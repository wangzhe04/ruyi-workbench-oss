'use strict';
// Pure boundary tests: no DPAPI, process spawn or fake encrypted-store acceptance.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { constBlock, functionBlock } = require('../lib/source-slice');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const { requestShape, readObservation, assertSameDirectory } = require('../lib/external-bots-c2/sealed-observer.cjs');
const { assertCompleteRun, inspectSealedRunBytes } = require('../lib/external-bots-c2/sealed-run-contract.cjs');

test('Windows canonical case spelling names the same real directory, while a different physical root never does', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-C2-Observer-Case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const other = path.join(root, 'different-root'); fs.mkdirSync(other);
  assertSameDirectory(root, fs.realpathSync.native(root));
  if (process.platform === 'win32') assertSameDirectory(root.toLowerCase(), root.toUpperCase());
  else assert.throws(() => assertSameDirectory(root.toLowerCase(), root.toUpperCase()));
  assert.throws(() => assertSameDirectory(root, other), /different physical root path/);
  assert.throws(() => assertSameDirectory(root, path.join(root, 'missing')), { code: 'ENOENT' });
});

test('observer accepts only bounded identity-based read operations, never path/write/key/control commands', () => {
  for (const message of [{ id: 1, op: 'ledger' }, { id: 2, op: 'journal', sid: 'session_original-1' },
    { id: 3, op: 'run', sid: 'session_original-1', runId: 'run_original' }]) assert.equal(requestShape(message), message);
  for (const message of [null, [], {}, { id: 0, op: 'ledger' }, { id: 1.1, op: 'ledger' }, { id: 1, op: 'write' },
    { id: 1, op: 'keys' }, { id: 1, op: 'bind' }, { id: 1, op: 'ledger', file: 'other' },
    { id: 1, op: 'journal' }, { id: 1, op: 'journal', sid: '../other' }, { id: 1, op: 'journal', sid: 'a\\b' },
    { id: 1, op: 'journal', sid: 'C:\\other' }, { id: 1, op: 'journal', sid: '' }, { id: 1, op: 'journal', sid: 'a'.repeat(129) },
    { id: 1, op: 'journal', sid: 'good', kind: 'messages' }, { id: 1, op: 'run', sid: 'good' },
    { id: 1, op: 'run', sid: 'good', runId: '../other' }, { id: 1, op: 'run', sid: '../other', runId: 'good' },
    { id: 1, op: 'run', sid: 'good', runId: 'C:\\other' }, { id: 1, op: 'run', sid: 'good', runId: 'good', strict: false },
    { id: 1, op: 'run', sid: 'good', runId: 'a'.repeat(65) }, { id: 1, op: 'run', sid: 'good', runId: 'CoN' },
    { id: 1, op: 'run', sid: '_private', runId: 'good' },
    { id: 1, op: 'run', sid: 'good', runId: 'good', file: 'other' }]) assert.throws(() => requestShape(message));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-c2-observer-pure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  const selected = { root, id: 'a'.repeat(48), mode: 'encrypted', generation: 1, proof: { sha256: 'b'.repeat(64) } };
  const current = structuredClone(selected), calls = [];
  const manifest = { async readActive() { calls.push('manifest'); return structuredClone(current); } };
  const api = { async externalBotReadState() { calls.push('production-ledger-read'); return { items: [{ id: 'original' }] }; },
    async decodeSessionJournalText(sid, kind, raw) { calls.push({ sid, kind, raw }); return '{"id":"decision","status":"answered"}\n'; } };
  return { root, selected, current, manifest, api, calls };
}

test('observer delegates exact selected-root bytes to production decoder and binds ledger reads before and after observation', async t => {
  const f = fixture(t), raw = '{"w":2,"e":"opaque-byte-observation"}\n';
  fs.writeFileSync(path.join(f.root, 'sessions', 'original.interventions.ndjson'), raw);
  assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 1, op: 'journal', sid: 'original' }), [{ id: 'decision', status: 'answered' }]);
  assert.deepEqual(f.calls, ['manifest', { sid: 'original', kind: 'interventions', raw }, 'manifest']);
  f.calls.length = 0;
  assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }), { items: [{ id: 'original' }] });
  assert.deepEqual(f.calls, ['manifest', 'production-ledger-read', 'manifest']);
  if (process.platform === 'win32') {
    f.current.root = f.root.toUpperCase();
    assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 3, op: 'ledger' }), { items: [{ id: 'original' }] });
  }
});

