#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchText } from './sync-jcc-official-augment-source.mjs';

const VERSION_INDEX_URL = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/config/versiondataconfig.js';
const ASSET_ROOT = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/';

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function parseJson(text, label) {
  try { return JSON.parse(text.replace(/^\uFEFF/, '').trim()); }
  catch (error) { fail(`${label} is not JSON: ${error.message}`); }
}
function md(value) {
  return String(value ?? '-').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-';
}
function numericSort(left, right) { return Number(left.id || left.adventureId) - Number(right.id || right.adventureId); }
function section(title, rows) { return [`## ${title}`, '', ...rows].join('\n'); }
function table(rows) { return rows.map((row) => `| ${row.map(md).join(' | ')} |`).join('\n'); }

function traitDocument(payloads, selected) {
  const groups = [
    ['特质', Object.values(payloads.race.data || {}).sort(numericSort)],
    ['职业', Object.values(payloads.job.data || {}).sort(numericSort)],
  ];
  const records = groups.flatMap(([kind, rows]) => rows.map((row) => {
    const counts = String(row.numList || '').split('|');
    const colors = String(row.color || '').split('|');
    const effects = String(row.desc2 || '').split('|');
    return [
      `### ${kind}：${md(row.name)}`,
      '',
      row.picture ? `![${md(row.name)}](${row.picture})` : '',
      '',
      `- 官方 ID：\`${row.id}\``,
      `- 类型：${kind}`,
      `- 基础说明：${md(row.prefix)}`,
      '',
      '| 激活数量 | 阶段序号 | 颜色代码 | 效果 |',
      '| ---: | ---: | ---: | --- |',
      ...counts.map((count, index) => {
        const effect = String(effects[index] || '').replace(/^\s*\(\d+\)\s*/, '');
        return `| ${count} | ${index + 1} | ${colors[index] || '-'} | ${md(effect)} |`;
      }),
      '',
    ].join('\n');
  }));
  return [
    '# 金铲铲之战：自然之力英雄资料',
    '',
    `> 腾讯官方 Mode 18 / ${selected.season} / ${selected.version} 结构化数据的确定性镜像。`,
    '',
    ...records,
  ].join('\n');
}

function championDocument(payloads, selected) {
  const rows = Object.values(payloads.chess.data || {});
  const visible = rows.filter((row) => /^1\d{4}$/.test(String(row.id)) && Number(row.showHeroTag) === 1).sort(numericSort);
  const byCanonical = new Map();
  for (const row of rows) {
    const id = String(row.id || '');
    if (!/^\d\d{4}$/.test(id)) continue;
    const canonical = id.slice(1);
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical).push(row);
  }
  const records = visible.map((base, ordinal) => {
    const canonical = String(base.id).slice(1);
    const stars = (byCanonical.get(canonical) || [base]).sort((a, b) => Number(a.mapID) - Number(b.mapID));
    const species = String(base.species || '').split('|').filter((id) => id && id !== '0');
    const classes = String(base.class || '').split('|').filter((id) => id && id !== '0');
    const traitById = new Map([
      ...Object.values(payloads.race.data || {}),
      ...Object.values(payloads.job.data || {}),
    ].map((row) => [String(row.id), row.name]));
    const attributes = [
      ['初始法力值', 'initMP'], ['护甲', 'armor'], ['攻击距离', 'attackRange'], ['攻速', 'attackSpeed'],
      ['暴击率', 'criticalStrikeChance'], ['法力值', 'maxMP'], ['物攻', 'initAttackDamage'],
      ['生命', 'initHP'], ['魔抗', 'magicResist'],
    ];
    const skillValues = String(stars.at(-1)?.skillValueDesc || base.skillValueDesc || '')
      .split('|').filter(Boolean).map((value, index) => {
        const separator = value.indexOf(':');
        return separator >= 0
          ? `- ${md(value.slice(0, separator))}：${md(value.slice(separator + 1))}`
          : `- 官方值${index + 1}：${md(value)}`;
      });
    return [
      `### ${ordinal + 1}. ${md(base.name)}`,
      '', '#### 基础信息', '',
      table([['项目', '内容'], ['---', '---'], ['名称', base.name], ['费用', `${base.price}金币`],
        ['特质', species.map((id) => traitById.get(id) || id).join('、') || '-'],
        ['职业', classes.map((id) => traitById.get(id) || id).join('、') || '-']]),
      '', '#### 技能', '', `##### ${md(base.skillName)}`, '', '- 类型：主动', '', md(base.skillDesc), '',
      '**技能数值**', '', ...(skillValues.length ? skillValues : ['- 官方值：-']), '',
      '#### 属性', '',
      `| 属性 | ${stars.map((_, index) => `${index + 1}星`).join(' | ')} |`,
      `| --- | ${stars.map(() => '---:').join(' | ')} |`,
      ...attributes.map(([label, key]) => `| ${label} | ${stars.map((row) => md(row[key])).join(' | ')} |`),
      '', '#### 官方数据标识', '',
      table([['字段', '内容'], ['---', '---'], ['英雄 ID', canonical],
        ['原始星级 ID', stars.map((row) => row.id).join('、')], ['MapIds', stars.map((row) => row.mapID).join('、')],
        ['资源标识', base.heroPaint], ['官网原始技能值', stars.at(-1)?.skillBriefValue || base.skillBriefValue || '-'],
        ...stars.map((row, index) => [`${index + 1}星技能描述`, row.skillDesc || '-']),
        ...stars.map((row, index) => [`${index + 1}星技能数值说明`, row.skillValueDesc || '-']),
        ['英雄头像', base.picture], ['小头像', base.picture], ['技能图标', base.skillIcon]]),
      '',
    ].join('\n');
  });
  return [traitDocument(payloads, selected), '', '## 英雄详情', '', ...records].join('\n');
}

