require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// E2E(第123波 M1 §3.2「启动恢复」):进程崩在四段边界上,重启之后会怎样。
//
// 用户触发:定时任务跑到一半机器蓝屏 / 用户直接关掉工作台 / 杀软把进程干掉。
// 病根形状(29 号文 §4「幂等」与 §10 红线):重启时看见一条任务挂着 inFlightRunId,只有两种错法 ——
//   ① 当它成功了 -> 用户以为周报生成了,其实没有;
//   ② 当它没跑过、原样重发 -> 上一次可能已经真的动过文件/发过东西了,重放不可撤销。
// 正解(J11):记 **unknown**「结果未知,先核对」,把那一个 occurrence 消费掉,nextFireAt 推过它。
//
// 判据(§3.2 逐条):
//   K 四段    —— WCW_SCHEDULER_CRASH_AT ∈ {after-register, after-dispatch, mid-run, before-reconcile}
//               让服务在该点 process.exit(3);每一段重启后:
//                 · 同 occurrenceKey 的 registered 【只有一条】(不重复触发);
//                 · 补出来的终态是 outcome:'unknown' + error:'interrupted'(不判成功);
//                 · nextFireAt 已推过那个时点(J11「不盲目重发」);
//                 · 再跑几拍也不冒出第二条 registered。
//   J10a 补跑 —— 服务【干净地】停掉,假时钟拨过一个 due(仍在 grace 内)再启:一条 mode:'late' 的补跑,
//               而且【只补一次】。
//   J10b 跳过 —— 同上但拨过 graceMinutes:一条 outcome:'skipped' + error:'grace_expired',不补跑。
//
// 载荷一律用 reminder:四个崩溃点在 reminder 分支上全都可达(见 13s schedulerFireOnce),
// 于是本件不需要任何模型端点 —— 崩溃时序本身就够难量了,不该再叠一个 provider 的不确定性。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-scheduler-crash-e2e');
const WORK = path.join(HOME, 'workspace');
const CLOCK = path.join(HOME, 'clock.txt');
const TICK_MS = 120;
const MINUTE = 60000;
const HOUR = 3600000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(child) { if (child && child.pid) { try { killOwnTree(child); } catch { /* already gone */ } } }
function readRuntime() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')); } catch { return null; } }
function setClock(ms) { fs.writeFileSync(CLOCK, String(Math.round(ms)), 'utf8'); }
function firesRows() {
  let text = '';
  try { text = fs.readFileSync(path.join(HOME, 'scheduler', 'fires-v1.ndjson'), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) { const t = line.trim(); if (!t) continue; try { rows.push(JSON.parse(t)); } catch { /* torn tail */ } }
  return rows;
}
function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
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
// **本件一趟里要起 12 次服务,而它们共用同一个数据根** —— runtime.json 里【始终】躺着一个 token
// (上一个进程留下的),所以「等到文件里有 token」这条经典写法在这里是假的:它第一次就返回旧值,
// 拿旧 token 打新服务 = 403,再 .json.tasks 就是 undefined(2026-09-13 实测 1/4 概率红,报的是
// 一条 TypeError,与调度器无关)。30 号文 §8.14 早把「重启点补抓 token 未比对身份」登记成债 ——
// 这里按 pid 精确等到【这一个】子进程自己写下的那一份。
async function waitToken(child) {
  for (let i = 0; i < 300; i++) {
    const runtime = readRuntime();
    if (runtime && runtime.token && Number(runtime.pid) === Number(child.pid)) return runtime.token;
    await sleep(100);
  }
  return '';
}
async function waitFires(predicate, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { const rows = firesRows(); if (predicate(rows)) return rows; await sleep(80); }
  return firesRows();
}

// 唯一的 spawn 点(fixture-home.static 数的就是它这一处;crashAt 为空 = 干净启动)。
// env 【必须写在 spawn 的实参里】而不是先拼一个局部变量再传进去:fixture-home.static 的扫描器
// 认的是「spawn 调用的实参文本里出现 RUYI_HOME」,拼在外面它就看不见这一处,那条「每一处都
// spread process.env」的隔离锁也就漏掉了本件(122-L2 之后每件新夹具都按这个形状写)。
function spawnWb(port, crashAt) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB,
    env: {
      ...process.env,
      RUYI_HOME: HOME, HOME, USERPROFILE: HOME,
      WCW_SCHEDULER_CLOCK_FILE: CLOCK,
      WCW_SCHEDULER_TICK_MS: String(TICK_MS),
      ...(crashAt ? { WCW_SCHEDULER_CRASH_AT: crashAt } : {}),
    },
    windowsHide: true,
  });
  child.exitInfo = { code: null, done: false };
  child.on('exit', code => { child.exitInfo.code = code; child.exitInfo.done = true; });
  child.stderr.on('data', d => { const s = String(d).trim(); if (s && !/scheduler_test_crash/.test(s)) console.error('[wb!] ' + s); });
  return child;
}
async function waitExit(child, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (child.exitInfo.done) return child.exitInfo.code; await sleep(60); }
  return null;
}

