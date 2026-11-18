'use strict';
// Read-only phase trace on synthetic owner. No guard or data-dependent flow changes.
const path=require('node:path'),crypto=require('node:crypto'),H=x=>crypto.createHash('sha256').update(x).digest('hex');
function transform(source,file){if(!path.isAbsolute(file)||file.includes('"'))throw Error('trace.path');
 const inject=`  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  static void ResearchRootPhase(string stage) {
    try { Node root=null;foreach(Node n in Nodes.Values)if(n.Entry!=null && Str(n.Entry["rel"])==""){root=n;break;}if(root==null)return;
      Basic actual=BasicOf(root.Handle);var times=new List<string>();foreach(object raw in (IEnumerable)root.Entry["times"])times.Add(Str(raw));var fields=new List<string>();
      if(times.Count!=4)fields.Add("times.shape");else {if(Str(actual.Creation)!=times[0])fields.Add("time.creation");if(Str(actual.Access)!=times[1])fields.Add("time.access");if(Str(actual.Write)!=times[2])fields.Add("time.write");if(Str(actual.Change)!=times[3])fields.Add("time.change");}if(actual.Attr!=Convert.ToUInt32(root.Entry["attrs"]))fields.Add("attrs");
      var row=new Dictionary<string,object>{{"pid",GetCurrentProcessId()},{"stage",stage},{"path",""},{"fields",fields}};System.IO.File.AppendAllText(${JSON.stringify(file)},Json.Serialize(row)+Environment.NewLine);
    }catch{} // Trace failure never changes the real operation or its rejection.
  }
`;
 const edits=[
 ['  static void Walk(string path, string rel, List<object> entries, bool capture) {',inject+'  static void Walk(string path, string rel, List<object> entries, bool capture) {'],
 ['      Nodes.Add(id, node); entries.Add(node.Entry);','      Nodes.Add(id, node); entries.Add(node.Entry); ResearchRootPhase("entry-added");'],
 ['      foreach (string name in StreamNames(node)) {\n        if (directory && name == "") Reject("directory_data");','      ResearchRootPhase("before-walk-streams"); List<string> walkStreams=StreamNames(node); ResearchRootPhase("after-walk-streams"); foreach (string name in walkStreams) {\n        if (directory && name == "") Reject("directory_data");'],
 ['          byte[] bytes = Read(handle); TotalBytes += bytes.Length;','          ResearchRootPhase("before-walk-read"); byte[] bytes = Read(handle); ResearchRootPhase("after-walk-read"); TotalBytes += bytes.Length;'],
 ['      if (!directory && !StreamNames(node).Contains("")) Reject("default_stream_missing");','      if (!directory) { ResearchRootPhase("before-walk-stream-recheck"); bool hasDefault=StreamNames(node).Contains(""); ResearchRootPhase("after-walk-stream-recheck"); if(!hasDefault) Reject("default_stream_missing"); }'],
 ['    VerifyEntries(expected);\n    foreach (Node node in expected) {','    ResearchRootPhase("before-verify-entries"); VerifyEntries(expected); ResearchRootPhase("after-verify-entries");\n    foreach (Node node in expected) {'],
 ['      List<string> current = StreamNames(node), names = new List<string>();','      ResearchRootPhase("before-verify-streams"); List<string> current = StreamNames(node), names = new List<string>(); ResearchRootPhase("after-verify-streams");'],
 ['          byte[] bytes = Read(handle); if (Hash(bytes) != Str(stream["hash"])) Reject("content_changed"); Array.Clear(bytes, 0, bytes.Length);','          ResearchRootPhase("before-verify-read"); byte[] bytes = Read(handle); ResearchRootPhase("after-verify-read"); if (Hash(bytes) != Str(stream["hash"])) Reject("content_changed"); Array.Clear(bytes, 0, bytes.Length);'],
 ['      if (directory) foreach (string child in DirectoryChildren(node.Handle,path)) Walk(child, rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child), entries, capture);', '      if (directory) { ResearchRootPhase("before-enumeration"); string[] children=DirectoryChildren(node.Handle,path); ResearchRootPhase("after-enumeration"); foreach (string child in children) { ResearchRootPhase("before-child"); Walk(child, rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child), entries, capture); ResearchRootPhase("after-child"); } }'],
 ['    StringBuilder filesystem = new StringBuilder(64); uint serial, component, flags;','    ResearchRootPhase("after-walk"); StringBuilder filesystem = new StringBuilder(64); uint serial, component, flags;'],
 ['    if (filesystem.ToString() != "NTFS") Reject("filesystem_unsupported");','    ResearchRootPhase("after-volume"); if (filesystem.ToString() != "NTFS") Reject("filesystem_unsupported");'],
 ['    VerifyOriginalLayout(); Verify(false, true); return Snapshot;','    ResearchRootPhase("before-layout"); VerifyOriginalLayout(); ResearchRootPhase("after-layout"); Verify(false, true); ResearchRootPhase("after-verify"); return Snapshot;'],
 ['      try {VerifyCapturedBasicUnchanged(new List<Node>(Nodes.Values));}','      try {ResearchRootPhase("before-guard");VerifyCapturedBasicUnchanged(new List<Node>(Nodes.Values));}']
 ];let out=source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('trace.boundary '+a.slice(0,55));out=out.replace(a,b);}return{source:out,originalSha256:H(source),derivedSha256:H(out),edits};
}
module.exports={transform};
