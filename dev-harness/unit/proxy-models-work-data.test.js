'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const { functionBlock, constBlock, sliceBlock, bracedBlock } = require('../lib/source-slice');
const sourceDir = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const source = fs.readFileSync(process.env.RUYI_PROXY_CACHE_SOURCE || path.join(sourceDir, '13-http-router.js'), 'utf8');
const chain = functionBlock(fs.readFileSync(path.join(sourceDir, '00-boot.js'), 'utf8'), 'runKeyedChain');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-proxy-cache-unit-'));
const keys = [];
after(() => { keys.forEach(key => key.fill(0)); assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-proxy-cache-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
const plain = value => JSON.parse(JSON.stringify(value));
const privateError = error => String(error?.code || '').startsWith('work_data');
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'cache-'));
  const state = { enabled: false, key: crypto.randomBytes(32), instance: 'proxy-cache-unit', missing: false, unlocks: 0, writes: 0, reads: 0, failWrite: false, ioError: false, proxy: [] };
  keys.push(state.key);
  const disk = { ...fsp, readFile: async (...args) => { state.reads++; if (state.ioError) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fsp.readFile(...args); },
    stat: async (...args) => { if (state.ioError) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fsp.stat(...args); } };
  const fx = loadWorkDataChunks({ fsp: disk });
  fx.store.Hooks.keys = { unlock: async () => { state.unlocks++; if (state.missing) throw Object.assign(new Error('missing'), { code: 'work_data_key.absent' }); return state.key; }, instance: async () => state.instance };
  const sandbox = { require, Buffer, process, console, path, crypto, fsp: disk, WorkDataStore: fx.store, paths: { data: dir },
    proxyModelsCacheMemo: null, proxyModelsCacheMemoState: null, proxyModelsCacheChains: new Map(),
    readConfig: async () => { if (state.switchError) throw new Error('unknown switch'); return { workDataEncryptionV1: state.enabled }; },
    atomicWriteJson: async (...args) => { state.writes++; if (state.writeGate) await state.writeGate; if (state.failWrite) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); return fx.atomicWriteJson(...args); },
    fetchProxyModels: async () => state.proxy };
  const constants = ['MODEL_PRESETS', 'MODEL_TIER_LABEL', 'MODEL_TIER_USE', 'CLAUDE_ALIAS_IDS'];
  const names = ['proxyModelsCacheFailure', 'proxyModelsCacheStore', 'readProxyModelsCache', 'getProxyModelsCache', 'setProxyModelsCache', 'offlineModelList', 'modelCapabilityTier', 'buildModelHint', 'tierModelForNode', 'resolveNodeModel', 'discoverModels'];
  const code = chain + '\n' + sliceBlock(source, 'const PROXY_MODELS_CACHE_PATH', 'let proxyModelsCacheMemo') + '\n' + constants.map(name => constBlock(source, name)).join('\n') + '\n' + names.map(name => functionBlock(source, name)).join('\n');
  vm.runInNewContext(code + '\nglobalThis.api={' + names.join(',') + '};', sandbox);
  return { state, api: sandbox.api, file: path.join(dir, 'proxy-models-cache.json'), sandbox,
    bytes: () => fs.readFileSync(path.join(dir, 'proxy-models-cache.json'), 'utf8'),
    raw: text => { fs.writeFileSync(path.join(dir, 'proxy-models-cache.json'), text); },
    seal: text => fx.store.createText({ file: () => path.join(dir, 'proxy-models-cache.json'), purpose: 'cache', schema: 1, scopeId: 'global', recordId: 'proxy-models-cache', chunked: true, maxPlaintextBytes: 256 * 1024 * 1024, enabled: async () => true, writeJson: fx.atomicWriteJson }).write(text) };
}

test('OFF preserves exact pretty bytes, normalization, cap50, no-op contents and no key creation', async () => {
  const f = fixture(); assert.deepEqual(plain(await f.api.getProxyModelsCache()), { at: '', models: [] }); assert.equal(fs.existsSync(f.file), false);
  await f.api.setProxyModelsCache([{ id: ' one ', label: 'One' }, { id: 'one', label: 'duplicate' }, ...Array.from({ length: 70 }, (_, i) => ({ id: 'm' + i }))]);
  const data = JSON.parse(f.bytes()); assert.equal(data.models.length, 50); assert.equal(data.models[0].id, 'one'); assert.equal(data.models[0].label, 'One');
  assert.equal(f.bytes(), JSON.stringify(data, null, 2)); assert.equal(f.state.unlocks, 0);
  const before = f.bytes(), writes = f.state.writes; await f.api.setProxyModelsCache(data.models); assert.equal(f.bytes(), before); assert.equal(f.state.writes, writes);
});

