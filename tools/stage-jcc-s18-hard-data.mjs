#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { importS18SourceDocs } from './import-jcc-s18-source-docs.mjs';
import { parseTypedAugmentEffect } from './jcc_typed_effect_parser.mjs';
import { buildRuntimeDecisionIndexes } from './jcc_runtime_decision_indexes.mjs';
import { publishAndPointPatchHardDataCandidate } from './jcc_hard_data_package_store.mjs';
import { applyBalancePatchSet } from './jcc_balance_patch_overlay.mjs';
import { buildNormalizedArtifactCounts } from './jcc_hard_data_artifact_counts.mjs';

let LOCAL_IDENTITY = Object.freeze({ season_id: 's18', patch_id: 's18_1', mode_id: 'mode18' });
let UPSTREAM_PROVENANCE = Object.freeze({ season_id: 'S19', data_version: '18.18.1' });
let PACKAGE_ID = 'jcc-s18-s18_1';
let SOURCE_PACKAGE_ID = 'jcc-mode18-s19-18.18.1';
let EXPECTED_SOURCE_DOC_COUNTS = null;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const COMMON_BASELINE_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/common/standard-game-baseline.json');
const DATATFT_SNAPSHOT_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-database.json');
const DATATFT_RATE_SNAPSHOT_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-rate.json');
const DATATFT_TRAIT_TRACKER_SNAPSHOT_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/datatft-s18-trait-tracker.json');
const OFFICIAL_AUGMENT_SNAPSHOT_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/official-s18-augments.json');
const ITEM_USAGE_TAXONOMY_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/item-usage-taxonomy.json');
const PATCH_SOURCE_MANIFEST_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-manifest.json');
const BALANCE_PATCH_FILE = path.join(REPO_ROOT, 'data/game-knowledge/jcc/seasons/s18/patches/s18_1/balance-changes-18.1b.json');
const VENDORED_ROOTS = Object.freeze([
  'data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs',
  'data/source-docs/jcc/s18',
  'data/game-knowledge/jcc/sources/s18',
  'docs/source-data/jcc/s18',
  'docs/sources/jcc/s18',
]);

function configurePatchContext(manifest) {
  if (!manifest) return;
  const upstream = manifest.upstream_source || {};
  const mode = String(upstream.mode || '18');
  const version = String(upstream.data_version || '18.18.1');
  const upstreamSeason = String(upstream.season_id || 'S19');
  LOCAL_IDENTITY = Object.freeze({
    season_id: String(manifest.season_id || 's18'),
    patch_id: String(manifest.patch_id || 's18_1'),
    mode_id: `mode${mode}`,
  });
  UPSTREAM_PROVENANCE = Object.freeze({ mode, season_id: upstreamSeason, data_version: version });
  PACKAGE_ID = `jcc-${LOCAL_IDENTITY.season_id}-${LOCAL_IDENTITY.patch_id}`;
  SOURCE_PACKAGE_ID = `jcc-mode${mode}-${upstreamSeason.toLowerCase()}-${version}`;
  EXPECTED_SOURCE_DOC_COUNTS = upstream.catalog_counts || null;
  if (!EXPECTED_SOURCE_DOC_COUNTS) fail('Patch upstream_source.catalog_counts is required');
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableRows(rows) {
  return [...rows].sort((left, right) => {
    const leftId = String(left.official_id ?? left.id ?? left.identity ?? '');
    const rightId = String(right.official_id ?? right.id ?? right.identity ?? '');
    if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
      const difference = BigInt(leftId) - BigInt(rightId);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
    }
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function normalizedName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s·•・！!，,。；;：:、（）()\[\]【】{}]/g, '');
}

function namesForSupplemental(row, primaryField) {
  return [row?.[primaryField], row?.jccname, row?.name, row?.displayName, ...(row?.otherNames || [])]
    .map((value) => normalizedName(value))
    .filter(Boolean);
}

function augmentNameAliases(sourceRows) {
  const aliasRules = (sourceRows || []).flatMap((row) => {
    const externalName = String(row?.name || '').trim();
    const officialName = String(row?.jccname || '').trim();
    const externalId = String(row?.hexId || '').trim();
    if (!externalName || !officialName || !externalId || normalizedName(externalName) === normalizedName(officialName)) return [];
    return [{ externalName, officialName, externalId }];
  });
  return new Map((sourceRows || []).map((row) => {
    const aliases = namesForSupplemental(row, 'jccname');
    const sourceName = String(row?.name || '').trim();
    const sourceId = String(row?.hexId || '').trim();
    for (const rule of aliasRules) {
      if (!sourceId.startsWith(rule.externalId) || !sourceName.startsWith(rule.externalName)) continue;
      aliases.push(normalizedName(`${rule.officialName}${sourceName.slice(rule.externalName.length)}`));
    }
    return [row.hexId, sortedUnique(aliases)];
  }));
}

function indexSupplemental(rows, primaryField) {
  const index = new Map();
  for (const row of rows || []) {
    for (const name of namesForSupplemental(row, primaryField)) {
      if (!index.has(name)) index.set(name, row);
    }
  }
  return index;
}

function semanticOnlyEffects(sourceText) {
  return {
    parse_status: 'semantic_only',
    exact_effect_blocks: [],
    structured_terms: [],
    conditional_tags: [],
    dynamic_placeholders: [],
    source_text: String(sourceText || ''),
  };
}

