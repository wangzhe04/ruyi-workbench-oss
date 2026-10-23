'use strict';
// Source runtime units. Real local filesystem/crypto; Windows DPAPI for ON.
// No provider, server listener or product data file is changed.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const repo = process.env.JOURNAL_REPO || path.resolve(__dirname, '../..');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-checkpoint-unit-'));
const workspace = path.join(root, 'workspace'), data = path.join(root, 'data'); fs.mkdirSync(workspace);
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), data));
const app = path.join(repo, 'ruyi-workbench/app'), src = path.join(app, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json')));
const names = ['WorkDataStore', 'workDataKeys', 'readConfig', 'writeConfig', 'createSession', 'saveSession', 'loadSession', 'paths',
  'journalDir', 'journalReadIndex', 'journalReadIndexForWrite', 'journalWriteIndex', 'journalRecord', 'journalRecordMany', 'journalDropEntries', 'journalGc',
  'journalReadBefore', 'journalGzipStore', 'journalJsonStore', 'journalRollback', 'journalRevertLogRead', 'journalRevertLogRecord', 'journalRevertNoticesPeek',
  'journalRevertNoticesAck', 'journalRevertLogPrune', 'writeHistorySnapshot', 'rehydrateObservation', 'materializeCheckpointEditorDiff', 'rewindSession',
  'journalWriteChains', 'journalRevertChains', 'sessionWriteChains', 'flushSessionIndex', 'journalTrimProtectedSnapshots',
  'journalGlobalSweepOnce', 'buildMissionResult', 'journalByteEstimate: () => journalGlobalBytes'];
const runtimes = [];
function load() {
  const mod = new Module(path.join(app, 'server.js'), module); mod.filename = path.join(app, 'server.js'); mod.paths = Module._nodeModulePaths(app);
  const text = manifest.modules.map(row => {
    const candidate = path.join(__dirname, 'src', row.file);
    return fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(src, row.file), 'utf8');
  }).join('\n');
  mod._compile(text + '\nmodule.exports.__journal = {' + names.join(',') + '};', mod.filename);
  runtimes.push(mod.exports.__journal); return mod.exports.__journal;
}
const api = load(), workError = error => String(error && error.code || '').startsWith('work_data');
const toggle = async (flag, target = api) => { const config = await target.readConfig(); config.workDataEncryptionV1 = flag; await target.writeConfig(config); };
const keyFile = path.join(data, 'work-data-key-v1.json');
const win = { skip: process.platform !== 'win32' && 'real DPAPI Windows only' };
async function enable() { await toggle(true); const key = await api.workDataKeys.ensure(); key.fill(0); }
async function session(title) { return api.createSession({ title, cwd: workspace }); }
const beforeFile = (sid, turn, entry) => path.join(api.journalDir(sid), `${turn}-${entry}.gz`);
const indexFile = sid => path.join(api.journalDir(sid), 'index.json');
const revertFile = sid => path.join(api.journalDir(sid), 'reverts.json');
async function settle() {
  for (const runtime of runtimes) {
    await Promise.all([...runtime.journalWriteChains.values(), ...runtime.journalRevertChains.values(), ...runtime.sessionWriteChains.values()].map(p => p.catch(() => {})));
    await runtime.flushSessionIndex();
  }
}
after(async () => {
  await settle(); for (const runtime of runtimes) runtime.workDataKeys.clear();
  assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true });
});

test('OFF checkpoint artifacts retain exact compact JSON and native gzip bytes without creating keys', async () => {
  await toggle(false); const s = await session('OFF journal');
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xd6, 0xd0, 0xce, 0xc4, 13, 10, 0, 255]);
  const file = path.join(workspace, 'off.txt'); fs.writeFileSync(file, bytes);
  assert.equal((await api.journalRecord(s.id, 1, 'file_write', file, 'modify', bytes)).ok, true);
  const rows = await api.journalReadIndex(s.id);
  assert.equal(fs.readFileSync(indexFile(s.id), 'utf8'), JSON.stringify(rows));
  assert.deepEqual(fs.readFileSync(beforeFile(s.id, 1, 0)), zlib.gzipSync(bytes));
  assert.deepEqual(await api.journalReadBefore(s.id, 1, 0), bytes);
  await api.journalRevertLogRecord(s.id, [{ ...rows[0], path: file }]);
  const reverts = await api.journalRevertLogRead(s.id);
  assert.equal(fs.readFileSync(revertFile(s.id), 'utf8'), JSON.stringify({ schema: 1, items: reverts }));
  const history = [{ role: 'tool', content: 'OFF 历史😀' }], raw = JSON.stringify(history);
  assert.equal(await api.writeHistorySnapshot(s.id, 1, history, false), 'history:1');
  assert.deepEqual(fs.readFileSync(path.join(api.journalDir(s.id), 'history-1.json.gz')), zlib.gzipSync(Buffer.from(raw)));
  assert.equal(fs.existsSync(keyFile), false);
});

