'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFixture, createClaimWiring, tick } = require('../lib/work-data-production-host-fixture');

test('genuine owner and keeper brands reject roots-shaped clones and Proxy objects without getters', async () => {
  const f = createFixture(), owner = await f.lease([f.paths.base]); let gets = 0;
  const foreign = { get roots() { gets++; return [f.paths.base]; } };
  for (const value of [foreign, new Proxy(owner, { get() { gets++; throw Error('trap'); } }), Object.create(owner)]) {
    assert.equal(f.api.ownership.isLease(value), false); assert.equal(f.api.ownership.owns(value, f.paths.base), false);
    assert.throws(() => f.api.ownership.createSourceKeeper(value, f.paths.base));
  }
  const keeper = f.api.ownership.createSourceKeeper(owner, f.paths.base);
  assert.equal(f.api.ownership.isSourceKeeper(new Proxy(keeper, {}), owner, f.paths.base), false);
  assert.equal(gets, 0); await keeper.release(); await owner.release();
});

test('queued release stays pinned until the synchronous final checked guard permits close', async () => {
  const f = createFixture(), owner = await f.lease([f.paths.base]), keeper = f.api.ownership.createSourceKeeper(owner, f.paths.base);
  const released = owner.release(); await tick(); assert.equal(f.servers[0].closeCalls, 0);
  let checks = 0; const done = keeper.releaseOwner(() => { checks++; assert.equal(f.servers[0].closeCalls, checks === 1 ? 0 : 1); return true; });
  assert.equal(checks, 1); assert.equal(f.servers[0].closeCalls, 1); await done; await released;
  assert.ok(checks >= 2, 'completion rechecks the guard after the one authorized close');
});

test('false or asynchronous checked guard cannot authorize a new close', async () => {
  for (const guard of [() => false, async () => true]) {
    const f = createFixture(), owner = await f.lease([f.paths.base]), keeper = f.api.ownership.createSourceKeeper(owner, f.paths.base);
    await assert.rejects(() => keeper.releaseOwner(guard)); assert.equal(f.servers[0].closeCalls, 0);
    assert.ok(f.holds.length); assert.equal(keeper.assertExclusive(owner), false);
  }
});

for (const queued of [false, true]) test('verifier microtask revocation cannot report success or start a new close; queued=' + queued, async () => {
  const f = createFixture(); let owner, pending, sent = 0;
  const acquire = f.api.ownership.acquire;
  f.nativeBindings.ownership = { ...f.api.ownership, acquire: async roots => { owner = await acquire(roots); return owner; } };
  if (queued) f.nativeBindings.fullSnapshot.create = () => ({ seal: async () => { pending = owner.release(); pending.catch(() => {}); return { sourceProof: { sha256: 'd'.repeat(64) }, files: 1, directories: 1 }; } });
  const target = await f.api.ownership.canonicalRoot(f.paths.base), bytes = Buffer.from(JSON.stringify({ schema: 1, kind: 'verify-full', id: 'a'.repeat(48), nonce: 'c'.repeat(64), parentPid: 888, target, generation: 1, password: 'synthetic verifier password' }));
  const enqueue = n => n === 0 ? f.state.unknown = true : queueMicrotask(() => enqueue(n - 1));
  await assert.rejects(() => f.native.runVerifier({ parentConnected: () => true, parentPid: () => 888, readInput: async () => bytes, send: async () => { sent++; enqueue(4); } }));
  if (pending) await pending.catch(() => {});
  assert.equal(sent, 1); assert.equal(f.native.helperMayStillRun(), true); assert.ok(bytes.every(value => value === 0));
  assert.equal(f.servers[0].closeCalls, 0); assert.equal(f.servers[0].listening, true); assert.ok(f.holds.length);
});

test('adapter capabilities keep the wired verifier entry supported and upload unsupported', () => {
  const f = createFixture(), clock = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0 };
  assert.deepEqual([...f.native.capabilities.implemented].sort(), ['cold-verifier-protocol', 'full-snapshot-adapter', 'genuine-source-keeper', 'native-flush-adapter']);
  assert.equal(f.native.capabilities.verifierCommandBound, false, 'the bare adapter has no entry command until 13ar binds it');
  assert.ok(!f.native.capabilities.unsupported.includes('verifier-cli-entry'), 'the verifier CLI entry is wired by 13ar/14-main, not an unsupported capability');
  assert.ok(f.native.capabilities.unsupported.includes('upload'), 'this adapter still does not implement upload');
  const bound = f.api.native.create({ bindings: f.nativeBindings, proc: { pid: 1 }, clock,
    verifierCommand: { command: process.execPath, args: ['server.js', 'work-data-verify'] } });
  assert.equal(bound.capabilities.verifierCommandBound, true);
  assert.ok(!bound.capabilities.unsupported.includes('verifier-cli-entry'));
});

test('unknown during a legally started close rejects without reopening exclusion or closing twice', async () => {
  const f = createFixture({ manualClose: true }), owner = await f.lease([f.paths.base]), keeper = f.api.ownership.createSourceKeeper(owner, f.paths.base);
  const pending = keeper.releaseOwner(() => true); pending.catch(() => {}); assert.equal(f.servers[0].closeCalls, 1);
  keeper.retainUnknown(0); f.servers[0].finishClose(); await assert.rejects(() => pending);
  assert.equal(f.servers[0].listening, false); assert.equal(f.servers[0].closeCalls, 1); assert.equal(keeper.assertExclusive(owner), false); assert.ok(f.holds.length);
});

