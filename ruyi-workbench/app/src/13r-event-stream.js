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
// ────────────────────────────────────────────────────────────────────────────
const eventStreamStateBusy = new Set();
const eventStreamStateAgain = new Set();
async function eventStreamEmitThreadState(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return;
  if (eventStreamIsStewardSession(sid)) return;
  if (eventStreamStateBusy.has(sid)) { eventStreamStateAgain.add(sid); return; }
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
    eventStreamPublish('thread.state', {
      sessionId: sid,
      missionId: String(sessionMissionId(head) || ''),
      state: derived.state,
      updatedAt: String(head.updatedAt || ''),
      wait,
    });
    // origin / watched 是 K3 的字段(34 号文 §4.1):此刻会话头上还没有它们,**不带**——
    // 现编一个默认值就是造第二份判据。K3 落地后在这里补两个字段即可。
  } finally {
    eventStreamStateBusy.delete(sid);
    if (eventStreamStateAgain.delete(sid)) void eventStreamEmitThreadState(sid);
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
  if (name === 'thread.state') { void eventStreamEmitThreadState(data.sessionId); return; }
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
    eventStreamPublish('inbox.appended', { sessionId: String(data.sessionId || ''), kind: String(data.kind || '') });
    return;
  }
  if (name === 'steward.say') {
    eventStreamPublish('steward.say', { turnSeq: Math.max(0, Number(data.turnSeq) || 0), trigger: String(data.trigger || '') });
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