test('ordinary legacy damage preserves strict-index quarantine, lenient reverts and malformed-gzip failure', async () => {
  await toggle(false); const s = await session('bad legacy'); fs.mkdirSync(api.journalDir(s.id), { recursive: true });
  fs.writeFileSync(indexFile(s.id), '{broken');
  assert.deepEqual(await api.journalReadIndexForWrite(s.id), []);
  assert.ok(fs.readdirSync(api.journalDir(s.id)).some(name => name.startsWith('index.json.corrupt-')));
  fs.writeFileSync(revertFile(s.id), '{broken'); assert.deepEqual(await api.journalRevertLogRead(s.id), []);
  fs.writeFileSync(beforeFile(s.id, 1, 0), Buffer.from([0x1f, 0x8b, 8, 0]));
  await assert.rejects(api.journalReadBefore(s.id, 1, 0), error => !workError(error));
  const valid = zlib.gzipSync('replacement'); await api.journalGzipStore(s.id, '1-0.gz').write(valid);
  assert.deepEqual(fs.readFileSync(beforeFile(s.id, 1, 0)), valid);
});

test('valid gzip containing literal workData JSON is binary legacy, never UTF8 marker guessed', win, async () => {
  await enable(); const s = await session('gzip marker'); fs.mkdirSync(api.journalDir(s.id), { recursive: true });
  const value = Buffer.from('{"workData":3,"secret":"SYNTHETIC-GZIP-MARKER"}');
  const gz = zlib.gzipSync(value, { level: 0 }); assert.ok(gz.includes(Buffer.from('"workData":3')));
  fs.writeFileSync(beforeFile(s.id, 1, 0), gz);
  assert.deepEqual(await api.journalReadBefore(s.id, 1, 0), value);
  await api.journalGzipStore(s.id, '1-0.gz').write(gz);
  assert.equal(JSON.parse(fs.readFileSync(beforeFile(s.id, 1, 0), 'utf8').split('\n')[0]).workData, 3);
  assert.deepEqual(await api.journalReadBefore(s.id, 1, 0), value);
});

