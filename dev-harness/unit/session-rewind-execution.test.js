'use strict';
// Deterministic interleavings of the actual rewind and hand-off functions; no server or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBlock, sliceBlock, constBlock } = require('../lib/source-slice');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, 'ruyi-workbench/app', file), 'utf8');
const store = read('src/02-session-store.js');
const conversation = read('public/js/steward-conversation.js');
const execution = id => ({ serverInstanceId: 'process-A', driverRunId: id, phase: 'running' });
const idleOptions = () => ({ guardExecution: true, expectedExecution: null, expectedIdleState: {
  turnSeq: 2, rewindGen: 0, executionObservation: { serverInstanceId: 'process-A', lastDriverRunId: null, evictionGeneration: 0 },
} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  const calls = [];
  const session = { id: 's', turnSeq: 2, messages: [
    { role: 'user', turnSeq: 1, content: 'keep' },
    { role: 'assistant', content: 'kept' },
    { role: 'user', turnSeq: 2, content: 'remove' },
    { role: 'assistant', content: 'removed' },
  ] };
  const ctx = vm.createContext({
    SessionExecutionHooks: {
      snapshot: () => null,
      observation: () => ({ serverInstanceId: 'process-A', lastDriverRunId: null, evictionGeneration: 0 }),
      checkRewind: (_sid, expected) => ({ ok: true, execution: expected }),
      stop: (_sid, expected) => { calls.push(['stop', expected]); return { ok: true, stopped: false }; },
    },
    activeChildren: new Map(), turnSettlers: new Map(), journalWriteChains: new Map(),
    loadSession: async () => { calls.push(['load']); return structuredClone(session); },
    saveSession: async value => { calls.push(['save', value.messages.map(m => m.content)]); },
    readConfig: async () => ({ workDataEncryptionV1: false }),
    WorkDataStore: { acquireSnapshot: () => { throw new Error('OFF rewind must not unlock'); } },
    // This suite controls execution/admission interleavings. Persistence crypto
    // and its no-mutation preflights are exercised by journal-work-data tests.
    journalRevertLogRead: async () => [], journalAssertWritable: async () => {},
    journalReadIndex: async () => [], journalPreflightMutation: async () => new Map(),
    logEvent: () => {}, setTimeout, clearTimeout,
    journalRollbackContents: async () => { calls.push(['rollback']); return { ok: true, reverted: [], failed: [] }; },
    journalRevertLogPrune: async () => {}, bumpMissionChangeSeq: async () => {},
    cancelModelRunsOfDiscardedTurns: () => {}, EventStreamHooks: {}, RUYI_EVENTS: { emit() {} },
    ...overrides,
  });
  const guarded = sliceBlock(store, '// A guarded rewind owns admission', 'async function rewindSessionContents');
  assert.ok(guarded.includes('async function rewindSession('));
  vm.runInContext(functionBlock(read('src/00-boot.js'), 'runKeyedChain') + '\n' + guarded + '\n'
    + ['withJournalWriteLock', 'withJournalArtifactOperation', 'rewindSessionContents', 'rewindSessionArtifactContents'].map(name => functionBlock(store, name)).join('\n') + '\nthis.rewind = rewindSession;', ctx);
  return { ctx, calls, session, rewind: ctx.rewind, blocked: () => ctx.SessionExecutionHooks.admissionBlocked('s') };
}

test('guarded rewind rejects missing identity and stop conflicts before reads or rollback, releasing admission', async () => {
  const f = fixture();
  assert.equal((await f.rewind('s', 2, true, { guardExecution: true })).error, 'execution_identity_required');
  assert.deepEqual(f.calls, []);
  assert.equal(f.blocked(), false);
  f.ctx.SessionExecutionHooks.stop = () => ({ ok: false, error: 'execution_changed' });
  assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).error, 'execution_changed');
  assert.deepEqual(f.calls, []);
  assert.equal(f.blocked(), false);
});

