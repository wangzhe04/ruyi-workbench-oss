'use strict';
// Actual Store/Tree/codec composition; only the closed native reader is modeled.
// These are capability and IO-boundary tests, not NTFS metadata acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm'),zlib=require('node:zlib');
const {loadWorkDataJournals}=require('../lib/work-data-journals-fixture');
const {createPreservedReaderModel}=require('../lib/work-data-preserved-reader-model');
const {constBlock,functionBlock}=require('../lib/source-slice');
const rootDir=path.resolve(__dirname,'../../ruyi-workbench/app/src'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{paired=false,legacyBridge=false}={}){
  const root=await io.mkdtemp(path.join(os.tmpdir(),'ruyi-migration-captured-unit-')),source=path.join(root,'source'),target=path.join(root,'target');
  await io.mkdir(source);await io.mkdir(target);
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ruyi-migration-captured-unit-'));await io.rm(root,{recursive:true,force:true});});
  const state={sourceIO:0,native:0,scopes:0,scopeOpen:false,writes:0,tokens:[],copies:[],keyCopies:[],releases:0};
  const inSource=file=>path.resolve(file).toLowerCase().startsWith(source.toLowerCase()+path.sep);
  const guardedIO={...io,async open(file,flags,...args){
    if(inSource(file)&&flags==='r'){state.sourceIO++;throw Error('ordinary source open forbidden');}
    if(flags.includes('x')){assert.equal(state.scopeOpen,false,'source scope must close before target writes');state.writes++;}
    return io.open(file,flags,...args);
  },async readFile(file,...args){if(inSource(file)){state.sourceIO++;throw Error('ordinary source readFile forbidden');}return io.readFile(file,...args);}};
  const actual=loadWorkDataJournals({io:guardedIO,fsp:guardedIO,require:name=>name==='node:fs/promises'?guardedIO:require(name)});
  const context={...actual,WorkDataStore:{...actual.WorkDataStore,...(legacyBridge?{Hooks:{}}:{}),createBinary(host){
    const store=actual.WorkDataStore.createBinary(host);return{...store,async readWithPhysical(options){
      const result=await store.readWithPhysical(options);state.copies.push(result.value);
      if(state.zeroFailure)Object.defineProperty(result.value,'fill',{value(){throw state.zeroFailure;}});
      return result;
    }};
  },async readCapturedBytes(options){
    const bytes=await actual.WorkDataStore.readCapturedBytes(options);state.copies.push(bytes);
    if(state.zeroFailure)Object.defineProperty(bytes,'fill',{value(){throw state.zeroFailure;}});
    return bytes;
  }},require:name=>name==='node:fs/promises'?guardedIO:require(name),Buffer,process};vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(rootDir,'01aa-work-data-tree.js'),'utf8')+'\n'+fs.readFileSync(path.join(rootDir,'01x-work-data-migration-codecs.js'),'utf8'),context);
  if(legacyBridge){
    const bridge=context.WorkDataStore.Hooks.capturedFiles;
    Object.defineProperty(actual.store.Hooks,'capturedFiles',{value:Object.freeze({
      async read(token,file){const bytes=await bridge.read(token,file);await state.afterDirectRead?.(file);return bytes;},
      verify:bridge.verify,assert:bridge.assert,
    })});
  }
  const api=vm.runInContext('({tree:WorkDataTree,codecs:WorkDataMigrationCodecs})',context),owner={roots:[source]};
  const singleCapture=createPreservedReaderModel(async()=>{state.native++;if(state.onNativeCapture)await state.onNativeCapture();});
  const nativeCapture=async(root,revision,readback)=>{
    if(!paired||!readback)return singleCapture(root,revision);
    state.pairs=(state.pairs||0)+1;
    assert.equal(api.tree.claimPreservedReadback({...readback},root,revision),false);
    assert.equal(api.tree.claimPreservedReadback(readback,root,readback.revision),false);
    assert.equal(api.tree.claimPreservedReadback(readback,root,revision),true);
    assert.equal(api.tree.claimPreservedReadback(readback,root,revision),false);
    if(state.earlyBindFailure){
      void readback.bind({revision:readback.revision});
      await new Promise(resolve=>setImmediate(resolve));
      return singleCapture(root,readback.revision);
    }
    if(state.providerFailure){
      const first=await singleCapture(root,revision);state.ownerFailure=state.bindFailure;
      void readback.bind(first);
      throw state.providerFailure;
    }
    await readback.bind(await singleCapture(root,revision));
    await state.beforeReadback?.();
    return singleCapture(root,readback.revision);
  };
  const reader=api.tree.createPreserved({capturePreserved:nativeCapture,ownership:owner,assertExclusive:value=>{if(state.ownerFailure)throw state.ownerFailure;return value===owner;},assertExclusiveSync:value=>value===owner});
  const master=crypto.randomBytes(32),keys={async snapshot(){const key=Buffer.from(master);state.keyCopies.push(key);return{key,instanceId:'b'.repeat(32),release(){state.releases++;key.fill(0);if(state.releaseFailure)throw state.releaseFailure;}};}};
  const scope=async work=>{
    state.scopes++;assert.equal(state.scopeOpen,false);state.scopeOpen=true;const capture=await reader.capture(source);
    try{const value=await work(async file=>{const token=await api.tree.borrowCapturedFile(capture,file,owner,{maxBytes:4*1024*1024});state.tokens.push({token,file});return token;});
      await reader.verify(capture);if(Object.hasOwn(state,'lateFailure'))throw state.lateFailure;return value;
    }finally{capture.release();state.scopeOpen=false;}
  };
  const bridge=api.codecs.create({sourceRoot:source,targetRoot:target,sourceKeys:keys,targetKeys:keys,writeJson:actual.atomicWriteJson,withSourceReadScope:scope,maxPhysicalBytes:4*1024*1024,maxLogicalBytes:4*1024*1024});
  return{root,source,target,state,actual,api,owner,reader,scope,keys,bridge,async put(name,bytes){const file=path.join(source,...name.split('/'));await io.mkdir(path.dirname(file),{recursive:true});await io.writeFile(file,bytes);return file;}};
}
for(const [name,bytes,method,reads] of [
  ['sessions/one.json',Buffer.from('{"id":"one","text":"中文😀"}'),'transform',2],
  ['checkpoints/one/1-2.gz',zlib.gzipSync(Buffer.from('{"text":"binary"}')),'transform',2],
  ['sessions/one.messages.ndjson',Buffer.from('{"role":"user","text":"row"}\n'),'transform',2],
  ['sessions/one.messages.ndjson.prevbody',Buffer.from('{"role":"user","text":"previous"}\n'),'transformRetained',2],
  ['agent-runs/one/two.events.ndjson.gz',zlib.gzipSync(Buffer.from('{"text":"nested"}\n')),'transform',2],
])test('captured migration reads '+name+' with fresh one-read grants and no ordinary source DATA IO',async t=>{
  const f=await fixture(t),input=await f.put(name,bytes),result=await f.bridge[method]({relative:name,targetMode:'encrypted'});
  assert.equal(result.sourcePhysicalHash,hash(bytes));assert.equal(f.state.sourceIO,0);assert.equal(f.state.scopes,2);assert.equal(f.state.tokens.length,reads);
  // The private Store copy remains in the bridge until the full pre-work
  // census completes. Post-work and both separate source scopes still verify.
  assert.equal(new Set(f.state.tokens.map(row=>row.token)).size,reads);assert.ok(f.state.writes>0);assert.equal(f.state.native,reads*4+8);
  for(const{token,file}of f.state.tokens)assert.throws(()=>f.api.tree.assertCapturedFile(token,file),/captured_file_invalid/);
  for(const key of f.state.keyCopies)assert.ok(key.every(byte=>byte===0));assert.deepEqual(await io.readFile(input),bytes);
  const target=await io.readFile(path.join(f.target,...name.split('/')));assert.equal(hash(target),result.targetPhysicalHash);
});
test('readonly captured codec authenticates the same physical decode read without writes',async t=>{
  const f=await fixture(t),name='sessions/one.json',bytes=Buffer.from('{"id":"one"}');await f.put(name,bytes);
  const proof=await f.bridge.verify({relative:name,targetMode:'plain'});assert.equal(proof.physicalHash,hash(bytes));assert.equal(f.state.scopes,1);assert.equal(f.state.tokens.length,1);assert.equal(f.state.native,8);assert.equal(f.state.writes,0);
  await assert.rejects(f.bridge.verify({relative:name,targetMode:'encrypted'}),{code:'work_data_migration.verification_failed'});assert.equal(f.state.sourceIO,0);
});

