'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after}=require('node:test');const {createRepresentationFixture}=require('../lib/migration-backup-representation-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-representation-unit-')),fixtures=[];
const fixture=()=>{const f=createRepresentationFixture(root);fixtures.push(f);return f;};
after(()=>{for(const f of fixtures)f.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
const identities=root=>{const out=[];const visit=relative=>{const file=path.join(root,relative),s=fs.statSync(file,{bigint:true});out.push([relative,s.ino.toString(),s.isDirectory()?null:fs.readFileSync(file).toString('base64')]);if(s.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(relative,name));};visit('');return out;};
async function encrypted(f,p){const token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});await f.owner.prepareRepresentation(token,{mode:'encrypted'});await f.shadow(p.live,f.candidate,p.skillId);assert.equal((await f.owner.prepareBindings(token)).ready,true);f.select(f.candidate);f.state.enabled=true;await f.owner.activate();return token;}
async function plaintext(f,p){const next={...f.newCandidate(),mode:'plain'},live=path.join(f.selected.root,'skills',p.skillId);await f.shadow(live,next,p.skillId,false);const token=await f.owner.prepare({expected:f.selected,candidate:next});await f.owner.prepareRepresentation(token,{mode:'plain'});assert.equal((await f.owner.prepareBindings(token)).ready,true);f.select(next,2,'plain');f.state.enabled=false;await f.owner.activate();return token;}
test('real codecs bind encrypted -> plain business undo to original IDs and publish typed terminal history without replay',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);const token=await plaintext(f,p),live=path.join(f.selected.root,'skills',p.skillId),oldBaseLive=identities(p.live);
 const ref=await f.owner.ref(f.stamp,p.skillId,token.storeId),receipt={file:p.live,kind:'skill-copy',backup:p.backup,backupRef:ref,items:[{id:p.skillId,copyTreeHash:p.record.copyTreeHash}]};
 assert.equal((await f.api.migrationUndoSkillCopy(receipt)).outcome,'restored-previous');assert.equal(f.nativeId(live),p.snapshot.entries[0].id);assert.equal(fs.readFileSync(path.join(live,'SKILL.md'),'utf8'),'ORIGINAL');assert.equal(JSON.parse(fs.readFileSync(path.join(live,'.ruyi-import.json'),'utf8')).workData,undefined);assert.deepEqual(identities(p.live),oldBaseLive);
 const backup=path.join(token.root,f.stamp,p.skillId),history=await f.readHistory(backup);assert.ok(history);assert.equal(history.historyOnly,true);assert.equal(history.phase,'complete');assert.equal(history.mode,'plain');assert.notEqual(f.nativeId(backup),p.snapshot.entries[0].id);
 const now=identities(live),events=f.state.events.length;await f.owner.activate();await f.api.migrationRecoverSkillBackups();assert.equal((await f.api.migrationUndoSkillCopy(receipt)).outcome,'restored-previous');assert.deepEqual(identities(live),now);assert.equal(f.state.events.slice(events).some(x=>x==='materialize-before'),false);
});
test('plain target bindings retain edit guards and authenticate the target mode before authority installation',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);const token=await plaintext(f,p);const live=path.join(f.selected.root,'skills',p.skillId),ref=await f.owner.ref(f.stamp,p.skillId,token.storeId);
 fs.writeFileSync(path.join(live,'SKILL.md'),'USER EDIT');const events=f.state.events.length,result=await f.api.migrationUndoSkillCopy({file:p.live,backupRef:ref,items:[{id:p.skillId,copyTreeHash:p.record.copyTreeHash}]});assert.equal(result.reason,'edited');assert.equal(f.state.events.slice(events).some(x=>x==='materialize-before'),false);
 const selected=f.selected;f.select(selected,selected.generation,'encrypted');await assert.rejects(()=>f.owner.activate(),error=>error.code==='work_data_backup.representation_mode');assert.equal(fs.readFileSync(path.join(live,'SKILL.md'),'utf8'),'USER EDIT');
});
test('a second plain -> sealed transition preserves authenticated prior eligibility instead of trusting an old absolute log',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);await plaintext(f,p);const live=path.join(f.selected.root,'skills',p.skillId),next={...f.newCandidate(),mode:'encrypted'};await f.shadow(live,next,p.skillId,true);const token=await f.owner.prepare({expected:f.selected,candidate:next});await f.owner.prepareRepresentation(token,{mode:'encrypted'});assert.equal((await f.owner.prepareBindings(token)).ready,true);f.select(next,3);f.state.enabled=true;await f.owner.activate();const ref=await f.owner.ref(f.stamp,p.skillId,token.storeId),backup=await f.owner.resolve(ref);const record=await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(backup));assert.equal(record.intent.conversion.eligibility,'eligible');assert.equal(record.snapshot.entries[0].id,p.snapshot.entries[0].id);assert.ok(ref);
});
test('conversion interruption at every simulated write/move boundary cancels to the same source IDs and bytes',async()=>{
 for(const cut of ['flush','materialize-before','materialize-written','materialize-after','seal-before','seal-after','move-before','move-after']){
  const f=fixture(),p=await f.plain(),before=identities(p.backup),live=identities(p.live),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});
  f.state.cut=cut;await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted'}),error=>error.operationMayHaveExecuted===true&&error.retry===false);
  assert.equal((await f.owner.recoverRepresentation()).phase,'canceled',cut);assert.deepEqual(identities(path.join(token.root,f.stamp,p.skillId)),before,cut);assert.deepEqual(identities(p.live),live,cut);await f.owner.recover();assert.deepEqual(identities(p.backup),before,cut);
 }
});
test('corrupt provenance rejects conversion before original DATA mutation and keeps the visible authority',async()=>{
 const f=fixture(),p=await f.plain();fs.writeFileSync(path.join(p.backup,'.ruyi-import.json'),JSON.stringify({schema:1,workData:3,keyId:'forged.k1'}));const before=identities(p.backup),live=identities(p.live),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});
 await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted'}));assert.deepEqual(identities(path.join(token.root,f.stamp,p.skillId)),before);assert.deepEqual(identities(p.live),live);assert.equal(f.state.events.some(x=>x==='materialize-before'||x==='seal-before'),false);
});
test('unknown ADS after interruption remains present and blocks restoration with an explicit uncertain result',async()=>{
 const f=fixture(),p=await f.plain(),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});f.state.cut='seal-after';await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted'}));
 const original=p.snapshot.entries.find(x=>x.rel==='SKILL.md');f.streams.set(original.id,new Map([[':UNKNOWN:$DATA',Buffer.from('PRESERVE')]]));await assert.rejects(()=>f.owner.recoverRepresentation(),error=>error.operationMayHaveExecuted===true&&error.resultUnavailable===true&&error.retry===false);assert.equal(f.streams.get(original.id).get(':UNKNOWN:$DATA').toString(),'PRESERVE');assert.equal(fs.readFileSync(path.join(p.live,'SKILL.md'),'utf8'),'REPLACEMENT');
});
test('plain originals changed after binding preparation block activation and preserve both authorities',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);const next={...f.newCandidate(),mode:'plain'},source=path.join(f.selected.root,'skills',p.skillId);await f.shadow(source,next,p.skillId,false);const token=await f.owner.prepare({expected:f.selected,candidate:next});await f.owner.prepareRepresentation(token,{mode:'plain'});await f.owner.prepareBindings(token);const backup=path.join(token.root,f.stamp,p.skillId);f.select(next,2,'plain');f.state.enabled=false;await f.owner.recoverRepresentation();fs.writeFileSync(path.join(backup,'SKILL.md'),'EXTERNAL CHANGE');
 await assert.rejects(()=>f.owner.activate(),error=>error.code==='work_data_backup.plain_backup_changed');assert.equal(fs.readFileSync(path.join(backup,'SKILL.md'),'utf8'),'EXTERNAL CHANGE');assert.equal(fs.readFileSync(path.join(source,'SKILL.md'),'utf8'),'REPLACEMENT');
});
test('new ordinary OFF backups under a plain authority retain whole-directory undo and do not acquire keys',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);const token=await plaintext(f,p),stamp='2026-10-26T00-00-00-000Z',live=path.join(f.selected.root,'skills',p.skillId),backup=path.join(token.root,stamp,p.skillId);fs.mkdirSync(path.dirname(backup),{recursive:true});await fsp.rename(live,backup);const original=identities(backup);fs.mkdirSync(live);fs.writeFileSync(path.join(live,'SKILL.md'),'NEW OFF COPY');const treeHash=await f.api.migrationTreeHash(await f.api.migrationSkillTree(live));await f.api.writeSkillImportRecord(live,{...p.record,copyTreeHash:treeHash},p.skillId);const count=f.state.acquires;
 const result=await f.api.migrationUndoSkillCopy({file:live,backupRef:f.owner.ref(stamp,p.skillId,token.storeId),items:[{id:p.skillId,copyTreeHash:treeHash}]});assert.equal(result.outcome,'restored-previous');assert.deepEqual(identities(live),original);assert.equal(f.state.acquires,count);
});
test('post-mutation frozen, null and primitive host errors are wrapped as controlled uncertain results in prepare and recovery',async()=>{
 for(const cause of [Object.freeze(Object.assign(Error('frozen-after-clear'),{code:'simulated.frozen',operationMayHaveExecuted:false,retry:true})),null,'primitive failure']){
  const f=fixture(),p=await f.plain(),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate}),seal=f.native.seal;
  f.native.seal=async args=>{await seal(args);throw cause;};await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted'}),error=>error.operationMayHaveExecuted===true&&error.resultUnavailable===true&&error.retry===false&&error.cause===cause);f.native.seal=seal;
  const materialize=f.native.materialize;f.native.materialize=async args=>{await materialize(args);throw cause;};await assert.rejects(()=>f.owner.recoverRepresentation(),error=>error.operationMayHaveExecuted===true&&error.resultUnavailable===true&&error.retry===false&&error.cause===cause);f.native.materialize=materialize;
  assert.equal((await f.owner.recoverRepresentation()).phase,'canceled');assert.equal(f.nativeId(path.join(token.root,f.stamp,p.skillId)),p.snapshot.entries[0].id);
 }
});
test('plain -> real sealed archive/intent -> cancellation restores the same original objects and exact bytes',async()=>{
 const f=fixture(),plain=await f.plain(),before=identities(plain.backup),liveBefore=identities(plain.live),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});
 const prepared=await f.owner.prepareRepresentation(token,{mode:'encrypted'});assert.equal(prepared.entries,1);
 const backup=path.join(token.root,f.stamp,plain.skillId),d={backup,id:plain.skillId,stamp:f.stamp,scopeId:'skill-backups:'+f.stamp,recordId:'skill-backup:'+(process.platform==='win32'?plain.skillId.toLowerCase():plain.skillId),archiveKeys:f.fx.store.Hooks.keys,intentKeys:f.fx.store.Hooks.keys},record=await f.api.migrationCapsuleRead(d);assert.equal(record.intent.conversion.eligibility,'eligible');assert.equal(record.snapshot.entries[0].id,plain.snapshot.entries[0].id);
 const provenance=record.snapshot.entries.find(row=>row.rel==='.ruyi-import.json').streams[0];assert.equal(JSON.parse(Buffer.from(provenance.data,'base64').toString().split('\n')[0]).workData,3);
 assert.ok(f.state.events.indexOf('flush')<f.state.events.indexOf('seal-before'));assert.deepEqual(identities(plain.live),liveBefore);
 const canceled=await f.owner.recoverRepresentation();assert.equal(canceled.phase,'canceled');assert.deepEqual(identities(backup),before);assert.deepEqual(identities(plain.live),liveBefore);
 await f.owner.recover();assert.deepEqual(identities(plain.backup),before);
});
test('unknown child after preparation causes a closed failure and is never deleted during cancellation',async()=>{
 const f=fixture(),plain=await f.plain(),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});f.state.cut='seal-after';await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted'}),error=>error.operationMayHaveExecuted===true);
 const control=path.join(f.dir,'.work-data','skill-backups','representations-v1'),operation=fs.readdirSync(control)[0],recordDir=path.join(control,operation,fs.readdirSync(path.join(control,operation))[0]);
 const unknown=path.join(recordDir,'capsule','objects','UNKNOWN');fs.writeFileSync(unknown,'KEEP UNKNOWN');await assert.rejects(()=>f.owner.recoverRepresentation());assert.equal(fs.readFileSync(unknown,'utf8'),'KEEP UNKNOWN');
 assert.equal(fs.existsSync(plain.live),true);
});
test('sealed -> plain reuses original objects, decodes provenance, and cancellation restores the same sealed wrapper and exact carriers',async()=>{
 const f=fixture(),plain=await f.plain(),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});await f.owner.prepareRepresentation(token,{mode:'encrypted'});
 await f.shadow(plain.live,f.candidate,plain.skillId);assert.equal((await f.owner.prepareBindings(token)).ready,true);f.select(f.candidate);f.state.enabled=true;await f.owner.activate();
 const backup=path.join(token.root,f.stamp,plain.skillId),wrapperId=f.nativeId(backup),archive=fs.readFileSync(path.join(backup,'archive')),intent=fs.readFileSync(path.join(backup,'intent'));
 const live=path.join(f.selected.root,'skills',plain.skillId),liveBefore=identities(live),next=f.newCandidate(),second=await f.owner.prepare({expected:f.selected,candidate:next});
 const converted=await f.owner.prepareRepresentation(second,{mode:'plain'});assert.equal(converted.entries,1);assert.equal(f.nativeId(backup),plain.snapshot.entries[0].id);
 const restored=fs.readFileSync(path.join(backup,'.ruyi-import.json'),'utf8');assert.equal(JSON.parse(restored).source,'codex');assert.equal(JSON.parse(restored).workData,undefined);assert.deepEqual(identities(live),liveBefore);
 const canceled=await f.owner.recoverRepresentation();assert.equal(canceled.phase,'canceled');assert.equal(f.nativeId(backup),wrapperId);assert.deepEqual(fs.readFileSync(path.join(backup,'archive')),archive);assert.deepEqual(fs.readFileSync(path.join(backup,'intent')),intent);
 await f.owner.activate();assert.deepEqual(identities(live),liveBefore);
});
test('terminal history converts both modes without re-instantiating historical IDs or touching the originals now live',async()=>{
 const f=fixture(),plain=await f.plain(),token=await f.owner.prepare({expected:f.selected,candidate:f.candidate});await f.owner.prepareRepresentation(token,{mode:'encrypted'});await f.shadow(plain.live,f.candidate,plain.skillId);await f.owner.prepareBindings(token);f.select(f.candidate);f.state.enabled=true;await f.owner.activate();
 const backup=path.join(token.root,f.stamp,plain.skillId),live=path.join(f.selected.root,'skills',plain.skillId);await f.terminal(backup,live);const liveBefore=identities(live),wrapperId=f.nativeId(backup),before=identities(backup);
 const next=f.newCandidate(),second=await f.owner.prepare({expected:f.selected,candidate:next}),start=f.state.events.length;await f.owner.prepareRepresentation(second,{mode:'plain'});
 const history=await f.readHistory(backup);assert.ok(history);assert.equal(history.historyOnly,true);assert.equal(history.phase,'complete');assert.equal(history.mode,'plain');assert.notEqual(f.nativeId(backup),history.snapshot.entries[0].id);assert.deepEqual(identities(live),liveBefore);
 assert.equal(f.state.events.slice(start).some(event=>event.startsWith('seal-')||event.startsWith('materialize-')),false);
 await f.owner.recoverRepresentation();assert.equal(f.nativeId(backup),wrapperId);assert.deepEqual(identities(backup),before);assert.deepEqual(identities(live),liveBefore);
 const third=await f.owner.prepare({expected:f.selected,candidate:next});await f.owner.prepareRepresentation(third,{mode:'plain'});f.select(next,2,'plain');assert.equal((await f.owner.recoverRepresentation()).phase,'kept');
 const plainHistory=identities(backup),last=f.newCandidate(),fourth=await f.owner.prepare({expected:f.selected,candidate:last});await f.owner.prepareRepresentation(fourth,{mode:'encrypted'});assert.equal((await f.readHistory(backup)).mode,'encrypted');assert.deepEqual(identities(live),liveBefore);
 await f.owner.recoverRepresentation();assert.deepEqual(identities(backup),plainHistory);assert.deepEqual(identities(live),liveBefore);
});
