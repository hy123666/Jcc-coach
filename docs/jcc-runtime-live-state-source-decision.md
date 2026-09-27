# JCC Runtime Live-State Source Decision

Requirements authority: current authoritative requirement. Registry:
`docs/requirements/requirements-registry.json`.

## Decision

Do not promote Android net-log action candidates or MuMu gameassist candidate classes directly into final `board_units` / `bench_units`.

For PC TFT, the best available reference is Overwolf's Teamfight Tactics Game Events Provider: it exposes first-class `board_pieces`, `bench_pieces`, and `shop_pieces` events. That is the kind of source that can safely feed a reducer or live state model.

For JCC on Android/MuMu, the closest observed equivalent is MuMu's private NemuInit bridge. It is not a public SDK, but it does register `gi_plugin_jkchess` and dispatches structured board/bench/shop/status payloads into MuMu gameassist. Treat this as the primary source to investigate before spending more live games on 3D visual identity.

Update from live MuMu testing: the desktop MuMu runtime does not need the Android companion APK for these GI payloads. MuMu's own `com.mumu.gameassist.jkchess` process writes `gi_plugin_jkchess` payloads through `nemuinit`, and the desktop runtime can read them from `adb logcat` as a read-only source.

Current product decision for the MuMu desktop version: JCC Runtime daemon owns
state in `.jcc-runtime-data/app.sqlite`; legacy JSON is mirror/debug output
only. Use MuMu logcat GI as the primary real-time source for board/bench/shop
and phase candidates. Use scoped RapidOCR ROI only for HUD self-state text and
the explicit owned-augment text-panel recovery action. Augment choice, the S17
star-god two-choice, and item/anvil choice candidates are current-match user
reports only, with no OCR or host CLI multimodal fallback for candidate names.
Host CLI multimodal current-frame sensing remains fallback/conflict-check evidence
outside active choice-candidate intake. Keep the Android companion path paused.
Do not wire companion OCR/ROI/icon tools into the MuMu desktop product mainline.

Catalog decision: resolve runtime identities through `data/runtime/jcc/mumu-catalog-overlay.json`, generated from decrypted MuMu `cfg.json`. The overlay supplies current-season Chinese names, ids, icon URLs, and OCR dictionaries for champions, augments/star-gods, equipment, and traits. Project hard-data remains the mechanics/formula/strategy source; daily Zhangmeng/ranking data remains the big-data strategy source. MuMu `lus.json`, `lineup_index`, and `user_lineup` are excluded from strategy and may only be used as format evidence.

## Evidence

Repo-local MuMu evidence:

- `data/runtime/jcc/mumu-gameassist-runtime-schema.json` observes `BuyHeroInfo`, `WaitHeroInfo`, `SellHeroInfo`, `GiHeroInfo`, `GiWaitHeroList`, `PlayerBattleInfo`, `XYPosition`, and `ChessPositionApi`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/mumu/gameassist/startup/ServiceInitializer.java` registers `gi_plugin_jkchess` through `NemuInitProxy.setNemuInitMessageHandler(...)`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/U3/C1590d.java` is the `LocalNemuInitMessageHandler` dispatcher:
  - `4096`: game start;
  - `8192`: game over;
  - `4352`: `GiWaitHeroList`, likely bench/waiting units;
  - `4353`: `GiHeroList`, likely visible board units;
  - `4354`: `GiBuyHeroList`, shop units;
  - `4358`: `GiGameStatus`, game status/phase.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/mumu/nemuinit/NemuInitProxy.java` is only a stub inside the APK. The real implementation is supplied by the MuMu host/runtime, which means the structured payload source is outside the APK code we can directly call as a normal Android app.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/mumu/gameassist/games/jcc/data/WaitHeroInfo.java` shows `heroId`, `heroEntityId`, and `pos`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/mumu/gameassist/games/jcc/data/GiWaitHeroList.java` wraps a list of `GiHeroInfo`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/mumu/gameassist/games/jcc/data/PlayerBattleInfo.java` contains battle-context lists, including hero/entity/position-like arrays.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/com/benjaminwan/ocrlibrary/OcrEngine.java` and `OcrResult.java` prove bundled OCR use.
- `data/runtime/jcc/mumu-dex-usage-map.json` records screen-capture, OCR, candidate model, position model, and config-loading usage.
- `data/runtime/jcc/mumu-nemuinit-bridge-map.json` records the stronger bridge evidence:
  - registration of `gi_plugin_jkchess`;
  - command dispatch for `4096`, `8192`, and `4352` through `4358`;
  - payload JSON keys for `GiHeroList`, `GiWaitHeroList`, `GiBuyHeroList`, `GiEquipList`, and `GiGameStatus`;
  - native host symbols for `sendNemuInitCommand`, `setNemuInitProxyCallback`, and `handleNemuInitMessage`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/i3/A.java` shows `4358` status `s=4` starts `begin buy hex ocr`.
