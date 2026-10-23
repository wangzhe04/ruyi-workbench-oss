'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const temp = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'ruyi-personal-visits-unit-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const reference = require('../lib/server-internals').loadServerInternals(['normalizeAgentWorkflow', 'BUILTIN_AGENT_WORKFLOWS', 'safeJsonParse', 'runKeyedChain']);
const clone = value => JSON.parse(JSON.stringify(value));
const privacyError = error => String(error && error.code || '').startsWith('work_data');
const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const personalNames = ['personalAgentWorkflowStore', 'readPersonalAgentWorkflows', 'projectAgentWorkflowsFile', 'readProjectAgentWorkflows', 'getAgentWorkflows', 'saveAgentWorkflow', 'deleteAgentWorkflow'];
const visitNames = ['stewardVisitsDir', 'stewardVisitFileName', 'stewardVisitStore', 'stewardUnusedVisitFile', 'stewardTrimVisits', 'stewardArchiveConversation'];
const blocks = (file, names) => names.map(name => {
  const block = functionBlock(source(file), name); assert.ok(block.length > 20, 'real function exists: ' + name); return block;
}).join('\n');
function fixture() {
  const fx = loadWorkDataChunks(), key = crypto.randomBytes(32), dir = path.join(root, crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const state = { enabled: false, missing: false, unlocks: 0, failWrite: false, mutations: 0, loads: 0, rejectMutation: false, bumpGeneration: false,
    live: { id: 'steward', rewindGen: 0, summary: '旧摘要', attachments: [{ name: '附件' }], stewardTaint: true,
      claudeSessionId: 'old-cli', providerHistory: [{ role: 'user', content: 'provider old' }],
      messages: [{ role: 'user', content: '保密原文甲', createdAt: '2026-10-22T01:00:00.000Z' }, { role: 'assistant', content: '保密答复乙', createdAt: '2026-10-22T01:01:00.000Z' }] },
    runtime: { conversationGeneration: 0 } };
  fx.store.Hooks.keys = { unlock: async () => { state.unlocks++; if (state.missing) throw Object.assign(new Error('absent'), { code: 'work_data_key.absent' }); return key; }, instance: async () => 'personal-visits-unit' };
  const sandbox = { require, Buffer, process, console, path, crypto, fsp,
    paths: { agentWorkflows: path.join(dir, 'workflows') }, WorkDataStore: fx.store,
    normalizeAgentWorkflow: reference.normalizeAgentWorkflow, BUILTIN_AGENT_WORKFLOWS: reference.BUILTIN_AGENT_WORKFLOWS, safeJsonParse: reference.safeJsonParse,
    readConfig: async () => ({ workDataEncryptionV1: state.enabled }),
    atomicWriteJson: async (...args) => { if (state.failWrite) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fx.atomicWriteJson(...args); },
    stewardDir: () => path.join(dir, 'steward'), STEWARD_VISITS_DIR: 'visits', STEWARD_VISITS_KEEP: 200, STEWARD_VISIT_SCHEMA: 1, STEWARD_SESSION_ID: 'steward',
    stewardRunnerRuntime: state.runtime, stewardArchiveChains: new Map(), runKeyedChain: reference.runKeyedChain,
    nowIso: () => '2026-10-23T05:00:00.000Z', makeId: prefix => state.fixedId || prefix + '_' + crypto.randomBytes(4).toString('hex'), logEvent: () => {},
    readSessionNotes: async () => ({ entries: [{ text: '保密备注' }] }),
    loadSession: async () => { state.loads++; if (state.loadError) throw state.loadError; return clone(state.live); },
    mutateSession: async (_id, work) => {
      state.mutations++;
      if (state.onMutation) state.onMutation();
      if (state.mutationWait) await state.mutationWait;
      if (state.mutationError) throw state.mutationError;
      const names = await fsp.readdir(path.join(dir, 'steward', 'visits'));
      state.archivePersistedBeforeMutation = names.some(name => fs.statSync(path.join(dir, 'steward', 'visits', name)).size > 0);
      const fresh = clone(state.live);
      if (state.bumpGeneration) state.runtime.conversationGeneration++;
      const result = work(fresh);
      if (result?.abort || state.rejectMutation) return { ok: false };
      state.live = fresh; return { ok: true };
    },
  };
  const names = [...personalNames, ...visitNames];
  vm.runInNewContext(blocks('08-agent-runs.js', personalNames) + '\n' + blocks('13q-steward-runner-turn.js', visitNames) + '\nglobalThis.api = {' + names.join(',') + '};', sandbox);
  return { api: sandbox.api, state, dir, key, file: id => path.join(dir, 'workflows', id + '.json'), close: () => key.fill(0) };
}
const workflow = { id: 'private_flow', title: '保密个人工作流', description: '保密描述', nodes: [{ id: 'one', task: '保密步骤正文' }] };
after(() => {
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-personal-visits-unit-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('personal OFF bytes, hand-maintained filenames and legacy invalid-file filtering stay compatible', async () => {
  const f = fixture();
  try {
    const saved = await f.api.saveAgentWorkflow('personal', f.dir, workflow);
    assert.equal(fs.readFileSync(f.file(workflow.id), 'utf8'), JSON.stringify(saved, null, 2));
    assert.equal(f.state.unlocks, 0);
    fs.writeFileSync(path.join(f.dir, 'workflows', 'Display Name 中文.json'), JSON.stringify({ ...workflow, id: 'hand_named' }));
    fs.writeFileSync(path.join(f.dir, 'workflows', 'bad.json'), '{bad');
    assert.deepEqual(Array.from(await f.api.readPersonalAgentWorkflows(), row => row.id).sort(), ['hand_named', workflow.id].sort());
    assert.equal(f.state.unlocks, 0);
    const project = await f.api.saveAgentWorkflow('project', f.dir, { ...workflow, title: '项目覆盖' });
    assert.equal((await f.api.getAgentWorkflows(f.dir)).find(row => row.id === workflow.id).title, project.title);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, '.ruyi', 'workflows.json'), 'utf8')).workData, undefined);
  } finally { f.close(); }
});

