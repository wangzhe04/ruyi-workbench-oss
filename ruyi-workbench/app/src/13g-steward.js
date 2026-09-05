// ============================================================================
// 第 116 波 116b(27 号文 §11.3「116b 收件箱与游标」):管家(Steward)收件箱轮询器、游标与只读路由。
//
// 定位(transport 层,manifest 中位于 13e-pretender-index.js 之后、14-main.js 之前):
//   本文件把【三条现成的 seq 日志】增量读成【五类白名单事件】,落进管家自己的两个文件,并开出四条
//   token 级只读/控制路由。它不改任何执行语义 —— 只读别人的账,只写自己的箱。
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
//   · 13g 只引用拼接顺序在它之前的模块符号(00/01/01b/02/08/13e/06i …),全部后向边;
//   · 13-http-router.js 【不得】直接引用本文件的任何符号 —— 那会是前向边。挂接改走延迟绑定:
//     本文件在加载时 `Object.assign(StewardHooks, { handleApiRoutes, stopInbox, inboxRead, inboxState })`,
//     13 只写 `StewardHooks.handleApiRoutes`(13 → 06i 是后向边);
//   · 14-main.js 在 startServer 返回(服务已监听)后调用 `startStewardInbox(config)`(14 → 13g 后向边)。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时本文件【零副作用】—— 不起 interval、不建
// `<data>/steward/` 目录、不写任何文件;四条路由仍在(路由清册不因开关变化),start 返回 409
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
  const fresh = events.filter(evt => !stewardRuntime.seen.has(stewardEventDedupeKey(evt)));
  const merged = stewardMergeInboxEvents(fresh, STEWARD_MERGE_WINDOW_MS).slice(0, STEWARD_TICK_MAX_EVENTS);
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

// ────────────────────────────────────────────────────────────────────────────
// 路由(全部 token 级,ROUTE_AUTH 在 01b-route-auth.js 登记;handler 内另做 tokenOk 纵深自查)。
// 13-http-router.js 只经 StewardHooks.handleApiRoutes 调用本函数,不直接引用它(禁止前向边)。
// ────────────────────────────────────────────────────────────────────────────
// 形态与 handleOverlayApiRoutes 一致:命中即 send(调用方以 res.writableEnded 为命中信号),
// 不命中就自然返回让路由链继续(不写前缀早退守卫 —— 那会在路由清册里多出一个无鉴权首配的裸前缀判定点)。
async function handleStewardApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/steward/start') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const started = await startStewardInbox(config);
    return send(res, json({ ok: true, running: Boolean(started && started.running) }));
  }

  if (req.method === 'POST' && pathname === '/api/steward/stop') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    stopStewardInbox();
    return send(res, json({ ok: true, running: false }));
  }

  if (req.method === 'GET' && pathname === '/api/steward/state') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    // 116f: 收件箱状态之上并进回合运行器状态(visit/turns/cost/circuit/lastReply)。运行器故障时
    // 这条只读路由仍然返回收件箱那一半 —— 状态面不该因为旁路组件出错而整条不可用。
    let runner = {};
    if (typeof StewardHooks.runnerState === 'function') {
      try { runner = (await StewardHooks.runnerState(config)) || {}; } catch { runner = {}; }
    }
    return send(res, json({ ok: true, ...await stewardInboxState(config), ...runner }));
  }

  if (req.method === 'GET' && pathname === '/api/steward/inbox') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const query = new URL(req.url, 'http://x').searchParams;
    const result = await stewardInboxRead({ since: query.get('since'), limit: query.get('limit') });
    return send(res, json({ ok: true, ...result }));
  }

  // 116-pre(27号文§8.12/§11.1第3项/§11.3):递话预判——只读、零模型、不写盘。装配(读投影+会话头+
  // 记忆存储、缓存)在 13h-steward-runner.js(拼接顺序在本文件之后),故经 StewardHooks 转交(同
  // handleRunnerApiRoutes 一手法);q 长度在这里再夹一遍(纯函数自己也夹,双重防线)。tookMs 只计
  // StewardHooks.preroute 这一段(排除 token 校验与 HTTP 层开销),与「p50 ≤50ms」的度量口径对齐。
  if (req.method === 'GET' && pathname === '/api/steward/preroute') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const query = new URL(req.url, 'http://x').searchParams;
    const q = String(query.get('q') || '').slice(0, STEWARD_PREROUTE_QUERY_MAX);
    const startedAt = Date.now();
    const result = typeof StewardHooks.preroute === 'function'
      ? await StewardHooks.preroute(q, config)
      : { kind: 'new', hits: [] }; // 理论上不可能(13h 恒填充);兜底而不是抛异常
    const tookMs = Date.now() - startedAt;
    return send(res, json({ ok: true, kind: result.kind, hits: result.hits, tookMs }));
  }

  // 116f: /api/steward/{visit,message,act} 住 13h-steward-runner.js(拼接顺序在本文件【之后】)。
  // 与 13 挂 13g 同一手法:直接写函数名会是前向边,故经 06i 的延迟绑定命名空间转交;未填充时本行
  // 是无操作,路由链继续往下走(最终 404)。命中与否仍以 res.writableEnded 为准。
  if (typeof StewardHooks.handleRunnerApiRoutes === 'function') {
    await StewardHooks.handleRunnerApiRoutes(req, res, pathname);
  }
}


// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116c(27 号文 §3.5 工具面 / §4 记忆层 / §11.2 读预算):管家工具集实现。
//
// 定位:12-tool-dispatch.js 里的 17 个 steward_* handler 只写一行 `StewardHooks.xxx(args, ctx)`,
// 真实实现全在这里。这样 12(工具层)→ 06i(引擎层命名空间)是后向边,13g(传输层)单向往 06i 挂方法,
// 全程零新增前向边。
//
// 铁律(§3.4 红线 + §3.3):
//   ① 管家「动如意」,不「动世界」—— 本文件不提供任何文件读写/shell/桌面/浏览器/联网/git 写能力;
//      要动手就 steward_thread_new / steward_thread_continue 委派给线程,由线程按自己的权限档执行。
//   ② 双重 fail-closed:stewardEnabledV1 !== true -> steward.disabled(零写入);
//      ctx.session.kind !== 'steward' -> steward.forbidden(普通会话即使拿到工具名也调不动)。
//   ③ 管家只能收紧,不能放宽:放行范围一律经 06i 的 stewardMayAct(目标线程 permissionMode, ...);
//      永久豁免清单(stewardToolPermanentlyExempt)在任何权限档都返回 propose_required。
//   ④ 每个写动作追加一行决策日志 `<data>/steward/decisions-v1.ndjson`,带 undoRef 与依据。
// ════════════════════════════════════════════════════════════════════════════

// ── 落盘常量(两个新面,已登记进 durable-state-inventory)────────────────────────────────────
const STEWARD_DECISIONS_FILE = 'decisions-v1.ndjson';
const STEWARD_MEMORY_FILE = 'memory-v1.json';
const STEWARD_MEMORY_SCHEMA = 1;

// ── 工具面数值口径 ──────────────────────────────────────────────────────────────────────
const STEWARD_SEARCH_LIMIT_DEFAULT = 10, STEWARD_SEARCH_LIMIT_MAX = 50;
const STEWARD_LAST_SAY_CHARS = STEWARD_DIGEST_LIMITS.lastSayChars;   // 200,与总览行同一口径
const STEWARD_READ_TAIL_DEFAULT = 6, STEWARD_READ_TAIL_MAX = 20;
const STEWARD_READ_CHARS_DEFAULT = 12000, STEWARD_READ_CHARS_MIN = 1000, STEWARD_READ_CHARS_MAX = 12000;
const STEWARD_READ_CALLS_PER_TURN = 6;      // §11.2:每回合 ≤6 次深读
const STEWARD_AUDIT_LIMIT_DEFAULT = 20, STEWARD_AUDIT_LIMIT_MAX = 100;
const STEWARD_TITLE_MAX = 80;
const STEWARD_STEER_TEXT_MAX = 2000;
// 116-2b steward_thread_note:管家给【已在跑】的线程补一句上下文。600 字上限比 steer_node 的 2000
// 紧得多 —— 它是"补一句",不是"改任务";前缀由服务端加,与 [用户插话] 的前缀纪律同精神(用户一眼
// 就能分清哪句是自己说的、哪句是管家加的)。
const STEWARD_NOTE_TEXT_MAX = 600;
const STEWARD_NOTE_PREFIX = '（管家补充）';
const STEWARD_PENDING_SUMMARY_MAX = 12;     // thread_status 里最多列几条待决摘要
const STEWARD_RUNS_MAX = 20;                // runs_status 单次最多返回几个 run digest

