'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { bracedBlock } = require('./source-slice');

function pinnedNativeMethod(native, marker, sha256, label) {
  assert.equal(native.split(marker).length, 2, 'unique ' + label);
  const block = bracedBlock(native, marker);
  assert.equal(createHash('sha256').update(block).digest('hex'), sha256, 'reviewed ' + label);
  return block;
}

function removeForwardPlainPublication(native) {
  const method = pinnedNativeMethod(native, '  static void Publish(',
    '72728574aa4685b2258d5cd1017ac29e678373fe9aa3ba0281df882a964d23bd', 'forward plain publication');
  let original = method;
  for (const [current, previous] of [
    [[
      '    object exactOption;',
      '    if(args.TryGetValue("publishExactBasic",out exactOption)&&!(exactOption is bool))Reject("portable_publication_scope");',
      '    bool publishExactBasic=exactOption is bool&&(bool)exactOption;',
      '',
    ].join('\n'), ''],
    ['    string error=null,parentId=null,target=Str(args["target"]);', '    string error=null;'],
    ['      string name=System.IO.Path.GetFileName(target),parentPath=System.IO.Path.GetDirectoryName(target);',
      '      string name=System.IO.Path.GetFileName(Str(args["target"]));'],
    [[
      '      using(SafeFileHandle parent=Open(parentPath)) {',
      '        if(publishExactBasic) {',
      '          StoreFileSystem(parent);',
      '          parentId=CandidateDirectoryId(parent);',
      '          CheckPortableBasicGuard(parent,NativePath(parentPath),parentId);',
      '        }',
      '        Rename(root,name,parent);',
      '      }',
    ].join('\n'), '      using(SafeFileHandle parent=Open(System.IO.Path.GetDirectoryName(Str(args["target"])))) Rename(root,name,parent);'],
    [[
      '    VerifyNames(target,true);',
      '    if(!publishExactBasic){RestoreBasic(Expected());return;}',
      '    // Preserve the authorized output after the rename/read handles settle.',
      '    // The original authenticated record still dictates all Basic values.',
      '    var wanted=Snapshot;',
      '    var readArgs=new Dictionary<string,object>{{"root",target},{"revision",Str(wanted["revision"])}};',
      '    PublishOwnedPortableBasic(target,parentId,readArgs,wanted);',
      '    VerifyPortableReadback(wanted,Dict(CapturePreserved(readArgs)));',
      '    Close(true);',
    ].join('\n'), '    VerifyNames(Str(args["target"]),true);RestoreBasic(Expected());'],
  ]) {
    assert.equal(original.split(current).length, 2, 'unique forward plain publication change');
    original = original.replace(current, previous);
  }
  assert.equal(native.split(method).length, 2, 'unique reviewed forward plain publication');
  return native.replace(method, original);
}

