# SoundPulse v0.7.0
Spotify direct-auth diagnostic/fix.
- Authentication request now mirrors the official SillyTavern Spotify extension:
  - same `/callback/spotify`
  - same five scopes
  - 64-character crypto-random PKCE verifier
  - same `source=spotify&query=...` callback envelope
- Callback/token errors are shown directly in SoundPulse instead of disappearing.
- On successful token exchange SoundPulse immediately checks `/v1/me` and current playback.
