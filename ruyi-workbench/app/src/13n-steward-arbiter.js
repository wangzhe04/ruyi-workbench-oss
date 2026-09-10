// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家的线程间仲裁器(116h)。
//
// 落点(transport 层,manifest 中位于 13m-steward-runner-base.js 之后、13o-steward-runner-prompt.js 之前)。
// T2 拆分:原 13h-steward-runner.js 已 2522 行 —— 比 T1 拆之前的 13g 还长,而 31 号文七轴的
// 回合层改动(污染打标、代答/代批、通知)全要往它里面加。按「谁被谁引用」把它拆成六个
// 文件,拼接顺序即依赖方向,零新增前向边:
//   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
//     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
//     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
//   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
//     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
//   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
//     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
//   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
//     熔断、收件箱消息装配、输入区预判归一;
//   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
//     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
//   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
//     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
//     上面五个文件里的实现,排在后面才是后向边)。
// 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
//
// 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
// (00/01/02/04/06b/06i/08/09/10/13e/13g 族 …),全部后向边;它自己的符号只被排在它之后的
// 管家运行器族文件与 14-main.js 的 e2e 导出面引用,同样是后向边。
// ============================================================================
// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「多线程看板与注意力预算」;用户 2026-09-03 拍板
// 「同时最多 5 条、设置可调」):线程间仲裁。
//
// 要解决的是三件事,不是一件:
//   ① 并发上限 —— 六条线程同时开跑会把端点打爆、把钱烧光,也让用户根本看不过来;
//   ② 同一个工作文件夹的写互斥 —— 两条线程同时改同一棵目录树,后果是谁也说不清的乱改;
//   ③ 可解释的排队 —— 排队本身不是问题,「不知道在等什么」才是。每条等待线程只给一个原因
//      (等你 > 等锁 > 等预算 > 等并发位),UI 与管家原话引用同一句。
//
// 为什么不新建一套系统:06g-resource-leases.js 已经有「租约 + 冲突 + 等待者 + 阻塞者」这套语义,
// 只是它的粒度是【子代理节点与工具调用】。本切片把同一套语义搬到【回合】这一粒度,并且【复用它的
// 事件形状】—— 等待/放行/释放一律走既有的 `agent_resource`(state: waiting|acquired|released,
// resources: [...], blockers: [...]),资源名取 `steward:slot` / `cwd-write:<hash>` / `steward:budget`。
// 于是 112c 的状态条「等待资源：X,被 Y 占着」原样可用,progress-events 的事件枚举一个都不用加。
//
// 边界(§3.4 红线):
//   · 仲裁只在 stewardEnabledV1 === true 时生效。关时 10 的回合入口根本不调 acquireTurnSlot,
//     runSessionTurn 的路径逐字节走原路(session-turn-core / budget-guard / multi-session-parallel
//     等既有件即为证明);
//   · 管家会话自己不受并发上限约束 —— 它不是线程,是那个替你看着线程的人;
//   · 仲裁只管【回合级】的写锁与并发位,不碰 nativeToolGate,也不改子代理内部 06g 租约的任何语义;
//   · 有待决的会话回合不占并发位、不入队,直接放行 —— 那种回合本来就是用户在答复,把它排队等于
//     让「等你」的线程再等一次别人。
//
// 状态全在内存(进程重启即空):running/queue 是「此刻谁在跑、谁在等」的运行时事实,不是可重建的
// 持久面,故 durable-state-inventory 无新面。
// ════════════════════════════════════════════════════════════════════════════

// 饥饿避免的等待阈值 = max(60s, 最近若干回合平均时长 × 3)。WCW_STEWARD_ARBITER_STARVE_MS 是测试
// 接缝(照 06g 的 WCW_RESOURCE_LEASE_TIMEOUT_MS 一手法):设了就【整个覆盖】这个阈值(连平均时长那一项
// 一起),因为 e2e 里的回合本来就慢,只压低下限根本压不动 max();显式给 0 也认(0 = 立即提首)。
const STEWARD_ARBITER_STARVE_MIN_MS = 60000;
const STEWARD_ARBITER_STARVE_OVERRIDE_MS = (() => {
  const raw = process.env.WCW_STEWARD_ARBITER_STARVE_MS;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
})();
const STEWARD_ARBITER_STARVE_FACTOR = 3;
const STEWARD_ARBITER_DURATION_SAMPLES = 20;   // 平均回合时长的样本数
const STEWARD_ARBITER_COST_CACHE_MS = 2000;    // 当日费用记账缓存(配置【不缓存】,费用台账缓存 2 秒)
const STEWARD_ARBITER_QUEUE_MAX = 500;         // 队列硬顶:超出宁可放行也不无限堆积(排队不是背压手段)

