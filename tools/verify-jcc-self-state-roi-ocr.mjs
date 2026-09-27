import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applySelfStateRoiOcrRunToSelfStateRefresh,
  getRuntimeServiceState,
  normalizeSelfStateEconomyField,
  selfStateRoiOcrAuditSummary,
  selfStateRoiOcrHasFields,
  setRuntimeServiceState,
} from "../ui/electron/runtime-service.js";

const runtimeService = await readFile("ui/electron/runtime-service.js", "utf8");
const roiRunner = await readFile("tools/run-jcc-self-state-roi-ocr.mjs", "utf8");
const rapidOcrWorker = await readFile("tools/run_jcc_rapidocr_jsonl_worker.py", "utf8");
const aggregatorSource = await readFile("tools/jcc_ocr_field_aggregator.py", "utf8");
const hpRoi = await readFile("tools/roi_hp_local.py", "utf8");
const roiCommon = await readFile("tools/jcc_roi_common.py", "utf8");
const layout = await readFile("data/runtime/jcc/visual-roi-layout.json", "utf8");

assert.equal(selfStateRoiOcrHasFields({ ok: true, phase: {}, economy: {} }), false, "runtime service must not treat empty self-state ROI OCR as successful");
assert.equal(selfStateRoiOcrHasFields({ ok: true, phase: {} }), false, "runtime service must not treat missing economy as successful");
assert.equal(selfStateRoiOcrHasFields({ ok: true, phase: {}, economy: { hp: undefined, gold: undefined, level: undefined, xp: undefined } }), false, "runtime service must not treat undefined self-state fields as successful");
assert.equal(selfStateRoiOcrHasFields({ ok: true, phase: { stage_round: "3-6" }, economy: {} }), true, "runtime service should accept a parsed stage round");
assert.equal(
  selfStateRoiOcrHasFields({ ok: true, phase: {}, economy: { gold: 51 } }),
  false,
  "an isolated number from a frame without a same-frame stage HUD anchor must not become authoritative economy",
);
assert(!runtimeService.includes("buildInitialFastCruiseGreeting"),
  "legacy automatic opening coaching must remain deleted so unanchored OCR facts cannot occupy the answer lane");

