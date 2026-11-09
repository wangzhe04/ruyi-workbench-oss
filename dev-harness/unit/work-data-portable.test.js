'use strict';
const {test}=require('node:test'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture,portableFixture,fullPortableOwner,installStandalone,targetProtector,hash}=require('../lib/work-data-portable-fixture');
// The shared representation fixture injects a simulated native metadata/stream
// adapter. The portable path now requires that any supplied native model can
// also open its bound-directory durability broker; without one the owner
// correctly refuses with portable_durability_required. Attach a broker that
// walks and re-reads the actual stage instead of acknowledging blindly.
function withPortableDurability(f){
 const native=f.special.native,tokens=new Map();
 const failure=name=>Object.assign(new Error('synthetic native durability '+name),{code:'work_data_backup.'+name,retry:false});
 native.openPortableDurability=async()=>{
  let closed=false;
  return {
   async command(request){
    if(closed||!request||typeof request!=='object')throw failure('portable_durability_binding');
    if(request.cmd==='store-flush-bound'){
     const info=await native.info(request.root);
     return Object.freeze({schema:1,kind:'bound-directory-flush-v1',root:request.root,id:info.id,volume:info.volume,role:request.role,ordinal:request.ordinal,flushed:true});
    }
    if(request.cmd==='capture-owned-flush-ready'){
     const info=await native.info(request.root),snapshot=await native.capture(request.root,request.revision),token=crypto.randomBytes(32).toString('hex');
     tokens.set(token,{root:request.root,revision:request.revision,snapshot});
     return Object.freeze({schema:1,scope:'owned-stage',snapshot,token,volume:info.volume});
    }
    if(request.cmd==='flush-captured-directories'){
     const known=tokens.get(request.token);
     if(!known||known.root!==request.root||known.revision!==request.revision)throw failure('portable_durability_binding');
     const snapshot=await native.capture(request.root,request.revision);
     const directories=snapshot.entries.filter(entry=>entry.dir).map(entry=>({id:entry.id,rel:entry.rel}))
       .sort((a,b)=>b.rel.length-a.rel.length||(a.rel<b.rel?-1:a.rel>b.rel?1:0));
     const ids=new Set(directories.map(entry=>entry.id));
     if(!Array.isArray(request.directoryIds)||request.directoryIds.length!==directories.length||new Set(request.directoryIds).size!==directories.length
       ||request.directoryIds.some(id=>!ids.has(id)))throw failure('portable_durability_binding');
     const info=await native.info(request.root);
     return Object.freeze({schema:1,kind:'captured-directory-flush-v1',role:'owned-stage',root:request.root,revision:request.revision,token:request.token,volume:info.volume,allFlushed:true,metadataExact:true,count:directories.length,directories});
    }
    throw failure('portable_durability_binding');
   },
   async close(){closed=true;}
  };
 };
 return f;
}

