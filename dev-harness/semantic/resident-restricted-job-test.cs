using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

// Test-only external restriction. This never opens a product Job HANDLE and
// deliberately has NO KILL_ON_JOB_CLOSE/Terminate API. The external research
// keeper remains containment. It must not turn test reclamation into a PASS.
public static class ResidentRestrictedJobTest {
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint lo,hi;public string Text {get{return (((ulong)hi<<32)|lo).ToString();}}}
 [StructLayout(LayoutKind.Sequential)] struct BASIC {public long a,b;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct EXT {public BASIC basic;public IO io;public UIntPtr proc,job,peakProc,peakJob;}
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {public long a,b,c,d;public uint faults,total,active,terminated;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FT a,out FT b,out FT c,out FT d);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder image,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint ms);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT value,int bytes);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT value,uint bytes,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 static IntPtr Job=IntPtr.Zero,Actor=IntPtr.Zero,Helper=IntPtr.Zero;static bool Entered,Finished;
 public sealed class Identity {public int requestedPid;public uint actualPid;public string creationFileTime,image;public bool matched,alive;}
 public sealed class Result {public bool ok,actorAssigned,helperAssigned,handlesClosed;public string phase,error;public int win32;public uint? active,total,limitTerminated;public Identity actor,helper;public string authority="external test-only ActiveProcessLimit=2; no product Job HANDLE, no kill flag or termination call";}
 static void Need(bool value,string code){if(!value)throw new IOException(code+":"+Marshal.GetLastWin32Error());}
 static IntPtr Open(int pid,string expectedBirth,string expectedImage,out Identity identity){identity=new Identity{requestedPid=pid};ulong birth;Need(pid>0&&pid!=GetCurrentProcessId()&&UInt64.TryParse(expectedBirth,out birth)&&birth>0&&!String.IsNullOrEmpty(expectedImage)&&Path.IsPathRooted(expectedImage),"RESTRICTION_IDENTITY_ARGUMENT");IntPtr handle=OpenProcess(0x00100000|0x1000|0x100|1,false,pid);Need(handle!=IntPtr.Zero,"RESTRICTION_OPEN");try{identity.actualPid=GetProcessId(handle);FT a,b,c,d;Need(GetProcessTimes(handle,out a,out b,out c,out d),"RESTRICTION_CREATION");identity.creationFileTime=a.Text;var text=new StringBuilder(32768);uint length=(uint)text.Capacity;Need(QueryFullProcessImageNameW(handle,0,text,ref length),"RESTRICTION_IMAGE");identity.image=text.ToString();identity.matched=identity.actualPid==(uint)pid&&identity.creationFileTime==expectedBirth&&String.Equals(Path.GetFullPath(identity.image),Path.GetFullPath(expectedImage),StringComparison.OrdinalIgnoreCase);Need(identity.matched,"RESTRICTION_IDENTITY_MISMATCH");identity.alive=WaitForSingleObject(handle,0)==258;Need(identity.alive,"RESTRICTION_ALREADY_EXITED");return handle;}catch{CloseHandle(handle);throw;}}
 static void Account(Result r){ACCOUNT value=new ACCOUNT();Need(Job!=IntPtr.Zero&&QueryInformationJobObject(Job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"RESTRICTION_QUERY");r.active=value.active;r.total=value.total;r.limitTerminated=value.terminated;}
 static bool Release(){bool good=true;foreach(var value in new[]{Actor,Helper,Job})if(value!=IntPtr.Zero&&!CloseHandle(value))good=false;Actor=Helper=Job=IntPtr.Zero;return good;}
 public static Result Begin(int actorPid,string actorBirth,string actorImage,int helperPid,string helperBirth,string helperImage){var r=new Result{phase="begin"};try{Need(!Entered&&!Finished&&Job==IntPtr.Zero&&actorPid!=helperPid,"RESTRICTION_SINGLE_USE");Entered=true;Actor=Open(actorPid,actorBirth,actorImage,out r.actor);Helper=Open(helperPid,helperBirth,helperImage,out r.helper);Job=CreateJobObjectW(IntPtr.Zero,null);Need(Job!=IntPtr.Zero,"RESTRICTION_CREATE");var limits=new EXT();limits.basic.flags=0x8;limits.basic.active=2;Need(SetInformationJobObject(Job,9,ref limits,Marshal.SizeOf(typeof(EXT))),"RESTRICTION_LIMIT");Need(AssignProcessToJobObject(Job,Actor),"RESTRICTION_ASSIGN_ACTOR");r.actorAssigned=true;Need(AssignProcessToJobObject(Job,Helper),"RESTRICTION_ASSIGN_HELPER");r.helperAssigned=true;Account(r);Need(r.active==2,"RESTRICTION_ACTIVE_TWO");r.ok=true;}catch(Exception e){r.error=e.Message;r.win32=Marshal.GetLastWin32Error();r.handlesClosed=Release();r.ok=false;Finished=true;}return r;}
 public static Result Finish(){var r=new Result{phase="finish"};try{Need(Entered&&!Finished&&Job!=IntPtr.Zero,"RESTRICTION_FINISH_STATE");Account(r);Need(r.active==0&&WaitForSingleObject(Actor,0)==0&&WaitForSingleObject(Helper,0)==0,"RESTRICTION_STILL_ACTIVE");r.ok=true;}catch(Exception e){r.error=e.Message;r.win32=Marshal.GetLastWin32Error();r.ok=false;}finally{Finished=true;r.handlesClosed=Release();if(!r.handlesClosed){r.ok=false;r.error="RESTRICTION_CLOSE_FAILED";}}return r;}
}
