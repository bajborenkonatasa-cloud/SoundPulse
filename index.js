import { getContext } from '../../../extensions.js';

const EXT = 'soundpulse';
const DEFAULTS = {
    enabled: true,
    clientId: '',
    mode: 'auto',
    awareness: true,
    reaction: 'natural',
    dynamicColor: true,
    folded: true,
    miniX: null,
    miniY: null,
};

let settings;
let currentTrack = null;
let authStatus = 'not-connected';
let pollTimer = null;

const $id = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadSettings() {
    const ctx = getContext();
    ctx.extensionSettings[EXT] ??= {};
    settings = ctx.extensionSettings[EXT];
    for (const [k,v] of Object.entries(DEFAULTS)) {
        if (settings[k] === undefined) settings[k] = v;
    }
    return settings;
}
function save() { getContext().saveSettingsDebounced(); }

function esc(s='') {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function randomString(n=64) {
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const a=crypto.getRandomValues(new Uint8Array(n));
    return [...a].map(x=>chars[x%chars.length]).join('');
}
async function challenge(verifier) {
    const bytes = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function redirectUri() { return new URL('/callback/spotify', window.location.origin).toString(); }

async function authenticate() {
    const id = ($id('sp-client-id')?.value || settings.clientId || '').trim();
    if (!id) { toastr.warning('SoundPulse: сначала вставь Spotify Client ID'); return; }
    settings.clientId=id; save();
    if (!crypto?.subtle) { toastr.error('SoundPulse: Spotify OAuth требует HTTPS'); return; }
    const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const verifier=crypto.getRandomValues(new Uint8Array(64)).reduce((s,b)=>s+chars[b%62],'');
    sessionStorage.setItem('soundpulse_spotify_verifier', verifier);
    sessionStorage.setItem('soundpulse_spotify_client_id', id);
    const params=new URLSearchParams({
        client_id:id,response_type:'code',redirect_uri:redirectUri(),
        code_challenge_method:'S256',code_challenge:await challenge(verifier),
        scope:'user-read-private user-read-playback-state user-top-read user-modify-playback-state playlist-read-private',
        show_dialog:'true'
    });
    // Use SillyTavern's own Spotify callback route, exactly like the official extension.
    sessionStorage.setItem('soundpulse_oauth_started','1');
    window.location.assign('https://accounts.spotify.com/authorize?'+params.toString());
}
function oauthState(msg,kind='info'){
    sessionStorage.setItem('soundpulse_oauth_status',msg);
    const el=$id('sp-oauth-detail'); if(el)el.textContent=msg;
    console.log('[SoundPulse OAuth]',kind,msg);
}
async function handleCallback() {
    const params=new URLSearchParams(window.location.search);
    if(params.get('source')!=='spotify') return false;
    const query=params.get('query');
    const code=query ? new URLSearchParams(query).get('code') : null;
    const oauthError=query ? new URLSearchParams(query).get('error') : null;
    const verifier=sessionStorage.getItem('soundpulse_spotify_verifier');
    const id=(sessionStorage.getItem('soundpulse_spotify_client_id') || settings?.clientId || '').trim();

    if(oauthError){
      oauthState('Spotify вернул ошибку: '+oauthError,'error');
      history.replaceState({},document.title,window.location.pathname);
      return false;
    }
    if(!code){
      oauthState('Callback Spotify пришёл без code','error');
      history.replaceState({},document.title,window.location.pathname);
      return false;
    }
    if(!verifier){
      oauthState('Callback получен, но потерян PKCE verifier','error');
      history.replaceState({},document.title,window.location.pathname);
      return false;
    }
    if(!id){
      oauthState('Callback получен, но Client ID пуст','error');
      history.replaceState({},document.title,window.location.pathname);
      return false;
    }

    const body=new URLSearchParams({
      client_id:id,
      grant_type:'authorization_code',
      redirect_uri:new URL('/callback/spotify',window.location.origin).toString(),
      code_verifier:verifier,
      code
    });
    try{
      oauthState('Callback ✓ · получаю token…','info');
      const r=await fetch('https://accounts.spotify.com/api/token',{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body
      });
      const raw=await r.text();
      let t; try{t=JSON.parse(raw)}catch{t=null}
      if(!r.ok){
        const detail=t?.error_description||t?.error||raw||r.statusText;
        throw new Error(`${r.status} ${detail}`);
      }
      if(!t?.access_token) throw new Error('Spotify не вернул access_token');
      t.expires_at=Date.now()+(Number(t.expires_in)||3600)*1000;
      localStorage.setItem('soundpulse_spotify_token',JSON.stringify(t));
      sessionStorage.removeItem('soundpulse_spotify_verifier');
      sessionStorage.removeItem('soundpulse_spotify_client_id');
      history.replaceState({},document.title,window.location.pathname);
      oauthState('Token ✓ · проверяю аккаунт…','ok');
      toastr?.success?.('SoundPulse подключён к Spotify 💜');
      return true;
    }catch(e){
      history.replaceState({},document.title,window.location.pathname);
      oauthState('Token error: '+e.message,'error');
      console.error('[SoundPulse OAuth]',e);
      toastr?.error?.('SoundPulse Spotify: '+e.message);
      return false;
    }
}

function importOfficialSpotifySession(){
  try{
    const es=getContext()?.extensionSettings || {};
    for(const [key,val] of Object.entries(es)){
      if(!val || typeof val!=='object') continue;
      const tok=val.clientToken;
      const cid=val.clientId;
      if(!cid || !tok?.access_token) continue;
      // Restrict to a Spotify-looking settings object, not an arbitrary token-bearing extension.
      const looksSpotify=/spotify/i.test(key) || ('getCurrentTrack' in val) || ('searchTracks' in val);
      if(!looksSpotify) continue;
      const copy={...tok};
      if(copy.expires && !copy.expires_at) copy.expires_at=copy.expires;
      localStorage.setItem('soundpulse_spotify_token',JSON.stringify(copy));
      if(!settings.clientId){settings.clientId=cid;save();}
      oauthState('Сессия Spotify найдена ✓ · проверяю аккаунт…','ok');
      return true;
    }
  }catch(e){ console.warn('[SoundPulse] official Spotify session import failed',e); }
  return false;
}

function tokenData() { try{return JSON.parse(localStorage.getItem('soundpulse_spotify_token')||'null')}catch{return null} }
async function token() {
    let t=tokenData();
    if (!t) return null;
    if (Date.now() < (t.expires_at||0)-60000) return t.access_token;
    if (!t.refresh_token) return null;
    const id=settings.clientId || sessionStorage.getItem('soundpulse_spotify_client_id');
    const r=await fetch('https://accounts.spotify.com/api/token',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:id})
    });
    if (!r.ok) return null;
    const n=await r.json();
    n.refresh_token=n.refresh_token||t.refresh_token;
    n.expires_at=Date.now()+n.expires_in*1000;
    localStorage.setItem('soundpulse_spotify_token',JSON.stringify(n));
    return n.access_token;
}
async function api(path,opt={}) {
    const t=await token();
    if (!t) return null;
    const r=await fetch('https://api.spotify.com/v1/'+path,{
        ...opt, headers:{Authorization:'Bearer '+t,'Content-Type':'application/json',...(opt.headers||{})}
    });
    if (r.status===204) return {};
    if (!r.ok) {
        const detail=await r.text().catch(()=> '');
        throw new Error('Spotify '+r.status+(detail?' · '+detail.slice(0,120):''));
    }
    const type=(r.headers.get('content-type')||'').toLowerCase();
    if (type.includes('application/json')) return r.json();
    const text=await r.text().catch(()=> '');
    if (!text.trim()) return {};
    // Some successful playback-control responses are not JSON. They are still success.
    return {ok:true,text};
}
async function logout() {
    localStorage.removeItem('soundpulse_spotify_token');
    sessionStorage.removeItem('soundpulse_spotify_verifier');
    sessionStorage.removeItem('soundpulse_spotify_client_id');
    sessionStorage.removeItem('soundpulse_spotify_verifier');
    currentTrack=null; authStatus='not-connected'; render();
    toastr.info('SoundPulse: Spotify отключён');
}
async function getUser() {
    try {
        const me=await api('me');
        authStatus=me?.display_name||me?.id||'connected'; oauthState('Spotify /me ✓ · '+authStatus,'ok');
    } catch(e) { authStatus='error'; oauthState('Spotify /me error: '+e.message,'error'); }
    updateStatus();
}

