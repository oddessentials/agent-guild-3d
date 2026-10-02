@echo off
rem Double-click to open Agent Guild on Windows. Requires Node.js 22 or newer.
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist node_modules\node-pty (
  echo Installing Agent Guild dependencies. This happens once.
  call npm install --omit=dev --no-fund --no-audit
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
node bin\agent-guild.mjs open
if errorlevel 1 pause
