'use strict';
// 进程内的 OpenAI 兼容假 provider —— 取代各件手写的那一份 http.createServer + SSE 帧(2026-09 盘点约 71 件)。
// 零依赖(只用内建 http)。与 dev-harness/fake-openai.js 的分工:那个是【独立进程】、靠 FAKE_* 环境变量切模式,
// 适合「整件只要一种固定行为」;本模块在【测试进程里】跑、由一个脚本化的 handler 逐请求决定回什么,
// 适合按请求内容分支、计数、会合、挂住之类的场景(以前正是这些场景各自手抄了一份)。
//
// 端口:默认 listen(0) 由系统分配临时端口(与 free-port.js 同一个口径,落在 8700–9199 测试带之外,
// 不进 lib/port-audit 的审计面)。要沿用写死端口的旧件,把端口字面量留在 *.e2e.js 里、经 { port } 传进来 ——
// 端口审计只扫 *.e2e.js,字面量留在件里,审计照旧看得见、照旧防撞。
//
// 用法:
//   const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
//   const fake = await startFakeProvider({
//     handler(req) {                       // req: { method, url, headers, raw, body, messages, tools, stream, index, res, sse, open, end }
//       if (req.tools.length && !req.messages.some(m => m.role === 'tool')) return toolCallFrames('file_read', { path: 'a.txt' }, 'call_1');
//       return [...textFrames('done'), usageFrame({ prompt_tokens: 8, completion_tokens: 4 })];
//     },
//   });
//   config.providers = [{ …, baseUrl: fake.url }];   // fake.url = 'http://127.0.0.1:<port>'
//   … fake.requests[i].messages …                    // 每一发 chat/completions 的请求体(按到达顺序)
//   await fake.close();                              // 先销毁所有连接(挂住的流也收得掉),再关监听
//
// handler 的返回值(可以是 Promise):
//   · 帧数组             → 流式请求:写 SSE 头、逐帧 `data: <json>\n\n`、末尾 `data: [DONE]\n\n` 再 end;
//                          非流式请求(请求体里显式 stream:false):把帧聚合成一份 chat.completion JSON 回。
//   · 字符串             → textFrames(字符串) 的简写。
//   · { frames, delayMs, done } → 同帧数组;delayMs 为帧间间隔,done:false 时不补 [DONE](模拟不发终止符的网关)。
//   · { status, json[, headers] } → 按该状态码回一份 JSON(429/500/503 之类的错误信封);headers 追加响应头(如 { 'retry-after': '2' })。
//   · undefined / null  → handler 自己接管 req.res(例如 setTimeout 后再写、或者故意挂住不回)。
//                          接管时可用 req.open() 写 SSE 头、req.sse(frame) 写一帧、req.end() 补 [DONE] 并 end。
// handler 抛错 → 回 500 JSON(头已写出则直接 end),错误记进 fake.errors。
// 路由:GET …/models → { object:'list', data:[{ id, object:'model' }] }(models:false 关掉);
//       POST …/chat/completions → handler;其余交给 opts.fallback(req, res),没给就 404。
const http = require('http');

const DEFAULT_ID = 'chatcmpl-fake';
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };

