#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_GATE_FAILURE_TYPES, PRODUCT_GATE_LAYERS, classifyProductGateFailure, gateLayerForCheck } from "../ui/electron/product-gate-classification.js";
import { CHECKS, DEFAULT_CHECK_TIMEOUT_MS, checkProfile, checkRunPassed, parseArgs, parseJsonTail, runNode, selectChecks, writeReport } from "./verify-jcc-runtime-product-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
assert.deepEqual(PRODUCT_GATE_LAYERS, ["deterministic", "provider_contract", "live_acceptance"]);
assert.deepEqual(PRODUCT_GATE_FAILURE_TYPES, ["product_regression", "test_fixture_failure", "environment_failure", "known_compatibility_failure"]);
assert.throws(() => gateLayerForCheck({}), /layer_required/);
assert.throws(() => gateLayerForCheck({ id: "new", layer: "typo" }), /layer_required/);
assert.equal(new Set(CHECKS.map((check) => check.id)).size, CHECKS.length);
const evidence = [];
for (const check of CHECKS) {
  const layer = gateLayerForCheck(check);
  const source = await readFile(path.join(root, check.command[0]), "utf8");
  const callsTransport = /\b(?:await|return)\s+(?:runHostAgentRequest|detectHostAgent|discoverHostAgents)\s*\(/u.test(source);
  const injectedHost = /runHost:\s*async/u.test(source);
  const journeyLive = source.includes("journeyOptions()") && source.includes("if (acceptanceOptions.realHost)");
  const optionalLive = source.includes('hasFlag("--live-host")')
    || source.includes('process.argv.includes("--live")')
    || journeyLive;
  if (check.id.includes("stub") || injectedHost || (callsTransport && !optionalLive)) {
    assert.notEqual(layer, "deterministic", check.id + " must register its provider boundary");
  }
  if (optionalLive && layer === "deterministic") {
    assert(!check.command.includes("--live-host"));
    assert(!check.command.includes("--real-host"));
    if (journeyLive) {
      const helper = await readFile(path.join(root, "tools/jcc-player-journey-acceptance.mjs"), "utf8");
      assert(helper.includes("realHost: false"));
      assert(helper.includes('if (arg === "--real-host") options.realHost = true;'));
    }
  }
  evidence.push({ id: check.id, layer, command: check.command, provider_evidence: injectedHost
    ? "injected_host_functions" : callsTransport
      ? optionalLive ? "live_branch_not_selected_and_runtime_guarded" : "transport_calls"
      : "no_direct_transport_call_runtime_guarded_if_deterministic" });
}
for (const id of ["host_task_projection_contract", "ranking_status_view_model", "host_turn_trace"]) {
  assert.equal(CHECKS.find((check) => check.id === id)?.layer, "deterministic");
}
assert.equal(CHECKS.find((check) => check.id === "host_session_lifecycle").timeout_ms, 360000);
assert.equal(CHECKS.find((check) => check.id === "response_task_delivery").timeout_ms, 360000);
assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 300000);
for (const id of ["wiki_match_recovery", "native_ranking_pull", "runtime_daemon_server", "runtime_daemon_client"]) {
  assert.equal(CHECKS.find((check) => check.id === id).timeout_ms, 300000, `${id} must have the long suite budget`);
}
for (const layer of PRODUCT_GATE_LAYERS) {
  const selected = selectChecks(layer);
  assert(selected.length > 0);
  assert(selected.every((check) => check.layer === layer));
  assert(selected.every((check) => !["manual", "hygiene"].includes(checkProfile(check))));
}
assert(selectChecks("core").every((check) => check.layer !== "live_acceptance"));
const nativeLive = CHECKS.find((check) => check.id === "host_native_schema_live");
assert.equal(nativeLive.layer, "provider_contract");
assert.equal(checkProfile(nativeLive), "live");
for (const profile of ["core", "extended", "smoke", "deterministic", "provider_contract"]) {
  assert(!selectChecks(profile).some((check) => check.id === nativeLive.id));
}
assert(selectChecks("live").some((check) => check.id === nativeLive.id));
assert.equal(CHECKS.find((check) => check.id === "host_evidence_materialization").layer, "deterministic");
assert.throws(() => selectChecks("core", ["missing-check"]), /Unknown --only/);
assert.deepEqual(selectChecks("core", ["host_session_live_smoke"]).map((check) => check.id), ["host_session_live_smoke"]);
assert.deepEqual(parseArgs(["--only", "a,b", "--only", "c"]).only, ["a", "b", "c"]);
assert.throws(() => parseArgs(["--report"]), /requires a path/);
assert.throws(() => parseArgs(["--only"]), /requires/);
assert.throws(() => parseArgs(["--only", ", ,"]), /requires/);
assert.throws(() => parseArgs(["--timeout-ms", "NaN"]), /Invalid/);