test('missing bytes, locked key, malformed decoded rows and production ledger errors all reject rather than return an empty journal/ledger', async t => {
  const f = fixture(t), request = { id: 1, op: 'journal', sid: 'original' };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), { code: 'ENOENT' });
  fs.writeFileSync(path.join(f.root, 'sessions', 'original.interventions.ndjson'), 'not-plaintext\n');
  f.api.decodeSessionJournalText = async () => { throw Object.assign(Error('locked key'), { code: 'work_data_key.decrypt_failed' }); };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), { code: 'work_data_key.decrypt_failed' });
  f.api.decodeSessionJournalText = async () => 'invalid decoded JSON\n';
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), SyntaxError);
  f.api.externalBotReadState = async () => { throw Object.assign(Error('corrupt ledger'), { code: 'external_channel.storage_unavailable' }); };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }), { code: 'external_channel.storage_unavailable' });
});

test('changed root, mode, generation, id or manifest proof fails before production IO and a change during IO fails before returning facts', async t => {
  for (const field of ['root', 'mode', 'generation', 'id', 'proof']) {
    const f = fixture(t);
    f.current[field] = field === 'generation' ? 2 : field === 'proof' ? { sha256: 'c'.repeat(64) } : 'changed';
    if (field === 'root') { f.current.root = path.join(f.root, 'different-physical-root'); fs.mkdirSync(f.current.root); }
    await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 1, op: 'ledger' }));
    assert.deepEqual(f.calls, ['manifest']);
  }
  const f = fixture(t);
  f.api.externalBotReadState = async () => { f.current.generation++; return { items: [] }; };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }));
});

test('run observation calls only the strict production snapshot reader between both root checks', async t => {
  const f = fixture(t), run = { id: 'run_original', sessionId: 'original', nodes: [{ id: 'helper', attempts: 1, version: 2 }] };
  f.api.readAgentRunSnapshot = async (sid, runId, options) => { f.calls.push({ sid, runId, options }); return run; };
  assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 1, op: 'run', sid: 'original', runId: 'run_original' }), run);
  assert.deepEqual(f.calls, ['manifest', { sid: 'original', runId: 'run_original', options: { strict: true } }, 'manifest']);
  f.api.readAgentRunSnapshot = async () => { f.current.generation++; return run; };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'run', sid: 'original', runId: 'run_original' }));
});

test('run observer never turns reader errors, missing records or wrong payload identities into success', async t => {
  const f = fixture(t), message = { id: 1, op: 'run', sid: 'original', runId: 'run_original' };
  for (const code of ['ENOENT', 'work_data_key.decrypt_failed', 'work_data_chunk.authenticate_failed']) {
    f.api.readAgentRunSnapshot = async () => { throw Object.assign(Error('synthetic failure'), { code }); };
    await assert.rejects(readObservation(f.api, f.selected, f.manifest, message), { code });
  }
  for (const value of [null, [], { id: 'other', sessionId: 'original', nodes: [] },
    { id: 'run_original', sessionId: 'other', nodes: [] }, { id: 'run_original', sessionId: 'original', nodes: {} }]) {
    f.api.readAgentRunSnapshot = async () => value;
    await assert.rejects(readObservation(f.api, f.selected, f.manifest, message));
  }
});

async function runStoreFixture(t) {
  const f = fixture(t), shared = loadWorkDataChunks(), key = crypto.randomBytes(32), instanceId = 'c2-run-unit-instance';
  let locked = false;
  t.after(() => key.fill(0));
  shared.store.Hooks.keys = { async unlock() { if (locked) throw Object.assign(Error('unit key locked'), { code: 'work_data_key.locked' }); return key; }, instance: async () => instanceId };
  const source = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
  const autonomy = source('07-autonomy.js'), config = source('01-config.js');
  const blocks = [constBlock(config, 'RESERVED_SESSION_FILE_IDS'), functionBlock(config, 'safeSessionId'), functionBlock(source('00-boot.js'), 'safeJsonParse'),
    ...['agentRunDir', 'agentRunFile', 'agentRunSnapshotCredential', 'agentRunSnapshotStore', 'readAgentRunSnapshot'].map(name => functionBlock(autonomy, name))];
  assert.ok(blocks.every(Boolean));
  const api = vm.runInNewContext(blocks.join('\n') + ';({agentRunFile,agentRunSnapshotStore,readAgentRunSnapshot});', {
    WorkDataStore: shared.store, atomicWriteJson: shared.atomicWriteJson, readConfig: async () => ({ workDataEncryptionV1: true }),
    path, crypto, paths: { agentRuns: path.join(f.root, 'agent-runs') },
  });
  const sid = 'session_original', runId = 'run_original', run = { id: runId, sessionId: sid, status: 'succeeded', version: 2,
    nodes: [{ id: 'origin', task: 'C2_SOURCE_PRIVATE_中文', status: 'succeeded', attempts: 1 },
      { id: 'helper', task: 'C2_POOL_HELPER', result: 'C2_POOL_HELPER_ACTUAL_CONSUMED', status: 'succeeded', attempts: 1, version: 3 }] };
  const file = api.agentRunFile(sid, runId); fs.mkdirSync(path.dirname(file), { recursive: true });
  await api.agentRunSnapshotStore(sid, runId).write(JSON.stringify(run));
  return { ...f, ...api, sid, runId, run, file, instanceId, lock: () => { locked = true; } };
}

