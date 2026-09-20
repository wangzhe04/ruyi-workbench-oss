// ============================================================================
// 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合运行器族的注册表、
// 三条路由与两个「够不着才落在这里」的工具实现。
//
// 落点(transport 层,manifest 中位于 13q-steward-runner-turn.js 之后、14-main.js 之前)。
// T2 拆分:本文件曾 2522 行(比 T1 拆之前的 13g 还长,而 31 号文七轴的回合层改动全要往它
// 里面加)。按「谁被谁引用」拆成六个文件,拼接顺序即依赖方向,零新增前向边:
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
// 下面这段 116f 的横幅逐字节原样保留。它描述的是【整个 13h 族】合起来做的那件事 ——
// 里面的「本文件」如今指的是 13m/13n/13o/13p/13q/13h 这六个文件,不再只是一个文件;
// 开关红线、零入边、steward_reply 投放口径三条铁律一字未改,对整族同样成立。
// ============================================================================
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

// ── 用户手按的停止也进决策日志(121-K5;33 号文 §0 末段记的那条不对称,34 号文 §4.4 末条)────────
// 事实:全仓只有一个停止原语(04 的 stopSession),两条路都落到它 —— 管家按的走上面那个
// steward_thread_stop(写一行决策日志),用户按的走 POST /api/stop(什么都不写)。于是「行动流水」
// 上看得见模型停了哪条线程,看不见人停了哪条;116-3 P1-13 当初以「全部行动经命令核心与审计」为由
// 把「提升优先级」改走工具实现时,「停止」没照做。这里还的就是这一笔。
//
// 为什么住 13h:13-http-router.js 拼在 13h 【之前】,直接调 13j 的 stewardAppendDecision 是前向边
// (32 号文 §4 纪律 1 的例 3 同一个模具)。所以走 StewardHooks 迟绑定 —— 与它旁边那个
// cancelQueuedTurn 逐字同一个挂法:路由那一侧只认 typeof StewardHooks.x === 'function'。
//
// 行形状对齐上面那一条(tool/args/targetSessionId/permissionMode/mayAct/undoRef/basis):
//   · tool = 'user_stop' —— 它不是一个管家工具,所以不叫 steward_*;读流水的人一眼分得出是谁按的;
//   · mayAct = 'user' —— 真值表里没有这一档,因为【压根没有过权限判定】:人手按的停止不需要管家
//     有没有资格,记的是「这一下是人做的」;
//   · basis.origin = 'ui_stop' —— 与 revokeAllGrants(sid,'ui-stop') 同源的那句话,来路一眼可查;
//   · undoRef 与 steward_thread_stop 那一条逐字相同(停下的回合不能原样续上,这一点与谁按的无关)。
// 开关关时【不写】:决策日志住 stewardDir(),27 号文 §3.4 的红线是「开关关时零持久化写入」。
// 记账失败绝不影响停止本身(stewardAppendDecision 自己就是 fire-and-forget)。
async function stewardAppendUserStop(sessionId, facts) {
  const sid = safeSessionId(sessionId);
  if (!sid) return false;
  const config = await readConfig().catch(() => null);
  if (!config || config.stewardEnabledV1 !== true) return false;
  const head = await stewardReadSessionHead(sid).catch(() => null);
  if (!head || !head.id) return false;
  if (stewardRawKind(head) === 'steward') return false;   // 管家自己那条会话不进线程流水
  const f = (facts && typeof facts === 'object') ? facts : {};
  stewardAppendDecision({
    tool: 'user_stop',
    args: { stopped: f.stopped === true, queuedStopped: f.queuedStopped === true },
    targetSessionId: sid,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'user',
    undoRef: { kind: 'none', note: '停下的回合不能原样续上;要继续用「接着办」' },
    basis: { origin: 'ui_stop' },
  });
  return true;
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
        // 123-P1 ①(38 号文):这一帧是【白名单】,不是整份 reply 的展开 —— 13q 往回执里加的字段
        // 不写进这里就到不了前端。契约不完整那句灰字回执在 live 那条路(finishReply)靠的就是它。
        // 缺省不写,与落盘章同一口径。
        ...(reply.contractIncomplete === true ? { contractIncomplete: true } : {}),
        // 123-P1 收尾（38 号文 §4；P1 登记项①，主会话补）：`createdAt` 也漏在白名单外面。
        // 123-N1 ① 给 13q 的回执加了它（落盘那条助手消息的 createdAt），前端 finishReply 拿它
        // 推 `lastRenderedAt` 水位；可这一帧没带，前端读到的恒空，**主路径从未生效**，一直靠
        // `alignWatermark()` 那条兜底活着（每回合多发一次 `?since=`）。AB 段测得绿是因为它 stub
        // 了 fetch、直接喂带 createdAt 的回执，够不着这一帧。缺省不写，与上面两个同口径。
        ...(reply.createdAt ? { createdAt: String(reply.createdAt) } : {}),
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
  // 121-K5:用户在界面上手按的停止也记一行决策日志(33 号文 §0 的不对称)。挂法与上一行同款,
  // 消费者只有 13 的 POST /api/stop —— 它拼在 13h 之前,经 06i 的命名空间调,零新增前向边。
  appendUserStop: stewardAppendUserStop,
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
  // 129g:此刻【正在跑的那个管家回合】是谁触发的('user' | 'inbox' | '')。
  // 为什么要有这一口:管家工具有两条调用面 —— ① 模型在回合的工具循环里直接调(09-workflow 造的
  // ctx 是 {sessionId,turnSeq,session,config,workingDir,signal},**没有 trigger**);② 13p 的自理层
  // 与 /api/steward/act 显式带 trigger。于是 stewardTriggerOf(ctx) 在【第一条面上恒为空串】,
  // 而 stewardUnattendedByModel 恒为 false —— 无人值守回合里模型直接调 steward_thread_continue,
  // 自理清单闸与目标线程权限闸**一道都不过**,拿到的是「用户就在跟前」的直递待遇。
  // (既有 e2e 全部手工往 ctx 里塞 trigger,所以这个缺口一直没被照到。)
  // 补法放在 13g 的 stewardToolHandler 一处(42 个工具的唯一咽喉),它经本口取真值;
  // inflight 在回合本体开跑【前】同步认领、收尾时清空,所以工具循环期间它就是当前回合的那一个。
  currentTurnTrigger: () => (stewardRunnerRuntime.inflight ? String(stewardRunnerRuntime.inflight.kind || '') : ''),
  // 117l D7:同理住 13h —— 它要 02 的 normalizeSessionEngineRoute 与 04 的 logEvent,06i 够不着那两个。
  applyThreadTier: stewardApplyThreadTier,
});
