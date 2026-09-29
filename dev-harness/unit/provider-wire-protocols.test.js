'use strict';
// 58 号方案批 1:服务商线协议登记表(04i PROVIDER_WIRE_PROTOCOLS)与前端协议表(public/js/provider-api-styles.js)。
// 加一种协议应当只要「服务端登记表一项 + 前端一行 + 两份语言包的文案键」,不用满仓找 `apiStyle === 'responses'`。本件钉:
//   [R] 登记表:冻结、键序、每项成员齐全且类型对、id 等于键;前端表键集合 / 键序 / serverWebSearch 与服务端逐一相同,
//       labelKey 在中英两份语言包里都有。
//   [N] 归一:normalizeProviderApiStyle(服务端与前端两份)对一张输入表(三个真协议、缺失、空串、大小写错、未登记的名字、
//       原型链名字、非字符串)的输出与修前 `x === 'responses' ? 'responses' : 'chat'` 逐项相同 —— 批 2 起唯一的差别是
//       'anthropic' 本身被认成 anthropic;providerWireProtocol 认服务商对象与协议值。
//   [M] 各成员金样:端点 / 模型清单 URL、请求头、基础请求体(chat 流式带 stream_options、非流式不带;Responses 的 instructions
//       缺省取首条 system、显式优先、foldSystem 折后插规则、serverItems 接在历史之后)、推理强度字段、工具翻译与服务端搜索映射、
//       输出上限字段名、短补全请求体、非流式回体解码(取字口径、截断与失败判据、用量与响应 id)、落历史字段。
//   [H] 延迟绑定:makeId / redact / 配对自愈经 ProviderWireHooks 由 07 绑好(缺 id 的工具调用拿到 call_<16 hex>、失败详情里的密钥被脱敏)。
//   [G] 结构锁:协议分叉只住 04i 与前端协议表 —— app/src 其余模块与 public 前端里不再有 `=== 'responses'` 比较、
//       respStyle / isResponses 变量,也不再直调 Responses 翻译函数与 04h 的 URL / 请求头原语。
// 流式事件语法的完整语料由 unit/provider-wire-stream.test.js 钉;出站请求体的逐字节形状由 unit/provider-http.test.js 钉(改字、起草)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wire-protocols-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { PROVIDER_WIRE_PROTOCOLS, normalizeProviderApiStyle, providerWireProtocol, providerRequestHeaders } = srv;
const loadFrontend = () => import(pathToFileURL(path.join(app, 'public', 'js', 'provider-api-styles.js')).href);

