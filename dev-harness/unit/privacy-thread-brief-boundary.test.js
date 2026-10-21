'use strict';
// Actual threadBriefOnce -> providerRawCompletion -> providerPostJsonOnce boundary.
// Only persistence metadata and fetch responses are synthetic; no listener/model/CLI/DPAPI process.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-thread-brief-boundary-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'threadBriefOnce', 'buildThreadBriefMessages', 'providerPostJsonOnce', 'providerModelPostOnce', 'THREAD_BRIEF_INPUT_CHARS', 'THREAD_BRIEF_REPLY_CHARS'], { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
let seals = 0, opens = 0, workerStarts = 0, serial = 0;
app.PrivacyCore.configHooks.sealLocal = (...args) => { seals++; return f.vault.sealLocal(...args); };
app.PrivacyCore.configHooks.openLocal = (...args) => { opens++; return f.vault.openLocal(...args); };
const threads = require('node:worker_threads'), OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker { constructor(...args) { workerStarts++; super(...args); } };
const state = app.__eval(`(() => {
  const state = { gate: null, writes: [], logs: [] };
  loadSession = async id => { if (state.gate) await state.gate(); return { id, kind: 'quick_ask', title: 'New session', rewindGen: 0, turnSeq: 1 }; };
  updateSessionMeta = async (id, patch) => { state.writes.push({ id, patch }); return { ok: true }; };
  threadBriefRateLimited = () => false;
  logEvent = event => { state.logs.push({ kind: event.kind, error: event.error }); };
  return state;
})()`);
const captured = [], savedFetch = global.fetch;
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body); captured.push({ url, body });
  const text = JSON.stringify({ title: 'Synthetic private task', gist: 'A synthetic title acceptance fixture.' });
  const payload = Array.isArray(body.input)
    ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
    : url.includes('/messages') ? { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
    : { choices: [{ message: { content: text } }] };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};
const inputCap = app.THREAD_BRIEF_INPUT_CHARS, replyCap = app.THREAD_BRIEF_REPLY_CHARS;
const provider = style => ({ id: 'synthetic-' + style, type: 'openai-compat', apiStyle: style, baseUrl: 'https://fixture.invalid/v1',
  model: 'synthetic-model', apiKey: '', anthropicThinking: 'off', serverWebSearch: false });
const policy = (mode = 'basic', rules = []) => ({ privacyModeV1: mode, privacyTechnicalV1: false, privacyRulesV1: rules, providers: [], stewardThreadBriefV1: true, locale: 'en-US' });
const key = 'sk-SYNTHETIC-BRIEF-BOUNDARY-' + 'K'.repeat(24);
const idPrefix = '11010120000101001', weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
const identity = idPrefix + '10X98765432'[weights.reduce((sum, weight, i) => sum + weight * Number(idPrefix[i]), 0) % 11];
const sid = () => 'sess_brief_boundary_' + (++serial);
const invoke = (id, config, style, message, replyText = '') => app.threadBriefOnce({ sessionId: id, config, threadProvider: provider(style), stage: 'first_turn', message, replyText }, id);
const wire = from => JSON.stringify(captured.slice(from).map(row => row.body));
after(() => {
  global.fetch = savedFetch; threads.Worker = OriginalWorker; f.vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-thread-brief-boundary-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});

test('actual title requests protect full input and reply before caps under all three wire protocols', async () => {
  const cases = [
    { mode: 'basic', message: 'p'.repeat(inputCap - 11) + ' ' + key, fragment: key.slice(0, 10), category: 'CREDENTIAL' },
    { mode: 'enhanced', message: 'p'.repeat(inputCap - 11) + ' ' + identity, fragment: identity.slice(0, 10), category: 'IDENTITY' },
    { mode: 'basic', message: 'Public synthetic task.', reply: 'p'.repeat(replyCap - 11) + ' ' + key, fragment: key.slice(0, 10), category: 'CREDENTIAL' },
  ];
  for (const style of ['chat', 'responses', 'anthropic']) for (const row of cases) {
    const config = policy(row.mode); app.PrivacyGateway.configure(config); const before = captured.length;
    assert.ok(await invoke(sid(), config, style, row.message, row.reply));
    assert.equal(captured.length, before + 1); const sent = wire(before);
    assert.equal(sent.includes(row.fragment), false, style + ': clipped original prefix must never reach fetch');
    assert.match(sent, new RegExp('RUYI_PVT:' + row.category + ':'));
  }
});

test('full structured field context survives title clipping and protected excerpts are never clipped twice', async () => {
  const field = 'SYNTHETIC-CLIPPED-FIELD-' + 'Q'.repeat(1300);
  const config = policy('basic', [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }]);
  const source = JSON.stringify({ patientCode: field }, null, 2);
  for (const style of ['chat', 'responses', 'anthropic']) {
    app.PrivacyGateway.configure(config); const before = captured.length;
    assert.ok(await invoke(sid(), config, style, source));
    const sent = wire(before); assert.equal(sent.includes(field.slice(0, 32)), false); assert.match(sent, /RUYI_PVT:INTERNAL:/);
  }
  // The internal override receives already bounded/protected excerpts. Its caller
  // owns the cap; applying the old slice again would split the final opaque token.
  const ref = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
  const excerpt = 'p'.repeat(inputCap - 5) + ref;
  const messages = app.buildThreadBriefMessages('unused original', '', 'en-US', { message: excerpt, reply: '' });
  assert.ok(JSON.stringify(messages).includes(ref));
});

