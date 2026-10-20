'use strict';
// Actual HTTP route functions with an in-memory response sink, synthetic session
// storage and synthetic ciphertext. No listener, browser, model or DPAPI process.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-display-http-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'streamChat', 'handleStewardRunnerApiRoutes', 'handleStewardApiRoutes', 'handleSessionApiRoutes', 'sessionMessagesStamp'], { withEval: true });
const fixture = require('../lib/privacy-test-fixture').fixture();
let seals = 0, opens = 0;
app.PrivacyCore.configHooks.sealLocal = (...args) => { seals++; return fixture.vault.sealLocal(...args); };
app.PrivacyCore.configHooks.openLocal = (...args) => { opens++; return fixture.vault.openLocal(...args); };
const state = app.__eval(`(() => {
  const state = { config: null, session: null, live: { live: false }, run: null, steward: null, runner: {} };
  readJsonBody = async req => req.fixtureBody || {};
  tokenOk = () => true;
  readConfig = async () => state.config;
  runSessionTurn = opts => state.run(opts);
  runStewardTurn = opts => state.steward(opts);
  loadSession = async id => state.session && state.session.id === id ? state.session : null;
  readSessionHeadResilient = async () => state.session;
  sessionEnvelopeStamp = async () => 'synthetic-disk-stamp';
  sessionEnvelopeLiveParts = () => state.live;
  sessionDisplayTitle = session => session.title || '';
  StewardHooks.runnerState = async () => state.runner;
  stewardInboxState = async () => ({ enabled: true });
  return state;
})()`);
const policy = mode => ({ privacyModeV1: mode, privacyRulesV1: [], privacyTechnicalV1: false, providers: [], stewardEnabledV1: true });
const request = (method, url, fixtureBody = {}) => Object.assign(new EventEmitter(), { method, url, headers: {}, fixtureBody, socket: { setNoDelay() {} } });
function response() {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], headers: {}, writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    flushHeaders() {}, write(chunk) { assert.equal(this.writableEnded, false); this.chunks.push(String(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; },
  });
  return res;
}
const frames = res => res.chunks.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const envelope = res => JSON.parse(res.chunks.join(''));
const synthetic = 'synthetic-display-http@example.test';
async function reference(id) {
  state.config = policy('enhanced'); app.PrivacyGateway.configure(state.config);
  return app.PrivacyGateway.run(id, state.config, async () => (await app.PrivacyGateway.toolResult({ email: synthetic })).email);
}
function canonical(id, token) {
  return { id, title: 'Synthetic display task', messages: [{ role: 'user', content: 'Public task', createdAt: '2026-10-20T01:00:00Z' },
    { role: 'assistant', content: token, thinking: token, segments: [{ type: 'text', text: token }, { type: 'thinking', text: token }], createdAt: '2026-10-20T02:00:00Z' }],
  providerHistory: [{ role: 'assistant', content: token }], turnSeq: 1 };
}
after(() => {
  fixture.vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-display-http-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});

test('main HTTP projects only display copies and awaits split-token output before end', async () => {
  const id = 'sess_display_http_main', token = await reference(id), session = canonical(id, token), before = JSON.stringify(session);
  state.run = async opts => {
    assert.equal(opts.knownMessages, null);
    opts.onStart(); opts.onEvent({ type: 'session', session, messagesStamp: app.sessionMessagesStamp(session.messages) });
    // Production processEvt emits raw_line before every decoded SSE delta.
    // Its presence must not flush and expose the preceding partial marker.
    for (const text of token) { opts.onEvent({ type: 'raw_line', line: 'synthetic opaque wire frame' }); opts.onEvent({ type: 'assistant_delta', text }); }
    for (const text of token) { opts.onEvent({ type: 'raw_line', line: 'synthetic opaque wire frame' }); opts.onEvent({ type: 'thinking_delta', text }); }
    opts.onEvent({ type: 'tool_result', id: 'opaque-tool', content: { text: token } });
    opts.onEvent({ type: 'result', ok: true }); opts.onFlush();
  };
  // The trusted session frame, rather than a user-selected body id, binds new scope.
  const res = response(); await app.streamChat(request('POST', '/api/chat/stream', { sessionId: 'sess_wrong_body', message: 'Public task', knownMessages: { count: 2, stamp: 'canonical-only' } }), res);
  const events = frames(res), shown = events.find(row => row.type === 'session');
  assert.equal(shown.session.messages[1].content, synthetic);
  assert.equal(shown.session.providerHistory[0].content, token);
  for (const type of ['assistant_delta', 'thinking_delta']) assert.equal(events.filter(row => row.type === type).map(row => row.text).join(''), synthetic);
  assert.equal(events.find(row => row.type === 'tool_result').content.text, token);
  assert.equal(events.at(-1).type, 'result'); assert.equal(res.writableEnded, true); assert.equal(JSON.stringify(session), before);
});

