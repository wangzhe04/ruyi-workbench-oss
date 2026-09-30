'use strict';
// http_request / web_search 的健壮性与错误形状(审计 NE-11)。全部走本机假服务器,不外连。
//   [R1] POST 带 Content-Length、不走 chunked;对象体按 JSON 序列化并补 content-type
//   [R2] timeoutMs 是整个请求的硬期限(对端每 400ms 滴一个字节也拦得住);httpGetGuarded 的 totalTimeoutMs 同理
//   [R3] 4xx / 5xx 带 error:'HTTP <status>' + statusCode + body;连接失败带 failClass / hint;坏 URL 返回 {ok:false} 不抛
//   [R4] web_search:searxng 200 却是 HTML → ok:false 并说明;403 给 json 格式提示;有效 JSON 的零结果仍是 ok:true
//   [R5] API-key 后端失败:默认【不】回退公网内置搜索(不外发查询词),searchBackend.fallbackToBuiltin:true 才回退并带 fallbackFrom;
//        内置也没结果 → 原错误 + fallbackTried;searxng / custom 永不回退(内网或带域名的自托管端点都一样)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-http-robust-'));
process.env.RUYI_HOME = root;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[k];
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const ctx = () => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd: root } });
const call = (name, args) => srv.toolCall(name, args, ctx());

const servers = [];
async function serve(handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(async () => { for (const s of servers) { await new Promise(r => { s.close(r); if (s.closeAllConnections) s.closeAllConnections(); }); } fs.rmSync(root, { recursive: true, force: true }); });
const elapsedMs = t0 => Number(process.hrtime.bigint() - t0) / 1e6;

test('[R1] 字符串请求体带 Content-Length,不发 Transfer-Encoding: chunked', async () => {
  const seen = [];
  const base = await serve((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { seen.push({ te: req.headers['transfer-encoding'], cl: req.headers['content-length'], ct: req.headers['content-type'], body }); res.end('ok'); });
  });
  const str = '{"k":"中文值"}';
  await call('http_request', { url: base + '/s', method: 'POST', body: str, headers: { 'content-type': 'application/json' } });
  assert.equal(seen[0].te, undefined, '不是 chunked');
  assert.equal(seen[0].cl, String(Buffer.byteLength(str)), 'Content-Length 是字节数(中文 3 字节)');
  assert.equal(seen[0].body, str);
  // 调用方自己给了 content-length 就不覆盖。
  await call('http_request', { url: base + '/s2', method: 'POST', body: 'abc', headers: { 'Content-Length': '3' } });
  assert.equal(seen[1].cl, '3');
});

test('[R1] 对象体按 JSON 序列化,没给 content-type 就补 application/json', async () => {
  const seen = [];
  const base = await serve((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { seen.push({ cl: req.headers['content-length'], ct: req.headers['content-type'], body }); res.end('ok'); });
  });
  await call('http_request', { url: base + '/o', method: 'POST', body: { a: 1, b: ['x'] } });
  assert.equal(seen[0].body, '{"a":1,"b":["x"]}', '修前是 "[object Object]"');
  assert.equal(seen[0].ct, 'application/json');
  assert.equal(seen[0].cl, String(seen[0].body.length));
});

test('[R2] timeoutMs 是硬期限:对端每 400ms 滴一个字节也在期限附近返回', async () => {
  const base = await serve((req, res) => {
    res.writeHead(200);
    let n = 0;
    const iv = setInterval(() => { res.write('x'); if (++n >= 25) { clearInterval(iv); res.end(); } }, 400);
    res.on('close', () => clearInterval(iv));
  });
  const t0 = process.hrtime.bigint();
  const r = await call('http_request', { url: base + '/trickle', timeoutMs: 1000 });
  const ms = elapsedMs(t0);
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout after 1000ms \(total\)/);
  assert.equal(r.failClass, 'timeout');
  assert.ok(ms < 2500, `修前要 ~10 秒(idle 计时被每个字节重置),现在 ${Math.round(ms)}ms`);
});

test('[R2] httpGetGuarded 的 totalTimeoutMs 给整条链一个硬期限;不传时仍只是空闲超时', async () => {
  const base = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let n = 0;
    const iv = setInterval(() => { res.write('y'); if (++n >= 25) { clearInterval(iv); res.end(); } }, 200);
    res.on('close', () => clearInterval(iv));
  });
  const t0 = process.hrtime.bigint();
  const r = await srv.httpGetGuarded(base + '/t', { timeoutMs: 1000, totalTimeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.equal(r.failClass, 'timeout');
  assert.match(r.error, /\(total\)/);
  assert.ok(elapsedMs(t0) < 2000);
  const ok = await srv.httpGetGuarded(base + '/t2', { timeoutMs: 1000 });
  assert.equal(ok.ok, true, '没有 totalTimeoutMs 时,持续有数据的响应可以跑完(下载大文件靠这个)');
  assert.equal(ok.body.length, 25);
});

