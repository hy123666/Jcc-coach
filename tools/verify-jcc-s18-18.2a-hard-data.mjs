import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyBalancePatchSet } from './jcc_balance_patch_overlay.mjs';
import { createDecisionMathService } from '../ui/electron/decision-math-service.js';

const index = process.argv.indexOf('--manifest');
assert(index >= 0, '--manifest required');
const root = path.dirname(path.resolve(process.argv[index + 1]));
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const manifest = await json('manifest.json');
assert.equal(manifest.release_version, '18.2a');
const mechanics = await json('normalized/mechanics_parameters.json');
assert.deepEqual(mechanics.progression.xp_to_next_level, {2:2,3:6,4:10,5:20,6:36,7:56,8:68,9:68});
assert.equal(mechanics.progression.cumulative_xp_to_level['9'], 198);
assert.equal(mechanics.progression.cumulative_xp_to_level['10'], 266);
const champions = await json('normalized/champions.json');
const one = (rows,name) => { const found=rows.filter(r=>r.name===name);assert.equal(found.length,1,name);return found[0]; };
for (const [name, parts] of [
  ['卡蜜尔',['150/225/375/640','60/90/200/310']],
  ['凯尔',['62/92/105/115','35/35/35/45']],
  ['提莫',['55/82/130/230']], ['慎',['350/430/550/700']],
  ['黛安娜',['75/115/180/230','150/275/500/525']],
  ['阿狸',['455/685/3500/5000']], ['绯红印记树怪',['155/235/1000/1500']],
  ['苍蓝雕纹魔像',['350/450/2000/5000']], ['婕拉',['35/53/225/425']],
  ['拉克丝',['375/565/6500/9999']], ['艾希',['9/14/200/200','3/3/20/20']],
]) for (const value of parts) assert(one(champions,name).skill.raw_values.includes(value), `${name}: ${value}`);
assert.equal(one(champions,'易').attributes_by_star['物攻'][0],60);
assert.deepEqual(one(champions,'易').balance_overrides.spell_form_magic_damage_by_star,[125,190,285]);
assert(one(champions,'黛安娜').attributes_by_star['法力值'].every(v=>v===40));
assert(one(champions,'茂凯').attributes_by_star['法力值'].every(v=>v===100));
assert.equal(one(champions,'绯红印记树怪').attributes_by_star['物攻'][0],120);
const traits = await json('normalized/traits.json');
assert.deepEqual(one(traits,'迅捷射手').breakpoints.map(r=>r.effect.match(/\+(\d+)%/)?.[1]),['3','5','8','12']);
const repoRoot = path.resolve(import.meta.dirname, '..');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const patch = await readJson(path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s18/patches/s18_2/balance-changes-18.2a.json'));
const inherited = patch.inherited_balance_delta;
assert.equal(inherited.target_baseline_generation_id, '4d08f8301b7fc1a99a99a80c6f7f5d8268d35a90ace7d320d212a821ca12d999');
const baselineRoot = path.resolve(root, '..', inherited.target_baseline_generation_id);
const baselineJson = file => readJson(path.join(baselineRoot, file));
const baselineManifest = await baselineJson('manifest.json');
const baselineSeason = await baselineJson('normalized/season_mechanics.json');
const season = await json('normalized/season_mechanics.json');
const sprites = season.shop_extensions.flatMap(extension => extension.entries || []);
const baseline = {
  identity: { ...baselineManifest.identity, hard_data_generation_id: baselineManifest.hard_data_generation_id },
  sprites: baselineSeason.shop_extensions.flatMap(extension => extension.entries || []),
  season_metadata: [{ id: 'season:s18', name: 's18', balance_overrides: baselineSeason.balance_overrides }],
};
for (const catalog of ['champions', 'traits', 'items', 'augments', 'chess_variants']) {
  baseline[catalog] = await baselineJson(`normalized/${catalog}.json`);
}
for (const catalog of ['mechanics_parameters', 'reward_tables']) {
  baseline[catalog] = [await baselineJson(`normalized/${catalog}.json`)];
}
const parentPatch = await readJson(path.join(repoRoot, inherited.source_path));
assert.deepEqual(patch.operations.slice(0, inherited.operation_count), parentPatch.operations, '18.2 replay prefix');
const deltaOperations = patch.operations.slice(inherited.operation_count);
const expected = applyBalancePatchSet(baseline, {
  ...patch, baseline: baseline.identity, operations: deltaOperations,
}).catalogs;
// Compare the full source rebuild with applying only the new delta to promoted 18.2.
for (const catalog of ['champions', 'traits', 'items', 'augments', 'chess_variants']) {
  assert.deepEqual(await json(`normalized/${catalog}.json`), expected[catalog], `${catalog}: rebuilt versus promoted baseline plus delta`);
}
assert.deepEqual(sprites, expected.sprites, 'all sprite families and source variants');
const changedChampionIds = new Set(deltaOperations.filter(op => op.catalog === 'champions').map(op => op.id));
let unchangedChampions = 0;
for (const original of baseline.champions) {
  if (changedChampionIds.has(original.id)) continue;
  assert.deepEqual(champions.find(row => row.id === original.id), original, `untouched champion ${original.name}`);
  unchangedChampions++;
}
const lux = one(champions, '拉克丝');
const oldLux = one(baseline.champions, '拉克丝');
for (const field of ['raw_refs', 'source_variants', 'source_mappings', 'runtime_semantics']) {
  assert.deepEqual(lux[field], oldLux[field], `Lux ${field}`);
}
assert.equal(lux.source_variants.length, 9);
const dragon = champions.find(row => row.raw_refs?.resource_key === 's18_elderdragon');
assert(dragon, 'Elder Dragon must remain present');
assert.deepEqual(dragon, baseline.champions.find(row => row.id === dragon.id), 'Elder Dragon complete record unchanged');
for (const name of ['乐芙兰', '提莫', '黛安娜', '苍蓝雕纹魔像', '婕拉', '拉克丝', '艾希', '绯红印记树怪']) {
  assert.equal(one(champions, name).skill.descriptions_by_star['4'], one(baseline.champions, name).skill.descriptions_by_star['4'], `${name} unmentioned fourth star`);
}
const solar = one(traits, '日蚀骑士');
assert.match(solar.breakpoints[0].effect, /15%【攻击速度】和12【护甲】【魔法抗性】/u);
for (const text of Object.values(solar.text)) assert.match(text, /和12【护甲】【魔法抗性】/u);
assert.equal(one(traits, '黑荆棘').balance_overrides.tank_sacrifice_resistances, 12);
assert.deepEqual(one(traits, '迅捷射手'), one(baseline.traits, '迅捷射手'));
const bounty = one(traits, '赏金猎人').balance_overrides;
assert.equal(bounty.bounty_mapping_status, 'user_declared_deltas_without_inherited_task_rows');
assert.deepEqual(bounty.bounty_changes.map(row => [row.requirement, row.reward]), [
  [{ kind: 'spell_casts', count: 6 }, { kind: 'champion', cost: 4 }],
  [{ kind: 'spell_casts', count: 8 }, { kind: 'shop_refreshes', count: 6 }],
  [{ kind: 'attacks', count: 60 }, { kind: 'champion', cost: 5 }],
  [undefined, { kind: 'gold', amount: 7 }],
  [{ kind: 'damage', amount: 10000 }, { kind: 'gold', amount: 7 }],
  [{ kind: 'kills', count: 8 }, { kind: 'gold', amount: 12 }],
]);
const redResolution = one(champions, '绯红印记树怪').balance_overrides.armor_ignore_patch_resolution;
assert.equal(redResolution.status, 'user_confirmed');
assert.equal(redResolution.resolved_current_formula, '15% + 30% AP');
assert.equal(redResolution.inherited_formula_status, 'unmentioned_high_stars_historical_only');
for (const star of ['1', '2']) assert.match(one(champions, '绯红印记树怪').skill.values_by_star[star], /45% = 15% \+ 30%/u);
assert.deepEqual(redResolution.announced_changes.map(row => [row.from, row.to, row.status]), [
  ['10%', '15%', 'user_confirmed'], ['15+30%', '20+25%', 'superseded_by_user_clarification'],
]);
const small = one(sprites, '小人国');
assert.deepEqual(small.source_variants.map(row => row.id), ['181182', '181183']);
for (const row of [small, ...small.source_variants]) {
  assert.equal(row.enabled, false, `${row.id} disabled`);
  assert.equal(row.availability_status, 'disabled');
  assert.equal(row.disabled_reason, 'temporarily_disabled_in_18_2a');
}
const transformations = sprites.filter(row => /变形术/u.test(row.name));
assert.deepEqual(transformations.map(row => row.id), ['181032', '181036', '181042']);
for (const row of transformations) {
  for (const variant of [row, ...row.source_variants]) {
    assert.equal(variant.offer_conditions.first_sprite_of_preparation_phase_only, true);
    assert.match(variant.description, /仅作为每个准备阶段的第一个自然仙灵出现/u);
    assert.equal(variant.description, variant.effects.source_text);
  }
  assert.equal(row.base_effect, row.source_variants[0].description);
  assert.equal(row.upgrade.effect, row.source_variants[1].description);
  assert.equal(row.upgrade.effects.source_text, row.upgrade.effect);
}

// Optional integration gate: data preservation alone does not prove Host visibility.
const profileIndex = process.argv.indexOf('--core-profile');
const hostFindings = [];
if (profileIndex >= 0) {
  const profileFile = path.resolve(process.argv[profileIndex + 1]);
  const profile = await readJson(profileFile);
  const knowledgeRoot = path.join(repoRoot, 'data/game-knowledge/jcc');
  const bundle = await readJson(path.join(knowledgeRoot, profile.bundle_path));
  assert.equal(path.resolve(repoRoot, bundle.runtime_identity.hard_data_manifest), path.join(root, 'manifest.json'));
  const service = await createDecisionMathService({
    hardDataPackageDir: root, coreProfileFile: profileFile,
    decisionInputCatalogFile: path.join(knowledgeRoot, profile.decision_input_catalog_path),
  });
  for (const [name, source] of [
    ['绯红印记树怪', one(champions, '绯红印记树怪')],
    ['易', one(champions, '易')],
    ['黑荆棘', one(traits, '黑荆棘')],
    ['赏金猎人', one(traits, '赏金猎人')],
  ]) {
    const details = service.queryKnowledge({ entity_names: [name], source_domains: ['core'] }).result.entities;
    assert.deepEqual(one(details, name).details.balance_overrides, source.balance_overrides, `${name} full knowledge retrieval`);
    const projected = one(service.resolveMentionedFacts(name).entities, name);
    if (JSON.stringify(projected.balance_overrides) !== JSON.stringify(source.balance_overrides)) {
      hostFindings.push({ entity: name, path: 'resolveMentionedFacts', issue: 'balance_overrides_missing_or_changed' });
    }
  }
  const projectedSmall = one(service.resolveMentionedFacts('小人国').entities, '小人国');
  if (projectedSmall.enabled !== false || projectedSmall.availability_status !== 'disabled') {
    hostFindings.push({ entity: '小人国', path: 'resolveMentionedFacts', issue: 'disabled_state_missing' });
  }
  for (const row of transformations) {
    const projected = one(service.resolveMentionedFacts(row.name).entities, row.name);
    assert.match(projected.effects.source_text, /仅作为每个准备阶段的第一个自然仙灵出现/u);
  }
}
console.log(JSON.stringify({ok:hostFindings.length === 0,release_version:manifest.release_version,hard_data_generation_id:manifest.hard_data_generation_id,champions:champions.length,traits:traits.length,unchanged_champions:unchangedChampions,comparison:'full_source_rebuild_equals_promoted_18_2_plus_delta',host_projection_checked:profileIndex >= 0,host_findings:hostFindings}));
if (hostFindings.length) process.exitCode = 1;
