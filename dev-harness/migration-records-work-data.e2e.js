'use strict';
// Generated runtime, synthetic source skills/external config and real Windows DPAPI.
// No source overlay, service process, real home, user migration or publication.
const path = require('node:path'), repo = process.env.MIGRATION_REPO || process.cwd();
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-migration-record-e2e-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(home, data));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('MIGRATION RECORD WORK DATA');
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const names = ['readConfig', 'writeConfig', 'workDataKeys', 'WorkDataStore', 'atomicWriteJson', 'migrationCopySkills',
  'migrationLogs', 'migrationUndo', 'writeMigrationLog', 'readSkillImportRecord', 'saveUserPlaybook', 'loadSkillRegistry'];
const runtimes = [], load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const workError = error => String(error && error.code || '').startsWith('work_data');
const toggle = async (api, enabled) => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config);
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = id => {
  const source = path.join(home, '.codex', 'skills', id);
  write(path.join(source, 'SKILL.md'), `---\nname: ${id}\ndescription: Synthetic private skill\n---\n\nPRIVATE MIGRATION ${id}\n`);
  return path.join(data, 'skills', id);
};
const log = (id, file) => ({ schema: 1, id, files: [{ file, kind: 'json', items: [{
  serverId: 'synthetic', container: ['mcpServers'], changes: [{ field: 'command', from: 'OLD', to: 'NEW' }],
}] }] });
const external = id => {
  const file = path.join(root, 'external', id + '.json');
  write(file, '{"mcpServers":{"synthetic":{"command":"NEW"}}}\n'); return file;
};
const metadata = target => path.join(target, '.ruyi-import.json');
const logFile = id => path.join(data, 'migrations', id + '.json');
const clearKeys = () => { for (const api of runtimes) api.workDataKeys.clear(); };

