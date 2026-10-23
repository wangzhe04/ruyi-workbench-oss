'use strict';
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const { constBlock } = require('../lib/source-slice');
const source = fs.readFileSync(process.env.RUYI_WORK_DATA_STORE_SOURCE || path.resolve(__dirname, '../../ruyi-workbench/app/src/01p-work-data-store.js'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-key-scopes-unit-'));
const masters = [];
after(() => { masters.forEach(key => key.fill(0)); assert.ok(path.basename(root).startsWith('ruyi-key-scopes-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
const privateError = error => String(error?.code || '').startsWith('work_data');
function fixture() {
  const fx = loadWorkDataChunks(), dir = fs.mkdtempSync(path.join(root, 'scope-'));
  const state = { key: crypto.randomBytes(32), instanceId: 'key-scope-unit', enabled: true, acquires: 0, releases: 0, sourceKeys: [], usedKeys: [], writes: 0, legacyUnlocks: 0, legacyInstances: 0 };
  masters.push(state.key);
  const cryptoSpy = { ...fx.crypto, seal: (...args) => { state.usedKeys.push(args[1]); return fx.crypto.seal(...args); }, open: (...args) => { state.usedKeys.push(args[1]); return fx.crypto.open(...args); } };
  const chunksSpy = { ...fx.chunks, sealFactory: (...args) => { state.usedKeys.push(args[1]); return fx.chunks.sealFactory(...args); }, openLines: (...args) => { state.usedKeys.push(args[1]); return fx.chunks.openLines(...args); } };
  const store = vm.runInNewContext(constBlock(source, 'WorkDataStore') + '\nWorkDataStore;', { require, Buffer, console, WorkDataCrypto: cryptoSpy, WorkDataChunks: chunksSpy });
  const keys = { snapshot: async () => {
    state.acquires++; if (state.acquireError) throw state.acquireError;
    const key = Buffer.from(state.key), instanceId = state.instanceId; state.sourceKeys.push(key);
    return { key, instanceId, release: async () => { state.releases++; if (!state.releaseBeforeZeroError) key.fill(0); if (state.releaseError) throw state.releaseError; } };
  }, unlock: async () => { throw new Error('native snapshot must be preferred'); }, instance: async () => { throw new Error('native snapshot must be preferred'); } };
  const legacy = { unlock: async () => { state.legacyUnlocks++; return state.key; }, instance: async () => { state.legacyInstances++; if (state.onInstance) await state.onInstance(); return state.instanceId; } };
  const writeJson = async (...args) => { state.writes++; if (state.onWrite) await state.onWrite(); if (state.writeError) throw state.writeError; return fx.atomicWriteJson(...args); };
  const binding = { purpose: 'memory', schema: 1, scopeId: 'global', recordId: 'scoped-record' };
  const host = extra => ({ file: () => path.join(dir, 'record.json'), ...binding, keys, enabled: async () => state.enabled, writeJson, ...extra });
  const text = extra => store.createText(host({ chunked: true, maxPlaintextBytes: 256 * 1024 * 1024, validateSealedText: async value => { if (state.onValidate) await state.onValidate(value); return !state.invalidText; }, ...extra }));
  return { state, store, keys, legacy, text, host, fx, binding, file: path.join(dir, 'record.json'), bytes: () => fs.readFileSync(path.join(dir, 'record.json'), 'utf8'), reset: () => { state.acquires = 0; state.releases = 0; state.usedKeys = []; state.sourceKeys = []; },
    assertReleased: () => { assert.equal(state.releases, state.acquires); for (const key of state.usedKeys) assert.ok(key.equals(Buffer.alloc(32))); } };
}

test('OFF plain read/write does no snapshot/unlock and preserves exact original bytes', async () => {
  const f = fixture(); f.state.enabled = false; f.state.acquireError = new Error('must not acquire');
  const store = f.text(); await store.write('OFF_ORIGINAL_BYTES'); assert.equal(await store.read(), 'OFF_ORIGINAL_BYTES'); assert.equal(f.bytes(), 'OFF_ORIGINAL_BYTES');
  assert.equal(f.state.acquires, 0); assert.equal(f.state.releases, 0);
});

test('one lazy native snapshot owns an entire chunks guard+write and is released exactly once', async () => {
  const f = fixture(), originalKey = Buffer.from(f.state.key), store = f.text(); await store.write('old'); f.reset();
  f.state.onValidate = () => { f.state.sourceKeys.forEach(key => key.fill(0)); f.state.key = crypto.randomBytes(32); masters.push(f.state.key); f.state.instanceId = 'replacement-instance'; };
  await store.write('new'); assert.equal(f.state.acquires, 1); f.assertReleased(); assert.ok(f.state.usedKeys.length >= 2); assert.ok(f.state.usedKeys.every(key => key === f.state.usedKeys[0]));
  const header = JSON.parse(f.bytes().split('\n')[0]); assert.equal(header.instanceId, 'key-scope-unit');
  assert.equal(await f.fx.chunks.openLines((async function* () { yield* f.bytes().trimEnd().split('\n'); })(), originalKey,
    { ...f.binding, instanceId: 'key-scope-unit', seq: 1 }, 256 * 1024 * 1024), 'new'); originalKey.fill(0);
});

test('v2 plaintext upgrade and createJson old-state validation share guard/read/encode operation snapshots', async () => {
  const f = fixture(); await f.text({ chunked: false }).write('v2 old'); f.reset(); await f.text().write('v3 new'); assert.equal(f.state.acquires, 1); f.assertReleased();
  fs.unlinkSync(f.file); const json = f.store.createJson(f.host({ schemaVersion: 1, defaultValue: () => ({ schema: 1, entries: [] }), validate: value => value.schema === 1 && Array.isArray(value.entries) }));
  await json.write({ schema: 1, entries: ['old'] }); f.reset(); await json.write({ schema: 1, entries: ['new'] });
  assert.equal(f.state.acquires, 1); f.assertReleased(); assert.ok(f.state.usedKeys.length >= 2); assert.ok(f.state.usedKeys.every(key => key === f.state.usedKeys[0]));
});

test('legacy customkeys copy before await-instance and cleanup never zeros provider-owned memory', async () => {
  const f = fixture(), expected = Buffer.from(f.state.key); f.state.onInstance = () => { f.state.key.fill(0); };
  await f.text({ keys: f.legacy, chunked: false }).write('legacy key owner');
  const envelope = JSON.parse(f.bytes()), plaintext = f.fx.crypto.open(Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'workData')), expected,
    { ...f.binding, instanceId: 'key-scope-unit', seq: 1 }); assert.equal(plaintext, 'legacy key owner'); assert.equal(f.state.legacyUnlocks, 1);
  f.state.onInstance = null; f.state.key = expected; masters.push(expected); const before = Buffer.from(expected);
  assert.equal(await f.text({ keys: f.legacy, chunked: false }).read(), 'legacy key owner'); assert.ok(expected.equals(before)); before.fill(0);
  for (const key of f.state.usedKeys) assert.ok(key.equals(Buffer.alloc(32)));
});

test('bad sealed input, validator rejection and key acquisition failure never overwrite or retain a lease', async () => {
  const f = fixture(), store = f.text(); await store.write('old'); const original = f.bytes(); f.reset(); f.state.invalidText = true;
  await assert.rejects(store.read(), privateError); f.assertReleased();
  await assert.rejects(store.write('new'), privateError); assert.equal(f.bytes(), original); f.assertReleased();
  f.state.invalidText = false; f.state.acquireError = Object.assign(new Error('missing'), { code: 'work_data_key.absent' });
  await assert.rejects(store.write('must not overwrite'), { code: 'work_data_key.absent' }); assert.equal(f.bytes(), original);
});

test('release failure still zeroes operation copies; abort preserves its primary error and prior disk', async () => {
  const f = fixture(), store = f.text(); await store.write('old'); const original = f.bytes(); f.reset();
  f.state.releaseError = new Error('synthetic release failure'); f.state.releaseBeforeZeroError = true;
  await assert.rejects(store.read(), { code: 'work_data_store.snapshot_release' });
  for (const key of f.state.usedKeys) assert.ok(key.equals(Buffer.alloc(32)));
  f.state.writeError = Object.assign(new Error('synthetic aborted write'), { code: 'ABORT_ERR' });
  await assert.rejects(store.write('new'), { code: 'ABORT_ERR' }); assert.equal(f.bytes(), original);
  for (const key of f.state.usedKeys) assert.ok(key.equals(Buffer.alloc(32)));
  f.state.sourceKeys.forEach(key => key.fill(0));
});

test('native-only Hooks and transparent snapshot facades support idempotent release and legacy mock Hooks', async () => {
  const f = fixture(); f.store.Hooks.keys = { snapshot: f.keys.snapshot };
  const facade = { snapshot: () => f.store.acquireSnapshot(f.store.requireKeys()), unlock: () => f.store.requireKeys().unlock(), instance: () => f.store.requireKeys().instance() };
  await f.text({ keys: facade }).write('native facade'); assert.equal(f.state.acquires, 1); f.assertReleased();
  const lease = await f.store.acquireSnapshot(facade); const owned = lease.key; await lease.release(); await lease.release(); assert.ok(owned.equals(Buffer.alloc(32))); assert.equal(f.state.acquires, 2); assert.equal(f.state.releases, 2);
  f.store.Hooks.keys = f.legacy; assert.equal(await f.text({ keys: facade }).read(), 'native facade'); assert.ok(!f.state.key.equals(Buffer.alloc(32)));
});

test('OFF existing sealed read authenticates but downgrade guard refuses without acquiring a key', async () => {
  const f = fixture(), store = f.text(); await store.write('old sealed'); const before = f.bytes(); f.reset(); f.state.enabled = false;
  await assert.rejects(store.write('plain downgrade'), { code: 'work_data_store.downgrade_refused' }); assert.equal(f.state.acquires, 0); assert.equal(f.bytes(), before);
  assert.equal(await store.read(), 'old sealed'); assert.equal(f.state.acquires, 1); f.assertReleased();
});