function removePreservedCloseCertification(native) {
  const edits = [
    ['      if(BoundaryHandle!=null){ClosePreservedTemporary(BoundaryHandle);BoundaryHandle=null;}}', [
      '      if(BoundaryHandle!=null){IntPtr value=BoundaryHandle.DangerousGetHandle();try{BoundaryHandle.Dispose();}catch{Reject("census_first_close_unverified");}BoundaryHandle=null;uint flags;',
      '        if(GetHandleInformation(value,out flags)||Marshal.GetLastWin32Error()!=6)Reject("census_first_close_unverified");}}',
    ].join('\n')],
    [[
      '    // Certify the kernel close of this still-owned object. A later query of its',
      '    // numeric value can see a different object after Windows recycles the slot.',
      '    if (!CloseHandle(handle.DangerousGetHandle())) Reject("census_first_close_unverified");',
      '    handle.SetHandleAsInvalid();',
      '    if (!handle.IsClosed) Reject("census_first_close_unverified");',
    ].join('\n'), [
      '    IntPtr value = handle.DangerousGetHandle();',
      '    handle.Dispose();',
      '    uint flags;',
      '    if (!handle.IsClosed || GetHandleInformation(value, out flags) || Marshal.GetLastWin32Error() != 6)',
      '      Reject("census_first_close_unverified");',
    ].join('\n')],
    [[
      '  static void Close(bool certify = false) {',
      '    foreach (Node node in Nodes.Values) {',
      '      foreach (SafeFileHandle stream in node.Streams.Values) {',
      '        if(certify)ClosePreservedTemporary(stream);else stream.Dispose();',
      '      }',
      '      if(certify)ClosePreservedTemporary(node.Handle);else node.Handle.Dispose();',
      '    }',
    ].join('\n'), [
      '  static void Close() {',
      '    foreach (Node node in Nodes.Values) { foreach (SafeFileHandle stream in node.Streams.Values) stream.Dispose(); node.Handle.Dispose(); }',
    ].join('\n')],
    ['  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);\n', ''],
    ['      Close(true);TotalBytes=0;', '      Close();TotalBytes=0;'],
    ['      foreach(SafeFileHandle handle in handles)if(!handle.IsClosed)Reject("census_first_close_unverified");', [
      '      foreach(SafeFileHandle handle in handles)if(!handle.IsClosed)Reject("census_first_close_unverified");',
      '      foreach(IntPtr address in addresses) {uint flags;if(GetHandleInformation(address,out flags) || Marshal.GetLastWin32Error()!=6)Reject("census_first_close_unverified");}',
    ].join('\n')],
  ];
  for (const [current, previous] of edits) {
    assert.equal(native.split(current).length, 2, 'unique preserved close certification change');
    native = native.replace(current, previous);
  }
  return native;
}

