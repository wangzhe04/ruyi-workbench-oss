'use strict';
// 150 号文 S1 / S18:语义层失败的两类边界。
//   · 守卫类(撤权、取消、stale、privacy.*、work_data*、执行权,以及调用方回验回调里抛的任何东西)原样上抛;
//   · 其余从语义层抛出的(semantic.owner_identity、编解码契约、score 形状不对……)退回关键词基线、标 unavailable。
// 06hb 的可用性失败(进程在观测前退出、ready ok:false)不再写永久 startingFailure:冷却后下一次请求重起,资产修好即恢复。
// 06ha 先判 descriptor 再判期限:冷模型加载期回执是 loading 而不是 timeout。
//
// SemanticFailurePolicy 是 00-boot 的模块内常量、memoryPreflightMustPropagate 是 05 的内部函数,都不在 server.js 的
// 导出面上;这里按 source-slice 切出原样定义放进 vm 里跑它们的【行为】(与 memory-semantic.test.js 读 06hc 同口径)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { constBlock, functionBlock } = require('../lib/source-slice');
const { killOwnTree } = require('../lib/kill-own-tree');

const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');
const policySource = constBlock(read('00-boot.js'), 'SemanticFailurePolicy');
const propagateSource = functionBlock(read('05-claude-engine.js'), 'memoryPreflightMustPropagate');
assert.ok(policySource.length > 400, 'sliced SemanticFailurePolicy from 00-boot');
assert.ok(propagateSource.length > 40, 'sliced memoryPreflightMustPropagate from 05');

function policyContext() {
  const context = vm.createContext({ MemorySemanticHooks: {}, setTimeout, clearTimeout, Date });
  vm.runInContext(policySource + '\n' + propagateSource, context);
  return context;
}
const fault = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });

test('S1 guard boundary: guard failures propagate, semantic runtime failures degrade', () => {
  const c = policyContext();
  const P = vm.runInContext('SemanticFailurePolicy', c), mustPropagate = vm.runInContext('memoryPreflightMustPropagate', c);
  const guards = [
    Object.assign(Error('aborted'), { name: 'AbortError' }), fault('ABORT_ERR'),
    fault('privacy.disclosure_dirty'), fault('privacy_policy.revoked'), fault('work_data.key_locked'), fault('work_data_key.locked'),
    fault('memory_semantic.guard_failed'), fault('memory_semantic.stale'), fault('memory_semantic.aborted'),
    fault('SESSION_EXECUTION_REVOKED'), fault('STEWARD_TURN_CANCELLED'),
    Object.assign(Error('anything'), { memorySemanticGuardFailure: true }), Error('semantic.aborted'),
  ];
  for (const error of guards) {
    assert.equal(P.isGuard(error), true, 'guard: ' + (error.code || error.message));
    assert.equal(P.degradable(error), false, 'not degradable: ' + (error.code || error.message));
    assert.equal(mustPropagate(error), true, 'preflight propagates: ' + (error.code || error.message));
  }
  const runtime = [fault('semantic.owner_identity'), fault('semantic.vector_contract'), Error('semantic.untrusted_codec_result'),
    Error('semantic.prepare_failed'), Error('memory_semantic.score_failed'), fault('EG2_TOKEN_CONTRACT'), TypeError('semantic.invalid_texts')];
  for (const error of runtime) {
    assert.equal(P.isGuard(error), false, 'not a guard: ' + (error.code || error.message));
    assert.equal(P.degradable(error), true, 'degradable: ' + (error.code || error.message));
    assert.equal(mustPropagate(error), false, 'preflight no longer propagates: ' + (error.code || error.message));
  }
  // Non-Error throwables (frozen sentinels, strings) and anything during an aborted signal stay conservative.
  assert.equal(P.degradable(Object.freeze({ semanticSourceBudget: true })), false);
  assert.equal(P.degradable('semantic.owner_identity'), false);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(P.degradable(fault('semantic.owner_identity'), aborted.signal), false);
});

