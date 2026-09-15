// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家的回合入口、到访、递话通道与 acts 落定。
//
// 落点(transport 层,manifest 中位于 13p-steward-runner-actions.js 之后、13h-steward-runner.js 之前)。
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

// 123-N1 ①:本回合落盘的那条助手消息的 createdAt(回执带给前端当水位用,见 stewardRunClaimedTurn
// 里的调用点)。形状照抄同族的 stewardLastAssistantContent —— 同一条消息、同一个找法(从尾往前
// 找第一条 assistant),只是取的字段不同;读不到会话、没有助手消息、字段缺失都回空串,调用方据此
// 退到「对齐一发」的老路。代价是每回合多一次会话读:stewardLastAssistantContent 在 13p、本刀不碰
// 它(硬纪律的独占文件表),合并成一次读是主会话的活,登记为一笔小债。
async function stewardLastAssistantCreatedAt() {
  const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
  if (!session) return '';
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') return String(messages[i].createdAt || '');
  }
  return '';
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
  // 123-N1 ①(34 号文;用户 2026-09-13 真机走查「同一段对话出现两遍」):回执带上【本回合落盘的
  // 那条助手消息的 createdAt】。前端 finishReply 拿它推 appendSince 的水位 —— 修前水位只在
  // 「进壳画历史」那一处推高,用户自己发的回合直接上屏、从不推水位,于是下一条收件箱回合到达时
  // 壳层按旧水位重拉增量,把屏上已有的回合又画了一遍。
  // 取的是【同一条消息】的字段:stewardStampReply 盖章盖在「最后一条助手消息」上,这里读的也是
  // 它(盖章只写 .steward,不动 createdAt,所以先读后盖、先盖后读拿到的是同一个值)。用户那条消息
  // 的 createdAt 更早,水位推到助手这条即把两条一起盖住。
  const stampedAt = await stewardLastAssistantCreatedAt();
  const parsedReply = stewardParseReply(finalText);
  // 123-P1 ①(38 号文;用户 2026-09-14 真机取证):契约不完整 —— 模型没给必填的 why(判据与理由见
  // 13o stewardParseReply 那一段头注)。这里做两件事:记一条审计(trigger / 模型给了哪些键 / say
  // 有多长,正文一个字不进日志),以及往下把旗子带进回执与落盘的章 —— 前端据此在这条回复下面画
  // 一句灰字系统回执,明说「这一轮它没有执行任何动作」。
  // **诚实优先,不重试**:在同一回合里用一条纠正提示重跑一次模型这个方案评估过,不做 ——
  // 它必然动到回合语义的四处:① 第二发 runSessionTurn 会往管家会话里【真的】写一条 user 消息
  // (纠正提示)和第二条 assistant 消息,对话流回放时那条纠正提示会当成用户气泡上屏;
  // ② stewardRunnerRuntime.turns 与用量台账要么漏记(一次模型调用逃过每小时熔断与日费用)、
  // 要么多记(用户看到「一句话花了两个回合」);③ 抢占:重试把 inflight 的占用窗口拉长一倍,
  // 用户回合抢占一个收件箱回合的时序随之改变(controller 只有一个,abort 落在哪一发也要重新定义);
  // ④ stewardLastAssistantCreatedAt / turnSeq 取的是「最后一条助手消息」,重试后它指向第二发。
  // 派单稿的原话是「如果会动到回合循环、预算、熔断或抢占的语义,就不做」—— 四条全中,故登记为
  // 后续(要做得先给重试一条【不写会话正文】的旁路通道,那是 09-workflow 的地界)。
  if (parsedReply.contractIncomplete === true) {
    logEvent({
      kind: 'steward_contract_incomplete',
      trigger,
      keys: Array.isArray(parsedReply.contractKeys) ? parsedReply.contractKeys : [],
      sayChars: String(parsedReply.say || '').length,
    });
  }
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
    // 123-N1 ①:落盘时刻(ISO 8601 定长 UTC 串,与 GET /api/sessions/steward?since= 同一把尺)。
    // 读不到就不下发这个键 —— 前端缺省时自己走「对齐一发」的退路,老回执逐字节不变。
    ...(stampedAt ? { createdAt: stampedAt } : {}),
    // 123-P1 ①:【缺省不写】。老回合的落盘章里读不到这个键即为 false,前端 `=== true` 判定,
    // 一份历史都不用迁移。
    ...(parsedReply.contractIncomplete === true ? { contractIncomplete: true } : {}),
    circuit: null,
  };
  // 117s-H4:落盘的回执带来源(对象);reply.trigger(内存态 lastReply 与 steward_reply 帧)仍是字符串。
  await stewardStampReply({
    say: reply.say, why: reply.why, acts: reply.acts, actions: reply.actions, parsed: reply.parsed,
    // 123-P1 ①:落盘的章也带这一面 —— 回放那条路(前端 renderHistorySince)只看得到这份章,
    // live 与刷新之后看到的必须是同一句话。同样缺省不写。
    ...(reply.contractIncomplete === true ? { contractIncomplete: true } : {}),
    trigger: await stewardTriggerStamp(trigger, events).catch(() => ({ kind: trigger })),
  });
  // 121-K2a(§6.1 第 3 条):管家刚说完一句并落了盘。**正文不进事件**(§6.1 红线;避免双写)——
  // 前端收到这一帧再去拉一次消息面,拉到的与落盘的是同一份。
  RUYI_EVENTS.emit('steward.say', { turnSeq: reply.turnSeq, trigger: String(trigger || '') });

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

