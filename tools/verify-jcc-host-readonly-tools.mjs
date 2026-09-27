import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  handleCodexDynamicToolRequest,
  handleAcpHostRequest,
  hostCliCapabilities,
} from "../ui/electron/host-adapters.js";
import {
  createHostReadonlyToolBroker,
  JCC_CODEX_DYNAMIC_TOOL_SPECS,
  JCC_HOST_READONLY_TOOL_CONTRACT_VERSION,
} from "../ui/electron/host-readonly-tool-broker.js";

const codex = hostCliCapabilities("codex", null, []);
const kimi = hostCliCapabilities("kimi", null, []);
assert.equal(codex.readonly_strategy_tools.mode, "native_dynamic_tools");
assert.deepEqual(codex.readonly_strategy_tools.tools, ["jcc.query_knowledge", "jcc.calculate"]);
assert.equal(codex.readonly_strategy_tools.tool_surface_policy, "jcc_native_dynamic_tools_only");
assert.equal(kimi.readonly_strategy_tools.mode, "prefetch_complete");
assert.deepEqual(kimi.readonly_strategy_tools.tools, []);
assert.equal(codex.readonly_strategy_tools.contract_version, JCC_HOST_READONLY_TOOL_CONTRACT_VERSION);
assert.equal(JCC_CODEX_DYNAMIC_TOOL_SPECS[0].name, "jcc");
assert.deepEqual(JCC_CODEX_DYNAMIC_TOOL_SPECS[0].tools.map((tool) => tool.name), ["query_knowledge", "calculate"]);

let observed = null;
const activeTurn = {
  turnId: "turn-1",
  acceptsReadonlyTools: true,
  cancelled: false,
  readonlyToolHandler: async (toolName, args) => {
    observed = { toolName, args };
    return { evidence_snapshot_id: "evidence:test" };
  },
};
const sessionState = { providerSessionId: "thread-1", readonlyToolMode: "native_dynamic_tools", activeTurn };
const response = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 7,
  method: "item/tool/call",
  params: {
    callId: "call-1",
    threadId: "thread-1",
    turnId: "turn-1",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: { facets: ["champion_trait_map"] },
  },
}, () => sessionState);
assert.deepEqual(observed, {
  toolName: "jcc.query_knowledge",
  args: { facets: ["champion_trait_map"] },
});
assert.equal(response.result.success, true);
assert.deepEqual(JSON.parse(response.result.contentItems[0].text), { evidence_snapshot_id: "evidence:test" });

const prefetchResponse = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 8,
  method: "item/tool/call",
  params: { callId: "call-prefetch", threadId: "thread-1", turnId: "turn-1", namespace: "jcc", tool: "query_knowledge" },
}, () => ({ ...sessionState, readonlyToolMode: "prefetch_complete" }));
assert.equal(prefetchResponse.result.success, false, "a prefetch session must not accept a native dynamic-tool call");
assert.match(JSON.parse(prefetchResponse.result.contentItems[0].text).error, /unavailable|stale/i);

const acpFileResponse = await handleAcpHostRequest({
  jsonrpc: "2.0",
  id: 9,
  method: "fs/read_text_file",
  params: { path: "G:/OneDrive/000-AI/jcc-runtime/README.md" },
}, { hostCwd: "G:/OneDrive/000-AI/jcc-runtime" });
assert.equal(acpFileResponse.error?.code, -32004, "Kimi ACP must not expose arbitrary filesystem reads");

let expansionArgs = null;
const expansionBroker = createHostReadonlyToolBroker({
  evidencePacket: {
    evidence_snapshot: { evidence_snapshot_id: "evidence:ranking-expansion" },
    plan: { evidence_policy_id: "master_plus_only" },
    coverage: { receipts: [] },
  },
  queryKnowledge: async (args) => {
    expansionArgs = args;
    return { status: "expanded", candidate_working_set_count: 24 };
  },
});
const expansionResult = await expansionBroker.call("jcc.query_knowledge", {
  operation: "expand_ranking_candidates",
  candidate_working_set_hint: 40,
  question: "比较更多不同的上分阵容",
});
assert.equal(expansionArgs.operation, "expand_ranking_candidates");
assert.equal(expansionArgs.candidate_working_set_hint, 40);
assert.equal(expansionResult.result.candidate_working_set_count, 24);
await expansionBroker.call("jcc.query_knowledge", {
  operation: "search_lineups", strength_bands: ["C", "d", "invalid"], include_band_directory: true,
});
assert.deepEqual(expansionArgs.strength_bands, ["c", "d"]);
assert.equal(expansionArgs.include_band_directory, true);