const MEMBERS = {
  id: 'string', serverWebSearch: 'boolean', outputTokensField: 'string',
  endpointBase: 'function', completionUrl: 'function', modelsUrl: 'function', requestHeaders: 'function',
  encodeMessages: 'function', applyEffort: 'function', applyTools: 'function', encodeQuick: 'function',
  decodeCompletion: 'function', createStreamDecoder: 'function', normalizeUsage: 'function', assistantHistoryFields: 'function',
  retryOn400: 'function',
};
// 修前的三元式,外加批 2 登记的 anthropic(大小写错、带空格的照旧落回 chat)。
const legacyStyle = value => (value === 'responses' ? 'responses' : value === 'anthropic' ? 'anthropic' : 'chat');
const INPUTS = ['chat', 'responses', undefined, null, '', 'Responses', 'RESPONSES', ' responses', 'anthropic', 'Anthropic', 'anthropic ', 'messages', 'openai', 42, true, {}, [],
  'toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

test('[R] 登记表成员齐全、冻结;前端表与服务端逐一相同', async () => {
  assert.ok(Object.isFrozen(PROVIDER_WIRE_PROTOCOLS));
  assert.deepEqual(Object.keys(PROVIDER_WIRE_PROTOCOLS), ['chat', 'responses', 'anthropic'], '登记顺序即设置页下拉顺序');
  for (const [id, entry] of Object.entries(PROVIDER_WIRE_PROTOCOLS)) {
    assert.ok(Object.isFrozen(entry), `${id} 冻结`);
    assert.equal(entry.id, id);
    assert.deepEqual(Object.keys(entry).sort(), Object.keys(MEMBERS).sort(), `${id} 成员齐全`);
    for (const [key, kind] of Object.entries(MEMBERS)) assert.equal(typeof entry[key], kind, `${id}.${key} 是 ${kind}`);
  }
  const fe = await loadFrontend();
  assert.ok(Object.isFrozen(fe.PROVIDER_API_STYLES));
  assert.deepEqual(Object.keys(fe.PROVIDER_API_STYLES), Object.keys(PROVIDER_WIRE_PROTOCOLS), '前端键集合与键序同服务端');
  assert.deepEqual([...fe.PROVIDER_API_STYLE_IDS], Object.keys(PROVIDER_WIRE_PROTOCOLS));
  assert.equal(fe.PROVIDER_API_STYLE_DEFAULT, normalizeProviderApiStyle(undefined));
  const locales = ['zh-CN', 'en-US'].map(l => JSON.parse(fs.readFileSync(path.join(app, 'public', 'locales', l + '.json'), 'utf8')));
  for (const [id, row] of Object.entries(fe.PROVIDER_API_STYLES)) {
    assert.ok(Object.isFrozen(row), `前端 ${id} 冻结`);
    assert.deepEqual(Object.keys(row).sort(), ['id', 'labelKey', 'serverWebSearch']);
    assert.equal(row.id, id);
    assert.equal(row.serverWebSearch, PROVIDER_WIRE_PROTOCOLS[id].serverWebSearch, `${id}.serverWebSearch 两边同值`);
    for (const loc of locales) assert.equal(typeof loc[row.labelKey], 'string', `${row.labelKey} 两份语言包都有`);
  }
});

test('[N] 协议值归一与修前三元式逐项相同(服务端与前端两份)', async () => {
  const fe = await loadFrontend();
  for (const v of INPUTS) {
    assert.equal(normalizeProviderApiStyle(v), legacyStyle(v), `服务端 ${JSON.stringify(v)}`);
    assert.equal(fe.normalizeProviderApiStyle(v), legacyStyle(v), `前端 ${JSON.stringify(v)}`);
    assert.equal(providerWireProtocol({ apiStyle: v }).id, legacyStyle(v), `服务商对象 ${JSON.stringify(v)}`);
    if (typeof v !== 'object' || v === null) assert.equal(providerWireProtocol(v).id, legacyStyle(v), `协议值 ${JSON.stringify(v)}`);
    assert.equal(fe.providerApiStyleMeta(v).id, legacyStyle(v));
  }
  assert.equal(providerWireProtocol(null).id, 'chat');
  assert.equal(providerWireProtocol(undefined).id, 'chat');
  // sanitizeProvider 经同一个归一落盘:缺省与未登记的值都变成 'chat'
  const normalized = srv.normalizeConfig({ providers: [{ id: 'a', apiStyle: 'responses' }, { id: 'b', apiStyle: 'Responses' }, { id: 'c' }] });
  const cfg = normalized.config || normalized;
  assert.deepEqual(cfg.providers.filter(p => ['a', 'b', 'c'].includes(p.id)).map(p => p.apiStyle), ['responses', 'chat', 'chat']);
});

test('[M] 端点、模型清单、请求头', () => {
  const { chat, responses } = PROVIDER_WIRE_PROTOCOLS;
  const bases = [['https://h.x', 'https://h.x/v1', 'https://h.x'], ['https://h.x/v1/', 'https://h.x/v1', 'https://h.x/v1'], ['https://h.x/compatible-mode/v1', 'https://h.x/compatible-mode/v1', 'https://h.x/compatible-mode/v1'], ['', '', '']];
  for (const [base, v1, raw] of bases) {
    assert.equal(chat.endpointBase(base), v1);
    assert.equal(responses.endpointBase(base), raw);
    assert.equal(chat.completionUrl(base), v1 ? v1 + '/chat/completions' : '');
    assert.equal(responses.completionUrl(base), raw ? raw + '/responses' : '');
    assert.equal(chat.modelsUrl(base), v1 ? v1 + '/models' : '');
    assert.equal(responses.modelsUrl(base), v1 ? v1 + '/models' : '', 'Responses 的模型清单照旧在 {v1}/models');
  }
  const provider = { apiKey: ' k ', extraHeaders: { 'X-A': '1' } };
  for (const entry of [chat, responses]) assert.deepEqual(Object.entries(entry.requestHeaders(provider)), Object.entries(providerRequestHeaders(provider)));
});

test('[M] 请求体编码、推理强度、工具、输出上限、短补全', () => {
  const { chat, responses } = PROVIDER_WIRE_PROTOCOLS;
  const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'q' }, { role: 'system', content: ' EXTRA ' }, { role: 'system', content: 'SYS' }];
  assert.equal(JSON.stringify(chat.encodeMessages({ model: 'm', messages, stream: true })),
    JSON.stringify({ model: 'm', messages, stream: true, stream_options: { include_usage: true } }));
  assert.equal(JSON.stringify(chat.encodeMessages({ model: 'm', messages, stream: false, instructions: 'ignored', serverItems: [{ x: 1 }] })),
    JSON.stringify({ model: 'm', messages, stream: false }));
  const userItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] };
  assert.equal(JSON.stringify(responses.encodeMessages({ model: 'm', messages, stream: true })),
    JSON.stringify({ model: 'm', instructions: 'SYS', input: [userItem], stream: true }), 'instructions 缺省取首条 system');
  assert.equal(JSON.stringify(responses.encodeMessages({ model: 'm', messages, stream: false, instructions: 'EXPLICIT', serverItems: [{ type: 'web_search_call', id: 'ws' }] })),
    JSON.stringify({ model: 'm', instructions: 'EXPLICIT', input: [userItem, { type: 'web_search_call', id: 'ws' }], stream: false }), '显式 instructions 优先;服务端工具项接在历史之后');
  assert.equal(responses.encodeMessages({ model: 'm', messages, stream: false, foldSystem: true }).instructions, 'SYS\n\nEXTRA', 'foldSystem 折后插规则(去空白、与首条相同的不重复)');

  const effortChat = chat.applyEffort({ model: 'm' }, 'high');
  const effortResp = responses.applyEffort({ model: 'm' }, 'high');
  assert.deepEqual(effortChat, { model: 'm', reasoning_effort: 'high' });
  assert.deepEqual(effortResp, { model: 'm', reasoning: { effort: 'high' } });
  assert.deepEqual(chat.applyEffort({ model: 'm' }, ''), { model: 'm' });
  assert.deepEqual(srv.applyProviderReasoningEffort({ model: 'm' }, { reasoningEffort: 'low' }, 'responses'), { model: 'm', reasoning: { effort: 'low' } });
  assert.deepEqual(srv.applyProviderReasoningEffort({ model: 'm' }, { reasoningEffort: 'low' }, 'Responses'), { model: 'm', reasoning_effort: 'low' }, '未登记的协议值按缺省 chat');

  const tools = [{ type: 'function', function: { name: 'web_search', description: 'd', parameters: { type: 'object' } } }, { type: 'function', function: { name: 'file_read' } }];
  assert.deepEqual(chat.applyTools({}, tools, { serverWebSearch: true }), { tools, tool_choice: 'auto' });
  assert.deepEqual(responses.applyTools({}, tools, { serverWebSearch: false }), { tools: [
    { type: 'function', name: 'web_search', description: 'd', parameters: { type: 'object' } },
    { type: 'function', name: 'file_read', description: '', parameters: { type: 'object', properties: {} } }], tool_choice: 'auto' });
  assert.deepEqual(responses.applyTools({}, tools, { serverWebSearch: true }).tools[0], { type: 'web_search' }, '服务端搜索只在显式开启时映射');

  assert.equal(chat.outputTokensField, 'max_tokens');
  assert.equal(responses.outputTokensField, 'max_output_tokens');
  const quick = [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: 'U1' }, { role: 'user', content: 'U2' }];
  assert.equal(JSON.stringify(chat.encodeQuick({ model: 'f', messages: quick, plain: false })),
    JSON.stringify({ model: 'f', messages: quick, stream: false, temperature: 0, max_tokens: 400, thinking: { type: 'disabled' }, enable_thinking: false }));
  assert.equal(JSON.stringify(responses.encodeQuick({ model: 'f', messages: quick, plain: true })),
    JSON.stringify({ model: 'f', instructions: 'S1\n\nS2', input: 'U1\nU2', stream: false, max_output_tokens: 400 }));
});

