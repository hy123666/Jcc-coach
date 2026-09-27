import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegisteredRetiredSeason } from "./archive-jcc-season.mjs";
import { inspectWriterLeaseOwner } from "../ui/electron/runtime-writer-lease.js";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repoRoot = path.resolve(readArg("--repo-root", defaultRepoRoot));
const runtimeDataRoot = path.resolve(readArg("--runtime-data-root", path.join(repoRoot, ".jcc-runtime-data")));
const omxRoot = path.resolve(readArg("--omx-root", path.join(repoRoot, ".omx")));
const apply = process.argv.includes("--apply");
const retiredVersion = process.argv.includes("--retired-version");
const seasonId = readArg("--season-id");

function assertNoActiveWriter() {
  const leaseFile = path.join(runtimeDataRoot, "runtime-daemon", "writer-lease.json");
  if (!existsSync(leaseFile)) return;
  let lease = null;
  try {
    lease = JSON.parse(readFileSync(leaseFile, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Refusing cleanup because the writer lease is unreadable: ${leaseFile}`);
  }
  const ownerStatus = inspectWriterLeaseOwner(lease);
  if (ownerStatus.status === "active") {
    throw new Error(`Refusing cleanup while JCC Runtime writer PID ${lease.pid} is active. Stop JCC Runtime first.`);
  }
  if (ownerStatus.status === "unverifiable") {
    throw new Error(`Refusing cleanup because JCC Runtime writer PID ${lease?.pid ?? "unknown"} cannot be verified safely.`);
  }
}

function assertContained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing ${label} cleanup outside ${resolvedRoot}: ${resolved}`);
  }
  return resolved;
}

function bytesOf(target) {
  if (!existsSync(target)) return 0;
  const stack = [target];
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(path.join(current, child));
    } else {
      bytes += stat.size;
    }
  }
  return bytes;
}

