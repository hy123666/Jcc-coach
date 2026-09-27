#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverVendoredDocs, stageS18HardData } from './stage-jcc-s18-hard-data.mjs';
import { buildDecisionInputCatalogFromSources } from '../ui/electron/decision-input-catalog.js';
import { normalizedArtifactCount } from './jcc_hard_data_artifact_counts.mjs';

const EXPECTED_FILES = [
  'hard-data-manifest.json', 'indexes/augment_stage_authority.json', 'indexes/champion_damage_profile.json',
  'indexes/champion_item_fit.json', 'indexes/champion_role_profile.json', 'indexes/entity_alias_gateway.json',
  'indexes/entity_strategy_weights.json', 'indexes/item_holder_fit.json', 'indexes/item_holders.json',
  'indexes/item_conflicts.json', 'indexes/component_to_item_candidates.json', 'indexes/item_wait_cost.json',
  'indexes/supplemental_source_audit.json', 'indexes/balance_patch_audit.json', 'indexes/trait_breakpoints.json', 'indexes/trait_unit_matrix.json', 'manifest.json',
  'indexes/trait_diversity_roster_index.json',
  'normalized/augments.json', 'normalized/champions.json', 'normalized/chess_variants.json',
  'normalized/items.json', 'normalized/mechanics_parameters.json',
  'normalized/per_match_variables.json', 'normalized/reward_tables.json', 'normalized/season_mechanics.json', 'normalized/traits.json', 'runtime-catalog-overlay.json',
  'normalized/trait_diversity_roster_support.json',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function rows(count, create) {
  return Array.from({ length: count }, (_, index) => create(index + 1));
}

function catalog(kind, items, source = `${kind}.md`) {
  return {
    schema: 'jcc-s18-source-import-v1', catalog_kind: kind,
    identity: { season_id: 's18', patch_id: 's18_1', mode_id: 'mode18' },
    upstream_provenance: { season_id: 'S19', data_version: '18.18.1', source_document: source, source_sha256: 'a'.repeat(64) },
    count: items.length, items,
  };
}

function proof(kind, ordinal) {
  return { document: `${kind}.md`, document_sha256: 'a'.repeat(64), section: kind, ordinal };
}

function syntheticImportResult() {
  const traits = rows(36, (number) => ({
    official_id: String(2000 + number), name: `Trait ${number}`, kind: number <= 24 ? 'trait' : 'class',
    description: `Trait ${number} description`, tiers: [{ count: 2, level: 1, color: null, effect_text: `Effect ${number}` }], provenance: proof('traits', number),
  }));
  const champions = rows(65, (number) => ({
    official_id: String(1000 + number), mumu_base_id: String(11000 + number), name: `Champion ${number}`, cost: (number % 5) + 1,
    traits: [`Trait ${((number - 1) % 24) + 1}`], classes: [`Trait ${25 + ((number - 1) % 12)}`],
    skill: { name: `Skill ${number}`, effects: { source_text: `Skill effect ${number}` } }, attributes_by_star: {},
    raw_star_ids: [String(11000 + number), String(21000 + number), String(31000 + number)], map_ids: ['1', '2', '3'],
    star_identity: [1, 2, 3].map((star) => ({ star, raw_star_id: String(star * 10000 + 1000 + number), map_id: String(star) })),
    resource_key: `s18_champion_${number}`, provenance: proof('champions', number),
  }));
  const augments = rows(186, (number) => ({
    official_id: String(3000 + number), name: `Augment ${number}`, tier: ((number - 1) % 3) + 1,
    effects: { source_text: `Augment effect ${number}` }, provenance: proof('augments', number),
  }));
  const equipment = rows(151, (number) => ({
    official_id: String(4000 + number), name: number === 10 ? 'Infinity Edge' : `Item ${number}`,
    category: number <= 8 ? '基础装备' : '成型装备', map_id: String(number), icon_key: `item_${number}`,
    stats_source_text: `Stats ${number}`, effects: { source_text: `Item effect ${number}` },
    recipe: number <= 8 ? null : { component_ids: ['4001', '4002'], component_names: ['Item 1', 'Item 2'], formula_source_text: `Item 1 + Item 2 = ${number === 10 ? 'Infinity Edge' : `Item ${number}`}` },
    provenance: proof('equipment', number),
  }));
  const sprites = rows(354, (number) => ({
    official_id: String(5000 + number), sprite_id: String(5000 + number), name: number <= 2 ? 'Duplicate Sprite' : `Sprite ${number}`,
    title: `Sprite title ${number}`, cost: number % 11, effects: { source_text: `Sprite effect ${number}` }, assets: {}, provenance: proof('sprites', number),
  }));
  const catalogs = {
    champions: catalog('champions', champions), traits: catalog('traits', traits, 'champions.md'),
    augments: catalog('augments', augments), equipment: catalog('equipment', equipment), sprites: catalog('sprites', sprites),
  };
  return {
    manifest: { catalogs: Object.fromEntries(Object.entries(catalogs).map(([kind, value]) => [kind, { source_document: value.upstream_provenance.source_document, source_sha256: value.upstream_provenance.source_sha256 }])) },
    catalogs,
  };
}

async function listFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, child));
    else result.push(child);
  }
  return result.sort();
}

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, ...relative.split('/')), 'utf8'));
}

async function compareDirectories(first, second, label = 'staged directories') {
  const firstFiles = await listFiles(first);
  const secondFiles = await listFiles(second);
  assert.ok(EXPECTED_FILES.every((file) => firstFiles.includes(file)), 'every required base artifact must be staged');
  assert.deepEqual(secondFiles, firstFiles);
  const differences = [];
  for (const file of firstFiles) {
    let left;
    let right;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      [left, right] = await Promise.all([readFile(path.join(first, ...file.split('/'))), readFile(path.join(second, ...file.split('/')))]);
      if (left.equals(right)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!left.equals(right)) differences.push({ file, left: sha256(left), right: sha256(right) });
  }
  assert.deepEqual(differences, [], `${label} must be byte-identical across repeated staging`);
}

