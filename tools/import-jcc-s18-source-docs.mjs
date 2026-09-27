#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseTypedEffectEnvelope,
  parseTypedMetrics,
} from './jcc_typed_effect_parser.mjs';

const SCHEMA_VERSION = 'jcc-s18-source-import-v1';
const OUTPUT_FILES = Object.freeze({
  champions: 'champions.json',
  traits: 'traits.json',
  augments: 'augments.json',
  equipment: 'equipment.json',
  sprites: 'sprites.json',
});

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf('=');
    if (equals !== -1) {
      values.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`Missing value for ${token}`);
    values.set(token.slice(2), next);
    index += 1;
  }

  const pick = (...names) => names.map((name) => values.get(name)).find(Boolean);
  const options = {
    championsDoc: pick('champions-doc', 'heroes-doc', 'champions'),
    augmentsDoc: pick('augments-doc', 'augments'),
    spritesDoc: pick('sprites-doc', 'sprites'),
    equipmentDoc: pick('equipment-doc', 'equipment'),
    outDir: pick('out-dir'),
    seasonId: pick('season-id', 'local-season-id'),
    patchId: pick('patch-id', 'local-patch-id'),
    modeId: pick('mode-id', 'local-mode-id'),
    upstreamSeasonId: pick('upstream-season-id', 'upstream-season'),
    upstreamVersion: pick('upstream-version', 'upstream-data-version'),
    expectedCounts: pick('expected-counts') ? JSON.parse(pick('expected-counts')) : null,
    patchSourceManifest: pick('patch-source-manifest'),
  };

  for (const [name, value] of Object.entries(options).filter(([name]) => (
    ['championsDoc', 'augmentsDoc', 'spritesDoc', 'equipmentDoc', 'outDir'].includes(name)
  ))) {
    if (!value) fail(`Missing required argument for ${name}`);
  }
  return options;
}

function normalizeNewlines(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';
  let escaped = false;
  for (const character of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
      current += character;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isDividerRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith('|')) continue;
    const headers = splitMarkdownRow(lines[index]);
    const divider = splitMarkdownRow(lines[index + 1]);
    if (!isDividerRow(divider) || headers.length !== divider.length) continue;
    const rows = [];
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith('|')) {
      const cells = splitMarkdownRow(lines[index]);
      if (cells.length === headers.length) rows.push(cells);
      index += 1;
    }
    tables.push({ headers, rows });
    index -= 1;
  }
  return tables;
}

function cleanValue(value) {
  const trimmed = String(value ?? '').trim().replace(/\\\|/g, '|');
  const link = trimmed.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  if (link) return link[1];
  const unquoted = trimmed.replace(/^`([^`]*)`$/, '$1');
  return unquoted === '-' ? null : unquoted;
}

function tableToObject(table) {
  return Object.fromEntries(table.rows.map(([key, value]) => [cleanValue(key), cleanValue(value)]));
}

function parseInteger(value, label) {
  const match = String(value ?? '').match(/-?\d+/);
  if (!match) fail(`Expected integer for ${label}, received ${JSON.stringify(value)}`);
  return Number.parseInt(match[0], 10);
}

function parseNumberList(value, label) {
  const numbers = String(value ?? '').match(/-?\d+/g)?.map(Number) ?? [];
  if (numbers.length === 0) fail(`Expected number list for ${label}`);
  return numbers;
}

function parseNameList(value) {
  if (!value) return [];
  return String(value).split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}

function imageUrl(text) {
  return text.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? null;
}

function subsectionText(section, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^#### ${escaped}\\s*$([\\s\\S]*?)(?=^#### |^---\\s*$|(?![\\s\\S]))`, 'm'));
  return match?.[1].trim() ?? '';
}

function sectionRecords(text, startPattern, recordPattern) {
  const start = text.search(startPattern);
  const scoped = start === -1 ? text : text.slice(start);
  const matches = [...scoped.matchAll(recordPattern)];
  return matches.map((match, index) => {
    const begin = match.index;
    const end = matches[index + 1]?.index ?? scoped.length;
    return {
      ordinal: Number.parseInt(match[1], 10),
      headingName: match[2].trim(),
      sourceText: scoped.slice(begin, end).replace(/\n+---\s*$/s, '').trim(),
    };
  });
}

function metricTerms(sourceText) {
  return parseTypedMetrics(sourceText);
}

function effectEnvelope(sourceText, exactEffectBlocks = []) {
  return parseTypedEffectEnvelope(sourceText, { exactEffectBlocks });
}

function sourceRef(document, section, ordinal) {
  return {
    document: document.basename,
    document_sha256: document.sha256,
    section,
    ordinal,
  };
}

