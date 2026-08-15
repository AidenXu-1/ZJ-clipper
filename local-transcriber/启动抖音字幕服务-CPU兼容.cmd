@echo off
setlocal
title Nomo Local Douyin Transcriber - CPU Mode
cd /d "%~dp0"
echo Nomo local Douyin transcriber - CPU compatibility mode
echo Keep this window open while transcribing.
echo.
where uv >nul 2>nul
if errorlevel 1 (
  echo ERROR: uv was not found in PATH.
  echo Ask Codex to install or configure uv first.
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ERROR: FFmpeg was not found in PATH.
  echo Ask Codex to install or configure FFmpeg first.
  pause
  exit /b 1
)
set "NOMO_DATA_DIR=%LOCALAPPDATA%\NomoClipper\Transcriber"
set "UV_CACHE_DIR=%NOMO_DATA_DIR%\uv-cache"
set "HF_HOME=%NOMO_DATA_DIR%\huggingface"
set "NOMO_DEVICE=cpu"
set "NOMO_WHISPER_MODEL=small"
echo CPU mode is slower but does not require NVIDIA CUDA libraries.
echo.
uv run --python 3.11 python server.py
set "NOMO_EXIT_CODE=%ERRORLEVEL%"
echo.
echo Nomo transcriber stopped. Exit code: %NOMO_EXIT_CODE%
pause
exit /b %NOMO_EXIT_CODE%
