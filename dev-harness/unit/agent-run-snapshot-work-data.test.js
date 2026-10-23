'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const repo = process.env.RUYI_SNAPSHOT_DRAFT_REPO || path.resolve(__dirname, '../..');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-snapshot-unit-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), root));
const appDir = path.join(repo, 'ruyi-workbench/app'), src = path.join(appDir, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const names = ['saveAgentRun', 'listAgentRuns', 'listAgentRunDigests', 'readAgentRunRecord', 'readAgentRunSnapshot', 'agentRunSnapshotStore',
  'agentRunFile', 'agentRunWriteChains', 'agentRunEventChains', 'agentRunDigestCache', 'agentRunDigestStats', 'readConfig', 'writeConfig', 'WorkDataStore', 'activeAgentRuns',
  'stewardReadRunSnapshot', 'stewardRunResumeTier', 'launchPersistedAgentRun', 'sweepAgentRunEventsStore', 'EventStreamHooks', 'agentRunSaveFailures',
  'markInterruptedAgentRuns', 'markInterruptedInterventions', 'interventionFilePath', 'handleAgentRunApiRoutes', 'createSession', 'getPretenderProjectionIndex',
  'pretenderIndexRuntime', 'pretenderRunSourceAuth'];
const mod = new Module(path.join(appDir, 'server.js'), module); mod.filename = path.join(appDir, 'server.js'); mod.paths = Module._nodeModulePaths(appDir);
const source = manifest.modules.map(item => {
  const candidate = path.join(__dirname, 'src', item.file);
  return fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(src, item.file), 'utf8');
}).join('\n');
mod._compile(source + '\nmodule.exports.__snapshotTest = {' + names.join(',') + '}; module.exports.__snapshotEval = code => eval(code);', mod.filename);
const api = mod.exports.__snapshotTest;
const actionState = mod.exports.__snapshotEval(`(() => {
  const state = { apply: 0, cleanup: 0 };
  tokenOk = () => true; readJsonBody = async req => req.fixtureBody || {};
  send = (res, result) => { res.result = result; return true; };
  applyAgentWorktree = async () => { state.apply++; return { ok: true }; };
  cleanupAgentWorktree = async () => { state.cleanup++; };
  return state;
})()`);
let master = crypto.randomBytes(32), instance = 'snapshot-unit', absent = false, unlocks = 0, clearOnInstance = false;
api.WorkDataStore.Hooks.keys = {
  unlock: async () => { unlocks++; if (absent) throw Object.assign(new Error('work_data_key.absent'), { code: 'work_data_key.absent' }); return master; },
  instance: async () => { if (clearOnInstance) { clearOnInstance = false; master.fill(0); } return instance; },
};
const toggle = async flag => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
const run = (id = 'run_aa', sessionId = 'sess_snapshot') => ({ id, sessionId, status: 'completed', createdAt: '2026-01-01T00:00:00Z', nodes: [{ id: 'n1', status: 'succeeded', result: 'SYNTHETIC-PRIVATE-SNAPSHOT' }] });
const privateError = error => String(error && error.code || '').startsWith('work_data');
after(async () => {
  clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer);
  await Promise.all([...api.agentRunWriteChains.values(), ...api.agentRunEventChains.values()].map(value => value.catch(() => {})));
  master.fill(0); assert.equal(path.dirname(root), tempBase); fs.rmSync(root, { recursive: true, force: true });
});

test('snapshot draft preserves OFF bytes and submission-time capture without key access', async () => {
  await toggle(false); const before = unlocks, value = run();
  const promise = api.saveAgentRun(value); const submitted = JSON.stringify(value, null, 2);
  value.nodes[0].result = 'mutated after submission'; await promise;
  assert.equal(fs.readFileSync(api.agentRunFile(value.sessionId, value.id), 'utf8'), submitted);
  assert.equal((await api.listAgentRuns(value.sessionId))[0].nodes[0].result, 'SYNTHETIC-PRIVATE-SNAPSHOT');
  assert.equal((await api.listAgentRunDigests(value.sessionId))[0].id, value.id);
  await api.listAgentRunDigests(value.sessionId);
  const session = await api.createSession({ title: 'Legacy snapshot projection', cwd: root });
  await api.saveAgentRun(run('run_ff', session.id)); await api.getPretenderProjectionIndex();
  assert.equal(unlocks, before);
});

