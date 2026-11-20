'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { functionBlock, constBlock } = require('../lib/source-slice');
const { createMigrationSkillBackupFixture, source } = require('../lib/migration-skill-backup-fixture');
const { basicMetadata, addEa, setShortName } = require('../lib/skill-capsule-native-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-skill-backup-unit-'));
const fixtures = [];
after(() => {
  for (const fixture of fixtures) fixture.close();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});
const fixture = options => { const value = createMigrationSkillBackupFixture(root, options); fixtures.push(value); return value; };
const stamp = '2026-10-23T00-00-00-000Z';
const win = process.platform === 'win32';
const ids = root => {
  const entries = [];
  const visit = relative => {
    const file = path.join(root, relative), stat = fs.statSync(file, { bigint: true });
    entries.push([relative.replace(/\\/g, '/'), stat.ino.toString()]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(relative, name));
  };
  visit('');
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
};

test('ON copy and undo retain original IDs and bytes below an owned path longer than MAX_PATH', { skip: !win }, async () => {
  const f = fixture();
  // Node's own mkdtemp has a separate Windows length limit. Keep fixture control
  // short while exercising the actual skills/copy/undo paths beyond MAX_PATH.
  f.paths.skills = path.join(f.dir, 'long-owner', 'P'.repeat(90), 'Q'.repeat(90), 'R'.repeat(60));
  const dest = f.skill('long-path'), row = f.row('long-path');
  fs.writeFileSync(path.join(dest, 'sub', 'binary.bin:long-path-stream'), Buffer.from([0, 255, 128, 13, 10]));
  assert.ok(dest.length > 260);
  const before = ids(dest), bytes = fs.readFileSync(path.join(dest, 'sub', 'binary.bin'));
  const copied = await f.api.migrationCopyOneSkill(row, stamp);
  assert.equal(copied.ok, true);
  const undo = await f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'long-path', copyTreeHash: copied.copyTreeHash }] });
  assert.equal(undo.outcome, 'restored-previous');
  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin')), bytes);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin:long-path-stream')), Buffer.from([0, 255, 128, 13, 10]));
  assert.equal(f.state.acquires, f.state.releases);
});

test('OFF retains original directory rename and exact arbitrary bytes/ADS with no key acquisition', { skip: !win }, async () => {
  const f = fixture({ enabled: false }), dest = f.skill('one'), row = f.row();
  fs.writeFileSync(path.join(dest, 'sub', 'binary.bin:private-stream'), Buffer.from([255, 0, 254]));
  fs.writeFileSync(dest + ':directory-private', 'DIRECTORY ADS');
  const before = ids(dest);

  const copied = await f.api.migrationCopyOneSkill(row, stamp);
  assert.equal(copied.ok, true);
  assert.deepEqual(ids(copied.backup), before);
  assert.equal(fs.existsSync(path.join(copied.backup, '.ruyi-capsule-v1')), false);
  const undo = await f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] });

  assert.equal(undo.outcome, 'restored-previous');
  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin:private-stream')), Buffer.from([255, 0, 254]));
  assert.equal(fs.readFileSync(dest + ':directory-private', 'utf8'), 'DIRECTORY ADS');
  assert.equal(f.state.acquires, 0);
});

test('ON ordinary NTFS skill backs up every original object and DATA/ADS, then restores exact bytes/IDs through private stage', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), row = f.row();
  fs.writeFileSync(path.join(dest, 'sub', 'binary.bin:private-stream'), Buffer.from([255, 0, 254]));
  fs.writeFileSync(dest + ':directory-private', 'DIRECTORY ADS');
  const before = ids(dest), metadata = basicMetadata(dest);

  const copied = await f.api.migrationCopyOneSkill(row, stamp);
  assert.equal(copied.ok, true);
  const descriptor = f.api.migrationCapsuleDescriptor(copied.backup);
  const record = await f.api.migrationCapsuleRead(descriptor);
  assert.equal(record.intent.phase, 'published');
  assert.equal(record.snapshot.entries.length, before.length);
  assert.equal(JSON.parse(fs.readFileSync(path.join(copied.backup, 'archive'), 'utf8').split('\n')[0]).purpose, 'backup');
  const objects = path.join(copied.backup, 'objects');
  assert.equal(fs.readdirSync(objects).every(name => /^[a-f0-9]{64}$/.test(name)), true);
  assert.equal(fs.readFileSync(path.join(copied.backup, 'archive'), 'utf8').includes('ORIGINAL PRIVATE'), false);
  await f.api.migrationCapsuleVerifyReady(descriptor, record.snapshot);

  const undo = await f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] });
  const actualMetadata = basicMetadata(dest, record.snapshot.entries.map(entry => entry.rel));
  assert.equal(undo.outcome, 'restored-previous');
  const expectedMetadata = metadata.map(entry => ({ ...entry,
    attrs: record.snapshot.entries.find(original => original.rel === entry.rel).attrs,
    times: [...record.snapshot.entries.find(original => original.rel === entry.rel).times] }));
  assert.deepEqual(actualMetadata, expectedMetadata);
  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin')), Buffer.from([0, 255, 13, 10, 128, 42]));
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin:private-stream')), Buffer.from([255, 0, 254]));
  assert.equal(fs.readFileSync(dest + ':directory-private', 'utf8'), 'DIRECTORY ADS');
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase, 'complete');
  assert.equal(f.state.acquires, f.state.releases);
});

async function archiveOnlyFixture(f, dest, id = 'one') {
  // Use the real current writer to make the archive, then declare that only
  // its authenticated bytes should be needed for restoration.
  const row = f.row(id);
  f.state.rows = [row];
  const copied = await f.api.hooks.copySkills({ keys: [row.key], overwrite: true });
  assert.equal(copied.copied, 1);
  const descriptor = f.api.migrationCapsuleDescriptor(f.backup(copied.id, id));
  const { intent } = await f.api.migrationCapsuleRead(descriptor);
  await f.api.migrationCapsuleWriteIntent(descriptor, { ...intent, archiveOnly: true });
  await fsp.rm(path.join(descriptor.backup, 'objects'), { recursive: true });
  const [log] = await vm.runInNewContext('migrationLogs()', f.context);
  assert.equal(log.files[0].file, dest);
  return { descriptor, log, file: log.files[0] };
}