test('admission stays closed through settlement and file rollback, including concurrent rewind', async () => {
  const settled = deferred();
  const rollback = deferred();
  let enteredRollback;
  const entered = new Promise(r => { enteredRollback = r; });
  const f = fixture({ turnSettlers: new Map([['s', { promise: settled.promise }]]),
    journalRollbackContents: async () => { enteredRollback(); await rollback.promise; return { ok: true, reverted: [], failed: [] }; },
  });
  const pending = f.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') });
  assert.equal(f.blocked(), true);
  assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).error, 'rewind_in_progress');
  assert.equal((await f.rewind('s', 2, true)).error, 'rewind_in_progress');
  assert.equal(f.calls.some(c => c[0] === 'save'), false);
  settled.resolve();
  await entered;
  assert.equal(f.blocked(), true);
  rollback.resolve();
  assert.equal((await pending).ok, true);
  assert.equal(f.blocked(), false);
  assert.equal(f.calls.filter(c => c[0] === 'save').length, 1);
});

test('a guarded rewind cannot overlap an already pending legacy rewind', async () => {
  const pendingRead = deferred();
  const f = fixture();
  const load = f.ctx.loadSession;
  f.ctx.loadSession = async id => { await pendingRead.promise; return load(id); };
  const legacy = f.rewind('s', 2, false);
  assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: null })).error, 'rewind_in_progress');
  pendingRead.resolve();
  assert.equal((await legacy).ok, true);
});

test('the actual turn entry refuses admission while guarded rewind awaits storage', async () => {
  const pendingRead = deferred();
  const f = fixture();
  const load = f.ctx.loadSession;
  f.ctx.loadSession = async id => { await pendingRead.promise; return load(id); };
  const pending = f.rewind('s', 2, false, idleOptions());
  assert.equal(f.blocked(), true);
  let registered = 0;
  Object.assign(f.ctx, {
    readConfig: async () => ({}), loadSession: async () => ({ id: 's', todos: [] }),
    AGENT_WAKE_SOURCE: 'agent_wake', EXCLUSIVE_TURN_SOURCES: new Set(),
    sessionTodosSignature: () => '', resolvePermissionMode: () => 'default', permissionModeFrom: () => '',
    configForSessionEngineRoute: config => config, agentWakeChain: new Map(), agentWakeSuppressed: new Set(),
    sessionEngineRouteScopeOverrides: new Map(),
    makeId: () => { registered++; return 'B'; }, bindDriverRun: () => { registered++; },
  });
  vm.runInContext(functionBlock(read('src/10-context-governance.js'), 'runSessionTurn') + '\nthis.startTurn = runSessionTurn;', f.ctx);
  await assert.rejects(f.ctx.startTurn({ sessionId: 's', source: 'steward' }), error => error.code === 'SESSION_EXECUTION_LOCKED');
  assert.equal(registered, 0, 'no new driver identity or grant binding occurs');
  assert.equal(f.ctx.turnSettlers.size, 0);
  f.ctx.loadSession = load;
  pendingRead.resolve();
  assert.equal((await pending).ok, true);
  assert.equal(f.blocked(), false);
});

test('settlement timeout refuses guarded rollback; read/save failures always release admission', async () => {
  const f = fixture({ turnSettlers: new Map([['s', { promise: new Promise(() => {}) }]]),
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
  });
  assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).error, 'rewind_settle_timeout');
  assert.equal(f.calls.some(c => c[0] === 'save' || c[0] === 'rollback'), false);
  assert.equal(f.blocked(), false);
  const readFailure = fixture({ loadSession: async () => { throw new Error('read failed'); } });
  await assert.rejects(readFailure.rewind('s', 2, false, idleOptions()), /read failed/);
  assert.equal(readFailure.blocked(), false);
  const saveFailure = fixture({ saveSession: async () => { throw new Error('save failed'); } });
  await assert.rejects(saveFailure.rewind('s', 2, false, idleOptions()), /save failed/);
  assert.equal(saveFailure.blocked(), false);
});

