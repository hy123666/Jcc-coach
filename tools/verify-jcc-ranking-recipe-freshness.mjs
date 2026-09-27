import assert from "node:assert/strict";

import {
  buildRankingRecipeFreshnessProfile,
  evaluateRecipeSourceFreshness,
  statDateFromIsoTimestamp,
} from "./jcc_ranking_recipe_freshness.mjs";

assert.equal(statDateFromIsoTimestamp("2026-08-31T16:30:00.000Z"), "20260901");

const fresh = evaluateRecipeSourceFreshness({ rankingStatDate: "20260831", sourceStatDate: "20260831" });
assert.equal(fresh.status, "fresh");
assert.equal(fresh.automatic_pairing, true);

const recent = evaluateRecipeSourceFreshness({ rankingStatDate: "20260831", sourceStatDate: "20260830" });
assert.equal(recent.status, "recent_lag");
assert.equal(recent.lag_days, 1);

const stale = evaluateRecipeSourceFreshness({ rankingStatDate: "20260831", sourceStatDate: "20260825" });
assert.equal(stale.status, "stale_reference");
assert.equal(stale.matching_policy, "exact_or_high_confidence_compatible_only");

const expired = evaluateRecipeSourceFreshness({ rankingStatDate: "20260831", sourceStatDate: "20260820" });
assert.equal(expired.status, "expired");
assert.equal(expired.automatic_pairing, false);

const future = evaluateRecipeSourceFreshness({ rankingStatDate: "20260831", sourceStatDate: "20260901" });
assert.equal(future.status, "incompatible_date_order");
assert.equal(future.automatic_pairing, false);
assert.equal(future.structural_evidence, false);

const incompatible = evaluateRecipeSourceFreshness({
  rankingStatDate: "20260831",
  sourceStatDate: "20260831",
  identityCompatible: false,
});
assert.equal(incompatible.status, "incompatible");

const profile = buildRankingRecipeFreshnessProfile({
  rankingStatDate: "20260831",
  sourceCapabilities: {
    winning: { status: "available", source_stat_date: "20260830", accepted_recipe_count: 10 },
    popular: {
      status: "available",
      accepted_recipe_count: 20,
      source_receipt: { last_modified: "2026-08-31T08:00:00.000Z" },
    },
  },
});
assert.equal(profile.status, "ready_with_source_lag");
assert.equal(profile.sources.winning.status, "recent_lag");
assert.equal(profile.sources.popular.status, "fresh");

for (const status of ["incompatible", "expired", "forbidden", "quarantined", "failed", "unavailable"]) {
  const blockedProfile = buildRankingRecipeFreshnessProfile({
    rankingStatDate: "20260831",
    sourceCapabilities: {
      winning: { status, source_stat_date: "20260831", accepted_recipe_count: 999 },
      popular: { status: `available_but_${status}`, source_stat_date: "20260831", accepted_recipe_count: 999 },
    },
  });
  assert.equal(blockedProfile.status, "unavailable", `${status} sources must not make the profile ready`);
  assert.equal(blockedProfile.sources.winning.status, status);
  assert.equal(blockedProfile.sources.winning.automatic_pairing, false,
    `${status} must remain terminal despite accepted recipes`);
  assert.equal(blockedProfile.sources.popular.status, status);
  assert.equal(blockedProfile.sources.popular.automatic_pairing, false,
    `compound ${status} status must remain terminal despite accepted recipes`);
}

console.log(JSON.stringify({
  ok: true,
  schema: profile.schema,
  verified: [
    "explicit_terminal_status_cannot_be_revived_by_accepted_recipe_count",
    "compound_terminal_status_cannot_be_revived_by_accepted_recipe_count",
  ],
}, null, 2));
