import assert from "node:assert/strict";
import {
  evaluateRankingVariant,
  retrieveRankingCandidates,
} from "../ui/electron/ranking-query-retrieval.js";

const traits = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

function variant(id, {
  traitEntries = [],
  mainCarry = null,
  primaryTank = null,
  members = [],
} = {}) {
  const lineupIds = [...new Set([
    mainCarry,
    primaryTank,
    ...members,
  ].filter(Boolean))];
  return {
    variant_id: id,
    semantic_role: "published_final_lineup_variant",
    trait_signature: {
      traits: traitEntries.map(([traitId, breakpoint]) => ({
        canonical_trait_id: traitId,
        trait_id: traitId,
        breakpoint,
      })),
    },
    lineup_ids: lineupIds,
    lineup_names: lineupIds.map((entry) => `${entry}-name`),
    main_carry: mainCarry ? { champion_id: mainCarry, champion_name: `${mainCarry}-name` } : null,
    primary_tank: primaryTank ? { champion_id: primaryTank, champion_name: `${primaryTank}-name` } : null,
  };
}

function candidate(id, variants, strength = null) {
  return {
    id,
    display_name: id,
    strategy_profile: {
      variants,
      ...(strength === null ? {} : {
        strength_anchor: {
          authority: "national_trait_strength",
          metrics: { top4_rate: strength, top1_rate: strength / 3, use_rate: strength / 10 },
          quality: { current_day_score: strength },
        },
      }),
    },
  };
}

const trait = (id, breakpoint = 2) => ({ kind: "trait", id, breakpoint });
const champion = (id, role = "member") => ({ kind: "champion", id, role });
const and = (...clauses) => ({ op: "and", clauses });
const or = (...clauses) => ({ op: "or", clauses });
const not = (clause) => ({ op: "not", clause });

const complete = candidate("complete", [variant("complete-v1", {
  traitEntries: traits.map((id) => [id, 2]),
  mainCarry: "carry-a",
  primaryTank: "tank-a",
  members: ["member-a"],
})], 0.61);

for (let count = 2; count <= 6; count += 1) {
  const expression = and(...traits.slice(0, count).map((id) => trait(id)));
  const evaluation = evaluateRankingVariant(complete.strategy_profile.variants[0], expression);
  assert.equal(evaluation.exact, true, `${count} trait conditions must match one published variant atomically`);
  assert.equal(evaluation.positive_matched, count);
  assert.equal(evaluation.positive_total, count);
}

const exactBreakpoint = evaluateRankingVariant(
  complete.strategy_profile.variants[0],
  and(trait("alpha", 2), not(trait("alpha", 4))),
);
assert.equal(exactBreakpoint.exact, true, "trait breakpoints must match exactly rather than by family alone");

const wrongBreakpoint = evaluateRankingVariant(complete.strategy_profile.variants[0], trait("alpha", 4));
assert.equal(wrongBreakpoint.exact, false);
assert.equal(wrongBreakpoint.positive_matched, 0);

assert.throws(() => retrieveRankingCandidates([
  candidate("canonical-inferno", [variant("canonical-inferno-v1", { traitEntries: [["458", 3]] })], 0.9),
], {
  groups: [{ id: "raw-source-id-forbidden", expression: trait("847001", 3) }],
}), /must identify an entity/u,
"raw Ranking family ids must be rejected before they can act as canonical trait query identities");

const malformedRawTraitVariant = {
  ...variant("malformed-raw-trait-v1"),
  trait_signature: {
    traits: [{ trait_id: "847001", breakpoint: 3 }],
  },
};
assert.throws(
  () => evaluateRankingVariant(malformedRawTraitVariant, trait("847001", 3)),
  /must identify an entity/u,
  "a malformed candidate must not restore a raw source family id as a typed-query identity",
);

const exactNegativeBreakpoint = retrieveRankingCandidates([
  candidate("keeps-two-beta", [variant("keeps-two-beta-v1", { traitEntries: [["alpha", 2], ["beta", 2]] })], 0.5),
  candidate("rejects-six-beta", [variant("rejects-six-beta-v1", { traitEntries: [["alpha", 2], ["beta", 6]] })], 0.9),
], {
  groups: [{ id: "exact-negative-breakpoint", expression: and(trait("alpha", 2), not(trait("beta", 6))) }],
});
assert.deepEqual(exactNegativeBreakpoint.groups[0].exact_candidate_ids, ["keeps-two-beta"]);

