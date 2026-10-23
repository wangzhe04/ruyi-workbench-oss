'use strict';
require('./lib/self-isolate-home');
// Real memory save/group lookup and Windows DPAPI. Only the project metadata family is asserted
// sealed here; memory bodies have their own adapter and migration work.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const t = createRunner('MEMORY META WORK DATA');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-meta-e2e-'));
process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const api = require('./lib/server-internals').loadServerInternals([
  'saveMemory', 'listMemoryProjectGroups', 'memoryProjectDir', 'projectKeyForCwd', 'readConfig', 'writeConfig', 'workDataKeys',
]);
const cwd = path.join(root, 'synthetic-private-memory-project');
const setSwitch = async flag => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
(async () => {
  await setSwitch(false);
  const saved = await api.saveMemory({ scope: 'project', name: 'Synthetic project memory', body: 'Synthetic remembered convention' }, cwd);
  t.ok(saved.ok, 'normal memory save creates its project metadata');
  const metaFile = path.join(api.memoryProjectDir(cwd), 'meta.json');
  const before = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  t.ok(before.path === cwd && !Object.hasOwn(before, 'workData'), 'OFF keeps the existing project metadata shape');
  if (process.platform !== 'win32') { console.log('SKIP encrypted project metadata requires real Windows DPAPI'); return; }
  await setSwitch(true); await api.workDataKeys.ensure();
  const updated = await api.saveMemory({ ...saved.memory, body: 'Synthetic revised convention' }, cwd);
  t.ok(updated.ok, 'existing project memory remains editable after enabling sealing');
  const sealed = fs.readFileSync(metaFile, 'utf8');
  t.ok(JSON.parse(sealed).workData === 2 && !sealed.includes(cwd) && !sealed.includes(path.basename(cwd)), 'project paths and labels are absent from metadata ciphertext');
  const groups = await api.listMemoryProjectGroups('');
  t.ok(groups.some(group => group.projectKey === api.projectKeyForCwd(cwd) && group.path === cwd && group.label === path.basename(cwd)), 'normal project group lookup decrypts its actual label and path');
  const bodyBefore = fs.readFileSync(saved.memory.file, 'utf8');
  const keyFile = path.join(root, 'work-data-key-v1.json'); api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.listMemoryProjectGroups(''), error => String(error.code).startsWith('work_data'));
    await assert.rejects(() => api.saveMemory({ ...saved.memory, body: 'MUST_NOT_WRITE' }, cwd), error => String(error.code).startsWith('work_data'));
    t.ok(fs.readFileSync(metaFile, 'utf8') === sealed && fs.readFileSync(saved.memory.file, 'utf8') === bodyBefore, 'missing metadata key refuses the mutation before changing the existing memory');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); }
  await setSwitch(false);
  await assert.rejects(() => api.saveMemory({ ...saved.memory, body: 'MUST_NOT_DOWNGRADE' }, cwd), { code: 'work_data_store.downgrade_refused' });
  t.ok(fs.readFileSync(metaFile, 'utf8') === sealed && fs.readFileSync(saved.memory.file, 'utf8') === bodyBefore, 'disabled encryption refuses downgrading sealed metadata or partially updating the memory');
})().catch(error => t.fail(error.stack || String(error))).finally(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
