'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
const os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { functionBlock } = require('../lib/source-slice');
const repo = process.env.RUYI_SCHEDULER_REPO || path.resolve(__dirname, '../..');
const candidate = process.env.RUYI_SCHEDULER_SOURCE || path.join(repo, 'ruyi-workbench/app/src');
const { loadWorkDataChunks } = require(path.join(repo, 'dev-harness/lib/work-data-chunks-fixture'));
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-scheduler-consumers-unit-'));
after(() => { assert.equal(path.dirname(root), base); fs.rmSync(root, { recursive: true, force: true }); });
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const state = { enabled: false, missing: false, instance: 'scheduler-test-instance', key: crypto.randomBytes(32), acquires: 0, releases: 0,
    reminders: 0, sessions: 0, turns: 0, decisions: [], events: [], reads: 0, readFaults: 0 };
  const isFires = file => String(file).endsWith('fires-v1.ndjson');
  const testFs = { ...fsp, stat: async (file, options) => {
    const value = await fsp.stat(file, options);
    return isFires(file) && options?.bigint && state.fireStat ? { ...value, ...state.fireStat } : value;
  }, open: async (file, flags, ...args) => {
    const handle = await fsp.open(file, flags, ...args);
    if (!isFires(file)) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'stat') return async options => {
        const value = await target.stat(options);
        return options?.bigint && state.fireStat ? { ...value, ...state.fireStat } : value;
      };
      if (key === 'write' && flags === 'a') return async (...params) => {
        const value = await target.write(...params);
        if (state.failAfterFireWrite) { state.failAfterFireWrite = false; throw Object.assign(Error('synthetic append failure after bytes'), { code: 'ENOSPC' }); }
        return value;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }, truncate: async (file, ...args) => {
    if (isFires(file) && state.failFireRollback) { state.failFireRollback = false; throw Object.assign(Error('synthetic rollback failure'), { code: 'EIO' }); }
    return fsp.truncate(file, ...args);
  }, readFile: async (file, ...args) => {
    if (String(file).endsWith('tasks-v1.json')) {
      state.reads++;
      if (state.readFaults > 0) { state.readFaults--; throw Object.assign(Error('temporarily locked'), { code: 'EBUSY' }); }
    }
    return fsp.readFile(file, ...args);
  } };
  const fx = loadWorkDataChunks({ fsp: testFs, require: name => name === 'node:fs/promises' ? testFs : require(name) });
  fx.store.Hooks.keys = { snapshot: async () => {
    state.acquires++;
    if (state.missing) throw Object.assign(Error('missing key'), { code: 'work_data_key.absent' });
    const key = Buffer.from(state.key);
    return { key, instanceId: state.instance, release: () => { state.releases++; key.fill(0); } };
  } };
  const journals = vm.runInNewContext(fs.readFileSync(path.join(candidate, '01q-work-data-records.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(candidate, '01s-work-data-journals.js'), 'utf8') + '\n({ journals: WorkDataJournals, records: WorkDataRecords });', {
    require: name => name === 'node:fs/promises' ? testFs : require(name), Buffer, console,
    WorkDataCrypto: fx.crypto, WorkDataChunks: fx.chunks, WorkDataStore: fx.store,
  });
  // Observe the actual journal's committed plaintext input; sealed appends now
  // stream through FileHandle.write rather than the old appendFile call.
  const observedJournals = { create: host => {
    const store = journals.journals.create(host);
    return { ...store, append: async (rows, ...args) => {
      const result = await store.append(rows, ...args);
      if (host.context.kind === 'scheduler-fires' && state.onAppendFire) await state.onAppendFire(JSON.parse(rows[0]));
      return result;
    } };
  } };
  const context = vm.createContext({ require, Buffer, console, crypto, fs, fsp: testFs, path,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, process: { env: {} },
    WorkDataStore: fx.store, WorkDataJournals: observedJournals, paths: { data: dir }, atomicWriteJson: async (file, data, options) => { if (state.failSaves && String(file).endsWith('tasks-v1.json')) throw Object.assign(Error('synthetic disk full'), { code: 'ENOSPC' }); return fx.atomicWriteJson(file, data, options); },
    __clockNow: Date.parse('2026-10-23T12:00:00Z'),
    RUYI_EVENTS: { subscribe() {}, emit(name, row) { state.events.push([name, row]); } },
    readConfig: async () => ({ schedulerEnabledV1: true, workDataEncryptionV1: state.enabled, permissionMode: 'default' }),
    logEvent: row => state.events.push(row), makeId: prefix => prefix + '_' + crypto.randomBytes(8).toString('hex'),
    StewardHooks: {}, stewardToolHandler: (_name, fn) => fn, stewardFail: (code, message, params) => ({ ok: false, error: code, message, ...params }),
    stewardUnattendedByModel: () => false, stewardSanitizeText: value => String(value), stewardAppendDecision: row => { state.decisions.push(row); },
    safeSessionId: id => String(id || ''), stewardReadSessionHead: async id => ({ id }), stewardRawKind: head => head.kind || '',
    STEWARD_SESSION_ID: 'steward', PERMISSION_MODES: ['default'], stewardPermissionRank: () => 1,
    schedulerAskWaitSessions: new Map(), activeChildren: new Map(),
    createSession: async () => { state.sessions++; return { id: 'sess_' + state.sessions, cwd: dir }; },
    saveSession: async () => {}, loadSession: async id => ({ id, cwd: dir }),
    updateSessionMeta: async () => {}, nowIso: () => new Date().toISOString(),
    runSessionTurn: async row => { state.turns++; return state.onTurn ? state.onTurn(row) : { ok: true, result: { ok: true } }; },
    safeDecodeURIComponent: value => decodeURIComponent(value),
    readJsonBody: async req => { if (req.beforeBody) await req.beforeBody(); return req.body || {}; },
    apiFailure: (code, params, message, status) => ({ ok: false, error: code, params, message, status }),
    json: value => value, send: (res, value) => { res.value = value; return value; },
  });
  let source = functionBlock(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/01-config.js'), 'utf8'), 'readFileTail') + '\n'
    + functionBlock(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/02-session-store.js'), 'utf8'), 'repairMissionChangeTornTail') + '\n'
    + fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/06j-scheduler-core.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(candidate, '13s-scheduler.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(candidate, '13t-steward-schedule.js'), 'utf8');
  if (options.cap) source = source.replace('const SCHEDULER_TASK_ENGINEERING_BYTES = 256 * 1024 * 1024;', 'const SCHEDULER_TASK_ENGINEERING_BYTES = ' + options.cap + ';');
  if (options.fireWindow) source = source.replace('const SCHEDULER_FIRES_FULL_READ_BYTES = 8 * 1024 * 1024;', 'const SCHEDULER_FIRES_FULL_READ_BYTES = ' + options.fireWindow.full + ';')
    .replace('const SCHEDULER_FIRES_TAIL_BYTES = 1024 * 1024;', 'const SCHEDULER_FIRES_TAIL_BYTES = ' + options.fireWindow.tail + ';');
  const names = ['schedulerRuntime', 'SchedulerHooks', 'schedulerTasksPath', 'schedulerFiresPath', 'schedulerTaskPayload', 'schedulerTaskStore', 'withSchedulerTaskOperation',
    'schedulerTaskAdmission', 'schedulerReadTasksFile', 'schedulerSaveTasks', 'schedulerLoad', 'schedulerRecover', 'schedulerFireOnce', 'schedulerTick', 'schedulerRunNow',
    'schedulerAppendFire', 'schedulerReadFireRows', 'schedulerReadFiresText', 'schedulerFireJournal', 'schedulerFirePreflight',
    'handleSchedulerApiRoutes', 'normalizeSchedulerTask', 'schedulerClockNow', 'schedulerDayKey', 'startScheduler', 'stopScheduler',
    'stewardImplScheduleCreate', 'stewardImplScheduleList', 'stewardImplScheduleDelete', 'stewardImplSchedulePause', 'stewardImplScheduleResume', 'schedulerCommitmentsSince'];
  const api = vm.runInContext(source + '\nschedulerClockNow = () => __clockNow;\n({' + names.join(',') + '});', context);
  api.SchedulerHooks.onReminderDue = async () => { state.reminders++; };
  api.SchedulerHooks.prepareThread = async () => {};
  api.SchedulerHooks.onSchedulerNotice = async () => {};
  const task = (id = 'sch_fixture', kind = 'reminder') => {
    const result = api.normalizeSchedulerTask({ id, title: 'TASK-PRIVATE中文😀', schedule: { kind: 'daily', at: '09:00' }, payload: { kind, text: 'TASK-BODY-PRIVATE' } }, context.__clockNow);
    assert.equal(result.ok, true); return result.task;
  };
  const runtime = api.schedulerRuntime;
  runtime.loaded = true;
  const prepare = async (enabled = false, kind = 'reminder') => {
    state.enabled = enabled; const row = task('sch_fixture', kind); runtime.tasks = [row]; await api.schedulerSaveTasks(); return row;
  };
  const call = async (method, url, body = {}, beforeBody) => {
    const req = { method, url, headers: {}, body, beforeBody }, res = {};
    await api.handleSchedulerApiRoutes(req, res, url); return res.value;
  };
  return { ...api, runtime, state, context, task, prepare, call, dir, file: api.schedulerTasksPath(), fires: api.schedulerFiresPath(), records: journals.records };
}
const privateError = error => String(error?.code || '').startsWith('work_data');
const bytesOrAbsent = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
async function encodeFire(f, row, binding = {}) {
  const factory = f.records.encodeRecordFactory(typeof row === 'string' ? row : JSON.stringify(row), f.state.key,
    { kind: 'scheduler-fires', sessionId: 'scheduler-global', instanceId: f.state.instance, ordinal: 0, ...binding }, 256 * 1024 * 1024);
  try { const parts = []; for await (const part of factory()) parts.push(Buffer.from(part)); return Buffer.concat(parts); }
  finally { factory.dispose(); }
}
function tamperFire(row) {
  const value = row.e.envelope.ciphertext;
  row.e.envelope.ciphertext = (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  return row;
}
test('OFF exact pretty bytes and opaque rows, original retry and quarantine branches remain', async () => {
  const f = fixture(); await f.prepare(); f.runtime.opaqueTasks = [{ unknown: 'OPAQUE-PRIVATE' }]; await f.schedulerSaveTasks();
  assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(f.schedulerTaskPayload(), null, 2)); assert.equal(f.state.acquires, 0);
  f.state.readFaults = 2; const read = await f.schedulerReadTasksFile(); assert.equal(read.tasks.length, 2); assert.equal(f.state.readFaults, 0);
  f.state.readFaults = 5; const unreadable = await f.schedulerReadTasksFile(); assert.equal(unreadable.unreadable, true); assert.equal(unreadable.code, 'EBUSY');
  const original = fs.readFileSync(f.file); assert.deepEqual(fs.readFileSync(f.file), original);
  fs.writeFileSync(f.file, '{ordinary broken'); assert.equal((await f.schedulerReadTasksFile()).tasks.length, 0);
  assert.equal(fs.readFileSync(f.file + '.corrupt', 'utf8'), '{ordinary broken'); assert.equal(fs.existsSync(f.file), false);
});
test('ON chunks seal large opaque definitions losslessly, cold load retains unreadable rows', async () => {
  const f = fixture(); await f.prepare(true); f.runtime.opaqueTasks = [{ opaque: '大😀'.repeat(180000) }]; await f.schedulerSaveTasks();
  const raw = fs.readFileSync(f.file); assert.equal(JSON.parse(raw.toString().split('\n')[0]).workData, 3); assert.equal(raw.includes(Buffer.from('TASK-PRIVATE')), false);
  assert.equal((await f.schedulerReadTasksFile()).tasks[1].opaque.length, f.runtime.opaqueTasks[0].opaque.length);
  f.runtime.loaded = false; await f.schedulerLoad(); assert.equal(f.runtime.tasks.length, 1); assert.equal(f.runtime.opaqueTasks.length, 1);
  assert.equal(f.state.acquires, f.state.releases);
});
test('warm legacy and sealed readers authenticate missing, different-key and different-instance authority', async () => {
  for (const sealed of [false, true]) {
    const f = fixture(); await f.prepare(sealed); const before = fs.readFileSync(f.file); f.state.enabled = true;
    f.state.missing = true;
    await assert.rejects(() => f.schedulerLoad(), privateError); await assert.rejects(() => f.call('GET', '/api/scheduler/tasks'), privateError);
    await assert.rejects(() => f.stewardImplScheduleList({}, {}, { schedulerEnabledV1: true }), privateError);
    await assert.rejects(() => f.schedulerCommitmentsSince(0), privateError); assert.deepEqual(fs.readFileSync(f.file), before);
    f.state.missing = false;
    if (sealed) {
      const key = f.state.key; f.state.key = crypto.randomBytes(32); await assert.rejects(() => f.schedulerLoad(), privateError); f.state.key = key;
      f.state.instance += '-foreign'; await assert.rejects(() => f.schedulerLoad(), privateError);
    }
    assert.equal(fs.existsSync(f.file + '.corrupt'), false);
  }
});
test('missing keys stop HTTP CRUD after suspended body before memory, disk, events or decision mutations', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const f = fixture(); const task = await f.prepare(true), before = fs.readFileSync(f.file), memory = JSON.stringify(f.runtime.tasks), events = f.state.events.length;
    const url = '/api/scheduler/tasks' + (method === 'POST' ? '' : '/' + task.id);
    const body = method === 'POST' ? { title: 'new', schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: 'new' } } : { title: 'changed' };
    if (method === 'DELETE') f.state.missing = true;
    await assert.rejects(() => f.call(method, url, body, () => { f.state.missing = true; }), privateError);
    assert.equal(JSON.stringify(f.runtime.tasks), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.state.events.length, events);
    assert.equal(f.state.decisions.length, 0); assert.equal(fs.existsSync(f.fires), false);
  }
});
test('corrupt sealed tasks refuse direct save, every mutation admission and startup before quarantine or fires', async () => {
  const f = fixture(); const task = await f.prepare(true); const raw = fs.readFileSync(f.file); fs.writeFileSync(f.file, raw.subarray(0, raw.length - 15));
  const bytes = fs.readFileSync(f.file), memory = JSON.stringify(f.runtime.tasks);
  await assert.rejects(() => f.schedulerSaveTasks(), privateError);
  await assert.rejects(() => f.schedulerFireOnce(task, 'manual', f.context.__clockNow), privateError);
  await assert.rejects(() => f.schedulerRecover([]), privateError);
  await assert.rejects(() => f.startScheduler({ schedulerEnabledV1: true }), privateError);
  assert.equal(f.runtime.started, false); assert.equal(f.runtime.startDeferred, true); assert.equal(f.runtime.timer, null);
  assert.equal(JSON.stringify(f.runtime.tasks), memory); assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(fs.existsSync(f.file + '.corrupt'), false); assert.equal(fs.existsSync(f.fires), false);
});
test('authenticated wrong shape and foreign record binding refuse overwrite without quarantine', async () => {
  const f = fixture(); await f.prepare(true);
  await f.withSchedulerTaskOperation(operation => f.schedulerTaskStore(operation).write('{"schema":1,"tasks":false}'));
  const before = fs.readFileSync(f.file); await assert.rejects(() => f.schedulerReadTasksFile(), privateError); await assert.rejects(() => f.schedulerSaveTasks(), privateError);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.file + '.corrupt'), false);
});
test('sealed OFF reads remain available but CRUD/fire admission refuses downgrade before changing memory', async () => {
  const f = fixture(); const task = await f.prepare(true); const before = fs.readFileSync(f.file), memory = JSON.stringify(f.runtime.tasks); f.state.enabled = false;
  await f.schedulerLoad(); assert.equal((await f.call('GET', '/api/scheduler/tasks')).tasks.length, 1);
  await assert.rejects(() => f.call('DELETE', '/api/scheduler/tasks/' + task.id), { code: 'work_data_store.downgrade_refused' });
  await assert.rejects(() => f.schedulerFireOnce(task, 'manual', f.context.__clockNow), { code: 'work_data_store.downgrade_refused' });
  assert.equal(JSON.stringify(f.runtime.tasks), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.fires), false);
});
test('warm key loss stops tick before consuming late queue and recovery before fire/notice/state writes', async () => {
  const f = fixture(); const task = await f.prepare(true); task.state.nextFireAt = new Date(f.context.__clockNow - 1000).toISOString(); task.state.inFlightRunId = 'srun_crash';
  f.runtime.loadedFromDisk = new Set([task.id]); f.runtime.lateQueue.push({ taskId: task.id, dueMs: f.context.__clockNow });
  const memory = JSON.stringify(task), before = fs.readFileSync(f.file); f.state.missing = true;
  const acquiredBeforeTick = f.state.acquires; await f.schedulerTick(); assert.ok(f.state.acquires > acquiredBeforeTick, 'tick reached current-key authentication'); assert.equal(f.runtime.lateQueue.length, 1); assert.equal(f.runtime.inFlightTaskIds.size, 0);
  await assert.rejects(() => f.schedulerRecover([]), privateError); assert.equal(JSON.stringify(task), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.fires), false); assert.equal(f.state.reminders, 0);
});
test('all steward task mutators refuse revoked warm authority and leave task object intact', async () => {
  const f = fixture(); const task = await f.prepare(true); const config = { schedulerEnabledV1: true }, before = fs.readFileSync(f.file), memory = JSON.stringify(task); f.state.missing = true;
  for (const fn of [() => f.stewardImplScheduleCreate({ title: 'new' }, {}, config), () => f.stewardImplSchedulePause({ id: task.id }, {}, config), () => f.stewardImplScheduleResume({ id: task.id }, {}, config), () => f.stewardImplScheduleDelete({ id: task.id }, {}, config)]) await assert.rejects(fn, privateError);
  assert.equal(f.runtime.tasks[0], task); assert.equal(JSON.stringify(task), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.state.decisions.length, 0);
});
test('live PATCH preserves task object identity, server workdir and in-flight ownership', async () => {
  const f = fixture(); const task = await f.prepare(true); task.workdir = 'C:\\owned'; task.state.inFlightRunId = 'srun_live'; await f.schedulerSaveTasks();
  const result = await f.call('PATCH', '/api/scheduler/tasks/' + task.id, { title: 'renamed', workdir: 'C:\\foreign' });
  assert.equal(result.ok, true); assert.equal(f.runtime.tasks[0], task); assert.equal(task.title, 'renamed'); assert.equal(task.workdir, 'C:\\owned'); assert.equal(task.state.inFlightRunId, 'srun_live');
});
test('model turn holds no task key lease; post-execution loss blocks reconcile and recovery never replays it', async () => {
  const f = fixture(); const task = await f.prepare(true, 'prompt'); let reached, release;
  const atTurn = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.state.onTurn = async () => { assert.equal(f.state.acquires, f.state.releases, 'all task operation leases released before actual model turn'); reached(); await gate; f.state.missing = true; return { ok: true, result: { ok: true } }; };
  const running = f.schedulerRunNow(task); await atTurn; assert.equal(f.state.turns, 1); assert.equal(f.state.sessions, 1); const registered = fs.readFileSync(f.file); release();
  await assert.rejects(() => running, privateError); assert.ok(task.state.inFlightRunId); assert.deepEqual(fs.readFileSync(f.file), registered);
  await assert.rejects(() => f.schedulerReadFireRows(), privateError);
  f.state.missing = false;
  const rows = await f.schedulerReadFireRows(); assert.equal(rows.filter(row => row.phase === 'reconciled').length, 0);
  f.runtime.loaded = false; const coldRows = await f.schedulerLoad(); await f.schedulerRecover(coldRows);
  assert.equal(f.state.turns, 1); assert.equal(f.runtime.tasks[0].state.inFlightRunId, ''); assert.equal(f.runtime.tasks[0].state.lastResult, 'unknown');
  assert.equal((await f.schedulerReadFireRows()).at(-1).outcome, 'unknown');
});
test('small encrypted capacity refuses oversized existing definitions before registration or callbacks; OFF remains unlimited', async () => {
  const f = fixture({ cap: 1024 }); const task = await f.prepare(false); f.runtime.opaqueTasks = [{ opaque: 'x'.repeat(2000) }]; await f.schedulerSaveTasks();
  const before = fs.readFileSync(f.file), memory = JSON.stringify(task); f.state.enabled = true;
  await assert.rejects(() => f.schedulerFireOnce(task, 'manual', f.context.__clockNow), { code: 'work_data.scheduler_tasks_limit' });
  assert.equal(JSON.stringify(task), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.fires), false); assert.equal(f.state.reminders, 0);
});
test('failed HTTP and steward publications roll back live definitions and preserve task identities', async () => {
  const config = { schedulerEnabledV1: true };
  const operations = [
    f => f.call('POST', '/api/scheduler/tasks', { title: 'new', schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: 'new' } }),
    f => f.call('PATCH', '/api/scheduler/tasks/sch_fixture', { title: 'changed' }),
    f => f.call('DELETE', '/api/scheduler/tasks/sch_fixture'),
    f => f.stewardImplScheduleCreate({ title: 'new', schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: 'new' } }, {}, config),
    f => f.stewardImplSchedulePause({ id: 'sch_fixture' }, {}, config),
    f => f.stewardImplScheduleDelete({ id: 'sch_fixture' }, {}, config),
  ];
  for (const enabled of [false, true]) for (const mutate of operations) {
    const f = fixture(); const task = await f.prepare(enabled), before = fs.readFileSync(f.file), memory = JSON.stringify(f.runtime.tasks), events = f.state.events.length;
    f.state.failSaves = true; await assert.rejects(() => mutate(f), { code: 'ENOSPC' });
    assert.equal(f.runtime.tasks[0], task); assert.equal(JSON.stringify(f.runtime.tasks), memory); assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.state.events.length, events); assert.equal(f.state.decisions.length, 0);
    f.state.failSaves = false; assert.equal((await f.call('GET', '/api/scheduler/tasks')).tasks[0].title, task.title);
  }
});
test('a failed registration save restores counters and state before any fire or reminder is published', async () => {
  const f = fixture(); const task = await f.prepare(true), before = fs.readFileSync(f.file), memory = JSON.stringify(task), global = JSON.stringify(f.runtime.globalRuns); f.state.failSaves = true;
  await assert.rejects(() => f.schedulerRunNow(task), { code: 'ENOSPC' });
  assert.equal(JSON.stringify(task), memory); assert.equal(JSON.stringify(f.runtime.globalRuns), global); assert.equal(f.runtime.attempts.size, 0); assert.equal(f.runtime.inFlightTaskIds.size, 0);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.fires), false); assert.equal(f.state.reminders, 0);
});
test('OFF plaintext warm definitions do not acquire an invented key lock after an earlier encrypted operation', async () => {
  const f = fixture(); await f.prepare(true); f.state.enabled = false; const payload = f.schedulerTaskPayload(); fs.writeFileSync(f.file, JSON.stringify(payload, null, 2));
  f.state.missing = true; const acquires = f.state.acquires; await f.schedulerLoad(); await f.call('PATCH', '/api/scheduler/tasks/sch_fixture', { title: 'plain update' });
  assert.equal(f.state.acquires, acquires); assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).tasks[0].title, 'plain update');
});
test('concurrent readers wait for pending publication and receive the rolled-back committed task on failure', async () => {
  const f = fixture(); const task = await f.prepare(true), title = task.title, before = fs.readFileSync(f.file);
  const write = f.context.atomicWriteJson; let reached, release;
  const atWrite = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.context.atomicWriteJson = async (file, ...args) => {
    if (file === f.file) { reached(); await gate; throw Object.assign(Error('synthetic delayed disk full'), { code: 'ENOSPC' }); }
    return write(file, ...args);
  };
  const patch = f.call('PATCH', '/api/scheduler/tasks/' + task.id, { title: 'UNCOMMITTED TITLE' });
  await atWrite;
  let readSettled = false;
  const reading = f.call('GET', '/api/scheduler/tasks').then(result => { readSettled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(readSettled, false, 'GET must wait while the domain publication remains undecided');
  } finally { release(); }
  await assert.rejects(() => patch, { code: 'ENOSPC' });
  assert.equal((await reading).tasks[0].title, title); assert.equal(f.runtime.tasks[0], task); assert.deepEqual(fs.readFileSync(f.file), before);
});
test('concurrent first-load POSTs cannot publish an old task table over a completed create', async () => {
  const f = fixture(); await f.prepare(false); f.runtime.loaded = false;
  const read = f.context.schedulerReadTasksFile; let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.context.schedulerReadTasksFile = async () => { const ordinal = ++reads; const result = await read(); if (ordinal === 2) await gate; return result; };
  const body = title => ({ title, schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: title } });
  const creatingA = f.call('POST', '/api/scheduler/tasks', body('create A'));
  const creatingB = f.call('POST', '/api/scheduler/tasks', body('create B'));
  let createdA;
  try { createdA = await creatingA; } finally { release(); }
  const createdB = await creatingB;
  assert.equal(createdA.ok, true); assert.equal(createdB.ok, true);
  const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8')).tasks.map(task => task.id);
  assert.ok(persisted.includes(createdA.task.id), 'first completed create stays authoritative'); assert.ok(persisted.includes(createdB.task.id)); assert.equal(persisted.length, 3);
});
test('key revocation after running journal publication blocks the actual model turn before it starts', async () => {
  const f = fixture(); const task = await f.prepare(true, 'prompt');
  f.state.onAppendFire = row => { if (row.phase === 'running') f.state.missing = true; };
  await assert.rejects(() => f.schedulerRunNow(task), privateError);
  assert.equal(f.state.turns, 0); assert.ok(task.state.inFlightRunId);
  const sealed = fs.readFileSync(f.fires);
  await assert.rejects(() => f.schedulerReadFireRows(), privateError); f.state.missing = false;
  const rows = await f.schedulerReadFireRows(); assert.deepEqual(fs.readFileSync(f.fires), sealed);
  assert.equal(rows.at(-1).phase, 'running'); assert.equal(rows.filter(row => row.phase === 'registered').length, 1); assert.equal(rows.filter(row => row.phase === 'reconciled').length, 0);
  assert.equal(fs.existsSync(f.file + '.corrupt'), false);
});
test('preturn waits for a concurrent failed payload PATCH and sends only the committed model message', async () => {
  const f = fixture(); const task = await f.prepare(true, 'prompt'), originalText = task.payload.text;
  const write = f.context.atomicWriteJson; let reached, release, failedPatch;
  const atWrite = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let gatePatch = false, receivedText = '';
  f.context.atomicWriteJson = async (file, ...args) => {
    if (gatePatch && file === f.file) { reached(); await gate; throw Object.assign(Error('synthetic payload disk full'), { code: 'ENOSPC' }); }
    return write(file, ...args);
  };
  f.state.onAppendFire = async row => {
    if (row.phase !== 'running') return;
    gatePatch = true;
    failedPatch = f.call('PATCH', '/api/scheduler/tasks/' + task.id, { payload: { kind: 'prompt', text: 'UNCOMMITTED MODEL MESSAGE' } }).then(value => ({ value }), error => ({ error }));
    await atWrite;
  };
  f.state.onTurn = row => { receivedText = row.message; return { ok: true, result: { ok: true } }; };
  const running = f.schedulerRunNow(task);
  await atWrite;
  try { await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.state.turns, 0, 'model admission waits for the task publication'); }
  finally { gatePatch = false; release(); }
  assert.equal((await failedPatch).error.code, 'ENOSPC');
  assert.equal((await running).outcome, 'succeeded'); assert.equal(receivedText, originalText); assert.equal(task.payload.text, originalText);
});

