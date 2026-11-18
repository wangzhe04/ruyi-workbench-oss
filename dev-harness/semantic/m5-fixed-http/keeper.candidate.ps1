param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Script,[Parameter(Mandatory=$true)][string]$ControllerSha256,[Parameter(Mandatory=$true)][string]$Contract,[Parameter(Mandatory=$true)][string]$ContractSha256,[switch]$BusinessOnly)
$ErrorActionPreference='Stop'
# Secondary scrub; launcher supplies clean environment before PowerShell starts.
$rootPath=(Resolve-Path -LiteralPath $Root).Path
if (!(Test-Path -LiteralPath (Join-Path $rootPath 'OWNER.json'))) {throw 'owner missing'}
 # Rebuild a minimal environment before starting the owned controller.
 $system=[Environment]::SystemDirectory;$windows=[IO.Directory]::GetParent($system).FullName
 foreach($key in @([Environment]::GetEnvironmentVariables('Process').Keys)){[Environment]::SetEnvironmentVariable([string]$key,$null,'Process')}
 $isolatedHome=Join-Path $rootPath 'keeper-home';foreach($dir in @($isolatedHome,(Join-Path $isolatedHome 'local'),(Join-Path $isolatedHome 'roaming'),(Join-Path $isolatedHome 'tmp'))){[void][IO.Directory]::CreateDirectory($dir)}
 $env:SystemRoot=$windows;$env:WINDIR=$windows;$env:SystemDrive=[IO.Path]::GetPathRoot($windows).TrimEnd('\');$env:PATH=$system;$env:HOME=$isolatedHome;$env:USERPROFILE=$isolatedHome;$env:APPDATA=Join-Path $isolatedHome 'roaming';$env:LOCALAPPDATA=Join-Path $isolatedHome 'local';$env:TEMP=Join-Path $isolatedHome 'tmp';$env:TMP=$env:TEMP
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.ComponentModel;
public static class ResearchJob {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {public int cb;public string r,d,t;public int x,y,xs,ys,xc,yc,fill,flags;public short show,res;public IntPtr reserved,stdin,stdout,stderr;}
 [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public int pid,tid;}
 [StructLayout(LayoutKind.Sequential)] public struct BASIC {public long pt,jt;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] public struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] public struct EXT {public BASIC basic;public IO io;public UIntPtr proc,job,peakProc,peakJob;}
 [StructLayout(LayoutKind.Sequential)] public struct ACCOUNT {public long user,kernel,periodUser,periodKernel;public uint faults,total,active,terminated;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr j,int type,ref EXT data,int length);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool QueryInformationJobObject(IntPtr j,int type,IntPtr data,int length,out int returned);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool CreateProcess(string app,System.Text.StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)]public static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)]public static extern bool TerminateJobObject(IntPtr j,uint code);
 [DllImport("kernel32.dll",SetLastError=true)]public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr p,out long creation,out long exit,out long kernel,out long user);
 public static long Creation(IntPtr p){long a,b,c,d;Check(GetProcessTimes(p,out a,out b,out c,out d));return a;}
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static IntPtr Create(){IntPtr j=CreateJobObject(IntPtr.Zero,null);if(j==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());EXT e=new EXT();e.basic.flags=0x2000;Check(SetInformationJobObject(j,9,ref e,Marshal.SizeOf(typeof(EXT))));return j;}
 public static PI Start(IntPtr j,string app,string cmd,string cwd){STARTUPINFO s=new STARTUPINFO();s.cb=Marshal.SizeOf(typeof(STARTUPINFO));PI p;Check(CreateProcess(app,new System.Text.StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref s,out p));try{Check(AssignProcessToJobObject(j,p.process));if(ResumeThread(p.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());return p;}catch{TerminateProcess(p.process,1);TerminateJobObject(j,1);WaitForSingleObject(p.process,10000);CloseHandle(p.thread);CloseHandle(p.process);throw;}}
 public static ACCOUNT Stats(IntPtr j){int len=Marshal.SizeOf(typeof(ACCOUNT)),r;IntPtr b=Marshal.AllocHGlobal(len);try{Check(QueryInformationJobObject(j,1,b,len,out r));return (ACCOUNT)Marshal.PtrToStructure(b,typeof(ACCOUNT));}finally{Marshal.FreeHGlobal(b);}}
 [StructLayout(LayoutKind.Sequential)] struct PBI {public IntPtr Reserved1,Peb,Reserved20,Reserved21,Pid,Parent;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool member);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p,int flags,System.Text.StringBuilder image,ref int size);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int kind,ref PBI data,int length,out int returned);
 public sealed class ObservationFailure:Exception {public readonly string Stage;public readonly int NativeStatus;public ObservationFailure(string stage,int status):base("identity observation failed"){Stage=stage;NativeStatus=status;}}
 static void InspectCheck(bool ok,string stage){if(!ok)throw new ObservationFailure(stage,Marshal.GetLastWin32Error());}
 [StructLayout(LayoutKind.Sequential)] struct CompletionAssociation {public IntPtr Key, Port;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr port,IntPtr key,uint threads);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref CompletionAssociation data,int length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out IntPtr key,out IntPtr value,uint ms);
 public sealed class CaptureFailure : Exception {
  public readonly int Pid;
  public CaptureFailure(int pid,Exception cause):base("first capture failed",cause){Pid=pid;}
 }
 public sealed class EarlyCapture : IDisposable {
  readonly Dictionary<int,HeldMember> members=new Dictionary<int,HeldMember>();
  readonly IntPtr job,port;
  readonly System.Threading.Thread worker;
  volatile bool stopping;
  CaptureFailure failure;
  public EarlyCapture(IntPtr ownedJob) {
   job=ownedJob;
   port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1);
   Check(port!=IntPtr.Zero);
   try {
    var association=new CompletionAssociation{Key=new IntPtr(1),Port=port};
    Check(SetInformationJobObject(job,7,ref association,Marshal.SizeOf(typeof(CompletionAssociation))));
    worker=new System.Threading.Thread(Receive){IsBackground=true};worker.Start();
   } catch {CloseHandle(port);throw;}
  }
  void Receive() {
   try {
    while(true){
     uint message;IntPtr key,value;
     if(!GetQueuedCompletionStatus(port,out message,out key,out value,20)){
      int status=Marshal.GetLastWin32Error();
      if(status!=258)throw new CaptureFailure(0,new ObservationFailure("completion-port-receive",status));
      if(stopping)return;
      continue;
     }
     if(key!=new IntPtr(1))throw new CaptureFailure(0,new ObservationFailure("completion-key-conflict",0));
     if(message==6)Ensure(value.ToInt32());
    }
   } catch(Exception cause){lock(members){if(failure==null)failure=cause as CaptureFailure ?? new CaptureFailure(0,cause);}}
  }
  public HeldMember Ensure(int pid){
   lock(members){
    if(failure!=null)throw failure;
    HeldMember member;
    if(members.TryGetValue(pid,out member))return member;
    try {member=new HeldMember(job,pid);members.Add(pid,member);return member;}
    catch(Exception cause){failure=new CaptureFailure(pid,cause);throw failure;}
   }
  }
  public HeldMember[] Snapshot(){lock(members){if(failure!=null)throw failure;var captured=new HeldMember[members.Count];members.Values.CopyTo(captured,0);return captured;}}
  public void Stop(){stopping=true;if(!worker.Join(1000))throw new CaptureFailure(0,new ObservationFailure("completion-port-stop",258));}
  public void Dispose(){Stop();CloseHandle(port);lock(members){foreach(var member in members.Values)member.Dispose();}}
 }
 // Keeping the handle open also reserves its process ID until final cleanup.
 public sealed class HeldMember : IDisposable {
  IntPtr process;
  public readonly int Pid;
  public readonly long Birth, Parent;
  public readonly string Image;
  public bool Retired { get; private set; }
  public uint ExitCode { get; private set; }
  public HeldMember(IntPtr job,int pid) {
   IntPtr p=OpenProcess(0x101400,false,pid);
   if(p==IntPtr.Zero)throw new ObservationFailure("open-process",Marshal.GetLastWin32Error());
   try {
    bool member;
    InspectCheck(IsProcessInJob(p,job,out member),"is-process-in-job");
    if(!member)throw new ObservationFailure("not-exact-job",0);
    long birth,exit,kernel,user;
    InspectCheck(GetProcessTimes(p,out birth,out exit,out kernel,out user),"get-process-times");
    var image=new System.Text.StringBuilder(32768);int n=image.Capacity;
    InspectCheck(QueryFullProcessImageName(p,0,image,ref n),"query-image");
    PBI q=new PBI();int returned;
    int status=NtQueryInformationProcess(p,0,ref q,Marshal.SizeOf(typeof(PBI)),out returned);
    if(status!=0)throw new ObservationFailure("query-parent",status);
    if(q.Pid.ToInt64()!=pid||birth<=0||n<=0)throw new ObservationFailure("identity-conflict",0);
    Pid=pid;Birth=birth;Parent=q.Parent.ToInt64();Image=image.ToString();
    process=p;p=IntPtr.Zero;
   } finally { if(p!=IntPtr.Zero)CloseHandle(p); }
  }
  public bool PollRetirement() {
   if(process==IntPtr.Zero)throw new ObjectDisposedException("HeldMember");
   if(Retired)return false;
   uint wait=WaitForSingleObject(process,0);
   if(wait==0x102)return false;
   if(wait!=0)throw new ObservationFailure("held-wait",Marshal.GetLastWin32Error());
   uint code;
   InspectCheck(GetExitCodeProcess(process,out code),"held-exit-code");
   long birth,exit,kernel,user;
   InspectCheck(GetProcessTimes(process,out birth,out exit,out kernel,out user),"get-process-times");
   if(birth!=Birth||exit<=0)throw new ObservationFailure("identity-conflict",0);
   ExitCode=code;Retired=true;return true;
  }
  public void Dispose() { if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;} }
 }
 public static long[] Pids(IntPtr j){int len=65536,r;IntPtr b=Marshal.AllocHGlobal(len);try{Check(QueryInformationJobObject(j,3,b,len,out r));int n=Marshal.ReadInt32(b,4);long[] a=new long[n];for(int i=0;i<n;i++)a[i]=Marshal.ReadIntPtr(b,8+i*IntPtr.Size).ToInt64();return a;}finally{Marshal.FreeHGlobal(b);}}
}
'@
$job=[IntPtr]::Zero;$proc=$null;$receipt=[ordered]@{schema=1;status='FAIL';error=$null;terminationRequested=$false}
$held=@{};$sample=0;$earlyCapture=$null
$birthLog=Join-Path $rootPath 'job-member-creations.jsonl'
$membersLog=Join-Path $rootPath 'job-member-observations.jsonl'
$retiredLog=Join-Path $rootPath 'job-member-retirements.jsonl'
$cohortLog=Join-Path $rootPath 'job-member-complete-samples.jsonl'
function Publish-Cohort($rows) {
 $line=(@{sample=$sample;rows=$rows} | ConvertTo-Json -Depth 5 -Compress)+[char]10
 $bytes=[Text.Encoding]::UTF8.GetBytes($line)
 $stream=[IO.FileStream]::new($cohortLog,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
 try {$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
function Sample-Job {
 $script:sample++
 try {foreach($captured in $earlyCapture.Snapshot()){Import-HeldMember $captured}}
 catch {Write-ObservationFailure 0 $_.Exception}
 $listed=@{}
 $cohort=[System.Collections.Generic.List[object]]::new()
 foreach($memberPid in @([ResearchJob]::Pids($job))){
   $id=[int]$memberPid
   try {
    if($id -le 0 -or $listed.ContainsKey($id)){throw [ResearchJob+ObservationFailure]::new('identity-conflict',0)}
    $listed[$id]=$true
    if(!$held.ContainsKey($id)){Import-HeldMember ($earlyCapture.Ensure($id))}
    $v=$held[$id]
    Record-Retirement $v
    if(!$v.Retired){
     $row=@{schema=1;sample=$sample;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pid=$v.Pid;creation=[string]$v.Birth;parentPid=$v.Parent;image=$v.Image;exactJob=$true}
     $cohort.Add($row)
     $row|ConvertTo-Json -Compress|Add-Content -Encoding UTF8 -LiteralPath $membersLog
    }
   }catch{ Write-ObservationFailure $id $_.Exception }
 }
 foreach($v in $held.Values){
  if(!$listed.ContainsKey($v.Pid)){
   try {Record-Retirement $v}catch{Write-ObservationFailure $v.Pid $_.Exception}
  }
 }
 Publish-Cohort ($cohort.ToArray())
}
function Import-HeldMember($member) {
 if($held.ContainsKey($member.Pid)){return}
 @{schema=1;sample=$sample;pid=$member.Pid;creation=[string]$member.Birth;parentPid=$member.Parent;image=$member.Image;exactJob=$true}|ConvertTo-Json -Compress|Add-Content -Encoding UTF8 -LiteralPath $birthLog
 $held[$member.Pid]=$member
}
function Record-Retirement($v) {
 if($v.PollRetirement()){
  @{schema=1;sample=$sample;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pid=$v.Pid;creation=[string]$v.Birth;parentPid=$v.Parent;image=$v.Image;exactJob=$true;wait='signaled';exitCode=$v.ExitCode}|ConvertTo-Json -Compress|Add-Content -Encoding UTF8 -LiteralPath $retiredLog
 }
}
function Write-ObservationFailure($id,$failure){
 $safeStage='unknown';$safeStatus=$null
 for($depth=0;$depth -lt 8 -and $null -ne $failure;$depth++){
  if($failure -is [ResearchJob+CaptureFailure]){$id=$failure.Pid}
  if($failure -is [ResearchJob+ObservationFailure]){$safeStage=$failure.Stage;$safeStatus=$failure.NativeStatus;break}
  $failure=$failure.InnerException
 }
 try {@{schema=1;sample=$sample;pid=$id;stage=$safeStage;nativeStatus=$safeStatus}|ConvertTo-Json -Compress|Set-Content -Encoding UTF8 -LiteralPath (Join-Path $rootPath 'identity-observation-failure.json')}catch{}
 throw 'job member identity observation unknown'
}

function Confirm-FlushChildren($reviewedContract){
 $powerShell=$reviewedContract.powershell
 $processes=@($held.Values | Where-Object {$_.Image -ieq $powerShell})
 $file=Join-Path $rootPath 'guard-flush-events.jsonl'
 $rows=@()
 if(Test-Path -LiteralPath $file){$rows=@(Get-Content -LiteralPath $file | ForEach-Object {ConvertFrom-Json $_})}
 if($rows.Count -ne ($processes.Count*3)){throw 'flush helper lifecycle unpaired'}
 $serverRows=@(Get-Content -LiteralPath (Join-Path $rootPath 'guard-child-events.jsonl') | ForEach-Object {ConvertFrom-Json $_})
 $seen=@{}
 for($i=0;$i -lt $rows.Count;$i+=3){
  $start,$end,$close=$rows[$i],$rows[$i+1],$rows[$i+2]
  if(@($start.schema,$end.schema,$close.schema | Where-Object {$_ -ne 1}).Count -or
     $start.inputAccepted -ne $true -or $start.kind -cne 'spawn' -or $end.kind -cne 'exit' -or $close.kind -cne 'close' -or
     $start.pid -ne $end.pid -or $start.pid -ne $close.pid -or
     $start.parentPid -ne $end.parentPid -or $start.parentPid -ne $close.parentPid -or
     $start.at -gt $end.at -or $end.at -gt $close.at -or
     $end.code -ne 0 -or $close.code -ne 0 -or $end.signal -or $close.signal){throw 'flush helper Node lifecycle unknown'}
  $id=[int]$start.pid;$parent=[int]$start.parentPid
  if($seen.ContainsKey($id) -or !$held.ContainsKey($id) -or !$held.ContainsKey($parent)){throw 'flush helper identity unknown'}
  $v=$held[$id];$owner=$held[$parent]
  if($v.Image -ine $powerShell -or $v.Parent -ne $parent -or $owner.Image -ine $reviewedContract.node -or
     $v.Birth -lt $owner.Birth -or !$v.Retired -or $v.ExitCode -ne 0){throw 'flush helper held lifecycle unknown'}
  $bounds=@($serverRows | Where-Object {$_.pid -eq $parent})
  if($bounds.Count -ne 2 -or $start.at -lt $bounds[0].at -or $close.at -gt $bounds[1].at){throw 'flush helper owner window unknown'}
  $seen[$id]=$true
 }
 return $seen.Count
}
function Confirm-BusinessDrain($status,$code,$accounting,$forced) {
 return ($status -ceq 'BUSINESS_ASSERTIONS_AND_GUARD_CLOSE_REQUIRE_OUTER_JOB' -and
         $code -eq 0 -and $forced -eq $false -and $null -ne $accounting -and
         $null -ne $accounting.active -and $accounting.active -eq 0 -and
         $null -ne $accounting.members -and @($accounting.members).Count -eq 0 -and
         $accounting.totalProcesses -gt 0 -and $null -ne $accounting.limitTerminatedProcesses -and
         $accounting.limitTerminatedProcesses -eq 0)
}

try{
 $rootPath=(Resolve-Path -LiteralPath $Root).Path;$scriptPath=(Resolve-Path -LiteralPath $Script).Path;$nodePath=(Resolve-Path -LiteralPath $Node).Path;$contractPath=(Resolve-Path -LiteralPath $Contract).Path
 if (!(Test-Path -LiteralPath (Join-Path $rootPath 'OWNER.json'))) {throw 'owner missing'}
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash.ToLowerInvariant() -ne $ControllerSha256) {throw 'controller hash mismatch'}
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath $contractPath).Hash.ToLowerInvariant() -ne $ContractSha256) {throw 'contract hash mismatch'}
 foreach($v in @($rootPath,$scriptPath,$nodePath,$contractPath)){if($v.Contains('"')){throw 'invalid path'}}
 $reviewedContract=Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
 $expectedKind=if($BusinessOnly){'FROZEN_M5_HTTP_BUSINESS_ONLY'}else{'FROZEN_M5_HTTP_EXECUTABLE'}
 if($reviewedContract.status -cne $expectedKind){throw 'M5 lane mismatch'}
 $op=if($BusinessOnly){'run-business'}else{'run'}
 if($BusinessOnly){$receipt.lane='business-only';$receipt.perProcessIdentityQualification='NOT_RUN'}
 $job=[ResearchJob]::Create()
 if(!$BusinessOnly){$earlyCapture=[ResearchJob+EarlyCapture]::new($job)}
 $cmd='"'+$nodePath+'" "'+$scriptPath+'" '+$op+' "'+$contractPath+'" '+$ContractSha256;$proc=[ResearchJob]::Start($job,$nodePath,$cmd,$rootPath);$receipt.controllerPid=$proc.pid;$receipt.controllerCreationFileTime=[string][ResearchJob]::Creation($proc.process)
 $deadline=(Get-Date).AddSeconds(135);$done=$false
 while((Get-Date) -lt $deadline){
   if(!$BusinessOnly){Sample-Job}
   $wait=[ResearchJob]::WaitForSingleObject($proc.process,250)
   if($wait -eq 0){$done=$true;break}
   if($wait -ne 258){throw 'controller handle wait failed'}
 }

 if(!$done){throw 'controller deadline'}
 $code=0;if(![ResearchJob]::GetExitCodeProcess($proc.process,[ref]$code)){throw 'controller exit query failed'};$receipt.controllerExitCode=$code
 $receiptPath=Join-Path $rootPath 'controller-receipt.json';if(!(Test-Path -LiteralPath $receiptPath)){throw 'controller receipt missing'}
 $childReceipt=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
 $expectedReceipt=if($BusinessOnly){'BUSINESS_ASSERTIONS_AND_GUARD_CLOSE_REQUIRE_OUTER_JOB'}else{'CONTROLLER_SUCCESS_REQUIRES_OUTER_JOB'}
 if($code -ne 0 -or $childReceipt.status -cne $expectedReceipt){throw 'controller did not complete scoped M5 trial'}
 $s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));$receipt.beforeReclaim=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}
 if($s.active -gt 0 -or $ids.Count -gt 0){$settle=(Get-Date).AddSeconds(2);do{Start-Sleep -Milliseconds 50;if(!$BusinessOnly){Sample-Job};$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break}}while((Get-Date) -lt $settle);if($s.active -gt 0 -or $ids.Count -gt 0){throw 'product or auxiliary process remained before fallback reclamation'}}
 $drain=(Get-Date).AddSeconds(15);do{$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $drain)
 $receipt.accounting=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}
 if($s.active -ne 0 -or $ids.Count -ne 0){throw 'owned job not drained'}
 if($BusinessOnly){
  if(!(Confirm-BusinessDrain $childReceipt.status $code $receipt.accounting $receipt.terminationRequested)){throw 'M5 business-only natural drain unproven'}
  $receipt.status='PASS_M5_LOOPBACK_BUSINESS_ONLY_NATURAL_JOB_DRAIN'
 }else{
   try {$earlyCapture.Stop()}catch {Write-ObservationFailure 0 $_.Exception}
   Sample-Job
   $receipt.heldIdentities=$held.Count
   $receipt.heldRetired=@($held.Values | Where-Object Retired).Count
   if($s.terminated -ne 0 -or $receipt.heldIdentities -ne $s.total -or $receipt.heldRetired -ne $receipt.heldIdentities){throw 'unobserved or unretired job process identity'}
   if(!$held.ContainsKey($proc.pid) -or [string]$held[$proc.pid].Birth -cne $receipt.controllerCreationFileTime){throw 'controller identity conflict'}
   $receipt.flushHelpers=Confirm-FlushChildren (Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json)
   $receipt.status='PASS_M5_SCOPED_OUTER_DRAINED'
 }


}catch{
 $receipt.error=$_.Exception.ToString()
 if($job -ne [IntPtr]::Zero){$receipt.terminationRequested=$true;$receipt.terminationCallSucceeded=[ResearchJob]::TerminateJobObject($job,91);$drain=(Get-Date).AddSeconds(15);do{try{$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break}}catch{$receipt.terminationQueryError=$_.Exception.ToString();break};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $drain);if($s){$receipt.afterTermination=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}}}
}finally{
 if($earlyCapture){try{$earlyCapture.Dispose()}catch{$receipt.status='FAIL';$receipt.captureCleanupError=$_.Exception.ToString()}}
 if($proc){[void][ResearchJob]::CloseHandle($proc.thread);[void][ResearchJob]::CloseHandle($proc.process)};if($job -ne [IntPtr]::Zero){[void][ResearchJob]::CloseHandle($job)}
 $out=Join-Path $Root 'outer-job-receipt.json';if(Test-Path -LiteralPath $out){throw 'receipt already exists'};$receipt|ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $out
}
if($BusinessOnly){if($receipt.status -cne 'PASS_M5_LOOPBACK_BUSINESS_ONLY_NATURAL_JOB_DRAIN'){exit 1}}else{if($receipt.status -cne 'PASS_M5_SCOPED_OUTER_DRAINED'){exit 1}}
