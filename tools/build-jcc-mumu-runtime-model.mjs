import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const CONTRACT_PATH = "data/runtime/jcc/mumu-gameassist-source-contract.json";
const DEFAULT_ROOT = ".omx/runtime-evidence/mumu-gameassist-jkchess";
const DEFAULT_OUT_DIR = "data/runtime/jcc";

const TARGET_CLASSES = [
  {
    id: "BuyHeroInfo",
    descriptor: "com/mumu/gameassist/games/jcc/data/BuyHeroInfo",
    role: "shop_purchase_candidate",
    live_state_mapping: ["shop_units", "candidate_actions.buy"],
  },
  {
    id: "WaitHeroInfo",
    descriptor: "com/mumu/gameassist/games/jcc/data/WaitHeroInfo",
    role: "bench_wait_candidate",
    live_state_mapping: ["bench_units.candidate_observations"],
  },
  {
    id: "SellHeroInfo",
    descriptor: "com/mumu/gameassist/games/jcc/data/SellHeroInfo",
    role: "sell_action_candidate",
    live_state_mapping: ["candidate_actions.sell"],
  },
  {
    id: "GiHeroInfo",
    descriptor: "com/mumu/gameassist/games/jcc/data/GiHeroInfo",
    role: "board_or_visible_hero_candidate",
    live_state_mapping: ["board_units.candidate_observations"],
  },
  {
    id: "GiHeroList",
    descriptor: "com/mumu/gameassist/games/jcc/data/GiHeroList",
    role: "visible_hero_list_candidate",
    live_state_mapping: ["board_units.candidate_observations"],
  },
  {
    id: "GiWaitHeroList",
    descriptor: "com/mumu/gameassist/games/jcc/data/GiWaitHeroList",
    role: "bench_wait_list_candidate",
    live_state_mapping: ["bench_units.candidate_observations"],
  },
  {
    id: "PlayerBattleInfo",
    descriptor: "com/mumu/gameassist/games/jcc/data/PlayerBattleInfo",
    role: "player_battle_context_candidate",
    live_state_mapping: ["players.candidate_observations", "opponents.candidate_observations"],
  },
  {
    id: "PlayerBattleInfoList",
    descriptor: "com/mumu/gameassist/games/jcc/data/PlayerBattleInfoList",
    role: "player_battle_context_list_candidate",
    live_state_mapping: ["players.candidate_observations", "opponents.candidate_observations"],
  },
  {
    id: "GiGameStatus",
    descriptor: "com/mumu/gameassist/games/jcc/data/GiGameStatus",
    role: "game_status_candidate",
    live_state_mapping: ["phase", "round", "stage"],
  },
  {
    id: "StageData",
    descriptor: "com/mumu/gameassist/games/jcc/data/StageData",
    role: "mumu_recommendation_stage_payload_schema_evidence_only",
    live_state_mapping: ["mumu_reference.recommendation_payload.stage"],
  },
  {
    id: "StageRecommendData",
    descriptor: "com/mumu/gameassist/games/jcc/data/StageRecommendData",
    role: "mumu_recommendation_stage_payload_schema_evidence_only",
    live_state_mapping: ["mumu_reference.recommendation_payload.stage"],
  },
  {
    id: "XYPosition",
    descriptor: "com/mumu/gameassist/api/XYPosition",
    role: "screen_or_board_xy_position",
    live_state_mapping: ["position.candidate_xy"],
  },
  {
    id: "ChessPositionApi",
    descriptor: "com/mumu/gameassist/api/ChessPositionApi",
    role: "chess_position_api_model",
    live_state_mapping: ["position.candidate_grid"],
  },
  {
    id: "PositionApiData",
    descriptor: "com/mumu/gameassist/api/PositionApiData",
    role: "position_payload_wrapper",
    live_state_mapping: ["position.candidate_grid"],
  },
  {
    id: "LineupDetailData",
    descriptor: "com/mumu/gameassist/api/LineupDetailData",
    role: "mumu_lineup_payload_schema_evidence_only",
    live_state_mapping: ["mumu_reference.lineup_payload"],
  },
  {
    id: "OuterPositionApiData",
    descriptor: "com/mumu/gameassist/api/OuterPositionApiData",
    role: "outer_position_payload",
    live_state_mapping: ["mumu_reference.positioning_payload"],
  },
  {
    id: "ChosenApiData",
    descriptor: "com/mumu/gameassist/api/ChosenApiData",
    role: "augment_or_chosen_payload",
    live_state_mapping: ["augments.candidate_observations", "mumu_reference.augment_payload"],
  },
  {
    id: "SecretskillApiData",
    descriptor: "com/mumu/gameassist/api/SecretskillApiData",
    role: "secret_skill_or_augment_payload",
    live_state_mapping: ["augments.candidate_observations", "mumu_reference.augment_payload"],
  },
  {
    id: "LineupApiData",
    descriptor: "com/mumu/gameassist/api/LineupApiData",
    role: "mumu_lineup_api_payload_schema_evidence_only",
    live_state_mapping: ["mumu_reference.lineup_payload"],
  },
];

