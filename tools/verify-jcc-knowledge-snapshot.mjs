import assert from "node:assert/strict";
import {
  createKnowledgeSnapshot,
  knowledgeSnapshotMatches,
} from "../ui/electron/knowledge-snapshot.js";

const input = {
  coreProfileId: "a".repeat(64),
  rankingOverlayId: "ranking-overlay-test",
  seasonId: "s18",
  patchId: "s18_1",
  coreSourceIdentity: {
    hard_data_manifest_fingerprint: "b".repeat(64),
    catalog_source_fingerprint: "c".repeat(64),
  },
  rankingSourceIdentity: {
    season_id: "s18",
    patch_id: "s18_1",
    core_profile_id: "a".repeat(64),
    catalog_fingerprint: "c".repeat(64),
    dependency_closure_status: "closed",
    ranking_overlay_id: "ranking-overlay-test",
  },
  capturedAt: "2026-08-19T00:00:00.000Z",
};
const first = createKnowledgeSnapshot(input);
const second = createKnowledgeSnapshot(input);
assert.equal(first.generation_id, second.generation_id);
assert.equal(knowledgeSnapshotMatches(first, second), true);
const changedRanking = createKnowledgeSnapshot({
  ...input,
  rankingOverlayId: "ranking-overlay-next",
  rankingSourceIdentity: { ...input.rankingSourceIdentity, ranking_overlay_id: "ranking-overlay-next" },
});
assert.notEqual(first.generation_id, changedRanking.generation_id);
assert.equal(knowledgeSnapshotMatches(first, changedRanking), false);
assert.equal(Object.isFrozen(first), true);
await assert.rejects(async () => createKnowledgeSnapshot({ ...input, coreProfileId: null }), /core_profile_id/);
await assert.rejects(async () => createKnowledgeSnapshot({
  ...input,
  rankingSourceIdentity: { ...input.rankingSourceIdentity, season_id: "s19", patch_id: "s19_1" },
}), /incompatible/);
await assert.rejects(async () => createKnowledgeSnapshot({
  ...input,
  rankingSourceIdentity: { ...input.rankingSourceIdentity, core_profile_id: "d".repeat(64) },
}), /Core Profile generation/);
const unavailable = createKnowledgeSnapshot({
  ...input,
  rankingOverlayId: `unavailable:${input.coreProfileId}`,
  rankingSourceIdentity: null,
});
assert.equal(unavailable.ranking_overlay_id, `unavailable:${input.coreProfileId}`);
assert.equal(unavailable.compatibility.status, "ranking_overlay_unavailable");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-knowledge-snapshot-verifier-v1",
  checked: [
    "generation identity is deterministic over Core Profile and Ranking Overlay",
    "snapshot is immutable",
    "missing identities fail closed",
    "incompatible Ranking Overlay fails closed",
    "unavailable Ranking Overlay preserves a Core-only turn"
  ]
}, null, 2));
