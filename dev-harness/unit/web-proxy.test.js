'use strict';
// web_fetch / http_request 经 HTTP(S) 代理出网(审计 NE-10)。假代理是本机 http.Server:普通请求收绝对 URI(http 目标),
// 'connect' 事件收 CONNECT 隧道(https 目标)。目标域名全是 *.example.test —— 本机解析不了,能通只可能是代理解析的。
//   [P1] http 目标:绝对 URI 请求发给代理(Host 头是目标、user:pass@ 变 Proxy-Authorization),不做本机 DNS 预检
//   [P2] https 目标:CONNECT host:443 → 叠 TLS(openssl 生成自签证书,子进程用 NODE_EXTRA_CA_CERTS 信任;没有 openssl 则跳过)
//   [P3] 代理拒绝 CONNECT / 代理连不上:failClass 'proxy',说明是代理的问题,不说「域名解析失败」也不说「疑似离线」
//   [P4] NO_PROXY(后缀 / *. / host:port / CIDR / *)与默认直连(回环、私网、单标签主机名)
//   [P5] SSRF 护栏在走代理时仍然有效:私网字面量不发包、重定向到元数据地址被拦
//   [P6] http_request 同样走代理
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const cp = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-web-proxy-'));
process.env.RUYI_HOME = root;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
process.env.WCW_TEST_NO_NET_ANCHORS = '1'; // 失败后的「疑似离线」探测不外连
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const clearProxyEnv = () => { for (const k of PROXY_VARS) delete process.env[k]; };
clearProxyEnv();
const SERVER_JS = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
const srv = require(SERVER_JS);

const ctx = () => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd: root } });
const call = (name, args) => srv.toolCall(name, args, ctx());
const closers = [];
after(async () => { clearProxyEnv(); for (const c of closers) await c(); fs.rmSync(root, { recursive: true, force: true }); });
// 关的时候把所有原始连接(含 CONNECT 隧道的 socket —— http.Server 的 closeAllConnections 管不到它们)一并销毁,否则 close 回调不来。
const listen = server => new Promise(r => {
  const socks = new Set();
  server.on('connection', c => { socks.add(c); c.on('close', () => socks.delete(c)); });
  server.listen(0, '127.0.0.1', () => {
    closers.push(() => new Promise(res => { for (const c of socks) c.destroy(); server.close(res); }));
    r(server.address().port);
  });
});

