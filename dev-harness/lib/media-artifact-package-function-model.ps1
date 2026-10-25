param(
 [string]$RepositoryRoot = (Join-Path $PSScriptRoot '../..'),
 [Parameter(Mandatory=$true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
$fixtureFull = [IO.Path]::GetFullPath($FixtureRoot)
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not [IO.Path]::IsPathRooted($FixtureRoot) -or -not ([IO.Path]::GetDirectoryName($fixtureFull)).Equals($tempPrefix.TrimEnd([IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($fixtureFull)).StartsWith('ruyi-media-') -or (Test-Path -LiteralPath $fixtureFull)) { throw 'FixtureRoot must be a fresh owned ruyi-media- directory directly inside the current temporary directory' }
New-Item -ItemType Directory -Path $fixtureFull | Out-Null
$ErrorActionPreference = 'Stop'
# Parse the actual package source, then evaluate only its two named functions.
# Get-Command resolves to an in-process PowerShell fixture function: no external command is invoked.
$source = Join-Path $RepositoryRoot 'ruyi-workbench/tools/package-offline.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($source,[Text.Encoding]::UTF8), [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) { throw "Package source parser failures: $errors" }
foreach ($name in @('Get-Sha256Hex', 'Assert-MediaArtifactInventory')) {
  $selected = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
  if ($selected.Count -ne 1) { throw "Expected one actual package function: $name" }
  . ([scriptblock]::Create($selected[0].Extent.Text))
}
function Assert-Model([bool]$Value, [string]$Label) { if (-not $Value) { throw $Label }; $script:checks += 1 }
function Expect-Refusal([scriptblock]$Work, [string]$Label) { $failed = $false; try { & $Work } catch { $failed = $true }; Assert-Model $failed $Label }
function Get-Command { param($Name, $CommandType, $ErrorAction) if ($script:nodeMissing) { return $null }; Assert-Model ($Name -ceq 'node.exe' -and $CommandType -ceq 'Application') 'only reviewed Node selection is requested'; [pscustomobject]@{ Source = 'Invoke-InventoryFixture' } }
function Invoke-InventoryFixture { param($Verifier, $Acc, $Sources) $script:calls += 1; $script:lastCall = @($Verifier, $Acc, $Sources); $global:LASTEXITCODE = $script:exitCode; $script:receipt }
function node { throw 'external execution forbidden' }
function python { throw 'external execution forbidden' }
function Start-Process { throw 'external execution forbidden' }
$script:checks = 0; $script:calls = 0; $script:nodeMissing = $false; $script:exitCode = 0
$fixture = $fixtureFull
$workbench = Join-Path $fixture ('workbench with spaces ' + [char]0x4e2d); $tools = Join-Path $workbench 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
foreach ($name in @('media-runtime-lock.cjs', 'verify-media-artifacts.cjs')) { Copy-Item -LiteralPath (Join-Path $RepositoryRoot ('ruyi-workbench/tools/' + $name)) -Destination $tools -Force }
$acc = Join-Path $fixture 'existing-runtime'; $sources = Join-Path $fixture 'existing-sources'
$good = '{"schema":1,"verificationKind":"offline-artifact-inventory","dependencyFilesVerified":true,"sourceArchiveVerified":true,"installsPerformed":false,"mediaProcessingEnabled":false,"mediaEgressEnabled":false}'
$script:receipt = $good
Assert-MediaArtifactInventory $workbench $acc $sources
Assert-Model ($script:calls -eq 1) 'the successful gate uses one exact inventory call'
Assert-Model ($script:lastCall[0] -ceq (Join-Path $workbench 'tools\verify-media-artifacts.cjs')) 'verifier follows selected workbench and staged resources'
Assert-Model ($script:lastCall[1] -ceq $acc -and $script:lastCall[2] -ceq $sources) 'absolute space and Unicode paths remain exact separate arguments'
foreach ($bad in @('', 'not-json', 'null', '{}', ($good.Replace('"schema":1','"schema":2')), ($good.Replace('offline-artifact-inventory','media-launch')), ($good.Replace('"dependencyFilesVerified":true','"dependencyFilesVerified":"true"')), ($good.Replace('"sourceArchiveVerified":true','"sourceArchiveVerified":false')), ($good.Replace('"installsPerformed":false','"installsPerformed":true')), ($good.Replace('"mediaProcessingEnabled":false','"mediaProcessingEnabled":true')), ($good.Replace('"mediaEgressEnabled":false','"mediaEgressEnabled":true')))) {
  $script:receipt = $bad; Expect-Refusal { Assert-MediaArtifactInventory $workbench $acc $sources } 'missing, malformed, falsy or capability-bearing receipt must refuse'
}
$script:receipt = $good; $script:exitCode = 1
Expect-Refusal { Assert-MediaArtifactInventory $workbench $acc $sources } 'nonzero verifier exit refuses even when output claims success'
$script:exitCode = 0; $script:nodeMissing = $true; $before = $script:calls
Expect-Refusal { Assert-MediaArtifactInventory $workbench $acc $sources } 'missing packaging Node refuses without alternative provider'
Assert-Model ($script:calls -eq $before) 'missing Node cannot reach a verifier'
$script:nodeMissing = $false
foreach ($name in @('media-runtime-lock.cjs', 'verify-media-artifacts.cjs')) {
  $target = Join-Path $tools $name; $original = [System.IO.File]::ReadAllBytes($target); $before = $script:calls
  try { [System.IO.File]::WriteAllText($target, 'SYNTHETIC_CHANGED_TOOL'); Expect-Refusal { Assert-MediaArtifactInventory $workbench $acc $sources } 'changed tool refuses before executing fixture'; Assert-Model ($script:calls -eq $before) 'hash mismatch cannot reach a verifier' } finally { [System.IO.File]::WriteAllBytes($target, $original) }
  $saved = $target + '.saved'
  try { Move-Item -LiteralPath $target -Destination $saved; Expect-Refusal { Assert-MediaArtifactInventory $workbench $acc $sources } 'missing tool refuses before executing fixture'; Assert-Model ($script:calls -eq $before) 'missing helper cannot reach a verifier' } finally { if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $target } }
}
Write-Output ('SOURCE_FUNCTION_MODEL_PASS checks=' + $script:checks + ' verifierFixtureCalls=' + $script:calls + ' nativeProcesses=0')