test('queued HTTP PATCH merges the state committed by an earlier real fire registration inside the task owner', async () => {
  const f = fixture(); const task = await f.prepare(true, 'prompt');
  let bodyReached, bodyRelease, blockerReached, blockerRelease, patchQueued, turnReached, turnRelease;
  const atBody = new Promise(resolve => { bodyReached = resolve; }), bodyGate = new Promise(resolve => { bodyRelease = resolve; });
  const atBlocker = new Promise(resolve => { blockerReached = resolve; }), blockerGate = new Promise(resolve => { blockerRelease = resolve; });
  const atPatchQueue = new Promise(resolve => { patchQueued = resolve; });
  const atTurn = new Promise(resolve => { turnReached = resolve; }), turnGate = new Promise(resolve => { turnRelease = resolve; });
  f.state.onTurn = async () => { turnReached(); await turnGate; return { ok: true, result: { ok: true } }; };
  const patch = f.call('PATCH', '/api/scheduler/tasks/' + task.id, { title: 'queued live title', workdir: 'C:\\foreign' }, async () => { bodyReached(); await bodyGate; });
  await atBody;
  const blocker = f.schedulerTaskAdmission(async operation => { blockerReached(); await blockerGate; await f.schedulerSaveTasks(operation); });
  await atBlocker;
  const admission = f.context.schedulerTaskAdmission; let admissions = 0;
  f.context.schedulerTaskAdmission = (...args) => { const result = admission(...args); if (++admissions === 2) patchQueued(); return result; };
  const firing = f.schedulerRunNow(task);
  bodyRelease(); await atPatchQueue; blockerRelease(); await blocker;
  const patched = await patch; await atTurn;
  try {
    assert.equal(patched.ok, true); assert.equal(f.runtime.tasks[0], task); assert.ok(task.state.inFlightRunId, 'PATCH retains the actual registered run identity');
    assert.equal(task.state.runsToday.count, 1); assert.equal(f.runtime.globalRuns.count, 1);
    const persisted = (await f.schedulerReadTasksFile()).tasks[0];
    assert.equal(persisted.state.inFlightRunId, task.state.inFlightRunId); assert.equal(persisted.state.runsToday.count, 1); assert.equal(task.workdir || '', '');
  } finally { turnRelease(); }
  assert.equal((await firing).outcome, 'succeeded'); assert.equal(task.state.inFlightRunId, ''); assert.equal(f.state.turns, 1);
});
test('queued pause observes the actual fire trip and cannot publish a stale undo that re-enables the task', async () => {
  const f = fixture(); const task = await f.prepare(true, 'prompt'); task.state.consecutiveFailures = 2; await f.schedulerSaveTasks();
  let turnReached, turnRelease, loadReached, loadRelease, blockerReached, blockerRelease, reconcileQueued, pauseQueued;
  const atTurn = new Promise(resolve => { turnReached = resolve; }), turnGate = new Promise(resolve => { turnRelease = resolve; });
  const atLoad = new Promise(resolve => { loadReached = resolve; }), loadGate = new Promise(resolve => { loadRelease = resolve; });
  const atBlocker = new Promise(resolve => { blockerReached = resolve; }), blockerGate = new Promise(resolve => { blockerRelease = resolve; });
  const atReconcile = new Promise(resolve => { reconcileQueued = resolve; }), atPause = new Promise(resolve => { pauseQueued = resolve; });
  f.state.onTurn = async () => { turnReached(); await turnGate; return { ok: false, result: { ok: false } }; };
  const firing = f.schedulerRunNow(task); await atTurn;
  const load = f.context.schedulerToolLoad;
  f.context.schedulerToolLoad = async () => { const value = await load(); loadReached(); await loadGate; return value; };
  const pausing = f.stewardImplSchedulePause({ id: task.id }, {}, { schedulerEnabledV1: true }); await atLoad;
  const blocker = f.schedulerTaskAdmission(async operation => { blockerReached(); await blockerGate; await f.schedulerSaveTasks(operation); }); await atBlocker;
  const admission = f.context.schedulerTaskAdmission; let admissions = 0;
  f.context.schedulerTaskAdmission = (...args) => { const result = admission(...args); if (++admissions === 1) reconcileQueued(); else if (admissions === 2) pauseQueued(); return result; };
  turnRelease(); await atReconcile; loadRelease(); await atPause; blockerRelease(); await blocker;
  assert.equal((await firing).outcome, 'failed'); const paused = await pausing;
  assert.equal(paused.unchanged, true, 'pause reads the committed trip rather than its pre-queue enabled state');
  assert.equal(task.state.enabled, false); assert.equal(task.state.consecutiveFailures, 3); assert.equal(task.revision, 0);
  assert.equal(f.state.decisions.length, 0, 'no stale undo may reverse the completed safety trip');
});
test('queued automatic registration rechecks a committed pause or changed ontime due before any fire effects', async () => {
  for (const [mode, patchBody] of [['ontime', { enabled: false }], ['ontime', { schedule: { kind: 'daily', at: '11:00' } }], ['late', { enabled: false }]]) {
    const f = fixture(); const task = await f.prepare(true), due = Date.parse(task.state.nextFireAt);
    let bodyReached, bodyRelease, blockerReached, blockerRelease, patchQueued;
    const atBody = new Promise(resolve => { bodyReached = resolve; }), bodyGate = new Promise(resolve => { bodyRelease = resolve; });
    const atBlocker = new Promise(resolve => { blockerReached = resolve; }), blockerGate = new Promise(resolve => { blockerRelease = resolve; });
    const atPatch = new Promise(resolve => { patchQueued = resolve; });
    const patch = f.call('PATCH', '/api/scheduler/tasks/' + task.id, patchBody, async () => { bodyReached(); await bodyGate; }); await atBody;
    const blocker = f.schedulerTaskAdmission(async operation => { blockerReached(); await blockerGate; await f.schedulerSaveTasks(operation); }); await atBlocker;
    const admission = f.context.schedulerTaskAdmission;
    f.context.schedulerTaskAdmission = (...args) => { const result = admission(...args); patchQueued(); return result; };
    bodyRelease(); await atPatch;
    const automatic = f.schedulerFireOnce(task, mode, due); blockerRelease(); await blocker; assert.equal((await patch).ok, true);
    assert.equal(await automatic, 'skipped'); assert.equal(f.state.reminders, 0); assert.equal(fs.existsSync(f.fires), false);
    assert.equal(task.state.inFlightRunId, ''); assert.equal(f.runtime.globalRuns.count, 0); assert.equal(f.runtime.attempts.size, 0);
  }
});
test('manual execution keeps explicit paused-task semantics and late recovery may use its consumed due', async () => {
  const manual = fixture(); const task = await manual.prepare(true); task.state.enabled = false; await manual.schedulerSaveTasks();
  assert.equal((await manual.schedulerRunNow(task)).outcome, 'succeeded'); assert.equal(manual.state.reminders, 1);
  const late = fixture(); const lateTask = await late.prepare(true), due = Date.parse(lateTask.state.nextFireAt) - 60000;
  assert.equal(await late.schedulerFireOnce(lateTask, 'late', due), 'succeeded'); assert.equal(late.state.reminders, 1);
});
test('scheduler storage failures retain stable codes and existing statuses through the actual sendError transport', async () => {
  const { functionBlock } = require(path.join(repo, 'dev-harness/lib/source-slice'));
  const boot = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/00-boot.js'), 'utf8');
  const config = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/01-config.js'), 'utf8');
  const responses = [];
  const transport = vm.runInNewContext(['normalizeApiErrorPayload', 'json', 'apiFailure'].map(name => functionBlock(boot, name)).join('\n') + '\n'
    + functionBlock(config, 'sendError') + '\n({sendError});', { send: (_res, value) => responses.push(value) });
  const f = fixture(); await f.prepare(true);
  const failures = [f.context.schedulerStorageFailure('tasks_limit')];
  const readConfig = f.context.readConfig; f.context.readConfig = async () => { throw Error('synthetic config unavailable'); };
  try { await f.schedulerLoad(); assert.fail('must reject unavailable config'); } catch (error) { failures.push(error); }
  f.context.readConfig = readConfig; f.state.enabled = false;
  try { await f.call('DELETE', '/api/scheduler/tasks/sch_fixture'); assert.fail('must refuse sealed downgrade'); } catch (error) { failures.push(error); }
  assert.deepEqual(failures.map(error => error.code), ['work_data.scheduler_tasks_limit', 'work_data_store.switch_unavailable', 'work_data_store.downgrade_refused']);
  for (const error of failures) {
    transport.sendError({}, error); const response = responses.at(-1);
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).error.code, error.code);
  }
});