const identityFields = ["candidate_id", "selected_variant_id", "candidate_evidence_id"];
const querySpec = JCC_CODEX_DYNAMIC_TOOL_SPECS[0].tools.find((tool) => tool.name === "query_knowledge");
assert.doesNotMatch(querySpec.description, /functions\.exec|max_output_tokens/,
  "native dynamic-tool registration must not teach the model an Agent-selectable compatibility wrapper");
assert.match(querySpec.description, /Compare complete returned candidates directly/,
  "the registered tool must explain that search results are directly comparable rather than incomplete summaries");
assert.match(querySpec.description, /cache_hit describes Runtime computation reuse/,
  "the registered tool must explain model-visible current-turn query reuse");
assert(querySpec.inputSchema.properties.operation.enum.includes("get_common_knowledge"),
  "native knowledge retrieval must expose Common recovery through the same global tool protocol");
assert.equal(querySpec.inputSchema.properties.strength_bands.type, "array");
assert.equal(querySpec.inputSchema.properties.include_band_directory.type, "boolean");
for (const field of identityFields) {
  assert.equal(querySpec.inputSchema.properties[field]?.type, "string");
  assert.equal(querySpec.inputSchema.properties[field]?.maxLength, 256);
}
let identityArgs;
let identityQueryCalls = 0;
const identityBroker = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "evidence:identity" } },
  maxTotalCalls: 30,
  maxCallsPerTool: 30,
  queryKnowledge: async (args) => { identityQueryCalls += 1; identityArgs = args; return { status: "ok" }; },
});
await identityBroker.call("jcc.query_knowledge", {
  operation: "get_lineup", candidate_id: " candidate:A ",
  selected_variant_id: " variant:B ", candidate_evidence_id: " evidence:C ",
});
assert.deepEqual(identityFields.map((field) => identityArgs[field]), ["candidate:A", "variant:B", "evidence:C"]);
await identityBroker.call("jcc.query_knowledge", { operation: "get_lineup", candidate_id: "candidate:A", question: "selected_variant_id=variant:wrong" });
assert.equal(identityArgs.selected_variant_id, undefined, "question must not synthesize a variant selector");
assert.equal(identityArgs.candidate_evidence_id, undefined);

let repeatedSearchCalls = 0;
const repeatedSearchBroker = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "evidence:repeat" } },
  cacheQueries: true,
  maxTotalCalls: 1,
  maxCallsPerTool: 1,
  queryKnowledge: async () => {
    repeatedSearchCalls += 1;
    return {
      status: "ok",
      result: { candidates: [{ candidate_id: "candidate:repeat", selected_variant_id: "variant:1", candidate_evidence_id: "evidence:1", strategy_notes: "evidence ".repeat(3000) }] },
    };
  },
});
const repeatedArgs = { operation: "search_lineups", search_constraints: "", limit: 5 };
const firstSearch = await repeatedSearchBroker.call("jcc.query_knowledge", repeatedArgs);
const secondSearch = await repeatedSearchBroker.call("jcc.query_knowledge", { limit: 5, search_constraints: "", operation: "search_lineups" });
assert.equal(repeatedSearchCalls, 1, "same snapshot-bound query must execute once");
assert.equal(firstSearch.schema, "jcc-query-knowledge-result-v2");
assert.equal(firstSearch.ok, true, "canonical tool results must expose a top-level success flag");
assert.equal(firstSearch.delivery.cache_hit, false, "the first retrieval must be identified as a source result");
assert.equal(Object.hasOwn(firstSearch, "expansion"), false, "legacy expansion must not be emitted on the canonical tool result");
assert.equal(JSON.stringify(firstSearch).includes('"expansion"'), false, "legacy expansion must not leak into model-visible evidence");
assert.equal(secondSearch.delivery.cache_hit, true, "the Host must see that a repeated query identity is already cached");
assert.equal(secondSearch.delivery.reused_result, true);
assert.equal(secondSearch.delivery.next_action, "answer_from_previous_result");
assert.equal(repeatedSearchBroker.knowledge_ledger.length, 2, "ledger records both retrieval and reuse without duplicate source calls");
const redundantRecovery = await repeatedSearchBroker.call("jcc.query_knowledge", { ...repeatedArgs, recover: true });
assert.equal(redundantRecovery.delivery.reused_result, true, "bare recovery must not duplicate sufficient current-turn evidence");
assert.ok(redundantRecovery.delivery.recovery_notice.includes("lost_evidence"), "genuine recovery must remain discoverable");
assert.ok(Buffer.byteLength(JSON.stringify(redundantRecovery)) < Buffer.byteLength(JSON.stringify(firstSearch)) / 5,
  "reuse must materially reduce wire bytes, not merely label duplicate evidence");