function rememberTrackLocal(track){
  try{
    const item=track?.item; if(!item?.id)return;
    const key='soundpulse_track_history';
    const list=JSON.parse(localStorage.getItem(key)||'[]');
    if(list[0]?.id===item.id)return;
    list.unshift({id:item.id,name:item.name||'',artist:(item.artists||[]).map(a=>a.name).join(', '),at:Date.now()});
    localStorage.setItem(key,JSON.stringify(list.slice(0,20)));
    sessionStorage.setItem('soundpulse_track_changed','1');
  }catch{}
}

async function poll() {
    if (!settings.enabled) return;
    try {
        const p=await api('me/player/currently-playing');
        if (!p) { currentTrack=null; authStatus=tokenData()?'connected':'not-connected'; render(); return; }
        if (!p.item) { currentTrack=null; render(); return; }
        const i=p.item;
        currentTrack={
            id:i.id,name:i.name,artist:(i.artists||[]).map(a=>a.name).join(', '),
            cover:i.album?.images?.[0]?.url||'',duration:i.duration_ms||0,
            progress:p.progress_ms||0,playing:!!p.is_playing,stamp:Date.now()
        };
        render();
    } catch(e) {
        console.warn('[SoundPulse] poll',e);
        authStatus='error'; updateStatus();
    }
}
async function playback(action) {
    try {
        if (action==='prev') await api('me/player/previous',{method:'POST'});
        if (action==='next') await api('me/player/next',{method:'POST'});
        if (action==='play') await api(currentTrack?.playing?'me/player/pause':'me/player/play',{method:'PUT'});
        setTimeout(poll,500);
    } catch(e) { toastr.warning('Spotify: '+e.message); }
}

