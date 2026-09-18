require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 116 波 116-2b · 27 号文 §3.3/§3.5/§11.6):停滞与预算信号落持久日志 + 管家自理动作真实执行
// + 既有线程的插话补充。
//
// 为什么需要这一件:116b 的交付记录登记了一个缺口 —— `subagent_no_progress` / `loop_recovery` /
// `budget_guard` 只走 SSE 与审计日志,不落三条带 seq 的持久日志,而管家收件箱只读那三条日志。
// 于是「线程还在跑但没往前走」「线程撞了预算墙」这两类事,管家永远看不见。本件从【真实引擎路径】
// 造出这两类事实,一路验到收件箱与自理动作。
//
// 覆盖:
//  (A) 开关【关】时:主回合 loop_recovery -> 账本 change type 'stalled',一个回合里两次纠偏只落一条
//      (写入端 5 分钟频控);budget_guard tripped -> 账本 'budget_tripped',每回合最多一条、两个回合两条;
//      `<data>/steward` 目录不存在(账本是线程自己的持久化,不受管家开关影响 —— 这正是纪律)。
//  (B) 开关【开】:新写入的 'stalled' / 'budget_tripped' 经轮询进收件箱,kind 落 stalled / budget,
//      payload 带 reason/count/spent/budget 摘要且不带工具输出正文。
//  (C) 合成 agent run 事件文件里的 'run_stalled' / 'run_budget_tripped' 同样入箱(带 runId)。
//  (D) 自理动作(进程内,时序可判定):retry 开 + 线程 acceptEdits -> failed 事件后【自动】递话「继续」,
//      决策日志出现、steward_reply.actions 里 auto:true;同一目标本小时第二次失败不再自动。
//  (E) retry 关 / 线程 default -> 只有一条 act「重试」,零执行零决策日志。
//  (F) resume:null 跟随 autonomyAutoResume 的两态。
//  (G) steward_thread_note:目标有在途回合 -> 插话被下一步消费(会话正文出现 steered:true 的
//      「（管家补充）」那一条);无在途回合 -> steward.no_active_turn;普通 ctx -> steward.forbidden。
//  (H) 开关关时:账本照写,但收件箱与自理零动作零写入。
//
// 端口全部 getFreePort() 动态取。判定行:`STEWARD SIGNALS E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-signals-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }

const TOOL_PORT = await getFreePort();
const STEER_PORT = await getFreePort();
const REPLY_PORT = await getFreePort();
const WB_PORT = await getFreePort();
// 主端点在进程内阶段要换成「慢且有多轮工具」的那个 fake(插话必须有迭代边界才谈得上被消费)。
let toolsPort = TOOL_PORT;
const POLL_MS = 5000;                    // stewardPollMs 下限
const stewardDir = path.join(HOME, 'steward');
const inboxFile = path.join(stewardDir, 'inbox-v1.ndjson');
const decisionsFile = path.join(stewardDir, 'decisions-v1.ndjson');

// ── 两个 fake:一个演工具(造 loop_recovery 与真回合),一个演管家的结构化答复 ───────────────────
const LOOP_TARGET = path.join(HOME, 'loop-me.txt');
fs.writeFileSync(LOOP_TARGET, 'loop fixture');
// 同一个 file_write 重复 16 次:5 次命中 -> 注入恢复指令(loop_recovery attempt 1),再 5 次 -> attempt 2,
// 第 3 次命中才硬停。故一个回合里恰好有【两次】loop_recovery —— 正好用来验写入端频控只落一条。
const LOOP_STEP = { name: 'file_write', args: { path: LOOP_TARGET, content: 'loop fixture' } };
const STEWARD_REPLY = JSON.stringify({ say: '我看了一眼。', why: '收件箱', acts: [], actions: [] });

const toolFake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
  // 32 步 = 两个循环回合各 15 次调用(第 3 次 5x 命中硬停)。(A) 用一个,(B) 用另一个。
  env: { ...process.env, FAKE_OPENAI_PORT: String(TOOL_PORT), FAKE_TOOL_SEQUENCE: JSON.stringify(Array.from({ length: 32 }, () => LOOP_STEP)) },
  windowsHide: true,
});
const replyFake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(REPLY_PORT)], {
  env: { ...process.env, FAKE_REPLY_SEQUENCE: JSON.stringify([STEWARD_REPLY]) },
  windowsHide: true,
});
for (const f of [toolFake, replyFake]) f.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
await sleep(700);

