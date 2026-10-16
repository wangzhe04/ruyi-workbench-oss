'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/04-permission-runtime.js'), 'utf8');
function fixture() {
  const effects = [];
  const context = vm.createContext({ OVERLAY_ID: 'epoch-one', turnSettlers: new Map(), sessionLastExecutions: new Map(), sessionExecutionEvictionGeneration: 0, activeChildren: new Map(), SessionExecutionHooks: {
    cancelQueuedTurn(sid, run) { effects.push(['queue', sid, run]); return context.queued === run; },
    revokeGrants(sid) { effects.push(['revoke', sid]); },
  }, stopSession(sid, reason) { effects.push(['stop', sid, reason]); context.activeChildren.delete(sid); } });
  for (const name of ['recordSessionExecutionOwner', 'sessionExecutionObservation', 'sessionExecutionSnapshot', 'sessionExecutionCheck', 'sessionExecutionCheckRewind', 'assertSessionExecutionOwner', 'registerSessionExecutionChild', 'requestSessionExecutionStop']) {
    vm.runInContext(functionBlock(source, name), context);
  }
  function admit(run, phase = 'starting') {
    const owner = { driverRunId: run, phase, cancelRequested: false, cancel(reason) { this.cancelRequested = true; effects.push(['cancel', run, reason]); } };
    context.recordSessionExecutionOwner('s', owner);
    return owner;
  }
  return { context, effects, admit, expected: run => ({ serverInstanceId: 'epoch-one', driverRunId: run }) };
}
test('old buttons, explicit idle, missing identity and previous process reject before any stop/revoke/cancel', () => {
  const { context: c, effects, admit, expected } = fixture();
  admit('B');
  for (const value of [expected('A'), null, undefined, { ...expected('B'), serverInstanceId: 'epoch-old' }, {}]) {
    assert.equal(c.requestSessionExecutionStop('s', value).ok, false);
    assert.deepEqual(effects, []);
  }
  assert.equal(c.requestSessionExecutionStop('s', undefined).error, 'execution_identity_required');
});
test('one identity survives startup, queue admission and child gaps; cancellation closes later registration', () => {
  for (const phase of ['starting', 'queued', 'running']) {
    const { context: c, effects, admit, expected } = fixture();
    const owner = admit('A', phase);
    if (phase === 'queued') c.queued = 'A';
    const result = c.requestSessionExecutionStop('s', expected('A'));
    assert.equal(result.stopped, true);
    assert.equal(result.queuedStopped, phase === 'queued');
    assert.equal(owner.cancelRequested, true);
    assert.equal(effects[0][0], 'queue');
    assert.throws(() => c.registerSessionExecutionChild('s', {}, owner), { code: 'STEWARD_TURN_CANCELLED' });
    assert.equal(c.activeChildren.size, 0);
  }
});
test('stale engine never borrows successor ownership or kills its child', () => {
  const { context: c, effects, admit } = fixture();
  const a = admit('A'); const b = admit('B'); const reg = {};
  c.registerSessionExecutionChild('s', reg, b);
  assert.throws(() => c.registerSessionExecutionChild('s', {}, a), { code: 'STEWARD_TURN_CANCELLED' });
  assert.equal(c.activeChildren.get('s'), reg);
  assert.deepEqual(effects, []);
});
test('disconnect preserves session grants; explicit stop revokes once even if repeated while settling', () => {
  const { context: c, effects, admit, expected } = fixture();
  admit('A'); c.requestSessionExecutionStop('s', expected('A'), 'disconnected');
  assert.equal(effects.filter(x => x[0] === 'revoke').length, 0);
  const b = admit('B'); c.registerSessionExecutionChild('s', {}, b);
  c.requestSessionExecutionStop('s', expected('B')); c.requestSessionExecutionStop('s', expected('B'));
  assert.equal(effects.filter(x => x[0] === 'revoke').length, 1);
  assert.equal(effects.filter(x => x[0] === 'stop').length, 1);
});
test('completed undo requires last admitted identity; completion of a newer driver cannot resurrect A', () => {
  const { context: c, admit, expected } = fixture();
  admit('A'); c.turnSettlers.delete('s');
  assert.equal(c.sessionExecutionCheckRewind('s', expected('A')).ok, true);
  assert.equal(c.sessionExecutionCheck('s', expected('A')).ok, false);
  admit('B'); c.turnSettlers.delete('s');
  assert.equal(c.sessionExecutionCheckRewind('s', expected('A')).ok, false);
  assert.equal(c.sessionExecutionCheckRewind('s', expected('B')).ok, true);
  assert.equal(c.sessionExecutionCheckRewind('s', { ...expected('B'), serverInstanceId: 'epoch-old' }).ok, false);
  for (let i = 0; i < 2048; i++) c.recordSessionExecutionOwner('other-' + i, { driverRunId: 'r-' + i });
  assert.equal(c.sessionLastExecutions.size, 2048);
  assert.equal(c.sessionExecutionCheckRewind('s', expected('B')).ok, false);
});

test('idle observations distinguish any newer admission and fail closed after evidence eviction', () => {
  const { context: c, admit } = fixture();
  const initial = JSON.stringify(c.sessionExecutionObservation('s'));
  admit('A'); c.turnSettlers.delete('s');
  assert.notEqual(JSON.stringify(c.sessionExecutionObservation('s')), initial);
  const completed = JSON.stringify(c.sessionExecutionObservation('s'));
  admit('B'); c.turnSettlers.delete('s');
  assert.notEqual(JSON.stringify(c.sessionExecutionObservation('s')), completed);
  for (let i = 0; i < 2049; i++) c.recordSessionExecutionOwner('other-' + i, { driverRunId: 'r-' + i });
  assert.notEqual(JSON.stringify(c.sessionExecutionObservation('s')), initial);
  assert.ok(c.sessionExecutionObservation('s').evictionGeneration > 0);
});

test('a user stop after disconnect revokes that same owner grants exactly once', () => {
  const { context: c, effects, admit, expected } = fixture();
  admit('A');
  c.requestSessionExecutionStop('s', expected('A'), 'disconnected');
  assert.equal(effects.filter(x => x[0] === 'revoke').length, 0);
  const first = c.requestSessionExecutionStop('s', expected('A'), 'stopped');
  const repeated = c.requestSessionExecutionStop('s', expected('A'), 'stopped');
  assert.equal(first.alreadyRequested, false);
  assert.equal(repeated.alreadyRequested, true);
  assert.equal(effects.filter(x => x[0] === 'revoke').length, 1);
});