const stewardArbiter = {
  running: new Map(),      // token -> { token, sessionId, title, cwdKey, startedAt }
  // 116-3 P2-15:「有待决的回合不占并发位、不入 running」这条刻意设计的口子,实际影响比 §11.6 的
  // 措辞更宽 —— 那个 bypass 判定发生在 stewardArbiterBlocked(内含同 cwd 锁检查)【之前】,所以一条
  // 有待决的线程可以和【正在写同一个目录、持锁运行中】的另一条线程正面撞上,不只是排队顺序上的不讲究。
  // 语义不改(它确实不该等 —— 用户正在答复它),但两个写者至少要【彼此可见】:登记在这张单独的表里,
  // 并进仲裁器读模型的 pendingWriters,撞上时给回合的事件流发一条 agent_resource 提示。
  // 刻意【不】进 running:那会让它开始占并发位、开始挡别人,与 116h 的设计相反(e2e ④ 也钉着这条)。
  pendingRuns: new Map(),  // token -> { token, sessionId, title, cwdKey, startedAt }
  queue: [],               // 先到先得;插队与饥饿提升 = 摘出来 unshift 到队首(不排序,不打分)
  turns: [],               // 每次放行的时刻(ms),只留 24 小时 —— hour 口径从这一份数据算
  durations: [],           // 最近若干个回合的实际时长(ms),只喂饥饿阈值
  seq: 0,
  draining: false,
  drainAgain: false,
  costCache: { at: 0, value: 0 },
  budgetNotified: new Map(), // sessionId -> 上次落 budget 通知的小时桶(同一条线程一小时最多提醒一次)
};

// 工作文件夹的锁键:规范化成绝对路径,Windows 折大小写,再取 sha1 前 12 位。用哈希而不是原路径是
// 因为这个字符串会作为 `cwd-write:<hash>` 进事件流与看板 —— 路径可能很长也可能含用户名。
function stewardArbiterCwdKey(cwd) {
  const raw = String(cwd == null ? '' : cwd).trim();
  if (!raw) return 'nocwd';
  let abs = raw;
  try { abs = path.resolve(raw); } catch { abs = raw; }
  // 116-3 P1-11:哈希前先 realpath。两个会话的 cwd 通过不同的符号链接 / Windows 目录联接(junction)
  // 指向同一个真实目录时,不归一就会算出两个不同的锁键,写互斥完全不生效 —— 同一棵目录树真的会被
  // 两条线程并发改。同步版是刻意的:锁键要在 entry 构造时(同步段内)就定下来,不能为它引入一次 await
  // (那正是 P0-5 那条 TOCTOU 的来源)。目录还没建出来 / 没权限就退回 resolve 后的路径。
  try { abs = (fs.realpathSync.native || fs.realpathSync)(abs); } catch { /* ENOENT / EPERM:用 resolve 结果 */ }
  const folded = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return crypto.createHash('sha1').update(folded).digest('hex').slice(0, 12);
}

function stewardArbiterMaxParallel(config) {
  const n = Number(config && config.stewardMaxParallelThreads);
  return Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : 5;
}

// 资源名(既有 agent_resource 事件的 resources 字段)。三种等待各有自己的资源名,让 112c 状态条
// 的「等待资源：X」直接可读。needs_you 不走这里 —— 那种回合根本不排队。
function stewardArbiterResourceOf(wait) {
  if (wait && wait.lock) return `cwd-write:${wait.lock.cwdKey}`;
  if (wait && wait.budget) return 'steward:budget';
  return 'steward:slot';
}
// 等待原因的「有没有变」签名:变了才重发一条 waiting 事件(ahead 递减也算变 —— 用户要看见队伍在动)。
function stewardArbiterWaitSignature(wait) {
  if (wait && wait.lock) return `lock:${wait.lock.sessionId}`;
  if (wait && wait.budget) return `budget:${wait.budget.axis}`;
  if (wait && wait.slot) return `slot:${Math.max(0, Number(wait.slot.ahead) || 0)}`;
  return '';
}