// ── 稳定信封 ────────────────────────────────────────────────────────────────────────────
// 形状与 105a observation_recall 同源:{ ok:false, error:<稳定码>, message:<人话> }。error 是模型要
// 分支的机器码,message 只给人看;调用方(模型)对 propose_required / quota_exceeded / steward.busy
// 一律不重试 —— schema description 里写明了。
function stewardFail(code, message, extra) {
  return { ok: false, error: String(code), message: String(message || code), ...(extra && typeof extra === 'object' ? extra : {}) };
}

// 管家会话身份:只认会话头上【显式】的 kind === 'steward'。有意不用 sessionKind()——那个归一化函数
// 只回 'mission'|'quick_ask',把管家会话也算成普通会话,拿它做身份判定等于把门拆了。
function stewardCtxIsSteward(ctx) {
  const session = ctx && ctx.session;
  return !!(session && typeof session === 'object' && session.kind === 'steward');
}

// 17 个工具共用的门控壳:开关 -> 身份 -> 实现 -> 异常兜底。单一判定点(12 的 handler 不重复判断)。
function stewardToolHandler(toolName, impl) {
  return async (args, ctx) => {
    let config = null;
    try { config = await readConfig(); } catch { config = null; }
    if (!config || config.stewardEnabledV1 !== true) {
      return stewardFail('steward.disabled', `${toolName} is unavailable: the workbench steward is disabled (stewardEnabledV1=false)`);
    }
    if (!stewardCtxIsSteward(ctx)) {
      return stewardFail('steward.forbidden', `${toolName} is only available to the workbench steward session (session.kind must be 'steward')`);
    }
    try {
      return await impl((args && typeof args === 'object') ? args : {}, ctx || {}, config);
    } catch (error) {
      const message = String((error && error.message) || error);
      logEvent({ kind: 'steward_tool_error', tool: toolName, message: message.slice(0, 400) });
      return stewardFail('steward.failed', `${toolName} failed: ${message}`);
    }
  };
}

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────
function stewardClampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function stewardClipSay(value) {
  const raw = stewardSanitizeText(value);
  return raw.length > STEWARD_LAST_SAY_CHARS ? raw.slice(0, STEWARD_LAST_SAY_CHARS) + '…' : raw;
}
// 会话头的原始 kind(未经 sessionKind 归一)。管家会话过滤与目标合法性判定都靠它。
async function stewardReadSessionHead(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  try {
    const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null);
    // 116-2a: 这条读路径绕过 loadSession(只要头,不装正文),所以要自己盖一次会话级权限档的内存
    // 覆盖表 —— 否则用户刚在活回合期间切了档、还没落盘,管家读到的就是旧档(见 02 的覆盖表头注)。
    return head && typeof head === 'object' ? applySessionPermissionModeOverride(head) : head;
  } catch { return null; }
}
function stewardRawKind(head) {
  const k = head && head.kind;
  return (typeof k === 'string' && k) ? k : (head && head.mission ? 'mission' : 'quick_ask');
}
// 线程的【生效】权限档 = resolvePermissionMode 的会话级 > 全局两层(§3.3「新线程用全局默认权限」)。
// 116-2a:改为直调 01-config 的解析器,与回合执行侧(runSessionTurn)用的是同一个函数、同一张白名单 ——
// 管家判「我能不能替它答」与线程实际按哪档执行,从此不可能各算各的。请求级那一层是回合内临时值,
// 不在会话头上,管家看不到也不该看到(它只对那一单当前执行链有效)。
function stewardThreadPermissionMode(head, config) {
  return resolvePermissionMode({ session: head, config });
}
function stewardLastAssistantText(session) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.content || '').trim()) return String(m.content);
  }
  return String((session && session.summary) || '');
}
function stewardEngineOf(head) {
  const route = (head && head.engineRoute && typeof head.engineRoute === 'object') ? head.engineRoute : null;
  if (!route) return { engine: '', model: '' };
  return {
    engine: route.engine === 'openai' ? 'openai' : (route.agentCliType || 'claude'),
    model: String(route.model || ''),
    providerId: String(route.providerId || ''),
  };
}

// ── 决策日志(§3.5「所有写工具返回 undoRef,决策日志记录」)───────────────────────────────
// 与 inbox 同款 append-only 纪律:先 repairMissionChangeTornTail 把尾部半行截干净,再整行 appendFile,
// 全部经一条 per-process 串行链。开关关时根本走不到这里(门控壳先返回 steward.disabled)。
const stewardDecisionsPath = () => path.join(stewardDir(), STEWARD_DECISIONS_FILE);
let stewardDecisionChain = Promise.resolve();
let stewardDecisionSeq = 0;
// 116-2b:自理动作的溯源基底。13h 在【工具入参】上挂一个内部字段 stewardBasis({inboxSeq,auto,origin}),
// 由下面两个实现并进决策日志的 basis —— 事后能分清「这一次重试是管家自理做的、由第 N 条收件箱
// 事件触发」。它不在工具 schema 里(additionalProperties:false),模型即使编造出来也只影响日志注解,
// 不影响任何判定;args 照旧只记摘要字段,这一坨不进 args。
function stewardBasisOf(args, extra) {
  const raw = (args && typeof args.stewardBasis === 'object' && args.stewardBasis) ? args.stewardBasis : null;
  const base = (extra && typeof extra === 'object') ? { ...extra } : {};
  if (!raw) return base;
  if (raw.inboxSeq != null) base.inboxSeq = Number(raw.inboxSeq) || 0;
  if (raw.auto != null) base.auto = raw.auto === true;
  if (raw.origin) base.origin = String(raw.origin).slice(0, 40);
  return base;
}

function stewardAppendDecision(row) {
  const record = {
    seq: ++stewardDecisionSeq,
    at: nowIso(),
    tool: String((row && row.tool) || ''),
    args: (row && row.args && typeof row.args === 'object') ? row.args : {},
    targetSessionId: String((row && row.targetSessionId) || ''),
    permissionMode: String((row && row.permissionMode) || ''),
    mayAct: String((row && row.mayAct) || ''),
    undoRef: (row && row.undoRef) || null,
    basis: (row && row.basis && typeof row.basis === 'object') ? row.basis : {},
  };
  const line = JSON.stringify(record) + '\n';
  stewardDecisionChain = stewardDecisionChain.then(async () => {
    await fsp.mkdir(stewardDir(), { recursive: true });
    const file = stewardDecisionsPath();
    await repairMissionChangeTornTail(file);
    await fsp.appendFile(file, line, 'utf8');
  }).catch(() => {}); // 记账失败绝不回滚已经做完的动作(与 usage ledger 同款 fire-and-forget 纪律)
  return record;
}

// ── 管家记忆存储(§4)────────────────────────────────────────────────────────────────────
const stewardMemoryPath = () => path.join(stewardDir(), STEWARD_MEMORY_FILE);
let stewardMemoryChain = Promise.resolve();
function stewardEmptyMemoryStore() { return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: '', entries: [] }; }
function stewardNormalizeMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const kind = String(raw.kind || '');
  const text = String(raw.text || '');
  if (!id || !STEWARD_MEMORY_KINDS.includes(kind) || !text) return null;
  const confidence = Number(raw.confidence);
  return {
    id,
    kind,
    text: text.slice(0, STEWARD_MEMORY_LIMITS.textChars),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
    sourceSessionId: String(raw.sourceSessionId || ''),
    sourceSeq: Math.max(0, Number(raw.sourceSeq) || 0),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
    lastUsedAt: String(raw.lastUsedAt || ''),
    useCount: Math.max(0, Number(raw.useCount) || 0),
    state: raw.state === 'vetoed' ? 'vetoed' : 'active',
  };
}
async function stewardReadMemoryStore() {
  let raw = null;
  try { raw = safeJsonParse(await fsp.readFile(stewardMemoryPath(), 'utf8'), null); } catch { raw = null; }
  // 损坏/缺失/错 schema = 空库(不抢救、不 mkdir):记忆是旁路增强,坏了不该拖住任何回合。
  if (!raw || raw.schema !== STEWARD_MEMORY_SCHEMA || !Array.isArray(raw.entries)) return stewardEmptyMemoryStore();
  const entries = [];
  for (const item of raw.entries) {
    const entry = stewardNormalizeMemoryEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= STEWARD_MEMORY_LIMITS.maxEntries) break;
  }
  return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: String(raw.updatedAt || ''), entries };
}
// 读-改-写全程串在一条 per-process 链上(同 usage/inbox 纪律),两次并发写不会互相盖掉。
function stewardMutateMemory(mutator) {
  const next = stewardMemoryChain.then(async () => {
    const store = await stewardReadMemoryStore();
    const outcome = await mutator(store);
    if (outcome && outcome.persist) {
      store.updatedAt = nowIso();
      await fsp.mkdir(stewardDir(), { recursive: true });
      await atomicWriteJson(stewardMemoryPath(), store);
    }
    return outcome ? outcome.result : null;
  });
  stewardMemoryChain = next.catch(() => {});
  return next;
}

