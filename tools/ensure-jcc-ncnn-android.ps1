param(
  [string]$Version = "20260526"
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Root = Join-Path $Repo ".omx\third_party\ncnn"
$Zip = Join-Path $Root "ncnn-$Version-android.zip"
$ExtractRoot = Join-Path $Root "ncnn-$Version-android"
$PackageRoot = Join-Path $ExtractRoot "ncnn-$Version-android"
$Required = @(
  (Join-Path $PackageRoot "arm64-v8a\lib\libncnn.a"),
  (Join-Path $PackageRoot "x86_64\lib\libncnn.a")
)

$allPresent = $true
foreach ($path in $Required) {
  if (-not (Test-Path $path)) {
    $allPresent = $false
    break
  }
}
if ($allPresent) {
  Write-Output "ncnn Android $Version already present"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (-not (Test-Path $Zip)) {
  $env:HTTPS_PROXY = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { "http://127.0.0.1:10808" }
  $env:HTTP_PROXY = if ($env:HTTP_PROXY) { $env:HTTP_PROXY } else { "http://127.0.0.1:10808" }
  $url = "https://github.com/Tencent/ncnn/releases/download/$Version/ncnn-$Version-android.zip"
  Write-Output "downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $Zip
}

if (Test-Path $ExtractRoot) {
  Remove-Item -LiteralPath $ExtractRoot -Recurse -Force
}
Expand-Archive -LiteralPath $Zip -DestinationPath $ExtractRoot -Force

foreach ($path in $Required) {
  if (-not (Test-Path $path)) {
    throw "missing required ncnn file after extraction: $path"
  }
}
Write-Output "ncnn Android $Version ready"
