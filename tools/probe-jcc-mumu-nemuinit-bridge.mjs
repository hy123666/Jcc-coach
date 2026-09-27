import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_DEVICE = "127.0.0.1:7555";
const DEFAULT_OUT = ".omx/runtime-evidence/mumu-nemuinit-bridge-probe/latest";

function usage() {
  return [
    "Usage:",
    "  node tools/probe-jcc-mumu-nemuinit-bridge.mjs [--adb <adb.exe>] [--device <host:port>] [--connect] [--out-dir <dir>] [--logcat-seconds <n>]",
    "",
    "Runs a read-only MuMu nemuinit bridge probe. It does not send game commands.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { device: DEFAULT_DEVICE, outDir: DEFAULT_OUT, connect: false, logcatSeconds: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--connect") options.connect = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--logcat-seconds") options.logcatSeconds = Number(argv[++index]);
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

async function adbCandidates(explicitAdb) {
  const names = process.platform === "win32" ? ["adb.exe", "adb"] : ["adb"];
  const candidates = [];
  if (explicitAdb) candidates.push({ source: "--adb", path: explicitAdb });
  if (process.env.JCC_ADB) candidates.push({ source: "JCC_ADB", path: process.env.JCC_ADB });
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean)) {
    for (const name of names) candidates.push({ source: "android_env", path: path.join(root, "platform-tools", name) });
  }
  const repoSdk = path.resolve(".omx/tools/android-sdk");
  for (const name of names) candidates.push({ source: "repo_android_sdk", path: path.join(repoSdk, "platform-tools", name) });
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const roots = [
      local && path.join(local, "Android", "Sdk"),
      programFiles && path.join(programFiles, "Android", "android-sdk"),
      programFilesX86 && path.join(programFilesX86, "Android", "android-sdk"),
      "G:\\005-娱乐类\\mumu\\MuMuPlayer\\nx_device\\12.0\\shell",
      "H:\\mumu\\MuMuPlayer\\nx_device\\12.0\\shell",
    ].filter(Boolean);
    for (const root of roots) {
      for (const name of names) candidates.push({ source: "common_or_mumu_path", path: path.join(root, name) });
    }
  }
  for (const name of names) candidates.push({ source: "PATH", path: name });

  const checked = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    checked.push({
      ...candidate,
      exists: candidate.path === "adb" ? null : await exists(candidate.path),
    });
  }
  return checked;
}

function run(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 124, stdout, stderr, timed_out: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message || String(error), timed_out: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timed_out: false });
    });
  });
}

function makeAdb(adb, device) {
  return {
    run: (args, timeoutMs) => run(adb, device ? ["-s", device, ...args] : args, timeoutMs),
    shell: (command, timeoutMs) => run(adb, device ? ["-s", device, "shell", command] : ["shell", command], timeoutMs),
  };
}

function summarizeCommand(result) {
  return {
    code: result.code,
    timed_out: result.timed_out,
    stdout: result.stdout.trim().slice(0, 20000),
    stderr: result.stderr.trim().slice(0, 12000),
  };
}