test('archive-only undo reads the existing encrypted archive and reconstructs names, DATA and sealed provenance without original objects', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), before = ids(dest);
  const original = { schema: 1, source: 'codex', plugin: '', sourcePath: 'C:/old-skill', importedAt: '2026-10-22', sourceTreeHash: 'before', copyTreeHash: 'before' };
  await f.api.writeSkillImportRecord(dest, original);
  const provenance = await fsp.readFile(path.join(dest, '.ruyi-import.json'));
  const deep = path.join('sub', '甲'.repeat(100), '庚'.repeat(100), '目录');
  await fsp.mkdir(path.join(dest, deep, '空目录'), { recursive: true });
  await fsp.writeFile(path.toNamespacedPath(path.join(dest, deep, 'CON')), Buffer.from([130, 0, 13, 10, 255]));
  await fsp.writeFile(path.toNamespacedPath(path.join(dest, 'sub', 'binary.bin')) + ':private:$DATA', Buffer.from([255, 0, 254]));
  await fsp.writeFile(path.toNamespacedPath(dest) + ':directory-private:$DATA', 'DIRECTORY ADS');
  const { descriptor, log } = await archiveOnlyFixture(f, dest);
  const originalBroker = f.api.migrationCapsuleBroker, commands = [];
  f.replace('migrationCapsuleBroker', async () => {
    const broker = await originalBroker();
    return { ...broker, command: args => { commands.push(args.cmd); return broker.command(args); } };
  });

  const receipt = await f.api.hooks.undo({ id: log.id });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.restored, 1);
  assert.equal(receipt.skills[0].outcome, 'restored-previous');
  assert.notEqual(ids(dest)[0][1], before[0][1], 'undo uses a new root inode');
  assert.deepEqual(await fsp.readFile(path.toNamespacedPath(path.join(dest, deep, 'CON'))), Buffer.from([130, 0, 13, 10, 255]));
  assert.deepEqual(await fsp.readdir(path.toNamespacedPath(path.join(dest, deep, '空目录'))), []);
  assert.deepEqual(await fsp.readFile(path.join(dest, 'sub', 'binary.bin')), Buffer.from([0, 255, 13, 10, 128, 42]));
  assert.deepEqual(await fsp.readFile(path.join(dest, 'sub', 'binary.bin') + ':private:$DATA'), Buffer.from([255, 0, 254]));
  assert.equal(await fsp.readFile(dest + ':directory-private:$DATA', 'utf8'), 'DIRECTORY ADS');
  assert.deepEqual(await fsp.readFile(path.join(dest, '.ruyi-import.json')), provenance);
  assert.deepEqual({ ...await f.api.readSkillImportRecord(dest) }, original);
  assert.ok(commands.length > 0 && commands.every(command => command === 'capture'), 'native code checks the replacement, but never creates or restores a backup object');
  assert.deepEqual((await fsp.readdir(descriptor.backup)).sort(), ['.ruyi-capsule-v1', 'archive', 'intent']);
  assert.deepEqual(await fsp.readdir(f.paths.skills), ['one']);
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase, 'complete');
  const [completed] = await vm.runInNewContext('migrationLogs()', f.context);
  assert.equal(completed.undoResult.restored, 1);
  assert.equal(typeof completed.undoneAt, 'string');
  assert.equal(completed.undoProgress, undefined);
  assert.equal((await f.api.hooks.undo({ id: log.id })).error, 'already-undone');
  assert.equal(f.state.acquires, f.state.releases);
});

test('archive-only undo resumes an interrupted publication and acknowledges the same restored root once', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one');
  const { descriptor, file } = await archiveOnlyFixture(f, dest);
  f.context.fsp = { ...fsp, writeFile: async (target, ...args) => {
    if (path.basename(target) === 'binary.bin') throw Object.assign(Error('materialization interrupted'), { code: 'EIO' });
    return fsp.writeFile(target, ...args);
  } };
  await assert.rejects(() => f.api.migrationUndoSkillCopy(file), { code: 'EIO', operationMayHaveExecuted: true });
  const interrupted = (await f.api.migrationCapsuleRead(descriptor)).intent.archiveRestore;
  assert.match(interrupted.ownerIdentity, /^\d+:\d+$/);
  assert.equal(interrupted.identity, undefined);
  assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), '# REPLACEMENT\n');

  f.context.fsp = { ...fsp, rename: async (from, to) => {
    if (path.basename(from) === 'tree' && to === dest) throw Object.assign(Error('publication interrupted'), { code: 'EIO' });
    return fsp.rename(from, to);
  } };
  await assert.rejects(() => f.api.hooks.recover(), { code: 'EIO' });
  assert.equal(fs.existsSync(dest), false);
  const { intent } = await f.api.migrationCapsuleRead(descriptor);
  assert.equal(intent.phase, 'restoring');
  const rootAfter = intent.archiveRestore.identity.split(':')[1];
  const siblings = await fsp.readdir(f.paths.skills);
  assert.equal(siblings.length, 2);
  assert.ok(siblings.every(name => name.startsWith('.ruyi-copy-undo-')));

  f.context.fsp = fsp;
  const stagedFile = path.join(f.paths.skills, siblings.find(name => name.endsWith('-stage')), 'tree', 'SKILL.md');
  await fsp.writeFile(stagedFile + ':foreign:$DATA', 'A stream not in the archive');
  await assert.rejects(() => f.api.hooks.recover(), { code: 'work_data_backup.archive_restore_bytes' });
  assert.equal(fs.existsSync(dest), false);
  assert.equal(await fsp.readFile(stagedFile + ':foreign:$DATA', 'utf8'), 'A stream not in the archive');
  await fsp.unlink(stagedFile + ':foreign:$DATA');

  const write = f.api.migrationCapsuleWriteIntent;
  f.replace('migrationCapsuleWriteIntent', (target, value) => {
    if (value.phase === 'complete') throw Object.assign(Error('completion interrupted'), { code: 'ENOSPC' });
    return write(target, value);
  });
  await assert.rejects(() => f.api.hooks.recover(), { code: 'ENOSPC' });
  assert.equal(ids(dest)[0][1], rootAfter);
  assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\n');
  await fsp.appendFile(path.join(dest, 'SKILL.md'), 'EDIT AFTER PUBLICATION');

  f.replace('migrationCapsuleWriteIntent', write);
  const retired = path.join(f.paths.skills, siblings.find(name => name.endsWith('-retired')));
  const unexpected = path.join(retired, 'unexpected.txt');
  await fsp.writeFile(unexpected, 'An unrelated file');
  await assert.rejects(() => f.api.hooks.recover(), { code: 'work_data_backup.live_changed' });
  assert.equal(await fsp.readFile(unexpected, 'utf8'), 'An unrelated file');
  await fsp.unlink(unexpected);
  // Resume deletion after a cleanup had already removed one original file.
  await fsp.unlink(path.join(retired, 'SKILL.md'));
  await f.api.hooks.recover();
  assert.equal((await f.api.migrationUndoSkillCopy(file)).outcome, 'restored-previous');
  assert.equal(ids(dest)[0][1], rootAfter);
  assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\nEDIT AFTER PUBLICATION');
  assert.deepEqual(await fsp.readdir(f.paths.skills), ['one']);
  assert.deepEqual((await fsp.readdir(descriptor.backup)).sort(), ['.ruyi-capsule-v1', 'archive', 'intent']);
});