function sortedUnique(values) {
  return [...new Set((values || []).filter(Boolean).map(String))].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function numberList(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  return String(value ?? '').split('/').map(Number).filter(Number.isFinite);
}

function comparableHeroStats(row) {
  return {
    '生命': numberList(row?.lifeData2 || row?.lifeData),
    '物攻': numberList(row?.attackData2 || row?.attackData),
    '护甲': numberList(row?.armor),
    '魔抗': numberList(row?.spellBlock),
    '初始法力值': numberList(row?.startMagic),
    '法力值': numberList(row?.magic),
    '攻速': numberList(row?.attackSpeed),
    '攻击距离': numberList(row?.attackRange),
    '暴击率': numberList(Number(row?.crit) * 100),
  };
}

function compareHeroStats(champion, supplemental) {
  const external = comparableHeroStats(supplemental);
  const conflicts = [];
  for (const [metric, externalValues] of Object.entries(external)) {
    const officialValues = numberList(champion.attributes_by_star?.[metric]);
    if (!officialValues.length || !externalValues.length) continue;
    const width = Math.min(officialValues.length, externalValues.length);
    const differs = officialValues.slice(0, width).some((value, index) => Math.abs(value - externalValues[index]) > 1e-9);
    if (differs) conflicts.push({ metric, official_values: officialValues, datatft_values: externalValues });
  }
  if (normalizedName(champion.skill?.name) !== normalizedName(supplemental?.skillName)) {
    conflicts.push({ metric: 'skill_name', official_value: champion.skill?.name || null, datatft_value: supplemental?.skillName || null });
  }
  return conflicts;
}

function sourceProof(row) {
  return row?.provenance ? {
    document: row.provenance.document,
    document_sha256: row.provenance.document_sha256,
    section: row.provenance.section,
    ordinal: row.provenance.ordinal,
  } : null;
}

function address(kind, id) {
  return `jcc:${LOCAL_IDENTITY.season_id}:${kind}:${id}`;
}

function itemType(category) {
  const types = {
    '基础装备': '基础装备',
    '成型装备': '成型装备',
    '转职纹章': '转职纹章',
    '神器装备': '神器装备',
    '光明武器': '光明武器',
    '特殊装备': '特殊装备',
  };
  return types[category] || String(category || '成型装备');
}

function itemTags(category) {
  const tags = {
    '基础装备': ['component'],
    '转职纹章': ['emblem'],
    '神器装备': ['artifact'],
    '光明武器': ['radiant'],
  };
  return tags[category] || [];
}

function itemUsageTaxonomyById(document) {
  if (document?.schema !== 'jcc-patch-item-usage-taxonomy-v1'
    || document?.identity?.season_id !== LOCAL_IDENTITY.season_id
    || document?.identity?.patch_id !== LOCAL_IDENTITY.patch_id) {
    fail('item usage taxonomy must bind the active S18 patch identity');
  }
  const allowedFacets = new Set(['tank', 'physical', 'magic', 'speed', 'mana', 'sustain', 'utility', 'artifact', 'special']);
  const byId = new Map();
  for (const entry of document.entries || []) {
    const id = String(entry?.item_id || '');
    const facets = sortedUnique(entry?.browse_facets || []);
    if (!id || byId.has(id)) fail(`duplicate or missing item usage taxonomy id: ${id || '<missing>'}`);
    if (!entry?.name || !entry?.primary_role || !facets.length) fail(`incomplete item usage taxonomy entry: ${id}`);
    if (facets.some((facet) => !allowedFacets.has(facet))) fail(`unknown item browse facet for ${id}`);
    byId.set(id, { ...entry, item_id: id, browse_facets: facets });
  }
  return byId;
}

function projectCatalogs(catalogs, itemUsageTaxonomy, championRuntimeSemantics = []) {
  const itemUsageById = itemUsageTaxonomyById(itemUsageTaxonomy);
  const runtimeSemanticsByChampionId = new Map(
    (Array.isArray(championRuntimeSemantics) ? championRuntimeSemantics : [])
      .map((entry) => [String(entry?.canonical_champion_id || ''), entry])
      .filter(([id]) => id),
  );
  const traitsByName = new Map();
  const traits = stableRows(catalogs.traits.items).map((row) => {
    const id = String(row.official_id);
    const projected = {
      address: address('trait', id), source: 'jcc_official_s18_source_docs', id, name: row.name,
      type: row.kind, icon_url: row.icon_url || null, breakpoints: row.tiers.map((tier) => ({
        level: tier.level, count: tier.count, color: tier.color, effect: tier.effect_text,
      })),
      num_list: row.tiers.map((tier) => tier.count), text: { prefix: row.description || '', desc2: row.tiers.map((tier) => `(${tier.count})${tier.effect_text}`).join('|') },
      source_proof: sourceProof(row),
    };
    const key = normalizedName(row.name);
    traitsByName.set(key, [...(traitsByName.get(key) || []), { id, name: row.name, address: projected.address }]);
    return projected;
  });

  const champions = stableRows(catalogs.champions.items).map((row) => ({
    address: address('champion', row.official_id), source: 'jcc_official_s18_source_docs', id: String(row.official_id),
    mumu_base_id: row.mumu_base_id, name: row.name, cost: row.cost,
    traits: [...row.traits, ...row.classes].flatMap((name) => traitsByName.get(normalizedName(name)) || [{ id: null, name, address: null }]),
    skill: row.skill, attributes_by_star: row.attributes_by_star,
    runtime_semantics: runtimeSemanticsByChampionId.get(String(row.official_id)) || null,
    raw_refs: { raw_star_ids: row.raw_star_ids, map_ids: row.map_ids, resource_key: row.resource_key },
    source_proof: sourceProof(row),
  }));

  const chessVariants = stableRows(catalogs.champions.items).flatMap((row) => row.star_identity.map((variant) => ({
    address: address('chess_variant', variant.raw_star_id), source: 'jcc_official_s18_source_docs',
    id: variant.raw_star_id, champion_id: String(row.official_id), name: row.name, cost: row.cost, star: variant.star,
    map_id: variant.map_id, resource_key: row.resource_key, source_proof: sourceProof(row),
  })));

  const items = stableRows(catalogs.equipment.items).map((row) => {
    const id = String(row.official_id);
    const usage = itemUsageById.get(id) || null;
    if (usage && normalizedName(usage.name) !== normalizedName(row.name)) {
      fail(`item usage taxonomy identity mismatch for ${id}: ${usage.name} != ${row.name}`);
    }
    return {
      address: address('item', row.official_id), source: 'jcc_official_s18_source_docs', id,
      name: row.name, type: itemType(row.category), map_id: row.map_id, icon_key: row.icon_key,
      basic_desc: row.stats_source_text || '', structured_stats: row.structured_stats || [],
      desc: row.effects?.source_text || '', effects: row.effects, tags: itemTags(row.category),
      recipe: row.recipe, icon_url: row.icon_url, source_proof: sourceProof(row),
      primary_role: usage?.primary_role || null,
      browse_facets: usage?.browse_facets || [],
      usage_taxonomy_status: usage ? 'developer_curated_patch_v1' : 'not_browse_classified',
    };
  });
  const projectedItemIds = new Set(items.map((item) => item.id));
  for (const itemId of itemUsageById.keys()) {
    if (!projectedItemIds.has(itemId)) fail(`item usage taxonomy references an unknown current item: ${itemId}`);
  }

  const augments = stableRows(catalogs.augments.items).map((row) => ({
    address: address('augment', row.official_id), source: 'jcc_official_s18_source_docs', id: String(row.official_id),
    name: row.name, tier: String(row.tier), desc: row.effects?.source_text || '', effects: row.effects,
    icon_url: row.icon_url, tags: [], source_proof: sourceProof(row),
  }));

  const sprites = stableRows(catalogs.sprites.items).map((row) => ({
    address: address('sprite', row.official_id), id: String(row.official_id), sprite_id: row.sprite_id, name: row.name, title: row.title, cost: row.cost,
    description: row.effects?.source_text || '', effects: row.effects, assets: row.assets, source_proof: sourceProof(row),
  }));
  return { champions, chess_variants: chessVariants, traits, items, augments, sprites };
}

function projectOfficialAugments(snapshot, importedAugments) {
  if (snapshot?.schema !== 'jcc-official-augment-snapshot-v1'
    || snapshot?.target?.season_id !== LOCAL_IDENTITY.season_id
    || snapshot?.target?.patch_id !== LOCAL_IDENTITY.patch_id
    || snapshot?.target?.mode_id !== LOCAL_IDENTITY.mode_id) {
    fail(`Official augment snapshot must bind ${LOCAL_IDENTITY.season_id}/${LOCAL_IDENTITY.patch_id}/${LOCAL_IDENTITY.mode_id}`);
  }
  if (snapshot?.source?.trust_role !== 'primary_augment_entity_authority') {
    fail('Official augment snapshot must declare primary_augment_entity_authority');
  }
  const importedById = new Map((importedAugments || []).map((row) => [String(row.id), row]));
  return stableRows((snapshot.augments || []).map((row) => {
    const id = String(row.id);
    const imported = importedById.get(id);
    const description = String(row.description || '');
    return {
      ...(imported || {}),
      address: address('augment', id),
      source: 'jcc_official_mode18_augment_snapshot',
      id,
      name: String(row.name),
      tier: String(row.tier),
      desc: description,
      effects: parseTypedAugmentEffect(description),
      icon_url: row.icon_url || imported?.icon_url || null,
      tags: imported?.tags || [],
      aliases: sortedUnique([row.name, imported?.name, ...(imported?.aliases || [])]),
      source_proof: {
        provider_id: snapshot.source.provider_id,
        page_url: snapshot.source.page_url,
        augment_url: snapshot.source.augment_url,
        augment_payload_sha256: snapshot.source.augment_payload_sha256,
        upstream_identity: snapshot.upstream_identity,
      },
    };
  }));
}

function applyConfirmedPatchAugmentExtensions(projectedAugments, manifest, supplementalSnapshot) {
  const extensions = manifest?.confirmed_patch_augment_extensions || [];
  if (!extensions.length) return projectedAugments;
  const supplementalById = new Map(
    (supplementalSnapshot?.catalogs?.augments || []).map((row) => [String(row.hexId || ''), row]),
  );
  const existingIds = new Set(projectedAugments.map((row) => String(row.id)));
  const additions = extensions.map((extension) => {
    const externalId = String(extension.external_id || '').trim();
    const supplemental = supplementalById.get(externalId);
    if (!supplemental) fail(`Confirmed patch augment extension ${externalId} is absent from the frozen supplemental snapshot`);
    const id = String(extension.id || '').trim();
    if (!id || existingIds.has(id)) fail(`Confirmed patch augment extension id is missing or already exists: ${id}`);
    const supplementalName = String(supplemental.jccname || supplemental.name || '').trim();
    if (supplementalName !== String(extension.name || '').trim()) {
      fail(`Confirmed patch augment extension name mismatch for ${externalId}`);
    }
    return {
      address: address('augment', id),
      source: 'jcc_developer_confirmed_s18_patch_extension',
      id,
      name: String(extension.name),
      tier: String(extension.tier),
      desc: String(extension.description || supplemental.desc || ''),
      effects: parseTypedAugmentEffect(
        extension.description
          || supplemental.desc
          || extension.effects?.source_text
          || '',
      ),
      icon_url: extension.icon_url || null,
      tags: sortedUnique(extension.tags || []),
      aliases: sortedUnique([extension.name, supplemental.jccname, supplemental.name]),
      rounds: sortedUnique(extension.rounds || supplemental.round || []),
      category_ids: sortedUnique(extension.category_ids || supplemental.category_ids || []),
      category_labels: sortedUnique(extension.category_labels || supplemental.category_labels || []),
      stage_authority: String(extension.authority || 'developer_confirmed_patch_manifest'),
      source_proof: {
        provider_id: 'jcc_developer_confirmed_patch_manifest',
        manifest_id: `data/game-knowledge/jcc/seasons/${LOCAL_IDENTITY.season_id}/patches/${LOCAL_IDENTITY.patch_id}/source-manifest.json`,
        external_source: 'datatft_frozen_s18_database_snapshot',
        external_id: externalId,
      },
    };
  });
  return stableRows([...projectedAugments, ...additions]);
}

function compactSupplementalProof(snapshot, row, externalId) {
  return {
    provider_id: snapshot.source?.provider_id || 'datatft',
    page_url: snapshot.source?.page_url || null,
    encrypted_data_asset_sha256: snapshot.source?.encrypted_data_asset_sha256 || null,
    external_id: externalId || row?.key || row?.hexId || null,
    trust_role: snapshot.source?.trust_role || 'supplemental_structured_hard_data',
  };
}

function spriteConflictFields(variants, source) {
  if (!source) return [];
  const expected = [
    ['cost', variants[0]?.cost, source.cost],
    ['base_effect', variants[0]?.description, source.effect],
    ['upgrade.cost', variants[1]?.cost ?? null, source.upgrade?.cost ?? null],
    ['upgrade.effect', variants[1]?.description ?? null, source.upgrade?.effect ?? null],
    ['prismatic.cost', variants[2]?.cost ?? null, source.prismatic?.cost ?? null],
    ['prismatic.effect', variants[2]?.description ?? null, source.prismatic?.effect ?? null],
  ];
  return expected.filter(([, officialValue, supplementalValue]) => {
    if (officialValue == null && supplementalValue == null) return false;
    if (typeof officialValue === 'string' || typeof supplementalValue === 'string') {
      return normalizedName(officialValue) !== normalizedName(supplementalValue);
    }
    return officialValue !== supplementalValue;
  }).map(([field, officialValue, supplementalValue]) => ({ field, official_value: officialValue, supplemental_value: supplementalValue }));
}

function normalizedEffectText(value) {
  return normalizedName(String(value || '').replace(/<[^>]+>/g, ''));
}

function spriteLifecycleFingerprint(variants, source) {
  const official = {
    base_cost: variants[0]?.cost ?? null,
    base_effect: normalizedEffectText(variants[0]?.description),
    upgrade_cost: variants[1]?.cost ?? null,
    upgrade_effect: normalizedEffectText(variants[1]?.description),
    prismatic_cost: variants[2]?.cost ?? null,
    prismatic_effect: normalizedEffectText(variants[2]?.description),
  };
  const supplemental = {
    base_cost: source?.cost ?? null,
    base_effect: normalizedEffectText(source?.effect),
    upgrade_cost: source?.upgrade?.cost ?? null,
    upgrade_effect: normalizedEffectText(source?.upgrade?.effect),
    prismatic_cost: source?.prismatic?.cost ?? null,
    prismatic_effect: normalizedEffectText(source?.prismatic?.effect),
  };
  return { official, supplemental };
}

function findSpriteSourceMatch(variants, sourceRows, consumedSourceKeys) {
  const exactName = normalizedName(variants[0]?.name);
  const exact = sourceRows.find((row) => !consumedSourceKeys.has(row.key)
    && namesForSupplemental(row, 'title').includes(exactName));
  if (exact) return { source: exact, match_kind: 'declared_name' };
  const effectMatches = sourceRows.filter((row) => {
    if (consumedSourceKeys.has(row.key)) return false;
    const { official, supplemental } = spriteLifecycleFingerprint(variants, row);
    return official.base_effect && JSON.stringify(official) === JSON.stringify(supplemental);
  });
  return effectMatches.length === 1
    ? { source: effectMatches[0], match_kind: 'exact_lifecycle_content' }
    : { source: null, match_kind: null };
}

function canonicalizeSprites(officialRows, snapshot) {
  const byName = new Map();
  for (const row of officialRows) {
    const key = normalizedName(row.name);
    byName.set(key, [...(byName.get(key) || []), row]);
  }
  const sourceRows = snapshot.catalogs?.nature_sprites || [];
  const consumedSourceKeys = new Set();
  const canonical = [];
  const conflicts = [];
  for (const [nameKey, variants] of byName) {
    const match = findSpriteSourceMatch(variants, sourceRows, consumedSourceKeys);
    const source = match.source;
    if (source) consumedSourceKeys.add(source.key);
    const baseVariant = variants[0];
    const upgradeVariant = variants[1] || null;
    const prismaticVariant = variants[2] || null;
    const conflictFields = spriteConflictFields(variants, source);
    if (conflictFields.length) {
      conflicts.push({
        name: baseVariant.name,
        official_variant_ids: variants.map((variant) => variant.id),
        supplemental_external_id: source?.key || null,
        fields: conflictFields,
      });
    }
    canonical.push({
      ...baseVariant,
      address: address('sprite', baseVariant.id),
      id: String(baseVariant.id),
      name: baseVariant.name,
      aliases: sortedUnique([
        baseVariant.name,
        source?.title,
        source?.jccname,
        source?.name,
        source?.displayName,
        ...(source?.otherNames || []),
      ]),
      title: baseVariant.title || baseVariant.name,
      cost: baseVariant.cost,
      tier: source?.tier ?? null,
      category_id: source?.category_id || 'unknown',
      category_label: source?.category_label || '未分类',
      round_ranges: source?.rounds || [],
      available_rounds: source?.available_rounds || [],
      stage_groups: source?.stage_groups || {},
      requirements: source?.requires || [],
      base_effect: baseVariant.description,
      upgrade: upgradeVariant ? {
        cost: upgradeVariant.cost,
        effect: upgradeVariant.description,
        effects: upgradeVariant.effects,
        source_proof: upgradeVariant.source_proof,
      } : null,
      prismatic: prismaticVariant ? {
        cost: prismaticVariant.cost,
        effect: prismaticVariant.description,
        effects: prismaticVariant.effects,
        source_proof: prismaticVariant.source_proof,
      } : null,
      source_variants: variants.map((variant) => ({
        id: variant.id,
        cost: variant.cost,
        description: variant.description,
        effects: variant.effects,
        source_proof: variant.source_proof,
      })),
      supplemental_source: source ? {
        ...compactSupplementalProof(snapshot, source, source.key),
        external_name: source.title || null,
        identity_match: {
          kind: match.match_kind,
          canonical_name: baseVariant.name,
        },
      } : null,
    });
  }
  for (const source of sourceRows) {
    if (consumedSourceKeys.has(source.key)) continue;
    const id = `datatft:${source.key}`;
    canonical.push({
      address: address('sprite', id),
      id,
      sprite_id: source.key,
      source: 'datatft_supplemental_s18_database',
      name: source.jccname || source.title,
      title: source.title,
      cost: source.cost,
      tier: source.tier ?? null,
      category_id: source.category_id || 'unknown',
      category_label: source.category_label || '未分类',
      description: source.effect || '',
      effects: semanticOnlyEffects(source.effect),
      round_ranges: source.rounds || [],
      available_rounds: source.available_rounds || [],
      stage_groups: source.stage_groups || {},
      requirements: source.requires || [],
      base_effect: source.effect || '',
      upgrade: source.upgrade ? { cost: source.upgrade.cost ?? null, effect: source.upgrade.effect || '', effects: semanticOnlyEffects(source.upgrade.effect) } : null,
      prismatic: source.prismatic ? { cost: source.prismatic.cost ?? null, effect: source.prismatic.effect || '', effects: semanticOnlyEffects(source.prismatic.effect) } : null,
      assets: {},
      source_variants: [],
      source_proof: null,
      supplemental_source: compactSupplementalProof(snapshot, source, source.key),
    });
  }
  return { entries: stableRows(canonical), conflicts: stableRows(conflicts) };
}

function textSimilarity(left, right) {
  const leftChars = new Set(normalizedName(left));
  const rightChars = new Set(normalizedName(right));
  if (!leftChars.size || !rightChars.size) return 0;
  let intersection = 0;
  for (const value of leftChars) if (rightChars.has(value)) intersection += 1;
  return intersection / new Set([...leftChars, ...rightChars]).size;
}

function augmentAssetIdentity(value) {
  const fileName = String(value || '').split(/[\\/]/).pop()?.split(/[?#]/)[0] || '';
  return fileName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function numericEffectSignature(value) {
  return (String(value || '').match(/\d+(?:\.\d+)?%?/g) || []).map(String).join('|');
}

function reviewDiscardedSupplementalAugment(source, officialRows) {
  const sourceAsset = augmentAssetIdentity(source.img);
  const sourceNumbers = numericEffectSignature(source.desc);
  const sameAsset = sourceAsset
    ? officialRows.filter((official) => augmentAssetIdentity(official.icon_url) === sourceAsset)
    : [];
  if (sameAsset.length) {
    const nearest = sameAsset
      .map((official) => ({ official, score: textSimilarity(official.desc, source.desc) }))
      .sort((left, right) => right.score - left.score || String(left.official.id).localeCompare(String(right.official.id)))[0];
    const officialNumbers = numericEffectSignature(nearest.official.desc);
    return {
      review_status: 'reviewed_not_equivalent',
      reason: officialNumbers !== sourceNumbers
        ? 'same_resource_identity_but_effect_numbers_differ'
        : 'same_resource_identity_but_tier_or_semantics_differ',
      nearest_official: {
        id: nearest.official.id,
        name: nearest.official.name,
        tier: nearest.official.tier,
        numeric_effect_signature: officialNumbers,
      },
      supplemental_numeric_effect_signature: sourceNumbers,
    };
  }
  const nearest = officialRows
    .map((official) => ({
      official,
      score: Math.max(
        textSimilarity(official.name, source.jccname || source.name),
        textSimilarity(official.desc, source.desc),
      ),
    }))
    .sort((left, right) => right.score - left.score || String(left.official.id).localeCompare(String(right.official.id)))[0];
  return {
    review_status: 'reviewed_not_equivalent',
    reason: 'no_current_official_name_effect_or_resource_equivalent',
    nearest_official: nearest?.score >= 0.45 ? {
      id: nearest.official.id,
      name: nearest.official.name,
      tier: nearest.official.tier,
      similarity: Number(nearest.score.toFixed(4)),
    } : null,
    supplemental_numeric_effect_signature: sourceNumbers,
  };
}

function matchSupplementalAugments(officialRows, sourceRows) {
  const byName = new Map();
  const aliasesByExternalId = augmentNameAliases(sourceRows);
  for (const source of sourceRows || []) {
    for (const key of aliasesByExternalId.get(source.hexId) || []) {
      byName.set(key, [...(byName.get(key) || []), {
        row: source,
        match_kind: namesForSupplemental(source, 'jccname').includes(key) ? 'declared_name' : 'source_family_alias',
        matched_alias: key,
      }]);
    }
  }
  const used = new Set();
  const matches = new Map();
  const equivalentVariants = new Map();
  for (const official of officialRows) {
    const candidates = (byName.get(normalizedName(official.name)) || []).filter((entry) => !used.has(entry.row.hexId));
    if (!candidates.length) continue;
    const ranked = candidates.map((entry) => ({
      ...entry,
      score: (normalizedName(official.desc) === normalizedName(entry.row.desc) ? 100 : 0)
        + (String(official.tier) === String(entry.row.tier) ? 10 : 0)
        + textSimilarity(official.desc, entry.row.desc),
    })).sort((left, right) => right.score - left.score || String(left.row.hexId).localeCompare(String(right.row.hexId)));
    matches.set(official.address, ranked[0]);
    used.add(ranked[0].row.hexId);
  }

  for (const official of officialRows) {
    if (matches.has(official.address)) continue;
    const officialAsset = augmentAssetIdentity(official.icon_url);
    if (!officialAsset) continue;
    const officialNumbers = numericEffectSignature(official.desc);
    const candidates = (sourceRows || []).filter((source) => {
      if (used.has(source.hexId)) return false;
      if (String(official.tier) !== String(source.tier)) return false;
      if (augmentAssetIdentity(source.img) !== officialAsset) return false;
      return numericEffectSignature(source.desc) === officialNumbers;
    }).map((source) => ({
      row: source,
      match_kind: 'source_asset_and_effect_signature',
      matched_alias: normalizedName(source.jccname || source.name),
      score: normalizedName(official.desc) === normalizedName(source.desc)
        ? 100
        : textSimilarity(official.desc, source.desc),
    })).sort((left, right) => right.score - left.score || String(left.row.hexId).localeCompare(String(right.row.hexId)));
    if (!candidates.length) continue;
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) continue;
    matches.set(official.address, candidates[0]);
    used.add(candidates[0].row.hexId);
  }
  for (const source of sourceRows || []) {
    if (used.has(source.hexId)) continue;
    const sourceAsset = augmentAssetIdentity(source.img);
    if (!sourceAsset) continue;
    const sourceNumbers = numericEffectSignature(source.desc);
    const candidates = officialRows.filter((official) => (
      String(official.tier) === String(source.tier)
      && augmentAssetIdentity(official.icon_url) === sourceAsset
      && numericEffectSignature(official.desc) === sourceNumbers
    )).map((official) => ({
      official,
      score: normalizedName(official.desc) === normalizedName(source.desc)
        ? 100
        : textSimilarity(official.desc, source.desc),
    })).sort((left, right) => right.score - left.score || String(left.official.id).localeCompare(String(right.official.id)));
    if (!candidates.length || candidates[0].score < 0.35) continue;
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) continue;
    const official = candidates[0].official;
    equivalentVariants.set(official.address, [
      ...(equivalentVariants.get(official.address) || []),
      {
        row: source,
        match_kind: 'source_asset_and_effect_signature_alias',
        matched_alias: normalizedName(source.jccname || source.name),
        score: candidates[0].score,
      },
    ]);
    used.add(source.hexId);
  }
  return { matches, equivalentVariants, used };
}

function mergeSupplementalCatalogs(projected, snapshot) {
  if (!snapshot) {
    return {
      projected,
      audit: {
        schema: 'jcc-supplemental-hard-data-audit-v1',
        identity: LOCAL_IDENTITY,
        status: 'not_supplied',
        source: null,
        coverage: {},
        conflicts: {},
      },
    };
  }
  if (snapshot.schema !== 'jcc-datatft-database-snapshot-v1' || snapshot.target?.season_id !== 's18') {
    fail('DataTFT snapshot must be jcc-datatft-database-snapshot-v1 for s18');
  }
  const heroIndex = indexSupplemental(snapshot.catalogs?.champions, 'displayName');
  const itemIndex = indexSupplemental(snapshot.catalogs?.items, 'jccname');
  const traitIndex = indexSupplemental(snapshot.catalogs?.traits, 'name');
  const heroConflicts = [];
  const augmentMatches = matchSupplementalAugments(projected.augments, snapshot.catalogs?.augments || []);
  const matchedExternalAugments = augmentMatches.used;
  const augmentCategoryLabels = new Map(
    (snapshot.category_definitions?.augment || []).map((entry) => [String(entry.id), String(entry.label)]),
  );
  const orderedAugmentCategories = (source) => sortedUnique(source.category_ids).map((id) => ({
    id,
    label: augmentCategoryLabels.get(id) || id,
  }));
  const champions = projected.champions.map((row) => {
    const source = heroIndex.get(normalizedName(row.name));
    if (!source) return row;
    const conflicts = compareHeroStats(row, source);
    if (conflicts.length) heroConflicts.push({ id: row.id, name: row.name, conflicts });
    return {
      ...row,
      supplemental_source: {
        ...compactSupplementalProof(snapshot, source, source.key),
        chess_id: source.chessId ?? null,
        resource_key: source.key || null,
        role: source.role || null,
        role_key: source.roleKey || null,
        recommended_equipment_ids: String(source.recEquip || '').split(',').filter(Boolean),
        skill_name: source.skillName || null,
        skill_type: source.skillType || null,
        skill_detail_html: source.skillDetail2 || null,
        comparable_stats: comparableHeroStats(source),
      },
      supplemental_conflicts: conflicts,
    };
  });
  const items = projected.items.map((row) => {
    const source = itemIndex.get(normalizedName(row.name));
    return source ? {
      ...row,
      supplemental_source: {
        ...compactSupplementalProof(snapshot, source, source.key),
        equip_id: source.equipId ?? null,
        resource_key: source.key || null,
        external_name: source.name || null,
        external_type: source.type2 || null,
        effect_html: source.effect || null,
        effect_attributes: source.effectAttr || null,
      },
    } : row;
  });
  const traits = projected.traits.map((row) => {
    const source = traitIndex.get(normalizedName(row.name));
    return source ? {
      ...row,
      supplemental_source: {
        ...compactSupplementalProof(snapshot, source, source.key),
        resource_key: source.key || null,
        external_numeric_id: source.jobId ?? source.raceId ?? null,
        external_kind: source.trait_kind || null,
        hero_ids: source.heros || [],
        breakpoints: source.level || [],
        description_html: source.introduce || null,
      },
    } : row;
  });
  const augments = projected.augments.map((row) => {
    const match = augmentMatches.matches.get(row.address);
    if (!match) return row;
    const source = match.row;
    const equivalentVariants = augmentMatches.equivalentVariants.get(row.address) || [];
    const categories = orderedAugmentCategories(source);
    const categoryIds = categories.map((entry) => entry.id);
    return {
      ...row,
      aliases: sortedUnique([
        row.name,
        source.jccname,
        source.name,
        source.displayName,
        ...(source.otherNames || []),
        ...equivalentVariants.flatMap((entry) => [
          entry.row.jccname,
          entry.row.name,
          entry.row.displayName,
          ...(entry.row.otherNames || []),
        ]),
      ]),
      tier_color: source.tier_color || null,
      rounds: sortedUnique(source.round),
      category_ids: categoryIds,
      category_labels: categories.map((entry) => entry.label),
      tags: sortedUnique([...(row.tags || []), ...categoryIds.map((id) => `augment_category:${id}`)]),
      supplemental_source: {
        ...compactSupplementalProof(snapshot, source, source.hexId),
        hex_id: source.hexId || null,
        external_name: source.name || null,
        external_code: source.code || null,
        identity_match: {
          kind: match.match_kind,
          matched_alias: match.matched_alias,
          canonical_name: row.name,
        },
        equivalent_variants: equivalentVariants.map((entry) => ({
          ...compactSupplementalProof(snapshot, entry.row, entry.row.hexId),
          external_name: entry.row.jccname || entry.row.name || null,
          identity_match: {
            kind: entry.match_kind,
            matched_alias: entry.matched_alias,
            canonical_name: row.name,
          },
        })),
      },
    };
  });
  const discardedUnofficialAugments = (snapshot.catalogs?.augments || [])
    .filter((row) => !matchedExternalAugments.has(row.hexId))
    .map((row) => ({
      id: row.hexId,
      name: row.jccname || row.name,
      ...reviewDiscardedSupplementalAugment(row, projected.augments),
    }));
  const canonicalSprites = canonicalizeSprites(projected.sprites, snapshot);
  const sprites = canonicalSprites.entries;
  const coverage = {
    champions: { official: projected.champions.length, supplemental: snapshot.catalogs.champions.length, matched: champions.filter((row) => row.supplemental_source).length },
    items: { official: projected.items.length, supplemental: snapshot.catalogs.items.length, matched: items.filter((row) => row.supplemental_source).length },
    traits: { official: projected.traits.length, supplemental: snapshot.catalogs.traits.length, matched: traits.filter((row) => row.supplemental_source).length },
    augments: {
      official: projected.augments.length,
      supplemental: snapshot.catalogs.augments.length,
      matched: matchedExternalAugments.size,
      matched_entities: augments.filter((row) => row.supplemental_source).length,
      stage_bound: augments.filter((row) => row.rounds?.length).length,
      final_catalog: augments.length,
      official_only: projected.augments.filter((row) => !augmentMatches.matches.has(row.address)).map((row) => ({ id: row.id, name: row.name })),
      official_only_search_only: projected.augments.filter((row) => !augmentMatches.matches.has(row.address)).length,
      discarded_unofficial: discardedUnofficialAugments,
    },
    nature_sprites: { official_variants: projected.sprites.length, canonical_entries: sprites.length, supplemental: snapshot.catalogs.nature_sprites.length },
  };
  return {
    projected: { ...projected, champions, items, traits, augments: stableRows(augments), sprites },
    audit: {
      schema: 'jcc-supplemental-hard-data-audit-v1',
      identity: LOCAL_IDENTITY,
      status: 'compared_and_merged',
      policy: 'The current official source is the complete augment entity authority. Patch manifests may explicitly add a bounded developer-confirmed extension after frozen-supplement identity and content checks; all other unmatched supplemental rows remain audit-only.',
      source: snapshot.source,
      category_definitions: snapshot.category_definitions,
      coverage,
      conflicts: {
        champion_stats_and_skill_names: heroConflicts,
        nature_sprite_effects_and_costs: canonicalSprites.conflicts,
      },
    },
  };
}

export {
  projectCatalogs,
  projectOfficialAugments,
  applyConfirmedPatchAugmentExtensions,
  mergeSupplementalCatalogs,
};

function buildAliasGateway(projected) {
  const kinds = { champion: projected.champions, trait: projected.traits, item: projected.items, augment: projected.augments, sprite: projected.sprites };
  const byKindAndName = {};
  const lookup = {};
  for (const [kind, rows] of Object.entries(kinds)) {
    byKindAndName[kind] = {};
    for (const row of rows) {
      const key = normalizedName(row.name);
      byKindAndName[kind][key] = [...(byKindAndName[kind][key] || []), row.id].sort();
      const aliasesByNormalizedName = new Map();
      for (const alias of sortedUnique([row.name, ...(row.aliases || [])])) {
        const aliasKey = normalizedName(alias);
        if (aliasKey && !aliasesByNormalizedName.has(aliasKey)) aliasesByNormalizedName.set(aliasKey, alias);
      }
      for (const [aliasKey, alias] of aliasesByNormalizedName) {
        const entryKey = `${kind}:${aliasKey}`;
        const refs = (lookup[entryKey]?.r || []).concat({
          entity_kind: kind, entity_id: row.id, entity_address: row.address, entity_name: row.name, alias, source: row.source,
        });
        const ids = sortedUnique(refs.map((ref) => ref.entity_id));
        lookup[entryKey] = { n: aliasKey, ids, r: refs, ambiguous: ids.length > 1 };
      }
    }
  }
  return {
    schema: 'jcc-entity-alias-gateway-v1', identity: LOCAL_IDENTITY,
    lookup, by_kind_and_name: byKindAndName,
    ambiguous_names: Object.entries(byKindAndName).flatMap(([kind, names]) => Object.entries(names)
      .filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ kind, name, ids }))),
  };
}

