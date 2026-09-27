@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and reopen this launcher.
  pause
  exit /b 1
)
if not exist "ui\node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run: npm --prefix ui ci
  pause
  exit /b 1
)
node tools\launch-jcc-runtime-electron.mjs
if errorlevel 1 pause
