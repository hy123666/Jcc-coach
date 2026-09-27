import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

const DEFAULT_ROOT = ".omx/runtime-evidence/mumu-gameassist-jkchess";
const DEFAULT_PACKAGE_ROOT = ".omx/runtime-evidence/mumu-config-packages";
const DEFAULT_OUT = "data/runtime/jcc/mumu-config-format-analysis.json";

const JCC_PATTERNS = [
  /BuyHeroInfo|WaitHeroInfo|SellHeroInfo|GiHeroInfo|GiWaitHeroList|GiHeroList|PlayerBattleInfo|GiGameStatus/,
  /ChessPositionApi|XYPosition|PositionApiData|LineupDetailData|OuterPositionApiData/,
  /roundOcrText|Buy hex ocr|captureDisplay|takeScreenShot|ScreenCapture|ScreenshotHardwareBuffer/i,
  /app_libs_rapidocr|ch_pp_ocrv3|tool_apk_jkchess_assist/i,
  /board_units|bench_units|live_board|live_bench|current_board|current_bench/i,
  /roi|rect|bounds|position|screenShot|ocr/i,
];

function usage() {
  return [
    "Usage:",
    "  node tools/analyze-jcc-mumu-config-formats.mjs [--root <mumu-root>] [--package-root <downloaded-config-root>] [--out <json>]",
    "",
    "Builds a small, read-only format map for MuMu JCC gameassist APK/config evidence.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, packageRoot: DEFAULT_PACKAGE_ROOT, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--package-root") options.packageRoot = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
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

function sha256Prefix(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function asciiStrings(buffer, min = 4) {
  const strings = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) current += String.fromCharCode(byte);
    else {
      if (current.length >= min) strings.push(current);
      current = "";
    }
  }
  if (current.length >= min) strings.push(current);
  return strings;
}

function utf16LeStrings(buffer, min = 4) {
  const strings = [];
  let current = "";
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = buffer.readUInt16LE(index);
    if (code >= 32 && code <= 126) current += String.fromCharCode(code);
    else {
      if (current.length >= min) strings.push(current);
      current = "";
    }
  }
  if (current.length >= min) strings.push(current);
  return strings;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sampleMatching(strings, patterns, limit = 160) {
  return unique(strings
    .filter((value) => patterns.some((pattern) => pattern.test(value)))
    .map((value) => value.slice(0, 320)))
    .slice(0, limit);
}

function entropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of buffer) counts[byte] += 1;
  let value = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / buffer.length;
    value -= p * Math.log2(p);
  }
  return Number(value.toFixed(4));
}

function classifySignature(buffer) {
  return {
    zip: buffer[0] === 0x50 && buffer[1] === 0x4b,
    gzip: buffer[0] === 0x1f && buffer[1] === 0x8b,
    sqlite: buffer.subarray(0, 16).toString("latin1") === "SQLite format 3\0",
    dex: buffer.subarray(0, 3).toString("latin1") === "dex",
    elf: buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46,
    png: buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47,
    x23b: buffer.subarray(0, 5).toString("latin1") === "<X23B",
  };
}

function probeZlib(buffer) {
  const probes = [];
  const candidateOffsets = [];
  for (let index = 0; index + 2 < Math.min(buffer.length, 4096); index += 1) {
    const first = buffer[index];
    const second = buffer[index + 1];
    if (first === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(second)) candidateOffsets.push(index);
  }
  for (const offset of candidateOffsets.slice(0, 12)) {
    const chunk = buffer.subarray(offset);
    for (const [method, inflate] of [
      ["inflate", zlib.inflateSync],
      ["inflateRaw", zlib.inflateRawSync],
    ]) {
      try {
        const decoded = inflate(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        probes.push({
          offset,
          method,
          ok: true,
          decoded_bytes: decoded.length,
          decoded_sha256_prefix: sha256Prefix(decoded),
          decoded_preview_ascii: asciiStrings(decoded).slice(0, 20),
        });
      } catch (error) {
        probes.push({
          offset,
          method,
          ok: false,
          error: String(error.message || error).slice(0, 120),
        });
      }
    }
  }
  return {
    candidate_offsets: candidateOffsets.slice(0, 40),
    successful: probes.filter((probe) => probe.ok).slice(0, 6),
    failed_sample: probes.filter((probe) => !probe.ok).slice(0, 8),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs || 10_000);
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

async function summarizeSqlite(file) {
  if (!(await exists(file))) return null;
  const script = String.raw`
import json
import sqlite3
import sys

def cap(value):
    if isinstance(value, bytes):
        return {"type": "bytes", "size": len(value), "prefix_hex": value[:32].hex()}
    if isinstance(value, str):
        return value[:500]
    return value

db_path = sys.argv[1]
out = {"ok": False, "path": db_path, "tables": [], "samples": {}, "error": None}
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    tables = conn.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
    out["tables"] = [{"name": row["name"], "sql": cap(row["sql"] or "")} for row in tables]
    for row in tables:
        name = row["name"]
        cols = [col["name"] for col in conn.execute(f"PRAGMA table_info({name})").fetchall()]
        count = conn.execute(f"SELECT COUNT(*) AS c FROM {name}").fetchone()["c"]
        rows = conn.execute(f"SELECT * FROM {name} LIMIT 2").fetchall()
        out["samples"][name] = {
            "columns": cols,
            "row_count": count,
            "rows": [{key: cap(item[key]) for key in item.keys()} for item in rows],
        }
    out["ok"] = True
except Exception as exc:
    out["error"] = str(exc)
print(json.dumps(out, ensure_ascii=False))
`;
  const result = await run("py", ["-3", "-c", script, file], { timeoutMs: 10_000 });
  if (result.code !== 0) return { ok: false, error: result.stderr.trim().slice(0, 400) };
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, error: "sqlite_summary_parse_failed", raw: result.stdout.slice(0, 400) };
  }
}

