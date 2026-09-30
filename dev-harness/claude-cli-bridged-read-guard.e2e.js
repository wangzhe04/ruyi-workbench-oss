require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会同步 MCP 到 CLI 全局配置,见 lib 头注)
// E2E(审计 A①/A② 后续 · CLI 直挂面):toolLoadingMode:'full' 时,桥接服务器(ACC 等)直接写进 --mcp-config,
// 由 Claude CLI 自己 spawn、自己调 —— 不经工作台的三个分发点(09/08/12),修前读路径闸与环境剥离在这条路上都缺席。
//
// 真服务 + 临时目录里的最小假 CLI:它读 --mcp-config,把桥接条目(fake)的 env 块原样记下,再以 CLI 的工具全名
// (mcp__fake__<tool>)经如意 MCP 条目里的 WCW_PORT/WCW_TOKEN/WCW_SESSION_ID 调三次 /api/permission/request:
//   (1) mcp__fake__read_file 读数据根里的 config.json          → 权限桥直接拒(不弹窗),理由是内部数据;
//   (2) mcp__fake__find_template 的 template_path 是相对路径   → 直接拒(不弹窗),要求绝对路径;
//   (3) mcp__fake__find_template 的 template_path 在工作区内    → 照常走弹窗(测试以用户身份拒绝,证明没被闸误伤)。
// 另验:fake 条目的 env 块把 WCW_TOKEN / WCW_PORT / WCW_HOST / WCW_SESSION_ID / ANTHROPIC_* 置空、条目自己的 env 保留;
// 如意自己的条目仍带回环令牌(权限桥靠它)。
// 覆盖不到的(如实写在 13d 注释里):bypass / auto 档与 exec 档 DAG 节点里 CLI 不来问权限,读路径闸插不进去。
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_MCP = path.resolve(__dirname, 'fake-mcp.js');
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcw-cli-bridged-guard-'));
const HOME = path.join(ROOT_TMP, 'home');
const WORK = path.join(ROOT_TMP, 'work');
const FAKE_CLI = path.join(ROOT_TMP, 'fake-cli.js');
const CAPTURE = path.join(ROOT_TMP, 'bridge-replies.ndjson');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const INSIDE_TEMPLATE = path.join(WORK, 'button.png');
fs.writeFileSync(INSIDE_TEMPLATE, 'PNG');
const REQUESTS = [
  { toolName: 'mcp__fake__read_file', input: { path: path.join(HOME, 'config.json') } },
  { toolName: 'mcp__fake__find_template', input: { template_path: 'button.png' } },
  { toolName: 'mcp__fake__find_template', input: { template_path: INSIDE_TEMPLATE } },
];
fs.writeFileSync(FAKE_CLI, `'use strict';
const fs = require('fs'), http = require('http');
const argv = process.argv.slice(2);
const at = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const SID = 'fake-guard-' + Math.random().toString(16).slice(2, 8);
const emit = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('error', () => {});
const ask = (env, toolName, input) => new Promise(resolve => {
  const body = JSON.stringify({ token: env.WCW_TOKEN, sessionId: env.WCW_SESSION_ID, toolName, input });
  const req = http.request({ host: env.WCW_HOST || '127.0.0.1', port: Number(env.WCW_PORT), path: '/api/permission/request', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } });
  });
  req.on('error', e => resolve({ error: String(e && e.message) }));
  req.write(body); req.end();
});
(async () => {
  let env = {}, servers = {};
  try {
    const mcp = JSON.parse(fs.readFileSync(at('--mcp-config'), 'utf8'));
    servers = mcp.mcpServers || {};
    for (const s of Object.values(servers)) if (s && s.env && s.env.WCW_TOKEN) env = s.env;
  } catch {}
  emit({ type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'fake-model' });
  const replies = [];
  for (const r of ${JSON.stringify(REQUESTS)}) replies.push(await ask(env, r.toolName, r.input));
  fs.appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ permissionMode: at('--permission-mode'), promptTool: at('--permission-prompt-tool'), servers, replies }) + '\\n');
  emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SID, duration_ms: 10, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
})();
`);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'default', engineMode: 'print', toolLoadingMode: 'full',
  permissionBridge: true, includeWorkbenchMcp: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  externalMcpServers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_MCP], enabled: true, env: { OWN_KEY: 'own-value' } }],
  defaultWorkspace: WORK, recentWorkspaces: [], permissionTimeoutMs: 60000,
}, null, 2));

