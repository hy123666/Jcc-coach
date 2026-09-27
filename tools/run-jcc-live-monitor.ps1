param(
  [string]$Adb = "G:\005-娱乐类\mumu\MuMuPlayer\nx_device\12.0\shell\adb.exe",
  [string]$Device = "127.0.0.1:7555",
  [string]$OutRoot = ".omx\runtime-evidence",
  [int]$IntervalSeconds = 10,
  [int]$AdbConnectTimeoutSeconds = 2,
  [string]$Scope = "planning_shop"
)

$ErrorActionPreference = "Continue"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$started = Get-Date
$stamp = $started.ToString("yyyyMMdd-HHmmss")
$sessionDir = Join-Path $OutRoot "live-monitor-$stamp"
New-Item -ItemType Directory -Force $sessionDir | Out-Null

$stopFile = Join-Path $sessionDir "STOP"
$logFile = Join-Path $sessionDir "adb-logcat-live.txt"
$logErrFile = Join-Path $sessionDir "adb-logcat-live.err.txt"
$eventsFile = Join-Path $sessionDir "monitor-events.ndjson"
$stateFile = ".omx\state\jcc-live-monitor.json"
New-Item -ItemType Directory -Force (Split-Path $stateFile) | Out-Null

function Write-JsonLine($Path, $Value) {
  $Value | ConvertTo-Json -Depth 12 -Compress | Add-Content -Encoding UTF8 $Path
}

function Read-JsonViaNode($Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $script = @"
const fs = require("node:fs");
const file = process.argv[1];
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
process.stdout.write(JSON.stringify(parsed));
"@
  $json = & node -e $script $resolved
  if ($LASTEXITCODE -ne 0) {
    throw "Node UTF-8 JSON read failed for $resolved"
  }
  return $json | ConvertFrom-Json
}

function Write-State($Status, $Extra = @{}) {
  $state = @{
    active = $Status -eq "running"
    status = $Status
    pid = $PID
    adb = $Adb
    device = $Device
    scope = $Scope
    session_dir = (Resolve-Path $sessionDir).Path
    stop_file = (Resolve-Path $sessionDir).Path + "\STOP"
    updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }
  $state | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $stateFile
}

function Invoke-AdbQuick($Arguments, $TimeoutSeconds = 5) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Adb
  $psi.Arguments = (($Arguments | ForEach-Object {
    $arg = [string]$_
    if ($arg -match '[\s"]') {
      '"' + ($arg -replace '"', '\"') + '"'
    } else {
      $arg
    }
  }) -join " ")
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch {}
    return @{
      ok = $false
      exit_code = $null
      stdout = ""
      stderr = "timed out after ${TimeoutSeconds}s"
      timed_out = $true
    }
  }
  return @{
    ok = $process.ExitCode -eq 0
    exit_code = $process.ExitCode
    stdout = $process.StandardOutput.ReadToEnd()
    stderr = $process.StandardError.ReadToEnd()
    timed_out = $false
  }
}

function Test-AdbDeviceOnline() {
  $result = Invoke-AdbQuick @("devices") 2
  if (-not $result.ok) { return $false }
  foreach ($line in ($result.stdout -split "`r?`n")) {
    if ($line.Trim() -eq "$Device`tdevice") { return $true }
  }
  return $false
}

function Ensure-AdbDeviceOnline($LogPath) {
  if (Test-AdbDeviceOnline) {
    "adb device already online: $Device" | Add-Content -Encoding UTF8 $LogPath
    return $true
  }
  $connect = Invoke-AdbQuick @("connect", $Device) $AdbConnectTimeoutSeconds
  "adb connect $Device exit=$($connect.exit_code) timed_out=$($connect.timed_out)" | Add-Content -Encoding UTF8 $LogPath
  if ($connect.stdout) { $connect.stdout | Add-Content -Encoding UTF8 $LogPath }
  if ($connect.stderr) { $connect.stderr | Add-Content -Encoding UTF8 $LogPath }
  return (Test-AdbDeviceOnline)
}

$meta = @{
  started_at = $started.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  adb = $Adb
  device = $Device
  scope = $Scope
  interval_seconds = $IntervalSeconds
  adb_connect_timeout_seconds = $AdbConnectTimeoutSeconds
  session_dir = (Resolve-Path $sessionDir).Path
  stop_file = (Resolve-Path $sessionDir).Path + "\STOP"
  note = "Create STOP file or kill monitor pid to stop. This monitor is read-only."
}
$meta | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $sessionDir "monitor-meta.json")
Write-State "running" @{ iteration = 0 }
Write-JsonLine $eventsFile @{ event = "monitor_started"; meta = $meta }

