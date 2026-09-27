import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostReadonlyToolBroker } from "../ui/electron/host-readonly-tool-broker.js";
import { restoreHostEvidence } from "../ui/electron/host-evidence-materialization.js";
import { normalizeHostToolResult } from "../ui/electron/host-turn-execution-contract.js";
import { buildHostKnowledgeOperationInstructions, readHostCoachInstructionContractSync, buildHostCoachInstructions } from "./jcc_host_coach_instruction_contract.mjs";
import { JCC_CODEX_DYNAMIC_TOOL_SPECS } from "../ui/electron/host-readonly-tool-broker.js";

const instructions = buildHostKnowledgeOperationInstructions();
const bootstrap = buildHostCoachInstructions({ contract: readHostCoachInstructionContractSync(), mode: "daily_chat" }).join("\n");
assert.equal(instructions.length, 3);
for (const instruction of instructions) {
  assert.ok(bootstrap.includes(instruction));
  assert.ok(JCC_CODEX_DYNAMIC_TOOL_SPECS[0].tools[0].description.includes(instruction));
}
assert.equal(normalizeHostToolResult({ ok: false, error: "unavailable" }).delivery.payload_state, "unavailable");
assert.equal(normalizeHostToolResult({ result: { selected_ranking_candidates: { candidates: [{ candidate_id: "a" }], next_cursor: "page2" } } }).delivery.more_available, true);

const source = { status: "ok", result: { candidates: [
  { candidate_id: "a", selected_variant_id: "v1", roster: ["unit-a"], notes: "x".repeat(900) },
  { candidate_id: "b", selected_variant_id: "v2", roster: ["unit-b"], notes: "x".repeat(900) },
], candidate_working_set_truncated: true, total_matching_count: 8, remaining_count: 6, next_cursor: "source:2" } };
let calls = 0;
const broker = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "s" } }, cacheQueries: true,
  queryKnowledge: async () => { calls++; return structuredClone(source); },
});
const args = { operation: "search_lineups", limit: 2 };
const first = await broker.call("jcc.query_knowledge", args);
assert.equal(first.delivery.payload_state, "complete");
assert.equal(first.delivery.more_available, true);
assert.equal(first.delivery.recovery_available, true);
assert.equal(first.result.candidate_working_set_truncated, undefined, "pagination is not wire truncation");
assert.equal(first.result.next_cursor, "source:2");
assert.equal(first.delivery.already_retrieved, false);
const repeated = await broker.call("jcc.query_knowledge", args);
assert.equal(repeated.delivery.payload_state, "reuse_notice");
const recovered = await broker.call("jcc.query_knowledge", { ...args, recover: true, recovery_reason: "lost_evidence" });
assert.equal(recovered.delivery.payload_state, "complete");
assert.equal(recovered.delivery.already_retrieved, true);
assert.equal(recovered.delivery.reused_result, false);
assert.deepEqual(restoreHostEvidence(first).result.candidates, source.result.candidates);
assert.deepEqual(restoreHostEvidence(recovered).result.candidates, source.result.candidates);
assert.equal(calls, 1);

const partial = createHostReadonlyToolBroker({
  evidencePacket: { evidence_snapshot: { evidence_snapshot_id: "s" } },
  cacheQueries: true, maxResultBytes: 4096,
  queryKnowledge: async () => ({ status: "ok", result: { candidates: [
    { candidate_id: "huge", notes: "x".repeat(20000) },
  ] } }),
});
const incomplete = await partial.call("jcc.query_knowledge", args);
assert.equal(incomplete.delivery.payload_state, "partial");
assert.equal(incomplete.delivery.already_sufficient, false);
assert.equal(incomplete.delivery.complete_atomic_candidates, false);
console.log("Knowledge delivery semantics and atomic recovery passed");

const evidencePacket = { evidence_snapshot: { evidence_snapshot_id: "semantics-regression" } };
const recovery = { recover: true, recovery_reason: "lost_evidence" };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test("source failures remain unavailable and are not cached", async () => {
  for (const value of [
    { status: "unavailable", result: null },
    { status: "forbidden", error_code: "source_forbidden" },
    { status: "error", error_code: "snapshot_mismatch" },
    { status: "not_found", error_code: "not_found" },
    { status: "query_required", missing_fields: ["candidate_id"] },
    { status: "ambiguous", candidate_id: "a" },
    { ok: false, error: { code: "source_failed" }, result: {} },
    null,
  ]) {
    let sourceCalls = 0;
    const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
      queryKnowledge: async () => { sourceCalls++; return structuredClone(value); } });
    const normalized = normalizeHostToolResult(value);
    assert.equal(normalized.ok, false, JSON.stringify(value));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await instance.call("jcc.query_knowledge", args);
      assert.equal(result.ok, false);
      assert.equal(result.delivery.payload_state, "unavailable");
      assert.equal(result.delivery.already_sufficient, false);
      assert.equal(result.delivery.recovery_available, false);
      assert.deepEqual(result.error, normalized.error);
    }
    assert.equal(sourceCalls, 2, "failure is not a reusable successful source result");
  }
});

