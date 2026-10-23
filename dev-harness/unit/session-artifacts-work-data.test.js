'use strict';
// TEMP source overlay. Pure cryptography is real; only the unit key protector is reversible/synthetic.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const repo = process.env.RUYI_SESSION_ARTIFACT_REPO || process.cwd(), draft = __dirname;
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-session-artifact-unit-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = path.join(repo, 'ruyi-workbench/app'), src = path.join(app, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const names = ['sessionIndexPath', 'sessionIndexStore', 'readSessionIndex', 'writeSessionIndex', 'invalidateSessionIndex',
  'scheduleSessionIndexUpdate', 'flushSessionIndex', 'flushSessionIndexSync', 'withSessionIndexLock', 'listSessions', 'readConfig', 'writeConfig',
  'workDataKeys', 'WorkDataStore', 'createSession', 'loadSession', 'saveSession', 'sessionPath', 'sessionBodyPaths',
  'sessionV1BackupPath', 'sessionV1BackupStore', 'readSessionV1BackupRecord', 'retireSessionV1Backup', 'ensureSessionV1Backup', 'loadSessionV1Backup',
  'sessionWriteChains', 'pretenderIndexRuntime', 'paths'];
let source = manifest.modules.map(row => {
  const file = row.file === '02-session-store.js' && process.env.RUYI_SESSION_ARTIFACT_SOURCE
    ? process.env.RUYI_SESSION_ARTIFACT_SOURCE
    : fs.existsSync(path.join(draft, 'src', row.file)) ? path.join(draft, 'src', row.file) : path.join(src, row.file);
  const text = fs.readFileSync(file, 'utf8');
  return row.file === '02-session-store.js' ? text.replace('protector: LocalSecretCrypto,', 'protector: __sessionArtifactUnitProtector,') : text;
}).join('\n');
source = 'const __sessionArtifactUnitProtector = { supported: () => true, run: async (_op, value) => Buffer.from(value) };\n' + source.replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
const mod = new Module(path.join(app, 'server.js'), module); mod.filename = path.join(app, 'server.js'); mod.paths = Module._nodeModulePaths(app);
mod._compile(source + '\nmodule.exports.__artifactTest = {' + names.join(',') + '}; module.exports.__artifactEval = code => eval(code);', mod.filename);
const api = mod.exports.__artifactTest;
const toggle = async flag => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
const privateError = error => String(error && error.code || '').startsWith('work_data');
const keyFile = path.join(api.paths.data, 'work-data-key-v1.json');
async function withMissingKey(work) {
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.missing');
  try { return await work(); } finally { fs.renameSync(keyFile + '.missing', keyFile); }
}
async function resetIndex(rows = []) { await toggle(false); await api.writeSessionIndex(rows); }
const seed = (id, rows = [{ role: 'user', content: 'LEGACY-PRIVATE-备份😀' }]) => {
  const value = { id, title: 'Legacy ' + id, cwd: root, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', messages: rows, providerHistory: [] };
  fs.mkdirSync(path.dirname(api.sessionPath(id)), { recursive: true });
  const raw = JSON.stringify(value, null, 2) + '\n'; fs.writeFileSync(api.sessionPath(id), raw); return { value, raw };
};
after(async () => {
  clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer);
  mod.exports.__artifactEval('if (sessionIndexFlushTimer) clearTimeout(sessionIndexFlushTimer); pendingSessionIndex.clear(); inflightSessionIndex.clear();');
  await Promise.all([...api.sessionWriteChains.values()].map(promise => promise.catch(() => {})));
  api.workDataKeys.clear(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true });
});

test('OFF index serialization, sync exit overlays and malformed ordinary cache retain the legacy contract', async () => {
  const rows = [{ id: 'sess_plain', title: '索引😀', updatedAt: '2020' }]; await resetIndex(rows);
  assert.equal(fs.readFileSync(api.sessionIndexPath(), 'utf8'), JSON.stringify(rows, null, 2));
  api.scheduleSessionIndexUpdate('sess_plain', { ...rows[0], title: 'sync title' }); api.flushSessionIndexSync();
  assert.equal(JSON.parse(fs.readFileSync(api.sessionIndexPath(), 'utf8'))[0].title, 'sync title');
  fs.writeFileSync(api.sessionIndexPath(), '{ordinary bad JSON'); assert.equal(await api.readSessionIndex(), null);
  fs.writeFileSync(api.sessionIndexPath(), '{"some":"ordinary object"}'); assert.equal(await api.readSessionIndex(), null);
});

