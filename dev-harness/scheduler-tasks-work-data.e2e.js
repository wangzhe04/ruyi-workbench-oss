'use strict';
// Actual generated runtime, real Windows DPAPI and isolated synthetic task definitions.
// Task definitions and fire journals use the actual storage/DPAPI; notifications are not sent to real platforms.
const path = require('node:path'), repo = process.env.RUYI_SCHEDULER_REPO || path.resolve(__dirname, '..');
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-scheduler-tasks-e2e-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('SCHEDULER TASKS WORK DATA');
const names = ['sendError', 'readConfig', 'writeConfig', 'workDataKeys', 'paths', 'normalizeSchedulerTask', 'schedulerRuntime', 'schedulerTasksPath', 'schedulerFiresPath',
  'schedulerLoad', 'schedulerSaveTasks', 'schedulerReadTasksFile', 'schedulerRecover', 'schedulerTick', 'schedulerAppendFire', 'schedulerFireOnce', 'stopScheduler',
  'schedulerReadFireRows', 'schedulerReadFiresText', 'schedulerFireJournal', 'WorkDataJournals', 'atomicWriteJson',
  'handleSchedulerApiRoutes', 'pretenderIndexRuntime', 'stewardImplScheduleList', 'stewardImplSchedulePause', 'stewardImplScheduleDelete', 'schedulerCommitmentsSince'];