// 假代理。mode: 'ok' | 'deny'(CONNECT 回 403)。tlsPort:CONNECT 成功时把隧道接到这个本机端口。
async function startProxy({ mode = 'ok', tlsPort = 0, redirectTo = '' } = {}) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ kind: 'http', url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || '', method: req.method, headers: req.headers });
    if (redirectTo && req.url.includes('/redir')) { res.writeHead(302, { location: redirectTo }); res.end(); return; }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': req.url.includes('/api') ? 'application/json' : 'text/html; charset=utf-8' });
      res.end(req.url.includes('/api') ? JSON.stringify({ via: 'proxy', url: req.url, body }) : `<html><head><title>via proxy</title></head><body><p>proxied ${req.url}</p></body></html>`);
    });
  });
  s.on('connect', (req, client, head) => {
    seen.push({ kind: 'connect', url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || '' });
    if (mode === 'deny' || !tlsPort) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const up = net.connect(tlsPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  const port = await listen(s);
  return { port, seen, url: 'http://127.0.0.1:' + port };
}
// 一个立刻关掉的端口:必然 ECONNREFUSED。
async function deadPort() {
  const s = net.createServer();
  const port = await new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  await new Promise(r => s.close(r));
  return port;
}

test('[P1] http 目标经代理:绝对 URI + Host + Proxy-Authorization,不做本机 DNS', async () => {
  const proxy = await startProxy();
  clearProxyEnv();
  process.env.HTTP_PROXY = `http://user:p%40ss@127.0.0.1:${proxy.port}`;
  const r = await srv.webFetch({ url: 'http://web.example.test:8081/a/b?q=1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.viaProxy, true);
  assert.equal(r.title, 'via proxy');
  assert.match(r.text, /proxied http:\/\/web\.example\.test:8081\/a\/b\?q=1/);
  assert.equal(proxy.seen.length, 1);
  assert.equal(proxy.seen[0].url, 'http://web.example.test:8081/a/b?q=1', '请求行是绝对 URI');
  assert.equal(proxy.seen[0].host, 'web.example.test:8081', 'Host 头是目标');
  assert.equal(proxy.seen[0].auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'), 'user:pass@ → Proxy-Authorization');
  clearProxyEnv();
});

test('[P1] 没配代理时同一个网址直连失败(对照:证明上面的成功来自代理)', async () => {
  clearProxyEnv();
  const r = await call('http_request', { url: 'http://web.example.test:8081/direct-control', timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.notEqual(r.failClass, 'proxy');
});

// ── [P2] ────────────────────────────────────────────────────────────────────────────────────────────────
function opensslCert(dir, host) {
  const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  const r = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host], { encoding: 'utf8' });
  return r.status === 0 ? { key: fs.readFileSync(key), cert: fs.readFileSync(crt), certPath: crt } : null;
}
test('[P2] https 目标经 CONNECT 隧道:代理只看到 host:443,TLS 端到端', async t => {
  const pki = opensslCert(root, 'secure.example.test');
  if (!pki) { t.skip('本机没有 openssl,跳过 TLS 端到端'); return; }
  const target = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>secure</title></head><body><p>hello over tunnel ${req.url}</p><a href="/next">next</a></body></html>`);
  });
  const tlsPort = await listen(target);
  const proxy = await startProxy({ tlsPort });
  const script = `const s=require(${JSON.stringify(SERVER_JS)});s.webFetch({url:'https://secure.example.test/page?x=1'}).then(r=>{console.log(JSON.stringify(r));process.exit(0)})`;
  const env = Object.assign({}, process.env, { RUYI_HOME: path.join(root, 'child-home'), HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: pki.certPath, WCW_TEST_NO_NET_ANCHORS: '1' });
  for (const k of PROXY_VARS) if (k !== 'HTTPS_PROXY') delete env[k];
  const out = await new Promise((resolve, reject) => {
    const c = cp.spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let so = '', se = '';
    c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; });
    c.on('close', () => resolve({ so, se }));
    c.on('error', reject);
  });
  const r = JSON.parse(out.so.trim().split('\n').pop());
  assert.equal(r.ok, true, out.so + out.se);
  assert.equal(r.viaProxy, true);
  assert.match(r.text, /hello over tunnel \/page\?x=1/);
  assert.deepEqual(r.links, ['[1] https://secure.example.test/next']);
  assert.deepEqual(proxy.seen.map(x => x.kind + ' ' + x.url), ['connect secure.example.test:443'], '代理只看到 CONNECT host:443');
});

// ── [P3] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[P3] 代理拒绝 CONNECT → failClass proxy,说明是代理的问题', async () => {
  const proxy = await startProxy({ mode: 'deny' });
  clearProxyEnv();
  process.env.HTTPS_PROXY = proxy.url;
  const r = await srv.webFetch({ url: 'https://denied.example.test/x' });
  assert.equal(r.ok, false);
  assert.equal(r.failClass, 'proxy');
  assert.match(r.error, /CONNECT denied\.example\.test:443.*403/);
  assert.match(r.hint, /HTTPS_PROXY/);
  assert.ok(!/离线|解析失败/.test(r.error + r.hint), '不误报离线 / 域名解析失败');
  clearProxyEnv();
});

test('[P3] 代理本身连不上(http / https 目标)→ failClass proxy,错误里带代理地址', async () => {
  const port = await deadPort();
  clearProxyEnv();
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `127.0.0.1:${port}`; // 不带协议头也认
  for (const url of ['http://a.example.test/', 'https://a.example.test/']) {
    const r = await srv.webFetch({ url });
    assert.equal(r.ok, false, url);
    assert.equal(r.failClass, 'proxy', url);
    assert.ok(r.error.includes('127.0.0.1:' + port), r.error);
    assert.ok(!/离线/.test(r.hint), r.hint);
  }
  clearProxyEnv();
});

// ── [P4] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[P4] NO_PROXY:后缀 / *. / host:port / CIDR / * 直连;端口不符仍走代理', async () => {
  const proxy = await startProxy();
  const viaProxy = async (url, noProxy) => {
    clearProxyEnv();
    process.env.HTTP_PROXY = proxy.url;
    if (noProxy !== undefined) process.env.NO_PROXY = noProxy;
    const before = proxy.seen.length;
    const r = await call('http_request', { url, timeoutMs: 400 }); // 直连那一支不能等真实 DNS / 真实网络:硬期限 400ms
    return { went: proxy.seen.length > before, r };
  };
  assert.equal((await viaProxy('http://n.example.test/', undefined)).went, true, '基线:走代理');
  assert.equal((await viaProxy('http://n.example.test/', 'example.test')).went, false, '域名后缀');
  assert.equal((await viaProxy('http://n.example.test/', '.example.test')).went, false, '.后缀');
  assert.equal((await viaProxy('http://n.example.test/', 'foo.com, *.example.test')).went, false, '*. 通配 + 逗号空格分隔');
  assert.equal((await viaProxy('http://n.example.test:8081/', 'n.example.test:8081')).went, false, 'host:port 命中');
  assert.equal((await viaProxy('http://n.example.test:8082/', 'n.example.test:8081')).went, true, 'host:port 端口不符仍走代理');
  assert.equal((await viaProxy('http://n.example.test/', '*')).went, false, '*');
  assert.equal((await viaProxy('http://8.8.8.8/', '8.8.0.0/16')).went, false, 'IPv4 CIDR 命中');
  assert.equal((await viaProxy('http://9.9.9.9/', '8.8.0.0/16')).went, true, 'IPv4 CIDR 不命中仍走代理');
  assert.equal((await viaProxy('http://n.example.test/', 'other.test')).went, true, '不相干的 NO_PROXY 不影响');
  const lower = async () => { clearProxyEnv(); process.env.http_proxy = proxy.url; const b = proxy.seen.length; await call('http_request', { url: 'http://l.example.test/', timeoutMs: 400 }); return proxy.seen.length > b; };
  assert.equal(await lower(), true, '小写 http_proxy 也认');
  clearProxyEnv();
});

test('[P4] 默认直连:回环、单标签主机名、*.local、私网 IP 不走代理', async () => {
  const proxy = await startProxy();
  const local = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('direct loopback ok'); });
  const lp = await listen(local);
  clearProxyEnv();
  process.env.HTTP_PROXY = proxy.url;
  const r = await srv.webFetch({ url: `http://127.0.0.1:${lp}/x` });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'direct loopback ok');
  assert.ok(!r.viaProxy);
  const h = await call('http_request', { url: `http://127.0.0.1:${lp}/y` });
  assert.equal(h.body, 'direct loopback ok');
  // 单标签主机名 / 私网 IP / *.local:直连(连不上无所谓,硬期限 300ms),一次都不该经过代理。
  for (const u of ['http://intranet-host/x', 'http://192.168.9.9:9/x', 'http://printer.local/x']) await call('http_request', { url: u, timeoutMs: 300 });
  assert.equal(proxy.seen.length, 0, '一次都没有经过代理:' + JSON.stringify(proxy.seen.map(x => x.url)));
  clearProxyEnv();
});

// ── [P5] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[P5] 走代理时 SSRF 护栏仍在:私网字面量不发包;重定向到元数据地址被拦', async () => {
  const proxy = await startProxy({ redirectTo: 'http://169.254.169.254/latest/meta-data/' });
  clearProxyEnv();
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = proxy.url;
  for (const url of ['http://10.0.0.1/x', 'http://169.254.169.254/x', 'http://localhost/x', 'https://svc.internal/x']) {
    const r = await srv.webFetch({ url });
    assert.equal(r.ok, false, url);
    assert.ok(r.blocked, url);
  }
  assert.equal(proxy.seen.length, 0, '被拦的网址没有发给代理');
  const red = await srv.webFetch({ url: 'http://r.example.test/redir' });
  assert.equal(red.ok, false);
  assert.ok(red.blocked, '重定向后的元数据地址被逐跳复查拦下:' + JSON.stringify(red));
  assert.equal(proxy.seen.length, 1, '只有第一跳发给了代理');
  clearProxyEnv();
});

// ── [P6] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[P6] http_request 经代理:POST 带 Content-Length,响应回来', async () => {
  const proxy = await startProxy();
  clearProxyEnv();
  process.env.HTTP_PROXY = proxy.url;
  const r = await call('http_request', { url: 'http://api.example.test/api/echo', method: 'POST', body: '{"k":"值"}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.viaProxy, true);
  const j = JSON.parse(r.body);
  assert.equal(j.url, 'http://api.example.test/api/echo');
  assert.equal(j.body, '{"k":"值"}');
  assert.equal(proxy.seen[0].headers['content-length'], String(Buffer.byteLength('{"k":"值"}')));
  clearProxyEnv();
});