test('ON index/reverts/binary/history survive cold keys with exact bytes and bound stable references', win, async () => {
  await enable(); const s = await session('sealed checkpoint');
  const bytes = Buffer.concat([Buffer.from('GBK\r\n'), crypto.randomBytes(1300 * 1024)]), file = path.join(workspace, 'sealed.bin');
  fs.writeFileSync(file, 'after');
  assert.equal((await api.journalRecord(s.id, 3, 'file_write', file, 'modify', bytes)).ok, true);
  const row = (await api.journalReadIndex(s.id))[0]; await api.journalRevertLogRecord(s.id, [{ ...row, path: file }]);
  const content = 'PRIVATE-历史😀'.repeat(4000) + crypto.randomBytes(1100 * 1024).toString('base64');
  const history = [{ role: 'tool', content, tool_call_id: 'tool-1' }];
  const snapshot = await api.writeHistorySnapshot(s.id, 3, history, true);
  assert.match(snapshot, /^history:3:[a-f0-9]{16}$/);
  const ref = snapshot + ':0:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const carriers = [indexFile(s.id), revertFile(s.id), beforeFile(s.id, 3, 0), path.join(api.journalDir(s.id), snapshot.replaceAll(':', '-') + '.json.gz')];
  for (const carrier of carriers) {
    const raw = fs.readFileSync(carrier, 'utf8'); assert.equal(JSON.parse(raw.split('\n')[0]).workData, 3);
    assert.equal(raw.includes(file), false); assert.equal(raw.includes('PRIVATE-历史'), false);
  }
  api.workDataKeys.clear(); const cold = load();
  assert.equal((await cold.journalReadIndex(s.id))[0].path, file);
  assert.deepEqual(await cold.journalReadBefore(s.id, 3, 0), bytes);
  assert.equal((await cold.journalRevertNoticesPeek(s.id)).length, 1);
  assert.equal((await cold.rehydrateObservation(s.id, ref)).content, content);
  const rolled = await cold.journalRollback(s.id, 3, 0); assert.equal(rolled.ok, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal((await cold.journalRollback(s.id, 3, 0)).error, 'no entries');
});

test('cross-session/record ciphertext and tampered prior index fail without reset, quarantine or new plaintext', win, async () => {
  await enable(); const s = await session('binding A'), other = await session('binding B');
  const file = path.join(workspace, 'binding.txt');
  assert.equal((await api.journalRecord(s.id, 4, 'file_write', file, 'modify', 'private before')).ok, true);
  const original = fs.readFileSync(indexFile(s.id)); fs.mkdirSync(api.journalDir(other.id), { recursive: true });
  fs.writeFileSync(indexFile(other.id), original); await assert.rejects(api.journalReadIndex(other.id), workError);
  fs.writeFileSync(beforeFile(s.id, 4, 1), fs.readFileSync(beforeFile(s.id, 4, 0)));
  await assert.rejects(api.journalReadBefore(s.id, 4, 1), workError);
  fs.writeFileSync(revertFile(s.id), original); await assert.rejects(api.journalRevertLogRead(s.id), workError);
  const corrupt = original.subarray(0, original.length - 1); fs.writeFileSync(indexFile(s.id), corrupt);
  assert.equal((await api.journalRecord(s.id, 4, 'file_write', file, 'modify', 'do not store')).ok, false);
  assert.deepEqual(fs.readFileSync(indexFile(s.id)), corrupt);
  assert.equal(fs.readdirSync(api.journalDir(s.id)).some(name => name.includes('.corrupt-')), false);
  assert.equal(fs.existsSync(beforeFile(s.id, 4, 2)), false);
});

test('missing keys refuse create unlink and before restore before any workspace mutation; OFF downgrade also preflights', win, async () => {
  await enable(); const s = await session('missing keys');
  const created = path.join(workspace, 'keep-created.txt'), modified = path.join(workspace, 'keep-modified.txt');
  fs.writeFileSync(created, 'must keep created'); fs.writeFileSync(modified, 'must keep current');
  assert.equal((await api.journalRecord(s.id, 5, 'file_write', modified, 'modify', 'old original')).ok, true);
  assert.equal((await api.journalRecord(s.id, 5, 'file_write', created, 'create', null)).ok, true);
  const original = fs.readFileSync(indexFile(s.id)); await settle();
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.held');
  try {
    await assert.rejects(api.journalRollback(s.id, 5), workError);
    await assert.rejects(api.buildMissionResult(s), workError, 'locked index is not persisted as an empty rollback projection');
    assert.equal(fs.readFileSync(created, 'utf8'), 'must keep created');
    assert.equal(fs.readFileSync(modified, 'utf8'), 'must keep current');
    assert.deepEqual(fs.readFileSync(indexFile(s.id)), original);
  } finally { fs.renameSync(keyFile + '.held', keyFile); }
  await toggle(false);
  await assert.rejects(api.journalRollback(s.id, 5), workError);
  assert.equal(fs.readFileSync(created, 'utf8'), 'must keep created');
  assert.equal(fs.readFileSync(modified, 'utf8'), 'must keep current');
  assert.deepEqual(fs.readFileSync(indexFile(s.id)), original);
});

test('binary probe tolerates short reads and seal/old guard share one owned snapshot, releasing after writer failure', async () => {
  const target = path.join(root, 'binary-owned-snapshot.gz'), master = crypto.randomBytes(32);
  const gz = zlib.gzipSync(Buffer.from('BINARY OWNED SNAPSHOT'));
  fs.writeFileSync(target, gz);
  const originalOpen = fsp.open;
  fsp.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (String(file) !== target) return handle;
    const read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 1), position);
    return handle;
  };
  let calls = 0, releases = 0, activeProviderCopy;
  const keys = { snapshot: async () => {
    calls++; const key = Buffer.from(master); activeProviderCopy = key;
    return { key, instanceId: 'a'.repeat(32), release: () => { releases++; key.fill(0); } };
  } };
  let failWrite = false, destroyProviderCopy = false;
  const host = {
    file: () => target, purpose: 'session', scopeId: 'binary-test', recordId: '1-0.gz', schema: 1,
    enabled: async () => true, keys, chunked: true, maxBinaryBytes: 8 * 1024 * 1024, maxPlaintextBytes: 8 * 1024 * 1024,
    validateLegacyBinary: bytes => { zlib.gunzipSync(bytes); return true; },
    writeJson: async (file, factory, options) => {
      if (failWrite) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      if (destroyProviderCopy) activeProviderCopy.fill(0);
      const parts = []; for await (const part of factory()) parts.push(Buffer.from(part));
      fs.writeFileSync(file, Buffer.concat(parts));
    },
  };
  const store = api.WorkDataStore.createBinary(host);
  try { assert.deepEqual(await store.read(), gz); } finally { fsp.open = originalOpen; }
  assert.equal(calls, 0, 'complete ordinary gzip does not unlock a key');
  await store.write(gz); assert.equal(calls, 1); assert.equal(releases, 1);
  calls = releases = 0; destroyProviderCopy = true;
  await store.write(gz); assert.equal(calls, 1, 'old guard and new encoding use one snapshot'); assert.equal(releases, 1);
  assert.deepEqual(await store.read(), gz); assert.equal(calls, 2); assert.equal(releases, 2);
  const previous = fs.readFileSync(target); calls = releases = 0; failWrite = true;
  await assert.rejects(store.write(gz), { code: 'EIO' });
  assert.equal(calls, 1); assert.equal(releases, 1); assert.ok(activeProviderCopy.every(byte => byte === 0));
  assert.deepEqual(fs.readFileSync(target), previous);
});

