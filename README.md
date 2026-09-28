# SoundPulse v0.6.1
Fixes the missing SoundPulse settings drawer.
SillyTavern may create its Extensions settings host after SoundPulse initializes, so SoundPulse now retries only the lightweight settings mount for up to 15 seconds and then stops.
Falls back between #extensions_settings2 and #extensions_settings.
Spotify OAuth PKCE code from 0.6.0 is unchanged.