test('[R3] 4xx / 5xx 带 error 与 statusCode、body;连接失败带 failClass 与 hint;坏 URL 不抛', async () => {
  const base = await serve((req, res) => {
    const code = Number(req.url.slice(1)) || 200;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end('{"err":"nope"}');
  });
  const r404 = await call('http_request', { url: base + '/404' });
  assert.equal(r404.ok, false);
  assert.equal(r404.error, 'HTTP 404');
  assert.equal(r404.statusCode, 404);
  assert.equal(r404.body, '{"err":"nope"}', '错误页的 body 仍然给模型看');
  const r503 = await call('http_request', { url: base + '/503' });
  assert.equal(r503.error, 'HTTP 503');
  const r200 = await call('http_request', { url: base + '/200' });
  assert.equal(r200.ok, true);
  assert.ok(!('error' in r200));
  const r302 = await call('http_request', { url: base + '/302' });
  assert.equal(r302.redirected, true, '3xx 保持原样(不跟随,ok:true)');

  const refused = await call('http_request', { url: 'http://127.0.0.1:1/' });
  assert.equal(refused.ok, false);
  assert.equal(refused.failClass, 'connect');
  assert.ok(refused.hint, '连接失败给出下一步提示');
  assert.match(refused.error, /ECONNREFUSED/, '底层错误细节保留');

  const bad = await call('http_request', { url: 'ftp://x/y' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /http/);
});

// ── web_search ─────────────────────────────────────────────────────────────────────────────────────────
const BING_HTML = '<html><body><ol id="b_results">'
  + '<li class="b_algo"><h2><a href="https://found.example/a">Builtin Found A</a></h2><div class="b_caption"><p>snippet a</p></div></li>'
  + '<li class="b_algo"><h2><a href="https://found.example/b">Builtin Found B</a></h2><div class="b_caption"><p>snippet b</p></div></li>'
  + '</ol></body></html>';

test('[R4] searxng 200 却是 HTML(登录页 / WAF)→ ok:false 并说明,不是静默 results:[]', async () => {
  const base = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>please login</html>'); });
  const r = await srv.webSearch({ query: 'x' }, { searchBackend: { type: 'searxng', baseUrl: base } });
  assert.equal(r.ok, false);
  assert.equal(r.parseFailed, true);
  assert.match(r.error, /不是 JSON/);
  assert.match(r.hint, /search\.formats/);
  assert.equal(r.backend, 'searxng');
});

test('[R4] searxng 403 → 提示启用 json 格式;401 / 429 各有提示;有效 JSON 的零结果仍是 ok:true', async () => {
  const base = await serve((req, res) => {
    const u = new URL(req.url, 'http://x');
    const st = Number(u.searchParams.get('q'));
    if (st) { res.writeHead(st); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const cfg = { searchBackend: { type: 'searxng', baseUrl: base } };
  const r403 = await srv.webSearch({ query: '403' }, cfg);
  assert.equal(r403.ok, false);
  assert.equal(r403.statusCode, 403);
  assert.match(r403.hint, /search\.formats/);
  const deny = await serve((req, res) => { res.writeHead(req.url.startsWith('/search') ? 401 : 429); res.end('no'); });
  const r401 = await srv.webSearch({ query: 'q' }, { searchBackend: { type: 'tavily', baseUrl: deny, apiKey: 'k', builtinBaseUrl: 'http://127.0.0.1:1' } });
  assert.equal(r401.statusCode, 401);
  assert.match(r401.hint, /API Key/);
  const r429 = await srv.webSearch({ query: 'q' }, { searchBackend: { type: 'bocha', baseUrl: deny, apiKey: 'k', builtinBaseUrl: 'http://127.0.0.1:1' } });
  assert.equal(r429.statusCode, 429);
  assert.match(r429.hint, /限流|额度/);
  const empty = await srv.webSearch({ query: 'nothing' }, cfg);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.results, []);
});

test('[R5] API-key 后端失败:默认不回退(查询词不外发),fallbackSkipped 说明原因与开关', async () => {
  let builtinHit = 0;
  const bing = await serve((req, res) => { builtinHit++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(BING_HTML); });
  const tavily = await serve((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"detail":"bad key"}'); });
  for (const type of ['tavily', 'bocha', 'brave', 'bing']) {
    const r = await srv.webSearch({ query: 'private query' }, { searchBackend: { type, baseUrl: tavily, apiKey: 'wrong', builtinBaseUrl: bing } });
    assert.equal(r.ok, false, type);
    assert.equal(r.backend, type);
    assert.match(r.fallbackSkipped || '', /没有回退/, type);
    assert.match(r.hint || '', /fallbackToBuiltin/, type);
    assert.ok(!('fallbackFrom' in r), type);
  }
  assert.equal(builtinHit, 0, '内置(公网)引擎一次都没有被请求');
});

test('[R5] searchBackend.fallbackToBuiltin 落得进配置(缺省关、只在 true 时保留)', () => {
  const { normalizeConfig } = srv;
  const on = normalizeConfig({ searchBackend: { type: 'tavily', baseUrl: '', apiKey: '', fallbackToBuiltin: true }, searchBackendMigrated: true });
  assert.equal(on.config.searchBackend.fallbackToBuiltin, true);
  const off = normalizeConfig({ searchBackend: { type: 'tavily', baseUrl: '', apiKey: '', fallbackToBuiltin: 'yes' }, searchBackendMigrated: true });
  assert.ok(!('fallbackToBuiltin' in off.config.searchBackend));
});

test('[R5] fallbackToBuiltin:true → 回退内置搜索,带 fallbackFrom / fallbackReason', async () => {
  const bing = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(BING_HTML); });
  const tavily = await serve((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"detail":"bad key"}'); });
  const cfg = { searchBackend: { type: 'tavily', baseUrl: tavily, apiKey: 'wrong', builtinBaseUrl: bing, fallbackToBuiltin: true } };
  const r = await srv.webSearch({ query: 'fallback query' }, cfg);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.fallbackFrom, 'tavily');
  assert.equal(r.backend, 'builtin');
  assert.match(r.fallbackReason, /HTTP 401/);
  assert.deepEqual(r.results.map(x => x.url), ['https://found.example/a', 'https://found.example/b']);
  assert.match(r.note, /tavily/);
});

test('[R5] 内置也没结果 → 仍是原错误(带 fallbackTried);后端正常时不回退', async () => {
  const emptyBing = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); });
  const bocha = await serve((req, res) => { res.writeHead(500); res.end('boom'); });
  const r = await srv.webSearch({ query: 'q' }, { searchBackend: { type: 'bocha', baseUrl: bocha, apiKey: 'k', builtinBaseUrl: emptyBing, fallbackToBuiltin: true } });
  assert.equal(r.ok, false);
  assert.equal(r.backend, 'bocha');
  assert.equal(r.fallbackTried, 'builtin');
  assert.equal(r.statusCode, 500);
  const good = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'T', url: 'https://t.example', content: 'c' }] })); });
  const g = await srv.webSearch({ query: 'q' }, { searchBackend: { type: 'tavily', baseUrl: good, apiKey: 'k', builtinBaseUrl: emptyBing, fallbackToBuiltin: true } });
  assert.equal(g.ok, true);
  assert.equal(g.backend, 'tavily');
  assert.ok(!('fallbackFrom' in g));
});

