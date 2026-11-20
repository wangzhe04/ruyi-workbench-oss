'use strict';
// Actual snapshot/recovery/control/tree owners and real temporary files. Native
// protection, flush, new-process verification and migration are explicit seams;
// these tests do not establish native or process integration.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),draft=path.join(repo,'ruyi-workbench/app/src');
const {fixture}=require(path.join(repo,'dev-harness/lib/work-data-full-snapshot-fixture'));
const password='synthetic operation password only',hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function setup(t,options={}){
 const f=await fixture(t);await f.write('config.json','{ "workDataEncryptionV1": false, "label":"SYNTHETIC_PRIVATE" }');
 await f.write('uploads/payload.bin',Buffer.from([0,255,99]));await fsp.mkdir(path.join(f.base,'uploads/empty'));
 // Seam over the module's own io: only the backup package open/write is faulted,
 // so every other read stays the real filesystem owner.
 if(options.statfs||options.backupOpenFails||options.backupWriteFails)f.context.require=name=>{
  if(name!=='node:fs/promises')return require(name);
  const api=options.statfs?{...fsp,statfs:options.statfs}:{...fsp};
  if(!options.backupOpenFails&&!options.backupWriteFails)return api;
  return {...api,open:async(file,flags,mode)=>{
   const target=String(file),isPackage=flags==='wx'&&target.endsWith('.ruyi-backup');
   if(isPackage&&options.backupOpenFails)throw Object.assign(Error('simulated backup open refusal'),{code:'EACCES'});
   const handle=await api.open(file,flags,mode);
   if(isPackage&&options.backupWriteFails)return {stat:opts=>handle.stat(opts),writeFile:async()=>{throw Object.assign(Error('simulated backup write refusal'),{code:'EIO'});},sync:()=>handle.sync(),close:()=>handle.close()};
   return handle;
  }};
 };
 f.context.VERSION='3.0.1';f.context.ExternalBotCredentials=f.api.ExternalBotCredentials;
 vm.runInContext(fs.readFileSync(path.join(draft,'13aj-work-data-control.js'),'utf8')+'\n'+fs.readFileSync(path.join(draft,'01ae-work-data-maintenance-result.js'),'utf8')+'\n'+fs.readFileSync(process.env.RUYI_COLD_OPERATIONS_SOURCE||path.join(draft,'13ak-work-data-cold-operations.js'),'utf8'),f.context);
 const api=vm.runInContext('({WorkDataColdOperations,WorkDataTree,WorkDataRecovery,WorkDataManifest})',f.context);
 const events=[],owners=[],sourceOwner={roots:[f.base]},backupDirectory=path.join(f.root,'backups');await fsp.mkdir(backupDirectory);
 let backupFlushes=0;
 const context={id:'a'.repeat(48),base:f.base,operation:'export',password,expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null},ownership:sourceOwner,assertExclusive:owner=>owner===sourceOwner};
 let x;
 const host={
  async acquire(roots){const owner={roots,released:false,async release(){assert.equal(owner.released,false);owner.released=true;events.push('release:'+path.basename(roots[0]));}};owners.push(owner);events.push('acquire:'+path.basename(roots[0]));return owner;},
  async flush(roots){events.push('flush:'+path.basename(roots[0]));
   if(options.flush)await options.flush({roots,x,f});
   if(options.failResultFlush&&path.basename(roots[0])==='.work-data'&&(await fsp.readdir(roots[0])).some(name=>name.startsWith('.maintenance-result-v1.stage-')))throw Error('simulated result flush refusal');
   // Opt-in: refuse the first durability flush of the backup directory only, after
   // the package bytes are already on disk (the earlier volume probe is not it).
   if(options.failBackupFlush&&path.basename(roots[0])==='backups'&&fs.existsSync(path.join(roots[0],'ruyi-work-data-'+'a'.repeat(48)+'.ruyi-backup'))&&++backupFlushes===1)throw options.failBackupFlush===true?Error('simulated backup flush refusal'):options.failBackupFlush();},
  async verifyFresh(value){events.push('fresh');assert.ok(owners.every(owner=>owner.released));const own={roots:[value.target]};
   const full=f.api.WorkDataFullSnapshot.create({base:value.target,ownership:own,assertExclusive:owner=>owner===own,protector:f.a,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});
   const sealed=await full.seal({password:value.password,appVersion:'3.0.1',generation:value.generation??0});assert.ok(sealed.files>=2);
   if(options.verifyFresh)await options.verifyFresh({f,context,events,value});return options.freshResult??true;},
  async verifyDisposableNativeTree(value){events.push('native-tree');assert.ok(owners.some(owner=>!owner.released&&owner===value.ownership));return options.nativeResult??true;},
  async captureRehearsal({target,ownership,assertExclusive}){const tree=api.WorkDataTree.create(),captured=await tree.capture(target);assert.equal(assertExclusive(ownership),true);return {...captured,async verify(owner){assert.equal(assertExclusive(owner),true);await tree.verify(captured);if(options.rehearsalVerify) return options.rehearsalVerify();return true;},release(){events.push('rehearsal-release');captured.release();if(options.rehearsalRelease) return options.rehearsalRelease();}};},
  fullSnapshot(base,ownership,assertExclusive,{onNativeCause}){events.push('snapshot-host');if(options.snapshotFactory)return options.snapshotFactory({base,ownership,assertExclusive,onNativeCause,f});const protector={supported:()=>f.context.LocalSecretCrypto.supported(),async run(...args){try{return await f.context.LocalSecretCrypto.run(...args);}catch(cause){onNativeCause(cause);throw cause;}}};return f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});},
  migrationFactory(args){events.push('migration');if(typeof options.migration!=='function')throw Error('migration must not run for these operations');return options.migration(x,args);},
  progress(value){events.push(value.phase);},helperMayStillRun:()=>options.helperMayStillRun===true,
 };
 const operation=api.WorkDataColdOperations.create(host);
 // 151 阶段 3A(W7):演练在数据根旁边(同卷)的产品私有目录里,不在备份文件夹里。
 x={f,api,host,context,operation,events,owners,backupDirectory,rehearsal:path.join(path.dirname(f.base),'.ruyi-work-data-rehearsal-'+context.id),backupFile:path.join(backupDirectory,'ruyi-work-data-'+context.id+'.ruyi-backup')};
 return x;
}
// Bounded handoff capability as 13ai issues it. `finish` observes the real files at
// the instant it is called, so ordering claims are evidence rather than narration.
function withClaim(x,options={}){
 const events=[],observed={};
 const resultFile=path.join(x.f.base,'.work-data','maintenance-result-v1.json'),intentFile=path.join(x.f.base,'.work-data','maintenance-v1.json');
 const api={
  async finish(){events.push('finish');observed.finish={result:fs.existsSync(resultFile),intent:fs.existsSync(intentFile)};
   if(options.failFinish)throw Error('synthetic claim finish refusal');},
  async abandon(){events.push('abandon');observed.abandon={backups:(await fsp.readdir(x.backupDirectory)).length};
   if(options.failAbandon)throw Error('synthetic claim abandon refusal');},
 };
 x.claim={events,observed};
 x.context.claim=Object.freeze({finish:()=>api.finish(),abandon:()=>api.abandon()});
 return x;
}
// The worker validates and pins its upload before invoking cold operations.
// This fixture captures that already-validated DTO once from the real held file;
// later substitution must not refresh it. The worker/broker boundary is tested separately.
async function bindRestoreUpload(x,paths){
 assert.equal(x.context.upload,undefined,'fixture handoff can only be issued once');
 const named=await fsp.lstat(paths.uploadFile,{bigint:true}),handle=await fsp.open(paths.uploadFile,'r');
 let first,bytes;try{first=await handle.stat({bigint:true});assert.equal(first.isFile(),true);assert.equal(named.isSymbolicLink(),false);assert.equal(first.nlink,1n);bytes=await handle.readFile();const after=await handle.stat({bigint:true}),last=await fsp.lstat(paths.uploadFile,{bigint:true});for(const key of ['dev','ino','size','nlink','mtimeNs','ctimeNs']){assert.equal(named[key],first[key]);assert.equal(after[key],first[key]);assert.equal(last[key],first[key]);}assert.equal(bytes.length,Number(first.size));assert.equal(hash(bytes),paths.uploadSha256);}finally{await handle.close();}
 x.context.upload=Object.freeze({bytes:bytes.length,identity:Object.freeze({dev:String(first.dev),ino:String(first.ino)})});
 return paths;
}

