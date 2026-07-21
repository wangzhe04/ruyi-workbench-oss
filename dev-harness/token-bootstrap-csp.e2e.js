'use strict';
/*
 * E2E (第47波47c): S1 token Bootstrap + S3 CSP -- token 不再随 HTML 明文下发。
 *
 *  S1 核心安全属性:
 *   ① 浏览器导航(UA 含 Mozilla / 带 Origin / sec-fetch-dest)GET / -> HTML 里 wcw-token content 为空
 *      (view-source/缓存/抓包 HTML 均不可得 token);
 *   ② 非浏览器(无 UA,curl/node e2e/MCP child)GET / -> 仍明文注入 token(向后兼容,信任面同旧规);
 *   ③ POST /api/bootstrap(open 级,无 token)loopback -> {ok:true, token} -- 浏览器拿 token 的唯一通道;
 *   ④ rebinding(Host=攻击域)POST /api/bootstrap -> 403(顶层 host 门挡,token 不外泄给反弹域名);
 *   ⑤ bootstrap 拿到的 token 能通过 /api/sessions 的 token-browser 鉴权(闭环可用)。
 *  S3:CSP meta 在 HTML 头,connect-src 'self'(阻断外泄)+ script-src 排除外域 + object-src 'none'。
 *  S 静态锁:bootstrap handler / initToken / serveStatic browserNav 分支 / ROUTE_AUTH open 条目。
 *
 * Run: node dev-harness/token-bootstrap-csp.e2e.js
 */
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-token-bootstrap-csp');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function req(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, timeout: 4000, headers: h }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
let PORT = 0;
async function up() { for (let i = 0; i < 50; i++) { try { const r = await req('GET', '/health', {}); if (r.status === 200) return true; } catch {} await sleep(120); } return false; }

(async () => {
  // ── S 段: 静态锁 ──
  console.log('── S 段: 静态锁 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  const net = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'net.js'), 'utf8');
  const app = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
  ok(src.includes("pathname === '/api/bootstrap'") && /json\(\{ ok: true, token: RUNTIME\.token/.test(src), 'S1 /api/bootstrap handler 在(返 token)');
  ok(src.includes("{ m: 'POST', p: '/api/bootstrap', auth: 'open' }"), 'S2 ROUTE_AUTH bootstrap open 条目在');
  ok(/browserNav = Boolean\(h\['sec-fetch-dest'\]\)/.test(src) && /browserNav \? '' :/.test(src), 'S3 serveStatic 浏览器导航分支不下发明文 token');
  ok(net.includes('export async function initToken') && net.includes("fetch('/api/bootstrap'") && net.includes("sessionStorage.setItem('wcw.token'"), 'S4 net.js initToken 握手 + sessionStorage 存储');
  ok(app.includes('await initToken();'), 'S5 app.js boot 调 initToken(在任何 api 前)');
  ok(/<meta http-equiv="Content-Security-Policy"/.test(html) && html.includes("connect-src 'self'") && html.includes("object-src 'none'"), 'S6 CSP meta 在(connect-src self + object-src none)');

  // ── 起服务 ──
  PORT = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '2.0.0', permissionMode: 'bypass' }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(), 'workbench up');
    const goodHost = `127.0.0.1:${PORT}`;

    // ── ① 浏览器导航:HTML token 为空 ──
    console.log('── S1 段: token 不随 HTML 明文下发(浏览器) ──');
    const browserUAs = [
      { name: 'Edge UA', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Edge/120.0' } },
      { name: 'Origin 头', headers: { Origin: `http://127.0.0.1:${PORT}` } },
      { name: 'sec-fetch-dest', headers: { 'sec-fetch-dest': 'document' } },
    ];
    let realToken = '';
    for (const { name, headers } of browserUAs) {
      const r = await req('GET', '/', { Host: goodHost, ...headers });
      const m = r.body.match(/name="wcw-token"\s+content="([a-f0-9]*)"/);
      ok(!!m && m[1] === '', `① 浏览器导航(${name})HTML wcw-token content 为空(不下发明文) got "${m ? m[1] : '(无 meta)'}"`);
    }
    // ── ② 非浏览器:仍明文注入(向后兼容) ──
    const r2 = await req('GET', '/', { Host: goodHost }); // node http 无 UA/Origin/sec-fetch
    const m2 = r2.body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/);
    ok(!!m2 && m2[1].length >= 16, `② 非浏览器 GET / 仍明文注入 token(向后兼容,e2e/CLI 信任面同旧) got "${m2 ? m2[1].slice(0, 8) + '…' : '(无)'}"`);
    realToken = m2 ? m2[1] : '';

    // ── ③ POST /api/bootstrap loopback -> token ──
    const r3 = await req('POST', '/api/bootstrap', { Host: goodHost });
    let bootToken = '';
    try { const j = JSON.parse(r3.body); bootToken = j.token || ''; } catch {}
    ok(r3.status === 200 && bootToken === realToken, `③ POST /api/bootstrap loopback -> 返真 token(浏览器唯一通道) got status=${r3.status} token="${bootToken.slice(0, 8)}…"`);

    // ── ④ rebinding Host -> 403 ──
    const r4 = await req('POST', '/api/bootstrap', { Host: `evil.example:${PORT}` });
    ok(r4.status === 403 && !r4.body.includes(realToken), `④ rebinding Host POST /api/bootstrap -> 403 且不泄 token got ${r4.status}`);

    // ── ⑤ bootstrap token 通过 token-browser 鉴权(闭环) ──
    const r5 = await req('GET', '/api/sessions', { Host: goodHost, Origin: `http://127.0.0.1:${PORT}`, 'x-wcw-token': bootToken });
    ok(r5.status === 200, `⑤ bootstrap 拿到的 token 通过 /api/sessions 鉴权(闭环可用) got ${r5.status}`);
    const r5b = await req('GET', '/api/sessions', { Host: goodHost, Origin: `http://127.0.0.1:${PORT}`, 'x-wcw-token': 'wrong-token' });
    ok(r5b.status === 403, `⑤b 错 token 被拒(bootstrap token 是真凭据,非放行一切) got ${r5b.status}`);

    // ── S3 CSP 在 HTML 头 ──
    console.log('── S3 段: CSP ──');
    ok(r2.body.includes('Content-Security-Policy') && r2.body.includes("connect-src 'self'"), 'S3a HTML 含 CSP meta 且 connect-src self');
    ok(r2.body.includes("object-src 'none'") && r2.body.includes("script-src 'self'"), 'S3b CSP object-src none + script-src self(排外域)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nTOKEN BOOTSTRAP+CSP E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
