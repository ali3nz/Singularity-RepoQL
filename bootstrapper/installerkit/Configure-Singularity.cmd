@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-Singularity.ps1" -Mode Wizard
exit /b %ERRORLEVEL%
