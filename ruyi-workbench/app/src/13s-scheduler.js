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
// hunt2-P5:tick 里「迟到多少仍算准点」。生产 tick 30 s,再留出事件循环一时被占、NTP 小幅校时的余量;
// 超过它才是「错过」(机器睡眠/休眠唤醒、时钟大跳),交给 onMissed/graceMinutes 判。
const SCHEDULER_ONTIME_SLACK_MS = 5 * 60000;

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
// 回合超时(task.policy.timeoutMinutes,最小 1 分钟)。测试旗 WCW_SCHEDULER_TIMEOUT_MS 把它压到毫秒级(同上面几个旗:
// 只读 process.env,缺省即生产取值,不进 config、不进 UI、不落盘)。
function schedulerTurnTimeoutMs(schedTask) {
  const raw = Number(process.env.WCW_SCHEDULER_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 50) return Math.round(raw);
  return Math.max(1000, schedTask.policy.timeoutMinutes * 60000);
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
  ticking: false,       // tick 重入闸(防同一个定时器触发两次并发 tick,不再是「等全部到点任务跑完」的闸)
  tasks: [],
  fireSeq: 0,
  globalRuns: { date: '', count: 0 },
  lateQueue: [],        // [{ taskId, dueMs }] —— 启动恢复排的补跑,只排一次(29 号文 §4「只补一次」)
  // C18 已知债修复(见 schedulerDispatchFire 与 schedulerTick 头注):某条任务的回合还没收尾(在跑,
  // 或在 13n 仲裁器里排队/等锁)期间,它的 id 留在这张表里 —— 只活在本进程,tick 据此跳过它,
  // 不再靠「await 到它收尾才看下一条」来防重派单。与 task.state.inFlightRunId(落盘、跨重启认)
  // 双保险:后者在 schedulerFireOnce 的登记段【同步】写下,只覆盖「登记成功之后」那一段;
  // 这张表在【调用前】就写下,连「登记之前」的一小段窗口(比如撞上限的 skipped 分支)也一起挡住。
  inFlightTaskIds: new Set(),
  // 启动恢复【只认装载那一刻盘上就有的那些任务】。为什么需要这个集合:调度器起在 boot 探针段
  // (listen 之后 500 ms,见 13-http-router 那一行的理由),而六条 API 在 listen 那一刻就活了 ——
  // 用户/e2e 完全可能在这 500 ms 里建一条任务并把时钟拨过它。那条任务【不是「错过」的】:
  // 它的 nextFireAt 是刚刚按「现在」算出来的,本进程一直在跑,只是还没轮到第一拍。
  // 不区分的话它会被 missedOccurrence 认成错过、以 mode:'late' 补跑 —— 界面上就成了「补跑」,
  // 而事实是准时。(实测:scheduler.e2e 的 B3 当场红成「succeeded/late」。)
  loadedFromDisk: new Set(),
  // hunt2-P6:盘上归一化不过 / 没有 id / 超出 maxTasks 的行。不调度、不上 API,只在写盘时原样带回去 ——
  // 修前装载时跳过、下一次写盘就把它们永久删掉(注释写着「不静默改写用户的定义」,写盘却静默删了)。
  opaqueTasks: [],
  startDeferred: false, // hunt2-P6:startScheduler 撞上读不出来的任务表而没起来(路由闸装载成功后补起)
  // 启动那一刻 schedulerEnabledV1 关着(startScheduler 立即返回、什么都没做)。之后配置里把它打开 ——
  // 01 writeConfig 派的 'config.written'(设置页 / 管家改设置 / API)或路由闸读到开着(手改了 config.json)——
  // 就当场补起,不必重启。stopScheduler(进程收尾)清掉它,收尾之后不再被配置写入唤醒。
  awaitingEnable: false,
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
  // hunt2-P6:只有 ENOENT 才是「还没有任务表」。修前任何读失败(Windows 上杀软/备份软件短暂持锁的
  // EBUSY/EPERM、句柄耗尽)都答成 missing:true,调度器按空表装载 —— 下一次 schedulerSaveTasks 就把
  // 用户整张任务表冲成空的。瞬时错误先有界重试,仍失败回 unreadable:schedulerLoad 不置 loaded、不许写盘。
  for (let attempt = 0; ; attempt++) {
    try { text = await fsp.readFile(file, 'utf8'); break; }
    catch (e) {
      const code = String((e && e.code) || '');
      if (code === 'ENOENT') return { tasks: [], globalRuns: { date: '', count: 0 }, missing: true };
      if (!['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN'].includes(code) || attempt >= 4) {
        return { tasks: [], globalRuns: { date: '', count: 0 }, missing: false, unreadable: true, code: code || 'EREAD' };
      }
      await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
    }
  }
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
  // hunt2-P6:没装载成功(任务表存在却读不出来)就不许写 —— 此刻内存里的空表不是事实,写下去就是删用户的任务。
  if (!schedulerRuntime.loaded) {
    try { logEvent({ kind: 'scheduler_save_refused', reason: 'not_loaded' }); } catch { /* ignore */ }
    return Promise.resolve();
  }
  const payload = {
    schema: SCHEDULER_TASKS_SCHEMA,
    updatedAt: new Date(schedulerClockNow()).toISOString(),
    globalRuns: schedulerRuntime.globalRuns,
    // hunt2-P6:装载时归一化不过的行原样写回(见 schedulerLoad),不因为「这一版读不懂」就从盘上消失。
    tasks: [...schedulerRuntime.tasks, ...schedulerRuntime.opaqueTasks],
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
  if (file.unreadable) {
    // hunt2-P6:不置 loaded —— 路由闸据此答 503、写盘被拒;下一次路由请求会再试着装载。
    schedulerRuntime.lastError = 'tasks-v1.json 暂时读不出来(' + file.code + '),调度器未装载,任务表原样保留';
    try { logEvent({ kind: 'scheduler_tasks_unreadable', code: file.code }); } catch { /* ignore */ }
    return null;
  }
  const tasks = [];
  const opaque = [];
  for (const rawTask of file.tasks) {
    const normalized = normalizeSchedulerTask(rawTask, now);
    // 坏行 / 没有 id 的行 / 超出上限的行:不调度,但原样留着写回去(不静默改写用户的定义)。
    if (!normalized.ok || !normalized.task.id || tasks.length >= SCHEDULER_LIMITS.maxTasks) { opaque.push(rawTask); continue; }
    tasks.push(schedulerRestorePersistedState(normalized.task, rawTask));
  }
  schedulerRuntime.tasks = tasks;
  schedulerRuntime.opaqueTasks = opaque;
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

// 一个错过的时点按策略【不补】:记一行 reconciled/skipped(mode:'late')并通知。启动恢复与 tick(hunt2-P5)共用。
async function schedulerRecordMissedSkip(task, missed, now) {
  const reason = missed.withinGrace ? 'policy_skip' : 'grace_expired';
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
    error: reason,
  });
  void schedulerNotify('onSchedulerNotice', {
    kind: 'skipped', taskId: task.id, title: task.title,
    occurrenceKey: missed.occurrenceKey, mode: 'late', at: new Date(now).toISOString(),
    reason,
  });
  schedulerEmitChanged(task.id, 'reconciled', 'skipped');
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
      await schedulerRecordMissedSkip(task, missed, now);
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
// 权限档:【天花板 = 全局档,永不含 bypass】。任务没给(''),或给的档不在
// PERMISSION_MODES 白名单里,或给的是 bypass —— 一律回落全局默认档;给了就与全局档取更紧的那个。这一句是 06j 那半条校验
// (「不是 bypass 的非空字符串就留着」)的另一半:只有这里读得到 config。
// 安全修复(审计 D):修前「天花板」只挡了 bypass —— 任务档比全局档【宽】时照样生效(全局 plan、任务 auto
// → 定时回合按 auto 跑),全局是 bypass 而任务没给档时也原样拿到 bypass(与「永不含 bypass」相悖)。
// 现在按 06i 的全序(plan < default < acceptEdits < auto < bypass)取 min(任务档 || 全局档, 全局档),
// 结果若仍是 bypass(只可能来自全局档)一律落到 default。全局档本身不认识 → 按 default 算(fail-closed)。
function schedulerPermissionModeFor(schedTask, schedConfig) {
  const wanted0 = String((schedTask && schedTask.autonomy && schedTask.autonomy.permissionMode) || '');
  const globalRaw = String((schedConfig && schedConfig.permissionMode) || 'default');
  const globalMode = stewardPermissionRank(globalRaw) >= 0 ? globalRaw : 'default';
  const wanted = (wanted0 && wanted0 !== 'bypass' && wanted0 !== 'bypassPermissions' && PERMISSION_MODES.includes(wanted0)) ? wanted0 : globalMode;
  const narrowest = stewardPermissionRank(wanted) <= stewardPermissionRank(globalMode) ? wanted : globalMode;
  return (narrowest === 'bypass' || narrowest === 'bypassPermissions') ? 'default' : narrowest;
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
  // hunt3:从这里起到收尾之前,任何一步抛错(tasks-v1.json / fires-v1.ndjson 写不进去、readConfig、
  // createSession/saveSession ……)都【不许】越过收尾段直接冒出去。修前异常冒到 schedulerDispatchFire 只落一条
  // 日志:inFlightRunId 永远留在任务上(盘上也是)、没有 reconciled 行、nextFireAt 不推进 —— tick 从此永远跳过它,
  // run-now 永远 409,直到重启走崩溃残留恢复。现在一律按 failed 走同一段收尾(清 inFlightRunId、推进 nextFireAt、
  // 计入连败熔断、补 reconciled 行);收尾自己再写不进去,内存里的状态也已经先摆正了,下一拍照常能派。
  let outcome = 'succeeded';
  let error = '';
  let sessionId = '';
  let costTokens = 0;
  let targetBusy = false;   // 8a:目标线程正被别处的回合占着(SESSION_TURN_BUSY_ELSEWHERE),见下
  let targetBusySource = '';   // 占着它的回合是谁发起的(runSessionTurn 的 source:'http' / 'steward' / 'scheduler' / 'agent_wake')
  try {
    await schedulerSaveTasks();
    await schedulerAppendFire({ ...fireBase, phase: 'registered' });
    schedulerRuntime.firedTotal += 1;
    schedulerEmitChanged(task.id, 'registered', '');
    schedulerMaybeCrash('after-register');

    // ── ② 派单 ────────────────────────────────────────────────────────────────
    const config = await readConfig();

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
        // 第二轮工具走查(F15):指名的既有线程不存在(被删了 / 一开始就填错),或者就是管家自己的会话时,修前会落到下面
        // 「没有会话就新开一条」的分支 —— 悄悄开新线程、照样记 succeeded,用户以为它一直在原线程里接着做。
        // 目标是用户明确指的那一条,找不到就是这一次失败(进 failed / 连败计数,三次熔断停用,用户能看见),不替他改目标。
        if (!session || session.kind === 'steward' || session.id === STEWARD_SESSION_ID) {
          throw new Error(`target_session_not_found: ${String(task.target.sessionId).slice(0, 64)}`);
        }
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
      const askWaitMs = schedulerAskWaitMs(config);
      schedulerAskWaitSessions.set(sessionId, askWaitMs);
      let permissionDenied = 0;
      // 超时只计回合真正在干活的时间,【不含】卡在「等你批准」上的那一段。无人值守的批准窗口(schedulerAskWaitMinutes,
      // 缺省 30 分)与回合超时(timeoutMinutes,缺省 30 分,从回合开始算)同量级:修前回合头一个动作就是要批准的话,
      // 超时计时器与批准窗口同刻到期,超时那一支又排在 permissionDenied 之前判 —— needs_you 实际走不到,
      // 一条「只是没人来批」的任务被记成 failed/timeout,三次就熔断停用。现在待批的区间不记进超时的账:
      // 下面的计时器在到点时扣掉它再看还剩多少(到点时还有未决审批,当下那一段也按已等的时间扣)。
      // 只靠事件配对记账:requestNativePermission / CLI 桥都【无论怎么收场】(批准、拒绝、到时、停止)发 permission_decision。
      // 单段待批最多只扣 askCapMs(批准窗口 + 存档暂停的 TTL + 余量):万一哪条路径漏发了 decision,超时也不会被无限推迟。
      const turnTimeoutMs = schedulerTurnTimeoutMs(task);
      const askCapMs = askWaitMs + Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000) + 60000;
      const pendingAsks = new Set();
      let askClosedMs = 0;     // 已经结束的待批区间累计(每段按 askCapMs 封顶)
      let askOpenSince = 0;    // 当前这一段待批(可能有几条并发审批)从何时起,0 = 此刻没有未决审批
      const askSpentMs = () => askClosedMs + (askOpenSince ? Math.min(Date.now() - askOpenSince, askCapMs) : 0);
      const onEvent = evt => {
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'permission_request' && evt.requestId) {
          if (!pendingAsks.size) askOpenSince = Date.now();
          pendingAsks.add(String(evt.requestId));
        }
        if (evt.type === 'permission_decision' && evt.requestId && pendingAsks.delete(String(evt.requestId)) && !pendingAsks.size) {
          askClosedMs += Math.min(Date.now() - askOpenSince, askCapMs);
          askOpenSince = 0;
        }
        if (evt.type === 'permission_decision' && evt.behavior !== 'allow') permissionDenied += 1;
        if (evt.type === 'usage' && evt.usage) {
          const u = evt.usage;
          costTokens += (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
            + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        }
      };
      let timedOut = false;        // 真的因超时叫停了一个【活回合】
      let queueTimedOut = false;   // 回合在 13n 仲裁器里排队排过了超时、还没起跑就被撤出队列
      // 127 波 2-ter 登记的已知债(C18 code-review finding)的前一半早已修:回合在仲裁器里等锁/等并发位、
      // 或本身跑得慢时,下面这个 await 一直挂着只挡【这一条任务自己】—— 不再借道 schedulerRuntime.ticking
      // 把整个调度器一起拖住(见 schedulerDispatchFire / schedulerTick 头注:tick 不再 await 单条任务的
      // schedulerFireOnce)。后一半是超时计时器:stopSession 只认活回合(activeChildren),这条任务若此刻还【排队中】
      // (在 13n 仲裁器里等并发位 / 同工作文件夹写锁,没真的起回合),它拿不到活回合、什么都没停 —— 修前计时器是
      // 一次性的、照样先把 timedOut 置上:回合排到了照常跑完,记账却是 failed/timeout,与实际不符,还计入连败熔断。
      // 现在到点时:① 有活回合 → 停它(timedOut);② 没有活回合但排着队 → 经 StewardHooks.cancelQueuedTurn 把它撤出队列
      // (与 POST /api/stop 同一条路),按「这一次没跑成」记账(queueTimedOut,见下);③ 两样都没有 = 回合还在起跑前
      // (装载会话 / 引擎还没登记中止器)或刚好收尾 —— 不判超时,稍后再看,而不是留一个永远不会再触发的计时器。
      const turnStartedMs = Date.now();
      let timer = null;
      const armTimeout = delayMs => {
        timer = setTimeout(onTimeout, Math.max(1, Math.round(delayMs)));
        if (timer && typeof timer.unref === 'function') timer.unref();
      };
      const onTimeout = () => {
        timer = null;
        const leftMs = turnTimeoutMs - (Date.now() - turnStartedMs - askSpentMs());
        if (leftMs > 50) { armTimeout(leftMs); return; }   // 扣掉等批准的时间,还没到
        let stopped = false;
        try { stopped = stopSession(sessionId, 'scheduler_timeout') === true; } catch { /* 会话已经收尾 */ }
        if (stopped) { timedOut = true; return; }
        let cancelled = false;
        try { cancelled = typeof StewardHooks.cancelQueuedTurn === 'function' && StewardHooks.cancelQueuedTurn(sessionId) === true; } catch { /* 仲裁器不在 = 没有排队这回事 */ }
        if (cancelled) { queueTimedOut = true; return; }
        armTimeout(1000);
      };
      armTimeout(turnTimeoutMs);
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
        // 8a:目标线程(existing-session)此刻有一个别处发起的回合在跑 —— runSessionTurn 在起回合【之前】
        // 就回 409,一个字节都没动那条线程。这不是这条任务的失败:修前记成 failed、计入连败,用户在那条线程里
        // 连着聊三次就把任务熔断停用了。判据只认稳定错误码,不认文案。
        if (e && e.code === 'SESSION_TURN_BUSY_ELSEWHERE') { targetBusy = true; targetBusySource = String(e.turnSource || ''); }
      } finally {
        if (timer) { clearTimeout(timer); timer = null; }
        // 挡回我们的若是【另一个定时回合】(两条任务同刻指向同一条既有线程,见 10 runSessionTurn 的同源忙判定),
        // 表里那一格是它正在用的无人值守等待窗口(两边写进去的值相同)—— 在这里删掉,它后面的批准就退回 120 秒的默认窗口。
        if (!(targetBusy && targetBusySource === 'scheduler')) schedulerAskWaitSessions.delete(sessionId);
      }
      // 成败口径与 13k stewardRecordLaunchOutcome 逐字同源:取【内层】 result.result.ok ——
      // 外层 ok 只表示「这次调用完成了」,一条 HTTP 500 的回合外层仍然是 ok:true(116-4 实测)。
      const inner = (result && typeof result === 'object' && result.result && typeof result.result === 'object') ? result.result : null;
      // 没有内层 result 事件而 stopped:回合是在【排队时】被撤的(runSessionTurn 的 STEWARD_TURN_CANCELLED 分支只发 process/stopped,
      // 返回 ok:true、result:null)—— 它一个字都没跑,不能顺着外层 ok 记成 succeeded。
      const neverRan = !inner && !!(result && result.stopped);
      const turnOk = inner ? inner.ok === true : !!(result && result.ok && !neverRan);
      if (queueTimedOut) { outcome = 'skipped'; error = 'queue_timeout'; }
      else if (timedOut) { outcome = 'failed'; error = error || 'timeout'; }
      else if (!result || !turnOk) { outcome = 'failed'; error = error || (neverRan ? 'stopped' : String((inner && inner.errorClass) || 'turn_failed')); }
      else if (permissionDenied > 0) { outcome = 'needs_you'; error = 'permission_denied'; }
      else outcome = 'succeeded';
      if (targetBusy || queueTimedOut) {
        // 8a:按「这一次不跑」记 skipped(与撞上限同一个结果值,原因 target_busy),不计连败;日程推进到【下一个】
        // 时点(收尾段对非 manual 一律如此)—— 不选「下一拍重试」:用户在那条线程里一聊半小时,每 30 秒一拍的
        // 重试会在他每说完一句话的空档里立刻插进一个定时回合,而 cron 的下一个时点本来就是这条任务的节奏。
        // 登记时预扣的两份当日计数退回(什么都没跑,不该占今天的上限)。
        // 排队超时(queue_timeout)同一口径:回合在 13n 仲裁器里排了一整个超时都没轮到(并发位 / 同文件夹写锁 / 预算被别的线程占着),
        // 计时器已把它撤出队列、什么都没跑 —— 那是工作台忙,不是这条任务的错,不该计入连败(修前记 failed/timeout 还让回合排到后照跑)。
        outcome = 'skipped';
        error = targetBusy ? 'target_busy' : 'queue_timeout';
        if (task.state.runsToday && task.state.runsToday.date === day) task.state.runsToday = { date: day, count: Math.max(0, task.state.runsToday.count - 1) };
        if (schedulerRuntime.globalRuns.date === day) schedulerRuntime.globalRuns = { date: day, count: Math.max(0, schedulerRuntime.globalRuns.count - 1) };
      }
      // 第四源(13i 按 launchedBy:'steward' 收 done/failed):把身份与成败落到【会话头】上。
      // 为什么必须落盘:收件箱只读磁盘上的账,runSessionTurn 的返回值只活在这一个闭包里(116-4 的教训)。
      // 判据与 13k stewardRecordLaunchOutcome 【同口径】—— 取内层 result.result.ok、aborted 看内层、
      // errorClass 从内层拿;这里不调它而是就地写,是因为上面那三行已经把 inner/turnOk 算出来了,
      // 再调一遍等于把同一个判断算两次(两次的口径将来会各自漂)。走 updateSessionMeta 而不是
      // loadSession+saveSession:它会避开活回合的写竞态。旁路纪律:写失败只是少一条账,绝不反噬触发。
      // 8a:target_busy 时这条线程上根本没有定时回合,不往别人的回合头上记一笔「管家末回合」。
      // queue_timeout 同理:回合没跑过,线程上没有它的成败可记。
      if (!targetBusy && !queueTimedOut) void updateSessionMeta(sessionId, {
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
  } catch (e) {
    outcome = 'failed';
    error = 'dispatch_error: ' + String((e && (e.code || e.message)) || e).slice(0, 380);
    try { logEvent({ kind: 'scheduler_fire_error', taskId: task.id, runId, detail: String((e && e.message) || e).slice(0, 400) }); } catch { /* 观测不反噬 */ }
  }

  // ── ④ 收尾 ────────────────────────────────────────────────────────────────
  schedulerMaybeCrash('before-reconcile');
  const finishedMs = schedulerClockNow();
  task.state.inFlightRunId = '';
  task.state.lastResult = outcome;
  // skipped(撞上限 / 8a 目标线程忙)既不是失败也不是成功:连败计数原样不动(与上面撞上限那一支同口径)。
  if (outcome === 'failed') task.state.consecutiveFailures = (Number(task.state.consecutiveFailures) || 0) + 1;
  else if (outcome !== 'skipped') task.state.consecutiveFailures = 0;
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
// C18(code-review 已知债修复,127 波 2-ter 曾登记「等锁期间整个调度器停摆」、13s:509-512 头注 ——
// 见 schedulerFireOnce 里那一段):派单即返回,不等它收尾。旧写法在这里 `await schedulerFireOnce(...)`,
// 于是一条任务的回合只要在 13n 仲裁器里排队(并发位满 / 同 cwd 写锁 / 预算)或者本身跑得慢,
// 同一拍里排在它后面的其它到点任务【连派单都派不出去】—— 不是「跟着变慢」,是「压根没被尝试」。
// 现在 for/while 循环体只管调用 schedulerDispatchFire(不 await 它),真正的登记 / 派单 / 收尾仍在
// schedulerFireOnce 内部完成,只是不再拿一条任务的完成来做另一条任务能不能开始的闸门。
function schedulerDispatchFire(task, mode, dueMs) {
  schedulerRuntime.inFlightTaskIds.add(task.id);
  schedulerFireOnce(task, mode, dueMs)
    .catch(e => {
      schedulerRuntime.lastError = String((e && e.message) || e).slice(0, 400);
      try { logEvent({ kind: 'scheduler_tick_error', detail: schedulerRuntime.lastError, taskId: task.id }); } catch { /* ignore */ }
    })
    .then(() => { schedulerRuntime.inFlightTaskIds.delete(task.id); });
}
// 「立即运行」的共用口:HTTP 的 POST /:id/run-now 与管家的 steward_schedule_run_now(13t)走同一份。
// 闸只挡【这一条任务自己】:落盘的 task.state.inFlightRunId(登记成功之后)或进程内的 inFlightTaskIds(调用前就写下,
// 与 tick 的派单共用同一张表)。不看 ticking —— 别的任务在跑、tick 正在派单,都不是这一条不能手动跑一次的理由
// (hunt2-P10 修的是 HTTP 那一半;修前管家那一半仍拿 ticking 当全局并发 1 的闸:任何一条在跑就拒,
// 自己跑的时候还整段占着 ticking,把 tick 一起挡住)。
// 「再跑一次」是一个【新】 occurrence(mode:'manual'),不是对旧那次的重试(37 号文 §1)。
// occurrenceKey = taskId@dueIso,而 dueIso 取「此刻」—— 同一毫秒里按两下(假时钟下更是必然,时钟是钉死的)
// 会撞出同一个 key,那就变成「同一 occurrence 的第二次尝试」,与承诺投影的语义相反。往后挪到第一个没被用过的
// 毫秒:生产上这一步恒是无操作,只有钉死时钟的 e2e 会走进循环。
// 返回 { busy: true }(这一条正在跑,调用方各按自己的信封拒)或 { busy: false, outcome }。
function schedulerTaskBusy(task) {
  return !!(task && (task.state.inFlightRunId || schedulerRuntime.inFlightTaskIds.has(task.id)));
}
async function schedulerRunNow(task) {
  if (schedulerTaskBusy(task)) return { busy: true, outcome: '' };
  let manualDueMs = schedulerClockNow();
  while (schedulerRuntime.attempts.has(occurrenceKey(task.id, manualDueMs))) manualDueMs += 1;
  schedulerRuntime.inFlightTaskIds.add(task.id);
  try { return { busy: false, outcome: await schedulerFireOnce(task, 'manual', manualDueMs) }; }
  finally { schedulerRuntime.inFlightTaskIds.delete(task.id); }
}

// `ticking` 只挡「同一个定时器触发两次并发 tick」的重入 —— 不再是「等全部到点任务跑完」的闸,
// 派单全走 schedulerDispatchFire,tick 本体现在是一段纯同步的派单决策(见上)。
async function schedulerTick() {
  if (schedulerRuntime.ticking) return;
  schedulerRuntime.ticking = true;
  const generation = schedulerRuntime.generation;
  try {
    // hunt3:总开关是【活的】。startScheduler 只在启动时读一次 schedulerEnabledV1,修前用户在设置里把它关掉之后
    // interval 照跑、到点照派(「关了所有定时承诺一起停」只在重启后才兑现)。每一拍先重读配置(readConfig 走
    // 文件指纹缓存,一拍一次 stat),关着就这一拍什么都不做 —— 不派单、不动补跑队列、不写盘;interval 留着,
    // 用户再打开时下一拍就接着走,不必重启。已经派出去的那一次照常收尾(它的回合可能已经在跑)。
    const liveConfig = await readConfig().catch(() => null);
    if (liveConfig && !schedulerEnabled(liveConfig)) return;
    if (generation !== schedulerRuntime.generation) return;
    // ① 启动恢复排的补跑(只跑一次:出队即消费)
    while (schedulerRuntime.lateQueue.length) {
      if (generation !== schedulerRuntime.generation) return;
      const queued = schedulerRuntime.lateQueue.shift();
      const task = schedulerRuntime.tasks.find(row => row.id === queued.taskId);
      if (!task || !task.state.enabled || task.state.inFlightRunId || schedulerRuntime.inFlightTaskIds.has(task.id)) continue;
      schedulerDispatchFire(task, 'late', queued.dueMs);
    }
    // ② 到点的任务。按 nextFireAt 升序派单 —— 同一拍里两条都到点时,先到的先派单,但谁先【收尾】
    // 不再由派单顺序决定(哪条的回合先跑完,哪条先 reconciled)。
    const now = schedulerClockNow();
    const due = schedulerRuntime.tasks
      .filter(task => task.state.enabled && !task.state.inFlightRunId && !schedulerRuntime.inFlightTaskIds.has(task.id)
        && task.state.nextFireAt && Date.parse(task.state.nextFireAt) <= now)
      .sort((a, b) => Date.parse(a.state.nextFireAt) - Date.parse(b.state.nextFireAt));
    let skippedAny = false;
    for (const task of due) {
      if (generation !== schedulerRuntime.generation) return;
      // 上面记 skipped 那一段有 await,期间 run-now 可能已把这条派出去了:再核一次。
      if (task.state.inFlightRunId || schedulerRuntime.inFlightTaskIds.has(task.id)) continue;
      // hunt2-P5:进程一直活着、但机器睡过去/时钟跳过去的那一类「错过」,修前 tick 一律当准点跑
      // (onMissed:'skip' 与 graceMinutes 只在启动恢复里生效;实测晚 11 小时仍记 ontime)。
      // 迟到在 SCHEDULER_ONTIME_SLACK_MS 之内是 tick 粒度的正常抖动,照旧准点;超过它才按与启动恢复
      // 同一套判据(missedOccurrence):宽限内且 run-once-late → 以 late 补跑一次;否则记 skipped、推进。
      const missed = missedOccurrence(task, now);
      if (missed && missed.lateByMs > SCHEDULER_ONTIME_SLACK_MS) {
        if (missed.runLate) { schedulerDispatchFire(task, 'late', missed.dueMs); continue; }
        const nextMs = nextFireAt(task.schedule, now);
        task.state.nextFireAt = nextMs == null ? '' : new Date(nextMs).toISOString();
        await schedulerRecordMissedSkip(task, missed, now);
        skippedAny = true;
        continue;
      }
      schedulerDispatchFire(task, 'ontime', Date.parse(task.state.nextFireAt));
    }
    if (skippedAny) await schedulerSaveTasks();
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
  if (!schedulerEnabled(schedConfig)) { schedulerRuntime.enabled = false; schedulerRuntime.awaitingEnable = true; return false; }
  schedulerRuntime.awaitingEnable = false;
  schedulerRuntime.enabled = true;
  schedulerRuntime.started = true;
  schedulerRuntime.generation += 1;
  const rows = await schedulerLoad();
  if (!schedulerRuntime.loaded) {
    // hunt2-P6:任务表在却读不出来 —— 不恢复、不起 interval(恢复会写盘)。退回「未启动」,路由闸下次装载成功时再起。
    schedulerRuntime.started = false;
    schedulerRuntime.startDeferred = true;
    return false;
  }
  schedulerRuntime.startDeferred = false;
  await schedulerRecover(rows);
  schedulerEnsureTimer();
  // 起完就先跑一拍(不等第一个 30 s):补跑队列与「服务没开着的时候刚好到点」都该立刻见效。
  setImmediate(() => { void schedulerTick(); });
  try { logEvent({ kind: 'scheduler_started', tasks: schedulerRuntime.tasks.length, late: schedulerRuntime.lateQueue.length }); } catch { /* ignore */ }
  return true;
}
function stopScheduler() {
  schedulerRuntime.awaitingEnable = false;
  schedulerRuntime.generation += 1;      // 在途 tick 看见代际变了就尽快退出
  if (schedulerRuntime.timer) { clearInterval(schedulerRuntime.timer); schedulerRuntime.timer = null; }
  schedulerRuntime.started = false;
}
// 启动时关着、之后被打开:听 01 writeConfig 派的 'config.written'(只带开关位)。关着的那段时间这里什么都不做 ——
// 不起 interval、不建目录、不读盘(红线⑤原样成立);打开那一刻走的就是启动那一条 startScheduler(装载、恢复、
// 有任务才起 interval、先跑一拍)。已经起过的调度器不归这里管:运行中关掉/再打开由 tick 每拍重读配置处理。
// 装在模块加载期,进程生命周期内不卸(同 13i / 13r 的订阅纪律);订阅者只排一个异步启动,不回流到写路径。
RUYI_EVENTS.subscribe((name, payload) => {
  if (name !== 'config.written') return;
  if (!schedulerRuntime.awaitingEnable || schedulerRuntime.started) return;
  if (!(payload && payload.schedulerEnabledV1 === true)) return;
  void startScheduler({ schedulerEnabledV1: true }).catch(() => {});
});

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
  if (!schedulerRuntime.loaded) {
    send(res, apiFailure('scheduler.unavailable', {}, 'the scheduler task table exists but could not be read; nothing was changed', 503));
    return '';
  }
  // hunt2-P6:启动那一刻读失败而没起来的调度器,在这里装载成功后补起(startScheduler 自己幂等)。
  // 启动时关着、之后开着(配置被手改、没经 writeConfig 那一声)的同样在这里补起。
  if ((schedulerRuntime.startDeferred || schedulerRuntime.awaitingEnable) && !schedulerRuntime.started) await startScheduler(config);
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
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
    if (index < 0) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    let body = {};
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('api.body_invalid', {}, 'invalid JSON body', 400)); }
    // 读 body 期间表可能变过(并发 DELETE):按 id 重新找,不拿旧下标。
    const current = schedulerRuntime.tasks.find(task => task.id === id);
    if (!current) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
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
    // 例外:从暂停(含熔断停用)里被重新打开 —— 暂停期间 tick 不碰这条任务,盘上的 nextFireAt 还停在暂停那一刻的
    // 旧时点上;保住它的话,恢复后第一拍就把暂停期间的时点当「错过」补跑一次(或记一条没人错过的 skipped)。
    // 此时用 normalizeSchedulerTask 刚按「此刻」算好的那个(与 13t schedulerToolSetEnabled 同口径)。
    const resumedFromPause = normalized.task.state.enabled && !current.state.enabled;
    if (!resumedFromPause && JSON.stringify(normalized.task.schedule) === JSON.stringify(current.schedule)) {
      normalized.task.state.nextFireAt = current.state.nextFireAt;
    }
    normalized.task.state.inFlightRunId = current.state.inFlightRunId;
    // 从熔断里被重新打开:连败计数清零,否则下一次失败立刻再熔断。
    if (normalized.task.state.enabled && !current.state.enabled) normalized.task.state.consecutiveFailures = 0;
    // hunt2-P1:【原地】换内容,不换对象。在飞的 schedulerFireOnce 攥着的就是 current 这个对象 —— 修前这里
    // 换成新对象,在飞那一次收尾时把 inFlightRunId 清在已经不在表里的旧对象上,表里的新对象永远带着一个
    // 不会被清的 inFlightRunId(run-now 永远 409、tick 永远跳过,落盘后重启还会被当成崩溃残留)。
    // 在飞那一次此后读 task.state 拿到的是这里的新 state(已带着 inFlightRunId),收尾照常清掉它。
    for (const key of Object.keys(current)) if (!Object.prototype.hasOwnProperty.call(normalized.task, key)) delete current[key];
    Object.assign(current, normalized.task);
    await schedulerSaveTasks();
    schedulerEnsureTimer();
    schedulerEmitChanged(id, 'updated', '');
    return send(res, json({ ok: true, task: schedulerPublicTask(current, locale) }));
  }

  if ((req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))
      && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)$/)) {
    const locale = await schedulerRouteGate(req, res); if (!locale) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
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
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/run-now'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
    const task = schedulerRuntime.tasks.find(row => row.id === id);
    if (!task) return send(res, apiFailure('scheduler.not_found', { id }, 'no such scheduler task', 404));
    // hunt2-P10:修前这里整段拿着 ticking(tick 重入闸),手动那一次的回合跑多久,其它任务就多久派不出单
    // (tick 一进来就 return)。现在只挡【这一条任务】—— 闸与新 occurrence 的取法都在 schedulerRunNow(与管家工具共用)。
    const ran = await schedulerRunNow(task);
    if (ran.busy) return send(res, apiFailure('scheduler.busy', { id }, 'this task is already running', 409));
    return send(res, json({ ok: true, outcome: ran.outcome, task: schedulerPublicTask(task, locale) }));
  }

  if (req.method === 'GET' && pathname.match(/^\/api\/scheduler\/tasks\/([^/]+)\/runs$/)) {
    if (!(await schedulerRouteGate(req, res))) return;
    const id = safeDecodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length, pathname.length - '/runs'.length));
    if (id === null) return send(res, apiFailure('scheduler.not_found', {}, 'no such scheduler task', 404));   // 坏编码(%zz):不是任何任务的 id,不再 URIError 500
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