test('actual empty V3 store exports authenticated exact closed portable records without source changes',async t=>{
 const f=await portableFixture(t),{captured,request}=await f.capture();try{const before=await f.tree.verify(captured),portable=await f.owner.capturePortable(request);assert.equal(portable.type,'skill-backup-portable');assert.equal(portable.sourceSha256,request.source.sourceSha256);const value=await f.owner.validatePortable({...request,data:portable.data});assert.equal(value.records.length,3);assert.equal(value.profile.originalObjects,'refused');assert.equal(value.authority.id,f.selected.id);assert.equal((await f.tree.verify(captured)).sha256,before.sha256);portable.release();assert.equal(portable.data.every(n=>n===0),true);}finally{captured.release();}
});
test('catalogued nonempty capsule migrates through durable prepared and ready host callbacks',async t=>{
 const f=await portableFixture(t),plain=await f.special.plain(),base=f.base,selected=f.selected;
 f.special.context.WorkDataTree=f.api.WorkDataTree;
 f.special.fx.store.Hooks.capturedFiles=f.fx.store.Hooks.capturedFiles;
 await fsp.writeFile(path.join(plain.backup,'.ruyi-import.json'),JSON.stringify(plain.record));
 const liveProvenance=vm.runInNewContext('WorkDataStore',f.special.context).createText({
  file:()=>path.join(plain.live,'.ruyi-import.json'),purpose:'backup',schema:1,scopeId:'skills',
  recordId:'skill-import:'+(process.platform==='win32'?plain.skillId.toLowerCase():plain.skillId),
  keys:f.keys,chunked:true,maxPlaintextBytes:16*1024,enabled:()=>true,writeJson:f.fx.atomicWriteJson});
 await fsp.unlink(path.join(plain.live,'.ruyi-import.json'));await liveProvenance.write(JSON.stringify(plain.record));
 const live=path.join(selected.root,'skills',plain.skillId);
 await fsp.mkdir(path.dirname(live),{recursive:true});await fsp.rename(plain.live,live);
 await fsp.unlink(path.join(base,'migrations',f.special.stamp+'.json'));
 const backup=path.join(base,'.work-data','skill-backups','objects-v1',f.special.stamp,plain.skillId);
 const objects=path.join(backup,'objects'),revision='1'.repeat(64);
 await fsp.mkdir(objects,{recursive:true});
 const snapshot=await f.special.native.capture(plain.backup,revision);
 const descriptor={backup,stamp:f.special.stamp,id:plain.skillId,scopeId:'skill-backups:'+f.special.stamp,
  recordId:'skill-backup:'+(process.platform==='win32'?plain.skillId.toLowerCase():plain.skillId),archiveKeys:f.keys,intentKeys:f.keys};
 const intent={schema:1,id:descriptor.id,stamp:descriptor.stamp,revision,phase:'published',oldRoot:snapshot.entries[0].id,
  newTree:f.special.api.migrationCapsuleFingerprint(await f.special.native.capture(live,revision)),sourceStage:'.ruyi-copy-'+descriptor.id+'-'+descriptor.stamp};
 await f.special.api.migrationCapsuleArchive(descriptor).write(require('node:zlib').gzipSync(Buffer.from(JSON.stringify(snapshot))));
 await f.special.api.migrationCapsuleWriteIntent(descriptor,intent);
 await f.special.native.seal({root:plain.backup,container:objects,snapshot});
 await fsp.writeFile(path.join(backup,'.ruyi-capsule-v1'),'{"version":1}');
 const nativeCapture=f.special.native.capture;
 f.special.native.capture=async(...args)=>{
  const result=await nativeCapture(...args);
  for(const row of result.entries)row.opaque=crypto.randomBytes(32).toString('hex');
  return result;
 };
 const intentFile=path.join(base,'.work-data','maintenance-v1.json');
 await fsp.unlink(intentFile);
 const sourceProof=await fullPortableOwner(f).seal({password:'synthetic nonempty migration password',appVersion:'3.0.1',generation:selected.generation});
 assert.equal(sourceProof.specialCoverage.originalObjects,'new-owned-portable');
 withPortableDurability(f);
 f.special.native.createOwnedPortable=async({root,snapshot:input,revision})=>{
  for(const row of [...input.entries].sort((a,b)=>a.rel.length-b.rel.length)){
   const target=path.join(root,...row.rel.split('/')),data=row.streams.find(stream=>stream.name==='');
   if(row.dir)await fsp.mkdir(target);else await fsp.writeFile(target,Buffer.from(data.data,'base64'),{flag:'wx'});
   const id=f.special.nativeId(target);
   f.special.metadata.set(id,{attrs:row.attrs,times:row.times,shortName:row.shortName});
   f.special.streams.set(id,new Map(row.streams.filter(stream=>stream.name!=='').map(stream=>[stream.name,Buffer.from(stream.data,'base64')])));
  }
  return f.special.native.capture(root,revision);
 };
 const restoredRoot=path.join(f.root,'stable-native-portable-target'),restoreOwner={roots:[restoredRoot]};
 const staged=await fullPortableOwner(f).restore({serialized:sourceProof.serialized,password:'synthetic nonempty migration password',target:restoredRoot,targetOwnership:restoreOwner});
 assert.equal(staged.specialProfile.originalObjects,'new-owned-portable');
 const resealed=await fullPortableOwner({...f,base:restoredRoot}).seal({password:'synthetic nonempty migration password',appVersion:'3.0.1',generation:selected.generation});
 assert.equal(resealed.specialCoverage.originalObjects,'new-owned-portable');
 const backupReceipt={sha256:hash(sourceProof.serialized)},ownership={roots:[base]},callbacks=[];
 const writeIntent=async info=>{
  const data=Buffer.from(JSON.stringify(info||{}));await fsp.writeFile(intentFile,data);
  const stat=await fsp.lstat(intentFile,{bigint:true});
  return {ownedFile:{name:'.work-data/maintenance-v1.json',identity:{dev:String(stat.dev),ino:String(stat.ino)},sha256:hash(data)}};
 };
 await writeIntent();
 const capturePreserved=async(root,revision)=>{
  const captured=await f.special.native.capture(root,revision);
  for(const row of captured.entries){
   const stat=await fsp.lstat(path.join(root,...row.rel.split('/')),{bigint:true});
   row.id=stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0');
  }
  return captured;
 };
 const host=f.api.WorkDataMigrationHost.create({base,ownership,manifest:f.manifest,protector:f.protector,assertExclusive:()=>true,assertExclusiveSync:()=>true,
  preservedRead:{profile:'bounded-native-v1',capturePreserved},
  assertDurableBackup:request=>request.backupReceipt===backupReceipt&&request.sourceProof===sourceProof,assertIntent:writeIntent,
  onCandidate:writeIntent,onKeyReady:writeIntent,assertSpecialCoverage:()=>true,
  async onSpecialPrepared(info){assert.equal(fs.existsSync(path.join(backup,'.ruyi-capsule-v1')),true);callbacks.push(info.transition);return writeIntent(info);},
  async onSpecialReady(info){assert.equal(f.special.nativeId(backup),snapshot.entries[0].id);callbacks.push(info.transitionReady);return writeIntent(info);},
  specialOwnerFactory:options=>f.special.api.hooks.createBackupOwner({...options,native:f.special.native}),writeJson:f.fx.atomicWriteJson});
 const prepared=await host.prepare({expected:selected,targetMode:'plain',sourceProof,backupReceipt});
 assert.equal(callbacks.length,2);assert.match(callbacks[0].preparedSha256,/^[a-f0-9]{64}$/);assert.match(callbacks[1].targetNativeSha256,/^[a-f0-9]{64}$/);
 const published=await host.publish(prepared),verified=await host.verifyPublished(prepared);
 assert.equal(published.active.mode,'plain');assert.equal(verified.targetSha256,callbacks[1].targetSha256);
 assert.equal(f.special.nativeId(backup),snapshot.entries[0].id);assert.equal(await fsp.readFile(path.join(backup,'SKILL.md'),'utf8'),'ORIGINAL');
});
for(const changedStream of [false,true])test(changedStream
 ?'legacy admission rejects an ADS added after portable verification and before the move'
 :'legacy generation-zero nonempty backup moves only after authenticated durable host receipt',async t=>{
 const f=await fixture(t),base=f.base,plain=await f.special.plain(),selected=await f.manifest.readActive();
 await f.write('config.json','{}');
 await fsp.writeFile(path.join(plain.backup,'.ruyi-import.json'),JSON.stringify(plain.record));
 await fsp.writeFile(path.join(plain.live,'.ruyi-import.json'),JSON.stringify(plain.record));
 f.special.context.WorkDataTree=f.api.WorkDataTree;f.special.context.WorkDataMigrationCodecs=f.api.WorkDataMigrationCodecs;
 f.special.fx.store.Hooks.capturedFiles=f.fx.store.Hooks.capturedFiles;
 const sourceProof=await fullPortableOwner(f).seal({password:'synthetic legacy nonempty password',appVersion:'3.0.1',generation:0});
 assert.equal(sourceProof.specialCoverage.originalObjects,'new-owned-portable');
 assert.equal(sourceProof.specialCoverage.sourcePath,'migrations/skill-backups');
 const updateDirectoryAccess=(dir,access)=>{
  const state=f.special.metadata.get(f.special.nativeId(dir)),[creation,,write,change]=state.times;
  f.special.metadata.set(f.special.nativeId(dir),{...state,times:[creation,access,write,change]});
 };
 updateDirectoryAccess(plain.backup,'11');
 updateDirectoryAccess(plain.live,'12');
 const ownership={roots:[base]},backupReceipt={sha256:hash(sourceProof.serialized)},intentFile=path.join(base,'.work-data','maintenance-v1.json');
 const stable=path.join(base,'.work-data','skill-backups','objects-v1'),oldId=f.special.nativeId(plain.backup),callbacks=[];
 const writeIntent=async info=>{
  const data=Buffer.from(JSON.stringify(info||{}));await fsp.mkdir(path.dirname(intentFile),{recursive:true});await fsp.writeFile(intentFile,data);
  const stat=await fsp.lstat(intentFile,{bigint:true});
  return {ownedFile:{name:'.work-data/maintenance-v1.json',identity:{dev:String(stat.dev),ino:String(stat.ino)},sha256:hash(data)}};
 };
 const capturePreserved=async(root,revision)=>{
  const captured=await f.special.native.capture(root,revision);
  for(const row of captured.entries){
   const stat=await fsp.lstat(path.join(root,...row.rel.split('/')),{bigint:true});
   row.id=stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0');
  }
  return captured;
 };
 await writeIntent();
 const host=f.api.WorkDataMigrationHost.create({base,ownership,manifest:f.manifest,protector:f.protector,assertExclusive:()=>true,assertExclusiveSync:()=>true,
  preservedRead:{profile:'bounded-native-v1',capturePreserved},assertDurableBackup:request=>request.backupReceipt===backupReceipt&&request.sourceProof===sourceProof,
  assertIntent:writeIntent,onCandidate:writeIntent,onKeyReady:writeIntent,assertSpecialCoverage:()=>true,
  async onSpecialPrepared(info){
   assert.equal(f.special.nativeId(plain.backup),oldId);assert.equal(fs.existsSync(stable),false);
   updateDirectoryAccess(plain.backup,'13');
   callbacks.push('prepared');return writeIntent(info);
  },
  async onSpecialReady(info){
   assert.equal(fs.existsSync(plain.backup),false);assert.equal(fs.existsSync(stable),true);
   callbacks.push('ready');return writeIntent(info);
  },
  specialOwnerFactory:options=>{
   const owner=f.special.api.hooks.createBackupOwner({...options,native:f.special.native});
   if(!changedStream)return owner;
   return {...owner,prepareRepresentation(token,prepareOptions){
    const file=path.join(plain.backup,'SKILL.md');
    f.special.streams.set(f.special.nativeId(file),new Map([[':unexpected:$DATA',Buffer.from('SYNTHETIC')]]));
    return owner.prepareRepresentation(token,prepareOptions);
   }};
  },writeJson:f.fx.atomicWriteJson});
 if(changedStream){
  await assert.rejects(host.prepare({expected:selected,targetMode:'encrypted',sourceProof,backupReceipt}),
   {code:'work_data_backup.representation_prepared_changed'});
  assert.equal(fs.existsSync(stable),false);
  assert.equal(f.special.nativeId(plain.backup),oldId);
  assert.deepEqual(callbacks,[]);
  return;
 }
 const prepared=await host.prepare({expected:selected,targetMode:'encrypted',sourceProof,backupReceipt});
 assert.deepEqual(callbacks,['prepared','ready']);
 const published=await host.publish(prepared),verified=await host.verifyPublished(prepared);
 assert.equal(published.active.mode,'encrypted');assert.equal(verified.generation,1);
 const capsule=path.join(stable,f.special.stamp,plain.skillId);
 assert.equal(fs.existsSync(path.join(capsule,'.ruyi-capsule-v1')),true);
 assert.ok((await fsp.readdir(path.join(capsule,'objects'))).some(name=>f.special.nativeId(path.join(capsule,'objects',name))===oldId));
});
test('terminal typed history is authenticated as source history, preserving bytes and never creating undo eligibility',async t=>{
 const f=await portableFixture(t),stamp='2026-10-24T00-00-00-000Z',id='Tool_One',wrapper=path.join(f.base,'.work-data','skill-backups','objects-v1',stamp,id),original=path.join(f.root,'source-terminal');await fsp.mkdir(original);await fsp.writeFile(path.join(original,'SKILL.md'),'TERMINAL_HISTORY_PRIVATE');const snapshot=await f.special.native.capture(original,'1'.repeat(64));await fsp.mkdir(wrapper,{recursive:true});const descriptor={backup:wrapper,stamp,id,recordId:'skill-backup:tool_one',archiveKeys:f.keys},historyStore=vm.runInNewContext('migrationBackupHistoryStore',f.special.context);await historyStore(descriptor,'encrypted').write(JSON.stringify({schema:1,type:'terminal-skill-backup-history',historyOnly:true,id,stamp,phase:'complete',snapshot}));await fsp.writeFile(path.join(wrapper,'.ruyi-backup-history-v1'),JSON.stringify({schema:1,mode:'encrypted'}));
 const {captured,request}=await f.capture();try{const portable=await f.owner.capturePortable(request),value=await f.owner.validatePortable({...request,data:portable.data}),record=value.records.find(row=>row.kind==='history');assert.equal(record.value.historyOnly,true);assert.equal(record.value.phase,'complete');assert.equal(record.value.snapshot.entries.find(entry=>!entry.dir).streams[0].data,Buffer.from('TERMINAL_HISTORY_PRIVATE').toString('base64'));assert.equal(record.value.eligibility,undefined);assert.equal(value.profile.terminalSnapshots,'source-history-only');portable.release();}finally{captured.release();}
});
test('unknown child, pending journal and source control ADS never receive a portable-success claim',async t=>{
 for(const type of['unknown','pending','ADS']){const f=await portableFixture(t);if(type==='unknown')await fsp.writeFile(path.join(f.base,'.work-data','skill-backups','unknown'),'PRESERVE');if(type==='pending'){const store=vm.runInNewContext('WorkDataStore',f.special.context).createText({file:()=>path.join(f.base,'.work-data','skill-backups','relocation-v1.sealed'),purpose:'backup',schema:1,scopeId:'skill-backup-owner:'+hash(path.resolve(f.base).toLowerCase()).slice(0,32),recordId:'relocation-v1',keys:f.keys,chunked:true,maxPlaintextBytes:256*1024*1024,enabled:()=>true,writeJson:f.fx.atomicWriteJson});const {captured,request}=await f.capture();const good=await f.owner.capturePortable(request),value=JSON.parse(good.data),journal=value.records.find(row=>row.kind==='relocation').value;good.release();captured.release();await store.write(JSON.stringify({...journal,phase:'moved'}));}if(type==='ADS'){const file=path.join(f.base,'.work-data','skill-backups','catalog-v1.sealed');f.special.streams.set(f.special.nativeId(file),new Map([[':unknown:$DATA',Buffer.from('PRIVATE_ADS')]]));}const {captured,request}=await f.capture();try{await assert.rejects(()=>f.owner.capturePortable(request));}finally{captured.release();}}
});
test('original-object capsule namespace remains explicit special-required, including a retained raw archive',async t=>{
 const f=await portableFixture(t);await fsp.mkdir(path.join(f.base,'.work-data','skill-backups','objects-v1','2026-10-24T00-00-00-000Z','one'),{recursive:true});await fsp.writeFile(path.join(f.base,'.work-data','skill-backups','objects-v1','2026-10-24T00-00-00-000Z','one','archive'),'PRESERVE ORIGINAL CAPSULE');const {captured,request}=await f.capture();try{await assert.rejects(()=>f.owner.capturePortable(request),{code:'work_data_backup.portable_original_capsule_required'});}finally{captured.release();}
});
test('fixed typed auxiliary source binds all special generation files and empty directory names through the real password codec',async t=>{
 const f=await portableFixture(t),{captured,request}=await f.capture();try{const portable=await f.owner.capturePortable(request),lease=await f.keys.snapshot(),recovery=f.api.WorkDataRecovery.create(),snapshot={appVersion:'3.0.1',generation:f.selected.generation,createdAt:new Date().toISOString(),directories:[...captured.directories],files:captured.files.map(row=>({path:row.path,data:row.data,keyRefs:[]})),keys:[{id:'work-data:'+lease.instanceId,purpose:'work-data',instanceId:lease.instanceId,protectedKey:f.header.protectedKey,master:lease.key}],auxiliaries:[{type:portable.type,schema:portable.schema,sourcePath:portable.sourcePath,sourceSha256:portable.sourceSha256,data:portable.data}]};const serialized=await recovery.seal(snapshot,'synthetic portable password');lease.release();portable.release();const opened=await recovery.open(serialized,'synthetic portable password');try{assert.equal(opened.snapshot.auxiliaries[0].type,'skill-backup-portable');assert.equal((await f.owner.validatePortable({files:opened.snapshot.files,directories:opened.snapshot.directories,source:recovery.skillBackupSource(opened.snapshot.files,opened.snapshot.directories),readCaptured:f.readCaptured,data:opened.snapshot.auxiliaries[0].data})).authority.id,f.selected.id);}finally{opened.release();}
 const wrong={...snapshot,auxiliaries:[{...snapshot.auxiliaries[0],data:Buffer.from('{}'),sourceSha256:'0'.repeat(64)}]};await assert.rejects(()=>recovery.seal(wrong,'synthetic portable password'),{code:'work_data_recovery.auxiliary_invalid'});
 }finally{captured.release();}
});

