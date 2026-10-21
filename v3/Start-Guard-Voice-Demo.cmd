@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run the existing JagaAI setup first to create .venv.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8767 after the server starts.
echo This demo uses an isolated database and cannot send real messages or calls.
".venv\Scripts\python.exe" "scripts\guard-voice-demo.py" %*
pause
