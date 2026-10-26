'use strict';
// Generated runtime and real CurrentUser DPAPI/native NTFS broker. Every home,
// external CLI source, skill and configuration belongs to this disposable root.
const path = require('node:path'), repo = process.env.MIGRATION_REPO || path.resolve(__dirname, '..');
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const assert = require('node:assert/strict');
const { releaseEnvironment } = require(path.join(repo, 'dev-harness/lib/release-checks'));
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const { basicMetadata, setShortName } = require(path.join(repo, 'dev-harness/lib/skill-capsule-native-fixture'));
const { runNativeShortProbes } = require(path.join(repo, 'dev-harness/lib/native-short-probe-fixture'));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('MIGRATION SKILL BACKUP WORK DATA');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-skill-backup-dpapi-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
Object.assign(process.env, releaseEnvironment(home, data));
const names = ['flushWorkbenchLogs', 'readConfig', 'writeConfig', 'workDataKeys', 'migrationCopySkills', 'migrationLogs', 'migrationUndo',
  'migrationUndoSkillCopy', 'migrationCapsuleRead', 'migrationCapsuleDescriptor', 'MigrationHooks', 'loadSkillRegistry', 'migrationCapsuleBroker'];
const runtimes = [];
const load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const clearKeys = () => { for (const api of runtimes) api.workDataKeys.clear(); };
const toggle = async (api, enabled) => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config);
};
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const ids = root => {
  const result = [];
  const walk = relative => {
    const file = path.join(root, relative), stat = fs.statSync(file, { bigint: true });
    result.push([relative.replace(/\\/g, '/'), stat.ino.toString()]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(relative, name));
  };
  walk(''); return result.sort((a, b) => a[0].localeCompare(b[0]));
};
const externalSkill = (id, revision) => write(path.join(home, '.codex', 'skills', id, 'SKILL.md'),
  `---\nname: ${id}\ndescription: Disposable offline fixture\n---\n\nPRIVATE SOURCE ${revision}\n`);
const liveSkill = id => path.join(data, 'skills', id);
const workError = error => String(error?.code || '').startsWith('work_data');
async function initial(api, id) {
  await toggle(api, false);
  externalSkill(id, 1);
  const copied = await api.migrationCopySkills({ keys: ['codex:' + id] });
  assert.equal(copied.copied, 1);
  const target = liveSkill(id);
  write(path.join(target, 'private-directory', 'arbitrary.bin'), Buffer.from([0, 255, 10, 13, 128, 42]));
  write(path.join(target, 'private-directory', 'arbitrary.bin:private-ads'), 'PRIVATE FILE STREAM');
  write(target + ':directory-private-ads', 'PRIVATE DIRECTORY STREAM');
  externalSkill(id, 2);
  return target;
}
async function backupOf(api, result) {
  const log = (await api.migrationLogs()).find(row => row.id === result.id);
  assert.ok(log);
  return log.files.find(row => row.kind === 'skill-copy').backup;
}