test('captureServe retains source-scoped Result admission when owner release was queued', async () => {
  const f = createFixture(), warm = await f.warm(), installed = f.factory.installWarm();
  assert.equal(await installed.runtime.captureServe(f.captureContext(warm.session, warm.ownership)), false);
  assert.equal(await f.workerHooks.readResult(), null); const reads = f.state.resultReads;
  const released = warm.ownership.release(); await assert.rejects(() => f.workerHooks.readResult(), { code: 'DATA_ROOT_KEEPER_INVALID' });
  assert.equal(f.state.resultReads, reads); assert.ok(f.servers.every(server => server.closeCalls === 0));
  await warm.session.close(); await released;
});

test('captured Result cannot continue after listener loss and retains genuine source', async () => {
  const f = createFixture(), warm = await f.warm(), installed = f.factory.installWarm(), captured = f.captureContext(warm.session, warm.ownership);
  await installed.runtime.captureServe(captured); captured.server.listening = false;
  await assert.rejects(() => f.workerHooks.readResult(), error => error.ownershipRetained === true);
  await assert.rejects(() => warm.ownership.release()); assert.ok(f.servers.every(server => server.closeCalls === 0));
});

for (const kind of ['clone', 'proxy']) test('captured-result DI requires exact current host identity: ' + kind, async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.runtimeHost({ base: warm.session.base, role: 'warm' });
  const other = kind === 'clone' ? { ...host } : new Proxy(host, {}), runtime = f.api.runtime.create(other);
  await assert.rejects(() => runtime.captureServe(f.captureContext(warm.session, warm.ownership)), { code: 'work_data_setup.runtime_host_invalid' });
  assert.equal(f.workerHooks.readResult, undefined); assert.equal(f.state.resultReads, 0); await f.finishWarm(warm);
});

test('Runtime passes its current host into DI and does not borrow the original private host', async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.runtimeHost({ base: warm.session.base, role: 'warm' });
  const clone = { ...host }; let seen;
  clone.bindCapturedResult = (candidate, ...args) => { seen = candidate; return host.bindCapturedResult(candidate, ...args); };
  const runtime = f.api.runtime.create(clone);
  await assert.rejects(() => runtime.captureServe(f.captureContext(warm.session, warm.ownership)), { code: 'work_data_setup.runtime_host_invalid' });
  assert.equal(seen, clone); assert.notEqual(seen, host); await f.finishWarm(warm);
});

test('present but malformed or refused captured-result DI never falls back to an unscoped reader', async () => {
  for (const dependency of [null, false, () => null]) {
    const f = createFixture(), warm = await f.warm();
    const host = { ...f.factory.runtimeHost({ base: warm.session.base, role: 'warm' }), bindCapturedResult: dependency };
    const runtime = f.api.runtime.create(host);
    await assert.rejects(() => runtime.captureServe(f.captureContext(warm.session, warm.ownership)), { code: 'work_data_setup.runtime_host_invalid' });
    assert.equal(f.workerHooks.readResult, undefined); assert.equal(f.state.resultReads, 0); await f.finishWarm(warm);
  }
});

test('bootstrap pins genuine source and empty custody before boot inspection, then binds and configures before inner startup', async () => {
  const f = createFixture(); await f.startRouter({ inspect: async () => {
    assert.ok(f.servers.every(server => server.listening && server.closeCalls === 0));
    const status = f.bootstrap.inspect(f.state.bootOwner); assert.equal(status.phase, 'acquired'); assert.equal(status.installed, false);
    assert.deepEqual(f.memory.entries(status.uploadRoot), []);
  } });
  assert.ok(f.events.indexOf('inspect') < f.events.indexOf('root-bind'));
  assert.ok(f.events.indexOf('root-bind') < f.events.indexOf('flush'));
  assert.ok(f.events.indexOf('flush') < f.events.indexOf('inner'));
  assert.equal(typeof f.workerHooks.putUpload, 'function'); assert.equal(f.workerHooks.start, undefined);
});

test('pending boot refusal consumes the early pin and closes owner before any bind or custody write', async () => {
  const f = createFixture(); await assert.rejects(() => f.startRouter({ pending: true }), { code: 'work_data_setup.intent_pending' });
  assert.equal(f.events.includes('root-bind'), false); assert.equal(f.events.includes('flush'), false); assert.equal(f.events.includes('error-writer'), false);
  assert.ok(f.servers.every(server => server.closeCalls === 1 && !server.listening));
  const status = f.bootstrap.inspect(f.state.bootOwner); assert.equal(status.phase, 'closed'); assert.deepEqual(f.memory.entries(status.uploadRoot), []);
});

test('early source pin defers queued direct release until checked preconfigure abort', async () => {
  const f = createFixture(), owner = await f.bootstrap.acquireServe({ base: f.paths.base, roots: [f.paths.base] });
  const pending = owner.release(); await tick(); assert.ok(f.servers.every(server => server.closeCalls === 0));
  await f.bootstrap.abortUnconfigured({ ownership: owner }); await pending; assert.ok(f.servers.every(server => server.closeCalls === 1));
});

test('bootstrap registration cannot be borrowed by roots-shaped or Proxy owners', async () => {
  const f = createFixture(), owner = await f.bootstrap.acquireServe({ base: f.paths.base, roots: [f.paths.base] });
  for (const foreign of [{ roots: owner.roots }, new Proxy(owner, {})]) {
    await assert.rejects(() => f.bootstrap.configureServe({ base: f.paths.base, ownership: foreign }), { code: 'work_data_bootstrap.serve_owner_unavailable' });
  }
  assert.equal(f.events.includes('flush'), false); assert.equal(f.workerHooks.putUpload, undefined);
  await f.bootstrap.abortUnconfigured({ ownership: owner });
});