test('S1 guard wrapper marks whatever a caller check throws, whatever its code', async () => {
  const c = policyContext();
  const P = vm.runInContext('SemanticFailurePolicy', c);
  const changed = fault('fulltext_index.source_changed'), plain = Error('source revoked');
  for (const error of [changed, plain]) {
    assert.equal(P.degradable(error), true, 'unmarked caller failure would look degradable');
    await assert.rejects(P.guard(async () => { throw error; })(), e => e === error);
    assert.equal(P.isGuard(error), true, 'marked after passing through the guard wrapper');
    assert.equal(P.degradable(error), false);
  }
  assert.equal(P.guard(undefined), undefined);
  assert.equal(await P.guard(async x => x + 1)(1), 2);
});

function memoryRecall(score) {
  const c = policyContext();
  const factory = vm.runInContext(read('06hc-memory-semantic.js') + '\nMemorySemanticRecall;', c);
  const entries = [{ id: 'a' }, { id: 'rule-fill' }, { id: 'b' }], fillKeys = new Set(['rule-fill']);
  const host = { fallback: () => ({ entries, fillKeys }), enabled: () => true, lexical: () => [{ entry: entries[0], shared: 1 }, { entry: entries[2], shared: 1 }],
    key: entry => entry.id, text: entry => entry.id, score };
  return { entries, recall: factory.create(host) };
}

test('S1 memory rerank: runtime failure falls back to the keyword baseline and reports unavailable', async () => {
  for (const thrown of [fault('semantic.owner_identity'), Error('semantic.untrusted_codec_result')]) {
    const phases = [];
    const f = memoryRecall(async () => { throw thrown; });
    const result = await f.recall.rank([], 'query', 4, {}, { scopeId: 'p', check: async phase => { phases.push(phase); } });
    assert.equal(result.entries, f.entries, 'baseline order kept');
    assert.equal(result.semantic.status, 'unavailable');
    assert.deepEqual({ ...result.semantic.fallback }, { reason: 'unavailable', method: 'existing-recall' });
    assert.deepEqual(phases, ['start', 'finish'], 'the fallback still revalidates before returning');
  }
  const malformed = memoryRecall(async () => ({ status: 'mystery' }));
  assert.equal((await malformed.recall.rank([], 'query', 4, {}, {})).semantic.status, 'unavailable', 'malformed score result degrades too');
});

test('S1 memory rerank: guard failures from the caller check and cancellation still propagate', async () => {
  const stale = fault('memory_semantic.stale');
  const viaGuard = memoryRecall(async (_q, _t, options) => { await options.beforeEncode(); return { status: 'ready', scores: [1, 0] }; });
  await assert.rejects(viaGuard.recall.rank([], 'query', 4, {}, { check: async phase => { if (phase === 'finish') throw stale; } }), e => e === stale);
  // A check failure with an arbitrary code still counts as a guard once it went through beforeEncode.
  const revoked = Error('source revoked');
  await assert.rejects(viaGuard.recall.rank([], 'query', 4, {}, { check: async phase => { if (phase === 'finish') throw revoked; } }), e => e === revoked);
  const privacy = memoryRecall(async () => { throw fault('privacy.disclosure_dirty'); });
  await assert.rejects(privacy.recall.rank([], 'query', 4, {}, {}), { code: 'privacy.disclosure_dirty' });
  const workData = memoryRecall(async () => { throw fault('work_data.key_locked'); });
  await assert.rejects(workData.recall.rank([], 'query', 4, {}, {}), { code: 'work_data.key_locked' });
  const controller = new AbortController();
  const cancelled = memoryRecall(async () => { controller.abort(); throw fault('semantic.owner_identity'); });
  await assert.rejects(cancelled.recall.rank([], 'query', 4, {}, { signal: controller.signal }), { code: 'semantic.owner_identity' });
});

test('S1 explicit memory search: runtime failure returns keyword matches with unavailable status', async () => {
  const f = memoryRecall(async () => { throw fault('semantic.owner_identity'); });
  const result = await f.recall.search(f.entries, 'query', 20, {}, { scopeId: 'p', check: async () => {} });
  assert.deepEqual(Array.from(result.entries, entry => entry.id), ['a', 'b']);
  assert.equal(result.semantic.status, 'unavailable');
  assert.equal(result.semantic.fallback.reason, 'unavailable');
  const stale = fault('memory_semantic.stale');
  const guarded = memoryRecall(async (_q, _t, options) => { await options.beforeEncode(); return { status: 'ready', scores: [] }; });
  await assert.rejects(guarded.recall.search(guarded.entries, 'query', 20, {}, { check: async phase => { if (phase === 'finish') throw stale; } }), e => e === stale);
});