assert.equal(normalizeSelfStateEconomyField("hp", null), null, "missing HP must remain missing instead of becoming numeric zero");
assert.equal(normalizeSelfStateEconomyField("gold", null), null, "missing gold must remain missing instead of becoming numeric zero");
assert.equal(normalizeSelfStateEconomyField("xp", null), null, "missing XP must remain missing instead of becoming numeric zero");
assert.equal(normalizeSelfStateEconomyField("gold", 0, { status: "observed" }), 0, "an explicitly observed zero-gold value must remain valid");
assert.equal(normalizeSelfStateEconomyField("xp", 0, { status: "observed" }), 0, "an explicitly observed zero-XP value must remain valid");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "match-stale-zero-cleanup" },
  self_state_refresh: {
    status: "failed",
    last_economy: { hp: 0, gold: 36, level: 4, xp: { value: 4, to_next: 10 } },
    last_economy_frame_anchor_status: "same_frame_stage_observed",
    last_economy_sources: {
      hp: "self_state_roi_ocr",
      gold: "self_state_roi_ocr",
      level: "self_state_roi_ocr",
      xp: "self_state_roi_ocr",
    },
    last_missing_economy_fields: [],
  },
  match_context: {
    latest_hud_self_state: {
      source: "self_state_roi_ocr",
      economy_frame_anchor_status: "same_frame_stage_observed",
      economy: { hp: 0, gold: 36 },
      economy_sources: { hp: "self_state_roi_ocr", gold: "self_state_roi_ocr" },
    },
    latest_authoritative_facts: {
      economy: { hp: 0, gold: 36 },
      latest_hud_self_state: {
        source: "self_state_roi_ocr",
        economy_frame_anchor_status: "same_frame_stage_observed",
        economy: { hp: 0, gold: 36 },
      },
    },
  },
});
const cleanedHydratedState = getRuntimeServiceState();
assert.equal(cleanedHydratedState.self_state_refresh.last_economy.hp, undefined, "hydration must remove a previously persisted false HP zero");
assert.equal(cleanedHydratedState.self_state_refresh.last_economy.gold, 36, "hydration cleanup must preserve valid sibling economy fields");
assert.equal(cleanedHydratedState.self_state_refresh.last_economy_sources.hp, undefined, "hydration must remove false HP source authority");
assert(cleanedHydratedState.self_state_refresh.last_missing_economy_fields.includes("hp"), "hydration cleanup must expose HP as missing");
assert.equal(cleanedHydratedState.match_context.latest_hud_self_state.economy.hp, undefined, "hydration must clean the persisted HUD overlay too");
assert.equal(cleanedHydratedState.match_context.latest_authoritative_facts.economy.hp, undefined, "hydration must clean persisted authoritative match facts too");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "match-legacy-unanchored-gold" },
  self_state_refresh: {
    status: "completed_self_state_roi_ocr",
    last_source: "self_state_roi_ocr",
    last_economy: { gold: 51 },
    last_economy_sources: { gold: "self_state_roi_ocr" },
    last_economy_observed_at: "2026-08-16T05:45:41.445Z",
  },
  match_context: {
    latest_hud_self_state: {
      source: "self_state_roi_ocr",
      economy: { gold: 51 },
      economy_sources: { gold: "self_state_roi_ocr" },
    },
    latest_authoritative_facts: {
      economy: { gold: 51 },
      latest_hud_self_state: {
        source: "self_state_roi_ocr",
        economy: { gold: 51 },
        economy_sources: { gold: "self_state_roi_ocr" },
      },
    },
  },
});
const migratedLegacyState = getRuntimeServiceState();
assert.equal(migratedLegacyState.self_state_refresh.last_economy.gold, undefined, "hydration must clear legacy OCR economy without same-frame HUD anchor provenance");
assert.equal(migratedLegacyState.match_context.latest_hud_self_state.economy.gold, undefined, "hydration must clear the unanchored persisted HUD overlay");
assert.equal(migratedLegacyState.match_context.latest_authoritative_facts.economy.gold, undefined, "hydration must clear unanchored authoritative match economy");
applySelfStateRoiOcrRunToSelfStateRefresh({
  result: {
    ok: true,
    phase: { stage_round: "1-1" },
    economy: {},
    field_status: {
      "phase.stage_round": { status: "observed", source: "tools/roi_stage.py", raw_text: "1-1" },
    },
  },
  completed_run: {
    completed_at: "2026-08-16T05:45:53.090Z",
    request: { request_id: "stage-only-after-legacy-gold" },
    artifacts: {},
  },
}, "completed_self_state_roi_stage_ocr");
const stageAfterLegacyGold = getRuntimeServiceState().self_state_refresh;
assert.equal(stageAfterLegacyGold.last_stage_round, "1-1", "stage-only OCR should still promote its current stage");
assert.equal(stageAfterLegacyGold.last_economy.gold, undefined, "stage-only OCR must not revive unanchored legacy gold");
assert.equal(stageAfterLegacyGold.last_economy.gold, undefined, "migrated loading-screen gold must remain absent from every downstream fixed-checkpoint fact packet");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "match-missing-hp-regression" },
});
applySelfStateRoiOcrRunToSelfStateRefresh({
  result: {
    ok: true,
    phase: { stage_round: "2-6" },
    economy: {
      hp: null,
      gold: 36,
      level: 4,
      xp: { value: 4, to_next: 10, display: "4/10" },
    },
    field_status: {
      "phase.stage_round": { status: "observed", source: "tools/roi_stage.py" },
      "economy.gold": { status: "observed", source: "tools/roi_gold.py" },
      "economy.level": { status: "observed", source: "tools/roi_level_xp.py" },
      "economy.xp": { status: "observed", source: "tools/roi_level_xp.py" },
    },
  },
  completed_run: {
    completed_at: "2026-08-10T07:01:28.177Z",
    request: { request_id: "missing-hp-regression" },
    artifacts: {},
  },
}, "completed_self_state_roi_ocr");
const missingHpRefresh = getRuntimeServiceState().self_state_refresh;
assert.equal(missingHpRefresh.last_economy.hp, undefined, "a missing HP crop must not be promoted as an economy value");
assert.equal(missingHpRefresh.last_economy.gold, 36, "valid fields from the same HUD frame must still be promoted");
assert.equal(missingHpRefresh.last_economy_sources.hp, undefined, "a missing HP crop must not receive self_state_roi_ocr authority");
assert(missingHpRefresh.last_missing_economy_fields.includes("hp"), "a missing HP crop must stay visible in refresh diagnostics");
assert.equal(missingHpRefresh.last_economy_frame_anchor_status, "same_frame_stage_observed", "an anchored full-HUD frame must persist affirmative economy provenance");
applySelfStateRoiOcrRunToSelfStateRefresh({
  result: {
    ok: true,
    phase: { stage_round: "2-7" },
    economy: {},
    field_status: {
      "phase.stage_round": { status: "observed", source: "tools/roi_stage.py", raw_text: "2-7" },
    },
  },
  completed_run: {
    completed_at: "2026-08-10T07:01:35.000Z",
    request: { request_id: "stage-only-after-anchored-full-hud" },
    artifacts: {},
  },
}, "completed_self_state_roi_stage_ocr");
const anchoredStageOnlyRefresh = getRuntimeServiceState().self_state_refresh;
assert.equal(anchoredStageOnlyRefresh.last_stage_round, "2-7", "stage-only OCR should advance the stage after an anchored full-HUD read");
assert.equal(anchoredStageOnlyRefresh.last_economy.gold, 36, "stage-only OCR should preserve independently timestamped economy from an anchored full-HUD frame");

