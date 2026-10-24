$ErrorActionPreference = 'Stop'
# Owned synthetic process transport only; operation and flush remain simulations.
$ruyiRuntimeJobSource = @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class MaintenanceRuntimeOuterJobProbe {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long PerProcess,PerJob;public uint Flags;public UIntPtr Minimum,Maximum;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Extended value,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool value){if(!value)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 static int ReadPid(string root,string name){string file=Path.Combine(root,name);for(int n=0;n<600&&!File.Exists(file);n++)Thread.Sleep(25);if(!File.Exists(file))throw new Exception("Owned process did not become ready: "+name);return Int32.Parse(File.ReadAllText(file));}
 public static void Run(string root,string node,string fixture){
  IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("Job unavailable");
  Process parent=null,worker=null,successor=null;
  try{
   var info=new Extended();info.Basic.Flags=0x2000;Check(SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(Extended))));
   var start=new ProcessStartInfo(node,"\""+fixture+"\" parent");start.UseShellExecute=false;start.CreateNoWindow=true;
   parent=Process.Start(start);Check(AssignProcessToJobObject(job,parent.Handle));File.WriteAllText(Path.Combine(root,"outer-job-assigned"),"assigned");
   if(!parent.WaitForExit(15000)||parent.ExitCode!=0)throw new Exception("Original serve failed or did not exit");
   int workerPid=ReadPid(root,"worker-pid.txt"),successorPid=ReadPid(root,"successor-pid.txt");
   try{worker=Process.GetProcessById(workerPid);if(!worker.WaitForExit(10000))throw new Exception("Worker did not actually exit after successor acknowledgment");}catch(ArgumentException){/* Already observed absent after the successor's ready record. */}
   successor=Process.GetProcessById(successorPid);if(successor.HasExited)throw new Exception("Successor died with worker");
   // Closing the desktop-style outer Job must still close its detached grandchild.
   Check(CloseHandle(job));job=IntPtr.Zero;
   if(!successor.WaitForExit(10000))throw new Exception("Successor escaped desktop outer Job");
   File.WriteAllText(Path.Combine(root,"outer-job-result.json"),"{\"ok\":true,\"workerExited\":true,\"successorSurvivedWorker\":true,\"outerJobKilledSuccessor\":true,\"worker\":"+workerPid+",\"successor\":"+successorPid+"}");
  }finally{
   if(job!=IntPtr.Zero)CloseHandle(job);
   // Exact Process objects were obtained from this fixture's fresh private PID
   // records. Cleanup also settles a deliberately unassigned negative control.
   foreach(Process owned in new Process[]{successor,worker,parent})if(owned!=null){try{if(!owned.HasExited){owned.Kill();owned.WaitForExit(5000);}}finally{owned.Dispose();}}
  }
 }
}
'@
Add-Type -TypeDefinition $ruyiRuntimeJobSource
[MaintenanceRuntimeOuterJobProbe]::Run($env:RUYI_RUNTIME_UNIT_ROOT, $env:RUYI_RUNTIME_NODE_EXE, $env:RUYI_RUNTIME_FIXTURE)
