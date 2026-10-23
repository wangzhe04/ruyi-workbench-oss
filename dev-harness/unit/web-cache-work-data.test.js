'use strict';
// Source runtime: exercise real cache helpers, chunk crypto and atomic writes before generation.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { functionBlock, constBlock } = require('../lib/source-slice');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-web-cache-data-unit-'));
const master = crypto.randomBytes(32), source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/11-native-tools.js'), 'utf8');
let serial = 0;
function fixture() {
  const codec = loadWorkDataChunks(), dir = path.join(root, String(++serial));
  const state = { enabled: false, missing: false, unlocks: 0, instanceId: 'web-cache-unit' }, events = [];
  codec.store.Hooks.keys = { unlock: async () => {
    state.unlocks++;
    if (state.missing) throw Object.assign(new Error('work_data_key.absent'), { code: 'work_data_key.absent' });
    return master;
  }, instance: async () => state.instanceId };
  const names = ['webCachePath', 'webCacheStore', 'readWebCache', 'writeWebCache', 'evictWebCacheOverCap'];
  const code = names.map(name => functionBlock(source, name)).join('\n') + '\n' + constBlock(source, 'WEB_CACHE_HARD_MAX_ENTRIES');
  const api = vm.runInNewContext(code + '\n({' + names.join(',') + '})', {
    crypto, path, fsp, Buffer, process, WorkDataStore: codec.store,
    paths: { webcache: dir }, atomicWriteJson: codec.atomicWriteJson,
    readConfig: async () => ({ workDataEncryptionV1: state.enabled }), logEvent: event => events.push(event),
  });
  return { ...api, codec, state, events, dir };
}
const entry = url => ({ url, title: 'SYNTHETIC-PRIVATE-TITLE', text: '多语言😀\n'.repeat(80000), ts: '2026-10-23T00:00:00Z' });
const workError = error => String(error && error.code || '').startsWith('work_data');
after(() => { master.fill(0); fs.rmSync(root, { recursive: true, force: true }); });

test('OFF preserves exact compact cache bytes, large text and zero key access', async () => {
  const f = fixture(), value = entry('https://synthetic.invalid/off');
  await f.writeWebCache(value);
  assert.equal(fs.readFileSync(f.webCachePath(value.url), 'utf8'), JSON.stringify(value));
  assert.equal(JSON.stringify(await f.readWebCache(value.url)), JSON.stringify(value));
  assert.equal(f.state.unlocks, 0);
});

test('ON hides URL/title/body and reads a complete multi-chunk entry even after disabling', async () => {
  const f = fixture(), value = entry('https://synthetic.invalid/sealed'); f.state.enabled = true;
  await f.writeWebCache(value);
  const raw = fs.readFileSync(f.webCachePath(value.url), 'utf8'), header = JSON.parse(raw.split('\n')[0]);
  assert.equal(header.workData, 3); assert.equal(header.purpose, 'cache');
  for (const sensitive of [value.url, value.title, '多语言']) assert.equal(raw.includes(sensitive), false);
  assert.equal(JSON.stringify(await f.readWebCache(value.url)), JSON.stringify(value));
  f.state.enabled = false;
  assert.equal((await f.readWebCache(value.url)).text, value.text);
  await f.writeWebCache({ ...value, text: 'replacement' });
  assert.equal(fs.readFileSync(f.webCachePath(value.url), 'utf8'), raw);
  assert.equal(f.events.at(-1).reason, 'work_data_store.downgrade_refused');
});

test('absent keys, swapped URLs/instances and truncated cache records never become misses or get overwritten', async () => {
  const f = fixture(), value = entry('https://synthetic.invalid/bound'); f.state.enabled = true;
  await f.writeWebCache(value);
  const target = f.webCachePath(value.url), raw = fs.readFileSync(target, 'utf8');
  f.state.missing = true;
  await assert.rejects(() => f.readWebCache(value.url), workError);
  await f.writeWebCache({ ...value, text: 'must not overwrite' });
  assert.equal(fs.readFileSync(target, 'utf8'), raw);
  const fresh = { ...value, url: value.url + '/new' };
  await f.writeWebCache(fresh); assert.equal(fs.existsSync(f.webCachePath(fresh.url)), false);
  assert.ok(f.events.every(event => !JSON.stringify(event).includes(value.url)));
  f.state.missing = false;
  const other = value.url + '/other'; fs.copyFileSync(target, f.webCachePath(other));
  await assert.rejects(() => f.readWebCache(other), workError);
  f.state.instanceId = 'another-instance'; await assert.rejects(() => f.readWebCache(value.url), workError);
  f.state.instanceId = 'web-cache-unit';
  for (const broken of [raw.slice(0, -25), raw.replace('chunks-v1', 'chunks-v9')]) {
    fs.writeFileSync(target, broken);
    await assert.rejects(() => f.readWebCache(value.url), workError);
    await f.writeWebCache({ ...value, text: 'must not overwrite' });
    assert.equal(fs.readFileSync(target, 'utf8'), broken);
    assert.equal(fs.existsSync(target + '.corrupt'), false);
  }
});

