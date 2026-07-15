@echo off
chcp 65001 >nul 2>&1
title AI Computer Control - Offline Installer
echo ============================================================
echo   AI Computer Control - One-Click Offline Installer
echo ============================================================
echo.

:: A verified full package always prefers its bundled runtime.  This makes the
:: result independent of Microsoft Store aliases and the machine's Python ABI.
if exist "%~dp0python_embed\python.exe" (
    echo Using bundled offline Python...
    "%~dp0python_embed\python.exe" -X utf8 "%~dp0install.py"
) else (
    where python >nul 2>&1
    if %errorlevel% equ 0 (
        echo Bundled runtime absent; trying legacy system-Python fallback...
        python -X utf8 "%~dp0install.py"
    ) else (
        echo ERROR: bundled runtime is missing and no system Python was found.
        exit /b 1
    )
)

echo.
pause
