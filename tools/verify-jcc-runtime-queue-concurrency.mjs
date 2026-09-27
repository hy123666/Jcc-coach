import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeSqliteStore,
} from "../ui/electron/runtime-state-store.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-runtime-queue-concurrency-"));
  let storeA = null;
  let storeB = null;
  let storeC = null;
  try {
    storeA = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot }).open();
    storeB = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot }).open();
    storeC = createRuntimeSqliteStore(repoRoot, { dataRoot: tempRoot }).open();

    const queued = storeA.enqueue("host_request", { request_id: "verify-one" }, "pending", { maxAttempts: 2 });
    const results = await Promise.all([
      Promise.resolve().then(() => storeA.claimQueueItem("host_request", { workerId: "worker-a", leaseMs: 30000 })),
      Promise.resolve().then(() => storeB.claimQueueItem("host_request", { workerId: "worker-b", leaseMs: 30000 })),
      Promise.resolve().then(() => storeC.claimQueueItem("host_request", { workerId: "worker-c", leaseMs: 30000 })),
    ]);
    const claimed = results.filter(Boolean);
    assert(claimed.length === 1, `exactly one worker should claim one queue item, got ${claimed.length}`);
    assert(claimed[0].id === queued.id, "claimed item id mismatch");
    assert(claimed[0].status === "running", "claimed item must be running");
    assert(claimed[0].lease_token, "claimed item must include a fencing lease token");
    assert(claimed[0].lease_generation === 1, "first claim must use lease generation 1");

    const after = storeA.getQueueItem(queued.id);
    assert(after.attempts === 1, "single queue item should only have one claim attempt");
    assert(["worker-a", "worker-b", "worker-c"].includes(after.locked_by), "claimed queue item must record owning worker");

    const noneLeft = storeB.claimQueueItem("host_request", { workerId: "worker-extra", leaseMs: 30000 });
    assert(noneLeft === null, "running item must not be claimed again before recovery");

    storeA.failQueueItem(queued.id, { code: "VERIFY_RETRY" }, {
      workerId: claimed[0].locked_by,
      leaseToken: claimed[0].lease_token,
      leaseGeneration: claimed[0].lease_generation,
    });
    const retryClaim = storeB.claimQueueItem("host_request", { workerId: "worker-retry", leaseMs: 30000 });
    assert(retryClaim?.id === queued.id, "retry item should be claimable again");
    assert(retryClaim.attempts === 2, "retry claim should increment attempts once");
    assert(retryClaim.lease_generation === 2, "retry claim must advance the lease generation");
    assert(retryClaim.lease_token !== claimed[0].lease_token, "retry claim must rotate the fencing token");

    const staleCompletion = storeA.completeQueueItem(queued.id, { stale: true }, {
      workerId: claimed[0].locked_by,
      leaseToken: claimed[0].lease_token,
      leaseGeneration: claimed[0].lease_generation,
    });
    assert(staleCompletion === null, "stale worker must not complete a re-leased queue item");
    assert(storeA.getQueueItem(queued.id)?.status === "running", "stale completion must leave the current worker lease intact");
    const completed = storeB.completeQueueItem(queued.id, { current: true }, {
      workerId: retryClaim.locked_by,
      leaseToken: retryClaim.lease_token,
      leaseGeneration: retryClaim.lease_generation,
    });
    assert(completed?.status === "completed", "current lease owner should complete the queue item");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checked: [
        "transactional-claim-one-winner",
        "no-double-claim-while-running",
        "retry-claim-after-fail",
        "stale-lease-completion-fenced",
        "current-lease-completion-accepted",
      ],
    }, null, 2)}\n`);
  } finally {
    storeA?.close();
    storeB?.close();
    storeC?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
