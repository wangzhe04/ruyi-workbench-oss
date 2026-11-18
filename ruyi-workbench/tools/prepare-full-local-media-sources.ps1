param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$SupplementRoot,
  [Parameter(Mandatory = $true)][string]$BuildPython
)
# Prepare the existing local-full-v2 source profile. This does not migrate the
# ordinary Full source lock, build native code or grant public redistribution.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lock = Get-Content -LiteralPath (Join-Path $root 'tools\media-runtime-sources-local-full.json') -Raw | ConvertFrom-Json
$expectedNames = @('opencv-windows-ffmpeg-sources-v2-local.zip', 'opencv_python_headless-5.0.0.93.tar.gz')
if ($lock.schema -ne 1 -or $lock.artifacts.Count -ne 2 -or $lock.redistributionAdmitted -ne $false) {
  throw 'Unexpected Full-local source profile.'
}
function Assert-SourceFile([string]$File, $Row) {
  if ((Get-Item -LiteralPath $File).Length -ne $Row.bytes) { throw "Source size mismatch: $File" }
  $stream = [IO.File]::OpenRead($File)
  $algo = [Security.Cryptography.SHA256]::Create()
  try { $digest = ([BitConverter]::ToString($algo.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $algo.Dispose(); $stream.Dispose() }
  if ($digest -cne $Row.sha256) { throw "Source SHA-256 mismatch: $File" }
}
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$target = [IO.Path]::GetFullPath($Destination)
for ($i = 0; $i -lt $expectedNames.Count; $i++) {
  $row = $lock.artifacts[$i]
  if ($row.path -cne $expectedNames[$i]) { throw 'Unexpected Full-local source filename.' }
  Assert-SourceFile (Join-Path $source $row.path) $row
}
$candidateTools = $PSScriptRoot
. (Join-Path $candidateTools 'invoke-supplement-validator.ps1')
$validator = Join-Path $candidateTools 'validate-openh264-supplement.py'
$supplementLock = Join-Path $candidateTools 'openh264-supplement.lock.json'
$supplementSource = (Resolve-Path -LiteralPath $SupplementRoot).Path
Invoke-SupplementValidator $BuildPython @($validator, $supplementLock, $supplementSource, $source)
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($row in $lock.artifacts) {
  $inputFile = Join-Path $source $row.path
  $outputFile = Join-Path $target $row.path
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($inputFile), $outputFile)) {
    Copy-Item -LiteralPath $inputFile -Destination $outputFile -Force
  }
  Assert-SourceFile $outputFile $row
}
$supplementRow = Get-Content -LiteralPath $supplementLock -Raw | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $supplementSource $supplementRow.archive.name) -Destination (Join-Path $target $supplementRow.archive.name) -Force
Copy-Item -LiteralPath $supplementLock -Destination (Join-Path $target 'openh264-supplement.lock.json') -Force
Invoke-SupplementValidator $BuildPython @($validator, (Join-Path $target 'openh264-supplement.lock.json'), $target, $target)
Write-Output "Verified Full-local media source input: $target"
Write-Output 'Use -IncludeAcc -LocalMediaSources -Variant full-local with this -MediaSourcesRoot. Public redistribution remains unapproved.'
