import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readLiveRankingsSummary, compactSelectedRankingCandidatesForTurn } from "../ui/electron/runtime-service.js";
import { projectRankingToolCandidate, restoreRankingToolCandidate } from "../ui/electron/ranking-tool-projection.js";

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const ranking = await readLiveRankingsSummary();
const raw = compactSelectedRankingCandidatesForTurn({ candidates: ranking.tiers["0"].lineup_groups }, {
  maxCandidates: 10, includeLineupIds: true,
}).candidates;
assert.equal(raw.length, 10);
const rows = raw.map(candidate => {
  const start = performance.now();
  const projected = projectRankingToolCandidate(candidate);
  const restored = restoreRankingToolCandidate(projected);
  const canonical = projected.strategy_profile.canonical_variant;
  assert.deepEqual(canonical.atomic_roster_members, candidate.strategy_profile.canonical_variant.atomic_roster_members,
    "search projection must preserve the complete atomic roster");
  assert.deepEqual(canonical.main_carry, candidate.strategy_profile.canonical_variant.main_carry);
  assert.deepEqual(canonical.primary_tank, candidate.strategy_profile.canonical_variant.primary_tank);
  assert.equal(canonical.main_carry.champion_id, candidate.strategy_profile.main_carry.champion_id,
    "search projection must expose the resolved candidate carry");
  assert.equal(canonical.primary_tank.champion_id, candidate.strategy_profile.primary_tank.champion_id,
    "search projection must expose the resolved candidate tank");
  assert.deepEqual(canonical.trait_signature, candidate.strategy_profile.canonical_variant.trait_signature);
  assert.deepEqual(canonical.lifecycle_prior, candidate.strategy_profile.canonical_variant.lifecycle_prior);
  assert.deepEqual(projected.strategy_profile.strength_anchor, candidate.strategy_profile.strength_anchor);
  assert(projected.strategy_profile.equipment_requirements, "search projection must preserve equipment evidence");
  assert(Object.hasOwn(canonical, "transition_chain"), "search projection must preserve transition evidence, including explicit unknown/empty state");
  assert(canonical.formation_profile, "search projection must preserve compact formation conditions");
  assert(projected.strategy_profile.condition_priors, "search projection must preserve entry and pivot conditions");
  assert(!Array.isArray(projected.strategy_profile.semantic_features?.relations),
    "search projection must not expand the typed relation index inside every candidate");
  assert(!Array.isArray(projected.semantic_features?.relations),
    "search projection must not retain a second expanded relation index at candidate level");
  assert(!Array.isArray(canonical.mature_recipe_variants),
    "search projection must not expand every recipe alternative inside every candidate");
  assert(Array.isArray(canonical.mature_recipe_variant_refs),
    "search projection must retain recipe alternative references for exact follow-up");
  assert(canonical.mature_recipe_variant_refs.every((ref) => !Object.hasOwn(ref, "role_resolution")),
    "recipe references must not repeat internal role-audit payloads");
  assert(!Object.hasOwn(projected.strategy_profile, "primary_tank_item_evidence_by_champion"),
    "search projection must not repeat tank evidence for non-selected holders");
  assert.deepEqual(restored.strategy_profile.canonical_variant.atomic_roster_members,
    candidate.strategy_profile.canonical_variant.atomic_roster_members);
  assert.equal(projected.available_variant_refs.length, candidate.strategy_profile.sibling_variants.length);
  const variantRef = projected.available_variant_refs[0];
  const sourceVariant = candidate.strategy_profile.sibling_variants[0];
  assert.equal(variantRef.candidate_id, candidate.id,
    "variant references must retain the parent candidate identity");
  assert.equal(variantRef.selected_variant_id, sourceVariant.variant_id,
    "variant references must retain the exact atomic variant identity");
  assert.equal(variantRef.candidate_evidence_id, sourceVariant.candidate_evidence_id,
    "variant references must retain the exact evidence identity");
  assert.equal(variantRef.detail_retrieval, "get_lineup",
    "variant references must advertise exact detail retrieval without embedding another roster");
  assert(!Object.hasOwn(variantRef, "atomic_roster_id"),
    "variant references must not repeat the full internal roster identity");
  assert.ok(!Object.hasOwn(projected.strategy_profile, "sibling_variants"));
  const mergedFields = Object.entries(projected.field_aliases || {}).map(([source, target]) => ({
    source, target, original_bytes: bytes(source.split(".").reduce((v, key) => v[key], candidate)),
  }));
  return { id: candidate.id, before_bytes: bytes(candidate), after_bytes: bytes(projected),
    sibling_fulltext_bytes: bytes(candidate.strategy_profile.sibling_variants), merged_fields: mergedFields,
    projection_ms: performance.now() - start };
});
const fixture = { strategy_profile: { canonical_variant: { main_carry: { id: "A" }, formation_profile: { x: 1 } },
  main_carry: { id: "B" }, formation_profile: { x: 1 }, sibling_variants: [] }, formation_profile: { x: 1 } };
const projectedFixture = projectRankingToolCandidate(fixture);
assert.deepEqual(projectedFixture.strategy_profile.main_carry, { id: "B" }, "different facts must not merge");
const restoredFixture = restoreRankingToolCandidate(projectedFixture);
assert.deepEqual(restoredFixture.formation_profile, { x: 1 }, "alias chains must resolve");
assert.deepEqual(fixture.strategy_profile.sibling_variants, [], "source must not mutate");
assert.ok(rows.slice(0, 5).reduce((total, row) => total + row.after_bytes, 0) < 110 * 1024,
  "five complete comparison candidates must remain below the bounded tool-result target");
const report = { ok: true, ranking_overlay_id: ranking.ranking_overlay_id, stat_date: ranking.stat_date,
  comparisons: [5, 10].map(count => ({ count,
    before_bytes: rows.slice(0,count).reduce((n,r) => n+r.before_bytes,0),
    after_bytes: rows.slice(0,count).reduce((n,r) => n+r.after_bytes,0),
  })), rows };
await mkdir(".omx/runtime-evidence", { recursive: true });
await writeFile(".omx/runtime-evidence/ranking-tool-projection.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: rows.slice(0,1) }, null, 2));