test('[M] 非流式回体解码、用量、落历史字段', () => {
  const { chat, responses } = PROVIDER_WIRE_PROTOCOLS;
  const c = chat.decodeCompletion({ id: 'cc', choices: [{ finish_reason: 'length', message: { content: [{ type: 'text', text: '甲' }, { type: 'image_url' }, { text: '乙' }], reasoning: 'r' } }], usage: { prompt_tokens: 3 } });
  assert.equal(c.text, '甲乙', 'parts 数组拼 text(修前起草会得到 [object Object])');
  assert.equal(c.reasoning, 'r');
  assert.equal(c.finishReason, 'length');
  assert.equal(c.incomplete, true);
  assert.equal(c.incompleteReason, 'length');
  assert.equal(c.failed, false);
  assert.deepEqual(c.usage, { prompt_tokens: 3 });
  assert.equal(c.responseId, 'cc');
  const empty = chat.decodeCompletion(null);
  assert.deepEqual({ text: empty.text, reasoning: empty.reasoning, toolCalls: empty.toolCalls, usage: empty.usage, responseId: empty.responseId, failed: empty.failed, incomplete: empty.incomplete, incompleteReason: empty.incompleteReason },
    { text: '', reasoning: '', toolCalls: [], usage: null, responseId: '', failed: false, incomplete: false, incompleteReason: 'output limit' });

  const r = responses.decodeCompletion({ response: { id: 'rr' }, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'A' }, { type: 'refusal', text: 'NOPE' }, { type: 'input_text', text: 'B' }] }] });
  assert.equal(r.text, 'AB', 'Responses 只取 output_text / input_text');
  assert.equal(r.finishReason, 'length');
  assert.equal(r.incomplete, true);
  assert.equal(r.incompleteReason, 'max_output_tokens');
  assert.equal(r.responseId, 'rr');
  const f = responses.decodeCompletion({ status: 'failed', error: { code: 'server_error' } });
  assert.equal(f.failed, true);
  assert.equal(f.failedDetail, 'server_error');
  assert.equal(f.finishReason, 'error');
  assert.equal(chat.decodeCompletion({ status: 'FAILED', error: 'boom' }).failedDetail, 'boom');

  for (const entry of [chat, responses]) {
    const u = { prompt_tokens: 1 };
    assert.equal(entry.normalizeUsage(u), u, `${entry.id} 用量原样`);
    assert.deepEqual(entry.assistantHistoryFields({ reasoning: '想' }), { reasoning_content: '想' });
    assert.deepEqual(entry.assistantHistoryFields({ reasoning: '' }), {});
  }
});

