'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离，防 fake-mcp 夹具经 claude mcp add-json／Kimi 同步漏进真机 ~/.claude.json 与 ~/.kimi-code/mcp.json（见 lib 头注）
// Covers three v1.4.4 fixes:
//  (A) buildClaudeCliEnv actually reaching the spawned Claude CLI child — config wins over a stale OS
//      env var (the reported "changes back to ark-code-latest no matter what" symptom).
//  (B) the Agent 工作流 DAG can run a node natively through Claude CLI (runClaudeSubAgentOnce) with NO
//      OpenAI-compatible Provider configured at all — previously the launch handler hard-required one.
//  (C) a Claude-engine DAG node's exec-tier bridged MCP access is scoped by role.mcpServers (or, if
//      unset, gets the full workbench MCP config); read/edit tiers get no MCP config at all.
//  (D) 2026-10: a Claude-engine node is gated by the permission mode like the OpenAI path — default /
//      acceptEdits run as `dontAsk` with the allowlist capped to the tiers that mode allows (no more bypass).
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
  // ---- (K) 2026-10:Kimi Code 父回合(reg.kind 'kimi-acp')不再被当成 'openai' ----
  // 修前 `reg ? (reg.kind === 'claude' ? 'claude' : 'openai') : …`:没配 provider 时路由成 provider=null,节点一启动就抛。
  // 活的 Kimi 父回合在离线夹具里起不来,这里钉结构:只有活的 provider 父回合才映射成 'openai',其余按可用引擎挑。
  {
    const { sliceBlock } = require('./lib/source-slice.js');
    const routing = sliceBlock(fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8'), 'const parentEngine = ', ';', { inclusive: true });
    ok(/reg && reg\.kind === 'claude' \? 'claude'/.test(routing) && /reg && reg\.kind === 'openai' \? 'openai'/.test(routing) && /provider \? 'openai' : 'claude'/.test(routing),
      'K launch routing maps only a live provider parent to openai; a Kimi parent (or none) picks from the available engines');
  }
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
      const rolePromptArg = String(argv2[argv2.indexOf('--append-system-prompt') + 1] || '');
      ok(rolePromptArg.includes('你是 Explorer') && rolePromptArg.includes('<response-language-policy>'),
        '2026-10: Claude 节点的 --append-system-prompt 带上角色提示词(修前只有语言政策,角色规矩在 Claude 引擎下全丢)');

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

  // ---- (D) 2026-10「两引擎都按权限档拒绝」:非全自动档下 Claude 节点不再被抬成 bypass ----
  // 修前 default/acceptEdits 在 edit/exec 档被强转成 bypassPermissions(OpenAI 路径同档却是拒绝)。现在与 nativeToolGate
  // 同口径:default 只放 read 级,acceptEdits 再放 edit 级,exec 级(Bash/桥接 MCP)拒;CLI 侧用 dontAsk 落实。
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-claude-permgate-e2e');
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    const argvCapture = path.join(HOME, 'argv-capture.json');
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 14, permissionMode: 'default', defaultWorkspace: HOME, providers: [], activeProvider: '',
      desktopMcp: { enabled: false },
    }, null, 2));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: argvCapture },
    });
    try {
      ok(await up(PORT), 'permission-gate test server starts');
      const token = await tokenFor(PORT); const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'dag-permgate', cwd: HOME }, hdr);
      const sid = created.session.id;
      const launch = async node => {
        const r = await post(PORT, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [node] });
        return { r, argv: JSON.parse(fs.readFileSync(argvCapture, 'utf8')) };
      };
      const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
      const READ = 'Read,Grep,Glob,WebSearch,WebFetch';

      let { r, argv } = await launch({ id: 'coder_default', task: 'implement', role: 'coder', engine: 'claude' });
      ok(r.ok === true && r.results[0].status === 'succeeded', 'D1 exec-tier coder node still runs under the default mode');
      ok(flag(argv, '--permission-mode') === 'dontAsk', `D1 default mode is no longer coerced to bypass: exec node runs as dontAsk (got ${flag(argv, '--permission-mode')})`);
      ok(flag(argv, '--allowed-tools') === READ, `D1 default mode: an unrestricted exec role is capped to the read-tier allowlist (got ${flag(argv, '--allowed-tools')})`);
      ok(!argv.includes('--mcp-config'), 'D1 default mode: no bridged MCP for an exec node whose exec tier is refused');

      ({ r, argv } = await launch({ id: 'verifier_default', task: 'verify', role: 'verifier', engine: 'claude' }));
      ok(flag(argv, '--permission-mode') === 'dontAsk' && flag(argv, '--allowed-tools') === READ,
        `D2 default mode: verifier's declared Bash is filtered out (got ${flag(argv, '--permission-mode')} / ${flag(argv, '--allowed-tools')})`);

      ({ r, argv } = await launch({ id: 'read_default', task: 'look around', engine: 'claude' }));
      ok(flag(argv, '--permission-mode') === 'dontAsk' && flag(argv, '--allowed-tools') === READ,
        `D3 default mode: read-tier node keeps its read allowlist under dontAsk (got ${flag(argv, '--permission-mode')} / ${flag(argv, '--allowed-tools')})`);

      ({ r, argv } = await launch({ id: 'explorer_default', task: 'explore', role: 'explorer', engine: 'claude' }));
      ok(flag(argv, '--permission-mode') === 'plan', "D4 a role's own plan mode still passes straight through");

      const toEdits = await post(PORT, '/api/config', { permissionMode: 'acceptEdits' }, hdr);
      ok(toEdits && toEdits.config && toEdits.config.permissionMode === 'acceptEdits', 'D5 global mode switched to acceptEdits');
      ({ r, argv } = await launch({ id: 'coder_edits', task: 'implement', role: 'coder', engine: 'claude' }));
      ok(flag(argv, '--permission-mode') === 'dontAsk' && flag(argv, '--allowed-tools') === READ + ',Write,Edit',
        `D5 acceptEdits: exec node gets read + edit tools, still no Bash (got ${flag(argv, '--permission-mode')} / ${flag(argv, '--allowed-tools')})`);

      const toAuto = await post(PORT, '/api/config', { permissionMode: 'auto', confirm: true }, hdr);
      ok(toAuto && toAuto.config && toAuto.config.permissionMode === 'auto', 'D6 global mode switched to auto (with confirm)');
      ({ r, argv } = await launch({ id: 'coder_auto', task: 'implement', role: 'coder', engine: 'claude' }));
      ok(flag(argv, '--permission-mode') === 'auto' && !argv.includes('--allowed-tools'),
        `D6 auto passes straight to the CLI's own classifier with the exec tier unrestricted (got ${flag(argv, '--permission-mode')} / ${flag(argv, '--allowed-tools')})`);
    } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  console.log('\nAGENT WORKFLOW CLAUDE ENGINE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
