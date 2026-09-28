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
    const verifier=randomString();
    localStorage.setItem('soundpulse_spotify_verifier', verifier);
    localStorage.setItem('soundpulse_spotify_client_id', id);
    const params=new URLSearchParams({
        client_id:id,response_type:'code',redirect_uri:redirectUri(),
        code_challenge_method:'S256',code_challenge:await challenge(verifier),
        scope:'user-read-private user-read-email user-read-currently-playing user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-top-read user-read-recently-played',
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
    const p=new URLSearchParams(location.search);
    let code=p.get('code');
    if (p.get('source')==='spotify' && p.get('query')) {
        code=new URLSearchParams(p.get('query')).get('code');
    }
    const verifier=localStorage.getItem('soundpulse_spotify_verifier');
    const id=localStorage.getItem('soundpulse_spotify_client_id');
    if (!code || !verifier || !id) { if(sessionStorage.getItem('soundpulse_oauth_started')) oauthState('Callback не получен: code/verifier отсутствует','error'); return false; }
    try {
        const r=await fetch('https://accounts.spotify.com/api/token',{
            method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({client_id:id,grant_type:'authorization_code',code,redirect_uri:redirectUri(),code_verifier:verifier})
        });
        if (!r.ok) throw new Error(await r.text());
        const t=await r.json();
        t.expires_at=Date.now()+t.expires_in*1000;
        localStorage.setItem('soundpulse_spotify_token',JSON.stringify(t));
        oauthState('Token получен ✓','ok');
        localStorage.removeItem('soundpulse_spotify_verifier');
        history.replaceState({},document.title,location.pathname);
        toastr?.success?.('SoundPulse подключён к Spotify 💜');
        return false;
    } catch(e) {
        oauthState('OAuth error: '+e.message,'error');
        console.error('[SoundPulse OAuth]',e);
        toastr?.error?.('SoundPulse Spotify OAuth: '+e.message);
        history.replaceState({},document.title,location.pathname);
        return false;
    }
}
function tokenData() { try{return JSON.parse(localStorage.getItem('soundpulse_spotify_token')||'null')}catch{return null} }
async function token() {
    let t=tokenData();
    if (!t) return null;
    if (Date.now() < (t.expires_at||0)-60000) return t.access_token;
    if (!t.refresh_token) return null;
    const id=settings.clientId || localStorage.getItem('soundpulse_spotify_client_id');
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
    if (!r.ok) throw new Error('Spotify '+r.status);
    return r.json();
}
async function logout() {
    localStorage.removeItem('soundpulse_spotify_token');
    localStorage.removeItem('soundpulse_spotify_verifier');
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
    el.setAttribute('popover','manual');
    el.innerHTML=`<button id="spm-record" aria-label="SoundPulse"><span class="spm-disc"><span>♫</span></span></button>
      <div class="spm-copy"><div class="spm-top"><span id="spm-dot">●</span><span id="spm-user">SoundPulse</span><span id="spm-mode">AUTO</span></div>
      <div id="spm-title">Spotify не подключён</div><div id="spm-artist">нажми для открытия</div>
      <div class="spm-progress"><b id="spm-fill"></b></div></div>
      <button id="spm-toggle" aria-label="Свернуть">×</button>`;
    document.body.appendChild(el);
    let sx=null,sy=null,ox=0,oy=0,moved=false;
    const clamp=()=>{
      const r=el.getBoundingClientRect();
      const x=Math.max(5,Math.min(innerWidth-r.width-5,r.left));
      const y=Math.max(5,Math.min(innerHeight-r.height-5,r.top));
      el.style.left=x+'px';el.style.top=y+'px';settings.miniX=x;settings.miniY=y;
    };
    const start=e=>{if(e.target.closest('#spm-toggle'))return;const p=e.touches?.[0]||e,r=el.getBoundingClientRect();sx=p.clientX;sy=p.clientY;ox=r.left;oy=r.top;moved=false};
    const move=e=>{if(sx===null)return;const p=e.touches?.[0]||e,dx=p.clientX-sx,dy=p.clientY-sy;if(Math.abs(dx)+Math.abs(dy)<8)return;moved=true;e.preventDefault();el.style.left=Math.max(5,Math.min(innerWidth-el.offsetWidth-5,ox+dx))+'px';el.style.top=Math.max(5,Math.min(innerHeight-el.offsetHeight-5,oy+dy))+'px'};
    const end=()=>{if(moved){const r=el.getBoundingClientRect();settings.miniX=r.left;settings.miniY=r.top;save()}sx=sy=null};
    el.addEventListener('touchstart',start,{passive:true});document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',end);
    el.addEventListener('mousedown',start);document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);
    el.addEventListener('click',e=>{if(moved){moved=false;return}if(!e.target.closest('#spm-toggle'))openTopLayer(false)});
    $id('spm-toggle').onclick=e=>{e.stopPropagation();el.classList.toggle('spm-orb-only');setTimeout(clamp,0)};
    window.addEventListener('resize',()=>setTimeout(clamp,50));
}
function showMini() {
    createMiniPlayer();
    const el=$id('soundpulse-mini'); if(!el)return;
    try{if(!el.matches(':popover-open'))el.showPopover()}catch{el.style.display='flex'}
    requestAnimationFrame(()=>{
      if(settings.miniX!==null&&settings.miniY!==null){el.style.left=settings.miniX+'px';el.style.top=settings.miniY+'px'}
      else {el.style.left=Math.max(8,innerWidth-el.offsetWidth-12)+'px';el.style.top=Math.max(70,innerHeight-el.offsetHeight-95)+'px'}
    });
}
function toggleMini() {
    const el=$id('soundpulse-mini'); if(!el){showMini();return}
    try{el.matches(':popover-open')?el.hidePopover():showMini()}catch{el.style.display=el.style.display==='none'?'flex':'none'}
}
function syncMini() {
    const el=$id('soundpulse-mini'); if(!el)return;
    const names={auto:'AUTO',inworld:'WORLD',soundtrack:'OST',visual:'VISUAL'};
    $id('spm-mode').textContent=names[settings?.mode]||'AUTO';
    $id('spm-dot').classList.toggle('ok',!!tokenData());
    $id('spm-user').textContent=(authStatus && !['not-connected','connected','error'].includes(authStatus))?authStatus:'SoundPulse';
    if(currentTrack){
        $id('spm-title').textContent=currentTrack.name;$id('spm-artist').textContent=currentTrack.artist;
        const p=progress();$id('spm-fill').style.width=(currentTrack.duration?p/currentTrack.duration*100:0)+'%';
        el.classList.toggle('spm-playing',!!currentTrack.playing);
    }else{
        $id('spm-title').textContent=tokenData()?'Spotify подключён':'Spotify не подключён';
        $id('spm-artist').textContent=tokenData()?'включи трек':'Client ID → Authenticate';
        $id('spm-fill').style.width='0%';el.classList.remove('spm-playing');
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
function createSettings() {
    const host=$id('extensions_settings2');
    if (!host || $id('soundpulse-settings')) return;
    const d=document.createElement('div'); d.id='soundpulse-settings'; d.className='inline-drawer';
    d.innerHTML=`<div class="inline-drawer-toggle inline-drawer-header"><b>🎧 SoundPulse · 0.3.1</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <div class="sp-diagnostic">UI <b id="sp-ui-state">✓</b> · Spotify <b id="sp-auth-state">—</b> · Playback <b id="sp-play-state">—</b><div id="sp-account" class="sp-account">Аккаунт: —</div><div id="sp-oauth-detail" class="sp-account">OAuth: —</div><div class="sp-account">Redirect URI: <code id="sp-redirect-uri"></code></div></div>
      <label class="checkbox_label"><input id="sp-enabled" type="checkbox"><span>Включить SoundPulse</span></label>
      <label>Spotify Client ID<input id="sp-client-id" class="text_pole" type="text" autocomplete="off" placeholder="вставь тот же Client ID"></label>
      <div class="sp-settings-row"><button id="sp-auth" class="menu_button">🎧 Authenticate</button><button id="sp-logout" class="menu_button">Logout</button></div>
      <label class="checkbox_label"><input id="sp-awareness" type="checkbox"><span>Music Awareness для модели</span></label>
      <label class="checkbox_label"><input id="sp-color" type="checkbox"><span>Динамический цвет от обложки</span></label>
      <label>Режим<select id="sp-mode" class="text_pole"><option value="auto">Auto</option><option value="inworld">In-world</option><option value="soundtrack">Soundtrack</option><option value="visual">Visual only</option></select></label>
      <label>Реакция модели<select id="sp-reaction" class="text_pole"><option value="rare">Редко</option><option value="natural">Естественно</option><option value="active">Активно</option></select></label>
      <button id="sp-test-ui" class="menu_button">💿 Показать тестовый винил</button>
      <div class="sp-note">v0.3.1 · mini-player в top layer. Lyrics пока только подготовленный слот.</div>
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
    $id('sp-enabled').onchange=e=>{settings.enabled=e.target.checked;save();render()};
    $id('sp-awareness').onchange=e=>{settings.awareness=e.target.checked;save();inject()};
    $id('sp-color').onchange=e=>{settings.dynamicColor=e.target.checked;save()};
    $id('sp-client-id').onchange=e=>{settings.clientId=e.target.value.trim();save()};
    $id('sp-mode').onchange=e=>{settings.mode=e.target.value;save();render();inject()};
    $id('sp-reaction').onchange=e=>{settings.reaction=e.target.value;save();inject()};
    $id('sp-auth').onclick=authenticate; $id('sp-logout').onclick=logout;
    $id('sp-test-ui').onclick=()=>openTopLayer(true);
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
    if(await handleCallback()) return;
    loadSettings();
    createPlayer(); createMiniPlayer(); createTopLayer(); createSettings(); attachMenu(); render(); showMini();
    setInterval(attachMenu,1000);
    if(tokenData()){await getUser(); await poll();}
    pollTimer=setInterval(poll,8000);
    setInterval(tick,500);
    console.log('[SoundPulse] v0.3.1 ready');
}
$(document).ready(()=>setTimeout(init,1200));
