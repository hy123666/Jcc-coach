# JCC Runtime OCR Inventory

This inventory describes the only supported production sensing paths. The
obsolete visual-observation builder, OCR normalizer, standalone RapidOCR
adapters, broad icon matcher, debug ROI cropper, smoke runner, and their
dedicated verifiers have been physically deleted. They are not research
evidence and must not be restored as compatibility paths.

The crop-task contract is documented in `docs/runtime-ocr-redesign.md`.

## Production Reference Map

| Fact family | Producer | Recognition | Aggregator / resolver | Authority |
| --- | --- | --- | --- | --- |
| Stage, HP, gold, level, XP | one current frame plus dedicated Python ROI croppers | resident RapidOCR worker | `tools/jcc_ocr_field_aggregator.py` | scoped HUD fact source |
| Owned augment text panel | `tools/roi_owned_augment_text_panel.py` | resident RapidOCR worker | `tools/jcc_owned_augment_text_panel_aggregator.py` | manual same-match confirmation evidence |
| Augment choice candidates | current-match user report through the mode composer; optional explicit Quick OCR may populate only the renderer draft | structured card report or complete current-stage/tier OCR draft | runtime choice report normalizer / host scoring request | user confirmation remains the only canonical product source |
| Item/anvil and descriptor-declared season-choice candidates | current-match user report through the mode composer | structured card report | runtime choice report normalizer / host scoring request | active product source only when declared by the current descriptor; no OCR or multimodal fallback |
| Own board and bench | MuMu 4353 under S=1 plus a fresh non-empty 4354 shop anchor | structured source | MuMu live-state builder | primary truth |
| Left item rail | MuMu 4357 | structured source | MuMu live-state builder | primary truth |
| Equipped items | MuMu 4356 assigned by coordinates to trusted 4353 units under the same S=1 + 4354 anchor | structured source | MuMu live-state builder | primary truth |
| Left item rail fallback | `tools/roi_left_item_rail.py` | `tools/match-jcc-left-item-rail-icons.mjs` with a scene-specific item template set | `tools/jcc_left_item_rail_field_aggregator.mjs` | validation/fallback candidates only; never primary `items.item_bench` |
| Missing or ambiguous visual evidence outside active choice-candidate intake | transient frame reference | current host CLI multimodal model | visual observation/live-state resolver | fallback evidence only; cannot overwrite structured primary facts or user-reported choice candidates |

## Product Contract

Runtime OCR should be:

1. one frame capture;
2. deterministic Python ROI crop-task scripts;
3. one resident OCR worker;
4. one field parser / aggregator;
5. host model receives only structured facts plus rules and user context.

Choice candidate truth is not OCR-driven. Augment choices, item/anvil choices,
and any additional choice kind declared by the active season descriptor require
current-match user confirmation before advice. Augment mode may expose one
explicit Quick OCR action after the
user selects stage and tier. Each uniquely matched row legal for that exact
stage and tier may fill only its physical renderer slot; unresolved slots stay
unchanged or empty and the UI reports the recognized count;
it writes no canonical choice facts, opens no Host answer, and never auto-sends.
Item/anvil and descriptor-declared season-choice intake remains user-report
only. The 2-1 augment report includes current equipment; later augment rounds
use equipment deltas unless the user changes more facts.

## Active Product ROI Scripts

- `tools/roi_stage.py` -> `phase.stage_round`
- `tools/roi_gold.py` -> `economy.gold`
- `tools/roi_level_xp.py` -> `economy.level`, `economy.xp`
- `tools/roi_hp_local.py` -> `economy.hp`
- `tools/roi_owned_augment_text_panel.py` -> calibrated manual
  augment-mode crop task for the in-game owned augment detail text panel.
  This recovers/confirm selected augments from text only, not side-rail icon
  matching.

These scripts emit `jcc-roi-crop-task-batch-v1`. They do not perform OCR and
do not write final live-state fields.

## Compatibility / Calibration ROI Scripts

- `tools/roi_augment_choice.py`
- `tools/roi_item_choice.py`

The augment ROI tool is additionally used by the explicit augment Quick OCR
renderer-draft action. That action is not product truth and cannot populate the
canonical current choice set. Item choice ROI remains
compatibility/calibration-only and must not run as live product intake.

## Active Product Aggregators

- `tools/jcc_ocr_field_aggregator.py`
- `tools/jcc_owned_augment_text_panel_aggregator.py`

The self-state aggregator accepts resident OCR results and emits `jcc-self-state-facts-v1`.
HP is promoted only when `roi_hp_local.py` proves that the right-side surface
is the standard player scoreboard and identifies the local enlarged avatar
row. Combat damage panels and other right-side overlays must emit no HP task.
Single-line numeric crops such as local HP and level use recognition-only OCR;
the resident Python worker must honor the caller's `use_det`, `use_cls`, and
`text_score` options. At level 10, a missing XP glyph is normalized to the
structured max-level display `已满`.
The owned augment text-panel aggregator accepts resident OCR results and emits
same-match, stage-bound selected augment confirmation events for the three
standard augment rows only.

