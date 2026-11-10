'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises');
const path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const Control=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13aj-work-data-control.js'),'utf8')+'\nWorkDataMaintenanceControl;',{require,Buffer,process});
const state=backup=>({schema:1,id:'a'.repeat(48),operation:'enable',phase:'prepared',createdAt:'2026-10-24T08:00:00.000Z',
 expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backup:{path:backup,sha256:'b'.repeat(64)},candidate:null});
async function fixture(t){
 const parent=path.resolve(os.tmpdir()),root=await fsp.mkdtemp(path.join(parent,'ruyi-control-unit-')),base=path.join(root,'source');await fsp.mkdir(base);
 t.after(async()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('ruyi-control-unit-'));await fsp.rm(root,{recursive:true,force:true});});
 const owner={roots:[base]},facts={exclusive:true,backup:true,flushes:[],failFlush:false};
 const host={base,ownership:owner,assertExclusive:async o=>o===owner&&facts.exclusive,
  assertDurableBackup:async()=>facts.backup,flush:async paths=>{facts.flushes.push([...paths]);if(facts.failFlush)throw Object.freeze(new Error('simulated flush refusal'));}};
 return{root,base,host,facts,owner,control:Control.create(host),s:state(path.join(root,'backup.pkg')),file:path.join(base,'.work-data','maintenance-v1.json')};
}
async function completeRecovery(t){
 const f=await fixture(t);let receipt=await f.control.write(f.s);
 const candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:'d'.repeat(64)};
 for(const phase of ['candidate','key-ready','published','complete'])receipt=await f.control.write({...f.s,phase,candidate},receipt);
 const recovery=Control.create(f.host),selected=await recovery.selectCompleteRecovery();return{...f,recovery,selected,issued:receipt};
}
test('C11 read selection is strict full-state/identity proof and never becomes an old issued receipt',async t=>{
 const f=await completeRecovery(t),bytes=await fsp.readFile(f.file),stat=await fsp.lstat(f.file,{bigint:true});
 assert.equal(f.selected.state.phase,'complete');assert.equal(Object.isFrozen(f.selected.state.candidate),true);assert.equal(f.selected.receipt.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 assert.equal(f.selected.receipt.bytes,bytes.length);assert.deepEqual({...f.selected.receipt.identity},{dev:String(stat.dev),ino:String(stat.ino)});
 await assert.rejects(f.recovery.finish(f.selected,async()=>true),{code:'work_data_setup.intent_receipt_invalid'});
 for(const token of [{...f.selected},new Proxy(f.selected,{})]){
  assert.equal(Control.acceptsRecoveryProfile(token,f.base,f.owner),false);
  await assert.rejects(f.recovery.recoverComplete(token,async()=>true,()=>true),{code:'work_data_setup.complete_recovery_receipt_invalid'});
 }
 assert.equal(Control.acceptsRecoveryProfile(f.selected,f.base,{...f.owner}),false);
 assert.equal(Control.acceptsRecoveryProfile(f.selected,path.join(f.base,'other'),f.owner),false);
 await assert.rejects(Control.create(f.host).recoverComplete(f.selected,async()=>true,()=>true),{code:'work_data_setup.complete_recovery_receipt_invalid'});
 await Control.verifyRecoveryProfile(f.selected,{base:f.base,ownership:f.owner,path:'.work-data/maintenance-v1.json',bytes});
 await assert.rejects(Control.verifyRecoveryProfile(f.selected,{base:f.base,ownership:f.owner,path:'.work-data/other.json',bytes}));
});
test('C11 read selection rejects all unqualified phases and exact identity replacement',async t=>{
 for(const phase of ['prepared','candidate','key-ready','published']){
  const f=await completeRecovery(t),state=JSON.parse(await fsp.readFile(f.file,'utf8'));state.phase=phase;await fsp.writeFile(f.file,JSON.stringify(state));
  await assert.rejects(f.recovery.selectCompleteRecovery(),{code:'work_data_setup.complete_recovery_ineligible'});
 }
 const f=await completeRecovery(t),bytes=await fsp.readFile(f.file);await fsp.rename(f.file,f.file+'.old');await fsp.writeFile(f.file,bytes);
 await assert.rejects(Control.verifyRecoveryProfile(f.selected,{base:f.base,ownership:f.owner,path:'.work-data/maintenance-v1.json',bytes}),{code:'work_data_setup.intent_changed'});
 await assert.rejects(f.recovery.recoverComplete(f.selected,async()=>true,()=>true),{code:'work_data_setup.intent_changed'});assert.deepEqual(await fsp.readFile(f.file),bytes);
});
test('C11 trusted callbacks are required twice, final guard is synchronous and retired proof loses read authority',async t=>{
 const f=await completeRecovery(t),bytes=await fsp.readFile(f.file);let callbacks=0;
 await assert.rejects(f.recovery.recoverComplete(f.selected,async()=>false,()=>true),{code:'work_data_setup.completion_unverified'});
 await assert.rejects(f.recovery.recoverComplete(f.selected,async()=>true,async()=>true),{code:'work_data_setup.completion_unverified'});
 assert.deepEqual(await fsp.readFile(f.file),bytes);
 await f.recovery.recoverComplete(f.selected,async()=>{callbacks++;assert.deepEqual(await fsp.readFile(f.file),bytes);await assert.rejects(f.recovery.write(f.s),{code:'work_data_setup.intent_busy'});return true;},()=>true);
 assert.equal(callbacks,2);assert.equal(fs.existsSync(f.file),false);assert.equal(Control.acceptsRecoveryProfile(f.selected,f.base,f.owner),false);
 await assert.rejects(f.recovery.recoverComplete(f.selected,async()=>true,()=>true),{code:'work_data_setup.complete_recovery_receipt_invalid'});
});
test('inspection is read only and absent intent never creates a control namespace',async t=>{
 const f=await fixture(t);assert.equal((await f.control.inspect()).pending,false);assert.deepEqual(await fsp.readdir(f.base),[]);
});
test('only actual exclusive owner and verified durable backup authorize the first intent',async t=>{
 const f=await fixture(t);f.facts.backup=false;await assert.rejects(f.control.write(f.s));assert.deepEqual(await fsp.readdir(f.base),[]);
 f.facts.backup=true;f.facts.exclusive=false;await assert.rejects(f.control.write(f.s));assert.deepEqual(await fsp.readdir(f.base),[]);
});
test('stage and selected entry are flushed then exact SHA/native identity is issued; startup still refuses ordinary work',async t=>{
 const f=await fixture(t),receipt=await f.control.write(f.s);
 assert.equal(receipt.name,'.work-data/maintenance-v1.json');assert.equal(f.facts.flushes.length,2);
 const bytes=await fsp.readFile(f.file),stat=await fsp.stat(f.file,{bigint:true});
 assert.equal(receipt.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(receipt.identity.ino,String(stat.ino));
 assert.equal((await f.control.inspect()).pending,true);assert.equal(await f.control.verify(receipt),receipt);
 assert.equal(Object.isFrozen(receipt),true);assert.equal(Object.isFrozen(receipt.identity),true);
});
test('forged/cloned receipts and on-disk edits cannot update or remove an intent',async t=>{
 const f=await fixture(t),r=await f.control.write(f.s);
 await assert.rejects(f.control.verify({...r}));await fsp.writeFile(f.file,JSON.stringify({...f.s,id:'c'.repeat(48)}));
 await assert.rejects(f.control.verify(r));await assert.rejects(f.control.finish(r,async()=>true));assert.equal(fs.existsSync(f.file),true);
});
test('a valid update binds the original job/source/backup and rejects phase rollback',async t=>{
 const f=await fixture(t),r=await f.control.write(f.s),next={...f.s,phase:'candidate',candidate:{id:'c'.repeat(48),mode:'encrypted',headerSha256:null}};
 const r2=await f.control.write(next,r);assert.equal(r2.phase,'candidate');await assert.rejects(f.control.verify(r));
 await assert.rejects(f.control.write({...next,backup:{...next.backup,path:path.join(f.root,'other.pkg')}},r2));
 await assert.rejects(f.control.write({...next,phase:'prepared'},r2));
 assert.equal(await f.control.verify(r2),r2);
});
test('a candidate pointer digest is durable and cannot change or disappear in later phases',async t=>{
 const f=await fixture(t),initial=await f.control.write(f.s);
 const candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:null,pointerSha256:'d'.repeat(64)};
 const next={...f.s,phase:'candidate',candidate};
 await assert.rejects(f.control.write({...next,candidate:{...candidate,pointerSha256:[candidate.pointerSha256]}},initial),{code:'work_data_setup.intent_invalid'});
 const admitted=await f.control.write(next,initial);
 const ready={...next,phase:'key-ready',candidate:{...candidate,headerSha256:'e'.repeat(64)}};
 const {pointerSha256,...legacy}=ready.candidate;
 for(const changed of [legacy,{...ready.candidate,pointerSha256:'f'.repeat(64)}]){
  await assert.rejects(f.control.write({...ready,candidate:changed},admitted),error=>
   error.code==='work_data_setup.intent_write_failed'&&error.cause?.code==='work_data_setup.intent_binding_changed');
  assert.equal(await f.control.verify(admitted),admitted);
 }
 await f.control.write(ready,admitted);
 assert.deepEqual(JSON.parse(await fsp.readFile(f.file,'utf8')).candidate,ready.candidate);
});
test('the transition proof can be bound once while key-ready and has a separate exact recovery token',async t=>{
 const f=await fixture(t),candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:'d'.repeat(64),pointerSha256:'e'.repeat(64)};
 const transition={schema:1,operationId:'f'.repeat(48),preparedSha256:'1'.repeat(64)};
 const transitionReady={schema:1,targetSha256:'2'.repeat(64),targetNativeSha256:'3'.repeat(64)};
 const transitionSourceScope={schema:1,nativePath:'migrations/skill-backups',createdParents:['.work-data','.work-data/generations']};
 const ready={...f.s,phase:'key-ready',candidate},withProof={...ready,transition,transitionSourceScope,transitionSourceSha256:'5'.repeat(64)};
 let receipt=await f.control.write(f.s);
 await assert.rejects(f.control.write({...withProof,phase:'candidate'},receipt),{code:'work_data_setup.intent_invalid'});
 receipt=await f.control.write({...ready,phase:'candidate'},receipt);
 await assert.rejects(f.control.write(withProof,receipt),error=>error.cause?.code==='work_data_setup.intent_phase_invalid');
 receipt=await f.control.write(ready,receipt);
 await assert.rejects(f.control.write({...withProof,transition:{...transition,operationId:[transition.operationId]}},receipt),
  {code:'work_data_setup.intent_invalid'});
 await assert.rejects(f.control.write({...withProof,transitionSourceScope:{...transitionSourceScope,createdParents:['.work-data']}},receipt),
  {code:'work_data_setup.intent_invalid'});
 await assert.rejects(f.control.write({...withProof,phase:'published'},receipt),error=>error.cause?.code==='work_data_setup.intent_phase_invalid');
 await assert.rejects(f.control.write({...withProof,transitionReady},receipt),error=>error.cause?.code==='work_data_setup.intent_phase_invalid');
 receipt=await f.control.write(withProof,receipt);
 for(const changed of [ready,{...withProof,transition:{...transition,preparedSha256:'2'.repeat(64)}},
  {...withProof,transitionSourceSha256:'6'.repeat(64)},{...withProof,transitionSourceScope:undefined}])
  await assert.rejects(f.control.write(changed,receipt),error=>error.cause?.code==='work_data_setup.intent_binding_changed');
 await assert.rejects(f.control.write({...withProof,phase:'published',transitionReady},receipt),error=>error.cause?.code==='work_data_setup.intent_phase_invalid');
 receipt=await f.control.write({...withProof,transitionReady},receipt);
 for(const changed of [withProof,{...withProof,transitionReady:{...transitionReady,targetNativeSha256:'4'.repeat(64)}}])
  await assert.rejects(f.control.write(changed,receipt),error=>error.cause?.code==='work_data_setup.intent_binding_changed');
 const cold=Control.create(f.host),selected=await cold.selectTransitionRecovery();
 assert.deepEqual({...selected.state.transition},transition);
 assert.deepEqual({...selected.state.transitionReady},transitionReady);
 assert.equal(selected.state.transitionSourceSha256,withProof.transitionSourceSha256);
 assert.equal(selected.state.transitionSourceScope.nativePath,transitionSourceScope.nativePath);
 assert.deepEqual([...selected.state.transitionSourceScope.createdParents],transitionSourceScope.createdParents);
 assert.ok(Object.isFrozen(selected.state.transition));
 assert.equal(Control.acceptsRecoveryProfile(selected,f.base,f.owner),false);
 await assert.rejects(cold.recoverComplete(selected,async()=>true,()=>true),{code:'work_data_setup.complete_recovery_receipt_invalid'});
 await assert.rejects(Control.create(f.host).recoverTransition(selected,async()=>true),{code:'work_data_setup.transition_recovery_receipt_invalid'});
 await assert.rejects(cold.recoverTransition({...selected},async()=>true),{code:'work_data_setup.transition_recovery_receipt_invalid'});
 const raw=await fsp.readFile(f.file);let deferredCheck;
 assert.equal(await cold.recoverTransition(selected,async (state,check)=>{
  assert.equal(state,selected.state);assert.equal(await check(),true);deferredCheck=check;
  await assert.rejects(cold.write(f.s),{code:'work_data_setup.intent_busy'});
  return 'replayed';
 }),'replayed');
 assert.throws(deferredCheck,{code:'work_data_setup.transition_recovery_receipt_invalid'});
 await assert.rejects(cold.recoverTransition(selected,async()=>true),{code:'work_data_setup.transition_recovery_receipt_invalid'});
 assert.deepEqual(await fsp.readFile(f.file),raw);
});
test('inverse retirement persists an exact plan before deletion and can resume after interruption',async t=>{
 const f=await fixture(t),candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:'d'.repeat(64),pointerSha256:'e'.repeat(64)};
 const ready={...f.s,phase:'key-ready',candidate};
 const transition={schema:1,operationId:'f'.repeat(48),preparedSha256:'1'.repeat(64)};
 const transitionReady={schema:1,targetSha256:'2'.repeat(64),targetNativeSha256:'3'.repeat(64)};
 const plan={schema:1,retainedSha256:'4'.repeat(64),claim:{parentPid:12,childPid:13,dev:'1',ino:'2',sha256:'5'.repeat(64)},
  rows:[{path:'.work-data/generations/'+candidate.id,dir:true,id:'6'.repeat(24),sha256:'7'.repeat(64)}]};
 let receipt=await f.control.write(f.s);
 for(const next of [{...ready,phase:'candidate'},ready,{...ready,transition,transitionSourceSha256:'8'.repeat(64)},
  {...ready,transition,transitionSourceSha256:'8'.repeat(64),transitionReady}])receipt=await f.control.write(next,receipt);
 const cold=Control.create(f.host),first=await cold.selectTransitionRecovery();
 await assert.rejects(cold.write({...first.state,phase:'retiring',retirement:plan}),{code:'work_data_setup.intent_invalid'});
 await assert.rejects(cold.recoverInverse(first,async({persist})=>{
  await persist(plan,async stage=>{assert.match(stage,/^\.maintenance-v1\.stage-/);return true;});
  throw Error('interrupted after durable retirement plan');
 }),/interrupted after durable retirement plan/);
 const resumed=Control.create(f.host),selected=await resumed.selectTransitionRecovery();
 assert.equal(selected.state.phase,'retiring');
 assert.deepEqual(JSON.parse(JSON.stringify(selected.state.retirement)),plan);
 await assert.rejects(resumed.recoverTransition(selected,async()=>true),{code:'work_data_setup.transition_recovery_receipt_invalid'});
 await resumed.recoverInverse(selected,async({check,finish})=>{
  assert.equal(await check(),true);
  await assert.rejects(finish(async()=>false),{code:'work_data_setup.transition_recovery_receipt_invalid'});
  await finish(async()=>true);
 });
 assert.equal((await resumed.inspect()).pending,false);
});
test('the source digest excludes only exact owned control namespaces and binds ordinary identity, stamps and data',()=>{
 const candidateId='a'.repeat(48),selected={candidateId},file=(path,identity='1:2')=>({path,identity,sha256:'e'.repeat(64),mtimeNs:'3',ctimeNs:'4'});
 const original={sourceFiles:[file('config.json'),file('.work-data/skill-backups/item')],sourceDirectories:[{path:'',identity:'1:1'}]};
 const digest=Control.sourceOrdinaryDigest(original,selected);
 const shadow=file('.work-data/generations/'+candidateId+'/config.json');
 assert.equal(Control.sourceOrdinaryDigest({...original,sourceFiles:[...original.sourceFiles,shadow,file('.work-data/maintenance-v1.json')]},selected),digest);
 for(const extra of ['.work-data/skill-backups-old/item','.work-data/generations/'+'b'.repeat(48)+'/config.json','.work-data/maintenance-v1.json.prev'])
  assert.notEqual(Control.sourceOrdinaryDigest({...original,sourceFiles:[...original.sourceFiles,file(extra)]},selected),digest);
 for(const changed of [{identity:'1:9'},{ctimeNs:'5'},{sha256:'f'.repeat(64)}])
  assert.notEqual(Control.sourceOrdinaryDigest({...original,sourceFiles:[{...original.sourceFiles[0],...changed}]},selected),digest);
 assert.throws(()=>Control.sourceOrdinaryDigest({...original,sourceFiles:[file('nested/../config.json')]},selected),{code:'work_data_setup.transition_source_invalid'});
});
test('legacy source roles preserve pre-existing control parents and normalize only the bound relocation',()=>{
 const candidateId='a'.repeat(48),legacy='migrations/skill-backups',stable='.work-data/skill-backups';
 const file=(path,identity)=>({path,identity,sha256:'e'.repeat(64),mtimeNs:'3',ctimeNs:'4'}),dir=(path,identity)=>({path,identity});
 const coverage={type:'skill-backup-portable',originalObjects:'new-owned-portable',sourcePath:legacy};
 const parents=[dir('.work-data','1:4'),dir('.work-data/generations','1:5')];
 const sourceFiles=[file('config.json','1:3'),file(legacy+'/old.txt','1:8')];
 const sourceDirectories=[dir('','1:1'),dir('migrations','1:2'),dir(legacy,'1:7')];
 for(const count of [0,1,2]){
  const before={sourceFiles,sourceDirectories:[...sourceDirectories,...parents.slice(0,count)],specialCoverage:coverage};
  const scope=Control.legacyTransitionSourceScope(before),options={candidateId,scope};
  assert.deepEqual([...scope.createdParents],parents.slice(count).map(row=>row.path));
  const relocated={sourceFiles:[sourceFiles[0],file(stable+'/old.txt','1:8'),file('.work-data/maintenance-v1.json','1:6')],
   sourceDirectories:[...sourceDirectories.slice(0,2),...parents,dir(stable,'1:7'),dir('.work-data/generations/'+candidateId,'1:9')]};
  const digest=Control.sourceOrdinaryDigest(before,options);
  assert.equal(Control.sourceOrdinaryDigest(relocated,options),digest);
  assert.notEqual(Control.sourceOrdinaryDigest(relocated,{candidateId}),digest);
  assert.notEqual(Control.sourceOrdinaryDigest({...relocated,sourceFiles:[...relocated.sourceFiles,file('migrations/skill-backups-extra/file','1:10')]},options),digest);
  assert.notEqual(Control.sourceOrdinaryDigest({...relocated,sourceFiles:[...relocated.sourceFiles,file(legacy,'1:10')]},options),digest);
  if(count)assert.notEqual(Control.sourceOrdinaryDigest({...relocated,
   sourceDirectories:relocated.sourceDirectories.map(row=>row.path===parents[0].path?{...row,identity:'1:10'}:row)},options),digest);
 }
 assert.throws(()=>Control.legacyTransitionSourceScope({sourceFiles,sourceDirectories:[...sourceDirectories,parents[1]],specialCoverage:coverage}),
  {code:'work_data_setup.transition_source_invalid'});
});
test('transition recovery refuses an intent replaced with the same bytes while replay runs',async t=>{
 const f=await fixture(t),candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:'d'.repeat(64),pointerSha256:'e'.repeat(64)};
 let receipt=await f.control.write(f.s);
 for(const phase of ['candidate','key-ready'])receipt=await f.control.write({...f.s,phase,candidate},receipt);
 await f.control.write({...f.s,phase:'key-ready',candidate,transition:{schema:1,operationId:'f'.repeat(48),preparedSha256:'1'.repeat(64)}},receipt);
 const cold=Control.create(f.host),selected=await cold.selectTransitionRecovery(),bytes=await fsp.readFile(f.file);
 await assert.rejects(cold.recoverTransition(selected,async()=>{
  await fsp.rename(f.file,f.file+'.original');await fsp.writeFile(f.file,bytes);return true;
 }),{code:'work_data_setup.intent_changed'});
 assert.deepEqual(await fsp.readFile(f.file),bytes);
});
test('an existing intent is never overwritten without this exact owner-issued receipt',async t=>{
 const f=await fixture(t);const r=await f.control.write(f.s),other=Control.create(f.host);
 await assert.rejects(other.write(f.s));await assert.rejects(other.write(f.s,r));assert.equal(await f.control.verify(r),r);
});
test('failure before rename retains its stage and next inspection explicitly reports pending-stage',async t=>{
 const f=await fixture(t);f.facts.failFlush=true;await assert.rejects(f.control.write(f.s),e=>e.retry===false&&e.operationMayHaveExecuted===true);
 const names=await fsp.readdir(path.dirname(f.file));assert.equal(names.length,1);assert.ok(names[0].startsWith('.maintenance-v1.stage-'));
 assert.equal(fs.existsSync(f.file),false);await assert.rejects(f.control.inspect(),e=>e.code==='work_data_setup.intent_stage_pending');
});
test('failure after rename retains selected intent; no receipt can be forged to authorize continuation',async t=>{
 const f=await fixture(t);f.host.flush=async()=>{if(f.facts.flushes.length++)throw Error('postrename failure');};const c=Control.create(f.host);
 await assert.rejects(c.write(f.s));assert.equal(fs.existsSync(f.file),true);assert.equal((await c.inspect()).pending,true);
 await assert.rejects(c.verify({name:'.work-data/maintenance-v1.json'}));
});
test('a same-byte staged replacement cannot acquire intent publication authority',async t=>{
 const f=await fixture(t),root=path.dirname(f.file);
 let intercepted=false;
 f.host.flush=async()=>{
  if(intercepted)return;
  const name=(await fsp.readdir(root)).find(value=>value.startsWith('.maintenance-v1.stage-'));
  const stage=path.join(root,name),bytes=await fsp.readFile(stage);
  await fsp.rename(stage,path.join(root,'displaced-original'));await fsp.writeFile(stage,bytes);
  intercepted=true;
 };
 const c=Control.create(f.host);
 await assert.rejects(c.write(f.s),error=>error.code==='work_data_setup.intent_write_failed'&&error.cause?.code==='work_data_setup.intent_changed');
 assert.equal(intercepted,true);assert.equal(fs.existsSync(f.file),false);
 assert.ok((await fsp.readdir(root)).some(name=>name.startsWith('.maintenance-v1.stage-')));
});
test('completion must verify published state freshly and excludes concurrent intent writes',async t=>{
 const f=await fixture(t);let r=await f.control.write(f.s);
 const candidate={id:'c'.repeat(48),mode:'encrypted',headerSha256:'d'.repeat(64)};
 for(const phase of ['candidate','key-ready','published','complete'])r=await f.control.write({...f.s,phase,candidate},r);
 await assert.rejects(f.control.finish(r,async()=>false));assert.equal(fs.existsSync(f.file),true);
 let resolve;const held=new Promise(r=>resolve=r);const finishing=f.control.finish(r,async()=>{await held;return true;});
 await assert.rejects(f.control.write({...f.s,phase:'complete'},r),e=>e.code==='work_data_setup.intent_busy');resolve();await finishing;
 assert.equal(fs.existsSync(f.file),false);assert.equal((await f.control.inspect()).pending,false);await assert.rejects(f.control.verify(r));
});
test('malformed/truncated/oversized intent or aliased control namespace fail without repairing any source',async t=>{
 const f=await fixture(t);await fsp.mkdir(path.dirname(f.file));
 for(const bytes of [Buffer.from('{"schema":'),Buffer.alloc(32769,65),Buffer.from([255])]){
  await fsp.writeFile(f.file,bytes);await assert.rejects(f.control.inspect());assert.deepEqual(await fsp.readFile(f.file),bytes);
 }
});
test('hardlinked intent cannot gain a receipt or be inspected as valid authority',async t=>{
 const f=await fixture(t);await fsp.mkdir(path.dirname(f.file));await fsp.writeFile(f.file,JSON.stringify(f.s));
 await fsp.link(f.file,path.join(f.root,'alias.json'));await assert.rejects(f.control.inspect());assert.equal((await fsp.stat(f.file)).nlink,2);
});
test('an orphan stage also blocks updates made with a formerly valid selected receipt',async t=>{
 const f=await fixture(t),r=await f.control.write(f.s);const before=await fsp.readFile(f.file);
 await fsp.writeFile(path.join(path.dirname(f.file),'.maintenance-v1.stage-'+'d'.repeat(48)),'unknown retained stage');
 await assert.rejects(f.control.write({...f.s,phase:'candidate',candidate:{id:'c'.repeat(48),mode:'plain',headerSha256:null}},r));
 assert.deepEqual(await fsp.readFile(f.file),before);
});
test('caller mutation during flush cannot change the selected intent receipt or authorize premature completion',async t=>{
 const f=await fixture(t),original=structuredClone(f.s);
 f.host.flush=async()=>{f.s.phase='complete';f.s.id='f'.repeat(48);f.s.expectedAuthority.generation=8;};
 const c=Control.create(f.host),r=await c.write(f.s);
 assert.equal(r.phase,'prepared');assert.equal(r.id,original.id);assert.deepEqual(JSON.parse(await fsp.readFile(f.file,'utf8')),original);
 await assert.rejects(c.finish(r,async()=>true));assert.equal(fs.existsSync(f.file),true);
});
