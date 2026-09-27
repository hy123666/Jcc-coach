#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_VERSION_INDEX_URL = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/config/versiondataconfig.js';
const DEFAULT_ASSET_ROOT = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/';
const DEFAULT_OUTPUT = path.resolve(
  import.meta.dirname,
  '../data/game-knowledge/jcc/seasons/s18/patches/s18_1/source-docs/official-s18-augments.json',
);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableRows(rows) {
  return [...rows].sort((left, right) => {
    const leftId = String(left.id || '');
    const rightId = String(right.id || '');
    if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
      const difference = BigInt(leftId) - BigInt(rightId);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
    }
    return leftId.localeCompare(rightId);
  });
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'jcc-runtime-source-adapter/1.0' },
  });
  if (!response.ok) fail(`Official JCC source request failed (${response.status}): ${url}`);
  return response.text();
}

function parseJsonDocument(text, label) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch (error) {
    fail(`${label} is not a JSON document: ${error.message}`);
  }
}

function selectVersion(rows, mode, upstreamSeason) {
  const candidates = rows.filter((row) => String(row.mode) === mode && String(row.season).toUpperCase() === upstreamSeason.toUpperCase());
  if (!candidates.length) fail(`Official version index has no mode=${mode}, season=${upstreamSeason}`);
  return candidates.find((row) => Number(row.is_newest_version) === 1)
    || candidates.sort((left, right) => String(right.version).localeCompare(String(left.version), undefined, { numeric: true }))[0];
}

function canonicalRow(row) {
  const id = String(row?.id || '').trim();
  const name = String(row?.name || '').trim();
  const tier = Number(row?.level);
  if (!id || !name || ![1, 2, 3].includes(tier)) fail(`Invalid official augment row: ${JSON.stringify(row)}`);
  return {
    id,
    name,
    tier,
    description: String(row.desc || '').trim(),
    icon_url: String(row.icon || '').trim() || null,
    icon_small_url: String(row.icon_small || '').trim() || null,
    is_legend: Number(row.is_legend || 0),
    hero_enhancement_type: String(row.hero_enhancement_type || '0'),
    trait_id: String(row.fetterId || '').trim() || null,
    trait_type: String(row.fetterType || '0'),
  };
}

export async function buildOfficialAugmentSnapshot({
  mode = '18',
  upstreamSeason = 'S19',
  localSeason = 's18',
  patch = 's18_1',
  versionIndexUrl = DEFAULT_VERSION_INDEX_URL,
  assetRoot = DEFAULT_ASSET_ROOT,
} = {}) {
  const versionIndexText = await fetchText(versionIndexUrl);
  const versions = parseJsonDocument(versionIndexText, 'Official JCC version index');
  if (!Array.isArray(versions)) fail('Official JCC version index must be an array');
  const selected = selectVersion(versions, mode, upstreamSeason);
  if (!selected.hexurl) fail('Selected official version has no hexurl');
  const augmentUrl = new URL(String(selected.hexurl).replace(/^\/+/, ''), assetRoot).href;
  const augmentText = await fetchText(augmentUrl);
  const payload = parseJsonDocument(augmentText, 'Official JCC augment payload');
  if (String(payload.setId) !== mode || String(payload.season).toUpperCase() !== upstreamSeason.toUpperCase()) {
    fail(`Official augment identity mismatch: expected ${mode}/${upstreamSeason}, received ${payload.setId}/${payload.season}`);
  }
  if (String(payload.version) !== String(selected.version)) {
    fail(`Official augment version mismatch: index=${selected.version}, payload=${payload.version}`);
  }
  const augments = stableRows(Object.values(payload.data || {}).map(canonicalRow));
  const ids = new Set(augments.map((row) => row.id));
  if (ids.size !== augments.length) fail('Official augment payload contains duplicate ids');
  return {
    schema: 'jcc-official-augment-snapshot-v1',
    target: {
      season_id: localSeason,
      patch_id: patch,
      mode_id: `mode${mode}`,
    },
    upstream_identity: {
      mode,
      season: upstreamSeason,
      version: String(payload.version),
      source_label: String(selected.name || ''),
    },
    source: {
      provider_id: 'jcc_official',
      page_url: 'https://jcc.qq.com/#/hex',
      version_index_url: versionIndexUrl,
      version_index_sha256: sha256(versionIndexText),
      augment_url: augmentUrl,
      augment_payload_sha256: sha256(augmentText),
      trust_role: 'primary_augment_entity_authority',
    },
    counts: {
      rows: augments.length,
      unique_names: new Set(augments.map((row) => row.name)).size,
      by_tier: Object.fromEntries([1, 2, 3].map((tier) => [String(tier), augments.filter((row) => row.tier === tier).length])),
    },
    augments,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`Unexpected positional argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`);
    result[key] = value;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output || DEFAULT_OUTPUT);
  const snapshot = await buildOfficialAugmentSnapshot(options);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, output, counts: snapshot.counts, upstream_identity: snapshot.upstream_identity })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