setRuntimeServiceState({
  match_session: { status: "active", match_session_id: "match-loading-screen-gold" },
});
applySelfStateRoiOcrRunToSelfStateRefresh({
  result: {
    ok: true,
    phase: { stage_round: null },
    economy: { hp: null, gold: 51, level: null, xp: null },
    field_status: {
      "phase.stage_round": { status: "missing", source: "tools/roi_stage.py" },
      "economy.gold": { status: "observed", source: "tools/roi_gold.py", raw_text: "51" },
    },
  },
  completed_run: {
    completed_at: "2026-08-16T05:45:41.445Z",
    request: { request_id: "loading-screen-gold-regression" },
    artifacts: {},
  },
}, "completed_self_state_roi_ocr");
const loadingScreenRefresh = getRuntimeServiceState().self_state_refresh;
assert.equal(loadingScreenRefresh.last_economy.gold, undefined, "loading-screen badge text must not receive HUD gold authority");
assert(loadingScreenRefresh.last_missing_economy_fields.includes("gold"), "rejected loading-screen gold must remain explicitly missing");
assert.equal(loadingScreenRefresh.last_frame_anchor_status, "missing_same_frame_stage", "HUD diagnostics must explain why the isolated number was rejected");

const hpAudit = selfStateRoiOcrAuditSummary({
  result: {
    phase: { stage_round: "2-6" },
    economy: { hp: null, gold: 36, level: 4, xp: { value: 4, to_next: 10, display: "4/10" } },
    field_status: {
      "phase.stage_round": { status: "observed", confidence: 0.97 },
      "economy.hp": { status: "missing" },
      "economy.gold": { status: "observed", confidence: 0.99 },
      "economy.level": { status: "observed", confidence: 0.95 },
      "economy.xp": { status: "observed", confidence: 0.96 },
    },
  },
});
assert.deepEqual(hpAudit.missing_fields, ["economy.hp"], "HUD audit must expose a missing HP crop directly");
assert.equal(hpAudit.observed_values["economy.gold"], 36, "HUD audit must retain normalized sibling facts");
assert.equal(hpAudit.observed_values["economy.hp"], undefined, "HUD audit must not serialize a false HP zero");
assert.equal(hpAudit.field_outcomes["economy.hp"].status, "missing", "HUD audit must retain per-field missing status");

