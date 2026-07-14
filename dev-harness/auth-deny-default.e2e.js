// E2E (第33波): 全 GET 面 host 校验 + 声明式 auth 路由表 deny-by-default。
// 验 four things:
//   (A) 顶层 hostAllowed 门:rebinding(Host=evil)对 GET / 与 GET /api/status 一律 403(治第29波 backlog #0:
//       之前 GET 跳过 originOk/hostAllowed,serveStatic 把含 token 的 index.html 服务给任意 Host)。
//   (B) deny-by-default:未声明路由 /api/typo -> 403(非 404),治 S0 教训 opt-in 名单根因。
//   (C) GET 面泄露收紧:GET /api/agent-roles|agent-workflows|playbooks(原无 host 门+无 token 门)现为
//       token-browser(浏览器须 token;loopback 非浏览器须同源,无需 token),与 sessions/skills 同纪律。
//   (D) 回归:各鉴权级别语义不变——open(status)/token-browser(sessions,loopback 豁免)/token(agent-runs,始终须 token)。
// 连接始终打 127.0.0.1:PORT,仅 Host/Origin/token 头手工构造。端口 9126。无需 fake provider。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-auth-deny-e2e');
const PORT = 9126;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function scrapeToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
// 任意方法+路径+头,连接 127.0.0.1:PORT(Host 头可伪造=rebinding 形)。resolves {status, body}。
function probe(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, timeout: 4000, headers: h }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT); }
    ok(!!h, 'workbench up on :' + PORT);
    const token = await scrapeToken(PORT);
    ok(!!token, 'UI token scraped from GET / (loopback)');
    const goodHost = `127.0.0.1:${PORT}`;
    const origin = `http://127.0.0.1:${PORT}`;
    const evilHost = `evil.example:${PORT}`;
    const evilOrigin = `http://evil.example:${PORT}`;

    // ── (A) 顶层 host 门:rebinding 对 GET / 与 GET /api/status 一律 403 ──
    console.log('── A 段: 顶层 host 门(rebinding 覆盖 GET 面 + 静态 /) ──');
    const a1 = await probe(PORT, 'GET', '/', { Host: evilHost });
    ok(a1.status === 403, 'A1 GET / Host=evil -> 403 (index.html 不服务给 rebinding,治 token 泄露主链) got ' + a1.status);
    ok(!a1.body.includes(token), 'A2 GET / Host=evil body 不含 token (rebinding 拿不到 token)');
    const a3 = await probe(PORT, 'GET', '/', { Host: goodHost });
    ok(a3.status === 200 && a3.body.includes(token), 'A3 GET / Host=loopback -> 200 + 含 token (合法 UI 不受影响)');
    const a4 = await probe(PORT, 'GET', '/api/status', { Host: evilHost });
    ok(a4.status === 403, 'A4 GET /api/status Host=evil -> 403 (GET 面也 host 校验) got ' + a4.status);
    const a5 = await probe(PORT, 'GET', '/api/status', { Host: goodHost });
    ok(a5.status === 200, 'A5 GET /api/status Host=loopback 无 token -> 200 (open 级别) got ' + a5.status);

    // ── (B) deny-by-default:未声明路由 -> 403(非 404) ──
    console.log('── B 段: deny-by-default ──');
    const b1 = await probe(PORT, 'GET', '/api/this-route-does-not-exist', { Host: goodHost, Origin: origin, 'x-wcw-token': token });
    ok(b1.status === 403, 'B1 GET /api/typo(未声明) -> 403 deny-by-default (非 404) got ' + b1.status);

    // ── (C) GET 面泄露收紧:agent-roles/agent-workflows/playbooks 现 token-browser ──
    console.log('── C 段: 3 个 GET 收紧(token-browser,原无 host 门+无 token 门) ──');
    for (const p of ['/api/agent-roles', '/api/agent-workflows', '/api/playbooks']) {
      const cBrowserNoToken = await probe(PORT, 'GET', p, { Host: goodHost, Origin: origin });
      ok(cBrowserNoToken.status === 403, 'C ' + p + ' 浏览器(Origin)无 token -> 403 got ' + cBrowserNoToken.status);
      const cBrowserToken = await probe(PORT, 'GET', p, { Host: goodHost, Origin: origin, 'x-wcw-token': token });
      ok(cBrowserToken.status === 200, 'C ' + p + ' 浏览器(Origin)+token -> 200 got ' + cBrowserToken.status);
      const cLoopbackNoToken = await probe(PORT, 'GET', p, { Host: goodHost });
      ok(cLoopbackNoToken.status === 200, 'C ' + p + ' loopback 非浏览器无 token -> 200 (豁免,与 sessions 同纪律) got ' + cLoopbackNoToken.status);
      const cEvilToken = await probe(PORT, 'GET', p, { Host: evilHost, Origin: evilOrigin, 'x-wcw-token': token });
      ok(cEvilToken.status === 403, 'C ' + p + ' rebinding(Host=evil)+token -> 403 (host 门挡,即便偷到 token) got ' + cEvilToken.status);
    }

    // ── (D) 回归:各鉴权级别语义不变 ──
    console.log('── D 段: 鉴权级别回归 ──');
    // open: status 无 token 放行(已验 A5)
    // token-browser GET: sessions
    const d1 = await probe(PORT, 'GET', '/api/sessions', { Host: goodHost, Origin: origin, 'x-wcw-token': token });
    ok(d1.status === 200, 'D1 GET /api/sessions 浏览器+token -> 200 got ' + d1.status);
    const d2 = await probe(PORT, 'GET', '/api/sessions', { Host: goodHost, Origin: origin });
    ok(d2.status === 403, 'D2 GET /api/sessions 浏览器无 token -> 403 got ' + d2.status);
    // token-browser POST: sessions loopback 豁免(dns-rebind test 5 同构)
    const d3 = await probe(PORT, 'POST', '/api/sessions', { Host: goodHost }, { title: 'auth-deny probe', cwd: HOME });
    ok(d3.status === 200, 'D3 POST /api/sessions loopback 无 Origin 无 token -> 200 (loopback 豁免保持) got ' + d3.status);
    // token GET: agent-runs 始终须 token
    const d4 = await probe(PORT, 'GET', '/api/agent-runs', { Host: goodHost });
    ok(d4.status === 403, 'D4 GET /api/agent-runs 无 token -> 403 (token 级别始终须) got ' + d4.status);
    const d5 = await probe(PORT, 'GET', '/api/agent-runs', { Host: goodHost, 'x-wcw-token': token });
    ok(d5.status !== 403, 'D5 GET /api/agent-runs +token -> 非 403 (auth 过,handler 自查放行) got ' + d5.status);
    // token GET: audit 自查(tokenOk 纵深)
    const d6 = await probe(PORT, 'GET', '/api/audit', { Host: goodHost });
    ok(d6.status === 403, 'D6 GET /api/audit 无 token -> 403 (handler 自查纵深) got ' + d6.status);
    const d7 = await probe(PORT, 'GET', '/api/audit', { Host: goodHost, 'x-wcw-token': token });
    ok(d7.status !== 403, 'D7 GET /api/audit +token -> 非 403 (auth 过) got ' + d7.status);
    // body-token: mission loopback 无 header token 但有 body token -> 放行(handler 自查)
    const d8 = await probe(PORT, 'POST', '/api/mission', { Host: goodHost, 'content-type': 'application/json' }, { action: 'check', sessionId: 'sess_nonexistent', token });
    ok(d8.status !== 403, 'D8 POST /api/mission body-token -> 非 403 (body-token 豁免 origin,handler 自查) got ' + d8.status);
    // 第35波：真实 PATCH/DELETE 不能再被 deny-by-default 拦在 handler 之前；带 Origin 的浏览器请求仍必须有 token。
    const realMethodRoutes = [
      { method: 'PATCH', path: '/api/sessions/auth_method_probe', body: {} },
      { method: 'DELETE', path: '/api/sessions/auth_method_probe', body: {} },
      { method: 'DELETE', path: '/api/memory/auth_method_probe', body: { scope: 'global', cwd: HOME } },
      { method: 'DELETE', path: '/api/playbooks/auth_method_probe', body: {} },
      { method: 'DELETE', path: '/api/agent-workflows/auth_method_probe', body: { scope: 'personal', cwd: HOME } },
    ];
    for (const item of realMethodRoutes) {
      const denied = await probe(PORT, item.method, item.path, { Host: goodHost, Origin: origin }, item.body);
      ok(denied.status === 403, `D9 ${item.method} ${item.path} browser without token -> 403 got ${denied.status}`);
      const allowed = await probe(PORT, item.method, item.path, { Host: goodHost, Origin: origin, 'x-wcw-token': token }, item.body);
      ok(allowed.status !== 403, `D9 ${item.method} ${item.path} browser + token reaches handler (got ${allowed.status})`);
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nAUTH-DENY-DEFAULT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
