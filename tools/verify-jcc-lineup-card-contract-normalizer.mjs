import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertLineupPinnedResultSchema,
  buildLineupPinnedResultCanonicalOutputSchema,
  buildLineupPinnedResultInstructions,
  lineupPinnedResultAtomicRosterDiagnostics,
  lineupPinnedResultIsPublishable,
  lineupPinnedResultSchemaDiagnostics,
  normalizeLineupPinnedResult,
  queryAtomicLineupEvidence,
} from "../ui/electron/lineup-card-contract.js";

const championNames = [
  "Unit1",
  "Unit2",
  "Unit3",
  "Unit4",
  "Unit5",
  "Unit6",
  "Unit7",
  "Unit8",
  "Unit9",
  "Unit10",
];

const hostRequest = {
  mode: "lineup_card",
  user_message: "final capped lineup card",
  season_catalog: { champion_names: championNames },
};

function units(count) {
  return Array.from({ length: count }, (_, index) => ({
    row: Math.floor(index / 7) + 1,
    col: (index % 7) + 1,
    name: championNames[index],
    ...(index === 0 ? { items: ["ItemA", "ItemB", "ItemC"] } : {}),
  }));
}

const legacyMoves = normalizeLineupPinnedResult({
  schema: "jcc-internal-lineup-plan-v1",
  slot: "target",
  title: "Legacy move migration",
  units: units(7),
  recommended_moves: ["Level to 8 on 4-2 and add Unit8."],
});

assert.deepEqual(
  legacyMoves.recommended_moves,
  [{ description: "Level to 8 on 4-2 and add Unit8." }],
  "legacy recommended_moves:string[] must normalize into canonical object moves",
);
assert.deepEqual(
  legacyMoves.moves,
  ["Level to 8 on 4-2 and add Unit8."],
  "legacy recommended_moves:string[] must survive in renderable moves:string[]",
);
assert(lineupPinnedResultIsPublishable(legacyMoves, hostRequest), "legacy migrated lineup must remain publishable");

const canonical = normalizeLineupPinnedResult({
  schema: "jcc-internal-lineup-plan-v1",
  slot: "lineup",
  title: "Custom 10-pop cap",
  summary: "Uses non-default row/col positioning.",
  units: [
    { row: 4, col: 7, name: "Unit1", items: ["CarryItem1", "CarryItem2", "CarryItem3"], notes: "far right carry" },
    { row: 1, col: 1, name: "Unit2", items: ["TankItem"] },
    { row: 1, col: 4, name: "Unit3" },
    { row: 2, col: 2, name: "Unit4" },
    { row: 2, col: 6, name: "Unit5" },
    { row: 3, col: 1, name: "Unit6" },
    { row: 3, col: 7, name: "Unit7" },
    { row: 4, col: 1, name: "Unit8" },
    { row: 4, col: 3, name: "Unit9" },
    { row: 4, col: 5, name: "Unit10" },
  ],
  recommended_moves: [
    { unit: "Unit1", from: "row 4 col 5", to: "row 4 col 7", reason: "custom anti-clump positioning" },
  ],
  nodes: [
    { label: "Level 7 transition", level: 7, timing: "3-5", units: units(7), recommended_moves: ["Stabilize on 7."] },
    { label: "Level 8 node", level: 8, timing: "4-2", units: units(8), moves: ["Add Unit8."] },
    { label: "Level 9 node", level: 9, timing: "5-1", units: units(9), recommended_moves: [{ action: "Add Unit9" }] },
    { label: "Level 10 cap", level: 10, timing: "6-1", units: units(10), recommended_moves: [{ action: "Add Unit10" }] },
  ],
});

assert.equal(canonical.schema, "jcc-internal-lineup-plan-v1");
assert.equal(canonical.units.length, 10, "10-pop custom board must normalize");
assert.equal(canonical.units[0].row, 4, "custom row must be preserved");
assert.equal(canonical.units[0].col, 7, "custom col must be preserved");
assert.deepEqual(canonical.units[0].items, ["CarryItem1", "CarryItem2", "CarryItem3"], "unit equipment must be preserved");
assert.equal(typeof canonical.recommended_moves[0], "object", "canonical recommended_moves must be object[]");
assert(canonical.moves[0].includes("Unit1 row 4 col 5 -> row 4 col 7"), "structured moves must derive renderable moves:string[]");
assert.deepEqual(canonical.nodes.map((node) => node.level), [7, 8, 9, 10], "transition/node populations 7/8/9/10 must normalize");
assert.deepEqual(canonical.nodes.map((node) => node.units.length), [7, 8, 9, 10], "node units must preserve population counts");
assert.equal(canonical.nodes[0].recommended_moves[0].description, "Stabilize on 7.", "node legacy moves must normalize too");
assert(lineupPinnedResultIsPublishable(canonical, hostRequest), "canonical 10-pop lineup must be publishable");

