// ============================================================================
// 第 123 波 M1 §3.2/§3.3/§3.4(37 号文;设计权威 29 号文 §4「调度器」§5「载荷」§10「红线」):
// 定时任务调度器 —— tick、四段触发、启动恢复、上限与熔断、六条 API。
//
// 落点(transport 层,manifest 中位于 13r-event-stream.js 之后、14-main.js 之前;文件名按
// ENGINEERING-SPEC §1 的 ^13[a-z]?- 正则)。
//
// 依赖方向:
//   · 本文件引用的一切(06j 的纯函数、02 的会话存储、04 的 activeChildren/stopSession、
//     07 的 ask 等待表、10 的 runSessionTurn、13i/13j/13k 的既有原语、00-boot 的 RUYI_EVENTS)
//     在 manifest 里都排在它【之前】,全部后向边;
//   · 13-http-router.js 排在本文件【之前】,它那一行 `await handleSchedulerApiRoutes(...)` 是一条
//     **前向边**(13 → 13s),与既有的 13 → 13b/13c/13d 同型 —— 已登记进
//     src/module-dependency-policy.json 的 allowedForwardEdges 并附来路。
//     为什么不走 Hooks 迟绑定:那三条域路由的先例就是直调,路由清册的扫描器也按这个形状认
//     (`await handleXxxApiRoutes(`);再造一个 Hooks 只会让清册多一个看不见的入口。
//     reminder 出箱那一头【必须】走 Hooks(SchedulerHooks,住 06j)—— 填充方 13i 排在 13s 之前。
//
// 红线(29 号文 §10,每条都有锁):
//   ① 无人值守遇 ask 【绝不自动放行】。本文件只把「等多久」换成 config.schedulerAskWaitMinutes,
//      gate 语义一个字不动 —— 到时仍然是拒(子集律:只能拒,永不放行)。
//   ② 任务定义只能由 token 级 API 写入(01b-route-auth 六条全 token;body-token 永远够不着)。
//   ③ 载荷禁止键在 06j 的 normalizeSchedulerTask 里整条拒。
//   ④ 补跑只补一次,永不追赶多次;熔断优先于重试。
//   ⑤ 关闭调度或无任务时【零后台开销、零持久化写入】—— schedulerEnabledV1 !== true 时
//      startScheduler 立即返回(不建目录、不起 interval、不读盘);零任务时不起 interval。
//   ⑥ 进程崩溃后那一次记 unknown,不默认成功、不盲目重发(J11)。
// ============================================================================

// ── 落盘常量 ────────────────────────────────────────────────────────────────
const SCHEDULER_DIR_NAME = 'scheduler';
const SCHEDULER_TASKS_FILE = 'tasks-v1.json';
const SCHEDULER_FIRES_FILE = 'fires-v1.ndjson';
const SCHEDULER_TASKS_SCHEMA = 1;

// ── 运行常量 ────────────────────────────────────────────────────────────────
const SCHEDULER_TICK_MS_DEFAULT = 30000;      // 29 号文 §4:30 s(任务精度是分钟级,不是秒级)
const SCHEDULER_TICK_MS_MIN = 10;             // 只有测试旗能压到这么低
const SCHEDULER_TICK_MS_MAX = 300000;
const SCHEDULER_FIRES_FULL_READ_BYTES = 8 * 1024 * 1024;   // 超过它只读尾窗(同 inbox 口径)
const SCHEDULER_FIRES_TAIL_BYTES = 1024 * 1024;
const SCHEDULER_RUNS_LIMIT_DEFAULT = 5;
const SCHEDULER_RUNS_LIMIT_MAX = 50;
const SCHEDULER_TITLE_IN_FIRE_MAX = 120;

// ── 测试旗(§3.4)────────────────────────────────────────────────────────────
// 口径与仓里既有的测试缝逐字同款(05-claude-engine 的 WCW_FAKE_CLAUDE、06g 的
// WCW_RESOURCE_LEASE_TIMEOUT_MS、09-workflow 的 WCW_AGENT_NODE_IDLE_MS):**只读 process.env**,
// 默认缺省即生产行为,不进 config、不进 UI、不落盘。不带旗时下面四个函数各自回落到生产取值 ——
// scheduler.e2e.js 的 A 组钉的就是这一条:四个旗名在整个 src/ 里【只】出现在本文件的这四个
// process.env 读取点,且不带旗时 tickMs 读到的是生产默认 30 s、崩溃钩子一次都不触发。
function schedulerClockNow() {
  const file = process.env.WCW_SCHEDULER_CLOCK_FILE || '';
  if (!file) return Date.now();
  try {
    const value = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  } catch { /* 假时钟文件还没写出来:回落真时钟 */ }
  return Date.now();
}
function schedulerTickMs() {
  const raw = Number(process.env.WCW_SCHEDULER_TICK_MS);
  if (!Number.isFinite(raw)) return SCHEDULER_TICK_MS_DEFAULT;
  return Math.min(SCHEDULER_TICK_MS_MAX, Math.max(SCHEDULER_TICK_MS_MIN, Math.round(raw)));
}
// ask 等待窗口。生产取 config.schedulerAskWaitMinutes(01-config 已钳 [1,240]);测试旗把它压到毫秒级。
// **只改「等多久」,不改「等到了怎么判」** —— 到时仍是拒,见 07-autonomy 的 requestNativePermission。
function schedulerAskWaitMs(schedConfig) {
  const raw = Number(process.env.WCW_SCHEDULER_ASK_WAIT_MS);
  if (Number.isFinite(raw) && raw >= 50) return Math.round(raw);
  const minutes = Number(schedConfig && schedConfig.schedulerAskWaitMinutes);
  const clamped = Number.isFinite(minutes)
    ? Math.min(SCHEDULER_LIMITS.askWaitMinutesMax, Math.max(SCHEDULER_LIMITS.askWaitMinutesMin, Math.round(minutes)))
    : SCHEDULER_LIMITS.askWaitMinutesDefault;
  return clamped * 60000;
}
// 崩溃钩子:在四段边界上把服务打死(process.exit(3)),供 scheduler-crash.e2e.js 造真崩溃。
// 四个点名与 §3.2 逐字:after-register / after-dispatch / mid-run / before-reconcile。
function schedulerMaybeCrash(schedPoint) {
  if (String(process.env.WCW_SCHEDULER_CRASH_AT || '') !== String(schedPoint)) return;
  try { logEvent({ kind: 'scheduler_test_crash', point: String(schedPoint) }); } catch { /* 观测不反噬 */ }
  process.exit(3);
}