test('S18 cold model loading past the deadline reports loading, not timeout', async () => {
  const api = vm.runInNewContext(read('06ha-semantic-retrieval.js') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const loading = api.create({ prepare: async () => { await sleep(40); return { ok: false, available: false, reason: 'unavailable', state: 'loading' }; }, encode: async () => { throw Error('must not encode'); } });
  assert.equal((await loading.score('query', ['doc'], { scopeId: 's', deadlineMs: 5 })).status, 'loading');
  const warming = api.create({ prepare: async () => { await sleep(40); return { ok: false, available: false, reason: 'unavailable', state: 'warming' }; }, encode: async () => { throw Error('must not encode'); } });
  assert.equal((await warming.score('query', ['doc'], { scopeId: 's', deadlineMs: 5 })).status, 'loading');
  // A ready runtime that consumed the whole budget is still a timeout.
  const ready = api.create({ prepare: async () => { await sleep(40); return { available: true, modelId: 'm', modelFingerprint: 'fp', retrievalThresholds: { search: .3 } }; }, encode: async () => { throw Error('must not encode'); } });
  assert.equal((await ready.score('query', ['doc'], { scopeId: 's', deadlineMs: 5 })).status, 'timeout');
});

// ── 06hb:可用性失败带退避重试 ─────────────────────────────────────────────────────────────────
const runtimeSource = read('06hb-semantic-runtime.js');
const fingerprint = 'b'.repeat(64);
const goodWorker = `const readline=require('node:readline');console.log(JSON.stringify({type:'ready',modelFingerprint:'${fingerprint}',dimensions:8}));
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);console.log(JSON.stringify({ok:true,requestId:r.requestId,modelFingerprint:'${fingerprint}',vectors:r.texts.map(()=>[1,0,0,0,0,0,0,0])}));});`;
// Mirrors the production worker with missing assets: it reports ready ok:false and exits before identity is observed.
const brokenWorker = `console.log(JSON.stringify({type:'ready',ok:false,error:{code:'RUNTIME_UNAVAILABLE'}}));process.exitCode=1;`;
// Passes warmup (the first request), then dies on the first real encode.
const crashAfterWarmupWorker = `const readline=require('node:readline');console.log(JSON.stringify({type:'ready',modelFingerprint:'${fingerprint}',dimensions:8}));let n=0;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(++n>1)process.exit(3);console.log(JSON.stringify({ok:true,requestId:r.requestId,modelFingerprint:'${fingerprint}',vectors:r.texts.map(()=>[1,0,0,0,0,0,0,0])}));});`;

function runtimeFixture({ retryMs = 60, worker = null, stableMs } = {}) {
  let now = Date.now();
  class RuntimeClock extends Date { static now() { return now; } }
  // Drive the cooldown explicitly. Child I/O and its safety timers still run in real time.
  const context = vm.createContext({ SemanticRuntimeHooks: {}, Buffer, setTimeout, clearTimeout, Date: RuntimeClock, require, process, __dirname, WeakRef });
  const api = vm.runInContext(runtimeSource + '\n;SemanticRuntimeClient;', context);
  const children = [];
  let assetsFixed = !!worker;
  const exited = child => child.exitCode !== null || child.signalCode !== null;
  const client = api.create({
    enabled: async () => true, startupMs: 5000, faultRetryMs: retryMs, faultRetryMaxMs: retryMs * 4, ...(stableMs === undefined ? {} : { faultStableMs: stableMs }),
    settings: () => ({ command: process.execPath, args: ['-e', worker || (assetsFixed ? goodWorker : brokenWorker)], env: {}, cwd: process.cwd() }),
    spawn: (...args) => { const child = cp.spawn(...args); children.push(child); return child; },
    // Deterministic stand-in for Get-Process: a broken worker is observed only after it has exited (the S1 race);
    // live children report a stable identity, exited ones are absent.
    observe: async pid => {
      const child = children.find(row => row.pid === pid);
      if (!child) return { exists: false };
      if (!assetsFixed && !exited(child)) await new Promise(resolve => child.once('exit', resolve));
      return exited(child) ? { exists: false } : { exists: true, pid, creationFileTime: '133' + String(pid) };
    },
  });
  return { client, children, launches: () => children.length, fixAssets: () => { assetsFixed = true; }, advance: ms => { now += ms; },
    async close() { try { await client.stop('disabled'); } catch { /* cleanup below */ } for (const child of children) if (!exited(child)) killOwnTree(child); } };
}

test('S1 worker that exits before identity is an availability failure, retried after backoff, recovers without restart', async () => {
  const retryMs = 60;
  const f = runtimeFixture({ retryMs });
  try {
    const first = await f.client.prepare({ budgetMs: 5000 });
    assert.equal(first.available, false, 'unavailable result instead of a thrown semantic.owner_identity');
    assert.equal(f.client.descriptor().state, 'failed');
    assert.equal(f.launches(), 1);
    // Inside the cooldown no new process is spawned and nothing throws.
    f.advance(retryMs - 1);
    const cooled = await f.client.prepare({ budgetMs: 1000 });
    assert.equal(cooled.available, false); assert.equal(cooled.state, 'failed'); assert.equal(f.launches(), 1);
    const encoded = await f.client.encode(['query'], { role: 'query', budgetMs: 500 });
    assert.equal(encoded.ok, false); assert.equal(f.launches(), 1);
    // Still broken after the cooldown: one more attempt, still no throw, backoff grows.
    f.advance(1);
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, false);
    assert.equal(f.launches(), 2);
    f.advance(retryMs * 2 - 1);
    assert.equal((await f.client.prepare({ budgetMs: 1000 })).available, false); assert.equal(f.launches(), 2);
    // Assets repaired: the next attempt after the (doubled) cooldown starts a working worker.
    f.fixAssets();
    f.advance(1);
    const recovered = await f.client.prepare({ budgetMs: 5000 });
    assert.equal(recovered.available, true, 'recovered without restart()');
    assert.equal(f.launches(), 3);
    const result = await f.client.encode(['中文'], { role: 'query', budgetMs: 1000 });
    assert.equal(result.ok, true); assert.equal(result.modelFingerprint, fingerprint);
    assert.equal(f.client.stats().faultRetries, 2);
  } finally { await f.close(); }
});