test('actual history and streaming HTTP routes translate complete diagnostics while preserving ordinary bracket endings', async () => {
  state.config = { ...policy('enhanced'), locale: 'zh-CN' }; app.PrivacyGateway.configure(state.config);
  const marker = '[Local privacy validation refused an unavailable reference in an earlier model message. No value was recovered; inspect the original local transcript and tool error before retrying.]';
  const id = 'sess_display_http_diagnostic', session = canonical(id, marker), before = JSON.stringify(session);
  state.session = session; state.live = { live: false };
  const loaded = response(); await app.handleSessionApiRoutes(request('GET', '/api/sessions/' + id), loaded, '/api/sessions/' + id);
  const expected = envelope(loaded).session.messages.at(-1).content; assert.match(expected, /本机隐私保护/); assert.ok(!expected.includes(marker));
  state.run = async opts => {
    opts.onStart(); opts.onEvent({ type: 'session', session });
    for (const text of marker) { opts.onEvent({ type: 'assistant_delta', text }); opts.onEvent({ type: 'raw_line', line: 'synthetic wire metadata' }); }
    opts.onEvent({ type: 'assistant_delta', text: ' ordinary [' }); opts.onEvent({ type: 'result', ok: true });
  };
  const streamed = response(); await app.streamChat(request('POST', '/api/chat/stream', { sessionId: id, message: 'Public task' }), streamed);
  assert.equal(frames(streamed).filter(row => row.type === 'assistant_delta').map(row => row.text).join(''), expected + ' ordinary [');
  assert.equal(JSON.stringify(session), before); assert.equal(streamed.writableEnded, true);
});

test('HTTP display snapshots the session synchronously before the engine appends the next user message', async () => {
  state.config = policy('off'); app.PrivacyGateway.configure(state.config);
  const observed = [];
  for (const kind of ['main', 'steward']) {
    const session = { id: kind === 'main' ? 'sess_display_sync_snapshot' : 'steward',
      messages: [{ role: 'assistant', content: 'Previous public answer' }], providerHistory: [] };
    const stamp = app.sessionMessagesStamp(session.messages);
    const run = async opts => {
      if (opts.onStart) opts.onStart();
      opts.onEvent({ type: 'session', session, messagesStamp: stamp });
      // Production runSessionTurn emits its prefix snapshot just before the
      // admitted engine synchronously appends this turn's user message.
      session.messages.push({ role: 'user', content: 'Current public input' });
      opts.onEvent({ type: 'result', ok: true });
      return { ok: true, say: 'Public reply' };
    };
    const res = response();
    if (kind === 'main') {
      state.run = run; await app.streamChat(request('POST', '/api/chat/stream', { message: 'Public task' }), res);
    } else {
      state.steward = run; await app.handleStewardRunnerApiRoutes(request('POST', '/api/steward/message', { message: 'Public task' }), res, '/api/steward/message');
    }
    const event = frames(res).find(row => row.type === 'session');
    observed.push({ kind, messageCount: event.session.messages.length, stampMatches: event.messagesStamp === app.sessionMessagesStamp(event.session.messages) });
    assert.equal(session.messages.length, 2, kind + ': canonical engine append remains intact');
  }
  assert.deepEqual(observed, [{ kind: 'main', messageCount: 1, stampMatches: true }, { kind: 'steward', messageCount: 1, stampMatches: true }],
    'both HTTP sinks must capture the original host prefix before later engine mutations');
});

test('main HTTP safely flushes a cancelled partial marker before closing the response', async () => {
  const id = 'sess_display_http_cancel', token = await reference(id);
  state.run = async opts => {
    opts.onStart(); opts.onEvent({ type: 'session', session: canonical(id, token) });
    opts.onEvent({ type: 'assistant_delta', text: 'Public prefix [[RUYI_PVT:EMA' });
    throw Error('synthetic cancellation');
  };
  const res = response(); await assert.rejects(app.streamChat(request('POST', '/api/chat/stream', { message: 'Public task' }), res), /synthetic cancellation/);
  const output = frames(res).filter(row => row.type === 'assistant_delta').map(row => row.text).join('');
  assert.ok(output.startsWith('Public prefix ')); assert.equal(output.includes('[[RUYI_PVT:'), false); assert.equal(output.includes(synthetic), false);
  assert.equal(res.writableEnded, true);
});

