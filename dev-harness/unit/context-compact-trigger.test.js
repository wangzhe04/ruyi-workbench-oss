'use strict';
// Real source, isolated storage, no model requests: conversation trigger != summarizer input budget.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-compact-trigger-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { readServerSource } = require('../src-reader');
const source = readServerSource();
after(() => fs.rmSync(root, { recursive: true, force: true }));

function extract(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `extract ${name}`);
  return match[0];
}
const key = srv.contextWindowOverrideKey;
function configFor(limit = 1000000, model = 'ark-code-latest') {
  return {
    agentCliType: 'claude', model, autoCompactThreshold: 0.8,
    compactProviderId: 'local', compactModel: 'gemma4:12b-128k',
    providers: [{ id: 'local', model: 'gemma4:12b-128k', contextWindow: 131072 }],
    contextWindowOverrides: { [key('agent', 'claude', model)]: limit },
  };
}
function sessionAt(tokens, usage = {}) {
  return { id: 'test', claudeSessionId: 'native-old', claudeSessionModel: 'ark-code-latest', messages: [
    { role: 'assistant', engine: 'claude', model: 'ark-code-latest', usage: { contextTokens: tokens, ...usage } },
  ] };
}
function agentTrigger(extra = {}) {
  const calls = [], events = [];
  const context = {
    agentConversationContextMeta: srv.agentConversationContextMeta,
    resolveContextWindow: srv.resolveContextWindow,
    runAgentExternalCompact: async (...args) => { calls.push(args); return { ok: true, beforeTokens: 800000, afterTokens: 3000 }; },
    loadSession: async () => ({ id: 'test', claudeSessionId: '', messages: [] }),
    kimiSessionStatus: async () => ({ ok: false }),
    applyKimiStatusToSession: () => {},
    ...extra,
  };
  const run = vm.runInNewContext(`${extract('lastSessionContextTokens')}\n${extract('replaceSessionObject')}\n${extract('maybeAutoCompactAgentSession')}\nmaybeAutoCompactAgentSession`, context);
  return { calls, events, run: (session, config, type = 'claude') => run(session, config, type, e => events.push(e)) };
}

test('241K/1M with a 128K local summarizer does not compact or mutate the session', async () => {
  const trigger = agentTrigger(), session = sessionAt(241000), before = structuredClone(session);
  assert.equal(await trigger.run(session, configFor()), false);
  assert.equal(trigger.calls.length, 0);
  assert.deepEqual(trigger.events, []);
  assert.deepEqual(session, before);
});

test('threshold boundary: 799999 skips; 800000 triggers with main 1M and keeps local summary selection', async () => {
  const trigger = agentTrigger(), config = configFor();
  assert.equal(await trigger.run(sessionAt(799999), config), false);
  const session = sessionAt(800000);
  assert.equal(await trigger.run(session, config), true);
  assert.equal(trigger.calls.length, 1);
  assert.equal(trigger.events[0].contextWindow, 1000000);
  assert.equal(trigger.calls[0][1].compactModel, 'gemma4:12b-128k');
  assert.equal(trigger.calls[0][2], 'auto');
  assert.equal(session.claudeSessionId, '');
});

test('a larger summarizer cannot postpone compaction for a small conversation model', async () => {
  const trigger = agentTrigger(), config = configFor(128000);
  config.providers[0].contextWindow = 1000000;
  assert.equal(await trigger.run(sessionAt(110000), config), true);
  assert.equal(trigger.events[0].contextWindow, 128000);
});

test('custom thresholds use the conversation limit; default Claude native path is unchanged', async () => {
  const trigger = agentTrigger(), config = configFor();
  config.autoCompactThreshold = 0.9;
  assert.equal(await trigger.run(sessionAt(850000), config), false);
  assert.equal(await trigger.run(sessionAt(900000), { ...config, compactProviderId: '' }), false);
  assert.equal(trigger.calls.length, 0);
});

test('native measured context is used for unknown models without a manual limit', async () => {
  const config = configFor(0), session = sessionAt(241000, {
    contextEngine: 'agent', contextAgentCliType: 'claude', contextModel: config.model, contextWindow: 1000000,
  });
  assert.equal((await srv.agentConversationContextMeta(config, session)).contextWindow, 1000000);
  assert.equal(await agentTrigger().run(session, config), false);
});

test('manual limits override old usage; Auto ignores old manual and external-summary windows', async () => {
  const config = configFor(), session = sessionAt(241000, {
    contextEngine: 'agent', contextAgentCliType: 'claude', contextModel: config.model, contextWindow: 131072,
  });
  assert.equal((await srv.agentConversationContextMeta(config, session)).contextWindow, 1000000);
  config.contextWindowOverrides[key('agent', 'claude', config.model)] = 0;
  for (const marker of [{ contextWindowSource: 'manual' }, { source: 'external-compact' }]) {
    const stale = structuredClone(session);
    Object.assign(stale.messages[0].usage, marker);
    assert.equal((await srv.agentConversationContextMeta(config, stale)).contextWindow, srv.CONTEXT_WINDOW_FALLBACK);
  }
});

