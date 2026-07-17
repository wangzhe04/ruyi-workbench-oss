@echo off
setlocal EnableDelayedExpansion
title AI Computer Control - Incremental Update
chcp 65001 >nul 2>&1

REM Incremental updater for an ALREADY-INSTALLED ai-computer-control.
REM   update.bat            -> hot-copy new .py over the installed package (no deps, instant)
REM   update.bat --code     -> same as above
REM   update.bat --deps     -> pip-install desktop/OCR wheels from .\wheels (uiautomation, comtypes, winsdk)
REM Ship this file next to an updated "ai_computer_control\" source tree (and optional "wheels\").

set "INSTALL_DIR=%LOCALAPPDATA%\ai-computer-control"
set "SRC=%~dp0ai_computer_control"
set "MODE=%1"
if "%MODE%"=="" set "MODE=--code"

REM Two install layouts exist: new packages install a hydrated embedded runtime at
REM runtime\python (install.py), older ones built a venv at venv\. Probe both (new first).
set "PY="
set "SITEPKG="
if exist "%INSTALL_DIR%\runtime\python\python.exe" (
  set "PY=%INSTALL_DIR%\runtime\python\python.exe"
  set "SITEPKG=%INSTALL_DIR%\runtime\python\Lib\site-packages\ai_computer_control"
) else if exist "%INSTALL_DIR%\venv\Scripts\python.exe" (
  set "PY=%INSTALL_DIR%\venv\Scripts\python.exe"
  set "SITEPKG=%INSTALL_DIR%\venv\Lib\site-packages\ai_computer_control"
)

if not defined PY (
  echo [update] ERROR: not installed at "%INSTALL_DIR%" ^(no runtime\python or venv layout^). Run install.bat first.
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
set "WHEEL_DIR=%~dp0wheels"
if not exist "%WHEEL_DIR%" set "WHEEL_DIR=%~dp0offline_packages"
if not exist "%WHEEL_DIR%" set "WHEEL_DIR=%~dp0..\offline_packages"
if not exist "%WHEEL_DIR%" (
  echo [update] ERROR: no wheels\ or offline_packages\ directory was found. Rebuild the offline package,
  echo          or copy uiautomation/comtypes/winsdk wheels into wheels\ .
  exit /b 1
)
echo [update] Installing optional desktop and Windows OCR deps from local wheels (no internet)...
"%PY%" -m pip install --no-index --find-links "%WHEEL_DIR%" --no-deps --upgrade uiautomation comtypes winsdk
if errorlevel 1 ( echo [update] pip install failed. & exit /b 1 )
echo [update] Optional UI-Automation and Windows OCR deps installed. Now run: update.bat --code
goto end

:end
endlocal