test('large index seals losslessly and read, warm memo, invalidation and sync exit never bypass missing-key authority', async () => {
  await toggle(true); await api.workDataKeys.ensure();
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: 'sess_' + i, title: '索引😀'.repeat(250), updatedAt: '2020' }));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024);
  await api.writeSessionIndex(rows, new Map(rows.map(row => [row.id, row])));
  const original = fs.readFileSync(api.sessionIndexPath());
  assert.equal(JSON.parse(original.toString('utf8').split('\n')[0]).workData, 3);
  assert.deepEqual(await api.readSessionIndex(), rows);
  await withMissingKey(async () => {
    api.scheduleSessionIndexUpdate(rows[0].id, { ...rows[0], title: 'MUST NOT WRITE' }); await api.flushSessionIndex();
    assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), original);
    await assert.rejects(api.readSessionIndex, privateError);
    await assert.rejects(api.listSessions, privateError);
    api.scheduleSessionIndexUpdate(rows[0].id, { ...rows[0], title: 'MUST NOT SYNC' }); api.flushSessionIndexSync();
    await api.invalidateSessionIndex(); assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), original);
    await assert.rejects(api.readSessionIndex, privateError);
  });
  assert.equal(await api.readSessionIndex(), null, 'logical invalidation remains pending until authoritative rebuild');
  await api.writeSessionIndex(rows); assert.deepEqual(await api.readSessionIndex(), rows);
  const rebuilt = fs.readFileSync(api.sessionIndexPath());
  await toggle(false); await assert.rejects(() => api.writeSessionIndex([]), { code: 'work_data_store.downgrade_refused' });
  assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), rebuilt);
});

test('authenticated malformed index cannot be served or overwritten as a legacy cache miss', async () => {
  await toggle(true);
  await api.writeSessionIndex([]);
  await api.sessionIndexStore().write('{"not":"an index"}');
  const original = fs.readFileSync(api.sessionIndexPath());
  await assert.rejects(api.readSessionIndex, { code: 'work_data_store.validate' });
  await assert.rejects(() => api.writeSessionIndex([]), { code: 'work_data_store.validate' });
  await api.invalidateSessionIndex(); assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), original);
  await assert.rejects(api.listSessions, { code: 'work_data_store.validate' });
  fs.unlinkSync(api.sessionIndexPath());
});

test('sealed warm memo does not authenticate a different instance/master and failures preserve the old index', async () => {
  await toggle(true); const rows = [{ id: 'sess_identity', title: 'PRIVATE-INDEX' }], oldKey = fs.readFileSync(keyFile), stored = JSON.parse(oldKey);
  for (const changed of [
    { ...stored, protectedKey: Buffer.alloc(32, 17).toString('base64') },
    { ...stored, instanceId: 'f'.repeat(32) },
  ]) {
    await api.writeSessionIndex(rows, new Map(rows.map(row => [row.id, row])));
    const original = fs.readFileSync(api.sessionIndexPath());
    api.workDataKeys.clear(); fs.writeFileSync(keyFile, JSON.stringify(changed));
    try {
      api.scheduleSessionIndexUpdate(rows[0].id, { ...rows[0], title: 'NO NEW KEY OVERWRITE' }); await api.flushSessionIndex();
      await assert.rejects(api.readSessionIndex, privateError); assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), original);
    } finally { api.workDataKeys.clear(); fs.writeFileSync(keyFile, oldKey); }
  }
});

