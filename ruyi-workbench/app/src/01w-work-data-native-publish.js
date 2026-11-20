// Windows NTFS manifest publication. The lifecycle host owns source validation, the
// single serve owner and managed writer exclusion. No hostile same-account namespace CAS
// or physical power-loss guarantee is claimed. Paths travel only through bounded stdin.
const WorkDataNativePublish = ((cp, path) => {
const NATIVE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
public static class RuyiManifestPublisher {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint size,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationW(string root,StringBuilder name,uint nameSize,out uint serial,out uint maxComponent,out uint flags,StringBuilder fs,uint fsSize);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileExW(string from,string to,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long distance,out long result,uint method);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] bytes,uint length,out uint read,IntPtr overlapped);
  static bool Moved=false;
  static bool Attempted=false;
  static int NativeCode=0;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=65536, RecursionLimit=16 };
  static readonly List<SafeFileHandle> Held = new List<SafeFileHandle>();
  static readonly Dictionary<string,SafeFileHandle> Directories = new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  static void Reject(string code,int native=0) { NativeCode=native; throw new InvalidOperationException(code); }
  static void Check(bool value,string code) { if(!value) Reject(code,Marshal.GetLastWin32Error()); }
  static bool Equal(string a,string b) { return String.Equals(a,b,StringComparison.OrdinalIgnoreCase); }
  static string Extended(string value) { return @"\\?\"+value; }
  static string Text(object value) { if(!(value is string)) Reject("input_invalid"); return (string)value; }
  static Dictionary<string,object> Object(object value) { var result=value as Dictionary<string,object>; if(result==null) Reject("input_invalid"); return result; }
  static void Shape(Dictionary<string,object> value,string fields) {
    string[] expected=fields.Split(','); if(value.Count!=expected.Length) Reject("input_invalid");
    foreach(string field in expected) if(!value.ContainsKey(field)) Reject("input_invalid");
  }
  static string Full(object value) {
    string name=Text(value);
    if(name.Length<3 || name.Length>8192 || name[1]!=':' || name[2]!='\\' || !Char.IsLetter(name[0]) || name.IndexOf('/')>=0) Reject("path_invalid");
    foreach(char c in name) if(c<32 || "<>\"|?*".IndexOf(c)>=0) Reject("path_invalid");
    string rest=name.Substring(3); if(rest.IndexOf(':')>=0) Reject("path_invalid");
    if(rest.Length>0) foreach(string piece in rest.Split('\\')) {
      if(piece.Length==0 || piece=="." || piece==".." || piece.EndsWith(".") || piece.EndsWith(" ")) Reject("path_invalid");
    }
    string full=Path.GetFullPath(name);
    if(!Equal(full,name)) Reject("path_invalid"); return full;
  }
  static Info Information(SafeFileHandle handle,bool directory) {
    Info info; Check(GetFileInformationByHandle(handle,out info),"identity_unavailable");
    if((info.Attr&0x400u)!=0 || ((info.Attr&0x10u)!=0)!=directory || (!directory&&info.Links!=1)) Reject("object_unsupported");
    return info;
  }
  static string Identity(SafeFileHandle handle) {
    Info info; Check(GetFileInformationByHandle(handle,out info),"identity_unavailable");
    return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
  }
  static string Final(SafeFileHandle handle,uint flags=0) {
    StringBuilder text=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(handle,text,(uint)text.Capacity,flags);
    if(length==0 || length>=text.Capacity) Reject("path_unavailable",Marshal.GetLastWin32Error());
    return text.ToString();
  }
  static string Volume(SafeFileHandle handle) {
    string final=Final(handle,1); int end=final.IndexOf(@"}\",StringComparison.Ordinal);
    if(!final.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase)||end<0) Reject("volume_unsupported");
    return final.Substring(0,end+2);
  }
  static SafeFileHandle DirectoryGuard(string name) {
    SafeFileHandle existing; if(Directories.TryGetValue(name,out existing)) return existing;
    // Deny DELETE on every ancestor, while allowing ordinary child entry updates.
    SafeFileHandle handle=CreateFileW(Extended(name),0x80u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
    if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); Reject("directory_unavailable",error); }
    Held.Add(handle); Information(handle,true);
    if(!Equal(Final(handle),Extended(name))) Reject("directory_alias");
    Directories.Add(name,handle); return handle;
  }
  static void Ancestors(string name) {
    string root=Path.GetPathRoot(name), cursor=root; DirectoryGuard(cursor);
    string rest=name.Substring(root.Length);
    if(rest.Length>0) foreach(string piece in rest.Split('\\')) { cursor=Path.Combine(cursor,piece); DirectoryGuard(cursor); }
  }
  static SafeFileHandle FileGuard(string name,bool source) {
    // DELETE sharing is required by our path-based MoveFileEx call. DATA readers/writers
    // cannot open these files during publication. This is not hostile-namespace CAS.
    SafeFileHandle handle=CreateFileW(Extended(name),source?0xC0000000u:0x80000000u,4,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
    if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); if(!source&&error==2) return null; Reject(error==32?"occupied":"file_unavailable",error); }
    Held.Add(handle); Info info=Information(handle,false);
    if(info.SizeHigh!=0 || info.SizeLow>4096) Reject("manifest_invalid");
    if(!Equal(Final(handle),Extended(name))) Reject("file_alias"); return handle;
  }
  static byte[] Read(SafeFileHandle handle) {
    long position; Check(SetFilePointerEx(handle,0,out position,0),"read_failed");
    byte[] bytes=new byte[4097]; uint read; Check(ReadFile(handle,bytes,(uint)bytes.Length,out read,IntPtr.Zero),"read_failed");
    if(read>4096) Reject("manifest_invalid"); byte[] result=new byte[read]; Buffer.BlockCopy(bytes,0,result,0,(int)read); return result;
  }
  static string Hash(byte[] bytes) { using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
  static int FlushDirectory(string directory) {
    // Capability reporting only: unsupported directory flush is never recorded as success.
    SafeFileHandle handle=CreateFileW(Extended(directory),0xC0000000u,7,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
    if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); return error; }
    using(handle) { if(!FlushFileBuffers(handle)) return Marshal.GetLastWin32Error(); return 0; }
  }
  // Separate one-shot command; the original publication input/response are unchanged.
  static Dictionary<string,object> FlushDirectories(Dictionary<string,object> input) {
    Shape(input,"flushDirectories");
    object[] raw=input["flushDirectories"] as object[];
    if(raw==null||raw.Length<1||raw.Length>256) Reject("input_invalid");
    string[] dirs=new string[raw.Length]; var unique=new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
    for(int i=0;i<raw.Length;i++) { dirs[i]=Full(raw[i]); if(unique.ContainsKey(dirs[i])) Reject("directory_duplicate"); unique.Add(dirs[i],true); }
    // Establish every real ancestor and NTFS capability before the first flush.
    foreach(string directory in dirs) { Ancestors(directory); Progress(); }
    var volumes=new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
    foreach(var directory in Directories.Values) {
      string volume=Volume(directory); if(volumes.ContainsKey(volume)) continue; volumes.Add(volume,true);
      StringBuilder volumeName=new StringBuilder(256), fsName=new StringBuilder(64); uint serial,maxComponent,flags;
      Check(GetVolumeInformationW(volume,volumeName,256,out serial,out maxComponent,out flags,fsName,64),"volume_unavailable");
      if(fsName.ToString()!="NTFS") Reject("filesystem_unsupported");
    }
    var codes=new List<int>();
    Attempted=true;
    foreach(string directory in dirs) { int code=FlushDirectory(directory); if(code!=0) Reject("durability_unsupported",code); codes.Add(code); Progress(); }
    return new Dictionary<string,object> { {"ok",true},{"flushDirectories",dirs},{"directoryFlush",codes} };
  }
  // 151 阶段 3D(W11/W12):常驻刷盘循环。只在 RunFlushLoop 里回进度行;一次性的 RunFlush/Run 协议不变。
  static bool LoopMode=false;
  static int ProgressCount=0;
  static void Progress() { if(!LoopMode) return; ProgressCount++; Console.Out.WriteLine("{\"progress\":"+ProgressCount+"}"); Console.Out.Flush(); }
  public static void RunFlushLoop() {
    var flushJson=new JavaScriptSerializer { MaxJsonLength=262144, RecursionLimit=16 };
    LoopMode=true; Console.Out.WriteLine("{\"ready\":true}"); Console.Out.Flush();
    for(;;) {
      StringBuilder input=new StringBuilder(); int value; bool over=false;
      while((value=Console.In.Read())!=-1&&value!='\n') { if(input.Length>=65536) over=true; else input.Append((char)value); }
      if(value==-1&&input.Length==0) return;
      string reply;
      try {
        if(over) Reject("input_limit");
        var response=FlushDirectories(Object(flushJson.DeserializeObject(input.ToString()))); reply=flushJson.Serialize(response);
      } catch(Exception error) {
        string code=error is InvalidOperationException ? error.Message : "native_failed";
        if(!System.Text.RegularExpressions.Regex.IsMatch(code,"^[a-z_]{1,48}$")) code="native_failed";
        reply=flushJson.Serialize(new Dictionary<string,object> { {"ok",false},{"code",code},{"native",NativeCode},{"moved",false},{"attempted",Attempted} });
      } finally {
        // Every handle of this command is closed before its reply line: an idle helper holds nothing.
        for(int i=Held.Count-1;i>=0;i--) Held[i].Dispose();
        Held.Clear(); Directories.Clear();
      }
      Attempted=false; NativeCode=0; Moved=false; ProgressCount=0;
      Console.Out.WriteLine(reply); Console.Out.Flush();
      if(value==-1) return;
    }
  }
  public static void RunFlush() {
    var flushJson=new JavaScriptSerializer { MaxJsonLength=262144, RecursionLimit=16 };
    try {
      StringBuilder input=new StringBuilder(); int value;
      while((value=Console.In.Read())!=-1&&value!='\n') { if(input.Length>=65536) Reject("input_limit"); input.Append((char)value); }
      var response=FlushDirectories(Object(flushJson.DeserializeObject(input.ToString()))); Console.Out.WriteLine(flushJson.Serialize(response));
    } catch(Exception error) {
      string code=error is InvalidOperationException ? error.Message : "native_failed";
      if(!System.Text.RegularExpressions.Regex.IsMatch(code,"^[a-z_]{1,48}$")) code="native_failed";
      Console.Out.WriteLine(flushJson.Serialize(new Dictionary<string,object> { {"ok",false},{"code",code},{"native",NativeCode},{"moved",false},{"attempted",Attempted} }));
    } finally { for(int i=Held.Count-1;i>=0;i--) Held[i].Dispose(); }
  }
  static Dictionary<string,object> Publish(Dictionary<string,object> input) {
    Shape(input,"stage,target,directory,directories");
    string stage=Full(input["stage"]), target=Full(input["target"]), control=Full(input["directory"]);
    object[] raw=input["directories"] as object[]; if(raw==null||raw.Length!=4) Reject("input_invalid");
    string[] dirs=new string[4]; for(int i=0;i<4;i++) dirs[i]=Full(raw[i]);
    string root=Path.GetDirectoryName(control), generations=Path.Combine(control,"generations");
    if(Path.GetFileName(control)!=".work-data" || !Equal(Path.GetDirectoryName(stage),control) || !Equal(target,Path.Combine(control,"active-v1.json"))
      || !Equal(dirs[1],generations) || !Equal(dirs[2],control) || !Equal(dirs[3],root)
      || !Equal(Path.GetDirectoryName(dirs[0]),generations) || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(dirs[0]),"^[a-f0-9]{48}$")
      || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(stage),"^\\.active-v1\\.stage-[a-f0-9]{48}\\.json$")) Reject("namespace_invalid");
    foreach(string directory in dirs) Ancestors(directory);
    SafeFileHandle source=FileGuard(stage,true), previous=FileGuard(target,false);
    string volume=Volume(source), sourceId=Identity(source);
    foreach(var directory in Directories.Values) if(!Equal(Volume(directory),volume)) Reject("cross_volume");
    if(previous!=null&&(!Equal(Volume(previous),volume)||Identity(previous)==sourceId)) Reject("cross_volume");
    StringBuilder volumeName=new StringBuilder(256), fsName=new StringBuilder(64); uint serial,maxComponent,flags;
    Check(GetVolumeInformationW(volume,volumeName,256,out serial,out maxComponent,out flags,fsName,64),"volume_unavailable");
    if(fsName.ToString()!="NTFS") Reject("filesystem_unsupported");
    byte[] bytes=Read(source); string expectedHash=Hash(bytes);
    var state=Object(Json.DeserializeObject(new UTF8Encoding(false,true).GetString(bytes)));
    Shape(state,"schema,generation,id,mode,activeRoot");
    string id=Text(state["id"]), mode=Text(state["mode"]);
    if(!(state["schema"] is int)||(int)state["schema"]!=1||!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{48}$")
      || (mode!="plain"&&mode!="encrypted") || Text(state["activeRoot"])!="generations/"+id || Path.GetFileName(dirs[0])!=id) Reject("manifest_invalid");
    // Generation range/type is already checked by the JS authority owner; repeat it here.
    if(!(state["generation"] is int)&&!(state["generation"] is long)&&!(state["generation"] is decimal)) Reject("manifest_invalid");
    decimal generation=Convert.ToDecimal(state["generation"]); if(generation<1||generation>9007199254740991m||Decimal.Truncate(generation)!=generation) Reject("manifest_invalid");
    Check(FlushFileBuffers(source),"source_flush_failed");
    foreach(string directory in dirs) { int failure=FlushDirectory(directory); if(failure!=0) Reject("durability_unsupported",failure); }
    if(!Equal(Final(source),Extended(stage)) || (previous!=null&&!Equal(Final(previous),Extended(target)))) Reject("identity_changed");
    // Existing target handles, even metadata-only/share-all handles, prevent this
    // tested NTFS replacement. Close only that guard after the final identity check.
    // The host's single owner still excludes managed writers; this is not CAS against
    // an unrelated process deliberately renaming the target in this narrow window.
    if(previous!=null) previous.Dispose();
    // Exactly REPLACE_EXISTING | WRITE_THROUGH. COPY_ALLOWED is deliberately absent.
    Attempted=true;
    if(!MoveFileExW(Extended(stage),Extended(target),9)) Reject("move_failed",Marshal.GetLastWin32Error());
    Moved=true;
    if(!Equal(Final(source),Extended(target))||Identity(source)!=sourceId||Hash(Read(source))!=expectedHash) Reject("published_mismatch");
    SafeFileHandle published=CreateFileW(Extended(target),0x80u,7,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
    if(published.IsInvalid) { int failure=Marshal.GetLastWin32Error(); published.Dispose(); Reject("published_unavailable",failure); }
    Held.Add(published); Information(published,false);
    if(Identity(published)!=sourceId || !Equal(Final(published),Extended(target))) Reject("published_mismatch");
    var directoryFlush=new List<int>(); foreach(string directory in dirs) { int failure=FlushDirectory(directory); directoryFlush.Add(failure); if(failure!=0) Reject("directory_flush_failed",failure); }
    return new Dictionary<string,object> { {"ok",true},{"moved",true},{"sourceFlushed",true},{"writeThrough",true},{"sameVolume",true},{"directoryFlush",directoryFlush},{"sha256",expectedHash} };
  }
  public static void Run() {
    try {
      StringBuilder input=new StringBuilder(); int value;
      while((value=Console.In.Read())!=-1&&value!='\n') { if(input.Length>=65536) Reject("input_limit"); input.Append((char)value); }
      var response=Publish(Object(Json.DeserializeObject(input.ToString()))); Console.Out.WriteLine(Json.Serialize(response));
    } catch(Exception error) {
      string code=error is InvalidOperationException ? error.Message : "native_failed";
      if(!System.Text.RegularExpressions.Regex.IsMatch(code,"^[a-z_]{1,48}$")) code="native_failed";
      Console.Out.WriteLine(Json.Serialize(new Dictionary<string,object> { {"ok",false},{"code",code},{"native",NativeCode},{"moved",Moved},{"attempted",Attempted} }));
    } finally { for(int i=Held.Count-1;i>=0;i--) Held[i].Dispose(); }
  }
}`;
const BOOTSTRAP = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RUYI_MANIFEST_PUBLISHER_SOURCE))); [RuyiManifestPublisher]::Run()";
const failure = (suffix, uncertain) => Object.assign(new Error('work_data_manifest.' + suffix), { code: 'work_data_manifest.' + suffix, apiCode: 'work_data_manifest.' + suffix, statusCode: 409, commitUncertain: uncertain });
function invoke(args) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(failure('publisher_unsupported', false));
    const serialized = JSON.stringify(args);
    if (Buffer.byteLength(serialized, 'utf8') > 65536) return reject(failure('publisher_input_limit', false));
    const windows = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = cp.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(BOOTSTRAP, 'utf16le').toString('base64')], {
      env: { ...process.env, RUYI_MANIFEST_PUBLISHER_SOURCE: Buffer.from(NATIVE).toString('base64') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.join(windows, 'System32') });
    const output = [];
    let bytes = 0, stderrBytes = 0, settled = false, spawned = false, forcedError = null, terminateTimer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminateTimer); error ? reject(error) : resolve(value); };
    const stop = error => {
      if (settled || forcedError) return;
      forcedError = error;
      // Do not hand control back while this helper still owns source/parent guards.
      // A failed OS termination must leave the host's migration gate blocked.
      terminateTimer = setTimeout(() => { error.helperMayStillRun = true; finish(error); }, 2000);
      try { child.kill(); } catch { /* wait for close or keep the host blocked at the deadline */ }
    };
    const timer = setTimeout(() => stop(failure('publisher_timeout', true)), 20000);
    child.once('spawn', () => { spawned = true; });
    child.on('error', () => {
      // ChildProcess also emits error when kill fails. Only a failed spawn with no
      // process identity can prove that no native helper owns filesystem guards.
      if (!spawned && !child.pid && !forcedError) finish(failure('publisher_unavailable', false));
      else stop(failure('publisher_process', true));
    });
    child.stdout.on('data', chunk => {
      if (forcedError) return;
      bytes += chunk.length;
      if (bytes > 8192) { stop(failure('publisher_output_limit', true)); return; }
      output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', chunk => { if (forcedError) return; stderrBytes += chunk.length; if (stderrBytes > 8192) stop(failure('publisher_output_limit', true)); });
    // Pipe faults are transport failures, not proof that the native helper stopped.
    // stop() keeps the host gate blocked until close or the termination deadline.
    child.stdout.on('error', () => stop(failure('publisher_pipe', true)));
    child.stderr.on('error', () => stop(failure('publisher_pipe', true)));
    child.on('close', code => {
      if (settled) return;
      if (forcedError) { finish(forcedError); return; }
      let response; try { response = JSON.parse(Buffer.concat(output, bytes).toString('utf8')); } catch { finish(failure('publisher_unverifiable', true)); return; }
      if (code !== 0 || !response || typeof response.ok !== 'boolean') { finish(failure('publisher_unverifiable', true)); return; }
      if (!response.ok) {
        if (Object.keys(response).sort().join(',') !== 'attempted,code,moved,native,ok' || typeof response.moved !== 'boolean' || typeof response.attempted !== 'boolean'
          || !Number.isInteger(response.native) || response.native < 0 || response.moved && !response.attempted) { finish(failure('publisher_unverifiable', true)); return; }
        const suffix = typeof response.code === 'string' && /^[a-z_]{1,48}$/.test(response.code) ? response.code : 'native_failed';
        const error = failure('publisher_' + suffix, response.attempted === true); error.nativeCode = response.native; finish(error); return;
      }
      if (Object.keys(response).sort().join(',') !== 'directoryFlush,moved,ok,sameVolume,sha256,sourceFlushed,writeThrough' || response.moved !== true || response.sourceFlushed !== true || response.writeThrough !== true || response.sameVolume !== true
        || !Array.isArray(response.directoryFlush) || response.directoryFlush.length !== 4 || response.directoryFlush.some(value => value !== 0)
        || typeof response.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(response.sha256)) { finish(failure('publisher_unverifiable', true)); return; }
      finish(null, response);
    });
    child.stdin.on('error', () => stop(failure('publisher_pipe', true)));
    child.stdin.end(serialized + '\n');
  });
}

// 151 阶段 3D(150 号文 W11/W12):刷盘助手常驻。原来每次 flush 都新起一个 PowerShell 并用 Add-Type 现场编译
// 本模块的 C#(约 0.7–1 s),一次启用要刷十几到几十次。现在一个进程里只编译一次,之后按行收命令;
// 每条命令在 C# 里先释放本命令持有的全部句柄,再回结果行(RunFlushLoop),所以两条命令之间助手不持有任何句柄。
// 空闲 FLUSH_IDLE_MS 后关 stdin 让它自行退出;空闲期间子进程与管道都 unref,不拖住宿主退出(宿主退出即 EOF)。
// 失败语义不变:超时/管道/输出不可验证 → 杀掉并等关闭,关不掉就 helperMayStillRun;带类型的拒绝 → 先让助手
// 正常退出(等到 close)再报 nativeSettled,与原来「助手进程已结束」的含义一致。
// 超时与进度解耦(W12):助手每完成一个目录的祖先守卫或刷盘就回一行 {"progress":n};FLUSH_STALL_MS 是
// 「多久没有任何进展」而不是一条命令的总时长。编译(第一次就绪)单独给 FLUSH_START_MS。
const FLUSH_LOOP_BOOTSTRAP = BOOTSTRAP.replace('[RuyiManifestPublisher]::Run()', '[RuyiManifestPublisher]::RunFlushLoop()');
const FLUSH_START_MS = 60000, FLUSH_STALL_MS = 20000, FLUSH_IDLE_MS = 15000, FLUSH_CLOSE_MS = 2000, FLUSH_LINE_LIMIT = 262144;
const flushFailure = (suffix, uncertain = false) => Object.assign(failure('flush_' + suffix, uncertain), {
  retry:false, operationMayHaveExecuted:uncertain, resultUnavailable:uncertain,
});
const flushStats = { spawned:0, commands:0 };
let flushHelper = null, flushQueue = Promise.resolve();
function flushSelect(directories) {
  if (!Array.isArray(directories) || directories.length < 1 || directories.length > 256) throw flushFailure('input_invalid');
  const selected = [], unique = new Set();
  for (const directory of directories) {
    if (typeof directory !== 'string' || directory.length < 3 || directory.length > 8192 || !/^[A-Za-z]:\\/.test(directory)
      || /[\x00-\x1f<>"|?*\/]/.test(directory) || directory.slice(2).includes(':') || Buffer.from(directory).toString('utf8') !== directory
      || path.win32.resolve(directory) !== directory || directory.slice(3).split('\\').some(piece => piece === '.' || piece === '..' || /[. ]$/.test(piece))
      || directory.length > 3 && directory.endsWith('\\') || unique.has(directory.toLowerCase())) throw flushFailure('input_invalid');
    unique.add(directory.toLowerCase()); selected.push(directory);
  }
  const serialized = JSON.stringify({flushDirectories:selected});
  if (Buffer.byteLength(serialized,'utf8') > 65536) throw flushFailure('input_limit');
  return { selected, serialized };
}
// One helper process. All events of the child are bound once; the current command (if any) receives them.
function flushSpawn() {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child = cp.spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(FLUSH_LOOP_BOOTSTRAP,'utf16le').toString('base64')], {
    env:{...process.env,RUYI_MANIFEST_PUBLISHER_SOURCE:Buffer.from(NATIVE).toString('base64')},windowsHide:true,stdio:['pipe','pipe','pipe'],
    // v2(审查 L3):常驻助手空闲时也活着,不能占住宿主的当前目录(否则那个目录改名会 EBUSY)。
    cwd:path.join(process.env.SystemRoot || 'C:\\Windows','System32'),
  });
  flushStats.spawned++;
  const helper = { child, spawned:false, ready:false, dead:false, closed:false, closeCode:null, command:null, idleTimer:null, lineParts:[], lineBytes:0,
    stderrBytes:0, closeWaiters:[], waitingReady:[] };
  const setRef = on => { for (const target of [child, child.stdin, child.stdout, child.stderr]) { try { on ? target?.ref?.() : target?.unref?.(); } catch { /* optional */ } } };
  helper.setRef = setRef;
  const current = () => helper.command;
  child.once('spawn',() => { helper.spawned = true; });
  child.on('error',() => {
    // ChildProcess also emits error when kill fails. Only a failed spawn with no process
    // identity can prove that no native helper ever existed.
    if (!helper.spawned && !child.pid) { helper.dead = true; helper.closed = true; for (const waiter of helper.waitingReady.splice(0)) waiter.fail(flushFailure('unavailable')); current()?.unavailable(); return; }
    flushRetire(helper); current()?.stop(flushFailure('process',true));
    for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('process',true));
  });
  child.stdout.on('data',chunk => {
    let start = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, start)) {
      flushLinePart(helper, chunk.subarray(start, at)); if (helper.lineBytes > FLUSH_LINE_LIMIT) return flushOverflow(helper);
      const raw = Buffer.concat(helper.lineParts, helper.lineBytes); for (const part of helper.lineParts) part.fill(0); helper.lineParts = []; helper.lineBytes = 0;
      flushLine(helper, raw); raw.fill(0); start = at + 1;
    }
    if (start < chunk.length) { flushLinePart(helper, chunk.subarray(start)); if (helper.lineBytes > FLUSH_LINE_LIMIT) flushOverflow(helper); }
  });
  child.stderr.on('data',chunk => { helper.stderrBytes += chunk.length; if (helper.stderrBytes > 8192) { flushRetire(helper); current()?.stop(flushFailure('output_limit',true)); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('output_limit',true)); } });
  // Pipe faults are transport failures, not proof that the native helper stopped.
  child.stdout.on('error',() => { flushRetire(helper); current()?.stop(flushFailure('pipe',true)); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('pipe',true)); });
  child.stderr.on('error',() => { flushRetire(helper); current()?.stop(flushFailure('pipe',true)); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('pipe',true)); });
  child.stdin.on('error',() => { flushRetire(helper); current()?.stop(flushFailure('pipe',true)); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('pipe',true)); });
  child.on('close',code => {
    helper.closed = true; helper.closeCode = code; flushRetire(helper);
    for (const waiter of helper.closeWaiters.splice(0)) waiter(code);
    for (const waiter of helper.waitingReady.splice(0)) waiter.closed();
    current()?.closed(code);
  });
  return helper;
}
function flushLinePart(helper, part) { helper.lineBytes += part.length; if (helper.lineBytes <= FLUSH_LINE_LIMIT) helper.lineParts.push(Buffer.from(part)); }
function flushOverflow(helper) {
  for (const part of helper.lineParts) part.fill(0); helper.lineParts = []; helper.lineBytes = FLUSH_LINE_LIMIT + 1;
  flushRetire(helper); helper.command?.stop(flushFailure('output_limit',true));
  for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('output_limit',true));
}
// A retired helper never receives another command; a new one is spawned for the next flush.
function flushRetire(helper) { helper.dead = true; if (flushHelper === helper) flushHelper = null; if (helper.idleTimer) { clearTimeout(helper.idleTimer); helper.idleTimer = null; } }
function flushLine(helper, raw) {
  let response;
  try {
    const bytes = raw.length && raw[raw.length - 1] === 13 ? raw.subarray(0, raw.length - 1) : raw, text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Error('utf8');
    response = JSON.parse(text);
  }
  catch { flushRetire(helper); helper.command?.stop(flushFailure('unverifiable',true)); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('unverifiable',true)); return; }
  if (!helper.ready) {
    if (Object.keys(response || {}).sort().join(',') !== 'ready' || response.ready !== true) { flushRetire(helper); for (const waiter of helper.waitingReady.splice(0)) waiter.stop(flushFailure('unverifiable',true)); return; }
    helper.ready = true; for (const waiter of helper.waitingReady.splice(0)) waiter.ready(); return;
  }
  const command = helper.command;
  if (!command) { flushRetire(helper); return; } // Unsolicited output: never trust this helper again.
  if (response && Object.keys(response).sort().join(',') === 'progress' && Number.isSafeInteger(response.progress) && response.progress > command.progress && response.progress <= 2 * command.selected.length) {
    command.progress = response.progress; command.renew(); return;
  }
  command.reply(response);
}
function flushReady(helper) {
  return new Promise((resolve, reject) => {
    if (helper.ready) return resolve();
    let settled = false, killTimer = null;
    const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); error ? reject(error) : resolve(); };
    const waiter = {
      ready:() => done(),
      fail:error => done(error),
      // The helper has not received any path yet: a confirmed close proves nothing ran.
      closed:() => done(flushFailure('unavailable')),
      stop:error => { if (settled) return; flushRetire(helper); killTimer = setTimeout(() => { error.helperMayStillRun = true; done(error); }, FLUSH_CLOSE_MS);
        helper.closeWaiters.push(() => done(flushFailure('unavailable'))); try { helper.child.kill(); } catch { /* wait for close or the deadline */ } },
    };
    helper.waitingReady.push(waiter);
    const timer = setTimeout(() => waiter.stop(flushFailure('timeout',true)), FLUSH_START_MS);
    if (helper.closed) waiter.closed();
  });
}
function flushCommand(helper, selected, serialized) {
  return new Promise((resolve, reject) => {
    let settled = false, forcedError = null, terminateTimer = null, timer = null, attemptedClose = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminateTimer);
      if (helper.command === command) helper.command = null;
      error ? reject(error) : resolve(value);
    };
    const stop = error => {
      if (settled || forcedError) return; forcedError = error; flushRetire(helper); clearTimeout(timer);
      // Same ownership rule as publication: kill failure cannot release the host gate.
      terminateTimer = setTimeout(() => { error.helperMayStillRun = true; finish(error); }, FLUSH_CLOSE_MS);
      if (helper.closed) return finish(error);
      try { helper.child.kill(); } catch { /* Wait for close or report a possibly live helper. */ }
    };
    const command = {
      selected, progress:0,
      renew() { if (settled || forcedError) return; clearTimeout(timer); timer = setTimeout(() => stop(flushFailure('timeout',true)), FLUSH_STALL_MS); },
      stop, unavailable:() => finish(flushFailure('unavailable')),
      closed(code) {
        if (settled) return; if (forcedError) return finish(forcedError);
        if (attemptedClose) return; // reply() owns a refusal's close.
        finish(flushFailure('unverifiable',true));
      },
      reply(response) {
        if (settled || forcedError) return;
        if (!response || typeof response.ok !== 'boolean') return stop(flushFailure('unverifiable',true));
        if (!response.ok) {
          if (Object.keys(response).sort().join(',') !== 'attempted,code,moved,native,ok' || response.moved !== false || typeof response.attempted !== 'boolean'
            || !Number.isInteger(response.native) || response.native < 0 || typeof response.code !== 'string' || !/^[a-z_]{1,48}$/.test(response.code)) return stop(flushFailure('unverifiable',true));
          // 151 阶段 3A(150 号文 W8):助手已经正常收尾并回了一份带类型的拒绝。flush 命令只开句柄、调
          // FlushFileBuffers,从不改名字空间,所以这类拒绝是「确定没做成」而不是「可能做了一半」:
          // nativeSettled 只说助手进程已结束,flushRefusal 只是原生码的复述,二者都不授予任何权限。
          // 常驻助手(3D):先让它正常退出并等到 close,nativeSettled 的含义保持不变。
          const error = flushFailure(response.code,response.attempted); error.nativeCode = response.native;
          attemptedClose = true; flushRetire(helper); clearTimeout(timer);
          terminateTimer = setTimeout(() => { error.helperMayStillRun = true; finish(error); }, FLUSH_CLOSE_MS);
          const settle = code => { if (code === 0) { error.nativeSettled = true; error.flushRefusal = response.code; finish(error); } else { stop(flushFailure('unverifiable',true)); } };
          if (helper.closed) return settle(helper.closeCode);
          helper.closeWaiters.push(settle);
          try { helper.child.stdin.end(); } catch { stop(flushFailure('pipe',true)); }
          return;
        }
        if (Object.keys(response).sort().join(',') !== 'directoryFlush,flushDirectories,ok'
          || !Array.isArray(response.flushDirectories) || response.flushDirectories.length !== selected.length || response.flushDirectories.some((directory,index) => directory !== selected[index])
          || !Array.isArray(response.directoryFlush) || response.directoryFlush.length !== selected.length || response.directoryFlush.some(code => code !== 0)) return stop(flushFailure('unverifiable',true));
        finish(null,Object.freeze({ok:true,flushDirectories:Object.freeze(response.flushDirectories),directoryFlush:Object.freeze(response.directoryFlush)}));
      },
    };
    helper.command = command; flushStats.commands++;
    command.renew();
    try { helper.child.stdin.write(serialized + '\n', error => { if (error) stop(flushFailure('pipe',true)); }); } catch { stop(flushFailure('pipe',true)); }
  });
}
async function flushRun(selected, serialized) {
  let helper = flushHelper && !flushHelper.dead && !flushHelper.closed ? flushHelper : null;
  if (helper && helper.idleTimer) { clearTimeout(helper.idleTimer); helper.idleTimer = null; }
  if (!helper) {
    try { helper = flushSpawn(); } catch { throw flushFailure('unavailable'); }
    flushHelper = helper;
  }
  // v3(审查 R2-2):从选中/新起助手到这条命令结束,助手都标为占用;驻留期在此期间结束时,释放方跳过被占用的
  // 助手,由这里的 finally 在命令结束后按当时的驻留状态收尾。
  helper.reserved = (helper.reserved || 0) + 1;
  try {
    helper.setRef(true);
    await flushReady(helper);
    if (helper.dead || helper.closed) throw flushFailure('unavailable');
    return await flushCommand(helper, selected, serialized);
  } finally {
    helper.reserved--;
    if (flushHelper === helper && !helper.dead && !helper.closed && !helper.command && helper.reserved < 1) flushIdle(helper);
  }
}
// v2:常驻只在显式的驻留期内(冷端维护操作用 holdResident() 包住整次操作)。驻留期外每条命令做完就让助手正常
// 退出,与原来「一次一进程」的进程形状一致:普通 serve 不会多出一个空闲 15 s 的子进程(进程审计、进程谱系夹具
// 都看得到它)。驻留期结束时空闲的助手立即退出。
let residentHolds = 0;
function flushIdle(helper) {
  if (residentHolds < 1) { flushRetire(helper); try { helper.child.stdin.end(); } catch { /* exiting */ } return; }
  helper.setRef(false);
  helper.idleTimer = setTimeout(() => { helper.idleTimer = null; flushRetire(helper); try { helper.child.stdin.end(); } catch { /* exiting */ } }, FLUSH_IDLE_MS);
  helper.idleTimer.unref?.();
}
function holdResident() {
  residentHolds++; let released = false;
  return () => {
    if (released) return; released = true; residentHolds = Math.max(0, residentHolds - 1);
    const helper = flushHelper;
    if (residentHolds < 1 && helper && !helper.dead && !helper.closed && !helper.command && !(helper.reserved > 0)) {
      if (helper.idleTimer) { clearTimeout(helper.idleTimer); helper.idleTimer = null; }
      flushIdle(helper);
    }
  };
}
function invokeFlush(directories) {
  if (process.platform !== 'win32') return Promise.reject(flushFailure('unsupported'));
  let request;
  try { request = flushSelect(directories); } catch (error) { return Promise.reject(error); }
  // Commands are serialized: one helper runs one command at a time; a failure retires it.
  const run = () => flushRun(request.selected, request.serialized);
  const result = flushQueue.then(run, run);
  flushQueue = result.catch(() => {});
  return result;
}

// 151 阶段 3A(W8):把一次 flush 失败归成「卷不支持」「刷盘被拒」或「不确定」。只认本模块自己发出的、
// 助手已正常结束的那一种形状;超时、管道错误、输出不可验证、助手可能仍在跑的,一律 uncertain。
// 返回值只用于挑选给人看的稳定码,不改变任何调用方的失败语义。
const UNSUPPORTED_VOLUME = new Set(['filesystem_unsupported', 'volume_unsupported']);
function classifyFlushFailure(error) {
  try {
    if (!error || typeof error !== 'object') return 'uncertain';
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value, settled = Object.getOwnPropertyDescriptor(error, 'nativeSettled')?.value;
    const refusal = Object.getOwnPropertyDescriptor(error, 'flushRefusal')?.value, helper = Object.getOwnPropertyDescriptor(error, 'helperMayStillRun')?.value;
    if (settled !== true || helper === true || typeof refusal !== 'string' || code !== 'work_data_manifest.flush_' + refusal) return 'uncertain';
    return UNSUPPORTED_VOLUME.has(refusal) ? 'volume_unsupported' : 'refused';
  } catch { return 'uncertain'; }
}

  return Object.freeze({ create: () => invoke, createFlush: () => invokeFlush, classifyFlushFailure, flushStats: () => Object.freeze({ ...flushStats }), holdResident,
    // 一次刷盘的合法时长上界(起助手 + 停滞 + 关闭),13ai 的 arm 上限由它推出。
    FLUSH_BOUND_MS: FLUSH_START_MS + FLUSH_STALL_MS + FLUSH_CLOSE_MS });
})(require('node:child_process'), require('node:path'));

if (process.platform === 'win32') WorkDataManifest.Hooks.publish = WorkDataNativePublish.create();
