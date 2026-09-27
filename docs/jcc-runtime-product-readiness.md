# JCC Runtime Product Readiness

This document is the operator-facing readiness contract for the current JCC
Runtime product path.

Requirements authority is classified by
`docs/requirements/requirements-registry.json`; runtime mode authority is
`data/runtime/jcc/runtime-ui-mode-contract.json`.

## Product Shape

The runtime follows the Open Design-style split:

- Electron UI is a narrow interface.
- `ui/electron/runtime-daemon-server.js` is the independent OS daemon entry.
- `ui/electron/runtime-state-store.js` owns canonical `app.sqlite` state under
  `.jcc-runtime-data` by default, or `JCC_RUNTIME_DATA_DIR` when overridden.
- Host CLI adapters are thin, streaming, selected-context callers.
- Codex/Kimi/Claude style host models produce final AI-native coach text; they
  do not own JCC runtime world state.

## Local Startup

Use the repository-level scripts so product operations are discoverable:

```powershell
npm run runtime:bootstrap
npm run ui:start
```

`runtime:bootstrap` checks hard data, live rankings, rank-signal context, and
startup context-pack generation. It must not scan MuMu ports.

Live ranking refresh is an offline compilation boundary. "Offline" here means
deterministic update-time scripts, not an additional Agent/model analysis turn.
The refresh downloads
the current 掌盟 tier partitions, audits them, compiles the season-neutral
`lineup-strategy-index.json`, and promotes all current artifacts atomically.
The index uses the current national trait ranking as lineup-strength authority,
matches it to winning-lineup recipes by full trait-family sets and exact
breakpoints, and adds main carries, transitions, associated augments, hero
popularity, item packages, self-board templates, and compact reverse indexes.
Match runtime performs bounded target retrieval from this current-day index and
reconciles every prior with live state, hard data, confirmed choices, equipment,
stage, HP, economy, and user intent. After promotion, only a
compact signal is archived and history is pruned to 14 distinct dates; raw
snapshots remain limited to current plus previous. Historical signals and trend
summaries are excluded from active-match retrieval, ordering, Host context, and
Coach decisions; they exist only for diagnostics, rollback, and explicit lobby
review.

This compilation is deterministic and runs during the ranking update. It does
not open a second Agent analysis task. The script joins lineup rankings with
the active hard-data catalogs so main carries, carry item packages, associated
augments, core units, transition lineups, self-board templates, hero market
priors, and evidence quality are indexed before Start Match. Runtime attaches
the index only when the promoted audit passes and the manifest, rank signal,
strategy index, runtime season/patch tuple, package, and upstream version all
agree. A successful refresh automatically overwrites the same-date diagnostic
signal or prunes dates older than the latest 14 after atomically replacing its
diagnostic trend summary.

`ui:start` starts the Vite UI and Electron shell. Electron starts or reconnects
to the daemon through the daemon client.

## Windows Desktop Entry

Install the current repository shortcut with:

```powershell
npm.cmd run ui:shortcut:install
```

The developer desktop shortcut starts JCC Runtime without a console window and
focuses the existing Electron window when the application is already running.
It is not the public installer shortcut.

The release installer policy lives in `ui/electron-builder.yml` and
`data/runtime/jcc/windows-distribution-contract.json`. A player installation
must always create a desktop shortcut and a Start Menu shortcut targeting the
installed executable, never Node, npm, PowerShell, VBScript, Vite, or a
repository path. Public release remains blocked until a packaged Windows smoke
test proves install, desktop launch, single-instance focus, clean exit,
uninstall, and shortcut removal.

## Game Understanding Harness

The common coaching harness is split into three bounded layers:

- `data/game-knowledge/jcc/common/doctrine.json` and
  `complete-game-doctrine.json` contain season-neutral cost-curve doctrine:
  reroll anchors, four-cost and legendary-cap timing, emblem/pivot conditions,
  interest recovery references, and XP alignment. The compiler embeds them in
  the immutable Core Profile; Runtime never reads the retired
  `base-game-rules.json` source format. These are priors, not fixed scripts.
  Current patch/rank-bracket data,
  confirmed choices, active-season variables, equipment, copy progress,
  contested timing, target structure, board readiness, HP, economy, XP, and
  explicit user direction may override them when the evidence is stated.
- `tools/build-jcc-lineup-lifecycle-context.mjs` derives a compact current-turn
  lifecycle and own-board readiness object. It estimates readiness; it does not
  simulate combat or infer opponent units.