test("upstream partial candidates never become complete or suppress exact retrieval", async () => {
  let sourceCalls = 0;
  const value = { status: "partial", result: { candidates: [{ candidate_id: "a", missing_fields: ["roster"] }] } };
  const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
    queryKnowledge: async () => { sourceCalls++; return structuredClone(value); } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await instance.call("jcc.query_knowledge", args);
    assert.equal(result.delivery.payload_state, "partial");
    assert.equal(result.delivery.complete_atomic_candidates, false);
    assert.equal(result.delivery.already_sufficient, false);
    assert.deepEqual(restoreHostEvidence(result).result, value.result);
  }
  await instance.call("jcc.query_knowledge", { operation: "get_lineup", candidate_id: "a" });
  assert.equal(sourceCalls, 3);
});

test("zero-candidate wire truncation is not sufficient on ordinary retry", async () => {
  const result = await partial.call("jcc.query_knowledge", args);
  assert.equal(result.delivery.payload_state, "partial");
  assert.equal(result.delivery.reused_result, false);
  assert.equal(result.delivery.already_sufficient, false);
  assert.equal(result.delivery.complete_atomic_candidates, false);
  assert.notEqual(result.delivery.next_action, "answer_from_this_result");
});

const pagedCandidates = Array.from({ length: 5 }, (_, i) => ({
  candidate_id: `candidate-${i}`, selected_variant_id: `variant-${i}`,
  roster: [`unit-${i}`], equipment: { carry: `item-${i}` }, notes: String(i).repeat(1700),
}));
const pageArgs = { operation: "search_lineups", search_constraints: "A", limit: 5 };
function pagedBroker(options = {}) {
  return createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
    maxResultBytes: 4096, maxCumulativeResultBytes: 128 * 1024,
    maxTotalCalls: 10, maxCallsPerTool: 10,
    queryKnowledge: async () => ({ status: "ok", result: { candidates: structuredClone(pagedCandidates),
      remaining_count: 2, next_cursor: "source:next" } }), ...options });
}

test("broker pages recover idempotently, retaining atomic bodies and cursor chain", async () => {
  const instance = pagedBroker();
  const firstPage = await instance.call("jcc.query_knowledge", pageArgs);
  assert.ok(firstPage.next_cursor?.startsWith("tool-page:"));
  const firstRecovered = await instance.call("jcc.query_knowledge", { ...pageArgs, ...recovery });
  assert.deepEqual(firstRecovered.result, firstPage.result);
  assert.equal(firstRecovered.next_cursor, firstPage.next_cursor);
  const collected = [...restoreHostEvidence(firstPage).result.candidates];
  let cursor = firstPage.next_cursor;
  while (cursor) {
    const currentArgs = { ...pageArgs, cursor };
    const page = await instance.call("jcc.query_knowledge", currentArgs);
    const replay = await instance.call("jcc.query_knowledge", { ...currentArgs, ...recovery });
    const retry = await instance.call("jcc.query_knowledge", currentArgs);
    for (const recoveredPage of [replay, retry]) {
      assert.deepEqual(recoveredPage.result, page.result);
      assert.equal(recoveredPage.next_cursor, page.next_cursor);
      assert.equal(recoveredPage.delivery.payload_state, page.delivery.payload_state);
      assert.ok(bytes(recoveredPage) <= 4096);
    }
    collected.push(...restoreHostEvidence(page).result.candidates);
    cursor = page.next_cursor;
    if (!cursor) assert.equal(page.result.next_cursor, "source:next");
  }
  assert.deepEqual(collected, pagedCandidates, "every candidate is whole and appears on one page");
});

test("broker cursors reject changes to selectors and page size without consuming the page", async () => {
  const instance = pagedBroker();
  const firstPage = await instance.call("jcc.query_knowledge", pageArgs);
  for (const changed of [
    { search_constraints: "B" }, { question: "different" }, { entity_names: ["other"] },
    { role: "main_carry" }, { route_ids: ["other"] }, { facets: ["roster"] },
    { candidate_id: "other" }, { selected_variant_id: "other" }, { candidate_evidence_id: "other" },
    { limit: 2 }, { candidate_working_set_hint: 2 }, { operation: "expand_ranking_candidates" },
  ]) {
    await assert.rejects(instance.call("jcc.query_knowledge", {
      ...pageArgs, cursor: firstPage.next_cursor, ...changed,
    }), /readonly_tool_invalid_cursor/);
  }
  const page = await instance.call("jcc.query_knowledge", { ...pageArgs, cursor: firstPage.next_cursor });
  assert.ok(page.result.candidates.length);
});

