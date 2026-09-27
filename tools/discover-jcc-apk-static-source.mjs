import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const CONTRACT_PATH = "data/runtime/jcc/apk-static-source-contract.json";
const DEFAULT_PACKAGE = "com.tencent.jkchess";
const DEFAULT_OUT_DIR = ".omx/runtime-evidence/jcc-apk-static";
const MAX_ENTRY_SCAN_BYTES = 32 * 1024 * 1024;

const TERM_GROUPS = {
  proto: [
    ".proto",
    "FileDescriptorProto",
    "google.protobuf",
    "protobuf",
    "MessageLite",
    "CodedInputStream",
    "CodedOutputStream",
  ],
  il2cpp: [
    "global-metadata.dat",
    "libil2cpp.so",
    "il2cpp",
    "MetadataRegistration",
    "CodeRegistration",
  ],
  native_runtime: [
    "libGameCore.so",
    "GameCore",
    "ApolloZGame",
    "yxzg",
    "InGameRoundFlow",
    "AITreeNode_SellChess",
    "AITreeNode_GetOnChess",
    "AITreeNode_MoveChess",
  ],
  board_bench_shop: [
    "board_units",
    "bench_units",
    "Board",
    "Bench",
    "Shop",
    "Chess",
    "Hero",
    "Lineup",
    "Position",
  ],
};

const INTERESTING_ENTRY_PATTERN = /(^|\/)(global-metadata\.dat|classes\d*\.dex|libil2cpp\.so|libGameCore\.so)$|\.proto$|protobuf|proto|assets\/bin\/Data|assets\/.*(cfg|config|data|bytes|dat|json)|yxzg|GameCore|metadata/i;
const SENSITIVE_PATTERN = /(token|openid|access|pay|qq|uin|user_name|login|passport|msdk|sig|session|auth|cookie|account|phone)/i;

function usage() {
  return [
    "Usage:",
    "  node tools/discover-jcc-apk-static-source.mjs --adb <adb.exe> --device <host:port> [options]",
    "  node tools/discover-jcc-apk-static-source.mjs --apk-root <local copied APK dir> [options]",
    "",
    "Options:",
    "  --package <id>       Android package id. Default: com.tencent.jkchess",
    "  --out-dir <dir>      Evidence output directory. Default: .omx/runtime-evidence/jcc-apk-static/<timestamp>",
    "  --apk-root <dir>     Scan an existing local APK directory instead of using ADB.",
    "  --no-pull           With ADB, only record pm path/package metadata; do not pull APK files.",
    "  --help              Show this help.",
    "",
    "This tool is read-only. It does not bypass SSL pinning, hook the process, inspect memory, or capture live network traffic.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { packageId: DEFAULT_PACKAGE, pull: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--package") options.packageId = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--apk-root") options.apkRoot = argv[++index];
    else if (arg === "--no-pull") options.pull = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 80,
    ...options,
  });
  return {
    ok: result.status === 0 && !result.error,
    exit_code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
  };
}

