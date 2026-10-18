@echo off
call "%~dp0Start-JagaAI.cmd" -SetupOnly %*
exit /b %ERRORLEVEL%
