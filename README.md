# SoundPulse v0.6.2
Critical OAuth/UI fix:
- A successful Spotify callback used to make init() return before SoundPulse created its settings panel and Magic Wand item.
- SoundPulse now processes the callback and always continues normal UI initialization.
- Keeps the delayed settings mount fallback from 0.6.1.
- Keeps direct Spotify PKCE, vinyl UI, drag and shimmer.