- `.omx/archive/mumu-reverse-evidence-20260610.tar.gz!/mumu-gameassist-jadx/sources/i3/H.java` shows MuMu parses hex OCR by matching OCR `TextBlock` text against `SeasonConfig.hexes`, logs `buy hex:` / `buy hex list:`, stores hex IDs in `f9646n`, and updates in-memory `buyHexTips`.

Live test evidence:

- In the 2026-06-08 static prep test, user-visible truth was board: Caitlyn, Cho'Gath, Aatrox, Rek'Sai, Maokai; bench: Poppy, Teemo, Cho'Gath, Caitlyn.
- Companion visual occupancy fluctuated and identity confidence was too low for promotion.
- Android net-log action signals contained multiple chairs and stale/global action events. They did not provide a complete current local board+bench snapshot.
- In the 2026-06-09 MuMu live test, `adb logcat` observed real `gi_plugin_jkchess` payloads:
  - `4352 {"wl":[...]}` for bench/wait units;
  - `4353 {"hl":[...]}` for hero lists;
  - `4354 {"bl":[...]}` for shop units;
  - `4358 {"s":...}` for game status.
- In the 2026-06-09 MuMu hex live test, `4358 {"s":4}` was observed during augment selection. MuMu did not expose a separate GI augment-choice payload. Earlier experiments recovered text from helper OCR logs, but that path is now retired from product live_state/advice because it is passive, inconsistent, and easy to mix with stale choices. Current runtime uses `s=4` only as a choice-window attention trigger/reservation signal. Candidate names for augment, S17 star-god two-choice, and item/anvil flows come from current-match user reports only.
- The ordinary companion APK callback was not the usable path: MuMu gameassist returns `ok` before later callbacks, so the desktop runtime should read `nemuinit` logcat for the MuMu version.
- Calibration finding: `4353` can include units that also appear in `4352` at bench coordinates. It is now modeled as `current_view`, not verified local `board_units`.
- View-scope finding: in the 2026-06-09 keep-alive session, filtered `4353` counts reached 15 after removing bench overlap. That exceeds a normal local board cap and is strong evidence that `4353` can be combat/current-view or all-visible scope in some phases. It must not be promoted to local board without a separate local-player or view-scope binding.
- Encoding finding: MuMu `GiHeroInfo.i` is a raw encoded hero id. The base hero id is `(rawHeroId % 10000) + 10000`; `rawHeroId / 10000` carries a star/variant bucket. Runtime output must preserve both raw and base ids.
- Local-player scope finding: `GiHeroInfo` only contains `i/x/y`; `GiHeroList` dispatches into MuMu's `battleInfoRepo`, but the public `gi_plugin_jkchess` payload does not carry `chair`, `owner`, or player id. In the current MuMu logcat-only route, no `#SoGame_Report chairid`, `ObservedManager`, or `interalBattle ChairId` lines were visible. Therefore `4353` should be treated as "MuMu current/recognized board candidate" until live view-switch calibration proves it is always local-player scoped.
- Self-view anchor finding: the older `fresh match + 4358 s=1` gate was not strong enough because `s=1` is only phase/status evidence. The current product gate is visible non-empty `4354` shop data in the current match: that is the local actionable self-view anchor. Product promotion is allowed only as a candidate after that shop anchor plus fresh `4353` current-view evidence; freeze/hold when the shop anchor is absent, stale, empty, or the view is suspended.
- Phase calibration: `4358 s=1` is planning/actionable, `s=2` is observing/non-self current view and must not be bound to battle_state, `s=4` is a choice-window attention/reservation signal, and `s=5` is transition/unstable.
- Equipment calibration: `4357` is the opportunistic primary left item rail / inventory source. `4356` is current-screen visible equipment rectangles; promote to own equipped items only under S=1 + fresh non-empty `4354` + trusted `4353` coordinate assignment. When either structured field is absent, an explicit current-match user report is the next reliable field-level source and remains labeled `user_confirmed`; it does not become MuMu hard fact. Icon matching stays fallback/conflict-check evidence and runs only for an explicit user refresh/equipment request, never from periodic HUD/background sensing.

