# JCC Runtime OCR Redesign

## Goal

Rebuild runtime OCR as a small, mechanical sensing pipeline. ROI scripts locate
and crop evidence. A single resident OCR worker reads text. A field aggregator
turns OCR text into structured match facts. The host model only receives those
facts plus rules and user context.

Canonical product OCR facts are limited to HUD self-state facts and the explicit
owned-augment text-panel recovery action. Choice truth remains a current-match
user confirmation. Augment mode may additionally run one explicit Quick OCR
convenience that fills only a complete exact-stage/tier renderer draft; it does
not write canonical candidates or selected choices, open a Host answer, or
auto-send. Item/anvil choices and any additional choice kind declared by the
active season descriptor remain user-report only and do not use OCR or host
multimodal fallback for candidate names.

This replaces the old mixed OCR flow where `.mjs` tools, legacy visual builders,
fixed ROI candidates, and parser logic could all promote OCR facts.

## Non-Goals For This Pass

- Do not make OCR fact sampling itself a host-model trigger. Runtime scheduling
  may sample facts on a watchdog, but only semantic event gates decide when the
  coach model should speak.
- Do not make choice windows OCR-driven. Canonical augment, item/anvil, and
  descriptor-declared season-choice intake remains user-confirmed even when the
  UI detects an attention window. The augment-only Quick OCR renderer draft is
  an explicit convenience, not automatic sensing or product truth.
- Do not use the host model for hard HUD text recognition.

## Pipeline

### 1. Frame Capture

Runtime captures one current frame and passes the same frame path to ROI scripts.
Capture policy remains owned by runtime, not by ROI scripts.

The production default is `capture-source=auto`: use the selected ADB target's
`exec-out screencap` first, including MuMu Android 15, and use a discovered
MuMuShell instance only when ADB returns an empty frame. `mumu-shell` remains an
explicit diagnostic override, never the runtime default.

### 2. ROI Scripts

Each ROI script is a deterministic `.py` tool. It receives the frame path and
outputs crop tasks. It does not OCR text and does not promote final fields.

HUD ROI scripts run for facts that are continuously useful:

- `roi_stage.py` -> `phase.stage_round`
- `roi_gold.py` -> `economy.gold`
- `roi_level_xp.py` -> `economy.level`, `economy.xp`
- `roi_hp_local.py` -> `economy.hp`

Owned-augment recovery is the only active non-HUD text panel ROI. It runs only
from the augment-mode secondary preset after the user opens the owned augment
detail panel:

- `roi_owned_augment_text_panel.py` -> selected augment text-panel rows

Choice ROI scripts have narrow, non-authoritative roles:

- `roi_augment_choice.py` -> explicit augment renderer draft plus calibration
- `roi_item_choice.py` -> completed-item forge/anvil visible item names

### 3. Crop Task JSON

ROI scripts output this shape:

```json
{
  "schema": "jcc-roi-crop-task-batch-v1",
  "ok": true,
  "frame": "G:/.../frame.png",
  "tasks": [
    {
      "task_id": "economy.hp:local_scoreboard_detected_row",
      "field": "economy.hp",
      "kind": "numeric_text",
      "crop_image": "G:/.../hp.png",
      "source_script": "tools/roi_hp_local.py",
      "roi": { "x": 1432, "y": 149, "w": 80, "h": 56 },
      "evidence": {
        "detector": "local_scoreboard_avatar_ring",
        "selected_row": 1,
        "confidence": 0.87
      }
    }
  ]
}
```

Crop tasks are evidence requests, not final facts.

### 4. Resident OCR Worker

Runtime owns one resident OCR worker. The worker accepts crop tasks and returns
OCR text blocks. It does not know game semantics.

All HUD and choice runners share the same `tools/jcc-rapidocr-resident-worker.mjs`
process boundary. Concurrent startup requests share one promise, OCR jobs are
serialized through one queue, startup failure terminates the child process tree,
and daemon/window shutdown reaps the worker. Five sensing modes must never mean
five independently loaded RapidOCR models.

```json
{
  "schema": "jcc-ocr-result-batch-v1",
  "ok": true,
  "results": [
    {
      "task_id": "economy.hp:local_scoreboard_detected_row",
      "field": "economy.hp",
      "text": "100",
      "blocks": [{ "text": "100", "confidence": 0.99 }]
    }
  ]
}
```

