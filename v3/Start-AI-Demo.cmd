@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Missing v3 Python environment. See README.md, "Quick start for judges".
  pause
  exit /b 1
)
".venv\Scripts\python.exe" run.py --demo
pause