function commonEntry(commonBaseline, id) {
  const entry = commonBaseline?.entries?.find((row) => row.id === id);
  if (!entry) fail(`Common standard baseline is missing ${id}`);
  return entry;
}

function cumulativeXpFromCurve(xpToNextLevel) {
  const result = { '2': 0 };
  let total = 0;
  for (let level = 2; level <= 9; level += 1) {
    total += Number(xpToNextLevel[String(level)] || 0);
    result[String(level + 1)] = total;
  }
  return result;
}

function normalizeVersionComparisonValue(field, value) {
  if (field === 'shop.pool_by_cost' && Array.isArray(value)) {
    return Object.fromEntries(value.map((row) => [String(row.cost), Number(row.copies_per_champion)]));
  }
  if (field === 'shop.odds_by_level' && Array.isArray(value)) {
    return Object.fromEntries(value.map((row) => [String(row.level), [row.cost1, row.cost2, row.cost3, row.cost4, row.cost5].map(Number)]));
  }
  if (field === 'economy.base_income_by_round' && value && typeof value === 'object') {
    const normalized = { ...value };
    if (normalized['1-1'] === 0) delete normalized['1-1'];
    if (normalized['2-2'] !== undefined && normalized['2-2+'] === undefined) {
      normalized['2-2+'] = normalized['2-2'];
      delete normalized['2-2'];
    }
    return normalized;
  }
  return value;
}

