param(
  [string]$OutputDir = "dist",
  [switch]$SkipExeBuild,
  [switch]$IncludeAcc,
  [string]$Variant = "offline"
)

# Wave-23: emits variant offline bundles. Ruyi-<Variant>[.zip].
#   -SkipExeBuild  : skip the pkg exe build; bundle node.exe as a zero-install source runner (offline-native).
#   -IncludeAcc    : also bundle the ACC desktop-control MCP source (full package). Offline wheels
#                    (opencv/matplotlib/...) are large and NOT in git -- fetched by ACC's own installer or
#                    dropped in from the Release asset; see mcp/ai-computer-control/README.
#   -Variant       : label for the stage dir and zip name.

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) "..")).Path
$repoRoot = (Resolve-Path (Join-Path $root "..")).Path
$dist = Join-Path $root $OutputDir
$stage = Join-Path $dist "Ruyi-$Variant"

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

$exe = Join-Path $dist "Ruyi.exe"
if (Test-Path $exe) {
  Copy-Item $exe (Join-Path $stage "Ruyi.exe")
} else {
  Write-Warning "EXE not found (SkipExeBuild or not built). Packaging source-runner + bundled node.exe (zero-install offline)."
}

Copy-Item (Join-Path $root "app") (Join-Path $stage "app") -Recurse
Copy-Item (Join-Path $root "resources") (Join-Path $stage "resources") -Recurse
Copy-Item (Join-Path $root "config") (Join-Path $stage "config") -Recurse
Copy-Item (Join-Path $root "docs") (Join-Path $stage "docs") -Recurse
Copy-Item (Join-Path $root "package.json") (Join-Path $stage "package.json")

$accSummary = "(no ACC)"
if ($IncludeAcc) {
  $accSrc = Join-Path $repoRoot "mcp\ai-computer-control"
  if (Test-Path $accSrc) {
    $accDst = Join-Path $stage "mcp\ai-computer-control"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $accDst) | Out-Null
    Copy-Item $accSrc $accDst -Recurse
    Get-ChildItem -LiteralPath $accDst -Recurse -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -in @('__pycache__', '.venv', '.pytest_cache') } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $accDst -Recurse -Force -File -Filter *.pyc -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    $accSummary = "(ACC source + installer bundled; offline wheels per ACC/README)"
  } else {
    Write-Warning "IncludeAcc set but ACC source not found: $accSrc"
  }
}

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
) else if exist runtime\node\node.exe (
  runtime\node\node.exe app\server.js serve --open
) else (
  where node >nul 2>nul && ( node app\server.js serve --open ) || ( echo [Ruyi] no bundled node runtime and no node on PATH ^(need Node ^>= 20^). & pause )
)
"@
Set-Content -LiteralPath (Join-Path $stage "Start-Workbench.cmd") -Value $launcher -Encoding ASCII

$zip = Join-Path $dist "Ruyi-$Variant.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Created $zip  ($zipMB MB)  $accSummary"
