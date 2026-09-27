import { readFile, writeFile } from "node:fs/promises";

const CONTRACT_REF = "data/runtime/jcc/visual-live-state-contract.json";

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-visual-live-state.mjs --live-state <match-live-state.json> --visual-observations <visual-observations.json> [--out <visual-live-state.json>]",
    "",
    "Applies host-multimodal visual observations into live_state as candidate evidence without overwriting verified MuMu bridge/log fields.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live-state") options.liveState = argv[++index];
    else if (arg === "--visual-observations") options.visualObservations = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function visualFieldStatus(observation, reason = null) {
  return {
    status: observation?.status || "missing",
    source_type: "visual_screen",
    source: observation?.source || "visual_observation",
    confidence: observation?.confidence || 0,
    evidence: observation?.evidence || null,
    promotion_status: observation?.status === "visual_candidate" ? "candidate_not_verified" : "not_promoted",
    reason,
  };
}

function candidateArrayStatus(candidates, reason) {
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  const confidence = hasCandidates
    ? Math.max(...candidates.map((candidate) => candidate.confidence || 0))
    : 0;
  const usableCandidates = hasCandidates
    ? candidates.filter((candidate) => ["visual_candidate", "visual_uncertain_candidate"].includes(String(candidate.status || "")))
    : [];
  const hasUsableCandidates = usableCandidates.length > 0;
  const hasLowConfidenceCandidates = hasCandidates
    && candidates.some((candidate) => candidate.status === "visual_low_confidence_candidate");
  const hasOnlyUnresolvedCandidates = hasCandidates
    && !hasUsableCandidates
    && candidates.every((candidate) => candidate.status === "visual_model_candidate_unresolved" || candidate.status === "visual_low_confidence_candidate");
  const blockedByPhaseGate = hasCandidates && candidates.some((candidate) => candidate.phase_gate?.promotion_allowed_after_roi_calibration === false);
  const phaseGate = hasCandidates
    ? candidates.find((candidate) => candidate.phase_gate)?.phase_gate || null
    : null;
  let status = "missing";
  let promotionStatus = "not_promoted";
  if (hasUsableCandidates) {
    status = usableCandidates.some((candidate) => candidate.status === "visual_candidate")
      ? "visual_candidate"
      : "visual_uncertain_candidate";
    promotionStatus = usableCandidates.some((candidate) => candidate.status === "visual_uncertain_candidate")
      ? "diagnostic_candidates_not_hard_facts"
      : (blockedByPhaseGate ? "blocked_by_phase_gate" : "candidate_not_verified");
  } else if (hasLowConfidenceCandidates) {
    status = "visual_low_confidence_candidate";
    promotionStatus = "blocked_by_low_confidence";
  } else if (hasOnlyUnresolvedCandidates) {
    status = "visual_model_candidate_unresolved";
    promotionStatus = "blocked_by_unresolved_identity";
  }
  return {
    status,
    source_type: "visual_screen",
    confidence,
    evidence: hasCandidates ? candidates[0].evidence || null : null,
    promotion_status: promotionStatus,
    reason,
    phase_gate: phaseGate,
  };
}

function candidateSource(value) {
  return String(value?.source || value?.provenance?.source || value?.recognition_source || "");
}

function isRoiChoiceSource(value) {
  const source = typeof value === "string" ? value : candidateSource(value);
  return /(?:roi_ocr|rapidocr|fast_choice_text|choice_panel|augment_choice_roi|item_choice_roi)/i.test(source || "");
}

function isLeftItemRailSpecializedCandidate(value) {
  const source = candidateSource(value);
  return source === "left_item_rail_roi_icon";
}

function isMumu4357ItemBenchSource(value) {
  if (!value || typeof value !== "object") return false;
  const source = candidateSource(value);
  const policy = String(value?.promotion_policy || value?.provenance?.promotion_policy || "");
  return source === "mumu_4357_item_bench"
    || policy === "structured_4357_left_item_rail_primary";
}

function hasStructuredMumu4357ItemBench(liveState) {
  const rows = Array.isArray(liveState?.items?.item_bench) ? liveState.items.item_bench : [];
  const status = liveState?.field_status?.["items.item_bench"] || {};
  return rows.some(isMumu4357ItemBenchSource)
    || isMumu4357ItemBenchSource(status);
}