test('fire OFF append preserves exact JSON bytes, valid rows and old torn-tail repair without keys', async () => {
  const f = fixture(); await f.prepare();
  const old = { seq: 8, phase: 'registered', occurrenceKey: 'old', opaque: '原文😀' };
  const prefix = JSON.stringify(old) + '\nBROKEN\n\n'; fs.writeFileSync(f.fires, prefix + '{torn'); f.runtime.fireSeq = 8;
  const row = await f.schedulerAppendFire({ phase: 'reconciled', outcome: 'succeeded', occurrenceKey: 'new' });
  assert.equal(fs.readFileSync(f.fires, 'utf8'), prefix + JSON.stringify(row) + '\n');
  assert.deepEqual(Array.from(await f.schedulerReadFireRows(), row => row.seq), [8, 9]); assert.equal(f.state.acquires, 0);
});

test('fire mixed prefixes retain every legacy byte and bind encrypted rows to physical ordinal', async () => {
  const f = fixture(); await f.prepare(true);
  const prefix = 'BROKEN\n\n' + JSON.stringify({ seq: 7, phase: 'registered', occurrenceKey: 'old' }) + '\n';
  fs.writeFileSync(f.fires, prefix); f.runtime.fireSeq = 7;
  await f.schedulerAppendFire({ phase: 'reconciled', outcome: 'succeeded', occurrenceKey: 'old', opaque: 'FIRE-SECRET' });
  const raw = fs.readFileSync(f.fires, 'utf8'); assert.equal(raw.slice(0, prefix.length), prefix);
  assert.equal(JSON.parse(raw.slice(prefix.length).trim()).e.seq, 3); assert.equal(raw.includes('FIRE-SECRET'), false);
  assert.deepEqual(Array.from(await f.schedulerReadFireRows(), row => row.seq), [7, 8]); assert.equal(f.state.acquires, f.state.releases);
});

