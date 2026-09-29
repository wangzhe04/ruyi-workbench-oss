'use strict';
// 58 号方案批 2:Anthropic Messages 表项(PROVIDER_WIRE_PROTOCOLS.anthropic,编解码在 04i-provider-anthropic.js)的金样。
//   [A1] 端点与鉴权头:{v1}/messages;anthropic-version;auto = 官方主机只发 x-api-key、其它主机两个都发;显式 x-api-key / bearer;extraHeaders 最后覆盖。
//   [A2] 请求编码:顶层 system;后插 system → <system-reminder> user 文本;连续 tool 结果合成一条 user,tool_result 排在截图之前;
//        相邻同角色合并;首条补 user;参数坏 JSON → {};id 清洗两边一致;图片 data URI / http;空文本不出块;max_tokens 必填;
//        思考方式(模型名 auto、adaptive / off 覆盖);不带 stream_options。
//   [A3] 思考块回放:只回放最后一条 user 之后那段 assistant 的 providerBlocks;换模型、tool_use id 对不上都不回放;更早的只发文本与 tool_use。
//   [A3b] 这一发不带 tools(摘要 / 起草 / 去工具重打):tool_use / tool_result 改写成文字(Messages 不收没有 tools 定义的工具块),也不回放思考块。
//   [A4] 推理强度、工具、短补全。
//   [A5] 非流式解码:文本 / 思考 / 工具、stop_reason 映射、拒答与错误、用量归一、providerBlocks 只在有思考块时带。
//   [A6] 流式解码:思考 + 签名、文本、并行 tool_use 的 input_json_delta、用量只报一次、块序;流内 error 在吐内容前后两种口径;拒答。
//   [A7] 400 兼容重打:签名失配去掉全部思考块;网关不认的参数去掉点名的那个;无关 400 不重打。
//   [A8] 用量归一、落历史字段、529 走瞬时重试、sanitizeProvider 的两个能力项(空不落字段)、模型清单的 max_input_tokens。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wire-anthropic-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const wire = srv.PROVIDER_WIRE_PROTOCOLS.anthropic;

const OFFICIAL = { id: 'a', apiKey: ' sk-ant-test ', baseUrl: 'https://api.anthropic.com', apiStyle: 'anthropic' };
const GATEWAY = { id: 'g', apiKey: 'gw-key', baseUrl: 'https://gw.example.cn/anthropic/', apiStyle: 'anthropic' };