const diagnostics = lineupPinnedResultSchemaDiagnostics({
  schema: "jcc-internal-lineup-plan-v1",
  units: [
    { row: 0, col: 1, name: "Unit1" },
    { row: 1, col: 1, name: "MissingFromCatalog" },
    { row: 1, col: 1, name: "Unit2", items: ["Tank", "", "Third", "Fourth"] },
  ],
  recommended_moves: [{}],
  moves: [""],
  nodes: [null],
}, hostRequest);

for (const expected of [
  "units[0].row must be an integer from 1 to 4",
  "units[2] duplicates board coordinate 1:1",
  "units[1].name is absent from current season catalog: MissingFromCatalog",
  "units[2].items[1] must be a non-empty item name",
  "units[2].items must contain at most 3 items",
  "recommended_moves[0] must include action, description, unit/from/to, or reason",
  "moves[0] must be a non-empty string",
  "nodes[0] must be an object",
]) {
  assert(diagnostics.includes(expected), `missing precise diagnostic: ${expected}`);
}
assert.throws(
  () => assertLineupPinnedResultSchema({ units: [{ row: 5, col: 1, name: "Unit1" }] }, hostRequest),
  /units\[0\]\.row must be an integer from 1 to 4/,
  "assert helper must throw precise field diagnostics",
);

assert.equal(normalizeLineupPinnedResult({ final_text: "Unit1 Unit2 Unit3 Unit4 Unit5 Unit6 Unit7" }), null, "must not infer pseudo lineup card from pure final_text");

const outputSchema = buildLineupPinnedResultCanonicalOutputSchema();
assert.equal(outputSchema.schema, "jcc-internal-lineup-plan-v1", "runtime prompt schema builder must expose canonical schema");
assert(outputSchema.required.includes("recommended_moves"), "runtime prompt schema must require canonical recommended_moves");
assert(buildLineupPinnedResultInstructions().includes("Runtime materializes those deterministic fields"),
  "runtime prompt instruction builder must keep deterministic card fields out of the Agent handoff");

function finalTargetHost(candidateContext) {
  return {
    ...hostRequest,
    lineup_card_intent: "final_target",
    ...candidateContext,
  };
}

function finalTargetCard(roster, candidateId, { nestedCandidateId = false, variantId = `${candidateId}-variant` } = {}) {
  return normalizeLineupPinnedResult({
    schema: "jcc-internal-lineup-plan-v1",
    slot: "lineup",
    title: "Atomic final target",
    ...(nestedCandidateId ? {} : { candidate_id: candidateId }),
    selected_variant_id: variantId,
    units: roster.map((name, index) => ({ row: Math.floor(index / 7) + 1, col: (index % 7) + 1, name })),
    moves: ["Build the selected complete target."],
    equipment_status: "not_provided_in_evidence",
    strategy: {
      ...(nestedCandidateId ? { candidate_id: candidateId } : {}),
      selected_variant_id: variantId,
      main_carry: roster[0],
      main_tank: roster[1],
      core_traits: "Atomic trait",
      formation_burden: "medium",
      cap: "complete cap",
      floor: "stable floor",
    },
  });
}