function chunk(id, delta, finishReason = null) {
  return { id, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

// 文本回答:一帧(或按数组逐段多帧)content,再一帧 finish_reason。
function textFrames(text, opts = {}) {
  const id = opts.id || DEFAULT_ID;
  const parts = Array.isArray(text) ? text : [text];
  const frames = parts.map((part, i) => chunk(id, i === 0 ? { role: 'assistant', content: String(part) } : { content: String(part) }));
  if (opts.finish !== null) frames.push(chunk(id, {}, opts.finish || 'stop'));
  return frames;
}

// 工具调用:toolCallFrames(name, args, callId) 发一个;toolCallFrames([{ name, args, id }, …]) 在同一条 assistant 消息里并发多个。
// args 为对象时 JSON.stringify,为字符串时原样(可用来造半截/坏 JSON)。opts.split:true 把每个调用的 arguments
// 拆成「空串 + 前半 + 后半」三帧(与 fake-openai.js 的 emitOneToolCall 同形),考工作台的分片拼接。
function toolCallFrames(nameOrCalls, args, callId, opts = {}) {
  const calls = Array.isArray(nameOrCalls) ? nameOrCalls : [{ name: nameOrCalls, args, id: callId }];
  const id = opts.id || DEFAULT_ID;
  const frames = [];
  calls.forEach((call, i) => {
    const index = call.index === undefined ? i : call.index;
    const argStr = typeof call.args === 'string' ? call.args : JSON.stringify(call.args === undefined ? {} : call.args);
    const cid = call.id || `call_${i + 1}`;
    const head = i === 0 ? { role: 'assistant', content: null } : {};
    if (opts.split) {
      const half = Math.ceil(argStr.length / 2);
      frames.push(chunk(id, { ...head, tool_calls: [{ index, id: cid, type: 'function', function: { name: call.name, arguments: '' } }] }));
      frames.push(chunk(id, { tool_calls: [{ index, function: { arguments: argStr.slice(0, half) } }] }));
      frames.push(chunk(id, { tool_calls: [{ index, function: { arguments: argStr.slice(half) } }] }));
    } else {
      frames.push(chunk(id, { ...head, tool_calls: [{ index, id: cid, type: 'function', function: { name: call.name, arguments: argStr } }] }));
    }
  });
  if (opts.finish !== null) frames.push(chunk(id, {}, opts.finish || 'tool_calls'));
  return frames;
}

// 用量帧(choices 为空、带 usage —— stream_options.include_usage 的末帧形状)。
// usageFrame(8, 4) → { prompt_tokens: 8, completion_tokens: 4 };传对象则原样放进 usage。
function usageFrame(promptOrUsage = 8, completion = 4, opts = {}) {
  const usage = typeof promptOrUsage === 'object' && promptOrUsage
    ? promptOrUsage
    : { prompt_tokens: promptOrUsage, completion_tokens: completion };
  return { id: opts.id || DEFAULT_ID, choices: [], usage };
}

// 帧 → 非流式 chat.completion(给显式 stream:false 的请求)。
function aggregate(frames, model) {
  let content = '', finish = null, usage, id = DEFAULT_ID, sawContent = false;
  const calls = new Map();
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    if (f.id) id = f.id;
    if (f.usage) usage = f.usage;
    for (const c of f.choices || []) {
      const d = c.delta || {};
      if (typeof d.content === 'string') { content += d.content; sawContent = true; }
      for (const tc of d.tool_calls || []) {
        const key = tc.index === undefined ? calls.size : tc.index;
        const cur = calls.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.function.name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') cur.function.arguments += tc.function.arguments;
        calls.set(key, cur);
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
  }
  const message = { role: 'assistant', content: sawContent ? content : null };
  if (calls.size) message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  const out = { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model || 'fake-model', choices: [{ index: 0, message, finish_reason: finish || (calls.size ? 'tool_calls' : 'stop') }] };
  if (usage) out.usage = usage;
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startFakeProvider(opts = {}) {
  const handler = typeof opts.handler === 'function' ? opts.handler : () => textFrames('ok');
  const models = opts.models === false ? null : (Array.isArray(opts.models) ? opts.models : ['fake-model']);
  const requests = [];
  const errors = [];
  const sockets = new Set();

  async function respond(ctx, out) {
    const { res } = ctx;
    if (out === undefined || out === null) return; // handler 自己接管
    if (typeof out === 'string') out = textFrames(out);
    if (!Array.isArray(out) && typeof out === 'object' && out.status !== undefined && !out.frames) {
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers && typeof out.headers === 'object' ? out.headers : {}) });
      res.end(JSON.stringify(out.json === undefined ? {} : out.json));
      return;
    }
    const spec = Array.isArray(out) ? { frames: out } : out;
    const frames = Array.isArray(spec.frames) ? spec.frames : [];
    if (!ctx.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(aggregate(frames, ctx.body && ctx.body.model)));
      return;
    }
    ctx.open();
    for (let i = 0; i < frames.length; i++) {
      if (i > 0 && spec.delayMs) await sleep(spec.delayMs);
      if (res.destroyed || res.writableEnded) return; // 客户端走了(中断/停止):别往关掉的流上写
      ctx.sse(frames[i]);
    }
    if (spec.done === false) res.end();
    else ctx.end();
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (models && req.method === 'GET' && /\/models(?:\?|$)/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }));
      return;
    }
    if (!(req.method === 'POST' && url.includes('/chat/completions'))) {
      if (typeof opts.fallback === 'function') return opts.fallback(req, res);
      res.writeHead(404); res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      if (!body || typeof body !== 'object') body = {};
      const ctx = {
        method: req.method, url, headers: req.headers, raw, body,
        messages: Array.isArray(body.messages) ? body.messages : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
        stream: body.stream !== false,
        index: requests.length,
        req, res,
        open() { if (!res.headersSent) res.writeHead(200, SSE_HEADERS); },
        sse(frame) { ctx.open(); res.write('data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n'); },
        end() { if (res.writableEnded) return; ctx.open(); res.write('data: [DONE]\n\n'); res.end(); },
      };
      requests.push({ method: ctx.method, url, headers: ctx.headers, raw, body, messages: ctx.messages, tools: ctx.tools, stream: ctx.stream });
      try {
        await respond(ctx, await handler(ctx));
      } catch (e) {
        errors.push(e);
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fake provider handler threw: ' + (e && e.message || e), type: 'fake_error' } })); }
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
  let closed = null;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    errors,
    server,
    close() {
      if (!closed) {
        closed = new Promise(resolve => {
          for (const s of sockets) { try { s.destroy(); } catch { /* 已断 */ } }
          server.close(() => resolve());
        });
      }
      return closed;
    },
  };
}

module.exports = { startFakeProvider, textFrames, toolCallFrames, usageFrame, aggregate, SSE_HEADERS };
