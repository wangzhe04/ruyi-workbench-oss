'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-meta-unit-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const api = require('../lib/server-internals').loadServerInternals([
  'writeMemoryMeta', 'readMemoryProjectMeta', 'memoryProjectDir', 'projectKeyForCwd',
  'readConfig', 'writeConfig', 'WorkDataStore', 'WorkDataCrypto', 'atomicWriteJson',
]);
const master = crypto.randomBytes(32), instanceId = 'memory-meta-unit';
let missing = false, unlocks = 0;
api.WorkDataStore.Hooks.keys = {
  unlock: async () => { unlocks++; if (missing) throw Object.assign(Error('work_data_key.absent'), { code: 'work_data_key.absent' }); return master; },
  instance: async () => instanceId,
};
const cwd = path.join(root, 'synthetic-private-project');
const dir = api.memoryProjectDir(cwd), file = path.join(dir, 'meta.json');
const stamp = '2026-10-23T00:00:00.000Z';
const value = { path: cwd, label: path.basename(cwd), createdAt: stamp };
const setSwitch = async flag => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
after(() => { master.fill(0); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });

test('project meta OFF retains exact legacy bytes and creation time without unlocking keys', async () => {
  await setSwitch(false); fs.mkdirSync(dir, { recursive: true });
  await api.atomicWriteJson(file, value); const before = fs.readFileSync(file, 'utf8'), count = unlocks;
  await api.writeMemoryMeta(dir, cwd);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(await api.readMemoryProjectMeta(dir), value); assert.equal(unlocks, count);
});

test('project meta seals paths and labels and remains readable after disabling, without downgrade', async () => {
  await setSwitch(true); await api.writeMemoryMeta(dir, cwd);
  const sealed = fs.readFileSync(file, 'utf8'); assert.equal(JSON.parse(sealed).workData, 2);
  assert.equal(sealed.includes(cwd), false); assert.equal(sealed.includes(value.label), false);
  assert.deepEqual(await api.readMemoryProjectMeta(dir), value);
  await setSwitch(false);
  assert.deepEqual(await api.readMemoryProjectMeta(dir), value);
  await assert.rejects(() => api.writeMemoryMeta(dir, cwd), { code: 'work_data_store.downgrade_refused' });
  assert.equal(fs.readFileSync(file, 'utf8'), sealed);
});

test('missing key, tampered and truncated project metadata refuse reads and writes without replacing the file', async () => {
  await setSwitch(true); const sealed = fs.readFileSync(file, 'utf8');
  missing = true;
  try {
    await assert.rejects(() => api.readMemoryProjectMeta(dir), { code: 'work_data_key.absent' });
    await assert.rejects(() => api.writeMemoryMeta(dir, cwd), { code: 'work_data_key.absent' });
    assert.equal(fs.readFileSync(file, 'utf8'), sealed);
  } finally { missing = false; }
  const changed = JSON.parse(sealed); changed.keyId = 'work-data-v2.k2';
  for (const broken of [JSON.stringify(changed), '{"workData":2,"envelope":']) {
    fs.writeFileSync(file, broken);
    await assert.rejects(() => api.readMemoryProjectMeta(dir), error => String(error.code).startsWith('work_data'));
    await assert.rejects(() => api.writeMemoryMeta(dir, cwd), error => String(error.code).startsWith('work_data'));
    assert.equal(fs.readFileSync(file, 'utf8'), broken); assert.equal(fs.existsSync(file + '.corrupt'), false);
  }
  fs.writeFileSync(file, sealed);
});

test('project metadata authenticates the destination bucket and rejects validly sealed invalid metadata', async () => {
  const otherCwd = path.join(root, 'other-project'), otherDir = api.memoryProjectDir(otherCwd), otherFile = path.join(otherDir, 'meta.json');
  fs.mkdirSync(otherDir, { recursive: true }); fs.copyFileSync(file, otherFile);
  const moved = fs.readFileSync(otherFile, 'utf8');
  await assert.rejects(() => api.readMemoryProjectMeta(otherDir), error => String(error.code).startsWith('work_data'));
  await assert.rejects(() => api.writeMemoryMeta(otherDir, otherCwd), error => String(error.code).startsWith('work_data'));
  assert.equal(fs.readFileSync(otherFile, 'utf8'), moved);
  const malformed = { workData: 2, ...api.WorkDataCrypto.seal('[]', master, {
    purpose: 'memory', instanceId, schema: 1, scopeId: 'project:' + api.projectKeyForCwd(otherCwd), recordId: 'memory-meta', seq: 1,
  }) };
  const wrongShape = JSON.stringify(malformed); fs.writeFileSync(otherFile, wrongShape);
  await assert.rejects(() => api.readMemoryProjectMeta(otherDir), error => String(error.code).startsWith('work_data'));
  await assert.rejects(() => api.writeMemoryMeta(otherDir, otherCwd), error => String(error.code).startsWith('work_data'));
  assert.equal(fs.readFileSync(otherFile, 'utf8'), wrongShape);
});

test('legacy malformed project metadata retains its optional sidecar recovery contract', async () => {
  await setSwitch(false); const legacyDir = api.memoryProjectDir(path.join(root, 'legacy'));
  fs.mkdirSync(legacyDir, { recursive: true }); fs.writeFileSync(path.join(legacyDir, 'meta.json'), '{legacy broken');
  assert.equal(await api.readMemoryProjectMeta(legacyDir), null);
  await api.writeMemoryMeta(legacyDir, path.join(root, 'legacy'));
  const stored = JSON.parse(fs.readFileSync(path.join(legacyDir, 'meta.json'), 'utf8'));
  assert.equal(stored.path, path.join(root, 'legacy')); assert.equal(Object.hasOwn(stored, 'workData'), false);
});