function stewardArbiterEmit(entry, state, resource, blockers) {
  if (!entry || typeof entry.onEvent !== 'function') return;
  const payload = { type: 'agent_resource', state, resources: [String(resource || '')] };
  if (Array.isArray(blockers) && blockers.length) payload.blockers = blockers.map(String);
  try { entry.onEvent(payload); } catch { /* sink 已断,等待照常 */ }
}

// 队列里排在 entry 前面还有几条(cancelled 的不算)。entry 不在队列里(刚来的新条目)时 = 全队长度。
function stewardArbiterAhead(entry) {
  let ahead = 0;
  for (const row of stewardArbiter.queue) {
    if (row === entry) return ahead;
    if (!row.cancelled) ahead += 1;
  }
  return ahead;
}

// 当日全部线程的花费(USD)。取 usage 台账当日合计 —— 与 13e/13g/13h 同一条「套餐制名义金额不进真实
// 费用」的口径。台账可能很长,故 2 秒记账缓存;配置【不在这里缓存】(上限改动要即时生效)。
async function stewardArbiterDayCost() {
  const now = Date.now();
  if (now - stewardArbiter.costCache.at < STEWARD_ARBITER_COST_CACHE_MS) return stewardArbiter.costCache.value;
  const today = usageDayKey(now);
  let cost = 0;
  for (const row of await readUsageRows(0).catch(() => [])) {
    if (!row || usageDayKey(Date.parse(row.ts)) !== today) continue;
    if (row.costTrusted === false) continue;
    const value = Number(row.cost);
    if (Number.isFinite(value)) cost += value;
  }
  const rounded = Math.round(cost * 1e6) / 1e6;
  stewardArbiter.costCache = { at: now, value: rounded };
  return rounded;
}

// 全局预算闸:小时回合数(滑动窗口,计【全部线程】的回合;管家自己的回合走 13h 另一套熔断,不进这里)
// 与当日费用。触顶不是拒绝,是排队 —— 用户把上限调高,下一次唤醒就放行。
async function stewardArbiterBudget(config) {
  const now = Date.now();
  stewardArbiter.turns = stewardArbiter.turns.filter(ts => ts > now - STEWARD_TURN_DAY_MS);
  const maxTurns = Math.max(0, Math.round(Number(config && config.stewardGlobalMaxTurnsPerHour) || 0));
  if (maxTurns > 0) {
    const spent = stewardArbiter.turns.filter(ts => ts > now - STEWARD_TURN_WINDOW_MS).length;
    if (spent >= maxTurns) return { axis: 'turns_per_hour', spent, limit: maxTurns };
  }
  const maxCost = Number(config && config.stewardGlobalMaxCostPerDay);
  if (Number.isFinite(maxCost) && maxCost > 0) {
    const spent = await stewardArbiterDayCost();
    if (spent >= maxCost) return { axis: 'cost_per_day', spent, limit: maxCost };
  }
  return null;
}

// 这条线程现在被什么挡着 —— 返回 06i waitReasonFor 认的 ctx 形状,或 null(可以跑了)。
// 判定顺序即优先级(§3.1 116h「原因单一性」):锁 > 预算 > 并发位。needs_you 在更上游就短路了。
// ② 同一个工作文件夹的写互斥(纯同步)。**本切片一律按「写」处理**:一个回合会不会写文件在开始时
// 无法预知(模型还没说话),按只读乐观放行的代价是两条线程真的一起改同一棵树。只读回合的识别与放宽
// 留后续波。抽成独立函数是 116-3 P1-12 要的:队列溢出的逃生舱也要单独问它一次(见 stewardAcquireTurnSlot)。
function stewardArbiterCwdLock(entry) {
  for (const run of stewardArbiter.running.values()) {
    if (run.sessionId === entry.sessionId) continue;   // 同一条线程的两个回合由既有 supersede 语义管
    if (run.cwdKey !== entry.cwdKey) continue;
    return { sessionId: run.sessionId, title: run.title, cwdKey: run.cwdKey };
  }
  // 队列里排在它【前面】的同 cwd 条目也算锁:否则后来者会在先到者之前抢到那把锁(FIFO 公平性)。
  for (const row of stewardArbiter.queue) {
    if (row === entry) break;
    if (row.cancelled || row.sessionId === entry.sessionId) continue;
    if (row.cwdKey === entry.cwdKey) return { sessionId: row.sessionId, title: row.title, cwdKey: row.cwdKey };
  }
  return null;
}
async function stewardArbiterBlocked(entry, config) {
  const lock = stewardArbiterCwdLock(entry);
  if (lock) return { lock };
  // ③ 全局预算。
  const budget = await stewardArbiterBudget(config);
  if (budget) return { budget };
  // ④ 并发位。
  if (stewardArbiter.running.size >= stewardArbiterMaxParallel(config)) return { slot: { ahead: stewardArbiterAhead(entry) } };
  return null;
}

