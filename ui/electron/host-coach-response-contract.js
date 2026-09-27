export const HOST_COACH_RESPONSE_SCHEMA_ID = "jcc-host-cli-coach-response-v1";
export const HOST_COACH_RESPONSE_GENERATOR = "current_cli_agent_main_model";
export const AUGMENT_CHOICE_REFRESH_ACTIONS = Object.freeze([
  "keep_and_pick", "refresh_specific", "refresh_all", "refresh_if_available", "no_refresh_available",
]);

export function normalizeAugmentRefreshAction(value) {
  const action = snakeCaseEnum(value);
  return action === "keep" ? "keep_and_pick" : action;
}

export function augmentCandidateTransportKey(value) {
  // Tier typography is resolved only against this request's exact candidate set.
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase()
    .replace(/(iii|ii|iv|i)$/u, (tier) => ({ i: "1", ii: "2", iii: "3", iv: "4" })[tier]);
}

const CHOICE_RESPONSE_MODES = new Set(["augment_choice", "item_choice"]);
const HARD_STRATEGIC_RESPONSE_MODES = new Set(["strategic_checkpoint"]);

export function resolveHostCoachResponseValidationBoundary({
  mode = null,
  strategicEvidencePresent = false,
  strategicContractRequired = false,
  lineupCard = false,
} = {}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  const choiceMode = CHOICE_RESPONSE_MODES.has(normalizedMode);
  const lineupCardMode = lineupCard === true || normalizedMode === "lineup_card";
  const hardStrategicMode = HARD_STRATEGIC_RESPONSE_MODES.has(normalizedMode) || lineupCardMode;
  const strategicValidationRequired = hardStrategicMode
    || strategicContractRequired === true;
  return Object.freeze({
    mode: normalizedMode || null,
    choice_mode: choiceMode,
    lineup_card_validation_required: lineupCardMode,
    strategic_evidence_present: strategicEvidencePresent === true,
    strategic_candidate_validation_required: strategicValidationRequired,
    strategy_content_is_advisory: true,
    hard_failures_are_transport_or_authority_only: true,
  });
}

const nullableString = () => ({ type: ["string", "null"] });

const nullableInteger = ({ minimum = null, maximum = null } = {}) => ({
  type: ["integer", "null"],
  ...(minimum == null ? {} : { minimum }),
  ...(maximum == null ? {} : { maximum }),
});

function strictObject(properties, {
  additionalProperties = false,
  required = Object.keys(properties),
} = {}) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties,
  };
}

function baseCoachProperties() {
  return {
    schema: { type: "string", const: HOST_COACH_RESPONSE_SCHEMA_ID },
    generated_by: { type: "string", const: HOST_COACH_RESPONSE_GENERATOR },
    final_text: { type: "string", minLength: 1 },
  };
}

function choiceHandoffSchema(candidateNames = []) {
  const refs = [...new Set(candidateNames.map((value) => String(value || "").trim()).filter(Boolean))];
  const refSchema = refs.length ? { type: "string", enum: refs } : { type: "string", minLength: 1 };
  return strictObject({
    selected_ref: {
      anyOf: [
        { type: "null" },
        refSchema,
      ],
    },
    ordered_refs: {
      type: "array",
      items: refSchema,
      minItems: 0,
      maxItems: 8,
    },
    ui_action: {
      type: "string",
      enum: ["select", "refresh", "none"],
    },
    refresh_slots: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 3 },
      maxItems: 3,
    },
  });
}

function candidateRefsSchema(candidateIds = []) {
  const candidates = [...new Set(candidateIds.map((value) => String(value || "").trim()).filter(Boolean))];
  const candidateIdSchema = candidates.length
    ? { type: "string", enum: candidates }
    : { type: "string", minLength: 1 };
  return {
    type: "array",
    items: strictObject({
      candidate_id: candidateIdSchema,
      variant_id: nullableString(),
      candidate_evidence_id: nullableString(),
    }),
    maxItems: 10,
  };
}

function lineupHandoffSchema() {
  return {
    anyOf: [
      { type: "null" },
      strictObject({
        candidate_id: nullableString(),
        variant_id: nullableString(),
        target_source: {
          type: "string",
          enum: ["ranking", "chat_discovered", "user_custom"],
        },
        target_identity: nullableString(),
        adjustments: { type: "array", items: { type: "string" }, maxItems: 12 },
        equipment_priority: { type: "array", items: { type: "string" }, maxItems: 12 },
        positioning_intent: nullableString(),
      }),
    ],
  };
}