test('bootstrap rejects same-path custody replacement without rebasing its physical identity', async () => {
  const f = createFixture(), owner = await f.bootstrap.acquireServe({ base: f.paths.base, roots: [f.paths.base] }), status = f.bootstrap.inspect(owner);
  f.memory.replaceDirectory(status.uploadRoot);
  await assert.rejects(() => f.bootstrap.configureServe({ base: f.paths.base, ownership: owner }), { code: 'work_data_bootstrap.upload_root_changed' });
  assert.equal(f.events.includes('flush'), false); await f.bootstrap.abortUnconfigured({ ownership: owner });
});

test('bootstrap native uncertainty before configure retains early owner and denies checked abort', async () => {
  const f = createFixture(), owner = await f.bootstrap.acquireServe({ base: f.paths.base, roots: [f.paths.base] }); f.state.unknown = true;
  await assert.rejects(() => f.bootstrap.abortUnconfigured({ ownership: owner }), error => error.ownershipRetained === true);
  assert.equal(f.bootstrap.helperMayStillRun(), true); assert.ok(f.servers.every(server => server.listening && server.closeCalls === 0));
});

test('uncertain bootstrap startup never enters extra error writer or inner startup', async () => {
  const f = createFixture(); f.state.unknown = true; await assert.rejects(() => f.startRouter());
  assert.equal(f.events.includes('error-writer'), false); assert.equal(f.events.includes('inner'), false); assert.equal(f.bootstrap.helperMayStillRun(), true);
  assert.ok(f.servers.every(server => server.closeCalls === 0));
});

test('available upload cannot advertise or queue a missing worker and returns stable501 before drain', async () => {
  const f = createFixture(), warm = await f.warm(); f.factory.installWarm(); let drains = 0, queues = 0;
  const setup = f.api.setup.create({ worker: () => f.workerHooks, inspect: async () => ({ base: f.paths.base, authority: f.fullAuthority, configMirror: true }),
    maintenance: { accepting: () => true, status: () => ({}), begin() { drains++; throw Error('No drain'); } },
    id: () => 'c'.repeat(48), now: () => new Date(0).toISOString(), validateDirectories: async () => {}, defer() { queues++; throw Error('No job queue'); } });
  const status = await setup.status(); assert.equal(status.capabilities.upload, true); assert.equal(status.capabilities.worker, false); assert.equal(status.capabilities.download, false);
  const body = { operation: 'disable', password: 'synthetic setup password', expectedAuthority: f.fullAuthority, backupDirectory: f.paths.backup, confirmPlaintext: true };
  await assert.rejects(() => setup.submit(body), error => error.code === 'work_data_setup.worker_unavailable' && error.apiCode === error.code && error.statusCode === 501);
  assert.equal(body.password, ''); assert.equal(drains, 0); assert.equal(queues, 0); assert.equal((await setup.status()).job, null); await f.finishWarm(warm);
});

function createSetup(f) {
  const counters = { drains: 0, queues: 0 };
  const setup = f.api.setup.create({ worker: () => f.workerHooks, inspect: async () => ({ base: f.paths.base, authority: f.fullAuthority, configMirror: true }),
    maintenance: { accepting: () => true, status: () => ({}), begin() { counters.drains++; throw Error('No drain'); } },
    id: () => 'c'.repeat(48), now: () => new Date(0).toISOString(), validateDirectories: async () => {}, defer() { counters.queues++; throw Error('No job queue'); } });
  return { setup, counters };
}

test('a completed result receipt read through workerHooks still advertises no worker and admits no job', async () => {
  const f = createFixture(), warm = await f.warm(); f.factory.installWarm();
  const receipt = Object.freeze({ schema: 1, id: 'd'.repeat(48), operation: 'disable', state: 'published', authority: f.fullAuthority });
  f.workerHooks.readResult = async () => receipt;
  const { setup, counters } = createSetup(f);
  const status = await setup.status();
  assert.deepEqual(status.lastResult, receipt); assert.equal(status.job, null);
  assert.equal(status.capabilities.worker, false); assert.equal(status.capabilities.upload, true); assert.equal(status.capabilities.download, false);
  assert.equal(Object.keys(status.capabilities).length, 3);
  assert.equal(f.workerHooks.start, undefined);
  const body = { operation: 'disable', password: 'synthetic setup password', expectedAuthority: f.fullAuthority, backupDirectory: f.paths.backup, confirmPlaintext: true };
  await assert.rejects(() => setup.submit(body), error => error.code === 'work_data_setup.worker_unavailable' && error.apiCode === error.code && error.statusCode === 501);
  assert.equal(body.password, ''); assert.equal(counters.drains, 0); assert.equal(counters.queues, 0);
  const again = await setup.status(); assert.equal(again.job, null); assert.deepEqual(again.lastResult, receipt); assert.equal(again.capabilities.worker, false);
  await f.finishWarm(warm);
});

test('an unreadable worker result refuses status as 503 result_unavailable instead of a worker advertisement', async () => {
  const f = createFixture(), warm = await f.warm(); f.factory.installWarm();
  f.workerHooks.readResult = async () => { throw Object.assign(Error('modeled result record changed'), { code: 'work_data_result.record_changed' }); };
  const { setup, counters } = createSetup(f);
  await assert.rejects(() => setup.status(), error => error.code === 'work_data_setup.result_unavailable'
    && error.apiCode === 'work_data_setup.result_unavailable' && error.statusCode === 503);
  assert.equal(f.workerHooks.start, undefined); assert.equal(counters.drains, 0); assert.equal(counters.queues, 0);
  await f.finishWarm(warm);
});