test('S10 a worker that passes warmup but dies on its first real encode keeps doubling its cooldown', async () => {
  const retryMs = 300;
  const f = runtimeFixture({ retryMs, worker: crashAfterWarmupWorker });
  const crashOnce = async () => {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true, 'warmup passes');
    const encoded = await f.client.encode(['query'], { role: 'query', budgetMs: 1000 });
    assert.equal(encoded.ok, false, 'the real encode fails instead of throwing');
    for (let i = 0; i < 100 && f.client.descriptor().state !== 'failed'; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.client.descriptor().state, 'failed');
  };
  try {
    await crashOnce();
    assert.equal(f.launches(), 1);
    f.advance(retryMs);
    await crashOnce();
    assert.equal(f.launches(), 2, 'first cooldown is the base interval');
    // Before the fix warmup reset the streak, so this second cooldown was the base interval again (restart twice a minute forever).
    f.advance(retryMs * 2 - 1);
    const cooled = await f.client.prepare({ budgetMs: 1000 });
    assert.equal(cooled.available, false);
    assert.equal(f.launches(), 2, 'second cooldown is at least twice the base interval');
    f.advance(1);
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    assert.equal(f.launches(), 3);
  } finally { await f.close(); }
});

test('S10 a worker that stayed up for the stable window has its streak forgiven before the next failure', async () => {
  const retryMs = 300;
  const f = runtimeFixture({ retryMs, worker: crashAfterWarmupWorker, stableMs: 0 });
  try {
    for (let round = 1; round <= 3; round += 1) {
      assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
      assert.equal((await f.client.encode(['query'], { role: 'query', budgetMs: 1000 })).ok, false);
      for (let i = 0; i < 100 && f.client.descriptor().state !== 'failed'; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(f.launches(), round);
      // Forgiven each time, so every cooldown stays at the base interval.
      f.advance(retryMs);
    }
  } finally { await f.close(); }
});
