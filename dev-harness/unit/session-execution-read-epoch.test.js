'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { functionBlock } = require('../lib/source-slice');
const { imageBindings } = require('../lib/composer-race-fixture');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/public/js/session-experience.js'), 'utf8');
function fixture(imageApi) {
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const state = { currentSession: { id: 's', messages: ['current'] }, sessionExecution: undefined };
  const images = imageBindings(state, imageApi);
  const c = vm.createContext({ state, sessionOpenSeq: 0, sessionChoices: 0, sessionExecutionReadSeq: 0,
    invalidateImageOperations: images.invalidateImageOperations,
    sessionOpenPending: null, sessionOpenRefreshPending: false,
    sessionExecutionNeedsRefresh: false, activeTurns: new Map(), api: async () => result,
    syncLivePolling() {}, renderCurrentSession() { throw Error('stale read rendered'); },
  });
  return { c, state, release, images };
}
test('opening another session invalidates the real in-flight image preparation', async () => {
  let resolveImage, signal, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const imageResponse = new Promise(resolve => { resolveImage = resolve; });
  const { c, state, release, images } = fixture((_url, options) => {
    signal = options.signal; notifyStarted(); return imageResponse;
  });
  state.config = { privacyModeV1: 'basic' };
  const record = { id: 'image1', name: 'picture.png' };
  const preparation = images.prepareProtectedImages([record], 's');
  await started;
  vm.runInContext(functionBlock(source, 'openSession'), c);
  const opening = c.openSession('next');
  assert.equal(signal.aborted, true);
  resolveImage({});
  await assert.rejects(preparation, /reviewRequired/);
  c.sessionExecutionReadSeq += 1;
  release({ ok: true, session: { id: 'next', messages: [] }, execution: null });
  await opening;
  assert.equal(record.protectedImage, undefined);
});
test('an open read started before epoch change cannot refill identity, body or render', async () => {
  const { c, state, release } = fixture();
  vm.runInContext(functionBlock(source, 'openSession'), c);
  const pending = c.openSession('s');
  c.sessionExecutionReadSeq += 1;
  release({ ok: true, session: { id: 's', messages: ['stale'] }, execution: { serverInstanceId: 'old', driverRunId: 'old' } });
  await pending;
  assert.deepEqual(state.currentSession.messages, ['current']);
  assert.equal(state.sessionExecution, undefined);
});

for (const refresh of ['refreshLiveTurn', 'reloadCurrentSessionAfterAway']) test(refresh + ' defers old-session pushes until the user selection settles', async () => {
  const { c, state, release } = fixture();
  const reads = []; let renders = 0;
  const noop = () => {};
  Object.assign(c, {
    api: async url => { reads.push(url); return url.startsWith('/api/status') ? {} : c.response; },
    steerPendingList: [], steeredSeen: [], currentChangedWhileAway: false, localStorage: { setItem() {} }, $: () => null,
    resetStickyScroll: noop, updateEngineDependentUI: noop, renderSessions: noop, renderCurrentSession: () => renders++,
    renderResumeBanner: noop, syncStreamingUi: noop, mountActiveTurn: noop, syncOwnTurnLiveIndicator: noop,
    syncEventStreamPresence: noop, scrollMessagesToBottom: noop, latestUsage: noop, renderContextMeter: noop,
    liveTurnVisible: () => false, captureLiveTurn: noop,
  });
  c.response = new Promise(resolve => { c.resolveSelection = resolve; });
  vm.runInContext([functionBlock(source, 'openSession'), functionBlock(source, 'refreshLiveTurn'), functionBlock(source, 'reloadCurrentSessionAfterAway')].join('\n'), c);
  const opening = c.openSession('b');
  const pushes = [c[refresh](), c[refresh]()];
  const readsDuringSelection = [...reads], readSeqDuringSelection = c.sessionExecutionReadSeq;
  c.resolveSelection({ ok: true, session: { id: 'b', messages: ['selected'] }, execution: null });
  await opening; await Promise.all(pushes); await Promise.resolve();
  assert.deepEqual(readsDuringSelection, ['/api/sessions/b'], 'no current-session read can supersede the selected session');
  assert.equal(readSeqDuringSelection, 1);
  assert.equal(state.currentSession.id, 'b'); assert.equal(renders, 1);
  assert.equal(c.sessionOpenPending, null); assert.equal(c.sessionOpenRefreshPending, false);
  assert.equal(reads.filter(url => url.includes('?view=live')).length, 1, 'skipped pushes coalesce into one fresh selected-session read');
  assert.ok(reads.at(-1).startsWith('/api/sessions/b?'));
  release({});
});

