// Original, isolated M1 experiment. Job Object manages lifetime, not isolation.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

public class AppContainerHost {
  [StructLayout(LayoutKind.Sequential)] struct SC { public IntPtr sid, capabilities; public int count, reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TokenGroupsOne { public uint count; public SidAndAttributes first; }
  [StructLayout(LayoutKind.Sequential)] struct FileIdentity { public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
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
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,IntPtr disable,uint deleteCount,IntPtr delete,uint restrictCount,ref SidAndAttributes restrict,out IntPtr restricted);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileIdentity identity);
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
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,out int value,int size,out int needed);
  [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] static extern bool GetTokenBuffer(IntPtr token,int type,IntPtr value,int size,out int needed);
  [DllImport("api-ms-win-security-base-l1-2-2.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr capabilities,out uint count);
  static int TokenInteger(IntPtr token,int type) { int value,needed; Check(GetTokenInformation(token,type,out value,4,out needed),"query-token-"+type); return value; }
  static object TokenSnapshot(IntPtr process,string expectedSid,bool? expectedLpac,string stage,string[] expectedCapabilities,string expectedRestriction=null) {
    IntPtr token; Check(OpenProcessToken(process,8,out token),"open-token");
    try {
      bool app=TokenInteger(token,29)==1; int needed,lpacValue;
      bool lpacQuery=GetTokenInformation(token,46,out lpacValue,4,out needed); int lpacError=lpacQuery?0:Marshal.GetLastWin32Error(); bool? lpac=lpacQuery?(bool?)(lpacValue!=0):null;
      GetTokenBuffer(token,31,IntPtr.Zero,0,out needed); IntPtr buffer=Marshal.AllocHGlobal(needed); string actualSid;
      try { Check(GetTokenBuffer(token,31,buffer,needed,out needed),"query-package-sid"); actualSid=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; } finally { Marshal.FreeHGlobal(buffer); }
      GetTokenBuffer(token,30,IntPtr.Zero,0,out needed); buffer=Marshal.AllocHGlobal(needed); int capabilities; var capabilitySids=new List<string>();
      try { Check(GetTokenBuffer(token,30,buffer,needed,out needed),"query-capabilities"); capabilities=Marshal.ReadInt32(buffer); int offset=(int)Marshal.OffsetOf(typeof(TokenGroupsOne),"first"),stride=Marshal.SizeOf(typeof(SidAndAttributes)); for(int i=0;i<capabilities;i++)capabilitySids.Add(new SecurityIdentifier(Marshal.ReadIntPtr(buffer,offset+i*stride)).Value); } finally { Marshal.FreeHGlobal(buffer); }
      GetTokenBuffer(token,11,IntPtr.Zero,0,out needed);buffer=Marshal.AllocHGlobal(needed);var restrictedSids=new List<string>();
      try {Check(GetTokenBuffer(token,11,buffer,needed,out needed),"query-restricted-sids");int count=Marshal.ReadInt32(buffer),offset=(int)Marshal.OffsetOf(typeof(TokenGroupsOne),"first"),stride=Marshal.SizeOf(typeof(SidAndAttributes));for(int i=0;i<count;i++)restrictedSids.Add(new SecurityIdentifier(Marshal.ReadIntPtr(buffer,offset+i*stride)).Value);}finally{Marshal.FreeHGlobal(buffer);}
      bool restrictionMatched=expectedRestriction==null||restrictedSids.Count==1&&restrictedSids[0]==expectedRestriction;
      bool capsMatch=expectedCapabilities==null || String.Join(",",capabilitySids.ToArray())==String.Join(",",expectedCapabilities);
      if(!app || expectedSid!=null&&actualSid!=expectedSid || expectedLpac.HasValue&&lpac.HasValue&&lpac!=expectedLpac.Value || !capsMatch || !restrictionMatched) throw new Exception("unexpected-token-boundary");
      return new {stage=stage,kind="descendant-token",isAppContainer=app,isLessPrivilegedAppContainer=lpac,lpacQuerySucceeded=lpacQuery,lpacQueryError=lpacError,packageSid=actualSid,capabilityCount=capabilities,capabilitySids=capabilitySids.ToArray(),profileSidMatched=expectedSid==null?(bool?)null:actualSid==expectedSid,restrictedSidCount=restrictedSids.Count,restrictedSids=restrictedSids.ToArray(),expectedRestrictionMatched=expectedRestriction==null?(bool?)null:restrictionMatched};
    } finally {CloseHandle(token);}
  }
  static JavaScriptSerializer json=new JavaScriptSerializer();
  static readonly object jsonLock=new object();
  static void Event(object value) { lock(jsonLock)Console.Error.WriteLine(json.Serialize(value)); }
  static string BoundedLine(TextReader reader) { var line=new StringBuilder();for(int next;(next=reader.Read())!=-1;){if(next=='\n')return line.ToString();if(line.Length>=400000)throw new Exception("pipe-frame-limit");if(next!='\r')line.Append((char)next);}if(line.Length==0)return null;throw new Exception("pipe-truncated-frame"); }
  static void Relay(NamedPipeServerStream pipe) {
    try {
      pipe.WaitForConnection();var reader=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true);var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true);writer.AutoFlush=true;
      string line;while((line=BoundedLine(reader))!=null) {
        Dictionary<string,object> request;lock(jsonLock)request=json.Deserialize<Dictionary<string,object>>(line);Event(new {stage="broker-request",request=request});
        string reply=BoundedLine(Console.In);if(reply==null)throw new Exception("broker-host-closed");
        writer.WriteLine(reply);
      }
    } catch(Exception error) {Event(new {stage="pipe-relay-stopped",error=error.GetType().Name});}
  }
  static void Check(bool result,string stage) { if(!result) throw new Exception(stage+":"+Marshal.GetLastWin32Error()); }
  static void Low(string directory) {
    IntPtr sd=IntPtr.Zero,sacl; uint size; bool present,defaulted;
    try { Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"low-descriptor"); Check(GetSecurityDescriptorSacl(sd,out present,out sacl,out defaulted),"low-sacl"); uint status=SetNamedSecurityInfo(directory,1,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl); if(status!=0) throw new Exception("low-label:"+status); }
    finally { if(sd!=IntPtr.Zero) LocalFree(sd); }
  }
  static void LowPipe(NamedPipeServerStream pipe) {
    IntPtr sd=IntPtr.Zero,sacl;uint size;bool present,defaulted;
    try {Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;LW)",1,out sd,out size),"pipe-low-descriptor");Check(GetSecurityDescriptorSacl(sd,out present,out sacl,out defaulted),"pipe-low-sacl");uint status=SetSecurityInfo(pipe.SafePipeHandle.DangerousGetHandle(),6,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);if(status!=0)throw new Exception("pipe-low-label:"+status);}
    finally {if(sd!=IntPtr.Zero)LocalFree(sd);}
  }
  static void Grant(string directory,SecurityIdentifier sid,FileSystemRights rights) { var acl=Directory.GetAccessControl(directory); acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); Directory.SetAccessControl(directory,acl); }
  static List<Dictionary<string,object>> FilesystemFixtures(Dictionary<string,object> config,string configPath) {
    var result=new List<Dictionary<string,object>>();
    if(!config.ContainsKey("filesystemFixtures"))return result;
    string root=Path.GetDirectoryName(Path.GetFullPath(configPath)),temporary=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\";
    if(!root.StartsWith(temporary,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("ruyi-m1-cli-",StringComparison.Ordinal))throw new Exception("filesystem-root-not-owned");
    var entries=config["filesystemFixtures"] as System.Collections.IEnumerable;
    if(entries==null||config["filesystemFixtures"] is string)throw new Exception("filesystem-fixtures-array-required");
    foreach(object entry in entries) {
      if(result.Count>=16)throw new Exception("filesystem-fixtures-limit");
      var fixture=entry as Dictionary<string,object>;
      if(fixture==null||fixture.Count!=3||!fixture.ContainsKey("directory")||!fixture.ContainsKey("principal")||!fixture.ContainsKey("rights"))throw new Exception("filesystem-fixture-fields");
      string directory=fixture["directory"] as string,principal=fixture["principal"] as string,rights=fixture["rights"] as string;
      if(directory==null||!Path.IsPathRooted(directory)||!Path.GetFullPath(directory).StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)||!Directory.Exists(directory))throw new Exception("filesystem-fixture-not-owned-directory");
      if(principal!="arap"&&principal!="everyone"&&principal!="user"&&principal!="profile")throw new Exception("filesystem-fixture-principal");
      if(rights!="read"&&rights!="write")throw new Exception("filesystem-fixture-rights");
      // Validate the root as well as each ancestor; lexical prefix alone accepts junction escapes.
      for(string current=Path.GetFullPath(directory);;current=Path.GetDirectoryName(current)) {
        if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new Exception("filesystem-fixture-reparse");
        if(String.Equals(current,root,StringComparison.OrdinalIgnoreCase))break;
      }
      var pending=new Stack<string>();pending.Push(directory);
      while(pending.Count>0)foreach(string child in Directory.EnumerateFileSystemEntries(pending.Pop())) {
        FileAttributes attributes=File.GetAttributes(child);
        if((attributes&FileAttributes.ReparsePoint)!=0)throw new Exception("filesystem-fixture-reparse");
        if((attributes&FileAttributes.Directory)!=0)pending.Push(child);
        else using(var file=File.Open(child,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
          FileIdentity information;Check(GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),out information),"filesystem-fixture-file-identity");
          if(information.links!=1)throw new Exception("filesystem-fixture-hardlink");
        }
      }
      result.Add(fixture);
    }
    return result;
  }
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
    Console.OutputEncoding=new UTF8Encoding(false);Console.InputEncoding=new UTF8Encoding(false);
    if(args.Length==2&&args[0]=="--validate-filesystem-fixtures") {
      try {FilesystemFixtures(json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[1])),args[1]);Console.WriteLine("filesystem-fixtures-valid");return 0;}
      catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
    }
    if(args.Length==2 && args[0]=="--cleanup-profile") {
      if(!System.Text.RegularExpressions.Regex.IsMatch(args[1],@"^ruyi\.m1\.[a-f0-9]{32}$")) return 64;
      IntPtr recoveredSid=IntPtr.Zero,recoveredPath; string folder=null;
      if(DeriveAppContainerSidFromAppContainerName(args[1],out recoveredSid)==0) { if(GetAppContainerFolderPath(new SecurityIdentifier(recoveredSid).Value,out recoveredPath)==0) { folder=Marshal.PtrToStringUni(recoveredPath); Marshal.FreeCoTaskMem(recoveredPath); } FreeSid(recoveredSid); }
      int status=DeleteAppContainerProfile(args[1]); bool absent=folder!=null&&!Directory.Exists(folder);
      Event(new {stage="recovery-cleanup",profileDeleteHresult=status,profileDirectoryAbsent=absent}); return status==0&&absent?0:1;
    }
    if(args.Length==1 && args[0]=="--token-self") {
      Console.WriteLine(json.Serialize(TokenSnapshot(System.Diagnostics.Process.GetCurrentProcess().Handle,null,null,"descendant-token",null))); return 0;
    }
    if(args.Length!=1) return 64;
    string profile="ruyi.m1."+Guid.NewGuid().ToString("N");
    IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,scmem=IntPtr.Zero,handles=IntPtr.Zero,envmem=IntPtr.Zero,job=IntPtr.Zero,lpacPolicy=IntPtr.Zero,capmem=IntPtr.Zero,capSid=IntPtr.Zero,nullInput=IntPtr.Zero,restrictedToken=IntPtr.Zero,restrictionSidMemory=IntPtr.Zero; PI pi=new PI(); bool assigned=false; string profilePath=null,expectedRestriction=null;NamedPipeServerStream brokerPipe=null;
    int result=1;
    try {
      var c=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[0]));
      string isolation=c.ContainsKey("isolation")?(string)c["isolation"]:"AppContainer";
      if(isolation!="AppContainer"&&isolation!="LPAC") throw new Exception("invalid-isolation"); bool lpac=isolation=="LPAC";
      bool registryRead=c.ContainsKey("registryRead")&&(bool)c["registryRead"]; if(registryRead&&!lpac)throw new Exception("registry-read-requires-lpac"); string[] expectedCapabilities=new string[0];
      bool filesystemRestrictedToken=c.ContainsKey("filesystemRestrictedToken")&&(bool)c["filesystemRestrictedToken"];if(filesystemRestrictedToken&&!lpac)throw new Exception("filesystem-restriction-requires-lpac");
      if(registryRead) {
        IntPtr groups=IntPtr.Zero,caps=IntPtr.Zero;uint groupCount=0,count=0;
        try { Check(DeriveCapabilitySidsFromName("registryRead",out groups,out groupCount,out caps,out count),"derive-registry-read"); if(count!=1)throw new Exception("unexpected-derived-capability-count"); capSid=Marshal.ReadIntPtr(caps); expectedCapabilities=new string[]{new SecurityIdentifier(capSid).Value}; capmem=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes))); var entry=new SidAndAttributes();entry.sid=capSid;entry.attributes=4;Marshal.StructureToPtr(entry,capmem,false); }
        finally {if(groups!=IntPtr.Zero){for(int i=0;i<groupCount;i++)LocalFree(Marshal.ReadIntPtr(groups,i*IntPtr.Size));LocalFree(groups);}if(caps!=IntPtr.Zero)LocalFree(caps);}
      }
      profile=(string)c["profile"];
      if(!System.Text.RegularExpressions.Regex.IsMatch(profile,@"^ruyi\.m1\.[a-f0-9]{32}$")) throw new Exception("invalid-owned-profile-name");
      string projection=(string)c["projection"],write=(string)c["write"],exe=(string)c["exe"];
      ValidateOwnedPaths(args[0],projection,write,exe,(string)c["aapDirectory"]);
      // Complete validation before profile creation or any ACL mutation.
      var filesystemFixtures=FilesystemFixtures(c,args[0]);
      bool filesystemStorage=c.ContainsKey("filesystemStorage")&&(bool)c["filesystemStorage"];
      // Synthetic negative control: ordinary AppContainer can also read AAP-granted files.
      Grant((string)c["aapDirectory"],new SecurityIdentifier("S-1-15-2-1"),FileSystemRights.ReadAndExecute);
      int hr=CreateAppContainerProfile(profile,profile,"Temporary isolated synthetic M1 probe",IntPtr.Zero,0,out sid); if(hr!=0) throw new Exception("create-profile:0x"+hr.ToString("X8"));
      var identity=new SecurityIdentifier(sid); IntPtr pp; if(GetAppContainerFolderPath(identity.Value,out pp)==0) { profilePath=Marshal.PtrToStringUni(pp); Marshal.FreeCoTaskMem(pp); }
      foreach(var fixture in filesystemFixtures) {
        string principal=(string)fixture["principal"];
        var fixtureSid=principal=="profile"?identity:principal=="user"?WindowsIdentity.GetCurrent().User:new SecurityIdentifier(principal=="arap"?"S-1-15-2-2":"S-1-1-0");
        Grant((string)fixture["directory"],fixtureSid,(string)fixture["rights"]=="read"?FileSystemRights.ReadAndExecute:FileSystemRights.Modify);
        if((string)fixture["rights"]=="write")Low((string)fixture["directory"]);
      }
      string filesystemStoragePath=null;
      if(filesystemStorage) {
        if(profilePath==null)throw new Exception("filesystem-profile-path-unavailable");
        filesystemStoragePath=Path.Combine(profilePath,"filesystem-probe");Directory.CreateDirectory(filesystemStoragePath);Low(filesystemStoragePath);
        File.WriteAllText(Path.Combine(filesystemStoragePath,"marker.txt"),"SYNTHETIC_PROFILE_STORAGE");
      }
      bool pipeBroker=c.ContainsKey("pipeBroker")&&(bool)c["pipeBroker"];string pipeName=null;
      if(pipeBroker) {
        if(!lpac)throw new Exception("pipe-broker-requires-lpac");pipeName="LOCAL\\ruyi.m1."+Guid.NewGuid().ToString("N");
        var security=new PipeSecurity();security.SetSecurityDescriptorSddlForm("D:P(D;;GA;;;NU)(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")(A;;GRGW;;;"+identity.Value+")");
        string serverPipeName="Sessions\\"+System.Diagnostics.Process.GetCurrentProcess().SessionId+"\\AppContainerNamedObjects\\"+identity.Value+"\\"+pipeName.Substring(6);
        brokerPipe=new NamedPipeServerStream(serverPipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security,HandleInheritability.None,PipeAccessRights.TakeOwnership);LowPipe(brokerPipe);
        var relay=new System.Threading.Thread(()=>Relay(brokerPipe));relay.IsBackground=true;relay.Start();Event(new {stage="pipe-created",profileSidAuthorized=true,hostUserAuthorized=true,networkDenied=true,lowIntegrity=true});
        nullInput=CreateFile("NUL",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);if(nullInput==(IntPtr)(-1))throw new Exception("open-null-stdin:"+Marshal.GetLastWin32Error());
      }
      Grant(projection,identity,FileSystemRights.ReadAndExecute); Grant(write,identity,FileSystemRights.FullControl); Low(write);
      if(filesystemRestrictedToken) {
        byte[] random=Guid.NewGuid().ToByteArray();expectedRestriction="S-1-5-21-"+BitConverter.ToUInt32(random,0)+"-"+BitConverter.ToUInt32(random,4)+"-"+BitConverter.ToUInt32(random,8)+"-"+BitConverter.ToUInt32(random,12);
        var restriction=new SecurityIdentifier(expectedRestriction);byte[] bytes=new byte[restriction.BinaryLength];restriction.GetBinaryForm(bytes,0);restrictionSidMemory=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,restrictionSidMemory,bytes.Length);
        var entry=new SidAndAttributes();entry.sid=restrictionSidMemory;entry.attributes=0;IntPtr ownToken;Check(OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,11,out ownToken),"open-own-primary-token");
        try {Check(CreateRestrictedToken(ownToken,1,0,IntPtr.Zero,0,IntPtr.Zero,1,ref entry,out restrictedToken),"create-restricted-primary-token");}finally{CloseHandle(ownToken);}
        Grant(projection,restriction,FileSystemRights.ReadAndExecute);Grant(write,restriction,FileSystemRights.Modify);
      }
      int attributeCount=lpac?3:2; IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,attributeCount,0,ref size); list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,attributeCount,0,ref size),"initialize-attributes");
      SC sc=new SC(); sc.sid=sid;sc.capabilities=capmem;sc.count=registryRead?1:0; scmem=Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc,scmem,false);
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20009,scmem,(IntPtr)Marshal.SizeOf(sc),IntPtr.Zero,IntPtr.Zero),"security-capabilities");
      // PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY; opt out of AAP.
      if(lpac) { lpacPolicy=Marshal.AllocHGlobal(4); Marshal.WriteInt32(lpacPolicy,1); Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x2000f,lpacPolicy,(IntPtr)4,IntPtr.Zero,IntPtr.Zero),"all-application-packages-opt-out"); }
      SIX si=new SIX(); si.si.cb=Marshal.SizeOf(si); si.si.flags=0x101; si.si.show=0; si.si.input=GetStdHandle(-10); si.si.output=GetStdHandle(-11); si.si.error=GetStdHandle(-12); si.attrs=list;
      // Broker control stderr must never be inherited by the CLI. Raw CLI diagnostics
      // share its stdout; host stdin exclusively carries broker replies to this helper.
      if(pipeBroker){si.si.input=nullInput;si.si.error=si.si.output;}
      var allowed=new List<IntPtr>();foreach(IntPtr handle in new IntPtr[]{si.si.input,si.si.output,si.si.error})if(!allowed.Contains(handle))allowed.Add(handle);
      handles=Marshal.AllocHGlobal(IntPtr.Size*allowed.Count); for(int i=0;i<allowed.Count;i++){ Check(SetHandleInformation(allowed[i],1,1),"inherit-stdio"); Marshal.WriteIntPtr(handles,i*IntPtr.Size,allowed[i]); }
      Check(UpdateProcThreadAttribute(list,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*allowed.Count),IntPtr.Zero,IntPtr.Zero),"handle-list");
      var env=(Dictionary<string,object>)c["env"];if(pipeBroker)env["RUYI_M1_PIPE"]="\\\\.\\pipe\\"+pipeName;
      if(filesystemStorage){env["RUYI_M1_PROFILE_STORAGE"]=filesystemStoragePath;env["RUYI_M1_PROFILE_SID"]=identity.Value;}
      var keys=new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); var block=new StringBuilder(); foreach(string key in keys) block.Append(key).Append('=').Append((string)env[key]).Append('\0'); block.Append('\0'); envmem=Marshal.StringToHGlobalUni(block.ToString());
      var command=new StringBuilder(Quote(exe)); foreach(object a in (System.Collections.IEnumerable)c["args"]) command.Append(' ').Append(Quote((string)a));
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("create-job:"+Marshal.GetLastWin32Error()); var limits=new JobLimit(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)),"job-limits");
      if(filesystemRestrictedToken)Check(CreateProcessAsUser(restrictedToken,exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,envmem,(string)c["cwd"],ref si,out pi),"create-process-as-user");
      else Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,envmem,(string)c["cwd"],ref si,out pi),"create-process");
      Check(AssignProcessToJobObject(job,pi.process),"assign-job"); assigned=true;
      Event(TokenSnapshot(pi.process,identity.Value,lpac,"token-verified",expectedCapabilities,expectedRestriction));
      if(ResumeThread(pi.thread)==0xffffffff) throw new Exception("resume:"+Marshal.GetLastWin32Error());
      Event(new {stage="launched",isolation=isolation,capabilities=sc.count,capabilityNames=registryRead?new string[]{"registryRead"}:new string[0]});
      uint wait=WaitForSingleObject(pi.process,Convert.ToUInt32(c["timeoutMs"]));
      if(wait==258) { bool terminated=TerminateJobObject(job,124); uint stopped=WaitForSingleObject(pi.process,5000); Event(new {stage="timeout",terminateJobSucceeded=terminated,rootWaitResult=stopped}); result=124; }
      else if(wait!=0) throw new Exception("wait:"+wait);
      else { uint code; Check(GetExitCodeProcess(pi.process,out code),"exit-code"); result=unchecked((int)code); Event(new {stage="exit",code=code}); }
    } catch(Exception e) { Event(new {stage="error",error=e.Message,errorType=e.GetType().Name,errorHresult=e.HResult}); }
    finally {
      bool? terminateSucceeded=null; uint? rootWait=null,activeProcesses=null,totalProcesses=null;
      if(pi.process!=IntPtr.Zero) {
        terminateSucceeded=assigned ? TerminateJobObject(job,125) : TerminateProcess(pi.process,125); rootWait=WaitForSingleObject(pi.process,5000);
        if(assigned) { Accounting accounting; for(int retry=0;retry<100;retry++) { if(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) {activeProcesses=accounting.active;totalProcesses=accounting.total;} else break; if(activeProcesses==0) break; System.Threading.Thread.Sleep(50); } }
      }
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process); if(job!=IntPtr.Zero) CloseHandle(job);
      if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); } if(scmem!=IntPtr.Zero) Marshal.FreeHGlobal(scmem); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(envmem!=IntPtr.Zero) Marshal.FreeHGlobal(envmem);
      if(lpacPolicy!=IntPtr.Zero) Marshal.FreeHGlobal(lpacPolicy);
      if(capmem!=IntPtr.Zero)Marshal.FreeHGlobal(capmem);if(capSid!=IntPtr.Zero)LocalFree(capSid);
      if(restrictedToken!=IntPtr.Zero)CloseHandle(restrictedToken);if(restrictionSidMemory!=IntPtr.Zero)Marshal.FreeHGlobal(restrictionSidMemory);
      if(brokerPipe!=null)brokerPipe.Dispose();if(nullInput!=IntPtr.Zero&&nullInput!=(IntPtr)(-1))CloseHandle(nullInput);
      int deleted=sid==IntPtr.Zero ? 0 : DeleteAppContainerProfile(profile); if(sid!=IntPtr.Zero) FreeSid(sid);
      bool? profileAbsent=profilePath==null ? (bool?)null : !Directory.Exists(profilePath);
      bool treeStopped=pi.process!=IntPtr.Zero && terminateSucceeded==true && rootWait==0 && (!assigned || activeProcesses==0);
      Event(new {stage="cleanup",profileDeleteHresult=deleted,profileDirectoryAbsent=profileAbsent,terminateSucceeded=terminateSucceeded,rootWaitResult=rootWait,jobActiveProcesses=activeProcesses,jobTotalProcesses=totalProcesses,ownedTreeTerminated=treeStopped,processCreated=pi.process!=IntPtr.Zero});
      if(deleted!=0 || profileAbsent!=true || (pi.process!=IntPtr.Zero && !treeStopped)) result=1;
    }
    return result;
  }
}
