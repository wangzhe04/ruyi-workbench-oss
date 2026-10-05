require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会同步 MCP 到 CLI 全局配置,见 lib 头注)
(async () => {
'use strict';
// E2E(2026-10 能力总闸补桥接面):设置页「能力总闸」承诺「关掉之后,对应的工具在所有线程里既不提供给模型、也不会执行」。
// 修前 allowCommandTools / allowDesktopTools(+ 会话级 desktopTools)只拦两张原生名单,内置桌面 MCP(ACC,serverId
// 'ai-computer-control')的 run_command / screenshot / mouse_click / batch_actions 照常提供、照常执行。
//
// 真服务 + 脚本化假 provider + fake-mcp.js 的 FAKE_MCP_ACC_POLICY 模式(与 ACC 同名的 run_command / screenshot /
// mouse_click / batch_actions / read_document)。同一个 fake 同时挂成两份:desktopMcp(= 内置桌面 MCP,前缀
// ai_computer_control__)与外部连接器 ext-mcp(前缀 ext_mcp__)—— 是否真被调到看 FAKE_MCP_CALL_CAPTURE。
//   [A] 全局 allowCommandTools:false / allowDesktopTools:true,full 模式:
//       A1 工具面(provider 请求的 tools)里没有 ACC 的 run_command / batch_actions,有 screenshot 与外部的同名 run_command;
//       A2 list_tools 目录同上;A3 直调 / A4 经 tool_invoke_exec 调 run_command → tool-disabled、没执行;
//       A5 batch_actions(转调器,命令闸关也关)→ tool-disabled;A6 screenshot、A7 名单外的 read_document、A8 外部 MCP 的
//       同名 run_command 照常执行;A9 会话级 desktopTools:false(全局 true)→ screenshot 被拒,原因点名「this session」;
//       A10 全局 workbench.mcp.json(Kimi 的 mcp.json 由它合并)里 ACC 条目按全局闸带 ACC_HIDE_TOOLS。
//   [B] 全局 allowCommandTools:true / allowDesktopTools:false,auto 模式:
//       B1 screenshot、B2 tool_invoke_exec{mouse_click}、B3 batch_actions → tool-disabled;B4 run_command 照常;
//       B5 tool_search 搜不到、B6 tool_load 按名拉不进被关的 ACC 工具(steward-guardrails R5 的真回合版);
//       B7 会话级 desktopTools:true(全局 false)→ screenshot 放行;
//       B8-B11 MCP 子进程(Claude / Kimi CLI 经如意 MCP 的代理路径,ctx 为空):按 WCW_SESSION_ID 取会话覆盖 ——
//       没覆盖的会话代理调 screenshot 被拒、目录里也没有;覆盖 true 的会话放行、目录里有。
//   [C] Claude CLI 直挂面(full 模式,假 CLI 读 --mcp-config 并以 CLI 全名问权限桥):
//       C1 ACC 条目带 ACC_HIDE_TOOLS(命令族 + 转调器 + 这条线程 desktopTools:false 带来的桌面族,不含名单外工具),
//       外部条目不带;C2 权限桥对 mcp__ai-computer-control__run_command / screenshot 直接拒(不弹窗),
//       read_document 与外部 MCP 的 run_command 照常弹窗。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const FAKE_MCP = path.resolve(__dirname, 'fake-mcp.js');
const t = createRunner('ACC CAPABILITY GATES');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const scenarioOf = messages => {
  const tagged = (messages || []).filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
};
const ACC = 'ai_computer_control__';
const EXT = 'ext_mcp__';

function httpJson(port, method, p, body, token) {
  return new Promise(resolve => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...(token ? { 'x-wcw-token': token } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 20000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.end(raw);
  });
}
function chatStream(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const evs = [];
      const take = l => { if (!l.trim()) return; let e; try { e = JSON.parse(l); } catch { return; } evs.push(e); if (onEvent) { try { onEvent(e); } catch { /* ignore */ } } };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
      res.on('end', () => { take(buf); resolve(evs); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
const readLines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const readToken = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } };

function mcpSession(home, extraEnv) {
  const child = cp.spawn(process.execPath, [SERVER, 'mcp'], {
    cwd: WB, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, ...extraEnv },
  });
  let buf = ''; const pending = new Map();
  child.stdout.on('data', chunk => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n'); if (nl < 0) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg); }
    }
  });
  let seq = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 20000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args || {} });
    try { return JSON.parse(r.result.content[0].text); } catch { return { raw: r }; }
  };
  return { child, call, tool };
}

