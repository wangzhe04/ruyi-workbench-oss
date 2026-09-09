// ============================================================================
// 第 117 波 T1(32 号文 §2.1):管家线程族工具 —— 管家「动如意」的那只手全在这里。
//
// 落点(transport 层,manifest 中位于 13j-steward-tool-base.js 之后、13l-steward-ops.js 之前)。
// 收录九个工具的实现:steward_threads_search / thread_status / thread_read / thread_new /
//   thread_continue / thread_rename / thread_permission / thread_note / quick_ask;
//   派活原语(stewardLaunchTurn / stewardRecordLaunchOutcome / stewardTriggerOf /
//   stewardUnattendedByModel / stewardRelayAutoAllowed)也在这里 —— 它们的消费者全在本文件内;
//   外加两个基础设施实现 —— stewardEnrichInboxRows(给收件箱行补交付摘要,消费者是 13i 的轮询器)
//   与 stewardQuickClose(速查线程收工,消费者是 13h 的回合收尾),它们都只经 StewardHooks 露面。
// 全部函数体自原 13g-steward.js 逐字节搬来,零行为改动;工具门控壳与注册表仍在 13g。
//
// 铁律一条没变(见 13j 顶部 116c 横幅):管家不「动世界」,要动手一律委派给线程;每个写动作经
// stewardAppendDecision 落一行决策日志;放行范围一律经 06i 的 stewardMayAct,只能收紧不能放宽。
//
// 依赖纪律(§11.3):本文件只引用拼接顺序在它之前的模块符号(00/01/01c/02/04/06i/10/13d/13e/13i/13j …),
// 全部后向边;它自己的符号只被 13g 的注册表引用,同样是后向边。
// ============================================================================