test('export saves authenticated actual full package, restores and verifies it before exact disposable cleanup; source bytes stay unchanged',async t=>{
 const x=await setup(t),tree=x.api.WorkDataTree.create(),before=await tree.capture(x.f.base);t.after(()=>before.release());
 const result=await x.operation.execute(x.context);assert.equal(result.state,'verified');assert.equal(result.operation,'export');assert.equal(result.backup.path,x.backupFile);
 const saved=await fsp.readFile(x.backupFile);assert.equal(result.backup.sha256,hash(saved));assert.equal(saved.includes(Buffer.from('SYNTHETIC_PRIVATE')),false);
 const opened=await x.api.WorkDataRecovery.open(saved.toString('utf8'),password);try{assert.equal(opened.snapshot.files.find(row=>row.path==='config.json').data.toString(),'{ "workDataEncryptionV1": false, "label":"SYNTHETIC_PRIVATE" }');assert.ok(opened.snapshot.directories.includes('uploads/empty'));}finally{opened.release();}
 assert.equal(fs.existsSync(x.rehearsal),false);assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')));assert.ok(x.owners.every(owner=>owner.released));
 for(const row of before.files)assert.deepEqual(await fsp.readFile(path.join(x.f.base,...row.path.split('/'))),row.data);
 assert.ok(x.events.indexOf('snapshot')<x.events.indexOf('verify-backup'));assert.ok(x.events.indexOf('fresh')<x.events.indexOf('native-tree'));assert.equal(x.events.includes('migration'),false);
});
// 151 阶段 3A(W1/W7):改前断言「备份包与演练目录都留在原地」;现在没写 intent、源未改时,本次造出的两样东西按身份清掉,
// 失败被证明为自恢复(冷端可把服务交还原根)。源仍然不写 intent。
test('fresh-verifier failure removes this attempt\'s backup and rehearsal, writes no source intent and is self-recovered',async t=>{
 const x=await setup(t,{verifyFresh:async()=>{throw Error('cold validation refusal');}});
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'&&e.operationMayHaveExecuted===false;});
 assert.equal(fs.existsSync(x.backupFile),false);assert.equal(fs.existsSync(x.rehearsal),false);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
 assert.equal(x.operation.selfRecovered(error),true);assert.equal(error.selfRecovered,true);assert.equal(error.backupPath,undefined,'a removed package is no longer named');
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);assert.ok(x.owners.every(owner=>owner.released));assert.equal(x.events.includes('migration'),false);
});
test('rehearsal capability is required with no ordinary reader fallback',async t=>{
 const x=await setup(t),host={...x.host};delete host.captureRehearsal;
 assert.throws(()=>x.api.WorkDataColdOperations.create(host),{code:'work_data_setup.operation_host_invalid'});
});

test('rehearsal buffer release failure blocks removal and target close, and is attempted only once',async t=>{
 let attempts=0;const x=withClaim(await setup(t,{rehearsalRelease(){attempts++;throw Error('synthetic cleanup failure');}}));
 await assert.rejects(x.operation.execute(x.context),error=>error.helperMayStillRun===true&&error.cause?.code==='work_data_setup.rehearsal_cleanup_uncertain');
 assert.equal(attempts,1);assert.equal(fs.existsSync(x.rehearsal),true);assert.equal(x.owners.at(-1).released,false);assert.deepEqual(x.claim.events,[]);
 assert.equal(x.events.includes('migration'),false);
});

// 151 阶段 3A(W7):改前断言失败后演练目录仍在;现在成功路径的「放行删除」仍不被授权(不进原生普查),
// 但失败路径按 mkdir 身份把本次的明文演练整棵清掉。
test('non-true preserved rehearsal verification cannot authorize native census; the failure path still removes the rehearsal by identity',async t=>{
 const x=await setup(t,{rehearsalVerify:()=>({ok:true})});
 await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.rehearsal_changed'&&x.operation.selfRecovered(error));
 assert.equal(fs.existsSync(x.rehearsal),false);assert.equal(x.events.includes('native-tree'),false);assert.equal(x.events.includes('migration'),false);
});

test('rehearsal cleanup retains the original verifier failure when its buffer release also fails',async t=>{
 const primary=Error('synthetic original verifier failure'),secondary=Error('synthetic release failure');
 const x=await setup(t,{verifyFresh:async()=>{throw primary;},rehearsalRelease(){throw secondary;}});
 await assert.rejects(x.operation.execute(x.context),error=>error.helperMayStillRun===true&&error.cause?.cause?.cause===primary&&error.cause.cause.errors[1].cause===secondary);
 assert.equal(fs.existsSync(x.rehearsal),true);assert.equal(x.events.filter(value=>value==='rehearsal-release').length,1);
});

for(const kind of ['rejected','pending','getter'])test('nonvoid rehearsal release remains unknown without executing then: '+kind,async t=>{
 let traps=0;const x=withClaim(await setup(t,{rehearsalRelease(){
  if(kind==='rejected')return Promise.reject(Error('synthetic rejected close'));
  if(kind==='pending')return new Promise(()=>{});
  return Object.defineProperty({},'then',{get(){traps++;throw Error('getter');}});
 }}));
 await assert.rejects(x.operation.execute(x.context),error=>error.helperMayStillRun===true);
 assert.equal(traps,0);assert.equal(fs.existsSync(x.rehearsal),true);assert.equal(x.owners.at(-1).released,false);assert.deepEqual(x.claim.events,[]);
});

