param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

# Process observation only. No window API, UI automation, input, termination,
# process-table sweep or replacement process lookup after the original is held.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class RuyiDesktopQualificationProcess {
  [StructLayout(LayoutKind.Sequential)] public struct Time { public uint Low, High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out Time c, out Time e, out Time k, out Time u);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr h, IntPtr job, out bool result);
  public static string Created(IntPtr h) { Time c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u))throw new Win32Exception(); return (((ulong)c.High<<32)|c.Low).ToString(); }
  public static string Image(IntPtr h) { var text=new StringBuilder(32768); int size=text.Capacity; if(!QueryFullProcessImageName(h,0,text,ref size))throw new Win32Exception(); return text.ToString(); }
  public static bool InAnyJob(IntPtr h) { bool answer; if(!IsProcessInJob(h,IntPtr.Zero,out answer))throw new Win32Exception(); return answer; }
}
'@
function Require($Condition, [string]$Reason) { if (-not $Condition) { throw $Reason } }
function SamePath([string]$A, [string]$B) { return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($A), [IO.Path]::GetFullPath($B)) }
function Receipt([string]$Name, $Value) {
  $file = Join-Path $job.output $Name
  $pending = $file + '.writing-' + $PID
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
  $stream = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($pending, $file)
}
function ReadProcess([int]$ProcessNumber) {
  return Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ProcessNumber) -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
}
function CheckRow($Row, [int]$ProcessNumber, [int]$ParentNumber, [string]$Image) {
  Require ($null -ne $Row) 'selected process absent'
  Require ([int]$Row.ProcessId -eq $ProcessNumber -and [int]$Row.ParentProcessId -eq $ParentNumber) 'selected parent/process identity mismatch'
  Require ($Row.ExecutablePath -and (SamePath $Row.ExecutablePath $Image)) 'selected executable identity mismatch'
  Require ($null -ne $Row.CreationDate -and $Row.CommandLine) 'selected birth/command identity unavailable'
}