test('paired census preserves both readings and catches a changed source after the first handle scope closed',async t=>{
  const f=await fixture(t,{paired:true}),name='sessions/one.json',file=await f.put(name,'{"id":"one"}');
  await f.bridge.verify({relative:name,targetMode:'plain'});
  assert.equal(f.state.native,8);assert.equal(f.state.pairs,4);assert.equal(f.state.sourceIO,0);
  f.state.beforeReadback=()=>io.writeFile(file,'{"id":"two"}');
  await assert.rejects(f.bridge.transform({relative:name,targetMode:'encrypted'}),{code:'work_data_tree.source_changed'});
  assert.equal(f.state.writes,0);assert.equal(f.state.sourceIO,0);
});
for(const legacyBridge of [false,true])test('Store refuses a changed carrier before consumption with '+(legacyBridge?'the legacy verified read bridge':'a private copy'),async t=>{
  const f=await fixture(t,{legacyBridge}),name='sessions/one.json',file=await f.put(name,'{}');
  const host={file:()=>file,purpose:'session',schema:2,scopeId:'sessions',recordId:'one',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson};
  await loadWorkDataJournals().store.createText(host).write('{"id":"one"}');f.state.keyCopies.length=0;
  let changed=false,physicalCalls=0;
  const change=async()=>{assert.equal(changed,false);changed=true;await io.writeFile(file,'{"id":"two"}');};
  if(legacyBridge)f.state.afterDirectRead=async actual=>{assert.equal(actual,file);assert.equal(f.state.native,4);await change();};
  else f.state.onNativeCapture=async()=>{if(f.state.native===3)await change();};
  await assert.rejects(f.scope(factory=>f.actual.store.createText({...host,capturedFile:()=>factory(file)})
    .readWithPhysical({maxBytes:4096,assertPhysical:()=>{physicalCalls++;}})),{code:'work_data_tree.source_changed'});
  assert.equal(changed,true);assert.equal(physicalCalls,0);assert.equal(f.state.keyCopies.length,0);assert.equal(f.state.sourceIO,0);
});
test('standalone captured-file consumers still verify the live carrier before returning bytes',async t=>{
  const f=await fixture(t),file=await f.put('sessions/one.json','{"id":"one"}'),captured=await f.reader.capture(f.source);
  try{
    const token=await f.api.tree.borrowCapturedFile(captured,file,f.owner);
    f.state.onNativeCapture=async()=>{if(f.state.native===3)await io.writeFile(file,'{"id":"two"}');};
    await assert.rejects(f.api.tree.readCapturedFile(token,file),{code:'work_data_tree.source_changed'});
    assert.equal(f.state.native,4);assert.equal(f.state.sourceIO,0);
  }finally{captured.release();}
});
test('a read-only scope shares one live readback across grants and refuses to return a stale result',async t=>{
  const f=await fixture(t),a=await f.put('sessions/one.json','{"id":"one"}'),b=await f.put('sessions/two.json','{"id":"two"}');
  const captured=await f.reader.capture(f.source);
  const read=async file=>{
    const token=await f.api.tree.borrowCapturedFile(captured,file,f.owner);
    try{return (await f.api.tree.readCapturedFile(token,file)).toString('utf8');}
    finally{token.release();}
  };
  try{
    await assert.rejects(f.api.tree.readCapturedScope(captured,{...f.owner},()=>assert.fail()),/captured_file_invalid/);
    const values=await f.api.tree.readCapturedScope(captured,f.owner,async()=>[await read(a),await read(b)]);
    assert.deepEqual(values,['{"id":"one"}','{"id":"two"}']);
    assert.equal(f.state.native,4);
    await assert.rejects(f.api.tree.readCapturedScope(captured,f.owner,async()=>{
      const before=await read(a);
      await io.writeFile(b,'{"id":"changed"}');
      return [before,await read(b)];
    }),{code:'work_data_tree.source_changed'});
    assert.equal(f.state.native,6);
  }finally{captured.release();}
});
test('paired census observes a binding rejection before a provider returns without awaiting it',async t=>{
  const f=await fixture(t,{paired:true}),name='sessions/one.json';await f.put(name,'{"id":"one"}');
  f.state.earlyBindFailure=true;
  await assert.rejects(f.bridge.verify({relative:name,targetMode:'plain'}),{code:'work_data_tree.preserved_native_invalid'});
  assert.equal(f.state.writes,0);
});
test('paired census preserves a distinct binding uncertainty after the provider fails first',async t=>{
  const f=await fixture(t,{paired:true}),name='sessions/one.json';await f.put(name,'{"id":"one"}');
  const primary=Error('native provider failed'),bind=Object.assign(Error('Node binding uncertain'),{helperMayStillRun:true});
  const host=fs.readFileSync(path.join(rootDir,'01ad-work-data-migration-host.js'),'utf8'),detect=constBlock(host,'sourceUnknown');
  assert.ok(detect);
  const sourceUnknown=vm.runInNewContext(detect+'\nsourceUnknown;',{require});
  f.state.providerFailure=primary;f.state.bindFailure=bind;
  await assert.rejects(f.bridge.verify({relative:name,targetMode:'plain'}),error=>{
    const aggregate=error.cause;
    assert.equal(aggregate.cause,primary);assert.equal(aggregate.errors[0],primary);assert.equal(aggregate.errors[1],bind);
    assert.equal(sourceUnknown(new AggregateError(aggregate.errors)),true);assert.equal(sourceUnknown(error),true);
    return aggregate.helperMayStillRun===true&&aggregate.ownershipRetained===true;
  });
  assert.equal(f.state.writes,0);
});