function lineupCardSchema() {
  const unit = strictObject({
    row: nullableInteger({ minimum: 1, maximum: 4 }),
    col: nullableInteger({ minimum: 1, maximum: 7 }),
    name: { type: "string", minLength: 1 },
    mark: nullableString(),
    star: nullableInteger({ minimum: 1, maximum: 4 }),
    role: nullableString(),
    items: { type: "array", items: { type: "string" }, maxItems: 3 },
    notes: nullableString(),
  }, { required: ["name"] });
  const loadout = strictObject({
    unit: { type: "string", minLength: 1 },
    items: { type: "array", items: { type: "string" }, maxItems: 3 },
    note: nullableString(),
  }, { required: ["unit", "items"] });
  const move = strictObject({
    unit: nullableString(),
    from: nullableString(),
    to: nullableString(),
    action: nullableString(),
    reason: nullableString(),
    description: nullableString(),
  }, { required: [] });
  const strategy = strictObject({
    target_source: nullableString(),
    target_identity: nullableString(),
    candidate_id: nullableString(),
    selected_variant_id: nullableString(),
    main_carry: nullableString(),
    main_tank: nullableString(),
    secondary_carry: nullableString(),
    core_traits: { type: "array", items: { type: "string" }, maxItems: 16 },
    formation_burden: nullableString(),
    cap: nullableString(),
    floor: nullableString(),
    augment_fit: nullableString(),
    artifact_fit: nullableString(),
    emblem_fit: nullableString(),
    key_mechanic: nullableString(),
    augment_conditions: { type: "array", items: { type: "string" }, maxItems: 24 },
    transition_path: { type: "array", items: { type: "string" }, maxItems: 24 },
    conditions: { type: "array", items: { type: "string" }, maxItems: 8 },
    replacements: { type: "array", items: { type: "string" }, maxItems: 8 },
  }, { required: [] });
  const node = strictObject({
    id: nullableString(),
    label: nullableString(),
    timing: nullableString(),
    level: nullableInteger({ minimum: 1, maximum: 12 }),
    units: { type: "array", items: unit, maxItems: 11 },
    recommended_moves: { type: "array", items: move, maxItems: 24 },
    moves: { type: "array", items: { type: "string" }, maxItems: 24 },
  }, { required: [] });
  return strictObject({
    schema: { type: "string", const: "jcc-internal-lineup-plan-v1" },
    slot: { type: "string", enum: ["lineup", "position", "target", "transition", "next_pivot", "positioning"] },
    title: { type: "string", minLength: 1 },
    candidate_id: nullableString(),
    selected_variant_id: nullableString(),
    target_source: { type: ["string", "null"], enum: ["candidate", "chat_discovery", "user_custom", null] },
    target_identity: nullableString(),
    summary: nullableString(),
    units: { type: "array", items: unit, minItems: 0, maxItems: 11 },
    loadouts: { type: "array", items: loadout, maxItems: 16 },
    recommended_moves: { type: "array", items: move, maxItems: 24 },
    moves: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 24 },
    equipment_status: { type: "string", enum: ["provided", "not_provided_in_evidence", "unknown", "pending"] },
    strategy,
    nodes: { type: "array", items: node, maxItems: 24 },
  }, { required: ["schema", "slot", "title"] });
}

function factCaptureSchema() {
  const item = strictObject({
    entity_name: { type: "string", minLength: 1 },
    quantity: { type: "integer", minimum: 1, maximum: 20 },
  });
  const operation = strictObject({
    op: {
      type: "string",
      enum: ["set_choice", "replace_equipment", "add_equipment", "remove_equipment", "clear_equipment", "assign_equipment", "clear_equipment_assignments", "set_match_variable"],
    },
    choice_kind: nullableString(),
    stage_round: nullableString(),
    entity_name: nullableString(),
    reward_text: nullableString(),
    category: { type: ["string", "null"], enum: ["components", "completed", "radiant", "support", "artifacts", "emblems", "special", null] },
    items: { type: "array", items: item, maxItems: 32 },
    champion_name: nullableString(),
    item_name: nullableString(),
    quantity: nullableInteger({ minimum: 0, maximum: 99 }),
    holder_intent: { type: ["string", "null"], enum: ["temporary", "unspecified", null] },
    field_key: nullableString(),
    value_text: nullableString(),
    input_text: nullableString(),
  });
  const unresolved = strictObject({
    input_text: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
  });
  return strictObject({
    schema: { type: "string", const: "jcc-match-fact-capture-v1" },
    operations: { type: "array", items: operation, maxItems: 32 },
    unresolved: { type: "array", items: unresolved, maxItems: 16 },
  });
}

