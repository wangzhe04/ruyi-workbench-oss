'use strict';
// hunt2 · http 区(HTTP 层健壮性)回归锁。每条都是修前能复现的故障:
//   [S1] 分离式外部启动(office_open / browser_open / 代码编辑器 / Kimi 授权网址 / 资源管理器兜底 / --open)
//        找不到程序时 ENOENT 是 ChildProcess 上的【异步】'error' 事件;修前没有监听者 → uncaughtException →
//        服务 process.exit(1),而工具先回了「opened」。spawnDetachedChecked 是它们共用的唯一入口。
//   [S2] createSession 收到非字符串 cwd / title(请求体直传)不再原样落盘(修前 {"cwd":5} 让这条会话每回合都死)。
//   [H*] 起一个真服务打 HTTP:null 请求体、坏百分号编码、坏会话 id、未知工具/工具参数错、带坏 sessionId 的
//        /api/chat/stream、超总闸的 Content-Length、SSE 连接上限 —— 修前全是 500(或挂住/静默新建会话/无界)。
//   [L*] 两条拿不到确定性复现的硬化(子进程 stdin 的 EPIPE、NDJSON 流收尾后的迟到写)只能锁结构:
//        判据本身就是「这段代码必须挂监听/必须先判流已收尾」。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-http-hardening-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const SERVER = path.join(REPO, 'ruyi-workbench', 'app', 'server.js');
const srv = require(SERVER);
const { fixtureChildEnv } = require('../lib/fixture-home');
const { killOwnTree } = require('../lib/kill-own-tree');
const { getFreePort } = require('../free-port.js');
const { functionBlock } = require('../lib/source-slice');

const SRC = path.join(REPO, 'ruyi-workbench', 'app', 'src');
const readSrc = name => fs.readFileSync(path.join(SRC, name), 'utf8');