test('legacy idle rewind remains compatible while guarded explicit idle reaches the same content path', async () => {
  for (const options of [{}, idleOptions()]) {
    const f = fixture();
    assert.equal((await f.rewind('s', 2, false, options)).ok, true);
    assert.equal(JSON.stringify(f.calls.find(c => c[0] === 'save')[1]), JSON.stringify(['keep', 'kept']));
  }
});

test('idle undo rejects any intervening admission, tombstone eviction or process change even without turn progression', async () => {
  const runtime = read('src/04-permission-runtime.js');
  const make = () => {
    const f = fixture({ OVERLAY_ID: 'process-A', sessionLastExecutions: new Map(), sessionExecutionEvictionGeneration: 0 });
    vm.runInContext(['recordSessionExecutionOwner', 'sessionExecutionObservation', 'sessionExecutionSnapshot', 'sessionExecutionCheck', 'sessionExecutionCheckRewind']
      .map(name => functionBlock(runtime, name)).join('\n')
      + '\nSessionExecutionHooks.checkRewind = sessionExecutionCheckRewind; SessionExecutionHooks.observation = sessionExecutionObservation;', f.ctx);
    return f;
  };
  const admitted = make();
  admitted.ctx.recordSessionExecutionOwner('s', { driverRunId: 'B' });
  admitted.ctx.turnSettlers.delete('s');
  assert.equal(admitted.session.turnSeq, 2, 'B may settle before writing any new user message');
  assert.equal((await admitted.rewind('s', 2, true, idleOptions())).error, 'execution_changed');
  assert.deepEqual(admitted.calls, []);
  const evicted = make();
  evicted.ctx.recordSessionExecutionOwner('s', { driverRunId: 'B' });
  evicted.ctx.turnSettlers.delete('s');
  for (let i = 0; i < 2048; i++) evicted.ctx.recordSessionExecutionOwner('other-' + i, { driverRunId: 'driver-' + i });
  assert.equal(evicted.ctx.SessionExecutionHooks.observation('s').lastDriverRunId, null);
  assert.equal((await evicted.rewind('s', 2, true, idleOptions())).error, 'execution_changed');
  assert.deepEqual(evicted.calls, []);
  const restarted = make(); restarted.ctx.OVERLAY_ID = 'process-B';
  assert.equal((await restarted.rewind('s', 2, true, idleOptions())).error, 'execution_changed');
  assert.deepEqual(restarted.calls, []);
});

test('guarded idle requires the complete observation and checks authoritative turn/rewind generations before rollback', async () => {
  for (const expectedIdleState of [undefined, {}, { turnSeq: 2, rewindGen: 0 }, { ...idleOptions().expectedIdleState, rewindGen: '0' }]) {
    const f = fixture();
    assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: null, expectedIdleState })).error, 'execution_identity_required');
    assert.deepEqual(f.calls, []);
    assert.equal(f.blocked(), false);
  }
  for (const field of ['turnSeq', 'rewindGen']) {
    const f = fixture(); f.session[field] = field === 'turnSeq' ? 3 : 1;
    assert.equal((await f.rewind('s', 2, true, idleOptions())).error, 'execution_changed');
    assert.equal(f.calls.some(c => ['stop', 'save', 'rollback'].includes(c[0])), false);
    assert.equal(f.blocked(), false);
  }
});