test('an existing worker start hook is never borrowed by installWarm or activateServe', async () => {
  const f = createFixture(), warm = await f.warm(); let starts = 0;
  const sentinel = async () => { starts++; throw Error('unreachable worker start'); };
  f.workerHooks.start = sentinel;
  assert.throws(() => f.factory.installWarm(), { code: 'work_data_host.worker_hooks_invalid' });
  assert.equal(f.state.configured, null); assert.equal(f.workerHooks.putUpload, undefined);
  assert.equal(f.workerHooks.resolveUpload, undefined); assert.equal(f.workerHooks.readResult, undefined);
  assert.equal(f.workerHooks.start, sentinel); assert.equal(starts, 0);
  const runtime = f.api.runtime.create(f.factory.runtimeHost({ base: warm.session.base, role: 'warm' }));
  assert.throws(() => runtime.activateServe(), { code: 'work_data_setup.runtime_not_captured' });
  await runtime.captureServe(f.captureContext(warm.session, warm.ownership));
  assert.equal(runtime.activateServe(), false);
  assert.equal(f.workerHooks.start, sentinel); assert.equal(starts, 0);
  await f.finishWarm(warm);
});

const foldPath = value => process.platform === 'win32' ? value.toLowerCase() : value;

test('warm adaptersReady reads every live driver and health gate instead of configure success', async () => {
  const f = createFixture(), warm = await f.warm(), installed = f.factory.installWarm();
  // The claim adapter arrives through live wiring; configure/install alone is never enough.
  f.bindings.claim = f.claim;
  assert.equal(installed.host.adaptersReady(), true);
  assert.equal(f.factory.capabilities.productionReady, false);
  assert.equal(installed.capabilities.worker, false);
  assert.equal(installed.capabilities.download, false);
  assert.equal(installed.capabilities.crashClaim, false);
  assert.equal(installed.capabilities.activation, false);

  // A configured runtime host whose warm source was never installed is not ready.
  const uninstalled = createFixture(), opened = await uninstalled.open(uninstalled.factory);
  uninstalled.bindings.claim = uninstalled.claim;
  assert.equal(uninstalled.factory.runtimeHost({ base: opened.session.base, role: 'warm' }).adaptersReady(), false);
  await uninstalled.finishWarm(opened);

  // A Proxy-shaped bindings object never lends adapters to a new factory.
  assert.throws(() => f.api.host.create({ proc: f.proc, bindings: new Proxy(f.bindings, {}) }), { code: 'work_data_host.bindings_invalid' });

  // Command identity is re-derived from the current verifier entry, not remembered.
  f.context.WorkDataVerifierEntry = { command: () => ({ command: f.proc.execPath, args: ['work-data-verify'] }) };
  assert.equal(installed.host.adaptersReady(), true);
  f.context.WorkDataVerifierEntry = { command: () => ({ command: f.proc.execPath, args: ['other-entry.js', 'work-data-verify'] }) };
  assert.equal(installed.host.adaptersReady(), false);
  delete f.context.WorkDataVerifierEntry;
  assert.equal(installed.host.adaptersReady(), true);

  const cases = [
    ['claim', f => { f.bindings.claim = null; }, true],
    ['result adapter', f => { f.bindings.resultApi = null; }, true],
    ['control adapter', f => { f.bindings.controlApi = null; }, true],
    ['worker adapter', f => { f.bindings.workerApi = null; }, true],
    ['command executable', f => { f.bindings.command = mode => ({ command: f.proc.execPath + '.other', args: [mode] }); }, true],
    ['command entry', f => { f.bindings.command = mode => ({ command: f.proc.execPath, args: ['relative-entry.js', mode] }); }, true],
    ['command mode', f => { f.bindings.command = mode => ({ command: f.proc.execPath, args: [mode === 'work-data-maintenance' ? 'work-data-successor' : 'work-data-maintenance'] }); }, true],
    ['verifier entry', f => { f.bindings.native = f.native; }, true],
    ['native helper', f => { f.state.unknown = true; }, true],
    ['keeper and owner', f => { f.servers[0].emit('error', Error('modeled ownership loss')); }, true]
  ];
  for (const [name, mutate, wired] of cases) {
    const fixture = createFixture(), warm = await fixture.warm(), installed = fixture.factory.installWarm();
    if (wired) fixture.bindings.claim = fixture.claim;
    mutate(fixture);
    assert.equal(installed.host.adaptersReady(), false, name);
  }
});

test('cold adaptersReady needs the same adapters without a warm source or a base prefetch', async () => {
  const f = createFixture();
  f.bindings.claim = f.claim;
  const host = f.factory.runtimeHost({ base: f.paths.base, role: 'cold' });
  assert.equal(host.adaptersReady(), true);
  assert.equal(f.events.includes('flush'), false);

  f.bindings.resultApi = null;
  assert.equal(host.adaptersReady(), false);

  const g = createFixture();
  g.bindings.claim = g.claim;
  const other = g.factory.runtimeHost({ base: g.paths.base, role: 'cold' });
  g.state.unknown = true;
  assert.equal(other.adaptersReady(), false);
  assert.equal(other.helperMayStillRun(), true);
});

