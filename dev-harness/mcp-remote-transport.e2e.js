'use strict';
/*
 * E2E (第49波49c): 远程 MCP transport(03 §4.2)— McpHttpClient 双 transport 契约。
 *
 *  F 段 内建双 fake 远程 server(零依赖,同文件起 http 服务):
 *   - streamable-HTTP(2025-03-26):POST 单端点;initialize 回 mcp-session-id;tools/list 与
 *     tools/call 分别用 application/json 与 text/event-stream 两种响应形态(多行 data 拼接)。
 *   - legacy SSE(2024-11-05):GET /sse 发 endpoint 事件;POST 202 应答;结果经流上 message 事件回;
 *     支持中途推 notifications/tools/list_changed。
 *  A 段 直连契约(require 真身 McpHttpClient):
 *   - http transport:握手(协议 2025-03-26)/session-id 捕获并回显/tools/list/echo 调用/JSON+SSE 两种响应形态
 *   - sse transport:endpoint 发现/流上应答/list_changed 后 listTools 惰性重列
 *   - 超时:tools/call 超时 → ok:false + 连接重置人话(无进程树可杀)
 *   - headers ${VAR} 连接时展开(配置存引用,密钥不落盘)
 *  B 段 桥接通路(resolveExternalMcpServers → getMcpClient → collectBridgedTools):
 *   - 远程条目进目录(前缀 serverId__toolName),stdio 条目不受新 cacheKey 影响
 *  S 段 静态锁:sanitize 远程分支 / ROUTE 直通 / 导入器 headers 不展开
 *
 * Run: node dev-harness/mcp-remote-transport.e2e.js
 */
const http = require('http');
const { getFreePort } = require('./free-port.js');

const srv = require('../ruyi-workbench/app/server.js');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fake streamable-HTTP MCP server ──────────────────────────────────────────
function startStreamableHttpMcp(port, captured) {
  const tools = [{ name: 'remote_echo', description: 'echo over http', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }];
  return http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      captured.push({ url: req.url, sessionId: req.headers['mcp-session-id'] || null, auth: req.headers['authorization'] || null });
      let msg = null; try { msg = JSON.parse(b || '{}'); } catch { /* ignore */ }
      if (!msg || !msg.method) { res.writeHead(400); return res.end(); }
      const reply = (result, useSse) => {
        const frame = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        if (useSse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // 多行 data 拆分(验 e5-multiline-sse 拼接)—— 按 SSE 规范在 token 边界(首个逗号,必在
          // 字符串外)切,客户端以 \n 重拼仍是合法 JSON(切字符串中间是非法假服务器,测不出真行为)。
          const cut = frame.indexOf(',');
          res.end('event: message\ndata: ' + frame.slice(0, cut) + '\ndata: ' + frame.slice(cut) + '\n\n');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(frame);
        }
      };
      if (msg.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'fake-session-123');
        return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-http-mcp', version: '1.0' } }, false);
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') return reply({ tools }, true);   // SSE 形态
      if (msg.method === 'tools/call') {
        const a = (msg.params && msg.params.arguments) || {};
        if (a.slowMs) { /* 不应答,让客户端超时 */ return; }
        return reply({ content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: String(a.message || '') }) }] }, false);
      }
      res.writeHead(404); res.end();
    });
  }).listen(port, '127.0.0.1');
}

// ── fake legacy-SSE MCP server ───────────────────────────────────────────────
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
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        res.writeHead(202); res.end('Accepted');
        let msg = null; try { msg = JSON.parse(b || '{}'); } catch { /* ignore */ }
        if (!msg || msg.id == null) return; // notification: 202 即完
        const result = (r) => sendEvent('message', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }));
        if (msg.method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-sse-mcp', version: '1.0' } });
        if (msg.method === 'tools/list') return result({ tools: state.tools });
        if (msg.method === 'tools/call') {
          const a = (msg.params && msg.params.arguments) || {};
          return result({ content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: String(a.message || ''), via: 'sse' }) }] });
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return server.listen(port, '127.0.0.1');
}

