param(
  [Parameter(Mandatory = $true)][string]$BuildPython,
  [Parameter(Mandatory = $true)][string]$HeaderRoot,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'invoke-supplement-validator.ps1')
# Explicit awaited executable dispatch also works when PATHEXT is absent.
Invoke-SupplementValidator $BuildPython @(
  (Join-Path $PSScriptRoot 'build-openh264-supplement.py'),
  '--lock', (Join-Path $PSScriptRoot 'openh264-supplement.lock.json'),
  '--header-root', $HeaderRoot,
  '--destination', $Destination
)
