'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const temp = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'ruyi-mission-playbook-work-data-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const api = require('../lib/server-internals').loadServerInternals([
  'readMissionContainer', 'writeMissionContainer', 'missionContainerPath', 'missionContainerStore',
  'readPlaybooksFromDir', 'saveUserPlaybook', 'userPlaybookStore', 'builtinPlaybooksDir', 'loadAllPlaybooks', 'normalizePlaybook',
  'readConfig', 'writeConfig', 'WorkDataStore', 'WorkDataCrypto', 'atomicWriteJson', 'paths',
]);
const master = crypto.randomBytes(32);
let absent = false, unlocks = 0;
api.WorkDataStore.Hooks.keys = {
  unlock: async () => {
    unlocks++;
    if (absent) throw Object.assign(new Error('work_data_key.absent'), { code: 'work_data_key.absent' });
    return master;
  },
  instance: async () => 'mission-playbook-unit',
};
const setSwitch = async flag => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = flag;
  await api.writeConfig(config);
};
const mission = { missionId: 'mission_secret', title: '事项保密标题', goal: '事项保密目标', acceptance: [], sessionIds: [], createdAt: '2026-10-23T00:00:00.000Z' };
const playbook = { id: 'private_book', title: '模板保密标题', promptTemplate: '模板保密正文 {topic}', inputs: [{ key: 'topic', label: '主题', type: 'text' }] };
const playbookFile = name => path.join(api.paths.playbooks, name);
const errorIsPrivate = error => String(error && error.code || '').startsWith('work_data');
after(() => {
  master.fill(0);
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-mission-playbook-work-data-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('OFF preserves mission and user playbook pretty JSON bytes without touching a key', async () => {
  await setSwitch(false);
  const before = unlocks;
  const saved = await api.writeMissionContainer(mission);
  assert.equal(fs.readFileSync(api.missionContainerPath(mission.missionId), 'utf8'), JSON.stringify(saved, null, 2));
  assert.deepEqual(await api.readMissionContainer(mission.missionId), saved);
  await api.saveUserPlaybook(playbook);
  assert.equal(fs.readFileSync(playbookFile(playbook.id + '.json'), 'utf8'), JSON.stringify(playbook, null, 2));
  assert.deepEqual((await api.readPlaybooksFromDir(api.paths.playbooks)).get(playbook.id), api.normalizePlaybook(playbook));
  assert.equal(unlocks, before);
});

test('legacy UTF-8 BOM, UTF-16LE and differing filenames stay readable while built-ins stay ordinary resources', async () => {
  const before = unlocks;
  for (const [name, bytes] of [
    ['Display Name.json', Buffer.from('\uFEFF' + JSON.stringify({ ...playbook, id: 'bom_book' }))],
    ['Unicode Name.json', Buffer.from('\uFEFF' + JSON.stringify({ ...playbook, id: 'unicode_book', legacyData: { workData: 2 } }), 'utf16le')],
  ]) fs.writeFileSync(playbookFile(name), bytes);
  const users = await api.readPlaybooksFromDir(api.paths.playbooks);
  assert.equal(users.get('bom_book').title, playbook.title);
  assert.equal(users.get('unicode_book').title, playbook.title);
  assert.ok((await api.readPlaybooksFromDir(api.builtinPlaybooksDir())).size > 0);
  assert.equal(unlocks, before);
});

test('sealed families round-trip, keep originals off disk, and reject missing keys and broken ciphertext without replacement', async () => {
  await setSwitch(true);
  const saved = await api.writeMissionContainer(mission); await api.saveUserPlaybook(playbook);
  for (const family of [
    { file: api.missionContainerPath(mission.missionId), secret: mission.goal, read: () => api.readMissionContainer(mission.missionId), write: () => api.writeMissionContainer(mission) },
    { file: playbookFile(playbook.id + '.json'), secret: playbook.promptTemplate, read: () => api.readPlaybooksFromDir(api.paths.playbooks), write: () => api.saveUserPlaybook(playbook) },
  ]) {
    const sealed = fs.readFileSync(family.file, 'utf8');
    assert.ok(!sealed.includes(family.secret)); assert.equal(JSON.parse(sealed.split('\n')[0]).workData, 3);
    await family.read(); absent = true;
    try {
      await assert.rejects(family.read, { code: 'work_data_key.absent' });
      await assert.rejects(family.write, { code: 'work_data_key.absent' });
      assert.equal(fs.readFileSync(family.file, 'utf8'), sealed);
    } finally { absent = false; }
    for (const broken of [sealed.slice(0, -30), '{"workData":3,"format":']) {
      fs.writeFileSync(family.file, broken);
      await assert.rejects(family.read, errorIsPrivate); await assert.rejects(family.write, errorIsPrivate);
      assert.equal(fs.readFileSync(family.file, 'utf8'), broken);
      assert.equal(fs.existsSync(family.file + '.corrupt'), false);
    }
    fs.writeFileSync(family.file, sealed);
  }
  assert.deepEqual(await api.readMissionContainer(mission.missionId), saved);
  await setSwitch(false);
  await assert.rejects(() => api.writeMissionContainer(mission), { code: 'work_data_store.downgrade_refused' });
  await assert.rejects(() => api.saveUserPlaybook(playbook), { code: 'work_data_store.downgrade_refused' });
});

test('scope and filename bindings reject copied ciphertext before any quarantine or built-in fallback', async () => {
  await setSwitch(true);
  const copiedMission = api.missionContainerPath('mission_other');
  fs.copyFileSync(api.missionContainerPath(mission.missionId), copiedMission);
  const missionBytes = fs.readFileSync(copiedMission, 'utf8');
  await assert.rejects(() => api.readMissionContainer('mission_other'), errorIsPrivate);
  await assert.rejects(() => api.writeMissionContainer({ ...mission, missionId: 'mission_other' }), errorIsPrivate);
  assert.equal(fs.readFileSync(copiedMission, 'utf8'), missionBytes); assert.equal(fs.existsSync(copiedMission + '.corrupt'), false);
  fs.unlinkSync(copiedMission);
  const builtins = await api.readPlaybooksFromDir(api.builtinPlaybooksDir());
  const builtinId = [...builtins.keys()][0], copiedBook = playbookFile(builtinId + '.json');
  fs.copyFileSync(playbookFile(playbook.id + '.json'), copiedBook);
  const bookBytes = fs.readFileSync(copiedBook, 'utf8');
  await assert.rejects(api.loadAllPlaybooks, errorIsPrivate);
  await assert.rejects(() => api.saveUserPlaybook({ ...playbook, id: builtinId }), errorIsPrivate);
  assert.equal(fs.readFileSync(copiedBook, 'utf8'), bookBytes);
  fs.unlinkSync(copiedBook);
});

test('authenticated but invalid domain plaintext never becomes a quarantined mission or a missing override', async () => {
  const seal = (file, text, binding) => api.atomicWriteJson(file, { workData: 2, ...api.WorkDataCrypto.seal(text, master, {
    instanceId: 'mission-playbook-unit', schema: 1, seq: 1, ...binding,
  }) });
  const invalidMission = api.missionContainerPath('mission_invalid');
  for (const body of ['{}', JSON.stringify({ schema: 1, missionId: 'mission_wrong', title: 'wrong identity' })]) {
    await seal(invalidMission, body, { purpose: 'task', scopeId: 'mission_invalid', recordId: 'mission-container' });
    const before = fs.readFileSync(invalidMission, 'utf8');
    await assert.rejects(() => api.readMissionContainer('mission_invalid'), { code: 'work_data_store.validate' });
    await assert.rejects(() => api.writeMissionContainer({ ...mission, missionId: 'mission_invalid' }), { code: 'work_data_store.validate' });
    assert.equal(fs.readFileSync(invalidMission, 'utf8'), before); assert.equal(fs.existsSync(invalidMission + '.corrupt'), false);
  }
  fs.unlinkSync(invalidMission);
  const builtinId = [...(await api.readPlaybooksFromDir(api.builtinPlaybooksDir())).keys()][0];
  const name = builtinId + '.json', invalidBook = playbookFile(name);
  await seal(invalidBook, '{}', { purpose: 'workflow', scopeId: 'user', recordId: 'playbook:' + crypto.createHash('sha256').update(name).digest('hex') });
  const before = fs.readFileSync(invalidBook, 'utf8');
  await assert.rejects(api.loadAllPlaybooks, { code: 'work_data_store.validate' });
  await assert.rejects(() => api.saveUserPlaybook({ ...playbook, id: builtinId }), { code: 'work_data_store.validate' });
  assert.equal(fs.readFileSync(invalidBook, 'utf8'), before); fs.unlinkSync(invalidBook);
});

test('playbooks larger than the former one-MiB envelope cap remain complete through explicit chunked storage', async () => {
  await setSwitch(true);
  const large = { ...playbook, id: 'large_book', retainedLegacyField: '中文😀'.repeat(150000) };
  const text = JSON.stringify(large, null, 2); assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  await api.saveUserPlaybook(large);
  assert.equal(await api.userPlaybookStore(large.id + '.json').read(), text);
  assert.deepEqual((await api.readPlaybooksFromDir(api.paths.playbooks)).get(large.id), api.normalizePlaybook(large));
  const bomText = '\uFEFF' + JSON.stringify({ ...playbook, id: 'sealed_bom_book' });
  await api.userPlaybookStore('Sealed BOM Display Name.json').write(bomText);
  assert.equal(await api.userPlaybookStore('Sealed BOM Display Name.json').read(), bomText);
  assert.equal((await api.readPlaybooksFromDir(api.paths.playbooks)).get('sealed_bom_book').title, playbook.title);
});

test('invalid legacy domain files keep their existing quarantine or skip behavior', async () => {
  const file = api.missionContainerPath('mission_legacy_bad'); fs.writeFileSync(file, '{broken');
  assert.equal(await api.readMissionContainer('mission_legacy_bad'), null);
  assert.equal(fs.readFileSync(file + '.corrupt', 'utf8'), '{broken');
  fs.writeFileSync(playbookFile('bad-legacy.json'), '{broken');
  assert.equal((await api.readPlaybooksFromDir(api.paths.playbooks)).has('bad-legacy'), false);
});