const reconciledOf = (rows, taskId) => rows.filter(r => r.taskId === taskId && r.phase === 'reconciled');
const registeredOf = (rows, taskId) => rows.filter(r => r.taskId === taskId && r.phase === 'registered');
// 每天 09:00 的 reminder —— 四段与 J10 共用同一种任务形状(daily 才有「下一次」可以往前推)。
const DAILY_BODY = title => ({ title, schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: '到点了' } });

// Small cold-process workers isolate the two persistence boundaries that occur between normal ticks.
async function recoveryWorker() {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const command = JSON.parse(input);
  const S = require('./lib/server-internals').loadServerInternals(['schedulerLoad', 'schedulerRecover', 'schedulerTick',
    'schedulerFireOnce', 'schedulerRuntime', 'schedulerReadFireRows'], { withEval: true });
  const rows = await S.schedulerLoad();
  if (command.op === 'edit-settle') {
    S.__eval(`schedulerAppendFire = ((append) => async row => {
      if (row.phase === 'dispatched') throw Object.assign(new Error('synthetic dispatch failure'), { code: 'EIO' });
      if (row.phase === 'reconciled') {
        const task = schedulerRuntime.tasks[0];
        task.schedule = { kind: 'daily', at: '21:00' };
        task.state.nextFireAt = new Date(nextFireAt(task.schedule, schedulerClockNow())).toISOString();
        task.state.enabled = true;
        task.state.consecutiveFailures = 0;
        await schedulerSaveTasks();
      }
      return append(row);
    })(schedulerAppendFire);`);
    await S.schedulerFireOnce(S.schedulerRuntime.tasks[0], 'ontime', command.dueMs);
    console.log(JSON.stringify({ task: S.schedulerRuntime.tasks[0], rows: await S.schedulerReadFireRows() }));
    return;
  }
  if (command.op === 'skip-crash' || command.op === 'skip-overlap') {
    S.__eval(`schedulerAppendFire = ((append) => async row => {
      ${command.op === 'skip-overlap' ? "if (row.phase === 'reconciled') { await schedulerSaveTasks(); process.exit(3); }" : ''}
      const result = await append(row);
      if (row.phase === 'reconciled') process.exit(3);
      return result;
    })(schedulerAppendFire);`);
    if (command.op === 'skip-overlap') await S.schedulerTick();
    else if (command.cap) await S.schedulerFireOnce(S.schedulerRuntime.tasks[0], 'late', command.dueMs);
    else await S.schedulerRecover(rows);
    throw new Error('skip persistence crash boundary was not reached');
  }
  if (['settle-crash', 'overlap-crash'].includes(command.op)) {
    // Exit immediately after the first terminal persistence action, whichever store is written first.
    S.__eval(`atomicWriteJson = ((write) => async (file, value, options) => {
      const result = await write(file, value, options);
      if (file === schedulerTasksPath() && value.tasks.some(task => !task.state.inFlightRunId)) process.exit(3);
      return result;
    })(atomicWriteJson);
    schedulerAppendFire = ((append) => async row => {
      ${command.fail ? 'if (row.phase === "dispatched") throw Object.assign(new Error("synthetic dispatch failure"), {code:"EIO"});' : ''}
      ${command.op === 'overlap-crash' ? 'if (row.phase === "reconciled") { await schedulerSaveTasks(); process.exit(3); }' : ''}
      const result = await append(row);
      if (row.phase === 'reconciled') process.exit(3);
      return result;
    })(schedulerAppendFire);`);
    await S.schedulerFireOnce(S.schedulerRuntime.tasks[0], command.mode, command.dueMs);
    throw new Error('terminal crash boundary was not reached');
  }
  await S.schedulerRecover(rows);
  if (command.op === 'drain') {
    await S.schedulerTick();
    while (S.schedulerRuntime.inFlightTaskIds.size) await sleep(10);
  }
  console.log(JSON.stringify({ queued: S.schedulerRuntime.lateQueue.length, task: S.schedulerRuntime.tasks[0], rows: await S.schedulerReadFireRows() }));
}
function coldWorker(data, command) {
  const result = cp.spawnSync(process.execPath, [__filename, '--recovery-worker'], {
    env: { ...process.env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, HOME: data, USERPROFILE: data, WCW_SCHEDULER_CLOCK_FILE: CLOCK },
    input: JSON.stringify(command), encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
  });
  if (['settle-crash', 'overlap-crash', 'skip-crash', 'skip-overlap'].includes(command.op)) {
    ok(!result.error && result.status === 3, `P2 ${command.op} reached the terminal persistence crash boundary`);
    return null;
  }
  if (result.error || result.status) throw new Error(result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}
function seedColdTask(label, now, at = '09:00', failures = 0) {
  const data = path.join(HOME, label);
  fs.mkdirSync(path.join(data, 'scheduler'), { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, schedulerEnabledV1: true,
    stewardEnabledV1: false, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, defaultWorkspace: data,
    desktopMcp: { enabled: false, autodetect: false } }));
  const dueMs = new Date(now).setHours(...at.split(':').map(Number), 0, 0);
  const task = { ...DAILY_BODY(label), id: 'sch_cold_boundary', schedule: { kind: 'daily', at },
    state: { enabled: true, nextFireAt: new Date(dueMs).toISOString(), consecutiveFailures: failures } };
  fs.writeFileSync(path.join(data, 'scheduler/tasks-v1.json'), JSON.stringify({ schema: 1, tasks: [task], globalRuns: { date: '', count: 0 } }));
  return { data, dueMs, id: task.id };
}