test('measured windows from another engine or model never control the active conversation', async () => {
  const config = configFor(0);
  for (const usage of [
    { contextEngine: 'openai', contextProviderId: 'local', contextModel: config.model },
    { contextEngine: 'agent', contextAgentCliType: 'kimi', contextModel: config.model },
    { contextEngine: 'agent', contextAgentCliType: 'claude', contextModel: 'other-model' },
  ]) {
    const meta = await srv.agentConversationContextMeta(config, sessionAt(241000, { ...usage, contextWindow: 1000000 }));
    assert.equal(meta.contextWindow, srv.CONTEXT_WINDOW_FALLBACK);
  }
});

test('override identity isolates engine/provider/model and supports the CLI default route', async () => {
  const config = configFor();
  assert.equal(srv.configuredConversationWindow(config, 'agent', 'kimi', config.model), 0);
  assert.equal(srv.configuredConversationWindow(config, 'openai', 'claude', config.model), 0);
  assert.equal(srv.configuredConversationWindow(config, 'agent', 'claude', 'other-model'), 0);
  config.model = '';
  config.contextWindowOverrides[key('agent', 'claude', '')] = 1000000;
  assert.equal((await srv.agentConversationContextMeta(config, sessionAt(241000))).contextWindow, 1000000);
});

test('Kimi native status provides usage without replacing an explicit conversation limit', async () => {
  const config = configFor();
  config.agentCliType = 'kimi';
  config.contextWindowOverrides[key('agent', 'kimi', config.model)] = 1000000;
  const trigger = agentTrigger({ kimiSessionStatus: async () => ({ ok: true, contextTokens: 241000, contextWindow: 262144 }) });
  assert.equal(await trigger.run(sessionAt(241000), config, 'kimi'), false);
  assert.equal(trigger.calls.length, 0);
});

test('provider trigger consumes main-model override, not the summarizer window', async () => {
  const config = configFor();
  const provider = { id: 'main', model: config.model, contextWindow: 65536 };
  config.contextWindowOverrides[key('openai', 'main', config.model)] = 1000000;
  const summary = srv.resolveCompactionProvider(config, provider);
  assert.equal(srv.providerConversationContextWindow(config, provider, provider.model), 1000000);
  assert.equal(srv.providerContextWindow(summary.provider, summary.model), 131072);
  assert.equal(provider.contextWindow, 65536, 'does not mutate provider or summary budgets');
  const events = [];
  const run = vm.runInNewContext(`${extract('maybeAutoCompact')}\nmaybeAutoCompact`, {
    providerConversationContextWindow: srv.providerConversationContextWindow,
    providerContextWindow: srv.providerContextWindow,
    calibratedEstimate: () => 241000,
    writeHistorySnapshot: () => assert.fail('under-budget turns must not start compaction'),
  });
  assert.equal(await run({ providerHistory: [{ role: 'user', content: 'history' }] }, provider, '', config, e => events.push(e), provider.model), false);
  assert.deepEqual(events, []);
});

test('provider learned safety caps remain authoritative over manual conversation limits', () => {
  const config = configFor(), provider = { id: 'capped-main', model: 'custom', contextWindow: 1000000 };
  config.contextWindowOverrides[key('openai', provider.id, provider.model)] = 1000000;
  srv.noteWindowOvershoot(provider.id, provider.model, 100000);
  assert.equal(srv.providerConversationContextWindow(config, provider, provider.model), 90000);
});

test('config normalization bounds and validates persisted overrides; Auto zero survives', () => {
  const a = key('agent', 'claude', 'a'), b = key('openai', 'local', 'b'), c = key('agent', 'kimi', 'c');
  const { config } = srv.normalizeConfig({ contextWindowOverrides: {
    [a]: 1, [b]: 3000000, [c]: 0, invalid: 1000000,
    '["wrong","claude","x"]': 1000000, '["agent","claude",42]': 1000000,
    '["agent","claude","negative"]': -1, '["agent","claude","string"]': '1000000',
  } });
  assert.deepEqual(config.contextWindowOverrides, { [a]: 8000, [b]: 2000000, [c]: 0 });
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [key('agent', 'claude', String(i)), 1000000]));
  assert.equal(Object.keys(srv.normalizeConfig({ contextWindowOverrides: many }).config.contextWindowOverrides).length, 200);
});

function frontend(config = configFor(), legacy = {}) {
  const storage = new Map(Object.entries(legacy)), calls = [];
  const state = { config, status: {}, shownUsage: null };
  const context = vm.createContext({ window: {}, localStorage: {
    getItem: k => storage.get(k) ?? null, removeItem: k => storage.delete(k),
  } });
  const load = (file, name) => vm.runInContext(fs.readFileSync(path.join(app, 'public/js', file), 'utf8').replace(/export function /g, 'function ') + `\n${name}`, context);
  const api = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/config') {
      if (api.fail) throw new Error('save failed');
      return { ok: true, config: JSON.parse(options.body) };
    }
    return { contextWindowResolved: { value: 65536, source: 'fallback', engine: 'agent', agentCliType: 'claude', model: state.config.model } };
  };
  const ui = load('chat-render-primitives.js', 'createChatRenderPrimitives')({
    state, api, currentModelId: () => state.config.model, isProviderMode: () => !!state.config.activeProvider,
  });
  return { state, ui, api, calls, storage, load };
}

