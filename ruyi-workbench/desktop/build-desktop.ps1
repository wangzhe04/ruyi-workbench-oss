# Ruyi Workbench desktop shell build script (zero npm dependency).
#
# Compiles desktop/RuyiDesktop.cs with the system csc.exe (.NET Framework 4.x)
# into RuyiDesktop.exe (/target:winexe -> no console window), and copies
# WebView2Loader.dll next to the exe. Output lands in the ruyi-workbench root,
# alongside app\server.js.
#
# Usage: powershell -ExecutionPolicy Bypass -File desktop\build-desktop.ps1

$ErrorActionPreference = 'Stop'

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ruyiRoot   = Split-Path -Parent $desktopDir
$src        = Join-Path $desktopDir 'RuyiDesktop.cs'
$manifest   = Join-Path $desktopDir 'app.manifest'
$loaderSrc  = Join-Path $desktopDir 'WebView2Loader.dll'
$iconSrc    = Join-Path $desktopDir 'ruyi.ico'
$outExe     = Join-Path $ruyiRoot 'RuyiDesktop.exe'
$loaderDst  = Join-Path $ruyiRoot 'WebView2Loader.dll'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  Write-Error "System C# compiler not found: $csc"
}
if (-not (Test-Path -LiteralPath $loaderSrc)) {
  Write-Error "WebView2Loader.dll missing: $loaderSrc (Microsoft redistributable, shipped with the source tree)"
}

Write-Host "[Ruyi] Compiling RuyiDesktop.cs ..."
$iconArgs = @()
if (Test-Path -LiteralPath $iconSrc) { $iconArgs += "/win32icon:$iconSrc" }
else { Write-Host "[Ruyi] ruyi.ico not found, building without embedded icon (run desktop\build-icon.ps1 first)" }
& $csc @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001',
  '/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll',
  '/r:System.Web.Extensions.dll',
  "/win32manifest:$manifest","/out:$outExe") @iconArgs $src
if ($LASTEXITCODE -ne 0) { throw "csc build failed (exit $LASTEXITCODE)" }

Copy-Item -LiteralPath $loaderSrc -Destination $loaderDst -Force
Write-Host "[Ruyi] Built: $outExe"
Write-Host "[Ruyi] Copied: $loaderDst"