function censusProducerModel(fault){
  const src=fs.readFileSync(path.join(rootDir,'13u-migration-center.js'),'utf8');
  const functions=['migrationCapsuleShape','migrationCapsuleFail','migrationCapturedCleanupFailure','migrationCapsuleCapturePreserved'].map(name=>functionBlock(src,name));
  assert.ok(functions.every(Boolean));
  const root='synthetic-owned-root',first='1'.repeat(64),last='2'.repeat(64),events=[];
  const snapshot=revision=>({schema:1,platform:'ntfs-objects-v1',revision,entries:[
    {rel:'',dir:true,id:'a'.repeat(24),opaque:'a'.repeat(64),attrs:16,times:['1','2','3','4'],shortName:'',streams:[]},
    {rel:'one',dir:false,id:'b'.repeat(24),opaque:'b'.repeat(64),attrs:32,times:['1','2','3','4'],shortName:'',streams:['',':named:$DATA'].map(name=>({name,size:0,hash:hash(Buffer.alloc(0)),data:''}))},
  ]});
  const nativeError=Object.assign(new Error('native did not prove close'),{code:'work_data_backup.census_first_close_unverified'});
  let started,release,idle;
  const closing=new Promise(resolve=>{started=resolve;}),closed=new Promise(resolve=>{release=resolve;});
  const migrationCapsuleBroker=async()=>{events.push('spawn');return{
    async command(args){
      events.push(args.cmd);assert.equal(args.root,root);
      if(args.cmd==='capture-preserved-census-first'){
        assert.equal(args.revision,first);if(fault==='unclosed')throw nativeError;
        return {closedHandles:fault==='count'?2:3,revision:fault==='nonce'?last:first,snapshot:snapshot(first)};
      }
      assert.equal(args.cmd,'capture-preserved-census-final');assert.equal(args.revision,last);assert.equal(args.firstRevision,first);
      return snapshot(fault==='final-nonce'?first:last);
    },
    async close(){events.push('close');started();await closed;if(fault==='unclosed')throw nativeError;
      if(fault==='idle-close')throw Object.assign(new Error('unknown close'),{helperMayStillRun:true});},
  };};
  const issued=new WeakSet(),WorkDataTree={claimPreservedReadback(token,selected,revision){return selected===root&&revision===first&&issued.delete(token);}};
  const timers={setTimeout(callback,ms){assert.equal(ms,120000);idle=callback;return 1;},clearTimeout(){idle=null;}};
  const capture=vm.runInNewContext(functions.join('\n')+'\nmigrationCapsuleCapturePreserved;',{Buffer,crypto,migrationCapsuleBroker,WorkDataTree,require(name){assert.equal(name,'node:timers');return timers;}});
  return {events,first,last,root,release,closing,unknown:()=>migrationCapsuleBroker.helperMayStillRun,
    fireIdle(){assert.equal(typeof idle,'function');idle();},
    run(bind,{forged=false}={}){const token=Object.freeze({revision:last,bind});if(!forged)issued.add(token);return capture(root,first,token);}};
}
test('paired producer binds only after the closed first receipt and releases only after final actual close',async()=>{
  const f=censusProducerModel();let finished=false;
  const result=f.run(value=>{assert.equal(value.revision,f.first);f.events.push('node-bind');}).then(value=>{finished=true;return value;});
  await Promise.race([f.closing,result]);
  assert.deepEqual(f.events,['spawn','capture-preserved-census-first','node-bind','capture-preserved-census-final','close']);
  assert.equal(finished,false);f.release();assert.equal((await result).revision,f.last);assert.equal(f.unknown(),undefined);
});
for(const fault of ['count','nonce','unclosed'])test('paired producer latches a failed first close proof '+fault+' and never sends the final command',async()=>{
  const f=censusProducerModel(fault);f.release();
  await assert.rejects(f.run(()=>assert.fail('unproven first receipt reached Node')),
    {code:'work_data_backup.census_first_close_unverified',helperMayStillRun:true,ownershipRetained:true});
  assert.deepEqual(f.events,['spawn','capture-preserved-census-first','close']);assert.equal(f.unknown(),true);
});
test('paired producer refuses an unissued readback before starting a broker',async()=>{
  const f=censusProducerModel();await assert.rejects(f.run(()=>{}, {forged:true}),{code:'work_data_backup.census_scope'});
  assert.deepEqual(f.events,[]);
});
test('paired producer refuses a final result replaying the first nonce after actual close',async()=>{
  const f=censusProducerModel('final-nonce'),result=f.run(()=>{});
  await Promise.race([f.closing,result]);f.release();
  await assert.rejects(result,{code:'work_data_backup.shape'});
  assert.equal(f.unknown(),undefined);
});
test('paired producer bounds idle native close but settles the Node bind and retains both failures',async()=>{
  const f=censusProducerModel('idle-close'),primary=Error('Node binding failed');let bindStarted,rejectBind,settled=false;
  const started=new Promise(resolve=>{bindStarted=resolve;}),binding=new Promise((resolve,reject)=>{rejectBind=reject;});
  const result=f.run(()=>{bindStarted();return binding;});
  result.then(()=>{settled=true;},()=>{settled=true;});
  await Promise.race([started,result]);f.fireIdle();await f.closing;f.release();await Promise.resolve();assert.equal(settled,false);
  rejectBind(primary);
  await assert.rejects(result,error=>error.helperMayStillRun===true&&error.ownershipRetained===true
    &&error.cause.code==='work_data_backup.census_idle_timeout'&&error.cause.cause===primary);
  assert.deepEqual(f.events,['spawn','capture-preserved-census-first','close']);
});

