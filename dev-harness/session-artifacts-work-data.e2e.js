'use strict';
// Run against the actual generated runtime, with an isolated synthetic data root.
// Real Windows DPAPI and filesystem publication/recovery. No key provider or storage-domain stubs.
const path = require('node:path'), repo = process.env.RUYI_SESSION_ARTIFACT_REPO || process.cwd();
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-session-artifact-e2e-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('SESSION ARTIFACT WORK DATA');
const names = ['createSession', 'loadSession', 'saveSession', 'listSessions', 'readConfig', 'writeConfig', 'workDataKeys', 'paths',
  'sessionIndexPath', 'readSessionIndex', 'writeSessionIndex', 'scheduleSessionIndexUpdate', 'flushSessionIndex', 'flushSessionIndexSync', 'invalidateSessionIndex',
  'sessionV1BackupPath', 'sessionV1BackupStore', 'readSessionV1BackupRecord', 'loadSessionV1Backup', 'ensureSessionV1Backup',
  'sessionPath', 'sessionBodyPaths', 'sessionWriteChains', 'withSessionIndexLock', 'pretenderIndexRuntime'];
const runtimes = [], load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error && error.code || '').startsWith('work_data');
const toggle = async (api, flag) => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
function seed(api, id, large = false) {
  const messages = large ? Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '备份😀'.repeat(2500) })) : [{ role: 'user', content: 'PRIVATE-LEGACY-备份😀' }];
  const value = { id, title: 'PRIVATE-LEGACY-TITLE', cwd: root, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', messages, providerHistory: [] };
  const raw = JSON.stringify(value, null, 2) + '\n'; fs.mkdirSync(api.paths.sessions, { recursive: true }); fs.writeFileSync(api.sessionPath(id), raw);
  return { raw, messages };
}
async function settle(api) {
  await Promise.all([...api.sessionWriteChains.values()].map(promise => promise.catch(() => {})));
  await api.flushSessionIndex();
  // A timer may already have taken the pending batch before flushSessionIndex()
  // observes it. Join the same owner chain before a test writes a synthetic index.
  await api.withSessionIndexLock(async () => {});
}

