'use strict';
// 58 号方案批 1:openAiStreamOnce(07)的【特征语料锁】。协议登记表重构把 chat / responses 两套事件语法从这个函数里
// 搬成各协议的解码器;这件在动代码之前用 master(292c6f03)的实现把整套语料跑一遍、结果写进金样,
// 重构后同一份语料必须逐项相同 —— 事件序列(assistant_delta / thinking_delta / raw_line 及其 seq)、markUsage 收到的每一帧、
// 返回值的每个字段、每一发出站请求体(400 剥 stream_options 重试那一发也算)、抛出的异常。
//
// 语料覆盖:
//   chat 流式   文本(按 5 字节切块,中文跨块)、reasoning_content 与 reasoning 两种拼法、并行 tool_calls(有 index / 只有 id /
//               每片都带 id / 什么都不带)、一个事件跨多行 data:、一个事件里多行各自完整的 JSON、注释行与 event:/id: 字段、
//               CRLF、无结尾空行、[DONE] 之后的垃圾、finish_reason=length、空名工具调用被滤掉;
//   responses 流式 文本 + 推理 + completed 用量、按 item_id 路由的交错并行 function_call、缺 item_id 回退当前槽、
//               web_search_call(search / open_page)、中途事件自带 usage、incomplete、failed(带超窗语义 / 无详情 / 带密钥被脱敏);
//   非流式回体   chat(推理 + 正文 + 缺 id 的工具调用)、responses(推理 + 正文 + function_call + incomplete / failed);
//   失败路径     400 工具被拒、400 超窗、400 剥 stream_options 重试、400 普通、502 failover 标记、401 不 failover、
//               连接失败结构化返回、TLS 失败、AbortError 原样抛、其它异常原样抛。
// makeId 生成的随机 id(call_<16 hex>)打码成 call_<id>,其余逐字比对。
//
// 金样:dev-harness/fixtures/provider-wire-stream.golden.json。只有在【有意】改变流式解码行为时才重录:
//   RUYI_RECORD_GOLDEN=1 node --test dev-harness/unit/provider-wire-stream.test.js
// 重录必须在 PR 里说明改了哪条语料的哪个字段、为什么。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wire-stream-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { openAiStreamOnce } = srv;
const GOLDEN = path.resolve(__dirname, '../fixtures/provider-wire-stream.golden.json');
const RECORD = process.env.RUYI_RECORD_GOLDEN === '1';

const enc = new TextEncoder();
// SSE 帧:每个对象一行 data:,事件之间空行。
const sse = (...events) => events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join('');
// 把字符串按字节切成小块交给 ReadableStream,专门制造「一个事件、一个 UTF-8 字符被切在两块之间」。
const streamBody = (text, chunk) => {
  const bytes = enc.encode(text);
  return new ReadableStream({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += chunk) ctrl.enqueue(bytes.slice(i, i + chunk));
      ctrl.close();
    },
  });
};
const CHAT_BODY = { model: 'm', messages: [{ role: 'user', content: 'q' }], stream: true, stream_options: { include_usage: true } };
const CHAT_BODY_TOOLS = { ...CHAT_BODY, tools: [{ type: 'function', function: { name: 'file_read', parameters: { type: 'object' } } }], tool_choice: 'auto' };
const CHAT_BODY_NO_OPTS = { model: 'm', messages: [{ role: 'user', content: 'q' }], stream: true };
const RESP_BODY = { model: 'm', instructions: 'sys', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }], stream: true };
const RESP_BODY_TOOLS = { ...RESP_BODY, tools: [{ type: 'function', name: 'file_read', parameters: { type: 'object' } }], tool_choice: 'auto' };
const tc = (index, id, name, args) => {
  const t = {};
  if (index !== undefined) t.index = index;
  if (id !== undefined) t.id = id;
  const fn = {};
  if (name !== undefined) fn.name = name;
  if (args !== undefined) fn.arguments = args;
  if (name !== undefined || args !== undefined) t.function = fn;
  return { choices: [{ delta: { tool_calls: [t] } }] };
};
// 假密钥运行时拼出来(repo-hygiene 的全仓密钥扫描不会把夹具当真密钥)。
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');