// ── 运行时(进程内;重启即空,任何要活过重启的事实都在磁盘上)────────────────────────────────
const schedulerRuntime = {
  enabled: false,
  started: false,
  loaded: false,
  timer: null,
  generation: 0,        // stopScheduler 自增;在途 tick 发现代际变了就尽快退出
  ticking: false,       // 全局并发 1 的第一道闸(第二道是 fire 循环里的 await 串行)
  tasks: [],
  fireSeq: 0,
  globalRuns: { date: '', count: 0 },
  lateQueue: [],        // [{ taskId, dueMs }] —— 启动恢复排的补跑,只排一次(29 号文 §4「只补一次」)
  // 启动恢复【只认装载那一刻盘上就有的那些任务】。为什么需要这个集合:调度器起在 boot 探针段
  // (listen 之后 500 ms,见 13-http-router 那一行的理由),而六条 API 在 listen 那一刻就活了 ——
  // 用户/e2e 完全可能在这 500 ms 里建一条任务并把时钟拨过它。那条任务【不是「错过」的】:
  // 它的 nextFireAt 是刚刚按「现在」算出来的,本进程一直在跑,只是还没轮到第一拍。
  // 不区分的话它会被 missedOccurrence 认成错过、以 mode:'late' 补跑 —— 界面上就成了「补跑」,
  // 而事实是准时。(实测:scheduler.e2e 的 B3 当场红成「succeeded/late」。)
  loadedFromDisk: new Set(),
  attempts: new Map(),  // occurrenceKey -> 已注册过几次(executionGeneration 的来源)
  lastError: '',
  firedTotal: 0,        // e2e 观测用:本进程一共触发过几次
};
let schedulerTasksChain = Promise.resolve();   // tasks-v1.json 的 per-process 串行写链
let schedulerFiresChain = Promise.resolve();   // fires-v1.ndjson 的 per-process 串行 append 链

function schedulerDir() { return path.join(paths.data, SCHEDULER_DIR_NAME); }
function schedulerTasksPath() { return path.join(schedulerDir(), SCHEDULER_TASKS_FILE); }
function schedulerFiresPath() { return path.join(schedulerDir(), SCHEDULER_FIRES_FILE); }
function schedulerDayKey(schedMs) {
  const d = new Date(schedMs);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function schedulerEnabled(schedConfig) { return !!(schedConfig && schedConfig.schedulerEnabledV1 === true); }

// 事件:任务或 fires 变了。13r 只转发,不承载正文(§6.1 红线)—— 帧里只有「哪条任务、到了哪一段、
// 什么结果」,标题与文案都不进这条线(前端从 GET /api/scheduler/tasks 那一份拿)。
function schedulerEmitChanged(schedTaskId, schedPhase, schedOutcome) {
  try {
    RUYI_EVENTS.emit('schedule.changed', {
      taskId: String(schedTaskId || ''),
      phase: String(schedPhase || ''),
      outcome: String(schedOutcome || ''),
    });
  } catch { /* 观测绝不反噬触发 */ }
}
// 旁路回调(SchedulerHooks 住 06j)。未填充 = 无操作;填充方抛错就地吞掉。
function schedulerNotify(schedHookName, schedRow) {
  try {
    const hook = SchedulerHooks[schedHookName];
    if (typeof hook === 'function') return Promise.resolve(hook(schedRow)).catch(() => null);
  } catch { /* ignore */ }
  return Promise.resolve(null);
}

// ── 落盘:tasks-v1.json(atomicWriteJson)────────────────────────────────────────────────────
async function schedulerReadTasksFile() {
  const file = schedulerTasksPath();
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); }
  catch { return { tasks: [], globalRuns: { date: '', count: 0 }, missing: true }; }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || parsed.schema !== SCHEDULER_TASKS_SCHEMA || !Array.isArray(parsed.tasks)) {
    // 隔离而不是就地丢:用户的任务定义是他自己写下的东西,坏了要留一份原件给他捞。
    // rename 而不是 copy —— 留在原地会每次读都重新隔离一次,并且永远报「存在但读不出来」。
    try { await fsp.rename(file, file + '.corrupt'); } catch { /* best-effort */ }
    schedulerRuntime.lastError = 'tasks-v1.json 损坏或版本不符,已隔离为 tasks-v1.json.corrupt,本次按空表启动';
    try { logEvent({ kind: 'scheduler_tasks_corrupt', detail: schedulerRuntime.lastError }); } catch { /* ignore */ }
    return { tasks: [], globalRuns: { date: '', count: 0 }, missing: false };
  }
  const runs = (parsed.globalRuns && typeof parsed.globalRuns === 'object') ? parsed.globalRuns : {};
  return {
    tasks: parsed.tasks,
    globalRuns: { date: String(runs.date || ''), count: Math.max(0, Number(runs.count) || 0) },
    missing: false,
  };
}
// 写盘。**零任务时也要写**(用户刚把最后一条删掉,那份空表就是事实);但 startScheduler 在
// schedulerEnabledV1 关时压根不会走到这里(红线⑤:关着一个字节都不写)。
function schedulerSaveTasks() {
  const payload = {
    schema: SCHEDULER_TASKS_SCHEMA,
    updatedAt: new Date(schedulerClockNow()).toISOString(),
    globalRuns: schedulerRuntime.globalRuns,
    tasks: schedulerRuntime.tasks,
  };
  const next = schedulerTasksChain.catch(() => {}).then(async () => {
    await fsp.mkdir(schedulerDir(), { recursive: true });
    await atomicWriteJson(schedulerTasksPath(), payload);
  });
  schedulerTasksChain = next.catch(() => {});
  return next;
}