function parseTraits(document) {
  const matches = [...document.text.matchAll(/^### (特质|职业)：(.+)$/gm)];
  return matches.map((match, index) => {
    const sourceText = document.text.slice(match.index, matches[index + 1]?.index ?? document.text.search(/^## 英雄详情$/m)).trim();
    const fields = Object.fromEntries([...sourceText.matchAll(/^- ([^：]+)：(.+)$/gm)].map((row) => [row[1], cleanValue(row[2])]));
    const tierTable = parseTables(sourceText).find((table) => table.headers[0] === '激活数量');
    if (!tierTable) fail(`Missing activation table for ${match[2]}`);
    const tiers = tierTable.rows.map(([count, level, color, effect]) => ({
      count: parseInteger(count, `${match[2]} activation count`),
      level: parseInteger(level, `${match[2]} tier level`),
      color: cleanValue(color) === null ? null : parseInteger(color, `${match[2]} tier color`),
      effect_text: cleanValue(effect),
    }));
    const officialId = String(fields['官方 ID'] ?? fail(`Missing official trait ID for ${match[2]}`));
    return {
      identity: `trait:${officialId}`,
      official_id: officialId,
      name: match[2].trim(),
      kind: match[1] === '特质' ? 'trait' : 'class',
      description: fields['基础说明'],
      icon_url: imageUrl(sourceText),
      tiers,
      effects: effectEnvelope(fields['基础说明'] ?? '', tiers.map((tier) => ({
        scope: `activation:${tier.count}`,
        source_text: tier.effect_text,
      }))),
      upstream_fields: fields,
      provenance: sourceRef(document, match[0], index + 1),
      source_text: sourceText,
    };
  });
}

function parseChampions(document) {
  return sectionRecords(document.text, /^## 英雄详情$/m, /^### (\d+)\. (.+)$/gm).map((record) => {
    const tables = parseTables(record.sourceText);
    const basic = tableToObject(tables.find((table) => table.headers[0] === '项目') ?? fail(`Missing basic table for ${record.headingName}`));
    const attributesTable = tables.find((table) => table.headers[0] === '属性');
    const upstream = tableToObject(tables.find((table) => table.headers[0] === '字段') ?? fail(`Missing identity table for ${record.headingName}`));
    const officialId = String(upstream['英雄 ID'] ?? fail(`Missing hero ID for ${record.headingName}`));
    const rawStarIds = parseNumberList(upstream['原始星级 ID'], `${record.headingName} raw star IDs`);
    const mapIds = parseNumberList(upstream.MapIds, `${record.headingName} MapIds`);
    if (rawStarIds.length !== mapIds.length) fail(`Star ID/MapId length mismatch for ${record.headingName}`);
    const resourceKey = String(upstream['资源标识'] ?? fail(`Missing resource key for ${record.headingName}`));
    const skillName = record.sourceText.match(/^##### (.+)$/m)?.[1]?.trim() ?? null;
    const skillType = record.sourceText.match(/^- 类型：(.+)$/m)?.[1]?.trim() ?? null;
    const skillBody = subsectionText(record.sourceText, '技能')
      .replace(/^##### .*$/m, '')
      .replace(/^- 类型：.*$/m, '')
      .split(/^\*\*技能数值\*\*$/m)[0]
      .trim();
    const skillValuesBlock = subsectionText(record.sourceText, '技能').split(/^\*\*技能数值\*\*$/m)[1] ?? '';
    const skillValues = [...skillValuesBlock.matchAll(/^- ([^：:]+)[：:]\s*(.+)$/gm)].map((match) => ({
      label: match[1].trim(),
      source_text: match[2].trim(),
    }));
    const attributes = {};
    if (attributesTable) {
      for (const row of attributesTable.rows) {
        attributes[cleanValue(row[0])] = row.slice(1).map((value) => Number(cleanValue(value)));
      }
    }
    return {
      identity: `champion:${officialId}`,
      official_id: officialId,
      mumu_base_id: String(Number(officialId) + 10000),
      raw_star_ids: rawStarIds.map(String),
      map_ids: mapIds.map(String),
      star_identity: rawStarIds.map((rawStarId, index) => ({
        star: index + 1,
        raw_star_id: String(rawStarId),
        map_id: String(mapIds[index]),
      })),
      resource_key: resourceKey,
      name: String(basic['名称'] ?? record.headingName),
      cost: parseInteger(basic['费用'], `${record.headingName} cost`),
      traits: parseNameList(basic['特质']),
      classes: parseNameList(basic['职业']),
      skill: {
        name: skillName,
        type: skillType,
        effects: effectEnvelope(skillBody, skillValues.map((value) => ({ scope: value.label, source_text: value.source_text }))),
        raw_values: upstream['官网原始技能值'],
        descriptions_by_star: Object.fromEntries(rawStarIds.map((_, index) => [
          String(index + 1),
          upstream[`${index + 1}星技能描述`] || (index === 0 ? skillBody : null),
        ])),
        values_by_star: Object.fromEntries(rawStarIds.map((_, index) => [
          String(index + 1),
          upstream[`${index + 1}星技能数值说明`] || null,
        ])),
      },
      attributes_by_star: attributes,
      assets: {
        portrait_url: upstream['英雄头像'],
        small_portrait_url: upstream['小头像'],
        skill_icon_url: upstream['技能图标'],
      },
      upstream_fields: upstream,
      provenance: sourceRef(document, `英雄详情/${record.headingName}`, record.ordinal),
      source_text: record.sourceText,
    };
  });
}

function parseAugments(document) {
  return sectionRecords(document.text, /^## 一级强化符文/m, /^### (\d+)\. (.+)$/gm).map((record) => {
    const table = parseTables(record.sourceText).find((candidate) => candidate.headers[0] === '字段');
    if (!table) fail(`Missing augment identity table for ${record.headingName}`);
    const upstream = tableToObject(table);
    const officialId = String(upstream['官方 ID'] ?? fail(`Missing augment ID for ${record.headingName}`));
    const effectText = subsectionText(record.sourceText, '强化效果');
    return {
      identity: `augment:${officialId}`,
      official_id: officialId,
      name: String(upstream['名称'] ?? record.headingName),
      tier: parseInteger(upstream['强化等级'], `${record.headingName} tier`),
      effects: effectEnvelope(effectText),
      icon_url: upstream['官方图标'],
      small_icon_url: upstream['官方小图标'],
      upstream_fields: upstream,
      provenance: sourceRef(document, `强化/${record.headingName}`, record.ordinal),
      source_text: record.sourceText,
    };
  });
}

function parseRecipe(section) {
  const componentOne = section.match(/^- 组件一：(.+?)（官方ID：`([^`]+)`）$/m);
  const componentTwo = section.match(/^- 组件二：(.+?)（官方ID：`([^`]+)`）$/m);
  const formula = section.match(/^- 合成公式：(.+)$/m)?.[1]?.trim() ?? null;
  if (!componentOne && !componentTwo && !formula) return null;
  if (!componentOne || !componentTwo || !formula) fail('Incomplete equipment recipe');
  return {
    component_ids: [componentOne[2], componentTwo[2]],
    component_names: [componentOne[1], componentTwo[1]],
    formula_source_text: formula,
  };
}

function parseEquipment(document) {
  return sectionRecords(document.text, /^## 基础装备/m, /^### (\d+)\. (.+)$/gm).map((record) => {
    const table = parseTables(record.sourceText).find((candidate) => candidate.headers[0] === '字段');
    if (!table) fail(`Missing equipment identity table for ${record.headingName}`);
    const upstream = tableToObject(table);
    const officialId = String(upstream['官方 ID'] ?? fail(`Missing equipment ID for ${record.headingName}`));
    const statsText = subsectionText(record.sourceText, '基础属性');
    const effectText = subsectionText(record.sourceText, '装备效果');
    const recipe = parseRecipe(subsectionText(record.sourceText, '合成路径'));
    return {
      identity: `equipment:${officialId}`,
      official_id: officialId,
      name: String(upstream['名称'] ?? record.headingName),
      category: upstream['分类'],
      map_id: upstream['Map ID'],
      icon_key: upstream['图标标识'],
      stats_source_text: statsText,
      structured_stats: metricTerms(statsText),
      recipe,
      effects: effectEnvelope(effectText),
      icon_url: upstream['官方图标'],
      small_icon_url: upstream['官方小图标'],
      upstream_fields: upstream,
      provenance: sourceRef(document, `装备/${record.headingName}`, record.ordinal),
      source_text: record.sourceText,
    };
  });
}

function parseSprites(document) {
  return sectionRecords(document.text, /^## 0金币小精灵/m, /^### (\d+)\. (.+)$/gm).map((record) => {
    const table = parseTables(record.sourceText).find((candidate) => candidate.headers[0] === '字段');
    if (!table) fail(`Missing sprite identity table for ${record.headingName}`);
    const upstream = tableToObject(table);
    const officialId = String(upstream['官方 ID'] ?? fail(`Missing sprite ID for ${record.headingName}`));
    const effectText = subsectionText(record.sourceText, '效果');
    return {
      identity: `sprite:${officialId}`,
      official_id: officialId,
      sprite_id: String(upstream['小精灵 ID'] ?? officialId),
      name: String(upstream['名称'] ?? record.headingName),
      title: upstream['标题'],
      cost: parseInteger(upstream['费用'], `${record.headingName} cost`),
      effects: effectEnvelope(effectText),
      assets: { logo_url: upstream.Logo, icon_url: upstream.Icon },
      upstream_fields: upstream,
      provenance: sourceRef(document, `小精灵/${record.headingName}`, record.ordinal),
      source_text: record.sourceText,
    };
  });
}

async function loadDocument(filePath, kind) {
  const text = normalizeNewlines(await readFile(filePath, 'utf8'));
  return { kind, basename: path.basename(filePath), sha256: sha256(text), text };
}

function assertCatalog(items, kind, expectedCounts) {
  const expectedCount = expectedCounts?.[kind];
  if (!Number.isInteger(expectedCount)) fail(`Missing expected catalog count for ${kind}`);
  if (items.length !== expectedCount) {
    fail(`${kind} count mismatch: expected ${expectedCount}, received ${items.length}`);
  }
  const identities = new Set(items.map((item) => item.identity));
  if (identities.size !== items.length) fail(`${kind} contains duplicate identities`);
}

function catalogDocument(kind, items, identity, upstreamProvenance, source) {
  return {
    schema: SCHEMA_VERSION,
    catalog_kind: kind,
    identity,
    upstream_provenance: {
      season_id: upstreamProvenance.season_id,
      data_version: upstreamProvenance.data_version,
      source_document: source.basename,
      source_sha256: source.sha256,
    },
    count: items.length,
    items,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function importS18SourceDocs(options) {
  const [championsDoc, augmentsDoc, spritesDoc, equipmentDoc] = await Promise.all([
    loadDocument(options.championsDoc, 'champions_traits'),
    loadDocument(options.augmentsDoc, 'augments'),
    loadDocument(options.spritesDoc, 'sprites'),
    loadDocument(options.equipmentDoc, 'equipment'),
  ]);
  const identity = {
    season_id: options.seasonId,
    patch_id: options.patchId,
    mode_id: options.modeId,
  };
  const upstreamProvenance = {
    season_id: options.upstreamSeasonId,
    data_version: options.upstreamVersion,
  };
  const parsed = {
    champions: parseChampions(championsDoc),
    traits: parseTraits(championsDoc),
    augments: parseAugments(augmentsDoc),
    equipment: parseEquipment(equipmentDoc),
    sprites: parseSprites(spritesDoc),
  };
  for (const [kind, items] of Object.entries(parsed)) assertCatalog(items, kind, options.expectedCounts);

  const documents = { champions: championsDoc, traits: championsDoc, augments: augmentsDoc, equipment: equipmentDoc, sprites: spritesDoc };
  const catalogs = Object.fromEntries(Object.entries(parsed).map(([kind, items]) => [
    kind,
    catalogDocument(kind, items, identity, upstreamProvenance, documents[kind]),
  ]));
  const manifest = {
    schema: SCHEMA_VERSION,
    identity,
    upstream_provenance: upstreamProvenance,
    deterministic: true,
    catalogs: Object.fromEntries(Object.entries(catalogs).map(([kind, catalog]) => [kind, {
      file: OUTPUT_FILES[kind],
      count: catalog.count,
      source_document: catalog.upstream_provenance.source_document,
      source_sha256: catalog.upstream_provenance.source_sha256,
    }])),
  };

  await mkdir(options.outDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(options.outDir, 'manifest.json'), manifest),
    ...Object.entries(catalogs).map(([kind, catalog]) => writeJson(path.join(options.outDir, OUTPUT_FILES[kind]), catalog)),
  ]);
  return { manifest, catalogs };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.patchSourceManifest) {
    const manifest = JSON.parse(await readFile(options.patchSourceManifest, 'utf8'));
    options.seasonId = manifest.season_id;
    options.patchId = manifest.patch_id;
    options.modeId = `mode${manifest.upstream_source.mode}`;
    options.upstreamSeasonId = manifest.upstream_source.season_id;
    options.upstreamVersion = manifest.upstream_source.data_version;
    options.expectedCounts = manifest.upstream_source.catalog_counts;
  }
  for (const key of ['seasonId', 'patchId', 'modeId', 'upstreamSeasonId', 'upstreamVersion', 'expectedCounts']) {
    if (!options[key]) fail(`Missing required version identity for ${key}`);
  }
  const result = await importS18SourceDocs(options);
  process.stdout.write(`${JSON.stringify({
    out_dir: path.resolve(options.outDir),
    counts: Object.fromEntries(Object.entries(result.catalogs).map(([kind, catalog]) => [kind, catalog.count])),
  })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
