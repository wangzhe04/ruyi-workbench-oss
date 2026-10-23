'use strict';
// Independent, owned Windows fixture operations; no work-data keys or runtime.
const cp = require('node:child_process');
const native = String.raw`
using System; using System.IO; using System.Text; using System.Collections.Generic;
using System.Runtime.InteropServices; using System.ComponentModel;
using System.Web.Script.Serialization; using Microsoft.Win32.SafeHandles;
public static class SkillCapsuleFixture {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attr; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr sec,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out Basic value,uint size);
  [DllImport("ntdll.dll")] static extern int NtSetEaFile(SafeFileHandle h,IntPtr iosb,byte[] buffer,uint length);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  static void Read(string root,string relative,List<object> rows,bool recursive) {
    string path=System.IO.Path.Combine(root,relative);
    using(var handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      Basic value;if(!GetFileInformationByHandleEx(handle,0,out value,(uint)Marshal.SizeOf(typeof(Basic))))throw new Win32Exception(Marshal.GetLastWin32Error());
      var sections=System.Security.AccessControl.AccessControlSections.Access|System.Security.AccessControl.AccessControlSections.Owner|System.Security.AccessControl.AccessControlSections.Group;
      string sddl=System.IO.File.GetAccessControl(path,sections).GetSecurityDescriptorSddlForm(sections);
      rows.Add(new Dictionary<string,object>{{"rel",relative.Replace('\\','/')},{"attrs",value.Attr},{"times",new string[]{value.Creation.ToString(),value.Access.ToString(),value.Write.ToString(),value.Change.ToString()}},{"sddl",sddl}});
      if(recursive&&(value.Attr&16)!=0)foreach(string child in Directory.GetFileSystemEntries(path))Read(root,System.IO.Path.Combine(relative,System.IO.Path.GetFileName(child)),rows,true);
    }
  }
  public static string Metadata(string root,string relatives) {
    var json=new JavaScriptSerializer();var rows=new List<object>();
    if(String.IsNullOrEmpty(relatives))Read(root,"",rows,true);
    else foreach(string relative in json.Deserialize<string[]>(relatives))Read(root,relative,rows,false);
    return json.Serialize(rows);
  }
  public static void AddEa(string path) {
    using(var handle=CreateFile(path,0x10,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] name=Encoding.ASCII.GetBytes("RUYI_FIXTURE_EA"),data=Encoding.ASCII.GetBytes("PRIVATE EA MUST NOT BE LOST");
      byte[] buffer=new byte[8+name.Length+1+data.Length];buffer[5]=(byte)name.Length;
      Buffer.BlockCopy(BitConverter.GetBytes((ushort)data.Length),0,buffer,6,2);Buffer.BlockCopy(name,0,buffer,8,name.Length);Buffer.BlockCopy(data,0,buffer,9+name.Length,data.Length);
      IntPtr iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
      try {int status=NtSetEaFile(handle,iosb,buffer,(uint)buffer.Length);if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));}
      finally {Marshal.FreeHGlobal(iosb);}
    }
  }
}`;
function invoke(file, operation, relatives) {
  const script = "$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RUYI_NATIVE_FIXTURE_SOURCE))); "
    + (operation === 'ea' ? '[SkillCapsuleFixture]::AddEa($env:RUYI_NATIVE_FIXTURE_PATH)' : '[SkillCapsuleFixture]::Metadata($env:RUYI_NATIVE_FIXTURE_PATH,$env:RUYI_NATIVE_FIXTURE_RELATIVES)');
  const result = cp.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, RUYI_NATIVE_FIXTURE_SOURCE: Buffer.from(native).toString('base64'), RUYI_NATIVE_FIXTURE_PATH: file,
      RUYI_NATIVE_FIXTURE_RELATIVES: relatives ? JSON.stringify(relatives) : '' },
    windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('native fixture failed: ' + result.status + ' ' + result.stderr);
  return operation === 'ea' ? undefined : JSON.parse(result.stdout.trim()).sort((a, b) => a.rel.localeCompare(b.rel));
}
module.exports = { basicMetadata: (file, relatives) => invoke(file, 'metadata', relatives), addEa: file => invoke(file, 'ea') };