(async () => {
  const api = load(), offTarget = await initial(api, 'capsule-off'), beforeOff = ids(offTarget);
  const off = await api.migrationCopySkills({ keys: ['codex:capsule-off'], overwrite: true });
  const offBackup = await backupOf(api, off);
  assert.deepEqual(ids(offBackup), beforeOff);
  assert.equal(fs.existsSync(path.join(offBackup, '.ruyi-capsule-v1')), false);
  await api.migrationUndo({ id: off.id });
  assert.deepEqual(ids(offTarget), beforeOff);
  assert.equal(fs.readFileSync(offTarget + ':directory-private-ads', 'utf8'), 'PRIVATE DIRECTORY STREAM');
  assert.equal(fs.existsSync(path.join(data, 'work-data-key-v1.json')), false);
  t.ok(true, 'OFF keeps the original rename/undo objects and exact default/file/directory stream bytes without creating keys');
  if (process.platform !== 'win32') { console.log('SKIP real Windows NTFS/DPAPI capsule lifecycle'); return; }

  const probes = await runNativeShortProbes(api, path.join(root, 'owned-long-probes'));
  assert.equal(probes.length, 8);
  assert.ok(probes.some(row => row.probeLength >= 1024));
  assert.equal(fs.existsSync(path.join(data, 'work-data-key-v1.json')), false);
  t.ok(true, 'short-name capability probes pass long owned paths through 1024 characters with actual helper exit/close and no key creation');

  const target = await initial(api, 'capsule-on');
  write(path.join(target, 'private-directory', 'long-empty-alias-name.txt'), 'PRIVATE EMPTY ALIAS');
  setShortName(target, 'ORIGROOT');
  setShortName(path.join(target, 'private-directory'), 'ORIGDIR');
  setShortName(path.join(target, 'private-directory', 'arbitrary.bin'), 'ORIGBIN.BIN');
  setShortName(path.join(target, 'private-directory', 'long-empty-alias-name.txt'), '');
  const before = ids(target);
  const readableSecurity = basicMetadata(target).map(entry => ({ rel: entry.rel, sddl: entry.sddl }));
  fs.chmodSync(path.join(target, 'private-directory', 'arbitrary.bin'), 0o444);
  await toggle(api, true); const provisioned = await api.workDataKeys.ensure(); provisioned.fill(0);
  const copied = await api.migrationCopySkills({ keys: ['codex:capsule-on'], overwrite: true });
  assert.equal(copied.copied, 1);
  const backup = await backupOf(api, copied), descriptor = api.migrationCapsuleDescriptor(backup);
  const record = await api.migrationCapsuleRead(descriptor);
  assert.equal(record.intent.phase, 'published');
  for (const name of ['archive', 'intent']) {
    const text = fs.readFileSync(path.join(backup, name), 'utf8');
    const header = JSON.parse(text.split('\n')[0]);
    assert.equal(header.workData, 3); assert.equal(header.purpose, 'backup');
    assert.equal(text.includes('PRIVATE'), false); assert.equal(text.includes(root), false);
  }
  assert.equal(fs.readdirSync(path.join(backup, 'objects')).every(name => /^[a-f0-9]{64}$/.test(name)), true);
  clearKeys(); const cold = load();
  let copies = 0; const originalCopy = fsp.copyFile;
  fsp.copyFile = async (...args) => { copies++; return originalCopy(...args); };
  try {
    await cold.MigrationHooks.recover();
    assert.ok((await cold.loadSkillRegistry('', await cold.readConfig(), null)).some(row => row.id === 'capsule-on'));
    assert.equal(copies, 0);
  } finally { fsp.copyFile = originalCopy; }
  t.ok(true, 'ON archive and durable intent seal through real DPAPI; a cold owner recovers the published receipt without replaying the copy');

  const live = fs.readFileSync(path.join(target, 'SKILL.md')), authority = fs.readFileSync(path.join(backup, 'archive'));
  clearKeys(); const key = path.join(data, 'work-data-key-v1.json'); fs.renameSync(key, key + '.held');
  try {
    const keyless = load();
    await assert.rejects(keyless.MigrationHooks.recover(), workError);
    await assert.rejects(keyless.migrationUndo({ id: copied.id }), workError);
    assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), live);
    assert.deepEqual(fs.readFileSync(path.join(backup, 'archive')), authority);
  } finally { fs.renameSync(key + '.held', key); }
  await toggle(cold, false);
  await assert.rejects(cold.migrationUndoSkillCopy({ file: target, backup,
    items: [{ id: 'capsule-on', copyTreeHash: 'ignored-before-OFF-guard' }] }), workError);
  assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), live);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'archive')), authority);
  await toggle(cold, true);
  t.ok(true, 'missing keys and OFF sealed undo refuse before live/capsule mutation and preserve both authorities byte for byte');

  // Outwait the cache expiry that exposed V3's immediate-undo false positive.
  // This observed delay is a regression probe, not a claimed universal tunnel lifetime.
  await new Promise(resolve => setTimeout(resolve, 22000));
  // The capsule has no raw gzip or plaintext-intent alternate authority.
  const sealedIntent = fs.readFileSync(path.join(backup, 'intent'));
  const alternate = require('node:zlib').gzipSync(Buffer.from(JSON.stringify({ ...record.snapshot, untrusted: { workData: 3 } })), { level: 0 });
  fs.writeFileSync(path.join(backup, 'archive'), alternate);
  await assert.rejects(cold.migrationUndo({ id: copied.id }), workError);
  assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), live);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'archive')), alternate);
  fs.writeFileSync(path.join(backup, 'archive'), authority);
  const plainIntent = JSON.stringify({ ...record.intent, untrusted: { workData: 3 } });
  fs.writeFileSync(path.join(backup, 'intent'), plainIntent);
  await assert.rejects(cold.migrationUndo({ id: copied.id }), workError);
  assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), live);
  assert.equal(fs.readFileSync(path.join(backup, 'intent'), 'utf8'), plainIntent);
  fs.writeFileSync(path.join(backup, 'intent'), sealedIntent);
  t.ok(true, 'ordinary gzip with embedded markers and plaintext intent never become unauthenticated capsule authority');

  const rename = fsp.rename, logFile = path.join(data, 'migrations', copied.id + '.json');
  fsp.rename = async (from, to) => {
    if (to === logFile) throw Object.assign(new Error('owned full-disk fixture'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  let undone;
  try { undone = await cold.migrationUndo({ id: copied.id }); }
  finally { fsp.rename = rename; }
  // Inspect Basic through READ_ATTRIBUTES only before directory enumeration or DATA reads.
  const metadata = basicMetadata(target, record.snapshot.entries.map(entry => entry.rel));
  for (const entry of metadata) {
    const archived = record.snapshot.entries.find(original => original.rel === entry.rel);
    assert.equal(entry.attrs, archived.attrs); assert.deepEqual(entry.times, [...archived.times]);
    assert.equal(entry.shortName, archived.shortName);
    assert.equal(entry.sddl, readableSecurity.find(original => original.rel === entry.rel).sddl);
  }
  assert.equal(undone.operationMayHaveExecuted, true); assert.equal(undone.retry, false);
  assert.deepEqual(ids(target), before);
  assert.deepEqual(fs.readFileSync(path.join(target, 'private-directory', 'arbitrary.bin')), Buffer.from([0, 255, 10, 13, 128, 42]));
  assert.equal(fs.readFileSync(path.join(target, 'private-directory', 'arbitrary.bin:private-ads'), 'utf8'), 'PRIVATE FILE STREAM');
  assert.equal(fs.readFileSync(target + ':directory-private-ads', 'utf8'), 'PRIVATE DIRECTORY STREAM');
  clearKeys(); const afterUndo = load(); await afterUndo.MigrationHooks.recover();
  const retry = await afterUndo.migrationUndo({ id: copied.id });
  assert.equal(retry.ok, true); assert.deepEqual(ids(target), before);
  fs.chmodSync(path.join(target, 'private-directory', 'arbitrary.bin'), 0o666);
  t.ok(true, 'undo restores exact original objects/security/attrs/all four times/streams, and failed result-log persistence never causes a second destructive undo');

  const interrupted = await initial(afterUndo, 'capsule-interrupted'), originalIds = ids(interrupted);
  await toggle(afterUndo, true);
  let intentWrites = 0, failed;
  fsp.rename = async (from, to) => {
    if (path.basename(to) === 'intent' && ++intentWrites === 2) throw Object.assign(new Error('owned ready-intent cut'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { failed = await afterUndo.migrationCopySkills({ keys: ['codex:capsule-interrupted'], overwrite: true }); }
  finally { fsp.rename = rename; }
  assert.equal(failed.operationMayHaveExecuted, true); assert.equal(failed.retry, false);
  assert.equal(fs.existsSync(interrupted), false);
  clearKeys(); const recovery = load();
  copies = 0; fsp.copyFile = async (...args) => { copies++; return originalCopy(...args); };
  try { await recovery.MigrationHooks.recover(); assert.equal(copies, 0); }
  finally { fsp.copyFile = originalCopy; }
  assert.deepEqual(ids(interrupted), originalIds);
  assert.equal(fs.readFileSync(interrupted + ':directory-private-ads', 'utf8'), 'PRIVATE DIRECTORY STREAM');
  t.ok(true, 'cold DPAPI recovery repairs a durable preparing capsule after native clear without redoing the user copy');
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  await Promise.all(runtimes.map(api => api.flushWorkbenchLogs({ allowFailure: true })));
  clearKeys(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