for(const kind of ['text','sealed-text','chunked-text','gzip','sealed-gzip'])test('Store physical receipt hashes the exact '+kind+' carrier after the real decode lifecycle',async t=>{
  const f=await fixture(t),binary=kind.endsWith('gzip'),logical=binary?zlib.gzipSync(Buffer.from('{"text":"中文😀"}')):'\uFEFF{"id":"one","text":"中文😀"}',name=binary?'checkpoints/one/1-2.gz':'sessions/one.json',file=await f.put(name,logical);
  const host={file:()=>file,purpose:'session',schema:binary?1:2,scopeId:binary?'one':'sessions',recordId:binary?'1-2.gz':'one',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson,
    ...(binary?{chunked:true,maxPlaintextBytes:4*1024*1024,maxBinaryBytes:4*1024*1024,validateLegacyBinary:bytes=>{zlib.gunzipSync(bytes);return true;}}:kind==='chunked-text'?{chunked:true,maxPlaintextBytes:4*1024*1024}:{})};
  if(kind.startsWith('sealed-')||kind==='chunked-text')await loadWorkDataJournals().store[binary?'createBinary':'createText'](host).write(logical);
  const physical=await io.readFile(file);
  const result=await f.scope(async factory=>{
    const store=f.actual.store[binary?'createBinary':'createText']({...host,capturedFile:()=>factory(file)});
    return store.readWithPhysical({maxBytes:4*1024*1024,assertPhysical:info=>{assert.equal(Object.isFrozen(info),true);assert.equal(info.bytes,physical.length);assert.equal(info.sha256,hash(physical));assert.equal(info.gzip,kind==='gzip');assert.equal(info.utf8Valid,kind==='gzip'?null:true);}});
  });
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.physical),true);assert.equal(result.physical.sha256,hash(physical));
  if(binary){assert.deepEqual(result.value,logical);result.value.fill(0);}else assert.equal(result.value,logical);
  assert.equal(f.state.native,8);assert.equal(f.state.tokens.length,1);assert.equal(f.state.sourceIO,0);
});