// 151 阶段 3A(W7):以下三件改前断言「失败后演练原样保留」。成功路径的放行判据不变(native-tree 何时调用、
// 是否进 migration 都照旧钉住);失败后演练目录本身是本次 mkdir 造的(身份对得上),整棵清掉,不再把明文留在盘上。
test('new verifier-created object refuses the success-path disposal; the failure path removes the whole owned rehearsal',async t=>{
 const x=await setup(t,{verifyFresh:async({value})=>fsp.writeFile(path.join(value.target,'foreign.bin'),'FOREIGN')});
 await assert.rejects(x.operation.execute(x.context),/preparation_failed/);assert.equal(fs.existsSync(x.rehearsal),false);assert.equal(x.events.includes('native-tree'),false);assert.equal(x.events.includes('migration'),false);
});
test('native namespace refusal blocks the success-path disposal; the failure path removes the owned rehearsal',async t=>{
 const x=await setup(t,{nativeResult:false});await assert.rejects(x.operation.execute(x.context),/preparation_failed/);assert.equal(fs.existsSync(x.rehearsal),false);assert.ok(x.events.includes('native-tree'));assert.equal(x.events.includes('migration'),false);
});
test('fresh verifier must return exact true; truthy receipt and undefined cannot authorize cleanup',async t=>{
 const x=await setup(t,{freshResult:{ok:true}});await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.fresh_verification_failed');assert.equal(fs.existsSync(x.rehearsal),false);assert.equal(x.events.includes('native-tree'),false);
});
test('backup directory cannot contain the source tree',async t=>{
 const x=await setup(t);x.context.paths.backupDirectory=x.f.root;await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.backup_directory_invalid');assert.deepEqual(x.events,[]);
});
test('backup substitution after fresh verification blocks any source intent or generation work',async t=>{
 const x=await setup(t,{verifyFresh:async({context})=>fsp.writeFile(path.join(context.paths.backupDirectory,'ruyi-work-data-'+context.id+'.ruyi-backup'),'substituted')});
 await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.backup_changed');assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);assert.equal(x.events.includes('migration'),false);
});
test('pending unknown stage blocks before snapshot and leaves exact stage and source untouched',async t=>{
 const x=await setup(t);await x.f.write('.work-data/.maintenance-v1.stage-'+ 'b'.repeat(48),'UNKNOWN');
 await assert.rejects(x.operation.execute(x.context),/intent_stage_pending/);assert.deepEqual(x.events,[]);assert.equal(fs.existsSync(x.backupFile),false);
});
test('authority legacy mode conflict refuses before package/native verification',async t=>{
 const x=await setup(t);x.context.expectedAuthority.mode='encrypted';await assert.rejects(x.operation.execute(x.context),/authority_changed/);assert.deepEqual(x.events,[]);assert.equal(fs.existsSync(x.backupFile),false);
});
test('restore wrong authenticated password refuses before backup and destination writes',async t=>{
 const x=await setup(t),otherPassword='different synthetic password only',sealed=await x.f.owner().seal({password:otherPassword,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'&&error.cause?.code==='work_data_recovery.authentication'&&error.operationMayHaveExecuted===false&&error.targetMayHaveBeenCreated===undefined);assert.equal(fs.existsSync(x.context.paths.targetDirectory),false);assert.equal(fs.existsSync(x.backupFile),false);assert.ok(x.owners.every(owner=>owner.released));assert.equal(x.events.includes('migration'),false);
});
test('export result publication failure retains exact pending stage and never reports an unexecuted retry-safe operation',async t=>{
 const x=await setup(t,{failResultFlush:true});await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.result_requires_recovery'&&error.operationMayHaveExecuted===true&&error.resultMayHaveBeenWritten===true&&error.backupPath===x.backupFile);
 const names=await fsp.readdir(path.join(x.f.base,'.work-data'));assert.equal(names.filter(name=>name.startsWith('.maintenance-result-v1.stage-')).length,1);assert.equal(names.includes('maintenance-result-v1.json'),false);assert.ok(fs.existsSync(x.backupFile));
});
test('restore actual full package into absent disjoint root reports separate-root activation honestly',async t=>{
 const x=await setup(t),sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 const result=await x.operation.execute(x.context);assert.equal(result.activation,'separate-fresh-root');assert.equal(result.restartRoot,x.f.base);assert.equal(await fsp.readFile(path.join(result.restored.target,'config.json'),'utf8'),'{ "workDataEncryptionV1": false, "label":"SYNTHETIC_PRIVATE" }');assert.ok(x.owners.every(owner=>owner.released));assert.equal(x.events.includes('migration'),false);
 // The in-memory result carries the actual restored-root identity and authority;
 // the persistent result schema is unchanged and still names only target+activation.
 const target=result.restored.target,stat=await fsp.lstat(target,{bigint:true}),active=await x.api.WorkDataManifest.create({base:target}).readActive();
 assert.deepEqual(Object.keys(result.activationTarget).sort(),['authority','identity','target']);
 assert.equal(result.activationTarget.target,target);
 assert.deepEqual(JSON.parse(JSON.stringify(result.activationTarget.identity)),{dev:String(stat.dev),ino:String(stat.ino)});
 assert.deepEqual(JSON.parse(JSON.stringify(result.activationTarget.authority)),{generation:active.generation,id:active.id,mode:active.mode,sha256:active.proof.sha256});
 const persisted=JSON.parse(await fsp.readFile(path.join(x.f.base,'.work-data','maintenance-result-v1.json'),'utf8'));
 assert.equal('activationTarget' in persisted,false,'target authority stays in memory');assert.equal('restartRoot' in persisted,false);
 assert.deepEqual(persisted.restored,{target:path.resolve(target),activation:'separate-fresh-root'});
 assert.ok(x.events.indexOf('fresh')>x.events.indexOf('release:'+path.basename(target)),'fresh verification runs after the target owner is released');
});

test('wrong upload password performs zero backup or destination writes',async t=>{
 const x=await setup(t),sealed=await x.f.owner().seal({password:'another synthetic password only',appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 let error;try{await x.operation.execute(x.context);}catch(e){error=e;}
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[],'incorrect password must not write even a backup or rehearsal');
 assert.equal(fs.existsSync(x.context.paths.targetDirectory),false);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
 assert.equal(error?.cause?.code,'work_data_recovery.authentication');assert.equal(error.operationMayHaveExecuted,false);assert.equal(error.targetMayHaveBeenCreated,undefined);assert.deepEqual(x.events,[]);
});
test('valid uploaded full package recovers after current source master is lost',async t=>{
 const x=await setup(t);await x.f.write('config.json','{"workDataEncryptionV1":true}');await fsp.mkdir(path.join(x.f.base,'sessions'));const keys=await x.f.newKeys();await x.f.store('sessions/sess_lost.json',keys).write('{"id":"sess_lost","private":"RECOVER_ME"}');
 const sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);await fsp.unlink(path.join(x.f.base,'work-data-key-v1.json'));
 const original=await fsp.readFile(path.join(x.f.base,'sessions/sess_lost.json'));x.context.operation='restore';x.context.expectedAuthority.mode='encrypted';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 let result;await assert.doesNotReject(async()=>{result=await x.operation.execute(x.context);});assert.equal(result.state,'verified');assert.equal(result.activation,'separate-fresh-root');assert.equal(fs.existsSync(path.join(x.f.base,'work-data-key-v1.json')),false);assert.deepEqual(await fsp.readFile(path.join(x.f.base,'sessions/sess_lost.json')),original);
 assert.equal(hash(await fsp.readFile(result.backup.path)),x.context.paths.uploadSha256);assert.equal(fs.existsSync(x.rehearsal),false);assert.ok(fs.existsSync(path.join(result.restored.target,'work-data-key-v1.json')));assert.equal(x.events.includes('snapshot'),false);
 const header=JSON.parse(await fsp.readFile(path.join(result.restored.target,'work-data-key-v1.json'),'utf8')),cold=x.f.api.WorkDataKeys.create({protector:x.f.a,enabled:()=>true,store:{read:async()=>header}}),descriptor=x.f.api.WorkDataMigrationCodecs.describe('sessions/sess_lost.json');
 const store=x.f.fx.store.createText({...descriptor,file:()=>path.join(result.restored.target,'sessions/sess_lost.json'),keys:cold,enabled:()=>true,writeJson:x.f.fx.atomicWriteJson});assert.equal(await store.read(),'{"id":"sess_lost","private":"RECOVER_ME"}');
});

for(const available of [0n,17n*1024n*1024n])test('restore rejects insufficient aggregate same-volume free bytes '+available,async t=>{
 const x=await setup(t,{statfs:async()=>({bsize:1n,bavail:available})}),sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 await assert.rejects(x.operation.execute(x.context),e=>e.cause?.code==='work_data_setup.space_insufficient'&&e.operationMayHaveExecuted===false);
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(fs.existsSync(x.context.paths.targetDirectory),false);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
});
test('unavailable free-space query blocks export before backup or intent writes',async t=>{
 const x=await setup(t,{statfs:async()=>{throw Error('simulated filesystem query refusal');}});
 await assert.rejects(x.operation.execute(x.context),e=>e.cause?.code==='work_data_setup.space_unavailable'&&e.operationMayHaveExecuted===false);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
});

test('restore preserves an unknown source transition stage while recovering only into a new root',async t=>{
 const x=await setup(t),sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 const unknown='.work-data/.maintenance-v1.stage-'+ 'b'.repeat(48);await x.f.write(unknown,'PRESERVE_UNKNOWN_STAGE');
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 const result=await x.operation.execute(x.context);assert.equal(result.state,'verified');assert.equal(await fsp.readFile(path.join(x.f.base,...unknown.split('/')),'utf8'),'PRESERVE_UNKNOWN_STAGE');assert.equal(fs.existsSync(path.join(result.restored.target,...unknown.split('/'))),false);assert.equal(x.events.includes('snapshot'),false);
});

// Pure native seams: retained fake leases have no actual child or OS resources.
async function restoreContext(x,change){const sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0});let bytes=Buffer.from(sealed.serialized);if(change)bytes=change(bytes);const uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,bytes);x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restored-new'),uploadFile,uploadSha256:hash(bytes)});return bytes;}

