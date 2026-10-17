@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo JagaAI local application: http://127.0.0.1:5173
echo Keep this window open. Press Ctrl+C to stop.
node scripts/dev.mjs
pause
