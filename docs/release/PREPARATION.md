# Public Source Preparation

> Historical export record from September 23, 2026. The contents and pending
> packaging statements below describe that earlier export, not the current
> release. Current status: README.md and docs/release/PUBLICATION-CHECKLIST.md.

## Contents

- Source baseline: `e2073d77158150afdc32a56fa22970bfa81f0498`.
- S18 / 18.2a active Core, Common, semantic features and all declared S18
  patch source artifacts. Earlier S18 base material remains available for rebuilds.
- Current and two existing previous full Ranking generations, dated
  September 21, 22 and 23, with current-Core recipes, semantic annotations
  and compact current-Core trend history.
- Runtime/UI source, tests, project contracts, maintenance documentation
  and repo-local skill. The Android companion source is retained as a paused
  optional component; it is not the current Windows product's required frontend.
- The redacted S17 OCR test image is a regression fixture, not production S17 data.

## Excluded

- Original `.git` history and remote configuration.
- Personal Runtime SQLite, conversation history, provider sessions, credentials,
  local dependencies, Python environments and development caches.
- S17 production source registration, S17 data and inactive compiled Core bundles.
- Developer OMX plans/state and personal design-workspace metadata.

The current/previous Ranking mirrors are retained for compatibility with existing
update/diff tooling. Immutable generations and the active closure remain authoritative.

## Verified In This Directory

- Active Core loader validates immutable artifact identity and hashes.
- All declared S18 patch source artifacts exist.
- Active Ranking/Recipe closure resolves: 492 winning and 57 popular recipes.
- Runtime Ranking signal contract passes for the included statistics date.
- Ranking generation-store regression test passes.
- Common token/private-key signature scan was reviewed; the matches were test
  identifiers containing `task-`, not real credentials. This is a bounded scan,
  not certification that every possible secret format or binary is covered.

## Remaining Release Work

- Select and finalize the noncommercial source license and third-party notices.
- The source launcher still invokes `npm` and expects `ui/node_modules/electron`.
  A fresh checkout cannot be launched by double-clicking the shortcut without
  installing and building dependencies. A Windows installer must ship the built
  Electron application and the Node runtime needed by its daemon, or install
  them before creating a usable shortcut.
- Bundle a working OCR runtime and its model assets. The current source defaults
  to `.venv-ocr/Scripts/python.exe`, which is intentionally excluded from this
  source export. Verify the resident worker actually loads and reads a captured
  choice panel and HUD on a clean Windows account; static OCR tests alone do
  not prove first-run readiness.
- Ship `tools/bin/adb.exe` with its DLLs in the Windows distribution, document
  their provenance and applicable notices, and verify discovery, shell, logcat,
  frame capture and watcher restart on a machine without ADB on `PATH`.
- Check that the bundled Core, Common, Ranking and Recipe active pointers resolve
  after installation, including paths with spaces and a non-admin install.
- Codex CLI and Kimi Code are external user-installed Hosts. First run must
  report which is detected, whether it is authenticated and whether native JCC
  tools can be registered; do not report a ready chat session before Host
  initialization succeeds. MuMu, the game and ADB access remain user setup.
- Run a clean-machine acceptance journey: first launch, lobby preset answer,
  MuMu discovery, Start Match, 2-2 cruise, choice OCR, HUD refresh, lineup card,
  Stop Match, relaunch and a second fresh Match. Verify that failures are visible
  and actionable rather than silently marked ready.
- Migrate legacy repository-wide tests that explicitly rely on retired S17 or
  excluded developer documents into isolated fixtures as part of release gating.
- Install clean dependencies, build and test the actual Windows distribution,
  including CLI authentication, OCR setup, MuMu and a live Match.
- Create the separate public repository and initialize its first commit only
  after release preparation is reviewed. No public remote was created here.

## Installation Dependency Audit (2026-09-25)

This is an adversarial audit of the first-use Windows installation path. The
source copy being usable is not evidence that a clean installed copy is usable.
The following requirements are release gates, not optional documentation.

### Must ship inside the Windows package

- Packaged Electron application, built `ui/dist`, Electron's bundled Node
  runtime, the daemon entrypoint, and all runtime JavaScript modules. The
  production launcher must not call `npm`, `node` from `PATH`, Vite, or a
  repository-relative development script.
- A self-contained OCR execution environment. This means a supported embedded
  Python runtime or equivalent packaged worker environment, RapidOCR and its
  native dependencies, and every OCR model/config asset required for an
  offline first run. The current repository contains the worker and YAML
  configuration, but the audit found no packaged OCR model files and the
  resident-worker lifecycle check still fails when `.venv-ocr` is absent.
- OCR paths must resolve from the installed resource directory, not from
  `.venv-ocr/Scripts/python.exe` relative to the current working directory.
  Model paths must be explicit and immutable inside the package or copied to a
  known user cache; first OCR use must not silently download a model.