function compareVersionParameters(commonBaseline, rateSnapshot) {
  if (!rateSnapshot) return { matches: [], conflicts: [] };
  const commonShop = commonEntry(commonBaseline, 'standard.shop_and_pool');
  const commonProgression = commonEntry(commonBaseline, 'standard.progression');
  const commonEconomy = commonEntry(commonBaseline, 'standard.economy');
  const commonDamage = commonEntry(commonBaseline, 'standard.player_damage');
  const commonAugmentProbabilities = commonEntry(commonBaseline, 'standard.augment_tier_probabilities');
  const comparisons = [
    ['shop.pool_by_cost', commonShop.pool_by_cost, rateSnapshot.basic_information?.shop?.pool_by_cost],
    ['shop.odds_by_level', commonShop.odds_by_level, rateSnapshot.basic_information?.shop?.odds_by_level],
    ['progression.xp_to_next_level', commonProgression.xp_to_next_level, rateSnapshot.basic_information?.progression?.xp_to_next_level],
    ['economy.base_income_by_round', commonEconomy.base_income_by_round, rateSnapshot.basic_information?.economy?.base_income_by_round],
    ['player_damage.base_damage_by_stage', commonDamage.base_damage_by_stage, rateSnapshot.basic_information?.player_damage?.base_damage_by_stage],
    ['player_damage.surviving_enemy_unit_damage', commonDamage.surviving_enemy_unit_damage, rateSnapshot.basic_information?.player_damage?.survivor_unit_damage],
    ['augment_tier_sequence_probabilities', commonAugmentProbabilities.rows, rateSnapshot.augment_tier_sequence_probabilities?.rows],
  ];
  const matches = [];
  const conflicts = [];
  for (const [field, commonValue, s18Value] of comparisons) {
    const normalizedCommonValue = normalizeVersionComparisonValue(field, commonValue);
    const normalizedS18Value = normalizeVersionComparisonValue(field, s18Value);
    const row = { field, common_value: commonValue, supplemental_value: s18Value };
    if (JSON.stringify(normalizedCommonValue) === JSON.stringify(normalizedS18Value)) matches.push(row);
    else conflicts.push(row);
  }
  return { matches, conflicts };
}

function buildRewardTables(projected, rateSnapshot) {
  if (!rateSnapshot) {
    return {
      schema: 'jcc-version-reward-tables-v1',
      identity: LOCAL_IDENTITY,
      entity_tables: [], season_tables: [], supplemental_unbound_tables: [], exclusions: [],
    };
  }
  if (rateSnapshot.schema !== 'jcc-datatft-rate-snapshot-v1' || rateSnapshot.target?.season_id !== LOCAL_IDENTITY.season_id) {
    fail('DataTFT rate snapshot must be jcc-datatft-rate-snapshot-v1 for s18');
  }
  const augmentsByName = new Map(projected.augments.map((row) => [normalizedName(row.name), row]));
  const traitsByName = new Map(projected.traits.map((row) => [normalizedName(row.name), row]));
  const entityTables = [];
  const seasonTables = [];
  const supplementalUnboundTables = [];
  const bindEntityTable = (table, entity, sourceKey) => {
    const tableId = `${entity.kind || table.kind}:${entity.id}:rewards`;
    entity.reward_table_ref = tableId;
    entityTables.push({
      table_id: tableId,
      entity_ref: { kind: table.kind, id: entity.id, address: entity.address, name: entity.name },
      source_key: sourceKey,
      source_ref: rateSnapshot.source,
      outcome_semantics: table.outcome_semantics,
      groups: table.groups,
    });
  };
  for (const [sourceKey, table] of Object.entries(rateSnapshot.reward_tables || {})) {
    if (table.kind === 'orb') {
      seasonTables.push({
        table_id: `season:${LOCAL_IDENTITY.season_id}:orb:${table.canonical_name}`,
        mechanic_kind: 'pve_reward_orb',
        name: table.canonical_name,
        source_key: sourceKey,
        source_ref: rateSnapshot.source,
        outcome_semantics: table.outcome_semantics,
        groups: table.groups,
      });
      continue;
    }
    if (table.kind === 'augment_family' && normalizedName(table.canonical_name) === normalizedName('扩展包')) {
      const variants = { '-': '扩展包', '+': '扩展包+', '++': '扩展包++' };
      for (const group of table.groups || []) {
        const canonicalName = variants[group.label];
        const entity = augmentsByName.get(normalizedName(canonicalName));
        if (!entity) fail(`Official augment ${canonicalName} is required for DataTFT reward binding`);
        bindEntityTable({ ...table, kind: 'augment', groups: [group] }, entity, sourceKey);
      }
      continue;
    }
    const entity = table.kind === 'trait'
      ? traitsByName.get(normalizedName(table.canonical_name))
      : augmentsByName.get(normalizedName(table.canonical_name));
    if (entity) {
      bindEntityTable(table, entity, sourceKey);
    } else {
      supplementalUnboundTables.push({
        table_id: `supplemental:${sourceKey}`,
        name: table.canonical_name,
        kind: table.kind,
        source_key: sourceKey,
        source_ref: rateSnapshot.source,
        catalog_binding_status: 'supplemental_named_table_not_in_official_catalog',
        catalog_legality: 'not_established',
        outcome_semantics: table.outcome_semantics,
        groups: table.groups,
      });
    }
  }
  return {
    schema: 'jcc-version-reward-tables-v1',
    identity: LOCAL_IDENTITY,
    entity_tables: entityTables,
    season_tables: seasonTables,
    supplemental_unbound_tables: supplementalUnboundTables,
    exclusions: rateSnapshot.exclusions || [],
    provenance: rateSnapshot.source,
  };
}

function buildMechanicsParameters(commonBaseline, commonBaselineSha256, rateSnapshot = null) {
  const shop = commonEntry(commonBaseline, 'standard.shop_and_pool');
  const merge = commonEntry(commonBaseline, 'standard.star_upgrade');
  const commonProgression = commonEntry(commonBaseline, 'standard.progression');
  const economy = commonEntry(commonBaseline, 'standard.economy');
  const commonPlayerDamage = commonEntry(commonBaseline, 'standard.player_damage');
  const commonAugmentProbabilities = commonEntry(commonBaseline, 'standard.augment_tier_probabilities');
  const progression = commonProgression;
  const playerDamage = commonPlayerDamage;
  const shopTables = {
    odds_by_level: normalizeVersionComparisonValue('shop.odds_by_level', shop.odds_by_level),
    pool_by_cost: normalizeVersionComparisonValue('shop.pool_by_cost', shop.pool_by_cost),
    reroll_cost: shop.reroll_cost,
    shop_slots: shop.shop_slots,
  };
  return {
    schema: 'jcc-version-mechanics-parameters-v1',
    identity: LOCAL_IDENTITY,
    provenance: {
      authority: 'common_user_confirmed_standard',
      common_source: {
        logical_id: commonBaseline.logical_id,
        content_sha256: commonBaselineSha256,
      },
      runtime_policy: 'authoritative_unless_active_season_explicitly_declares_a_verified_override',
      supplemental_comparison_source: rateSnapshot?.source || null,
    },
    standard_merge_rule: {
      copies_per_merge: merge.copies_per_merge,
      base_copies_by_star: merge.base_copies_by_star,
    },
    progression,
    economy,
    player_damage: playerDamage,
    combat_defaults: {
      base_ability_power: 100,
      mana_per_basic_attack: 10,
      confidence: 'common_runtime_default_not_entity_specific',
    },
    shop: shopTables,
    augment_tier_sequence_probabilities: commonAugmentProbabilities,
    source_comparison: compareVersionParameters(commonBaseline, rateSnapshot),
    formulas: {
      shop_odds: { exactness: 'exact_if_current_shop_parameters_and_pool_state_are_known', tables: shopTables },
      shop_specific_unit_odds: { exactness: 'exact_if_current_shop_parameters_and_pool_state_are_known', tables: shopTables },
      level_timing: {
        exactness: 'exact_for_standard_xp_purchase',
        tables: {
          xp_curve: Object.entries(progression.cumulative_xp_to_level).map(([level, totalXp]) => ({ level: Number(level), totalXp })),
        },
      },
      economy: {
        exactness: 'exact_for_supplied_standard_income_inputs',
        tables: {
          base_income_by_round: economy.base_income_by_round,
          streak_bonus: economy.streak_bonus,
          pvp_win_gold: economy.pvp_win_gold,
          pvp_loss_gold: economy.pvp_loss_gold,
          normal_interest_cap: economy.interest.normal_cap,
        },
      },
      pvp_player_damage: {
        exactness: 'exact_for_registered_standard_stage_and_survivor_count',
        tables: { base_damage_by_stage: playerDamage.base_damage_by_stage },
      },
      hp_lethal_tolerance: {
        exactness: 'threshold_exact_for_given_stage_hp_and_survivor_count',
        tables: { base_damage_by_stage: playerDamage.base_damage_by_stage },
      },
    },
  };
}

function parseTrackerTraitText(value) {
  const match = String(value || '').trim().match(/^(\d+)\s*(.+)$/u);
  if (!match) fail(`Invalid DataTFT tracker trait text: ${value}`);
  return { count: Number(match[1]), name: match[2].trim() };
}

function traitBreakpointAtCount(trait, count) {
  return [...(trait.breakpoints || [])]
    .filter((breakpoint) => Number(breakpoint.count) <= count)
    .sort((left, right) => Number(right.count) - Number(left.count))[0] || null;
}

