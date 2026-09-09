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
// 117s-H1(27 号文 §11.13.3):事件行仍是那 400 字的标题行,交付正文另起一个【受预算的引用块】
// 跟在它后面 —— 于是模型不必再花一次 steward_thread_read 配额去读它自己刚被通知的那份交付。
const STEWARD_INBOX_DELIVERABLE_CHARS = 4000; // 单条交付正文在收件箱消息里的上限
const STEWARD_INBOX_MESSAGE_CHARS = 12000;    // 一条收件箱消息的总预算(标题行永不丢,正文从最旧的丢起)
const STEWARD_MEMORY_BLOCK_CHARS = 3000;      // 记忆块 ≤3000 字符
const STEWARD_SAY_MAX = 600;                  // say ≤600 字
const STEWARD_WHY_MAX = 400;
const STEWARD_ACT_LABEL_MAX = 12;             // 按钮文字 ≤12 字
const STEWARD_ACTS_MAX = 3;                   // 一次回合按钮 ≤3 个
const STEWARD_ACTIONS_MAX = 5;                // 一次回合最多执行 5 条 action(其余丢弃并如实标注)
const STEWARD_DEBOUNCE_MS = 5000;             // 收件箱去抖窗口
// 116-4(27 号文 §11.7 第 2 项「速查闭环」):速查线程的答案是【用户正在等的那一句】。让它也压满
// 5 秒去抖,用户的体感就是「问一次要等两趟」。带 quick:true 的 done 行把本次去抖压到 0,其余事件
// 仍走 5 秒 —— 它们是通知,不是有人正等着的答案。
const STEWARD_QUICK_DEBOUNCE_MS = 0;          // 速查答案:不去抖,立刻起回合
const STEWARD_NO_PROGRESS_MAX = 5;            // 连续 5 次收件箱回合零 acts 零 actions -> 退避
const STEWARD_VISIT_DIGEST_MAX = 5;           // 到访摘要 ≤5 条人话
const STEWARD_PENDING_LIST_MAX = 20;          // 到访返回的待决列表上限
const STEWARD_TURN_WINDOW_MS = 60 * 60 * 1000; // 每小时回合上限的滑动窗口
const STEWARD_TURN_DAY_MS = 24 * 60 * 60 * 1000; // 回合时间戳表只保留 24 小时(state 的 day 口径同源)
const STEWARD_PREEMPT_WAIT_MS = 15000;        // 抢占后等在途回合收尾的上限
// 117l D3(§11.9;用户第四轮走查第 6 条「为啥输出完了还显示『在忙上一件』;要能让用户连续发消息」):
// 用户回合撞用户回合时【真】排队等前一个收尾的上限。修前是一发 Promise.race(15s) 之后【不复查】,
// 超时就带着一个还在写正文的回合再开一个 —— 两个回合同时写管家会话正文,后一条把前一条盖掉。
const STEWARD_USER_QUEUE_WAIT_MS = 5 * 60 * 1000;
// ── 116-2b 自理动作(§3.3 自理清单的【真实执行】)──────────────────────────────────────────
const STEWARD_SELF_SERVE_ATTEMPT_MAX = 2;    // 同一目标连续 2 次自理动作后仍失败 -> 停自动、只提议
const STEWARD_SELF_SERVE_RETRY_WINDOW_MS = 60 * 60 * 1000; // 同一目标本小时只自动重试一次
const STEWARD_SELF_SERVE_PER_TURN_MAX = 3;   // 一个收件箱回合最多自理 3 个目标(其余进回合层)

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
  steward_thread_prioritize: 'threadPrioritize',   // 116h:§8.10 看板每行的「提升优先级」按钮
  steward_decide: 'decide',
  steward_run_action: 'runAction',
  steward_thread_stop: 'threadStop',               // 117m-A4:线程级停止(不在表里 = 按钮按下去 4xx)
  steward_memory_write: 'memoryWrite',
  steward_memory_veto: 'memoryVeto',
  // 116-2e:两个「须确认」的写工具。它们在模型回合里一定回 propose_required(ctx 里没有
  // userPressed),被 stewardDowngradeActions 降级成一个按钮;用户按下那个按钮走
  // POST /api/steward/act,那条路径才置 ctx.userPressed = true。
  steward_config_set: 'configSet',
  steward_skill_toggle: 'skillToggle',
});

