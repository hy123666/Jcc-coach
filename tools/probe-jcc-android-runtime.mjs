import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PACKAGE = "com.tencent.jkchess";
const DEFAULT_REMOTE_BASE = `/sdcard/Android/data/${DEFAULT_PACKAGE}/files`;
const CAPTURE_CONTRACT_PATH = "data/runtime/jcc/android-runtime-capture-contract.json";
const BASELINE_SCOPES = ["lobby_baseline", "match_history", "in_game"];
const STATE_TERMS = [
  "board",
  "bench",
  "shop",
  "store",
  "equip",
  "item",
  "hero",
  "piece",
  "gold",
  "money",
  "round",
  "level",
  "exp",
  "hp",
  "health",
  "lineup",
  "formation",
];
const EVENT_TERMS = [
  "Bridge] msgId",
  "MsgExec",
  "handled msg id",
  "MessagePairWrap",
  "ChessBattle",
  "Battle",
  "InGame",
];
const SENSITIVE_PATTERN = /(token|openid|access|pay|qq|uin|user_name|login|passport|msdk|sig|session|auth|cookie|account|phone)/i;
const NOISE_PATTERN = /(AssetBundle|COSPackage|Load Over|Start Load|Texture|unity3d|Downloader|filelist|journal|Wwise|Audio|Video|HardwareCheck|StageRunner|LoadStage|showStage)/i;

function usage() {
  const scopes = validScopes();
  return [
    "Usage:",
    "  node tools/probe-jcc-android-runtime.mjs --adb <adb.exe> --device <host:port> --scope <scope> [options]",
    "",
    "Options:",
    "  --package <id>       Android package id. Default: com.tencent.jkchess",
    `  --scope <scope>      Capture scope. Valid: ${scopes.join(", ")}.`,
    "  --list-scopes        Print valid baseline and targeted capture scopes as JSON, then exit.",
    "  --out <dir>          Evidence output directory. Default: .omx/runtime-evidence/android-probe-<timestamp>",
    "  --no-pull-net        Skip pulling /sdcard Android/data public net logs.",
    "  --help               Show this help.",
    "",
    `Targeted capture contract: ${CAPTURE_CONTRACT_PATH}`,
    "This probe is read-only: it uses ADB, dumpsys, UIAutomator, logcat snapshots, and public external app files.",
  ].join("\n");
}

function loadCaptureContract() {
  try {
    return JSON.parse(fs.readFileSync(CAPTURE_CONTRACT_PATH, "utf8"));
  } catch {
    return { scenarios: [] };
  }
}

function targetedScopes() {
  return loadCaptureContract().scenarios?.map((scenario) => scenario.id) || [];
}

function validScopes() {
  return [...BASELINE_SCOPES, ...targetedScopes()];
}

function scopeMetadata(scope) {
  const scenario = loadCaptureContract().scenarios?.find((entry) => entry.id === scope);
  if (!scenario) {
    return {
      scope_kind: BASELINE_SCOPES.includes(scope) ? "baseline" : "unknown",
      targeted_capture_contract: null,
    };
  }
  return {
    scope_kind: "targeted",
    targeted_capture_contract: CAPTURE_CONTRACT_PATH,
    scenario_id: scenario.id,
    scenario_goal: scenario.goal,
    target_fields: scenario.target_fields || [],
    capture_steps: scenario.capture_steps || [],
    success_criteria: scenario.success_criteria || [],
  };
}

function scopeListPayload() {
  const targeted = targetedScopes();
  return {
    ok: true,
    contract_ref: CAPTURE_CONTRACT_PATH,
    baseline_scopes: BASELINE_SCOPES,
    targeted_scopes: targeted,
    scopes: [...BASELINE_SCOPES, ...targeted],
  };
}

function parseArgs(argv) {
  const options = {
    packageId: DEFAULT_PACKAGE,
    pullNet: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list-scopes") options.listScopes = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--package") options.packageId = argv[++index];
    else if (arg === "--scope") options.scope = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--no-pull-net") options.pullNet = false;
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

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function countTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(escaped, "ig")) || []).length;
}