test('real task chunks plus production strict run reader preserve the entire run, nodes, versions and attempts', async t => {
  // Real crypto, text store, atomic writer and exact production run functions.
  // Only this pure test's key source/config are synthetic; this is not DPAPI admission.
  const f = await runStoreFixture(t), bytes = fs.readFileSync(f.file);
  const decoded = await readObservation({ readAgentRunSnapshot: f.readAgentRunSnapshot }, f.selected, f.manifest,
    { id: 1, op: 'run', sid: f.sid, runId: f.runId });
  const observed = JSON.parse(JSON.stringify(decoded)); // mirror the actual IPC/HTTP JSON boundaries
  assertCompleteRun(f.run, observed, f.sid, f.runId);
  const physical = inspectSealedRunBytes(bytes, { sid: f.sid, runId: f.runId, instanceId: f.instanceId,
    forbidden: ['C2_SOURCE_PRIVATE_中文', 'C2_POOL_HELPER', 'C2_POOL_HELPER_ACTUAL_CONSUMED'] });
  assert.equal(physical.purpose, 'task'); assert.equal(physical.encryptedChunks, 1);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  for (const mutate of [r => { r.version++; }, r => { r.nodes[1].attempts++; }, r => { r.nodes[1].result = 'changed'; },
    r => { r.nodes.pop(); }, r => { r.live = true; }]) {
    const altered = structuredClone(f.run); mutate(altered);
    assert.throws(() => assertCompleteRun(altered, observed, f.sid, f.runId));
  }
});

test('wrong physical task binding refuses, and a correct-looking header cannot grant authentication for damaged ciphertext', async t => {
  const f = await runStoreFixture(t), original = fs.readFileSync(f.file, 'utf8'), rows = original.trim().split('\n').map(JSON.parse);
  const options = { sid: f.sid, runId: f.runId, instanceId: f.instanceId, forbidden: ['C2_POOL_HELPER_ACTUAL_CONSUMED'] };
  for (const [key, value] of [['purpose', 'queue'], ['instanceId', 'other'], ['scopeId', 'other'], ['recordId', 'agent-run:other'],
    ['schema', 2], ['seq', 2], ['keyId', 'work-data-v2.k2'], ['format', 'unknown']]) {
    const altered = structuredClone(rows); altered[0][key] = value;
    const bytes = Buffer.from(altered.map(JSON.stringify).join('\n') + '\n');
    assert.throws(() => inspectSealedRunBytes(bytes, options));
    fs.writeFileSync(f.file, bytes);
    await assert.rejects(f.readAgentRunSnapshot(f.sid, f.runId, { strict: true }));
  }
  const damaged = structuredClone(rows), text = damaged[1].e.envelope.ciphertext;
  damaged[1].e.envelope.ciphertext = (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
  const bytes = Buffer.from(damaged.map(JSON.stringify).join('\n') + '\n');
  inspectSealedRunBytes(bytes, options); // structural identity alone is explicitly insufficient
  fs.writeFileSync(f.file, bytes);
  await assert.rejects(f.readAgentRunSnapshot(f.sid, f.runId, { strict: true }), error => String(error.code).startsWith('work_data'));
  fs.writeFileSync(f.file, original);
  f.lock(); await assert.rejects(f.readAgentRunSnapshot(f.sid, f.runId, { strict: true }), { code: 'work_data_key.locked' });
  assert.deepEqual(fs.readFileSync(f.file), Buffer.from(original));
});

test('missing selected run snapshot refuses despite a same-named plaintext fallback in another base', async t => {
  const f = await runStoreFixture(t), base = path.join(f.root, 'stable-base', 'agent-runs', f.sid);
  fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, f.runId + '.json'), JSON.stringify(f.run));
  fs.unlinkSync(f.file);
  await assert.rejects(f.readAgentRunSnapshot(f.sid, f.runId, { strict: true }), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, f.runId + '.json'), 'utf8')), f.run);
});