function buildTrackerTraitNameResolver(projected, snapshot, championBySourceId, traitByExternalId) {
  const resolver = new Map(projected.traits.map((trait) => [normalizedName(trait.name), {
    trait,
    match_kind: 'official_name',
    source_name: trait.name,
  }]));
  const unknownOccurrences = new Map();
  for (const group of snapshot.roster_groups || []) {
    const providerTraitIds = new Set(group.support_key === 'none'
      ? []
      : group.support_key.split('+').map((externalId) => {
          const trait = traitByExternalId.get(externalId);
          if (!trait) fail(`Trait tracker support key references unknown trait ${externalId}`);
          return trait.id;
        }));
    for (const roster of group.identity_evidence_rosters || group.rosters || []) {
      for (const sourceText of roster.trait_texts || []) {
        const parsed = parseTrackerTraitText(sourceText);
        const key = normalizedName(parsed.name);
        if (resolver.has(key)) continue;
        unknownOccurrences.set(key, [
          ...(unknownOccurrences.get(key) || []),
          {
            source_name: parsed.name,
            count: parsed.count,
            source_champion_ids: roster.source_champion_ids,
            provider_trait_ids: providerTraitIds,
          },
        ]);
      }
    }
  }
  for (const [key, occurrences] of unknownOccurrences) {
    const prefixCandidates = projected.traits.filter((trait) => {
      const official = normalizedName(trait.name);
      return key.length >= 2 && (official.startsWith(key) || key.startsWith(official));
    });
    if (prefixCandidates.length === 1) {
      resolver.set(key, {
        trait: prefixCandidates[0],
        match_kind: 'unique_official_name_prefix',
        source_name: occurrences[0].source_name,
      });
      continue;
    }
    const candidates = projected.traits.map((trait) => {
      let matchingOccurrences = 0;
      for (const occurrence of occurrences) {
        const championCount = occurrence.source_champion_ids.reduce((total, sourceChampionId) => {
          const champion = championBySourceId.get(String(sourceChampionId));
          if (!champion) fail(`Trait tracker roster references unknown champion ${sourceChampionId}`);
          return total + (champion.traits.some((entry) => entry.id === trait.id) ? 1 : 0);
        }, 0);
        const providerCount = occurrence.provider_trait_ids.has(trait.id) ? 1 : 0;
        const activeBreakpoint = traitBreakpointAtCount(trait, championCount + providerCount);
        if (Number(activeBreakpoint?.count) === occurrence.count) matchingOccurrences += 1;
      }
      const count_consistency = matchingOccurrences / occurrences.length;
      const name_similarity = textSimilarity(occurrences[0].source_name, trait.name);
      return {
        trait,
        count_consistency,
        name_similarity,
        score: count_consistency * 10 + name_similarity,
      };
    }).filter((candidate) => candidate.count_consistency >= 0.95
      || (candidate.count_consistency >= 0.5 && candidate.name_similarity >= 0.3))
      .sort((left, right) => right.score - left.score || left.trait.id.localeCompare(right.trait.id));
    if (!candidates.length || (candidates.length > 1 && candidates[0].score - candidates[1].score < 0.1)) {
      fail(`Trait tracker alias ${occurrences[0].source_name} did not resolve uniquely against official roster counts`);
    }
    resolver.set(key, {
      trait: candidates[0].trait,
      match_kind: 'dominant_roster_count_and_breakpoint_match',
      source_name: occurrences[0].source_name,
      count_consistency: Number(candidates[0].count_consistency.toFixed(6)),
      name_similarity: Number(candidates[0].name_similarity.toFixed(6)),
    });
  }
  return resolver;
}

function buildTraitDiversityRosterSupport(projected, snapshot) {
  if (!snapshot) return null;
  if (snapshot.schema !== 'jcc-datatft-trait-tracker-snapshot-v2') fail('Invalid DataTFT trait tracker snapshot schema');
  if (snapshot.target?.season_id !== LOCAL_IDENTITY.season_id || snapshot.target?.patch_id !== LOCAL_IDENTITY.patch_id) {
    fail('DataTFT trait tracker snapshot identity does not match the staged patch');
  }
  const championBySourceId = new Map(projected.champions.map((champion) => [
    String(champion.supplemental_source?.chess_id || ''),
    champion,
  ]).filter(([sourceId]) => sourceId));
  const traitByExternalId = new Map(projected.traits.map((trait) => [
    String(trait.supplemental_source?.external_id || ''),
    trait,
  ]).filter(([externalId]) => externalId));
  const traitNameResolver = buildTrackerTraitNameResolver(
    projected,
    snapshot,
    championBySourceId,
    traitByExternalId,
  );
  const augmentByExternalId = new Map(projected.augments.map((augment) => [
    String(augment.supplemental_source?.external_id || ''),
    augment,
  ]).filter(([externalId]) => externalId));
  const augmentByName = new Map(projected.augments.map((augment) => [normalizedName(augment.name), augment]));

  const supportKeys = (snapshot.support_keys || []).map((supportKey) => ({
    support_key: supportKey,
    provider_traits: supportKey === 'none'
      ? []
      : supportKey.split('+').map((externalId) => {
          const trait = traitByExternalId.get(externalId);
          if (!trait) fail(`Trait tracker support key references unknown trait ${externalId}`);
          return { external_id: externalId, id: trait.id, address: trait.address, name: trait.name };
        }),
  }));
  const supportByKey = new Map(supportKeys.map((row) => [row.support_key, row]));

  let rosterGroups = (snapshot.roster_groups || []).map((group) => {
    const support = supportByKey.get(group.support_key);
    if (!support) fail(`Trait tracker roster group uses unknown support key ${group.support_key}`);
    const rosters = (group.rosters || []).map((roster) => {
      const champions = roster.source_champion_ids.map((sourceChampionId) => {
        const champion = championBySourceId.get(String(sourceChampionId));
        if (!champion) fail(`Trait tracker roster references unknown champion ${sourceChampionId}`);
        return champion;
      });
      const traitActivations = roster.trait_texts.map((sourceText) => {
        const parsed = parseTrackerTraitText(sourceText);
        const resolved = traitNameResolver.get(normalizedName(parsed.name));
        const trait = resolved?.trait;
        if (!trait) fail(`Trait tracker roster references unknown trait name ${parsed.name}`);
        const breakpoint = traitBreakpointAtCount(trait, parsed.count);
        if (!breakpoint) fail(`Trait tracker roster uses illegal ${parsed.count} ${trait.name} breakpoint`);
        const uniqueTrait = Number(breakpoint.color) === 5;
        return {
          id: trait.id,
          count: parsed.count,
          breakpoint_color: breakpoint.color,
          bronze_tier: Number(breakpoint.color) === 1,
          unique_trait: uniqueTrait,
          ...(resolved.match_kind === 'official_name' ? {} : {
            source_name: parsed.name,
            identity_match_kind: resolved.match_kind,
            identity_match_confidence: resolved.count_consistency,
          }),
        };
      });
      if (Number(roster.active_trait_count) !== traitActivations.length) {
        fail(`Trait tracker roster ${roster.roster_id} active trait count does not match its trait rows`);
      }
      return {
        roster_id: roster.roster_id,
        ordinal: roster.ordinal,
        team_key: roster.team_key,
        population: Number(group.population),
        support_key: group.support_key,
        champion_ids: champions.map((champion) => champion.id),
        source_champion_ids: roster.source_champion_ids,
        trait_activations: traitActivations,
        metrics: {
          active_trait_count: traitActivations.length,
          non_unique_active_trait_count: traitActivations.filter((trait) => !trait.unique_trait).length,
          bronze_trait_count: traitActivations.filter((trait) => trait.bronze_tier).length,
          four_cost_unit_count: champions.filter((champion) => Number(champion.cost) === 4).length,
          five_cost_unit_count: champions.filter((champion) => Number(champion.cost) === 5).length,
          high_cost_unit_count: champions.filter((champion) => Number(champion.cost) >= 4).length,
          tracker_high_cost_tank_count: Number(roster.high_cost_tank_count || 0),
          tracker_high_cost_carry_count: Number(roster.high_cost_carry_count || 0),
          source_quality: Number(roster.quality),
          total_unit_cost: Number(roster.total_cost),
        },
      };
    });
    return {
      support_key: group.support_key,
      provider_traits: support.provider_traits,
      population: Number(group.population),
      role_constraint_status: group.role_constraint_status,
      upstream_row_count: Number(group.upstream_row_count),
      source_row_count: Number(group.row_count),
      source_maximum_active_trait_count: Number(group.maximum_active_trait_count),
      rosters,
    };
  });

  const objectiveMetrics = Object.freeze({
    trait_ladder_reward_progress: 'non_unique_active_trait_count',
    bronze_trait_scaling: 'bronze_trait_count',
  });
  const rankHighCostPrimary = (left, right) => (
    Number(right.metrics.high_cost_unit_count) - Number(left.metrics.high_cost_unit_count)
    || String(left.roster_id).localeCompare(String(right.roster_id))
  );
  const rankAccessibleFallback = (left, right) => (
    Number(left.metrics.five_cost_unit_count) - Number(right.metrics.five_cost_unit_count)
    || Number(right.metrics.four_cost_unit_count) - Number(left.metrics.four_cost_unit_count)
    || Number(right.metrics.high_cost_unit_count) - Number(left.metrics.high_cost_unit_count)
    || Number(right.metrics.total_unit_cost) - Number(left.metrics.total_unit_cost)
    || String(left.roster_id).localeCompare(String(right.roster_id))
  );

  rosterGroups = rosterGroups.map((group) => {
    let rosters = group.rosters;
    if (group.role_constraint_status !== 'satisfied') {
      const maximumTraits = Math.max(...rosters.map((row) => row.metrics.non_unique_active_trait_count));
      const maximumHighCost = Math.max(...rosters
        .filter((row) => row.metrics.non_unique_active_trait_count === maximumTraits)
        .map((row) => row.metrics.high_cost_unit_count));
      rosters = rosters.filter((row) => row.metrics.non_unique_active_trait_count === maximumTraits
        && row.metrics.high_cost_unit_count === maximumHighCost);
    }
    const objectiveViews = Object.fromEntries(Object.entries(objectiveMetrics).map(([objectiveId, primaryMetric]) => {
      const maximumObjectiveValue = Math.max(...rosters.map((row) => Number(row.metrics[primaryMetric])));
      const primary = rosters.filter((row) => Number(row.metrics[primaryMetric]) === maximumObjectiveValue)
        .sort(rankHighCostPrimary);
      const fallback = rosters.filter((row) => Number(row.metrics[primaryMetric]) === maximumObjectiveValue - 1)
        .sort(rankAccessibleFallback);
      const maximumHighCost = Math.max(...primary.map((row) => row.metrics.high_cost_unit_count));
      const highCostLeaders = primary.filter((row) => row.metrics.high_cost_unit_count === maximumHighCost);
      const championFrequency = new Map();
      for (const roster of highCostLeaders) {
        for (const championId of roster.champion_ids) {
          championFrequency.set(championId, (championFrequency.get(championId) || 0) + 1);
        }
      }
      const frequencyRows = [...championFrequency.entries()]
        .map(([championId, count]) => ({ champion_id: championId, count, share: count / highCostLeaders.length }))
        .sort((left, right) => right.count - left.count || left.champion_id.localeCompare(right.champion_id));
      return [objectiveId, {
        objective_id: objectiveId,
        primary_metric: primaryMetric,
        maximum_objective_value: maximumObjectiveValue,
        primary_roster_ids: primary.map((row) => row.roster_id),
        accessibility_fallback_roster_ids: fallback.map((row) => row.roster_id),
        maximum_high_cost_unit_count: maximumHighCost,
        high_cost_frontier_roster_ids: highCostLeaders.map((row) => row.roster_id),
        common_champion_ids: frequencyRows.filter((row) => row.count === highCostLeaders.length).map((row) => row.champion_id),
        frequent_champions: frequencyRows.filter((row) => row.share >= 0.6),
      }];
    }));
    return {
      ...group,
      source_row_count: rosters.length,
      rosters,
      objective_views: objectiveViews,
    };
  });

  const groupsByPopulation = new Map(rosterGroups.map((group) => [group.population, group]));
  rosterGroups = rosterGroups.map((group) => ({
    ...group,
    rosters: group.rosters.map((roster) => {
      const currentIds = new Set(roster.champion_ids);
      const nextGroup = groupsByPopulation.get(group.population + 1);
      const transitionsByObjective = Object.fromEntries(Object.entries(objectiveMetrics).map(([objectiveId, metric]) => {
        const frontierIds = new Set(nextGroup?.objective_views?.[objectiveId]?.high_cost_frontier_roster_ids || []);
        const nextRows = (nextGroup?.rosters || []).filter((row) => frontierIds.has(row.roster_id));
        const transitions = nextRows.map((next) => {
          const nextIds = new Set(next.champion_ids);
          const keptChampionIds = roster.champion_ids.filter((id) => nextIds.has(id));
          const addedChampionIds = next.champion_ids.filter((id) => !currentIds.has(id));
          const removedChampionIds = roster.champion_ids.filter((id) => !nextIds.has(id));
          return {
            roster_id: next.roster_id,
            population: next.population,
            status: removedChampionIds.length === 0 && addedChampionIds.length === 1
              ? 'exact_add_only'
              : 'degraded_transition',
            kept_champion_ids: keptChampionIds,
            added_champion_ids: addedChampionIds,
            removed_champion_ids: removedChampionIds,
            overlap_count: keptChampionIds.length,
            overlap_ratio: Number((keptChampionIds.length / roster.champion_ids.length).toFixed(6)),
            target_objective_value: Number(next.metrics[metric]),
            target_high_cost_unit_count: next.metrics.high_cost_unit_count,
          };
        }).sort((left, right) => right.overlap_count - left.overlap_count
          || left.roster_id.localeCompare(right.roster_id));
        return [objectiveId, transitions.slice(0, 3)];
      }));
      return { ...roster, next_population_transitions_by_objective: transitionsByObjective };
    }),
  }));

  const objectiveDefinitions = [
    {
      objective_id: 'trait_ladder_reward_progress',
      primary_metric: 'non_unique_active_trait_count',
      tie_breakers: ['high_cost_unit_count'],
      reward_table_ref: 'augment:30749:rewards',
      runtime_policy: 'Prefer the next reachable reward threshold, then use current-match strength and Master+ evidence only as post-selection evidence.',
    },
    {
      objective_id: 'bronze_trait_scaling',
      primary_metric: 'bronze_trait_count',
      tie_breakers: ['high_cost_unit_count'],
      reward_table_ref: null,
      runtime_policy: 'Maximize currently active bronze-tier traits without treating tracker quality as lineup-strength evidence.',
    },
  ];
  const augmentBindings = (snapshot.augment_targets || []).map((target) => {
    const augment = augmentByExternalId.get(String(target.external_id || ''))
      || augmentByName.get(normalizedName(target.canonical_name));
    if (!augment) fail(`Trait tracker target augment was not found: ${target.canonical_name}`);
    const binding = {
      augment_id: augment.id,
      augment_address: augment.address,
      augment_name: augment.name,
      aliases: sortedUnique([augment.name, ...(augment.aliases || []), target.canonical_name]),
      external_id: target.external_id,
      objective_id: target.objective_id,
      roster_support_id: `${LOCAL_IDENTITY.patch_id}:trait_diversity_rosters`,
    };
    augment.trait_roster_support_ref = binding.roster_support_id;
    augment.trait_roster_objective_id = binding.objective_id;
    return binding;
  });
  const rosterCount = rosterGroups.reduce((total, group) => total + group.rosters.length, 0);
  return {
    schema: 'jcc-trait-diversity-roster-support-v2',
    identity: LOCAL_IDENTITY,
    roster_support_id: `${LOCAL_IDENTITY.patch_id}:trait_diversity_rosters`,
    source: {
      provider_id: snapshot.source?.provider_id || 'datatft',
      page_url: snapshot.source?.page_url || null,
      tracker_asset_url: snapshot.source?.tracker_asset_url || null,
      tracker_asset_sha256: snapshot.source?.tracker_asset_sha256 || null,
      trust_role: 'supplemental_precomputed_roster_candidates_not_strength_authority',
    },
    objective_definitions: objectiveDefinitions,
    augment_bindings: augmentBindings,
    champion_refs: Object.fromEntries(projected.champions.map((champion) => [champion.id, {
      id: champion.id,
      name: champion.name,
      cost: champion.cost,
    }])),
    trait_refs: Object.fromEntries(projected.traits.map((trait) => [trait.id, {
      id: trait.id,
      name: trait.name,
      type: trait.type,
    }])),
    support_keys: supportKeys,
    populations: snapshot.tracker_contract?.populations || [],
    roster_groups: rosterGroups,
    counts: {
      augment_bindings: augmentBindings.length,
      support_keys: supportKeys.length,
      population_buckets: rosterGroups.length,
      source_candidate_rows: rosterCount,
    },
    policy: {
      official_catalog_identity_only: true,
      rosters_are_atomic_and_must_not_be_spliced: true,
      tracker_metrics_are_not_master_plus_strength: true,
      master_plus_rankings_may_rerank_only_after_trait_objective_eligibility: true,
      runtime_online_fetch_forbidden: true,
    },
  };
}

