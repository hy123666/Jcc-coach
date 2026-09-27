# MuMu Desktop Runtime

Requirements authority is classified by
`docs/requirements/requirements-registry.json`; runtime mode authority is
`data/runtime/jcc/runtime-ui-mode-contract.json`.

MuMu desktop runtime reads `adb logcat` from MuMu gameassist while the official JCC assistant is running.

The runtime backend/UI should reuse the persisted `device_connection` when one is
already bound. It should run `tools/discover-jcc-mumu-adb-target.mjs` only when
the user clicks `Detect MuMu and Connect` or an explicit re-scan action, then use
`recommended_target.serial`. Users should not need to know MuMu's local ADB port.

Minimal backend flow:

```powershell
node tools\start-jcc-mumu-runtime-watch.mjs
```

`recommended_target.serial` may be a normal emulator serial such as `emulator-5554`
or a host/port serial such as `127.0.0.1:7555`. Treat it as an opaque ADB
device id in the product UI.

For a UI health check without starting the long-running watcher:

```powershell
node tools\start-jcc-mumu-runtime-watch.mjs --dry-run
```

The backend writes `.omx/state/jcc-mumu-runtime-service.json` with discovery status,
the recommended ADB serial, and the watcher command.

## Future UI Requirement

When the product UI is built, MuMu desktop setup must expose a one-click action:

```text
Detect MuMu and Connect
```

Expected UX:

- User opens MuMu.
- User opens JCC.
- User enables/opens the official `金铲铲阵容大师` assistant.
- User clicks one button in our runtime UI.
- Backend runs `tools/start-jcc-mumu-runtime-watch.mjs --dry-run` for detection
  only from this user-triggered bind/re-scan action, never during normal app
  startup.
- UI displays a plain status such as `MuMu/JCC connected`.
- Advanced details may show the opaque ADB serial, but normal users should not see or edit ports.

The UI should not ask users to find MuMu install paths, ADB paths, local ports, or device serials unless automatic discovery fails.

## Verified GI Commands

- `4352`: bench/wait units.
- `4353`: current-view hero list.
- `4354`: shop units.
- `4358`: phase/status.

## Phase Gate

- `4358 s=1`: planning/actionable.
- `4358 s=2`: observing/non-self current view; do not bind it to battle_state.
- `4358 s=4`: choice-window attention trigger. It can be augment, item/anvil,
  or another active descriptor-owned choice panel. In active product flows it
  reserves the choice lane and may prefill the relevant composer prompt, but it
  must not start OCR or host multimodal candidate intake.
- `4358 s=5`: transition/unstable.

`s=4` does not prove the user's final selection. Treat it as a proactive wake-up
signal only. For augment/hex, descriptor-owned season choices, and item/anvil panels,
advice requires a current-match user report. A refresh action prefills the
refreshed-report prefix and waits for the user to send; it does not auto-send or
capture a frame. The draft is not final match state:

```text
s=4 or runtime UI mode
-> prefill the mode composer
-> user reports the visible candidates
-> agent gives advice
-> runtime asks for confirmation
-> user/UI confirms selected option or reroll/skip
-> runtime writes selected_augments / current match variables from that same-match structured confirmation
```

The user-triggered owned-augment detail panel OCR path is diagnostic recovery
for reading effect text. It does not replace the structured card confirmation
and cannot write the final selected augment by itself.

For augment/hex advice, the agent may recommend `choose`, `reroll_slot`,
`reroll_multiple`, `skip/wait`, or ask for extra context from hard-data, big-data,
and current live_state. The 2-1 augment report must include current equipment;
later augment reports use equipment deltas unless the user changes more facts.
If the user rerolls and reports new visible choices, emit a new draft under the
same active augment-choice mode. The final selected augment is still match
memory only after confirmation.

For a descriptor-owned season choice, the product path is explicit UI intent.
The active major-season descriptor supplies the mode, candidate shape, stage
semantics, and canonical write target. Runtime waits for the current-match user
report and does not run OCR or host multimodal fallback for candidate names.
Seasons that declare no such choice expose no extra mode or manual variable.

