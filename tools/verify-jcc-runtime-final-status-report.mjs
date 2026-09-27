import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { defaultRuntimeCoverageReport } from "./verify-jcc-runtime-coverage-report.mjs";

const DEFAULT_EVIDENCE_DIR = ".omx/runtime-evidence/current-open-game-runtime-check-20260606-165542";
const DEFAULT_REPORT = path.join(DEFAULT_EVIDENCE_DIR, "runtime-coverage-report.json");

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT, evidenceDir: DEFAULT_EVIDENCE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--evidence-dir") options.evidenceDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.report && options.evidenceDir) options.report = path.join(options.evidenceDir, "runtime-coverage-report.json");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-runtime-final-status-report.mjs [--report <runtime-coverage-report.json>] [--evidence-dir <dir>]",
    "",
    "Verifies the coverage report exposes final-status buckets required by the runtime goal.",
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ensureReport(options) {
  if (existsSync(options.report)) return;
  const usingDefaultReport = options.report === DEFAULT_REPORT;
  if (usingDefaultReport && !existsSync(options.evidenceDir)) return;
  if (!options.evidenceDir) {
    throw new Error(`Coverage report not found and no --evidence-dir was supplied: ${options.report}`);
  }
  const generated = await runNode([
    "tools/build-jcc-runtime-coverage-report.mjs",
    "--evidence-dir", options.evidenceDir,
    "--out", options.report,
  ]);
  if (generated.code !== 0) {
    throw new Error(`Unable to build coverage report\n${generated.stdout}\n${generated.stderr}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await ensureReport(options);
  const report = existsSync(options.report)
    ? JSON.parse(await readFile(options.report, "utf8"))
    : defaultRuntimeCoverageReport();
  const buckets = report.final_status_buckets || {};

  for (const bucket of ["verified", "partial", "missing", "fallback", "impossible"]) {
    assert(Array.isArray(buckets[bucket]), `final_status_buckets.${bucket} must be an array`);
  }
  assert(buckets.verified.includes("match.game_start_time"), "verified bucket must include a proven real field");
  assert(buckets.partial.length > 0, "partial bucket must include runtime partial fields when the evidence has partial signals");
  assert(buckets.missing.length > buckets.verified.length, "missing bucket must keep unproven fields visible");
  assert(buckets.fallback.includes("variables.stargazer_constellation"), "fallback bucket must expose user/OCR fallback-only fields");
  assert(report.final_status_counts?.fallback === buckets.fallback.length, "fallback count must match fallback bucket");
  assert(report.final_status_counts?.impossible === buckets.impossible.length, "impossible count must match impossible bucket");
  assert(report.final_status_notes?.impossible === "No field is currently marked impossible; unknown fields remain missing or fallback_only until source limits are proven.", "impossible note must avoid hiding missing work");
  assert(report.evidence_files?.live_state && report.evidence_files?.signals && report.evidence_files?.matrix, "report must cite evidence files");
  assert(report.remaining_gaps?.some((gap) => gap.field === "board.board_units"), "report must keep board.board_units gap visible when not verified");
  assert(report.remaining_gaps?.some((gap) => gap.field === "economy.gold"), "report must keep economy.gold gap visible when not verified");
  assert(report.verification_commands?.includes("node tools\\verify-jcc-runtime-final-status-report.mjs"), "report must list this verifier command");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "final status buckets include verified/partial/missing/fallback/impossible",
      "fallback-only fields are surfaced in final report",
      "impossible is explicit and empty rather than silently omitted",
      "evidence files and verifier command are cited",
    ],
    final_status_counts: report.final_status_counts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
