'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {fixture}=require('./scalar-coverage-reuse-fixture.cjs'),{createTiming}=require('./scalar-producer-phase-timing.cjs');
const fp={modelFingerprint:'synthetic',templateFingerprint:'synthetic',runtimeFingerprint:'synthetic',policyFingerprint:'synthetic'};
function descendants(snapshot,phase,name){const byId=new Map(snapshot.events.map(e=>[e.id,e]));return snapshot.events.filter(e=>{
  if(e.name!==name)return false;let p=byId.get(e.parent);while(p){if(p.name===phase)return true;p=byId.get(p.parent);}return false;});}
async function setup(t,options={}){
  const timing=createTiming();let after=null;
  const f=await fixture({reuse:options.reuse!==false,enabled:true,privacy:'enhanced',researchDirectory:path.resolve('output/semantic-coverage-reuse-fakes'),
    runtime:{prepare:async()=>({available:true,modelFingerprint:'synthetic'}),encode:async(texts,opts)=>{await opts.beforeEncode?.();return {ok:true,modelFingerprint:'synthetic',vectors:texts.map(()=>[1,0])};}},
    scalarHost:{prepare:async()=>({ok:true,...fp}),verify:async(_q,_s,opts)=>{await opts.beforeVerify();return options.unknown?{ok:false,reason:'unavailable'}:{ok:true,...fp,score:options.negative?.01:.99,accepted:!options.negative};},stop:async()=>({cleanupStatus:'observed',workerExited:true})}});
  t.after(()=>f.close());
  f.context.ResearchProducerTiming={...timing,measure:async(name,work)=>{const result=await timing.measure(name,work);if(name==='phase.coverage.preVerifier'&&after){const action=after;after=null;await action();}return result;}};
  for(const sid of ['A','B','C'])await f.put(sid,[{role:'user',id:'m1',content:sid==='A'?'orchid factual archive':'unrelated source '+sid,...(sid==='C'?options.extra:{})}],{head:{title:'',summary:'',cwd:''}});
  await f.index.prepare(null);await f.ui('orchid missing');timing.reset();
  return {f,timing,setAfter:fn=>after=fn,search:async()=>{timing.reset();return f.ui('orchid missing');}};
}
test('real authorized source proof is reused only within this search; final source scan is reduced',async t=>{
  const x=await setup(t),found=await x.search(),snap=x.timing.snapshot();assert.equal(found.coverage.complete,true);
  assert.equal(descendants(snap,'phase.coverage.preVerifier','host.scan').length,3);
  assert.ok(descendants(snap,'phase.coverage.final','host.scan').length<3);
  await x.search();assert.equal(descendants(x.timing.snapshot(),'phase.coverage.preVerifier','host.scan').length,3,'prior request proof never skips new precoverage');
});
test('source rewrite after capture cannot reuse the earlier revision or disclose its old value',async t=>{
  const x=await setup(t);x.setAfter(()=>x.f.put('C',[{role:'user',id:'m1',content:'replaced source'}]));
  let result,error;try{result=await x.search();}catch(e){error=e;}
  assert.ok(error||result.coverage.complete===false);assert.ok(error||!result.results.some(r=>r.snippet?.includes('unrelated source C')));
});
test('scope/config revocation after capture still rejects and does not publish evidence',async t=>{
  const x=await setup(t);x.setAfter(()=>x.f.changeConfig({privacyModeV1:'strict'}));
  await assert.rejects(x.search(),e=>!!e);
});
test('source guard hard error after full scan retains the original error object',async t=>{
  const x=await setup(t),error=Object.assign(new Error('synthetic denied'),{code:'EACCES'});x.setAfter(()=>{throw error;});
  await assert.rejects(x.search(),e=>e===error);
});
test('unknown text-member count remains partial after reuse, never a clean coverage proof',async t=>{
  const x=await setup(t,{extra:{blocks:[{unsupported:true}]}}),found=await x.search();
  assert.equal(found.coverage.complete,false);assert.ok(found.coverage.messages.unverifiedText>0);
  assert.equal(found.semantic.coverage,'partial');
});
test('embedded attachments remain on original full scan path and keep partial evidence',async t=>{
  const x=await setup(t,{extra:{attachments:[{textPreview:'unverified attachment'}]}}),found=await x.search();
  assert.equal(found.coverage.complete,false);assert.ok(descendants(x.timing.snapshot(),'phase.coverage.final','host.scan').length>=1);
});
test('external encrypted file rewrite with unchanged in-memory sequence is caught by the real owner',async t=>{
  const x=await setup(t),file=path.join(x.f.sessions,'C.messages.ndjson'),sequence=x.f.api.source.sequence('C');
  x.setAfter(async()=>{const bytes=await fs.readFile(file);bytes[10]^=1;await fs.writeFile(file,bytes);assert.equal(x.f.api.source.sequence('C'),sequence);});
  let result,error;try{result=await x.search();}catch(e){error=e;}
  assert.ok(error||result.coverage.complete===false,'cached scan proof is not a current external owner proof');
});
test('external source deletion after capture cannot produce complete coverage',async t=>{
  const x=await setup(t);x.setAfter(()=>fs.unlink(path.join(x.f.sessions,'C.messages.ndjson')));
  let result,error;try{result=await x.search();}catch(e){error=e;}assert.ok(error||result.coverage.complete===false);
});
test('actual destination cancellation after capture keeps existing consumer fail-closed behavior',async t=>{
  const x=await setup(t);x.setAfter(()=>x.f.controller.abort(0));let observed=Symbol('not rejected');
  try{await x.f.model('orchid missing');}catch(e){observed=e;}assert.equal(observed.code,'session_search.destination_changed');assert.equal(x.f.controller.signal.reason,0);
});
test('unknown scalar result remains withheld and partial even with complete source proofs',async t=>{
  const x=await setup(t,{unknown:true}),found=await x.search();assert.equal(found.results.length,0);assert.equal(found.semantic.coverage,'partial');
});
test('negative cached scalar does not turn a rewritten source into a proven negative answer',async t=>{
  const x=await setup(t,{negative:true});x.setAfter(()=>x.f.put('C',[{role:'user',id:'m1',content:'new unmatched material'}]));
  let result,error;try{result=await x.search();}catch(e){error=e;}assert.ok(error||result.coverage.complete===false);
});
module.exports={descendants};
