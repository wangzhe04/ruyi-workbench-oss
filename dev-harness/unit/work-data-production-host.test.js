'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, tick } = require('../lib/work-data-production-host-fixture');

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
