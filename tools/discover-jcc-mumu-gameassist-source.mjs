import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTRACT_PATH = "data/runtime/jcc/mumu-gameassist-source-contract.json";
const DEFAULT_ROOT = ".omx/runtime-evidence/mumu-gameassist-jkchess";
const DEFAULT_OUT_DIR = ".omx/runtime-evidence/jcc-mumu-gameassist-source";

function usage() {
  return [
    "Usage:",
    "  node tools/discover-jcc-mumu-gameassist-source.mjs [--root <mumu evidence root>] [--out-dir <dir>]",
    "",
    "Scans MuMu's JCC gameassist APK/private-cache evidence for reusable source boundaries.",
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
    .map((value) => value.slice(0, 240)))
    .slice(0, limit);
}

async function scanStrings(file) {
  if (!(await exists(file))) return [];
  return asciiStrings(await readFile(file));
}

function classifyBlob(buffer) {
  const firstBytes = buffer.subarray(0, 32);
  return {
    size_bytes: buffer.length,
    first_bytes_hex: firstBytes.toString("hex"),
    signature: {
      gzip: buffer[0] === 0x1f && buffer[1] === 0x8b,
      zip: buffer[0] === 0x50 && buffer[1] === 0x4b,
      sqlite: buffer.subarray(0, 16).toString("latin1") === "SQLite format 3\0",
      x23b: buffer.subarray(0, 5).toString("latin1") === "<X23B",
    },
  };
}

async function scanPrivateDatabase(root) {
  const dbDir = path.join(root, "data", "databases");
  const files = await walk(dbDir);
  const allLines = [];
  for (const file of files) {
    const strings = await scanStrings(file);
    allLines.push(...sampleMatching(strings, [
      /CREATE TABLE/i,
      /CREATE INDEX/i,
      /user_lineup/i,
      /lineup_index/i,
      /SELECT .*user_lineup/i,
      /INSERT .*lineup/i,
      /config/i,
    ], 120));
  }
  const joined = allLines.join("\n");
  return {
    files: files.map((file) => path.relative(root, file).replaceAll("\\", "/")),
    tables: ["user_lineup", "lineup_index", "config"].filter((name) => new RegExp(`\\b${name}\\b`, "i").test(joined)),
    schema_samples: unique(allLines).slice(0, 80),
    has_live_board_table: /\b(board_units|bench_units|live_board|live_bench|current_board)\b/i.test(joined),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });

  const apkRoot = path.join(root, "apk");
  const dexPath = path.join(apkRoot, "classes.dex");
  const dexStrings = await scanStrings(dexPath);
  const apkFiles = await walk(apkRoot);
  const dataFiles = await walk(path.join(root, "data"));

  const structurePatterns = [
    /com\/mumu\/gameassist\/games\/jcc\/data\/(BuyHeroInfo|WaitHeroInfo|SellHeroInfo|GiHeroInfo|GiWaitHeroList|GiHeroList|PlayerBattleInfo|StageData|GiGameStatus)/,
    /com\/mumu\/gameassist\/api\/(ChessPositionApi|XYPosition|LineupDetailData|PositionApiData)/,
  ];
  const ocrPatterns = [
    /com\/benjaminwan\/ocrlibrary\/(OcrResult|TextBlock|OcrEngine|Point)/,
    /RapidOcr|ch_PP-OCR|captureDisplay|screenShot|roundOcrText|Buy hex ocr/i,
  ];
  const apiPatterns = [
    /https:\/\/mumu\.nie\.netease\.com\/api\/toolbox\/item\/config/i,
    /GenericData|GetGenericData|UploadGenericData|LineupDetailRequest|ZmLineupDetailRequest/i,
  ];
  const liveSnapshotPatterns = [
    /\bboard_units\b/i,
    /\bbench_units\b/i,
    /\blive_board\b/i,
    /\blive_bench\b/i,
    /\bcurrent_board\b/i,
    /\bcurrent_bench\b/i,
  ];

  const cfgPath = path.join(apkRoot, "assets", "cfg");
  const lusPath = path.join(apkRoot, "assets", "lus");
  const pulledCfgPath = path.join(root, "data", "cfg");
  const cfgBlobs = {};
  for (const [name, file] of [["apk_assets_cfg", cfgPath], ["apk_assets_lus", lusPath], ["pulled_data_cfg", pulledCfgPath]]) {
    if (await exists(file)) cfgBlobs[name] = classifyBlob(await readFile(file));
  }

  const privateDatabase = await scanPrivateDatabase(root);
  const mumuApiConfigUrls = sampleMatching(dexStrings, [/https:\/\/mumu\.nie\.netease\.com\/api\/toolbox\/item\/config/i], 20);
  const directLiveSnapshotTokens = sampleMatching(dexStrings, liveSnapshotPatterns, 40);
  const observedStructures = sampleMatching(dexStrings, structurePatterns, 120);
  const ocrStructures = sampleMatching(dexStrings, ocrPatterns, 120);
  const apiStructures = sampleMatching(dexStrings, apiPatterns, 120);

  const hasExpectedStructures = contract.expected_apk_structures.every((expected) => (
    dexStrings.some((value) => value.includes(expected))
  ));
  const hasExpectedTables = contract.expected_private_tables.every((expected) => (
    privateDatabase.tables.includes(expected)
  ));
  const hasOcrEvidence = ocrStructures.length > 0;
  const hasDirectLiveSnapshot = directLiveSnapshotTokens.length > 0 || privateDatabase.has_live_board_table;

  const discovery = {
    schema_version: 1,
    product_boundary: contract.product_boundary,
    root,
    source_decision: {
      status: hasExpectedStructures && hasOcrEvidence ? "candidate_source_verified" : "insufficient_evidence",
      live_state_boundary: contract.live_state_boundary,
      pollution_guard: contract.pollution_guard,
      direct_live_board_snapshot_status: hasDirectLiveSnapshot ? "candidate_tokens_need_manual_reverse_engineering" : "not_observed",
    },
    package_evidence: {
      apk_present: await exists(path.join(root, "base.apk")),
      dex_present: await exists(dexPath),
      apk_file_count: apkFiles.length,
      data_file_count: dataFiles.length,
      mumu_api_config_urls: mumuApiConfigUrls,
    },
    dex_evidence: {
      expected_structure_status: hasExpectedStructures ? "observed" : "partial",
      observed_structures: observedStructures,
      ocr_structures: ocrStructures,
      api_structures: apiStructures,
      direct_live_snapshot_tokens: directLiveSnapshotTokens,
    },
    private_cache_evidence: {
      expected_table_status: hasExpectedTables ? "observed" : "partial",
      ...privateDatabase,
    },
    binary_config_evidence: cfgBlobs,
    runtime_use: contract.use_in_runtime,
    forbidden_sources: contract.forbidden_sources,
  };

  const outPath = path.join(outDir, "mumu-gameassist-source-discovery.json");
  await writeFile(outPath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    status: discovery.source_decision.status,
    direct_live_board_snapshot_status: discovery.source_decision.direct_live_board_snapshot_status,
    observed_structure_count: observedStructures.length,
    ocr_structure_count: ocrStructures.length,
    private_tables: privateDatabase.tables,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
