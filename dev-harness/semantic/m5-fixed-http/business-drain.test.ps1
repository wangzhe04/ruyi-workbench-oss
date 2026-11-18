$ErrorActionPreference='Stop'
$source=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'keeper.candidate.ps1')
$definition=[regex]::Match($source,'(?m)^function Confirm-BusinessDrain[\s\S]*?^}').Value
if(!$definition){throw 'keeper drain predicate missing'}
. ([scriptblock]::Create($definition))
$status='BUSINESS_ASSERTIONS_AND_GUARD_CLOSE_REQUIRE_OUTER_JOB'
$clean=@{active=0;members=@();totalProcesses=10;limitTerminatedProcesses=0}
if(!(Confirm-BusinessDrain $status 0 $clean $false)){throw 'natural empty Job was refused'}
if(Confirm-BusinessDrain $status 0 $clean $true){throw 'forced empty Job was accepted'}
if(Confirm-BusinessDrain $status 1 $clean $false){throw 'non-zero controller exit was accepted'}
if(Confirm-BusinessDrain 'CONTROLLER_SUCCESS_REQUIRES_OUTER_JOB' 0 $clean $false){throw 'wrong lane status was accepted'}
$clean.active=1;$clean.members=@(420)
if(Confirm-BusinessDrain $status 0 $clean $false){throw 'occupied Job was accepted'}
$clean.active=0
if(Confirm-BusinessDrain $status 0 $clean $false){throw 'nonempty member list was accepted'}
$clean.members=@();$clean.limitTerminatedProcesses=1
if(Confirm-BusinessDrain $status 0 $clean $false){throw 'limit-terminated Job was accepted'}
Write-Output 'Business-only drain predicate rejected forced, failed, occupied, and wrong-lane receipts.'
