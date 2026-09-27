import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_MAX_FILES_PER_TARGET = 20000;
const DEFAULT_MAX_ENTRIES_PER_TARGET = 50000;
const DEFAULT_MAX_ELAPSED_MS = 2000;
const DEFAULT_MAX_TOTAL_ELAPSED_MS = 10000;
const DEFAULT_IGNORED_TARGETS = [
  ".jcc-runtime-data",
  ".omx/runtime-evidence",
  ".omx/state",
  ".omx/logs",
  ".omx/downloads",
  ".omx/gradle-home",
  ".omx/bin",
  ".omx/tools",
  ".omx/cache",
  ".omx/archive",
  ".omx/reports",
  ".omx/context",
  ".omx/plans",
  ".omx/project-memory.json",
  ".omx/notepad.md",
  ".venv-ocr",
  "ui/dist",
  "ui/node_modules",
  "android-companion/.gradle",
  "android-companion/app/build",
  "android-companion/build",
];

const CLASSIFICATION_RULES = [
  { category: "runtime_daemon_ui_mainline_source", prefixes: ["ui/electron/", "ui/src/", "AGENTS.md", ".codex/skills/jcc-runtime-agent/"] },
  { category: "verifier_test_tools", prefixes: ["tools/verify-jcc-", "tools/audit-jcc-", "tools/cleanup-jcc-generated-artifacts.mjs"] },
  { category: "season_hard_data", prefixes: ["data/core-patches/", "data/runtime/jcc/"] },
  { category: "live_rankings_big_data", prefixes: ["data/live-rankings/"] },
  { category: "legacy_ocr_icon_matcher_debug", prefixes: ["tools/legacy-", "tools/debug-", ".venv-ocr/", ".omx/runtime-evidence/ocr", ".omx/cache/"] },
  { category: "runtime_generated_temp", prefixes: [".jcc-runtime-data/", ".omx/runtime-evidence/", ".omx/logs/", ".omx/state/", "ui/dist/", "ui/node_modules/", ".omx/downloads/", ".omx/gradle-home/", ".omx/bin/", ".omx/tools/", "android-companion/app/build/", "android-companion/build/", "android-companion/.gradle/"] },
  { category: "historical_omx_plans_reports", prefixes: [".omx/archive/", ".omx/reports/", ".omx/plans/", ".omx/context/", ".omx/project-memory.json", ".omx/notepad.md"] },
  { category: "paused_apk_android_side_track", prefixes: ["android-companion/"] },
];

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function normalize(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => normalize(entry.trim()))
    .filter(Boolean);
}

function parseArgs(argv) {
  const explicitIgnoredTargets = [];
  const options = {
    maxFilesPerTarget: process.env.JCC_REPO_HYGIENE_MAX_FILES_PER_TARGET
      ? parsePositiveInteger(process.env.JCC_REPO_HYGIENE_MAX_FILES_PER_TARGET, "JCC_REPO_HYGIENE_MAX_FILES_PER_TARGET")
      : DEFAULT_MAX_FILES_PER_TARGET,
    maxEntriesPerTarget: process.env.JCC_REPO_HYGIENE_MAX_ENTRIES_PER_TARGET
      ? parsePositiveInteger(process.env.JCC_REPO_HYGIENE_MAX_ENTRIES_PER_TARGET, "JCC_REPO_HYGIENE_MAX_ENTRIES_PER_TARGET")
      : DEFAULT_MAX_ENTRIES_PER_TARGET,
    maxElapsedMs: process.env.JCC_REPO_HYGIENE_MAX_ELAPSED_MS
      ? parsePositiveInteger(process.env.JCC_REPO_HYGIENE_MAX_ELAPSED_MS, "JCC_REPO_HYGIENE_MAX_ELAPSED_MS")
      : DEFAULT_MAX_ELAPSED_MS,
    maxTotalElapsedMs: process.env.JCC_REPO_HYGIENE_MAX_TOTAL_ELAPSED_MS
      ? parsePositiveInteger(process.env.JCC_REPO_HYGIENE_MAX_TOTAL_ELAPSED_MS, "JCC_REPO_HYGIENE_MAX_TOTAL_ELAPSED_MS")
      : DEFAULT_MAX_TOTAL_ELAPSED_MS,
    ignoredTargets: process.env.JCC_REPO_HYGIENE_IGNORED_TARGETS
      ? parseList(process.env.JCC_REPO_HYGIENE_IGNORED_TARGETS)
      : DEFAULT_IGNORED_TARGETS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-files-per-target") options.maxFilesPerTarget = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--max-entries-per-target") options.maxEntriesPerTarget = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--max-elapsed-ms") options.maxElapsedMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--max-total-elapsed-ms") options.maxTotalElapsedMs = parsePositiveInteger(argv[++index], arg);
    else if (arg === "--ignored-target") explicitIgnoredTargets.push(normalize(argv[++index]));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (explicitIgnoredTargets.length) options.ignoredTargets = explicitIgnoredTargets;
  return options;
}

