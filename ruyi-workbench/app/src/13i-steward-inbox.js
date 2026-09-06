// ============================================================================
// 第 116 波 116b(27 号文 §11.3「116b 收件箱与游标」)/ 116-2e 拆分:管家(Steward)收件箱轮询器与游标。
//
// 拆分来源(116-2e):本文件的全部内容原本是 `13g-steward.js` 的前半(第 1 行到 handleStewardApiRoutes
//   之前),零行为搬家 —— 函数体一行未改,只改了本文件头注释。拆分理由:13g 已 1993 行触到 SPEC §2 的
//   2000 行目标上限,116-2e 还要往它的 handleStewardApiRoutes 与工具管道里加东西。
// 落点(transport 层,manifest 中位于 13e-pretender-index.js 之后、13g-steward.js 之前):
//   只能【前置】—— `steward-runner.static` 同时锁着「13h 紧跟 13g」与「13h 紧邻 14-main」,
//   13g 与 13h 之间没有位置;前置模块只能承载 13g 的【上游】部分(收件箱),否则出前向边。
//
// 本文件把【三条现成的 seq 日志】增量读成【五类白名单事件】,落进管家自己的两个文件。
// 它不改任何执行语义 —— 只读别人的账,只写自己的箱。路由、决策日志、记忆存储与 21 个管家工具
// 仍住 13g(它拼接在本文件之后,引用本文件的符号全部是后向边)。
//
// 三个源(全部是既有权威源,本波不新增任何写入端):
//   ① Mission Change Ledger  `readMissionChangesWithMeta(sessionId, currentRevision)`(02-session-store.js)
//      —— per-session append-only,seq = mission.changeSeq(单调 revision)。
//   ② agent run 事件日志      `readAgentRunEvents(sessionId, runId, afterSeq, limit)`(08-agent-runs.js)
//      —— per-run append-only,seq = run.eventSeq(单调)。
//   ③ 待决投影                `getPretenderProjectionIndex()`(13e-pretender-index.js)
//      —— 可重建物化索引,给出每个会话的 pending Intervention 列表与 mission card(含预算耗尽标记)。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13i 只引用拼接顺序在它之前的模块符号(00/01/01b/02/08/13e/06i …),全部后向边;
//   · 13-http-router.js 【不得】直接引用本文件的任何符号 —— 那会是前向边。挂接改走延迟绑定:
//     13g 在加载时 `Object.assign(StewardHooks, { handleApiRoutes, stopInbox, inboxRead, inboxState })`,
//     其中后三个键的实现就在本文件里(13g → 13i 是后向边),13 只写 `StewardHooks.handleApiRoutes`;
//   · 14-main.js 在 startServer 返回(服务已监听)后调用 `startStewardInbox(config)`(14 → 13i 后向边)。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时本文件【零副作用】—— 不起 interval、不建
// `<data>/steward/` 目录、不写任何文件;四条路由(住 13g)仍在(路由清册不因开关变化),start 返回 409
// `steward.disabled`,state 返回 enabled:false,inbox 读一个不存在的文件得空数组(不 mkdir)。
// ============================================================================
// ── 落盘常量 ────────────────────────────────────────────────────────────────
const STEWARD_DIR_NAME = 'steward';
const STEWARD_INBOX_FILE = 'inbox-v1.ndjson';
const STEWARD_CURSOR_FILE = 'cursor-v1.json';
const STEWARD_CURSOR_SCHEMA = 1;

// ── 归一化/合并常量 ──────────────────────────────────────────────────────────
const STEWARD_MERGE_WINDOW_MS = 5000;      // §11.3:同 sessionId 同 kind 5 秒窗口内合并为一条
const STEWARD_SUMMARY_CHARS = 200;         // payload 摘要硬顶(与 STEWARD_DIGEST_LIMITS.lastSayChars 同数)
const STEWARD_MERGED_SEQS_MAX = 20;        // 合并行里回填的源 seq 上限(供重启重建去重集合)
const STEWARD_TICK_MAX_EVENTS = 200;       // 单轮入箱上限(防某次大补账把箱子灌爆)
const STEWARD_CARRY_MAX_EVENTS = 5000;     // 116-3 P0-3:跨轮结转队列硬顶(超出才真的丢,并落一条日志)

// ── 轮询成本常量 ────────────────────────────────────────────────────────────
const STEWARD_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // 「活跃」= 有待决 / 未终态 / 24 小时内有变更
const STEWARD_RUN_EVENT_PAGE = 200;        // 单个 run 单轮最多读多少条事件(下轮继续)
const STEWARD_FIRST_SIGHT_MAX_REVISION = 200; // 首见会话:revision 不超过它才全读,否则只建基线
const STEWARD_FIRST_SIGHT_MAX_EVENT_SEQ = 500; // 首见 run:同上

// ── 容量常量(游标不得无限增长) ───────────────────────────────────────────────
const STEWARD_CURSOR_MAX_SESSIONS = 500;
const STEWARD_CURSOR_MAX_RUNS = 500;
const STEWARD_CURSOR_MAX_PENDING = 2000;

// ── 读取常量 ────────────────────────────────────────────────────────────────
const STEWARD_INBOX_LIMIT_DEFAULT = 50;
const STEWARD_INBOX_LIMIT_MAX = 200;       // §11.3:limit 夹 [1,200]
const STEWARD_INBOX_FULL_READ_BYTES = 8 * 1024 * 1024; // 超过它只读尾窗(首个半行丢弃)
const STEWARD_INBOX_TAIL_BYTES = 1024 * 1024;
const STEWARD_DEDUPE_TAIL_ROWS = 2000;     // 启动时从 inbox 尾部重建去重集合的行数上限
const STEWARD_SEEN_MAX_KEYS = 20000;       // 去重集合内存硬顶,超了就按同一口径从尾部重建