// 2) steward_threads_search —— 113b 的会话内容搜索核心(不走 HTTP)+ 标题词法兜底。
async function stewardImplThreadsSearch(args, ctx, config) {
  const q = String(args.q || '').trim();
  const limit = stewardClampInt(args.limit, 1, STEWARD_SEARCH_LIMIT_MAX, STEWARD_SEARCH_LIMIT_DEFAULT);
  const includeClosed = args.includeClosed === true;   // 116-2e:把已收工的速查线程也算进来
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
    // 116-2e(§11.1 第 2 项):已收工的速查线程默认不出现 —— 它答完那一句就没用了,留在结果里
    // 只会挤掉真正的任务线程。includeClosed:true 可以要回来(用户问「刚才那条速查说了啥」)。
    if (!includeClosed && stewardQuickClosed(head)) continue;
    const meta = byId.get(row.id) || {};
    const slice = slices.get(row.id) || null;
    const card = slice ? overlayMissionCard(slice) : null;
    // 116-3 P1-5:兜底判据从「非 mission 即 quick_ask」改成「只有管家自己开的速查线程才是 quick_ask」。
    // sessionKind() 里的 'quick_ask' 是第 70 波遗留的「纯问答默认档」,与 116 波的「速查线程」是两个概念;
    // 混用会把用户正在进行的普通对话打上「速查中」标签喂给管家,让它以为那是「答完即扔」的临时线程。
    // 117r-D5 收尾(主会话):D5 把五态的守卫从「是不是速查」换成「调用方有没有事实」之后，这条【没有
    // 卡片】的兜底支就漏了 —— 它一个事实都不喂,原来靠 kind 短路才说得出「速查中」,改完会一路掉进
    // 「无 run、无回合、无里程碑」那条分支变成「交办中」。D1 之后速查线程恒有卡片,所以只在投影还没
    // 赶上的瞬时窗口走到这里,但那也是一句假话。速查那一侧显式说「我没有事实」,与 13d 那条不读会话头
    // 的兜底支同一口径;mission 那一侧不动(它本来就落 dispatching,逐字节不变)。
    const derived = card ? stewardThreadStateFromCard(card)
      : (stewardQuickThread(head)
        ? deriveStewardThreadState({ kind: 'quick_ask', factsUnknown: true })
        : deriveStewardThreadState({ kind: 'mission' }));
    const missionId = (slice && slice.missionId) || (head && sessionMissionId(head)) || row.id;
    results.push({
      sessionId: row.id,
      missionId,
      // 116g:命中的线程属于哪个【事项】。未归类线程这里是空串(事项标题就是线程标题,不重复说)。
      missionTitle: await missionTitleOf(missionId),
      title: stewardSanitizeText(meta.title || (head && head.title) || ''),
      ...(sessionBriefOf(head) || sessionBriefOf(meta) ? { brief: sessionBriefOf(head) || sessionBriefOf(meta) } : {}),   // 116-5b(§11.8.5):title 仍是原话(管家凭它认出用户当时的说法),名字与概括另给一个键,缺席时不出现;经典壳那一面在 13d 的 searchSessionsByContent
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
      kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',   // 116-3 P1-5,判据同 threads_search
      autoMode: head.mission && head.mission.autoMode,
      resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
      pending: await missionPendingCounts(sessionId, [], null).catch(() => null),
      activeTurn: activeChildren.has(sessionId),
      runCount: 0,
      turnSeq: head.turnSeq, ledgerless: !head.mission, lastTurnFailed: !!(head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)), // 117p-S2(§8.3):无账本判据只认「头上没有 mission 容器」,与卡片侧 card.status === 'none' 同义;13g 行闸所迫挤一行,释义见 06i/13d 同名键注释
    });

  const rawPending = (await readInterventions(sessionId).catch(() => [])).filter(iv => iv && iv.status === 'pending');
  const interventions = rawPending
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
    // 116h(§3.1 116h 行 / §8.10「排队可解释」):等待原因【单一】,由 06i 的 waitReasonFor 单点判定
    // (等你 > 等锁 > 等预算 > 等并发位)。pending 用五态判据已经算好的那一份,不再数第二遍;
    // 仲裁器一侧是同步只读(开关关时 arbiterWait 恒返回 null,wait 只可能是「等你」或 null)。
    wait: waitReasonFor(
      { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
      typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(sessionId) : null,
    ),
    // 117l D4(§11.9;用户第四轮走查第 1 条):它在问你。【只加字段】—— wait 与五态一字不改。
    // 判据单点在 06i;本处拿得到完整的最后一条助手消息(session 已装载),所以三态都算得准。
    asksYou: stewardAsksYouForThread({
      pending: rawPending, activeTurn: activeChildren.has(sessionId),
      lastAssistantText: session ? stewardLastAssistantText(session) : (head.summary || ''),
    }),
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
    used += rows[i].text.length + STEWARD_READ_ROW_OVERHEAD;
    if (used > maxChars) { cut = i + 1; break; }
    cut = i;
  }
  let kept = rows.slice(cut);
  // 117s-H3(27 号文 §11.13.3 ④,真 bug):上面那个循环第一步就可能 `used > maxChars` —— 最新的那一行
  // 单独超预算时 cut = rows.length,kept 直接是【空数组】,管家读一条 13000 字的交付得到 `rows: []`,
  // 于是它只能回一句「读不到」。整行丢在「行很多、每行不长」时是对的,在「就一行、那一行很长」时是错的:
  // 用户要的东西全在那一行里。修法 —— 最新一行单独超预算时截【它的尾巴】(结论一般在末尾),
  // 前面补一个 '…' 说明前文被截掉了,并如实标 clippedRows:1(与整行丢的 truncated 分开报,两件事)。
  let clippedRows = 0;
  if (!kept.length && rows.length) {
    const newest = rows[rows.length - 1];
    const room = Math.max(1, maxChars - STEWARD_READ_ROW_OVERHEAD);
    kept = [{ ...newest, text: STEWARD_READ_CLIP_MARK + newest.text.slice(-room) }];
    clippedRows = 1;
  }
  const chars = kept.reduce((n, r) => n + r.text.length, 0);
  bucket.chars += chars;
  return {
    ok: true,
    sessionId,
    tail,
    turnSeqs: [...wanted].sort((a, b) => a - b),
    truncated: cut > 0,
    clippedRows,
    chars,
    quota: { callsUsed: bucket.calls, callsMax: STEWARD_READ_CALLS_PER_TURN, charsUsed: bucket.chars, charsMax: budgetChars },
    rows: kept,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 线程族(tier edit)—— 建线程/递话/改名。全部返回 undoRef 并落决策日志。
// ════════════════════════════════════════════════════════════════════════════

// 后台回合:fire-and-forget(不 await)。管家回合不能被线程回合的时长绑住 —— 它要立刻回一句
// 「已经交给线程 X 去做了」。异常只写 logEvent,绝不冒泡到工具返回值(那会让模型以为没交出去)。
// 116-4(27 号文 §11.7「第四源 sessionTurns」):回合 settle 之后把【身份与成败】落到会话头上。
// 为什么必须落盘:收件箱只读磁盘上的账,而会话头本来没有任何回合成败字段(实测:回合失败后头上只有
// summary 里那句人话,那是渲染不是信号),runSessionTurn 的返回值只活在这一个进程的这一个闭包里。
// 不落盘 = 第四源永远只能报「跑完了」,报不出「挂了」。
//   · launchedBy 在这里补写,是为了覆盖 thread_continue(递话给用户自己的会话,它没经过 createSession)；
//     quick_ask / thread_new 已经在建会话时就地写过了,这里重复写是幂等的。
//   · 成败取【内层】result.result.ok —— 外层 ok 只表示「这次调用完成了」,一条 HTTP 500 的回合外层
//     仍然是 ok:true(116-4 实测),拿外层判会把每一条失败回合都说成收工。
//   · 走 updateSessionMeta 而不是 loadSession+saveSession:settle 那一刻会话可能还在收尾窗口里,
//     这条通道会延后到 settle 之后在【重新装载的副本】上重放,不会用陈旧正文盖掉回合刚写的消息。
//   · 旁路纪律:写失败只是少一条账(第四源退化成报 done),绝不反噬回合本身。
function stewardRecordLaunchOutcome(sessionId, result) {
  const sid = safeSessionId(sessionId);
  if (!sid) return Promise.resolve(null);
  const inner = (result && typeof result === 'object' && result.result && typeof result.result === 'object') ? result.result : null;
  const aborted = !!(inner ? inner.aborted : (result && result.stopped));
  const ok = inner ? inner.ok === true : !!(result && result.ok);
  return updateSessionMeta(sid, {
    launchedBy: 'steward',
    stewardLastTurn: {
      seq: Math.max(0, Number(result && result.turnSeq) || 0),
      ok,
      aborted,
      errorClass: String((inner && inner.errorClass) || ''),
      at: nowIso(),
    },
  }).catch(() => null);
}

function stewardLaunchTurn(input, tool) {
  const promise = runSessionTurn({ ...input, onEvent: () => {} });
  promise.then(result => {
    logEvent({ kind: 'steward_turn_done', tool, sessionId: String(input.sessionId || ''), ok: !!(result && result.ok), stopped: !!(result && result.stopped) });
    void stewardRecordLaunchOutcome(input.sessionId, result);
  }).catch(error => {
    logEvent({ kind: 'steward_turn_error', tool, sessionId: String(input.sessionId || ''), message: String((error && error.message) || error).slice(0, 400) });
    // 回合整个抛出来(不是回合内部失败):同样要留一条落盘的账,否则第四源看见 turnSeq 没动
    // 就什么都不报,管家永远不知道自己派出去的这一趟连回合都没起来。
    void stewardRecordLaunchOutcome(input.sessionId, { result: { ok: false, aborted: false, errorClass: 'launch_error' } });
  });
  return promise;
}

// ── 116-3 P0-2(对抗审查:线程族三工具在三条路径上都没有接入权限门)────────────────────────
// 触发面判定。`ctx.trigger` 由回合运行器的三个执行点显式给:
//   · 模型在结构化回复里声明的 actions —— 透传本回合的 'user' | 'inbox';
//   · 确定性自理(七道闸那条路)—— 恒 'inbox',并另带 ctx.selfServe = true;
//   · 用户在界面上亲手按下按钮的 act 执行路径 —— 恒 'user'。
// 这里用的是 trigger 而【不是】 userPressed:后者的读者按 06i 契约与静态锁只有 config_set /
// skill_toggle 两处(「按钮 ≠ 扩权」),线程族的在不在场判定不该去挤那个字段。
// 其余调用面(工具循环里模型直接调、进程内直调)没有 trigger —— 保持既有直递语义。
function stewardTriggerOf(ctx) {
  const raw = String((ctx && ctx.trigger) || '');
  return raw === 'inbox' || raw === 'user' ? raw : '';
}
// 这一次调用是不是「模型自己在无人值守回合里决定要动别的线程」。
// 三者都不是它:① 用户就在跟前(trigger==='user',含亲手按按钮那条路);② 13h 的【确定性自理】(七道闸,
// ctx.selfServe === true —— 它按事件类别走的是 §3.3 真值表的 'failed' 档,不是 'relay' 档,已经在
// stewardSelfServeGate 里逐条判过了,这里再按 relay 判一次会把「失败自动重试」也一起挡掉);
// ③ 没有 trigger 的调用面(进程内直调/工具循环)—— 保持既有直递语义。
// ctx 由 13h 构造,模型碰不到它;args 里同名字段一概不作数(与 userPressed 同一条纪律)。
function stewardUnattendedByModel(ctx) {
  if (!ctx || ctx.selfServe === true) return false;
  return stewardTriggerOf(ctx) === 'inbox';
}
// 无人值守(inbox)触发时线程族的自理清单闸:relay 没勾选就只提议。
function stewardRelayAutoAllowed(config) {
  const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
  return auto.relay === true;
}

// 10) steward_thread_new —— 委托书。原话逐字在最前,管家补充经中和后进围栏(见 06i buildStewardBrief)。
async function stewardImplThreadNew(args, ctx, config) {
  const brief = (args.brief && typeof args.brief === 'object') ? args.brief : null;
  if (!brief || !String(brief.userText || '').trim()) {
    return stewardFail('invalid_request', 'brief.userText is required and must contain the user\'s own words verbatim');
  }
  // 116-3 P0-2:收件箱触发的「自己新开线程」要用户先在自理清单里留着这一项(§11.1 第 6 项)。
  // 新线程还没有目标线程可判权限,所以这里只有清单这一道闸;新线程自己的权限由全局默认档决定。
  if (stewardUnattendedByModel(ctx)) {
    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    if (auto.newThread === false) {
      return stewardFail('propose_required', '「自己新开线程」已经关掉,无人值守时只能把它作为提议交给用户,不要重试', {
        reason: 'self_serve_off', tool: 'steward_thread_new',
      });
    }
  }
  const composed = buildStewardBrief(brief);
  const requestedMissionId = args.missionId ? safeSessionId(args.missionId) : '';
  if (args.missionId && !requestedMissionId) return stewardFail('invalid_request', 'invalid missionId');

  const session = await createSession({
    title: args.title ? String(args.title).slice(0, STEWARD_TITLE_MAX) : undefined,
    cwd: args.cwd ? String(args.cwd) : undefined,
  });
  session.kind = 'mission';                                   // 线程 = 任务线程(不是速问)
  session.launchedBy = 'steward';                             // 116-4:收件箱第四源的「管家关心」标
  // 117s-A D2(§11.13 ⑤a):管家给的 title【不是】人起的名字(模型只是把用户那句话抄了一遍),
  // 覆写掉 createSession 刚写下的 'user',否则 116-5 的自动摘要永远跳过 —— 白名单与理由见 02:1066。
  if (args.title) session.titleSource = 'steward';
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
  // 117l D7:按任务复杂度选档(缺省 strong)—— 写在 saveSession 之前,跟着同一次落盘走,零额外写。
  const tiered = StewardHooks.applyThreadTier(session, args.tier, config);
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

  // 117d 第 0 步:回退锚点。undoRef.sessionId 是「删掉这条线程」的把手,但整单回退要的是
  // 【被递那一回合将拥有的 seq】—— 与 09-workflow 的 plannedTurnSeq 同口径(session.turnSeq + 1);
  // 新建会话 turnSeq 恒为 0,故委托书是第 1 回合。rewindSession 按这个 seq 定位首条用户消息。
  const undoRef = { kind: 'thread_new', sessionId: session.id, rewindTargetTurnSeq: (Number(session.turnSeq) || 0) + 1 };
  stewardAppendDecision({
    tool: 'steward_thread_new',
    args: { title: session.title, missionId: session.missionId, briefChars: composed.text.length, supplementChars: composed.supplement.length, truncated: composed.truncated, tier: tiered.tier },
    targetSessionId: session.id,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: { memoryIds: composed.memoryIds },
  });
  return { ok: true, sessionId: session.id, missionId: sessionMissionId(session), title: session.title, briefTruncated: composed.truncated, tier: tiered.tier, engine: tiered.engine, undoRef };
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
  // 117l D2(§11.9;用户第四轮走查第 1、6 条):这里原本只有一道 activeChildren.has -> steward.busy,
  // 两头都错(等回答的线程也算「忙」;没命中时 stewardLaunchTurn 又会 supersede 掉它)。现在按
  // 【目标状态】选通道,判定与执行的单点在 13h(经 StewardHooks.relayDeliver 延迟绑定,零前向边;
  // 四条通道各自的理由写在那里的头注),POST /api/steward/relay 走的是同一个实现。

  // 116-3 P0-2:无人值守(收件箱)触发的递话要过两道闸 —— 自理清单勾选 + 目标线程权限档
  // (§3.5 工具面表格:线程族按目标线程权限,「每步都问」「只做计划」一律提议)。判据与
  // stewardImplDecide / stewardImplRunAction 同一写法:先算 mayAct,不是 'auto' 就 propose_required。
  const permissionMode = stewardThreadPermissionMode(head, config);
  let mayAct = 'auto';
  if (stewardUnattendedByModel(ctx)) {
    if (!stewardRelayAutoAllowed(config)) {
      return stewardFail('propose_required', '「事项内自动交接」没有勾选,无人值守时的递话只能作为提议交给用户,不要重试', {
        reason: 'self_serve_off', sessionId, permissionMode,
      });
    }
    mayAct = stewardMayAct(permissionMode, 'relay', 'edit');
    if (mayAct !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,管家不能在你不在场时直接往它里面递话;把它作为提议交给用户,不要重试`, {
        reason: 'target_permission', sessionId, permissionMode,
      });
    }
  }

  // 递话【前】的 turnSeq:检查点以它为锚。但 rewindSession 的主键【不是】它 —— 它按「要删的那一回合的
  // 第一条用户消息」定位,即 plannedTurnSeq = 递话前 turnSeq + 1(与 09-workflow 同口径)。117d 第 0 步
  // 补出显式字段 rewindTargetTurnSeq;turnSeq 语义保持「递话前」不变(既有消费者逐字节不受影响)。
  const beforeTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
  const undoRef = { kind: 'turn', sessionId, turnSeq: beforeTurnSeq, rewindTargetTurnSeq: beforeTurnSeq + 1 };
  const basis = stewardBasisOf(args);
  // title 用【显示名】(116-5b 单点),不拿 id 冒充标题;turn 通道的启动仍是 13g 自己的
  // stewardLaunchTurn(同一个 requestMeta、同一本决策日志)—— 13h 只决定「走哪条」。
  const delivered = await StewardHooks.relayDeliver({
    sessionId, message, title: sessionDisplayTitle(head), source: 'steward_thread_continue',
    launch: () => {
      stewardLaunchTurn({ sessionId, message, source: 'steward', requestMeta: { tool: 'steward_thread_continue', ...(basis.origin ? { origin: basis.origin } : {}) } }, 'steward_thread_continue');
      return { undoRef };
    },
  });
  if (delivered && delivered.ok === false) return delivered;

  stewardAppendDecision({
    tool: 'steward_thread_continue',
    // 117l D2:走的哪条通道进决策日志 —— 行动流水里「答了一道提问」与「开了一个新回合」是两件事。
    args: { messageChars: message.length, channel: String(delivered && delivered.channel || 'turn') },
    targetSessionId: sessionId,
    permissionMode,
    // 116-3 P0-2:写【真实】判定值,不再是硬编码 'auto' —— 决策日志要能事后对账
    // 「这个动作到底是不是该提议而没提议」。
    mayAct,
    undoRef: (delivered && delivered.undoRef) || undoRef,
    basis,
  });
  return { ok: true, sessionId, undoRef, ...(delivered && typeof delivered === 'object' ? delivered : {}) };
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
  // 116-3 P0-2:改名同样按目标线程权限档判(§3.5 线程族整行都是「按目标线程权限」)。
  // 13h 的 stewardSelfServeAllows 末尾原有的注释说「rename 由 13g 内部的 stewardMayAct 裁决」——
  // 那句话此前是错的(内部根本没有这个裁决),这一行把它补成真的。
  const currentMode = stewardThreadPermissionMode(head, config);
  let renameMayAct = 'auto';
  if (stewardUnattendedByModel(ctx)) {
    renameMayAct = stewardMayAct(currentMode, 'relay', 'edit');
    if (renameMayAct !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(currentMode)}」,管家不能在你不在场时改它的标题;把它作为提议交给用户,不要重试`, {
        reason: 'target_permission', sessionId, permissionMode: currentMode,
      });
    }
  }
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
    mayAct: renameMayAct,   // 116-3 P0-2:真实判定值,不再是常量
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

// 24) steward_quick_ask —— 速查线程(§11.1 第 2 项)。
//     何时用:要读文件、联网或动手才能答的问题。何时别用:关于如意、事项、费用、设置的问题 —— 那些
//     管家自己就知道,开一条线程去问等于让用户白等一次回合。
//     不进任何事项;权限用新线程默认权限(即全局 permissionMode),照常受 116h 仲裁;答完自动收工。
async function stewardImplQuickAsk(args, ctx, config) {
  const question = stewardSanitizeText(args.question).trim();
  if (!question) return stewardFail('invalid_request', 'question is required');
  if (question.length > STEWARD_QUICK_QUESTION_CHARS) {
    return stewardFail('invalid_request', `question must be at most ${STEWARD_QUICK_QUESTION_CHARS} characters`);
  }
  if (!stewardTurnQuotaTake('quick_ask', ctx, STEWARD_QUICK_ASKS_PER_TURN)) {
    return stewardFail('quota_exceeded', `at most ${STEWARD_QUICK_ASKS_PER_TURN} quick-ask threads per steward turn; do not retry - answer with what you already know or tell the user`);
  }
  const session = await createSession({
    title: question.slice(0, STEWARD_TITLE_MAX),
    cwd: args.cwd ? String(args.cwd) : undefined,
  });
  session.kind = STEWARD_QUICK_KIND;
  // 116-5a:速查线程建出来时 title 是【问题原话的前 N 个字】,那不是「人给的名字」而恰恰是本波要
  // 替换掉的东西。createSession 会因为它非占位而标上 titleSource:'user',这里清掉 —— 否则这条线程
  // 永远拿不到自动摘要。thread_new 那边不清:args.title 是管家【有意】起的名字,与改名同一性质。
  delete session.titleSource;
  // 116-4:管家关心的会话的三个机器痕迹之一(另两个是 stewardQuick、线程在别人的事项里)。
  // 在这里就地写进内存副本,跟着下面那次 saveSession 一起落盘 —— 零额外写。
  session.launchedBy = 'steward';
  // 速查线程【不进事项】:missionId 指回自己(createSession 的缺省),不写任何反向索引,
  // GET /api/missions 里它就是一条「未归类」的派生行,不占任何事项的验收与预算。
  session.stewardQuick = {
    schema: 1,
    askedAt: nowIso(),
    question,
    stewardTurnKey: String(stewardTurnKeyOf(ctx)),
    closedAt: null,
  };
  // 117l D7:速查线程恒走 fast 档 —— 它定义上就是「查一下」,没有理由烧强模型(没配 fast 档就跟随全局)。
  const quickTier = StewardHooks.applyThreadTier(session, 'fast', config);
  await saveSession(session);

  stewardLaunchTurn({
    sessionId: session.id,
    message: question,
    cwd: session.cwd,
    source: 'steward',
    requestMeta: { tool: 'steward_quick_ask' },
  }, 'steward_quick_ask');

  // 117e 第 0 步:与 117d-0 的 thread_new / thread_continue 同口径 —— 撤回锚点显式化。
  // rewindSession 按「要删的那一回合的第一条用户消息」定位(09 的 plannedTurnSeq = turnSeq + 1),
  // 按 `turnSeq` 字面传会得 target turn not found。新建会话的 turnSeq 恒为 0,这里仍按字段读,
  // 与上面那两处逐字同形(将来 createSession 若带出非零 seq 也不会错)。
  const undoRef = { kind: 'thread_new', sessionId: session.id, rewindTargetTurnSeq: (Number(session.turnSeq) || 0) + 1 };
  stewardAppendDecision({
    tool: 'steward_quick_ask',
    args: { chars: question.length, tier: quickTier.tier },
    targetSessionId: session.id,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: stewardBasisOf(args),
  });
  return { ok: true, sessionId: session.id, kind: STEWARD_QUICK_KIND, question, tier: quickTier.tier, engine: quickTier.engine, undoRef };
}

// ── 收件箱增强(13i 每轮落盘前调,经 StewardHooks 延迟绑定)──────────────────────────────────
// 117s-H1(27 号文 §11.13.3,用户第三轮回话「线程的交付管家能不能看全」):给【每一条】管家关心的
// 线程的 `done` 行补上这一回合真正的交付 —— `payload.deliverable = {text,chars,truncated,turnSeq,files}`。
// 修前只有速查线程补一个 `answer`,而那个字段 13h 里【零渲染点】(grep 可自证):交付正文从来没有
// 进过收件箱回合,管家只拿到一行「线程第 N 回合跑完了」,正文全靠它自己再花一次 thread_read 配额去读。
// 判据用 06i 的 stewardWatchedThread —— 与 13i 决定「这条线程要不要入箱」的是同一条线,不另立第二套
// (用户自己在经典壳里聊的普通会话本来就不入箱,这里也就不会为它们装载会话)。
//
// 为什么在这里而不是在 13i:13i 只认三条 seq 日志,不读会话正文;而交付正文与本回合的文件账都要装载
// 会话。放在 13g 并经命名空间回调,13i 就不需要认识 13g 的任何符号(前向边红线)。
// 旁路纪律:抛错绝不反噬轮询器 —— 13i 那边整段包在 try 里,补不上就是少几个字段。
async function stewardEnrichInboxRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const heads = new Map();
  for (const row of list) {
    if (!row || row.kind !== 'done') continue;
    const sid = safeSessionId(row.sessionId);
    if (!sid) continue;
    if (!heads.has(sid)) heads.set(sid, await stewardReadSessionHead(sid).catch(() => null));
    const head = heads.get(sid);
    if (!head) continue;
    if (!stewardWatchedThread(head, sid, row.missionId)) continue;
    const quick = stewardRawKind(head) === STEWARD_QUICK_KIND && !!head.stewardQuick;
    const session = await loadSession(sid).catch(() => null);
    if (!session) continue;
    const payload = (row.payload && typeof row.payload === 'object') ? row.payload : {};
    // 回合号取事件自己的(第四源 stewardNormalizeSessionTurn 落的 payload.turnSeq);取不到就退到
    // 会话头上的当前回合号,再取不到才让下面的挑选退到「最后一条助手话」。
    const turnSeq = Math.max(0, Number(payload.turnSeq) || 0) || Math.max(0, Number(head.turnSeq) || 0);
    const full = stewardSanitizeBlock(stewardTurnAssistantText(session, turnSeq));
    const patch = {};
    if (full.trim()) {
      patch.deliverable = {
        text: full.slice(0, STEWARD_DELIVERABLE_CHARS),
        chars: full.length,
        truncated: full.length > STEWARD_DELIVERABLE_CHARS,
        turnSeq,
        files: stewardTurnFiles(session, turnSeq),
      };
    }
    // 速查线程的 `answer` 留着(老消费者与 116-2e 的收工判据都认它),但它现在与交付【同一份原文】,
    // 只是仍按 ≤1200 的老口径中和成单行 —— 两个字段从此不会各说各的。
    if (quick) {
      patch.quick = true;
      patch.answer = stewardSanitizeText(full || stewardLastAssistantText(session)).slice(0, STEWARD_QUICK_ANSWER_CHARS);
    }
    if (Object.keys(patch).length) row.payload = { ...payload, ...patch };
  }
  return list;
}

