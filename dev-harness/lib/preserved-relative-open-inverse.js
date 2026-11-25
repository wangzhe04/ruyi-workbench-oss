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

// bc5ee425 extends the earlier stage-retirement method and its call sites to
// handle committed source directories. Restore the exact 9a9cf068 method first
// so the existing inverse still verifies its original method and dispatch.
function removeCommittedSourceRetirement(native) {
  const marker = '  static object RetirePortableStage(Dictionary<string,object> args, bool committedSource=false)';
  const method = pinnedNativeMethod(native, marker,
    'd4d1be2def885cff96e062613401df6af3f4639ce5f6873c2d55aeb4c80c9b51', 'committed-source retirement method');
  const file = require('node:path').join(__dirname, '../fixtures/pre-p1-portable-stage-retirement.txt');
  const previousMethod = require('node:fs').readFileSync(file, 'utf8').replace(/\n$/, '');
  const dispatch = [
    '          else if(command=="retire-committed-source") {',
    '            if(!firstCommand)Reject("portable_retire_scope");',
    '            result=RetirePortableStage(args,true);',
    '          }', '',
  ].join('\n');
  for (const [current, previous] of [
    [method, previousMethod],
    [dispatch, ''],
    ['  static bool RetiringCommittedSource = false;\n', ''],
    ['      if(RetiringCommittedSource)access=dataStream ? 0x80000100u : 0x80010100u;\n', ''],
    ['uint share = RetiringCommittedSource ? (dataStream ? 5u : 1u) : RetiringPortableStage',
      'uint share = RetiringPortableStage'],
    ['if(RetiringPortableStage && !RetiringCommittedSource && streamName!="")',
      'if(RetiringPortableStage && streamName!="")'],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique committed-source retirement change');
    native = native.replace(current, () => previous);
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

// 151 阶段 3D(150 号文 W11/W12): native heartbeat lines ({"progress":n} at most once per second inside the
// command loop) and the hash-only verification census (content="hash"). Exact reviewed inverse.
function removeNativeHeartbeatAndHashOnly(native) {
  const loopBeat = ' { Beat();';
  assert.equal(native.split(loopBeat).length - 1, 14, 'native heartbeat loop points');
  native = native.split(loopBeat).join(' {');
  const beatBlock = [
    '  // 151 阶段 3D(150 号文 W12):长命令心跳。距上一行超过 1 s 才写一行 {"progress":n};Node 端只用它给「这条命令',
    '  // 还在推进」续期,不改变任何回复的形状或判定。n 是本进程里推进点的累计数(单调递增)。',
    '  static readonly System.Diagnostics.Stopwatch BeatClock = System.Diagnostics.Stopwatch.StartNew();',
    '  static long BeatCount = 0;',
    '  static bool BeatEnabled = false;',
    '  static void Beat() { BeatCount++; if (!BeatEnabled || BeatClock.ElapsedMilliseconds < 1000) return; BeatClock.Restart(); Console.Out.WriteLine("{\\"progress\\":" + BeatCount + "}"); Console.Out.Flush(); }',
    ''].join('\n');
  const hashOnlyBlock = [
    '  // 151 阶段 3D(150 号文 W11):只为复核的普查(content="hash")不回传内容,只回每个流的大小与 SHA-256;',
    '  // 句柄、元数据、整树复读与哈希核对与带内容的普查完全相同。只由 Node 端只读复核路径请求。',
    '  static bool HashOnly=false;',
    ''].join('\n');
  const hashOnlyArgs = [
    '    object content=null;HashOnly=args.TryGetValue("content",out content)&&content is string&&(string)content=="hash";',
    '    if(content!=null&&!HashOnly)Reject("census_content");',
    ''].join('\n');
  for (const [current, previous] of [
    [beatBlock, ''],
    ['      Beat(); byte[] buffer = new byte[Math.Min(65536, result.Length - used)]; uint got;', '      byte[] buffer = new byte[Math.Min(65536, result.Length - used)]; uint got;'],
    ['      Beat(); byte[] buffer = new byte[Math.Min(65536, bytes.Length - offset)];', '      byte[] buffer = new byte[Math.Min(65536, bytes.Length - offset)];'],
    ['    path=NativePath(path); Beat();\n', '    path=NativePath(path);\n'],
    ['          if (HashOnly) { AddTransport(192 + JsonBytes(streamName)); streams.Add(new Dictionary<string,object> { { "name", streamName }, { "size", bytes.Length }, { "hash", Hash(bytes) } }); }\n'
      + '          else { AddTransport(192 + JsonBytes(streamName) + 4L * ((bytes.Length + 2) / 3));\n          streams.Add(',
      '          AddTransport(192 + JsonBytes(streamName) + 4L * ((bytes.Length + 2) / 3));\n          streams.Add('],
    ['{ "hash", Hash(bytes) }, { "data", Convert.ToBase64String(bytes) } }); }', '{ "hash", Hash(bytes) }, { "data", Convert.ToBase64String(bytes) } });'],
    [hashOnlyBlock, ''],
    [hashOnlyArgs, ''],
    ['finally {PreserveTimeHandles=previous;HashOnly=false;}}', 'finally {PreserveTimeHandles=previous;}}'],
    ['Console.OutputEncoding = new UTF8Encoding(false); BeatEnabled = true;', 'Console.OutputEncoding = new UTF8Encoding(false);'],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique native heartbeat/hash-only change');
    native = native.replace(current, previous);
  }
  return native;
}

// 150 W3: the data-root census budget (entries/bytes/file/transport/depth with
// typed census_*_limit refusals, areas, and the MaxJsonLength reply guard)
// replaced the fixed 10,000-entry / 96,000,000-byte native caps. Exact reviewed inverse.
function removeNativeCensusBudget(native) {
  for (const [current, previous] of [
    ["  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 251658240, RecursionLimit = 512 };",
      "  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 180000000, RecursionLimit = 512 };"],
    ["  // Capsule caps by default (per stream and total 96,000,000 bytes, 10,000\n  // entries). A data-root census (args budget \"data-root\") uses\n  // WorkDataTree.NATIVE_BUDGET (01aa): 200,001 entries, 120 MiB total, one\n  // response line of at most 240 MiB UTF-8 bytes. MaxBytes stays per stream.\n  static long MaxBytes = 96000000, TotalBytes, MaxTotal = 96000000, Transport, MaxTransport = 251658240 - 1048576;\n  static int MaxEntries = 10000;\n  static bool DataRootBudget = false;\n  static void ApplyBudget(Dictionary<string,object> args) {\n    object raw; DataRootBudget = args.TryGetValue(\"budget\", out raw) && raw is string && (string)raw == \"data-root\";\n    MaxEntries = DataRootBudget ? 200001 : 10000; MaxTotal = DataRootBudget ? 125829120 : 96000000; Transport = 0;\n  }\n  static void ResetBudget() { DataRootBudget = false; MaxEntries = 10000; MaxTotal = 96000000; Transport = 0; Areas.Clear(); }\n  // Data-root census only: entries/bytes per top-level area seen so far, sent\n  // with a census_*_limit refusal (the Node side maps names to product areas).\n  static readonly Dictionary<string,long[]> Areas = new Dictionary<string,long[]>(StringComparer.OrdinalIgnoreCase);\n  static string AreaOf(string rel) {\n    if (rel == \"\") return \"\";\n    string[] parts = rel.Split('/');\n    if (String.Equals(parts[0], \".work-data\", StringComparison.OrdinalIgnoreCase))\n      return parts.Length >= 4 && String.Equals(parts[1], \"generations\", StringComparison.OrdinalIgnoreCase) ? parts[3] : \".work-data\";\n    return parts[0];\n  }\n  static void AreaAdd(string rel, long entries, long bytes) {\n    if (!DataRootBudget) return; string area = AreaOf(rel); if (area == \"\") return;\n    long[] value; if (!Areas.TryGetValue(area, out value)) { value = new long[2]; Areas.Add(area, value); } value[0] += entries; value[1] += bytes;\n  }\n  sealed class BudgetException : InvalidOperationException { public readonly List<object> AreaRows; public BudgetException(string code, List<object> rows) : base(code) { AreaRows = rows; } }\n  static void BudgetReject(string code) {\n    List<KeyValuePair<string,long[]>> pairs = new List<KeyValuePair<string,long[]>>(Areas);\n    pairs.Sort((a, b) => b.Value[1] != a.Value[1] ? b.Value[1].CompareTo(a.Value[1]) : b.Value[0].CompareTo(a.Value[0]));\n    List<object> rows = new List<object>();\n    for (int i = 0; i < pairs.Count && i < 16; i++) rows.Add(new Dictionary<string,object> { { \"area\", pairs[i].Key }, { \"entries\", pairs[i].Value[0] }, { \"bytes\", pairs[i].Value[1] } });\n    throw new BudgetException(code, rows);\n  }\n  // Conservative UTF-8 size of one JSON string: escaped and non-ASCII chars\n  // count 6 bytes (a six-character escape, >= their UTF-8 size), so Node's byte line limit and\n  // MaxJsonLength (chars) both hold whenever this estimate does.\n  static long JsonBytes(string value) { long n = 2; foreach (char c in value) n += c < 0x20 || c == '\"' || c == '\\\\' || c == '<' || c == '>' || c == '&' || c == '\\'' || c >= 0x80 ? 6 : 1; return n; }\n  static void AddTransport(long bytes) { Transport += bytes; if (Transport > MaxTransport) { if (DataRootBudget) BudgetReject(\"census_transport_limit\"); Reject(\"archive_limit\"); } }",
      "  static long MaxBytes = 96000000, TotalBytes;"],
    ["        long size = BitConverter.ToInt64(header, 8);\n        if (DataRootBudget && size > MaxBytes) BudgetReject(\"census_file_limit\");",
      "        long size = BitConverter.ToInt64(header, 8);"],
    ["            if(children.Count>=MaxEntries){if(DataRootBudget)BudgetReject(\"census_entries_limit\");Reject(\"directory_census\");}\n            if(String.IsNullOrEmpty(name)||name.IndexOfAny(new char[]{'\\\\','/',':','\\0'})>=0)Reject(\"directory_census\");",
      "            if(String.IsNullOrEmpty(name)||name.IndexOfAny(new char[]{'\\\\','/',':','\\0'})>=0||children.Count>=10000)Reject(\"directory_census\");"],
    ["    if (entries.Count >= MaxEntries) { if (DataRootBudget) { AreaAdd(rel, 1, 0); BudgetReject(\"census_entries_limit\"); } Reject(\"archive_limit\"); }\n    if (rel.Split('/').Length > 256) { if (DataRootBudget) BudgetReject(\"census_depth_limit\"); Reject(\"archive_limit\"); }",
      "    if (entries.Count >= 10000 || rel.Split('/').Length > 256) Reject(\"archive_limit\");"],
    ["      Nodes.Add(id, node); entries.Add(node.Entry);\n      if (capture) { AreaAdd(rel, 1, 0); AddTransport(512 + JsonBytes(rel) + JsonBytes(Str(node.Entry[\"shortName\"]))); }",
      "      Nodes.Add(id, node); entries.Add(node.Entry);"],
    ["          if (DataRootBudget) {\n            long size; Check(GetFileSizeEx(handle, out size));\n            if (size > MaxBytes) { AreaAdd(rel, 0, size); BudgetReject(\"census_file_limit\"); }\n            if (TotalBytes + size > MaxTotal) { AreaAdd(rel, 0, size); BudgetReject(\"census_bytes_limit\"); }\n          }\n          byte[] bytes = Read(handle); TotalBytes += bytes.Length; AreaAdd(rel, 0, bytes.Length);\n          if (TotalBytes > MaxTotal) { if (DataRootBudget) BudgetReject(\"census_bytes_limit\"); Reject(\"archive_limit\"); }\n          AddTransport(192 + JsonBytes(streamName) + 4L * ((bytes.Length + 2) / 3));",
      "          byte[] bytes = Read(handle); TotalBytes += bytes.Length;\n          if (TotalBytes > MaxBytes) Reject(\"archive_limit\");"],
    ["    if (Nodes.Count != 0) Reject(\"already_open\"); TotalBytes = 0; ApplyBudget(args);\n    List<object> entries = new List<object>(); try { Walk(Str(args[\"root\"]), \"\", entries, true, preserved); } finally { ResetBudget(); }",
      "    if (Nodes.Count != 0) Reject(\"already_open\"); TotalBytes = 0;\n    List<object> entries = new List<object>(); Walk(Str(args[\"root\"]), \"\", entries, true, preserved);"],
    ["          string reply = null;\n          try { reply = Json.Serialize(new Dictionary<string,object> { { \"ok\", true }, { \"value\", result } }); } catch (InvalidOperationException) { reply = null; }\n          result = null; if (reply == null) Reject(\"census_transport_limit\");\n          Console.WriteLine(reply);",
      "          Console.WriteLine(Json.Serialize(new Dictionary<string,object> { { \"ok\", true }, { \"value\", result } }));"],
    ["          var failureRow=new Dictionary<string,object> { { \"ok\", false }, { \"code\", code } }; if(error is BudgetException)failureRow.Add(\"areas\",((BudgetException)error).AreaRows); if(code==\"census_first_close_unverified\" && error.InnerException!=null) {var inner=error.InnerException;string safe=inner is Win32Exception?\"native_win32_\"+((Win32Exception)inner).NativeErrorCode:inner is InvalidOperationException?inner.Message:\"native_failure\";if(System.Text.RegularExpressions.Regex.IsMatch(safe,\"^[a-z0-9_]{1,128}$\"))failureRow.Add(\"primaryCode\",safe);} Console.WriteLine(Json.Serialize(failureRow));",
      "          var failureRow=new Dictionary<string,object> { { \"ok\", false }, { \"code\", code } }; if(code==\"census_first_close_unverified\" && error.InnerException!=null) {var inner=error.InnerException;string safe=inner is Win32Exception?\"native_win32_\"+((Win32Exception)inner).NativeErrorCode:inner is InvalidOperationException?inner.Message:\"native_failure\";if(System.Text.RegularExpressions.Regex.IsMatch(safe,\"^[a-z0-9_]{1,128}$\"))failureRow.Add(\"primaryCode\",safe);} Console.WriteLine(Json.Serialize(failureRow));"],
  ]) {
    assert.equal(native.split(current).length, 2, 'unique native census budget change');
    native = native.replace(current, previous);
  }
  return native;
}

function restorePreRelativeOpenNative(native) {
  for (const undo of [
    removeCommittedSourceRetirement,
    removeNativeHeartbeatAndHashOnly,
    removeNativeCensusBudget,
    removeForwardPlainPublication,
    removePreservedCloseCertification,
    removePortableBasicPublication,
    removePortableMoveParentReceipt,
    removePortableStageRetirement,
    removePreservedRelativeOpen,
  ]) native = undo(native);
  return native;
}

module.exports = { removeCommittedSourceRetirement, removeNativeCensusBudget, removeForwardPlainPublication, removePortableBasicPublication, removePortableMoveAncestorReceipt, removePortableMoveParentReceipt, removePortableStageRetirement, removePreservedCloseCertification, removePreservedRelativeOpen, restorePreRelativeOpenNative };
