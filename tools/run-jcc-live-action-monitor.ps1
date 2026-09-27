param(
  [string]$Adb = ".omx\bin\adb.exe",
  [string]$Device = "127.0.0.1:7555",
  [string]$OutRoot = ".omx\runtime-evidence",
  [int]$IntervalSeconds = 2,
  [int]$AdbConnectTimeoutSeconds = 1,
  [string]$RemoteNetRoot = "/sdcard/Android/data/com.tencent.jkchess/files/yxzg/net",
  [int]$NetTailFileCount = 5,
  [switch]$KeepProbeArtifacts
)

$ErrorActionPreference = "Continue"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$started = Get-Date
$stamp = $started.ToString("yyyyMMdd-HHmmss")
$sessionDir = Join-Path $OutRoot "live-action-monitor-$stamp"
New-Item -ItemType Directory -Force $sessionDir | Out-Null

$stopFile = Join-Path $sessionDir "STOP"
$eventsFile = Join-Path $sessionDir "monitor-events.ndjson"
$previousSignalsCache = Join-Path $sessionDir "previous-signals-cache.json"
$stateFile = ".omx\state\jcc-live-action-monitor.json"
New-Item -ItemType Directory -Force (Split-Path $stateFile) | Out-Null

function Write-JsonLine($Path, $Value) {
  $Value | ConvertTo-Json -Depth 30 -Compress | Add-Content -Encoding UTF8 $Path
}

function Write-JsonLineText($Path, $Text) {
  $Text | Add-Content -Encoding UTF8 $Path
}

function Read-TextViaNode($Path) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $script = @"
const fs = require("node:fs");
const file = process.argv[1];
process.stdout.write(fs.readFileSync(file, "utf8"));
"@
  $text = & node -e $script $resolved
  if ($LASTEXITCODE -ne 0) {
    throw "Node UTF-8 text read failed for $resolved"
  }
  return $text
}

function Short-Error($Value) {
  $text = [string]$Value
  $text = $text -replace "[\r\n]+", " "
  if ($text.Length -gt 500) { return $text.Substring(0, 500) }
  return $text
}

function Write-State($Status, $Extra = @{}) {
  $state = @{
    active = $Status -eq "running"
    status = $Status
    pid = $PID
    adb = $Adb
    device = $Device
    remote_net_root = $RemoteNetRoot
    session_dir = (Resolve-Path $sessionDir).Path
    stop_file = (Resolve-Path $sessionDir).Path + "\STOP"
    updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }
  $state | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $stateFile
}

function Quote-Arg($Value) {
  $arg = [string]$Value
  if ($arg -match '[\s"]') {
    return '"' + ($arg -replace '"', '\"') + '"'
  }
  return $arg
}

function Invoke-AdbQuick($Arguments, $TimeoutSeconds = 5) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Adb
  $psi.Arguments = (($Arguments | ForEach-Object { Quote-Arg $_ }) -join " ")
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

function Ensure-AdbDeviceOnline() {
  if (Test-AdbDeviceOnline) { return $true }
  [void](Invoke-AdbQuick @("connect", $Device) $AdbConnectTimeoutSeconds)
  return (Test-AdbDeviceOnline)
}