test('[H] 延迟绑定的环内工具已由 07 填好', () => {
  const { chat, responses } = PROVIDER_WIRE_PROTOCOLS;
  const calls = chat.decodeCompletion({ choices: [{ message: { tool_calls: [{ function: { name: 'file_read' } }] } }] }).toolCalls;
  assert.match(calls[0].id, /^call_[0-9a-f]{16}$/, 'makeId');
  const dec = responses.createStreamDecoder({ onEvent: () => {}, markUsage: () => {} });
  const fake = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
  assert.equal(dec.feed({ type: 'response.failed', response: { error: { message: 'bad ' + fake } } }), true);
  assert.equal(dec.finish().httpError, 'Responses failed: bad «redacted»', 'redact');
  // 配对自愈:结尾缺 function_call_output 的 function_call 补一条合成结果(调用方的历史数组不动)
  const history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] }];
  const items = srv.buildResponsesInputItems(history);
  assert.equal(history.length, 2);
  assert.ok(items.some(i => i.type === 'function_call_output' && i.call_id === 'c1'), 'repairProviderHistoryPairing');
});

test('[G] 协议分叉只住 04i 与前端协议表', () => {
  const srcDir = path.join(app, 'src');
  const hits = [];
  const scan = (file, text, rules) => {
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const [label, re] of rules) if (re.test(code)) hits.push(`${file}:${i + 1} ${label}: ${line.trim().slice(0, 120)}`);
    });
  };
  const backendRules = [
    ['与协议字面量比较', /===?\s*'responses'|'responses'\s*===?/],
    ['协议布尔变量', /\b(?:respStyle|isResponses|subApiStyle)\b/],
    ['直调 Responses 翻译', /\b(?:buildResponsesInputItems|toResponsesTools|toResponsesContent)\s*\(/],
    ['直调 04h URL / 请求头原语', /\b(?:providerCompletionUrl|providerApiBase|providerResponsesBase|providerRequestHeaders)\s*\(/],
  ];
  for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
    if (file === '04h-provider-http.js' || file === '04i-provider-wire.js') continue;
    scan(file, fs.readFileSync(path.join(srcDir, file), 'utf8'), backendRules);
  }
  const frontendRules = [['与协议字面量比较', /apiStyle\s*===?\s*'|===?\s*'responses'/]];
  const pub = path.join(app, 'public');
  for (const file of [...fs.readdirSync(path.join(pub, 'js')).filter(f => f.endsWith('.js')).map(f => path.join('js', f)), 'app.js']) {
    if (file === path.join('js', 'provider-api-styles.js')) continue;
    scan(file, fs.readFileSync(path.join(pub, file), 'utf8'), frontendRules);
  }
  assert.deepEqual(hits, []);
});
