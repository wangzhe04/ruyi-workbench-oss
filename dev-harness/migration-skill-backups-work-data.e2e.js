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
  'migrationUndoSkillCopy', 'migrationCapsuleRead', 'migrationCapsuleWriteIntent', 'migrationCapsuleDescriptor', 'migrationCapsuleCreateOwnedPortable', 'MigrationHooks', 'loadSkillRegistry', 'migrationCapsuleBroker'];
const runtimes = [];
const load = (previewWriter = false) => {
  const api = loadServerInternals(names, {withEval:previewWriter});
  if (previewWriter) api.__eval('migrationCapsulePrepare = ' + require('./lib/legacy-skill-capsule-writer').toString());
  runtimes.push(api);
  return api;
};
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
  const api = load(true), offTarget = await initial(api, 'capsule-off'), beforeOff = ids(offTarget);
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
  assert.equal(record.intent.undoFormat, undefined);
  const archiveOnly = path.join(root, 'archive-only'), rebuilt = path.join(root, 'rebuilt', 'capsule-on');
  fs.mkdirSync(archiveOnly);
  fs.mkdirSync(path.dirname(rebuilt));
  for (const name of ['archive', 'intent']) fs.copyFileSync(path.join(backup, name), path.join(archiveOnly, name));
  clearKeys();
  const reader = load();
  const { snapshot } = await reader.migrationCapsuleRead({ ...descriptor, backup: archiveOnly });
  // The archive can list streams in a different order than the new NTFS objects.
  for (const entry of snapshot.entries) entry.streams.reverse();
  const reconstructed = await reader.migrationCapsuleCreateOwnedPortable(rebuilt, snapshot, require('node:crypto').randomBytes(32).toString('hex'));
  assert.equal(reconstructed.entries.length, before.length);
  assert.deepEqual(ids(rebuilt).map(row => row[0]), before.map(row => row[0]));
  for (const entry of snapshot.entries) {
    for (const stream of entry.streams) {
      const file = path.join(rebuilt, ...entry.rel.split('/')) + stream.name;
      assert.deepEqual(fs.readFileSync(file), Buffer.from(stream.data, 'base64'));
    }
  }
  t.ok(true, 'cold reconstruction uses archive and intent alone and reproduces exact paths and every data stream');
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
  clearKeys(); const afterUndo = load(true); await afterUndo.MigrationHooks.recover();
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

  for (const cut of ['before-publication', 'after-publication', 'after-cleanup-rename', 'partial-cleanup', 'complete-intent', 'uninterrupted']) {
    const id = 'archive-' + cut, target = await initial(recovery, id);
    const oldBytes = fs.readFileSync(path.join(target, 'SKILL.md'));
    fs.mkdirSync(path.join(target, '空目录'));
    fs.chmodSync(path.join(target, 'private-directory', 'arbitrary.bin'), 0o444);
    await toggle(recovery, true);
    const update = await recovery.migrationCopySkills({ keys: ['codex:' + id], overwrite: true });
    const backup = await backupOf(recovery, update);
    assert.deepEqual((await fsp.readdir(backup)).sort(), ['.ruyi-capsule-v1','archive','intent']);
    clearKeys();
    const owner = load();
    await owner.MigrationHooks.recover();
    let interrupted = false;
    const remove = fsp.rm;
    let interruptedDirectory;
    fsp.rm = async (file, options) => {
      if (cut === 'partial-cleanup' && path.basename(file).startsWith('.ruyi-copy-finished-')) {
        interrupted = true;
        interruptedDirectory = file;
        await fsp.unlink(path.join(file, 'previous', 'SKILL.md'));
        throw Object.assign(new Error('fixture cleanup cut'), { code: 'EIO' });
      }
      return remove(file, options);
    };
    fsp.rename = async (from, to) => {
      const publishing = path.basename(path.dirname(from)) === 'rebuilt' && to === target;
      const retiring = path.basename(to).startsWith('.ruyi-copy-finished-');
      const completing = to === path.join(backup, 'intent') && fs.existsSync(path.join(target, '空目录'));
      if ((publishing && cut === 'after-publication') || (retiring && cut === 'after-cleanup-rename')) await rename(from, to);
      if ((publishing && ['before-publication', 'after-publication'].includes(cut))
          || (retiring && cut === 'after-cleanup-rename') || (completing && cut === 'complete-intent')) {
        interrupted = true;
        throw Object.assign(new Error('fixture publication cut'), { code: 'EIO' });
      }
      return rename(from, to);
    };
    let result;
    try { result = await owner.migrationUndo({ id: update.id }); }
    finally { fsp.rename = rename; fsp.rm = remove; }
    assert.equal(interrupted, cut !== 'uninterrupted');
    if (interrupted) {
      assert.equal(result.operationMayHaveExecuted, true);
      assert.equal(result.retry, false);
    } else assert.equal(result.ok, true);
    assert.equal(fs.existsSync(target), cut !== 'before-publication');
    if (cut === 'before-publication') {
      // A new OS process takes the durable receipt, publishes, and exits
      // immediately. A second process has only disk state and CurrentUser DPAPI.
      const program = `
        const fs = require('node:fs/promises'), path = require('node:path');
        const api = require('./dev-harness/lib/server-internals').loadServerInternals(['MigrationHooks']);
        const rename = fs.rename;
        fs.rename = async (from, to) => {
          await rename(from, to);
          if (process.argv[1] === 'cut' && path.basename(path.dirname(from)) === 'rebuilt' && to === process.argv[2]) process.exit(73);
        };
        api.MigrationHooks.recover().catch(error => { console.error(error); process.exitCode = 1; });`;
      for (const [mode, expected] of [['cut', 73], ['resume', 0]]) {
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', program, mode, target],
          { cwd: repo, env: releaseEnvironment(home, data), encoding: 'utf8', windowsHide: true, timeout: 120000 });
        assert.equal(child.status, expected, child.error?.message || child.stderr);
      }
    }
    const interruptedId = fs.existsSync(target) && fs.statSync(target, { bigint: true }).ino;
    if (cut === 'partial-cleanup') {
      const added = path.join(interruptedDirectory, 'foreign.txt');
      write(added, 'preserve');
      clearKeys();
      await assert.rejects(load().MigrationHooks.recover(), { code: 'work_data_backup.restore_cleanup_changed' });
      assert.equal(fs.readFileSync(added, 'utf8'), 'preserve');
      await rename(added, path.join(root, 'fixture-foreign-file'));
    }
    if (cut === 'after-publication') {
      const saved = path.join(root, 'fixture-published-tree');
      await rename(target, saved);
      write(path.join(target, 'SKILL.md'), 'foreign tree');
      clearKeys();
      await assert.rejects(load().MigrationHooks.recover(), workError);
      assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'foreign tree');
      await rename(target, path.join(root, 'fixture-foreign-tree'));
      await rename(saved, target);
    }
    clearKeys();
    const resumed = load();
    await resumed.MigrationHooks.recover();
    const recoveredIds = ids(target);
    if (interruptedId) assert.equal(fs.statSync(target, { bigint: true }).ino, interruptedId);
    assert.deepEqual(fs.readFileSync(path.join(target, 'SKILL.md')), oldBytes);
    assert.deepEqual(fs.readdirSync(path.join(target, '空目录')), []);
    assert.deepEqual(fs.readFileSync(path.join(target, 'private-directory', 'arbitrary.bin')), Buffer.from([0,255,10,13,128,42]));
    assert.equal(fs.readFileSync(path.join(target, 'private-directory', 'arbitrary.bin:private-ads'), 'utf8'), 'PRIVATE FILE STREAM');
    assert.equal(fs.readFileSync(target + ':directory-private-ads', 'utf8'), 'PRIVATE DIRECTORY STREAM');
    assert.equal(fs.existsSync(path.join(backup, 'objects')), false);
    if (interrupted) assert.equal((await resumed.migrationUndo({ id: update.id })).ok, true);
    assert.deepEqual(ids(target), recoveredIds);
    assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('.ruyi-copy-')), false);
    t.ok(true, 'archive-only undo resumes ' + cut + ' and acknowledges the same restored tree');
  }
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  await Promise.all(runtimes.map(api => api.flushWorkbenchLogs({ allowFailure: true })));
  clearKeys(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
