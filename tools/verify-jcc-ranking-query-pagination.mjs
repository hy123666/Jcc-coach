import assert from "node:assert/strict";
import {
  RANKING_QUERY_CURSOR_MAX_BYTES,
  createRankingQueryCursor,
  acknowledgeRankingQueryCursor,
  ensureRankingQueryCursor,
  nextFiveRankingCandidates,
  nextThreeRankingCandidates,
  paginateRankingQueryCursor,
  rankingQueryCursorBytes,
} from "../ui/electron/ranking-query-cursor.js";

const queryIdentity = {
  match_session_id: "match-pagination",
  stage_round: "3-2",
  target_role: "main_carry:nami",
  board_fingerprint: "board-a",
  equipment_fingerprint: "items-a",
};
const masterPlusDataFingerprint = "master-plus-20260818-audit-pass";
const forbiddenPackage = "FULL_STRATEGY_PACKAGE_MUST_NOT_SURVIVE";
const candidates = Array.from({ length: 11 }, (_, index) => ({
  id: `lineup-${index + 1}`,
  stage_weighted_score: 100 - index,
  match_reasons: [`meta:${index + 1}`, index % 2 ? "board" : "augment", `meta:${index + 1}`],
  canonical_variant: { units: [forbiddenPackage.repeat(100)] },
  complete_strategy_package: forbiddenPackage.repeat(100),
}));

const initial = createRankingQueryCursor({
  queryIdentity,
  masterPlusDataFingerprint,
  candidates,
});
assert.equal(initial.candidates.length, candidates.length, "cursor must retain the full lightweight candidate pool");
assert.deepEqual(initial.candidates[0], {
  id: "lineup-1",
  score: 100,
  match_reasons: ["meta:1", "augment"],
});
assert.equal(JSON.stringify(initial).includes(forbiddenPackage), false, "cursor must never retain strategy packages or arbitrary candidate fields");
assert(rankingQueryCursorBytes(initial) <= RANKING_QUERY_CURSOR_MAX_BYTES);