test('host-preserved same-scope references remain atomic while raw tool sources still reject reserved tokens', async () => {
  for (const style of ['chat', 'responses', 'anthropic']) {
    const id = sid(), config = policy('enhanced'); app.PrivacyGateway.configure(config); let reference;
    await app.PrivacyGateway.run(id, config, async () => {
      reference = (await app.PrivacyGateway.toolResult({ email: 'synthetic-existing-ref@example.test' })).email;
      await assert.rejects(app.PrivacyGateway.projectSource(reference), /privacy\.reserved_literal/);
    });
    const before = captured.length;
    assert.ok(await invoke(id, config, style, 'p'.repeat(inputCap - 10) + ' ' + reference));
    const sent = wire(before);
    assert.ok(sent.includes(reference)); assert.equal(sent.includes('synthetic-existing-ref@example.test'), false);
    assert.equal((sent.match(/\[\[RUYI_PVT:/g) || []).length, (sent.match(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g) || []).length);
  }
});

test('forged and cross-scope references stop the auxiliary call before fetch', async () => {
  const config = policy('enhanced'); app.PrivacyGateway.configure(config); let reference;
  await app.PrivacyGateway.run(sid(), config, async () => { reference = (await app.PrivacyGateway.toolResult({ email: 'synthetic-other-scope@example.test' })).email; });
  for (const value of [reference, '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]', '[[RUYI_PVT:abbreviated']) {
    const before = captured.length;
    assert.equal(await invoke(sid(), config, 'chat', 'Public task ' + value), null);
    assert.equal(captured.length, before);
  }
});

test('late title with a stale off config uses the current protected policy', async () => {
  const current = policy('basic'); app.PrivacyGateway.configure(current); const before = captured.length;
  assert.ok(await invoke(sid(), policy('off'), 'chat', 'p'.repeat(inputCap - 11) + ' ' + key));
  assert.equal(captured.length, before + 1); assert.equal(wire(before).includes(key.slice(0, 10)), false); assert.match(wire(before), /RUYI_PVT:CREDENTIAL:/);
});

test('off-to-on and protected rule switches during an awaited title gate cannot send under stale policy', async () => {
  for (const initial of [policy('off'), policy('basic')]) {
    app.PrivacyGateway.configure(initial);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
    state.gate = async () => { entered(); await gate; };
    const before = captured.length;
    const pending = invoke(sid(), initial, 'chat', 'Synthetic public request.');
    try {
      await blocked;
      app.PrivacyGateway.configure(policy('enhanced', [{ id: 'changed', kind: 'literal', value: 'SYNTHETIC-SWITCH', category: 'INTERNAL' }]));
      release(); assert.equal(await pending, null); assert.equal(captured.length, before);
    } finally { release(); state.gate = null; await pending; }
  }
});

test('ordinary off title preserves original 1200 and 400 caps without scope state, workers or key wrapping', async () => {
  const config = policy('off');
  Object.defineProperty(config, 'privacyRulesV1', { get() { throw Error('off rules enumerated'); } });
  app.PrivacyGateway.configure(config);
  const before = captured.length, oldSeals = seals, oldOpens = opens, oldWorkers = workerStarts;
  const filesBefore = fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')).sort() : [];
  const message = 'm'.repeat(inputCap + 100), reply = 'r'.repeat(replyCap + 100);
  assert.ok(await invoke(sid(), config, 'chat', message, reply));
  const body = captured[before].body;
  const content = body.messages.findLast(row => row.role === 'user').content;
  assert.equal(content, "User's own words:\n" + message.slice(0, inputCap) + '\n\nAssistant reply (excerpt):\n' + reply.slice(0, replyCap));
  assert.equal(seals, oldSeals); assert.equal(opens, oldOpens); assert.equal(workerStarts, oldWorkers);
  assert.deepEqual(fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')).sort() : [], filesBefore);
  assert.equal(fs.existsSync(path.join(data, 'credential-vault-v1.json')), false);
});

test('actual provider POST rechecks policy after boundary resolution and before fetch', async () => {
  const vm = require('node:vm');
  for (const initial of [policy('off'), policy('basic')]) {
    const gateway = app.PrivacyGateway; gateway.configure(initial);
    let boundaryResolved = 0, fetches = 0;
    // The real boundary finishes first. Resolving this thenable queues the caller's
    // await continuation; change policy synchronously before that continuation runs.
    // Without the POST caller's post-await assert, its actual fetch is now reachable.
    const post = vm.runInNewContext('(() => { const providerModelPostOnce = ' + app.providerModelPostOnce.toString() + '; return ' + app.providerPostJsonOnce.toString() + '; })()', {
      AbortController, setTimeout, clearTimeout,
      PrivacyGateway: { ...gateway, beforeModelRequest: body => ({ then(resolve, reject) {
        gateway.beforeModelRequest(body).then(prepared => {
          boundaryResolved++; resolve(prepared); gateway.configure(policy('enhanced'));
        }, reject);
      } }) },
      fetch: async () => { fetches++; throw Error('stale policy reached fetch'); },
    });
    const result = await gateway.withPolicy(sid(), () => post({ url: 'https://fixture.invalid/v1/chat/completions', headers: {},
      body: { messages: [{ role: 'user', content: 'Synthetic public request.' }] }, timeoutMs: 1000 }));
    assert.equal(boundaryResolved, 1); assert.equal(fetches, 0);
    assert.equal(result.threw, true); assert.equal(result.error.code, 'privacy.policy_changed');
  }
});
