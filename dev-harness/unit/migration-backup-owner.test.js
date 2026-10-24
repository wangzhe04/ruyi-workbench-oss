'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBackupOwnerFixture}=require('../lib/migration-backup-owner-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-backup-owner-unit-')),fixtures=[];
function negativeTransform(source){
 if(process.env.RUYI_BACKUP_OWNER_NEGATIVE==='physical-id')return source.replace('return source.backup;',"return path.join(stableRoot, backupRef.stamp, backupRef.skillId);");
 if(process.env.RUYI_BACKUP_OWNER_NEGATIVE==='variant-auth')return source.replace('const record = await migrationCapsuleRead({ ...descriptor(stableRoot, entry.ref.stamp, entry.physicalSkillId), ...variant });','const record = { intent: { phase: entry.phase, newTree: entry.newTree } };');
 if(process.env.RUYI_BACKUP_OWNER_NEGATIVE==='history')return source.replace("binding.sourceRootIds.map(id => path.join(id === null ? base : generationRoot(id), 'skills'))","[path.join(base, 'skills')]");
 return source;
}
const fixture=(options={})=>{const transform=options.sourceTransform;const f=createBackupOwnerFixture(root,{...options,sourceTransform:source=>negativeTransform(transform?transform(source):source)});fixtures.push(f);return f;};
after(()=>{for(const f of fixtures)f.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});