function createMiniPlayer() {
    if ($id('soundpulse-mini')) return;
    const el=document.createElement('div');
    el.id='soundpulse-mini';
    el.innerHTML=`<div class="sp-orb-shell">
      <button id="spm-hide" aria-label="Спрятать">‹</button>
      <div id="spm-vinyl" class="spm-vinyl">
        <div class="spm-rings"></div><div class="spm-shine"></div>
        <div class="spm-label"><span id="spm-title">SoundPulse</span><small id="spm-artist">Spotify</small></div>
        <div class="spm-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      </div>
      <div id="spm-lyric" class="spm-lyric">♪</div>
    </div>`;
    document.body.appendChild(el);
    let sx=null,sy=null,ox=0,oy=0,moved=false,dragId=null;
    const vinyl=$id('spm-vinyl');
    const dragStart=e=>{
      if(e.button!==undefined&&e.button!==0)return;
      dragId=e.pointerId;sx=e.clientX;sy=e.clientY;ox=Number(el.dataset.dragX)||0;oy=Number(el.dataset.dragY)||0;moved=false;
      try{vinyl.setPointerCapture(e.pointerId)}catch{}
      e.preventDefault();e.stopPropagation();
    };
    const dragMove=e=>{
      if(dragId===null||e.pointerId!==dragId)return;
      const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>4)moved=true;
      if(!moved)return;
      const x=Math.max(4,Math.min(innerWidth-el.offsetWidth-4,ox+dx));
      const y=Math.max(4,Math.min(innerHeight-el.offsetHeight-4,oy+dy));
      el.style.setProperty('transform',`translate3d(${x}px,${y}px,0)`,'important');
      el.dataset.dragX=String(x);el.dataset.dragY=String(y);e.preventDefault();e.stopPropagation();
    };
    const dragEnd=e=>{
      if(dragId===null||e.pointerId!==dragId)return;
      try{vinyl.releasePointerCapture(e.pointerId)}catch{}
      if(moved){settings.miniX=Math.round(Number(el.dataset.dragX)||0);settings.miniY=Math.round(Number(el.dataset.dragY)||0);save()}
      dragId=null;sx=sy=null;e.preventDefault();e.stopPropagation();
      setTimeout(()=>{moved=false},80);
    };
    vinyl.addEventListener('pointerdown',dragStart,{capture:true});
    vinyl.addEventListener('pointermove',dragMove,{capture:true});
    vinyl.addEventListener('pointerup',dragEnd,{capture:true});
    vinyl.addEventListener('pointercancel',dragEnd,{capture:true});
    let lastTap=0;
    vinyl.addEventListener('pointerup',()=>{const n=Date.now();if(n-lastTap<330){hideMini(true);lastTap=0}else lastTap=n});
    el.addEventListener('click',e=>{if(moved){e.preventDefault();e.stopPropagation();return;} /* v0.4.5: plain tap intentionally does nothing */});
    $id('spm-hide').onclick=e=>{e.stopPropagation();hideMini(true)};
}
function anyDrawerOpen(){
    const visible=e=>{
      if(!e)return false;
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      return e.getClientRects().length>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0&&r.width>40&&r.height>40;
    };
    const drawerSelectors=['.drawer-content','.drawer-content.openDrawer','.openDrawer','#left-nav-panel','#right-nav-panel','#extensions_settings','#ai_response_configuration','#advanced-formatting'];
    return [...document.querySelectorAll(drawerSelectors.join(','))].some(e=>visible(e));
}
function inChatView(){
    try{
      const c=ctx(),chat=document.querySelector('#chat'),send=document.querySelector('#send_form');
      const vis=e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden');
      return Array.isArray(c?.chat)&&c.chat.length>0&&vis(chat)&&vis(send)&&!anyDrawerOpen();
    }catch{return false}
}
function hideMini(manual=false){
    const e=$id('soundpulse-mini');if(!e)return;
    e.classList.add('spm-hidden');
    if(manual)sessionStorage.setItem('soundpulse_hidden','1');
}
function enforceMiniScope(){if(!inChatView())hideMini(false)}
function showMini(force=false){
    if(!force&&sessionStorage.getItem('soundpulse_hidden')==='1')return;
    createMiniPlayer();const el=$id('soundpulse-mini');if(!el)return;
    if(el.parentElement!==document.body) document.body.appendChild(el);
    el.classList.remove('spm-hidden');sessionStorage.removeItem('soundpulse_hidden');
    requestAnimationFrame(()=>{
      const x=settings.miniX!==null?settings.miniX:Math.max(8,innerWidth-132);
      const y=settings.miniY!==null?settings.miniY:Math.max(80,innerHeight-270);
      el.dataset.dragX=String(x);el.dataset.dragY=String(y);
      el.style.left='0px';el.style.top='0px';
      el.style.setProperty('transform',`translate3d(${x}px,${y}px,0)`,'important');
    });
}
function toggleMini(){
    const el=$id('soundpulse-mini');
    if(el&&!el.classList.contains('spm-hidden')){hideMini(true);return}
    sessionStorage.removeItem('soundpulse_hidden');showMini(true);
}
function syncMini(){
    const el=$id('soundpulse-mini');if(!el)return;
    const t=$id('spm-title'),a=$id('spm-artist'),l=$id('spm-lyric');
    if(currentTrack){
      t.textContent=currentTrack.name||'Трек';a.textContent=currentTrack.artist||'';
      l.textContent=currentTrack.lyric||'♪ текущая строка — когда подключим источник lyrics';
      el.classList.toggle('spm-playing',!!currentTrack.playing);
    }else{
      t.textContent='SoundPulse';a.textContent=tokenData()?'Spotify подключён':'не подключён';
      l.textContent='♪';el.classList.remove('spm-playing');
    }
}
function createTopLayer() {
    if ($id('soundpulse-dialog')) return;
    const d=document.createElement('dialog');
    d.id='soundpulse-dialog';
    d.innerHTML=`<div class="spd-shell">
      <button id="spd-close" aria-label="Закрыть">×</button>
      <div class="spd-vinyl"><div class="spd-grooves"><span>♫</span></div><div class="spd-eq"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="spd-kicker">SOUNDPULSE</div>
      <div id="spd-title">UI жив 💜</div>
      <div id="spd-artist">Spotify подключим следующим слоем</div>
      <div class="spd-line"><b id="spd-fill"></b></div>
      <div class="spd-times"><span id="spd-now">0:00</span><span id="spd-total">0:00</span></div>
      <div class="spd-controls"><button data-spd="prev">⏮</button><button data-spd="play">▶</button><button data-spd="next">⏭</button></div>
      <div id="spd-mode">AUTO · Music Awareness</div>
      <div class="spd-lyrics">♪ lyrics · место для одной текущей строки</div>
    </div>`;
    document.body.appendChild(d);
    $id('spd-close').onclick=()=>d.close();
    d.addEventListener('click',e=>{if(e.target===d)d.close()});
    d.querySelectorAll('[data-spd]').forEach(b=>b.onclick=()=>playback(b.dataset.spd));
}
function openTopLayer(test=false) {
    createTopLayer();
    const d=$id('soundpulse-dialog');
    if (test && !currentTrack) currentTrack={name:'SoundPulse UI Test',artist:'если ты это видишь — top layer работает 💜',cover:'',duration:188000,progress:42000,playing:true,stamp:Date.now()};
    syncDialog();
    if(!d.open)d.showModal();
}
function syncDialog() {
    const d=$id('soundpulse-dialog'); if(!d)return;
    const names={auto:'AUTO',inworld:'IN-WORLD',soundtrack:'SOUNDTRACK',visual:'VISUAL'};
    $id('spd-mode').textContent=(names[settings?.mode]||'AUTO')+' · Music Awareness';
    if(currentTrack){
        $id('spd-title').textContent=currentTrack.name;
        $id('spd-artist').textContent=currentTrack.artist;
        const p=progress(),pct=currentTrack.duration?p/currentTrack.duration*100:0;
        $id('spd-fill').style.width=pct+'%';$id('spd-now').textContent=fmt(p);$id('spd-total').textContent=fmt(currentTrack.duration);
        d.classList.toggle('spd-playing',!!currentTrack.playing);
        d.querySelector('[data-spd="play"]').textContent=currentTrack.playing?'❚❚':'▶';
    }else{
        $id('spd-title').textContent=tokenData()?'Spotify подключён':'SoundPulse готов';
        $id('spd-artist').textContent=tokenData()?'Включи песню в Spotify':'Сначала проверяем интерфейс 💿';
        d.classList.remove('spd-playing');
    }
}

