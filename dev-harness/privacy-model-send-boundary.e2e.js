'use strict';
// Generated server functions, real PrivacyGateway and loopback receiver; synthetic data only.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { releaseEnvironment } = require('./lib/release-checks');
const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-model-boundary-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'providerModelPostOnce', 'providerPostJsonOnce', 'probeProviderCompletion', 'openAiStreamOnce', 'singleSummaryCall', 'providerWireProtocol']);
const fixture = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = fixture.vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = fixture.vault.openLocal;
const runner = createRunner('PRIVACY MODEL SEND BOUNDARY');
const secret = 'sk-SYNTHETIC-MODEL-BOUNDARY-' + 'K'.repeat(30);
const policy = mode => ({ privacyModeV1: mode, privacyRulesV1: [], providers: [] });
const gateway = app.PrivacyGateway;
let serial = 0, responseMode = '', switchAfterResponse = false;
const rows = [];
async function check(label, work) { try { await work(); runner.ok(true, label); } catch (e) { runner.ok(false, label + ': ' + e.stack); } }
(async () => {
  let fake;
  try {
    const record = (url, raw, headers) => rows.push({ url, raw, body: JSON.parse(raw), headers });
    fake = await startFakeProvider({ handler(ctx) {
      record(ctx.url, ctx.raw, ctx.headers);
      if (responseMode === 'retry' && ctx.body.stream_options) {
        if (switchAfterResponse) gateway.configure(policy('off'));
        return { status: 400, json: { error: { message: 'stream_options unsupported' } } };
      }
      return textFrames('A sufficiently detailed synthetic summary with useful retained context.');
    }, fallback(req, res) {
      let raw = ''; req.setEncoding('utf8'); req.on('data', part => { raw += part; });
      req.on('end', () => {
        record(req.url, raw, req.headers);
        const text = 'A sufficiently detailed synthetic summary with useful retained context.';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url.includes('/messages')
          ? { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
          : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }));
      });
    } });
    const provider = style => ({ id: 'fixture-' + style, type: 'openai-compat', apiStyle: style, baseUrl: fake.url + '/v1', model: 'fixture-model', apiKey: '', anthropicThinking: 'off', serverWebSearch: false });
    const messages = () => [{ role: 'user', content: 'Synthetic source ' + secret }];
    const body = style => app.providerWireProtocol(provider(style)).encodeMessages({ model: 'fixture-model', messages: messages(), stream: false, provider: provider(style) });
    const post = (b, signal) => app.providerModelPostOnce({ url: fake.url + '/v1/chat/completions', headers: { 'content-type': 'application/json', 'x-fixture': 'preserved' }, body: b, signal });
    const stream = b => app.openAiStreamOnce({ chatUrl: fake.url + '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: b, ctrl: new AbortController(), onEvent() {}, markUsage() {}, rawSeqRef: { n: 0 }, touch() {} });
    for (const style of ['chat', 'responses', 'anthropic']) {
      await check(style + ' wrappers preserve protocol and protect actual received bytes', async () => {
        gateway.configure(policy('basic'));
        const start = rows.length, p = provider(style), wire = app.providerWireProtocol(p);
        await gateway.withPolicy('fixture-style-' + (++serial), async () => {
          const result = await app.providerPostJsonOnce({ url: wire.completionUrl(p.baseUrl), headers: wire.requestHeaders(p), body: body(style), timeoutMs: 1000 });
          assert.equal(result.ok, true);
          assert.equal((await app.probeProviderCompletion(p, 'fixture-model', 1000)).ok, true);
          const result2 = await app.openAiStreamOnce({ chatUrl: wire.completionUrl(p.baseUrl), headers: wire.requestHeaders(p), body: body(style), ctrl: new AbortController(), onEvent() {}, markUsage() {}, rawSeqRef: { n: 0 }, touch() {}, protocol: wire });
          assert.equal(result2.text.includes('synthetic'), true);
          const summary = await app.singleSummaryCall(p, messages(), 'fixture-model', null, 'Summarize the synthetic facts.', undefined, policy('basic'));
          assert.equal(summary.ok, true);
        });
        assert.equal(rows.length, start + 4);
        for (const row of rows.slice(start)) assert.equal(row.raw.includes(secret), false);
        const sent = rows[start]; assert.match(sent.raw, /RUYI_PVT/);
        assert.equal(sent.body.model, 'fixture-model');
        assert.equal(Array.isArray(style === 'responses' ? sent.body.input : sent.body.messages), true);
        if (style === 'anthropic') assert.equal(sent.headers['anthropic-version'], '2023-06-01');
      });
    }
    await check('OFF sends exact JSON without scanning, scope persistence or key protection', async () => {
      gateway.configure(policy('off')); const original = app.PrivacyCore.configHooks.sealLocal;
      const threads = require('node:worker_threads'), OriginalWorker = threads.Worker;
      let workers = 0, contextAtEncode = 'unset';
      threads.Worker = class extends OriginalWorker { constructor(...args) { workers++; super(...args); } };
      const scopesBefore = fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')).sort() : [];
      app.PrivacyCore.configHooks.sealLocal = () => { throw Error('OFF must not seal'); };
      try {
        const b = { model: 'fixture-model', messages: messages(), stream: false, extra: { quote: '"', count: 123 } };
        const start = rows.length;
        // A non-enumerable toJSON observes the real final encoder without changing its bytes.
        Object.defineProperty(b, 'toJSON', { value() { contextAtEncode = gateway.active(); return { ...this }; } });
        await (await post(b)).text();
        assert.equal(rows.length, start + 1); assert.equal(rows.at(-1).raw, JSON.stringify(b));
        assert.equal(rows.at(-1).headers['x-fixture'], 'preserved');
        assert.equal(contextAtEncode, undefined); assert.equal(workers, 0);
        assert.deepEqual(fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')).sort() : [], scopesBefore);
      } finally { app.PrivacyCore.configHooks.sealLocal = original; threads.Worker = OriginalWorker; }
    });
    for (const mode of ['basic', 'enhanced', 'strict']) {
      await check('unscoped OFF to ' + mode + ' during before await sends zero bytes', async () => {
        gateway.configure(policy('off')); const start = rows.length;
        const pending = post({ messages: messages(), stream: false }); gateway.configure(policy(mode));
        await assert.rejects(pending, /privacy.policy_changed/); assert.equal(rows.length, start);
      });
    }
    await check('protected to OFF during preparation sends zero bytes', async () => {
      gateway.configure(policy('basic')); const start = rows.length;
      const pending = post({ messages: messages(), stream: false }); gateway.configure(policy('off'));
      await assert.rejects(pending, /privacy.policy_changed/); assert.equal(rows.length, start);
    });
    await check('protected rule revision during preparation sends zero bytes', async () => {
      gateway.configure(policy('basic')); const start = rows.length;
      const pending = gateway.withPolicy('fixture-rule-switch-' + (++serial), () => post({ messages: messages(), stream: false }));
      gateway.configure({ ...policy('basic'), privacyTechnicalV1: true });
      await assert.rejects(pending, /privacy.policy_changed/); assert.equal(rows.length, start);
    });
    await check('unscoped protected request uses auxiliary scope and protects actual bytes', async () => {
      gateway.configure(policy('basic')); const start = rows.length;
      await (await post({ messages: messages(), stream: false })).text();
      assert.equal(rows.length, start + 1); assert.equal(rows.at(-1).raw.includes(secret), false); assert.match(rows.at(-1).raw, /RUYI_PVT/);
    });
    await check('JSON toJSON policy mutation is checked before fetch', async () => {
      gateway.configure(policy('off')); const start = rows.length;
      await assert.rejects(post({ toJSON() { gateway.configure(policy('strict')); return { messages: messages() }; } }), /privacy.policy_changed/);
      assert.equal(rows.length, start);
    });
    await check('mapping persistence failure blocks actual POST', async () => {
      gateway.configure(policy('basic')); const start = rows.length, original = app.PrivacyCore.configHooks.sealLocal;
      app.PrivacyCore.configHooks.sealLocal = async () => { throw Error('synthetic persist failure'); };
      try { await assert.rejects(gateway.withPolicy('fixture-fail-' + (++serial), () => post({ messages: messages(), stream: false })), /synthetic persist failure/); }
      finally { app.PrivacyCore.configHooks.sealLocal = original; }
      assert.equal(rows.length, start);
    });
    await check('existing scope aliases survive unified boundary without changing scope', async () => {
      gateway.configure(policy('basic'));
      await gateway.withPolicy('fixture-alias-' + (++serial), async () => {
        const context = gateway.active(), protectedBody = await gateway.beforeModelRequest({ messages: messages(), stream: false });
        const alias = protectedBody.messages.at(-1).content.match(/\[\[RUYI_PVT:[^\]]+\]\]/)[0];
        await (await post(protectedBody)).text(); assert.equal(gateway.active(), context);
        assert.equal(rows.at(-1).raw.includes(alias), true); assert.equal(rows.at(-1).raw.includes(secret), false);
      });
    });
    await check('already canceled signal sends zero bytes', async () => {
      gateway.configure(policy('off')); const ctrl = new AbortController(); ctrl.abort(); const start = rows.length;
      await assert.rejects(post({ messages: messages() }, ctrl.signal), { name: 'AbortError' }); assert.equal(rows.length, start);
    });
    await check('stream compatibility retry re-enters protection for both actual sends', async () => {
      gateway.configure(policy('basic')); responseMode = 'retry'; const start = rows.length;
      const result = await gateway.withPolicy('fixture-retry-' + (++serial), () => stream({ model: 'fixture-model', messages: messages(), stream: false, stream_options: { include_usage: true } }));
      assert.equal(result.text.includes('synthetic'), true); assert.equal(rows.length, start + 2);
      assert.equal(rows[start].body.stream_options.include_usage, true); assert.equal(rows[start + 1].body.stream_options, undefined);
      for (const row of rows.slice(start)) { assert.equal(row.raw.includes(secret), false); assert.match(row.raw, /RUYI_PVT/); }
    });
    await check('policy switch before compatibility retry prevents the second send', async () => {
      gateway.configure(policy('basic')); switchAfterResponse = true; const start = rows.length;
      await assert.rejects(gateway.withPolicy('fixture-retry-switch-' + (++serial), () => stream({ model: 'fixture-model', messages: messages(), stream: false, stream_options: { include_usage: true } })), /privacy.policy_changed/);
      assert.equal(rows.length, start + 1); assert.equal(rows.at(-1).raw.includes(secret), false);
    });
  } finally {
    if (fake) await fake.close(); fixture.vault.clear();
    assert.equal(path.dirname(root), tempBase);
    fs.rmSync(root, { recursive: true, force: true });
  }
  runner.done();
})().catch(e => { console.error(e); process.exitCode = 1; });