External reference:

- Overwolf TFT GEP documents `board_pieces`, `bench_pieces`, and `shop_pieces` as exact piece/position updates for PC TFT.
- Riot Live Client Data API is a local in-game API, but its documented LoL endpoints are not evidence of TFT board/bench piece snapshots.
- A Riot developer-relations issue reports that TFT `/liveclientdata/allgamedata` is basically recycled LoL-shaped JSON with very little TFT-specific information. Treat Riot Live Client Data as insufficient for board/bench state unless new official TFT live fields are observed.

## Consequence

There are three viable runtime source tiers:

1. Event-provider tier, ideal:
   - PC TFT: Overwolf GEP-like data can directly drive `board_units`, `bench_units`, `shop_units`, economy, HP, and phase.
   - JCC Android: MuMu's `gi_plugin_jkchess`/`NemuInitProxy` bridge is the closest observed equivalent. Only adopt it if we can subscribe to the host bridge read-only without bypassing anti-cheat or modifying the game process.

Current implementation assets:

- `tools/analyze-jcc-mumu-nemuinit-bridge.mjs` builds the bridge command/schema/symbol map.
- `tools/verify-jcc-mumu-nemuinit-bridge.mjs` verifies the map and prevents overclaiming live access.
- `tools/normalize-jcc-mumu-gi-message.mjs` converts one `gi_plugin_jkchess` payload into our runtime event shape.
- `tools/build-jcc-mumu-gi-live-state.mjs` folds normalized MuMu GI events into a match-scoped candidate live state.
- `tools/probe-jcc-mumu-nemuinit-bridge.mjs` performs read-only ADB/service/package/logcat probing and never sends game commands.

## TFT PC vs JCC MuMu Field Map

| Runtime need | PC TFT Overwolf GEP | JCC MuMu gameassist/NemuInit | Notes |
| --- | --- | --- | --- |
| Match start/end | `match_start`, `match_end` | `4096`, `8192` | Same product-level concept. |
| Current-view units | `board_pieces` when local-scoped | `4353` -> `GiHeroList` -> `hl: [{i,x,y}]` | Not proven local-only; observed counts can exceed local-board cap. Treat as current-view/combat candidate. |
| Local board | `board_pieces` | derived only after self-view gate | Visible non-empty `4354` shop establishes the current-match self-view anchor; then `4353 - 4352` may become a local-board candidate. `4358` S codes remain phase/status evidence only. |
| Bench | `bench_pieces` | `4352` -> `GiWaitHeroList` -> `wl: [{i,x,y}]` | MuMu encodes as hero list with grid-ish x/y. |
| Shop | `shop_pieces` | `4354` -> `GiBuyHeroList` | MuMu uses hero/entity IDs. |
| Equipment | `items.item_bench`, `items.equipped_items` | `4357` inventory, `4356` visible equipment rectangles | Field precedence is trusted MuMu structured fact, current-match explicit user confirmation, then visual/icon candidate evidence. `4357` is the primary item bench source. `4356` becomes own equipped items only after S=1 + fresh `4354` + trusted `4353` coordinate assignment; otherwise diagnostic only. |
| Carousel / round select | `carousel_pieces` | `4355` -> `GiRoundSelectUnitList` | Static schema exists; current season live payload not verified. |
| Phase/status | `match_info`, `battle_state`, etc. | `4358` -> `GiGameStatus` | `s=1` planning/actionable, `s=2` observing/non-self current view, `s=4` visible choice attention trigger, `s=5` transition. |
| Augment / hex choices | `augments` / overlay-specific sources | `4358 s=4` marks a visible choice window | No separate GI augment command observed. Product runtime uses current-match user reports only for candidate names. OCR, helper text logs, and host multimodal output must not populate live choice candidates. |

This mapping means PC TFT is useful as a schema reference, not as a directly reusable Riot Live Client Data implementation.

## MuMu Host Bridge Status

Observed on MuMu:

- Android service: `nemuinit: [android.INemuInit]`.
- Pulled host artifacts:
  - `raw-evidence-cleaned:mumu-host-bridge`
  - `raw-evidence-cleaned:mumu-host-bridge`
  - `raw-evidence-cleaned:mumu-host-bridge`
  - `raw-evidence-cleaned:mumu-host-bridge`