test('[R5] searxng / custom 失败时永不回退(内网地址、带域名的内网主机、即使开了 fallbackToBuiltin)', async () => {
  let builtinHit = 0;
  const bing = await serve((req, res) => { builtinHit++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(BING_HTML); });
  const dead = await serve((req, res) => { res.writeHead(503); res.end('down'); });   // 127.0.0.1 = 内网地址
  for (const type of ['searxng', 'custom']) {
    const r = await srv.webSearch({ query: 'secret internal query' }, { searchBackend: { type, baseUrl: dead, builtinBaseUrl: bing } });
    assert.equal(r.ok, false, type);
    assert.match(r.fallbackSkipped || '', /没有回退/, type);
    // 普通带点域名的自托管端点(修前只豁免 localhost / 私网 IP / .local):连不上也不能把查询词发给公网,开关也不放行。
    const named = await srv.webSearch({ query: 'secret internal query' }, { searchBackend: { type, baseUrl: 'http://searx.corp.example.test:9', builtinBaseUrl: bing, fallbackToBuiltin: true } });
    assert.equal(named.ok, false, type + ' named');
    assert.match(named.fallbackSkipped || '', /没有回退/, type + ' named');
  }
  assert.equal(builtinHit, 0, '内置引擎一次都没有被请求');
});
