import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  checkpointBatch,
  checkpointMatchesPacket,
  checkpointReadyResponses,
  createRankingMaintenanceCheckpoint,
  markRankingMaintenanceBatchAttempt,
  markRankingMaintenanceBatchReady,
  normalizeRankingMaintenanceCheckpoint,
} from "./jcc_ranking_maintenance_checkpoint.mjs";
import { runRankingSemanticMaintenance } from "../ui/electron/runtime-service.js";

const packet = {
  schema: "jcc-ranking-maintenance-packet-v1",
  input_hash: "input-hash",
  stat_date: "20260829",
  target_identity: { core_profile_id: "core", active_patch_id: "patch" },
};
const batches = [
  { input_hash: "batch-a", records: [{ lineup_id: "a" }] },
  { input_hash: "batch-b", records: [{ lineup_id: "b" }] },
];

let checkpoint = createRankingMaintenanceCheckpoint(packet, batches, "2026-08-30T00:00:00.000Z");
assert.equal(checkpointMatchesPacket(checkpoint, packet), true);
assert.equal(checkpointBatch(checkpoint, batches[0], "1")?.status, "pending");

checkpoint = markRankingMaintenanceBatchAttempt(checkpoint, batches[0], "1", 2);
assert.equal(checkpointBatch(checkpoint, batches[0], "1")?.attempt_count, 2);

const response = {
  schema: "jcc-ranking-maintenance-response-v1",
  input_hash: "batch-a",
  annotations: [{ lineup_id: "a" }],
};
checkpoint = markRankingMaintenanceBatchReady(checkpoint, batches[0], "1", response, 2);
assert.equal(checkpointBatch(checkpoint, batches[0], "1")?.status, "ready");
assert.equal(checkpointReadyResponses(checkpoint).length, 1);

const childBatch = { input_hash: "batch-a-child", records: [{ lineup_id: "a" }] };
checkpoint = markRankingMaintenanceBatchReady(checkpoint, childBatch, "1.1", response, 1);
assert.equal(checkpointBatch(checkpoint, childBatch, "1.1")?.status, "ready");
assert.equal(checkpointReadyResponses(checkpoint).length, 2);

const normalized = normalizeRankingMaintenanceCheckpoint(checkpoint);
assert.ok(normalized);
assert.equal(normalized.batches.length, 3);
assert.equal(checkpointMatchesPacket({ ...checkpoint, input_hash: "other" }, packet), false);

const recoveryDir = path.resolve(".tmp-ranking-maintenance-recovery");
await rm(recoveryDir, { recursive: true, force: true });
await mkdir(recoveryDir, { recursive: true });
const recoveryFile = path.join(recoveryDir, "checkpoint.json");
const recoveryPacket = {
  ...packet,
  records: ["a", "b"].map((id) => ({
    lineup_id: id,
    semantic_hash: id.repeat(64),
    semantic_structure: "x".repeat(30000),
  })),
};
const responseFor = (prompt) => {
  const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
  return {
    schema: "jcc-ranking-maintenance-response-v1",
    target_identity: batch.target_identity,
    input_hash: batch.input_hash,
    annotations: batch.records.map((record) => ({
      lineup_id: record.lineup_id,
      confidence: "medium",
      formation_burden: "medium",
      flexibility: "medium",
      strategy_style: "standard_leveling",
      condition_flags: [],
      rationale_codes: ["new_current_day_recipe"],
    })),
  };
};
let firstRunCalls = 0;
const firstRun = await runRankingSemanticMaintenance(recoveryPacket, {
  progressFile: recoveryFile,
  ensureHost: async () => ({ available: true, provider: "test" }),
  runHost: async (_host, prompt) => {
    firstRunCalls += 1;
    if (firstRunCalls === 1) return { ok: true, response: responseFor(prompt) };
    return { ok: false, error: "simulated interruption" };
  },
  taskId: "verify-recovery-first-run",
});
assert.equal(firstRun.receipt.status, "degraded");
const persistedAfterInterrupt = JSON.parse(await readFile(recoveryFile, "utf8"));
assert.equal(persistedAfterInterrupt.batches.filter((batch) => batch.status === "ready").length, 1,
  "a completed batch must survive an interrupted update");
