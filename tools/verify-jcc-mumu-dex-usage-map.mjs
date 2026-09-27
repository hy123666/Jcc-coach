import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_OUT = "data/runtime/jcc/mumu-dex-usage-map.json";

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-dex-usage-map.mjs [--out <json>] [--skip-build]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--skip-build") options.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.skipBuild) {
    const result = await runNode(["tools/analyze-jcc-mumu-dex-usage.mjs", "--out", options.out]);
    if (result.code !== 0) {
      throw new Error(`analyze-jcc-mumu-dex-usage failed\n${result.stdout}\n${result.stderr}`);
    }
  }

  const file = path.resolve(options.out);
  const info = await stat(file);
  assert(info.size > 0, "DEX usage map must not be empty");
  assert(info.size < 2_000_000, "DEX usage map must remain small");
  const map = await readJson(file);
  assert(map.schema_version === 1, "schema_version must be 1");
  assert(map.counts.methods > 1000, "method table should be parsed");
  assert(map.counts.encoded_methods > 1000, "encoded methods should be parsed");
  assert(map.evidence_summary.method_level_ocr_usage_observed === true, "OCR usage must be observed");
  assert(map.evidence_summary.method_level_jcc_candidate_model_usage_observed === true, "JCC candidate model usage must be observed");
  assert(map.evidence_summary.method_level_position_model_usage_observed === true, "position model usage must be observed");
  assert(map.evidence_summary.direct_live_board_or_bench_snapshot_method_observed === false, "must not claim direct board/bench snapshot method");
  assert(Array.isArray(map.target_methods_by_tag.ocr_loop) && map.target_methods_by_tag.ocr_loop.length > 0, "ocr_loop tag must have methods");
  assert(Array.isArray(map.target_methods_by_tag.jcc_live_candidate_model) && map.target_methods_by_tag.jcc_live_candidate_model.length > 0, "jcc candidate tag must have methods");
  assert(map.current_claims.cannot_claim.some((claim) => /direct board_units\/bench_units/i.test(claim)), "must include direct snapshot cannot-claim");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "DEX method table parse",
      "encoded method/code scan",
      "OCR method-level usage",
      "JCC candidate model method-level usage",
      "position model method-level usage",
      "no direct board/bench snapshot overclaim",
    ],
    output: file,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