test('file and directory extended attributes refuse before archive/rename/clear', { skip: !win }, async () => {
  for (const relative of ['SKILL.md', 'sub']) {
    const f = fixture(), dest = f.skill('one'), row = f.row();
    addEa(path.join(dest, relative));
    const before = ids(dest), metadata = basicMetadata(dest);

    await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), { code: 'work_data_backup.unsupported_stream' });

    assert.deepEqual(ids(dest), before);
    const withoutReadAccessTime = entries => entries.map(entry => ({ ...entry, times: [entry.times[0], entry.times[2], entry.times[3]] }));
    assert.deepEqual(withoutReadAccessTime(basicMetadata(dest)), withoutReadAccessTime(metadata));
    assert.equal(fs.existsSync(f.backup()), false);
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\n');
  }
});

test('read-only ordinary files and their ADS restore on the same objects with the read-only attribute intact', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), file = path.join(dest, 'sub', 'binary.bin');
  fs.writeFileSync(file + ':readonly-ads', 'READ ONLY ADS');
  fs.chmodSync(file, 0o444);
  const before = ids(dest);

  const copied = await f.api.migrationCopyOneSkill(f.row(), stamp);
  assert.equal(copied.ok, true);
  const descriptor = f.api.migrationCapsuleDescriptor(copied.backup), record = await f.api.migrationCapsuleRead(descriptor);
  assert.equal(record.snapshot.entries.find(entry => entry.rel === 'sub/binary.bin').attrs & 1, 1);
  const undone = await f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] });

  assert.equal(undone.outcome, 'restored-previous');
  const metadata = basicMetadata(dest, record.snapshot.entries.map(entry => entry.rel));
  assert.equal(metadata.find(entry => entry.rel === 'sub/binary.bin').attrs & 1, 1);
  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 255, 13, 10, 128, 42]));
  assert.equal(fs.readFileSync(file + ':readonly-ads', 'utf8'), 'READ ONLY ADS');
  fs.chmodSync(file, 0o666);
});

test('an existing writer on a read-only file or directory ADS is excluded before archive publication or metadata changes', { skip: !win }, async () => {
  for (const kind of ['readonly-default', 'directory-ADS']) {
    const f = fixture(), dest = f.skill('one'), file = kind === 'readonly-default' ? path.join(dest, 'SKILL.md') : dest + ':held-ads';
    if (kind === 'directory-ADS') fs.writeFileSync(file, 'ORIGINAL DIRECTORY ADS');
    const writer = fs.openSync(file, 'r+');
    if (kind === 'readonly-default') fs.chmodSync(file, 0o444);
    const before = ids(dest), content = fs.readFileSync(file), mode = fs.statSync(file).mode;
    try {
      await assert.rejects(() => f.api.migrationCopyOneSkill(f.row(), stamp), error =>
        String(error.code).startsWith('work_data_backup') && !error.operationMayHaveExecuted);
      assert.deepEqual(ids(dest), before);
      assert.deepEqual(fs.readFileSync(file), content);
      assert.equal(fs.statSync(file).mode, mode);
      assert.equal(fs.existsSync(f.backup()), false);
    } finally { fs.closeSync(writer); if (kind === 'readonly-default') fs.chmodSync(file, 0o666); }
  }
});

test('a new writer during the read-only handle handoff leaves all DATA/ADS/names intact and restores original Basic', { skip: !win }, async () => {
  const f = fixture({ nativeSourceTransform: source => source
    .replace('static string Step = "idle";', 'static string Step = "idle"; static SafeFileHandle ProbeWriter;')
    .replace('old.Dispose();\n    SafeFileHandle replacement = CreateFile(path,0xC0010000u,5,',
      'old.Dispose();\n    ProbeWriter=CreateFile(path,0xC0000000u,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);\n    SafeFileHandle replacement = CreateFile(path,0xC0010000u,5,') });
  const dest = f.skill('one'), file = path.join(dest, 'sub', 'binary.bin');
  fs.writeFileSync(file + ':unchanged-ads', 'ORIGINAL ADS MUST SURVIVE');
  fs.chmodSync(file, 0o444);
  const before = ids(dest), contents = fs.readFileSync(file), mode = fs.statSync(file).mode;
  await assert.rejects(() => f.api.migrationCopyOneSkill(f.row(), stamp), error => error.operationMayHaveExecuted === true);

  const record = await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(f.backup()));
  const metadata = basicMetadata(dest, record.snapshot.entries.map(entry => entry.rel));
  for (const entry of metadata) {
    const archived = record.snapshot.entries.find(original => original.rel === entry.rel);
    assert.equal(entry.attrs, archived.attrs);
    assert.deepEqual([entry.times[0], entry.times[2], entry.times[3]], [archived.times[0], archived.times[2], archived.times[3]]);
  }
  assert.deepEqual(ids(dest), before);
  assert.equal(fs.statSync(file).mode, mode);
  assert.deepEqual(fs.readFileSync(file), contents);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\n');
  assert.equal(fs.readFileSync(file + ':unchanged-ads', 'utf8'), 'ORIGINAL ADS MUST SURVIVE');
  assert.deepEqual(fs.readdirSync(path.join(f.backup(), 'objects')), []);
  fs.chmodSync(file, 0o666);
});

