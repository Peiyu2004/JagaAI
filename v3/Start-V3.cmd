@echo off
call "%~dp0..\Start-JagaAI.cmd" -Empty %*
exit /b %ERRORLEVEL%