test('large fire records use the real chunk codec and cold load reconstructs exact opaque content', async () => {
  const f = fixture(); await f.prepare(true); const opaque = '火😀'.repeat(240000);
  await f.schedulerAppendFire({ phase: 'registered', occurrenceKey: 'large', opaque });
  const raw = fs.readFileSync(f.fires, 'utf8'); assert.equal(JSON.parse(raw.trim()).w, 3); assert.equal(raw.includes('火😀'), false);
  f.runtime.loaded = false; const rows = await f.schedulerLoad(); assert.equal(rows[0].opaque, opaque); assert.equal(f.runtime.fireSeq, 1);
});

test('fire windows use plaintext bytes when ciphertext alone exceeds the full-read threshold', async () => {
  const f = fixture({ fireWindow: { full: 1024, tail: 600 } }); await f.prepare(true);
  await f.schedulerAppendFire({ phase: 'registered', occurrenceKey: 'window', opaque: 'x'.repeat(650) });
  assert.ok(fs.statSync(f.fires).size > 1024);
  const window = await f.schedulerReadFiresText(); assert.equal(window.droppedHead, false); assert.ok(Buffer.byteLength(window.text) < 1024);
  assert.equal((await f.schedulerReadFireRows())[0].opaque, 'x'.repeat(650));
});

