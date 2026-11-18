using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Own-source Windows lifetime/byte proxy. Model NDJSON never shares its control
// stream. The outer Job handle intentionally lives until process teardown.
internal static class ResidentProxyHost {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime;public uint flags;public UIntPtr minimum,maximum;public uint active;public UIntPtr affinity;public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic;public IoCounters io;public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d;public uint pageFaults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo { public int cb;public string reserved,desktop,title;public int x,y,w,h,cols,rows,fill;public uint flags;public short show,reservedBytes;public IntPtr reservedData,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info;public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread;public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high;public long Value {get{return unchecked((long)(((ulong)high<<32)|low));}} }
  [StructLayout(LayoutKind.Sequential)] struct ProcessBasic { public IntPtr reserved1,peb,reserved2,reserved3,pid,parentPid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SecurityAttributes attributes,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern void ExitProcess(uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out ProcessBasic info,int length,out int returned);
  sealed class Bootstrap { public int version {get;set;}public int parentPid {get;set;}public string parentCreationFileTime {get;set;}public string command {get;set;}public string[] args {get;set;}public string controlPipe {get;set;}public string nonce {get;set;}public string key {get;set;} }
  static JavaScriptSerializer Serializer(){return new JavaScriptSerializer {MaxJsonLength=131072,RecursionLimit=16};}
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly object ControlLock=new object();
  static readonly ManualResetEvent Stop=new ManualResetEvent(false),StartupComplete=new ManualResetEvent(false);
  static IntPtr Outer=IntPtr.Zero,Inner=IntPtr.Zero;
  static ProcessInfo Worker;
  static bool WorkerCreated,InnerAssigned,WorkerResumed,OutputStarted,OutputSucceeded;
  static readonly ManualResetEvent OutputDrained=new ManualResetEvent(false);
  static long WorkerOutputBytes;
  static byte[] Key;
  static string Nonce,HelperCreation,WorkerCreation,PipeName;
  static long Sequence,StopCounter,StderrBytes;
  static volatile string Reason="worker-exit";
  static void Require(bool value,string code){if(!value)throw new InvalidOperationException(code);}
  static long Created(IntPtr handle){FileTime a,b,c,d;Require(GetProcessTimes(handle,out a,out b,out c,out d),"PROCESS_IDENTITY");return a.Value;}
  static string Quote(string value){if(value==null||value.IndexOf('\0')>=0)throw new ArgumentException();if(value.Length>0&&value.IndexOfAny(new[]{' ','\t','\n','\v','"'})<0)return value;var b=new StringBuilder("\"");int slash=0;foreach(char ch in value){if(ch=='\\'){slash++;continue;}if(ch=='"'){b.Append('\\',slash*2+1);b.Append('"');slash=0;continue;}b.Append('\\',slash);slash=0;b.Append(ch);}b.Append('\\',slash*2);return b.Append('"').ToString();}
  static string Line(Stream input,int maximum,int timeout){var bytes=new MemoryStream();var timer=Stopwatch.StartNew();while(bytes.Length<=maximum){int value;if(timeout>0){var one=new byte[1];var read=input.BeginRead(one,0,1,null,null);int remaining=Math.Max(0,timeout-(int)timer.ElapsedMilliseconds);if(!read.AsyncWaitHandle.WaitOne(remaining))throw new IOException("CONTROL_TIMEOUT");value=input.EndRead(read)==0?-1:one[0];read.AsyncWaitHandle.Close();}else value=input.ReadByte();if(value<0)return bytes.Length==0?null:Utf8.GetString(bytes.ToArray());if(value==10)return Utf8.GetString(bytes.ToArray());bytes.WriteByte((byte)value);}throw new IOException("LINE_LIMIT");}
  static bool Hex(string value,int size){if(value==null||value.Length!=size)return false;foreach(char c in value)if(!(c>='0'&&c<='9'||c>='a'&&c<='f'))return false;return true;}
  static byte[] Decode(string value){var result=new byte[value.Length/2];for(int n=0;n<result.Length;n++)result[n]=Convert.ToByte(value.Substring(n*2,2),16);return result;}
  static string Mac(string value){using(var h=new HMACSHA256(Key))return BitConverter.ToString(h.ComputeHash(Utf8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
  static bool Equal(string a,string b){if(a==null||b==null||a.Length!=b.Length)return false;int difference=0;for(int n=0;n<a.Length;n++)difference|=a[n]^b[n];return difference==0;}
  static void Control(string type,Dictionary<string,object> fields){if(Key==null)return;lock(ControlLock){fields["type"]=type;fields["counter"]=++Sequence;fields["nonce"]=Nonce;fields["helperPid"]=GetCurrentProcessId();fields["helperCreationFileTime"]=HelperCreation;var payload=Serializer().Serialize(fields);Console.Error.WriteLine(Serializer().Serialize(new Dictionary<string,object>{{"payload",payload},{"mac",Mac(payload)}}));Console.Error.Flush();}}
  static void KillForParent(){if(Outer!=IntPtr.Zero)TerminateJobObject(Outer,187);ExitProcess(187);}
  static IntPtr Parent(int claimed,long creation){ProcessBasic basic;int returned;Require(NtQueryInformationProcess(GetCurrentProcess(),0,out basic,Marshal.SizeOf(typeof(ProcessBasic)),out returned)==0&&basic.parentPid.ToInt64()==claimed,"PARENT_PID");var handle=OpenProcess(0x00100000|0x1000,false,claimed);Require(handle!=IntPtr.Zero,"PARENT_HANDLE");if(Created(handle)!=creation){CloseHandle(handle);throw new InvalidOperationException("PARENT_CREATION");}return handle;}
  static IntPtr Job(uint active){var job=CreateJobObject(IntPtr.Zero,null);Require(job!=IntPtr.Zero,"JOB_CREATE");var limit=new ExtendedLimit();limit.basic.flags=0x2000|0x8;limit.basic.active=active;if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))){CloseHandle(job);throw new InvalidOperationException("JOB_LIMIT");}return job;}
  static void ControlServer(){try{while(!Stop.WaitOne(0)){var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);using(var identity=WindowsIdentity.GetCurrent()){security.AddAccessRule(new PipeAccessRule(identity.User,PipeAccessRights.FullControl,AccessControlType.Allow));}security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));using(var pipe=new NamedPipeServerStream(PipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security)){pipe.WaitForConnection();try{var text=Line(pipe,4096,1500);var row=Serializer().Deserialize<Dictionary<string,object>>(text);Require(row!=null&&row.Count==4&&row.ContainsKey("op")&&row.ContainsKey("nonce")&&row.ContainsKey("counter")&&row.ContainsKey("mac"),"STOP_SHAPE");long counter=Convert.ToInt64(row["counter"]);Require((string)row["op"]=="stop"&&(string)row["nonce"]==Nonce&&counter==Interlocked.Read(ref StopCounter)+1&&Equal((string)row["mac"],Mac("stop|"+counter+"|"+Nonce)),"STOP_AUTH");Interlocked.Exchange(ref StopCounter,counter);Reason="stop-command";Stop.Set();}catch{}}}}catch{Reason="control-failed";Stop.Set();}}
  static void Spawn(Bootstrap request,Stream parentInput){
    IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero;
    bool attributeReady=false;
    try{var sa=new SecurityAttributes {length=Marshal.SizeOf(typeof(SecurityAttributes)),inherit=true};Require(CreatePipe(out inputRead,out inputWrite,ref sa,65536),"PIPE_INPUT");Require(CreatePipe(out outputRead,out outputWrite,ref sa,65536),"PIPE_OUTPUT");Require(CreatePipe(out errorRead,out errorWrite,ref sa,65536),"PIPE_ERROR");Require(SetHandleInformation(inputWrite,1,0)&&SetHandleInformation(outputRead,1,0)&&SetHandleInformation(errorRead,1,0),"PIPE_INHERITANCE");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);Require(size!=IntPtr.Zero,"HANDLE_LIST_SIZE");attributes=Marshal.AllocHGlobal(size);Require(InitializeProcThreadAttributeList(attributes,1,0,ref size),"HANDLE_LIST_INIT");attributeReady=true;handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,inputRead);Marshal.WriteIntPtr(handles,IntPtr.Size,outputWrite);Marshal.WriteIntPtr(handles,IntPtr.Size*2,errorWrite);Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x00020002,handles,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"HANDLE_LIST");
      var startup=new StartupInfoEx();startup.info.cb=Marshal.SizeOf(typeof(StartupInfoEx));startup.info.flags=0x100;startup.info.input=inputRead;startup.info.output=outputWrite;startup.info.error=errorWrite;startup.attributes=attributes;var command=new StringBuilder(Quote(request.command));foreach(string arg in request.args)command.Append(' ').Append(Quote(arg));Require(command.Length<32767,"COMMAND_LIMIT");Require(!Stop.WaitOne(0),"STOPPED_BEFORE_SPAWN");Require(CreateProcessW(request.command,command,IntPtr.Zero,IntPtr.Zero,true,0x00000004|0x00080000|0x08000000,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out Worker),"CREATE_PROCESS");WorkerCreated=true;WorkerCreation=Created(Worker.process).ToString();Require(AssignProcessToJobObject(Inner,Worker.process),"ASSIGN_INNER");InnerAssigned=true;Require(!Stop.WaitOne(0),"STOPPED_BEFORE_RESUME");
      Control("owned",new Dictionary<string,object>{{"workerPid",Worker.pid},{"workerCreationFileTime",WorkerCreation},{"outerAssigned",true},{"innerAssigned",true}});Require(ResumeThread(Worker.thread)!=0xffffffff,"RESUME");WorkerResumed=true;CloseHandle(Worker.thread);Worker.thread=IntPtr.Zero;
      CloseHandle(inputRead);inputRead=IntPtr.Zero;CloseHandle(outputWrite);outputWrite=IntPtr.Zero;CloseHandle(errorWrite);errorWrite=IntPtr.Zero;
      var childInput=new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write,65536);inputWrite=IntPtr.Zero;var childOutput=new FileStream(new SafeFileHandle(outputRead,true),FileAccess.Read,65536);outputRead=IntPtr.Zero;var childError=new FileStream(new SafeFileHandle(errorRead,true),FileAccess.Read,8192);errorRead=IntPtr.Zero;
      var input=new Thread(()=>{try{var buffer=new byte[65536];int count;while((count=parentInput.Read(buffer,0,buffer.Length))>0){childInput.Write(buffer,0,count);childInput.Flush();}Reason="stdin-eof";}catch{Reason="stdin-closed";}finally{Stop.Set();try{childInput.Dispose();}catch{}}});input.IsBackground=true;input.Start();
      var output=new Thread(()=>{try{var target=Console.OpenStandardOutput();var buffer=new byte[65536];int count;while((count=childOutput.Read(buffer,0,buffer.Length))>0){target.Write(buffer,0,count);Interlocked.Add(ref WorkerOutputBytes,count);}target.Flush();OutputSucceeded=true;}catch{Reason="stdout-closed";Stop.Set();}finally{try{childOutput.Dispose();}catch{}OutputDrained.Set();}});output.IsBackground=true;OutputStarted=true;output.Start();
      var errors=new Thread(()=>{try{var buffer=new byte[8192];int read;while((read=childError.Read(buffer,0,buffer.Length))>0)Interlocked.Add(ref StderrBytes,read);}catch{}finally{try{childError.Dispose();}catch{}}});errors.IsBackground=true;errors.Start();StartupComplete.Set();
    }finally{if(attributeReady)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);foreach(var handle in new[]{inputRead,inputWrite,outputRead,outputWrite,errorRead,errorWrite})if(handle!=IntPtr.Zero)CloseHandle(handle);}
  }
  static bool Cleanup(){var timer=Stopwatch.StartNew();bool signaled=!WorkerCreated;uint exitCode=0;int? active=null;if(WorkerCreated){if(WaitForSingleObject(Worker.process,0)!=0){if(InnerAssigned)TerminateJobObject(Inner,188);else TerminateProcess(Worker.process,188);}signaled=WaitForSingleObject(Worker.process,(uint)Math.Max(0,5000-(int)timer.ElapsedMilliseconds))==0;GetExitCodeProcess(Worker.process,out exitCode);}Accounting account;if(Inner!=IntPtr.Zero){do{if(QueryInformationJobObject(Inner,1,out account,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)){active=(int)account.active;if(active==0)break;}else break;Thread.Sleep(5);}while(timer.ElapsedMilliseconds<5000);}else if(!WorkerCreated)active=0;
    bool drained=!WorkerResumed||(OutputStarted&&OutputDrained.WaitOne(Math.Max(0,5000-(int)timer.ElapsedMilliseconds))&&OutputSucceeded);
    bool observed=signaled&&active==0&&drained;Control("closed",new Dictionary<string,object>{{"cleanupStatus",observed?"observed":"unknown"},{"workerStarted",WorkerCreated},{"workerPid",WorkerCreated?(object)Worker.pid:null},{"workerCreationFileTime",WorkerCreation},{"workerSignaled",signaled},{"innerActive",active},{"workerExitCode",exitCode},{"reason",Reason},{"workerStderrBytes",Interlocked.Read(ref StderrBytes)},{"stdoutDrained",drained},{"workerOutputBytes",Interlocked.Read(ref WorkerOutputBytes)}});return observed;
  }
  static int Main(string[] argv){IntPtr parent=IntPtr.Zero;bool clean=false;var startupTimer=new Thread(()=>{if(!StartupComplete.WaitOne(10000))KillForParent();});startupTimer.IsBackground=true;startupTimer.Start();try{Require(argv.Length==2,"ARGUMENTS");int parentPid=Int32.Parse(argv[0]);long parentCreation=Int64.Parse(argv[1]);parent=Parent(parentPid,parentCreation);var parentHandle=parent;var watcher=new Thread(()=>{WaitForSingleObject(parentHandle,0xffffffff);KillForParent();});watcher.IsBackground=true;watcher.Start();HelperCreation=Created(GetCurrentProcess()).ToString();var input=Console.OpenStandardInput();var text=Line(input,131072,0);var shape=Serializer().Deserialize<Dictionary<string,object>>(text);Require(shape!=null&&shape.Count==8,"BOOTSTRAP_FIELDS");foreach(var name in new[]{"version","parentPid","parentCreationFileTime","command","args","controlPipe","nonce","key"})Require(shape.ContainsKey(name),"BOOTSTRAP_FIELDS");var request=Serializer().Deserialize<Bootstrap>(text);Require(request!=null&&request.version==1&&request.parentPid==parentPid&&request.parentCreationFileTime==parentCreation.ToString()&&Path.IsPathRooted(request.command)&&request.command==Path.GetFullPath(request.command)&&request.args!=null&&request.args.Length<=64&&Hex(request.nonce,64)&&Hex(request.key,64)&&request.controlPipe=="ruyi-resident-proxy-"+request.nonce,"BOOTSTRAP");Key=Decode(request.key);Nonce=request.nonce;PipeName=request.controlPipe;
      Outer=Job(2);Require(AssignProcessToJobObject(Outer,GetCurrentProcess()),"ASSIGN_OUTER");Inner=Job(1);var server=new Thread(ControlServer);server.IsBackground=true;server.Start();Control("control-ready",new Dictionary<string,object>{{"controlPipe",PipeName}});Spawn(request,input);uint result=WaitForMultipleObjects(2,new[]{Stop.SafeWaitHandle.DangerousGetHandle(),Worker.process},false,0xffffffff);if(result==1)Reason="worker-exit";else if(result!=0)throw new IOException("WAIT_FAILED");clean=Cleanup();return clean?0:1;
    }catch{Reason="startup-error";try{clean=Cleanup();}catch{}return 1;}finally{StartupComplete.Set();if(Worker.thread!=IntPtr.Zero)CloseHandle(Worker.thread);if(Worker.process!=IntPtr.Zero)CloseHandle(Worker.process);if(Inner!=IntPtr.Zero)CloseHandle(Inner);/* parent HANDLE remains open while the independent waiter is pending; OS teardown closes it. */if(Key!=null)Array.Clear(Key,0,Key.Length);
      // Do not CloseHandle(Outer): it contains this process. OS teardown closes
      // the sole non-inherited handle after the cleanup acknowledgement.
    }
  }
}
