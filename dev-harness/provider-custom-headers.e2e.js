'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E: OpenAI 兼容 provider 的自定义请求头 (extraHeaders)。
// 后端 sanitizeProvider 已支持 extraHeaders;本轮补齐前端编辑入口 + 敏感头掩码(与 apiKey 同纪律)。
// 这里只测纯函数掩码往返(确定性,无网络):敏感头下发掩码、保存时还原、非敏感头明文往返、用户改值直通。
const http = require('http');
const { maskSecrets, unmaskSecrets, unmaskProviders, fetchOpenAiModels, normalizeConfig, providerReasoningEffort, applyProviderReasoningEffort,
  maskedSecretConflicts, providerLaunchVectorKey, safeUrlForDisplay } = require('../ruyi-workbench/app/server.js');

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 9) 107-S2(46 号文 §5 ⑦b M5):掩码还原的【启动向量闸】。
//    修前 providers 段只按 id 配对:同一次保存里把 baseUrl 换掉、apiKey 仍回传掩码,真 key 就被贴到
//    新端点上。主端点每回合都用,所以这一格比 S0b 已经关掉的 MCP 那一格更要命。
//    判据:这次保存【没有把密钥送去任何新地址】(地址集合 = baseUrl ∪ (audioBaseUrl||baseUrl) ∪ extraBaseUrls
//    的子集),回传的掩码才算「用户没动它」。收窄(删地址、清空 audioBaseUrl 让它回落)不算变化 ——
//    剩下的每一个地址原本就在收这份密钥。
//    假值全部运行时拼出(repo-hygiene (b) 的全仓明文扫描不误报),失败信息只打前 6 个字符。
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const head = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 6) + (v.length > 6 ? '…' : '')) : String(v));
  const REAL = 'sk-' + 'S2Vector' + 'Fake' + '1234';
  const HDR = 'Bearer ' + 'tokS2' + 'Fake' + '9999';
  const disk2 = { providers: [{
    id: 'vec', label: 'Vec', type: 'openai-compat',
    baseUrl: 'https://api.vec.test/v1', audioBaseUrl: 'https://asr.vec.test/v1', extraBaseUrls: ['https://bk.vec.test/v1'],
    apiKey: REAL, extraHeaders: { Authorization: HDR, 'X-Organization': 'org-9' },
  }] };
  const shown = maskSecrets(disk2).providers[0];
  const echo = extra => ({ providers: [{ ...JSON.parse(JSON.stringify(shown)), ...extra }] });

  // (a) 地址一个没变 → 照常还原(这是绝大多数保存走的那一条)。
  const keptR = unmaskSecrets(echo({}), disk2).providers[0];
  ok(keptR.apiKey === REAL && keptR.extraHeaders.Authorization === HDR, 'S2-a unchanged launch vector still restores key + sensitive header (got ' + head(keptR.apiKey) + ')');
  ok(maskedSecretConflicts(echo({}), disk2).length === 0, 'S2-a unchanged launch vector reports no conflict');

  // (b) 改 baseUrl:密钥【不跟过去】。兜底是清空,写口另有整份拒绝(见下面的 conflicts)。
  const movedBase = unmaskSecrets(echo({ baseUrl: 'https://evil.vec.test/v1' }), disk2).providers[0];
  ok(movedBase.apiKey === '' && movedBase.extraHeaders.Authorization === '',
    'S2-b changed baseUrl → masked key/header NOT re-attached (key ' + head(movedBase.apiKey) + ', header ' + head(movedBase.extraHeaders.Authorization) + ')');
  const cb = maskedSecretConflicts(echo({ baseUrl: 'https://evil.vec.test/v1' }), disk2);
  ok(cb.length === 1 && cb[0].reason === 'endpoint_changed' && cb[0].id === 'vec'
    && cb[0].fields.includes('apiKey') && cb[0].fields.includes('extraHeaders.Authorization'),
    'S2-b the conflict names the provider and both masked fields (got ' + JSON.stringify(cb) + ')');

  // (c) audioBaseUrl 与 extraBaseUrls 同属启动向量:前者是 ASR 转写端点(同一份 apiKey),后者是
  //     streamWithFailover 逐个试的备用端点(每一个都带同一个 Authorization)。
  ok(maskedSecretConflicts(echo({ audioBaseUrl: 'https://evil-asr.vec.test/v1' }), disk2)[0].reason === 'endpoint_changed', 'S2-c changed audioBaseUrl counts as a vector change');
  ok(maskedSecretConflicts(echo({ extraBaseUrls: [...shown.extraBaseUrls, 'https://evil-bk.vec.test/v1'] }), disk2)[0].reason === 'endpoint_changed',
    'S2-c an ADDED extraBaseUrls entry counts as a vector change (failover sends the same key there)');
  // 【收窄】不拒:删掉一个备用端点、或把 audioBaseUrl 清空(它回落到 baseUrl,本来就在集合里),
  // 剩下的每一个地址原本就在收这份密钥 —— 收窄不可能把密钥送到新地方。
  ok(unmaskSecrets(echo({ extraBaseUrls: [] }), disk2).providers[0].apiKey === REAL && maskedSecretConflicts(echo({ extraBaseUrls: [] }), disk2).length === 0,
    'S2-c REMOVING an extraBaseUrls entry is a NARROWING and still restores (got ' + head(unmaskSecrets(echo({ extraBaseUrls: [] }), disk2).providers[0].apiKey) + ')');
  ok(unmaskSecrets(echo({ audioBaseUrl: '' }), disk2).providers[0].apiKey === REAL && maskedSecretConflicts(echo({ audioBaseUrl: '' }), disk2).length === 0,
    'S2-c clearing audioBaseUrl falls back to baseUrl(已在集合里)→ 仍然还原(asr-transcribe F1 的形状)');
  ok(unmaskSecrets(echo({ baseUrl: 'https://asr.vec.test/v1' }), disk2).providers[0].apiKey === REAL,
    'S2-c 把 baseUrl 换成【本来就在集合里的另一个地址】也算收窄(不新增地址即可)');
  ok(providerLaunchVectorKey(disk2.providers[0]) === providerLaunchVectorKey(shown), 'S2-c the masked echo has the same launch-vector key as disk (URL 脱敏只在真有凭据时才改串)');

  // (d) 真填了新明文:改不改地址都照存(掩码闸只咬掩码)。
  const NEWKEY = 'sk-' + 'S2Rotated' + '0987';
  const rotated = unmaskSecrets(echo({ baseUrl: 'https://new.vec.test/v1', apiKey: NEWKEY }), disk2).providers[0];
  ok(rotated.apiKey === NEWKEY && rotated.baseUrl === 'https://new.vec.test/v1', 'S2-d a new plaintext key with a changed baseUrl is stored (got ' + head(rotated.apiKey) + ')');
  // 换端点时【每一个】掩码都要重填:只重填 apiKey、把敏感头留着掩码,照样拒绝(那个头也是一份凭据)。
  const halfRotated = maskedSecretConflicts(echo({ baseUrl: 'https://new.vec.test/v1', apiKey: NEWKEY }), disk2);
  ok(halfRotated.length === 1 && JSON.stringify(halfRotated[0].fields) === JSON.stringify(['extraHeaders.Authorization']),
    'S2-d re-typing only the key while a sensitive header stays masked is still refused (fields ' + JSON.stringify(halfRotated.map(c => c.fields)) + ')');
  const fullRotated = echo({ baseUrl: 'https://new.vec.test/v1', apiKey: NEWKEY, extraHeaders: { Authorization: 'Bearer ' + 'newS2' + 'Fake' + '1122', 'X-Organization': 'org-9' } });
  ok(maskedSecretConflicts(fullRotated, disk2).length === 0, 'S2-d a new plaintext key + header with a changed baseUrl is NOT refused');
  ok(unmaskSecrets(fullRotated, disk2).providers[0].apiKey === NEWKEY, 'S2-d …and it lands as typed');
  ok(unmaskSecrets(echo({ apiKey: '' }), disk2).providers[0].apiKey === '' && maskedSecretConflicts(echo({ apiKey: '' }), disk2).length === 0,
    'S2-d an explicitly emptied key clears without a refusal (这是「我就是要删掉密钥」的走法)');

  // (e) 新 id / 改了 id 带着别人的掩码 → 没有可还原的真值,同样拒绝(不静默存成空)。
  const cn = maskedSecretConflicts(echo({ id: 'vec-copy' }), disk2);
  ok(cn.length === 1 && cn[0].reason === 'no_match', 'S2-e a masked key on an id that is not on disk is refused as no_match (got ' + JSON.stringify(cn.map(c => c.reason)) + ')');

  // (f) /api/provider/test 走的 unmaskProviders 是同一道闸 —— 那条路会【当场把还原出来的 key 发出去】。
  ok(unmaskProviders([{ ...shown }], disk2.providers)[0].apiKey === REAL, 'S2-f provider test restores the key when the endpoint is unchanged');
  ok(unmaskProviders([{ ...shown, baseUrl: 'https://evil.vec.test/v1' }], disk2.providers)[0].apiKey === '',
    'S2-f provider test does NOT hand the real key to a changed baseUrl (got ' + head(unmaskProviders([{ ...shown, baseUrl: 'https://evil.vec.test/v1' }], disk2.providers)[0].apiKey) + ')');

  // (g) searchBackend(向量 = type + baseUrl)与 modelsApiKey(向量 = modelsApiBase)同一条规则。
  const SB = 'sb-' + 'S2Fake' + '5566', MK = 'mk-' + 'S2Fake' + '7788';
  const disk3 = { searchBackend: { type: 'tavily', baseUrl: 'https://s.vec.test', apiKey: SB }, modelsApiBase: 'https://cli.vec.test', modelsApiKey: MK };
  const m3 = maskSecrets(disk3);
  ok(unmaskSecrets({ searchBackend: { ...m3.searchBackend } }, disk3).searchBackend.apiKey === SB, 'S2-g searchBackend key restored when type+baseUrl unchanged');
  ok(unmaskSecrets({ searchBackend: { ...m3.searchBackend, baseUrl: 'https://evil.vec.test' } }, disk3).searchBackend.apiKey === '', 'S2-g changed search baseUrl → key not re-attached');
  ok(maskedSecretConflicts({ searchBackend: { ...m3.searchBackend, baseUrl: 'https://evil.vec.test' } }, disk3)[0].scope === 'searchBackend', 'S2-g the search conflict is reported');
  ok(unmaskSecrets({ modelsApiKey: m3.modelsApiKey }, disk3).modelsApiKey === MK, 'S2-g modelsApiKey restored when the patch does not touch modelsApiBase');
  ok(unmaskSecrets({ modelsApiKey: m3.modelsApiKey, modelsApiBase: 'https://evil-cli.vec.test' }, disk3).modelsApiKey === '', 'S2-g changed modelsApiBase → modelsApiKey not re-attached');
  ok(maskedSecretConflicts({ modelsApiKey: m3.modelsApiKey, modelsApiBase: 'https://evil-cli.vec.test' }, disk3)[0].id === 'modelsApiKey', 'S2-g the Claude-CLI endpoint conflict is reported');

  // (h) 最后一道闸:掩码【永远】到不了磁盘 —— normalizeConfig 每次读写都过 sanitizeProvider。
  const survived = normalizeConfig({ providers: [{ id: 'vec', baseUrl: 'https://api.vec.test/v1', apiKey: '••••1234', extraHeaders: { Authorization: '••••9999' } }] }).config.providers[0];
  ok(survived.apiKey === '' && survived.extraHeaders.Authorization === '', 'S2-h a mask that reaches sanitizeProvider is cleared, never persisted (key ' + head(survived.apiKey) + ')');
  const surv2 = normalizeConfig({ modelsApiBase: 'https://cli.vec.test?api_key=••••cdef', modelsApiKey: '••••7788', searchBackend: { type: 'tavily', baseUrl: 'https://s.vec.test?token=••••abcd', apiKey: '••••5566' } }).config;
  ok(surv2.modelsApiBase === '' && surv2.modelsApiKey === '' && surv2.searchBackend.baseUrl === '' && surv2.searchBackend.apiKey === '',
    'S2-h the same last-line clear covers modelsApi*/searchBackend (masked URL and masked key alike)');

  // (i) 107-S2 L3:URL 里的凭据只在【显示面】脱敏,而且没有凭据的地址一个字节都不变(否则原样回传
  //     会被当成「换了端点」而被拒)。
  ok(safeUrlForDisplay('https://api.vec.test/v1') === 'https://api.vec.test/v1', 'S2-i a credential-free URL is returned byte-identical (no trailing-slash normalization)');
  ok(safeUrlForDisplay('https://u:p@api.vec.test/v1') === 'https://api.vec.test/v1', 'S2-i userinfo is stripped, scheme/host/path stay visible');
  ok(safeUrlForDisplay('https://api.vec.test/v1?api_key=ABCDEFGH&model=m1') === 'https://api.vec.test/v1?api_key=••••EFGH&model=m1',
    'S2-i credential query values are masked, non-credential ones stay (got ' + safeUrlForDisplay('https://api.vec.test/v1?api_key=ABCDEFGH&model=m1') + ')');
  const diskUrl = { providers: [{ id: 'u', baseUrl: 'https://api.vec.test/v1?api_key=ABCDEFGH', apiKey: REAL }] };
  const shownUrl = maskSecrets(diskUrl).providers[0];
  ok(!JSON.stringify(shownUrl).includes('ABCDEFGH'), 'S2-i the display copy carries no plaintext URL credential');
  ok(unmaskSecrets({ providers: [{ ...shownUrl }] }, diskUrl).providers[0].baseUrl === 'https://api.vec.test/v1?api_key=ABCDEFGH',
    'S2-i a masked URL echoed back is restored to the real one on save');
  const badUrl = maskedSecretConflicts({ providers: [{ ...shownUrl, baseUrl: 'https://evil.vec.test/v1?api_key=••••EFGH' }] }, diskUrl);
  ok(badUrl.length === 1 && badUrl[0].reason === 'masked_url', 'S2-i a HALF-edited masked URL is refused, never written (got ' + JSON.stringify(badUrl.map(c => c.reason)) + ')');
}

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
