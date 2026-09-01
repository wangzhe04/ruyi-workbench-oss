#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// budget-guard.e2e.js — 106 #13a 预算保护基础层 + #13a-t 长命令时间预算
//
// 覆盖:
//   [U] 开关三态/阈值钳位/决策纯函数(require 直测):
//       budgetGuardEnabled(开关×预算双门)、budgetGuardDecision 预警/预留/触顶判定表、
//       13a-t 双开关严格布尔与 warn/hard/byte 阈值钳位。
//   [E-13a] 集成(fake-openai + FAKE_CAPTURE_DIR):
//       触顶即停新增模型调用(0 请求)+ 预算说明 note + budget_guard 事件;
//       大预算零触发路径与开关关逐字节一致;until-done 任务触顶降 supervised(可恢复)。
//   [E-13a-t] 集成(真实 powershell_run):
//       dead-long-runner 硬终态杀树 + 配对 tool_result 含预算原因 + 回合继续;
//       shadow 只记「本应触发」零行为变化;字节轴只计数;零触发路径逐字节不变。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 隔离纪律(同 session-notes-inject):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-unit-'));

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p, headers) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000, headers: headers || {} }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
async function getJson(port, p, headers) { const r = await get(port, p, headers); if (!r) return null; try { return JSON.parse(r.body); } catch { return null; } }
function postJson(port, p, payload, headers) { return new Promise(resolve => { const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 10000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.write(data); req.end(); }); }
function postStream(port, payload) { return new Promise(resolve => { const events = []; const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let buf = ''; res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } }); res.on('end', () => resolve(events)); }); req.on('error', () => resolve(events)); req.on('timeout', () => { req.destroy(); resolve(events); }); req.write(data); req.end(); }); }
async function tokenFor(port) { const r = await get(port, '/'); const m = r && r.body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); return m ? m[1] : ''; }

