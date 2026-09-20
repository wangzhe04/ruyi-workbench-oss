// ============================================================================
// 第 121 波 K2a(34 号文 §6.1「一条推送:GET /api/events/stream(SSE)」):事件流。
//
// 落点(transport 层,manifest 中位于 13h-steward-runner.js 之后、14-main.js 之前;文件名按
// ENGINEERING-SPEC §1 的 `^13[a-z]?-` 正则)。职责【只有一件】:把已经发生的事扇出到所有连接。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 本文件只引用拼接顺序在它【之前】的模块符号(00-boot 的 RUYI_EVENTS/EventStreamHooks、
//     01-config 的 send/json/tokenOk、02 的会话头读取、04 的 activeChildren 与旁路订阅、
//     06i 的五态派生、13d 的未决计数)—— 全部后向边;
//   · 13-http-router.js 排在本文件【之前】,【不得】直接引用本文件的任何符号。挂接走 00-boot 的
//     延迟绑定命名空间 `EventStreamHooks`(先例:06i 的 StewardHooks、06c 的 AgentLoopHooks);
//   · 没有任何模块引用本文件的 provides,故本文件不进任何环。
//
// 红线(§6.1):
//   ① 事件流【不承载工具输出正文】—— 只带「哪条线程、什么状态、在调什么工具」。参数、结果、
//      文件内容一个字都不进这条线;要正文仍走既有的 GET /api/sessions/:id 与管家消息面。
//   ② 不改任何写路径的语义。生产者那边每处只多一行 `RUYI_EVENTS.emit(...)`,派不出去就算了。
//   ③ 不落盘。环是内存的,进程重启即空;断线补发只补最近 200 条,补不到就让客户端整份重拉
//      (兜底轮询本来就在,§6.2)。
//
// 五态【不在这里另算一遍】:`thread.state` 的 state 由 06i 的 deriveStewardThreadState 现算,
// 入参与 13d buildMissionAggregateRows 的②支逐字一致(那一支也是「有会话头在手」的情形)。
// 全仓只有那一份判据,这里是它的第三个调用面,不是第二份实现。
// ============================================================================

const EVENT_STREAM_RING_MAX = 200;            // 断线补发窗口(§6.1);超出让客户端整份重拉
const EVENT_STREAM_HEARTBEAT_MS = 25000;      // `: ping` 心跳(§6.1)
const EVENT_STREAM_LIVE_THROTTLE_MS = 500;    // thread.live 每会话 ≥500ms 一条(§6.1 节流列)
const EVENT_STREAM_TEXT_TAIL = 240;           // textTail 上限(§6.1 载荷列)
const EVENT_STREAM_SUMMARY_MAX = 160;         // summary 上限(§6.1 载荷列)
const EVENT_STREAM_LIVE_SESSIONS_MAX = 256;   // 节流表容量上限(长跑进程里它只增不减的防线)

// 连接表。每条连接就是一份【在场信号】(§4.3):lens 与 sessionId 来自查询参数,断连即清。
const eventStreamClients = new Set();   // { res, lens, sessionId, at, heartbeat }
// 环 + 单调 id。id 只在【广播帧】上递增 —— presence.ack 是连接私有帧,故意不带 id,
// 免得它把客户端的 Last-Event-ID 推到一个别人没有的位置。
const eventStreamRing = [];             // [{ id, event, data }]
let eventStreamSeq = 0;

function eventStreamWriteFrame(client, frame) {
  if (!client || !client.res || client.res.writableEnded) return;
  try {
    client.res.write(
      (frame.id ? `id: ${frame.id}\n` : '') +
      `event: ${frame.event}\n` +
      `data: ${JSON.stringify(frame.data)}\n\n`,
    );
  } catch { /* 客户端走了;close 监听器会清 */ }
}

