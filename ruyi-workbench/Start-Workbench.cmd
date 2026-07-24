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

"%RUYI_ROOT%runtime\node\node.exe" "%RUYI_ROOT%app\server.js" serve --open
set "RUYI_EXIT=%ERRORLEVEL%"
if not "%RUYI_EXIT%"=="0" (
  echo.
  echo [Ruyi] Workbench stopped with exit code %RUYI_EXIT%.
  pause
)
exit /b %RUYI_EXIT%

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