// ---------------------------------------------------------------------------------------------
test('[S1] spawnDetachedChecked:程序不存在 → {ok:false, code:ENOENT},不成为 uncaughtException', async () => {
  let uncaught = null;
  const onUncaught = e => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  try {
    const missing = path.join(root, 'no-such-launcher-' + process.pid + (process.platform === 'win32' ? '.exe' : ''));
    const r = await srv.spawnDetachedChecked(missing, ['x'], { detached: true, windowsHide: true, stdio: 'ignore' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ENOENT');
    assert.match(String(r.error), /ENOENT/);
    await new Promise(resolve => setTimeout(resolve, 50));   // 给迟到的 'error' 一拍
    assert.equal(uncaught, null, '启动失败不得冒成 uncaughtException');
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('[S1] spawnDetachedChecked:能起的程序 → {ok:true, pid}(成功路径与原 spawn().unref() 同参)', async () => {
  const r = await srv.spawnDetachedChecked(process.execPath, ['-e', ''], { detached: true, windowsHide: true, stdio: 'ignore' });
  assert.equal(r.ok, true);
  assert.ok(Number(r.pid) > 0);
});

test('[S2] createSession:非字符串/空白的 cwd 与 title 当没传', async () => {
  const a = await srv.createSession({ cwd: 5, title: { a: 1 } });
  assert.equal(typeof a.cwd, 'string');
  assert.ok(a.cwd.length > 0);
  assert.equal(a.title, 'New session');
  assert.equal(a.titleSource, undefined, '非法标题不算「人起的名字」');
  const b = await srv.createSession({ cwd: ['x'], title: ['t'] });
  assert.equal(typeof b.cwd, 'string');
  assert.equal(b.title, 'New session');
  const c = await srv.createSession({ cwd: root, title: 'x'.repeat(500) });
  assert.equal(c.cwd, root);
  assert.equal(c.title.length, 200, '标题上限与改名(applySessionMetaPatch)同为 200');
  assert.equal(c.titleSource, 'user');
});

// ---------------------------------------------------------------------------------------------
// 真服务。只起一次,各 [H*] 共用;token 走 /api/bootstrap(与前端同一条握手)。
let child = null, port = 0, token = '', childHome = '', serverLog = '';
function request(method, pathname, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
    const h = { 'x-wcw-token': token, ...headers };
    if (data !== null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h, timeout: 15000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* ndjson 或非 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
    if (data !== null) req.write(data);
    req.end();
  });
}
const errCode = r => (r.json && r.json.error && typeof r.json.error === 'object') ? r.json.error.code : null;

before(async () => {
  const fixture = fixtureChildEnv({ perTest: true });
  childHome = fixture.home;
  port = await getFreePort();
  const env = { ...fixture.env, RUYI_HOME: path.join(childHome, '.ruyi-workbench') };
  delete env.WIN_CLAUDE_WORKBENCH_HOME;
  child = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { serverLog += c; });
  child.stderr.on('data', c => { serverLog += c; });
  const deadline = Date.now() + 45000;
  for (;;) {
    try { const r = await request('GET', '/health'); if (r.status === 200) break; } catch { /* 还没起来 */ }
    if (child.exitCode !== null) throw new Error('server exited early:\n' + serverLog);
    if (Date.now() > deadline) throw new Error('server did not become healthy:\n' + serverLog);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const boot = await request('POST', '/api/bootstrap');
  token = boot.json && boot.json.token;
  assert.ok(token, 'bootstrap token');
});

after(() => {
  try { if (child && child.exitCode === null) killOwnTree(child); } catch { /* already gone */ }
  try { fs.rmSync(childHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('[H1] 请求体是 JSON null → 按空体处理,不再 TypeError 500', async () => {
  for (const [route, want] of [['/api/steer', 400], ['/api/todo', 403], ['/api/mission', null], ['/api/plan/decision', null]]) {
    const r = await request('POST', route, { raw: 'null' });
    assert.ok(r.status < 500, `${route} null 体 → 实 ${r.status} ${r.text.slice(0, 160)}`);
    if (want) assert.equal(r.status, want, `${route}`);
  }
});

test('[H2] 坏百分号编码的路径段 → 4xx,不再 URIError 500', async () => {
  const bg = await request('GET', '/api/sessions/%zz/background');
  assert.equal(bg.status, 400);
  assert.equal(errCode(bg), 'session.id_invalid');
  for (const [method, route] of [['DELETE', '/api/scheduler/tasks/%zz'], ['PATCH', '/api/scheduler/tasks/%zz'],
    ['POST', '/api/scheduler/tasks/%zz/run-now'], ['GET', '/api/scheduler/tasks/%zz/runs']]) {
    const r = await request(method, route, method === 'GET' || method === 'DELETE' ? {} : { body: {} });
    assert.equal(r.status, 404, `${method} ${route} → 实 ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(errCode(r), 'scheduler.not_found');
  }
});

test('[H3] DELETE /api/sessions/<坏 id> → 400 session.id_invalid(不再回假的 ok:true)', async () => {
  const r = await request('DELETE', '/api/sessions/foo.bar');
  assert.equal(r.status, 400);
  assert.equal(errCode(r), 'session.id_invalid');
});

test('[H4] /api/tools:未知工具 404、工具参数错 400,不再 500', async () => {
  const unknown = await request('POST', '/api/tools/no_such_tool', { body: {} });
  assert.equal(unknown.status, 404);
  assert.equal(errCode(unknown), 'tool.unknown');
  const proto = await request('POST', '/api/tools/constructor', { body: {} });
  assert.equal(proto.status, 404, '原型链上的名字也是未知工具');
  const bad = await request('POST', '/api/tools/glob', { body: {} });
  assert.equal(bad.status, 400, `glob 缺 pattern → 实 ${bad.status} ${bad.text.slice(0, 160)}`);
  assert.equal(errCode(bad), 'tool.failed');
  assert.match(bad.json.error.message, /pattern/);
  const good = await request('POST', '/api/tools/file_list', { body: { path: childHome } });
  assert.equal(good.status, 200, '正常调用形状不变');
  assert.equal(good.json.ok, true);
});

test('[H5] /api/chat/stream 带坏 sessionId → 400,不再静默新建一条会话', async () => {
  const before = await request('GET', '/api/sessions');
  const count = (before.json && Array.isArray(before.json.sessions)) ? before.json.sessions.length : -1;
  for (const sessionId of ['foo.bar', 123, { a: 1 }]) {
    const r = await request('POST', '/api/chat/stream', { body: { sessionId, message: 'hi' }, headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 400, `sessionId=${JSON.stringify(sessionId)} → 实 ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(errCode(r), 'session.id_invalid');
  }
  const afterList = await request('GET', '/api/sessions');
  assert.equal(afterList.json.sessions.length, count, '没有新建会话');
});

test('[H6] 非字符串 cwd 不再让 /api/memory* 与会话落盘 500', async () => {
  const meta = await request('POST', '/api/memory/metadata', { body: { cwd: 5 } });
  assert.ok(meta.status < 500, `memory/metadata → 实 ${meta.status} ${meta.text.slice(0, 160)}`);
  const created = await request('POST', '/api/sessions', { body: { cwd: 5, title: { a: 1 } } });
  assert.equal(created.status, 200);
  assert.equal(typeof created.json.session.cwd, 'string');
  assert.equal(created.json.session.title, 'New session');
});

test('[H7] 声明的 Content-Length 超总闸 → 立即 413 api.body_too_large(不先缓冲、不报 internal_error)', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/todo',
      headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': String(200 * 1024 * 1024) }, timeout: 8000 }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => { resolve({ status: res.statusCode, text }); req.destroy(); });
    });
    req.on('error', e => (e && e.code === 'ECONNRESET') ? undefined : reject(e));
    req.on('timeout', () => req.destroy(new Error('timeout: 服务在等 200 MB 的体,没做 Content-Length 预检')));
    req.write('{');   // 只发一个字节:修前服务会一直等剩下的 200 MB
  });
  assert.equal(r.status, 413);
  assert.match(r.text, /api\.body_too_large/);
  const alive = await request('GET', '/health');
  assert.equal(alive.status, 200);
});

test('[H8] office_open 起不来打开程序 → 工具失败,服务不崩(Linux:explorer.exe 不存在)', { skip: process.platform === 'win32' ? 'Windows 上 explorer.exe 真的会弹窗;失败分支由 [S1] 直测' : false }, async () => {
  const r = await request('POST', '/api/tools/office_open', { body: { path: childHome } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.ok, false, `修前回 opened:${r.text.slice(0, 200)}`);
  assert.match(r.json.result.error, /ENOENT/);
  const b = await request('POST', '/api/tools/browser_open', { body: { url: 'https://example.invalid/' } });
  assert.equal(b.status, 200);
  assert.equal(b.json.result.ok, false, 'browser_open 同样如实报失败');
  await new Promise(resolve => setTimeout(resolve, 300));
  const alive = await request('GET', '/health');
  assert.equal(alive.status, 200, '服务还活着');
  assert.equal(child.exitCode, null);
});

test('[H9] /api/events/stream 连接数有上限(第 33 条 → 503),已有连接不受影响', async () => {
  const open = [];
  try {
    for (let i = 0; i < 32; i += 1) {
      open.push(await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events/stream', headers: { 'x-wcw-token': token } }, res => resolve({ req, res }));
        req.on('error', reject);
        req.end();
      }));
    }
    assert.ok(open.every(c => c.res.statusCode === 200), '前 32 条正常');
    const over = await request('GET', '/api/events/stream');
    assert.equal(over.status, 503);
    assert.equal(errCode(over), 'events.too_many_clients');
  } finally {
    for (const c of open) { try { c.req.destroy(); } catch { /* ignore */ } }
  }
  // 断开后名额回来(close 监听器清表)。
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const r = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events/stream', headers: { 'x-wcw-token': token } }, res => { resolve(res.statusCode); req.destroy(); });
      req.on('error', () => resolve(0));
      req.end();
    });
    ok = r === 200;
  }
  assert.ok(ok, '断开之后又能连');
});