## Runtime UI Modes

Future UI should expose mode buttons instead of asking the agent to infer every
choice screen from a screenshot:

Authoritative mode semantics live in `data/runtime/jcc/runtime-ui-mode-contract.json`.
The important product behavior is:

- `巡航模式`: default always-on mode. It consumes live_state continuously and emits
  short proactive advice only when a high-value strategic trigger fires.
- `本局目标`: top panel for the user target plus only the manual fields declared
  by the active major-season descriptor. A season with no fields shows none.
- `赛季选择`: shown only when the active descriptor registers a season-owned
  choice mode; candidates come only from the current-match user report.
- `海克斯选择`: can be woken by `s=4`; supports streaming advice drafts and
  reroll actions, but final selection requires confirmation.
- `装备/锻造器选择`: prefill `选哪个`; wait for the user to report the visible
  item/anvil candidates.
- `Cruise`: default always-on mode. It consumes live_state continuously and emits
  short proactive advice only when a high-value strategic trigger fires.
- `Match target`: top panel for user intent and only descriptor-declared manual
  fields.
- `Season choice`: descriptor-driven and hidden when the active season declares
  no season-owned choice.
- `Augment choice`: can be woken by `s=4`; supports streaming advice and reroll
  actions from current-match user reports, but final selection requires
  confirmation.
- `Item choice`: accepts the user-reported item/forge panel options and combines
  them with own items, board, augments, and plan.
- `Refresh self status`: explicitly refresh local board, bench, shop, HUD
  economy text, augments, and items. HUD text uses the scoped RapidOCR ROI path
  for `phase.stage_round`, `economy.hp`, `economy.gold`, `economy.level`, and
  `economy.xp`.
- Opponent board/power/counter-positioning modes are not product paths. MuMu
  current-view data does not reliably expose opponent unit identity.

The contract is `data/runtime/jcc/runtime-ui-mode-contract.json`. If no mode is
supplied, the old visual classifier is only diagnostic/fallback evidence for
non-choice facts. It must not populate active choice candidates.
`unknown_choice_panel` is an exception state, not the main product route.

Streaming advice is event-driven, not an endless monologue. The watcher keeps
live_state fresh in the background. In `巡航模式`, the agent may proactively speak
when the value is high enough:

- after automatic shop refresh, whether to hold key units, pairs, pivot units, or
  sell for interest;
- when HP/economy/streak/board strength implies leveling, rolling, sacking, or
  stabilizing;
- when shops, items, augments, user-confirmed scouting notes, and hard data make
  the current target lineup better or worse;
- when the next high-impact decision needs a missing user-confirmed fact.

Background observation updates immutable latest decision snapshots. Only a
derived, registered, materially changed decision may enter the decision agenda
and compete for the single Host answer lane.

Every proactive output must pass an interrupt threshold, cooldown, and dedupe
check. The visible answer should stay short: conclusion, reason, action. If the
user types extra analysis into the chat box while a mode is active, merge that
message into the same mode context and recompute a new short draft. Stop a task
stream when the user confirms/skips the choice, switches mode, starts a new match
session, or the visible choice/manual note becomes stale; then return to
`巡航模式`.

Normal proactive cadence is at most one visible answer per one to two rounds
unless a higher-priority registered decision supersedes it. Suppress and
recompute stale cross-stage advice instead of delivering it late.

## Advice Output Contract

Advice output uses `host_cli_main_model_required`:

```text
advice_task / response_draft stable fields
-> UI, CLI, voice, logs, tests consume predictable data
-> backend emits host_cli_agent_request
-> current CLI main model renders the final natural coach text
```