// ── 落盘:fires-v1.ndjson(append-only;与 session-changes / inbox 同款原语)──────────────────
function schedulerAppendFire(schedRow) {
  schedulerRuntime.fireSeq += 1;
  const row = { seq: schedulerRuntime.fireSeq, at: new Date(schedulerClockNow()).toISOString(), ...schedRow };
  const file = schedulerFiresPath();
  const payload = JSON.stringify(row) + '\n';
  const next = schedulerFiresChain.catch(() => {}).then(async () => {
    await fsp.mkdir(schedulerDir(), { recursive: true });
    await repairMissionChangeTornTail(file);   // 尾部半行先截干净,再整行 append(防焊接)
    await fsp.appendFile(file, payload, 'utf8');
  });
  schedulerFiresChain = next.catch(() => {});
  return next.then(() => row);
}
async function schedulerReadFiresText() {
  const file = schedulerFiresPath();
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
  if (size <= SCHEDULER_FIRES_FULL_READ_BYTES) {
    try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
  }
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(SCHEDULER_FIRES_TAIL_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SCHEDULER_FIRES_TAIL_BYTES, size - SCHEDULER_FIRES_TAIL_BYTES);
    return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
  } catch { return { text: '', droppedHead: false }; }
  finally { if (fh) await fh.close().catch(() => {}); }
}
// 坏行/尾部半行一律跳过(append-only 日志的既有纪律)。
async function schedulerReadFireRows() {
  const { text, droppedHead } = await schedulerReadFiresText();
  const lines = String(text || '').split('\n');
  const rows = [];
  for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { row = null; }
    if (!row || typeof row !== 'object') continue;
    if (!Number.isSafeInteger(Number(row.seq)) || !SCHEDULER_PHASES.includes(String(row.phase || ''))) continue;
    rows.push(row);
  }
  return rows;
}

// ── 装载与启动恢复 ──────────────────────────────────────────────────────────
// 归一化会【现算】nextFireAt(见 06j 的 ⑥ 段),而启动恢复恰恰要看磁盘上那个【旧的】nextFireAt
// (它 <= 现在 就等于「那一刻没人来触发」)。所以装载时归一化之后要把两个字段按盘上的值放回去。
// 这一步不能省:省了就永远算不出「错过」,J10 会静默变成「从不补跑」。
function schedulerRestorePersistedState(schedTask, schedRawTask) {
  const rawState = (schedRawTask && schedRawTask.state && typeof schedRawTask.state === 'object') ? schedRawTask.state : {};
  const persistedNext = Date.parse(String(rawState.nextFireAt || ''));
  if (Number.isFinite(persistedNext)) schedTask.state.nextFireAt = new Date(persistedNext).toISOString();
  const persistedUpdated = Date.parse(String(schedRawTask && schedRawTask.updatedAt));
  if (Number.isFinite(persistedUpdated)) schedTask.updatedAt = new Date(persistedUpdated).toISOString();
  return schedTask;
}
async function schedulerLoad() {
  if (schedulerRuntime.loaded) return;
  const now = schedulerClockNow();
  const file = await schedulerReadTasksFile();
  const tasks = [];
  for (const rawTask of file.tasks) {
    const normalized = normalizeSchedulerTask(rawTask, now);
    if (!normalized.ok) continue;                       // 坏行跳过(不静默改写用户的定义)
    if (!normalized.task.id) continue;                  // 没有 id 的行不该在盘上,跳过
    tasks.push(schedulerRestorePersistedState(normalized.task, rawTask));
    if (tasks.length >= SCHEDULER_LIMITS.maxTasks) break;
  }
  schedulerRuntime.tasks = tasks;
  schedulerRuntime.loadedFromDisk = new Set(tasks.map(task => task.id));
  schedulerRuntime.globalRuns = file.globalRuns;
  // fires 的单调 seq 与「同 occurrence 试过几次」都从盘上的账重建 —— 进程内计数器不跨重启。
  const rows = await schedulerReadFireRows();
  let maxSeq = 0;
  const attempts = new Map();
  for (const row of rows) {
    const seq = Number(row.seq) || 0;
    if (seq > maxSeq) maxSeq = seq;
    if (String(row.phase) === 'registered') {
      const key = String(row.occurrenceKey || '');
      if (key) attempts.set(key, (attempts.get(key) || 0) + 1);
    }
  }
  schedulerRuntime.fireSeq = maxSeq;
  schedulerRuntime.attempts = attempts;
  schedulerRuntime.loaded = true;
  return rows;
}