test('OFF plaintext memo proof cannot authorize an encrypted external replacement or a later ON write', async () => {
  const rows = [{ id: 'sess_off_proof', title: 'PUBLIC-PROOF' }]; await toggle(true); await api.writeSessionIndex(rows);
  const sealed = fs.readFileSync(api.sessionIndexPath());
  await toggle(false);
  const plain = JSON.stringify(rows, null, 2), padded = plain + ' '.repeat(sealed.length - Buffer.byteLength(plain));
  fs.writeFileSync(api.sessionIndexPath(), padded); assert.deepEqual(await api.readSessionIndex(), rows);
  const oldStat = fs.statSync(api.sessionIndexPath());
  fs.writeFileSync(api.sessionIndexPath(), sealed); fs.utimesSync(api.sessionIndexPath(), oldStat.atime, oldStat.mtime);
  await assert.rejects(() => api.writeSessionIndex([{ id: 'sess_off_proof', title: 'NO DOWNGRADE' }]), { code: 'work_data_store.downgrade_refused' });
  assert.deepEqual(fs.readFileSync(api.sessionIndexPath()), sealed);
  fs.writeFileSync(api.sessionIndexPath(), plain); await api.readSessionIndex();
  // Publish ON before queuing the sync-only probe: awaiting config I/O with a pending batch
  // lets the legitimate 200ms OFF debounce flush first on a busy runner.
  await toggle(true);
  api.scheduleSessionIndexUpdate('sess_off_proof', { ...rows[0], title: 'NO ON SYNC PLAINTEXT' });
  api.flushSessionIndexSync(); assert.equal(fs.readFileSync(api.sessionIndexPath(), 'utf8'), plain);
  await api.writeSessionIndex(rows); assert.equal(JSON.parse(fs.readFileSync(api.sessionIndexPath(), 'utf8').split('\n')[0]).workData, 3);
});

test('rebuilding an absent index does not hide a locked encrypted session head or publish an empty replacement', async () => {
  await toggle(true); const session = await api.createSession({ cwd: root, title: 'PRIVATE-HEAD-REBUILD' });
  await api.flushSessionIndex(); fs.rmSync(api.sessionIndexPath(), { force: true });
  const head = fs.readFileSync(api.sessionPath(session.id));
  await withMissingKey(async () => {
    await assert.rejects(api.listSessions, privateError);
    assert.equal(fs.existsSync(api.sessionIndexPath()), false); assert.deepEqual(fs.readFileSync(api.sessionPath(session.id)), head);
  });
});

test('OFF legacy migration creates an exact pristine backup and rejects cross-session backup contents', async () => {
  await toggle(false); const { raw } = seed('sess_backup_off');
  const loaded = await api.loadSession('sess_backup_off'); assert.equal(loaded.messages.length, 1);
  assert.equal(fs.readFileSync(api.sessionV1BackupPath('sess_backup_off'), 'utf8'), raw);
  const bytes = fs.readFileSync(api.sessionV1BackupPath('sess_backup_off'));
  await api.ensureSessionV1Backup('sess_backup_off'); assert.deepEqual(fs.readFileSync(api.sessionV1BackupPath('sess_backup_off')), bytes);
  fs.copyFileSync(api.sessionV1BackupPath('sess_backup_off'), api.sessionV1BackupPath('sess_backup_wrong'));
  assert.equal(await api.loadSessionV1Backup('sess_backup_wrong'), null);
});

test('ON large legacy backup is complete and bound to its containing session; corrupted body restores from it', async () => {
  await toggle(true); const messages = Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '备份😀'.repeat(2500) }));
  const { raw } = seed('sess_backup_on', messages); assert.ok(Buffer.byteLength(raw) > 1024 * 1024);
  const loaded = await api.loadSession('sess_backup_on'); assert.equal(loaded.messages.length, 64);
  const file = api.sessionV1BackupPath('sess_backup_on'), original = fs.readFileSync(file);
  assert.equal(JSON.parse(original.toString('utf8').split('\n')[0]).workData, 3);
  assert.equal((await api.readSessionV1BackupRecord('sess_backup_on')).text, raw);
  fs.copyFileSync(file, api.sessionV1BackupPath('sess_backup_foreign'));
  await assert.rejects(() => api.loadSessionV1Backup('sess_backup_foreign'), privateError);
  // Plaintext broken body is a synthetic crash fixture, not an authentication failure of an existing sealed row.
  const body = api.sessionBodyPaths('sess_backup_on'); fs.writeFileSync(body.messages, 'BROKEN JSON\n');
  const restored = await api.loadSession('sess_backup_on'); assert.equal(restored.messages.length, 64);
  assert.equal(restored.messages[0].content, messages[0].content); assert.deepEqual(fs.readFileSync(file), original);
  assert.equal((await api.loadSession('sess_backup_on')).messages.length, 64); assert.equal(fs.existsSync(file), false);
});

