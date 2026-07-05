@echo off
setlocal
cd /d "%~dp0.."
set WIN_CLAUDE_WORKBENCH_HOME=%CD%\.wcwtest
set WCW_FAKE_CLAUDE=%CD%\tools\fake-claude.js
set WCW_FAKE_SCENARIO=happy
"dist\Ruyi-offline\runtime\node\node.exe" "app\server.js" serve --port 8799