const atomicRoster = championNames.slice(0, 8);
const rootShapeCandidates = [
  { candidate_id: "root-core-units", selected_variant_id: "root-core-units-variant", core_units: atomicRoster.map((name) => ({ champion_name: name })) },
  { candidate_id: "root-core-names", selected_variant_id: "root-core-names-variant", core_unit_names: atomicRoster },
  { candidate_id: "root-atomic-members", selected_variant_id: "root-atomic-members-variant", atomic_roster_members: atomicRoster.map((name) => ({ name })) },
  { candidate_id: "root-canonical", selected_variant_id: "root-canonical-variant", canonical_variant: { lineup_names: atomicRoster } },
  { candidate_id: "root-champion-names", selected_variant_id: "root-champion-names-variant", champion_names: atomicRoster },
];
for (const candidate of rootShapeCandidates) {
  const card = finalTargetCard(atomicRoster, candidate.candidate_id);
  const atomicHost = finalTargetHost({ selected_ranking_candidates: [candidate] });
  assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(card, atomicHost), [], `${candidate.candidate_id} must expose its atomic roster`);
  assert(lineupPinnedResultIsPublishable(card, atomicHost), `${candidate.candidate_id} must publish with its exact complete roster`);
}

const nestedCandidateCard = finalTargetCard(atomicRoster, "nested-strategy-candidate", { nestedCandidateId: true });
assert.equal(nestedCandidateCard.candidate_id, "nested-strategy-candidate", "nested strategy candidate_id must promote to the normalized card identity");
assert.equal(nestedCandidateCard.strategy.candidate_id, "nested-strategy-candidate", "nested strategy candidate_id must remain available in strategy metadata");

const mappedReferenceHost = finalTargetHost({
  selected_ranking_candidates: [{ candidate_id: "mapped-candidate" }],
  runtime_context: {
    strategy_fit_packet: {
      candidate_lines: [{ candidate_id: "mapped-candidate" }],
      candidate_working_set: [{
        line_id: "mapped-candidate",
        selected_variant_id: "mapped-candidate-variant",
        canonical_variant: { atomic_roster_members: atomicRoster.map((name) => ({ champion_name: name })) },
      }],
    },
  },
});
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster, "mapped-candidate"), mappedReferenceHost),
  [],
  "a selected candidate reference must resolve to its complete strategy_fit_packet working-set candidate",
);

const selectedVariantHost = finalTargetHost({
  selected_ranking_candidates: [{
    candidate_id: "selected-sibling-variant",
    selected_variant_id: "variant-b",
    population: 7,
    atomic_roster_members: atomicRoster.slice(0, 7).map((name) => ({ champion_name: name })),
    canonical_variant: {
      variant_id: "variant-a",
      population: 7,
      atomic_roster_members: atomicRoster.slice(0, 7).map((name) => ({ champion_name: name })),
    },
    variants: [
      { variant_id: "variant-a", population: 7, lineup_names: atomicRoster.slice(0, 7) },
      { variant_id: "variant-b", population: 8, lineup_names: atomicRoster },
    ],
  }],
});
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster, "selected-sibling-variant", { variantId: "variant-b" }), selectedVariantHost),
  [],
  "selected_variant_id must override conflicting root and canonical default-roster evidence",
);

const repeatedCandidateIdHost = finalTargetHost({
  selected_ranking_candidates: [
    {
      candidate_id: "shared-candidate",
      selected_variant_id: "shared-candidate-roster-1",
      population: 7,
      atomic_roster_members: atomicRoster.slice(0, 7).map((name) => ({ champion_name: name })),
    },
    {
      candidate_id: "shared-candidate",
      selected_variant_id: "shared-candidate-roster-3",
      population: 8,
      atomic_roster_members: atomicRoster.map((name) => ({ champion_name: name })),
    },
  ],
});
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster, "shared-candidate", {
    variantId: "shared-candidate-roster-3",
  }), repeatedCandidateIdHost),
  [],
  "candidate_id plus selected_variant_id must resolve the exact roster when several atomic rows share one candidate id",
);

