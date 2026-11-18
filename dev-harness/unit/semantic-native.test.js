'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const source = fs.readFileSync(path.resolve(__dirname, '../semantic/native-host-prototype.cjs'), 'utf8');
const api = vm.runInNewContext(source + '\nSemanticNativeClient;', { require, Buffer, Date, setTimeout, clearTimeout, fetch, AbortController, AbortSignal });
const nativeRoot = process.env.RUYI_NATIVE_TEST_ROOT;
const freshApi = (clock = Date, load = require) => {
  const priorExitListeners = new Set(process.listeners('exit'));
  const module = vm.runInNewContext(source + '\nSemanticNativeClient;', { require: load, Buffer, Date: clock, setTimeout, clearTimeout, fetch, AbortController, AbortSignal });
  // Fresh modules below own only fake children. The real-process e2e exercises
  // the exit hook; avoid accumulating fake-module hooks in this test process.
  for (const listener of process.listeners('exit')) if (!priorExitListeners.has(listener)) process.removeListener('exit', listener);
  return module;
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fakeChild() {
  const child = new (require('node:events').EventEmitter)();
  child.pid = 2147000000; child.exitCode = null; child.signalCode = null;
  child.ref = child.unref = () => child;
  child.close = () => { child.exitCode = 0; child.emit('close', 0, null); };
  child.kill = () => { child.close(); return true; }; return child;
}

test('native backend is explicit, bounded, and does not activate without enabled authority', async () => {
  const client = api.create();
  try {
    const result = await client.prepare(); assert.equal(result.reason, 'disabled'); assert.equal(client.stats().starts, 0);
    assert.equal(client.estimateEncodingBudget('document', 1), 212);
    assert.equal(client.estimateEncodingBudget('document', 3), 572);
    assert.throws(() => client.estimateEncodingBudget('wrong', 1), /INVALID_BUDGET_REQUEST/);
  } finally { await client.stop(); }
});

test('missing and damaged native asset locks return diagnostic unavailability', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-assets-unit-'));
  for (const damaged of [false, true]) {
    if (damaged) fs.writeFileSync(path.join(directory, 'native.lock.json'), '{}');
    const client = api.create({ root: directory, enabled: async () => true });
    try {
      const result = await client.prepare({ budgetMs: 20000 });
      assert.equal(result.available, false); assert.equal(result.reason, 'unavailable');
      assert.equal(result.diagnostic.code, damaged ? 'ASSET_INTEGRITY_FAILED' : 'MODEL_NOT_INSTALLED');
      assert.equal(client.stats().starts, 0);
    } finally { await client.stop(); }
  }
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('native asset fallback does not swallow configuration/privacy authority or cancellation errors', async () => {
  const denied = Object.assign(new Error('privacy.authority_changed'), { code: 'privacy.authority_changed' });
  const client = api.create({ enabled: async () => { throw denied; } });
  try { await assert.rejects(client.prepare(), error => error === denied); }
  finally { await client.stop(); }
  const controller = new AbortController(), cancelled = new Error('caller.cancelled'); controller.abort(cancelled);
  const idle = api.create({ enabled: async () => true });
  try {
    await assert.rejects(idle.prepare({ signal: controller.signal }), error => error === cancelled);
    await assert.rejects(idle.encode(['public'], { role: 'query', signal: controller.signal }), error => error === cancelled);
    assert.equal(idle.stats().starts, 0);
  } finally { await idle.stop(); }
});

test('helper close cannot remove home or report exit before observed native exit', { skip: !nativeRoot }, async () => {
  const module = freshApi(), proof = deferred(), handed = deferred(); let home;
  const client = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
    home = request.spawnOptions.cwd; const child = fakeChild();
    const owner = Object.freeze({ child, nativePid: 2147000001, exited: proof.promise, terminate: () => proof.promise });
    request.onOwned(owner); child.close(); handed.resolve(); return owner;
  } });
  const prepared = client.prepare({ budgetMs: 20000 }); await handed.promise;
  assert.equal(fs.existsSync(home), true); assert.equal(client.stats().unconfirmedOwners, 1);
  assert.equal(client.descriptor().available, false); assert.equal(client.descriptor().state, 'cleanup-pending');
  let stopped = false; const stop = client.stop().then(value => { stopped = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(stopped, false);
  proof.resolve({ cleanupStatus: 'observed' }); await prepared; const outcome = await stop;
  assert.equal(outcome.workerExited, true); assert.equal(fs.existsSync(home), false); assert.equal(client.stats().unconfirmedOwners, 0);
});

test('unknown native cleanup survives stop and blocks another client for the same asset root', { skip: !nativeRoot }, async () => {
  const module = freshApi(); let home, launches = 0;
  const launchNative = async request => {
    launches++; home = request.spawnOptions.cwd; const child = fakeChild(), exited = Promise.resolve({ cleanupStatus: 'unknown' });
    const owner = Object.freeze({ child, exited, terminate: () => exited }); request.onOwned(owner); child.close(); return owner;
  };
  const first = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative });
  // A missing pre-ready native identity is a protocol failure; ownership must
  // nevertheless remain registered and its unknown cleanup must remain sticky.
  await assert.rejects(first.prepare({ budgetMs: 20000 }), /INVALID_NATIVE_LAUNCH/);
  assert.equal((await first.stop()).workerExited, false); assert.equal(first.descriptor().state, 'cleanup-unknown');
  assert.equal(fs.existsSync(home), true); assert.equal(first.stats().unconfirmedOwners, 1);
  const second = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative });
  assert.equal((await second.prepare()).available, false); assert.equal((await second.stop()).workerExited, false);
  assert.equal(launches, 1); assert.equal(second.stats().verifications, 0);
  // The directory deliberately remains; an unknown result is not cleanup proof.
});