async function summarizeFile(id, file, options = {}) {
  if (!(await exists(file))) return { id, path: file, exists: false };
  const buffer = await readFile(file);
  const ascii = options.scanStrings === false ? [] : asciiStrings(buffer);
  const utf16 = options.scanStrings === false ? [] : utf16LeStrings(buffer);
  const signature = classifySignature(buffer);
  return {
    id,
    path: path.relative(process.cwd(), file).replaceAll("\\", "/"),
    exists: true,
    size_bytes: buffer.length,
    sha256_prefix: sha256Prefix(buffer),
    first_bytes_hex: buffer.subarray(0, 64).toString("hex"),
    first_bytes_ascii: buffer.subarray(0, 32).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
    signature,
    entropy_first_64k: entropy(buffer.subarray(0, Math.min(buffer.length, 65536))),
    matched_strings: sampleMatching([...ascii, ...utf16], JCC_PATTERNS, options.limit || 120),
    string_counts: {
      ascii: ascii.length,
      utf16le: utf16.length,
    },
    x23b_probe: signature.x23b ? {
      header_ascii: buffer.subarray(0, 6).toString("latin1"),
      likely_container: "custom_or_encrypted_container",
      zlib_probe: probeZlib(buffer),
    } : null,
  };
}

async function summarizeOcrPackages(packageRoot) {
  const root = path.resolve(packageRoot);
  const files = await walk(root);
  const interesting = files.filter((file) => /\.(so|param|txt|json|zip)$/i.test(file));
  const summaries = [];
  for (const file of interesting) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    const scanStrings = !/\.zip$/i.test(file);
    summaries.push(await summarizeFile(rel, file, {
      scanStrings,
      limit: 40,
    }));
  }
  return {
    root: path.relative(process.cwd(), root).replaceAll("\\", "/"),
    file_count: files.length,
    summaries,
    conclusion: "Observed packages are generic OCR runtime/model assets unless JCC-specific matched_strings appear.",
  };
}

