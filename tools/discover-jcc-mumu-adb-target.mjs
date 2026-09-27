import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { terminateProcessTree } from "./jcc_process_runner.mjs";

const DEFAULT_PORTS = [
  7555,
  16384,
  16416,
  16448,
  16480,
  16512,
  5555,
  5557,
];

const JCC_PACKAGE = "com.tencent.jkchess";
const MUMU_ASSIST_PACKAGE = "com.mumu.gameassist.jkchess";
const RUNTIME_HEALTH_TIMEOUT_MS = 1800;
const HEALTH_LATENCY_TIE_MS = 50;

function usage() {
  return [
    "Usage:",
    "  node tools/discover-jcc-mumu-adb-target.mjs [--adb <adb.exe>] [--ports <p1,p2,...>] [--no-connect] [--timeout-ms <ms>]",
    "",
    "Discovers the best local MuMu ADB target for the JCC desktop runtime.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    ports: [...DEFAULT_PORTS],
    connect: true,
    timeoutMs: 8000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--ports") {
      options.ports = argv[++index]
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    } else if (arg === "--no-connect") options.connect = false;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function adbCandidates(explicitAdb) {
  const names = process.platform === "win32" ? ["adb.exe", "adb"] : ["adb"];
  const output = [];
  if (explicitAdb) output.push({ source: "--adb", path: explicitAdb });
  if (process.env.JCC_ADB) output.push({ source: "JCC_ADB", path: process.env.JCC_ADB });
  if (process.platform === "win32") output.push({ source: "bundled", path: path.resolve("tools", "bin", "adb.exe") });
  if (process.env.JCC_ADB_SKIP_REPO_LOCAL !== "1") {
    for (const name of names) output.push({ source: "repo_local", path: path.resolve(".omx", "bin", name) });
  }
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean)) {
    for (const name of names) output.push({ source: "android_env", path: path.join(root, "platform-tools", name) });
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    for (const root of [
      local && path.join(local, "Android", "Sdk"),
      programFiles && path.join(programFiles, "Android", "android-sdk"),
      programFilesX86 && path.join(programFilesX86, "Android", "android-sdk"),
    ].filter(Boolean)) {
      for (const name of names) output.push({ source: "common_sdk", path: path.join(root, "platform-tools", name) });
    }
  } else {
    for (const root of [path.join(os.homedir(), "Android", "Sdk"), path.join(os.homedir(), "Library", "Android", "sdk")]) {
      for (const name of names) output.push({ source: "common_sdk", path: path.join(root, "platform-tools", name) });
    }
  }
  output.push({ source: "PATH", path: "adb" });
  const checked = [];
  for (const candidate of output) {
    checked.push({ ...candidate, exists: candidate.path === "adb" ? null : await exists(candidate.path) });
  }
  return checked;
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(async () => {
        if (settled) return;
        settled = true;
        await terminateProcessTree(child);
        resolve({ code: 124, stdout, stderr: `${stderr}\ntimeout_after_${timeoutMs}ms`.trim() });
      }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function timedRun(command, args, timeoutMs) {
  const startedAt = Date.now();
  const result = await run(command, args, timeoutMs);
  return {
    ...result,
    elapsed_ms: Date.now() - startedAt,
  };
}

function parseDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line)
    .map(({ line, index }) => {
      const [serial, state] = line.split(/\s+/);
      const transportMatch = /\btransport_id:(\d+)\b/.exec(line);
      return {
        serial,
        state,
        raw: line,
        online: state === "device",
        list_index: index,
        transport_id: transportMatch ? Number(transportMatch[1]) : null,
      };
    });
}

function hostPort(serial) {
  const match = /^([^:]+):(\d+)$/.exec(serial || "");
  if (!match) return null;
  return { host: match[1], port: Number(match[2]) };
}

function portPriority(serial) {
  const hp = hostPort(serial);
  if (!hp) return DEFAULT_PORTS.length + 100;
  const index = DEFAULT_PORTS.indexOf(hp.port);
  return index >= 0 ? index : DEFAULT_PORTS.length + hp.port;
}

function serialDiscoveryPriority(serial, initiallySeenSerials = new Set()) {
  return initiallySeenSerials.has(serial) ? 0 : 1000 + portPriority(serial);
}

async function adbShell(adbPath, serial, command, timeoutMs) {
  return run(adbPath, ["-s", serial, "shell", command], timeoutMs);
}

