'use strict';
// Standalone, opt-in callback relay. No workbench token, filesystem, DNS lookup or platform API access.
const http = require('node:http');
const https = require('node:https');

const CALLBACK = /^\/api\/external-bots\/callback\/(qq|feishu)\?connectionId=[a-z][a-z0-9_-]{0,63}$/;
const SIGNATURE_HEADERS = Object.freeze({
  qq: ['x-signature-ed25519', 'x-signature-timestamp', 'x-bot-appid'],
  feishu: ['x-lark-signature', 'x-lark-request-timestamp', 'x-lark-request-nonce'],
});
function upstreamOrigin(input) {
  if (typeof input !== 'string') throw new Error('upstream must be an explicit loopback HTTP(S) origin');
  // Check the original spelling as well: URL normalizes encoded hosts and integer IPv4 addresses.
  if (!/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(input)) throw new Error('upstream must be a literal loopback HTTP(S) origin');
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid upstream origin');
  return url;
}
function bounded(value, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('invalid gateway limit');
  return result;
}
function createGateway(options = {}) {
  const upstream = upstreamOrigin(options.upstream);
  const timeoutMs = bounded(options.timeoutMs, 15000, 20, 60000);
  const maxConcurrent = bounded(options.maxConcurrent, 32, 1, 256);
  const maxConnections = bounded(options.maxConnections, 64, 1, 512);
  const maxResponseBytes = bounded(options.maxResponseBytes, 65536, 1, 1048576);
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const match = CALLBACK.exec(req.url || '');
    const reject = (status, code) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'connection': 'close' });
      res.end(JSON.stringify({ ok: false, error: code }));
      req.resume();
    };
    if (req.method !== 'POST' || !match) { reject(404, 'gateway.route_unavailable'); return; }
    if (active >= maxConcurrent) { reject(503, 'gateway.busy'); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { reject(415, 'gateway.encoding_unsupported'); return; }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 65536)) { reject(413, 'gateway.body_too_large'); return; }
    const allowed = ['content-type', ...SIGNATURE_HEADERS[match[1]]];
    const headers = Object.create(null);
    const seen = new Set();
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index].toLowerCase();
      if (!allowed.includes(name)) continue;
      if (seen.has(name)) { reject(400, 'gateway.duplicate_header'); return; }
      seen.add(name); headers[name] = req.rawHeaders[index + 1];
    }
    active++;
    let finished = false, proxy = null, response = null, size = 0;
    const chunks = [];
    const timer = setTimeout(() => fail(504, 'gateway.timeout'), timeoutMs);
    timer.unref();
    function finish() {
      if (finished) return;
      finished = true; clearTimeout(timer); active--;
    }
    function fail(status, code) {
      if (finished) return;
      // Mark complete before destroying either side; error/close events can be synchronous.
      finish();
      if (proxy) proxy.destroy();
      if (response) response.destroy();
      reject(status, code);
    }
    res.on('finish', finish);
    res.on('close', () => { finish(); if (proxy) proxy.destroy(); if (response) response.destroy(); });
    req.on('aborted', () => fail(400, 'gateway.request_aborted'));
    req.on('error', () => fail(400, 'gateway.request_failed'));
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > 65536) { fail(413, 'gateway.body_too_large'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      const body = Buffer.concat(chunks, size);
      headers['content-length'] = String(size);
      // Host/port are fixed by validated origin. No incoming Host, cookies, auth, Origin or forwarded headers survive.
      proxy = (upstream.protocol === 'https:' ? https : http).request({
        protocol: upstream.protocol, hostname: upstream.hostname === '[::1]' ? '::1' : upstream.hostname,
        port: upstream.port || undefined, method: 'POST', path: req.url, headers, agent: false,
      }, upstreamResponse => {
        if (finished) { upstreamResponse.destroy(); return; }
        response = upstreamResponse;
        if (response.statusCode >= 300 && response.statusCode < 400) { fail(502, 'gateway.redirect_rejected'); return; }
        const declared = response.headers['content-length'];
        if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > maxResponseBytes)) { fail(502, 'gateway.response_too_large'); return; }
        const responseHeaders = { 'cache-control': 'no-store' };
        if (typeof response.headers['content-type'] === 'string') responseHeaders['content-type'] = response.headers['content-type'];
        res.writeHead(response.statusCode || 502, responseHeaders);
        let received = 0;
        response.on('data', chunk => {
          if (finished) return;
          received += chunk.length;
          if (received > maxResponseBytes) { fail(502, 'gateway.response_too_large'); return; }
          if (!res.write(chunk)) response.pause();
        });
        res.on('drain', () => response.resume());
        response.on('end', () => { if (!finished) res.end(); });
        response.on('error', () => fail(502, 'gateway.upstream_failed'));
        response.on('aborted', () => fail(502, 'gateway.upstream_failed'));
      });
      proxy.on('error', () => fail(502, 'gateway.upstream_failed'));
      proxy.end(body);
    });
  });
  server.maxConnections = maxConnections;
  server.dropMaxConnection = true;
  server.headersTimeout = Math.max(timeoutMs, 1000);
  server.requestTimeout = timeoutMs;
  server.timeout = timeoutMs;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 8;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('checkContinue', (_req, res) => { res.writeHead(417, { connection: 'close' }); res.end(); });
  return server;
}
function main(args) {
  const help = 'Usage: node external-bot-gateway.js --upstream http://127.0.0.1:8765 [--host 127.0.0.1] [--port 8788]\nOnly POST /api/external-bots/callback/qq|feishu?connectionId=<id> is relayed. TLS/public deployment is administrator managed.\n';
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  const options = { host: '127.0.0.1', port: 8788 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--upstream', '--host', '--port'].includes(key) || seen.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid gateway arguments; use --help');
    seen.add(key); options[key.slice(2)] = args[index + 1];
  }
  if (typeof options.host !== 'string' || !options.host || /[\s/]/.test(options.host)) throw new Error('invalid listen host');
  if (!/^[0-9]{1,5}$/.test(String(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error('invalid listen port');
  const server = createGateway(options);
  server.on('error', () => { process.stderr.write('Gateway could not listen.\n'); process.exitCode = 1; });
  server.listen(Number(options.port), options.host, () => {
    const address = server.address();
    process.stdout.write('Listening on http://' + (address.family === 'IPv6' ? '[' + address.address + ']' : address.address) + ':' + address.port + '\n');
  });
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { createGateway };
