param(
  [string]$OutputDir = "dist",
  [switch]$SkipExeBuild
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) "..")).Path
$dist = Join-Path $root $OutputDir
$stage = Join-Path $dist "Ruyi-offline"   # v1.0-S9 改名(原 WinClaudeWorkbench-offline)

if (Test-Path $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

if (-not $SkipExeBuild) {
  Push-Location $root
  try {
    if (-not (Test-Path "node_modules\.bin\pkg.cmd")) {
      & npm.cmd install
    }
    & npx.cmd pkg . --targets node24-win-x64 --output (Join-Path $dist "Ruyi.exe")
  } finally {
    Pop-Location
  }
}

$exe = Join-Path $dist "Ruyi.exe"   # v1.0-S9 改名(原 WinClaudeWorkbench.exe)
if (Test-Path $exe) {
  Copy-Item $exe (Join-Path $stage "Ruyi.exe")
} else {
  Write-Warning "EXE not found. Packaging source-runner fallback only."
}

Copy-Item (Join-Path $root "app") (Join-Path $stage "app") -Recurse
Copy-Item (Join-Path $root "resources") (Join-Path $stage "resources") -Recurse
Copy-Item (Join-Path $root "config") (Join-Path $stage "config") -Recurse
Copy-Item (Join-Path $root "docs") (Join-Path $stage "docs") -Recurse
Copy-Item (Join-Path $root "package.json") (Join-Path $stage "package.json")

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "runtime\node") | Out-Null
  Copy-Item $node.Source (Join-Path $stage "runtime\node\node.exe")
}

$launcher = @"
@echo off
setlocal
cd /d "%~dp0"
if exist Ruyi.exe (
  Ruyi.exe serve --open
) else (
  runtime\node\node.exe app\server.js serve --open
)
"@
Set-Content -LiteralPath (Join-Path $stage "Start-Workbench.cmd") -Value $launcher -Encoding ASCII

$zip = Join-Path $dist "Ruyi-offline.zip"   # v1.0-S9 改名(原 WinClaudeWorkbench-offline.zip)
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Write-Host "Created $zip"