// 触顶时给收件箱一条 budget 事件。有 mission 的会话走 116-2b 已有的写入端(Mission Change Ledger 的
// budget_tripped,116b 的 budget 类就认它);bumpMissionChangeSeq 对【无 mission】的会话是静默 no-op
// (116-2b 已登记为待办),那种线程只留下面这条审计 + 上面那条 agent_resource 事件 —— 本切片不为它
// 新造第三条通路。turnSeq 传负的小时桶:既有 budget_guard 的去重表按真实 turnSeq(≥0)记,负数不会
// 与它撞车,又能让「同一条线程隔一小时再触顶」重新落一条。
function stewardArbiterRecordBudget(entry) {
  const budget = entry && entry.wait && entry.wait.budget;
  if (!budget) return;
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  if (stewardArbiter.budgetNotified.get(entry.sessionId) === bucket) return;
  stewardArbiter.budgetNotified.set(entry.sessionId, bucket);
  if (stewardArbiter.budgetNotified.size > 500) {
    for (const [key] of stewardArbiter.budgetNotified) { stewardArbiter.budgetNotified.delete(key); if (stewardArbiter.budgetNotified.size <= 400) break; }
  }
  try {
    recordMissionBudgetTrippedChange(entry.sessionId, {
      axis: 'steward_' + budget.axis, spent: budget.spent, budget: budget.limit, turnSeq: -bucket,
    });
  } catch { /* 账本不可写不该拖住排队 */ }
  try { logEvent({ kind: 'steward_arbiter_budget', sessionId: entry.sessionId, axis: budget.axis, spent: budget.spent, limit: budget.limit }); } catch { /* ignore */ }
}

// 把新的等待原因写进条目并(变了才)发一条 waiting 事件。
function stewardArbiterSetWait(entry, wait) {
  entry.wait = wait;
  const signature = stewardArbiterWaitSignature(wait);
  if (signature === entry.waitSignature) return;
  entry.waitSignature = signature;
  const resource = stewardArbiterResourceOf(wait);
  entry.lastResource = resource;
  const blockers = wait && wait.lock ? [wait.lock.title || wait.lock.sessionId] : [];
  stewardArbiterEmit(entry, 'waiting', resource, blockers);
  if (wait && wait.budget) stewardArbiterRecordBudget(entry);
}

// 放行:登记并发位、记一笔回合时刻,返回带 release 的凭据。release 幂等,回合的 finally 无条件调它。
function stewardArbiterGrant(entry) {
  const token = `slot_${++stewardArbiter.seq}`;
  const startedAt = Date.now();
  stewardArbiter.running.set(token, { token, sessionId: entry.sessionId, title: entry.title, cwdKey: entry.cwdKey, startedAt });
  stewardArbiter.turns.push(startedAt);
  // 只有【真的等过】的条目才发 acquired/released:没等过的回合在事件流里凭空多两帧,对用户是噪音,
  // 对既有壳是白白多一次重渲染。等过的条目必须发 —— 状态条要靠它把「等待资源」那一行清掉。
  if (entry.waited) stewardArbiterEmit(entry, 'acquired', entry.lastResource || 'steward:slot');
  let released = false;
  return {
    granted: true,
    release: () => {
      if (released) return;
      released = true;
      if (stewardArbiter.running.delete(token)) {
        stewardArbiter.durations.push(Math.max(0, Date.now() - startedAt));
        while (stewardArbiter.durations.length > STEWARD_ARBITER_DURATION_SAMPLES) stewardArbiter.durations.shift();
      }
      if (entry.waited) stewardArbiterEmit(entry, 'released', entry.lastResource || 'steward:slot');
      stewardArbiterScheduleDrain();
    },
  };
}