test('local owner creates an empty reversible stable store through the sealed journal',async()=>{
 const f=fixture(),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});assert.equal(fs.existsSync(token.root),true);assert.equal(f.state.moves,1);
 const recovered=await f.owner().recover();assert.equal(recovered.phase,'canceled');assert.equal(fs.existsSync(path.join(f.dir,'migrations','skill-backups')),true);assert.equal(f.state.moves,2);
});
test('simulated pre/post-rename crash reconciles the same directory object and never copies or overwrites unknown nodes',async()=>{
 for(const cut of ['before','after']){const f=fixture(),file=f.plain(),id=f.nativeId(path.dirname(file));f.state.failMove=cut;await assert.rejects(()=>f.owner().prepare({expected:f.expected,candidate:f.candidate}),e=>e.operationMayHaveExecuted===true&&e.retry===false);f.state.failMove=null;const r=await f.owner().recover();assert.equal(r.phase,'canceled');assert.equal(f.nativeId(path.dirname(file)),id);assert.equal(fs.readFileSync(file,'utf8'),'RETAINED PRIVATE');}
});
test('plain backups remain original objects and cannot be advertised as protected until their dedicated sealing owner exists',async()=>{
 const f=fixture(),file=f.plain(),id=f.nativeId(path.dirname(file)),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate}),binding=await owner.prepareBindings(token);assert.equal(binding.ready,false);f.commit();const kept=await f.owner().recover();assert.equal(kept.phase,'kept');const target=path.join(token.root,f.stamp,'one');assert.equal(f.nativeId(target),id);assert.equal(fs.readFileSync(path.join(target,'SKILL.md'),'utf8'),'RETAINED PRIVATE');await assert.rejects(()=>owner.activate(),{code:'work_data_backup.binding_missing'});
});
test('unknown target directory after a prepared move is retained and blocks ambiguous rollback',async()=>{
 const f=fixture();f.plain();const token=await f.owner().prepare({expected:f.expected,candidate:f.candidate});const legacy=path.join(f.dir,'migrations','skill-backups');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'UNKNOWN'),'KEEP');await assert.rejects(()=>f.owner().recover(),{code:'work_data_backup.store_identity'});assert.equal(fs.readFileSync(path.join(legacy,'UNKNOWN'),'utf8'),'KEEP');assert.equal(fs.existsSync(token.root),true);
});
test('a plaintext nested-marker relocation journal cannot acquire authority and remains byte exact',async()=>{
 const f=fixture();f.plain();await f.owner().prepare({expected:f.expected,candidate:f.candidate});const file=path.join(f.dir,'.work-data','skill-backups','relocation-v1.sealed'),plain='{"untrusted":{"workData":3}}';fs.writeFileSync(file,plain);await assert.rejects(()=>f.owner().recover(),e=>String(e.code).startsWith('work_data'));assert.equal(fs.readFileSync(file,'utf8'),plain);
});
test('copied replacement directory IDs cannot replace the original native store identity',async()=>{
 const f=fixture();f.plain();const token=await f.owner().prepare({expected:f.expected,candidate:f.candidate});const copy=token.root+'-COPY';await fsp.cp(token.root,copy,{recursive:true});fs.renameSync(token.root,token.root+'-ORIGINAL');fs.renameSync(copy,token.root);await assert.rejects(()=>f.owner().recover(),{code:'work_data_backup.store_identity'});assert.equal(fs.existsSync(token.root+'-ORIGINAL'),true);
});
test('real archive/intent codecs bind target generation IDs and permit only logically identical provenance re-encoding with simulated native capture',async()=>{
 const f=fixture(),cap=await f.capsule(),owner=f.owner(),original=fs.readFileSync(path.join(cap.backup,'intent')),token=await owner.prepare({expected:f.expected,candidate:f.candidate});const binding=await owner.prepareBindings(token);assert.equal(binding.ready,true);assert.equal(binding.entries,1);assert.deepEqual(fs.readFileSync(path.join(token.root,f.stamp,'one','intent')),original);f.commit();await owner.activate();const ref=owner.ref(f.stamp,'one',token.storeId);assert.equal(await owner.resolve(ref),path.join(token.root,f.stamp,'one'));const d=f.api.migrationCapsuleDescriptor(await owner.resolve(ref)),record=await f.api.migrationCapsuleRead(d);assert.equal(record.intent.generationId,f.candidate.id);assert.equal(record.intent.newTree.find(e=>e.rel==='').id,f.nativeId(cap.target));assert.notEqual(record.intent.newTree.find(e=>e.rel==='').id,f.nativeId(cap.source));assert.notEqual(fs.readFileSync(d.intentFile,'utf8'),original.toString('utf8'));
 await assert.rejects(()=>owner.resolve({...ref,storeId:'f'.repeat(48)}),{code:'work_data_backup.backup_ref'});
 await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:cap.source,backup:path.join(f.dir,'elsewhere',f.stamp,'one'),items:[{id:'one'}]}),{code:'work_data_backup.backup_ref'});
});
test('changed shadow content or changed logical provenance never receives an undo binding',async()=>{
 for(const changed of ['content','provenance']){const f=fixture(),cap=await f.capsule(),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});if(changed==='content')fs.writeFileSync(path.join(cap.target,'SKILL.md'),'FORGED SHADOW');else await f.api.skillImportRecordStore(cap.target,'one',true).write('{"schema":1,"source":"codex","sourcePath":"FORGED","plugin":"","importedAt":"now","sourceTreeHash":"hash","copyTreeHash":"hash"}');await assert.rejects(()=>owner.prepareBindings(token),{code:changed==='content'?'work_data_backup.binding_tree':'work_data_backup.binding_provenance'});assert.equal(fs.existsSync(path.join(cap.source,'SKILL.md')),true);}
});
test('edited source stays edited after the generation switch rather than blessing its copied bytes',async()=>{
 const f=fixture(),cap=await f.capsule();fs.writeFileSync(path.join(cap.source,'SKILL.md'),'USER EDIT');const owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});await owner.prepareBindings(token);f.commit();await owner.activate();const result=await f.api.migrationUndoSkillCopy({file:cap.source,backup:cap.backup,items:[{id:'one'}]});assert.equal(result.outcome,'kept');assert.equal(result.reason,'edited');assert.equal(fs.readFileSync(path.join(cap.source,'SKILL.md'),'utf8'),'USER EDIT');
});
test('source carriers changed after binding preparation block activation without altering either authority',async()=>{
 const f=fixture(),cap=await f.capsule(),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});await owner.prepareBindings(token);const archive=path.join(token.root,f.stamp,'one','archive');fs.appendFileSync(archive,'UNKNOWN');f.commit();await assert.rejects(()=>owner.activate(),{code:'work_data_backup.binding_source_changed'});assert.equal(fs.readFileSync(archive,'utf8').endsWith('UNKNOWN'),true);assert.equal(fs.existsSync(cap.source),true);assert.equal(fs.existsSync(cap.target),true);
});

