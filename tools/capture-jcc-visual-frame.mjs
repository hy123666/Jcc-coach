import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const CONTRACT_REF = "data/runtime/jcc/visual-live-state-contract.json";
const DEFAULT_CAPTURE_STEP_TIMEOUT_MS = Number(process.env.JCC_VISUAL_FRAME_CAPTURE_STEP_TIMEOUT_MS || 10000);

function usage() {
  return [
    "Usage:",
    "  node tools/capture-jcc-visual-frame.mjs --out-dir <dir> [--device <adb-id>] [--fixture-image <png>] [--persist-frame] [--label <label>]",
    "  node tools/capture-jcc-visual-frame.mjs --out-dir <dir> --capture-source mumu-shell [--mumu-shell <NemuShell.exe>] [--mumu-instance <ginstance...>]",
    "",
    "Captures a bounded JCC visual frame envelope. Raw frames are transient by default and are persisted only when explicitly requested.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--device") options.device = argv[++index];
    else if (arg === "--adb") options.adb = argv[++index];
    else if (arg === "--connect") options.connect = argv[++index];
    else if (arg === "--fixture-image") options.fixtureImage = argv[++index];
    else if (arg === "--capture-source") options.captureSource = argv[++index];
    else if (arg === "--mumu-shell") options.mumuShell = argv[++index];
    else if (arg === "--mumu-host") options.mumuHost = argv[++index];
    else if (arg === "--mumu-instance") options.mumuInstance = argv[++index];
    else if (arg === "--mumu-vm-config") options.mumuVmConfig = argv[++index];
    else if (arg === "--persist-frame") options.persistFrame = true;
    else if (arg === "--label") options.label = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findFirstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function discoverableMumuRoots() {
  return [
    process.env.JCC_MUMU_HOME,
    "H:\\mumu\\MuMuPlayer",
    "C:\\Program Files\\Netease\\MuMuPlayer",
    "C:\\Program Files\\MuMu\\MuMuPlayer",
  ].filter(Boolean);
}

async function childDirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function discoverMumuShell() {
  const candidates = [];
  for (const root of discoverableMumuRoots()) {
    for (const deviceRoot of await childDirectories(path.join(root, "nx_device"))) {
      candidates.push(path.join(deviceRoot, "shell", "NemuShell.exe"));
    }
  }
  return findFirstExisting(candidates);
}

async function discoverMumuVmInstance(device) {
  const targetPort = String(device || "").match(/:(\d+)$/)?.[1] || null;
  let firstInstance = null;
  for (const root of discoverableMumuRoots()) {
    for (const vmRoot of await childDirectories(path.join(root, "vms"))) {
      let entries = [];
      try {
        entries = await readdir(vmRoot, { withFileTypes: true });
      } catch {}
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".nemu")) continue;
        let text;
        try {
          text = await readFile(path.join(vmRoot, entry.name), "utf8");
        } catch {
          continue;
        }
        const instance = text.match(/instance_name"\s+value="([^"]+)"/)?.[1] || null;
        if (!instance) continue;
        if (!firstInstance) firstInstance = instance;
        if (targetPort && new RegExp(`hostport="${targetPort}"`).test(text)) return instance;
      }
    }
  }
  return firstInstance;
}

async function findMumuShell(explicitShell) {
  if (explicitShell) return explicitShell;
  if (process.env.JCC_MUMU_SHELL) return process.env.JCC_MUMU_SHELL;
  if (process.platform !== "win32") return null;
  const discovered = await discoverMumuShell();
  if (discovered) return discovered;
  const roots = [
    process.env.JCC_MUMU_HOME,
    "H:\\mumu\\MuMuPlayer",
    "G:\\005-娱乐类\\mumu\\MuMuPlayer",
    "C:\\Program Files\\Netease\\MuMuPlayer",
    "C:\\Program Files\\MuMu\\MuMuPlayer",
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "nx_device", "12.0", "shell", "NemuShell.exe"));
    candidates.push(path.join(root, "nx_main", "NemuShell.exe"));
  }
  return findFirstExisting(candidates);
}

async function findMumuVmConfig(explicitConfig) {
  if (explicitConfig) return explicitConfig;
  if (process.env.JCC_MUMU_VM_CONFIG) return process.env.JCC_MUMU_VM_CONFIG;
  if (process.platform !== "win32") return null;
  const roots = [
    process.env.JCC_MUMU_HOME,
    "H:\\mumu\\MuMuPlayer",
    "G:\\005-娱乐类\\mumu\\MuMuPlayer",
    "C:\\Program Files\\Netease\\MuMuPlayer",
    "C:\\Program Files\\MuMu\\MuMuPlayer",
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "vms", "MuMuPlayer-12.0-0", "MuMuPlayer-12.0-0.nemu"));
  }
  return findFirstExisting(candidates);
}