// ────────────────────────────────────────────────────────────────────────────
// 源事件 → 五类白名单的【唯一】映射表。
//
// 纪律(dev-harness/steward-events.static.e2e.js 机械对账):三个源在源码里写入端出现过的【每一个】
// type 字面量都必须在本表里登记 —— 登记为 null 也算登记。加了新事件却不登记 = 门红。
// 值的取值:五类之一('needs_you'|'failed'|'done'|'stalled'|'budget')、null(明确丢弃)、
// 或 '@<resolver>'(同一 type 的语义由 payload 决定,见下方三个 stewardResolve* 纯函数)。
// ────────────────────────────────────────────────────────────────────────────
const STEWARD_SOURCE_EVENT_MAP = Object.freeze({
  // ① Mission Change Ledger(02-session-store.js 的 MISSION_CHANGE_TYPES,9 种)
  missionChange: Object.freeze({
    mission_started: null,        // 新建任务账本,不是五类中任一(管家从总览就知道有这条线程)
    progress: null,               // 每回合一条的常规推进 = 心跳,按 §11.3「心跳丢弃」
    failure: 'failed',            // 回合失败(errorClass 在 detail 里)
    budget: null,                 // ← 用量入账(00-boot appendUsageLedger 的每回合 turn 行),是心跳不是触顶;
                                  //   真正的「预算触顶」由投影的 card.mission.budgetExhausted 承载(见 projection)
    intervention_pending: null,   // ← needs_you 统一由投影产出(去重键=interventionId),此处再产一次会双份
    intervention_resolved: null,  // 待决已解决 = 不再需要你,不入箱(投影侧 pendingIds 会自然移除)
    result: '@missionResult',     // 结果章:complete → done;stopped 带错误 → failed;stopped 无错误 → done
    rewind: null,                 // 回退检查点是用户自己的动作
    run_deleted: null,            // 删运行记录是用户自己的动作
    // 116-2b 新增(补 116b 登记的缺口):普通回合的两类信号,由 02 的写入端落账(带频控)。
    stalled: 'stalled',           // 主回合死循环纠偏等"还在跑但没往前走"(同会话 5 分钟一条)
    budget_tripped: 'budget',     // 回合 token 预算保护触顶(每回合最多一条;与心跳 'budget' 分开)
    // 116g:线程加入/移出事项、事项合并/拆分。它是【归属变更】,不是五类信号中的任何一个 ——
    // 用户自己(或管家替他)刚做完这个动作,不需要再被"通知"一次。登记为 null = 显式丢弃。
    mission_membership: null,
  }),
  // ② agent run 事件日志(全 src 扫 appendAgentRunEvent 的 type 字面量,22 种)
  agentRun: Object.freeze({
    run_created: null,            // 班组起跑
    run_end: '@runEnd',           // succeeded/stopped → done;failed/partial → failed
    run_paused: null,             // reason: 'user'(用户自己按的)/'persistence_degraded'(与下面的
                                  //   persistence_degraded 同一事实,只登记一次,避免双份)
    run_resumed: null,
    run_resume_requested: null,
    run_resume_deferred: 'stalled',   // 重启后按 resumeTier 不敢自动续 → 停在半路等你
    run_auto_resume: null,
    run_interrupted: 'stalled',       // 进程重启把 run 打断,停在半路
    run_stop_requested: null,
    run_pool: null,               // 任务池提案 → needs_you 由投影的 pool Intervention 统一产出
    run_replan: null,             // 重规划提案 → replan 不在四类待决白名单(§3.1),本波不入箱
    node_start: null,
    node_progress: null,          // 节点里程碑,高频进度
    node_wait: null,
    node_settled: '@nodeSettled', // status failed/rejected → failed;其余(succeeded/skipped/…)丢弃
    node_requeued: null,          // 与 node_settled 同一行三元表达式的另一支
    node_wrapup_requested: null,
    node_wrapup_forced: null,
    node_idle_aborted: 'stalled',      // 节点空闲超时被中止 = 停滞
    node_no_progress_aborted: 'stalled', // 语义死循环被中止 = 停滞
    persistence_degraded: 'failed',    // 快照连续写失败 = 硬故障
    persistence_recovered: null,
    // 116-2b 新增(补 116b 登记的缺口):班组内的两类信号,由 09 的节点事件壳落账(频控在 08 写入端)。
    run_stalled: 'stalled',            // subagent_no_progress / loop_recovery(同 run 5 分钟一条)
    run_budget_tripped: 'budget',      // 节点工具迭代预算耗尽(按节点天然去重)
  }),
  // ③ 待决投影里的 Intervention 类型(全 src 扫 registerIntervention 的 type 字面量,5 种)
  intervention: Object.freeze({
    permission: 'needs_you',
    question: 'needs_you',
    plan: 'needs_you',
    pool: 'needs_you',
    replan: null,                 // §3.1 四类待决只有 permission/question/plan/pool;replan 归 116-2
  }),
  // ④ 投影派生(没有对应的源事件 type,由 mission card 的持久标记推出)
  projection: Object.freeze({
    budget_exhausted: 'budget',   // m.budgetExhaustedAt 是一次性持久标记 → 每个事项只入箱一次
  }),
  // ⑤ 只走 SSE、【故意】不落任何持久日志的进度信号(116-2b 登记)。收件箱只读三条带 seq 的持久
  //    日志,故这里的东西不可能入箱 —— 登记为 null 是为了让"新信号必须有人登记一次"这条纪律不被
  //    沉默绕过:下一个人加进度事件时,至少要来这张表里写一行"它是进度,不是信号"。
  //    这一组【不参与】116b 静态锁的三条双向等集判定(它扫的是三个持久写入端,这里没有写入端)。
  sseOnly: Object.freeze({
    adaptive_tool_budget: null,   // 子代理工具迭代预算自适应扩容 = 进度(还在往前走),不是触顶
  }),
});

// 只在这四个源事件里出现、但语义由 payload 决定的三个纯函数解析器(表里以 '@name' 指向)。
function stewardResolveMissionResultKind(detail) {
  const d = (detail && typeof detail === 'object') ? detail : {};
  const status = String(d.status || '');
  if (status === 'complete') return 'done';
  if (status === 'stopped') {
    // 「结果章 stopped 且带错误」→ failed;用户主动收工(无错误)→ done(终态,报一次)。
    if (d.errorClass || d.error || Number(d.failed) > 0) return 'failed';
    return 'done';
  }
  return null;
}
function stewardResolveRunEndKind(data) {
  const status = String((data && data.status) || '');
  if (status === 'succeeded' || status === 'stopped') return 'done';
  if (status === 'failed' || status === 'partial') return 'failed';
  return null;
}
function stewardResolveNodeSettledKind(data) {
  const status = String((data && data.status) || '');
  return (status === 'failed' || status === 'rejected') ? 'failed' : null;
}
const STEWARD_KIND_RESOLVERS = Object.freeze({
  '@missionResult': stewardResolveMissionResultKind,
  '@runEnd': stewardResolveRunEndKind,
  '@nodeSettled': stewardResolveNodeSettledKind,
});

