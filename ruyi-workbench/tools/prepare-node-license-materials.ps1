param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [switch]$Download
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$materials = Join-Path $root 'runtime\node'
$lock = Get-Content -LiteralPath (Join-Path $materials 'provenance.lock.json') -Raw | ConvertFrom-Json
function Get-Sha([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algo = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algo.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $algo.Dispose(); $stream.Dispose() }
}
$archiveFull = [IO.Path]::GetFullPath($ArchivePath)
if ($Download) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archiveFull) | Out-Null
  Invoke-WebRequest -Uri $lock.archive.url -OutFile $archiveFull
}
if ((Get-Item -LiteralPath $archiveFull).Length -ne $lock.archive.bytes -or (Get-Sha $archiveFull) -cne $lock.archive.sha256) {
  throw 'Node official ZIP does not match the reviewed release identity.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archiveFull)
try {
  $prefix = 'node-' + $lock.version + '-' + $lock.platform + '/'
  foreach ($name in @('node.exe', 'LICENSE')) {
    $entry = $zip.GetEntry($prefix + $name)
    if (-not $entry) { throw "Official Node archive is missing $name." }
    $stream = $entry.Open()
    $algo = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($algo.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algo.Dispose(); $stream.Dispose() }
    $expected = if ($name -ceq 'node.exe') { $lock.binary } else { $lock.files | Where-Object file -CEQ 'LICENSE' }
    if ($entry.Length -ne $expected.bytes -or $digest -cne $expected.sha256) { throw "Official Node archive has unexpected $name bytes." }
  }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($prefix + 'LICENSE'), (Join-Path $materials 'LICENSE'), $true)
} finally { $zip.Dispose() }
Write-Output 'Verified official Node ZIP, its executable and complete original LICENSE. License bytes restored unchanged.'