test('portable empty store stages native identity before target mkdir and cold owner opens new-base control AAD',async t=>{
 const f=withPortableDurability(await portableFixture(t)),{captured,request}=await f.capture(),target=path.join(f.root,'portable-target');try{const portable=await f.owner.capturePortable(request),sourceCatalog=JSON.parse(portable.data).records.find(row=>row.kind==='catalog').value,token=await f.owner.stagePortable({...request,data:portable.data,target,keysFor:async()=>f.keys,assertTargetExclusive:async()=>true});assert.equal(fs.existsSync(target),false);assert.ok(token.files.length===3);assert.equal(sourceCatalog.rootId===token.stageIdentity.id,false);await installStandalone(f,captured,token,target);const targetManifest=f.api.WorkDataManifest.create({base:target,publish:()=>{throw Error('read-only');}}),cold=f.special.api.hooks.createBackupOwner({base:target,readActive:()=>targetManifest.readActive(),sourceKeys:f.keys,targetKeys:f.keys,native:f.special.native});const verified=await cold.verifyPublished({expected:await targetManifest.readActive()});assert.notEqual(verified.rootId,sourceCatalog.rootId);assert.equal(verified.storeId,sourceCatalog.storeId);assert.equal((await f.owner.verifyPortableInstalled(token)).readOnly,true);await assert.rejects(()=>f.owner.installPortable(token,{targetIdentity:{dev:'0',ino:'0'}}),{code:'work_data_backup.portable_token'});portable.release();token.release();assert.equal((await f.tree.verify(captured)).files,captured.files.length);}finally{captured.release();}
});
test('portable stage cannot overwrite or alias source/target and rejects owner loss before mutation',async t=>{
 const f=withPortableDurability(await portableFixture(t)),{captured,request}=await f.capture();try{const portable=await f.owner.capturePortable(request);await assert.rejects(()=>f.owner.stagePortable({...request,data:portable.data,target:f.base,keysFor:async()=>f.keys,assertTargetExclusive:async()=>true}),{code:'work_data_backup.portable_target'});const target=path.join(f.root,'existing-target');await fsp.mkdir(target);await assert.rejects(()=>f.owner.stagePortable({...request,data:portable.data,target,keysFor:async()=>f.keys,assertTargetExclusive:async()=>true}),{code:'work_data_backup.portable_target_exists'});await assert.rejects(()=>f.owner.stagePortable({...request,data:portable.data,target:path.join(f.root,'denied-target'),keysFor:async()=>f.keys,assertTargetExclusive:async()=>false}),{code:'work_data_backup.portable_owner'});portable.release();}finally{captured.release();}
});


