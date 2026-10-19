@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-server.ps1" %*
pause
