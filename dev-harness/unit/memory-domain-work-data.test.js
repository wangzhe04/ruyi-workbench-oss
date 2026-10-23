'use strict';
require('../lib/self-isolate-home');
// Exercise real family functions and crypto with a synthetic in-memory key set on every platform.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-work-data-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const api = require('../lib/server-internals').loadServerInternals([
  'readMemoryRelations', 'writeMemoryRelations', 'memoryRelationsFile',
  'readMemoryProposalState', 'writeMemoryProposalState', 'memoryProposalStateFile',
  'readConfig', 'writeConfig', 'WorkDataStore', 'atomicWriteJson',
]);
const master = crypto.randomBytes(32);
let absent = false;
api.WorkDataStore.Hooks.keys = {
  unlock: async () => {
    if (absent) throw Object.assign(new Error('work_data_key.absent'), { code: 'work_data_key.absent' });
    return master;
  },
  instance: async () => 'memory-domain-unit',
};
const setSwitch = async enabled => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = enabled;
  await api.writeConfig(config);
};
const relation = { id: 'rel_1', type: 'supports', from: 'mem_a', to: 'mem_b', note: '关系保密正文', confirmed: false };
const proposal = { schema: 1, lastEvaluatedTurn: 2, lastShownTurn: 1, current: { id: 'proposal_1', status: 'pending', proposal: { body: '候选保密正文' } }, history: [] };
const families = [
  { name: 'relations', file: api.memoryRelationsFile('global', root), value: [relation],
    read: () => api.readMemoryRelations('global', root), write: value => api.writeMemoryRelations('global', root, value), secret: relation.note },
  { name: 'proposals', file: api.memoryProposalStateFile('session_memory'), value: proposal,
    read: () => api.readMemoryProposalState('session_memory'), write: value => api.writeMemoryProposalState('session_memory', value), secret: proposal.current.proposal.body },
];
after(() => { master.fill(0); fs.rmSync(root, { recursive: true, force: true }); });

for (const family of families) {
  test(family.name + ': legacy bytes, sealed round-trip, missing key, tamper, and no downgrade', async () => {
    await setSwitch(false);
    await family.write(family.value);
    const reference = path.join(root, family.name + '-reference.json');
    await api.atomicWriteJson(reference, family.value);
    assert.equal(fs.readFileSync(family.file, 'utf8'), fs.readFileSync(reference, 'utf8'));
    assert.deepEqual(await family.read(), family.value);
    await setSwitch(true);
    await family.write(family.value);
    const sealed = fs.readFileSync(family.file, 'utf8');
    assert.equal(JSON.parse(sealed).workData, 2);
    assert.equal(sealed.includes(family.secret), false);
    assert.deepEqual(await family.read(), family.value);
    absent = true;
    try {
      await assert.rejects(family.read, { code: 'work_data_key.absent' });
      await assert.rejects(() => family.write(family.value), { code: 'work_data_key.absent' });
      assert.equal(fs.readFileSync(family.file, 'utf8'), sealed);
    } finally { absent = false; }
    const tampered = JSON.parse(sealed); tampered.keyId = 'work-data-v2.k2';
    const broken = JSON.stringify(tampered);
    fs.writeFileSync(family.file, broken);
    await assert.rejects(family.read, error => String(error.code).startsWith('work_data'));
    await assert.rejects(() => family.write(family.value), error => String(error.code).startsWith('work_data'));
    assert.equal(fs.readFileSync(family.file, 'utf8'), broken);
    for (const truncated of ['{"workData":2,"ciphertext":', sealed.slice(0, -20)]) {
      fs.writeFileSync(family.file, truncated);
      await assert.rejects(family.read, { code: 'work_data_store.corrupt' });
      await assert.rejects(() => family.write(family.value), { code: 'work_data_store.corrupt' });
      assert.equal(fs.readFileSync(family.file, 'utf8'), truncated, 'truncated ciphertext must survive the rejected write byte for byte');
    }
    fs.writeFileSync(family.file, sealed);
    await setSwitch(false);
    assert.deepEqual(await family.read(), family.value);
    await assert.rejects(() => family.write(family.value), { code: 'work_data_store.downgrade_refused' });
    assert.equal(fs.readFileSync(family.file, 'utf8'), sealed);
  });
}

test('proposal capacity applies to plaintext even when the sealed envelope exceeds 256 KB', async () => {
  await setSwitch(true);
  const state = { ...proposal, current: { proposal: { body: '中'.repeat(70000) } } };
  await api.writeMemoryProposalState('session_large', state);
  const file = api.memoryProposalStateFile('session_large');
  assert.ok(fs.statSync(file).size > 256 * 1024);
  assert.deepEqual(await api.readMemoryProposalState('session_large'), state);
  const { workData, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rest, workData }));
  assert.deepEqual(await api.readMemoryProposalState('session_large'), state, 'a marker after the ciphertext is still detected');
});