// 116-3 P2-15:待决豁免的「放行凭据」。与 stewardArbiterGrant 的区别只有两条:登记进 pendingRuns
// 而不是 running(不占并发位、不挡别人),以及只在真的与同 cwd 的活跃写者撞上时才发一条事件。
function stewardArbiterGrantPending(info) {
  const token = `pend_${++stewardArbiter.seq}`;
  const row = { token, sessionId: info.sessionId, title: info.title, cwdKey: info.cwdKey, startedAt: Date.now() };
  stewardArbiter.pendingRuns.set(token, row);
  const rivals = [];
  for (const run of stewardArbiter.running.values()) {
    if (run.sessionId === row.sessionId || run.cwdKey !== row.cwdKey) continue;
    rivals.push(run.title || run.sessionId);
  }
  if (rivals.length && typeof info.onEvent === 'function') {
    // state:'acquired' 而不是 'waiting':它没有在等谁,只是与别人同时在写同一个文件夹 —— 事件流里
    // 说错状态比不说更糟(用户会以为它卡住了)。
    stewardArbiterEmit({ onEvent: info.onEvent }, 'acquired', `cwd-write:${row.cwdKey}`, rivals);
  }
  let released = false;
  return {
    granted: true,
    release: () => {
      if (released) return;
      released = true;
      stewardArbiter.pendingRuns.delete(token);
    },
  };
}

function stewardArbiterDetach(entry) {
  if (entry && entry.signal && entry.onAbort) {
    try { entry.signal.removeEventListener('abort', entry.onAbort); } catch { /* 无 EventTarget */ }
    entry.onAbort = null;
  }
}

// 出队并把等待中的回合判为「没跑成」。调用方(10 的回合入口)据此走停止收尾,不是错误收尾。
function stewardArbiterCancel(entry, reason) {
  if (!entry || entry.cancelled) return false;
  entry.cancelled = true;
  const i = stewardArbiter.queue.indexOf(entry);
  if (i >= 0) stewardArbiter.queue.splice(i, 1);
  stewardArbiterDetach(entry);
  if (entry.waited) stewardArbiterEmit(entry, 'released', entry.lastResource || 'steward:slot');
  if (typeof entry.resolve === 'function') { const resolve = entry.resolve; entry.resolve = null; resolve({ granted: false, reason: String(reason || 'cancelled') }); }
  stewardArbiterScheduleDrain();
  return true;
}

// /api/stop 的接线:被停的会话若还在排队,把它出队(既有 stopSession 只认活回合,排队中的回合它看不见)。
function stewardCancelQueuedTurn(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return false;
  let hit = false;
  for (const entry of [...stewardArbiter.queue]) {
    if (entry.sessionId !== sid) continue;
    if (stewardArbiterCancel(entry, 'stopped')) hit = true;
  }
  return hit;
}

function stewardArbiterScheduleDrain() {
  if (stewardArbiter.draining) { stewardArbiter.drainAgain = true; return; }
  stewardArbiter.draining = true;
  Promise.resolve()
    .then(() => stewardArbiterDrain())
    .catch(() => { /* 唤醒失败不该让队列永久卡死:下一次释放会再唤醒 */ })
    .then(() => {
      stewardArbiter.draining = false;
      if (stewardArbiter.drainAgain) { stewardArbiter.drainAgain = false; stewardArbiterScheduleDrain(); }
    });
}

function stewardArbiterStarveThresholdMs() {
  if (STEWARD_ARBITER_STARVE_OVERRIDE_MS != null) return STEWARD_ARBITER_STARVE_OVERRIDE_MS;
  const samples = stewardArbiter.durations;
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  return Math.max(STEWARD_ARBITER_STARVE_MIN_MS, Math.round(avg * STEWARD_ARBITER_STARVE_FACTOR));
}

// 队首那一段「已经被饥饿保护提上来」的条目有多长。插队只能插到这一段【之后】——否则「提一次」
// 等于没提:被提上来的条目会被下一个插队者立刻反超,然后因为 starvationBumped 已经是 true 而再也
// 得不到第二次保护,饿死得比没有饥饿避免时还彻底。
function stewardArbiterStarvedHead() {
  let i = 0;
  while (i < stewardArbiter.queue.length && stewardArbiter.queue[i].starvationBumped === true) i += 1;
  return i;
}

