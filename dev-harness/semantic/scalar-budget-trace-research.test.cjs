'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {wrapScalarHost}=require('./scalar-budget-trace-research.cjs');
const {createScalarNativeHost}=require('./gcc-scalar-native-host-research.cjs');
const model='9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7',runtime='5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c',adapter='0ae9f69a19b689fdcdb093918bd000a5aebe4c7eed354e227c75e38041764ff8';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function host(score){return createScalarNativeHost({factory:async options=>{let finish;const exited=new Promise(resolve=>finish=resolve);
  options.onOwned({exited,terminate:async()=>finish({cleanupStatus:'observed'})});
  return {runtimeLockSha256:runtime,adapterSourceSha256:adapter,contract:{modelSha256:model,templateSha256:'fake',hostMaxJointTokens:512,physicalBatch:1},stats:()=>({}),score};}});}
test('predictor can enter a rejection fixed point after one guard-inclusive sample',async()=>{
  let nativeCalls=0;const base=host(async(_query,_source,opts)=>{nativeCalls++;await opts.beforeRerank();await sleep(410);await opts.beforeRerank();return {ok:true,probability:.98,tokens:50};});
  const traced=wrapScalarHost(base),fp=await traced.prepare({deadline:Date.now()+5000});
  const first=await traced.verify('synthetic',{text:'synthetic'},{fingerprints:fp,deadline:Date.now()+1000,beforeVerify:async()=>{}});
  assert.equal(first.ok,true);const predicted=base.estimateVerificationBudget(1);assert.ok(predicted>500);
  for(let n=0;n<5;n++){const value=await traced.verify('synthetic',{text:'synthetic'},{fingerprints:fp,deadline:Date.now()+300,beforeVerify:async()=>{}});assert.equal(value.reason,'timeout');}
  const traces=traced.takeBudgetTraces();assert.equal(nativeCalls,1);assert.equal(base.stats().predictedTimeouts,5);assert.equal(traces.length,6);
  assert.ok(traces.slice(1).every(row=>row.estimateMs>row.remainingAtHostMs&&row.http.length===0));assert.equal((await traced.stop()).workerExited,true);
});
test('source exception identity and global fetch are unchanged by tracing',async()=>{
  const base=host(async()=>{throw Error('must not reach native');}),traced=wrapScalarHost(base),fp=await traced.prepare({deadline:Date.now()+5000}),before=global.fetch;
  let seen=Symbol();try{await traced.verify('synthetic',{text:'synthetic'},{fingerprints:fp,deadline:Date.now()+1000,beforeVerify:async()=>{throw 0;}});}catch(error){seen=error;}
  assert.equal(seen,0);assert.equal(global.fetch,before);assert.equal(traced.takeBudgetTraces()[0].status,'threw');assert.equal((await traced.stop()).workerExited,true);
});
test('HTTP timing records route and elapsed but not body or authorization',async()=>{
  const prior=global.fetch;global.fetch=async()=>({ok:true,status:200,json:async()=>({value:1})});
  try{const fake={prepare:async()=>({ok:true}),estimateVerificationBudget:()=>100,verify:async(_q,_s,opts)=>{await opts.beforeVerify();
    const response=await fetch('http://127.0.0.1:1234/rerank',{headers:{authorization:'Bearer secret'},body:'private synthetic'});
    await response.json();return {ok:true};}},traced=wrapScalarHost(fake),installed=global.fetch;
    assert.equal((await traced.verify('q',{text:'private synthetic'},{deadline:Date.now()+1000,beforeVerify:async()=>{}})).ok,true);
    const trace=traced.takeBudgetTraces()[0],serialized=JSON.stringify(trace);assert.equal(trace.http[0].route,'/rerank');assert.ok(trace.http[0].totalMs>=0);
    assert.ok(!serialized.includes('secret')&&!serialized.includes('private synthetic'));assert.equal(global.fetch,installed);
  }finally{global.fetch=prior;}
});
