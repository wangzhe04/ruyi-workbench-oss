'use strict';
// 架构还债批 2·A:OpenAI 兼容服务商 HTTP 原语搬进 04h-provider-http.js 之后,出站请求与修前逐字节相同。
// 期望值是搬家前(bc9f19c7)的 server.js 对同一组输入实测抓下来的,这里写死,不依赖 git。
//   [H1] 端点 base 归一化:chat 归到 /vN(已有 /vN 或 /compatible-mode/v1 原样),responses 原样(只去尾斜杠)。
//   [H2] 补全 URL:base 为空 → '';chat → /chat/completions;responses → /responses。
//   [H3] 请求头:content-type → Bearer(key 去空白;空 key 不带)→ 自定义头整份覆盖(含覆盖 authorization);键序即插入序。
//   [H4] providerFixCompletion(句尾改字):URL、头、请求体逐字节;400 去掉思考开关再打一次;SSE 回体兜底;错误文本。
//   [H5] providerRawCompletion(起草/JSON 修复/记忆审稿):URL、头、请求体(身份系统层除外)逐字节;不认 SSE;错误文本。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-provider-http-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { providerBaseWithV1, providerResponsesBase, providerApiBase, providerCompletionUrl, providerRequestHeaders, providerFixCompletion, providerRawCompletion } = srv;

const P = {
  A: { id: 'a', type: 'openai-compat', baseUrl: 'https://api.x.com', apiKey: ' sk-1 ', model: 'm1' },
  B: { id: 'b', type: 'openai-compat', baseUrl: 'https://api.x.com/v1/', apiKey: 'kb', model: 'm2', extraHeaders: { 'X-Custom': '1', authorization: 'Bearer override' } },
  C: { id: 'c', type: 'openai-compat', apiStyle: 'responses', baseUrl: 'https://api.deepseek.com/', apiKey: 'kc', model: 'ds' },
  D: { id: 'd', type: 'openai-compat', apiStyle: 'responses', baseUrl: 'https://h.example/v2', apiKey: '', keyOptional: true, model: 'md', extraHeaders: { 'X-Api-Key': 'zz' } },
  E: { id: 'e', type: 'openai-compat', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'llama' }], temperature: 0.3 },
  F: { id: 'f', type: 'openai-compat', baseUrl: '', apiKey: 'k', model: 'x' },
  G: { id: 'g', type: 'openai-compat', baseUrl: 'https://u:p@h.com/compatible-mode/v1', apiKey: 'k', model: 'x', reasoning: 'high' },
};
const H_JSON = ['content-type', 'application/json'];
const HEADERS = {
  A: [H_JSON, ['authorization', 'Bearer sk-1']],
  B: [H_JSON, ['authorization', 'Bearer override'], ['X-Custom', '1']],
  C: [H_JSON, ['authorization', 'Bearer kc']],
  D: [H_JSON, ['X-Api-Key', 'zz']],
  E: [H_JSON],
  G: [H_JSON, ['authorization', 'Bearer k']],
};
const URLS = {
  A: 'https://api.x.com/v1/chat/completions',
  B: 'https://api.x.com/v1/chat/completions',
  C: 'https://api.deepseek.com/responses',
  D: 'https://h.example/v2/responses',
  E: 'http://127.0.0.1:11434/v1/chat/completions',
  G: 'https://u:p@h.com/compatible-mode/v1/chat/completions',
};

