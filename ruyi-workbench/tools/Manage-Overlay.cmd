@echo off
REM Thin wrapper so backup/apply always runs through Manage-Overlay.ps1.
REM Usage: Manage-Overlay.cmd apply|rollback|list|verify "C:\path\to\Ruyi-offline"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Manage-Overlay.ps1" %*
