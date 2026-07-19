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
#                       The checked-in ACC source is overlaid into that runtime and the manifest is
#                       regenerated, so a code-only ACC fix is deployed by --ensure as well.
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

function Sync-AccReleaseRuntime([string]$AccSource, [string]$AccDestination, [string]$StageRoot) {
  # The offline runtime is intentionally cached between Full builds, but its embedded wheel can be
  # older than the checked-in ACC code.  Ruyi launches the installed embedded runtime, not src/,
  # so copy the current source into site-packages before creating the release manifest.
  $sourcePackage = Join-Path $AccSource "src\ai_computer_control"
  $runtimePackage = Join-Path $AccDestination "python_embed\Lib\site-packages\ai_computer_control"
  if (-not (Test-Path -LiteralPath $sourcePackage -PathType Container)) {
    throw "ACC source package is missing: $sourcePackage"
  }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $runtimePackage) -PathType Container)) {
    throw "ACC embedded runtime is missing its site-packages directory."
  }
  if (Test-Path -LiteralPath $runtimePackage) {
    Remove-LongTree $runtimePackage $StageRoot
  }
  Copy-LongTree $sourcePackage $runtimePackage | Out-Null
  Get-ChildItem -LiteralPath $runtimePackage -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq '__pycache__' } |
    Sort-Object FullName -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  Get-ChildItem -LiteralPath $runtimePackage -Recurse -Force -File -Filter *.pyc -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

  # Copy the installer inputs after the cached offline payload, otherwise its older copies win.
  foreach ($name in @('install.py', 'install.bat', 'mcp_config_template.json')) {
    $source = Join-Path $AccSource "installer\$name"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "ACC installer input is missing: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $AccDestination $name) -Force
  }
  $requirements = Join-Path $AccSource 'requirements_offline.txt'
  if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw "ACC requirements are missing: $requirements" }
  Copy-Item -LiteralPath $requirements -Destination (Join-Path $AccDestination 'requirements_offline.txt') -Force
  return $sourcePackage
}

function Write-AccReleaseManifest([string]$AccDestination, [string]$SourcePackage) {
  # Keep the verified cached payload entries, replacing only the runtime code and installer inputs
  # with their release-stage hashes.  The changed manifest digest makes --ensure upgrade an older
  # installed runtime instead of merely refreshing its MCP registration.
  $manifestPath = Join-Path $AccDestination 'offline-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "ACC offline manifest is missing: $manifestPath"
  }
  $base = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $changed = @{}
  foreach ($name in @('install.py', 'install.bat', 'mcp_config_template.json', 'requirements_offline.txt')) {
    $changed[$name] = $true
  }
  $runtimePrefix = 'python_embed/Lib/site-packages/ai_computer_control/'
  Get-ChildItem -LiteralPath $SourcePackage -Recurse -Force | Where-Object {
    -not $_.PSIsContainer -and $_.Extension -ne '.pyc' -and $_.FullName -notmatch '\\__pycache__(\\|$)'
  } | ForEach-Object {
    $relative = $_.FullName.Substring($SourcePackage.Length).TrimStart('\').Replace('\', '/')
    $changed[$runtimePrefix + $relative] = $true
  }

  $files = New-Object System.Collections.Generic.List[object]
  foreach ($entry in @($base.files)) {
    $path = [string]$entry.path
    $staleBytecode = $path.StartsWith($runtimePrefix, [StringComparison]::Ordinal) -and
      ($path.Contains('/__pycache__/') -or $path.EndsWith('.pyc', [StringComparison]::OrdinalIgnoreCase))
    if (-not $changed.ContainsKey($path) -and -not $staleBytecode) {
      $files.Add([ordered]@{ path = [string]$entry.path; bytes = [int64]$entry.bytes; sha256 = [string]$entry.sha256 })
    }
  }
  foreach ($relative in @($changed.Keys | Sort-Object)) {
    $full = Join-Path $AccDestination ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "ACC manifest input is missing: $relative" }
    $item = Get-Item -LiteralPath $full
    $files.Add([ordered]@{
      path = $relative
      bytes = [int64]$item.Length
      sha256 = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    })
  }
  $sortedFiles = @($files | Sort-Object { [string]$_.path })
  $manifest = [ordered]@{
    schema = [int]$base.schema
    name = [string]$base.name
    pythonVersion = [string]$base.pythonVersion
    wheelOnly = $true
    fileCount = $sortedFiles.Count
    files = $sortedFiles
  }
  $json = $manifest | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

