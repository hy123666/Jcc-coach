param(
  [string]$Version = "4.13.0",
  [string]$Tag = "v35",
  [string]$Proxy = "http://127.0.0.1:10808"
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Root = Join-Path $Repo ".omx\third_party\opencv-mobile"
$Zip = Join-Path $Root "opencv-mobile-$Version-android.zip"
$Extracted = Join-Path $Root "opencv-mobile-$Version-android"
$Config = Join-Path $Extracted "sdk\native\jni\OpenCVConfig.cmake"

New-Item -ItemType Directory -Force -Path $Root | Out-Null

if (-not (Test-Path $Config)) {
  $Url = "https://github.com/nihui/opencv-mobile/releases/download/$Tag/opencv-mobile-$Version-android.zip"
  if (-not (Test-Path $Zip)) {
    Write-Host "Downloading opencv-mobile Android $Version from $Url"
    $oldHttps = $env:HTTPS_PROXY
    $oldHttp = $env:HTTP_PROXY
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
    try {
      Invoke-WebRequest -Uri $Url -OutFile $Zip
    } finally {
      $env:HTTPS_PROXY = $oldHttps
      $env:HTTP_PROXY = $oldHttp
    }
  }

  Write-Host "Extracting $Zip"
  Expand-Archive -Force -Path $Zip -DestinationPath $Root
}

if (-not (Test-Path $Config)) {
  throw "Missing OpenCV Android config after install: $Config"
}

Write-Host "opencv-mobile Android $Version present at $Extracted"
