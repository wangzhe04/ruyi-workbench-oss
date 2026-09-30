require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会同步 MCP 到 CLI 全局配置,见 lib 头注)
// E2E(安全审计修复 C):Claude CLI 的权限桥(/api/permission/request)按【这一回合的实效档】判,不按全局档。
//
// 修前 13d 读 config.permissionMode(全局)。全局 auto 时,一条被请求级 / 会话级收紧到 default 的回合:
// runClaudeTurn 按解析档 default 起 CLI(带 --permission-prompt-tool),CLI 为一次 Write 来问权限桥,
// 桥却拿全局 auto 去判 → edit 档直接 allow,用户收紧了的线程被静默放行。
//
// 真服务 + 一个写在临时目录里的最小假 CLI:它从 --mcp-config 里取出每会话 MCP 条目的 WCW_PORT/WCW_TOKEN/
// WCW_SESSION_ID(真 CLI 的 MCP 子进程就是拿这几个值调桥的),以 Claude 名 `Write` 调一次 /api/permission/request,
// 把桥的答复记到文件里,再按 stream-json 收尾。
//   (A) 全局 auto + 请求级 default:CLI 按 default 起(带权限桥);桥【不】自动放行 —— 发出 permission_request,
//       测试以用户身份拒绝,假 CLI 收到的是 deny。
//   (B) 对照:全局 auto、回合不收紧:CLI 按 auto 起;桥对 edit 档照旧直接 allow,不弹窗(auto 档的既有口径不变)。
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcw-claude-perm-bridge-'));
const HOME = path.join(ROOT_TMP, 'home');
const WORK = path.join(ROOT_TMP, 'work');
const FAKE_CLI = path.join(ROOT_TMP, 'fake-cli.js');
const CAPTURE = path.join(ROOT_TMP, 'bridge-replies.ndjson');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(FAKE_CLI, `'use strict';
const fs = require('fs'), http = require('http');
const argv = process.argv.slice(2);
const at = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const SID = 'fake-bridge-' + Math.random().toString(16).slice(2, 8);
const emit = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('error', () => {});
(async () => {
  let env = {};
  try {
    const mcp = JSON.parse(fs.readFileSync(at('--mcp-config'), 'utf8'));
    for (const s of Object.values(mcp.mcpServers || {})) if (s && s.env && s.env.WCW_TOKEN) env = s.env;
  } catch {}
  emit({ type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'fake-model' });
  const body = JSON.stringify({ token: env.WCW_TOKEN, sessionId: env.WCW_SESSION_ID, toolName: 'Write', input: { file_path: ${JSON.stringify(path.join(WORK, 'x.txt'))}, content: 'x' } });
  const reply = await new Promise(resolve => {
    const req = http.request({ host: env.WCW_HOST || '127.0.0.1', port: Number(env.WCW_PORT), path: '/api/permission/request', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } });
    });
    req.on('error', e => resolve({ error: String(e && e.message) }));
    req.write(body); req.end();
  });
  fs.appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ permissionMode: at('--permission-mode'), promptTool: at('--permission-prompt-tool'), reply }) + '\\n');
  emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SID, duration_ms: 10, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
})();
`);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'auto', engineMode: 'print',
  permissionBridge: true, includeWorkbenchMcp: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
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
// 读 /api/chat/stream 的 NDJSON;每来一条事件交给 onEvent(可以在流还开着时去答权限)。
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
  const t = createRunner('CLAUDE PERMISSION BRIDGE MODE');
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
    const created = await postJson(PORT, '/api/sessions', { title: 'bridge', cwd: WORK });
    const sid = created && created.session && created.session.id;
    ok(!!sid, 'session created');

    // (A) 全局 auto,这一单请求级收紧到 default。
    const askedA = [];
    const evA = await chatStream(PORT, { sessionId: sid, message: '写个文件', cwd: WORK, permissionMode: 'default' }, e => {
      if (e && e.type === 'permission_request') {
        askedA.push(e);
        void postJson(PORT, '/api/permission/decision', { requestId: e.requestId, behavior: 'deny', message: 'user said no' });
      }
    });
    const repA = readReplies()[0] || {};
    ok(repA.permissionMode === 'default' && repA.promptTool, `A1 CLI 按回合解析档 default 起、带权限桥(got ${repA.permissionMode} / ${repA.promptTool})`);
    ok(askedA.length === 1 && askedA[0].toolName === 'Write' && askedA[0].tier === 'edit',
      `A2 桥按 default 判 edit 档 → 发出 permission_request 让人决定,而不是按全局 auto 放行(got ${askedA.length} 条)`);
    ok(repA.reply && repA.reply.behavior === 'deny', `A3 假 CLI 收到的是用户的拒绝(got ${JSON.stringify(repA.reply)})`);
    ok(evA.length > 0, 'A4 回合流正常返回');

    // (B) 对照:回合不收紧 → 跟随全局 auto。
    const askedB = [];
    await chatStream(PORT, { sessionId: sid, message: '再写一个', cwd: WORK }, e => {
      if (e && e.type === 'permission_request') {
        askedB.push(e);
        void postJson(PORT, '/api/permission/decision', { requestId: e.requestId, behavior: 'deny' });
      }
    });
    const repB = readReplies()[1] || {};
    ok(repB.permissionMode === 'auto', `B1 不收紧时 CLI 按全局 auto 起(got ${repB.permissionMode})`);
    ok(askedB.length === 0 && repB.reply && repB.reply.behavior === 'allow',
      `B2 auto 档 edit 请求照旧直接放行、不弹窗(got ${askedB.length} 条 / ${JSON.stringify(repB.reply)})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { killOwnTree(wb); } catch { /* gone */ }
    await sleep(200);
    try { fs.rmSync(ROOT_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  t.done({ exit: true });
})();