const recoveredSearch = await repeatedSearchBroker.call("jcc.query_knowledge", { ...repeatedArgs, recover: true, recovery_reason: "context_compaction" });
assert.equal(repeatedSearchCalls, 1, "recovery must rehydrate cached evidence without a second source query");
assert.equal(recoveredSearch.delivery.cache_hit, true, "recovery must identify the rehydrated result as a cache hit");
assert.equal(recoveredSearch.delivery.reused_result, false);
assert.equal(recoveredSearch.result.candidates.length, 1);
assert.deepEqual(recoveredSearch.result, firstSearch.result, "explicit recovery must preserve every fact");
assert.equal(repeatedSearchBroker.audit.filter((entry) => entry.ok).length, 4,
  "repeated and recovery reads must remain auditable without consuming the source-call budget");

const partialBroker = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "evidence:partial" } },
  cacheQueries: true,
  maxResultBytes: 4096,
  queryKnowledge: async () => ({ status: "ok", result: { candidates: [
    { candidate_id: "large", strategy_notes: "x".repeat(20000) },
  ] } }),
});
const partialFirst = await partialBroker.call("jcc.query_knowledge", repeatedArgs);
assert.equal(partialFirst.status, "partial");
const partialRecovery = await partialBroker.call("jcc.query_knowledge", { ...repeatedArgs, recover: true });
assert.notEqual(partialRecovery.delivery.reused_result, true, "partial delivery must not be declared complete by its source cache");

let crossOperationCalls = [];
const crossOperationBroker = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "evidence:cross-operation" } },
  maxTotalCalls: 4,
  maxCallsPerTool: 4,
  queryKnowledge: async (args) => {
    crossOperationCalls.push(args.operation);
    if (args.operation === "search_lineups") {
      return {
        status: "ok",
        result: {
          candidates: [{
            candidate_id: "candidate:complete",
            selected_variant_id: "candidate:complete:variant:1",
            candidate_evidence_id: "evidence:complete",
            canonical_variant: { lineup_ids: ["c1", "c2"] },
          }],
        },
      };
    }
    return { status: "ok", result: { candidate_id: args.candidate_id, recovered: true } };
  },
});
const completeSearch = await crossOperationBroker.call("jcc.query_knowledge", {
  operation: "search_lineups", search_constraints: "", limit: 5,
});
assert.equal(completeSearch.delivery.complete_atomic_candidates, true);
const redundantLineup = await crossOperationBroker.call("jcc.query_knowledge", {
  operation: "get_lineup", candidate_id: "candidate:complete",
});
assert.equal(redundantLineup.delivery.reused_result, true,
  "an exact get_lineup without a missing facet must reuse the complete search projection");
assert.equal(redundantLineup.delivery.reuse_reason, "candidate_already_delivered_by_complete_search_projection");
assert.deepEqual(crossOperationCalls, ["search_lineups"],
  "cross-operation reuse must avoid a redundant source query");
const recoveredLineup = await crossOperationBroker.call("jcc.query_knowledge", {
  operation: "get_lineup", candidate_id: "candidate:complete", recover: true,
});
assert.deepEqual(crossOperationCalls, ["search_lineups", "get_lineup"],
  "explicit recovery must still permit an exact re-fetch after compaction or lost context");