// 广播一帧。`at` 是【服务端写这一帧的时刻】—— §6.3 的五个指标就是拿它与客户端收到的时刻比对的,
// 载荷里没有它的话「≤1 s」这条验收无从证伪。
function eventStreamPublish(event, data) {
  eventStreamSeq += 1;
  const frame = { id: eventStreamSeq, event: String(event || ''), data: { ...(data || {}), at: nowIso() } };
  eventStreamRing.push(frame);
  while (eventStreamRing.length > EVENT_STREAM_RING_MAX) eventStreamRing.shift();
  for (const client of eventStreamClients) eventStreamWriteFrame(client, frame);
}

// 管家自己的会话【不是线程】,`thread.*` 一条都不该带它(它的动静走 steward.say)。判据与
// 13i:783 逐字同源 —— 按固定 id 判,不按会话头原始 kind(会话头在建的那一刻还没标上)。
function eventStreamIsStewardSession(sessionId) {
  return String(sessionId || '') === STEWARD_SESSION_ID;
}

// ────────────────────────────────────────────────────────────────────────────
// 在场快照(§4.3;K3 的收件箱在场门要用)。**本刀只产出这份事实,不接任何门** ——
// 收件箱现在读不到它,行为一个字没变。
// ────────────────────────────────────────────────────────────────────────────
function stewardPresenceSnapshot() {
  return [...eventStreamClients].map(client => ({
    lens: String(client.lens || ''),
    sessionId: String(client.sessionId || ''),
    at: String(client.at || ''),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// thread.state:会话头变过 / 回合起跑 / 回合收尾之后现算一次五态。
// 每会话串行 + 合并:同一条线程在一次派生还没跑完时又变了,只补跑一次(不排队 N 次)。
//
// 128f-⑫(用户 2026-09-19「删除线程等操作没有及时的界面反馈,要点别处才刷新」):两种来路。
//   · 显式那一路(RUYI_EVENTS 'thread.state':回合起跑/收尾、改名/置顶、待决结算、班组控制)照旧【每次都发】;
//   · 隐式那一路(RUYI_EVENTS 'thread.touched':02 saveSession 每次落会话头都派一发)只在【这一行看得见的
//     那几样】变了才发 —— 回合里 saveSession 一轮好几次,每次都推的话每个客户端每次都要重拉一遍行,正是
//     K2b 明确拒绝的那件事(见 thread.live 的节流头注)。「看得见的那几样」= 推送载荷里除 updatedAt 之外的
//     全部 ＋ 显示名 ＋ 自动推进／结论／验收 a/b。【不含】turnSeq:回合起跑之后它才加一,放进来就是在跑那一段
//     平白多推一帧(event-stream.e2e H3 第一轮实测);回退改 turnSeq 的那一处(02 rewindSession)自己显式派。
//   为什么要有隐式那一路:行的来源有几十个写口(停自动推进、回退、管家接手、预算熔断……),逐个补
//   RUYI_EVENTS.emit 就是又一张手攒的名单;会话头是它们全都要经过的那一处(02 saveSession)。
// ────────────────────────────────────────────────────────────────────────────
const eventStreamStateBusy = new Set();
const eventStreamStateAgain = new Map();        // sessionId -> 补跑那一趟是不是显式的(显式 OR 隐式 = 显式)
const eventStreamLastRowSig = new Map();        // sessionId -> 上一次发出去的那一行签名(隐式那一路据此去重)
const EVENT_STREAM_ROW_SIG_MAX = 2048;          // 签名表容量上限(长跑进程里只增不减的防线;满了整表清空,代价是多推一次)
async function eventStreamEmitThreadState(sessionId, opts = {}) {
  const sid = safeSessionId(sessionId);
  if (!sid) return;
  if (eventStreamIsStewardSession(sid)) return;
  const onlyIfChanged = Boolean(opts && opts.onlyIfChanged);
  if (eventStreamStateBusy.has(sid)) {
    eventStreamStateAgain.set(sid, (eventStreamStateAgain.get(sid) === false ? false : true) && onlyIfChanged);
    return;
  }
  eventStreamStateBusy.add(sid);
  try {
    const head = await readMissionSessionHead(sid).catch(() => null);
    if (!head || !head.id) return;                       // 会话已删/读不出来:不编一个状态出来
    const pending = await missionPendingCounts(sid, [], null).catch(() => null);
    const derived = deriveStewardThreadState({
      kind: 'mission',
      autoMode: head.mission && head.mission.autoMode,
      resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
      pending,
      activeTurn: activeChildren.has(sid),
      runCount: 0,
      turnSeq: head.turnSeq,
      // 与 13d 的②支逐字一致:无账本判据只认「头上没有 mission 容器」。
      ledgerless: !head.mission,
      lastTurnFailed: !!(head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)),
    });
    // `wait` = 这条线程此刻有几件在等你。与五态的 needs_you 判据同源(pendingTotal > 0),
    // 不是第二个计数口径。
    const wait = pending ? (Math.max(0, Number(pending.permissions) || 0) + Math.max(0, Number(pending.questions) || 0)
      + Math.max(0, Number(pending.plans) || 0) + Math.max(0, Number(pending.pool) || 0)) : 0;
    // 121-K3:origin / watched 两个字段补齐(§4.1 的事件表)。判据【不新造】—— 与 13e 的索引行
    // 用的是 06i 同一对函数(threadOriginOf / stewardWatchedThread),同一个会话头喂进去,
    // 推送与索引不可能各说各话。missionId 与 watched 判据吃的是同一个值(下面这行现算的那个)。
    const missionId = String(sessionMissionId(head) || sid);
    const frame = {
      sessionId: sid,
      missionId: String(sessionMissionId(head) || ''),
      state: derived.state,
      updatedAt: String(head.updatedAt || ''),
      wait,
      origin: threadOriginOf(head),
      watched: stewardWatchedThread(head, sid, missionId),
    };
    const { updatedAt: _ignored, ...visible } = frame;
    const mission = head.mission && typeof head.mission === 'object' ? head.mission : null;
    const milestones = mission && Array.isArray(mission.milestones) ? mission.milestones : [];
    const sig = JSON.stringify({
      ...visible,
      title: sessionDisplayTitle(head),
      autoMode: mission ? String(mission.autoMode || '') : '',
      result: mission && mission.result ? String(mission.result.status || '') : '',
      acceptance: [milestones.filter(m => m && m.status === 'done').length, milestones.length],   // 行尾「验收 a/b」
    });
    if (onlyIfChanged && eventStreamLastRowSig.get(sid) === sig) return;
    if (eventStreamLastRowSig.size >= EVENT_STREAM_ROW_SIG_MAX && !eventStreamLastRowSig.has(sid)) eventStreamLastRowSig.clear();
    eventStreamLastRowSig.set(sid, sig);
    eventStreamPublish('thread.state', frame);
  } finally {
    eventStreamStateBusy.delete(sid);
    if (eventStreamStateAgain.has(sid)) {
      const again = eventStreamStateAgain.get(sid);
      eventStreamStateAgain.delete(sid);
      void eventStreamEmitThreadState(sid, { onlyIfChanged: again });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// thread.live:活回合的中途动作(§6.3 指标 d「今天永远看不到」)。
// 取的是 04 那份 reg.liveTail —— 同一个累加器、同一份预算,不另攒一套。
// ────────────────────────────────────────────────────────────────────────────
const eventStreamLiveLastAt = new Map();   // sessionId -> ms
function eventStreamPruneLiveTable() {
  if (eventStreamLiveLastAt.size <= EVENT_STREAM_LIVE_SESSIONS_MAX) return;
  const cutoff = eventStreamLiveLastAt.size - EVENT_STREAM_LIVE_SESSIONS_MAX;
  let dropped = 0;
  for (const key of eventStreamLiveLastAt.keys()) {     // Map 按插入序:最早的先走
    eventStreamLiveLastAt.delete(key);
    if (++dropped >= cutoff) break;
  }
}
function eventStreamOnActiveChildEvent(reg, evt) {
  if (!eventStreamClients.size) return;                 // 没人看就不算
  const sid = String((reg && reg.session && reg.session.id) || '');
  if (!sid || eventStreamIsStewardSession(sid)) return;
  const type = String((evt && evt.type) || '');
  if (type !== 'assistant_delta' && type !== 'tool_use' && type !== 'tool_result') return;
  const now = Date.now();
  const last = eventStreamLiveLastAt.get(sid) || 0;
  if (now - last < EVENT_STREAM_LIVE_THROTTLE_MS) return;
  const tail = (reg && reg.liveTail && typeof reg.liveTail === 'object') ? reg.liveTail : null;
  if (!tail) return;
  eventStreamLiveLastAt.set(sid, now);
  eventStreamPruneLiveTable();
  eventStreamPublish('thread.live', {
    sessionId: sid,
    tool: String(tail.tool || ''),
    textTail: String(tail.text || '').slice(-EVENT_STREAM_TEXT_TAIL),
    iterations: Math.max(0, Number(tail.iterations) || 0),
    updatedAt: String(tail.updatedAt || ''),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 订阅(模块加载期装,进程生命周期内不卸)。
// ────────────────────────────────────────────────────────────────────────────
RUYI_EVENTS.subscribe((name, payload) => {
  const data = (payload && typeof payload === 'object') ? payload : {};
  // 128f-⑫:现算那一趟挪到【发事件的那一串同步代码跑完之后】(setImmediate)。修前是当场开读会话头 —— 发事件的人
  // 紧接着若把事件循环占住(同步起子进程之类),那一发读只走完「打开文件」,读与关要等循环回来,句柄就一直开着;
  // Windows 上这期间别的进程把新头 rename 过来会一直 EPERM(session-rewind-gen E 第一轮实测:父进程撤回之后
  // spawnSync 子进程,子进程存盘 8 次重试全撞上)。推迟一拍的代价是这一帧晚一个 tick。
  if (name === 'thread.state') { const sid = data.sessionId; setImmediate(() => { void eventStreamEmitThreadState(sid); }); return; }
  // 128f-⑫:会话头落盘(02 saveSession)—— 只在这一行看得见的东西变了才推(见 eventStreamEmitThreadState 头注)。
  if (name === 'thread.touched') { const sid = data.sessionId; setImmediate(() => { void eventStreamEmitThreadState(sid, { onlyIfChanged: true }); }); return; }
  // 128f-⑫:线程删掉了。修前删除一帧都不派(02 deleteSession),而且就算派了 thread.state,这边读不出会话头也会
  // 丢掉它(上面「会话已删/读不出来」那一支)—— 于是左栏那一行要等下一拍轮询(管家视角 15 s)或用户点别处才消失。
  // 这一帧只带 id:「哪一条没了」就是它的全部事实。
  if (name === 'thread.removed') {
    if (eventStreamIsStewardSession(data.sessionId)) return;
    const sid = safeSessionId(data.sessionId);
    if (!sid) return;
    eventStreamLastRowSig.delete(sid);
    eventStreamPublish('thread.removed', { sessionId: sid });
    return;
  }
  if (name === 'thread.done') {
    if (eventStreamIsStewardSession(data.sessionId)) return;
    eventStreamPublish('thread.done', {
      sessionId: String(data.sessionId || ''),
      summary: String(data.summary || '').slice(0, EVENT_STREAM_SUMMARY_MAX),
    });
    // 收工之后五态也变了(「在跑」→「已收工」/「已停工」),顺手现算一次 —— 指标 b 要的是两件事
    // 同时到:药丸与「它最后说」。
    void eventStreamEmitThreadState(data.sessionId);
    return;
  }
  if (name === 'thread.needs_you') {
    if (eventStreamIsStewardSession(data.sessionId)) return;
    eventStreamPublish('thread.needs_you', {
      sessionId: String(data.sessionId || ''),
      interventionId: String(data.interventionId || ''),
      kind: String(data.kind || ''),
      question: String(data.question || ''),
      options: Array.isArray(data.options) ? data.options.map(o => String(o || '')) : [],
    });
    void eventStreamEmitThreadState(data.sessionId);   // 「等你」计数同时变(指标 c)
    return;
  }
  if (name === 'thread.created' || name === 'thread.adopted') {
    if (eventStreamIsStewardSession(data.sessionId)) return;
    eventStreamPublish(name, {
      sessionId: String(data.sessionId || ''),
      missionId: String(data.missionId || ''),
      title: String(data.title || ''),
    });
    return;
  }
  if (name === 'inbox.appended') {
    // 121-K6a(34 号文 §4.3):安静卡要的最小字段——quiet(在场门②的旗)、needs_you 的 ask/options/
    // answerQuestionId(单问有选项时才有)。任务名不在这里带:前端已经从 /api/missions 那一份行拿到
    // title/来源/色号,再带一份等于第二个数据源(thread-head.js 那套「问左栏要,不裸发第二份」的先例)。
    const frame = { sessionId: String(data.sessionId || ''), kind: String(data.kind || '') };
    // 123-M2:收件箱行号与定时任务 id 两个【标识】(安静卡「稍后」的 sourceRef 要 inboxSeq,
    // 不属于任何线程的 reminder 要 taskId 当卡的身份)。两个都是序号/id,不承载正文。
    if (Number(data.inboxSeq) > 0) frame.inboxSeq = Number(data.inboxSeq);
    if (data.taskId) frame.taskId = String(data.taskId).slice(0, 64);
    if (data.quiet === true) frame.quiet = true;
    if (data.ask) frame.ask = String(data.ask).slice(0, EVENT_STREAM_SUMMARY_MAX);
    if (data.interventionId) frame.interventionId = String(data.interventionId);
    if (data.answerQuestionId) frame.answerQuestionId = String(data.answerQuestionId);
    if (Array.isArray(data.options) && data.options.length) {
      frame.options = data.options.slice(0, 6).map(o => ({
        id: String((o && o.id) || ''),
        label: String((o && o.label) || '').slice(0, 60),
      })).filter(o => o.id && o.label);
    }
    eventStreamPublish('inbox.appended', frame);
    return;
  }
  if (name === 'steward.say') {
    eventStreamPublish('steward.say', { turnSeq: Math.max(0, Number(data.turnSeq) || 0), trigger: String(data.trigger || '') });
    return;
  }
  // 128f-⑪(用户拍板 A「立刻通知你」):管家看过一条权限请求、没替你批,回合结束时它还挂着 —— 留给你了。
  // 只带 id、一句摘要(13i 归一化时就不含入参正文)与截止时刻;§6.1 红线:命令原文不进这条线。
  // 129f(31 号文 §2.4):管家主动叫人。与 steward.deferred 同一条路 —— 服务端只负责「该不该叫」,
  // 「此刻在不在前台、是不是静默时段」由前端那一处判(quiet-card 里本来就有,不在这儿再写第二份)。
  if (name === 'steward.notify') {
    const sid = String((data && data.sessionId) || '');
    eventStreamPublish('steward.notify', {
      sessionId: sid,
      kind: String((data && data.kind) || ''),
      text: String((data && data.text) || ''),
    });
    return;
  }
  if (name === 'steward.deferred') {
    if (eventStreamIsStewardSession(data.sessionId)) return;
    eventStreamPublish('steward.deferred', {
      sessionId: String(data.sessionId || ''),
      interventionId: String(data.interventionId || ''),
      ask: String(data.ask || '').slice(0, EVENT_STREAM_SUMMARY_MAX),
      deadlineAt: String(data.deadlineAt || ''),
    });
    return;
  }
  // 123-M1(37 号文 §3.2「事件」):定时任务变了 —— 建/改/删/四段触发各派一帧。
  // 本文件【只转发】:三个字段全是枚举与 id,标题、载荷正文、结果原文一个字都不进这条线(§6.1 红线①);
  // 前端(M2)据此刷口袋计数、「接下来」两行与设置块,零轮询 —— 正文仍走 GET /api/scheduler/tasks。
  if (name === 'schedule.changed') {
    eventStreamPublish('schedule.changed', {
      taskId: String(data.taskId || ''),
      phase: String(data.phase || ''),
      outcome: String(data.outcome || ''),
    });
    return;
  }
  // 未知事件名:丢弃。总线是开放的,这条线不是 —— 加新事件要在这里显式登记一行。
});
subscribeActiveChildEvents(eventStreamOnActiveChildEvent);

// ────────────────────────────────────────────────────────────────────────────
// 路由。鉴权沿用 01b-route-auth.js 的表(`GET /api/events/stream` = token-browser,与
// `POST /api/chat/stream` 同档);表是权威,handler 不另写一道自查(同 /api/chat/stream)。
// 形态与 handleOverlayApiRoutes / handleStewardApiRoutes 一致:不命中就自然返回让路由链继续
// (不写前缀早退守卫 —— 那会在路由清册里多出一个无鉴权首配的裸前缀判定点)。**命中信号不同**:
// 那两个是 res.writableEnded,本函数命中之后【故意不 end】(SSE 连接要一直开着),所以
// 13-http-router 那一行用的是 `res.headersSent || res.writableEnded`(理由写在那里)。
// ────────────────────────────────────────────────────────────────────────────
async function handleEventStreamApiRoutes(req, res, pathname) {
  // 判定点写成字面量(不是常量引用):route-inventory 的扫描器只认现行写法
  // `req.method === 'X' && pathname === '/api/...'`,写成常量它就扫不到,清册里会多出一条死鉴权行。
  if (!(req.method === 'GET' && pathname === '/api/events/stream')) return;
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const lensRaw = String(query.get('lens') || '');
  const client = {
    res,
    lens: (lensRaw === 'steward' || lensRaw === 'classic') ? lensRaw : '',
    sessionId: safeSessionId(query.get('sessionId') || '') || '',
    at: nowIso(),
    heartbeat: null,
  };
  try { req.socket.setNoDelay(true); } catch { /* ignore */ }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  try { res.flushHeaders(); } catch { /* ignore */ }
  eventStreamClients.add(client);

  // 断线补发:标准 SSE 的 Last-Event-ID 头(EventSource 自动带),另收一个查询参数形态供
  // 自己拼请求的客户端(fetch 流式读)用。环里没有的(断太久)就补不了 —— 兜底轮询接手。
  const lastSeen = Number(req.headers['last-event-id'] || query.get('lastEventId') || 0);
  if (Number.isFinite(lastSeen) && lastSeen > 0) {
    for (const frame of eventStreamRing) if (frame.id > lastSeen) eventStreamWriteFrame(client, frame);
  }
  // 连接私有帧:回显在场参数。不带 id(见 eventStreamRing 头注)。
  eventStreamWriteFrame(client, { id: 0, event: 'presence.ack', data: { lens: client.lens, sessionId: client.sessionId, at: client.at } });

  client.heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch { /* 客户端走了 */ }
  }, EVENT_STREAM_HEARTBEAT_MS);
  if (client.heartbeat && typeof client.heartbeat.unref === 'function') client.heartbeat.unref();

  const drop = () => {
    if (client.heartbeat) { clearInterval(client.heartbeat); client.heartbeat = null; }
    eventStreamClients.delete(client);   // 断连即清 = 在场信号消失(§4.3)
  };
  res.on('close', drop);
  res.on('error', drop);
  req.on('aborted', drop);
  // 故意不 res.end():这条连接要一直开着。于是 res.writableEnded 永远是 false ——
  // 13-http-router 那一行的命中信号写的是 `res.headersSent || res.writableEnded`(理由写在那里)。
}

// 13-http-router.js 只写 `EventStreamHooks.handleApiRoutes`(13 → 00-boot 是既有后向边);
// 直接引用上面那个函数名会是一条新前向边(同 13g 的 StewardHooks 纪律)。
Object.assign(EventStreamHooks, {
  handleApiRoutes: handleEventStreamApiRoutes,
  presenceSnapshot: stewardPresenceSnapshot,
});