// ── §11.2 深读预算:每回合 ≤6 次、累计字符 ≤ stewardReadBudgetChars ─────────────────────────
// 桶键与 105a observation_recall 同款:会话 id + 回合序号(= providerHistory 里 user 消息条数,回合内
// 稳定、下回合自增,不需要新管线)。每会话保留最近 4 个桶,全局最多 64 个会话,先进先出。
const _stewardReadBudget = new Map(); // sessionId -> Map(turnKey -> { calls, chars })
function stewardReadBucket(sessionId, turnKey) {
  let buckets = _stewardReadBudget.get(sessionId);
  if (!buckets) { buckets = new Map(); _stewardReadBudget.set(sessionId, buckets); }
  while (_stewardReadBudget.size > 64) _stewardReadBudget.delete(_stewardReadBudget.keys().next().value);
  if (!buckets.has(turnKey)) {
    buckets.set(turnKey, { calls: 0, chars: 0 });
    while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
  }
  return buckets.get(turnKey);
}
function stewardTurnKeyOf(ctx) {
  const session = ctx && ctx.session;
  const history = Array.isArray(session && session.providerHistory) ? session.providerHistory : [];
  return history.reduce((n, m) => n + (m && m.role === 'user' ? 1 : 0), 0);
}

// ════════════════════════════════════════════════════════════════════════════
// 观察族(tier read)—— 只读如意自身账面,零副作用,不写任何持久化。
// ════════════════════════════════════════════════════════════════════════════

// 1) steward_self_status —— 复用 108c 的装配函数(12-tool-dispatch 的 buildWorkbenchSelfStatus),
//    再追加一个 steward 段(管家设置掩码 + 收件箱状态)。不新造任何事实源。
const STEWARD_CONFIG_KEYS = Object.freeze([
  'stewardEnabledV1', 'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour',
  'stewardMaxCostPerDay', 'stewardAutoActions', 'stewardContextBudgetTokens', 'stewardReadBudgetChars',
  'stewardVisitIdleMinutes', 'stewardConversationRetention',
]);
async function stewardImplSelfStatus(args, ctx, config) {
  const wantSteward = !args.section || args.section === 'all' || args.section === 'steward';
  // section:'steward' 只要身份 + 管家段(省上下文);其余 section 原样透传给 108c 的装配函数。
  const base = await buildWorkbenchSelfStatus({ section: args.section === 'steward' ? 'identity' : args.section }, ctx);
  if (!wantSteward) return base;
  const stewardConfig = {};
  // 全部是标量/小对象开关,天生不含 apiKey/token;仍按白名单逐键回显,防将来新增敏感键被顺带带出。
  for (const key of STEWARD_CONFIG_KEYS) stewardConfig[key] = config[key];
  return { ...base, steward: { config: stewardConfig, inbox: await stewardInboxState(config) } };
}

// 2) steward_threads_search —— 113b 的会话内容搜索核心(不走 HTTP)+ 标题词法兜底。
async function stewardImplThreadsSearch(args, ctx, config) {
  const q = String(args.q || '').trim();
  const limit = stewardClampInt(args.limit, 1, STEWARD_SEARCH_LIMIT_MAX, STEWARD_SEARCH_LIMIT_DEFAULT);
  if (!q) return { ok: true, query: '', results: [], indexed: 0, reason: 'query_empty' };
  const metas = await listSessions().catch(() => []);
  const byId = new Map(metas.map(meta => [meta.id, meta]));

  let ranked = [];        // [{ id, score }]
  let indexed = 0;
  let degraded = '';
  if (sessionSearchIndexEnabled(config)) {
    // 内容索引在:直接用 113b 的核心函数(GET /api/sessions/search 背后那一个)。
    const found = await searchSessionsByContent(q, Math.min(STEWARD_SEARCH_LIMIT_MAX, limit + 10)).catch(() => null);
    if (found && Array.isArray(found.results)) {
      indexed = Number(found.indexed) || 0;
      ranked = found.results.map(row => ({ id: row.id, score: Number(row.score) || 0 }));
    } else degraded = 'search_failed';
  } else degraded = 'index_disabled';
  if (!ranked.length) {
    // 退化词法:只看标题与摘要(不读正文),命中即按更新时间排序 —— 索引关着时仍然能找到线程。
    const needle = q.toLowerCase();
    ranked = metas
      .filter(meta => (String(meta.title || '') + ' ' + String(meta.summary || '')).toLowerCase().includes(needle))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map(meta => ({ id: meta.id, score: 0 }));
    if (!degraded) degraded = 'lexical_fallback';
  }

  const index = await getPretenderProjectionIndex().catch(() => null);
  const slices = new Map(((index && index.sessions) || []).map(row => [row.sessionId, row]));
  // 116g:同一事项被多条命中线程共用时只读一次事项文件(结果上限 50,不做无界扫描)。
  const missionTitles = new Map();
  const missionTitleOf = async missionId => {
    if (!missionTitles.has(missionId)) {
      const container = await readMissionContainer(missionId).catch(() => null);
      missionTitles.set(missionId, container ? stewardSanitizeText(container.title) : '');
    }
    return missionTitles.get(missionId);
  };
  const results = [];
  for (const row of ranked) {
    if (results.length >= limit) break;
    const head = await stewardReadSessionHead(row.id);
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') continue;                       // §11.3:管家自己的会话永不出现在结果里
    const meta = byId.get(row.id) || {};
    const slice = slices.get(row.id) || null;
    const card = slice ? overlayMissionCard(slice) : null;
    const derived = card ? stewardThreadStateFromCard(card) : deriveStewardThreadState({ kind: rawKind === 'mission' ? 'mission' : 'quick_ask' });
    const missionId = (slice && slice.missionId) || (head && sessionMissionId(head)) || row.id;
    results.push({
      sessionId: row.id,
      missionId,
      // 116g:命中的线程属于哪个【事项】。未归类线程这里是空串(事项标题就是线程标题,不重复说)。
      missionTitle: await missionTitleOf(missionId),
      title: stewardSanitizeText(meta.title || (head && head.title) || ''),
      kind: rawKind,
      state: derived.state,
      stateLabel: derived.label,
      // 诚实:总览与搜索结果里的「最后一句」用会话摘要(= 助手原话经既有收尾裁剪),不做模型改写。
      lastAssistantText: stewardClipSay(meta.summary || (head && head.summary) || ''),
      updatedAt: String(meta.updatedAt || (head && head.updatedAt) || ''),
      score: Number(row.score) || 0,
    });
  }
  return { ok: true, query: q, results, indexed, ...(degraded ? { degraded } : {}) };
}