test('fire key, instance, scope and authenticated domain-shape failures preserve task and fire bytes before business', async () => {
  for (const issue of ['missing', 'instance', 'scope', 'shape']) {
    const f = fixture(); const task = await f.prepare(false); f.state.enabled = true;
    const row = { seq: 1, phase: 'registered', occurrenceKey: 'prior', opaque: 'PRIVATE' };
    fs.writeFileSync(f.fires, await encodeFire(f, issue === 'shape' ? { ...row, phase: 'not-a-phase' } : row,
      issue === 'scope' ? { sessionId: 'foreign-scheduler' } : {}));
    if (issue === 'missing') f.state.missing = true;
    if (issue === 'instance') f.state.instance += '-foreign';
    const before = fs.readFileSync(f.fires), tasks = fs.readFileSync(f.file), memory = JSON.stringify(task);
    await assert.rejects(() => f.schedulerReadFireRows(), privateError);
    await assert.rejects(() => f.schedulerRunNow(task), privateError);
    assert.deepEqual(fs.readFileSync(f.fires), before); assert.deepEqual(fs.readFileSync(f.file), tasks);
    assert.equal(JSON.stringify(task), memory); assert.equal(f.runtime.fireSeq, 0); assert.equal(f.runtime.attempts.size, 0);
    assert.equal(f.state.reminders, 0); assert.equal(f.state.sessions, 0); assert.equal(f.state.turns, 0);
    assert.equal(fs.existsSync(f.fires + '.corrupt'), false);
  }
});

