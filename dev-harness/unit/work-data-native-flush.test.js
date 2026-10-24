'use strict';
// VM transport/shape tests only. No PowerShell, native API, actual fsync or data root.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.RUYI_NATIVE_PUBLISH_SOURCE||path.resolve(__dirname,'../../ruyi-workbench/app/src/01w-work-data-native-publish.js'),'utf8');
const dirs=['C:\\owned\\nested','C:\\owned'];
const success=values=>({ok:true,flushDirectories:[...values],directoryFlush:values.map(()=>0)});
function fixture({mode='no-close',text=source,platform='win32'}={}){
 const timers=new Set(),child=new EventEmitter(),calls=[];child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 let packet,settled=false;child.stdin.end=text=>{packet=JSON.parse(text);};child.kill=()=>{calls.push('kill');if(mode==='kill-throws')throw Object.freeze(Error('foreign kill'));if(mode==='kill-error')child.emit('error',Error('foreign kill'));if(mode==='kill-closes')queueMicrotask(()=>child.emit('close',1));return false;};
 const api=vm.runInNewContext(text+'\nWorkDataNativePublish;',{Buffer,Set,process:{platform,env:{SystemRoot:'C:\\Windows'}},WorkDataManifest:{Hooks:{}},
  require:name=>name==='node:child_process'?{spawn:(...args)=>{calls.push(args);if(mode==='spawn-throws')throw Error('foreign spawn');return child;}}:require(name),
  setTimeout:(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},clearTimeout:timer=>timers.delete(timer)});
 const flush=values=>{const promise=api.createFlush()(values);promise.then(()=>{settled=true;},()=>{settled=true;});return promise;};
 return {api,child,calls,timers,flush,packet:()=>packet,settled:()=>settled,spawn:()=>{child.pid=123;child.emit('spawn');},
  fire:ms=>{const timer=[...timers].find(row=>row.ms===ms);assert.ok(timer);timers.delete(timer);timer.fn();},
  complete:(value,code=0)=>{child.stdout.emit('data',Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)));child.emit('close',code);}};
}
const tick=()=>Promise.resolve().then(()=>Promise.resolve());

test('flush validates 1..256 distinct canonical Windows directories before helper creation',async()=>{
 for(const values of [[],{},null,new Array(1),Array(257).fill('C:\\owned'),['relative'],['C:relative'],['\\\\server\\share'],['C:/owned'],['C:\\owned\\..\\other'],['C:\\owned\\'],['C:\\bad.'],['C:\\bad '],['C:\\owned:ads'],['C:\\bad\ud800'],['C:\\owned','c:\\OWNED']]){
  const f=fixture();await assert.rejects(f.flush(values),error=>error.code==='work_data_manifest.flush_input_invalid'&&error.retry===false);assert.equal(f.calls.length,0);
 }
 const f=fixture();await assert.rejects(f.flush(Array.from({length:256},(_,i)=>'C:\\'+String(i).padStart(3,'0')+'x'.repeat(300))),/flush_input_limit/);assert.equal(f.calls.length,0);
 const non=fixture({platform:'linux'});await assert.rejects(non.flush(dirs),/flush_unsupported/);assert.equal(non.calls.length,0);
});

test('bounded stdin carries only flushDirectories; caller mutation cannot retarget and exact native zeros are required',async()=>{
 const f=fixture(),selected=[...dirs],promise=f.flush(selected);selected[0]='C:\\other';selected.push('C:\\extra');
 assert.deepEqual(f.packet(),{flushDirectories:dirs});assert.equal(f.calls.length,1);const [executable,args,options]=f.calls[0];
 assert.ok(executable.endsWith('powershell.exe'));assert.equal(options.windowsHide,true);assert.deepEqual(Array.from(options.stdio),['pipe','pipe','pipe']);
 const bootstrap=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.ok(bootstrap.includes('::RunFlush()'));assert.ok(!bootstrap.includes('::Run()'));assert.ok(!JSON.stringify(args).includes('owned'));
 assert.ok(Buffer.from(options.env.RUYI_MANIFEST_PUBLISHER_SOURCE,'base64').toString().includes('FlushDirectory(directory)'));
 f.complete(success(dirs));const result=await promise;assert.deepEqual(JSON.parse(JSON.stringify(result)),success(dirs));assert.equal(Object.isFrozen(result),true);assert.equal(f.timers.size,0);
});

test('both minimum and maximum directory counts reach the helper and require matching zero codes',async()=>{
 for(const selected of [[dirs[0]],Array.from({length:256},(_,i)=>'C:\\owned\\directory-'+i)]){const f=fixture(),promise=f.flush(selected);assert.deepEqual(f.packet(),{flushDirectories:selected});f.complete(success(selected));const result=await promise;assert.equal(result.directoryFlush.length,selected.length);}
});

test('flush rejects reordered missing additional or nonzero native results and nonzero process exit',async()=>{
 for(const mutate of [x=>x.flushDirectories.reverse(),x=>x.flushDirectories.pop(),x=>x.flushDirectories.push('C:\\unexpected'),x=>x.directoryFlush[0]=5,x=>x.directoryFlush[0]='0',x=>x.directoryFlush.pop(),x=>x.extra=true,x=>delete x.directoryFlush]){
  const f=fixture(),promise=f.flush(dirs),result=success(dirs);mutate(result);f.complete(result);await assert.rejects(promise,error=>error.code==='work_data_manifest.flush_unverifiable'&&error.commitUncertain===true);
 }
 const f=fixture(),promise=f.flush(dirs);f.complete(success(dirs),1);await assert.rejects(promise,/flush_unverifiable/);
});