async function resolveMumuInstance(explicitInstance, explicitConfig, device) {
  if (explicitInstance) return explicitInstance;
  if (process.env.JCC_MUMU_INSTANCE) return process.env.JCC_MUMU_INSTANCE;
  if (!explicitConfig) {
    const discovered = await discoverMumuVmInstance(device);
    if (discovered) return discovered;
  }
  const config = await findMumuVmConfig(explicitConfig);
  if (!config) return null;
  const text = await readFile(config, "utf8");
  const match = text.match(/instance_name"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

async function resolveAdb(explicitAdb) {
  if (explicitAdb) return explicitAdb;
  if (process.env.JCC_ADB) return process.env.JCC_ADB;
  const names = process.platform === "win32" ? ["adb.exe", "adb"] : ["adb"];
  const candidates = names.map((name) => path.resolve("tools", "bin", name));
  candidates.push(...names.map((name) => path.resolve(".omx", "bin", name)));
  for (const root of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean)) {
    for (const name of names) candidates.push(path.join(root, "platform-tools", name));
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    for (const root of [local && path.join(local, "Android", "Sdk"), programFiles && path.join(programFiles, "Android", "android-sdk"), programFilesX86 && path.join(programFilesX86, "Android", "android-sdk")].filter(Boolean)) {
      for (const name of names) candidates.push(path.join(root, "platform-tools", name));
    }
  } else {
    for (const root of [path.join(os.homedir(), "Android", "Sdk"), path.join(os.homedir(), "Library", "Android", "sdk")]) {
      for (const name of names) candidates.push(path.join(root, "platform-tools", name));
    }
  }
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "adb";
}

function adbScreencap(adbPath, device, timeoutMs = DEFAULT_CAPTURE_STEP_TIMEOUT_MS) {
  const args = [];
  if (device) args.push("-s", device);
  args.push("exec-out", "screencap", "-p");
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (child.exitCode === null || child.exitCode === undefined) child.kill();
        } catch {}
        finish(reject, new Error(`${adbPath} screencap timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error(`adb_not_found: could not launch "${adbPath}". Set JCC_ADB, ANDROID_HOME, or pass --adb <path-to-adb>.`));
        return;
      }
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`${adbPath} screencap failed with ${code}: ${stderr.trim()}`));
        return;
      }
      finish(resolve, Buffer.concat(chunks));
    });
  });
}

function adbCommand(adbPath, args, timeoutMs = DEFAULT_CAPTURE_STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (child.exitCode === null || child.exitCode === undefined) child.kill();
        } catch {}
        finish(resolve, { code: 124, stdout, stderr: `${stderr}${stderr ? "\n" : ""}adb command timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error(`adb_not_found: could not launch "${adbPath}". Set JCC_ADB, ANDROID_HOME, or pass --adb <path-to-adb>.`));
        return;
      }
      finish(reject, error);
    });
    child.on("close", (code) => finish(resolve, { code, stdout, stderr }));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || options.timeout_ms || DEFAULT_CAPTURE_STEP_TIMEOUT_MS);
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (child.exitCode === null || child.exitCode === undefined) child.kill();
        } catch {}
        finish(resolve, { code: 124, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${command} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => finish(resolve, { code, stdout, stderr }));
  });
}

