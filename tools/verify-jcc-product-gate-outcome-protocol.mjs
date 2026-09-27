import assert from "node:assert/strict";
import { checkRunPassed, parseJsonTail, runNode } from "./verify-jcc-runtime-product-gate.mjs";

const cases = [
  { name: "canonical_success", stdout: '{"ok":true}', expected: true },
  { name: "canonical_success_with_metrics", stdout: '{"ok":true,"status":"ok","count":3}', expected: true },
  { name: "legacy_explicit_pass", stdout: '{"status":"pass"}', expected: true },
  { name: "diagnostics_before_json", stdout: 'diagnostic\n{"ok":true}', expected: true },
  { name: "empty_zero_exit", stdout: "", expected: false },
  { name: "plain_text_success", stdout: "verification passed.", expected: false },
  { name: "status_ok_only", stdout: '{"status":"ok"}', expected: false },
  { name: "malformed_json", stdout: '{"ok":true', expected: false },
  { name: "failure_overrides_pass", stdout: '{"ok":false,"status":"pass"}', expected: false },
  { name: "nonzero_overrides_success", stdout: '{"ok":true}', code: 1, expected: false },
  { name: "skip_flag", stdout: '{"ok":true,"skipped":true}', expected: false },
  ...["skipped", "external_dependency_pending", "simulated_pass_external_mumu_pending"].map((status) => ({
    name: status, stdout: JSON.stringify({ ok: true, status }), expected: false,
  })),
];
const verified = [];
for (const fixture of cases) {
  const run = await runNode(["--input-type=module", "-e",
    `process.stdout.write(${JSON.stringify(fixture.stdout)});process.exitCode=${fixture.code || 0};`,
  ], 10000);
  assert.equal(run.code, fixture.code || 0, run.stderr);
  assert.equal(checkRunPassed(run, parseJsonTail(run.stdout)), fixture.expected, fixture.name);
  verified.push({ name: fixture.name, exit_code: run.code, accepted: fixture.expected });
}
assert.equal(checkRunPassed({ code: 0, timed_out: true }, { ok: true }), false);
console.log(JSON.stringify({ ok: true, schema: "jcc-product-gate-outcome-protocol-verification-v1", verified }, null, 2));
