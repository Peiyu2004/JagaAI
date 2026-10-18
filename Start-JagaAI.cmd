@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-jagaai.ps1" %*
set "JAGAAI_EXIT=%ERRORLEVEL%"
if not "%JAGAAI_EXIT%"=="0" (
  echo.
  echo JagaAI could not start. See the error above and .runtime\setup\setup.log.
)
pause
exit /b %JAGAAI_EXIT%
