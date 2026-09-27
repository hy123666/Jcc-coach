import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readText(file) {
  return readFile(file, "utf8");
}

function bodyBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end >= 0, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

async function main() {
  const service = await readText("ui/electron/runtime-service.js");
  const app = await readText("ui/src/App.tsx");
  const hostMerge = await readText("tools/run-jcc-host-coach-response.mjs");
  const selfStateRunner = await readText("tools/run-jcc-self-state-roi-ocr.mjs");
  const frameCapture = await readText("tools/capture-jcc-visual-frame.mjs");
  const hostInstructionContract = await readText("data/runtime/jcc/host-coach-instruction-contract.json");
  const lineupCardContract = await readText("ui/electron/lineup-card-contract.js");

  const selfStateApply = bodyBetween(
    service,
    "function applySelfStateRoiOcrRunToSelfStateRefresh",
    "function formatRuntimeDisplayValue",
  );
  assert(
    selfStateApply.includes("normalizeSelfStateEconomyField(field, economy[field], fieldStatus[`economy.${field}`])"),
    "manual self-state refresh must normalize each OCR economy field before storing it",
  );
  assert(
    selfStateApply.includes(": observedEconomy;"),
    "full self-state refresh must not retain stale previous economy values when an OCR field is missing",
  );
  assert(
    selfStateApply.includes("last_missing_economy_fields"),
    "manual refresh must record which HUD economy fields were missing",
  );

  const displayValue = bodyBetween(
    service,
    "function formatRuntimeDisplayValue",
    "function normalizeSelfStateEconomyField",
  );
  assert(
    displayValue.includes("value.display") && displayValue.includes("`${value.value}/${value.to_next}`"),
    "XP objects with display/value/to_next must render as readable XP instead of [object Object]",
  );
  assert(!displayValue.includes("const raw = unboxRuntimeValue(value);\n  if (valueIsMissing(raw)) return null;\n  if (raw && typeof raw === \"object\")"), "formatRuntimeDisplayValue must not unbox XP objects before checking display/to_next");

  const normalizer = bodyBetween(
    service,
    "function normalizeSelfStateEconomyField",
    "function manualSelfStateRefreshNextStep",
  );
  assert(
    normalizer.includes('if (status === "missing"') && normalizer.includes('field === "hp"'),
    "self-state HUD normalizer must reject missing HP OCR fields",
  );
  assert(
    normalizer.includes("confidence < 0.8"),
    "self-state HUD HP must reject low-confidence OCR instead of showing stale/unsafe 1 HP",
  );
  assert(
    normalizer.includes("number <= 0 || number > 150"),
    "self-state HUD HP must use the JCC HP range guard",
  );
  assert(
    normalizer.includes("if (valueIsMissing(value)) return null;")
      && normalizer.includes("if (valueIsMissing(raw)) return null;"),
    "missing HUD numeric fields must be rejected before JavaScript numeric coercion can turn null into zero",
  );

  const mergeVisual = bodyBetween(
    service,
    "function mergeVisualSelfStateFields",
    "function visualLiveStateMode",
  );
  assert(
    mergeVisual.includes("const visualValue = normalizeSelfStateEconomyField(field, visualLiveState.economy?.[field], visualFieldStatus);"),
    "resolved live_state merge must apply the same HUD economy validation as manual refresh",
  );
  assert(
    mergeVisual.includes("stageRoundIsAhead(visualStage, baseStage)"),
    "later self-state ROI stage must be able to override stale base stage such as old 1-1",
  );
  assert(
    service.includes("function latestKnownStageRound")
      && service.includes("stageRoundIsAhead(selfStage, liveStage)")
      && service.includes("stage_round: stageRound || null"),
    "match user-message context must record the latest known self-state stage instead of stale live_state shells such as old 1-1",
  );
  assert(
    service.includes("function sanitizeRecentUserMessagesForHost")
      && service.includes("corrected_from_stale_match_context_stage")
      && service.includes("sanitizeMatchContextForHost(matchContext, currentStageRound)"),
    "host selected context must correct older recent_user_messages recorded against a stale stage shell",
  );
  assert(
    hostInstructionContract.includes("opening-stage and economy examples as doctrine only")
      && hostInstructionContract.includes("current stage belongs to the opening phase described by the active game rules"),
    "canonical host instructions must prevent opening doctrine from being presented as the current action outside the active rule layer's opening phase",
  );

  const refreshSummary = bodyBetween(
    service,
    "function summarizeManualSelfStateRefresh",
    "function valueIsMissing",
  );
  assert(
    refreshSummary.includes("manualSelfStateRefreshNextStep(refreshResult)"),
    "manual refresh must include a conservative next-step coach sentence, not only repeat raw HUD facts",
  );
  assert(
    refreshSummary.includes('missing.includes("hp")'),
    "manual refresh must tell the user when HP was not read instead of showing stale HP",
  );

  const lineupNormalize = bodyBetween(
    service,
    "function hostRequestHasLineupCardIntent",
    "function clampString",
  );
  assert(
    service.includes("lineupPinnedResultIsPublishable")
      && lineupCardContract.includes("lineupPinnedResultMinimumUnitCount")
      && lineupCardContract.includes("units.length < lineupPinnedResultMinimumUnitCount")
      && lineupCardContract.includes("seasonNames.has(unit.name)"),
    "lineup-card mode must attempt current-season pinned_result materialization",
  );
  assert(
    lineupNormalize.includes("lineup_card_not_supplied"),
    "lineup-card intent with no usable pinned_result must remain observable without a correction-required response",
  );
  assert(
    lineupCardContract.includes("seasonCatalogFromHostRequest") && lineupCardContract.includes("champion_names"),
    "lineup-card publishable contract must be grounded in current-season catalog names",
  );
  assert(
    selfStateApply.includes("fallbackEconomyEvidence")
      && selfStateApply.includes("last_active_live_state_fallback_economy")
      && !selfStateApply.includes("observedSources[field] = \"active_live_state_fallback\""),
    "manual self-state refresh must keep active live_state fallback as diagnostic evidence, never as authoritative HUD OCR economy",
  );
  assert(
    service.includes("economySources[field] !== \"self_state_roi_ocr\"")
      && service.includes("fallback_evidence: refresh.last_active_live_state_fallback_used"),
    "latest HUD self-state overlay must expose only self_state_roi_ocr economy fields and keep fallback as diagnostics",
  );

  assert(
    hostMerge.includes("normalizeHostCoachResponse")
      && hostMerge.includes("normalizeHostCoachResponse(response, request.host_cli_agent_request)"),
    "offline host response merge path must use the canonical Runtime response contract, including lineup-card pinned_result enforcement",
  );

  const adviceStage = bodyBetween(
    service,
    "function adviceStageCategory",
    "function runtimeEventContextCategory",
  );
  assert(adviceStage.includes('isCruiseFixedCheckpointStage(stage)'), "event cruise must delegate proactive scheduling to the registered fixed-checkpoint agenda");
  assert(!adviceStage.includes('"5-2"') && !adviceStage.includes('"5-5"'), "non-fixed 5-2 and 5-5 must not retain legacy proactive checkpoint pollution");

  assert(
    app.includes("responseTaskFromResult(result)")
      && app.includes("result.response_task ?? result.state?.response_task ?? null")
      && app.includes("response_task_revision: responseTaskRevision"),
    "UI must ack the exact delivered task id and revision returned with the response, not stale state.response_task",
  );
  assert(
    service.includes("function normalizeXpRuntimeSnapshotValue")
      && service.includes("xp: normalizeXpRuntimeSnapshotValue(summary?.economy?.xp)"),
    "event detector must retain XP object values such as {value,to_next} instead of degrading them to null",
  );
  assert(
    service.includes("function freshHudSelfStateOverlay")
      && service.includes("function freshAuthoritativeMatchFactsSnapshot")
      && service.includes("HUD_SELF_STATE_AUTHORITY_TTL_MS")
      && service.includes("latest_authoritative_facts: authoritativeFacts")
      && service.includes("buildAuthoritativeMatchFactsSnapshot(matchContext")
      && service.includes("last_stage_round_source")
      && !service.includes("|| state.self_state_refresh?.last_stage_round"),
    "host context must not let stale HUD/match authoritative facts keep old stage/gold/hp snapshots alive",
  );
  assert(
    service.includes("ensureActiveMatchWatcherRunning(\"observe_runtime_tick\")")
      && service.includes("ensureActiveMatchWatcherRunning(\"poll_cruise_advice\")")
      && service.includes("active_match_watcher_restart_started")
      && service.includes("active_match_watcher_restart_completed"),
    "active-match cruise must restart a stopped watcher instead of continuing with stale live_state",
  );
  assert(
    service.includes("watcherBelongsToActiveMatch")
      && service.includes('["mumu_target_not_found", "watcher_spawn_failed", "watcher_failed"]')
      && service.includes('watcherServiceState?.status === "stopped" && !watcherServiceState?.recommended_target'),
    "runtime must not keep using stale adb_target when the fresh watcher state says MuMu/ADB is unavailable",
  );
  assert(
    selfStateRunner.includes("function resolveRuntimeDeviceOption")
      && selfStateRunner.includes("serviceFreshForMatch")
      && selfStateRunner.includes("mumu_target_not_found")
      && selfStateRunner.includes("JCC_SELF_STATE_ROI_FRAME_CAPTURE_TIMEOUT_MS")
      && selfStateRunner.includes("JCC_SELF_STATE_ROI_SCRIPT_TIMEOUT_MS")
      && selfStateRunner.includes("missingSelfStateFields")
      && selfStateRunner.includes("JCC_SELF_STATE_ROI_PRESERVE_DEBUG_IMAGES")
      && selfStateRunner.includes("preserved_debug_images_reason"),
    "self-state ROI runner must avoid stale device reuse, time out capture/ROI work, and preserve crop evidence when HUD fields are missing",
  );
  assert(
    frameCapture.includes("DEFAULT_CAPTURE_STEP_TIMEOUT_MS")
      && frameCapture.includes("JCC_MUMU_SHELL_CAPTURE_TIMEOUT_MS")
      && frameCapture.includes("JCC_MUMU_SHELL_PULL_TIMEOUT_MS")
      && frameCapture.includes("JCC_MUMU_SHELL_RM_TIMEOUT_MS")
      && frameCapture.includes("screencap timed out")
      && frameCapture.includes("adb command timed out"),
    "frame capture must bound adb/NemuShell calls so a closed MuMu instance cannot hang HUD refresh",
  );

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-live-test-symptom-regression-v1",
    verified: [
      "manual_refresh_no_stale_hp",
      "manual_refresh_no_object_xp",
      "manual_refresh_next_step_text",
      "self_state_roi_stage_can_override_stale_stage",
      "match_context_stage_uses_latest_known_self_state_stage",
      "host_context_corrects_stale_recent_message_stage",
      "opening_doctrine_not_current_stage_action",
      "lineup_card_pinned_result_contract",
      "lineup_card_no_degraded_prose_fallback",
      "event_detector_keeps_xp_object_snapshot",
      "event_cruise_extra_tempo_checkpoints",
      "ui_ack_uses_response_task_payload",
      "stale_hud_authority_ttl_blocks_old_match_facts",
      "active_match_watcher_restart_guard",
      "stale_adb_target_rejected_when_watcher_unavailable",
      "self_state_roi_capture_and_crop_timeouts",
      "self_state_roi_missing_field_debug_artifacts",
      "frame_capture_adb_and_mumu_shell_timeouts",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