$logcat = $null
$previousSignals = $null
try {
  $initialConnectLog = Join-Path $sessionDir "adb-connect-initial.txt"
  $initialOnline = Ensure-AdbDeviceOnline $initialConnectLog
  Write-JsonLine $eventsFile @{ event = "adb_initial_ready"; online = $initialOnline; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  $logcat = Start-Process -FilePath $Adb -ArgumentList @("-s", $Device, "logcat", "-v", "threadtime") -RedirectStandardOutput $logFile -RedirectStandardError $logErrFile -NoNewWindow -PassThru
  Write-JsonLine $eventsFile @{ event = "logcat_started"; pid = $logcat.Id; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

  $iteration = 0
  while (-not (Test-Path $stopFile)) {
    $iteration += 1
    $iterStamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $probeDir = Join-Path $sessionDir ("probe_{0:0000}_{1}" -f $iteration, $iterStamp)
    New-Item -ItemType Directory -Force $probeDir | Out-Null
    Write-State "running" @{ iteration = $iteration; current_probe_dir = (Resolve-Path $probeDir).Path }
    Write-JsonLine $eventsFile @{ event = "probe_started"; iteration = $iteration; dir = (Resolve-Path $probeDir).Path; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

    $probeLog = Join-Path $probeDir "monitor-command.log"
    try {
      $online = Ensure-AdbDeviceOnline $probeLog
      if (-not $online) {
        Write-JsonLine $eventsFile @{ event = "probe_skipped_adb_offline"; iteration = $iteration; dir = (Resolve-Path $probeDir).Path; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }
      & $Adb -s $Device get-state *>&1 | Add-Content -Encoding UTF8 $probeLog
      & node tools\probe-jcc-android-runtime.mjs --adb $Adb --device $Device --scope $Scope --out $probeDir *>&1 | Tee-Object -FilePath $probeLog | Out-Null
      $probeReport = Join-Path $probeDir "probe-report.json"
      $signals = Join-Path $probeDir "candidate-runtime-signals.json"
      $liveState = Join-Path $probeDir "match-live-state.json"
      if (Test-Path $probeReport) {
        & node tools\extract-jcc-android-runtime-signals.mjs --input $probeReport --out $signals *>&1 | Add-Content -Encoding UTF8 $probeLog
      }
      if (Test-Path $signals) {
        & node tools\build-jcc-match-live-state.mjs --signals $signals --out $liveState *>&1 | Add-Content -Encoding UTF8 $probeLog
      }
      $actionDelta = Join-Path $probeDir "current-match-action-delta.json"
      if ((Test-Path $signals) -and $previousSignals -and (Test-Path $previousSignals)) {
        & node tools\diff-jcc-current-match-actions.mjs --before $previousSignals --after $signals --out $actionDelta *>&1 | Add-Content -Encoding UTF8 $probeLog
      }
      if ((Test-Path $signals) -and (Test-Path $liveState)) {
        $signalJson = Read-JsonViaNode $signals
        $stateJson = Read-JsonViaNode $liveState
        $actionDeltaJson = $null
        if (Test-Path $actionDelta) {
          $actionDeltaJson = Read-JsonViaNode $actionDelta
        }
        $summary = @{
          iteration = $iteration
          captured_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
          probe_dir = (Resolve-Path $probeDir).Path
          signal_count = $signalJson.signal_count
          signal_counts = $signalJson.signal_counts
          ok = $stateJson.ok
          match = $stateJson.match
          gate = $stateJson.live_state.gate
          board_units_count = @($stateJson.live_state.board.board_units).Count
          bench_units_count = @($stateJson.live_state.bench.bench_units).Count
          board_units = $stateJson.live_state.board.board_units
          bench_units = $stateJson.live_state.bench.bench_units
          action_candidates = $stateJson.live_state.source_insights.board_bench_action_candidates
          current_match_action_delta = $actionDeltaJson
          folded_board_bench_state = $stateJson.live_state.source_insights.folded_board_bench_state
        }
        $summary | ConvertTo-Json -Depth 40 | Set-Content -Encoding UTF8 (Join-Path $probeDir "monitor-summary.json")
        Write-JsonLine $eventsFile @{ event = "probe_completed"; summary = $summary }
      } else {
        Write-JsonLine $eventsFile @{ event = "probe_incomplete"; iteration = $iteration; dir = (Resolve-Path $probeDir).Path }
      }
      if (Test-Path $signals) {
        $previousSignals = $signals
      }
    } catch {
      Write-JsonLine $eventsFile @{ event = "probe_error"; iteration = $iteration; error = $_.Exception.Message; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    }

    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  if ($logcat -and -not $logcat.HasExited) {
    Stop-Process -Id $logcat.Id -Force -ErrorAction SilentlyContinue
  }
  Write-State "stopped" @{ stopped_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  Write-JsonLine $eventsFile @{ event = "monitor_stopped"; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
}
