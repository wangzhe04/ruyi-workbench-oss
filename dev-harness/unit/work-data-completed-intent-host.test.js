'use strict';
// Pure production-module composition: memory FS/net/clock only. No subprocess,
// real OS owner, native helper, browser or PowerShell is started by this suite.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {createFixture,tick}=require('../lib/work-data-production-host-fixture');
const dto=value=>JSON.parse(JSON.stringify(value)),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function model({operation='enable',manualClose=false}={}){
 const f=createFixture({manualClose}),claim=await f.sourceClaim({operation}),id=claim.record.id;
 const base=claim.record.base,controlRoot=path.join(base,'.work-data'),candidate='a'.repeat(48),candidateRoot=path.join(controlRoot,'generations',candidate);
 f.memory.mkdir(candidateRoot);
 const header=JSON.stringify({schema:1,instanceId:'1'.repeat(32),protectedKey:Buffer.alloc(32,3).toString('base64')});
 const manifest=JSON.stringify({schema:1,id:candidate,generation:operation==='enable'?1:2,mode:operation==='enable'?'encrypted':'plain',activeRoot:'generations/'+candidate});
 const headerFile=path.join(candidateRoot,'work-data-key-v1.json'),manifestFile=path.join(controlRoot,'active-v1.json');
 f.memory.put(headerFile,header);f.memory.put(manifestFile,manifest);
 const authority={generation:operation==='enable'?1:2,id:candidate,mode:operation==='enable'?'encrypted':'plain',sha256:hash(manifest)};
 const expected=operation==='enable'?{generation:0,id:null,mode:'plain',sha256:null}:{generation:1,id:'b'.repeat(48),mode:'encrypted',sha256:'c'.repeat(64)};
 f.nativeBindings.manifest.create=()=>({readActive:async()=>({...authority,root:candidateRoot,proof:{sha256:authority.sha256}})});
 const backupFile=path.join(f.paths.backup,'ruyi-work-data-'+id+'.ruyi-backup');f.memory.put(backupFile,'SYNTHETIC PURE RESULT BACKUP');
 const stat=f.memory.stat(backupFile),backup={path:backupFile,bytes:Number(stat.size),sha256:hash(await f.memory.io.readFile(backupFile)),identity:{dev:String(stat.dev),ino:String(stat.ino)}};
 const owner=await f.api.ownership.acquire([base]),exclusive=lease=>lease===owner&&f.api.ownership.owns(lease,base);
 const control=f.api.control.create({base,ownership:owner,assertExclusive:exclusive,assertDurableBackup:async()=>true,flush:async()=>{}});
 const state={schema:1,id,operation,phase:'prepared',createdAt:claim.record.createdAt,expectedAuthority:expected,backup:{path:backupFile,sha256:backup.sha256},candidate:null};
 let receipt=await control.write(state);
 for(const phase of ['candidate','key-ready','published','complete'])receipt=await control.write({...state,phase,candidate:{id:candidate,mode:authority.mode,headerSha256:hash(header)}},receipt);
 const resultApi=f.api.result.create({base,ownership:owner,assertExclusive:exclusive,readAuthority:async()=>authority,assertDurableBackup:async()=>true,flush:async()=>{}});
 const result={schema:1,id,operation,state:'published',sourceAuthority:expected,authority,backup,finishedAt:claim.record.updatedAt};
 await resultApi.write(result);const released=owner.release();if(manualClose)f.servers.at(-1).finishClose();await released;
 const intentFile=path.join(controlRoot,'maintenance-v1.json'),resultFile=path.join(controlRoot,f.api.result.NAME),observed={seals:0};
 const proof=()=>({sha256:'d'.repeat(64),bytes:100,files:4,directories:3});
 const seal=async options=>{
  observed.seals++;assert.equal(f.memory.exists(intentFile),true,'both complete profiles still contain intent');
  assert.equal(f.api.control.acceptsRecoveryProfile(options.controlRecoveryProof,base,options.ownership),true);
  await f.api.control.verifyRecoveryProfile(options.controlRecoveryProof,{base,ownership:options.ownership,path:'.work-data/maintenance-v1.json',bytes:await f.memory.io.readFile(intentFile)});
  const sourceFiles=await Promise.all([manifestFile,headerFile].map(async file=>{const stat=f.memory.stat(file);return{path:path.relative(base,file).split(path.sep).join('/'),identity:String(stat.dev)+':'+String(stat.ino),sha256:hash(await f.memory.io.readFile(file))};}));
  const sourceDirectories=['','.work-data','.work-data/generations','.work-data/generations/'+candidate].map(relative=>{const stat=f.memory.stat(path.join(base,...relative.split('/')));return{path:relative,identity:String(stat.dev)+':'+String(stat.ino)};});
  return{sourceProof:proof(),sourceFiles,sourceDirectories};
 };
 f.nativeBindings.fullSnapshot.create=options=>({seal:async()=>seal(options)});
 const before={intent:await f.memory.io.readFile(intentFile),claim:await f.memory.io.readFile(claim.file),result:await f.memory.io.readFile(resultFile),backup:await f.memory.io.readFile(backupFile)};
 return{f,claim,base,controlRoot,candidateRoot,intentFile,resultFile,headerFile,manifestFile,backupFile,authority,expected,state,result,observed,seal,before};
}
async function preserved(m){for(const [name,file]of [['intent',m.intentFile],['claim',m.claim.file],['result',m.resultFile],['backup',m.backupFile]])assert.deepEqual(await m.f.memory.io.readFile(file),m.before[name],name);}
async function transitionInventory(f,base){
 const sourceFiles=[],sourceDirectories=[];
 async function visit(relative){
  const file=path.join(base,...relative.split('/')),stat=f.memory.stat(file);
  const row={path:relative,identity:String(stat.dev)+':'+String(stat.ino),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)};
  if(stat.isDirectory()){
   sourceDirectories.push(row);
   for(const name of f.memory.entries(file))await visit(relative?relative+'/'+name:name);
  }else sourceFiles.push({...row,sha256:hash(await f.memory.io.readFile(file))});
 }
 await visit('');
 return {sourceFiles,sourceDirectories};
}
async function transitionModel({published=false,legacy=false,legacyRelocated=false,existingControl=false,phase='key-ready',ready=false,sourceProof=true}={}){
 const operation=legacy?'enable':'disable',f=createFixture(),claim=await f.sourceClaim({operation}),{base,id}=claim.record;
 const controlRoot=path.join(base,'.work-data'),generations=path.join(controlRoot,'generations'),candidateId='a'.repeat(48),sourceId=legacy?null:'b'.repeat(48);
 const oldRoot=legacy?base:path.join(generations,sourceId),candidateRoot=path.join(generations,candidateId);
 f.memory.mkdir(oldRoot);
 const header=byte=>JSON.stringify({schema:1,instanceId:'1'.repeat(32),protectedKey:Buffer.alloc(32,byte).toString('base64')});
 const sourceHeaderFile=path.join(oldRoot,'work-data-key-v1.json'),headerFile=path.join(candidateRoot,'work-data-key-v1.json');
 if(legacy)f.memory.put(path.join(base,'config.json'),'{"workDataEncryptionV1":false}');
 else f.memory.put(sourceHeaderFile,header(1));
 const ordinaryFile=path.join(oldRoot,'retained-fixture.bin');f.memory.put(ordinaryFile,'SYNTHETIC UNCHANGED SOURCE');
 const legacyRoot=path.join(base,'migrations','skill-backups'),stableRoot=path.join(controlRoot,'skill-backups','objects-v1');
 let legacySource,scope;
 if(legacyRelocated){
  assert.equal(legacy,true);
  if(existingControl)f.memory.mkdir(generations);
  f.memory.mkdir(legacyRoot);f.memory.put(path.join(legacyRoot,'prior.txt'),'LEGACY ORIGINAL');
  legacySource={...await transitionInventory(f,base),specialCoverage:{
   type:'skill-backup-portable',originalObjects:'new-owned-portable',sourcePath:'migrations/skill-backups'}};
  scope=f.api.control.legacyTransitionSourceScope(legacySource);
 }
 f.memory.mkdir(candidateRoot);f.memory.put(headerFile,header(2));
 const pointer=(id,generation,mode)=>JSON.stringify({schema:1,generation,id,mode,activeRoot:'generations/'+id})+'\n';
 const oldPointer=legacy?null:pointer(sourceId,1,'encrypted'),newPointer=pointer(candidateId,legacy?1:2,legacy?'encrypted':'plain');
 const manifestFile=path.join(controlRoot,'active-v1.json');
 if(published||oldPointer!==null)f.memory.put(manifestFile,published?newPointer:oldPointer);
 f.nativeBindings.manifest.create=()=>({async readActive(){
  if(!f.memory.exists(manifestFile))return {id:null,generation:0,mode:'plain',root:base,proof:{raw:null,sha256:null}};
  const raw=await f.memory.io.readFile(manifestFile,'utf8'),value=JSON.parse(raw);
  return {...value,root:path.join(controlRoot,value.activeRoot),proof:{raw,sha256:hash(raw)}};
 }});
 f.nativeBindings.protector.run=async()=>Buffer.alloc(32,9);
 f.nativeBindings.readRecoveryControl=async file=>f.memory.io.readFile(file);
 const backupFile=path.join(f.paths.backup,'ruyi-work-data-'+id+'.ruyi-backup'),backupBytes=Buffer.from('SYNTHETIC RETAINED TRANSITION BACKUP');
 f.memory.put(backupFile,backupBytes);
 const owner=await f.api.ownership.acquire([base]),exclusive=lease=>lease===owner&&f.api.ownership.owns(lease,base);
 const control=f.api.control.create({base,ownership:owner,assertExclusive:exclusive,assertDurableBackup:async()=>true,flush:async()=>{}});
 const expectedAuthority={generation:legacy?0:1,id:sourceId,mode:legacy?'plain':'encrypted',sha256:legacy?null:hash(oldPointer)};
 const state={schema:1,id,operation,phase:'prepared',createdAt:claim.record.createdAt,expectedAuthority,backup:{path:backupFile,sha256:hash(backupBytes)},candidate:null};
 const transition={schema:1,operationId:'e'.repeat(48),preparedSha256:'f'.repeat(64)};
 const transitionReady=ready?{schema:1,targetSha256:'2'.repeat(64),targetNativeSha256:'3'.repeat(64)}:undefined;
 const candidate={id:candidateId,mode:legacy?'encrypted':'plain',headerSha256:hash(header(2)),pointerSha256:hash(newPointer)};
 const sourceBinding=sourceProof?{
  ...(scope?{transitionSourceScope:scope}:{}),
  transitionSourceSha256:f.api.control.sourceOrdinaryDigest(legacySource??await transitionInventory(f,base),{candidateId,scope}),
 }:{};
 let receipt=await control.write(state);
 for(const phase of ['candidate','key-ready'])receipt=await control.write({...state,phase,candidate},receipt);
 receipt=await control.write({...state,phase:'key-ready',candidate,transition,...sourceBinding},receipt);
 if(ready)receipt=await control.write({...state,phase:'key-ready',candidate,transition,transitionReady,...sourceBinding},receipt);
 if(phase==='published')await control.write({...state,phase,candidate,transition,...(ready?{transitionReady}:{}),...sourceBinding},receipt);
 if(legacyRelocated){
  f.memory.mkdir(stableRoot);
  await f.memory.io.rename(path.join(legacyRoot,'prior.txt'),path.join(stableRoot,'prior.txt'));
  await f.memory.io.unlink(legacyRoot);
 }
 await owner.release();
 f.nativeBindings.tree.createPreserved=()=>({async capture(root){
  const rows=await transitionInventory(f,root);
  return {files:rows.sourceFiles,directories:rows.sourceDirectories.map(row=>row.path).filter(Boolean),release(){}};
 },async verify(){return {};}});
 const intentFile=path.join(controlRoot,'maintenance-v1.json'),resultFile=path.join(controlRoot,f.api.result.NAME);
 const before={intent:await f.memory.io.readFile(intentFile),claim:await f.memory.io.readFile(claim.file)};
 return {f,base,claim,intentFile,manifestFile,headerFile,sourceHeaderFile,backupFile,resultFile,controlRoot,oldRoot,candidateRoot,
  transition,transitionReady,ordinaryFile,legacyRoot,stableRoot,newPointer,oldPointer,before};
}
test('prepared takeover selects inverse on exact old authority and keeps both pending records',async()=>{
 for(const options of [{},{legacy:true}]){
  const m=await transitionModel(options),{f}=m,disposition='inverse';
  let calls=0;
  f.nativeBindings.skillOwner=options=>{
   assert.equal(options.sourceKeys,options.targetKeys);
   return {async recoverPreparedTransition({state,disposition:received,assertUnchanged}){
    calls++;assert.equal(received,disposition);assert.deepEqual(dto(state.transition),m.transition);
    assert.equal(await assertUnchanged(),true);assert.equal(f.servers.at(-1).listening,true);
    return {operationId:m.transition.operationId,disposition:received};
   }};
  };
  const ownership={...f.api.ownership,acquire(roots,opts){
   assert.deepEqual(dto(opts),{preserveRuntime:true});
   return f.api.ownership.acquire(roots);
  }};
  const factory=f.api.host.create({proc:f.proc,bindings:{...f.bindings,ownership}});
  const result=await factory.recoverPreparedTransition({base:m.base});
  assert.equal(calls,1);assert.equal(result.disposition,disposition);assert.equal(result.ownerReplayVerified,true);
  assert.equal(result.intentRetained,true);assert.equal(result.claimRetained,true);assert.equal(result.maintenanceOutcome,'pending');
  assert.equal(result.candidateProofVerified,false);
  assert.equal(result.sourceProofVerified,true);
  assert.equal(result.authority.sha256,m.oldPointer===null?null:hash(m.oldPointer));
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
  assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
  assert.equal(f.memory.exists(m.resultFile),false);assert.equal(f.servers.at(-1).closeCalls,1);
 }
});
test('legacy inverse crosses the old-to-stable relocation without ignoring an existing ordinary parent',async()=>{
 for(const fault of ['none','existing-parent','foreign-child']){
  const m=await transitionModel({legacy:true,legacyRelocated:true,existingControl:fault==='existing-parent'}),{f}=m;
  let replayed=0;
  f.nativeBindings.skillOwner=()=>({async recoverPreparedTransition({state,disposition,assertUnchanged}){
   replayed++;assert.equal(disposition,'inverse');assert.equal(state.transitionSourceScope.nativePath,'migrations/skill-backups');
   assert.deepEqual([...state.transitionSourceScope.createdParents],['.work-data','.work-data/generations']);
   assert.equal(f.memory.exists(m.legacyRoot),false);assert.equal(await assertUnchanged(),true);
   f.memory.mkdir(m.legacyRoot);
   await f.memory.io.rename(path.join(m.stableRoot,'prior.txt'),path.join(m.legacyRoot,'prior.txt'));
   await f.memory.io.unlink(m.stableRoot);
   return {operationId:state.transition.operationId,disposition};
  }});
  if(fault==='existing-parent')f.memory.replaceDirectory(m.controlRoot);
  if(fault==='foreign-child')f.memory.put(path.join(path.dirname(m.legacyRoot),'foreign.txt'),'UNBOUND ORDINARY DATA');
  const recovery=f.factory.recoverPreparedTransition({base:m.base});
  if(fault==='none'){
   const result=await recovery;
   assert.equal(result.sourceProofVerified,true);assert.equal(result.maintenanceOutcome,'pending');
   assert.equal(await f.memory.io.readFile(path.join(m.legacyRoot,'prior.txt'),'utf8'),'LEGACY ORIGINAL');
   assert.equal(replayed,1);
  }else{
   await assert.rejects(recovery,{code:'work_data_adapter.transition_recovery_source_changed'});
   assert.equal(replayed,0);assert.equal(f.memory.exists(m.legacyRoot),false);
  }
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
  assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 }
});
test('inverse replay verifies the original ordinary witness, keeps the ready shadow and refuses a same-byte replacement',async()=>{
 for(const fault of ['none','before','after','foreign-shadow','shadow-before','shadow-after']){
  const m=await transitionModel({sourceProof:true,ready:true}),{f}=m;
  let replayed=0,captures=0,candidateCaptures=0;
  const replace=async()=>{
   const bytes=await f.memory.io.readFile(m.ordinaryFile);
   await f.memory.io.rename(m.ordinaryFile,path.join(f.paths.temp,'retained-original'));
   f.memory.put(m.ordinaryFile,bytes);
  };
  f.nativeBindings.tree.createPreserved=()=>({async capture(root){
   if(root===m.candidateRoot)return {candidate:true,order:++candidateCaptures,release(){}};
   captures++;assert.equal(root,m.base);
   const rows=await transitionInventory(f,root);
   return {files:rows.sourceFiles,directories:rows.sourceDirectories.map(row=>row.path).filter(Boolean),release(){}};
  },async verify(captured){
   if(!captured.candidate)return {};
   const altered=fault===(captured.order===1?'shadow-before':'shadow-after');
   return {sha256:m.transitionReady.targetSha256,nativeSha256:altered?'9'.repeat(64):m.transitionReady.targetNativeSha256};
  }});
  f.nativeBindings.skillOwner=()=>({async recoverPreparedTransition({state,disposition,assertUnchanged}){
   replayed++;assert.equal(disposition,'inverse');assert.equal(await assertUnchanged(),true);
   if(fault==='after')await replace();
   return {operationId:state.transition.operationId,disposition};
  }});
  if(fault==='before')await replace();
  if(fault==='foreign-shadow'){
   const outside=path.join(path.dirname(m.candidateRoot),'c'.repeat(48));f.memory.mkdir(outside);
   f.memory.put(path.join(outside,'extra'),'UNOWNED GENERATION');
  }
  const candidate=await f.memory.io.readFile(m.headerFile),recovery=f.factory.recoverPreparedTransition({base:m.base});
  if(fault==='none'){
   const result=await recovery;
   assert.equal(result.sourceProofVerified,true);assert.equal(result.candidateProofVerified,true);assert.equal(result.maintenanceOutcome,'pending');
   assert.equal(result.claimRetained,true);assert.equal(result.intentRetained,true);
  }else await assert.rejects(recovery,{code:'work_data_adapter.transition_recovery_'+(fault.startsWith('shadow-')?'candidate_changed':'source_changed')});
  assert.equal(replayed,['none','after','shadow-after'].includes(fault)?1:0);
  assert.equal(captures,replayed?2:1);
  assert.equal(candidateCaptures,({none:2,after:1,'shadow-before':1,'shadow-after':2})[fault]||0);
  assert.deepEqual(await f.memory.io.readFile(m.headerFile),candidate);
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
  assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
  assert.equal(f.memory.exists(m.resultFile),false);
 }
});
test('ready forward takeover recaptures the candidate before and after replay and refuses altered native metadata',async()=>{
 for(const changed of ['neither','before','after']){
  const m=await transitionModel({published:true,ready:true}),{f}=m;
  let captured=0,released=0,ownerCalls=0;
  const preservedHeaderBytes=[];
  const open=f.memory.io.open;
  f.memory.io.open=async(file,flags)=>{
   assert.notEqual(file,m.headerFile,'a ready header never uses the ordinary file reader');
   return open(file,flags);
  };
  f.nativeBindings.readRecoveryControl=async file=>{
   assert.equal(file,m.headerFile);
   const data=await f.memory.io.readFile(file);preservedHeaderBytes.push(data);return data;
  };
  const snapshots=new Set();
  f.nativeBindings.tree.createPreserved=options=>{
   assert.equal(options.assertExclusiveSync(options.ownership),true);
   return {async capture(root){
    assert.equal(root,m.candidateRoot);
    const snapshot={order:++captured,release(){released++;}};snapshots.add(snapshot);return snapshot;
   },async verify(snapshot){
    assert.equal(snapshots.has(snapshot),true);
    const altered=changed===(snapshot.order===1?'before':'after');
    return {sha256:m.transitionReady.targetSha256,nativeSha256:altered?'9'.repeat(64):m.transitionReady.targetNativeSha256};
   }};
  };
  f.nativeBindings.skillOwner=()=>({async recoverPreparedTransition({state,disposition,assertUnchanged}){
   ownerCalls++;assert.equal(captured,1);assert.equal(released,1);assert.equal(await assertUnchanged(),true);
   return {operationId:state.transition.operationId,disposition};
  }});
  const pending=f.factory.recoverPreparedTransition({base:m.base});
  if(changed==='neither')assert.equal((await pending).candidateProofVerified,true);
  else await assert.rejects(pending,{code:'work_data_adapter.transition_recovery_candidate_changed'});
  assert.equal(ownerCalls,changed==='before'?0:1);
  assert.equal(captured,changed==='before'?1:2);assert.equal(released,captured);
  assert.ok(preservedHeaderBytes.length>=2);
  assert.ok(preservedHeaderBytes.every(data=>data.every(byte=>byte===0)));
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
  assert.equal(f.memory.exists(m.resultFile),false);
 }
});
test('a ready recovery header cannot fall back or follow a same-byte pathname replacement',async()=>{
 for(const fault of ['reader-unavailable','replaced']){
  const m=await transitionModel({published:true,ready:true}),{f}=m;
  const open=f.memory.io.open;
  f.memory.io.open=async(file,flags)=>{assert.notEqual(file,m.headerFile);return open(file,flags);};
  let read;
  if(fault==='reader-unavailable')delete f.nativeBindings.readRecoveryControl;
  else f.nativeBindings.readRecoveryControl=async file=>{
   read=await f.memory.io.readFile(file);
   await f.memory.io.rename(file,path.join(f.paths.temp,'held-ready-header'));
   f.memory.put(file,read);return read;
  };
  f.nativeBindings.skillOwner=()=>{assert.fail('no owner replay without the exact preserved header');};
  await assert.rejects(f.factory.recoverPreparedTransition({base:m.base}),error=>
   error.code==='work_data_host.transition_recovery_file_invalid'
   &&error.cause?.code===(fault==='reader-unavailable'?'work_data_adapter.transition_recovery_header_reader_unavailable':'work_data_host.transition_recovery_file_changed'));
  if(read)assert.ok(read.every(byte=>byte===0));
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
  assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 }
});
function verifiedSettlement(m,{specialReadOnly=true}={}){
 const {f}=m;
 f.nativeBindings.tree.createPreserved=()=>({async capture(){return {release(){}};},async verify(){
  return {sha256:m.transitionReady.targetSha256,nativeSha256:m.transitionReady.targetNativeSha256};
 }});
 f.nativeBindings.skillOwner=()=>({async recoverPreparedTransition({state,disposition,assertUnchanged}){
  assert.equal(await assertUnchanged(),true);return {operationId:state.transition.operationId,disposition};
 },async verifyPublished({expected}){
  assert.equal(expected.root,m.candidateRoot);
  return {entries:1,generationId:expected.id,mode:expected.mode,readOnly:specialReadOnly,rootId:'4'.repeat(24),storeId:'5'.repeat(48),volume:'volume'};
 }});
}
test('forward settlement verifies domain ownership and persists result before completing the same intent',async()=>{
 const m=await transitionModel({published:true,ready:true}),{f}=m,renames=[];
 const headerBefore=await f.memory.io.readFile(m.headerFile),headerInode=f.memory.stat(m.headerFile).ino;
 const oldBefore=await f.memory.io.readFile(m.ordinaryFile),oldInode=f.memory.stat(m.ordinaryFile).ino;
 verifiedSettlement(m);
 const rename=f.memory.io.rename;
 f.memory.io.rename=async(from,to)=>{
  if(to===m.resultFile||to===m.intentFile){
   renames.push(to);
   if(to===m.intentFile){
    assert.equal(JSON.parse(await f.memory.io.readFile(m.intentFile)).phase,'key-ready');
    assert.equal(f.api.result.decode(await f.memory.io.readFile(m.resultFile)).state,'published');
   }
  }
  return rename(from,to);
 };
 const final=await f.factory.recoverPreparedTransition({base:m.base,settleForward:true});
 assert.equal(final.candidateProofVerified,true);assert.equal(final.maintenanceOutcome,'result-durable');
 assert.equal(final.intentRetained,true);assert.equal(final.claimRetained,true);
 assert.deepEqual(renames,[m.resultFile,m.intentFile]);
 assert.deepEqual(JSON.parse(await f.memory.io.readFile(m.intentFile)),{...JSON.parse(m.before.intent),phase:'complete'});
 const result=f.api.result.decode(await f.memory.io.readFile(m.resultFile));
 assert.deepEqual(dto(result.authority),dto(final.authority));
 assert.equal(result.id,m.claim.record.id);assert.equal(result.backup.path,m.backupFile);
 assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 assert.deepEqual(await f.memory.io.readFile(m.headerFile),headerBefore);assert.equal(f.memory.stat(m.headerFile).ino,headerInode);
 assert.deepEqual(await f.memory.io.readFile(m.ordinaryFile),oldBefore);assert.equal(f.memory.stat(m.ordinaryFile).ino,oldInode);
 const other=f.api.host.create({proc:f.proc,bindings:f.bindings}),before=await f.memory.io.readFile(m.resultFile);
 assert.equal((await other.recoverPreparedTransition({base:m.base,settleForward:true})).maintenanceOutcome,'result-durable');
 assert.deepEqual(await f.memory.io.readFile(m.resultFile),before);
 assert.deepEqual(renames,[m.resultFile,m.intentFile]);
});
test('forward settlement resumes a same-job result after failure before the intent stage starts',async()=>{
 const m=await transitionModel({published:true,ready:true}),{f}=m,open=f.memory.io.open;
 verifiedSettlement(m);
 const injected=Object.assign(Error('modeled process interruption before complete-intent stage'),{code:'EIO'});
 f.memory.io.open=async(file,flags)=>{
  if(flags==='wx'&&path.basename(file).startsWith('.maintenance-v1.stage-'))throw injected;
  return open(file,flags);
 };
 await assert.rejects(f.factory.recoverPreparedTransition({base:m.base,settleForward:true}),error=>error===injected);
 assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
 const result=await f.memory.io.readFile(m.resultFile),resultId=f.memory.stat(m.resultFile).ino;
 f.memory.io.open=open;
 const other=f.api.host.create({proc:f.proc,bindings:f.bindings});
 assert.equal((await other.recoverPreparedTransition({base:m.base,settleForward:true})).maintenanceOutcome,'result-durable');
 assert.deepEqual(await f.memory.io.readFile(m.resultFile),result);
 assert.equal(f.memory.stat(m.resultFile).ino,resultId);
 assert.equal(JSON.parse(await f.memory.io.readFile(m.intentFile)).phase,'complete');
 assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
});
test('forward settlement refuses inverse authority, missing readiness, and unverified special readback',async()=>{
 for(const [fault,options] of [['inverse',{ready:true}],['not-ready',{published:true}],['special',{published:true,ready:true}]]){
  const m=await transitionModel(options),{f}=m;
  verifiedSettlement(m,{specialReadOnly:false});
  await assert.rejects(f.factory.recoverPreparedTransition({base:m.base,settleForward:true}),{
   code:fault==='special'?'work_data_adapter.transition_recovery_owner_invalid'
    :fault==='not-ready'?'work_data_host.transition_recovery_candidate_unready':'work_data_host.transition_recovery_settlement_ineligible'});
  assert.equal(f.memory.exists(m.resultFile),false);
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 }
});
test('prepared takeover refuses a third pointer, a published intent on old authority, and invalid recovery evidence',async()=>{
 for(const fault of ['third-pointer','published-old','published-no-ready','inverse-no-proof','header','master','backup','stage','live-pid']){
  const m=await transitionModel({phase:fault==='published-old'?'published':'key-ready',published:fault==='published-no-ready',
   sourceProof:fault!=='inverse-no-proof'}),{f}=m;let calls=0;
  f.nativeBindings.skillOwner=()=>{calls++;throw Error('owner replay must remain uncalled');};
  const expected={
   'third-pointer':'work_data_host.transition_recovery_authority_mismatch','published-old':'work_data_host.transition_recovery_authority_mismatch',
   'published-no-ready':'work_data_host.transition_recovery_candidate_unready',
   'inverse-no-proof':'work_data_host.transition_recovery_source_unready',
   header:'work_data_host.transition_recovery_header_invalid',master:'work_data_adapter.transition_recovery_key_changed',
   backup:'work_data_result.backup_changed',stage:'work_data_host.transition_recovery_stage_pending','live-pid':'work_data_host.transition_recovery_process_pending',
  };
  if(fault==='third-pointer')f.memory.put(m.manifestFile,m.oldPointer.replace('"schema":1','"schema": 1'));
  if(fault==='header')f.memory.put(m.headerFile,'{}');
  if(fault==='master')f.nativeBindings.protector.run=async(_,bytes)=>Buffer.from(bytes);
  if(fault==='backup')f.memory.put(m.backupFile,'CHANGED');
  if(fault==='stage')f.memory.put(path.join(m.controlRoot,'.active-v1.stage-untrusted'),'RETAIN');
  if(fault==='live-pid')f.proc.kill=()=>true;
  await assert.rejects(f.factory.recoverPreparedTransition({base:m.base}),{code:expected[fault]});
  assert.equal(calls,0,fault);assert.equal(f.servers.at(-1).closeCalls,1,fault);
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 }
});
test('prepared takeover rechecks replaced native inputs and retains an uncertain helper owner',async()=>{
 for(const fault of ['candidate-root','claim','helper']){
  const m=await transitionModel(),{f}=m;
  f.nativeBindings.skillOwner=()=>({async recoverPreparedTransition({assertUnchanged}){
   assert.equal(await assertUnchanged(),true);
   if(fault==='candidate-root')f.memory.replaceDirectory(m.candidateRoot);
   if(fault==='claim'){await f.memory.io.rename(m.claim.file,m.claim.file+'.held');f.memory.put(m.claim.file,m.before.claim);}
   if(fault==='helper')throw Object.assign(Error('modeled unconfirmed helper'),{helperMayStillRun:true});
   await assertUnchanged();
   assert.fail('replaced evidence must refuse');
  }});
  await assert.rejects(f.factory.recoverPreparedTransition({base:m.base}),error=>fault==='helper'?
   error.ownershipRetained===true:error.code==='work_data_host.transition_recovery_'+(fault==='claim'?'claim_changed':'evidence_changed'));
  assert.equal(f.servers.at(-1).closeCalls,fault==='helper'?0:1,fault);
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);
 }
});
test('C11 enable and disable use two real claim callbacks then retire exact intent before claim',async()=>{
 for(const operation of ['enable','disable']){
  const m=await model({operation}),{f}=m,unlinks=[],unlink=f.memory.io.unlink;
  f.memory.io.unlink=async file=>{unlinks.push(file);if(file===m.intentFile)assert.equal(f.servers.at(-1).closeCalls,0);await unlink(file);};
  const result=await f.factory.recoverCompletedIntent({base:m.base});
  assert.equal(m.observed.seals,2);assert.deepEqual(unlinks,[m.intentFile,m.claim.file]);
  assert.equal(result.completionEvidence,'existing-durable-result');assert.equal(result.intentRetired,true);assert.equal(result.claimRetired,true);assert.equal(result.currentSourceReadable,true);assert.equal(result.sourceProofPhase,'before-intent-retirement');
  assert.deepEqual(dto(result.authority),m.authority);assert.deepEqual(await f.memory.io.readFile(m.resultFile),m.before.result);assert.deepEqual(await f.memory.io.readFile(m.backupFile),m.before.backup);
  assert.equal(f.servers.at(-1).closeCalls,1);assert.equal(f.servers.at(-1).listening,false);
 }
});
test('C11 last intent capture runs inside genuine claim mutation gate',async()=>{
 const m=await model(),{f}=m,open=f.memory.io.open;let blocked=0;
 f.memory.io.open=async(file,flags,...rest)=>{
  if(file===m.intentFile&&flags==='r'&&m.observed.seals===2){
   await assert.rejects(m.claim.owner.write({...m.claim.record},m.claim.receipt),{code:'work_data_claim.busy'});
   await assert.rejects(m.claim.owner.remove(m.claim.receipt),{code:'work_data_claim.busy'});
   await assert.rejects(m.claim.owner.recoverCompleted(m.claim.receipt,async()=>true),{code:'work_data_claim.busy'});
   await assert.rejects(m.claim.owner.recoverSource(m.claim.receipt,async()=>({})),{code:'work_data_claim.busy'});blocked++;
  }return open(file,flags,...rest);
 };
 await f.factory.recoverCompletedIntent({base:m.base});assert.ok(blocked>=3);assert.equal(m.observed.seals,2);
});
test('C11 C10 missing result, bad backup, noncomplete, unknown stage and wrong proof refuse unchanged',async()=>{
 for(const fault of ['no-result','backup','phase','stage','source-authority','header','authority','claim']){
  const m=await model(),{f}=m;
  if(fault==='no-result')await f.memory.io.unlink(m.resultFile);
  if(fault==='backup')f.memory.put(m.backupFile,'DIFFERENT SAME CURRENT FILE');
  if(fault==='phase'){const state=JSON.parse(m.before.intent);state.phase='published';f.memory.put(m.intentFile,JSON.stringify(state));}
  if(fault==='stage')f.memory.put(path.join(m.controlRoot,'.maintenance-v1.stage-unknown'),'KEEP');
  if(fault==='source-authority'){const result=dto(m.result);result.sourceAuthority={...result.sourceAuthority,mode:'encrypted'};f.memory.put(m.resultFile,JSON.stringify(result));}
  if(fault==='header')f.memory.put(m.headerFile,JSON.stringify({schema:1,instanceId:'',protectedKey:''}));
  if(fault==='authority')f.nativeBindings.manifest.create=()=>({readActive:async()=>({...m.authority,generation:9,root:m.candidateRoot,proof:{sha256:m.authority.sha256}})});
  if(fault==='claim'){const value=JSON.parse(m.before.claim);value.operation='export';f.memory.put(m.claim.file,JSON.stringify(value));}
  const intent=await f.memory.io.readFile(m.intentFile),claim=await f.memory.io.readFile(m.claim.file);
  await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}));
  assert.deepEqual(await f.memory.io.readFile(m.intentFile),intent,fault);assert.deepEqual(await f.memory.io.readFile(m.claim.file),claim,fault);assert.equal(m.observed.seals,0,fault);
  assert.equal(f.servers.at(-1).closeCalls,1,fault);
 }
});
test('C11 does not retire a complete intent whose prepared pointer digest differs from authority',async()=>{
 const m=await model(),state=JSON.parse(m.before.intent);
 state.candidate.pointerSha256='0'.repeat(64);
 m.f.memory.put(m.intentFile,JSON.stringify(state));
 m.before.intent=await m.f.memory.io.readFile(m.intentFile);
 await assert.rejects(m.f.factory.recoverCompletedIntent({base:m.base}),{code:'work_data_host.complete_recovery_authority_mismatch'});
 await preserved(m);
 assert.equal(m.observed.seals,0);
});
test('C11 unequal second profile, key refusal and claim replacement preserve intent',async()=>{
 for(const fault of ['profile','key','claim']){
  const m=await model(),{f}=m;
  f.nativeBindings.fullSnapshot.create=options=>({seal:async()=>{
   if(fault==='key')throw Object.assign(Error('bad key'),{code:'work_data_key.invalid'});
   const value=await m.seal(options);
   if(fault==='claim')f.memory.put(m.claim.file,JSON.stringify({...m.claim.record,nonce:'f'.repeat(64)}));
   if(fault==='profile'&&m.observed.seals===2)value.sourceProof.sha256='e'.repeat(64);return value;
  }});
  await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}));assert.deepEqual(await f.memory.io.readFile(m.intentFile),m.before.intent);
  assert.equal(f.servers.at(-1).closeCalls,1);if(fault!=='claim')await preserved(m);
 }
});
test('C11 missing or unreadable key capture returns a typed private error and preserves metadata',async()=>{
 for(const fault of ['missing','lstat','open','read','json']){
  const m=await model(),{f}=m,cause=Object.assign(Error('PRIVATE key path '+m.headerFile),{code:fault==='read'?'EIO':'EACCES'});let fileClosed=false;
  if(fault==='missing')await f.memory.io.unlink(m.headerFile);
  if(fault==='lstat'){const lstat=f.memory.io.lstat;f.memory.io.lstat=async(file,...args)=>{if(file===m.headerFile)throw cause;return lstat(file,...args);};}
  if(fault==='open'||fault==='read'){const open=f.memory.io.open;f.memory.io.open=async(file,...args)=>{
   if(file===m.headerFile&&fault==='open')throw cause;
   const handle=await open(file,...args);if(file===m.headerFile){handle.read=async()=>{throw cause;};const close=handle.close;handle.close=async()=>{fileClosed=true;return close();};}return handle;
  };}
  if(fault==='json')f.memory.put(m.headerFile,'{"PRIVATE_KEY_CONTENT":');
  await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}),error=>{
   assert.equal(error.code,fault==='json'?'work_data_host.complete_recovery_header_invalid':'work_data_host.complete_recovery_file_invalid');
   if(fault==='missing')assert.equal(error.cause?.code,'ENOENT');else if(fault==='json')assert.equal(error.cause?.name,'SyntaxError');else assert.equal(error.cause,cause);
   assert.equal(String(error.stack).includes(m.headerFile),false);assert.equal(String(error.stack).includes('PRIVATE_KEY_CONTENT'),false);return true;
  });
  await preserved(m);assert.equal(m.observed.seals,0);assert.equal(f.servers.at(-1).closeCalls,1);if(fault==='read')assert.equal(fileClosed,true);
 }
});
test('C11 key read uncertainty remains in the typed error cause and retains the genuine owner',async()=>{
 const m=await model(),{f}=m,cause=Object.assign(Error('PRIVATE uncertain key read '+m.headerFile),{code:'EIO',ownershipRetained:true,helperMayStillRun:true}),open=f.memory.io.open;
 f.memory.io.open=async(file,...args)=>{const handle=await open(file,...args);if(file===m.headerFile)handle.read=async()=>{throw cause;};return handle;};
 await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}),error=>error.ownershipRetained===true&&error.cause?.code==='work_data_host.complete_recovery_file_invalid'&&error.cause.cause===cause);
 await preserved(m);assert.equal(m.observed.seals,0);assert.equal(f.servers.at(-1).closeCalls,0);assert.ok(f.holds.some(row=>row.refs>0));
});
test('C11 post intent unlink flush failure leaves durable result and claim without restoring intent',async()=>{
 for(const uncertain of [false,true]){
  const m=await model(),{f}=m,cause=Object.assign(Error('flush failure'),{code:'work_data_manifest.flush_refused',helperMayStillRun:uncertain});
  const unlink=f.memory.io.unlink;let deleted=false;
  f.memory.io.unlink=async file=>{await unlink(file);if(file===m.intentFile){deleted=true;f.state.flushFailure=cause;}};
  await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}),error=>uncertain?error.ownershipRetained===true:error.code==='work_data_claim.recovery_unverified');
  assert.equal(deleted,true);assert.equal(f.memory.exists(m.intentFile),false);assert.deepEqual(await f.memory.io.readFile(m.claim.file),m.before.claim);assert.deepEqual(await f.memory.io.readFile(m.resultFile),m.before.result);
  assert.equal(f.servers.at(-1).closeCalls,uncertain?0:1);if(uncertain)assert.ok(f.holds.some(row=>row.refs>0));
 }
});
test('C11 clear-only snapshot cleanup retains real owner through claim verification cause wrapper',async()=>{
 const m=await model(),{f}=m,cause=Object.assign(Error('clear-only cleanup'),{code:'work_data_full.release_failed',helperMayStillRun:false,ownershipRetained:true});
 f.nativeBindings.fullSnapshot.create=()=>({seal:async()=>{throw cause;}});
 await assert.rejects(f.factory.recoverCompletedIntent({base:m.base}),error=>error.ownershipRetained===true&&error.cause?.code==='work_data_claim.recovery_unverified'&&error.cause.cause===cause);
 await preserved(m);assert.equal(f.servers.at(-1).closeCalls,0);assert.ok(f.holds.some(row=>row.refs>0));
});
test('C11 independent claim adapter unclosed helper failure after intent retirement retains source',async()=>{
 const m=await model(),{f}=m,native=f.unclosedNativeFlush();let original;
 f.state.claimFlush=async()=>{try{return await native.flush(['C:\\ruyi-c11-native-flush-model']);}catch(error){original=error;throw error;}};
 const pending=f.factory.recoverCompletedIntent({base:m.base});pending.catch(()=>{});
 for(let index=0;index<200&&!f.timeouts.some(row=>row.ms===20000);index++)await tick();
 assert.ok(f.timeouts.some(row=>row.ms===20000));native.fail();native.expire();
 await assert.rejects(pending,error=>error.ownershipRetained===true&&error.cause?.code==='work_data_claim.remove_failed'&&error.cause.cause===original);
 assert.equal(original.code,'work_data_manifest.flush_pipe');assert.equal(original.helperMayStillRun,true);
 assert.equal(f.memory.exists(m.intentFile),false);assert.equal(f.memory.exists(m.claim.file),false);assert.deepEqual(await f.memory.io.readFile(m.resultFile),m.before.result);
 assert.equal(f.servers.at(-1).closeCalls,0);assert.ok(f.holds.some(row=>row.refs>0));
});
test('C11 actual owner-close failure never retries or returns successful retirement',async()=>{
 const m=await model({manualClose:true}),{f}=m,pending=f.factory.recoverCompletedIntent({base:m.base});pending.catch(()=>{});
 for(let index=0;index<200&&(f.servers.length<2||f.servers.at(-1).closeCalls!==1);index++)await tick();
 assert.equal(f.servers.length,2);
 assert.equal(f.servers.at(-1).closeCalls,1);f.servers.at(-1).finishClose(Error('modeled close failure'));
 await assert.rejects(pending,error=>error.ownershipRetained===true);assert.equal(f.servers.at(-1).closeCalls,1);
 assert.equal(f.memory.exists(m.intentFile),false);assert.equal(f.memory.exists(m.claim.file),false);assert.ok(f.holds.some(row=>row.refs>0));
});