// 每条语料:body = 调用方交给 openAiStreamOnce 的请求体;steps = fetch 桩逐发的回应。
//   { sse, chunk } 流式回体;{ json } 无 body 流的非流式回体;{ status, text } 非 2xx;{ throw } fetch 抛错。
const CASES = {
  'chat.text.chunked': { body: CHAT_BODY, steps: [{ chunk: 5, sse: sse(
    { id: 'chatcmpl-1', choices: [{ delta: { role: 'assistant', content: '' } }] },
    { id: 'chatcmpl-1', choices: [{ delta: { content: '你好，' } }] },
    { id: 'chatcmpl-1', choices: [{ delta: { content: '世界 hello' } }] },
    { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'stop' }] },
    { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } } },
    '[DONE]') }] },
  'chat.reasoning.both-spellings': { body: CHAT_BODY, steps: [{ chunk: 64, sse: sse(
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { reasoning: '再想' } }] },
    { choices: [{ delta: { content: '答案' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { input_tokens: 3, output_tokens: 2 } },
    '[DONE]') }] },
  'chat.tools.parallel-indexed': { body: CHAT_BODY_TOOLS, steps: [{ chunk: 17, sse: sse(
    { choices: [{ delta: { content: '我来读两个文件' } }] },
    tc(0, 'call_a', 'file_read', ''),
    tc(1, 'call_b', 'file_read', ''),
    tc(0, undefined, undefined, '{"path":'),
    tc(1, undefined, undefined, '{"path":"b.txt"}'),
    tc(0, undefined, undefined, '"a.txt"}'),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]') }] },
  'chat.tools.id-only-first-fragment': { body: CHAT_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    tc(undefined, 'call_x', 'file_read', '{"pa'),
    tc(undefined, undefined, undefined, 'th":"x"}'),
    tc(undefined, 'call_y', 'file_list', '{"path":'),
    tc(undefined, undefined, undefined, '"."}'),
    '[DONE]') }] },
  'chat.tools.id-every-fragment-and-name-split': { body: CHAT_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    tc(0, 'call_r', 'file_', '{"a":'),
    tc(0, 'call_r', 'read', '1}'),
    '[DONE]') }] },
  'chat.tools.no-id-no-index': { body: CHAT_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    tc(undefined, undefined, 'file_read', '{"path"'),
    tc(undefined, undefined, undefined, ':"z"}'),
    tc(undefined, undefined, undefined, undefined),
    '[DONE]') }] },
  'chat.tools.empty-name-filtered': { body: CHAT_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    tc(0, 'call_e', '', '{}'),
    tc(1, 'call_f', 'file_read', '{}'),
    '[DONE]') }] },
  'chat.framing.multiline-data-one-event': { body: CHAT_BODY, steps: [{ chunk: 64,
    sse: 'data: {"choices":[{"delta":\ndata: {"content":"拼起来"}}]}\n\n' + sse('[DONE]') }] },
  'chat.framing.multiline-data-each-complete': { body: CHAT_BODY, steps: [{ chunk: 64,
    sse: 'data: {"choices":[{"delta":{"content":"一"}}]}\ndata: {"choices":[{"delta":{"content":"二"}}]}\n\n' + sse('[DONE]') }] },
  'chat.framing.comments-fields-crlf': { body: CHAT_BODY, steps: [{ chunk: 3,
    sse: ': keep-alive\r\nevent: message\r\nid: 7\r\ndata: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\nretry: 100\r\ndata:{"choices":[{"delta":{"content":"B"}}]}\r\n\r\ndata: [DONE]\r\n\r\n' }] },
  'chat.framing.no-trailing-blank-line': { body: CHAT_BODY, steps: [{ chunk: 64,
    sse: 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}]}' }] },
  'chat.framing.garbage-after-done': { body: CHAT_BODY, steps: [{ chunk: 64,
    sse: sse({ choices: [{ delta: { content: 'ok' } }] }, '[DONE]') + 'data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n' }] },
  'chat.framing.bad-json-lines-skipped': { body: CHAT_BODY, steps: [{ chunk: 64,
    sse: 'data: {not json\n\n' + sse({ choices: [{ delta: { content: 'after' } }] }, '[DONE]') }] },
  'chat.finish.length': { body: CHAT_BODY, steps: [{ chunk: 64, sse: sse(
    { choices: [{ delta: { content: '截断' }, finish_reason: 'length' }] },
    '[DONE]') }] },
  'chat.no-choices-usage-only': { body: CHAT_BODY, steps: [{ chunk: 64, sse: sse(
    { choices: [{ delta: { content: 'u' } }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1 } },
    '[DONE]') }] },

  'responses.text-reasoning-completed': { body: RESP_BODY, steps: [{ chunk: 9, sse: sse(
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.in_progress', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: '推理一' },
    { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: '推理二' },
    { type: 'response.reasoning_text.done', item_id: 'rs_1', text: '推理一推理二' },
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant' } },
    { type: 'response.content_part.added', item_id: 'msg_1', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: '结论：' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: '完成' },
    { type: 'response.output_text.done', item_id: 'msg_1', text: '结论：完成' },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 20, output_tokens: 6, input_tokens_details: { cached_tokens: 10 } } } },
    { type: 'response.output_text.delta', delta: 'AFTER-TERMINAL' }) }] },
  'responses.function-calls-interleaved': { body: RESP_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    { type: 'response.created', response: { id: 'resp_2' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'file_list', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a"}' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '"."}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: '_x' } },
    { type: 'response.completed', response: { id: 'resp_2', usage: { input_tokens: 5, output_tokens: 5 } } }) }] },
  'responses.function-call-fallbacks': { body: RESP_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    { type: 'response.function_call_arguments.delta', delta: '{"orphan":1}' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', name: 'file_read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'unknown', delta: '{"x":2}' },
    { type: 'response.completed', response: {} }) }] },
  'responses.web-search-calls': { body: RESP_BODY_TOOLS, steps: [{ chunk: 64, sse: sse(
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['如意 工作台', '', 'ruyi'] } } },
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_2', status: 'in_progress' } },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_2', status: 'completed', action: { type: 'open_page', url: 'https://example.com/a' } } },
    { type: 'response.output_item.added', item: { type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed' } },
    { type: 'response.output_text.delta', delta: '搜到了' },
    { type: 'response.completed', response: { id: 'resp_ws' } }) }] },
  'responses.usage-on-intermediate-event': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse(
    { type: 'response.output_text.delta', delta: 'x', usage: { input_tokens: 1, output_tokens: 1 } },
    { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 2 } } }) }] },
  'responses.incomplete': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse(
    { type: 'response.output_text.delta', delta: '半截' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }) }] },
  'responses.failed.context': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse(
    { type: 'response.failed', response: { error: { message: 'maximum context length exceeded: too many tokens' } } }) }] },
  'responses.failed.no-detail': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse({ type: 'response.failed', response: {} }) }] },
  'responses.failed.redacted': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse(
    { type: 'response.failed', response: { last_error: { code: 'bad_key ' + FAKE_KEY } } }) }] },
  'responses.id-from-event-id': { body: RESP_BODY, steps: [{ chunk: 64, sse: sse(
    { type: 'response.created', id: 'evt_created_ignored' },
    { type: 'response.output_text.delta', id: 'evt_7', delta: 'z' },
    { type: 'response.completed', response: {} }) }] },

  'nonstream.chat': { body: CHAT_BODY_TOOLS, steps: [{ json: {
    id: 'chatcmpl-ns',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '正文', reasoning_content: '推理',
      tool_calls: [{ id: 'call_ns', type: 'function', function: { name: 'file_read', arguments: '{"path":"a"}' } },
        { type: 'function', function: { name: 'file_list' } }, { id: 'call_noname', function: { arguments: '{}' } }] } }],
    usage: { prompt_tokens: 9, completion_tokens: 3 } } }] },
  'nonstream.chat.reasoning-alt-spelling': { body: CHAT_BODY, steps: [{ json: {
    choices: [{ finish_reason: 'stop', message: { content: '', reasoning: '只有推理' } }] } }] },
  'nonstream.chat.null-body': { body: CHAT_BODY, steps: [{ json: null }] },
  'nonstream.responses': { body: RESP_BODY_TOOLS, steps: [{ json: {
    id: 'resp_ns', status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '想' }, { type: 'other', text: 'skip' }] },
      { type: 'message', content: [{ type: 'output_text', text: '文' }, { type: 'input_text', text: '本' }, { type: 'refusal', refusal: 'no' }] },
      { type: 'function_call', call_id: 'call_r1', name: 'file_read', arguments: '{"path":"b"}' },
      { type: 'function_call', name: 'file_list', arguments: '' },
      { type: 'function_call', call_id: 'call_r3', arguments: '{}' },
    ],
    usage: { input_tokens: 4, output_tokens: 2 } } }] },
  'nonstream.responses.incomplete': { body: RESP_BODY, steps: [{ json: { response: { id: 'resp_inner' }, status: 'incomplete', output: [] } }] },
  'nonstream.responses.failed': { body: RESP_BODY, steps: [{ json: { status: 'failed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'part' }] }] } }] },

  'error.400.tools-rejected': { body: CHAT_BODY_TOOLS, steps: [{ status: 400, text: '{"error":{"message":"tools are not supported for this model"}}' }] },
  'error.400.context-overflow': { body: CHAT_BODY_TOOLS, steps: [{ status: 400, text: '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}' }] },
  'error.400.context-overflow.no-tools': { body: CHAT_BODY, steps: [{ status: 400, text: 'prompt is too long: 250000 tokens > 200000 maximum' }] },
  'error.400.stream-options-retry': { body: CHAT_BODY, steps: [
    { status: 400, text: '{"error":"unknown field stream_options"}' },
    { chunk: 64, sse: sse({ choices: [{ delta: { content: '重试成功' } }] }, '[DONE]') }] },
  'error.400.stream-options-retry-fails-again': { body: CHAT_BODY, steps: [
    { status: 400, text: 'unsupported parameter' },
    { status: 500, text: 'still bad ' + FAKE_KEY }] },
  'error.400.plain': { body: CHAT_BODY_NO_OPTS, steps: [{ status: 400, text: 'bad request: invalid model' }] },
  'error.400.plain.responses-with-tools-function-text': { body: RESP_BODY_TOOLS, steps: [{ status: 400, text: 'function name invalid' }] },
  'error.502.failover': { body: CHAT_BODY, steps: [{ status: 502, text: 'bad gateway' }] },
  'error.503.failover.responses': { body: RESP_BODY, steps: [{ status: 503, text: '' }] },
  'error.401.no-failover': { body: CHAT_BODY_TOOLS, steps: [{ status: 401, text: 'invalid api key for tool access' }] },
  'error.429': { body: CHAT_BODY, steps: [{ status: 429, text: 'rate limited' }] },
  'error.throw.connect': { body: CHAT_BODY, steps: [{ throw: { message: 'fetch failed', causeCode: 'ECONNREFUSED' } }] },
  'error.throw.code': { body: RESP_BODY, steps: [{ throw: { message: 'x', code: 'ENOTFOUND' } }] },
  'error.throw.tls': { body: CHAT_BODY, steps: [{ throw: { message: 'self-signed certificate in chain' } }] },
  'error.throw.abort': { body: CHAT_BODY, steps: [{ throw: { name: 'AbortError', message: 'aborted' } }] },
  'error.throw.other': { body: CHAT_BODY, steps: [{ throw: { message: 'weird failure' } }] },
};

const MAKE_ID = /\bcall_[0-9a-f]{16}\b/g;
const mask = value => JSON.parse(JSON.stringify(value === undefined ? null : value).replace(MAKE_ID, 'call_<id>'));

async function runCase(spec) {
  const steps = spec.steps.slice();
  const fetchBodies = [];
  const events = [];
  const usages = [];
  let touches = 0;
  global.fetch = async (url, init) => {
    fetchBodies.push({ url, method: init && init.method, headers: init && init.headers, body: init && init.body });
    const step = steps.shift();
    if (!step) throw new Error('fetch called more times than the case scripted');
    if (step.throw) {
      const e = new Error(step.throw.message);
      if (step.throw.name) e.name = step.throw.name;
      if (step.throw.code) e.code = step.throw.code;
      if (step.throw.causeCode) e.cause = { code: step.throw.causeCode };
      throw e;
    }
    if ('json' in step) {
      // 非流式:没有可读流的回体(openAiStreamOnce 看 res.body.getReader 决定走哪条路)
      return { ok: true, status: 200, body: null, json: async () => step.json, text: async () => JSON.stringify(step.json) };
    }
    if (step.sse != null) return new Response(streamBody(step.sse, step.chunk || 64), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(step.text, { status: step.status });
  };
  let result = null, thrown = null;
  try {
    result = await openAiStreamOnce({
      chatUrl: 'http://127.0.0.1:1/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: spec.body, ctrl: null,
      onEvent: e => events.push(e), markUsage: u => usages.push(u), rawSeqRef: { n: 0 }, touch: () => { touches += 1; },
    });
  } catch (e) {
    thrown = { name: e && e.name, message: e && e.message };
  }
  return mask({ result, thrown, events, usages, touchedAtLeastOnce: touches > 0, fetches: fetchBodies, unusedSteps: steps.length });
}

test('openAiStreamOnce 特征语料与金样逐项相同', async () => {
  const realFetch = global.fetch;
  const actual = {};
  try {
    for (const [name, spec] of Object.entries(CASES)) actual[name] = await runCase(spec);
  } finally { global.fetch = realFetch; }
  if (RECORD) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n', 'utf8');
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden), '语料与金样一一对应');
  for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