(async () => {
  // ── F 段: 起双 fake ──
  const HP = await getFreePort(), SP = await getFreePort();
  const httpCalls = [];
  const httpServer = startStreamableHttpMcp(HP, httpCalls);
  const sseState = { tools: [{ name: 'sse_echo', description: 'echo over sse', inputSchema: { type: 'object', properties: {} } }] };
  const sseServer = startLegacySseMcp(SP, sseState);
  await sleep(200);

  // ── A 段: 直连契约 ──
  console.log('── A 段: McpHttpClient 双 transport 直连 ──');
  process.env.MCP_TEST_SECRET = 's3cr3t-token';
  const hclient = new srv.McpHttpClient({ id: 'http-srv', transport: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: { Authorization: 'Bearer ${MCP_TEST_SECRET}' } });
  await hclient.start();
  ok(true, 'A1 http transport 握手成功(2025-03-26)');
  ok(hclient.serverInfo && hclient.serverInfo.name === 'fake-http-mcp', 'A2 serverInfo 回传');
  ok(httpCalls.some(c => c.sessionId === 'fake-session-123'), 'A3 mcp-session-id 捕获并回显(initialize 后请求带 session)');
  ok(httpCalls.every(c => c.auth === 'Bearer s3cr3t-token'), 'A4 headers ${VAR} 连接时展开(所有请求带真实密钥)');
  const htools = await hclient.listTools();
  ok(htools.length === 1 && htools[0].name === 'remote_echo', 'A5 tools/list 经 SSE 响应形态解析(多行 data 拼接)');
  const hcall = await hclient.callTool('remote_echo', { message: 'hello-remote' });
  ok(hcall && hcall.ok === true && hcall.echoed === 'hello-remote', 'A6 tools/call JSON 响应形态 + ok 包络规范化');

  const sclient = new srv.McpHttpClient({ id: 'sse-srv', transport: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: {} });
  await sclient.start();
  ok(true, 'A7 sse transport 握手成功(endpoint 发现 + 流上应答)');
  const stools = await sclient.listTools();
  ok(stools.length === 1 && stools[0].name === 'sse_echo', 'A8 sse tools/list 经流上 message 事件回传');
  const scall = await sclient.callTool('sse_echo', { message: 'hi' });
  ok(scall && scall.ok === true && scall.via === 'sse', 'A9 sse tools/call 全链路(POST 202 + 流回)');
  // tools/list_changed:推通知 → listTools 惰性重列拿到新目录
  sseState.tools = [...sseState.tools, { name: 'sse_new_tool', description: 'added later', inputSchema: { type: 'object', properties: {} } }];
  sseState.pushListChanged();
  await sleep(300);
  const stools2 = await sclient.listTools();
  ok(stools2.length === 2 && stools2.some(t => t.name === 'sse_new_tool'), 'A10 tools/list_changed 通知 → listTools 惰性重列(03 §4.2)');

  // 超时:无进程树可杀 → ok:false + 连接重置人话 + 下次调用重连
  const slow = await hclient.callTool('remote_echo', { message: 'x', slowMs: 1 }, 1500);
  ok(slow && slow.ok === false && /连接已重置/.test(slow.error || ''), 'A11 http 超时 → 远程连接重置人话(非杀进程树) (got ' + (slow && slow.error) + ')');
  const after = await hclient.callTool('remote_echo', { message: 'again' }, 3000);
  ok(after && after.ok === false, 'A12 客户端 dead 后同实例不再可用(重连走 getBridgedClient 惰性重建)');

  // ── B 段: 桥接通路 ──
  console.log('── B 段: resolveExternalMcpServers → collectBridgedTools ──');
  const config = {
    bridgeExternalToolsToProvider: true,
    externalMcpServers: [
      { id: 'remote-http', label: 'R', transport: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: {}, enabled: true },
      { id: 'remote-sse', label: 'S', transport: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: {}, enabled: true },
      { id: 'bad-remote', label: 'B', transport: 'http', url: '', enabled: true },
    ],
  };
  const entries = srv.resolveExternalMcpServers(config);
  ok(entries.length === 2 && entries.every(e => e.url), 'B1 远程条目直通(缺 url 的被滤) (got ' + entries.length + ')');
  ok(entries.every(e => !e.command), 'B2 远程条目不带 command(不会误走 stdio)');
  const catalog = await srv.collectBridgedTools(config, true);
  const names = catalog.tools.map(t => t.function.name).sort();
  ok(names.includes('remote_http__remote_echo') && names.includes('remote_sse__sse_echo'), 'B3 桥目录含双远程工具(前缀规范化) (got ' + names.join(',') + ')');
  const inv = srv.safeMcpInventory(config);
  ok(inv.every(e => e.transport) && inv.every(e => typeof e.url === 'string'), 'B4 safeMcpInventory 回显 transport/url(无 command)');

  // ── S 段: 静态锁 ──
  console.log('── S 段: 静态锁 ──');
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'), 'utf8');
  ok(/class McpHttpClient/.test(src) && /streamable HTTP \(2025-03-26\)/.test(src), 'S1 McpHttpClient 在(双 transport)');
  ok(/typeRaw === 'sse' \|\| typeRaw === 'http' \|\| typeRaw === 'streamable-http'/.test(src), 'S2 sanitize 远程分支在');
  ok(/notifications\/tools\/list_changed/.test(src), 'S3 tools/list_changed 响应在');
  ok(/new McpHttpClient\(entry\) : new McpStdioClient\(entry\)|new McpHttpClient\(entry\)/.test(src), 'S4 getMcpClient 按 transport 选类');
  const sanBad = srv.sanitizeExternalMcpServer({ id: 'x', type: 'http', url: 'ftp://nope' });
  ok(sanBad === null, 'S5 sanitize 拒绝非 http(s) url');
  const sanGood = srv.sanitizeExternalMcpServer({ id: 'x', type: 'streamable-http', url: 'https://api.example.com/mcp', headers: { A: 'b' } });
  ok(!!sanGood && sanGood.transport === 'http' && !sanGood.command, 'S6 sanitize streamable-http 归一 http 且无 command');

  httpServer.close(); sseServer.close();
  await sleep(100);
  console.log('\nMCP REMOTE TRANSPORT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