test('[A1] 端点与鉴权头', () => {
  assert.equal(wire.completionUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(wire.completionUrl('https://gw.example.cn/anthropic/'), 'https://gw.example.cn/anthropic/v1/messages');
  assert.equal(wire.completionUrl('https://gw.example.cn/v1'), 'https://gw.example.cn/v1/messages');
  assert.equal(wire.completionUrl(''), '');
  assert.equal(wire.modelsUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/models');
  assert.equal(wire.endpointBase('https://gw.example.cn/anthropic/'), 'https://gw.example.cn/anthropic/v1');
  assert.deepEqual(wire.requestHeaders(OFFICIAL), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-test' });
  assert.deepEqual(wire.requestHeaders(GATEWAY), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'gw-key', authorization: 'Bearer gw-key' });
  assert.deepEqual(wire.requestHeaders({ ...GATEWAY, anthropicAuth: 'bearer' }), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer gw-key' });
  assert.deepEqual(wire.requestHeaders({ ...GATEWAY, anthropicAuth: 'x-api-key' }), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'gw-key' });
  assert.deepEqual(wire.requestHeaders({ ...GATEWAY, apiKey: '' }), { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, '空 key(keyOptional 端点)不带鉴权头');
  const h = wire.requestHeaders({ ...OFFICIAL, extraHeaders: { 'anthropic-beta': 'x-1', 'x-api-key': 'override' } });
  assert.equal(h['anthropic-beta'], 'x-1');
  assert.equal(h['x-api-key'], 'override', 'extraHeaders 最后覆盖');
  // 主机名判定不被路径 / userinfo 骗过
  assert.ok('authorization' in wire.requestHeaders({ ...GATEWAY, baseUrl: 'https://proxy.example/api.anthropic.com' }));
  assert.ok('authorization' in wire.requestHeaders({ ...GATEWAY, baseUrl: 'https://api.anthropic.com.evil.example' }));
  assert.ok(!('authorization' in wire.requestHeaders({ ...GATEWAY, baseUrl: 'HTTPS://API.ANTHROPIC.COM/' })));
});

const SCREEN = 'data:image/png;base64,iVBORw0KGgo=';
function sampleHistory() {
  return [
    { role: 'system', content: 'STABLE SYSTEM' },
    { role: 'user', content: '读一下两个文件' },
    { role: 'assistant', content: '好的', tool_calls: [
      { id: 'call.1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
      { id: 'call_2', type: 'function', function: { name: 'file_read', arguments: '{not json' } },
    ] },
    { role: 'tool', tool_call_id: 'call.1', content: 'A 内容' },
    { role: 'tool', tool_call_id: 'call_2', content: '' },
    { role: 'user', content: [{ type: 'text', text: '截图如下' }, { type: 'image_url', image_url: { url: SCREEN } }] },
    { role: 'system', content: '[压缩标记] 以上为摘要' },
    { role: 'user', content: [{ type: 'text', text: '   ' }, { type: 'image_url', image_url: 'https://img.example/x.png' }] },
  ];
}

test('[A2] 请求编码', () => {
  const b = wire.encodeMessages({ model: 'glm-4.6', messages: sampleHistory(), stream: true, provider: GATEWAY, hasTools: true });
  assert.deepEqual(Object.keys(b), ['model', 'max_tokens', 'system', 'messages', 'stream']);
  assert.equal(b.max_tokens, 32000);
  assert.equal(b.system, 'STABLE SYSTEM');
  assert.equal(b.stream, true);
  assert.ok(!('stream_options' in b) && !('thinking' in b), '非 Claude 模型缺省不发 thinking;不带 stream_options');
  assert.deepEqual(b.messages, [
    { role: 'user', content: [{ type: 'text', text: '读一下两个文件' }] },
    { role: 'assistant', content: [
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'call_1', name: 'file_read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_2', name: 'file_read', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'A 内容' },
      { type: 'tool_result', tool_use_id: 'call_2', content: '(空)' },
      { type: 'text', text: '截图如下' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: '<system-reminder>\n[压缩标记] 以上为摘要\n</system-reminder>' },
      { type: 'image', source: { type: 'url', url: 'https://img.example/x.png' } },
    ] },
  ]);
  const nb = wire.encodeMessages({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'S' }, { role: 'assistant', content: '上次说到' }], stream: false, instructions: 'EXPLICIT', provider: OFFICIAL });
  assert.equal(nb.max_tokens, 8192);
  assert.equal(nb.system, 'EXPLICIT', '显式 instructions 优先');
  assert.equal(nb.stream, false);
  assert.deepEqual(nb.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, '官方主机带 drop_block');
  assert.deepEqual(nb.messages.map(m => m.role), ['user', 'assistant', 'user'], '首条补 user、末条不留 assistant(不预填)');
  // 思考方式:模型名 auto;显式覆盖
  const think = (model, provider) => wire.encodeMessages({ model, messages: [{ role: 'user', content: 'hi' }], stream: true, provider }).thinking;
  assert.ok(think('claude-sonnet-4-6', GATEWAY));
  assert.ok(think('claude-fable-5-1', GATEWAY));
  assert.ok(think('anthropic/claude-sonnet-5-5', GATEWAY), '中转商加前缀的名字也认');
  assert.equal(think('claude-sonnet-4-5', GATEWAY), undefined, '4.5 及更早不认 adaptive');
  assert.equal(think('claude-haiku-4-5', GATEWAY), undefined);
  assert.equal(think('claude-sonnet-4-20250514', GATEWAY), undefined, '日期后缀不当次版本号');
  assert.equal(think('kimi-k2', GATEWAY), undefined);
  assert.deepEqual(think('kimi-k2', { ...GATEWAY, anthropicThinking: 'adaptive' }), { type: 'adaptive', display: 'summarized' });
  assert.equal(think('claude-opus-5-5', { ...OFFICIAL, anthropicThinking: 'off' }), undefined);
  // 没有 system 时不发空 system
  assert.ok(!('system' in wire.encodeMessages({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true })));
  // 缺 tool_result 的 tool_use 由配对自愈补上合成结果(只改副本)
  const hist = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'shell', arguments: '{}' } }] }, { role: 'user', content: '算了' }];
  const before = JSON.stringify(hist);
  const paired = wire.encodeMessages({ model: 'm', messages: hist, stream: true, hasTools: true });
  assert.equal(JSON.stringify(hist), before, '调用方历史不被改');
  assert.equal(paired.messages[2].content[0].type, 'tool_result');
  assert.equal(paired.messages[2].content[0].tool_use_id, 'call_x');
});

