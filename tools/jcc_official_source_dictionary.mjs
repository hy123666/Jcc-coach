import { createHash } from 'node:crypto';

const DEFAULT_ASSET_ROOT = 'https://game.gtimg.cn/images/lol/act/jkzlk/js/';
const SOURCE_KINDS = Object.freeze(['trait', 'chess']);

function fail(message) {
  throw new Error(message);
}

function textValue(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function firstValue(...values) {
  return values.map(textValue).find((value) => value !== null) ?? null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
  );
}

function contentHash(value) {
  return sha256(JSON.stringify(stableObject(value)));
}

function normalizedSeason(value) {
  return textValue(value)?.replace(/^s/iu, '').toUpperCase() ?? null;
}

function numericAwareCompare(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (/^\d+$/u.test(leftText) && /^\d+$/u.test(rightText)) {
    const difference = BigInt(leftText) - BigInt(rightText);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return leftText.localeCompare(rightText, 'en');
}

function orderedDictionary(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => numericAwareCompare(left, right)));
}

function requiredIdentity(upstreamIdentity) {
  const mode = firstValue(upstreamIdentity?.mode, upstreamIdentity?.setId, upstreamIdentity?.set_id);
  const version = firstValue(upstreamIdentity?.version, upstreamIdentity?.data_version);
  const season = firstValue(upstreamIdentity?.season, upstreamIdentity?.season_id);
  if (!mode || !version || !season) {
    fail('upstream_identity requires mode, version, and season');
  }
  return { mode, version, season };
}

function sourceRows(document, label) {
  const data = document?.data ?? document?.rows ?? document;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return Object.values(data);
  fail(`${label} data must be an object or array`);
}

function sourceEntries(document, label) {
  const data = document?.data ?? document?.rows ?? document;
  if (Array.isArray(data)) return data.map((row) => [null, row]);
  if (data && typeof data === 'object') return Object.entries(data);
  fail(`${label} data must be an object or array`);
}

function parseDocumentText(sourceText, label) {
  const trimmed = String(sourceText ?? '').replace(/^\uFEFF/u, '').trim();
  if (!trimmed) fail(`${label} is empty`);
  const candidates = [trimmed.replace(/;\s*$/u, '')];
  const assignment = trimmed.match(/^[\w.$\[\]'"-]+\s*=\s*([\s\S]*?);?\s*$/u);
  if (assignment) candidates.push(assignment[1]);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next non-executable wrapper form.
    }
  }
  fail(`${label} is not a JSON document`);
}

function assertOptionalDocumentIdentity(document, upstreamIdentity, label) {
  const expected = requiredIdentity(upstreamIdentity);
  const actualVersion = firstValue(document?.version, document?.data_version);
  const actualSeason = firstValue(document?.season, document?.season_id);
  const actualMode = firstValue(document?.setId, document?.setid, document?.set_id, document?.mode);
  if (actualVersion && actualVersion !== expected.version) {
    fail(`${label} version mismatch: expected ${expected.version}, received ${actualVersion}`);
  }
  if (actualSeason && normalizedSeason(actualSeason) !== normalizedSeason(expected.season)) {
    fail(`${label} season mismatch: expected ${expected.season}, received ${actualSeason}`);
  }
  if (actualMode && actualMode !== expected.mode) {
    fail(`${label} setId mismatch: expected ${expected.mode}, received ${actualMode}`);
  }
}

function traitSourceId(row, sourceKey) {
  return firstValue(row?.id, row?.source_id, row?.sourceId, row?.$origin_contact_id, sourceKey);
}

