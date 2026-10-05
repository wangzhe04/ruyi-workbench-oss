'use strict';
// hunt2-mcp:原生桥 MCP 客户端与导入器的一组加固(04-permission-runtime)。真源码、临时 HOME、真子进程 / 真 HTTP。
//
//   [1]  SSE 连接器地址连不上:修前 req.on('error') 引用了声明在响应回调里的 openTimer → ReferenceError 冒成
//        uncaughtException,整个工作台进程退出。现在 start() 如实拒掉;连上但不给 endpoint 的按 startupTimeoutMs 拒。
//   [2]  streamable-HTTP 会话失效(对端重启,旧 Mcp-Session-Id 回 404):修前此后每次调用都 404,客户端永不重握手。
//   [3]  条目的 enabledTools / disabledTools / bearerTokenEnvVar / startupTimeoutMs / toolTimeoutMs 修前存了不用。
//   [4]  同 id 的连接器改好之后,旧的 60s 失败冷却修前照用(「改好了还是连不上」)。
//   [5]  对端发来的请求(带 id 的 ping)修前被当成响应,把我们同号的 tools/call 用 undefined 提前结掉。
//   [6]  单行 >4MB 的响应修前被从中间截断,调用干等到超时再被杀进程;超上限的行现在整行丢弃并如实拒掉那一次调用。
//   [7]  sanitizeServerId 撞前缀(my-srv / my_srv)修前后到者的工具被静默丢掉;工具名非法字符 / 超 64 字符修前原样下发。
//   [8]  JSON 数组文本结果修前被展开成 {"0":…};工具自带 ok:true 修前盖掉协议层 isError:true。
//   [9]  config.toml:多行数组、[mcp_servers.X.env] 子表、行尾注释、单引号值、远程条目修前全被丢。
//   [10] ~/.claude.json >256KB 修前一律拒导。
//   [11] 以符号链接 / 目录联接挂进 <dataRoot>/mcp/ 的 drop-in 连接器修前被跳过(Dirent 对链接不报目录)。
//   [14] killAllMcpClients 修前漏掉还在握手的客户端(退出后子进程成孤儿)。
//   [15] 健康探针修前读握手时缓存的目录,卡死的服务器照样报 ok。
//   [16] tools/list 的 nextCursor 分页修前只取第一页。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-hardening-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { McpStdioClient, McpHttpClient, collectBridgedTools, probeMcpConnector, killAllMcpClients, parseMcpConfigFile,
  resolveExternalMcpServers, invalidateMcpDropInCache } = srv;

// 一个按 MODE 换行为的假 stdio MCP 服务器。
const FAKE = path.join(root, 'fake-mcp.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const mode = process.env.MODE || 'ok';
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
let buf = '', lists = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
const text = (id, t, extra) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }], ...(extra || {}) } });
function handle(m) {
  if (mode === 'hang') return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake' }, capabilities: {} } });
  if (m.method === 'tools/list') {
    lists++;
    if (mode === 'wedge' && lists > 1) return;   // 握手后就卡死
    if (mode === 'paged') {
      const page = m.params && m.params.cursor === 'p2' ? 2 : 1;
      return send({ jsonrpc: '2.0', id: m.id, result: page === 1 ? { tools: [{ name: 'a' }], nextCursor: 'p2' } : { tools: [{ name: 'b' }] } });
    }
    if (mode === 'names') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'dotted.name' }, { name: 'x'.repeat(80) }] } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't' }, { name: 'secret' }] } });
  }
  if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    if (mode === 'nocall') return;
    if (mode === 'srverr') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'upstream API timed out after 30s (retry later)' } });
    if (mode === 'ping') { send({ jsonrpc: '2.0', id: m.id, method: 'ping' }); setTimeout(() => text(m.id, 'real'), 50); return; }
    if (name === 'array') return text(m.id, '[{"a":1},{"a":2}]');
    if (name === 'errok') return text(m.id, '{"ok":true,"detail":"x"}', { isError: true });
    if (name === 'big') return text(m.id, 'x'.repeat(5 * 1024 * 1024));
    if (name === 'huge') return text(m.id, 'y'.repeat(300000));
    return text(m.id, 'called ' + name);
  }
}
`);
const HANG = { command: process.execPath, args: [FAKE], env: { MODE: 'hang' } };
const entry = (id, mode, extra) => ({ id, command: process.execPath, args: [FAKE], env: { MODE: mode || 'ok' }, ...(extra || {}) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const baseConfig = servers => ({ bridgeExternalToolsToProvider: true, externalMcpServers: servers, desktopMcp: { enabled: false }, enableMcpDropIn: false, toolbox: { autoDiscover: false } });

after(() => { try { killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

function listen(handler) {
  return new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

test('[1] 连不上的 SSE 连接器:start 如实拒掉,不抛成 uncaughtException', async () => {
  const uncaught = [];
  const onUncaught = e => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const s = await listen(() => {});
    const port = s.address().port;
    await new Promise(r => s.close(r));   // 刚释放的端口:连接被拒
    const c = new McpHttpClient({ id: 'r', transport: 'sse', url: `http://127.0.0.1:${port}/sse` });
    await assert.rejects(c.start(), /handshake failed: mcp sse connect/);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(uncaught.length, 0, 'no uncaught exception: ' + uncaught.map(e => e.message).join('; '));
    assert.equal(c.dead, true);
  } finally { process.off('uncaughtException', onUncaught); }
});