// 表查询:返回五类之一或 null。未登记的 type 一律 null(丢弃)并由静态门在下一次改动时报红。
function stewardKindFor(source, type, payload) {
  const table = STEWARD_SOURCE_EVENT_MAP[source];
  if (!table || !Object.prototype.hasOwnProperty.call(table, String(type))) return null;
  const value = table[String(type)];
  if (value == null) return null;
  if (typeof value === 'string' && value.startsWith('@')) {
    const resolver = STEWARD_KIND_RESOLVERS[value];
    return resolver ? resolver(payload) : null;
  }
  return STEWARD_EVENT_KINDS.includes(value) ? value : null;
}

// ────────────────────────────────────────────────────────────────────────────
// 纯函数区(不碰磁盘、不读配置):归一化 / 去重键 / 合并。单测 unit/steward-inbox-core.test.js 直测。
// 入参一律是普通对象,不依赖任何源模块的运行时状态。
// ────────────────────────────────────────────────────────────────────────────
function stewardClipSummary(value) {
  const text = stewardSanitizeText(value).trim();
  return text.length > STEWARD_SUMMARY_CHARS ? text.slice(0, STEWARD_SUMMARY_CHARS) + '…' : text;
}

function stewardIsoAt(value) {
  const text = String(value == null ? '' : value);
  return Number.isFinite(Date.parse(text)) ? text : new Date(0).toISOString();
}

// 去重键 = sessionId + kind + runId + seq(§11.3「去重键 sessionId+kind+seq」;needs_you 的 seq
// 位就是 interventionId,budget 的 seq 位是常量 'exhausted' —— 二者都是各自源的稳定游标)。
function stewardEventDedupeKey(evt) {
  const e = (evt && typeof evt === 'object') ? evt : {};
  return [String(e.sessionId || ''), String(e.kind || ''), String(e.runId || ''), String(e.seq)].join('\u0000');
}

