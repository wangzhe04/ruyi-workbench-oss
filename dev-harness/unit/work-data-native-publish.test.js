'use strict';
// Process ownership failures must never release the migration gate while a native
// helper may still hold filesystem guards. No PowerShell or filesystem writes here.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test'), assert = require('node:assert/strict');
const { sliceBlock } = require('../lib/source-slice');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/01w-work-data-native-publish.js'), 'utf8');
const args = { stage: 'C:\\synthetic\\.work-data\\.active-v1.stage-' + 'a'.repeat(48) + '.json',
  target: 'C:\\synthetic\\.work-data\\active-v1.json', directory: 'C:\\synthetic\\.work-data',
  directories: ['C:\\synthetic\\.work-data\\generations\\' + 'b'.repeat(48), 'C:\\synthetic\\.work-data\\generations', 'C:\\synthetic\\.work-data', 'C:\\synthetic'] };

function fixture(mode = 'no-close', text = source) {
  const timers = new Set(), child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kills = 0;
  child.kill = () => {
    child.kills++;
    if (mode === 'kill-throws') throw Object.assign(Error('synthetic kill failure'), { code: 'EPERM' });
    if (mode === 'kill-error') child.emit('error', Object.assign(Error('synthetic kill failure'), { code: 'EPERM' }));
    if (mode === 'kill-closes') queueMicrotask(() => child.emit('close', 1));
    return false;
  };
  const hooks = {}, context = {
    Buffer, process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }, WorkDataManifest: { Hooks: hooks },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    require: name => {
      assert.ok(['node:child_process', 'node:path'].includes(name), 'native publisher only uses its declared host dependencies');
      return name === 'node:child_process' ? { spawn: () => child } : require(name);
    },
  };
  const api = vm.runInNewContext(text + '\nWorkDataNativePublish;', context);
  assert.deepEqual(Object.keys(api), ['create', 'createFlush']);
  const publish = api.create(); assert.equal(hooks.publish, publish, 'Windows registration uses the same factory publisher');
  const promise = publish(args); let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  const fire = ms => {
    const timer = [...timers].find(item => item.ms === ms);
    assert.ok(timer, 'expected bounded timer ' + ms); timers.delete(timer); timer.fn();
  };
  return { child, promise, fire, timers, settled: () => settled,
    spawn: () => { child.pid = 123456; child.emit('spawn'); } };
}
const tick = () => Promise.resolve().then(() => Promise.resolve());
const uncertainAlive = error => error.commitUncertain === true && error.helperMayStillRun === true;
const success = { ok: true, moved: true, sourceFlushed: true, writeThrough: true, sameVolume: true,
  directoryFlush: [0, 0, 0, 0], sha256: 'a'.repeat(64) };

test('native publisher reports only a true spawn failure with no process identity as definitely unpublished', async () => {
  const f = fixture(); f.child.emit('error', Error('synthetic spawn failure'));
  await assert.rejects(f.promise, error => error.code === 'work_data_manifest.publisher_unavailable'
    && error.commitUncertain === false && error.helperMayStillRun !== true);
  assert.equal(f.child.kills, 0); assert.equal(f.timers.size, 0);
});

async function timeoutFailure(mode, text = source) {
  const f = fixture(mode, text); f.spawn(); f.fire(20000); await tick();
  assert.equal(f.settled(), false, 'kill failure cannot settle before helper close or the termination deadline');
  assert.equal(f.child.kills, 1); f.fire(2000);
  await assert.rejects(f.promise, uncertainAlive);
  assert.equal(f.timers.size, 0);
}
test('a kill error event preserves uncertainty and waits for the termination deadline', () => timeoutFailure('kill-error'));
test('a synchronous kill exception preserves uncertainty and waits for the termination deadline', () => timeoutFailure('kill-throws'));

