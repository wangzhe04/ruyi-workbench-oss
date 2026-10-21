// Original, isolated M1 experiment. Job Object manages lifetime, not isolation.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

public class AppContainerHost {
  [StructLayout(LayoutKind.Sequential)] struct SC { public IntPtr sid, capabilities; public int count, reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show, reserved2; public IntPtr data,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct JobLimit { public BasicLimit basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,int count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref JobLimit info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,int size,IntPtr returned);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value,uint rev,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,out int value,int size,out int needed);
  static JavaScriptSerializer json=new JavaScriptSerializer();
  static void Event(object value) { Console.Error.WriteLine(json.Serialize(value)); }
  static void Check(bool result,string stage) { if(!result) throw new Exception(stage+":"+Marshal.GetLastWin32Error()); }
  static void Low(string directory) {
    IntPtr sd=IntPtr.Zero,sacl; uint size; bool present,defaulted;
    try { Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"low-descriptor"); Check(GetSecurityDescriptorSacl(sd,out present,out sacl,out defaulted),"low-sacl"); uint status=SetNamedSecurityInfo(directory,1,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl); if(status!=0) throw new Exception("low-label:"+status); }
    finally { if(sd!=IntPtr.Zero) LocalFree(sd); }
  }
  static void Grant(string directory,SecurityIdentifier sid,FileSystemRights rights) { var acl=Directory.GetAccessControl(directory); acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); Directory.SetAccessControl(directory,acl); }
  static void ValidateOwnedPaths(string config,string projection,string write,string exe,string aap) {
    string root=Path.GetDirectoryName(Path.GetFullPath(config));
    if(!root.StartsWith(Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("ruyi-m1-cli-",StringComparison.Ordinal)) throw new Exception("not-owned-temporary-root");
    foreach(string value in new string[]{projection,write,exe,aap}) {
      if(!Path.GetFullPath(value).StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new Exception("path-outside-owned-root");
      for(string current=Path.GetFullPath(value);current!=root;current=Path.GetDirectoryName(current)) if((Directory.Exists(current)||File.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0) throw new Exception("reparse-point-not-permitted");
    }
    if(!Path.GetFullPath(write).StartsWith(Path.GetFullPath(projection)+"\\",StringComparison.OrdinalIgnoreCase)||!Path.GetFullPath(exe).StartsWith(Path.GetFullPath(projection)+"\\",StringComparison.OrdinalIgnoreCase)) throw new Exception("executable-or-write-outside-projection");
  }
  // Implements CommandLineToArgvW quoting, including empty args and trailing slashes.
  public static string Quote(string arg) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='\"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes); b.Append(c); slashes=0; } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
  public static int Main(string[] args) {
    if(args.Length==2 && args[0]=="--cleanup-profile") {
      if(!System.Text.RegularExpressions.Regex.IsMatch(args[1],@"^ruyi\.m1\.[a-f0-9]{32}$")) return 64;
      IntPtr recoveredSid=IntPtr.Zero,recoveredPath; string folder=null;
      if(DeriveAppContainerSidFromAppContainerName(args[1],out recoveredSid)==0) { if(GetAppContainerFolderPath(new SecurityIdentifier(recoveredSid).Value,out recoveredPath)==0) { folder=Marshal.PtrToStringUni(recoveredPath); Marshal.FreeCoTaskMem(recoveredPath); } FreeSid(recoveredSid); }
      int status=DeleteAppContainerProfile(args[1]); bool absent=folder!=null&&!Directory.Exists(folder);
      Event(new {stage="recovery-cleanup",profileDeleteHresult=status,profileDirectoryAbsent=absent}); return status==0&&absent?0:1;
    }
    if(args.Length==1 && args[0]=="--token-self") {
      IntPtr token; Check(OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,8,out token),"open-self-token");
      try { int value,needed; Check(GetTokenInformation(token,29,out value,4,out needed),"query-self-token"); Console.WriteLine(json.Serialize(new {kind="descendant-token",isAppContainer=value==1})); return value==1?0:1; } finally {CloseHandle(token);}
    }
    if(args.Length!=1) return 64;
    string profile="ruyi.m1."+Guid.NewGuid().ToString("N");
    IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,scmem=IntPtr.Zero,handles=IntPtr.Zero,envmem=IntPtr.Zero,job=IntPtr.Zero; PI pi=new PI(); bool assigned=false; string profilePath=null;
    int result=1;
    try {
      var c=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[0]));
      profile=(string)c["profile"];
      if(!System.Text.RegularExpressions.Regex.IsMatch(profile,@"^ruyi\.m1\.[a-f0-9]{32}$")) throw new Exception("invalid-owned-profile-name");
      string projection=(string)c["projection"],write=(string)c["write"],exe=(string)c["exe"];
      ValidateOwnedPaths(args[0],projection,write,exe,(string)c["aapDirectory"]);
      // Synthetic negative control: ordinary AppContainer can also read AAP-granted files.
      Grant((string)c["aapDirectory"],new SecurityIdentifier("S-1-15-2-1"),FileSystemRights.ReadAndExecute);
      int hr=CreateAppContainerProfile(profile,profile,"Temporary isolated synthetic M1 probe",IntPtr.Zero,0,out sid); if(hr!=0) throw new Exception("create-profile:0x"+hr.ToString("X8"));
      var identity=new SecurityIdentifier(sid); IntPtr pp; if(GetAppContainerFolderPath(identity.Value,out pp)==0) { profilePath=Marshal.PtrToStringUni(pp); Marshal.FreeCoTaskMem(pp); }
      Grant(projection,identity,FileSystemRights.ReadAndExecute); Grant(write,identity,FileSystemRights.FullControl); Low(write);
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,2,0,ref size),"initialize-attributes");
      SC sc=new SC(); sc.sid=sid; scmem=Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc,scmem,false);
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20009,scmem,(IntPtr)Marshal.SizeOf(sc),IntPtr.Zero,IntPtr.Zero),"security-capabilities");
      SIX si=new SIX(); si.si.cb=Marshal.SizeOf(si); si.si.flags=0x101; si.si.show=0; si.si.input=GetStdHandle(-10); si.si.output=GetStdHandle(-11); si.si.error=GetStdHandle(-12); si.attrs=list;
      IntPtr[] allowed={si.si.input,si.si.output,si.si.error}; handles=Marshal.AllocHGlobal(IntPtr.Size*3); for(int i=0;i<3;i++){ Check(SetHandleInformation(allowed[i],1,1),"inherit-stdio"); Marshal.WriteIntPtr(handles,i*IntPtr.Size,allowed[i]); }
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"handle-list");
      var env=(Dictionary<string,object>)c["env"]; var keys=new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); var block=new StringBuilder(); foreach(string key in keys) block.Append(key).Append('=').Append((string)env[key]).Append('\0'); block.Append('\0'); envmem=Marshal.StringToHGlobalUni(block.ToString());
      var command=new StringBuilder(Quote(exe)); foreach(object a in (System.Collections.IEnumerable)c["args"]) command.Append(' ').Append(Quote((string)a));
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("create-job:"+Marshal.GetLastWin32Error()); var limits=new JobLimit(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"job-limits");
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,envmem,(string)c["cwd"],ref si,out pi),"create-process");
      Check(AssignProcessToJobObject(job,pi.process),"assign-job"); assigned=true;
      IntPtr token; Check(OpenProcessToken(pi.process,8,out token),"open-child-token");
      try { int isAppContainer,needed; Check(GetTokenInformation(token,29,out isAppContainer,4,out needed),"query-appcontainer-token"); if(isAppContainer!=1) throw new Exception("child-token-not-appcontainer"); Event(new {stage="token-verified",isAppContainer=true}); } finally {CloseHandle(token);}
      if(ResumeThread(pi.thread)==0xffffffff) throw new Exception("resume:"+Marshal.GetLastWin32Error());
      Event(new {stage="launched",isolation="AppContainer",capabilities=0});
      uint wait=WaitForSingleObject(pi.process,Convert.ToUInt32(c["timeoutMs"]));
      if(wait==258) { bool terminated=TerminateJobObject(job,124); uint stopped=WaitForSingleObject(pi.process,5000); Event(new {stage="timeout",terminateJobSucceeded=terminated,rootWaitResult=stopped}); result=124; }
      else if(wait!=0) throw new Exception("wait:"+wait);
      else { uint code; Check(GetExitCodeProcess(pi.process,out code),"exit-code"); result=unchecked((int)code); Event(new {stage="exit",code=code}); }
    } catch(Exception e) { Event(new {stage="error",error=e.Message}); }
    finally {
      bool? terminateSucceeded=null; uint? rootWait=null,activeProcesses=null,totalProcesses=null;
      if(pi.process!=IntPtr.Zero) {
        terminateSucceeded=assigned ? TerminateJobObject(job,125) : TerminateProcess(pi.process,125); rootWait=WaitForSingleObject(pi.process,5000);
        if(assigned) { Accounting accounting; for(int retry=0;retry<100;retry++) { if(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) {activeProcesses=accounting.active;totalProcesses=accounting.total;} else break; if(activeProcesses==0) break; System.Threading.Thread.Sleep(50); } }
      }
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process); if(job!=IntPtr.Zero) CloseHandle(job);
      if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); } if(scmem!=IntPtr.Zero) Marshal.FreeHGlobal(scmem); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(envmem!=IntPtr.Zero) Marshal.FreeHGlobal(envmem);
      int deleted=sid==IntPtr.Zero ? 0 : DeleteAppContainerProfile(profile); if(sid!=IntPtr.Zero) FreeSid(sid);
      bool? profileAbsent=profilePath==null ? (bool?)null : !Directory.Exists(profilePath);
      bool treeStopped=pi.process!=IntPtr.Zero && terminateSucceeded==true && rootWait==0 && (!assigned || activeProcesses==0);
      Event(new {stage="cleanup",profileDeleteHresult=deleted,profileDirectoryAbsent=profileAbsent,terminateSucceeded=terminateSucceeded,rootWaitResult=rootWait,jobActiveProcesses=activeProcesses,jobTotalProcesses=totalProcesses,ownedTreeTerminated=treeStopped});
      if(deleted!=0 || profileAbsent!=true || (pi.process!=IntPtr.Zero && !treeStopped)) result=1;
    }
    return result;
  }
}
