require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// E2E(第123波 M1 §3.2):定时任务调度器 —— tick、四段触发、并发 1、熔断、上限、两类载荷、无人值守 ask。
//
// 用户触发:「每个工作日 18:00 生成周报草稿」「明天九点提醒我」。到点这件事一年只发生几百次,
// 靠真等是等不到的 —— 所以本件全程走 §3.4 的**假时钟**(WCW_SCHEDULER_CLOCK_FILE:文件里写一个
// epoch ms,调度器每 tick 读它当「现在」),把一天、一个月、一次连败三次压进几秒钟。
//
// 判据(§3.2 逐条):
//   A 零开销   —— schedulerEnabledV1:false 时 startScheduler 立即返回且【一个字节都不写】
//                 (<data>/scheduler/ 目录都不建);开着但零任务时不起 interval。**进程内直测**
//                 (require server.js 调 startScheduler/schedulerRuntimeSnapshot)——「有没有起
//                 setInterval」不是 HTTP 面上的事实,只能这么量。
//   B once     —— 到点触发一次【且只一次】;fires 里同 occurrenceKey 的 registered 只有一条;
//                 触发后 nextRunAt 变空(once 没有下一次);再拨时钟不再触发。
//   C daily    —— 连推两天 -> 两次;第二次的 dueAt 比第一次晚 24 小时(本地墙钟同一时刻)。
//   D cron     —— `*/1 * * * *` 每分钟一次。
//   E 并发 1   —— 两条任务同一刻到点:第二条的 registered.seq > 第一条的 reconciled.seq(串行)。
//   F 熔断     —— 连败 3 次 -> enabled 变 false,fires 最后一行带 tripped。
//   G 上限     —— maxRunsPerDay:1 的 cron,第二次到点记 skipped/task_daily_cap,不起回合。
//   H reminder —— 不调模型:会话数不变、用量台账为空、fires 里 outcome succeeded。
//   I prompt   —— 起一个真回合(fake provider),outcome succeeded、fires 带 sessionId、
//                 会话头 origin:'schedule'(02:2819 早为本波留的第三值)且 launchedBy:'steward'
//                 (13i 第四源按它收 done/failed)。
//   J ask      —— 无人值守遇 ask 【不放行】:等 WCW_SCHEDULER_ASK_WAIT_MS 后拒,本次 needs_you,
//                 任务 state.lastResult 也是 needs_you。**这是 29 号文 §10 红线二的锁。**
//
// fake 引擎:本件自带一个进程内的 OpenAI 兼容小服务(同 mission-start-race.e2e.js 的做法),
// 按【用户消息里的暗号】分叉 —— PLAIN 直接回一句、BOOM 回 HTTP 500(造失败)、TOOLCALL 发起一次
// file_write(edit 档 -> 在 default 权限下 gate 判 ask,正是 J 组要的)。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-scheduler-e2e');
const WORK = path.join(HOME, 'workspace');
const CLOCK = path.join(HOME, 'clock.txt');
const TICK_MS = 150;
const ASK_WAIT_MS = 900;
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(child) { if (child && child.pid) { try { killOwnTree(child); } catch { /* already gone */ } } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function setClock(ms) { fs.writeFileSync(CLOCK, String(Math.round(ms)), 'utf8'); }
function firesRows() {
  const file = path.join(HOME, 'scheduler', 'fires-v1.ndjson');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* torn tail */ }
  }
  return rows;
}
function usageRows() {
  const dir = path.join(HOME, 'usage');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const f of files) {
    for (const line of String(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n')) {
      if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { /* skip */ } }
    }
  }
  return rows;
}

function request(port, method, pathname, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
      ...(extraHeaders || {}),
    } }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 300; i++) { const r = await request(port, 'GET', '/health', null, '').catch(() => null); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}
