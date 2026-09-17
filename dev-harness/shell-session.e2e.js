require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
// E2E (v0.8-S2): persistent shell sessions on the native provider engine. Offline; drives the workbench
// via the fake OpenAI server (FAKE_TOOL_SEQUENCE) for the in-turn tool loop, then hits the token-gated
// /api/tools/* HTTP surface directly to prove cross-turn survival (session lives in the serve process)
// and to exercise concurrency-cap + kill. One workbench + one fake for the whole run. Ports 8967-8969.
//
// Coverage:
//  (a) SEQUENCE [shell_start{shellId:'s1'}(不传 cwd), shell_send{input:'(Get-Location).Path'}] in ONE turn whose
//      cwd is SESS_CWD → start ok + send output prints SESS_CWD (proves the session persisted BETWEEN the two tool
//      calls, and — 107-S0 — that a cwd-less shell starts in the turn's working folder, not the user's home).
//  (b) cross-turn survival + UI-token通路: after the turn, POST /api/tools/shell_poll {shellId:'s1'}
//      (token scraped from index.html) → running:true, then shell_send echo NEW marker → marker appears.
//  (c) concurrency cap: start s2, s3 (cap=3 → ok), s4 → error contains 上限.
//  (d) kill s1 → shell_list no longer contains s1.
//  (e) F1: cap counts LIVE sessions only — after the kill, a new start succeeds.
//  (f) 107-S0(46 号文 §1.5 ②,45 号文 §9.6 发现 3):执行闸判的目录 ≡ 命令真跑的目录。修前闸按会话 cwd 判,
//      shell_start／powershell_run／script_run 缺省 cwd 却起在家目录。经 /api/tools 带 sessionId(进程内分发,
//      ctx.session 是那条会话):不传 cwd → 会话 cwd(≠ defaultWorkspace ≠ 家目录);传 cwd → 就用它;
//      会话 cwd 落在 execute:false 的工作区里 → 照样拒,且没有起 shell。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-shell-session-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const WORK = path.join(HOME, 'work');
// 107-S0:三个互不相同的目录 —— 会话 cwd、显式 cwd、禁止执行的工作区;defaultWorkspace 是 WORK,家目录是 run-all／
// self-isolate 给的临时家,四者两两不同,才分得清「落到了哪一档」。
const SESS_CWD = path.join(HOME, 'sess-cwd');
const OTHER = path.join(HOME, 'explicit-cwd');
const DENY = path.join(HOME, 'no-exec');
// 比路径:realpath.native 展开 8.3 短名再小写;输出里只认「整行就是一个盘符路径」的行(PowerShell 的 PS 提示行不算)。
const canon = p => { try { return fs.realpathSync.native(String(p)).replace(/[\\/]+$/, '').toLowerCase(); } catch { return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); } };
const printsDir = (out, dir) => String(out || '').split(/\r?\n/).some(l => { const t = l.trim(); return /^[a-z]:[\\/]/i.test(t) && canon(t) === canon(dir); });
const outHead = out => JSON.stringify(String(out || '').trim().slice(0, 200));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
// Scrape the UI token from the injected <meta name="wcw-token" content="..."> in index.html.
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
function tool(port, token, name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function apiPost(port, token, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    for (const d of [SESS_CWD, OTHER, DENY]) fs.mkdirSync(d, { recursive: true });
    // config: native fake provider (so the engine runs toolCall() in-process, where shell state lives).
    // shellSessionMax:3 → s1,s2,s3 fit, s4 trips the cap.
    // 107-S0:workspaces 首行 WORK(= defaultWorkspace),DENY 那一行 execute:false —— (f) 的拒绝判据要它。
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass', shellSessionMax: 3,
      workspaces: [{ path: WORK, read: true, write: true, execute: true }, { path: DENY, read: true, write: true, execute: false }],
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
      activeProvider: 'fake',
    }, null, 2));

    // (a) SEQUENCE: start s1 (deterministic id, 107-S0:不传 cwd) then send (Get-Location).Path — both in one turn.
    const seq = JSON.stringify([
      { name: 'shell_start', args: { shellId: 's1' } },
      { name: 'shell_send', args: { shellId: 's1', input: '(Get-Location).Path' } },
    ]);
    const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fake, wb);

    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up');
    const token = await getToken(WB_PORT);
    ok(!!token, 'scraped UI token from index.html');

    const events = await postStream(WB_PORT, { message: '起个 shell 并看当前目录', cwd: SESS_CWD });
    const results = events.filter(e => e.type === 'tool_result');
    ok(results.length >= 2, '(a) at least 2 tool_result events (got ' + results.length + ')');
    const startRes = results[0] && results[0].content;
    ok(startRes && startRes.ok === true && startRes.shellId === 's1', '(a) shell_start ok with shellId s1');
    ok(startRes && canon(startRes.cwd) === canon(SESS_CWD), '(a) 107-S0 cwd-less shell_start reports the turn working folder as cwd (got ' + JSON.stringify(startRes && startRes.cwd) + ')');
    const sendRes = results[1] && results[1].content;
    ok(sendRes && sendRes.ok === true, '(a) shell_send ok');
    const sendOut = (sendRes && sendRes.output) || '';
    // 107-S0:整行比对(8.3 短名已展开)—— 修前这里打出来的是家目录。
    ok(printsDir(sendOut, SESS_CWD), '(a) 107-S0 (Get-Location).Path prints the turn working folder, not home (got: ' + outHead(sendOut) + ', home ' + JSON.stringify(os.homedir()) + ')');
    ok(sendRes && sendRes.running === true, '(a) session still running after send');

    // (b) cross-turn survival via the token-gated HTTP surface (same serve process, new "turn").
    const pollRes = await tool(WB_PORT, token, 'shell_poll', { shellId: 's1', cursor: 0 });
    ok(pollRes.result && pollRes.result.ok === true && pollRes.result.running === true, '(b) shell_poll after turn: running:true (cross-turn survival)');
    const echo = await tool(WB_PORT, token, 'shell_send', { shellId: 's1', input: 'echo ALIVE_MARKER_2' });
    ok(echo.result && echo.result.ok === true && String(echo.result.output || '').includes('ALIVE_MARKER_2'), '(b) shell_send echoes NEW marker (session alive across turn + UI-token通路)');

    // (c) concurrency cap: cap=3 → s2,s3 ok, s4 errors with 上限.
    const s2 = await tool(WB_PORT, token, 'shell_start', { shellId: 's2', cwd: WORK });
    ok(s2.result && s2.result.ok === true, '(c) start s2 ok');
    const s3 = await tool(WB_PORT, token, 'shell_start', { shellId: 's3', cwd: WORK });
    ok(s3.result && s3.result.ok === true, '(c) start s3 ok');
    const s4 = await tool(WB_PORT, token, 'shell_start', { shellId: 's4', cwd: WORK });
    ok(s4.result && s4.result.ok === false && String(s4.result.error || '').includes('上限'), '(c) start s4 rejected: error contains 上限 (got: ' + (s4.result && s4.result.error) + ')');

    // Bonus: deterministic-id clash + bad-id validation (under cap now would need a free slot; test on s2 name).
    const dup = await tool(WB_PORT, token, 'shell_start', { shellId: 's1' });
    ok(dup.result && dup.result.ok === false, '(c) duplicate/at-cap start rejected');

    // (d) kill s1 → shell_list no longer lists s1 (and frees a slot).
    const kill = await tool(WB_PORT, token, 'shell_kill', { shellId: 's1' });
    ok(kill.result && kill.result.ok === true, '(d) shell_kill s1 ok');
    const list = await tool(WB_PORT, token, 'shell_list', {});
    const ids = ((list.result && list.result.shells) || []).map(s => s.shellId);
    ok(!ids.includes('s1'), '(d) shell_list no longer contains s1 (got: ' + JSON.stringify(ids) + ')');
    ok(ids.includes('s2') && ids.includes('s3'), '(d) shell_list still contains s2, s3');

    // (e) v0.8-S2fix F1: the cap counts LIVE sessions only — after killing s1 (2 active of cap 3),
    // a new start must succeed (a Map-size count would eventually block on dead/exited entries).
    const s5 = await tool(WB_PORT, token, 'shell_start', { shellId: 's5', cwd: WORK });
    ok(s5.result && s5.result.ok === true, '(e) start s5 after kill succeeds (cap counts live sessions only)');

    // (f) 107-S0:执行闸判的目录 ≡ 命令真跑的目录(先腾出并发位:s2/s3/s5 全杀)。
    for (const id of ['s2', 's3', 's5']) await tool(WB_PORT, token, 'shell_kill', { shellId: id });
    const mk = await apiPost(WB_PORT, token, '/api/sessions', { title: '107-S0 会话 cwd', cwd: SESS_CWD });
    const sid = mk && mk.session && mk.session.id;
    ok(!!sid && canon(mk.session.cwd) === canon(SESS_CWD), '(f) session created with cwd SESS_CWD (got ' + JSON.stringify(mk && mk.session && mk.session.cwd) + ')');
    // f1 shell_start 不传 cwd → 会话 cwd(不是 defaultWorkspace=WORK,也不是家目录)。
    const f1 = await tool(WB_PORT, token, 'shell_start', { shellId: 's6', sessionId: sid });
    ok(f1.result && f1.result.ok === true && canon(f1.result.cwd) === canon(SESS_CWD), '(f1) shell_start without cwd → cwd is the session cwd (got ' + JSON.stringify(f1.result && (f1.result.cwd || f1.result.error)) + ')');
    const f1s = await tool(WB_PORT, token, 'shell_send', { shellId: 's6', input: '(Get-Location).Path' });
    ok(printsDir(f1s.result && f1s.result.output, SESS_CWD), '(f1) (Get-Location).Path prints the session cwd (got: ' + outHead(f1s.result && f1s.result.output) + ', home ' + JSON.stringify(os.homedir()) + ')');
    // f2 显式 cwd → 就用它(会话 cwd 不抢)。
    const f2 = await tool(WB_PORT, token, 'shell_start', { shellId: 's7', sessionId: sid, cwd: OTHER });
    const f2s = await tool(WB_PORT, token, 'shell_send', { shellId: 's7', input: '(Get-Location).Path' });
    ok(f2.result && f2.result.ok === true && printsDir(f2s.result && f2s.result.output, OTHER), '(f2) shell_start with explicit cwd prints that cwd (got: ' + outHead(f2s.result && f2s.result.output) + ')');
    // f3/f4/f5 同一个闸的另两个执行工具:powershell_run / script_run 缺省也跑在会话 cwd,显式 cwd 照用。
    const f3 = await tool(WB_PORT, token, 'powershell_run', { command: '(Get-Location).Path', sessionId: sid, timeoutMs: 30000 });
    ok(f3.result && printsDir(f3.result.stdout, SESS_CWD), '(f3) powershell_run without cwd runs in the session cwd (got: ' + outHead(f3.result && (f3.result.stdout || f3.result.stderr || f3.result.error)) + ')');
    const f4 = await tool(WB_PORT, token, 'script_run', { language: 'node', code: 'console.log(process.cwd())', sessionId: sid, timeoutMs: 30000 });
    ok(f4.result && printsDir(f4.result.stdout, SESS_CWD), '(f4) script_run without cwd runs in the session cwd (got: ' + outHead(f4.result && (f4.result.stdout || f4.result.stderr || f4.result.error)) + ')');
    const f5 = await tool(WB_PORT, token, 'powershell_run', { command: '(Get-Location).Path', sessionId: sid, cwd: OTHER, timeoutMs: 30000 });
    ok(f5.result && printsDir(f5.result.stdout, OTHER), '(f5) powershell_run with explicit cwd runs there (got: ' + outHead(f5.result && (f5.result.stdout || f5.result.error)) + ')');
    // f6 会话 cwd 就是 execute:false 的工作区 → shell_start／powershell_run 不传 cwd 仍被拒,且没起 shell。
    const mkDeny = await apiPost(WB_PORT, token, '/api/sessions', { title: '107-S0 禁止执行', cwd: DENY });
    const denySid = mkDeny && mkDeny.session && mkDeny.session.id;
    const f6 = await tool(WB_PORT, token, 'shell_start', { shellId: 's8', sessionId: denySid });
    ok(!!denySid && f6.result && f6.result.ok === false && f6.result.code === 'not-allowed', '(f6) shell_start in a session whose cwd is an execute:false workspace → denied (got ' + JSON.stringify(f6.result).slice(0, 160) + ')');
    const f6ps = await tool(WB_PORT, token, 'powershell_run', { command: 'Write-Output SHOULD_NOT_RUN', sessionId: denySid });
    ok(f6ps.result && f6ps.result.ok === false && f6ps.result.code === 'not-allowed', '(f6) powershell_run without cwd in that session → denied');
    const f6list = await tool(WB_PORT, token, 'shell_list', {});
    ok(!((f6list.result && f6list.result.shells) || []).some(s => s.shellId === 's8'), '(f6) the denied shell s8 was never started');
    // f7 对照:允许的会话里显式把 cwd 指到 DENY → 同样拒(修前修后都如此)。
    const f7 = await tool(WB_PORT, token, 'shell_start', { shellId: 's9', sessionId: sid, cwd: DENY });
    ok(f7.result && f7.result.ok === false && f7.result.code === 'not-allowed', '(f7) explicit cwd inside the execute:false workspace → denied');
    for (const id of ['s6', 's7']) await tool(WB_PORT, token, 'shell_kill', { shellId: id });
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    // Kill the workbench tree (reaps its shell children too), then the fake.
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSHELL-SESSION E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