function isLeftItemRailObservation(observations) {
  return observations?.metadata?.source === "left_item_rail_roi_icon"
    || observations?.field_status?.["items.item_bench"]?.source === "left_item_rail_roi_icon"
    || [
      ...(Array.isArray(observations?.items?.item_bench) ? observations.items.item_bench : []),
      ...(Array.isArray(observations?.items?.item_bench_candidates) ? observations.items.item_bench_candidates : []),
    ].some(isLeftItemRailSpecializedCandidate);
}

function productCandidates(candidates, options = {}) {
  return Array.isArray(candidates)
    ? candidates.filter((candidate) =>
      options.allowLeftItemRail || !isLeftItemRailSpecializedCandidate(candidate)
    )
    : candidates;
}

function productCandidateRows(candidates, options = {}) {
  const rows = productCandidates(candidates, options);
  return Array.isArray(rows) ? rows : [];
}

function sanitizeVisualForProduct(observations) {
  const sanitized = structuredClone(observations || {});
  if (sanitized.items) {
    const itemBenchRows = productCandidateRows(sanitized.items.item_bench);
    const leftRailRowsInMainShape = itemBenchRows.filter(isLeftItemRailSpecializedCandidate);
    const hardItemBenchRows = itemBenchRows.filter((candidate) => !isLeftItemRailSpecializedCandidate(candidate));
    const itemBenchCandidateRows = [
      ...leftRailRowsInMainShape,
      ...productCandidateRows(sanitized.items.item_bench_candidates, { allowLeftItemRail: true }),
    ];
    sanitized.items = {
      ...sanitized.items,
      item_bench: hardItemBenchRows,
      item_bench_candidates: itemBenchCandidateRows,
      equipped_items: productCandidates(sanitized.items.equipped_items),
    };
  }
  if (sanitized.augments) {
    sanitized.augments = {
      ...sanitized.augments,
      selected_augments: productCandidates(sanitized.augments.selected_augments),
    };
  }
  delete sanitized.opponents;
  return sanitized;
}

function usableVisualCandidates(candidates) {
  return Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate?.status === "visual_candidate")
    : [];
}

function candidateVisualRows(candidates) {
  return Array.isArray(candidates)
    ? candidates.filter((candidate) => ["visual_candidate", "visual_uncertain_candidate"].includes(String(candidate?.status || "")))
    : [];
}

function choiceNameFromCandidate(candidate) {
  return String(
    candidate?.name
    || candidate?.text
    || candidate?.title
    || candidate?.catalog_match?.name
    || candidate?.catalog_match?.normalized_name
    || candidate?.id
    || "",
  ).trim();
}

function visualValue(observation) {
  if (!observation || typeof observation !== "object") return undefined;
  return observation.value;
}

function observationSource(observation, fallback = "host_multimodal_visual") {
  return observation?.source || observation?.provenance?.source || fallback;
}

function hasValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "string" && /^(unknown|missing|null|undefined|n\/a|na|--|—)$/i.test(value.trim())) return false;
  return true;
}

function normalizeStageRound(value) {
  const raw = typeof value === "object" && value !== null && Object.hasOwn(value, "value") ? value.value : value;
  if (typeof raw !== "string") return null;
  const match = raw.match(/(\d+)\s*[-_/]\s*(\d+)/);
  return match ? `${Number(match[1])}-${Number(match[2])}` : null;
}

function isSelfStateRoiOcrSource(source) {
  return source === "self_state_roi_ocr";
}