let resumedCalls = 0;
const resumed = await runRankingSemanticMaintenance(recoveryPacket, {
  progressFile: recoveryFile,
  ensureHost: async () => ({ available: true, provider: "test" }),
  runHost: async (_host, prompt) => {
    resumedCalls += 1;
    return { ok: true, response: responseFor(prompt) };
  },
  taskId: "verify-recovery-resumed-run",
});
assert.equal(resumed.receipt.status, "ready");
assert.equal(resumedCalls, 1, "the resumed run must skip the completed batch");
let offlineFinalizeHostChecks = 0;
let offlineFinalizeHostCalls = 0;
const offlineFinalize = await runRankingSemanticMaintenance(recoveryPacket, {
  progressFile: recoveryFile,
  ensureHost: async () => {
    offlineFinalizeHostChecks += 1;
    throw new Error("Host must not be required after every batch is checkpointed");
  },
  runHost: async () => {
    offlineFinalizeHostCalls += 1;
    throw new Error("Host must not be called after every batch is checkpointed");
  },
  taskId: "verify-recovery-offline-finalize",
});
assert.equal(offlineFinalize.receipt.status, "ready");
assert.equal(offlineFinalizeHostChecks, 0,
  "a fully checkpointed maintenance run must finalize without rechecking Host availability");
assert.equal(offlineFinalizeHostCalls, 0,
  "a fully checkpointed maintenance run must finalize without another Host request");
await rm(recoveryDir, { recursive: true, force: true });

const splitRecoveryDir = path.resolve(".tmp-ranking-maintenance-split-recovery");
await rm(splitRecoveryDir, { recursive: true, force: true });
await mkdir(splitRecoveryDir, { recursive: true });
const splitRecoveryFile = path.join(splitRecoveryDir, "checkpoint.json");
const splitPacket = {
  ...packet,
  input_hash: "split-packet",
  records: ["a", "b"].map((id) => ({
    lineup_id: id,
    semantic_hash: id.repeat(64),
    semantic_structure: "x".repeat(4000),
  })),
};
let splitFirstCalls = 0;
const splitFirstRun = await runRankingSemanticMaintenance(splitPacket, {
  progressFile: splitRecoveryFile,
  ensureHost: async () => ({ available: true, provider: "test" }),
  runHost: async (_host, prompt) => {
    splitFirstCalls += 1;
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    if (batch.records.length > 1) return { ok: true, response: { schema: "invalid" } };
    if (batch.records[0].lineup_id === "a") return { ok: true, response: responseFor(prompt) };
    return { ok: false, error: "simulated child interruption" };
  },
  taskId: "verify-split-recovery-first-run",
});
assert.equal(splitFirstRun.receipt.status, "degraded");
const splitCheckpoint = JSON.parse(await readFile(splitRecoveryFile, "utf8"));
assert(splitCheckpoint.batches.some((batch) => batch.batch_path === "1.1" && batch.status === "ready"),
  "an adaptive child batch must be checkpointed independently");
let splitResumeCalls = 0;
const splitResumed = await runRankingSemanticMaintenance(splitPacket, {
  progressFile: splitRecoveryFile,
  ensureHost: async () => ({ available: true, provider: "test" }),
  runHost: async (_host, prompt) => {
    splitResumeCalls += 1;
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    assert.equal(batch.records.length, 1,
      "resume must not re-request a parent batch when ready child checkpoints already cover part of it");
    assert.equal(batch.records[0].lineup_id, "b");
    return { ok: true, response: responseFor(prompt) };
  },
  taskId: "verify-split-recovery-resumed-run",
});
assert.equal(splitResumed.receipt.status, "ready");
assert.equal(splitResumeCalls, 1,
  "adaptive split recovery must request only the missing child batch");
await rm(splitRecoveryDir, { recursive: true, force: true });

const deferredRetryDir = path.resolve(".tmp-ranking-maintenance-deferred-retry");
await rm(deferredRetryDir, { recursive: true, force: true });

const hostRecoveryDir = path.resolve(".tmp-ranking-maintenance-host-recovery");
await rm(hostRecoveryDir, { recursive: true, force: true });
await mkdir(hostRecoveryDir, { recursive: true });
const hostRecoveryFile = path.join(hostRecoveryDir, "checkpoint.json");
const hostRecoveryPacket = {
  ...packet,
  input_hash: "host-recovery-packet",
  records: ["a", "b"].map((id) => ({
    lineup_id: id,
    semantic_hash: id.repeat(64),
    semantic_structure: "x".repeat(30000),
  })),
};
let hostDiscoveryCalls = 0;
const hostRecoveryOrder = [];
const hostRecoveryResult = await runRankingSemanticMaintenance(hostRecoveryPacket, {
  progressFile: hostRecoveryFile,
  ensureHost: async () => {
    hostDiscoveryCalls += 1;
    return hostDiscoveryCalls <= 2 ? { available: false } : { available: true, provider: "test" };
  },
  runHost: async (_host, prompt) => {
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    hostRecoveryOrder.push(batch.records[0].lineup_id);
    return { ok: true, response: responseFor(prompt) };
  },
  taskId: "verify-host-recovery",
});
assert.equal(hostRecoveryResult.receipt.status, "ready",
  "a Host that recovers while later independent batches run must allow the earlier unavailable batch to retry in the same update");
