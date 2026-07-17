// E2E (第35波 P2 索引去重注入): Claude 引擎的「稳定索引段」(技能/记忆/编排提示)不再每轮塞进
// --append-system-prompt,而是经 stdin <workbench-context> 块一次性注入,按内容 hash 去重:
//   (A) 首轮: 索引经 stdin 注入(meta.indexInjected=true,带 hash);--append-system-prompt 不含技能索引。
//   (B) 次轮(同会话同内容,resume 保真 — WCW_FAKE_SID 固定): 不重复注入(meta.indexInjected=false,hash 不变);
//       stdin 仍保留 recovery history + <current_user_message>。
//   (C) 启用技能集变化 → hash 变 → 重新注入(新旧技能都在,hash 变)。
//   (D) 再次稳定 → 恢复去重跳过。
//   (E) slash 命令轮: 不注入(必须占 stdin 首 token)且不污染 hash —— 下一轮普通消息仍按去重跳过。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'wcw-index-dedup-e2e');
const CWD = path.join(HOME, 'project');
const ARGV_CAP = path.join(HOME, 'argv.json');
const STDIN_CAP = path.join(HOME, 'stdin.txt');
const PORT_P = getFreePort(); // CJS 不允许顶层 await(Node 24)—— main IIFE 里解
let PORT = 0;

// ---- fixtures -------------------------------------------------------------------------------------------
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print',
}, null, 2));
function writeSkill(id, desc) {
  const dir = path.join(HOME, 'skills', id); // 用户技能库(dataRoot/skills)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${desc}\n---\n\n# ${id}\n\nbody\n`);
}
writeSkill('dedup-skill-a', 'DEDUP_MARKER_A 去重测试技能甲');
writeSkill('dedup-skill-b', 'DEDUP_MARKER_B 去重测试技能乙');

// ---- http helpers ---------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
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
async function turn(port, sessionId, message) {
  for (const f of [ARGV_CAP, STDIN_CAP]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  const evts = await postStream(port, { sessionId, message, cwd: CWD });
  let argv = [], stdinTxt = '';
  for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
  for (let i = 0; i < 20 && !fs.existsSync(STDIN_CAP); i++) await sleep(100);
  try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
  try { stdinTxt = fs.readFileSync(STDIN_CAP, 'utf8'); } catch { /* left empty */ }
  const ai = argv.indexOf('--append-system-prompt');
  return { evts, argv, stdinTxt, appendVal: ai >= 0 ? String(argv[ai + 1] || '') : '', meta: evts.find(e => e.type === 'meta') || {} };
}

(async () => {
  PORT = await PORT_P;
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, windowsHide: true,
    env: {
      ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, RUYI_HOME: HOME,
      WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP, WCW_FAKE_STDIN_CAPTURE: STDIN_CAP,
      WCW_FAKE_SID: 'fake-dedup-sid-0001', // resume 保真: 每轮回放同一 session id(真实 CLI --resume 的行为)
    },
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT); }
    ok(!!h, '(0) 工作台 listening :' + PORT);
    const sess = (await postJson(PORT, '/api/sessions', { cwd: CWD })).body.session;
    await postJson(PORT, '/api/session/skills', { sessionId: sess.id, skills: ['dedup-skill-a'] });

    // (A) 首轮: 注入
    const t1 = await turn(PORT, sess.id, 'dedup turn one');
    ok(t1.meta.indexInjected === true && typeof t1.meta.indexHash === 'string' && t1.meta.indexHash.length > 0, '(A1) 首轮 meta.indexInjected=true 且带 hash (' + t1.meta.indexHash + ')');
    ok(/<workbench-context>/.test(t1.stdinTxt) && t1.stdinTxt.includes('dedup-skill-a'), '(A2) 首轮 stdin <workbench-context> 注入技能索引(dedup-skill-a)');
    ok(!/<skill-index>/.test(t1.appendVal), '(A3) --append-system-prompt 不含技能索引(P2 信道分离)');
    ok(t1.stdinTxt.includes('<current_user_message>') && t1.stdinTxt.includes('dedup turn one'), '(A4) stdin 保留 <current_user_message> 定界与用户消息');
    const H1 = t1.meta.indexHash;

    // (B) 次轮(同内容): 去重跳过
    const t2 = await turn(PORT, sess.id, 'dedup turn two');
    ok(t2.meta.indexInjected === false, '(B1) 内容未变 → meta.indexInjected=false(去重跳过)');
    ok(t2.meta.indexHash === H1, '(B2) hash 不变(仍上报供观测)');
    ok(!/<workbench-context>/.test(t2.stdinTxt), '(B3) stdin 不含 <workbench-context>(不重复发送索引)');
    ok(t2.stdinTxt.includes('dedup turn one') && t2.stdinTxt.includes('<current_user_message>'), '(B4) recovery history 与用户消息定界照常');

    // (C) 启用技能集变化: 重注
    await postJson(PORT, '/api/session/skills', { sessionId: sess.id, skills: ['dedup-skill-a', 'dedup-skill-b'] });
    const t3 = await turn(PORT, sess.id, 'dedup turn three');
    ok(t3.meta.indexInjected === true && t3.meta.indexHash && t3.meta.indexHash !== H1, '(C1) 技能集变化 → hash 变 → 重新注入(hash ' + H1 + ' → ' + t3.meta.indexHash + ')');
    ok(t3.stdinTxt.includes('dedup-skill-a') && t3.stdinTxt.includes('dedup-skill-b'), '(C2) 重注内容含新旧两个技能');

    // (D) 再次稳定: 恢复去重
    const t4 = await turn(PORT, sess.id, 'dedup turn four');
    ok(t4.meta.indexInjected === false && t4.meta.indexHash === t3.meta.indexHash && !/<workbench-context>/.test(t4.stdinTxt), '(D1) 内容再次稳定 → 恢复去重跳过');

    // (E) slash 命令轮: 不注入、不污染 hash
    const t5 = await turn(PORT, sess.id, '/compact');
    ok(!/<workbench-context>/.test(t5.stdinTxt), '(E1) slash 命令轮 stdin 无注入块(必须占首 token)');
    ok(t5.stdinTxt.trim().startsWith('/compact'), '(E2) slash 命令原文居首');
    const t6 = await turn(PORT, sess.id, 'dedup turn six');
    ok(t6.meta.indexInjected === false && t6.meta.indexHash === t3.meta.indexHash, '(E3) slash 轮未污染 hash —— 后续普通轮仍按去重跳过');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nINDEX-DEDUP E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