const THINK = { type: 'thinking', thinking: '先读 a', signature: 'SIG-1' };
function withBlocks(model) {
  return [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '第一轮答', reasoning_content: 'old', providerBlocks: { protocol: 'anthropic', model, blocks: [{ type: 'thinking', thinking: 'old', signature: 'SIG-0' }, { type: 'text', text: '第一轮答' }] } },
    { role: 'user', content: '第二轮' },
    { role: 'assistant', content: '', reasoning_content: '先读 a', tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'file_read', arguments: '{"path":"a"}' } }],
      providerBlocks: { protocol: 'anthropic', model: 'claude-opus-5-5-20260901', requestModel: model, blocks: [THINK, { type: 'tool_use', id: 'toolu_01', name: 'file_read', input: { path: 'a' } }] } },
    { role: 'tool', tool_call_id: 'toolu_01', content: 'A' },
  ];
}

test('[A3] 思考块回放', () => {
  const b = wire.encodeMessages({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'S' }, ...withBlocks('claude-opus-5-5')], stream: true, provider: OFFICIAL, hasTools: true });
  assert.deepEqual(b.messages[1].content, [{ type: 'text', text: '第一轮答' }], '最后一条 user 之前的思考块不回放(leading run 丢掉)');
  assert.deepEqual(b.messages[3].content, [THINK, { type: 'tool_use', id: 'toolu_01', name: 'file_read', input: { path: 'a' } }], '当前工具循环的内容块原样回放(认 requestModel)');
  assert.notEqual(b.messages[3].content[0], THINK, '回放的是副本');
  const other = wire.encodeMessages({ model: 'claude-sonnet-5-5', messages: withBlocks('claude-opus-5-5'), stream: true, provider: OFFICIAL, hasTools: true });
  assert.deepEqual(other.messages[3].content.map(x => x.type), ['tool_use'], '换模型不回放');
  const h = withBlocks('claude-opus-5-5');
  h[3].tool_calls[0].id = 'toolu_99';
  h[4].tool_call_id = 'toolu_99';
  const mismatch = wire.encodeMessages({ model: 'claude-opus-5-5', messages: h, stream: true, provider: OFFICIAL, hasTools: true });
  assert.deepEqual(mismatch.messages[3].content.map(x => x.type), ['tool_use'], 'tool_use id 对不上不回放');
  const notOurs = withBlocks('claude-opus-5-5');
  notOurs[3].providerBlocks.protocol = 'responses';
  assert.deepEqual(wire.encodeMessages({ model: 'claude-opus-5-5', messages: notOurs, stream: true, hasTools: true }).messages[3].content.map(x => x.type), ['tool_use']);
});