async function verifyContentManifest(root) {
  const manifestBytes = await readFile(path.join(root, 'hard-data-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(root, ...relativePath.split('/')));
    assert.equal(bytes.byteLength, expected.bytes, `${relativePath} byte size must match the content manifest`);
    assert.equal(sha256(bytes), expected.sha256, `${relativePath} hash must match the content manifest`);
  }
  const packageManifest = await readJson(root, 'manifest.json');
  assert.equal(manifestBytes.byteLength, packageManifest.hard_data_manifest.bytes);
  assert.equal(sha256(manifestBytes), packageManifest.hard_data_manifest.sha256);
}

function assertIdentitySeparation(value, label) {
  assert.deepEqual(value.identity, { season_id: 's18', patch_id: 's18_1', mode_id: 'mode18' }, `${label} local identity`);
  const localView = JSON.stringify({ ...value, upstream_provenance: undefined });
  assert.equal(localView.includes('S19'), false, `${label} must not leak S19 into local identity/content`);
  assert.equal(localView.includes('s17'), false, `${label} must not contain an S17 fallback`);
}

async function verify(root) {
  const manifest = await readJson(root, 'manifest.json');
  const hardData = await readJson(root, 'hard-data-manifest.json');
  const champions = await readJson(root, 'normalized/champions.json');
  const chessVariants = await readJson(root, 'normalized/chess_variants.json');
  const traits = await readJson(root, 'normalized/traits.json');
  const items = await readJson(root, 'normalized/items.json');
  const augments = await readJson(root, 'normalized/augments.json');
  const mechanics = await readJson(root, 'normalized/season_mechanics.json');
  const mechanicsParameters = await readJson(root, 'normalized/mechanics_parameters.json');
  const rewardTables = await readJson(root, 'normalized/reward_tables.json');
  const traitRosterSupport = await readJson(root, 'normalized/trait_diversity_roster_support.json');
  const traitRosterIndex = await readJson(root, 'indexes/trait_diversity_roster_index.json');
  const variables = await readJson(root, 'normalized/per_match_variables.json');
  const aliases = await readJson(root, 'indexes/entity_alias_gateway.json');
  const damageProfiles = await readJson(root, 'indexes/champion_damage_profile.json');
  const roleProfiles = await readJson(root, 'indexes/champion_role_profile.json');
  const championItemFit = await readJson(root, 'indexes/champion_item_fit.json');
  const itemHolderFit = await readJson(root, 'indexes/item_holder_fit.json');
  const itemHolders = await readJson(root, 'indexes/item_holders.json');
  const itemConflicts = await readJson(root, 'indexes/item_conflicts.json');
  const componentCandidates = await readJson(root, 'indexes/component_to_item_candidates.json');
  const itemWaitCost = await readJson(root, 'indexes/item_wait_cost.json');
  const traitBreakpoints = await readJson(root, 'indexes/trait_breakpoints.json');
  const traitUnitMatrix = await readJson(root, 'indexes/trait_unit_matrix.json');
  const strategyWeights = await readJson(root, 'indexes/entity_strategy_weights.json');
  const stages = await readJson(root, 'indexes/augment_stage_authority.json');
  const overlay = await readJson(root, 'runtime-catalog-overlay.json');

  assert.equal(manifest.packageId, 'jcc-s18-s18_1');
  assert.equal(manifest.season, '18');
  assert.equal(manifest.version, '18.18.1');
  assert.equal(manifest.modeName, 'Mode18NatureForce');
  assert.equal(manifest.source_package_id, 'jcc-mode18-s19-18.18.1');
  assert.deepEqual({ mode: manifest.upstream_provenance.mode, season: manifest.upstream_provenance.season, version: manifest.upstream_provenance.version }, { mode: '18', season: 'S19', version: '18.18.1' });
  assert.deepEqual(manifest.upstream_provenance.season_id, 'S19');
  assert.deepEqual(manifest.upstream_provenance.data_version, '18.18.1');
  assert.equal(manifest.promoted, false);
  assert.equal(manifest.rankings_included, false);
  assertIdentitySeparation(manifest, 'manifest');
  assertIdentitySeparation(hardData, 'hard-data manifest');
  assert.deepEqual(hardData.counts, {
    champions: 65, chess_variants: 195, traits: 36, items: 151, augments: 186,
    season_mechanics: 354, per_match_variables: 0, mechanics_parameters: 0,
    reward_tables: 0,
    trait_diversity_roster_support: 0,
    source_entity_mappings: 0,
    balance_patch_audit: 0,
  });
  assert.equal(champions.length, 65); assert.equal(chessVariants.length, 195); assert.equal(traits.length, 36);
  assert.equal(items.length, 151); assert.equal(augments.length, 186);
  assert.ok(champions.every((row) => row.address.startsWith('jcc:s18:champion:') && Array.isArray(row.traits)));
  assert.ok(items.every((row) => row.address.startsWith('jcc:s18:item:') && 'recipe' in row));
  const infinityEdge = items.find((row) => row.name === 'Infinity Edge');
  assert.deepEqual(infinityEdge.recipe.component_ids, ['4001', '4002']);
  assert.match(infinityEdge.recipe.formula_source_text, /Item 1 \+ Item 2/);

  assert.equal(aliases.schema, 'jcc-entity-alias-gateway-v1');
  assert.equal(damageProfiles.length, 65); assert.equal(roleProfiles.length, 65); assert.equal(championItemFit.length, 65);
  assert.equal(itemHolderFit.length, 151); assert.equal(traitBreakpoints.length, 36); assert.equal(traitUnitMatrix.length, 36);
  assert.equal(itemHolders.length, 151); assert.equal(itemConflicts.length, 151);
  assert.ok(componentCandidates.length >= 8 && componentCandidates.filter((row) => row.candidates.length > 0).length >= 2);
  assert.equal(itemWaitCost.length, componentCandidates.length);
  assert.equal(strategyWeights.length, 65 + 36 + 151 + 186);
  assert.ok(roleProfiles.every((row) => row.champion_address.startsWith('jcc:s18:champion:') && row.confidence === 'deterministic_semantic_heuristic'));
  assert.ok(championItemFit.every((row) => Array.isArray(row.item_candidates) && row.item_candidates.length > 0));
  assert.ok(itemHolderFit.every((row) => Array.isArray(row.candidate_holders) && row.candidate_holders.length > 0));
  assert.ok(traitUnitMatrix.every((row) => Array.isArray(row.members) && Array.isArray(row.breakpoints)));
  assert.equal(new Set(strategyWeights.map((row) => row.address)).size, strategyWeights.length, 'strategy-weight addresses must be unique across entity kinds');
  assert.equal(/jcc:s17:/i.test(JSON.stringify({ damageProfiles, roleProfiles, championItemFit, itemHolderFit, traitBreakpoints, traitUnitMatrix, strategyWeights })), false);
  assert.deepEqual(aliases.by_kind_and_name.sprite['duplicatesprite'], ['5001', '5002']);
  assert.deepEqual(aliases.ambiguous_names.find((row) => row.kind === 'sprite' && row.name === 'duplicatesprite')?.ids, ['5001', '5002']);
  const spriteMechanic = mechanics.shop_extensions[0];
  assert.equal(spriteMechanic.kind, 'shop_extension'); assert.equal(spriteMechanic.catalog_kind, 'sprite');
  assert.equal(spriteMechanic.choice_mode, false); assert.equal(spriteMechanic.manual_variable, false); assert.equal(spriteMechanic.entries.length, 354);
  const duplicateSprites = spriteMechanic.entries.filter((row) => row.name === 'Duplicate Sprite');
  assert.deepEqual(duplicateSprites.map((row) => row.id), ['5001', '5002']);
  assert.deepEqual(mechanics.choice_mechanics, []); assert.deepEqual(mechanics.manual_variable_fields, []);
  assert.equal(mechanicsParameters.schema, 'jcc-version-mechanics-parameters-v1');
  assert.equal(mechanicsParameters.provenance.authority, 'common_user_confirmed_standard');
  assert.equal(mechanicsParameters.provenance.common_source.logical_id, 'common.standard_game_baseline');
  assert.match(mechanicsParameters.provenance.common_source.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal('inherited_from' in mechanicsParameters.provenance, false);
  assert.deepEqual(mechanicsParameters.standard_merge_rule.base_copies_by_star, { '1': 1, '2': 3, '3': 9 });
  assert.deepEqual(mechanicsParameters.shop.pool_by_cost, { '1': 30, '2': 25, '3': 18, '4': 10, '5': 9 });
  assert.deepEqual(mechanicsParameters.shop.odds_by_level['8'], [15, 20, 32, 30, 3]);
  assert.equal(mechanicsParameters.player_damage.base_damage_by_stage['5'], 10);
  assert.equal(mechanicsParameters.augment_tier_sequence_probabilities.first_choice_tier_distribution.tiers[0].probability_fraction, '1/3');
  assert.deepEqual(rewardTables.entity_tables, []);
  assert.deepEqual(rewardTables.season_tables, []);
  assert.deepEqual(rewardTables.supplemental_unbound_tables, []);
  assert.equal(traitRosterSupport.counts.source_candidate_rows, 0);
  assert.deepEqual(traitRosterSupport.group_shards, []);
  assert.equal(traitRosterIndex.available, false);
  assert.equal(mechanicsParameters.economy.streak_bonus.find((row) => row.min_streak === 5).gold, 2);
  assert.deepEqual(variables.variables, []); assert.deepEqual(variables.prompt_at_match_start, []);
  assert.deepEqual(stages.augment_stage_bindings, []); assert.deepEqual(stages.generated_augments, []);
  assert.match(stages.authority_source, /s18_source_docs/); assert.equal(/s17/i.test(JSON.stringify(stages)), false);
  assert.equal(overlay.schema, 'jcc-runtime-catalog-overlay-v1');
  assert.ok(Object.keys(overlay.champions_by_id).length >= 65);
  assert.equal(Object.keys(overlay.items_by_id).length, 151);
  assert.ok(Object.keys(hardData.files).every((file) => !/rank/i.test(file)), 'content manifest must not reference rankings');

  const decisionCatalog = buildDecisionInputCatalogFromSources({
    seasonId: 's18', activePatchId: 's18_1', manifest: hardData,
    augments, items, entityAliasGateway: aliases, augmentStageAuthority: stages,
    normalRules: { choice_mechanics: [{ kind: 'augment', stages: ['2-1', '3-2', '4-2'] }] },
    specialRules: { mechanics: { choice_mechanics: [] } },
  });
  assert.equal(decisionCatalog.schema, 'jcc-decision-input-catalog-v1');
  assert.equal(decisionCatalog.counts.augment, 186); assert.equal(decisionCatalog.counts.item, 151);
  assert.equal(decisionCatalog.choice_descriptors.star_god, undefined); assert.equal(decisionCatalog.by_kind.god_reward, undefined);
  assert.equal(decisionCatalog.choice_descriptors.augment.unknown_round.length, 186);
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const root = await mkdtemp(path.join(os.tmpdir(), 'jcc-s18-hard-data-staging-'));
  try {
    const importResult = syntheticImportResult();
    const emptyItemUsageTaxonomy = {
      schema: 'jcc-patch-item-usage-taxonomy-v1',
      identity: { season_id: 's18', patch_id: 's18_1' },
      authority: 'synthetic_test_fixture',
      entries: [],
    };
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const importBefore = JSON.stringify(importResult);
    const syntheticPatchManifest = {
      season_id: 's18',
      patch_id: 's18_1',
      upstream_source: {
        mode: '18',
        season_id: 'S19',
        data_version: '18.18.1',
        catalog_counts: Object.fromEntries(Object.entries(importResult.catalogs).map(([kind, catalog]) => [kind, catalog.items.length])),
      },
      source_entity_mappings: {
        champion_aliases: [],
        champion_variants: [],
        champion_runtime_semantics: [],
      },
    };
    await stageS18HardData({ outDir: first, importResult, itemUsageTaxonomy: emptyItemUsageTaxonomy, patchSourceManifest: syntheticPatchManifest });
    assert.equal(JSON.stringify(importResult), importBefore, 'staging must not mutate a caller-owned import result');
    await stageS18HardData({ outDir: second, importResult, itemUsageTaxonomy: emptyItemUsageTaxonomy, patchSourceManifest: syntheticPatchManifest });
    await compareDirectories(first, second, 'synthetic staging outputs');
    await verify(first);
    const docs = await discoverVendoredDocs(repoRoot);
    assert.deepEqual(Object.keys(docs).sort(), ['augmentsDoc', 'championsDoc', 'equipmentDoc', 'spritesDoc']);
    const actualFirst = path.join(root, 'actual-first');
    const actualSecond = path.join(root, 'actual-second');
    const patchManifestFile = path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json');
    const patchManifest = JSON.parse(await readFile(patchManifestFile, 'utf8'));
    const balancePatch = JSON.parse(await readFile(path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/balance-changes-18.1b.json'), 'utf8'));
    await stageS18HardData({ ...docs, outDir: actualFirst, patchSourceManifest: patchManifest, balancePatch });
    await stageS18HardData({ ...docs, outDir: actualSecond, patchSourceManifest: patchManifest, balancePatch });
    await compareDirectories(actualFirst, actualSecond, 'vendored-document staging outputs');
    const seasonDescriptor = JSON.parse(await readFile(path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s18/season-descriptor.json'), 'utf8'));
    const grandElementalist = seasonDescriptor.mechanics.find((row) => row.id === 'season_mechanic.grand_elementalist');
    assert.equal(grandElementalist.canonical_entity_id, '5459');
    assert.equal(grandElementalist.selected_trait_contribution, 2);
    assert.deepEqual(grandElementalist.variant_order, ['黑荆棘', '灵魂莲华', '魔女', '永恒之森', '花仙子', '地狱火', '月蚀骑士', '野兽之灵', '日蚀骑士']);
    assert.equal(grandElementalist.shop_conversion.trigger, 'own_one_grand_elementalist_on_board_or_bench');
    const currentManifestPath = patchManifest.source_artifacts.find((row) => row.role === 'hard_data_manifest')?.path;
    assert.match(currentManifestPath || '', /^data\/core-patches\/jcc\/generations\/[a-f0-9]{64}\/manifest\.json$/);
    const currentPackageDir = path.dirname(path.join(repoRoot, currentManifestPath));
    await assert.rejects(
      stageS18HardData({ ...docs, outDir: currentPackageDir }),
      /immutable generations are publisher-owned/,
      'the source adapter must reject direct writes to a published generation',
    );
    assert.equal(
      (await readJson(currentPackageDir, 'manifest.json')).hard_data_generation_id,
      path.basename(currentPackageDir),
      'the published hard-data generation must remain content-addressed and immutable',
    );
    await verifyContentManifest(actualFirst);
    await verifyContentManifest(currentPackageDir);
    const actualAliases = await readJson(actualFirst, 'indexes/entity_alias_gateway.json');
    const actualHardData = await readJson(actualFirst, 'hard-data-manifest.json');
    const actualAugments = await readJson(actualFirst, 'normalized/augments.json');
    const actualMechanics = await readJson(actualFirst, 'normalized/season_mechanics.json');
    const actualMechanicsParameters = await readJson(actualFirst, 'normalized/mechanics_parameters.json');
    const actualRewardTables = await readJson(actualFirst, 'normalized/reward_tables.json');
    const actualTraitRosterSupport = await readJson(actualFirst, 'normalized/trait_diversity_roster_support.json');
    const actualTraitRosterIndex = await readJson(actualFirst, 'indexes/trait_diversity_roster_index.json');
    const actualStageAuthority = await readJson(actualFirst, 'indexes/augment_stage_authority.json');
  const actualSupplementalAudit = await readJson(actualFirst, 'indexes/supplemental_source_audit.json');
    const actualBalancePatchAudit = await readJson(actualFirst, 'indexes/balance_patch_audit.json');
    assert.deepEqual(actualHardData.counts, {
      champions: 65, chess_variants: 260, traits: 36, items: 151, augments: 261,
      season_mechanics: 176, per_match_variables: 0, mechanics_parameters: 0,
      reward_tables: 15,
      trait_diversity_roster_support: 7,
      source_entity_mappings: 11,
      balance_patch_audit: 81,
    });
    assert.equal(actualBalancePatchAudit.schema, 'jcc-core-balance-patch-audit-v1');
    assert.equal(actualBalancePatchAudit.release_version, '18.1b');
    assert.equal(actualBalancePatchAudit.applied_operations, 81);
    assert.equal(actualAugments.length, 261);
    assert.equal(actualMechanicsParameters.augment_tier_sequence_probabilities.rows.length, 18);
    assert.equal(actualMechanicsParameters.progression.xp_to_next_level['7'], 56);
    assert.equal(actualMechanicsParameters.player_damage.base_damage_by_stage['5'], 10);
    assert.equal(actualMechanicsParameters.augment_tier_sequence_probabilities.first_choice_tier_distribution.tiers.length, 3);
    assert.equal(actualMechanicsParameters.shop.pool_by_cost['1'], 30);
    assert.deepEqual(actualMechanicsParameters.shop.odds_by_level['8'], [15, 20, 32, 30, 3]);
    assert.equal(actualRewardTables.entity_tables.length, 11);
    assert.equal(actualRewardTables.season_tables.length, 4);
    assert.deepEqual(actualRewardTables.supplemental_unbound_tables, []);
    assert.equal(normalizedArtifactCount('reward_tables', actualRewardTables), 15);
    assert.equal(actualRewardTables.exclusions.some((row) => row.source_key === '战利品订阅'), true);
    assert.equal(actualTraitRosterSupport.counts.source_candidate_rows, 43);
    assert.equal(actualTraitRosterSupport.counts.unit_slot_occurrences, 347);
    assert.equal(actualTraitRosterSupport.counts.unique_champion_entities_used, 32);
    assert.equal(actualTraitRosterSupport.counts.catalog_champion_entities, 65);
    assert.equal(actualTraitRosterSupport.counts.augment_bindings, 3);
    assert.equal(actualTraitRosterSupport.group_shards.length, 7);
    assert.deepEqual(actualTraitRosterSupport.support_keys.map((row) => row.support_key), ['none']);
    assert.equal(actualTraitRosterIndex.available, true);
    assert.equal(Object.keys(actualTraitRosterIndex.groups).length, 7);
    assert.equal(actualTraitRosterSupport.policy.rosters_are_atomic_and_must_not_be_spliced, true);
    assert.equal(actualTraitRosterSupport.policy.runtime_online_fetch_forbidden, true);
    assert.equal('roster_groups' in actualTraitRosterSupport, false, 'the support descriptor must not inline all candidate rows');
    for (const shardRef of actualTraitRosterSupport.group_shards) {
      const shard = await readJson(actualFirst, shardRef.relative_path);
      assert.equal(shard.schema, 'jcc-trait-diversity-roster-shard-v2');
      assert.equal(shard.rosters.length, shardRef.source_candidate_rows);
      assert.ok(shard.rosters.every((roster) => (
        roster.champion_ids.length === shard.population
        && new Set(roster.champion_ids).size === shard.population
        && Number.isInteger(roster.metrics.high_cost_unit_count)
        && Number.isInteger(roster.metrics.four_cost_unit_count)
        && Number.isInteger(roster.metrics.five_cost_unit_count)
      )));
    }
    const populationEightRef = actualTraitRosterSupport.group_shards.find((row) => row.population === 8);
    const populationEight = await readJson(actualFirst, populationEightRef.relative_path);
    assert.equal(populationEightRef.objective_views.trait_ladder_reward_progress.primary_roster_ids.length, 4);
    assert.equal(populationEightRef.objective_views.trait_ladder_reward_progress.accessibility_fallback_roster_ids.length, 1);
    assert.equal(populationEightRef.objective_views.bronze_trait_scaling.primary_roster_ids.length, 2);
    assert.equal(populationEightRef.objective_views.bronze_trait_scaling.accessibility_fallback_roster_ids.length, 3);
    assert.ok(populationEight.rosters.every((roster) => (
      Array.isArray(roster.next_population_transitions_by_objective.trait_ladder_reward_progress)
      && Array.isArray(roster.next_population_transitions_by_objective.bronze_trait_scaling)
    )));
    const populationFourRef = actualTraitRosterSupport.group_shards.find((row) => row.population === 4);
    const populationFour = await readJson(actualFirst, populationFourRef.relative_path);
    assert.equal(populationFourRef.role_constraint_status, 'unavailable_at_population');
    assert.ok(populationFour.rosters.some((roster) => (
      roster.next_population_transitions_by_objective.trait_ladder_reward_progress[0]?.status === 'degraded_transition'
    )));
    for (const [name, objective] of [
      ['拼盘天梯', 'trait_ladder_reward_progress'],
      ['终身黄铜 I', 'bronze_trait_scaling'],
      ['终身黄铜 II', 'bronze_trait_scaling'],
    ]) {
      const augment = actualAugments.find((row) => row.name === name);
      assert.equal(augment?.trait_roster_support_ref, 's18_1:trait_diversity_rosters');
      assert.equal(augment?.trait_roster_objective_id, objective);
      assert.equal('rosters' in augment, false, `${name} must reference the shared roster support instead of copying it inline`);
    }
    const standUnited = actualAugments.find((row) => row.name === '并肩作战 I');
    assert.equal(standUnited?.trait_roster_support_ref, undefined, '并肩作战 I must remain a normal augment without companion roster support');
    assert.equal(JSON.stringify(actualRewardTables).includes('战利品订阅'), true, 'excluded source must remain auditable');
    assert.equal(actualRewardTables.entity_tables.some((table) => table.entity_ref.name === '战利品订阅'), false);
    assert.equal(actualRewardTables.season_tables.some((table) => table.name === '战利品订阅'), false);
    const covenRewards = actualRewardTables.entity_tables.find((table) => table.entity_ref.kind === 'trait' && table.entity_ref.name === '魔女');
    const traitRows = await readJson(actualFirst, 'normalized/traits.json');
    assert.equal(covenRewards.entity_ref.id, traitRows.find((row) => row.name === '魔女')?.id);
    assert.deepEqual(covenRewards.groups.map((group) => group.label), ['40', '85', '130', '185', '250', '365', '500', '650', '800']);
    assert.equal(traitRows.find((row) => row.name === '魔女')?.reward_table_ref, covenRewards.table_id);
    assert.deepEqual(actualRewardTables.season_tables.map((table) => table.name), ['灰色法球', '蓝色法球', '金色法球', '棱彩法球']);
    for (const table of [...actualRewardTables.entity_tables, ...actualRewardTables.season_tables, ...actualRewardTables.supplemental_unbound_tables]) {
      for (const group of table.groups) {
        assert.ok(group.outcomes.every((outcome) => outcome.rewards.length > 0));
      }
    }
    assert.equal(actualMechanics.shop_extensions[0].entries.length, 176);
    assert.equal(actualStageAuthority.authority_source, 'datatft_s18_database_snapshot');
    assert.equal(actualStageAuthority.augment_stage_bindings.length, 246);
    assert.deepEqual(actualStageAuthority.category_definitions.map((entry) => entry.id), ['economy', 'combat', 'equipment', 'synergy', 'exclusive', 'other']);
    assert.equal(actualSupplementalAudit.status, 'compared_and_merged');
    assert.equal(actualSupplementalAudit.coverage.augments.official, 261);
    assert.equal(actualSupplementalAudit.coverage.augments.supplemental, 256);
    assert.equal(actualSupplementalAudit.coverage.augments.matched, 247);
    assert.equal(actualSupplementalAudit.coverage.augments.matched_entities, 246);
    assert.equal(actualSupplementalAudit.coverage.augments.stage_bound, 246);
    assert.equal(actualSupplementalAudit.coverage.augments.final_catalog, 261);
    assert.equal(actualSupplementalAudit.coverage.augments.official_only.length, 15);
    assert.equal(actualSupplementalAudit.coverage.augments.official_only_search_only, 15);
    assert.equal(actualSupplementalAudit.coverage.augments.discarded_unofficial.length, 9);
    assert.ok(actualSupplementalAudit.coverage.augments.discarded_unofficial.every((row) => row.review_status === 'reviewed_not_equivalent' && row.reason));
    assert.deepEqual(
      actualSupplementalAudit.coverage.augments.discarded_unofficial.map((row) => row.name).sort(),
      ['战时补给：女神之泪', '星界恩典I', '白银命运', '集中火力', '挑个好伙计！', '意外之礼', '意外之礼+', '新纪元', '绝境反击'].sort(),
    );
    const forgedStrength = actualAugments.find((row) => row.name === '神力天铸');
    assert.equal(forgedStrength?.id, 'datatft:DA_ForgedInStrength');
    assert.deepEqual(forgedStrength?.rounds, ['2-1']);
    assert.deepEqual(forgedStrength?.category_ids, ['equipment']);
    assert.ok(forgedStrength?.tags.includes('condition:health_threshold_35'));
    assert.equal(
      actualStageAuthority.augment_stage_bindings.find((row) => row.id === forgedStrength.id)?.authority,
      'developer_confirmed_s18_patch_extension_from_frozen_supplement',
    );
    assert.ok(actualStageAuthority.augment_stage_bindings.every((row) => row.rounds.every((round) => ['2-1', '3-2', '4-2'].includes(round))));
    for (const [name, rounds] of [
      ['锻造挚友', ['4-2']],
      ['新纪元+', ['3-2']],
    ]) {
      const augment = actualAugments.find((row) => row.name === name);
      assert.deepEqual(augment?.rounds, rounds);
      assert.equal(
        actualStageAuthority.augment_stage_bindings.find((row) => row.id === augment.id)?.authority,
        'datatft_supplemental_verified_snapshot',
      );
    }
    for (const name of ['战时补给：女神之泪', '星界恩典I', '集中火力', '意外之礼', '意外之礼+', '绝境反击']) {
      assert.equal(actualAugments.some((row) => row.name === name), false, `${name} must remain outside the official production catalog`);
    }
    const carryAwareness = actualAugments.find((row) => row.name === '核心位的觉悟');
    assert.deepEqual(carryAwareness.rounds, ['3-2', '4-2']);
    assert.deepEqual(carryAwareness.category_ids, ['combat', 'other']);
    assert.deepEqual(carryAwareness.category_labels, ['战力', '其他']);
    const lightMagicRoll = actualAugments.find((row) => row.name === '轻量魔法投掷');
    assert.equal(lightMagicRoll.id, '10559');
    assert.deepEqual(lightMagicRoll.rounds, ['2-1']);
    assert.equal(lightMagicRoll.reward_table_ref, 'augment:10559:rewards');
    assert.equal(
      actualRewardTables.entity_tables.find((table) => table.entity_ref.id === '10559')?.entity_ref?.name,
      '轻量魔法投掷',
    );
    for (const [officialName, datatftName, rounds] of [
      ['8级嘀干的传说', '8级D干的传说', ['3-2']],
      ['纹章树', '羁绊树', ['2-1']],
      ['纹章树+', '羁绊树+', ['3-2']],
    ]) {
      const augment = actualAugments.find((row) => row.name === officialName);
      assert.ok(augment.aliases.includes(datatftName));
      assert.deepEqual(augment.rounds, rounds);
      assert.equal(augment.supplemental_source.identity_match.kind, 'source_asset_and_effect_signature');
    }
    const epoch = actualAugments.find((row) => row.name === '新纪元+');
    assert.equal(epoch.supplemental_source.external_id, 'DA_EpochPlus');
    assert.equal(epoch.supplemental_source.equivalent_variants.length, 0, 'the lower-value base version must not alias the official plus version');
    const discardedEpoch = actualSupplementalAudit.coverage.augments.discarded_unofficial.find((row) => row.id === 'DA_Epoch');
    assert.equal(discardedEpoch.reason, 'same_resource_identity_but_effect_numbers_differ');
    assert.equal(discardedEpoch.nearest_official.name, '新纪元+');
    const radiantRascal = actualAugments.find((row) => row.name === '交给运气');
    assert.ok(radiantRascal.aliases.includes('光明无赖'));
    assert.equal(radiantRascal.supplemental_source.equivalent_variants[0].external_id, 'DA_RadiantRascal');
    assert.equal(
      radiantRascal.supplemental_source.equivalent_variants[0].identity_match.kind,
      'source_asset_and_effect_signature_alias',
    );
    const officialAugmentAliases = [
      ['嘀嘀街区', 'DD街区', '2069'],
      ['嘀嘀街区加强版', 'DD街区+', '3069'],
      ['锅铲厨房', '金铲铲厨房', '30187'],
      ['灵活摇摆', '灵活', '40006'],
      ['核心位的觉悟', 'C位的觉悟', '10048'],
      ['金鳞精粹', '金鳞精萃', '30045'],
    ];
    for (const [officialName, supplementalName, officialId] of officialAugmentAliases) {
      const augment = actualAugments.find((row) => row.name === officialName);
      assert.equal(augment?.id, officialId);
      assert.ok(augment.aliases.includes(supplementalName));
      assert.deepEqual(actualAliases.lookup[`augment:${supplementalName.toLowerCase()}`]?.ids, [officialId]);
      assert.equal(
        actualAugments.some((row) => row.name === supplementalName && row.id !== officialId),
        false,
        `${supplementalName} must remain an alias of the official canonical augment`,
      );
    }
    const arcaneGangTwo = actualAugments.find((row) => row.name === '秘法帮派 II');
    assert.equal(arcaneGangTwo.source, 'jcc_official_mode18_augment_snapshot');
    assert.equal(arcaneGangTwo.supplemental_source?.hex_id, 'DA_BandOfThievesII');
    assert.equal(arcaneGangTwo.supplemental_source?.identity_match?.kind, 'source_family_alias');
    assert.ok(arcaneGangTwo.aliases.includes('窃贼帮派 II'));
    assert.deepEqual(actualAliases.lookup['augment:窃贼帮派ii']?.ids, ['3068']);
    assert.equal(actualAliases.lookup['augment:窃贼帮派ii']?.r?.[0]?.entity_name, '秘法帮派 II');
    assert.equal(actualAugments.some((row) => row.id === 'datatft:DA_BandOfThievesII'), false);
    assert.equal(actualAugments.some((row) => row.id === 'datatft:DA_BandOfThievesIIPlus'), false);
    assert.equal(actualAugments.some((row) => row.id === 'datatft:DA_BandOfThievesIIPlusPlus'), false);
    assert.deepEqual(actualAliases.by_kind_and_name.sprite['抛硬币'], ['181008']);
    const coinFlipSprite = actualMechanics.shop_extensions[0].entries.find((row) => row.name === '抛硬币');
    assert.deepEqual(coinFlipSprite.source_variants.map((row) => row.id), ['181008', '181009']);
    assert.ok(coinFlipSprite.upgrade?.effect, 'the upgraded effect must stay attached to the canonical nature-sprite entity');
    const renamedSupplement = JSON.parse(await readFile(
      path.join(repoRoot, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-database.json'),
      'utf8',
    ));
    const renamedCoinFlip = renamedSupplement.catalogs.nature_sprites.find((row) => row.title === '抛硬币');
    renamedCoinFlip.title = 'DataTFT 抛硬币别名';
    const renamedSpriteOut = path.join(root, 'renamed-sprite-source');
    await stageS18HardData({ ...docs, outDir: renamedSpriteOut, supplementalSnapshot: renamedSupplement });
    const renamedMechanics = await readJson(renamedSpriteOut, 'normalized/season_mechanics.json');
    const renamedCanonical = renamedMechanics.shop_extensions[0].entries.find((row) => row.name === '抛硬币');
    assert.equal(renamedCanonical.supplemental_source.identity_match.kind, 'exact_lifecycle_content');
    assert.ok(renamedCanonical.aliases.includes('DataTFT 抛硬币别名'));
    assert.equal(renamedMechanics.shop_extensions[0].entries.some((row) => row.name === 'DataTFT 抛硬币别名'), false);
    for (const sprite of actualMechanics.shop_extensions[0].entries) {
      assert.deepEqual(Object.values(sprite.stage_groups || {}).flat(), sprite.available_rounds, `${sprite.name} stage groups must cover all available rounds`);
      assert.ok(sprite.available_rounds.every((round) => {
        const [stage, subround] = round.split('-').map(Number);
        return stage < 8 || (stage === 8 && subround <= 1);
      }), `${sprite.name} must not expose a nature-sprite round after 8-1`);
    }
    for (const sprite of actualMechanics.shop_extensions[0].entries.filter((row) => row.source_variants.length)) {
      const [baseVariant, upgradeVariant, prismaticVariant] = sprite.source_variants;
      assert.equal(sprite.cost, baseVariant.cost, `${sprite.name} must keep the normalized base cost aligned with its base variant`);
      assert.equal(sprite.base_effect, baseVariant.description, `${sprite.name} must preserve the official base effect`);
      assert.equal(sprite.upgrade?.cost ?? null, upgradeVariant?.cost ?? null, `${sprite.name} must preserve the official upgrade cost`);
      assert.equal(sprite.upgrade?.effect ?? null, upgradeVariant?.description ?? null, `${sprite.name} must preserve the official upgrade effect`);
      assert.equal(sprite.prismatic?.cost ?? null, prismaticVariant?.cost ?? null, `${sprite.name} must preserve the official prismatic cost`);
      assert.equal(sprite.prismatic?.effect ?? null, prismaticVariant?.description ?? null, `${sprite.name} must preserve the official prismatic effect`);
    }
    assert.ok(
      actualSupplementalAudit.conflicts.nature_sprite_effects_and_costs.length > 0,
      'supplemental sprite conflicts must remain explicit audit evidence',
    );
    assert.deepEqual(actualAliases.by_kind_and_name.item['绝命花妖纹章'], ['41810', '41821']);
    const actualOverlay = await readJson(actualFirst, 'runtime-catalog-overlay.json');
    assert.equal(actualOverlay.champions_by_id['11500'].name, '奥恩');
    assert.equal(actualOverlay.champions_by_id['11500'].canonical_id, '1500');
    const ornnTraitCodes = actualOverlay.champions_by_id['11500'].class_or_trait_codes.split('|').filter(Boolean);
    assert.ok(ornnTraitCodes.length > 0);
    assert.ok(ornnTraitCodes.every((code) => actualOverlay.traits_by_id[code]?.code_id === code));
    assert.ok(ornnTraitCodes.every((code) => typeof actualOverlay.traits_by_id[code]?.breakpoints === 'string'));
    assert.ok(ornnTraitCodes.every((code) => /^https:\/\//.test(actualOverlay.traits_by_id[code]?.icon_url)));
    const firstAugment = Object.values(actualOverlay.augments_by_id)[0];
    assert.ok(firstAugment.tier && firstAugment.source && 'icon_url' in firstAugment);
    const actualItems = await readJson(actualFirst, 'normalized/items.json');
    assert.ok(actualItems.some((item) => item.effects?.structured_terms?.length > 0));
    const actualComponentCandidates = await readJson(actualFirst, 'indexes/component_to_item_candidates.json');
    assert.equal(actualComponentCandidates.length, 10);
    assert.ok(actualComponentCandidates.every((row) => row.candidates.length > 0));
    assert.equal(patchManifest.activation_blockers.includes('compatible_master_plus_rankings_unavailable'), false);
    assert.equal(patchManifest.activation_blockers.includes('mode18_mumu_runtime_mapping_not_live_verified'), false);
    assert.equal(patchManifest.known_limitations.some((entry) => entry.includes('15468')), false);
    assert.deepEqual(patchManifest.runtime_mapping_validation?.allowed_unresolved_shop_only_ids, []);
    assert.equal(actualOverlay.champions_by_id['14514'].canonical_id, '4501');
    assert.equal(actualOverlay.champions_by_id['14514'].name, '莫甘娜');
    assert.equal(actualOverlay.champions_by_id['15460'].canonical_id, '5452');
    assert.equal(actualOverlay.champions_by_id['15460'].name, '纳尔');
    for (let sourceId = 15461; sourceId <= 15469; sourceId += 1) {
      assert.equal(actualOverlay.champions_by_id[String(sourceId)].canonical_id, '5459');
      assert.equal(actualOverlay.champions_by_id[String(sourceId)].name, '拉克丝');
      assert.equal(actualOverlay.champions_by_id[String(sourceId)].source_variant.order, sourceId - 15460);
    }
    assert.equal(actualOverlay.champions_by_id['15462'].source_variant.trait_name, '灵魂莲华');
    assert.equal(actualOverlay.champions_by_id['15463'].source_variant.trait_name, '魔女');
    assert.equal(actualOverlay.champions_by_id['15468'].source_variant.trait_name, '野兽之灵');
    const sourceMappings = await readJson(actualFirst, 'normalized/source_entity_mappings.json');
    assert.deepEqual(sourceMappings.counts, { champion_aliases: 2, champion_variants: 9, champion_mappings: 11 });
    assert.equal(
      patchManifest.known_limitations.includes('master_plus_rankings_not_yet_published_runtime_uses_ranking_unavailable'),
      false,
    );
    assert.equal(patchManifest.activation_blockers.includes('official_augment_stage_authority_unavailable'), false);
    assert.equal(patchManifest.known_limitations.includes('official_augment_stage_authority_unavailable_search_and_manual_analysis_remain_supported'), false);
    assert.equal(patchManifest.source_adapter.id, 'official_primary_datatft_enrichment_mode18_v8');
    assert.equal(patchManifest.release_version, '18.1b');
    assert.equal(patchManifest.parent_core_generation_id, 'ecfb536b6aacecb34ff92b0d2e52042e69a42e8ece3392ee1ca7f24b703abb19');
    assert.equal(patchManifest.balance_patch?.release_version, '18.1b');
    assert.equal(patchManifest.balance_patch?.baseline?.hard_data_generation_id, patchManifest.parent_core_generation_id);
    assert.equal(patchManifest.offline_core_supplement_sources?.datatft_s18_frozen?.production_core_input, true);
    assert.equal(patchManifest.hard_data_candidate?.immutable, true);
    assert.equal(path.basename(currentPackageDir), patchManifest.hard_data_candidate?.generation_id);
    const candidate = JSON.parse(await readFile(path.join(repoRoot, 'data/game-knowledge/jcc/candidates/candidate-profile.json'), 'utf8'));
    assert.equal(candidate.season_id, 's18');
    assert.deepEqual(candidate.activation_blockers, [...patchManifest.activation_blockers].sort());
    process.stdout.write(`${JSON.stringify({ ok: true, deterministic_files: (await listFiles(actualFirst)).length, counts: { champions: 65, traits: 36, official_augments: 261, runtime_augments: 261, equipment: 151, sprites: 176 }, assertions: ['determinism', 'real source documents', 'current official augment catalog authority', 'developer-confirmed bounded patch augment extension', 'identity separation', 'multi-key MuMu champion mapping', 'patch source aliases and Grand Elementalist variants', 'Grand Elementalist major-season behavior', 'duplicate names', 'recipes', 'structured effects', 'DataTFT stage and category enrichment for matched official augments only', 'unmatched supplemental augments discarded', 'official augment names with DataTFT aliases', 'resource-and-effect-signature alias recovery', 'different-number effects do not merge', 'canonical nature-sprite lifecycle through 8-1', 'official nature-sprite names with exact lifecycle alias fallback', 'source-declared augment family aliases', 'separate matched, stage-bound, search-only, and final-catalog counts', 'no S17 fallback', 'empty S18 manual variables', 'runtime decision indexes', 'compiler-required shapes', 'sprites are shop extensions', 'live MuMu mapping receipt', 'release blockers propagated to candidate', 'current Ranking capability is not mislabeled unavailable'] })}\n`);
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    if (process.env.JCC_KEEP_TEST_ARTIFACTS === '1') process.stderr.write(`kept test artifacts: ${resolved}\n`);
    else await rm(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