assert(runtimeService.includes("../../tools/run-jcc-self-state-roi-ocr.mjs"), "runtime service must import the new self-state ROI OCR runner");
assert(runtimeService.includes('"tools/run-jcc-self-state-roi-ocr.mjs"'), "runtime service should allowlist the self-state ROI OCR runner");
assert(runtimeService.includes("runSelfStateRoiOcrWithWorker(selfStateRoiOcrOptions, worker)"), "self-state reads must execute through the resident-worker ROI path");
assert(
  roiRunner.includes("async function runOcrTasks(tasks, worker, requestedFields, requestedFieldDiagnostics, options)"),
  "HUD ROI worker dispatch must receive the owning run options instead of reading an undefined closure variable",
);
assert(
  roiRunner.includes("runOcrTasks(tasks, ownedWorker, requestedFields, requestedFieldDiagnostics, options)"),
  "HUD ROI runs must forward the active match/session options into every resident-worker request",
);
assert(runtimeService.includes("function prewarmSelfStateRoiOcrWorker"), "runtime service must support prewarming the self-state ROI OCR worker");
assert(runtimeService.includes('startMatchOcrWarmupWorkers("start_match")'), "Start Match should invoke the resident OCR worker warmup bundle");
assert(runtimeService.includes('{ key: "shared_rapidocr", get: getSelfStateRoiOcrWorker }'), "Start Match should prewarm the daemon-owned shared RapidOCR worker before the first cruise/self-state read");
assert(runtimeService.includes('capabilities: ["hud_self_state", "augment_quick_ocr_draft", "diagnostic_owned_augment_panel"]'), "the shared Start Match warmup must cover HUD, augment draft, and diagnostic panel consumers");
assert(runtimeService.includes('process.env.JCC_DISABLE_RESIDENT_SELF_STATE_ROI_OCR !== "1"'), "resident self-state ROI OCR should be enabled by default and disableable only by explicit env override");
assert(runtimeService.includes('"self_state_roi_resident_worker_failed_fallback_to_tool"'), "self-state ROI OCR must retain an explicit resident-worker fallback event");
assert(runtimeService.includes('"self_state_roi_resident_worker_failed_no_cold_fallback"'), "self-state ROI OCR must record when cold fallback is intentionally blocked");
assert(runtimeService.includes('process.env.JCC_ALLOW_COLD_SELF_STATE_ROI_OCR_FALLBACK !== "1"'), "self-state ROI OCR must only fall back to the standalone tool when explicitly enabled");
assert(runtimeService.includes('last_source: "self_state_roi_ocr"'), "self-state refresh should record the new ROI OCR source");
assert(runtimeService.includes('return source === "self_state_roi_ocr";'), "self-state source checks should only accept the new ROI OCR source");
assert(runtimeService.includes("isSelfStateRoiOcrSource"), "runtime service should centralize self-state ROI OCR source checks");
assert(runtimeService.includes('refreshStageFromSelfStateRoiOcr("poll_cruise_stage_self_state_roi_ocr")'), "cruise should fill missing stage with stage-only self-state ROI OCR before phase triggers");
assert(runtimeService.includes('fields: "stage"'), "cruise stage repair should use stage-only self-state ROI OCR, not full self-state ROI OCR");
assert(runtimeService.includes("function selfStateRoiOcrRunIsNewerThanCurrent"), "runtime service must reject older self-state ROI OCR completions that race after newer self-state facts");
assert(runtimeService.includes("function applySelfStateRoiOcrRunToSelfStateRefresh"), "runtime service must centralize monotonic self-state ROI OCR state updates");
assert(runtimeService.includes("last_economy_observed_at"), "stage and economy freshness must be tracked independently");
assert(runtimeService.indexOf('source: "background_self_state_roi_ocr_completed"') < runtimeService.indexOf('const itemRailLiveState = authoritativeItemRailState?.live_state'), "successful HUD facts must be promoted before item fallback starts");
const backgroundRefresh = runtimeService.slice(
  runtimeService.indexOf("async function runBackgroundSelfStateRefresh"),
  runtimeService.indexOf("async function runManualSelfStateRefreshForUserMessage"),
);
assert(backgroundRefresh.includes('event_type: "hud_facts_changed"'), "background HUD success must publish canonical hud_facts_changed events");
assert(backgroundRefresh.includes('event_type: "self_state_refresh_changed"'), "background HUD lifecycle must publish canonical refresh events");
assert(!backgroundRefresh.includes("await persistState();"), "background HUD must not persist only to the legacy JSON mirror");
assert(!runtimeService.includes("selfStateRoiOcrRun.result?.phase?.stage_round || previous.last_stage_round"), "self-state refresh must not preserve stale previous stage when the latest OCR misses");
assert(runtimeService.includes("const observedEconomy = {}"), "self-state refresh should update economy field-by-field from observed OCR values");
assert(runtimeService.includes("previousEconomyHasFrameAnchor ? previous.last_economy || {} : {}"), "stage-only self-state OCR must preserve only full-HUD economy with explicit same-frame stage provenance");
assert(runtimeService.includes('last_economy_frame_anchor_status === "same_frame_stage_observed"'), "self-state economy persistence must require an affirmative same-frame stage anchor");
assert(runtimeService.includes("last_previous_full_self_state_economy_evidence"), "stage-only self-state OCR may keep previous economy only as non-authoritative diagnostic evidence");
assert(runtimeService.includes("last_stage_round_source: stageRound ? \"self_state_roi_ocr\" : null"), "self-state refresh must record positive source proof for authoritative stage");