// Archive, intent and binding crypto remain real. Only final native capture/restore
// are simulated here; the separately owned native probe must restore real objects.
function simulatedUndo(f) {
 f.replace('migrationCapsuleCapture',f.native.capture);
 f.replace('migrationCapsuleRestore',async(descriptor,snapshot,intent)=>{assert.equal(intent.phase,'restoring');assert.equal(descriptor.id,intent.id);intent.phase='complete';await f.api.migrationCapsuleWriteIntent(descriptor,intent);});
}
function choose(candidate,generation){const crypto=require('node:crypto'),raw=JSON.stringify({schema:1,id:candidate.id,generation,mode:'encrypted',activeRoot:'generations/'+candidate.id});return {...candidate,generation,proof:{raw,sha256:crypto.createHash('sha256').update(raw).digest('hex')}};}
async function newPublishedCapsule(f,storeRoot,source,snapshot,stamp,id){
 const backup=path.join(storeRoot,stamp,id);fs.mkdirSync(path.join(backup,'objects'),{recursive:true});fs.writeFileSync(path.join(backup,'.ruyi-capsule-v1'),'{}');
 const descriptor=f.api.migrationCapsuleDescriptor(backup);await f.api.migrationCapsuleArchive(descriptor).write(require('node:zlib').gzipSync(Buffer.from(JSON.stringify(snapshot))));const live=await f.native.capture(source,snapshot.revision);await f.api.migrationCapsuleWriteIntent(descriptor,{schema:1,id,stamp,revision:snapshot.revision,phase:'published',oldRoot:snapshot.entries[0].id,newTree:f.api.migrationCapsuleFingerprint(live),sourceStage:'.ruyi-copy-'+id+'-'+stamp});return backup;
}

test('logical Windows identity resolves the authenticated original mixed-case physical and intent ID through real codecs and simulated undo',async()=>{
 const f=fixture({skillId:'Tool_One'}),cap=await f.capsule(),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});await owner.prepareBindings(token);f.commit();await owner.activate();
 const ref=owner.ref(f.stamp,'Tool_One',token.storeId);assert.equal(ref.skillId,process.platform==='win32'?'tool_one':'Tool_One');
 const physical=await owner.resolve(ref);assert.equal(physical,path.join(token.root,f.stamp,'Tool_One'));
 const descriptor=f.api.migrationCapsuleDescriptor(physical),record=await f.api.migrationCapsuleRead(descriptor);assert.equal(descriptor.id,'Tool_One');assert.equal(record.intent.id,'Tool_One');
 simulatedUndo(f);const result=await f.api.migrationUndoSkillCopy({file:cap.source,backup:cap.backup,backupRef:ref,items:[{id:'Tool_One'}]});assert.equal(result.outcome,'restored-previous');
 await owner.activate();assert.equal((await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(await owner.resolve(ref)))).intent.phase,'complete');
});