test('guarded HTTP rewind keeps stable conflict codes and forwards the original idle observation', async () => {
  const boot = read('src/00-boot.js');
  const source = read('src/13b-api-domain-routes.js');
  for (const error of ['execution_identity_required', 'execution_identity_unavailable', 'execution_changed', 'rewind_in_progress', 'rewind_settle_timeout']) {
    let options;
    const ctx = vm.createContext({
      readJsonBody: async () => ({ sessionId: 's', targetTurnSeq: 2, rollbackFiles: true, ...idleOptions() }),
      safeSessionId: id => id, send: (_res, value) => value,
      rewindSession: async (_id, _target, _files, observed) => { options = observed; return { ok: false, error }; },
    });
    vm.runInContext(constBlock(boot, 'LEGACY_API_ERROR_CODES') + '\n'
      + ['normalizeApiErrorPayload', 'json', 'apiFailure'].map(name => functionBlock(boot, name)).join('\n') + '\n'
      + functionBlock(source, 'handleCheckpointApiRoutes') + '\nthis.route = handleCheckpointApiRoutes;', ctx);
    const response = await ctx.route({ method: 'POST' }, {}, '/api/session/rewind');
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(response.body).error.code, error);
    assert.equal(JSON.stringify(options.expectedIdleState), JSON.stringify(idleOptions().expectedIdleState));
  }
});

test('legacy automatic stop compares the pre-read identity and refuses a replacement execution', async () => {
  const a = execution('A');
  const f = fixture({ activeChildren: new Map([['s', { session: { id: 's' } }]]) });
  f.ctx.SessionExecutionHooks.snapshot = () => a;
  f.ctx.SessionExecutionHooks.stop = (_id, expected) => {
    assert.equal(expected, a);
    return { ok: false, error: 'execution_changed' };
  };
  assert.equal((await f.rewind('s', 2, true)).error, 'execution_changed');
  assert.equal(f.calls.some(c => c[0] === 'save' || c[0] === 'rollback'), false);
});

test('legacy rewind observes execution before encryption configuration can yield', async () => {
  const configRead = deferred(), a = execution('A'), b = execution('B');
  let current = a;
  const f = fixture({ readConfig: async () => { await configRead.promise; return { workDataEncryptionV1: false }; },
    activeChildren: new Map([['s', { session: { id: 's' } }]]) });
  f.ctx.SessionExecutionHooks.snapshot = () => current;
  f.ctx.SessionExecutionHooks.stop = (_id, expected) => {
    f.calls.push(['stop', expected]);
    return expected === current ? { ok: true } : { ok: false, error: 'execution_changed' };
  };
  const pending = f.rewind('s', 2, true);
  current = b; f.ctx.activeChildren.set('s', { session: { id: 's' }, owner: b });
  configRead.resolve();
  assert.equal((await pending).error, 'execution_changed');
  assert.equal(f.calls.find(call => call[0] === 'stop')[1], a);
  assert.equal(f.calls.some(call => call[0] === 'save' || call[0] === 'rollback'), false);
});

test('storage preflight failure releases guarded admission before any rollback or save', async () => {
  const f = fixture({ journalAssertWritable: async () => { throw Object.assign(new Error('locked'), { code: 'work_data_store.downgrade_refused' }); } });
  await assert.rejects(f.rewind('s', 2, true, idleOptions()), error => error.code === 'work_data_store.downgrade_refused');
  assert.equal(f.calls.some(call => call[0] === 'save' || call[0] === 'rollback'), false);
  assert.equal(f.blocked(), false);
});

test('completed A can rewind using bounded admission evidence; completed B invalidates old A', async () => {
  const runtime = read('src/04-permission-runtime.js');
  const make = () => {
    const f = fixture({ OVERLAY_ID: 'process-A', sessionLastExecutions: new Map() });
    vm.runInContext(['recordSessionExecutionOwner', 'sessionExecutionSnapshot', 'sessionExecutionCheck', 'sessionExecutionCheckRewind']
      .map(name => functionBlock(runtime, name)).join('\n') + '\nSessionExecutionHooks.checkRewind = sessionExecutionCheckRewind;', f.ctx);
    f.ctx.recordSessionExecutionOwner('s', { driverRunId: 'A' });
    f.ctx.turnSettlers.delete('s');
    return f;
  };
  const a = make();
  assert.equal((await a.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).ok, true);
  assert.equal(a.calls.some(c => c[0] === 'stop'), false, 'completed undo does not broaden ordinary stop matching');
  const b = make();
  b.ctx.recordSessionExecutionOwner('s', { driverRunId: 'B' });
  b.ctx.turnSettlers.delete('s');
  assert.equal((await b.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).error, 'execution_changed');
  assert.deepEqual(b.calls, []);
  for (const invalidate of [f => f.ctx.sessionLastExecutions.clear(), f => { f.ctx.OVERLAY_ID = 'process-B'; }]) {
    const f = make(); invalidate(f);
    assert.equal((await f.rewind('s', 2, true, { guardExecution: true, expectedExecution: execution('A') })).error, 'execution_changed');
    assert.deepEqual(f.calls, []);
  }
});