function createPlayer() {
    if ($id('soundpulse-player')) return;
    const el=document.createElement('div');
    el.id='soundpulse-player';
    el.innerHTML=`
      <button id="sp-orb" aria-label="SoundPulse">
        <span class="sp-record"><span class="sp-record-label">♫</span></span>
        <span class="sp-eq"><i></i><i></i><i></i><i></i></span>
      </button>
      <section id="sp-card">
        <div class="sp-art-wrap"><img id="sp-art" alt=""><span class="sp-hole"></span></div>
        <div class="sp-info">
          <div class="sp-eyebrow">SOUNDPULSE</div>
          <div id="sp-title">Spotify ещё не подключён</div>
          <div id="sp-artist">нажми 🎧 SoundPulse в волшебной палочке</div>
          <div class="sp-line"><b id="sp-line-fill"></b></div>
          <div class="sp-times"><span id="sp-now">0:00</span><span id="sp-total">0:00</span></div>
          <div class="sp-controls">
            <button data-sp="prev">⏮</button><button data-sp="play">▶</button><button data-sp="next">⏭</button>
            <button id="sp-mode-chip">AUTO</button>
          </div>
          <div id="sp-lyric">♪ текущая строка lyrics — следующий слой</div>
        </div>
      </section>`;
    document.body.appendChild(el);
    $id('sp-orb').addEventListener('click',()=>{settings.folded=!settings.folded;save();render();});
    el.querySelectorAll('[data-sp]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();playback(b.dataset.sp)}));
    $id('sp-mode-chip').addEventListener('click',e=>{
        e.stopPropagation(); const modes=['auto','inworld','soundtrack','visual'];
        settings.mode=modes[(modes.indexOf(settings.mode)+1)%modes.length]; save(); render(); inject();
    });
    makeDraggable(el);
}
function makeDraggable(el) {
    let sx,sy,ox,oy,drag=false;
    const start=e=>{if(e.target.closest('#sp-card button'))return;const p=e.touches?.[0]||e;sx=p.clientX;sy=p.clientY;const r=el.getBoundingClientRect();ox=r.left;oy=r.top;drag=false;};
    const move=e=>{if(sx===undefined)return;const p=e.touches?.[0]||e,dx=p.clientX-sx,dy=p.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>8)drag=true;if(!drag)return;e.preventDefault();el.style.left=Math.max(4,Math.min(innerWidth-el.offsetWidth-4,ox+dx))+'px';el.style.top=Math.max(4,Math.min(innerHeight-el.offsetHeight-4,oy+dy))+'px';el.style.right='auto';el.style.bottom='auto';};
    const end=()=>{sx=undefined;sy=undefined;};
    el.addEventListener('touchstart',start,{passive:true});document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',end);
    el.addEventListener('mousedown',start);document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);
}
function attachMenu() {
    const menu=$id('extensionsMenu');
    if (!menu || $id('soundpulse-menu-item-container')) return;
    const box=document.createElement('div');
    box.id='soundpulse-menu-item-container'; box.className='extension_container interactable'; box.tabIndex=0;
    box.innerHTML='<div id="soundpulse-wand-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><i class="fa-solid fa-music" style="width:20px;text-align:center"></i><span>SoundPulse</span></div>';
    menu.appendChild(box);
    $id('soundpulse-wand-item').addEventListener('click',()=>toggleMini());
}

