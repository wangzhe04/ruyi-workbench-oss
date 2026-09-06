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
    // 116h(§8.10「排队可解释」):总览行的等待原因也走 06i 的 waitReasonFor 单点 —— 管家在提示词里
    // 读到的那句话,与 steward_thread_status / 看板 / steward_missions 逐字相同。
    const wait = waitReasonFor({ pending: pendingCount }, stewardArbiterWait(sid));
    rows.push({
      sessionId: sid,
      // 116-pre(§8.12/§11.3):递话预判的 index 行要 missionId——3.0 里等于 sessionId(见下方注释),
      // 加在这里而不是 digest 里,因为 buildStewardDigestLine 的 lead 段只吃 id/missionTitle/title 三键,
      // 多一个 missionId 键对总览行的拼装零影响(新增只加不改)。
      missionId: sessionMissionId(head) || sid,
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
      // 116-3 P0-2:trigger 进 ctx —— 13g 的线程族三工具据它区分「用户就在跟前」(直递)与
      // 「无人值守的收件箱回合」(要过自理清单 + 目标线程权限两道闸)。本文件不复制那套判据。
      result = await StewardHooks[hookKey](args, { session, sessionId: session.id, config, trigger });
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
    const gate = await stewardSelfServeGate(plan, config);
    const row = { tool: plan.tool, args: plan.args, auto: true, label: plan.label, intent: plan.intent, sessionId: plan.sessionId, inboxSeq };
    if (!gate.allowed) {
      row.result = stewardFail('propose_required', gate.reason, { reason: 'self_serve_gate', sessionId: plan.sessionId });
      executed.push(row);
      notes.push(`- [${inboxSeq}] 线程 ${plan.sessionId}:管家没有自动${plan.label}(${gate.reason}),已作为提议留给用户。`);
      continue;
    }
    const hookKey = STEWARD_ACTION_HOOKS[plan.tool];
    const entry = stewardSelfServeEntry(key);
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
      ? `- [${inboxSeq}] 线程 ${plan.sessionId}:管家已经自动${plan.label}了(${plan.tool}),把这件事讲给用户听即可,不要再重复动手。`
      : `- [${inboxSeq}] 线程 ${plan.sessionId}:管家试了自动${plan.label}但没成(${stewardSanitizeText(row.result && (row.result.message || row.result.error))}),已作为提议留给用户。`);
    logEvent({ kind: 'steward_self_serve', intent: plan.intent, tool: plan.tool, sessionId: plan.sessionId, runId: plan.runId, ok: okDone, inboxSeq });
  }
  return { executed, notes };
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

function stewardInboxMessage(events, config, selfServeNotes) {
  const pack = getPromptPack(config && config.locale);
  const rows = events.slice(-STEWARD_INBOX_EVENTS_PER_TURN);
  // 116-2b:自理动作的结果作为事件的【补充信息】进回合层 —— 模型于是只需要「说」,不必再决定
  // 该不该重试(那件事工作台已经按规则做完或明确放弃了)。没有自理行时这一段整段不出现,
  // 收件箱回合的消息与 116f 逐字节相同。
  const notes = (Array.isArray(selfServeNotes) ? selfServeNotes : []).filter(Boolean).slice(0, STEWARD_SELF_SERVE_PER_TURN_MAX);
  const lines = [pack.steward.inboxHeader({ count: rows.length }), ...rows.map(stewardEventLine)];
  if (notes.length) lines.push('[管家已自理] 下面这些事工作台已经按你勾的「管家可以自己做的事」处置过了:', ...notes);
  lines.push(pack.steward.inboxTrailer);
  return lines.join('\n');
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
  // 116-2b:自理动作【先于模型】跑。它是确定性处置(见 stewardSelfServeInbox 的头注),结果作为
  // 收件箱事件的补充信息进回合层 —— 模型只需要说,不必再决定。用户回合不走这里:用户就在跟前,
  // 他这一句话本身就是指令,轮不到管家替他主动做什么(§3.3「没在说话时才叫主动」)。
  const selfServe = trigger === 'inbox' && events.length
    ? await stewardSelfServeInbox(events, session, config)
    : { executed: [], notes: [] };
  const message = trigger === 'inbox' ? stewardInboxMessage(events, config, selfServe.notes) : String(opts.message == null ? '' : opts.message);
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
    // 自理动作已经真的发生了,回合失败不能把它们吞掉 —— 如实带回去(界面与 /api/steward/state 都能看到)。
    return stewardFail('steward.turn_failed', detail || 'the steward turn did not complete', { trigger, stopped: !!turn.stopped, actions: selfServe.executed });
  }
  const finalText = await stewardLastAssistantContent();
  const parsedReply = stewardParseReply(finalText);
  // 自理动作排在模型 actions 【前面】:它们先发生,steward_reply.actions 的顺序就该是事情发生的
  // 顺序。两者同形,故 stewardDowngradeActions 一视同仁 —— 自理侧被闸门拦下的行(propose_required)
  // 与模型侧被 13g 拦下的行走同一条降级路径,变成一个按钮。
  const executed = selfServe.executed.concat(parsedReply.actions.length
    ? await stewardExecuteActions(parsedReply.actions, session, config, trigger)
    : []);
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
async function stewardArbiterBlocked(entry, config) {
  // ② 同一个工作文件夹的写互斥。**本切片一律按「写」处理**:一个回合会不会写文件在开始时无法预知
  // (模型还没说话),按只读乐观放行的代价是两条线程真的一起改同一棵树。只读回合的识别与放宽留后续波。
  for (const run of stewardArbiter.running.values()) {
    if (run.sessionId === entry.sessionId) continue;   // 同一条线程的两个回合由既有 supersede 语义管
    if (run.cwdKey !== entry.cwdKey) continue;
    return { lock: { sessionId: run.sessionId, title: run.title, cwdKey: run.cwdKey } };
  }
  // 队列里排在它【前面】的同 cwd 条目也算锁:否则后来者会在先到者之前抢到那把锁(FIFO 公平性)。
  for (const row of stewardArbiter.queue) {
    if (row === entry) break;
    if (row.cancelled || row.sessionId === entry.sessionId) continue;
    if (row.cwdKey === entry.cwdKey) return { lock: { sessionId: row.sessionId, title: row.title, cwdKey: row.cwdKey } };
  }
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
  if (await stewardArbiterHasPending(sessionId)) return passthrough;        // ① 等你 -> 直接放行
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
  // (这一判定是同步的,可以留在入队之前;真正的准入判定见下。)
  if (stewardArbiter.queue.length >= STEWARD_ARBITER_QUEUE_MAX) return stewardArbiterGrant(entry);
  // 116-3 P0-5(对抗审查:同 cwd 写互斥的 TOCTOU):全新条目【也】一律先入队,准入判定与「写进
  // running」由 stewardArbiterDrain 在【同一个同步段】里完成(drain 自己有 draining 单飞标志)。
  // 旧写法在这里单独跑一次 stewardArbiterBlocked 再 grant —— 中间隔着 readConfig / hasPending /
  // arbiterBudget 三次真实 await(都会让出事件循环),两条 cwd 相同的全新回合几乎同时到达时会
  // 双双判定「没人占着」然后各自 grant,116h 的核心保证在真实并发下根本不成立。
  // 代价:没被挡住的回合也多走一次 drain 的 readConfig(不缓存,§8.10 要求上限改动即时生效)。
  // waited 保持 false —— 只有真的被挡住时 drain 才置 true,没等过的回合在事件流里不多两帧。
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
    const result = stewardArbiterPrioritize(body && body.sessionId);
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
});
