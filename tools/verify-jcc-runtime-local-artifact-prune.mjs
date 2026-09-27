import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jcc-local-artifact-prune-"));
const runtimeRoot = path.join(tempRoot, ".jcc-runtime-data");
const omxRoot = path.join(tempRoot, ".omx");
const legacyTestOutputTargets = [
  ".jcc-runtime-data/manual-tests",
  ".jcc-runtime-data/verification",
  ".jcc-runtime-data/ui-verification",
  ".jcc-runtime-data/tmp",
  ".jcc-runtime-data/tmp-verify-context-pack",
  ".jcc-runtime-data/tmp-verify-context-pack-augment",
  ".jcc-runtime-data/verify-context-pack",
];
const finalCoreProfileId = "b".repeat(64);

async function put(relativePath, text = "fixture") {
  const file = path.join(tempRoot, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

async function exists(relativePath) {
  try {
    await access(path.join(tempRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function run(extra = []) {
  return spawnSync(process.execPath, [
    "tools/prune-jcc-runtime-local-artifacts.mjs",
    "--repo-root", tempRoot,
    "--runtime-data-root", runtimeRoot,
    "--omx-root", omxRoot,
    "--retired-version",
    "--season-id", "s17",
    ...extra,
  ], { cwd: repoRoot, encoding: "utf8" });
}

function runMaintenance() {
  return spawnSync(process.execPath, [
    "tools/maintain-jcc-runtime-db.mjs",
    "--repo-root", tempRoot,
    "--runtime-data-root", runtimeRoot,
    "--reset-retired-version-runtime",
    "--season-id", "s17",
  ], { cwd: repoRoot, encoding: "utf8" });
}

try {
  await put("data/game-knowledge/jcc/manifest.json", JSON.stringify({
    schema: "jcc-game-knowledge-manifest-v1",
    season_descriptors: { s17: "seasons/s17/season-descriptor.json" },
    season_archives: { s17: "seasons/s17/archive-manifest.json" },
  }));
  await put("data/game-knowledge/jcc/seasons/s17/season-descriptor.json", JSON.stringify({ logical_id: "season.s17" }));
  await put("data/game-knowledge/jcc/seasons/s17/archive-manifest.json", JSON.stringify({
    schema: "jcc-season-in-place-archive-v1",
    season_id: "s17",
    status: "frozen_read_only_in_place",
    archive_policy: {
      physical_relocation_allowed: false,
      source_updates_allowed: false,
      excluded_from_new_default_compilation: true,
    },
    identity_policy: { local_season_id: "s17" },
    descriptor: {
      logical_id: "season.s17",
      path: "data/game-knowledge/jcc/seasons/s17/season-descriptor.json",
    },
    final_core_profile_id: finalCoreProfileId,
    generated_core_profiles: [{ core_profile_id: finalCoreProfileId }],
  }));
  await put("data/game-knowledge/jcc/active-profile.json", JSON.stringify({ season_id: "s18" }));
  await put("data/game-knowledge/jcc/candidates/candidate-profile.json", JSON.stringify({ season_id: "s19" }));

  const missingSeason = spawnSync(process.execPath, [
    "tools/prune-jcc-runtime-local-artifacts.mjs",
    "--repo-root", tempRoot,
    "--runtime-data-root", runtimeRoot,
    "--omx-root", omxRoot,
    "--retired-version",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(missingSeason.status, 0);
  assert.match(missingSeason.stderr, /explicit --season-id/);

  const missingReceipt = run();
  assert.notEqual(missingReceipt.status, 0);
  assert.match(missingReceipt.stderr, /DB reset receipt is missing or unreadable/);

  const maintenance = runMaintenance();
  assert.equal(maintenance.status, 0, maintenance.stderr || maintenance.stdout);
  const receiptPath = ".jcc-runtime-data/maintenance/retired-version-db-reset-receipt.json";
  const receipt = JSON.parse(await readFile(path.join(tempRoot, receiptPath), "utf8"));
  await put(receiptPath, JSON.stringify({ ...receipt, season_id: "s18" }));
  const wrongSeasonReceipt = run();
  assert.notEqual(wrongSeasonReceipt.status, 0);
  assert.match(wrongSeasonReceipt.stderr, /does not match archived season s17/);
  const restoredMaintenance = runMaintenance();
  assert.equal(restoredMaintenance.status, 0, restoredMaintenance.stderr || restoredMaintenance.stdout);

  await put(".jcc-runtime-data/state/jcc-runtime-user-settings.json", "settings");
  await put(".jcc-runtime-data/state/jcc-runtime-user-memory.json", "memory");
  await put(".jcc-runtime-data/state/jcc-runtime-match-context.json");
  await put(".jcc-runtime-data/runtime-evidence/live-match-monitor/frame.json");
  await put(".jcc-runtime-data/s18-mumu-id-validation-fixture/events.jsonl");
  await put(".jcc-runtime-data/mumu-gameassist-fixture.apk", "temporary inspection package");
  await put(".jcc-runtime-data/roi-calibration/frame.png");
  for (const target of legacyTestOutputTargets) await put(`${target}/result.json`);
  await put(".jcc-runtime-data/candidates/legacy.json");
  await put(".jcc-runtime-data/host-cli/codex-home/state.sqlite");
  await put(".jcc-runtime-data/host-cli/codex-home/sessions/lobby/state.sqlite");
  await put(".jcc-runtime-data/host-cli/codex-home/runs/run-crashed/state.sqlite");
  await put(".jcc-runtime-data/host-cli/codex-home/tmp/orphan.json");
  await put(".jcc-runtime-data/runtime-daemon/writer-lease.json", JSON.stringify({ pid: 99999999 }));
  await put(".jcc-runtime-data/logs/runtime.log");
  await put(".jcc-runtime-data/launch-logs/launch.log");
  await put(".jcc-runtime-data/verify-jcc-full-player-journey-sim.progress.log");
  await put(".jcc-runtime-data/last-adb-discovery.txt");
  await put(".omx/runtime-evidence/live-match-monitor/state.json");
  await put(".omx/logs/old-tool-run.log");
  await put(".omx/reports/old.stdout.log");
  await put(".omx/reviews/old.png");
  await put(".omx/npm-cache/cache.bin");
  await put(".omx/tmp-codex-app-server-schema/schema.json");
  await put(".omx/tmp-jcc-trace-verify.mjs", "throw new Error('one-time verifier');");
  await put(".omx/state/session.json", "state");
  await put(".omx/state/jcc-ui-runtime-state.json.123.456.tmp", "stale mirror");
  await put(".omx/plans/current.md", "plan");
  await put(".omx/archive/source-evidence.tar.gz", "archive");
  await put(".omx/third_party/rapidocr/model.bin", "model");

  const dryRun = run();
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  const report = JSON.parse(dryRun.stdout);
  assert.equal(report.mode, "dry_run");
  assert(report.candidates.some((entry) => entry.endsWith(".omx/runtime-evidence")));
  for (const target of legacyTestOutputTargets) {
    assert(report.candidates.includes(target), `${target} should be listed by dry-run`);
    assert.equal(await exists(`${target}/result.json`), true, `${target} must remain after dry-run`);
  }
  assert.equal(await exists(".omx/runtime-evidence/live-match-monitor/state.json"), true);

  const applied = run(["--apply"]);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const appliedReport = JSON.parse(applied.stdout);
  assert.equal(appliedReport.mode, "apply");
  for (const target of legacyTestOutputTargets) {
    assert(appliedReport.deleted.includes(target), `${target} should be listed as deleted`);
    assert.equal(await exists(target), false, `${target} should be pruned`);
  }
  for (const target of [
    ".jcc-runtime-data/runtime-evidence",
    ".jcc-runtime-data/s18-mumu-id-validation-fixture",
    ".jcc-runtime-data/mumu-gameassist-fixture.apk",
    ".jcc-runtime-data/roi-calibration",
    ".jcc-runtime-data/candidates",
    ".jcc-runtime-data/runtime-daemon",
    ".jcc-runtime-data/logs",
    ".jcc-runtime-data/launch-logs",
    ".jcc-runtime-data/host-cli/codex-home/runs",
    ".jcc-runtime-data/host-cli/codex-home/tmp",
    ".omx/runtime-evidence",
    ".omx/logs",
    ".omx/reports",
    ".omx/reviews",
    ".omx/npm-cache",
    ".omx/tmp-codex-app-server-schema",
    ".omx/tmp-jcc-trace-verify.mjs",
    ".omx/state/jcc-ui-runtime-state.json.123.456.tmp",
  ]) assert.equal(await exists(target), false, `${target} should be pruned`);
  for (const target of [
    ".jcc-runtime-data/app.sqlite",
    ".jcc-runtime-data/maintenance/retired-version-db-reset-receipt.json",
    ".jcc-runtime-data/state/jcc-runtime-user-settings.json",
    ".jcc-runtime-data/state/jcc-runtime-user-memory.json",
    ".jcc-runtime-data/host-cli/codex-home/state.sqlite",
    ".jcc-runtime-data/host-cli/codex-home/sessions/lobby/state.sqlite",
    ".omx/state/session.json",
    ".omx/plans/current.md",
    ".omx/archive/source-evidence.tar.gz",
    ".omx/third_party/rapidocr/model.bin",
  ]) assert.equal(await exists(target), true, `${target} must be preserved`);
  assert.equal(await exists(".jcc-runtime-data/state/jcc-runtime-match-context.json"), false);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-runtime-local-artifact-prune-verification-v1",
    checked: [
      "dry-run-before-delete",
      "all-legacy-test-output-classes-listed-and-removed",
      "retired-version-artifacts-removed",
      "canonical-sqlite-preserved",
      "user-settings-and-memory-preserved",
      "omx-state-plans-archive-and-dependencies-preserved",
      "provider-native-history-preserved",
      "explicit-season-id-required",
      "same-season-db-reset-receipt-required",
      "registered-archived-season-pruned",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
