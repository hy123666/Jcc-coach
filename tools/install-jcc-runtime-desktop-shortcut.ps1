[CmdletBinding()]
param(
  [ValidateSet('Install', 'Remove')]
  [string]$Action = 'Install',
  [string]$DesktopPath,
  [string]$InstalledExecutable
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $DesktopPath) { $DesktopPath = [Environment]::GetFolderPath('Desktop') }
if (-not $DesktopPath) { throw 'Windows desktop path is unavailable.' }
New-Item -ItemType Directory -Force -Path $DesktopPath | Out-Null

$shortcutPath = Join-Path $DesktopPath 'JCC Runtime.lnk'
if ($Action -eq 'Remove') {
  Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{
    ok = $true
    schema = 'jcc-runtime-desktop-shortcut-v1'
    action = 'removed'
    shortcut = $shortcutPath
  } | ConvertTo-Json -Compress
  exit 0
}

$iconPath = Join-Path $repoRoot 'ui\assets\jcc-runtime.ico'
if (-not (Test-Path -LiteralPath $iconPath)) {
  & (Join-Path $PSScriptRoot 'build-jcc-runtime-windows-icon.ps1') | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ($InstalledExecutable) {
  $resolvedExecutable = (Resolve-Path $InstalledExecutable).Path
  $shortcut.TargetPath = $resolvedExecutable
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = Split-Path -Parent $resolvedExecutable
  $shortcut.IconLocation = "$resolvedExecutable,0"
  $targetKind = 'installed_executable'
} else {
  $hiddenLauncher = Join-Path $repoRoot 'tools\launch-jcc-runtime-hidden.vbs'
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + $hiddenLauncher + '"'
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.IconLocation = "$iconPath,0"
  $targetKind = 'developer_hidden_launcher'
}
$shortcut.Description = 'Open JCC Runtime Coach'
$shortcut.Save()

[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null

[pscustomobject]@{
  ok = $true
  schema = 'jcc-runtime-desktop-shortcut-v1'
  action = 'installed'
  target_kind = $targetKind
  shortcut = (Resolve-Path $shortcutPath).Path
  icon = $iconPath
} | ConvertTo-Json -Compress
