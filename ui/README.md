# JCC Runtime UI

This folder contains the Electron application and React UI for JCC Runtime.

Run `npm ci`, then `npm run start` from this directory for development.
Run `npm run build` and `npm run start:built` for the built renderer.

Current intent:
- Any coding harness can maintain the UI through the repository's engineering entrypoints.
- Runtime UI source belongs here; personal design-tool state is not a dependency.
- Current machine contracts and repo-local design documents govern behavior and presentation.

Primary documents:
- `PRODUCT.md` defines what the UI is for and what modes it supports.
- `DESIGN.md` defines the visual and interaction direction.
- `IA.md` maps the screens, panels, and information hierarchy.

Do not treat this as a marketing landing page. The first screen is the usable runtime coach workspace.