function updateMusicBrainUI(){
  const badge=document.getElementById('sp-brain-badge');
  const sub=document.getElementById('sp-brain-sub');
  if(!badge)return;
  const mode=settings.mode||'auto';
  const map={
    auto:['✨ Auto','SoundPulse передаёт модели выбор: услышать музыку физически только когда это правдоподобно; иначе использовать её как внешний саундтрек.'],
    inworld:['🔊 In-world','Музыка существует внутри сцены. Персонажи могут услышать её и естественно отреагировать.'],
    soundtrack:['🎬 Soundtrack','Музыка внешняя. Персонажи её не слышат; она влияет только на тон и атмосферу повествования.'],
    visual:['👁 Visual only','Только Spotify и винил. Музыкальный контекст модели не передаётся.']
  };
  badge.textContent=map[mode][0]; if(sub)sub.textContent=map[mode][1];
  document.querySelectorAll('#soundpulse-settings .sp-brain-mode').forEach(b=>b.classList.toggle('sp-selected',b.dataset.sceneMode===mode));
}


function sceneMatchSnapshot(){
  try{
    const c=getContext?.();
    const msgs=(c?.chat||[]).slice(-8).map(m=>{
      const who=m?.is_user?'USER':'CHAR';
      const text=String(m?.mes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      return text ? `${who}: ${text.slice(0,700)}` : '';
    }).filter(Boolean);
    const current=playback?.item;
    const currentText=current ? `${current.name||''} — ${(current.artists||[]).map(a=>a.name).join(', ')}` : 'ничего';
    const prompt=`Подбери музыку для текущей ролевой сцены.
Верни 3 коротких поисковых варианта для Spotify: настроение/жанр/тип трека, без длинного объяснения.
Не управляй персонажем пользователя и не меняй сюжет.
Текущий трек: ${currentText}
Режим SoundPulse: ${settings.mode||'auto'}
Последние сообщения:
${msgs.join('\n')}`;
    sessionStorage.setItem('soundpulse_scene_match_prompt',prompt);
    const box=document.getElementById('sp-scene-result');
    if(box){
      box.hidden=false;
      box.textContent=msgs.length ? `Снимок готов: ${msgs.length} последних сообщений. Запрос подготовлен локально — скрытого LLM-вызова нет.` : 'Чат пока пуст — нечего анализировать.';
    }
    const st=document.getElementById('sp-scene-status'); if(st)st.textContent=msgs.length?'снимок ✓':'нет сцены';
    return prompt;
  }catch(e){ console.warn('[SoundPulse] Scene Match snapshot failed',e); return ''; }
}
async function copySceneMatchPrompt(){
  const prompt=sessionStorage.getItem('soundpulse_scene_match_prompt')||sceneMatchSnapshot();
  if(!prompt)return;
  try{ await navigator.clipboard.writeText(prompt); toastr?.success?.('Scene Match: запрос скопирован'); }
  catch{ toastr?.info?.('Scene Match подготовлен'); }
}

function createSettings() {
    const host=$id('extensions_settings2') || $id('extensions_settings') || document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host || $id('soundpulse-settings')) return;
    const d=document.createElement('div'); d.id='soundpulse-settings'; d.className='inline-drawer';
    d.innerHTML=`<div class="inline-drawer-toggle inline-drawer-header"><b>🎧 SoundPulse · 0.9.0</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content sp-compact-settings">
      <div class="sp-statusbar">
        <span>UI <b id="sp-ui-state">✓</b></span><span>Spotify <b id="sp-auth-state">—</b></span><span>Playback <b id="sp-play-state">—</b></span>
        <span id="sp-account" class="sp-account-chip">Аккаунт: —</span>
      </div>

      <label class="checkbox_label sp-master"><input id="sp-enabled" type="checkbox"><span><b>SoundPulse</b> включён</span></label>

      <details class="sp-section">
        <summary>🔐 Spotify и подключение <span class="sp-summary-hint">аккаунт · ключ · вход</span></summary>
        <div class="sp-section-body">
          <label>Spotify Client ID</label>
          <div class="sp-secret-row"><input id="sp-client-id" class="text_pole" type="password" autocomplete="off" placeholder="Spotify Client ID"><button id="sp-client-eye" class="menu_button sp-eye" type="button" title="Показать / скрыть Client ID">👁</button></div>
          <button type="button" class="sp-info-toggle" data-help="sp-help-client">ⓘ Что это?</button>
          <div id="sp-help-client" class="sp-help sp-collapsible-help" hidden>Client ID твоего Spotify Developer App. Он скрыт по умолчанию; 👁 временно показывает его.</div>

          <div class="sp-settings-row"><button id="sp-auth" class="menu_button">🎧 Authenticate</button><button id="sp-logout" class="menu_button">Logout</button></div>
          <button id="sp-import-official" class="menu_button">🔗 Подхватить вход из официального Spotify</button>
          <button type="button" class="sp-info-toggle" data-help="sp-help-auth">ⓘ Как работает вход?</button>
          <div id="sp-help-auth" class="sp-help sp-collapsible-help" hidden><b>Authenticate</b> — отдельный вход SoundPulse. <b>Logout</b> удаляет его сохранённую сессию. Мост нужен только для одноразового импорта уже рабочей авторизации.</div>

          <details class="sp-mini-details">
            <summary>Диагностика OAuth</summary>
            <div id="sp-oauth-detail" class="sp-account">OAuth: —</div>
            <div class="sp-account">Redirect URI: <code id="sp-redirect-uri"></code></div>
          </details>
        </div>
      </details>

      <details class="sp-section" open>
        <summary>🎭 Поведение в ролевой <span class="sp-summary-hint">awareness · режим · реакция</span></summary>
        <div class="sp-section-body">
          <label class="checkbox_label"><input id="sp-awareness" type="checkbox"><span>Music Awareness для модели</span></label>
          <button type="button" class="sp-info-toggle" data-help="sp-help-awareness">ⓘ</button>
          <div id="sp-help-awareness" class="sp-help sp-collapsible-help" hidden>Передаёт модели короткий контекст о текущем треке. Выкл. — музыка остаётся только в интерфейсе и музыкальный prompt не добавляется.</div>
          <div class="sp-setting-line"><label for="sp-cadence">Передача модели</label><select id="sp-cadence" class="text_pole"><option value="always">Всегда</option><option value="change">При смене трека</option><option value="smart">Умно</option><option value="off">Никогда</option></select><button type="button" class="sp-info-toggle sp-info-inline" data-help="sp-help-cadence">ⓘ</button></div>
          <div id="sp-help-cadence" class="sp-help sp-help-table sp-collapsible-help" hidden>
            <div><b>Всегда</b><span>Короткий музыкальный контекст идёт с каждым обычным RP-запросом.</span></div>
            <div><b>Смена</b><span>Новый трек отмечается движком; минимум лишнего музыкального контекста.</span></div>
            <div><b>Умно</b><span>Рекомендуемый баланс: движок учитывает трек, но инструкция просит не форсировать реакцию.</span></div>
            <div><b>Никогда</b><span>Spotify и винил работают, модели музыка не передаётся.</span></div>
          </div>

          <div class="sp-setting-line"><label for="sp-mode">Режим</label><select id="sp-mode" class="text_pole"><option value="auto">Auto</option><option value="inworld">In-world</option><option value="soundtrack">Soundtrack</option><option value="visual">Visual only</option></select><button type="button" class="sp-info-toggle sp-info-inline" data-help="sp-help-mode">ⓘ</button></div>
          <div id="sp-help-mode" class="sp-help sp-help-table sp-collapsible-help" hidden>
            <div><b>Auto</b><span>Сам решает: музыка в мире сцены или саундтрек.</span></div>
            <div><b>In-world</b><span>Персонажи могут реально слышать музыку.</span></div>
            <div><b>Soundtrack</b><span>Только атмосфера; персонажи трек не слышат.</span></div>
            <div><b>Visual only</b><span>Только плеер; модели музыка не передаётся.</span></div>
          </div>

          <div class="sp-setting-line"><label for="sp-reaction">Реакция модели</label><select id="sp-reaction" class="text_pole"><option value="rare">Редко</option><option value="natural">Естественно</option><option value="active">Активно</option></select><button type="button" class="sp-info-toggle sp-info-inline" data-help="sp-help-reaction">ⓘ</button></div>
          <div id="sp-help-reaction" class="sp-help sp-help-table sp-collapsible-help" hidden>
            <div><b>Редко</b><span>Музыка почти не вмешивается.</span></div>
            <div><b>Естественно</b><span>Учитывается только когда подходит сцене.</span></div>
            <div><b>Активно</b><span>Влияет заметнее, но не обязана упоминаться каждый ответ.</span></div>
          </div>
          <div class="sp-brain-card">
            <div class="sp-brain-head"><b>🧠 Music Brain</b><span id="sp-brain-badge">🎬 Soundtrack</span></div>
            <div class="sp-brain-sub" id="sp-brain-sub">Авто-логика не форсирует упоминание музыки.</div>
            <div class="sp-brain-actions">
              <button type="button" class="menu_button sp-brain-mode" data-scene-mode="auto">✨ Auto</button>
              <button type="button" class="menu_button sp-brain-mode" data-scene-mode="inworld">🔊 В сцене</button>
              <button type="button" class="menu_button sp-brain-mode" data-scene-mode="soundtrack">🎬 Саундтрек</button>
              <button type="button" class="menu_button sp-brain-mode" data-scene-mode="visual">👁 Только винил</button>
            </div>
          </div>

          <div class="sp-scene-match">
            <div class="sp-brain-head"><b>✨ Scene Match</b><span id="sp-scene-status">готов</span></div>
            <div class="sp-brain-sub">Ручной снимок текущей сцены. Никаких фоновых LLM-запросов: запускается только по твоему нажатию.</div>
            <div class="sp-scene-actions">
              <button type="button" id="sp-scene-snapshot" class="menu_button">✨ Снять настроение сцены</button>
              <button type="button" id="sp-scene-copy" class="menu_button">📋 Копировать запрос</button>
            </div>
            <div id="sp-scene-result" class="sp-scene-result" hidden></div>
          </div>
        </div>
      </details>

      <details class="sp-section">
        <summary>🎨 Винил и оформление <span class="sp-summary-hint">цвет · тест</span></summary>
        <div class="sp-section-body">
          <label class="checkbox_label"><input id="sp-color" type="checkbox"><span>Динамический цвет от обложки</span></label>
          <button id="sp-test-ui" class="menu_button">💿 Показать тестовый винил</button>
        </div>
      </details>

      <div class="sp-note">v0.9.0 · Scene Match: ручной снимок сцены + подготовка музыкального запроса.</div>
    </div>`;
    host.appendChild(d);

    $id('sp-enabled').checked=settings.enabled;
    $id('sp-awareness').checked=settings.awareness;
    $id('sp-color').checked=settings.dynamicColor;
    $id('sp-client-id').value=settings.clientId||'';
    $id('sp-redirect-uri').textContent=redirectUri();
    $id('sp-oauth-detail').textContent='OAuth: '+(sessionStorage.getItem('soundpulse_oauth_status')||'—');
    $id('sp-mode').value=settings.mode;
    $id('sp-reaction').value=settings.reaction;
    $id('sp-cadence').value=settings.awarenessCadence||'smart';

    $id('sp-enabled').onchange=e=>{settings.enabled=e.target.checked;save();render();inject()};
    $id('sp-awareness').onchange=e=>{settings.awareness=e.target.checked;save();inject()};
    $id('sp-color').onchange=e=>{settings.dynamicColor=e.target.checked;save()};
    $id('sp-client-id').onchange=e=>{settings.clientId=e.target.value.trim();save()};
    $id('sp-client-eye').onclick=()=>{const f=$id('sp-client-id');const show=f.type==='password';f.type=show?'text':'password';$id('sp-client-eye').textContent=show?'🙈':'👁';};
    $id('sp-mode').onchange=e=>{settings.mode=e.target.value;save();updateMusicBrainUI();render();inject()};
    $id('sp-reaction').onchange=e=>{settings.reaction=e.target.value;save();inject()};
    $id('sp-cadence').onchange=e=>{settings.awarenessCadence=e.target.value;save();inject()};
    $id('sp-auth').onclick=authenticate;
    $id('sp-import-official').onclick=async()=>{
      if(!importOfficialSpotifySession()){
        oauthState('Официальная Spotify-сессия не найдена в extensionSettings','error');
        toastr?.warning?.('Сначала один раз войди в официальном Spotify.');
        return;
      }
      await getUser(); await poll(); render();
    };
    $id('sp-logout').onclick=logout;
    $id('sp-test-ui').onclick=()=>openTopLayer(true);
    $id('sp-scene-snapshot').onclick=sceneMatchSnapshot;
    $id('sp-scene-copy').onclick=copySceneMatchPrompt;
    d.querySelectorAll('.sp-brain-mode').forEach(btn=>btn.onclick=()=>{
      settings.mode=btn.dataset.sceneMode; save();
      const sel=$id('sp-mode'); if(sel)sel.value=settings.mode;
      updateMusicBrainUI(); render(); inject();
    });
    updateMusicBrainUI();

    d.querySelectorAll('.sp-info-toggle').forEach(btn=>{
      btn.onclick=()=>{
        const help=$id(btn.dataset.help); if(!help)return;
        help.hidden=!help.hidden;
        btn.classList.toggle('is-open',!help.hidden);
      };
    });
}
function updateStatus() {
    if ($id('sp-auth-state')) $id('sp-auth-state').textContent=authStatus==='not-connected'?'—':authStatus==='error'?'✕':'✓';
    if ($id('sp-play-state')) $id('sp-play-state').textContent=currentTrack?'✓':'—';
    if ($id('sp-account')) $id('sp-account').textContent='Аккаунт: '+((authStatus && !['not-connected','connected','error'].includes(authStatus))?authStatus:'—');
}
function fmt(ms){let s=Math.floor((ms||0)/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function progress(){if(!currentTrack)return 0;return Math.min(currentTrack.duration,currentTrack.progress+(currentTrack.playing?Date.now()-currentTrack.stamp:0))}
function render() {
    createPlayer();
    const el=$id('soundpulse-player'); if(!el)return;
    el.style.display=settings.enabled?'flex':'none';
    el.classList.toggle('sp-folded',settings.folded);
    el.classList.toggle('sp-playing',!!currentTrack?.playing);
    const names={auto:'AUTO',inworld:'IN-WORLD',soundtrack:'SOUNDTRACK',visual:'VISUAL'};
    $id('sp-mode-chip').textContent=names[settings.mode]||'AUTO';
    if (currentTrack) {
        $id('sp-title').textContent=currentTrack.name;
        $id('sp-artist').textContent=currentTrack.artist;
        $id('sp-art').src=currentTrack.cover||'';
        $id('sp-art').style.display=currentTrack.cover?'block':'none';
        el.querySelector('[data-sp="play"]').textContent=currentTrack.playing?'❚❚':'▶';
        if(settings.dynamicColor && currentTrack.cover) applyCoverColor(currentTrack.cover);
    } else {
        $id('sp-title').textContent=tokenData()?'Spotify подключён':'Spotify ещё не подключён';
        $id('sp-artist').textContent=tokenData()?'Включи трек в Spotify':'вставь Client ID → Authenticate';
        $id('sp-art').style.display='none';
    }
    updateStatus(); inject(); syncDialog(); syncMini();
}
function applyCoverColor(url) {
    const img=new Image(); img.crossOrigin='anonymous';
    img.onload=()=>{try{const c=document.createElement('canvas');c.width=c.height=1;const g=c.getContext('2d');g.drawImage(img,0,0,1,1);const d=g.getImageData(0,0,1,1).data;document.documentElement.style.setProperty('--sp-accent',`rgb(${Math.max(90,d[0])} ${Math.max(70,d[1])} ${Math.max(115,d[2])})`)}catch{}};
    img.src=url;
}
function inject() {
  if ((settings.awarenessCadence||'smart')==='off') { try { getContext()?.setExtensionPrompt?.('soundpulse',''); } catch{} return; }
    const ctx=getContext(), key='soundpulse_music_awareness';
    if(!settings?.enabled||!settings.awareness||!currentTrack||settings.mode==='visual'){ctx.setExtensionPrompt(key,'',-1,0);return}
    const text=`[SOUNDPULSE — LIVE MUSIC]
The user is actually listening to: ${currentTrack.name} — ${currentTrack.artist}.
Mode: ${settings.mode}; reaction: ${settings.reaction}.
Song language does not need to match the setting language. In AUTO, decide whether the track plausibly exists in-world or is only a soundtrack. If characters could not plausibly hear or know it, never pretend they do; use only broad emotional atmosphere when relevant. Never force a music reference or derail a stronger scene.`;
    ctx.setExtensionPrompt(key,text,0,0,false,0);
}
function tick() {
    if(!currentTrack)return;
    const p=progress(), pct=currentTrack.duration?p/currentTrack.duration*100:0;
    if($id('sp-line-fill'))$id('sp-line-fill').style.width=pct+'%';
    if($id('sp-now'))$id('sp-now').textContent=fmt(p);
    if($id('sp-total'))$id('sp-total').textContent=fmt(currentTrack.duration); syncDialog(); syncMini();
}
async function init() {
    loadSettings();
    const spotifyReturned=await handleCallback();
    createPlayer(); createMiniPlayer(); createTopLayer(); createSettings(); attachMenu(); render();
    if(!tokenData()) importOfficialSpotifySession();
    if(spotifyReturned || tokenData()){ setTimeout(async()=>{await getUser();await poll();render();},250); }
    // ST can build Extensions settings after third-party extensions initialize.
    // Retry only the settings mount for a short time; this is cheap and stops itself.
    let spMountTries=0;
    const spMountTimer=setInterval(()=>{
      spMountTries++;
      if($id('soundpulse-settings') || spMountTries>=30){clearInterval(spMountTimer);return;}
      createSettings();
    },500); document.addEventListener('pointerdown',e=>{
      const mini=$id('soundpulse-mini'); if(!mini)return;
      const path=e.composedPath();
      if(path.includes(mini))return;
      const target=e.target;
      const insideRealChat=target?.closest?.('#chat,#send_form');
      if(!insideRealChat) hideMini(false);
    },true);
    document.addEventListener('click',e=>{
      const mini=$id('soundpulse-mini'); if(!mini)return;
      if(e.composedPath().includes(mini))return;
      if(!e.target?.closest?.('#chat,#send_form')) hideMini(false);
    },true);
    setInterval(attachMenu,1000);
    if(tokenData()){await getUser(); await poll();}
    pollTimer=setInterval(poll,8000);
    setInterval(tick,500);
    console.log('[SoundPulse] v0.9.0 ready');
}
$(document).ready(()=>setTimeout(init,1200));