test('hardlink/reparse capabilities refuse before any original object or backup authority changes', { skip: !win }, async () => {
  for (const kind of ['hardlink', 'junction']) {
    const f = fixture(), dest = f.skill('one'), row = f.row();
    if (kind === 'hardlink') fs.linkSync(path.join(dest, 'SKILL.md'), path.join(f.dir, 'external-alias'));
    else fs.symlinkSync(path.join(dest, 'sub'), path.join(dest, 'junction'), 'junction');
    const before = fs.readFileSync(path.join(dest, 'SKILL.md')), inode = fs.statSync(dest, { bigint: true }).ino;

    await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), { code: 'work_data_backup.unsupported_object' });

    assert.deepEqual(fs.readFileSync(path.join(dest, 'SKILL.md')), before);
    assert.equal(fs.statSync(dest, { bigint: true }).ino, inode);
    assert.equal(fs.existsSync(f.backup()), false);
  }
});

test('archive/intent authentication and OFF downgrade refusal precede any undo live mutation', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), copied = await f.api.migrationCopyOneSkill(f.row(), stamp);
  const file = { file: dest, backup: copied.backup, items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] };
  const live = fs.readFileSync(path.join(dest, 'SKILL.md')), archive = path.join(copied.backup, 'archive');
  const bytes = fs.readFileSync(archive);

  f.state.enabled = false;
  await assert.rejects(() => f.api.migrationUndoSkillCopy(file), { code: 'work_data_backup.downgrade_refused' });
  assert.deepEqual(fs.readFileSync(path.join(dest, 'SKILL.md')), live);
  assert.deepEqual(fs.readFileSync(archive), bytes);
  f.state.enabled = true;
  f.state.missing = true;
  await assert.rejects(() => f.api.migrationUndoSkillCopy(file), { code: 'work_data_key.absent' });
  f.state.missing = false;
  fs.writeFileSync(archive, bytes.subarray(0, bytes.length - 17));
  await assert.rejects(() => f.api.migrationUndoSkillCopy(file), error => String(error.code).startsWith('work_data'));
  assert.deepEqual(fs.readFileSync(path.join(dest, 'SKILL.md')), live);
  assert.deepEqual(fs.readFileSync(archive), bytes.subarray(0, bytes.length - 17));
});

test('preparing crash after native clear is recovered once before the next owner, including when the switch is OFF', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), row = f.row(), before = ids(dest);
  const original = f.api.migrationCapsuleWriteIntent;
  f.replace('migrationCapsuleWriteIntent', async (descriptor, intent) => {
    if (intent.phase === 'ready') throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    return original(descriptor, intent);
  });
  await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), error => error.operationMayHaveExecuted === true && error.retry === false);
  assert.equal(fs.existsSync(dest), false);

  f.replace('migrationCapsuleWriteIntent', original);
  f.state.enabled = false;
  await f.api.hooks.recover();

  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin')), Buffer.from([0, 255, 13, 10, 128, 42]));
  const descriptor = f.api.migrationCapsuleDescriptor(f.backup());
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase, 'aborted');
  await f.api.hooks.recover();
  assert.deepEqual(ids(dest), before);
});

test('ready publication and missing log survive recovery without copying again; later live edits are left for ordinary undo conflict handling', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), row = f.row();
  f.state.rows = [row];
  f.state.failLog = true;
  const copied = await f.api.migrationCopySkills({ keys: [row.key], overwrite: true });
  assert.equal(copied.operationMayHaveExecuted, true);
  assert.equal(copied.copied, 1);
  assert.equal(copied.retry, false);
  const after = ids(dest);
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# USER EDIT\n');

  await f.api.hooks.recover();

  assert.deepEqual(ids(dest), after);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# USER EDIT\n');
});

test('undo publication with failed final intent/log is acknowledged once and never deletes the restored original on retry', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), before = ids(dest), row = f.row();
  const copied = await f.api.migrationCopyOneSkill(row, stamp);
  const descriptor = f.api.migrationCapsuleDescriptor(copied.backup), original = f.api.migrationCapsuleWriteIntent;
  f.replace('migrationCapsuleWriteIntent', async (descriptor, intent) => {
    if (intent.phase === 'complete') throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    return original(descriptor, intent);
  });
  const file = { file: dest, backup: copied.backup, items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] };
  await assert.rejects(() => f.api.migrationUndoSkillCopy(file), error => error.operationMayHaveExecuted === true);
  assert.deepEqual(ids(dest), before);

  f.replace('migrationCapsuleWriteIntent', original);
  await f.api.hooks.recover();
  const retried = await f.api.migrationUndoSkillCopy(file);

  assert.equal(retried.outcome, 'restored-previous');
  assert.deepEqual(ids(dest), before);
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase, 'complete');
  assert.equal(fs.existsSync(path.join(copied.backup, 'retired')), false);
});

test('unknown child or ADS appearing after capture prevents clear and is never removed by failed recovery', { skip: !win }, async () => {
  for (const kind of ['child', 'ADS']) {
    const f = fixture(), dest = f.skill('one'), row = f.row(), original = f.api.migrationCapsuleBroker;
    const extra = kind === 'child' ? path.join(dest, 'unseen-child') : path.join(dest, 'sub', 'binary.bin:unseen-stream');
    f.replace('migrationCapsuleBroker', async () => {
      const broker = await original();
      return { ...broker, command: async args => {
        if (args.cmd === 'seal') fs.writeFileSync(extra, 'UNCAPTURED MUST SURVIVE');
        return broker.command(args);
      } };
    });

    await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), error => error.operationMayHaveExecuted === true);

    assert.equal(fs.readFileSync(extra, 'utf8'), 'UNCAPTURED MUST SURVIVE');
    assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin')), Buffer.from([0, 255, 13, 10, 128, 42]));
    assert.deepEqual(fs.readdirSync(path.join(f.backup(), 'objects')), []);
    f.replace('migrationCapsuleBroker', original);
    await assert.rejects(() => f.api.hooks.recover(), error => String(error.code).startsWith('work_data_backup'));
    assert.equal(fs.readFileSync(extra, 'utf8'), 'UNCAPTURED MUST SURVIVE');
  }
});

