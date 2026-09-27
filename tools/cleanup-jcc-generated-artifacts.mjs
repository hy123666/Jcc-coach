import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");

const CLEANUP_TARGETS = [
  {
    path: ".omx/runtime-evidence",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "Runtime evidence and host response files are generated debug artifacts.",
  },
  {
    path: ".omx/logs",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "OMX logs are generated runtime logs; product runtime now writes canonical lightweight state to .jcc-runtime-data/app.sqlite.",
  },
  {
    path: ".omx/downloads",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "Downloaded APK/SDK/archive artifacts are not product source.",
  },
  {
    path: ".omx/gradle-home",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "Gradle cache is rebuildable.",
  },
  {
    path: ".omx/bin",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "OMX local binaries are generated helper artifacts.",
    optional: true,
  },
  {
    path: ".omx/tools",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "Vendored/generated tool workspace under .omx is not JCC Runtime product source.",
  },
  {
    path: ".omx/cache",
    category: "legacy_ocr_icon_matcher_debug",
    action: "delete",
    reason: "Legacy cache is debug-only; product visual assets live under data/runtime/jcc.",
  },
  {
    path: ".venv-ocr",
    category: "legacy_ocr_icon_matcher_debug",
    action: "delete",
    reason: "Legacy OCR virtualenv is rebuildable and not mainline.",
  },
  {
    path: "ui/dist",
    category: "runtime_generated_temp",
    action: "delete",
    reason: "Vite build output is generated and ignored.",
  },
  {
    path: "android-companion/.gradle",
    category: "paused_apk_android_side_track",
    action: "delete",
    reason: "Paused APK-side local Gradle state is generated.",
  },
  {
    path: "android-companion/app/build",
    category: "paused_apk_android_side_track",
    action: "delete",
    reason: "Paused APK-side build output is generated.",
  },
  {
    path: "android-companion/build",
    category: "paused_apk_android_side_track",
    action: "delete",
    reason: "Paused APK-side build output is generated.",
  },
];

const PRESERVE_TARGETS = [
  {
    path: ".jcc-runtime-data",
    category: "runtime_canonical_local_state",
    reason: "Local canonical runtime SQLite/state; never commit, but do not delete automatically.",
  },
  {
    path: ".omx/context",
    category: "historical_omx_plans_reports",
    reason: "Small historical planning context; preserve unless user asks for archive cleanup.",
  },
  {
    path: ".omx/plans",
    category: "historical_omx_plans_reports",
    reason: "Small historical planning artifacts; preserve unless user asks for archive cleanup.",
  },
  {
    path: ".omx/archive",
    category: "historical_omx_plans_reports",
    reason: "Historical archive; preserve for manual review.",
  },
  {
    path: ".omx/reports",
    category: "historical_omx_plans_reports",
    reason: "Small reports; preserve for manual review.",
  },
  {
    path: "ui/node_modules",
    category: "dependency_install",
    reason: "Needed for local build/test speed; ignored but not cleanup default.",
  },
];

function isInsideRepo(target) {
  const resolved = path.resolve(repoRoot, target);
  const relative = path.relative(repoRoot, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sizeOfPath(target) {
  const resolved = path.resolve(repoRoot, target);
  if (!existsSync(resolved)) return { exists: false, files: 0, bytes: 0 };
  const stack = [resolved];
  let files = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(path.join(current, child));
    } else {
      files += 1;
      bytes += stat.size;
    }
  }
  return { exists: true, files, bytes };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function chmodTreeWritable(target) {
  if (!existsSync(target)) return;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    try {
      chmodSync(current, 0o666);
    } catch {}
    try {
      const stat = statSync(current);
      if (stat.isDirectory()) {
        try {
          chmodSync(current, 0o777);
        } catch {}
        for (const child of readdirSync(current)) stack.push(path.join(current, child));
      }
    } catch {}
  }
}

function rmGeneratedPath(entry, attempts = 4) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      chmodTreeWritable(entry.resolved_path);
      rmSync(entry.resolved_path, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return { ok: true, error: null };
    } catch (error) {
      lastError = error;
      sleep(250);
    }
  }
  return {
    ok: false,
    error: {
      code: lastError?.code || null,
      message: lastError?.message || String(lastError),
    },
  };
}

function mb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

function describe(target) {
  if (!isInsideRepo(target.path)) throw new Error(`Refusing cleanup outside repo: ${target.path}`);
  const size = sizeOfPath(target.path);
  return {
    ...target,
    exists: size.exists,
    files: size.files,
    bytes: size.bytes,
    mb: mb(size.bytes),
    resolved_path: path.resolve(repoRoot, target.path),
  };
}

function main() {
  const cleanup = CLEANUP_TARGETS.map(describe).filter((entry) => entry.exists);
  const preserve = PRESERVE_TARGETS.map(describe).filter((entry) => entry.exists);
  const deleted = [];
  const failed = [];
  if (apply) {
    for (const entry of cleanup) {
      const result = rmGeneratedPath(entry);
      if (result.ok) deleted.push(entry.path);
      else failed.push({ path: entry.path, optional: Boolean(entry.optional), ...result.error });
    }
  }
  const hardFailures = failed.filter((entry) => !entry.optional);
  const cleanupBytes = cleanup.reduce((sum, entry) => sum + entry.bytes, 0);
  const report = {
    ok: true,
    schema: "jcc-generated-artifact-cleanup-v1",
    mode: apply ? "apply" : "dry_run",
    repo_root: repoRoot,
    cleanup_candidates: cleanup,
    preserve_by_default: preserve,
    totals: {
      cleanup_files: cleanup.reduce((sum, entry) => sum + entry.files, 0),
      cleanup_bytes: cleanupBytes,
      cleanup_mb: mb(cleanupBytes),
    },
    deleted,
    failed,
    next_step: apply
      ? "Run node tools/audit-jcc-repo-hygiene.mjs and product gate after cleanup. Optional failed items are local locked leftovers; hard failed items need process/OneDrive cleanup."
      : "Review cleanup_candidates, then run with --apply if acceptable.",
    checked: [
      "allowlisted-cleanup-targets-only",
      "repo-boundary-check",
      "dry-run-default",
      "preserve-canonical-runtime-data",
      "preserve-small-history-by-default",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (hardFailures.length) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
