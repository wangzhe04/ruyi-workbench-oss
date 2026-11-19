'use strict';
// 150 号文 U10：两个语义开关(「记忆语义检索」runtimeMemoryVectorRecallV1、「本地语义检索增强」semanticRetrievalV1)
// 合成设置页上的一个开关，并在那一行显示本地语义模型此刻的状态(加载中/就绪/冷却中/不可用，与 151 阶段 1A 的冷却退避同口径)。
//   · 设置目录里只剩 semanticRetrievalV1 这一行；拨它一次两个键一起写(catalogPatch)。
//   · 老配置不丢用户选择：没拨过的配置原样生效(normalizeConfig 不改写任何一个键)；只关过记忆那一半的人，
//     状态句如实说「记忆仍只用关键词」，不会被悄悄打开。
//   · 后端 /api/status 的 semanticRuntime 由 13 的 semanticRuntimeStatusView 归成五个稳定态，前端按同一张表出句子。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-semantic-switch-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.RUYI_HOME = home;
const { loadServerInternals } = require('../lib/server-internals');
const app = loadServerInternals(['normalizeConfig', 'memoryVectorRecallEnabled', 'semanticRuntimeStatusView', 'SEMANTIC_STATUS_COOLDOWN_CODES', 'SEMANTIC_STATUS_ASSETS_MISMATCH']);
const normalized = raw => app.normalizeConfig(raw).config;   // normalizeConfig 回 { config, changed, persisted }
const catalogUrl = pathToFileURL(path.join(repo, 'ruyi-workbench/app/public/js/settings-catalog.js')).href;
const zh = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/en-US.json'), 'utf8'));

test('the settings catalog shows one semantic switch and writes both legacy keys', async () => {
  const catalog = await import(catalogUrl);
  const fields = catalog.catalogFields();
  assert.equal(fields.filter(f => f.key === 'runtimeMemoryVectorRecallV1').length, 0, 'the memory-only switch row is gone');
  const field = fields.find(f => f.key === 'semanticRetrievalV1');
  assert.ok(field && field.type === 'toggle' && field.status === 'semanticRuntime');
  assert.deepEqual(catalog.catalogPatch(field, false, {}), { semanticRetrievalV1: false, runtimeMemoryVectorRecallV1: false });
  assert.deepEqual(catalog.catalogPatch(field, true, { semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: false }),
    { semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: true });
});

test('legacy configurations keep the user choice until the merged switch is touched', async () => {
  const catalog = await import(catalogUrl);
  const field = catalog.catalogFields().find(f => f.key === 'semanticRetrievalV1');
  // 只关过记忆那一半：语义检索照开、记忆召回照旧只用关键词 —— 不悄悄打开。
  const memoryOff = normalized({ semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: false });
  assert.equal(memoryOff.semanticRetrievalV1, true);
  assert.equal(memoryOff.runtimeMemoryVectorRecallV1, false);
  assert.equal(app.memoryVectorRecallEnabled(memoryOff), false);
  assert.equal(catalog.catalogDisplayValue(field, memoryOff), true);
  const memoryNote = catalog.semanticSwitchStatus(memoryOff, { state: 'ready' });
  assert.equal(memoryNote.extraKey, 'settings.catalog.semanticRetrievalV1.status.memoryKeywordOnly');
  // 关过语义检索那一半：开关显示关；记忆的离线向量层照旧(不替他改)。
  const semanticOff = normalized({ semanticRetrievalV1: false, runtimeMemoryVectorRecallV1: true });
  assert.equal(semanticOff.semanticRetrievalV1, false);
  assert.equal(app.memoryVectorRecallEnabled(semanticOff), true);
  assert.equal(catalog.catalogDisplayValue(field, semanticOff), false);
  assert.equal(catalog.semanticSwitchStatus(semanticOff, { state: 'ready' }).state, 'off');
  // 默认配置两者都开，没有补充句。
  const fresh = normalized({});
  assert.equal(fresh.semanticRetrievalV1, true);
  assert.equal(app.memoryVectorRecallEnabled(fresh), true);
  assert.equal(catalog.semanticSwitchStatus(fresh, { state: 'loading' }).extraKey, '');
  // 拨一次合并开关之后，两个键一致，记忆那一半跟着开关走。
  const touched = normalized({ ...memoryOff, ...catalog.catalogPatch(field, true, memoryOff) });
  assert.equal(app.memoryVectorRecallEnabled(touched), true);
  assert.equal(catalog.semanticSwitchStatus(touched, { state: 'ready' }).extraKey, '');
  const touchedOff = normalized({ ...memoryOff, ...catalog.catalogPatch(field, false, memoryOff) });
  assert.equal(touchedOff.semanticRetrievalV1, false);
  assert.equal(app.memoryVectorRecallEnabled(touchedOff), false);
});

