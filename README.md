# SoundPulse v0.2.1
Исправления:
- визуальный плеер теперь открывается через native `<dialog>` top layer, как проверенный подход Scene Omens;
- пункт SoundPulse в волшебной палочке открывает top-layer плеер;
- тестовая кнопка открывает тот же top-layer;
- Spotify OAuth использует `/callback/spotify`, как официальный SillyTavern Spotify extension;
- callback понимает SillyTavern `source=spotify&query=...`.

Важно: в Spotify Developer Dashboard Redirect URI для этого Client ID должен совпадать с адресом, который использует SillyTavern: `<ваш origin>/callback/spotify`.