const OCR_PATTERNS = [
  /com\/benjaminwan\/ocrlibrary\/(OcrResult|TextBlock|OcrEngine|Point)/,
  /RapidOcr/i,
  /ch_PP-OCR/i,
  /captureDisplay/i,
  /takeScreenShot/i,
  /screenShot/i,
  /roundOcrText/i,
  /Buy hex ocr/i,
];

function usage() {
  return [
    "Usage:",
    "  node tools/build-jcc-mumu-runtime-model.mjs [--root <mumu evidence root>] [--out-dir <dir>]",
    "",
    "Builds small runtime-facing MuMu gameassist schema/cache/position artifacts.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, files = []) {
  if (!(await exists(dir))) return files;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, files);
    else files.push(file);
  }
  return files;
}

function asciiStrings(buffer) {
  const strings = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) current += String.fromCharCode(byte);
    else {
      if (current.length >= 4) strings.push(current);
      current = "";
    }
  }
  if (current.length >= 4) strings.push(current);
  return strings;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sampleMatching(strings, patterns, limit = 80) {
  return unique(strings
    .filter((value) => patterns.some((pattern) => pattern.test(value)))
    .map((value) => value.slice(0, 260)))
    .slice(0, limit);
}

function descriptorToType(descriptor) {
  if (descriptor === "I") return "int";
  if (descriptor === "J") return "long";
  if (descriptor === "D") return "double";
  if (descriptor === "F") return "float";
  if (descriptor === "Z") return "boolean";
  if (descriptor === "B") return "byte";
  if (descriptor === "S") return "short";
  if (descriptor === "C") return "char";
  if (descriptor.startsWith("[")) return `${descriptorToType(descriptor.slice(1))}[]`;
  if (descriptor === "Ljava/lang/String;") return "string";
  if (descriptor === "Ljava/util/List;") return "list";
  if (descriptor === "Ljava/util/Map;") return "map";
  if (descriptor === "Ljava/util/HashMap;") return "hashmap";
  if (descriptor.startsWith("L") && descriptor.endsWith(";")) return descriptor.slice(1, -1).replaceAll("/", ".");
  return descriptor;
}

function parseDescriptorParameters(signature) {
  const start = signature.indexOf("(");
  const end = signature.indexOf(")");
  if (start === -1 || end === -1 || end < start) return [];
  const raw = signature.slice(start + 1, end);
  const descriptors = [];
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if ("IJDFZBSC".includes(char)) {
      descriptors.push(char);
      index += 1;
    } else if (char === "[") {
      let cursor = index + 1;
      while (raw[cursor] === "[") cursor += 1;
      if (raw[cursor] === "L") {
        const semicolon = raw.indexOf(";", cursor);
        descriptors.push(raw.slice(index, semicolon + 1));
        index = semicolon + 1;
      } else {
        descriptors.push(raw.slice(index, cursor + 1));
        index = cursor + 1;
      }
    } else if (char === "L") {
      const semicolon = raw.indexOf(";", index);
      descriptors.push(raw.slice(index, semicolon + 1));
      index = semicolon + 1;
    } else {
      descriptors.push(char);
      index += 1;
    }
  }
  return descriptors.map((descriptor) => ({
    descriptor,
    type: descriptorToType(descriptor),
  }));
}

