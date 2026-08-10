'use strict';
// E2E: OpenAI 兼容 provider 的自定义请求头 (extraHeaders)。
// 后端 sanitizeProvider 已支持 extraHeaders;本轮补齐前端编辑入口 + 敏感头掩码(与 apiKey 同纪律)。
// 这里只测纯函数掩码往返(确定性,无网络):敏感头下发掩码、保存时还原、非敏感头明文往返、用户改值直通。
const http = require('http');
const { maskSecrets, unmaskSecrets, unmaskProviders, fetchOpenAiModels, normalizeConfig, providerReasoningEffort, applyProviderReasoningEffort } = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

const disk = { providers: [{
  id: 'custom', label: 'Custom', type: 'openai-compat', baseUrl: 'https://api.example.com',
  apiKey: 'sk-secretkey12345',
  extraHeaders: {
    Authorization: 'Bearer tok_secret_9999',  // 敏感:掩码
    'X-API-Key': 'abcdef123456',              // 敏感:掩码
    'X-Organization': 'org-123',              // 非敏感:明文
    'X-Track-Token': 'track-abc',             // 敏感(token):掩码
  },
}] };

// 1) 下发掩码:敏感头值变 ••••末4,非敏感头明文不变;apiKey 仍掩码。
const masked = maskSecrets(disk);
const mh = masked.providers[0].extraHeaders;
ok(mh.Authorization === '••••9999', 'sensitive Authorization header is masked on the way out');
ok(mh['X-API-Key'] === '••••3456', 'sensitive X-API-Key header is masked');
ok(mh['X-Track-Token'] === '••••-abc' || mh['X-Track-Token'] === '••••k-abc' || mh['X-Track-Token'].startsWith('••••'), 'token-named header is masked');
ok(mh['X-Organization'] === 'org-123', 'non-sensitive header stays plaintext in the response');
ok(masked.providers[0].apiKey === '••••2345', 'apiKey masking still works alongside header masking');
ok(!masked.providers[0].extraHeaders.Authorization.includes('tok_secret'), 'masked response does not leak the real token value');

// 2) 保存往返:用户没改这些头(仍是掩码) -> 从磁盘还原真实值。
const echoedBack = { providers: [{ ...masked.providers[0] }] };
const unmasked = unmaskSecrets(echoedBack, disk);
const uh = unmasked.providers[0].extraHeaders;
ok(uh.Authorization === 'Bearer tok_secret_9999', 'untouched masked Authorization restored to real value on save');
ok(uh['X-API-Key'] === 'abcdef123456', 'untouched masked X-API-Key restored');
ok(uh['X-Organization'] === 'org-123', 'non-sensitive header round-trips unchanged');
ok(unmasked.providers[0].apiKey === 'sk-secretkey12345', 'apiKey restored alongside headers');

// 3) 用户改了某个敏感头(新值,非掩码前缀) -> 直通,不用磁盘旧值覆盖。
const edited = { providers: [{ ...masked.providers[0], extraHeaders: {
  ...mh, Authorization: 'Bearer brand-new-token-xyz',
} }] };
const unmasked2 = unmaskSecrets(edited, disk);
ok(unmasked2.providers[0].extraHeaders.Authorization === 'Bearer brand-new-token-xyz', 'user-edited sensitive header passes through (not overwritten by disk value)');
ok(unmasked2.providers[0].extraHeaders['X-API-Key'] === 'abcdef123456', 'other untouched headers still restored when one is edited');

// 4) 无 extraHeaders 的 provider 不报错(存量零回归)。
const noHeaders = maskSecrets({ providers: [{ id: 'plain', apiKey: 'sk-x' }] });
ok(noHeaders.providers[0].extraHeaders === undefined, 'provider without extraHeaders stays without the field');
const unmaskedNo = unmaskSecrets({ providers: [{ id: 'plain', apiKey: '••••sk-x' }] }, { providers: [{ id: 'plain', apiKey: 'real-key-9999' }] });
ok(unmaskedNo.providers[0].apiKey === 'real-key-9999', 'apiKey unmask still works for a provider with no extraHeaders');

// 5) The provider-test route uses unmaskProviders. A masked UI draft must regain its custom auth header.
const testDraft = unmaskProviders([masked.providers[0]], disk.providers)[0];
ok(testDraft.extraHeaders.Authorization === 'Bearer tok_secret_9999', 'provider test restores masked custom auth headers');

// 6) A manually entered multi-model list is preserved as normalized model options.
const manual = normalizeConfig({ providers: [{ id: 'manual', baseUrl: 'http://example.test', models: ['ark-code-latest', 'gpt-4.1'] }] }).config.providers[0];
ok(manual.models.length === 2 && manual.models[0].id === 'ark-code-latest' && manual.models[1].id === 'gpt-4.1', 'manual model IDs normalize into provider model options');

// 7) Reasoning effort uses each OpenAI-compatible API's field name, and omitted means no compatibility risk.
const reasoningProvider = normalizeConfig({ providers: [{ id: 'reasoning', baseUrl: 'http://example.test', reasoningEffort: 'XHIGH' }] }).config.providers[0];
ok(providerReasoningEffort(reasoningProvider) === 'xhigh', 'reasoning effort is normalized and allowlisted');
const chatWithEffort = applyProviderReasoningEffort({ model: 'gpt-5.6-sol' }, reasoningProvider, 'chat');
ok(chatWithEffort.reasoning_effort === 'xhigh' && !Object.prototype.hasOwnProperty.call(chatWithEffort, 'reasoning'), 'Chat Completions sends reasoning_effort');
const responsesWithEffort = applyProviderReasoningEffort({ model: 'gpt-5.6-sol' }, reasoningProvider, 'responses');
ok(responsesWithEffort.reasoning && responsesWithEffort.reasoning.effort === 'xhigh' && !Object.prototype.hasOwnProperty.call(responsesWithEffort, 'reasoning_effort'), 'Responses sends reasoning.effort');
const defaultReasoning = applyProviderReasoningEffort({ model: 'compat-model' }, { reasoningEffort: '' }, 'chat');
ok(!Object.prototype.hasOwnProperty.call(defaultReasoning, 'reasoning_effort'), 'default reasoning effort omits unsupported fields');

// 8) Verify the actual models probe sends a custom Token header on the wire.
async function verifyWireHeader() {
  let received = {};
  const fake = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'header-test-model' }] }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  try {
    const port = fake.address().port;
    const probe = await fetchOpenAiModels({
      id: 'header-test', baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-api-key', extraHeaders: { Token: 'test-token-value' },
    });
    ok(probe.ok === true && probe.models.some(m => m.id === 'header-test-model'), 'models probe succeeds with custom headers');
    ok(received.token === 'test-token-value', 'models probe sends Token header verbatim');
    ok(received.authorization === 'Bearer test-api-key', 'custom Token header coexists with built-in bearer auth');
  } finally {
    await new Promise(resolve => fake.close(resolve));
  }
}

verifyWireHeader().catch(err => {
  failures++;
  console.error('FAIL custom header wire test: ' + (err && err.stack || err));
}).finally(() => {
  console.log('\nPROVIDER CUSTOM HEADERS E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
});
