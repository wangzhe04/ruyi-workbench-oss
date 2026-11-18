'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {run,summarize,fixedFixture}=require('./scalar-window-append-performance.cjs');
test('fixed original natural workload has 25 sources and 30 distinct queries',()=>{
  const f=fixedFixture();assert.equal(f.documents.length,25);assert.equal(f.queries.length,30);assert.equal(new Set(f.queries).size,30);
  assert.ok(f.documents.every(row=>row.text.length>=3180));
});
test('all-denominator p95 retains partial and separates complete subset',()=>{
  const row=(elapsedMs,complete)=>({elapsedMs,complete,resultCount:0,classes:{weakLexical:0,semanticOnly:0},calls:{queryTexts:1,scalarVerifications:0},privateSummary:{weakWork:0}});
  const value=summarize([row(100,true),row(900,false)]);assert.equal(value.count,2);assert.equal(value.partial,1);assert.equal(value.p95Ms,900);assert.equal(value.completeOnlyP95Ms,100);
});
test('actual public consumer labels first queries and repeats separately using fake runtime only',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-perf-harness-fake-')),fps={modelFingerprint:'fake-model',templateFingerprint:'fake-template',runtimeFingerprint:'fake-runtime',policyFingerprint:'fake-policy'};
  let verified=0;const encoder={prepare:async()=>({available:true,modelFingerprint:'fake-model'}),encode:async(texts,opts)=>{await opts.beforeEncode?.();return {ok:true,modelFingerprint:'fake-model',vectors:texts.map(()=>[1,0])};},
    stop:async()=>({workerExited:true,cleanupStatus:'observed'}),stats:()=>({})};
  const scalarHost={prepare:async()=>({ok:true,...fps}),verify:async(_query,_source,opts)=>{await opts.beforeVerify();verified++;return {ok:true,...fps,score:.99,accepted:true};},
    stop:async()=>({workerExited:true,cleanupStatus:'observed'}),stats:()=>({verified})};
  const profile={id:'fake',kind:'synthetic-test',encoder,scalarHost,bindings:[],ownedIdentities:()=>({coarse:null,scalar:null})};
  const corpus={documents:[{id:'P000',text:'garden plants watering soil'},{id:'P001',text:'cooking pasta tomato garlic'}],
    queries:['water a garden','cook tomato pasta']};
  const value=await run({directory,profile,corpus,prewarmMax:8});
  assert.equal(value.failed,false);assert.equal(value.report.fresh.length,2);assert.equal(value.report.repeat.length,2);
  assert.equal(value.report.summary.fresh.queryEncodedOnce,2);assert.equal(value.report.summary.repeat.queryCacheHits,2);
  assert.equal(value.report.allWorkersObservedExited,true);
  const next=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-perf-harness-close-fail-'));
  const failed=await run({directory:next,profile,corpus,prewarmMax:8,fixtureFactory:async opts=>{
    const f=await require('./scalar-window-append-public-consumer-fixture.cjs').fixture(opts),close=f.close;
    return {...f,close:async()=>{await close();throw Error('synthetic fixture close failure');}};
  }});
  assert.equal(failed.report.status,'FAIL_FIXTURE_CLEANUP');assert.equal(failed.failed,true);
});
