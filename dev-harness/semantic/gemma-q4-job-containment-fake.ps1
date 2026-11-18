param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Script,[Parameter(Mandatory=$true)][string]$ControllerSha256)
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
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr p,uint code);
 static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static IntPtr Create(){IntPtr j=CreateJobObject(IntPtr.Zero,null);if(j==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());EXT e=new EXT();e.basic.flags=0x2000;Check(SetInformationJobObject(j,9,ref e,Marshal.SizeOf(typeof(EXT))));return j;}
 public static PI Start(IntPtr j,string app,string cmd,string cwd){STARTUPINFO s=new STARTUPINFO();s.cb=Marshal.SizeOf(typeof(STARTUPINFO));PI p;Check(CreateProcess(app,new System.Text.StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref s,out p));try{Check(AssignProcessToJobObject(j,p.process));if(ResumeThread(p.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());return p;}catch{TerminateProcess(p.process,1);TerminateJobObject(j,1);WaitForSingleObject(p.process,10000);CloseHandle(p.thread);CloseHandle(p.process);throw;}}
 public static ACCOUNT Stats(IntPtr j){int len=Marshal.SizeOf(typeof(ACCOUNT)),r;IntPtr b=Marshal.AllocHGlobal(len);try{Check(QueryInformationJobObject(j,1,b,len,out r));return (ACCOUNT)Marshal.PtrToStructure(b,typeof(ACCOUNT));}finally{Marshal.FreeHGlobal(b);}}
 public static long[] Pids(IntPtr j){int len=65536,r;IntPtr b=Marshal.AllocHGlobal(len);try{Check(QueryInformationJobObject(j,3,b,len,out r));int n=Marshal.ReadInt32(b,4);long[] a=new long[n];for(int i=0;i<n;i++)a[i]=Marshal.ReadIntPtr(b,8+i*IntPtr.Size).ToInt64();return a;}finally{Marshal.FreeHGlobal(b);}}
}
'@
$job=[IntPtr]::Zero;$proc=$null;$receipt=[ordered]@{schema=1;status='FAIL';observations=@();error=$null}
try{
 $rootPath=(Resolve-Path -LiteralPath $Root).Path;$scriptPath=(Resolve-Path -LiteralPath $Script).Path;$nodePath=(Resolve-Path -LiteralPath $Node).Path
 if (!(Test-Path -LiteralPath (Join-Path $rootPath 'OWNER.json'))) {throw 'owner missing'}
 if ((Get-FileHash -Algorithm SHA256 -LiteralPath $scriptPath).Hash.ToLowerInvariant() -ne $ControllerSha256) {throw 'controller hash mismatch'}
 if ($rootPath.Contains('"') -or $scriptPath.Contains('"') -or $nodePath.Contains('"')) {throw 'invalid path'}
 $job=[ResearchJob]::Create();$cmd='"'+$nodePath+'" "'+$scriptPath+'" "'+$rootPath+'" controller';$proc=[ResearchJob]::Start($job,$nodePath,$cmd,$rootPath);$receipt.controllerPid=$proc.pid
 $start=(Get-Date).AddSeconds(25);$controllerExited=$false;$seenLiveAfterExit=$false
 while ((Get-Date) -lt $start){$done=[ResearchJob]::WaitForSingleObject($proc.process,0) -eq 0;$stats=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));if($done){$controllerExited=$true;if($stats.active -gt 0){$seenLiveAfterExit=$true}};if($controllerExited -and $stats.active -eq 0 -and $ids.Count -eq 0){break};Start-Sleep -Milliseconds 40}
 $code=0;[void][ResearchJob]::GetExitCodeProcess($proc.process,[ref]$code);$stats=[ResearchJob]::Stats($job);$ids=@([ResearchJob]::Pids($job));$receipt.observations=@{controllerExitCode=$code;seenLiveAfterControllerExit=$seenLiveAfterExit;active=$stats.active;totalProcesses=$stats.total;limitTerminatedProcesses=$stats.terminated;members=$ids;grandchildCompleted=(Test-Path -LiteralPath (Join-Path $rootPath 'grandchild-finished.json'))}
 if (!$controllerExited -or $code -ne 0 -or !$seenLiveAfterExit -or $stats.active -ne 0 -or $ids.Count -ne 0 -or $stats.total -lt 5 -or !$receipt.observations.grandchildCompleted){throw 'job containment proof failed'}
 $receipt.status='PASS_SYNTHETIC_JOB_CONTAINMENT'
}catch{$receipt.error=$_.Exception.ToString();if($job -ne [IntPtr]::Zero){[void][ResearchJob]::TerminateJobObject($job,91);$receipt.terminatedOwnedJob=$true}}
finally{if($proc){[void][ResearchJob]::CloseHandle($proc.thread);[void][ResearchJob]::CloseHandle($proc.process)};if($job -ne [IntPtr]::Zero){[void][ResearchJob]::CloseHandle($job)};$receipt|ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Root 'job-receipt.json')}
if($receipt.status -ne 'PASS_SYNTHETIC_JOB_CONTAINMENT'){exit 1}