test('errors before and after synchronous ownership retain primary identity despite cleanup failure', { skip: !nativeRoot }, async () => {
  const before = new Error('privacy.before_owned'), beforeModule = freshApi();
  const neverOwned = beforeModule.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async () => { throw before; } });
  await assert.rejects(neverOwned.prepare({ budgetMs: 20000 }), error => error === before);
  assert.equal((await neverOwned.stop()).workerExited, true);
  const after = new Error('privacy.after_owned'), cleanup = new Error('observer.failed'), module = freshApi(); let home;
  const client = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
    home = request.spawnOptions.cwd; const child = fakeChild(), exited = Promise.reject(cleanup);
    const owner = Object.freeze({ child, exited, terminate: async () => { throw cleanup; } });
    request.onOwned(owner); child.close(); throw after;
  } });
  await assert.rejects(client.prepare({ budgetMs: 20000 }), error => error === after);
  const stop = await client.stop(); assert.equal(stop.ok, false); assert.equal(stop.workerExited, false);
  assert.equal(client.descriptor().diagnostic.code, 'NATIVE_CLEANUP_UNCONFIRMED'); assert.equal(fs.existsSync(home), true);
});

test('a late native identity getter failure still terminates the exact owner and preserves the error', { skip: !nativeRoot }, async () => {
  const module = freshApi(), primary = new Error('identity.getter_failed'); let terminations = 0;
  const client = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
    const child = fakeChild(), exited = deferred();
    const owner = Object.freeze({ child, exited: exited.promise, getNativeIdentity: () => { throw primary; },
      terminate: async () => { terminations++; child.close(); exited.resolve({ cleanupStatus: 'observed' }); } });
    request.onOwned(owner); return owner;
  } });
  await assert.rejects(client.prepare({ budgetMs: 20000 }), error => error === primary);
  assert.equal(terminations, 1); assert.equal((await client.stop()).workerExited, true);
  assert.equal(client.stats().unconfirmedOwners, 0);
});

test('host and owner failures stay original when their cleanup crosses the startup deadline', { skip: !nativeRoot }, async () => {
  for (const kind of ['launcher', 'identity']) {
    let now = Date.now(), terminations = 0;
    class Clock extends Date { static now() { return now; } }
    const module = freshApi(Clock), primary = Object.assign(new Error('host.permission_changed'), { code: 'EACCES' });
    const client = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
      const child = fakeChild(), exited = deferred();
      const owner = Object.freeze({ child, exited: exited.promise,
        getNativeIdentity: () => { now = request.deadline + 1; throw primary; },
        terminate: async () => { terminations++; child.close(); exited.resolve({ cleanupStatus: 'observed' }); } });
      request.onOwned(owner);
      if (kind === 'launcher') { now = request.deadline + 1; throw primary; }
      return owner;
    } });
    await assert.rejects(client.prepare({ budgetMs: 20000 }), error => error === primary);
    assert.equal(terminations, 1); assert.equal((await client.stop()).workerExited, true);
    assert.equal(client.stats().unconfirmedOwners, 0);
  }
});

test('OS listener permission failures stay original after the startup deadline', { skip: !nativeRoot }, async () => {
  for (const code of ['EACCES', 'EPERM']) {
    let now = Date.now(), launchDeadline, terminations = 0;
    class Clock extends Date { static now() { return now; } }
    const primary = Object.assign(new Error('listener.permission_changed'), { code });
    const execFile = () => { throw new Error('expected promisified listener query'); };
    execFile[require('node:util').promisify.custom] = async () => { now = launchDeadline + 1; throw primary; };
    const module = freshApi(Clock, name => name === 'node:child_process' ? { ...require(name), execFile } : require(name));
    const client = module.create({ root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
      launchDeadline = request.deadline; const child = fakeChild(), exited = deferred();
      const owner = Object.freeze({ child, nativePid: 2147000001, exited: exited.promise,
        terminate: async () => { terminations++; child.close(); exited.resolve({ cleanupStatus: 'observed' }); } });
      request.onOwned(owner); return owner;
    } });
    await assert.rejects(client.prepare({ budgetMs: 20000 }), error => error === primary);
    assert.equal(terminations, 1); assert.equal((await client.stop()).workerExited, true);
    assert.equal(client.stats().unconfirmedOwners, 0);
  }
});

test('a background hard startup error precedes its unknown-cleanup availability blocker', { skip: !nativeRoot }, async () => {
  const module = freshApi(), primary = Object.assign(new Error('background.permission_changed'), { code: 'EACCES' });
  const cleanup = new Error('observer.failed'), handed = deferred();
  const options = { root: path.resolve(nativeRoot), enabled: async () => true, launchNative: async request => {
    const child = fakeChild(), exited = deferred();
    const owner = Object.freeze({ child, exited: exited.promise, terminate: async () => {
      child.close(); exited.reject(cleanup); throw cleanup;
    } });
    request.onOwned(owner); handed.resolve(); await Promise.resolve(); throw primary;
  } };
  const client = module.create(options);
  assert.equal((await client.prepare({ budgetMs: 500 })).state, 'loading');
  await handed.promise;
  for (let attempt = 0; client.stats().cleanupStatus !== 'unknown' && attempt < 100; attempt++)
    await new Promise(resolve => setTimeout(resolve, 1));
  // Give the single background owner's catch/finally a turn after exit evidence.
  await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(client.prepare({ budgetMs: 20000 }), error => error === primary);
  const sibling = module.create(options);
  assert.equal((await sibling.prepare({ budgetMs: 20000 })).reason, 'unavailable');
  assert.equal(sibling.stats().verifications, 0);
  assert.equal((await client.stop()).workerExited, false); assert.equal((await sibling.stop()).workerExited, false);
});