for(const kind of ['invalid-utf8','physical-limit','nonvoid-guard'])test('same-read '+kind+' refuses before credentials or target writes',async t=>{
  const f=await fixture(t),bytes=kind==='invalid-utf8'?Buffer.from([123,34,120,34,58,34,0xc0,0xaf,34,125]):Buffer.from('{"id":"one"}'),file=await f.put('sessions/one.json',bytes);
  let traps=0,guarded=false;const opaque=Object.defineProperty({},'then',{get(){traps++;throw Error('must not read then');}});
  if(kind==='invalid-utf8')await assert.rejects(f.bridge.transform({relative:'sessions/one.json',targetMode:'encrypted'}),{code:'work_data_migration.utf8_invalid'});
  else await assert.rejects(f.scope(async factory=>f.actual.store.createText({file:()=>file,purpose:'session',schema:2,scopeId:'sessions',recordId:'one',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson,capturedFile:()=>factory(file)})
    .readWithPhysical({maxBytes:kind==='physical-limit'?1:4096,assertPhysical:()=>{guarded=true;return opaque;}})),error=>kind==='physical-limit'?error.code==='work_data_store.engineering_limit':error.code==='work_data_store.physical_check_unproven'&&error.helperMayStillRun===true);
  assert.equal(traps,0);assert.equal(guarded,kind==='nonvoid-guard');assert.equal(f.state.keyCopies.length,0);assert.equal(f.state.writes,0);assert.equal(f.state.sourceIO,0);
});