test('retirement requires a retired drain, zero counters, no inflight operation and a healthy source', async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.installWarm().host;
  assert.equal(host.retiredReceipt(), null);
  assert.equal(host.isRetired(), false);

  f.state.maintenance.phase = 'retired';
  assert.equal(host.isRetired(), true);
  const receipt = host.retiredReceipt();
  assert.deepEqual({ ...receipt, busy: { ...receipt.busy } }, { phase: 'retired', admitted: 0, writers: 0, dirty: 0, busy: { turns: 0 },
    inflight: 0, installed: true, keeper: true, owner: true, helper: false });

  for (const [name, value, reset] of [['admitted', 1, 0], ['writers', 1, 0], ['dirty', 1, 0], ['busy', { turns: 1 }, { turns: 0 }]]) {
    f.state.maintenance[name] = value;
    assert.equal(host.isRetired(), false, name);
    f.state.maintenance[name] = reset;
  }
  f.state.maintenance.phase = 'idle';
  assert.equal(host.isRetired(), false);
  f.state.maintenance.phase = 'retired';

  // A pending source-scoped operation blocks retirement; jobs.size is never consulted.
  let release; const pending = new Promise(resolve => { release = resolve; });
  const realResult = f.bindings.resultApi;
  f.bindings.resultApi = { create: () => ({ read: () => pending }) };
  const inflight = warm.session.readResult();
  await tick();
  assert.equal(host.isRetired(), false);
  release({});
  await inflight;
  f.bindings.resultApi = realResult;
  assert.equal(host.isRetired(), true);

  // Synthesized, borrowed or incomplete drain evidence never retires.
  const retired = { phase: 'retired', admitted: 0, writers: 0, dirty: 0, busy: { turns: 0 } };
  f.bindings.maintenance = new Proxy({ status: () => retired }, {});
  assert.equal(host.isRetired(), false);
  f.bindings.maintenance = { status: () => ({ phase: 'retired', admitted: 0, writers: 0, dirty: 0 }) };
  assert.equal(host.isRetired(), false);
  f.bindings.maintenance = { status: () => retired };
  assert.equal(host.isRetired(), true);
  f.servers[0].emit('error', Error('modeled ownership loss'));
  assert.equal(host.isRetired(), false);
});

function fakeChild(pid) {
  const handlers = new Map();
  return { pid, connected: true, exitCode: null, signalCode: null, disconnects: 0, kills: 0,
    disconnect() { this.connected = false; this.disconnects++; },
    kill() { this.kills++; },
    once(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); return this; },
    removeListener(event, fn) { handlers.set(event, (handlers.get(event) || []).filter(row => row !== fn)); return this; },
    emit(event, ...args) { for (const fn of [...(handlers.get(event) || [])]) fn(...args); return true; } };
}

test('stopUncommitted disconnects only its own uncommitted child and waits for the actual exit', async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.installWarm().host;
  const child = fakeChild(4242);
  f.bindings.workerApi = { ...f.bindings.workerApi, spawnCold() { return child; } };
  assert.equal(host.workerApi.spawnCold({ command: 'node', args: [] }, {}), child);

  // Another factory's host never inherits this registry entry.
  const foreignHost = f.api.host.create({ proc: f.proc, bindings: f.bindings }).runtimeHost({ base: f.paths.base, role: 'cold' });
  await assert.rejects(() => foreignHost.stopUncommitted(child), { code: 'work_data_host.child_unregistered' });
  assert.equal(child.disconnects, 0); assert.equal(child.kills, 0);

  const stopping = host.stopUncommitted(child);
  assert.equal(child.disconnects, 1);
  assert.equal(child.kills, 0, 'an uncommitted child is never killed');
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const receipt = await stopping;
  assert.equal(receipt.pid, 4242); assert.equal(receipt.exited, true);
  assert.equal(child.kills, 0);

  const stranger = fakeChild(7);
  for (const value of [stranger, new Proxy(stranger, {}), { ...stranger }]) {
    await assert.rejects(() => host.stopUncommitted(value), { code: 'work_data_host.child_unregistered' });
  }
  assert.equal(stranger.disconnects, 0); assert.equal(stranger.kills, 0);
  await f.finishWarm(warm);
});

test('stopUncommitted never kills and retains ownership when the child exit is not observed', async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.installWarm().host;
  const child = fakeChild(4343);
  f.bindings.workerApi = { ...f.bindings.workerApi, spawnCold() { return child; } };
  host.workerApi.spawnCold({ command: 'node', args: [] }, {});
  const before = f.timeouts.length;
  const stopping = host.stopUncommitted(child); stopping.catch(() => {});
  assert.equal(f.timeouts.length, before + 1);
  await tick();
  assert.equal(child.disconnects, 1); assert.equal(child.kills, 0);
  f.timeouts[before].fn();
  await assert.rejects(() => stopping, error => error.code === 'work_data_host.worker_stop_timeout'
    && error.ownershipRetained === true && error.helperMayStillRun === true);
  assert.equal(child.kills, 0);
  // A retained source is never released as if the stop had succeeded.
  await assert.rejects(() => warm.ownership.release());
});

test('exit runs only after a live retired receipt and maps a returned exit to process_exit_returned', async () => {
  const f = createFixture(), warm = await f.warm(), host = f.factory.installWarm().host;
  await assert.rejects(() => host.exit(0), { code: 'work_data_host.exit_not_retired' });
  assert.deepEqual(f.state.exitCalls, []);
  assert.equal(f.api.ownership.owns(warm.ownership, f.paths.base), true);

  f.state.maintenance.phase = 'retired';
  await assert.rejects(() => host.exit(0), error => error.code === 'work_data_host.process_exit_returned'
    && error.ownershipRetained === true && error.cause?.code === 'MODELED_PROCESS_EXIT');
  assert.deepEqual(f.state.exitCalls, [0]);
  await assert.rejects(() => warm.ownership.release());
});

test('cold exit requires a finished cold source and never exits while the owner is still held', async () => {
  const f = createFixture();
  const host = f.factory.runtimeHost({ base: f.paths.base, role: 'cold' });
  await assert.rejects(() => host.exit(0), { code: 'work_data_host.exit_not_finished' });
  assert.deepEqual(f.state.exitCalls, []);
  const ownership = await host.acquire([f.paths.base]);
  await assert.rejects(() => host.exit(0), { code: 'work_data_host.exit_not_finished' });
  assert.equal(await host.withColdSource({ ownership, base: f.paths.base }, async () => 42), 42);
  await assert.rejects(() => host.exit(0), error => error.code === 'work_data_host.process_exit_returned');
  assert.deepEqual(f.state.exitCalls, [0]);
});