test('same-stat warm fire tampering cannot authorize an append or a task registration', async () => {
  const f = fixture(); const task = await f.prepare(true); await f.schedulerAppendFire({ phase: 'registered', occurrenceKey: 'warm' });
  await f.schedulerReadFireRows(); const before = fs.statSync(f.fires, { bigint: true }), raw = fs.readFileSync(f.fires, 'utf8');
  f.state.fireStat = Object.fromEntries(['size', 'mtimeNs', 'ctimeNs', 'dev', 'ino'].map(key => [key, before[key]]));
  const row = tamperFire(JSON.parse(raw.trim()));
  fs.writeFileSync(f.fires, JSON.stringify(row) + '\n'); const damaged = fs.readFileSync(f.fires), tasks = fs.readFileSync(f.file), memory = JSON.stringify(task), seq = f.runtime.fireSeq;
  await assert.rejects(() => f.schedulerAppendFire({ phase: 'running' }), privateError);
  await assert.rejects(() => f.schedulerRunNow(task), privateError);
  assert.deepEqual(fs.readFileSync(f.fires), damaged); assert.deepEqual(fs.readFileSync(f.file), tasks); assert.equal(JSON.stringify(task), memory); assert.equal(f.runtime.fireSeq, seq);
});

test('sealed fire read works OFF but append and complete no-LF tail repair refuse plaintext downgrade', async () => {
  for (const noLf of [false, true]) {
    const f = fixture(); await f.prepare(false); f.state.enabled = true;
    let sealed = await encodeFire(f, { seq: 1, phase: 'registered', occurrenceKey: 'off' }); if (noLf) sealed = sealed.subarray(0, sealed.length - 1);
    fs.writeFileSync(f.fires, sealed); f.state.enabled = false;
    assert.equal((await f.schedulerReadFireRows())[0].occurrenceKey, 'off');
    await assert.rejects(() => f.schedulerAppendFire({ phase: 'running' }), privateError);
    assert.deepEqual(fs.readFileSync(f.fires), sealed); assert.equal(f.runtime.fireSeq, 0);
  }
});

