using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// Transient, system-PowerShell-loaded file lease broker. Never a resident model host.
public static class ResidentImageLease {
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint lo,hi; public string Value {get{return (((ulong)hi<<32)|lo).ToString();}}}
 [StructLayout(LayoutKind.Sequential)] struct FI {public uint attrs;public FT creation,access,write;public uint volume,sizeHi,sizeLo,links,indexHi,indexLo;}
 [StructLayout(LayoutKind.Sequential)] struct PBI {public IntPtr a,b,c,d,pid,parent;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder text,uint length,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FI info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FT a,out FT b,out FT c,out FT d);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out PBI info,int length,out int returned);
 sealed class Lease {public string value,kind,path;public Lease(string v,string k,string p){value=v;kind=k;path=p;}}
 static void Need(bool value,string message){if(!value)throw new IOException(message+":"+Marshal.GetLastWin32Error());}
 static string Full(string value){Need(!String.IsNullOrEmpty(value)&&Path.IsPathRooted(value)&&!value.StartsWith(@"\\"),"LEASE_PATH");string full=Path.GetFullPath(value);Need(String.Equals(full,value,StringComparison.OrdinalIgnoreCase),"LEASE_PATH_CANONICAL");return full;}
 static IntPtr Parent(int pid,string creation){PBI info;int size;Need(NtQueryInformationProcess(GetCurrentProcess(),0,out info,Marshal.SizeOf(typeof(PBI)),out size)==0&&info.parent.ToInt64()==pid,"LEASE_OS_PARENT");IntPtr process=OpenProcess(0x00100000|0x1000|0x40,false,pid);Need(process!=IntPtr.Zero,"LEASE_PARENT_OPEN");FT a,b,c,d;try{Need(GetProcessTimes(process,out a,out b,out c,out d)&&a.Value==creation&&WaitForSingleObject(process,0)==258,"LEASE_PARENT_IDENTITY");return process;}catch{CloseHandle(process);throw;}}
 static void Alive(IntPtr parent){Need(WaitForSingleObject(parent,0)==258,"LEASE_PARENT_EXITED");}
 static IntPtr Lock(string path,bool directory){IntPtr file=CreateFileW(path,directory?0x80u:0x80000000u,1,IntPtr.Zero,3,directory?0x02200000u:0x00200000u,IntPtr.Zero);Need(file!=new IntPtr(-1),"LEASE_OPEN");try{FI info;Need(GetFileInformationByHandle(file,out info)&&(info.attrs&0x400)==0&&((info.attrs&0x10)!=0)==directory,"LEASE_FILE_KIND");var text=new StringBuilder(32768);uint length=GetFinalPathNameByHandleW(file,text,(uint)text.Capacity,0);Need(length>0&&length<text.Capacity,"LEASE_FINAL_PATH");string actual=text.ToString();if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);Need(String.Equals(actual.TrimEnd('\\'),path.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase),"LEASE_ALIAS");return file;}catch{CloseHandle(file);throw;}}
 static string Digest(IntPtr file){using(var stream=new FileStream(new SafeFileHandle(file,false),FileAccess.Read,65536,false))using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
 static void RemoteClose(IntPtr parent,string text){ulong value;Need(UInt64.TryParse(text,out value)&&value>0&&value<Int64.MaxValue,"LEASE_HANDLE");IntPtr local;Need(DuplicateHandle(parent,new IntPtr((long)value),GetCurrentProcess(),out local,0,false,3),"LEASE_CLOSE_SOURCE");Need(CloseHandle(local),"LEASE_CLOSE_LOCAL");}
 public static object Run(int pid,string creation,string operation,string[] files,string[] hashes,string[] handles){var leases=new List<Lease>();var local=new List<IntPtr>();var released=new List<string>();IntPtr parent=IntPtr.Zero;try{parent=Parent(pid,creation);if(operation=="release"){Need(handles!=null&&handles.Length<=128,"LEASE_RELEASE_COUNT");foreach(string handle in handles){Alive(parent);RemoteClose(parent,handle);released.Add(handle);}return new {ok=true,released=released.ToArray()};}
  Need(operation=="acquire"&&files!=null&&hashes!=null&&files.Length==2&&hashes.Length==2,"LEASE_REQUEST");var directories=new SortedSet<string>(Comparer<string>.Create((a,b)=>{int size=a.Length.CompareTo(b.Length);return size!=0?size:StringComparer.OrdinalIgnoreCase.Compare(a,b);}));foreach(string raw in files){string file=Full(raw);for(string dir=Path.GetDirectoryName(file);!String.IsNullOrEmpty(dir);dir=Path.GetDirectoryName(dir)){directories.Add(dir);if(dir==Path.GetPathRoot(dir))break;}directories.Add(Path.GetPathRoot(file));}Need(directories.Count<=96,"LEASE_DIRECTORY_COUNT");var kinds=new List<string>();var paths=new List<string>();foreach(string directory in directories){Alive(parent);local.Add(Lock(directory,true));kinds.Add("directory");paths.Add(directory);}for(int n=0;n<files.Length;n++){Alive(parent);IntPtr file=Lock(Full(files[n]),false);local.Add(file);kinds.Add("file");paths.Add(files[n]);Need(Digest(file)==hashes[n],"LEASE_INTEGRITY");}
  for(int n=0;n<local.Count;n++){Alive(parent);IntPtr remote;Need(DuplicateHandle(GetCurrentProcess(),local[n],parent,out remote,0,false,2),"LEASE_DUPLICATE");leases.Add(new Lease(((ulong)remote.ToInt64()).ToString(),kinds[n],paths[n]));}Alive(parent);return new {ok=true,leases=leases.ToArray(),parentPid=pid,parentCreationFileTime=creation};
 }catch(Exception error){if(parent!=IntPtr.Zero&&operation=="acquire"){foreach(Lease lease in leases){try{RemoteClose(parent,lease.value);released.Add(lease.value);}catch{}}}var retained=new List<string>();foreach(Lease lease in leases)if(!released.Contains(lease.value))retained.Add(lease.value);return new {ok=false,error=error.Message,released=released.ToArray(),retained=retained.ToArray()};}finally{foreach(IntPtr handle in local)CloseHandle(handle);if(parent!=IntPtr.Zero)CloseHandle(parent);}}
}