test('POSIX readdir filenames retain literal backslashes instead of selecting a different tail file', () => {
  const fx = loadWorkDataChunks();
  const factory = vm.runInNewContext(functionBlock(source('08-agent-runs.js'), 'personalAgentWorkflowStore') + '\npersonalAgentWorkflowStore;', {
    path: path.posix, process: { platform: 'linux' }, crypto, WorkDataStore: fx.store,
    paths: { agentWorkflows: '/data/workflows' }, readConfig: async () => ({ workDataEncryptionV1: false }),
    atomicWriteJson: fx.atomicWriteJson, normalizeAgentWorkflow: reference.normalizeAgentWorkflow,
  });
  const name = ['Team', 'Manual.json'].join(String.fromCharCode(92));
  assert.equal(factory(name).filePath(), '/data/workflows/' + name);
  assert.notEqual(factory(name).filePath(), factory('Manual.json').filePath());
});

test('personal ON seals large workflows and missing keys/tampering never hide or overwrite the personal layer', async () => {
  const f = fixture(); f.state.enabled = true;
  try {
    const large = { ...workflow, nodes: Array.from({ length: 64 }, (_v, i) => ({ id: 'n' + i, task: '长步骤'.repeat(5000) })) };
    const saved = await f.api.saveAgentWorkflow('personal', f.dir, large);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 1024 * 1024);
    const file = f.file(workflow.id), bytes = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(bytes.split('\n')[0]).workData, 3); assert.equal(bytes.includes('长步骤'), false);
    assert.equal((await f.api.readPersonalAgentWorkflows())[0].nodes.length, 64);
    f.state.missing = true;
    await assert.rejects(() => f.api.readPersonalAgentWorkflows(), privacyError);
    await assert.rejects(() => f.api.saveAgentWorkflow('personal', f.dir, workflow), privacyError);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); f.state.missing = false;
    fs.writeFileSync(file, bytes.slice(0, -30));
    await assert.rejects(() => f.api.readPersonalAgentWorkflows(), privacyError);
    await assert.rejects(() => f.api.saveAgentWorkflow('personal', f.dir, workflow), privacyError);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes.slice(0, -30)); fs.writeFileSync(file, bytes);
    f.state.enabled = false;
    await assert.rejects(() => f.api.saveAgentWorkflow('personal', f.dir, workflow), { code: 'work_data_store.downgrade_refused' });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(await f.api.deleteAgentWorkflow('personal', f.dir, workflow.id), true, 'explicit deletion retains its existing semantics');
  } finally { f.close(); }
});

