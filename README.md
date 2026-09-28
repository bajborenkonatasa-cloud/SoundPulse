# SoundPulse v0.8.0 — Music Engine foundation

- Keeps working Spotify account/playback/vinyl behavior from v0.7.6.
- Adds compact RP setting “Передача модели”: Всегда / При смене трека / Умно / Никогда.
- Adds local recent-track memory (last 20) for future Scene Match logic. This local bookkeeping uses no LLM tokens.
- Keeps Auto / In-world / Soundtrack / Visual only and reaction intensity.
- “Никогда” explicitly clears/blocks SoundPulse music prompt injection while Spotify UI/playback continues.
- No separate LLM call is added by this version.
