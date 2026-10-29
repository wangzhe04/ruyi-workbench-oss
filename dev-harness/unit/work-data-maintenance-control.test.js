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
