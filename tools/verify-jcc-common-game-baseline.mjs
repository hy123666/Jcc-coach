#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonRoot = path.join(repoRoot, "data", "game-knowledge", "jcc", "common");

async function readJson(file) {
  return JSON.parse(await readFile(path.join(commonRoot, file), "utf8"));
}

const manifest = JSON.parse(await readFile(path.join(repoRoot, "data", "game-knowledge", "jcc", "manifest.json"), "utf8"));
const baseline = await readJson("standard-game-baseline.json");
const glossary = await readJson("glossary.json");
const concepts = await readJson("concepts.json");
const standardMechanics = await readJson("standard-mechanics.json");
const activeProfile = JSON.parse(await readFile(path.join(repoRoot, "data", "game-knowledge", "jcc", "active-profile.json"), "utf8"));
const activeDescriptorRelative = manifest.season_descriptors?.[activeProfile.season_id];
assert.ok(activeDescriptorRelative, `active season ${activeProfile.season_id} must have a registered descriptor`);
const activeDescriptor = JSON.parse(await readFile(path.join(repoRoot, "data", "game-knowledge", "jcc", activeDescriptorRelative), "utf8"));

assert.ok(manifest.common_documents.includes("common/standard-game-baseline.json"));
assert.ok(manifest.common_documents.includes("common/glossary.json"));
assert.equal(baseline.scope, "common");
assert.equal(baseline.season_neutral, true);
assert.equal(baseline.authority.kind, "user_confirmed_common_standard");
assert.equal(baseline.override_policy, "active_season_must_explicitly_declare_any_exception");

const byId = new Map(baseline.entries.map((entry) => [entry.id, entry]));
assert.deepEqual(byId.get("standard.shop_and_pool").pool_by_cost.map((row) => row.copies_per_champion), [30, 25, 18, 10, 9]);
assert.deepEqual(byId.get("standard.shop_and_pool").odds_by_level.find((row) => row.level === 8), {
  level: 8, cost1: 15, cost2: 20, cost3: 32, cost4: 30, cost5: 3,
});
assert.deepEqual(byId.get("standard.star_upgrade").base_copies_by_star, { "1": 1, "2": 3, "3": 9 });
assert.deepEqual(byId.get("standard.player_damage").base_damage_by_stage, { "1": 0, "2": 2, "3": 6, "4": 7, "5": 10, "6": 12, "7": 17, "8": 150 });
assert.deepEqual(byId.get("standard.player_damage").surviving_enemy_unit_damage, { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8 });
assert.equal(byId.get("standard.player_damage").formula, "stage_base_damage + surviving_enemy_unit_damage_by_count");

const economy = byId.get("standard.economy");
assert.deepEqual(economy.base_income_by_round, { "1-2": 2, "1-3": 2, "1-4": 3, "2-1": 4, "2-2+": 5 });
assert.deepEqual(economy.streak_bonus, [
  { min_streak: 2, max_streak: 4, gold: 1 },
  { min_streak: 5, max_streak: 5, gold: 2 },
  { min_streak: 6, max_streak: null, gold: 3 },
]);
assert.equal(economy.pvp_win_gold, 1);

const progression = byId.get("standard.progression");
assert.equal(progression.starting_level, 2);
assert.equal(progression.natural_xp_per_round, 2);
assert.deepEqual(progression.xp_purchase, { gold: 4, xp: 4 });
assert.deepEqual(progression.xp_to_next_level, { "2": 2, "3": 6, "4": 10, "5": 20, "6": 36, "7": 56, "8": 68, "9": 68 });
assert.deepEqual(progression.cumulative_xp_to_level, { "2": 0, "3": 2, "4": 8, "5": 18, "6": 38, "7": 74, "8": 130, "9": 198, "10": 266 });
assert.deepEqual(progression.reference_purchase_gold_at_standard_natural_timing, { "3": 0, "4": 4, "5": 8, "6": 20, "7": 36, "8": 56, "9": 68, "10": 68 });

const augmentTierProbabilities = byId.get("standard.augment_tier_probabilities");
assert.deepEqual(augmentTierProbabilities.first_choice_tier_distribution.tiers.map((row) => row.probability_fraction), ["1/3", "1/3", "1/3"]);
assert.equal(augmentTierProbabilities.rows.length, 18);

const schedule = byId.get("standard.round_schedule");
assert.equal(schedule.rounds["2-1"].kind, "augment");
assert.equal(schedule.rounds["2-4"].kind, "carousel");
assert.equal(schedule.rounds["2-7"].kind, "pve");
assert.equal(schedule.rounds["3-2"].kind, "augment");
assert.equal(schedule.rounds["4-2"].kind, "augment");
assert.equal(schedule.rounds["7-4"].kind, "carousel");

const conceptIds = new Set(concepts.entries.map((entry) => entry.id));
for (const id of ["concept.player_damage", "concept.victory_and_placement", "concept.pve", "concept.pvp", "concept.carousel"]) {
  assert.ok(conceptIds.has(id), `missing Common concept ${id}`);
}

const glossaryById = new Map(glossary.entries.map((entry) => [entry.id, entry]));
for (const id of [
  "term.fast_8", "term.slow_roll", "term.hyper_roll", "term.roll_down", "term.pivot", "term.carry",
  "term.frontline", "term.reroll_comp", "term.refresh", "term.buy_xp", "term.emblem", "term.augment",
  "term.carousel", "term.aoe", "term.dps", "term.average_placement",
  "term.grid",
]) assert.ok(glossaryById.has(id), `missing glossary entry ${id}`);
assert.ok(glossaryById.get("term.refresh").aliases.includes("D牌"));
assert.ok(glossaryById.get("term.buy_xp").aliases.includes("F"));
assert.ok(glossaryById.get("term.augment").aliases.includes("海克斯"));

const mechanicsById = new Map(standardMechanics.entries.map((entry) => [entry.id, entry]));
const carousel = mechanicsById.get("mechanic.carousel_checkpoint");
assert.deepEqual(carousel.checkpoints, ["2-4", "3-4", "4-4", "5-4", "6-4", "7-4"]);
assert.equal(carousel.choice_window, false);
assert.equal(carousel.runtime_ui_mode, null);
assert.ok(activeDescriptor.inherits.standard_mechanics.includes("mechanic.carousel_checkpoint"));
assert.deepEqual(Object.keys(activeDescriptor.runtime_contract.normal_rules.stage_decision_tasks), carousel.checkpoints);

console.log(JSON.stringify({
  ok: true,
  assertions: [
    "Common authority and override boundary",
    "shop odds and shared pool",
    "star-up and progression",
    "round schedule and player damage",
    "economy and streak income",
    "basic gameplay concepts",
    "player terminology and aliases",
    "standard carousel inheritance without a Runtime Mode",
  ],
  active_season_id: activeProfile.season_id,
}));