test('an already-open writer and sealed capacity overflow refuse before original rename/clear and create no backup wrapper', { skip: !win }, async () => {
  for (const kind of ['writer', 'capacity']) {
    const f = fixture(), dest = f.skill('one'), row = f.row();
    let handle;
    if (kind === 'writer') handle = fs.openSync(path.join(dest, 'SKILL.md'), 'r+');
    else {
      const file = fs.openSync(path.join(dest, 'oversized.bin'), 'w');
      fs.ftruncateSync(file, 96000001);
      fs.closeSync(file);
    }
    const before = ids(dest);
    try {
      await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), error => String(error.code).startsWith('work_data_backup'));
    } finally { if (handle !== undefined) fs.closeSync(handle); }

    assert.deepEqual(ids(dest), before);
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\n');
    assert.equal(fs.existsSync(f.backup()), false);
  }
});

test('a captured file moved outside the live tree cannot be cleared through its still-open handle', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), row = f.row(), original = f.api.migrationCapsuleBroker;
  const moved = path.join(f.dir, 'external-moved-original.bin');
  f.replace('migrationCapsuleBroker', async () => {
    const broker = await original();
    return { ...broker, command: async args => {
      if (args.cmd === 'seal') fs.renameSync(path.join(dest, 'sub', 'binary.bin'), moved);
      return broker.command(args);
    } };
  });

  await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), { code: 'work_data_backup.entry_set_changed' });

  assert.deepEqual(fs.readFileSync(moved), Buffer.from([0, 255, 13, 10, 128, 42]));
  assert.deepEqual(fs.readdirSync(path.join(f.backup(), 'objects')), []);
});

test('OFF old destination has no new sealed archive capacity cap', { skip: !win }, async () => {
  const f = fixture({ enabled: false }), dest = f.skill('one'), file = path.join(dest, 'large-old.bin');
  const handle = fs.openSync(file, 'w');
  fs.ftruncateSync(handle, 96000001);
  fs.writeSync(handle, Buffer.from([255, 0, 128]), 0, 3, 96000001 - 3);
  fs.closeSync(handle);
  const before = ids(dest);

  const copied = await f.api.migrationCopyOneSkill(f.row(), stamp);

  assert.equal(copied.ok, true);
  assert.deepEqual(ids(copied.backup), before);
  assert.equal(fs.statSync(path.join(copied.backup, 'large-old.bin')).size, 96000001);
  assert.equal(f.state.acquires, 0);
});

test('an old backup may contain an unrelated sealed archive payload; losing the new capsule marker still cannot enable legacy undo', { skip: !win }, async () => {
  const f = fixture({ enabled: false }), dest = f.skill('one');
  fs.writeFileSync(path.join(dest, 'archive'), JSON.stringify({ workData: 3, purpose: 'backup', scopeId: 'other-family', recordId: 'other-record' }) + '\n');
  const copied = await f.api.migrationCopyOneSkill(f.row(), stamp);
  assert.equal(await f.api.migrationCapsulePresent(copied.backup), false);
  const result = await f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] });
  assert.equal(result.outcome, 'restored-previous');
  assert.equal(fs.existsSync(path.join(dest, 'archive')), true);

  f.state.enabled = true;
  const sealed = await f.api.migrationCopyOneSkill(f.row(), '2026-10-23T00-00-00-001Z');
  fs.unlinkSync(path.join(sealed.backup, '.ruyi-capsule-v1'));
  assert.equal(await f.api.migrationCapsulePresent(sealed.backup), true);
  f.state.enabled = false;
  await assert.rejects(() => f.api.migrationUndoSkillCopy({ file: dest, backup: sealed.backup,
    items: [{ id: 'one', copyTreeHash: sealed.copyTreeHash }] }), { code: 'work_data_backup.downgrade_refused' });
});

test('a crash after one flat-object move recovers from mixed live and capsule locations by authenticated IDs', { skip: !win }, async () => {
  const f = fixture({ nativeSourceTransform: source => source
    .replace('static string Step = "idle";', 'static string Step = "idle"; static int ProbeMoves;')
    .replace('Rename(node, Str(node.Entry["opaque"]), Capsule);', 'Rename(node, Str(node.Entry["opaque"]), Capsule); if (++ProbeMoves == 1) Reject("probe_cut");') });
  const dest = f.skill('one'), before = ids(dest), row = f.row();
  await assert.rejects(() => f.api.migrationCopyOneSkill(row, stamp), { code: 'work_data_backup.probe_cut' });
  assert.equal(fs.readdirSync(path.join(f.backup(), 'objects')).length, 1);

  await f.api.hooks.recover();

  assert.deepEqual(ids(dest), before);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'sub', 'binary.bin')), Buffer.from([0, 255, 13, 10, 128, 42]));
  assert.equal((await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(f.backup()))).intent.phase, 'aborted');
});

test('undo crash after retirement preserves both trees and completes once on recovery before readers are released', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), before = ids(dest), copied = await f.api.migrationCopyOneSkill(f.row(), stamp);
  const original = f.api.migrationCapsuleBroker;
  f.replace('migrationCapsuleBroker', async () => {
    const broker = await original();
    return { ...broker, command: async args => {
      if (args.cmd === 'publish') throw Object.assign(new Error('cut'), { code: 'EIO' });
      return broker.command(args);
    } };
  });
  await assert.rejects(() => f.api.migrationUndoSkillCopy({ file: dest, backup: copied.backup,
    items: [{ id: 'one', copyTreeHash: copied.copyTreeHash }] }), error => error.operationMayHaveExecuted === true);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(path.join(copied.backup, 'retired', 'SKILL.md')), true);
  const stagedRecord = await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(copied.backup));
  assert.equal(fs.existsSync(path.join(copied.backup, 'restored', stagedRecord.intent.oldRoot, 'SKILL.md')), true);

  f.replace('migrationCapsuleBroker', original);
  await f.api.hooks.recover();

  assert.deepEqual(ids(dest), before);
  assert.equal(fs.existsSync(path.join(copied.backup, 'retired')), false);
});

