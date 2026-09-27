import assert from "node:assert/strict";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";
import { rankingToolQueryRequest, knowledgeQueryScope, recordKnowledgeToolResult, markValidatedHostResponse, isValidatedHostResponse } from "../ui/electron/host-knowledge-turn.js";

const packet = { evidence_snapshot: { evidence_snapshot_id: "snapshot:test" } };
const candidates = Array.from({ length: 5 }, (_, i) => ({
  candidate_id: `candidate:${i}`, selected_variant_id: `variant:${i}`,
  candidate_evidence_id: `evidence:${i}`, roster: ["A", "B"], detail: "x".repeat(600),
}));
for (const operation of ["search_lineups", "expand_ranking_candidates"]) {
  let queries = 0;
  const delivered = [];
  const broker = createHostReadonlyToolBroker({
    evidencePacket: packet, maxResultBytes: 2200, maxCumulativeResultBytes: 12000,
    maxCallsPerTool: 10, maxTotalCalls: 10,
    onResult: (result) => delivered.push(result),
    queryKnowledge: async () => {
      queries++;
      return operation === "search_lineups"
        ? { result: { candidates } }
        : { selected_ranking_candidates: { candidates } };
    },
  });
  const received = [];
  let cursor;
  do {
    const result = await broker.call("query_knowledge", { operation, cursor });
    const page = result.result?.candidates
      ? result.result
      : result.result?.selected_ranking_candidates;
    assert.ok(page.candidates.length, "a bounded page must retain complete candidates");
    received.push(...page.candidates);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2200);
    cursor = result.next_cursor;
  } while (cursor);
  assert.deepEqual(received, candidates);
  assert.equal(queries, 1, "continuation must not re-run broad retrieval");
  assert.equal(delivered.length > 1, true);
}
const nearBudget = createHostReadonlyToolBroker({
  evidencePacket: packet, maxResultBytes: 4096, maxCumulativeResultBytes: 4096,
  queryKnowledge: async () => ({ data: "x".repeat(3800) }),
});
await nearBudget.call("query_knowledge", { operation: "get_entity" });
const query = rankingToolQueryRequest({ operation: "search_lineups", limit: 5, entity_names: ["婕拉"], role: "main_carry" }, {
  requestId: "task", catalog: { entities: [] }, facts: { gold: 20 }, liveState: { stage_round: "3-2" },
});
assert.equal(query.ranking_working_set_hint, 5);
assert.match(query.user_message, /婕拉主C/);
assert.equal(query.context.live_state_summary.stage_round, "3-2");
const current = { request_id: "direct:new", request_hash: "new-hash", mode: "cruise" };
recordKnowledgeToolResult(current, { result: { candidates } }, { operation: "search_lineups" });
assert.equal(knowledgeQueryScope(current).candidates.size, 5);
recordKnowledgeToolResult(current, { result: { ...candidates[0], schema: "jcc-atomic-lineup-evidence-v1", status: "ok", detail: undefined } }, { operation: "get_lineup" });
assert.equal([...knowledgeQueryScope(current).candidates.values()][0].detail, candidates[0].detail,
  "a narrower exact lookup cannot overwrite the complete candidate used for validation");
assert.equal(JSON.stringify(current).includes("candidate:"), false, "local validation must never serialize into a new prompt");
assert.equal(knowledgeQueryScope({ ...current }).candidates.size, 0, "a different task object must not inherit evidence");
const response = markValidatedHostResponse({
  schema: "jcc-host-cli-coach-response-v1", generated_by: "host_cli_main_model",
  request_id: current.request_id, request_hash: current.request_hash, mode: current.mode,
  final_text: "按当前信息回答。",
}, current);
assert.equal(isValidatedHostResponse(response, current), true);
assert.equal(isValidatedHostResponse({ ...response }, current), false);
assert.equal(isValidatedHostResponse(response, { ...current, request_id: "foreign" }), false);
const { completePendingHostCoach } = await import("../ui/electron/runtime-service.js");
const old = { request_id: "old-pipeline", request_hash: "old-hash", mode: "augment_choice" };
const completion = await completePendingHostCoach({
  request: old,
  request_event: { type: "advice_response_requested", response_id: old.request_id, mode: old.mode, host_cli_agent_request: old },
}, response, "task", null, current);
assert.equal(completion.ok, true, completion.error);
assert.equal(completion.advice_response.request_ref.request_id, current.request_id);
assert.equal(completion.advice_response.response_id, current.request_id);
assert.equal(completion.advice_response.mode, current.mode);
assert.equal(completion.advice_response.coach_response, response, "already validated response is not normalized twice");
console.log("pull delivery regression tests passed");
