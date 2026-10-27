$ErrorActionPreference = 'Stop'
# Owned outer lifetime owner for the production maintenance E2E.
#
# The product launches the cold worker, and therefore the successor, with
# DETACHED_PROCESS so they outlive old serve: the handoff is impossible if the
# worker dies with its parent. That also means only an inherited Job can reclaim
# the final successor once the run is over.
#
# This keeper therefore never owns old serve. A Job containing old serve would
# make libuv's detached spawn non-detachable - measured on this host: with a Job
# around serve the cold worker is gone the moment serve exits (claim stuck at
# committed, no maintenance listener), and it survives with
# JOB_OBJECT_LIMIT_BREAKAWAY_OK. The same Job would also swallow every later
# round, because round N's old serve is round N-1's successor. Instead the test
# publishes the one process it cannot otherwise stop - the last successor - and
# only that exact <pid, creation> identity is assigned:
#
#   job-target.json -> verify identity, assign, write job-assigned.json
#   job-release.json -> success: enumerate members, close the Job, prove every
#                       member identity is absent, write outer-job-result.json.
#   job-hold.json    -> failure/unknown: record who was inside and keep the
#                       scene. If a member was assigned the promise is bounded
#                       (RUYI_PM_HOLD_MS, default 120 s) and then closed with
#                       autoClosedAfterHold:true - still ok:false, never success.
#
# Nothing is killed by PID; only the OS Job is closed.
$jobSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RuyiMaintenanceOuterJob {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcess; public long PerJob; public uint Flags; public UIntPtr Minimum; public UIntPtr Maximum; public uint Active; public UIntPtr Affinity; public uint Priority; public uint Scheduling; }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong Read; public ulong Write; public ulong Other; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] public struct Ext { public Basic Basic; public Io Io; public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcess; public UIntPtr PeakJob; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,ref Ext v,uint l);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr b,uint l,out uint r);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 public static IntPtr Create(){IntPtr j=CreateJobObject(IntPtr.Zero,null);if(j==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());var e=new Ext();e.Basic.Flags=0x2000;if(!SetInformationJobObject(j,9,ref e,(uint)Marshal.SizeOf(typeof(Ext))))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return j;}
 public static void Assign(IntPtr j,IntPtr p){if(!AssignProcessToJobObject(j,p))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static int[] Pids(IntPtr j){int cap=16*1024;IntPtr b=Marshal.AllocHGlobal(cap);try{uint r;if(!QueryInformationJobObject(j,3,b,(uint)cap,out r))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());int n=Marshal.ReadInt32(b,0);var l=new List<int>();for(int i=0;i<n;i++)l.Add((int)Marshal.ReadIntPtr(b,8+i*IntPtr.Size).ToInt64());return l.ToArray();}finally{Marshal.FreeHGlobal(b);}}
 public static void Close(IntPtr j){if(j!=IntPtr.Zero)CloseHandle(j);}
}
'@
Add-Type -TypeDefinition $jobSource

function Write-Json([string]$file, $value) {
  $text = ($value | ConvertTo-Json -Depth 6 -Compress)
  $tmp = $file + '.stage-' + [Guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  Move-Item -LiteralPath $tmp -Destination $file
}
# Exact CIM creation identity, or $null when that PID is gone.
function Get-CimCreated([int]$processId) {
  $row = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -Property ProcessId,CreationDate
  if (-not $row -or -not $row.CreationDate) { return $null }
  return $row.CreationDate.ToFileTimeUtc().ToString()
}
function Get-MemberIdentities($job) {
  $rows = @()
  foreach ($memberPid in [RuyiMaintenanceOuterJob]::Pids($job)) {
    $rows += ,([pscustomobject]@{ pid = [int]$memberPid; cimCreated = (Get-CimCreated $memberPid) })
  }
  return ,$rows
}
function Wait-File([string]$file, [int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $file) { return $true }
    Start-Sleep -Milliseconds 25
  }
  return $false
}

