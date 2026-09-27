import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const DEFAULT_APK = ".omx/runtime-evidence/jcc-apk-static-current-7555/apk/01-base.apk";
const DEFAULT_OUT_DIR = ".omx/runtime-evidence/jcc-il2cpp-static-current";
const TARGET_ENTRIES = [
  "assets/bin/Data/Managed/Metadata/global-metadata.dat",
  "lib/arm64-v8a/libil2cpp.so",
  "classes.dex",
  "classes2.dex",
  "classes3.dex",
];
const TERM_GROUPS = {
  protocol: ["protobuf", "FileDescriptorProto", ".proto", "CodedInputStream", "MessageLite", "InGameRoundFlow", "RoundFlow", "AITreeNode"],
  board_bench_shop: ["Board", "Bench", "Shop", "Chess", "Hero", "Piece", "Position", "Lineup", "WaitHero", "BuyHero", "SellHero"],
  runtime_state: ["GameStart", "GameEnd", "Battle", "Round", "Player", "Chair", "Money", "Gold", "Level", "Exp", "Hp", "Health"],
};
const SENSITIVE_PATTERN = /(token|openid|access|pay|qq|uin|user_name|login|passport|msdk|sig|session|auth|cookie|account|phone)/i;

function usage() {
  return [
    "Usage:",
    "  node tools/extract-jcc-apk-il2cpp-hints.mjs [--apk <base.apk>] [--out-dir <dir>]",
    "",
    "Extracts selected IL2CPP/DEX static artifacts from a local copied APK and scans strings for parser hints.",
    "This is read-only and emits source_insights only.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { apk: DEFAULT_APK, outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apk") options.apk = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= min; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) return [];
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = centralDirOffset;
  for (let index = 0; index < entryCount && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) return null;
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > buffer.length) return null;
  const compressed = buffer.subarray(dataOffset, dataEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  return null;
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

function utf16LeStrings(buffer) {
  const strings = [];
  let current = "";
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = buffer.readUInt16LE(index);
    if (code >= 32 && code <= 126) current += String.fromCharCode(code);
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

function clean(value) {
  return String(value).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function interestingStrings(strings, terms, limit = 160) {
  const out = [];
  for (const value of strings) {
    if (SENSITIVE_PATTERN.test(value)) continue;
    const matched = terms.find((term) => value.toLowerCase().includes(term.toLowerCase()));
    if (!matched) continue;
    out.push({ term: matched, value: clean(value) });
    if (out.length >= limit) break;
  }
  return out;
}

function summarizeStrings(strings) {
  const summary = {};
  for (const [group, terms] of Object.entries(TERM_GROUPS)) {
    const samples = interestingStrings(strings, terms);
    summary[group] = {
      matched: samples.length > 0,
      terms: unique(samples.map((sample) => sample.term)),
      samples,
    };
  }
  return summary;
}

function parseIl2cppMetadataHeader(buffer) {
  if (buffer.length < 32) return null;
  return {
    magic_hex: buffer.subarray(0, 4).toString("hex"),
    version: buffer.readUInt32LE(4),
    plausible_il2cpp_metadata: buffer.readUInt32LE(0) === 0xaf1bb1fa,
    first_pairs: Array.from({ length: 12 }, (_, index) => {
      const offset = 8 + index * 8;
      if (offset + 8 > buffer.length) return null;
      return { offset: buffer.readUInt32LE(offset), size: buffer.readUInt32LE(offset + 4) };
    }).filter(Boolean),
  };
}

function entryKind(name) {
  if (/global-metadata\.dat$/i.test(name)) return "global_metadata";
  if (/libil2cpp\.so$/i.test(name)) return "libil2cpp";
  if (/classes\d*\.dex$/i.test(name)) return "dex";
  return "other";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const apkPath = path.resolve(options.apk);
  const outDir = path.resolve(options.outDir);
  const artifactDir = path.join(outDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });

  const apk = await readFile(apkPath);
  const entries = listZipEntries(apk);
  const extracted = [];

  for (const target of TARGET_ENTRIES) {
    const entry = entries.find((candidate) => candidate.name === target);
    if (!entry) {
      extracted.push({ name: target, present: false });
      continue;
    }
    const bytes = readZipEntry(apk, entry);
    if (!bytes) {
      extracted.push({ name: target, present: true, extracted: false, reason: "unsupported_or_corrupt_zip_entry" });
      continue;
    }
    const localPath = path.join(artifactDir, target.replace(/[\\/]+/g, "__"));
    await writeFile(localPath, bytes);
    const strings = unique([...asciiStrings(bytes), ...utf16LeStrings(bytes)]).slice(0, 300000);
    extracted.push({
      name: target,
      kind: entryKind(target),
      present: true,
      extracted: true,
      local_path: localPath,
      size_bytes: bytes.length,
      metadata_header: /global-metadata\.dat$/i.test(target) ? parseIl2cppMetadataHeader(bytes) : null,
      string_count_sampled: strings.length,
      string_summary: summarizeStrings(strings),
    });
  }

  const report = {
    schema_version: 1,
    product_boundary: "jcc_installed_apk_il2cpp_static_hints",
    scan_scope: "copied_local_apk_selected_entries_only",
    apk_path: apkPath,
    out_dir: outDir,
    source_decision: {
      status: extracted.some((entry) => entry.string_summary?.protocol?.matched || entry.string_summary?.board_bench_shop?.matched)
        ? "candidate_il2cpp_static_hints_found"
        : "no_relevant_il2cpp_static_hints_found",
      status_kind: "static_il2cpp_source_discovery_only",
      live_state_promotion_status: "forbidden_without_runtime_local_binding",
      pollution_guard: "Never merge IL2CPP/APK static hints into board_units, bench_units, or current live_state. Use them only to guide parser hypotheses.",
    },
    extracted_entries: extracted,
  };

  const outPath = path.join(outDir, "il2cpp-static-hints.json");
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    status: report.source_decision.status,
    extracted: extracted.map((entry) => ({
      name: entry.name,
      present: entry.present,
      extracted: entry.extracted,
      size_bytes: entry.size_bytes || 0,
      protocol_terms: entry.string_summary?.protocol?.terms || [],
      board_terms: entry.string_summary?.board_bench_shop?.terms || [],
      runtime_terms: entry.string_summary?.runtime_state?.terms || [],
      metadata_version: entry.metadata_header?.version || null,
      plausible_il2cpp_metadata: entry.metadata_header?.plausible_il2cpp_metadata || false,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