const seededShown = createRankingQueryCursor({
  queryIdentity,
  masterPlusDataFingerprint,
  candidates,
  shownIds: ["lineup-1", "lineup-1", "unknown-lineup"],
});
const seededPage = nextThreeRankingCandidates(seededShown, {
  requestId: "seeded-page",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.deepEqual(seededShown.shown_ids, ["lineup-1"], "shown IDs must be deduplicated and limited to the current pool");
assert.deepEqual(seededPage.candidates.map(({ id }) => id), ["lineup-2", "lineup-3", "lineup-4"], "the first page must exclude caller-supplied shown IDs");

const page1 = nextThreeRankingCandidates(initial, {
  requestId: "page-1",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.deepEqual(page1.candidates.map(({ id }) => id), ["lineup-1", "lineup-2", "lineup-3"]);
assert.deepEqual(page1.cursor.shown_ids, ["lineup-1", "lineup-2", "lineup-3"]);
assert.equal(page1.exhausted, false);

const preview = paginateRankingQueryCursor(initial, {
  requestId: "wide-preview",
  pageSize: 8,
  queryIdentity,
  masterPlusDataFingerprint,
  consume: false,
});
assert.deepEqual(preview.candidates.map(({ id }) => id), candidates.slice(0, 8).map(({ id }) => id),
  "the Agent may inspect a wider internal working set");
assert.deepEqual(preview.cursor.shown_ids, [],
  "an internal working set must not be marked as user-visible before response acknowledgement");
const previewAck = acknowledgeRankingQueryCursor(preview.cursor, {
  requestId: "wide-preview",
  selectedIds: ["lineup-2", "lineup-5", "lineup-7"],
  fallbackCount: 3,
});
assert.deepEqual(previewAck.cursor.shown_ids, ["lineup-2", "lineup-5", "lineup-7"],
  "only exact Host-selected candidates should become user-visible");
const afterPreview = nextThreeRankingCandidates(previewAck.cursor, {
  requestId: "after-wide-preview",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.deepEqual(afterPreview.candidates.map(({ id }) => id), ["lineup-1", "lineup-3", "lineup-4"],
  "a continuation must retain internal candidates that the user never saw");

const page1Replay = nextThreeRankingCandidates(page1.cursor, {
  requestId: "page-1",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.equal(page1Replay.idempotent, true, "same request must replay without advancing shown IDs");
assert.deepEqual(page1Replay.candidates, page1.candidates);
assert.deepEqual(page1Replay.cursor, page1.cursor);
assert.throws(() => nextFiveRankingCandidates(page1.cursor, {
  requestId: "page-1",
  queryIdentity,
  masterPlusDataFingerprint,
}), /already used with page size 3/);

const page2 = nextFiveRankingCandidates(page1.cursor, {
  requestId: "page-2",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.deepEqual(page2.candidates.map(({ id }) => id), ["lineup-4", "lineup-5", "lineup-6", "lineup-7", "lineup-8"]);
assert.equal(new Set(page2.cursor.shown_ids).size, 8, "pages must exclude all shown candidates");

const page3 = nextFiveRankingCandidates(page2.cursor, {
  requestId: "page-3",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.deepEqual(page3.candidates.map(({ id }) => id), ["lineup-9", "lineup-10", "lineup-11"]);
assert.equal(page3.exhausted, true);

const exhausted = nextThreeRankingCandidates(page3.cursor, {
  requestId: "page-4",
  queryIdentity,
  masterPlusDataFingerprint,
});
assert.equal(exhausted.status, "exhausted");
assert.deepEqual(exhausted.candidates, []);
assert.equal(exhausted.exhausted, true);

const changedConditions = ensureRankingQueryCursor(page3.cursor, {
  queryIdentity: { ...queryIdentity, stage_round: "3-5" },
  masterPlusDataFingerprint,
  candidates,
});
assert.equal(changedConditions.replaced, true);
assert.equal(changedConditions.reason, "query_or_fingerprint_changed");
assert.deepEqual(changedConditions.cursor.shown_ids, [], "query condition changes must create a fresh cursor");
assert.notEqual(changedConditions.cursor.cursor_id, page3.cursor.cursor_id);

const changedFingerprint = ensureRankingQueryCursor(page3.cursor, {
  queryIdentity,
  masterPlusDataFingerprint: "master-plus-20260819-new-promotion",
  candidates,
});
assert.equal(changedFingerprint.replaced, true);
assert.deepEqual(changedFingerprint.cursor.shown_ids, [], "Master+ data promotion must invalidate prior pagination");

const invalidatedPage = paginateRankingQueryCursor(page3.cursor, {
  requestId: "stale-page",
  pageSize: 3,
  queryIdentity,
  masterPlusDataFingerprint: "master-plus-20260819-new-promotion",
});
assert.equal(invalidatedPage.status, "invalidated");
assert.equal(invalidatedPage.cursor, null, "a stale cursor must fail closed instead of mixing ranking fingerprints");

const reorderedIdentity = createRankingQueryCursor({
  queryIdentity: {
    equipment_fingerprint: "items-a",
    board_fingerprint: "board-a",
    target_role: "main_carry:nami",
    stage_round: "3-2",
    match_session_id: "match-pagination",
  },
  masterPlusDataFingerprint,
  candidates,
});
assert.equal(reorderedIdentity.cursor_id, initial.cursor_id, "query object key order must not change cursor identity");

assert.throws(() => createRankingQueryCursor({
  queryIdentity,
  masterPlusDataFingerprint,
  candidates: Array.from({ length: 80 }, (_, index) => ({
    id: `oversized-${index}`,
    score: index,
    match_reasons: Array.from({ length: 20 }, (__, reasonIndex) => `reason-${reasonIndex}-${"x".repeat(80)}`),
  })),
  byteBudget: 4096,
}), /exceeds 4096 bytes/, "cursor must fail closed when compact state exceeds its byte budget");

assert.throws(() => createRankingQueryCursor({
  queryIdentity,
  masterPlusDataFingerprint,
  candidates: [{ id: "invalid-score", score: Number.NaN, match_reasons: [] }],
}), /score must be finite/);
assert.throws(() => createRankingQueryCursor({
  masterPlusDataFingerprint,
  candidates,
}), /queryIdentity is required/);

console.log(JSON.stringify({
  ok: true,
  schema: initial.schema,
  candidate_count: initial.candidates.length,
  page_sizes: [page1.candidates.length, page2.candidates.length, page3.candidates.length],
  exhausted: exhausted.exhausted,
  cursor_bytes: rankingQueryCursorBytes(page3.cursor),
  max_cursor_bytes: RANKING_QUERY_CURSOR_MAX_BYTES,
}));
