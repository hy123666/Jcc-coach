# Android Companion APK Track

REQUIREMENTS-STATUS: paused. This is a paused side track and must not be used as a MuMu desktop release gate.
See
`docs/requirements/requirements-registry.json`.

The current product/runtime mainline is the MuMu desktop runtime:

- MuMu logcat / `gi_plugin_jkchess` bridge for board, bench, shop, and phase data.
- Scoped RapidOCR ROI for HUD economy and choice-window text, MuMu `4357`/gated
  `4356` for item facts, and icon/host vision evidence only as fallback or
  conflict-check input.
- Desktop runtime watcher, scorer, advice lifecycle, and postgame/memory backend.

This APK companion code is kept as an isolated prototype for a future phone/other-emulator
path. It should not be required by the MuMu desktop runtime, must not be used as
a MuMu desktop release gate, and changes here should not be used to unblock or
validate the mainline unless the APK track is explicitly resumed.

Do not commit Gradle/CMake/build caches from this directory. Keep only source, assets, and
small reproducible configuration files.
