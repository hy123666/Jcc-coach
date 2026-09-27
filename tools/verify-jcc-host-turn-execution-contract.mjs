import assert from "node:assert/strict";
import {
  buildHostTurnExecutionContract,
  canonicalQueryIdentity,
  decideKnowledgeQueryReuse,
  normalizeHostToolResult,
  recordKnowledgeLedgerEntry,
} from "../ui/electron/host-turn-execution-contract.js";

const contract = buildHostTurnExecutionContract({
  mode: "daily_chat",
  request: { user_message: "聊一下当前上分思路" },
  runtimeContext: {},
});
assert.equal(contract.schema, "jcc-host-turn-execution-contract-v1");
assert.equal(contract.semantic_owner, "host_model");
assert.equal(contract.query_policy.prefer_one_sufficient_query, true);
assert.equal(contract.query_policy.allow_targeted_followup, true);
assert.equal(contract.query_policy.same_query_source_execution, "cached_when_available");
assert.equal(contract.query_policy.ledger_scope, "request_time_snapshot_not_live_provider_state");
assert.equal(contract.response_policy.interim_agent_messages_allowed, false);
assert.equal(contract.response_policy.tool_call_is_first_assistant_action_when_required, true);
assert.equal(contract.response_policy.final_response_objects, 1);
assert.ok(contract.runtime_hint.possible_routes.includes("current_version_strategy"));

const rankingContract = buildHostTurnExecutionContract({
  mode: "daily_chat",
  request: { user_message: "聊一下当前上分思路" },
  runtimeContext: {
    knowledge_snapshot: { ranking_overlay_id: "ranking-s18-master-plus-test" },
    current_turn_contract: { source_policy: { live_rankings: { active_for_turn: true } } },
    daily_big_data: { available: true },
  },
});
assert.equal(
  rankingContract.first_action,
  "understand_user_intent_then_query_current_master_plus_working_set_once_if_the_question_needs_rankings",
  "current-version strategy turns should guide one initial Ranking query without taking semantic ownership from the model",
);

const unavailableRankingContract = buildHostTurnExecutionContract({
  mode: "daily_chat",
  request: { user_message: "聊一下当前上分思路" },
  runtimeContext: {
    knowledge_snapshot: { ranking_overlay_id: "unavailable:core-s18-test" },
    current_turn_contract: { source_policy: { live_rankings: { active_for_turn: false } } },
    daily_big_data: { available: false },
  },
});
assert.equal(
  unavailableRankingContract.first_action,
  "understand_user_intent_then_choose_minimal_evidence",
  "unavailable Ranking data must keep the generic evidence path",
);

const first = canonicalQueryIdentity("evidence:1", "search_lineups", {
  limit: 5,
  search_constraints: "",
  cursor: null,
});
const same = canonicalQueryIdentity("evidence:1", "search_lineups", {
  cursor: null,
  search_constraints: "",
  limit: 5,
});
const differentSnapshot = canonicalQueryIdentity("evidence:2", "search_lineups", {
  limit: 5,
  search_constraints: "",
  cursor: null,
});
assert.equal(first, same, "argument ordering must not change query identity");
assert.notEqual(first, differentSnapshot, "snapshot must bind query identity");

const ledger = recordKnowledgeLedgerEntry([], {
  receipt_id: "tool-result:1",
  query_identity: first,
  operation: "search_lineups",
  snapshot_id: "evidence:1",
  coverage: ["ranking_lineup_candidates"],
  status: "sufficient",
});
assert.equal(decideKnowledgeQueryReuse(ledger, first, { context_compacted: false }).action, "reuse");
assert.equal(decideKnowledgeQueryReuse(ledger, first, { context_compacted: true }).action, "recover");
assert.equal(decideKnowledgeQueryReuse(ledger, differentSnapshot, { context_compacted: false }).action, "execute");

const normalized = normalizeHostToolResult({
  operation: "search_lineups",
  result: { candidates: [{ candidate_id: "candidate-a" }] },
}, { evidenceSnapshotId: "evidence:1", queryIdentity: first });
assert.equal(normalized.schema, "jcc-query-knowledge-result-v2");
assert.equal(normalized.ok, true);
assert.equal(normalized.operation, "search_lineups");
assert.equal(normalized.result.candidates.length, 1);
assert.equal(normalized.query_identity, first);
assert.equal(normalized.delivery.next_action, "answer_from_this_result");

const calculation = normalizeHostToolResult({
  schema: "jcc-calculate-tool-result-v1",
  operation: "calculate",
  result: { answer: "deterministic" },
}, { operation: "calculate", evidenceSnapshotId: "evidence:1", queryIdentity: "calculate:test" });
assert.equal(calculation.schema, "jcc-calculate-tool-result-v1");
assert.equal(calculation.operation, "calculate");
assert.deepEqual(calculation.result, { answer: "deterministic" });

console.log(JSON.stringify({ ok: true, schema: "jcc-host-turn-execution-contract-verification-v1" }, null, 2));
