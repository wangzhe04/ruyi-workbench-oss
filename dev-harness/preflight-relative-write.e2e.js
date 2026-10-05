require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(走查 W1·F1):默认(询问)档下,文件写工具的写边界预检(03 preflightWriteBoundary,在弹窗之前)必须与各工具
// handler 同一条路径解析(12 resolveFileToolPath:相对路径接在【会话工作区】下、~ 先展开)。
// 修前预检用裸 path.resolve —— 相对路径落到服务进程 cwd,file_write {path:'rel-note.txt'} 还没弹窗就被判
// 「工作文件夹外面」;而真正的 handler 按工作区解析,本来是写得进去的。
//   (1) file_write 相对路径(工作区内)→ 弹权限窗(permission_request),批准后文件真落在 <工作区>/rel-note.txt,
//       服务进程 cwd 下没有这个文件。
//   (2) file_move 的 to 是相对路径(工作区内的子目录)→ 同样弹窗、批准后落在工作区。
//   (3) file_write 相对路径跳出工作区(../outside-rel.txt)→ 仍在弹窗之前被拒(不弹窗),报出的 path 是
//       「工作区 + 相对段」解析后的路径,文件没写出来。
// 判定行:`PREFLIGHT RELATIVE WRITE E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('PREFLIGHT RELATIVE WRITE');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const WB_DIR = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preflight-rel-'));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preflight-rel-ws-'));
const WS = path.join(SANDBOX, 'workspace');
fs.mkdirSync(WS, { recursive: true });
const OUTSIDE = path.join(SANDBOX, 'outside-rel.txt');     // path.resolve(WS, '../outside-rel.txt')
const PROCESS_CWD_LEAK = path.join(WB_DIR, 'rel-note.txt'); // 修前相对路径会落在服务进程 cwd(spawn 时 cwd = ruyi-workbench)

let fake = null, wb = null;
try {
  const steps = [
    ['file_write', { path: 'rel-note.txt', content: 'relative ok' }],
    ['file_move', { from: 'rel-note.txt', to: 'moved/rel-moved.txt' }],
    ['file_write', { path: '../outside-rel.txt', content: 'should not land' }],
  ];
  fake = await startFakeProvider({
    handler(req) {
      const done = (req.messages || []).filter(m => m.role === 'tool').length;
      if (done < steps.length) return toolCallFrames(steps[done][0], steps[done][1], 'call_' + done);
      return [...textFrames('all done'), usageFrame({ prompt_tokens: 8, completion_tokens: 4 })];
    },
  });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, permissionMode: 'default', permissionTimeoutMs: 20000, engineMode: 'interactive', toolLoadingMode: 'full',
    defaultWorkspace: WS, recentWorkspaces: [WS], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const port = await getFreePort();
  wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], { cwd: WB_DIR, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  const httpJson = (method, route, body, headers) => new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 30000, headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  let live = null; for (let i = 0; i < 100 && !live; i++) { await sleep(150); live = await httpJson('GET', '/health').catch(() => null); }
  const page = await new Promise(r => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c)); res.on('end', () => r(b)); }));
  const token = (String(page).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  const auth = { 'x-wcw-token': token };
  const created = await httpJson('POST', '/api/sessions', { title: 'preflight rel', cwd: WS }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid && !!token, 'P0 前置:真服务起得来、拿得到令牌、能建会话');

  // 跑一个回合;每个 permission_request 当场批准(经 /api/permission/decision),并记下来。
  const permRequests = [];
  const events = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ sessionId: sid, message: '请按脚本调用工具', cwd: WS });
    const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const evs = [];
      res.setEncoding('utf8');   // 按块 += Buffer 会把跨块的汉字劈成 U+FFFD(F3 同一类);测试客户端自己也要用对
      res.on('data', ch => {
        buf += ch; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev = null; try { ev = JSON.parse(line); } catch { /* ignore */ }
          if (!ev) continue;
          evs.push(ev);
          if (ev.type === 'permission_request') {
            permRequests.push(ev);
            httpJson('POST', '/api/permission/decision', { requestId: ev.requestId, behavior: 'allow' }, auth).catch(() => {});
          }
        }
      });
      res.on('end', () => resolve(evs));
    });
    r.on('error', reject); r.write(data); r.end();
  });
  const results = new Map();
  for (const e of events) {
    if (e.type === 'tool_use') results.set(e.id, { name: e.name, input: e.input });
    if (e.type === 'tool_result' && results.has(e.id)) results.get(e.id).content = e.content;
  }
  const asObj = c => (c && typeof c === 'object') ? c : (() => { try { return JSON.parse(c); } catch { return {}; } })();
  const step = i => ({ ...(results.get('call_' + i) || {}), res: asObj((results.get('call_' + i) || {}).content) });

  const s0 = step(0);
  ok(permRequests.some(p => p.toolName === 'file_write' || p.tool === 'file_write'), `A1 file_write 相对路径(工作区内)→ 弹了权限窗(修前预检把它判成「工作文件夹外面」,不弹;permission_request ${permRequests.length} 个)`);
  ok(s0.res.ok === true && s0.res.path === path.join(WS, 'rel-note.txt'),
    `A2 批准后写在 <工作区>/rel-note.txt(工具回的 path;got ${JSON.stringify(s0.res).slice(0, 160)})`);
  ok(!fs.existsSync(PROCESS_CWD_LEAK), 'A3 服务进程 cwd 下没有 rel-note.txt');

  const s1 = step(1);
  ok(permRequests.some(p => p.toolName === 'file_move' || p.tool === 'file_move'), 'B1 file_move 的 to 是相对路径(工作区内)→ 弹了权限窗');
  ok(s1.res.ok === true && fs.existsSync(path.join(WS, 'moved', 'rel-moved.txt')) && !fs.existsSync(path.join(WS, 'rel-note.txt'))
      && fs.readFileSync(path.join(WS, 'moved', 'rel-moved.txt'), 'utf8') === 'relative ok',
    `B2 批准后落在 <工作区>/moved/rel-moved.txt,内容是 A 步写的那份(got ${JSON.stringify(s1.res).slice(0, 160)})`);

  const s2 = step(2);
  const writePerms = permRequests.filter(p => (p.toolName || p.tool) === 'file_write').length;
  ok(writePerms === 1, `C1 跳出工作区的相对路径仍在弹窗之前被拒:file_write 的权限窗只有第一次那一个(got ${writePerms})`);
  ok(s2.res.ok === false && s2.res.code === 'not-allowed' && s2.res.path === OUTSIDE,
    `C2 报出的 path 是「工作区 + ../outside-rel.txt」解析后的路径(got ${JSON.stringify(s2.res).slice(0, 200)})`);
  ok(!fs.existsSync(OUTSIDE), 'C3 越界文件没有写出来');
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { if (wb) killOwnTree(wb); } catch { /* ignore */ }
  try { if (fake) await fake.close(); } catch { /* ignore */ }
  await sleep(300);
  for (const d of [HOME, SANDBOX]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  t.done();
}
})();