async function waitToken() {
  for (let i = 0; i < 300; i++) { const t = readToken(); if (t) return t; await sleep(100); }
  return readToken();
}
// 等 fires 里出现满足 predicate 的行(墙钟预算 20 s;tick 是 150 ms,足够跑 130 拍)。
async function waitFires(predicate, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const rows = firesRows();
    if (predicate(rows)) return rows;
    await sleep(80);
  }
  return firesRows();
}
const reconciledOf = (rows, taskId) => rows.filter(r => r.taskId === taskId && r.phase === 'reconciled');
const registeredOf = (rows, taskId) => rows.filter(r => r.taskId === taskId && r.phase === 'registered');

// ── fake OpenAI 兼容引擎(按用户消息里的暗号分叉)────────────────────────────────────────────
function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if ((req.url || '').includes('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const messages = (body && Array.isArray(body.messages)) ? body.messages : [];
    const userText = messages.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join(' ');
    const toolDone = messages.some(m => m && m.role === 'tool');
    if (userText.includes('BOOM')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const id = 'chatcmpl-sched';
    res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n');
    if (userText.includes('TOOLCALL') && !toolDone) {
      res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_write', arguments: '' } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: path.join(WORK, 'scheduled.txt'), content: 'x' }) } }] }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: { content: '定时任务跑完了' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

(async () => {
  /* ═════════ A 零开销(进程内直测:setInterval 起没起,HTTP 面上看不见)═════════ */
  {
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wcw-sched-probe-'));
    process.env.WIN_CLAUDE_WORKBENCH_HOME = probeHome;
    process.env.RUYI_HOME = probeHome;
    const srv = require(path.join(WB, 'app', 'server.js'));
    const { startScheduler, stopScheduler, schedulerRuntimeSnapshot } = srv;
    const startedOff = await startScheduler({ schedulerEnabledV1: false });
    ok(startedOff === false, 'A1 schedulerEnabledV1:false -> startScheduler 立即返回 false');
    ok(schedulerRuntimeSnapshot().timerActive === false && schedulerRuntimeSnapshot().enabled === false,
      'A2 关着时既没有 interval 也没有 enabled 标');
    ok(!fs.existsSync(path.join(probeHome, 'scheduler')),
      'A3 关着时 <data>/scheduler/ 目录都不建(29 号文 §10:零后台开销、零持久化写入)');
    stopScheduler();
    const startedOn = await startScheduler({ schedulerEnabledV1: true });
    const snap = schedulerRuntimeSnapshot();
    ok(startedOn === true && snap.enabled === true, 'A4 开着时 startScheduler 返回 true');
    ok(snap.taskCount === 0 && snap.timerActive === false,
      `A5 开着但【零任务】时不起 interval(实测 taskCount=${snap.taskCount} timerActive=${snap.timerActive})`);
    await sleep(60);
    ok(!fs.existsSync(path.join(probeHome, 'scheduler')), 'A6 零任务时仍然一个字节都不写');
    // §3.4 的静态锁:四个测试旗只是【缝】,不带旗时读不到 —— 生产零影响。
    // 判据两半:① 旗名在整个 src/ 里只出现在 13s 的四个 process.env 读取点(没有第二个消费者、
    // 没有人把它写进 config 或 UI);② 本进程【没有】设过任何一个旗,而 tickMs 读到的是生产默认
    // 30 s、崩溃钩子一次都没触发(上面那两次 startScheduler 都活着回来了)。
    {
      const FLAGS = ['WCW_SCHEDULER_CLOCK_FILE', 'WCW_SCHEDULER_TICK_MS', 'WCW_SCHEDULER_ASK_WAIT_MS', 'WCW_SCHEDULER_CRASH_AT'];
      const srcDir = path.join(WB, 'app', 'src');
      const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
      for (const flag of FLAGS) {
        const hits = [];
        for (const f of files) {
          const body = fs.readFileSync(path.join(srcDir, f), 'utf8');
          const reads = (body.match(new RegExp('process\\.env\\.' + flag + '\\b', 'g')) || []).length;
          if (reads) hits.push(f + ' x' + reads);
        }
        ok(hits.length === 1 && hits[0] === '13s-scheduler.js x1',
          `A7[${flag}] 整个 src/ 里只有 13s 的一处 process.env 读取点(实测 ${JSON.stringify(hits)})`);
      }
      for (const flag of FLAGS) {
        ok(process.env[flag] === undefined, `A8[${flag}] 本进程没设这个旗 —— 下面那条断言才算数`);
      }
      ok(schedulerRuntimeSnapshot().tickMs === 30000,
        `A9 不带旗时 tick 是生产默认 30 s(实测 ${schedulerRuntimeSnapshot().tickMs})`);
    }
    stopScheduler();
    try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  /* ═════════ 起真服务 ═════════ */
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const WB_PORT = await getFreePort();
  const PROVIDER_PORT = await getFreePort();
  // 基准时刻取一个【固定的工作日中午】,不用真实当下 —— 判据里要算「明天同一时刻」,
  // 用真实当下会在夏令时/月末那几天变成薛定谔的断言。
  let clock = new Date(2026, 4, 4, 12, 0, 0, 0).getTime();   // 2026-05-04 周一 12:00 本地
  setClock(clock);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass',
    includeWorkbenchMcp: false, defaultWorkspace: WORK,
    stewardEnabledV1: false,           // 管家收件箱轮询与本件无关,关掉省噪音
    stewardThreadBriefV1: false,       // 自动摘要会额外打一次 provider,与用量断言互相干扰
    schedulerEnabledV1: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');

  const provider = await startProvider(PROVIDER_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB,
    env: {
      ...process.env,
      RUYI_HOME: HOME, HOME, USERPROFILE: HOME,
      WCW_SCHEDULER_CLOCK_FILE: CLOCK,
      WCW_SCHEDULER_TICK_MS: String(TICK_MS),
      WCW_SCHEDULER_ASK_WAIT_MS: String(ASK_WAIT_MS),
    },
    windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    ok(await waitHealth(WB_PORT), 'workbench up');
    const token = await waitToken();
    ok(!!token, 'runtime token available');
    const create = (body) => request(WB_PORT, 'POST', '/api/scheduler/tasks', body, token);
    const listTasks = async () => (await request(WB_PORT, 'GET', '/api/scheduler/tasks', null, token)).json;

    /* ═════════ B once 触发一次且只一次 ═════════ */
    const onceAt = new Date(clock + 5 * MINUTE);
    const onceBody = {
      title: '一次性提醒',
      schedule: { kind: 'once', date: `${onceAt.getFullYear()}-${String(onceAt.getMonth() + 1).padStart(2, '0')}-${String(onceAt.getDate()).padStart(2, '0')}`, at: `${String(onceAt.getHours()).padStart(2, '0')}:${String(onceAt.getMinutes()).padStart(2, '0')}` },
      payload: { kind: 'reminder', text: '该交周报了' },
    };
    const onceRes = await create(onceBody);
    ok(onceRes.status === 200 && onceRes.json && onceRes.json.ok, 'B1 建一条 once reminder');
    const onceId = onceRes.json.task.id;
    const sessionsBefore = (await request(WB_PORT, 'GET', '/api/sessions', null, token)).json;
    const sessionCountBefore = (sessionsBefore && Array.isArray(sessionsBefore.sessions)) ? sessionsBefore.sessions.length : -1;
    clock += 6 * MINUTE; setClock(clock);
    let rows = await waitFires(r => reconciledOf(r, onceId).length >= 1);
    ok(registeredOf(rows, onceId).length === 1,
      `B2 到点【只】触发一次(registered 恰 1 条;实测 ${registeredOf(rows, onceId).length})`);
    const onceRun = reconciledOf(rows, onceId)[0];
    ok(!!onceRun && onceRun.outcome === 'succeeded' && onceRun.mode === 'ontime',
      `B3 结果 succeeded、触发模式 ontime(实测 ${onceRun && onceRun.outcome}/${onceRun && onceRun.mode})`);
    ok(!!onceRun && /@/.test(String(onceRun.occurrenceKey)) && onceRun.occurrenceKey.startsWith(onceId + '@'),
      'B4 occurrenceKey = taskId@dueIso');
    {
      const list = await listTasks();
      const task = list.tasks.find(t => t.id === onceId);
      ok(!!task && task.nextRunAt === '', 'B5 once 跑过之后 nextRunAt 变空(它没有下一次)');
    }
    clock += 3 * DAY; setClock(clock);
    await sleep(TICK_MS * 6);
    ok(registeredOf(firesRows(), onceId).length === 1, 'B6 再拨三天也不会第二次触发(过期的 once 不复活)');

    /* ═════════ H reminder 不起回合 ═════════ */
    const sessionsAfter = (await request(WB_PORT, 'GET', '/api/sessions', null, token)).json;
    const sessionCountAfter = (sessionsAfter && Array.isArray(sessionsAfter.sessions)) ? sessionsAfter.sessions.length : -2;
    ok(sessionCountBefore >= 0 && sessionCountAfter === sessionCountBefore,
      `H1 reminder 载荷【不开会话】(前 ${sessionCountBefore} 后 ${sessionCountAfter})`);
    ok(usageRows().length === 0, `H2 reminder 载荷零用量台账(实测 ${usageRows().length} 行)`);
    ok(!onceRun.sessionId, 'H3 reminder 的 fires 行不带 sessionId');

    /* ═════════ C daily 连推两天两次 ═════════ */
    const dailyRes = await create({
      title: '每天九点', schedule: { kind: 'daily', at: '09:00' },
      payload: { kind: 'reminder', text: '起床' },
    });
    ok(dailyRes.status === 200, 'C1 建一条 daily');
    const dailyId = dailyRes.json.task.id;
    const dailyFirstDue = Date.parse(dailyRes.json.task.nextRunAt);
    clock = dailyFirstDue + MINUTE; setClock(clock);
    await waitFires(r => reconciledOf(r, dailyId).length >= 1);
    clock = dailyFirstDue + DAY + MINUTE; setClock(clock);
    rows = await waitFires(r => reconciledOf(r, dailyId).length >= 2);
    const dailyRuns = reconciledOf(rows, dailyId);
    ok(dailyRuns.length === 2, `C2 连推两天 -> 恰两次(实测 ${dailyRuns.length})`);
    ok(dailyRuns.length === 2 && Date.parse(dailyRuns[1].dueAt) - Date.parse(dailyRuns[0].dueAt) === DAY,
      'C3 两次的 dueAt 正好差 24 小时(本地墙钟同一时刻)');

    /* ═════════ D cron 每分钟 ═════════ */
    const cronRes = await create({
      title: '每分钟', schedule: { kind: 'cron', expr: '*/1 * * * *' },
      payload: { kind: 'reminder', text: 'tick' },
    });
    ok(cronRes.status === 200, 'D1 建一条 */1 cron');
    const cronId = cronRes.json.task.id;
    for (let i = 0; i < 3; i++) {
      clock += MINUTE + 1000; setClock(clock);
      await waitFires(r => reconciledOf(r, cronId).length >= i + 1);
    }
    ok(reconciledOf(firesRows(), cronId).length === 3,
      `D2 拨过三分钟 -> 三次(实测 ${reconciledOf(firesRows(), cronId).length})`);
    await request(WB_PORT, 'DELETE', '/api/scheduler/tasks/' + cronId, null, token);

    /* ═════════ E 并发 1(两条同刻到点串行)═════════ */
    const eA = (await create({ title: '同刻甲', schedule: { kind: 'cron', expr: '*/5 * * * *' }, payload: { kind: 'reminder', text: 'a' } })).json.task;
    const eB = (await create({ title: '同刻乙', schedule: { kind: 'cron', expr: '*/5 * * * *' }, payload: { kind: 'reminder', text: 'b' } })).json.task;
    ok(eA.nextRunAt === eB.nextRunAt, 'E1 两条任务的下次触发时刻逐字相同(同刻到点)');
    clock = Date.parse(eA.nextRunAt) + 1000; setClock(clock);
    rows = await waitFires(r => reconciledOf(r, eA.id).length >= 1 && reconciledOf(r, eB.id).length >= 1);
    const seqOf = (taskId, phase) => (rows.filter(r => r.taskId === taskId && r.phase === phase)[0] || {}).seq;
    const firstDone = Math.min(seqOf(eA.id, 'reconciled'), seqOf(eB.id, 'reconciled'));
    const secondStart = Math.max(seqOf(eA.id, 'registered'), seqOf(eB.id, 'registered'));
    ok(Number.isFinite(firstDone) && Number.isFinite(secondStart) && secondStart > firstDone,
      `E2 全局并发 1:后一条 registered(seq ${secondStart})排在前一条 reconciled(seq ${firstDone})之后`);
    for (const t of [eA, eB]) await request(WB_PORT, 'DELETE', '/api/scheduler/tasks/' + t.id, null, token);

    /* ═════════ I prompt 起真回合 ═════════ */
    const promptRes = await create({
      title: '周报草稿', schedule: { kind: 'cron', expr: '*/5 * * * *' },
      payload: { kind: 'prompt', text: 'PLAIN 生成周报草稿' },
    });
    ok(promptRes.status === 200, 'I1 建一条 prompt 任务');
    const promptId = promptRes.json.task.id;
    clock = Date.parse(promptRes.json.task.nextRunAt) + 1000; setClock(clock);
    rows = await waitFires(r => reconciledOf(r, promptId).length >= 1, 30000);
    const promptRun = reconciledOf(rows, promptId)[0];
    ok(!!promptRun && promptRun.outcome === 'succeeded',
      `I2 prompt 载荷跑完 outcome=succeeded(实测 ${promptRun && promptRun.outcome} / ${promptRun && promptRun.error})`);
    ok(!!promptRun && !!promptRun.sessionId, 'I3 fires 行带 sessionId(产出线程直达)');
    const head = (await request(WB_PORT, 'GET', '/api/sessions/' + promptRun.sessionId, null, token)).json;
    const session = head && (head.session || head);
    ok(!!session && session.origin === 'schedule',
      `I4 产出线程的 origin 是 'schedule'(02:2819 为本波留的第三值;实测 ${session && session.origin})`);
    ok(!!session && session.launchedBy === 'steward',
      'I5 launchedBy 仍是 steward —— 13i 第四源按它收 done/failed,这条路不能断');
    ok(usageRows().length > 0, 'I6 prompt 载荷【有】用量台账(与 H2 的 reminder 零用量成对)');
    await request(WB_PORT, 'DELETE', '/api/scheduler/tasks/' + promptId, null, token);

    /* ═════════ J 无人值守 ask -> 到时拒 -> needs_you(29 号文 §10 红线二)═════════ */
    const askRes = await create({
      title: '要动文件的任务', schedule: { kind: 'cron', expr: '*/5 * * * *' },
      payload: { kind: 'prompt', text: 'TOOLCALL 帮我写个文件' },
      autonomy: { permissionMode: 'default' },   // default 档下 edit 档工具 gate 判 ask
    });
    ok(askRes.status === 200, 'J1 建一条会撞权限的 prompt 任务');
    const askId = askRes.json.task.id;
    clock = Date.parse(askRes.json.task.nextRunAt) + 1000; setClock(clock);
    rows = await waitFires(r => reconciledOf(r, askId).length >= 1, 40000);
    const askRun = reconciledOf(rows, askId)[0];
    ok(!!askRun && askRun.outcome === 'needs_you',
      `J2 无人值守遇 ask:等满 ${ASK_WAIT_MS} ms 后【拒】,本次记 needs_you(实测 ${askRun && askRun.outcome} / ${askRun && askRun.error})`);
    ok(!fs.existsSync(path.join(WORK, 'scheduled.txt')),
      'J3 【子集律】那个文件一个字节都没被写出来 —— 到时是拒,永不放行');
    {
      const list = await listTasks();
      const task = list.tasks.find(t => t.id === askId);
      ok(!!task && task.state.lastResult === 'needs_you', 'J4 任务 state.lastResult 也是 needs_you(用户回来「立即运行」重跑)');
    }
    await request(WB_PORT, 'DELETE', '/api/scheduler/tasks/' + askId, null, token);

    /* ═════════ G 上限:单任务 maxRunsPerDay ═════════ */
    const capRes = await create({
      title: '一天只跑一次', schedule: { kind: 'cron', expr: '*/1 * * * *' },
      payload: { kind: 'reminder', text: 'cap' },
      policy: { maxRunsPerDay: 1 },
    });
    ok(capRes.status === 200 && capRes.json.task.policy.maxRunsPerDay === 1, 'G1 建一条 maxRunsPerDay:1 的每分钟任务');
    const capId = capRes.json.task.id;
    clock += MINUTE + 1000; setClock(clock);
    await waitFires(r => reconciledOf(r, capId).length >= 1);
    clock += MINUTE + 1000; setClock(clock);
    rows = await waitFires(r => reconciledOf(r, capId).length >= 2);
    const capRuns = reconciledOf(rows, capId);
    ok(capRuns.length >= 2 && capRuns[0].outcome === 'succeeded' && capRuns[1].outcome === 'skipped'
      && capRuns[1].error === 'task_daily_cap',
      `G2 第二次撞单任务日上限 -> skipped/task_daily_cap(实测 ${capRuns.map(r => r.outcome + '/' + (r.error || '')).join(' ')})`);
    ok(registeredOf(rows, capId).length === 1, 'G3 撞上限那一次【没有】 registered 行 —— 它压根没起来');
    await request(WB_PORT, 'DELETE', '/api/scheduler/tasks/' + capId, null, token);

    /* ═════════ F 连败 3 次熔断 ═════════ */
    const boomRes = await create({
      title: '一直失败', schedule: { kind: 'cron', expr: '*/1 * * * *' },
      payload: { kind: 'prompt', text: 'BOOM 让端点炸' },
    });
    ok(boomRes.status === 200, 'F1 建一条注定失败的 prompt 任务');
    const boomId = boomRes.json.task.id;
    for (let i = 0; i < 3; i++) {
      clock += MINUTE + 1000; setClock(clock);
      await waitFires(r => reconciledOf(r, boomId).length >= i + 1, 30000);
    }
    rows = firesRows();
    const boomRuns = reconciledOf(rows, boomId);
    ok(boomRuns.length === 3 && boomRuns.every(r => r.outcome === 'failed'),
      `F2 连着三次 failed(实测 ${boomRuns.map(r => r.outcome).join(',')})`);
    ok(boomRuns.length === 3 && boomRuns[2].tripped === true, 'F3 第三次那行带 tripped(熔断)');
    {
      const list = await listTasks();
      const task = list.tasks.find(t => t.id === boomId);
      ok(!!task && task.enabled === false && task.state.consecutiveFailures === 3,
        `F4 熔断把任务关掉(enabled=${task && task.enabled} consecutiveFailures=${task && task.state.consecutiveFailures})`);
    }
    clock += 5 * MINUTE; setClock(clock);
    await sleep(TICK_MS * 6);
    ok(reconciledOf(firesRows(), boomId).length === 3, 'F5 熔断之后再拨时钟也不再触发(熔断优先于重试)');
  } finally {
    kill(wb);
    try { provider.close(); } catch { /* ignore */ }
  }

  console.log(fail ? ('FAIL total ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