function extractConstructorSignatures(strings, classDescriptor) {
  const escaped = classDescriptor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\([^)]*\\)L${escaped};`);
  return unique(strings.filter((value) => pattern.test(value)).map((value) => value.match(pattern)?.[0])).slice(0, 20);
}

function extractClassModel(strings) {
  return TARGET_CLASSES.map((target) => {
    const classDescriptor = `L${target.descriptor};`;
    const observed = strings.some((value) => value.includes(target.descriptor) || value.includes(classDescriptor));
    const jsonAdapterObserved = strings.some((value) => (
      value.includes(`${target.descriptor}JsonAdapter`) || value.includes(`${target.id}JsonAdapter`)
    ));
    const constructors = extractConstructorSignatures(strings, target.descriptor).map((signature) => ({
      signature,
      parameters: parseDescriptorParameters(signature),
    }));
    return {
      id: target.id,
      descriptor: target.descriptor,
      observed,
      json_adapter_observed: jsonAdapterObserved,
      role: target.role,
      live_state_mapping: target.live_state_mapping,
      constructors,
      field_name_status: constructors.length > 0 || jsonAdapterObserved ? "structure_observed_field_names_obfuscated" : "not_observed",
      promotion_rule: "candidate_only_until_screen_roi_or_runtime_local_player_binding_confirms identity and position",
    };
  });
}

function classifyBlob(buffer) {
  const signature = {
    gzip: buffer[0] === 0x1f && buffer[1] === 0x8b,
    zip: buffer[0] === 0x50 && buffer[1] === 0x4b,
    sqlite: buffer.subarray(0, 16).toString("latin1") === "SQLite format 3\0",
    x23b: buffer.subarray(0, 5).toString("latin1") === "<X23B",
  };
  return {
    size_bytes: buffer.length,
    first_bytes_hex: buffer.subarray(0, 32).toString("hex"),
    signature,
    decode_status: signature.x23b
      ? "x23b_container_observed_not_decoded"
      : signature.gzip || signature.zip || signature.sqlite
        ? "standard_container_signature_observed"
        : "opaque_binary",
  };
}

function extractSqlSchemas(strings) {
  return unique(strings.filter((value) => /CREATE (TABLE|INDEX)|user_lineup|lineup_index|PRIMARY KEY|lineupJson/i.test(value)))
    .map((value) => value.slice(0, 600))
    .slice(0, 80);
}

async function scanPrivateCache(root) {
  const dbDir = path.join(root, "data", "databases");
  const files = await walk(dbDir);
  const fileSummaries = [];
  const allStrings = [];
  for (const file of files) {
    const buffer = await readFile(file);
    const strings = asciiStrings(buffer);
    allStrings.push(...strings);
    fileSummaries.push({
      path: path.relative(root, file).replaceAll("\\", "/"),
      size_bytes: buffer.length,
      signature: classifyBlob(buffer).signature,
      schema_samples: extractSqlSchemas(strings).slice(0, 20),
    });
  }
  const joined = allStrings.join("\n");
  const sqliteSummary = await summarizeSqliteDatabases(files);
  return {
    status: files.length > 0 ? "observed" : "not_observed",
    sqlite_engine_status: sqliteSummary.status,
    tables: ["user_lineup", "lineup_index", "config"].filter((name) => new RegExp(`\\b${name}\\b`, "i").test(joined)),
    schema_samples: extractSqlSchemas(allStrings),
    has_live_board_table: /\b(board_units|bench_units|live_board|live_bench|current_board|current_bench)\b/i.test(joined),
    file_summaries: fileSummaries,
    sqlite_summaries: sqliteSummary.databases,
    row_sample_status: sqliteSummary.databases.some((db) => db.ok && Object.keys(db.table_samples || {}).length > 0)
      ? "read_only_samples_observed"
      : "not_read",
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs || 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function summarizeSqliteDatabases(files) {
  const sqliteFiles = [];
  for (const file of files) {
    const buffer = await readFile(file);
    if (buffer.subarray(0, 16).toString("latin1") === "SQLite format 3\0") sqliteFiles.push(file);
  }
  if (sqliteFiles.length === 0) return { status: "no_sqlite_database_files", databases: [] };

  const script = String.raw`
import json
import sqlite3
import sys

def cap(value):
    if isinstance(value, bytes):
        return {"type": "bytes", "size": len(value), "prefix_hex": value[:32].hex()}
    if isinstance(value, str):
        return value[:800]
    return value