function buildTraitDiversityRosterIndex(support) {
  if (!support) return {
    schema: 'jcc-trait-diversity-roster-index-v2', identity: LOCAL_IDENTITY,
    available: false, augment_bindings: [], groups: {},
  };
  return {
    schema: 'jcc-trait-diversity-roster-index-v2',
    identity: LOCAL_IDENTITY,
    available: true,
    roster_support_id: support.roster_support_id,
    objective_definitions: support.objective_definitions,
    augment_bindings: support.augment_bindings,
    support_keys: support.support_keys,
    populations: support.populations,
    groups: Object.fromEntries(support.group_shards.map((group) => [
      `${group.support_key}:${group.population}`,
      {
        relative_path: group.relative_path,
        sha256: group.sha256,
        byte_size: group.byte_size,
        source_candidate_rows: group.source_candidate_rows,
        metric_maxima: group.metric_maxima,
      },
    ])),
    counts: support.counts,
    policy: support.policy,
  };
}

function partitionTraitDiversityRosterSupport(support) {
  if (!support) return { descriptor: null, shardRecords: [] };
  const shardRecords = support.roster_groups.map((group) => {
    const supportToken = group.support_key === 'none'
      ? 'none'
      : sha256(group.support_key).slice(0, 16);
    const relativePath = `normalized/trait-diversity-rosters/${supportToken}/${group.population}.json`;
    return artifactRecord(relativePath, {
      schema: 'jcc-trait-diversity-roster-shard-v2',
      roster_support_id: support.roster_support_id,
      support_key: group.support_key,
      provider_traits: group.provider_traits,
      population: group.population,
      source_candidate_rows: group.source_row_count,
      source_maximum_active_trait_count: group.source_maximum_active_trait_count,
      role_constraint_status: group.role_constraint_status,
      objective_views: group.objective_views,
      rosters: group.rosters,
    }, { compact: true });
  });
  const recordByKey = new Map(shardRecords.map((record) => {
    const shard = record.value;
    return [`${shard.support_key}:${shard.population}`, record];
  }));
  const groupShards = support.roster_groups.map((group) => {
    const record = recordByKey.get(`${group.support_key}:${group.population}`);
    const metricMaxima = {
      non_unique_active_trait_count: Math.max(...group.rosters.map((row) => row.metrics.non_unique_active_trait_count)),
      bronze_trait_count: Math.max(...group.rosters.map((row) => row.metrics.bronze_trait_count)),
    };
    return {
      support_key: group.support_key,
      provider_traits: group.provider_traits,
      population: group.population,
      relative_path: record.relativePath,
      sha256: record.sha256,
      byte_size: record.bytes,
      source_candidate_rows: group.source_row_count,
      metric_maxima: metricMaxima,
      role_constraint_status: group.role_constraint_status,
      objective_views: group.objective_views,
    };
  });
  const sourceCandidateRows = support.roster_groups.reduce((total, group) => total + group.rosters.length, 0);
  const unitSlotOccurrences = support.roster_groups.reduce((total, group) => total + group.rosters.length * group.population, 0);
  const uniqueChampionEntitiesUsed = new Set(support.roster_groups.flatMap((group) => (
    group.rosters.flatMap((roster) => roster.champion_ids)
  ))).size;
  return {
    descriptor: {
      ...support,
      roster_groups: undefined,
      group_shards: groupShards,
      counts: {
        augment_bindings: support.augment_bindings.length,
        support_keys: support.support_keys.length,
        population_buckets: groupShards.length,
        source_candidate_rows: sourceCandidateRows,
        unit_slot_occurrences: unitSlotOccurrences,
        unique_champion_entities_used: uniqueChampionEntitiesUsed,
        catalog_champion_entities: Object.keys(support.champion_refs).length,
      },
    },
    shardRecords,
  };
}

function applySourceEntityMappings(projected, mappingConfig = null) {
  const aliases = Array.isArray(mappingConfig?.champion_aliases) ? mappingConfig.champion_aliases : [];
  const variants = Array.isArray(mappingConfig?.champion_variants) ? mappingConfig.champion_variants : [];
  const championsById = new Map(projected.champions.map((row) => [String(row.id), row]));
  const traitsById = new Map(projected.traits.map((row) => [String(row.id), row]));
  const claimedSourceIds = new Map();
  const normalizedRows = [];

  for (const mapping of [...aliases, ...variants]) {
    const sourceId = String(mapping?.source_id || '').trim();
    const canonicalChampionId = String(mapping?.canonical_champion_id || '').trim();
    const champion = championsById.get(canonicalChampionId);
    if (!/^\d+$/u.test(sourceId)) fail(`Invalid source champion mapping id: ${sourceId || '<empty>'}`);
    if (!champion) fail(`Source champion mapping ${sourceId} references unknown canonical champion ${canonicalChampionId}`);
    if (mapping.canonical_name && mapping.canonical_name !== champion.name) {
      fail(`Source champion mapping ${sourceId} canonical name mismatch: ${mapping.canonical_name} != ${champion.name}`);
    }
    if (claimedSourceIds.has(sourceId)) fail(`Duplicate source champion mapping id: ${sourceId}`);
    const officialOwner = projected.champions.find((row) => [
      row.id,
      row.mumu_base_id,
      ...(row.raw_refs?.raw_star_ids || []),
    ].map(String).includes(sourceId));
    if (officialOwner && officialOwner.id !== canonicalChampionId) {
      fail(`Source champion mapping ${sourceId} collides with official champion ${officialOwner.id}`);
    }

    const variantTraitId = mapping.variant_trait_id == null ? null : String(mapping.variant_trait_id);
    const variantTrait = variantTraitId ? traitsById.get(variantTraitId) : null;
    if (variantTraitId && !variantTrait) fail(`Source champion mapping ${sourceId} references unknown trait ${variantTraitId}`);
    if (variantTrait && mapping.variant_trait_name && mapping.variant_trait_name !== variantTrait.name) {
      fail(`Source champion mapping ${sourceId} trait name mismatch: ${mapping.variant_trait_name} != ${variantTrait.name}`);
    }

    const normalized = {
      source_id: sourceId,
      canonical_champion_id: canonicalChampionId,
      canonical_name: champion.name,
      mapping_kind: String(mapping.mapping_kind || 'source_alias'),
      authority: String(mapping.authority || 'patch_source_manifest'),
      ...(variantTrait ? {
        variant_order: Number(mapping.variant_order),
        variant_trait_id: variantTrait.id,
        variant_trait_name: variantTrait.name,
      } : {}),
    };
    claimedSourceIds.set(sourceId, normalized);
    normalizedRows.push(normalized);
    champion.raw_refs = champion.raw_refs || {};
    champion.raw_refs.origin_hero_ids = sortedUnique([...(champion.raw_refs.origin_hero_ids || []), sourceId]);
    champion.source_mappings = [...(champion.source_mappings || []), normalized];
    if (variantTrait) champion.source_variants = [...(champion.source_variants || []), normalized];
  }

  return {
    schema: mappingConfig?.schema || 'jcc-patch-source-entity-mappings-v1',
    identity: LOCAL_IDENTITY,
    champion_mappings: stableRows(normalizedRows),
    counts: {
      champion_aliases: aliases.length,
      champion_variants: variants.length,
      champion_mappings: normalizedRows.length,
    },
  };
}

function rebindInheritedMechanics(mechanics, inheritance) {
  if (!mechanics) return null;
  const rebound = structuredClone(mechanics);
  rebound.identity = LOCAL_IDENTITY;
  rebound.provenance = {
    ...(rebound.provenance || {}),
    inherited_from: {
      generation_id: inheritance.generation_id,
      role: 'mechanics_parameters',
    },
  };
  return rebound;
}

function rebindInheritedRewardTables(rewardTables, projected, inheritance) {
  if (!rewardTables) return null;
  const rebound = structuredClone(rewardTables);
  rebound.identity = LOCAL_IDENTITY;
  rebound.provenance = {
    ...(rebound.provenance || {}),
    inherited_from: {
      generation_id: inheritance.generation_id,
      role: 'reward_tables',
    },
  };
  const entitiesByKindAndId = new Map([
    ...projected.traits.map((entity) => [`trait:${entity.id}`, entity]),
    ...projected.augments.map((entity) => [`augment:${entity.id}`, entity]),
  ]);
  for (const table of rebound.entity_tables || []) {
    const entity = entitiesByKindAndId.get(`${table.entity_ref?.kind}:${table.entity_ref?.id}`);
    if (!entity) fail(`Inherited reward table entity is absent from the current catalog: ${table.table_id}`);
    table.entity_ref = {
      kind: table.entity_ref.kind,
      id: entity.id,
      address: entity.address,
      name: entity.name,
    };
    entity.reward_table_ref = table.table_id;
  }
  return rebound;
}

