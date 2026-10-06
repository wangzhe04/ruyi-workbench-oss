'use strict';
// 进程内的 Anthropic Messages 假端点(58 号方案批 2)—— 与 lib/fake-openai-provider.js 同一个模具,只是线协议换成 Messages:
//   POST …/v1/messages  → handler(流式写 `event: <type>\ndata: <json>\n\n`,非流式把事件聚合成一份 message JSON)
//   GET  …/v1/models    → { data:[{ id, display_name, max_input_tokens, max_tokens, type:'model' }], has_more:false }
//                         (startFakeAnthropic({ models: null }) → 404,模拟不提供模型清单的兼容网关)
// 零依赖(只用内建 http),listen(0) 由系统分端口。
//
// 用法:
//   const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');
//   const fake = await startFakeAnthropic({
//     handler(req) {   // req: { url, headers, raw, body, messages, tools, stream, index, res }
//       return messageEvents({ thinking: '想', signature: 'SIG', text: '好', toolUses: [{ id: 'toolu_1', name: 'file_read', input: { path } }] });
//     },
//   });
//   provider.baseUrl = fake.url + '/anthropic';   // 端点 = /anthropic/v1/messages
//   … fake.requests[i].body / .headers / .url …
//   await fake.close();
//
// handler 的返回值(可以是 Promise):
//   · 事件数组          → 流式请求逐个写出;非流式请求聚合成 message JSON
//   · 字符串            → messageEvents({ text }) 的简写
//   · { status, json }  → 按该状态码回 JSON(400 签名失配、529 过载之类)
//   · undefined / null  → handler 自己接管 req.res
const http = require('http');

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };

// 一条完整回复的事件序列。thinking 与 signature 给了就先出一个 thinking 块;text 其后;toolUses 各占一块,参数分两段 input_json_delta。
// usage:{ input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens }(output 放在 message_delta 里,与真端点同)。
function messageEvents(opts = {}) {
  const model = opts.model || 'claude-opus-5-5';
  const u = opts.usage || { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 };
  const events = [{ type: 'message_start', message: { id: opts.id || 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: u.input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, output_tokens: 1 } } }];
  let index = 0;
  if (opts.thinking != null || opts.signature) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    if (opts.thinking) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(opts.thinking) } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: String(opts.signature || 'SIG') } });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  if (opts.text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const part of (Array.isArray(opts.text) ? opts.text : [opts.text])) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(part) } });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  for (const call of (opts.toolUses || [])) {
    const argStr = JSON.stringify(call.input || {});
    const half = Math.ceil(argStr.length / 2);
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argStr.slice(0, half) } });
    events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argStr.slice(half) } });
    events.push({ type: 'content_block_stop', index });
    index += 1;
  }
  events.push({ type: 'message_delta', delta: { stop_reason: opts.stop || ((opts.toolUses || []).length ? 'tool_use' : 'end_turn'), stop_sequence: null, ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}) }, usage: { output_tokens: u.output_tokens || 0 } });
  events.push({ type: 'message_stop' });
  return events;
}

// 事件 → 非流式 message(给 stream:false 的请求)。
function aggregate(events) {
  let msg = { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: {} };
  const blocks = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'message_start') msg = { ...msg, ...e.message, content: [] };
    else if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block, _partial: '' };
    else if (e.type === 'content_block_delta') {
      const b = blocks[e.index]; const d = e.delta || {};
      if (!b) continue;
      if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
      if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
      if (d.type === 'input_json_delta') b._partial += d.partial_json;
    } else if (e.type === 'message_delta') {
      msg.stop_reason = e.delta && e.delta.stop_reason;
      if (e.delta && e.delta.stop_details) msg.stop_details = e.delta.stop_details;
      msg.usage = { ...msg.usage, ...(e.usage || {}) };
    }
  }
  msg.content = blocks.filter(Boolean).map(b => {
    const { _partial, ...rest } = b;
    if (rest.type === 'tool_use') rest.input = _partial ? JSON.parse(_partial) : (rest.input || {});
    return rest;
  });
  return msg;
}

async function startFakeAnthropic(opts = {}) {
  const handler = typeof opts.handler === 'function' ? opts.handler : () => messageEvents({ text: 'ok' });
  const models = opts.models === null ? null : (opts.models || [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 }]);
  const requests = [];
  const modelRequests = [];
  const errors = [];
  const sockets = new Set();

  async function respond(ctx, out) {
    const { res } = ctx;
    if (out === undefined || out === null) return;
    if (typeof out === 'string') out = messageEvents({ text: out });
    if (!Array.isArray(out) && typeof out === 'object' && out.status !== undefined) {
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json === undefined ? {} : out.json));
      return;
    }
    const events = Array.isArray(out) ? out : [];
    if (!ctx.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(aggregate(events)));
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    for (const e of events) {
      if (res.destroyed || res.writableEnded) return;
      res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    }
    res.end();
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'GET' && /\/v1\/models(?:\?|$)/.test(url)) {
      modelRequests.push({ url, headers: req.headers });
      // models:null = 不提供模型清单的兼容网关(如 DeepSeek 的 /anthropic):回 404。
      if (models === null) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Not Found', type: 'not_found' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map(m => ({ type: 'model', created_at: '2026-01-01T00:00:00Z', ...m })), has_more: false, first_id: models[0] && models[0].id, last_id: models[models.length - 1] && models[models.length - 1].id }));
      return;
    }
    if (!(req.method === 'POST' && /\/v1\/messages(?:\?|$)/.test(url))) { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      if (!body || typeof body !== 'object') body = {};
      const ctx = {
        url, headers: req.headers, raw, body,
        messages: Array.isArray(body.messages) ? body.messages : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
        stream: body.stream === true,
        index: requests.length,
        req, res,
      };
      requests.push({ url, headers: req.headers, raw, body, messages: ctx.messages, tools: ctx.tools, stream: ctx.stream });
      try {
        await respond(ctx, await handler(ctx));
      } catch (e) {
        errors.push(e);
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fake handler threw: ' + (e && e.message || e) } })); }
        else if (!res.writableEnded) res.end();
      }
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests, modelRequests, errors,
    close() {
      for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { startFakeAnthropic, messageEvents, aggregate };