function okText(result) {
  return result.code === 0 && String(result.stdout || "").trim().length > 0;
}

async function probeRuntimeHealth(adbPath, serial, timeoutMs) {
  const healthTimeoutMs = Math.min(timeoutMs, RUNTIME_HEALTH_TIMEOUT_MS);
  const [shell, logcat] = await Promise.all([
    timedRun(adbPath, ["-s", serial, "shell", "echo jcc_runtime_probe"], healthTimeoutMs),
    timedRun(adbPath, ["-s", serial, "logcat", "-d", "-t", "1"], healthTimeoutMs),
  ]);
  const shellOk = shell.code === 0 && /\bjcc_runtime_probe\b/.test(shell.stdout || "");
  const logcatOk = logcat.code === 0;
  return {
    shell_ok: shellOk,
    logcat_ok: logcatOk,
    usable_for_runtime: shellOk && logcatOk,
    shell_ms: shell.elapsed_ms,
    logcat_ms: logcat.elapsed_ms,
    score: (shellOk ? 10 : 0) + (logcatOk ? 10 : 0),
    stderr: {
      shell: String(shell.stderr || "").trim().slice(0, 300),
      logcat: String(logcat.stderr || "").trim().slice(0, 300),
    },
  };
}

function healthSortValue(candidate) {
  const health = candidate.health || {};
  const unusablePenalty = health.usable_for_runtime ? 0 : 100000;
  const shellMs = Number.isFinite(health.shell_ms) ? health.shell_ms : RUNTIME_HEALTH_TIMEOUT_MS;
  const logcatMs = Number.isFinite(health.logcat_ms) ? health.logcat_ms : RUNTIME_HEALTH_TIMEOUT_MS;
  return unusablePenalty + shellMs + logcatMs;
}

function compareHealth(a, b) {
  const delta = healthSortValue(a) - healthSortValue(b);
  return Math.abs(delta) > HEALTH_LATENCY_TIE_MS ? delta : 0;
}

