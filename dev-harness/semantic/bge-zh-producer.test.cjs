'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{fixture}=require('./bge-zh-live-fixture.cjs');
const qVector=[1,...Array(511).fill(0)];
async function setup(t,documents,options={}){let detail,after=null;const vectors=[];
  const runtime={prepare:async()=>({available:true,modelId:'bge-small-zh-v1.5',modelFingerprint:'fake-bge512',dimensions:512,retrievalThresholds:{search:.53,automatic:null}}),encode:async(texts,opts)=>{await opts.beforeEncode?.();if(after){const work=after;after=null;await work();}if(options.partial&&opts.role==='document')return {ok:false,reason:'timeout'};
    return {ok:true,modelFingerprint:'fake-bge512',vectors:texts.map(text=>{vectors.push({role:opts.role,length:text.length});if(opts.role==='query')return qVector;const score=options.score?options.score(text):text.startsWith('TOP')?.9:text.includes('BEST')?.7:.52;return [score,Math.sqrt(1-score*score),...Array(510).fill(0)];})};}};
  const f=await fixture({enabled:true,privacy:'enhanced',runtime,observeSearch:(_value,privateValue)=>{detail=privateValue;},researchDirectory:path.resolve('output/bge-zh-producer-fakes')});t.after(()=>f.close());
  for(const [sid,value]of Object.entries(documents))await f.put(sid,[{role:'user',id:'m1',content:value.text}],{head:{title:value.title||'',summary:value.summary||'',cwd:''}});await f.index.prepare(null);
  return {f,vectors,detail:()=>detail,setAfter:work=>after=work,search:()=>f.ui('orchid missing')};
}
test('long weak source cites its fixed best original window; no scalar or whole field inference',async t=>{
  const text='orchid early weak. '+'padding '.repeat(35)+'BEST later evidence '.repeat(7),x=await setup(t,{A:{text},B:{text:'TOP independent source'}}),found=await x.search(),a=found.results.find(row=>row.reference?.sessionId==='A');
  assert.ok(a);assert.equal(a.reference.source,'content');assert.equal(a.reference.matchKind,'verified-window');assert.ok(a.reference.matchStart>0);assert.equal(a.reference.matchEnd-a.reference.matchStart,96);assert.ok(a.snippet.includes(text.slice(a.reference.matchStart,a.reference.matchEnd)));assert.equal(x.detail().scalarPairs,0);assert.ok(x.vectors.filter(row=>row.role==='document').every(row=>row.length<=96));
});
test('rejected weak source cannot borrow another source cosine or suppress that independent hit',async t=>{
  const x=await setup(t,{A:{text:'orchid low evidence'},B:{text:'TOP independent evidence'}}),found=await x.search();assert.equal(found.results.length,1);assert.equal(found.results[0].reference.sessionId,'B');assert.equal(x.detail().scalarPairs,0);
});
test('partial coarse coverage withholds weak candidate and keeps partial status',async t=>{
  const x=await setup(t,{A:{text:'orchid weak evidence'}},{partial:true}),found=await x.search();assert.equal(found.results.length,0);assert.equal(found.semantic.coverage,'partial');
});
test('source configuration revocation during encoder await rejects before disclosure',async t=>{
  const x=await setup(t,{A:{text:'orchid weak evidence'}});x.setAfter(()=>x.f.changeConfig({privacyModeV1:'strict'}));await assert.rejects(x.search());
});
test('metadata admission remains same-field full privacy-projected context with no body reference',async t=>{
  const secret='sk-live-'+ 'a1B2'.repeat(12),summary='TOP missing evidence '+secret+' complete context';
  const x=await setup(t,{A:{text:'unrelated body',title:'orchid title is rejected',summary}}),found=await x.search();assert.equal(found.results.length,1);const hit=found.results[0];assert.equal(hit.reference,null);assert.equal(hit.matchKind,'metadata-context');assert.ok(!hit.snippet.includes(secret));assert.ok(hit.snippet.includes('complete context'));assert.ok(!hit.snippet.includes('title is rejected'));
});