// 3) steward_thread_status —— 五态优先取投影 card,没有则按 mission-state.js 同一判据在服务端派生。
function stewardPendingOneLine(iv) {
  const type = String((iv && iv.type) || '');
  if (type === 'permission') return `工具 ${stewardSanitizeText(iv.toolName || '?')}(${stewardSanitizeText(iv.tier || 'exec')} 级)等待放行`;
  if (type === 'question') {
    const first = (Array.isArray(iv && iv.questions) ? iv.questions : [])[0];
    return stewardClipSay((first && (first.question || first.title)) || '等待你回答');
  }
  if (type === 'plan') return stewardClipSay(iv.planSummary || '计划等待批准');
  if (type === 'pool') return stewardClipSay(iv.task || '任务池提案等待批准');
  if (type === 'replan') return stewardClipSay(iv.summary || '重规划提案等待批准');
  return stewardClipSay(type || '未知待决');
}
async function stewardImplThreadStatus(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  const rawKind = stewardRawKind(head);
  if (rawKind === 'steward') return stewardFail('not_found', 'the steward session is not a thread');

  const index = await getPretenderProjectionIndex().catch(() => null);
  const slice = ((index && index.sessions) || []).find(row => row.sessionId === sessionId) || null;
  const card = slice ? overlayMissionCard(slice) : null;
  const derived = card
    ? stewardThreadStateFromCard(card)
    : deriveStewardThreadState({
      kind: rawKind === 'mission' ? 'mission' : 'quick_ask',
      autoMode: head.mission && head.mission.autoMode,
      resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
      pending: await missionPendingCounts(sessionId, [], null).catch(() => null),
      activeTurn: activeChildren.has(sessionId),
      runCount: 0,
      turnSeq: head.turnSeq,
    });

  const interventions = (await readInterventions(sessionId).catch(() => []))
    .filter(iv => iv && iv.status === 'pending')
    .slice(0, STEWARD_PENDING_SUMMARY_MAX)
    .map(iv => ({ id: String(iv.id), type: String(iv.type || ''), toolName: String(iv.toolName || ''), tier: String(iv.tier || ''), summary: stewardPendingOneLine(iv), interventionVersion: Number(iv.interventionVersion) || 0 }));

  const session = await loadSession(sessionId).catch(() => null);
  const usage = (slice && slice.usage) || null;
  const engine = stewardEngineOf(head);
  const lastRun = card && card.lastRun ? card.lastRun : null;
  // 116g:这条线程属于哪个【事项】,以及那个事项整体是什么状态(由 06i 的 aggregateMissionState 单点
  // 纯函数按全部子线程五态算出;未归类事项 = 只有它自己一条线程,聚合态就等于自己的五态)。
  const missionOfThread = sessionMissionId(head) || sessionId;
  const missionRow = (await buildMissionAggregateRows({ includeArchived: true }).catch(() => null) || { rows: [] })
    .rows.find(row => row.missionId === missionOfThread) || null;
  return {
    ok: true,
    sessionId,
    missionId: sessionMissionId(head),
    mission: {
      missionId: missionOfThread,
      title: stewardSanitizeText(missionRow ? missionRow.title : (head.title || '')),
      aggregateState: missionRow ? missionRow.aggregateState : derived.state,
      threadCount: missionRow ? missionRow.threadCount : 1,
      derived: missionRow ? missionRow.derived : true,
    },
    title: stewardSanitizeText(head.title || ''),
    kind: rawKind,
    state: derived.state,
    stateLabel: derived.label,
    stateSources: derived.sources,
    activeTurn: activeChildren.has(sessionId),
    currentAction: lastRun ? stewardSanitizeText(`班组运行 ${lastRun.id || ''} · ${lastRun.status || ''}`) : (activeChildren.has(sessionId) ? '回合进行中' : ''),
    lastStep: lastRun ? stewardSanitizeText(`${lastRun.nodeCount || 0} 个节点 · eventSeq ${lastRun.eventSeq || 0}`) : '',
    pending: interventions,
    pendingCounts: (card && card.pending) || await missionPendingCounts(sessionId, [], null).catch(() => null),
    // permissionMode 保持既有语义 =【生效】档(既有断言与提示词都读它;断言只加不改)。
    permissionMode: stewardThreadPermissionMode(head, config),
    permissionLabel: stewardPermissionLabel(stewardThreadPermissionMode(head, config)),
    // 116-2a 只加两个字段,把「生效档」与「这条线程自己定的档」显式分开:
    //   effectivePermissionMode —— 与 permissionMode 同值,名字自解释,给 117 的 chip 与管家提示词读;
    //   sessionPermissionMode —— 会话级设置,null = 没定、跟着全局走(chip 的实底/浅底就看它)。
    effectivePermissionMode: stewardThreadPermissionMode(head, config),
    sessionPermissionMode: sessionPermissionModeOf(head),
    engine: engine.engine,
    model: engine.model,
    providerId: engine.providerId || '',
    usage: usage ? { inTok: usage.inTok, outTok: usage.outTok, cachedInTok: usage.cachedInTok, turns: usage.turns, costsByCurrency: usage.costsByCurrency } : null,
    turnSeq: Math.max(0, Number(head.turnSeq) || 0),
    updatedAt: String(head.updatedAt || ''),
    lastAssistantText: stewardClipSay(session ? stewardLastAssistantText(session) : (head.summary || '')),
  };
}

// 4) steward_thread_read —— §11.2 按需层。配额与预算在写任何东西之前先扣;读到的内容【不写入任何
//    持久化】(记忆只记用户本人陈述,深读结果不进记忆,也不落决策日志)。
function stewardToolCallLine(call) {
  const name = stewardSanitizeText((call && call.name) || 'tool');
  let inputHint = '';
  try {
    const raw = JSON.stringify((call && call.input) || {});
    inputHint = stewardSanitizeText(raw).slice(0, 160);
  } catch { inputHint = '{…}'; }
  let resultChars = 0;
  try { resultChars = JSON.stringify((call && call.result) != null ? call.result : '').length; } catch { resultChars = -1; }
  // 工具输出只给长度(与既有 observation reducer 的缩减视图同一诚实口径:不给全文,给可回读的把手)。
  return `[工具] ${name} ${inputHint} → ${resultChars >= 0 ? resultChars + ' 字符' : '不可序列化'}${call && call.id ? ' (id=' + stewardSanitizeText(call.id) + ')' : ''}`;
}
async function stewardImplThreadRead(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const tail = stewardClampInt(args.tail, 1, STEWARD_READ_TAIL_MAX, STEWARD_READ_TAIL_DEFAULT);
  const maxChars = stewardClampInt(args.maxChars, STEWARD_READ_CHARS_MIN, STEWARD_READ_CHARS_MAX, STEWARD_READ_CHARS_DEFAULT);
  const budgetChars = stewardClampInt(config.stewardReadBudgetChars, 4000, 400000, 48000);
  const stewardSessionId = String((ctx.session && ctx.session.id) || 'steward');
  const bucket = stewardReadBucket(stewardSessionId, stewardTurnKeyOf(ctx));
  if (bucket.calls >= STEWARD_READ_CALLS_PER_TURN) {
    return stewardFail('quota_exceeded', `steward_thread_read quota exhausted for this turn (${STEWARD_READ_CALLS_PER_TURN} deep reads); answer from the overview instead of retrying`);
  }
  if (bucket.chars >= budgetChars) {
    return stewardFail('budget_exceeded', `steward read budget exhausted for this visit (${budgetChars} chars, stewardReadBudgetChars); answer from the overview instead of retrying`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('not_found', 'the steward session is not a thread');
  const session = await loadSession(sessionId).catch(() => null);
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);

  // 消耗一次配额:一旦真的开读就计数(不论最终返回多少字符),否则「读了但没算」就是预算漏洞。
  bucket.calls += 1;

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const turnSeqs = [...new Set(messages.map(m => Number(m && m.turnSeq)).filter(Number.isFinite))].sort((a, b) => a - b);
  const wanted = new Set(turnSeqs.slice(-tail));
  const rows = [];
  for (const m of messages) {
    if (!m) continue;
    const seq = Number(m.turnSeq);
    if (Number.isFinite(seq) && !wanted.has(seq)) continue;
    if (!Number.isFinite(seq) && turnSeqs.length) continue; // 无 turnSeq 的历史消息在有回合号时跳过
    if (m.role === 'user') rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'user', text: stewardSanitizeBlock(m.content || '') });
    else if (m.role === 'assistant') {
      rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'assistant', text: stewardSanitizeBlock(m.content || '') });
      for (const call of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
        rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'tool', text: stewardToolCallLine(call) });
      }
    }
  }
  // 超出 maxChars 时从【最早】的行开始丢(最近的对话最有用),并如实标 truncated。
  let used = 0, cut = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    used += rows[i].text.length + 16;
    if (used > maxChars) { cut = i + 1; break; }
    cut = i;
  }
  const kept = rows.slice(cut);
  const chars = kept.reduce((n, r) => n + r.text.length, 0);
  bucket.chars += chars;
  return {
    ok: true,
    sessionId,
    tail,
    turnSeqs: [...wanted].sort((a, b) => a - b),
    truncated: cut > 0,
    chars,
    quota: { callsUsed: bucket.calls, callsMax: STEWARD_READ_CALLS_PER_TURN, charsUsed: bucket.chars, charsMax: budgetChars },
    rows: kept,
  };
}