test('a runtime child error after spawn cannot be mistaken for a failed spawn', async () => {
  const f = fixture(); f.spawn(); f.child.emit('error', Error('synthetic runtime failure')); await tick();
  assert.equal(f.settled(), false); assert.equal(f.child.kills, 1); f.fire(2000);
  await assert.rejects(f.promise, error => error.code === 'work_data_manifest.publisher_process' && uncertainAlive(error));
  assert.equal(f.timers.size, 0);
});

test('an existing child pid is treated as potentially live even before the spawn notification', async () => {
  const f = fixture('kill-error'); f.child.pid = 123456;
  f.child.emit('error', Error('synthetic error before spawn notification')); await tick();
  assert.equal(f.settled(), false); assert.equal(f.child.kills, 1); f.fire(2000);
  await assert.rejects(f.promise, uncertainAlive); assert.equal(f.timers.size, 0);
});

test('confirmed helper close clears all timers without claiming that the commit outcome is known', async () => {
  const f = fixture('kill-closes'); f.spawn(); f.fire(20000);
  await assert.rejects(f.promise, error => error.code === 'work_data_manifest.publisher_timeout'
    && error.commitUncertain === true && error.helperMayStillRun !== true);
  assert.equal(f.child.kills, 1); assert.equal(f.timers.size, 0);
});

test('negative control restoring the old error handler fails the same helper-ownership contract', async () => {
  const handler = sliceBlock(source, "    child.on('error', () => {", "    child.stdout.on('data'");
  assert.ok(handler.length > 100);
  const old = "    child.on('error', () => finish(failure('publisher_unavailable', false)));\n";
  const broken = source.replace(handler, old); assert.notEqual(broken, source);
  await assert.rejects(() => timeoutFailure('kill-error', broken), { code: 'ERR_ASSERTION' });
});

const publishStdoutPipe = "    child.stdout.on('error', () => stop(failure('publisher_pipe', true)));\n";
const publishStderrPipe = "    child.stderr.on('error', () => stop(failure('publisher_pipe', true)));\n";

test('a stdout or stderr pipe error before close keeps the helper uncertain until close or the termination deadline', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = fixture(); f.spawn();
    f.child[stream].emit('error', Error('synthetic ' + stream + ' pipe failure')); await tick();
    assert.equal(f.settled(), false, 'a transport fault cannot settle while the helper may still own guards');
    assert.equal(f.child.kills, 1);
    f.fire(2000);
    await assert.rejects(f.promise, error => error.code === 'work_data_manifest.publisher_pipe' && uncertainAlive(error));
    assert.equal(f.timers.size, 0);
  }
});

test('a pipe error followed by an actual helper close keeps the existing confirmed-close meaning', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = fixture('kill-closes'); f.spawn();
    f.child[stream].emit('error', Error('synthetic ' + stream + ' pipe failure')); await tick();
    await assert.rejects(f.promise, error => error.code === 'work_data_manifest.publisher_pipe'
      && error.commitUncertain === true && error.helperMayStillRun !== true);
    assert.equal(f.child.kills, 1); assert.equal(f.timers.size, 0);
  }
});

test('a stream error after the helper settled is absorbed and cannot retract the result or kill it late', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const f = fixture(); f.spawn();
    f.child.stdout.emit('data', Buffer.from(JSON.stringify(success)));
    f.child.emit('close', 0);
    const result = await f.promise;
    assert.equal(result.ok, true);
    assert.doesNotThrow(() => f.child[stream].emit('error', Error('late ' + stream + ' pipe failure')));
    assert.equal(f.child.kills, 0, 'a settled helper must not be killed by a late transport fault');
    assert.equal(f.timers.size, 0);
  }
});

test('negative control without the stream error listeners turns the same pipe fault into an unhandled emitter error', () => {
  const broken = source.replace(publishStdoutPipe, '').replace(publishStderrPipe, '');
  assert.notEqual(broken, source);
  for (const stream of ['stdout', 'stderr']) {
    const f = fixture('no-close', broken); f.spawn();
    const fault = Error('synthetic ' + stream + ' pipe failure');
    assert.throws(() => f.child[stream].emit('error', fault), error => error === fault);
    assert.equal(f.settled(), false);
  }
});