test('legacy browser-only 1M is persisted before use and removed only after success', async () => {
  const config = configFor(); config.contextWindowOverrides = {};
  const f = frontend(config, { 'wcw.ctxWindow::ark-code-latest': '1000000' });
  assert.equal(f.ui.ctxWindow(), 1000000);
  await f.ui.syncContextWindowManual();
  assert.equal(f.state.config.contextWindowOverrides[key('agent', 'claude', config.model)], 1000000);
  assert.equal(f.calls[0].url, '/api/config');
  assert.equal(f.storage.size, 0);
  await f.ui.syncContextWindowManual();
  assert.equal(f.calls.filter(c => c.url === '/api/config').length, 1);
});

test('legacy global override migrates once; Auto zero prevents it reappearing', async () => {
  const config = configFor(); config.contextWindowOverrides = {};
  const f = frontend(config, { 'wcw.ctxWindow': '1000000' });
  await f.ui.syncContextWindowManual();
  await f.ui.setCtxWindowManual(0);
  f.storage.set('wcw.ctxWindow', '1000000');
  assert.equal(f.ui.ctxWindowManual(), 0);
  assert.equal(f.ui.ctxWindow(), 65536, 'unknown main model matches server fallback');
});

test('manual save captures its route and serializes rapid edits without losing other overrides', async () => {
  const f = frontend();
  const first = f.ui.setCtxWindowManual(1000000);
  f.state.config.model = 'other-model';
  const second = f.ui.setCtxWindowManual(128000);
  await Promise.all([first, second]);
  assert.equal(f.state.config.contextWindowOverrides[key('agent', 'claude', 'ark-code-latest')], 1000000);
  assert.equal(f.state.config.contextWindowOverrides[key('agent', 'claude', 'other-model')], 128000);
  f.state.config.agentCliType = 'kimi';
  assert.equal(f.ui.ctxWindowManual(), 0);
});

test('failed migration leaves legacy value intact and can be retried', async () => {
  const config = configFor(); config.contextWindowOverrides = {};
  const f = frontend(config, { 'wcw.ctxWindow::ark-code-latest': '1000000' });
  f.api.fail = true;
  await assert.rejects(f.ui.syncContextWindowManual(), /save failed/);
  assert.equal(f.storage.size, 1);
  assert.equal(Object.keys(f.state.config.contextWindowOverrides).length, 0);
  f.api.fail = false;
  await f.ui.syncContextWindowManual();
  assert.equal(f.storage.size, 0);
});

test('Auto ignores obsolete manual/external usage and rejects status from another route', () => {
  const f = frontend(configFor(0));
  f.state.status.contextWindowResolved = { engine: 'agent', agentCliType: 'claude', model: f.state.config.model, value: 1000000, source: 'table' };
  f.state.shownUsage = { contextEngine: 'agent', contextAgentCliType: 'claude', contextModel: f.state.config.model, contextWindow: 131072, source: 'external-compact' };
  assert.equal(f.ui.ctxWindow(), 1000000);
  f.state.shownUsage.source = 'native';
  f.state.shownUsage.contextWindowSource = 'manual';
  assert.equal(f.ui.ctxWindow(), 1000000);
  f.state.status.contextWindowResolved.agentCliType = 'kimi';
  assert.notEqual(f.ui.ctxWindow(), 1000000);
});

test('send waits for limit persistence; on failure it preserves the draft and attachments', async () => {
  const f = frontend(), draft = { value: 'keep this draft' }, toasts = [];
  f.state.currentSession = { id: 'test' };
  f.state.attachments = [{ name: 'keep.txt' }];
  let release, synced = false;
  const pending = new Promise((_, reject) => { release = reject; });
  const runtime = f.load('chat-stream-runtime.js', 'createChatStreamRuntime')({
    state: f.state, $: id => { assert.equal(id, 'promptInput'); return draft; },
    syncContextWindowManual: () => { synced = true; return pending; },
    apiErrText: e => e.message, toast: (...args) => toasts.push(args),
  });
  const send = runtime.sendPrompt();
  assert.equal(synced, true);
  assert.equal(draft.value, 'keep this draft');
  assert.equal(runtime.activeTurns.size, 0);
  release(new Error('save failed'));
  await send;
  assert.equal(draft.value, 'keep this draft');
  assert.equal(f.state.attachments.length, 1);
  assert.equal(runtime.activeTurns.size, 0);
  assert.deepEqual(toasts, [['save failed', 'err']]);
});