// 5) steward_runs_status —— 复用 08 的 listAgentRuns + 13d 的 missionRunDigest(不另造 digest)。
async function stewardImplRunsStatus(args, ctx, config) {
  const explicit = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !explicit) return stewardFail('not_found', 'invalid sessionId');
  let sessionIds = [];
  if (explicit) sessionIds = [explicit];
  else {
    const index = await getPretenderProjectionIndex().catch(() => null);
    sessionIds = ((index && index.sessions) || []).filter(row => row.card).map(row => row.sessionId);
  }
  const runs = [];
  for (const sid of sessionIds) {
    if (runs.length >= STEWARD_RUNS_MAX) break;
    const head = await stewardReadSessionHead(sid);
    if (stewardRawKind(head) === 'steward') continue;
    for (const run of await listAgentRuns(sid).catch(() => [])) {
      if (runs.length >= STEWARD_RUNS_MAX) break;
      const live = activeAgentRuns.get(run.id);
      const mem = live && live.run ? live.run : run;
      const nodes = Array.isArray(mem.nodes) ? mem.nodes : [];
      runs.push({
        sessionId: sid,
        runId: String(run.id || ''),
        status: String(mem.status || ''),
        live: !!live,
        paused: !!(live && live.paused),
        nodes: { total: nodes.length, done: nodes.filter(n => n && n.status === 'done').length, failed: nodes.filter(n => n && n.status === 'failed').length, running: nodes.filter(n => n && (n.status === 'running' || n.status === 'waiting_resource')).length },
        // 等待原因单一化:优先「等你」(池提案待批),其次「等锁」(资源),再次「已暂停」。
        waitReason: (Array.isArray(mem.taskPool) ? mem.taskPool : []).some(p => p && p.status === 'proposed') ? '等你批任务池提案'
          : nodes.some(n => n && n.status === 'waiting_resource') ? '等资源锁'
            : (live && live.paused) ? '已暂停' : '',
        resumeTier: String(mem.resumeTier || ''),
        digest: missionRunDigest(mem, !!live),
      });
    }
  }
  return { ok: true, runs, truncated: runs.length >= STEWARD_RUNS_MAX };
}

// 6) steward_inbox_read —— 直接委托 116b 的原始读取器(同一实现,不复制第二份)。
async function stewardImplInboxRead(args) {
  return { ok: true, ...await stewardInboxRead({ since: args.since, limit: args.limit }) };
}

// 7) steward_usage —— 用量台账按会话/按日汇总;管家自身开销(kind:'aux', note:'steward')单列。
function stewardEmptyUsageBucket() { return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} }; }
function stewardAddUsageRow(bucket, row) {
  bucket.turns += 1;
  bucket.inTok += Number(row.inTok) || 0;
  bucket.outTok += Number(row.outTok) || 0;
  bucket.cachedInTok += Number(row.cachedInTok) || 0;
  const cost = Number(row.cost);
  const currency = typeof row.currency === 'string' ? row.currency : '';
  // costTrusted === false 的行(套餐制的名义金额)不进真实费用合计 —— 与 13e 的 addMissionUsageRow 同口径。
  if (row.costTrusted !== false && currency && Number.isFinite(cost)) {
    bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + cost) * 1e6) / 1e6;
  }
}
async function stewardImplUsage(args) {
  const sessionId = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !sessionId) return stewardFail('not_found', 'invalid sessionId');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args.day || '')) ? String(args.day) : '';
  const rows = await readUsageRows(0).catch(() => []);
  const total = stewardEmptyUsageBucket();
  const steward = stewardEmptyUsageBucket();
  const bySession = new Map();
  const byDay = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (sessionId && String(row.sessionId || '') !== sessionId) continue;
    const rowDay = usageDayKey(Date.parse(row.ts));
    if (day && rowDay !== day) continue;
    stewardAddUsageRow(total, row);
    if (row.kind === 'aux' && row.note === 'steward') stewardAddUsageRow(steward, row);
    const sid = String(row.sessionId || '');
    if (!bySession.has(sid)) bySession.set(sid, stewardEmptyUsageBucket());
    stewardAddUsageRow(bySession.get(sid), row);
    if (!byDay.has(rowDay)) byDay.set(rowDay, stewardEmptyUsageBucket());
    stewardAddUsageRow(byDay.get(rowDay), row);
  }
  const topSessions = [...bySession.entries()]
    .sort((a, b) => (b[1].inTok + b[1].outTok) - (a[1].inTok + a[1].outTok))
    .slice(0, 20)
    .map(([sid, bucket]) => ({ sessionId: sid, ...bucket }));
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31).map(([d, bucket]) => ({ day: d, ...bucket }));
  return { ok: true, scope: { sessionId: sessionId || '', day: day || '' }, total, steward, bySession: topSessions, byDay: days };
}

// 8) steward_health —— computeHealth 的原始项(人话映射留给前端/管家自己说)。
async function stewardImplHealth(args, ctx, config) {
  const { health } = await computeHealth(config);
  return { ok: true, health: (Array.isArray(health) ? health : []).map(h => ({ id: h.id, ok: h.ok, detail: h.detail })) };
}

// 9) steward_audit_tail —— 既有 collectAudit(内部已过 redact 脱敏),只取 workbench 源(桌面 MCP 审计
//    要起桥,管家的「刚才发生了什么」不该为此拉起一个子进程)。
async function stewardImplAuditTail(args, ctx, config) {
  const limit = stewardClampInt(args.limit, 1, STEWARD_AUDIT_LIMIT_MAX, STEWARD_AUDIT_LIMIT_DEFAULT);
  const audit = await collectAudit(config, { limit, sourceFilter: 'workbench', typeFilter: null });
  return { ok: true, entries: (audit && audit.entries) || [], truncated: !!(audit && audit.truncated) };
}

// ════════════════════════════════════════════════════════════════════════════
// 线程族(tier edit)—— 建线程/递话/改名。全部返回 undoRef 并落决策日志。
// ════════════════════════════════════════════════════════════════════════════

// 后台回合:fire-and-forget(不 await)。管家回合不能被线程回合的时长绑住 —— 它要立刻回一句
// 「已经交给线程 X 去做了」。异常只写 logEvent,绝不冒泡到工具返回值(那会让模型以为没交出去)。
function stewardLaunchTurn(input, tool) {
  const promise = runSessionTurn({ ...input, onEvent: () => {} });
  promise.then(result => {
    logEvent({ kind: 'steward_turn_done', tool, sessionId: String(input.sessionId || ''), ok: !!(result && result.ok), stopped: !!(result && result.stopped) });
  }).catch(error => {
    logEvent({ kind: 'steward_turn_error', tool, sessionId: String(input.sessionId || ''), message: String((error && error.message) || error).slice(0, 400) });
  });
  return promise;
}

// 10) steward_thread_new —— 委托书。原话逐字在最前,管家补充经中和后进围栏(见 06i buildStewardBrief)。
async function stewardImplThreadNew(args, ctx, config) {
  const brief = (args.brief && typeof args.brief === 'object') ? args.brief : null;
  if (!brief || !String(brief.userText || '').trim()) {
    return stewardFail('invalid_request', 'brief.userText is required and must contain the user\'s own words verbatim');
  }
  const composed = buildStewardBrief(brief);
  const requestedMissionId = args.missionId ? safeSessionId(args.missionId) : '';
  if (args.missionId && !requestedMissionId) return stewardFail('invalid_request', 'invalid missionId');

  const session = await createSession({
    title: args.title ? String(args.title).slice(0, STEWARD_TITLE_MAX) : undefined,
    cwd: args.cwd ? String(args.cwd) : undefined,
  });
  session.kind = 'mission';                                   // 线程 = 任务线程(不是速问)
  if (requestedMissionId) session.missionId = requestedMissionId; // 归入既有事项;否则 createSession 已置 missionId = 自身 id
  // 委托书落盘:原话与管家补充【分开存】,供 117 显示与用户「改一下」;不把拼好的整段存成一坨。
  session.brief = {
    schema: 1,
    by: 'steward',
    createdAt: nowIso(),
    userText: composed.userText,
    supplement: composed.supplement,
    truncated: composed.truncated,
    memoryIds: composed.memoryIds,
    playbookId: String(brief.playbookId || ''),
  };
  await saveSession(session);
  // 116g:显式指定了事项就写反向索引(事项文件不存在 = 「未归类」,missionIndexAdd 自身 no-op ——
  // 新会话的 missionId === sessionId 那条常规路径永远不会凭空建出一个事项文件)。
  if (requestedMissionId) await missionIndexAdd(requestedMissionId, session.id);

  stewardLaunchTurn({
    sessionId: session.id,
    message: composed.text,
    cwd: session.cwd,
    source: 'steward',
    requestMeta: { tool: 'steward_thread_new' },
  }, 'steward_thread_new');

  const undoRef = { kind: 'thread_new', sessionId: session.id };
  stewardAppendDecision({
    tool: 'steward_thread_new',
    args: { title: session.title, missionId: session.missionId, briefChars: composed.text.length, supplementChars: composed.supplement.length, truncated: composed.truncated },
    targetSessionId: session.id,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: { memoryIds: composed.memoryIds },
  });
  return { ok: true, sessionId: session.id, missionId: sessionMissionId(session), title: session.title, briefTruncated: composed.truncated, undoRef };
}