test('independent actual key-owner wrapper cannot release target lease after known helper uncertainty',async t=>{const x=await setup(t);await x.f.write('config.json','{"workDataEncryptionV1":true}');const keys=await x.f.newKeys();await x.f.store('sessions/sess_hold.json',keys).write('{"id":"sess_hold","private":"HOLD"}');await restoreContext(x);x.context.expectedAuthority.mode='encrypted';const raw=Object.freeze(Object.assign(Error('native pending'),{cause:Object.freeze(Object.assign(Error('underlying'),{helperMayStillRun:true}))}));x.f.a.run=async()=>{throw raw;};let error;try{await x.operation.execute(x.context);}catch(e){error=e;}const receipt={code:error?.code,helperMayStillRun:error?.helperMayStillRun||false,operationMayHaveExecuted:error?.operationMayHaveExecuted,owners:x.owners.map(o=>({released:o.released,roots:o.roots})),causeCode:error?.cause?.code};assert.equal(receipt.code,'work_data_setup.restore_requires_inspection');assert.equal(x.owners.length,1);assert.equal(x.owners[0].released,false);assert.equal(error.helperMayStillRun,true);});

test('actual helper permanent latch survives key-owner sanitization and retains target owner',async t=>{
 const x=await setup(t);await x.f.write('config.json','{"workDataEncryptionV1":true}');const keys=await x.f.newKeys();
 await x.f.store('sessions/sess_hold.json',keys).write('{"id":"sess_hold","private":"HOLD"}');await restoreContext(x);x.context.expectedAuthority.mode='encrypted';
 const {EventEmitter}=require('node:events'),timers=new Map();let serial=0,launches=0,child;
 const local=vm.runInNewContext(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01j-local-crypto.js'),'utf8')+'\nLocalSecretCrypto;',{
  Buffer,TextDecoder,process:{platform:'win32',env:{SystemRoot:'C:\\Windows'}},
  setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  require:name=>name==='node:path'?path:{spawn(){if(launches++)throw Error('synthetic launch refused');child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>false;return child;}}
 });
 const pending=local.run('protect',Buffer.from('synthetic'),Buffer.alloc(0));
 const fire=ms=>{const entry=[...timers].find(([,v])=>v.ms===ms);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();};
 fire(15000);fire(2000);await assert.rejects(pending,e=>e.helperMayStillRun===true);assert.equal(local.helperMayStillRun(),true);
 // The next launch error has no flag; the permanent native latch is the only evidence.
 // The latch becomes visible after initial admission while the target is being
 // acquired. The next launch still throws without a flag, so actual key-owner
 // sanitization must not release that already acquired target.
 const acquire=x.host.acquire;x.host.acquire=async roots=>{const owner=await acquire(roots);x.f.context.LocalSecretCrypto=local;return owner;};
 let error;try{await x.operation.execute(x.context);}catch(e){error=e;}
 assert.equal(x.owners.length,1);assert.equal(x.owners[0].released,false);assert.equal(error.helperMayStillRun,true);
 assert.equal(error.cause.code,'work_data_key.protect_failed');assert.equal(x.host.helperMayStillRun(),false);assert.equal(timers.size,0);
 child.emit('close',1);assert.equal(local.helperMayStillRun(),true);
});

for(const backend of ['MigrationHooks','LocalSecretCrypto'])test(backend+' uncertainty already visible at entry creates no target owner or backup',async t=>{
 const x=await setup(t),tree=x.api.WorkDataTree.create(),before=await tree.capture(x.f.base);t.after(()=>before.release());
 x.f.context[backend]={...x.f.context[backend],helperMayStillRun:()=>true};
 await assert.rejects(()=>x.operation.execute(x.context),error=>error.code==='work_data_setup.native_helper_uncertain'&&error.helperMayStillRun===true);
 assert.equal(x.owners.length,0);assert.deepEqual(x.events,[]);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);await tree.verify(before);
});

test('cold restore handoff keeps its original inode and rejects same-bytes file substitution',async t=>{
 const x=await setup(t);await restoreContext(x);const issued=x.context.upload,original=await fsp.readFile(x.context.paths.uploadFile);
 await fsp.rename(x.context.paths.uploadFile,x.context.paths.uploadFile+'.original');await fsp.writeFile(x.context.paths.uploadFile,original);
 assert.notEqual(String((await fsp.lstat(x.context.paths.uploadFile,{bigint:true})).ino),issued.identity.ino);
 await assert.rejects(()=>x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.upload_changed'&&error.operationMayHaveExecuted===false);
 assert.equal(x.context.upload,issued);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(fs.existsSync(x.context.paths.targetDirectory),false);
});
test('cold restore fixture cannot refresh an already-issued upload handoff',async t=>{
 const x=await setup(t);await restoreContext(x);const issued=x.context.upload;
 await assert.rejects(()=>bindRestoreUpload(x,x.context.paths),/only be issued once/);assert.equal(x.context.upload,issued);assert.deepEqual(x.events,[]);
});

// --- Handoff claim capability: finish only after proof, abandon only without effects ---
// This migration seam is a stub, not a migration proof: it publishes a real
// generation through the real manifest owner so that intent/result ordering around
// the claim is observed on actual files.
function enableMigration(x,args,faults={}){
 const events=[];
 const instance=x.api.WorkDataManifest.create({base:x.f.base,publish:async({stage,target})=>{await fsp.rename(stage,target);}});
 let expected=null;
 return {events,
  async prepare({expected:authority,targetMode}){events.push('prepare');expected=authority;
   const candidate=await instance.prepare({expected:authority,mode:targetMode});
   await args.onCandidate({candidate});
   return {candidate,transformed:[{path:'config.json'}],retainedPlainDisclosure:'synthetic retention note'};},
  async publish(prepared){events.push('publish');if(faults.failPublish)throw Error('synthetic publish refusal');
   await args.onKeyReady({candidate:prepared.candidate,headerSha256:'a'.repeat(64)});
   const active=await instance.commit({expected,candidate:prepared.candidate});
   return {active,candidateId:prepared.candidate.id,mode:prepared.candidate.mode,generation:prepared.candidate.generation,processExitRequired:true};},
  async verifyPublished(prepared){events.push('verifyPublished');const selected=await instance.readActive();
   return {active:selected,candidateId:prepared.candidate.id,generation:prepared.candidate.generation,mode:prepared.candidate.mode,
    logicalFiles:prepared.transformed.length,processExitRequired:true,readOnly:true,specialSha256:'0'.repeat(64),targetSha256:'1'.repeat(64)};}};
}

test('export retires the handoff claim only after the verified result exists',async t=>{
 const x=withClaim(await setup(t));
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'verified');
 assert.deepEqual(x.claim.events,['finish']);
 assert.deepEqual(x.claim.observed.finish,{result:true,intent:false});
 assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')));
});

test('a pre-backup refusal abandons the claim because this attempt wrote nothing',async t=>{
 const x=withClaim(await setup(t,{statfs:async()=>{throw Error('simulated filesystem query refusal');}}));
 await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.space_unavailable'&&error.operationMayHaveExecuted===false);
 assert.deepEqual(x.claim.events,['abandon']);
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
});

test('an authority refusal abandons the claim before any package or source write',async t=>{
 const x=withClaim(await setup(t));x.context.expectedAuthority.mode='encrypted';
 await assert.rejects(x.operation.execute(x.context),/authority_changed/);
 assert.deepEqual(x.claim.events,['abandon']);
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
});

test('a refused abandon keeps the claim and never replaces the original typed failure',async t=>{
 const x=withClaim(await setup(t,{statfs:async()=>{throw Error('simulated filesystem query refusal');}}),{failAbandon:true});
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='work_data_setup.space_unavailable'&&error.operationMayHaveExecuted===false);
 assert.deepEqual(x.claim.events,['abandon']);
});

// 151 阶段 3A(W1):以下三件改前断言「备份包/演练一旦开始就保留交接记录」(下次启动 handoff_pending)。
// 现在:先按身份删掉本次造出的备份包与演练,确认都不在了才撤交接记录(abandon 时备份文件夹已空);
// 名字被别人占着的演练路径(从没交给 restore)原样不动。
test('a started backup is removed by identity before the claim is abandoned when the source was never mutated',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async()=>{throw Error('cold validation refusal');}}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'&&e.operationMayHaveExecuted===false;});
 assert.equal(fs.existsSync(x.backupFile),false);assert.equal(fs.existsSync(x.rehearsal),false);
 assert.deepEqual(x.claim.events,['abandon']);assert.deepEqual(x.claim.observed.abandon,{backups:0},'the package is gone before the record is retired');
 assert.equal(x.operation.selfRecovered(error),true);
});