- The same object is consumed by leveling/economy context, combat-cap context,
  proactive Cruise scoring, and the Host context when available. Rankings are
  evidence-backed candidate priors, while current live facts and confirmed
  user choices retain precedence. Ranking packets distinguish stable broad
  evidence from high-ceiling low-sample evidence; top-one rate alone is never
  sufficient to call a line a stable meta default.
- Board readiness exposes the current decision gap, next-level value, immediate
  upgrade evidence, and an estimate confidence. These are cheap own-state
  signals, not a battle simulator. Strategic answers use a bounded conditional
  shape: default line and reason, at most two action-changing conditions, and
  the immediate action.

The offline benchmark at
`data/runtime/jcc/fixtures/coach-decision-benchmarks/common-lineup-lifecycle-v1.json`
is the regression floor for common game understanding. It must remain free of
season-specific champion or mechanic names. Its counterexamples must cover
mixed cost curves and tempo exceptions so expert heuristics cannot become
universal prohibitions. Postgame decision/outcome evidence
may be used by the lobby review flow only after user approval; it must never
create live-match Host work or silently rewrite strategy memory.

## Verification

Normal local product gate:

```powershell
npm run runtime:product-gate
npm run runtime:goal-audit
npm run runtime:benchmark:modes
```

`runtime:goal-audit` is the goal-specific acceptance map for the current
runtime-coach objective. It runs the product gate plus strict MuMu/Kimi checks,
then maps the evidence back to the user-facing requirements: Start Match live
attachment, cruise triggers, current-match user-reported choice intake, scoped
RapidOCR HUD/owned-augment recovery, own-board promotion, host-coach provenance, removed
opponent scan guardrails, `lineup_card` pinned-card output, and selected
hard-data / big-data context. Kimi remains optional for the current
Codex-first product path and is reported as pending until authenticated live
generation passes.

`runtime:benchmark:modes` does not call a real host model. It verifies selected
host context for daily chat, active-match chat, and every runtime mode: ordinary
greetings stay light, strategy questions attach user preferences, current-season
catalog, and daily rankings, and active-match modes carry compact `live_state`
evidence.

Repository hygiene:

```powershell
npm run repo:hygiene
```

Generated-artifact cleanup:

```powershell
npm run repo:cleanup:dry
npm run repo:cleanup
```

Strict external acceptance gates:

```powershell
npm run runtime:live:mumu
npm run runtime:live:codex
npm run runtime:login:kimi
npm run runtime:verify:kimi-discovery
npm run runtime:live:kimi
```

The strict MuMu gate requires a real accepted MuMu/JCC ADB target. The strict
Codex gate requires an authenticated Codex CLI and verifies JSON-event-stream
selected-context transport. The strict Kimi gate requires an authenticated Kimi
CLI. `runtime:login:kimi` launches the same Kimi CLI found by the runtime
adapter discovery order: explicit settings, the last successful command,
user-selected search roots, `KIMI_BIN`, `PATH`, package-manager global bins,
common user-level bin directories, bounded common install-root scanning, and
repo-nearby developer installs.

## Data And Retention Rules

- Never commit `.jcc-runtime-data`, `.omx/runtime-evidence`, screenshots, logs,
  `ui/dist`, `ui/node_modules`, APK build outputs, or local caches.
- `.jcc-runtime-data/app.sqlite` is the local canonical SQLite runtime store.
- Legacy `.omx` JSON is compatibility/debug evidence only.
- Full live_state, raw frames, and raw logcat are debug-only explicit retention
  paths, not product defaults.
- Permanent runtime telemetry intake, proxy evidence bundles, and installed
  acceptance artifacts are retired and are not readiness prerequisites.
- Fault diagnostics are default-off, bounded, asynchronous, and retained for
  at most seven days. Review retains at most 20 compact structured postgame
  summaries and never raw screenshots, full live state, or complete Host
  payloads.

## What This Gate Does Not Claim

- It does not claim Kimi live generation unless `runtime:live:kimi` passes.
- It does not claim Codex live generation unless `runtime:live:codex` passes.
- It does not claim MuMu live-game acceptance unless `runtime:live:mumu` passes.
- It treats current-match user reports as the only active candidate source for
  augment, active-season, and item/anvil choices. Choice OCR and multimodal
  tools are compatibility/calibration paths and must not populate active choice
  facts. HUD and explicit owned-augment text-panel OCR remain supported.
- It treats `data/runtime/jcc/runtime-ui-mode-contract.json` as the current
  machine truth for runtime modes, including `lineup_card`.