test('personal file identity prevents ciphertext transplant and authenticated wrong shapes cannot be sanitized away', async () => {
  const f = fixture(); f.state.enabled = true;
  try {
    await f.api.saveAgentWorkflow('personal', f.dir, workflow);
    const bytes = fs.readFileSync(f.file(workflow.id), 'utf8');
    const other = f.file('different_name'); fs.writeFileSync(other, bytes);
    await assert.rejects(() => f.api.readPersonalAgentWorkflows(), privacyError); fs.unlinkSync(other);
    const named = f.api.personalAgentWorkflowStore('Display Name 中文.json');
    await named.write(JSON.stringify({ ...reference.normalizeAgentWorkflow(workflow, { source: 'personal' }), id: 'different_payload_id' }));
    assert.equal((await f.api.readPersonalAgentWorkflows()).some(row => row.id === 'different_payload_id'), true);
    await f.api.personalAgentWorkflowStore(workflow.id + '.json').write(JSON.stringify({ schemaVersion: 1, nodes: [] }));
    const wrong = fs.readFileSync(f.file(workflow.id), 'utf8');
    await assert.rejects(() => f.api.readPersonalAgentWorkflows(), { code: 'work_data_store.validate' });
    await assert.rejects(() => f.api.saveAgentWorkflow('personal', f.dir, workflow), privacyError);
    assert.equal(fs.readFileSync(f.file(workflow.id), 'utf8'), wrong);
  } finally { f.close(); }
});

test('visit OFF keeps exact old archive bytes and persists before live truncation', async () => {
  const f = fixture();
  try {
    const before = clone(f.state.live.messages), startedAt = '2026-10-22T02:00:00.000Z';
    const result = await f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
    assert.equal(result.file, f.api.stewardVisitFileName(startedAt), 'normal OFF archives keep their existing deterministic filename');
    const file = path.join(f.api.stewardVisitsDir(), result.file);
    const expected = { schema: 1, sessionId: 'steward', startedAt, archivedAt: '2026-10-23T05:00:00.000Z', retention: 'visit', messages: before };
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(expected, null, 2));
    assert.equal(f.state.archivePersistedBeforeMutation, true); assert.equal(f.state.live.messages.length, 0); assert.equal(f.state.unlocks, 0);
  } finally { f.close(); }
});

test('visit ON seals >1MiB archives; reset retains notes and generation rollback removes only the new archive', async () => {
  const f = fixture(); f.state.enabled = true;
  try {
    f.state.live.messages = [{ role: 'user', content: '归档保密正文'.repeat(100000), createdAt: '2026-10-22T01:00:00.000Z' }];
    const result = await f.api.stewardArchiveConversation({}, '2026-10-22T03:00:00.000Z', { reset: true });
    const file = path.join(f.api.stewardVisitsDir(), result.file), bytes = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(bytes.split('\n')[0]).workData, 3); assert.equal(bytes.includes('归档保密正文'), false);
    const opened = JSON.parse(await f.api.stewardVisitStore(file).read());
    assert.ok(Buffer.byteLength(JSON.stringify(opened)) > 1024 * 1024);
    assert.equal(opened.sessionNotes.entries[0].text, '保密备注');
    assert.equal(f.state.archivePersistedBeforeMutation, true);
    assert.equal(f.state.live.summary, ''); assert.equal(f.state.live.providerHistory.length, 0); assert.equal(f.state.live.attachments.length, 0);
    f.state.live.messages = [{ role: 'user', content: '不能截断', createdAt: '2026-10-22T04:00:00.000Z' }];
    const before = clone(f.state.live), previous = fs.readdirSync(f.api.stewardVisitsDir()).sort();
    f.state.bumpGeneration = true;
    const rolledBack = await f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, '2026-10-22T05:00:00.000Z', { generation: 0 });
    assert.equal(rolledBack.archived, 0); assert.deepEqual(clone(f.state.live), before);
    assert.deepEqual(fs.readdirSync(f.api.stewardVisitsDir()).sort(), previous);
  } finally { f.close(); }
});

test('existing valid archives survive a CAS rollback in both plain and sealed modes', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(); f.state.enabled = enabled;
    try {
      const startedAt = '2026-10-22T07:00:00.000Z';
      const file = path.join(f.api.stewardVisitsDir(), f.api.stewardVisitFileName(startedAt));
      await f.api.stewardVisitStore(file).write(JSON.stringify({ schema: 1, sessionId: 'steward', messages: [{ role: 'user', content: 'OLDER VALID ARCHIVE' }] }));
      const previous = fs.readFileSync(file, 'utf8'), live = clone(f.state.live);
      f.state.bumpGeneration = true;
      const result = await f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt, { generation: 0 });
      assert.equal(result.archived, 0); assert.deepEqual(clone(f.state.live), live);
      assert.equal(fs.readFileSync(file, 'utf8'), previous, 'rollback cannot delete or replace an older valid archive');
      assert.deepEqual(fs.readdirSync(f.api.stewardVisitsDir()), [path.basename(file)]);
    } finally { f.close(); }
  }
});