test('snapshot draft seals >1 MiB Unicode losslessly and all shared cold consumers decrypt', async () => {
  await toggle(true); const value = run('run_ab'); value.nodes[0].result = '保密😀'.repeat(200000);
  await api.saveAgentRun(value);
  const bytes = fs.readFileSync(api.agentRunFile(value.sessionId, value.id), 'utf8');
  assert.equal(JSON.parse(bytes.split('\n')[0]).workData, 3); assert.ok(!bytes.includes('保密'));
  assert.equal((await api.readAgentRunSnapshot(value.sessionId, value.id)).nodes[0].result, value.nodes[0].result);
  assert.equal((await api.readAgentRunRecord(value.sessionId, value.id)).run.id, value.id);
  assert.equal((await api.stewardReadRunSnapshot(value.sessionId, value.id)).id, value.id);
  assert.equal((await api.EventStreamHooks.readAgentRunSnapshot(value.sessionId, value.id)).id, value.id);
});

test('warm sealed digest rejects key loss, new master and different instance without changing bytes', async () => {
  const sid = 'sess_snapshot', rid = 'run_ab', file = api.agentRunFile(sid, rid), original = fs.readFileSync(file);
  await api.listAgentRunDigests(sid); absent = true;
  try { await assert.rejects(api.listAgentRunDigests(sid), { code: 'work_data_key.absent' }); }
  finally { absent = false; }
  await api.listAgentRunDigests(sid); const previous = master; master = crypto.randomBytes(32);
  try { await assert.rejects(api.listAgentRunDigests(sid), privateError); }
  finally { master.fill(0); master = previous; }
  await api.listAgentRunDigests(sid); instance = 'other-instance';
  try { await assert.rejects(api.listAgentRunDigests(sid), privateError); }
  finally { instance = 'snapshot-unit'; }
  assert.deepEqual(fs.readFileSync(file), original);
});

test('scope, missing key, truncation and authenticated bad shape never downgrade, resume or replace', async () => {
  const value = run('run_ac'), file = api.agentRunFile(value.sessionId, value.id); await api.saveAgentRun(value);
  const original = fs.readFileSync(file, 'utf8');
  const copied = api.agentRunFile('sess_other', value.id); fs.mkdirSync(path.dirname(copied), { recursive: true }); fs.writeFileSync(copied, original);
  await assert.rejects(api.readAgentRunSnapshot('sess_other', value.id), privateError);
  await assert.rejects(api.launchPersistedAgentRun({ sessionId: 'sess_other', runId: value.id }), privateError);
  assert.equal(api.activeAgentRuns.has(value.id), false);
  for (const broken of [original.slice(0, -30), '{"workData":3,"format":']) {
    fs.writeFileSync(file, broken); await assert.rejects(api.saveAgentRun(value), privateError);
    await assert.rejects(api.stewardRunResumeTier(value.sessionId, value.id, {}), privateError);
    assert.equal(fs.readFileSync(file, 'utf8'), broken);
  }
  fs.writeFileSync(file, original); await toggle(false);
  await assert.rejects(api.saveAgentRun(value), { code: 'work_data_store.downgrade_refused' });
  assert.equal(fs.readFileSync(file, 'utf8'), original); await toggle(true);
  // Write a correctly authenticated fixture with invalid domain identity, then verify bad reads stay hard.
  await api.agentRunSnapshotStore(value.sessionId, value.id).write(JSON.stringify({ ...value, id: 'run_wrong' }));
  const invalidShape = fs.readFileSync(file, 'utf8');
  await assert.rejects(api.readAgentRunSnapshot(value.sessionId, value.id), { code: 'work_data_store.validate' });
  await assert.rejects(api.saveAgentRun(value), { code: 'work_data_store.validate' });
  assert.equal(fs.readFileSync(file, 'utf8'), invalidShape);
  fs.writeFileSync(file, original); fs.unlinkSync(copied);
});