test('the backend status view maps runtime descriptors onto the five stable states', async () => {
  const { SEMANTIC_RUNTIME_STATES } = await import(catalogUrl);
  const view = (config, descriptor, env = {}) => app.semanticRuntimeStatusView(config, descriptor, env);
  const on = { semanticRetrievalV1: true };
  assert.deepEqual(view({ semanticRetrievalV1: false }, { available: true, state: 'ready' }), { state: 'off' });
  assert.deepEqual(view(on, { available: true, state: 'ready' }, { RUYI_DISABLE_SEMANTIC: '1' }), { state: 'off' });
  assert.deepEqual(view(on, { available: true, state: 'ready' }), { state: 'ready' });
  for (const state of ['cold', 'loading', 'warming']) assert.deepEqual(view(on, { available: false, state }), { state: 'loading' }, state);
  // 06hb 的可用性失败进冷却(到点自动重试)：缺文件、进程观测前退出、预热失败、超时、工作进程退出。
  assert.deepEqual(view(on, { available: false, state: 'failed' }), { state: 'cooldown' });
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.worker_exited' }), { state: 'cooldown' });
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.assets_unavailable' }), { state: 'cooldown', reason: 'assets_missing' });
  // 与锁不一致不会自己好:报 unavailable(不是金色的「冷却中」配一句「不可用、请重装」);每个码只落一个态。
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.gemma2_lock_integrity' }), { state: 'unavailable', reason: 'assets_mismatch' });
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.gemma2_profile_contract' }), { state: 'unavailable', reason: 'assets_mismatch' });
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.gemma2_profile_unavailable' }), { state: 'cooldown', reason: 'assets_missing' });
  for (const code of app.SEMANTIC_STATUS_ASSETS_MISMATCH) assert.equal(app.SEMANTIC_STATUS_COOLDOWN_CODES.has(code), false, 'mismatch code also listed as cooldown: ' + code);
  // 契约违例(06hb startingFailure)要重启或修复。
  assert.deepEqual(view(on, { available: false, state: 'failed', diagnosticCode: 'semantic.ready_contract' }), { state: 'unavailable' });
  assert.deepEqual(view(on, { available: false, state: 'unknown' }), { state: 'unavailable' });
  assert.deepEqual(view(on, null), { state: 'unavailable' }, 'no descriptor at all is not reported as ready or loading');
  // 后端只会吐前端认识的态。
  const produced = new Set(['off', 'ready', 'loading', 'cooldown', 'unavailable']);
  assert.deepEqual([...produced].sort(), [...SEMANTIC_RUNTIME_STATES].sort());
});

test('every status sentence the switch can show exists in both locales', async () => {
  const { semanticSwitchStatus } = await import(catalogUrl);
  const keys = new Set();
  for (const config of [{}, { semanticRetrievalV1: false }, { semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: false }]) {
    for (const runtime of [null, { state: 'off' }, { state: 'loading' }, { state: 'ready' }, { state: 'cooldown' }, { state: 'unavailable' },
      { state: 'cooldown', reason: 'assets_missing' }, { state: 'unavailable', reason: 'assets_mismatch' }]) {
      const out = semanticSwitchStatus(config, runtime);
      keys.add(out.key);
      if (out.extraKey) keys.add(out.extraKey);
    }
  }
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'zh-CN missing ' + key);
    assert.equal(typeof en[key], 'string', 'en-US missing ' + key);
  }
  assert.ok(keys.size >= 9, 'covers off/loading/ready/cooldown/unavailable/assets/host/unknown/memory note');
  for (const key of ['settings.catalog.runtimeMemoryVectorRecallV1', 'settings.catalog.runtimeMemoryVectorRecallV1.hint']) {
    assert.equal(zh[key], undefined, 'orphan label left behind: ' + key);
    assert.equal(en[key], undefined, 'orphan label left behind: ' + key);
  }
});