// Diagnostic words in assertion messages and filenames are not root-cause evidence.
for (const input of [
  { stderr: "AssertionError at fixtures/file.mjs ENOENT known compatibility failure" },
  { timedOut: true },
  { parsed: { failure: { failure_type: "test_fixture_failure" } } },
  { parsed: { failure: { failure_type: "known_compatibility_failure", evidence: "unsupported API" } } },
]) assert.equal(classifyProductGateFailure(input).failure_type, "product_regression");
assert.equal(classifyProductGateFailure({ spawnError: "ENOENT" }).failure_type, "environment_failure");
for (const type of PRODUCT_GATE_FAILURE_TYPES) {
  const failure = classifyProductGateFailure({ parsed: {
    failure: { failure_type: type, evidence: "verified precondition", issue_ref: "test-only-reference" },
  } });
  assert.equal(failure.failure_type, type);
  assert.equal(failure.blocking, true);
}
assert.deepEqual(parseJsonTail('diagnostic\n{"ok":false}'), { ok: false });
assert.equal(checkRunPassed({ code: 0 }, { ok: true }), true);
for (const parsed of [{ ok: true, status: "external_dependency_pending" }, { ok: true, skipped: true }, { ok: false }]) {
  assert.equal(checkRunPassed({ code: 0 }, parsed), false);
}
assert.equal(checkRunPassed({ code: 1 }, { ok: true }), false);
assert.equal(checkRunPassed({ code: 0, timed_out: true }, { ok: true }), false);
for (const check of CHECKS.filter((check) => check.layer === "live_acceptance")) {
  const source = await readFile(path.join(root, check.command[0]), "utf8");
  if (source.includes('hasFlag("--require-live")')) assert(check.command.includes("--require-live"));
  if (source.includes('hasFlag("--require-live-mumu")')) assert(check.command.includes("--require-live-mumu"));
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-gate-classification-"));
try {
  const reportPath = path.join(tempRoot, "nested", "report.json");
  await writeReport(reportPath, { ok: false, status: "running", results: [] });
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).status, "running");
  await writeReport(reportPath, { ok: false, status: "completed", diagnostics: "full failure detail" });
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).diagnostics, "full failure detail");
  assert.deepEqual(await readdir(path.dirname(reportPath)), ["report.json"]);
  const probe = await runNode(["--input-type=module", "-e",
    "console.log(JSON.stringify({ok:true,root:process.env.JCC_RUNTIME_DATA_DIR,gateRoot:process.env.JCC_PRODUCT_GATE_ISOLATED_RUNTIME_DATA_DIR,disabled:process.env.JCC_UI_DISABLE_CODEX_EXEC}));"
  ], 10000);
  assert.equal(probe.code, 0, probe.stderr);
  const observed = JSON.parse(probe.stdout);
  assert.equal(observed.root, observed.gateRoot);
  assert.equal(observed.disabled, "1");
  await assert.rejects(readFile(path.join(observed.root, "anything")), { code: "ENOENT" });
  const failedProbe = await runNode(["--input-type=module", "-e", 'console.log(JSON.stringify({ok:false}));process.exitCode=1;'], 10000);
  assert.equal(checkRunPassed(failedProbe, parseJsonTail(failedProbe.stdout)), false);
  const timeoutProbe = await runNode(["--input-type=module", "-e", "setInterval(() => {}, 1000)"], 500);
  assert.equal(timeoutProbe.timed_out, true);
  assert.equal(timeoutProbe.code, 124);

  // Even swallowed adapter errors cannot make an offline gate succeed.
  const adapter = pathToFileURL(path.join(root, "ui/electron/host-adapters.js")).href;
  const guarded = await runNode(["--input-type=module", "-e",
    "const {runHostAgentRequest}=await import(" + JSON.stringify(adapter) + ");try{await runHostAgentRequest({provider:'codex'},'must not dispatch');}catch{}console.log(JSON.stringify({ok:true}));"
  ], 10000);
  assert.equal(guarded.code, 1);
  assert.match(guarded.stderr, /deterministic_gate_provider_call_forbidden/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, schema: "jcc-product-gate-classification-v1", checked_count: CHECKS.length,
  layers: Object.fromEntries(PRODUCT_GATE_LAYERS.map((layer) => [layer, CHECKS.filter((check) => check.layer === layer).length])),
  mapping: evidence,
}, null, 2));