Compatibility aggregators such as `tools/jcc_augment_choice_field_aggregator.py` and
`tools/jcc_item_choice_field_aggregator.py` may exist for calibration fixtures
only. They must not be described as product fact promotion paths.

## Resident OCR Worker

- `tools/jcc-rapidocr-resident-worker.mjs`
- `tools/run_jcc_rapidocr_jsonl_worker.py`

The JavaScript boundary owns one shared Python worker per runtime daemon. The
Python worker is the only product OCR text recognizer used by the self-state,
owned-augment text-panel, and explicit augment renderer-draft ROI runners.
Product ROI scripts crop; this worker reads text; aggregators parse fields. God
and item choice OCR runners may use the worker only for compatibility/calibration
jobs outside live choice intake. Startup timeout,
window close, and daemon shutdown must terminate the full worker process tree;
retries must reuse or replace the shared worker, never accumulate models.

Every screenshot/crop/aggregation subprocess uses the shared bounded process
runner. A timeout terminates the full Windows process tree before the caller can
start another sensing run. OCR responses are correlated by request `id`; a late
response from a timed-out request cannot settle the next request.

## Product Mainline

- `data/runtime/jcc/runtime-mode-sensing-map.json` points self-state fields at ROI scripts plus the unified aggregator.
- `ui/electron/runtime-service.js` calls `tools/run-jcc-self-state-roi-ocr.mjs`.
- The product ROI runners use `tools/run_jcc_rapidocr_jsonl_worker.py` through
  the shared runtime-owned resident worker boundary. ROI scripts never load OCR.
- Product frame capture defaults to `auto`: selected-device ADB screencap first,
  discovered MuMuShell fallback second. Android-version-specific MuMuShell paths
  must not be a required hot-path dependency.
- Repeating `self-state-roi-ocr` and `left-item-rail-roi-icon` run bundles are
  bounded by top-level entry count and age. Retention handles files and nested
  run directories, fails closed on invalid limits, and never deletes outside
  the configured sensing root.
- When authoritative live state already contains 4357 item-rail evidence, HUD
  OCR success or failure cannot trigger the icon fallback. Missing-4357 icon
  fallback is allowed only for an explicit user refresh/equipment request or an
  explicit conflict check; periodic/background sensing never starts it, and its
  output remains candidate-only.
- New writes use source `self_state_roi_ocr` and the `last_self_state_roi_*` state fields.
- Stage freshness and economy freshness are tracked independently. A stage-only
  observation may preserve a still-fresh full-economy observation, but it must
  not extend that economy observation's TTL. Successful HUD facts are promoted
  before optional left-item-rail fallback work begins.
- Augment, item/anvil, and descriptor-declared season-choice candidates are
  written only from structured current-match user reports or explicit confirmation.
  Refresh creates a new report opportunity; it does not send automatically.
  `augment_choice_roi_ocr` may populate only a complete exact-stage/tier
  renderer draft after an explicit user action. It must not write canonical
  choice state or open a Host task. `item_choice_roi_ocr` remains a
  compatibility/calibration label only.
- Owned augment detail-panel OCR is a manual augment-mode recovery path, source
  `user_triggered_owned_augment_text_panel_ocr`. It writes through
  `match_context.choice_confirmations`, never through side-rail icon matching
  or cruise background capture.
- Item/anvil reports may write `items.choice_options` only from the current
  user-reported candidate set; they must never write augment, god, item-bench,
  or equipped-item facts. Cruise does not auto-run item/anvil choice intake;
  item mode plus an explicit user message/preset is required.

## Removed System

The repository no longer contains any `tools/*legacy*debug*` sensing tool or
dedicated verifier. The removed system included:

- the generic visual-observation builder and OCR normalizer;
- standalone and private RapidOCR launchers;
- the broad all-scene icon matcher and calibration runner;
- the generic debug ROI cropper and visual smoke/orchestration runners;
- tests whose only purpose was to preserve those implementations.

Removal is compulsory. A new feature must extend one of the formal producers in
the reference map instead of recreating a generic visual pipeline.

## Release Verification

The sensing release suite must cover:

- dedicated Python ROI croppers emit crop tasks only;
- the shared resident worker is the only text recognizer and concurrent prewarm
  requests create one logical model process;
- startup timeout and daemon shutdown leave no resident OCR process behind;
- late OCR replies are matched by request id and cannot contaminate later jobs;
- repeated HUD and item fallback runs remain bounded for a long-running match;
- Android 15 ADB capture succeeds without a MuMu 12 instance dependency;
- choice-report normalizers require current-match report scope, expected option
  counts, and refresh revision handling;
- explicit augment Quick OCR accepts one to three distinct exact-stage/tier
  catalog matches, changes only their physical renderer slots, reports partial
  completion, and remains foreground single-flight;
- MuMu 4353/4356/4357 remain the primary structured sources;
- a missing 4357 command and an observed-empty 4356 payload are reported as
  structured-source degradation, not as successful item recognition and not as
  a visual OCR failure;
- scene-scoped icon matching emits fallback/validation candidates only;
- host multimodal vision remains a missing/ambiguous-evidence fallback outside
  active choice-candidate intake;
- removed opponent-board product modes and obsolete debug tools stay absent.