test("recovery cannot grow pagination caches beyond admitted calls", async () => {
  const instance = pagedBroker({ maxTotalCalls: 2, maxCallsPerTool: 2 });
  const firstPage = await instance.call("jcc.query_knowledge", pageArgs);
  const secondArgs = { ...pageArgs, cursor: firstPage.next_cursor };
  const secondPage = await instance.call("jcc.query_knowledge", secondArgs);
  assert.ok(secondPage.next_cursor);
  for (let i = 0; i < 8; i++) {
    const rootReplay = await instance.call("jcc.query_knowledge", { ...pageArgs, ...recovery });
    const pageReplay = await instance.call("jcc.query_knowledge", { ...secondArgs, ...recovery });
    assert.equal(rootReplay.next_cursor, firstPage.next_cursor, "no new root continuation on recovery");
    assert.equal(pageReplay.next_cursor, secondPage.next_cursor, "no new child continuation on recovery");
  }
  await assert.rejects(instance.call("jcc.query_knowledge", { ...pageArgs, cursor: secondPage.next_cursor }), /call budget exceeded/);
  await assert.rejects(instance.call("jcc.query_knowledge", { ...pageArgs, search_constraints: "new" }), /call budget exceeded/);
});

test("post-call freshness failure leaves an undelivered page retrievable", async () => {
  let checks = 0;
  let failAt = Infinity;
  const instance = pagedBroker({ assertFresh: () => {
    checks++;
    if (checks === failAt) throw new Error("snapshot_expired");
  } });
  const firstPage = await instance.call("jcc.query_knowledge", pageArgs);
  const nextArgs = { ...pageArgs, cursor: firstPage.next_cursor };
  failAt = checks + 2;
  await assert.rejects(instance.call("jcc.query_knowledge", nextArgs), /snapshot_expired/);
  failAt = Infinity;
  const retry = await instance.call("jcc.query_knowledge", { ...nextArgs, ...recovery });
  assert.deepEqual(restoreHostEvidence(retry).result.candidates[0], pagedCandidates[firstPage.result.candidates.length]);
  failAt = checks + 1;
  await assert.rejects(instance.call("jcc.query_knowledge", { ...nextArgs, ...recovery }), /snapshot_expired/,
    "cached page delivery must still validate freshness");
});

test("page recovery enforces cumulative bytes without shrinking the original page", async () => {
  const ceiling = 11000;
  const instance = pagedBroker({ maxCumulativeResultBytes: ceiling });
  const firstPage = await instance.call("jcc.query_knowledge", pageArgs);
  const nextArgs = { ...pageArgs, cursor: firstPage.next_cursor };
  const secondPage = await instance.call("jcc.query_knowledge", nextArgs);
  let rejected = false;
  for (let i = 0; i < 10; i++) {
    try {
      const replay = await instance.call("jcc.query_knowledge", { ...nextArgs, ...recovery });
      assert.deepEqual(replay.result, secondPage.result);
      assert.equal(replay.next_cursor, secondPage.next_cursor);
      assert.ok(bytes(replay) <= 4096);
    } catch (error) {
      assert.match(error.message, /cumulative turn budget exceeded/);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true);
  assert.ok(instance.audit.filter(entry => entry.ok).every(entry => entry.cumulative_turn_bytes <= ceiling));
});

test("concurrent queries cannot collide in pagination or duplicate cache admission", async () => {
  const instance = pagedBroker({ assertFresh: async () => {} });
  const otherArgs = { ...pageArgs, search_constraints: "B" };
  const [left, right] = await Promise.all([
    instance.call("jcc.query_knowledge", pageArgs),
    instance.call("jcc.query_knowledge", otherArgs),
  ]);
  assert.notEqual(left.next_cursor, right.next_cursor);
  await instance.call("jcc.query_knowledge", { ...pageArgs, cursor: left.next_cursor });
  await instance.call("jcc.query_knowledge", { ...otherArgs, cursor: right.next_cursor });

  const singleAdmission = pagedBroker({ maxTotalCalls: 1, maxCallsPerTool: 1, assertFresh: async () => {} });
  const pages = await Promise.all(Array.from({ length: 4 }, () => singleAdmission.call("jcc.query_knowledge", pageArgs)));
  assert.equal(new Set(pages.map(page => page.next_cursor)).size, 1);
  assert.equal(singleAdmission.audit.filter(entry => entry.ok && !entry.cache_hit).length, 1);
});

const abortError = { name: "AbortError", message: "readonly_tool_call_aborted" };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("aborted delayed source cannot cache or stamp delivery; retry reads fresh evidence", async () => {
  for (const operation of ["search_lineups", "calculate"]) {
    const entered = deferred();
    const finish = deferred();
    const controller = new AbortController();
    let sourceCalls = 0;
    let delivered = 0;
    const source = async () => {
      const revision = ++sourceCalls;
      if (revision === 1) { entered.resolve(); await finish.promise; }
      return { status: "ok", result: { candidates: [{ candidate_id: "a", revision }] } };
    };
    const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
      queryKnowledge: source, calculate: source, onResult: () => { delivered++; } });
    const tool = operation === "calculate" ? "jcc.calculate" : "jcc.query_knowledge";
    const query = { operation, question: "test" };
    const pending = instance.call(tool, query, { signal: controller.signal });
    const rejected = assert.rejects(pending, abortError);
    await entered.promise;
    controller.abort();
    finish.resolve();
    await rejected;
    assert.equal(delivered, 0);
    assert.deepEqual(instance.knowledge_ledger, []);
    assert.equal(instance.audit.filter(entry => entry.ok).length, 0);
    const retry = await instance.call(tool, query);
    assert.equal(sourceCalls, 2, "an aborted source result must not populate queryCache");
    assert.equal(delivered, 1);
    assert.equal(instance.knowledge_ledger.length, 1);
    if (operation !== "calculate") {
      assert.equal(retry.result.candidates[0].revision, 2);
      assert.equal(retry.delivery.payload_state, "complete");
      assert.equal(retry.delivery.cache_hit, false);
      assert.equal(retry.delivery.previously_delivered_count, 0);
      assert.equal(retry.delivery.reused_result, false);
    }
  }
});