function removePortableBasicPublication(native) {
  const check = pinnedNativeMethod(native, '  static void CheckPortableBasicGuard(',
    '8d4677d9d56aca6cfa079892ebdc26beb6da514d7fdd932d57354a0fed83b748', 'portable Basic guard check');
  const open = pinnedNativeMethod(native, '  static SafeFileHandle OpenPortableBasicGuard(',
    '0a847e1e842560d60344ec3cf9d15fa116c6eae5eb56d1b2b118ad46a71f65c4', 'portable Basic guard open');
  const publish = pinnedNativeMethod(native, '  static void PublishOwnedPortableBasic(',
    '91e63497d1e5d8af0294b0730a0f8ce1ad7bea412d11d68e90445d08f521ad48', 'portable Basic publication');
  for (const [current, previous] of [
    [check + '\n', ''],
    [open + '\n', ''],
    [publish + '\n', ''],
    ['Dictionary<string,object> actual,bool compareBasic=true) {', 'Dictionary<string,object> actual) {'],
    ['(bool)entry["dir"]!=(bool)expected["dir"]\n        || compareBasic && Convert.ToUInt32(entry["attrs"])',
      '(bool)entry["dir"]!=(bool)expected["dir"] || Convert.ToUInt32(entry["attrs"])'],
    ['for(int index=0;compareBasic && index<4;index++)', 'for(int index=0;index<4;index++)'],
    ['string parentRoot=System.IO.Path.GetDirectoryName(root),parentId;using(SafeFileHandle parent=Open(parentRoot)) {',
      'string parentRoot=System.IO.Path.GetDirectoryName(root);using(SafeFileHandle parent=Open(parentRoot)) {'],
    ['      parentId=Id(parent);\n', ''],
    [[
      '    foreach(Node node in Expected())if((bool)node.Entry["dir"])FlushStoreDirectory(PathOf(node.Handle));FlushStoreDirectory(parentRoot);',
      '    Dictionary<string,object> wanted=Snapshot;',
      '    var readArgs=new Dictionary<string,object>{{"root",root},{"revision",revision}};',
      '    PublishOwnedPortableBasic(root,parentId,readArgs,wanted);',
      '    Dictionary<string,object> observed=Dict(CapturePreserved(readArgs));',
    ].join('\n'), [
      '    // Enumeration and every auxiliary flush handle finish before the final',
      '    // metadata application. Suppressed primary/stream handles cannot overwrite',
      '    // restored Basic values on close. Reopen and inspect actual objects/bytes.',
      '    foreach(Node node in Expected())if((bool)node.Entry["dir"])FlushStoreDirectory(PathOf(node.Handle));FlushStoreDirectory(parentRoot);',
      '    RestoreBasic(Expected());Dictionary<string,object> wanted=Snapshot;Close();',
      '    Dictionary<string,object> observed=Dict(CapturePreserved(new Dictionary<string,object>{{"root",root},{"revision",revision}}));',
    ].join('\n')],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique portable Basic publication change');
    native = native.replace(current, previous);
  }
  return native;
}

function removePortableMoveParentReceipt(native) {
  native = removePortableMoveAncestorReceipt(native);
  const check = pinnedNativeMethod(native, '  static void CheckPortableMoveParent(',
    '1e17e3eaedd1389f76485069224fc8838a350af499bef90088e391a34cab6d43', 'portable move parent check');
  const open = pinnedNativeMethod(native, '  static SafeFileHandle OpenPortableMoveParent(',
    '33820d323f366320ef2aaec1ccbb5a80fc33a1410d09f286a9fc3c74c71296af', 'portable move parent open');
  const receipt = [
    '      var receipt=new Dictionary<string,object>{{"id",Id(original)},{"volume",VolumeOf(original)}};',
    '      if(stageParent!=null) {',
    '        CheckPortableMoveParent(stageParent,fromParent,Str(args["stageParentId"]));',
    '        Basic post=BasicOf(stageParent);',
    '        receipt.Add("stageParent",new Dictionary<string,object>{{"id",Id(stageParent)},{"root",fromParent},',
    '          {"times",new string[]{Str(post.Creation),Str(post.Access),Str(post.Write),Str(post.Change)}}});',
    '      }',
    '      return receipt;',
  ].join('\n');
  for (const [current, previous] of [
    [check + '\n', ''],
    [open + '\n', ''],
    ['    using(var original=Open(source)) using(var parent=Open(toParent))\n'
      + '    using(var stageParent=OpenPortableMoveParent(args,fromParent)) {',
    '    using(var original=Open(source)) using(var parent=Open(toParent)) {'],
    [receipt, '      return new Dictionary<string,object>{{"id",Id(original)},{"volume",VolumeOf(original)}};'],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique portable move parent receipt addition');
    native = native.replace(current, previous);
  }
  return native;
}

function removePortableMoveAncestorReceipt(native) {
  const held = pinnedNativeMethod(native, '  static SafeFileHandle HoldPortableMoveDirectory(',
    'd85f22f58b70af6de76ebdcdb5d97d909ef845c9dc182182485764f3d57f8dd7', 'portable move held directory');
  const ancestors = pinnedNativeMethod(native, '  static List<SafeFileHandle> OpenPortableMoveAncestors(',
    '7f652c302bae4fd898e2bd14a6ba130e59859219ff367059528b9125d1de6b08', 'portable move ancestors');
  const witnesses = [
    '        var witnesses=new List<object>();string cursor=fromParent;int index=0;',
    '        foreach(var handle in stageAncestors) {',
    '          cursor=System.IO.Path.GetDirectoryName(cursor);',
    '          string id=Str(((object[])args["stageAncestorIds"])[index++]);',
    '          CheckPortableMoveParent(handle,cursor,id);',
    '          Basic basic=BasicOf(handle);',
    '          witnesses.Add(new Dictionary<string,object>{{"id",id},{"root",cursor},',
    '            {"times",new string[]{Str(basic.Creation),Str(basic.Access),Str(basic.Write),Str(basic.Change)}}});',
    '        }',
    '        receipt.Add("stageAncestors",witnesses);',
    '',
  ].join('\n');
  const previousOpen = [
    '    var handle=OpenPreservedHandle(null,null,NativePath(path),0x00100180u,3);',
    '    try {',
    '      PreserveHandleTimes(handle);',
    '      CheckPortableMoveParent(handle,path,(string)id);',
    '      return handle;',
    '    }catch{handle.Dispose();throw;}',
    '  }',
    '',
  ].join('\n');
  for (const [current, previous] of [
    ['      var stageAncestors=OpenPortableMoveAncestors(args,fromParent);\n      try {\n', ''],
    [witnesses, ''],
    ['      }finally{foreach(var handle in stageAncestors)handle.Dispose();}\n', ''],
    ['    return HoldPortableMoveDirectory(path,(string)id);\n  }\n' + held + '\n', previousOpen],
    [ancestors + '\n', ''],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique portable move ancestor receipt change');
    native = native.replace(current, previous);
  }
  return native;
}

function removePortableStageRetirement(native) {
  const dispatch = [
    '          else if (command == "retire-portable-stage") {',
    '            if(!firstCommand)Reject("portable_retire_scope");',
    '            result=RetirePortableStage(args);',
    '          }',
    '',
  ].join('\n');
  // This pin covers the reviewed addition before the historical pins cover the remainder.
  const block = pinnedNativeMethod(native, '  static object RetirePortableStage(Dictionary<string,object> args)',
    'a70173d16f3f17c57d28b6ed7b1ea57d7302920a5e9f679bdf986f5e90f9c73d',
    'portable-stage retirement method');
  for (const [current, previous] of [
    [block + '\n\n', ''],
    [dispatch, ''],
    ['  static bool RetiringPortableStage = false;\n', ''],
    ['      uint share = RetiringPortableStage ? 0u : directory ? 6u : 5u;', '      uint share = directory ? 6u : 5u;'],
    ['        if(RetiringPortableStage && streamName!="")Reject("portable_retire_named_stream");\n', ''],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique portable-stage retirement addition');
    native = native.replace(current, previous);
  }
  return native;
}

// Undo the M3 access-path changes before comparing with historical source pins.
function removePreservedRelativeOpen(native) {
  const removeBlock = (startMarker, endMarker) => {
    const start = native.indexOf(startMarker);
    const end = native.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    native = native.slice(0, start) + native.slice(end);
  };
  if (native.includes('  static void BoundaryInit(')) {
    removeBlock('  // Private source/output boundary.', '  static SafeFileHandle OpenPreservedRelative(');
    removeBlock('  // Atomically create the private generation', '  static object Capture(Dictionary');
    const boundaryFinally = '      finally {try {BoundaryClose(primary==null);} catch(Exception closeError) {if(BoundaryHandle!=null || closeError.Message=="census_first_close_unverified")throw new InvalidOperationException("census_first_close_unverified",primary??closeError);throw;} finally {PreserveTimeHandles=previous;}}';
    const edits = [
      [' BoundaryParent(rel,node.Handle);', ''],
      ['        string childRelative = rel == "" ? childName : rel + "/" + childName;\n        if (!BoundaryChild(node, child, childRelative)) Walk(child, childRelative,', '        Walk(child, rel == "" ? childName : rel + "/" + childName,'],
      ['if (!paths.Contains(child) && !BoundaryContains(child))', 'if (!paths.Contains(child))'],
      ['try {BoundaryInit(args);return Capture(args,true);}', 'try {return Capture(args,true);}'],
      [boundaryFinally, '      finally {PreserveTimeHandles=previous;}'],
      ['closedHandles+(args.ContainsKey("candidateBoundary")?1:0)', 'closedHandles'],
      ['          if (command == "candidate-allocation-start") result=CandidateAllocationStart(args);\n          else if (command == "candidate-allocation-close") result=CandidateAllocationClose(args);\n          else if (command == "store-info")', '          if (command == "store-info")'],
    ];
    const failure = native.split('\n').find(line => line.includes('var failureRow=new Dictionary<string,object>'));
    assert.ok(failure);
    edits.push([failure, '          Console.WriteLine(Json.Serialize(new Dictionary<string,object> { { "ok", false }, { "code", code } }));']);
    for (const [current, previous] of edits) {
      assert.equal(native.split(current).length, 2, current);
      native = native.replace(current, previous);
    }
  }
  const start = native.indexOf('  static SafeFileHandle OpenPreservedRelative(');
  const walk = native.indexOf('  static void Walk(', start);
  assert.ok(start >= 0 && walk > start);
  let prior = native.slice(0, start) + native.slice(walk);
  const streamOpen = [
    '        SafeFileHandle handle = node.Handle;',
    '        if (streamName != "") {',
    '          string streamPath = PathOf(node.Handle) + streamName;',
    '          handle = preserved ? OpenPreserved(parent, name + streamName, streamPath, true, out writable) : Open(streamPath, out writable, true);',
    '          node.Streams.Add(streamName, handle);',
    '          if (!writable) node.ReadOnlyStreams.Add(streamName);',
    '        }',
  ].join('\n');
  const recurse = [
    '      if (directory) foreach (string child in DirectoryChildren(node.Handle,path)) {',
    '        string childName = System.IO.Path.GetFileName(child);',
    '        Walk(child, rel == "" ? childName : rel + "/" + childName, entries, capture, preserved, node.Handle, childName);',
    '      }',
  ].join('\n');
  for (const [current, previous] of [
    [', bool capture, bool preserved = false, SafeFileHandle parent = null, string name = null)', ', bool capture)'],
    ['Node node = new Node();\n    node.Handle = preserved ? OpenPreserved(parent, name, path, false, out node.Writable) : Open(path, out node.Writable);',
      'Node node = new Node(); node.Handle = Open(path, out node.Writable);'],
    [streamOpen, '        SafeFileHandle handle = name == "" ? node.Handle : Open(PathOf(node.Handle) + name, out writable, true);\n'
      + '        if (name != "") { node.Streams.Add(name, handle); if (!writable) node.ReadOnlyStreams.Add(name); }'],
    ['foreach (string streamName in StreamNames(node))', 'foreach (string name in StreamNames(node))'],
    ['if (directory && streamName == "")', 'if (directory && name == "")'],
    ['{ "name", streamName }, { "size", bytes.Length }', '{ "name", name }, { "size", bytes.Length }'],
    [recurse, '      if (directory) foreach (string child in DirectoryChildren(node.Handle,path)) Walk(child, rel == "" ? System.IO.Path.GetFileName(child) : rel + "/" + System.IO.Path.GetFileName(child), entries, capture);'],
    ['static object Capture(Dictionary<string,object> args, bool preserved = false)', 'static object Capture(Dictionary<string,object> args)'],
    ['Walk(Str(args["root"]), "", entries, true, preserved);', 'Walk(Str(args["root"]), "", entries, true);'],
    ['try {return Capture(args,true);}', 'try {return Capture(args);}'],
  ]) {
    assert.equal(prior.split(current).length, 2);
    prior = prior.replace(current, previous);
  }
  return prior;
}

function restorePreRelativeOpenNative(native) {
  for (const undo of [
    removeForwardPlainPublication,
    removePreservedCloseCertification,
    removePortableBasicPublication,
    removePortableMoveParentReceipt,
    removePortableStageRetirement,
    removePreservedRelativeOpen,
  ]) native = undo(native);
  return native;
}

module.exports = { removeForwardPlainPublication, removePortableBasicPublication, removePortableMoveAncestorReceipt, removePortableMoveParentReceipt, removePortableStageRetirement, removePreservedCloseCertification, removePreservedRelativeOpen, restorePreRelativeOpenNative };
