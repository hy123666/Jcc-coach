import assert from "node:assert/strict";
import {
  annotateRankingDirectionFamilies,
  buildRankingBandDirectory,
  prioritizeRankingDirectionCoverage,
  remainingRankingDirectionCandidates,
  selectRankingDirectionShowcase,
} from "../ui/electron/ranking-direction-family.js";

function candidate(id, trait, carry, units, band, score) {
  return {
    id,
    display_name: id,
    strategy_profile: {
      main_carry: { champion_id: carry, champion_name: carry },
      strength_anchor: {
        source_trait_signature: { traits: [{ canonical_trait_id: trait, trait_name: trait }] },
        quality: { band, current_day_score: score },
      },
      canonical_variant: { lineup_ids: units, lineup_names: units, formation_profile: null },
    },
  };
}

const infernoSeven = candidate("inferno-seven", "inferno", "sivir",
  ["varus", "shen", "vi", "lillia", "amumu", "sivir", "kennen", "ashe", "lux"], "s", 0.82);
const infernoFive = candidate("inferno-five", "inferno", "sivir",
  ["varus", "shen", "vi", "crab", "amumu", "sivir", "kennen", "ashe", "maokai"], "s", 0.78);
const infernoRift = candidate("inferno-rift", "inferno", "ashe",
  ["vi", "blue", "amumu", "sivir", "kennen", "ashe", "dragon", "lux"], "s", 0.75);
infernoRift.main_trait_list = [{ canonical_trait_id: "inferno", trait_name: "inferno", hero_num: 5 }];
infernoRift.strategy_profile.strength_anchor.source_trait_signature.traits.unshift({
  canonical_trait_id: "rift", trait_name: "rift", breakpoint: 3,
});
const forestNine = candidate("forest-nine", "forest", "aphelios",
  ["ornn", "xayah", "alistar", "leblanc", "hecarim", "ezreal", "aphelios", "gnar", "lux"], "s", 0.72);
const forestSeven = candidate("forest-seven", "forest", "aphelios",
  ["ornn", "xayah", "alistar", "leblanc", "hecarim", "ezreal", "aphelios", "gnar", "lillia"], "b", 0.49);
const warden = candidate("warden-aphelios", "warden", "aphelios",
  ["aphelios", "taric", "sejuani", "lillia", "blue", "ornn", "gnar", "vi"], "a", 0.65);
const khazix = candidate("khazix", "warden", "khazix",
  ["khazix", "taric", "sejuani", "diana", "leona", "shen", "gnar", "vi"], "a", 0.62);
const draven = candidate("draven-dragon", "rift", "draven",
  ["draven", "dragon", "taric", "blue", "wolf", "gnar", "vi", "shen"], "a", 0.56);
const situational = candidate("situational", "mage", "cassiopeia",
  ["cassiopeia", "annie", "hecarim", "lillia", "vi", "lux"], "c", 0.4);
const weak = candidate("weak", "druid", "kogmaw",
  ["kogmaw", "wolf", "gnar", "leona", "shen", "vi"], "d", 0.2);
const source = [infernoSeven, infernoFive, infernoRift, forestNine, warden, khazix, draven,
  forestSeven, situational, weak];
const annotated = annotateRankingDirectionFamilies(source);
const get = (id) => annotated.find((row) => row.id === id);
assert.equal(get("inferno-seven").direction_family.direction_id, get("inferno-five").direction_family.direction_id);
assert.equal(get("inferno-seven").direction_family.family_id, get("inferno-rift").direction_family.family_id);
assert.notEqual(get("inferno-seven").direction_family.direction_id, get("inferno-rift").direction_family.direction_id);
assert.equal(get("forest-nine").direction_family.direction_id, get("forest-seven").direction_family.direction_id);
assert.notEqual(get("warden-aphelios").direction_family.family_id, get("forest-nine").direction_family.family_id,
  "a shared carry or incidental roster units must not merge different primary trait families");
assert(get("inferno-seven").direction_family.same_direction_candidates.some((row) =>
  row.candidate_id === "inferno-five" && row.strength_band === "s"));

const lobby = selectRankingDirectionShowcase(annotated, { count: 5, bands: ["s", "a"] });
assert.equal(lobby.length, 5);
assert(lobby.every((row) => ["s", "a"].includes(row.strategy_profile.strength_anchor.quality.band)));
assert.equal(new Set(lobby.map((row) => row.direction_family.direction_id)).size, 5);
assert(lobby.filter((row) => row.direction_family.family_id === get("inferno-seven").direction_family.family_id).length <= 2);
assert(!lobby.some((row) => row.id === "inferno-five"));
const lobbyRemaining = remainingRankingDirectionCandidates(annotated, lobby, { bands: ["s", "a"] });
assert(!lobbyRemaining.some((row) => lobby.some((shown) =>
  shown.direction_family.direction_id === row.direction_family.direction_id)),
"generic continuation must not repeat a previously presented direction through a sibling variant");
assert(!lobbyRemaining.some((row) => ["b", "c", "d"].includes(row.strategy_profile.strength_anchor.quality.band)),
  "generic S/A pagination must stop instead of creating empty lower-band pages");
assert.equal(selectRankingDirectionShowcase(annotated, { count: 5, bands: ["d"] })[0].id, "weak",
  "lower bands must remain directly searchable");
const unbanded = candidate("legacy-unbanded", "new-trait", "new-carry", ["one", "two"], null, 0.1);
assert.equal(selectRankingDirectionShowcase([unbanded], { count: 5, bands: ["s", "a"] }).length, 1,
  "an older pinned snapshot without bands must not become an empty result");

const match = prioritizeRankingDirectionCoverage(annotated, { count: 5 });
assert.equal(match.length, source.length, "direction coverage must not remove any atomic candidate");
assert.equal(new Set(match.map((row) => row.id)).size, source.length);
assert.equal(match.slice(0, 5).filter((row) => row.direction_family.family_id
  === get("inferno-seven").direction_family.family_id).length, 2);
assert.deepEqual(source.map((row) => row.id), ["inferno-seven", "inferno-five", "inferno-rift", "forest-nine",
  "warden-aphelios", "khazix", "draven-dragon", "forest-seven", "situational", "weak"],
"family annotation cannot mutate the source order");

const directory = buildRankingBandDirectory(source);
assert.deepEqual(directory.bands.map((row) => row.band), ["s", "a", "b", "c", "d"]);
assert.equal(directory.bands[0].total_atomic_candidates, 4);
assert.equal(directory.bands[1].total_atomic_candidates, 3);
assert.equal(directory.bands[0].featured_directions.length, 3);
console.log(JSON.stringify({ ok: true, schema: directory.schema, lobby_ids: lobby.map((row) => row.id),
  match_first_five: match.slice(0, 5).map((row) => row.id) }));
