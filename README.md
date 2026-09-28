# SoundPulse v0.6.3
Critical startup crash fix.
0.6.0–0.6.2 called handleCallback() before loadSettings(). handleCallback() evaluated settings.clientId while settings was still undefined, so the entire extension stopped before creating either the Extensions drawer or Magic Wand item.
Now loadSettings() runs first, and callback access is additionally guarded with settings?.clientId.
