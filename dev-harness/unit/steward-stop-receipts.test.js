'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
const conversation = import('../../ruyi-workbench/app/public/js/steward-conversation.js');
const drawer = import('../../ruyi-workbench/app/public/js/steward-drawer.js');

test('stop acknowledgements require an actual stop flag; exact not_running is a no-op', async () => {
  const { stewardStopReceiptOf: read } = await conversation;
  for (const response of [null, {}, { ok: true }, { ok: 1, stopped: true }, { ok: true, stopped: 'true' }, { ok: true, stopped: false, queuedStopped: 1 }]) {
    assert.equal(read(response).outcome, 'unknown', JSON.stringify(response));
  }
  assert.equal(read({ ok: true, stopped: true }).outcome, 'accepted');
  assert.equal(read({ ok: true, queuedStopped: true }).outcome, 'accepted');
  assert.equal(read({ ok: true, stopped: false }).outcome, 'noop');
  assert.equal(read({ ok: false, error: 'not_running' }).outcome, 'noop');
  assert.equal(read({ ok: false, error: { code: 'not_running' } }).outcome, 'noop');
  assert.equal(read({ ok: false, error: 'denied', message: 'not_running' }).outcome, 'failed');
});

test('same-target concurrent stops share one write; other targets do not wait; lost responses never retry', async () => {
  const { stewardThreadStop: stop } = await drawer;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const api = async (_url, request) => {
    const id = JSON.parse(request.body).sessionId;
    calls.push(id);
    if (id === 'waiting') { await gate; throw new TypeError('Failed to fetch'); }
    return { ok: true, stopped: true };
  };
  const a = stop({ api, sessionId: 'waiting' });
  const b = stop({ api, sessionId: 'waiting' });
  const other = await stop({ api, sessionId: 'other' });
  assert.equal(other.outcome, 'accepted');
  assert.deepEqual(calls, ['waiting', 'other']);
  release();
  assert.equal((await a).outcome, 'unknown');
  assert.equal((await b).outcome, 'unknown');
  assert.deepEqual(calls, ['waiting', 'other']);
});

test('explicit 4xx rejection keeps its reason; 5xx and malformed successful responses stay unknown', async () => {
  const { stewardThreadStop: stop } = await drawer;
  const rejected = Object.assign(new Error(JSON.stringify({ ok: false, error: { code: 'stop.denied', message: 'explicit refusal' } })), { status: 409 });
  const result = await stop({ api: async () => { throw rejected; }, sessionId: 'rejected' });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'stop.denied');
  assert.equal(result.error.message, 'explicit refusal');
  assert.equal((await stop({ api: async () => { throw Object.assign(new Error('server failed'), { status: 500 }); }, sessionId: 'server-error' })).outcome, 'unknown');
  assert.equal((await stop({ api: async () => ({ ok: true }), sessionId: 'empty-receipt' })).outcome, 'unknown');
});

test('same session A and B have independent in-flight writes; late A does not repaint B or a new epoch', async () => {
  const { stewardThreadStop: stop, stewardStopControl: control } = await drawer;
  const a = { serverInstanceId: 'p-one', driverRunId: 'A' };
  const b = { serverInstanceId: 'p-one', driverRunId: 'B' };
  const restarted = { serverInstanceId: 'p-two', driverRunId: 'B' };
  const buttons = [];
  const document = { querySelectorAll: () => buttons, createElement: () => ({ dataset: {}, setAttribute(name) { this[name] = ''; }, hasAttribute(name) { return name in this; } }) };
  globalThis.document = document;
  const button = () => { const item = { dataset: {}, ownerDocument: document, after(feedback) { this.feedback = feedback; } }; buttons.push(item); return item; };
  const active = button();
  const t = key => key;
  control(active, 'same-id', t, null, a);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const api = async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body.expectedExecution);
    if (body.expectedExecution.driverRunId === 'A') { await gate; throw new TypeError('lost'); }
    return { ok: true, stopped: true };
  };
  const pa = stop({ api, sessionId: 'same-id', expectedExecution: a });
  await Promise.resolve();
  assert.equal(active.disabled, true);
  control(active, 'same-id', t, null, b);
  assert.equal(active.disabled, false, 'A pending cannot disable new B');
  await stop({ api, sessionId: 'same-id', expectedExecution: b });
  assert.equal(active.feedback.dataset.stopOutcome, 'accepted');
  control(active, 'same-id', t, null, restarted);
  assert.equal(active.feedback.hidden, true, 'new epoch does not inherit B receipt');
  release(); await pa;
  assert.equal(active.feedback.hidden, true, 'late A cannot overwrite current epoch');
  assert.deepEqual(calls, [a, b]);
  delete globalThis.document;
});

test('after epoch switch, late old stop results cannot repopulate history or paint new idle controls', () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  const { functionBlock } = require('../lib/source-slice');
  const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/public/js/steward-drawer.js'), 'utf8');
  let paints = 0;
  const c = vm.createContext({ stewardStopServerInstanceId: 'new-process', stewardStopReceipts: new Map(),
    stewardStopRequests: new Map(), stewardStopRequestSequence: 0, stewardPaintStopControls() { paints++; } });
  vm.runInContext(functionBlock(source, 'stewardPublishStopReceipt'), c);
  const result = c.stewardPublishStopReceipt(JSON.stringify(['same-id', 'old-process', 'A', 'known']), { ok: false, outcome: 'unknown' });
  assert.equal(result.latestRequest, false);
  assert.equal(c.stewardStopReceipts.size, 0);
  assert.equal(c.stewardStopRequestSequence, 0);
  assert.equal(paints, 0);
});

test('late event-stream binding adopts the observed stop epoch and presence acknowledgement repaints controls', () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  const { functionBlock } = require('../lib/source-slice');
  const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/public/js/steward-drawer.js'), 'utf8');
  const listeners = new Map(); let paints = 0;
  const c = vm.createContext({ drawerServerInstanceId: '', stewardStopServerInstanceId: '',
    EVENT_STREAM_INSTANCE_EVENT: 'server.instance', EVENT_STREAM_LIVE_EVENT: 'thread.live', EVENT_STREAM_ROW_EVENTS: [],
    stewardPaintStopControls() { paints++; } });
  vm.runInContext(functionBlock(source, 'setEventStream'), c);
  assert.equal(c.setEventStream({ stats: () => ({ serverInstanceId: 'already-connected' }),
    isConnected: () => true, on: (name, fn) => listeners.set(name, fn) }), true);
  assert.equal(c.drawerServerInstanceId, 'already-connected');
  assert.equal(c.stewardStopServerInstanceId, 'already-connected');
  assert.equal(paints, 1, 'binding an already connected stream immediately repaints existing idle controls');
  listeners.get('presence.ack')({ serverInstanceId: 'already-connected' });
  assert.equal(paints, 2, 'idle controls are repainted even if their previous render preceded the acknowledgement');
});
