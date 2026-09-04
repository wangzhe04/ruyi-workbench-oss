@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions DisableDelayedExpansion
set "RUYI_ROOT=%~dp0"
cd /d "%RUYI_ROOT%" 2>nul
if errorlevel 1 (
  set "RUYI_MISSING=package directory"
  goto :package_incomplete
)

REM Fail early with an actionable message when this launcher was run from inside
REM the ZIP or Windows skipped files while extracting a long path.
if not exist "%RUYI_ROOT%package.json" (
  set "RUYI_MISSING=package.json"
  goto :package_incomplete
)
if not exist "%RUYI_ROOT%app\server.js" (
  set "RUYI_MISSING=app\server.js"
  goto :package_incomplete
)
if not exist "%RUYI_ROOT%runtime\node\node.exe" (
  set "RUYI_MISSING=runtime\node\node.exe"
  goto :package_incomplete
)

REM Prefer the standalone desktop shell: own window, own tray, closing it reaps the process tree.
REM Fall back to node + default browser when the exe/dll is absent (e.g. an unbuilt source checkout).
REM 118c: kept ASCII-only so cmd.exe parses this launcher identically under any console code page.
if exist "%RUYI_ROOT%RuyiDesktop.exe" if exist "%RUYI_ROOT%WebView2Loader.dll" (
  start "" "%RUYI_ROOT%RuyiDesktop.exe"
  exit /b 0
)

REM 118c: no black console window on the node fallback path any more. PowerShell starts node.exe
REM hidden and detached, then this launcher exits immediately, so the transient cmd window closes
REM at once instead of staying open for the whole session (and no pause on failure).
REM Paths travel through environment variables, never inline quoting, so a folder name with spaces,
REM single quotes or ampersands cannot break the command line.
REM Startup failures are not printed here: the server writes a plain-language last-start-error.json
REM into its data folder and the next successful launch shows it in the in-app notice bar.
set "RUYI_NODE=%RUYI_ROOT%runtime\node\node.exe"
set "RUYI_SERVER=%RUYI_ROOT%app\server.js"
powershell -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath $env:RUYI_NODE -ArgumentList @($env:RUYI_SERVER,'serve','--open') -WindowStyle Hidden"
if not errorlevel 1 exit /b 0

REM PowerShell unavailable (removed, or blocked by policy): start node directly so the workbench still
REM runs. This degraded path keeps one console window, which is better than not starting at all.
"%RUYI_NODE%" "%RUYI_SERVER%" serve --open
exit /b %ERRORLEVEL%

:package_incomplete
echo.
echo [Ruyi] PACKAGE INCOMPLETE - missing: %RUYI_MISSING%
echo.
echo Do not run Start-Workbench.cmd from inside the ZIP preview.
echo Right-click the downloaded ZIP, choose "Extract All", and then run
echo Start-Workbench.cmd from the extracted folder.
echo.
echo Recommended location: C:\Ruyi
echo Avoid deep OneDrive/Desktop paths. Never choose "Skip" during extraction.
echo See README-START-HERE.txt for Chinese and English instructions.
echo.
pause
exit /b 2
