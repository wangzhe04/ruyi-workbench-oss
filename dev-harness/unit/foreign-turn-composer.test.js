'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { imageBindings } = require('../lib/composer-race-fixture');

function fixture() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/chat-stream-runtime.js'), 'utf8');
  const state = { currentSession: { id: 'delegated' }, streaming: false, config: {}, sessionRelay: null, sessionExecution: { sessionId: 'delegated', execution: { serverInstanceId: 'fixture', driverRunId: 'delegated-run' } } };
  const importLine = "import { prepareProtectedImages } from './attachment-tray.js';";
  assert.deepEqual(source.match(/^import .*;$/gm), [importLine]);
  const create = vm.runInNewContext(source.replace(importLine, '').replace(/^export /gm, '') + '\ncreateChatStreamRuntime', {
    document: { querySelector: () => null },
    window: {},
    prepareProtectedImages: imageBindings(state).prepareProtectedImages,
  });
  const nodes = {
    sendBtn: { classList: { toggle() {} } }, promptInput: { value: '' }, steerDeliveryMode: {},
  };
  const calls = [];
  const runtime = create({ state, $: id => nodes[id], t: key => key,
    isProviderMode: () => true,
    iconTextBtn: (button, icon, label) => { button.label = label; },
    api: async (route, options) => { calls.push({ route, body: JSON.parse(options.body) }); return { ok: true, stopped: true }; },
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
  assert.equal(calls[0].body.expectedExecution.driverRunId, 'delegated-run');
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
    state, sessionExecutionReadSeq: 1, validExecutionSnapshot: value => value === null || Boolean(value?.serverInstanceId && value?.driverRunId), updateSendBtn: () => runtime.updateSendBtn(),
  });
  capture('delegated', { session: { id: 'delegated' }, execution: { serverInstanceId: 'fixture', driverRunId: 'remote' }, resumable: { live: true }, relay: { channel: 'steer' } }, 1);
  assert.equal(nodes.sendBtn.label, 'common.stop');
  capture('delegated', { session: { id: 'delegated' }, execution: null, resumable: { live: false } }, 1);
  assert.equal(nodes.sendBtn.label, 'chat.send');
  assert.equal(state.sessionRelay, null);
  assert.equal(state.sessionExecution.execution, null);
});
