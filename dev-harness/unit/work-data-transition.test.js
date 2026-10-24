'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const transition = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,
  '../../ruyi-workbench/app/src/01u-work-data-transition.js'), 'utf8') + '\nWorkDataTransition;', { require });
const latch = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const code = suffix => error => error.code === 'work_data.transition_' + suffix;

test('an exclusive owner waits for an admitted task without stopping its nested writes', async () => {
  const gate = transition.create({ generation: 7 }), taskStarted = latch(), finish = latch(), events = [];
  const task = gate.run(async check => {
    taskStarted.resolve(); await finish.promise; check();
    await gate.run(async nested => { nested(); events.push('write'); });
  });
  await taskStarted.promise;
  const migration = gate.exclusive(async owner => { owner.check(); events.push('switch'); });
  assert.equal(gate.status().phase, 'waiting');
  await assert.rejects(gate.run(() => events.push('new task')), code('busy'));
  finish.resolve(); await task; await migration;
  assert.deepEqual(events, ['write', 'switch']);
  assert.equal(gate.status().phase, 'open');
});

test('unawaited nested work remains counted and cannot publish after its outer task ends', async () => {
  const gate = transition.create(), finish = latch(), started = latch();
  let nested;
  await gate.run(async () => { nested = gate.run(async check => { started.resolve(); await finish.promise; check(); }); });
  await started.promise;
  let entered = false;
  const migration = gate.exclusive(async () => { entered = true; });
  assert.equal(entered, false);
  finish.resolve(); await assert.rejects(nested, code('stale_writer')); await migration;
  assert.equal(entered, true); assert.equal(gate.status().active, 0);
});

test('a detached old context cannot acquire fresh admission after a task completes', async () => {
  const gate = transition.create(), finish = latch(); let detached;
  await gate.run(async () => { detached = finish.promise.then(() => gate.run(() => 'late write')); });
  finish.resolve(); await assert.rejects(detached, code('stale_writer'));
  assert.equal(await gate.run(check => check()), 0);
});

test('cancelling an idle wait reopens admission and preserves the admitted task', async () => {
  const gate = transition.create(), finish = latch(), started = latch(), abort = new AbortController();
  const task = gate.run(async check => { started.resolve(); await finish.promise; return check(); });
  await started.promise;
  const migration = gate.exclusive(() => assert.fail('must not switch'), { signal: abort.signal });
  abort.abort(); await assert.rejects(migration, code('cancelled'));
  assert.equal(gate.status().phase, 'open');
  assert.equal(await gate.run(check => check()), 0);
  finish.resolve(); assert.equal(await task, 0);
});

test('retirement permanently rejects new writers and expires captured check callbacks', async () => {
  const gate = transition.create({ generation: 4 }); let stale;
  await gate.run(check => { stale = check; });
  await gate.exclusive(async owner => owner.commit(5, async () => {}));
  assert.equal(gate.status().generation, 5); assert.equal(gate.status().phase, 'retired');
  assert.throws(stale, code('stale_writer'));
  await assert.rejects(gate.run(() => {}), code('restart_required'));
  await assert.rejects(gate.exclusive(() => {}), code('restart_required'));
});

test('failure after durable commit cannot reopen old generation writers', async () => {
  const gate = transition.create();
  await assert.rejects(gate.exclusive(async owner => { await owner.commit(1, async () => {}); throw Error('restart failed'); }), /restart failed/);
  assert.equal(gate.status().phase, 'retired');
});

test('failed preparation releases the barrier but never reuses its exclusive capability', async () => {
  const gate = transition.create(); let stale;
  await assert.rejects(gate.exclusive(owner => { stale = owner; throw Error('ENOSPC'); }), /ENOSPC/);
  assert.equal(gate.status().phase, 'open');
  assert.throws(stale.check, code('owner_expired'));
  await assert.rejects(stale.commit(1, () => {}), code('owner_expired'));
});

test('parallel exclusive requests cannot overwrite the pending owner', async () => {
  const gate = transition.create(), finish = latch(), started = latch();
  const task = gate.run(async () => { started.resolve(); await finish.promise; });
  await started.promise;
  const first = gate.exclusive(async () => 'first');
  await assert.rejects(gate.exclusive(() => 'second'), code('busy'));
  finish.resolve(); await task; assert.equal(await first, 'first');
});

test('exclusive calls from an admitted task reject without self-deadlocking', async () => {
  const gate = transition.create();
  await gate.run(async () => assert.rejects(gate.exclusive(() => {}), code('nested_exclusive')));
});

test('abort during preparation is observed and does not commit a generation', async () => {
  const gate = transition.create(), abort = new AbortController();
  await assert.rejects(gate.exclusive(owner => { abort.abort(); owner.check(); }, { signal: abort.signal }), code('cancelled'));
  assert.equal(gate.status().generation, 0); assert.equal(gate.status().phase, 'open');
});

test('cancellation during a successful durable commit cannot reopen the old generation', async () => {
  const gate = transition.create(), abort = new AbortController(), committing = latch(), durable = latch();
  let manifest = 0;
  const migration = gate.exclusive(async owner => {
    await owner.commit(1, async () => { committing.resolve(); await durable.promise; manifest = 1; });
  }, { signal: abort.signal });
  await committing.promise; abort.abort(); durable.resolve(); await migration;
  assert.equal(manifest, 1); assert.equal(gate.status().generation, 1);
  assert.equal(gate.status().phase, 'retired');
  await assert.rejects(gate.run(() => {}), code('restart_required'));
});

test('invalid generation and unowned mutation are rejected', async () => {
  assert.throws(() => transition.create({ generation: -1 }), code('generation'));
  const gate = transition.create(); assert.throws(gate.assertCurrent, code('stale_writer'));
  await assert.rejects(gate.exclusive(owner => owner.commit(2, () => {})), code('generation'));
  assert.equal(gate.status().generation, 0);
});

test('an aborted request never closes admission', async () => {
  const gate = transition.create(), abort = new AbortController(); abort.abort();
  await assert.rejects(gate.exclusive(() => {}, { signal: abort.signal }), code('cancelled'));
  assert.equal(gate.status().phase, 'open');
});

test('an ambiguous commit failure keeps admission closed until process recovery', async () => {
  const gate = transition.create(); let manifest = 0;
  await assert.rejects(gate.exclusive(owner => owner.commit(1, async () => {
    manifest = 1; throw Error('directory flush failed after rename');
  })), /directory flush failed/);
  assert.equal(manifest, 1); assert.equal(gate.status().phase, 'retired');
  await assert.rejects(gate.run(() => {}), code('restart_required'));
});