// 4C 审查应改 1:设置页那一行的跟随只读 /api/status、按访问有界(每 3 s、最多 10 次),不走整份 refreshStatus
// (它连带 GET /api/models,现拉用户远端服务商的 /models)。行为用注入的假 fetch/计时器跑;接线用源码切片钉住。
test('the status follow is bounded per visit and only reads /api/status', async () => {
  const { followSemanticRuntimeStatus, SEMANTIC_STATUS_FOLLOW } = await import(catalogUrl);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const harness = runtimeFor => {
    const queue = [], calls = []; let runtime = null, paints = 0;
    const deps = { fetchStatus: async () => { calls.push('/api/status'); return { semanticRuntime: runtimeFor(calls.length) }; },
      getConfig: () => ({ semanticRetrievalV1: true }), setRuntime: r => { runtime = r; }, visible: () => true,
      paint: () => { paints += 1; }, schedule: fn => queue.push(fn) };
    const drain = async () => { await flush(); while (queue.length) { queue.shift()(); await flush(); } };
    return { deps, queue, calls, drain, get runtime() { return runtime; }, get paints() { return paints; } };
  };
  // 一直冷却:恰好 10 次就停,不再排下一拍。
  const stuck = harness(() => ({ state: 'cooldown', reason: 'assets_missing' }));
  followSemanticRuntimeStatus(stuck.deps);
  await stuck.drain();
  assert.equal(stuck.calls.length, SEMANTIC_STATUS_FOLLOW.maxFetches);
  assert.equal(SEMANTIC_STATUS_FOLLOW.maxFetches, 10);
  assert.equal(stuck.paints, 10);
  assert.ok(stuck.calls.every(path => path === '/api/status'));
  // 第 3 次就绪:就停。
  const settles = harness(n => ({ state: n >= 3 ? 'ready' : 'loading' }));
  followSemanticRuntimeStatus(settles.deps);
  await settles.drain();
  assert.equal(settles.calls.length, 3);
  assert.equal(settles.runtime.state, 'ready');
  // 新的一次访问让上一次排着的那一拍作废(旧访问不再取数)。
  const old = harness(() => ({ state: 'loading' }));
  followSemanticRuntimeStatus(old.deps);
  await flush();
  assert.equal(old.calls.length, 1);
  const next = harness(() => ({ state: 'ready' }));
  followSemanticRuntimeStatus(next.deps);
  await old.drain(); await next.drain();
  assert.equal(old.calls.length, 1, 'superseded visit stops');
  assert.equal(next.calls.length, 1);
  // 页签切走就停。
  let shown = true;
  const away = harness(() => ({ state: 'loading' }));
  followSemanticRuntimeStatus({ ...away.deps, visible: () => shown });
  await flush(); shown = false; await away.drain();
  assert.equal(away.calls.length, 1);
  // 151 phase 4C integration: one failed /api/status read retries on the next tick instead of freezing the line.
  const flaky = harness(n => ({ state: n >= 3 ? 'ready' : 'loading' }));
  const realFetch = flaky.deps.fetchStatus;
  flaky.deps.fetchStatus = async () => { if (flaky.calls.length === 1) { flaky.calls.push('/api/status'); throw Error('network'); } return realFetch(); };
  followSemanticRuntimeStatus(flaky.deps);
  await flaky.drain();
  assert.equal(flaky.runtime && flaky.runtime.state, 'ready', 'a failed read does not end the follow');
  assert.ok(flaky.calls.length <= SEMANTIC_STATUS_FOLLOW.maxFetches);
  // A follow whose every read fails still stops at the per-visit budget.
  const down = harness(() => ({ state: 'loading' }));
  down.deps.fetchStatus = async () => { down.calls.push('/api/status'); throw Error('network'); };
  followSemanticRuntimeStatus(down.deps);
  await down.drain();
  assert.equal(down.calls.length, SEMANTIC_STATUS_FOLLOW.maxFetches);
});

test('the follow is wired to the Advanced tab visit only and never to refreshStatus', () => {
  const { functionBlock } = require('../lib/source-slice');
  const nav = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/navigation-controls.js'), 'utf8');
  const settings = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/provider-settings.js'), 'utf8');
  const sw = functionBlock(nav, 'switchSettingsTab');
  const branch = sw.slice(sw.indexOf("if (name === 'advanced') followSemanticRuntimeStatus({"), sw.indexOf('});', sw.indexOf("if (name === 'advanced') followSemanticRuntimeStatus({")) + 3);
  assert.ok(branch.includes("fetchStatus: () => api('/api/status')"), 'reads /api/status only');
  assert.doesNotMatch(branch, /refreshStatus|refreshModels|\/api\/models|fillSettings/);
  assert.doesNotMatch(settings, /followSemanticRuntimeStatus|semanticStatusFollow/, 'provider-settings no longer arms a follow from every fill');
  assert.doesNotMatch(functionBlock(settings, 'refreshSettingsCatalog'), /refreshStatus|setTimeout/);
});