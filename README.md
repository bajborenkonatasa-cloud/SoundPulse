# SoundPulse v0.5.0
Architecture fix for mobile SillyTavern:
- The mini vinyl is no longer a browser Popover/top-layer element.
- It is a normal fixed overlay with a deliberately modest z-index.
- SillyTavern drawers/settings/preset/API panels can therefore physically cover it.
- Magic Wand → SoundPulse toggles it.
- Drag, saved position, holographic sunlight sweep and double-tap hide are preserved.
