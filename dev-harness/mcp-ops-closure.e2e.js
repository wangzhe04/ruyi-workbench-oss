'use strict';
/*
 * E2E (第55波 EC-C 55a/55b): MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 + 启停/删除持久化。
 *
 * 覆盖 roadmap EC-C 退出条件的后端地基(路由 + 探针 + 配置变更;前端在 55c):
 *  P 段 classifyMcpError 单测:7 类归一(startup/network/auth/protocol/tool_registration/timeout/security)。
 *  U 段 buildMcpConnectorInventory 无探针形状:三源(desktop/config/drop-in)标注、disabled 含、env 掩码。
 *  G 段 buildMcpConnectorInventory 探针:enabled 跑探针(ok),disabled -> status:disabled(不探针)。
 *  I 段 GET /api/mcp/connectors(无探针):清单形状 + env 掩码 + compat 矩阵随附。
 *  A 段 POST /api/mcp/connectors/health {stdio-good}:成功 -> ok + toolCount。
 *  B 段 POST health {stdio-bad}:坏命令 -> failed + startup。
 *  C 段 POST health {stdio-break}:握手 JSON-RPC error -> failed + protocol。
 *  D 段 POST health {stdio-hang,timeoutMs:2000}:不应答 initialize -> failed + timeout(probe start 竞速)。
 *  E 段 POST health {http-401}:HTTP 401 -> failed + auth。
 *  F 段 POST health {sse-chg} x2:legacy SSE tools/list_changed -> 第一次 toolCount=2,推变更后第二次=3。
 *  H 段(55b)POST /api/mcp/connectors/toggle:停用全路径(落盘/清单/探针 404/活客户端被杀/无关连接器
 *    不受影响)+ 启用回连 + desktop/drop-in 409 拒 + 未知 404 + 参数 400 + 无 token 拒。
 *  J 段(55b)DELETE /api/mcp/connectors:删除全路径(落盘/清单消失/探针 404)+ desktop/drop-in 409 拒 + 无 token 拒。
 *  K 段(55b)重启一致性:同 HOME 重启后停用仍停用、删除不复活、无关条目不受影响(退出条件#3)。
 *  S 段 静态锁:四函数/路由表/路由接线在 server.js。
 *
 * Run: node dev-harness/mcp-ops-closure.e2e.js
 */
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const FAKE_MCP = path.resolve(__dirname, 'fake-mcp.js');
const HOME = path.join(os.tmpdir(), 'wcw-mcp-ops-closure');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 12000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 60; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
function del(port, p, body, headers = {}) { // 55b: DELETE 带 body(与 post 同形,仅方法不同)
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'DELETE', timeout: 12000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const errText = r => { const e = r && r.json && r.json.error; return typeof e === 'string' ? e : (e && e.message) || ''; }; // 55b: 4xx 错误被包装为 {code,message}
// 取首页 HTML(非浏览器导航 -> meta 携带 bootstrap token)。必须挂 error/timeout:并行全量跑时
// getFreePort 的 check-then-use 竞态可让端口在本调用前被别件抢占(up() 过了也会被偷),裸 http.get
// 的 ECONNREFUSED 是 unhandled -> 整进程崩、输出空(第55波 EC-C 收尾并行门抓到的形态)。
function getHtml(port) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    });
    r.on('error', () => resolve('')); r.on('timeout', () => { r.destroy(); resolve(''); });
  });
}

// ── fake HTTP 401 server(E 段:鉴权失败)──
function start401Server(port) {
  return http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
  }).listen(port, '127.0.0.1');
}