test('[A3b] 不带 tools 的请求:工具块改写成文字,不回放思考块', () => {
  for (const hasTools of [false, undefined]) {
    const b = wire.encodeMessages({ model: 'claude-opus-5-5', messages: [...withBlocks('claude-opus-5-5'), { role: 'user', content: '请总结' }], stream: false, provider: OFFICIAL, hasTools });
    const blocks = b.messages.flatMap(m => m.content);
    assert.ok(blocks.every(x => x.type === 'text'), `hasTools=${hasTools}:只剩文本块(${JSON.stringify(blocks.map(x => x.type))})`);
    assert.ok(blocks.some(x => x.text === '[调用工具 file_read] {"path":"a"}'));
    assert.ok(blocks.some(x => x.text === '[工具结果 toolu_01]\nA'));
    assert.deepEqual(b.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user'], '改写后角色照样交替');
  }
});

test('[A4] 推理强度、工具、短补全', () => {
  const eff = e => wire.applyEffort({ output_config: { keep: 1 } }, e);
  assert.deepEqual(eff('high'), { output_config: { keep: 1, effort: 'high' } });
  assert.deepEqual(eff('minimal').output_config.effort, 'low');
  assert.deepEqual(eff('none').output_config.effort, 'low');
  assert.deepEqual(eff('xhigh').output_config.effort, 'xhigh');
  assert.deepEqual(eff(''), { output_config: { keep: 1 } });
  assert.deepEqual(eff('turbo'), { output_config: { keep: 1 } }, '不认的档位不写');
  const withTools = wire.applyTools({}, [
    { type: 'function', function: { name: 'file_read', description: '读', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'web_search' } },
    { type: 'function', function: {} },
  ], { serverWebSearch: true });
  assert.deepEqual(withTools, {
    tools: [
      { name: 'file_read', description: '读', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'web_search', description: '', input_schema: { type: 'object', properties: {} } },
    ],
    tool_choice: { type: 'auto' },
  });
  assert.equal(wire.outputTokensField, 'max_tokens');
  assert.equal(wire.serverWebSearch, false);
  assert.deepEqual(wire.encodeQuick({ model: 'm', messages: [{ role: 'system', content: 'FIX' }, { role: 'user', content: '句子' }] }),
    { model: 'm', max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'text', text: '句子' }] }], stream: false, system: 'FIX', output_config: { effort: 'low' } });
  assert.ok(!('output_config' in wire.encodeQuick({ model: 'm', messages: [{ role: 'user', content: 'x' }], plain: true })));
});

