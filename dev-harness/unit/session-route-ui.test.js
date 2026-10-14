'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-route-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const publicDir = path.join(app, 'public');
const srv = require(path.join(app, 'server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a session route overrides the global new-session default without mutating it', () => {
  const config = {
    activeProvider: 'new-default', model: 'claude-global', agentCliType: 'claude',
    providers: [
      { id: 'bound', model: 'bound-default' },
      { id: 'new-default', model: 'latest-global' },
    ],
  };
  const session = { engineRoute: { engine: 'openai', providerId: 'bound', model: 'bound-model' }, messages: [] };
  const effective = srv.configForSessionEngineRoute(config, session);
  assert.equal(effective.activeProvider, 'bound');
  assert.equal(effective.providers.find(item => item.id === 'bound').model, 'bound-model');
  assert.equal(config.activeProvider, 'new-default');
  assert.equal(config.providers[0].model, 'bound-default');
});

test('legacy sessions infer their route from the latest assistant source', () => {
  const providerSession = srv.normalizeSession({ messages: [
    { role: 'assistant', engine: 'claude', agentCliType: 'claude', model: 'old-agent' },
    { role: 'assistant', engine: 'openai', providerId: 'p2', model: 'm2' },
  ], providerHistory: [], attachments: [] }).session;
  assert.deepEqual(providerSession.engineRoute, { engine: 'openai', providerId: 'p2', model: 'm2' });

  const agentSession = srv.normalizeSession({ messages: [
    { role: 'assistant', engine: 'claude', agentCliType: 'kimi', model: 'kimi-k2' },
  ], providerHistory: [], attachments: [] }).session;
  assert.deepEqual(agentSession.engineRoute, { engine: 'agent', agentCliType: 'kimi', model: 'kimi-k2' });
});

test('a live turn stale save cannot overwrite a newer session route choice', async () => {
  const id = 'route_race';
  await srv.saveSession({
    id, schemaVersion: 1, turnSeq: 0, title: 'route race', cwd: root,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [], providerHistory: [], attachments: [],
    engineRoute: { engine: 'agent', agentCliType: 'claude', model: 'old' },
  });
  const staleTurnCopy = await srv.loadSession(id);
  await srv.updateSessionMeta(id, { engineRoute: { engine: 'openai', providerId: 'p-new', model: 'm-new' } });
  staleTurnCopy.messages.push({ role: 'assistant', engine: 'claude', model: 'old', content: 'old turn completes' });
  await srv.saveSession(staleTurnCopy);
  const fresh = await srv.loadSession(id);
  assert.deepEqual(fresh.engineRoute, { engine: 'openai', providerId: 'p-new', model: 'm-new' });
});

test('active-turn user reconciliation only suppresses the optimistic row for this turn', () => {
  const source = fs.readFileSync(path.join(publicDir, 'js', 'turn-narrative.js'), 'utf8');
  const match = source.match(/export function activeTurnUserIsPersisted\([^\n]*\) \{[\s\S]*?^\}/m);
  assert.ok(match);
  const fn = vm.runInNewContext(`${match[0].replace('export ', '')}\nactiveTurnUserIsPersisted`);
  const turn = { message: 'same prompt', initialTurnSeq: 4, startedAt: Date.now() };
  assert.equal(fn([{ role: 'user', content: 'same prompt', turnSeq: 4 }], turn), false, 'an older equal prompt is not this turn');
  assert.equal(fn([{ role: 'user', content: 'same prompt', turnSeq: 5 }], turn), true, 'the persisted current turn replaces optimism');
  assert.equal(fn([{ role: 'user', content: 'different', turnSeq: 5 }], turn), false);
});

test('live remount, session route UI, and pre-turn context controls stay wired', () => {
  const stream = fs.readFileSync(path.join(publicDir, 'js', 'chat-stream-runtime.js'), 'utf8');
  const provider = fs.readFileSync(path.join(publicDir, 'js', 'provider-settings.js'), 'utf8');
  const navigation = fs.readFileSync(path.join(publicDir, 'js', 'navigation-controls.js'), 'utf8');
  const primitives = fs.readFileSync(path.join(publicDir, 'js', 'chat-render-primitives.js'), 'utf8');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(stream, /persistedUser = activeTurnUserIsPersisted/);
  assert.match(stream, /initialTurnSeq:/);
  assert.match(provider, /state\.currentSession\?\.engineRoute/);
  assert.match(navigation, /patchSession\(state\.currentSession\.id, \{ engineRoute \}\)/);
  assert.match(html, /id="contextMeter" class="ctx-meter"/);
  assert.match(primitives, /ctx\.noUsage/);
  for (const value of [200000, 262144, 524288, 1000000]) assert.ok(navigation.includes(String(value)), `preset ${value}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(publicDir, 'locales', 'zh-CN.json'), 'utf8')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(publicDir, 'locales', 'en-US.json'), 'utf8')));
});

test('thread state updates the streaming title without replacing conversation messages', () => {
  const source = fs.readFileSync(path.join(publicDir, 'js', 'session-experience.js'), 'utf8');
  const start = source.indexOf('function bindLiveEventStream()');
  const code = source.slice(start, source.indexOf('// 切回工作台', start));
  let titleWrites = 0, titleText = '';
  const node = { get textContent() { return titleText; }, set textContent(value) { titleText = value; titleWrites++; } };
  const listeners = new Map(), messages = [{ role: 'assistant', content: 'live text' }];
  const state = { streaming: true, currentSession: { id: 'sess_live', title: 'Untitled', messages } };
  const ctx = { state, $: () => node, eventStream: { on: (name, fn) => listeners.set(name, fn), isConnected: () => true }, EVENT_STREAM_LIVE_EVENT: 'thread.live', EVENT_STREAM_ROW_EVENTS: ['thread.state'], syncLivePolling() {}, pushLiveTurn() {}, liveStreamConnected: false };
  vm.runInNewContext(code + '\nbindLiveEventStream();', ctx);
  listeners.get('thread.state')({ sessionId: 'sess_live', title: 'Generated title' });
  assert.equal(node.textContent, 'Generated title');
  assert.equal(state.currentSession.title, 'Generated title');
  assert.equal(state.currentSession.messages, messages);
  listeners.get('thread.state')({ sessionId: 'sess_live', title: 'Generated title' });
  assert.equal(titleWrites, 1, 'unchanged title must not trigger the thread-head MutationObserver');
  listeners.get('thread.state')({ sessionId: 'sess_other', title: 'Other title' });
  assert.equal(node.textContent, 'Generated title');
});

function watchHeadFixture(api, refreshRows) {
  const source = fs.readFileSync(path.join(publicDir, 'js', 'thread-head.js'), 'utf8');
  const nodes = { threadStewardBand: { dataset: {}, querySelector: () => null }, threadStewardText: {}, threadStewardWatch: { dataset: {}, checked: true } };
  const state = { currentSession: { id: 'sess_a' } }, rows = { sess_a: { watched: true }, sess_b: { watched: false } };
  const ctx = { createQuickSwitchChips: () => ({ setSession() {} }), doc: () => ({}), byId: id => nodes[id] || null, rerenderAllQuickSwitchChips() {}, stewardBandKey: () => '', toast() {}, apiErrText: value => value };
  const factory = vm.runInNewContext(source.slice(source.indexOf('export function createThreadHead')).replace('export ', '') + '\ncreateThreadHead', ctx);
  const head = factory({ api, refreshRows, state, missionRowOf: id => rows[id] });
  head.render();
  return { head, state, rows, toggle: nodes.threadStewardWatch };
}

test('watch PATCH failure restores the authoritative checkbox after pending renders', async () => {
  let release;
  const request = new Promise(resolve => { release = resolve; });
  const f = watchHeadFixture(() => request, async () => {});
  f.toggle.checked = false; f.toggle.onchange(); f.head.render();
  assert.equal(f.toggle.checked, false);
  release({ ok: false, error: 'fixture failure' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.toggle.checked, true);
});

test('watch row refresh does not apply an earlier thread interaction after switching threads', async () => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const refresh = new Promise(resolve => { release = resolve; });
  const f = watchHeadFixture(async () => ({ ok: true, session: { id: 'sess_a' } }), () => { reached(); return refresh; });
  f.toggle.checked = false; f.toggle.onchange(); await waiting;
  f.rows.sess_b.watched = true;
  f.state.currentSession = { id: 'sess_b' }; f.head.render();
  assert.equal(f.toggle.checked, true);
  // A's refresh cannot set B's switch or replace its current session.
  f.rows.sess_a.watched = false; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.currentSession.id, 'sess_b');
  assert.equal(f.toggle.checked, true);
  f.rows.sess_b.watched = false; f.head.render();
  assert.equal(f.toggle.checked, false);
});
