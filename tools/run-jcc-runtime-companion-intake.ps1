param(
  [int]$Port = 49377,
  [string]$HostName = "127.0.0.1",
  [string]$MatchSessionId = "",
  [string]$Output = ""
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Args = @(
  (Join-Path $Repo "tools\jcc-runtime-companion-intake-server.mjs"),
  "--host", $HostName,
  "--port", "$Port"
)

if ($MatchSessionId) {
  $Args += @("--match-session-id", $MatchSessionId)
}
if ($Output) {
  $Args += @("--output", $Output)
}

node @Args