function undoFixture(response = { ok: true, filesReverted: [] }) {
  const calls = [], problems = [], settled = [];
  const ctx = vm.createContext({
    api: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response; },
    showActProblem: (_row, text) => problems.push(text), t: (key, params) => params?.error || key,
    stewardActErrorMessage: () => '',
    stewardErrorText: value => typeof value === 'object' ? value?.code : value,
    settleRow: (...args) => settled.push(args), appendSteward() {}, pickTarget() {},
  });
  vm.runInContext(functionBlock(conversation, 'handOffRewindTarget') + '\n' + functionBlock(conversation, 'undoHandOff') + '\nthis.undo = undoHandOff;', ctx);
  return { undo: ctx.undo, calls, problems, settled };
}

test('hand-off undo sends one guarded rewind with captured identity and anchor, never a separate stop', async () => {
  const f = undoFixture();
  const identity = execution('A');
  assert.equal(await f.undo({ sessionId: 's', undoRef: { kind: 'turn', rewindTargetTurnSeq: 2, execution: identity }, actsRow: {} }), true);
  assert.deepEqual(f.calls, [{ url: '/api/session/rewind', body: {
    sessionId: 's', targetTurnSeq: 2, rollbackFiles: true, guardExecution: true, expectedExecution: identity,
  } }]);
  const missing = undoFixture();
  assert.equal(await missing.undo({ sessionId: 's', undoRef: { rewindTargetTurnSeq: 2 }, actsRow: {} }), false);
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.settled.length, 0);
});

test('rejected or malformed guarded undo never reports success or sends a fallback request', async () => {
  for (const response of [null, {}, { ok: false, error: 'execution_changed' }, { ok: false, error: 'rewind_settle_timeout' }]) {
    const f = undoFixture(response);
    assert.equal(await f.undo({ sessionId: 's', undoRef: { rewindTargetTurnSeq: 2, execution: execution('A') }, actsRow: {} }), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.settled.length, 0);
  }
});

test('stop act snapshots its identity before confirmation; missing and explicit idle remain distinct', () => {
  const capture = vm.runInNewContext(functionBlock(conversation, 'captureStopAct') + '\ncaptureStopAct');
  const act = { tool: 'steward_thread_stop', args: { sessionId: 's', expectedExecution: execution('A') } };
  const snapshot = capture(act);
  act.args.expectedExecution.driverRunId = 'B';
  assert.equal(snapshot.args.expectedExecution.driverRunId, 'A');
  assert.equal(Object.hasOwn(capture({ tool: act.tool, args: {} }).args, 'expectedExecution'), false);
  assert.equal(capture({ tool: act.tool, args: { expectedExecution: null } }).args.expectedExecution, null);
});

