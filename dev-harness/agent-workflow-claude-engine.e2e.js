'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离，防 fake-mcp 夹具经 claude mcp add-json／Kimi 同步漏进真机 ~/.claude.json 与 ~/.kimi-code/mcp.json（见 lib 头注）
// Covers three v1.4.4 fixes:
//  (A) buildClaudeCliEnv actually reaching the spawned Claude CLI child — config wins over a stale OS
//      env var (the reported "changes back to ark-code-latest no matter what" symptom).
//  (B) the Agent 工作流 DAG can run a node natively through Claude CLI (runClaudeSubAgentOnce) with NO
//      OpenAI-compatible Provider configured at all — previously the launch handler hard-required one.
//  (C) a Claude-engine DAG node's exec-tier bridged MCP access is scoped by role.mcpServers (or, if
//      unset, gets the full workbench MCP config); read/edit tiers get no MCP config at all.
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { killOwnTree(p); } catch { /* ignore */ } }
function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.write(raw); r.end(); }); }
function stream(port, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = '', events = []; res.on('data', c => { b += c; let i; while ((i = b.indexOf('\n')) >= 0) { const line = b.slice(0, i); b = b.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* ignore */ } } }); res.on('end', () => resolve(events)); }); r.on('error', reject); r.write(raw); r.end(); }); }
async function up(port) { // 117q:预算 50×120ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function tokenFor(port) {
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
}

