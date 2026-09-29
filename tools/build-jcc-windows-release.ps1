[CmdletBinding()]
param(
  [string]$ReleaseRoot = 'F:\Jcc-coach',
  [string]$Version = '0.1.4',
  [string]$ExpectedStatDate,
  [string]$BuildRoot,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = (Resolve-Path $ReleaseRoot).Path
$rankingSource = Join-Path $repoRoot 'data\live-rankings\jcc'
$rankingTarget = Join-Path $releaseRoot 'data\live-rankings\jcc'
$uiRoot = Join-Path $releaseRoot 'ui'
$packageJson = Join-Path $uiRoot 'package.json'
$lockFile = Join-Path $uiRoot 'package-lock.json'

if (-not (Test-Path (Join-Path $releaseRoot '.git'))) {
  throw "Release root is not a Git checkout: $releaseRoot"
}
if (-not (Test-Path $packageJson)) { throw "Missing release package manifest: $packageJson" }

$manifest = Get-Content (Join-Path $rankingSource 'current\manifest.json') -Raw | ConvertFrom-Json
$actualStatDate = [string]$manifest.current.stat_date
if (-not $ExpectedStatDate) { $ExpectedStatDate = $actualStatDate }
if ($actualStatDate -ne $ExpectedStatDate) {
  throw "Expected Ranking stat date $ExpectedStatDate, but active manifest is $actualStatDate"
}

node (Join-Path $repoRoot 'tools\verify-jcc-release-ranking.mjs') --root $repoRoot --expected-stat-date $ExpectedStatDate
if ($LASTEXITCODE -ne 0) { throw 'Development Ranking release verification failed' }

node (Join-Path $repoRoot 'tools\jcc-release-source-sync.mjs') $repoRoot $releaseRoot sync
if ($LASTEXITCODE -ne 0) { throw 'Release source synchronization failed' }

foreach ($relative in @('data\game-knowledge\jcc', 'data\core-patches\jcc')) {
  $source = Join-Path $repoRoot $relative
  $target = Join-Path $releaseRoot $relative
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $cursor = Get-Item -LiteralPath $target
  while ($cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Core target traverses a reparse point: $($cursor.FullName)" }
    $cursor = $cursor.Parent
  }
  if (-not ([IO.Path]::GetFullPath($target).StartsWith($releaseRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Core target is outside release root' }
  & robocopy $source $target /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS
  if ($LASTEXITCODE -gt 7) { throw "Core sync failed with robocopy exit code $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force -Path $rankingTarget | Out-Null
# /MIR may delete retired generations. Reject redirected destinations first.
$cursor = Get-Item -LiteralPath $rankingTarget
while ($cursor) {
  if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Ranking target traverses a reparse point: $($cursor.FullName)" }
  $cursor = $cursor.Parent
}
if (-not ([IO.Path]::GetFullPath($rankingTarget).StartsWith($releaseRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Ranking target is outside release root' }
& robocopy $rankingSource $rankingTarget /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -gt 7) { throw "Ranking sync failed with robocopy exit code $LASTEXITCODE" }

$releasePackage = Get-Content $packageJson -Raw | ConvertFrom-Json
if ([string]$releasePackage.version -ne $Version) { throw 'Release package.json version mismatch' }
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if (p.version !== process.argv[2] || p.packages?.['']?.version !== process.argv[2]) process.exit(2);" $lockFile $Version
if ($LASTEXITCODE -ne 0) { throw 'Release package-lock.json version mismatch' }
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const b=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); if (!a.core_profile_id || a.core_profile_id !== b.core_profile_id) process.exit(2);" (Join-Path $repoRoot 'data\game-knowledge\jcc\active-profile.json') (Join-Path $releaseRoot 'data\game-knowledge\jcc\active-profile.json')
if ($LASTEXITCODE -ne 0) { throw 'Release Core profile differs from development Core' }
node (Join-Path $repoRoot 'tools\verify-jcc-release-ranking.mjs') --root $releaseRoot --expected-stat-date $ExpectedStatDate
if ($LASTEXITCODE -ne 0) { throw 'Release Ranking closure verification failed' }

if (-not $SkipBuild) {
  Push-Location $uiRoot
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Locked release dependency installation failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Fresh renderer build failed' }
  } finally {
    Pop-Location
  }
  node (Join-Path $releaseRoot 'tools\verify-jcc-windows-installer-resources.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer resources are incomplete' }
  node (Join-Path $releaseRoot 'tools\verify-jcc-uninstall-user-data.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Windows uninstaller verification failed' }
  Push-Location $releaseRoot
  try {
    node tools/verify-jcc-renderer-event-delivery.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Release renderer delivery regression failed' }
  } finally {
    Pop-Location
  }
  if (-not $BuildRoot) { $BuildRoot = Join-Path (Split-Path $releaseRoot -Parent) 'jcc-runtime-builds' }
  New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
  $buildOutput = Join-Path $BuildRoot ("jcc-release-$Version-$([guid]::NewGuid().ToString('N'))")
  $releaseOutput = Join-Path $uiRoot "release-$Version"
  $installerName = "JCC-Runtime-$Version-x64.exe"
  Push-Location $uiRoot
  try {
    node (Join-Path $repoRoot 'tools\jcc-release-source-sync.mjs') $repoRoot $releaseRoot verify
    if ($LASTEXITCODE -ne 0) { throw 'Source changed during renderer build' }
    & (Join-Path $uiRoot 'node_modules\.bin\electron-builder.cmd') --config electron-builder.yml "--config.directories.output=$buildOutput" --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Windows package build failed' }
    node (Join-Path $repoRoot 'tools\verify-jcc-packaged-source.mjs') $repoRoot $releaseRoot (Join-Path $buildOutput 'win-unpacked')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged application differs from development sources or fresh renderer' }
    node (Join-Path $releaseRoot 'tools\verify-jcc-packaged-daemon.mjs') (Join-Path $buildOutput 'win-unpacked')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged daemon verification failed' }
    node (Join-Path $releaseRoot 'tools\verify-jcc-packaged-cruise.mjs') (Join-Path $buildOutput 'win-unpacked')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Cruise or offline dependency verification failed' }
    $installer = Join-Path $buildOutput $installerName
    if (-not (Test-Path -LiteralPath $installer)) { throw "Installer is missing: $installer" }
    New-Item -ItemType Directory -Force -Path $releaseOutput | Out-Null
    Copy-Item -LiteralPath $installer -Destination $releaseOutput -Force
    Copy-Item -LiteralPath "$installer.blockmap" -Destination $releaseOutput -Force
    $sourceHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath (Join-Path $releaseOutput $installerName) -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw 'Published installer hash mismatch' }
  } finally {
    Pop-Location
    if ($buildOutput -and (Test-Path -LiteralPath $buildOutput)) {
      $resolvedBuildOutput = (Resolve-Path -LiteralPath $buildOutput).Path
      $resolvedBuildRoot = (Resolve-Path -LiteralPath $BuildRoot).Path.TrimEnd('\') + '\'
      if (-not $resolvedBuildOutput.StartsWith($resolvedBuildRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build cleanup escaped build root' }
      try {
        Remove-Item -LiteralPath $buildOutput -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Warning "Build output was not fully removed: $buildOutput. $($_.Exception.Message)"
      }
    }
  }
}

Write-Output (ConvertTo-Json -Depth 5 ([ordered]@{
  ok = $true
  version = $Version
  ranking_stat_date = $ExpectedStatDate
  release_root = $releaseRoot
  build_skipped = [bool]$SkipBuild
}))
