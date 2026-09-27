import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { journeyOptions } from "./jcc-player-journey-acceptance.mjs";

const options = journeyOptions();
if (options.help || options.plan) {
  console.log("Usage: node tools/verify-jcc-full-player-journey-matrix.mjs [--real-host --provider codex|kimi --model MODEL --reasoning low]\nRuns baseline, artifact and radiant sequentially. Progress streams to stderr; reports use stdout. --real-host incurs provider calls for every scenario; default uses validated simulated responses.");
  process.exit(0);
}

const root = process.cwd();
const reportFile = options.report ? path.resolve(root, options.report) : null;
const journeyScript = path.join(root, "tools", "verify-jcc-full-player-journey-sim.mjs");
const scenarios = [
  { id: "baseline", item_choice_kind: "completed_item_forge" },
  { id: "artifact", item_choice_kind: "artifact_forge" },
  { id: "radiant", item_choice_kind: "radiant_item_choice" },
];

function runJourney(scenario) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    process.stderr.write(`[journey-matrix:${scenario.id}] starting\n`);
    const args = process.argv.slice(2);
    if (reportFile) {
      const reportArg = args.indexOf("--report");
      const parsed = path.parse(reportFile);
      args[reportArg + 1] = path.join(parsed.dir, `${parsed.name}-${scenario.id}${parsed.ext || ".json"}`);
    }
    const child = spawn(process.execPath, [journeyScript, ...args], {
      cwd: root,
      env: {
        ...process.env,
        JCC_VERIFY_FULL_PLAYER_JOURNEY_VARIANT: scenario.id,
        JCC_VERIFY_FULL_PLAYER_JOURNEY_MATCH_ID: `journey-match-${scenario.id}`,
        JCC_VERIFY_FULL_PLAYER_JOURNEY_ITEM_CHOICE_KIND: scenario.item_choice_kind,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(`[journey-matrix:${scenario.id}] ${chunk}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      process.stderr.write(`[journey-matrix:${scenario.id}] exited ${code}; elapsed ${Date.now() - startedAt}ms\n`);
      if (code !== 0) {
        let failure;
        try { failure = JSON.parse(stdout)?.acceptance; } catch {}
        reject(new Error(`${scenario.id} journey failed with code ${code}: ${failure?.failure_step || "unknown step"}\n${failure?.error || stderr.slice(-4000)}`));
        return;
      }
      let report;
      try {
        report = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`${scenario.id} journey returned invalid JSON: ${error.message}\n${stdout}`));
        return;
      }
      resolve({
        id: scenario.id,
        item_choice_kind: scenario.item_choice_kind,
        elapsed_ms: Date.now() - startedAt,
        report,
      });
    });
  });
}

const results = [];
for (const scenario of scenarios) results.push(await runJourney(scenario));
assert.equal(results.length, 3);
assert.equal(new Set(results.map((entry) => entry.report.match_session_id)).size, 3);
for (const result of results) {
  assert.equal(result.report.ok, true);
  assert.equal(result.report.acceptance?.validity, true);
  assert.equal(result.report.acceptance?.perf, true);
  assert.equal(result.report.journey_variant, result.id);
  assert.equal(result.report.item_choice_kind, result.item_choice_kind);
  assert(result.report.checked.includes("fixed_checkpoint_progression_through_3_5_4_3_4_5_and_5_3"));
}

const report = {
  ok: true,
  schema: "jcc-full-player-journey-matrix-v1",
  scenario_count: results.length,
  validity: results.every((entry) => entry.report.acceptance.validity === true),
  perf: results.every((entry) => entry.report.acceptance.perf === true),
  target_met: results.every((entry) => entry.report.acceptance.target_met === true),
  real_host_dispatch: results.every((entry) => entry.report.acceptance.real_host_dispatch === true),
  scenarios: results.map((entry) => ({
    id: entry.id,
    match_session_id: entry.report.match_session_id,
    item_choice_kind: entry.item_choice_kind,
    elapsed_ms: entry.elapsed_ms,
    acceptance: entry.report.acceptance,
    runtime_shutdown: entry.report.shutdown?.status || null,
  })),
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (reportFile) {
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, serialized);
}
process.stdout.write(serialized);