const rankingDefault = repeatedCandidateIdHost.selected_ranking_candidates[0];
const workingSetCandidate = repeatedCandidateIdHost.selected_ranking_candidates[1];
const crossContainerHost = finalTargetHost({
  selected_ranking_candidates: { candidates: [rankingDefault] },
  runtime_context: {
    strategy_fit_packet: { candidate_working_set: [workingSetCandidate] },
  },
});
const workingSetCard = finalTargetCard(atomicRoster, "shared-candidate", {
  variantId: workingSetCandidate.selected_variant_id,
});
const rankingDefaultCard = finalTargetCard(atomicRoster.slice(0, 7), "shared-candidate", {
  variantId: rankingDefault.selected_variant_id,
});
const projectedCrossContainerHost = {
  ...crossContainerHost,
  selected_ranking_candidates: {
    candidate_refs: [{
      candidate_id: workingSetCandidate.candidate_id,
      selected_variant_id: workingSetCandidate.selected_variant_id,
    }],
  },
};
for (const request of [crossContainerHost, projectedCrossContainerHost]) {
  assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(workingSetCard, request), [],
    "the exact working-set variant must validate in both full and projected requests");
  assert.equal(lineupPinnedResultIsPublishable(workingSetCard, request), true);
  for (const variantId of [rankingDefault.selected_variant_id, "shared-candidate-roster-99"]) {
    const card = finalTargetCard(atomicRoster, "shared-candidate", { variantId });
    assert.match(lineupPinnedResultAtomicRosterDiagnostics(card, request).join("; "), /selected_variant_id mismatch/,
      "a Ranking-only or unknown variant must not bypass the authoritative working set");
    assert.equal(lineupPinnedResultIsPublishable(card, request), false);
  }
  for (const roster of [atomicRoster.slice(0, 7), [...atomicRoster.slice(0, 7), "ForeignUnit"]]) {
    const card = finalTargetCard(roster, "shared-candidate", {
      variantId: workingSetCandidate.selected_variant_id,
    });
    assert.match(lineupPinnedResultAtomicRosterDiagnostics(card, request).join("; "), /atomic roster mismatch/);
    assert.equal(lineupPinnedResultIsPublishable(card, request), false);
  }
  const foreignCandidateCard = { ...workingSetCard, candidate_id: "foreign-candidate" };
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(foreignCandidateCard, request).join("; "), /atomic candidate roster identity/);
  assert.equal(lineupPinnedResultIsPublishable(foreignCandidateCard, request), false);
}
const rankingFallbackHost = finalTargetHost({ selected_ranking_candidates: { candidates: [rankingDefault] } });
const productionRoles = {
  main_carry: { champion_id: "5454", champion_name: "艾希", item_names: ["朔极之矛", "红霸符", "地狱火纹章"], item_ids: ["2004", "2009", "41806"] },
  primary_tank: { champion_id: "4503", champion_name: "阿木木", item_names: ["石像鬼石板甲", "狂徒铠甲"], item_ids: ["2028", "2034"] },
};
if (process.env.JCC_LINEUP_REPLAY_FILE) {
  const { normalizeHostCoachResponse } = await import("../ui/electron/runtime-service.js");
  const captures = JSON.parse(readFileSync(process.env.JCC_LINEUP_REPLAY_FILE, "utf8"));
  for (const { request, response } of captures) {
    const before = structuredClone({ request, response });
    const normalized = normalizeHostCoachResponse(response, request);
    assert.equal(normalized.final_text, response.final_text);
    assert.deepEqual(normalized.pinned_result.units.map(unit => unit.name), response.pinned_result.units.map(unit => unit.name));
    assert.deepEqual({ request, response }, before, "real replay must not alter captured evidence or Host text");
    for (const role of ["main_carry", "main_tank"]) {
      const invalid = structuredClone(response);
      invalid.pinned_result.strategy[role] = "WrongRole";
      assert.throws(() => normalizeHostCoachResponse(invalid, request), /main (carry|tank) mismatch/);
    }
  }
  console.log(JSON.stringify({ replayed_responses: captures.length, original_text_preserved: true, wrong_roles_rejected: true }));
}
const splitVariantCandidate = { candidate_id: "A", selected_variant_id: "variant2",
  canonical_variant: { variant_id: "variant1", population: 1, lineup_names: ["UnitA"] },
  variants: [{ variant_id: "variant2", population: 1, lineup_names: ["UnitB"] }] };
const splitVariantHost = { lineup_card_intent: "final_target", runtime_context: { strategy_fit_packet: { candidate_working_set: [splitVariantCandidate] } } };
assert.equal(queryAtomicLineupEvidence(splitVariantHost, { candidate_id: "A", selected_variant_id: "variant1" }).status, "not_found",
  "a canonical alias cannot authorize the different resolved selected snapshot");