test('plain memo invalidates on external replace/delete and ordinary I/O or invalid JSON stays a cache miss', async () => {
  const f = fixture(); f.raw(JSON.stringify({ at: 'legacy', models: [{ id: 7, label: 8 }, null, { id: '' }], legacyExtra: true }));
  assert.deepEqual(plain(await f.api.getProxyModelsCache()), { at: 'legacy', models: [{ id: '7', label: '8' }] });
  const reads = f.state.reads; await f.api.getProxyModelsCache(); assert.equal(f.state.reads, reads);
  f.raw(JSON.stringify({ at: 'changed', models: [{ id: 'second-model' }] })); assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'second-model');
  f.raw('{'); assert.equal((await f.api.getProxyModelsCache()).models.length, 0);
  f.state.ioError = true; assert.equal((await f.api.getProxyModelsCache()).models.length, 0); f.state.ioError = false;
  fs.unlinkSync(f.file); assert.equal((await f.api.getProxyModelsCache()).models.length, 0);
});

test('ON reads old plaintext without migration then seals a large whole cache with purpose cache', async () => {
  const f = fixture(); await f.api.setProxyModelsCache([{ id: 'legacy-id' }]); const before = f.bytes(); f.state.enabled = true;
  assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'legacy-id'); assert.equal(f.bytes(), before);
  await f.api.setProxyModelsCache([{ id: 'private-account-model', label: 'PRIVATE_LABEL' + '私'.repeat(400000) }]);
  const header = JSON.parse(f.bytes().split('\n')[0]); assert.equal(header.workData, 3); assert.equal(header.purpose, 'cache'); assert.equal(header.manifest.purpose, 'cache');
  assert.ok(!f.bytes().includes('private-account-model')); assert.ok((await f.api.getProxyModelsCache()).models[0].label.length > 400000);
});

test('warm sealed cache never bypasses current missing key, instance binding, or master authority', async () => {
  const f = fixture(); f.state.enabled = true; await f.api.setProxyModelsCache([{ id: 'PRIVATE_ID' }]);
  assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'PRIVATE_ID'); const unlocks = f.state.unlocks;
  await f.api.getProxyModelsCache(); assert.ok(f.state.unlocks > unlocks); const before = f.bytes();
  f.state.missing = true;
  await assert.rejects(f.api.getProxyModelsCache(), privateError); await assert.rejects(f.api.setProxyModelsCache([{ id: 'replacement' }]), privateError);
  f.state.proxy = [{ id: 'live-new' }]; await assert.rejects(f.api.discoverModels({}), privateError); assert.equal(f.bytes(), before);
  f.state.missing = false; f.state.instance = 'other-instance'; await assert.rejects(f.api.getProxyModelsCache(), privateError);
  f.state.instance = 'proxy-cache-unit'; const original = f.state.key; f.state.key = crypto.randomBytes(32); keys.push(f.state.key);
  await assert.rejects(f.api.getProxyModelsCache(), privateError); f.state.key = original;
  assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'PRIVATE_ID');
});

test('ON plain warm memo still checks key/instance authority and unknown switch never means OFF', async () => {
  const f = fixture(); await f.api.setProxyModelsCache([{ id: 'old-plain' }]); await f.api.getProxyModelsCache(); f.state.enabled = true; f.state.missing = true;
  await assert.rejects(f.api.getProxyModelsCache(), privateError); assert.ok(f.bytes().includes('old-plain'));
  f.state.missing = false; await f.api.getProxyModelsCache(); f.state.switchError = true;
  await assert.rejects(f.api.getProxyModelsCache(), privateError);
});

test('validly sealed invalid shape, truncated files and disabled writes never empty/overwrite ciphertext', async () => {
  const f = fixture(); f.state.enabled = true; await f.api.setProxyModelsCache([{ id: 'original' }]); const original = f.bytes();
  for (const malformed of [original.slice(0, -10), '{"workData":3,"manifest":']) {
    f.raw(malformed); await assert.rejects(f.api.getProxyModelsCache(), privateError); await assert.rejects(f.api.setProxyModelsCache([{ id: 'new' }]), privateError); assert.equal(f.bytes(), malformed);
  }
  f.raw(original); await f.seal(JSON.stringify({ at: '', models: [{ id: 'bad', label: {} }] })); const invalid = f.bytes();
  await assert.rejects(f.api.getProxyModelsCache(), privateError); await assert.rejects(f.api.setProxyModelsCache([{ id: 'new' }]), privateError); assert.equal(f.bytes(), invalid);
  f.raw(original); f.state.enabled = false; assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'original');
  await assert.rejects(f.api.setProxyModelsCache([{ id: 'no-downgrade' }]), privateError); assert.equal(f.bytes(), original);
  f.state.missing = true; await assert.rejects(f.api.getProxyModelsCache(), privateError);
});

test('failed atomic writes publish no new memo and preserve prior plain/sealed disk', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(); f.state.enabled = enabled; await f.api.setProxyModelsCache([{ id: 'old' }]); const before = f.bytes();
    f.state.failWrite = true; await f.api.setProxyModelsCache([{ id: 'uncommitted' }]);
    assert.equal(f.bytes(), before); assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'old');
  }
});

