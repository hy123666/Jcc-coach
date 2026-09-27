import assert from "node:assert/strict";
import { assertProviderOutputSchema } from "../ui/electron/host-adapters.js";
import { buildHostCoachNativeOutputSchema, buildWikiCurationNativeOutputSchema, HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA, normalizeHostCoachTransportEnvelope as normalize } from "../ui/electron/host-coach-response-contract.js";
import { parseHostJsonObject } from "../ui/electron/host-response-json.js";
import { normalizeLineupPinnedResult, lineupPinnedResultSchemaDiagnostics } from "../ui/electron/lineup-card-contract.js";

const identity = { schema: "jcc-host-cli-coach-response-v1", generated_by: "current_cli_agent_main_model", final_text: "answer" };
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
function strictShape(schema, at = "$") {
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, at);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties || {}).sort(),
      `${at}: every declared property must be required by the Provider transport schema`,
    );
  }
  for (const [name, child] of Object.entries(schema.properties || {})) strictShape(child, `${at}.${name}`);
  if (schema.items) strictShape(schema.items, `${at}[]`);
  for (const child of schema.anyOf || []) strictShape(child, `${at}.anyOf`);
  for (const child of schema.oneOf || []) strictShape(child, `${at}.oneOf`);
  for (const child of schema.allOf || []) strictShape(child, `${at}.allOf`);
}
check("native_strict_shapes_all_modes", () => {
  for (const options of [{}, { augmentCandidateNames: ["A", "B", "C"] }, { strategicDecisionKeys: ["lineup_direction"], strategicCandidateIds: ["A"] }, { lineupCard: true }, { factCapture: true }]) {
    const schema = buildHostCoachNativeOutputSchema(options);
    strictShape(schema);
    assert.equal(assertProviderOutputSchema(schema), schema);
  }
  for (const schema of [buildWikiCurationNativeOutputSchema(), HOST_SESSION_WARMUP_NATIVE_OUTPUT_SCHEMA]) {
    strictShape(schema);
    assert.equal(assertProviderOutputSchema(schema), schema);
  }
});
check("provider_preflight_rejects_both_required_directions_locally", () => {
  assert.throws(() => assertProviderOutputSchema({
    type: "object",
    properties: { present: { type: "string" }, omitted: { type: "string" } },
    required: ["present", "unknown"],
    additionalProperties: false,
  }), /invalid_json_schema.*missing omitted.*unknown unknown/);
});
check("coach_schema_contains_only_minimal_machine_handoffs", () => {
  const plain = buildHostCoachNativeOutputSchema();
  assert.deepEqual(Object.keys(plain.properties), ["schema", "generated_by", "final_text"]);

  const choice = buildHostCoachNativeOutputSchema({ augmentCandidateNames: ["A", "B", "C"] });
  assert(choice.properties.choice_handoff);
  assert.equal(choice.properties.choice_recommendation, undefined);
  assert.equal(choice.properties.augment_evaluator_override_reason, undefined);

  const strategic = buildHostCoachNativeOutputSchema({
    mode: "strategic_checkpoint",
    strategicDecisionKeys: ["lineup_direction"],
    strategicCandidateIds: ["A"],
  });
  assert(strategic.properties.candidate_refs);
  assert.equal(strategic.properties.strategic_completion, undefined);
  assert.equal(strategic.properties.strategy_selection, undefined);

  const card = buildHostCoachNativeOutputSchema({ mode: "lineup_card", lineupCard: true });
  assert(card.properties.lineup_handoff);
  assert.equal(card.properties.candidate_refs, undefined);
  assert.equal(card.properties.pinned_result, undefined);

  const combined = buildHostCoachNativeOutputSchema({
    mode: "lineup_card",
    lineupCard: true,
    augmentCandidateNames: ["A", "B", "C"],
    strategicDecisionKeys: ["lineup_direction"],
    strategicCandidateIds: ["candidate-a"],
  });
  assert.deepEqual(
    Object.keys(combined.properties),
    ["schema", "generated_by", "final_text", "lineup_handoff"],
    "a combined card turn must carry one mechanical handoff instead of duplicate strategy identities",
  );
});
check("identity_alias_conflicts_fail_closed", () => {
  for (const extra of [{ responseSchema: "foreign" }, { generatedBy: "foreign" }, { finalText: "different" }, { request_id: "one", requestId: "two" }]) {
    assert.throws(() => normalize({ ...identity, ...extra }), /alias conflict/);
    assert.throws(() => parseHostJsonObject(JSON.stringify({ ...identity, ...extra })), /alias conflict/);
  }
  assert.equal(normalize({ ...identity, finalText: "answer" }).final_text, "answer");
});
check("missing_identity_not_filled", () => {
  for (const key of ["schema", "generated_by", "final_text"]) {
    const missing = { ...identity }; delete missing[key];
    assert.throws(() => parseHostJsonObject(JSON.stringify(missing)), /host_cli_json_parse_failed/);
  }
});
check("single_explicit_wrapper_only", () => {
  assert.equal(normalize({ response: { ...identity } }).final_text, "answer");
  assert.equal(normalize(parseHostJsonObject(JSON.stringify({ response: identity }))).final_text, "answer");
  assert.throws(() => normalize({ ...identity, response: { ...identity, final_text: "other" } }), /wrapper conflict/);
  assert.throws(() => parseHostJsonObject(JSON.stringify({ result: identity })), /host_cli_json_parse_failed/);
  assert.throws(() => normalize({ response: [identity, identity] }), /wrapper/);
});
check("choice_numeric_scalar_and_nested_aliases", () => {
  const value = normalize({ ...identity, choiceRecommendation: { candidateRanking: "A", refreshAction: "refresh Slots", refreshSlots: "2" }, strategicCompletion: { coveredRequiredDecisions: "lineup_direction", decisionOutputs: { lineup_direction: "Keep this" } } });
  assert.deepEqual(value.choice_recommendation.candidate_ranking, ["A"]);
  assert.deepEqual(value.choice_recommendation.refresh_slots, [2]);
  assert.equal(value.choice_recommendation.refresh_action, "refresh_slots");
  assert.deepEqual(value.strategic_completion.covered_required_decisions, ["lineup_direction"]);
  for (const bad of [true, "2x", "", " ", "1.5", "Infinity", {}]) {
    assert.throws(() => normalize({ ...identity, choice_recommendation: { refresh_slots: [bad] } }), /integer/);
  }
});
check("minimal_handoffs_normalize_to_runtime_compatibility_fields", () => {
  const value = normalize({
    ...identity,
    choiceHandoff: {
      selectedRef: "A",
      orderedRefs: ["A", "B", "C"],
      uiAction: "select",
      refreshSlots: [],
    },
    candidateRefs: [{ candidateId: "candidate-a", variantId: "variant-a", candidateEvidenceId: null }],
    lineupHandoff: {
      candidateId: "candidate-a",
      variantId: "variant-a",
      targetSource: "ranking",
      targetIdentity: null,
      adjustments: [],
      equipmentPriority: [],
      positioningIntent: null,
    },
  });
  assert.equal(value.choice_recommendation.selected_candidate, "A");
  assert.equal(value.choice_recommendation.refresh_action, "keep_and_pick");
  assert.equal(value.candidate_refs[0].selected_variant_id, "variant-a");
  assert.equal(value.strategy_selection.selected_candidate_refs[0].candidate_id, "candidate-a");
  assert.equal(value.lineup_handoff.variant_id, "variant-a");
});
check("fact_shape_normalization_does_not_invent_operations", () => {
  const fact = normalize({ ...identity, factCapture: { schema: "jcc-match-fact-capture-v1", operations: { op: "add_equipment", items: { entityName: "Item", quantity: "2" } }, unresolved: [] } }).fact_capture;
  assert.equal(fact.operations[0].items[0].quantity, 2);
  assert.equal(fact.operations[0].items[0].entity_name, "Item");
  assert.equal(normalize({ ...identity }).fact_capture, undefined);
  assert.equal(normalize({ ...identity, factCapture: {} }).fact_capture.operations, undefined);
});
check("lineup_camel_scalar_numeric_null_and_idempotence", () => {
  const card = { schema: "jcc-internal-lineup-plan-v1", slot: "transition", units: { row: "1", columnIndex: "2", championName: "Unit", star: null, items: "Item" }, recommendedMoves: { description: "Keep" }, strategy: { mainCarry: "Unit", coreTraits: "Trait" }, nodes: { level: null } };
  const result = normalizeLineupPinnedResult(card);
  assert.equal(result.units[0].col, 2);
  assert.equal(result.units[0].star, undefined);
  assert.deepEqual(result.units[0].items, ["Item"]);
  assert.equal(result.strategy.main_carry, "Unit");
  assert.deepEqual(result.strategy.core_traits, ["Trait"]);
  assert.deepEqual(normalizeLineupPinnedResult(result), result);
  assert.deepEqual(lineupPinnedResultSchemaDiagnostics(card), []);
});
check("invalid_lineup_never_silently_drops_units_or_items", () => {
  for (const invalid of [{ row: true }, { row: "1.5" }, { row: null }, { star: "2x" }, { items: ["1", "2", "3", "4"] }]) {
    const card = { units: [{ name: "Unit", row: 1, col: 1 }, { name: "Other", row: 2, col: 1, ...invalid }] };
    assert.throws(() => normalizeLineupPinnedResult(card), /integer|items/);
  }
});
check("legacy_coordinates_remain_idempotent", () => {
  const card = { units: [{ champion: "Unit", r: "1", c: "2" }] };
  const once = normalize({ ...identity, pinned_result: card });
  assert.deepEqual(normalize(once), once);
});
check("no_recursion_into_free_text_or_payload_strings", () => {
  const value = normalize({ ...identity, factCapture: '{"operations":[]}', final_text: '{"requestId":"foreign"}', provider_debug: { requestId: "foreign" } });
  assert.equal(typeof value.fact_capture, "string");
  assert.equal(value.request_id, undefined);
  assert.equal(value.final_text, '{"requestId":"foreign"}');
});
console.log(JSON.stringify({ ok: true, checks }, null, 2));
