param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Script,[Parameter(Mandatory=$true)][string]$ControllerSha256,[Parameter(Mandatory=$true)][string]$Contract,[Parameter(Mandatory=$true)][string]$ContractSha256)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.ComponentModel;
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
 public static long[] Pids(IntPtr j){int len=65536,r;IntPtr b=Marshal.AllocHGlobal(len);try{Check(QueryInformationJobObject(j,3,b,len,out r));int n=Marshal.ReadInt32(b,4);long[] a=new long[n];for(int i=0;i<n;i++)a[i]=Marshal.ReadIntPtr(b,8+i*IntPtr.Size).ToInt64();return a;}finally{Marshal.FreeHGlobal(b);}}
}
'@
$job=[IntPtr]::Zero;$proc=$null;$receipt=[ordered]@{schema=1;status='FAIL';error=$null;terminationRequested=$false}
try{
 $rootPath=(Resolve-Path -LiteralPath $Root).Path;$scriptPath=(Resolve-Path -LiteralPath $Script).Path;$nodePath=(Resolve-Path -LiteralPath $Node).Path;$contractPath=(Resolve-Path -LiteralPath $Contract).Path
 if (!(Test-Path -LiteralPath (Join-Path $rootPath 'OWNER.json'))) {throw 'owner missing'}
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash.ToLowerInvariant() -ne $ControllerSha256) {throw 'controller hash mismatch'}
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath $contractPath).Hash.ToLowerInvariant() -ne $ContractSha256) {throw 'contract hash mismatch'}
 foreach($v in @($rootPath,$scriptPath,$nodePath,$contractPath)){if($v.Contains('"')){throw 'invalid path'}}
 # Restrict inherited state before Node starts; product child environment is further restricted by releaseEnvironment.
 foreach($key in @([Environment]::GetEnvironmentVariables('Process').Keys)){if([string]$key -match '^(NODE_OPTIONS|NODE_PATH|NODE_DEBUG|RUYI_|WCW_|CLAUDE_|KIMI_|CODEX_|ANTHROPIC_|OPENAI_)'){[Environment]::SetEnvironmentVariable([string]$key,$null,'Process')}}
 $isolatedHome=Join-Path $rootPath 'keeper-home';foreach($dir in @($isolatedHome,(Join-Path $isolatedHome 'local'),(Join-Path $isolatedHome 'roaming'),(Join-Path $isolatedHome 'tmp'),(Join-Path $isolatedHome 'claude'),(Join-Path $isolatedHome 'kimi'),(Join-Path $isolatedHome 'codex'),(Join-Path $isolatedHome 'data'))){[void][IO.Directory]::CreateDirectory($dir)}
 $env:HOME=$isolatedHome;$env:USERPROFILE=$isolatedHome;$env:HOMEDRIVE=[IO.Path]::GetPathRoot($isolatedHome).TrimEnd('\');$env:HOMEPATH=$isolatedHome.Substring($env:HOMEDRIVE.Length)
 $env:APPDATA=Join-Path $isolatedHome 'roaming';$env:LOCALAPPDATA=Join-Path $isolatedHome 'local';$env:TEMP=Join-Path $isolatedHome 'tmp';$env:TMP=$env:TEMP
 $env:RUYI_HOME=Join-Path $isolatedHome 'data';$env:WIN_CLAUDE_WORKBENCH_HOME=$env:RUYI_HOME;$env:CLAUDE_CONFIG_DIR=Join-Path $isolatedHome 'claude';$env:KIMI_CODE_HOME=Join-Path $isolatedHome 'kimi';$env:CODEX_HOME=Join-Path $isolatedHome 'codex';$env:WCW_NO_BROWSER='1';$env:HF_HUB_OFFLINE='1';$env:TRANSFORMERS_OFFLINE='1'
 $job=[ResearchJob]::Create();$cmd='"'+$nodePath+'" "'+$scriptPath+'" run "'+$contractPath+'" '+$ContractSha256;$proc=[ResearchJob]::Start($job,$nodePath,$cmd,$rootPath);$receipt.controllerPid=$proc.pid;$receipt.controllerCreationFileTime=[string][ResearchJob]::Creation($proc.process)
 $deadline=(Get-Date).AddSeconds(70);$done=$false
 while((Get-Date) -lt $deadline){if([ResearchJob]::WaitForSingleObject($proc.process,250) -eq 0){$done=$true;break}}
 if(!$done){throw 'controller deadline'}
 $code=0;if(![ResearchJob]::GetExitCodeProcess($proc.process,[ref]$code)){throw 'controller exit query failed'};$receipt.controllerExitCode=$code
 $receiptPath=Join-Path $rootPath 'receipt.json';if(!(Test-Path -LiteralPath $receiptPath)){throw 'controller receipt missing'}
 $childReceipt=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
 if($code -ne 0 -or $childReceipt.status -ne 'PASS_PROXY_DEATH_SYNTHETIC_NOT_MODEL_QUALIFICATION'){throw 'controller did not complete scoped synthetic proxy trial'}
 $s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));$receipt.beforeReclaim=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}
 if($s.active -gt 0 -or $ids.Count -gt 0){$settle=(Get-Date).AddSeconds(2);do{Start-Sleep -Milliseconds 50;$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break}}while((Get-Date) -lt $settle);if($s.active -gt 0 -or $ids.Count -gt 0){throw 'product or auxiliary process remained before fallback reclamation'}}
 $drain=(Get-Date).AddSeconds(15);do{$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $drain)
 $receipt.accounting=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}
 if($s.active -ne 0 -or $ids.Count -ne 0){throw 'owned job not drained'}
 $receipt.status='PASS_PROXY_DEATH_OUTER_DRAINED'

}catch{
 $receipt.error=$_.Exception.ToString()
 if($job -ne [IntPtr]::Zero){$receipt.terminationRequested=$true;$receipt.terminationCallSucceeded=[ResearchJob]::TerminateJobObject($job,91);$drain=(Get-Date).AddSeconds(15);do{try{$s=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($s.active -eq 0 -and $ids.Count -eq 0){break}}catch{$receipt.terminationQueryError=$_.Exception.ToString();break};Start-Sleep -Milliseconds 100}while((Get-Date) -lt $drain);if($s){$receipt.afterTermination=@{active=$s.active;totalProcesses=$s.total;limitTerminatedProcesses=$s.terminated;members=$ids}}}
}finally{
 if($proc){[void][ResearchJob]::CloseHandle($proc.thread);[void][ResearchJob]::CloseHandle($proc.process)};if($job -ne [IntPtr]::Zero){[void][ResearchJob]::CloseHandle($job)}
 $out=Join-Path $Root 'outer-job-receipt.json';if(Test-Path -LiteralPath $out){throw 'receipt already exists'};$receipt|ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $out
}
if($receipt.status -ne 'PASS_PROXY_DEATH_OUTER_DRAINED'){exit 1}
