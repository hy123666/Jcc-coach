import assert from "node:assert/strict";
import {
  RANKING_EMBLEM_PLAN_SCHEMA,
  planConstrainedEmblemAssignments,
} from "../ui/electron/ranking-emblem-planner.js";

const traitCatalog = [
  { trait_id: "arcana", breakpoints: [{ count: 2, tier: "bronze" }, { count: 4, tier: "gold" }] },
  { trait_id: "warden", breakpoints: [2, 4] },
  { trait_id: "sage", breakpoints: [{ count: 2, tier: "silver" }, { count: 5, tier: "prismatic", prismatic: true }] },
  { trait_id: "unused", breakpoints: [2] },
];
const championNaturalTraits = {
  a: ["arcana"],
  b: ["arcana", "warden"],
  c: ["warden"],
  d: ["sage"],
  e: ["sage"],
  f: ["sage"],
  g: ["sage", "unused"],
  h: ["unused"],
  x: ["warden"],
  i: ["arcana"],
};

const exactRequirement = planConstrainedEmblemAssignments({
  lineupCandidates: [{
    candidate_id: "required-line",
    national_top_four_rate: 0.71,
    variants: [{
      variant_id: "required-v1",
      roster: ["a", "b", "c"],
      formation_required_emblems: [{ emblem_id: "arcana-emblem", granted_trait_id: "arcana", holder_id: "c" }],
    }],
  }],
  confirmedEmblems: [{ emblem_id: "arcana-emblem", granted_trait_id: "arcana", quantity: 1 }],
  traitCatalog,
  championNaturalTraits: new Map(Object.entries(championNaturalTraits)),
});
assert.equal(exactRequirement.schema, RANKING_EMBLEM_PLAN_SCHEMA);
assert.equal(exactRequirement.status, "ok");
assert.deepEqual(exactRequirement.variant_plans[0].plans[0].assignments, [{
  emblem_id: "arcana-emblem",
  emblem_copy: 1,
  granted_trait_id: "arcana",
  trait_id: "arcana",
  holder_id: "c",
  evidence_kind: "published_formation_required",
}]);
assert.equal(exactRequirement.variant_plans[0].plans[0].derivation_kind, "published_formation_required");
assert.equal(exactRequirement.variant_plans[0].plans[0].trait_results.find(({ trait_id }) => trait_id === "arcana").final_count, 3);

const threeEmblems = planConstrainedEmblemAssignments({
  lineupCandidates: [{ candidate_id: "three", variants: [{ variant_id: "three-v1", roster: ["a", "b", "c", "g", "h", "x", "i"] }] }],
  confirmedEmblems: [
    { emblem_id: "arcana-emblem", granted_trait_id: "arcana", quantity: 1 },
    { emblem_id: "warden-emblem", granted_trait_id: "warden", quantity: 1 },
    { emblem_id: "unused-emblem", granted_trait_id: "unused", quantity: 1 },
  ],
  traitCatalog,
  championNaturalTraits,
});
assert.equal(threeEmblems.status, "ok");
const topThreePlan = threeEmblems.variant_plans[0].plans[0];
assert.equal(topThreePlan.assignments.length, 2, "only breakpoint-producing legal assignments should outrank unnecessary assignments");
assert.deepEqual(topThreePlan.unused_emblems.map(({ emblem_id }) => emblem_id), ["unused-emblem"]);
assert(topThreePlan.assignments.every(({ evidence_kind }) => evidence_kind === "rule_derived"));

const prismatic = planConstrainedEmblemAssignments({
  lineupCandidates: [{ candidate_id: "prismatic", canonical_variant: { variant_id: "prismatic-v1", roster: ["d", "e", "f", "g", "a"] } }],
  confirmedEmblems: [{ emblem_id: "sage-emblem", granted_trait_id: "sage", quantity: 1 }],
  traitCatalog,
  championNaturalTraits,
});
const prismaticPlan = prismatic.variant_plans[0].plans[0];
assert.equal(prismaticPlan.prismatic_gain_count, 1);
assert.deepEqual(prismaticPlan.trait_results.find(({ trait_id }) => trait_id === "sage").gained_breakpoints, [{
  count: 5,
  tier: "prismatic",
  prismatic: true,
}]);

