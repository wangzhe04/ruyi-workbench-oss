param(
 [string]$RepositoryRoot = (Join-Path $PSScriptRoot '../..'),
 [Parameter(Mandatory=$true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
$ErrorActionPreference='Stop'
# Run the unchanged original two-command assertion first, then make that same selected first command fail.
. (Join-Path $PSScriptRoot 'media-artifact-multiple-command-model.ps1') -RepositoryRoot $RepositoryRoot -FixtureRoot $FixtureRoot
function Invoke-FirstInventoryFixture { param($Verifier,$Acc,$Sources) $script:firstCalls++; $global:LASTEXITCODE=1; '{"schema":1,"verificationKind":"offline-artifact-inventory","dependencyFilesVerified":true,"sourceArchiveVerified":true,"installsPerformed":false,"mediaProcessingEnabled":false,"mediaEgressEnabled":false}' }
$caught=$null
try { Assert-MediaArtifactInventory $workbench (Join-Path $fixtureFull 'runtime') (Join-Path $fixtureFull 'sources') } catch { $caught=$_ }
if(-not $caught -or $script:firstCalls -ne 2 -or $script:secondCalls -ne 0){ throw 'First Application failure must refuse; second discovered command cannot be a fallback' }
Write-Output 'MULTIPLE_COMMAND_NO_FALLBACK_PASS firstCalls=2 secondCalls=0 nativeProcesses=0'