// ① Mission Change Ledger 的一条 change record → 归一化事件 | null
function stewardNormalizeMissionChange(record) {
  const r = (record && typeof record === 'object') ? record : {};
  const seq = Number(r.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const detail = (r.detail && typeof r.detail === 'object') ? r.detail : {};
  const cursor = (r.cursor && typeof r.cursor === 'object') ? r.cursor : {};
  const kind = stewardKindFor('missionChange', r.type, detail);
  if (!kind) return null;
  const payload = { source: 'mission_change', changeType: String(r.type || '') };
  if (detail.errorClass) payload.errorClass = stewardClipSummary(detail.errorClass);
  if (detail.status) payload.resultStatus = stewardClipSummary(detail.status);
  if (cursor.turnSeq != null) payload.turnSeq = Number(cursor.turnSeq) || 0;
  if (cursor.engine) payload.engine = stewardClipSummary(cursor.engine);
  // 116-2b:两个新 type 的摘要只取 detail 里的计数与原因(reason/tool/count/spent/budget),
  // 与 failure 同纪律 —— 永不带工具输出正文。
  if (detail.reason) payload.reason = stewardClipSummary(detail.reason);
  if (detail.tool) payload.tool = stewardClipSummary(detail.tool);
  if (detail.count != null) payload.count = Number(detail.count) || 0;
  if (detail.spent != null) payload.spent = Number(detail.spent) || 0;
  if (detail.budget != null) payload.budget = Number(detail.budget) || 0;
  payload.summary = stewardClipSummary(
    r.type === 'stalled'
      ? `线程停住了(${payload.reason || '无进展'}${payload.tool ? ' · ' + payload.tool : ''}${payload.count ? ' · 第 ' + payload.count + ' 次' : ''})`
      : r.type === 'budget_tripped'
        ? `回合 token 预算触顶(已用 ${payload.spent}/${payload.budget})`
        : kind === 'failed'
          ? `回合失败${payload.errorClass ? '(' + payload.errorClass + ')' : ''}`
          : `事项结果章:${payload.resultStatus || ''}`);
  return {
    kind,
    sessionId: String(r.sessionId || ''),
    missionId: String(r.missionId || r.sessionId || ''),
    runId: '',
    seq,
    at: stewardIsoAt(r.occurredAt),
    payload,
  };
}

// ② agent run 事件 → 归一化事件 | null
function stewardNormalizeRunEvent(sessionId, missionId, runId, evt) {
  const e = (evt && typeof evt === 'object') ? evt : {};
  const seq = Number(e.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const data = (e.data && typeof e.data === 'object') ? e.data : {};
  const kind = stewardKindFor('agentRun', e.type, data);
  if (!kind) return null;
  const payload = { source: 'agent_run', eventType: String(e.type || '') };
  if (e.nodeId) payload.nodeId = stewardClipSummary(e.nodeId);
  if (data.status) payload.runStatus = stewardClipSummary(data.status);
  if (data.errorClass) payload.errorClass = stewardClipSummary(data.errorClass);
  if (data.reason) payload.reason = stewardClipSummary(data.reason);
  // 刻意不带 data.text / data.nodes 等正文:payload 只放摘要与引用 id,永不带工具输出全文。
  // 116-2b:run_stalled / run_budget_tripped 的 data 带 reason/tool/count/limit,补进 payload 摘要。
  if (data.tool) payload.tool = stewardClipSummary(data.tool);
  if (data.count != null) payload.count = Number(data.count) || 0;
  if (data.limit != null) payload.limit = Number(data.limit) || 0;
  payload.summary = stewardClipSummary(
    kind === 'done' ? `班组 ${runId} 收工(${payload.runStatus || ''})`
      : kind === 'failed' ? `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}失败${payload.errorClass ? '(' + payload.errorClass + ')' : ''}`
        : kind === 'budget' ? `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}用完了工具迭代预算(${payload.limit} 轮)`
          : `班组 ${runId} ${payload.nodeId ? '节点 ' + payload.nodeId + ' ' : ''}停滞(${payload.eventType}${payload.reason ? ' · ' + payload.reason : ''}${payload.tool ? ' · ' + payload.tool : ''})`);
  return {
    kind,
    sessionId: String(sessionId || ''),
    missionId: String(missionId || sessionId || ''),
    runId: String(runId || ''),
    seq,
    at: stewardIsoAt(e.ts),
    payload,
  };
}

// ③ 投影里一条 pending Intervention → 归一化 needs_you 事件 | null
function stewardNormalizePendingIntervention(sessionId, missionId, iv) {
  const v = (iv && typeof iv === 'object') ? iv : {};
  if (String(v.status || '') !== 'pending') return null;
  const id = String(v.id || '');
  if (!id) return null;
  const type = String(v.type || '');
  const kind = stewardKindFor('intervention', type, v);
  if (!kind) return null;
  const payload = { source: 'projection', interventionId: id, interventionType: type };
  if (v.toolName) payload.toolName = stewardClipSummary(v.toolName);
  if (v.tier) payload.tier = stewardClipSummary(v.tier);
  if (v.runId) payload.runId = stewardClipSummary(v.runId);
  // 一句话摘要:只取各类待决自己的摘要字段(问题原文/计划摘要/池任务),永不带 iv.input(可能含文件正文)。
  const summary = type === 'permission' ? `请求执行工具 ${payload.toolName || '(未知)'}${payload.tier ? ' · ' + payload.tier : ''}`
    : type === 'question' ? String(v.questionSummary || '在问你一个问题')
      : type === 'plan' ? String(v.planSummary || '提交了一份计划等你批')
        : String(v.task || '提了一个新任务等你批');
  payload.summary = stewardClipSummary(summary);
  return {
    kind,
    sessionId: String(sessionId || ''),
    missionId: String(missionId || sessionId || ''),
    runId: String(v.runId || ''),
    seq: id, // needs_you 的去重游标就是 interventionId(同一待决只入箱一次)
    at: stewardIsoAt(v.requestedAt),
    payload,
  };
}

// ④ 投影派生:mission card 的预算耗尽标记 → budget 事件 | null(每个事项一次性)
function stewardNormalizeBudgetExhausted(sessionId, missionId, card) {
  const c = (card && typeof card === 'object') ? card : null;
  const mission = c && c.mission && typeof c.mission === 'object' ? c.mission : null;
  if (!mission || mission.budgetExhausted !== true) return null;
  const kind = stewardKindFor('projection', 'budget_exhausted', mission);
  if (!kind) return null;
  const budget = (mission.budget && typeof mission.budget === 'object') ? mission.budget : {};
  const spent = (mission.spent && typeof mission.spent === 'object') ? mission.spent : {};
  return {
    kind,
    sessionId: String(sessionId || ''),
    missionId: String(missionId || sessionId || ''),
    runId: '',
    seq: 'exhausted',
    at: stewardIsoAt(mission.updatedAt || c.updatedAt),
    payload: {
      source: 'projection',
      autoTurns: Number(spent.autoTurns) || 0,
      maxAutoTurns: Number(budget.maxAutoTurns) || 0,
      tokens: Number(spent.tokens) || 0,
      maxTokens: Number(budget.maxTokens) || 0,
      summary: stewardClipSummary(`事项预算已用尽(自动回合 ${Number(spent.autoTurns) || 0}/${Number(budget.maxAutoTurns) || 0})`),
    },
  };
}

// 合并(纯函数):同 sessionId + 同 kind、且距该组【首条】不超过 windowMs 的事件并成一条。
// 组内:count 累加、at 取最早、payload 取最新、seq 取最新;所有被并掉的源 seq 回填进
// payload.mergedSeqs(上限 STEWARD_MERGED_SEQS_MAX),供重启时从 inbox 尾部重建完整去重集合。
function stewardMergeInboxEvents(events, windowMs) {
  const window = Number.isFinite(Number(windowMs)) ? Number(windowMs) : STEWARD_MERGE_WINDOW_MS;
  const rows = (Array.isArray(events) ? events : []).filter(e => e && typeof e === 'object' && STEWARD_EVENT_KINDS.includes(e.kind));
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at))
    || String(a.sessionId).localeCompare(String(b.sessionId))
    || String(a.kind).localeCompare(String(b.kind))
    || String(a.seq).localeCompare(String(b.seq)));
  const open = new Map(); // sessionId\0kind -> group
  const out = [];
  for (const evt of rows) {
    const groupKey = String(evt.sessionId || '') + '\u0000' + String(evt.kind || '');
    const at = Date.parse(evt.at);
    const atMs = Number.isFinite(at) ? at : 0;
    const group = open.get(groupKey);
    if (group && atMs - group.__firstMs <= window) {
      group.count += 1;
      group.seq = evt.seq;
      group.runId = String(evt.runId || group.runId || '');
      group.payload = { ...evt.payload };
      if (group.__seqs.length < STEWARD_MERGED_SEQS_MAX) group.__seqs.push(evt.seq);
      continue;
    }
    const created = {
      kind: evt.kind,
      sessionId: String(evt.sessionId || ''),
      missionId: String(evt.missionId || evt.sessionId || ''),
      runId: String(evt.runId || ''),
      seq: evt.seq,
      at: evt.at,
      payload: { ...evt.payload },
      count: 1,
      __firstMs: atMs,
      __seqs: [evt.seq],
    };
    open.set(groupKey, created);
    out.push(created);
  }
  return out.map(group => {
    const row = { kind: group.kind, sessionId: group.sessionId, missionId: group.missionId, runId: group.runId, seq: group.seq, at: group.at, payload: group.payload, count: group.count };
    if (group.count > 1) row.payload = { ...row.payload, mergedSeqs: group.__seqs.slice(0, STEWARD_MERGED_SEQS_MAX) };
    return row;
  });
}

