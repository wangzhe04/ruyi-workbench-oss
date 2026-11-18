'use strict';
// Development transform; do not load into production before review and native tests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const native=require('./owned-candidate-native-research-v3.cjs');
function transform(source){
 const base=native.transform(source),fragment=fs.readFileSync(path.join(__dirname,'owned-candidate-source-boundary-research.csfrag'),'utf8');
 const allocator=fs.readFileSync(path.join(__dirname,'owned-candidate-allocator-research.jsfrag'),'utf8');
 const edits=[
  ['  static object ResearchCandidateClose(Dictionary<string,object> args) {ResearchCandidateAuth(args);foreach(var h in ResearchCandidateHandles.Values)h.Dispose();ResearchCandidateHandles.Clear();ResearchCandidateIds.Clear();ResearchCandidateBase=null;ResearchCandidateRoot=null;ResearchCandidateToken=null;ResearchAnchorParts=null;ResearchAnchorIds=null;return new Dictionary<string,object>{{"closed",true}};}',
   '  static object ResearchCandidateClose(Dictionary<string,object> args) {ResearchCandidateAuth(args);var addresses=new HashSet<IntPtr>();foreach(var h in ResearchCandidateHandles.Values){if(h.IsClosed||h.IsInvalid||!addresses.Add(h.DangerousGetHandle()))Reject("census_first_close_unverified");}foreach(var h in ResearchCandidateHandles.Values){try{h.Dispose();}catch{Reject("census_first_close_unverified");}}foreach(IntPtr address in addresses){uint flags;if(GetHandleInformation(address,out flags)||Marshal.GetLastWin32Error()!=6)Reject("census_first_close_unverified");}ResearchCandidateHandles.Clear();ResearchCandidateIds.Clear();ResearchCandidateBase=null;ResearchCandidateRoot=null;ResearchCandidateToken=null;ResearchAnchorParts=null;ResearchAnchorIds=null;return new Dictionary<string,object>{{"closed",true}};}'],
  ['  static void Walk(string path, string rel, List<object> entries, bool capture) {',fragment+'\n  static void Walk(string path, string rel, List<object> entries, bool capture) {'],
  ['      string id = Id(node.Handle); if (Nodes.ContainsKey(id)) Reject("object_duplicate");','      string id = Id(node.Handle); BoundaryParent(rel,node.Handle); if (Nodes.ContainsKey(id)) Reject("object_duplicate");'],
  ['      if (directory) foreach (string child in DirectoryChildren(node.Handle,path)) Walk(child, rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child), entries, capture);',
   '      if (directory) foreach (string child in DirectoryChildren(node.Handle,path)) { string childRel=rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child); if(!BoundaryChild(node,child,childRel))Walk(child,childRel,entries,capture); }'],
  ['        if (!paths.Contains(child)) Reject("entry_set_changed");','        if (!paths.Contains(child) && !BoundaryContains(child)) Reject("entry_set_changed");'],
  ['    try {return Capture(args);}','    try {BoundaryInit(args);return Capture(args);}'],
  ['      finally {PreserveTimeHandles=previous;}\n    }\n  }\n  static object ReadPreservedControl',
   '      finally {try {BoundaryClose(primary==null);} catch(Exception closeError) {if(BoundaryHandle!=null || closeError.Message=="census_first_close_unverified")throw new InvalidOperationException("census_first_close_unverified",primary??closeError);throw;} finally {PreserveTimeHandles=previous;}}\n    }\n  }\n  static object ReadPreservedControl'],
  ['{{"revision",Str(args["revision"])},{"closedHandles",closedHandles},{"snapshot",snapshot}};',
   '{{"revision",Str(args["revision"])},{"closedHandles",closedHandles+(args.ContainsKey("candidateBoundary")?1:0)},{"snapshot",snapshot}};'],
  ["  if(paired&&!WorkDataTree.claimPreservedReadback(readback,root,revision))migrationCapsuleFail('census_scope');",
   "  const readbackContext=paired?(typeof WorkDataTree.claimPreservedReadbackContext==='function'?WorkDataTree.claimPreservedReadbackContext(readback,root,revision):(WorkDataTree.claimPreservedReadback(readback,root,revision)?{candidateBoundary:null}:null)):null;\n  if(paired&&!readbackContext)migrationCapsuleFail('census_scope');\n  const candidateBoundary=readbackContext?.candidateBoundary||null;"],
  ["    try{first=await broker.command({cmd:'capture-preserved-census-first',root,revision});}",
   "    try{first=await broker.command({cmd:'capture-preserved-census-first',root,revision,...(candidateBoundary?{candidateBoundary}:{})});}"],
  ["      ||first.closedHandles!==first.snapshot.entries.reduce((total,row)=>total+1+row.streams.filter(stream=>stream.name!=='').length,0))throw unverified();",
   "      ||first.closedHandles!==first.snapshot.entries.reduce((total,row)=>total+1+row.streams.filter(stream=>stream.name!=='').length,0)+(candidateBoundary?1:0))throw unverified();"],
  ["    final=await broker.command({cmd:'capture-preserved-census-final',root,firstRevision:revision,revision:finalRevision});",
   "    try{final=await broker.command({cmd:'capture-preserved-census-final',root,firstRevision:revision,revision:finalRevision,...(candidateBoundary?{candidateBoundary}:{})});}catch(cause){if(cause?.code==='work_data_backup.census_first_close_unverified')throw unverified(cause);throw cause;}"],
  ['const migrationCapsuleIssuedChildren = new Set();','const migrationCapsuleIssuedChildren = new Set(), migrationCapsuleBrokerChildren = new WeakMap();'],
  ['  migrationCapsuleIssuedChildren.add(child);','  migrationCapsuleIssuedChildren.add(child);const candidateChildObservation={child,closeObserved:false,closeCode:null,closeSignal:null};child.once(\'close\',(code,signal)=>{candidateChildObservation.closeObserved=true;candidateChildObservation.closeCode=code;candidateChildObservation.closeSignal=signal;});'],
  ['  return Object.freeze({ command, close });','  const issuedBroker=Object.freeze({ command, close });migrationCapsuleBrokerChildren.set(issuedBroker,candidateChildObservation);return issuedBroker;'],
  ['          Console.WriteLine(Json.Serialize(new Dictionary<string,object> { { "ok", false }, { "code", code } }));',
   '          var failureRow=new Dictionary<string,object> { { "ok", false }, { "code", code } }; if(code=="census_first_close_unverified" && error.InnerException!=null) {var inner=error.InnerException;string safe=inner is Win32Exception?"native_win32_"+((Win32Exception)inner).NativeErrorCode:inner is InvalidOperationException?inner.Message:"native_failure";if(System.Text.RegularExpressions.Regex.IsMatch(safe,"^[a-z0-9_]{1,128}$"))failureRow.Add("primaryCode",safe);} Console.WriteLine(Json.Serialize(failureRow));'],
  ["          const error = failure(suffix); firstError ||= error; entry.reject(error);",
   "          const primarySuffix=/^[a-z0-9_]{1,128}$/.test(response?.primaryCode||'')?response.primaryCode:null;const error = failure(suffix,primarySuffix?failure(primarySuffix):undefined); firstError ||= error; entry.reject(error);"],
  ['async function migrationCapsuleCapturePreserved(root, revision, readback) {',allocator+'\nasync function migrationCapsuleCapturePreserved(root, revision, readback) {']
 ];
 let out=base.source;for(const [a,b] of edits){if(out.split(a).length!==2)throw Error('boundary.transform');out=out.replace(a,b);}return {source:out,edits:[...base.edits,...edits],sha256:crypto.createHash('sha256').update(out).digest('hex')};
}
module.exports={transform};
