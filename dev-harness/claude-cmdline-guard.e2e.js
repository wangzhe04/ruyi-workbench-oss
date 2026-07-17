// E2E (cmd8191 防线): 技能索引/角色定义把 Claude CLI 命令行顶过 cmd.exe 8191 字符上限 → 「命令行太长。」
// 事故的回归测试。三层:
//   (A) 单元(require server.js): spawnCmdLineLength 与 batchSafeSpawn 的真实构造【严格同构】;cmdLineBudgetFor
//       的启动器分档;fenceSafeSlice / shrinkFencedSection / clampAppendWithSkills / appendTurnPolicies 的围栏安全;
//       classifyClaudeSubagentFailure 把「命令行太长。」列为 definitive(不无谓重试)。
//   (B) 集成(WCW_CLAUDE_CMDLINE_BUDGET 测试缝 + fake-claude argv 捕获): 对抗配置(长用户 append + 4 技能 +
//       团队模式政策压力)下 —— 回合正常完成;整行(按 cmd 公式重建)≤ 预算;append 以用户 MARKER 开头、以
//       </response-language-policy> 收尾;所有围栏开闭配对(无悬空开标签);降级经 stderr 事件与 meta.cmdlineGuard 告知。
//   (C) 对照(无测试缝): 同样配置不触发任何降级 —— 哨兵不改变预算内行为(append 完整、--agents 在、无守卫事件)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'wcw-cmdline-guard-e2e');
const CWD = path.join(HOME, 'project');
const ARGV_CAP = path.join(HOME, 'argv.json');
const PORT_A = await getFreePort(), PORT_B = await getFreePort();
const MARKER = 'CMDGUARD_MARKER_ZQ';
const BUDGET = 4200; // 对抗预算:真实 7900 的一半强,足以保住 用户append+团队/语言政策,不足以放技能段与 --agents

const srv = require(path.join(WB, 'app', 'server.js'));

const { getFreePort } = require('./free-port.js');

// ---- fixtures -------------------------------------------------------------------------------------------
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print',
  appendSystemPrompt: MARKER + ' ' + '用户自定义系统提示。'.repeat(80), // ~800 字用户 append,最高优先级
}, null, 2));
function writeSkill(id, descLen) {
  const dir = path.join(CWD, '.ruyi', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} 描述。${'该技能用于压力测试命令行预算。'.repeat(descLen)}\n---\n\n# ${id}\n\nbody\n`);
}
for (let i = 0; i < 4; i++) writeSkill(`guard-skill-${i}`, 6); // 技能段合计 ~1500+ 字

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
async function startServer(port, extraEnv) {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP, ...extraEnv },
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); }
  return { wb, h };
}
async function stopServer(wb) { if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } await sleep(300); }
// 与服务端 spawnCmdLineLength 的 cmd 公式严格同构(测试缝开启时服务端对 node 直启也用此公式)。
function cmdLineOf(argvAfterFake) {
  const comspec = process.env.ComSpec || 'cmd.exe';
  const line = '"' + [process.execPath, ...argvAfterFake].map(srv.quoteWinArg).join(' ') + '"';
  return `${comspec} /d /s /c ${line}`.length;
}
function fenceBalance(text) {
  // 返回开闭不配对的标签清单;空数组 = 所有围栏配对(无悬空开标签)
  const names = new Set();
  for (const m of String(text).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)>/g)) names.add(m[1]);
  const bad = [];
  for (const n of names) {
    const opens = (String(text).match(new RegExp(`<${n}>`, 'g')) || []).length + (String(text).match(new RegExp(`<${n} [^>]*>`, 'g')) || []).length;
    const closes = (String(text).match(new RegExp(`</${n}>`, 'g')) || []).length;
    if (opens !== closes) bad.push({ tag: n, opens, closes });
  }
  return bad;
}