// 起一套 fake-openai + workbench;flags 写进 config.json;fakeEnv/wbEnv 追加环境变量。
async function launchStack(tag, flags, fakeEnv, wbEnv) {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-e-' + tag + '-'));
  const CAP = path.join(EHOME, 'caps'); fs.mkdirSync(CAP, { recursive: true });
  fs.writeFileSync(path.join(EHOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 40000 }],
    activeProvider: 'fake',
    autoCompactThreshold: 0.8,
    ...(flags || {}),
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_CAPTURE_DIR: CAP, ...(fakeEnv || {}) },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: EHOME, RUYI_HOME: EHOME, ...(wbEnv || {}) }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!' + tag + '] ' + l.trim())));
  let h = null; for (let i = 0; i < 80 && !h; i++) { await sleep(250); h = await get(WB_PORT, '/health'); }
  const readCap = n => { try { return JSON.parse(fs.readFileSync(path.join(CAP, 'req-' + String(n).padStart(3, '0') + '.json'), 'utf8')); } catch { return null; } };
  const capCount = () => { try { return fs.readdirSync(CAP).filter(f => f.startsWith('req-')).length; } catch { return 0; } };
  // logEvent 是异步追加流 —— 轮询读当日 ndjson,容忍flush延迟。
  const logFile = path.join(EHOME, 'logs', 'workbench-' + new Date().toISOString().slice(0, 10) + '.ndjson');
  const waitLog = async (pred, ms) => {
    const deadline = Date.now() + (ms || 4000);
    while (Date.now() < deadline) {
      let lines = []; try { lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* not yet */ }
      const hit = lines.filter(pred);
      if (hit.length) return hit;
      await sleep(200);
    }
    return [];
  };
  const cleanup = async () => { kill(wb); kill(fake); await sleep(300); fs.rmSync(EHOME, { recursive: true, force: true }); };
  return { EHOME, WB_PORT, CAP, readCap, capCount, waitLog, cleanup, healthy: !!h };
}
// 捕获请求里 role:'tool' 消息的文本合集。
function toolContents(body) {
  return (((body && body.messages) || []).filter(m => m && m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')));
}
// 逐字节等价比较前归一化已知易变字段(powershell_run 结果的 elapsedMs 是墙钟,两次运行必然不同)。
function normalizeCapText(raw) {
  return String(raw || '').replace(/elapsedMs(\\{0,2}")?:\s*\d+/g, 'elapsedMs$1:0');
}

(async () => {
  // ═══ [U] 开关三态 / 阈值钳位 / 决策纯函数 ═══
  console.log('── [U] #13a/13a-t 开关与决策白盒契约 ──');
  ok(srv.budgetGuardEnabled(srv.defaultConfig()) === false, 'U1 默认配置预算保护关闭(106 逐项取证纪律)');
  ok(srv.budgetGuardEnabled({ runtimeBudgetGuardV1: true }) === false, 'U2 开关开但预算 0 → 不把门(空转安全)');
  ok(srv.budgetGuardEnabled({ runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 50000 }) === true, 'U3 开关开+预算 >0 → 生效');
  ok(srv.budgetGuardEnabled(srv.normalizeConfig({ runtimeBudgetGuardV1: 'true', budgetGuardTurnTokensV1: 5000 }).config) === false, 'U4 字符串 "true" 洗回 false(严格布尔)');
  ok(srv.budgetGuardTurnTokens({ budgetGuardTurnTokensV1: -5 }) === 0 && srv.budgetGuardTurnTokens({ budgetGuardTurnTokensV1: 99999999 }) === 10000000 && srv.budgetGuardTurnTokens({ budgetGuardTurnTokensV1: 'x' }) === 0, 'U5 预算钳位 [0,10000000],坏值落 0(关门不放宽)');
  ok(srv.budgetGuardWarnRatio({ budgetGuardWarnRatioV1: 'x' }) === 0.8 && srv.budgetGuardWarnRatio({ budgetGuardWarnRatioV1: 2 }) === 0.99 && srv.budgetGuardWarnRatio({ budgetGuardWarnRatioV1: 0.05 }) === 0.1, 'U6 预警比例钳位 [0.1,0.99],缺省 0.8');
  ok(srv.budgetGuardDecision(0, 50, 100, 0.8) === 'ok', 'U7a 决策:远未触线 → ok');
  ok(srv.budgetGuardDecision(80, 10, 100, 0.8) === 'warn', 'U7b 决策:spent 过 80% 且还装得下下一调用 → warn');
  ok(srv.budgetGuardDecision(95, 10, 100, 0.8) === 'trip', 'U7c 决策:spent+reserve 超预算 → trip(预留在途)');
  ok(srv.budgetGuardDecision(0, 101, 100, 0.8) === 'trip', 'U7d 决策:单次调用估算即超预算 → trip(首发即停)');
  ok(srv.budgetGuardDecision(95, 6, 100, 0.8) === 'trip', 'U7e 决策:trip 优先于 warn(触顶即最强预警)');
  ok(srv.budgetGuardDecision(99999, 99999, 0, 0.8) === 'ok', 'U7f 决策:预算 0 → 恒 ok(不开门)');
  ok(srv.toolTimeBudgetEnabled(srv.defaultConfig()) === false && srv.toolTimeBudgetShadowEnabled(srv.defaultConfig()) === false, 'U8 13a-t 双开关默认关闭');
  ok(srv.toolTimeBudgetEnabled({ runtimeToolTimeBudgetV1: true }) === true && srv.toolTimeBudgetShadowEnabled({ runtimeToolTimeBudgetShadowV1: true }) === true, 'U9 13a-t 显式 true 各自生效');
  const cfgStr = srv.normalizeConfig({ runtimeToolTimeBudgetV1: 'true', runtimeToolTimeBudgetShadowV1: 'true' }).config;
  ok(srv.toolTimeBudgetEnabled(cfgStr) === false && srv.toolTimeBudgetShadowEnabled(cfgStr) === false, 'U10 13a-t 字符串 "true" 洗回 false(严格布尔)');
  ok(srv.toolTimeBudgetWarnMs({ toolTimeBudgetWarnMsV1: 500 }) === 1000 && srv.toolTimeBudgetWarnMs({ toolTimeBudgetWarnMsV1: 99999999 }) === 3600000 && srv.toolTimeBudgetWarnMs({ toolTimeBudgetWarnMsV1: 'x' }) === 0, 'U11 warn 钳位 [1000,3600000],0/坏值关闭该级');
  ok(srv.toolTimeBudgetHardMs({ toolTimeBudgetHardMsV1: 100 }) === 5000 && srv.toolTimeBudgetHardMs({ toolTimeBudgetHardMsV1: 99999999 }) === 7200000, 'U12 hard 钳位 [5000,7200000]');
  ok(srv.toolByteBudgetShadowBytes({ toolByteBudgetShadowBytesV1: -1 }) === 0 && srv.toolByteBudgetShadowBytes({ toolByteBudgetShadowBytesV1: 5 }) === 5 && srv.toolByteBudgetShadowBytes({ toolByteBudgetShadowBytesV1: 'x' }) === 0, 'U13 字节计数阈值 0=不计数,坏值落 0');

  // ═══ [E-13a] 预算保护基础层集成 ═══
  console.log('── [E] #13a 触顶停新增 / 零触发等价 / 任务暂停恢复 ──');
  const SEQ_READ = JSON.stringify([{ name: 'file_read', args: { path: 'package.json' } }, { name: 'file_read', args: { path: 'README.md' } }]);
  let baseCaps = null;
  { // A: 开关关基线 —— 两个 file_read 步骤完整跑完(3 次模型调用)。
    const A = await launchStack('a', {}, { FAKE_TOOL_SEQUENCE: SEQ_READ });
    ok(A.healthy, 'E0a workbench A listening on :' + A.WB_PORT);
    try {
      const ev = await postStream(A.WB_PORT, { message: '读两个文件' });
      ok(A.capCount() === 3 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E1 开关关基线:3 次模型调用跑完整个工具序列');
      baseCaps = [A.readCap(1), A.readCap(2), A.readCap(3)].map(c => JSON.stringify(c));
      ok(baseCaps.every(Boolean), 'E2 基线三次请求体均已捕获');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await A.cleanup(); }
  }
  { // B: 开关开+大预算 → 与基线逐字节一致,零预算事件。
    const B = await launchStack('b', { runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 10000000 }, { FAKE_TOOL_SEQUENCE: SEQ_READ });
    ok(B.healthy, 'E0b workbench B listening on :' + B.WB_PORT);
    try {
      const ev = await postStream(B.WB_PORT, { message: '读两个文件' });
      const caps = [B.readCap(1), B.readCap(2), B.readCap(3)].map(c => JSON.stringify(c));
      ok(B.capCount() === 3 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E3 开关开+大预算:3 次调用跑完(零触发)');
      ok(baseCaps && JSON.stringify(caps) === JSON.stringify(baseCaps), 'E4 零触发路径请求体与开关关逐字节一致');
      ok(!ev.some(e => e.type === 'budget_guard'), 'E5 零触发路径无 budget_guard 事件');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await B.cleanup(); }
  }
  { // C: 开关开+预算 60(小于首次调用估算)→ 首发即停:0 次模型调用 + note + tripped 事件。
    const C = await launchStack('c', { runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 60 }, {});
    ok(C.healthy, 'E0c workbench C listening on :' + C.WB_PORT);
    try {
      const ev = await postStream(C.WB_PORT, { message: '你好' });
      ok(C.capCount() === 0, 'E6 触顶:0 次模型调用发出(停止新增调用)');
      const trip = ev.find(e => e.type === 'budget_guard' && e.state === 'tripped');
      ok(!!trip && trip.axis === 'turn_tokens' && trip.spent === 0 && trip.budget === 60, 'E7 budget_guard tripped 事件口径正确(spent/reserve/budget)');
      const note = ev.filter(e => e.type === 'assistant_delta').map(e => e.text || '').join('');
      ok(note.includes('预算保护') && note.includes('60'), 'E8 触顶对模型/用户可见(预算说明 note,不静默吞掉)');
      ok(!!(ev.find(e => e.type === 'result') || {}).ok, 'E9 回合正常结束(历史完整,可发消息续跑)');
      const logs = await C.waitLog(l => l.kind === 'budget_guard_trip', 3000);
      ok(logs.length === 1 && logs[0].budget === 60, 'E10 触顶落脱敏审计账(恰好一条)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await C.cleanup(); }
  }
  { // D: until-done 任务触顶 → 降 supervised(暂停,非报错),驱动器不再续跑;用户可恢复。
    const D = await launchStack('d', { runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 60 }, {});
    ok(D.healthy, 'E0d workbench D listening on :' + D.WB_PORT);
    try {
      const token = await tokenFor(D.WB_PORT);
      const hdr = { 'x-wcw-token': token };
      const ev1 = await postStream(D.WB_PORT, { message: '准备开工' });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      ok(!!sid, 'E11 拿到 session id');
      const started = sid ? await postJson(D.WB_PORT, '/api/mission', { sessionId: sid, action: 'start', mission: { goal: '验证预算暂停', milestones: [{ id: 'm1', desc: '推进一件事' }] }, autoMode: 'until-done' }, hdr) : null;
      ok(!!started && started.body && started.body.ok === true && started.body.mission && started.body.mission.autoMode === 'until-done', 'E12 until-done 任务账本已建立');
      const before = D.capCount();
      const ev2 = await postStream(D.WB_PORT, { sessionId: sid, message: '继续推进' });
      ok(ev2.some(e => e.type === 'mission' && e.state === 'budget_guard_paused'), 'E13 触顶后任务事件 budget_guard_paused(说明原因)');
      const m1 = await getJson(D.WB_PORT, '/api/mission?sessionId=' + encodeURIComponent(sid), hdr);
      ok(m1 && m1.mission && m1.mission.autoMode === 'supervised', 'E14 触顶后 autoMode 降 supervised(暂停,进度保留,非报错)');
      ok(D.capCount() === before, 'E15 驱动器未再续跑撞墙(零新增模型调用)');
      const resumed = await postJson(D.WB_PORT, '/api/mission', { sessionId: sid, action: 'update', autoMode: 'until-done' }, hdr);
      const m2 = await getJson(D.WB_PORT, '/api/mission?sessionId=' + encodeURIComponent(sid), hdr);
      ok(!!resumed && resumed.body && resumed.body.ok === true && m2 && m2.mission && m2.mission.autoMode === 'until-done', 'E16 恢复路径:用户重设 until-done 生效(恢复状态正确)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await D.cleanup(); }
  }

  // ═══ [E-13a-t] 长命令时间预算(真实 powershell_run)═══
  console.log('── [E] #13a-t dead-long-runner 硬终态 / shadow / 字节计数 / 零触发等价 ──');
  const WB_FAST = { WCW_TOOL_HEARTBEAT_MS: '300' };
  let t0Caps = null;
  { // T0: 全关基线(快命令)。
    const T0 = await launchStack('t0', {}, { FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'powershell_run', args: { command: 'Write-Output hi' } }]) }, WB_FAST);
    ok(T0.healthy, 'E0e workbench T0 listening on :' + T0.WB_PORT);
    try {
      const ev = await postStream(T0.WB_PORT, { message: '跑个快命令' });
      ok(T0.capCount() === 2 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E17 基线:快命令 2 次调用完成');
      t0Caps = [T0.readCap(1), T0.readCap(2)].map(c => normalizeCapText(JSON.stringify(c)));
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await T0.cleanup(); }
  }
  { // T1: 主动档 dead-long-runner —— 软警告 + 硬终态杀树 + 配对 tool_result 含原因 + 回合继续。
    const T1 = await launchStack('t1', { runtimeToolTimeBudgetV1: true, toolTimeBudgetWarnMsV1: 1000, toolTimeBudgetHardMsV1: 5000 }, { FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 30' } }]) }, WB_FAST);
    ok(T1.healthy, 'E0f workbench T1 listening on :' + T1.WB_PORT);
    try {
      const t0 = Date.now();
      const ev = await postStream(T1.WB_PORT, { message: '跑个慢命令' });
      const wall = Date.now() - t0;
      ok(wall < 25000, 'E18 硬终态在 ~5s 杀树(墙钟 ' + wall + 'ms,远小于命令自身 30s)');
      ok(ev.some(e => e.type === 'tool_progress' && e.state === 'budget_soft'), 'E19 软警告 tool_progress(budget_soft)已发');
      ok(ev.some(e => e.type === 'tool_progress' && e.state === 'budget_hard'), 'E20 硬终态 tool_progress(budget_hard)已发');
      const cap2 = T1.readCap(2);
      const tools = cap2 ? toolContents(cap2).join('\n') : '';
      ok(!!cap2 && tools.includes('时间预算'), 'E21 配对 tool_result 含预算中断原因(回合继续,模型可见)');
      ok(tools.includes('budgetKilled') || tools.includes('timeBudgetInterrupted'), 'E22 tool_result 带预算中断标记(不冒称正常结束)');
      const logs = await T1.waitLog(l => l.kind === 'tool_time_budget' && l.state === 'hard_kill' && l.mode === 'enforce', 3000);
      ok(logs.length === 1 && logs[0].deadlineMs === 5000, 'E23 硬终态落脱敏审计账(deadline/工具名,不含命令正文)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await T1.cleanup(); }
  }
  { // T2: shadow 档 —— 命令自然跑完(8s),只记「本应触发」;叠加字节轴计数。
    const T2 = await launchStack('t2', { runtimeToolTimeBudgetShadowV1: true, toolTimeBudgetWarnMsV1: 1000, toolTimeBudgetHardMsV1: 5000, toolByteBudgetShadowBytesV1: 10 }, { FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'powershell_run', args: { command: "Start-Sleep -Seconds 8; Write-Output ('x'*50)" } }]) }, WB_FAST);
    ok(T2.healthy, 'E0g workbench T2 listening on :' + T2.WB_PORT);
    try {
      const t0 = Date.now();
      const ev = await postStream(T2.WB_PORT, { message: '跑个中等命令' });
      const wall = Date.now() - t0;
      ok(wall >= 7000, 'E24 shadow 不动作:命令自然跑完(墙钟 ' + wall + 'ms ≥ 8s 命令时长)');
      ok(!ev.some(e => e.type === 'tool_progress' && (e.state === 'budget_soft' || e.state === 'budget_hard')), 'E25 shadow 零用户面事件(零行为变化)');
      const cap2 = T2.readCap(2);
      const tools = cap2 ? toolContents(cap2).join('\n') : '';
      ok(!!cap2 && !tools.includes('budgetKilled') && !tools.includes('时间预算'), 'E26 shadow 的配对 tool_result 与正常完成无异');
      const wl = await T2.waitLog(l => l.kind === 'tool_time_budget' && l.mode === 'shadow' && l.state === 'would_hard_kill', 3000);
      const ws = await T2.waitLog(l => l.kind === 'tool_time_budget' && l.mode === 'shadow' && l.state === 'would_soft_warning', 1000);
      ok(wl.length === 1 && ws.length === 1, 'E27 shadow 落「本应软警告/本应硬杀」各一条(校准阈值用)');
      const bb = await T2.waitLog(l => l.kind === 'tool_byte_budget_shadow' && l.bytes > 10, 2000);
      ok(bb.length === 1 && bb[0].thresholdBytes === 10, 'E28 字节轴只计数:超阈值完成调用落一条计数事件(不改写结果)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await T2.cleanup(); }
  }
  { // T3: 主动档+高阈值(零触发)→ 与全关基线逐字节一致。
    const T3 = await launchStack('t3', { runtimeToolTimeBudgetV1: true, toolTimeBudgetWarnMsV1: 1000, toolTimeBudgetHardMsV1: 60000 }, { FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'powershell_run', args: { command: 'Write-Output hi' } }]) }, WB_FAST);
    ok(T3.healthy, 'E0h workbench T3 listening on :' + T3.WB_PORT);
    try {
      const ev = await postStream(T3.WB_PORT, { message: '跑个快命令' });
      const caps = [T3.readCap(1), T3.readCap(2)].map(c => normalizeCapText(JSON.stringify(c)));
      ok(T3.capCount() === 2 && !!(ev.find(e => e.type === 'result') || {}).ok, 'E29 主动档零触发:快命令正常完成');
      ok(t0Caps && JSON.stringify(caps) === JSON.stringify(t0Caps), 'E30 零触发路径请求体与全关基线逐字节一致(elapsedMs 墙钟已归一化)');
      const logs = await T3.waitLog(l => l.kind === 'tool_time_budget' || l.kind === 'tool_byte_budget_shadow', 1500);
      ok(logs.length === 0, 'E31 零触发路径零预算日志(无误报)');
    } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
    finally { await T3.cleanup(); }
  }

  console.log(failures === 0 ? '\nBUDGET-GUARD E2E: ALL PASS' : '\nBUDGET-GUARD E2E: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