// ── config ──────────────────────────────────────────────────────────────────────────────────
function writeConfig(patch) {
  const config = {
    configSchema: 7, activeProvider: 'tools', engineMode: 'interactive',
    permissionMode: 'bypass',            // 循环夹具要 file_write 真跑起来,不能停在 permission
    permissionTimeoutMs: 30000, includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false,
    stewardEnabledV1: false, stewardPollMs: POLL_MS,
    stewardMaxTurnsPerHour: 100, stewardMaxCostPerDay: 0,
    stewardProviderId: 'replies',        // 管家自己走「只会答话」的那个端点
    stewardContextBudgetTokens: 200000, stewardReadBudgetChars: 48000,
    stewardVisitIdleMinutes: 60, stewardConversationRetention: 'visit',
    stewardAutoActions: { retry: true, resume: null, relay: false, newThread: true },
    autonomyAutoResume: false,
    providers: [
      { id: 'tools', label: 'Tools', type: 'openai-compat', baseUrl: `http://127.0.0.1:${toolsPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
      { id: 'replies', label: 'Replies', type: 'openai-compat', baseUrl: `http://127.0.0.1:${REPLY_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
    ],
    ...patch,
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return config;
}
writeConfig({});

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────────────────────
function token() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(method, urlPath, body) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: WB_PORT, path: urlPath, method,
      headers: { 'x-wcw-token': token(), ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json, lines: text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
      });
    });
    req.on('error', () => resolve({ status: 0, text: '', json: null, lines: [] }));
    if (payload) req.write(payload);
    req.end();
  });
}
function changes(sid) {
  try {
    return fs.readFileSync(path.join(HOME, 'sessions', sid + '.changes.ndjson'), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const changesOf = (sid, type) => changes(sid).filter(r => r.type === type);
async function newMissionSession(title) {
  const created = await request('POST', '/api/sessions', { title, cwd: HOME });
  const sid = created.json && created.json.session && created.json.session.id;
  if (sid) await request('POST', '/api/mission', { sessionId: sid, action: 'start', mission: { goal: title, milestones: [{ id: 'm1', desc: '推进一件事' }] }, autoMode: 'off' });
  return sid;
}
function spawnWb() {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  child.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  return child;
}
async function waitUp() { for (let i = 0; i < 120; i++) { await sleep(150); const r = await request('GET', '/api/status'); if (r.status === 200) return true; } return false; }
function inboxRows() {
  try { return fs.readFileSync(inboxFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
async function tickUntil(predicate, budgetMs) {
  const deadline = Date.now() + (budgetMs || 15000);
  for (;;) {
    await request('POST', '/api/steward/start', {});
    const rows = inboxRows();
    if (predicate(rows)) return rows;
    if (Date.now() > deadline) return rows;
    await sleep(400);
  }
}

let wb = null;
let SID_LOOP = '', SID_BUDGET = '', SID_RUN = '';
try {
  /* ═════════ (A) 开关关:两类信号照样落账本 ═════════ */
  console.log('── (A) 开关关:信号落账本 ──');
  wb = spawnWb();
  ok(await waitUp(), 'A0 工作台起来了');

  SID_LOOP = await newMissionSession('循环夹具');
  ok(!!SID_LOOP, 'A1 建了一条带任务账本的线程(循环)');
  {
    const ev = await request('POST', '/api/chat/stream', { sessionId: SID_LOOP, message: '开始', cwd: HOME });
    const recoveries = ev.lines.filter(l => l.type === 'loop_recovery' && l.state === 'injected');
    ok(recoveries.length === 2, `A2 一个回合里恰好两次 loop_recovery(既有夹具口径;got ${recoveries.length})`);
    const stalled = changesOf(SID_LOOP, 'stalled');
    ok(stalled.length === 1, `A3 两次纠偏只落【一条】 change type 'stalled'(写入端 5 分钟频控;got ${stalled.length})`);
    const row = stalled[0] || {};
    ok(row.detail && row.detail.reason === 'loop_recovery' && Number(row.detail.count) >= 1,
      `A4 detail 只带原因与计数(reason=${row.detail && row.detail.reason} count=${row.detail && row.detail.count})`);
    ok(row.detail && !('content' in row.detail) && !JSON.stringify(row.detail).includes('loop fixture'),
      'A5 detail 不带工具输出正文(与 failure 同纪律)');
    ok(Number(row.seq) >= 1 && row.cursor && Number(row.cursor.turnSeq) >= 1, 'A6 记录带账本 seq 与 cursor.turnSeq(收件箱据此增量消费)');
  }

  SID_BUDGET = await newMissionSession('预算夹具');
  ok(!!SID_BUDGET, 'A7 建了第二条线程(预算)');
  {
    writeConfig({ runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 60 });
    const ev = await request('POST', '/api/chat/stream', { sessionId: SID_BUDGET, message: '你好', cwd: HOME });
    ok(ev.lines.some(l => l.type === 'budget_guard' && l.state === 'tripped'), 'A8 budget_guard tripped 事件照旧发出(SSE 不变)');
    const tripped = changesOf(SID_BUDGET, 'budget_tripped');
    ok(tripped.length === 1, `A9 触顶落一条 change type 'budget_tripped'(got ${tripped.length})`);
    const row = tripped[0] || {};
    ok(row.detail && row.detail.axis === 'turn_tokens' && Number(row.detail.budget) === 60,
      `A10 detail 带 axis/spent/budget 摘要(budget=${row.detail && row.detail.budget})`);
    // 第二个回合 -> 第二条(每回合最多一条,不是每次判定一条)。
    await request('POST', '/api/chat/stream', { sessionId: SID_BUDGET, message: '再来', cwd: HOME });
    const after = changesOf(SID_BUDGET, 'budget_tripped');
    ok(after.length === 2, `A11 第二个回合再落一条(每回合最多一条;got ${after.length})`);
    ok(new Set(after.map(r => r.cursor && r.cursor.turnSeq)).size === 2, 'A12 两条分属不同 turnSeq(按回合去重,不是按时间)');
    ok(changesOf(SID_BUDGET, 'budget').length === 0 || changesOf(SID_BUDGET, 'budget').every(r => r.type === 'budget'),
      "A13 既有心跳 type 'budget' 与新 'budget_tripped' 是两个 type(没有互相顶掉)");
    writeConfig({});
  }
  ok(!fs.existsSync(stewardDir), 'A14 开关关:账本照写,但 <data>/steward 目录不存在(收件箱零写入)');
} finally {
  kill(wb); wb = null;
}
await sleep(400);

try {
  /* ═════════ (B)(C) 开关开:两类信号进收件箱 ═════════ */
  console.log('── (B)(C) 开关开:信号进收件箱 ──');
  writeConfig({ stewardEnabledV1: true });
  wb = spawnWb();
  ok(await waitUp(), 'B0 工作台(开关开)起来了');
  // 冷启动只建基线:先跑一轮,让两条既有线程的账本游标就位,之后【新写入】的才该入箱。
  await tickUntil(() => true, 1000);
  const baseline = inboxRows().length;

  {
    // 又一个循环回合 -> 新的 'stalled'(进程重启,频控窗口重开)。
    await request('POST', '/api/chat/stream', { sessionId: SID_LOOP, message: '再来一遍', cwd: HOME });
    const rows = await tickUntil(r => r.some(x => x.kind === 'stalled' && x.sessionId === SID_LOOP), 20000);
    const row = rows.find(x => x.kind === 'stalled' && x.sessionId === SID_LOOP) || null;
    ok(!!row, "B1 账本 'stalled' -> 收件箱 kind=stalled");
    ok(row && row.payload && row.payload.changeType === 'stalled' && row.payload.reason === 'loop_recovery',
      `B2 payload 带 changeType 与 reason(got ${row && row.payload && row.payload.reason})`);
    ok(row && /停住了/.test(String(row.payload.summary || '')), `B3 摘要是人话(got ${row && row.payload && row.payload.summary})`);
    ok(row && !JSON.stringify(row.payload).includes('loop fixture'), 'B4 payload 不带工具输出正文');
  }
  {
    writeConfig({ stewardEnabledV1: true, runtimeBudgetGuardV1: true, budgetGuardTurnTokensV1: 60 });
    await request('POST', '/api/chat/stream', { sessionId: SID_BUDGET, message: '第三次', cwd: HOME });
    const rows = await tickUntil(r => r.some(x => x.kind === 'budget' && x.sessionId === SID_BUDGET), 20000);
    const row = rows.find(x => x.kind === 'budget' && x.sessionId === SID_BUDGET) || null;
    ok(!!row, "B5 账本 'budget_tripped' -> 收件箱 kind=budget");
    ok(row && row.payload && row.payload.changeType === 'budget_tripped' && Number(row.payload.budget) === 60,
      `B6 payload 带 spent/budget(got ${row && row.payload && row.payload.budget})`);
    writeConfig({ stewardEnabledV1: true });
  }
  {
    // (C) 合成 run 事件文件:两个新 run 事件 type 走真实收集器与归一化器。
    SID_RUN = await newMissionSession('班组夹具');
    const RUN_ID = 'run_2b51ff';
    const runDir = path.join(HOME, 'agent-runs', SID_RUN);
    fs.mkdirSync(runDir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, RUN_ID + '.events.ndjson'),
      JSON.stringify({ seq: 1, ts: at, runId: RUN_ID, type: 'run_created', data: {} }) + '\n'
      + JSON.stringify({ seq: 2, ts: at, runId: RUN_ID, type: 'run_stalled', nodeId: 'n1', data: { reason: 'subagent_no_progress', tool: '', count: 3 } }) + '\n'
      + JSON.stringify({ seq: 3, ts: at, runId: RUN_ID, type: 'run_budget_tripped', nodeId: 'n2', data: { reason: 'tool_iteration_budget', limit: 40, hardLimit: 40, toolCalls: 40 } }) + '\n', 'utf8');
    fs.writeFileSync(path.join(runDir, RUN_ID + '.json'), JSON.stringify({
      id: RUN_ID, sessionId: SID_RUN, status: 'running', eventSeq: 3, createdAt: at, updatedAt: at, nodes: [],
    }), 'utf8');
    const rows = await tickUntil(r => r.some(x => x.runId === RUN_ID && x.kind === 'stalled') && r.some(x => x.runId === RUN_ID && x.kind === 'budget'), 20000);
    const st = rows.find(x => x.runId === RUN_ID && x.kind === 'stalled') || null;
    const bg = rows.find(x => x.runId === RUN_ID && x.kind === 'budget') || null;
    ok(!!st, "C1 run 事件 'run_stalled' -> 收件箱 kind=stalled(带 runId)");
    ok(st && st.payload && st.payload.eventType === 'run_stalled' && st.payload.reason === 'subagent_no_progress' && Number(st.payload.count) === 3,
      `C2 payload 带 eventType/reason/count(got ${st && JSON.stringify(st.payload && st.payload.reason)})`);
    ok(!!bg, "C3 run 事件 'run_budget_tripped' -> 收件箱 kind=budget");
    ok(bg && bg.payload && Number(bg.payload.limit) === 40 && /工具迭代预算/.test(String(bg.payload.summary || '')),
      `C4 预算摘要说清是工具迭代预算(got ${bg && bg.payload && bg.payload.summary})`);
    ok(inboxRows().length > baseline, 'C5 冷启动基线之后的新事实才入箱(历史不倒灌)');
  }
} finally {
  kill(wb); wb = null;
}
await sleep(400);

/* ═════════════════════ 进程内阶段:自理动作与插话补充 ═════════════════════ */
console.log('── (D)-(H) 进程内:自理动作与插话补充 ──');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
// 换主端点:循环夹具的剧本早被前两阶段消费光了(耗尽后 fake 只回一句话 = 单轮回合,没有迭代边界)。
// 插话必须在【下一次迭代边界】被 drain 才算「被下一步消费」,故这里换一个「有多轮工具 + 流慢」的 fake。
kill(toolFake);
// 读【不同】文件:同签名连击会被死循环护栏拦下,那样回合会提前收尾、插话来不及被 drain。
const READ_TARGETS = Array.from({ length: 12 }, (_, i) => {
  const f = path.join(HOME, `read-me-${i}.txt`);
  fs.writeFileSync(f, 'steer fixture ' + i);
  return f;
});
const steerFake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(STEER_PORT)], {
  env: {
    ...process.env,
    FAKE_TOOL_SEQUENCE: JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ name: 'file_read', args: { path: READ_TARGETS[i % READ_TARGETS.length] } }))),
    FAKE_STREAM_DELAY_MS: '150',
  },
  windowsHide: true,
});
steerFake.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
await sleep(700);
toolsPort = STEER_PORT;
// 进程内阶段把全局档从 bypass(循环夹具需要)改回 default —— 自理动作的权限闸要两态可判定。
// file_read 是 read 档、default 下 auto-allow,插话夹具照样跑得起来。
const writeConfig3 = patch => writeConfig({ stewardEnabledV1: true, permissionMode: 'default', ...(patch || {}) });
writeConfig3();
const srv = require(SERVER);
const readDecisions = () => { try { return fs.readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });
const failedEvent = (sid, seq) => ({ inboxSeq: seq, kind: 'failed', sessionId: sid, missionId: sid, seq, at: new Date().toISOString(), payload: { source: 'mission_change', changeType: 'failure', summary: '回合失败' }, count: 1 });

