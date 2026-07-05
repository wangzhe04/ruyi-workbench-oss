@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
REM Ruyi launcher (overlay v0.3+; formerly Win Claude Workbench).
REM ASCII-only on purpose: a Chinese comment here breaks parsing under the GBK code page.
REM Node-first: runs the (overlaid) app\server.js via the bundled Node runtime so UI/server changes
REM take effect without rebuilding the exe. Set WCW_FORCE_EXE=1 to force the baked exe instead.

if "%WCW_FORCE_EXE%"=="1" goto :exe

if exist "runtime\node\node.exe" if exist "app\server.js" (
  "runtime\node\node.exe" "app\server.js" serve --open
  goto :end
)

:exe
REM v1.0-S9: exe renamed to Ruyi.exe; dual-name compat -- try new name then legacy WinClaudeWorkbench.exe.
if exist "Ruyi.exe" (
  "Ruyi.exe" serve --open
  goto :end
)
if exist "WinClaudeWorkbench.exe" (
  "WinClaudeWorkbench.exe" serve --open
  goto :end
)

echo [Start-Workbench] Could not find runtime\node\node.exe + app\server.js, nor Ruyi.exe / WinClaudeWorkbench.exe.
echo Make sure you extracted the full package into this folder.
pause

:end
endlocal
