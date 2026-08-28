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
