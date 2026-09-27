#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { importS18SourceDocs } from './import-jcc-s18-source-docs.mjs';

const FILES = Object.freeze([
  'manifest.json',
  'champions.json',
  'traits.json',
  'augments.json',
  'equipment.json',
  'sprites.json',
]);

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    assert.match(token, /^--[^=]+(?:=.*)?$/, `Unexpected argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals !== -1) {
      values.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value for ${token}`);
    values.set(token.slice(2), argv[index + 1]);
    index += 1;
  }
  const required = (name) => {
    const value = values.get(name);
    assert.ok(value, `Missing required argument --${name}`);
    return value;
  };
  return {
    championsDoc: required('champions-doc'),
    augmentsDoc: required('augments-doc'),
    spritesDoc: required('sprites-doc'),
    equipmentDoc: required('equipment-doc'),
    seasonId: values.get('season-id') ?? 's18',
    patchId: values.get('patch-id') ?? 's18_1',
    modeId: values.get('mode-id') ?? 'mode18',
    upstreamSeasonId: values.get('upstream-season-id') ?? 'S19',
    upstreamVersion: values.get('upstream-version') ?? '18.18.1',
    patchSourceManifest: values.get('patch-source-manifest')
      ?? 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json',
  };
}

async function readJson(directory, filename) {
  return JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
}

function itemNamed(catalog, name) {
  const matches = catalog.items.filter((item) => item.name === name);
  assert.equal(matches.length, 1, `Expected exactly one ${catalog.catalog_kind} named ${name}`);
  return matches[0];
}

async function assertStableOutput(firstDirectory, secondDirectory) {
  assert.deepEqual((await readdir(firstDirectory)).sort(), [...FILES].sort());
  assert.deepEqual((await readdir(secondDirectory)).sort(), [...FILES].sort());
  for (const filename of FILES) {
    const [first, second] = await Promise.all([
      readFile(path.join(firstDirectory, filename)),
      readFile(path.join(secondDirectory, filename)),
    ]);
    assert.ok(first.equals(second), `${filename} is not byte-stable across repeated imports`);
  }
}

function assertCatalogContract(manifest, catalogs, options) {
  assert.deepEqual(manifest.identity, {
    season_id: options.seasonId,
    patch_id: options.patchId,
    mode_id: options.modeId,
  });
  assert.deepEqual(manifest.upstream_provenance, {
    season_id: options.upstreamSeasonId,
    data_version: options.upstreamVersion,
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalogs).map(([kind, catalog]) => [kind, catalog.count])),
    options.expectedCounts,
  );
  for (const catalog of Object.values(catalogs)) {
    assert.deepEqual(catalog.identity, {
      season_id: options.seasonId,
      patch_id: options.patchId,
      mode_id: options.modeId,
    });
    assert.equal(catalog.upstream_provenance.season_id, options.upstreamSeasonId);
    assert.equal(catalog.upstream_provenance.data_version, options.upstreamVersion);
    assert.match(catalog.upstream_provenance.source_sha256, /^[a-f0-9]{64}$/);
    assert.ok(catalog.items.every((item) => item.source_text.length > 0));
    assert.ok(catalog.items.every((item) => item.provenance.document_sha256 === catalog.upstream_provenance.source_sha256));
  }
}

function assertChampionIdentity(champions) {
  const ornn = itemNamed(champions, '奥恩');
  assert.deepEqual({
    identity: ornn.identity,
    official_id: ornn.official_id,
    mumu_base_id: ornn.mumu_base_id,
    raw_star_ids: ornn.raw_star_ids,
    map_ids: ornn.map_ids,
    resource_key: ornn.resource_key,
  }, {
    identity: 'champion:1500',
    official_id: '1500',
    mumu_base_id: '11500',
    raw_star_ids: ['11500', '21500', '31500', '41500'],
    map_ids: ['1', '2', '3', '4'],
    resource_key: 's18_ornn',
  });
  assert.deepEqual(ornn.star_identity[0], { star: 1, raw_star_id: '11500', map_id: '1' });
  assert.equal(ornn.skill.effects.source_text.includes('持续4秒'), true);
  assert.notEqual(ornn.skill.effects.parse_status, 'exact', 'Timed champion skill must retain conditional semantics');
}

function assertTraits(traits) {
  assert.equal(traits.items.filter((item) => item.kind === 'trait').length, 24);
  assert.equal(traits.items.filter((item) => item.kind === 'class').length, 12);
  const executioner = itemNamed(traits, '裁决使');
  assert.equal(executioner.tiers.find((tier) => tier.count === 4)?.color, null);
}

function assertTimedAugment(augments) {
  const partialAscension = itemNamed(augments, '部分飞升');
  assert.equal(partialAscension.official_id, '1021');
  assert.equal(partialAscension.effects.parse_status, 'conditional');
  assert.match(partialAscension.effects.source_text, /战斗开始12秒后/);
  assert.ok(partialAscension.effects.conditional_tags.some((tag) => tag.kind === 'timing' && tag.source_text.includes('12秒')));
  assert.ok(partialAscension.effects.structured_terms.some((term) => (
    term.trigger.kind === 'combat_elapsed'
    && term.trigger.seconds === 12
    && term.metrics.some((metric) => metric.metric === 'damage_amp' && metric.value === 20 && metric.unit === 'percent')
  )));
}

