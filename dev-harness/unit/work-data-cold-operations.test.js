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
   if(isPackage&&options.backupWriteFails)return {writeFile:async()=>{throw Object.assign(Error('simulated backup write refusal'),{code:'EIO'});},sync:()=>handle.sync(),close:()=>handle.close()};
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
   if(options.failResultFlush&&path.basename(roots[0])==='.work-data'&&(await fsp.readdir(roots[0])).some(name=>name.startsWith('.maintenance-result-v1.stage-')))throw Error('simulated result flush refusal');
   // Opt-in: refuse the first durability flush of the backup directory only, after
   // the package bytes are already on disk.
   if(options.failBackupFlush&&path.basename(roots[0])==='backups'&&++backupFlushes===1)throw Error('simulated backup flush refusal');},
  async verifyFresh(value){events.push('fresh');assert.ok(owners.every(owner=>owner.released));const own={roots:[value.target]};
   const full=f.api.WorkDataFullSnapshot.create({base:value.target,ownership:own,assertExclusive:owner=>owner===own,protector:f.a,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});
   const sealed=await full.seal({password:value.password,appVersion:'3.0.1',generation:value.generation??0});assert.ok(sealed.files>=2);
   if(options.verifyFresh)await options.verifyFresh({f,context,events,value});return options.freshResult??true;},
  async verifyDisposableNativeTree(value){events.push('native-tree');assert.ok(owners.some(owner=>!owner.released&&owner===value.ownership));return options.nativeResult??true;},
  migrationFactory(args){events.push('migration');if(typeof options.migration!=='function')throw Error('migration must not run for these operations');return options.migration(x,args);},
  progress(value){events.push(value.phase);},helperMayStillRun:()=>options.helperMayStillRun===true,
 };
 const operation=api.WorkDataColdOperations.create(host);
 x={f,api,host,context,operation,events,owners,backupDirectory,rehearsal:path.join(backupDirectory,'.ruyi-work-data-verify-'+context.id),backupFile:path.join(backupDirectory,'ruyi-work-data-'+context.id+'.ruyi-backup')};
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
test('fresh-verifier failure retains verified backup and rehearsal and writes no source intent',async t=>{
 const x=await setup(t,{verifyFresh:async()=>{throw Error('cold validation refusal');}});
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'&&error.operationMayHaveExecuted===false);
 assert.ok(fs.existsSync(x.backupFile));assert.ok(fs.existsSync(x.rehearsal));assert.equal(fs.existsSync(path.join(x.f.base,'.work-data')),false);assert.ok(x.owners.every(owner=>owner.released));assert.equal(x.events.includes('migration'),false);
});
test('new verifier-created object refuses cleanup and preserves all rehearsal files',async t=>{
 const x=await setup(t,{verifyFresh:async({value})=>fsp.writeFile(path.join(value.target,'foreign.bin'),'FOREIGN')});
 await assert.rejects(x.operation.execute(x.context),/preparation_failed/);assert.equal(await fsp.readFile(path.join(x.rehearsal,'foreign.bin'),'utf8'),'FOREIGN');assert.equal(x.events.includes('native-tree'),false);assert.equal(x.events.includes('migration'),false);
});
test('native namespace refusal retains rehearsal even when default stream proof passes',async t=>{
 const x=await setup(t,{nativeResult:false});await assert.rejects(x.operation.execute(x.context),/preparation_failed/);assert.ok(fs.existsSync(x.rehearsal));assert.ok(x.events.includes('native-tree'));assert.equal(x.events.includes('migration'),false);
});
test('fresh verifier must return exact true; truthy receipt and undefined cannot authorize cleanup',async t=>{
 const x=await setup(t,{freshResult:{ok:true}});await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.fresh_verification_failed');assert.ok(fs.existsSync(x.rehearsal));assert.equal(x.events.includes('native-tree'),false);
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

test('a started backup keeps the claim even though the source was never mutated',async t=>{
 const x=withClaim(await setup(t,{verifyFresh:async()=>{throw Error('cold validation refusal');}}));
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'&&error.operationMayHaveExecuted===false);
 assert.ok(fs.existsSync(x.backupFile),'a real backup exists, so the claim must survive');
 assert.deepEqual(x.claim.events,[]);
});

test('a started rehearsal keeps the claim even when no source intent was written',async t=>{
 const x=withClaim(await setup(t,{nativeResult:false}));
 await assert.rejects(x.operation.execute(x.context),/preparation_failed/);
 assert.ok(fs.existsSync(x.rehearsal));assert.equal(fs.existsSync(path.join(x.f.base,'.work-data','maintenance-v1.json')),false);
 assert.deepEqual(x.claim.events,[]);
});

test('an existing rehearsal path keeps the claim once its creation is attempted',async t=>{
 const x=withClaim(await setup(t));await fsp.mkdir(x.rehearsal);
 await assert.rejects(x.operation.execute(x.context),error=>error.cause?.code==='work_data_setup.target_exists');
 assert.deepEqual(x.claim.events,[]);
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

test('a write refusal after the backup file was created keeps the claim and names that path',async t=>{
 const x=withClaim(await setup(t,{backupWriteFails:true}));
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.cause?.code==='EIO'&&error.operationMayHaveExecuted===false&&error.backupPath===x.backupFile);
 assert.deepEqual(x.claim.events,[],'a created package file is an effect the next boot must inspect');
 assert.equal(fs.existsSync(x.backupFile),true);
 assert.equal((await fsp.stat(x.backupFile)).size,0);
});

test('a refused backup durability flush keeps the claim because the bytes are already on disk',async t=>{
 const x=withClaim(await setup(t,{failBackupFlush:true}));
 await assert.rejects(x.operation.execute(x.context),error=>error.code==='work_data_setup.preparation_failed'
  &&error.operationMayHaveExecuted===false&&error.backupPath===x.backupFile);
 assert.deepEqual(x.claim.events,[]);
 assert.ok((await fsp.stat(x.backupFile)).size>0);
});