// 11) steward_thread_continue —— 原话直递。undoRef 锚在递话【前】的 turnSeq(rewindSession 的主键)。
async function stewardImplThreadContinue(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const message = String(args.message == null ? '' : args.message);
  if (!message.trim()) return stewardFail('invalid_request', 'message is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be a relay target');
  // 忙锁复用既有活回合判定(activeChildren —— 与 mission 五态的 activeTurn 同一权威信号),不新造锁。
  if (activeChildren.has(sessionId)) return stewardFail('steward.busy', `thread ${sessionId} already has a turn in flight; do not retry — tell the user or wait for it to settle`);

  // 递话【前】的 turnSeq:检查点与 rewindSession 都以它为锚(rewindSession(sessionId, targetTurnSeq, true))。
  const undoRef = { kind: 'turn', sessionId, turnSeq: Math.max(0, Number(head.turnSeq) || 0) };
  const basis = stewardBasisOf(args);
  stewardLaunchTurn({
    sessionId,
    message,
    source: 'steward',
    requestMeta: { tool: 'steward_thread_continue', ...(basis.origin ? { origin: basis.origin } : {}) },
  }, 'steward_thread_continue');

  stewardAppendDecision({
    tool: 'steward_thread_continue',
    args: { messageChars: message.length },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef,
    basis,
  });
  return { ok: true, sessionId, undoRef };
}

// 12) steward_thread_rename —— undoRef 带旧标题(一键改回)。
async function stewardImplThreadRename(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const title = String(args.title == null ? '' : args.title).replace(/[\r\n]+/g, ' ').trim().slice(0, STEWARD_TITLE_MAX);
  if (!title) return stewardFail('invalid_request', 'title is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be renamed by a tool');
  // 与 thread_continue 同一条忙锁:改名走 loadSession -> saveSession 的读改写,活回合期间那份内存副本会
  // 在回合的收尾 save 之后落盘,把回合刚写进去的消息用陈旧副本盖掉(会话正文缩水 = 头计数与正文行数错位)。
  // 经典壳的重命名由用户手动触发、撞上的概率低;管家是自动的,必须显式挡住。
  if (activeChildren.has(sessionId)) return stewardFail('steward.busy', `thread ${sessionId} has a turn in flight; rename it after the turn settles`);
  const previousTitle = String(head.title || '');
  // 复用既有的会话元数据更新原语(PUT /api/sessions/:id 背后那一个),不另开第二条改名写路径。
  const session = await updateSessionMeta(sessionId, { title });
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
  const undoRef = { kind: 'title', sessionId, previousTitle };
  stewardAppendDecision({
    tool: 'steward_thread_rename',
    args: { title, previousTitle },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: {},
  });
  return { ok: true, sessionId, title, undoRef };
}