const runtimes = [], servers = [];
const load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error?.code || '').startsWith('work_data');
async function toggle(api, enabled) { const config = await api.readConfig(); config.schedulerEnabledV1 = true; config.workDataEncryptionV1 = enabled; await api.writeConfig(config); }
async function serve(api) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    Promise.resolve(api.handleSchedulerApiRoutes(req, res, pathname)).then(() => {
      if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
    }, error => {
      if (!res.writableEnded) api.sendError(res, error);
    });
  });
  servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  return async (method, route, body) => {
    const response = await fetch(endpoint + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
}
(async () => {
  const api = load(); await toggle(api, false);
  const now = Date.now(), normalized = api.normalizeSchedulerTask({ id: 'sch_real_dpapi', title: 'TASK-PRIVATE-TITLE中文😀',
    schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'TASK-PRIVATE-BODY' } }, now);
  assert.equal(normalized.ok, true);
  const opaque = { futureSchema: true, privateText: 'OPAQUE-PRIVATE' };
  const file = api.schedulerTasksPath(); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, globalRuns: { date: '', count: 0 }, tasks: [normalized.task, opaque] }, null, 2));
  await api.schedulerLoad(); const originalTask = api.schedulerRuntime.tasks[0], call = await serve(api);
  const patch = await call('PATCH', '/api/scheduler/tasks/sch_real_dpapi', { title: 'OFF-TITLE中文😀' }); assert.equal(patch.status, 200); assert.equal(api.schedulerRuntime.tasks[0], originalTask);
  const plain = fs.readFileSync(file, 'utf8'); assert.equal(plain, JSON.stringify(JSON.parse(plain), null, 2)); assert.deepEqual(JSON.parse(plain).tasks[1], opaque);
  t.ok(true, 'OFF HTTP PATCH preserves pretty JSON, task identity and opaque future definitions');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI encrypted scheduler tasks: Windows only'); return; }
  await toggle(api, true); await api.workDataKeys.ensure();
  api.schedulerRuntime.opaqueTasks = [{ ...opaque, privateText: '大对象😀'.repeat(150000) }];
  await api.schedulerSaveTasks(); assert.ok(Buffer.byteLength(JSON.stringify(api.schedulerRuntime.opaqueTasks)) > 1024 * 1024);
  const sealed = fs.readFileSync(file); assert.equal(JSON.parse(sealed.toString('utf8').split('\n')[0]).workData, 3); assert.equal(sealed.includes(Buffer.from('OFF-TITLE')), false);
  const header = JSON.parse(sealed.toString('utf8').split('\n')[0]); assert.equal(header.purpose, 'task'); assert.equal(header.scopeId, 'scheduler'); assert.equal(header.recordId, 'scheduler-tasks');
  api.workDataKeys.clear(); const cold = load(); await cold.schedulerLoad();
  assert.equal(cold.schedulerRuntime.tasks[0].title, 'OFF-TITLE中文😀'); assert.equal(cold.schedulerRuntime.opaqueTasks[0].privateText, api.schedulerRuntime.opaqueTasks[0].privateText);
  const coldCall = await serve(cold), task = cold.schedulerRuntime.tasks[0], beforeMemory = JSON.stringify(cold.schedulerRuntime.tasks);
  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json'); for (const runtime of runtimes) runtime.workDataKeys.clear();
  t.ok(true, 'real DPAPI seals a task table larger than 1 MiB and independent cold load restores exact opaque Unicode content');

  fs.renameSync(keyFile, keyFile + '.missing');
  try {
    for (const [method, route, body] of [
      ['GET', '/api/scheduler/tasks'],
      ['POST', '/api/scheduler/tasks', { title: 'NO CREATE', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'NO' } }],
      ['PATCH', '/api/scheduler/tasks/' + task.id, { title: 'NO UPDATE' }],
      ['DELETE', '/api/scheduler/tasks/' + task.id],
      ['POST', '/api/scheduler/tasks/' + task.id + '/run-now', {}],
    ]) {
      const result = await coldCall(method, route, body); assert.equal(result.status, 500, JSON.stringify(result)); assert.equal(result.body.error.code, 'work_data_key.absent');
    }
    await assert.rejects(() => cold.stewardImplScheduleList({}, {}, { schedulerEnabledV1: true }), privateError);
    await assert.rejects(() => cold.stewardImplSchedulePause({ id: task.id }, {}, { schedulerEnabledV1: true }), privateError);
    await assert.rejects(() => cold.stewardImplScheduleDelete({ id: task.id }, {}, { schedulerEnabledV1: true }), privateError);
    await assert.rejects(() => cold.schedulerCommitmentsSince(0), privateError);
    cold.schedulerRuntime.lateQueue.push({ taskId: task.id, dueMs: Date.now() }); await cold.schedulerTick(); assert.equal(cold.schedulerRuntime.lateQueue.length, 1);
    await assert.rejects(() => cold.schedulerRecover([]), privateError); await assert.rejects(() => cold.schedulerFireOnce(task, 'manual', Date.now()), privateError);
    assert.equal(JSON.stringify(cold.schedulerRuntime.tasks), beforeMemory); assert.equal(cold.schedulerRuntime.tasks[0], task);
    assert.deepEqual(fs.readFileSync(file), sealed); assert.equal(fs.existsSync(cold.schedulerFiresPath()), false); assert.equal(fs.existsSync(file + '.corrupt'), false);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); cold.schedulerRuntime.lateQueue.length = 0; }
  t.ok(true, 'warm key loss blocks HTTP CRUD/run-now, steward consumers, tick and recovery before task, fire or notification effects');

  const keyBytes = fs.readFileSync(keyFile), changedKey = JSON.parse(keyBytes); changedKey.instanceId = 'f'.repeat(32);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.writeFileSync(keyFile, JSON.stringify(changedKey));
  try { await assert.rejects(() => cold.schedulerLoad(), privateError); assert.deepEqual(fs.readFileSync(file), sealed); }
  finally { fs.writeFileSync(keyFile, keyBytes); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  const broken = sealed.subarray(0, sealed.length - 25); fs.writeFileSync(file, broken);
  await assert.rejects(() => cold.schedulerLoad(), privateError); await assert.rejects(() => cold.schedulerSaveTasks(), privateError);
  assert.deepEqual(fs.readFileSync(file), broken); assert.equal(fs.existsSync(file + '.corrupt'), false); fs.writeFileSync(file, sealed);
  await toggle(cold, false); await cold.schedulerLoad();
  const refused = await coldCall('DELETE', '/api/scheduler/tasks/' + task.id); assert.equal(refused.status, 503); assert.equal(refused.body.error.code, 'work_data_store.downgrade_refused');
  assert.deepEqual(fs.readFileSync(file), sealed); assert.equal(cold.schedulerRuntime.tasks[0], task);
  t.ok(true, 'wrong instance and torn sealed bytes fail closed; OFF can read sealed tasks but mutations refuse downgrade');

  await toggle(cold, true);
  task.state.inFlightRunId = 'srun_synthetic_crash'; await cold.schedulerSaveTasks();
  await cold.schedulerAppendFire({ taskId: task.id, title: task.title, occurrenceKey: task.id + '@' + task.state.nextFireAt, dueAt: task.state.nextFireAt,
    runId: task.state.inFlightRunId, executionGeneration: 1, mode: 'manual', phase: 'registered' });
  cold.workDataKeys.clear(); const recovered = load(), rows = await recovered.schedulerLoad(); await recovered.schedulerRecover(rows);
  assert.equal(recovered.schedulerRuntime.tasks[0].state.inFlightRunId, ''); assert.equal(recovered.schedulerRuntime.tasks[0].state.lastResult, 'unknown');
  assert.equal(recovered.schedulerRuntime.firedTotal, 0);
  const fires = await recovered.schedulerReadFireRows(); assert.equal(fires.at(-1).outcome, 'unknown'); assert.equal(fires.filter(row => row.phase === 'registered').length, 1);
  t.ok(true, 'cold registered occurrence recovers as unknown once without replaying a reminder or model turn');

  const fireFile = recovered.schedulerFiresPath(), large = 'FIRE-PRIVATE-PAYLOAD' + '火😀'.repeat(1050000);
  await recovered.schedulerAppendFire({ taskId: task.id, phase: 'reconciled', outcome: 'succeeded', occurrenceKey: 'large-fire', opaque: large });
  const fireBytes = fs.readFileSync(fireFile); assert.ok(fireBytes.length > 8 * 1024 * 1024); assert.equal(fireBytes.includes(Buffer.from('FIRE-PRIVATE-PAYLOAD')), false);
  assert.equal(JSON.parse(fireBytes.toString('utf8').trim().split('\n').at(-1)).w, 3);
  recovered.workDataKeys.clear(); const fireCold = load(), fireCall = await serve(fireCold);
  const window = await fireCold.schedulerReadFiresText(); assert.equal(window.droppedHead, false); assert.ok(Buffer.byteLength(window.text) < 8 * 1024 * 1024);
  assert.equal((await fireCold.schedulerReadFireRows()).at(-1).opaque, large);
  const listed = await fireCall('GET', '/api/scheduler/tasks/' + task.id + '/runs'); assert.equal(listed.status, 200); assert.ok(listed.body.runs.length > 0);
  t.ok(true, 'real DPAPI chunked fire exceeds the physical 8 MiB window yet cold logical reads and actual HTTP runs preserve its complete content');

  const taskBytes = fs.readFileSync(file); for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.missing');
  try {
    await assert.rejects(() => fireCold.schedulerReadFireRows(), privateError);
    await assert.rejects(() => fireCold.schedulerAppendFire({ phase: 'running' }), privateError);
    await assert.rejects(() => fireCold.schedulerCommitmentsSince(0), privateError);
    const refused = await fireCall('GET', '/api/scheduler/tasks/' + task.id + '/runs'); assert.equal(refused.status, 500); assert.equal(refused.body.error.code, 'work_data_key.absent');
    assert.deepEqual(fs.readFileSync(fireFile), fireBytes); assert.deepEqual(fs.readFileSync(file), taskBytes);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); }
  t.ok(true, 'real key loss refuses direct fire reads, writes, commitments and actual HTTP runs without changing task or journal bytes');

  const carriers = fireBytes.toString('utf8').trim().split('\n'), damaged = JSON.parse(carriers[0]), cipher = damaged.e.envelope.ciphertext;
  damaged.e.envelope.ciphertext = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1); carriers[0] = JSON.stringify(damaged);
  const badBytes = Buffer.from(carriers.join('\n') + '\n'); fs.writeFileSync(fireFile, badBytes);
  await assert.rejects(() => fireCold.schedulerReadFireRows(), privateError); await assert.rejects(() => fireCold.schedulerAppendFire({ phase: 'running' }), privateError);
  assert.deepEqual(fs.readFileSync(fireFile), badBytes); assert.equal(fs.existsSync(fireFile + '.corrupt'), false);
  const noLf = fireBytes.subarray(0, fireBytes.length - 1); fs.writeFileSync(fireFile, noLf);
  assert.equal((await fireCold.schedulerReadFireRows()).at(-1).opaque, large);
  await assert.rejects(() => fireCold.schedulerAppendFire({ phase: 'running' }), { code: 'work_data_journal.sealed_tail_uncommitted' }); assert.deepEqual(fs.readFileSync(fireFile), noLf);
  fs.writeFileSync(fireFile, fireBytes); await toggle(fireCold, false);
  assert.equal((await fireCold.schedulerReadFireRows()).at(-1).opaque, large);
  await assert.rejects(() => fireCold.schedulerAppendFire({ phase: 'running' }), { code: 'work_data_journal.downgrade_refused' }); assert.deepEqual(fs.readFileSync(fireFile), fireBytes);
  t.ok(true, 'tampering, complete sealed no-LF tails and OFF downgrade never quarantine, truncate or overwrite valid recovery authority');

  await toggle(fireCold, true);
  const foreign = path.join(path.dirname(fireFile), 'foreign-fire.fixture.ndjson');
  const store = fireCold.WorkDataJournals.create({ file: foreign, context: { kind: 'scheduler-fires', sessionId: 'foreign-scheduler' },
    enabled: async () => true, writeJson: fireCold.atomicWriteJson });
  await store.append([JSON.stringify({ seq: 1, phase: 'registered', occurrenceKey: 'foreign' })], async () => { throw Error('encrypted writer must not use legacy append'); });
  const foreignBytes = fs.readFileSync(foreign); fs.writeFileSync(fireFile, foreignBytes);
  await assert.rejects(() => fireCold.schedulerReadFireRows(), privateError); await assert.rejects(() => fireCold.schedulerAppendFire({ phase: 'running' }), privateError);
  assert.deepEqual(fs.readFileSync(fireFile), foreignBytes); assert.deepEqual(fs.readFileSync(file), taskBytes); fs.writeFileSync(fireFile, fireBytes);
  t.ok(true, 'a real DPAPI journal bound to another scheduler scope cannot be read or rewritten under the live scope');
})().catch(error => { t.fail(error?.stack || String(error)); }).finally(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  for (const api of runtimes) { api.stopScheduler(); clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-scheduler-tasks-e2e-')); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
