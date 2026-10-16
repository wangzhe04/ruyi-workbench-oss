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
