param(
  [string]$OutputDir = "dist",
  [switch]$SkipExeBuild,
  [switch]$IncludeAcc,
  [switch]$BuildAccOffline,
  [string]$AccOfflineSource = "",
  [string]$Variant = "offline"
)

# Wave-23: emits variant offline bundles. Ruyi-<Variant>[.zip].
#   -SkipExeBuild  : skip the pkg exe build; bundle node.exe as a zero-install source runner (offline-native).
#   -IncludeAcc       : bundle ACC source + a verified, pre-hydrated offline runtime (wheel cache + browser).
#                       It refuses to create a misleading "full" package when the hydrated payload is absent.
#   -BuildAccOffline  : build that ACC payload now (requires internet on the packaging machine).
#   -AccOfflineSource : existing ACC build_offline folder; defaults to mcp/ai-computer-control/build_offline.
#   -Variant       : label for the stage dir and zip name.

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) "..")).Path
$repoRoot = (Resolve-Path (Join-Path $root "..")).Path
$dist = Join-Path $root $OutputDir
$stage = Join-Path $dist "Ruyi-$Variant"

function Copy-LongTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    & $robocopy.Source $Source $Destination /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    $copyCode = $LASTEXITCODE
    if ($copyCode -gt 7) { throw "Long-path copy failed with robocopy exit code ${copyCode}: '$Source' -> '$Destination'." }
    return
  }
  Copy-Item (Join-Path $Source "*") $Destination -Recurse -Force
}

function Remove-LongTree([string]$Target, [string]$AllowedRoot) {
  $targetFull = [IO.Path]::GetFullPath($Target).TrimEnd('\')
  $allowedFull = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
  if (-not $targetFull.StartsWith($allowedFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside package output root: '$targetFull'."
  }
  if (-not (Test-Path -LiteralPath $targetFull)) { return }
  $empty = Join-Path $allowedFull ".ruyi-empty-for-long-path-cleanup"
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    & $robocopy.Source $empty $targetFull /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP *>$null
    $cleanCode = $LASTEXITCODE
    if ($cleanCode -gt 7) { throw "Long-path cleanup failed with robocopy exit code ${cleanCode}: '$targetFull'." }
  }
  Remove-Item -LiteralPath $targetFull -Recurse -Force
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path $stage) {
  Remove-LongTree $stage $dist
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
    if ($BuildAccOffline) {
      $builder = Join-Path $accSrc "installer\build_offline_package.py"
      $builderPython = (Get-Command python.exe -ErrorAction SilentlyContinue)
      if (-not $builderPython) { throw "Python is required on the packaging machine to build the ACC offline runtime." }
      & $builderPython.Source $builder --keep-build
      if ($LASTEXITCODE -ne 0) { throw "ACC offline runtime build failed." }
    }
    $offlineSrc = if ($AccOfflineSource) { (Resolve-Path -LiteralPath $AccOfflineSource).Path } else { Join-Path $accSrc "build_offline" }
    $manifest = Join-Path $offlineSrc "offline-manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) {
      throw "Verified ACC offline payload not found at '$offlineSrc'. Run with -BuildAccOffline or pass -AccOfflineSource. Refusing to create a source-only package labeled full/offline."
    }
    $manifestJson = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($manifestJson.wheelOnly -ne $true -or -not (Test-Path -LiteralPath (Join-Path $offlineSrc "python_embed\python.exe"))) {
      throw "ACC offline payload is invalid: it must be wheel-only and include python_embed\python.exe."
    }
    $accDst = Join-Path $stage "mcp\ai-computer-control"
    New-Item -ItemType Directory -Force -Path $accDst | Out-Null
    # Copy checked-in source without recursively nesting local build products into the release.
    $excludedAccEntries = @("build", "build_offline", "dist", ".venv", "venv", "__pycache__", ".pytest_cache")
    Get-ChildItem -LiteralPath $accSrc -Force | Where-Object {
      $_.Name -notin $excludedAccEntries -and ($_.PSIsContainer -or $_.Extension -ne '.zip')
    } | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $accDst -Recurse -Force
    }
    Get-ChildItem -LiteralPath $accDst -Recurse -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -in @('__pycache__', '.venv', '.pytest_cache') } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $accDst -Recurse -Force -File -Filter *.pyc -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    # Chromium contains paths beyond the legacy Win32 260-character limit.
    Copy-LongTree $offlineSrc $accDst
    $accPython = Join-Path $accDst "python_embed\python.exe"
    $oldPythonPath = $env:PYTHONPATH
    try {
      $env:PYTHONPATH = Join-Path $accDst "src"
      & $accPython -X utf8 -c "from mcp.server.fastmcp import FastMCP; import ai_computer_control.server"
      if ($LASTEXITCODE -ne 0) { throw "ACC bundled runtime import verification failed after staging." }
    } finally { $env:PYTHONPATH = $oldPythonPath }
    $sourceArchives = @(Get-ChildItem -LiteralPath (Join-Path $accDst "offline_packages") -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.whl' })
    if ($sourceArchives.Count -gt 0) { throw "ACC staged wheel cache contains non-wheel artifacts: $($sourceArchives.Name -join ', ')" }
    $accSummary = "(ACC source + verified embedded Python + wheel-only cache + Chromium bundled)"
  } else {
    throw "IncludeAcc set but ACC source not found: $accSrc"
  }
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($node) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "runtime\node") | Out-Null
  Copy-Item $node.Source (Join-Path $stage "runtime\node\node.exe")
}

$accBootstrap = ""
if ($IncludeAcc) {
  $accBootstrap = @"
set "ACC_ROOT=%~dp0mcp\ai-computer-control"
echo [Ruyi] Ensuring AI Computer Control is installed and registered...
"%ACC_ROOT%\python_embed\python.exe" -X utf8 "%ACC_ROOT%\install.py" --ensure
if errorlevel 1 (
  echo [Ruyi] ACC installation failed. See the error above.
  pause
  exit /b 1
)
"@
}

$launcher = @"
@echo off
setlocal
cd /d "%~dp0"
$accBootstrap
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
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($tar) {
  # Windows bsdtar is long-path aware and chooses ZIP from the output suffix.
  & $tar.Source -a -c -f $zip -C $stage .
  if ($LASTEXITCODE -ne 0) { throw "Long-path ZIP creation failed with tar exit code $LASTEXITCODE." }
} else {
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
}
$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Created $zip  ($zipMB MB)  $accSummary"