test('failed selection releases its pending guard and drains a skipped refresh', async () => {
  const { c } = fixture(); let reject; let refreshes = 0;
  c.api = () => new Promise((_resolve, fail) => { reject = fail; });
  c.refreshLiveTurn = () => { refreshes++; };
  vm.runInContext(functionBlock(source, 'openSession'), c);
  const opening = c.openSession('b');
  c.sessionOpenRefreshPending = true;
  reject(Error('offline'));
  await assert.rejects(opening, /offline/);
  assert.equal(c.sessionOpenPending, null); assert.equal(c.sessionOpenRefreshPending, false);
  assert.equal(refreshes, 1);
});
for (const name of ['reloadCurrentSessionAfterAway', 'refreshLiveTurn']) test(name + ' rejects a late epoch or superseded same-session read before all presentation updates', async () => {
  const { c, state, release } = fixture();
  vm.runInContext(functionBlock(source, name), c);
  const pending = c[name]();
  c.sessionExecutionReadSeq += 1;
  release({ ok: true, session: { id: 's', messages: ['stale'] }, execution: null });
  await pending;
  assert.deepEqual(state.currentSession.messages, ['current']);
  assert.equal(state.sessionExecution, undefined);
});
test('epoch invalidation uses the next presence ack to refresh once without a timer', async () => {
  const listeners = new Map(); let refreshes = 0;
  const c = vm.createContext({ eventStream: { on(name, fn) { listeners.set(name, fn); }, isConnected: () => true },
    EVENT_STREAM_INSTANCE_EVENT: 'server.instance', EVENT_STREAM_LIVE_EVENT: 'thread.live', EVENT_STREAM_ROW_EVENTS: [],
    sessionExecutionReadSeq: 2, sessionExecutionNeedsRefresh: false, state: { sessionExecution: { old: true } },
    liveStreamConnected: false, refreshLiveTurn() { refreshes++; },
  });
  vm.runInContext(functionBlock(source, 'bindLiveEventStream'), c);
  c.bindLiveEventStream();
  listeners.get('server.instance')({ serverInstanceId: 'new' });
  assert.equal(c.sessionExecutionReadSeq, 3); assert.equal(c.state.sessionExecution, undefined);
  listeners.get('presence.ack')({}); listeners.get('presence.ack')({});
  assert.equal(refreshes, 1);
});

const runtimeSource = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/public/js/chat-stream-runtime.js'), 'utf8');
for (const outcome of ['success', 'failure']) for (const owned of [false, true]) test(`late ${outcome} stop receipt cannot change B after ${owned ? 'owned' : 'background'} A`, async () => {
  let resolve, reject;
  const pending = new Promise((r, j) => { resolve = r; reject = j; });
  const a = { serverInstanceId: 'epoch-A', driverRunId: 'A', phase: 'running' };
  const b = { serverInstanceId: 'epoch-A', driverRunId: 'B', phase: 'running' };
  const state = { currentSession: { id: 's' }, sessionExecution: { sessionId: 's', execution: a } };
  const activeTurns = new Map(); let writes = 0;
  if (owned) activeTurns.set('s', { execution: a, abort: { abort() { writes++; } } });
  const c = vm.createContext({ state, activeTurns, api: () => pending, setProc() { writes++; }, toast() { writes++; }, t: key => key });
  vm.runInContext(functionBlock(runtimeSource, 'stopTurn'), c);
  const stopping = c.stopTurn();
  state.sessionExecution.execution = b;
  if (owned) activeTurns.set('s', { execution: b });
  if (outcome === 'success') resolve({ ok: true, stopped: true });
  else reject(Object.assign(new Error('rejected'), { status: 409 }));
  await stopping;
  assert.equal(writes, 0);
});
test('same driver phase changes preserve receipt ownership; epoch invalidation removes it', async () => {
  for (const invalidate of [false, true]) {
    let resolve; const pending = new Promise(r => { resolve = r; }); let writes = 0;
    const state = { currentSession: { id: 's' }, sessionExecution: { sessionId: 's', execution: { serverInstanceId: 'epoch', driverRunId: 'A', phase: 'queued' } } };
    const c = vm.createContext({ state, activeTurns: new Map(), api: () => pending, setProc() { writes++; }, toast() { writes++; }, t: key => key });
    vm.runInContext(functionBlock(runtimeSource, 'stopTurn'), c);
    const stopping = c.stopTurn();
    if (invalidate) state.sessionExecution = undefined;
    else state.sessionExecution.execution.phase = 'running';
    resolve({ ok: true, stopped: true }); await stopping;
    assert.equal(writes, invalidate ? 0 : 1);
  }
});