// 收工:回合结束后由 13h 调 —— 把 stewardQuick.closedAt 落在会话头上。收工后这条线程从管家的总览
// 与 steward_threads_search 里消失(经典壳照常看得见,它只是数据)。幂等:已收工的再调是无操作。
async function stewardQuickClose(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return { ok: false, error: 'invalid_request' };
  const head = await stewardReadSessionHead(sid);
  if (!head || stewardRawKind(head) !== STEWARD_QUICK_KIND || !head.stewardQuick) return { ok: false, error: 'not_found' };
  // 116-3 P1-6:判「还算不算收工」走 stewardQuickClosed(它会把「收工后用户又聊了」算成重开),
  // 而不是只看 closedAt 是不是真值 —— 否则一条被用户重新用起来的速查线程再次收工时会被当成幂等
  // 直接返回,closedTurnSeq 永远停在第一次收工那一刻,它就再也关不上了。
  if (stewardQuickClosed(head)) return { ok: true, sessionId: sid, closedAt: head.stewardQuick.closedAt, changed: false };
  const closedAt = nowIso();
  // 收工时记下【当时的回合数】。之后会话每多一个用户回合,turnSeq 就会超过它 = 用户在继续用这条线程。
  const closedTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
  await updateSessionMeta(sid, { stewardQuick: { ...head.stewardQuick, closedAt, closedTurnSeq } });
  return { ok: true, sessionId: sid, closedAt, closedTurnSeq, changed: true };
}
