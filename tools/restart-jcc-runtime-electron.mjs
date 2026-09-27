import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message || String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildRenderer() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = process.platform === "win32"
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/c", "call", npm, "--prefix", "ui", "run", "build"]]
    : [npm, ["--prefix", "ui", "run", "build"]];
  const result = spawnSync(command[0], command[1], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(String(result.error?.message || result.stderr || result.stdout || "JCC Runtime UI build failed."));
  }
  return {
    command: `${npm} --prefix ui run build`,
    status: result.status,
  };
}

async function main() {
  const repo = repoRoot.replace(/\//g, "\\");
  const killScript = `
$repo = ${psString(repo)}
$selfPid = $PID
function Select-JccRuntimeProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.ProcessId -ne $selfPid -and
    $_.CommandLine -notlike '*tools\restart-jcc-runtime-electron.mjs*' -and
    @('node.exe','electron.exe','python.exe','esbuild.exe','cmd.exe','adb.exe') -contains $_.Name -and
    (
      $_.CommandLine -like "*$repo*ui*node_modules*" -or
      $_.CommandLine -like "*$repo*ui*electron*" -or
      $_.CommandLine -like "*runtime-daemon-server.js*" -or
      $_.CommandLine -like "*$repo*runtime-daemon-server.js*" -or
      $_.CommandLine -like "*$repo*run_jcc_rapidocr_jsonl_worker.py*" -or
      $_.CommandLine -like "*$repo*watch-jcc-mumu-runtime-logcat.mjs*" -or
      $_.CommandLine -like "*$repo*npm.cmd --prefix ui run start*" -or
      $_.CommandLine -like "*VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron .*" -or
      ($_.CommandLine -like "*wait-on http://127.0.0.1:5173*" -and $_.CommandLine -like "*$repo*") -or
      ($_.CommandLine -like "*vite*bin*vite.js*--host 127.0.0.1*" -and $_.CommandLine -like "*$repo*") -or
      ($_.CommandLine -like "*electron*cli.js*" -and $_.CommandLine -like "*$repo*") -or
      ($_.CommandLine -like "*electron.exe .*" -and $_.CommandLine -like "*$repo*")
    )
  }
}
$killed = @()
for ($i = 0; $i -lt 6; $i++) {
  $targets = @(Select-JccRuntimeProcesses)
  if ($targets.Count -eq 0) { break }
  $killed += $targets | Select-Object ProcessId,Name,CommandLine
  foreach ($p in $targets) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Milliseconds 500
}
$daemonInfo = Join-Path $repo '.jcc-runtime-data\runtime-daemon\daemon-info.json'
try { Remove-Item -LiteralPath $daemonInfo -Force -ErrorAction SilentlyContinue } catch {}
$deadline = (Get-Date).AddSeconds(8)
do {
  $listeners = @(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
$listeners = @(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $holders = foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    [PSCustomObject]@{ ProcessId = $listener.OwningProcess; Name = $proc.Name; CommandLine = $proc.CommandLine }
  }
  [PSCustomObject]@{ killed = $killed; port_5173_blocked = $holders } | ConvertTo-Json -Compress -Depth 6
  exit 20
}
[PSCustomObject]@{ killed = $killed; port_5173_free = $true } | ConvertTo-Json -Compress -Depth 6
`;
  const killed = await runPowerShell(killScript);
  if (killed.code !== 0) {
    throw new Error(killed.stderr || killed.stdout || "failed to stop existing JCC runtime processes");
  }

  const build = buildRenderer();

  const startScript = `
$repo = ${psString(repo)}
$logDir = Join-Path $repo '.jcc-runtime-data\\\\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$out = Join-Path $logDir ("ui-start-$runId.out.log")
$err = Join-Path $logDir ("ui-start-$runId.err.log")
$latestOut = Join-Path $logDir 'ui-start.out.log'
$latestErr = Join-Path $logDir 'ui-start.err.log'
$latestJson = Join-Path $logDir 'ui-start.latest.json'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
Set-Content -LiteralPath $out -Value '' -Encoding UTF8
Set-Content -LiteralPath $err -Value '' -Encoding UTF8
Set-Content -LiteralPath $latestOut -Value ("Current run stdout: " + $out) -Encoding UTF8
Set-Content -LiteralPath $latestErr -Value ("Current run stderr: " + $err) -Encoding UTF8
$cmd = 'cd /d "' + $repo + '" && "' + $npm + '" --prefix ui run start:built 1> "' + $out + '" 2> "' + $err + '"'
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $cmd) -WindowStyle Hidden -PassThru
$startInfo = [PSCustomObject]@{ pid = $p.Id; stdout = $out; stderr = $err; latest_stdout = $latestOut; latest_stderr = $latestErr; npm = $npm }
$startInfo | ConvertTo-Json -Compress | Set-Content -LiteralPath $latestJson -Encoding UTF8
$startInfo | ConvertTo-Json -Compress
`;
  const started = await runPowerShell(startScript);
  if (started.code !== 0) {
    throw new Error(started.stderr || started.stdout || "failed to start JCC runtime Electron");
  }
  console.log(JSON.stringify({
    ok: true,
    build,
    cleanup: killed.stdout.trim() ? JSON.parse(killed.stdout) : null,
    started: started.stdout.trim() ? JSON.parse(started.stdout) : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
