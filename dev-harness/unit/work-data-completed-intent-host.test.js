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