// 启动恢复(§3.2)。两件事,顺序不能反:
//   ① 崩溃残留 —— 有 inFlightRunId 且 fires 里那个 run 没有 reconciled 行 → 补一条 unknown。
//      **那一次 occurrence 就此消费掉**(nextFireAt 推过它),否则重启会把同一个 occurrence 再触发
//      一遍 —— 而它上一次可能已经真的动过文件了(J11「不重发」)。
//   ② 错过的时点 —— 必须排在 ① 之后:被崩溃消费掉的那个时点不该再算作「错过」。
async function schedulerRecover(schedFireRows) {
  const now = schedulerClockNow();
  const rows = Array.isArray(schedFireRows) ? schedFireRows : await schedulerReadFireRows();
  const byRun = new Map();          // runId -> { occurrenceKey, dueAt, mode, reconciled }
  for (const row of rows) {
    const runId = String(row.runId || '');
    if (!runId) continue;
    const entry = byRun.get(runId) || { occurrenceKey: '', dueAt: '', mode: 'ontime', reconciled: false };
    if (row.occurrenceKey) entry.occurrenceKey = String(row.occurrenceKey);
    if (row.dueAt) entry.dueAt = String(row.dueAt);
    if (row.mode) entry.mode = String(row.mode);
    if (String(row.phase) === 'reconciled') entry.reconciled = true;
    byRun.set(runId, entry);
  }
  let dirty = false;

  // 只走「装载那一刻盘上就有的」那些任务(见 loadedFromDisk 的头注)。
  const fromDisk = schedulerRuntime.tasks.filter(task => schedulerRuntime.loadedFromDisk.has(task.id));

  // ① 崩溃残留
  for (const task of fromDisk) {
    const runId = String(task.state.inFlightRunId || '');
    if (!runId) continue;
    const entry = byRun.get(runId) || { occurrenceKey: occurrenceKey(task.id, now), dueAt: '', mode: 'ontime', reconciled: false };
    if (!entry.reconciled) {
      await schedulerAppendFire({
        taskId: task.id,
        title: String(task.title).slice(0, SCHEDULER_TITLE_IN_FIRE_MAX),
        occurrenceKey: entry.occurrenceKey,
        dueAt: entry.dueAt,
        runId,
        executionGeneration: schedulerRuntime.attempts.get(entry.occurrenceKey) || 1,
        mode: entry.mode,
        phase: 'reconciled',
        outcome: 'unknown',
        error: 'interrupted',
      });
      void schedulerNotify('onSchedulerNotice', {
        kind: 'unknown', taskId: task.id, title: task.title,
        occurrenceKey: entry.occurrenceKey, mode: entry.mode, at: new Date(now).toISOString(),
      });
      schedulerEmitChanged(task.id, 'reconciled', 'unknown');
    }
    task.state.inFlightRunId = '';
    task.state.lastResult = 'unknown';
    // 把 nextFireAt 推过那个已经消费掉的时点。dueAt 读不出来时用「现在」兜底(仍然只往前走)。
    const consumedMs = Date.parse(entry.dueAt);
    const fromMs = Number.isFinite(consumedMs) ? Math.max(now, consumedMs) : now;
    const nextMs = nextFireAt(task.schedule, fromMs);
    task.state.nextFireAt = nextMs == null ? '' : new Date(nextMs).toISOString();
    dirty = true;
  }

  // ② 错过的时点
  for (const task of fromDisk) {
    if (!task.state.enabled) continue;
    const missed = missedOccurrence(task, now);
    if (!missed) continue;
    if (missed.runLate) {
      schedulerRuntime.lateQueue.push({ taskId: task.id, dueMs: missed.dueMs });
    } else {
      await schedulerAppendFire({
        taskId: task.id,
        title: String(task.title).slice(0, SCHEDULER_TITLE_IN_FIRE_MAX),
        occurrenceKey: missed.occurrenceKey,
        dueAt: new Date(missed.dueMs).toISOString(),
        runId: '',
        executionGeneration: 0,
        mode: 'late',
        phase: 'reconciled',
        outcome: 'skipped',
        error: missed.withinGrace ? 'policy_skip' : 'grace_expired',
      });
      void schedulerNotify('onSchedulerNotice', {
        kind: 'skipped', taskId: task.id, title: task.title,
        occurrenceKey: missed.occurrenceKey, mode: 'late', at: new Date(now).toISOString(),
        reason: missed.withinGrace ? 'policy_skip' : 'grace_expired',
      });
      schedulerEmitChanged(task.id, 'reconciled', 'skipped');
    }
    // 两条路都推进 nextFireAt ——「补跑只补一次」由 lateQueue 保证,不靠「还留着旧时点」。
    const nextMs = nextFireAt(task.schedule, now);
    task.state.nextFireAt = nextMs == null ? '' : new Date(nextMs).toISOString();
    dirty = true;
  }
  // 恢复只做一次:清掉集合,此后任何任务都只能走正常的 tick(mode:'ontime')。
  schedulerRuntime.loadedFromDisk = new Set();
  if (dirty) await schedulerSaveTasks();
}

// ── 触发四段(§3.2)────────────────────────────────────────────────────────
// 权限档:任务自带的档是【天花板 = 全局档去掉 bypass】。任务没给(''),或给的档不在
// PERMISSION_MODES 白名单里,或给的是 bypass —— 一律回落全局默认档。这一句是 06j 那半条校验
// (「不是 bypass 的非空字符串就留着」)的另一半:只有这里读得到 config。
function schedulerPermissionModeFor(schedTask, schedConfig) {
  const wanted = String((schedTask.autonomy && schedTask.autonomy.permissionMode) || '');
  const globalMode = String((schedConfig && schedConfig.permissionMode) || 'default');
  if (!wanted) return globalMode;
  if (wanted === 'bypass' || wanted === 'bypassPermissions') return globalMode;
  if (!PERMISSION_MODES.includes(wanted)) return globalMode;
  return wanted;
}