// 起一个 provider 引擎的服务:configExtra 叠在基线配置上;body 拿到 { run, newSession, patch, HOME, WS, capture, calls }。
async function withProviderServer(configExtra, body) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-acc-gates-'));
  const WS = path.join(HOME, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  const DOC = path.join(WS, 'note.docx');
  fs.writeFileSync(DOC, 'DOC');
  const capture = path.join(HOME, 'mcp-calls.ndjson');
  const SCN = {
    LIST: ['list_tools', {}],
    CMD: [`${ACC}run_command`, { command: 'echo acc' }],
    CMDINV: ['tool_invoke_exec', { name: `${ACC}run_command`, arguments: { command: 'echo acc' } }],
    BATCH: [`${ACC}batch_actions`, { actions: [{ tool: 'run_command', args: { command: 'echo acc' } }] }],
    SHOT: [`${ACC}screenshot`, {}],
    SHOTS: [`${ACC}screenshot`, {}],
    SHOTOFF: [`${ACC}screenshot`, {}],
    CLICKINV: ['tool_invoke_exec', { name: `${ACC}mouse_click`, arguments: { x: 1, y: 1 } }],
    EXT: [`${EXT}run_command`, { command: 'echo ext' }],
    DOC: [`${ACC}read_document`, { path: DOC }],
    SEARCH: ['tool_search', { query: 'screenshot mouse_click click screen' }],
    LOAD: ['tool_load', { tools: [`${ACC}mouse_click`] }],
  };
  const fake = await startFakeProvider({
    async handler(req) {
      const msgs = req.messages;
      if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
      const answered = msgs.slice(msgs.map(m => m && m.role).lastIndexOf('user') + 1).some(m => m.role === 'tool');
      if (answered) return textFrames('done');
      const s = SCN[scenarioOf(msgs)];
      return s ? toolCallFrames(s[0], s[1], 'c1') : textFrames('default');
    },
  });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS, toolLoadingMode: 'auto',
    stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
    desktopMcp: { enabled: true, command: process.execPath, args: [FAKE_MCP], cwd: '', autodetect: false },
    externalMcpServers: [{ id: 'ext-mcp', label: 'Ext', command: process.execPath, args: [FAKE_MCP], enabled: true, env: { FAKE_MCP_SERVER_TAG: 'ext' } }],
    ...configExtra,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
    activeProvider: 'fake',
  }));
  const fakeEnv = { FAKE_MCP_ACC_POLICY: '1', FAKE_MCP_CALL_CAPTURE: capture, FAKE_MCP_SERVER_TAG: 'acc' };
  const WP = await getFreePort();
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, ...fakeEnv },
  });
  const children = [];
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { up = (await httpJson(WP, 'GET', '/health')).status === 200; if (!up) await sleep(120); }
    ok(up, `server up (${JSON.stringify(configExtra)})`);
    let token = '';
    for (let i = 0; i < 50 && !token; i++) { token = readToken(HOME); if (!token) await sleep(100); }
    const calls = () => readLines(capture);
    const callCount = (tag, name) => calls().filter(c => c.tag === tag && c.name === name).length;
    // 跑一个场景:返回 { toolText(模型下一发看到的 tool 消息), firstTools(这一回合第一发请求的 tools 名单), evs }
    const run = async (scn, sessionId) => {
      const evs = await chatStream(WP, { message: `SCN-${scn} go`, ...(sessionId ? { sessionId } : {}) });
      const reqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);
      const last = reqs[reqs.length - 1];
      const toolText = last ? last.messages.filter(m => m.role === 'tool').map(m => contentText(m.content)).join('\n') : '';
      const firstTools = reqs.length ? (reqs[0].tools || []).map(x => x && x.function && x.function.name).filter(Boolean) : [];
      return { toolText, firstTools, evs };
    };
    const newSession = async () => {
      const r = await httpJson(WP, 'POST', '/api/sessions', { title: 'acc-gates', cwd: WS }, token);
      return r.json && r.json.session && r.json.session.id;
    };
    const patch = (sid, body2) => httpJson(WP, 'PATCH', '/api/sessions/' + encodeURIComponent(sid), body2, token);
    const mcp = env2 => { const m = mcpSession(HOME, { ...fakeEnv, ...env2 }); children.push(m.child); return m; };
    const status = () => httpJson(WP, 'GET', '/api/status', undefined, token);
    await body({ run, newSession, patch, mcp, callCount, status, HOME, WS });
  } finally {
    for (const c of children) { try { killOwnTree(c); } catch { /* gone */ } }
    try { killOwnTree(wb); } catch { /* gone */ }
    await fake.close();
    await sleep(200);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

try {
  // ═══════ [A] 命令闸关、桌面闸开(full 模式:目录里有什么,provider 请求的 tools 里就有什么) ═══════
  await withProviderServer({ allowCommandTools: false, allowDesktopTools: true, toolLoadingMode: 'full' }, async ({ run, newSession, patch, callCount, status, HOME }) => {
    const list = await run('LIST');
    const names = new Set(list.firstTools);
    ok(!names.has(`${ACC}run_command`) && !names.has(`${ACC}batch_actions`),
      `A1 工具面里没有 ACC 的 run_command / batch_actions(got ${[...names].filter(n => n.startsWith(ACC)).join(',')})`);
    ok(names.has(`${ACC}screenshot`) && names.has(`${ACC}read_document`) && names.has(`${EXT}run_command`),
      'A1b 工具面里照常有 ACC 的 screenshot / read_document 与外部 MCP 的同名 run_command');
    ok(!list.toolText.includes(`"${ACC}run_command"`) && !list.toolText.includes(`"${ACC}batch_actions"`) && list.toolText.includes(`"${EXT}run_command"`) && list.toolText.includes(`"${ACC}screenshot"`),
      `A2 list_tools 目录同上(got ${list.toolText.slice(0, 160)})`);

    const a3 = await run('CMD');
    ok(/tool-disabled/.test(a3.toolText) && /allowCommandTools=false/.test(a3.toolText), `A3 直调 ACC run_command → tool-disabled(got ${a3.toolText.slice(0, 160)})`);
    const a4 = await run('CMDINV');
    ok(/tool-disabled/.test(a4.toolText) && /allowCommandTools=false/.test(a4.toolText), `A4 经 tool_invoke_exec 调同样被拒(got ${a4.toolText.slice(0, 160)})`);
    ok(callCount('acc', 'run_command') === 0, 'A3/A4 ACC 的 run_command 一次都没被执行');
    const a5 = await run('BATCH');
    ok(/tool-disabled/.test(a5.toolText) && /allowCommandTools=false/.test(a5.toolText) && callCount('acc', 'batch_actions') === 0,
      `A5 转调器 batch_actions 随命令闸关(got ${a5.toolText.slice(0, 160)})`);

    const a6 = await run('SHOT');
    ok(!/tool-disabled/.test(a6.toolText) && callCount('acc', 'screenshot') === 1, `A6 桌面闸开:screenshot 照常执行(got ${a6.toolText.slice(0, 120)})`);
    const a7 = await run('DOC');
    ok(!/tool-disabled/.test(a7.toolText) && callCount('acc', 'read_document') === 1, `A7 名单外的 ACC read_document 不受影响(got ${a7.toolText.slice(0, 120)})`);
    const a8 = await run('EXT');
    ok(!/tool-disabled/.test(a8.toolText) && callCount('ext', 'run_command') === 1, `A8 外部 MCP 的同名 run_command 不受影响(got ${a8.toolText.slice(0, 120)})`);

    const sid = await newSession();
    const p = await patch(sid, { desktopTools: false });
    ok(p.status === 200, `A9 前置:会话级 desktopTools:false 写入(got ${p.status})`);
    const before = callCount('acc', 'screenshot');
    const a9 = await run('SHOTOFF', sid);
    ok(/tool-disabled/.test(a9.toolText) && /this session/.test(a9.toolText) && callCount('acc', 'screenshot') === before,
      `A9 全局开 + 会话 desktopTools:false → screenshot 被拒且点名本会话(got ${a9.toolText.slice(0, 160)})`);

    // A10 全局的 workbench.mcp.json(Kimi 的 mcp.json 由它合并而来;也是 /api/status 给出的 mcpConfigPath):ACC 条目按全局闸带
    //     ACC_HIDE_TOOLS(这里只有命令族 + 转调器),外部条目不带。
    const st = await status();
    const mcpFile = (st.json && st.json.mcpConfigPath) || path.join(HOME, 'generated', 'workbench.mcp.json');
    let globalServers = null;
    for (let i = 0; i < 50 && !globalServers; i++) {
      try { globalServers = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers; } catch { await sleep(100); }
    }
    const gAcc = ((globalServers || {})['ai-computer-control'] || {}).env || {};
    const gExt = ((globalServers || {})['ext-mcp'] || {}).env || {};
    ok(gAcc.ACC_HIDE_TOOLS === 'batch_actions,kill_process,launch_application,macro_run,run_command' && !('ACC_HIDE_TOOLS' in gExt),
      `A10 全局 MCP 配置的 ACC 条目按全局闸带 ACC_HIDE_TOOLS,外部条目不带(got ${JSON.stringify(gAcc.ACC_HIDE_TOOLS)})`);
  });

  // ═══════ [B] 命令闸开、桌面闸关(auto 模式) ═══════
  await withProviderServer({ allowCommandTools: true, allowDesktopTools: false, toolLoadingMode: 'auto' }, async ({ run, newSession, patch, mcp, callCount }) => {
    const b1 = await run('SHOT');
    ok(/tool-disabled/.test(b1.toolText) && /allowDesktopTools=false/.test(b1.toolText), `B1 screenshot → tool-disabled(got ${b1.toolText.slice(0, 160)})`);
    const b2 = await run('CLICKINV');
    ok(/tool-disabled/.test(b2.toolText) && /allowDesktopTools=false/.test(b2.toolText), `B2 tool_invoke_exec{mouse_click} → tool-disabled(got ${b2.toolText.slice(0, 160)})`);
    const b3 = await run('BATCH');
    ok(/tool-disabled/.test(b3.toolText) && /allowDesktopTools=false/.test(b3.toolText), `B3 转调器 batch_actions 随桌面闸关(got ${b3.toolText.slice(0, 160)})`);
    ok(callCount('acc', 'screenshot') === 0 && callCount('acc', 'mouse_click') === 0 && callCount('acc', 'batch_actions') === 0, 'B1-B3 三个工具一次都没被执行');
    const b4 = await run('CMD');
    ok(!/tool-disabled/.test(b4.toolText) && callCount('acc', 'run_command') === 1, `B4 命令闸开:ACC run_command 照常执行(got ${b4.toolText.slice(0, 120)})`);
    // 按带引号的整名判:fake 自己的 screenshot_full(名单外)以同一串开头,不能用子串。
    const b5 = await run('SEARCH');
    ok(b5.toolText.length > 0 && !b5.toolText.includes(`"${ACC}screenshot"`) && !b5.toolText.includes(`"${ACC}mouse_click"`),
      `B5 tool_search 搜不到被关的 ACC 桌面工具(got ${b5.toolText.slice(0, 200)})`);
    const b6 = await run('LOAD');
    ok(/unknown/.test(b6.toolText) && b6.toolText.includes(`${ACC}mouse_click`) && !/"loaded":\["ai_computer_control__mouse_click"\]/.test(b6.toolText),
      `B6 tool_load 按名拉不进被关的 ACC 工具(got ${b6.toolText.slice(0, 200)})`);

    const sidOn = await newSession();
    const pOn = await patch(sidOn, { desktopTools: true, confirm: true });
    ok(pOn.status === 200, `B7 前置:会话级 desktopTools:true 写入(got ${pOn.status})`);
    const b7 = await run('SHOTS', sidOn);
    ok(!/tool-disabled/.test(b7.toolText) && callCount('acc', 'screenshot') === 1, `B7 全局关 + 会话 desktopTools:true → screenshot 放行(got ${b7.toolText.slice(0, 160)})`);
    const sidPlain = await newSession();

    // MCP 子进程(CLI 经如意 MCP 的代理路径):ctx 为空,按 WCW_SESSION_ID 装会话头取覆盖
    const plain = mcp({ WCW_SESSION_ID: sidPlain, WCW_TOOL_LOADING_MODE: 'auto', WCW_TOOL_PACKS: 'core' });
    await plain.call('initialize', { protocolVersion: '2024-11-05' });
    const b8 = await plain.tool('tool_invoke_exec', { name: `${ACC}screenshot`, arguments: {} });
    ok(b8 && b8.ok === false && b8.code === 'tool-disabled' && /allowDesktopTools=false/.test(b8.error || ''), `B8 MCP 子进程:无覆盖的会话代理调 screenshot → tool-disabled(got ${JSON.stringify(b8).slice(0, 160)})`);
    const b9 = await plain.tool('tool_search', { query: 'screenshot screen capture' });
    ok(!!(b9 && b9.ok) && !JSON.stringify(b9).includes(`"${ACC}screenshot"`), `B9 MCP 子进程目录里没有被关的 screenshot(got ${JSON.stringify(b9).slice(0, 200)})`);
    const b9b = await plain.tool('tool_invoke_exec', { name: `${ACC}run_command`, arguments: { command: 'echo' } });
    ok(b9b && b9b.ok !== false, `B9b MCP 子进程:命令闸开时 run_command 照常(got ${JSON.stringify(b9b).slice(0, 160)})`);
    const on = mcp({ WCW_SESSION_ID: sidOn, WCW_TOOL_LOADING_MODE: 'auto', WCW_TOOL_PACKS: 'core' });
    await on.call('initialize', { protocolVersion: '2024-11-05' });
    const shotsBefore = callCount('acc', 'screenshot');
    const b10 = await on.tool('tool_invoke_exec', { name: `${ACC}screenshot`, arguments: {} });
    ok(b10 && b10.ok !== false && callCount('acc', 'screenshot') === shotsBefore + 1, `B10 MCP 子进程:desktopTools:true 的会话代理调 screenshot 放行(got ${JSON.stringify(b10).slice(0, 160)})`);
    const b11 = await on.tool('tool_search', { query: 'screenshot screen capture' });
    ok(JSON.stringify(b11).includes(`"${ACC}screenshot"`), `B11 desktopTools:true 的会话目录里有 screenshot(got ${JSON.stringify(b11).slice(0, 200)})`);
  });

  // ═══════ [C] Claude CLI 直挂面(full 模式) ═══════
  {
    const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-acc-gates-cli-'));
    const HOME = path.join(ROOT_TMP, 'home');
    const WORK = path.join(ROOT_TMP, 'work');
    const FAKE_CLI = path.join(ROOT_TMP, 'fake-cli.js');
    const CAPTURE = path.join(ROOT_TMP, 'cli-replies.ndjson');
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(WORK, { recursive: true });
    const DOC = path.join(WORK, 'note.docx');
    fs.writeFileSync(DOC, 'DOC');
    const REQUESTS = [
      { toolName: 'mcp__ai-computer-control__run_command', input: { command: 'echo hi' } },
      { toolName: 'mcp__ai-computer-control__screenshot', input: {} },
      { toolName: 'mcp__ai-computer-control__read_document', input: { path: DOC } },
      { toolName: 'mcp__ext-mcp__run_command', input: { command: 'echo hi' } },
    ];
    fs.writeFileSync(FAKE_CLI, `'use strict';
const fs = require('fs'), http = require('http');
const argv = process.argv.slice(2);
const at = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const SID = 'fake-acc-gates-' + Math.random().toString(16).slice(2, 8);
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
  fs.appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ servers, replies }) + '\\n');
  emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SID, duration_ms: 10, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
})();
`);
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, version: '1.0.0', permissionMode: 'default', engineMode: 'print', toolLoadingMode: 'full',
      permissionBridge: true, includeWorkbenchMcp: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
      allowCommandTools: false, allowDesktopTools: true,
      desktopMcp: { enabled: true, command: process.execPath, args: [FAKE_MCP], cwd: '', autodetect: false },
      externalMcpServers: [{ id: 'ext-mcp', label: 'Ext', command: process.execPath, args: [FAKE_MCP], enabled: true }],
      defaultWorkspace: WORK, recentWorkspaces: [], permissionTimeoutMs: 60000, stewardThreadBriefV1: false,
    }, null, 2));
    const PORT = await getFreePort();
    const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(PORT)], {
      cwd: WB, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLI },
    });
    try {
      let up = false;
      for (let i = 0; i < 300 && !up; i++) { up = (await httpJson(PORT, 'GET', '/health')).status === 200; if (!up) await sleep(120); }
      ok(up, 'C 前置:workbench (Claude 引擎) up');
      let token = '';
      for (let i = 0; i < 50 && !token; i++) { token = readToken(HOME); if (!token) await sleep(100); }
      const created = await httpJson(PORT, 'POST', '/api/sessions', { title: 'acc-gates-cli', cwd: WORK }, token);
      const sid = created.json && created.json.session && created.json.session.id;
      const p = sid ? await httpJson(PORT, 'PATCH', '/api/sessions/' + encodeURIComponent(sid), { desktopTools: false }, token) : { status: 0 };
      ok(!!sid && p.status === 200, `C 前置:会话建好并写入 desktopTools:false(got ${p.status})`);
      const asked = [];
      await chatStream(PORT, { sessionId: sid, message: '看看桌面', cwd: WORK }, e => {
        if (e && e.type === 'permission_request') {
          asked.push(e.toolName);
          void httpJson(PORT, 'POST', '/api/permission/decision', { requestId: e.requestId, behavior: 'deny', message: 'user said no' }, token);
        }
      });
      const cap = readLines(CAPTURE)[0] || {};
      const accEnv = ((cap.servers || {})['ai-computer-control'] || {}).env || {};
      const hidden = String(accEnv.ACC_HIDE_TOOLS || '').split(',').filter(Boolean);
      ok(['run_command', 'launch_application', 'kill_process', 'batch_actions', 'macro_run', 'screenshot', 'mouse_click', 'type_text', 'ocr_screen', 'get_clipboard'].every(n => hidden.includes(n))
        && !hidden.includes('read_document') && !hidden.includes('ocr_image') && !hidden.includes('list_processes'),
        `C1 直挂 ACC 条目带 ACC_HIDE_TOOLS(命令族 + 转调器 + 会话关掉的桌面族;名单外不在其中)(got ${hidden.length} 件: ${hidden.slice(0, 8).join(',')}…)`);
      const extEnv = ((cap.servers || {})['ext-mcp'] || {}).env || {};
      ok(!!(cap.servers || {})['ext-mcp'] && !('ACC_HIDE_TOOLS' in extEnv), 'C1b 外部 MCP 条目不带 ACC_HIDE_TOOLS');
      const replies = cap.replies || [];
      ok(replies[0] && replies[0].behavior === 'deny' && /tool-disabled|disabled by settings/.test(String(replies[0].message || '')) && /allowCommandTools=false/.test(String(replies[0].message || '')),
        `C2 权限桥:mcp__ai-computer-control__run_command 直接拒(got ${JSON.stringify(replies[0])})`);
      ok(replies[1] && replies[1].behavior === 'deny' && /this session/.test(String(replies[1].message || '')),
        `C2b 权限桥:这条线程 desktopTools:false → screenshot 直接拒(got ${JSON.stringify(replies[1])})`);
      ok(replies[2] && replies[2].behavior === 'deny' && replies[2].message === 'user said no' && replies[3] && replies[3].message === 'user said no',
        `C2c 名单外的 read_document 与外部 MCP 的 run_command 照常弹窗由人定(got ${JSON.stringify(replies.slice(2))})`);
      ok(asked.length === 2 && asked[0] === 'mcp__ai-computer-control__read_document' && asked[1] === 'mcp__ext-mcp__run_command',
        `C2d 被总闸拦下的两条不弹窗(got ${asked.join(',') || '无'})`);
    } finally {
      try { killOwnTree(wb); } catch { /* gone */ }
      await sleep(200);
      try { fs.rmSync(ROOT_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
}
t.done({ exit: true });
})();