test('startColdMaintenance builds and configures exactly one cold runtime host, then runs cold', async () => {
  const f = createFixture();
  f.bindings.claim = f.claim;
  f.proc.env = { RUYI_HOME: f.paths.base };
  const calls = []; let seen = null, runtime = null;
  const hooks = {
    configure(host) { calls.push('configure'); seen = host; runtime = f.api.runtime.create(host); return runtime; },
    runCold() { calls.push('runCold'); assert.ok(runtime); return 'cold-finished'; }
  };
  assert.equal(await f.api.host.startColdMaintenance({ proc: f.proc, hooks, bindings: f.bindings }), 'cold-finished');
  assert.deepEqual(calls, ['configure', 'runCold']);
  assert.equal(seen.process, f.proc);
  assert.equal(seen.adaptersReady(), true);
  assert.equal(await seen.base(), foldPath(f.paths.base));
  assert.equal(f.state.configured, null);
  assert.equal(f.events.includes('flush'), false);

  const missing = createFixture();
  await assert.rejects(() => missing.api.host.startColdMaintenance({ proc: missing.proc, hooks, bindings: missing.bindings }),
    { code: 'work_data_host.cold_base_invalid' });

  const failing = createFixture();
  failing.proc.env = { RUYI_HOME: failing.paths.base };
  const order = [];
  await assert.rejects(() => failing.api.host.startColdMaintenance({ proc: failing.proc, bindings: failing.bindings,
    hooks: { configure() { order.push('configure'); throw Error('modeled configure failure'); }, runCold() { order.push('runCold'); } } }),
  /modeled configure failure/);
  assert.deepEqual(order, ['configure']);
});

test('13au installs one real claim on the runtime hooks and the boot gate cleans only proven records', async t => {
  const w = await createClaimWiring();
  t.after(() => w.dispose());
  const hooks = w.hooks;
  // 13am's hook block never sets a claim; 13au's module tail installs the only one.
  assert.equal(w.installedBy13am, undefined);
  // 13av carries the fresh-root activation API on that same owner; 13au installs
  // that exact object instead of minting a parallel activation owner.
  assert.deepEqual(Object.keys(hooks.claim).sort(), ['activation', 'classify', 'inspect', 'remove', 'write']);
  assert.equal(hooks.activation, hooks.claim.activation);
  assert.deepEqual(Object.keys(hooks.activation).sort(), ['inspect', 'remove', 'write']);

  // productionBindings reuses that exact instance instead of minting a parallel owner.
  const factory = w.api.host.create({ proc: w.proc });
  const coldHost = factory.runtimeHost({ base: w.canonicalBase, role: 'cold' });
  assert.equal(coldHost.claim, hooks.claim);
  assert.equal(coldHost.adaptersReady(), true);

  const lease = await w.lease();
  t.after(() => lease.release());
  const boot = () => hooks.inspectBoot({ base: w.canonicalBase, ownership: lease });
  const present = async () => (await hooks.claim.inspect({ base: w.canonicalBase })).present;

  // 1. No handoff record: boot proceeds and creates nothing.
  assert.equal(await boot(), true);
  assert.equal(await present(), false);
  assert.deepEqual(w.claimEntries(), []);

  // 2. armed is inert and is cleaned through the exact inspected receipt.
  await hooks.claim.write(w.claimRecord('armed'));
  assert.equal(await present(), true);
  assert.equal(await boot(), true);
  assert.equal(await present(), false);

  // 3. committed with a live child is pending: refuse and keep the record bytes.
  const armedAgain = await hooks.claim.write(w.claimRecord('armed'));
  const committed = await hooks.claim.write(w.claimRecord('committed', { updatedAt: '2026-10-27T00:00:01.000Z' }), armedAgain);
  const pendingBytes = w.claimBytes();
  await assert.rejects(boot, { code: 'work_data_setup.handoff_pending' });
  assert.deepEqual(w.claimBytes(), pendingBytes);

  // 4. owned plus a result for a different job is not complete: refuse, keep the record.
  await hooks.claim.write(w.claimRecord('owned', { updatedAt: '2026-10-27T00:00:02.000Z' }), committed);
  w.writeResult(w.resultRecord('d'.repeat(48)));
  const ownedBytes = w.claimBytes();
  await assert.rejects(boot, { code: 'work_data_setup.handoff_pending' });
  assert.deepEqual(w.claimBytes(), ownedBytes);

  // 5. owned plus the matching result is complete: clean exactly that record.
  w.writeResult(w.resultRecord('a'.repeat(48)));
  assert.equal(await boot(), true);
  assert.equal(await present(), false);
});

test('without the claim module the hook stays unset and the host advertises no worker', async t => {
  const w = await createClaimWiring({ claimModule: false });
  t.after(() => w.dispose());
  // 13au's tail refuses to synthesize a claim owner when 13av is absent.
  assert.equal(w.hooks.claim, undefined);
  const factory = w.api.host.create({ proc: w.proc });
  const coldHost = factory.runtimeHost({ base: w.canonicalBase, role: 'cold' });
  assert.equal(coldHost.claim, null);
  assert.equal(coldHost.adaptersReady(), false, 'the missing claim keeps the worker unready');
  const lease = await w.lease();
  t.after(() => lease.release());
  assert.equal(await w.hooks.inspectBoot({ base: w.canonicalBase, ownership: lease }), true);
});