function classify(file) {
  const normalized = normalize(file);
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.prefixes.some((prefix) => normalized === normalize(prefix).replace(/\/$/, "") || normalized.startsWith(normalize(prefix)))) {
      return rule.category;
    }
  }
  return "needs_manual_review";
}

function parseStatusZ(output) {
  const parts = output.split("\0").filter(Boolean);
  const rows = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    rows.push({ status, file: normalize(file), category: classify(file) });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return rows;
}

function resolveRepoTarget(target) {
  const resolved = path.resolve(repoRoot, target);
  const relative = path.relative(repoRoot, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Ignored target must stay inside the repository: ${target}`);
}

function sizeOfPath(target, budget) {
  const resolved = resolveRepoTarget(target);
  const emptyResult = {
    exists: false,
    files: 0,
    bytes: 0,
    entries_scanned: 0,
    directories_scanned: 0,
    symlinks_skipped: 0,
    missing_entries: 0,
    truncated: false,
    reason: null,
    truncation_reason: null,
    scan_error: null,
    elapsed_ms: 0,
  };
  if (!existsSync(resolved)) return emptyResult;

  const startedAt = performance.now();
  const targetDeadline = startedAt + budget.maxElapsedMs;
  const pendingDirectories = [];
  let files = 0;
  let bytes = 0;
  let entriesScanned = 1;
  let directoriesScanned = 0;
  let symlinksSkipped = 0;
  let missingEntries = 0;
  let truncated = false;
  let truncationReason = null;
  let scanError = null;
  const truncate = (reason) => {
    truncated = true;
    truncationReason = reason;
  };

  const timeBudgetReason = () => {
    const now = performance.now();
    if (now >= budget.totalDeadline) return "total_elapsed_budget_exceeded";
    if (now >= targetDeadline) return "elapsed_budget_exceeded";
    return null;
  };

  const handleFilesystemError = (error) => {
    if (error?.code === "ENOENT") {
      missingEntries += 1;
      return true;
    }
    scanError = {
      code: error?.code || "UNKNOWN",
      message: error?.message || String(error),
    };
    truncate("filesystem_error");
    return false;
  };

  try {
    const rootStat = lstatSync(resolved);
    if (rootStat.isSymbolicLink()) {
      symlinksSkipped = 1;
    } else if (rootStat.isDirectory()) {
      pendingDirectories.push(resolved);
    } else {
      files = 1;
      bytes = rootStat.size;
    }
  } catch (error) {
    handleFilesystemError(error);
  }

  scanLoop:
  while (!truncated && pendingDirectories.length) {
    const timeReason = timeBudgetReason();
    if (timeReason) {
      truncate(timeReason);
      break;
    }
    if (entriesScanned >= budget.maxEntriesPerTarget) {
      truncate("entry_budget_exceeded");
      break;
    }

    const current = pendingDirectories.pop();
    let directory;
    try {
      directory = opendirSync(current);
      directoriesScanned += 1;
    } catch (error) {
      if (handleFilesystemError(error)) continue;
      break;
    }

    try {
      while (true) {
        const innerTimeReason = timeBudgetReason();
        if (innerTimeReason) {
          truncate(innerTimeReason);
          break scanLoop;
        }
        if (entriesScanned >= budget.maxEntriesPerTarget) {
          truncate("entry_budget_exceeded");
          break scanLoop;
        }

        const entry = directory.readSync();
        if (!entry) break;
        entriesScanned += 1;
        if (entry.isSymbolicLink()) {
          symlinksSkipped += 1;
          continue;
        }

        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(child);
          continue;
        }
        if (files >= budget.maxFilesPerTarget) {
          truncate("file_budget_exceeded");
          break scanLoop;
        }

        try {
          const stat = lstatSync(child);
          if (stat.isSymbolicLink()) {
            symlinksSkipped += 1;
          } else if (stat.isDirectory()) {
            pendingDirectories.push(child);
          } else {
            files += 1;
            bytes += stat.size;
          }
        } catch (error) {
          if (!handleFilesystemError(error)) break scanLoop;
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  return {
    exists: true,
    files,
    bytes,
    entries_scanned: entriesScanned,
    directories_scanned: directoriesScanned,
    symlinks_skipped: symlinksSkipped,
    missing_entries: missingEntries,
    truncated,
    reason: truncationReason,
    truncation_reason: truncationReason,
    scan_error: scanError,
    elapsed_ms: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function formatMb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

function groupByCategory(rows) {
  const grouped = {};
  for (const row of rows) {
    grouped[row.category] ||= [];
    grouped[row.category].push(row);
  }
  return grouped;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const statusRows = parseStatusZ(runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const dirtyTracked = statusRows.filter((row) => !row.status.includes("??"));
  const untracked = statusRows.filter((row) => row.status.includes("??"));
  const trackedFiles = runGit(["ls-files", "-z"]).split("\0").map(normalize).filter(Boolean);
  const trackedRawRuntimeArtifacts = trackedFiles.filter((file) => (
    file.startsWith("data/runtime/jcc/calibration-samples/")
    && (/(?:^|\/)capture\/frame\.(?:png|jpe?g)$/i.test(file) || /\.(?:jsonl|log)$/i.test(file))
  ));

  const inventoryStartedAt = performance.now();
  const totalDeadline = inventoryStartedAt + options.maxTotalElapsedMs;
  const ignoredInventory = options.ignoredTargets.map((target) => {
    const size = sizeOfPath(target, {
      maxFilesPerTarget: options.maxFilesPerTarget,
      maxEntriesPerTarget: options.maxEntriesPerTarget,
      maxElapsedMs: options.maxElapsedMs,
      totalDeadline,
    });
    return {
      path: target,
      category: classify(target),
      exists: size.exists,
      files: size.files,
      bytes: size.bytes,
      mb: formatMb(size.bytes),
      entries_scanned: size.entries_scanned,
      directories_scanned: size.directories_scanned,
      symlinks_skipped: size.symlinks_skipped,
      missing_entries: size.missing_entries,
      truncated: size.truncated,
      reason: size.reason,
      truncation_reason: size.truncation_reason,
      scan_error: size.scan_error,
      elapsed_ms: size.elapsed_ms,
      suggested_action: target === ".jcc-runtime-data"
        ? "keep_local_never_commit"
        : target.startsWith(".omx/")
          ? "archive_or_clean_generated_history_after_review"
          : "ignore_or_rebuild_as_needed",
    };
  }).filter((entry) => entry.exists);

  const ignoredBytes = ignoredInventory.reduce((sum, entry) => sum + entry.bytes, 0);
  const ignoredFiles = ignoredInventory.reduce((sum, entry) => sum + entry.files, 0);
  const truncatedInventory = ignoredInventory.filter((entry) => entry.truncated);
  const report = {
    ok: dirtyTracked.length === 0 && untracked.length === 0 && trackedRawRuntimeArtifacts.length === 0,
    schema: "jcc-repo-hygiene-audit-v1",
    git_clean: dirtyTracked.length === 0 && untracked.length === 0,
    tracked_dirty_count: dirtyTracked.length,
    untracked_count: untracked.length,
    tracked_raw_runtime_artifact_count: trackedRawRuntimeArtifacts.length,
    tracked_raw_runtime_artifacts: trackedRawRuntimeArtifacts,
    tracked_dirty_by_category: groupByCategory(dirtyTracked),
    untracked_by_category: groupByCategory(untracked),
    ignored_inventory: ignoredInventory,
    ignored_totals: {
      files: ignoredFiles,
      bytes: ignoredBytes,
      mb: formatMb(ignoredBytes),
      truncated: truncatedInventory.length > 0,
      truncated_count: truncatedInventory.length,
      truncation_reasons: [...new Set(truncatedInventory.map((entry) => entry.truncation_reason).filter(Boolean))],
    },
    inventory_budget: {
      max_files_per_target: options.maxFilesPerTarget,
      max_entries_per_target: options.maxEntriesPerTarget,
      max_elapsed_ms: options.maxElapsedMs,
      max_total_elapsed_ms: options.maxTotalElapsedMs,
      actual_elapsed_ms: Math.round((performance.now() - inventoryStartedAt) * 100) / 100,
    },
    cleanup_policy: [
      "Do not commit .jcc-runtime-data, runtime evidence, screenshots, logs, dist, node_modules, or APK build outputs.",
      "Archive .omx plans/context/reports only if they are needed as historical evidence; product source of truth belongs in tracked docs/data/tools/ui.",
      "Active choice candidates come only from current-match structured user reports. Choice OCR is calibration-only; HUD and explicit owned-augment text-panel OCR are narrow exceptions, and item icon matching is explicit-request/conflict-check fallback only.",
      "Run this audit before final commits; git_clean must be true before claiming repository hygiene.",
    ],
    checked: [
      "git-tracked-dirty",
      "git-untracked",
      "tracked-raw-runtime-artifacts",
      "ignored-runtime-inventory",
      "budgeted-ignored-runtime-inventory",
      "six-category-classification",
      "cleanup-policy",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
