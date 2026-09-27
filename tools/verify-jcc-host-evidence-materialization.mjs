import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { materializeHostEvidence, restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";

const candidates = Array.from({ length: 64 }, (_, index) => ({
  candidate_id: `candidate-${index}`,
  selected_variant_id: `variant-${index}`,
  canonical_variant: {
    variant_id: `variant-${index}`,
    population: 8,
    lineup_names: Array.from({ length: 8 }, (_, unit) => `unit-${index}-${unit}`),
    equipment_priority: { main_carry: ["item-a", "item-b", "item-c"] },
    transitions: [{ population: 7, lineup_names: ["transition-a", "transition-b"] }],
    positioning: { status: "unknown" },
    main_carry: { champion_id: `carry-${index}`, champion_name: `carry-${index}`, item_names: ["item-a", "item-b"] },
    primary_tank: { champion_id: `tank-${index}`, champion_name: `tank-${index}`, item_names: ["item-c"] },
  },
  strategy_profile: { semantic_features: { archetype: "standard" }, provenance: { source: "exact-ranking" } },
  top4_rate: 0.72,
  top1_rate: 0.22,
}));
const fit = { candidate_working_set: candidates, candidate_working_set_count: 64, requested_display_count: 3 };
const delta = {
  request_id: "test",
  mode: "cruise",
  runtime_context: {
    strategy_fit_packet: structuredClone(fit),
    strategy_evidence_prefetch: { evidence: { ranking: { candidates: structuredClone(candidates) }, fit: structuredClone(fit) } },
    strategy_evidence_coverage: { receipts: [{ facet_id: "ranking_lineup_candidates", evidence_keys: ["ranking"] }] },
  },
  selected_ranking_candidates: { candidates: structuredClone(candidates) },
};
const before = structuredClone(delta);
const output = materializeHostEvidence(delta, { runtimeContext: { strategy_fit_packet: fit } });
const restored = restoreHostEvidence(JSON.parse(JSON.stringify(output)));
assert.deepEqual(delta, before, "materialization must not mutate callers or their evidence store");
assert.equal(output.runtime_context.host_evidence_materialization.agent_candidate_count, 10);
assert.equal(output.runtime_context.host_evidence_materialization.retrieval_pool_count, 64);
assert.equal(output.runtime_context.host_evidence_materialization.requested_display_count, 3);
assert.deepEqual(restored.runtime_context.strategy_fit_packet.candidate_working_set, candidates.slice(0, 10));
assert.deepEqual(restored.selected_ranking_candidates.candidates, candidates.slice(0, 10));
assert.deepEqual(restored.runtime_context.strategy_evidence_prefetch.evidence.ranking.candidates, candidates.slice(0, 10));
assert(JSON.stringify(output).length < JSON.stringify(restored).length);
const recovered = materializeHostEvidence({
  ...delta,
  runtime_context: { ...delta.runtime_context, strategy_fit_packet: { candidate_working_set_reused: true } },
}, { runtimeContext: { strategy_fit_packet: fit }, ledger: { recovery_required: true, stable_strategy_evidence: { id: "ledger-id", fingerprint: "fingerprint" } } });
assert.equal(restoreHostEvidence(recovered).runtime_context.strategy_fit_packet.candidate_working_set, undefined,
  "even recovery flags must not silently reintroduce sourceFit; existing query recovery owns expansion");
assert.equal(recovered.runtime_context.host_evidence_materialization.ledger_identity, "ledger-id");
const damaged = structuredClone(output);
damaged.runtime_context.strategy_fit_packet.candidate_working_set[0].top4_rate = 0.1;
assert.throws(() => restoreHostEvidence(damaged), /identity_mismatch/);
const choice = materializeHostEvidence({
  ...delta, mode: "augment_choice",
  choices: { stage_round: "3-2", candidates: [{ name: "A" }, { name: "B" }, { name: "C" }] },
  response_contract_ref: {},
  runtime_context: { ...delta.runtime_context, strategic_obligation: { stage_round: "2-2" } },
}, { runtimeContext: { strategy_fit_packet: { ...fit, strategic_obligation: { stage_round: "2-2" }, strategic_checkpoint: { required_decisions: ["old-2-2-delivery"] } } } });
assert(!JSON.stringify(choice).includes("old-2-2-delivery"));
assert(!JSON.stringify(choice).includes('"strategic_obligation"'));
assert.deepEqual(restoreHostEvidence(choice).choices.candidates, [{ name: "A" }, { name: "B" }, { name: "C" }]);
assert.deepEqual(restoreHostEvidence(choice).runtime_context.strategy_fit_packet.candidate_working_set[0].canonical_variant.main_carry, candidates[0].canonical_variant.main_carry);
assert.deepEqual(restoreHostEvidence(choice).runtime_context.strategy_fit_packet.candidate_working_set[0].canonical_variant.primary_tank, candidates[0].canonical_variant.primary_tank);
assert.throws(() => materializeHostEvidence({ ...delta, request_kind: "hard_data_query" }), /task_source_policy_ranking_evidence_forbidden/);
const core = materializeHostEvidence({ mode: "cruise", request_kind: "hard_data_query", runtime_context: { decision_math_context: { operation: "core-calculation" } } }, { runtimeContext: { strategy_fit_packet: fit } });
assert(!JSON.stringify(core).includes("candidate-0"), "source recovery must not reintroduce Ranking into Core-only");
assert.throws(() => materializeHostEvidence({ mode: "cruise", runtime_context: { strategy_fit_packet: { candidate_working_set_reused: true } } }), /requires_current_turn_rebuild/);
const partial = { candidate_id: candidates[0].candidate_id, selected_variant_id: candidates[0].selected_variant_id, canonical_variant: candidates[0].canonical_variant };
const partialOutput = materializeHostEvidence({ ...delta, selected_ranking_candidates: { candidates: [partial] } }, { runtimeContext: { strategy_fit_packet: fit } });
assert.deepEqual(restoreHostEvidence(partialOutput).selected_ranking_candidates.candidates[0], partial);
assert.equal(partialOutput.selected_ranking_candidates.candidates[0].candidate_id, partial.candidate_id,
  "non-identical candidate shapes remain materialized, with lossless child references");
const refs = materializeHostEvidence({ ...delta, selected_ranking_candidates: { candidate_refs: [{ candidate_id: "candidate-0", selected_variant_id: "variant-0" }] } }, { runtimeContext: { strategy_fit_packet: fit } });
assert.equal(restoreHostEvidence(refs).selected_ranking_candidates.candidate_refs[0].candidate_id, "candidate-0");
for (const [choiceStage, checkpoint] of [["2-1", "2-2"], ["3-2", "3-3"], ["4-2", "4-3"]]) {
  const obligation = { stage_round: checkpoint, required_decisions: ["lineup_direction"] };
  const combined = materializeHostEvidence({ mode: "augment_choice", choices: { stage_round: choiceStage },
    response_contract_ref: { candidate_refs: obligation }, runtime_context: { strategic_obligation: obligation } });
  const restoredCombined = restoreHostEvidence(combined);
  assert.deepEqual(restoredCombined.response_contract_ref.candidate_refs, obligation);
  assert.deepEqual(restoredCombined.runtime_context.strategic_obligation, obligation);
}
const reused = materializeHostEvidence({ mode: "cruise", runtime_context: { strategy_fit_packet: { candidate_working_set_reused: true } } },
  { runtimeContext: { strategy_fit_packet: fit }, ledger: { stable_strategy_evidence: { id: "ledger", fingerprint: "same", candidate_content_fingerprints: candidates.slice(0, 10) } } });
assert.equal(reused.runtime_context.strategy_fit_packet.candidate_working_set, undefined);
assert(!JSON.stringify(reused).includes("unit-0-0"), "normal ledger reuse must not reintroduce source bodies");
const coreTheory = { mode: "cruise", request_kind: "hard_data_query", runtime_context: { decision_math_context: { candidate_working_set: [{ id: "theory", roster: ["core-unit"] }] } } };
assert.deepEqual(restoreHostEvidence(materializeHostEvidence(coreTheory)).runtime_context.decision_math_context, coreTheory.runtime_context.decision_math_context);
const popular = materializeHostEvidence({ mode: "cruise", request_kind: "popular_recipe_query", evidence_policy_id: "popular_recipe_catalog_only", runtime_context: {} }, { runtimeContext: { strategy_fit_packet: fit } });
assert(!JSON.stringify(popular).includes("candidate-0"));

const evidenceVariants = [
  {
    ...candidates[0],
    candidate_evidence_id: "evidence-shared",
    selected_variant_id: "baseline",
    mature_recipe_variants: Array.from({ length: 6 }, (_, index) => ({ variant_id: `retained-${index}`, roster: ["retained-unit"] })),
    mature_recipe_variant_receipt: { source_count: 128, retained_count: 6, truncated: true },
    archive: { raw_rows: Array.from({ length: 128 }, (_, index) => ({ index, payload: "unbounded" })) },
  },
  {
    ...candidates[0],
    candidate_evidence_id: "evidence-shared",
    selected_variant_id: "alternate",
    canonical_variant: { ...candidates[0].canonical_variant, variant_id: "alternate", atomic_variant_difference: { added_units: ["alternate-unit"] } },
    top4_rate: 0.73,
  },
  { ...candidates[1], candidate_evidence_id: "evidence-distinct" },
];
const evidenceDelta = {
  request_id: "evidence-id-boundary",
  mode: "cruise",
  runtime_context: { strategy_fit_packet: { candidate_working_set: evidenceVariants },
    strategy_evidence_prefetch: { evidence: { ranking: { candidates: structuredClone(evidenceVariants) } } },
    strategy_evidence_coverage: { receipts: [{ facet_id: "ranking_lineup_candidates", evidence_keys: ["ranking"] }] } },
  selected_ranking_candidates: { candidates: structuredClone(evidenceVariants).reverse() },
};
const evidenceOutput = materializeHostEvidence(evidenceDelta, { runtimeContext: { strategy_fit_packet: { candidate_working_set: evidenceVariants } } });
const evidenceRestored = restoreHostEvidence(evidenceOutput);
const materializedRows = evidenceRestored.runtime_context.strategy_fit_packet.candidate_working_set;
assert.equal(materializedRows.length, 2, "one complete materialization is emitted per candidate_evidence_id");
assert.equal(evidenceOutput.runtime_context.host_evidence_materialization.agent_candidate_count, 2);
assert.equal(materializedRows[0].canonical_variant.lineup_names.length, 8, "canonical roster remains complete");
assert.equal(materializedRows[0].top4_rate, 0.72, "metrics remain attached to the materialized candidate");
assert.equal(materializedRows[0].host_evidence_archive_receipts.length, 1);
assert.deepEqual(materializedRows[0].mature_recipe_variants, evidenceVariants[0].mature_recipe_variants);
assert.deepEqual(materializedRows[0].mature_recipe_variant_receipt, evidenceVariants[0].mature_recipe_variant_receipt);
assert.equal(materializedRows[0].host_evidence_archive_receipts[0].status, "omitted_from_host_turn");
assert.match(materializedRows[0].host_evidence_archive_receipts[0].content_ref, /^sha256:/);
assert(!JSON.stringify(evidenceOutput).includes("unbounded"), "raw mature variants and archives are not copied");
assert.equal(evidenceOutput.selected_ranking_candidates.candidates[1].schema, "jcc-host-evidence-address-reference-v1",
  "a different variant shape with the same evidence id references the canonical materialization");
assert.deepEqual(evidenceRestored.selected_ranking_candidates.candidates[1], materializedRows[0]);
assert.deepEqual(materializedRows[0].canonical_variant.atomic_variant_difference, undefined,
  "the selected full materialization does not merge a second variant");
console.log(JSON.stringify({ bad_scenario: "3-2 choices referencing 2-2 without delivery obligations", payload_bytes: Buffer.byteLength(JSON.stringify(choice)), restored_bytes: Buffer.byteLength(JSON.stringify(restoreHostEvidence(choice))), core_only_bytes: Buffer.byteLength(JSON.stringify(core)) }));
console.log(JSON.stringify({ ok: true, checked: ["64_search_10_agent_3_display", "complete_roster_fields_restored", "cross_path_deduplication", "ledger_reuse_without_reinjection_even_during_recovery", "explicit_combined_choice_checkpoint_contract_preserved", "core_theory_candidates_allowed", "popular_recipe_source_isolation", "reference_hash_validation", "input_immutable"] }));

const ledger = { stable_strategy_evidence: { fingerprint: "known", candidate_content_fingerprints: candidates.slice(0, 10).map(c => ({ candidate_id: c.candidate_id, selected_variant_id: c.selected_variant_id })) } };
const ledgerDelta = structuredClone(delta);
ledgerDelta.runtime_context.strategy_fit_packet = { candidate_working_set_reused: true };
const ledgerOutput = materializeHostEvidence(ledgerDelta, { runtimeContext: { strategy_fit_packet: fit }, ledger });
assert.equal(JSON.stringify(ledgerOutput).includes("unit-0-0"), false, "prefetch cannot replay complete bodies on trusted reuse");
const staleChoiceDelta = structuredClone(delta);
staleChoiceDelta.mode = "augment_choice";
staleChoiceDelta.runtime_context.strategy_evidence_prefetch.evidence.fit.strategic_obligation = { required_decisions: ["stale-2-2"] };
staleChoiceDelta.runtime_context.strategy_evidence_prefetch.evidence.fit.next_coach_plan = { required_decisions: ["stale-2-2"] };
assert.equal(JSON.stringify(materializeHostEvidence(staleChoiceDelta)).includes("stale-2-2"), false);
const { compactHostTurnDelta } = await import("../ui/electron/runtime-service.js");
const fullTransition = { ...candidates[0], transition_populations: [4, 5, 6, 7, 8], transition_steps: ["a", "b", "c", "d", "e"] };
const actual = compactHostTurnDelta({ request_id: "actual", mode: "cruise", user_message: "compare", runtime_context: {
  strategy_fit_packet: { schema: "jcc-strategy-fit-packet-v1", candidate_working_set: [fullTransition] },
} }, { capsule_id: "capsule", fingerprint: "test" });
const full = restoreHostEvidence(actual).runtime_context.strategy_fit_packet.candidate_working_set[0];
assert.deepEqual(full.transition_populations, fullTransition.transition_populations);
assert.deepEqual(full.transition_steps, fullTransition.transition_steps);
const coreAugments = { operation: "evaluate_augment_effect_choices", executable: true, candidates: [{ id: "augment-a", effect: { gold: 27, level: 9 } }] };
const coreAugmentRequest = { request_id: "core-augment", mode: "cruise", request_kind: "hard_data_query", origin_action_id: "cruise_no_big_data", evidence_policy_id: "active_core_profile_only", runtime_context: {
  decision_math_context: coreAugments,
  strategy_evidence_prefetch: { evidence: { augments: coreAugments } },
  strategy_evidence_coverage: { receipts: [{ facet_id: "augment_effects_and_fit", evidence_keys: ["augments"] }] },
} };
const coreAugmentDelta = restoreHostEvidence(compactHostTurnDelta(coreAugmentRequest, { capsule_id: "core", fingerprint: "core" }));
assert.deepEqual(coreAugmentDelta.runtime_context.strategy_evidence_prefetch.evidence.augments.candidates, coreAugments.candidates);
const frontierRequest = structuredClone(delta);
frontierRequest.runtime_context.strategy_evidence_prefetch.evidence.frontier = candidates.slice(0, 12);
frontierRequest.runtime_context.strategy_evidence_coverage.receipts.push({ facet_id: "candidate_frontier", source_domain: "ranking", evidence_keys: ["frontier"] });
const frontierDelta = restoreHostEvidence(compactHostTurnDelta(frontierRequest, { capsule_id: "frontier", fingerprint: "frontier" }));
assert.equal(frontierDelta.runtime_context.strategy_evidence_prefetch.evidence.frontier.length,
  frontierDelta.runtime_context.strategy_fit_packet.candidate_working_set.length);
const coreFrontier = structuredClone(coreAugmentRequest);
coreFrontier.runtime_context.strategy_evidence_prefetch.evidence.frontier = [{ id: "core-theory", roster: ["core-unit"] }];
coreFrontier.runtime_context.strategy_evidence_coverage.receipts.push({ facet_id: "candidate_frontier", source_domain: "core", evidence_keys: ["frontier"] });
assert.deepEqual(restoreHostEvidence(compactHostTurnDelta(coreFrontier, { capsule_id: "core", fingerprint: "core" })).runtime_context.strategy_evidence_prefetch.evidence.frontier,
  coreFrontier.runtime_context.strategy_evidence_prefetch.evidence.frontier);

const refSchema = "jcc-host-evidence-address-reference-v1";
const repeatedFrontier = structuredClone(delta);
repeatedFrontier.runtime_context.strategy_evidence_prefetch.evidence = {
  one: [structuredClone(candidates[0])], two: [structuredClone(candidates[0])],
};
repeatedFrontier.runtime_context.strategy_evidence_coverage.receipts = [{
  facet_id: "candidate_frontier", source_domain: "ranking", evidence_keys: ["one", "two"],
}];
const repeatedFrontierOutput = materializeHostEvidence(repeatedFrontier);
const repeatedFrontierRestored = restoreHostEvidence(JSON.parse(JSON.stringify(repeatedFrontierOutput)));
for (const key of ["one", "two"]) {
  assert.deepEqual(repeatedFrontierRestored.runtime_context.strategy_evidence_prefetch.evidence[key], [candidates[0]],
    "pre-generated frontier references must not give their parent an encoded-only original hash");
}
const sharedFit = structuredClone(fit);
const sharedFitInput = { mode: "cruise", runtime_context: {
  strategy_fit_packet: sharedFit, cruise_decision_context: { strategy_fit_packet: sharedFit },
  strategy_evidence_prefetch: { evidence: { shared: sharedFit } },
} };
const sharedFitOutput = materializeHostEvidence(sharedFitInput);
const sharedFitRestored = restoreHostEvidence(JSON.parse(JSON.stringify(sharedFitOutput)));
for (const container of [sharedFitRestored.runtime_context.strategy_fit_packet,
  sharedFitRestored.runtime_context.cruise_decision_context.strategy_fit_packet,
  sharedFitRestored.runtime_context.strategy_evidence_prefetch.evidence.shared]) {
  assert.deepEqual(container.candidate_working_set, candidates.slice(0, 10),
    "encoding a shared fit at another path must not overwrite the original materialized targets");
}
assert.deepEqual(sharedFitInput.runtime_context.strategy_fit_packet, fit);
assert.deepEqual(materializeHostEvidence(sharedFitInput), sharedFitOutput, "repeated calls on the same source are deterministic");
const hash = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const shared = { positions: Array.from({ length: 40 }, (_, i) => ({ unit: `unit-${i}`, row: i % 4 })) };
const parent = { first: shared, second: structuredClone(shared), preserved: "parent" };
const nestedInput = { mode: "cruise", runtime_context: {
  match_facts: { choice_confirmations: parent },
  strategy_evidence_prefetch: { evidence: {
    duplicate: structuredClone(parent),
    later: { "escaped/key~": structuredClone(shared), different: { ...shared, extra: "do-not-merge" } },
  } },
} };
const nestedBefore = structuredClone(nestedInput);
const nestedOutput = materializeHostEvidence(nestedInput);
const nestedWire = JSON.parse(JSON.stringify(nestedOutput));
const nestedRestored = restoreHostEvidence(nestedWire);
delete nestedRestored.runtime_context.host_evidence_materialization;
assert.deepEqual(nestedRestored, nestedInput, "recursive restoration must preserve every nested field and array");
assert.deepEqual(nestedInput, nestedBefore, "nested encoding cannot mutate source evidence");
const duplicate = nestedWire.runtime_context.strategy_evidence_prefetch.evidence.duplicate;
assert.equal(duplicate.schema, refSchema);
assert.equal(duplicate.evidence_identity, hash(parent), "parent identity hashes the original, not the encoded children");
assert.equal(duplicate.encoded_evidence_identity, hash(nestedWire.runtime_context.match_facts.choice_confirmations));
assert.equal(nestedWire.runtime_context.match_facts.choice_confirmations.second.schema, refSchema);
assert.equal(nestedWire.runtime_context.strategy_evidence_prefetch.evidence.later["escaped/key~"].address,
  "/runtime_context/match_facts/choice_confirmations/first", "skipped parent descendants must not hide a later reference target");
const originalHashDamage = structuredClone(nestedWire);
originalHashDamage.runtime_context.strategy_evidence_prefetch.evidence.duplicate.evidence_identity = hash({ wrong: true });
assert.throws(() => restoreHostEvidence(originalHashDamage), /identity_mismatch/);
const encodedHashDamage = structuredClone(nestedWire);
encodedHashDamage.runtime_context.strategy_evidence_prefetch.evidence.duplicate.encoded_evidence_identity = hash(parent);
assert.throws(() => restoreHostEvidence(encodedHashDamage), /encoded_identity_mismatch/);
const childDamage = structuredClone(nestedWire);
childDamage.runtime_context.match_facts.choice_confirmations.second.evidence_identity = hash({ wrong: true });
assert.throws(() => restoreHostEvidence(childDamage), /identity_mismatch/);
const ref = address => ({ schema: refSchema, address, evidence_identity: hash({}) });
assert.throws(() => restoreHostEvidence({ a: { child: ref("/a") } }), /invalid_or_cyclic/);
assert.throws(() => restoreHostEvidence({ a: { child: ref("/b") }, b: { child: ref("/a") } }), /invalid_or_cyclic/);
assert.throws(() => restoreHostEvidence({ a: ref("/missing") }), /reference_missing/);
assert.throws(() => restoreHostEvidence({ a: ref("/b"), b: ref("/a") }), /target_must_be_materialized/);
const nestedCandidate = { ...candidates[0], formation_profile: shared,
  canonical_variant: { ...candidates[0].canonical_variant, formation_profile: shared,
    mature_recipe_variants: [{ id: "sibling-a", data: shared }, { id: "sibling-b", data: shared }] } };
const nestedRequest = { request_id: "nested-compact", mode: "cruise", runtime_context: {
  strategy_fit_packet: { candidate_working_set: [nestedCandidate] },
}, selected_ranking_candidates: { candidates: [nestedCandidate] } };
const nestedCompact = compactHostTurnDelta(nestedRequest, { capsule_id: "nested", fingerprint: "nested" });
const compactRestored = restoreHostEvidence(JSON.parse(JSON.stringify(nestedCompact)));
const nestedDirect = restoreHostEvidence(materializeHostEvidence(nestedRequest));
assert.deepEqual(nestedDirect.runtime_context.strategy_fit_packet.candidate_working_set[0], nestedCandidate);
assert.deepEqual(nestedDirect.selected_ranking_candidates.candidates[0], nestedCandidate);
for (const row of [compactRestored.runtime_context.strategy_fit_packet.candidate_working_set[0]]) {
  assert.deepEqual(row.canonical_variant, nestedCandidate.canonical_variant);
  assert.deepEqual(row.formation_profile, nestedCandidate.formation_profile);
  assert.equal(row.candidate_id, nestedCandidate.candidate_id);
  assert.equal(row.selected_variant_id, nestedCandidate.selected_variant_id);
  assert.equal(row.top4_rate, nestedCandidate.top4_rate);
}
console.log(JSON.stringify({ ok: true, checked: ["nested_duplicate_objects_and_arrays", "deep_roundtrip_equality",
  "original_and_encoded_parent_hashes", "child_hash_tampering_rejected", "cycles_rejected", "missing_target_rejected",
  "hidden_parent_targets_not_registered", "compact_entry_preserves_all_siblings"] }));