test('oversized truncated containers with markers crossing scan chunks never become empty state', async () => {
  await setSwitch(true);
  const file = api.memoryProposalStateFile('session_split_marker');
  const broken = ' '.repeat(65530) + '{"workData"' + ' '.repeat(70000) + ':2,"ciphertext":' + ' '.repeat(200000);
  fs.writeFileSync(file, broken);
  await assert.rejects(() => api.readMemoryProposalState('session_split_marker'), { code: 'work_data_store.corrupt' });
  await assert.rejects(() => api.writeMemoryProposalState('session_split_marker', proposal), { code: 'work_data_store.corrupt' });
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('JSON and text adapters reject direct overwrites of syntactically broken marked containers', async () => {
  for (const kind of ['createJson', 'createText']) {
    const file = path.join(root, kind + '-truncated.json');
    let enabled = true;
    const store = api.WorkDataStore[kind]({
      file: () => file, purpose: 'memory', schemaVersion: 1, scopeId: 'global', recordId: 'broken-test',
      defaultValue: () => ({ schema: 1 }), writeJson: api.atomicWriteJson,
      enabled: async () => enabled,
    });
    const broken = '{"workData":2,"ciphertext":';
    fs.writeFileSync(file, broken);
    for (const flag of [true, false]) {
      enabled = flag;
      await assert.rejects(() => store.read(), { code: 'work_data_store.corrupt' });
      await assert.rejects(() => store.write(kind === 'createText' ? '{}' : { schema: 1 }), { code: 'work_data_store.corrupt' });
      assert.equal(fs.readFileSync(file, 'utf8'), broken);
      assert.equal(fs.existsSync(file + '.corrupt'), false, 'marked ciphertext is not quarantined as legacy plaintext');
    }
    fs.writeFileSync(file, '{legacy broken');
    if (kind === 'createText') assert.equal(await store.read(), '{legacy broken');
    else assert.deepEqual(await store.read(), { schema: 1 });
    const nested = { schema: 1, current: { workData: 2 } };
    fs.writeFileSync(file, JSON.stringify(nested));
    await store.write(kind === 'createText' ? JSON.stringify(nested) : nested);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), nested, 'valid nested business fields are not container markers');
  }
});

test('ciphertext cannot move between sessions or project/global relation scopes', async () => {
  await setSwitch(true);
  await api.writeMemoryProposalState('session_source', proposal);
  const source = api.memoryProposalStateFile('session_source'), destination = api.memoryProposalStateFile('session_other');
  fs.copyFileSync(source, destination);
  const before = fs.readFileSync(destination, 'utf8');
  await assert.rejects(() => api.readMemoryProposalState('session_other'), error => String(error.code).startsWith('work_data'));
  await assert.rejects(() => api.writeMemoryProposalState('session_other', proposal), error => String(error.code).startsWith('work_data'));
  assert.equal(fs.readFileSync(destination, 'utf8'), before);
  const globalFile = api.memoryRelationsFile('global', root), projectFile = api.memoryRelationsFile('project', root);
  fs.mkdirSync(path.dirname(projectFile), { recursive: true }); fs.copyFileSync(globalFile, projectFile);
  await assert.rejects(() => api.readMemoryRelations('project', root), error => String(error.code).startsWith('work_data'));
  await assert.rejects(() => api.writeMemoryRelations('project', root, [relation]), error => String(error.code).startsWith('work_data'));
  assert.equal(fs.readFileSync(projectFile, 'utf8'), fs.readFileSync(globalFile, 'utf8'));
});

test('legacy bad plaintext still returns empty and relation filtering stays unchanged', async () => {
  await setSwitch(false);
  const file = api.memoryRelationsFile('project', path.join(root, 'legacy'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([relation, { ...relation, id: '../bad' }, { ...relation, type: 'unknown' }]));
  assert.deepEqual(await api.readMemoryRelations('project', path.join(root, 'legacy')), [relation]);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(await api.readMemoryRelations('project', path.join(root, 'legacy')), []);
  const proposalFile = api.memoryProposalStateFile('session_bad');
  fs.writeFileSync(proposalFile, '{broken');
  assert.deepEqual(await api.readMemoryProposalState('session_bad'), { schema: 1, history: [] });
  const oversizedFile = api.memoryProposalStateFile('session_oversized');
  fs.writeFileSync(oversizedFile, JSON.stringify({ current: { body: 'x'.repeat(270000) } }));
  assert.deepEqual(await api.readMemoryProposalState('session_oversized'), { schema: 1, history: [] });
  fs.mkdirSync(api.memoryProposalStateFile('session_directory'));
  assert.deepEqual(await api.readMemoryProposalState('session_directory'), { schema: 1, history: [] });
});
