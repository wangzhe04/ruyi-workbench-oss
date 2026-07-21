'use strict';
/*
 * E2E (第48波48c): MCP 配置导入器 v1 -- 从 Claude Code .mcp.json / Codex config.toml 导入(03 §4.1)。
 *
 *  P 段 解析器单测(require 真身):
 *   - .mcp.json stdio 条目 -> {id,command,args,env,cwd,type:stdio}
 *   - .mcp.json sse/http 条目 -> unsupported 标记(不静默丢)
 *   - Codex config.toml [mcp_servers.X] 段 -> command/args/env/cwd 正确提取
 *   - ${VAR}/%VAR% 插值(从 process.env)
 *   - 错误:文件缺失/坏 JSON/无 mcpServers/未知格式 -> 各自 error 不抛
 *  H 段 HTTP 全路径:
 *   - scan 自动发现(paths 缺省)返回 servers + errors
 *   - scan 显式 paths 解析多源 + conflict 检测(撞 config 已有 id)
 *   - apply 写 stdio 条目 -> config.externalMcpServers 增条
 *   - apply 跳过 sse/http(unsupported)
 *   - apply id 撞名 -> 更新(非追加)
 *   - apply ≤10 上限
 *  S 段 静态锁: handler / ROUTE_AUTH / 解析器 export
 *
 * Run: node dev-harness/mcp-import-config.e2e.js
 */
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-mcp-import-config');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const srv = require(SERVER);

  // ── P 段: 解析器单测 ──
  console.log('── P 段: 解析器(JSON/TOML/插值/错误) ──');
  const mcpJsonPath = path.join(HOME, 'mcp.json');
  fs.writeFileSync(mcpJsonPath, JSON.stringify({
    mcpServers: {
      'stdio-srv': { type: 'stdio', command: '${HOME_VAR}/server.exe', args: ['--flag', '%PORT_VAR%'], env: { KEY: '${HOME_VAR}' }, cwd: '${HOME_VAR}' },
      'sse-srv': { type: 'sse', url: 'http://example/sse' },
    },
  }));
  process.env.HOME_VAR = 'C:/exp'; process.env.PORT_VAR = '8080';
  const r1 = srv.parseMcpConfigFile(mcpJsonPath);
  ok(r1.servers.length === 2 && !r1.error, 'P1 .mcp.json 解析出 2 条(stdio + sse)');
  const stdio = r1.servers.find(s => s.id === 'stdio-srv');
  ok(!!stdio && stdio.command === 'C:/exp/server.exe', 'P2 stdio command ${VAR} 插值 (got ' + (stdio && stdio.command) + ')');
  ok(!!stdio && stdio.args[1] === '8080', 'P3 args %VAR% 插值 (got ' + JSON.stringify(stdio && stdio.args) + ')');
  ok(!!stdio && stdio.env.KEY === 'C:/exp' && stdio.cwd === 'C:/exp', 'P4 env/cwd 插值');
  const sse = r1.servers.find(s => s.id === 'sse-srv');
  ok(!!sse && sse.unsupported && sse.url === 'http://example/sse', 'P5 sse 条目标 unsupported(不静默丢)');

  const tomlPath = path.join(HOME, 'config.toml');
  fs.writeFileSync(tomlPath, [
    '# codex config',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-github"]',
    'env = { GITHUB_TOKEN = "ghp_xxx" }',
    'cwd = "C:/proj"',
    '',
    '[other_section]',
    'foo = "bar"',
    '',
    '[mcp_servers.fetch]',
    'command = "python"',
    'args = ["-m", "fetch_mcp"]',
  ].join('\n'));
  const r2 = srv.parseMcpConfigFile(tomlPath);
  ok(r2.servers.length === 2 && !r2.error, 'P6 TOML 解析出 2 个 mcp_servers 段(跳过 other_section)');
  const gh = r2.servers.find(s => s.id === 'github');
  ok(!!gh && gh.command === 'npx' && gh.args.length === 2 && gh.env.GITHUB_TOKEN === 'ghp_xxx' && gh.cwd === 'C:/proj', 'P7 TOML github 段 command/args/env/cwd 全提取');
  const ft = r2.servers.find(s => s.id === 'fetch');
  ok(!!ft && ft.command === 'python', 'P8 TOML 第二段 fetch 提取(多段不互吞)');

  // 错误路径(不抛)
  ok(srv.parseMcpConfigFile(path.join(HOME, 'nope.json')).error, 'P9 文件缺失 -> error 不抛');
  fs.writeFileSync(path.join(HOME, 'bad.json'), '{not json');
  ok(srv.parseMcpConfigFile(path.join(HOME, 'bad.json')).error, 'P10 坏 JSON -> error');
  fs.writeFileSync(path.join(HOME, 'nokey.json'), '{"other":1}');
  ok(srv.parseMcpConfigFile(path.join(HOME, 'nokey.json')).error, 'P11 JSON 无 mcpServers -> error');
  fs.writeFileSync(path.join(HOME, 'unknown.txt'), 'hello');
  ok(srv.parseMcpConfigFile(path.join(HOME, 'unknown.txt')).error, 'P12 未知格式 -> error');

  // ── S 段: 静态锁 ──
  console.log('── S 段: 静态锁 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  ok(src.includes("pathname === '/api/mcp/import-config/scan'") && src.includes("pathname === '/api/mcp/import-config/apply'"), 'S1 scan/apply handler 在');
  ok(src.includes("{ m: 'POST', p: '/api/mcp/import-config/scan', auth: 'token' }"), 'S2 ROUTE_AUTH scan/apply token 条目在');
  ok(typeof srv.scanMcpSources === 'function' && typeof srv.parseMcpConfigFile === 'function', 'S3 解析器 export(scanMcpSources/parseMcpConfigFile)');

  // ── H 段: HTTP 全路径 ──
  console.log('── H 段: HTTP scan/apply ──');
  const WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '2.0.0', permissionMode: 'bypass', externalMcpServers: [{ id: 'existing', label: '已有', command: 'old.exe', args: [], env: {}, cwd: '', enabled: true }] }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench up');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const hdr = { 'x-wcw-token': token };

    // scan 显式 paths(用上面的 mcp.json + toml)
    const sc = await post(WP, '/api/mcp/import-config/scan', { paths: [mcpJsonPath, tomlPath] }, hdr);
    ok(sc && sc.status === 200 && sc.json && sc.json.ok === true, 'H1 scan 200 ok');
    const scanIds = (sc.json && sc.json.servers || []).map(s => s.id);
    ok(scanIds.includes('stdio-srv') && scanIds.includes('github') && scanIds.includes('fetch'), 'H2 scan 多源合并(stdio-srv + github + fetch)');
    ok((sc.json && sc.json.servers || []).some(s => s.id === 'sse-srv' && s.unsupported), 'H3 scan 含 sse unsupported 条目(不丢)');
    ok((sc.json && sc.json.errors || []).length === 0, 'H4 scan 无解析错误(两文件均合法)');

    // scan conflict 检测:撞 config 已有 'existing' id
    const conflictJson = path.join(HOME, 'conflict.json');
    fs.writeFileSync(conflictJson, JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'new.exe' } } }));
    const sc2 = await post(WP, '/api/mcp/import-config/scan', { paths: [conflictJson] }, hdr);
    const ex = (sc2.json && sc2.json.servers || []).find(s => s.id === 'existing');
    ok(!!ex && ex.conflict === true, 'H5 scan conflict 检测(撞 config 已有 id 标 conflict=true)');

    // apply:写 stdio + 跳 sse
    const ap = await post(WP, '/api/mcp/import-config/apply', { servers: [
      { id: 'imported-stdio', label: '导入的', command: 'node', args: ['s.js'], env: {}, cwd: '' },
      { id: 'imported-sse', type: 'sse', url: 'http://x', command: '' },
    ] }, hdr);
    ok(ap && ap.status === 200 && ap.json && ap.json.ok === true, 'H6 apply 200 ok');
    ok(ap.json.added.includes('imported-stdio') && ap.json.skipped.some(s => s.id === 'imported-sse'), 'H7 apply 写 stdio + 跳过 sse(unsupported)');
    // 验证写回 config
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const ids = (cfg.externalMcpServers || []).map(s => s.id);
    ok(ids.includes('imported-stdio') && !ids.includes('imported-sse'), 'H8 config.externalMcpServers 含 stdio 不含 sse');

    // apply id 撞名 -> 更新(非追加)
    const ap2 = await post(WP, '/api/mcp/import-config/apply', { servers: [{ id: 'existing', label: '更新后', command: 'updated.exe', args: [], env: {}, cwd: '' }] }, hdr);
    ok(ap2.json && ap2.json.updated.includes('existing') && !ap2.json.added.includes('existing'), 'H9 apply id 撞名 -> 更新(非追加)');
    const cfg2 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const ex2 = (cfg2.externalMcpServers || []).find(s => s.id === 'existing');
    ok(!!ex2 && ex2.command === 'updated.exe', 'H10 撞名条目 command 已更新');
    ok((cfg2.externalMcpServers || []).filter(s => s.id === 'existing').length === 1, 'H11 撞名未产生重复条目');

    // apply ≤10 上限(先填到 10,再 apply 新 id -> skip)
    const fill = Array.from({ length: 8 }, (_, i) => ({ id: 'fill-' + i, label: 'f', command: 'f.exe', args: [], env: {}, cwd: '' }));
    await post(WP, '/api/mcp/import-config/apply', { servers: fill }, hdr);
    const ap3 = await post(WP, '/api/mcp/import-config/apply', { servers: [{ id: 'overflow', label: 'o', command: 'o.exe', args: [], env: {}, cwd: '' }] }, hdr);
    ok(ap3.json && ap3.json.skipped.some(s => s.id === 'overflow' && /上限/.test(s.reason)), 'H12 apply 超 10 上限 -> skip 带原因');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nMCP IMPORT CONFIG E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