// ---------------------------------------------------------------------------------------------
// 结构锁(判据本身是结构性的:这段代码必须挂监听 / 必须先判流已收尾)。
test('[L1] 子进程 stdin 挂了 error 监听(Kimi ACP RPC、PowerShell 会话):EPIPE 不成 uncaughtException', () => {
  const rpc = functionBlock(readSrc('05b-kimi-bridge.js'), 'createKimiAcpRpc');
  assert.ok(rpc.length > 200, '切到 createKimiAcpRpc');
  assert.match(rpc, /child\.stdin\.on\('error'/);
  const shell = functionBlock(readSrc('11-native-tools.js'), 'shellStart');
  assert.ok(shell.length > 200, '切到 shellStart');
  assert.match(shell, /child\.stdin\.on\('error'/);
});

test('[L2] NDJSON 流壳:收尾后的迟到事件不写、res 挂 error 监听(streamChat / 管家运行器)', () => {
  for (const [file, fn] of [['10-context-governance.js', 'streamChat'], ['13h-steward-runner.js', 'handleStewardRunnerApiRoutes']]) {
    const block = functionBlock(readSrc(file), fn);
    assert.ok(block.length > 200, `切到 ${fn}`);
    const guards = block.match(/if \(res\.writableEnded \|\| res\.destroyed\) return;/g) || [];
    assert.ok(guards.length >= 2, `${fn}:flushDeltas 与 writeEvent 都先判流已收尾(实 ${guards.length})`);
    assert.match(block, /res\.on\('error', \(\) => \{\}\)/, `${fn}:res 上挂 error 监听`);
  }
});

test('[L3] agent-runs digest 轮询不再深拷贝 live run(只读标量,浅展开等值)', () => {
  const block = functionBlock(readSrc('13d-core-domain-routes.js'), 'handleAgentRunApiRoutes');
  assert.ok(block.length > 200, '切到 handleAgentRunApiRoutes');
  assert.match(block, /digestView \? live\.run : JSON\.parse\(JSON\.stringify\(live\.run\)\)/);
});

test('[L4] 分离式启动全部走 spawnDetachedChecked:产品源码里不再有裸 spawn(...).unref()', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.js'))) {
    const lines = readSrc(f).split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\bspawn\([^;]*\)\.unref\(\)/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], '裸 spawn(...).unref() 没有 error 监听,启动失败会带崩服务;改用 spawnDetachedChecked');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