test('actual fullsnapshot exports after enable and restores native new-base empty store plus cold foreign-account keys',async t=>{
 const f=withPortableDurability(await portableFixture(t));await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const id='a'.repeat(48),result={schema:1,id,operation:'enable',finishedAt:new Date().toISOString(),state:'published',sourceAuthority:{generation:0,id:null,mode:'plain',sha256:null},authority:{generation:1,id:f.selected.id,mode:'encrypted',sha256:f.selected.proof.sha256},backup:{path:path.join(f.root,'missing-old-machine','ruyi-work-data-'+id+'.ruyi-backup'),sha256:'b'.repeat(64),bytes:1,identity:{dev:'1',ino:'2'}}},resultBytes=Buffer.from(JSON.stringify(result));await f.write('.work-data/maintenance-result-v1.json',resultBytes);const owner=fullPortableOwner(f),source=await f.tree.capture(f.base),before=await f.tree.verify(source);try{const sealed=await owner.seal({password:'synthetic portable package password',appVersion:'3.0.1',generation:1});assert.equal(sealed.specialCoverage.type,'skill-backup-portable');const target=path.join(f.root,'foreign-account-target'),native=targetProtector(target);let restored;await assert.doesNotReject(async()=>{restored=await fullPortableOwner(f,native).restore({serialized:sealed.serialized,password:'synthetic portable package password',target,targetOwnership:{roots:[target]}});});assert.match(restored.nativeMetadata,/new native store identity/);assert.equal(restored.specialProfile.originalObjects,'refused');assert.deepEqual(await fsp.readFile(path.join(target,'.work-data','maintenance-result-v1.json')),resultBytes);native.state.guard=false;const manifest=f.api.WorkDataManifest.create({base:target,publish:()=>{throw Error('read-only');}}),selected=await manifest.readActive(),header=JSON.parse(await fsp.readFile(path.join(selected.root,'work-data-key-v1.json'),'utf8')),keys=f.api.WorkDataKeys.create({protector:native,enabled:()=>true,store:{read:async()=>header}}),cold=f.special.api.hooks.createBackupOwner({base:target,readActive:()=>manifest.readActive(),sourceKeys:keys,targetKeys:keys,native:f.special.native});assert.equal((await cold.verifyPublished({expected:selected})).generationId,selected.id);assert.equal((await f.tree.verify(source)).sha256,before.sha256);assert.ok(restored.stagedStates.some(row=>row.path==='.work-data/skill-backups/catalog-v1.sealed'&&row.sourceSha256!==row.stagedSha256));keys.clear();}finally{source.release();}
});
test('snapshot result metadata uses actual static schema and never exempts an unknown wx stage',async t=>{
 for(const kind of['bad-result','stage']){const f=await portableFixture(t);await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));await f.write('.work-data/'+(kind==='bad-result'?'maintenance-result-v1.json':'.maintenance-result-v1.stage-'+'1'.repeat(48)),'{}');await assert.rejects(()=>fullPortableOwner(f).seal({password:'synthetic portable package password',appVersion:'3.0.1',generation:1}));assert.equal((await f.manifest.readActive()).generation,1);}
});
test('actual enable -> complete portable export -> plain shadow -> new generation cold read retains old source and backup',async t=>{
 const f=await portableFixture(t);await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const password='synthetic second direction password',sealed=await fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:1}),backupFile=path.join(f.root,'verified-second-backup.ruyi-backup');const handle=await fsp.open(backupFile,'wx');try{await handle.writeFile(sealed.serialized);await handle.sync();}finally{await handle.close();}const backupReceipt=Object.freeze({file:backupFile,sha256:hash(Buffer.from(sealed.serialized))}),expected=await f.manifest.readActive();let intentCount=0;const intent=async()=>{const data=Buffer.from(JSON.stringify({schema:1,count:++intentCount})),file=path.join(f.base,'.work-data','maintenance-v1.json');await fsp.writeFile(file,data);const stat=await fsp.lstat(file,{bigint:true});return{ownedFile:{name:'.work-data/maintenance-v1.json',sha256:hash(data),identity:{dev:String(stat.dev),ino:String(stat.ino)}}};};await intent();const host=f.api.WorkDataMigrationHost.create({base:f.base,ownership:{roots:[f.base]},assertExclusive:async()=>true,manifest:f.manifest,protector:f.protector,assertDurableBackup:async request=>request.backupReceipt===backupReceipt&&request.sourceProof===sealed&&hash(await fsp.readFile(backupFile))===backupReceipt.sha256,assertIntent:intent,onCandidate:intent,onKeyReady:intent,assertSpecialCoverage:async request=>request.backupReceipt===backupReceipt&&request.sourceProof===sealed&&sealed.specialCoverage.type==='skill-backup-portable',maintenanceResultOwner:f.api.WorkDataMaintenanceResult,specialOwnerFactory:options=>f.special.api.hooks.createBackupOwner({...options,native:f.special.native}),writeJson:f.fx.atomicWriteJson});const old=await fsp.readFile(path.join(expected.root,'sessions','sess_one.json')),prepared=await host.prepare({expected,targetMode:'plain',backupReceipt,sourceProof:sealed}),published=await host.publish(prepared),verified=await host.verifyPublished(prepared);assert.equal(published.active.generation,2);assert.equal(verified.mode,'plain');assert.equal(await fsp.readFile(path.join(published.active.root,'sessions','sess_one.json'),'utf8'),'{"id":"sess_one","text":"SECOND_DIRECTION_PRIVATE"}');assert.deepEqual(await fsp.readFile(path.join(expected.root,'sessions','sess_one.json')),old);assert.equal(hash(await fsp.readFile(backupFile)),backupReceipt.sha256);await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const second=await fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:2});assert.equal(second.specialCoverage.type,'skill-backup-portable');
});
test('valid BOM logical session JSON keeps original bytes through full backup and actual migration codecs',async t=>{
 const f=await fixture(t),logical='\uFEFF{"id":"sess_one","text":"BOM_SESSION_PRIVATE"}';await f.write('sessions/sess_one.json',logical);const expected=await f.manifest.readActive(),backup=await f.backupFirst(),token=await f.host.prepare({...backup,expected,targetMode:'encrypted'}),selected=(await f.host.publish(token)).active,header=JSON.parse(await fsp.readFile(path.join(selected.root,'work-data-key-v1.json'),'utf8')),keys=f.api.WorkDataKeys.create({protector:f.protector,enabled:()=>true,store:{read:async()=>header}}),d=f.api.WorkDataMigrationCodecs.describe('sessions/sess_one.json');assert.equal(await f.fx.store.createText({...d,file:()=>path.join(selected.root,'sessions','sess_one.json'),keys,enabled:()=>true,writeJson:f.fx.atomicWriteJson}).read(),logical);assert.equal(await fsp.readFile(path.join(f.base,'sessions','sess_one.json'),'utf8'),logical);keys.clear();
});
test('typed history full portable restore preserves authenticated raw carrier and remains terminal on the new native store',async t=>{
 const f=withPortableDurability(await portableFixture(t)),stamp='2026-10-24T00-00-00-000Z',id='Tool_One',wrapper=path.join(f.base,'.work-data','skill-backups','objects-v1',stamp,id),original=path.join(f.root,'terminal-original');await fsp.mkdir(original);await fsp.writeFile(path.join(original,'SKILL.md'),'TYPED_TERMINAL_ORIGINAL');const snapshot=await f.special.native.capture(original,'2'.repeat(64));await fsp.mkdir(wrapper,{recursive:true});const descriptor={backup:wrapper,stamp,id,recordId:'skill-backup:tool_one',archiveKeys:f.keys};await vm.runInNewContext('migrationBackupHistoryStore',f.special.context)(descriptor,'encrypted').write(JSON.stringify({schema:1,type:'terminal-skill-backup-history',historyOnly:true,id,stamp,phase:'aborted',snapshot}));await fsp.writeFile(path.join(wrapper,'.ruyi-backup-history-v1'),JSON.stringify({schema:1,mode:'encrypted'}));const raw=await fsp.readFile(path.join(wrapper,'history'));await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const password='synthetic terminal portable package',sealed=await fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:1}),target=path.join(f.root,'terminal-target');await fullPortableOwner(f).restore({serialized:sealed.serialized,password,target,targetOwnership:{roots:[target]}});assert.deepEqual(await fsp.readFile(path.join(target,'.work-data','skill-backups','objects-v1',stamp,id,'history')),raw);const targetWrapper=path.join(target,'.work-data','skill-backups','objects-v1',stamp,id),history=await f.special.readHistory(targetWrapper,{...descriptor,backup:targetWrapper});assert.equal(history.phase,'aborted');assert.equal(history.historyOnly,true);assert.deepEqual(JSON.parse(JSON.stringify(history.snapshot)),JSON.parse(JSON.stringify(snapshot)));assert.equal(history.eligibility,undefined);
});
test('portable source closure cannot be supplied as a caller-selected subset',async t=>{
 const f=await portableFixture(t),{captured,request}=await f.capture();try{const forged={...request,source:{...request.source,files:request.source.files.slice(1)}};await assert.rejects(()=>f.owner.capturePortable(forged),{code:'work_data_backup.portable_source'});}finally{captured.release();}
});
test('a new ADS in owned staging prevents installation and preserves the original authority',async t=>{
 const f=withPortableDurability(await portableFixture(t)),{captured,request}=await f.capture(),target=path.join(f.root,'stage-ADS-target');try{const portable=await f.owner.capturePortable(request),token=await f.owner.stagePortable({...request,data:portable.data,target,keysFor:async()=>f.keys,assertTargetExclusive:async()=>true}),file=path.join(token.stageRoot,...token.files[0].path.split('/'));f.special.streams.set(f.special.nativeId(file),new Map([[':unexpected:$DATA',Buffer.from('PRESERVE ADS')]]));await assert.rejects(()=>installStandalone(f,captured,token,target),{code:'work_data_backup.portable_stage_changed'});assert.equal((await f.manifest.readActive()).id,f.selected.id);portable.release();token.release();}finally{captured.release();}
});
test('typed history nested real provenance closes both working masters and refuses missing retained header',async t=>{
 const f=await portableFixture(t),stamp='2026-10-24T00-00-00-000Z',id='Tool_One',wrapper=path.join(f.base,'.work-data','skill-backups','objects-v1',stamp,id),original=path.join(f.root,'nested-history-original'),maker=f.api.WorkDataKeys.create({protector:f.protector,enabled:()=>false,store:{read:async()=>f.api.WorkDataKeys.empty()}}),staged=await maker.stageNew();await f.write('work-data-key-v1.json.prev',JSON.stringify(staged.header));staged.lease.release();const oldKeys=f.api.WorkDataKeys.create({protector:f.protector,enabled:()=>true,store:{read:async()=>staged.header}});await fsp.mkdir(original);await fsp.writeFile(path.join(original,'SKILL.md'),'NESTED ORIGINAL');const prior=f.special.fx.store.Hooks.keys;f.special.fx.store.Hooks.keys=oldKeys;try{await f.special.api.skillImportRecordStore(original,id,true).write('{"schema":1,"source":"codex","sourcePath":"SOURCE_ONLY_PRIVATE","plugin":"","importedAt":"then","sourceTreeHash":"x","copyTreeHash":"y"}');}finally{f.special.fx.store.Hooks.keys=prior;}const snapshot=await f.special.native.capture(original,'3'.repeat(64));await fsp.mkdir(wrapper,{recursive:true});await vm.runInNewContext('migrationBackupHistoryStore',f.special.context)({backup:wrapper,stamp,id,recordId:'skill-backup:tool_one',archiveKeys:f.keys},'encrypted').write(JSON.stringify({schema:1,type:'terminal-skill-backup-history',historyOnly:true,id,stamp,phase:'complete',snapshot}));await fsp.writeFile(path.join(wrapper,'.ruyi-backup-history-v1'),JSON.stringify({schema:1,mode:'encrypted'}));await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const password='synthetic nested closed keys',sealed=await fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:1}),opened=await f.api.WorkDataRecovery.open(sealed.serialized,password);try{assert.equal(opened.snapshot.keys.length,2);const history=opened.snapshot.files.find(row=>row.path.endsWith('/Tool_One/history'));assert.equal(history.keyRefs.length,2);}finally{opened.release();}await fsp.unlink(path.join(f.base,'work-data-key-v1.json.prev'));await assert.rejects(()=>fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:1}),{code:'work_data_full.key_missing'});oldKeys.clear();maker.clear();
});