db_path = sys.argv[1]
out = {"path": db_path, "ok": False, "tables": [], "table_samples": {}, "error": None}
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    tables = conn.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    out["tables"] = [{"name": row["name"], "sql": cap(row["sql"] or "")} for row in tables]
    target_names = [row["name"] for row in tables if row["name"] in ("user_lineup", "lineup_index", "config")]
    for table in target_names:
        cols = [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        count = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
        rows = conn.execute(f"SELECT * FROM {table} LIMIT 3").fetchall()
        out["table_samples"][table] = {
            "columns": cols,
            "row_count": count,
            "rows": [{key: cap(row[key]) for key in row.keys()} for row in rows],
        }
    out["ok"] = True
except Exception as exc:
    out["error"] = str(exc)
print(json.dumps(out, ensure_ascii=False))
`;

  const databases = [];
  for (const file of sqliteFiles) {
    const result = await run("py", ["-3", "-c", script, file], { timeoutMs: 10_000 });
    if (result.code === 0) {
      try {
        databases.push(JSON.parse(result.stdout.trim()));
      } catch {
        databases.push({ path: file, ok: false, error: "python_sqlite_json_parse_failed", stderr: result.stderr.trim() });
      }
    } else {
      databases.push({ path: file, ok: false, error: "python_sqlite_read_failed", stderr: result.stderr.trim().slice(0, 800) });
    }
  }
  return {
    status: databases.some((db) => db.ok) ? "python_sqlite3_read_only" : "python_sqlite3_unavailable_or_failed",
    databases,
  };
}

async function scanBinaryConfigs(root) {
  const apkRoot = path.join(root, "apk");
  const files = [
    ["apk_assets_cfg", path.join(apkRoot, "assets", "cfg")],
    ["apk_assets_lus", path.join(apkRoot, "assets", "lus")],
    ["pulled_data_cfg", path.join(root, "data", "cfg")],
  ];
  const out = {};
  for (const [id, file] of files) {
    if (await exists(file)) out[id] = classifyBlob(await readFile(file));
  }
  return out;
}

function buildPositionModel(classModels, ocrEvidence) {
  const observedIds = new Set(classModels.filter((model) => model.observed).map((model) => model.id));
  return {
    schema_version: 1,
    source: "mumu_gameassist_jkchess_apk",
    status: observedIds.has("XYPosition") && observedIds.has("ChessPositionApi") && observedIds.has("PositionApiData")
      ? "position_model_structures_observed"
      : "partial",
    observed_structures: ["XYPosition", "ChessPositionApi", "PositionApiData", "OuterPositionApiData"].filter((id) => observedIds.has(id)),
    coordinate_semantics: {
      xy_position: "MuMu API class boundary observed. Exact screen-to-grid transform must be calibrated against visual ROI.",
      chess_position_api: "Likely wraps logical chess position and XYPosition. Field names remain obfuscated in retained DEX evidence.",
      bench_axis: "Do not infer left-to-right bench slot from raw x alone without visual calibration; previous y=-1/x=4 samples are action-log coordinates, not proven UI slot numbers.",
      board_axis: "Board grid must be emitted only after ROI detection or runtime-local binding verifies the unit is on local board.",
    },
    expected_runtime_adapter_shape: {
      board_units: "array of {unit_id, name?, star?, items?, position:{source:'visual_roi'|'mumu_candidate', row?, col?, x?, y?, confidence}}",
      bench_units: "array of {unit_id, name?, slot?, position:{source:'visual_roi'|'mumu_candidate', x?, y?, confidence}}",
      candidate_actions: "array of {kind:'buy'|'sell'|'move', from?, to?, observed_at, evidence_source}",
    },
    ocr_capture_evidence_count: ocrEvidence.length,
    promotion_guard: "MuMu position candidates can seed ROI and parser names, but final board_units/bench_units require current-frame visual evidence or a verified action reducer scoped to the current match.",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  const dexPath = path.join(root, "apk", "classes.dex");
  if (!(await exists(dexPath))) throw new Error(`classes.dex not found: ${dexPath}`);

  await mkdir(outDir, { recursive: true });
  const dexStrings = asciiStrings(await readFile(dexPath));
  const classModels = extractClassModel(dexStrings);
  const ocrEvidence = sampleMatching(dexStrings, OCR_PATTERNS, 140);
  const apiEvidence = sampleMatching(dexStrings, [
    /https:\/\/mumu\.nie\.netease\.com\/api\/toolbox\/item\/config/i,
    /LineupDetailRequest|ZmLineupDetailRequest|GenericData|GetGenericData/i,
  ], 80);
  const directLiveSnapshotTokens = sampleMatching(dexStrings, [
    /\bboard_units\b/i,
    /\bbench_units\b/i,
    /\blive_board\b/i,
    /\blive_bench\b/i,
    /\bcurrent_board\b/i,
    /\bcurrent_bench\b/i,
  ], 40);

  const privateCache = await scanPrivateCache(root);
  const binaryConfigs = await scanBinaryConfigs(root);
  const positionModel = buildPositionModel(classModels, ocrEvidence);

  const schema = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    product_boundary: contract.product_boundary,
    package_name: contract.observed_package.package_name,
    source_root: root,
    live_state_boundary: contract.live_state_boundary,
    pollution_guard: contract.pollution_guard,
    direct_live_board_snapshot_status: directLiveSnapshotTokens.length > 0 || privateCache.has_live_board_table
      ? "candidate_tokens_need_manual_reverse_engineering"
      : "not_observed",
    classes: classModels,
    ocr_and_capture_evidence: ocrEvidence,
    api_evidence: apiEvidence,
    direct_live_snapshot_tokens: directLiveSnapshotTokens,
    runtime_use: {
      can_use_now: [
      "class names and roles as parser/schema vocabulary",
      "OCR/capture evidence as confirmation that MuMu uses a visual pipeline",
      "lineup/private-cache schema as reverse-engineering evidence only",
      "position classes as coordinate-model hints for ROI calibration",
      ],
      cannot_claim_yet: [
        "direct SDK call returning current local board_units",
        "direct SDK call returning current local bench_units",
        "raw action-log coordinate equals UI slot without calibration",
      ],
    },
  };

  const cacheSchema = {
    schema_version: 1,
    generated_at: schema.generated_at,
    product_boundary: contract.product_boundary,
    private_cache: privateCache,
    binary_configs: binaryConfigs,
    runtime_use: {
      lineup_cache: "schema_evidence_only; do not use MuMu lineup_index/user_lineup as project strategy source",
      strategy_source: "do_not_use; runtime strategy must use project hard-data, live rankings, formulas, and AI-native route evaluators",
      x23b_configs: "observed but not decoded; do not block visual runtime on this",
      live_state: privateCache.has_live_board_table ? "candidate_needs_manual_reverse_engineering" : "not_present_in_observed_cache",
    },
  };

  const configMap = {
    schema_version: 1,
    generated_at: schema.generated_at,
    endpoints: apiEvidence.filter((value) => value.startsWith("https://")),
    data_models: classModels
      .filter((model) => model.observed)
      .map((model) => ({
        id: model.id,
        descriptor: model.descriptor,
        role: model.role,
        live_state_mapping: model.live_state_mapping,
        promotion_rule: model.promotion_rule,
      })),
    recommended_pipeline: [
      "Use ADB/MediaProjection frame capture for current visible state.",
      "Use MuMu class names to normalize OCR/ROI outputs into BuyHeroInfo/WaitHeroInfo/GiHeroInfo/SellHeroInfo-shaped candidates.",
      "Resolve hero identity against local JCC hard-data catalog.",
      "Run strategy/recommendation through project hard-data, live-ranking signals, formulas, and AI-native route evaluators; never through MuMu lineup_index.",
      "Promote to board_units/bench_units only after current-frame evidence or current-match action reducer verifies local-player scope.",
    ],
  };

  const outputs = [
    ["mumu-gameassist-runtime-schema.json", schema],
    ["mumu-lineup-cache-schema.json", cacheSchema],
    ["mumu-config-source-map.json", configMap],
    ["mumu-position-model.json", positionModel],
  ];
  for (const [fileName, data] of outputs) {
    await writeFile(path.join(outDir, fileName), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    ok: true,
    out_dir: outDir,
    files: outputs.map(([fileName]) => path.join(outDir, fileName)),
    observed_classes: classModels.filter((model) => model.observed).length,
    json_adapters: classModels.filter((model) => model.json_adapter_observed).length,
    ocr_evidence_count: ocrEvidence.length,
    private_tables: privateCache.tables,
    direct_live_board_snapshot_status: schema.direct_live_board_snapshot_status,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