const resolvedVariant = queryAtomicLineupEvidence(splitVariantHost, { candidate_id: "A", selected_variant_id: "variant2" });
assert.equal(resolvedVariant.status, "ok");
assert.equal(resolvedVariant.selected_variant_id, "variant2");
assert.deepEqual(resolvedVariant.roster, ["UnitB"]);
assert.deepEqual(resolvedVariant.canonical_variant, splitVariantCandidate.variants[0]);
const sharedCanonicalRowsHost = { lineup_card_intent: "final_target", runtime_context: { strategy_fit_packet: {
  candidate_working_set: [
    { ...splitVariantCandidate, selected_variant_id: "variant1" },
    structuredClone(splitVariantCandidate),
  ],
} } };
for (const [variantId, roster] of [["variant1", ["UnitA"]], ["variant2", ["UnitB"]]]) {
  const queried = queryAtomicLineupEvidence(sharedCanonicalRowsHost, { candidate_id: "A", selected_variant_id: variantId });
  assert.equal(queried.status, "ok", "working-set rows sharing a canonical alias must remain distinct and unambiguous");
  assert.equal(queried.selected_variant_id, variantId);
  assert.deepEqual(queried.roster, roster);
  assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(roster, "A", { variantId }), sharedCanonicalRowsHost), []);
}
assert.equal(queryAtomicLineupEvidence(sharedCanonicalRowsHost, { candidate_id: "A" }).status, "ambiguous");
const unrelatedRolesHost = structuredClone(splitVariantHost);
Object.assign(unrelatedRolesHost.runtime_context.strategy_fit_packet.candidate_working_set[0], {
  main_carry: "UnitA", primary_tank: "UnitA",
});
const isolatedRoles = queryAtomicLineupEvidence(unrelatedRolesHost, { candidate_id: "A", selected_variant_id: "variant2" });
assert.equal(isolatedRoles.main_carry, "", "selected variant cannot borrow a root role of uncertain variant provenance");
assert.equal(isolatedRoles.main_tank, "");
for (const names of [["UnitA"], ["UnitB"]]) {
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(names, "A", { variantId: "variant1" }), splitVariantHost).join("; "),
    /selected_variant_id mismatch/);
}
assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(["UnitB"], "A", { variantId: "variant2" }), splitVariantHost), []);
const specialPopulationRoster = Array.from({ length: 11 }, (_, index) => `RiftUnit${index + 1}`);
const specialPopulationCandidate = {
  candidate_id: "rift-beast-10",
  selected_variant_id: "rift-beast-10:roster:1",
  canonical_variant: {
    variant_id: "rift-beast-10:roster:1",
    population: 10,
    roster_unit_count: 11,
    occupied_population: 12,
    base_team_size: 10,
    team_size_bonus: 2,
    effective_team_size: 12,
    population_legal: true,
    lineup_names: specialPopulationRoster,
  },
};
const specialPopulationHost = {
  lineup_card_intent: "final_target",
  runtime_context: { strategy_fit_packet: { candidate_working_set: [specialPopulationCandidate] } },
};
const specialPopulationEvidence = queryAtomicLineupEvidence(specialPopulationHost, {
  candidate_id: specialPopulationCandidate.candidate_id,
  selected_variant_id: specialPopulationCandidate.selected_variant_id,
});
assert.equal(specialPopulationEvidence.status, "ok",
  "special population cost must not make a complete 11-entity roster look incomplete at base team size 10");
