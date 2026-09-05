// ============================================================================
// 第 116 波 116f(27 号文 §11.3「116f 回合运行器与到访」):管家回合运行器、输出契约、熔断与到访。
//
// 定位(transport 层,manifest 中位于 13g-steward.js 之后、14-main.js 之前):
//   13g 是「箱子与工具」,本文件是「回合与到访」—— 它把用户消息或收件箱事件组装成一个回合,交给既有
//   回合机器(runSessionTurn)去跑,再把模型的结构化输出解析成 {say, acts, actions, why},按【目标线程】
//   的权限执行 actions 或把它降级成一个提议按钮,最后落决策日志并把结构化结果返回给调用方。
//
// steward_reply 的投放口径(有意与回合流事件分开):它【不是】回合流事件,而是管家通道这一次请求的
//   响应载荷 —— 回合早已收尾、模型也早已说完,它是工作台【事后】按契约解析并执行完 actions 之后
//   拼出来的东西。所以运行器只把它放进返回值与 stewardRunnerRuntime.lastReply(/api/steward/state 可读),
//   由 /api/steward/message 的 SSE 壳作为流的最后一帧写出;回合过程中的既有事件(session/
//   assistant_delta/tool_use/result …)照旧原样透传给调用方的 onEvent。这样经典壳与 Preview 壳的
//   回合事件契约(112b progress-events 的双向登记表)一条都不用动 —— 那两个壳根本不接管家通道。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13h 只引用拼接顺序在它之前的模块符号(00/01/02/04/06b/06i/08/09/10/13e/13g …),全部后向边;
//   · 没有任何模块引用 13h 的符号 —— 09(提示词分叉)、10(预算分叉)、13g(轮询器出口/state/路由转交)
//     一律经 06i 的 StewardHooks 延迟绑定拿实现,故 13h 零入边、不进任何强连通分量;
//   · 反过来 13h 直接调 13g 的内部函数(stewardDir/stewardFail/stewardAppendDecision …)是后向边,合法。
//     13g 想复用本文件的东西则【不可以】—— 那是前向边,故总览行的装配在本文件里另写一份(用的仍是
//     06i/13g 的同一批原语与同一批事实源,不新造第二个事实源)。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时本文件【零副作用】—— 不建管家会话、不起任何 timer、
// 不写任何文件;三条路由仍在(路由清册不因开关变化),一律返回 409 `steward.disabled`。
//
// 管家会话(§3.1「管家自身是 kind:'steward' 的特殊会话」):
//   固定 id `steward`(06i 的 STEWARD_SESSION_ID)、标题「如意管家」、cwd = 数据根;开关开且首次被唤醒时
//   懒创建。排除面(会话列表 / 113b 内容搜索 / 13e 投影 / 116b 收件箱)一律按会话头【原始】 kind 判定,
//   不经 sessionKind()(它会把 steward 归一成 quick_ask,拿它当身份判据等于把门拆了)。
//
// 本切片只支持 OpenAI 兼容 provider:解析到 Claude / Kimi CLI 引擎时返回稳定信封
// `steward.unsupported_engine`(116-2 候选:CLI 引擎的管家回合要另接 runClaudeTurn 的事件流与工具协议)。
// ============================================================================

// ── 落盘面(唯一新增:到访归档;已登记进 durable-state-inventory)────────────────────────────────
const STEWARD_VISITS_DIR = 'visits';
const STEWARD_VISIT_SCHEMA = 1;
const STEWARD_VISITS_KEEP = 200;              // 归档文件保留个数(超出从最旧删起)

// ── 回合层数值口径(§11.2)────────────────────────────────────────────────────────────────────
const STEWARD_INBOX_EVENTS_PER_TURN = 30;     // 一个收件箱回合最多带 30 条事件
const STEWARD_INBOX_EVENT_CHARS = 400;        // 每条事件 ≤400 字
const STEWARD_MEMORY_BLOCK_CHARS = 3000;      // 记忆块 ≤3000 字符
const STEWARD_SAY_MAX = 600;                  // say ≤600 字
const STEWARD_WHY_MAX = 400;
const STEWARD_ACT_LABEL_MAX = 12;             // 按钮文字 ≤12 字
const STEWARD_ACTS_MAX = 3;                   // 一次回合按钮 ≤3 个
const STEWARD_ACTIONS_MAX = 5;                // 一次回合最多执行 5 条 action(其余丢弃并如实标注)
const STEWARD_DEBOUNCE_MS = 5000;             // 收件箱去抖窗口
const STEWARD_NO_PROGRESS_MAX = 5;            // 连续 5 次收件箱回合零 acts 零 actions -> 退避
const STEWARD_VISIT_DIGEST_MAX = 5;           // 到访摘要 ≤5 条人话
const STEWARD_PENDING_LIST_MAX = 20;          // 到访返回的待决列表上限
const STEWARD_TURN_WINDOW_MS = 60 * 60 * 1000; // 每小时回合上限的滑动窗口
const STEWARD_TURN_DAY_MS = 24 * 60 * 60 * 1000; // 回合时间戳表只保留 24 小时(state 的 day 口径同源)
const STEWARD_PREEMPT_WAIT_MS = 15000;        // 抢占后等在途回合收尾的上限

// ── 到访摘要的五类人话(确定性归纳,不调模型;§8.9「每次打开只汇报」)──────────────────────────
const STEWARD_DIGEST_KIND_TEXT = Object.freeze({
  needs_you: n => `${n} 条线程在等你拿主意`,
  failed: n => `${n} 条线程出错了`,
  done: n => `${n} 条线程收工了`,
  stalled: n => `${n} 条线程停住了`,
  budget: n => `${n} 条线程用完了预算`,
});

// ── 可由 actions 执行的写工具 -> StewardHooks 实现键。白名单即闸门:不在表里的工具名一律拒绝
//    (读类工具没有出现在这里的理由 —— 模型要读就自己在回合里调工具,不该经 actions 绕一圈)。
const STEWARD_ACTION_HOOKS = Object.freeze({
  steward_thread_new: 'threadNew',
  steward_thread_continue: 'threadContinue',
  steward_thread_rename: 'threadRename',
  steward_decide: 'decide',
  steward_run_action: 'runAction',
  steward_memory_write: 'memoryWrite',
  steward_memory_veto: 'memoryVeto',
});

// 降级成按钮时的人话标签(§8.4「话＋一行按钮」:按钮上写用户要做的那件事,不写工具名)。
const STEWARD_DECIDE_LABELS = Object.freeze({ allow: '允许', deny: '拒绝', approve: '批准', reject: '驳回', answer: '回答' });
const STEWARD_RUN_ACTION_LABELS = Object.freeze({ pause: '暂停', resume: '继续', stop: '停止', retry_node: '重试', steer_node: '插话' });
const STEWARD_TOOL_LABELS = Object.freeze({
  steward_thread_new: '新开线程', steward_thread_continue: '接着办', steward_thread_rename: '改标题',
  steward_memory_write: '记下', steward_memory_veto: '别记',
});