test('missing or damaged backup key never becomes missing backup, quarantine, or successful migration', async () => {
  await toggle(true); seed('sess_backup_blocked'); await api.loadSession('sess_backup_blocked');
  const backup = api.sessionV1BackupPath('sess_backup_blocked'), head = api.sessionPath('sess_backup_blocked'), body = api.sessionBodyPaths('sess_backup_blocked');
  const bytes = { backup: fs.readFileSync(backup), head: fs.readFileSync(head), messages: fs.readFileSync(body.messages), provider: fs.readFileSync(body.provider) };
  await withMissingKey(async () => {
    await assert.rejects(() => api.loadSessionV1Backup('sess_backup_blocked'), privateError);
    await assert.rejects(() => api.ensureSessionV1Backup('sess_backup_blocked'), privateError);
    await assert.rejects(() => api.loadSession('sess_backup_blocked'), privateError);
    assert.deepEqual(fs.readFileSync(backup), bytes.backup); assert.deepEqual(fs.readFileSync(head), bytes.head);
    assert.deepEqual(fs.readFileSync(body.messages), bytes.messages); assert.deepEqual(fs.readFileSync(body.provider), bytes.provider);
  });
  const broken = bytes.backup.subarray(0, bytes.backup.length - 25); fs.writeFileSync(backup, broken);
  await assert.rejects(() => api.loadSession('sess_backup_blocked'), privateError);
  assert.deepEqual(fs.readFileSync(backup), broken); assert.deepEqual(fs.readFileSync(head), bytes.head);
  assert.equal(fs.existsSync(head + '.corrupt'), false); fs.writeFileSync(backup, bytes.backup);
  const legacy = seed('sess_backup_new_blocked');
  await withMissingKey(async () => {
    await assert.rejects(() => api.loadSession('sess_backup_new_blocked'), privateError);
    assert.equal(fs.readFileSync(api.sessionPath('sess_backup_new_blocked'), 'utf8'), legacy.raw);
    assert.equal(fs.existsSync(api.sessionV1BackupPath('sess_backup_new_blocked')), false);
    assert.equal(fs.existsSync(api.sessionBodyPaths('sess_backup_new_blocked').messages), false);
  });
});

test('backup publication failure leaves the legacy source and absent body files intact with no partial final backup', async () => {
  await toggle(true); const id = 'sess_backup_publish_fail', legacy = seed(id);
  const originalLink = fs.promises.link;
  fs.promises.link = async (source, target) => {
    if (target === api.sessionV1BackupPath(id)) throw Object.assign(new Error('synthetic full/locked publication'), { code: 'ENOSPC' });
    return originalLink(source, target);
  };
  try {
    await assert.rejects(() => api.ensureSessionV1Backup(id), { code: 'ENOSPC' });
    assert.equal(fs.readFileSync(api.sessionPath(id), 'utf8'), legacy.raw);
    assert.equal(fs.existsSync(api.sessionV1BackupPath(id)), false);
    assert.equal(fs.existsSync(api.sessionBodyPaths(id).messages), false);
    assert.equal(fs.readdirSync(api.paths.sessions).some(file => file.startsWith(id + '.json.v1bak.') && file.endsWith('.tmp')), false);
    assert.equal(fs.readdirSync(api.paths.sessions).some(file => file.startsWith(id + '.json.v1bak.') && file.endsWith('.sealed-stage')), false);
  } finally { fs.promises.link = originalLink; }
  await api.ensureSessionV1Backup(id);
  assert.equal((await api.readSessionV1BackupRecord(id)).text, legacy.raw);
});