// 一次触发。mode ∈ ontime|late|manual。返回本次的 outcome(e2e 与 run-now 都读它)。
async function schedulerFireOnce(schedTask, schedMode, schedDueMs) {
  const task = schedTask;
  const startedMs = schedulerClockNow();
  const day = schedulerDayKey(startedMs);
  if (schedulerRuntime.globalRuns.date !== day) schedulerRuntime.globalRuns = { date: day, count: 0 };
  if (!task.state.runsToday || task.state.runsToday.date !== day) task.state.runsToday = { date: day, count: 0 };
  const occKey = occurrenceKey(task.id, schedDueMs);
  const dueAt = new Date(schedDueMs).toISOString();

  // ── 上限(29 号文 §4)。撞上限不是失败,是【这一次不跑】:记一行 skipped 并推进下一次。
  const globalFull = schedulerRuntime.globalRuns.count >= SCHEDULER_LIMITS.globalRunsPerDay;
  const taskFull = task.state.runsToday.count >= task.policy.maxRunsPerDay;
  if (globalFull || taskFull) {
    await schedulerAppendFire({
      taskId: task.id, title: String(task.title).slice(0, SCHEDULER_TITLE_IN_FIRE_MAX),
      occurrenceKey: occKey, dueAt, runId: '', executionGeneration: 0, mode: schedMode,
      phase: 'reconciled', outcome: 'skipped', error: globalFull ? 'global_daily_cap' : 'task_daily_cap',
    });
    if (schedMode !== 'manual') {
      const bumped = nextFireAt(task.schedule, startedMs);
      task.state.nextFireAt = bumped == null ? '' : new Date(bumped).toISOString();
    }
    task.state.lastResult = 'skipped';
    task.state.lastMode = schedMode;
    await schedulerSaveTasks();
    schedulerEmitChanged(task.id, 'reconciled', 'skipped');
    return 'skipped';
  }

  const runId = makeId('srun');
  const attempts = (schedulerRuntime.attempts.get(occKey) || 0) + 1;
  schedulerRuntime.attempts.set(occKey, attempts);
  const fireBase = {
    taskId: task.id,
    title: String(task.title).slice(0, SCHEDULER_TITLE_IN_FIRE_MAX),
    occurrenceKey: occKey,
    dueAt,
    runId,
    executionGeneration: attempts,
    mode: schedMode,
  };

  // ── ① 登记(原子写 inFlightRunId + lastFiredAt,再落一行 registered)────────────────────
  task.state.inFlightRunId = runId;
  task.state.lastFiredAt = new Date(startedMs).toISOString();
  task.state.lastMode = schedMode;
  task.state.runsToday = { date: day, count: task.state.runsToday.count + 1 };
  schedulerRuntime.globalRuns = { date: day, count: schedulerRuntime.globalRuns.count + 1 };
  await schedulerSaveTasks();
  await schedulerAppendFire({ ...fireBase, phase: 'registered' });
  schedulerRuntime.firedTotal += 1;
  schedulerEmitChanged(task.id, 'registered', '');
  schedulerMaybeCrash('after-register');

  // ── ② 派单 ────────────────────────────────────────────────────────────────
  const config = await readConfig();
  let outcome = 'succeeded';
  let error = '';
  let sessionId = '';
  let costTokens = 0;

  if (task.payload.kind === 'reminder') {
    // reminder 【不调模型】(29 号文 §5:永远安全)。出箱那一头是 M2 的活,这里只敲回调口。
    await schedulerAppendFire({ ...fireBase, phase: 'dispatched' });
    schedulerEmitChanged(task.id, 'dispatched', '');
    schedulerMaybeCrash('after-dispatch');
    schedulerMaybeCrash('mid-run');
    await schedulerNotify('onReminderDue', {
      taskId: task.id, title: task.title, text: task.payload.text,
      occurrenceKey: occKey, dueAt, firedAt: new Date(startedMs).toISOString(), mode: schedMode,
      ...(task.payload.sourceRef ? { sourceRef: task.payload.sourceRef } : {}),
    });
  } else {
    let session = null;
    if (task.target.mode === 'existing-session' && task.target.sessionId) {
      session = await loadSession(task.target.sessionId).catch(() => null);
    }
    if (!session) {
      // 与 13k stewardImplThreadNew 同一条路:createSession → 三个身份字段 → saveSession → 起回合。
      // origin 用 'schedule'(02-session-store:2819 早已为 119/123 波留好的第三值);launchedBy/createdBy
      // 仍是 'steward' —— 13i 的第四源按 launchedBy 收 done/failed,那条路不能断。
      session = await createSession({ title: String(task.title).slice(0, SCHEDULER_TITLE_IN_FIRE_MAX), origin: 'schedule' });
      session.kind = 'mission';
      session.launchedBy = 'steward';
      session.createdBy = 'steward';
      session.titleSource = 'steward';
      // 127 波 2-ter(45 号文 §2-quinquies):档位(S-a)与这条任务自己固定的工作文件夹(S-b)。
      // 位置与 13k stewardImplThreadNew 同款:createSession 之后改内存副本,跟着下面那一次 saveSession
      // 落盘,零额外写;下面起回合传的 cwd 正是这里换过的 session.cwd,所以仲裁器的写锁键跟着变
      // (修前所有定时线程都在 defaultWorkspace 上,互相抢、也跟手工线程抢同一把 cwd-write 锁)。
      // 实现住 13t(SchedulerHooks.prepareThread,契约见 06j):它要 13k 的派生原语与管家的 applyThreadTier,
      // 本文件直调 13k 会是一条把 13k 拉进环的新边。没填 = 两件都不做,与修前逐字节同路;填充方两件各自
      // 兜住自己的异常,哪件出错哪件回落(档位跟随全局 / 文件夹回落 defaultWorkspace)。
      const workdirBefore = String(task.workdir || '');
      const prepared = await schedulerNotify('prepareThread', { session, task, config });
      // 派生不成(表满 / 根不可用 / 撞名试满 / 写配置失败)不让触发失败:线程照旧落在 defaultWorkspace,
      // 但留一条日志 —— 否则用户只会看到「又在等锁」而无从知道是表满了。
      if (prepared && prepared.workdir === 'fallback') {
        try {
          logEvent({ kind: 'scheduler_workdir_fallback', taskId: task.id, sessionId: session.id, reason: String(prepared.fallbackReason || '') });
        } catch { /* 观测不反噬触发 */ }
      }
      await saveSession(session);
      // 首次派生(或原文件夹不在表里、重新派生)出了新路径:立刻写回任务表,不等回合收尾 ——
      // 回合可能跑半个小时,期间进程没了的话下一次会再派生一个 `-2` 目录、再占一行候选表。
      if (String(task.workdir || '') !== workdirBefore) await schedulerSaveTasks();
    }
    sessionId = session.id;
    await schedulerAppendFire({ ...fireBase, phase: 'dispatched', sessionId });
    schedulerEmitChanged(task.id, 'dispatched', '');
    schedulerMaybeCrash('after-dispatch');
    await schedulerAppendFire({ ...fireBase, phase: 'running', sessionId });
    schedulerMaybeCrash('mid-run');

    // 无人值守的 ask:只把「等多久」换掉(见 07-autonomy 的 schedulerAskWaitSessions);
    // 成对写/清 —— finally 里删,否则一条被换过窗口的会话会把这个值带到后面的手动回合上。
    schedulerAskWaitSessions.set(sessionId, schedulerAskWaitMs(config));
    let permissionDenied = 0;
    const onEvent = evt => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'permission_decision' && evt.behavior !== 'allow') permissionDenied += 1;
      if (evt.type === 'usage' && evt.usage) {
        const u = evt.usage;
        costTokens += (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
          + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
      }
    };
    let timedOut = false;
    // 已知债(127 波 2-ter 登记,不在本刀修):回合在仲裁器里等锁/等并发位时,这里的 await 一直挂着,
    // schedulerRuntime.ticking 也就一直是 true —— 整个调度器跟着停摆(别的任务到点也不触发);而超时
    // 计时器调的 stopSession 只认活回合,【排队中】的那一条不会被出队。S-b 让定时线程不再与
    // defaultWorkspace 上的手工线程抢同一把锁,大幅缓解但没有根治(并发位满 / 预算触顶仍会这样等)。
    const timer = setTimeout(() => {
      timedOut = true;
      try { stopSession(sessionId, 'scheduler_timeout'); } catch { /* 会话已经收尾 */ }
    }, Math.max(1000, task.policy.timeoutMinutes * 60000));
    if (timer && typeof timer.unref === 'function') timer.unref();
    let result = null;
    try {
      result = await runSessionTurn({
        sessionId,
        message: task.payload.text,
        cwd: session.cwd,
        permissionMode: schedulerPermissionModeFor(task, config),
        source: 'scheduler',
        requestMeta: { taskId: task.id, runId },
        onEvent,
      });
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 400);
    } finally {
      clearTimeout(timer);
      schedulerAskWaitSessions.delete(sessionId);
    }
    // 成败口径与 13k stewardRecordLaunchOutcome 逐字同源:取【内层】 result.result.ok ——
    // 外层 ok 只表示「这次调用完成了」,一条 HTTP 500 的回合外层仍然是 ok:true(116-4 实测)。
    const inner = (result && typeof result === 'object' && result.result && typeof result.result === 'object') ? result.result : null;
    const turnOk = inner ? inner.ok === true : !!(result && result.ok);
    if (timedOut) { outcome = 'failed'; error = error || 'timeout'; }
    else if (!result || !turnOk) { outcome = 'failed'; error = error || String((inner && inner.errorClass) || 'turn_failed'); }
    else if (permissionDenied > 0) { outcome = 'needs_you'; error = 'permission_denied'; }
    else outcome = 'succeeded';
    // 第四源(13i 按 launchedBy:'steward' 收 done/failed):把身份与成败落到【会话头】上。
    // 为什么必须落盘:收件箱只读磁盘上的账,runSessionTurn 的返回值只活在这一个闭包里(116-4 的教训)。
    // 判据与 13k stewardRecordLaunchOutcome 【同口径】—— 取内层 result.result.ok、aborted 看内层、
    // errorClass 从内层拿;这里不调它而是就地写,是因为上面那三行已经把 inner/turnOk 算出来了,
    // 再调一遍等于把同一个判断算两次(两次的口径将来会各自漂)。走 updateSessionMeta 而不是
    // loadSession+saveSession:它会避开活回合的写竞态。旁路纪律:写失败只是少一条账,绝不反噬触发。
    void updateSessionMeta(sessionId, {
      launchedBy: 'steward',
      stewardLastTurn: {
        seq: Math.max(0, Number(result && result.turnSeq) || 0),
        ok: outcome === 'succeeded',
        aborted: !!(inner ? inner.aborted : (result && result.stopped)),
        errorClass: String((inner && inner.errorClass) || (timedOut ? 'timeout' : '')),
        at: nowIso(),
      },
    }).catch(() => null);
  }

  // ── ④ 收尾 ────────────────────────────────────────────────────────────────
  schedulerMaybeCrash('before-reconcile');
  const finishedMs = schedulerClockNow();
  task.state.inFlightRunId = '';
  task.state.lastResult = outcome;
  task.state.consecutiveFailures = outcome === 'failed' ? (Number(task.state.consecutiveFailures) || 0) + 1 : 0;
  let tripped = false;
  if (task.state.consecutiveFailures >= SCHEDULER_LIMITS.consecutiveFailuresTrip) {
    task.state.enabled = false;      // 熔断优先于重试(29 号文 §10)
    tripped = true;
  }
  // manual(「再跑一次」)不动 nextFireAt:它是计划之外的一个新 occurrence,不该把日程往后推。
  if (schedMode !== 'manual') {
    const nextMs = nextFireAt(task.schedule, finishedMs);
    task.state.nextFireAt = nextMs == null ? '' : new Date(nextMs).toISOString();
  }
  task.updatedAt = new Date(finishedMs).toISOString();
  await schedulerSaveTasks();
  await schedulerAppendFire({
    ...fireBase, phase: 'reconciled', outcome,
    ...(error ? { error } : {}),
    ...(sessionId ? { sessionId } : {}),
    durationMs: Math.max(0, finishedMs - startedMs),
    costTokens,
    ...(tripped ? { tripped: true } : {}),
  });
  schedulerEmitChanged(task.id, 'reconciled', outcome);
  if (tripped) {
    void schedulerNotify('onSchedulerNotice', {
      kind: 'tripped', taskId: task.id, title: task.title,
      occurrenceKey: occKey, mode: schedMode, at: new Date(finishedMs).toISOString(),
      consecutiveFailures: task.state.consecutiveFailures,
    });
  } else if (outcome === 'needs_you') {
    void schedulerNotify('onSchedulerNotice', {
      kind: 'needs_you', taskId: task.id, title: task.title,
      occurrenceKey: occKey, mode: schedMode, at: new Date(finishedMs).toISOString(), sessionId,
    });
  }
  return outcome;
}

