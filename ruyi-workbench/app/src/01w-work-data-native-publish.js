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
    foreach(string directory in dirs) Ancestors(directory);
    var volumes=new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
    foreach(var directory in Directories.Values) {
      string volume=Volume(directory); if(volumes.ContainsKey(volume)) continue; volumes.Add(volume,true);
      StringBuilder volumeName=new StringBuilder(256), fsName=new StringBuilder(64); uint serial,maxComponent,flags;
      Check(GetVolumeInformationW(volume,volumeName,256,out serial,out maxComponent,out flags,fsName,64),"volume_unavailable");
      if(fsName.ToString()!="NTFS") Reject("filesystem_unsupported");
    }
    var codes=new List<int>();
    Attempted=true;
    foreach(string directory in dirs) { int code=FlushDirectory(directory); if(code!=0) Reject("durability_unsupported",code); codes.Add(code); }
    return new Dictionary<string,object> { {"ok",true},{"flushDirectories",dirs},{"directoryFlush",codes} };
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
      env: { ...process.env, RUYI_MANIFEST_PUBLISHER_SOURCE: Buffer.from(NATIVE).toString('base64') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

const FLUSH_BOOTSTRAP = BOOTSTRAP.replace('[RuyiManifestPublisher]::Run()', '[RuyiManifestPublisher]::RunFlush()');
const flushFailure = (suffix, uncertain = false) => Object.assign(failure('flush_' + suffix, uncertain), {
  retry:false, operationMayHaveExecuted:uncertain, resultUnavailable:uncertain,
});
function invokeFlush(directories) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(flushFailure('unsupported'));
    if (!Array.isArray(directories) || directories.length < 1 || directories.length > 256) return reject(flushFailure('input_invalid'));
    const selected = [], unique = new Set();
    for (const directory of directories) {
      if (typeof directory !== 'string' || directory.length < 3 || directory.length > 8192 || !/^[A-Za-z]:\\/.test(directory)
        || /[\x00-\x1f<>"|?*\/]/.test(directory) || directory.slice(2).includes(':') || Buffer.from(directory).toString('utf8') !== directory
        || path.win32.resolve(directory) !== directory || directory.slice(3).split('\\').some(piece => piece === '.' || piece === '..' || /[. ]$/.test(piece))
        || directory.length > 3 && directory.endsWith('\\') || unique.has(directory.toLowerCase())) return reject(flushFailure('input_invalid'));
      unique.add(directory.toLowerCase()); selected.push(directory);
    }
    const serialized = JSON.stringify({flushDirectories:selected});
    if (Buffer.byteLength(serialized,'utf8') > 65536) return reject(flushFailure('input_limit'));
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    let child;
    try { child = cp.spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(FLUSH_BOOTSTRAP,'utf16le').toString('base64')], {
      env:{...process.env,RUYI_MANIFEST_PUBLISHER_SOURCE:Buffer.from(NATIVE).toString('base64')},windowsHide:true,stdio:['pipe','pipe','pipe'],
    }); } catch { return reject(flushFailure('unavailable')); }
    const output = [];
    let bytes = 0, stderrBytes = 0, settled = false, spawned = false, forcedError = null, terminateTimer;
    const finish = (error,value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminateTimer);
      for (const part of output) part.fill(0); output.length = 0;
      error ? reject(error) : resolve(value);
    };
    const stop = error => {
      if (settled || forcedError) return; forcedError = error;
      // Same ownership rule as publication: kill failure cannot release the host gate.
      terminateTimer = setTimeout(() => {error.helperMayStillRun = true;finish(error);},2000);
      try {child.kill();} catch { /* Wait for close or report a possibly live helper. */ }
    };
    const timer = setTimeout(() => stop(flushFailure('timeout',true)),20000);
    child.once('spawn',() => {spawned = true;});
    child.on('error',() => {
      if (!spawned && !child.pid && !forcedError) finish(flushFailure('unavailable'));
      else stop(flushFailure('process',true));
    });
    child.stdout.on('data',chunk => {
      if (settled || forcedError) return; bytes += chunk.length;
      if (bytes > 262144) return stop(flushFailure('output_limit',true));
      output.push(Buffer.from(chunk));
    });
    child.stderr.on('data',chunk => {if (!settled && !forcedError) {stderrBytes += chunk.length;if (stderrBytes > 8192) stop(flushFailure('output_limit',true));}});
    child.stdout.on('error',() => stop(flushFailure('pipe',true)));
    child.stderr.on('error',() => stop(flushFailure('pipe',true)));
    child.on('close',code => {
      if (settled) return; if (forcedError) return finish(forcedError);
      let response, raw;
      try {raw = Buffer.concat(output,bytes);const text = raw.toString('utf8');if (!Buffer.from(text).equals(raw)) throw Error('utf8');response = JSON.parse(text);}
      catch {return finish(flushFailure('unverifiable',true));} finally {raw?.fill(0);}
      if (code !== 0 || !response || typeof response.ok !== 'boolean') return finish(flushFailure('unverifiable',true));
      if (!response.ok) {
        if (Object.keys(response).sort().join(',') !== 'attempted,code,moved,native,ok' || response.moved !== false || typeof response.attempted !== 'boolean'
          || !Number.isInteger(response.native) || response.native < 0 || typeof response.code !== 'string' || !/^[a-z_]{1,48}$/.test(response.code)) return finish(flushFailure('unverifiable',true));
        const error = flushFailure(response.code,response.attempted);error.nativeCode = response.native;return finish(error);
      }
      if (Object.keys(response).sort().join(',') !== 'directoryFlush,flushDirectories,ok'
        || !Array.isArray(response.flushDirectories) || response.flushDirectories.length !== selected.length || response.flushDirectories.some((directory,index) => directory !== selected[index])
        || !Array.isArray(response.directoryFlush) || response.directoryFlush.length !== selected.length || response.directoryFlush.some(code => code !== 0)) return finish(flushFailure('unverifiable',true));
      finish(null,Object.freeze({ok:true,flushDirectories:Object.freeze(response.flushDirectories),directoryFlush:Object.freeze(response.directoryFlush)}));
    });
    child.stdin.on('error',() => stop(flushFailure('pipe',true)));
    try {child.stdin.end(serialized + '\n');} catch {stop(flushFailure('pipe',true));}
  });
}

  return Object.freeze({ create: () => invoke, createFlush: () => invokeFlush });
})(require('node:child_process'), require('node:path'));

if (process.platform === 'win32') WorkDataManifest.Hooks.publish = WorkDataNativePublish.create();
