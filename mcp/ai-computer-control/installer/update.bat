@echo off
setlocal EnableDelayedExpansion
title AI Computer Control - Incremental Update
chcp 65001 >nul 2>&1

REM Incremental updater for an ALREADY-INSTALLED ai-computer-control.
REM   update.bat            -> hot-copy new .py over the installed package (no deps, instant)
REM   update.bat --code     -> same as above
REM   update.bat --deps     -> pip-install new wheels from .\wheels (e.g. uiautomation, comtypes)
REM Ship this file next to an updated "ai_computer_control\" source tree (and optional "wheels\").

set "INSTALL_DIR=%LOCALAPPDATA%\ai-computer-control"
set "SITEPKG=%INSTALL_DIR%\venv\Lib\site-packages\ai_computer_control"
set "PY=%INSTALL_DIR%\venv\Scripts\python.exe"
set "SRC=%~dp0ai_computer_control"
set "MODE=%1"
if "%MODE%"=="" set "MODE=--code"

if not exist "%PY%" (
  echo [update] ERROR: not installed at "%INSTALL_DIR%". Run install.bat first.
  exit /b 1
)

if /I "%MODE%"=="--deps" goto deps

:code
if not exist "%SRC%" (
  echo [update] ERROR: source folder not found: "%SRC%"
  echo          Put the new ai_computer_control\ tree next to this update.bat.
  exit /b 1
)
if not exist "%SITEPKG%" (
  echo [update] ERROR: installed package not found at "%SITEPKG%".
  exit /b 1
)
echo [update] Mirroring updated .py into "%SITEPKG%" ...
REM /MIR mirrors deletions too (removes stale/renamed modules); keep __pycache__ and VERSION.txt.
robocopy "%SRC%" "%SITEPKG%" /MIR /XD __pycache__ /XF VERSION.txt >nul
REM robocopy exit codes: <8 = success (1 = files copied). >=8 = real failure.
if %ERRORLEVEL% GEQ 8 ( echo [update] copy failed ^(robocopy %ERRORLEVEL%^). & exit /b 1 )
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
> "%SITEPKG%\VERSION.txt" echo overlay-code %TS%
echo [update] Done. New/changed tools are live after the MCP server restarts.
echo          (In Claude, the server relaunches on next use; or restart Claude.)
goto end

:deps
if not exist "%~dp0wheels" (
  echo [update] ERROR: no wheels\ folder next to update.bat. Rebuild the offline package to get the wheels,
  echo          or copy uiautomation/comtypes wheels into wheels\ .
  exit /b 1
)
echo [update] Installing optional deps from local wheels (no internet)...
"%PY%" -m pip install --no-index --find-links "%~dp0wheels" --no-deps --upgrade uiautomation comtypes
if errorlevel 1 ( echo [update] pip install failed. & exit /b 1 )
echo [update] Optional UI-Automation deps installed. Now run: update.bat --code
goto end

:end
endlocal
