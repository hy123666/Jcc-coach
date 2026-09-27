import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_OUT_DIR = "data/runtime/jcc";
const REQUIRED_FILES = [
  "mumu-gameassist-runtime-schema.json",
  "mumu-lineup-cache-schema.json",
  "mumu-config-source-map.json",
  "mumu-position-model.json",
];

function usage() {
  return [
    "Usage:",
    "  node tools/verify-jcc-mumu-runtime-model.mjs [--out-dir <dir>] [--skip-build]",
    "",
    "Verifies MuMu gameassist runtime model artifacts remain candidate-only and usable by visual runtime.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUT_DIR, skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
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

function byId(classes, id) {
  return classes.find((model) => model.id === id);
}

function hasParamCount(model, count) {
  return model.constructors.some((ctor) => ctor.parameters.length === count);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.skipBuild) {
    const result = await runNode(["tools/build-jcc-mumu-runtime-model.mjs", "--out-dir", options.outDir]);
    if (result.code !== 0) {
      throw new Error(`build-jcc-mumu-runtime-model failed\n${result.stdout}\n${result.stderr}`);
    }
  }

  const outDir = path.resolve(options.outDir);
  for (const fileName of REQUIRED_FILES) {
    const file = path.join(outDir, fileName);
    const info = await stat(file);
    assert(info.size > 0, `${fileName} must not be empty`);
    assert(info.size < 2_000_000, `${fileName} must remain a small contract artifact`);
  }

  const schema = await readJson(path.join(outDir, "mumu-gameassist-runtime-schema.json"));
  const cache = await readJson(path.join(outDir, "mumu-lineup-cache-schema.json"));
  const config = await readJson(path.join(outDir, "mumu-config-source-map.json"));
  const position = await readJson(path.join(outDir, "mumu-position-model.json"));

  assert(schema.schema_version === 1, "runtime schema_version must be 1");
  assert(schema.product_boundary === "mumu_gameassist_jkchess_apk_private_cache", "schema must stay inside MuMu gameassist boundary");
  assert(schema.direct_live_board_snapshot_status === "not_observed", "schema must not claim direct live board/bench snapshot");
  assert(/Never merge MuMu gameassist candidates/i.test(schema.pollution_guard), "schema must include pollution guard");

  const classes = schema.classes || [];
  for (const id of ["BuyHeroInfo", "WaitHeroInfo", "SellHeroInfo", "GiHeroInfo", "GiWaitHeroList", "PlayerBattleInfo", "XYPosition", "ChessPositionApi", "PositionApiData", "LineupDetailData"]) {
    const model = byId(classes, id);
    assert(model?.observed, `${id} must be observed in DEX evidence`);
    assert(/candidate|recommendation|position|payload/i.test(model.role), `${id} must have a runtime role`);
    assert(/candidate_only/i.test(model.promotion_rule), `${id} must not auto-promote to live_state`);
  }

  assert(hasParamCount(byId(classes, "BuyHeroInfo"), 2), "BuyHeroInfo should expose a 2-param constructor-like signature");
  assert(hasParamCount(byId(classes, "WaitHeroInfo"), 3), "WaitHeroInfo should expose a 3-param constructor-like signature");
  assert(hasParamCount(byId(classes, "GiHeroInfo"), 3), "GiHeroInfo should expose a 3-param constructor-like signature");
  assert(byId(classes, "PlayerBattleInfo").constructors.some((ctor) => ctor.parameters.some((param) => param.type === "list")), "PlayerBattleInfo should expose list-like parameters");

  const ocrEvidence = schema.ocr_and_capture_evidence || [];
  assert(ocrEvidence.some((value) => /OcrResult/i.test(value)), "OCR evidence must include OcrResult");
  assert(ocrEvidence.some((value) => /captureDisplay|takeScreenShot|screenShot/i.test(value)), "OCR evidence must include capture/screenshot boundary");
  assert(ocrEvidence.some((value) => /ch_PP-OCR|RapidOcr/i.test(value)), "OCR evidence must include OCR model/runtime boundary");

  const tables = cache.private_cache?.tables || [];
  assert(cache.private_cache?.sqlite_engine_status === "python_sqlite3_read_only", "cache schema must include read-only SQLite summary");
  assert(cache.private_cache?.row_sample_status === "read_only_samples_observed", "cache schema must include read-only row samples");
  assert(tables.includes("user_lineup"), "cache schema must include user_lineup");
  assert(tables.includes("lineup_index"), "cache schema must include lineup_index");
  assert(tables.includes("config"), "cache schema must include config");
  assert(cache.private_cache?.has_live_board_table === false, "private cache must not expose live board table");
  assert(/do not use MuMu lineup_index/i.test(cache.runtime_use?.lineup_cache || ""), "MuMu lineup cache must be schema evidence only");
  assert(/hard-data.*live rankings.*formulas.*AI-native/i.test(cache.runtime_use?.strategy_source || ""), "strategy source must remain project hard-data/live-rankings/formulas/AI-native");
  assert(cache.private_cache?.sqlite_summaries?.some((db) => db.ok && db.table_samples?.user_lineup), "SQLite summary must include user_lineup sample metadata");
  assert(cache.private_cache?.sqlite_summaries?.some((db) => db.ok && db.table_samples?.lineup_index), "SQLite summary must include lineup_index sample metadata");
  assert(cache.private_cache?.sqlite_summaries?.some((db) => db.ok && db.table_samples?.config), "SQLite summary must include config sample metadata");
  assert(cache.binary_configs?.apk_assets_cfg?.signature?.x23b, "apk assets/cfg should be classified as X23B");
  assert(cache.binary_configs?.apk_assets_lus?.signature?.x23b, "apk assets/lus should be classified as X23B");

  assert(Array.isArray(config.data_models) && config.data_models.length >= 10, "config map must expose observed data models");
  assert(config.recommended_pipeline?.some((step) => /never through MuMu lineup_index/i.test(step)), "config map must forbid MuMu lineup_index as strategy source");
  assert(config.recommended_pipeline?.some((step) => /Promote to board_units\/bench_units only/i.test(step)), "config map must preserve promotion guard");

  assert(position.status === "position_model_structures_observed", "position model structures must be observed");
  assert(/Do not infer left-to-right bench slot/i.test(position.coordinate_semantics?.bench_axis || ""), "bench coordinate warning must be explicit");
  assert(/verified action reducer/i.test(position.promotion_guard || ""), "position model must require verified reducer or frame evidence");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "MuMu data/API/OCR class structures",
      "constructor-like DEX signatures",
      "private cache table schemas",
      "read-only SQLite row samples",
      "MuMu lineup cache excluded from strategy source",
      "X23B config classification",
      "candidate-only live_state promotion guard",
      "position model coordinate warning",
    ],
    observed_classes: classes.filter((model) => model.observed).length,
    json_adapters: classes.filter((model) => model.json_adapter_observed).length,
    private_tables: tables,
    ocr_evidence_count: ocrEvidence.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