// 12b) steward_thread_permission —— 线程权限【只降不升】(116-2a)。
// 这是永久豁免清单第 2 条(「管家不得自我扩权:放宽任一线程的 permissionMode」)的机器实现:
// 目标档必须严格比【当前生效档】更紧(STEWARD_PERMISSION_RANK 的单调性判定),否则一律
// steward.widen_forbidden —— 放宽只能由用户在界面上改,那条路上还有一道「切到全自动须二次确认」。
// 不加忙锁:116-2a 把 updateSessionMeta 的读改写竞态改成了「活回合期间延后落盘 + 内存覆盖表立刻生效」,
// 收紧对下一回合立即有效且不会盖掉在途回合刚写的消息 —— 这正是收紧最该起效的时刻,拒绝反而危险。
async function stewardImplThreadPermission(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const target = String(args.permissionMode == null ? '' : args.permissionMode);
  if (!PERMISSION_MODES.includes(target)) {
    return stewardFail('invalid_request', `permissionMode must be one of ${PERMISSION_MODES.join('/')}`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no thread permission');

  const current = stewardThreadPermissionMode(head, config);
  if (!stewardMayTightenTo(current, target)) {
    return stewardFail('steward.widen_forbidden',
      `线程 ${sessionId} 当前权限是「${stewardPermissionLabel(current)}」,管家只能收紧、不能放宽或平移到「${stewardPermissionLabel(target)}」;要放宽请让用户在界面上改`,
      { sessionId, permissionMode: current, requested: target });
  }
  const previous = sessionPermissionModeOf(head); // 会话级旧值(null = 之前跟着全局走)
  const session = await updateSessionMeta(sessionId, { permissionMode: target });
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
  const undoRef = { kind: 'permission', sessionId, previous };
  stewardAppendDecision({
    tool: 'steward_thread_permission',
    args: { permissionMode: target, previous },
    targetSessionId: sessionId,
    permissionMode: target,
    mayAct: 'auto',
    undoRef,
    basis: { previousEffective: current },
  });
  return { ok: true, sessionId, permissionMode: target, effectivePermissionMode: target, previousEffective: current, previous, undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 决策族(tier exec)—— 替用户答复待决 / 控制班组。放行范围一律经 stewardMayAct + 永久豁免。
// ════════════════════════════════════════════════════════════════════════════

// 13) steward_decide。判定顺序(顺序即安全):
//     读待决 -> 永久豁免正则 -> stewardMayAct(目标线程权限) -> 才真正 decideIntervention。
//     前两道拦下的一律【不落决策日志】—— 没做决定就没有决定可记(只记「做过什么」,不记「想做什么」)。
async function stewardImplDecide(args, ctx, config) {
  const missionId = safeSessionId(args.missionId);
  const interventionId = String(args.interventionId || '');
  const action = String(args.action || '');
  if (!missionId || !interventionId || !action) return stewardFail('invalid_request', 'missionId, interventionId and action are required');
  const head = await stewardReadSessionHead(missionId);
  if (!head || !head.id) return stewardFail('not_found', 'mission or intervention not found');
  const current = (await readInterventions(missionId).catch(() => [])).find(iv => iv && String(iv.id) === interventionId);
  if (!current) return stewardFail('not_found', 'mission or intervention not found');

  const type = String(current.type || '');
  const toolName = String(current.toolName || '');
  const tier = String(current.tier || '');
  const permissionMode = stewardThreadPermissionMode(head, config);

  // §3.3 永久豁免:命中即降级为提议,任何权限档都不放行 —— 这类动作没有 checkpoint 可回滚。
  if (type === 'permission' && stewardToolPermanentlyExempt(toolName)) {
    return stewardFail('propose_required', `工具 ${stewardSanitizeText(toolName)} 属于永久豁免清单(不可撤销且外溢的动作),任何权限档都必须由用户亲自决定`, {
      reason: 'permanently_exempt', missionId, interventionId, type, toolName, permissionMode,
    });
  }
  const mayAct = stewardMayAct(permissionMode, type === 'permission' ? 'permission' : type, tier);
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,这类待决只能由用户决定;把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', missionId, interventionId, type, toolName, tier, permissionMode,
    });
  }

  const expectedVersion = Number.isInteger(args.expectedVersion) && args.expectedVersion >= 0
    ? args.expectedVersion
    : Math.max(0, Number(current.interventionVersion) || 0);
  const result = await decideIntervention({
    missionId,
    interventionId,
    payload: { action, ...(args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload : {}) },
    expectedVersion,
    idempotencyKey: makeId('stew'),
    source: 'steward',
    decidedBy: 'steward',
    contractRequest: true,
  });
  const body = (result && result.body) || {};
  // permission 放行后不可撤销(工具已经开跑);其余三类锚回会话 turnSeq(可回退检查点)。
  const undoRef = body.ok === true
    ? (type === 'permission' && action === 'allow'
      ? { kind: 'none', note: '不可撤销' }
      : { kind: 'turn', sessionId: missionId, turnSeq: Math.max(0, Number(head.turnSeq) || 0) })
    : null;
  if (body.ok === true) {
    stewardAppendDecision({
      tool: 'steward_decide',
      args: { type, action, toolName, tier, interventionId, expectedVersion },
      targetSessionId: missionId,
      permissionMode,
      mayAct,
      undoRef,
      basis: { interventionId, interventionVersion: Number(body.interventionVersion) || 0 },
    });
    return { ...body, undoRef };
  }
  // 失败按 decideIntervention 的稳定 reason 原样回传(version_conflict / not_found / already_terminal /
  // delivery_unavailable …)。用 body.reason 而不是 error.code:reason 是命令核心的机器码,
  // error.code 只是它加了 'intervention.' 前缀的 HTTP 变体,工具面统一暴露前者更好分支。
  const failure = (body.error && typeof body.error === 'object') ? body.error : {};
  return stewardFail(String(body.reason || failure.code || 'decision_failed'), String(failure.message || body.message || 'decision could not be delivered'), {
    missionId, interventionId, type, params: failure.params || {}, status: result && result.status,
  });
}

// 14) steward_run_action。口径(§11.3 116c 行):
//     pause / stop —— 收紧类,任何权限档都可做(把事情停下来永远比让它跑下去保守);
//     resume / retry_node —— 失败处置类,按 §3.3 真值表的 'failed' 档口径:「改文件不问」以上可由管家直接做
//     (续跑/重试只是让线程接着走,线程自己的权限门仍会对 exec 逐条问);「每步都问」「只做计划」只提议。
//     116-2b 验收对齐(Fable):原先借 'plan' 档判定把它们限定为「只有全自动」,与 §3.3 自理清单
//     (失败重试/重启续跑对改文件不问生效)及 13h 自理侧预闸口径不一致,两道闸统一为 'failed'。
//     steer_node —— 改变线程要做的事,按 'plan' 档口径只有「全自动」可做。
const STEWARD_RUN_TIGHTENING = Object.freeze(['pause', 'stop']);
const STEWARD_RUN_ADVANCING = Object.freeze(['resume', 'retry_node', 'steer_node']);
const STEWARD_RUN_ACTION_KIND = Object.freeze({ resume: 'failed', retry_node: 'failed', steer_node: 'plan' });
async function stewardImplRunAction(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  const runId = safeSessionId(args.runId);
  const action = String(args.action || '');
  if (!sessionId || !runId) return stewardFail('invalid_request', 'sessionId and runId are required');
  if (!STEWARD_RUN_TIGHTENING.includes(action) && !STEWARD_RUN_ADVANCING.includes(action)) {
    return stewardFail('invalid_request', `unknown action: ${stewardSanitizeText(action)}`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no agent runs');
  const permissionMode = stewardThreadPermissionMode(head, config);
  const mayAct = STEWARD_RUN_TIGHTENING.includes(action) ? 'auto' : stewardMayAct(permissionMode, STEWARD_RUN_ACTION_KIND[action], 'exec');
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `「${stewardSanitizeText(action)}」是推进类动作,当前线程权限「${stewardPermissionLabel(permissionMode)}」不允许管家直接执行(续跑/重试需「改文件不问」以上,改指令需「全自动」)——把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', sessionId, runId, action, permissionMode,
    });
  }
  const cmd = await agentRunActionCommand({
    sessionId, runId, action,
    nodeId: args.nodeId,
    text: args.message == null ? '' : String(args.message).slice(0, STEWARD_STEER_TEXT_MAX),
  });
  if (!cmd) return stewardFail('invalid_request', `unsupported action: ${stewardSanitizeText(action)}`);
  const body = cmd.body || {};
  if (body.ok !== true) return stewardFail('run_action_failed', String(body.error || 'agent run action failed'), { sessionId, runId, action, status: cmd.status });
  // pause/stop 可由 resume 撤销;推进类动作没有对称撤销原语,如实标注不可撤销。
  const undoRef = action === 'pause' || action === 'stop'
    ? { kind: 'run_action', sessionId, runId, action: 'resume' }
    : { kind: 'none', note: '不可撤销' };
  stewardAppendDecision({
    tool: 'steward_run_action',
    args: { action, runId, nodeId: String(args.nodeId || '') },
    targetSessionId: sessionId,
    permissionMode,
    mayAct,
    undoRef,
    basis: stewardBasisOf(args, { runId }),
  });
  return { ...body, sessionId, runId, action, undoRef };
}

// 15b) steward_thread_note —— 既有线程的【插话补充】(116-2b,§3.5 委派行末句)。
//
// 为什么是插话而不是递话:§8.12 定的是「既有线程的递话走原话直递,管家如有补充以插话追加,不阻塞
// 线程启动」。递话(thread_continue)会【起一个新回合】,补充却必须落在【正在跑的那个回合】里 ——
// 它是给线程补上下文,不是给它派新活。所以走的是 /api/steer 背后的同一条注入通道(116-2b 把它零行为
// 抽成了 13b 的 steerSessionCore),而不是第二条注入路径:引擎分流(openai 队列 / Claude stdin /
// Kimi ACP 跟随)、队列上限、提问挂起时拒绝、持久呈现进会话正文,一条纪律都不用重写。
//
// 三条自己的收紧:①≤600 字;②尖括号中和(stewardSanitizeText,与总览行同一函数);③服务端加
// 「（管家补充）」前缀 —— 用户在 2.0 视窗里看到的插话必须能一眼分清是谁说的。
// 没有在途回合(或该回合不接受插话)时一律 steward.no_active_turn:模型看到这个信封就该改用
// steward_thread_continue,而不是轮询重试。
async function stewardImplThreadNote(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const text = stewardSanitizeText(args.text).trim().slice(0, STEWARD_NOTE_TEXT_MAX);
  if (!text) return stewardFail('invalid_request', 'text is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot receive a steward note');

  const outcome = await steerSessionCore({ sessionId, text: STEWARD_NOTE_PREFIX + text });
  // 核心的两种"没成"(apiFailure 形态的 400/409 与裸 json 的 {ok:false,error}) 归一成同一个稳定信封:
  // 对模型来说它们是同一件事 —— 现在没法把这句话插进去,别重试。
  if (outcome.kind === 'failure' || !(outcome.body && outcome.body.ok === true)) {
    const detail = String((outcome.kind === 'failure' ? outcome.message : (outcome.body && outcome.body.error)) || '').slice(0, 300);
    return stewardFail('steward.no_active_turn', `thread ${sessionId} cannot take a note right now: ${detail} —— do not retry; use steward_thread_continue to start a new turn instead`, { sessionId });
  }
  const body = outcome.body;
  // 撤回原语是 DELETE /api/steer,它按【文本】在队列里找那一条 —— 所以 undoRef 的真正把手是 text
  // 而不是某个 id(既有插话通道就没有 id 这个东西,编一个出来只会骗人)。
  const undoRef = { kind: 'note', sessionId, text: STEWARD_NOTE_PREFIX + text, queued: Number(body.queued) || 0, injected: body.injected === true };
  stewardAppendDecision({
    tool: 'steward_thread_note',
    args: { textChars: text.length },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef,
    basis: {},
  });
  return { ok: true, sessionId, queued: Number(body.queued) || 0, injected: body.injected === true, undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 记忆族(§4)—— 只记「用户本人陈述」。四道闸:来源必须是用户消息 -> 敏感过滤 -> 容量 -> 同义去重。
// ════════════════════════════════════════════════════════════════════════════

// 来源校验:sourceRef 指向的那个回合里必须真有一条【用户】消息。工具输出/助手消息来源确定性拒绝
// (§11.3「工具输出来源确定性拒绝」)—— 否则管家会把自己或工具说的话当成用户的偏好记下来。
async function stewardSourceIsUserMessage(sourceRef) {
  const sessionId = safeSessionId(sourceRef && sourceRef.sessionId);
  if (!sessionId) return false;
  const turnSeq = Number(sourceRef && sourceRef.turnSeq);
  if (!Number.isFinite(turnSeq)) return false;
  const session = await loadSession(sessionId).catch(() => null);
  if (!session) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // 116f 第二道:role:'user' 还不够 —— 管家的【收件箱回合】也是以一条 user 消息注入的(工作台把
  // 几十条系统事件归成一段文本发给模型),但那不是用户本人说的话。13h 在那条消息上落了
  // meta.origin === 'inbox'(随会话正文持久化,重启后仍在),这里确定性拒绝它。同理拒绝
  // 驱动器自动续跑的消息(source:'mission-driver')—— 也不是人说的。
  return messages.some(m => m && m.role === 'user' && Number(m.turnSeq) === turnSeq
    && !(m.meta && typeof m.meta === 'object' && m.meta.origin === 'inbox')
    && m.source !== 'mission-driver');
}

// 15) steward_memory_write
async function stewardImplMemoryWrite(args, ctx, config) {
  const kind = String(args.kind || '');
  if (!STEWARD_MEMORY_KINDS.includes(kind)) return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  const text = stewardSanitizeText(args.text).trim();
  if (!text) return stewardFail('invalid_request', 'text is required');
  if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
    return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
  }
  const sourceRef = (args.sourceRef && typeof args.sourceRef === 'object') ? args.sourceRef : null;
  if (!sourceRef) return stewardFail('invalid_request', 'sourceRef {sessionId, turnSeq} is required');
  if (!await stewardSourceIsUserMessage(sourceRef)) {
    return stewardFail('source_not_user', 'sourceRef must point at a turn that contains the user\'s own message; tool output and assistant text are not valid memory sources');
  }
  // 敏感过滤复用工作台记忆的同一条正则(密钥/口令/JWT/连接串),不另写第二套判据。
  if (memoryProposalLooksSensitive({ body: text })) {
    return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
  }

  const terms = stewardMemoryTerms(text);
  return stewardMutateMemory(async store => {
    // 被否决过的同义内容拒绝写回(§4 第 ⑤ 条:vetoed 之后同义不再自动写回)。
    const vetoed = store.entries.find(e => e.state === 'vetoed' && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    if (vetoed) {
      return { persist: false, result: stewardFail('vetoed_duplicate', `a synonymous memory was vetoed by the user (${vetoed.id}); do not write it back`, { id: vetoed.id }) };
    }
    const existing = store.entries.find(e => e.state === 'active' && e.kind === kind && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    const at = nowIso();
    if (existing) {
      existing.text = text;
      existing.confidence = Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : existing.confidence;
      existing.sourceSessionId = String(sourceRef.sessionId || '');
      existing.sourceSeq = Math.max(0, Number(sourceRef.turnSeq) || 0);
      existing.updatedAt = at;
      const undoRef = { kind: 'memory', id: existing.id, prev: null };
      stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: true }, targetSessionId: String(sourceRef.sessionId || ''), permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [existing.id] } });
      return { persist: true, result: { ok: true, id: existing.id, merged: true, undoRef } };
    }
    const activeCount = store.entries.filter(e => e.state === 'active').length;
    if (activeCount >= STEWARD_MEMORY_LIMITS.maxEntries) {
      return { persist: false, result: stewardFail('capacity_exceeded', `steward memory is full (${STEWARD_MEMORY_LIMITS.maxEntries} active entries); veto something before writing more`) };
    }
    const entry = {
      id: makeId('smem'),
      kind,
      text,
      confidence: Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6,
      sourceSessionId: String(sourceRef.sessionId || ''),
      sourceSeq: Math.max(0, Number(sourceRef.turnSeq) || 0),
      createdAt: at,
      updatedAt: at,
      lastUsedAt: '',
      useCount: 0,
      state: 'active',
    };
    store.entries.push(entry);
    const undoRef = { kind: 'memory', id: entry.id, prev: null };
    stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: false }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [entry.id] } });
    return { persist: true, result: { ok: true, id: entry.id, merged: false, undoRef } };
  });
}

// 16) steward_memory_veto
async function stewardImplMemoryVeto(args) {
  const id = String(args.id || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    const prev = entry.state;
    entry.state = 'vetoed';
    entry.updatedAt = nowIso();
    const undoRef = { kind: 'memory', id, prev };
    stewardAppendDecision({ tool: 'steward_memory_veto', args: { id }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, id, state: 'vetoed', undoRef } };
  });
}

// 17) steward_memory_search —— 词法匹配(词项 Jaccard + 子串命中),默认排除 vetoed。
async function stewardImplMemorySearch(args) {
  const q = String(args.q || '').trim();
  const kind = STEWARD_MEMORY_KINDS.includes(String(args.kind || '')) ? String(args.kind) : '';
  const limit = stewardClampInt(args.limit, 1, STEWARD_MEMORY_LIMITS.searchLimit, 20);
  const includeVetoed = args.includeVetoed === true;
  const store = await stewardReadMemoryStore();
  const terms = q ? stewardMemoryTerms(q) : null;
  const needle = q.toLowerCase();
  const rows = store.entries
    .filter(e => (includeVetoed || e.state === 'active') && (!kind || e.kind === kind))
    .map(e => ({
      entry: e,
      score: terms ? Math.max(stewardTermJaccard(terms, e.text), e.text.toLowerCase().includes(needle) ? 0.9 : 0) : 0,
    }))
    .filter(row => !terms || row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)))
    .slice(0, limit)
    .map(row => ({ ...row.entry, score: Number(row.score.toFixed(4)) }));
  return { ok: true, query: q, kind: kind || '', total: store.entries.length, entries: rows };
}

// 20) steward_missions —— 事项级只读视图(116g / §3.1 / §8.10)。
// 纪律:装配全部委托 13d 的 buildMissionAggregateRows(与看板 GET /api/missions 逐字节同源),
// 事项级状态只经 06i 的 aggregateMissionState 纯函数 —— 本文件【不】自己判定任何状态。
async function stewardImplMissions(args, ctx, config) {
  const includeArchived = !!(args && args.includeArchived === true);
  const aggregate = await buildMissionAggregateRows({ includeArchived }).catch(() => ({ rows: [] }));
  const missions = aggregate.rows.map(row => {
    const mission = {
      missionId: row.missionId,
      title: stewardSanitizeText(row.title),
      goal: stewardSanitizeText(row.goal).slice(0, 400),
      aggregateState: row.aggregateState,
      aggregateStateLabel: stewardStateLabel(row.aggregateState),
      acceptance: {
        done: row.acceptance.done,
        total: row.acceptance.total,
        items: row.acceptance.items.map(item => ({ id: item.id, text: stewardSanitizeText(item.text), done: item.done === true })),
      },
      budget: row.budget,
      cost: row.cost,
      derived: row.derived,
      threads: row.threads.map(thread => ({
        sessionId: thread.sessionId,
        title: thread.title,
        state: thread.state,
        stateLabel: thread.stateLabel,
        permissionMode: thread.permissionMode,
        lastAssistantText: thread.lastAssistantText,   // 13d 已按 §11.2 截到 120 字
      })),
    };
    if (row.archivedAt) mission.archivedAt = row.archivedAt;
    return mission;
  });
  return { ok: true, missions, count: missions.length };
}

// 延迟绑定(先例 06c AgentLoopHooks):06i 声明空命名空间,本文件在加载时填充实现。
// 消费者(13-http-router 的路由链、13-http-router 的关服收尾、116c 的管家工具 handler)全程只看
// StewardHooks.*,从不直接依赖 13g —— 这就是「不新增前向边」的落地方式。
Object.assign(StewardHooks, {
  handleApiRoutes: handleStewardApiRoutes,
  stopInbox: stopStewardInbox,
  inboxRead: stewardInboxRead,
  inboxState: stewardInboxState,
  // 116c: 17 个管家工具的实现键(116-2a 增第 18 个 threadPermission;116-2b 增第 19 个 threadNote;
  // 116g 增第 20 个 missions)。每个都经 stewardToolHandler
  // 包一层门控壳(开关 -> 身份 -> 实现),
  // 12-tool-dispatch 的 handler 只写一行 `StewardHooks.<键>(args, ctx)`。键名与 06i 的契约注释逐条对应。
  selfStatus: stewardToolHandler('steward_self_status', stewardImplSelfStatus),
  threadsSearch: stewardToolHandler('steward_threads_search', stewardImplThreadsSearch),
  threadStatus: stewardToolHandler('steward_thread_status', stewardImplThreadStatus),
  threadRead: stewardToolHandler('steward_thread_read', stewardImplThreadRead),
  runsStatus: stewardToolHandler('steward_runs_status', stewardImplRunsStatus),
  inboxReadTool: stewardToolHandler('steward_inbox_read', stewardImplInboxRead),
  usage: stewardToolHandler('steward_usage', stewardImplUsage),
  health: stewardToolHandler('steward_health', stewardImplHealth),
  auditTail: stewardToolHandler('steward_audit_tail', stewardImplAuditTail),
  missions: stewardToolHandler('steward_missions', stewardImplMissions), // 116g
  threadNew: stewardToolHandler('steward_thread_new', stewardImplThreadNew),
  threadContinue: stewardToolHandler('steward_thread_continue', stewardImplThreadContinue),
  threadRename: stewardToolHandler('steward_thread_rename', stewardImplThreadRename),
  threadPermission: stewardToolHandler('steward_thread_permission', stewardImplThreadPermission), // 116-2a
  threadNote: stewardToolHandler('steward_thread_note', stewardImplThreadNote), // 116-2b
  decide: stewardToolHandler('steward_decide', stewardImplDecide),
  runAction: stewardToolHandler('steward_run_action', stewardImplRunAction),
  memoryWrite: stewardToolHandler('steward_memory_write', stewardImplMemoryWrite),
  memoryVeto: stewardToolHandler('steward_memory_veto', stewardImplMemoryVeto),
  memorySearch: stewardToolHandler('steward_memory_search', stewardImplMemorySearch),
});
