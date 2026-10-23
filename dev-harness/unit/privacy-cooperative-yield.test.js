'use strict';
// DRAFT: definitions only; do not run until the parent opens the runtime window.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const repo = process.env.RUYI_GATEWAY_DRAFT_REPO || path.resolve(__dirname, '../..');
const fixturePath = path.join(repo, 'dev-harness/lib/privacy-test-fixture.js');
let fixtureLibrary;
if (process.env.RUYI_GATEWAY_DRAFT_DIR) {
  const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath; fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath));
  fixtureModule._compile(fs.readFileSync(path.join(process.env.RUYI_GATEWAY_DRAFT_DIR, 'test-lib/privacy-test-fixture.js'), 'utf8'), fixturePath);
  fixtureLibrary = fixtureModule.exports;
} else fixtureLibrary = require(fixturePath);
const { fixture, gateway } = fixtureLibrary;
const { functionBlock } = require(path.join(repo, 'dev-harness/lib/source-slice'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-gateway-cooperative-'));
const source = file => fs.readFileSync(process.env.RUYI_GATEWAY_DRAFT_DIR ? path.join(process.env.RUYI_GATEWAY_DRAFT_DIR, 'src', file) : path.join(repo, 'ruyi-workbench/app/src', file), 'utf8');
const policy = rules => ({ privacyModeV1: 'enhanced', privacyRulesV1: rules || [], providers: [] });
let serial = 0;
const fresh = (schedule = setImmediate, fx = fixture()) => {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const api = gateway(dir, fx, { source: source('03a-privacy-gateway.js'), setImmediate: schedule });
  api.configure(policy()); return { api, fx };
};
const boundary = (api, fetch) => vm.runInNewContext(functionBlock(source('04h-provider-http.js'), 'providerModelPostOnce') + '\nproviderModelPostOnce;', { PrivacyGateway: api, fetch });
const wide = Array.from({ length: 2000 }, () => 'ordinary public leaf');
const protocols = [
  { messages: [{ role: 'user', content: 'Public request' }], metadata: { rows: wide } },
  { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Public request' }] }], metadata: { rows: wide } },
  { system: 'public', messages: [{ role: 'user', content: [{ type: 'text', text: 'Public request' }] }], metadata: { rows: wide } },
];
after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });

test('boundary cancellation during cooperative traversal sends no bytes in main/child protocol shapes', async () => {
  for (const scope of ['main', 'child']) for (const body of protocols) {
    const ctrl = new AbortController(); let yields = 0, sends = 0;
    const { api } = fresh(resume => { yields++; ctrl.abort(); return setImmediate(resume); });
    const post = boundary(api, async () => { sends++; throw Error('cancelled request reached provider'); });
    const original = JSON.stringify(body);
    await api.run(scope + (++serial), policy(), async () => {
      const context = api.active();
      await assert.rejects(post({ url: 'http://invalid.local/model', headers: {}, body, signal: ctrl.signal }), error => error.name === 'AbortError');
      assert.equal(api.active(), context, 'execution context identity survives every pause');
    });
    assert.ok(yields > 0); assert.equal(sends, 0); assert.equal(JSON.stringify(body), original);
  }
});

test('policy switch away and back while suspended invalidates the operation epoch', async () => {
  let api, changed = false, sends = 0;
  ({ api } = fresh(resume => {
    if (!changed) { changed = true; api.configure({ privacyModeV1: 'off' }); api.configure(policy()); }
    return setImmediate(resume);
  }));
  const post = boundary(api, async () => { sends++; });
  await api.run('epoch', policy(), async () => {
    await assert.rejects(post({ url: 'http://invalid.local/model', headers: {}, body: protocols[0] }), { code: 'privacy.policy_changed' });
  });
  assert.equal(sends, 0);
});

test('the final send boundary still checks the original epoch after awaiting a completed preparation', async () => {
  const { api } = fresh(); let sends = 0;
  const observed = { ...api, beforeModelRequest: async (...args) => {
    const result = await api.beforeModelRequest(...args);
    queueMicrotask(() => { api.configure({ privacyModeV1: 'off' }); api.configure(policy()); });
    return result;
  } };
  const post = boundary(observed, async () => { sends++; });
  await api.run('final-epoch', policy(), () => assert.rejects(post({ url: 'http://invalid.local/model', headers: {}, body: protocols[0] }), { code: 'privacy.policy_changed' }));
  assert.equal(sends, 0);
});

test('parallel regex operations in one scope never overwrite one another’s result map', async () => {
  const { api } = fresh(), config = policy([{ id: 'employee', kind: 'regex', value: 'EMP-[0-9]{4}', category: 'INTERNAL' }]); api.configure(config);
  await api.run('parallel-regex', config, async () => {
    const [a, b] = await Promise.all(['EMP-1111', 'EMP-2222'].map(secret => api.beforeModelRequest({ messages: [{ role: 'user', content: secret }], metadata: { rows: wide } })));
    assert.ok(!JSON.stringify(a).includes('EMP-1111')); assert.ok(!JSON.stringify(b).includes('EMP-2222'));
    assert.match(JSON.stringify(a), /RUYI_PVT/); assert.match(JSON.stringify(b), /RUYI_PVT/);
  });
});

test('regex_aborted becomes AbortError only for a truly aborted signal', async () => {
  const fx = fixture(), originalRegex = fx.PrivacyRegex;
  fx.PrivacyRegex = { ...originalRegex, scan: async () => { throw Object.assign(new Error('privacy.regex_aborted'), { code: 'privacy.regex_aborted' }); } };
  const { api } = fresh(setImmediate, fx), config = policy([{ id: 'employee', kind: 'regex', value: 'EMP-[0-9]{4}', category: 'INTERNAL' }]); api.configure(config);
  await api.run('false-abort', config, () => assert.rejects(api.beforeModelRequest(protocols[0], { signal: new AbortController().signal }), { code: 'privacy.regex_aborted' }));
  const ctrl = new AbortController();
  fx.PrivacyRegex.scan = async (_rules, _inputs, options) => {
    assert.equal(options.signal, ctrl.signal); ctrl.abort();
    throw Object.assign(new Error('privacy.regex_aborted'), { code: 'privacy.regex_aborted' });
  };
  await api.run('true-abort', config, () => assert.rejects(api.beforeModelRequest(protocols[0], { signal: ctrl.signal }), error => error.name === 'AbortError'));
});

test('the real streaming error and transient-retry adapters do not classify cancellation as retry or failover', async () => {
  const ctrl = new AbortController(); let sends = 0, classified = 0, failovers = 0;
  const { api } = fresh(resume => { ctrl.abort(); return setImmediate(resume); });
  const post = boundary(api, async () => { sends++; });
  const autonomy = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/07-autonomy.js'), 'utf8'), http = source('04h-provider-http.js');
  const transport = vm.runInNewContext(functionBlock(autonomy, 'openAiStreamOnce') + '\n' + functionBlock(http, 'withTransientRetry') + '\n({ openAiStreamOnce, withTransientRetry });', {
    providerModelPostOnce: post, providerWireProtocolForBody: () => ({}), failoverConnectReason: () => { failovers++; return 'connect'; }, abortableDelay: async () => {},
  });
  await api.run('no-replay', policy(), () => assert.rejects(transport.withTransientRetry({
    attempt: () => transport.openAiStreamOnce({ chatUrl: 'http://invalid.local/model', headers: {}, body: protocols[0], ctrl }),
    classify: () => { classified++; return 'retry'; }, maxRetries: 3, backoffMs: () => 0, signal: ctrl.signal, isAborted: () => ctrl.signal.aborted,
  }), error => error.name === 'AbortError'));
  assert.equal(sends, 0); assert.equal(classified, 0); assert.equal(failovers, 0);
});

test('summary history protection receives the caller stop signal and never enters summary dispatch', async () => {
  const ctrl = new AbortController(); let calls = 0;
  const { api } = fresh(resume => { ctrl.abort(); return setImmediate(resume); });
  const governance = source('10-context-governance.js');
  const summary = vm.runInNewContext(['summaryStopSignal', 'summaryStoppedResult', 'providerSummaryCall'].map(name => functionBlock(governance, name)).join('\n') + '\nproviderSummaryCall;', {
    PrivacyGateway: api, providerSummaryCallCore: async () => { calls++; return { ok: true }; },
  });
  await api.run('summary-abort', policy(), async () => {
    const owner = {}, history = Array.from({ length: 2000 }, () => ({ role: 'user', content: 'public' })); api.bindHostHistory(owner, history);
    const result = await summary({}, history, { privacyHistoryOwner: owner, signal: ctrl.signal });
    assert.equal(result.aborted, true); assert.equal(result.ok, false); assert.equal(calls, 0);
  });
});

test('yielding never clears sourceWork and strict raw/source proof gates remain in force', async () => {
  const { api } = fresh();
  await api.run('source-budget', policy(), async () => {
    await api.projectSource('first ordinary source'); const work = api.active().sourceWork;
    await api.beforeModelRequest(protocols[0]); await api.projectSource('second ordinary source');
    assert.equal(api.active().sourceWork, work); assert.equal(work.files, 2);
    assert.equal(work.bytes, Buffer.byteLength('first ordinary sourcesecond ordinary source'));
    await assert.rejects(api.projectSource('const PREFIX = "[[RUYI_PVT:";'), { code: 'privacy.reserved_literal' });
    await assert.rejects(api.toolResult({ raw: '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]' }), { code: 'privacy.reserved_literal' });
  });
});

test('cooperative boundaries retain original leaf, aggregate, node, depth and match limits', async () => {
  const { api, fx } = fresh();
  assert.equal(fx.PrivacyCore.LIMITS.bytes, 1024 * 1024);
  assert.equal(fx.PrivacyCore.LIMITS.learnedComparisons, 32 * 1024 * 1024);
  assert.equal(fx.PrivacyCore.LIMITS.matches, 10000);
  await api.run('fixed-limits', policy(), async () => {
    await assert.rejects(api.toolResult('X'.repeat(1024 * 1024 + 1)), { code: 'privacy.text_limit' });
    await assert.rejects(api.toolResult(Array(17).fill('X'.repeat(512 * 1024))), { code: 'privacy.aggregate_limit' });
    await assert.rejects(api.toolResult(Array(50001).fill(null)), { code: 'privacy.structure_limit' });
    let nested = 'public'; for (let i = 0; i < 34; i++) nested = { a: nested };
    await assert.rejects(api.toolResult(nested), { code: 'privacy.structure_limit' });
  });
  const config = policy([{ id: 'many', kind: 'literal', value: '!', category: 'INTERNAL' }]); api.configure(config);
  await api.run('match-limit', config, () => assert.rejects(api.toolResult('!'.repeat(10001)), { code: 'privacy.matches_limit' }));
});