function traitBreakpoint(row) {
  const value = firstValue(row?.num, row?.breakpoint, row?.minUnits, row?.min_units, row?.count);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function directChessCheckId(row) {
  return firstValue(
    row?.checkId,
    row?.check_id,
    row?.core_check_id,
    row?.coreCheckId,
    row?.core?.check_id,
    row?.core?.checkId,
    row?.identity?.check_id,
    row?.identity?.checkId,
    row?.chessId,
    row?.chess_id,
    row?.$key_id,
  );
}

function chessSourceId(row, sourceKey) {
  return firstValue(row?.id, row?.source_id, row?.sourceId, row?.heroId, row?.hero_id, row?.tftHeroId, sourceKey);
}

function derivedChessCheckId(row, sourceId) {
  const direct = directChessCheckId(row);
  if (direct) return direct;
  const originId = firstValue(row?.originHeroId, row?.origin_hero_id, row?.tftHeroId, sourceId);
  if (/^[1-4]\d{4,}$/u.test(originId ?? '')) return originId.slice(1);
  return originId;
}

function derivedStar(row, sourceId, checkId) {
  const explicit = firstValue(row?.star, row?.starLevel, row?.star_level, row?.level);
  if (explicit && /^\d+$/u.test(explicit)) return Number(explicit);
  if (sourceId && checkId && sourceId.endsWith(checkId)) {
    const prefix = sourceId.slice(0, -checkId.length);
    if (/^[1-4]$/u.test(prefix)) return Number(prefix);
  }
  return null;
}

function sourceTraitIds(row) {
  return [...new Set([
    row?.species,
    row?.job,
    row?.race,
    row?.traits,
    row?.traitIds,
    row?.trait_ids,
  ].flatMap((value) => (
    Array.isArray(value) ? value : String(value ?? '').split('|')
  )).map(textValue).filter(Boolean))].sort(numericAwareCompare);
}

function chessIdentity(row, sourceId, checkId) {
  const identity = {
    check_id: checkId,
    map_id: firstValue(row?.mapID, row?.mapId, row?.map_id, row?.core?.identity?.map_id, row?.identity?.map_id),
    resource_key: firstValue(
      row?.heroPaint,
      row?.hero_paint,
      row?.resourceKey,
      row?.resource_key,
      row?.core?.identity?.resource_key,
      row?.identity?.resource_key,
    ),
    star: derivedStar(row, sourceId, checkId),
  };
  return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== null));
}

function dictionaryResult(kind, bySourceId) {
  return {
    kind,
    count: Object.keys(bySourceId).length,
    by_source_id: bySourceId,
    content_hash: contentHash(bySourceId),
  };
}

export function buildOfficialSourceUrls(upstreamIdentity, { assetRoot = DEFAULT_ASSET_ROOT } = {}) {
  const identity = requiredIdentity(upstreamIdentity);
  const directory = `${identity.mode}/${identity.version}-${identity.season}/`;
  return Object.freeze({
    trait: new URL(`${directory}trait.js`, assetRoot).href,
    chess: new URL(`${directory}chess.js`, assetRoot).href,
  });
}

export function parseOfficialSourceDocument(sourceText, label = 'Official JCC source') {
  return parseDocumentText(sourceText, label);
}

export function validateOfficialSourceDocument(document, upstreamIdentity, label = 'Official JCC source') {
  assertOptionalDocumentIdentity(document, upstreamIdentity, label);
  sourceRows(document, label);
  return document;
}

export function compileOfficialTraitDictionary(document, upstreamIdentity) {
  validateOfficialSourceDocument(document, upstreamIdentity, 'Official JCC trait source');
  const entries = sourceEntries(document, 'Official JCC trait source').map(([sourceKey, row]) => {
    const sourceId = traitSourceId(row, sourceKey);
    const name = firstValue(row?.name, row?.title, row?.cn_name);
    const checkId = firstValue(row?.checkId, row?.check_id, row?.core_check_id, row?.coreCheckId);
    const breakpoint = traitBreakpoint(row);
    if (!sourceId || !name || !checkId || breakpoint === null) {
      fail(`Invalid official trait row: ${JSON.stringify(row)}`);
    }
    return [sourceId, {
      name,
      core: { check_id: checkId },
      breakpoint,
    }];
  });
  if (new Set(entries.map(([sourceId]) => sourceId)).size !== entries.length) {
    fail('Official JCC trait source contains duplicate source ids');
  }
  return dictionaryResult('trait', orderedDictionary(entries));
}

export function resolveOfficialTraitSemantic(dictionary, row) {
  const sourceId = textValue(row?.trait_id);
  const breakpointValue = row?.hero_num ?? row?.chess_num ?? row?.count ?? row?.breakpoint;
  const breakpoint = Number(breakpointValue);
  if (!sourceId || !Number.isFinite(breakpoint)) return null;
  const familyId = sourceId.length >= 6 ? sourceId.slice(0, 6) : sourceId;
  const rows = Object.entries(dictionary?.trait?.by_source_id || {})
    .filter(([key, value]) => (
      (key === sourceId || key.startsWith(familyId))
      && Number(value?.breakpoint) === breakpoint
    ));
  return rows.length === 1 ? { source_id: rows[0][0], ...rows[0][1] } : null;
}