test('identity conflicts use the existing localized refresh instruction', async () => {
  globalThis.window = globalThis;
  const { stewardActErrorMessage, stewardStopReceiptText } = await import('../../ruyi-workbench/app/public/js/steward-conversation.js');
  for (const locale of ['zh-CN', 'en-US']) {
    const table = JSON.parse(fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/locales', locale + '.json'), 'utf8'));
    const t = key => table[key] || key;
    for (const code of ['execution_identity_required', 'execution_changed', 'session_execution_locked', 'rewind_in_progress']) {
      assert.equal(stewardActErrorMessage({ code }, t), table['stewardShell.chat.errConflict']);
      assert.equal(stewardStopReceiptText({ outcome: 'failed', error: { code } }, t), table['stewardShell.chat.errConflict']);
    }
  }
});

test('launch registration captures only its own event and resolves unavailable if it never registers', async () => {
  const source = read('src/13k-steward-threads.js');
  let input;
  const done = deferred();
  const ctx = vm.createContext({
    stewardLaunchingTurns: new Set(), runSessionTurn: value => { input = value; return done.promise; },
    logEvent() {}, stewardRecordLaunchOutcome: async () => {},
  });
  const launch = vm.runInContext(functionBlock(source, 'stewardLaunchTurn') + '\nstewardLaunchTurn', ctx);
  const running = launch({ sessionId: 's' }, 'test');
  const own = execution('A');
  input.onEvent({ type: 'session', session: { id: 's', turnSeq: 7 }, execution: own });
  own.driverRunId = 'B';
  const observed = await running.registration;
  assert.equal(observed.execution.driverRunId, 'A');
  assert.equal(observed.rewindTargetTurnSeq, 8);
  done.resolve({ ok: true });
  await running;
  const early = launch({ sessionId: 's' }, 'test');
  assert.equal(await early.registration, null);
});

async function decisionFixture(response) {
  const source = read('public/js/steward-settings.js');
  const { validExecutionSnapshot } = await import('../../ruyi-workbench/app/public/js/run-health.js');
  const calls = [], notes = []; let reloaded = 0;
  const ctx = vm.createContext({ validExecutionSnapshot,
    call: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response; },
    note: (...args) => notes.push(args), t: key => key, loadDecisions: async () => { reloaded++; },
  });
  vm.runInContext(functionBlock(source, 'undoTarget') + '\n' + functionBlock(source, 'undoDecision')
    + '\nthis.target = undoTarget; this.undo = undoDecision;', ctx);
  return { target: ctx.target, undo: ctx.undo, calls, notes, reloads: () => reloaded };
}

test('decision history offers only detail for old, idle or malformed undo identities', async () => {
  const f = await decisionFixture({ ok: true });
  for (const execution of [undefined, null, {}, { serverInstanceId: 'old' }, { serverInstanceId: 'old', driverRunId: 1 }]) {
    const row = { undoRef: { sessionId: 's', rewindTargetTurnSeq: 3, execution } };
    assert.equal(f.target(row), null);
    assert.equal(await f.undo(row), null);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.reloads(), 0);
});

test('decision history undo sends the persisted execution and original anchor in one guarded request', async () => {
  const f = await decisionFixture({ ok: true });
  const identity = execution('captured-A');
  const row = { undoRef: { kind: 'turn', sessionId: 's', rewindTargetTurnSeq: 3, execution: identity } };
  const target = f.target(row); identity.driverRunId = 'changed-row';
  assert.equal(target.execution.driverRunId, 'captured-A', 'the captured target is a snapshot, not a mutable current identity');
  identity.driverRunId = 'captured-A';
  await f.undo(row);
  assert.deepEqual(f.calls, [{ url: '/api/session/rewind', body: { sessionId: 's', targetTurnSeq: 3,
    rollbackFiles: true, guardExecution: true, expectedExecution: identity } }]);
  assert.equal(f.notes[0][0], 'settings.steward.decisions.undone');
  assert.equal(f.reloads(), 1);
});

test('decision history failed or malformed rewind never announces success or reloads as if undone', async () => {
  for (const response of [null, {}, { ok: false, error: 'execution_changed' }]) {
    const f = await decisionFixture(response);
    await f.undo({ undoRef: { sessionId: 's', rewindTargetTurnSeq: 3, execution: execution('A') } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.notes.some(note => note[0] === 'settings.steward.decisions.undone'), false);
    assert.equal(f.reloads(), 0);
  }
});