function augmentDocument(payload, selected) {
  const rows = Object.values(payload.data || {}).sort(numericSort);
  const records = rows.map((row, index) => [
    `### ${index + 1}. ${md(row.name)}`, '', '#### 强化效果', '', md(row.desc), '', '#### 官方数据标识', '',
    table([['字段', '内容'], ['---', '---'], ['名称', row.name], ['官方 ID', row.id],
      ['强化等级', row.level], ['官方图标', row.icon || '-'], ['官方小图标', row.icon_small || row.icon || '-']]), '',
  ].join('\n'));
  return ['# 金铲铲之战：自然之力 S18 强化资料', '', `> 腾讯官方 ${selected.version} 强化目录。`, '', section('一级强化符文', records)].join('\n');
}

function equipmentDocument(payload, selected) {
  const rows = Object.values(payload.data || {}).sort(numericSort);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const records = rows.map((row, index) => {
    const first = byId.get(String(row.synthesis1));
    const second = byId.get(String(row.synthesis2));
    const recipe = first && second ? [
      '#### 合成路径', '', `- 组件一：${md(first.name)}（官方ID：\`${first.id}\`）`,
      `- 组件二：${md(second.name)}（官方ID：\`${second.id}\`）`,
      `- 合成公式：${md(first.name)} + ${md(second.name)} = ${md(row.name)}`, '',
    ] : [];
    return [
      `### ${index + 1}. ${md(row.name)}`, '', '#### 基础属性', '', md(row.basicDesc), '',
      '#### 装备效果', '', md(row.desc), '', ...recipe, '#### 官方数据标识', '',
      table([['字段', '内容'], ['---', '---'], ['名称', row.name], ['分类', row.type || '特殊装备'],
        ['官方 ID', row.id], ['Map ID', row.mapID], ['图标标识', row.icon],
        ['官方图标', row.picture], ['官方小图标', row.picture]]), '',
    ].join('\n');
  });
  return ['# 金铲铲之战：自然之力 S18 装备资料', '', `> 腾讯官方 ${selected.version} 装备目录。`, '', section('基础装备', records)].join('\n');
}

function spriteDocument(payload, selected) {
  const rows = Object.values(payload.data || {}).sort(numericSort);
  const records = rows.map((row, index) => [
    `### ${index + 1}. ${md(row.title)}`, '', '#### 效果', '', md(row.desc), '', '#### 官方数据标识', '',
    table([['字段', '内容'], ['---', '---'], ['名称', row.title], ['标题', row.title],
      ['官方 ID', row.adventureId], ['小精灵 ID', row.adventureId], ['费用', row.price],
      ['Logo', row.logo || '-'], ['Icon', row.logo || '-']]), '',
  ].join('\n'));
  return ['# 金铲铲之战：自然之力 S18 特殊机制 - 小精灵', '', `> 腾讯官方 ${selected.version} 自然仙灵目录。`, '', section('0金币小精灵', records)].join('\n');
}