test('cross-backup scope and authenticated wrong path/duplicate/stream shape cannot clear or replace a skill', { skip: !win }, async () => {
  const f = fixture(), dest = f.skill('one'), copied = await f.api.migrationCopyOneSkill(f.row(), stamp);
  const descriptor = f.api.migrationCapsuleDescriptor(copied.backup), record = await f.api.migrationCapsuleRead(descriptor);
  const before = fs.readFileSync(path.join(dest, 'SKILL.md'));
  const other = f.api.migrationCapsuleDescriptor(f.backup(stamp, 'two'));
  fs.mkdirSync(other.backup);
  for (const name of ['archive', 'intent']) fs.copyFileSync(path.join(copied.backup, name), path.join(other.backup, name));
  await assert.rejects(() => f.api.migrationCapsuleRead(other), error => String(error.code).startsWith('work_data'));

  for (const mutate of [
    value => { value.entries[1].rel = '../escaped'; },
    value => { value.entries.push(value.entries[1]); },
    value => { value.entries.find(entry => !entry.dir).streams[0].data = '////'; },
  ]) {
    const invalid = JSON.parse(JSON.stringify(record.snapshot));
    mutate(invalid);
    assert.equal(f.api.migrationCapsuleShape(invalid), false);
    const bytes = require('node:zlib').gzipSync(Buffer.from(JSON.stringify(invalid)));
    await assert.rejects(() => f.api.migrationCapsuleArchive(descriptor).write(bytes), { code: 'work_data_backup.shape' });
    assert.deepEqual(fs.readFileSync(path.join(dest, 'SKILL.md')), before);
  }
});

test('registry and skill_read retain the migration owner across their whole read, so a later copy cannot expose a half-tree', { skip: !win }, async () => {
  for (const kind of ['registry', 'skill_read']) {
    const f = fixture(), dest = f.skill('one'), row = f.row();
    f.state.rows = [row];
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const admitted = new Promise(resolve => { entered = resolve; });
    const borrow = f.api.hooks.withSkillRead;
    let readOwnerHeld = false;
    f.api.hooks.withSkillRead = work => borrow(async () => {
      readOwnerHeld = true;
      try { return await work(); } finally { readOwnerHeld = false; }
    });
    if (kind === 'registry') f.state.capabilityGate = async () => { entered(); await held; };
    else f.state.skillReadGate = async () => { entered(); await held; };
    const read = kind === 'registry' ? f.api.loadSkillRegistry('', {})
      : f.api.readEnabledSkill({ id: 'one' }, { session: { skills: [{ id: 'one', source: 'user' }] }, config: {} });
    await admitted;
    assert.equal(readOwnerHeld, true, 'the actual owner callback remains active inside the suspended business read');
    let renamed = false;
    const rename = fsp.rename;
    f.context.fsp = { ...fsp, rename: async (...args) => { renamed = true; return rename(...args); } };
    const copied = f.api.migrationCopySkills({ keys: [row.key], overwrite: true });
    // An owner noop queued after the copy cannot run either. This microtask turn
    // establishes admission without a sleep or a wall-clock timing assertion.
    let drained = false;
    const tail = f.api.hooks.withSkillRead(async () => { drained = true; });
    await Promise.resolve();
    assert.equal(renamed, false);
    assert.equal(drained, false);
    assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# ORIGINAL PRIVATE NAME\n');
    release();
    const result = await read;
    if (kind === 'skill_read') assert.equal(result.content, '# ORIGINAL PRIVATE NAME\n');
    assert.equal((await copied).copied, 1);
    await tail;
    assert.equal(drained, true);
  }
});

test('real startServerInner awaits capsule recovery after directories and before its first boot consumer, including rejection', async () => {
  for (const fail of [false, true]) {
    const events = [];
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const stop = new Error(fail ? 'recovery refused' : 'first consumer reached');
    const start = vm.runInNewContext(functionBlock(source('13-http-router.js'), 'startServerInner') + '\nstartServerInner;', {
      beginBootCliPathProbes: () => events.push('probes'),
      ensureDirs: async () => { events.push('directories'); }, START_NOTICE: {},
      MigrationHooks: { recover: async () => { events.push('recover-enter'); enter(); await held; if (fail) throw stop; events.push('recover-exit'); } },
      consumeStartError: async () => { events.push('consumer'); throw stop; },
    });
    const started = start({}, '127.0.0.1');
    await entered;
    assert.deepEqual(events, ['probes', 'directories', 'recover-enter']);
    release();
    await assert.rejects(started, error => error === stop);
    assert.deepEqual(events, fail ? ['probes', 'directories', 'recover-enter']
      : ['probes', 'directories', 'recover-enter', 'recover-exit', 'consumer']);
  }
});

test('new capsule binding/native capability errors retain stable apiCode through actual sendError', { skip: !win }, async () => {
  const boot = source('00-boot.js'), config = source('01-config.js');
  const sendError = vm.runInNewContext(constBlock(boot, 'LEGACY_API_ERROR_CODES') + '\n'
    + ['normalizeApiErrorPayload', 'json', 'apiFailure'].map(name => functionBlock(boot, name)).join('\n')
    + '\n' + ['send', 'sendError'].map(name => functionBlock(config, name)).join('\n') + '\nsendError;');
  const f = fixture(), target = f.skill('one'), row = f.row();
  fs.linkSync(path.join(target, 'SKILL.md'), path.join(f.dir, 'outside-alias'));
  for (const [code, trigger] of [
    ['work_data_backup.binding', () => f.api.migrationCapsuleDescriptor(path.join(f.dir, 'outside'))],
    ['work_data_backup.unsupported_object', () => f.api.migrationCopyOneSkill(row, stamp)],
  ]) {
    let caught;
    try { await trigger(); } catch (error) { caught = error; }
    assert.ok(caught);
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    sendError(response, caught);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, code);
  }
});