// ── tick ────────────────────────────────────────────────────────────────────
// 全局并发 1:`ticking` 挡住重入,循环里的 await 让同一拍里到点的多条任务【串行】跑完 ——
// 第二条落 registered 的时候第一条一定已经 reconciled 了(§3.2 判据)。
async function schedulerTick() {
  if (schedulerRuntime.ticking) return;
  schedulerRuntime.ticking = true;
  const generation = schedulerRuntime.generation;
  try {
    // ① 启动恢复排的补跑(只跑一次:出队即消费)
    while (schedulerRuntime.lateQueue.length) {
      if (generation !== schedulerRuntime.generation) return;
      const queued = schedulerRuntime.lateQueue.shift();
      const task = schedulerRuntime.tasks.find(row => row.id === queued.taskId);
      if (!task || !task.state.enabled || task.state.inFlightRunId) continue;
      await schedulerFireOnce(task, 'late', queued.dueMs);
    }
    // ② 到点的任务。按 nextFireAt 升序 —— 同一拍里两条都到点时,先到的先跑。
    const now = schedulerClockNow();
    const due = schedulerRuntime.tasks
      .filter(task => task.state.enabled && !task.state.inFlightRunId && task.state.nextFireAt
        && Date.parse(task.state.nextFireAt) <= now)
      .sort((a, b) => Date.parse(a.state.nextFireAt) - Date.parse(b.state.nextFireAt));
    for (const task of due) {
      if (generation !== schedulerRuntime.generation) return;
      await schedulerFireOnce(task, 'ontime', Date.parse(task.state.nextFireAt));
    }
  } catch (e) {
    schedulerRuntime.lastError = String((e && e.message) || e).slice(0, 400);
    try { logEvent({ kind: 'scheduler_tick_error', detail: schedulerRuntime.lastError }); } catch { /* ignore */ }
  } finally {
    schedulerRuntime.ticking = false;
  }
}