// 饥饿避免:等太久的条目提到队首【一次】。只提一次是关键 —— 「饿了就提」会退化成又一轮插队循环,
// 让后来的条目永远排在被反复提升的那几条后面。多条同时超时按它们原来的先后顺序依次上去。
function stewardArbiterStarvationBump(now) {
  const threshold = stewardArbiterStarveThresholdMs();
  for (const entry of [...stewardArbiter.queue]) {
    if (entry.cancelled || entry.starvationBumped) continue;
    if (now - entry.enqueuedAt < threshold) continue;
    entry.starvationBumped = true;
    const i = stewardArbiter.queue.indexOf(entry);
    const head = stewardArbiterStarvedHead();
    if (i > head) { stewardArbiter.queue.splice(i, 1); stewardArbiter.queue.splice(head, 0, entry); }
  }
}

async function stewardArbiterDrain() {
  if (!stewardArbiter.queue.length) return;
  // 上限改动即时生效(§8.10「点开即改,改完立即生效,不需重启」):每次唤醒【重新读配置】,绝不缓存。
  const config = await readConfig().catch(() => null);
  // 开关在排队期间被关掉:全部放行(仲裁不生效时不该有人还被它挡着)。
  if (!config || config.stewardEnabledV1 !== true) {
    for (const entry of [...stewardArbiter.queue]) {
      const i = stewardArbiter.queue.indexOf(entry);
      if (i >= 0) stewardArbiter.queue.splice(i, 1);
      stewardArbiterDetach(entry);
      if (typeof entry.resolve === 'function') { const resolve = entry.resolve; entry.resolve = null; resolve(stewardArbiterGrant(entry)); }
    }
    return;
  }
  stewardArbiterStarvationBump(Date.now());
  for (const entry of [...stewardArbiter.queue]) {
    if (entry.cancelled || stewardArbiter.queue.indexOf(entry) < 0) continue;
    const blocked = await stewardArbiterBlocked(entry, config);
    const at = stewardArbiter.queue.indexOf(entry);   // await 期间队列可能被别的路径改过,重新定位
    if (entry.cancelled || at < 0) continue;
    // 116-3 P0-5:waited 在这里置(而不是入队时)—— 全新条目现在也先入队,只有【真的被挡住】的那些
    // 才该在事件流里出现 waiting/acquired/released 三帧。
    if (blocked) { entry.waited = true; stewardArbiterSetWait(entry, blocked); continue; }
    stewardArbiter.queue.splice(at, 1);
    stewardArbiterDetach(entry);
    if (typeof entry.resolve === 'function') { const resolve = entry.resolve; entry.resolve = null; resolve(stewardArbiterGrant(entry)); }
  }
  // 队伍动过之后,还在等的每条都要拿到当下正确的 ahead(「前面还有几条」必须是真的)。
  for (const entry of stewardArbiter.queue) {
    if (entry.cancelled || !entry.wait || !entry.wait.slot) continue;
    stewardArbiterSetWait(entry, { slot: { ahead: stewardArbiterAhead(entry) } });
  }
}

// 待决判据:有待决的线程回合不入队、不占并发位 —— 用户正在答复它,让它再排一次队是最没道理的等待。
async function stewardArbiterHasPending(sessionId) {
  try {
    const rows = await readInterventions(sessionId);
    return (Array.isArray(rows) ? rows : []).some(iv => iv && iv.status === 'pending');
  } catch { return false; }
}