function makeAdb(adb, device) {
  return {
    run(args) {
      return run(adb, device ? ["-s", device, ...args] : args);
    },
    shell(command) {
      return this.run(["shell", command]);
    },
  };
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

function safeName(value, fallback) {
  const base = path.basename(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base || fallback;
}

function sanitizeSnippet(value) {
  return String(value)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function redact(text) {
  return String(text)
    .replace(/(token|access|openid|uin|user_name|sig|session|auth|cookie)(["'=:\s]+)[^,"\s}]+/gi, "$1$2<redacted>")
    .slice(0, 40000);
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

function termSamples(strings, terms, limit = 20) {
  const samples = [];
  for (const value of strings) {
    if (SENSITIVE_PATTERN.test(value)) continue;
    const matched = terms.find((term) => value.toLowerCase().includes(term.toLowerCase()));
    if (matched) samples.push({ term: matched, value: sanitizeSnippet(value) });
    if (samples.length >= limit) break;
  }
  return samples;
}

function summarizeTerms(strings) {
  const output = {};
  for (const [group, terms] of Object.entries(TERM_GROUPS)) {
    const matchedTerms = terms.filter((term) => (
      strings.some((value) => value.toLowerCase().includes(term.toLowerCase()))
    ));
    output[group] = {
      matched: matchedTerms.length > 0,
      terms: matchedTerms,
      samples: termSamples(strings, terms, 16),
    };
  }
  return output;
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
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
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
  if (dataEnd > buffer.length || entry.uncompressedSize > MAX_ENTRY_SCAN_BYTES) return null;
  const compressed = buffer.subarray(dataOffset, dataEnd);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) {
    try {
      return inflateRawSync(compressed);
    } catch {
      return null;
    }
  }
  return null;
}

function entryKind(name) {
  if (/global-metadata\.dat$/i.test(name)) return "il2cpp_metadata";
  if (/libil2cpp\.so$/i.test(name)) return "il2cpp_native_library";
  if (/libGameCore\.so$/i.test(name)) return "gamecore_native_library";
  if (/\.proto$/i.test(name)) return "proto_file";
  if (/classes\d*\.dex$/i.test(name)) return "dex";
  if (/assets\/bin\/Data/i.test(name)) return "unity_data";
  if (/assets\//i.test(name)) return "asset";
  if (/lib\/.*\.so$/i.test(name)) return "native_library";
  return "other";
}

async function scanApkFile(file) {
  const buffer = await readFile(file);
  const zipEntries = listZipEntries(buffer);
  const fileStrings = zipEntries.length > 0
    ? zipEntries.map((entry) => entry.name)
    : (buffer.length <= MAX_ENTRY_SCAN_BYTES ? unique([...asciiStrings(buffer), ...utf16LeStrings(buffer)]) : []);
  const interestingNames = zipEntries
    .filter((entry) => INTERESTING_ENTRY_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const scannedEntries = [];

  for (const entry of zipEntries.filter((value) => INTERESTING_ENTRY_PATTERN.test(value.name)).slice(0, 80)) {
    if (entry.uncompressedSize > MAX_ENTRY_SCAN_BYTES) {
      scannedEntries.push({
        name: entry.name,
        kind: entryKind(entry.name),
        size_bytes: entry.uncompressedSize,
        scanned: false,
        skipped_reason: "entry_exceeds_static_scan_limit",
        term_summary: summarizeTerms([entry.name]),
      });
      continue;
    }
    const entryBuffer = readZipEntry(buffer, entry);
    if (!entryBuffer) {
      scannedEntries.push({
        name: entry.name,
        kind: entryKind(entry.name),
        size_bytes: entry.uncompressedSize,
        scanned: false,
        term_summary: summarizeTerms([entry.name]),
      });
      continue;
    }
    const strings = unique([entry.name, ...asciiStrings(entryBuffer), ...utf16LeStrings(entryBuffer)]).slice(0, 120000);
    scannedEntries.push({
      name: entry.name,
      kind: entryKind(entry.name),
      size_bytes: entry.uncompressedSize,
      scanned: true,
      term_summary: summarizeTerms(strings),
    });
  }

  return {
    file,
    bytes: buffer.length,
    zip_detected: zipEntries.length > 0,
    zip_entry_count: zipEntries.length,
    interesting_entries: unique(interestingNames).slice(0, 240),
    file_term_summary: summarizeTerms(fileStrings),
    scanned_entries: scannedEntries,
  };
}

function parsePmPath(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^package:/, ""))
    .filter((line) => line.endsWith(".apk"));
}

async function pullApks(options, outDir) {
  const adb = makeAdb(options.adb, options.device);
  const apkOut = path.join(outDir, "apk");
  await mkdir(apkOut, { recursive: true });
  const commands = {
    devices: adb.run(["devices", "-l"]),
    pmPath: adb.shell(`pm path ${options.packageId}`),
    package: adb.shell(`dumpsys package ${options.packageId}`),
  };
  await writeFile(path.join(outDir, "adb-devices.txt"), redact(`${commands.devices.stdout}\n${commands.devices.stderr}`), "utf8");
  await writeFile(path.join(outDir, "pm-path.txt"), redact(`${commands.pmPath.stdout}\n${commands.pmPath.stderr}`), "utf8");
  await writeFile(path.join(outDir, "dumpsys-package-redacted.txt"), redact(`${commands.package.stdout}\n${commands.package.stderr}`), "utf8");

  const remoteApks = parsePmPath(commands.pmPath.stdout);
  const pulls = [];
  if (options.pull) {
    for (let index = 0; index < remoteApks.length; index += 1) {
      const remote = remoteApks[index];
      const local = path.join(apkOut, `${String(index + 1).padStart(2, "0")}-${safeName(remote, "package.apk")}`);
      const pull = adb.run(["pull", remote, local], { timeout: 180000 });
      pulls.push({
        remote,
        local,
        ok: pull.ok,
        output: redact(`${pull.stdout}\n${pull.stderr}`).trim(),
      });
    }
  }
  await writeFile(path.join(outDir, "pull-apk.json"), `${JSON.stringify({ remote_apks: remoteApks, pulls }, null, 2)}\n`, "utf8");
  return { commands, remoteApks, pulls, apkRoot: apkOut };
}

function aggregateEvidence(apkReports) {
  const groups = {};
  for (const group of Object.keys(TERM_GROUPS)) groups[group] = { matched: false, terms: [], evidence_locations: [] };
  const interestingEntries = [];
  for (const report of apkReports) {
    interestingEntries.push(...report.interesting_entries.map((entry) => ({ apk: path.basename(report.file), entry })));
    const summaries = [report.file_term_summary, ...report.scanned_entries.map((entry) => entry.term_summary).filter(Boolean)];
    for (const summary of summaries) {
      for (const [group, value] of Object.entries(summary)) {
        if (!value?.matched) continue;
        groups[group].matched = true;
        groups[group].terms.push(...value.terms);
        groups[group].evidence_locations.push(path.basename(report.file));
      }
    }
    for (const entry of report.scanned_entries) {
      for (const [group, value] of Object.entries(entry.term_summary || {})) {
        if (!value?.matched) continue;
        groups[group].evidence_locations.push(`${path.basename(report.file)}:${entry.name}`);
      }
    }
  }
  for (const group of Object.values(groups)) {
    group.terms = unique(group.terms);
    group.evidence_locations = unique(group.evidence_locations).slice(0, 80);
  }
  return {
    groups,
    interesting_entries: interestingEntries.slice(0, 240),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.apkRoot && (!options.adb || !options.device)) {
    throw new Error(`Missing --adb/--device or --apk-root\n${usage()}`);
  }

  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  const outDir = path.resolve(options.outDir || path.join(DEFAULT_OUT_DIR, timestamp()));
  await mkdir(outDir, { recursive: true });

  let adbEvidence = null;
  let apkRoot = options.apkRoot ? path.resolve(options.apkRoot) : null;
  if (!apkRoot) {
    adbEvidence = await pullApks(options, outDir);
    apkRoot = adbEvidence.apkRoot;
  }

  const apkFiles = (await walk(apkRoot)).filter((file) => file.toLowerCase().endsWith(".apk"));
  const apkReports = [];
  for (const file of apkFiles) apkReports.push(await scanApkFile(file));

  const aggregate = aggregateEvidence(apkReports);
  const hasProto = aggregate.groups.proto.matched;
  const hasIl2cpp = aggregate.groups.il2cpp.matched;
  const hasRuntimeNames = aggregate.groups.native_runtime.matched || aggregate.groups.board_bench_shop.matched;
  const status = hasProto || hasIl2cpp || hasRuntimeNames ? "candidate_static_hints_found" : "no_static_hints_found";

  const discovery = {
    schema_version: 1,
    product_boundary: contract.product_boundary,
    scan_scope: "copied_local_apk_only",
    source_contract_ref: CONTRACT_PATH,
    package_id: options.packageId || DEFAULT_PACKAGE,
    captured_at: new Date().toISOString(),
    root: outDir,
    apk_root: apkRoot,
    source_provenance: {
      device: options.device || null,
      package_id: options.packageId || DEFAULT_PACKAGE,
      pm_path_source: adbEvidence ? "adb shell pm path" : "not_used_local_apk_root",
      package_metadata_source: adbEvidence ? "adb shell dumpsys package" : "not_used_local_apk_root",
      local_evidence_dir: outDir,
      local_apk_root: apkRoot,
      copied_files: apkReports.map((report) => report.file),
      remote_apks: adbEvidence?.remoteApks || [],
    },
    source_decision: {
      status,
      status_kind: "static_apk_source_discovery_only",
      proto_descriptor_status: hasProto ? "candidate_terms_found" : "not_observed",
      il2cpp_status: hasIl2cpp ? "candidate_terms_found" : "not_observed",
      runtime_symbol_status: hasRuntimeNames ? "candidate_terms_found" : "not_observed",
      live_state_promotion_status: "forbidden_without_runtime_local_binding",
      promotion_policy: contract.promotion_policy,
      pollution_guard: contract.pollution_guard,
    },
    adb_evidence: adbEvidence ? {
      device: options.device,
      pm_path_ok: adbEvidence.commands.pmPath.ok,
      package_metadata_ok: adbEvidence.commands.package.ok,
      remote_apks: adbEvidence.remoteApks,
      pulls: adbEvidence.pulls.map((pull) => ({
        remote: pull.remote,
        local: pull.local,
        ok: pull.ok,
      })),
    } : null,
    static_evidence: {
      apk_file_count: apkReports.length,
      aggregate,
      apk_reports: apkReports,
    },
    allowed_sources: contract.allowed_sources,
    forbidden_sources: contract.forbidden_sources,
  };

  const outPath = path.join(outDir, "apk-static-source-discovery.json");
  await writeFile(outPath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    status: discovery.source_decision.status,
    proto_descriptor_status: discovery.source_decision.proto_descriptor_status,
    il2cpp_status: discovery.source_decision.il2cpp_status,
    runtime_symbol_status: discovery.source_decision.runtime_symbol_status,
    apk_file_count: discovery.static_evidence.apk_file_count,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
