# SoundPulse v0.6.0
Direct Spotify stage.
- Uses Authorization Code + PKCE.
- Redirect URI is exactly `${origin}/callback/spotify`.
- Reads SillyTavern callback envelope `?source=spotify&query=...`, matching the official Spotify extension.
- PKCE verifier/client id survive the callback in sessionStorage.
- Exchanges code directly at Spotify token endpoint.
- Immediately verifies `/v1/me` and current playback after success.
- Refresh token support remains.
- Existing v0.5.1 vinyl UI is retained.
