'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createScalarNativeHost } = require('./gcc-scalar-native-host-research.cjs');
const model = '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7', runtime = '5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c', adapter = '0ae9f69a19b689fdcdb093918bd000a5aebe4c7eed354e227c75e38041764ff8';
function fake(options = {}) { let stopped = 0, end; const exited = new Promise(resolve => end = resolve), owner = { exited, terminate: async () => { stopped++; end({ cleanupStatus: 'observed' }); } };
  const native = { runtimeLockSha256: runtime, adapterSourceSha256: adapter,
  contract: { modelSha256: model, templateSha256: 'template', hostMaxJointTokens: 512, physicalBatch: 1 },
  score: options.score || (async (_q, _d, options) => { await options.beforeRerank(); await options.beforeRerank(); return { ok: true, probability: .96, tokens: 80 }; }),
  stop: async () => { stopped++; return { cleanupStatus: 'observed', workerExited: true }; } };
  return { native, owner, host: createScalarNativeHost({ factory: async options => { options.onOwned(owner); return native; } }), stopped: () => stopped };
}
test('native host maps actual inner writes to beforeRerank using identical fingerprints and policy', async () => {
  const t = fake(), fp = await t.host.prepare({ deadline: Date.now() + 20000 }); let guards = 0;
  const result = await t.host.verify('q', { text: 'same field' }, { deadline: Date.now() + 1000, fingerprints: fp, beforeVerify: async () => { guards++; } });
  assert.equal(result.accepted, true); assert.equal(result.score, .96); assert.ok(guards >= 4);
  for (const name of ['modelFingerprint', 'templateFingerprint', 'runtimeFingerprint', 'policyFingerprint']) assert.equal(result[name], fp[name]);
  assert.equal((await t.host.stop()).cleanupStatus, 'observed');
});
test('late authority errors including falsy values remain primary and cleanup is observed', async () => {
  for (const reason of [0, false, '', Error('source changed')]) { const t = fake(), fp = await t.host.prepare(); let observed = Symbol();
    try { await t.host.verify('q', { text: 'field' }, { deadline: Date.now() + 1000, fingerprints: fp, beforeVerify: async () => { throw reason; } }); } catch (error) { observed = error; }
    assert.equal(observed, reason); assert.equal((await t.host.stop()).cleanupStatus, 'observed'); assert.ok(t.stopped());
  }
});
test('deadline during owned native request waits for stop and returns unknown admission timeout', async () => {
  const t = fake({ score: async (_q, _d, options) => { await options.beforeRerank(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  const fp = await t.host.prepare(), result = await t.host.verify('q', { text: 'field' }, { deadline: Date.now() + 400, fingerprints: fp, beforeVerify: async () => {} });
  assert.equal(result.ok, false); assert.equal(result.reason, 'timeout'); assert.ok(t.stopped()); assert.equal((await t.host.stop()).workerExited, true);
});
test('falsy external in-flight cancellation preserves exact original reason', async () => {
  for (const reason of [0, false, '']) { let entered; const began = new Promise(resolve => entered = resolve), controller = new AbortController();
    const t = fake({ score: async (_q, _d, options) => { entered(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
    const fp = await t.host.prepare(); const pending = t.host.verify('q', { text: 'field' }, { signal: controller.signal, deadline: Date.now() + 1000, fingerprints: fp, beforeVerify: async () => {} });
    await began; controller.abort(reason); let observed = Symbol(); try { await pending; } catch (error) { observed = error; } assert.equal(observed, reason); assert.equal((await t.host.stop()).workerExited, true);
  }
});
test('cold foreground is loading, stop awaits pending ownership, and failed opaque startup is not fake clean', async () => {
  let release; const t = fake(), gate = new Promise(resolve => release = resolve);
  const host = createScalarNativeHost({ factory: async options => { options.onOwned(t.owner); await gate; return t.native; } });
  assert.equal((await host.prepare({ deadline: Date.now() + 1000 })).state, 'loading');
  let finished = false; const stopping = host.stop().then(value => { finished = true; return value; }); await Promise.resolve(); assert.equal(finished, false);
  release(); assert.equal((await stopping).cleanupStatus, 'observed');
  const hard = Error('EACCES'), clean = fake(), failed = createScalarNativeHost({ factory: async options => { options.onOwned(clean.owner); throw hard; } });
  await assert.rejects(failed.prepare(), error => error === hard); await assert.rejects(failed.prepare(), error => error === hard);
  assert.equal((await failed.stop()).workerExited, true);
});
test('pending native-exit proof blocks another host even after native helper close', async () => {
  let end; const exited = new Promise(resolve => end = resolve), owner = { exited, terminate: async () => {} }, t = fake();
  const host = createScalarNativeHost({ factory: async options => { options.onOwned(owner); return t.native; } });
  const fp = await host.prepare(), next = fake(); let done = false; const stopping = host.stop().then(value => { done = true; return value; });
  await Promise.resolve(); assert.equal(done, false); assert.equal((await next.host.prepare()).ok, false);
  assert.equal((await host.verify('q', { text: 'field' }, { deadline: Date.now() + 1000, fingerprints: fp, beforeVerify: async () => {} })).ok, false);
  end({ cleanupStatus: 'observed' }); assert.equal((await stopping).workerExited, true); assert.equal((await next.host.prepare()).ok, true); await next.host.stop();
});
test('onOwned then constructor hard failure keeps exact unknown owner and blocks same-root new host', async () => {
  const hard = Error('EACCES after ownership'), owner = { terminate: async () => {}, exited: Promise.resolve({ cleanupStatus: 'unknown' }) };
  const host = createScalarNativeHost({ factory: async options => { options.onOwned(owner); throw hard; } });
  await assert.rejects(host.prepare(), error => error === hard); assert.equal((await host.stop()).workerExited, false);
  await assert.rejects(host.prepare(), error => error === hard); assert.equal((await fake().host.prepare()).ok, false);
});
test('already-unknown owner cannot be overwritten by a returning constructor or write after ready', () => {
  // A separate Node lifetime gives this intentionally permanent unknown root
  // its own registry. No model or helper is started by this injected factory.
  const script = `const {createScalarNativeHost}=require(${JSON.stringify(require.resolve('./gcc-scalar-native-host-research.cjs'))});
    const owner={terminate:async()=>{},exited:Promise.resolve({cleanupStatus:'unknown'})};let writes=0;
    const native={runtimeLockSha256:${JSON.stringify(runtime)},adapterSourceSha256:${JSON.stringify(adapter)},contract:{modelSha256:${JSON.stringify(model)},hostMaxJointTokens:512,physicalBatch:1,templateSha256:'t'},score:async()=>{writes++;return{}},stats:()=>({}),stop:async()=>({cleanupStatus:'unknown',workerExited:false})};
    (async()=>{const host=createScalarNativeHost({factory:async options=>{options.onOwned(owner);return native;}});let ready=false;try{ready=(await host.prepare()).ok;}catch{}const result=await host.verify('q',{text:'field'},{deadline:Date.now()+1000,fingerprints:{},beforeVerify:async()=>{}});const next=await createScalarNativeHost({factory:async()=>native}).prepare();const cleanup=await host.stop();console.log(JSON.stringify({ready,ok:result.ok,writes,next:next.ok,cleanup}));})().catch(error=>{console.error(error);process.exitCode=1});`;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout.trim()); assert.equal(value.ready, false); assert.equal(value.ok, false); assert.equal(value.writes, 0); assert.equal(value.next, false); assert.equal(value.cleanup.workerExited, false);
});
for (const mode of ['unknown', 'source-error']) test('owner becoming unknown across native await blocks next write and preserves ' + mode, () => {
  const script = `const {createScalarNativeHost}=require(${JSON.stringify(require.resolve('./gcc-scalar-native-host-research.cjs'))});
    let end,writes=0,guards=0;const exited=new Promise(resolve=>end=resolve),owner={terminate:async()=>{},exited},denied=Error('source revoked');
    const native={runtimeLockSha256:${JSON.stringify(runtime)},adapterSourceSha256:${JSON.stringify(adapter)},contract:{modelSha256:${JSON.stringify(model)},hostMaxJointTokens:512,physicalBatch:1,templateSha256:'t'},stats:()=>({}),stop:async()=>({cleanupStatus:'unknown',workerExited:false}),score:async(_q,_d,options)=>{end({cleanupStatus:'unknown'});await Promise.resolve();await options.beforeRerank();writes++;return{ok:true,probability:1,tokens:40}}};
    (async()=>{const host=createScalarNativeHost({factory:async options=>{options.onOwned(owner);return native;}}),fp=await host.prepare();let ok=false,primary=false;try{ok=(await host.verify('q',{text:'field'},{deadline:Date.now()+1000,fingerprints:fp,beforeVerify:async()=>{guards++;if(${JSON.stringify(mode)}==='source-error'&&guards===2)throw denied;}})).ok;}catch(error){primary=error===denied;}const cleanup=await host.stop();console.log(JSON.stringify({ok,writes,primary,cleanup,stats:host.stats()}));})().catch(error=>{console.error(error);process.exitCode=1});`;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout.trim()); assert.equal(value.writes, 0); assert.equal(value.ok, false); assert.equal(value.primary, mode === 'source-error'); assert.equal(value.cleanup.workerExited, false); assert.equal(value.stats.unconfirmedOwners, 1);
});