test('same-read binary key cleanup failure clears the decoded Buffer and returns no receipt',async t=>{
  const f=await fixture(t),file=await f.put('checkpoints/one/1-2.gz',''),gzip=zlib.gzipSync(Buffer.from('{"text":"PRIVATE"}'));
  const host={file:()=>file,purpose:'session',schema:1,scopeId:'one',recordId:'1-2.gz',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson,chunked:true,maxPlaintextBytes:4*1024*1024,maxBinaryBytes:4*1024*1024,validateLegacyBinary:()=>true};
  await loadWorkDataJournals().store.createBinary(host).write(gzip);
  const cleanup=Object.assign(Error('key release'),{helperMayStillRun:true});f.state.releaseFailure=cleanup;let decoded,returned=false;
  await assert.rejects(f.scope(async factory=>{const store=f.actual.store.createBinary({...host,capturedFile:()=>factory(file),validateLegacyBinary:bytes=>{decoded=bytes;return true;}});const result=await store.readWithPhysical({maxBytes:4096,assertPhysical:()=>{}});returned=true;return result;}),error=>error.cleanupFailed===true&&error.ownershipRetained===true);
  assert.equal(returned,false);assert.ok(decoded.every(byte=>byte===0));for(const key of f.state.keyCopies)assert.ok(key.every(byte=>byte===0));
});

test('same-read decoded binary is cleared when its closed source scope fails later',async t=>{
  const f=await fixture(t),name='checkpoints/one/1-2.gz',gzip=zlib.gzipSync(Buffer.from('{}'));await f.put(name,gzip);f.state.lateFailure=Object.assign(Error('late source proof'),{code:'work_data_migration.source_changed'});
  await assert.rejects(f.bridge.transform({relative:name,targetMode:'encrypted'}),{code:'work_data_migration.source_changed'});
  assert.ok(f.state.copies.length>0);for(const bytes of f.state.copies)assert.ok(bytes.every(byte=>byte===0));assert.equal(f.state.writes,0);
});

test('same-read binary returns no receipt and clears its Buffer after a late token verification failure',async t=>{
  const f=await fixture(t),file=await f.put('checkpoints/one/1-2.gz',zlib.gzipSync(Buffer.from('{}'))),primary=Object.assign(Error('post-decode changed'),{code:'work_data_tree.source_changed'});let decoded,returned=false;
  f.state.onNativeCapture=()=>{if(decoded)throw primary;};
  await assert.rejects(f.scope(async factory=>{
    const store=f.actual.store.createBinary({file:()=>file,purpose:'session',schema:1,scopeId:'one',recordId:'1-2.gz',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson,chunked:true,maxPlaintextBytes:4096,maxBinaryBytes:4096,capturedFile:()=>factory(file),validateLegacyBinary:bytes=>{decoded=bytes;return true;}});
    const result=await store.readWithPhysical({maxBytes:4096,assertPhysical:()=>{}});returned=true;return result;
  }),error=>error===primary);
  assert.equal(returned,false);assert.ok(decoded.every(byte=>byte===0));assert.equal(f.state.sourceIO,0);
});