assert.equal(specialPopulationEvidence.population, 10);
assert.equal(specialPopulationEvidence.roster_unit_count, 11);
assert.equal(specialPopulationEvidence.occupied_population, 12);
assert.equal(specialPopulationEvidence.effective_team_size, 12);
assert.deepEqual(specialPopulationEvidence.roster, specialPopulationRoster);
assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(
  finalTargetCard(specialPopulationRoster, specialPopulationCandidate.candidate_id, {
    variantId: specialPopulationCandidate.selected_variant_id,
  }),
  specialPopulationHost,
), [], "special population roster must remain publishable as the exact canonical candidate roster");
for (const candidate of [
  { ...splitVariantCandidate, selected_variant_id: "missing-variant" },
  { ...splitVariantCandidate, variants: [{ variant_id: "variant2", population: 2, lineup_names: ["UnitB"] }],
    main_carry: "UnitA", primary_tank: "UnitA", population: 1, lineup_names: ["UnitA"] },
]) {
  const request = { lineup_card_intent: "final_target", runtime_context: { strategy_fit_packet: { candidate_working_set: [candidate] } } };
  assert.equal(queryAtomicLineupEvidence(request, { candidate_id: "A", selected_variant_id: candidate.selected_variant_id }).status, "incomplete",
    "missing or incomplete selected variants cannot borrow another variant's complete roster");
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(["UnitA"], "A", { variantId: candidate.selected_variant_id }), request).join("; "),
    /atomic candidate roster evidence/);
}
for (const roles of [productionRoles, { main_carry: "艾希", primary_tank: "阿木木" },
  { main_carry: { name: "艾希" }, main_tank: { name: "阿木木" } }]) {
  const candidate = { candidate_id: "lineup:2d47248e957f5cae5b8aede3",
    selected_variant_id: "lineup:2d47248e957f5cae5b8aede3:roster:2",
    main_carry: "WrongCarry", primary_tank: "WrongTank",
    canonical_variant: { population: atomicRoster.length, lineup_names: atomicRoster, ...roles } };
  const request = finalTargetHost({ runtime_context: { strategy_fit_packet: { candidate_working_set: [candidate] } } });
  const before = structuredClone(request);
  const result = queryAtomicLineupEvidence(request, { candidate_id: candidate.candidate_id, selected_variant_id: candidate.selected_variant_id });
  assert.equal(result.status, "ok");
  assert.equal(result.main_carry, "艾希");
  assert.equal(result.main_tank, "阿木木");
  assert.deepEqual(result.canonical_variant, candidate.canonical_variant, "role display normalization preserves complete canonical evidence");
  assert.deepEqual(request, before);
  const card = finalTargetCard(atomicRoster, candidate.candidate_id, { variantId: candidate.selected_variant_id });
  card.strategy = { ...card.strategy, main_carry: "艾希", main_tank: "阿木木" };
  assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(card, request), [], "query and validation share canonical role extraction");
  card.strategy.main_carry = "WrongCarry";
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(card, request).join("; "), /main carry mismatch/);
  card.strategy.main_carry = "艾希";
  card.strategy.main_tank = "WrongTank";
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(card, request).join("; "), /main tank mismatch/);
}
for (const request of [crossContainerHost, projectedCrossContainerHost]) {
  const queried = queryAtomicLineupEvidence(request, { candidate_id: workingSetCandidate.candidate_id });
  assert.equal(queried.status, "ok");
  assert.equal(queried.selected_variant_id, workingSetCandidate.selected_variant_id);
  assert.deepEqual(queried.roster, atomicRoster);
  assert.equal(queryAtomicLineupEvidence(request, {
    candidate_id: workingSetCandidate.candidate_id, selected_variant_id: rankingDefault.selected_variant_id,
  }).status, "not_found");
  assert.equal(queryAtomicLineupEvidence(request, {}).status, "query_required");
  assert.equal(queryAtomicLineupEvidence(request, {
    candidate_id: "wrong", entity_names: [workingSetCandidate.candidate_id],
  }).status, "not_found", "an explicit candidate selector cannot be replaced by search terms");
}
assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(rankingDefaultCard, rankingFallbackHost), [],
  "selected Ranking candidates remain usable when no working set is supplied");
assert.equal(lineupPinnedResultIsPublishable(rankingDefaultCard, rankingFallbackHost), true);
const emptyWorkingSetHost = {
  ...crossContainerHost,
  runtime_context: { strategy_fit_packet: { candidate_working_set: [], candidate_lines: [rankingDefault] } },
};
assert.match(lineupPinnedResultAtomicRosterDiagnostics(rankingDefaultCard, emptyWorkingSetHost).join("; "), /atomic candidate roster evidence is required/,
  "an explicitly empty working set must not fall back to Ranking candidates or candidate lines");
assert.equal(lineupPinnedResultIsPublishable(rankingDefaultCard, emptyWorkingSetHost), false);
assert.equal(queryAtomicLineupEvidence(emptyWorkingSetHost, { candidate_id: rankingDefault.candidate_id }).status, "not_found");
const incompleteWorkingSetHost = {
  ...crossContainerHost,
  runtime_context: { strategy_fit_packet: { candidate_working_set: [{
    candidate_id: rankingDefault.candidate_id,
    selected_variant_id: rankingDefault.selected_variant_id,
  }] } },
};
assert.match(lineupPinnedResultAtomicRosterDiagnostics(rankingDefaultCard, incompleteWorkingSetHost).join("; "), /atomic candidate roster evidence is required/,
  "incomplete working-set evidence must not be replaced by a complete Ranking candidate");
