import assert from "node:assert/strict";
import { aggregateKnowledgeResult, isReusableKnowledgeReceipt } from "../ui/electron/knowledge-aggregation-layer.js";

const input = {
  result: { augment: { id: "augment:test", effect: "test" } },
  relations: [{ from: "augment:test", type: "fits", to: "lineup:test" }],
  source: { core_profile_id: "core:test", ranking_generation_id: "ranking:test" },
  freshness: { core: "current", ranking: "current" },
  snapshotId: "snapshot:test",
  sessionId: "match:test",
  query: { operation: "get_augment", entity_names: ["augment:test"] },
};
const output = aggregateKnowledgeResult(input);
assert.equal(output.schema, "jcc-knowledge-aggregation-result-v1");
assert.equal(output.source.knowledge_snapshot_id, "snapshot:test");
assert.equal(output.query_receipt.match_session_id, "match:test");
assert(isReusableKnowledgeReceipt(output, input));
assert(!isReusableKnowledgeReceipt(output, { ...input, snapshotId: "snapshot:other" }));
assert(Object.isFrozen(output));
assert(Object.isFrozen(output.result));
assert(Object.isFrozen(output.query_receipt));
console.log(JSON.stringify({ ok: true, schema: "jcc-knowledge-aggregation-layer-verification-v1", receipt_id: output.query_receipt.receipt_id }));
