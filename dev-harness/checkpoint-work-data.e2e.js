'use strict';
// Actual generated runtime with synthetic isolated data and real Windows DPAPI.
// This file does not source-overlay or copy server.js.
const path = require('node:path'), repo = process.env.JOURNAL_REPO || process.cwd();
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-checkpoint-work-e2e-'));
const data = path.join(root, 'data'), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), data));
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('CHECKPOINT WORK DATA');
const names = ['createSession', 'saveSession', 'readConfig', 'writeConfig', 'workDataKeys', 'toolCall', 'journalDir', 'journalReadIndex',
  'journalRecord', 'journalReadBefore', 'journalRollback', 'journalRevertLogRecord', 'journalRevertNoticesPeek', 'journalRevertNoticesAck',
  'writeHistorySnapshot', 'rehydrateObservation', 'materializeCheckpointEditorDiff', 'journalWriteChains', 'journalRevertChains',
  'sessionWriteChains', 'flushSessionIndex'];
const runtimes = [], load = () => { const runtime = loadServerInternals(names); runtimes.push(runtime); return runtime; };
const workError = error => String(error && error.code || '').startsWith('work_data');
const toggle = async (api, flag) => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
async function settle() {
  for (const api of runtimes) {
    await Promise.all([...api.journalWriteChains.values(), ...api.journalRevertChains.values(), ...api.sessionWriteChains.values()].map(p => p.catch(() => {})));
    await api.flushSessionIndex();
  }
}
(async () => {
  const api = load(); await toggle(api, false);
  const off = await api.createSession({ title: 'OFF CHECKPOINT', cwd: workspace });
  const offFile = path.join(workspace, 'off.bin'), offBefore = Buffer.from([0xff, 0, 0xd6, 0xd0, 13, 10]);
  assert.equal((await api.journalRecord(off.id, 1, 'file_write', offFile, 'modify', offBefore)).ok, true);
  const offIndex = await api.journalReadIndex(off.id);
  assert.equal(fs.readFileSync(path.join(api.journalDir(off.id), 'index.json'), 'utf8'), JSON.stringify(offIndex));
  assert.deepEqual(fs.readFileSync(path.join(api.journalDir(off.id), '1-0.gz')), zlib.gzipSync(offBefore));
  assert.equal(fs.existsSync(path.join(data, 'work-data-key-v1.json')), false);
  t.ok(true, 'OFF keeps exact compact JSON/native gzip bytes and creates no key');
  if (process.platform !== 'win32') { console.log('SKIP real Windows DPAPI checkpoint lifecycle'); return; }

  await toggle(api, true); const provisioned = await api.workDataKeys.ensure(); provisioned.fill(0);
  const session = await api.createSession({ title: 'ON PRIVATE CHECKPOINT', cwd: workspace });
  session.turnSeq = 2; await api.saveSession(session);
  const file = path.join(workspace, 'private-before.bin'), before = crypto.randomBytes(1300 * 1024);
  Buffer.from('BINARY BEFORE\0').copy(before); // deterministic non-BOM prefix; remaining arbitrary bytes stay exact
  fs.writeFileSync(file, before);
  const config = await api.readConfig(); config.permissionMode = 'bypass';
  const written = await api.toolCall('file_write', { path: file, content: 'one actual native file write', encoding: 'utf8', lineEnding: 'preserve' }, {
    sessionId: session.id, session, turnSeq: 2, workingDir: workspace, config, effectivePermissionMode: 'bypass',
  });
  assert.equal((typeof written === 'string' ? JSON.parse(written) : written).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one actual native file write');
  const row = (await api.journalReadIndex(session.id))[0]; assert.equal(row.path, file); assert.equal(row.entrySeq, 0);
  await api.journalRevertLogRecord(session.id, [{ ...row, path: file }]);
  const content = 'PRIVATE Unicode 历史😀'.repeat(4000) + crypto.randomBytes(1100 * 1024).toString('base64');
  const history = [{ role: 'tool', content, tool_call_id: 'physical-tool-1' }];
  const snapshot = await api.writeHistorySnapshot(session.id, 2, history, true); assert.match(snapshot, /^history:2:[a-f0-9]{16}$/);
  const rawRef = snapshot + ':0:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const dir = api.journalDir(session.id), indexFile = path.join(dir, 'index.json'), beforeFile = path.join(dir, '2-0.gz');
  const carriers = [indexFile, beforeFile, path.join(dir, 'reverts.json'), path.join(dir, snapshot.replaceAll(':', '-') + '.json.gz')];
  for (const carrier of carriers) {
    const raw = fs.readFileSync(carrier, 'utf8'); assert.equal(JSON.parse(raw.split('\n')[0]).workData, 3);
    assert.equal(raw.includes('PRIVATE Unicode'), false); assert.equal(raw.includes(file), false);
  }
  assert.ok(fs.statSync(beforeFile).size > 1024 * 1024, 'incompressible original exercises multi-chunk cipher');
  await settle(); api.workDataKeys.clear(); const cold = load();
  assert.deepEqual(await cold.journalReadBefore(session.id, 2, 0), before);
  assert.equal((await cold.rehydrateObservation(session.id, rawRef)).content, content);
  assert.equal((await cold.journalRevertNoticesPeek(session.id)).length, 1);
  t.ok(true, 'actual native write checkpoints arbitrary >1MiB original; sealed history/reverts cold-recover through real DPAPI');

  const indexBytes = fs.readFileSync(indexFile), originalBytes = fs.readFileSync(beforeFile);
  for (const runtime of runtimes) runtime.workDataKeys.clear();
  const keyFile = path.join(data, 'work-data-key-v1.json'); fs.renameSync(keyFile, keyFile + '.held');
  try {
    await assert.rejects(cold.journalReadBefore(session.id, 2, 0), workError);
    await assert.rejects(cold.journalRollback(session.id, 2), workError);
    await assert.rejects(cold.materializeCheckpointEditorDiff(session.id, row, file), workError);
    assert.equal(fs.existsSync(path.join(dir, 'external-diff')), false, 'failed authentication creates no plaintext editor cache');
    assert.equal(fs.readFileSync(file, 'utf8'), 'one actual native file write');
    assert.deepEqual(fs.readFileSync(indexFile), indexBytes); assert.deepEqual(fs.readFileSync(beforeFile), originalBytes);
  } finally { fs.renameSync(keyFile + '.held', keyFile); }
  t.ok(true, 'missing key after warm recovery refuses rollback and editor projection before any mutation/materialization');

  await toggle(cold, false); await assert.rejects(cold.journalRollback(session.id, 2), workError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one actual native file write'); assert.deepEqual(fs.readFileSync(indexFile), indexBytes);
  await toggle(cold, true);
  const result = await cold.journalRollback(session.id, 2); assert.equal(result.ok, true); assert.equal(result.reverted.length, 1);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal((await cold.journalRollback(session.id, 2)).error, 'no entries');
  await cold.journalRevertNoticesAck(session.id, (await cold.journalRevertNoticesPeek(session.id)).map(item => item.seq));
  assert.deepEqual(await cold.journalRevertNoticesPeek(session.id), []);
  t.ok(true, 'OFF downgrade cannot partially restore; ON recovery restores exact original once and durable notice ack survives');
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  try { await settle(); } catch { /* preserve primary verdict */ }
  for (const api of runtimes) api.workDataKeys.clear();
  assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
