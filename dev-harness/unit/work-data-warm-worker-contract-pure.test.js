'use strict';
// Real Worker -> original warm SourceKeeper facade -> real Setup -> real
// Maintenance. Child events, ownership, file metadata and clocks are inert.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const { constBlock, functionBlock } = require('../lib/source-slice');
const dir = path.resolve(__dirname, '../../ruyi-workbench/app/src'), source = name => fs.readFileSync(path.join(dir, name), 'utf8');
const workerSource = source('13ai-work-data-worker.js');
const wrapperSource = functionBlock(process.env.RUYI_WARM_WRAPPER_SOURCE ? fs.readFileSync(process.env.RUYI_WARM_WRAPPER_SOURCE, 'utf8') : source('13au-work-data-runtime-host.js'), 'withWarmSource');
a.ok(wrapperSource.length > 1000);
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } a.fail('inert original transition not reached'); };
const authority = { generation: 0, id: null, mode: 'plain', sha256: null }, id = 'a'.repeat(48), base = path.resolve('synthetic-not-created/base'), backup = path.resolve('synthetic-not-created/backup');
function facadeHost(events) {
  const pin = { async releaseChecked(guard) { guard(); events.push('pin-release'); } }, warm = { accepting: true, finished: false, base, ownership: {} }, jobs = new Set(), retained = [];
  let unknown = false;
  const wrap = vm.runInNewContext(wrapperSource + '\nwithWarmSource', { warm, jobs,
    N: { sourceKeeper: () => pin }, O: { isSourceKeeper: (value, owner, root) => value === pin && owner === warm.ownership && root === base },
    ensure: () => { if (unknown) throw Object.assign(Error('synthetic retained source'), { code: 'work_data_runtime_host.retained' }); },
    assertFinishSafe: () => { a.equal(unknown, false); },
    fail: suffix => Object.assign(Error('work_data_runtime_host.' + suffix), { code: 'work_data_runtime_host.' + suffix }),
    retain: error => { unknown = true; retained.push(error); return error; } });
  return { wrap, jobs, retained, pin, unknown: () => unknown };
}
async function pipeline({ closeHeld = false } = {}) {
  const events = [], timers = new Map(); let deferred, reply, claim, input, closeRelease;
  const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n }) };
  const load = name => ['fs/promises', 'node:fs/promises'].includes(name) ? io : require(name), context = { require: load, Buffer, process, AbortController };
  const Worker = vm.runInNewContext(constBlock(workerSource, 'WorkDataMaintenanceWorker') + '\nWorkDataMaintenanceWorker', context);
  const Setup = vm.runInNewContext(constBlock(source('13ah-work-data-setup.js'), 'WorkDataSetup') + '\nWorkDataSetup', context);
  const Maintenance = vm.runInNewContext(constBlock(source('13ag-work-data-maintenance.js'), 'WorkDataMaintenance') + '\nWorkDataMaintenance', context);
  const child = new EventEmitter(); child.pid = 222; child.stdin = new EventEmitter();
  child.stdin.end = (bytes, callback) => { input = JSON.parse(bytes); callback?.(); queueMicrotask(() => child.emit('message', { schema: 1, id: input.id, nonce: input.nonce, kind: 'ready' })); };
  child.send = (message, callback) => { events.push('send:' + message.kind); callback?.(); if (message.kind === 'go') queueMicrotask(() => child.emit('message', { ...message, kind: 'armed' })); };
  const claims = { inspect: async () => claim ? { present: true, value: claim, receipt: {} } : { present: false },
    write: async value => { claim = value; events.push('claim:' + value.phase); return {}; }, remove: async () => { claim = null; events.push('claim-remove'); } };
  const worker = Worker.create({ pid: 111, env: {}, base: async () => base, listener: () => ({ host: '127.0.0.1', port: 12345 }), spawn: () => child, claim: claims,
    setTimeout: (fn, ms) => { const row = { fn, ms }; timers.set(row, row); return row; }, clearTimeout: row => timers.delete(row),
    stopUncommitted: async () => events.push('stop-uncommitted'), exitParent: async () => events.push('exit-parent') });
  const facade = facadeHost(events); let handle, raw;
  const maintenance = Maintenance.create({ owns: () => false, snapshot: () => ({ busy: {}, pending: [], dirty: 0 }), pause: () => ({}), resume: () => events.push('resume'), flush: async () => {}, yield: tick });
  const closing = new Promise(resolve => { closeRelease = resolve; });
  const setup = Setup.create({ maintenance, inspect: async () => ({ authority, base }), validateDirectories: async () => {},
    worker: () => ({ start: async request => { handle = await facade.wrap(request, async () => { raw = await worker.start(request); return raw; }); return handle; } }),
    infrastructure: { prepareInfrastructure: () => { events.push('infra-prepare'); return {}; },
      closeInfrastructure: async () => { events.push('infra-close'); if (closeHeld) await closing; }, resumeInfrastructure: () => events.push('infra-resume') },
    id: () => id, now: () => 0, defer: fn => { deferred = fn; }, respond: (_res, value) => { reply = value; } });
  await setup.submit({ operation: 'enable', password: 'synthetic password only', expectedAuthority: authority, backupDirectory: backup });
  const done = deferred();
  return { events, timers, child, facade, maintenance, get handle() { return handle; }, get raw() { return raw; }, done,
    releaseClose: () => closeRelease(), readJob: async () => { await setup.handle({ method: 'GET' }, {}, '/api/work-data/jobs/' + id); return reply.job; } };
}
test('original Setup reaches go/armed through real warm facade before resident close and same original handoff', async () => {
  const f = await pipeline(); await until(() => f.events.includes('exit-parent') || f.events.includes('resume'));
  a.ok(f.events.includes('send:go')); a.ok(f.events.includes('infra-close')); a.ok(f.events.includes('exit-parent'));
  a.ok(f.events.indexOf('send:go') < f.events.indexOf('infra-close'));
  a.ok(f.events.indexOf('infra-close') < f.events.indexOf('exit-parent'));
  a.equal(f.events.filter(value => value === 'send:go').length, 1);
  a.equal(f.events.includes('pin-release'), false); a.equal(f.events.includes('stop-uncommitted'), false);
  a.equal(f.handle.failure, f.raw.failure); a.equal(typeof f.handle.commit, 'function'); a.equal(typeof f.handle.assertArmed, 'function');
  a.equal((await f.readJob()).takeover, true);
});
test('facade commit is one original promise/receiver; cancel cannot release committed keeper; committed handoff executes once', async () => {
  const events = [], f = facadeHost(events); let commits = 0, armed = false, handoffs = 0, cancels = 0, resolve;
  let liveFailure = new Promise(() => {}), reads = 0;
  const held = new Promise(yes => { resolve = yes; });
  const raw = { ready: Promise.resolve(), get failure() { reads++; return liveFailure; },
    commit() { a.equal(this, raw); commits++; return held.then(() => { armed = true; }); },
    assertArmed() { a.equal(this, raw); a.equal(armed, true); },
    async cancel() { a.equal(this, raw); cancels++; }, async handoff() { a.equal(this, raw); handoffs++; } };
  const handle = await f.wrap({}, async () => raw), first = handle.commit(), second = handle.commit();
  a.equal(first, second); a.equal(commits, 1);
  await a.rejects(handle.cancel(), /handoff_committed/); a.equal(cancels, 0); a.equal(f.jobs.size, 1); a.equal(events.includes('pin-release'), false);
  const replacement = new Promise(() => {}); liveFailure = replacement; a.equal(handle.failure, replacement); a.ok(reads >= 3);
  resolve(); await first; handle.assertArmed();
  await a.rejects(handle.handoff(), /parent_exit_returned/); a.equal(handoffs, 1);
  await a.rejects(handle.handoff(), /handoff_invalid/); a.equal(handoffs, 1); a.equal(f.jobs.size, 1); a.equal(f.unknown(), true);
});
test('original worker failure while resident close is pending reaches Setup and permanently keeps source ownership', async () => {
  const f = await pipeline({ closeHeld: true }); await until(() => f.events.includes('infra-close'));
  f.child.emit('close', 1); await until(() => f.facade.unknown());
  const failed = await f.readJob(); a.equal(failed.state, 'uncertain'); a.equal(failed.takeover, true); a.equal(failed.cancellable, false);
  a.equal(f.events.includes('exit-parent'), false); a.equal(f.events.includes('pin-release'), false); a.equal(f.facade.jobs.size, 1);
  f.releaseClose(); await tick(); await tick();
  a.equal(f.events.includes('exit-parent'), false); a.equal(f.events.includes('resume'), false); a.equal(f.events.includes('pin-release'), false);
  a.equal(f.facade.unknown(), true);
});
test('direct legacy handoff commits the exact original worker once before its same armed handoff and retains the pin', async () => {
  const events = [], f = facadeHost(events); let commits = 0, handoffs = 0, armed = false;
  const raw = { ready: Promise.resolve(), failure: new Promise(() => {}),
    async commit() { a.equal(this, raw); commits++; events.push('commit'); armed = true; },
    assertArmed() { a.equal(this, raw); a.equal(armed, true); events.push('assert-armed'); },
    async cancel() { a.fail('committed legacy handoff cannot cancel'); },
    async handoff() { a.equal(this, raw); a.equal(armed, true); handoffs++; events.push('handoff'); } };
  const handle = await f.wrap({}, async () => raw);
  await a.rejects(handle.handoff(), /parent_exit_returned/);
  a.equal(commits, 1); a.equal(handoffs, 1); a.deepEqual(events, ['commit', 'assert-armed', 'handoff']);
  a.equal(f.jobs.size, 1); a.equal(f.unknown(), true); a.equal(events.includes('pin-release'), false);
  await a.rejects(handle.handoff(), /handoff_invalid/); await a.rejects(handle.cancel(), /handoff_committed/);
  a.equal(commits, 1); a.equal(handoffs, 1); a.equal(f.jobs.size, 1);
});
test('uncommitted cancellation releases only the exact pin; malformed worker contract never fabricates split-commit capability', async () => {
  const events = [], f = facadeHost(events), raw = { ready: Promise.resolve(), failure: new Promise(() => {}), commit() {}, assertArmed() {}, async cancel() { a.equal(this, raw); events.push('cancel'); }, async handoff() {} };
  const handle = await f.wrap({}, async () => raw); await handle.cancel(); await handle.cancel();
  a.equal(events.filter(value => value === 'cancel').length, 1); a.equal(events.filter(value => value === 'pin-release').length, 1); a.equal(f.jobs.size, 0);
  await a.rejects(handle.handoff(), /handoff_invalid/);
  const broken = facadeHost([]); await a.rejects(broken.wrap({}, async () => ({ ready: Promise.resolve(), cancel() {}, handoff() {} })), /worker_contract_invalid/);
  a.equal(broken.jobs.size, 1); a.equal(broken.unknown(), true);
});
