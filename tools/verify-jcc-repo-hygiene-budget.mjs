#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runAudit(args) {
  const result = spawnSync(process.execPath, ["tools/audit-jcc-repo-hygiene.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert(result.status === 0 || result.status === 1, `unexpected audit exit ${result.status}: ${result.stderr}`);
  const stdout = String(result.stdout || "").trim();
  assert(stdout.startsWith("{"), `audit must emit JSON, got: ${stdout.slice(0, 200)}`);
  return { exitCode: result.status, report: JSON.parse(stdout) };
}

async function createSyntheticTree(root) {
  for (let dirIndex = 0; dirIndex < 12; dirIndex += 1) {
    const dir = path.join(root, `cache-${dirIndex}`);
    await mkdir(dir, { recursive: true });
    for (let fileIndex = 0; fileIndex < 12; fileIndex += 1) {
      await writeFile(path.join(dir, `artifact-${fileIndex}.bin`), "x".repeat(128), "utf8");
    }
  }
}

const relativeTarget = normalizePath(path.relative(repoRoot, path.join(repoRoot, ".omx", "cache", "jcc-hygiene-budget-test")));
const syntheticRoot = path.join(repoRoot, relativeTarget);
const relativeEmptyTreeTarget = normalizePath(path.relative(repoRoot, path.join(repoRoot, ".omx", "cache", "jcc-hygiene-empty-tree-test")));
const syntheticEmptyTreeRoot = path.join(repoRoot, relativeEmptyTreeTarget);

function normalizePath(file) {
  return String(file || "").replace(/\\/g, "/");
}

try {
  await rm(syntheticRoot, { recursive: true, force: true });
  await rm(syntheticEmptyTreeRoot, { recursive: true, force: true });
  await createSyntheticTree(syntheticRoot);
  for (let index = 0; index < 40; index += 1) {
    await mkdir(path.join(syntheticEmptyTreeRoot, `empty-${index}`, "nested"), { recursive: true });
  }

  let symlinkCreated = false;
  try {
    await symlink(syntheticRoot, path.join(syntheticRoot, "zz-cycle"), "junction");
    symlinkCreated = true;
  } catch (error) {
    if (!error || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  }

  const { exitCode, report } = runAudit([
    "--ignored-target",
    relativeTarget,
    "--max-files-per-target",
    "7",
    "--max-entries-per-target",
    "1000",
    "--max-elapsed-ms",
    "30000",
    "--max-total-elapsed-ms",
    "30000",
  ]);

  assert(report.schema === "jcc-repo-hygiene-audit-v1", "must preserve hygiene audit schema");
  assert(typeof report.ok === "boolean", "must preserve audit ok boolean");
  assert(exitCode === (report.ok ? 0 : 1), "must preserve audit exit semantics");
  assert(Array.isArray(report.ignored_inventory), "must return ignored inventory");
  assert(report.ignored_inventory.length === 1, `expected one configured ignored target, got ${report.ignored_inventory.length}`);

  const entry = report.ignored_inventory[0];
  assert(entry.path === relativeTarget, `expected synthetic target path, got ${entry.path}`);
  assert(entry.category === "legacy_ocr_icon_matcher_debug", `classification changed unexpectedly: ${entry.category}`);
  assert(entry.exists === true, "synthetic target must exist");
  assert(entry.files === 7, `file budget should return partial file count 7, got ${entry.files}`);
  assert(entry.bytes > 0, "partial byte count must be returned");
  assert(entry.truncated === true, "budgeted inventory must report truncated=true");
  assert(entry.reason === "file_budget_exceeded", `unexpected canonical reason: ${entry.reason}`);
  assert(entry.truncation_reason === "file_budget_exceeded", `unexpected truncation reason: ${entry.truncation_reason}`);
  assert(Number.isInteger(entry.entries_scanned) && entry.entries_scanned >= entry.files, "entry count must describe partial traversal");
  assert(report.ignored_totals.truncated === true, "totals must report truncation");
  assert(report.ignored_totals.truncated_count === 1, `expected one truncated target, got ${report.ignored_totals.truncated_count}`);
  assert(report.ignored_totals.truncation_reasons.includes("file_budget_exceeded"), "totals must include truncation reason");
  assert(report.inventory_budget.max_files_per_target === 7, "report must expose configured file budget");
  assert(report.inventory_budget.max_entries_per_target === 1000, "report must expose configured entry budget");
  assert(report.inventory_budget.max_total_elapsed_ms === 30000, "report must expose configured total budget");

  const entryBudgetRun = runAudit([
    "--ignored-target",
    relativeEmptyTreeTarget,
    "--max-files-per-target",
    "100000",
    "--max-entries-per-target",
    "5",
    "--max-elapsed-ms",
    "30000",
    "--max-total-elapsed-ms",
    "30000",
  ]);
  const entryBudgetResult = entryBudgetRun.report.ignored_inventory[0];
  assert(entryBudgetResult.files === 0, "empty-directory budget test must not depend on file count");
  assert(entryBudgetResult.entries_scanned === 5, `entry budget should stop at 5 entries, got ${entryBudgetResult.entries_scanned}`);
  assert(entryBudgetResult.reason === "entry_budget_exceeded", `unexpected entry budget reason: ${entryBudgetResult.reason}`);

  const elapsedRun = runAudit([
    "--ignored-target",
    relativeTarget,
    "--max-files-per-target",
    "100000",
    "--max-entries-per-target",
    "100000",
    "--max-elapsed-ms",
    "1",
    "--max-total-elapsed-ms",
    "30000",
  ]);
  const elapsedEntry = elapsedRun.report.ignored_inventory[0];
  assert(elapsedEntry.truncated === true, "elapsed budget must report truncated=true");
  assert(elapsedEntry.truncation_reason === "elapsed_budget_exceeded", `unexpected elapsed truncation reason: ${elapsedEntry.truncation_reason}`);
  assert(elapsedRun.report.inventory_budget.max_elapsed_ms === 1, "report must expose configured elapsed budget");

  const totalElapsedRun = runAudit([
    "--ignored-target",
    relativeTarget,
    "--ignored-target",
    relativeEmptyTreeTarget,
    "--max-files-per-target",
    "100000",
    "--max-entries-per-target",
    "100000",
    "--max-elapsed-ms",
    "30000",
    "--max-total-elapsed-ms",
    "1",
  ]);
  assert(
    totalElapsedRun.report.ignored_inventory.some((candidate) => candidate.reason === "total_elapsed_budget_exceeded"),
    "global inventory budget must stop the remaining scan",
  );

  if (symlinkCreated) {
    const symlinkRun = runAudit([
      "--ignored-target",
      relativeTarget,
      "--max-files-per-target",
      "100000",
      "--max-entries-per-target",
      "100000",
      "--max-elapsed-ms",
      "30000",
      "--max-total-elapsed-ms",
      "30000",
    ]);
    const symlinkEntry = symlinkRun.report.ignored_inventory[0];
    assert(symlinkEntry.truncated === false, `link-safe traversal should finish, got ${symlinkEntry.reason}`);
    assert(symlinkEntry.symlinks_skipped >= 1, "directory links must be skipped instead of followed");
    assert(symlinkEntry.files === 144, `directory link must not duplicate files, got ${symlinkEntry.files}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "jcc-repo-hygiene-budget-verification-v1",
    checked: [
      "synthetic-large-ignored-tree",
      "file-budget-truncation",
      "elapsed-budget-truncation",
      "total-elapsed-budget-truncation",
      "empty-directory-entry-budget",
      "directory-link-not-followed",
      "partial-counts-returned",
      "classification-preserved",
      "exit-semantics-preserved",
    ],
  }, null, 2)}\n`);
} finally {
  await rm(syntheticRoot, { recursive: true, force: true });
  await rm(syntheticEmptyTreeRoot, { recursive: true, force: true });
}