test('activation authenticates the selected target variant before publishing an undo authority',async()=>{
 for(const damage of ['missing','plaintext','wrong-tree']){
  const f=fixture(),cap=await f.capsule(),owner=f.owner(),token=await owner.prepare({expected:f.expected,candidate:f.candidate});await owner.prepareBindings(token);
  const ref=owner.ref(f.stamp,'one',token.storeId),variant=path.join(f.dir,'.work-data','skill-backups','intents',f.candidate.id,ref.backupId+'.sealed');
  if(damage==='missing')fs.unlinkSync(variant);else if(damage==='plaintext')fs.writeFileSync(variant,'{"nested":{"workData":3}}');else{
   const d={...cap.descriptor,backup:path.join(token.root,f.stamp,'one'),generationId:f.candidate.id,intentFile:variant,intentRecordId:cap.descriptor.recordId+':intent:'+f.candidate.id};
   const record=await f.api.migrationCapsuleRead(d);record.intent.newTree[0].id='00000001'+'9'.repeat(16);await f.api.migrationCapsuleWriteIntent(d,record.intent);
  }
  f.commit();await assert.rejects(()=>owner.activate());assert.equal(fs.existsSync(cap.source),true);assert.equal(fs.existsSync(cap.target),true);
 }
});

test('authenticated generation history accepts logs created in a previous generation and rejects unrelated absolute paths',async()=>{
 const f=fixture({skillId:'Tool_One'}),cap=await f.capsule();let selected=f.expected;
 const owner=f.api.hooks.createBackupOwner({base:f.dir,readActive:async()=>selected,sourceKeys:f.fx.store.Hooks.keys,native:f.native});
 const token=await owner.prepare({expected:selected,candidate:f.candidate});await owner.prepareBindings(token);selected=choose(f.candidate,1);await owner.activate();
 const secondStamp='2026-10-25T00-00-00-000Z',backup=await newPublishedCapsule(f,token.root,cap.target,cap.snapshot,secondStamp,'Tool_One');const ref=owner.ref(secondStamp,'Tool_One',token.storeId);
 assert.equal(await owner.resolve(ref),backup);await owner.activate();assert.equal(await owner.resolve(ref),backup); // New business backup survives same-generation restart.
 const next={id:'b'.repeat(48)};next.root=path.join(f.dir,'.work-data','generations',next.id);const target=path.join(next.root,'skills','Tool_One');fs.mkdirSync(path.dirname(target),{recursive:true});await fsp.cp(cap.target,target,{recursive:true});
 const second=await owner.prepare({expected:selected,candidate:next});await owner.prepareBindings(second);selected=choose(next,2);await owner.activate();
 simulatedUndo(f);const item={id:'Tool_One'};
 const denied=await f.api.migrationUndoSkillCopy({file:path.join(f.dir,'unrelated','skills','Tool_One'),backup,backupRef:ref,items:[item]});assert.equal(denied.reason,'invalid-log');
 const result=await f.api.migrationUndoSkillCopy({file:cap.target,backup,backupRef:ref,items:[item]});assert.equal(result.outcome,'restored-previous');
 assert.equal(await owner.resolve(ref),backup);assert.equal((await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(backup))).intent.id,'Tool_One');
});

test('logical ref platform identity preserves case on POSIX and requires the canonical Windows shape',async()=>{
 const f=fixture({sourceTransform:source=>source.replaceAll("process.platform === 'win32'","false")}),owner=f.owner();
 const upper=owner.ref(f.stamp,'Tool_One','a'.repeat(48)),lower=owner.ref(f.stamp,'tool_one','a'.repeat(48));assert.equal(upper.skillId,'Tool_One');assert.equal(lower.skillId,'tool_one');assert.notEqual(upper.backupId,lower.backupId);
 const actual=fixture(),cap=await actual.capsule(),own=actual.owner(),token=await own.prepare({expected:actual.expected,candidate:actual.candidate});await own.prepareBindings(token);actual.commit();await own.activate();
 const ref=own.ref(actual.stamp,'one',token.storeId);if(process.platform==='win32')await assert.rejects(()=>own.resolve({...ref,skillId:'ONE'}),{code:'work_data_backup.backup_ref'});
 assert.equal(fs.existsSync(cap.target),true);
});