function promoteVisualPhaseAndEconomy(liveState, observations) {
  liveState.field_status ||= {};
  const phaseValue = visualValue(observations.phase);
  const visualStageRound = normalizeStageRound(phaseValue?.stage_round || phaseValue?.current_round_text || phaseValue);
  const existingStageRound = normalizeStageRound(
    liveState.phase?.stage_round ||
    liveState.phase?.stageRound ||
    liveState.phase?.round_key ||
    liveState.phase?.current_round,
  );
  const source = observationSource(observations.phase);
  const isHudSelfState = isSelfStateRoiOcrSource(source) || isSelfStateRoiOcrSource(observations.metadata?.source);
  const canPromoteStageRound = isHudSelfState
    && visualStageRound
    && liveState.field_status["phase.stage_round"]?.status !== "verified"
    && (!existingStageRound || isHudSelfState);
  if (canPromoteStageRound) {
    liveState.phase ||= {};
    liveState.phase.stage_round = visualStageRound;
    liveState.phase.current_round_text = phaseValue?.current_round_text || visualStageRound;
    liveState.phase.stage_round_source = source;
    liveState.field_status["phase.stage_round"] = {
      status: "candidate",
      source_type: "visual_screen",
      source,
      confidence: observations.phase?.confidence || 0.7,
      evidence: observations.phase?.evidence || null,
      promotion_status: existingStageRound ? "replaced_stale_bridge_stage_round_by_hud" : "promoted_when_mumu_stage_round_missing",
      reason: existingStageRound
        ? "self-state ROI OCR is allowed to replace stale bridge stage_round for cruise timing only"
        : "MuMu 4358 exposes s-code only; current stage round comes from visible HUD when bridge has no stage_round",
    };
  }

  const economyFields = ["hp", "gold", "level", "xp"];
  for (const field of economyFields) {
    const observation = observations.economy?.[field];
    const value = visualValue(observation);
    if (!hasValue(value) || liveState.field_status[`economy.${field}`]?.status === "verified") continue;
    const source = observationSource(observation);
    const isHudEconomy = isSelfStateRoiOcrSource(source) || isSelfStateRoiOcrSource(observations.metadata?.source);
    if (!isHudEconomy) {
      liveState.field_status[`economy.${field}`] = visualFieldStatus(
        observation,
        "host multimodal visual HUD candidate is diagnostic only; phase/economy facts must come from self-state ROI OCR",
      );
      continue;
    }
    liveState.economy ||= {};
    const existing = liveState.economy[field];
    if (hasValue(existing) && !(typeof existing === "object" && Object.values(existing).every((entry) => !hasValue(entry)))) continue;
    liveState.economy[field] = value;
    liveState.field_status[`economy.${field}`] = {
      status: "candidate",
      source_type: "visual_screen",
      source,
      confidence: observation?.confidence || 0.7,
      evidence: observation?.evidence || null,
      promotion_status: "promoted_when_bridge_field_missing",
      reason: "self-state HUD value is needed for cruise economy/stage timing when MuMu bridge has no numeric field",
    };
  }
}

function syncVisualAugmentChoices(liveState, observations) {
  const choices = usableVisualCandidates(observations.augments?.choices)
    .filter((candidate) => choiceNameFromCandidate(candidate));
  if (!choices.length) return;
  const existingStatus = liveState.field_status?.["augments.current_choice_set"];
  if (existingStatus?.status === "verified") return;
  liveState.augments ||= {};
  const normalizedChoices = choices.slice(0, 3).map((candidate, index) => ({
    ...candidate,
    name: choiceNameFromCandidate(candidate),
    slot: candidate.slot ?? candidate.index ?? index,
    source: candidateSource(candidate) || "host_multimodal_visual",
    semantic_status: candidate.semantic_status || "visible_augment_choice_candidate",
  }));
  const existingChoiceSet = liveState.augments.current_choice_set;
  const existingSource = existingStatus?.source || existingChoiceSet?.source || "";
  if (isRoiChoiceSource(existingSource)) {
    liveState.augments.visual_choice_candidates = normalizedChoices;
    liveState.field_status ||= {};
    liveState.field_status["augments.visual_choice_candidates"] = {
      status: "candidate",
      source_type: "visual_screen",
      source: "host_multimodal_visual",
      confidence: Math.max(...normalizedChoices.map((choice) => choice.confidence || 0)),
      evidence: normalizedChoices[0]?.evidence || "host_multimodal_visual_choices",
      promotion_status: "conflict_check_only_roi_ocr_current_choice_set_primary",
      reason: "ROI/RapidOCR choice set already exists; host visual candidates are retained only as fallback/conflict evidence.",
    };
    return;
  }
  liveState.augments.choice_candidates = normalizedChoices;
  liveState.augments.current_choice_set = {
    schema: "jcc-augment-current-choice-set-v1",
    source: "host_multimodal_visual",
    choices: normalizedChoices,
    observed_at: observations.metadata?.observed_at || observations.metadata?.created_at || new Date().toISOString(),
    replace_current_choice_set: true,
  };
  liveState.field_status ||= {};
  liveState.field_status["augments.choice_candidates"] = {
    status: "candidate",
    source_type: "visual_screen",
    source: "host_multimodal_visual",
    confidence: Math.max(...normalizedChoices.map((choice) => choice.confidence || 0)),
    evidence: normalizedChoices[0]?.evidence || "host_multimodal_visual_choices",
    promotion_status: "candidate_not_verified",
    reason: "visible current augment choice set from host multimodal visual observation",
  };
  liveState.field_status["augments.current_choice_set"] = {
    status: "candidate",
    source_type: "visual_screen",
    source: "host_multimodal_visual",
    confidence: Math.max(...normalizedChoices.map((choice) => choice.confidence || 0)),
    evidence: normalizedChoices[0]?.evidence || "host_multimodal_visual_choices",
    promotion_status: "candidate_not_verified",
    replacement_policy: "visual_fallback_only_when_roi_ocr_choice_set_absent",
    reason: "host multimodal visual result is fallback candidate evidence for current augment choices",
  };
}