- `libnemuinitaidl.so` exports Binder methods including:
  - `sendNemuInitCommand`
  - `sendMessageToHost`
  - `sendMessageToVbox`
  - `setNemuInitProxyCallback`
  - `handleNemuInitMessage`

Interpretation: the bridge is technically inspectable and readable from desktop ADB logcat when MuMu's own `com.mumu.gameassist.jkchess` assistant is running. It is not a portable Android API and is not proven usable as a normal companion APK callback. For the MuMu desktop version, prefer the logcat reader over the APK bridge.

2. Android companion tier, paused and non-product:
   - The historical MediaProjection companion remains isolated for future
     research only.
   - It is not part of MuMu desktop runtime, release acceptance, source
     promotion, or fallback behavior.
   - Current desktop gaps use HUD ROI OCR, explicit owned-augment text-panel
     recovery, user reports, or allowed fallback evidence under the registered
     sensing contract; they must not silently reactivate the companion track.

3. Action-log tier, diagnostic only:
   - Use buy/sell/move/get-on signals to help bind candidate chairs and explain deltas.
   - Keep folded state under source insights/debug fields.
   - Never merge historical/global action logs into final `board_units` / `bench_units`.

## Next Implementation Direction

1. For MuMu desktop runtime, run an ADB logcat GI source:
   - `tools/extract-jcc-mumu-gi-events-from-logcat.mjs`;
   - `tools/normalize-jcc-mumu-gi-message.mjs`;
   - `tools/build-jcc-mumu-gi-live-state.mjs`.
   - For live use, prefer `tools/watch-jcc-mumu-runtime-logcat.mjs`, which streams compact events/state from logcat without saving screenshots or full raw logs.
2. Treat augment/hex, S17 star-god two-choice, and item/anvil choice as
   current-match user-report flows:
   - use `4358 s=4` only as an attention/reservation trigger;
   - prefill the mode composer and wait for the user to send the visible
     candidates;
   - refresh actions prefill the refreshed-report prefix and do not auto-send;
   - require 2-1 augment reports to include current equipment, while later
     augment rounds use equipment deltas unless the user changes more facts;
   - pass structured user-reported candidates plus live_state, rules, hard data,
     big data, and user intent to the host CLI model for scoring;
   - write structured choices only from current-match user reports or explicit
     confirmation.
   Helper OCR/text logs, choice OCR tools, and host multimodal current-frame
   output are not product sources for live candidate names and must not populate
   current choices, selected augments, or visible advice.
3. Use the self-view anchor gate for MuMu desktop board promotion. Current evidence already shows filtered `4353 GiHeroList` is not safe as final local `board_units` outside that gate.
4. For equipment, resolve each field through three layers: trusted MuMu structured sources (`4357` inventory and gated `4356` holder assignments), current-match explicit user confirmation, then conditional visual/icon candidates. If a real item-dependent decision lacks both structured and confirmed facts, cruise may ask one contextual, cooldowned question and accept the reply through the existing text/voice composer. That reply updates match context only and does not create a sibling Host answer. Do not add a permanent equipment-report mode. An explicit user refresh/equipment request may run one bounded icon-matcher fallback; periodic HUD/background sensing must not start it, and icon matches never become owned-item facts without confirmation.
5. If phone/tablet support is resumed later, build it as a separate companion semantic tier:
   - calibrated board/bench ROI geometry;
   - stable slot occupancy;
   - card/shop/bench identity recognition before 3D board identity;
   - event-triggered visual/text extraction and summary-only ring buffers.
6. Preserve strict session isolation: every new match gets a new `match_session_id`; no previous-match raw net/log events can enter current final state.

## Remaining Unknowns

- `4355` live carousel/round-select payload has not been observed in the current season tests.
- Opponent board unit identity is not exposed by the current MuMu logcat source. Product runtime must not fabricate opponent board, opponent power, or counter-positioning facts from current-view data.
- `4096`/`8192` are static dispatcher commands but are not reliable product session boundaries yet; use our own Start/Stop match session.
- `4107` is config/lineup update evidence, not a runtime strategy source.
- No MuMu GI/logcat field currently exposes local chair/owner/playerId, HP, gold, level, or XP.
- Other-player board/HP binding is not available from the current GI payloads.
- Host CLI multimodal visual sensing depends on current-frame capture and a multimodal-capable CLI agent. It is not a fallback for active augment, S17 star-god, or item/anvil candidate intake. If current visible facts outside those active choice flows are unavailable, the runtime should ask for user confirmation instead of falling back to stale helper text logs.