function Get-LatestRemoteNetFiles() {
  $dateResult = Invoke-AdbQuick @("-s", $Device, "shell", "ls -t $RemoteNetRoot 2>/dev/null | head -n 1") 3
  if (-not $dateResult.ok) { return $null }
  $dateDir = (($dateResult.stdout -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  if (-not $dateDir) { return $null }
  $count = [Math]::Max(1, $NetTailFileCount)
  $fileResult = Invoke-AdbQuick @("-s", $Device, "shell", "ls -t $RemoteNetRoot/$dateDir 2>/dev/null | head -n $count") 3
  if (-not $fileResult.ok) { return $null }
  $fileNames = @($fileResult.stdout -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
  if ($fileNames.Count -eq 0) { return $null }
  return @($fileNames | ForEach-Object { "$RemoteNetRoot/$dateDir/$_" })
}

function Get-RemoteStat($RemoteFile) {
  $stat = Invoke-AdbQuick @("-s", $Device, "shell", "stat -c '%s %Y' $RemoteFile") 3
  if (-not $stat.ok) { return $null }
  $line = (($stat.stdout -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  if ($line -notmatch '^([0-9]+)\s+([0-9]+)$') { return $null }
  return @{
    size = [int64]$matches[1]
    mtime = [int64]$matches[2]
    key = "$RemoteFile|$($matches[1])|$($matches[2])"
  }
}

function Get-RemoteFilesStat($RemoteFiles) {
  $stats = @()
  foreach ($remoteFile in $RemoteFiles) {
    $stat = Get-RemoteStat $remoteFile
    if (-not $stat) { return $null }
    $stats += @($stat + @{ remote_file = $remoteFile })
  }
  return @{
    files = $stats
    key = (($stats | ForEach-Object { $_.key }) -join "`n")
    latest = $stats[0]
    total_size = [int64](($stats | Measure-Object -Property size -Sum).Sum)
  }
}

$meta = @{
  started_at = $started.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  adb = $Adb
  device = $Device
  interval_seconds = $IntervalSeconds
  remote_net_root = $RemoteNetRoot
  net_tail_file_count = $NetTailFileCount
  keep_probe_artifacts = [bool]$KeepProbeArtifacts
  session_dir = (Resolve-Path $sessionDir).Path
  stop_file = (Resolve-Path $sessionDir).Path + "\STOP"
  note = "Read-only lightweight monitor: pulls recent current-day net files so GameStart and later local actions stay in one match-scoped parse; raw probe artifacts are deleted unless -KeepProbeArtifacts is set."
}
$meta | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 (Join-Path $sessionDir "monitor-meta.json")
Write-State "running" @{ iteration = 0 }
Write-JsonLine $eventsFile @{ event = "monitor_started"; meta = $meta }

$previousSignals = $null
$lastKey = $null
$iteration = 0
try {
  while (-not (Test-Path $stopFile)) {
    $iteration += 1
    $iterStamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $probeDir = Join-Path $sessionDir ("probe_{0:0000}_{1}" -f $iteration, $iterStamp)
    New-Item -ItemType Directory -Force $probeDir | Out-Null
    Write-State "running" @{ iteration = $iteration; current_probe_dir = (Resolve-Path $probeDir).Path }

    try {
      if (-not (Ensure-AdbDeviceOnline)) {
        Write-JsonLine $eventsFile @{ event = "probe_skipped_adb_offline"; iteration = $iteration; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }

      $remoteFiles = @(Get-LatestRemoteNetFiles)
      if ($remoteFiles.Count -eq 0) {
        Write-JsonLine $eventsFile @{ event = "probe_skipped_no_net_file"; iteration = $iteration; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }

      $remoteStat = Get-RemoteFilesStat $remoteFiles
      if (-not $remoteStat) {
        Write-JsonLine $eventsFile @{ event = "probe_skipped_no_stat"; iteration = $iteration; remote_files = $remoteFiles; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }

      if ($remoteStat.key -eq $lastKey) {
        Write-JsonLine $eventsFile @{ event = "probe_skipped_unchanged"; iteration = $iteration; remote_file = $remoteStat.latest.remote_file; remote_file_count = $remoteFiles.Count; size = $remoteStat.total_size; mtime = $remoteStat.latest.mtime; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }

      $localNet = Join-Path $probeDir "net-tail"
      New-Item -ItemType Directory -Force $localNet | Out-Null
      $pullLog = @()
      $pullFailed = $false
      foreach ($remoteFile in $remoteFiles) {
        $localFile = Join-Path $localNet (Split-Path $remoteFile -Leaf)
        $pull = Invoke-AdbQuick @("-s", $Device, "pull", $remoteFile, $localFile) 10
        $pullLog += @("[$remoteFile]", $pull.stdout, $pull.stderr)
        if (-not $pull.ok) {
          Write-JsonLine $eventsFile @{ event = "probe_pull_failed"; iteration = $iteration; remote_file = $remoteFile; error = $pull.stderr; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
          $pullFailed = $true
          break
        }
      }
      ($pullLog -join "`n") | Set-Content -Encoding UTF8 (Join-Path $probeDir "pull-net.txt")
      $remoteFiles | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $probeDir "remote-net-files.json")
      if ($pullFailed) {
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }

      $signals = Join-Path $probeDir "candidate-runtime-signals.json"
      $liveState = Join-Path $probeDir "match-live-state.json"
      $actionDelta = Join-Path $probeDir "current-match-action-delta.json"
      & node tools\extract-jcc-android-runtime-signals.mjs --input $localNet --out $signals *>&1 | Set-Content -Encoding UTF8 (Join-Path $probeDir "extract.log")
      & node tools\build-jcc-match-live-state.mjs --signals $signals --out $liveState *>&1 | Set-Content -Encoding UTF8 (Join-Path $probeDir "build-live-state.log")
      if ($previousSignals -and (Test-Path $previousSignals)) {
        & node tools\diff-jcc-current-match-actions.mjs --before $previousSignals --after $signals --out $actionDelta *>&1 | Set-Content -Encoding UTF8 (Join-Path $probeDir "diff-actions.log")
      }

      $summary = Join-Path $probeDir "monitor-summary.json"
      $eventJson = Join-Path $probeDir "monitor-event.jsonl"
      $summarizeArgs = @(
        "tools\summarize-jcc-live-action-monitor-probe.mjs",
        "--signals", $signals,
        "--live-state", $liveState,
        "--out-summary", $summary,
        "--out-event", $eventJson,
        "--iteration", $iteration,
        "--probe-dir", (Resolve-Path $probeDir).Path,
        "--remote-file", $remoteStat.latest.remote_file,
        "--remote-size", $remoteStat.total_size,
        "--remote-mtime", $remoteStat.latest.mtime
      )
      if (Test-Path $actionDelta) {
        $summarizeArgs += @("--delta", $actionDelta)
      }
      & node $summarizeArgs *>&1 | Set-Content -Encoding UTF8 (Join-Path $probeDir "summarize.log")
      if (Test-Path $eventJson) {
        Write-JsonLineText $eventsFile (Read-TextViaNode $eventJson)
      }
      if (-not $KeepProbeArtifacts) {
        Copy-Item -LiteralPath $signals -Destination $previousSignalsCache -Force
        $previousSignals = $previousSignalsCache
      } else {
        $previousSignals = $signals
      }
      $lastKey = $remoteStat.key
      if (-not $KeepProbeArtifacts) {
        foreach ($artifact in @($localNet, $signals, $liveState, $actionDelta, (Join-Path $probeDir "extract.log"), (Join-Path $probeDir "build-live-state.log"), (Join-Path $probeDir "diff-actions.log"), (Join-Path $probeDir "pull-net.txt"), (Join-Path $probeDir "remote-net-files.json"))) {
          if ($artifact -and (Test-Path $artifact)) {
            Remove-Item -LiteralPath $artifact -Recurse -Force -ErrorAction SilentlyContinue
          }
        }
      }
    } catch {
      Write-JsonLine $eventsFile @{ event = "probe_error"; iteration = $iteration; error = (Short-Error $_.Exception.Message); at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    }

    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  if (-not $KeepProbeArtifacts -and (Test-Path $previousSignalsCache)) {
    Remove-Item -LiteralPath $previousSignalsCache -Force -ErrorAction SilentlyContinue
  }
  Write-State "stopped" @{ stopped_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  Write-JsonLine $eventsFile @{ event = "monitor_stopped"; at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
}