test('authenticated invalid domain payloads fail before cache fallback or replacement; legacy invalid data stays a miss', async () => {
  const f = fixture(), url = 'https://synthetic.invalid/shape'; f.state.enabled = true;
  const target = f.webCachePath(url); fs.mkdirSync(f.dir, { recursive: true });
  const binding = { purpose: 'cache', instanceId: 'web-cache-unit', schema: 1, scopeId: 'global',
    recordId: 'web-cache:' + path.basename(target, '.json'), seq: 1 };
  for (const bad of [{ url, text: null }, { url: url + '/wrong', text: 'secret' }, []]) {
    const factory = f.codec.chunks.sealFactory(JSON.stringify(bad), master, binding, 256 * 1024 * 1024);
    await f.codec.atomicWriteJson(target, factory, { stream: true }); factory.dispose();
    const raw = fs.readFileSync(target, 'utf8');
    await assert.rejects(() => f.readWebCache(url), { code: 'work_data_store.validate' });
    await f.writeWebCache({ url, text: 'new' }); assert.equal(fs.readFileSync(target, 'utf8'), raw);
  }
  for (const plain of ['broken legacy JSON', JSON.stringify({ url, missingText: true })]) {
    fs.writeFileSync(target, plain); assert.equal(await f.readWebCache(url), null);
  }
  f.state.enabled = false; await f.writeWebCache({ url, text: 'legacy recovery' });
  assert.equal((await f.readWebCache(url)).text, 'legacy recovery');
});

test('successful encrypted cache writes retain existing oldest-file pruning', async () => {
  const f = fixture(), previous = process.env.WCW_WEBCACHE_HARD_MAX; f.state.enabled = true;
  process.env.WCW_WEBCACHE_HARD_MAX = '3';
  try {
    for (let i = 0; i < 4; i++) {
      const url = 'https://synthetic.invalid/prune-' + i;
      await f.writeWebCache({ url, text: 'body ' + i });
      fs.utimesSync(f.webCachePath(url), 1e9 + i, 1e9 + i);
    }
    assert.equal(fs.readdirSync(f.dir).length, 3);
    assert.equal(await f.readWebCache('https://synthetic.invalid/prune-0'), null);
    assert.equal((await f.readWebCache('https://synthetic.invalid/prune-3')).text, 'body 3');
  } finally {
    if (previous === undefined) delete process.env.WCW_WEBCACHE_HARD_MAX;
    else process.env.WCW_WEBCACHE_HARD_MAX = previous;
  }
});

test('failed saves do not run pruning, and ordinary I/O still follows the legacy miss contract', async () => {
  const f = fixture(), previous = process.env.WCW_WEBCACHE_HARD_MAX; f.state.enabled = true;
  for (let i = 0; i < 3; i++) await f.writeWebCache({ url: 'https://synthetic.invalid/keep-' + i, text: 'kept' });
  const before = fs.readdirSync(f.dir).sort(); f.state.missing = true;
  process.env.WCW_WEBCACHE_HARD_MAX = '1';
  try {
    await f.writeWebCache({ url: 'https://synthetic.invalid/keep-0', text: 'replacement' });
    assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
    const originalOpen = fsp.open;
    try {
      fsp.open = async () => { throw Object.assign(new Error('I/O fixture'), { code: 'EIO' }); };
      assert.equal(await f.readWebCache('https://synthetic.invalid/keep-0'), null);
    } finally { fsp.open = originalOpen; }
  } finally {
    if (previous === undefined) delete process.env.WCW_WEBCACHE_HARD_MAX;
    else process.env.WCW_WEBCACHE_HARD_MAX = previous;
  }
});