if (process.argv.includes('--recovery-worker')) recoveryWorker().catch(error => { console.error(error.stack); process.exitCode = 1; });
else (async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
    includeWorkbenchMcp: false, defaultWorkspace: WORK,
    stewardEnabledV1: false, stewardThreadBriefV1: false,
    schedulerEnabledV1: true,
  }), 'utf8');

  const PORT_A = await getFreePort();
  const PORT_B = await getFreePort();
  let clock = new Date(2026, 4, 4, 12, 0, 0, 0).getTime();   // 2026-05-04 周一 12:00 本地
  const children = [];

  try {
    /* ═════════ K 四段崩溃窗口 ═════════ */
    for (const point of ['after-register', 'after-dispatch', 'mid-run', 'before-reconcile']) {
      setClock(clock);
      const crashed = spawnWb(PORT_A, point);
      children.push(crashed);
      ok(await waitHealth(PORT_A), `K[${point}] 崩溃档服务起来了`);
      const token = await waitToken(crashed);
      const created = await request(PORT_A, 'POST', '/api/scheduler/tasks', DAILY_BODY('崩在 ' + point), token);
      ok(created.status === 200, `K[${point}] 建任务`);
      const task = created.json.task;
      const dueMs = Date.parse(task.nextRunAt);
      // 拨过 due -> 下一拍触发 -> 走到 point 就 process.exit(3)
      setClock(dueMs + MINUTE);
      const code = await waitExit(crashed);
      ok(code === 3, `K[${point}] 服务在该点真的死了(exit ${code},预期 3)`);

      const beforeRows = firesRows();
      ok(registeredOf(beforeRows, task.id).length === 1,
        `K[${point}] 崩之前只登记过一次(registered ${registeredOf(beforeRows, task.id).length} 条)`);
      ok(reconciledOf(beforeRows, task.id).length === 0,
        `K[${point}] 崩的时候还没有终态行 —— 这正是「结果未知」的现场`);

      // 重启(干净档)
      const revived = spawnWb(PORT_B, '');
      children.push(revived);
      ok(await waitHealth(PORT_B), `K[${point}] 重启起来了`);
      const token2 = await waitToken(revived);
      const rows = await waitFires(r => reconciledOf(r, task.id).length >= 1);
      const settled = reconciledOf(rows, task.id)[0];
      ok(!!settled && settled.outcome === 'unknown' && settled.error === 'interrupted',
        `K[${point}] J11:补出来的终态是 unknown/interrupted,【不判成功】(实测 ${settled && settled.outcome}/${settled && settled.error})`);
      ok(registeredOf(rows, task.id).length === 1,
        `K[${point}] 同一个 occurrence 【没有】被再触发一遍(registered 仍 1 条;实测 ${registeredOf(rows, task.id).length})`);
      ok(!!settled && settled.occurrenceKey === registeredOf(rows, task.id)[0].occurrenceKey,
        `K[${point}] 补的终态挂在【原来那个】 occurrence 上,不是新造一个`);
      const list = (await request(PORT_B, 'GET', '/api/scheduler/tasks', null, token2)).json;
      const after = list.tasks.find(t => t.id === task.id);
      ok(!!after && after.state.inFlightRunId === '', `K[${point}] inFlightRunId 已清`);
      ok(!!after && after.state.lastResult === 'unknown', `K[${point}] 任务 lastResult 是 unknown`);
      ok(!!after && Date.parse(after.nextRunAt) > dueMs,
        `K[${point}] nextFireAt 已推过那个时点(${after && after.nextRunAt} > ${new Date(dueMs).toISOString()})`);
      await sleep(TICK_MS * 6);
      ok(registeredOf(firesRows(), task.id).length === 1,
        `K[${point}] 又跑了几拍仍然只有一条 registered(J11「不盲目重发」)`);
      await request(PORT_B, 'DELETE', '/api/scheduler/tasks/' + task.id, null, token2);
      kill(revived);
      await waitExit(revived, 8000);
      clock = dueMs + 2 * HOUR;      // 下一轮从这里起算,别让上一轮的 due 再来一次
    }

    /* ═════════ J10a 错过且在 grace 内 -> 补一次 mode:'late' ═════════ */
    {
      setClock(clock);
      const up = spawnWb(PORT_A, '');
      children.push(up);
      ok(await waitHealth(PORT_A), 'J10a 服务起来了');
      const token = await waitToken(up);
      const created = await request(PORT_A, 'POST', '/api/scheduler/tasks', DAILY_BODY('错过要补'), token);
      ok(created.status === 200, 'J10a 建一条 daily(默认 graceMinutes 720、onMissed run-once-late)');
      const task = created.json.task;
      const dueMs = Date.parse(task.nextRunAt);
      // 干净地停掉 —— 模拟「用户关掉了工作台」,不是崩溃(没有 inFlightRunId)
      kill(up);
      await waitExit(up, 8000);
      const beforeRows = firesRows();
      ok(reconciledOf(beforeRows, task.id).length === 0, 'J10a 停机时这条任务一次都没跑过');
      // 拨过 due 一小时(grace 720 分钟内)再启
      setClock(dueMs + HOUR);
      const back = spawnWb(PORT_B, '');
      children.push(back);
      ok(await waitHealth(PORT_B), 'J10a 重启起来了');
      const token2 = await waitToken(back);
      const rows = await waitFires(r => reconciledOf(r, task.id).length >= 1);
      const late = reconciledOf(rows, task.id)[0];
      ok(!!late && late.mode === 'late',
        `J10a 补跑那一次的触发模式是【late】而不是 ontime —— 界面要如实显示「补跑」(实测 ${late && late.mode})`);
      ok(!!late && late.outcome === 'succeeded', `J10a 补跑真的跑成了(实测 ${late && late.outcome})`);
      ok(!!late && Date.parse(late.dueAt) === dueMs, 'J10a 补的是【原本那个时点】,不是「现在」');
      await sleep(TICK_MS * 8);
      ok(reconciledOf(firesRows(), task.id).length === 1,
        `J10a 【只补一次】,永不追赶(实测 ${reconciledOf(firesRows(), task.id).length} 次)`);
      await request(PORT_B, 'DELETE', '/api/scheduler/tasks/' + task.id, null, token2);
      kill(back);
      await waitExit(back, 8000);
      clock = dueMs + 2 * HOUR;
    }

    /* ═════════ J10b 错过且超出 grace -> skipped,不补跑 ═════════ */
    {
      setClock(clock);
      const up = spawnWb(PORT_A, '');
      children.push(up);
      ok(await waitHealth(PORT_A), 'J10b 服务起来了');
      const token = await waitToken(up);
      const created = await request(PORT_A, 'POST', '/api/scheduler/tasks',
        { ...DAILY_BODY('错过就算了'), policy: { graceMinutes: 5 } }, token);
      ok(created.status === 200 && created.json.task.policy.graceMinutes === 5, 'J10b 建一条 graceMinutes:5 的 daily');
      const task = created.json.task;
      const dueMs = Date.parse(task.nextRunAt);
      kill(up);
      await waitExit(up, 8000);
      setClock(dueMs + HOUR);          // 迟 60 分钟,远超 5 分钟宽限
      const back = spawnWb(PORT_B, '');
      children.push(back);
      ok(await waitHealth(PORT_B), 'J10b 重启起来了');
      const token2 = await waitToken(back);
      const rows = await waitFires(r => reconciledOf(r, task.id).length >= 1);
      const skipped = reconciledOf(rows, task.id)[0];
      ok(!!skipped && skipped.outcome === 'skipped' && skipped.error === 'grace_expired',
        `J10b 超出宽限 -> skipped/grace_expired(实测 ${skipped && skipped.outcome}/${skipped && skipped.error})`);
      ok(!!skipped && skipped.mode === 'late', 'J10b 那一行的 mode 仍是 late(它说的是「这是一个错过的时点」)');
      ok(registeredOf(rows, task.id).length === 0, 'J10b 【没有】 registered 行 —— 它压根没被派出去');
      const list = (await request(PORT_B, 'GET', '/api/scheduler/tasks', null, token2)).json;
      const after = list.tasks.find(t => t.id === task.id);
      ok(!!after && Date.parse(after.nextRunAt) > dueMs, 'J10b nextFireAt 仍然往前推了(跳过不等于卡住)');
      kill(back);
      await waitExit(back, 8000);
    }
    /* P2: recovery before the first tick must not consume an unregistered late occurrence. */
    const coldNow = new Date(2026, 4, 4, 10, 0, 0).getTime();
    setClock(coldNow);
    const lateCase = seedColdTask('late-before-tick', coldNow);
    const first = coldWorker(lateCase.data, { op: 'recover' });
    ok(first.queued === 1 && Date.parse(first.task.state.nextFireAt) === lateCase.dueMs,
      'P2 recovery keeps the old due on disk until its late occurrence is registered');
    const resumed = coldWorker(lateCase.data, { op: 'drain' });
    ok(registeredOf(resumed.rows, lateCase.id).length === 1 && reconciledOf(resumed.rows, lateCase.id)[0]?.outcome === 'succeeded',
      'P2 a second cold process still dispatches and completes the unregistered late occurrence');
    const again = coldWorker(lateCase.data, { op: 'drain' });
    ok(registeredOf(again.rows, lateCase.id).length === 1, 'P2 another restart cannot duplicate the recovered occurrence');

    /* P2: a crash between terminal log/task writes retains the result and its policy effects. */
    for (const row of [{ mode: 'ontime', fail: false }, { mode: 'ontime', fail: true }, { mode: 'manual', fail: false }]) {
      const fixture = seedColdTask('terminal-' + row.mode + '-' + row.fail, coldNow, row.mode === 'manual' ? '21:00' : '09:00', 2);
      coldWorker(fixture.data, { op: 'settle-crash', ...row, dueMs: row.mode === 'manual' ? coldNow : fixture.dueMs });
      const recovered = coldWorker(fixture.data, { op: 'drain' });
      const terminal = reconciledOf(recovered.rows, fixture.id);
      ok(terminal.length === 1 && terminal[0].outcome === (row.fail ? 'failed' : 'succeeded')
        && recovered.task.state.lastResult === terminal[0].outcome && !recovered.task.state.inFlightRunId,
        `P2 ${row.mode}/${row.fail ? 'failed' : 'succeeded'} restores the durable terminal result without changing it to unknown`);
      ok(recovered.task.state.consecutiveFailures === (row.fail ? 3 : 0) && recovered.task.state.enabled === !row.fail,
        'P2 recovery restores failure/reset counters and a tripped task stays disabled');
      ok(row.mode === 'manual' ? Date.parse(recovered.task.state.nextFireAt) === fixture.dueMs : Date.parse(recovered.task.state.nextFireAt) > coldNow,
        'P2 recovery preserves manual schedules and advances consumed planned occurrences');
    }
    const overlap = seedColdTask('terminal-overlap', coldNow);
    coldWorker(overlap.data, { op: 'overlap-crash', mode: 'ontime', dueMs: overlap.dueMs });
    const pending = JSON.parse(fs.readFileSync(path.join(overlap.data, 'scheduler/tasks-v1.json'), 'utf8')).tasks[0];
    ok(!!pending.state.inFlightRunId, 'P2 another whole-table write cannot clear the live marker before terminal persistence');
    const uncertain = coldWorker(overlap.data, { op: 'drain' });
    ok(registeredOf(uncertain.rows, overlap.id).length === 1 && reconciledOf(uncertain.rows, overlap.id).length === 1
      && uncertain.task.state.lastResult === 'unknown', 'P2 an interrupted overlapping save has one unknown receipt and never replays the work');
    const edited = seedColdTask('terminal-edit', coldNow, '09:00', 2);
    const editResult = coldWorker(edited.data, { op: 'edit-settle', dueMs: edited.dueMs });
    const afterEdit = editResult.task;
    ok(afterEdit.state.enabled && afterEdit.state.consecutiveFailures === 1 && !afterEdit.state.inFlightRunId
      && Date.parse(afterEdit.state.nextFireAt) === new Date(2026, 4, 4, 21, 0).getTime(),
      'P2 terminal persistence preserves a concurrent schedule edit and failure-counter reset');
    ok(reconciledOf(editResult.rows, edited.id)[0]?.tripped === true,
      'P2 the receipt retains the failure threshold observed at completion before the user reset');
    for (const variant of ['policy', 'cap', 'overlap']) {
      const cap = variant === 'cap';
      const beforeMidnight = new Date(2026, 4, 4, 23, 59, 30).getTime();
      setClock(beforeMidnight);
      const fixture = seedColdTask('skipped-' + variant, beforeMidnight, '23:50');
      const file = path.join(fixture.data, 'scheduler/tasks-v1.json'), seed = JSON.parse(fs.readFileSync(file, 'utf8'));
      seed.tasks[0].schedule = { kind: 'once', date: '2026-05-04', at: '23:50' };
      seed.tasks[0].policy = { onMissed: cap ? 'run-once-late' : 'skip', maxRunsPerDay: 1, graceMinutes: 720 };
      seed.tasks[0].state.runsToday = { date: '2026-05-04', count: 1 };
      fs.writeFileSync(file, JSON.stringify(seed));
      coldWorker(fixture.data, { op: variant === 'overlap' ? 'skip-overlap' : 'skip-crash', cap, dueMs: fixture.dueMs });
      if (variant === 'overlap') ok(Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].state.nextFireAt) === fixture.dueMs,
        'P2 another whole-table save cannot consume a tick skip before its receipt is durable');
      setClock(beforeMidnight + 2 * MINUTE);
      const recovered = coldWorker(fixture.data, { op: 'drain' });
      ok(reconciledOf(recovered.rows, fixture.id).length === 1 && !registeredOf(recovered.rows, fixture.id).length
        && recovered.task.state.lastResult === 'skipped' && !recovered.task.state.nextFireAt,
        `P2 ${variant} skip stays consumed across midnight without replaying work or duplicating its receipt`);
    }
  } finally {
    for (const child of children) kill(child);
  }

  console.log(fail ? ('FAIL total ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
