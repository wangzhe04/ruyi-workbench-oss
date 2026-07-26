'use strict';
/*
 * E2E (第55波 EC-C 55a): MCP 运维闭环 -- 统一读模型 + 健康探针 + 错误归类 + 兼容矩阵。
 *
 * 覆盖 roadmap EC-C 退出条件的后端地基(路由 + 探针;前端在 55c):
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
  const WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '2.0.1', permissionMode: 'bypass', enableMcpDropIn: false, desktopMcp: { enabled: false },
    externalMcpServers: [
      { id: 'stdio-good', label: '好的', command: process.execPath, args: [FAKE_MCP], env: { SECRET: 'ghp_xxx' }, cwd: '', enabled: true },
      { id: 'stdio-disabled', label: '停用的', command: process.execPath, args: [FAKE_MCP], env: {}, cwd: '', enabled: false },
      { id: 'stdio-bad', label: '坏命令', command: '__nonexistent_mcp_xyz__.exe', args: [], env: {}, cwd: '', enabled: true },
      { id: 'stdio-break', label: '协议坏', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_BREAK_INIT: '1' }, cwd: '', enabled: true },
      { id: 'stdio-hang', label: '挂起', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_HANG_INIT: '1' }, cwd: '', enabled: true },
      { id: 'stdio-conc', label: '并发互斥', command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_HANG_INIT: '1', FAKE_MCP_PID_CAPTURE: path.join(HOME, 'conc-pids.txt') }, cwd: '', enabled: true },
      { id: 'http-401', label: '鉴权失败', transport: 'http', url: `http://127.0.0.1:${P401}/mcp`, headers: {}, enabled: true },
      { id: 'sse-chg', label: '列表变化', transport: 'sse', url: `http://127.0.0.1:${PSSE}/sse`, headers: {}, enabled: true },
    ],
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench up');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
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

  await sleep(150);
  console.log('\nMCP OPS CLOSURE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