// ── 回合入口(10-context-governance 的 runSessionTurn 开头经 StewardHooks 调它)────────────────
// 返回 { granted:true, release } 或 { granted:false, reason }。开关关、管家会话、有待决三种情况
// 一律【立即】返回一个 release 为空操作的放行凭据 —— 调用方无分支,永远一句 await + finally release。
async function stewardAcquireTurnSlot(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const passthrough = { granted: true, release: () => {} };
  const config = opts.config || await readConfig().catch(() => null);
  if (!config || config.stewardEnabledV1 !== true) return passthrough;
  const sessionId = safeSessionId(opts.sessionId);
  if (!sessionId || sessionId === STEWARD_SESSION_ID) return passthrough;   // 管家不是线程,不占并发位
  // ① 等你 -> 直接放行。116-3 P2-15:放行照旧(它不该等),但把 cwd 登记进 pendingRuns 让两个写者
  // 彼此可见;真撞上同 cwd 的活跃写者时给这一路的事件流发一条 agent_resource(state:'acquired' —— 它
  // 没在等,只是同时在写),112c 状态条与看板据此能显示「同一个文件夹还有别的写者」。
  if (await stewardArbiterHasPending(sessionId)) {
    return stewardArbiterGrantPending({
      sessionId,
      title: stewardSanitizeText(opts.title || ''),
      cwdKey: stewardArbiterCwdKey(opts.cwd),
      onEvent: typeof opts.onEvent === 'function' ? opts.onEvent : null,
    });
  }
  const entry = {
    sessionId,
    title: stewardSanitizeText(opts.title || ''),
    cwdKey: stewardArbiterCwdKey(opts.cwd),
    enqueuedAt: Date.now(),
    priorityBump: false,
    starvationBumped: false,
    waited: false,
    cancelled: false,
    wait: null,
    waitSignature: '',
    lastResource: '',
    resolve: null,
    onAbort: null,
    onEvent: typeof opts.onEvent === 'function' ? opts.onEvent : null,
    signal: opts.signal || null,
  };
  if (entry.signal && entry.signal.aborted) return { granted: false, reason: 'aborted' };
  // 队列硬顶:排队是为了让用户看得懂,不是背压手段。堆到 500 条说明别处已经出问题了,放行比挂死诚实。
  // 116-3 P1-12:但逃生舱只对【预算与并发位】开 —— 同 cwd 写互斥是数据完整性问题,不是排队体验问题,
  // 而队列打满最常见的成因恰恰是「同一个繁忙目录上的自理重试循环」,这时候放行等于让两条线程一起改
  // 同一棵树。被锁挡住的条目照常入队(队列因此可能略微超过硬顶 —— 那是刻意的:宁可多排几条,
  // 也不并发写同一个文件夹)。这一判定是同步的,可以留在入队之前;真正的准入判定见下。
  if (stewardArbiter.queue.length >= STEWARD_ARBITER_QUEUE_MAX && !stewardArbiterCwdLock(entry)) {
    return stewardArbiterGrant(entry);
  }
  // 116-3 P0-5(对抗审查:同 cwd 写互斥的 TOCTOU):全新条目【也】一律先入队,准入判定与「写进
  // running」由 stewardArbiterDrain 在【同一个同步段】里完成(drain 自己有 draining 单飞标志)。
  // 旧写法在这里单独跑一次 stewardArbiterBlocked 再 grant —— 中间隔着 readConfig / hasPending /
  // arbiterBudget 三次真实 await(都会让出事件循环),两条 cwd 相同的全新回合几乎同时到达时会
  // 双双判定「没人占着」然后各自 grant,116h 的核心保证在真实并发下根本不成立。
  // 代价:没被挡住的回合也多走一次 drain 的 readConfig(不缓存,§8.10 要求上限改动即时生效)。
  // waited 保持 false —— 只有真的被挡住时 drain 才置 true,没等过的回合在事件流里不多两帧。
  // 入队到 drain 真正判定之间有一个【真实的时间窗】(drain 要 await readConfig)。§8.10「排队可解释」
  // 不允许读模型在这个窗口里出现「在排队、但说不出在等什么」的条目,所以先给一个同步就能算出来的
  // 临时原因:同 cwd 有锁就是等锁,否则按等并发位。drain 一跑就用真实判定覆盖它;不阻塞的条目直接
  // 放行,连一帧 waiting 事件都不会发(entry.waited 仍然是 false)。
  const provisionalLock = stewardArbiterCwdLock(entry);
  entry.wait = provisionalLock ? { lock: provisionalLock } : { slot: { ahead: stewardArbiterAhead(entry) } };
  stewardArbiter.queue.push(entry);
  const admitted = new Promise(resolve => {
    entry.resolve = resolve;
    if (entry.signal) {
      entry.onAbort = () => { stewardArbiterCancel(entry, 'aborted'); };
      try { entry.signal.addEventListener('abort', entry.onAbort, { once: true }); } catch { /* 无 EventTarget 的 signal:忽略 */ }
    }
  });
  stewardArbiterScheduleDrain();
  return admitted;
}