function buildCompanionContract() {
  return {
    contract_id: "jcc-android-companion-runtime-intake-v1",
    default_storage_policy: "no_frame_or_screenshot_persistence",
    capture_transport: {
      preferred_mvp: "MediaProjection -> ImageReader or MediaCodec -> local socket/WebSocket -> Node runtime",
      frame_policy: "frames are memory-only ring-buffer samples; persist only with explicit debug flag",
      binary_transport_options: [
        "H264 Annex-B NAL stream for lowest bandwidth",
        "JPEG/WEBP ROI crops for simpler MVP",
        "raw RGBA only inside device process before crop/encode",
      ],
    },
    semantic_transport: {
      runtime_ready_message_types: [
        "frame_meta",
        "roi_observations",
        "ocr_text_blocks",
        "semantic_observations",
        "heartbeat",
      ],
      preferred_agent_input: "JSONL semantic observations plus optional binary frame/ROI side-channel",
      reason: "The runtime agent should reason over structured text/ids/confidence/evidence pointers, not retained screenshots.",
    },
    match_session: {
      required_fields: ["match_session_id", "capture_session_id", "frame_seq", "monotonic_ms", "game_package", "orientation", "resolution"],
      pollution_guard: "drop or quarantine any observation whose match_session_id differs from current runtime session",
    },
    promotion_policy: {
      board_units: "semantic_observation candidate until current-frame slot evidence plus champion identity confidence passes threshold",
      bench_units: "semantic_observation candidate until current-frame slot evidence plus champion identity confidence passes threshold",
      augments: "OCR/text candidate until matched to local augment catalog with confidence and current augment-screen detection",
      economy: "OCR candidate until numeric sanity checks pass",
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(options.root);
  const apkRoot = path.join(root, "apk");
  const dataRoot = path.join(root, "data");
  const nativeRoot = path.join(apkRoot, "lib", "x86_64");
  const sqlitePath = path.join(dataRoot, "databases", "app-db");

  const files = [
    ["base_apk", path.join(root, "base.apk"), { scanStrings: false }],
    ["classes_dex", path.join(apkRoot, "classes.dex"), {}],
    ["apk_assets_cfg", path.join(apkRoot, "assets", "cfg"), {}],
    ["apk_assets_lus", path.join(apkRoot, "assets", "lus"), {}],
    ["pulled_data_cfg", path.join(dataRoot, "cfg"), {}],
    ["native_crypto", path.join(nativeRoot, "libcrypto_native.so"), {}],
    ["native_lt_obfuscated", path.join(nativeRoot, "libLTc1NDU1NzU0.so"), {}],
  ];

  const fileSummaries = [];
  for (const [id, file, config] of files) {
    fileSummaries.push(await summarizeFile(id, file, config));
  }

  const sqlite = await summarizeSqlite(sqlitePath);
  const ocrPackages = await summarizeOcrPackages(options.packageRoot);
  const classDex = fileSummaries.find((entry) => entry.id === "classes_dex");
  const liveSnapshotTokens = classDex?.matched_strings?.filter((value) => /board_units|bench_units|live_board|live_bench|current_board|current_bench/i.test(value)) || [];
  const x23bFiles = fileSummaries.filter((entry) => entry.signature?.x23b);
  const x23bDecoded = x23bFiles.some((entry) => (entry.x23b_probe?.zlib_probe?.successful || []).length > 0);

  const analysis = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    root: path.relative(process.cwd(), root).replaceAll("\\", "/"),
    purpose: "Classify MuMu JCC gameassist rule/config/runtime evidence without persisting gameplay frames.",
    evidence_summary: {
      dex_jcc_strings_observed: (classDex?.matched_strings || []).length > 0,
      direct_live_board_or_bench_snapshot_observed: liveSnapshotTokens.length > 0,
      x23b_files_observed: x23bFiles.map((entry) => entry.id),
      x23b_decode_status: x23bDecoded ? "zlib_payload_candidate_observed" : "opaque_x23b_no_standard_zlib_decode",
      sqlite_live_board_table_observed: Boolean(sqlite?.tables?.some((table) => /board|bench|live/i.test(table.name))),
      ocr_packages_jcc_specific_rules_observed: ocrPackages.summaries.some((entry) => (entry.matched_strings || []).some((value) => /BuyHeroInfo|GiHeroInfo|ChessPosition|海克斯|棋盘|备战/i.test(value))),
    },
    file_summaries: fileSummaries,
    sqlite_private_cache: sqlite,
    ocr_packages: ocrPackages,
    companion_runtime_intake_contract: buildCompanionContract(),
    current_claims: {
      can_claim: [
        "MuMu JCC APK contains JCC-specific data model names and OCR/capture strings.",
        "Online OCR packages are generic OCR runtime/model assets, not observed JCC rule packs.",
        "X23B config containers exist but are not decoded by standard zip/gzip/sqlite/zlib probes.",
        "Private SQLite cache contains lineup/config tables, not an observed live board/bench table.",
        "A future Android companion APK should default to no screenshot persistence and stream transient frame/ROI/semantic messages.",
      ],
      cannot_claim: [
        "MuMu exposes a stable external SDK/API returning current local board_units or bench_units.",
        "X23B files contain ROI/state-machine rules until decoded or method-level DEX use is mapped.",
        "OCR candidates equal verified current local board/bench state.",
      ],
    },
  };

  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out,
    dex_jcc_strings_observed: analysis.evidence_summary.dex_jcc_strings_observed,
    x23b_decode_status: analysis.evidence_summary.x23b_decode_status,
    direct_live_board_or_bench_snapshot_observed: analysis.evidence_summary.direct_live_board_or_bench_snapshot_observed,
    ocr_packages_jcc_specific_rules_observed: analysis.evidence_summary.ocr_packages_jcc_specific_rules_observed,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