// 红线⑤:**零任务不起 interval**。任何一次任务表变化之后都要重算一次这件事 ——
// 建第一条任务时把表从空变成非空,那一刻才该起;删掉最后一条时立刻停。
function schedulerEnsureTimer() {
  if (!schedulerRuntime.enabled || !schedulerRuntime.started) return;
  const wanted = schedulerRuntime.tasks.length > 0 || schedulerRuntime.lateQueue.length > 0;
  if (wanted && !schedulerRuntime.timer) {
    schedulerRuntime.timer = setInterval(() => { void schedulerTick(); }, schedulerTickMs());
    if (schedulerRuntime.timer && typeof schedulerRuntime.timer.unref === 'function') schedulerRuntime.timer.unref();
  } else if (!wanted && schedulerRuntime.timer) {
    clearInterval(schedulerRuntime.timer);
    schedulerRuntime.timer = null;
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────
// schedulerEnabledV1 !== true 时【立即返回且什么都不做】:不建目录、不读盘、不起 interval(红线⑤)。
async function startScheduler(schedConfig) {
  if (schedulerRuntime.started) return false;
  if (!schedulerEnabled(schedConfig)) { schedulerRuntime.enabled = false; return false; }
  schedulerRuntime.enabled = true;
  schedulerRuntime.started = true;
  schedulerRuntime.generation += 1;
  const rows = await schedulerLoad();
  await schedulerRecover(rows);
  schedulerEnsureTimer();
  // 起完就先跑一拍(不等第一个 30 s):补跑队列与「服务没开着的时候刚好到点」都该立刻见效。
  setImmediate(() => { void schedulerTick(); });
  try { logEvent({ kind: 'scheduler_started', tasks: schedulerRuntime.tasks.length, late: schedulerRuntime.lateQueue.length }); } catch { /* ignore */ }
  return true;
}
function stopScheduler() {
  schedulerRuntime.generation += 1;      // 在途 tick 看见代际变了就尽快退出
  if (schedulerRuntime.timer) { clearInterval(schedulerRuntime.timer); schedulerRuntime.timer = null; }
  schedulerRuntime.started = false;
}
// e2e 的观测面(不落盘、不改状态)。「零任务零 interval」这条红线就靠 timerActive 钉。
function schedulerRuntimeSnapshot() {
  return {
    enabled: schedulerRuntime.enabled,
    started: schedulerRuntime.started,
    timerActive: !!schedulerRuntime.timer,
    tickMs: schedulerTickMs(),
    taskCount: schedulerRuntime.tasks.length,
    fireSeq: schedulerRuntime.fireSeq,
    lateQueued: schedulerRuntime.lateQueue.length,
    firedTotal: schedulerRuntime.firedTotal,
    lastError: schedulerRuntime.lastError,
  };
}

// ── API(§3.3)───────────────────────────────────────────────────────────────
// 鉴权沿用 01b-route-auth.js 的表(六条一律 token;body-token 永远够不着写面 —— 29 号文 §10);
// 表是权威,handler 不另写一道自查(同 /api/steward/*)。
function schedulerPublicTask(schedTask, schedLocale) {
  const described = describeSchedule(schedTask.schedule, schedLocale);
  return {
    id: schedTask.id,
    title: schedTask.title,
    // K7 前端(rail-pocket / steward-drawer「接下来」/ steward-settings)读的就是 nextRunAt 与 enabled。
    // name 是它那份前向兼容读法的第二个候选键,一并给上,省得前端两处各写一个回落。
    name: schedTask.title,
    nextRunAt: schedTask.state.nextFireAt,
    enabled: schedTask.state.enabled,
    createdAt: schedTask.createdAt,
    updatedAt: schedTask.updatedAt,
    createdBy: schedTask.createdBy,
    revision: schedTask.revision,
    schedule: schedTask.schedule,
    payload: schedTask.payload,
    target: schedTask.target,
    autonomy: schedTask.autonomy,
    policy: schedTask.policy,
    state: schedTask.state,
    describeKey: described.key,
    describeParams: described.params,
  };
}
// fires 的多行(registered/dispatched/running/reconciled)是【同一次运行】的四段;对外按 runId 合成
// 一行「一次运行」。同 occurrence 的多次尝试是多个 runId,各占一行(executionGeneration 区分)。
function schedulerMergeRuns(schedRows, schedTaskId) {
  const byRun = new Map();
  for (const row of schedRows) {
    if (String(row.taskId || '') !== String(schedTaskId)) continue;
    const key = String(row.runId || '') || ('nore:' + String(row.seq));
    const entry = byRun.get(key) || { runId: String(row.runId || ''), firedAt: String(row.at || ''), phase: '', outcome: '' };
    entry.seq = Number(row.seq) || entry.seq || 0;
    entry.occurrenceKey = String(row.occurrenceKey || entry.occurrenceKey || '');
    entry.dueAt = String(row.dueAt || entry.dueAt || '');
    entry.mode = String(row.mode || entry.mode || '');
    entry.executionGeneration = Number(row.executionGeneration) || entry.executionGeneration || 0;
    entry.phase = String(row.phase || entry.phase || '');
    if (row.sessionId) entry.sessionId = String(row.sessionId);
    if (row.outcome) entry.outcome = String(row.outcome);
    if (row.error) entry.error = String(row.error);
    if (row.durationMs != null) entry.durationMs = Number(row.durationMs) || 0;
    if (row.costTokens != null) entry.costTokens = Number(row.costTokens) || 0;
    if (row.tripped) entry.tripped = true;
    byRun.set(key, entry);
  }
  return [...byRun.values()].sort((a, b) => (b.seq || 0) - (a.seq || 0));
}
function schedulerLocaleOf(req) {
  const raw = String((req && req.headers && req.headers['accept-language']) || '');
  return /^en/i.test(raw) ? 'en' : 'zh';
}

// 六条路由共用的前置:读配置 → 开关关就 409(路由清册不因开关变化,与 /api/steward/* 的
// steward.disabled 同款)→ 装载任务表。返回 locale;返回 '' 表示已经答过了(调用方直接 return)。
// **故意不在函数开头写 `if (!pathname.startsWith('/api/scheduler/')) return;` 这样的前缀早退守卫**:
// 路由清册的扫描器会把它认成一个判定点,于是清册里凭空多出一条「无鉴权首配」的裸前缀死路由
// (13r 的头注里记着同一条坑)。改成六个分支各调一次本函数,顺带也不让无关请求付一次 readConfig。
async function schedulerRouteGate(req, res) {
  const config = await readConfig();
  if (!schedulerEnabled(config)) {
    send(res, apiFailure('scheduler.disabled', {}, 'the scheduler is turned off (schedulerEnabledV1)', 409));
    return '';
  }
  await schedulerLoad();
  return schedulerLocaleOf(req);
}

async function handleSchedulerApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/scheduler/tasks') {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    return send(res, json({
      ok: true,
      nowMs: schedulerClockNow(),
      tasks: schedulerRuntime.tasks.map(task => schedulerPublicTask(task, locale)),
    }));
  }

  if (req.method === 'POST' && pathname === '/api/scheduler/tasks') {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    let body = {};
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('api.body_invalid', {}, 'invalid JSON body', 400)); }
    if (schedulerRuntime.tasks.length >= SCHEDULER_LIMITS.maxTasks) {
      return send(res, apiFailure('scheduler.capacity_exceeded', { max: SCHEDULER_LIMITS.maxTasks },
        'at most ' + SCHEDULER_LIMITS.maxTasks + ' scheduler tasks', 409));
    }
    // workdir 是服务端自有字段(127 波 2-ter S-b,见 06j ⑦ 段):新建时一律剥掉,调用方写不进来。
    const normalized = normalizeSchedulerTask({ ...body, id: '', revision: 0, workdir: '' }, schedulerClockNow());
    if (!normalized.ok) return send(res, apiFailure('scheduler.' + normalized.code, {}, normalized.message, 400));
    normalized.task.id = makeId('sch');
    schedulerRuntime.tasks.push(normalized.task);
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(normalized.task.id, 'created', '');
    return send(res, json({ ok: true, task: schedulerPublicTask(normalized.task, locale) }));
  }

  if ((req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH'))
      && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = decodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
    if (index < 0) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    let body = {};
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('api.body_invalid', {}, 'invalid JSON body', 400)); }
    const current = schedulerRuntime.tasks[index];
    // 部分更新:只认这五个顶层键,其余一律不动(id/createdAt/createdBy/revision 由服务端管)。
    // 127 波 2-ter:改档位就走这里 —— target 是整份替换(target.tier 随之生效或消失),不另开工具。
    // workdir 同属服务端自有(S-b):body 里带了也不认,永远取 current 那一份(显式写出来,不靠 ...current 的顺序)。
    const merged = {
      ...current,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.autonomy !== undefined ? { autonomy: body.autonomy } : {}),
      ...(body.policy !== undefined ? { policy: body.policy } : {}),
      state: { ...current.state, ...(body.enabled !== undefined ? { enabled: body.enabled !== false } : {}) },
      id: current.id,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      revision: current.revision,
      workdir: String(current.workdir || ''),
    };
    const normalized = normalizeSchedulerTask(merged, schedulerClockNow());
    if (!normalized.ok) return send(res, apiFailure('scheduler.' + normalized.code, {}, normalized.message, 400));
    normalized.task.revision = (Number(current.revision) || 0) + 1;
    // 计划没变时保住盘上的 nextFireAt(改个标题不该把下一次往后推);变了才用新算的那个。
    if (JSON.stringify(normalized.task.schedule) === JSON.stringify(current.schedule)) {
      normalized.task.state.nextFireAt = current.state.nextFireAt;
    }
    normalized.task.state.inFlightRunId = current.state.inFlightRunId;
    // 从熔断里被重新打开:连败计数清零,否则下一次失败立刻再熔断。
    if (normalized.task.state.enabled && !current.state.enabled) normalized.task.state.consecutiveFailures = 0;
    schedulerRuntime.tasks[index] = normalized.task;
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(id, 'updated', '');
    return send(res, json({ ok: true, task: schedulerPublicTask(normalized.task, locale) }));
  }

  if ((req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))
      && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = decodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
    if (index < 0) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    schedulerRuntime.tasks.splice(index, 1);
    // **删定义不删历史回执**(37 号文 §1):fires-v1.ndjson 一个字节都不动 —— 它是 append-only 的账,
    // 「这条任务当初真的跑过」是既成事实,不因为定义没了就该消失。
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(id, 'deleted', '');
    return send(res, json({ ok: true, id }));
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)\/run-now$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = decodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/run-now'.length));
    const task = schedulerRuntime.tasks.find(row => row.id === id);
    if (!task) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    if (task.state.inFlightRunId) {
      return send(res, apiFailure('scheduler.busy', { id }, 'this task is already running', 409));
    }
    if (schedulerRuntime.ticking) {
      return send(res, apiFailure('scheduler.busy', { id }, 'the scheduler is busy with another task (global concurrency is 1)', 409));
    }
    // 「再跑一次」是一个【新】 occurrence(mode:'manual'),不是对旧那次的重试(37 号文 §1)。
    // occurrenceKey = taskId@dueIso,而 dueIso 取「此刻」—— 同一毫秒里按两下(假时钟下更是必然,
    // 时钟是钉死的)会撞出同一个 key,那就变成「同一 occurrence 的第二次尝试」,与承诺投影的语义相反。
    // 往后挪到第一个没被用过的毫秒:生产上这一步恒是无操作,只有钉死时钟的 e2e 会走进循环。
    let manualDueMs = schedulerClockNow();
    while (schedulerRuntime.attempts.has(occurrenceKey(task.id, manualDueMs))) manualDueMs += 1;
    schedulerRuntime.ticking = true;
    let outcome = '';
    try { outcome = await schedulerFireOnce(task, 'manual', manualDueMs); }
    finally { schedulerRuntime.ticking = false; }
    return send(res, json({ ok: true, outcome, task: schedulerPublicTask(task, locale) }));
  }

  if (req.method === 'GET' && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)\/runs$/)) {
    if (!(await schedulerRouteGate(req, res))) return;
    const id = decodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/runs'.length));
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    // **先取原值再转数字**:`Number(query.get('limit'))` 在没带这个参数时是 Number(null) === 0,
    // 而 0 会被 Number.isFinite 认成「用户真给了一个数」,再钳进 [1,50] 就变成 limit=1 ——
    // 于是设置面「最近 5 次」永远只显示 1 条。同一个模具在 01c-runtime-flags 的 memoryLimit 头注里
    // 已经被记过一次(Number(null)=0 被静默解读成「上限为 0」);本件 F6/G3 又当场抓到一次。
    const rawLimit = query.get('limit');
    const wanted = rawLimit == null || rawLimit === '' ? NaN : Number(rawLimit);
    const limit = Number.isFinite(wanted) ? Math.min(SCHEDULER_RUNS_LIMIT_MAX, Math.max(1, Math.round(wanted))) : SCHEDULER_RUNS_LIMIT_DEFAULT;
    const rows = await schedulerReadFireRows();
    // 删掉定义之后这条仍然读得出来(回执不随定义走)—— 所以这里【不】先查 tasks 表。
    return send(res, json({ ok: true, taskId: id, runs: schedulerMergeRuns(rows, id).slice(0, limit) }));
  }
}