// 确定性到访摘要:自上次到访以来的收件箱事件按七类归纳成 ≤5 条人话,再加 123-M2 的【承诺三项】。
//
// 承诺三项(37 号文 §3.5)与上面那七类是【两本账】,不能合成一本:
//   · 七类数的是「上次到访以来【发生过】什么」(收件箱流水,按 inboxSeq 切);
//   · 三项里的「未来承诺」与「等你的」数的是【此刻的状态】(还没发生的下一次触发、仍然卡着的
//     needs_you)—— 拿流水去数它们会把「同一条任务反复 needs_you」算成好几条。
// 只有中间那一项(过期或结果未知)是流水,所以它单独用 fires 的 seq 当水位(见 13m 的 visit.fireSeq)。
//
// 读口经 06j 的 SchedulerHooks.commitmentsSince —— 实现住 13t-steward-schedule.js,它在 manifest 里
// 排在本文件【之后】,直接写函数名会是前向边;调度器关着或钩子没填充时整段是无操作(三项全 0)。
const STEWARD_COMMITMENT_TEXT = Object.freeze({
  upcoming: n => `${n} 件定时任务 24 小时内要触发`,
  missed: n => `${n} 件定时任务过期或结果未知`,
  needsYou: n => `${n} 件定时任务等你批准`,
});
const STEWARD_COMMITMENT_I18N = Object.freeze({
  upcoming: 'stewardShell.digest.commitment.upcoming',
  missed: 'stewardShell.digest.commitment.missed',
  needsYou: 'stewardShell.digest.commitment.needsYou',
});
async function stewardVisitDigest(sinceSeq, sinceFireSeq) {
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
  let commitments = { upcoming: 0, missed: 0, needsYou: 0, fireSeq: Math.max(0, Number(sinceFireSeq) || 0) };
  if (typeof SchedulerHooks.commitmentsSince === 'function') {
    // 旁路纪律:承诺读口出错只是少三行摘要,绝不让「打开管家」这件事失败。
    try { commitments = (await SchedulerHooks.commitmentsSince(sinceFireSeq, Date.now())) || commitments; }
    catch { /* 保持全 0 */ }
  }
  // 三项排在七类【之后】:那七类是刚发生的事(更新鲜),承诺是日程(用户自己早就知道有这回事)。
  // 同样受 STEWARD_VISIT_DIGEST_MAX 那个 ≤5 的帽子。
  for (const field of ['upcoming', 'missed', 'needsYou']) {
    if (items.length >= STEWARD_VISIT_DIGEST_MAX) break;
    const n = Math.max(0, Number(commitments[field]) || 0);
    if (!n) continue;
    items.push({
      kind: 'commitment', field, count: n,
      key: STEWARD_COMMITMENT_I18N[field], params: { count: n },
      text: STEWARD_COMMITMENT_TEXT[field](n),
    });
  }
  return {
    items, counts,
    commitments: { upcoming: commitments.upcoming, missed: commitments.missed, needsYou: commitments.needsYou },
    inboxSeq: Math.max(0, Number(read.inboxSeq) || 0),
    fireSeq: Math.max(0, Number(commitments.fireSeq) || 0),
  };
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
  const sinceFireSeq = Math.max(0, Number(stewardRunnerRuntime.visit.fireSeq) || 0);   // 123-M2 承诺三项的第二个水位

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
        fireSeq: sinceFireSeq,
        previousStartedAt: previousStartedAt || '',
      };
    }
  }
  const digest = await stewardVisitDigest(sinceSeq, sinceFireSeq);
  if (visitOpened) {
    stewardRunnerRuntime.visit.inboxSeq = digest.inboxSeq;   // 下次到访从这里往后归纳
    stewardRunnerRuntime.visit.fireSeq = digest.fireSeq;     // 123-M2:fires 那本账各走各的水位
  }
  const pending = await stewardPendingList();
  // 124 还债④(40 号文 §8.5 ④):**服务端不再自己挑「现在这一件」**,只把行投影出去。
  //
  // 修前这里有自己的一条挑选式:
  //     rows.find(needs_you) || rows.find(running) || rows[0]
  // 而界面那一份(public/js/thread-facts.js 的 focusThreadFor,124 走查② 之后是「等你 > 在跑 >
  // 最近发生的那一件」)判的是同一个问题:右栏「现在这一件」挑一条,问候语那枚「打开这一件」挑
  // 另一条。两处的第三档修前本来就不一样 —— 上面 stewardThreadDigestRows 的排序把 dispatching
  // 顶在「其余」之前,于是一条排队中的线程会赢过刚刚做完的那条。同一个问题两处判,迟早各说各话。
  //
  // 收法:这里只投影事实(id / 名字 / 五态 / 最后动静),挑哪一条由前端那一份纯函数判 —— 它有
  // unit 真值表与 focus-rail B1 两道锁,而本文件里再没有第二条挑选式(steward-runner.static 钉着)。
  // 帽子复用总览那一个(STEWARD_DIGEST_LIMITS.maxThreads = 40),不另起旋钮;行序保持
  // stewardThreadDigestRows 的优先序,所以裁掉的只可能是【既不等你也不在跑】的那些。
  const rows = await stewardThreadDigestRows(config).catch(() => []);
  const threads = rows.slice(0, STEWARD_DIGEST_LIMITS.maxThreads).map(row => ({
    sessionId: row.sessionId,
    // 116-5b:名字走显示名(缺摘要时回落到原话),与修前 focus.title 逐字同源。
    title: row.displayTitle || row.digest.title,
    state: row.state,
    updatedAt: row.updatedAt,
  }));
  return {
    ok: true,
    // 116-3 P2-14:归档失败时如实说「这次到访没真正开始」—— 时间戳没推进,下一次调用会立刻再试一次。
    newVisit: visitOpened,
    since: previousStartedAt || '',
    visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
    archive,
    digest: { items: digest.items, counts: digest.counts, commitments: digest.commitments },
    pending,
    // 124 还债④:不再回 focus —— 挑哪一条由前端那一份 focusThreadFor 判(§8.5 ④)。
    // 行里的名字仍走显示名(116-5b),与修前 focus.title 逐字同源。
    threads,
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