test('delayed restore retains custom, empty, OEM and reversed collision aliases on root/directories/files', { skip: !win }, async () => {
  const f=fixture(),dest=f.skill('archive', {
    'SKILL.md':'# ORIGINAL\n', 'long-directory-private/long-private-first.txt':'FIRST',
    'long-directory-private/long-private-second.txt':'SECOND',
    'long-directory-empty/long-private-empty.txt':'EMPTY', 'ROOTCAP':'ROOT ALIAS IS IN ITS PARENT NAMESPACE',
    'long-private-oem.txt':'OEM',
  });
  setShortName(dest,'ROOTCAP');
  setShortName(path.join(dest,'long-directory-private'),'ORIGDIR');
  setShortName(path.join(dest,'long-directory-private','long-private-first.txt'),'');
  setShortName(path.join(dest,'long-directory-private','long-private-second.txt'),'');
  setShortName(path.join(dest,'long-directory-private','long-private-first.txt'),'LONG-P~2.TXT');
  setShortName(path.join(dest,'long-directory-private','long-private-second.txt'),'LONG-P~1.TXT');
  setShortName(path.join(dest,'long-directory-empty'),'');
  setShortName(path.join(dest,'long-directory-empty','long-private-empty.txt'),'');
  setShortName(path.join(dest,'long-private-oem.txt'),'文档.TXT');
  const before=ids(dest),metadata=basicMetadata(dest),copy=await f.api.migrationCopyOneSkill(f.row('archive'),stamp);
  await new Promise(resolve=>setTimeout(resolve,22000));
  const undone=await f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'archive',copyTreeHash:copy.copyTreeHash}]});
  assert.equal(undone.outcome,'restored-previous');assert.deepEqual(ids(dest),before);
  assert.deepEqual(basicMetadata(dest).map(row=>[row.rel,row.shortName,row.sddl]),metadata.map(row=>[row.rel,row.shortName,row.sddl]));
});

test('ordinary root names equal to capsule wrapper files preserve their same-name DOS namespace', { skip: !win }, async () => {
  for(const id of ['archive','intent','objects','restored','retired']) {
    const f=fixture(),dest=f.skill(id),before=basicMetadata(dest),copy=await f.api.migrationCopyOneSkill(f.row(id),stamp);
    const undone=await f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id,copyTreeHash:copy.copyTreeHash}]});
    assert.equal(undone.outcome,'restored-previous');
    assert.deepEqual(basicMetadata(dest).map(row=>[row.rel,row.shortName]),before.map(row=>[row.rel,row.shortName]));
  }
});

test('unrelated root alias collision refuses before reconstruction or replacement retirement and preserves the sibling', { skip: !win }, async () => {
  const f=fixture(),dest=f.skill('one');setShortName(dest,'OLDROOT');
  const copy=await f.api.migrationCopyOneSkill(f.row(),stamp),replacement=ids(dest);
  const sibling=path.join(f.paths.skills,'unrelated-long-directory');fs.mkdirSync(sibling);fs.writeFileSync(path.join(sibling,'keep'),'UNKNOWN');setShortName(sibling,'OLDROOT');
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.root_alias_collision'});
  assert.deepEqual(ids(dest),replacement);assert.equal(fs.existsSync(path.join(copy.backup,'retired')),false);
  assert.equal(fs.readFileSync(path.join(sibling,'keep'),'utf8'),'UNKNOWN');
  const record=await f.api.migrationCapsuleRead(f.api.migrationCapsuleDescriptor(copy.backup));
  await f.api.migrationCapsuleVerifyReady(f.api.migrationCapsuleDescriptor(copy.backup),record.snapshot);
  setShortName(sibling,'');await f.api.hooks.recover();
  assert.equal(fs.readFileSync(path.join(sibling,'keep'),'utf8'),'UNKNOWN');
  assert.equal(basicMetadata(dest)[0].shortName,'OLDROOT');
});

test('crash after full root publication recovers original aliases and final Basic before completing restoring intent', { skip: !win }, async () => {
  let crash=true;
  const f=fixture({nativeSourceTransform:source=>crash?source.replace('      SetAlias(root,alias);','      if(Str(args["target"])!="") Reject("probe_published_before_metadata");\n      SetAlias(root,alias);'):source});
  const dest=f.skill('one');setShortName(dest,'ORIGROOT');const before=ids(dest),copy=await f.api.migrationCopyOneSkill(f.row(),stamp);
  const descriptor=f.api.migrationCapsuleDescriptor(copy.backup),record=await f.api.migrationCapsuleRead(descriptor);
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.probe_published_before_metadata'});
  assert.deepEqual(ids(dest),before);assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase,'restoring');
  crash=false;f.replace('migrationCapsuleBroker',fixture().api.migrationCapsuleBroker);await f.api.hooks.recover();
  const after=basicMetadata(dest,record.snapshot.entries.map(entry=>entry.rel));
  for(const row of after) {const entry=record.snapshot.entries.find(entry=>entry.rel===row.rel);assert.deepEqual(row.times,[...entry.times]);assert.equal(row.attrs,entry.attrs);assert.equal(row.shortName,entry.shortName);}
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase,'complete');assert.deepEqual(ids(dest),before);
});

test('short-name capability refusal happens before archive authority or original data mutation', { skip: !win }, async () => {
  const f=fixture({nativeSourceTransform:source=>source.replace('      Check(SetFileShortName(handle,name));','      if(name!="") Reject("probe_shortname_unsupported");\n      Check(SetFileShortName(handle,name));')});
  const dest=f.skill('one'),before=ids(dest);
  await assert.rejects(()=>f.api.migrationCopyOneSkill(f.row(),stamp),{code:'work_data_backup.probe_shortname_unsupported'});
  assert.deepEqual(ids(dest),before);assert.equal(fs.existsSync(f.backup()),false);assert.equal(fs.readFileSync(path.join(dest,'SKILL.md'),'utf8'),'# ORIGINAL PRIVATE NAME\n');
});


test('crash during empty-directory alias reconstruction recovers mixed private and opaque original objects', { skip: !win }, async () => {
  const f=fixture({nativeSourceTransform:source=>source.replace('      SetAlias(node,alias);','      SetAlias(node,alias);\n      if(rel=="long-private-directory") Reject("probe_private_alias_cut");')});
  const dest=f.skill('one',{'SKILL.md':'# ORIGINAL\n','long-private-directory/long-private-file.txt':'PRIVATE'});
  setShortName(path.join(dest,'long-private-directory'),'ORIGDIR');
  setShortName(path.join(dest,'long-private-directory','long-private-file.txt'),'ORIGFILE.TXT');
  const before=ids(dest),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),replacement=ids(dest);
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.probe_private_alias_cut'});
  assert.deepEqual(ids(dest),replacement);assert.equal(fs.existsSync(path.join(copy.backup,'retired')),false);
  f.replace('migrationCapsuleBroker',fixture().api.migrationCapsuleBroker);await f.api.hooks.recover();
  assert.deepEqual(ids(dest),before);const names=basicMetadata(dest).map(row=>[row.rel,row.shortName]);
  assert.deepEqual(names.filter(([rel])=>rel.startsWith('long-private-directory')),[['long-private-directory','ORIGDIR'],['long-private-directory/long-private-file.txt','ORIGFILE.TXT']]);
});

