// E2E (v1.0-S7 「性能专项」): windowing + startup非阻塞 + 大会话载入. Offline, zero-dep, self-built fixture.
// Asserts orders of magnitude (generous budgets to avoid flake), NOT precise values:
//  ① 400-message fixture → serve up → GET /api/sessions/<id> returns the FULL 400 messages AND server-side
//     latency < 2000ms (windowing is a pure FRONT-END render-layer behavior; the API never truncates).
//  ② cold start → /health ready < 5000ms.
//  ③ STATIC: app.js contains the windowing implementation — renderCurrentSession renders a tail window
//     (windowStartFor + MSG_WINDOW_TAIL), builds a「加载更早」control, and the >150 threshold gate exists.
//  ④ FUNCTIONAL: the API layer surfaces all 400 (proves windowing didn't leak into the server / load path).
// Judgement line (exact): PERF E2E: ALL PASS
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const { readFrontendSrc } = require('./read-frontend-src.js'); // v1.3-FE1:app.js 拆模块后聚合读 public/app.js+public/js/**
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const APP_JS = path.join(WB, 'app', 'public', 'app.js'); // 主前端源文件(聚合读取的第一个;下方 ③ 用 readFrontendSrc 聚合)
const HOME = path.join(os.tmpdir(), 'wcw-perf-e2e');
const WB_PORT = await getFreePort();
const SID = 'sess_perfe2e0001';
const SESSION_LOAD_BUDGET_MS = 2000;
const COLD_START_BUDGET_MS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) { return new Promise((resolve, reject) => { const t0 = process.hrtime.bigint(); const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const ms = Number(process.hrtime.bigint() - t0) / 1e6; try { resolve({ status: resp.statusCode, ms, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 200))); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// Build the 400-message fixture directly in HOME/sessions in the session-file format server.js expects.
// Mix: 200 dialogue (100 user/assistant pairs) + 150 tool-card assistant msgs (~1KB result JSON each) +
// 50 markdown-codeblock msgs = 400 total.
function buildFixture(sessionsDir) {
  const messages = [];
  let turnSeq = 0;
  const iso = n => new Date(Date.now() - (400 - n) * 60000).toISOString();
  for (let i = 0; i < 100; i++) {
    turnSeq++;
    messages.push({ role: 'user', content: `用户消息 #${i}: 请解释并给出下一步。`.repeat(2), createdAt: iso(messages.length), turnSeq });
    messages.push({ role: 'assistant', engine: 'openai', providerId: 'fake', model: 'fake-model', content: `助手回复 #${i}。`.repeat(8), usage: { usage: { input_tokens: 1200 + i, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } }, createdAt: iso(messages.length), turnSeq });
  }
  // ~1KB result JSON per tool card: pad `lines` until the serialized object is at least 1024 bytes.
  const resultObj = { ok: true, path: 'C:/proj/file.js', bytes: 2048, lines: [] };
  let k = 0;
  while (JSON.stringify(resultObj).length < 1024) { resultObj.lines.push(`line ${k++}: padding content to reach roughly one kilobyte of json`); }
  for (let i = 0; i < 150; i++) {
    turnSeq++;
    messages.push({ role: 'assistant', engine: 'openai', providerId: 'fake', model: 'fake-model', content: `工具调用 #${i}。`, toolCalls: [{ name: i % 3 === 0 ? 'file_read' : (i % 3 === 1 ? 'powershell_run' : 'git_status'), input: { path: `C:/proj/src/mod${i}.js` }, result: resultObj, isError: false, durationMs: 120 + i }], turnSummary: { turnSeq, filesChanged: i % 4 === 0 ? [{ path: `C:/proj/src/mod${i}.js`, op: 'modify', revertible: true, entrySeq: i }] : [], commands: 1, artifacts: [] }, createdAt: iso(messages.length), turnSeq });
  }
  const code = '```js\n' + Array.from({ length: 20 }, (_, l) => `const x${l} = compute(${l});`).join('\n') + '\n```';
  for (let i = 0; i < 50; i++) {
    turnSeq++;
    messages.push({ role: 'assistant', engine: 'openai', providerId: 'fake', model: 'fake-model', content: `## 示例 #${i}\n\n${code}\n\n完成。`, createdAt: iso(messages.length), turnSeq });
  }
  const session = { id: SID, schemaVersion: 1, turnSeq, title: 'PERF 大会话 fixture', summary: '', pinned: false, cwd: sessionsDir, createdAt: iso(0), updatedAt: iso(400), claudeSessionId: null, messages, providerHistory: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })), attachments: [], todos: [] };
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, SID + '.json'), JSON.stringify(session, null, 2), 'utf8');
  return messages.length;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const nMsgs = buildFixture(path.join(HOME, 'sessions'));
  ok(nMsgs === 400, 'fixture built with 400 messages (got ' + nMsgs + ')');

  // ② cold start → /health ready < budget
  const t0 = process.hrtime.bigint();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  wb.stdout.on('data', () => {});
  procs.push(wb);
  try {
    let h = null; for (let i = 0; i < 200 && !h; i++) { await sleep(50); h = await health(WB_PORT); }
    const startMs = Number(process.hrtime.bigint() - t0) / 1e6;
    ok(!!h, 'workbench up on :' + WB_PORT);
    ok(startMs < COLD_START_BUDGET_MS, `② cold start /health ready < ${COLD_START_BUDGET_MS}ms (got ${startMs.toFixed(0)}ms)`);
    if (startMs > COLD_START_BUDGET_MS * 0.5) console.log(`  [warn] cold start ${startMs.toFixed(0)}ms > 50% of budget — investigate before shipping`);

    // ① large-session load: full 400 + server latency < budget (warm once, then a timed read)
    await getJson(WB_PORT, '/api/sessions/' + SID);
    const g = await getJson(WB_PORT, '/api/sessions/' + SID);
    ok(g.status === 200 && g.body && g.body.ok, '① session-load API 200/ok');
    const loaded = (g.body.session && g.body.session.messages) || [];
    ok(loaded.length === 400, '④ API returns FULL 400 messages — windowing never truncates the API (got ' + loaded.length + ')');
    ok(g.ms < SESSION_LOAD_BUDGET_MS, `① session-load server latency < ${SESSION_LOAD_BUDGET_MS}ms (got ${g.ms.toFixed(1)}ms)`);
    if (g.ms > SESSION_LOAD_BUDGET_MS * 0.5) console.log(`  [warn] session-load ${g.ms.toFixed(1)}ms > 50% of budget — investigate`);

    // ③ STATIC assertions on the windowing implementation (aggregate: public/app.js + public/js/**/*.js)
    const src = readFrontendSrc();
    ok(/function\s+renderCurrentSession\s*\(/.test(src), '③a renderCurrentSession exists');
    ok(/function\s+windowStartFor\s*\(/.test(src) && /MSG_WINDOW_TAIL/.test(src), '③b tail-window logic (windowStartFor + MSG_WINDOW_TAIL)');
    ok(/const\s+MSG_WINDOW_THRESHOLD\s*=\s*150\b/.test(src), '③c windowing threshold = 150 (only > 150 msgs engages windowing)');
    ok(/n\s*<=\s*MSG_WINDOW_THRESHOLD/.test(src), '③d small-session guard: <= threshold returns full render (start 0)');
    ok(/加载更早/.test(src) && /function\s+buildLoadEarlierButton\s*\(/.test(src), '③e「加载更早」control build code present');
    ok(/for\s*\(let\s+i\s*=\s*start;\s*i\s*<\s*msgs\.length;\s*i\+\+\)/.test(src), '③f render loop starts at the window start (tail-only paint)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nPERF E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