function syncVisualItemChoices(liveState, observations) {
  const choices = usableVisualCandidates(observations.items?.choice_options)
    .filter((candidate) => choiceNameFromCandidate(candidate));
  if (!choices.length) return;
  const existingStatus = liveState.field_status?.["items.choice_options"];
  if (existingStatus?.status === "verified") return;
  liveState.items ||= {};
  const normalizedChoices = choices.slice(0, 5).map((candidate, index) => ({
    ...candidate,
    name: choiceNameFromCandidate(candidate),
    slot: candidate.slot ?? candidate.index ?? index,
    source: candidateSource(candidate) || "host_multimodal_visual",
    semantic_status: candidate.semantic_status || "visible_item_choice_candidate",
  }));
  const existingChoiceSet = liveState.items.current_choice_set;
  const existingSource = existingStatus?.source || existingChoiceSet?.source || "";
  if (isRoiChoiceSource(existingSource)) {
    liveState.items.visual_choice_candidates = normalizedChoices;
    liveState.field_status ||= {};
    liveState.field_status["items.visual_choice_candidates"] = {
      status: "candidate",
      source_type: "visual_screen",
      source: "host_multimodal_visual",
      confidence: Math.max(...normalizedChoices.map((choice) => choice.confidence || 0)),
      evidence: normalizedChoices[0]?.evidence || "host_multimodal_visual_choices",
      promotion_status: "conflict_check_only_roi_ocr_current_choice_set_primary",
      reason: "ROI/RapidOCR item choice set already exists; host visual candidates are retained only as fallback/conflict evidence.",
    };
    return;
  }
  liveState.items.choice_options = normalizedChoices;
  liveState.items.current_choice_set = {
    schema: "jcc-item-current-choice-set-v1",
    source: "host_multimodal_visual",
    choices: normalizedChoices,
    observed_at: observations.metadata?.observed_at || observations.metadata?.created_at || new Date().toISOString(),
    replace_current_choice_set: true,
  };
  liveState.field_status ||= {};
  liveState.field_status["items.choice_options"] = {
    status: "candidate",
    source_type: "visual_screen",
    source: "host_multimodal_visual",
    confidence: Math.max(...normalizedChoices.map((choice) => choice.confidence || 0)),
    evidence: normalizedChoices[0]?.evidence || "host_multimodal_visual_item_choices",
    promotion_status: "candidate_not_verified",
    replacement_policy: "visual_fallback_only_when_roi_ocr_choice_set_absent",
    reason: "visible current item choice set from host multimodal fallback",
  };
}

