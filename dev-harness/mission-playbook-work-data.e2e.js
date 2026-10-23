'use strict';
require('./lib/self-isolate-home');
// Real mission/playbook lifecycle and Windows DPAPI; no synthetic crypto or domain stubs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const t = createRunner('MISSION PLAYBOOK WORK DATA');
const temp = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'ruyi-mission-playbook-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const api = require('./lib/server-internals').loadServerInternals([
  'createMissionContainer', 'patchMissionContainer', 'readMissionContainer', 'missionContainerPath',
  'saveUserPlaybook', 'readPlaybooksFromDir', 'builtinPlaybooksDir', 'loadAllPlaybooks',
  'readConfig', 'writeConfig', 'workDataKeys', 'paths',
]);
const setSwitch = async flag => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = flag;
  await api.writeConfig(config);
};
const privateError = error => String(error && error.code || '').startsWith('work_data');

(async () => {
  await setSwitch(false);
  const created = await api.createMissionContainer({ title: '迁移前的事项', goal: '本机保密事项目标', sessionIds: [] });
  assert.equal(created.ok, true);
  const id = created.mission.missionId, missionFile = api.missionContainerPath(id);
  const builtinId = [...(await api.readPlaybooksFromDir(api.builtinPlaybooksDir())).keys()][0];
  const book = { id: builtinId, title: '本机覆盖模板', promptTemplate: '本机保密模板正文', inputs: [] };
  await api.saveUserPlaybook(book);
  const bookFile = path.join(api.paths.playbooks, builtinId + '.json');
  t.ok(fs.readFileSync(missionFile, 'utf8') === JSON.stringify(created.mission, null, 2)
    && fs.readFileSync(bookFile, 'utf8') === JSON.stringify(book, null, 2), 'OFF keeps both legacy pretty JSON representations');
  t.ok((await api.loadAllPlaybooks()).find(row => row.id === builtinId)?.builtin === false, 'the legacy user file overrides the built-in');
  if (process.platform !== 'win32') {
    console.log('SKIP real DPAPI sealing: Windows only; synthetic crypto coverage is in the unit suite');
    return;
  }
  await setSwitch(true); await api.workDataKeys.ensure();
  const updated = await api.patchMissionContainer(id, { goal: '开启后继续的保密事项目标' });
  assert.equal(updated.ok, true);
  await api.saveUserPlaybook({ ...book, promptTemplate: '开启后继续的保密模板正文' });
  const missionBytes = fs.readFileSync(missionFile, 'utf8'), bookBytes = fs.readFileSync(bookFile, 'utf8');
  t.ok(JSON.parse(missionBytes.split('\n')[0]).workData === 3 && JSON.parse(bookBytes.split('\n')[0]).workData === 3
    && !missionBytes.includes('保密事项目标') && !bookBytes.includes('保密模板正文'), 'resuming both pre-existing records seals their complete contents');
  api.workDataKeys.clear();
  const reloaded = await api.readMissionContainer(id), books = await api.loadAllPlaybooks();
  t.ok(reloaded.goal === updated.mission.goal && books.find(row => row.id === builtinId)?.promptTemplate === '开启后继续的保密模板正文'
    && books.find(row => row.id === builtinId)?.builtin === false, 'fresh key unlock restores the mission and its actual user override');
  t.ok(fs.readFileSync(missionFile, 'utf8') === missionBytes && fs.readFileSync(bookFile, 'utf8') === bookBytes, 'read-only reload creates no rewrite or migration');
  for (const family of [
    { file: missionFile, bytes: missionBytes, read: () => api.readMissionContainer(id), write: () => api.patchMissionContainer(id, { goal: 'must not replace' }) },
    { file: bookFile, bytes: bookBytes, read: api.loadAllPlaybooks, write: () => api.saveUserPlaybook(book) },
  ]) {
    const broken = family.bytes.slice(0, -30); fs.writeFileSync(family.file, broken);
    await assert.rejects(family.read, privateError); await assert.rejects(family.write, privateError);
    t.ok(fs.readFileSync(family.file, 'utf8') === broken && !fs.existsSync(family.file + '.corrupt'), 'broken sealed ' + path.basename(family.file) + ' stays untouched without a missing-record fallback');
    fs.writeFileSync(family.file, family.bytes);
  }
  const keyFile = path.join(api.paths.data, 'work-data-key-v1.json');
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.patchMissionContainer(id, { goal: 'must not replace' }), privateError);
    await assert.rejects(() => api.saveUserPlaybook(book), privateError);
    await assert.rejects(api.loadAllPlaybooks, privateError);
    t.ok(fs.readFileSync(missionFile, 'utf8') === missionBytes && fs.readFileSync(bookFile, 'utf8') === bookBytes, 'missing DPAPI key cannot erase either record or select a same-name built-in');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); }
  await setSwitch(false);
  await assert.rejects(() => api.patchMissionContainer(id, { goal: 'must not downgrade' }), { code: 'work_data_store.downgrade_refused' });
  await assert.rejects(() => api.saveUserPlaybook(book), { code: 'work_data_store.downgrade_refused' });
  t.ok(fs.readFileSync(missionFile, 'utf8') === missionBytes && fs.readFileSync(bookFile, 'utf8') === bookBytes, 'turning the switch off refuses implicit plaintext downgrades');
})().catch(error => { t.fail(error && error.stack || String(error)); }).finally(() => {
  api.workDataKeys.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-mission-playbook-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
