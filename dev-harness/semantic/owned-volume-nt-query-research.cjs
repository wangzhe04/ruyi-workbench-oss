'use strict';
// Research-only replacement inside Capture; no source rewrites/flushes.
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){const edits=[
 ['  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle h,IntPtr iosb,IntPtr value,uint length,int kind);','  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle h,IntPtr iosb,IntPtr value,uint length,int kind);\n  [DllImport("ntdll.dll")] static extern int NtQueryVolumeInformationFile(SafeFileHandle h,IntPtr iosb,IntPtr value,uint length,int kind);'],
 ['  static object Capture(Dictionary<string,object> args) {',String.raw`  // Research only: query the already held root object; never reopen a path.
  static void ResearchVolumeInfo(SafeFileHandle handle,out uint serial,out uint component,out uint flags,out string filesystem) {
    const int capacity=4096;IntPtr buffer=Marshal.AllocHGlobal(capacity),iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
    try {
      int status=NtQueryVolumeInformationFile(handle,iosb,buffer,capacity,5);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));if(status!=0)Reject("research_volume_status");
      long used=Marshal.ReadIntPtr(iosb,IntPtr.Size).ToInt64();if(used<12||used>capacity)Reject("research_volume_bounds");
      flags=unchecked((uint)Marshal.ReadInt32(buffer,0));int max=Marshal.ReadInt32(buffer,4),bytes=Marshal.ReadInt32(buffer,8);
      if(max<0||bytes<=0||(bytes&1)!=0||bytes>capacity-12||used<12L+bytes)Reject("research_volume_bounds");
      component=(uint)max;filesystem=Marshal.PtrToStringUni(IntPtr.Add(buffer,12),bytes/2);
      status=NtQueryVolumeInformationFile(handle,iosb,buffer,capacity,1);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));if(status!=0)Reject("research_volume_status");
      used=Marshal.ReadIntPtr(iosb,IntPtr.Size).ToInt64();if(used<18||used>capacity)Reject("research_volume_bounds");
      serial=unchecked((uint)Marshal.ReadInt32(buffer,8));int labelBytes=Marshal.ReadInt32(buffer,12);
      if(labelBytes<0||(labelBytes&1)!=0||labelBytes>capacity-18||used<18L+labelBytes)Reject("research_volume_bounds");
      Info info;Check(GetFileInformationByHandle(handle,out info));if(serial!=info.Volume)Reject("research_volume_serial_changed");
    }finally {Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(iosb);}
  }
  static object Capture(Dictionary<string,object> args) {`],
 ['    StringBuilder filesystem = new StringBuilder(64); uint serial, component, flags;\n    Check(GetVolumeInformationByHandleW(RootNode().Handle, null, 0, out serial, out component, out flags, filesystem, 64));\n    if (filesystem.ToString() != "NTFS") Reject("filesystem_unsupported");', '    string filesystem; uint serial, component, flags;\n    ResearchVolumeInfo(RootNode().Handle,out serial,out component,out flags,out filesystem);\n    if (filesystem != "NTFS") Reject("filesystem_unsupported");']
 ];let out=source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('volume.research.boundary '+a.slice(0,50));out=out.replace(a,b);}return{source:out,originalSha256:H(source),derivedSha256:H(out),edits};}
module.exports={transform};