// ────────────────────────────────────────────────────────────────────────────
// 运行时状态。全部【只在内存】—— 管家的持久化面只有 13g 登记的四个 + 本切片的 visits 归档,
// 到访状态本身不落盘(进程重启 = 新到访,与 §11.1 第 7 项「一次到访 = 页面重开或静默 60 分钟」一致)。
// ────────────────────────────────────────────────────────────────────────────
const stewardRunnerRuntime = {
  visit: { startedAt: '', lastActivityAt: '', inboxSeq: 0, previousStartedAt: '' },
  turns: [],            // 已跑回合的时间戳(ms),滑动窗口用
  noProgress: 0,        // 连续零进展的收件箱回合数
  inflight: null,       // { kind:'user'|'inbox', promise, controller, cancelled, events }
  queue: [],            // 待处理的收件箱事件(抢占时回排在这里)
  debounceTimer: null,
  lastReply: null,      // 最近一次 steward_reply 的精简副本(供 /api/steward/state)
  circuit: null,        // 最近一次触发的熔断 { kind, at, detail }
  stopped: false,       // 一键停机:停轮询的同时停回合队列
};

function stewardStopRunner() {
  stewardRunnerRuntime.stopped = true;
  if (stewardRunnerRuntime.debounceTimer) { clearTimeout(stewardRunnerRuntime.debounceTimer); stewardRunnerRuntime.debounceTimer = null; }
  stewardRunnerRuntime.queue = [];
  const inflight = stewardRunnerRuntime.inflight;
  if (inflight) {
    inflight.cancelled = 'stopped';
    stewardAbortInflight(inflight);
  }
  return { ok: true, stopped: true };
}
function stewardResumeRunner() {
  stewardRunnerRuntime.stopped = false;
  return { ok: true, stopped: false };
}

// 停一个在途管家回合:先 stopSession(既有停止原语 —— 它拿到 activeChildren 里的 abort 句柄直接掐
// 在途 fetch,不依赖 killOnDisconnect 配置),再 abort 我们自己的 signal(双保险;runSessionTurn 的
// 断线语义走的是这条)。线程自己的回合不受影响 —— 这里停的只有管家会话。
function stewardAbortInflight(inflight) {
  try { stopSession(STEWARD_SESSION_ID, 'steward-preempt'); } catch { /* 没有在途子进程即无操作 */ }
  try { if (inflight && inflight.controller) inflight.controller.abort(); } catch { /* 无 AbortController 环境 */ }
}

// ────────────────────────────────────────────────────────────────────────────
// 管家会话(单例)。
// ────────────────────────────────────────────────────────────────────────────

