import assert from "node:assert/strict";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";
import { materializeReadonlyEvidence, restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";

const shared = { source: "same-snapshot", facts: Array.from({ length: 40 }, (_, i) => ({ id: i, text: "complete-fact-".repeat(8) })) };
const payload = { first: shared, nested: { repeated: shared, different: { ...shared, source: "another-authority" } } };
const encoded = materializeReadonlyEvidence(payload);
assert.deepEqual(restoreHostEvidence(encoded), payload);
assert.ok(Buffer.byteLength(JSON.stringify(encoded)) < Buffer.byteLength(JSON.stringify(payload)));
assert.equal(encoded.nested.repeated.schema, "jcc-host-evidence-address-reference-v1");
assert.equal(encoded.nested.different.source, "another-authority");
assert.equal(encoded.nested.repeated.address, "/first");

const report = [];
for (const operation of ["get_entity", "get_related_entities", "get_strategy_wiki", "get_ranking_trend", "get_lineup", "get_lineup_variants", "calculate"]) {
  let queries = 0;
  let fresh = true;
  const expansion = { status: "ok", first: shared, second: shared };
  const args = { operation, candidate_id: "candidate", selected_variant_id: "variant", candidate_evidence_id: "evidence", question: "same facts" };
  const broker = createHostReadonlyToolBroker({
    evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "snapshot" } },
    queryKnowledge: async () => { queries++; return expansion; },
    calculate: async () => { queries++; return expansion; },
    assertFresh: () => { if (!fresh) throw new Error("expired"); },
    cacheQueries: true, maxCallsPerTool: 6, maxTotalCalls: 6,
    maxResultBytes: 7000, maxCumulativeResultBytes: 32000,
    onResult: result => assert.deepEqual(result.result, expansion),
  });
  const tool = operation === "calculate" ? "calculate" : "query_knowledge";
  const first = await broker.call(tool, args);
  const second = await broker.call(tool, operation === "calculate" ? args : { ...args, recover: true, recovery_reason: "lost_evidence" });
  assert.equal(first.status, undefined, "dedupe must run before budget reduction to a partial receipt");
  assert.deepEqual(restoreHostEvidence(second).result, expansion, "explicit re-fetch is fully self-contained");
  if (operation !== "calculate") {
    assert.equal(restoreHostEvidence(first).delivery.cache_hit, false);
    assert.equal(restoreHostEvidence(second).delivery.cache_hit, true);
    assert.equal(restoreHostEvidence(second).delivery.reused_result, false);
  }
  assert.equal(queries, operation === "calculate" ? 2 : 1);
  assert.equal(broker.audit[1].cache_hit, operation !== "calculate");
  fresh = false;
  await assert.rejects(broker.call(tool, args), /expired/, "cache cannot bypass snapshot/owner checks");
  report.push({ operation, wire_bytes: Buffer.byteLength(JSON.stringify(first)), restored_bytes: Buffer.byteLength(JSON.stringify(restoreHostEvidence(first))), queries });
}
console.log(JSON.stringify({ ok: true, report }, null, 2));