test('[1][3] SSE 连上但一直不给 endpoint 事件:按 startupTimeoutMs 拒掉并断开', async () => {
  const s = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hi\n\n'); });
  try {
    const c = new McpHttpClient({ id: 'r2', transport: 'sse', url: `http://127.0.0.1:${s.address().port}/sse`, startupTimeoutMs: 1000 });
    const t0 = Date.now();
    await assert.rejects(c.start(), /endpoint/);
    assert.ok(Date.now() - t0 < 4000, 'honours startupTimeoutMs (took ' + (Date.now() - t0) + 'ms)');
  } finally { s.closeAllConnections(); s.close(); }
});

test('[2] streamable-HTTP 会话失效(404):就地重握手并重发,后续调用恢复', async () => {
  let gen = 1;
  const s = await listen((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const m = b ? JSON.parse(b) : {};
      if (m.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' + gen }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'x' } } })); }
      if (req.headers['mcp-session-id'] !== 's' + gen) { res.writeHead(404); return res.end('session gone'); }
      if (m.method === 'tools/list') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't' }] } })); }
      if (m.method === 'tools/call') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' + gen }] } })); }
      res.writeHead(202); res.end();
    });
  });
  try {
    const c = new McpHttpClient({ id: 'h', transport: 'http', url: `http://127.0.0.1:${s.address().port}/mcp` });
    await c.start();
    assert.deepEqual(await c.callTool('t', {}), { ok: true, text: 'ok1' });
    gen = 2;   // 对端重启:旧会话作废
    assert.deepEqual(await c.callTool('t', {}), { ok: true, text: 'ok2' });
    assert.deepEqual(await c.callTool('t', {}), { ok: true, text: 'ok2' });
    assert.equal(c.dead, false);
  } finally { s.close(); }
});

test('[3] enabledTools / disabledTools 进目录前过滤,调用时再挡;bearerTokenEnvVar 补 Authorization', async () => {
  const cfg = baseConfig([entry('filt', 'ok', { disabledTools: ['secret'] }), entry('allow', 'ok', { enabledTools: ['secret'] })]);
  const r = await collectBridgedTools(cfg, true);
  assert.ok(r.route.filt__t && !r.route.filt__secret, 'disabledTools hides secret: ' + JSON.stringify(Object.keys(r.route)));
  assert.ok(r.route.allow__secret && !r.route.allow__t, 'enabledTools is an allow-list: ' + JSON.stringify(Object.keys(r.route)));
  const direct = new McpStdioClient(entry('filt2', 'ok', { disabledTools: ['secret'] }));
  await direct.start();
  try {
    const refused = await direct.callTool('secret', {});
    assert.equal(refused.ok, false);
    assert.match(refused.error, /disabled/);
    assert.equal((await direct.callTool('t', {})).ok, true);
  } finally { direct.kill(); }

  let seenAuth = '';
  const s = await listen((req, res) => {
    seenAuth = req.headers.authorization || '';
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const m = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: [] } : {} }));
    });
  });
  try {
    process.env.RUYI_TEST_MCP_TOKEN = 'tok-123';
    const c = new McpHttpClient({ id: 'b', transport: 'http', url: `http://127.0.0.1:${s.address().port}/mcp`, bearerTokenEnvVar: 'RUYI_TEST_MCP_TOKEN' });
    await c.start();
    assert.equal(seenAuth, 'Bearer tok-123');
  } finally { s.close(); delete process.env.RUYI_TEST_MCP_TOKEN; }
});