test('steward HTTP restores streaming narration and final say/why without changing actions', async () => {
  const token = await reference('steward'), session = canonical('steward', token), action = { tool: 'fixture', text: token };
  state.steward = async opts => {
    opts.onEvent({ type: 'session', session });
    opts.onEvent({ type: 'assistant_delta', text: token.slice(0, 20) });
    opts.onEvent({ type: 'assistant_delta', text: token.slice(20) });
    opts.onEvent({ type: 'result', ok: true });
    return { ok: true, say: token, why: token, actions: [action], acts: [], parsed: true };
  };
  const res = response(); await app.handleStewardRunnerApiRoutes(request('POST', '/api/steward/message', { message: 'Public task' }), res, '/api/steward/message');
  const events = frames(res), reply = events.find(row => row.type === 'steward_reply');
  assert.equal(events.filter(row => row.type === 'assistant_delta').map(row => row.text).join(''), synthetic);
  assert.equal(reply.say, synthetic); assert.equal(reply.why, synthetic); assert.equal(reply.actions[0].text, token);
  assert.equal(session.messages[1].content, token); assert.equal(session.providerHistory[0].content, token); assert.equal(res.writableEnded, true);
});

test('full, delta, since and live history use display copies and private mappings bypass canonical caches', async () => {
  const token = await reference('steward'); state.session = canonical('steward', token);
  state.live = { live: true, liveTail: { text: token, full: token }, liveTurn: { segments: [{ type: 'text', text: token }, { type: 'thinking', text: token }], toolCalls: [] } };
  const before = JSON.stringify(state.session), stamp = app.sessionMessagesStamp(state.session.messages.slice(0, 1));
  for (const mode of ['enhanced', 'off']) for (const suffix of ['', '?fromIndex=1&prefixStamp=' + encodeURIComponent(stamp), '?since=2026-10-20T01:30:00Z', '?view=live']) {
    state.config = policy(mode); app.PrivacyGateway.configure(state.config);
    const req = request('GET', '/api/sessions/steward' + suffix); req.headers['if-none-match'] = '*';
    const res = response(); await app.handleSessionApiRoutes(req, res, '/api/sessions/steward'); const shown = envelope(res);
    assert.equal(res.statusCode, 200); assert.equal(res.headers.etag, undefined); assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(shown.messagesFrom, undefined); assert.equal(shown.liveTail.text, synthetic); assert.equal(shown.liveTail.full, synthetic);
    assert.equal(shown.liveTurn.segments[0].text, synthetic);
    if (suffix !== '?view=live') {
      assert.equal(shown.session.messages.at(-1).content, synthetic); assert.equal(shown.session.providerHistory[0].content, token);
      assert.equal(shown.session.messages.length, suffix.startsWith('?since=') ? 1 : 2);
    }
  }
  assert.equal(JSON.stringify(state.session), before);
});

test('steward state projects only lastReply say/why and keeps the stored runner result opaque', async () => {
  const token = await reference('steward');
  state.runner = { lastReply: { say: token, why: token, acts: [{ text: token }], actions: [{ text: token }] } };
  const before = JSON.stringify(state.runner), res = response();
  await app.handleStewardApiRoutes(request('GET', '/api/steward/state'), res, '/api/steward/state');
  const shown = envelope(res);
  assert.equal(shown.lastReply.say, synthetic); assert.equal(shown.lastReply.why, synthetic);
  assert.equal(shown.lastReply.acts[0].text, token); assert.equal(shown.lastReply.actions[0].text, token);
  assert.equal(JSON.stringify(state.runner), before);
});

test('fresh off history preserves ETag/delta paths without initializing mappings or key wrapping', async () => {
  state.config = policy('off'); app.PrivacyGateway.configure(state.config);
  state.session = canonical('sess_display_http_off', 'Public text'); state.live = { live: false };
  const oldSeals = seals, oldOpens = opens, req = request('GET', '/api/sessions/sess_display_http_off'), first = response();
  await app.handleSessionApiRoutes(req, first, '/api/sessions/sess_display_http_off'); assert.ok(first.headers.etag);
  const again = response(), conditional = request('GET', req.url); conditional.headers['if-none-match'] = first.headers.etag;
  await app.handleSessionApiRoutes(conditional, again, '/api/sessions/sess_display_http_off'); assert.equal(again.statusCode, 304);
  const stamp = app.sessionMessagesStamp(state.session.messages.slice(0, 1)), delta = response();
  await app.handleSessionApiRoutes(request('GET', req.url + '?fromIndex=1&prefixStamp=' + stamp), delta, '/api/sessions/sess_display_http_off');
  assert.equal(envelope(delta).messagesFrom, 1); assert.equal(envelope(delta).session.messages.length, 1);
  assert.equal(seals, oldSeals); assert.equal(opens, oldOpens);
});