// fetch 桩:按剧本逐发回应,记下每一发的 URL/方法/头(保序)/请求体。
const calls = [];
let script = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  calls.push({ url, method: init && init.method, headers: Object.entries((init && init.headers) || {}), body: init && init.body, hasSignal: Boolean(init && init.signal) });
  const step = script.shift() || { status: 200, body: '{}' };
  if (step.throw) { const e = new Error(step.throw.message); if (step.throw.name) e.name = step.throw.name; throw e; }
  return new Response(step.body, { status: step.status, headers: { 'content-type': step.ct || 'application/json' } });
};
async function run(steps, fn) {
  calls.length = 0; script = steps.slice();
  const result = await fn();
  return { result, calls: calls.slice() };
}
const CHAT_OK = JSON.stringify({ choices: [{ message: { content: ' hello ' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
const RESP_OK = JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1 } });
const SSE = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":1}}\n\ndata: [DONE]\n';
const ERR_BODY = 'bad key sk-abcdefghijklmnopqrstuvwxyz0123456789 happened';
const FIX_MSGS = [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: 'U1' }];
const FIX_CHAT_BODY = '{"model":"fm","messages":[{"role":"system","content":"S1"},{"role":"system","content":"S2"},{"role":"user","content":"U1"}],"stream":false,"temperature":0,"max_tokens":400,"thinking":{"type":"disabled"},"enable_thinking":false}';
const FIX_CHAT_PLAIN = '{"model":"fm","messages":[{"role":"system","content":"S1"},{"role":"system","content":"S2"},{"role":"user","content":"U1"}],"stream":false,"temperature":0,"max_tokens":400}';
const FIX_RESP_BODY = '{"model":"fm","instructions":"S1\\n\\nS2","input":"U1","stream":false,"max_output_tokens":400,"reasoning":{"effort":"minimal"}}';
const FIX_RESP_PLAIN = '{"model":"fm","instructions":"S1\\n\\nS2","input":"U1","stream":false,"max_output_tokens":400}';

test('[H1] 端点 base 归一化(chat 归 /vN,responses 原样)', () => {
  const table = [
    ['', '', ''], ['  ', '', ''], [null, '', ''], [undefined, '', ''],
    ['https://a.b', 'https://a.b/v1', 'https://a.b'],
    ['https://a.b/', 'https://a.b/v1', 'https://a.b'],
    ['https://a.b/v1', 'https://a.b/v1', 'https://a.b/v1'],
    ['https://a.b/V3//', 'https://a.b/V3', 'https://a.b/V3'],
    ['https://a.b/compatible-mode/v1', 'https://a.b/compatible-mode/v1', 'https://a.b/compatible-mode/v1'],
    ['https://a.b/api', 'https://a.b/api/v1', 'https://a.b/api'],
  ];
  for (const [input, v1, resp] of table) {
    assert.equal(providerBaseWithV1(input), v1, 'v1 ' + input);
    assert.equal(providerResponsesBase(input), resp, 'responses ' + input);
    assert.equal(providerApiBase(input, false), v1);
    assert.equal(providerApiBase(input, true), resp);
  }
});

test('[H2] 补全 URL', () => {
  for (const [k, url] of Object.entries(URLS)) assert.equal(providerCompletionUrl(P[k].baseUrl, P[k].apiStyle === 'responses'), url, k);
  assert.equal(providerCompletionUrl('', false), '');
  assert.equal(providerCompletionUrl('   ', true), '');
});

test('[H3] 请求头(键序、Bearer 去空白、空 key 不带、自定义头覆盖)', () => {
  for (const [k, entries] of Object.entries(HEADERS)) assert.deepEqual(Object.entries(providerRequestHeaders(P[k])), entries, k);
  assert.deepEqual(Object.entries(providerRequestHeaders({ apiKey: '   ' })), [H_JSON]);
  assert.deepEqual(providerRequestHeaders(null), { 'content-type': 'application/json' });
  const shared = { 'X-A': '1' };
  const h = providerRequestHeaders({ apiKey: 'k', extraHeaders: shared });
  h['X-B'] = '2';
  assert.deepEqual(shared, { 'X-A': '1' }, '返回的是新对象,不改配置里的自定义头');
});

test('[H4] providerFixCompletion 各端点形状的出站请求逐字节', async () => {
  for (const k of ['A', 'B', 'C', 'D', 'E', 'G']) {
    const responses = P[k].apiStyle === 'responses';
    const r = await run([{ status: 200, body: responses ? RESP_OK : CHAT_OK }], () => providerFixCompletion(P[k], 'fm', FIX_MSGS));
    assert.deepEqual(r.result, responses
      ? { ok: true, content: 'hi', usage: { input_tokens: 1 }, model: 'fm' }
      : { ok: true, content: 'hello', usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'fm' }, k);
    assert.deepEqual(r.calls, [{ url: URLS[k], method: 'POST', headers: HEADERS[k], body: responses ? FIX_RESP_BODY : FIX_CHAT_BODY, hasSignal: true }], k);
  }
});

test('[H4] providerFixCompletion:400 去掉思考开关再打一次;SSE 兜底;错误文本', async () => {
  let r = await run([{ status: 400, body: '{"error":"unknown field thinking"}' }, { status: 200, body: RESP_OK }], () => providerFixCompletion(P.C, 'fm', FIX_MSGS));
  assert.deepEqual(r.calls.map(c => c.body), [FIX_RESP_BODY, FIX_RESP_PLAIN]);
  assert.equal(r.result.ok, true);
  r = await run([{ status: 400, body: '{"error":"x"}' }, { status: 400, body: '{"error":"y"}' }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.calls.map(c => c.body), [FIX_CHAT_BODY, FIX_CHAT_PLAIN]);
  assert.deepEqual(r.result, { ok: false, error: 'HTTP 400: {"error":"y"}' });
  r = await run([{ status: 500, body: ERR_BODY }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'HTTP 500' });   // 回体不是 JSON → 不回显
  r = await run([{ status: 200, body: SSE, ct: 'text/event-stream' }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: true, content: 'ab', usage: { prompt_tokens: 1 }, model: 'fm' });
  r = await run([{ status: 200, body: SSE, ct: 'text/event-stream' }], () => providerFixCompletion(P.C, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'empty completion', usage: { prompt_tokens: 1 } });
  r = await run([{ status: 200, body: '{"choices":[{"message":{"content":"  "}}],"usage":{"x":1}}' }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'empty completion', usage: { x: 1 } });
  r = await run([{ throw: { name: 'AbortError', message: 'aborted' } }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'timeout (20s)' });
  r = await run([{ throw: { message: 'boom' } }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'boom' });
  r = await run([{ throw: { message: '' } }], () => providerFixCompletion(P.A, 'fm', FIX_MSGS));
  assert.deepEqual(r.result, { ok: false, error: 'request failed' });
  r = await run([], () => providerFixCompletion(P.A, '', FIX_MSGS));
  assert.deepEqual(r, { result: { ok: false, error: 'no model' }, calls: [] });
  r = await run([], () => providerFixCompletion(P.F, 'fm', FIX_MSGS));
  assert.deepEqual(r, { result: { ok: false, error: 'provider base URL is not set' }, calls: [] });
});

// providerRawCompletion 的首条 system(chat)/instructions 开头(responses)是提示词包里的身份层 —— 那是提示词的事,
// 不归本件钉;换成占位后其余字节逐字比对。
function maskIdentity(body) {
  const j = JSON.parse(body);
  if (Array.isArray(j.messages)) j.messages[0].content = '<identity>';
  if (typeof j.instructions === 'string') j.instructions = '<identity>' + j.instructions.slice(j.instructions.indexOf('\n\nSYS EXTRA'));
  return JSON.stringify(j);
}
const RAW_HIST = [{ role: 'system', content: 'SYS EXTRA' }, { role: 'user', content: 'q' }];
const RAW_CHAT = model => `{"model":"${model}","messages":[{"role":"system","content":"<identity>"},{"role":"system","content":"SYS EXTRA"},{"role":"user","content":"q"}],"stream":false}`;
const RAW_RESP = model => `{"model":"${model}","instructions":"<identity>\\n\\nSYS EXTRA","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}],"stream":false}`;

test('[H5] providerRawCompletion 各端点形状的出站请求逐字节(身份层除外)', async () => {
  const expected = {
    A: { body: RAW_CHAT('m1'), result: { ok: true, content: 'hello', usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'm1' } },
    B: { body: RAW_CHAT('m2'), result: { ok: true, content: 'hello', usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'm2' } },
    C: { body: RAW_RESP('ds'), result: { ok: true, content: 'hi', usage: { input_tokens: 1 }, model: 'ds' } },
    D: { body: RAW_RESP('md'), result: { ok: true, content: 'hi', usage: { input_tokens: 1 }, model: 'md' } },
    E: { body: RAW_CHAT('llama').replace('"stream":false}', '"stream":false,"temperature":0.3}'), result: { ok: true, content: 'hello', usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'llama' } },
    G: { body: RAW_CHAT('x'), result: { ok: true, content: 'hello', usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'x' } },
  };
  for (const [k, exp] of Object.entries(expected)) {
    const responses = P[k].apiStyle === 'responses';
    const r = await run([{ status: 200, body: responses ? RESP_OK : CHAT_OK }], () => providerRawCompletion(P[k], RAW_HIST));
    assert.deepEqual(r.result, exp.result, k);
    assert.equal(r.calls.length, 1, k);
    assert.equal(r.calls[0].url, URLS[k], k);
    assert.equal(r.calls[0].method, 'POST', k);
    assert.deepEqual(r.calls[0].headers, HEADERS[k], k);
    assert.equal(r.calls[0].hasSignal, true, k);
    assert.equal(maskIdentity(r.calls[0].body), exp.body, k);
  }
});

test('[H5] providerRawCompletion 错误文本(脱敏、超时、抛错、空补全、不认 SSE)', async () => {
  let r = await run([{ status: 500, body: ERR_BODY }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'HTTP 500: bad key «redacted» happened' });
  r = await run([{ status: 200, body: 'not json' }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'provider returned an empty completion' });
  r = await run([{ status: 200, body: SSE, ct: 'text/event-stream' }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'provider returned an empty completion' });
  r = await run([{ throw: { name: 'AbortError', message: 'aborted' } }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'draft request timed out (60s)' });
  r = await run([{ throw: { message: 'boom' } }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'boom' });
  r = await run([{ throw: { message: '' } }], () => providerRawCompletion(P.A, RAW_HIST));
  assert.deepEqual(r.result, { ok: false, error: 'draft request failed' });
  r = await run([], () => providerRawCompletion(P.F, RAW_HIST));
  assert.deepEqual(r, { result: { ok: false, error: 'provider base URL is not set' }, calls: [] });
});

process.on('exit', () => {
  global.fetch = realFetch;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});
