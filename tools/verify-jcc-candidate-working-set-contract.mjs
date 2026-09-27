import assert from "node:assert/strict";
import {
  boundedCandidateWorkingSet,
  candidateWorkingSetLimitForStrategic,
  candidateWorkingSetLimitForDisplay,
  selectCandidateWorkingSetForDurableTarget,
} from "./jcc-candidate-working-set.mjs";
import { compactPipelineRankingCandidate } from "./run-jcc-cruise-runtime-pipeline.mjs";

const candidates = Array.from({ length: 18 }, (_, index) => ({
  candidate_id: `candidate-${index}`,
  name: `Candidate ${index}`,
  champion_names: [`Carry ${index}`, `Tank ${index}`, `Unit ${index}`],
  core_units: [`Carry ${index}`, `Tank ${index}`, `Unit ${index}`],
  roster_is_atomic: true,
  canonical_variant: { lineup_names: [`Carry ${index}`, `Tank ${index}`, `Unit ${index}`], roster_is_atomic: true },
}));

assert.equal(candidateWorkingSetLimitForDisplay(1), 5);
assert.equal(candidateWorkingSetLimitForDisplay(3), 5);
assert.equal(candidateWorkingSetLimitForDisplay(5), 10);
assert.equal(candidateWorkingSetLimitForDisplay(10), 10);
assert.equal(candidateWorkingSetLimitForStrategic({ requestedDisplayCount: 3 }), 5);
assert.equal(candidateWorkingSetLimitForStrategic({ requestedDisplayCount: 3, declaredLimit: 8 }), 8);
assert.equal(candidateWorkingSetLimitForStrategic({ requestedDisplayCount: 5, declaredLimit: 12, max: 16 }), 12);
assert.equal(candidateWorkingSetLimitForStrategic({ requestedDisplayCount: 3, sourceCount: 75 }), 5);
assert.equal(candidateWorkingSetLimitForStrategic({ requestedDisplayCount: 5, sourceCount: 7 }), 7);

const result = boundedCandidateWorkingSet(candidates, { displayCount: 3 });
assert.equal(result.length, 5);
assert.deepEqual(result.map((candidate) => candidate.candidate_id), [
  "candidate-0",
  "candidate-1",
  "candidate-2",
  "candidate-3",
  "candidate-4",
]);
assert.equal(new Set(result.map((candidate) => candidate.candidate_id)).size, result.length);
assert.ok(result.every((candidate) => candidate.canonical_variant));

const strategicResult = boundedCandidateWorkingSet(candidates, { displayCount: 3, limit: 10 });
assert.equal(strategicResult.length, 10);
assert.equal(new Set(strategicResult.map((candidate) => candidate.candidate_id)).size, 10);

const duplicateResult = boundedCandidateWorkingSet([
  { candidate_id: "same", name: "thin" },
  { candidate_id: "same", name: "complete", core_units: ["A", "B", "C"], champion_names: ["A", "B", "C"], roster_is_atomic: true },
  { candidate_id: "other", name: "other", core_units: ["C", "D", "E"], roster_is_atomic: true },
], { displayCount: 3 });
assert.deepEqual(duplicateResult.map((candidate) => candidate.name), ["complete", "other"]);

const variantResult = boundedCandidateWorkingSet([
  { candidate_id: "same-group", selected_variant_id: "variant-a", name: "variant A", core_units: ["A", "B", "C"], roster_is_atomic: true },
  { candidate_id: "same-group", selected_variant_id: "variant-b", name: "variant B", core_units: ["A", "B", "D"], roster_is_atomic: true },
], { displayCount: 3 });
assert.deepEqual(variantResult.map((candidate) => candidate.name), ["variant A", "variant B"]);

const incompleteResult = boundedCandidateWorkingSet([
  { candidate_id: "reference-only", name: "reference", champion_names: ["A", "B", "C"] },
  { candidate_id: "single-unit-atomic", name: "single unit atomic", atomic_roster_members: ["A"], roster_is_atomic: true },
  { candidate_id: "complete-atomic", name: "complete atomic", atomic_roster_members: ["A", "B", "C"], roster_is_atomic: true },
], { displayCount: 3 });
assert.deepEqual(incompleteResult.map((candidate) => candidate.candidate_id), ["complete-atomic"]);

const specialPopulation = {
  candidate_id: "special-population", population: 3, roster_is_atomic: true,
  atomic_roster_members: [{ name: "Large unit", population_cost: 2 }, { name: "Normal unit", population_cost: 1 }],
};
assert.equal(boundedCandidateWorkingSet([specialPopulation]).length, 1,
  "complete atomic rosters count declared slot costs rather than entity count");
assert.equal(boundedCandidateWorkingSet([{ ...specialPopulation,
  atomic_roster_members: [{ name: "Normal unit", population_cost: 1 }, { name: "Pet", occupies_population: false }],
}]).length, 0, "non-population companions cannot fill missing champion slots");

const mixedRosterRepresentation = boundedCandidateWorkingSet([{
  candidate_id: "mixed-roster",
  name: "mixed roster",
  roster_is_atomic: true,
  atomic_roster_members: [{ champion_id: "a", champion_name: "A" }],
  lineup_names: ["A", "B", "C"],
}], { displayCount: 3 });
assert.deepEqual(
  mixedRosterRepresentation.map((candidate) => candidate.candidate_id),
  ["mixed-roster"],
  "a partial enriched roster must not shadow a complete canonical name roster",
);

const targetScopedResult = selectCandidateWorkingSetForDurableTarget([
  { candidate_id: "target", selected_variant_id: "standard", name: "Target", core_units: ["A", "B", "C"], roster_is_atomic: true },
  { candidate_id: "target", selected_variant_id: "variant", name: "Target Variant", core_units: ["A", "B", "D"], roster_is_atomic: true },
  { candidate_id: "unrelated", selected_variant_id: "standard", name: "Unrelated", core_units: ["X", "Y", "Z"], roster_is_atomic: true },
], { candidate_id: "target", selected_variant_id: "standard" });
assert.deepEqual(targetScopedResult.map((candidate) => candidate.selected_variant_id), ["standard", "variant"]);

const compactSelectedVariant = compactPipelineRankingCandidate({
  candidate_id: "shared-family",
  selected_variant_id: "variant-b",
  canonical_variant: {
    variant_id: "variant-a",
    lineup_names: ["A", "B", "C"],
    roster_is_atomic: true,
  },
  variants: [{
    variant_id: "variant-b",
    lineup_names: ["A", "B", "D"],
    roster_is_atomic: true,
  }],
}, 0);
assert.equal(compactSelectedVariant.selected_variant_id, "variant-b");
assert.deepEqual(compactSelectedVariant.champion_names, ["A", "B", "D"]);
assert.equal(compactSelectedVariant.roster_is_atomic, true);

const compactUnknownAtomicity = compactPipelineRankingCandidate({
  candidate_id: "unknown-atomicity",
  selected_variant_id: "variant-unknown",
  variants: [{
    variant_id: "variant-unknown",
    lineup_names: ["A", "B", "C"],
  }],
}, 0);
assert.equal(compactUnknownAtomicity.roster_is_atomic, null);
assert.deepEqual(
  boundedCandidateWorkingSet([compactUnknownAtomicity], { displayCount: 3 }),
  [],
  "missing atomicity evidence must not be upgraded into a publishable candidate",
);

console.log("JCC candidate working-set contract checks passed");