function syncSpecializedItemBench(liveState, observations) {
  const candidates = candidateVisualRows(observations.items?.item_bench_candidates)
    .filter(isLeftItemRailSpecializedCandidate);
  const leftRailObservation = observations.metadata?.source === "left_item_rail_roi_icon"
    || candidates.length > 0
    || observations.field_status?.["items.item_bench_candidates"]?.source === "left_item_rail_roi_icon";
  if (!leftRailObservation) return;
  const existingStatus = liveState.field_status?.["items.item_bench"];
  if (existingStatus?.status === "verified") return;
  liveState.items ||= {};
  const normalizedCandidates = candidates.map((candidate) => ({
    ...candidate,
    semantic_status: candidate.semantic_status || "left_item_rail_roi_icon_candidate",
    source: candidateSource(candidate) || "left_item_rail_roi_icon",
  }));
  const hasStructuredPrimary = hasStructuredMumu4357ItemBench(liveState);
  liveState.items.item_bench_candidates = [
    ...normalizedCandidates,
  ].map((candidate) => ({
    ...candidate,
    semantic_status: hasStructuredPrimary
      ? "left_item_rail_roi_icon_validation_candidate"
      : "left_item_rail_roi_icon_fallback_candidate_not_promoted",
  }));
  liveState.field_status ||= {};
  liveState.field_status["items.item_bench_candidates"] = {
    status: candidates.length ? "candidate" : "missing",
    source_type: "left_item_rail_icon_matcher",
    source: "left_item_rail_roi_icon",
    confidence: candidates.length ? Math.max(...candidates.map((candidate) => candidate.confidence || 0)) : 0,
    evidence: candidates[0]?.evidence || "left_item_rail_roi_icon",
    promotion_status: hasStructuredPrimary ? "validation_only_mumu_4357_primary" : "fallback_candidates_not_promoted",
    reason: hasStructuredPrimary
      ? "4357 structured item bench is primary; icon matcher rows are validation/fallback evidence only"
      : "4357 structured item bench is absent; left rail icon rows stay as fallback candidates and do not populate items.item_bench",
  };
}

function visualObservationMode(observations) {
  return observations.metadata?.mode
    || observations.metadata?.vision_model?.mode
    || observations.metadata?.request?.mode
    || observations.request?.mode
    || observations.mode
    || null;
}

function isSelfStateOnlyVisualObservation(observations) {
  return visualObservationMode(observations) === "refresh_self_state"
    || isSelfStateRoiOcrSource(observations.metadata?.source);
}