function officialAugmentSnapshot(payload, selected, source, localSeason, patch) {
  const augments = Object.values(payload.data || {}).sort(numericSort).map((row) => ({
    id: String(row.id), name: String(row.name), tier: Number(row.level), description: String(row.desc || '').trim(),
    icon_url: String(row.icon || '').trim() || null, icon_small_url: String(row.icon_small || row.icon || '').trim() || null,
    is_legend: Number(row.is_legend || 0), hero_enhancement_type: String(row.hero_enhancement_type || '0'),
    trait_id: String(row.fetterId || '').trim() || null, trait_type: String(row.fetterType || '0'),
  }));
  return {
    schema: 'jcc-official-augment-snapshot-v1', target: { season_id: localSeason, patch_id: patch, mode_id: 'mode18' },
    upstream_identity: { mode: '18', season: selected.season, version: selected.version, source_label: selected.name },
    source: { provider_id: 'jcc_official', page_url: 'https://jcc.qq.com/#/hex', version_index_url: VERSION_INDEX_URL,
      version_index_sha256: source.index_sha256, augment_url: source.urls.hex, augment_payload_sha256: source.hashes.hex,
      trust_role: 'primary_augment_entity_authority' },
    counts: { rows: augments.length, unique_names: new Set(augments.map((row) => row.name)).size,
      by_tier: Object.fromEntries([1, 2, 3].map((tier) => [String(tier), augments.filter((row) => row.tier === tier).length])) },
    augments,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index].replace(/^--/, '')] = argv[index + 1];
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(options['output-dir'] || fail('--output-dir is required'));
  const version = options.version || fail('--version is required');
  const localSeason = options['local-season'] || 's18';
  const patch = options.patch || fail('--patch is required');
  const indexText = await fetchText(VERSION_INDEX_URL);
  const selected = parseJson(indexText, 'version index').find((row) => String(row.mode) === '18' && String(row.version) === version);
  if (!selected) fail(`Official Mode 18 version ${version} is absent`);
  const roles = { chess: 'herourl', race: 'raceurl', job: 'joburl', equip: 'equipurl', hex: 'hexurl', adventure: 'adventureurl' };
  const payloads = {};
  const source = { index_sha256: sha256(indexText), urls: {}, hashes: {} };
  await Promise.all(Object.entries(roles).map(async ([role, field]) => {
    const url = new URL(String(selected[field]).replace(/^\/+/, ''), ASSET_ROOT).href;
    const text = await fetchText(url);
    const payload = parseJson(text, role);
    if (String(payload.version) !== version || String(payload.setId) !== '18') fail(`${role} identity mismatch`);
    payloads[role] = payload; source.urls[role] = url; source.hashes[role] = sha256(text);
  }));
  const documents = {
    'champions-and-traits.md': championDocument(payloads, selected),
    'augments.md': augmentDocument(payloads.hex, selected),
    'equipment.md': equipmentDocument(payloads.equip, selected),
    'nature-sprites.md': spriteDocument(payloads.adventure, selected),
    'official-s18-augments.json': `${JSON.stringify(officialAugmentSnapshot(payloads.hex, selected, source, localSeason, patch), null, 2)}\n`,
    'official-source-receipt.json': `${JSON.stringify({ schema: 'jcc-official-hard-data-source-receipt-v1', target: { season_id: localSeason, patch_id: patch },
      upstream_identity: { mode: '18', season: selected.season, version: selected.version, released_at: selected.version_start_time }, source }, null, 2)}\n`,
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all(Object.entries(documents).map(([name, value]) => writeFile(path.join(outputDir, name), value, 'utf8')));
  process.stdout.write(`${JSON.stringify({ ok: true, output_dir: outputDir, version, counts: {
    champions: 65, traits: Object.keys(payloads.race.data).length + Object.keys(payloads.job.data).length,
    augments: Object.keys(payloads.hex.data).length, equipment: Object.keys(payloads.equip.data).length,
    sprites: Object.keys(payloads.adventure.data).length } })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}