Required machine fields such as `task_id`, `trigger_id`, `urgency`,
`confidence`, `response_draft.summary`, `response_draft.evidence`, and
`response_draft.actions` must stay present. They are not the exact words the
player must see. The visible answer should usually stay short, but that is a
rendering guideline rather than a rigid template. The agent may rewrite, merge
fields, omit low-value evidence, or expand details when the user asks. Do not
render advice as a table by default. Never show hidden chain-of-thought; show
concise reasons, evidence, and concrete actions.

## Debug Replay

Production runtime must not persist raw screenshots, raw logcat, full live_state,
or full estimator context by default. Debug replay is opt-in and lightweight:

```powershell
node tools\run-jcc-cruise-runtime-pipeline.mjs --live-state <live-state.json> --debug-trace .omx\runtime-evidence\jcc-cruise-debug\trace.jsonl
```

Each JSONL row records only the replay summary needed to answer why a suggestion
appeared: triggered `advice_task` summaries, compact live_state counts/samples,
estimator scalar scores, scorer suppression reasons, response draft summaries,
and user confirm/skip/message summaries. Use `--debug-max-mb <number>` to rotate
the trace file. This is for fixing bad advice, not for storing a whole match.

## Cruise Strategy Scorer

Cruise strategy scoring is implemented as a runtime scorer, not as fixed
glossary-driven strategy:

```powershell
node tools\score-jcc-cruise-strategy.mjs --live-state <live-state.json>
```

The scorer outputs `advice_tasks[]` with `trigger_id`, `value_score`,
`confidence`, `short_advice`, current-state `evidence`, suggested `actions`, and
`semantic_labels`.

`data/runtime/jcc/cruise-strategy-semantics-contract.json` is only the vocabulary
and label layer. Actual advice must be computed from current `live_state`, JCC
hard-data, daily ranking/big-data priors, user preferences, and confirmed
current-match variables. If current evidence is weak or the value score is below
the cruise interrupt threshold, the scorer must stay quiet.

## Local Board Rule

When a new match session starts while the camera is on the user's own board:

```text
bench_units = 4352.wl
board_units_candidate = 4353.hl - overlapping 4352.wl
```

Promote only after visible shop anchoring and fresh current-view evidence.
Freeze during `s=2`, `s=4`, and `s=5`.
Also require current-view bench-overlap evidence before updating the local board
candidate. If the user has moved to another board, `4353` may still update, but it
must remain `current_view` evidence rather than local board state.

## Self-View Anchor And Opponent Boundary

Authoritative MuMu view and opponent boundary:

- `S=1` means the user is in the own actionable/self-board view. Runtime may
  promote own board/bench/equipped-item facts only when `S=1` is paired with a
  fresh non-empty `4354` shop anchor.
- `S=2` means observing/non-self current view. Do not bind it to battle state.
  Runtime must not use S=2 `4353` data to update own board/bench/equipped items,
  and must never turn it into opponent board facts.
- `4353` is an own-unit candidate source only after the S=1 + fresh 4354 anchor.
  Without that anchor, keep it as scoped observation/diagnostic evidence only.
- `4354` non-empty shop is the strong own actionable view anchor. Empty shop is
  transition/observing evidence, not a board-unit source.
- `4357` is the primary left item rail / inventory equipment source.
- `4356` is current-screen visible equipment rectangles. Assign it to own units
  only by coordinate match to trusted S=1 + 4354 anchored `4353` units. Under
  S=2 or without the anchor, keep 4356 as unassigned diagnostics.
- Icon matcher output is fallback/conflict-check evidence only. It must not
  override 4357/4356 structured facts.

The product intentionally removed opponent board scouting, opponent power scan,
and counter-positioning modes. If the user provides manual scouting notes, store
them as user-confirmed context; do not fabricate them from MuMu current-view data.

## Item And Selected Augment Icons

MuMu GI provides the reliable own-state item path:

- `4357` is the primary left item rail / inventory source.
- `4356` visible equipment rectangles attach only to trusted
  `S=1 + fresh 4354 shop + 4353 own unit` coordinates.
