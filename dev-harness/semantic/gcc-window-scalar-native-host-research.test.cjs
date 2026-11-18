'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), cp = require('node:child_process');
const oldFactory = require('./gcc-scalar-native-host-research.cjs').createScalarNativeHost;
const newFactory = require('./gcc-window-scalar-native-host-research.cjs').createScalarNativeHost;
const nativePath = require.resolve('./gcc-rank-native-research.cjs');
const lock = '5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c';
const nativeSha = '0ae9f69a19b689fdcdb093918bd000a5aebe4c7eed354e227c75e38041764ff8';
const model = '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7';
function factory({ unknown = false } = {}) {
  return async options => {
    let end; const exited = unknown ? Promise.resolve({cleanupStatus:'unknown'}) : new Promise(resolve => { end=resolve; });
    options.onOwned({exited,terminate:async()=>{ if (end) end({cleanupStatus:'observed'}); }});
    return {runtimeLockSha256:lock,adapterSourceSha256:nativeSha,
      contract:{modelSha256:model,templateSha256:'fake',hostMaxJointTokens:512,physicalBatch:1},stats:()=>({}),
      score:async(_q,_d,opts)=>{await opts.beforeRerank();return {ok:true,probability:.96,tokens:10};}};
  };
}
test('window policy gets distinct cache fingerprint while preserving score and guard', async () => {
  const a=oldFactory({factory:factory()}), first=await a.prepare({deadline:Date.now()+5000}); await a.stop();
  const b=newFactory({factory:factory()}), second=await b.prepare({deadline:Date.now()+5000});
  assert.notEqual(first.policyFingerprint,second.policyFingerprint); assert.equal(first.runtimeFingerprint,second.runtimeFingerprint);
  let guards=0;const value=await b.verify('q',{text:'same'}, {deadline:Date.now()+1000,fingerprints:second,beforeVerify:async()=>{guards++;}});
  assert.equal(value.policyFingerprint,second.policyFingerprint);assert.equal(value.accepted,true);assert.ok(guards>=3);
  await assert.rejects(b.verify('q',{text:'same'},{deadline:Date.now()+1000,fingerprints:first,beforeVerify:async()=>{}}),/fingerprint_changed/);
  assert.equal((await b.stop()).workerExited,true);
});
test('pre-prepare cancellation keeps a falsy original reason ahead of fingerprint checks',async()=>{
  const host=newFactory({factory:factory()}),controller=new AbortController();controller.abort(0);let reason=Symbol();
  try{await host.verify('q',{text:'same'},{signal:controller.signal});}catch(error){reason=error;}
  assert.equal(reason,0);assert.equal((await host.stop()).workerExited,true);
});
test('unprepared verification remains unavailable and cannot write',async()=>{
  let writes=0;const host=newFactory({factory:async()=>{writes++;throw Error('must not launch');}});
  const value=await host.verify('q',{text:'same'},{deadline:Date.now()+1000,fingerprints:{},beforeVerify:async()=>{}});
  assert.equal(value.ok,false);assert.equal(value.reason,'unavailable');assert.equal(writes,0);assert.equal((await host.stop()).workerExited,true);
});
for (const ordering of ['old-first','new-first']) test('unknown owner blocks both policy variants: '+ordering, () => {
  const oldPath=JSON.stringify(require.resolve('./gcc-scalar-native-host-research.cjs'));
  const newPath=JSON.stringify(require.resolve('./gcc-window-scalar-native-host-research.cjs'));
  const script=`const old=require(${oldPath}).createScalarNativeHost,newer=require(${newPath}).createScalarNativeHost;
    const owner={exited:Promise.resolve({cleanupStatus:'unknown'}),terminate:async()=>{}};
    const maker=async opts=>{opts.onOwned(owner);throw Error('startup');};
    (async()=>{const first=(${JSON.stringify(ordering)}==='old-first'?old:newer)({factory:maker});try{await first.prepare()}catch{}
      const other=(${JSON.stringify(ordering)}==='old-first'?newer:old)({factory:async()=>{throw Error('must not launch')}});
      const result=await other.prepare();console.log(JSON.stringify({ok:result.ok,reason:result.reason}));})().catch(e=>{console.error(e);process.exitCode=1});`;
  const result=cp.spawnSync(process.execPath,['-e',script],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,false);
});
