import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimePaths } from "../ui/electron/runtime-state-store.js";
import { normalizeMumuHeroId } from "./jcc-mumu-hero-id.mjs";

const expected = [
  [11500, 11500, 1],
  [21500, 11500, 2],
  [31500, 11500, 3],
  [41500, 11500, 4],
];

for (const [rawId, baseId, star] of expected) {
  const result = normalizeMumuHeroId(rawId);
  assert.equal(result.raw_hero_id, rawId);
  assert.equal(result.base_hero_id, baseId);
  assert.equal(result.champion_id, baseId);
  assert.equal(result.star_bucket, star);
  assert.equal(result.star_level_hint, star);
}

assert.deepEqual(normalizeMumuHeroId(null), {
  raw_hero_id: null,
  base_hero_id: null,
  hero_id: null,
  champion_id: null,
  star_bucket: null,
  star_level_hint: null,
});

for (const invalid of [0, -11505, 11505.5, 10000, 20000, 30000, 40000, 51505, 991505, " 11505 ", "11x05"]) {
  const result = normalizeMumuHeroId(invalid);
  assert.equal(result.base_hero_id, null, `invalid MuMu id must fail closed: ${invalid}`);
  assert.equal(result.champion_id, null, `invalid MuMu id must not decorate a champion: ${invalid}`);
  assert.equal(result.star_level_hint, null, `invalid MuMu id must not expose a star: ${invalid}`);
}

for (const file of [
  "tools/watch-jcc-mumu-runtime-logcat.mjs",
  "tools/build-jcc-mumu-gi-live-state.mjs",
  "tools/normalize-jcc-mumu-gi-message.mjs",
]) {
  const source = await readFile(file, "utf8");
  assert.match(source, /normalizeMumuHeroId/);
  assert.doesNotMatch(source, /starBucket === 2 \? 3/);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimePaths(repoRoot);
const activeOverlay = JSON.parse(await readFile(runtimePaths.activeRuntimeCatalogOverlayFile, "utf8"));
const canonicalChampions = new Map();
for (const champion of Object.values(activeOverlay.champions_by_id || {})) {
  const canonicalId = Number(champion.canonical_id || champion.id);
  assert(Number.isSafeInteger(canonicalId) && canonicalId > 0 && canonicalId < 10000, `invalid active canonical champion id: ${canonicalId}`);
  const existing = canonicalChampions.get(canonicalId);
  if (existing) {
    assert.equal(existing.name, champion.name, `canonical champion name drift for ${canonicalId}`);
  } else {
    canonicalChampions.set(canonicalId, { name: champion.name });
  }
}
assert(canonicalChampions.size > 0, "active Core Profile must expose canonical champions");

let generatedRoundTrips = 0;
for (const [canonicalId, champion] of canonicalChampions) {
  for (const star of [1, 2, 3, 4]) {
    const rawId = star * 10000 + canonicalId;
    const normalized = normalizeMumuHeroId(rawId);
    const catalogEntry = activeOverlay.champions_by_id?.[String(rawId)];
    assert(catalogEntry, `${champion.name} star ${star} must have a generated MuMu catalog id ${rawId}`);
    assert.equal(normalized.base_hero_id, canonicalId + 10000, `${champion.name} star ${star} must normalize to one base hero id`);
    assert.equal(normalized.star_level_hint, star, `${champion.name} raw id ${rawId} must preserve its star level`);
    assert.equal(String(catalogEntry.canonical_id || catalogEntry.id), String(canonicalId), `${champion.name} raw id ${rawId} must resolve to its official canonical id`);
    assert.equal(Number(catalogEntry.star), star, `${champion.name} raw id ${rawId} catalog star must match the encoded prefix`);
    generatedRoundTrips += 1;
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  active_season_id: activeOverlay.identity?.season_id || null,
  canonical_champion_count: canonicalChampions.size,
  generated_star_id_roundtrips: generatedRoundTrips,
  checked: [
    "MuMu prefixes 1-4 map to star levels 1-4",
    "every champion in the active Core Profile maps from its official canonical id to all supported MuMu star ids",
    "all production parsers use the shared normalizer",
    "the retired two-star-to-three-star mapping stays absent",
    "invalid prefixes, zero-suffix ids, and non-integer ids fail closed before catalog decoration",
  ],
})}\n`);