// 这条线程此刻在等什么(同步只读)。返回值直接喂 06i 的 waitReasonFor —— 四个展示面(thread_status /
// 总览行 / GET /api/missions / steward_missions)因此永远说同一句话。
function stewardArbiterWait(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  for (const entry of stewardArbiter.queue) {
    if (!entry.cancelled && entry.sessionId === sid) return entry.wait || null;
  }
  return null;
}

// 插队:把排队中的这一条提到队首,下一个释放出来的并发位就归它(§8.10「提升优先级」)。
// 不预留、不抢占 —— 已经在跑的回合不会因为别人插队被打断。
function stewardArbiterPrioritize(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return { ok: false, error: 'invalid_session', message: 'invalid sessionId' };
  const entry = stewardArbiter.queue.find(row => !row.cancelled && row.sessionId === sid);
  if (!entry) return { ok: true, sessionId: sid, prioritized: false, reason: 'not_queued' };
  entry.priorityBump = true;
  const i = stewardArbiter.queue.indexOf(entry);
  // 插到队首,但排在「已被饥饿保护提上来」的那一段之后 —— 见 stewardArbiterStarvedHead 的头注。
  const head = stewardArbiterStarvedHead();
  if (i > head) { stewardArbiter.queue.splice(i, 1); stewardArbiter.queue.splice(head, 0, entry); }
  stewardArbiterScheduleDrain();
  return { ok: true, sessionId: sid, prioritized: true };
}

// 配置写完之后立刻按新上限唤醒一次队列(§8.10「点开即改,改完立即生效,不需重启」)。不这么接的话,
// 「同时最多 N 条」调大之后要等下一次回合释放才生效 —— 用户看到的就是「改了没反应」。
// 唤醒本身只会放行【按新配置本来就该放行】的条目,所以对非 steward 的配置写入是纯粹的无操作。
function stewardArbiterRefresh() {
  if (!stewardArbiter.queue.length) return false;
  stewardArbiterScheduleDrain();
  return true;
}

// 看板与 GET /api/steward/arbiter 的读模型。running/queue 都是运行时事实,不落盘。
async function stewardArbiterState(config) {
  const cfg = config || await readConfig().catch(() => null) || {};
  const now = Date.now();
  stewardArbiter.turns = stewardArbiter.turns.filter(ts => ts > now - STEWARD_TURN_DAY_MS);
  const maxCost = Number(cfg.stewardGlobalMaxCostPerDay);
  return {
    enabled: cfg.stewardEnabledV1 === true,
    maxParallel: stewardArbiterMaxParallel(cfg),
    running: [...stewardArbiter.running.values()].map(run => ({
      sessionId: run.sessionId, title: run.title, cwdKey: run.cwdKey, startedAt: run.startedAt,
    })),
    // 116-3 P2-15:待决豁免的写者。【不】并进 running —— 它不占并发位、不挡别人(116h 的刻意设计),
    // 但看板与状态条要看得见「同一个文件夹这会儿还有谁在写」。只加字段,不改既有形状。
    pendingWriters: [...stewardArbiter.pendingRuns.values()].map(run => ({
      sessionId: run.sessionId, title: run.title, cwdKey: run.cwdKey, startedAt: run.startedAt,
    })),
    queue: stewardArbiter.queue.filter(entry => !entry.cancelled).map(entry => ({
      sessionId: entry.sessionId,
      title: entry.title,
      cwdKey: entry.cwdKey,
      enqueuedAt: entry.enqueuedAt,
      priorityBump: entry.priorityBump === true,
      wait: waitReasonFor({ pending: 0 }, entry.wait),
    })),
    hour: {
      turns: stewardArbiter.turns.filter(ts => ts > now - STEWARD_TURN_WINDOW_MS).length,
      limit: Math.max(0, Math.round(Number(cfg.stewardGlobalMaxTurnsPerHour) || 0)),
    },
    day: {
      cost: await stewardArbiterDayCost().catch(() => 0),
      limit: Number.isFinite(maxCost) ? maxCost : 0,
    },
    starveThresholdMs: stewardArbiterStarveThresholdMs(),
  };
}