if (Test-Path $stage) {
  Remove-LongTree $stage $dist
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 第43波 freshness 门:产物必须 == 拼接(src),陈旧产物不进发行包。
& node (Join-Path $root "app\build.js") --check
if ($LASTEXITCODE -ne 0) { throw "app/server.js 落后于 app/src/(或手改了产物)— 先跑 node app/build.js 重建再打包" }

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
    $releaseSourcePackage = Sync-AccReleaseRuntime $accSrc $accDst $stage
    Write-AccReleaseManifest $accDst $releaseSourcePackage
    $accPython = Join-Path $accDst "python_embed\python.exe"
    $oldPythonPath = $env:PYTHONPATH
    try {
      $env:PYTHONPATH = Join-Path $accDst "src"
      # Embedded Python can refresh stale .pyc files during startup, invalidating its own signed payload
      # before install.py verifies it. -B keeps the release payload immutable, and the manifest probe makes
      # the packager enforce the exact same integrity gate that a clean target machine runs first.
      $accInstaller = (Join-Path $accDst "install.py").Replace('\', '\\').Replace("'", "\'")
      & $accPython -B -X utf8 -c "import runpy; m=runpy.run_path('$accInstaller'); assert m['verify_offline_payload']()"
      if ($LASTEXITCODE -ne 0) { throw "ACC staged manifest verification failed." }
      & $accPython -B -X utf8 -c "from mcp.server.fastmcp import FastMCP; import ai_computer_control.server"
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
"%ACC_ROOT%\python_embed\python.exe" -B -X utf8 "%ACC_ROOT%\install.py" --ensure
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

$archiveBase = "Ruyi-$Variant"
$zip = Join-Path $dist "$archiveBase.zip"

# Explorer's built-in ZIP handler applies its legacy path limit to a virtual/temporary extraction path,
# not only to the final destination. Keep enough headroom for a normal Downloads folder. Chromium and
# winsdk contain deep paths, so a verbose release asset name can make Explorer silently skip files even
# when the final visible path looks shorter than MAX_PATH.
$explorerDefaultPathBudget = 200
$longestStagedRelativePath = Get-ChildItem -LiteralPath $stage -Recurse -Force -File |
  ForEach-Object { $_.FullName.Substring($stage.Length).TrimStart('\').Length } |
  Measure-Object -Maximum
$projectedExplorerPath = $archiveBase.Length + 1 + [int]$longestStagedRelativePath.Maximum
if ($projectedExplorerPath -gt $explorerDefaultPathBudget) {
  throw "Windows Explorer extraction path budget exceeded ($projectedExplorerPath > $explorerDefaultPathBudget). Use a shorter -Variant (for example 'v1.6.5-full') and tell users not to skip files during extraction."
}

if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($tar) {
  # Windows bsdtar is long-path aware and chooses ZIP from the output suffix. Pass the stage's children
  # instead of ".": archives whose every entry starts with "./" appear empty to Explorer's ZIP shell.
  $archiveRoots = @(Get-ChildItem -LiteralPath $stage -Force | Sort-Object Name | ForEach-Object { $_.Name })
  if ($archiveRoots.Count -eq 0) { throw "Refusing to create an empty offline ZIP from '$stage'." }
  & $tar.Source -a -c -f $zip -C $stage @archiveRoots
  if ($LASTEXITCODE -ne 0) { throw "Long-path ZIP creation failed with tar exit code $LASTEXITCODE." }
} else {
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
}

# Reject structurally unreadable output and the Explorer-incompatible "./" layout before release.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  if ($archive.Entries.Count -eq 0) { throw "ZIP verification failed: archive is empty." }
  $badEntries = @($archive.Entries | Where-Object {
    $_.FullName -eq "." -or $_.FullName.StartsWith("./", [StringComparison]::Ordinal) -or
    $_.FullName.StartsWith("/", [StringComparison]::Ordinal) -or $_.FullName.Contains("../")
  })
  if ($badEntries.Count -gt 0) {
    throw "ZIP verification failed: Explorer-incompatible or unsafe entry '$($badEntries[0].FullName)'."
  }
  $buffer = New-Object byte[] (1MB)
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith("/", [StringComparison]::Ordinal)) { continue }
    $stream = $entry.Open()
    try {
      while ($stream.Read($buffer, 0, $buffer.Length) -gt 0) { }
    } finally {
      $stream.Dispose()
    }
  }
} finally {
  $archive.Dispose()
}
$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Created $zip  ($zipMB MB)  $accSummary"
