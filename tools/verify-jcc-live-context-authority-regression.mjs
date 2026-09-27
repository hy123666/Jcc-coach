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
  const bridge = await readText("ui/src/runtimeBridge.ts");
  const modeContract = await readText("data/runtime/jcc/runtime-ui-mode-contract.json");
  const lineupCardContract = await readText("ui/electron/lineup-card-contract.js");
  const hpRoi = await readText("tools/roi_hp_local.py");

  const hudOverlay = bodyBetween(
    service,
    "function applyHudSelfStateOverlayToSummary",
    "async function persistLatestHudSelfStateToMatchContext",
  );
  assert(
    hudOverlay.includes("hud_self_state_overlay_only")
      && hudOverlay.includes("latest_hud_self_state_overlay")
      && hudOverlay.includes("stageRound = normalizeStageRound(overlay.stage_round)"),
    "HUD self-state overlay must be able to create or correct the host live_state summary",
  );
  assert(
    service.includes("latest_hud_self_state:")
      && service.match(/persistLatestHudSelfStateToMatchContext\(reason\)/g)?.length >= 2,
    "successful self-state ROI refreshes must persist latest_hud_self_state into match context",
  );

  const latestStage = bodyBetween(
    service,
    "function latestKnownStageRound",
    "async function refreshStageFromSelfStateRoiOcr",
  );
  assert(
    latestStage.includes("freshHudSelfStateOverlay(state.match_context?.latest_hud_self_state)")
      && latestStage.includes("normalizeStageRound(contextOverlay?.stage_round)"),
    "latestKnownStageRound must use match-context HUD overlay instead of stale MuMu shells only",
  );
  const recordMessage = bodyBetween(
    service,
    "async function recordMatchUserMessageContext",
    "function latestObservedChoiceOptions",
  );
  assert(
    recordMessage.indexOf("state.match_context = await readMatchContextForActiveMatch();")
      < recordMessage.indexOf("const stageRound = latestKnownStageRound(liveState);"),
    "user-message match context must load latest HUD overlay before stamping stage_round",
  );

  const buildHostContext = bodyBetween(
    service,
    "async function buildRuntimeHostContext",
    "async function enrichHostRequestWithRuntimeContext",
  );
  assert(
    buildHostContext.includes("effectiveTargetPlanFromMatchContext")
      && buildHostContext.includes("target_plan: effectiveTargetPlan")
      && buildHostContext.includes("latest_hud_self_state"),
    "host context must carry the latest target-plan intent and HUD self-state evidence",
  );
  const enrichHost = bodyBetween(
    service,
    "async function enrichHostRequestWithRuntimeContext",
    "async function buildContextPack",
  );
  assert(
    enrichHost.includes("buildRuntimeHostContext")
      && enrichHost.includes("currentLiveStateSummaryWithTarget")
      && enrichHost.includes("decision_snapshot: decisionSnapshot"),
    "host request enrichment must consume the authoritative runtime context and decision snapshot for all host modes",
  );

  const queryTerms = bodyBetween(
    service,
    "function collectRankingQueryTermPacket",
    "function selectRelevantRankingCandidates",
  );
  assert(
    queryTerms.includes("latest_target_intent?.text")
      && queryTerms.includes("const targetPlans = [")
      && queryTerms.includes("targetPlans.flatMap(targetPlanIdentityValues)")
      && queryTerms.includes("const recentMessages = firstArray")
      && queryTerms.includes("recentMessages.slice(-6)")
      && queryTerms.includes("textLooksLikeTargetPlanIntent(text)"),
    "ranking query terms must include recent target-comp intent such as trait breakpoint requests",
  );
  assert(
    service.includes("function textHasSeasonTraitBreakpointIntent")
      && service.includes("activeSeasonTraitNamesForIntent"),
    "trait-breakpoint target intents must be detected from current-season trait names",
  );

  const pinnedNormalizer = bodyBetween(
    lineupCardContract,
    "export function normalizeLineupPinnedResult",
    "export function lineupPinnedResultMinimumUnitCount",
  );
  assert(
    pinnedNormalizer.includes("value.degraded") && pinnedNormalizer.includes("value.provenance"),
    "runtime pinned_result normalizer must preserve degraded/provenance metadata",
  );
  const lineupGate = bodyBetween(
    lineupCardContract,
    "export function lineupPinnedResultIsPublishable",
    "return true;",
  );
  assert(
    lineupGate.includes("lineupPinnedResultMinimumUnitCount")
      && lineupGate.includes("units.length < lineupPinnedResultMinimumUnitCount")
      && lineupGate.includes("loadout?.unit")
      && lineupGate.includes("seasonNames.has(unit.name)"),
    "lineup-card mode must require a publishable structured current-season card without hardcoding every request to 7 units",
  );

  assert(
    app.includes("mode?.primaryPresets.map((preset)")
      && app.includes("onClick={() => prefillPreset(preset.prompt)}")
      && modeContract.includes('"label": "经济节奏"')
      && modeContract.includes('"mode_id": "cruise"'),
    "cruise UI must expose an editable user-triggered economy question preset",
  );
  assert(
    app.includes("uiModeFromBackendMode(response?.mode, availableMatchModes) === \"lineup\"")
      && app.includes("setLineupStatus(\"failed\")")
      && app.includes("setPinnedPanelOpen(true)")
      && app.includes("lineup-card-missing"),
    "lineup mode without a structured card must preserve any last published card and show a visible failed status",
  );
  assert(
    bridge.includes("payload.degraded")
      && app.includes("pinnedResultIsPublishable")
      && bridge.includes("degraded?: boolean")
      && bridge.includes("provenance?: Record<string, unknown>")
      && app.includes("provenance?: Record<string, unknown>"),
    "UI bridge must preserve lineup-card metadata and reject degraded cards before rendering",
  );
  assert(
    hpRoi.includes("def row_has_reliable_local_player_ring")
      && hpRoi.includes("local_player_row_not_reliable")
      && hpRoi.includes("emit_crop_task_batch(args.frame, [], started, artifacts)"),
    "HP ROI must not emit an OCR crop when the local player row detector has no reliable avatar ring",
  );
  const saveManualVariables = bodyBetween(
    service,
    "async function saveManualVariables",
    "function valuesLabel",
  );
  assert(
    saveManualVariables.includes('response_policy: "context_only"')
      && saveManualVariables.includes("advice_eligible: false")
      && !saveManualVariables.includes("requeueRuntimeEventAdvice")
      && saveManualVariables.includes("2-1 强化建议")
      && !saveManualVariables.includes("final_text:"),
    "manual variable confirmation must remain fact-only and defer opening judgment to the first 2-1 augment answer",
  );

  console.log(JSON.stringify({
    ok: true,
    schema: "jcc-live-context-authority-regression-v1",
    checked: [
      "hud_self_state_overlay_authoritative",
      "latest_target_plan_intent_selected_context",
      "trait_breakpoint_ranking_query_terms",
      "lineup_card_hard_contract_visible",
      "cruise_economy_question_preset",
      "hp_roi_skips_unreliable_row",
      "manual_variables_context_only_until_first_augment",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