test('startSuccessorMaintenance prepares, starts the serve and completes only in that order', async () => {
  const f = createFixture();
  f.proc.env = { RUYI_HOME: f.paths.base };
  const order = [], channel = { kind: 'modeled-channel' }, options = { host: '127.0.0.1', port: '34567' };
  let served = null;
  const hooks = {
    prepareSuccessor(pipe, { base }) { order.push('prepare'); assert.equal(pipe, channel); assert.equal(base, f.paths.base); return { options }; },
    completeSuccessor() { order.push('complete'); return { kind: 'serve-ready' }; }
  };
  const startServe = async value => { order.push('serve'); served = value; return { listening: true }; };
  assert.deepEqual(await f.api.host.startSuccessorMaintenance({ proc: f.proc, hooks, startServe, channel }), { kind: 'serve-ready' });
  assert.deepEqual(order, ['prepare', 'serve', 'complete']);
  assert.equal(served, options);

  for (const failing of ['prepare', 'serve']) {
    const seen = []; let completed = 0;
    const broken = {
      prepareSuccessor() { seen.push('prepare'); if (failing === 'prepare') throw Error('modeled prepare failure'); return options; },
      completeSuccessor() { seen.push('complete'); completed++; return {}; }
    };
    const serve = async () => { seen.push('serve'); if (failing === 'serve') throw Error('modeled serve failure'); };
    await assert.rejects(() => f.api.host.startSuccessorMaintenance({ proc: f.proc, hooks: broken, startServe: serve, channel }), /modeled .* failure/);
    assert.equal(completed, 0);
    assert.deepEqual(seen, failing === 'prepare' ? ['prepare'] : ['prepare', 'serve']);
  }

  const missing = createFixture(); let prepared = 0;
  await assert.rejects(() => missing.api.host.startSuccessorMaintenance({ proc: missing.proc, channel,
    hooks: { prepareSuccessor() { prepared++; }, completeSuccessor() {} }, startServe: async () => {} }), { code: 'work_data_host.cold_base_invalid' });
  assert.equal(prepared, 0);
});

function verifierInput(target) {
  return Buffer.from(JSON.stringify({ schema: 1, kind: 'verify-full', id: 'a'.repeat(48), nonce: 'c'.repeat(64),
    parentPid: 888, target, generation: 1, password: 'synthetic verifier password' }));
}

const verifierClock = { setTimeout: () => ({ ref() {}, unref() {} }), clearTimeout() {}, setInterval: () => ({ ref() {}, unref() {} }) };

function verifierChannel(bytes, sent) {
  return { parentConnected: () => true, parentPid: () => 888, readInput: async () => bytes, send: async message => { sent.push(message); } };
}

test('the real verifier accepts a Windows case variant and keeps the requested path unchanged', async () => {
  const f = createFixture(), target = f.paths.base.toUpperCase();
  const seen = { acquire: [], manifest: [], snapshot: [] };
  const ownership = { ...f.api.ownership, acquire: async roots => { seen.acquire.push([...roots]); return f.api.ownership.acquire(roots); } };
  const manifest = { ...f.nativeBindings.manifest, create: options => { seen.manifest.push(options.base); return f.nativeBindings.manifest.create(options); } };
  const fullSnapshot = { ...f.nativeBindings.fullSnapshot, create: options => { seen.snapshot.push(options.base); return f.nativeBindings.fullSnapshot.create(options); } };
  const adapter = f.api.native.create({ bindings: { ...f.nativeBindings, ownership, manifest, fullSnapshot }, proc: f.proc, clock: verifierClock });
  // The memory filesystem is case-insensitive and the fixture models win32, so this
  // target is one physical directory whose spelling differs only by letter case.
  assert.notEqual(target, f.paths.base);
  assert.equal(target.toLowerCase(), f.paths.base.toLowerCase());

  const sent = [], bytes = verifierInput(target);
  const reply = await adapter.runVerifier(verifierChannel(bytes, sent));
  assert.equal(reply.kind, 'verified-full');
  assert.equal(reply.target, target, 'the result keeps the requested spelling');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, target);
  assert.deepEqual(seen.acquire, [[target]], 'acquire receives the original request path');
  assert.deepEqual(seen.manifest, [target, target], 'both authority reads keep the original path');
  assert.deepEqual(seen.snapshot, [target], 'the snapshot keeps the original path');
  assert.ok(bytes.every(value => value === 0));
});

test('the real verifier still refuses a junction alias and a different physical target', async () => {
  const f = createFixture();
  const other = path.join(f.root, 'other-base'); f.memory.mkdir(other);
  const baseLink = path.join(f.root, 'base-link'), otherLink = path.join(f.root, 'other-link');
  const links = new Map([[baseLink.toLowerCase(), f.paths.base], [otherLink.toLowerCase(), other]]);
  const realpath = f.memory.io.realpath.bind(f.memory.io);
  f.memory.io.realpath = async file => {
    const resolved = path.resolve(file);
    for (const [link, destination] of links) if (resolved.toLowerCase() === link) return destination;
    return realpath(file);
  };
  const adapter = f.api.native.create({ bindings: f.nativeBindings, proc: f.proc, clock: verifierClock });
  // Junction aliases (including a case-only spelling of a real alias) resolve to a
  // different physical directory and must still be refused before any owner exists.
  for (const target of [baseLink, otherLink, baseLink.toUpperCase()]) {
    const sent = [], bytes = verifierInput(target);
    await assert.rejects(() => adapter.runVerifier(verifierChannel(bytes, sent)), { code: 'work_data_adapter.parent_or_target_invalid' });
    assert.equal(sent.length, 0);
    assert.ok(bytes.every(value => value === 0));
  }
});

// ---------------------------------------------------------------------------
// B2: fresh-root activation ownership. 13av carries the receipt API on the one
// claim owner; 13au installs that exact object and hands each role only its verbs.
// ---------------------------------------------------------------------------
const nodeFs = require('node:fs');