function buildArtifacts(importResult, commonBaseline, commonBaselineSha256, supplementalSnapshot = null, rateSnapshot = null, officialAugmentSnapshot = null, traitTrackerSnapshot = null, sourceEntityMappings = null, itemUsageTaxonomy = null, championRuntimeSemantics = null, patchSourceManifest = null, balancePatch = null, inheritedHardData = null) {
  for (const [kind, count] of Object.entries(EXPECTED_SOURCE_DOC_COUNTS)) {
    if (importResult.catalogs?.[kind]?.items?.length !== count) fail(`${kind} count mismatch: expected ${count}`);
  }
  const sourceProjected = projectCatalogs(importResult.catalogs, itemUsageTaxonomy, championRuntimeSemantics);
  if (officialAugmentSnapshot) {
    sourceProjected.augments = projectOfficialAugments(officialAugmentSnapshot, sourceProjected.augments);
  }
  sourceProjected.augments = applyConfirmedPatchAugmentExtensions(sourceProjected.augments, patchSourceManifest, supplementalSnapshot);
  const merged = mergeSupplementalCatalogs(sourceProjected, supplementalSnapshot);
  const balanceBaselineGenerationId = patchSourceManifest?.parent_core_generation_id
    || patchSourceManifest?.hard_data_candidate?.generation_id;
  const inheritance = patchSourceManifest?.hard_data_inheritance || null;
  const patchableMechanics = rebindInheritedMechanics(inheritedHardData?.mechanics_parameters, inheritance)
    || buildMechanicsParameters(commonBaseline, commonBaselineSha256, rateSnapshot);
  const patchableRewardTables = rebindInheritedRewardTables(inheritedHardData?.reward_tables, merged.projected, inheritance)
    || buildRewardTables(merged.projected, rateSnapshot);
  const patchableSeasonMetadata = {
    id: `season:${LOCAL_IDENTITY.season_id}`,
    name: LOCAL_IDENTITY.season_id,
  };
  const patched = balancePatch
    ? applyBalancePatchSet({
        identity: { ...LOCAL_IDENTITY, hard_data_generation_id: balanceBaselineGenerationId },
        ...merged.projected,
        mechanics_parameters: [patchableMechanics],
        reward_tables: [patchableRewardTables],
        season_metadata: [patchableSeasonMetadata],
      }, balancePatch)
    : { catalogs: merged.projected, audit: null };
  const projected = patched.catalogs;
  const normalizedSourceEntityMappings = applySourceEntityMappings(projected, sourceEntityMappings);
  const rewardTables = projected.reward_tables?.[0] || patchableRewardTables;
  const completeTraitDiversityRosterSupport = buildTraitDiversityRosterSupport(projected, traitTrackerSnapshot);
  const {
    descriptor: traitDiversityRosterSupport,
    shardRecords: traitDiversityRosterShardRecords,
  } = partitionTraitDiversityRosterSupport(completeTraitDiversityRosterSupport);
  const normalized = {
    champions: projected.champions,
    chess_variants: projected.chess_variants,
    traits: projected.traits,
    items: projected.items,
    augments: projected.augments,
    reward_tables: rewardTables,
    trait_diversity_roster_support: traitDiversityRosterSupport || {
      schema: 'jcc-trait-diversity-roster-support-v2', identity: LOCAL_IDENTITY,
      roster_support_id: `${LOCAL_IDENTITY.patch_id}:trait_diversity_rosters`, available: false,
      objective_definitions: [], augment_bindings: [], support_keys: [], populations: [], group_shards: [],
      counts: { augment_bindings: 0, support_keys: 0, population_buckets: 0, source_candidate_rows: 0, unit_slot_occurrences: 0, unique_champion_entities_used: 0, catalog_champion_entities: 0 },
    },
    season_mechanics: {
      schema: 'jcc-season-mechanics-v1', identity: LOCAL_IDENTITY,
      balance_overrides: projected.season_metadata?.[0]?.balance_overrides || null,
      choice_mechanics: [], manual_variable_fields: [],
      shop_extensions: [{
        mechanic_id: 'sprite_shop_extension', kind: 'shop_extension', catalog_kind: 'sprite',
        choice_mode: false, manual_variable: false, entries: projected.sprites,
      }],
    },
    per_match_variables: {
      schema: 'jcc-per-match-variables-v1', identity: LOCAL_IDENTITY,
      prompt_at_match_start: [], variables: [],
    },
    mechanics_parameters: projected.mechanics_parameters?.[0] || patchableMechanics,
    source_entity_mappings: normalizedSourceEntityMappings,
    balance_patch_audit: patched.audit || {
      schema: 'jcc-core-balance-patch-audit-v1', release_version: null, baseline: null, applied_operations: 0, operations: [],
    },
  };
  const indexes = {
    entity_alias_gateway: buildAliasGateway(projected),
    ...buildRuntimeDecisionIndexes(projected),
    augment_stage_authority: {
      schema: 'jcc-decision-input-augment-stage-authority-v1', identity: LOCAL_IDENTITY,
      authority_source: supplementalSnapshot ? 'datatft_s18_database_snapshot' : 's18_source_docs_no_stage_authority',
      notes: supplementalSnapshot
        ? ['Exact augment stages and categories enrich official augments matched from the pinned DataTFT S18 snapshot.', 'Unmatched supplemental augments are excluded from the production catalog and stage index.']
        : ['No prior-season stage authority is inherited; unbound S18 augments remain search-only.'],
      category_definitions: supplementalSnapshot?.category_definitions?.augment || [],
      augment_stage_bindings: projected.augments.filter((row) => row.rounds?.length).map((row) => ({
        id: row.id,
        address: row.address,
        name: row.name,
        rounds: row.rounds,
        tier_color: row.tier_color || null,
        category_ids: row.category_ids || [],
        category_labels: row.category_labels || [],
        authority: row.stage_authority || 'datatft_supplemental_verified_snapshot',
        source_ref: row.supplemental_source || null,
      })),
      generated_augments: [],
    },
    trait_diversity_roster_index: buildTraitDiversityRosterIndex(traitDiversityRosterSupport),
    supplemental_source_audit: merged.audit,
    balance_patch_audit: patched.audit || null,
  };
  const championsById = {};
  for (const champion of projected.champions) {
    const sourceChampion = importResult.catalogs.champions.items.find((row) => String(row.official_id) === champion.id);
    const ids = [champion.id, sourceChampion?.mumu_base_id, ...(sourceChampion?.raw_star_ids || [])].filter(Boolean);
    for (const id of ids) {
      const starIndex = sourceChampion?.raw_star_ids?.indexOf(String(id)) ?? -1;
      championsById[String(id)] = {
        id: String(id), canonical_id: champion.id, name: champion.name, normalized_name: champion.name,
        cost: champion.cost, star: starIndex >= 0 ? starIndex + 1 : null,
        class_or_trait_codes: champion.traits.map((trait) => trait.id).filter(Boolean).join('|'),
        icon_url: sourceChampion?.assets?.portrait_url || null, resource_key: sourceChampion?.resource_key || null,
        source: 's18_official_identity_map',
      };
    }
    for (const mapping of champion.source_mappings || []) {
      const variantTraitCodes = mapping.variant_trait_id
        ? [...champion.traits.map((trait) => trait.id).filter(Boolean), mapping.variant_trait_id]
        : champion.traits.map((trait) => trait.id).filter(Boolean);
      championsById[String(mapping.source_id)] = {
        id: String(mapping.source_id),
        canonical_id: champion.id,
        name: champion.name,
        normalized_name: champion.name,
        cost: champion.cost,
        star: 1,
        class_or_trait_codes: sortedUnique(variantTraitCodes).join('|'),
        icon_url: sourceChampion?.assets?.portrait_url || null,
        resource_key: sourceChampion?.resource_key || null,
        source: 's18_patch_source_entity_mapping',
        mapping_kind: mapping.mapping_kind,
        source_mapping_authority: mapping.authority,
        ...(mapping.variant_trait_id ? {
          source_variant: {
            source_id: mapping.source_id,
            order: mapping.variant_order,
            trait_id: mapping.variant_trait_id,
            trait_name: mapping.variant_trait_name,
          },
        } : {}),
      };
    }
  }
  const itemsById = Object.fromEntries(projected.items.map((item) => [item.id, {
    id: item.id, name: item.name, normalized_name: item.name, icon_code: item.icon_key || item.id,
    icon_url: item.icon_url || null, component_1: item.recipe?.component_ids?.[0] || '0',
    component_2: item.recipe?.component_ids?.[1] || '0', formula: item.recipe?.formula_source_text || '',
    source: 's18_official_identity_map',
  }]));
  const runtimeOverlay = {
    schema: 'jcc-runtime-catalog-overlay-v1', identity: LOCAL_IDENTITY,
    source: 'staged_s18_source_docs', aliases: [], champions_by_id: championsById, items_by_id: itemsById,
    traits_by_id: Object.fromEntries(projected.traits.map((row) => [row.id, {
      id: row.id,
      code_id: row.id,
      name: row.name,
      normalized_name: row.name,
      breakpoints: row.num_list.join('|'),
      icon_url: row.icon_url || null,
      address: row.address,
      source: 's18_official_identity_map_unverified_mumu_code',
    }])),
    augments_by_id: Object.fromEntries(projected.augments.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      normalized_name: row.name,
      tier: row.tier,
      icon_url: row.icon_url || null,
      address: row.address,
      source: 's18_official_identity_map',
    }])),
  };
  return { normalized, indexes, runtimeOverlay, traitDiversityRosterShardRecords };
}

async function loadInheritedHardData(manifest) {
  const inheritance = manifest?.hard_data_inheritance;
  if (!inheritance) return null;
  const allowedRoles = new Set(['mechanics_parameters', 'reward_tables']);
  const roles = inheritance.roles || [];
  if (!roles.length || roles.some((role) => !allowedRoles.has(role))) {
    fail('hard_data_inheritance.roles contains an unsupported or empty role set');
  }
  const generationId = String(inheritance.generation_id || '');
  if (!/^[a-f0-9]{64}$/.test(generationId)) fail('hard_data_inheritance.generation_id is invalid');
  const generationDir = path.join(REPO_ROOT, 'data', 'core-patches', 'jcc', 'generations', generationId);
  const parentManifest = JSON.parse(await readFile(path.join(generationDir, 'manifest.json'), 'utf8'));
  if (parentManifest.hard_data_generation_id !== generationId) fail('Inherited hard-data manifest identity mismatch');
  if (parentManifest.identity?.season_id !== manifest.season_id) fail('Cross-season hard-data role inheritance is not allowed');
  const inherited = {};
  for (const role of roles) {
    inherited[role] = JSON.parse(await readFile(path.join(generationDir, 'normalized', `${role}.json`), 'utf8'));
  }
  return inherited;
}