test('published metadata recovery preserves an unknown newly added ADS and refuses completion', { skip: !win }, async () => {
  const f=fixture({nativeSourceTransform:source=>source.replace('      SetAlias(root,alias);','      SetAlias(root,alias);\n      using(var unknown=CreateFile(PathOf(root.Handle)+":unknown-recovery",0xC0000000u,7,IntPtr.Zero,4,0,IntPtr.Zero)) { if(unknown.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());Write(unknown,Encoding.UTF8.GetBytes("UNKNOWN MUST SURVIVE")); }')});
  const dest=f.skill('one'),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),descriptor=f.api.migrationCapsuleDescriptor(copy.backup);
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.stream_set_changed'});
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase,'restoring');
  f.replace('migrationCapsuleBroker',fixture().api.migrationCapsuleBroker);
  await assert.rejects(()=>f.api.hooks.recover(),{code:'work_data_backup.stream_set_changed'});
  assert.equal(fs.readFileSync(dest+':unknown-recovery','utf8'),'UNKNOWN MUST SURVIVE');
  assert.equal((await f.api.migrationCapsuleRead(descriptor)).intent.phase,'restoring');
});


test('capsule archive never accepts ordinary gzip or marker-bearing unauthenticated gzip as archive authority', { skip: !win }, async () => {
  for(const marked of [false,true]) {
    const f=fixture(),dest=f.skill('one'),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),descriptor=f.api.migrationCapsuleDescriptor(copy.backup);
    const record=await f.api.migrationCapsuleRead(descriptor),replacement=ids(dest),live=fs.readFileSync(path.join(dest,'SKILL.md'));
    const snapshot=JSON.parse(JSON.stringify(record.snapshot));
    const stream=snapshot.entries.find(entry=>entry.rel==='SKILL.md').streams.find(stream=>stream.name==='');
    const forged=Buffer.from('UNAUTHENTICATED REPLACEMENT');stream.data=forged.toString('base64');stream.size=forged.length;stream.hash=require('node:crypto').createHash('sha256').update(forged).digest('hex');
    if(marked)snapshot.untrusted={workData:3};
    const raw=require('node:zlib').gzipSync(Buffer.from(JSON.stringify(snapshot)),{level:0});
    if(marked)assert.equal(raw.includes(Buffer.from('"workData":3')),true);
    fs.writeFileSync(path.join(copy.backup,'archive'),raw);
    await assert.rejects(()=>f.api.migrationCapsuleArchive(descriptor).read(),{code:'work_data_backup.carrier'});
    await assert.rejects(()=>f.api.migrationCapsuleRead(descriptor),{code:'work_data_backup.carrier'});
    await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.carrier'});
    assert.deepEqual(ids(dest),replacement);assert.deepEqual(fs.readFileSync(path.join(dest,'SKILL.md')),live);assert.deepEqual(fs.readFileSync(path.join(copy.backup,'archive')),raw);
    assert.equal(fs.existsSync(path.join(copy.backup,'retired')),false);
  }
});

test('capsule intent requires authentication on every read even after prior sealed reads and writes', { skip: !win }, async () => {
  const f=fixture(),dest=f.skill('one'),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),descriptor=f.api.migrationCapsuleDescriptor(copy.backup);
  const record=await f.api.migrationCapsuleRead(descriptor),replacement=ids(dest),store=f.api.migrationCapsuleIntent(descriptor);
  await store.read();await store.write(JSON.stringify(record.intent));await store.read();
  const plain=JSON.stringify({...record.intent,untrusted:{workData:3}});fs.writeFileSync(path.join(copy.backup,'intent'),plain);
  await assert.rejects(()=>store.read(),{code:'work_data_backup.carrier'});
  await assert.rejects(()=>f.api.migrationCapsuleRead(descriptor),{code:'work_data_backup.carrier'});
  await assert.rejects(()=>f.api.migrationUndoSkillCopy({file:dest,backup:copy.backup,items:[{id:'one',copyTreeHash:copy.copyTreeHash}]}),{code:'work_data_backup.carrier'});
  assert.deepEqual(ids(dest),replacement);assert.equal(fs.readFileSync(path.join(copy.backup,'intent'),'utf8'),plain);assert.equal(fs.existsSync(path.join(copy.backup,'retired')),false);
});

test('archive authentication remains mandatory if its valid sealed carrier changes to gzip after the header probe', { skip: !win }, async () => {
  const f=fixture(),dest=f.skill('one'),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),descriptor=f.api.migrationCapsuleDescriptor(copy.backup);
  const record=await f.api.migrationCapsuleRead(descriptor),replacement=ids(dest),original=f.api.migrationCapsuleArchive;
  const raw=require('node:zlib').gzipSync(Buffer.from(JSON.stringify({...record.snapshot,untrusted:{workData:3}})),{level:0});
  f.replace('migrationCapsuleArchive',value=>{const store=original(value);return {...store,read:()=>{fs.writeFileSync(path.join(copy.backup,'archive'),raw);return store.read();}};});
  await assert.rejects(()=>f.api.migrationCapsuleRead(descriptor),{code:'work_data_backup.carrier'});
  assert.deepEqual(ids(dest),replacement);assert.deepEqual(fs.readFileSync(path.join(copy.backup,'archive')),raw);
});

test('intent authentication remains mandatory if its valid sealed carrier changes to plaintext after the header probe', { skip: !win }, async () => {
  const f=fixture(),dest=f.skill('one'),copy=await f.api.migrationCopyOneSkill(f.row(),stamp),descriptor=f.api.migrationCapsuleDescriptor(copy.backup);
  const record=await f.api.migrationCapsuleRead(descriptor),replacement=ids(dest),original=f.api.migrationCapsuleIntent;
  const plain=JSON.stringify({...record.intent,untrusted:{workData:3}});
  f.replace('migrationCapsuleIntent',value=>{const store=original(value);return {...store,read:()=>{fs.writeFileSync(path.join(copy.backup,'intent'),plain);return store.read();}};});
  await assert.rejects(()=>f.api.migrationCapsuleRead(descriptor),{code:'work_data_backup.carrier'});
  assert.deepEqual(ids(dest),replacement);assert.equal(fs.readFileSync(path.join(copy.backup,'intent'),'utf8'),plain);
});