test('unsupported directory flush returns typed refusal with the real native code and no fallback success',async()=>{
 for(const attempted of [false,true]){const f=fixture(),promise=f.flush(dirs);f.complete({ok:false,code:'durability_unsupported',native:5,moved:false,attempted});await assert.rejects(promise,error=>error.code==='work_data_manifest.flush_durability_unsupported'&&error.nativeCode===5&&error.retry===false&&error.commitUncertain===attempted);assert.equal(f.calls.length,1);}
 const f=fixture(),promise=f.flush(dirs);f.complete({ok:false,code:'durability_unsupported',native:5,moved:true,attempted:true});await assert.rejects(promise,/flush_unverifiable/);
});

test('flush response parsing is strict UTF8 and malformed or truncated output cannot pass',async()=>{
 for(const raw of [Buffer.from('{'),Buffer.from('null'),Buffer.concat([Buffer.from(JSON.stringify(success(dirs))),Buffer.from([255])])]){const f=fixture(),promise=f.flush(dirs);f.complete(raw);await assert.rejects(promise,/flush_unverifiable/);}
});

test('only true spawn failure proves no helper; post-spawn error retains uncertainty until close or deadline',async()=>{
 const sync=fixture({mode:'spawn-throws'});await assert.rejects(sync.flush(dirs),error=>error.code==='work_data_manifest.flush_unavailable'&&error.commitUncertain===false);
 const absent=fixture(),early=absent.flush(dirs);absent.child.emit('error',Error('spawn'));await assert.rejects(early,error=>error.code==='work_data_manifest.flush_unavailable'&&error.commitUncertain===false);assert.equal(absent.timers.size,0);
 for(const mode of ['kill-error','kill-throws']){const f=fixture({mode}),promise=f.flush(dirs);f.spawn();f.child.emit('error',Error('runtime'));await tick();assert.equal(f.settled(),false);f.fire(2000);await assert.rejects(promise,error=>error.helperMayStillRun===true&&error.commitUncertain===true&&error.retry===false);assert.equal(f.timers.size,0);}
});

test('timeout and output caps wait for helper termination; confirmed close differs from failed termination',async()=>{
 const stopped=fixture({mode:'kill-closes'}),promise=stopped.flush(dirs);stopped.spawn();stopped.fire(20000);await assert.rejects(promise,error=>error.code==='work_data_manifest.flush_timeout'&&error.commitUncertain===true&&error.helperMayStillRun!==true);assert.equal(stopped.timers.size,0);
 for(const [stream,size] of [['stdout',262145],['stderr',8193]]){const f=fixture(),promise=f.flush(dirs);f.spawn();f.child[stream].emit('data',Buffer.alloc(size));await tick();assert.equal(f.settled(),false);f.fire(2000);await assert.rejects(promise,error=>error.code==='work_data_manifest.flush_output_limit'&&error.helperMayStillRun===true);assert.equal(f.calls.filter(row=>row==='kill').length,1);}
});

test('an existing helper pid or broken stdin cannot be mistaken for a definitely unexecuted flush',async()=>{
 const f=fixture(),promise=f.flush(dirs);f.child.pid=123;f.child.emit('error',Error('before spawn notification'));await tick();assert.equal(f.settled(),false);f.fire(2000);await assert.rejects(promise,error=>error.helperMayStillRun===true);
 const pipe=fixture(),pending=pipe.flush(dirs);pipe.spawn();pipe.child.stdin.emit('error',Error('pipe'));await tick();assert.equal(pipe.settled(),false);pipe.fire(2000);await assert.rejects(pending,error=>error.code==='work_data_manifest.flush_pipe'&&error.helperMayStillRun===true);
});

test('native flush command shapes input and guards every ancestor/NTFS volume before actual FlushFileBuffers calls',()=>{
 const begin=source.indexOf('  static Dictionary<string,object> FlushDirectories('),end=source.indexOf('  public static void RunFlush()',begin),body=source.slice(begin,end);assert.ok(begin>=0&&end>begin);
 assert.ok(body.includes('Shape(input,"flushDirectories")'));assert.ok(body.includes('raw.Length<1||raw.Length>256'));assert.ok(body.includes('dirs[i]=Full(raw[i])'));assert.ok(body.includes('StringComparer.OrdinalIgnoreCase'));
 assert.ok(body.indexOf('Ancestors(directory)')>=0&&body.indexOf('Ancestors(directory)')<body.indexOf('Attempted=true'));assert.ok(body.indexOf('GetVolumeInformationW(')>=0&&body.indexOf('GetVolumeInformationW(')<body.indexOf('Attempted=true'));assert.ok(body.includes('fsName.ToString()!="NTFS"'));
 assert.ok(body.includes('int code=FlushDirectory(directory); if(code!=0) Reject("durability_unsupported",code);'));assert.ok(!body.includes('MoveFileExW'));
 const primitive=source.slice(source.indexOf('  static int FlushDirectory('),begin);assert.ok(primitive.includes('0xC0000000u'));assert.ok(primitive.includes('FlushFileBuffers(handle)'));assert.ok(primitive.includes('return Marshal.GetLastWin32Error()'));
 assert.ok(source.includes('var response=FlushDirectories(Object(flushJson.DeserializeObject(input.ToString())))'));assert.ok(source.includes('finally { for(int i=Held.Count-1;i>=0;i--) Held[i].Dispose(); }'));
});