// 从一条已落盘的 inbox 行还原它覆盖的【全部】去重键(含被合并掉的源 seq)。
function stewardInboxRowDedupeKeys(row) {
  if (!row || typeof row !== 'object') return [];
  const base = { sessionId: row.sessionId, kind: row.kind, runId: row.runId };
  const seqs = [row.seq];
  const merged = row.payload && Array.isArray(row.payload.mergedSeqs) ? row.payload.mergedSeqs : [];
  for (const seq of merged.slice(0, STEWARD_MERGED_SEQS_MAX)) if (!seqs.includes(seq)) seqs.push(seq);
  return seqs.map(seq => stewardEventDedupeKey({ ...base, seq }));
}

// ────────────────────────────────────────────────────────────────────────────
// 落盘层。写原语与 session-changes NDJSON 同款:先 repairMissionChangeTornTail(尾部半行截干净),
// 再 fsp.appendFile 整行;全部经一条 per-process 串行链(不交错)。游标走 atomicWriteJson。
// ────────────────────────────────────────────────────────────────────────────
function stewardDir() { return path.join(paths.data, STEWARD_DIR_NAME); }
function stewardInboxPath() { return path.join(stewardDir(), STEWARD_INBOX_FILE); }
function stewardCursorPath() { return path.join(stewardDir(), STEWARD_CURSOR_FILE); }

const stewardRuntime = {
  timer: null,
  running: false,
  ticking: false,
  generation: 0,        // stopStewardInbox 自增;在途 tick 发现代际变了就尽快退出
  loaded: false,
  cold: true,           // 本次装载时没有可用游标 = 冷启动(只建基线,不把历史灌进箱子)
  inboxSeq: 0,
  pollMs: 15000,
  lastTickAt: '',
  lastError: '',
  seen: new Set(),      // 去重集合(启动时从 inbox 尾部重建,上限 STEWARD_DEDUPE_TAIL_ROWS 行)
  cursor: { missionChanges: {}, agentRuns: {}, pendingIds: new Set() },
  // 116-3 P0-3:本轮因单轮上限没能写进箱子的【原始】事件。游标在 stewardCollectEvents 里已经越过
  // 它们(三条源日志的游标是「这一轮看到的最新版本号」,不管后面写没写进箱),所以不留在这里就是
  // 永久静默丢失 —— 而超出上限的恰恰是最新的那批 needs_you / failed。留到下一轮开头再入箱。
  carry: [],
};
let stewardAppendChain = Promise.resolve();

function stewardResetRuntimeState() {
  stewardRuntime.loaded = false;
  stewardRuntime.cold = true;
  stewardRuntime.inboxSeq = 0;
  stewardRuntime.lastTickAt = '';
  stewardRuntime.lastError = '';
  stewardRuntime.seen = new Set();
  stewardRuntime.cursor = { missionChanges: {}, agentRuns: {}, pendingIds: new Set() };
  stewardRuntime.carry = [];
}

// inbox 尾窗读取:小文件整读;大文件只读尾窗并丢弃首个半行(换行是单字节 0x0A,永不落在 UTF-8
// 多字节序列中 —— 与 readAgentRunEvents 的尾窗纪律同源)。文件不存在 = 空(绝不 mkdir)。
async function stewardReadInboxText() {
  const file = stewardInboxPath();
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
  if (size <= STEWARD_INBOX_FULL_READ_BYTES) {
    try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
  }
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(STEWARD_INBOX_TAIL_BYTES);
    const { bytesRead } = await fh.read(buf, 0, STEWARD_INBOX_TAIL_BYTES, size - STEWARD_INBOX_TAIL_BYTES);
    return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
  } catch { return { text: '', droppedHead: false }; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// 解析 inbox 文本为行对象。坏行/尾部半行一律跳过(append-only 日志的既有纪律)。
function stewardParseInboxText(text, droppedHead) {
  const lines = String(text || '').split('\n');
  const rows = [];
  for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = safeJsonParse(line, null);
    if (!row || typeof row !== 'object') continue;
    if (!Number.isSafeInteger(Number(row.inboxSeq)) || !STEWARD_EVENT_KINDS.includes(row.kind)) continue;
    rows.push(row);
  }
  return rows;
}

async function stewardReadInboxRows() {
  const { text, droppedHead } = await stewardReadInboxText();
  return stewardParseInboxText(text, droppedHead);
}

// 游标读取。读坏/缺失 → 冷启动(inboxSeq 从 inbox 尾行恢复,去重集合从 inbox 尾部 N 行重建,
// 三源只建基线不补历史)。这条正是「cursor 读坏 → 从零开始但不重复已在 inbox 里的键」。
async function stewardLoadState() {
  if (stewardRuntime.loaded) return;
  stewardResetRuntimeState();
  const rows = await stewardReadInboxRows();
  const tail = rows.slice(-STEWARD_DEDUPE_TAIL_ROWS);
  for (const row of tail) for (const key of stewardInboxRowDedupeKeys(row)) stewardRuntime.seen.add(key);
  for (const row of rows) stewardRuntime.inboxSeq = Math.max(stewardRuntime.inboxSeq, Number(row.inboxSeq) || 0);

  let raw = null;
  try { raw = safeJsonParse(await fsp.readFile(stewardCursorPath(), 'utf8'), null); } catch { raw = null; }
  if (raw && typeof raw === 'object' && Number(raw.schema) === STEWARD_CURSOR_SCHEMA) {
    const sources = (raw.sources && typeof raw.sources === 'object') ? raw.sources : {};
    const mc = (sources.missionChanges && typeof sources.missionChanges === 'object' && !Array.isArray(sources.missionChanges)) ? sources.missionChanges : {};
    const ar = (sources.agentRuns && typeof sources.agentRuns === 'object' && !Array.isArray(sources.agentRuns)) ? sources.agentRuns : {};
    for (const [sid, revision] of Object.entries(mc).slice(0, STEWARD_CURSOR_MAX_SESSIONS)) {
      const n = Number(revision);
      if (safeSessionId(sid) && Number.isSafeInteger(n) && n >= 0) stewardRuntime.cursor.missionChanges[sid] = n;
    }
    for (const [runId, seq] of Object.entries(ar).slice(0, STEWARD_CURSOR_MAX_RUNS)) {
      const n = Number(seq);
      if (safeSessionId(runId) && Number.isSafeInteger(n) && n >= 0) stewardRuntime.cursor.agentRuns[runId] = n;
    }
    const pending = Array.isArray(sources.pendingIds) ? sources.pendingIds : [];
    for (const key of pending.slice(0, STEWARD_CURSOR_MAX_PENDING)) if (typeof key === 'string' && key) stewardRuntime.cursor.pendingIds.add(key);
    const savedSeq = Number(raw.inboxSeq);
    if (Number.isSafeInteger(savedSeq) && savedSeq > stewardRuntime.inboxSeq) stewardRuntime.inboxSeq = savedSeq;
    stewardRuntime.cold = false;
  }
  stewardRuntime.loaded = true;
}

