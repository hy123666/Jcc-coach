import { createHash } from "node:crypto";

export const RANKING_QUERY_CURSOR_SCHEMA = "jcc-ranking-query-cursor-v1";
export const RANKING_QUERY_CURSOR_MAX_BYTES = 64 * 1024;

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 48;
const MAX_ID_LENGTH = 160;
const MAX_REASON_LENGTH = 240;
const MAX_REASONS_PER_CANDIDATE = 32;
const MAX_RECEIPTS = 16;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requiredText(value, label, maxLength = MAX_ID_LENGTH) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) throw new TypeError(`${label} is required`);
  if (text.length > maxLength) throw new RangeError(`${label} exceeds ${maxLength} characters`);
  return text;
}

function normalizeReasons(value, candidateId) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  if (values.length > MAX_REASONS_PER_CANDIDATE) {
    throw new RangeError(`candidate ${candidateId} exceeds ${MAX_REASONS_PER_CANDIDATE} match reasons`);
  }
  const reasons = [];
  const seen = new Set();
  for (const reason of values) {
    const text = typeof reason === "string" ? reason.normalize("NFKC").trim() : stableJson(reason);
    if (!text) continue;
    if (text.length > MAX_REASON_LENGTH) {
      throw new RangeError(`candidate ${candidateId} match reason exceeds ${MAX_REASON_LENGTH} characters`);
    }
    if (seen.has(text)) continue;
    seen.add(text);
    reasons.push(text);
  }
  return reasons;
}

function compactCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const ids = new Set();
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError(`candidate at index ${index} must be an object`);
    }
    const id = requiredText(candidate.id ?? candidate.candidate_id, `candidate id at index ${index}`);
    if (ids.has(id)) throw new Error(`duplicate candidate id: ${id}`);
    ids.add(id);
    const score = Number(candidate.score ?? candidate.stage_weighted_score ?? candidate.ranking_score);
    if (!Number.isFinite(score)) throw new TypeError(`candidate ${id} score must be finite`);
    return {
      id,
      score,
      match_reasons: normalizeReasons(
        candidate.match_reasons ?? candidate.matchReasons ?? candidate.matched_terms ?? [],
        id,
      ),
    };
  });
}

