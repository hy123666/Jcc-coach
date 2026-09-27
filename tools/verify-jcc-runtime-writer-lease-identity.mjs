import { strict as assert } from "node:assert";
import { currentProcessIdentity, leaseOwnerIsCurrentProcess } from "../ui/electron/runtime-writer-lease.js";

const current = currentProcessIdentity();

assert.equal(current.pid, process.pid, "current process identity must expose the actual PID");
assert.ok(current.started_at, "current process identity must expose a stable process start time");

assert.equal(
  leaseOwnerIsCurrentProcess({
    pid: current.pid,
    process_started_at: current.started_at,
  }),
  true,
  "an exact PID and process-start identity must be treated as the active writer",
);

assert.equal(
  leaseOwnerIsCurrentProcess({
    pid: current.pid,
    process_started_at: "2000-01-01T00:00:00.000Z",
  }),
  false,
  "a live PID reused by a newer process must not keep an old writer lease active",
);

assert.equal(
  leaseOwnerIsCurrentProcess({
    pid: 2147483647,
    process_started_at: "2000-01-01T00:00:00.000Z",
  }),
  false,
  "a missing process must not keep a writer lease active",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-runtime-writer-lease-identity-verification-v1",
  checked: [
    "exact-process-instance-owns-lease",
    "reused-pid-does-not-own-old-lease",
    "missing-process-does-not-own-lease",
  ],
})}\n`);
