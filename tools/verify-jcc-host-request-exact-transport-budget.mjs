import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  exactHostRequestBytes,
  finalizeHostRequestTransport,
} from "./run-jcc-cruise-runtime-pipeline.mjs";

const lifecycleContract = JSON.parse(await readFile(
  new URL("../data/runtime/jcc/host-context-lifecycle-contract.json", import.meta.url),
  "utf8",
));
const sizeBudgets = lifecycleContract.request_architecture.size_budgets;
const ordinaryTargetBytes = sizeBudgets.turn_delta_target_bytes;
const ordinaryHardLimitBytes = sizeBudgets.turn_delta_max_bytes;
const strategicTargetBytes = sizeBudgets.strategic_turn_delta_target_bytes;
const strategicHardLimitBytes = sizeBudgets.strategic_turn_delta_max_bytes;

const ordinary = finalizeHostRequestTransport({
  schema: "test-host-request",
  context: { transport_budget: {}, payload: "普通回合".repeat(1000) },
}, { targetBytes: ordinaryTargetBytes, hardLimitBytes: ordinaryHardLimitBytes });
assert.equal(ordinary.context.transport_budget.observed_exact_bytes, exactHostRequestBytes(ordinary));
assert.equal(ordinary.context.transport_budget.soft_target_exceeded, false);
assert.equal(ordinary.context.transport_budget.within_hard_limit, true);
assert.match(ordinary.request_hash, /^[a-f0-9]{64}$/);

const strategic = finalizeHostRequestTransport({
  schema: "test-host-request",
  context: { transport_budget: {}, payload: "完整原子候选证据".repeat(85000) },
}, { targetBytes: strategicTargetBytes, hardLimitBytes: strategicHardLimitBytes });
assert(strategic.context.transport_budget.observed_exact_bytes > ordinaryTargetBytes);
assert(strategic.context.transport_budget.observed_exact_bytes < strategicTargetBytes);
assert.equal(strategic.context.transport_budget.soft_target_exceeded, false);
assert.equal(strategic.context.transport_budget.within_hard_limit, true);

const strategicOverTarget = finalizeHostRequestTransport({
  schema: "test-host-request",
  context: { transport_budget: {}, payload: "完整原子候选证据".repeat(210000) },
}, { targetBytes: strategicTargetBytes, hardLimitBytes: strategicHardLimitBytes });
assert(strategicOverTarget.context.transport_budget.observed_exact_bytes > strategicTargetBytes);
assert(strategicOverTarget.context.transport_budget.observed_exact_bytes < strategicHardLimitBytes);
assert.equal(strategicOverTarget.context.transport_budget.soft_target_exceeded, true);

assert.throws(() => finalizeHostRequestTransport({
  context: { payload: "超出硬上限".repeat(400000) },
}, { targetBytes: ordinaryTargetBytes, hardLimitBytes: ordinaryHardLimitBytes }), /host_request_transport_hard_limit_exceeded/);

assert.throws(() => finalizeHostRequestTransport({ context: {} }, {
  targetBytes: ordinaryTargetBytes,
  hardLimitBytes: ordinaryHardLimitBytes,
  sanitizerExhausted: true,
}), /host_request_transport_sanitizer_exhausted/);

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-host-request-exact-transport-budget-verification-v1",
  ordinary_bytes: ordinary.context.transport_budget.observed_exact_bytes,
  strategic_bytes: strategic.context.transport_budget.observed_exact_bytes,
  ordinary_target_bytes: ordinaryTargetBytes,
  ordinary_hard_limit_bytes: ordinaryHardLimitBytes,
  strategic_target_bytes: strategicTargetBytes,
  strategic_hard_limit_bytes: strategicHardLimitBytes,
}, null, 2));