- Left-item-rail icon matching is fallback and conflict-check evidence only.
- Final selected augments come from same-match structured card confirmation.
- User-triggered owned-augment text-panel OCR is diagnostic effect-text
  recovery only and cannot write the final selection.

Opponent item rails, opponent selected augments, and selected-augment side-rail
icon matching are not product sensing paths. Unknown choice facts remain missing
until the user confirms them through the structured choice card.

Item fallback templates are managed by:

```powershell
node tools\ensure-jcc-visual-icon-assets.mjs --kind item
```

This builds the scene-scoped item manifest without downloading by default. Add
`--download` only when preparing local left-item-rail fallback assets. Same-icon
item IDs remain ambiguous candidates unless 4357 or another trusted structured
fact resolves them. Active augment selection uses current-match user reports and
same-match confirmation, not OCR, host multimodal candidate intake, or
icon-template calibration.

## What GI Does Not Provide Yet

- HP.
- Gold.
- Level.
- XP.
- Opponent equipment ownership and unanchored `S=2` equipment assignment. Own
  inventory uses 4357, and own equipped items use anchored 4356-to-4353
  coordinate assignment; icon matching remains fallback/validation evidence.
- Local chair, owner, or player id.
- Other-player board/HP binding.
- Descriptor-declared current-match variables that have no reliable structured source.

Use scoped RapidOCR ROI for HUD text and explicit owned-augment text-panel
recovery only. Use host multimodal current-frame sensing as fallback for missing
or ambiguous visible facts outside active choice-candidate intake.
User-triggered `what should I choose` requests should first use the active
runtime UI mode and the current-match user-report composer. If visual facts are
low confidence or the user has not reported choice candidates, ask for user
confirmation instead of answering with fake precision.

Item forge/anvil choices are expected near the shop/card area, but active
product intake uses the user-reported candidate list rather than the
`regions.phase.shop_area_item_forge_panel` ROI. Fixed rounds such as `5-3`,
`5-7`, and `6-7` are strategy/common-knowledge hints only. They must not create
runtime context, pending advice, or automatic answers. The user should press
`装备/锻造器选择` or ask which item to choose.

The user must send the visible item/anvil candidates before the host scores that
choice.

Production choice confirmation is written through the daemon-owned SQLite
canonical match state and resolved from the compiled active choice descriptor.
The following command is a historical compatibility regression fixture only; it is not a
runtime state owner:

```powershell
node tools\build-jcc-choice-confirmation-state.mjs --compatibility-fixture --events <choice-events.jsonl>
```

The common, season-neutral confirmation boundary is
`data/runtime/jcc/choice-confirmation-hook-contract.json`. Season-specific
choice modes, stages, prompts, storage fields, and follow-ups belong to the
active major-season descriptor.

## Internal Lineup Display

The runtime uses the deterministic internal lineup renderer. Host answers should
return `pinned_result` with schema `jcc-internal-lineup-plan-v1`; the runtime
renderer owns the 4x7 board materialization. It does not generate external game
codes, does not drive browser/editor automation, and does not depend on
publishing flows.

The runtime UI should include four copyable internal lineup text slots:

- 目标阵容
- 当前过渡阵容
- 下一阶段变阵
- 己方站位调整

Each slot is a human-readable 4-row by 7-column board with hero names, carried items, stars when known, and position words such as `第1行左3` or `第4行右1`.

For self-board placement adjustment, output the minimal move list first, then a short tactical reason. Do not claim opponent-specific counter-positioning unless the user manually supplied those opponent facts. Example:

```text
【己方站位调整】建议改动：- 黛安娜：从第3行右1移到第3行左1。原因：保护主C并优化己方输出路径。
```

The contract is `data/runtime/jcc/lineup-display-contract.json`.

## Descriptor-Owned Match Variables

Common Runtime keeps only the season-neutral target-plan and fact-editor surfaces.
Optional current-match fields exist only when the active major-season descriptor
declares them. A season with an empty declaration exposes no extra fields. Confirmed
values are match-scoped, and a missing optional field blocks only advice that directly
depends on that field.
