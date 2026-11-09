'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after}=require('node:test');const {createRepresentationFixture}=require('../lib/migration-backup-representation-fixture');
const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
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
test('warm authority admission authenticates controls without a corpus census or business recovery',async()=>{
 const f=fixture(),p=await f.plain();await encrypted(f,p);
 const ownership={roots:[f.dir]},exclusive=owner=>owner===ownership;
 const warm=f.api.hooks.createBackupOwner({base:f.dir,readActive:async()=>f.selected,sourceKeys:f.fx.store.Hooks.keys,
  ownership,assertExclusive:exclusive,assertExclusiveSync:exclusive,native:{...f.native,capture:async()=>assert.fail('warm startup must not capture the corpus')}});
 const result=await warm.activate({recoverPending:false,allowAbsent:true,lazyArtifacts:true});
 assert.equal(result.generationId,f.selected.id);
 const unknown=path.join(f.dir,'.work-data','skill-backups','unknown-control');
 await fsp.writeFile(unknown,'preserve');
 await assert.rejects(()=>warm.activate({recoverPending:false,allowAbsent:true,lazyArtifacts:true}),{code:'work_data_backup.owner_busy'});
 assert.equal(await fsp.readFile(unknown,'utf8'),'preserve');
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
async function preparedReverse(f,p){
 const encryptedToken=await encrypted(f,p),expected=f.selected,next={...f.newCandidate(),mode:'plain'};
 const raw=JSON.stringify({schema:1,id:next.id,generation:2,mode:next.mode,activeRoot:'generations/'+next.id});
 next.pointerProof=Object.freeze({raw,sha256:hash(raw)});
 await f.shadow(path.join(expected.root,'skills',p.skillId),next,p.skillId,false);
 const token=await f.owner.prepare({expected,candidate:next});
 const state={expectedAuthority:{id:expected.id,sha256:expected.proof.sha256},candidate:{id:next.id,mode:'plain',pointerSha256:next.pointerProof.sha256}};
 return {next,token,state,backup:path.join(encryptedToken.root,f.stamp,p.skillId)};
}
test('bound owner receipt is flushed before DATA conversion and can restore the exact old authority',async()=>{
 const f=fixture(),p=await f.plain(),{token,state,backup}=await preparedReverse(f,p),before=identities(backup),start=f.state.events.length;
 await f.owner.prepareRepresentation(token,{mode:'plain',assertPrepared:async()=>true,onPrepared:async transition=>{
  assert.match(transition.preparedSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(identities(backup),before);
  assert.ok(f.state.events.slice(start).includes('flush'));
  assert.ok(!f.state.events.slice(start).includes('materialize-before'));
  state.transition=transition;return true;
 }});
 assert.equal(f.nativeId(backup),p.snapshot.entries[0].id);
 await assert.rejects(()=>f.owner.recoverPreparedTransition({state,disposition:'forward',assertUnchanged:async()=>true}),{code:'work_data_backup.generation_changed'});
 const proof=await f.owner.recoverPreparedTransition({state,disposition:'inverse',assertUnchanged:async()=>true});
 assert.equal(proof.operationId,state.transition.operationId);assert.equal(proof.disposition,'inverse');assert.deepEqual(identities(backup),before);
 const events=f.state.events.length;await f.owner.recoverPreparedTransition({state,disposition:'inverse',verifyOnly:true,assertUnchanged:async()=>true});
 assert.ok(!f.state.events.slice(events).includes('materialize-before'));
 const unknown=path.join(f.dir,'.work-data','skill-backups','UNRELATED');
 await fsp.writeFile(unknown,'preserve unknown native owner data');
 await assert.rejects(()=>f.owner.recoverPreparedTransition({state,disposition:'inverse',verifyOnly:true,assertUnchanged:async()=>true}),{code:'work_data_backup.representation_census'});
 assert.equal(await fsp.readFile(unknown,'utf8'),'preserve unknown native owner data');
});
test('exact prepared owner delta admits named transition changes and rejects extra data before commit',async()=>{
 const f=fixture(),p=await f.plain(),{next,token,state,backup}=await preparedReverse(f,p);
 await f.owner.prepareRepresentation(token,{mode:'plain',assertPrepared:async()=>true,onPrepared:async transition=>{state.transition=transition;return true;}});
 await f.owner.prepareBindings(token);
 const delta=await f.owner.preparedDelta(token);
 assert.ok(delta.some(row=>row.before?.path.endsWith('/archive')&&row.after===null));
 assert.ok(delta.some(row=>row.after?.path.endsWith('/SKILL.md')&&row.before===null));
 const extra=path.join(backup,'UNOWNED');await fsp.writeFile(extra,'preserve this');
 await assert.rejects(()=>f.owner.preparedDelta(token),{code:'work_data_backup.representation_census'});
 assert.equal(await fsp.readFile(extra,'utf8'),'preserve this');await fsp.unlink(extra);
 f.select(next,2,'plain');
 const proof=await f.owner.recoverPreparedTransition({state,disposition:'forward',assertUnchanged:async()=>true});
 assert.equal(proof.disposition,'forward');assert.equal((await f.owner.verifyPublished({expected:f.selected})).entries,1);
});
test('legacy nonempty owner binds relocation and conversion before the original directory moves',async()=>{
 for(const disposition of ['inverse','forward']){
  const f=fixture(),p=await f.plain(),before=identities(p.backup),candidate={...f.candidate,mode:'encrypted'};
  const raw=JSON.stringify({schema:1,id:candidate.id,generation:1,mode:'encrypted',activeRoot:'generations/'+candidate.id});
  candidate.pointerProof={raw,sha256:hash(raw)};
  await f.shadow(p.live,candidate,p.skillId);
  const token=await f.owner.prepare({expected:f.selected,candidate,requireEstablished:true,deferLegacyRelocation:true});
  const state={expectedAuthority:{id:null,sha256:null},candidate:{id:candidate.id,mode:candidate.mode,pointerSha256:candidate.pointerProof.sha256}};
  assert.deepEqual(identities(p.backup),before);
  await f.owner.prepareRepresentation(token,{mode:'encrypted',assertPrepared:async()=>true,onPrepared:async transition=>{
   assert.deepEqual(identities(p.backup),before);
   assert.equal(fs.existsSync(token.root),false);
   assert.equal(f.state.events.includes('move-before'),false);
   state.transition=transition;return true;
  }});
  assert.equal(fs.existsSync(p.backup),false);
  await f.owner.prepareBindings(token);
  const delta=await f.owner.preparedDelta(token);
  assert.ok(delta.some(row=>row.before?.path.startsWith('migrations/skill-backups/')&&row.after===null));
  if(disposition==='forward')f.select(candidate);
  const replay=await f.owner.recoverPreparedTransition({state,disposition,assertUnchanged:async()=>true});
  assert.equal(replay.disposition,disposition);
  if(disposition==='inverse')assert.deepEqual(identities(p.backup),before);
  else assert.equal((await f.owner.verifyPublished({expected:f.selected})).entries,1);
 }
});
test('legacy cold inverse distinguishes original location before move and after lost move acknowledgment',async()=>{
 for(const fault of ['before-move','move-after','materialize-before']){
  const f=fixture(),p=await f.plain(),before=identities(p.backup),candidate={...f.candidate,mode:'encrypted'};
  const raw=JSON.stringify({schema:1,id:candidate.id,generation:1,mode:'encrypted',activeRoot:'generations/'+candidate.id});
  candidate.pointerProof={raw,sha256:hash(raw)};
  const token=await f.owner.prepare({expected:f.selected,candidate,requireEstablished:true,deferLegacyRelocation:true});
  const state={expectedAuthority:{id:null,sha256:null},candidate:{id:candidate.id,mode:candidate.mode,pointerSha256:candidate.pointerProof.sha256}};
  await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted',assertPrepared:async()=>fault!=='before-move',onPrepared:async transition=>{
   state.transition=transition;
   if(fault==='before-move'){
    const id=f.nativeId(p.backup),metadata=f.metadata.get(id),[creation,,write,change]=metadata.times;
    f.metadata.set(id,{...metadata,times:[creation,'17',write,change]});
   }
   if(fault!=='before-move')f.state.cut=fault;
   return true;
  }}),error=>error.operationMayHaveExecuted===true&&error.retry===false);
  assert.equal(fs.existsSync(p.backup),fault==='before-move');
  assert.equal(fs.existsSync(token.root),fault!=='before-move');
  assert.equal((await f.owner.recoverPreparedTransition({state,disposition:'inverse',assertUnchanged:async()=>true})).disposition,'inverse');
  assert.deepEqual(identities(p.backup),before);
  assert.equal(fs.existsSync(token.root),false);
 }
});
test('legacy deferred relocation refuses an existing historical control namespace',async()=>{
 const f=fixture(),p=await f.plain(),before=identities(p.backup),candidate={...f.candidate,mode:'encrypted'};
 const control=path.join(f.dir,'.work-data','skill-backups'),sentinel=path.join(control,'old-control');
 await fsp.mkdir(control);await fsp.writeFile(sentinel,'existing owner state');
 await assert.rejects(()=>f.owner.prepare({expected:f.selected,candidate,requireEstablished:true,deferLegacyRelocation:true}),
  {code:'work_data_backup.representation_prepared'});
 assert.deepEqual(identities(p.backup),before);assert.equal(await fsp.readFile(sentinel,'utf8'),'existing owner state');
 assert.equal(f.state.events.includes('move-before'),false);
});
test('legacy relocation refuses a same-byte replaced prepared ledger before its first move',async()=>{
 const f=fixture(),p=await f.plain(),before=identities(p.backup),candidate={...f.candidate,mode:'encrypted'};
 const raw=JSON.stringify({schema:1,id:candidate.id,generation:1,mode:'encrypted',activeRoot:'generations/'+candidate.id});
 candidate.pointerProof={raw,sha256:hash(raw)};
 const token=await f.owner.prepare({expected:f.selected,candidate,requireEstablished:true,deferLegacyRelocation:true});
 const journal=path.join(f.dir,'.work-data','skill-backups','relocation-v1.sealed'),retained=path.join(f.dir,'replacement-evidence');
 await assert.rejects(()=>f.owner.prepareRepresentation(token,{mode:'encrypted',assertPrepared:async()=>true,onPrepared:async()=>{
  const bytes=await fsp.readFile(journal);await fsp.rename(journal,retained);await fsp.writeFile(journal,bytes,{flag:'wx'});
  return true;
 }}),{code:'work_data_backup.representation_prepared_changed'});
 assert.deepEqual(identities(p.backup),before);
 assert.equal(fs.existsSync(token.root),false);assert.equal(f.state.events.includes('move-before'),false);
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

async function warmGenerationAuthority(f) {
  const ownership={roots:[f.dir]}, exclusive=owner=>owner===ownership;
  const warm=f.api.hooks.createBackupOwner({base:f.dir,readActive:async()=>f.selected,
    sourceKeys:f.fx.store.Hooks.keys,ownership,assertExclusive:exclusive,assertExclusiveSync:exclusive,native:f.native});
  await warm.activate({recoverPending:false,allowAbsent:true,lazyArtifacts:true});
}

test('warm Undo uses the exact active-generation encrypted capsule even when the stable slot has the same stamp and skill',async()=>{
  const f=fixture(), p=await f.plain(), token=await encrypted(f,p);
  const live=path.join(f.selected.root,'skills',p.skillId);
  const backup=path.join(f.selected.root,'migrations','skill-backups',f.stamp,p.skillId);
  const stable=path.join(token.root,f.stamp,p.skillId), stableBefore=identities(stable), original=identities(live);
  const descriptor={backup,stamp:f.stamp,id:p.skillId,scopeId:'skill-backups:'+f.stamp,
    recordId:'skill-backup:'+(process.platform==='win32'?p.skillId.toLowerCase():p.skillId)};
  const revision='9'.repeat(64), snapshot=await f.native.capture(live,revision);
  fs.mkdirSync(path.join(backup,'objects'),{recursive:true});
  fs.writeFileSync(path.join(backup,'.ruyi-capsule-v1'),'{"version":1}');
  await f.api.migrationCapsuleArchive(descriptor).write(require('node:zlib').gzipSync(Buffer.from(JSON.stringify(snapshot))));
  await f.native.seal({root:live,container:path.join(backup,'objects'),snapshot});
  fs.mkdirSync(live); fs.writeFileSync(path.join(live,'SKILL.md'),'HISTORICAL REPLACEMENT');
  const copyTreeHash=await f.api.migrationTreeHash(await f.api.migrationSkillTree(live));
  await f.api.writeSkillImportRecord(live,{...p.record,copyTreeHash},p.skillId);
  const intent={schema:1,id:p.skillId,stamp:f.stamp,revision,phase:'published',oldRoot:snapshot.entries[0].id,
    newTree:f.api.migrationCapsuleFingerprint(await f.native.capture(live,revision)),sourceStage:'.ruyi-copy-'+p.skillId+'-'+f.stamp};
  await f.api.migrationCapsuleWriteIntent(descriptor,intent);
  const receipt={file:live,kind:'skill-copy',backup,items:[{id:p.skillId,action:'updated',copyTreeHash}]};
  const writeLog=require('node:vm').runInNewContext('writeMigrationLog',f.context);
  await writeLog({schema:1,id:f.stamp,files:[receipt]});
  await warmGenerationAuthority(f);
  f.state.cut='materialize-before';
  const interrupted=await f.api.migrationUndo({id:f.stamp});
  assert.equal(interrupted.operationMayHaveExecuted,true);
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase,'restoring');
  await warmGenerationAuthority(f);
  const result=await f.api.migrationUndo({id:f.stamp});
  assert.equal(result.skills[0].outcome,'restored-previous');
  assert.deepEqual(identities(live),original);
  assert.deepEqual(identities(stable),stableBefore);
  assert.equal((await f.api.migrationUndoSkillCopy(receipt,f.stamp)).outcome,'restored-previous');
});

test('warm historical plain Undo binds the active log, skill and exact canonical backup directory',async()=>{
  const f=fixture(), p=await f.plain(); await encrypted(f,p); await plaintext(f,p);
  f.context.__state.enabled=false;
  await warmGenerationAuthority(f);
  const live=path.join(f.selected.root,'skills',p.skillId);
  const backup=path.join(f.selected.root,'migrations','skill-backups',f.stamp,p.skillId);
  fs.mkdirSync(path.dirname(backup),{recursive:true}); await fsp.rename(live,backup);
  const original=identities(backup);
  fs.mkdirSync(live); fs.writeFileSync(path.join(live,'SKILL.md'),'NEW PLAIN COPY');
  const copyTreeHash=await f.api.migrationTreeHash(await f.api.migrationSkillTree(live));
  await f.api.writeSkillImportRecord(live,{...p.record,copyTreeHash},p.skillId);
  const receipt={file:live,kind:'skill-copy',backup,items:[{id:p.skillId,action:'updated',copyTreeHash}]};
  const before=identities(live);
  await assert.rejects(()=>f.api.migrationUndoSkillCopy(receipt,'2026-10-25T00-00-00-000Z'),{code:'work_data_backup.backup_ref'});
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({...receipt,backup:path.join(f.candidate.root,'migrations','skill-backups',f.stamp,p.skillId)},f.stamp),{code:'work_data_backup.backup_ref'});
  const batch=path.dirname(backup), detached=batch+'-detached';
  await fsp.rename(batch,detached);
  await fsp.symlink(detached,batch,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>f.api.migrationUndoSkillCopy(receipt,f.stamp),{code:'work_data_backup.owner_directory'});
  assert.deepEqual(identities(live),before);
  await fsp.unlink(batch); await fsp.rename(detached,batch);
  assert.equal((await f.api.migrationUndoSkillCopy(receipt,f.stamp)).outcome,'restored-previous');
  assert.deepEqual(identities(live),original);
});