test('malformed legacy still skips and missing steward snapshots preserve missing semantics', async () => {
  await toggle(false); const value = run('run_ad', 'sess_legacy'), file = api.agentRunFile(value.sessionId, value.id);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{invalid legacy');
  assert.deepEqual(await api.listAgentRuns(value.sessionId), []); assert.equal(await api.stewardReadRunSnapshot(value.sessionId, value.id), null);
  assert.equal(await api.stewardRunResumeTier(value.sessionId, 'run_ee', {}), 'missing');
  await api.saveAgentRun(value); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).id, value.id);
});

test('real route functions consume sealed snapshots and reject failed authentication before apply or delete', async () => {
  await toggle(true); const value = run('run_af', 'sess_route'); value.nodes[0].isolation = { synthetic: true }; await api.saveAgentRun(value);
  const file = api.agentRunFile(value.sessionId, value.id), original = fs.readFileSync(file, 'utf8');
  const url = '/api/agent-runs/' + value.id + '?sessionId=' + value.sessionId, pathname = '/api/agent-runs/' + value.id;
  const res = {}; await api.handleAgentRunApiRoutes({ method: 'GET', url, headers: {} }, res, pathname);
  assert.equal(res.result.status, 200); assert.equal(JSON.parse(res.result.body).run.nodes[0].result, value.nodes[0].result);
  absent = true;
  try {
    for (const req of [
      { method: 'GET', url, headers: {} },
      { method: 'DELETE', url, headers: {} },
      { method: 'POST', url, headers: {}, fixtureBody: { sessionId: value.sessionId, action: 'apply_isolation', nodeId: 'n1' } },
    ]) await assert.rejects(api.handleAgentRunApiRoutes(req, {}, pathname), { code: 'work_data_key.absent' });
  } finally { absent = false; }
  assert.equal(actionState.apply, 0); assert.equal(actionState.cleanup, 0); assert.equal(fs.readFileSync(file, 'utf8'), original);
  await api.handleAgentRunApiRoutes({ method: 'POST', url, headers: {}, fixtureBody: { sessionId: value.sessionId, action: 'apply_isolation', nodeId: 'n1' } }, {}, pathname);
  assert.equal(actionState.apply, 1);
});

test('boot skips blocked snapshot sessions before orphan pool cancellation or snapshot mutation', async () => {
  const value = run('run_ba', 'sess_boot'); value.status = 'paused'; await api.saveAgentRun(value);
  const file = api.agentRunFile(value.sessionId, value.id), original = fs.readFileSync(file);
  const journal = api.interventionFilePath(value.sessionId), row = { id: 'pool_legacy', sessionId: value.sessionId, type: 'pool', runId: value.id, status: 'pending', interventionVersion: 1 };
  fs.writeFileSync(journal, JSON.stringify(row) + '\n'); const journalBytes = fs.readFileSync(journal);
  absent = true;
  try { await api.markInterruptedAgentRuns(); await api.markInterruptedInterventions(); }
  finally { absent = false; }
  assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readFileSync(journal), journalBytes);
});