test("abort after either freshness await prevents source or delivery commits", async () => {
  for (const cancelAt of [1, 2]) {
    const controller = new AbortController();
    let checks = 0;
    let sourceCalls = 0;
    let delivered = 0;
    const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
      assertFresh: async () => { if (++checks === cancelAt) controller.abort(); },
      queryKnowledge: async () => { sourceCalls++; return structuredClone(source); },
      onResult: () => { delivered++; } });
    await assert.rejects(instance.call("jcc.query_knowledge", args, { signal: controller.signal }), abortError);
    assert.equal(sourceCalls, cancelAt === 1 ? 0 : 1);
    assert.equal(delivered, 0);
    assert.deepEqual(instance.knowledge_ledger, []);
    const beforeRetry = sourceCalls;
    const retry = await instance.call("jcc.query_knowledge", args);
    assert.equal(sourceCalls, beforeRetry + 1);
    assert.equal(retry.delivery.cache_hit, false);
    assert.equal(retry.delivery.previously_delivered_count, 0);
  }
});

test("abort during async onResult leaves no broker delivery stamps or cache", async () => {
  const controller = new AbortController();
  const entered = deferred();
  const finish = deferred();
  let callbacks = 0;
  let sourceCalls = 0;
  const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true,
    queryKnowledge: async () => { sourceCalls++; return structuredClone(source); },
    onResult: async () => { if (++callbacks === 1) { entered.resolve(); await finish.promise; } } });
  const pending = instance.call("jcc.query_knowledge", args, { signal: controller.signal });
  const rejected = assert.rejects(pending, abortError);
  await entered.promise;
  controller.abort();
  finish.resolve();
  await rejected;
  assert.deepEqual(instance.knowledge_ledger, []);
  assert.equal(instance.audit.filter(entry => entry.ok).length, 0);
  const retry = await instance.call("jcc.query_knowledge", args);
  assert.equal(sourceCalls, 2);
  assert.equal(retry.delivery.cache_hit, false);
  assert.equal(retry.delivery.previously_delivered_count, 0);
});

test("pre-aborted and queued-aborted calls never enter source or consume call admission", async () => {
  const controller = new AbortController();
  let sourceCalls = 0;
  let checks = 0;
  const instance = createHostReadonlyToolBroker({ evidencePacket, cacheQueries: true, maxTotalCalls: 1,
    assertFresh: async () => { checks++; },
    queryKnowledge: async () => { sourceCalls++; return structuredClone(source); } });
  controller.abort();
  await assert.rejects(instance.call("jcc.query_knowledge", args, { signal: controller.signal }), abortError);
  assert.equal(checks, 0);
  assert.equal(sourceCalls, 0);
  const fresh = instance.call("jcc.query_knowledge", args);
  const queuedController = new AbortController();
  const queued = instance.call("jcc.query_knowledge", args, { signal: queuedController.signal });
  queuedController.abort();
  await assert.rejects(queued, abortError);
  assert.equal((await fresh).delivery.payload_state, "complete");
  assert.equal(sourceCalls, 1);
  assert.equal(instance.knowledge_ledger.length, 1);
});