assert.equal(lineupPinnedResultIsPublishable(rankingDefaultCard, incompleteWorkingSetHost), false);

const missingRosterHost = finalTargetHost({ selected_ranking_candidates: [{ candidate_id: "missing-roster" }] });
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster, "missing-roster"), missingRosterHost),
  ["atomic candidate roster evidence is required for the selected final target candidate"],
  "a selected candidate with no roster evidence must fail closed",
);
assert.equal(lineupPinnedResultIsPublishable(finalTargetCard(atomicRoster, "missing-roster"), missingRosterHost), false);

const absentCandidateEvidenceHost = finalTargetHost({ selected_ranking_candidates: [] });
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster, "absent-candidate-evidence"), absentCandidateEvidenceHost),
  ["atomic candidate roster evidence is required for the selected final target candidate"],
  "a card-selected candidate with no supplied candidate evidence must fail closed",
);
assert.equal(lineupPinnedResultIsPublishable(finalTargetCard(atomicRoster, "absent-candidate-evidence"), absentCandidateEvidenceHost), false);

const incompletePopulationHost = finalTargetHost({
  selected_ranking_candidates: [{
    candidate_id: "incomplete-population",
    canonical_variant: { population: 8, core_unit_names: atomicRoster.slice(0, 3) },
  }],
});
assert.deepEqual(
  lineupPinnedResultAtomicRosterDiagnostics(finalTargetCard(atomicRoster.slice(0, 3), "incomplete-population"), incompletePopulationHost),
  ["atomic candidate roster evidence is required for the selected final target candidate"],
  "core-only evidence shorter than the declared atomic population must fail closed",
);

const partialBoard = finalTargetCard(atomicRoster.slice(0, 5), "root-canonical");
const completeAtomicHost = finalTargetHost({ selected_ranking_candidates: [rootShapeCandidates[3]] });
assert.match(
  lineupPinnedResultAtomicRosterDiagnostics(partialBoard, completeAtomicHost)[0],
  /atomic roster mismatch/,
  "a partial current board must not satisfy a complete selected atomic variant",
);
assert.equal(lineupPinnedResultIsPublishable(partialBoard, completeAtomicHost), false);

const semanticCandidate = {
  candidate_id: "semantic-atomic",
  selected_variant_id: "semantic-v2",
  variants: [{
    variant_id: "semantic-v2",
    population: 8,
    lineup_names: atomicRoster,
    main_carry: atomicRoster[0],
    main_tank: atomicRoster[1],
    core_traits: ["TraitA", "TraitB"],
    loadouts: [{ unit: atomicRoster[0], items: ["ItemA", "ItemB"] }],
    augment_conditions: ["AugmentA"],
    transition_path: ["If Unit8 is found, field the complete roster."],
    cap: "Canonical cap",
    floor: "Canonical floor",
  }],
};
const semanticHost = finalTargetHost({ selected_ranking_candidates: [semanticCandidate] });
const semanticCard = normalizeLineupPinnedResult({
  ...finalTargetCard(atomicRoster, "semantic-atomic", { variantId: "semantic-v2" }),
  loadouts: [{ unit: atomicRoster[0], items: ["ItemA", "ItemB"] }],
  moves: ["If Unit8 is found, field the complete roster."],
  strategy: {
    candidate_id: "semantic-atomic",
    selected_variant_id: "semantic-v2",
    main_carry: atomicRoster[0],
    main_tank: atomicRoster[1],
    core_traits: "TraitA",
    formation_burden: "medium",
    cap: "Canonical cap",
    floor: "Canonical floor",
    augment_conditions: ["AugmentA"],
    transition_path: ["If Unit8 is found, field the complete roster."],
  },
});
semanticCard.strategy.core_traits = ["TraitA", "TraitB"];
assert.deepEqual(lineupPinnedResultAtomicRosterDiagnostics(semanticCard, semanticHost), [], "the exact canonical variant semantics must publish");