(async () => {
  const api = load(); await toggle(api, false);
  const session = await api.createSession({ cwd: root, title: 'OFF-PRIVATE-索引😀' }); await api.listSessions(); await api.flushSessionIndex();
  const plainIndex = fs.readFileSync(api.sessionIndexPath(), 'utf8'); assert.equal(plainIndex, JSON.stringify(JSON.parse(plainIndex), null, 2));
  const offId = 'sess_backup_e2e_off', off = seed(api, offId); await api.loadSession(offId);
  assert.equal(fs.readFileSync(api.sessionV1BackupPath(offId), 'utf8'), off.raw);
  await api.flushSessionIndex(); await api.listSessions(); await api.flushSessionIndex();
  t.ok(true, 'OFF preserves index pretty JSON and exact pristine v1 backup bytes');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI encrypted artifact lifecycle: Windows only'); return; }
  await toggle(api, true); await api.workDataKeys.ensure();
  // The index remains plaintext from OFF, but this ON session save produces pending sensitive metadata.
  const beforeSync = fs.readFileSync(api.sessionIndexPath()); assert.ok(beforeSync.toString('utf8').startsWith('['));
  session.title = 'ON-PRIVATE-METADATA'; await api.saveSession(session);
  api.flushSessionIndexSync(); assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), beforeSync);
  await api.flushSessionIndex(); assert.equal((await api.readSessionIndex()).find(row => row.id === session.id).title, session.title);
  t.ok(true, 'ON exit flush leaves old cache bytes intact; asynchronous flush seals pending metadata');

  const largeRows = Array.from({ length: 500 }, (_, i) => ({ id: 'sess_index_large_' + i, title: '索引😀'.repeat(250), updatedAt: '2020' }));
  assert.ok(Buffer.byteLength(JSON.stringify(largeRows)) > 1024 * 1024); await api.writeSessionIndex(largeRows);
  const largeId = 'sess_backup_e2e_large', large = seed(api, largeId, true); assert.ok(Buffer.byteLength(large.raw) > 1024 * 1024);
  assert.equal((await api.loadSession(largeId)).messages.length, 64);
  const backupFile = api.sessionV1BackupPath(largeId), sealedBackup = fs.readFileSync(backupFile);
  assert.equal(JSON.parse(sealedBackup.toString('utf8').split('\n')[0]).workData, 3); assert.equal(sealedBackup.includes(Buffer.from('备份')), false);
  // A separate OFF v2 fixture exercises backup authentication before an otherwise permitted plaintext repair.
  await toggle(api, false); const preflightId = 'sess_backup_e2e_preflight', preflight = seed(api, preflightId); await api.loadSession(preflightId);
  await toggle(api, true); await api.sessionV1BackupStore(preflightId).write(preflight.raw);
  const preflightBody = api.sessionBodyPaths(preflightId); fs.appendFileSync(preflightBody.messages, '{"PRIVATE_TORN":"');
  await settle(api); await api.writeSessionIndex(largeRows);
  api.workDataKeys.clear(); const cold = load();
  assert.deepEqual(await cold.readSessionIndex(), largeRows); assert.equal((await cold.readSessionV1BackupRecord(largeId)).text, large.raw);
  assert.deepEqual(fs.readFileSync(backupFile), sealedBackup);
  await cold.writeSessionIndex(largeRows, new Map(largeRows.map(row => [row.id, row])));
  const sealedIndex = fs.readFileSync(cold.sessionIndexPath()); assert.equal(JSON.parse(sealedIndex.toString('utf8').split('\n')[0]).workData, 3);
  const sourceBytes = { head: fs.readFileSync(cold.sessionPath(largeId)), messages: fs.readFileSync(cold.sessionBodyPaths(largeId).messages),
    preflightHead: fs.readFileSync(cold.sessionPath(preflightId)), preflightBody: fs.readFileSync(preflightBody.messages), preflightBackup: fs.readFileSync(cold.sessionV1BackupPath(preflightId)) };
  t.ok(true, 'real DPAPI seals >1 MiB Unicode index and backup; independent cold runtime restores exact plaintext');

  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json'); for (const runtime of runtimes) runtime.workDataKeys.clear();
  fs.renameSync(keyFile, keyFile + '.missing');
  try {
    cold.scheduleSessionIndexUpdate(largeRows[0].id, { ...largeRows[0], title: 'MUST NOT OVERWRITE' }); await cold.flushSessionIndex();
    await assert.rejects(cold.readSessionIndex, privateError); await assert.rejects(cold.listSessions, privateError);
    cold.scheduleSessionIndexUpdate(largeRows[0].id, { ...largeRows[0], title: 'MUST NOT SYNC' }); cold.flushSessionIndexSync(); await cold.flushSessionIndex();
    await cold.invalidateSessionIndex(); await assert.rejects(cold.readSessionIndex, privateError);
    await assert.rejects(() => cold.readSessionV1BackupRecord(largeId), privateError);
    await assert.rejects(() => cold.loadSessionV1Backup(largeId), privateError);
    await assert.rejects(() => cold.ensureSessionV1Backup(largeId), privateError);
    await assert.rejects(() => cold.loadSession(preflightId), privateError);
    assert.deepEqual(fs.readFileSync(cold.sessionIndexPath()), sealedIndex); assert.deepEqual(fs.readFileSync(backupFile), sealedBackup);
    assert.deepEqual(fs.readFileSync(cold.sessionPath(largeId)), sourceBytes.head); assert.deepEqual(fs.readFileSync(cold.sessionBodyPaths(largeId).messages), sourceBytes.messages);
    assert.deepEqual(fs.readFileSync(cold.sessionPath(preflightId)), sourceBytes.preflightHead); assert.deepEqual(fs.readFileSync(preflightBody.messages), sourceBytes.preflightBody);
    assert.deepEqual(fs.readFileSync(cold.sessionV1BackupPath(preflightId)), sourceBytes.preflightBackup);
    t.ok(true, 'key loss rejects warm index memo and backup recovery, preserving cache/backup/head/body including an unrepaired torn tail');
  } finally { fs.renameSync(keyFile + '.missing', keyFile); }

  const copiedId = 'sess_backup_e2e_foreign'; fs.copyFileSync(backupFile, cold.sessionV1BackupPath(copiedId));
  await assert.rejects(() => cold.loadSessionV1Backup(copiedId), privateError);
  fs.writeFileSync(cold.sessionBodyPaths(largeId).messages, 'BROKEN JSON\n');
  const recovered = await cold.loadSession(largeId); assert.deepEqual(recovered.messages.map(row => row.content), large.messages.map(row => row.content));
  assert.deepEqual(fs.readFileSync(backupFile), sealedBackup, 'recovery never replaces the pristine backup');
  assert.equal((await cold.loadSession(largeId)).messages.length, 64); assert.equal(fs.existsSync(backupFile), false);
  assert.equal((await cold.loadSession(preflightId)).messages.length, 1); assert.equal(fs.existsSync(cold.sessionV1BackupPath(preflightId)), false);
  assert.ok((await cold.listSessions()).some(row => row.id === largeId));
  t.ok(true, 'cold crash recovery restores all messages, rejects cross-session backup and retires only after complete v2 reads');
})().catch(error => { t.fail(error && error.stack || String(error)); }).finally(async () => {
  for (const api of runtimes) {
    clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer);
    await settle(api); api.workDataKeys.clear();
  }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-session-artifact-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