// ── fake legacy-SSE MCP server(F 段:tools/list_changed)── 改自 mcp-remote-transport.e2e.js
function startLegacySseMcp(port, state) {
  let streamRes = null;
  const sendEvent = (event, data) => { if (streamRes) streamRes.write('event: ' + event + '\ndata: ' + data + '\n\n'); };
  state.pushListChanged = () => sendEvent('message', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
  const server = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      streamRes = res;
      res.write('event: endpoint\ndata: /messages?session=abc\n\n');
      req.on('close', () => { streamRes = null; });
      return;
    }
    if (req.url.startsWith('/messages')) {
      let b = ''; req.on('data', c => b += c);
      req.on('end', () => {
        res.writeHead(202); res.end('Accepted');
        let msg = null; try { msg = JSON.parse(b || '{}'); } catch { /* ignore */ }
        if (!msg || msg.id == null) return;
        const result = (r) => sendEvent('message', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }));
        if (msg.method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-sse-mcp', version: '1.0' } });
        if (msg.method === 'tools/list') return result({ tools: state.tools });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return server.listen(port, '127.0.0.1');
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const srv = require(SERVER);

  // ── P 段: classifyMcpError 7 类单测 ──
  console.log('── P 段: classifyMcpError 归类 ──');
  ok(srv.classifyMcpError(new Error('mcp child error: spawn ENOENT')).category === 'startup', 'P1 ENOENT/child error -> startup');
  ok(srv.classifyMcpError(new Error('handshake failed: mcp initialize timed out')).category === 'timeout', 'P2 rpc 超时 -> timeout');
  ok(srv.classifyMcpError(new Error('mcp http: 响应中无匹配 id(状态 401)')).category === 'auth', 'P3 HTTP 401 -> auth');
  ok(srv.classifyMcpError(new Error('handshake failed: mcp error: protocol broken')).category === 'protocol', 'P4 JSON-RPC error -> protocol');
  ok(srv.classifyMcpError(new Error('connect ECONNREFUSED 127.0.0.1:9999')).category === 'network', 'P5 ECONNREFUSED -> network');
  ok(srv.classifyMcpError(new Error('mcp sse: HTTP 403 forbidden')).category === 'auth', 'P6 HTTP 403 -> auth');
  ok(srv.classifyMcpError(new Error('mcp tools/list timed out')).category === 'timeout', 'P7 tools/list 超时 -> timeout');
  ok(srv.classifyMcpError(new Error('refused: 目标主机指向本机/内网(SSRF 防护)')).category === 'security', 'P8 SSRF -> security');
  ok(srv.classifyMcpError(new Error('connect ECONNREFUSED 127.0.0.1:401')).category === 'network', 'P8b 端口号 401 不误归 auth -> network');
  ok(srv.classifyMcpError(new Error('something weird happened')).category === 'unknown', 'P9 未匹配 -> unknown');
  // URL 展示脱敏(55a P3 修复):userinfo 剥离
  ok(srv.safeUrlForDisplay('http://user:pass@host/mcp') === 'http://host/mcp', 'P10 URL userinfo 剥离');
  ok(srv.safeUrlForDisplay('http://127.0.0.1:9999/mcp') === 'http://127.0.0.1:9999/mcp', 'P10b 无凭据 URL 原样');

  // ── U 段: buildMcpConnectorInventory 无探针形状 ──
  console.log('── U 段: inventory 无探针形状 ──');
  const cfg = {
    enableMcpDropIn: false,
    desktopMcp: { enabled: false },
    externalMcpServers: [
      { id: 'stdio-good', label: '好的', command: process.execPath, args: [FAKE_MCP], env: { SECRET: 'ghp_super_secret_xxx' }, cwd: '', enabled: true },
      { id: 'stdio-disabled', label: '停用的', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: false },
      { id: 'http-remote', label: '远程', transport: 'http', url: 'http://127.0.0.1:9999/mcp', headers: {}, enabled: true },
      { id: 'bad-no-url', label: '坏', transport: 'http', url: '', enabled: true },
    ],
  };
  const inv = await srv.buildMcpConnectorInventory(cfg);
  const ids = inv.map(i => i.id);
  ok(ids.includes('stdio-good') && ids.includes('stdio-disabled') && ids.includes('http-remote'), 'U1 三源条目都在(config 含 disabled)');
  ok(!ids.includes('bad-no-url'), 'U2 远程条目缺 url 被滤(与 resolveExternalMcpServers 一致)');
  ok(!ids.includes('ai-computer-control'), 'U3 desktopMcp enabled=false -> 不入清单');
  const good = inv.find(i => i.id === 'stdio-good');
  ok(good.source === 'config' && good.builtIn === false && good.transport === 'stdio' && good.enabled === true, 'U4 config 条目 source/builtIn/transport/enabled');
  ok(good.commandOrUrl === process.execPath, 'U5 stdio commandOrUrl = command');
  ok(good.env.SECRET && good.env.SECRET !== 'ghp_super_secret_xxx' && good.envKeys.includes('SECRET'), 'U6 env 值掩码(防 token 泄漏)');
  ok(good.argsCount === 1, 'U7 argsCount 计数');
  ok(good.capabilities && Array.isArray(good.capabilities.capabilities) && good.capabilities.transport === 'stdio', 'U8 capabilities 从兼容矩阵注入');
  const dis = inv.find(i => i.id === 'stdio-disabled');
  ok(dis.enabled === false, 'U9 disabled 条目 enabled=false(保留供 UI 启用)');
  const rem = inv.find(i => i.id === 'http-remote');
  ok(rem.transport === 'http' && rem.commandOrUrl === 'http://127.0.0.1:9999/mcp' && rem.capabilities.supportsListChanged === true, 'U10 http 条目 transport/commandOrUrl/listChanged');
  ok(Array.isArray(srv.MCP_COMPAT_MATRIX.stdio.capabilities) && srv.MCP_COMPAT_MATRIX.http.supportsListChanged === true, 'U11 兼容矩阵三 transport 齐');

  // ── G 段: buildMcpConnectorInventory 探针(enabled 探针 / disabled 不探针)──
  console.log('── G 段: inventory 探针 ──');
  try {
    const gInv = await srv.buildMcpConnectorInventory({
      enableMcpDropIn: false, desktopMcp: { enabled: false },
      externalMcpServers: [
        { id: 'g-good', label: 'g', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: true },
        { id: 'g-disabled', label: 'gd', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: false },
      ],
    }, { probe: true, probeTimeoutMs: 8000 });
    const gg = gInv.find(i => i.id === 'g-good');
    const gd = gInv.find(i => i.id === 'g-disabled');
    ok(gg && gg.health && gg.health.status === 'ok' && gg.health.toolCount >= 20, 'G1 enabled 条目探针 ok + toolCount (got ' + (gg && gg.health && gg.health.toolCount) + ')');
    ok(gd && gd.health && gd.health.status === 'disabled', 'G2 disabled 条目不探针 -> status:disabled');
  } finally { try { srv.killAllMcpClients(); } catch { /* ignore */ } }

  // ── 起两个 fake 远程 server(E 段 401 / F 段 SSE)──
  const P401 = await getFreePort(), PSSE = await getFreePort();
  const srv401 = start401Server(P401);
  const sseState = { tools: [
    { name: 'sse_a', description: 'a', inputSchema: { type: 'object', properties: {} } },
    { name: 'sse_b', description: 'b', inputSchema: { type: 'object', properties: {} } },
  ] };
  const sseServer = startLegacySseMcp(PSSE, sseState);
  await sleep(200);

  // ── Boot: 真身 workbench ──
  // 55b:drop-in 连接器(dataRoot/mcp/drop-test)供「drop-in 拒绝启停/删除」断言;故 enableMcpDropIn 开。
  const DROPIN_DIR = path.join(HOME, 'mcp', 'drop-test');
  fs.mkdirSync(DROPIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(DROPIN_DIR, 'ruyi-mcp.json'), JSON.stringify({ id: 'drop-test', label: 'dropin', command: process.execPath, args: [FAKE_MCP] }));
  // 55b 对抗审查件:drop-shadow 同时存在 config 条目(遮蔽)与 drop-in 目录,验证停用/删除时的接管警告。
  const DROPIN_DIR2 = path.join(HOME, 'mcp', 'drop-shadow');
  fs.mkdirSync(DROPIN_DIR2, { recursive: true });
  fs.writeFileSync(path.join(DROPIN_DIR2, 'ruyi-mcp.json'), JSON.stringify({ id: 'drop-shadow', label: 'shadow', command: process.execPath, args: [FAKE_MCP] }));
  let WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '2.0.1', permissionMode: 'bypass', enableMcpDropIn: true, desktopMcp: { enabled: false },
    externalMcpServers: [
      { id: 'stdio-good', label: '好的', command: process.execPath, args: [FAKE_MCP], env: { SECRET: 'ghp_xxx', FAKE_MCP_PID_CAPTURE: path.join(HOME, 'good-pids.txt') }, cwd: '', enabled: true },
      { id: 'stdio-disabled', label: '停用的', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: false },
      { id: 'stdio-bad', label: '坏命令', command: '__nonexistent_mcp_xyz__.exe', args: [], env: {}, cwd: '', enabled: true },
      { id: 'stdio-break', label: '协议坏', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_BREAK_INIT: '1' }, cwd: '', enabled: true },
      { id: 'stdio-hang', label: '挂起', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_HANG_INIT: '1' }, cwd: '', enabled: true },
      { id: 'stdio-conc', label: '并发互斥', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_HANG_INIT: '1', FAKE_MCP_PID_CAPTURE: path.join(HOME, 'conc-pids.txt') }, cwd: '', enabled: true },
      { id: 'http-401', label: '鉴权失败', transport: 'http', url: `http://127.0.0.1:${P401}/mcp`, headers: {}, enabled: true },
      { id: 'sse-chg', label: '列表变化', transport: 'sse', url: `http://127.0.0.1:${PSSE}/sse`, headers: {}, enabled: true },
      { id: 'drop-shadow', label: '遮蔽dropin', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: true },
    ],
  }));
  const spawnWb = () => cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  // getFreePort is necessarily check-then-use. Under the full suite another short-lived process can claim
  // that port between the probe and server.listen; retry the boot on a newly probed port while preserving
  // the same HOME/config. A real startup crash repeats and still fails after the bounded retries.
  const bootWb = async () => {
    let child = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      child = spawnWb();
      if (await up(WP)) return { child, started: true };
      try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      await sleep(200);
      WP = await getFreePort();
    }
    return { child, started: false };
  };
  let boot = await bootWb();
  let wb = boot.child;
  try {
    ok(boot.started, 'workbench up');
    const html = await getHtml(WP);
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const hdr = { 'x-wcw-token': token };

    // ── I 段: GET /api/mcp/connectors(无探针)──
    console.log('── I 段: GET /api/mcp/connectors ──');
    const li = await get(WP, '/api/mcp/connectors', hdr);
    ok(li && li.status === 200 && li.json && li.json.ok === true, 'I1 GET 200 ok');
    const connectors = (li.json && li.json.connectors) || [];
    const cids = connectors.map(c => c.id);
    ok(cids.includes('stdio-good') && cids.includes('stdio-disabled') && cids.includes('stdio-bad') && cids.includes('stdio-break') && cids.includes('stdio-hang') && cids.includes('http-401') && cids.includes('sse-chg'), 'I2 七条目齐(含 disabled/坏/挂)');
    // desktop MCP:本机若 autodetect 探到则入清单(即便 enabled:false,UI 需展示并允许启用);
    // 环境无关断言:存在则必为 source=desktop/builtIn/enabled=false。
    if (cids.includes('ai-computer-control')) {
      const dm2 = connectors.find(c => c.id === 'ai-computer-control');
      ok(dm2.source === 'desktop' && dm2.builtIn === true && dm2.enabled === false, 'I3 desktop 条目(autodetect 探到)source=desktop/builtIn/enabled=false');
    } else {
      ok(true, 'I3 desktop 未探到(环境无 ai-computer-control)-> 不入清单');
    }
    const cgood = connectors.find(c => c.id === 'stdio-good');
    ok(cgood.source === 'config' && cgood.builtIn === false && cgood.transport === 'stdio', 'I4 source/builtIn/transport');
    ok(cgood.env.SECRET && cgood.env.SECRET !== 'ghp_xxx', 'I5 env 掩码');
    ok(cgood.health === null, 'I6 无探针时 health=null(不假造状态)');
    ok(li.json.compat && li.json.compat.http && li.json.compat.http.supportsListChanged === true, 'I7 compat 矩阵随附');
    const csse = connectors.find(c => c.id === 'sse-chg');
    ok(csse.transport === 'sse' && csse.capabilities.supportsListChanged === true, 'I8 sse 条目兼容矩阵');
    // disabled 条目不能经 /health 探针(不在 resolveExternalMcpServers 启用清单)-> 404
    const disH = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-disabled' }, hdr);
    ok(disH && disH.status === 404, 'I9 disabled 条目 /health -> 404(不在启用清单)');

    // ── A 段: 成功探针 ──
    console.log('── A 段: 成功探针 ──');
    const a = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-good' }, hdr);
    ok(a && a.status === 200 && a.json && a.json.ok === true, 'A1 health 200 ok');
    ok(a.json.health && a.json.health.status === 'ok' && a.json.health.toolCount >= 20, 'A2 status=ok + toolCount (got ' + (a.json.health && a.json.health.toolCount) + ')');
    ok(a.json.health.serverInfo && a.json.health.serverInfo.name === 'fake-mcp', 'A3 serverInfo 回传');
    ok(typeof a.json.health.latencyMs === 'number' && a.json.health.probedAt, 'A4 latencyMs/probedAt');

    // ── B 段: 启动失败(坏命令)──
    console.log('── B 段: 启动失败 ──');
    const b = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-bad' }, hdr);
    ok(b && b.json && b.json.health && b.json.health.status === 'failed', 'B1 status=failed');
    ok(b.json.health.category === 'startup', 'B2 category=startup (got ' + (b.json.health && b.json.health.category) + ')');

    // ── C 段: 协议不兼容(握手 JSON-RPC error)──
    console.log('── C 段: 协议不兼容 ──');
    const c = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-break' }, hdr);
    ok(c && c.json && c.json.health && c.json.health.status === 'failed', 'C1 status=failed');
    ok(c.json.health.category === 'protocol', 'C2 category=protocol (got ' + (c.json.health && c.json.health.category) + ')');

    // ── D 段: 超时(不应答 initialize)──
    console.log('── D 段: 超时 ──');
    const d = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-hang', timeoutMs: 2000 }, hdr);
    ok(d && d.json && d.json.health && d.json.health.status === 'failed', 'D1 status=failed');
    ok(d.json.health.category === 'timeout', 'D2 category=timeout (got ' + (d.json.health && d.json.health.category) + ')');

    // ── E 段: 鉴权失败(HTTP 401)──
    console.log('── E 段: 鉴权失败 ──');
    const e = await post(WP, '/api/mcp/connectors/health', { id: 'http-401' }, hdr);
    ok(e && e.json && e.json.health && e.json.health.status === 'failed', 'E1 status=failed');
    ok(e.json.health.category === 'auth', 'E2 category=auth (got ' + (e.json.health && e.json.health.category) + ')');

    // ── F 段: 工具列表变化(legacy SSE tools/list_changed)──
    console.log('── F 段: 工具列表变化 ──');
    const f1 = await post(WP, '/api/mcp/connectors/health', { id: 'sse-chg' }, hdr);
    ok(f1 && f1.json && f1.json.health && f1.json.health.status === 'ok' && f1.json.health.toolCount === 2, 'F1 第一次探针 toolCount=2 (got ' + (f1.json && f1.json.health && f1.json.health.toolCount) + ')');
    // 推 list_changed:目录变 3 件;live client 收到通知后 _toolsStale=true
    sseState.tools = [...sseState.tools, { name: 'sse_c', description: 'c', inputSchema: { type: 'object', properties: {} } }];
    sseState.pushListChanged();
    await sleep(400);
    const f2 = await post(WP, '/api/mcp/connectors/health', { id: 'sse-chg' }, hdr);
    ok(f2 && f2.json && f2.json.health && f2.json.health.status === 'ok' && f2.json.health.toolCount === 3, 'F2 推 list_changed 后第二次探针 toolCount=3 (got ' + (f2.json && f2.json.health && f2.json.health.toolCount) + ')');

    // 未知 id -> 404
    const unk = await post(WP, '/api/mcp/connectors/health', { id: 'no-such' }, hdr);
    ok(unk && unk.status === 404, 'F3 未知 id -> 404');
    // 无 token -> 401(同源 token 护栏)
    const noauth = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-good' }, {});
    ok(noauth && (noauth.status === 401 || noauth.status === 403), 'F4 无 token -> 401/403');

    // ── G2 段: 并发互斥(55a P2 修复)── 两个并发探针同一 id,应复用同一 start Promise,
    //    只 spawn 一个 fake-mcp 子进程(PID 文件恰好 1 行);无互斥则 2 行(孤儿)。
    console.log('── G2 段: 并发探针互斥 ──');
    const pidFile = path.join(HOME, 'conc-pids.txt');
    try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    const [c1, c2] = await Promise.all([
      post(WP, '/api/mcp/connectors/health', { id: 'stdio-conc', timeoutMs: 2000 }, hdr),
      post(WP, '/api/mcp/connectors/health', { id: 'stdio-conc', timeoutMs: 2000 }, hdr),
    ]);
    ok(c1 && c1.json && c1.json.health && c1.json.health.category === 'timeout', 'G2a 并发探针 1 -> timeout');
    ok(c2 && c2.json && c2.json.health && c2.json.health.category === 'timeout', 'G2b 并发探针 2 -> timeout');
    await sleep(100);
    let pidCount = 0;
    try { pidCount = fs.readFileSync(pidFile, 'utf8').split('\n').filter(l => l.trim()).length; } catch { /* ignore */ }
    ok(pidCount === 1, 'G2c 并发探针只 spawn 1 个子进程(互斥,无孤儿) (got ' + pidCount + ')');

    // ── H 段(55b): toggle 启停持久化 ──
    // stdio-good 在 A 段已探针 -> 活客户端在 mcpClients 缓存;停用它必须杀掉该客户端且不动无关连接器。
    console.log('── H 段: toggle 启停持久化 ──');
    let goodPid = 0;
    try { goodPid = Number((fs.readFileSync(path.join(HOME, 'good-pids.txt'), 'utf8').trim().split('\n').pop() || '').trim()) || 0; } catch { /* ignore */ }
    ok(goodPid > 0 && pidAlive(goodPid), 'H0 前置:A 段探针后 stdio-good 活客户端在 (pid ' + goodPid + ')');
    const t1 = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-good', enabled: false }, hdr);
    ok(t1 && t1.status === 200 && t1.json && t1.json.ok === true && t1.json.enabled === false, 'H1 停用 -> 200 ok enabled:false');
    const cfgOff = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(cfgOff.externalMcpServers.find(s => s.id === 'stdio-good').enabled === false, 'H2 停用已原子落盘 config.json');
    const liOff = await get(WP, '/api/mcp/connectors', hdr);
    ok(liOff && liOff.json && liOff.json.connectors.find(c => c.id === 'stdio-good').enabled === false, 'H3 GET 清单反映 enabled:false');
    const hOff = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-good' }, hdr);
    ok(hOff && hOff.status === 404, 'H4 停用后 /health -> 404(不在启用清单)');
    await sleep(300);
    ok(goodPid > 0 && !pidAlive(goodPid), 'H5 停用后活客户端被杀( invalidateMcpRuntime )');
    // 无关连接器不受影响:sse-chg 客户端仍活(探针仍 ok),config 其它条目 enabled 不变
    const hSse = await post(WP, '/api/mcp/connectors/health', { id: 'sse-chg' }, hdr);
    ok(hSse && hSse.json && hSse.json.health && hSse.json.health.status === 'ok', 'H6a 无关连接器(sse-chg)探针仍 ok(客户端未被误杀)');
    ok(cfgOff.externalMcpServers.find(s => s.id === 'stdio-bad').enabled === true && cfgOff.externalMcpServers.length === 9, 'H6b 无关条目配置不变(条数 9 不变)');
    const t2 = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-good', enabled: true }, hdr);
    ok(t2 && t2.status === 200 && t2.json && t2.json.enabled === true, 'H7a 启用 -> 200 ok enabled:true');
    const hOn = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-good' }, hdr);
    ok(hOn && hOn.status === 200 && hOn.json && hOn.json.health && hOn.json.health.status === 'ok', 'H7b 启用后可立即重测(失败冷却已清) -> ok');
    const tDesk = await post(WP, '/api/mcp/connectors/toggle', { id: 'ai-computer-control', enabled: false }, hdr);
    ok(tDesk && tDesk.status === 409 && /内置/.test(errText(tDesk)), 'H8 desktop 内置连接器 -> 409 + 人话原因');
    const tDrop = await post(WP, '/api/mcp/connectors/toggle', { id: 'drop-test', enabled: false }, hdr);
    ok(tDrop && tDrop.status === 409 && /drop-in/.test(errText(tDrop)), 'H9 drop-in 连接器 -> 409 + 人话原因(目录管理)');
    const tUnk = await post(WP, '/api/mcp/connectors/toggle', { id: 'no-such', enabled: true }, hdr);
    ok(tUnk && tUnk.status === 404, 'H10 未知 id -> 404');
    const tBad = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-good' }, hdr);
    ok(tBad && tBad.status === 400, 'H11 enabled 非布尔 -> 400');
    const tNoTok = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-good', enabled: false }, {});
    ok(tNoTok && (tNoTok.status === 401 || tNoTok.status === 403), 'H12 无 token -> 401/403');
    const t3 = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-good', enabled: false }, hdr);
    ok(t3 && t3.status === 200, 'H13 再停用 stdio-good(为 K 段重启一致性留终态)');
    // 55b 对抗审查件:停用遮蔽同 id drop-in 的 config 条目 -> warning 如实告知接管
    const tSh = await post(WP, '/api/mcp/connectors/toggle', { id: 'drop-shadow', enabled: false }, hdr);
    ok(tSh && tSh.status === 200 && /drop-in/.test((tSh.json && tSh.json.warning) || ''), 'H14 停用遮蔽 drop-in 的条目 -> warning 告知接管');
    const tSh2 = await post(WP, '/api/mcp/connectors/toggle', { id: 'drop-shadow', enabled: true }, hdr);
    ok(tSh2 && tSh2.status === 200 && !(tSh2.json && tSh2.json.warning), 'H15 启用路径不带 warning(无接管问题)');

    // ── J 段(55b): DELETE 删除持久化 ──
    console.log('── J 段: DELETE 删除持久化 ──');
    const dUnk = await del(WP, '/api/mcp/connectors', { id: 'no-such' }, hdr);
    ok(dUnk && dUnk.status === 404, 'J1 删除未知 id -> 404');
    const dDesk = await del(WP, '/api/mcp/connectors', { id: 'ai-computer-control' }, hdr);
    ok(dDesk && dDesk.status === 409 && /内置/.test(errText(dDesk)), 'J2 删除 desktop -> 409 + 人话原因');
    const dDrop = await del(WP, '/api/mcp/connectors', { id: 'drop-test' }, hdr);
    ok(dDrop && dDrop.status === 409 && /drop-in/.test(errText(dDrop)), 'J3 删除 drop-in -> 409(请移除目录)');
    const dBad = await del(WP, '/api/mcp/connectors', { id: 'stdio-bad' }, hdr);
    ok(dBad && dBad.status === 200 && dBad.json && dBad.json.ok === true && dBad.json.removed === true, 'J4 删除 stdio-bad -> 200 removed:true');
    const cfgDel = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(!cfgDel.externalMcpServers.some(s => s.id === 'stdio-bad') && cfgDel.externalMcpServers.length === 8, 'J5 删除已落盘(9->8,无关条目不动)');
    const liDel = await get(WP, '/api/mcp/connectors', hdr);
    ok(liDel && liDel.json && !liDel.json.connectors.some(c => c.id === 'stdio-bad'), 'J6 GET 清单不再含 stdio-bad');
    const hBad = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-bad' }, hdr);
    ok(hBad && hBad.status === 404, 'J7 删除后 /health -> 404');
    const dSh = await del(WP, '/api/mcp/connectors', { id: 'drop-shadow' }, hdr);
    ok(dSh && dSh.status === 200 && /drop-in/.test((dSh.json && dSh.json.warning) || ''), 'J9 删除遮蔽 drop-in 的条目 -> warning 告知接管(55b 对抗审查修复)');
    const cfgDel2 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(!cfgDel2.externalMcpServers.some(x => x.id === 'drop-shadow') && cfgDel2.externalMcpServers.length === 7, 'J10 删除已落盘(8->7)');
    const dNoTok = await del(WP, '/api/mcp/connectors', { id: 'stdio-good' }, {});
    ok(dNoTok && (dNoTok.status === 401 || dNoTok.status === 403), 'J8 无 token -> 401/403');

    // ── K 段(55b): 重启一致性 -- 同 HOME 重启,停用仍停用、删除不复活、无关条目在(退出条件#3)──
    console.log('── K 段: 重启一致性 ──');
    try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(500);
    WP = await getFreePort();
    boot = await bootWb();
    wb = boot.child;
    ok(boot.started, 'K1 重启后 workbench up');
    const html2 = await getHtml(WP);
    const hdr2 = { 'x-wcw-token': (html2.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '' };
    const liK = await get(WP, '/api/mcp/connectors', hdr2);
    const kGood = liK && liK.json && liK.json.connectors.find(c => c.id === 'stdio-good');
    ok(kGood && kGood.enabled === false, 'K2 重启后 stdio-good 仍停用(状态与配置一致)');
    ok(liK && liK.json && !liK.json.connectors.some(c => c.id === 'stdio-bad'), 'K3 重启后 stdio-bad 不复活');
    ok(liK && liK.json && liK.json.connectors.some(c => c.id === 'sse-chg' && c.enabled === true), 'K4 无关连接器(sse-chg)重启后仍在且启用');
    const tDel = await post(WP, '/api/mcp/connectors/toggle', { id: 'stdio-bad', enabled: true }, hdr2);
    ok(tDel && tDel.status === 404, 'K5 重启后操作已删除条目 -> 404');
    const hDis = await post(WP, '/api/mcp/connectors/health', { id: 'stdio-good' }, hdr2);
    ok(hDis && hDis.status === 404, 'K6 重启后停用条目仍不可探针(不自动重连)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    try { srv401.close(); } catch { /* ignore */ }
    try { sseServer.close(); } catch { /* ignore */ }
    try { srv.killAllMcpClients(); } catch { /* ignore */ }
  }

  // ── S 段: 静态锁 ──
  console.log('── S 段: 静态锁 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  ok(/function classifyMcpError/.test(src) && /function probeMcpConnector/.test(src) && /function buildMcpConnectorInventory/.test(src), 'S1 三函数在 server.js');
  ok(/const MCP_COMPAT_MATRIX/.test(src) && /supportsListChanged/.test(src), 'S2 兼容矩阵在');
  ok(/GET \/api\/mcp\/connectors/.test(src) || /'\/api\/mcp\/connectors'/.test(src), 'S3 GET /api/mcp/connectors 路由');
  ok(/POST \/api\/mcp\/connectors\/health/.test(src) || /'\/api\/mcp\/connectors\/health'/.test(src), 'S4 POST /api/mcp/connectors/health 路由');
  ok(/mcp_connectors_list/.test(src) && /mcp_connector_probe/.test(src), 'S5 审计事件 kinds');
  ok(/category: 'auth'/.test(src) && /category: 'startup'/.test(src) && /category: 'protocol'/.test(src) && /category: 'timeout'/.test(src), 'S6 7 类归类字面量');
  ok(/mcpClientPending/.test(src) && /复用同一个 start Promise/.test(src), 'S7 getMcpClient 并发互斥在(防孤儿子进程)');
  ok(/function safeUrlForDisplay/.test(src) && /u\.username = ''/.test(src), 'S8 URL userinfo 脱敏在');
  // 55b: 启停/删除持久化
  ok(/'\/api\/mcp\/connectors\/toggle'/.test(src) && /mcp_connector_toggle/.test(src), 'S9 toggle 路由 + 审计事件在');
  ok(/req\.method === 'DELETE' && pathname === '\/api\/mcp\/connectors'/.test(src) && /mcp_connector_delete/.test(src), 'S10 DELETE 路由 + 审计事件在');
  ok(/function mcpConnectorMutateError/.test(src) && /ai-computer-control\).*(不可|启停)/.test(src), 'S11 源守卫(desktop/drop-in 拒绝)在');
  ok(/\{ m: 'POST', p: '\/api\/mcp\/connectors\/toggle', auth: 'token' \}/.test(src) && /\{ m: 'DELETE', p: '\/api\/mcp\/connectors', auth: 'token' \}/.test(src), 'S12 ROUTE_AUTH 两条 token 级');
  ok(/invalidateMcpRuntime\(id\)/.test(src), 'S13 启停/删除后 invalidateMcpRuntime(杀活客户端/清冷却)');

  await sleep(150);
  console.log('\nMCP OPS CLOSURE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