function sanitizeSnippet(snippet) {
  return snippet
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function snippetsFor(text, term, max = 6) {
  const output = [];
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let pos = 0;
  while ((pos = lower.indexOf(needle, pos)) !== -1 && output.length < max) {
    const raw = text.slice(Math.max(0, pos - 90), Math.min(text.length, pos + term.length + 160));
    const snippet = sanitizeSnippet(raw);
    pos += term.length;
    if (!snippet || SENSITIVE_PATTERN.test(snippet) || NOISE_PATTERN.test(snippet)) continue;
    if (!output.includes(snippet)) output.push(snippet);
  }
  return output;
}

async function listFilesRecursive(root) {
  const found = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else found.push(filePath);
    }
  }
  if (fs.existsSync(root)) await walk(root);
  return found;
}

async function summarizePulledLogs(netDir) {
  const files = await listFilesRecursive(netDir);
  const summaries = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const text = bytes.toString("utf8");
    const counts = {};
    for (const term of [...STATE_TERMS, ...EVENT_TERMS]) {
      const count = countTerm(text, term);
      if (count > 0) counts[term] = count;
    }
    const evidence = {};
    for (const term of [...STATE_TERMS, ...EVENT_TERMS]) {
      const snippets = snippetsFor(text, term);
      if (snippets.length > 0) evidence[term] = snippets;
    }
    summaries.push({
      file: path.relative(netDir, file),
      bytes: bytes.length,
      counts,
      evidence,
    });
  }
  return summaries;
}