// 引擎解析:stewardProviderId/stewardModel 为空则跟随主端点(§11.1 第 5 项)。
// 返回 { ok:true, route } 或 { ok:false, error:'steward.unsupported_engine', engine }。
function stewardResolveRoute(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const explicitId = String(cfg.stewardProviderId || '').trim();
  if (explicitId) {
    const provider = (cfg.providers || []).find(p => p && p.id === explicitId);
    if (!provider) {
      return { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家端点 ${explicitId} 不在 Provider 列表里,请到设置里改` };
    }
    const route = normalizeSessionEngineRoute({ engine: 'openai', providerId: explicitId, model: String(cfg.stewardModel || '').trim() || provider.model || '' });
    return route ? { ok: true, route } : { ok: false, error: 'steward.unsupported_engine', engine: explicitId, message: `管家端点 ${explicitId} 无法解析成 OpenAI 兼容路由` };
  }
  // 跟随主端点。CLI 引擎(Claude / Kimi)在本切片不支持:管家回合的事件流与工具协议要另接一套,
  // 属 116-2。fail-closed 返回稳定信封,而不是悄悄换成别的端点跑起来。
  const route = sessionEngineRouteFromConfig(cfg);
  if (!route || route.engine !== 'openai') {
    const engine = route ? (route.agentCliType || 'claude') : 'none';
    return { ok: false, error: 'steward.unsupported_engine', engine, message: `管家本版只支持 OpenAI 兼容端点,当前主端点是 ${engine};请在设置里为管家单独指定一个 OpenAI 兼容端点(stewardProviderId)` };
  }
  const model = String(cfg.stewardModel || '').trim();
  return { ok: true, route: model ? { ...route, model } : route };
}

// 懒创建管家会话。不用 createSession(它生成 sess_* 随机 id;管家要的是固定 id,见 06i 的注释),
// 但字段形状与 createSession 逐条对齐,以便所有既有会话原语(load/save/rewind/压缩)照常可用。
async function ensureStewardSession(config) {
  const resolved = stewardResolveRoute(config);
  if (!resolved.ok) return resolved;
  const existing = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (existing && existing.id === STEWARD_SESSION_ID) {
    // 引擎/模型可能在设置里被改过 —— 每次唤醒对齐一次(会话头是路由的权威源,configForSessionEngineRoute
    // 读它)。kind 一旦被外部改坏就纠回来:身份判据全靠它。
    let dirty = false;
    if (existing.kind !== 'steward') { existing.kind = 'steward'; dirty = true; }
    if (JSON.stringify(existing.engineRoute || null) !== JSON.stringify(resolved.route)) { existing.engineRoute = resolved.route; dirty = true; }
    if (dirty) await saveSession(existing).catch(() => {});
    return { ok: true, session: existing, route: resolved.route };
  }
  const now = nowIso();
  const session = {
    id: STEWARD_SESSION_ID,
    schemaVersion: SESSION_SCHEMA,
    turnSeq: 0,
    title: STEWARD_SESSION_TITLE,
    summary: '',
    pinned: false,
    // cwd = 数据根:管家没有工作目录的概念(它不动文件),但回合机器要一个存在的目录做 workingDir。
    cwd: paths.data,
    createdAt: now,
    updatedAt: now,
    claudeSessionId: null,
    messages: [],
    providerHistory: [],
    providerHistoryCursor: 0,
    attachments: [],
    engineRoute: resolved.route,
    mission: null,
    missionId: STEWARD_SESSION_ID,
    kind: 'steward',                 // 身份:所有排除面按【这个原始值】判定
    permissionMode: STEWARD_PERMISSION_MODE, // 独立模式,不进 PERMISSION_MODES
  };
  await saveSession(session);
  logEvent({ kind: 'steward_session_created', sessionId: STEWARD_SESSION_ID, providerId: resolved.route.providerId, model: resolved.route.model });
  return { ok: true, session, route: resolved.route };
}

// ────────────────────────────────────────────────────────────────────────────
// 提示词装配(§11.2 分层):稳定层 = 06b steward.stable;易变层 = 记忆块 + 线程总览 + 尾句。
// ────────────────────────────────────────────────────────────────────────────

// 记忆块:直接用 116c 的门控工具实现(同一份读取与同一道门),按 kind 分组,整块 ≤3000 字符。
async function stewardMemoryBlock(session, config, pack) {
  let entries = [];
  try {
    const found = await StewardHooks.memorySearch({ limit: STEWARD_MEMORY_LIMITS.searchLimit }, { session, config });
    entries = (found && Array.isArray(found.entries)) ? found.entries : [];
  } catch { entries = []; }
  if (!entries.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty;
  const lines = [];
  for (const kind of STEWARD_MEMORY_KINDS) {
    const rows = entries.filter(e => e && e.kind === kind && e.state !== 'vetoed');
    for (const row of rows) {
      const source = row.sourceSessionId ? `来源 ${stewardSanitizeText(row.sourceSessionId)}` : '来源未记';
      lines.push(`- [${kind}#${stewardSanitizeText(row.id)}] ${stewardSanitizeText(row.text)}(${source},用过 ${Math.max(0, Number(row.useCount) || 0)} 次)`);
    }
  }
  if (!lines.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty;
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > STEWARD_MEMORY_BLOCK_CHARS) break;
    out.push(line);
    used += line.length + 1;
  }
  return pack.steward.memoryHeader + '\n' + out.join('\n');
}

// 线程总览行的数据装配。事实源与 116c 的 steward_thread_status 完全相同(13e 投影 + 会话头 +
// 06i 的五态判据),只是按「一行一条」的口径取字段 —— 13g 不能复用本函数(那会是前向边),
// 故这里是同一批原语的第二个调用方,不是第二个事实源。
//   · lastSay 取会话头的 summary:那就是上一回合助手最终文本的前 160 字(09 收尾处写的),
//     不经模型改写,符合 §11.2「诚实:最后一句取原话」;
//   · 只列「未收工」或「24 小时内收工」的线程,管家会话自己永远不列。
async function stewardThreadDigestRows(config) {
  const index = await getPretenderProjectionIndex().catch(() => null);
  const rows = [];
  const now = Date.now();
  for (const slice of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
    const sid = slice && safeSessionId(slice.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) continue;
    const head = await stewardReadSessionHead(sid);
    if (!head || !head.id) continue;
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') continue;   // 排除面:按会话头【原始】 kind 判,不经 sessionKind()
    const card = slice.card ? overlayMissionCard(slice) : null;
    const derived = card
      ? stewardThreadStateFromCard(card)
      : deriveStewardThreadState({
        kind: rawKind === 'mission' ? 'mission' : 'quick_ask',
        autoMode: head.mission && head.mission.autoMode,
        resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
        activeTurn: activeChildren.has(sid),
        turnSeq: head.turnSeq,
      });
    const updatedMs = Date.parse(String(head.updatedAt || ''));
    const settled = derived.state === 'done' || derived.state === 'stopped';
    const recent = Number.isFinite(updatedMs) && (now - updatedMs) <= 24 * 60 * 60 * 1000;
    if (settled && !recent) continue;      // 收工超过 24 小时的线程不占总览预算
    const lastRun = card && card.lastRun ? card.lastRun : null;
    const pendingCount = card && card.pending
      ? (Number(card.pending.permissions) || 0) + (Number(card.pending.questions) || 0) + (Number(card.pending.plans) || 0) + (Number(card.pending.pool) || 0)
      : 0;
    const usage = slice.usage || null;
    const costs = usage && usage.costsByCurrency ? Object.values(usage.costsByCurrency) : [];
    rows.push({
      sessionId: sid,
      // 116-pre(§8.12/§11.3):递话预判的 index 行要 missionId——3.0 里等于 sessionId(见下方注释),
      // 加在这里而不是 digest 里,因为 buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,
      // 多一个 missionId 键对总览行的拼装零影响(新增只加不改)。
      missionId: sessionMissionId(head) || sid,
      updatedAt: String(head.updatedAt || ''),
      state: derived.state,
      digest: {
        id: sid,
        // 事项标题本波恒为空:3.0 里 missionId === sessionId,事项标题就是线程标题,写两遍等于把同一
        // 句话在总览里重复一次(buildStewardDigestLine 对空段整段跳过)。116g 事项跨会话升格之后
        // 一个事项才会有多条线程,那时这里填事项自己的标题。
        missionTitle: '',
        title: head.title || '',
        state: derived.state,
        action: activeChildren.has(sid) ? '回合进行中' : (lastRun ? `班组 ${lastRun.status || ''}` : ''),
        lastSay: head.summary || '',
        waitReason: pendingCount > 0 ? `等你(${pendingCount} 条待决)` : '',
        permissionMode: stewardThreadPermissionMode(head, config),
        cost: costs.length ? costs.reduce((a, b) => a + (Number(b) || 0), 0) : null,
      },
    });
  }
  // 排序:等你 > 进行中 > 其余,同档按最近更新在前(总览被裁时先保住最该看的那几条)。
  const rank = state => (state === 'needs_you' ? 0 : state === 'running' ? 1 : state === 'dispatching' ? 2 : 3);
  rows.sort((a, b) => rank(a.state) - rank(b.state) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// 第 116 波 116-pre(27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3):递话预判端点。
//
// 装配纪律:index 的事实源与上面 stewardThreadDigestRows 完全相同(13e 投影 + 会话头 + 06i 五态判据),
// 本节【复用同一个函数】而不是另起一份 —— 116c 交付记录已经写明「13g 不能复用 13h 的函数(前向边)」,
// 但 preroute 端点本来就住在 13h 里,同文件内调用零边可言,是最省心的复用方式。
//
// 缓存(§11.3 交付物「按 13e 投影的 changeSeq 总和或最近会话 updatedAt 作为缓存键,命中则不重装配」):
// getPretenderProjectionIndex() 内部已经是增量维护的运行时缓存(source stamp 没变就不重扫会话),
// 它的整体 revision 已经是「本次投影所有 changeSeq 与卡片状态」的一个哈希摘要 —— 直接拿它当缓存键,
// 比自己重新求和一遍 changeSeq 更省一次遍历,语义完全等价(revision 本身就由 changeSeq 参与算出)。
// 命中时跳过的是【每会话一次 stewardReadSessionHead 文件读】那一段(§11.3 的目标 p50 ≤50ms 主要靠它)。
// 只在内存,不写盘;开关关时这段代码根本不会被调到(见路由分支)。
const _stewardPrerouteCache = { revision: '', rows: [] };
async function stewardPrerouteIndexRows(config) {
  const index = await getPretenderProjectionIndex().catch(() => null);
  const revision = String((index && index.revision) || '');
  if (revision && revision === _stewardPrerouteCache.revision) return _stewardPrerouteCache.rows;
  const digestRows = await stewardThreadDigestRows(config);
  const rows = digestRows.map(row => ({
    sessionId: row.sessionId,
    missionId: row.missionId || row.sessionId,
    missionTitle: (row.digest && row.digest.missionTitle) || '',
    title: (row.digest && row.digest.title) || '',
    // 116-pre 交付物口径:「summary(lastAssistantText 或摘要,≤400 字)」——digest.lastSay 就是
    // head.summary(诚实纪律:原话,不经模型改写),这里只做 400 字截断,不重新中和(stewardSanitizeText
    // 在 prerouteText 内部拼 reason/title 时才需要,summary 只参与打分不进返回值)。
    summary: String((row.digest && row.digest.lastSay) || '').slice(0, 400),
    state: row.state,
    updatedAt: row.updatedAt,
  }));
  if (revision) { _stewardPrerouteCache.revision = revision; _stewardPrerouteCache.rows = rows; }
  return rows;
}

// StewardHooks.preroute 的实现(§11.3「把 preroute(q) 挂到 StewardHooks,117 与 116f 都可能用」)。
// config 可选:路由处已经 readConfig() 过,直接传进来省一次重读;其余调用方(117 壳层)不传时自己读一遍。
async function stewardPreroute(q, configArg) {
  const config = (configArg && typeof configArg === 'object') ? configArg : await readConfig();
  const [index, memoryStore] = await Promise.all([
    stewardPrerouteIndexRows(config).catch(() => []),
    stewardReadMemoryStore().catch(() => ({ entries: [] })),
  ]);
  const memory = (memoryStore.entries || [])
    .filter(e => e && e.state !== 'vetoed' && (e.kind === 'focus' || e.kind === 'habit'))
    .map(e => ({ kind: e.kind, text: e.text }));
  return prerouteText(q, index, memory, {});
}

function stewardOverviewBlock(rows, pack) {
  // 尾句(「更多细节用 steward_thread_read,读取有预算」)在空总览时也要在:管家随时可能被问到
  // 一条刚建起来的线程,它必须知道深读这条路存在,而不是因为「上一秒没有线程」就以为没有工具可用。
  if (!rows.length) return [pack.steward.overviewHeader, pack.steward.overviewEmpty, pack.steward.overviewMore].join('\n');
  const lines = [];
  let used = 0;
  let folded = 0;
  for (const row of rows) {
    if (lines.length >= STEWARD_DIGEST_LIMITS.maxThreads) { folded += 1; continue; }
    const line = buildStewardDigestLine(row.digest);
    if (used + line.length + 1 > STEWARD_DIGEST_LIMITS.totalChars) { folded += 1; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  const out = [pack.steward.overviewHeader, ...lines];
  if (folded > 0) out.push(pack.steward.overviewFolded({ threads: folded }));
  out.push(pack.steward.overviewMore);
  return out.join('\n');
}

// 09 的提示词分叉入口(经 StewardHooks.buildSystemPrompt 调)。返回 {stable, volatile}:
// stable 进 system(版本级常量,前缀缓存完整命中),volatile 进第一条 user 消息前缀(与普通会话
// 的 turnVolatile 同一投放位置),易变内容后置。
async function buildStewardSystemPrompt(session, config, ctx) {
  const pack = getPromptPack(config && config.locale);
  const parts = [];
  try { parts.push(await stewardMemoryBlock(session, config, pack)); } catch { /* 记忆是旁路增强,缺了照常开工 */ }
  try { parts.push(stewardOverviewBlock(await stewardThreadDigestRows(config), pack)); } catch { /* 同上 */ }
  return { stable: pack.steward.stable, volatile: parts.filter(Boolean).join('\n\n') };
}

// 10 的预算分叉入口(经 StewardHooks.contextBudget 调)。§11.2:预算 = min(stewardContextBudgetTokens,
// 该模型 conversationWindow);到 60% 触发既有 L2。返回的是【触发线】,maybeAutoCompact 直接拿它比。
function stewardContextBudget(session, config, window) {
  const configured = Math.max(1, Math.round(Number(config && config.stewardContextBudgetTokens) || 200000));
  const modelWindow = Math.max(0, Math.round(Number(window) || 0));
  const cap = modelWindow > 0 ? Math.min(configured, modelWindow) : configured;
  return Math.max(1, Math.round(cap * 0.6));
}
function stewardVisitNotesPrompt(config) {
  return getPromptPack(config && config.locale).steward.visitNotes;
}

// ────────────────────────────────────────────────────────────────────────────
// 输出契约解析(§11.3 116f 行)。复用 08 的 json-repair(parseStructuredAgentOutput:多候选 + 两级
// 解析,合法 JSON 永远走原文 parse 分支)。解析失败不是错误:say 取原文、acts/actions 空、记一条
// logEvent —— 模型没按契约说话时,把它的话原样端给用户,好过丢掉。
// ────────────────────────────────────────────────────────────────────────────
function stewardActLabel(tool, args) {
  const a = (args && typeof args === 'object') ? args : {};
  if (tool === 'steward_decide') {
    const action = String(a.action || '');
    return (STEWARD_DECIDE_LABELS[action] || action || '决定').slice(0, STEWARD_ACT_LABEL_MAX);
  }
  if (tool === 'steward_run_action') {
    const action = String(a.action || '');
    return (STEWARD_RUN_ACTION_LABELS[action] || action || '执行').slice(0, STEWARD_ACT_LABEL_MAX);
  }
  return (STEWARD_TOOL_LABELS[tool] || '去做').slice(0, STEWARD_ACT_LABEL_MAX);
}

function stewardNormalizeAct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = String(raw.tool || '');
  const kindRaw = String(raw.kind || '');
  const kind = (kindRaw === 'tool' || kindRaw === 'open_thread' || kindRaw === 'dismiss')
    ? kindRaw
    : (tool ? 'tool' : 'dismiss');
  if (kind === 'tool' && !isStewardToolName(tool)) return null;  // 只认 steward_*(动世界的工具永远进不来)
  const label = stewardSanitizeText(raw.label).slice(0, STEWARD_ACT_LABEL_MAX)
    || (kind === 'tool' ? stewardActLabel(tool, raw.args) : (kind === 'open_thread' ? '打开' : '知道了'));
  const act = { label, kind };
  if (kind === 'tool') {
    act.tool = tool;
    act.args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
  }
  const sessionId = raw.sessionId ? safeSessionId(raw.sessionId) : '';
  if (sessionId) act.sessionId = sessionId;
  if (raw.primary === true) act.primary = true;
  return act;
}

// acts 归一:≤3 个、主动作只有一个(第一个 primary 胜出,其余降为安静按钮)。
function stewardNormalizeActs(list) {
  const out = [];
  let primaryTaken = false;
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (out.length >= STEWARD_ACTS_MAX) break;
    const act = stewardNormalizeAct(raw);
    if (!act) continue;
    if (act.primary) {
      if (primaryTaken) delete act.primary;
      else primaryTaken = true;
    }
    out.push(act);
  }
  return out;
}

function stewardParseReply(text) {
  const raw = String(text == null ? '' : text);
  const parsed = parseStructuredAgentOutput(raw);
  const value = parsed && parsed.ok ? parsed.value : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    logEvent({ kind: 'steward_contract_unparsed', chars: raw.length });
    return { parsed: false, say: raw.trim().slice(0, STEWARD_SAY_MAX), why: '', acts: [], actions: [] };
  }
  const actions = [];
  for (const item of (Array.isArray(value.actions) ? value.actions : [])) {
    if (!item || typeof item !== 'object') continue;
    const tool = String(item.tool || '');
    if (!isStewardToolName(tool)) continue;
    actions.push({ tool, args: (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) ? item.args : {} });
    if (actions.length >= STEWARD_ACTIONS_MAX) break;
  }
  return {
    parsed: true,
    say: String(value.say == null ? '' : value.say).slice(0, STEWARD_SAY_MAX),
    why: String(value.why == null ? '' : value.why).slice(0, STEWARD_WHY_MAX),
    acts: stewardNormalizeActs(value.acts),
    actions,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// actions 执行(§3.3 自理清单 + 目标线程权限)。
//
// 两道闸,顺序即安全:
//   ① 自理清单(stewardAutoActions):管家【主动】做的事要用户先在设置里勾过。清单只管「管家该不该
//      主动做」,不管「做得成做不成」;
//   ② 目标线程权限:在 13g 的工具实现内部由 stewardMayAct + 永久豁免清单判 —— 本文件不复制那套判据,
//      拿到 propose_required 就降级成一个按钮。这样「能不能做」永远只有一处定义。
// ────────────────────────────────────────────────────────────────────────────
async function stewardTargetPermission(args, config) {
  const sid = args && args.sessionId ? safeSessionId(args.sessionId) : (args && args.missionId ? safeSessionId(args.missionId) : '');
  if (!sid) return '';
  const head = await stewardReadSessionHead(sid);
  return head ? stewardThreadPermissionMode(head, config) : '';
}

// 自理清单判定。trigger==='user' 时用户就在跟前(这一句话就是授权),清单只约束【无人值守】的
// 收件箱回合 —— 这与 §3.3「管家的主动行为收进勾选清单」是同一件事:用户没在说话时才叫「主动」。
async function stewardSelfServeAllows(tool, args, config, trigger) {
  const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
  if (trigger === 'user') return { allowed: true };
  if (tool === 'steward_memory_write' || tool === 'steward_memory_veto') return { allowed: true }; // 管家记忆自由(§3.5)
  if (tool === 'steward_thread_continue') {
    // 递话(接力)默认关:只提议。
    return auto.relay === true ? { allowed: true } : { allowed: false, reason: '「事项内自动交接」没有勾选,只能提议' };
  }
  if (tool === 'steward_thread_new') {
    // 自己新开线程只在接力/定时触发时发生(§11.1 第 6 项);本切片没有定时触发源,故与 relay 同门。
    if (auto.newThread !== true) return { allowed: false, reason: '「自己新开线程」没有勾选,只能提议' };
    return auto.relay === true ? { allowed: true } : { allowed: false, reason: '新开线程只在接力或定时触发时自动发生,现在只能提议' };
  }
  if (tool === 'steward_run_action') {
    const action = String((args && args.action) || '');
    if (action === 'retry_node') {
      if (auto.retry !== true) return { allowed: false, reason: '「失败自动重试」没有勾选,只能提议' };
      // 重试是「替线程答一次 failed」:目标线程权限必须允许(default/plan 一律只提议)。
      const mode = await stewardTargetPermission(args, config);
      if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
        return { allowed: false, reason: `目标线程权限为「${stewardPermissionLabel(mode)}」,失败重试只能提议` };
      }
      return { allowed: true };
    }
    if (action === 'resume') {
      // resume 为 null 表示跟随既有 autonomyAutoResume(§11.1 第 6 项)。
      const resume = auto.resume === null || auto.resume === undefined ? (config && config.autonomyAutoResume === true) : auto.resume === true;
      return resume ? { allowed: true } : { allowed: false, reason: '「重启后自动续跑」没有开,只能提议' };
    }
    return { allowed: true }; // pause/stop 是收紧类,任何时候都可以做(13g 里也是这个口径)
  }
  return { allowed: true }; // decide / rename:由 13g 内部的 stewardMayAct 与永久豁免清单裁决
}

async function stewardExecuteActions(actions, session, config, trigger) {
  const out = [];
  for (const action of actions) {
    const tool = String(action.tool || '');
    const args = action.args || {};
    const hookKey = STEWARD_ACTION_HOOKS[tool];
    if (!hookKey) {
      out.push({ tool, args, result: stewardFail('not_allowed', `${tool} 不能作为 action 执行(只有写类管家工具可以;只读工具请在回合里直接调用)`) });
      continue;
    }
    const gate = await stewardSelfServeAllows(tool, args, config, trigger);
    if (!gate.allowed) {
      out.push({ tool, args, result: stewardFail('propose_required', gate.reason, { reason: 'self_serve_off' }) });
      continue;
    }
    let result;
    try {
      result = await StewardHooks[hookKey](args, { session, sessionId: session.id, config });
    } catch (error) {
      result = stewardFail('steward.failed', String((error && error.message) || error));
    }
    out.push({ tool, args, result });
  }
  return out;
}

// propose_required 的 action 自动降级成一条 act(§11.3:「不视为失败」)。标签由工具与 args 派生。
function stewardDowngradeActions(executed, acts) {
  const next = acts.slice();
  for (const row of executed) {
    if (next.length >= STEWARD_ACTS_MAX) break;
    const result = row && row.result;
    if (!result || result.ok !== false || result.error !== 'propose_required') continue;
    if (next.some(act => act.kind === 'tool' && act.tool === row.tool && JSON.stringify(act.args || {}) === JSON.stringify(row.args || {}))) continue;
    const act = { label: stewardActLabel(row.tool, row.args), kind: 'tool', tool: row.tool, args: row.args || {} };
    const sid = row.args && (row.args.sessionId || row.args.missionId) ? safeSessionId(row.args.sessionId || row.args.missionId) : '';
    if (sid) act.sessionId = sid;
    if (!next.some(a => a.primary)) act.primary = true;
    next.push(act);
  }
  return next.slice(0, STEWARD_ACTS_MAX);
}

// ────────────────────────────────────────────────────────────────────────────
// 熔断(§11.3):每小时回合数、日费用、无进展、停机。触发时不调模型,只回一条带 circuit 的 steward_reply。
// ────────────────────────────────────────────────────────────────────────────
async function stewardDayCost(config) {
  const today = usageDayKey(Date.now());
  let cost = 0;
  for (const row of await readUsageRows(0).catch(() => [])) {
    if (!row || row.kind !== 'aux' || row.note !== 'steward') continue;
    if (usageDayKey(Date.parse(row.ts)) !== today) continue;
    if (row.costTrusted === false) continue;      // 套餐制名义金额不进真实费用(与 13e/13g 同口径)
    const value = Number(row.cost);
    if (Number.isFinite(value)) cost += value;
  }
  return Math.round(cost * 1e6) / 1e6;
}

// 滑动窗口:表里只留最近 24 小时的回合时间戳(hour 与 day 两个口径都从这一份数据算,不各记一套)。
function stewardTurnsInWindow(now, windowMs) {
  stewardRunnerRuntime.turns = stewardRunnerRuntime.turns.filter(ts => ts > now - STEWARD_TURN_DAY_MS);
  const since = now - (Number(windowMs) || STEWARD_TURN_WINDOW_MS);
  return stewardRunnerRuntime.turns.filter(ts => ts > since).length;
}

async function stewardCircuitCheck(config, trigger) {
  if (stewardRunnerRuntime.stopped) return { kind: 'stopped', detail: '管家已停机(可在设置或 /api/steward/start 恢复)' };
  const maxTurns = Math.max(0, Math.round(Number(config.stewardMaxTurnsPerHour) || 0));
  if (maxTurns > 0 && stewardTurnsInWindow(Date.now(), STEWARD_TURN_WINDOW_MS) >= maxTurns) {
    return { kind: 'turns_per_hour', detail: `本小时已经跑了 ${maxTurns} 个管家回合,先歇一会儿`, limit: maxTurns };
  }
  const maxCost = Number(config.stewardMaxCostPerDay);
  if (Number.isFinite(maxCost) && maxCost > 0) {
    const spent = await stewardDayCost(config);
    if (spent >= maxCost) return { kind: 'cost_per_day', detail: `今天管家自己已经花了 ${spent},到了上限 ${maxCost}`, limit: maxCost, spent };
  }
  // 无进展只挡【收件箱】回合:用户消息永远优先,任何时候都能把管家叫醒(顺带清零退避)。
  if (trigger === 'inbox' && stewardRunnerRuntime.noProgress >= STEWARD_NO_PROGRESS_MAX) {
    return { kind: 'no_progress', detail: `连续 ${STEWARD_NO_PROGRESS_MAX} 次收件箱回合没有任何动作,退避到下一次你说话`, limit: STEWARD_NO_PROGRESS_MAX };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 回合运行器。
// ────────────────────────────────────────────────────────────────────────────
function stewardEventLine(row) {
  const kind = stewardSanitizeText(row && row.kind);
  const sid = stewardSanitizeText(row && row.sessionId);
  const payload = (row && row.payload && typeof row.payload === 'object') ? row.payload : {};
  const summary = stewardSanitizeText(payload.summary || payload.text || payload.type || '');
  const count = Math.max(1, Number(row && row.count) || 1);
  const line = `- [${Number(row && row.inboxSeq) || 0}] ${kind} · 线程 ${sid}${count > 1 ? ` · 同类 ${count} 条` : ''} · ${summary}`;
  return line.slice(0, STEWARD_INBOX_EVENT_CHARS);
}

function stewardInboxMessage(events, config) {
  const pack = getPromptPack(config && config.locale);
  const rows = events.slice(-STEWARD_INBOX_EVENTS_PER_TURN);
  return [pack.steward.inboxHeader({ count: rows.length }), ...rows.map(stewardEventLine), pack.steward.inboxTrailer].join('\n');
}

// 把结构化结果落到管家会话最新一条助手消息的 meta 上(§11.3:「结构化结果落在 …助手消息的 meta」)。
// 只在回合已经收尾后做(单管家并发 1 保证此刻没有在途回合),避免 116c 记过的读改写竞态。
async function stewardStampReply(reply) {
  const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (!session) return '';
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      messages[i].steward = reply;
      await saveSession(session).catch(() => {});
      return String(messages[i].content || '');
    }
  }
  return '';
}

async function stewardLastAssistantContent() {
  const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (!session) return '';
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') return String(messages[i].content || '');
  }
  return '';
}

// 单管家并发 1 + 用户抢占(§11.3):
//   · 用户回合到达时,在途的【收件箱】回合被就地取消(停回合 + 该批事件重排到队列尾),用户永远优先;
//   · 收件箱回合到达时若有任何在途回合,事件回排队列、本次不跑(去抖定时器会再来一次);
//   · 用户回合撞用户回合:排队等前一个收尾(不取消 —— 用户自己的两句话都要答)。
async function runStewardTurn(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const trigger = opts.trigger === 'inbox' ? 'inbox' : 'user';
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const events = Array.isArray(opts.events) ? opts.events : [];
  const config = await readConfig().catch(() => ({}));
  if (config.stewardEnabledV1 !== true) return stewardFail('steward.disabled', 'the workbench steward is disabled (stewardEnabledV1=false)');

  const circuit = await stewardCircuitCheck(config, trigger);
  if (circuit) {
    if (trigger === 'inbox' && events.length) stewardRunnerRuntime.queue.push(...events);
    stewardRunnerRuntime.circuit = { ...circuit, at: nowIso() };
    const reply = { trigger, say: circuit.detail, why: '熔断', acts: [], actions: [], parsed: false, circuit };
    stewardRunnerRuntime.lastReply = { ...reply, at: nowIso() };
    logEvent({ kind: 'steward_circuit', circuit: circuit.kind, trigger });
    return { ok: false, circuit, ...reply };
  }

  const inflight = stewardRunnerRuntime.inflight;
  if (inflight) {
    if (trigger === 'inbox') {
      stewardRunnerRuntime.queue.push(...events);
      return stewardFail('steward.busy', 'a steward turn is already in flight; the inbox batch was re-queued');
    }
    if (inflight.kind === 'inbox') {
      inflight.cancelled = 'preempted';
      stewardRunnerRuntime.queue.push(...(inflight.events || []));   // 事件不丢:重排到下一轮
      stewardAbortInflight(inflight);
      logEvent({ kind: 'steward_preempt', preempted: 'inbox', requeued: (inflight.events || []).length });
    }
    // 无论取消与否都等在途那个收尾:管家会话同一时刻只能有一个回合在写它的正文。
    await Promise.race([
      inflight.promise.catch(() => {}),
      new Promise(resolve => { const t = setTimeout(resolve, STEWARD_PREEMPT_WAIT_MS); if (t && t.unref) t.unref(); }),
    ]);
  }

  const ensured = await ensureStewardSession(config);
  if (!ensured.ok) {
    return stewardFail(ensured.error, ensured.message || 'steward engine is unsupported', { engine: ensured.engine });
  }
  const session = ensured.session;
  const message = trigger === 'inbox' ? stewardInboxMessage(events, config) : String(opts.message == null ? '' : opts.message);
  if (!message.trim()) return stewardFail('invalid_request', 'message is required');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const entry = { kind: trigger, controller, cancelled: '', events, promise: null };
  if (!stewardRunnerRuntime.visit.startedAt) stewardRunnerRuntime.visit.startedAt = nowIso();
  stewardRunnerRuntime.visit.lastActivityAt = nowIso();
  stewardRunnerRuntime.turns.push(Date.now());

  const run = (async () => {
    try {
      return await runSessionTurn({
        sessionId: session.id,
        message,
        cwd: session.cwd,
        source: 'steward',
        engineRoute: ensured.route,
        // 收件箱回合的这条 user 消息【不是用户本人说的话】:origin 随会话正文落盘,
        // steward_memory_write 的来源校验据此确定性拒绝它(13g stewardSourceIsUserMessage)。
        messageMeta: trigger === 'inbox' ? { origin: 'inbox', inboxSeqs: events.map(e => Number(e && e.inboxSeq) || 0).slice(0, STEWARD_INBOX_EVENTS_PER_TURN) } : null,
        requestMeta: { steward: true, trigger },
        onEvent,
        signal: controller ? controller.signal : null,
      });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })();
  entry.promise = run;
  stewardRunnerRuntime.inflight = entry;

  let turn = null;
  try {
    turn = await run;
  } finally {
    if (stewardRunnerRuntime.inflight === entry) stewardRunnerRuntime.inflight = null;
  }
  stewardRunnerRuntime.visit.lastActivityAt = nowIso();

  if (entry.cancelled) {
    logEvent({ kind: 'steward_turn_cancelled', reason: entry.cancelled, trigger });
    return stewardFail('steward.cancelled', `steward turn cancelled: ${entry.cancelled}`, { trigger });
  }

  // 回合本身失败(端点不通/被停/装载抛错)时【不能】去读「最后一条助手消息」—— 那是【上一个】回合
  // 的话,拿它当本回合的回答就是把旧答复冒充成新答复。如实回一条稳定信封,say 留给界面说人话。
  if (turn && turn.ok === false) {
    const detail = String(turn.error || '').slice(0, 300);
    logEvent({ kind: 'steward_turn_failed', trigger, error: detail });
    return stewardFail('steward.turn_failed', detail || 'the steward turn did not complete', { trigger, stopped: !!turn.stopped });
  }
  const finalText = await stewardLastAssistantContent();
  const parsedReply = stewardParseReply(finalText);
  const executed = parsedReply.actions.length
    ? await stewardExecuteActions(parsedReply.actions, session, config, trigger)
    : [];
  const acts = stewardDowngradeActions(executed, parsedReply.acts);
  const reply = {
    trigger,
    say: parsedReply.say,
    why: parsedReply.why,
    acts,
    actions: executed,
    parsed: parsedReply.parsed,
    turnSeq: Number(turn && turn.turnSeq) || 0,
    sessionId: session.id,
    circuit: null,
  };
  await stewardStampReply({ say: reply.say, why: reply.why, acts: reply.acts, actions: reply.actions, parsed: reply.parsed, trigger });

  // 无进展熔断的计数:只看收件箱回合(用户回合永远清零 —— 用户说话就是进展)。
  if (trigger === 'inbox') {
    if (!acts.length && !executed.length) stewardRunnerRuntime.noProgress += 1;
    else stewardRunnerRuntime.noProgress = 0;
  } else {
    stewardRunnerRuntime.noProgress = 0;
  }
  stewardRunnerRuntime.lastReply = { ...reply, at: nowIso() };
  return { ok: true, ...reply };
}

// ────────────────────────────────────────────────────────────────────────────
// 收件箱驱动:116b 每轮写完箱子调 onInboxBatch,这里做 5 秒去抖后起一个收件箱回合。
// ────────────────────────────────────────────────────────────────────────────
function stewardOnInboxBatch(rows) {
  if (stewardRunnerRuntime.stopped) return;
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return;
  stewardRunnerRuntime.queue.push(...list);
  if (stewardRunnerRuntime.debounceTimer) return;
  const timer = setTimeout(() => {
    stewardRunnerRuntime.debounceTimer = null;
    if (stewardRunnerRuntime.stopped) return;
    const batch = stewardRunnerRuntime.queue.splice(0, STEWARD_INBOX_EVENTS_PER_TURN);
    if (!batch.length) return;
    void runStewardTurn({ trigger: 'inbox', events: batch }).catch(() => {});
  }, STEWARD_DEBOUNCE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  stewardRunnerRuntime.debounceTimer = timer;
}

// ────────────────────────────────────────────────────────────────────────────
// 到访(§8.9「每次打开」/§11.1 第 7 项「一次到访 = 页面重开,或静默 60 分钟」)。
//
// 摘要是【确定性】的:由 inbox 自上次到访以来的事件按五类归纳,不调模型 —— 打开如意的第一屏不该
// 等一次模型往返,也不该因为端点不通就什么都看不到。
// ────────────────────────────────────────────────────────────────────────────
function stewardVisitsDir() { return path.join(stewardDir(), STEWARD_VISITS_DIR); }

// 归档文件名:ISO 时间戳里的 ':' 与 '.' 在 Windows 文件名里非法,换成 '-'(§CONTRIBUTING 第 4 条)。
function stewardVisitFileName(at) {
  return String(at || nowIso()).replace(/[:.]/g, '-') + '.json';
}

async function stewardTrimVisits() {
  const dir = stewardVisitsDir();
  const files = (await fsp.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json')).sort();
  if (files.length <= STEWARD_VISITS_KEEP) return;
  for (const file of files.slice(0, files.length - STEWARD_VISITS_KEEP)) {
    await fsp.unlink(path.join(dir, file)).catch(() => {});
  }
}

// 按 stewardConversationRetention 归档管家会话历史。
//   visit   : 整段归档后清空(默认,§8.1 原则 8「对话不是档案」);
//   24h     : 只归档 24 小时前的消息,近 24 小时留在会话里;
//   forever : 不归档不清空。
// 返回 { archived, file, kept }。
async function stewardArchiveConversation(config, startedAt) {
  const retention = String((config && config.stewardConversationRetention) || 'visit');
  if (retention === 'forever') return { archived: 0, file: '', kept: -1 };
  const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (!session) return { archived: 0, file: '', kept: 0 };
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (!messages.length) return { archived: 0, file: '', kept: 0 };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const keepFrom = retention === '24h'
    ? messages.findIndex(m => {
      const at = Date.parse(String((m && m.createdAt) || ''));
      return Number.isFinite(at) && at >= cutoff;
    })
    : messages.length;
  const splitAt = keepFrom < 0 ? messages.length : keepFrom;
  const archived = messages.slice(0, splitAt);
  if (!archived.length) return { archived: 0, file: '', kept: messages.length };
  const at = nowIso();
  const file = path.join(stewardVisitsDir(), stewardVisitFileName(startedAt || at));
  await fsp.mkdir(stewardVisitsDir(), { recursive: true });
  await atomicWriteJson(file, {
    schema: STEWARD_VISIT_SCHEMA,
    sessionId: STEWARD_SESSION_ID,
    startedAt: String(startedAt || ''),
    archivedAt: at,
    retention,
    messages: archived,
  });
  // 正文按保留策略截断。providerHistory 与消息不是一一对应(工具轮次更多),整段清空是唯一
  // 安全的做法:留半截会让下一回合带着孤儿 tool_calls 去请求(strict provider 直接 400)。
  session.messages = messages.slice(splitAt);
  session.providerHistory = [];
  session.providerHistoryCursor = session.messages.length;
  session.autoCompactWatermark = 0;
  await saveSession(session).catch(() => {});
  await stewardTrimVisits();
  return { archived: archived.length, file: path.basename(file), kept: session.messages.length };
}

// 确定性到访摘要:自上次到访以来的收件箱事件按五类归纳成 ≤5 条人话。
async function stewardVisitDigest(sinceSeq) {
  const read = await stewardInboxRead({ since: sinceSeq, limit: 200 }).catch(() => ({ items: [], inboxSeq: 0 }));
  const counts = {};
  for (const kind of STEWARD_EVENT_KINDS) counts[kind] = 0;
  for (const row of (read.items || [])) {
    if (Object.prototype.hasOwnProperty.call(counts, row && row.kind)) counts[row.kind] += Math.max(1, Number(row.count) || 1);
  }
  const items = [];
  for (const kind of STEWARD_EVENT_KINDS) {
    if (items.length >= STEWARD_VISIT_DIGEST_MAX) break;
    if (counts[kind] > 0) items.push({ kind, text: STEWARD_DIGEST_KIND_TEXT[kind](counts[kind]), count: counts[kind] });
  }
  return { items, counts, inboxSeq: Math.max(0, Number(read.inboxSeq) || 0) };
}

// 待决列表(来自投影,不读磁盘 —— 投影本身就是可重建物化索引)。
async function stewardPendingList() {
  const index = await getPretenderProjectionIndex().catch(() => null);
  const out = [];
  for (const slice of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
    const sid = slice && safeSessionId(slice.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) continue;
    for (const iv of (Array.isArray(slice.interventions) ? slice.interventions : [])) {
      if (!iv || iv.status !== 'pending') continue;
      if (out.length >= STEWARD_PENDING_LIST_MAX) return out;
      out.push({
        sessionId: sid,
        missionId: String(slice.missionId || sid),
        interventionId: String(iv.id || ''),
        type: String(iv.type || ''),
        summary: stewardPendingOneLine(iv),
      });
    }
  }
  return out;
}

async function stewardVisit(opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const config = await readConfig().catch(() => ({}));
  if (config.stewardEnabledV1 !== true) return stewardFail('steward.disabled', 'the workbench steward is disabled (stewardEnabledV1=false)');
  const idleMinutes = Math.max(1, Math.round(Number(config.stewardVisitIdleMinutes) || 60));
  const lastActivity = Date.parse(String(stewardRunnerRuntime.visit.lastActivityAt || ''));
  const idle = !Number.isFinite(lastActivity) || (Date.now() - lastActivity) > idleMinutes * 60 * 1000;
  const newVisit = options.force === true || idle;
  const previousStartedAt = stewardRunnerRuntime.visit.startedAt;
  const sinceSeq = Math.max(0, Number(stewardRunnerRuntime.visit.inboxSeq) || 0);

  let archive = { archived: 0, file: '', kept: -1 };
  if (newVisit) {
    archive = await stewardArchiveConversation(config, previousStartedAt || nowIso()).catch(() => ({ archived: 0, file: '', kept: -1 }));
    // 到访重置:读预算桶(§11.2 每回合 6 次 / 每到访 stewardReadBudgetChars)与无进展计数一起归零。
    try { _stewardReadBudget.delete(STEWARD_SESSION_ID); } catch { /* 桶是纯内存加速,清不掉也不影响正确性 */ }
    stewardRunnerRuntime.noProgress = 0;
    stewardRunnerRuntime.circuit = null;
    stewardRunnerRuntime.visit = {
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      inboxSeq: sinceSeq,
      previousStartedAt: previousStartedAt || '',
    };
  }
  const digest = await stewardVisitDigest(sinceSeq);
  if (newVisit) stewardRunnerRuntime.visit.inboxSeq = digest.inboxSeq;   // 下次到访从这里往后归纳
  const pending = await stewardPendingList();
  // 焦点线程:等你 > 在跑 > 失败(§8.10「现在这一件」的同一口径),没有线程时为空。
  const rows = await stewardThreadDigestRows(config).catch(() => []);
  const focusRow = rows.find(r => r.state === 'needs_you') || rows.find(r => r.state === 'running') || rows[0] || null;
  return {
    ok: true,
    newVisit,
    since: previousStartedAt || '',
    visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
    archive,
    digest: { items: digest.items, counts: digest.counts },
    pending,
    focus: focusRow ? { sessionId: focusRow.sessionId, title: focusRow.digest.title, state: focusRow.state } : null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// acts 落定:用户点了一个按钮。tool 走 13g 的同一实现(同一门控、同一决策日志),
// dismiss 只记一行日志,open_thread 只回 sessionId(切换由 UI 完成)。
// ────────────────────────────────────────────────────────────────────────────
async function stewardRunAct(act, config) {
  const raw = (act && typeof act === 'object') ? act : {};
  const kind = String(raw.kind || (raw.tool ? 'tool' : ''));
  if (kind === 'dismiss') {
    logEvent({ kind: 'steward_act_dismissed', label: String(raw.label || '').slice(0, 40) });
    return { ok: true, kind: 'dismiss' };
  }
  if (kind === 'open_thread') {
    const sid = safeSessionId(raw.sessionId);
    if (!sid) return stewardFail('invalid_request', 'open_thread act needs a valid sessionId');
    return { ok: true, kind: 'open_thread', sessionId: sid };
  }
  if (kind !== 'tool') return stewardFail('invalid_request', `unknown act kind: ${stewardSanitizeText(kind)}`);
  const tool = String(raw.tool || '');
  const hookKey = STEWARD_ACTION_HOOKS[tool];
  if (!hookKey) return stewardFail('not_allowed', `${stewardSanitizeText(tool)} 不能作为 act 执行`);
  const ensured = await ensureStewardSession(config);
  if (!ensured.ok) return stewardFail(ensured.error, ensured.message || 'steward engine is unsupported');
  const args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
  // 用户【亲自】按下的按钮:自理清单不适用(那是「管家该不该主动做」的清单),但目标线程权限与
  // 永久豁免清单照旧由 13g 内部裁决 —— 管家不会因为用户点了一下就获得放宽权限的能力。
  const result = await StewardHooks[hookKey](args, { session: ensured.session, sessionId: ensured.session.id, config });
  // 按钮【被执行了】就是 ok:true —— 工具自己的稳定信封(propose_required / not_found / version_conflict …)
  // 原样放在 result 里交给界面去说人话。只有 act 本身不合法(未知 kind、非管家工具、开关关)才是 4xx:
  // 把「工具说不行」翻译成 HTTP 错误会让前端分不清「按钮坏了」和「这件事不该这么做」。
  return { ok: true, kind: 'tool', tool, executed: !!(result && result.ok !== false), result };
}

// ────────────────────────────────────────────────────────────────────────────
// 路由(token 级,ROUTE_AUTH 在 01b 登记)。经 13g 的 handleStewardApiRoutes 末尾转交(见那里的注释)。
// ────────────────────────────────────────────────────────────────────────────
async function handleStewardRunnerApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/steward/visit') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await stewardVisit({ force: body && body.force === true });
    if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 409));
    return send(res, json(result));
  }

  if (req.method === 'POST' && pathname === '/api/steward/act') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await stewardRunAct(body && body.act, config);
    if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 400));
    return send(res, json(result));
  }

  if (req.method === 'POST' && pathname === '/api/steward/message') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const message = String((body && body.message) || '');
    if (!message.trim()) return send(res, apiFailure('invalid_request', {}, 'message is required', 400));
    // SSE 壳:与 /api/chat/stream 同款 NDJSON + 50ms delta 合批(那边的壳是 streamChat,这里是它的
    // 同形副本 —— 管家回合不经 /api/chat/stream,但前端拿到的事件流形状必须一样)。
    let deltaBuffer = []; let flushTimer = null;
    const flushDeltas = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!deltaBuffer.length) return;
      const merged = [];
      for (const d of deltaBuffer) {
        const last = merged[merged.length - 1];
        if (last && last.type === d.type) last.text = (last.text || '') + (d.text || '');
        else merged.push({ ...d });
      }
      deltaBuffer = [];
      for (const evt of merged) {
        try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
      }
    };
    const writeEvent = evt => {
      if (evt && (evt.type === 'assistant_delta' || evt.type === 'thinking_delta')) {
        deltaBuffer.push(evt);
        if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
        return;
      }
      flushDeltas();
      try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
    };
    try { req.socket.setNoDelay(true); } catch { /* ignore */ }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try { res.flushHeaders(); } catch { /* ignore */ }
    try {
      const result = await runStewardTurn({ trigger: 'user', message, onEvent: writeEvent });
      // 流的最后一帧 = 这次请求的响应载荷(见文件头「steward_reply 的投放口径」)。失败态也发这一帧:
      // 响应头早已发出,不能再改回 4xx 信封,故把稳定信封的 error/message 放进同一帧里,前端一处分支即可。
      const reply = (result && typeof result === 'object') ? result : {};
      writeEvent({
        type: 'steward_reply',
        trigger: 'user',
        say: String(reply.say || ''),
        why: String(reply.why || ''),
        acts: Array.isArray(reply.acts) ? reply.acts : [],
        actions: Array.isArray(reply.actions) ? reply.actions : [],
        parsed: reply.parsed === true,
        circuit: reply.circuit || null,
        ...(reply.ok === false && reply.error ? { error: reply.error, message: reply.message || '' } : {}),
      });
    } finally {
      flushDeltas();
      try { res.end(); } catch { /* client gone */ }
    }
    return;
  }
}