test('[A5] 非流式解码', () => {
  const d = wire.decodeCompletion({
    id: 'msg_1', type: 'message', model: 'claude-opus-5-5', stop_reason: 'tool_use',
    content: [THINK, { type: 'text', text: '我先读' }, { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: 'a' } }],
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
  }, { requestModel: 'claude-opus-5-5' });
  assert.equal(d.text, '我先读');
  assert.equal(d.reasoning, '先读 a');
  assert.deepEqual(d.toolCalls, [{ id: 'toolu_1', name: 'file_read', rawArgs: '{"path":"a"}' }]);
  assert.equal(d.finishReason, 'tool_calls');
  assert.equal(d.incomplete, false);
  assert.equal(d.failed, false);
  assert.equal(d.responseId, 'msg_1');
  assert.deepEqual([d.usage.prompt_tokens, d.usage.completion_tokens, d.usage.total_tokens, d.usage.prompt_tokens_details.cached_tokens, d.usage.input_tokens], [115, 7, 122, 100, 10]);
  assert.deepEqual(d.providerBlocks, { protocol: 'anthropic', model: 'claude-opus-5-5', requestModel: 'claude-opus-5-5', blocks: [THINK, { type: 'text', text: '我先读' }, { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: 'a' } }] });
  const plain = wire.decodeCompletion({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
  assert.equal(plain.finishReason, 'stop');
  assert.ok(!('providerBlocks' in plain), '没有思考块就不带 providerBlocks');
  const cut = wire.decodeCompletion({ content: [{ type: 'text', text: '半' }], stop_reason: 'max_tokens' });
  assert.equal(cut.incomplete, true);
  assert.equal(cut.finishReason, 'length');
  const refused = wire.decodeCompletion({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' } });
  assert.equal(refused.failed, true);
  assert.equal(refused.failedDetail, 'Anthropic refusal (cyber): no');
  const err = wire.decodeCompletion({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
  assert.equal(err.failed, true);
  assert.equal(err.failedDetail, 'bad');
  assert.equal(wire.decodeCompletion(null).text, '');
});

function runStream(events, requestModel) {
  const seen = [];
  const usages = [];
  const dec = wire.createStreamDecoder({ onEvent: e => seen.push(e), markUsage: u => usages.push(u), requestModel });
  let terminal = false;
  for (const e of events) { terminal = dec.feed(e); if (terminal) break; }
  return { out: dec.finish(), seen, usages, terminal };
}

test('[A6] 流式解码', () => {
  const { out, seen, usages, terminal } = runStream([
    { type: 'message_start', message: { id: 'msg_s', model: 'claude-opus-5-5', usage: { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '一想' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '两个一起读' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_a', name: 'file_read', input: {} } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_b', name: 'file_read', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
    { type: 'message_start', message: { id: 'ignored-after-stop' } },
  ], 'claude-opus-5-5');
  assert.equal(terminal, true, 'message_stop 终止流');
  assert.deepEqual(seen, [{ type: 'thinking_delta', text: '想' }, { type: 'thinking_delta', text: '一想' }, { type: 'assistant_delta', text: '两个一起读' }]);
  assert.equal(out.text, '两个一起读');
  assert.equal(out.reasoning, '想一想');
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.providerResponseId, 'msg_s');
  assert.deepEqual(out.toolCalls, [{ id: 'toolu_a', name: 'file_read', rawArgs: '{"path":"a"}' }, { id: 'toolu_b', name: 'file_read', rawArgs: '{"path":"b"}' }], '并行 tool_use 按 index 各自拼参数');
  assert.equal(usages.length, 1, '用量只报一次');
  assert.deepEqual([usages[0].prompt_tokens, usages[0].completion_tokens, usages[0].prompt_tokens_details.cached_tokens], [320, 42, 300]);
  assert.deepEqual(out.providerBlocks, { protocol: 'anthropic', model: 'claude-opus-5-5', requestModel: 'claude-opus-5-5', blocks: [
    { type: 'thinking', thinking: '想一想', signature: 'SIG-A' },
    { type: 'text', text: '两个一起读' },
    { type: 'tool_use', id: 'toolu_a', name: 'file_read', input: { path: 'a' } },
    { type: 'tool_use', id: 'toolu_b', name: 'file_read', input: { path: 'b' } },
  ] });
  assert.ok(!('httpError' in out));
  // 流内 error:还没吐内容 → HTTP 529(走瞬时重试);吐过内容 → 不带状态码
  const early = runStream([{ type: 'message_start', message: { id: 'm' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  assert.equal(early.terminal, true);
  assert.equal(early.out.httpError, 'HTTP 529: overloaded_error: Overloaded');
  assert.equal(early.out.finishReason, 'error');
  assert.equal(srv.providerCallIsTransient(early.out), true);
  const late = runStream([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写了一半' } },
    { type: 'error', error: { type: 'overloaded_error', message: 'sk-ant-api03-SECRETSECRETSECRETSECRET leaked' } },
  ]);
  assert.match(late.out.httpError, /^Anthropic stream error: overloaded_error: /);
  assert.ok(!late.out.httpError.includes('SECRETSECRETSECRET'), '错误文本过脱敏');
  assert.equal(srv.providerCallIsTransient(late.out), false, '吐过内容就不重试(否则界面内容重放)');
  const refusal = runStream([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'bio' } } }, { type: 'message_stop' }]);
  assert.equal(refusal.out.finishReason, 'refusal');
  assert.equal(refusal.out.httpError, 'Anthropic refusal (bio)');
  const noThinking = runStream([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hi' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
  assert.equal(noThinking.out.text, 'hi', 'content_block_start 自带的文字也算');
  assert.ok(!('providerBlocks' in noThinking.out));
  const redacted = runStream([{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENC' } }, { type: 'message_stop' }]);
  assert.deepEqual(redacted.out.providerBlocks.blocks, [{ type: 'redacted_thinking', data: 'ENC' }]);
});

test('[A7] 400 兼容重打', () => {
  const body = { model: 'claude-opus-5-5', max_tokens: 10, thinking: { type: 'adaptive' }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [THINK, { type: 'tool_use', id: 't', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
  ] };
  const stripped = wire.retryOn400(body, '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}');
  assert.deepEqual(stripped.messages[1].content, [{ type: 'tool_use', id: 't', name: 'x', input: {} }]);
  assert.deepEqual(stripped.thinking, { type: 'adaptive' }, '只去块,不动 thinking 开关');
  assert.equal(body.messages[1].content.length, 2, '原请求体不被改');
  const noThinkParam = wire.retryOn400({ ...body, messages: [body.messages[0]], output_config: { effort: 'high' } }, 'thinking: Extra inputs are not permitted');
  assert.ok(!('thinking' in noThinkParam) && noThinkParam.output_config, '只去点名的参数');
  assert.ok(!('temperature' in wire.retryOn400({ model: 'm', messages: [], temperature: 0.2 }, '`temperature` is deprecated for this model and not supported')));
  assert.equal(wire.retryOn400(body, 'max_tokens: must be less than 128000'), null);
  assert.equal(wire.retryOn400({ model: 'm', messages: [] }, 'thinking: unsupported'), null, '请求里没这个参数就不重打');
  assert.equal(srv.PROVIDER_WIRE_PROTOCOLS.chat.retryOn400(body, 'anything'), null);
  assert.equal(srv.PROVIDER_WIRE_PROTOCOLS.responses.retryOn400(body, 'anything'), null);
});

test('[A8] 用量、落历史字段、配置能力项、模型清单', () => {
  assert.equal(wire.normalizeUsage(null), null);
  const already = { prompt_tokens: 5, completion_tokens: 1 };
  assert.equal(wire.normalizeUsage(already), already, '已归一的原样');
  assert.deepEqual(wire.assistantHistoryFields({ reasoning: '想', providerBlocks: { protocol: 'anthropic', blocks: [] } }), { reasoning_content: '想', providerBlocks: { protocol: 'anthropic', blocks: [] } });
  assert.deepEqual(wire.assistantHistoryFields({ reasoning: '' }), {});
  const cfg = srv.normalizeConfig({ providers: [
    { id: 'p1', label: 'A', baseUrl: 'https://api.anthropic.com', apiStyle: 'anthropic', anthropicAuth: 'bearer', anthropicThinking: 'off', anthropicFallbacks: 'off' },
    { id: 'p2', label: 'B', baseUrl: 'https://x', apiStyle: 'anthropic', anthropicAuth: 'weird', anthropicThinking: 'always', anthropicFallbacks: 'on' },
  ] });
  const providers = (cfg.config || cfg).providers;
  const p1 = providers.find(p => p.id === 'p1');
  const p2 = providers.find(p => p.id === 'p2');
  assert.equal(p1.apiStyle, 'anthropic');
  assert.equal(p1.anthropicAuth, 'bearer');
  assert.equal(p1.anthropicThinking, 'off');
  assert.equal(p1.anthropicFallbacks, 'off');
  assert.ok(!('anthropicAuth' in p2) && !('anthropicThinking' in p2) && !('anthropicFallbacks' in p2), '不认的值不落字段');
  assert.equal(srv.extractContextLength({ id: 'claude-opus-5-5', max_input_tokens: 1000000, max_tokens: 128000 }), 1000000);
});

test('[A9] 新 Claude 模型的请求面(Opus 5.5 / Sonnet 5.5)', () => {
  const enc = (model, provider, extra = {}) => wire.encodeMessages({ model, messages: [{ role: 'user', content: 'hi' }], stream: true, provider, hasTools: true, ...extra });
  // 头:官方主机按模型带 beta;网关、老模型、非 Claude 不带
  assert.equal(wire.requestHeaders(OFFICIAL, { model: 'claude-opus-5-5' })['anthropic-beta'], 'thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01');
  assert.equal(wire.requestHeaders(OFFICIAL, { model: 'claude-sonnet-5-5' })['anthropic-beta'], 'thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01');
  assert.equal(wire.requestHeaders(OFFICIAL, { model: 'claude-fable-5-1' })['anthropic-beta'], 'thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01');
  assert.equal(wire.requestHeaders(OFFICIAL, { model: 'claude-sonnet-5' })['anthropic-beta'], 'thinking-binding-controls-2026-08-01', 'Sonnet 5 不在改派名单');
  assert.equal(wire.requestHeaders(OFFICIAL, { model: 'claude-haiku-4-5' })['anthropic-beta'], undefined);
  assert.equal(wire.requestHeaders({ ...OFFICIAL, anthropicFallbacks: 'off' }, { model: 'claude-opus-5-5' })['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
  assert.equal(wire.requestHeaders(GATEWAY, { model: 'claude-opus-5-5' })['anthropic-beta'], undefined, '网关不带官方 beta');
  assert.equal(wire.requestHeaders({ ...OFFICIAL, extraHeaders: { 'anthropic-beta': 'mine' } }, { model: 'claude-opus-5-5' })['anthropic-beta'], 'mine', '自定义头照旧最后覆盖');
  // 体:与头同一判据
  const opus = enc('claude-opus-5-5', OFFICIAL);
  assert.equal(opus.max_tokens, 64000);
  assert.equal(opus.fallbacks, 'default');
  assert.deepEqual(opus.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' });
  const gw = enc('claude-opus-5-5', GATEWAY);
  assert.equal(gw.max_tokens, 32000);
  assert.ok(!('fallbacks' in gw) && !('block_binding' in gw.thinking), '网关:不发 fallbacks / block_binding');
  assert.ok(!('fallbacks' in enc('claude-opus-5-5', { ...OFFICIAL, anthropicFallbacks: 'off' })));
  assert.ok(!('fallbacks' in enc('claude-opus-4-8', OFFICIAL)), 'Opus 4.8 不在改派名单');
  // 'off':Sonnet 5.5 用 between_tools;Opus 5.5 思考关不掉,不发 thinking
  assert.deepEqual(enc('claude-sonnet-5-5', { ...OFFICIAL, anthropicThinking: 'off' }).thinking, { type: 'between_tools' });
  assert.equal(enc('claude-opus-5-5', { ...OFFICIAL, anthropicThinking: 'off' }).thinking, undefined);
  const bt = wire.applyEffort(enc('claude-sonnet-5-5', { ...GATEWAY, anthropicThinking: 'off' }), 'xhigh');
  assert.equal(bt.thinking.type, 'adaptive', 'between_tools 只到 high;xhigh 换回 adaptive');
  assert.deepEqual(wire.applyEffort(enc('claude-sonnet-5-5', { ...GATEWAY, anthropicThinking: 'off' }), 'high').thinking, { type: 'between_tools' });
  // 采样参数
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-7', 'claude-fable-5-1']) {
    assert.ok(!('temperature' in wire.applyTemperature({ model }, 0.3)), `${model} 不发 temperature`);
  }
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'glm-4.6']) {
    assert.equal(wire.applyTemperature({ model }, 0.3).temperature, 0.3, `${model} 照发`);
  }
  assert.ok(!('temperature' in wire.applyTemperature({ model: 'glm-4.6' }, undefined)));
  assert.equal(srv.PROVIDER_WIRE_PROTOCOLS.chat.applyTemperature({}, 0.5).temperature, 0.5);
  // 回放保留 fallback 等未知块(少一块就改了后面思考块的前缀)
  const d = wire.decodeCompletion({ model: 'claude-opus-5', content: [
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
    { type: 'thinking', thinking: 't', signature: 'S' }, { type: 'text', text: 'ok' },
  ] }, { requestModel: 'claude-opus-5-5' });
  assert.deepEqual(d.providerBlocks.blocks[0], { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } });
  assert.equal(d.providerBlocks.requestModel, 'claude-opus-5-5', '改派后照样按请求 model 回放');
  // 网关不认官方专属字段:只去那一项
  const withBinding = { model: 'm', thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'S' }] }] };
  assert.deepEqual(wire.retryOn400(withBinding, 'thinking.block_binding: Extra inputs are not permitted').thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(wire.retryOn400({ model: 'm', thinking: { type: 'between_tools' }, messages: [] }, '"thinking.type.between_tools" is not supported for this model.').thinking, undefined);
  assert.ok(!('fallbacks' in wire.retryOn400({ model: 'm', fallbacks: 'default', messages: [] }, 'fallbacks: Extra inputs are not permitted')));
});

// 找 bug 波(Sonnet 复核)钉住的五条:每条先在修前的代码上复现过。
test('[A10] 签名失配报文点名 block_binding 时仍去掉思考块(不原样重打)', () => {
  const officialErr = 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".';
  const history = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'S' }, { type: 'tool_use', id: 'x', name: 'f', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }];
  for (const thinking of [{ type: 'adaptive', display: 'summarized' }, { type: 'between_tools' }]) {
    const body = { model: 'claude-sonnet-5-5', thinking, messages: history };
    const retried = wire.retryOn400(body, officialErr);
    assert.ok(retried, `${thinking.type}:要重打`);
    assert.notDeepEqual(retried, body, `${thinking.type}:重打体必须和原体不同`);
    assert.ok(!JSON.stringify(retried.messages).includes('"thinking"'), `${thinking.type}:思考块被去掉`);
    assert.deepEqual(retried.thinking, thinking, `${thinking.type}:思考设置本身不动`);
  }
});

test('[A10] 开着思考时不发 temperature', () => {
  const body = wire.encodeMessages({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: true, provider: OFFICIAL, hasTools: true });
  assert.equal(body.thinking && body.thinking.type, 'adaptive', '前提:Sonnet 4.6 在官方主机默认开自适应思考');
  assert.ok(!('temperature' in wire.applyTemperature(body, 0.2)), '思考 + temperature 会被 API 拒');
  assert.equal(wire.applyTemperature({ model: 'claude-sonnet-4-6', thinking: { type: 'disabled' } }, 0.2).temperature, 0.2, '显式关思考照发');
  assert.equal(wire.applyTemperature({ model: 'claude-sonnet-4-6' }, 0.2).temperature, 0.2, '没开思考照发');
});

test('[A10] message_delta 里为 null 的用量字段不抹掉 message_start 的计数', () => {
  const { usages } = runStream([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].prompt_tokens, 5100);
  assert.equal(usages[0].completion_tokens, 20);
});

test('[A10] 空文本块不进回放块', () => {
  const { out } = runStream([
    { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_a', name: 'f', input: {} } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ], 'claude-opus-5-5');
  assert.ok(out.providerBlocks, '有思考块就带回放块');
  assert.deepEqual(out.providerBlocks.blocks.map(b => b.type), ['thinking', 'tool_use'], '空文本块不回放(API 拒收空文本块)');
});

test('[A10] 同一 tool_use_id 只出一块 tool_result', () => {
  const body = wire.encodeMessages({
    model: 'claude-opus-5-5', stream: true, provider: GATEWAY, hasTools: true,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '[工具结果丢失]' },
      { role: 'system', content: 'rule' },
      { role: 'tool', tool_call_id: 'a', content: 'real' },
    ],
  });
  const results = body.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].content, 'real', '留后到的真结果');
});