async function mumuShellScreencap({ adbPath, device, mumuShell, mumuHost, mumuInstance }) {
  if (!mumuShell) throw new Error("mumu_shell_not_found: pass --mumu-shell <NemuShell.exe> or set JCC_MUMU_SHELL");
  if (!mumuInstance) throw new Error("mumu_instance_not_found: pass --mumu-instance <ginstance...> or set JCC_MUMU_INSTANCE");
  const host = mumuHost || process.env.JCC_MUMU_HOST || "mumu-0";
  const remotePath = `/sdcard/jcc_visual_frame_${Date.now()}_${Math.random().toString(16).slice(2)}.png`;
  const shellCommand = `screencap -p ${remotePath}; ls -l ${remotePath}`;
  const capture = await runProcess(mumuShell, [host, mumuInstance, shellCommand], {
    timeoutMs: Number(process.env.JCC_MUMU_SHELL_CAPTURE_TIMEOUT_MS || DEFAULT_CAPTURE_STEP_TIMEOUT_MS),
  });
  if (capture.code !== 0) {
    throw new Error(`mumu_shell_screencap_failed: ${capture.stderr.trim() || capture.stdout.trim()}`);
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "jcc-mumu-frame-"));
  const localPath = path.join(tempDir, "frame.png");
  try {
    const pullArgs = [];
    if (device) pullArgs.push("-s", device);
    pullArgs.push("pull", remotePath, localPath);
    const pull = await adbCommand(adbPath, pullArgs, Number(process.env.JCC_MUMU_SHELL_PULL_TIMEOUT_MS || DEFAULT_CAPTURE_STEP_TIMEOUT_MS));
    if (pull.code !== 0) {
      throw new Error(`mumu_shell_frame_pull_failed: ${pull.stderr.trim() || pull.stdout.trim()}`);
    }
    const bytes = await readFile(localPath);
    const rmArgs = [];
    if (device) rmArgs.push("-s", device);
    rmArgs.push("shell", "rm", "-f", remotePath);
    await adbCommand(adbPath, rmArgs, Number(process.env.JCC_MUMU_SHELL_RM_TIMEOUT_MS || DEFAULT_CAPTURE_STEP_TIMEOUT_MS));
    return {
      bytes,
      metadata: {
        mumu_shell: mumuShell,
        mumu_host: host,
        mumu_instance: mumuInstance,
        remote_path_removed: true,
        capture_stdout: capture.stdout.trim(),
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function pngSize(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature || buffer.length < 24) {
    return { width: null, height: null, format: "unknown" };
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    format: "png",
  };
}

async function loadContract() {
  return JSON.parse(await readFile(CONTRACT_REF, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.outDir) throw new Error(`Missing --out-dir\n${usage()}`);

  const contract = await loadContract();
  const requestedSource = options.captureSource || "auto";
  const adbPath = options.fixtureImage ? null : await resolveAdb(options.adb);
  const mumuAllowed = !options.fixtureImage && (requestedSource === "auto" || requestedSource === "mumu-shell");
  const mumuShell = mumuAllowed ? await findMumuShell(options.mumuShell) : null;
  const mumuInstance = mumuAllowed ? await resolveMumuInstance(options.mumuInstance, options.mumuVmConfig, options.device) : null;
  let connectResult = null;
  if (!options.fixtureImage && options.connect) {
    connectResult = await adbCommand(adbPath, ["connect", options.connect]);
  }
  let captureMetadata = null;
  let source = options.fixtureImage ? "fixture_image" : "adb_exec_out_screencap";
  let bytes = null;
  if (options.fixtureImage) {
    bytes = await readFile(options.fixtureImage);
  } else if (requestedSource === "mumu-shell") {
    const capture = await mumuShellScreencap({
      adbPath,
      device: options.device,
      mumuShell,
      mumuHost: options.mumuHost,
      mumuInstance,
    });
    bytes = capture.bytes;
    source = "mumu_nemushell_screencap";
    captureMetadata = capture.metadata;
  } else {
    bytes = await adbScreencap(adbPath, options.device);
    if (bytes.length === 0 && requestedSource === "auto" && mumuShell && mumuInstance) {
      const capture = await mumuShellScreencap({
        adbPath,
        device: options.device,
        mumuShell,
        mumuHost: options.mumuHost,
        mumuInstance,
      });
      bytes = capture.bytes;
      source = "mumu_nemushell_screencap";
      captureMetadata = {
        ...capture.metadata,
        fallback_reason: "adb_exec_out_screencap_empty",
      };
    }
  }
  if (bytes.length === 0) {
    throw new Error(source === "adb_exec_out_screencap"
      ? `adb_exec_out_screencap_empty: no frame bytes were returned${mumuShell && mumuInstance ? "; MuMuShell fallback also returned no frame" : "; MuMuShell fallback is unavailable for the selected instance"}.`
      : "Captured frame is empty");
  }

  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const frameId = `frame:${hash.slice(0, 16)}`;
  const size = pngSize(bytes);
  const persistRawFrame = Boolean(options.persistFrame);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const framePath = path.join(outDir, "frame.png");
  if (persistRawFrame) await writeFile(framePath, bytes);

  const envelope = {
    ok: true,
    contract_ref: CONTRACT_REF,
    source,
    adb_path: adbPath,
    capture_source_requested: requestedSource,
    capture_metadata: captureMetadata,
    adb_connect: connectResult ? {
      target: options.connect,
      code: connectResult.code,
      stdout: connectResult.stdout.trim(),
      stderr: connectResult.stderr.trim(),
    } : null,
    label: options.label || null,
    timestamp_utc: new Date().toISOString(),
    adb_device_id: options.device || null,
    frame_id: frameId,
    sha256: hash,
    bytes: bytes.length,
    image: {
      format: size.format,
      width: size.width,
      height: size.height,
      aspect_ratio: size.width && size.height ? Number((size.width / size.height).toFixed(4)) : null,
      persisted: persistRawFrame,
      path: persistRawFrame ? path.relative(process.cwd(), framePath) : null,
    },
    storage_policy: contract.storage_policy,
    forbidden_sources: contract.forbidden_sources,
  };
  const outFile = path.join(outDir, "visual-frame.json");
  await writeFile(outFile, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    frame_id: frameId,
    source,
    bytes: bytes.length,
    persisted: persistRawFrame,
    out: path.resolve(outFile),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