// GET /api/steward/state 的运行器半边(13g 把它并进收件箱状态里一起下发)。
async function stewardRunnerState(config) {
  const now = Date.now();
  return {
    visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
    turns: { hour: stewardTurnsInWindow(now, STEWARD_TURN_WINDOW_MS), day: stewardTurnsInWindow(now, STEWARD_TURN_DAY_MS) },
    cost: { day: await stewardDayCost(config).catch(() => 0) },
    circuit: stewardRunnerRuntime.circuit,
    lastReply: stewardRunnerRuntime.lastReply,
    stopped: stewardRunnerRuntime.stopped,
    inflight: stewardRunnerRuntime.inflight ? stewardRunnerRuntime.inflight.kind : '',
    queued: stewardRunnerRuntime.queue.length,
    noProgress: stewardRunnerRuntime.noProgress,
  };
}

// 延迟绑定(与 13g 同一手法):06i 声明空命名空间,本文件在加载时填充 116f 的实现键。
// 消费者 09(提示词分叉)、10(预算分叉与摘要 prompt)、13g(轮询器出口/state/路由转交)全程只看
// StewardHooks.*,从不直接引用 13h —— 13h 因此零入边,不进任何强连通分量。
Object.assign(StewardHooks, {
  buildSystemPrompt: buildStewardSystemPrompt,
  contextBudget: stewardContextBudget,
  visitNotesPrompt: stewardVisitNotesPrompt,
  onInboxBatch: stewardOnInboxBatch,
  runnerState: stewardRunnerState,
  handleRunnerApiRoutes: handleStewardRunnerApiRoutes,
  stopRunner: stewardStopRunner,
  resumeRunner: stewardResumeRunner,
  // 116-pre(§11.3):117 壳层与其它旁路消费者经这个键调,不必知道 13h 的存在。
  preroute: stewardPreroute,
});
