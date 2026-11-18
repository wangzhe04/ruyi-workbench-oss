using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

// Test-only native kill witness. Not shipped or invoked by the product runtime.
public static class ResidentOwnedProcessControl {
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint lo,hi;public string Value {get{return (((ulong)hi<<32)|lo).ToString();}}}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FT creation,out FT exit,out FT kernel,out FT user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder image,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 public sealed class Result {public bool ok,identityMatched,terminateCalled,terminateSucceeded,handleClosed;public int requestedPid,win32;public uint actualPid,beforeWait,afterWait,exitCode;public string creationFileTime,image,error,operation;public string authority="one retained native process HANDLE; no product Job handle opened";}
 static void Need(bool value,string code){if(!value)throw new IOException(code+":"+Marshal.GetLastWin32Error());}
 public static Result Run(int pid,string expectedCreation,string expectedImage,string operation){var result=new Result {requestedPid=pid,operation=operation};IntPtr target=IntPtr.Zero;try{ulong birth;Need(pid>0&&pid!=GetCurrentProcessId()&&UInt64.TryParse(expectedCreation,out birth)&&birth>0&&(operation=="inspect"||operation=="terminate"),"CONTROL_ARGUMENT");Need(!String.IsNullOrEmpty(expectedImage)&&Path.IsPathRooted(expectedImage),"CONTROL_IMAGE");expectedImage=Path.GetFullPath(expectedImage);target=OpenProcess(0x00100000|0x1000|1,false,pid);Need(target!=IntPtr.Zero,"CONTROL_OPEN");result.actualPid=GetProcessId(target);FT a,b,c,d;Need(GetProcessTimes(target,out a,out b,out c,out d),"CONTROL_CREATION");result.creationFileTime=a.Value;var text=new StringBuilder(32768);uint length=(uint)text.Capacity;Need(QueryFullProcessImageNameW(target,0,text,ref length),"CONTROL_IMAGE_QUERY");result.image=text.ToString();result.identityMatched=result.actualPid==(uint)pid&&result.creationFileTime==expectedCreation&&String.Equals(Path.GetFullPath(result.image),expectedImage,StringComparison.OrdinalIgnoreCase);Need(result.identityMatched,"CONTROL_IDENTITY_MISMATCH");result.beforeWait=WaitForSingleObject(target,0);Need(result.beforeWait==0||result.beforeWait==258,"CONTROL_WAIT_BEFORE");if(operation=="terminate"){Need(result.beforeWait==258,"CONTROL_ALREADY_EXITED");result.terminateCalled=true;result.terminateSucceeded=TerminateProcess(target,199);Need(result.terminateSucceeded,"CONTROL_TERMINATE");result.afterWait=WaitForSingleObject(target,5000);Need(result.afterWait==0,"CONTROL_WAIT_EXIT");Need(GetExitCodeProcess(target,out result.exitCode),"CONTROL_EXIT_CODE");Need(result.exitCode==199,"CONTROL_WRONG_EXIT_CODE");}else result.afterWait=result.beforeWait;result.ok=true;}catch(Exception error){result.error=error.Message;result.win32=Marshal.GetLastWin32Error();result.ok=false;}finally{if(target!=IntPtr.Zero){result.handleClosed=CloseHandle(target);if(!result.handleClosed){result.ok=false;result.error="CONTROL_CLOSE_HANDLE";result.win32=Marshal.GetLastWin32Error();}}else result.handleClosed=true;}return result;}
}