(async () => {
  let fail = 0;
  let wbA = null, wbB = null;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    // ============================== (A) 单元层 ==============================
    // A1: spawnCmdLineLength 与 batchSafeSpawn 的真实构造严格同构 —— 预算核算的就是 cmd 实际收到的那一行。
    const sampleArgs = ['-p', '--output-format', 'stream-json', '--append-system-prompt', '含 空格与"引号"与中文'.repeat(30), '--add-dir', 'C:\\some dir\\x'];
    const s = srv.batchSafeSpawn('C:\\npm\\claude.cmd', sampleArgs);
    const realLine = `${s.command} ${s.args.join(' ')}`;
    ok(srv.spawnCmdLineLength('C:\\npm\\claude.cmd', sampleArgs) === realLine.length, '(A1) spawnCmdLineLength === batchSafeSpawn 真实命令行长度 (' + realLine.length + ')');
    // A2: 预算分档 —— .cmd → 7900;直启 → 32000;测试缝覆盖;非 Windows → 0。
    const seamEnv = process.env.WCW_CLAUDE_CMDLINE_BUDGET;
    delete process.env.WCW_CLAUDE_CMDLINE_BUDGET;
    if (process.platform === 'win32') {
      ok(srv.cmdLineBudgetFor('C:\\npm\\claude.cmd') === 7900, '(A2a) .cmd 启动器预算 7900');
      ok(srv.cmdLineBudgetFor('C:\\npm\\claude.exe') === 32000, '(A2b) 直启预算 32000');
    } else {
      ok(srv.cmdLineBudgetFor('claude') === 0, '(A2ab) 非 Windows 不设防(0)');
    }
    process.env.WCW_CLAUDE_CMDLINE_BUDGET = '2600';
    ok(srv.cmdLineBudgetFor('whatever') === 2600, '(A2c) 测试缝强制预算 2600');
    if (seamEnv == null) delete process.env.WCW_CLAUDE_CMDLINE_BUDGET; else process.env.WCW_CLAUDE_CMDLINE_BUDGET = seamEnv;
    // A3: fenceSafeSlice —— 切点落在围栏内时回退到开标签之前,不留悬空围栏。
    const fenced = '用户文本\n\n头部\n<skill-index>\n- a\n- b\n</skill-index>\n\n尾';
    const cutInside = fenced.indexOf('- b');
    const sliced = srv.fenceSafeSlice(fenced, cutInside);
    ok(fenceBalance(sliced).length === 0 && !sliced.includes('<skill-index>'), '(A3a) 栏内切点 → 整段回退(无悬空 <skill-index>)');
    ok(srv.fenceSafeSlice(fenced, fenced.length + 10) === fenced, '(A3b) 房间足够 → 原文不动');
    const cutOutside = fenced.indexOf('\n\n头部');
    ok(srv.fenceSafeSlice(fenced, cutOutside) === fenced.slice(0, cutOutside), '(A3c) 栏外切点 → 普通截断');
    // A4: shrinkFencedSection —— 栏内截断保闭合;外壳放不下 → 整体丢弃。
    const sec = '声明头部\n<skill-index>\n- 技能甲：描述\n- 技能乙：描述\n- 技能丙：描述\n</skill-index>';
    const shrunk = srv.shrinkFencedSection(sec, sec.length - 10);
    ok(shrunk.length <= sec.length - 10 + 20 && shrunk.endsWith('</skill-index>') && shrunk.includes('已截断'), '(A4a) 段内收缩保闭合围栏 + 截断标记');
    ok(srv.shrinkFencedSection(sec, 30) === '', '(A4b) 外壳放不下 → 整体丢弃');
    // A5: clampAppendWithSkills —— 极限压缩下用户 append 在前、围栏不悬空。
    const skillSec = '头部\n<skill-index>\n' + Array.from({ length: 20 }, (_, i) => `- 技能${i}：${'描述'.repeat(40)}`).join('\n') + '\n</skill-index>';
    const clamped = srv.clampAppendWithSkills('USER_' + '用户'.repeat(100), skillSec, 1200);
    ok(clamped.length <= 1200 && clamped.startsWith('USER_') && fenceBalance(clamped).length === 0, '(A5) clampAppendWithSkills 钳 1200:用户段优先 + 围栏配对 (' + clamped.length + ')');
    // A6: appendTurnPolicies —— 政策段恒完整在末尾;prior 被裁时不留悬空围栏、总长不超。
    const pol = srv.appendTurnPolicies('U'.repeat(100) + '\n\n头\n<workbench-memory>\n' + 'M'.repeat(500) + '\n</workbench-memory>', { locale: 'zh-CN' }, false, 1200);
    ok(pol.endsWith('</response-language-policy>') && fenceBalance(pol).length === 0, '(A6a) 政策段收尾 + 围栏配对 (len ' + pol.length + ')');
    ok(pol.length <= 1200, '(A6b) 总长 ≤ 1200 (' + pol.length + ')');
    // A7: 分类器 —— 「命令行太长。」中英文签名都是 definitive(确定性参数错误,重试同样的 args 只会再败)。
    const clsZh = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: '命令行太长。\r\n', assistantText: '', toolCallCount: 0, gotResult: false, resultOk: true });
    const clsEn = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: 'The command line is too long.', assistantText: '', toolCallCount: 0, gotResult: false, resultOk: true });
    ok(clsZh.retry === false && clsZh.reason === 'definitive', '(A7a) 中文签名 → definitive 不重试');
    ok(clsEn.retry === false && clsEn.reason === 'definitive', '(A7b) 英文签名 → definitive 不重试');

    // ============================== (B) 集成层(测试缝强制预算) ==============================
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    const A = await startServer(PORT_A, { WCW_CLAUDE_CMDLINE_BUDGET: String(BUDGET) });
    wbA = A.wb;
    ok(!!A.h, '(B0) 带缝工作台 listening :' + PORT_A);
    const sessA = (await postJson(PORT_A, '/api/sessions', { cwd: CWD })).body.session;
    await postJson(PORT_A, '/api/session/skills', { sessionId: sessA.id, skills: ['guard-skill-0', 'guard-skill-1', 'guard-skill-2', 'guard-skill-3'] });
    const evts = await postStream(PORT_A, { sessionId: sessA.id, message: 'hello guard', cwd: CWD, agentTeam: true });
    const result = evts.find(e => e.type === 'result');
    ok(result && result.ok === true, '(B1) 对抗配置下回合正常完成(不硬失败)');
    let argv = [];
    for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
    const lineLen = cmdLineOf(argv);
    ok(lineLen <= BUDGET, '(B2) 重建 cmd 整行长度 ' + lineLen + ' ≤ 预算 ' + BUDGET);
    const ai = argv.indexOf('--append-system-prompt');
    ok(ai >= 0, '(B3) --append-system-prompt 仍在');
    const appendVal = ai >= 0 ? String(argv[ai + 1] || '') : '';
    ok(appendVal.startsWith(MARKER), '(B4) 用户 append 是最前段(最高优先级存活)');
    ok(appendVal.endsWith('</response-language-policy>'), '(B5) 语言政策段恒完整在末尾');
    ok(fenceBalance(appendVal).length === 0, '(B6) append 内所有围栏开闭配对 ' + JSON.stringify(fenceBalance(appendVal)));
    const guardStderr = evts.find(e => e.type === 'stderr' && /启动守卫/.test(e.text || ''));
    ok(!!guardStderr, '(B7) 降级经 stderr 事件告知用户 — ' + (guardStderr ? String(guardStderr.text).slice(0, 80) : '(无)'));
    const meta = evts.find(e => e.type === 'meta');
    ok(meta && meta.cmdlineGuard && Array.isArray(meta.cmdlineGuard.degraded) && meta.cmdlineGuard.degraded.length > 0, '(B8) meta.cmdlineGuard 携带降级明细 — ' + JSON.stringify(meta && meta.cmdlineGuard && meta.cmdlineGuard.degraded));
    ok(argv.indexOf('--agents') < 0 || (() => { try { JSON.parse(argv[argv.indexOf('--agents') + 1]); return true; } catch { return false; } })(), '(B9) --agents 要么被降级裁剪,要么 JSON 完好可解析');
    await stopServer(wbA); wbA = null;

    // ============================== (C) 对照层(无测试缝 → 不降级) ==============================
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    const B = await startServer(PORT_B, {});
    wbB = B.wb;
    ok(!!B.h, '(C0) 无缝工作台 listening :' + PORT_B);
    const sessB = (await postJson(PORT_B, '/api/sessions', { cwd: CWD })).body.session;
    await postJson(PORT_B, '/api/session/skills', { sessionId: sessB.id, skills: ['guard-skill-0', 'guard-skill-1', 'guard-skill-2', 'guard-skill-3'] });
    const evtsC = await postStream(PORT_B, { sessionId: sessB.id, message: 'hello guard', cwd: CWD });
    let argvC = [];
    for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argvC = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
    const aiC = argvC.indexOf('--append-system-prompt');
    const appendC = aiC >= 0 ? String(argvC[aiC + 1] || '') : '';
    ok(appendC.startsWith(MARKER) && appendC.includes('</skill-index>') && appendC.endsWith('</response-language-policy>'), '(C1) 预算内:技能段完整注入 + 首尾契约不变');
    ok(argvC.indexOf('--agents') >= 0, '(C2) 预算内:--agents 角色定义照常注入');
    ok(!evtsC.some(e => e.type === 'stderr' && /启动守卫/.test(e.text || '')), '(C3) 预算内:无守卫降级事件(行为逐字节不变)');
    const metaC = evtsC.find(e => e.type === 'meta');
    ok(metaC && metaC.cmdlineGuard === undefined, '(C4) 预算内:meta 不带 cmdlineGuard');
    await stopServer(wbB); wbB = null;
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    await stopServer(wbA); await stopServer(wbB);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCLAUDE-CMDLINE-GUARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