function assertEquipmentRecipes(equipment) {
  const completedItems = equipment.items.filter((item) => item.category === '成型装备');
  assert.equal(completedItems.length, 39);
  assert.ok(completedItems.every((item) => item.recipe), 'Every completed item must retain its source recipe');
  const infinityEdge = itemNamed(equipment, '无尽之刃');
  assert.deepEqual(infinityEdge.recipe, {
    component_ids: ['1001', '1009'],
    component_names: ['暴风之剑', '拳套'],
    formula_source_text: '暴风之剑 + 拳套 = 无尽之刃',
  });
  assert.equal(infinityEdge.map_id, '11');

  const spear = itemNamed(equipment, '朔极之矛');
  assert.ok(spear.structured_stats.some((metric) => metric.metric === 'mana_regen' && metric.value === 1));
  assert.ok(spear.effects.structured_terms.some((term) => (
    term.trigger.kind === 'basic_attack'
    && term.metrics.some((metric) => metric.metric === 'mana' && metric.value === 5)
  )));
}

function assertDynamicPlaceholders(catalogs) {
  const effects = Object.values(catalogs)
    .flatMap((catalog) => catalog.items)
    .map((item) => item.effects ?? item.skill?.effects)
    .filter(Boolean);
  const placeholders = effects.flatMap((effect) => effect.dynamic_placeholders ?? []);
  assert.ok(placeholders.length > 0, 'Expected official dynamic placeholders to be isolated');
  assert.ok(placeholders.every((placeholder) => placeholder.authoritative_value === null));
  assert.ok(effects.every((effect) => (effect.structured_terms ?? []).every((term) => (
    term.metrics.every((metric) => metric.dynamic_placeholder !== true)
  ))), 'Dynamic placeholder values must not enter calculable metrics');
  const expectedLabels = [
    '即将到来的金币',
    '伤害增幅加成',
    '参与击杀数',
    '已转化',
    '护甲与魔抗',
    '已获得的法术加成',
    '锻造之力',
  ];
  for (const label of expectedLabels) {
    const matchingEffects = effects.filter((effect) => new RegExp(`${label}\\s*[：:]\\s*0`).test(effect.source_text));
    assert.ok(matchingEffects.length > 0, `Expected a source fixture for dynamic label ${label}`);
    assert.ok(matchingEffects.every((effect) => (
      effect.dynamic_placeholders.some((placeholder) => placeholder.source_text.includes(label))
    )), `Every ${label} runtime counter must be isolated as a dynamic placeholder`);
  }
}

function assertSpriteIdentity(sprites, options) {
  const costs = [...new Set(sprites.items.map((item) => item.cost))].sort((left, right) => left - right);
  assert.ok(costs.length > 1 && costs[0] === 0 && costs.every(Number.isInteger));
  const coinFlips = sprites.items.filter((item) => item.name === '抛硬币');
  assert.equal(coinFlips.length, 2);
  assert.deepEqual(coinFlips.map((item) => item.identity), ['sprite:181008', 'sprite:181009']);
  assert.deepEqual(coinFlips.map((item) => item.cost), [0, 0]);
  assert.notEqual(coinFlips[0].effects.source_text, coinFlips[1].effects.source_text);
  assert.equal(new Set(sprites.items.map((item) => item.identity)).size, options.expectedCounts.sprites);
}

async function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${temporaryRoot}${path.sep}`), `Refusing to remove non-temporary path: ${resolved}`);
  await rm(resolved, { recursive: true, force: true });
}

export async function verifyS18SourceImport(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jcc-s18-source-import-'));
  const firstDirectory = path.join(root, 'first');
  const secondDirectory = path.join(root, 'second');
  try {
    const first = await importS18SourceDocs({ ...options, outDir: firstDirectory });
    await importS18SourceDocs({ ...options, outDir: secondDirectory });
    await assertStableOutput(firstDirectory, secondDirectory);
    assertCatalogContract(first.manifest, first.catalogs, options);
    assertChampionIdentity(first.catalogs.champions);
    assertTraits(first.catalogs.traits);
    assertTimedAugment(first.catalogs.augments);
    assertEquipmentRecipes(first.catalogs.equipment);
    assertSpriteIdentity(first.catalogs.sprites, options);
    assertDynamicPlaceholders(first.catalogs);
    return {
      counts: Object.fromEntries(Object.entries(first.catalogs).map(([kind, catalog]) => [kind, catalog.count])),
      deterministic_files: FILES.length,
      assertions: [
        'catalog counts and caller-owned identity',
        'byte-stable repeated output',
        'champion multi-key identity mapping',
        'nullable upstream trait fields',
        'structured conditional effect parsing',
        'completed-item recipes',
        'structured item stats and mana effects',
        'dynamic placeholder isolation',
        'sprite cost tiers and duplicate-name identity',
      ],
    };
  } finally {
    await removeTemporaryDirectory(root);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const patchManifest = JSON.parse(await readFile(options.patchSourceManifest, 'utf8'));
  const upstream = patchManifest.upstream_source;
  const result = await verifyS18SourceImport({
    ...options,
    seasonId: patchManifest.season_id,
    patchId: patchManifest.patch_id,
    modeId: `mode${upstream.mode}`,
    upstreamSeasonId: upstream.season_id,
    upstreamVersion: upstream.data_version,
    expectedCounts: upstream.catalog_counts,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