export function compileOfficialChessDictionary(document, upstreamIdentity) {
  validateOfficialSourceDocument(document, upstreamIdentity, 'Official JCC chess source');
  const entries = sourceEntries(document, 'Official JCC chess source').map(([sourceKey, row]) => {
    const sourceId = chessSourceId(row, sourceKey);
    const name = firstValue(row?.name, row?.title, row?.cn_name);
    const checkId = derivedChessCheckId(row, sourceId);
    if (!sourceId || !name || !checkId) fail(`Invalid official chess row: ${JSON.stringify(row)}`);
    return [sourceId, {
      name,
      core: {
        check_id: checkId,
        identity: chessIdentity(row, sourceId, checkId),
        trait_ids: sourceTraitIds(row),
      },
    }];
  });
  if (new Set(entries.map(([sourceId]) => sourceId)).size !== entries.length) {
    fail('Official JCC chess source contains duplicate source ids');
  }
  return dictionaryResult('chess', orderedDictionary(entries));
}

function observedIdsForKind(observedIds, kind) {
  const singular = `${kind}_ids`;
  const camel = `${kind}Ids`;
  const value = observedIds?.[kind] ?? observedIds?.[singular] ?? observedIds?.[camel] ?? [];
  return [...new Set((Array.isArray(value) ? value : [value]).map(textValue).filter(Boolean))]
    .sort(numericAwareCompare);
}

export function projectOfficialSourceObservedIds(dictionary, observedIds = {}) {
  const projection = {};
  for (const kind of SOURCE_KINDS) {
    const bySourceId = dictionary?.[kind]?.by_source_id ?? dictionary?.[`${kind}s`]?.by_source_id ?? {};
    projection[kind] = Object.fromEntries(
      observedIdsForKind(observedIds, kind)
        .filter((sourceId) => Object.hasOwn(bySourceId, sourceId))
        .map((sourceId) => [sourceId, bySourceId[sourceId]]),
    );
  }
  return projection;
}

async function fetchSourceText(fetchImpl, url, kind) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'jcc-runtime-source-adapter/1.0' },
  });
  if (!response || response.ok === false) {
    fail(`Official JCC ${kind} request failed (${response?.status ?? 'unknown'}): ${url}`);
  }
  if (typeof response.text !== 'function') fail(`Official JCC ${kind} response has no text() method`);
  return response.text();
}

export async function buildOfficialSourceDictionary({
  upstream_identity: suppliedIdentity,
  upstreamIdentity,
  fetchImpl = globalThis.fetch,
  assetRoot = DEFAULT_ASSET_ROOT,
} = {}) {
  const identity = requiredIdentity(suppliedIdentity ?? upstreamIdentity);
  if (typeof fetchImpl !== 'function') fail('fetchImpl must be a function');
  const urls = buildOfficialSourceUrls(identity, { assetRoot });
  const [traitText, chessText] = await Promise.all([
    fetchSourceText(fetchImpl, urls.trait, 'trait'),
    fetchSourceText(fetchImpl, urls.chess, 'chess'),
  ]);
  const traitDocument = parseDocumentText(traitText, 'Official JCC trait source');
  const chessDocument = parseDocumentText(chessText, 'Official JCC chess source');
  const trait = compileOfficialTraitDictionary(traitDocument, identity);
  const chess = compileOfficialChessDictionary(chessDocument, identity);
  const compiled = { trait: trait.by_source_id, chess: chess.by_source_id };
  return {
    schema: 'jcc-official-source-dictionary-v1',
    upstream_identity: identity,
    urls,
    source_hashes: {
      trait_sha256: sha256(traitText),
      chess_sha256: sha256(chessText),
    },
    trait,
    chess,
    content_hash: contentHash(compiled),
  };
}

export const compileTraitSourceDictionary = compileOfficialTraitDictionary;
export const compileChessSourceDictionary = compileOfficialChessDictionary;
export const compactObservedIdProjection = projectOfficialSourceObservedIds;