test('[3] startupTimeoutMs / toolTimeoutMs 落到客户端已有的超时参数上', async () => {
  const c = new McpStdioClient({ id: 'slow', ...HANG, startupTimeoutMs: 1000 });
  const t0 = Date.now();
  await assert.rejects(c.start(), /timed out/);
  assert.ok(Date.now() - t0 < 4000, 'startup honours startupTimeoutMs (took ' + (Date.now() - t0) + 'ms)');
  const w = new McpStdioClient(entry('tt', 'nocall', { toolTimeoutMs: 1000 }));
  await w.start();
  const t1 = Date.now();
  const r = await w.callTool('t', {});   // 不传超时:取条目的 toolTimeoutMs,而不是内置表的 900s
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after 1s/);
  assert.ok(Date.now() - t1 < 5000);
});

test('[4] 同 id 连接器改好之后,不再吃旧配置的失败冷却', async () => {
  const bad = { id: 'z', command: process.execPath, args: ['-e', 'process.exit(1)'] };
  const a = await probeMcpConnector(bad, { timeoutMs: 3000 });
  assert.equal(a.status, 'failed');
  const b = await probeMcpConnector(entry('z', 'ok'), { timeoutMs: 3000 });
  assert.equal(b.status, 'ok', 'fixed config probes ok immediately: ' + JSON.stringify(b));
});

test('[5] 对端发来的 ping 请求不再冒充响应', async () => {
  const c = new McpStdioClient(entry('p', 'ping'));
  await c.start();
  try { assert.deepEqual(await c.callTool('t', {}, 3000), { ok: true, text: 'real' }); } finally { c.kill(); }
});

test('[6] 5MB 单行响应完整收下;超上限的行整行丢弃、如实拒掉那一次,客户端照常可用', async () => {
  const c = new McpStdioClient(entry('big', 'ok'));
  await c.start();
  try {
    const r = await c.callTool('big', {}, 10000);
    assert.equal(r.ok, true);
    assert.equal(r.text.length, 5 * 1024 * 1024);
    c._lineMax = 100000;
    const t0 = Date.now();
    const r2 = await c.callTool('huge', {}, 10000);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /too large/);
    assert.ok(Date.now() - t0 < 5000, 'rejected promptly, not by timeout');
    assert.deepEqual(await c.callTool('t', {}, 3000), { ok: true, text: 'called t' });
  } finally { c.kill(); }
});

test('[7] 前缀撞车不丢工具;工具函数名合法且 ≤64', async () => {
  const r = await collectBridgedTools(baseConfig([entry('my-srv', 'ok'), entry('my_srv', 'ok'), entry('nm', 'names')]), true);
  const servers = new Set(Object.values(r.route).map(x => x.serverId));
  assert.ok(servers.has('my-srv') && servers.has('my_srv'), JSON.stringify(r.route));
  for (const name of Object.keys(r.route)) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  const toolNames = Object.values(r.route).filter(x => x.serverId === 'nm').map(x => x.toolName).sort();
  assert.deepEqual(toolNames, ['dotted.name', 'x'.repeat(80)].sort(), 'route keeps the real tool names');
});

test('[8] 数组结果进 items;工具 ok:true 不再盖掉 isError', async () => {
  const c = new McpStdioClient(entry('res', 'ok'));
  await c.start();
  try {
    assert.deepEqual(await c.callTool('array', {}), { ok: true, items: [{ a: 1 }, { a: 2 }] });
    assert.deepEqual(await c.callTool('errok', {}), { ok: false, detail: 'x' });
  } finally { c.kill(); }
});