test('an authenticated non-v1 or foreign-content backup is a hard refusal before repairs', async () => {
  await toggle(true); const id = 'sess_backup_shape', legacy = seed(id);
  for (const malformed of [{ ...legacy.value, storageVersion: 2 }, { ...legacy.value, id: 'sess_someone_else' }, { id }]) {
    const file = api.sessionV1BackupPath(id); fs.rmSync(file, { force: true });
    await api.sessionV1BackupStore(id).write(JSON.stringify(malformed));
    const bytes = fs.readFileSync(file);
    await assert.rejects(() => api.loadSessionV1Backup(id), { code: 'work_data_store.validate' });
    await assert.rejects(() => api.ensureSessionV1Backup(id), { code: 'work_data_store.validate' });
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.readFileSync(api.sessionPath(id), 'utf8'), legacy.raw);
  }
});

test('sealed backup preflight refuses key loss before truncating even a plaintext v2 body tail', async () => {
  await toggle(false); const id = 'sess_backup_preflight', legacy = seed(id); await api.loadSession(id);
  await toggle(true); await api.sessionV1BackupStore(id).write(legacy.raw);
  const body = api.sessionBodyPaths(id); fs.appendFileSync(body.messages, '{"TORN":"PRIVATE');
  const original = { head: fs.readFileSync(api.sessionPath(id)), backup: fs.readFileSync(api.sessionV1BackupPath(id)), body: fs.readFileSync(body.messages) };
  await withMissingKey(async () => {
    await assert.rejects(() => api.loadSession(id), privateError);
    assert.deepEqual(fs.readFileSync(api.sessionPath(id)), original.head); assert.deepEqual(fs.readFileSync(api.sessionV1BackupPath(id)), original.backup);
    assert.deepEqual(fs.readFileSync(body.messages), original.body);
  });
  assert.equal((await api.loadSession(id)).messages.length, 1); assert.equal(fs.existsSync(api.sessionV1BackupPath(id)), false);
  assert.notDeepEqual(fs.readFileSync(body.messages), original.body);
});

test('retirement cannot unlink an externally replaced same-size backup or a sealed record after key loss', async () => {
  await toggle(true); const id = 'sess_backup_retire', legacy = seed(id); await api.ensureSessionV1Backup(id);
  const file = api.sessionV1BackupPath(id), record = await api.readSessionV1BackupRecord(id), before = fs.statSync(file), beforeBig = fs.statSync(file, { bigint: true }), bytes = fs.readFileSync(file);
  const changed = Buffer.from(bytes); changed[changed.length - 30] = changed[changed.length - 30] === 65 ? 66 : 65;
  fs.writeFileSync(file, changed); fs.utimesSync(file, before.atime, before.mtime);
  // Date utimes rounds sub-millisecond precision. Present the exact saved mtimeNs so only ctime
  // distinguishes this in-place edit; deleting ctime from the product guard makes this test fail.
  const stat = fs.promises.stat;
  fs.promises.stat = async (target, options) => {
    const current = await stat(target, options);
    return target === file && options?.bigint ? { ...current, mtimeNs: beforeBig.mtimeNs } : current;
  };
  try { await api.retireSessionV1Backup(id, record); assert.deepEqual(fs.readFileSync(file), changed); }
  finally { fs.promises.stat = stat; }
  fs.writeFileSync(file, bytes); const current = await api.readSessionV1BackupRecord(id);
  await withMissingKey(async () => {
    await assert.rejects(() => api.retireSessionV1Backup(id, current), privateError); assert.deepEqual(fs.readFileSync(file), bytes);
  });
  await api.retireSessionV1Backup(id, await api.readSessionV1BackupRecord(id)); assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(api.sessionPath(id), 'utf8'), legacy.raw);
});

