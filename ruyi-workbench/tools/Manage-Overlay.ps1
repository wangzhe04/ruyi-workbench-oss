<#
  Manage-Overlay.ps1 — apply / rollback / list / verify a 如意 Ruyi overlay (原 Win Claude Workbench).

  Layout (inside the extracted overlay package):
    Manage-Overlay.cmd        (thin wrapper -> this script)
    Manage-Overlay.ps1
    APPLY-OVERLAY.md
    payload\                   (the files that land in the deployed folder)
      update-manifest.json     (sha256 of every payload file, relative to deployed root)
      app\... Start-Workbench.cmd resources\... tools\...

  Usage:
    Manage-Overlay.cmd apply    "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd rollback "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd list     "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd verify   "C:\path\to\Ruyi-offline"
#>
param(
  [Parameter(Position = 0)][ValidateSet('apply', 'rollback', 'list', 'verify')][string]$Action = 'apply',
  [Parameter(Position = 1)][string]$Target = ''
)
$ErrorActionPreference = 'Stop'
$overlayRoot = Split-Path -Parent $PSCommandPath
$payload = Join-Path $overlayRoot 'payload'
$manifestPath = Join-Path $payload 'update-manifest.json'

function Fail($m) { Write-Host "[overlay] ERROR: $m" -ForegroundColor Red; exit 1 }
function Info($m) { Write-Host "[overlay] $m" }

function Resolve-Target {
  param([string]$t)
  if (-not $t) {
    # Try the parent of the overlay folder, then CWD, if they look like a deployment.
    # v1.0-S9 exe 改名 Ruyi.exe;双名兼容(存量部署仍名 WinClaudeWorkbench.exe)。
    foreach ($cand in @((Split-Path -Parent $overlayRoot), (Get-Location).Path)) {
      if ($cand -and ((Test-Path (Join-Path $cand 'app\server.js')) -or (Test-Path (Join-Path $cand 'Ruyi.exe')) -or (Test-Path (Join-Path $cand 'WinClaudeWorkbench.exe')))) { return $cand }
    }
    Fail "Target folder not given and could not be auto-detected. Pass the deployed Ruyi-offline folder."
  }
  if (-not (Test-Path $t)) { Fail "Target not found: $t" }
  return (Resolve-Path $t).Path
}

function Assert-Deployment($t) {
  if (-not ((Test-Path (Join-Path $t 'app')) -or (Test-Path (Join-Path $t 'Ruyi.exe')) -or (Test-Path (Join-Path $t 'WinClaudeWorkbench.exe')) -or (Test-Path (Join-Path $t 'runtime\node\node.exe')))) {
    Fail "'$t' does not look like a Ruyi deployment (no app\, exe, or runtime\node)."
  }
}

function Port-Listening($port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}

function Get-Manifest { if (-not (Test-Path $manifestPath)) { Fail "payload\update-manifest.json missing." }; return Get-Content -Raw $manifestPath | ConvertFrom-Json }

function Do-Apply($t) {
  Assert-Deployment $t
  $m = Get-Manifest
  Info "Applying overlay v$($m.version) ($($m.fileCount) files) -> $t"
  if ((Port-Listening 8765) -or (Port-Listening 8799)) { Write-Warning "A workbench server may be running. Close it before restarting so the new server.js loads." }

  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $t ".overlay-backups\$($m.version)-$ts"
  New-Item -ItemType Directory -Force -Path $backup | Out-Null

  # 1) Back up any existing counterpart of each payload file.
  foreach ($f in $m.files) {
    $dst = Join-Path $t $f.path
    if (Test-Path $dst) {
      $bdst = Join-Path $backup $f.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bdst) | Out-Null
      Copy-Item -LiteralPath $dst -Destination $bdst -Force
    }
  }
  # Also back up the manifest itself if present.
  $curMani = Join-Path $t 'update-manifest.json'
  if (Test-Path $curMani) { Copy-Item $curMani (Join-Path $backup 'update-manifest.json') -Force }
  Info "Backed up existing files -> $backup"

  # 2) Copy payload over the target.
  foreach ($f in $m.files) {
    $src = Join-Path $payload $f.path
    $dst = Join-Path $t $f.path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
  Copy-Item $manifestPath (Join-Path $t 'update-manifest.json') -Force

  # 3) Marker + prune old backups (keep newest 5).
  @{ version = $m.version; overlay = $m.overlay; appliedAt = (Get-Date).ToString('o'); backup = $backup } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $t '.overlay-applied.json') -Encoding UTF8
  $backups = @(Get-ChildItem (Join-Path $t '.overlay-backups') -Directory -ErrorAction SilentlyContinue | Sort-Object CreationTime -Descending)
  if ($backups.Count -gt 5) { $backups | Select-Object -Skip 5 | Remove-Item -Recurse -Force }

  Do-Verify $t
  Info "DONE. Restart with Start-Workbench.cmd, then check /health and the 体检 (Doctor) tab."
}

function Do-Rollback($t) {
  Assert-Deployment $t
  if ((Port-Listening 8765) -or (Port-Listening 8799)) { Fail "A workbench server is running. Stop it before rolling back." }
  $root = Join-Path $t '.overlay-backups'
  if (-not (Test-Path $root)) { Fail "No backups found under $root" }
  $latest = Get-ChildItem $root -Directory | Sort-Object CreationTime -Descending | Select-Object -First 1
  if (-not $latest) { Fail "No backups found." }
  Info "Restoring backup $($latest.Name) -> $t"
  Get-ChildItem $latest.FullName -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($latest.FullName.Length).TrimStart('\')
    $dst = Join-Path $t $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
  }
  # Reconcile the manifest: if the backup had no manifest (fresh base install), remove the one Do-Apply
  # wrote so the integrity check doesn't report false mismatches against the rolled-back old files.
  if (-not (Test-Path (Join-Path $latest.FullName 'update-manifest.json'))) {
    Remove-Item -LiteralPath (Join-Path $t 'update-manifest.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $t '.overlay-applied.json') -Force -ErrorAction SilentlyContinue
  }
  Info "Rollback complete. (Note: files newly ADDED by the overlay are left in place; that is harmless.)"
}

function Do-List($t) {
  $root = Join-Path $t '.overlay-backups'
  if (-not (Test-Path $root)) { Info "No backups."; return }
  Get-ChildItem $root -Directory | Sort-Object Name -Descending | ForEach-Object {
    $n = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object).Count
    Info "$($_.Name)  ($n files)"
  }
}

function Do-Verify($t) {
  $m = Get-Manifest
  $bad = @()
  foreach ($f in $m.files) {
    $dst = Join-Path $t $f.path
    if (-not (Test-Path $dst)) { $bad += "$($f.path) [missing]"; continue }
    $sha = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLower()
    if ($sha -ne $f.sha256.ToLower()) { $bad += "$($f.path) [hash mismatch]" }
  }
  if ($bad.Count -eq 0) { Info "VERIFY OK: all $($m.fileCount) files match v$($m.version)." }
  else { Write-Warning "VERIFY: $($bad.Count) mismatch(es):`n  $([string]::Join("`n  ", $bad))" }
}

$t = Resolve-Target $Target
switch ($Action) {
  'apply' { Do-Apply $t }
  'rollback' { Do-Rollback $t }
  'list' { Do-List $t }
  'verify' { Do-Verify $t }
}