function applyVisualCandidates(liveStateInput, visualInput, contract) {
  const output = structuredClone(liveStateInput);
  const liveState = output.live_state || output;
  const rawObservations = visualInput.visual_observations || visualInput;
  const observations = sanitizeVisualForProduct(rawObservations);
  const selfStateOnly = isSelfStateOnlyVisualObservation(observations);
  const liveSessionId = liveState.metadata?.match_session_id || output.metadata?.match_session_id || liveState.match_session_id || output.match_session_id || null;
  const visualSessionId = observations.metadata?.match_session_id || observations.match_session_id || null;
  if (liveSessionId && visualSessionId && liveSessionId !== visualSessionId) {
    throw new Error(`match_session_id mismatch: live_state=${liveSessionId} visual_observations=${visualSessionId}`);
  }
  const matchSessionId = liveSessionId || visualSessionId || null;
  liveState.visual = {
    contract_ref: CONTRACT_REF,
    match_session_id: matchSessionId,
    frame_id: observations.frame_id,
    frame_hash: observations.frame_hash,
    phase: observations.phase,
    economy: observations.economy,
    shop: observations.shop,
    board: observations.board,
    bench: observations.bench,
    augments: observations.augments,
    items: observations.items,
    metadata: observations.metadata,
    promotion_policy: contract.promotion_policy,
    pollution_guard: contract.pollution_guard,
    match_session_policy: contract.match_session_policy,
  };
  const existingFieldStatus = liveState.field_status || {};
  const visualStatuses = {
    "phase.phase": visualFieldStatus(observations.phase, "visual phase candidate"),
    "economy.hp": visualFieldStatus(observations.economy?.hp, "host multimodal visual candidate; promote only after field policy accepts it"),
    "economy.gold": visualFieldStatus(observations.economy?.gold, "host multimodal visual candidate; promote only after field policy accepts it"),
    "economy.level": visualFieldStatus(observations.economy?.level, "host multimodal visual candidate; promote only after field policy accepts it"),
    "economy.xp": visualFieldStatus(observations.economy?.xp, "host multimodal visual candidate; promote only after field policy accepts it"),
    "shop.shop_units": candidateArrayStatus(observations.shop?.shop_units, "host multimodal shop candidates do not overwrite MuMu bridge shop units"),
    "board.board_units": candidateArrayStatus(observations.board?.board_units, "host multimodal board candidates are visual evidence only; MuMu bridge owns unit identity"),
    "bench.bench_units": candidateArrayStatus(observations.bench?.bench_units, "host multimodal bench candidates are visual evidence only; MuMu bridge owns bench identity"),
    "augments.selection_active": visualFieldStatus(observations.augments?.selection_active, "phase-derived augment candidate"),
    "augments.choices": candidateArrayStatus(observations.augments?.choices, "host multimodal choice candidates; user confirmation/history decides final selected augment"),
    "augments.selected_augments": candidateArrayStatus(observations.augments?.selected_augments, "host multimodal selected-augment candidates; same-icon groups stay ambiguous until disambiguated"),
    "items.choice_options": candidateArrayStatus(observations.items?.choice_options, "host multimodal item choice candidates; user confirmation decides final choice"),
    "items.item_bench": candidateArrayStatus(observations.items?.item_bench, "left item rail ROI icon candidates or host multimodal item bench candidates; low-confidence small icons remain candidates"),
    "items.item_bench_candidates": candidateArrayStatus(observations.items?.item_bench_candidates, "uncertain left item rail icon matches are diagnostic candidates, not hard item_bench facts"),
    "items.equipped_items": candidateArrayStatus(observations.items?.equipped_items, "host multimodal equipped-item candidates; phase and owner gates still apply"),
  };
  liveState.field_status = { ...existingFieldStatus };
  const leftItemRailObservation = isLeftItemRailObservation(observations);
  for (const [field, status] of Object.entries(visualStatuses)) {
    if (existingFieldStatus[field]?.status === "verified") continue;
    if (field === "items.item_bench" && (leftItemRailObservation || isMumu4357ItemBenchSource(existingFieldStatus[field]))) {
      continue;
    }
    liveState.field_status[field] = status;
  }
  if (!selfStateOnly) {
    syncVisualAugmentChoices(liveState, observations);
    syncVisualItemChoices(liveState, observations);
  }
  syncSpecializedItemBench(liveState, observations);
  promoteVisualPhaseAndEconomy(liveState, observations);
  liveState.metadata = {
    ...(liveState.metadata || {}),
    source_health: {
      ...(liveState.metadata?.source_health || {}),
      visual: {
        contract_ref: CONTRACT_REF,
        match_session_id: matchSessionId,
        source: observations.metadata?.source || "visual_observation",
        frame_id: observations.frame_id,
        storage_policy: observations.metadata?.storage_policy || contract.storage_policy,
        layout: observations.metadata?.layout || null,
        self_state_only: selfStateOnly,
      },
    },
  };
  output.metadata = {
    ...(output.metadata || {}),
    source_health: {
      ...(output.metadata?.source_health || {}),
      visual: liveState.metadata.source_health.visual,
    },
  };
  output.visual_contract = {
    contract_id: contract.contract_id,
    product_boundary: contract.product_boundary,
    mvp_fields: contract.mvp_fields,
    forbidden_sources: contract.forbidden_sources,
    match_session_policy: contract.match_session_policy,
  };
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.liveState) throw new Error(`Missing --live-state\n${usage()}`);
  if (!options.visualObservations) throw new Error(`Missing --visual-observations\n${usage()}`);
  const liveState = await readJson(options.liveState);
  const visual = await readJson(options.visualObservations);
  const contract = await readJson(CONTRACT_REF);
  const updated = applyVisualCandidates(liveState, visual, contract);
  const text = `${JSON.stringify(updated, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, "utf8");
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