assert.equal(evaluateRankingVariant(
  complete.strategy_profile.variants[0],
  and(champion("carry-a", "main_carry"), champion("tank-a", "primary_tank"), champion("member-a")),
).exact, true, "champion roles must be evaluated inside the same variant");
assert.equal(evaluateRankingVariant(
  complete.strategy_profile.variants[0],
  champion("member-a", "main_carry"),
).exact, false, "a member must not satisfy a main-carry condition");
assert.equal(evaluateRankingVariant(
  complete.strategy_profile.variants[0],
  or(champion("missing"), champion("member-a")),
).exact, true, "OR must accept one matching branch");

const negated = retrieveRankingCandidates([
  complete,
  candidate("contains-banned", [variant("contains-banned-v1", {
    traitEntries: [["alpha", 2], ["beta", 2]],
    members: ["banned"],
  })], 0.9),
], {
  groups: [{ id: "without-banned", expression: and(trait("alpha"), trait("beta"), not(champion("banned"))) }],
});
assert.deepEqual(negated.groups[0].exact_candidate_ids, ["complete"]);
assert.equal(negated.candidates.some((entry) => entry.id === "contains-banned" && entry.exact_group_ids.length), false);
assert.equal(negated.candidates.some((entry) => entry.id === "contains-banned"), false, "a NOT violation must not survive as positive partial evidence");

const splitAcrossVariants = candidate("split-across-variants", [
  variant("split-alpha", { traitEntries: [["alpha", 2]], mainCarry: "carry-a" }),
  variant("split-beta", { traitEntries: [["beta", 2]], mainCarry: "carry-a" }),
], 0.95);
const atomicResult = retrieveRankingCandidates([splitAcrossVariants, complete], {
  groups: [{ id: "atomic", expression: and(trait("alpha"), trait("beta")) }],
});
assert.deepEqual(atomicResult.groups[0].exact_candidate_ids, ["complete"]);
assert.equal(
  atomicResult.candidates.find((entry) => entry.id === "split-across-variants")?.exact_group_ids.length,
  0,
  "conditions split across variants must never become an exact group match",
);

const compiledStrengthOrder = retrieveRankingCandidates([
  {
    ...candidate("compiled-winner", [variant("compiled-winner-v1", { traitEntries: [["alpha", 2]] })], 0.1),
    strategy_profile: {
      ...candidate("compiled-winner", []).strategy_profile,
      variants: [variant("compiled-winner-v1", { traitEntries: [["alpha", 2]] })],
      strength_anchor: {
        metrics: { top4_rate: 0.1, top1_rate: 0.01, use_rate: 0.001 },
        quality: { current_day_score: 0.91 },
      },
    },
  },
  candidate("raw-formula-winner", [variant("raw-formula-winner-v1", { traitEntries: [["alpha", 2]] })], 0.8),
], {
  groups: [{ id: "compiled-strength-authority", expression: trait("alpha", 2) }],
});
assert.equal(compiledStrengthOrder.groups[0].exact_candidate_ids[0], "compiled-winner",
  "typed retrieval must consume the compiled deterministic current-day score instead of recalculating a competing formula");

const missingCompiledStrength = retrieveRankingCandidates([
  {
    ...candidate("a-low-appearance", [variant("a-low-appearance-v1", { traitEntries: [["alpha", 2]] })]),
    strategy_profile: {
      variants: [variant("a-low-appearance-v1", { traitEntries: [["alpha", 2]] })],
      strength_anchor: { metrics: { top4_rate: 0.1, top1_rate: 0.01, use_rate: 0.001 } },
    },
  },
  {
    ...candidate("b-high-appearance", [variant("b-high-appearance-v1", { traitEntries: [["alpha", 2]] })]),
    strategy_profile: {
      variants: [variant("b-high-appearance-v1", { traitEntries: [["alpha", 2]] })],
      strength_anchor: { metrics: { top4_rate: 0.9, top1_rate: 0.8, use_rate: 0.99 } },
    },
  },
], { groups: [{ id: "missing-compiled-strength", expression: trait("alpha", 2) }] });
assert.deepEqual(
  missingCompiledStrength.groups[0].exact_candidate_ids,
  ["a-low-appearance", "b-high-appearance"],
  "missing compiled current-day strength must remain unavailable; raw metrics and appearance cannot reconstruct or reorder it",
);

