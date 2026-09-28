# SoundPulse v0.7.2
Concrete bridge bug fix:
- v0.7.1 called `ctx()` inside importOfficialSpotifySession(), but no `ctx()` function exists in SoundPulse.
- The exception was caught silently, so the bridge always reported/fell back as if no official Spotify session existed.
- v0.7.2 uses `getContext().extensionSettings` correctly.
This also avoids the callback race when both official Spotify and SoundPulse are enabled: if official Spotify consumes the shared `/callback/spotify` query first, SoundPulse can import the token it saved.