assert.equal(recoveredLineup.result.candidate_id, "candidate:complete");
for (const field of identityFields) {
  await identityBroker.call("jcc.query_knowledge", { operation: "get_lineup", [field]: "x".repeat(256) });
  assert.equal(identityArgs[field].length, 256);
  for (const invalid of ["x".repeat(257), "  ", null, 123, {}]) {
    const before = identityQueryCalls;
    await assert.rejects(identityBroker.call("jcc.query_knowledge", { operation: "get_lineup", [field]: invalid }),
      new RegExp(`readonly_tool_invalid_${field}`));
    assert.equal(identityQueryCalls, before, "invalid explicit identity must not reach candidate-only fallback");
  }
}

const scopedPacket = {
  evidence_snapshot: { evidence_snapshot_id: "evidence:scoped-query" },
  plan: { evidence_policy_id: "master_plus_only" },
  coverage: { receipts: [
    { facet_id: "roster", route_ids: ["lineup"], state: "satisfied" },
    { facet_id: "items", route_ids: ["equipment"], state: "satisfied" },
    { facet_id: "missing", route_ids: ["lineup"], state: "missing" },
  ] },
};
const scopedStore = { roster: { units: ["UnitA"] }, items: { unrelated: "x".repeat(20_000) } };
async function scopedQuery(args) {
  const broker = createHostReadonlyToolBroker({
    evidencePacket: scopedPacket,
    evidenceStore: scopedStore,
    maxResultBytes: 4096,
    queryKnowledge: async (normalized) => ({ operation: normalized.operation, units: ["UnitA"] }),
  });
  return broker.call("jcc.query_knowledge", args);
}
for (const operation of ["get_entity", "get_related_entities", "get_lineup", "get_ranking_trend", "get_strategy_wiki", "expand_ranking_candidates"]) {
  for (const selectors of [{}, { facets: ["items"], route_ids: ["equipment"] }]) {
    const result = await scopedQuery({ operation, entity_names: ["candidate:A"], ...selectors });
    assert.deepEqual(result.result, { operation, units: ["UnitA"] }, `${operation}: unrelated evidence must not compact away the exact result`);
    assert.deepEqual(result.receipts, []);
    assert.deepEqual(result.evidence, {});
    assert.equal(result.evidence_snapshot_id, "evidence:scoped-query");
    assert.equal(result.source_policy, "master_plus_only");
  }
}
for (const args of [{}, { operation: "retrieve_evidence" }, { entity_names: ["UnitA"] }, { question: "UnitA roster" }]) {
  const result = await scopedQuery(args);
  assert.deepEqual(result.receipts, [], "an unscoped query must never replay all receipts");
  assert.deepEqual(result.evidence, {});
  assert.deepEqual(result.result.units, ["UnitA"]);
}
for (const [args, facets] of [
  [{ facets: ["roster"] }, ["roster"]],
  [{ operation: "retrieve_evidence", route_ids: ["lineup"] }, ["roster", "missing"]],
  [{ facets: ["roster"], route_ids: ["equipment"] }, []],
  [{ facets: ["unknown"] }, []],
]) {
  const result = await scopedQuery(args);
  assert.deepEqual(result.receipts.map((receipt) => receipt.facet_id), facets);
  assert.deepEqual(result.evidence, facets.includes("roster") ? { roster: scopedStore.roster } : {});
}

const rebuiltTurn = {
  turnId: "turn-rebuilt",
  acceptsReadonlyTools: true,
  cancelled: false,
  readonlyToolHandler: async () => {
    sessionState.activeTurn = { ...rebuiltTurn };
    return { survives_state_rebuild: true };
  },
};
sessionState.activeTurn = rebuiltTurn;
sessionState.capabilityReceipt = { observed_tool_calls: [] };
const rebuiltStateTurn = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 71,
  method: "item/tool/call",
  params: {
    callId: "call-rebuilt-state",
    threadId: "thread-1",
    turnId: "turn-rebuilt",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: {},
  },
}, () => sessionState);
assert.equal(rebuiltStateTurn.result.success, true,
  "reconstructed active-turn state with the same identity must not expire a valid tool call");