assert(roiRunner.includes("jcc-self-state-roi-ocr-result-v1"), "self-state ROI runner must emit the new result schema");
assert(roiRunner.includes("collectCropTasks"), "self-state ROI runner must collect ROI crop-task batches");
assert(roiRunner.includes("runRoiScript"), "self-state ROI runner must execute ROI scripts before OCR");
assert(roiRunner.includes("jcc-ocr-result-batch-v1"), "self-state ROI runner must normalize resident OCR output into an OCR result batch");
assert(roiRunner.includes("tools/jcc_ocr_field_aggregator.py"), "self-state ROI runner must use the unified field aggregator");
assert(roiRunner.includes("source: \"self_state_roi_ocr\""), "self-state ROI runner must tag visual live_state with the new source");
assert(roiRunner.includes("const batches = await Promise.all("), "independent HUD ROI crop scripts must run in parallel on one captured frame");
assert(roiRunner.includes('task.evidence?.ocr_profile === "single_line_numeric"'), "verified single-line HP crops must bypass text detection");
assert(rapidOcrWorker.includes('use_det=request.get("use_det")'), "resident OCR worker must honor per-task detection policy");
assert(rapidOcrWorker.includes('hasattr(raw_result, "txts") and hasattr(raw_result, "scores")'), "resident OCR worker must normalize recognition-only output");
assert(roiRunner.includes('if (options.captureSource) args.push("--capture-source", options.captureSource);'), "self-state ROI runner must forward --capture-source into capture-jcc-visual-frame");

assert(aggregatorSource.includes('"schema": "jcc-self-state-facts-v1"'), "aggregator must emit the unified self-state facts schema");
assert(aggregatorSource.includes('"economy.hp"'), "aggregator must promote local HP into economy.hp");
assert(aggregatorSource.includes("def parse_hp(result, text):"), "self-state HP parser must own strict HP-specific parsing");
assert(aggregatorSource.includes('digits.startswith("0")'), "self-state HP parser must reject malformed leading-zero readings");
assert(aggregatorSource.includes("parse_stage"), "aggregator must parse stage from OCR text");
assert(aggregatorSource.includes("parse_xp"), "aggregator must parse XP from OCR text");

assert(roiCommon.includes('"schema": "jcc-roi-crop-task-batch-v1"'), "ROI common helper must emit crop-task batches");
assert(hpRoi.includes('"economy.hp"'), "HP ROI script must target economy.hp");
assert(!hpRoi.includes("RapidOCR"), "HP ROI script must not load OCR itself");
assert(!hpRoi.includes("run_jcc_legacy_rapidocr"), "HP ROI script must not start a private OCR worker");
assert(!layout.includes("hp_local_yellow_avatar_row_candidate"), "layout must not retain the old fixed local HP row candidate");
assert(!layout.includes("hp_scoreboard_candidate"), "layout must not retain the old broad HP scoreboard candidate");
assert(layout.includes("hp_local_scoreboard_detected_row_policy"), "layout must document the dynamic local HP row detection policy");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "runtime service uses self-state ROI OCR runner as the self-state text mainline",
    "resident self-state ROI OCR worker remains the only text-recognition path",
    "ROI scripts emit crop tasks and do not read text",
    "field aggregator owns stage/gold/level/xp/hp parsing",
    "empty OCR cannot be promoted into successful self-state",
    "old HP candidate ROI names are absent from layout",
  ],
}, null, 2));