test('same-read conversion still independently reads a changed source after stage writes and refuses publication',async t=>{
  const f=await fixture(t),file=await f.put('sessions/one.json','{"id":"one","text":"ORIGINAL"}');let changed=false;
  f.state.onNativeCapture=async()=>{if(!changed&&f.state.writes){changed=true;await io.writeFile(file,'{"id":"one","text":"CHANGED"}');}};
  await assert.rejects(f.bridge.transform({relative:'sessions/one.json',targetMode:'encrypted'}),error=>error.code==='work_data_migration.source_changed'&&error.targetRetained===false);
  assert.equal(changed,true);assert.equal(f.state.scopes,2);assert.equal(f.state.tokens.length,2);assert.equal(fs.existsSync(path.join(f.target,'sessions/one.json')),false);for(const copy of f.state.copies)assert.ok(copy.every(byte=>byte===0));
});

for(const kind of ['cloned','released','wrong-file'])test('same-read Store refuses a '+kind+' file grant without ordinary IO',async t=>{
  const f=await fixture(t),file=await f.put('sessions/one.json','{}'),other=await f.put('sessions/two.json','{}');
  await assert.rejects(f.scope(async factory=>{
    let token=await factory(file);if(kind==='cloned')token={...token};if(kind==='released')token.release();
    return f.actual.store.createText({file:()=>kind==='wrong-file'?other:file,purpose:'session',schema:2,scopeId:'sessions',recordId:'one',keys:f.keys,enabled:()=>true,writeJson:f.actual.atomicWriteJson,capturedFile:()=>token})
      .readWithPhysical({maxBytes:4096,assertPhysical:()=>{}});
  }),/captured_file_invalid/);
  assert.equal(f.state.sourceIO,0);assert.equal(f.state.keyCopies.length,0);
});
test('permanent entry target reader opens real chunked codec output with its required explicit capacity',async t=>{
 const f=await fixture(t),name='missions/one.json',logical=JSON.stringify({id:'one',text:'中文😀'.repeat(3000)});await f.put(name,logical);
 await f.bridge.transform({relative:name,targetMode:'encrypted'});
 const read=vm.runInNewContext(functionBlock(fs.readFileSync(path.resolve(__dirname,'../work-data-migration-preserved-source.e2e.js'),'utf8'),'readCodecTargetText')+'\nreadCodecTargetText;');
 const file=path.join(f.target,...name.split('/')),descriptor=f.api.codecs.describe(name);
 assert.equal(JSON.parse((await io.readFile(file,'utf8')).split('\n')[0]).workData,3);
 assert.equal(await read({WorkDataStore:f.actual.store,atomicWriteJson:f.actual.atomicWriteJson},file,descriptor,f.keys),logical);
 const damaged=await io.readFile(file,'utf8');await io.writeFile(file,damaged.slice(0,-8));
 await assert.rejects(read({WorkDataStore:f.actual.store,atomicWriteJson:f.actual.atomicWriteJson},file,descriptor,f.keys));
});
test('captured scope failure retains the original failure and a simultaneous key-release uncertainty',async t=>{
  const f=await fixture(t);await f.put('sessions/one.json','{"id":"one"}');
  // Acquire a source key before the late scope failure using encrypted source.
  const file=path.join(f.source,'sessions/one.json'),setup=loadWorkDataJournals();await setup.store.createText({file:()=>file,purpose:'session',schema:2,scopeId:'sessions',recordId:'one',keys:f.keys,enabled:()=>true,writeJson:setup.atomicWriteJson}).write('{"id":"one"}');
  f.state.writes=0;
  const primary=Object.assign(Error('late source failure'),{code:'work_data_migration.source_changed'}),cleanup=Object.assign(Error('unknown key release'),{helperMayStillRun:true});f.state.lateFailure=primary;f.state.releaseFailure=cleanup;
  await assert.rejects(f.bridge.transform({relative:'sessions/one.json',targetMode:'plain'}),error=>{
    assert.equal(error.code,'work_data_migration.key_release_failed');assert.equal(error.errors[0].cause,primary);assert.ok(error.errors.slice(1).some(item=>item===cleanup||item.cause===cleanup));assert.equal(error.ownershipRetained,true);return true;
  });
  assert.equal(f.state.writes,0);assert.equal(f.state.sourceIO,0);for(const key of f.state.keyCopies)assert.ok(key.every(byte=>byte===0));
});
for(const kind of ['getter','proxy','falsy','zero'])test('codec cleanup keeps '+kind+' primary and settles keys despite secondary cleanup failure',async t=>{
  const f=await fixture(t),name=kind==='zero'?'checkpoints/one/1-2.gz':'sessions/one.json',file=await f.put(name,'{}'),setup=loadWorkDataJournals();
  if(kind==='zero')await setup.store.createBinary({file:()=>file,purpose:'session',schema:1,scopeId:'one',recordId:'1-2.gz',keys:f.keys,enabled:()=>true,chunked:true,maxBinaryBytes:4*1024*1024,maxPlaintextBytes:4*1024*1024,validateLegacyBinary:()=>true,writeJson:setup.atomicWriteJson}).write(zlib.gzipSync(Buffer.from('{}')));
  else await setup.store.createText({file:()=>file,purpose:'session',schema:2,scopeId:'sessions',recordId:'one',keys:f.keys,enabled:()=>true,writeJson:setup.atomicWriteJson}).write('{"id":"one"}');
  let traps=0;const primary=kind==='falsy'?false:kind==='proxy'?new Proxy({},{get(){traps++;throw Error('untrusted getter');}}):kind==='getter'?Object.defineProperty({},'code',{get(){traps++;throw Error('untrusted code');}}):Error('primary');
  const cleanup=Object.assign(Error('secondary key cleanup'),{helperMayStillRun:true});f.state.lateFailure=primary;f.state.releaseFailure=cleanup;
  if(kind==='zero')f.state.zeroFailure=Error('secondary zero cleanup');
  // The scope must throw falsy values too; the failure sentinel is separate.
  const expected=f.state.lateFailure;
  await assert.rejects(f.bridge.transform({relative:name,targetMode:'plain'}),error=>{
    assert.equal(error.code,'work_data_migration.key_release_failed');assert.equal(error.errors[0].cause,expected);assert.equal(error.ownershipRetained,true);
    if(kind==='zero')assert.ok(error.errors.includes(f.state.zeroFailure));return true;
  });
  assert.equal(traps,0);assert.equal(f.state.releases,f.state.keyCopies.length);assert.equal(f.state.scopeOpen,false);for(const key of f.state.keyCopies)assert.ok(key.every(byte=>byte===0));
  // Synthetic zero-failure copies are deliberately retained for inspection.
  for(const bytes of f.state.copies)Reflect.apply(Buffer.prototype.fill,bytes,[0]);
});

