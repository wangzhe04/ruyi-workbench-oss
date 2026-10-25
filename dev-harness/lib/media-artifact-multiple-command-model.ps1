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
# Evaluate only the two actual candidate functions. Both command candidates are local fixture functions.
$candidate = Join-Path $RepositoryRoot 'ruyi-workbench/tools/package-offline.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($candidate,[Text.Encoding]::UTF8),[ref]$tokens,[ref]$errors)
if (@($errors).Count) { throw 'Fixture requires syntactically valid original candidate' }
foreach($name in @('Get-Sha256Hex','Assert-MediaArtifactInventory')) {
 $selected=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if ($selected.Count -ne 1) { throw 'Fixture requires exactly one actual function' }
 . ([scriptblock]::Create($selected[0].Extent.Text))
}
$script:firstCalls=0; $script:secondCalls=0
function Get-Command { param($Name,$CommandType,$ErrorAction) if($Name -cne 'node.exe' -or $CommandType -cne 'Application'){throw 'Unexpected command discovery'}; @([pscustomobject]@{Source='Invoke-FirstInventoryFixture'},[pscustomobject]@{Source='Invoke-SecondInventoryFixture'}) }
function Invoke-FirstInventoryFixture { param($Verifier,$Acc,$Sources) $script:firstCalls++; $global:LASTEXITCODE=0; '{"schema":1,"verificationKind":"offline-artifact-inventory","dependencyFilesVerified":true,"sourceArchiveVerified":true,"installsPerformed":false,"mediaProcessingEnabled":false,"mediaEgressEnabled":false}' }
function Invoke-SecondInventoryFixture { $script:secondCalls++; throw 'Second discovered command must never be selected or tried as fallback' }
function Start-Process { throw 'external execution forbidden' }
function node { throw 'external execution forbidden' }
function python { throw 'external execution forbidden' }
$workbench=Join-Path $fixtureFull 'model-workbench'; $tools=Join-Path $workbench 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
foreach($name in @('media-runtime-lock.cjs','verify-media-artifacts.cjs')) { Copy-Item -LiteralPath (Join-Path $RepositoryRoot ('ruyi-workbench/tools/'+$name)) -Destination $tools -Force }
$caught=$null
try { Assert-MediaArtifactInventory $workbench (Join-Path $fixtureFull 'runtime') (Join-Path $fixtureFull 'sources') } catch { $caught=$_ }
[pscustomobject]@{firstCalls=$script:firstCalls;secondCalls=$script:secondCalls;caught=if($caught){$caught.Exception.Message}else{$null};nativeProcesses=0;scope='actual source function under in-process two-command discovery only'} | ConvertTo-Json | Write-Output
if($caught -or $script:firstCalls -ne 1 -or $script:secondCalls -ne 0) { throw 'MULTIPLE_COMMAND_MODEL: first discovered Application must be invoked exactly once without array invocation or fallback' }
Write-Output 'MULTIPLE_COMMAND_MODEL_PASS'