test('[9] config.toml:多行数组、env 子表、行尾注释、单引号值、远程条目、无法解析的段标 unsupported', () => {
  const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, [
    'model = "x" # top',
    '[mcp_servers.ctx]',
    'command = "npx"',
    'args = [',
    '  "-y",   # pkg runner',
    '  "@upstash/context7-mcp",',
    ']',
    'startup_timeout_sec = 20',
    "cwd = 'C:\\proj'",
    '',
    '[mcp_servers.ctx.env]',
    'API_KEY = "abc"',
    "FOO = 'b#r'",
    '',
    '[mcp_servers.two]',
    'command = "node"',
    'args = ["a.js"] # comment',
    'env = { A = "1", B = \'2\' }',
    'disabled_tools = ["rm"]',
    '',
    '[mcp_servers.remote]',
    'url = "https://example.test/mcp"',
    'bearer_token_env_var = "REMOTE_TOKEN"',
    'env_http_headers = { "X-Api-Key" = "REMOTE_KEY" }',
    '',
    '[mcp_servers.broken]',
    'command = """',
    'multi"""',
  ].join('\n'));
  const r = parseMcpConfigFile(file);
  assert.equal(r.error, undefined);
  const by = Object.fromEntries(r.servers.map(s => [s.id, s]));
  assert.deepEqual(by.ctx.args, ['-y', '@upstash/context7-mcp']);
  assert.deepEqual(by.ctx.env, { API_KEY: 'abc', FOO: 'b#r' });
  assert.equal(by.ctx.cwd, 'C:\\proj');
  assert.equal(by.ctx.startupTimeoutMs, 20000);
  assert.deepEqual(by.two.args, ['a.js']);
  assert.deepEqual(by.two.env, { A: '1', B: '2' });
  assert.deepEqual(by.two.disabledTools, ['rm']);
  assert.equal(by.remote.type, 'http');
  assert.equal(by.remote.url, 'https://example.test/mcp');
  assert.equal(by.remote.bearerTokenEnvVar, 'REMOTE_TOKEN');
  assert.deepEqual(by.remote.headers, { 'X-Api-Key': '${REMOTE_KEY}' });
  assert.ok(by.broken && by.broken.unsupported, 'unparsable section is surfaced as unsupported, not silently dropped');
});

test('[10] 大于 256KB 的 ~/.claude.json 照常导入', () => {
  const j = { mcpServers: { a: { command: 'node', args: ['x'] } }, projects: {} };
  for (let i = 0; i < 3000; i++) j.projects['/p/' + i] = { history: ['x'.repeat(100)] };
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(j));
  assert.ok(fs.statSync(file).size > 256 * 1024);
  const r = parseMcpConfigFile(file);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.servers.map(s => s.id), ['a']);
});

test('[11] 链接进 mcp/ 的 drop-in 目录被识别', () => {
  const src = path.join(root, 'dropin-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'ruyi-mcp.json'), JSON.stringify({ id: 'linked-dropin', command: process.execPath, args: ['x.js'] }));
  const mcpDir = path.join(process.env.RUYI_HOME, 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.symlinkSync(src, path.join(mcpDir, 'linked-dropin'), 'junction');
  invalidateMcpDropInCache();
  const ids = resolveExternalMcpServers({ desktopMcp: { enabled: false }, externalMcpServers: [], toolbox: { autoDiscover: false } }).map(e => e.id);
  assert.ok(ids.includes('linked-dropin'), JSON.stringify(ids));
});

test('[14] killAllMcpClients 也杀还在握手的客户端', async () => {
  const pidFile = path.join(root, 'hang.pid');
  const probe = await probeMcpConnector({ id: 'hang14', ...HANG, env: { MODE: 'hang', PID_FILE: pidFile } }, { timeoutMs: 2000 });
  assert.equal(probe.status, 'failed');   // 探针先到点,握手(8s)还在进行
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid), 'handshaking child is alive before cleanup');
  killAllMcpClients();
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await new Promise(r => setTimeout(r, 50)); gone = !alive(pid); }
  assert.ok(gone, 'handshaking child killed by killAllMcpClients');
});

test('[15] 健康探针真发 tools/list:握手后卡死的服务器不再报 ok', async () => {
  const e = entry('wedge15', 'wedge');
  const first = await probeMcpConnector(e, { timeoutMs: 2000 });
  assert.equal(first.status, 'ok');
  const second = await probeMcpConnector(e, { timeoutMs: 2000 });
  assert.equal(second.status, 'failed', JSON.stringify(second));
  assert.equal(second.category, 'timeout');
});

