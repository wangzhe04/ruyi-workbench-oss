'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {run}=require('./scalar-budget-live-diagnostic.cjs');
test('actual consumer fake diagnostic observes guards while preserving partial/result contract',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-scalar-budget-fake-')),fps={modelFingerprint:'model',templateFingerprint:'template',runtimeFingerprint:'runtime',policyFingerprint:'policy'};
  const encoder={prepare:async()=>({available:true,modelFingerprint:'model'}),encode:async(texts,options)=>{await options.beforeEncode?.();return {ok:true,modelFingerprint:'model',vectors:texts.map(()=>[1,0])};},
    stop:async()=>({workerExited:true,cleanupStatus:'observed'})};
  const scalarHost={prepare:async()=>({ok:true,...fps}),verify:async(_q,_source,options)=>{await options.beforeVerify();return {ok:true,...fps,score:.99,accepted:true};},
    estimateVerificationBudget:()=>150,stop:async()=>({workerExited:true,cleanupStatus:'observed'})};
  const result=await run({directory:dir,profile:{kind:'synthetic-test',encoder,scalarHost,bindings:[]},
    testCorpus:{topics:['garden trees','railway trains'],queries:['completely different concept'],documents:2}});
  assert.equal(result.failed,false);assert.equal(result.report.status,'COMPLETE_DIAGNOSTIC_NOT_QUALITY');
  const traces=[...result.report.prewarm,...result.report.queries].flatMap(row=>row.scalar);
  assert.ok(traces.length>=1);assert.ok(traces.some(row=>row.guards.length>=1));assert.equal(result.report.allWorkersObservedExited,true);
  assert.ok(!JSON.stringify(traces).includes('garden trees'));
});