// 降级成按钮时的人话标签(§8.4「话＋一行按钮」:按钮上写用户要做的那件事,不写工具名)。
const STEWARD_DECIDE_LABELS = Object.freeze({ allow: '允许', deny: '拒绝', approve: '批准', reject: '驳回', answer: '回答' });
const STEWARD_RUN_ACTION_LABELS = Object.freeze({ pause: '暂停', resume: '继续', stop: '停止', retry_node: '重试', steer_node: '插话' });
const STEWARD_TOOL_LABELS = Object.freeze({
  steward_thread_new: '新开线程', steward_thread_continue: '接着办', steward_thread_rename: '改标题',
  steward_memory_write: '记下', steward_memory_veto: '别记',
  steward_thread_prioritize: '插到最前',
  steward_thread_stop: '暂停这条线程',                            // 117m-A4
  steward_config_set: '改设置', steward_skill_toggle: '改技能',   // 116-2e
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
  debounceMs: -1,       // 116-4:当前那个定时器排的是多久(用来判「该不该重排成更快的」)
  lastReply: null,      // 最近一次 steward_reply 的精简副本(供 /api/steward/state)
  circuit: null,        // 最近一次触发的熔断 { kind, at, detail }
  stopped: false,       // 一键停机:停轮询的同时停回合队列
  // 116-2b:自理动作的每目标账。targetKey = sessionId|runId。只在内存(进程重启 = 重新开始数;
  // 与 §11.1 第 7 项「重启即新到访」同一立场:重启后第一次仍值得试一次,连着失败才该停手)。
  selfServe: new Map(),  // targetKey -> { attempts, lastRetryAt, lastActionAt }
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
  // 116g:事项标题只在【真有事项文件】时填。「未归类」事项(missionId === sessionId、无事项文件)的
  // 标题就是线程标题,填了等于把同一句话在总览行里重复一次(见下方 missionTitle 处的原注释)。
  // 按需读、按 missionId 记忆:总览一次最多读【出现过的事项】那么多个文件,不扫整个 missions 目录
  // (事项数上限 2000,全扫会让每次到访多出上千次文件读)。
  const missionTitles = new Map();
  const missionTitleOf = async missionId => {
    if (!missionTitles.has(missionId)) {
      const container = await readMissionContainer(missionId).catch(() => null);
      missionTitles.set(missionId, container ? container.title : '');
    }
    return missionTitles.get(missionId);
  };
  const rows = [];
  const now = Date.now();
  for (const slice of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
    const sid = slice && safeSessionId(slice.sessionId);
    if (!sid || sid === STEWARD_SESSION_ID) continue;
    const head = await stewardReadSessionHead(sid);
    if (!head || !head.id) continue;
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') continue;   // 排除面:按会话头【原始】 kind 判,不经 sessionKind()
    // 116-2e(§11.1 第 2 项):已收工的速查线程不占总览的注意力预算(判据单点在 13g 的
    // stewardQuickClosed,与 steward_threads_search 逐字同源;经 StewardHooks 调,同一条延迟绑定纪律)。
    if (typeof StewardHooks.quickClosed === 'function' && StewardHooks.quickClosed(head)) continue;
    const card = slice.card ? overlayMissionCard(slice) : null;
    const derived = card
      ? stewardThreadStateFromCard(card)
      : deriveStewardThreadState({
        // 116-3 P1-5:只有【管家自己用 steward_quick_ask 开的】速查线程才是 quick_ask。
        // 判据与 13g 的 threads_search / thread_status 同一个函数(13h -> 13g 是后向边),
        // 不再用「非 mission 即 quick_ask」那个把普通对话也一并打上标签的兜底。
        kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',
        autoMode: head.mission && head.mission.autoMode,
        resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
        activeTurn: activeChildren.has(sid),
        turnSeq: head.turnSeq,
        // 117p-S2:与 13g thread_status / 13d 事项聚合同一个喂法 —— 无账本判据只认
        // 「头上没有 mission 容器」,与卡片侧 card.status === 'none' 同义。
        ledgerless: !head.mission,
        lastTurnFailed: !!(head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)),
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
    // 116h(§8.10「排队可解释」):总览行的等待原因也走 06i 的 waitReasonFor 单点 —— 管家在提示词里
    // 读到的那句话,与 steward_thread_status / 看板 / steward_missions 逐字相同。
    const wait = waitReasonFor({ pending: pendingCount }, stewardArbiterWait(sid));
    rows.push({
      sessionId: sid,
      // 116-pre(§8.12/§11.3):递话预判的 index 行要 missionId——3.0 里等于 sessionId(见下方注释),
      // 加在这里而不是 digest 里,因为 buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,
      // 多一个 missionId 键对总览行的拼装零影响(新增只加不改)。
      missionId: sessionMissionId(head) || sid,
      // 116-5b(§11.8.5):这条线程的【显示名】(人起的 > 生成的 > 原话,判据单点在 02 的
      // sessionDisplayTitle)。与 missionId 同一条理由放在行的顶层而不是 digest 里:
      // buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,多一个顶层键对总览行的
      // 拼装零影响。**digest.title 仍是原话** —— 管家读到的是用户当时怎么说的,那比一个名字信息更全;
      // 需要显示名的是壳层(「现在这一件」、递送候选),它们读这个字段。
      displayTitle: sessionDisplayTitle(head),
      updatedAt: String(head.updatedAt || ''),
      state: derived.state,
      wait,   // 116h:结构化形状(与另外三个展示面同形),给 117 壳层与旁路消费者读
      digest: {
        id: sid,
        // 事项标题:116g 起,归入了【真事项】(有事项文件)的线程在总览行里带上事项自己的标题,
        // 「未归类」线程仍恒为空 —— 那种情况下事项标题就是线程标题,写两遍等于把同一句话在总览里
        // 重复一次(buildStewardDigestLine 对空段整段跳过)。
        missionTitle: (await missionTitleOf(sessionMissionId(head) || sid)) || '',
        title: head.title || '',
        state: derived.state,
        action: activeChildren.has(sid) ? '回合进行中' : (lastRun ? `班组 ${lastRun.status || ''}` : ''),
        lastSay: head.summary || '',
        // 116h:人话取 waitReasonFor 的 label(pendingCount > 0 时逐字仍是「等你(N 条待决)」,
        // 与 116f 的原措辞一致;新增的是等锁/等预算/等并发位三种)。
        waitReason: wait ? wait.label : '',
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
// 它的整体 revision 已经是「本次投影所有 changeSeq 与卡片状态」的一个哈希摘要 —— 拿它当缓存键的一半,
// 比自己重新求和一遍 changeSeq 更省一次遍历。(116-5b 补上另一半 builtAt:revision 只覆盖【有卡片的】
// 会话,速查线程的会话头改了它不会变 —— 详见下面 stewardPrerouteIndexRows 里那段注释。)
// 命中时跳过的是【每会话一次 stewardReadSessionHead 文件读】那一段(§11.3 的目标 p50 ≤50ms 主要靠它)。
// 只在内存,不写盘;开关关时这段代码根本不会被调到(见路由分支)。
const _stewardPrerouteCache = { revision: '', rows: [] };
async function stewardPrerouteIndexRows(config) {
  const index = await getPretenderProjectionIndex().catch(() => null);
  // 116-5b:缓存键从「只看 revision」改成「revision + builtAt」。revision 只由【事项卡片】与待决行
  // 算出(见 13e finalizePretenderIndex:missionRows 过滤掉了 card 为 null 的会话),所以一条
  // 【速查线程】的会话头改了 —— 比如本波的摘要刚落盘 —— revision 一个字节都不会变,这里就会一直
  // 回一份旧行,递送候选列表于是永远显示那条速查线程的原话。而速查线程恰恰是本波最需要起名字的那种
  // (13g 建完显式清了 titleSource 就是为了让它拿到摘要)。builtAt 只在投影【真的重建过】时才变
  // (getPretenderProjectionIndex 没有脏会话时直接返回同一个对象),所以连续敲字那段快路径一次没丢,
  // 多出来的只是「投影确实重建了一次」时多装配一次行。ETag 那一侧完全不受影响:这是 13h 自己的
  // 进程内 memo 键,不是 revision 的定义。
  const revision = String((index && index.revision) || '') + '|' + String((index && index.builtAt) || '');
  if (index && revision === _stewardPrerouteCache.revision) return _stewardPrerouteCache.rows;
  const digestRows = await stewardThreadDigestRows(config);
  const rows = digestRows.map(row => ({
    sessionId: row.sessionId,
    missionId: row.missionId || row.sessionId,
    missionTitle: (row.digest && row.digest.missionTitle) || '',
    title: (row.digest && row.digest.title) || '',
    // 116-5b:显示名单独一个键。**不覆盖 title** —— prerouteText 的词法打分吃的就是 title,
    // 把它换成压过的名字等于把用户当时打的那些词从索引里抹掉(见 06i stewardPrerouteHit 处的原注释)。
    displayTitle: row.displayTitle || (row.digest && row.digest.title) || '',
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
    // 117l D5:总览行的名字用【显示名】。修前这里是原话 title —— 用户机器上十几条还没起名的线程
    // 于是被管家一律叫成「New session」。**digest.title 本身不动**:preroute 的词法打分吃的就是它
    // (见 stewardPrerouteIndexRows 处的原注释),把索引里的原话换掉等于把用户当时打的词抹了。
    const line = buildStewardDigestLine({ ...row.digest, title: row.displayTitle || row.digest.title });
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
  // 117l:本波三条纪律(见 06b 的 rules 头注:英文稳定层已到 2453/2500,塞不下)。恒在,零条件。
  parts.push(pack.steward.rules);
  // 117l D1:输入区预判只是【提示】。它随这一回合的用户消息一起来(POST /api/steward/message 的
  // routeHint),挂在回合登记项上 —— 管家并发恒为 1,故「当前在途的那个 entry」就是本回合,不会串。
  // 无 hint 时这一段整段不输出:老载荷逐字节零变化(prompt-snapshot 据此只看 steward 段)。
  const hint = stewardRunnerRuntime.inflight && stewardRunnerRuntime.inflight.routeHint;
  if (hint && Array.isArray(hint.rows) && hint.rows.length) parts.push(pack.steward.routeHintBlock({ rows: hint.rows }));
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
  // 117m-A4:线程级停止与 run_action{pause,stop} 同族 —— 收紧类,无人值守也可以做。写成显式一行
  // 而不是靠函数末尾的兜底 return:这是一条【口径】,不该长得像「忘了登记所以放行」。
  if (tool === 'steward_thread_stop') return { allowed: true };
  return { allowed: true }; // decide / rename:由 13g 内部的 stewardMayAct 与永久豁免清单裁决
}

// 116-3 P2-11:「每回合最多自理 3 个目标」是【一个】上限,不是两个。修前
// STEWARD_SELF_SERVE_PER_TURN_MAX(3,只管确定性自理)与 STEWARD_ACTIONS_MAX(5,只管模型声明的
// actions)彼此独立、不去重 sessionId,于是一个回合合规地触达 3+5=8 条不同线程 —— 与 §11.3 写的
// 「≤3 个自理目标」对不上。priorTargets 把自理侧【真的动过】的目标带进来,两边合起来数。
async function stewardExecuteActions(actions, session, config, trigger, priorTargets) {
  const out = [];
  const touched = new Set((Array.isArray(priorTargets) ? priorTargets : []).filter(Boolean));
  for (const action of actions) {
    const tool = String(action.tool || '');
    const args = action.args || {};
    const hookKey = STEWARD_ACTION_HOOKS[tool];
    // 116-3 copy P1-1(§8.1 原则 7「界面不出现系统内部词」):每一行都带上工具的人话标签。
    // ※ 浮层此前把 `steward_thread_continue` 这种内部标识符原样吐给用户,而同一批 id 在「行动流水」
    // 里早就有一份人话映射 —— 同一个动作在两处一个是中文一个是英文下划线。后端把 label 放进行里,
    // 前端优先读它(读不到才回落工具名),两处从此说同一句话,前端也不必再 import 第二份映射表。
    // 三条出口(未登记工具 / 被闸门挡下 / 真执行)都要带,否则 ※ 里仍会漏出工具 id。
    // 用 stewardActLabel 而不是直接查 STEWARD_TOOL_LABELS:decide / run_action 的人话按【动作】给
    //(「允许」「重试」「续跑」),不是按工具名给,而降级成按钮时用的正是同一个函数 —— 一处口径。
    const label = stewardActLabel(tool, args);
    if (!hookKey) {
      out.push({ tool, label, args, result: stewardFail('not_allowed', `${tool} 不能作为 action 执行(只有写类管家工具可以;只读工具请在回合里直接调用)`) });
      continue;
    }
    // 116-3 P2-11:同一回合触达的【不同目标线程】总数硬顶 3(与确定性自理共用同一个数)。
    // 超出的照既有路径降级成一条按钮(propose_required 不算失败)。对同一条线程的第二个动作不再计数
    // ——「3 个目标」数的是目标,不是动作次数。
    const target = args && (args.sessionId || args.missionId) ? safeSessionId(args.sessionId || args.missionId) : '';
    if (target && !touched.has(target) && touched.size >= STEWARD_SELF_SERVE_PER_TURN_MAX) {
      out.push({ tool, label, args, result: stewardFail('propose_required',
        `这一回合已经动过 ${touched.size} 条线程(每回合最多 ${STEWARD_SELF_SERVE_PER_TURN_MAX} 条),这一条只能作为提议交给用户`,
        { reason: 'per_turn_target_max', sessionId: target }) });
      continue;
    }
    const gate = await stewardSelfServeAllows(tool, args, config, trigger);
    if (!gate.allowed) {
      out.push({ tool, label, args, result: stewardFail('propose_required', gate.reason, { reason: 'self_serve_off' }) });
      continue;
    }
    if (target) touched.add(target);
    let result;
    try {
      // 116-3 P0-2:trigger 进 ctx —— 13g 的线程族三工具据它区分「用户就在跟前」(直递)与
      // 「无人值守的收件箱回合」(要过自理清单 + 目标线程权限两道闸)。本文件不复制那套判据。
      result = await StewardHooks[hookKey](args, { session, sessionId: session.id, config, trigger });
    } catch (error) {
      result = stewardFail('steward.failed', String((error && error.message) || error));
    }
    out.push({ tool, label, args, result });
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
    // 116-2b:自理动作降级时用它自己的人话标签(「重试」/「续跑」)——它是按【意图】提的,
    // 不是按工具名提的:回合类重试走的是 thread_continue,按工具名会说成「接着办」,那不是用户
    // 要按的那件事。没有显式标签时仍按工具与 args 派生(既有行为逐字不变)。
    const act = { label: String(row.label || '').slice(0, STEWARD_ACT_LABEL_MAX) || stewardActLabel(row.tool, row.args), kind: 'tool', tool: row.tool, args: row.args || {} };
    const sid = row.args && (row.args.sessionId || row.args.missionId) ? safeSessionId(row.args.sessionId || row.args.missionId) : '';
    if (sid) act.sessionId = sid;
    if (!next.some(a => a.primary)) act.primary = true;
    next.push(act);
  }
  return next.slice(0, STEWARD_ACTS_MAX);
}

// ════════════════════════════════════════════════════════════════════════════
// 116-2b · 自理动作的确定性处置(§3.3「管家可以自己做的事」清单的真实执行)
//
// 为什么先于模型、且不经模型:失败重试与重启续跑是【确定性】的处置 —— 该不该做由三样东西唯一
// 决定(自理清单勾选 / 目标线程权限 / 该目标最近有没有被管家动过),没有一样需要「理解」。让模型
// 每次都重新推一遍,既慢又不稳定,还会把「能不能做」的判据散到提示词里去。所以:工作台先按规则
// 把该做的做掉,把【结果】当成收件箱事件的补充信息带进回合层,模型只需要「说」——把发生的事讲给
// 用户听、必要时补一个按钮。
//
// 闸门顺序(任一不过就降级成一条提议,不是失败):
//   ① 停机 / 熔断      —— 由 runStewardTurn 的 stewardCircuitCheck 在更外层挡掉(停机时根本不到这里);
//   ② 小时窗           —— 自理动作与管家回合【计入同一个】 stewardMaxTurnsPerHour 窗口;
//   ③ 无进展熔断       —— 同一目标连续 2 次自理动作后仍在报问题 -> 停自动,只提议;
//   ④ 自理清单勾选     —— retry / resume(resume 为 null 时跟随既有 autonomyAutoResume);
//   ⑤ 目标线程权限     —— stewardMayAct(mode,'failed','exec'),续跑按 failed 档口径(§3.3);
//   ⑥ 续跑另加一道     —— classifyRunResumeTier 必须判 auto_resumable(权限面不可证明就不自动);
//   ⑦ 13g 工具内部     —— 永久豁免与 stewardMayAct 的【权威】判据在那里,拿到 propose_required
//                          就照既有路径降级成按钮。本文件不复制那套判据。
//
// relay(事项内交接)本切片仍【只提议】(默认 false,§11.1 第 6 项);newThread 只在 relay 或定时
// 触发时才允许,而本切片没有引入任何定时触发源 —— 故这里【不存在】自动新开线程的路径:自理侧
// 根本不产生这两种 plan,模型若把它们写进 actions 仍由 stewardSelfServeAllows 那两道闸拦下。
// ════════════════════════════════════════════════════════════════════════════

function stewardSelfServeKey(sessionId, runId) {
  return String(sessionId || '') + '|' + String(runId || '');
}
function stewardSelfServeEntry(key) {
  let row = stewardRunnerRuntime.selfServe.get(key);
  if (!row) { row = { attempts: 0, lastRetryAt: 0, lastActionAt: 0 }; stewardRunnerRuntime.selfServe.set(key, row); }
  return row;
}

// 收件箱事件 -> 处置意图。返回 null = 只进回合层(让模型说,不自动动手)。
//   failed  : run 类(事件带 runId 与 nodeId)-> retry_node;回合类 -> thread_continue「继续」
//   stalled : 只有【重启续跑类】(run_interrupted / run_resume_deferred)才自动 resume;
//             node_idle_aborted / node_no_progress_aborted / run_stalled 是「跑不动」而不是「被打断」,
//             盲目续跑只会再撞一次同一堵墙 -> 一律只进回合层。
function stewardSelfServePlan(evt) {
  const e = (evt && typeof evt === 'object') ? evt : {};
  const sessionId = safeSessionId(e.sessionId);
  if (!sessionId) return null;
  const runId = safeSessionId(e.runId);
  const payload = (e.payload && typeof e.payload === 'object') ? e.payload : {};
  if (e.kind === 'failed') {
    if (runId && payload.nodeId) {
      return { intent: 'retry', label: '重试', tool: 'steward_run_action', sessionId, runId,
        args: { sessionId, runId, action: 'retry_node', nodeId: String(payload.nodeId) } };
    }
    // 原话固定为「继续」(不由模型编);origin 标进决策日志的 basis,事后能分清哪一句是自理重试。
    return { intent: 'retry', label: '重试', tool: 'steward_thread_continue', sessionId, runId: '',
      args: { sessionId, message: '继续' }, origin: 'steward-retry' };
  }
  if (e.kind === 'stalled') {
    const type = String(payload.eventType || '');
    if (runId && (type === 'run_interrupted' || type === 'run_resume_deferred')) {
      return { intent: 'resume', label: '续跑', tool: 'steward_run_action', sessionId, runId,
        args: { sessionId, runId, action: 'resume' }, origin: 'steward-resume' };
    }
  }
  return null;
}

// 续跑的第六道闸:重启后这条班组敢不敢自动跑,由既有 classifyRunResumeTier 说了算(权限面不可
// 证明 / 有非纯读节点停在半路 -> manual_resume_required)。读不到快照一律按不安全处理。
// 116-3 P0-4:判定本体搬去 13g 的 stewardRunResumeTier(与 steward_run_action 工具内部共用同一份
// ——「唯一权威判据」要真的唯一);本文件的自理预闸只是调它,不再另写一份。13h -> 13g 是后向边。

async function stewardSelfServeGate(plan, config) {
  const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
  const key = stewardSelfServeKey(plan.sessionId, plan.runId);
  const entry = stewardSelfServeEntry(key);
  const now = Date.now();

  // ② 小时窗:自理动作与管家回合共用 stewardMaxTurnsPerHour(§11.3「自理动作计入同一窗口」)。
  const maxTurns = Math.max(0, Math.round(Number(config.stewardMaxTurnsPerHour) || 0));
  if (maxTurns > 0 && stewardTurnsInWindow(now, STEWARD_TURN_WINDOW_MS) >= maxTurns) {
    return { allowed: false, reason: `本小时管家的动作已经到上限(${maxTurns}),这件事只能提议` };
  }
  // ③ 无进展熔断:同一目标连着自理两次还在报问题,说明自动重试解决不了,交回给人。
  if (entry.attempts >= STEWARD_SELF_SERVE_ATTEMPT_MAX) {
    return { allowed: false, reason: `这条线程已经自动处置过 ${entry.attempts} 次仍未好转,不再自动动手,只提议` };
  }
  const mode = await stewardTargetPermission(plan.args, config);
  if (plan.intent === 'retry') {
    if (auto.retry !== true) return { allowed: false, reason: '「失败自动重试」没有勾选,只能提议' };
    // ④' 同一目标本小时只自动重试一次 —— 失败往往连着来,一小时内重复重试就是刷钱。
    if (entry.lastRetryAt && now - entry.lastRetryAt < STEWARD_SELF_SERVE_RETRY_WINDOW_MS) {
      return { allowed: false, reason: '这条线程本小时已经自动重试过一次了,再失败只提议' };
    }
    if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
      return { allowed: false, reason: `目标线程权限为「${stewardPermissionLabel(mode)}」,失败重试只能提议` };
    }
    return { allowed: true, mode };
  }
  if (plan.intent === 'resume') {
    const resume = auto.resume === null || auto.resume === undefined ? (config && config.autonomyAutoResume === true) : auto.resume === true;
    if (!resume) return { allowed: false, reason: '「重启后自动续跑」没有开,只能提议' };
    if (stewardMayAct(mode, 'failed', 'exec') !== 'auto') {
      return { allowed: false, reason: `目标线程权限为「${stewardPermissionLabel(mode)}」,自动续跑只能提议` };
    }
    const tier = await stewardRunResumeTier(plan.sessionId, plan.runId, config);
    if (tier !== 'auto_resumable') {
      return { allowed: false, reason: `这条班组重启后被判为「${tier || '未知'}」,自动续跑不安全,只能提议` };
    }
    return { allowed: true, mode };
  }
  return { allowed: false, reason: '这类事件没有确定性处置,交给你判断' };
}

// 一批收件箱事件 -> 自理结果行。每个目标最多处置一次(同一线程同一批里连报三条失败不该重试三遍)。
// 返回的行与模型 actions 的执行结果【同形】({tool,args,result}),额外带 auto:true 与 label ——
// 于是「propose_required 自动降级成一条按钮」这条既有路径原样复用,不必另写一套降级。
async function stewardSelfServeInbox(events, session, config) {
  const executed = [];
  const notes = [];
  const seen = new Set();
  for (const evt of (Array.isArray(events) ? events : [])) {
    if (executed.length >= STEWARD_SELF_SERVE_PER_TURN_MAX) break;
    const plan = stewardSelfServePlan(evt);
    if (!plan) continue;
    const key = stewardSelfServeKey(plan.sessionId, plan.runId);
    if (seen.has(key)) continue;
    seen.add(key);
    const inboxSeq = Number(evt && evt.inboxSeq) || 0;
    // 117l D5:自理 notes 也进模型的回合层,同样要带名字(三处口径一致:事件行、notes、总览行)。
    const planTitle = await stewardDisplayTitleOf(plan.sessionId);
    const planWho = planTitle ? `线程「${planTitle}」(${plan.sessionId})` : `线程 ${plan.sessionId}`;
    const gate = await stewardSelfServeGate(plan, config);
    const row = { tool: plan.tool, args: plan.args, auto: true, label: plan.label, intent: plan.intent, sessionId: plan.sessionId, inboxSeq };
    if (!gate.allowed) {
      row.result = stewardFail('propose_required', gate.reason, { reason: 'self_serve_gate', sessionId: plan.sessionId });
      executed.push(row);
      notes.push(`- [${inboxSeq}] ${planWho}:管家没有自动${plan.label}(${gate.reason}),已作为提议留给用户。`);
      continue;
    }
    const hookKey = STEWARD_ACTION_HOOKS[plan.tool];
    const entry = stewardSelfServeEntry(key);
    row.acted = true;   // 116-3 P2-11:闸门放行、真的发出去了 —— 这条目标要计进「每回合 ≤3 个目标」
    // 计账在【发起前】:动作发出去了就算用过一次配额,哪怕它失败 —— 否则失败会变成免费重试。
    stewardRunnerRuntime.turns.push(Date.now());
    entry.attempts += 1;
    entry.lastActionAt = Date.now();
    if (plan.intent === 'retry') entry.lastRetryAt = Date.now();
    try {
      row.result = await StewardHooks[hookKey]({
        ...plan.args,
        // 决策日志的 basis:哪条收件箱事件触发的、是不是自理、什么来源。13g 的两个实现把它并进
        // basis 落盘(args 本身照旧只记摘要字段,不落这一坨)。
        stewardBasis: { inboxSeq, auto: true, origin: plan.origin || ('steward-' + plan.intent) },
        // 116-3 P0-2:确定性自理【只】发生在收件箱回合(runStewardTurn 里 trigger==='inbox' 才调本函数),
        // 故 ctx.trigger 恒为 'inbox';同时置 selfServe:true —— 这一条已经过了上面 stewardSelfServeGate
        // 的七道闸(含按事件类别的 stewardMayAct(mode,'failed','exec')),13g 不该再按 'relay' 档判第二遍。
      }, { session, sessionId: session.id, config, trigger: 'inbox', selfServe: true });
    } catch (error) {
      row.result = stewardFail('steward.failed', String((error && error.message) || error));
    }
    const okDone = !!(row.result && row.result.ok);
    executed.push(row);
    notes.push(okDone
      ? `- [${inboxSeq}] ${planWho}:管家已经自动${plan.label}了(${plan.tool}),把这件事讲给用户听即可,不要再重复动手。`
      : `- [${inboxSeq}] ${planWho}:管家试了自动${plan.label}但没成(${stewardSanitizeText(row.result && (row.result.message || row.result.error))}),已作为提议留给用户。`);
    logEvent({ kind: 'steward_self_serve', intent: plan.intent, tool: plan.tool, sessionId: plan.sessionId, runId: plan.runId, ok: okDone, inboxSeq });
  }
  return { executed, notes };
}

// ── 117l D5(§11.9;用户第四轮走查第 4 条「管家回复的 ※ 没有正确标明标题」)────────────────────
// 界面上永远不出现内部 id(公共纪律第 7 条)。修前管家落盘的 why 原文长这样:
//   「收件箱事件 [1] needs_you:线程 sess_a50604717960006a 有待决 question_77ef30898760f07a,…」
// 模型是照抄的 —— 收件箱事件行本来就是 `线程 ${sid}` 喂给它的。两头一起改:
//   ① 喂进去的那一头(下面 stewardEventLine / 自理 notes / 总览行)改成「线程『显示名』(id)」;
//   ② 吐出来的那一头(say / why)过一遍确定性替换,把漏网的 id 换成显示名、把纯机器把手删掉。
// **只作用于给人看的两段文字**:acts[].sessionId、actions[].args、决策日志一律不动 —— 那些 id 是
// 前端点按钮用的,人话化会把它们变成点不开的字符串。
async function stewardDisplayTitleOf(sessionId) {
  const head = await stewardReadSessionHead(sessionId).catch(() => null);
  return head && head.id ? String(sessionDisplayTitle(head) || '') : '';
}
// say/why 的人话化。先把文本里出现过的会话 id 逐个查成显示名(最多 8 个,一次到访里模型不会提更多),
// 再交给 06i 的纯函数做替换与标点收尾。查不到名字的 id 原样保留 —— 宁可露一个 id,也不能张冠李戴。
async function stewardHumanizeSay(text) {
  const raw = String(text == null ? '' : text);
  const ids = [...new Set(raw.match(/\bsess_[0-9a-f]{16}\b/g) || [])].slice(0, 8);
  const titles = new Map();
  for (const id of ids) {
    const title = await stewardDisplayTitleOf(id);
    if (title) titles.set(id, title);
  }
  return stewardHumanizeIds(raw, id => titles.get(id) || '');
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
  // 117m-A1(用户第六轮走查⑦「这个熔断也不对吧」):小时窗是【自主回合】的节流器,不是用户的说话额度。
  // 与下面 no_progress 那一条同一句纪律:用户消息永远优先,任何时候都能把管家叫醒。修前这条判据不看
  // trigger —— 真机日志里 {"kind":"steward_circuit","circuit":"turns_per_hour","trigger":"user"} 出现两次
  // (02:31:33 / 02:33:25),正是用户那两句「还在正常运转吗」被机器回了「本小时已经跑了 12 个管家回合,
  // 先歇一会儿」;而那 12 个额度是被根因 1 的「代批风暴」在 15 分钟内吃光的。两条判据当时自相矛盾。
  // 挡下【收件箱】回合时那句话必须能落地 —— 带上去哪儿调,否则用户只知道被挡了不知道怎么办。
  const maxTurns = Math.max(0, Math.round(Number(config.stewardMaxTurnsPerHour) || 0));
  if (trigger !== 'user' && maxTurns > 0 && stewardTurnsInWindow(Date.now(), STEWARD_TURN_WINDOW_MS) >= maxTurns) {
    return { kind: 'turns_per_hour', detail: `本小时已经跑了 ${maxTurns} 个管家回合,先歇一会儿(你随时可以直接跟我说话,不受这条限制)。要让它自己多跑一些,去设置·管家页把「每小时最多回合数」调高。`, limit: maxTurns };
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
// 117l D5:事件行里带上【显示名】。id 仍然在(模型要拿它当 sessionId 调工具),但它现在有名字跟着 ——
// 于是模型转述时抄到的是名字,而不是一串十六进制(修前它照抄的就是 `线程 sess_a506…`)。
function stewardEventLine(row, titleOf) {
  const kind = stewardSanitizeText(row && row.kind);
  const sid = stewardSanitizeText(row && row.sessionId);
  const payload = (row && row.payload && typeof row.payload === 'object') ? row.payload : {};
  const summary = stewardSanitizeText(payload.summary || payload.text || payload.type || '');
  const count = Math.max(1, Number(row && row.count) || 1);
  const title = stewardSanitizeText((typeof titleOf === 'function' ? titleOf(sid) : '') || '');
  const who = title ? `线程「${title}」(${sid})` : `线程 ${sid}`;
  const line = `- [${Number(row && row.inboxSeq) || 0}] ${kind} · ${who}${count > 1 ? ` · 同类 ${count} 条` : ''} · ${summary}`;
  return line.slice(0, STEWARD_INBOX_EVENT_CHARS);
}

// 117s-H1:一条 done 行的交付引用块。13g 的 enrichInboxRows 已经把正文中和过(stewardSanitizeBlock)
// 并截到 4000 字,这里只负责把它摆成一个有头有尾、模型一眼能看出边界的块:
//   > 线程「X」第 N 回合的交付(全文 M 字,已截 4000):
//   <正文>
//   > 写过的文件:a, b
// 头尾两行都以 '> ' 起头 —— 正文里就算自己写了一行 '> …' 也只是块内的一行,块的边界由「头行必然紧跟
// 在那条事件行之后、尾行必然是『写过的文件』」这条固定结构给出,不靠正文自律。
// 文件那一行【永远】出现(没有就如实说「改动账里没有」),它同时是这个块的收尾标记。
function stewardDeliverableBlock(row, title) {
  const d = (row && row.payload && row.payload.deliverable && typeof row.payload.deliverable === 'object')
    ? row.payload.deliverable : null;
  const text = stewardSanitizeBlock(d && d.text).slice(0, STEWARD_INBOX_DELIVERABLE_CHARS);
  if (!text.trim()) return '';
  const seq = Math.max(0, Number(d.turnSeq) || 0);
  const chars = Math.max(0, Number(d.chars) || text.length);
  const who = title ? `线程「${stewardSanitizeText(title)}」` : `线程 ${stewardSanitizeText(row && row.sessionId)}`;
  const clipped = (d.truncated === true || chars > text.length) ? `,已截到 ${text.length}` : '';
  const files = (Array.isArray(d.files) ? d.files : []).map(f => stewardSanitizeText(f)).filter(Boolean);
  return [
    `> ${who}第 ${seq} 回合的交付原文(全文 ${chars} 字${clipped}):`,
    text,
    files.length ? `> 写过的文件:${files.join('、')}` : '> 写过的文件:(本回合的改动账里没有)',
  ].join('\n');
}

async function stewardInboxMessage(events, config, selfServeNotes) {
  const pack = getPromptPack(config && config.locale);
  const rows = events.slice(-STEWARD_INBOX_EVENTS_PER_TURN);
  // 117l D5:一批事件里最多几十条,去重后逐个查一次会话头(与 stewardThreadDigestRows 同一读法)。
  const titles = new Map();
  for (const sid of [...new Set(rows.map(r => safeSessionId(r && r.sessionId)).filter(Boolean))]) {
    titles.set(sid, await stewardDisplayTitleOf(sid));
  }
  // 116-2b:自理动作的结果作为事件的【补充信息】进回合层 —— 模型于是只需要「说」,不必再决定
  // 该不该重试(那件事工作台已经按规则做完或明确放弃了)。没有自理行时这一段整段不出现,
  // 收件箱回合的消息与 116f 逐字节相同。
  const notes = (Array.isArray(selfServeNotes) ? selfServeNotes : []).filter(Boolean).slice(0, STEWARD_SELF_SERVE_PER_TURN_MAX);
  const headlines = rows.map(row => stewardEventLine(row, sid => titles.get(sid) || ''));
  const bodies = rows.map(row => stewardDeliverableBlock(row, titles.get(safeSessionId(row && row.sessionId)) || ''));

  // 117s-H1 的预算:标题行【永不丢】(它是「发生了什么」的唯一载体),超预算时从【最旧】的那一条
  // 交付正文开始丢 —— 与 stewardEventLine 的整体口径一致:最近的最有用。丢掉几条要如实说,
  // 否则模型会以为它拿到的就是全部。
  const header = pack.steward.inboxHeader({ count: rows.length });
  const trailer = pack.steward.inboxTrailer;
  const noteLines = notes.length ? ['[管家已自理] 下面这些事工作台已经按你勾的「管家可以自己做的事」处置过了:', ...notes] : [];
  let used = [header, ...headlines, ...noteLines, trailer].reduce((n, s) => n + String(s).length + 1, 0);
  const keepBody = new Array(rows.length).fill(false);
  let dropped = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!bodies[i]) continue;
    const cost = bodies[i].length + 1;
    if (used + cost > STEWARD_INBOX_MESSAGE_CHARS) { dropped += 1; continue; }
    used += cost;
    keepBody[i] = true;
  }
  const lines = [header];
  for (let i = 0; i < rows.length; i++) {
    lines.push(headlines[i]);
    if (keepBody[i]) lines.push(bodies[i]);
  }
  if (dropped) lines.push(`> (另有 ${dropped} 条交付正文没装下这条消息的字数预算,需要时用 steward_thread_read 去读)`);
  if (noteLines.length) lines.push(...noteLines);
  lines.push(trailer);
  return lines.join('\n');
}

// 117s-H4(27 号文 §11.13.3;117s-C 的派单稿在这里被证伪):落盘的回执里 `trigger` 修前只有
// `'user'|'inbox'` 两个字面量,来源线程的 id / 标题 / 回合号一个都不在里面 —— 前端要给收件箱那条
// 回复加「来自线程」小头,只能拿正则去抠中文事件行(`线程「X」(sess_…)`)。回执才是第一手证据,
// 所以这里把它加厚成一个对象:{ kind, sessionId?, title?, turnSeq?, sessionIds? }。
//   · 领头行取这一批里第一条 done / needs_you(它们才是「有东西可看」的那两类);都没有就退到第一条;
//   · 一批里涉及几条线程时 sessionIds 全给,小头指的是领头那一条。
// 【只改落盘的那一份】:运行器内存态 stewardRunnerRuntime.lastReply.trigger 仍是字符串 ——
// 壳层的状态轮询(public/js/steward-shell.js:277 `lastReply.trigger === 'inbox'`)靠它决定要不要
// 把新回复追进对话流,改了它就是一个静默的功能回归。两处是两个消费者,不必也不该同形。
async function stewardTriggerStamp(trigger, events) {
  if (trigger !== 'inbox') return { kind: 'user' };
  const rows = (Array.isArray(events) ? events : []).filter(r => r && safeSessionId(r.sessionId));
  const sessionIds = [...new Set(rows.map(r => safeSessionId(r.sessionId)))];
  const lead = rows.find(r => r.kind === 'done' || r.kind === 'needs_you') || rows[0] || null;
  const stamp = { kind: 'inbox', sessionIds };
  if (!lead) return stamp;
  stamp.sessionId = safeSessionId(lead.sessionId);
  stamp.title = await stewardDisplayTitleOf(stamp.sessionId).catch(() => '') || '';
  stamp.turnSeq = Math.max(0, Number(lead.payload && lead.payload.turnSeq) || 0);
  return stamp;
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

// 117l D1(§11.9;用户第四轮走查第 2 条):输入区预判的服务端归一。
// **只信 sessionId**:标题一律自己按显示名重查,原因串按既有的中和口径清洗并截断,前端给的标题
// 一个字都不进提示词 —— 否则「输入框里打什么,提示词里就出现什么」,那是一条现成的注入入口。
// 最多 3 条(§11.9 派单稿),查不到会话的行整条丢掉(id 编的就当没给)。
const STEWARD_ROUTE_HINT_MAX = 3;
const STEWARD_ROUTE_HINT_REASON_CHARS = 80;
async function stewardNormalizeRouteHint(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  if (!src) return null;
  const hits = Array.isArray(src.hits) ? src.hits.slice(0, STEWARD_ROUTE_HINT_MAX) : [];
  const rows = [];
  const seen = new Set();
  for (const hit of hits) {
    const sid = safeSessionId(hit && hit.sessionId);
    if (!sid || seen.has(sid) || sid === STEWARD_SESSION_ID) continue;
    const title = await stewardDisplayTitleOf(sid);
    if (!title) continue;                       // 会话不存在 = 这一条当没给
    seen.add(sid);
    rows.push({ sessionId: sid, title, reason: stewardSanitizeText(hit && hit.reason).slice(0, STEWARD_ROUTE_HINT_REASON_CHARS) });
  }
  if (!rows.length) return null;
  const picked = safeSessionId(src.picked);
  return { kind: String(src.kind || '').slice(0, 24), rows, picked: seen.has(picked) ? picked : '' };
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

  // 117l D3(§11.9):本次回合的登记项在入口就造好(含一个占位 promise)—— 等待循环退出
  // 之后必须【同步】认领 stewardRunnerRuntime.inflight,中间不能有 await:两个等待者否则会在同一
  // 微任务里一起冲出去,各自开一个回合。占位 promise 在本函数真正返回时才 resolve —— 于是
  // 等在后面的那一句话不仅等到回合跑完,还等到 stewardStampReply 把结构化结果盖完章。
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const entry = { kind: trigger, controller, cancelled: '', events, promise: null, routeHint: await stewardNormalizeRouteHint(opts.routeHint) };
  let finishEntry = () => {};
  entry.promise = new Promise(resolve => { finishEntry = () => resolve(); });

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
    //
    // 117l D3(§11.9;用户第四轮走查第 6 条):修前这里是【一发】 Promise.race(15s),之后不复查
    // stewardRunnerRuntime.inflight —— 一个跑了 16 秒还在写正文的回合会被这条路径直接放行,于是
    // 第二句用户的话带着另一个回合同时开跑,两个回合抢同一份 session.messages(后写者赢),用户
    // 看到的就是「输出完了还说在忙上一件」和一条被吞掉的回复。
    // 修法:循环等到在途那个真的不在了(或换成了别的 entry —— 那说明本次要等的这个已经收尾,
    // 后面那个是新来的,由它自己那一层去等),总上限 5 分钟。真等过才记一条审计。
    const waitStartedAt = Date.now();
    while (stewardRunnerRuntime.inflight === inflight) {
      if (Date.now() - waitStartedAt >= STEWARD_USER_QUEUE_WAIT_MS) {
        logEvent({ kind: 'steward_user_turn_timeout', waitedMs: Date.now() - waitStartedAt, waitedFor: inflight.kind });
        return stewardFail('steward.busy', `上一件还没写完(已经等了 ${Math.round((Date.now() - waitStartedAt) / 1000)} 秒),先看看它是不是卡住了`, { trigger, waitedMs: Date.now() - waitStartedAt });
      }
      await Promise.race([
        inflight.promise.catch(() => {}),
        new Promise(resolve => { const t = setTimeout(resolve, 200); if (t && t.unref) t.unref(); }),
      ]);
    }
    const waitedMs = Date.now() - waitStartedAt;
    // 「真等过」才记账:抢占一个收件箱回合通常是毫秒级,那不该在审计里刷屏。
    if (waitedMs > 0) logEvent({ kind: 'steward_user_turn_queued', waitedMs, waitedFor: inflight.kind, trigger });
  }

  stewardRunnerRuntime.inflight = entry;   // 同步认领(与上面的 while 判定之间没有 await)
  try {
    return await stewardRunClaimedTurn(trigger, opts, config, entry, controller, onEvent, events);
  } finally {
    if (stewardRunnerRuntime.inflight === entry) stewardRunnerRuntime.inflight = null;
    finishEntry();
  }
}

// 117l D3:认领之后的回合本体。抽出来只为让「同步认领 -> try/finally 释放」这条纪律
// 一目了然:释放必须盖住【全部】退出路径 —— 含 stewardStampReply 之后那一段。修前它跑在
// inflight 已经清空之后,第二句用户的话于是能在正文还没盖章时插进来。
async function stewardRunClaimedTurn(trigger, opts, config, entry, controller, onEvent, events) {
  const ensured = await ensureStewardSession(config);
  if (!ensured.ok) {
    return stewardFail(ensured.error, ensured.message || 'steward engine is unsupported', { engine: ensured.engine });
  }
  const session = ensured.session;
  // 116-2b:自理动作【先于模型】跑。它是确定性处置(见 stewardSelfServeInbox 的头注),结果作为
  // 收件箱事件的补充信息进回合层 —— 模型只需要说,不必再决定。用户回合不走这里:用户就在跟前,
  // 他这一句话本身就是指令,轮不到管家替他主动做什么(§3.3「没在说话时才叫主动」)。
  const selfServe = trigger === 'inbox' && events.length
    ? await stewardSelfServeInbox(events, session, config)
    : { executed: [], notes: [] };
  const message = trigger === 'inbox' ? await stewardInboxMessage(events, config, selfServe.notes) : String(opts.message == null ? '' : opts.message);
  if (!message.trim()) return stewardFail('invalid_request', 'message is required');

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
  entry.run = run;
  const turn = await run;
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
    // 自理动作已经真的发生了,回合失败不能把它们吞掉 —— 如实带回去(界面与 /api/steward/state 都能看到)。
    return stewardFail('steward.turn_failed', detail || 'the steward turn did not complete', { trigger, stopped: !!turn.stopped, actions: selfServe.executed });
  }
  const finalText = await stewardLastAssistantContent();
  const parsedReply = stewardParseReply(finalText);
  // 自理动作排在模型 actions 【前面】:它们先发生,steward_reply.actions 的顺序就该是事情发生的
  // 顺序。两者同形,故 stewardDowngradeActions 一视同仁 —— 自理侧被闸门拦下的行(propose_required)
  // 与模型侧被 13g 拦下的行走同一条降级路径,变成一个按钮。
  // 116-3 P2-11:自理侧【真的动过】的目标带进 actions 侧,两边合起来数同一个 3 —— 不是各数各的。
  const selfServeTargets = selfServe.executed.filter(row => row && row.acted === true).map(row => row.sessionId);
  const executed = selfServe.executed.concat(parsedReply.actions.length
    ? await stewardExecuteActions(parsedReply.actions, session, config, trigger, selfServeTargets)
    : []);
  const acts = stewardDowngradeActions(executed, parsedReply.acts);
  // 117l D5:say/why 在【这里】过一遍人话化 —— 于是 steward_reply 帧、落盘的 meta、/api/steward/state
  // 的 lastReply 三处拿到的是【同一份】文字(修前 ※ 里满是 sess_/question_)。acts/actions 不动。
  const say = await stewardHumanizeSay(parsedReply.say);
  const why = await stewardHumanizeSay(parsedReply.why);
  const reply = {
    trigger,
    say,
    why,
    acts,
    actions: executed,
    parsed: parsedReply.parsed,
    turnSeq: Number(turn && turn.turnSeq) || 0,
    sessionId: session.id,
    circuit: null,
  };
  // 117s-H4:落盘的回执带来源(对象);reply.trigger(内存态 lastReply 与 steward_reply 帧)仍是字符串。
  await stewardStampReply({
    say: reply.say, why: reply.why, acts: reply.acts, actions: reply.actions, parsed: reply.parsed,
    trigger: await stewardTriggerStamp(trigger, events).catch(() => ({ kind: trigger })),
  });

  // 无进展熔断的计数:只看收件箱回合(用户回合永远清零 —— 用户说话就是进展)。
  if (trigger === 'inbox') {
    if (!acts.length && !executed.length) stewardRunnerRuntime.noProgress += 1;
    else stewardRunnerRuntime.noProgress = 0;
  } else {
    stewardRunnerRuntime.noProgress = 0;
    // 116-3 P1-10:用户回合收尾时顺带把积压的收件箱事件排上 —— 用户说话解除退避,却不带走队列里
    // 那些没人处理的事件,是修前那个「积压永久停滞」的另一半。
    stewardScheduleInboxDrain();
  }
  // 116-2e(§11.1 第 2 项「速查线程自动收工」):速查线程的 done 事件【已经进过这一回合】之后才
  // 收工 —— 顺序不能反。先收工的话总览与搜索里就没这条了,管家转述答案时会发现自己刚读到的那条
  // 线程凭空消失。收工只写会话头上的 stewardQuick.closedAt,不动正文、不进事项、不改执行语义。
  if (trigger === 'inbox' && typeof StewardHooks.quickClose === 'function') {
    for (const evt of events) {
      if (!evt || evt.kind !== 'done') continue;
      if (!(evt.payload && evt.payload.quick === true)) continue;
      try { await StewardHooks.quickClose(evt.sessionId); } catch { /* 旁路:收工失败不影响这一回合 */ }
    }
  }
  stewardRunnerRuntime.lastReply = { ...reply, at: nowIso() };
  return { ok: true, ...reply };
}

// ────────────────────────────────────────────────────────────────────────────
// 收件箱驱动:116b 每轮写完箱子调 onInboxBatch,这里做 5 秒去抖后起一个收件箱回合。
// ────────────────────────────────────────────────────────────────────────────
// 116-3 P1-10:排空是【自持】的。修前只有「轮询器又写了新的一批」才会排一次定时器,于是一次大批量
// 积压超过 30 条之后,只要活动很快安静下来,剩下的条目会一直躺在内存队列里没人处理(而且是纯内存态,
// 进程重启整份丢失);用户来跟管家说话也不会把它清掉。现在:一批处理完队列还有就接着排一个定时器;
// 用户回合结束时也顺带踢一次(用户说话本来就会解除无进展退避,顺手把积压带走)。
// 116-4:队列里有没有「有人正等着的那一句答案」。
function stewardQueueHasQuickAnswer(rows) {
  return (Array.isArray(rows) ? rows : []).some(r => r && r.kind === 'done' && r.payload && r.payload.quick === true);
}
function stewardScheduleInboxDrain() {
  if (stewardRunnerRuntime.stopped) return;
  if (!stewardRunnerRuntime.queue.length) return;
  // 116-4:去抖时长由【队列内容】决定,不由调用方决定 —— 五个调用点一行都不用改,新语义自动覆盖全部。
  const delay = stewardQueueHasQuickAnswer(stewardRunnerRuntime.queue) ? STEWARD_QUICK_DEBOUNCE_MS : STEWARD_DEBOUNCE_MS;
  if (stewardRunnerRuntime.debounceTimer) {
    // 已经排着的那个更快或一样快:不动。更慢:重排 —— 否则一条先到的普通通知会把速查答案一起按住 5 秒。
    if (delay >= stewardRunnerRuntime.debounceMs) return;
    clearTimeout(stewardRunnerRuntime.debounceTimer);
    stewardRunnerRuntime.debounceTimer = null;
  }
  stewardRunnerRuntime.debounceMs = delay;
  const timer = setTimeout(() => {
    stewardRunnerRuntime.debounceTimer = null;
    stewardRunnerRuntime.debounceMs = -1;
    if (stewardRunnerRuntime.stopped) return;
    const batch = stewardRunnerRuntime.queue.splice(0, STEWARD_INBOX_EVENTS_PER_TURN);
    if (!batch.length) return;
    void runStewardTurn({ trigger: 'inbox', events: batch }).then(
      // 熔断(停机 / 小时窗触顶 / 日费用触顶 / 无进展退避)时【不】自排下一轮:那一路会把这批事件
      // 原样退回队列,再排就是一个 5 秒一次的空转循环,而解除熔断的条件(用户说话)本来就会在
      // 用户回合收尾时踢一次排空。其余情况(含 steward.busy 与引擎不可用)照常接着排。
      result => { if (!(result && result.circuit)) stewardScheduleInboxDrain(); },
      () => { /* 抛错不自排:等下一批新事件或下一次用户回合 */ },
    );
  }, delay);
  if (timer && typeof timer.unref === 'function') timer.unref();
  stewardRunnerRuntime.debounceTimer = timer;
}
function stewardOnInboxBatch(rows) {
  if (stewardRunnerRuntime.stopped) return;
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return;
  stewardRunnerRuntime.queue.push(...list);
  stewardScheduleInboxDrain();
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

  // 116-3 P0-6(对抗审查):到访归档与在途管家回合会【并发】读-改-写同一份管家会话文件。
  // saveSession 的 sessionWriteChains 只序列化「落盘」这个动作本身,不合并两个调用方各自持有的
  // 内存快照 —— 谁的 save 排在后面,谁那份快照就整份覆盖文件。后果是回合刚写的回复在归档件与活
  // 会话里【双双消失】,或者已归档的旧消息被复活,两种都不报错。
  // 修法:归档前等在途回合收尾(上限与用户抢占同一个 STEWARD_PREEMPT_WAIT_MS);等不到就
  // steward.busy —— 不归档、不重置到访,下一次打开再来(到访是可重试的,数据不是)。
  if (newVisit) {
    const inflight = stewardRunnerRuntime.inflight;
    if (inflight && inflight.promise) {
      await Promise.race([
        inflight.promise.catch(() => {}),
        new Promise(resolve => { const t = setTimeout(resolve, STEWARD_PREEMPT_WAIT_MS); if (t && t.unref) t.unref(); }),
      ]);
    }
    if (stewardRunnerRuntime.inflight) {
      return stewardFail('steward.busy', '管家正在跑一个回合,归档要等它收尾才安全;稍后再打开一次', {
        inflight: String(stewardRunnerRuntime.inflight.kind || ''),
      });
    }
  }

  let archive = { archived: 0, file: '', kept: -1 };
  // 116-3 P2-14:归档写文件失败(磁盘满、visits 目录被占用……)此前被 .catch 吞成「归档成功的新到访」——
  // 时间戳照常重置,于是基于 stewardVisitIdleMinutes(默认 60 分钟)的下一次自动到访要再等一整个
  // 静默窗口才重试,期间没有任何错误呈现给用户。修法:失败就【不推进到访状态】(下一次调用仍视为
  // 「到访还没真正开始」,可以立刻重试),并把 archive.error 带进响应体供上层如实说人话。
  let visitOpened = newVisit;
  if (newVisit) {
    archive = await stewardArchiveConversation(config, previousStartedAt || nowIso())
      .catch(error => ({ archived: 0, file: '', kept: -1, error: String((error && error.message) || error).slice(0, 300) }));
    if (archive.error) {
      visitOpened = false;
      try { logEvent({ kind: 'steward_visit_archive_failed', error: archive.error }); } catch { /* 观测绝不反噬 */ }
    } else {
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
  }
  const digest = await stewardVisitDigest(sinceSeq);
  if (visitOpened) stewardRunnerRuntime.visit.inboxSeq = digest.inboxSeq;   // 下次到访从这里往后归纳
  const pending = await stewardPendingList();
  // 焦点线程:等你 > 在跑 > 失败(§8.10「现在这一件」的同一口径),没有线程时为空。
  const rows = await stewardThreadDigestRows(config).catch(() => []);
  const focusRow = rows.find(r => r.state === 'needs_you') || rows.find(r => r.state === 'running') || rows[0] || null;
  return {
    ok: true,
    // 116-3 P2-14:归档失败时如实说「这次到访没真正开始」—— 时间戳没推进,下一次调用会立刻再试一次。
    newVisit: visitOpened,
    since: previousStartedAt || '',
    visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
    archive,
    digest: { items: digest.items, counts: digest.counts },
    pending,
    // 116-5b:「现在这一件」的标题走显示名(缺摘要时仍回落到原话,与旧行为逐字相同)。
    focus: focusRow ? { sessionId: focusRow.sessionId, title: focusRow.displayTitle || focusRow.digest.title, state: focusRow.state } : null,
  };
}

// 117l D7(§11.9;用户走查第 7 条「一个针对复杂任务的强模型、一个简单任务的快速模型」):
// 把 06i 判出来的那一档落到刚建好的会话头上。判定在 06i(纯函数),这里只做两件够得着的事 ——
// 用 02 的归一器把它构造成 engineRoute,以及在「配了但端点已经被删」时记一条审计。
//   · 那一档没配 → 不写 session.engineRoute = createSession 的既有缺省(跟随全局),存量零变化;
//   · 端点已删 → 同样回落全局,但必须留下审计:否则用户会看到「我明明配了强模型」而无从解释
//     (不报错、不拒绝开线程是故意的 —— 模型配错不该把事儿卡死)。
function stewardApplyThreadTier(session, tier, config) {
  const decided = stewardThreadEngineRoute(tier, config);
  const route = decided.found
    ? normalizeSessionEngineRoute({ engine: 'openai', providerId: decided.providerId, model: decided.model })
    : null;
  if (route) session.engineRoute = route;
  else if (decided.fallback) logEvent({ kind: 'steward_thread_model_fallback', tier: decided.tier, providerId: decided.providerId, sessionId: session.id });
  return {
    tier: decided.tier,
    engine: route ? { providerId: route.providerId, model: route.model } : { providerId: '', model: '' },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 第 117 波 117l D2(27 号文 §11.9;用户第四轮走查第 1、6 条):递话按【目标状态】选通道。
//
// 修前只有一道判据:`activeChildren.has(sessionId)` → `steward.busy`,否则起一个新回合。两头都错:
//   · 线程正挂在 request_user_input 上等用户回答时,它在 activeChildren 里 —— 于是用户那句
//     「走 A」被当成「线程忙」原地退回,界面还说成「我正忙着上一件」(管家忙),而真相是线程在等他;
//   · 一旦那条判据没命中(回合刚收尾/竞态),`stewardLaunchTurn` → `runSessionTurn` 的
//     `if (activeChildren.has) stopSession('superseded')`(09:1343,2.0 主输入框的既有语义)会把
//     那个等回答的回合就地杀掉,`request_user_input` 变成 status:'failed',用户还没答的问题凭空消失。
//
// 单点判定 + 单点执行:13g 的 steward_thread_continue 与 POST /api/steward/relay 都走这里,
// 抽屉「直接对这条线程说」不必再自己在 /api/steer 与 /api/chat/stream 之间猜。判定顺序固定:
//   answer(在等回答)> permission(在等批准)> queued(在仲裁器队列里排着)> steer(在跑)> turn(空闲)。
// 每一条都复用【既有】核心,不新造第二条通路:answer 走 decideIntervention(与 /api/chat/answer
// 同一条),steer 走 steerSessionCore(与 /api/steer 同一条),turn 走 stewardLaunchTurn。
// ════════════════════════════════════════════════════════════════════════════
// 117l-A1-fix (1):第五种目标状态 'queued'(在仲裁器队列里等着开跑)。它排在 steer 之前 ——
// 见 stewardRelayChannelFor 里那段头注。
const STEWARD_RELAY_CHANNELS = Object.freeze(['answer', 'permission', 'queued', 'steer', 'turn']);

// 判定单点。只读内存注册表(04 的三张待决表)与活回合表,零写入、零文件读 —— 判定必须便宜,
// 它在每一次递话前都要跑一遍。用【内存】表而不是待决旁路账:旁路账里可能留着一条回合已经死掉的
// 陈旧 pending(那种待决没人能再答),拿它挡住递话等于把线程锁死;内存表里有 = 此刻真的有人在等。
function stewardRelayChannelFor(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return { channel: 'turn' };
  for (const [qid, entry] of pendingQuestions) {
    if (!entry || entry.sessionId !== sid || entry.commandApplying) continue;
    return { channel: 'answer', questionId: String(qid), questions: Array.isArray(entry.questions) ? entry.questions : [] };
  }
  for (const [rid, entry] of pendingPermissions) {
    if (!entry || entry.sessionId !== sid || entry.commandApplying) continue;
    return { channel: 'permission', pendingId: String(rid), pendingType: 'permission' };
  }
  // 117l-A1-fix (1)(§11.9;主会话在真夹具上复核 A1 时撞出来的边界,是真丢数据):线程【已经排在
  // 仲裁器队列里、还没开跑】也是一种目标状态,而且它落在下面两道判据的缝里 —— 它不在 activeChildren
  // 里(09 的 activeChildren.set 在回合本体里,回合本体要等 10 拿到并发位之后才开始跑),也没有任何
  // 待决(有待决的回合根本不入队,见 stewardArbiterHasPending)。修前因此判成 turn -> stewardLaunchTurn
  // 又排一个回合;锁一放两个回合前后脚被放行,后一个在 09 的
  // `if (activeChildren.has) stopSession('superseded')` 里把前一个就地杀掉 —— 排队中那句话连同它的
  // 回合一起没了(实测 turn_start x2 / turn_kill superseded / 正文只剩第二句)。这正是 §11.9 D2 要
  // 杜绝的那种 supersede,只是换了个入口,所以判据加在这里、与另外四条同一处。
  // 判据用 13h 既有的同步只读单点 stewardArbiterWait:非 null 就是「此刻真的排在队里」。
  // 入队到 drain 首次判定之间有一个极短的窗口(条目已在队列、但马上会被放行),那一刻的递话也会被
  // 判成 queued —— 保守方向:让用户再说一遍,远好过丢掉一整个回合。
  const queuedWait = stewardArbiterWait(sid);
  if (queuedWait) return { channel: 'queued', wait: waitReasonFor({ pending: 0 }, queuedWait) };
  if (activeChildren.has(sid)) return { channel: 'steer' };
  return { channel: 'turn' };
}

// 执行单点。返回值就是工具/路由的稳定信封({ok:true,channel,…} 或 stewardFail(...))。
// launch 由调用方传进来(13g 的 stewardLaunchTurn 带着它自己的决策日志锚点与 requestMeta),
// 本函数不替它决定「新回合该带什么」—— 那是 13g 的既有语义,一个字都不动。
async function stewardRelayDeliver(input) {
  const o = (input && typeof input === 'object') ? input : {};
  const sid = safeSessionId(o.sessionId);
  const message = String(o.message == null ? '' : o.message);
  const title = String(o.title || '');
  if (!sid) return stewardFail('not_found', 'invalid sessionId');
  if (!message.trim()) return stewardFail('invalid_request', 'message is required');
  const decided = stewardRelayChannelFor(sid);

  if (decided.channel === 'answer') {
    // 用户这句话【就是】那道提问的答案。走与 /api/chat/answer 逐字相同的核心(13d 的 decideIntervention
    // 命令核心 + 04 的 normalizeQuestionAnswer),于是 CAS 行、审计、回合唤醒三样一个不少。
    const normalizedAnswer = normalizeQuestionAnswer({ content: message, answers: [] }, decided.questions);
    const result = await decideIntervention({
      missionId: sid,
      interventionId: decided.questionId,
      payload: { action: 'answer', normalizedAnswer },
      source: 'steward_relay',
      contractRequest: false,
    });
    if (!result || result.status !== 200) {
      return stewardFail('relay_failed', '这句话没能递成那道提问的答案(它可能刚刚超时或被别处答掉了)', {
        channel: 'answer', sessionId: sid, questionId: decided.questionId,
      });
    }
    logEvent({ kind: 'steward_relay', channel: 'answer', sessionId: sid, questionId: decided.questionId, source: String(o.source || 'steward_thread_continue') });
    return { ok: true, channel: 'answer', sessionId: sid, questionId: decided.questionId, undoRef: { kind: 'answer', sessionId: sid, questionId: decided.questionId } };
  }

  if (decided.channel === 'permission') {
    // 不代答。放行一个动作与回答一句话是两件事:前者要用户看着命令原文点头(§3.3 永久豁免的同一条精神)。
    return stewardFail('propose_required', '它在等你批准一个动作,先去批了再递话', {
      reason: 'pending_permission', channel: 'permission', sessionId: sid, pendingId: decided.pendingId,
    });
  }

  if (decided.channel === 'queued') {
    // 117l-A1-fix (1):不启动回合。也【不】把这句话挂到排队项上 —— 那要改仲裁器的队列形状
    // (entry 现在只有 sessionId/cwdKey/等待原因,没有「待递的话」这个概念),超出本轮;
    // 而在两者之间,诚实地退回来让用户再说一遍是唯一不丢数据的选择。
    // 人话里带上等待原因(与 steward_thread_status / 看板 / GET /api/missions 逐字同源的那个 label),
    // 用户才知道自己在等什么、什么时候该再说一次。
    const label = String((decided.wait && decided.wait.label) || '还没轮到它开跑');
    return stewardFail('steward.queued', `线程「${stewardSanitizeText(title) || sid}」还在排队(${label}),这句先没递进去;等它开跑后再说一次`, {
      channel: 'queued', sessionId: sid, wait: decided.wait || null,
    });
  }

  if (decided.channel === 'steer') {
    const outcome = await steerSessionCore({ sessionId: sid, text: message });
    const body = (outcome && outcome.kind === 'json') ? outcome.body : null;
    if (body && body.ok === true) {
      logEvent({ kind: 'steward_relay', channel: 'steer', sessionId: sid, source: String(o.source || 'steward_thread_continue') });
      return { ok: true, channel: 'steer', sessionId: sid, queued: Number(body.queued) || 0, injected: body.injected === true };
    }
    // 插不进去(Claude legacy/print、队列满、引擎不支持)。这时候才是「忙」—— 而且要说清是【线程】忙。
    const why = String((body && body.error) || (outcome && outcome.message) || '这一步不能插话');
    return stewardFail('steward.busy', `线程「${title || sid}」正忙且这一步不能插话:${stewardSanitizeText(why)}`, {
      channel: 'steer', sessionId: sid, reason: 'steer_ineligible',
    });
  }

  const launch = typeof o.launch === 'function' ? o.launch : null;
  if (!launch) return stewardFail('invalid_request', 'relay turn channel needs a launcher');
  const launched = await launch();
  if (launched && launched.ok === false) return launched;
  logEvent({ kind: 'steward_relay', channel: 'turn', sessionId: sid, source: String(o.source || 'steward_thread_continue') });
  return { ok: true, channel: 'turn', sessionId: sid, ...(launched && typeof launched === 'object' ? launched : {}) };
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
  // 116-2e:`userPressed` 的【唯一】来源就是这一行 —— 用户在界面上亲手按下了这个按钮。
  // 只有 steward_config_set 与 steward_skill_toggle 的「须确认」判定读它;stewardMayAct、
  // 永久豁免清单与线程权限判定一概不读(06i 契约注释与 steward-tools.static ⑦ 机械看住)。
  // 116-3 P0-2:trigger:'user' —— 用户就站在这个按钮前面,线程族的「无人值守」闸门不适用。
  // 它与 userPressed 是两件不同的事:trigger 说的是「用户在不在场」,userPressed 说的是
  // 「这一次配置改动是不是用户亲手按的」,后者的读者只有 config_set / skill_toggle 两处(06i 契约)。
  const result = await StewardHooks[hookKey](args, { session: ensured.session, sessionId: ensured.session.id, config, trigger: 'user', userPressed: true });
  // 按钮【被执行了】就是 ok:true —— 工具自己的稳定信封(propose_required / not_found / version_conflict …)
  // 原样放在 result 里交给界面去说人话。只有 act 本身不合法(未知 kind、非管家工具、开关关)才是 4xx:
  // 把「工具说不行」翻译成 HTTP 错误会让前端分不清「按钮坏了」和「这件事不该这么做」。
  return { ok: true, kind: 'tool', tool, executed: !!(result && result.ok !== false), result };
}

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

// ── steward_thread_prioritize(116h,§8.10「每行可提升优先级＝插队占下一个并发位」)──────────────
// 落在 13h 而不是 13g:实现要直接调本文件的仲裁器原语,而 13g 在拼接顺序上更早(引用本文件 = 前向边);
// 13g 也已顶到 SPEC §2 的 2000 行目标,再往里塞就要为它另起一次拆分。门控壳仍用 13g 的
// stewardToolHandler(13h -> 13g 是后向边),开关/身份两道 fail-closed 与其余 20 个工具逐字一致。
//
// 语义刻意做窄:只把【还在排队】的那一条提到队首,下一个释放出来的并发位归它。不预留、不抢占 ——
// 已经在跑的回合不会因为别人插队被打断(那会把一条线程做到一半的活扔掉,代价远大于早跑几秒的收益)。
// 目标不在队列里(在跑 / 已收工 / 根本没开回合)不是错误:返回 prioritized:false + reason,
// 让模型如实告诉用户「它没在排队,不用插」,而不是重试或编一个成功。
async function stewardImplThreadPrioritize(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session is not a thread');
  const result = stewardArbiterPrioritize(sessionId);
  if (!result || result.ok !== true) {
    return stewardFail(String((result && result.error) || 'steward.failed'), String((result && result.message) || 'prioritize failed'), { sessionId });
  }
  if (result.prioritized !== true) {
    return { ok: true, sessionId, prioritized: false, reason: String(result.reason || 'not_queued'), wait: null };
  }
  stewardAppendDecision({
    tool: 'steward_thread_prioritize',
    args: { sessionId },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef: { kind: 'prioritize', sessionId },
    basis: {},
  });
  return { ok: true, sessionId, prioritized: true, wait: waitReasonFor({ pending: 0 }, stewardArbiterWait(sessionId)) };
}

// ── steward_thread_stop(117m-A4,27 号文 §11.10 用户第六轮走查第 ③ 条「暂停这个线程,会显示 invalid」)──
// 根因:管家手里【只有】班组级的 steward_run_action(13g 的 stewardImplRunAction 头一行就要 sessionId
// 与 runId)。普通线程回合根本没有班组,模型想「暂停这条线程」只能拿它凑 -> 必然 invalid_request ->
// 前端 errGeneric 把机器码原样贴出来,就是用户看到的那个「invalid」。抽屉底部那枚「停止」按钮走的是
// POST /api/stop,管家一直没有对应的原语。这里补的就是那条路,不是第二条停机路径:
//   ① stopSession(既有停止原语:拿 activeChildren 里的 abort 句柄直接掐,并清掉该会话的三张待决表);
//   ② stewardCancelQueuedTurn(116h 仲裁器:stopSession 只认活回合,【还在排队】的回合它看不见);
//   ③ revokeAllGrants(第 27 波:显式停止 = 夺回控制,该会话的授权书连 scope:'session' 一并撤)。
// 三件都是既有核心,本函数一行停机逻辑都不自己写。
//
// 落在 13h 而不是 13g:与 stewardImplThreadPrioritize 同一条理由 —— 它要直接调本文件的仲裁器原语,
// 而 13g 已经顶到 SPEC §2 的 2000 行目标。门控壳仍用 13g 的 stewardToolHandler(13h -> 13g 是后向边),
// 开关/身份两道 fail-closed 与其余工具逐字一致。
//
// 权限:停止是【收紧类】—— 与 STEWARD_RUN_TIGHTENING 同款,任何权限档都 mayAct='auto'(连「每步都问」
// 的线程也允许管家替你按停,因为它只会让事情【少】发生)。只放开了收紧:同一条线程的 thread_continue /
// decide / run_action{resume} 仍各自过自己的权限门,一条都没松。
//
// 没在跑时不许回 invalid:那不是「请求非法」,是「不用停」。信封 not_running + 一句人话,模型照直说给
// 用户听就行(schema 的 description 里写明了拿到它不要重试)。也不许有副作用 —— 所以先看 activeChildren
// 再决定要不要调 stopSession:stopSession 即使拿不到条目也会清一遍三张待决表,那是【停一个真在跑的
// 回合】的收尾语义,不该发生在一个 not_running 的信封上;revokeAllGrants 同理,只在真停下了什么之后才撤。
const STEWARD_STOP_REASON_MAX = 200;
async function stewardImplThreadStop(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('invalid_request', 'sessionId is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot stop its own turn');
  const reason = stewardSanitizeText(args.reason).trim().slice(0, STEWARD_STOP_REASON_MAX);

  const stopped = activeChildren.has(sessionId) ? stopSession(sessionId, 'steward-stop') === true : false;
  let queuedStopped = false;
  try { queuedStopped = stewardCancelQueuedTurn(sessionId) === true; } catch { queuedStopped = false; }
  if (!stopped && !queuedStopped) return stewardFail('not_running', '这条线程现在没有在跑,不用停', { sessionId });
  try { revokeAllGrants(sessionId, 'steward-stop'); } catch { /* best-effort,与 /api/stop 同款 */ }

  // 停下的回合【不能】原样续上(它的半截输出已经落进会话正文;要撤销那一整回合是 rewind,另一件事)。
  // undoRef 诚实标 none,并把用户真正该走的那条路写进 note。
  const undoRef = { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' };
  stewardAppendDecision({
    tool: 'steward_thread_stop',
    args: { stopped, queuedStopped, ...(reason ? { reason } : {}) },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef,
    basis: stewardBasisOf(args, {}),
  });
  return { ok: true, sessionId, stopped, queuedStopped, undoRef };
}

// ────────────────────────────────────────────────────────────────────────────
// 路由(token 级,ROUTE_AUTH 在 01b 登记)。经 13g 的 handleStewardApiRoutes 末尾转交(见那里的注释)。
// ────────────────────────────────────────────────────────────────────────────
async function handleStewardRunnerApiRoutes(req, res, pathname) {
  // 116h(27 号文 §3.1 116h 行 / §8.10 多线程看板):线程间仲裁的只读状态与插队。
  // 状态是纯内存读模型(running/queue/hour/day),不写盘;prioritize 只动队列顺序,不打断在跑的回合。
  if (req.method === 'GET' && pathname === '/api/steward/arbiter') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    return send(res, json({ ok: true, ...await stewardArbiterState(config) }));
  }

  if (req.method === 'POST' && pathname === '/api/steward/arbiter/prioritize') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const body = await readJsonBody(req).catch(() => ({}));
    // 116-3 P1-13:改调 steward_thread_prioritize 的实现,不再直接碰仲裁器裸原语。
    // 修前这条路由(= 看板每行的「提升优先级」按钮)绕开了工具路径的两样东西:目标存在性/非管家会话
    // 校验,以及 decisions-v1.ndjson 的审计落盘 —— 于是【每一次经看板做的插队在行动流水里都没有记录】,
    // 与 §3.4 红线「全部行动经命令核心与审计」相悖;编造的 sessionId 也只是静默 not_queued。
    // 非法 sessionId 的稳定码仍由路由层给(invalid_session):它是「请求本身不合法」,不是「目标没找到」。
    if (!safeSessionId(body && body.sessionId)) {
      return send(res, apiFailure('invalid_session', {}, 'invalid sessionId', 400));
    }
    const result = await stewardImplThreadPrioritize({ sessionId: body.sessionId }, { config }, config);
    // 116g 硬教训:域层的 {ok:false,error} 直接送进 json() 会被 normalizeApiErrorPayload 归一成
    // api.request_failed,稳定信封必须在【路由层】转成 apiFailure。
    if (result && result.ok === false) return send(res, apiFailure(result.error, {}, result.message || result.error, 400));
    return send(res, json(result));
  }

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

  // 117l D2(§11.9):递话通道的 HTTP 面。抽屉「直接对这条线程说」与问答卡的自由回答都走它,
  // 不再自己在 /api/steer 与 /api/chat/stream 之间猜 —— “猜错了就把一个等回答的回合杀掉”正是用户第四轮
  // 走查第 1/6 条的根因。实现就是工具面那一个(同一条门控、同一本决策日志、同一个 undoRef),
  // trigger:'user' —— 用户就坐在抽屉前面敲这句话,无人值守的那两道闸不适用(与 /api/steward/act 同理)。
  // 不置 userPressed:那个字段只给 config_set / skill_toggle 的「须确认」判定用(06i 契约)。
  if (req.method === 'POST' && pathname === '/api/steward/relay') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const body = await readJsonBody(req).catch(() => ({}));
    if (!safeSessionId(body && body.sessionId)) {
      return send(res, apiFailure('invalid_session', {}, 'invalid sessionId', 400));
    }
    const ensured = await ensureStewardSession(config);
    if (!ensured.ok) return send(res, apiFailure(ensured.error, {}, ensured.message || 'steward engine is unsupported', 409));
    const result = await StewardHooks.threadContinue(
      { sessionId: body.sessionId, message: body.message },
      { session: ensured.session, sessionId: ensured.session.id, config, trigger: 'user' },
    );
    // 116g 硬教训(同 /api/steward/arbiter/prioritize):域层的 {ok:false,error} 直接送进 json() 会被
    // normalizeApiErrorPayload 归一成 api.request_failed,稳定信封必须在【路由层】转成 apiFailure。
    if (result && result.ok === false) {
      const code = String(result.error || 'relay_failed');
      const status = (code === 'not_found' || code === 'invalid_request' || code === 'invalid_target') ? 400 : 409;
      return send(res, apiFailure(code, {
        ...(result.channel ? { channel: result.channel } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        // 117l-A1-fix (1):queued 的等待原因也带上(与工具面同一份结构化 wait)—— 抽屉据此能显示
        // 「它在等锁 / 等预算 / 等并发位」,而不必去解析上面那句人话。别的通道没有这个键。
        ...(result.wait ? { wait: result.wait } : {}),
      }, result.message || code, status));
    }
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
      // 117l D1:routeHint 随请求进来,但它只是【提示】—— 服务端只信 sessionId(见 stewardNormalizeRouteHint)。
      const result = await runStewardTurn({ trigger: 'user', message, routeHint: body && body.routeHint, onEvent: writeEvent });
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
    // 116h:线程仲裁器的快照并进同一条状态路由 —— 看板顶部的「同时最多 N 条」与每行的等待原因
    // 读的是同一份事实,不必再多请求一次(独立的 GET /api/steward/arbiter 仍在,供只关心仲裁的调用方)。
    arbiter: await stewardArbiterState(config).catch(() => null),
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
  // 116h(§3.1/§8.10)线程间仲裁。消费者:10 的回合入口(acquireTurnSlot)、13 的 /api/stop
  // (cancelQueuedTurn)、13d 的事项聚合行与 13g 的 thread_status(arbiterWait)、13 的 POST /api/config
  // (arbiterRefresh)。一律经 06i,零前向边。
  // stewardArbiterPrioritize 与 stewardArbiterState 【不】进命名空间:它们的消费者全在本文件内
  // (两条 /api/steward/arbiter* 路由、steward_thread_prioritize 实现、并进 state 的 stewardRunnerState),
  // 挂上去就是没人用的钩子(= 死代码)。
  acquireTurnSlot: stewardAcquireTurnSlot,
  arbiterWait: stewardArbiterWait,
  cancelQueuedTurn: stewardCancelQueuedTurn,
  arbiterRefresh: stewardArbiterRefresh,
  // 116h 的第 21 个管家工具:实现住本文件(要直接调仲裁器原语),门控壳仍是 13g 的 stewardToolHandler。
  threadPrioritize: stewardToolHandler('steward_thread_prioritize', stewardImplThreadPrioritize),
  // 117m-A4 的第 27 个管家工具:线程级停止。住本文件的理由与 threadPrioritize 同款(要直接调仲裁器
  // 原语,且 13g 已顶到 2000 行闸);门控壳仍是 13g 的 stewardToolHandler。
  threadStop: stewardToolHandler('steward_thread_stop', stewardImplThreadStop),
  // 117l D2(§11.9):递话通道的判定与执行。实现住本文件的理由与 threadPrioritize 同款 ——
  // 它要同时够到 04 的三张待决内存表、13b 的 steerSessionCore、13d 的 decideIntervention 与
  // 09 的 activeChildren,而 13g 在 13b/13d 之后、13h 之前,由 13h 来当这个汇合点边最少。
  // 消费者:13g 的 steward_thread_continue(经 StewardHooks,零前向边)与本文件的 /api/steward/relay。
  // 117s-G(27 号文 §11.13.1 ②):stewardRelayChannelFor 现在【也】上命名空间 —— 它有了第一个
  // 13h 之外的消费者:13d 的 GET /api/sessions/:id 要把「这条线程此刻该走哪条通道」下发给经典壳
  // (前端此前只认 activeTurns = 本页自己起的流,别处起的回合一律判成空闲,一发消息就把它顶掉)。
  // 判定仍然只有这一份:13d 不重编第二条阶梯,只把结果投影成 relay:{channel,wait}。挂法与 arbiterWait
  // 同款(13d -> 06i 是后向边,零新增前向边)。上一版那条「消费者全在 13h 内部,挂上去就是死代码」的
  // 理由随第一个外部消费者出现而失效 —— 纪律没变,变的是事实。
  relayChannel: stewardRelayChannelFor,
  relayDeliver: stewardRelayDeliver,
  // 117l D7:同理住 13h —— 它要 02 的 normalizeSessionEngineRoute 与 04 的 logEvent,06i 够不着那两个。
  applyThreadTier: stewardApplyThreadTier,
});
