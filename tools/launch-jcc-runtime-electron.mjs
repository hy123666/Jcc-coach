import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(repoRoot, ".jcc-runtime-data", "logs");
const windowActivationPipe = `\\\\.\\pipe\\jcc-runtime-ui-${os.userInfo().username.replace(/[^a-z0-9_.-]/gi, "_")}`;
const rendererBuildFingerprintFile = path.join(repoRoot, "ui", "dist", ".jcc-renderer-source.sha256");

function persistLatestLaunch(result) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path.join(logDir, "desktop-launch.latest.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inspectDesktopRuntime() {
  const script = `
$repo = ${psString(repoRoot.replace(/\//g, "\\"))}
$runtime = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'electron.exe' -and
  $_.CommandLine -and
  $_.CommandLine -like "*$repo*ui*" -and
  $_.CommandLine -notmatch '--type=' -and
  $_.CommandLine -notmatch 'runtime-daemon-server\.js'
})
if ($runtime.Count -gt 0) {
  $process = Get-Process -Id $runtime[0].ProcessId -ErrorAction SilentlyContinue
  $handle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
  [pscustomobject]@{ status = 'already_running'; visible = [bool]($handle -ne 0); focused = $false; pid = $runtime[0].ProcessId; window_handle = $handle } | ConvertTo-Json -Compress
  exit 0
}
$listeners = @(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  [pscustomobject]@{ status = 'cold_start'; port_5173 = 'free' } | ConvertTo-Json -Compress
  exit 0
}
$holders = @($listeners | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
})
$runtimeVite = @($holders | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$repo*" -and $_.CommandLine -match 'vite'
})
if ($runtimeVite.Count -gt 0) {
  [pscustomobject]@{ status = 'renderer_running'; pid = $runtimeVite[0].ProcessId } | ConvertTo-Json -Compress
  exit 0
}
[pscustomobject]@{
  status = 'port_conflict'
  port = 5173
  holders = @($holders | Select-Object ProcessId,Name,CommandLine)
} | ConvertTo-Json -Compress -Depth 5
exit 20
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const stdout = String(result.stdout || "").trim();
  let payload = null;
  try { payload = stdout ? JSON.parse(stdout) : null; } catch {}
  if (result.status !== 0) {
    const error = new Error(payload?.status === "port_conflict"
      ? "Port 5173 is occupied by another application."
      : String(result.stderr || stdout || "Unable to inspect JCC Runtime processes."));
    error.details = payload;
    throw error;
  }
  return payload || { status: "cold_start" };
}

function resolveNpmCommand() {
  const lookup = spawnSync("where.exe", ["npm.cmd"], { encoding: "utf8", windowsHide: true });
  const candidate = String(lookup.stdout || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return candidate || "npm.cmd";
}

function collectRendererBuildInputs(target, output = []) {
  if (!existsSync(target)) return output;
  const stats = statSync(target);
  if (stats.isFile()) {
    output.push(target);
    return output;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    collectRendererBuildInputs(path.join(target, entry.name), output);
  }
  return output;
}

function rendererSourceFingerprint() {
  const uiRoot = path.join(repoRoot, "ui");
  const inputs = [
    path.join(uiRoot, "src"),
    path.join(uiRoot, "public"),
    path.join(uiRoot, "index.html"),
    path.join(uiRoot, "package.json"),
    path.join(uiRoot, "package-lock.json"),
    path.join(uiRoot, "tsconfig.json"),
    path.join(uiRoot, "tsconfig.node.json"),
    path.join(uiRoot, "vite.config.ts"),
  ].flatMap((target) => collectRendererBuildInputs(target));
  inputs.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update(path.relative(uiRoot, input).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(readFileSync(input));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function ensureBuiltUiAvailable() {
  const indexFile = path.join(repoRoot, "ui", "dist", "index.html");
  const expectedFingerprint = rendererSourceFingerprint();
  const builtFingerprint = existsSync(rendererBuildFingerprintFile)
    ? readFileSync(rendererBuildFingerprintFile, "utf8").trim()
    : null;
  if (existsSync(indexFile) && builtFingerprint === expectedFingerprint) return;
  const npm = resolveNpmCommand();
  const result = spawnSync(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/c",
    "call",
    npm,
    "--prefix",
    "ui",
    "run",
    "build",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
  if (result.status !== 0 || !existsSync(indexFile)) {
    throw new Error(String(result.error?.message || result.stderr || result.stdout || "JCC Runtime UI build failed."));
  }
  writeFileSync(rendererBuildFingerprintFile, `${expectedFingerprint}\n`, "utf8");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestWindowActivation(timeoutMs = 3_000) {
  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection(windowActivationPipe);
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("activate\n"));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try { finish(response.trim() ? JSON.parse(response) : null); } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
  });
}

async function waitForExistingRuntimeVisible(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspection = inspectDesktopRuntime();
    if (inspection.status !== "already_running") return null;
    if (inspection.visible) return inspection;
    await sleep(250);
  }
  return null;
}

async function waitForRuntimeReady(child, { timeoutMs = 45000, requireVisible = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspection = inspectDesktopRuntime();
    if (inspection.status === "already_running" && (!requireVisible || inspection.visible)) return inspection;
    if (child.exitCode !== null && inspection.status === "cold_start") {
      throw new Error(`JCC Runtime startup command exited before the application was ready (exit ${child.exitCode}).`);
    }
    await sleep(500);
  }
  throw new Error(`JCC Runtime did not expose a visible window within ${timeoutMs}ms.`);
}

async function startRuntime(scriptName) {
  if (!existsSync(path.join(repoRoot, "ui", "node_modules", "electron", "package.json"))) {
    throw new Error("JCC Runtime UI dependencies are missing. Run npm.cmd install --prefix ui first.");
  }
  mkdirSync(logDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutFile = path.join(logDir, `desktop-launch-${runId}.out.log`);
  const stderrFile = path.join(logDir, `desktop-launch-${runId}.err.log`);
  const stdoutFd = openSync(stdoutFile, "a");
  const stderrFd = openSync(stderrFile, "a");
  const npm = resolveNpmCommand();
  let child;
  try {
    child = spawn(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/c",
      "call",
      npm,
      "--prefix",
      "ui",
      "run",
      scriptName,
    ], {
      cwd: repoRoot,
      detached: false,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  persistLatestLaunch({
    ok: true,
    schema: "jcc-runtime-desktop-launch-v1",
    status: "runtime_starting",
    launcher_pid: child.pid,
    stdout: stdoutFile,
    stderr: stderrFile,
    requested_at: new Date().toISOString(),
  });
  const ready = await waitForRuntimeReady(child, {
    requireVisible: true,
    timeoutMs: scriptName === "electron" ? 90_000 : 120_000,
  });
  const result = {
    ok: true,
    schema: "jcc-runtime-desktop-launch-v1",
    status: scriptName === "electron" ? "runtime_activated" : "runtime_started",
    pid: ready.pid,
    launcher_pid: child.pid,
    visible: ready.visible,
    focused: ready.focused,
    stdout: stdoutFile,
    stderr: stderrFile,
    started_at: new Date().toISOString(),
  };
  return persistLatestLaunch(result);
}

async function main() {
  if (process.platform !== "win32") throw new Error("The desktop shortcut launcher currently supports Windows only.");
  const inspection = inspectDesktopRuntime();
  if (inspection.status === "already_running") {
    const activation = await requestWindowActivation();
    if (activation?.visible) {
      const result = persistLatestLaunch({
        ok: true,
        schema: "jcc-runtime-desktop-launch-v1",
        status: "existing_window_activated",
        visible: true,
        focused: Boolean(activation.focused),
        pid: activation.pid || inspection.pid,
        observed_at: new Date().toISOString(),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const recovered = await waitForExistingRuntimeVisible();
    if (recovered) {
      const result = persistLatestLaunch({
        ok: true,
        schema: "jcc-runtime-desktop-launch-v1",
        status: "existing_window_recovered",
        ...recovered,
        observed_at: new Date().toISOString(),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const result = await startRuntime("electron");
    process.stdout.write(`${JSON.stringify({ ...result, inspection }, null, 2)}\n`);
    return;
  }
  if (inspection.status !== "renderer_running") ensureBuiltUiAvailable();
  const result = await startRuntime(inspection.status === "renderer_running" ? "electron" : "start:built");
  process.stdout.write(`${JSON.stringify({ ...result, inspection }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const failure = persistLatestLaunch({
    ok: false,
    schema: "jcc-runtime-desktop-launch-v1",
    error: error?.message || String(error),
    details: error?.details || null,
    failed_at: new Date().toISOString(),
  });
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}
