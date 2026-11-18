$ErrorActionPreference = 'Stop'
$keeper = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'keeper.candidate.ps1')).Replace("`r`n", "`n")
$code = $keeper.Split(@("@'" + "`n"), [StringSplitOptions]::None)[1].Split(@("`n'@"), [StringSplitOptions]::None)[0]
$code = $code.Replace('s.cb=Marshal.SizeOf(typeof(STARTUPINFO));PI p;', 's.cb=Marshal.SizeOf(typeof(STARTUPINFO));s.flags=1;s.show=0;PI p;').Replace('0x08000004','0x00000014')
$addition = @'
 public sealed class Report {
  public uint Total, Active, LimitTerminated;
  public int RootPid;
  public uint RootExitCode;
  public bool Forced, AllProved;
  public System.Collections.Generic.List<HeldMember> Members = new System.Collections.Generic.List<HeldMember>();
  public System.Collections.Generic.List<string> Errors = new System.Collections.Generic.List<string>();
 }
 public static Report Probe(string cmd, string cwd) {
  var result = new Report();
  IntPtr job = Create();
  PI root = new PI();
  EarlyCapture capture = null;
  try {
   capture = new EarlyCapture(job);
   string child="\""+cmd+"\" /d /q /c exit 0";
   string batch=child+" & "+child+" & "+child+" & "+child;
   root=Start(job,cmd,"\""+cmd+"\" /d /q /s /c \"" + batch+"\"",cwd);
   result.RootPid=root.pid;
   if(WaitForSingleObject(root.process,1500)!=0)throw new TimeoutException("synthetic command exit");
   Check(GetExitCodeProcess(root.process,out result.RootExitCode));
   var settle=System.Diagnostics.Stopwatch.StartNew();
   while(Stats(job).active!=0 && settle.ElapsedMilliseconds<2000)System.Threading.Thread.Sleep(20);
   capture.Stop();
   try {result.Members.AddRange(capture.Snapshot());}
   catch(CaptureFailure error){result.Errors.Add(error.Pid+":"+error.InnerException.Message);}
   var stats=Stats(job);
   result.Total=stats.total;result.Active=stats.active;result.LimitTerminated=stats.terminated;
   foreach(var member in result.Members) {
    try {if(!member.PollRetirement())result.Errors.Add(member.Pid+":unsignaled");}
    catch(ObservationFailure error){result.Errors.Add(member.Pid+":"+error.Stage+":"+error.NativeStatus);}
   }
   result.AllProved=stats.total>=5 && stats.total==result.Members.Count && stats.active==0 && stats.terminated==0 && result.RootExitCode==0 && result.Errors.Count==0 && result.Members.Exists(m => m.Pid==root.pid && m.Birth==Creation(root.process));
  } finally {
   if(Stats(job).active>0) {result.Forced=true;TerminateJobObject(job,91);}
   if(capture!=null)capture.Dispose();
   if(root.thread!=IntPtr.Zero)CloseHandle(root.thread);
   if(root.process!=IntPtr.Zero)CloseHandle(root.process);
   CloseHandle(job);
  }
  return result;
 }
 public static bool FirstFailureStaysLatched() {
  IntPtr job=Create();
  try {
   using(var capture=new EarlyCapture(job)) {
    CaptureFailure first=null;
    try {capture.Ensure(0);}catch(CaptureFailure error){first=error;}
    if(first==null || first.Pid!=0 || ((ObservationFailure)first.InnerException).Stage!="open-process")return false;
    try {capture.Snapshot();}catch(CaptureFailure error){return Object.ReferenceEquals(first,error);}
    return false;
   }
  } finally {CloseHandle(job);}
 }
'@
Add-Type -TypeDefinition ($code.Substring(0,$code.LastIndexOf('}')) + $addition + "`n}")
$scope=Join-Path ([IO.Path]::GetTempPath()) ('ruyi-iocp-synthetic-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scope)
$result=[ResearchJob]::Probe((Join-Path ([Environment]::SystemDirectory) 'cmd.exe'),$scope)
$firstFailureLatched=[ResearchJob]::FirstFailureStaysLatched()
$result | Add-Member -NotePropertyName FirstFailureLatched -NotePropertyValue $firstFailureLatched
$receipt=Join-Path $scope 'receipt.json'
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding UTF8
Get-Content -LiteralPath $receipt
Write-Output $receipt
if(!$result.AllProved -or !$firstFailureLatched){exit 1}
