'use strict';
// Offline relay boundaries; ephemeral own HTTP servers only, no workbench, home, credentials or child process.
const http = require('node:http');
const { once } = require('node:events');
const { createRunner } = require('./lib/harness');
const { createGateway } = require('../ruyi-workbench/tools/external-bot-gateway');
const t = createRunner('EXTERNAL BOT GATEWAY');
const { ok } = t;
const ROUTE = '/api/external-bots/callback/qq?connectionId=bot_a';
const servers = [];
async function listen(server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
function request(port, path = ROUTE, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [], body = options.body || Buffer.from('{"hello":"世界"}\n');
    const headers = { 'content-type': 'application/json', ...options.headers };
    if (!headers['transfer-encoding']) headers['content-length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, method: options.method || 'POST', path,
      headers, agent: false }, res => {
      res.on('data', chunk => { chunks.push(chunk); if (options.onData) options.onData(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
(async () => {
  let mode = 'normal', received = [], release;
  const upstreamPort = await listen(http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (mode === 'timeout') return;
      if (mode === 'hold') { release = () => res.end('released'); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end('redirect'); return; }
      if (mode === 'large') { res.writeHead(200, { 'content-length': 65537 }); res.end(Buffer.alloc(65537)); return; }
      res.writeHead(202, { 'content-type': 'application/json', 'set-cookie': 'private=1', authorization: 'secret', location: '/private', 'x-internal': 'hidden' });
      res.write('{"phase":');
      if (mode === 'stream') { release = () => res.end('"done"}'); } else res.end('"done"}');
    });
  }));
  const upstream = 'http://127.0.0.1:' + upstreamPort;
  const port = await listen(createGateway({ upstream, timeoutMs: 1000, maxConcurrent: 2 }));
  const raw = Buffer.from(' { "字": "段" }\r\n');
  let result = await request(port, ROUTE, { body: raw, headers: {
    cookie: 'private=1', authorization: 'Bearer secret', origin: 'https://private.invalid',
    'x-forwarded-host': 'private.invalid', forwarded: 'for=secret', 'x-ruyi-token': 'secret', host: 'attacker.invalid',
    'x-signature-ed25519': 'signed', 'x-signature-timestamp': '123', 'x-bot-appid': 'appid', 'x-lark-signature': 'wrong-platform',
  } });
  const first = received[0];
  ok(result.status === 202 && result.body.toString() === '{"phase":"done"}', 'A1 exact callback response body/status');
  ok(first.path === ROUTE && first.body.equals(raw), 'A2 route and raw UTF8 bytes unchanged');
  ok(first.headers.host === '127.0.0.1:' + upstreamPort, 'A3 fixed upstream Host ignores incoming Host');
  ok(['cookie', 'authorization', 'origin', 'forwarded', 'x-forwarded-host', 'x-ruyi-token', 'x-lark-signature'].every(name => first.headers[name] === undefined), 'A4 credentials/forwarding/cross-platform headers never forwarded');
  ok(first.headers['x-bot-appid'] === 'appid' && first.headers['x-signature-ed25519'] === 'signed' && first.headers['x-signature-timestamp'] === '123', 'A5 QQ official authentication headers retained');
  ok(!result.headers['set-cookie'] && !result.headers.authorization && !result.headers.location && !result.headers['x-internal'] && result.headers['cache-control'] === 'no-store', 'A6 response internal headers removed');
  result = await request(port, '/api/external-bots/callback/feishu?connectionId=bot_b', { headers: {
    'x-lark-signature': 'sig', 'x-lark-request-timestamp': '123', 'x-lark-request-nonce': 'nonce', 'x-bot-appid': 'drop',
  } });
  ok(result.status === 202 && received.at(-1).headers['x-lark-signature'] === 'sig' && !received.at(-1).headers['x-bot-appid'], 'A7 Feishu header allowlist');
  const before = received.length;
  for (const path of ['/api/external-bots/connections', '/api/bootstrap', '/', '/api/external-bots/callback/qq',
    ROUTE + '&extra=1', ROUTE + '&connectionId=bot_b', ROUTE + '#x', '/api/external-bots/callback/%71q?connectionId=bot_a',
    '/api/external-bots/callback/qq/?connectionId=bot_a', '/api/external-bots/callback/qq?connectionId=%62ot_a',
    '/api/external-bots/../external-bots/callback/qq?connectionId=bot_a', 'http://127.0.0.1:' + upstreamPort + ROUTE,
    '/api/external-bots/callback/qq?connectionId=bot_a%26x%3D1']) {
    const rejected = await request(port, path); ok(rejected.status === 404, 'B route rejected ' + path);
  }
  ok((await request(port, ROUTE, { method: 'GET' })).status === 404 && received.length === before, 'B14 rejected routes never reach upstream');
  ok((await request(port, ROUTE, { body: Buffer.alloc(65537) })).status === 413, 'C1 declared oversized body rejected');
  ok((await request(port, ROUTE, { body: Buffer.alloc(65537), headers: { 'transfer-encoding': 'chunked' } })).status === 413, 'C2 chunked oversized body rejected');
  ok((await request(port, ROUTE, { headers: { 'content-encoding': 'gzip' } })).status === 415, 'C3 compressed body never transparently decoded');
  ok((await request(port, ROUTE, { headers: { 'x-bot-appid': ['a', 'b'] } })).status === 400, 'C4 duplicate authentication header rejected');
  mode = 'redirect'; result = await request(port);
  ok(result.status === 502 && !result.headers.location && result.body.toString().includes('redirect_rejected'), 'D1 redirects rejected without following or exposing Location');
  mode = 'large'; result = await request(port);
  ok(result.status === 502 && result.body.toString().includes('response_too_large'), 'D2 oversized response rejected before forwarding');
  mode = 'timeout'; result = await request(port);
  ok(result.status === 504 && result.body.toString().includes('gateway.timeout'), 'D3 upstream timeout bounded');
  mode = 'stream';
  let resolveFirst;
  const firstChunk = new Promise(resolve => { resolveFirst = resolve; });
  const streamed = request(port, ROUTE, { onData: () => resolveFirst() });
  await firstChunk; ok(typeof release === 'function', 'D4 first response chunk reaches client before upstream ends');
  release(); result = await streamed;
  ok(result.body.toString() === '{"phase":"done"}', 'D5 streaming completes intact');
  mode = 'hold';
  release = null;
  const holdPort = await listen(createGateway({ upstream, timeoutMs: 1000, maxConcurrent: 1 }));
  const held = request(holdPort);
  // Wait for observed upstream request, without assuming wallclock scheduling.
  const deadline = Date.now() + 900;
  while (typeof release !== 'function') {
    if (Date.now() > deadline) throw new Error('held request did not reach fake upstream');
    await new Promise(resolve => setImmediate(resolve));
  }
  result = await request(holdPort);
  ok(result.status === 503, 'D6 concurrent requests bounded');
  release(); await held;
  result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: ROUTE,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.write('{'); // Never finish the upload: gateway's total deadline must end it.
  });
  ok(result.status === 504 && result.body.toString().includes('gateway.timeout'), 'D7 stalled inbound upload has a bounded total deadline');
  for (const invalid of [undefined, 'http://localhost:' + upstreamPort, 'https://example.com', 'http://127.0.0.2', 'http://2130706433',
    'http://127.0.0.1@evil.invalid', 'http://127.0.0.1/private', 'http://127.0.0.1?x=1', 'http://127.0.0.1#x', 'http://%31%32%37.0.0.1']) {
    let rejected = false; try { createGateway({ upstream: invalid }); } catch { rejected = true; }
    ok(rejected, 'E invalid upstream rejected ' + String(invalid));
  }
  ok(!!createGateway({ upstream: 'http://[::1]:' + upstreamPort }), 'E11 IPv6 literal loopback accepted');
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  t.done();
});