function analyzeUiTree(xml) {
  const textValues = [...xml.matchAll(/\btext="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  const resourceIds = [...xml.matchAll(/\bresource-id="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  const unitySurface = /unitySurfaceView|content-desc="Game view"|class="android\.view\.View"/.test(xml);
  return {
    unity_surface_only: unitySurface && textValues.length === 0,
    text_node_count: textValues.length,
    resource_ids: [...new Set(resourceIds)].slice(0, 20),
    sample_text_nodes: textValues.slice(0, 20),
  };
}

function redact(text) {
  return text
    .replace(/(token|access|openid|uin|user_name|sig|session|auth|cookie)(["'=:\s]+)[^,"\s}]+/gi, "$1$2<redacted>")
    .slice(0, 20000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listScopes) {
    console.log(JSON.stringify(scopeListPayload(), null, 2));
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.adb) throw new Error(`Missing --adb\n${usage()}`);
  if (!options.device) throw new Error(`Missing --device\n${usage()}`);
  if (!options.scope) throw new Error(`Missing --scope\n${usage()}`);
  if (!validScopes().includes(options.scope)) {
    throw new Error(`Invalid --scope: ${options.scope}\n${usage()}`);
  }

  const packageId = options.packageId;
  const remoteBase = packageId === DEFAULT_PACKAGE
    ? DEFAULT_REMOTE_BASE
    : `/sdcard/Android/data/${packageId}/files`;
  const outDir = path.resolve(options.out || `.omx/runtime-evidence/android-probe-${timestamp()}`);
  await mkdir(outDir, { recursive: true });

  const adb = makeAdb(options.adb, options.device);
  const commands = {
    devices: adb.run(["devices", "-l"]),
    pid: adb.shell(`pidof ${packageId}`),
    focus: adb.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"),
    package: adb.shell(`dumpsys package ${packageId} | grep -E 'versionName|versionCode|dataDir|userId|targetSdk'`),
    identity: adb.shell("id"),
    privateData: adb.shell(`ls -ld /data/user/0/${packageId}; ls -l /data/user/0/${packageId} 2>&1 | head -20; run-as ${packageId} id 2>&1`),
    externalList: adb.shell(`find ${remoteBase}/yxzg -maxdepth 4 -type f 2>/dev/null | head -200`),
  };

  for (const [name, result] of Object.entries(commands)) {
    await writeText(path.join(outDir, `${name}.txt`), redact(`${result.stdout}\n${result.stderr}`));
  }

  adb.shell("uiautomator dump /sdcard/jcc-window.xml >/dev/null 2>&1");
  const ui = adb.shell("cat /sdcard/jcc-window.xml 2>/dev/null");
  await writeText(path.join(outDir, "window.xml"), ui.stdout || ui.stderr);

  adb.shell("logcat -c");
  const logcat = adb.shell("sleep 2; logcat -d -v time 2>/dev/null");
  await writeText(path.join(outDir, "logcat-snapshot-redacted.txt"), redact(logcat.stdout || logcat.stderr));

  let pulledNet = null;
  let logSummaries = [];
  if (options.pullNet) {
    const netOut = path.join(outDir, "net");
    await mkdir(netOut, { recursive: true });
    const pull = adb.run(["pull", `${remoteBase}/yxzg/net`, netOut]);
    await writeText(path.join(outDir, "pull-net.txt"), `${pull.stdout}\n${pull.stderr}`);
    pulledNet = { ok: pull.ok, output: redact(`${pull.stdout}\n${pull.stderr}`).trim() };
    logSummaries = await summarizePulledLogs(netOut);
  }

  const uiAnalysis = analyzeUiTree(ui.stdout || "");
  const logHasDirectStateEvidence = logSummaries.some((summary) => {
    const evidenceTerms = Object.keys(summary.evidence || {});
    return evidenceTerms.some((term) => STATE_TERMS.includes(term));
  });
  const logHasServerEvents = logSummaries.some((summary) => {
    const evidenceTerms = Object.keys(summary.evidence || {});
    return evidenceTerms.some((term) => EVENT_TERMS.includes(term));
  });

  const report = {
    ok: commands.pid.ok && Boolean(commands.pid.stdout.trim()) && /com\.tencent\.jkchess|ApolloZGame/.test(commands.focus.stdout),
    captured_at: new Date().toISOString(),
    package_id: packageId,
    device: options.device,
    capture_scope: options.scope,
    capture_scope_metadata: scopeMetadata(options.scope),
    out_dir: outDir,
    verdict: {
      adb_transport: commands.devices.ok && commands.pid.ok ? "online" : "not_verified",
      foreground_game: /com\.tencent\.jkchess|ApolloZGame/.test(commands.focus.stdout) ? "yes" : "no",
      private_app_data_without_root: /Permission denied|package not debuggable/.test(commands.privateData.stdout + commands.privateData.stderr) ? "not_readable" : "readable",
      android_ui_tree: uiAnalysis.unity_surface_only ? "unity_surface_only_no_structured_text" : "has_accessible_nodes",
      public_external_logs: pulledNet?.ok ? "readable" : "not_readable_or_skipped",
      direct_live_state_from_current_sample: logHasDirectStateEvidence ? "unproven_terms_only" : "not_found",
      server_event_names_from_current_sample: logHasServerEvents ? "present" : "not_found",
      strategy_input_eligible: options.scope === "lobby_baseline" ? "no_transport_baseline_only" : "yes_if_live_state_payload_verified",
    },
    evidence: {
      pid: commands.pid.stdout.trim(),
      focus: sanitizeSnippet(commands.focus.stdout),
      package: sanitizeSnippet(commands.package.stdout),
      identity: sanitizeSnippet(commands.identity.stdout),
      ui: uiAnalysis,
      pulled_net: pulledNet,
      log_summaries: logSummaries,
    },
    next_probe_step: options.scope === "lobby_baseline"
      ? "Use lobby_baseline only to verify transport/connectivity. Re-run with --scope in_game or --scope match_history for strategy-eligible samples."
      : "Compare this sample against lobby_baseline and verify whether board/shop/equip/gold/round payload evidence is present before emitting runtime live_state.",
  };

  await writeText(path.join(outDir, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: report.ok,
    out_dir: outDir,
    verdict: report.verdict,
    next_probe_step: report.next_probe_step,
  }, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
