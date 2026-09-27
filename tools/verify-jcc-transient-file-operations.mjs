import assert from "node:assert/strict";
import {
  isTransientFileOperationError,
  retryTransientFileOperation,
} from "./jcc_transient_file_operations.mjs";

assert.equal(isTransientFileOperationError({ code: "UNKNOWN" }), true);
assert.equal(isTransientFileOperationError({ code: "EPERM" }), true);
assert.equal(isTransientFileOperationError({ code: "EINVAL" }), false);

let attempts = 0;
const result = await retryTransientFileOperation(() => {
  attempts += 1;
  if (attempts < 3) {
    const error = new Error("UNKNOWN: transient OneDrive write failure");
    error.code = "UNKNOWN";
    throw error;
  }
  return "written";
}, { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 });

assert.equal(result, "written");
assert.equal(attempts, 3);

let permanentAttempts = 0;
await assert.rejects(
  retryTransientFileOperation(() => {
    permanentAttempts += 1;
    const error = new Error("invalid path");
    error.code = "EINVAL";
    throw error;
  }, { attempts: 4, baseDelayMs: 1 }),
  /invalid path/u,
);
assert.equal(permanentAttempts, 1);

console.log(JSON.stringify({
  ok: true,
  verifier: "jcc-transient-file-operations",
  checks: 6,
}, null, 2));
