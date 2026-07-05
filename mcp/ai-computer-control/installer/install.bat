@echo off
chcp 65001 >nul 2>&1
title AI Computer Control - Offline Installer
echo ============================================================
echo   AI Computer Control - One-Click Offline Installer
echo ============================================================
echo.

:: Try to find Python
where python >nul 2>&1
if %errorlevel% equ 0 (
    echo Found system Python:
    python --version
    echo.
    python "%~dp0install.py"
) else (
    :: Try embedded Python
    if exist "%~dp0python_embed\python.exe" (
        echo Using embedded Python...
        "%~dp0python_embed\python.exe" "%~dp0install.py"
    ) else (
        echo ERROR: Python not found!
        echo Please install Python 3.10+ from https://python.org
        echo Or ensure embedded Python is included in this package.
    )
)

echo.
pause