test('rewind authenticates reverts and every selected before image before files or conversation are truncated', win, async () => {
  await enable(); const s = await session('rewind preflight');
  s.messages = [{ role: 'user', content: 'one', turnSeq: 1 }, { role: 'assistant', content: 'first', turnSummary: { turnSeq: 1 } },
    { role: 'user', content: 'two', turnSeq: 2 }, { role: 'assistant', content: 'second', turnSummary: { turnSeq: 2 } }];
  s.turnSeq = 2; await api.saveSession(s);
  const file = path.join(workspace, 'rewind-preflight.txt'); fs.writeFileSync(file, 'current');
  assert.equal((await api.journalRecord(s.id, 1, 'file_write', file, 'modify', 'first original')).ok, true);
  assert.equal((await api.journalRecord(s.id, 2, 'file_write', file, 'modify', 'second original')).ok, true);
  await api.journalRevertLogRecord(s.id, [{ path: file, op: 'modify', turnSeq: 2, entrySeq: 0 }]);
  const badFile = beforeFile(s.id, 1, 0), originalBefore = fs.readFileSync(badFile);
  fs.writeFileSync(badFile, originalBefore.subarray(0, originalBefore.length - 1));
  const head = fs.readFileSync(path.join(data, 'sessions', s.id + '.json'));
  const index = fs.readFileSync(indexFile(s.id)), reverts = fs.readFileSync(revertFile(s.id));
  await assert.rejects(api.rewindSession(s.id, 1, true), workError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'current', 'newer valid turn did not restore before older selected auth failed');
  assert.deepEqual(fs.readFileSync(path.join(data, 'sessions', s.id + '.json')), head);
  assert.deepEqual(fs.readFileSync(indexFile(s.id)), index); assert.deepEqual(fs.readFileSync(revertFile(s.id)), reverts);
  fs.writeFileSync(badFile, originalBefore);
  fs.writeFileSync(revertFile(s.id), reverts.subarray(0, reverts.length - 1));
  await assert.rejects(api.rewindSession(s.id, 1, false), workError);
  assert.deepEqual(fs.readFileSync(path.join(data, 'sessions', s.id + '.json')), head);
});