test('failed fire append and failed rollback gate writes; UI read cannot acknowledge business recovery', async () => {
  const f = fixture(); await f.prepare(true); f.state.failAfterFireWrite = true; f.state.failFireRollback = true;
  await assert.rejects(() => f.schedulerAppendFire({ phase: 'registered', occurrenceKey: 'partial' }), { code: 'work_data_journal.recovery_required' });
  const committed = fs.readFileSync(f.fires); assert.equal(f.runtime.fireSeq, 0); assert.equal(f.schedulerFireJournal().recoveryPending(), true);
  assert.equal((await f.schedulerReadFireRows())[0].seq, 1);
  await assert.rejects(() => f.schedulerAppendFire({ phase: 'running', occurrenceKey: 'partial' }), { code: 'work_data_journal.recovery_required' });
  assert.deepEqual(fs.readFileSync(f.fires), committed);
  await f.schedulerTaskAdmission(() => f.schedulerFirePreflight());
  assert.equal(f.runtime.fireSeq, 1); assert.equal(f.runtime.attempts.get('partial'), 1); assert.equal(f.schedulerFireJournal().recoveryPending(), false);
  await f.schedulerAppendFire({ phase: 'reconciled', occurrenceKey: 'partial', outcome: 'unknown' });
  assert.deepEqual(Array.from(await f.schedulerReadFireRows(), row => row.seq), [1, 2]); assert.equal(f.state.reminders, 0); assert.equal(f.state.turns, 0);
});