function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postJson(port, p, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data); req.end();
  });
}
function chatStream(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = '';
      const take = line => { if (!line.trim()) return; let e; try { e = JSON.parse(line); } catch { return; } events.push(e); try { onEvent(e); } catch { /* ignore */ } };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
      res.on('end', () => { take(buf); resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
const readReplies = () => { try { return fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

(async () => {
  const t = createRunner('CLAUDE CLI BRIDGED READ GUARD');
  const { ok } = t;
  const PORT = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLI },
  });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 100 && !h; i++) { await sleep(150); h = await health(PORT); }
    ok(!!h, 'workbench up on :' + PORT);
    const created = await postJson(PORT, '/api/sessions', { title: 'cli-guard', cwd: WORK });
    const sid = created && created.session && created.session.id;
    ok(!!sid, 'session created');

    const asked = [];
    const events = await chatStream(PORT, { sessionId: sid, message: '看看桌面', cwd: WORK }, e => {
      if (e && e.type === 'permission_request') {
        asked.push(e);
        void postJson(PORT, '/api/permission/decision', { requestId: e.requestId, behavior: 'deny', message: 'user said no' });
      }
    });
    ok(events.length > 0, '回合流正常返回');
    const cap = readReplies()[0] || {};
    ok(cap.permissionMode === 'default' && cap.promptTool, `CLI 按 default 起、带权限桥(got ${cap.permissionMode} / ${cap.promptTool})`);
    const replies = cap.replies || [];

    // ── 环境剥离:fake 条目的 env 块
    const fake = (cap.servers || {}).fake;
    ok(!!(fake && fake.type === 'stdio'), `full 模式把桥接服务器直挂给 CLI(servers: ${Object.keys(cap.servers || {}).join(',')})`);
    const fenv = (fake && fake.env) || {};
    const blanked = ['WCW_TOKEN', 'WCW_PORT', 'WCW_HOST', 'WCW_SESSION_ID', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].filter(k => fenv[k] === '');
    ok(blanked.length === 6, `桥接条目 env 块把回环凭据与模型密钥置空(置空了 ${blanked.join(',') || '无'})`);
    ok(fenv.OWN_KEY === 'own-value', '桥接条目自己声明的 env 保留');
    const own = Object.entries(cap.servers || {}).find(([id]) => id !== 'fake');
    ok(!!(own && own[1].env && own[1].env.WCW_TOKEN), '如意自己的 MCP 条目仍带回环令牌(权限桥靠它)');

    // ── 读路径闸:CLI 来问权限时按 bridgedReadPathGate 判
    ok(replies[0] && replies[0].behavior === 'deny' && /内部数据/.test(String(replies[0].message || '')),
      `(1) mcp__fake__read_file 读 config.json → 权限桥直接拒(got ${JSON.stringify(replies[0])})`);
    ok(replies[1] && replies[1].behavior === 'deny' && /绝对路径/.test(String(replies[1].message || '')),
      `(2) find_template 相对 template_path → 直接拒(got ${JSON.stringify(replies[1])})`);
    ok(replies[2] && replies[2].behavior === 'deny' && replies[2].message === 'user said no',
      `(3) 工作区内的 template_path → 照常弹窗、由人决定(got ${JSON.stringify(replies[2])})`);
    ok(asked.length === 1 && asked[0].toolName === 'mcp__fake__find_template',
      `被闸拦下的两条不弹窗,只有工作区内那条弹了(got ${asked.map(a => a.toolName).join(',') || '无'})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch { /* gone */ }
    await sleep(200);
    try { fs.rmSync(ROOT_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  t.done({ exit: true });
})();
