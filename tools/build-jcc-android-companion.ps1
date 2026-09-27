param(
  [string]$Task = ":app:assembleDebug"
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Tools = Join-Path $Repo ".omx\tools"
$env:JAVA_HOME = Join-Path $Tools "jdk-17.0.19+10"
$env:ANDROID_HOME = Join-Path $Tools "android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$GradleHomeRoot = if ($env:TEMP) { $env:TEMP } else { Join-Path $Repo ".omx" }
$env:GRADLE_USER_HOME = Join-Path $GradleHomeRoot "jcc-runtime-gradle-home"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$GradleDir = if (Test-Path (Join-Path $Tools "gradle-9.4.1\bin\gradle.bat")) { Join-Path $Tools "gradle-9.4.1" } else { Join-Path $Tools "gradle-8.13" }
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$GradleDir\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "ensure-jcc-ncnn-android.ps1")
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "ensure-jcc-opencv-mobile-android.ps1")

$Gradle = Join-Path $GradleDir "bin\gradle.bat"
$Project = Join-Path $Repo "android-companion"
& $Gradle --no-daemon --no-build-cache --max-workers=1 $Task -p $Project