export function buildHostCoachNativeOutputSchema({
  mode = null,
  augmentCandidateNames = [],
  strategicDecisionKeys = [],
  strategicCandidateIds = [],
  strategicContractRequired = null,
  lineupCard = false,
  factCapture = false,
} = {}) {
  const requestedStrategicContract = strategicContractRequired === null
    ? strategicDecisionKeys.length > 0
    : strategicContractRequired === true;
  const validationBoundary = resolveHostCoachResponseValidationBoundary({
    mode,
    strategicEvidencePresent: strategicDecisionKeys.length > 0 || strategicCandidateIds.length > 0,
    strategicContractRequired: requestedStrategicContract,
    lineupCard,
  });
  const properties = baseCoachProperties();
  // A turn gets one mechanical handoff. This keeps combined UI/strategic
  // requests from asking the Agent to repeat the same identity in multiple
  // structures while final_text remains the complete player-facing answer.
  if (factCapture) properties.fact_capture = factCaptureSchema();
  else if (lineupCard) properties.lineup_handoff = lineupHandoffSchema();
  else if (augmentCandidateNames.length) properties.choice_handoff = choiceHandoffSchema(augmentCandidateNames);
  else if (validationBoundary.strategic_candidate_validation_required) {
    properties.candidate_refs = candidateRefsSchema(strategicCandidateIds);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "JCC Host Coach Response",
    ...strictObject(properties),
  };
}

export const HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "JCC Host Session Warmup Response",
  ...strictObject({
    schema: { type: "string", const: "jcc-host-session-bootstrap-ack-v1" },
    capsule_id: { type: "string", minLength: 1 },
    operation: { type: "string", minLength: 1 },
    accepted: { type: "boolean", const: true },
  }),
});

export function buildWikiCurationNativeOutputSchema({ runId = null } = {}) {
  const page = strictObject({
    page_id: nullableString(),
    revision: nullableString(),
    namespace: { type: "string", const: "personal_strategy" },
    category: {
      type: "string",
      enum: ["patch_meta_strategy", "season_mechanic_strategy", "universal_gameplay_strategy"],
    },
    season_id: nullableString(),
    patch_id: nullableString(),
    title: { type: "string", minLength: 1 },
    summary: nullableString(),
    body_md: nullableString(),
    tags: { type: "array", items: { type: "string" }, maxItems: 20 },
    source_event_ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    status: { type: "string", const: "draft" },
    stale_reason: nullableString(),
  });
  const staleUpdate = strictObject({
    page_id: { type: "string", minLength: 1 },
    revision: { type: "string", minLength: 1 },
    stale_reason: nullableString(),
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "JCC Wiki Curation Host Response",
    ...strictObject({
      schema: { type: "string", const: "jcc-wiki-curation-host-response-v1" },
      generated_by: { type: "string", const: HOST_COACH_RESPONSE_GENERATOR },
      run_id: runId ? { type: "string", const: String(runId) } : { type: "string", minLength: 1 },
      pages: { type: "array", items: page },
      stale_page_updates: { type: "array", items: staleUpdate },
      user_questions: { type: "array", items: { type: "string" } },
    }),
  };
}

function firstPresent(source, names) {
  const present = names.filter((name) => source[name] !== undefined);
  if (present.some((name) => !sameTransportValue(source[name], source[present[0]]))) {
    throw new Error(`host response transport alias conflict: ${names[0]}`);
  }
  return present.length ? source[present[0]] : undefined;
}

function sameTransportValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameTransportValue(left[key], right[key]));
}

// Only schema-declared paths are mechanical transport fields. Free text, arbitrary
// provider wrappers and stringified business payloads are never interpreted.
function normalizeDeclaredTransport(value, schema, path = "response") {
  if (value === undefined || value === null) return value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("integer")) {
    const number = typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isSafeInteger(number)) throw new Error(`${path} must be an integer`);
    return number;
  }
  if (types.includes("array")) {
    return (Array.isArray(value) ? value : [value]).map((entry, index) => normalizeDeclaredTransport(entry, schema.items, `${path}[${index}]`));
  }
  if (!types.includes("object") || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  for (const [key, childSchema] of Object.entries(schema.properties || {})) {
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const names = [...new Set([key, camel])].filter((name) => value[name] !== undefined);
    const entries = names.map((name) => normalizeDeclaredTransport(value[name], childSchema, `${path}.${key}`));
    if (entries.some((entry) => !sameTransportValue(entry, entries[0]))) throw new Error(`host response transport alias conflict: ${path}.${key}`);
    if (entries.length) {
      for (const name of names) delete result[name];
      result[key] = entries[0];
    }
  }
  return result;
}

