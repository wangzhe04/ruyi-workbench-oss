'use strict';
// Research-only native delta. Product source is untouched.
const crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source){
 const edits=[
 ['static SafeFileHandle OpenFlushChild(SafeFileHandle parent,string part,string expected,string volume) {','static SafeFileHandle OpenFlushChild(SafeFileHandle parent,string part,string expected,string volume,string expectedId=null) {'],
 ['      CheckFlushDirectory(handle,expected,volume);return handle;','      CheckFlushDirectory(handle,expected,volume,expectedId);return handle;'],
 ['  static void FlushStoreDirectoryPreserved(string path,string anchor) {',String.raw`  // Research-only owned-restore flush: open each component from the held
  // parent and compare the creation-time identity supplied by its owner.
  static object ResearchFlushOwnedRestore(Dictionary<string,object> args) {
    string anchor=Str(args["root"]),relative=Str(args["relative"]);
    object[] ids=args["ids"] as object[];
    if(anchor.Length<3 || anchor.Length>32763 || !Char.IsLetter(anchor[0]) || anchor[1]!=':' || anchor[2]!='\\'
      || !String.Equals(System.IO.Path.GetFullPath(anchor),anchor,StringComparison.OrdinalIgnoreCase))Reject("research_root");
    string[] parts=relative==""?new string[0]:relative.Split('/');
    if(parts.Length>512 || ids==null || ids.Length!=parts.Length+1)Reject("research_chain");
    foreach(string part in parts)if(!FlushPart(part))Reject("research_chain");
    foreach(object value in ids)if(!(value is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)value,"^[a-f0-9]{24}$"))Reject("research_identity");
    bool previous=PreserveTimeHandles;PreserveTimeHandles=true;var handles=new List<SafeFileHandle>();
    try {
      var root=CreateFile(anchor,0xC0000000u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
      if(root.IsInvalid){int error=Marshal.GetLastWin32Error();root.Dispose();throw new Win32Exception(error);}
      handles.Add(root);string expected=@"\\?\"+anchor;CheckFlushDirectory(root,expected,null,(string)ids[0]);string volume=VolumeOf(root);SafeFileHandle current=root;
      for(int i=0;i<parts.Length;i++){expected+=(expected.EndsWith("\\")?"":"\\")+parts[i];current=OpenFlushChild(current,parts[i],expected,volume,(string)ids[i+1]);handles.Add(current);}
      Check(FlushFileBuffers(current));
      return new Dictionary<string,object>{{"ok",true},{"root",anchor},{"relative",relative},{"ids",ids}};
    } finally {try {for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();}finally {PreserveTimeHandles=previous;}}
  }
  static void FlushStoreDirectoryPreserved(string path,string anchor) {`],
 ['          else if (command == "store-flush-bound") result=FlushStoreDirectoryBound(args);','          else if (command == "research-flush-owned-restore") result=ResearchFlushOwnedRestore(args);\n          else if (command == "store-flush-bound") result=FlushStoreDirectoryBound(args);']
 ];let result=source;for(const [before,after] of edits){if(result.split(before).length!==2)throw Error('native-research.boundary');result=result.replace(before,after);}return{source:result,originalSha256:H(source),derivedSha256:H(result),edits};
}
module.exports={transform};
