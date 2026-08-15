@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-native-host.ps1"
set "NOMO_EXIT=%ERRORLEVEL%"
echo.
if not "%NOMO_EXIT%"=="0" (
  echo Installation failed. Keep this window open and send the error to Codex.
) else (
  echo Installation completed. Reload Nomo Clipper once in chrome://extensions.
)
pause
exit /b %NOMO_EXIT%