- `tools/bin/adb.exe`, `AdbWinApi.dll`, and `AdbWinUsbApi.dll`, or an equivalent
  packaged ADB client. Native executables and DLLs must be outside the Electron
  ASAR archive or configured for unpacking. The installer must verify their
  hashes/provenance and ship the applicable third-party notices.
- Current S18 / 18.2a Core and Common, the active Ranking generation, the two
  previous full Ranking generations, recipes, and the compact trend history.
  These are read-only product data; user state and update scratch files are not
  package data.
- Runtime contracts, host initialization instructions, repo-local maintenance
  skill and release metadata required by the packaged host path. The package
  must fail clearly if a required contract is missing rather than emitting a
  misleading generic Host error.

### Must be provided by the user

- A supported external Host: Codex CLI or Kimi Code. The installer cannot ship
  credentials. First run must detect the CLI, authentication state, model
  availability, and native JCC tool registration independently for the current
  session. A global capability flag is not enough to mark a live session ready.
- A working model/provider connection and any required network, proxy or
  account access. Provider failure must be shown as a Host/provider failure,
  not as missing Core, Ranking, OCR, or ADB data.
- MuMu or another emulator with ADB enabled, the game running, and the required
  in-emulator JCC companion/tool where applicable. Bundled ADB is only the
  client; it does not include the emulator, the game, or the user's device
  session. The UI must distinguish “ADB client present” from “device/emulator
  actually connected”.

### Must be writable outside the installation directory

- SQLite runtime state, daemon metadata, logs, OCR captures, watcher state,
  provider/session state, ranking update scratch data, and user exports. The
  current default is `.jcc-runtime-data` under the repository root and must be
  changed for the packaged app to a per-user writable location such as the
  Electron user-data directory. Installing under `Program Files` as a standard
  user must not make the app read-only or require elevation for normal play.
- Updates must use a temporary user-writable staging directory and atomically
  switch the active Core/Ranking/Recipe pointers. A failed update must leave
  the previous active snapshot usable.

### Adversarial clean-install scenarios

The installer is not ready until all of these pass on a fresh Windows account
with no developer tools installed:

1. Install and launch from a path containing spaces, without Node.js, npm,
   Python, or ADB on `PATH`; the shortcut opens the packaged UI and the daemon
   becomes ready without a console window.
2. Run from a non-admin account and from a protected install directory; state,
   logs, OCR output, and update staging are written to the user data directory.
3. Start with no network, then run OCR and inspect the current Core/Ranking;
   bundled OCR models and data must work offline and no silent model download
   may be required.
4. Remove or invalidate Codex/Kimi authentication; the UI reports the missing
   Host/auth/tool capability and does not claim that chat is ready. Restore it
   and verify a new session registers `jcc.query_knowledge` and `jcc.calculate`.
5. Test no emulator, emulator with ADB disabled, wrong port, and healthy
   `127.0.0.1:7555`. The UI must report the real state; Start Match must not
   enter a false “connected/listening” state.
6. Verify ADB shell, logcat, bounded frame capture, watcher restart, OCR
   resident-worker restart, HUD refresh, choice sensing, and clean Stop Match.
7. Run lobby chat, a first Start Match, 2-2/3-2 strategic checkpoints, lineup
   card generation, relaunch, and a second fresh Match. No stale task, old
   session, old snapshot, or prior user's state may leak into the new session.
8. Update Ranking/Core from a clean install, verify active-pointer closure and
   rollback after an interrupted update, then uninstall without deleting user
   data unless the user explicitly chooses that option.
9. Build a release SBOM/license notice set covering Electron, Python/OCR,
   RapidOCR model files, ADB, and other bundled native dependencies. Scan the
   final installer and unpacked app for credentials, local paths, SQLite files,
   chat logs, and development caches.

### Current blockers confirmed by this audit

- No completed Windows installer has been built or tested. The current shortcut
  remains a source/development launcher that invokes npm and expects
  `ui/node_modules/electron`.
- No bundled OCR Python environment or model package is present in this source
  copy; the resident-worker lifecycle test fails when `.venv-ocr` is missing.
- The Electron main process and daemon still assume a repository-root layout in
  several paths. Packaged-resource resolution, ASAR unpacking, and the user
  data root must be implemented and tested before claiming Portable/installer
  readiness.
- ADB discovery has been improved and the bundled client is present, but the
  final installed-path, native-DLL, provenance, and no-PATH clean-machine gate
  remains outstanding.
- External Host authentication, MuMu/game setup, and a real live Match remain
  user/environment prerequisites and must be tested as explicit failure states.

The conclusion of this review is therefore: the source release copy is a sound
base for packaging, but it is not yet a first-use installer. Python/OCR,
models, packaged Electron/Node, user-data relocation, ADB native resources,
first-run diagnostics, and the clean-install journey are all required before
public release.

This source copy is ready for continued release preparation. It is not an EXE,
a certified clean-machine installation or a completed public publication.
