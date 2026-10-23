'use strict';
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock, functionBlock } = require('../lib/source-slice');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const sourceDir = process.env.RUYI_WORK_DATA_SCOPE_SOURCE_DIR || path.resolve(__dirname, '../../ruyi-workbench/app/src');
const source = name => fs.readFileSync(path.join(sourceDir, name), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-key-owner-paths-')), masters = [];
after(() => { masters.forEach(key => key.fill(0)); assert.ok(path.basename(root).startsWith('ruyi-key-owner-paths-')); fs.rmSync(root, { recursive: true, force: true }); });
const names02 = ['sessionBodyCodec', 'sessionBodyWriteText', 'sessionJournalFailure', 'sessionJournalRecordCandidate', 'decodeSessionJournalText', 'sessionJournalStamp', 'sessionJournalAppendState', 'noteSessionJournalAppend', 'repairSealedSessionJournalTail', 'appendProtectedSessionJournal', 'encodeSessionJournalReplacement', 'readSessionBodyFile', 'sessionArtifactCredential', 'sessionArtifactStamp', 'sessionArtifactStore'];
const names07 = ['agentRunSnapshotCredential', 'agentRunSnapshotStamp', 'agentRunSnapshotStore'];
function fixture() {
  const fx = loadWorkDataChunks(), dir = fs.mkdtempSync(path.join(root, 'owner-'));
  const state = { key: crypto.randomBytes(32), instanceId: 'owner-unit', enabled: true, acquires: 0, releases: 0, leaseKeys: [], writes: 0 };
  masters.push(state.key);
  const keys = { snapshot: async () => {
    state.acquires++; if (state.acquireError) throw state.acquireError;
    const key = Buffer.from(state.key); state.leaseKeys.push(key);
    return { key, instanceId: state.instanceId, release: () => { state.releases++; key.fill(0); } };
  } };
  const io = { ...fsp, readFile: async (...args) => { const value = await fsp.readFile(...args); if (state.afterRead) await state.afterRead(); return value; }, appendFile: async (...args) => { if (state.appendError) throw state.appendError; return fsp.appendFile(...args); } };
  const records = vm.runInNewContext(constBlock(fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/01q-work-data-records.js'), 'utf8'), 'WorkDataRecords') + '\nWorkDataRecords;', { require, Buffer, WorkDataCrypto: fx.crypto });
  const store = vm.runInNewContext(constBlock(source('01p-work-data-store.js'), 'WorkDataStore') + '\nWorkDataStore;', { require, Buffer, WorkDataCrypto: fx.crypto, WorkDataChunks: fx.chunks }); store.Hooks.keys = keys;
  const functions = names02.map(name => functionBlock(source('02-session-store.js'), name)).concat(names07.map(name => functionBlock(source('07-autonomy.js'), name)));
  functions.forEach(fn => assert.ok(fn.length > 40));
  const context = { require, Buffer, console, crypto, setTimeout, path, fsp: io, WorkDataStore: store, WorkDataRecords: records, workDataKeys: keys,
    readConfig: async () => ({ workDataEncryptionV1: state.enabled }), atomicWriteJson: async (...args) => { state.writes++; return fx.atomicWriteJson(...args); }, safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    safeSessionId: value => String(value), agentRunFile: (sid, rid) => path.join(dir, sid + '-' + rid + '.json'),
    sessionBodyPerfStats: { bodyReads: 0 }, sessionBodyStamp: stat => stat && [stat.size, stat.mtimeNs, stat.ino].join('|'), SESSION_HEAD_READ_RETRIES: 0,
    EventStreamHooks: {}, sessionJournalAppendStates: new Map(), SESSION_BODY_READ_TRANSIENT: new Set(['EPERM', 'EACCES', 'EBUSY']),
  };
  const api = vm.runInNewContext(functions.join('\n') + '\n({' + names02.concat(names07).join(',') + '})', context);
  return { ...api, state, dir, keys, fx, records, store, context, file: kind => path.join(dir, 'sid.' + kind + '.ndjson'), reset: () => { state.acquires = 0; state.releases = 0; state.leaseKeys = []; }, released: () => { assert.equal(state.releases, state.acquires); state.leaseKeys.forEach(key => assert.ok(key.equals(Buffer.alloc(32)))); } };
}
const encoded = (f, text, kind = 'messages', ordinal = 0) => f.records.encodeLine(text, f.state.key, { instanceId: f.state.instanceId, sessionId: 'sid', kind, ordinal });

test('body writers and readers preserve OFF bytes without touching keys and release one lease for multiple encoded rows', async () => {
  const f = fixture(), rows = ['{"role":"user","content":"one"}', '{"role":"assistant","content":"two"}']; f.state.enabled = false;
  assert.equal(await f.sessionBodyWriteText(f.file('messages'), rows), rows.join('\n') + '\n'); assert.equal(f.state.acquires, 0);
  await fsp.writeFile(f.file('messages'), rows.join('\n') + '\n'); assert.equal((await f.readSessionBodyFile(f.file('messages'))).entries.length, 2); assert.equal(f.state.acquires, 0);
  f.state.enabled = true; const sealed = await f.sessionBodyWriteText(f.file('messages'), rows); f.released(); assert.equal(f.state.acquires, 1);
  await fsp.writeFile(f.file('messages'), sealed); f.reset(); const result = await f.readSessionBodyFile(f.file('messages')); assert.equal(result.entries[1].content, 'two'); f.released(); assert.equal(f.state.acquires, 1);
});

test('body parse failures, authentication failures and torn/empty early returns release only acquired leases', async () => {
  const f = fixture(); await fsp.writeFile(f.file('messages'), encoded(f, '{"ok":1}') + '\nnot-json\n');
  assert.equal((await f.readSessionBodyFile(f.file('messages'))).corrupt, true); f.released(); assert.equal(f.state.acquires, 1);
  f.reset(); const wrong = encoded(f, '{"ok":2}', 'provider'); await fsp.writeFile(f.file('messages'), wrong + '\n');
  assert.equal((await f.readSessionBodyFile(f.file('messages'))).locked, true); f.released(); assert.equal(f.state.acquires, 1);
  f.reset(); await fsp.writeFile(f.file('messages'), '\n'); assert.equal((await f.readSessionBodyFile(f.file('messages'))).corrupt, true); assert.equal(f.state.acquires, 0);
  await fsp.writeFile(f.file('messages'), 'torn only'); assert.equal((await f.readSessionBodyFile(f.file('messages'))).tornAt, 0); assert.equal(f.state.acquires, 0);
});

test('journal decoding lazily owns one lease, borrows supplied credentials, and releases on corrupt committed rows', async () => {
  const f = fixture(), row = encoded(f, '{"id":"one"}', 'changes'), raw = row + '\n';
  assert.equal(await f.decodeSessionJournalText('sid', 'changes', raw), '{"id":"one"}\n'); f.released(); assert.equal(f.state.acquires, 1);
  f.reset(); const credential = await f.store.acquireSnapshot(f.keys); assert.equal(await f.decodeSessionJournalText('sid', 'changes', raw, false, credential), '{"id":"one"}\n'); assert.equal(f.state.acquires, 1); assert.equal(f.state.releases, 0); await credential.release(); f.released();
  f.reset(); await assert.rejects(f.decodeSessionJournalText('sid', 'changes', raw + encoded(f, '{"id":"bad"}', 'changes', 0) + '\n'), error => error.code === 'work_data_record.ordinal_mismatch'); f.released();
  f.reset(); assert.equal(await f.decodeSessionJournalText('sid', 'changes', '{"w":2,"e":', true), '{"w":2,"e":'); assert.equal(f.state.acquires, 0);
});

test('journal append guard and encode share a lease across await/clear, failures release and OFF never unlocks', async () => {
  const f = fixture(), original = Buffer.from(f.state.key), file = f.file('changes'); await fsp.writeFile(file, encoded(f, '{"id":"old"}', 'changes') + '\n');
  f.state.afterRead = () => { f.state.leaseKeys.forEach(key => key.fill(0)); f.state.key = crypto.randomBytes(32); masters.push(f.state.key); f.state.instanceId = 'replacement'; f.state.afterRead = null; };
  assert.equal(await f.appendProtectedSessionJournal(file, 'sid', 'changes', '{"id":"new"}\n'), true); f.released(); assert.equal(f.state.acquires, 1);
  assert.equal(f.records.decodeBody(await fsp.readFile(file, 'utf8'), original, { instanceId: 'owner-unit', sessionId: 'sid', kind: 'changes' }), '{"id":"old"}\n{"id":"new"}\n'); original.fill(0);
  f.state.enabled = false; f.reset(); await assert.rejects(f.appendProtectedSessionJournal(file, 'sid', 'changes', '{}\n'), error => error.code === 'work_data.journal_downgrade_refused'); assert.equal(f.state.acquires, 0);
  await fsp.unlink(file); f.state.enabled = true; f.reset(); f.state.appendError = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }); await assert.rejects(f.appendProtectedSessionJournal(file, 'sid', 'changes', '{}\n'), { code: 'ABORT_ERR' }); f.released();
});

test('journal replacement owns guard+encode credential and fails closed before repair for missing keys', async () => {
  const f = fixture(), file = f.file('interventions'); await fsp.writeFile(file, encoded(f, '{"id":"old"}', 'interventions') + '\n');
  const text = await f.encodeSessionJournalReplacement(file, 'sid', 'interventions', '{"id":"replacement"}\n'); f.released(); assert.equal(f.state.acquires, 1);
  assert.equal(f.records.decodeBody(text, f.state.key, { instanceId: f.state.instanceId, sessionId: 'sid', kind: 'interventions' }), '{"id":"replacement"}\n');
  const old = await fsp.readFile(file); f.state.acquireError = Object.assign(new Error('missing key'), { code: 'work_data_key.absent' }); await assert.rejects(f.appendProtectedSessionJournal(file, 'sid', 'interventions', '{}\n'), { code: 'work_data_key.absent' }); assert.ok((await fsp.readFile(file)).equals(old));
});

test('session artifact and run snapshot facades retain source stamps while releasing native leases after read/write', async () => {
  for (const kind of ['session', 'run']) {
    const f = fixture(), metadata = {}, file = path.join(f.dir, 'artifact.json');
    const store = kind === 'session' ? f.sessionArtifactStore(file, 'sessions', 'session-index', text => Array.isArray(JSON.parse(text)), metadata) : f.agentRunSnapshotStore('sid', 'run_one', metadata);
    const value = kind === 'session' ? '[]' : JSON.stringify({ id: 'run_one', sessionId: 'sid', nodes: [] });
    await store.write(value); assert.ok(metadata.authStamp.startsWith('owner-unit:')); f.released(); assert.equal(f.state.acquires, 1);
    const stamp = metadata.authStamp; f.reset(); await store.write(value); f.released(); assert.equal(f.state.acquires, 1); assert.equal(metadata.authStamp, stamp);
    f.reset(); assert.equal(await store.read(), value); f.released(); assert.equal(f.state.acquires, 1);
    f.reset(); const current = kind === 'session' ? await f.sessionArtifactStamp() : await f.agentRunSnapshotStamp(); assert.equal(current, stamp); f.released();
    f.reset(); f.state.acquireError = Object.assign(new Error('missing key'), { code: 'work_data_key.absent' }); await assert.rejects(store.read(), { code: 'work_data_key.absent' });
  }
});

test('pretender warm facts revalidate a released stamp and retain source identity invalidation', async () => {
  const f = fixture(), runtime = { dirtySessions: new Set() }, sources = new Map([['sid', { sourceStamp: 'unchanged', authStamp: 'old-key-identity' }]]);
  const check = vm.runInNewContext(functionBlock(source('13e-pretender-index.js'), 'pretenderCheckRunSourceAuth') + '\npretenderCheckRunSourceAuth;', { pretenderRunSourceAuth: sources, pretenderIndexRuntime: runtime, agentRunSnapshotStamp: f.agentRunSnapshotStamp });
  await check(); assert.deepEqual([...runtime.dirtySessions], ['sid']); f.released(); assert.equal(f.state.acquires, 1); assert.equal(sources.get('sid').sourceStamp, 'unchanged');
});