function serialize(value) {
  const stable = (entry) => Array.isArray(entry)
    ? entry.map(stable)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, stable(entry[key])]))
      : entry;
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function artifactRecord(relativePath, value, options = {}) {
  const content = serialize(value);
  return { relativePath, value, content, sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

async function writeArtifacts(outDir, records) {
  for (const record of records) {
    const file = path.join(outDir, ...record.relativePath.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, record.content, 'utf8');
  }
}

function sourceDocuments(importManifest) {
  return Object.fromEntries(Object.entries(importManifest.catalogs || {}).map(([kind, row]) => [kind, {
    source_document: row.source_document, source_sha256: row.source_sha256,
  }]));
}

export async function stageS18HardData(options = {}) {
  const patchSourceManifestFile = path.resolve(options.patchSourceManifestFile || PATCH_SOURCE_MANIFEST_FILE);
  const patchSourceManifest = options.patchSourceManifest
    || JSON.parse(await readFile(patchSourceManifestFile, 'utf8'));
  configurePatchContext(patchSourceManifest);
  const inheritedHardData = await loadInheritedHardData(patchSourceManifest);
  const outDir = path.resolve(options.outDir);
  const managedRoot = path.join(REPO_ROOT, 'data', 'core-patches', 'jcc');
  const relativeManaged = path.relative(managedRoot, outDir).replaceAll('\\', '/');
  const relativeTemp = path.relative(path.resolve(os.tmpdir()), outDir);
  const isManagedStaging = /^\.staging-[^/]+$/.test(relativeManaged);
  const isSystemTemp = relativeTemp && !relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp);
  if (!isManagedStaging && !isSystemTemp) {
    throw new Error('S18 hard-data staging output must use a system temporary directory or data/core-patches/jcc/.staging-*; immutable generations are publisher-owned');
  }
  const shouldLoadVendoredSupplement = options.supplementalSnapshot
    || options.datatftSnapshotFile
    || options.rateSnapshot
    || options.datatftRateSnapshotFile
    || options.traitTrackerSnapshot
    || options.datatftTraitTrackerSnapshotFile
    || options.officialAugmentSnapshot
    || options.officialAugmentSnapshotFile
    || !options.importResult;
  let importRoot = null;
  let importResult = options.importResult ? structuredClone(options.importResult) : null;
  if (!importResult) {
    importRoot = await mkdtemp(path.join(os.tmpdir(), 'jcc-s18-hard-data-source-import-'));
    importResult = await importS18SourceDocs({
      championsDoc: options.championsDoc, augmentsDoc: options.augmentsDoc,
      spritesDoc: options.spritesDoc, equipmentDoc: options.equipmentDoc,
      outDir: importRoot,
      seasonId: LOCAL_IDENTITY.season_id, patchId: LOCAL_IDENTITY.patch_id, modeId: LOCAL_IDENTITY.mode_id,
      upstreamSeasonId: UPSTREAM_PROVENANCE.season_id, upstreamVersion: UPSTREAM_PROVENANCE.data_version,
      expectedCounts: EXPECTED_SOURCE_DOC_COUNTS,
    });
  }
  try {
    let supplementalSnapshot = options.supplementalSnapshot || null;
    if (!supplementalSnapshot && shouldLoadVendoredSupplement) {
      const snapshotFile = path.resolve(options.datatftSnapshotFile || DATATFT_SNAPSHOT_FILE);
      supplementalSnapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
    }
    let rateSnapshot = options.rateSnapshot || null;
    if (!rateSnapshot && shouldLoadVendoredSupplement) {
      const rateSnapshotFile = path.resolve(options.datatftRateSnapshotFile || DATATFT_RATE_SNAPSHOT_FILE);
      rateSnapshot = JSON.parse(await readFile(rateSnapshotFile, 'utf8'));
    }
    let officialAugmentSnapshot = options.officialAugmentSnapshot || null;
    if (!officialAugmentSnapshot && shouldLoadVendoredSupplement) {
      const officialAugmentSnapshotFile = path.resolve(options.officialAugmentSnapshotFile || OFFICIAL_AUGMENT_SNAPSHOT_FILE);
      officialAugmentSnapshot = JSON.parse(await readFile(officialAugmentSnapshotFile, 'utf8'));
    }
    let traitTrackerSnapshot = options.traitTrackerSnapshot || null;
    if (!traitTrackerSnapshot && shouldLoadVendoredSupplement) {
      const traitTrackerSnapshotFile = path.resolve(options.datatftTraitTrackerSnapshotFile || DATATFT_TRAIT_TRACKER_SNAPSHOT_FILE);
      traitTrackerSnapshot = JSON.parse(await readFile(traitTrackerSnapshotFile, 'utf8'));
    }
    const itemUsageTaxonomyFile = path.resolve(options.itemUsageTaxonomyFile || ITEM_USAGE_TAXONOMY_FILE);
    const itemUsageTaxonomyText = options.itemUsageTaxonomy
      ? serialize(options.itemUsageTaxonomy)
      : await readFile(itemUsageTaxonomyFile, 'utf8');
    const itemUsageTaxonomy = options.itemUsageTaxonomy || JSON.parse(itemUsageTaxonomyText);
    const commonBaselineText = await readFile(options.commonBaselineFile || COMMON_BASELINE_FILE, 'utf8');
    const commonBaseline = JSON.parse(commonBaselineText);
    if (commonBaseline.authority?.kind !== 'user_confirmed_common_standard') {
      fail('Common standard baseline must carry user_confirmed_common_standard authority');
    }
    const balancePatch = options.balancePatch
      || (patchSourceManifest?.balance_patch
        ? JSON.parse(await readFile(options.balancePatchFile || BALANCE_PATCH_FILE, 'utf8'))
        : null);
    const artifacts = buildArtifacts(
      importResult,
      commonBaseline,
      sha256(commonBaselineText),
      supplementalSnapshot,
      rateSnapshot,
      officialAugmentSnapshot,
      traitTrackerSnapshot,
      patchSourceManifest?.source_entity_mappings,
      itemUsageTaxonomy,
      patchSourceManifest?.source_entity_mappings?.champion_runtime_semantics,
      patchSourceManifest,
      balancePatch,
      inheritedHardData,
    );
    const contentRecords = [
      ...Object.entries(artifacts.normalized).map(([name, value]) => artifactRecord(`normalized/${name}.json`, value)),
      ...Object.entries(artifacts.indexes).map(([name, value]) => artifactRecord(`indexes/${name}.json`, value)),
      ...artifacts.traitDiversityRosterShardRecords,
      artifactRecord('runtime-catalog-overlay.json', artifacts.runtimeOverlay),
    ];
    const counts = buildNormalizedArtifactCounts(artifacts.normalized);
    const hardDataManifest = {
      schema: 'jcc-hard-data-content-manifest-v1', identity: LOCAL_IDENTITY,
      runtime_patch_id: LOCAL_IDENTITY.patch_id, deterministic: true, rankings_included: false,
      counts, files: Object.fromEntries(contentRecords.map((row) => [row.relativePath, { sha256: row.sha256, bytes: row.bytes }])),
    };
    const hardDataRecord = artifactRecord('hard-data-manifest.json', hardDataManifest);
    const hardDataGenerationId = sha256(serialize({
      schema: 'jcc-hard-data-generation-identity-v1',
      package_id: PACKAGE_ID,
      identity: LOCAL_IDENTITY,
      source_package_id: SOURCE_PACKAGE_ID,
      balance_patch: balancePatch ? {
        release_version: balancePatch.release_version,
        source_note_sha256: balancePatch.source_note_sha256,
        schema: balancePatch.schema,
        applied_operations: artifacts.indexes.balance_patch_audit?.applied_operations || 0,
      } : null,
      hard_data_manifest_sha256: hardDataRecord.sha256,
    }));
    const manifest = {
      schema: 'jcc-s18-hard-data-staging-v1', packageId: PACKAGE_ID, game: '金铲铲之战',
      mode: String(UPSTREAM_PROVENANCE.mode || '18'), season: LOCAL_IDENTITY.season_id.replace(/^s/, ''),
      modeName: 'Mode18NatureForce', version: UPSTREAM_PROVENANCE.data_version, runtime_patch_id: LOCAL_IDENTITY.patch_id,
      release_version: balancePatch?.release_version || null,
      source_package_id: SOURCE_PACKAGE_ID,
      identity: LOCAL_IDENTITY,
      parent_core_generation_id: balancePatch?.baseline?.hard_data_generation_id || patchSourceManifest?.parent_core_generation_id || patchSourceManifest?.hard_data_candidate?.generation_id || null,
      balance_patch: balancePatch ? {
        schema: balancePatch.schema,
        release_version: balancePatch.release_version,
        source_note_sha256: balancePatch.source_note_sha256,
        baseline: balancePatch.baseline,
        applied_operations: artifacts.indexes.balance_patch_audit?.applied_operations || 0,
      } : null,
      upstream_provenance: {
        mode: '18', season: UPSTREAM_PROVENANCE.season_id, version: UPSTREAM_PROVENANCE.data_version,
        framework_name: 'Mode18NatureForce', ...UPSTREAM_PROVENANCE,
        source_documents: sourceDocuments(importResult.manifest),
        official_augment_catalog: officialAugmentSnapshot ? {
          provider_id: officialAugmentSnapshot.source?.provider_id || 'jcc_official',
          page_url: officialAugmentSnapshot.source?.page_url || null,
          augment_url: officialAugmentSnapshot.source?.augment_url || null,
          augment_payload_sha256: officialAugmentSnapshot.source?.augment_payload_sha256 || null,
          snapshot_schema: officialAugmentSnapshot.schema,
          rows: officialAugmentSnapshot.counts?.rows || 0,
        } : null,
        item_usage_taxonomy: {
          schema: itemUsageTaxonomy.schema,
          authority: itemUsageTaxonomy.authority,
          content_sha256: sha256(itemUsageTaxonomyText),
          entries: itemUsageTaxonomy.entries?.length || 0,
        },
        supplemental_database: supplementalSnapshot ? {
          provider_id: supplementalSnapshot.source?.provider_id || 'datatft',
          page_url: supplementalSnapshot.source?.page_url || null,
          encrypted_data_asset_sha256: supplementalSnapshot.source?.encrypted_data_asset_sha256 || null,
          snapshot_schema: supplementalSnapshot.schema,
        } : null,
        supplemental_rate_tables: rateSnapshot ? {
          provider_id: rateSnapshot.source?.provider_id || 'datatft',
          page_url: rateSnapshot.source?.page_url || null,
          index_asset_sha256: rateSnapshot.source?.index_asset_sha256 || null,
          encrypted_data_asset_sha256: rateSnapshot.source?.encrypted_data_asset_sha256 || null,
          snapshot_schema: rateSnapshot.schema,
        } : null,
        supplemental_trait_tracker: traitTrackerSnapshot ? {
          provider_id: traitTrackerSnapshot.source?.provider_id || 'datatft',
          page_url: traitTrackerSnapshot.source?.page_url || null,
          tracker_asset_url: traitTrackerSnapshot.source?.tracker_asset_url || null,
          tracker_asset_sha256: traitTrackerSnapshot.source?.tracker_asset_sha256 || null,
          snapshot_schema: traitTrackerSnapshot.schema,
          upstream_no_emblem_candidate_rows: traitTrackerSnapshot.counts?.upstream_no_emblem_candidate_rows || 0,
          retained_default_candidate_rows: traitTrackerSnapshot.counts?.staging_input_candidate_rows || 0,
          unit_slot_occurrences: traitTrackerSnapshot.counts?.unit_slot_occurrences || 0,
          unique_champion_entities_used: traitTrackerSnapshot.counts?.unique_champion_entities_used || 0,
        } : null,
        balance_patch: balancePatch ? {
          schema: balancePatch.schema,
          release_version: balancePatch.release_version,
          source_note_sha256: balancePatch.source_note_sha256,
          baseline: balancePatch.baseline,
        } : null,
      },
      deterministic: true, immutable: true, hard_data_generation_id: hardDataGenerationId,
      promoted: false, rankings_included: false,
      hard_data_manifest: { file: hardDataRecord.relativePath, sha256: hardDataRecord.sha256, bytes: hardDataRecord.bytes },
    };
    await writeArtifacts(outDir, [artifactRecord('manifest.json', manifest), hardDataRecord, ...contentRecords]);
    return { outDir, manifest, hardDataManifest, hardDataGenerationId, artifacts };
  } finally {
    if (importRoot) await rm(importRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals >= 0) values.set(token.slice(2, equals), token.slice(equals + 1));
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`Missing value for ${token}`);
      values.set(token.slice(2), value);
    }
  }
  return {
    championsDoc: values.get('champions-doc'), augmentsDoc: values.get('augments-doc'),
    spritesDoc: values.get('sprites-doc'), equipmentDoc: values.get('equipment-doc'),
    datatftSnapshotFile: values.get('datatft-snapshot'),
    datatftRateSnapshotFile: values.get('datatft-rate-snapshot'),
    datatftTraitTrackerSnapshotFile: values.get('datatft-trait-tracker-snapshot'),
    officialAugmentSnapshotFile: values.get('official-augment-snapshot'),
    itemUsageTaxonomyFile: values.get('item-usage-taxonomy'),
    balancePatchFile: values.get('balance-patch') || values.get('balance-changes'),
    patchSourceManifestFile: values.get('patch-source-manifest'),
    outDir: values.get('out-dir'),
  };
}

export async function discoverVendoredDocs(repoRoot) {
  const discovered = {};
  for (const relativeRoot of VENDORED_ROOTS) {
    const root = path.join(repoRoot, relativeRoot);
    let names;
    try { names = await readdir(root); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    for (const name of names.filter((entry) => /\.md$/i.test(entry)).sort()) {
      const file = path.join(root, name);
      const text = await readFile(file, 'utf8');
      if (!discovered.championsDoc && /## 英雄详情/.test(text) && /### (?:特质|职业)：/.test(text)) discovered.championsDoc = file;
      if (!discovered.augmentsDoc && /## 一级强化符文/.test(text)) discovered.augmentsDoc = file;
      if (!discovered.spritesDoc && /## 0金币小精灵/.test(text)) discovered.spritesDoc = file;
      if (!discovered.equipmentDoc && /## 基础装备/.test(text) && /合成路径/.test(text)) discovered.equipmentDoc = file;
    }
  }
  return discovered;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const explicit = parseArgs(process.argv.slice(2));
  const defaults = await discoverVendoredDocs(repoRoot);
  const options = { ...defaults, ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value)) };
  for (const key of ['championsDoc', 'augmentsDoc', 'spritesDoc', 'equipmentDoc']) {
    if (!options[key]) fail(`Missing ${key}; pass all four --*-doc paths or vendor recognizable source docs under an S18 source directory`);
  }
  if (options.outDir) {
    const result = await stageS18HardData(options);
    process.stdout.write(`${JSON.stringify({ ok: true, out_dir: result.outDir, package_id: PACKAGE_ID, generation_id: result.hardDataGenerationId, counts: result.hardDataManifest.counts, promoted: false })}\n`);
    return;
  }
  const managedRoot = path.join(repoRoot, 'data', 'core-patches', 'jcc');
  await mkdir(managedRoot, { recursive: true });
  const stagingDir = await mkdtemp(path.join(managedRoot, '.staging-s18-'));
  try {
    const result = await stageS18HardData({ ...options, outDir: stagingDir });
    const publication = await publishAndPointPatchHardDataCandidate({
      repoRoot,
      stagingDir,
      generationId: result.hardDataGenerationId,
      patchManifestFile: options.patchSourceManifestFile || PATCH_SOURCE_MANIFEST_FILE,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, out_dir: publication.generation_dir, package_id: PACKAGE_ID, generation_id: publication.generation_id, counts: result.hardDataManifest.counts, promoted: false })}\n`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