$job = $null
$original = $null
$held = $false
$released = $false
$unknown = $false
try {
  Require ([IO.Path]::IsPathRooted($JobFile)) 'absolute job file required'
  $job = Get-Content -LiteralPath $JobFile -Raw | ConvertFrom-Json
  Require (SamePath ([IO.Path]::GetDirectoryName($JobFile)) $job.output) 'job is outside its original output'
  $owner = Get-Content -LiteralPath (Join-Path $job.output 'desktop-owner.json') -Raw | ConvertFrom-Json
  Require ($job.schema -eq 1 -and $owner.nonce -eq $job.nonce -and $env:RUYI_DESKTOP_QUALIFICATION_NONCE -eq $job.nonce) 'original fixture nonce mismatch'
  Require (SamePath $owner.stage $job.stage) 'original fixture stage mismatch'
  Require ([int]$job.serverPid -gt 0 -and [int]$job.desktopPid -gt 0 -and [int]$job.driverPid -gt 0) 'positive original process identities required'
  Require (SamePath $job.serverExe (Join-Path $job.stage 'runtime\node\node.exe')) 'Desktop backend must be the actual bundled Node'
  Require (SamePath $job.desktopExe (Join-Path $job.stage 'RuyiDesktop.exe')) 'original Desktop executable required'
  $desktopBefore = ReadProcess ([int]$job.desktopPid)
  CheckRow $desktopBefore ([int]$job.desktopPid) ([int]$job.driverPid) $job.desktopExe
  $before = ReadProcess ([int]$job.serverPid)
  CheckRow $before ([int]$job.serverPid) ([int]$job.desktopPid) $job.serverExe
  $cimCreated = $before.CreationDate.ToFileTimeUtc().ToString()
  $desktopCreated = $desktopBefore.CreationDate.ToFileTimeUtc().ToString()
  $original = [Diagnostics.Process]::GetProcessById([int]$job.serverPid)
  $handle = $original.Handle
  Require ($handle -ne [IntPtr]::Zero -and $handle.ToInt64() -ne -1) 'original native handle unavailable'
  $held = $true
  $nativeCreated = [RuyiDesktopQualificationProcess]::Created($handle)
  Require ($original.StartTime.ToFileTimeUtc().ToString() -eq $nativeCreated) 'held .NET/native creation identity differs'
  Require (SamePath ([RuyiDesktopQualificationProcess]::Image($handle)) $job.serverExe) 'held native executable differs'
  Require ([RuyiDesktopQualificationProcess]::WaitForSingleObject($handle,0) -eq 258) 'original backend already exited before GUI handoff'
  $after = ReadProcess ([int]$job.serverPid)
  CheckRow $after ([int]$job.serverPid) ([int]$job.desktopPid) $job.serverExe
  Require ($after.CreationDate.ToFileTimeUtc().ToString() -eq $cimCreated -and $after.CommandLine -ceq $before.CommandLine) 'CIM birth/command changed across original handle acquisition'
  $desktopAfter = ReadProcess ([int]$job.desktopPid)
  CheckRow $desktopAfter ([int]$job.desktopPid) ([int]$job.driverPid) $job.desktopExe
  Require ($desktopAfter.CreationDate.ToFileTimeUtc().ToString() -eq $desktopCreated) 'original Desktop changed across backend handle acquisition'
  $inAnyJob = [RuyiDesktopQualificationProcess]::InAnyJob($handle)
  Require $inAnyJob 'Desktop-created backend is not in any Job'
  $ready = [pscustomobject]@{schema=1;kind='ORIGINAL_BACKEND_HANDLE_HELD';nonce=$job.nonce;observerPid=$PID;
    desktopPid=[int]$job.desktopPid;driverPid=[int]$job.driverPid;serverPid=[int]$job.serverPid;
    serverExe=$job.serverExe;desktopExe=$job.desktopExe;cimCreated=$cimCreated;nativeCreated=$nativeCreated;desktopCimCreated=$desktopCreated;
    heldAt=[DateTime]::UtcNow.ToString('o');inAnyJob=$inAnyJob;jobIdentityAndAllDescendantsCertified=$false}
  Receipt 'native-observer-ready.json' $ready
  $deadline = [DateTime]::Parse($job.deadlineUtc).ToUniversalTime()
  while ($true) {
    $wait = [RuyiDesktopQualificationProcess]::WaitForSingleObject($handle,100)
    if ($wait -eq 0) { break }
    Require ($wait -eq 258) 'original native wait failed'
    if (-not $unknown -and [DateTime]::UtcNow -ge $deadline) {
      $unknown = $true
      Receipt 'native-observer-unknown.json' ([pscustomobject]@{schema=1;status='UNKNOWN_ORIGINAL_HANDLE_STILL_HELD';serverPid=$job.serverPid;nonce=$job.nonce;observedAt=[DateTime]::UtcNow.ToString('o');pidAbsenceUsed=$false})
      # Do not substitute an absent/reused PID or dispose the only original
      # handle on timeout. Root still owns the GUI and may close it normally.
    }
  }
  $signaledAt = [DateTime]::UtcNow.ToString('o')
  Require ([RuyiDesktopQualificationProcess]::Created($handle) -eq $nativeCreated) 'original native birth changed'
  [uint32]$exitCode = 259
  Require ([RuyiDesktopQualificationProcess]::GetExitCodeProcess($handle,[ref]$exitCode)) 'original native exit code unavailable'
  $original.Dispose(); $released = $true
  Receipt 'native-observer-final.json' ([pscustomobject]@{schema=1;kind='ORIGINAL_BACKEND_HANDLE_SIGNALED';nonce=$job.nonce;
    serverPid=[int]$job.serverPid;nativeCreated=$nativeCreated;cimCreated=$cimCreated;signaledAt=$signaledAt;exitCode=$exitCode;
    originalHandleSignaled=$true;handleDisposed=$true;timedOut=$unknown;allDescendantKernelExitCertified=$false})
  if ($unknown -or $exitCode -ne 0) { exit 1 }
} catch {
  $primaryMessage = $_.Exception.Message
  if ($null -ne $job) {
    try { Receipt 'native-observer-error.json' ([pscustomobject]@{schema=1;status='UNKNOWN';nonce=$job.nonce;error=$primaryMessage;originalHandleHeld=$held;handleDisposed=$released}) } catch {}
  }
  [Console]::Error.WriteLine($primaryMessage)
  if ($held -and -not $released) {
    # Retain the exact .NET owner even when observation itself failed. An
    # original signal may release it later; no fresh PID lookup or kill occurs.
    while ([RuyiDesktopQualificationProcess]::WaitForSingleObject($handle,1000) -ne 0) { Start-Sleep -Milliseconds 1000 }
    $original.Dispose()
  }
  exit 1
}
