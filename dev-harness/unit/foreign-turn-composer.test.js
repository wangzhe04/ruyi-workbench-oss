'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/chat-stream-runtime.js'), 'utf8');
  const create = vm.runInNewContext(source.replace(/^export /gm, '') + '\ncreateChatStreamRuntime', {
    document: { querySelector: () => null },
    window: {},
  });
  const nodes = {
    sendBtn: { classList: { toggle() {} } }, promptInput: { value: '' }, steerDeliveryMode: {},
  };
  const state = { currentSession: { id: 'delegated' }, streaming: false, config: {}, sessionRelay: null };
  const calls = [];
  const runtime = create({ state, $: id => nodes[id], t: key => key,
    isProviderMode: () => true,
    iconTextBtn: (button, icon, label) => { button.label = label; },
    api: async (route, options) => { calls.push({ route, body: JSON.parse(options.body) }); return { ok: true }; },
  });
  return { state, nodes, calls, runtime };
}

test('delegated turn uses native stop, steer, delivery selector, then returns to send', () => {
  const { state, nodes, calls, runtime } = fixture();
  state.sessionRelay = { sessionId: 'delegated', channel: 'steer', live: true };
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'common.stop');
  nodes.sendBtn.onclick();
  assert.equal(calls[0].route, '/api/stop');
  assert.equal(calls[0].body.sessionId, 'delegated');
  nodes.promptInput.value = '请继续检查';
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'chat.steer');
  assert.equal(nodes.steerDeliveryMode.hidden, false);
  state.sessionRelay = null;
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'chat.send');
});

test('a live permission wait can be stopped, and foreign session state never leaks', () => {
  const { state, nodes, runtime } = fixture();
  state.sessionRelay = { sessionId: 'delegated', channel: 'permission', live: true };
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'common.stop');
  state.currentSession = { id: 'other' };
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'chat.send');
});

test('locally started turns keep native stop and steer behavior', () => {
  const { state, nodes, runtime } = fixture();
  state.streaming = true;
  runtime.activeTurns.set('delegated', { engine: 'openai' });
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'common.stop');
  nodes.promptInput.value = '补充';
  runtime.updateSendBtn();
  assert.equal(nodes.sendBtn.label, 'chat.steer');
});

test('server snapshots immediately refresh the composer on start and completion', () => {
  const { state, nodes, runtime } = fixture();
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/session-experience.js'), 'utf8');
  const body = source.slice(source.indexOf('function captureLiveTurn('), source.indexOf('\n// 该不该画'));
  const capture = vm.runInNewContext('let liveTurnSessionId, liveTurnTail, liveTurnNarrative, liveTurnLive;\n' + body + '\ncaptureLiveTurn', {
    state, updateSendBtn: () => runtime.updateSendBtn(),
  });
  capture('delegated', { resumable: { live: true }, relay: { channel: 'steer' } });
  assert.equal(nodes.sendBtn.label, 'common.stop');
  capture('delegated', { resumable: { live: false } });
  assert.equal(nodes.sendBtn.label, 'chat.send');
  assert.equal(state.sessionRelay, null);
});