const finish=vm.runInNewContext(functionBlock(fs.readFileSync(path.resolve(__dirname,'../work-data-migration-preserved-source.e2e.js'),'utf8'),'finishSourceFixture')+'\nfinishSourceFixture;');
for(const phase of ['clear','release','flush','retain','remove','unknown'])test('permanent source entry preserves first error through '+phase+' cleanup failure',async()=>{
 const primary=false,secondary=Error('synthetic '+phase),events=[];let held=phase==='retain';
 const action=name=>()=>{events.push(name);if(name===phase)throw secondary;};
 await assert.rejects(finish({complete:phase==='remove',failed:phase!=='remove',primary,clear:action('clear'),unknown:()=>{if(phase==='unknown')throw secondary;return held;},retain:action('retain'),release:action('release'),flush:action('flush'),remove:action('remove')}),error=>{
  assert.equal(error.ownershipRetained,true);if(phase!=='remove')assert.equal(error.errors[0],primary);assert.ok(error.errors.includes(secondary));return true;
 });
 assert.equal(events.filter(name=>name==='retain').length,1);if(phase!=='remove')assert.equal(events.includes('remove'),false);if(['clear','retain','unknown'].includes(phase))assert.equal(events.includes('release'),false);
});
test('permanent source entry removes only known success and preserves a falsy primary without cleanup errors',async()=>{
 const events=[],actions=Object.fromEntries(['clear','release','flush','remove','retain'].map(name=>[name,()=>{events.push(name);} ]));
 await finish({complete:true,failed:false,...actions,unknown:()=>false});assert.deepEqual(events,['clear','release','flush','remove']);events.length=0;
 await assert.rejects(finish({complete:false,failed:true,primary:false,...actions,unknown:()=>false}),error=>error===false);assert.deepEqual(events,['clear','release','flush']);
});
test('permanent source entry retains a late final-check unknown or inspection failure',async()=>{
 for(const throws of [false,true]){
  let checks=0;const events=[],secondary=Error('late unknown inspection'),action=name=>()=>{events.push(name);};
  await assert.rejects(finish({complete:false,failed:false,clear:action('clear'),release:action('release'),flush:action('flush'),remove:action('remove'),retain:action('retain'),unknown(){checks++;if(checks===5){if(throws)throw secondary;return true;}return false;}}),error=>{
   assert.equal(error.helperMayStillRun,true);if(throws)assert.ok(error.errors.includes(secondary));return true;
  });
  assert.deepEqual(events,['clear','release','flush','retain']);assert.equal(checks,5);
 }
});