(async () => {
  // ---- (A) config-driven third-party endpoint/model reaches the actually-spawned CLI child ----
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-env-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const envCapture = path.join(HOME, 'env-capture.json');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, activeProvider: '',
      modelsApiBase: 'https://ark.cn-beijing.volces.com/api/coding', modelsApiKey: 'ark-real-key',
      claudeAuthMode: 'bearer', model: 'doubao-seed-2.0-code',
    }, null, 2));
    // Simulate exactly the reported bug: the OS/shell env already carries an official-endpoint + stale
    // ark-code-latest setup (e.g. from an earlier `setx`) before the workbench even starts.
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ENV_CAPTURE: envCapture,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'stale-official-key', ANTHROPIC_MODEL: 'ark-code-latest' },
    });
    try {
      ok(await up(PORT), 'env-injection test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'env-test', cwd: HOME }, hdr);
      await stream(PORT, { sessionId: created.session.id, message: 'hello', cwd: HOME }, hdr);
      const seen = JSON.parse(fs.readFileSync(envCapture, 'utf8'));
      ok(seen.ANTHROPIC_BASE_URL === 'https://ark.cn-beijing.volces.com/api/coding', 'configured Base URL overrides the stale OS env var, not the official endpoint');
      ok(seen.ANTHROPIC_AUTH_TOKEN === 'ark-real-key', 'bearer auth mode sends the configured key as ANTHROPIC_AUTH_TOKEN');
      ok(seen.ANTHROPIC_API_KEY === '', 'bearer auth mode clears the conflicting ANTHROPIC_API_KEY instead of leaving the stale one');
      ok(seen.ANTHROPIC_MODEL === 'doubao-seed-2.0-code', 'configured model overrides the stale inherited ANTHROPIC_MODEL (was stuck at ark-code-latest)');
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  // ---- (B) DAG launch with Claude-native nodes and NO OpenAI Provider configured ----
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-dag-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const argvCapture = path.join(HOME, 'argv-capture.json');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, providers: [], activeProvider: '',
      claudeThinkingEffort: 'xhigh',
    }, null, 2));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: argvCapture },
    });
    try {
      ok(await up(PORT), 'no-provider DAG test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'dag-claude', cwd: HOME }, hdr);
      const sid = created.session.id;

      // No engine specified, no role, no Provider configured -> must default to 'claude' instead of
      // rejecting the launch (the old hard "需要至少配置一个 OpenAI 兼容 Provider" requirement).
      const bare = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [{ id: 'bare_node', task: 'say hi' }] });
      ok(bare.ok === true && bare.results[0].engine === 'claude' && bare.results[0].status === 'succeeded',
        'DAG node with no engine/provider defaults to and runs via the Claude CLI engine (got ' + JSON.stringify(bare) + ')');
      const argv1 = JSON.parse(fs.readFileSync(argvCapture, 'utf8'));
      ok(argv1.includes('--permission-mode') && argv1[argv1.indexOf('--permission-mode') + 1] === 'bypassPermissions', 'role-less node inherits the run permission mode (bypass)');
      ok(argv1.includes('--effort') && argv1[argv1.indexOf('--effort') + 1] === 'xhigh', 'Claude DAG node inherits the configured thinking effort');
      ok(argv1.includes('--allowed-tools') && argv1[argv1.indexOf('--allowed-tools') + 1] === 'Read,Grep,Glob,WebSearch,WebFetch', 'role-less node gets the read-tier tool allowlist by default (第22波: 含联网检索)');
      const policyIdx = argv1.indexOf('--append-system-prompt');
      ok(policyIdx >= 0 && String(argv1[policyIdx + 1] || '').includes('<response-language-policy>'), 'Claude DAG nodes receive the response-language policy');

      // Explicit role + explicit per-node model override on the Claude engine.
      const roled = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [{ id: 'role_node', task: 'explore', role: 'explorer', engine: 'claude', model: 'claude-haiku-4-5' }] });
      ok(roled.ok === true && roled.results[0].status === 'succeeded', 'explicit Claude-engine node with a role runs successfully');
      const argv2 = JSON.parse(fs.readFileSync(argvCapture, 'utf8'));
      ok(argv2.includes('--model') && argv2[argv2.indexOf('--model') + 1] === 'claude-haiku-4-5', 'per-node model override reaches --model, not the role default');
      ok(argv2.includes('--permission-mode') && argv2[argv2.indexOf('--permission-mode') + 1] === 'plan', "explorer role's own permission mode (plan) is honored, distinct from the run default");
      ok(argv2.includes('--allowed-tools') && argv2[argv2.indexOf('--allowed-tools') + 1] === 'Read,Grep,Glob,WebSearch,WebFetch', "role.claudeTools drives --allowed-tools (explorer 内置角色第22波起含联网)");

      const listed = await get(PORT, '/api/agent-runs?sessionId=' + encodeURIComponent(sid), hdr);
      ok(listed.runs.every(r => r.nodes.every(n => n.engine === 'claude')), 'persisted run records the engine each node actually used');
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  // ---- (C) exec-tier Claude-engine node gets a --mcp-config filtered to role.mcpServers; read-tier gets none ----
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-mcp-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const argvCapture = path.join(HOME, 'argv-capture.json');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, providers: [], activeProvider: '',
      desktopMcp: { enabled: false },
      externalMcpServers: [{ id: 'dummy-tool', label: 'Dummy', command: 'node', args: ['-e', 'process.exit(0)'], enabled: true }],
      agentRoleOverrides: [{ id: 'mcp-worker', label: 'MCP Worker', prompt: 'test worker', toolTier: 'exec', mcpServers: ['win-claude-workbench'] }],
    }, null, 2));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: argvCapture },
    });
    try {
      ok(await up(PORT), 'mcp-filter test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'dag-mcp', cwd: HOME }, hdr);
      const sid = created.session.id;

      const execRun = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [{ id: 'exec_node', task: 'do work', role: 'mcp-worker', engine: 'claude' }] });
      ok(execRun.ok === true && execRun.results[0].status === 'succeeded', 'exec-tier Claude-engine node with mcpServers runs successfully');
      const argv3 = JSON.parse(fs.readFileSync(argvCapture, 'utf8'));
      const mcpIdx = argv3.indexOf('--mcp-config');
      ok(mcpIdx >= 0, 'exec-tier node receives --mcp-config');
      const mcpConfig = mcpIdx >= 0 ? JSON.parse(fs.readFileSync(argv3[mcpIdx + 1], 'utf8')) : null;
      ok(!!mcpConfig && Object.keys(mcpConfig.mcpServers || {}).length === 1 && mcpConfig.mcpServers['ruyi'], "role.mcpServers narrows --mcp-config to just the allowed server ('dummy-tool' excluded; the role's pre-3.0 id win-claude-workbench still selects Ruyi's own server, now id ruyi)");

      const readRun = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [{ id: 'read_node', task: 'say hi', engine: 'claude' }] });
      ok(readRun.ok === true && readRun.results[0].status === 'succeeded', 'read-tier Claude-engine node still runs successfully');
      const argv4 = JSON.parse(fs.readFileSync(argvCapture, 'utf8'));
      ok(!argv4.includes('--mcp-config'), 'read-tier node gets no --mcp-config at all (bridged MCP is exec-only)');
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  // ---- (D) 61-C6:Claude CLI 找不到时,节点错误里说清找过哪、该怎么办(修前只有一句「未找到」)----
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-missing-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const missing = path.join(HOME, 'no-such-dir', 'claude.cmd');
    // 配一个模型服务商(地址不通也无妨:engine:'claude' 的节点不走它),让启动越过「两个引擎都不可用」的入口拒绝,
    // 走到逐节点那一层;入口拒绝的文案另由 D2 钉。
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, claudePath: missing,
      providers: [{ id: 'p', label: 'P', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }], activeProvider: 'p',
    }, null, 2));
    const env = { ...process.env, RUYI_HOME: HOME };
    delete env.WCW_FAKE_CLAUDE;   // 走真的「找可执行文件」判定
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, windowsHide: true, env });
    try {
      ok(await up(PORT), 'claude-missing test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'dag-claude-missing', cwd: HOME }, hdr);
      const run = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: created.session.id, nodes: [{ id: 'cli_node', task: 'say hi', engine: 'claude' }] });
      const r0 = run && Array.isArray(run.results) ? run.results[0] : null;
      const err = String((r0 && r0.error) || '');
      ok(r0 && r0.status !== 'succeeded' && err.includes('Claude CLI 未找到') && err.includes(missing) && /engine:'claude'/.test(err) && /claudePath/.test(err),
        "D1 Claude CLI 缺失:错误里带找过的路径与修法(去掉 engine:'claude' / 配 claudePath)(got " + JSON.stringify(r0 ? { status: r0.status, error: r0.error } : run) + ')');
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }
  // ---- (D2) 两个引擎都不可用:入口拒绝也说清找过哪(修前对不存在的 claude.cmd 也判「可用」,根本走不到这条拒绝)----
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-missing-noprov-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const missing = path.join(HOME, 'no-such-dir', 'claude.cmd');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, providers: [], activeProvider: '', claudePath: missing,
    }, null, 2));
    const env = { ...process.env, RUYI_HOME: HOME };
    delete env.WCW_FAKE_CLAUDE;
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, windowsHide: true, env });
    try {
      ok(await up(PORT), 'claude-missing/no-provider test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'dag-none', cwd: HOME }, hdr);
      const run = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: created.session.id, nodes: [{ id: 'n', task: 'say hi' }] });
      const e0 = run && run.error;
      const err = String((e0 && typeof e0 === 'object' ? e0.message : e0) || '');   // json() 把裸串 error 包成 {code, params, message} 信封
      ok(run && run.ok === false && /Claude CLI/.test(err) && err.includes(missing), 'D2 两个引擎都不可用:入口拒绝,并说清找过的 Claude CLI 路径(got ' + JSON.stringify(run) + ')');
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  console.log('\nAGENT WORKFLOW CLAUDE ENGINE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