assert.deepEqual(hostRecoveryOrder, ["a", "b"],
  "a Host that recovers during discovery should process batches in deterministic order");
await rm(hostRecoveryDir, { recursive: true, force: true });

const persistentBudgetDir = path.resolve(".tmp-ranking-maintenance-persistent-budget");
await rm(persistentBudgetDir, { recursive: true, force: true });
await mkdir(persistentBudgetDir, { recursive: true });
const persistentBudgetFile = path.join(persistentBudgetDir, "checkpoint.json");
const persistentBudgetPacket = {
  ...packet,
  input_hash: "persistent-budget-packet",
  records: [{ lineup_id: "a", semantic_hash: "a".repeat(64), semantic_structure: "x" }],
};
let persistentBudgetCalls = 0;
for (let run = 0; run < 4; run += 1) {
  await runRankingSemanticMaintenance(persistentBudgetPacket, {
    progressFile: persistentBudgetFile,
    ensureHost: async () => ({ available: true, provider: "test" }),
    runHost: async () => {
      persistentBudgetCalls += 1;
      return { ok: false, error: "systematic provider failure" };
    },
    taskId: `verify-persistent-budget-${run}`,
  });
}
assert.equal(persistentBudgetCalls, 6,
  "checkpoint recovery must enforce one cumulative six-attempt ceiling instead of granting unlimited retries per update action");
const persistentBudgetCheckpoint = JSON.parse(await readFile(persistentBudgetFile, "utf8"));
assert.equal(persistentBudgetCheckpoint.batches.find((batch) => batch.batch_path === "1")?.attempt_count, 6);
await rm(persistentBudgetDir, { recursive: true, force: true });
await mkdir(deferredRetryDir, { recursive: true });
const deferredRetryFile = path.join(deferredRetryDir, "checkpoint.json");
const deferredRetryPacket = {
  ...packet,
  input_hash: "deferred-retry-packet",
  records: ["a", "b", "c"].map((id) => ({
    lineup_id: id,
    semantic_hash: id.repeat(64),
    semantic_structure: "x".repeat(30000),
  })),
};
const deferredCallOrder = [];
let failedBCalls = 0;
const deferredRetryResult = await runRankingSemanticMaintenance(deferredRetryPacket, {
  progressFile: deferredRetryFile,
  ensureHost: async () => ({ available: true, provider: "test" }),
  runHost: async (_host, prompt) => {
    const batch = JSON.parse(prompt.split("输入数据如下：\n")[1].split("\n输出形状：")[0]);
    const id = batch.records[0].lineup_id;
    deferredCallOrder.push(id);
    if (id === "b" && failedBCalls < 2) {
      failedBCalls += 1;
      return { ok: false, error: "transient Host exit", stderr: "provider connection reset" };
    }
    return { ok: true, response: responseFor(prompt) };
  },
  taskId: "verify-deferred-retry",
});
assert.equal(deferredRetryResult.receipt.status, "ready",
  "one transient leaf failure must recover within the same update action");
assert.equal(deferredRetryResult.receipt.deferred_retry_count, 1);
assert(deferredCallOrder.indexOf("c") < deferredCallOrder.lastIndexOf("b"),
  "independent later batches must complete before a transient failed leaf is retried");
const deferredCheckpoint = JSON.parse(await readFile(deferredRetryFile, "utf8"));
assert.equal(deferredCheckpoint.batches.filter((batch) => batch.status === "ready").length, 3,
  "all independent batch results must be checkpointed after deferred recovery");
await rm(deferredRetryDir, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-ranking-maintenance-recovery-verification-v1",
  ready_batch_count: checkpointReadyResponses(checkpoint).length,
  supports_adaptive_child_batches: true,
  supports_same_action_deferred_retry: true,
  supports_same_action_host_recovery: true,
  persistent_attempt_budget: 6,
}, null, 2));