test('sealed retention keeps twenty turns, one hundred revert groups and newest four histories; repeated history bytes use net delta', win, async () => {
  await enable(); const s = await session('retention contracts'); const file = path.join(workspace, 'retention.txt');
  for (let turn = 1; turn <= 22; turn++) assert.equal((await api.journalRecord(s.id, turn, 'file_edit', file, 'modify', 'old-' + turn)).ok, true);
  const index = await api.journalReadIndex(s.id); assert.equal(index.length, 20); assert.equal(index[0].turnSeq, 3);
  assert.equal(fs.existsSync(beforeFile(s.id, 1, 0)), false); assert.equal(fs.existsSync(beforeFile(s.id, 3, 0)), true);
  await api.journalRevertLogRecord(s.id, Array.from({ length: 105 }, (_, i) => ({ path: file, turnSeq: i + 1, entrySeq: 0, op: 'modify' })));
  const reverted = await api.journalRevertLogRead(s.id); assert.equal(reverted.length, 100); assert.equal(reverted[0].turnSeq, 6);
  await api.journalRevertNoticesAck(s.id, reverted.slice(0, 10).map(row => row.seq));
  assert.equal((await api.journalRevertNoticesPeek(s.id)).length, 90);
  const history = [{ role: 'tool', content: 'history-repeat' }];
  const ref = await api.writeHistorySnapshot(s.id, 23, history, true); await settle();
  const firstSize = fs.statSync(path.join(api.journalDir(s.id), ref.replaceAll(':', '-') + '.json.gz')).size;
  const estimate = api.journalByteEstimate();
  assert.equal(await api.writeHistorySnapshot(s.id, 23, history, true), ref); await settle();
  assert.equal(api.journalByteEstimate(), estimate, 'same-size sealed overwrite is a net zero payload delta');
  assert.equal(fs.statSync(path.join(api.journalDir(s.id), ref.replaceAll(':', '-') + '.json.gz')).size, firstSize);
  for (let i = 0; i < 5; i++) await api.writeHistorySnapshot(s.id, 24 + i, [{ role: 'tool', content: 'history-' + i }], true);
  await settle(); await api.journalTrimProtectedSnapshots(api.journalDir(s.id), Infinity);
  assert.equal(fs.readdirSync(api.journalDir(s.id)).filter(name => name.startsWith('history-')).length, 4);
  assert.equal(fs.existsSync(beforeFile(s.id, 3, 0)), true, 'history trim never deletes rollback original');
});

test('a changed original after preflight is reported per-file and retains retry index; earlier successful rollback stays explicit', win, async () => {
  await enable(); const s = await session('external substitution');
  const first = path.join(workspace, 'substitution-first.txt'), second = path.join(workspace, 'substitution-second.txt');
  fs.writeFileSync(first, 'current-first'); fs.writeFileSync(second, 'current-second');
  await api.journalRecord(s.id, 30, 'file_edit', first, 'modify', 'old-first');
  await api.journalRecord(s.id, 30, 'file_edit', second, 'modify', 'old-second');
  const target = beforeFile(s.id, 30, 0), originalOpen = fsp.open; let reads = 0, substituted = false;
  fsp.open = async function(file, ...args) {
    if (String(file) === target && ++reads === 4) {
      substituted = true; // three opens authenticated preflight; now before actual restore reopens
      await api.journalGzipStore(s.id, '30-0.gz').write(zlib.gzipSync('externally changed original'));
    }
    return originalOpen.call(this, file, ...args);
  };
  let result;
  try { result = await api.journalRollback(s.id, 30); } finally { fsp.open = originalOpen; }
  assert.equal(substituted, true); assert.equal(result.ok, true);
  assert.equal(result.reverted.length, 1); assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /work_data\.journal_snapshot_changed/);
  assert.equal(fs.readFileSync(second, 'utf8'), 'old-second');
  assert.equal(fs.readFileSync(first, 'utf8'), 'current-first');
  assert.deepEqual((await api.journalReadIndex(s.id)).map(row => row.entrySeq), [0]);
});

test('global retention measures real sealed bytes and preserves the active writer while over engineering test cap', win, async () => {
  await enable(); await settle();
  const previous = process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES;
  process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES = String(100 * 1024);
  let capped;
  try { capped = load(); } finally {
    if (previous === undefined) delete process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES; else process.env.RUYI_JOURNAL_GLOBAL_MAX_BYTES = previous;
  }
  const old = path.join(data, 'checkpoints', 'sess_gc_old'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'index.json'), '[]'); fs.writeFileSync(path.join(old, 'old.gz'), crypto.randomBytes(120 * 1024));
  const stale = new Date('2000-01-01'); fs.utimesSync(old, stale, stale);
  const s = await capped.createSession({ title: 'protected writer', cwd: workspace });
  const original = crypto.randomBytes(65 * 1024), file = path.join(workspace, 'gc-before.bin');
  assert.equal((await capped.journalRecord(s.id, 1, 'file_edit', file, 'modify', original)).ok, true);
  await capped.journalGlobalSweepOnce(s.id);
  assert.equal(fs.existsSync(old), false, 'actual over-cap sweep prunes oldest checkpoint tree');
  assert.equal(fs.existsSync(capped.journalDir(s.id)), true, 'current writer is protected even if ciphertext alone exceeds cap');
  assert.deepEqual(await capped.journalReadBefore(s.id, 1, 0), original);
  const onDisk = fs.statSync(path.join(capped.journalDir(s.id), '1-0.gz')).size;
  assert.ok(onDisk > 100 * 1024, 'cipher representation expansion is counted as real bytes, not original binary length');
  assert.ok(capped.journalByteEstimate() >= onDisk);
});