function compactShownIds(shownIds, candidateIds) {
  if (!Array.isArray(shownIds)) throw new TypeError("shownIds must be an array");
  const shown = [];
  const seen = new Set();
  for (const value of shownIds) {
    const id = requiredText(value, "shown candidate id");
    if (!candidateIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    shown.push(id);
  }
  return shown;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertBudget(cursor, byteBudget) {
  const bytes = byteLength(cursor);
  if (bytes > byteBudget) {
    throw new RangeError(`ranking query cursor exceeds ${byteBudget} bytes: ${bytes}`);
  }
  return cursor;
}

function normalizeByteBudget(value) {
  const budget = value == null ? RANKING_QUERY_CURSOR_MAX_BYTES : Number(value);
  if (!Number.isInteger(budget) || budget < 1024 || budget > RANKING_QUERY_CURSOR_MAX_BYTES) {
    throw new RangeError(`byteBudget must be an integer from 1024 to ${RANKING_QUERY_CURSOR_MAX_BYTES}`);
  }
  return budget;
}

function cursorIdentity(queryIdentity, masterPlusDataFingerprint) {
  if (queryIdentity == null) throw new TypeError("queryIdentity is required");
  const dataFingerprint = requiredText(masterPlusDataFingerprint, "masterPlusDataFingerprint", 256);
  const queryFingerprint = fingerprint(queryIdentity);
  return {
    query_fingerprint: queryFingerprint,
    master_plus_data_fingerprint: dataFingerprint,
    cursor_id: fingerprint({ query_fingerprint: queryFingerprint, master_plus_data_fingerprint: dataFingerprint }),
  };
}

export function createRankingQueryCursor({
  queryIdentity,
  masterPlusDataFingerprint,
  candidates,
  shownIds = [],
  byteBudget,
} = {}) {
  const budget = normalizeByteBudget(byteBudget);
  const compact = compactCandidates(candidates);
  const identity = cursorIdentity(queryIdentity, masterPlusDataFingerprint);
  const cursor = {
    schema: RANKING_QUERY_CURSOR_SCHEMA,
    ...identity,
    candidates: compact,
    shown_ids: compactShownIds(shownIds, new Set(compact.map((candidate) => candidate.id))),
    receipts: [],
  };
  return assertBudget(cursor, budget);
}

export function ensureRankingQueryCursor(cursor, options = {}) {
  const expected = cursorIdentity(options.queryIdentity, options.masterPlusDataFingerprint);
  if (!cursor || cursor.schema !== RANKING_QUERY_CURSOR_SCHEMA || cursor.cursor_id !== expected.cursor_id) {
    return {
      cursor: createRankingQueryCursor(options),
      replaced: Boolean(cursor),
      reason: cursor ? "query_or_fingerprint_changed" : "cursor_missing",
    };
  }
  const budget = normalizeByteBudget(options.byteBudget);
  assertBudget(cursor, budget);
  return { cursor, replaced: false, reason: null };
}

function pageFromIds(cursor, ids) {
  const byId = new Map(cursor.candidates.map((candidate) => [candidate.id, candidate]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function paginateRankingQueryCursor(cursor, {
  requestId,
  pageSize,
  queryIdentity,
  masterPlusDataFingerprint,
  byteBudget,
  consume = true,
} = {}) {
  const id = requiredText(requestId, "requestId", 256);
  if (!Number.isInteger(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be an integer from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}`);
  }
  const budget = normalizeByteBudget(byteBudget);
  const expected = cursorIdentity(queryIdentity, masterPlusDataFingerprint);
  if (!cursor || cursor.schema !== RANKING_QUERY_CURSOR_SCHEMA || cursor.cursor_id !== expected.cursor_id) {
    return {
      status: "invalidated",
      reason: "query_or_fingerprint_changed",
      cursor: null,
      candidates: [],
      exhausted: false,
      idempotent: false,
    };
  }
  assertBudget(cursor, budget);
  const prior = cursor.receipts.find((receipt) => receipt.request_id === id);
  if (prior) {
    if (prior.page_size !== pageSize) throw new Error(`requestId ${id} was already used with page size ${prior.page_size}`);
    return {
      status: prior.candidate_ids.length ? "page" : "exhausted",
      cursor,
      candidates: pageFromIds(cursor, prior.candidate_ids),
      exhausted: prior.exhausted,
      idempotent: true,
    };
  }

  const shown = new Set(cursor.shown_ids);
  const page = cursor.candidates.filter((candidate) => !shown.has(candidate.id)).slice(0, pageSize);
  const pageIds = page.map((candidate) => candidate.id);
  const nextShownIds = consume ? [...cursor.shown_ids, ...pageIds] : [...cursor.shown_ids];
  const exhausted = cursor.shown_ids.length + pageIds.length >= cursor.candidates.length;
  const receipt = {
    request_id: id,
    page_size: pageSize,
    candidate_ids: pageIds,
    consumed: consume,
    acknowledged_candidate_ids: consume ? pageIds : [],
    exhausted,
  };
  const nextCursor = {
    ...cursor,
    shown_ids: nextShownIds,
    receipts: [...cursor.receipts, receipt].slice(-MAX_RECEIPTS),
  };
  assertBudget(nextCursor, budget);
  return {
    status: page.length ? "page" : "exhausted",
    cursor: nextCursor,
    candidates: page,
    exhausted,
    idempotent: false,
  };
}

export function acknowledgeRankingQueryCursor(cursor, {
  requestId,
  selectedIds = [],
  fallbackCount = 0,
  byteBudget,
} = {}) {
  const id = requiredText(requestId, "requestId", 256);
  const budget = normalizeByteBudget(byteBudget);
  if (!cursor || cursor.schema !== RANKING_QUERY_CURSOR_SCHEMA) throw new TypeError("cursor is invalid");
  const receiptIndex = cursor.receipts.findIndex((receipt) => receipt.request_id === id);
  if (receiptIndex < 0) return { cursor, acknowledged_ids: [], changed: false };
  const receipt = cursor.receipts[receiptIndex];
  const allowed = new Set(receipt.candidate_ids);
  const explicit = uniqueSelectedIds(selectedIds).filter((candidateId) => allowed.has(candidateId));
  const fallback = Number.isInteger(fallbackCount) && fallbackCount > 0
    ? receipt.candidate_ids.slice(0, fallbackCount)
    : [];
  const acknowledged = explicit.length ? explicit : fallback;
  const shown = [...new Set([...cursor.shown_ids, ...acknowledged])];
  const receipts = cursor.receipts.map((entry, index) => index === receiptIndex ? {
    ...entry,
    consumed: true,
    acknowledged_candidate_ids: acknowledged,
    exhausted: shown.length >= cursor.candidates.length,
  } : entry);
  const nextCursor = { ...cursor, shown_ids: shown, receipts };
  assertBudget(nextCursor, budget);
  return {
    cursor: nextCursor,
    acknowledged_ids: acknowledged,
    changed: stableJson(nextCursor) !== stableJson(cursor),
  };
}

function uniqueSelectedIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

export function nextThreeRankingCandidates(cursor, options = {}) {
  return paginateRankingQueryCursor(cursor, { ...options, pageSize: 3 });
}

export function nextFiveRankingCandidates(cursor, options = {}) {
  return paginateRankingQueryCursor(cursor, { ...options, pageSize: 5 });
}

export function rankingQueryCursorBytes(cursor) {
  return byteLength(cursor);
}