test('a started rehearsal is removed and the claim abandoned when no source intent was written',async t=>{
 const x=withClaim(await setup(t,{nativeResult:false}));
 await assert.rejects(x.operation.execute(x.context),/preparation_failed/);
 assert.equal(fs.existsSync(x.rehearsal),false);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-v1.json')),false);
 assert.deepEqual(x.claim.events,['abandon']);
});

test('a foreign object already at the rehearsal path is never touched; only this attempt\'s package is removed',async t=>{
 const x=withClaim(await setup(t));await fsp.mkdir(x.rehearsal);await fsp.writeFile(path.join(x.rehearsal,'foreign.txt'),'FOREIGN');
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.cause?.code==='work_data_setup.target_exists';});
 assert.equal(await fsp.readFile(path.join(x.rehearsal,'foreign.txt'),'utf8'),'FOREIGN');assert.equal(fs.existsSync(x.backupFile),false);
 assert.deepEqual(x.claim.events,['abandon']);assert.equal(x.operation.selfRecovered(error),true);
});

test('a written result keeps the claim because publication is already an effect',async t=>{
 const x=withClaim(await setup(t,{failResultFlush:true}));
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.result_requires_recovery'
  &&error.resultMayHaveBeenWritten===true);
 assert.deepEqual(x.claim.events,[]);
});

test('a refused claim finish keeps the record but still returns the verified export',async t=>{
 const x=withClaim(await setup(t),{failFinish:true});
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'verified');assert.deepEqual(x.claim.events,['finish']);
 assert.ok(fs.existsSync(result.backup.path));
 assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')));
});

test('enable retires the claim only after the verified intent is gone and the result is durable',async t=>{
 const x=withClaim(await setup(t,{migration:(f,args)=>enableMigration(f,args)}));x.context.operation='enable';
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'published');
 assert.deepEqual(x.claim.events,['finish']);
 assert.deepEqual(x.claim.observed.finish,{result:true,intent:false});
 const active=await x.api.WorkDataManifest.create({base:x.f.base}).readActive();
 assert.equal(active.generation,1);assert.equal(active.mode,'encrypted');
 assert.deepEqual(await fsp.readdir(x.backupDirectory),['ruyi-work-data-'+x.context.id+'.ruyi-backup']);
});

test('a mutation failure keeps the claim and reports the transition for recovery',async t=>{
 const x=withClaim(await setup(t,{migration:(f,args)=>enableMigration(f,args,{failPublish:true})}));x.context.operation='enable';
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.transition_requires_recovery'
  &&error.operationMayHaveExecuted===true&&error.sourceIntentRetained===true);
 assert.deepEqual(x.claim.events,[]);
 assert.ok(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-v1.json')),'the intent stays pending');
});

test('a malformed claim capability refuses before any snapshot, backup or intent',async t=>{
 for(const broken of [{finish(){}},{abandon(){}},{finish:'x',abandon(){}}]){
  const x=await setup(t);x.context.claim=broken;
  await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.claim_capability_invalid');
  assert.deepEqual(x.events,[]);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
  assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
 }
});

test('without a claim capability the operation body keeps its exact previous path',async t=>{
 const x=await setup(t);
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'verified');
 assert.deepEqual(x.events.filter(phase=>phase==='snapshot'||phase==='verify-backup'),['snapshot','verify-backup']);
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')),true);
});

// --- Zero-byte attempts may be abandoned; a created package file may not ---
test('a pre-existing backup path abandons the claim and leaves the foreign file untouched',async t=>{
 const x=withClaim(await setup(t));
 await fsp.writeFile(x.backupFile,'FOREIGN BYTES');
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='work_data_setup.target_exists'&&error.operationMayHaveExecuted===false&&error.backupPath===x.backupFile);
 assert.deepEqual(x.claim.events,['abandon'],'this attempt wrote no byte, so the owned record must not pin the base');
 assert.equal(await fsp.readFile(x.backupFile,'utf8'),'FOREIGN BYTES');
 assert.deepEqual(await fsp.readdir(x.backupDirectory),['ruyi-work-data-'+x.context.id+'.ruyi-backup']);
});

test('a refused backup open abandons the claim and still names the exact attempted path',async t=>{
 const x=withClaim(await setup(t,{backupOpenFails:true}));
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='EACCES'&&error.operationMayHaveExecuted===false&&error.backupPath===x.backupFile);
 assert.deepEqual(x.claim.events,['abandon']);
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[],'a refused open creates nothing');
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);
});

// 151 阶段 3A(W1/W8):以下两件改前断言「包文件已经造出来,交接记录保留、包留在原地」。现在本次 `wx` 造出的那个
// 对象(按 dev/ino)被删掉后才撤记录;错误不再点名已删掉的路径。
test('a write refusal after the backup file was created removes that exact file and then abandons the claim',async t=>{
 const x=withClaim(await setup(t,{backupWriteFails:true}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'
  &&e.cause?.code==='EIO'&&e.operationMayHaveExecuted===false&&e.backupPath===undefined;});
 assert.deepEqual(x.claim.events,['abandon']);assert.deepEqual(x.claim.observed.abandon,{backups:0});
 assert.equal(fs.existsSync(x.backupFile),false);assert.equal(x.operation.selfRecovered(error),true);
});

test('a refused backup durability flush after the bytes landed removes the package and abandons the claim',async t=>{
 const x=withClaim(await setup(t,{failBackupFlush:true}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'
  &&e.operationMayHaveExecuted===false&&e.backupPath===undefined;});
 assert.deepEqual(x.claim.events,['abandon']);assert.equal(fs.existsSync(x.backupFile),false);assert.equal(x.operation.selfRecovered(error),true);
});

