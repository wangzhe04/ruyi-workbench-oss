using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Research-only lifetime host. The unnamed non-inheritable job handle is held
// only by this process. Native stdout/stderr are drained to nowhere.
internal static class NativeJobHost {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  sealed class Request { public string command {get;set;} public string[] args {get;set;} }
  static string Quote(string arg) {
    if (arg == null) throw new ArgumentException();
    if (arg.Length > 0 && arg.IndexOfAny(new[]{' ', '\t', '\n', '\v', '"'}) < 0) return arg;
    var b=new StringBuilder("\"");int slash=0;foreach(char c in arg){if(c=='\\'){slash++;continue;}if(c=='"'){b.Append('\\',slash*2+1);b.Append('"');slash=0;continue;}b.Append('\\',slash);slash=0;b.Append(c);}b.Append('\\',slash*2);return b.Append('"').ToString();
  }
  static int Main(string[] argv) {
    // Observe only the exact process instance; never send a signal by PID.
    if(argv.Length==3 && argv[0]=="--wait") {
      try { int pid=Int32.Parse(argv[1]);long created=Int64.Parse(argv[2]);using(var process=Process.GetProcessById(pid)){if(process.StartTime.ToUniversalTime().ToFileTimeUtc()!=created)return 0;process.WaitForExit();return 0;} }
      catch(ArgumentException){return 0;}catch{return 1;}
    }
    if(argv.Length!=0)return 2;
    Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
    IntPtr job=IntPtr.Zero;Process native=null;var stop=new ManualResetEvent(false);
    try {
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new InvalidOperationException();
      var limit=new ExtendedLimit();limit.basic.flags=0x00002000;
      if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(ExtendedLimit))))throw new InvalidOperationException();
      if(!AssignProcessToJobObject(job,GetCurrentProcess()))throw new InvalidOperationException();
      var first=Console.In.ReadLine();if(first==null||first.Length>131072)return 2;
      var req=new JavaScriptSerializer().Deserialize<Request>(first);if(req==null||String.IsNullOrEmpty(req.command)||req.args==null||req.args.Length>256)return 2;
      var monitor=new Thread(()=>{try{while(Console.In.ReadLine()!=null)break;}catch{}finally{stop.Set();}});monitor.IsBackground=true;monitor.Start();
      if(stop.WaitOne(0))return 3;
      var info=new ProcessStartInfo(req.command);var args=new StringBuilder();foreach(var item in req.args){if(args.Length>0)args.Append(' ');args.Append(Quote(item));}info.Arguments=args.ToString();
      info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardInput=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
      native=Process.Start(info);if(native==null)throw new InvalidOperationException();native.StandardInput.Close();
      native.StandardOutput.BaseStream.CopyToAsync(Stream.Null);native.StandardError.BaseStream.CopyToAsync(Stream.Null);
      Console.Out.WriteLine("{\"type\":\"ready\",\"nativePid\":"+native.Id+",\"creationFileTime\":\""+native.StartTime.ToUniversalTime().ToFileTimeUtc()+"\"}");Console.Out.Flush();
      while(!stop.WaitOne(25)){if(native.HasExited)break;}
      if(!native.HasExited){native.Kill();native.WaitForExit();}else native.WaitForExit();
      Console.Out.WriteLine("{\"type\":\"closed\"}");Console.Out.Flush();return 0;
    }catch{try{if(native!=null&&!native.HasExited){native.Kill();native.WaitForExit();}}catch{}Console.Error.WriteLine("native_job_host.failure");return 1;}
    finally{if(native!=null)native.Dispose();if(job!=IntPtr.Zero)CloseHandle(job);stop.Dispose();}
  }
}