$root = $env:RUYI_PM_ROOT
if (-not $root -or -not (Test-Path -LiteralPath $root)) { throw 'owned outer Job requires an existing fixture root' }
$waitMs = 900000
if ($env:RUYI_PM_WAIT_MS) { $waitMs = [int]$env:RUYI_PM_WAIT_MS }
$holdMs = 120000
if ($env:RUYI_PM_HOLD_MS) { $holdMs = [int]$env:RUYI_PM_HOLD_MS }
$target = Join-Path $root 'job-target.json'
$release = Join-Path $root 'job-release.json'
$hold = Join-Path $root 'job-hold.json'
$result = Join-Path $root 'outer-job-result.json'
$assignedFile = Join-Path $root 'job-assigned.json'
$job = [RuyiMaintenanceOuterJob]::Create()
$member = $null
try {
  Write-Json (Join-Path $root 'job-ready.json') ([pscustomobject]@{ schema = 1; kind = 'OWNED_OUTER_JOB'; keeperPid = $PID })
  $deadline = (Get-Date).AddMilliseconds($waitMs)
  while (-not (Test-Path -LiteralPath $target)) {
    if (Test-Path -LiteralPath $hold) {
      # Nothing was assigned yet: the retained scene belongs to the test, and
      # closing an empty Job kills no product process.
      Write-Json $result ([pscustomobject]@{ schema = 1; ok = $false; held = $true; reason = 'test-reported-failure'; assigned = $false; members = @() })
      [RuyiMaintenanceOuterJob]::Close($job); $job = [IntPtr]::Zero
      exit 1
    }
    if ((Get-Date) -gt $deadline) {
      Write-Json $result ([pscustomobject]@{ schema = 1; ok = $false; held = $false; reason = 'target-timeout'; assigned = $false; members = @() })
      [RuyiMaintenanceOuterJob]::Close($job); $job = [IntPtr]::Zero
      exit 1
    }
    Start-Sleep -Milliseconds 25
  }
  $identity = Get-Content -LiteralPath $target -Raw | ConvertFrom-Json
  $targetPid = [int]$identity.pid
  $expected = [string]$identity.cimCreated
  $actual = Get-CimCreated $targetPid
  # A reused PID has a different creation time: refuse rather than own a stranger.
  if (-not $actual -or $actual -ne $expected) {
    Write-Json $result ([pscustomobject]@{ schema = 1; ok = $false; held = $false; reason = 'target-identity-changed'; assigned = $false; pid = $targetPid; expected = $expected; actual = $actual; members = @() })
    [RuyiMaintenanceOuterJob]::Close($job); $job = [IntPtr]::Zero
    exit 1
  }
  $process = [System.Diagnostics.Process]::GetProcessById($targetPid)
  [RuyiMaintenanceOuterJob]::Assign($job, $process.Handle)
  $member = [pscustomobject]@{ pid = $targetPid; cimCreated = $expected }
  Write-Json $assignedFile ([pscustomobject]@{ schema = 1; assigned = $true; pid = $targetPid; cimCreated = $expected; keeperPid = $PID })
  $deadline = (Get-Date).AddMilliseconds($waitMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $release) { break }
    if (Test-Path -LiteralPath $hold) { break }
    Start-Sleep -Milliseconds 25
  }
  if (-not (Test-Path -LiteralPath $release)) {
    $members = Get-MemberIdentities $job
    $released = @()
    foreach ($row in $members) {
      if ($row.cimCreated) { $released += ,([pscustomobject]@{ pid = [int]$row.pid; cimCreated = [string]$row.cimCreated }) }
    }
    Write-Json $result ([pscustomobject]@{ schema = 1; ok = $false; held = $true; reason = $(if (Test-Path -LiteralPath $hold) { 'test-reported-failure' } else { 'keeper-timeout' }); assigned = $true; members = $released; autoClosedAfterHold = $false })
    # A bounded hold keeps the assigned successor alive for the operator, then the
    # Job is closed. The receipt says so and stays ok:false.
    Start-Sleep -Milliseconds $holdMs
    $after = Get-MemberIdentities $job
    [RuyiMaintenanceOuterJob]::Close($job); $job = [IntPtr]::Zero
    Write-Json (Join-Path $root 'outer-job-hold-closed.json') ([pscustomobject]@{ schema = 1; autoClosedAfterHold = $true; members = $after })
    exit 1
  }
  $members = Get-MemberIdentities $job
  $counted = @()
  foreach ($row in $members) {
    if ($row.cimCreated) { $counted += ,([pscustomobject]@{ pid = [int]$row.pid; cimCreated = [string]$row.cimCreated }) }
  }
  [RuyiMaintenanceOuterJob]::Close($job); $job = [IntPtr]::Zero
  # Absence is checked by the exact <pid, creation> pair, never by PID alone.
  $survived = @()
  $absenceDeadline = (Get-Date).AddMilliseconds(30000)
  do {
    $survived = @()
    foreach ($row in $counted) {
      $now = Get-CimCreated ([int]$row.pid)
      if ($now -and $now -eq [string]$row.cimCreated) { $survived += ,([pscustomobject]@{ pid = [int]$row.pid; cimCreated = [string]$row.cimCreated }) }
    }
    if ($survived.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $absenceDeadline)
  Write-Json $result ([pscustomobject]@{ schema = 1; ok = ($survived.Count -eq 0); closed = $true; assigned = $true; target = $member; members = $counted; survived = $survived })
  if ($survived.Count -ne 0) { exit 1 }
  exit 0
} finally {
  if ($job -ne [IntPtr]::Zero) { [RuyiMaintenanceOuterJob]::Close($job) }
}