(async () => {
  const api = load(); await toggle(api, false);
  const offTarget = skill('migration-off');
  const off = await api.migrationCopySkills({ keys: ['codex:migration-off'] });
  assert.equal(off.ok, true); assert.equal(off.copied, 1);
  const offRecord = await api.readSkillImportRecord(offTarget);
  const legacyRecord = { schema: offRecord.schema, source: offRecord.source, sourcePath: offRecord.sourcePath,
    plugin: offRecord.plugin, importedAt: offRecord.importedAt,
    sourceTreeHash: offRecord.sourceTreeHash, copyTreeHash: offRecord.copyTreeHash };
  assert.equal(fs.readFileSync(metadata(offTarget), 'utf8'), JSON.stringify(legacyRecord, null, 2) + '\n');
  const offReceipt = (await api.migrationLogs()).find(row => row.id === off.id);
  assert.equal(fs.readFileSync(logFile(off.id), 'utf8'), JSON.stringify(offReceipt, null, 2));
  assert.equal(fs.existsSync(path.join(data, 'work-data-key-v1.json')), false);
  const offBytes = fs.readFileSync(metadata(offTarget)), receiptBytes = fs.readFileSync(logFile(off.id));
  const coldOff = load();
  assert.equal((await coldOff.readSkillImportRecord(offTarget)).source, 'codex');
  assert.deepEqual(fs.readFileSync(metadata(offTarget)), offBytes);
  assert.deepEqual(fs.readFileSync(logFile(off.id)), receiptBytes);
  t.ok(true, 'OFF copy/log and cold reads preserve exact legacy bytes without creating keys');
  if (process.platform !== 'win32') { console.log('SKIP real Windows DPAPI migration record lifecycle'); return; }

  await toggle(api, true); const provisioned = await api.workDataKeys.ensure(); provisioned.fill(0);
  const target = skill('migration-on');
  const copied = await api.migrationCopySkills({ keys: ['codex:migration-on'] });
  assert.equal(copied.ok, true); assert.equal(copied.copied, 1);
  for (const file of [metadata(target), logFile(copied.id)]) {
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(raw.split('\n')[0]).workData, 3);
    assert.equal(raw.includes('PRIVATE MIGRATION'), false); assert.equal(raw.includes(root), false);
  }
  clearKeys(); const cold = load();
  assert.equal((await cold.readSkillImportRecord(target)).source, 'codex');
  assert.equal((await cold.migrationLogs()).some(row => row.id === copied.id), true);
  t.ok(true, 'two family carriers seal and cold-recover through actual DPAPI with final skill identity');

  const before = fs.readFileSync(metadata(target)), receipt = fs.readFileSync(logFile(copied.id));
  const orphan = path.join(data, 'skills', '.ruyi-copy-synthetic-orphan');
  write(path.join(orphan, 'keep'), 'untouched on rejected admission'); skill('migration-keyless');
  clearKeys(); const keyFile = path.join(data, 'work-data-key-v1.json'); fs.renameSync(keyFile, keyFile + '.held');
  try {
    await assert.rejects(cold.readSkillImportRecord(target), workError);
    await assert.rejects(cold.migrationUndo({ id: copied.id }), workError);
    await assert.rejects(cold.migrationCopySkills({ keys: ['codex:migration-keyless'] }), workError);
    assert.deepEqual(fs.readFileSync(metadata(target)), before); assert.deepEqual(fs.readFileSync(logFile(copied.id)), receipt);
    assert.equal(fs.existsSync(path.join(data, 'skills', 'migration-keyless')), false);
    assert.equal(fs.readFileSync(path.join(orphan, 'keep'), 'utf8'), 'untouched on rejected admission');
  } finally { fs.renameSync(keyFile + '.held', keyFile); }
  t.ok(true, 'missing keys after warm reads reject copy/cleanup/undo before any live change');

  const other = path.join(data, 'skills', 'migration-wrong-scope'); write(metadata(other), before);
  await assert.rejects(cold.readSkillImportRecord(other), workError); assert.deepEqual(fs.readFileSync(metadata(other)), before);
  fs.rmSync(other, { recursive: true, force: true });
  const malformedId = '2026-01-01T00-00-00-001Z', malformed = external('malformed');
  const bad = log('2026-01-01T00-00-00-002Z', malformed); write(logFile(malformedId), JSON.stringify(bad));
  await assert.rejects(cold.migrationUndo({ id: malformedId }), workError);
  assert.equal(JSON.parse(fs.readFileSync(malformed)).mcpServers.synthetic.command, 'NEW');
  fs.unlinkSync(logFile(malformedId));
  const shapeId = '2026-01-01T00-00-00-003Z';
  const shape = log(shapeId, malformed); shape.files[0].items = {};
  // Authenticate a deliberately invalid shape with the real general store; the
  // family reader still has to reject it before external effects.
  await cold.WorkDataStore.createText({ file: () => logFile(shapeId), purpose: 'migration', schema: 1,
    scopeId: 'global', recordId: 'migration-log:' + shapeId, chunked: true,
    maxPlaintextBytes: 256 * 1024 * 1024, enabled: () => true,
    writeJson: cold.atomicWriteJson,
  }).write(JSON.stringify(shape));
  await assert.rejects(cold.migrationUndo({ id: shapeId }), workError);
  assert.equal(JSON.parse(fs.readFileSync(malformed)).mcpServers.synthetic.command, 'NEW'); fs.unlinkSync(logFile(shapeId));
  t.ok(true, 'wrong scope and wrong legacy id/shape fail before modifying external configuration');

  await toggle(cold, false);
  await assert.rejects(cold.migrationUndo({ id: copied.id }), workError);
  assert.deepEqual(fs.readFileSync(metadata(target)), before); assert.deepEqual(fs.readFileSync(logFile(copied.id)), receipt);
  await toggle(cold, true);
  t.ok(true, 'OFF can read sealed revisions but cannot undo into a plaintext downgrade');

  const partialTarget = skill('migration-partial');
  const rename = fsp.rename, copyFile = fsp.copyFile; let copies = 0;
  fsp.copyFile = async (...args) => { copies++; return copyFile(...args); };
  fsp.rename = async (from, to) => {
    if (path.dirname(to) === path.join(data, 'migrations')) throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  let partial, restart;
  try {
    try { partial = await cold.migrationCopySkills({ keys: ['codex:migration-partial'] }); }
    finally { fsp.rename = rename; }
    assert.equal(partial.ok, false); assert.equal(partial.operationMayHaveExecuted, true);
    assert.equal(partial.resultUnavailable, true); assert.equal(partial.retry, false);
    assert.equal(partial.copied, 1); assert.equal(partial.results[0].outcome, 'created'); assert.equal(copies, 1);
    assert.equal(fs.existsSync(metadata(partialTarget)), true); assert.equal(fs.existsSync(logFile(partial.id)), false);
    clearKeys(); restart = load(); await restart.migrationLogs();
    assert.equal((await restart.readSkillImportRecord(partialTarget)).source, 'codex'); assert.equal(copies, 1);
  } finally { fsp.rename = rename; fsp.copyFile = copyFile; }
  t.ok(true, 'post-copy log failure preserves completed receipt and never retries the copy or replays it after cold load');

  const configFile = external('partial-undo'), undoLog = log('2026-01-01T00-00-00-004Z', configFile);
  await restart.writeMigrationLog(undoLog); const undoBefore = fs.readFileSync(logFile(undoLog.id));
  fsp.rename = async (from, to) => {
    if (to === logFile(undoLog.id)) throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  let undone;
  try { undone = await restart.migrationUndo({ id: undoLog.id }); }
  finally { fsp.rename = rename; }
  assert.equal(undone.resultUnavailable, true); assert.equal(undone.retry, false); assert.equal(undone.restored, 1);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).mcpServers.synthetic.command, 'OLD');
  assert.deepEqual(fs.readFileSync(logFile(undoLog.id)), undoBefore);
  t.ok(true, 'post-undo log failure returns the completed external change and preserves the prior durable receipt');

  // Isolate the Playbook consumer from sealed provenance, so the negative test
  // reaches loadAllPlaybooks rather than failing earlier in readSkillDir.
  const skillsDir = path.join(data, 'skills'), heldSkills = path.join(data, 'skills-held');
  fs.renameSync(skillsDir, heldSkills);
  try {
    const playbook = { id: 'migration_registry_guard', title: 'Private registry fixture', promptTemplate: 'PRIVATE REGISTRY BODY' };
    await restart.saveUserPlaybook(playbook);
    const file = path.join(data, 'playbooks', playbook.id + '.json'), original = fs.readFileSync(file);
    assert.equal(JSON.parse(original.toString('utf8').split('\n')[0]).workData, 3);
    const config = await restart.readConfig();
    assert.ok((await restart.loadSkillRegistry('', config, null)).some(row => row.id === 'pb:' + playbook.id));
    clearKeys(); fs.renameSync(keyFile, keyFile + '.held');
    try {
      await assert.rejects(restart.loadSkillRegistry('', config, null), workError);
      assert.deepEqual(fs.readFileSync(file), original);
    } finally { fs.renameSync(keyFile + '.held', keyFile); }
  } finally { fs.renameSync(heldSkills, skillsDir); }
  t.ok(true, 'actual DPAPI-sealed Playbook cannot disappear from a successful registry response when its key becomes unavailable');
})().catch(error => t.fail(error.stack || String(error))).finally(() => {
  clearKeys(); assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