// append:与 session-changes 同款原语(repairMissionChangeTornTail + appendFile),per-process 串行。
function stewardAppendInboxRows(rows) {
  if (!rows.length) return Promise.resolve();
  const file = stewardInboxPath();
  const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const next = stewardAppendChain.catch(() => {}).then(async () => {
    await fsp.mkdir(stewardDir(), { recursive: true });
    await repairMissionChangeTornTail(file); // 尾部半行先截干净,再整行 append(防焊接)
    await fsp.appendFile(file, payload, 'utf8');
  });
  stewardAppendChain = next.catch(() => {});
  return next;
}

// 游标落盘(容量控制在这里做:只留活跃集合 + 硬顶,过期条目直接清掉)。
async function stewardSaveCursor(activeSessionIds, activeRunIds) {
  const missionChanges = {};
  for (const sid of activeSessionIds) {
    if (Object.keys(missionChanges).length >= STEWARD_CURSOR_MAX_SESSIONS) break;
    if (Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.missionChanges, sid)) missionChanges[sid] = stewardRuntime.cursor.missionChanges[sid];
  }
  const agentRuns = {};
  for (const runId of activeRunIds) {
    if (Object.keys(agentRuns).length >= STEWARD_CURSOR_MAX_RUNS) break;
    if (Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.agentRuns, runId)) agentRuns[runId] = stewardRuntime.cursor.agentRuns[runId];
  }
  stewardRuntime.cursor.missionChanges = missionChanges;
  stewardRuntime.cursor.agentRuns = agentRuns;
  const pendingIds = [...stewardRuntime.cursor.pendingIds].slice(0, STEWARD_CURSOR_MAX_PENDING);
  stewardRuntime.cursor.pendingIds = new Set(pendingIds);
  await fsp.mkdir(stewardDir(), { recursive: true });
  await atomicWriteJson(stewardCursorPath(), {
    schema: STEWARD_CURSOR_SCHEMA,
    inboxSeq: stewardRuntime.inboxSeq,
    updatedAt: nowIso(),
    sources: { missionChanges, agentRuns, pendingIds },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 轮询一轮。
//
// 成本纪律(§11.3「不得每次全量扫所有会话」):先取投影索引(进程内可重建缓存,脏页增量刷新),
// 只对【活跃】会话与 run 做增量磁盘读:
//   · Mission Ledger:只有 row.changeSeq > 已记游标才读(投影里的 changeSeq 就是免费的「有没有新变化」);
//   · agent run 事件:只读活跃会话里【未终态 或 24 小时内更新过】的 run;
//   · 待决:直接来自投影内存数组,零磁盘读。
// ────────────────────────────────────────────────────────────────────────────
async function stewardCollectEvents() {
  const index = await getPretenderProjectionIndex();
  const now = Date.now();
  const events = [];
  const activeSessionIds = [];   // 活跃会话优先(游标硬顶到了先丢不活跃的,见 stewardSaveCursor)
  const idleSessionIds = [];
  const activeRunIds = [];
  const nextPending = new Set();

  for (const row of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
    const sid = row && safeSessionId(row.sessionId);
    if (!sid) continue;
    // 116f 排除面之一:管家会话自己【绝不】进收件箱(否则管家的每个回合都会变成下一个回合的输入,
    // 一条自激励循环)。这里按固定 id 判(06i 的 STEWARD_SESSION_ID)而不是按会话头原始 kind:投影行
    // 里的 kind 是 sessionKind() 归一后的值(会把 steward 说成 quick_ask),拿到原始 kind 要为每行多读
    // 一次会话头 —— 每 15 秒一轮的轮询器不该为一个恒等判断付这个代价。双保险:13e 的扫描器只认
    // /^sess_/ 前缀的会话文件,取名 'steward' 的管家会话本来就到不了这个循环。
    if (sid === STEWARD_SESSION_ID) continue;
    const missionId = String(row.missionId || sid);
    const card = row.card || null;
    const updatedMs = Date.parse(String((card && card.updatedAt) || ''));
    const recent = Number.isFinite(updatedMs) && (now - updatedMs) <= STEWARD_ACTIVE_WINDOW_MS;

    // ── 待决(全局,不受活跃集限制:待决就是「需要你」,不能因为线程安静就漏报) ──
    let hasPending = false;
    for (const iv of (Array.isArray(row.interventions) ? row.interventions : [])) {
      if (!iv || iv.status !== 'pending') continue;
      hasPending = true;
      const id = String(iv.id || '');
      if (!id) continue;
      const pendingKey = sid + '\u0000' + id;
      nextPending.add(pendingKey);
      if (stewardRuntime.cursor.pendingIds.has(pendingKey)) continue;
      const evt = stewardNormalizePendingIntervention(sid, missionId, iv);
      if (evt) events.push(evt);
    }

    // ── 预算触顶(一次性持久标记) ──
    const budgetEvt = stewardNormalizeBudgetExhausted(sid, missionId, card);
    if (budgetEvt) events.push(budgetEvt);

    const active = hasPending || recent;
    const knownRevision = Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.missionChanges, sid)
      ? Number(stewardRuntime.cursor.missionChanges[sid]) : null;
    const revision = Math.max(0, Number(row.changeSeq) || 0);
    if (!active && knownRevision != null && revision <= knownRevision) { idleSessionIds.push(sid); continue; }
    (active ? activeSessionIds : idleSessionIds).push(sid);

    // ── ① Mission Change Ledger 增量 ──
    if (knownRevision == null) {
      // 首见:冷启动(或存量老会话)只建基线,不把历史灌进箱子;真正的新会话(revision 很小)照常全读。
      const baseline = (stewardRuntime.cold || revision > STEWARD_FIRST_SIGHT_MAX_REVISION) ? revision : 0;
      stewardRuntime.cursor.missionChanges[sid] = baseline;
      if (baseline < revision) {
        const meta = await readMissionChangesWithMeta(sid, revision).catch(() => null);
        for (const record of (meta && Array.isArray(meta.records) ? meta.records : [])) {
          if (Number(record.seq) <= baseline) continue;
          const evt = stewardNormalizeMissionChange({ ...record, sessionId: sid, missionId });
          if (evt) events.push(evt);
        }
        stewardRuntime.cursor.missionChanges[sid] = Math.max(baseline, revision);
      }
    } else if (revision > knownRevision) {
      const meta = await readMissionChangesWithMeta(sid, revision).catch(() => null);
      for (const record of (meta && Array.isArray(meta.records) ? meta.records : [])) {
        if (Number(record.seq) <= knownRevision) continue;
        const evt = stewardNormalizeMissionChange({ ...record, sessionId: sid, missionId });
        if (evt) events.push(evt);
      }
      stewardRuntime.cursor.missionChanges[sid] = Math.max(knownRevision, revision);
    }

    // ── ② agent run 事件增量(只看活跃会话里的活跃 run) ──
    if (!active) continue;
    const runs = await listAgentRuns(sid).catch(() => []);
    for (const run of runs) {
      const runId = run && safeSessionId(run.id);
      if (!runId) continue;
      const terminal = ['succeeded', 'failed', 'partial', 'stopped'].includes(String(run.status || ''));
      const runUpdatedMs = Date.parse(String(run.completedAt || run.updatedAt || run.createdAt || ''));
      const runRecent = Number.isFinite(runUpdatedMs) && (now - runUpdatedMs) <= STEWARD_ACTIVE_WINDOW_MS;
      if (terminal && !runRecent) continue;
      activeRunIds.push(runId);
      const eventSeq = Math.max(0, Number(run.eventSeq) || 0);
      const knownSeq = Object.prototype.hasOwnProperty.call(stewardRuntime.cursor.agentRuns, runId)
        ? Number(stewardRuntime.cursor.agentRuns[runId]) : null;
      let afterSeq;
      // 首见的 run:只有「本进程已经热过 + 这个 run 最近才动过 + 事件不多」三条同时成立才从 0 全读;
      // 否则只建基线(冷启动/老 run 复活都不把历史倒灌进箱,也就不依赖去重集合去兜底)。
      if (knownSeq == null) afterSeq = (stewardRuntime.cold || !runRecent || eventSeq > STEWARD_FIRST_SIGHT_MAX_EVENT_SEQ) ? eventSeq : 0;
      else afterSeq = knownSeq;
      stewardRuntime.cursor.agentRuns[runId] = afterSeq;
      const page = await readAgentRunEvents(sid, runId, afterSeq, STEWARD_RUN_EVENT_PAGE).catch(() => ({ events: [] }));
      let maxSeq = afterSeq;
      for (const evt of (page && Array.isArray(page.events) ? page.events : [])) {
        maxSeq = Math.max(maxSeq, Number(evt.seq) || 0);
        const normalized = stewardNormalizeRunEvent(sid, missionId, runId, evt);
        if (normalized) events.push(normalized);
      }
      stewardRuntime.cursor.agentRuns[runId] = maxSeq;
    }
  }

  stewardRuntime.cursor.pendingIds = nextPending;
  return { events, activeSessionIds: [...activeSessionIds, ...idleSessionIds], activeRunIds };
}

async function stewardTickOnce() {
  const generation = stewardRuntime.generation;
  await stewardLoadState();
  const { events, activeSessionIds, activeRunIds } = await stewardCollectEvents();
  if (generation !== stewardRuntime.generation) return { written: 0, aborted: true };
  // 116-3 P0-3:上一轮结转下来的事件排在最前(它们更早发生,游标也早已越过它们)。
  const carried = stewardRuntime.carry;
  stewardRuntime.carry = [];
  const fresh = carried.concat(events)
    .filter(evt => !stewardRuntime.seen.has(stewardEventDedupeKey(evt)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // 截断改在【合并之前】、对原始事件做,超出的部分原样结转到下一轮 —— 旧写法是「合并后 slice(0,200)」,
  // 被切掉的那些事件的游标已经前移,下一轮再也读不到它们(P0-3 的根因)。
  const head = fresh.slice(0, STEWARD_TICK_MAX_EVENTS);
  const rest = fresh.slice(STEWARD_TICK_MAX_EVENTS);
  if (rest.length) {
    const kept = rest.slice(0, STEWARD_CARRY_MAX_EVENTS);
    stewardRuntime.carry = kept;
    logEvent({ kind: 'steward_inbox_deferred', deferred: kept.length, dropped: rest.length - kept.length });
  }
  const merged = stewardMergeInboxEvents(head, STEWARD_MERGE_WINDOW_MS);
  const rows = [];
  for (const row of merged) {
    stewardRuntime.inboxSeq += 1;
    rows.push({
      inboxSeq: stewardRuntime.inboxSeq,
      kind: row.kind,
      sessionId: row.sessionId,
      missionId: row.missionId,
      runId: row.runId,
      seq: row.seq,
      at: row.at,
      payload: row.payload,
      count: row.count,
    });
  }
  // 116-2e(§11.1 第 2 项「速查线程」):落盘【前】给速查会话的 done 行补 quick:true 与 answer
  // (最后一句助手原话)。实现住 13g(它要装载会话正文),经 06i 的延迟绑定命名空间调 —— 直接写
  // 13g 的函数名会是前向边。旁路纪律:钩子未填充或抛错都不影响这一轮已经归一好的行。
  if (rows.length && typeof StewardHooks.enrichInboxRows === 'function') {
    try { await StewardHooks.enrichInboxRows(rows); } catch { /* 增强失败只是少两个字段,不反噬轮询器 */ }
  }
  if (rows.length) await stewardAppendInboxRows(rows);
  for (const row of rows) for (const key of stewardInboxRowDedupeKeys(row)) stewardRuntime.seen.add(key);
  // 去重集合在长跑进程里只增不减 —— 超过硬顶就按「装载时」的口径从 inbox 尾部重建(旧键本来也已经
  // 被游标挡住了,重建只是把内存占用重新压回上限)。
  if (stewardRuntime.seen.size > STEWARD_SEEN_MAX_KEYS) {
    const recent = (await stewardReadInboxRows()).slice(-STEWARD_DEDUPE_TAIL_ROWS);
    const rebuilt = new Set();
    for (const row of recent) for (const key of stewardInboxRowDedupeKeys(row)) rebuilt.add(key);
    stewardRuntime.seen = rebuilt;
  }
  // 冷启动只建基线,基线本身也必须落盘 —— 否则下次仍是冷启动,永远补不上历史增量。
  await stewardSaveCursor(activeSessionIds, activeRunIds);
  stewardRuntime.cold = false;
  stewardRuntime.lastTickAt = nowIso();
  // 116f: 本轮真的写进箱子的行交给回合运行器(13h 去抖 5 秒后起一个收件箱回合)。经 06i 的延迟绑定
  // 命名空间调(13g → 06i 是后向边;直接写 13h 的函数名会是前向边)。它是【旁路】:钩子未填充、
  // 抛错或运行器熔断,都不影响这一轮已经落盘的收件箱与游标。
  if (rows.length && typeof StewardHooks.onInboxBatch === 'function') {
    try { StewardHooks.onInboxBatch(rows); } catch { /* 运行器故障绝不反噬轮询器 */ }
  }
  return { written: rows.length, aborted: false };
}

async function stewardRunTick() {
  if (stewardRuntime.ticking) return { skipped: true }; // 串行:上一轮没跑完不叠加
  stewardRuntime.ticking = true;
  try {
    const result = await stewardTickOnce();
    stewardRuntime.lastError = '';
    return result;
  } catch (error) {
    stewardRuntime.lastError = String((error && error.message) || error || '').slice(0, 300);
    try { logEvent({ kind: 'steward_tick_error', error: stewardRuntime.lastError }); } catch { /* 观测绝不反噬 */ }
    return { error: stewardRuntime.lastError };
  } finally {
    stewardRuntime.ticking = false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 生命周期。开关关时 startStewardInbox 立即返回且【不做任何事】(不建目录、不起 interval)。
// ────────────────────────────────────────────────────────────────────────────
async function startStewardInbox(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  if (cfg.stewardEnabledV1 !== true) return { ok: false, running: false, enabled: false };
  const pollMs = Math.min(120000, Math.max(5000, Math.round(Number(cfg.stewardPollMs) || 15000)));
  stewardRuntime.pollMs = pollMs;
  // 116f: start 同时解除回合队列的停机(stop 把轮询与回合一起停,start 把两者一起放开)。
  if (typeof StewardHooks.resumeRunner === 'function') { try { StewardHooks.resumeRunner(); } catch { /* 旁路 */ } }
  if (stewardRuntime.running) { await stewardRunTick(); return { ok: true, running: true, enabled: true }; } // 幂等:重复 start 只补一轮
  stewardRuntime.running = true;
  stewardRuntime.generation += 1;
  await stewardRunTick();
  if (!stewardRuntime.running) return { ok: true, running: false, enabled: true }; // 起跑途中被 stop
  stewardRuntime.timer = setInterval(() => { void stewardRunTick(); }, pollMs);
  if (stewardRuntime.timer && typeof stewardRuntime.timer.unref === 'function') stewardRuntime.timer.unref();
  return { ok: true, running: true, enabled: true };
}

function stopStewardInbox() {
  // 116f(§8.6「一键停机常驻且永远可点」):停机停的是【轮询 + 在途管家回合 + 回合队列】三样。
  // 放在最前:即使下面清 timer 抛错,回合队列也已经停了。线程自己的回合不受影响(那由线程的权限门管)。
  if (typeof StewardHooks.stopRunner === 'function') { try { StewardHooks.stopRunner(); } catch { /* 旁路 */ } }
  if (stewardRuntime.timer) { clearInterval(stewardRuntime.timer); stewardRuntime.timer = null; }
  stewardRuntime.running = false;
  stewardRuntime.generation += 1; // 在途 tick 看到代际变化即放弃写入
  return { ok: true, running: false };
}

// ── 只读数据面(116c 的 steward_inbox_read 与 117 壳层复用同一实现) ──────────────
async function stewardInboxRead(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const since = Math.max(0, Math.round(Number(o.since) || 0));
  const rawLimit = Number(o.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(STEWARD_INBOX_LIMIT_MAX, Math.max(1, Math.round(rawLimit)))
    : STEWARD_INBOX_LIMIT_DEFAULT;
  const rows = await stewardReadInboxRows();
  const matched = rows.filter(row => Number(row.inboxSeq) > since).sort((a, b) => Number(a.inboxSeq) - Number(b.inboxSeq));
  const items = matched.slice(0, limit);
  return {
    items,
    since,
    limit,
    hasMore: matched.length > limit,
    inboxSeq: rows.reduce((max, row) => Math.max(max, Number(row.inboxSeq) || 0), 0),
  };
}

async function stewardInboxState(config) {
  const cfg = (config && typeof config === 'object') ? config : await readConfig().catch(() => ({}));
  const rows = await stewardReadInboxRows();
  const byKind = {};
  for (const kind of STEWARD_EVENT_KINDS) byKind[kind] = 0;
  let inboxSeq = 0;
  for (const row of rows) {
    inboxSeq = Math.max(inboxSeq, Number(row.inboxSeq) || 0);
    if (Object.prototype.hasOwnProperty.call(byKind, row.kind)) byKind[row.kind] += 1;
  }
  return {
    enabled: cfg.stewardEnabledV1 === true,
    running: stewardRuntime.running,
    inboxSeq: Math.max(inboxSeq, stewardRuntime.inboxSeq),
    pollMs: Math.min(120000, Math.max(5000, Math.round(Number(cfg.stewardPollMs) || 15000))),
    lastTickAt: stewardRuntime.lastTickAt,
    lastError: stewardRuntime.lastError,
    counts: { byKind },
  };
}
