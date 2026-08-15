@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-native-host.ps1"
set "NOMO_EXIT=%ERRORLEVEL%"
echo.
if not "%NOMO_EXIT%"=="0" echo Uninstall failed. Keep this window open and send the error to Codex.
pause
exit /b %NOMO_EXIT%