const twoGroups = retrieveRankingCandidates([
  candidate("group-a-line", [variant("group-a-v1", {
    traitEntries: [["alpha", 2], ["beta", 2]],
    mainCarry: "carry-a",
  })], 0.55),
  candidate("group-b-line", [variant("group-b-v1", {
    traitEntries: [["gamma", 2], ["delta", 2]],
    mainCarry: "carry-b",
  })], 0.58),
  splitAcrossVariants,
], {
  groups: [
    { id: "group-a", expression: and(trait("alpha"), trait("beta"), champion("carry-a", "main_carry")) },
    { id: "group-b", expression: and(trait("gamma"), trait("delta"), champion("carry-b", "main_carry")) },
  ],
});
assert.deepEqual(twoGroups.groups.map((group) => group.status), ["exact", "exact"]);
assert.deepEqual(twoGroups.groups[0].exact_candidate_ids, ["group-a-line"]);
assert.deepEqual(twoGroups.groups[1].exact_candidate_ids, ["group-b-line"]);
assert.deepEqual(twoGroups.candidates.slice(0, 2).map((entry) => entry.id), ["group-b-line", "group-a-line"]);

const partialOnly = retrieveRankingCandidates([
  candidate("partial-strong", [variant("partial-strong-v1", {
    traitEntries: [["alpha", 2], ["beta", 2]],
    mainCarry: "carry-a",
  })], 0.8),
  candidate("partial-weak", [variant("partial-weak-v1", {
    traitEntries: [["alpha", 2]],
    mainCarry: "carry-a",
  })], 0.9),
], {
  groups: [{ id: "missing-exact", expression: and(trait("alpha"), trait("beta"), trait("gamma")) }],
});
assert.equal(partialOnly.groups[0].status, "partial_downgrade");
assert.equal(partialOnly.groups[0].downgrade_reason, "no_atomic_exact_match");
assert.deepEqual(partialOnly.groups[0].partial_candidate_ids, ["partial-strong", "partial-weak"]);
assert.equal(partialOnly.candidates[0].id, "partial-strong", "coverage must outrank national strength for partial matches");

const orderFixture = [
  candidate("strong-member", [variant("strong-member-v1", {
    traitEntries: [["alpha", 2], ["beta", 2]],
    members: ["carry-a"],
  })], 0.9),
  candidate("weaker-carry", [variant("weaker-carry-v1", {
    traitEntries: [["alpha", 2], ["beta", 2]],
    mainCarry: "carry-a",
  })], 0.5),
];
const roleIntent = {
  groups: [{ id: "role-order", expression: and(trait("alpha"), trait("beta"), champion("carry-a", "main_carry")) }],
};
const forward = retrieveRankingCandidates(orderFixture, roleIntent);
const reversed = retrieveRankingCandidates([...orderFixture].reverse(), roleIntent);
assert.deepEqual(forward.candidates.map((entry) => entry.id), reversed.candidates.map((entry) => entry.id), "input order must not affect retrieval order");
assert.equal(forward.candidates[0].id, "weaker-carry", "exact role coverage must outrank unrelated national strength");
const roleTie = retrieveRankingCandidates(orderFixture, {
  groups: [{
    id: "role-tie",
    expression: and(trait("alpha"), trait("beta"), or(
      champion("carry-a", "main_carry"),
      champion("carry-a", "member"),
    )),
  }],
});
assert.equal(roleTie.candidates[0].id, "weaker-carry", "role precision must outrank national strength when exact coverage is equal");
const reversedClauses = retrieveRankingCandidates(orderFixture, {
  groups: [{
    id: "role-order",
    expression: and(champion("carry-a", "main_carry"), trait("beta"), trait("alpha")),
  }],
});
assert.deepEqual(
  reversedClauses.candidates.map((entry) => entry.id),
  forward.candidates.map((entry) => entry.id),
  "AND clause order must not affect retrieval order",
);

console.log(JSON.stringify({
  ok: true,
  schema: twoGroups.schema,
  verified_trait_intersections: [2, 3, 4, 5, 6],
  verified_groups: twoGroups.groups.map((group) => group.id),
  verified_partial_downgrade: partialOnly.groups[0].downgrade_reason,
  verified_atomic_rejection: "split-across-variants",
}, null, 2));