for (const [label, mutate, expected] of [
  ["same candidate wrong variant", (card) => { card.selected_variant_id = "semantic-v1"; }, /selected_variant_id mismatch/],
  ["foreign main carry", (card) => { card.strategy.main_carry = atomicRoster[2]; }, /main carry mismatch/],
  ["foreign main tank", (card) => { card.strategy.main_tank = atomicRoster[3]; }, /main tank mismatch/],
  ["foreign traits", (card) => { card.strategy.core_traits = ["TraitA", "ForeignTrait"]; }, /core trait mismatch/],
  ["foreign equipment", (card) => { card.loadouts = [{ unit: atomicRoster[0], items: ["ItemA", "ForeignItem"] }]; }, /equipment mismatch/],
  ["foreign augment", (card) => { card.strategy.augment_conditions = ["ForeignAugment"]; }, /augment mismatch/],
]) {
  const malicious = structuredClone(semanticCard);
  mutate(malicious);
  assert.match(lineupPinnedResultAtomicRosterDiagnostics(malicious, semanticHost).join("; "), expected, label);
}

const mixedRosterCard = structuredClone(semanticCard);
mixedRosterCard.units[7].name = "Unit10";
assert.match(lineupPinnedResultAtomicRosterDiagnostics(mixedRosterCard, semanticHost)[0], /atomic roster mismatch/, "malicious cross-candidate roster mixing must fail");

const unconditionalMoveCard = structuredClone(semanticCard);
unconditionalMoveCard.moves = ["Move Unit1 to the board and sell Unit8."];
assert.match(lineupPinnedResultAtomicRosterDiagnostics(unconditionalMoveCard, semanticHost).join("; "), /position evidence/, "unconditional position operations require current board or bench evidence");
const conditionalMoveCard = structuredClone(semanticCard);
conditionalMoveCard.moves = ["If Unit1 is on the bench, move it to the board after Unit8 is found."];
assert(!lineupPinnedResultAtomicRosterDiagnostics(conditionalMoveCard, semanticHost).some((entry) => /position evidence/.test(entry)), "explicit conditional operations remain deliverable without position evidence");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-lineup-card-contract-normalizer-verifier-v1",
  checked: [
    "legacy_recommended_moves_string_array_migrates_to_object_array_and_moves",
    "canonical_recommended_moves_object_array_and_moves_string_array",
    "custom_positioning_and_equipment_preserved",
    "transition_nodes_cover_7_8_9_10_population",
    "precise_field_diagnostics",
    "pure_final_text_does_not_create_pseudo_lineup_card",
    "runtime_prompt_schema_instruction_builder_exported",
    "root_atomic_candidate_shapes_preserve_complete_rosters",
    "nested_strategy_candidate_id_is_preserved",
    "strategy_fit_packet_candidate_reference_maps_to_working_set",
    "selected_variant_id_resolves_the_matching_atomic_sibling",
    "shared_candidate_id_resolves_by_exact_selected_variant_id",
    "working_set_overrides_ranking_default_in_full_and_projected_requests",
    "ranking_only_and_unknown_variants_fail_with_authoritative_working_set",
    "working_set_rejects_wrong_rosters_and_foreign_candidate_identity",
    "ranking_fallback_requires_absent_working_set",
    "empty_or_incomplete_working_set_fails_closed",
    "selected_candidate_missing_roster_fails_closed",
    "card_selected_candidate_without_candidate_evidence_fails_closed",
    "declared_population_rejects_partial_roster_evidence",
    "special_population_query_separates_roster_count_from_capacity",
    "special_population_card_preserves_complete_canonical_roster",
    "partial_current_board_cannot_replace_selected_atomic_variant",
    "exact_candidate_and_variant_semantics_publish",
    "canonical_object_and_string_roles_share_query_and_validation_normalization",
    "complete_canonical_role_evidence_preserved",
    "explicit_variant_matches_resolved_snapshot_not_alias_union",
    "unresolved_or_incomplete_selected_variant_cannot_borrow_sibling_or_root_roster",
    "selected_variant_roles_do_not_fall_back_to_another_source",
    "same_candidate_wrong_variant_is_rejected",
    "foreign_roles_traits_equipment_and_augments_are_rejected",
    "malicious_cross_candidate_roster_mix_is_rejected",
    "unconditional_position_operations_require_evidence",
    "conditional_position_operations_are_allowed",
  ],
}, null, 2));