test('concurrent refreshes serialize and a waiting read cannot see an uncommitted memo', async () => {
  const f = fixture(); await f.api.setProxyModelsCache([{ id: 'old' }]);
  let release; f.state.writeGate = new Promise(resolve => { release = resolve; });
  const first = f.api.setProxyModelsCache([{ id: 'first' }]);
  while (f.state.writes < 2) await new Promise(resolve => setTimeout(resolve, 1));
  let observed = false; const read = f.api.getProxyModelsCache().then(value => { observed = true; return value; });
  const second = f.api.setProxyModelsCache([{ id: 'second' }]); await new Promise(resolve => setImmediate(resolve)); assert.equal(observed, false);
  release(); await first; assert.equal((await read).models[0].id, 'first'); await second; assert.equal((await f.api.getProxyModelsCache()).models[0].id, 'second');
});

test('offline list/hint discovery await cache and pure tier/resolve preserve engine boundaries from supplied snapshot', async () => {
  const f = fixture(); await f.api.setProxyModelsCache([{ id: 'claude-cache-max', label: 'Private Max' }]);
  const config = { knownModels: ['qwen-flash', 'claude-cache-max'], extraModels: [], model: '', agentAutoModelTiering: true };
  const cache = await f.api.getProxyModelsCache();
  assert.equal(f.api.tierModelForNode('exec', 'openai', config, { models: [] }, cache), 'qwen-flash');
  assert.equal(f.api.resolveNodeModel('explicit', '', 'exec', 'openai', config, {}, cache), 'explicit');
  assert.equal(f.api.resolveNodeModel('', '', 'exec', 'openai', config, {}, cache), 'qwen-flash');
  assert.equal(f.api.resolveNodeModel('', '', 'exec', 'claude', config, {}, cache), '');
  const hint = await f.api.buildModelHint(config, { models: [] }); assert.ok(hint.includes('Claude 引擎节点')); assert.ok(hint.includes('claude-cache-max'));
  f.state.proxy = [{ id: 'fresh-proxy' }]; const discovered = await f.api.discoverModels(config); assert.equal(discovered.proxyCount, 1); assert.ok(discovered.models.some(model => model.id === 'fresh-proxy'));
});
test('proposal cache await precedes every mutation and closing/cap guards remain after the await', async () => {
  const f = fixture(); f.state.enabled = true; await f.api.setProxyModelsCache([{ id: 'cache-model' }]);
  const workflow = fs.readFileSync(path.join(path.dirname(process.env.RUYI_PROXY_CACHE_SOURCE || path.join(sourceDir, '13-http-router.js')), '09-workflow.js'), 'utf8');
  const block = bracedBlock(workflow, 'const proposeTaskImpl ='); assert.ok(block.includes('await getProxyModelsCache'));
  const run = { id: 'run', nodes: [], taskPool: [] }, runtime = { closing: false };
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const sandbox = { config: { agentAutoModelTiering: true }, poolPolicy: 'auto-capped', runtime, run,
    getProxyModelsCache: async () => { entered = true; await gate; return f.api.getProxyModelsCache(); } };
  const propose = vm.runInNewContext(block + ';proposeTaskImpl;', sandbox);
  const pending = propose('parent', { task: 'new proposal' }); assert.equal(entered, true); assert.equal(run.taskPool.length, 0);
  runtime.closing = true; release(); const closed = await pending;
  assert.equal(closed.ok, false); assert.ok(closed.error.includes('收尾')); assert.equal(run.taskPool.length, 0); assert.equal(run.nodes.length, 0);
  runtime.closing = false; f.state.missing = true; const denied = await propose('parent', { task: 'no-key proposal' });
  assert.equal(denied.ok, false); assert.equal(denied.error, 'missing'); assert.equal(run.taskPool.length, 0);
});

test('approval cache await is followed by live/stop/item validation before synchronous materialization', async () => {
  const f = fixture(); f.state.enabled = true; await f.api.setProxyModelsCache([{ id: 'cache-model' }]);
  const route = fs.readFileSync(path.join(path.dirname(process.env.RUYI_PROXY_CACHE_SOURCE || path.join(sourceDir, '13-http-router.js')), '13d-core-domain-routes.js'), 'utf8');
  const body = sliceBlock(route, '      const { runId, live, item, config, cwd, roleLibrary } = poolContext;', '    })();');
  assert.ok(body.includes('await ProxyModelHooks.read')); const run = { nodes: [] }, live = { run, stopRequested: false }, item = { status: 'proposed' };
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const sandbox = { action: 'approve', poolContext: { runId: 'run', live, item, config: { agentAutoModelTiering: true }, cwd: root, roleLibrary: new Map() },
    activeAgentRuns: new Map([['run', live]]), ProxyModelHooks: { read: async () => { await gate; return f.api.getProxyModelsCache(); } },
    materializePoolItem: () => { calls++; throw new Error('must not materialize'); } };
  const execute = vm.runInNewContext('(async()=>{' + body + '})', sandbox), pending = execute();
  live.stopRequested = true; release(); const denied = await pending;
  assert.equal(denied.reason, 'run_state_changed'); assert.equal(calls, 0); assert.equal(item.status, 'proposed'); assert.equal(run.nodes.length, 0);
  live.stopRequested = false; f.state.missing = true; await assert.rejects(execute(), privateError); assert.equal(calls, 0); assert.equal(item.status, 'proposed');
});
