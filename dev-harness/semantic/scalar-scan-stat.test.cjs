'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./scalar-scan-stat-fixture.cjs'),{createTiming}=require('./scalar-producer-phase-timing.cjs');
const fp={modelFingerprint:'synthetic',templateFingerprint:'synthetic',runtimeFingerprint:'synthetic',policyFingerprint:'synthetic'};
async function setup(t,options={}){
  const timing=createTiming();let after=null,writes=0,consumerIndex=null;
  const f=await fixture({enabled:!options.mixed&&!options.plain,privacy:'enhanced',researchDirectory:path.resolve('output/semantic-scan-stat-tests'),
    runtime:{prepare:async()=>({available:true,modelFingerprint:'synthetic'}),encode:async(texts,opts)=>{await opts.beforeEncode?.();return {ok:true,modelFingerprint:'synthetic',vectors:texts.map(()=>[1,0])};}},
    scalarHost:{prepare:async()=>({ok:true,...fp}),verify:async(_q,_s,opts)=>{await opts.beforeVerify();writes++;return options.unknown?{ok:false,reason:'unavailable'}:{ok:true,...fp,score:.99,accepted:true};},stop:async()=>({cleanupStatus:'observed',workerExited:true})}});
  t.after(()=>f.close());
  const bind=f.hooks.bindSessions;f.hooks.bindSessions=(...args)=>{consumerIndex=bind(...args);return consumerIndex;};
  f.context.ResearchProducerTiming={...timing,measure:async(name,work)=>{const value=await timing.measure(name,work);if(name==='phase.coverage.preVerifier'&&after){const action=after;after=null;await action();}return value;}};
  for(const sid of ['A','B','C']){const row={role:'user',id:'m1',content:sid==='A'?'orchid factual archive':'unrelated material '+sid,...(sid==='C'?options.extra:{})};await f.put(sid,[row],{head:{title:'',summary:'',cwd:''}});
    if(options.mixed){const line=f.fx.WorkDataRecords.encodeLine(JSON.stringify(row),f.master,{instanceId:f.instanceId,sessionId:sid,kind:'messages',ordinal:0});await fs.writeFile(path.join(f.sessions,sid+'.messages.ndjson'),line+'\n');}}
  if(!options.sourceOnly){await f.index.prepare(null);await f.ui('orchid missing');}timing.reset();writes=0;
  return {f,timing,consumerIndex:()=>consumerIndex,setAfter:fn=>after=fn,writes:()=>writes,search:async()=>{timing.reset();return f.ui('orchid missing');}};
}
const count=(x,label)=>x.timing.snapshot().counters.filter(row=>row.key[1]===label).reduce((sum,row)=>sum+row.calls,0);
test('warm fresh owner/key validated statistics skip coverage scans across requests',async t=>{
  const x=await setup(t),found=await x.search();assert.equal(found.coverage.complete,true);assert.ok(count(x,'scanStats.hit')>=3);
  const pre=x.timing.snapshot().events.find(e=>e.name==='phase.coverage.preVerifier');assert.ok(pre);assert.equal(x.timing.snapshot().events.filter(e=>e.name==='host.scan'&&e.parent===pre.id).length,0);
});
test('external body mutation and deletion without sequence changes reject stale statistics',async t=>{
  for(const action of ['rewrite','delete']){const x=await setup(t),file=path.join(x.f.sessions,'C.messages.ndjson'),seq=x.f.api.source.sequence('C');
    if(action==='delete')await fs.unlink(file);else{const data=await fs.readFile(file);data[10]^=1;await fs.writeFile(file,data);}
    assert.equal(x.f.api.source.sequence('C'),seq);await assert.rejects(x.search());}
});
test('body and head hardlink aliases are rejected by the owner even after cache warm',async t=>{
  for(const name of ['C.messages.ndjson','C.json']){const x=await setup(t),file=path.join(x.f.sessions,name),alias=path.join(x.f.directory,'owned-alias-'+name);await fs.link(file,alias);await assert.rejects(x.search(),e=>e.code==='session_fulltext_source.owner_alias');}
});
test('mixed OFF plaintext head and encrypted body retains original policy refusal and decode-key requirement',async t=>{
  const x=await setup(t,{mixed:true,sourceOnly:true});await assert.rejects(x.f.index.prepare(null),e=>e.code==='session_fulltext.source_policy_conflict');
  const proof=await x.f.api.source.scan('C',()=>{}),token=x.f.scanWitness.read(proof);assert.ok(token);assert.equal(proof.requiresEncryption,true);
  const error=Object.assign(new Error('key revoked'),{code:'EACCES'});x.f.keys.unlock=async()=>{throw error;};await assert.rejects(x.search(),e=>e===error);assert.equal(x.writes(),0);
});
test('actual body decode witness rejects key ABA, not a postscan key fingerprint',async t=>{
  const x=await setup(t,{mixed:true,sourceOnly:true}),wrong=crypto.randomBytes(32);
  x.f.keys.unlock=async()=>wrong;const before=await x.f.fx.store.acquireSnapshot(x.f.keys),beforeHash=crypto.createHash('sha256').update(before.key).digest('hex');await before.release();
  x.f.keys.unlock=async()=>x.f.master;const proof=await x.f.api.source.scan('C',()=>{}),token=x.f.scanWitness.read(proof);
  x.f.keys.unlock=async()=>wrong;const after=await x.f.fx.store.acquireSnapshot(x.f.keys);assert.equal(crypto.createHash('sha256').update(after.key).digest('hex'),beforeHash);await after.release();
  assert.ok(token);assert.equal(await x.f.scanWitness.validate(token),false,'actual middle B decode cannot be mislabeled with equal outside A leases');x.f.keys.unlock=async()=>x.f.master;assert.equal(await x.f.scanWitness.validate(token),true);wrong.fill(0);
});
test('source lease cleanup failure retains original error and never publishes a proof',async t=>{
  const x=await setup(t,{mixed:true,sourceOnly:true}),error=Object.assign(new Error('lease release denied'),{code:'EACCES'});let published=0;
  x.f.sourceWitnessContext.ResearchScanWitness={...x.f.scanWitness,publish:()=>published++};
  x.f.keys.snapshot=async()=>({key:x.f.master,instanceId:x.f.instanceId,release:async()=>{throw error;}});
  await assert.rejects(x.f.api.source.scan('C',()=>{}),e=>e===error);assert.equal(published,0);
});
test('current key change after precoverage is rejected at final public emission',async t=>{
  const x=await setup(t),error=Object.assign(new Error('late key revoked'),{code:'EACCES'});
  x.setAfter(()=>{x.f.keys.unlock=async()=>{throw error;};});await assert.rejects(x.search(),e=>e===error);
});
test('privacy/config revocation and falsy destination cancellation still fail closed',async t=>{
  const x=await setup(t);x.setAfter(()=>x.f.changeConfig({privacyModeV1:'strict'}));await assert.rejects(x.search());
  const y=await setup(t);y.setAfter(()=>y.f.controller.abort(0));await assert.rejects(y.f.model('orchid missing'),e=>e.code==='session_search.destination_changed');assert.equal(y.f.controller.signal.reason,0);
});
test('unknown text and attachments retain their actual unverified counts and partial coverage',async t=>{
  for(const extra of [{blocks:[{unsupported:true}]},{attachments:[{textPreview:'unverified attachment'}]}]){const x=await setup(t,{extra}),found=await x.search();assert.equal(found.coverage.complete,false);assert.equal(found.semantic.coverage,'partial');}
});
test('unknown scalar admission remains withheld even when statistical source coverage is cached',async t=>{
  const x=await setup(t,{unknown:true}),found=await x.search();assert.equal(found.results.length,0);assert.equal(found.semantic.coverage,'partial');
});
test('source revision changed after precoverage cannot reuse an old successful or negative proof',async t=>{
  const x=await setup(t);x.setAfter(()=>x.f.put('C',[{role:'user',id:'m1',content:'replacement source'}]));let result,error;try{result=await x.search();}catch(e){error=e;}assert.ok(error||!result.coverage.complete);
});
test('plaintext statistics never initialize or read a key just to reuse coverage',async t=>{
  const x=await setup(t,{plain:true});let keys=0;x.f.keys.unlock=async()=>{keys++;throw Error('plaintext must not acquire a key');};
  assert.equal((await x.search()).coverage.complete,true);assert.ok(count(x,'scanStats.hit')>=3);assert.equal(keys,0);
});
test('encryption mode changes clear statistics while sealed reads retain their original contract',async t=>{
  const x=await setup(t);x.f.changeConfig({workDataEncryptionV1:false});let result,error;try{result=await x.search();}catch(e){error=e;}
  assert.ok(count(x,'scanStats.clear')>0);assert.ok(!error||error.code==='session_fulltext.source_policy_conflict');if(result)assert.equal(result.coverage.complete,true);
});
test('resetPreparation and restorePause explicitly clear the private statistics cache',async t=>{
  const x=await setup(t);x.timing.reset();x.consumerIndex().resetPreparation('user-session-search');assert.ok(count(x,'scanStats.clear')>0);
  x.timing.reset();await x.f.ui('unused',null,()=>x.consumerIndex().restorePause());assert.ok(count(x,'scanStats.clear')>0);
});
test('encrypted head with empty body and no actual body lease never receives a cached-key witness',async t=>{
  const x=await setup(t,{sourceOnly:true});await x.f.put('Empty',[]);const proof=await x.f.api.source.scan('Empty',()=>{});
  assert.equal(proof.requiresEncryption,true);assert.equal(x.f.scanWitness.read(proof),null);
});
test('key-unavailable and credential-release falsy errors are preserved exactly',async t=>{
  const x=await setup(t);x.f.keys.unlock=async()=>{throw 0;};let first=Symbol();try{await x.search();}catch(e){first=e;}assert.equal(first,0);
  const y=await setup(t,{mixed:true,sourceOnly:true});y.f.keys.snapshot=async()=>({key:y.f.master,instanceId:y.f.instanceId,release:async()=>{throw false;}});
  let second=Symbol();try{await y.f.api.source.scan('C',()=>{});}catch(e){second=e;}assert.equal(second,false);
});
test('actual equal decode leases share one opaque token, different credentials never merge',async t=>{
  const x=await setup(t,{mixed:true,sourceOnly:true}),a=await x.f.api.source.scan('A',()=>{}),b=await x.f.api.source.scan('B',()=>{});
  assert.equal(x.f.scanWitness.read(a),x.f.scanWitness.read(b));
  const other=crypto.randomBytes(32);t.after(()=>other.fill(0));const row={role:'user',id:'m1',content:'different credential source'};
  const line=x.f.fx.WorkDataRecords.encodeLine(JSON.stringify(row),other,{instanceId:x.f.instanceId,sessionId:'C',kind:'messages',ordinal:0});await fs.writeFile(path.join(x.f.sessions,'C.messages.ndjson'),line+'\n');x.f.keys.unlock=async()=>other;
  const c=await x.f.api.source.scan('C',()=>{});assert.notEqual(x.f.scanWitness.read(a),x.f.scanWitness.read(c));assert.equal(await x.f.scanWitness.validate(x.f.scanWitness.read(a)),false);assert.equal(await x.f.scanWitness.validate(x.f.scanWitness.read(c)),true);
  x.f.keys.unlock=async()=>x.f.master;assert.equal(await x.f.scanWitness.validate(x.f.scanWitness.read(a)),true,'old opaque token remains verifiable without strong retention of old intern tags');
});
test('model and UI scopes cannot borrow statistical authorization from each other',async t=>{
  const x=await setup(t);x.timing.reset();const found=await x.f.model('orchid missing');assert.equal(found.coverage.complete,true);
  assert.ok(count(x,'scanStats.write')>=3);assert.equal(count(x,'scanStats.hit'),0);
});
