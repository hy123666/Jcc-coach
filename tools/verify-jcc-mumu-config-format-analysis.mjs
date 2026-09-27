import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_OUT = "data/runtime/jcc/mumu-config-format-analysis.json";

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-config-format-analysis.mjs [--out <json>] [--skip-build]",
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

function byId(analysis, id) {
  return analysis.file_summaries.find((entry) => entry.id === id);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.skipBuild) {
    const result = await runNode(["tools/analyze-jcc-mumu-config-formats.mjs", "--out", options.out]);
    if (result.code !== 0) {
      throw new Error(`analyze-jcc-mumu-config-formats failed\n${result.stdout}\n${result.stderr}`);
    }
  }

  const file = path.resolve(options.out);
  const info = await stat(file);
  assert(info.size > 0, "analysis output must not be empty");
  assert(info.size < 2_000_000, "analysis output must remain a small JSON artifact");

  const analysis = await readJson(file);
  assert(analysis.schema_version === 1, "schema_version must be 1");
  assert(analysis.evidence_summary.dex_jcc_strings_observed === true, "DEX must expose JCC strings");
  assert(analysis.evidence_summary.direct_live_board_or_bench_snapshot_observed === false, "must not claim direct live board/bench snapshot");
  assert(analysis.evidence_summary.sqlite_live_board_table_observed === false, "SQLite must not expose live board/bench table");
  assert(analysis.evidence_summary.ocr_packages_jcc_specific_rules_observed === false, "OCR packages must not be treated as JCC rule packs");

  assert(byId(analysis, "classes_dex")?.signature?.dex, "classes.dex signature must be detected");
  assert(byId(analysis, "apk_assets_cfg")?.signature?.x23b, "assets/cfg must be X23B");
  assert(byId(analysis, "apk_assets_lus")?.signature?.x23b, "assets/lus must be X23B");
  assert(byId(analysis, "pulled_data_cfg")?.signature?.x23b, "data/cfg must be X23B");
  assert(byId(analysis, "native_lt_obfuscated")?.signature?.elf, "obfuscated native lib must be ELF");

  const sqlite = analysis.sqlite_private_cache;
  assert(sqlite?.ok === true, "SQLite cache must be read successfully");
  const tables = sqlite.tables.map((table) => table.name);
  for (const table of ["config", "lineup_index", "user_lineup"]) {
    assert(tables.includes(table), `SQLite cache must include ${table}`);
  }

  const contract = analysis.companion_runtime_intake_contract;
  assert(contract.default_storage_policy === "no_frame_or_screenshot_persistence", "companion contract must forbid default frame persistence");
  assert(contract.semantic_transport.runtime_ready_message_types.includes("semantic_observations"), "contract must expose semantic observations");
  assert(contract.match_session.required_fields.includes("match_session_id"), "contract must require match_session_id");
  assert(/drop or quarantine/i.test(contract.match_session.pollution_guard), "contract must include session pollution guard");
  assert(/candidate/i.test(contract.promotion_policy.board_units), "board_units must remain candidate until verified");
  assert(/candidate/i.test(contract.promotion_policy.bench_units), "bench_units must remain candidate until verified");

  assert(analysis.current_claims.can_claim.length > 0, "analysis must include can_claim");
  assert(analysis.current_claims.cannot_claim.some((claim) => /stable external SDK\/API/i.test(claim)), "analysis must include SDK cannot-claim");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "DEX JCC string evidence",
      "X23B container classification",
      "SQLite private cache summary",
      "OCR packages not overclaimed as JCC rules",
      "no screenshot persistence companion contract",
      "match_session pollution guard",
      "candidate-only board/bench promotion",
    ],
    output: file,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