for (const badCatalog of [
  traitCatalog.filter(({ trait_id }) => trait_id !== "arcana"),
  [...traitCatalog, { trait_id: "arcana", breakpoints: [3] }],
]) {
  const invalid = planConstrainedEmblemAssignments({
    lineupCandidates: [{ candidate_id: "invalid", variants: [{ variant_id: "invalid-v1", roster: ["a", "c"] }] }],
    confirmedEmblems: [{ emblem_id: "arcana-emblem", granted_trait_id: "arcana", quantity: 1 }],
    traitCatalog: badCatalog,
    championNaturalTraits,
  });
  assert.equal(invalid.status, "invalid_input", "missing or ambiguous granted traits must fail closed");
  assert.deepEqual(invalid.variant_plans, []);
}

const atomic = planConstrainedEmblemAssignments({
  lineupCandidates: [{
    candidate_id: "atomic",
    top_four_rate: 0.99,
    strength_anchor: { national_stats: { appearance_rate: 1 } },
    variants: [
      { variant_id: "alpha", roster: ["a", "b", "c"] },
      { variant_id: "beta", roster: ["d", "e", "x"] },
    ],
  }],
  confirmedEmblems: [{ emblem_id: "warden-emblem", granted_trait_id: "warden", quantity: 1 }],
  traitCatalog,
  championNaturalTraits,
});
assert.deepEqual(atomic.variant_plans.map(({ published_roster }) => published_roster), [
  ["a", "b", "c"],
  ["d", "e", "x"],
]);
assert.equal(atomic.variant_plans.some(({ published_roster }) => published_roster.includes("a") && published_roster.includes("d")), false,
  "planner must never compose champions across variants");
const atomicJson = JSON.stringify(atomic);
for (const forbidden of ["top_four_rate", "appearance_rate", "national_stats", "strength_anchor"]) {
  assert.equal(atomicJson.includes(forbidden), false, `derived plans must not inherit ${forbidden}`);
}

const boundedInput = {
  lineupCandidates: [{ candidate_id: "bounded", variants: [
    { variant_id: "bounded-v1", roster: ["a", "b", "c", "d", "e", "f", "g", "h", "x"] },
    { variant_id: "bounded-v2", roster: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
  ] }],
  confirmedEmblems: [
    { emblem_id: "arcana-emblem", granted_trait_id: "arcana", quantity: 2 },
    { emblem_id: "warden-emblem", granted_trait_id: "warden", quantity: 2 },
    { emblem_id: "sage-emblem", granted_trait_id: "sage", quantity: 2 },
  ],
  traitCatalog,
  championNaturalTraits,
  liveConstraints: { limits: { beam_width: 5, max_plans_per_variant: 3, max_expanded_states: 100 } },
};
const boundedFirst = planConstrainedEmblemAssignments(boundedInput);
const boundedSecond = planConstrainedEmblemAssignments(boundedInput);
assert.deepEqual(boundedFirst, boundedSecond, "bounded planning must be deterministic");
assert(boundedFirst.variant_plans[0].plans.length <= 3);
assert(boundedFirst.search.expanded_states <= 100);
assert.equal(boundedFirst.search.truncated, true, "the request-wide expansion limit must truncate deterministically");
assert.equal(boundedFirst.search.beam_width, 5);
for (const variant of boundedFirst.variant_plans) {
  for (const plan of variant.plans) {
    assert.equal(plan.assignments.length + plan.unused_emblems.length, 6,
      "even a truncated plan must account for every confirmed emblem copy");
  }
}

console.log(JSON.stringify({
  ok: true,
  schema: RANKING_EMBLEM_PLAN_SCHEMA,
  exact_requirement_plans: exactRequirement.variant_plans[0].plans.length,
  unused_emblems: topThreePlan.unused_emblems.length,
  prismatic_gains: prismaticPlan.prismatic_gain_count,
  atomic_variants: atomic.variant_plans.length,
  bounded_plans: boundedFirst.variant_plans[0].plans.length,
  bounded_expanded_states: boundedFirst.search.expanded_states,
}));
