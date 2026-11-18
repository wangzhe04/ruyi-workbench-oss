'use strict';
// Research-only counterfactual. Existing guard, census and capture stay intact.
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){
 const edits=[
 ['  static string Id(SafeFileHandle handle) {',String.raw`  // Research: classify through held parent, then bind the original-style open
  // to the same ID and attributes. Two opens may be more restrictive than Open.
  static SafeFileHandle ResearchRelativeOpen(SafeFileHandle parent,string part,out bool writable) {
    if(String.IsNullOrEmpty(part)||part.IndexOfAny(new char[]{'\\','/',':','\0'})>=0)Reject("relative_research_name");
    IntPtr buffer=Marshal.StringToHGlobalUni(part),name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RelativeName))),iosb=Marshal.AllocHGlobal(IntPtr.Size*2);
    SafeFileHandle probe=null,handle=null;
    try {
      RelativeName unicode=new RelativeName{Length=(ushort)(part.Length*2),MaximumLength=(ushort)((part.Length+1)*2),Buffer=buffer};Marshal.StructureToPtr(unicode,name,false);
      RelativeAttributes a=new RelativeAttributes{Length=(uint)Marshal.SizeOf(typeof(RelativeAttributes)),RootDirectory=parent.DangerousGetHandle(),ObjectName=name,Attributes=0x40};
      int status=NtCreateFile(out probe,0x00100180u,ref a,iosb,IntPtr.Zero,0,7,1,0x00204020u,IntPtr.Zero,0);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));if(status!=0||probe==null||probe.IsInvalid)Reject("relative_research_probe");
      PreserveHandleTimes(probe);uint attrs=BasicOf(probe).Attr;string expected=Id(probe);bool directory=(attrs&0x10u)!=0,readOnly=(attrs&1u)!=0;
      probe.Dispose();probe=null;writable=!directory&&!readOnly;
      uint access=CapturedDirectoryWrite&&directory?0xC0110100u:writable?0xC0110000u:0x80110100u;
      status=NtCreateFile(out handle,access,ref a,iosb,IntPtr.Zero,0,directory?7u:5u,1,0x00204020u,IntPtr.Zero,0);
      if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status));if(status!=0||handle==null||handle.IsInvalid)Reject("relative_research_open");
      PreserveHandleTimes(handle);if(Id(handle)!=expected||BasicOf(handle).Attr!=attrs)Reject("relative_research_changed");
      SafeFileHandle result=handle;handle=null;return result;
    } finally {if(probe!=null)probe.Dispose();if(handle!=null)handle.Dispose();GC.KeepAlive(parent);Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(iosb);}
  }
  static string Id(SafeFileHandle handle) {`],
 ['  static void Walk(string path, string rel, List<object> entries, bool capture) {','  static void Walk(string path, string rel, List<object> entries, bool capture, SafeFileHandle parent = null) {'],
 ['    Node node = new Node(); node.Handle = Open(path, out node.Writable);','    Node node = new Node(); node.Handle = PreserveTimeHandles && parent != null ? ResearchRelativeOpen(parent,System.IO.Path.GetFileName(path),out node.Writable) : Open(path, out node.Writable);'],
 ['rel + "/" + System.IO.Path.GetFileName(child), entries, capture);','rel + "/" + System.IO.Path.GetFileName(child), entries, capture,node.Handle);']
 ];let result=source;for(const [a,b] of edits){if(result.split(a).length!==2)throw Error('relative.boundary '+a.slice(0,50));result=result.replace(a,b);}return {source:result,originalSha256:H(source),derivedSha256:H(result),edits};
}
module.exports={transform};

