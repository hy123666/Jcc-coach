# JCC Runtime Companion Product APK

REQUIREMENTS-STATUS: paused. This document describes a parked Android companion
prototype. It is not current MuMu desktop requirements authority and must not be
used as a MuMu desktop release gate. See
`docs/requirements/requirements-registry.json`.

This is the Android-side information source for coach mode. It captures the screen with user-authorized MediaProjection, keeps frames memory-only, extracts candidate observations, and streams structured JSONL to the desktop runtime agent.

## What Works Now

- `android-companion` builds a debug APK with a MediaProjection foreground service.
- The APK has a minimal UI for desktop host/port, start new match, stop capture, and session status.
- The APK creates a new `match_session_id` when the user taps `Start New Match Session`.
- Captured frames are consumed in memory through `ImageReader`.
- The APK emits JSONL `frame_meta`, `heartbeat`, `roi_observations`, `ocr_text_blocks`, and candidate-only `semantic_observations`.
- ROI observations include top bar/round candidate, gold, level, HP scoreboard candidate, augment slots, shop slots, 28 board slots, and 9 bench slots.
- OCR uses ML Kit Chinese text recognition for text ROIs.
- Champion identity candidates use 365 bundled MuMu-derived hero icon templates plus perceptual-hash matching.
- It does not persist screenshots or frame payloads.
- `tools/jcc-runtime-companion-intake-server.mjs` validates and optionally writes accepted semantic JSONL.
- Mismatched `match_session_id` messages are quarantined instead of merged.
- Base64 frame/image payload fields are rejected by default.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-jcc-android-companion.ps1
```

Debug APK:

```text
android-companion\app\build\outputs\apk\debug\app-debug.apk
```

## Runtime Intake

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-jcc-runtime-companion-intake.ps1 -Port 49377
```

The Android emulator should connect to the host through `10.0.2.2:49377`.

## Verification

```powershell
node tools\verify-jcc-runtime-companion-intake.mjs
node tools\verify-jcc-companion-product-apk.mjs
powershell -ExecutionPolicy Bypass -File tools\build-jcc-android-companion.ps1
```

## Current Limits

- Local verification proves build/schema/assets only. OCR quality, ROI calibration, and champion match accuracy need MuMu live-screen testing.
- APK output remains candidate-only. Desktop runtime must promote observations into verified `board_units` / `bench_units`.
- Remote networking outside the same LAN is intentionally not included yet.
