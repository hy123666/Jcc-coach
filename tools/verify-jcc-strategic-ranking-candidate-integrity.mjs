import assert from "node:assert/strict";
import { lineupSignalsForDecision } from "../tools/score-jcc-cruise-strategy.mjs";

const candidate = {
  id: "atomic-line-1",
  name: "完整方向",
  display_name: "完整方向",
  signal_score: 0.9,
  top4_rate: 0.8,
  top1_rate: 0.3,
  use_rate: 0.1,
  main_carry: { champion_name: "主C", cost: 4 },
  primary_tank: { champion_name: "主坦", cost: 4 },
  main_traits: ["核心羁绊"],
  source_role: "master_plus",
  metrics_authority: "national_master_plus_current_snapshot",
  provenance: { canonical_roster_source: "national_atomic_roster", strength_source: "master_plus" },
  evidence_boundary: { roster_is_atomic: true, recipe_metrics_used: false },
  core_units: [{ id: "1", name: "主C" }, { id: "2", name: "主坦" }],
  canonical_variant: {
    variant_id: "atomic-line-1-v1",
    population: 8,
    core_unit_names: ["主C", "主坦"],
    lineup_names: ["主C", "主坦", "功能位"],
    trait_signature: "核心羁绊4",
  },
  canonical_lineup_identity: { key: "trait-a:4", display_key: "核心羁绊4" },
  semantic_signature: { trait_key: "trait-a:4", roster_key: "1|2|3" },
  atomic_variant_comparison: {
    baseline_variant_id: "atomic-line-1-v1",
    variants: [{ variant_id: "atomic-line-1-v1", variant_type: "baseline_complete" }],
  },
  mature_recipe_variants: [{ recipe_id: "popular-variant", removed_units: ["功能位"], added_units: ["替换位"] }],
  strategy_profile: {
    lifecycle_prior: { archetype: "standard_operation" },
    equipment_requirements: { carry: ["输出装"] },
    condition_priors: { requires_augment: false },
  },
};
const result = lineupSignalsForDecision({ lineupSignals: [candidate] }, 1);
assert.equal(result.length, 1);
assert.deepEqual(result[0].core_units, candidate.core_units);
assert.deepEqual(result[0].canonical_variant, candidate.canonical_variant);
assert.deepEqual(result[0].strategy_profile, candidate.strategy_profile);
assert.deepEqual(result[0].canonical_lineup_identity, candidate.canonical_lineup_identity);
assert.deepEqual(result[0].semantic_signature, candidate.semantic_signature);
assert.deepEqual(result[0].atomic_variant_comparison, candidate.atomic_variant_comparison);
assert.deepEqual(result[0].mature_recipe_variants, candidate.mature_recipe_variants);
assert.deepEqual(result[0].provenance, candidate.provenance);
assert.deepEqual(result[0].evidence_boundary, candidate.evidence_boundary);

const wideResult = lineupSignalsForDecision({
  lineupSignals: Array.from({ length: 70 }, (_, index) => ({
    ...candidate,
    id: `atomic-line-${index}`,
    canonical_variant: {
      ...candidate.canonical_variant,
      variant_id: `atomic-line-${index}-v1`,
    },
    atomic_roster_id: `atomic-line-${index}-v1`,
    atomic_roster_members: ["主C", "主坦", `功能位${index}`],
    strength_anchor: { source: "master_plus", rank: index + 1 },
    metrics_authority: "master_plus_current_snapshot",
  })),
});
assert.equal(wideResult.length, 64, "the default strategic working surface must retain 64 candidates");
assert.equal(wideResult[0].atomic_roster_id, "atomic-line-0-v1");
assert.deepEqual(wideResult[0].atomic_roster_members, ["主C", "主坦", "功能位0"]);
assert.deepEqual(wideResult[0].strength_anchor, { source: "master_plus", rank: 1 });
assert.equal(wideResult[0].metrics_authority, "master_plus_current_snapshot");

console.log(JSON.stringify({ ok: true, schema: "jcc-strategic-ranking-candidate-integrity-verification-v1" }, null, 2));