test('fire failure after a real reminder keeps inFlight and cold recovery records unknown without another reminder', async () => {
  const f = fixture(); const task = await f.prepare(true);
  f.SchedulerHooks.onReminderDue = async () => {
    f.state.reminders++; f.state.cleanFires = fs.readFileSync(f.fires);
    const lines = f.state.cleanFires.toString('utf8').trim().split('\n');
    lines[lines.length - 1] = JSON.stringify(tamperFire(JSON.parse(lines.at(-1))));
    fs.writeFileSync(f.fires, lines.join('\n') + '\n');
  };
  await assert.rejects(() => f.schedulerRunNow(task), privateError); assert.equal(f.state.reminders, 1); assert.ok(task.state.inFlightRunId);
  const head = fs.readFileSync(f.file); await assert.rejects(() => f.schedulerRecover(), privateError); assert.deepEqual(fs.readFileSync(f.file), head);
  fs.writeFileSync(f.fires, f.state.cleanFires); f.runtime.loaded = false;
  const rows = await f.schedulerLoad(); await f.schedulerRecover(rows);
  assert.equal(f.state.reminders, 1); assert.equal(f.runtime.tasks[0].state.lastResult, 'unknown'); assert.equal((await f.schedulerReadFireRows()).at(-1).outcome, 'unknown');
});