async function probeDevice(adbPath, device, timeoutMs) {
  const serial = device.serial;
  const hp = hostPort(serial);
  const [
    manufacturer,
    model,
    gameassistPath,
    jccPath,
    gameassistPid,
    jccPid,
    foreground,
  ] = await Promise.all([
    adbShell(adbPath, serial, "getprop ro.product.manufacturer", timeoutMs),
    adbShell(adbPath, serial, "getprop ro.product.model", timeoutMs),
    adbShell(adbPath, serial, `pm path ${MUMU_ASSIST_PACKAGE}`, timeoutMs),
    adbShell(adbPath, serial, `pm path ${JCC_PACKAGE}`, timeoutMs),
    adbShell(adbPath, serial, `pidof ${MUMU_ASSIST_PACKAGE}`, timeoutMs),
    adbShell(adbPath, serial, `pidof ${JCC_PACKAGE}`, timeoutMs),
    adbShell(adbPath, serial, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|topResumedActivity' 2>/dev/null", timeoutMs),
  ]);
  const health = await probeRuntimeHealth(adbPath, serial, timeoutMs);
  const signals = {
    is_host_port: Boolean(hp),
    host: hp?.host || null,
    port: hp?.port || null,
    manufacturer: manufacturer.stdout.trim(),
    model: model.stdout.trim(),
    looks_like_mumu: /mumu|netease|nemu/i.test(`${manufacturer.stdout} ${model.stdout} ${serial}`),
    gameassist_installed: /package:/i.test(gameassistPath.stdout),
    jcc_installed: /package:/i.test(jccPath.stdout),
    gameassist_running: okText(gameassistPid),
    jcc_running: okText(jccPid),
    foreground_mentions_jcc: /com\.tencent\.jkchess|ApolloZGame/i.test(foreground.stdout),
  };
  let score = 0;
  if (device.online) score += 10;
  if (signals.looks_like_mumu) score += 15;
  if (signals.gameassist_installed) score += 30;
  if (signals.jcc_installed) score += 20;
  if (signals.gameassist_running) score += 15;
  if (signals.jcc_running) score += 15;
  if (signals.foreground_mentions_jcc) score += 10;
  score += health.score;
  return {
    serial,
    state: device.state,
    online: device.online,
    list_index: device.list_index,
    transport_id: device.transport_id,
    score,
    recommended: false,
    signals,
    health,
    probe: {
      gameassist_path: gameassistPath.stdout.trim(),
      jcc_path: jccPath.stdout.trim(),
      gameassist_pid: gameassistPid.stdout.trim(),
      jcc_pid: jccPid.stdout.trim(),
      foreground: foreground.stdout.trim().slice(0, 1000),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const checked = await adbCandidates(options.adb);
  const adb = checked.find((candidate) => candidate.exists === true) || checked.find((candidate) => candidate.path === "adb");
  if (!adb) {
    console.log(JSON.stringify({
      ok: false,
      reason: "adb_not_found",
      checked_adb_candidates: checked,
      next_step: "Install Android platform-tools or set JCC_ADB.",
    }, null, 2));
    process.exit(1);
  }

  let devicesResult = await run(adb.path, ["devices", "-l"], options.timeoutMs);
  const initialDevicesStdout = devicesResult.stdout.trim();
  const initialDevices = devicesResult.code === 0 ? parseDevices(devicesResult.stdout).filter((entry) => entry.online) : [];
  const initialSerials = new Set(initialDevices.map((entry) => entry.serial));
  const connectAttempts = [];
  if (options.connect) {
    for (const port of options.ports) {
      const target = `127.0.0.1:${port}`;
      const result = await run(adb.path, ["connect", target], options.timeoutMs);
      connectAttempts.push({
        target,
        code: result.code,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        connected: /connected to|already connected/i.test(`${result.stdout}\n${result.stderr}`),
      });
    }
    devicesResult = await run(adb.path, ["devices", "-l"], options.timeoutMs);
  }

  if (devicesResult.code !== 0) {
    console.log(JSON.stringify({
      ok: false,
      reason: "adb_devices_failed",
      adb,
      checked_adb_candidates: checked,
      port_scan: {
        enabled: options.connect,
        ports: options.ports,
        attempts: connectAttempts,
      },
      devices_stdout: devicesResult.stdout.trim(),
      devices_stderr: devicesResult.stderr.trim(),
      candidates: [],
      recommended_target: null,
      ui_hint: "ADB is configured but failed to list devices. Check platform-tools/JCC_ADB, then retry discovery.",
    }, null, 2));
    process.exit(1);
  }
  const devices = parseDevices(devicesResult.stdout);
  const probed = [];
  for (const device of devices.filter((entry) => entry.online)) {
    probed.push(await probeDevice(adb.path, device, options.timeoutMs));
  }
  probed.sort((a, b) =>
    b.score - a.score
    || compareHealth(a, b)
    || serialDiscoveryPriority(a.serial, initialSerials) - serialDiscoveryPriority(b.serial, initialSerials)
    || portPriority(a.serial) - portPriority(b.serial)
    || (a.list_index ?? 9999) - (b.list_index ?? 9999)
    || a.serial.localeCompare(b.serial)
  );
  if (probed[0]) probed[0].recommended = probed[0].score >= 40;
  const recommended = probed.find((device) => device.recommended) || null;
  const report = {
    ok: true,
    adb,
    checked_adb_candidates: checked,
    port_scan: {
      enabled: options.connect,
      policy: options.connect
        ? "scan_configured_ports_and_select_by_runtime_health"
        : "no_connect_scan_disabled",
      ports: options.ports,
      attempts: connectAttempts,
    },
    selection_policy: "Prefer the target with JCC/MuMu signals and passing runtime shell/logcat health probes; only use stable port order as a tie-break when healthy targets are effectively equal.",
    initial_devices_stdout: initialDevices.length > 0 ? initialDevicesStdout : "",
    devices_stdout: devicesResult.stdout.trim(),
    devices_stderr: devicesResult.stderr.trim(),
    candidates: probed,
    recommended_target: recommended ? {
      serial: recommended.serial,
      host: recommended.signals.host,
      port: recommended.signals.port,
      score: recommended.score,
      reason: [
        recommended.signals.gameassist_installed ? "mumu_jcc_assistant_installed" : null,
        recommended.signals.jcc_installed ? "jcc_installed" : null,
        recommended.signals.jcc_running ? "jcc_running" : null,
        recommended.signals.foreground_mentions_jcc ? "jcc_foreground" : null,
        recommended.health?.usable_for_runtime ? "runtime_health_probe_ok" : null,
      ].filter(Boolean),
      health: recommended.health,
    } : null,
    ui_hint: recommended
      ? `Use ${recommended.serial} for MuMu runtime; selected by JCC foreground signals and shell/logcat health.`
      : "No strong MuMu/JCC ADB target found. Start MuMu and JCC, then retry discovery.",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
