#!/usr/bin/env node
// lib/fake-openai-provider.js 的单测:SSE 帧形状、非流式聚合、错误信封、接管模式、请求记录、端口与关闭。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame, aggregate } = require('../lib/fake-openai-provider');
const { PORT_BAND } = require('../lib/port-audit');

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}
function sseFrames(text) {
  return text.split('\n\n').filter(Boolean).map(ev => ev.replace(/^data: /, '')).map(d => (d === '[DONE]' ? d : JSON.parse(d)));
}

describe('frame builders', () => {
  it('textFrames: role+content then stop; array → several content frames', () => {
    const f = textFrames('hi');
    assert.deepEqual(f, [
      { id: 'chatcmpl-fake', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'chatcmpl-fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const g = textFrames(['a', 'b'], { id: 'x', finish: 'length' });
    assert.equal(g.length, 3);
    assert.deepEqual(g[1].choices[0].delta, { content: 'b' });
    assert.equal(g[2].choices[0].finish_reason, 'length');
    assert.equal(textFrames('z', { finish: null }).length, 1);
  });

  it('toolCallFrames: single, parallel and split shapes', () => {
    const one = toolCallFrames('file_read', { path: 'a.txt' }, 'call_a');
    assert.equal(one.length, 2);
    assert.deepEqual(one[0].choices[0].delta, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } }] });
    assert.equal(one[1].choices[0].finish_reason, 'tool_calls');
    const two = toolCallFrames([{ name: 'a', args: {} }, { name: 'b', args: '{"x"', id: 'cb' }]);
    assert.equal(two.length, 3);
    assert.equal(two[1].choices[0].delta.tool_calls[0].index, 1);
    assert.equal(two[1].choices[0].delta.tool_calls[0].function.arguments, '{"x"');
    const split = toolCallFrames('w', { path: 'p' }, 'c1', { split: true });
    assert.equal(split.length, 4);
    const joined = split.slice(0, 3).map(f => f.choices[0].delta.tool_calls[0].function.arguments).join('');
    assert.equal(joined, '{"path":"p"}');
  });

  it('usageFrame and aggregate', () => {
    assert.deepEqual(usageFrame(8, 4), { id: 'chatcmpl-fake', choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    assert.deepEqual(usageFrame({ prompt_tokens: 1, total_tokens: 2 }).usage, { prompt_tokens: 1, total_tokens: 2 });
    const agg = aggregate([...toolCallFrames('w', { a: 1 }, 'c1', { split: true }), usageFrame(3, 2)], 'm');
    assert.equal(agg.object, 'chat.completion');
    assert.equal(agg.model, 'm');
    assert.equal(agg.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(agg.choices[0].message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{"a":1}' } }]);
    assert.deepEqual(agg.usage, { prompt_tokens: 3, completion_tokens: 2 });
    assert.equal(aggregate(textFrames(['a', 'b'])).choices[0].message.content, 'ab');
  });
});

describe('startFakeProvider', () => {
  it('serves /v1/models, streams scripted frames with [DONE], records requests, aggregates stream:false', async () => {
    const fake = await startFakeProvider({
      handler(req) {
        if (req.tools.length) return toolCallFrames('file_read', { path: 'x' }, 'call_1');
        return [...textFrames('hello'), usageFrame(8, 4)];
      },
    });
    try {
      assert.equal(fake.url, `http://127.0.0.1:${fake.port}`);
      assert.equal(String(fake.port).match(PORT_BAND), null, 'OS-assigned port must stay out of the audited 8700-9199 band');
      const models = await request(fake.port, 'GET', '/v1/models');
      assert.deepEqual(JSON.parse(models.body).data.map(m => m.id), ['fake-model']);

      const s = await request(fake.port, 'POST', '/v1/chat/completions', { model: 'fake-model', stream: true, messages: [{ role: 'user', content: 'q' }] });
      assert.equal(s.status, 200);
      assert.match(s.headers['content-type'], /text\/event-stream/);
      const frames = sseFrames(s.body);
      assert.equal(frames.pop(), '[DONE]');
      assert.equal(frames[0].choices[0].delta.content, 'hello');
      assert.deepEqual(frames[2].usage, { prompt_tokens: 8, completion_tokens: 4 });

      const t = await request(fake.port, 'POST', '/chat/completions', { messages: [], tools: [{ type: 'function', function: { name: 'file_read' } }] });
      assert.equal(sseFrames(t.body)[0].choices[0].delta.tool_calls[0].function.name, 'file_read');

      const n = await request(fake.port, 'POST', '/v1/chat/completions', { model: 'mm', stream: false, messages: [] });
      assert.match(n.headers['content-type'], /application\/json/);
      const j = JSON.parse(n.body);
      assert.equal(j.choices[0].message.content, 'hello');
      assert.equal(j.model, 'mm');

      assert.equal(fake.requests.length, 3);
      assert.equal(fake.requests[0].messages[0].content, 'q');
      assert.equal(fake.requests[1].tools.length, 1);
      assert.equal(fake.requests[2].stream, false);
      assert.equal((await request(fake.port, 'GET', '/nope')).status, 404);
    } finally { await fake.close(); }
  });

  it('status envelopes, string shorthand, delayMs/done:false, handler errors', async () => {
    let n = 0;
    const fake = await startFakeProvider({
      models: false,
      handler() {
        n += 1;
        if (n === 1) return { status: 503, json: { error: { message: 'transient' } } };
        if (n === 2) return 'plain';
        if (n === 3) return { frames: textFrames(['a', 'b']), delayMs: 5, done: false };
        throw new Error('boom');
      },
    });
    try {
      const a = await request(fake.port, 'POST', '/v1/chat/completions', {});
      assert.equal(a.status, 503);
      assert.equal(JSON.parse(a.body).error.message, 'transient');
      const b = sseFrames((await request(fake.port, 'POST', '/v1/chat/completions', {})).body);
      assert.equal(b[0].choices[0].delta.content, 'plain');
      const c = sseFrames((await request(fake.port, 'POST', '/v1/chat/completions', {})).body);
      assert.notEqual(c[c.length - 1], '[DONE]');
      assert.equal(c.length, 3);
      const d = await request(fake.port, 'POST', '/v1/chat/completions', {});
      assert.equal(d.status, 500);
      assert.equal(fake.errors.length, 1);
      assert.equal((await request(fake.port, 'GET', '/v1/models')).status, 404, 'models:false disables the route');
    } finally { await fake.close(); }
  });

  it('manual mode: handler owns res (open/sse/end), and close() tears down a hung stream', async () => {
    const fake = await startFakeProvider({
      fallback(req, res) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fb'); },
      handler(req) {
        if (req.body.hang) { req.open(); return undefined; }
        setTimeout(() => { req.sse(textFrames('late')[0]); req.end(); }, 10);
        return undefined;
      },
    });
    const late = sseFrames((await request(fake.port, 'POST', '/v1/chat/completions', {})).body);
    assert.equal(late[0].choices[0].delta.content, 'late');
    assert.equal(late[late.length - 1], '[DONE]');
    assert.equal((await request(fake.port, 'GET', '/other')).body, 'fb');
    const hung = request(fake.port, 'POST', '/v1/chat/completions', { hang: true }).catch(e => e);
    await new Promise(r => setTimeout(r, 50));
    const t0 = Date.now();
    await fake.close();
    assert.ok(Date.now() - t0 < 5000, 'close() must not wait for the hung stream');
    await hung;
    assert.strictEqual(fake.close(), fake.close(), 'close() is idempotent');
  });

  it('honours an explicit port (legacy fixed-port tests keep their literal in the .e2e.js)', async () => {
    const probe = await startFakeProvider();
    const port = probe.port;
    await probe.close();
    const fake = await startFakeProvider({ port });
    try { assert.equal(fake.port, port); } finally { await fake.close(); }
  });
});
