import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createRuntimeStoragePaths,
  writeLegacyJsonMirror,
  writeJsonAtomic,
} from "../ui/electron/runtime-state-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimePaths = createRuntimeStoragePaths(repoRoot);

function usage() {
  return [
    "Usage:",
    "  node tools/start-jcc-mumu-runtime-watch.mjs [--adb <adb.exe>] [--device <adb-serial>] [--out-dir <dir>] [--match-session-id <id>] [--catalog-overlay <file>] [--owner-instance-id <id>] [--owner-pid <pid>] [--duration-ms <ms>] [--dry-run]",
    "",
    "Auto-discovers the current MuMu/JCC ADB target, then starts the compact MuMu GI logcat watcher.",
    "The watcher is a structured MuMu source only; runtime-service owns event detection and scheduling.",
    "The caller should treat the discovered device serial as opaque; it may be emulator-5554 or host:port.",
    "Self-view anchoring is derived only from S=1 plus visible non-empty 4354 shop evidence.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    outDir: runtimePaths.currentWatchDir,
    durationMs: 0,
    summaryIntervalMs: 3000,
    discoveryTimeoutMs: 8000,
    connect: true,
    clearLogcatFirst: false,
    catalogOverlay: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--match-session-id") options.matchSessionId = argv[++index];
    else if (arg === "--owner-instance-id") options.ownerInstanceId = argv[++index];
    else if (arg === "--owner-pid") options.ownerPid = Number(argv[++index]);
    else if (arg === "--catalog-overlay") options.catalogOverlay = path.resolve(argv[++index]);
    else if (arg === "--start-new-match") {
      throw new Error("--start-new-match is retired; the canonical Runtime Start Match boundary must create the session first");
    }
    else if (arg === "--duration-ms") options.durationMs = Number(argv[++index]);
    else if (arg === "--summary-interval-ms") options.summaryIntervalMs = Number(argv[++index]);
    else if (arg === "--discovery-timeout-ms") options.discoveryTimeoutMs = Number(argv[++index]);
    else if (arg === "--ports") options.ports = argv[++index];
    else if (arg === "--no-connect") options.connect = false;
    else if (arg === "--clear-logcat-first") options.clearLogcatFirst = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
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

async function writeState(outDir, state) {
  await mkdir(outDir, { recursive: true });
  const enriched = {
    schema: "jcc-mumu-runtime-service-state-v1",
    updated_at: new Date().toISOString(),
    ...state,
  };
  await writeJsonAtomic(path.join(runtimePaths.stateDir, "jcc-mumu-runtime-service.json"), enriched);
  await writeLegacyJsonMirror(path.join(runtimePaths.legacyStateDir, "jcc-mumu-runtime-service.json"), enriched);
  await writeJsonAtomic(path.join(outDir, "service-state.json"), enriched);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const outDir = path.resolve(options.outDir);
  await writeState(outDir, {
    ok: true,
    status: "discovering",
    out_dir: outDir,
    match_session_id: options.matchSessionId || null,
    owner_instance_id: options.ownerInstanceId || null,
    owner_pid: Number.isInteger(options.ownerPid) ? options.ownerPid : null,
    supervisor_pid: process.pid,
    port_scan: {
      enabled: options.connect,
      trigger: "explicit_connect_or_rescan_action",
    },
    requested_device: options.device || null,
    ui_hint: "Scanning MuMu/JCC ADB targets before starting watcher.",
  });
  // Production passes the Match-pinned overlay. Resolve Active only for standalone use.
  if (!options.catalogOverlay) {
    const { createRuntimePaths } = await import("../ui/electron/runtime-state-store.js");
    options.catalogOverlay = createRuntimePaths(repoRoot).mumuCatalogOverlayFile;
  }
  const discoverArgs = ["tools/discover-jcc-mumu-adb-target.mjs"];
  if (options.adb) discoverArgs.push("--adb", options.adb);
  if (!options.connect) discoverArgs.push("--no-connect");
  if (Number.isFinite(options.discoveryTimeoutMs) && options.discoveryTimeoutMs > 0) {
    discoverArgs.push("--timeout-ms", String(options.discoveryTimeoutMs));
  }
  const devicePort = String(options.device || "").match(/:(\d+)$/)?.[1];
  if (options.ports) discoverArgs.push("--ports", options.ports);
  else if (devicePort) discoverArgs.push("--ports", devicePort);
  const discoveryResult = await runNode(discoverArgs);
  let discovery;
  try {
    discovery = JSON.parse(discoveryResult.stdout);
  } catch {
    await writeState(outDir, {
      ok: false,
      status: "discovery_failed",
      reason: "discovery_output_not_json",
      stderr: discoveryResult.stderr.trim(),
    });
    process.stdout.write(discoveryResult.stdout);
    process.stderr.write(discoveryResult.stderr);
    process.exit(discoveryResult.code || 1);
  }

  const requestedTarget = options.device
    ? (discovery.candidates || []).find((candidate) =>
      candidate.serial === options.device
      && candidate.score >= 40
      && candidate.health?.usable_for_runtime !== false)
    : null;
  const target = requestedTarget || discovery.recommended_target;
  if (discoveryResult.code !== 0 || discovery.ok === false || !target?.serial) {
    const state = {
      ok: false,
      status: "mumu_target_not_found",
      reason: discovery.reason || "no_recommended_mumu_jcc_target",
      discovery,
      port_scan: {
        enabled: options.connect,
        trigger: "explicit_connect_or_rescan_action",
      },
    };
    await writeState(outDir, state);
    console.log(JSON.stringify(state, null, 2));
    process.exit(1);
  }

  const watcherArgs = [
    "tools/watch-jcc-mumu-runtime-logcat.mjs",
    "--adb",
    discovery.adb.path,
    "--device",
    target.serial,
    "--out-dir",
    outDir,
    "--summary-interval-ms",
    String(options.summaryIntervalMs),
  ];
  if (options.catalogOverlay) watcherArgs.push("--catalog-overlay", options.catalogOverlay);
  if (options.matchSessionId) watcherArgs.push("--match-session-id", options.matchSessionId);
  if (options.durationMs > 0) watcherArgs.push("--duration-ms", String(options.durationMs));
  if (options.clearLogcatFirst) watcherArgs.push("--clear-logcat-first");

  const state = {
    ok: true,
    status: options.dryRun ? "ready" : "starting",
    adb: discovery.adb,
    recommended_target: target,
    target_source: requestedTarget ? "requested_device_health_checked" : "discovery_recommended_target",
    port_scan: {
      enabled: options.connect,
      trigger: "explicit_connect_or_rescan_action",
    },
    out_dir: outDir,
    match_session_id: options.matchSessionId || null,
    owner_instance_id: options.ownerInstanceId || null,
    owner_pid: Number.isInteger(options.ownerPid) ? options.ownerPid : null,
    supervisor_pid: process.pid,
    self_view_anchor: "s1_plus_non_empty_4354_shop_only",
    source_only: true,
    watcher_command: [process.execPath, ...watcherArgs],
    ui_hint: `MuMu/JCC target discovered: ${target.serial}`,
  };
  await writeState(outDir, state);
  if (options.dryRun) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(JSON.stringify(state, null, 2));
  const watcher = spawn(process.execPath, watcherArgs, {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    windowsHide: true,
  });
  watcher.on("error", async (error) => {
    await writeState(outDir, {
      ...state,
      ok: false,
      status: "watcher_spawn_failed",
      error: error.message || String(error),
    });
    process.exit(1);
  });
  watcher.on("close", async (code) => {
    await writeState(outDir, {
      ...state,
      ok: code === 0,
      status: code === 0 ? "stopped" : "watcher_failed",
      exit_code: code,
    });
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