### 5. Field Parser / Aggregator

The aggregator owns game-field parsing and final structured JSON. It maps OCR
results to typed fields, applies field-specific validation, and emits missing
or conflicted status when text is absent or ambiguous.

```json
{
  "schema": "jcc-self-state-facts-v1",
  "phase": { "stage_round": "2-2" },
  "economy": {
    "hp": 100,
    "gold": 8,
    "level": 3,
    "xp": { "value": 4, "to_next": 6, "display": "4/6" }
  },
  "field_status": {
    "economy.hp": {
      "source": "roi_hp_local.py + resident_ocr_worker",
      "status": "observed",
      "confidence": 0.99
    }
  }
}
```

### 6. Host Model

The host model receives structured facts, rules, hard data, big data, and user
context. It does not perform ROI selection or OCR for hard HUD text.

## Dedicated Choice Boundaries

Canonical live choice candidate intake is not OCR:

- Augment choice, item/anvil choice, and any additional choice kind declared by
  the active season descriptor require current-match user confirmation before
  advice.
- Augment mode may run Quick OCR only after stage and tier are selected. Each
  distinct exact-stage/tier catalog entry may fill only its physical renderer
  slot. Incomplete OCR preserves unresolved or newer manual slots and reports
  the recognized count; conflicting rows are rejected.
- Quick OCR does not persist candidates, confirm a selection, open a Host task,
  or auto-send. The user still reviews and submits the card.
- The mode UI prefills the composer and waits for the user to send.
- Refresh actions prefill the refreshed-report prefix and do not auto-send.
- The 2-1 augment report includes current equipment; later augment rounds use
  equipment deltas unless the user changes more facts.
- OCR and host multimodal output must not populate live choice candidates for
  these flows.

Choice tools are not one generic script:

- Augment choice uses `roi_augment_choice.py` and
  `jcc_augment_choice_field_aggregator.py`.
- Completed-item forge/anvil uses `roi_item_choice.py` and
  `jcc_item_choice_field_aggregator.py`.

The augment tool may additionally supply the bounded renderer-only draft above.
None of these tools may write `augments.current_choice_set` or
`items.choice_options` in the live product path. The completed-item forge live
path accepts only current-match user-reported item names into
`items.choice_options`; it must not write augment candidates, season-choice
candidates, selected items, item bench, or equipped-item facts. Cruise must not auto-run
item/anvil intake; item mode plus an explicit user question/preset is required.

## Removal Policy For Old OCR Paths

Remove runtime mainline dependencies on:

- fixed HUD HP candidates
- old HUD `.mjs` OCR promotion logic
- old choice OCR promotion logic
- legacy visual OCR normalizers as product truth
- any path that converts OCR text to live_state outside the new aggregator
- any live augment, descriptor-declared season choice, or item/anvil candidate
  intake from OCR or host multimodal vision

Research notes, MuMu reverse-engineering evidence, and historical docs may
remain, but they must not be imported by runtime product paths.

## Runtime Scheduling

- Start Match may prewarm the shared OCR worker once so HUD refresh and explicit
  owned-augment recovery do not pay model-load latency.
- Augment, item/anvil, and descriptor-declared season-choice modes wait for the
  user card report. Augment mode may explicitly fill a renderer draft through
  Quick OCR; refresh and OCR never submit or confirm automatically.
- Owned-augment text-panel recovery runs only from its active augment-mode
  secondary preset plus explicit user action.
- HUD self-state sensing is a low-frequency fact watchdog because MuMu GameAssist
  structured payloads can be silent. It refreshes typed stage/HP/gold/level/XP
  facts; it does not directly create a host-model request.
- The event detector compares authoritative facts and user context. Only a
  meaningful semantic event, or a direct user request, enters the response-task
  queue. Repeated unchanged HUD samples cannot consume the host-model lane.
- Background sensing is strict single-flight. Declaring a run stale does not
  release its lock while child work is still alive, and manual refresh does not
  start a second capture/OCR tree over an unfinished run.
- Sensing subprocesses are time-bounded and tree-killed on Windows. Completed
  run bundles are retained by bounded count/age rather than accumulating one
  directory per watchdog tick forever.