test('every retained generation binding must close to an actual terminal history carrier',async t=>{
 const f=await portableFixture(t),first=await f.capture();let binding;try{const portable=await f.owner.capturePortable(first.request);try{binding=JSON.parse(portable.data).records.find(row=>row.kind==='binding').value;}finally{portable.release();}}finally{first.captured.release();}
 const priorId='c'.repeat(48),stamp='2026-10-24T00-00-00-000Z',entry={ref:f.owner.ref(stamp,'ghost',binding.storeId),physicalSkillId:'ghost',kind:'history',historyMode:'encrypted',phase:'complete',eligibility:'terminal',sourceGenerationId:null,archiveSha:'0'.repeat(64),intentSha:'1'.repeat(64),newTree:null},relative='.work-data/generations/'+priorId+'/migrations/skill-backup-bindings-v2.sealed';
 await f.fx.store.createText({file:()=>path.join(f.base,...relative.split('/')),purpose:'backup',schema:1,scopeId:'skill-backup-owner:'+hash(path.resolve(f.base).toLowerCase()).slice(0,32),recordId:'bindings:'+priorId,keys:f.keys,chunked:true,maxPlaintextBytes:256*1024*1024,enabled:()=>true,writeJson:f.fx.atomicWriteJson}).write(JSON.stringify({...binding,generationId:priorId,entries:[entry]}));
 const next=await f.capture();try{await assert.rejects(()=>f.owner.capturePortable(next.request),{code:'work_data_backup.portable_binding'});}finally{next.captured.release();}
});

test('full restore rejects missing native installation or verification proof from an adapter',async t=>{
 for(const method of ['installPortable','verifyPortableInstalled']){const f=withPortableDurability(await portableFixture(t));await fsp.unlink(path.join(f.base,'.work-data','maintenance-v1.json'));const password='synthetic proof refusal password',sealed=await fullPortableOwner(f).seal({password,appVersion:'3.0.1',generation:1}),target=path.join(f.root,'bad-'+method),bad=f.api.WorkDataFullSnapshot.create({base:f.base,ownership:{roots:[f.base]},assertExclusive:async()=>true,protector:f.protector,externalOwner:options=>f.api.ExternalBotCredentials.create(options),maintenanceResultOwner:f.api.WorkDataMaintenanceResult,skillBackupOwner:options=>{const owner=f.special.api.hooks.createBackupOwner({...options,native:f.special.native});return{...owner,[method]:async(...args)=>{await owner[method](...args);return null;}};}});await assert.rejects(()=>bad.restore({serialized:sealed.serialized,password,target,targetOwnership:{roots:[target]}}),error=>error.code==='work_data_full.restore_failed'&&error.cause?.code==='work_data_full.special_owner_proof');assert.equal((await f.manifest.readActive()).id,f.selected.id);}
});
