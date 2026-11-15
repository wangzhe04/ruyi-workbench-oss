'use strict';
// Actual OS ownership + actual runtime module/turnSettlers. Client identity is synthetic and
// only preparation is exercised; no MCP/native dispatch or history-delivery claim.
const { test: nodeTest, after } = require('node:test');
const test = (name, fn) => nodeTest(name, { skip: process.platform !== 'darwin' }, fn);
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-execution-runtime-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR']) { process.env[key] = path.join(root, key); fs.mkdirSync(process.env[key]); }
const { loadServerInternals } = require('../lib/server-internals');
after(() => fs.rmSync(root, { recursive: true, force: true }));
let count = 0;
async function fixture() {
  const data = path.join(root, 'data-' + (++count)); fs.mkdirSync(data);
  process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const api = loadServerInternals(['ServerOwnership', 'DesktopExecutionRuntime', 'turnSettlers', 'writeStartError']);
  const ownership = await api.ServerOwnership.acquire([data]);
  await api.DesktopExecutionRuntime.initialize(ownership);
  const session = { id: 'sess_runtime', turnSeq: 1, rewindGen: 0 };
  const owner = { driverRunId: 'drun_real', cancelRequested: false };
  api.turnSettlers.set(session.id, owner);
  api.DesktopExecutionRuntime.admit(session, owner);
  return { ...api, ownership, session, owner, data };
}
const client = { clientId: '1'.repeat(32), accWorkerId: '2'.repeat(32), accPid: 12345, contextRequired: true };
const prepare = (f, overrides = {}) => f.DesktopExecutionRuntime.prepare({ session: f.session, owner: f.owner, callId: 'call_fixture', toolName: 'wait', args: { seconds: 0 }, client, ...overrides });