function validateDbResetReceipt(retiredSeason) {
  const receiptFile = path.join(runtimeDataRoot, "maintenance", "retired-version-db-reset-receipt.json");
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptFile, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Refusing retired-version artifact prune because the DB reset receipt is missing or unreadable: ${receiptFile}`, { cause: error });
  }
  if (
    receipt?.schema !== "jcc-retired-version-db-reset-receipt-v1"
    || receipt.season_id !== retiredSeason.season_id
    || receipt.archive_relative_path !== retiredSeason.archive_relative_path
    || receipt.archive_manifest_sha256 !== retiredSeason.archive_manifest_sha256
    || receipt.final_core_profile_id !== retiredSeason.final_core_profile_id
    || path.resolve(receipt.sqlite_file || "") !== path.resolve(runtimeDataRoot, "app.sqlite")
  ) {
    throw new Error(`Refusing retired-version artifact prune because the DB reset receipt does not match archived season ${retiredSeason.season_id}`);
  }
  return { receipt, receiptFile };
}

const runtimeTargets = [
  "manual-tests",
  "verification",
  "ui-verification",
  "tmp",
  "daily-intelligence",
  "tmp-verify-context-pack",
  "tmp-verify-context-pack-augment",
  "verify-context-pack",
].map((entry) => path.join(runtimeDataRoot, entry));

runtimeTargets.push(
  path.join(runtimeDataRoot, "state", "jcc-datatft-source-health.json"),
  path.join(runtimeDataRoot, "state", "jcc-daily-intelligence-generation-leases.json"),
);

if (existsSync(runtimeDataRoot)) {
  runtimeTargets.push(...readdirSync(runtimeDataRoot, { withFileTypes: true })
    .filter((entry) => (
      (entry.isDirectory() && /^s\d+-mumu-id-validation-/i.test(entry.name))
      || (entry.isFile() && /^mumu-gameassist-.*\.apk$/i.test(entry.name))
    ))
    .map((entry) => path.join(runtimeDataRoot, entry.name)));
}

const runtimeEvidenceRoot = path.join(runtimeDataRoot, "runtime-evidence");
if (retiredVersion) {
  runtimeTargets.push(
    runtimeEvidenceRoot,
    path.join(runtimeDataRoot, "roi-calibration"),
    path.join(runtimeDataRoot, "candidates"),
    path.join(runtimeDataRoot, "runtime-daemon"),
    path.join(runtimeDataRoot, "logs"),
    path.join(runtimeDataRoot, "launch-logs"),
    path.join(runtimeDataRoot, "host-cli", "codex-home", "runs"),
    path.join(runtimeDataRoot, "host-cli", "codex-home", "tmp"),
    path.join(runtimeDataRoot, "last-adb-discovery.txt"),
    path.join(runtimeDataRoot, "verify-jcc-full-player-journey-sim.progress.log"),
    path.join(runtimeDataRoot, "state", "jcc-current-match-session.json"),
    path.join(runtimeDataRoot, "state", "jcc-mumu-runtime-service.json"),
    path.join(runtimeDataRoot, "state", "jcc-runtime-match-context.json"),
    path.join(runtimeDataRoot, "state", "jcc-ui-runtime-state.json"),
  );
} else if (existsSync(runtimeEvidenceRoot)) {
  runtimeTargets.push(...readdirSync(runtimeEvidenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^live-replay-/i.test(entry.name))
    .map((entry) => path.join(runtimeEvidenceRoot, entry.name)));
}

const omxTargets = retiredVersion ? [
  path.join(omxRoot, "runtime-evidence"),
  path.join(omxRoot, "logs"),
  path.join(omxRoot, "reports"),
  path.join(omxRoot, "reviews"),
  path.join(omxRoot, "npm-cache"),
  path.join(omxRoot, "tmp-codex-app-server-schema"),
  path.join(omxRoot, "tmp-jcc-trace-verify.mjs"),
  path.join(omxRoot, "state", "jcc-cruise-advice-lifecycle.json"),
  path.join(omxRoot, "state", "jcc-current-match-session.json"),
  path.join(omxRoot, "state", "jcc-mumu-runtime-service.json"),
  path.join(omxRoot, "state", "jcc-prep-groundtruth-recorder.json"),
  path.join(omxRoot, "state", "jcc-runtime-match-context.json"),
  path.join(omxRoot, "state", "jcc-ui-runtime-state.json"),
] : [];

const omxStateRoot = path.join(omxRoot, "state");
if (retiredVersion && existsSync(omxStateRoot)) {
  omxTargets.push(...readdirSync(omxStateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^jcc-.*\.tmp$/i.test(entry.name))
    .map((entry) => path.join(omxStateRoot, entry.name)));
}

let retiredSeason = null;
let dbResetReceipt = null;
if (retiredVersion) {
  retiredSeason = await validateRegisteredRetiredSeason({ repoRoot, seasonId });
  dbResetReceipt = validateDbResetReceipt(retiredSeason);
  assertNoActiveWriter();
}

const targets = [
  ...runtimeTargets.map((target) => assertContained(runtimeDataRoot, target, "runtime artifact")),
  ...omxTargets.map((target) => assertContained(omxRoot, target, "OMX artifact")),
].filter((target, index, values) => values.indexOf(target) === index && existsSync(target));

const candidates = targets.map((target) => ({
  path: path.relative(repoRoot, target).replaceAll("\\", "/"),
  bytes: bytesOf(target),
}));
const deleted = [];
if (apply) {
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    deleted.push(path.relative(repoRoot, target).replaceAll("\\", "/"));
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: "jcc-runtime-local-artifact-prune-v2",
  mode: apply ? "apply" : "dry_run",
  retired_version_cleanup: retiredVersion,
  retired_season_id: retiredSeason?.season_id ?? null,
  db_reset_receipt_file: dbResetReceipt
    ? path.relative(repoRoot, dbResetReceipt.receiptFile).replaceAll("\\", "/")
    : null,
  runtime_data_root: runtimeDataRoot,
  omx_root: omxRoot,
  candidates: candidates.map((entry) => entry.path),
  candidate_bytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
  deleted,
  preserved: [
    path.relative(repoRoot, path.join(runtimeDataRoot, "app.sqlite")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(runtimeDataRoot, "maintenance", "retired-version-db-reset-receipt.json")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(runtimeDataRoot, "state", "jcc-runtime-user-settings.json")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(runtimeDataRoot, "state", "jcc-runtime-user-memory.json")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(runtimeDataRoot, "host-cli", "codex-home", "sessions")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(omxRoot, "state")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(omxRoot, "plans")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(omxRoot, "archive")).replaceAll("\\", "/"),
    path.relative(repoRoot, path.join(omxRoot, "third_party")).replaceAll("\\", "/"),
  ],
}, null, 2)}\n`);
