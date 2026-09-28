# SoundPulse v0.7.1
Adds a migration bridge from the official SillyTavern Spotify extension.
If the official extension has an existing clientToken/access_token in SillyTavern extension settings, SoundPulse can copy that session into its own local token store and immediately verify `/v1/me` and playback.
The official extension does not have to remain enabled after its saved session is imported.
Direct PKCE remains available.