test('ordinary backup I/O is not absence: full v2 repair and ON migration keep all recovery authority', async () => {
  await toggle(false); const id = 'sess_backup_locked_repair'; seed(id); await api.loadSession(id);
  const backup = api.sessionV1BackupPath(id), body = api.sessionBodyPaths(id); fs.writeFileSync(body.messages, 'BROKEN JSON\n');
  const bytes = { head: fs.readFileSync(api.sessionPath(id)), backup: fs.readFileSync(backup), body: fs.readFileSync(body.messages) };
  const legacyId = 'sess_backup_locked_migrate', legacy = seed(legacyId); fs.copyFileSync(api.sessionPath(legacyId), api.sessionV1BackupPath(legacyId));
  const open = fs.promises.open;
  fs.promises.open = async (file, ...args) => {
    if (file === backup || file === api.sessionV1BackupPath(legacyId)) throw Object.assign(new Error('synthetic locked backup'), { code: 'EACCES' });
    return open(file, ...args);
  };
  try {
    const unreadable = await api.readSessionV1BackupRecord(id); assert.equal(unreadable.unreadable, true);
    assert.equal(await api.loadSession(id), null); assert.equal(await api.loadSessionV1Backup(id), null);
    await api.retireSessionV1Backup(id, unreadable);
    assert.deepEqual(fs.readFileSync(api.sessionPath(id)), bytes.head); assert.deepEqual(fs.readFileSync(backup), bytes.backup);
    assert.deepEqual(fs.readFileSync(body.messages), bytes.body); assert.equal(fs.existsSync(api.sessionPath(id) + '.corrupt'), false);
    await toggle(true); await assert.rejects(() => api.ensureSessionV1Backup(legacyId), { code: 'EACCES' });
    const visible = await api.loadSession(legacyId); assert.equal(visible.messages.length, 1, 'legacy source stays readable without a claimed migration');
    assert.equal(fs.readFileSync(api.sessionPath(legacyId), 'utf8'), legacy.raw);
    assert.equal(fs.readFileSync(api.sessionV1BackupPath(legacyId), 'utf8'), legacy.raw);
    assert.equal(fs.existsSync(api.sessionBodyPaths(legacyId).messages), false);
  } finally { fs.promises.open = open; }
});

test('a failed config read cannot reuse an OFF plaintext proof to write', async () => {
  await toggle(true); await api.writeSessionIndex([]); await toggle(false); fs.writeFileSync(api.sessionIndexPath(), '[]'); await api.readSessionIndex();
  const restore = mod.exports.__artifactEval('(() => { const original = readConfig; readConfig = async () => { throw new Error("synthetic config unavailable"); }; return () => { readConfig = original; }; })()');
  try {
    await assert.rejects(() => api.writeSessionIndex([{ id: 'sess_unknown', title: 'NO UNKNOWN WRITE' }]), { code: 'work_data_store.switch_unavailable' });
    assert.equal(fs.readFileSync(api.sessionIndexPath(), 'utf8'), '[]');
  } finally { restore(); }
});

test('invalidation cannot unlink a sealed replacement while an old plaintext handle close is suspended', async () => {
  await toggle(false); fs.rmSync(api.sessionIndexPath(), { force: true }); await api.writeSessionIndex([{ id: 'sess_serial', title: 'old plain' }]);
  let reached, release; const atClose = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const open = fs.promises.open; let armed = true;
  fs.promises.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (armed && file === api.sessionIndexPath()) {
      armed = false; const close = handle.close.bind(handle);
      handle.close = async () => { reached(); await gate; return close(); };
    }
    return handle;
  };
  let writing;
  const invalidating = api.invalidateSessionIndex();
  try {
    await atClose; await toggle(true);
    let entered = false;
    // The production writers both hold this same lock (flush and list-rebuild); no fake writer.
    writing = api.withSessionIndexLock(async () => { entered = true; await api.writeSessionIndex([{ id: 'sess_serial', title: 'new sealed' }]); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, false, 'writer waits until invalidation has retired its old plaintext handle');
    release(); await invalidating; await writing;
    assert.equal(JSON.parse(fs.readFileSync(api.sessionIndexPath(), 'utf8').split('\n')[0]).workData, 3);
    assert.equal((await api.readSessionIndex())[0].title, 'new sealed');
  } finally { release(); fs.promises.open = open; await invalidating; if (writing) await writing; }
});
