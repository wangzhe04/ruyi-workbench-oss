'use strict';
// 150 号文 §4 P4 通过标准:用户发 `auth:\n  token: on` 后,第 1 轮与「继续」都到达假 provider,且 data / content /
// function 的拼写不被改写。Generated server functions, real PrivacyGateway, loopback fake provider; synthetic data only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-short-learned-wire-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'providerModelPostOnce', 'providerWireProtocol']);
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
let fake;
const rows = [];
after(async () => {
  if (fake) await fake.close(); f.vault.clear();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-short-learned-wire-')) throw Error('cleanup scope');
  fs.rmSync(root, { recursive: true, force: true });
});
const policy = mode => ({ privacyModeV1: mode, privacyRulesV1: [], privacyTechnicalV1: false, providers: [] });
const tools = [{ type: 'function', function: { name: 'synthetic_lookup', description: 'Look up data on a record',
  parameters: { type: 'object', properties: { data: { type: 'string' }, content: { type: 'string' }, function: { type: 'string' } } } } }];

for (const style of ['chat', 'responses', 'anthropic']) test(style + ': `token: on` turn and its continue both reach the provider unchanged', async () => {
  if (!fake) fake = await startFakeProvider({ handler(ctx) { rows.push(ctx.raw); return textFrames('好的，已看过配置。'); },
    fallback(req, res) { let raw = ''; req.setEncoding('utf8'); req.on('data', part => { raw += part; }); req.on('end', () => { rows.push(raw); res.setHeader('content-type', 'application/json'); res.end('{}'); }); } });
  const provider = { id: 'fixture-' + style, type: 'openai-compat', apiStyle: style, baseUrl: fake.url + '/v1', model: 'fixture-model', apiKey: '', anthropicThinking: 'off', serverWebSearch: false };
  const wire = app.providerWireProtocol(provider);
  const user = 'auth:\n  token: on\n密码：a\n帮我看看这段配置';
  const send = async messages => {
    const body = wire.encodeMessages({ model: 'fixture-model', messages, stream: false, provider, hasTools: true });
    wire.applyTools(body, tools, { serverWebSearch: false });
    const response = await app.providerModelPostOnce({ url: wire.completionUrl(provider.baseUrl), headers: wire.requestHeaders(provider), body });
    await response.text(); assert.equal(response.ok, true);
  };
  app.PrivacyGateway.configure(policy('enhanced'));
  const scopeId = 'short-learned-wire-' + style, before = rows.length;
  await app.PrivacyGateway.withPolicy(scopeId, () => send([{ role: 'user', content: user }]));
  await app.PrivacyGateway.withPolicy(scopeId, () => send([{ role: 'user', content: user }, { role: 'assistant', content: '收到，token 是 on。' }, { role: 'user', content: '继续' }]));
  const received = rows.slice(before);
  assert.equal(received.length, 2, 'both turns reached the fake provider');
  for (const raw of received) {
    assert.ok(raw.includes('token: on'), 'the trivial value is not pseudonymized');
    for (const key of ['"data":', '"content":', '"function":']) assert.ok(raw.includes(key), 'protocol key keeps its spelling: ' + key);
    assert.ok(raw.includes('Look up data on a record'));
    // `密码：a` is still protected in place (one reference), but `a` is not learned: nothing else is rewritten.
    assert.ok(/密码：\[\[RUYI_PVT:CREDENTIAL:[a-f0-9]{32}\]\]/.test(raw), 'the short labelled value is protected where it appears');
    assert.equal((raw.match(/RUYI_PVT:CREDENTIAL/g) || []).length, 1, 'no other occurrence of a short value was rewritten');
  }
  assert.ok(received[1].includes('继续'));
});