test('[16] tools/list 跟 nextCursor 翻页', async () => {
  const c = new McpStdioClient(entry('paged', 'paged'));
  await c.start();
  try { assert.deepEqual(c.listTools().map(t => t.name), ['a', 'b']); } finally { c.kill(); }
});

// 走查 W1·F7:callTool 只认「桥接自己的」超时 / 中断标记,不再用 /timed out/ 匹配错误文本。
// 修前 MCP 服务端自己回的 JSON-RPC error 只要含 "timed out",就被当成桥接超时:杀掉健康的 MCP 进程树、
// 回「tool timed out after Ns; 桥接进程树已终止」,服务端的原话被吞掉。
test('[F7] stdio:服务端自己回的 "timed out" 错误原样交给模型,不杀健康的 MCP 进程', async () => {
  const pidFile = path.join(root, 'f7-stdio.pid');
  const c = new McpStdioClient(entry('f7', 'srverr', { env: { MODE: 'srverr', PID_FILE: pidFile } }));
  await c.start();
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const r = await c.callTool('t', {}, 5000);
    assert.deepEqual(r, { ok: false, error: 'upstream API timed out after 30s (retry later)' });
    assert.equal(c.dead, false, '客户端不该被标死');
    assert.ok(alive(pid), '服务端进程不该被杀');
    const again = await c.callTool('t', {}, 5000);   // 仍可继续用(没被重连)
    assert.equal(again.error, 'upstream API timed out after 30s (retry later)');
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), pid, '没有重新拉起进程');
  } finally { c.kill(); }
});

test('[F7] stdio:桥接自己的超时仍照旧 —— 杀进程树并如实说', async () => {
  const pidFile = path.join(root, 'f7-stdio-hang.pid');
  const c = new McpStdioClient(entry('f7b', 'nocall', { env: { MODE: 'nocall', PID_FILE: pidFile } }));
  await c.start();
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const r = await c.callTool('t', {}, 1000);
  assert.equal(r.ok, false);
  assert.match(r.error, /tool timed out after 1s; 桥接进程树已终止/);
  let gone = !alive(pid);
  for (let i = 0; i < 30 && !gone; i++) { await new Promise(res => setTimeout(res, 100)); gone = !alive(pid); }
  assert.ok(gone, '桥接超时后进程树被杀');
  assert.equal(c.dead, true);
});

test('[F7] stdio:用户插话中断仍走 steerInterrupted', async () => {
  const c = new McpStdioClient(entry('f7c', 'nocall'));
  await c.start();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await c.callTool('t', {}, 10000, { signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(r.steerInterrupted, true, JSON.stringify(r));
  assert.equal(c.dead, true);
});

test('[F7] http:服务端 JSON-RPC error 含 "timed out" 原样回传、连接不重置;真超时与插话照旧', async () => {
  let mode = 'srverr';
  const s = await listen((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const m = JSON.parse(b || '{}');
      if (m.id == null) { res.writeHead(202); return res.end(); }
      if (m.method === 'tools/call' && mode === 'hang') return;   // 不回:触发桥接侧的超时
      res.writeHead(200, { 'content-type': 'application/json' });
      if (m.method === 'tools/call') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'query timed out on server' } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: [{ name: 't' }] } : {} }));
    });
  });
  try {
    const c = new McpHttpClient({ id: 'f7h', transport: 'http', url: `http://127.0.0.1:${s.address().port}/mcp` });
    await c.start();
    const r = await c.callTool('t', {}, 5000);
    assert.deepEqual(r, { ok: false, error: 'query timed out on server' });
    assert.equal(c.dead, false, '服务端的错误不该重置连接');
    mode = 'hang';
    const t = await c.callTool('t', {}, 1000);
    assert.match(t.error, /tool timed out after 1s; 远程连接已重置/, JSON.stringify(t));
    assert.equal(c.dead, true);
    const c2 = new McpHttpClient({ id: 'f7h2', transport: 'http', url: `http://127.0.0.1:${s.address().port}/mcp` });
    mode = 'srverr';
    await c2.start();
    mode = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const st = await c2.callTool('t', {}, 10000, { signal: ac.signal });
    assert.equal(st.steerInterrupted, true, JSON.stringify(st));
  } finally { s.closeAllConnections(); s.close(); }
});