// --- Restore claim lifecycle: verified result without source intent, target is an effect ---
async function claimRestore(x,sealPassword=password){
 const sealed=await x.f.owner().seal({password:sealPassword,appVersion:'3.0.1',generation:0});
 const uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 x.context.operation='restore';
 x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:path.join(x.f.root,'restore-target'),uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 return x.context.paths;
}
test('restore retires the handoff claim only after the verified result exists and writes no source intent',async t=>{
 const x=withClaim(await setup(t));const paths=await claimRestore(x);
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'verified');assert.equal(result.activation,'separate-fresh-root');assert.equal(result.restartRoot,x.f.base);
 assert.deepEqual(x.claim.events,['finish']);
 assert.deepEqual(x.claim.observed.finish,{result:true,intent:false});
 assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')));
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-v1.json')),false);
 assert.ok(fs.existsSync(paths.targetDirectory));
});
test('a restore failure after the target exists keeps the target and the claim',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async()=>{throw Error('cold validation refusal');}}));const paths=await claimRestore(x);
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.restore_requires_inspection'
  &&error.operationMayHaveExecuted===true&&error.targetMayHaveBeenCreated===true);
 assert.ok(fs.existsSync(paths.targetDirectory),'the created target is an effect the next boot must inspect');
 assert.ok(fs.existsSync(x.backupFile));
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-result-v1.json')),false,'a failed fresh verification writes no result');
 assert.deepEqual(x.claim.events,[]);
});
test('a target replaced after fresh verification refuses the verified result and keeps target and claim',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async({value})=>{await fsp.rename(value.target,value.target+'.original');await fsp.mkdir(value.target);}}));
 const paths=await claimRestore(x);
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.restore_requires_inspection'
  &&error.cause?.code==='work_data_setup.target_changed'&&error.operationMayHaveExecuted===true&&error.targetMayHaveBeenCreated===true);
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-result-v1.json')),false,'a changed target identity writes no result');
 assert.ok(fs.existsSync(paths.targetDirectory));assert.ok(fs.existsSync(paths.targetDirectory+'.original'),'the restored tree is retained at its replaced path');
 assert.ok(fs.existsSync(x.backupFile));assert.deepEqual(x.claim.events,[]);
});
test('a target authority re-authored after fresh verification refuses the verified result with unchanged identity',async t=>{
 let identityBefore=null;
 const x=withClaim(await setup(t,{verifyFresh:async({value})=>{
  const stat=await fsp.lstat(value.target,{bigint:true});identityBefore={dev:String(stat.dev),ino:String(stat.ino)};
  // Rewrite the restored config in place: the directory identity stays exactly the
  // same, only the target authority (plain -> encrypted) changes.
  await fsp.writeFile(path.join(value.target,'config.json'),'{"workDataEncryptionV1":true}');
 }}));
 const paths=await claimRestore(x);
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.restore_requires_inspection'
  &&error.cause?.code==='work_data_setup.target_changed'&&error.operationMayHaveExecuted===true&&error.targetMayHaveBeenCreated===true);
 const after=await fsp.lstat(paths.targetDirectory,{bigint:true});
 assert.equal(String(after.dev),identityBefore.dev);assert.equal(String(after.ino),identityBefore.ino,'the directory identity is intentionally unchanged');
 assert.equal(await fsp.readFile(path.join(paths.targetDirectory,'config.json'),'utf8'),'{"workDataEncryptionV1":true}','the re-authored target is retained');
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-result-v1.json')),false,'a changed target authority writes no result');
 assert.ok(fs.existsSync(x.backupFile));assert.deepEqual(x.claim.events,[]);
});
test('a restore refused by upload authentication abandons the claim before any target or backup',async t=>{
 const x=withClaim(await setup(t));const paths=await claimRestore(x,'different synthetic password only');
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='work_data_recovery.authentication'&&error.operationMayHaveExecuted===false);
 assert.deepEqual(x.claim.events,['abandon']);
 assert.equal(fs.existsSync(paths.targetDirectory),false);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
});
test('a refused restore claim finish keeps the record but still returns the verified result',async t=>{
 const x=withClaim(await setup(t),{failFinish:true});await claimRestore(x);
 const result=await x.operation.execute(x.context);
 assert.equal(result.state,'verified');assert.equal(result.activation,'separate-fresh-root');
 assert.deepEqual(x.claim.events,['finish']);
 assert.ok(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')));
});
test('a restore target inside the backup directory is refused before any backup or target effect',async t=>{
 const x=withClaim(await setup(t)),sealed=await x.f.owner().seal({password,appVersion:'3.0.1',generation:0}),uploadFile=path.join(x.f.root,'upload.ruyi-backup');await fsp.writeFile(uploadFile,sealed.serialized);
 const target=path.join(x.backupDirectory,'restored-inside');
 x.context.operation='restore';x.context.paths=await bindRestoreUpload(x,{...x.context.paths,targetDirectory:target,uploadFile,uploadSha256:hash(Buffer.from(sealed.serialized))});
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='work_data_setup.target_invalid'&&error.operationMayHaveExecuted===false);
 assert.equal(fs.existsSync(target),false,'the target inside the backup is never created');
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[],'no backup or other package is written');
 assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false,'no result or intent is written');
 assert.equal(x.owners.length,0,'no target owner is acquired');
 assert.deepEqual(x.claim.events,['abandon'],'a zero-effect refusal retires the handoff record');
});

test('cold operation requires the snapshot host capability before any operation work',async t=>{
 const x=await setup(t),host={...x.host};delete host.fullSnapshot;
 assert.throws(()=>x.api.WorkDataColdOperations.create(host),{code:'work_data_setup.operation_host_invalid'});
 assert.deepEqual(x.events,[]);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
});

test('cold export delegates the exact source ownership and synchronous guard to its supplied snapshot host',async t=>{
 let calls=0;const x=await setup(t,{snapshotFactory({base,ownership,assertExclusive,onNativeCause,f}){
  calls++;assert.equal(base,f.base);assert.equal(ownership.roots[0],base);assert.equal(assertExclusive(ownership),true);
  assert.equal(assertExclusive({roots:[base]}),false);assert.equal(typeof onNativeCause,'function');
  return f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector:f.a,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});
 }});
 const result=await x.operation.execute(x.context);assert.equal(result.state,'verified');assert.equal(calls,2,'seal and rehearsal restore use host factories');
 assert.equal(x.events.filter(value=>value==='snapshot-host').length,2);assert.ok(fs.existsSync(result.backup.path));
});

test('malformed snapshot owners fail without backup writes; pending or opaque ownership retains the claim',async t=>{
 for(const kind of ['missing','promise','rejected-promise','getter','proxy']){
  let traps=0;const x=withClaim(await setup(t,{snapshotFactory(){
   if(kind==='missing')return{seal(){throw Error('must not run');}};
   if(kind==='promise')return Promise.resolve({});
   if(kind==='rejected-promise')return Promise.reject(Error('synthetic factory rejection'));
   if(kind==='getter')return Object.defineProperty({restore(){}},'seal',{get(){traps++;throw Error('must not inspect');}});
   return new Proxy({},{get(){traps++;throw Error('must not inspect');}});
  }}));
  await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
   &&error.cause?.code===(kind==='missing'?'work_data_setup.snapshot_host_invalid':'work_data_setup.snapshot_host_uncertain')
   &&(error.helperMayStillRun===true)===(kind!=='missing'));
  assert.equal(traps,0);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(x.owners.length,0);
  assert.deepEqual(x.claim.events,kind==='missing'?['abandon']:[]);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data/maintenance-result-v1.json')),false);
  await new Promise(resolve=>setImmediate(resolve));
 }
});

// ---------------------------------------------------------------------------
// 151 阶段 3A(150 号文 W1/W7/W8):失败可恢复、演练不进备份文件夹、写包前预检卷。
// ---------------------------------------------------------------------------
// The real 01w classifier, loaded in its own realm without its publish side effect.
const flushClassifier=(()=>{const ctx={require,Buffer,process:{platform:'linux',env:{}},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(draft,'01w-work-data-native-publish.js'),'utf8')+'\nthis.WorkDataNativePublish=WorkDataNativePublish;',ctx);
 return ctx.WorkDataNativePublish;})();
// The same typed shape 01w's invokeFlush produces for a settled native refusal.
const settledFlushRefusal=(code,attempted=false)=>Object.assign(Error('work_data_manifest.flush_'+code),{code:'work_data_manifest.flush_'+code,apiCode:'work_data_manifest.flush_'+code,
 statusCode:409,commitUncertain:attempted,retry:false,operationMayHaveExecuted:attempted,resultUnavailable:attempted,nativeCode:0,nativeSettled:true,flushRefusal:code});
const PLAINTEXT_MARKERS=[Buffer.from('SYNTHETIC_PRIVATE'),Buffer.from('workDataEncryptionV1')];
// Every entry of the backup directory, recursively; only the one package name may exist
// and its bytes must not contain any plaintext marker of the source.
async function scanBackupDirectory(x,where){
 const seen=[];
 async function walk(dir,rel){for(const entry of await fsp.readdir(dir,{withFileTypes:true})){const name=rel?rel+'/'+entry.name:entry.name;seen.push(name);if(entry.isDirectory())await walk(path.join(dir,entry.name),name);}}
 await walk(x.backupDirectory,'');
 assert.ok(seen.every(name=>name==='ruyi-work-data-'+x.context.id+'.ruyi-backup'),where+': only the sealed package may appear in the backup directory, saw '+JSON.stringify(seen));
 for(const name of seen){const bytes=await fsp.readFile(path.join(x.backupDirectory,name));for(const marker of PLAINTEXT_MARKERS)assert.equal(bytes.includes(marker),false,where+': plaintext marker in '+name);}
 return seen;
}
function instrumentScans(x,scans){
 const wrap=name=>{const original=x.host[name];x.host[name]=async(...args)=>{await scanBackupDirectory(x,name+':before');scans.push(name);const value=await original(...args);await scanBackupDirectory(x,name+':after');return value;};};
 const progress=x.host.progress;x.host.progress=value=>{const out=progress(value);scans.push('progress:'+value.phase);return scanBackupDirectory(x,'progress:'+value.phase).then(()=>out);};
 for(const name of ['captureRehearsal','verifyFresh','verifyDisposableNativeTree','flush'])wrap(name);
}