function logcatSignals(text) {
  const patterns = [
    /gi_plugin_jkchess/ig,
    /NemuInit/ig,
    /handleNemuInitMessage/ig,
    /cmd:\s*0x[0-9a-f]+/ig,
    /GiHeroList|GiWaitHeroList|GiBuyHeroList|GiGameStatus/ig,
  ];
  const hits = {};
  for (const pattern of patterns) hits[String(pattern)] = (text.match(pattern) || []).length;
  return hits;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const checkedCandidates = await adbCandidates(options.adb);
  const preferred = checkedCandidates.find((candidate) => candidate.exists === true) || checkedCandidates.find((candidate) => candidate.path === "adb");
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });

  if (!preferred) {
    const report = {
      ok: false,
      blocker: "adb_not_found",
      checked_candidates: checkedCandidates,
      next_step: "set JCC_ADB or pass --adb <path-to-adb.exe>",
    };
    await writeFile(path.join(outDir, "mumu-nemuinit-bridge-probe.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const rawCommands = {};
  if (options.connect && options.device) {
    rawCommands.connect = summarizeCommand(await run(preferred.path, ["connect", options.device], 10000));
  }
  rawCommands.devices = summarizeCommand(await run(preferred.path, ["devices", "-l"], 10000));
  const adb = makeAdb(preferred.path, options.device);
  rawCommands.identity = summarizeCommand(await adb.shell("id", 10000));
  rawCommands.service_list = summarizeCommand(await adb.shell("service list | grep -i nemuinit", 10000));
  rawCommands.service_check = summarizeCommand(await adb.shell("service check nemuinit", 10000));
  rawCommands.ps = summarizeCommand(await adb.shell("ps -A | grep -E 'nemuinit|nemu_vapi|gameassist|jkchess' 2>/dev/null", 10000));
  rawCommands.gameassist_pkg = summarizeCommand(await adb.shell("pm path com.mumu.gameassist.jkchess; dumpsys package com.mumu.gameassist.jkchess | grep -E 'versionName|versionCode|dataDir|userId|targetSdk' 2>/dev/null", 10000));
  rawCommands.jcc_pkg = summarizeCommand(await adb.shell("pidof com.tencent.jkchess; dumpsys package com.tencent.jkchess | grep -E 'versionName|versionCode|dataDir|userId|targetSdk' 2>/dev/null", 10000));
  rawCommands.host_files = summarizeCommand(await adb.shell("ls -l /system/bin/nemuinit /system/lib64/libnemuinitaidl.so /system/priv-app/nemu-vapi-android-pack/nemu-vapi-android-pack.apk /system/priv-app/com.mumu.shared.sdk/com.mumu.shared.sdk.apk 2>/dev/null", 10000));
  rawCommands.logcat_clear = summarizeCommand(await adb.shell("logcat -c", 10000));
  rawCommands.logcat = summarizeCommand(await adb.shell(`sleep ${Math.max(1, Math.min(30, options.logcatSeconds))}; logcat -d -v time 2>/dev/null | grep -Ei 'gi_plugin_jkchess|NemuInit|handleNemuInitMessage|GiHeroList|GiWaitHeroList|GiBuyHeroList|GiGameStatus|cmd: 0x'`, (options.logcatSeconds + 8) * 1000));

  const serviceFound = /nemuinit/i.test(rawCommands.service_list.stdout) || /found/i.test(rawCommands.service_check.stdout);
  const gameassistPresent = /package:|version|userId|dataDir/i.test(rawCommands.gameassist_pkg.stdout);
  const hostFilesPresent = /libnemuinitaidl|nemuinit/i.test(rawCommands.host_files.stdout);
  const report = {
    ok: serviceFound && gameassistPresent && hostFilesPresent,
    generated_at: new Date().toISOString(),
    adb_candidate: preferred,
    device: options.device,
    read_only_policy: {
      sent_nemuinit_game_commands: false,
      sent_service_call: false,
      reason: "This probe is discovery-only; bridge subscription requires a safe client implementation.",
    },
    checks: {
      adb_transport: rawCommands.devices.code === 0 ? "observed" : "not_observed",
      nemuinit_service: serviceFound ? "observed" : "not_observed",
      gameassist_package: gameassistPresent ? "observed" : "not_observed",
      host_files: hostFilesPresent ? "observed" : "not_observed",
      live_logcat_bridge_tokens: logcatSignals(rawCommands.logcat.stdout),
    },
    bridge_access_status: serviceFound
      ? "host_service_observed_callback_subscription_not_yet_proven"
      : "host_service_not_observed",
    next_engineering_step: serviceFound
      ? "implement a safe Binder callback subscriber for android.INemuInitProxyCallback, then listen for gi_plugin_jkchess payloads"
      : "start MuMu and verify nemuinit service is present",
    raw_commands: rawCommands,
  };

  await writeFile(path.join(outDir, "mumu-nemuinit-bridge-probe.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    out: path.join(outDir, "mumu-nemuinit-bridge-probe.json"),
    checks: report.checks,
    bridge_access_status: report.bridge_access_status,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