assert.deepEqual(JSON.parse(rebuiltStateTurn.result.contentItems[0].text), { survives_state_rebuild: true });
assert.deepEqual(sessionState.capabilityReceipt.observed_tool_calls, ["jcc.query_knowledge"]);

const unavailable = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 8,
  method: "item/tool/call",
  params: {
    callId: "call-2",
    threadId: "thread-1",
    turnId: "turn-1",
    namespace: "jcc",
    tool: "calculate",
    arguments: { question: "test" },
  },
}, null);
assert.equal(unavailable.result.success, false);
assert.equal(JSON.parse(unavailable.result.contentItems[0].text).error, "readonly_tool_unavailable_for_this_turn");

const staleTurn = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 9,
  method: "item/tool/call",
  params: {
    callId: "call-stale",
    threadId: "thread-1",
    turnId: "turn-old",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: {},
  },
}, () => sessionState);
assert.equal(staleTurn.result.success, false);
assert.equal(JSON.parse(staleTurn.result.contentItems[0].text).error, "readonly_tool_stale_or_unbound_turn");

const expiringTurn = {
  turnId: "turn-expiring",
  acceptsReadonlyTools: true,
  cancelled: false,
  readonlyToolHandler: async () => {
    sessionState.activeTurn = activeTurn;
    return { should_not_escape: true };
  },
};
sessionState.activeTurn = expiringTurn;
const expiredDuringCall = await handleCodexDynamicToolRequest({
  jsonrpc: "2.0",
  id: 10,
  method: "item/tool/call",
  params: {
    callId: "call-expiring",
    threadId: "thread-1",
    turnId: "turn-expiring",
    namespace: "jcc",
    tool: "query_knowledge",
    arguments: {},
  },
}, () => sessionState);
assert.equal(expiredDuringCall.result.success, false);
assert.equal(JSON.parse(expiredDuringCall.result.contentItems[0].text).error, "readonly_tool_turn_expired_during_call");

const adapterSource = await readFile("ui/electron/host-adapters.js", "utf8");
const runtimeServiceSource = await readFile("ui/electron/runtime-service.js", "utf8");
assert.match(adapterSource, /dynamicTools:\s*JCC_CODEX_DYNAMIC_TOOL_SPECS/);
assert.match(adapterSource, /onServerRequest:\s*\(message\)\s*=>\s*handleCodexDynamicToolRequest/);
assert.match(adapterSource, /readonlyToolHandler/);
assert.match(adapterSource, /codexDynamicToolsUnsupported/);
assert.match(adapterSource, /threadResult = await connection\.request\("thread\/start", startParams/);
assert.match(adapterSource, /"--disable", "shell_tool"/,
  "JCC Codex sessions must disable the generic shell surface so native JCC tools are the only knowledge route");
assert.match(adapterSource, /"--disable", "unified_exec"/,
  "JCC Codex sessions must disable the unified shell executor as well as the legacy shell feature");
assert.match(adapterSource, /tool_surface_policy: "jcc_native_dynamic_tools_only"/,
  "the native-only tool surface must participate in persistent session identity");
assert.match(adapterSource, /readonlyToolMode = "prefetch_complete"/);
assert.match(adapterSource, /function codexThreadHasRegisteredReadonlyTools\(threadResult\)/,
  "resumed threads must prove registered JCC tools before claiming native capability");
assert.match(adapterSource, /codexThreadHasRegisteredReadonlyTools\(threadResult\)/,
  "resumed threads must use the explicit tool capability probe");
assert.doesNotMatch(adapterSource, /Array\.isArray\(persistedTools\) && persistedTools\.length === 0[\s\S]{0,80}native_dynamic_tools/,
  "missing dynamicTools metadata must not be inferred as native capability");
assert.doesNotMatch(runtimeServiceSource, /provider\s*===\s*"codex"\s*\?\s*"native_dynamic_tools"\s*:\s*"prefetch_complete"/,
  "Runtime must not infer native capability from provider identity before registration is verified");
assert.match(adapterSource, /params\.threadId === before\.providerSessionId/);
assert.match(adapterSource, /params\.turnId === activeTurn\.turnId/);

console.log(JSON.stringify({ ok: true, schema: "jcc-host-readonly-tools-verification-v1" }));