test('warm and disk-reused projections prove sealed run authority rather than serving stale facts after key changes', async () => {
  await toggle(false); const session = await api.createSession({ title: 'Snapshot projection', cwd: root }); await toggle(true);
  const value = run('run_bc', session.id); await api.saveAgentRun(value);
  const first = await api.getPretenderProjectionIndex(); assert.ok(first.sessions.some(row => row.sessionId === session.id));
  absent = true;
  try { await assert.rejects(api.getPretenderProjectionIndex(), { code: 'work_data_key.absent' }); }
  finally { absent = false; }
  await api.getPretenderProjectionIndex(); const previous = master; master = crypto.randomBytes(32);
  try {
    await assert.rejects(api.getPretenderProjectionIndex(), privateError);
    await assert.rejects(api.getPretenderProjectionIndex(), privateError); // Failure cannot consume its dirty mark then return old cache.
  } finally { master.fill(0); master = previous; }
  await api.getPretenderProjectionIndex();
  api.pretenderIndexRuntime.value = null; api.pretenderRunSourceAuth.clear(); absent = true;
  try { await assert.rejects(api.getPretenderProjectionIndex(), { code: 'work_data_key.absent' }); }
  finally { absent = false; }
});

test('events archiving uses authenticated terminal snapshot and leaves event authority intact on key failure', async () => {
  const value = run('run_bd', 'sess_archive'); value.updatedAt = '2000-01-01T00:00:00Z'; await api.saveAgentRun(value);
  // save stamps updatedAt; old completedAt is only used if updatedAt is absent, so use the real store fixture.
  value.updatedAt = '2000-01-01T00:00:00Z'; await api.agentRunSnapshotStore(value.sessionId, value.id).write(JSON.stringify(value, null, 2));
  const events = api.agentRunFile(value.sessionId, value.id).replace(/\.json$/, '.events.ndjson');
  const bytes = '{"type":"run_end","synthetic":"PRIVATE-EVENT"}\n'; fs.writeFileSync(events, bytes);
  absent = true;
  try { await assert.rejects(api.sweepAgentRunEventsStore({ agentRunEventsCompressDays: 1 }, { actions: [], freedBytes: 0 }), { code: 'work_data_key.absent' }); }
  finally { absent = false; }
  assert.equal(fs.readFileSync(events, 'utf8'), bytes); assert.equal(fs.existsSync(events + '.gz'), false);
  const result = { actions: [], freedBytes: 0 }; await api.sweepAgentRunEventsStore({ agentRunEventsCompressDays: 1 }, result);
  assert.equal(fs.existsSync(events), false); assert.ok(fs.existsSync(events + '.gz'));
  assert.ok(result.actions.some(action => action.detail.endsWith(value.id + '.events.ndjson')));
});

test('snapshot authentication failures preserve health thresholds and successful recovery clears persisted degradation', async () => {
  const value = run('run_be', 'sess_health'); value.status = 'running'; await api.saveAgentRun(value);
  const file = api.agentRunFile(value.sessionId, value.id), original = fs.readFileSync(file);
  const runtime = { run: value, paused: false, stopRequested: false }; api.activeAgentRuns.set(value.id, runtime); absent = true;
  try {
    for (let i = 1; i <= 8; i++) {
      await assert.rejects(api.saveAgentRun(value), { code: 'work_data_key.absent' });
      assert.equal(value.persistenceDegraded === true, i >= 3); assert.equal(runtime.paused, i >= 8);
    }
  } finally { absent = false; api.activeAgentRuns.delete(value.id); }
  assert.deepEqual(fs.readFileSync(file), original);
  await api.saveAgentRun(value); assert.equal(value.persistenceDegraded, false);
  assert.equal((await api.readAgentRunSnapshot(value.sessionId, value.id)).persistenceDegraded, false);
  assert.equal(api.agentRunSaveFailures.has(value.id), false);
});

test('one snapshot operation retains an independent key until guard and replacement finish', async () => {
  const value = run('run_bf', 'sess_keyclear'); await api.saveAgentRun(value);
  const originalKey = Buffer.from(master); clearOnInstance = true; value.nodes[0].result = 'UPDATED-AFTER-KEY-CLEAR';
  try { await api.saveAgentRun(value); }
  finally { master.fill(0); master = originalKey; clearOnInstance = false; }
  assert.equal((await api.readAgentRunSnapshot(value.sessionId, value.id)).nodes[0].result, value.nodes[0].result);
});