export function normalizeHostLineupTransport(value) {
  const result = normalizeDeclaredTransport(value, lineupCardSchema(), "pinned_result");
  if (!result || typeof result !== "object") return result;
  const normalizeUnitAliases = (unit) => {
    if (!unit || typeof unit !== "object") return unit;
    const aliases = {
      ...unit,
      name: firstPresent(unit, ["name", "unit", "champion", "champion_name", "championName"]),
      row: firstPresent(unit, ["row", "r"]),
      col: firstPresent(unit, ["col", "column", "column_index", "columnIndex", "c"]),
    };
    for (const key of ["unit", "champion", "champion_name", "championName", "r", "column", "column_index", "columnIndex", "c"]) delete aliases[key];
    return normalizeDeclaredTransport(aliases, lineupCardSchema().properties.units.items, "pinned_result.units");
  };
  if (result.units != null) result.units = normalizeArray(result.units).map(normalizeUnitAliases);
  if (result.board?.units != null) result.board = { ...result.board, units: normalizeArray(result.board.units).map(normalizeUnitAliases) };
  if (Array.isArray(result.nodes)) result.nodes = result.nodes.map((node) => normalizeHostLineupTransport(node));
  return result;
}

function normalizeChoiceRecommendationAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    candidate_ranking: normalizeArray(firstPresent(value, ["candidate_ranking", "candidateRanking", "ranking"])),
    refresh_action: normalizeAugmentRefreshAction(firstPresent(value, ["refresh_action", "refreshAction", "action"])),
    selected_candidate: firstPresent(value, ["selected_candidate", "selectedCandidate", "choice_name", "choiceName"]),
    refresh_slots: normalizeArray(firstPresent(value, ["refresh_slots", "refreshSlots", "reroll_slots", "rerollSlots"]))
      .map((slot) => normalizeDeclaredTransport(slot, { type: "integer" }, "choice_recommendation.refresh_slots")),
  };
}

function normalizeChoiceHandoffAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    selected_ref: firstPresent(value, ["selected_ref", "selectedRef"]),
    ordered_refs: normalizeArray(firstPresent(value, ["ordered_refs", "orderedRefs"])),
    ui_action: snakeCaseEnum(firstPresent(value, ["ui_action", "uiAction", "action"])),
    refresh_slots: normalizeArray(firstPresent(value, ["refresh_slots", "refreshSlots"]))
      .map((slot) => normalizeDeclaredTransport(slot, { type: "integer" }, "choice_handoff.refresh_slots")),
  };
}

function choiceRecommendationFromHandoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ordered = normalizeArray(value.ordered_refs).filter(Boolean);
  const selected = value.selected_ref || ordered[0] || null;
  const slots = normalizeArray(value.refresh_slots);
  const uiAction = snakeCaseEnum(value.ui_action);
  const refreshAction = uiAction === "select"
    ? "keep_and_pick"
    : uiAction === "refresh"
      ? (slots.length === 3 ? "refresh_all" : "refresh_specific")
      : "no_refresh_available";
  return {
    candidate_ranking: ordered,
    refresh_action: refreshAction,
    selected_candidate: selected,
    refresh_slots: slots,
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function snakeCaseEnum(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function normalizeCandidateReferenceAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    candidate_id: firstPresent(value, ["candidate_id", "candidateId", "id"]),
    selected_variant_id: firstPresent(value, ["selected_variant_id", "selectedVariantId", "variant_id", "variantId"]),
    candidate_evidence_id: firstPresent(value, ["candidate_evidence_id", "candidateEvidenceId", "evidence_id", "evidenceId"]),
  };
}

function normalizeLineupHandoffAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    candidate_id: firstPresent(value, ["candidate_id", "candidateId"]),
    variant_id: firstPresent(value, ["variant_id", "variantId", "selected_variant_id", "selectedVariantId"]),
    target_source: snakeCaseEnum(firstPresent(value, ["target_source", "targetSource"])),
    target_identity: firstPresent(value, ["target_identity", "targetIdentity"]),
    adjustments: normalizeArray(firstPresent(value, ["adjustments", "changes"])),
    equipment_priority: normalizeArray(firstPresent(value, ["equipment_priority", "equipmentPriority"])),
    positioning_intent: firstPresent(value, ["positioning_intent", "positioningIntent"]),
  };
}

function normalizeAugmentOverrideAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    fact_path: firstPresent(value, ["fact_path", "factPath", "path"]),
  };
}

function normalizeStrategicCompletionAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    covered_required_decisions: normalizeArray(firstPresent(value, ["covered_required_decisions", "coveredRequiredDecisions", "covered_decisions", "coveredDecisions"])),
    decision_outputs: firstPresent(value, ["decision_outputs", "decisionOutputs", "outputs"]),
  };
}

function normalizeStrategySelectionAliases(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    unavailable_reason: firstPresent(value, ["unavailable_reason", "unavailableReason"]),
    selected_candidate_ids: normalizeArray(firstPresent(value, ["selected_candidate_ids", "selectedCandidateIds", "candidate_ids", "candidateIds"])),
    selected_candidate_refs: normalizeArray(firstPresent(value, ["selected_candidate_refs", "selectedCandidateRefs", "selection_refs", "selectionRefs"]))
      .map(normalizeCandidateReferenceAliases),
  };
}

export function isHostCoachTransportCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const normalized = normalizeHostCoachTransportEnvelope(value);
  return normalized?.schema === HOST_COACH_RESPONSE_SCHEMA_ID
    && normalized?.generated_by === HOST_COACH_RESPONSE_GENERATOR
    && typeof normalized?.final_text === "string"
    && normalized.final_text.trim().length > 0;
}

export function normalizeHostCoachTransportEnvelope(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  if (Object.hasOwn(response, "response")) {
    const inner = response.response;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new Error("host response transport wrapper must contain one object");
    if (Object.keys(response).some((key) => key !== "response")) throw new Error("host response transport wrapper conflict");
    if (Object.hasOwn(inner, "response")) throw new Error("host response transport nested wrapper conflict");
    response = inner;
  }
  const legacyChoiceRecommendation = firstPresent(response, ["choice_recommendation", "choiceRecommendation"]);
  const choiceHandoff = normalizeChoiceHandoffAliases(firstPresent(response, ["choice_handoff", "choiceHandoff"]));
  const legacyStrategySelection = normalizeStrategySelectionAliases(firstPresent(response, ["strategy_selection", "strategySelection"]));
  const directCandidateRefs = firstPresent(response, ["candidate_refs", "candidateRefs"]);
  const candidateRefs = normalizeArray(directCandidateRefs === undefined
    ? legacyStrategySelection?.selected_candidate_refs
    : directCandidateRefs).map(normalizeCandidateReferenceAliases);
  return {
    ...response,
    schema: firstPresent(response, ["schema", "response_schema", "responseSchema"]),
    generated_by: firstPresent(response, ["generated_by", "generatedBy"]),
    final_text: firstPresent(response, ["final_text", "finalText", "text"]),
    recommended_action: firstPresent(response, ["recommended_action", "recommendedAction"]),
    followup_question: firstPresent(response, ["followup_question", "followupQuestion"]),
    choice_handoff: choiceHandoff,
    choice_recommendation: normalizeChoiceRecommendationAliases(legacyChoiceRecommendation)
      || choiceRecommendationFromHandoff(choiceHandoff),
    augment_evaluator_override_reason: normalizeAugmentOverrideAliases(firstPresent(response, ["augment_evaluator_override_reason", "augmentEvaluatorOverrideReason"])),
    fact_capture: normalizeDeclaredTransport(firstPresent(response, ["fact_capture", "factCapture"]), factCaptureSchema(), "fact_capture"),
    pinned_result: normalizeHostLineupTransport(firstPresent(response, ["pinned_result", "pinnedResult"])),
    lineup_handoff: normalizeLineupHandoffAliases(firstPresent(response, ["lineup_handoff", "lineupHandoff"])),
    candidate_refs: candidateRefs,
    strategic_completion: normalizeStrategicCompletionAliases(firstPresent(response, ["strategic_completion", "strategicCompletion"])),
    strategy_selection: legacyStrategySelection || (candidateRefs.length ? {
      status: "selected",
      unavailable: false,
      unavailable_reason: null,
      selected_candidate_ids: candidateRefs.map((ref) => ref.candidate_id).filter(Boolean),
      selected_candidate_refs: candidateRefs,
    } : undefined),
    request_id: firstPresent(response, ["request_id", "requestId"]),
    request_hash: firstPresent(response, ["request_hash", "requestHash"]),
  };
}
