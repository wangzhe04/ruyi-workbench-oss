'use strict';
// 151 阶段 1 · U3：维护期输入框闸门 —— 状态判读、禁用/放开 #promptInput、说明文案、失败触发复查、交接断连不误放开。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const load = () => import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/js/work-data-maintenance-gate.js')).toString('base64'));
const catalogs = Object.fromEntries(['zh-CN', 'en-US'].map(l => [l, JSON.parse(fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/locales', l + '.json'), 'utf8'))]));
const tFor = lang => (key, params = {}) => { assert.ok(Object.hasOwn(catalogs[lang], key), 'missing ' + key); return catalogs[lang][key].replace(/{{\s*(\w+)\s*}}/g, (m, k) => (params[k] == null ? m : String(params[k]))); };
const job = (state, operation = 'enable') => ({ id: 'a'.repeat(48), operation, state, cancellable: false, takeover: true, retry: false });

function dom() {
  const nodes = new Map();
  const make = tag => ({ tagName: tag, id: '', className: '', hidden: false, disabled: false, dataset: {}, attributes: {}, textContent: '', children: [],
    setAttribute(k, v) { this.attributes[k] = String(v); }, insertBefore(node) { this.children.unshift(node); if (node.id) nodes.set(node.id, node); return node; } });
  const composer = make('section'); composer.className = 'composer';
  const input = make('textarea'); input.id = 'promptInput'; input.closest = sel => (sel === '.composer' ? composer : null); nodes.set('promptInput', input);
  return { composer, input, doc: { getElementById: id => nodes.get(id) || null, createElement: make } };
}
function win() {
  const listeners = new Map();
  return { addEventListener: (name, fn) => listeners.set(name, fn), emit: (name, detail) => listeners.get(name)?.({ detail }) };
}

test('status phases map to a gate reason; open (or unknown) phases never block the composer', async () => {
  const { maintenanceGateState } = await load();
  assert.equal(maintenanceGateState(null), null);
  assert.equal(maintenanceGateState({ maintenance: { phase: 'open' }, job: job('queued') }), null);
  assert.equal(maintenanceGateState({ maintenance: { phase: 'future' } }), null);
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'waiting' }, job: job('draining', 'export') }), { reason: 'draining', operation: 'export' });
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'idle' }, job: job('handoff') }), { reason: 'handoff', operation: 'enable' });
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'retired', accepting: false }, job: job('handoff') }), { reason: 'handoff', operation: 'enable' });
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'retired' }, job: job('uncertain') }), { reason: 'uncertain', operation: 'enable' });
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'retired' }, job: job('failed', 'restore') }), { reason: 'failed', operation: 'restore' });
  assert.deepEqual(maintenanceGateState({ maintenance: { phase: 'retired' }, job: { operation: 'rm -rf', state: 'failed' } }), { reason: 'failed', operation: '' });
});

test('gate disables the input with a reason, keeps it across a dropped connection, and re-enables when the successor is open', async () => {
  const { createMaintenanceGate } = await load();
  const { input, composer, doc } = dom(); const w = win();
  const replies = [{ ok: true, maintenance: { phase: 'retired' }, job: job('handoff') }, 'network', { ok: true, maintenance: { phase: 'open' }, job: null }];
  const calls = [];
  const api = async route => { calls.push(route); const next = replies.shift(); if (next === 'network') throw new TypeError('Failed to fetch'); return next; };
  const gate = createMaintenanceGate({ api, apiErrorInfo: e => ({ code: e.code || '', message: e.message || '' }), t: tFor('zh-CN'), doc, win: w, pollMs: 1e9 });
  assert.equal(gate.noteFailure({ code: 'session.not_found' }), false, 'unrelated failures do not poll'); assert.equal(calls.length, 0);
  assert.equal(gate.noteFailure({ code: 'work_data_setup.takeover_committed' }), true);
  await gate.check();
  assert.equal(input.disabled, true); assert.equal(input.dataset.maintenance, 'handoff');
  const notice = composer.children[0];
  assert.equal(notice.id, 'maintenanceComposerNotice'); assert.equal(notice.hidden, false); assert.equal(notice.attributes.role, 'status');
  assert.match(notice.textContent, /正在交接给新进程（启用加密）/); assert.match(notice.textContent, /重启如意/);
  await gate.check(); assert.equal(input.disabled, true, 'a dropped connection during handoff keeps the gate closed');
  await gate.check(); assert.equal(input.disabled, false); assert.equal(input.dataset.maintenance, undefined); assert.equal(notice.hidden, true);
  assert.deepEqual(calls, ['/api/work-data/status', '/api/work-data/status', '/api/work-data/status']);
});

test('panel status events drive the gate without extra polling; internal_error carrying a maintenance code also triggers a check', async () => {
  const { createMaintenanceGate, isMaintenanceFailureCode } = await load();
  const { input, composer, doc } = dom(); const w = win(); let calls = 0;
  const gate = createMaintenanceGate({ api: async () => { calls++; return { maintenance: { phase: 'open' } }; }, apiErrorInfo: e => e, t: tFor('en-US'), doc, win: w, pollMs: 1e9 });
  w.emit('workdata:status', { maintenance: { phase: 'retired' }, job: job('failed', 'disable') });
  assert.equal(input.disabled, true); assert.equal(calls, 0);
  assert.match(composer.children[0].textContent, /did not finish \(Switch to plain-text storage\)|did not finish/);
  assert.ok(!/[㐀-鿿]/.test(composer.children[0].textContent));
  w.emit('workdata:status', { maintenance: { phase: 'open' }, job: null });
  assert.equal(input.disabled, false);
  assert.equal(gate.noteFailure({ code: 'api.internal_error', message: 'work_data.maintenance_busy' }), true);
  for (const code of ['work_data.maintenance_busy', 'work_data_setup.busy', 'work_data_setup.takeover_committed', 'work_data_store.switch_unavailable']) assert.ok(isMaintenanceFailureCode(code), code);
  for (const code of ['work_data_setup.path_invalid', 'privacy.busy', '', null]) assert.ok(!isMaintenanceFailureCode(code), String(code));
});

test('gate never re-enables an input it did not disable', async () => {
  const { createMaintenanceGate } = await load();
  const { input, doc } = dom(); const w = win(); input.disabled = true;
  createMaintenanceGate({ api: async () => ({}), apiErrorInfo: e => e, t: tFor('zh-CN'), doc, win: w, pollMs: 1e9 });
  w.emit('workdata:status', { maintenance: { phase: 'open' } });
  assert.equal(input.disabled, true);
});