test('actual admitted object prepares against live turn and stores no argument plaintext', async () => {
  const f = await fixture();
  try {
    const first = f.DesktopExecutionRuntime.admit(f.session, f.owner);
    assert.equal(f.DesktopExecutionRuntime.canWriteStartupError(), true);
    assert.equal(f.DesktopExecutionRuntime.admit(f.session, f.owner), first);
    const prepared = await prepare(f, { args: { seconds: 0, note: 'PRIVATE_RUNTIME_ARGUMENT' } });
    const raw = fs.readFileSync(path.join(f.data, 'desktop-executions-v1/state.json'), 'utf8'), row = JSON.parse(raw).entries[0];
    assert.equal(row.admissionId, first); assert.equal(row.turnSeq, 1); assert.equal(row.phase, 'prepared');
    assert.equal(raw.includes('PRIVATE_RUNTIME_ARGUMENT'), false); assert.equal(prepared.snapshot.note, 'PRIVATE_RUNTIME_ARGUMENT');
    await f.DesktopExecutionRuntime.guard(f.session.id);
  } finally { await f.ownership.release(); }
});
test('copying session or owner identities cannot authorize preparation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepare(f, { session: { ...f.session } }), { code: 'execution_admission_lost' });
    await assert.rejects(prepare(f, { owner: { ...f.owner } }), { code: 'execution_admission_lost' });
    assert.throws(() => f.DesktopExecutionRuntime.admit(f.session, { ...f.owner }), { code: 'execution_admission_lost' });
  } finally { await f.ownership.release(); }
});
test('cancel, supersede, sequence or generation mutation makes prior preparation hold the same-process successor', async () => {
  for (const mutation of ['cancel', 'supersede', 'turn', 'rewind', 'driver']) {
    const f = await fixture();
    try {
      await prepare(f);
      if (mutation === 'cancel') f.owner.cancelRequested = true;
      if (mutation === 'supersede') f.turnSettlers.set(f.session.id, { driverRunId: 'drun_next', cancelRequested: false });
      if (mutation === 'turn') f.session.turnSeq++;
      if (mutation === 'rewind') f.session.rewindGen++;
      if (mutation === 'driver') f.owner.driverRunId = 'drun_changed';
      await assert.rejects(f.DesktopExecutionRuntime.guard(f.session.id), { code: 'execution_reconciliation_required' }, mutation);
      const successor = { driverRunId: 'drun_successor', cancelRequested: false };
      f.turnSettlers.set(f.session.id, successor); f.session.turnSeq++;
      f.DesktopExecutionRuntime.admit(f.session, successor);
      await assert.rejects(prepare(f, { owner: successor, callId: 'brand_new_call' }), { code: 'execution_reconciliation_required' }, mutation);
    } finally { await f.ownership.release(); }
  }
});
test('release revokes live preparation and an old finalizer cannot delete a newer admission', async () => {
  const f = await fixture();
  try {
    await prepare(f); f.DesktopExecutionRuntime.release(f.session.id, f.owner);
    await assert.rejects(f.DesktopExecutionRuntime.guard(f.session.id), { code: 'execution_reconciliation_required' });
    const successor = { driverRunId: 'drun_next', cancelRequested: false };
    f.turnSettlers.set(f.session.id, successor); f.session.turnSeq++;
    const next = f.DesktopExecutionRuntime.admit(f.session, successor);
    f.DesktopExecutionRuntime.release(f.session.id, f.owner);
    assert.equal(f.DesktopExecutionRuntime.admit(f.session, successor), next);
    await assert.rejects(prepare(f, { owner: successor, callId: 'next' }), { code: 'execution_reconciliation_required' });
  } finally { await f.ownership.release(); }
});
test('released actual OS owner blocks guard, admit and preparation without writing a new row', async () => {
  const f = await fixture(); await f.ownership.release();
  await assert.rejects(f.DesktopExecutionRuntime.guard(f.session.id), { code: 'execution_owner_lost' });
  assert.throws(() => f.DesktopExecutionRuntime.admit(f.session, f.owner), { code: 'execution_owner_lost' });
  await assert.rejects(prepare(f), { code: 'execution_owner_lost' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'desktop-executions-v1/state.json'))).entries.length, 0);
});
test('replacing owned data directory cannot create a fresh execution authority under the old root lock', async () => {
  const f = await fixture();
  try {
    fs.renameSync(f.data, f.data + '-moved'); fs.mkdirSync(f.data);
    assert.equal(f.DesktopExecutionRuntime.canWriteStartupError(), false);
    await f.writeStartError('startup-failed', 'Must not touch replacement');
    await assert.rejects(f.DesktopExecutionRuntime.guard(f.session.id), { code: 'execution_owner_lost' });
    assert.throws(() => f.DesktopExecutionRuntime.admit(f.session, f.owner), { code: 'execution_owner_lost' });
    await assert.rejects(prepare(f), { code: 'execution_owner_lost' });
    assert.deepEqual(fs.readdirSync(f.data), []);
  } finally { await f.ownership.release(); }
});
test('string, null and nonfinite rewind generations cannot alias a real host generation', async () => {
  const f = await fixture();
  try {
    for (const gen of ['0', 'invalid', null, NaN, Infinity, -1]) {
      f.session.rewindGen = gen;
      assert.throws(() => f.DesktopExecutionRuntime.admit(f.session, f.owner), { code: 'execution_admission_lost' });
      await assert.rejects(prepare(f), { code: 'execution_admission_lost' });
    }
  } finally { await f.ownership.release(); }
});
test('replacement between acquiring OS ownership and initializing runtime cannot reset execution evidence', async () => {
  const data = path.join(root, 'before-init-' + (++count)); fs.mkdirSync(data);
  process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const api = loadServerInternals(['ServerOwnership', 'DesktopExecutionRuntime']);
  const owner = await api.ServerOwnership.acquire([data]);
  try {
    fs.renameSync(data, data + '-original'); fs.mkdirSync(data);
    assert.equal(owner.isHeld(), true, 'kernel handles remain owned, independently of directory identity');
    assert.equal(owner.isRootCurrent(owner.roots[0]), false);
    await assert.rejects(api.DesktopExecutionRuntime.initialize(owner), { code: 'execution_owner_lost' });
    assert.deepEqual(fs.readdirSync(data), []);
  } finally { await owner.release(); }
});
test('cold missing data root binds its first identity under the original startup gate', async () => {
  const data = path.join(root, 'cold-missing-' + (++count));
  process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const api = loadServerInternals(['ServerOwnership', 'DesktopExecutionRuntime']);
  const owner = await api.ServerOwnership.acquire([data]);
  try {
    assert.equal(fs.existsSync(data), false);
    await api.DesktopExecutionRuntime.initialize(owner); await owner.releaseStartup();
    assert.equal(owner.isRootCurrent(owner.roots[0]), true);
    await api.DesktopExecutionRuntime.guard('sess_cold');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'desktop-executions-v1/state.json'))).entries, []);
  } finally { await owner.release(); }
});
test('legacy migration binds the acquired source inode even when its old name becomes a symlink', async () => {
  const source = path.join(root, 'migration-old-' + (++count)), data = path.join(root, 'migration-new-' + count);
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'keep'), 'historical evidence');
  process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const api = loadServerInternals(['ServerOwnership', 'DesktopExecutionRuntime']);
  const owner = await api.ServerOwnership.acquire([source, data]);
  try {
    fs.renameSync(source, data); fs.symlinkSync(data, source, 'dir');
    await owner.confirmRoot(data, source);
    await api.DesktopExecutionRuntime.initialize(owner); await owner.releaseStartup();
    assert.equal(fs.readFileSync(path.join(data, 'keep'), 'utf8'), 'historical evidence');
    await api.DesktopExecutionRuntime.guard('sess_migration');
  } finally { await owner.release(); }
});
test('confirmed legacy rename releases startup gate when creating the old junction failed', async () => {
  const source = path.join(root, 'no-junction-old-' + (++count)), data = path.join(root, 'no-junction-new-' + count);
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'keep'), 'retained without junction');
  process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  const api = loadServerInternals(['ServerOwnership', 'DesktopExecutionRuntime']);
  const owner = await api.ServerOwnership.acquire([source, data]);
  try {
    fs.renameSync(source, data);
    await owner.confirmRoot(data, source);
    await api.DesktopExecutionRuntime.initialize(owner); await owner.releaseStartup();
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(data, 'keep'), 'utf8'), 'retained without junction');
    await api.DesktopExecutionRuntime.guard('sess_without_junction');
  } finally { await owner.release(); }
});

test('candidate owned ACC environment covers recognized aliases and overrides context-off entry env', async () => {
  const f = await fixture(), before = process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS;
  try {
    process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS = '1';
    for (const descriptor of [
      { id: 'ai-computer-control' },
      { id: 'renamed', command: 'python', args: ['-m', 'ai_computer_control.server'] },
      { id: 'dropin', command: '/fixture/ai-computer-control' }]) {
      const env = f.DesktopExecutionRuntime.clientEnvironment(descriptor.id, { RUYI_EXECUTION_CONTEXT_REQUIRED: '0', KEEP: 'value' }, descriptor);
      assert.equal(env.RUYI_EXECUTION_CONTEXT_REQUIRED, '1'); assert.equal(env.KEEP, 'value');
    }
    const original = { KEEP: 'value' };
    assert.equal(f.DesktopExecutionRuntime.clientEnvironment('unrelated', original, { id: 'unrelated', command: 'custom' }), original);
  } finally { if (before === undefined) delete process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS; else process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS = before; await f.ownership.release(); }
});