test('W8: an unsupported backup volume is refused by the probe before any snapshot or package write and the service may return',async t=>{
 const x=withClaim(await setup(t,{flush:async({roots})=>{if(path.basename(roots[0])==='backups')throw settledFlushRefusal('filesystem_unsupported');}}));
 x.f.context.WorkDataNativePublish=flushClassifier;
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'&&e.cause?.code==='work_data_setup.backup_filesystem_unsupported'
  &&e.cause.cause?.code==='work_data_manifest.flush_filesystem_unsupported'&&e.operationMayHaveExecuted===false;});
 assert.equal(x.events.includes('snapshot'),false,'no snapshot is taken for a refused volume');assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);
 assert.equal(fs.existsSync(x.rehearsal),false);assert.deepEqual(x.claim.events,['abandon']);assert.equal(x.operation.selfRecovered(error),true);
});
test('W8: a refused or uncertain probe names durability, not the volume type, and an uncertain helper is never self-recovered',async t=>{
 const refused=withClaim(await setup(t,{flush:async({roots})=>{if(path.basename(roots[0])==='backups')throw settledFlushRefusal('durability_unsupported',true);}}));
 refused.f.context.WorkDataNativePublish=flushClassifier;
 let error;await assert.rejects(refused.operation.execute(refused.context),e=>{error=e;return e.cause?.code==='work_data_setup.backup_durability_unavailable';});
 assert.equal(refused.operation.selfRecovered(error),true);assert.deepEqual(refused.claim.events,['abandon']);
 const uncertain=withClaim(await setup(t,{flush:async({roots})=>{if(path.basename(roots[0])==='backups')throw Object.assign(Error('work_data_manifest.flush_timeout'),{code:'work_data_manifest.flush_timeout',helperMayStillRun:true});}}));
 uncertain.f.context.WorkDataNativePublish=flushClassifier;
 await assert.rejects(uncertain.operation.execute(uncertain.context),e=>{error=e;return e.cause?.code==='work_data_setup.backup_durability_unavailable'&&e.helperMayStillRun===true;});
 assert.equal(uncertain.operation.selfRecovered(error),false);assert.deepEqual(uncertain.claim.events,[],'a possibly live helper keeps the record');
});
test('W1: a verify-backup failure leaves no package, no rehearsal, no intent and an unchanged source; the claim is retired last',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async()=>{throw Object.assign(Error('verifier timeout'),{code:'work_data_adapter.verifier_timeout'});}}));
 const tree=x.api.WorkDataTree.create(),before=await tree.capture(x.f.base);t.after(()=>before.release());
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed';});
 assert.equal(x.operation.selfRecovered(error),true);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(fs.existsSync(x.rehearsal),false);
 assert.deepEqual(x.claim.events,['abandon']);assert.deepEqual(x.claim.observed.abandon,{backups:0});
 await tree.verify(before);assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);assert.ok(x.owners.every(owner=>owner.released));
});
test('W1: a flush failure after the package bytes landed (non-NTFS slipping past the probe) is self-recovered',async t=>{
 const x=withClaim(await setup(t,{failBackupFlush:()=>settledFlushRefusal('filesystem_unsupported')}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.cause?.code==='work_data_manifest.flush_filesystem_unsupported';});
 assert.equal(x.operation.selfRecovered(error),true);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.deepEqual(x.claim.events,['abandon']);
});
test('W1: a substituted package body is evidence: it stays, the claim stays and the failure is not self-recovered',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async({context})=>fsp.writeFile(path.join(context.paths.backupDirectory,'ruyi-work-data-'+context.id+'.ruyi-backup'),'substituted')}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.cause?.code==='work_data_setup.backup_changed';});
 assert.equal(x.operation.selfRecovered(error),false);assert.equal(await fsp.readFile(x.backupFile,'utf8'),'substituted');assert.deepEqual(x.claim.events,[]);
 assert.equal(error.backupPath,x.backupFile);
});
test('W1: helper uncertainty during rehearsal release is never self-recovered and keeps the rehearsal, owner and claim',async t=>{
 const x=withClaim(await setup(t,{rehearsalRelease(){throw Error('synthetic cleanup failure');}}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.helperMayStillRun===true;});
 assert.equal(x.operation.selfRecovered(error),false);assert.equal(fs.existsSync(x.rehearsal),true);assert.deepEqual(x.claim.events,[]);
});
test('W1: a refused abandon keeps the failure unrecovered even after the package and rehearsal are gone',async t=>{
 const x=withClaim(await setup(t,{nativeResult:false}),{failAbandon:true});
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return true;});
 assert.equal(x.operation.selfRecovered(error),false);assert.deepEqual(x.claim.events,['abandon']);
});
test('W1: preflight refusals are self-recovered once the record is retired, never an unfinished intent stage',async t=>{
 const space=withClaim(await setup(t,{statfs:async()=>{throw Error('simulated filesystem query refusal');}}));
 let error;await assert.rejects(space.operation.execute(space.context),e=>{error=e;return true;});assert.equal(space.operation.selfRecovered(error),true);
 const authority=withClaim(await setup(t));authority.context.expectedAuthority.mode='encrypted';
 await assert.rejects(authority.operation.execute(authority.context),e=>{error=e;return /authority_changed/.test(e.message);});assert.equal(authority.operation.selfRecovered(error),true);
 const stage=withClaim(await setup(t));await stage.f.write('.work-data/.maintenance-v1.stage-'+'b'.repeat(48),'UNKNOWN');
 await assert.rejects(stage.operation.execute(stage.context),e=>{error=e;return /intent_stage_pending/.test(e.message);});assert.equal(stage.operation.selfRecovered(error),false);
 // A foreign thrown value carrying a recovery-looking property can never claim recovery.
 assert.equal(stage.operation.selfRecovered(Object.assign(Error('forged'),{selfRecovered:true})),false);
});
test('W7: the rehearsal lives beside the data root on its volume, never in the backup directory, and is gone after success',async t=>{
 const scans=[];let x;x=withClaim(await setup(t,{verifyFresh:async({value})=>{assert.equal(value.target,x.rehearsal);assert.equal(fs.existsSync(x.rehearsal),true);}}));instrumentScans(x,scans);
 const result=await x.operation.execute(x.context);assert.equal(result.state,'verified');
 assert.equal(path.dirname(x.rehearsal),path.dirname(x.f.base));assert.equal(fs.existsSync(x.rehearsal),false);
 for(const name of ['captureRehearsal','verifyFresh','verifyDisposableNativeTree','progress:snapshot','progress:verify-backup'])assert.ok(scans.includes(name),name+' was scanned');
 assert.ok(x.events.includes('flush:'+path.basename(path.dirname(x.f.base))),'the rehearsal removal is flushed on its own volume');
 assert.deepEqual(await scanBackupDirectory(x,'after success'),['ruyi-work-data-'+x.context.id+'.ruyi-backup']);
});
for(const [name,options] of [
 ['verifier failure',{verifyFresh:async()=>{throw Error('cold validation refusal');}}],
 ['native census refusal',{nativeResult:false}],
 ['rehearsal fingerprint refusal',{rehearsalVerify:()=>false}],
 ['package flush refusal',{failBackupFlush:true}],
 ['rehearsal release uncertainty',{rehearsalRelease(){throw Error('synthetic cleanup failure');}}],
])test('W7: no plaintext ever appears in the backup directory at any stage or after a '+name,async t=>{
 const scans=[],x=withClaim(await setup(t,options));instrumentScans(x,scans);
 await assert.rejects(x.operation.execute(x.context));
 await scanBackupDirectory(x,'after '+name);assert.ok(scans.length>0);
});
test('W7: a rehearsal restore that fails midway is removed by the identity its own mkdir reported',async t=>{
 const x=withClaim(await setup(t,{snapshotFactory:({base,ownership,assertExclusive,f})=>f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector:f.a,
  externalOwner:opts=>f.api.ExternalBotCredentials.create(opts),ownedRestoreFlush:async({target})=>{assert.ok(fs.existsSync(path.join(target,'config.json')),'plaintext was written before the refusal');throw Object.assign(Error('synthetic restore flush refusal'),{code:'EIO'});}})}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return e.cause?.code==='work_data_full.restore_failed'&&e.cause.targetRetained===true&&e.cause.targetIdentity?.ino!==undefined;});
 assert.equal(fs.existsSync(x.rehearsal),false);assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.deepEqual(x.claim.events,['abandon']);assert.equal(x.operation.selfRecovered(error),true);
});
test('W7: a rehearsal directory whose identity no longer matches is never deleted and keeps the claim',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async({value})=>{await fsp.rename(value.target,value.target+'.moved');await fsp.mkdir(value.target);await fsp.writeFile(path.join(value.target,'other.txt'),'OTHER');throw Error('cold validation refusal');}}));
 let error;await assert.rejects(x.operation.execute(x.context),e=>{error=e;return true;});
 assert.equal(x.operation.selfRecovered(error),false);assert.equal(await fsp.readFile(path.join(x.rehearsal,'other.txt'),'utf8'),'OTHER');assert.deepEqual(x.claim.events,[]);
});
// 151 阶段 3A:故障注入点与仓库其余测试钩子同一道双闸。只设故障名不生效(生产默认),两个都设才在该点失败,
// 而且注入的失败走的正是真实失败的同一条自清理路径。
test('3A: the cold fault hook needs RUYI_TEST_HOOKS=1 as well as the fault name, and only ever fails the operation',async t=>{
 const saved={hooks:process.env.RUYI_TEST_HOOKS,fault:process.env.RUYI_TEST_WORK_DATA_COLD_FAULT};
 t.after(()=>{for(const [name,value] of [['RUYI_TEST_HOOKS',saved.hooks],['RUYI_TEST_WORK_DATA_COLD_FAULT',saved.fault]])if(value===undefined)delete process.env[name];else process.env[name]=value;});
 delete process.env.RUYI_TEST_HOOKS;process.env.RUYI_TEST_WORK_DATA_COLD_FAULT='verify-backup';
 const off=withClaim(await setup(t));assert.equal((await off.operation.execute(off.context)).state,'verified','the fault name alone is inert');
 process.env.RUYI_TEST_HOOKS='1';process.env.RUYI_TEST_WORK_DATA_COLD_FAULT='not-a-fault-point';
 const unknown=withClaim(await setup(t));assert.equal((await unknown.operation.execute(unknown.context)).state,'verified','an unknown fault name is inert');
 process.env.RUYI_TEST_WORK_DATA_COLD_FAULT='verify-backup';
 const on=withClaim(await setup(t));let error;
 await assert.rejects(on.operation.execute(on.context),e=>{error=e;return e.code==='work_data_setup.preparation_failed'&&e.cause?.code==='work_data_setup.test_fault_verify_backup';});
 assert.equal(on.operation.selfRecovered(error),true);assert.deepEqual(await fsp.readdir(on.backupDirectory),[]);assert.equal(fs.existsSync(on.rehearsal),false);
});
// 151 阶段 3A review 应改 1:数据根直接在盘符根下(C:\X)时,非提权进程刷不了演练所在的父目录(C:\)。修前整轮快照与
// 演练做完才在删除演练后的那次 flush 失败;现在在任何快照之前先探一次父目录,刷不了就带稳定码提前拒绝,不退回备份文件夹。
const settledRefusal=code=>Object.assign(Error('work_data_manifest.flush_'+code),{code:'work_data_manifest.flush_'+code,operationMayHaveExecuted:false,nativeSettled:true,flushRefusal:code,nativeCode:5});
for(const [name,error,expected] of [
 ['a settled refusal (ACCESS_DENIED on a drive root)',()=>settledRefusal('access_denied'),'work_data_setup.rehearsal_location_unsupported'],
 ['an uncertain helper outcome',()=>Object.assign(Error('timeout'),{code:'work_data_manifest.flush_timeout'}),'work_data_setup.rehearsal_location_unavailable'],
])test('3A W7: a rehearsal parent that cannot be flushed is refused before any snapshot or package: '+name,async t=>{
 let x0;x0=await setup(t,{flush:async({roots,x})=>{if(x&&roots[0]===path.dirname(x.rehearsal))throw error();}});const x=withClaim(x0);
 x.f.context.WorkDataNativePublish=flushClassifier;
 let failure;await assert.rejects(x.operation.execute(x.context),e=>{failure=e;return e.code==='work_data_setup.preparation_failed'&&e.cause?.code===expected;});
 assert.equal(x.events.includes('snapshot'),false,'no snapshot ran');assert.equal(x.events.some(e=>e==='flush:backups'),false,'the backup directory was not even probed');
 assert.deepEqual(await fsp.readdir(x.backupDirectory),[]);assert.equal(fs.existsSync(x.rehearsal),false);
 assert.equal(x.operation.selfRecovered(failure),true,'nothing was written, so the service returns to the source');assert.deepEqual(x.claim.events,['abandon']);
});
// review 建议 4:源权威在这次尝试中变了 —— 交接记录不再先撤后查,而是保留给下一次启动。
test('3A W1: a source authority change during the attempt keeps the handoff record and is never self-recovered',async t=>{
 let xr;const x=withClaim(await setup(t,{verifyFresh:async()=>{fs.writeFileSync(path.join(xr.f.base,'config.json'),'{ "workDataEncryptionV1": true }');throw Object.assign(Error('inject'),{code:'probe.inject'});}}));xr=x;
 let failure;await assert.rejects(x.operation.execute(x.context),e=>{failure=e;return true;});
 assert.equal(x.operation.selfRecovered(failure),false);assert.deepEqual(x.claim.events,[],'the record is kept for the next boot');
});
// review 应改 3:恢复主人在证明原进程已死后按 claim id 清理被杀冷端留下的演练目录。只认本作业那一个路径;联接、
// 符号链接、别名或拿不到独占所有权时类型化拒绝并原样保留。
test('3A W7: removeOrphanRehearsal removes only the exact owned rehearsal directory and refuses aliases or a busy owner',async t=>{
 const x=await setup(t),api=x.api.WorkDataColdOperations,id='e'.repeat(48),target=api.rehearsalPathFor(x.f.base,id);
 assert.equal(path.dirname(target),path.dirname(x.f.base));
 const leases=[];const acquire=async roots=>{const lease={roots,released:false,async release(){lease.released=true;}};leases.push(lease);return lease;};
 assert.equal(await api.removeOrphanRehearsal({base:x.f.base,id,acquire}),'absent');
 await fsp.mkdir(path.join(target,'sessions'),{recursive:true});await fsp.writeFile(path.join(target,'config.json'),'SYNTHETIC_PLAINTEXT');
 assert.equal(await api.removeOrphanRehearsal({base:x.f.base,id,acquire}),'removed');assert.equal(fs.existsSync(target),false);
 assert.deepEqual(leases.map(lease=>[lease.roots[0],lease.released]),[[target,true]],'removed under its own exclusive owner, which is released');
 // A busy owner (for example a verifier process still running) keeps the tree.
 await fsp.mkdir(target);await fsp.writeFile(path.join(target,'config.json'),'KEEP');
 await assert.rejects(api.removeOrphanRehearsal({base:x.f.base,id,acquire:async()=>{throw Object.assign(Error('busy'),{code:'DATA_ROOT_IN_USE'});}}),{code:'work_data_setup.rehearsal_retained'});
 assert.equal(await fsp.readFile(path.join(target,'config.json'),'utf8'),'KEEP');await fsp.rm(target,{recursive:true});
 // A junction planted at the path is never followed or removed; its target is untouched.
 const victim=path.join(x.f.root,'victim');await fsp.mkdir(victim);await fsp.writeFile(path.join(victim,'user.txt'),'USER');
 fs.symlinkSync(victim,target,'junction');
 await assert.rejects(api.removeOrphanRehearsal({base:x.f.base,id,acquire}),{code:'work_data_setup.rehearsal_retained'});
 assert.equal(await fsp.readFile(path.join(victim,'user.txt'),'utf8'),'USER');assert.equal(fs.lstatSync(target).isSymbolicLink(),true);fs.unlinkSync(target);
 // A non-directory at the path and a malformed id are refused.
 await fsp.writeFile(target,'FILE');await assert.rejects(api.removeOrphanRehearsal({base:x.f.base,id,acquire}),{code:'work_data_setup.rehearsal_retained'});
 assert.equal(await fsp.readFile(target,'utf8'),'FILE');await fsp.unlink(target);
 await assert.rejects(api.removeOrphanRehearsal({base:x.f.base,id:'../x',acquire}),{code:'work_data_setup.rehearsal_retained'});
});