test('successful collisions preserve old files and retry a colliding generated suffix', async () => {
  const f = fixture(); f.state.enabled = true; f.state.fixedId = 'archive_same';
  try {
    const startedAt = '2026-10-22T08:00:00.000Z', base = path.join(f.api.stewardVisitsDir(), f.api.stewardVisitFileName(startedAt));
    const suffix = base.replace('.json', '-archive_same-1.json');
    for (const file of [base, suffix]) await f.api.stewardVisitStore(file).write(JSON.stringify({ schema: 1, sessionId: 'steward', messages: [{ content: 'KEEP ' + path.basename(file) }] }));
    const previous = [base, suffix].map(file => fs.readFileSync(file, 'utf8'));
    const result = await f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
    assert.equal(result.archived, 2); assert.equal(result.file, path.basename(base.replace('.json', '-archive_same-2.json')));
    assert.equal(f.state.live.messages.length, 0);
    assert.deepEqual([base, suffix].map(file => fs.readFileSync(file, 'utf8')), previous);
    assert.equal(JSON.parse(await f.api.stewardVisitStore(path.join(f.api.stewardVisitsDir(), result.file)).read()).messages.length, 2);
  } finally { f.close(); }
});

test('concurrent same-process archive calls serialize their session snapshots and do not consume the same turns twice', async () => {
  const f = fixture(); f.state.enabled = true;
  let release;
  try {
    const startedAt = '2026-10-22T09:00:00.000Z';
    let reachedMutation;
    const reached = new Promise(resolve => { reachedMutation = resolve; });
    f.state.mutationWait = new Promise(resolve => { release = resolve; });
    f.state.onMutation = reachedMutation;
    const first = f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
    await reached;
    const second = f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.loads, 1, 'second transaction cannot snapshot the session before first finishes');
    release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.archived), [2, 0]);
    assert.equal(fs.readdirSync(f.api.stewardVisitsDir()).length, 1); assert.equal(f.state.live.messages.length, 0);
  } finally { if (release) release(); f.close(); }
});

test('mutation key failures roll back only the new archive and propagate without poisoning the archive chain', async () => {
  const f = fixture(); f.state.enabled = true;
  try {
    const startedAt = '2026-10-22T10:00:00.000Z', file = path.join(f.api.stewardVisitsDir(), f.api.stewardVisitFileName(startedAt));
    await f.api.stewardVisitStore(file).write(JSON.stringify({ schema: 1, sessionId: 'steward', messages: [{ content: 'OLDER' }] }));
    const previous = fs.readFileSync(file, 'utf8'), live = clone(f.state.live);
    f.state.mutationError = Object.assign(new Error('key lost during CAS'), { code: 'work_data_key.absent' });
    await assert.rejects(() => f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), { code: 'work_data_key.absent' });
    assert.equal(fs.readFileSync(file, 'utf8'), previous); assert.deepEqual(clone(f.state.live), live);
    assert.deepEqual(fs.readdirSync(f.api.stewardVisitsDir()), [path.basename(file)]);
    f.state.mutationError = null;
    assert.equal((await f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt)).archived, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  } finally { f.close(); }
});

test('visit missing keys, load failures, corrupt old archives and disk errors leave live conversation untouched', async () => {
  const f = fixture(); f.state.enabled = true;
  try {
    const before = clone(f.state.live), startedAt = '2026-10-22T06:00:00.000Z';
    f.state.missing = true;
    await assert.rejects(() => f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), privacyError);
    assert.deepEqual(f.state.live, before); assert.equal(f.state.mutations, 0);
    f.state.missing = false; f.state.failWrite = true;
    await assert.rejects(() => f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), { code: 'ENOSPC' });
    assert.deepEqual(f.state.live, before); assert.equal(f.state.mutations, 0);
    f.state.failWrite = false;
    const file = path.join(f.api.stewardVisitsDir(), f.api.stewardVisitFileName(startedAt));
    fs.writeFileSync(file, '{"workData":3,"format":');
    await assert.rejects(() => f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), privacyError);
    assert.deepEqual(f.state.live, before); assert.equal(f.state.mutations, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"workData":3,"format":');
    f.state.loadError = Object.assign(new Error('unreadable session'), { code: 'work_data_store.corrupt' });
    await assert.rejects(() => f.api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), privacyError);
    assert.deepEqual(f.state.live, before);
  } finally { f.close(); }
});

test('visit pruning keeps the newest 200 filenames without reading archive contents', async () => {
  const f = fixture();
  try {
    const dir = f.api.stewardVisitsDir(); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 202; i++) fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.json'), 'archive fixture');
    await f.api.stewardTrimVisits();
    const remaining = fs.readdirSync(dir).sort(); assert.equal(remaining.length, 200); assert.equal(remaining[0], '0002.json');
  } finally { f.close(); }
});