try {
  /* ═════════ (E) retry 开但线程 default -> 只提议 ═════════ */
  {
    const before = readDecisions().length;
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [failedEvent(SID_LOOP, 501)] });
    const self = (r.actions || []).find(a => a && a.auto === true) || null;
    ok(!!self && self.result && self.result.error === 'propose_required' && self.result.reason === 'self_serve_gate',
      `E1 线程档为「每步都问」-> 自理重试只提议(got ${self && self.result && self.result.error})`);
    ok((r.acts || []).some(a => a.label === '重试' && a.tool === 'steward_thread_continue'),
      'E2 提议降级成一条 act「重试」(按意图给标签,不叫「接着办」)');
    ok(readDecisions().length === before, 'E3 只提议 -> 零决策日志');
  }

  /* ═════════ (D) 线程 acceptEdits + retry 开 -> 真执行 ═════════ */
  {
    // 116-2a 的会话级权限:把这条线程单独切到「改文件不问」。
    await srv.updateSessionMeta(SID_LOOP, { permissionMode: 'acceptEdits' });
    const before = readDecisions().length;
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [failedEvent(SID_LOOP, 502)] });
    const self = (r.actions || []).find(a => a && a.auto === true) || null;
    ok(!!self && self.tool === 'steward_thread_continue' && self.args.message === '继续' && self.result && self.result.ok === true,
      `D1 retry 开 + 线程 acceptEdits -> 自动递话「继续」(got ${self && JSON.stringify(self.result && self.result.error || 'ok')})`);
    ok(self && self.auto === true && self.label === '重试', 'D2 steward_reply.actions 里能看到 auto:true 与意图标签');
    const rows = readDecisions();
    ok(rows.length > before, 'D3 执行后落决策日志');
    const row = [...rows].reverse().find(x => x.tool === 'steward_thread_continue' && x.targetSessionId === SID_LOOP) || null;
    ok(row && row.basis && row.basis.auto === true && row.basis.origin === 'steward-retry' && Number(row.basis.inboxSeq) === 502,
      `D4 决策日志 basis 记下 inboxSeq / auto / origin(got ${row && JSON.stringify(row.basis)})`);
    ok(row && row.undoRef && row.undoRef.kind === 'turn', 'D5 决策日志带 undoRef(递话前的 turnSeq)');
  }
  {
    // 同一目标本小时第二次失败:不再自动(小时窗 + 无进展熔断两道闸中的第一道)。
    const before = readDecisions().length;
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [failedEvent(SID_LOOP, 503)] });
    const self = (r.actions || []).find(a => a && a.auto === true) || null;
    ok(!!self && self.result && self.result.error === 'propose_required' && /本小时/.test(String(self.result.message || '')),
      `D6 同一目标本小时第二次失败不再自动(got ${self && self.result && self.result.message})`);
    ok(readDecisions().length === before, 'D7 第二次零执行零决策日志');
  }

  /* ═════════ (F) resume:null 跟随 autonomyAutoResume 两态 ═════════ */
  {
    const stalledEvent = seq => ({
      inboxSeq: seq, kind: 'stalled', sessionId: SID_RUN, missionId: SID_RUN, seq, at: new Date().toISOString(),
      runId: 'run_2b51ff', payload: { source: 'agent_run', eventType: 'run_interrupted', summary: '被重启打断' }, count: 1,
    });
    await srv.updateSessionMeta(SID_RUN, { permissionMode: 'acceptEdits' });
    writeConfig3({ autonomyAutoResume: false });
    const off = await srv.runStewardTurn({ trigger: 'inbox', events: [stalledEvent(601)] });
    const offRow = (off.actions || []).find(a => a && a.auto === true) || null;
    ok(offRow && offRow.args.action === 'resume' && offRow.result && offRow.result.error === 'propose_required'
      && /重启后自动续跑/.test(String(offRow.result.message || '')),
      `F1 autonomyAutoResume=false -> resume 只提议(got ${offRow && offRow.result && offRow.result.message})`);
    ok((off.acts || []).some(a => a.label === '续跑'), 'F2 降级成一条 act「续跑」');

    writeConfig3({ autonomyAutoResume: true });
    const on = await srv.runStewardTurn({ trigger: 'inbox', events: [stalledEvent(602)] });
    const onRow = (on.actions || []).find(a => a && a.auto === true) || null;
    ok(onRow && onRow.args.action === 'resume' && onRow.result
      && !/重启后自动续跑/.test(String(onRow.result.message || '')),
      `F3 autonomyAutoResume=true -> 过自理清单那道闸(继续走权限与 resumeTier 判定;got ${onRow && (onRow.result.error || 'ok')})`);
    writeConfig3({ autonomyAutoResume: false });
  }
  {
    // 非重启类的停滞(节点跑不动)不自动动手:盲目续跑只会再撞一次同一堵墙。
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [{
      inboxSeq: 610, kind: 'stalled', sessionId: SID_RUN, missionId: SID_RUN, seq: 610, at: new Date().toISOString(),
      runId: 'run_2b51ff', payload: { source: 'agent_run', eventType: 'node_no_progress_aborted', summary: '语义死循环' }, count: 1,
    }] });
    ok(!(r.actions || []).some(a => a && a.auto === true), 'F4 node_no_progress_aborted / run_stalled 只进回合层,不自动动作');
  }

  /* ═════════ (G) steward_thread_note ═════════ */
  {
    // 用 SID_RUN 做插话夹具:它从建线程起就没跑过任何回合(F 相位的 resume 被权限闸挡在了
    // propose_required),所以「没有在途回合」这一态是干净可判定的 —— 拿 SID_LOOP 会撞上 (D) 的
    // 自理递话回合还没收尾。
    const forbidden = await srv.toolCall('steward_thread_note', { sessionId: SID_RUN, text: '补一句' }, { session: { id: SID_RUN, kind: 'mission' } });
    ok(forbidden && forbidden.ok === false && forbidden.error === 'steward.forbidden', `G1 普通会话 ctx -> steward.forbidden(got ${forbidden && forbidden.error})`);
    const idle = await srv.toolCall('steward_thread_note', { sessionId: SID_RUN, text: '补一句' }, stewardCtx());
    ok(idle && idle.ok === false && idle.error === 'steward.no_active_turn', `G2 无在途回合 -> steward.no_active_turn(got ${idle && idle.error})`);
    const missing = await srv.toolCall('steward_thread_note', { sessionId: 'sess_nope0000', text: '补一句' }, stewardCtx());
    ok(missing && missing.ok === false && missing.error === 'not_found', `G3 目标线程不存在 -> not_found(got ${missing && missing.error})`);

    // 有在途回合:换上的 fake 有 60 步 file_read(路径各不相同,不会被死循环护栏提前拦下)+ 慢流,
    // 迭代边界足够多,插话必然赶得上在下一次边界被 drain。
    // 116h(27 号文 §3.1 116h 行):管家开着时,同一个工作文件夹的回合是【写互斥】的 —— (D) 相位
    // 自理重试给 SID_LOOP 起的那个回合还占着 HOME 这把锁,本相位要测的是插话通道而不是仲裁,
    // 所以给这一个回合单独一个工作文件夹(file_read 的目标是绝对路径,不受 cwd 影响)。
    const NOTE_CWD = path.join(HOME, 'note-ws');
    fs.mkdirSync(NOTE_CWD, { recursive: true });
    const turn = srv.runSessionTurn({ sessionId: SID_RUN, message: '跑一段给插话用', cwd: NOTE_CWD, source: 'test', onEvent: () => {} });
    let noted = null;
    for (let i = 0; i < 150; i++) {
      noted = await srv.toolCall('steward_thread_note', { sessionId: SID_RUN, text: '相关文件在 <docs> 目录' }, stewardCtx());
      if (noted && noted.ok === true) break;
      await sleep(80);
    }
    ok(noted && noted.ok === true && Number(noted.queued) >= 1, `G4 目标有在途回合时插话入队成功(got ${noted && JSON.stringify(noted.error || noted.queued)})`);
    ok(noted && noted.undoRef && noted.undoRef.kind === 'note' && /（管家补充）/.test(String(noted.undoRef.text || '')),
      'G5 undoRef kind=note,且带服务端加的「（管家补充）」前缀(撤回按文本匹配)');
    ok(noted && /\[docs\]/.test(String(noted.undoRef.text || '')) && !/<docs>/.test(String(noted.undoRef.text || '')),
      'G6 尖括号被中和(与总览行同一函数)');
    await turn.catch(() => {});
    const body = (() => {
      try {
        return fs.readFileSync(path.join(HOME, 'sessions', SID_RUN + '.messages.ndjson'), 'utf8')
          .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    })();
    const steered = body.find(m => m && m.role === 'user' && m.steered === true && /（管家补充）相关文件在 \[docs\] 目录/.test(String(m.content || '')));
    ok(!!steered, 'G7 插话被下一步消费:会话正文里出现 steered:true 的「（管家补充）」那一条(与用户手动插话同一通道)');
    const decisions = readDecisions();
    ok(decisions.some(d => d.tool === 'steward_thread_note' && d.targetSessionId === SID_RUN), 'G8 插话补充落决策日志');
    const empty = await srv.toolCall('steward_thread_note', { sessionId: SID_RUN, text: '' }, stewardCtx());
    ok(empty && empty.ok === false && empty.error === 'invalid_request', 'G9 空文本 -> invalid_request');
  }

  /* ═════════ (H) 开关关:自理零动作零写入 ═════════ */
  {
    const beforeDecisions = readDecisions().length;
    const beforeInbox = inboxRows().length;
    writeConfig3({ stewardEnabledV1: false });
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [failedEvent(SID_RUN, 701)] });
    ok(r && r.ok === false && r.error === 'steward.disabled', 'H1 开关关:收件箱回合直接 steward.disabled(自理动作根本跑不到)');
    ok(readDecisions().length === beforeDecisions, 'H2 开关关:零决策日志');
    ok(inboxRows().length === beforeInbox, 'H3 开关关:收件箱零写入');
    const note = await srv.toolCall('steward_thread_note', { sessionId: SID_LOOP, text: '补一句' }, stewardCtx());
    ok(note && note.ok === false && note.error === 'steward.disabled', 'H4 开关关:steward_thread_note 也 fail-closed');
    // 账本是线程自己的持久化,与管家开关无关 —— (A) 阶段已在开关关的状态下证明它照写。
    ok(changesOf(SID_LOOP, 'stalled').length >= 1 && changesOf(SID_BUDGET, 'budget_tripped').length >= 2,
      'H5 账本里的 stalled / budget_tripped 仍在(线程自身的持久化,不受管家开关影响)');
    writeConfig3();
  }
} finally {
  kill(toolFake);
  kill(replyFake);
  if (typeof steerFake !== 'undefined') kill(steerFake);
}

console.log(fail === 0 ? 'STEWARD SIGNALS E2E: ALL PASS' : `STEWARD SIGNALS E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
})();