function activationRecord(w, target) {
  const stat = nodeFs.lstatSync(target, { bigint: true });
  return { schema: 1, activation: 'separate-fresh-root', operation: 'restore', base: target,
    baseIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    authority: { generation: 0, id: null, mode: 'plain', sha256: null },
    id: 'a'.repeat(48), nonce: 'b'.repeat(64), parentPid: w.proc.pid, resultSha256: 'c'.repeat(64),
    createdAt: '2026-10-27T00:00:00.000Z' };
}

test('13au installs the claim owner activation API and gives cold only write/inspect', async t => {
  const w = await createClaimWiring();
  t.after(() => w.dispose());
  const target = path.join(w.root, 'target'); nodeFs.mkdirSync(target);
  const canonicalTarget = await w.api.ownership.canonicalRoot(target);

  // The tail installs the claim owner's own activation object, never a clone.
  assert.equal(w.hooks.activation, w.hooks.claim.activation);
  assert.deepEqual(Object.keys(w.hooks.activation).sort(), ['inspect', 'remove', 'write']);

  const cold = w.api.host.create({ proc: w.proc }).runtimeHost({ base: w.canonicalBase, role: 'cold' });
  assert.equal(cold.claim, w.hooks.claim);
  assert.deepEqual(Object.keys(cold.activation).sort(), ['inspect', 'write'], 'cold writes and inspects only');
  assert.equal(cold.activation.remove, undefined, 'a cold worker never removes a successor receipt');

  const record = activationRecord(w, canonicalTarget);
  const receipt = await cold.activation.write(record, null);
  assert.deepEqual(Object.keys(receipt).sort(), ['base', 'dev', 'ino', 'sha256']);
  // The raw process owner sees the record written through the role facade: same
  // TEMP namespace, same instance, never a parallel activation owner.
  const raw = await w.hooks.activation.inspect({ base: canonicalTarget });
  assert.equal(raw.present, true);
  assert.deepEqual(JSON.parse(JSON.stringify(raw.value)), record);
  assert.deepEqual(Object.keys(raw.receipt).sort(), ['base', 'dev', 'ino', 'sha256']);

  // Consumption is a CAS on the exact sha/dev/ino receipt.
  const again = await cold.activation.write(record, null).catch(error => { assert.equal(error.code, 'work_data_claim.claim_exists'); return null; });
  assert.equal(again, null, 'a second create for the same target is refused');
  await assert.rejects(() => w.hooks.activation.remove({ ...raw.receipt, sha256: 'd'.repeat(64) }), { code: 'work_data_claim.claim_changed' });
  assert.equal((await w.hooks.activation.inspect({ base: canonicalTarget })).present, true);
  assert.equal(await w.hooks.activation.remove(raw.receipt), true);
  assert.equal((await cold.activation.inspect({ base: canonicalTarget })).present, false);
});

test('activation verbs are role scoped and a missing owner keeps every other adapter ready', async () => {
  const owner = Object.freeze({ inspect: async () => ({ present: false }), write: async () => null, remove: async () => true });
  const warmFixture = createFixture();
  warmFixture.bindings.claim = warmFixture.claim;
  warmFixture.bindings.activation = owner;
  const warm = await warmFixture.warm();
  const warmHost = warmFixture.factory.runtimeHost({ base: warm.session.base, role: 'warm' });
  assert.deepEqual(Object.keys(warmHost.activation).sort(), ['inspect', 'remove'], 'warm/successor inspects and consumes');
  assert.equal(warmHost.activation.write, undefined, 'a plain warm serve has no activation write');
  const installed = warmFixture.factory.installWarm();
  assert.deepEqual(Object.keys(installed.capabilities).sort(), ['activation', 'crashClaim', 'download', 'upload', 'worker']);
  assert.equal(installed.capabilities.activation, false, 'install-time capability stays false');
  assert.equal(installed.capabilities.worker, false);
  await warmFixture.finishWarm(warm);

  // No activation in bindings: the capability is absent, not synthesized, and the
  // remaining maintenance adapters stay ready (enable/export are unaffected).
  const coldFixture = createFixture();
  coldFixture.bindings.claim = coldFixture.claim;
  const missing = coldFixture.api.host.create({ proc: coldFixture.proc, bindings: coldFixture.bindings }).runtimeHost({ base: coldFixture.paths.base, role: 'cold' });
  assert.equal(missing.activation, null);
  assert.equal(missing.adaptersReady(), true);
  coldFixture.bindings.activation = owner;
  const present = coldFixture.api.host.create({ proc: coldFixture.proc, bindings: coldFixture.bindings }).runtimeHost({ base: coldFixture.paths.base, role: 'cold' });
  assert.deepEqual(Object.keys(present.activation).sort(), ['inspect', 'write']);
  assert.equal(present.adaptersReady(), true);

  // An owner missing one verb is treated as absent instead of degrading silently.
  coldFixture.bindings.activation = { inspect: async () => ({ present: false }), write: async () => null };
  const partial = coldFixture.api.host.create({ proc: coldFixture.proc, bindings: coldFixture.bindings }).runtimeHost({ base: coldFixture.paths.base, role: 'cold' });
  assert.equal(partial.activation, null);
});

test('an existing activation owner is never replaced by the module tail', async t => {
  const sentinel = Object.freeze({ inspect: async () => { throw Object.assign(Error('sentinel activation'), { code: 'sentinel.activation' }); }, write: async () => null, remove: async () => true });
  const w = await createClaimWiring({ presetActivation: sentinel });
  t.after(() => w.dispose());
  assert.equal(w.hooks.activation, sentinel);
  const cold = w.api.host.create({ proc: w.proc }).runtimeHost({ base: w.canonicalBase, role: 'cold' });
  assert.deepEqual(Object.keys(cold.activation).sort(), ['inspect', 'write']);
  await assert.rejects(() => cold.activation.inspect({ base: w.canonicalBase }), { code: 'sentinel.activation' });
});
