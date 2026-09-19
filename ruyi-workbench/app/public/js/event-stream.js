'use strict';

import { apiRaw } from './net.js';

// 第 121 波 K2b（34 号文 §6.2）：事件流客户端。**全仓唯一一条服务端推送连接。**
//
// 为什么不是 `EventSource`（K2a 交付后写进 §6.2 的修正）：`GET /api/events/stream` 在
// `01b-route-auth.js` 里是 `token-browser` 档（与 `POST /api/chat/stream` 同档），要带
// `x-wcw-token` 请求头；`EventSource` 设不了请求头，只能靠 cookie / 查询串带凭据 —— 前者本仓没有，
// 后者等于把 token 写进 URL（会进访问日志、也违背 47c-S1「HTML 不下发 token」那条线）。所以这里走
// `fetch + ReadableStream` 自己按 SSE 规范切帧，与 `chat-stream-runtime.js` 读 `/api/chat/stream`
// 是同一种读法；断线补发的 `Last-Event-ID` 也就得自己记、自己带（`EventSource` 那一半是浏览器做的）。
//
// 三条纪律：
//   ① 请求只走 `net.js` 的 `apiRaw()` —— 它拼鉴权头（`authHeaders`）、并且拿到 403/auth.token_invalid 时
//      换新 token 重放一次。**这一条不是顺手复用**：后台进程在同一端口重启后旧 token 立即失效，
//      裸 fetch 会在退避循环里拿着旧 token 永远 403（117q-B3a 拿看板那一次真 bug 换来的纪律，
//      30 号文 §4.6 P1-6）—— 而推送这条线断了之后四处兜底轮询就是唯一的眼睛，还得靠它自愈。
//      本文件因此不碰 token、不拼第二份头、也不直调 fetch。
//   ② 在场信号（§4.3）只在【连接时】由 `?lens=&sessionId=` 报给服务端（13r 的连接表就是那份快照，
//      **没有第二个写口**）。所以「换视角／换会话」这件事的唯一落实方式是【重连】：去抖 300 ms
//      合并连点，再断开旧连接、带 `Last-Event-ID` 重连。
//   ③ 页面隐藏【不断连】：在场信号要真（用户只是切走标签页，人还在壳里坐着）。真正的收摊信号是
//      `pagehide` —— 那一刻才 abort。
//
// 退避：1 s → 30 s 封顶、每次 ×2、带 ±20% 抖动（多标签页同时掉线时不要在同一毫秒一起回来）。
// 载荷一律当数据看：`data:` 解析失败就丢这一帧，绝不 throw 出去掀翻订阅者。

export const EVENT_STREAM_PATH = '/api/events/stream';
export const EVENT_STREAM_RETRY_MIN_MS = 1000;
export const EVENT_STREAM_RETRY_MAX_MS = 30000;
export const EVENT_STREAM_RETRY_JITTER = 0.2;
// 换视角／换会话的去抖窗口：连点「管家 ↔ 工作台」或快速上下翻会话时只重连一次。
export const EVENT_STREAM_PRESENCE_DEBOUNCE_MS = 300;
// 订阅名：连接状态变化。消费者据此在「30 s 兜底」与「今天的节奏」之间切节拍。
export const EVENT_STREAM_CONNECTION_EVENT = 'connection';
// 「这一行本身变了」的五个事件（§6.1 事件表）。名字收在这里而不是各消费者里各写一遍：它们是
// 与 13r 的显式登记表对拍的【线上契约】，而且散在四个文件里写五个字面量会把看板那几把
// 「五态字面量计数」的锁（B5／M6／N3）撞红 —— 事件名里那个 needs_you 不是五态，别混进那本账。
// 128f-⑫：第六个 thread.removed（线程删掉了；修前删除一帧都不派，管家视角的左栏要等 15 s 那一拍轮询）。
export const EVENT_STREAM_ROW_EVENTS = Object.freeze([
  'thread.state', 'thread.needs_you', 'thread.done', 'thread.created', 'thread.adopted', 'thread.removed',
]);
// 活回合的中途动作（每会话 ≥500 ms 一条，§6.1 节流列）。就地改，不触发任何请求。
export const EVENT_STREAM_LIVE_EVENT = 'thread.live';

// SSE 一帧的解析（纯函数，零 DOM、零状态 —— dev-harness 直接 import 跑真值表）。
// 规范里本帧要用的四种行：`id:`／`event:`／`data:`（可多行，按 \n 拼）／以 `:` 开头的注释行
// （13r 的 `: ping` 心跳走这一支）。字段名后的一个空格是可选的，两种写法都收。
// 返回 null = 这一块不是事件帧（注释块／空块）。
export function parseEventStreamBlock(block) {
  const text = String(block == null ? '' : block);
  if (!text.trim()) return null;
  let id = '';
  let event = '';
  const data = [];
  let sawField = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    if (line.startsWith(':')) continue;                      // 注释行（心跳）
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') { id = value; sawField = true; }
    else if (field === 'event') { event = value; sawField = true; }
    else if (field === 'data') { data.push(value); sawField = true; }
    // 其余字段（retry 等）13r 不发，收到也不认 —— 这条线只登记它真的会来的东西。
  }
  if (!sawField) return null;
  let payload = null;
  if (data.length) { try { payload = JSON.parse(data.join('\n')); } catch { payload = null; } }
  return { id, event, data: payload };
}

export function createEventStream({
  // 在场信号的两个读口（组合根注入：视角读 data-shell-mode，会话读 state.currentSession）。
  lensProvider = () => '',
  sessionIdProvider = () => '',
  // 测试与非浏览器环境的接缝；生产一律走 net.js 的 apiRaw 与全局 document。
  requestImpl = null,
  documentImpl = null,
} = {}) {
  const listeners = new Map();          // event name -> Set<fn>
  let controller = null;                // 当前连接的 AbortController
  let started = false;                  // start() 过、还没 stop()
  let connected = false;
  let lastEventId = '';                 // 只记【带 id】的帧（presence.ack 不带 id，见 13r 的环头注）
  // 122-L1a（36 号文 §2.3；J16）：断线补发的去重水位与「补发段」的门。见 dispatchFrame 头注。
  let lastSeenSeq = 0;                  // 已经派发过的最高帧 id（13r 的 eventStreamSeq 是单调整数）
  let replayWindow = false;             // 本连接是否还在补发段（presence.ack 之前的那一截）
  let replayed = 0;                     // 丢掉的重放帧计数（只读实况，给 e2e 与诊断）
  let retryMs = EVENT_STREAM_RETRY_MIN_MS;
  let retryTimer = 0;
  let presenceTimer = 0;
  let generation = 0;                   // 每次连接一个代号：旧连接的读循环收尾时不许改新连接的状态
  let presenceKey = '';                 // 当前连接自报的 lens|sessionId
  let frames = 0;
  let connects = 0;
  let bound = false;

  const docOf = () => documentImpl || globalThis.document || null;
  const requestOf = () => (typeof requestImpl === 'function' ? requestImpl : apiRaw);

  function emit(name, payload) {
    const set = listeners.get(String(name || ''));
    if (!set || !set.size) return 0;
    let sent = 0;
    // 快照一份再发：订阅者在回调里退订（消费者切壳时会）不许把本次派发搅乱。
    for (const fn of [...set]) {
      try { fn(payload); sent += 1; } catch { /* 一个消费者出错不许掀翻其余消费者 */ }
    }
    return sent;
  }

  function off(name, fn) {
    const set = listeners.get(String(name || ''));
    return set ? set.delete(fn) : false;
  }

  function on(name, fn) {
    if (typeof fn !== 'function') return () => false;
    const key = String(name || '');
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => off(key, fn);
  }

  function setConnected(next) {
    const value = next === true;
    if (value === connected) return false;
    connected = value;
    emit(EVENT_STREAM_CONNECTION_EVENT, { connected });
    return true;
  }

  function presenceOf() {
    let lens = '';
    let sessionId = '';
    try { lens = String(lensProvider() || ''); } catch { lens = ''; }
    try { sessionId = String(sessionIdProvider() || ''); } catch { sessionId = ''; }
    return { lens, sessionId, key: `${lens}|${sessionId}` };
  }

  function urlFor(presence) {
    const params = new URLSearchParams();
    params.set('lens', presence.lens);
    params.set('sessionId', presence.sessionId);
    return `${EVENT_STREAM_PATH}?${params.toString()}`;
  }

  function clearRetry() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = 0;
  }

  // 退避：×2 到 30 s 封顶，落地值带 ±20% 抖动。
  function nextDelayMs() {
    const base = Math.min(EVENT_STREAM_RETRY_MAX_MS, Math.max(EVENT_STREAM_RETRY_MIN_MS, retryMs));
    retryMs = Math.min(EVENT_STREAM_RETRY_MAX_MS, base * 2);
    const jitter = base * EVENT_STREAM_RETRY_JITTER * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  function scheduleReconnect(delayMs) {
    if (!started || retryTimer) return false;
    const wait = Number.isFinite(delayMs) ? Math.max(0, delayMs) : nextDelayMs();
    retryTimer = setTimeout(() => { retryTimer = 0; void connect(); }, wait);
    return true;
  }

  function abortCurrent() {
    if (!controller) return false;
    const gone = controller;
    controller = null;
    try { gone.abort(); } catch { /* 已经没了 */ }
    return true;
  }

  // 一帧到手：先记 Last-Event-ID（只认带 id 的），再派给订阅者。
  //
  // 122-L1a（36 号文 §2.3；J16「SSE 重连重放去重」）：重连时我们把 `Last-Event-ID` 带上去，
  // 13r 就把环里 id 更大的帧【整段重发】一遍。断线那一刻已经派发过的帧因此会再来一次 ——
  // 修前它们照样往下派：多出第二张安静卡、已经回复过的 needs_you 复活、系统通知重响。
  // 去重的水位就是 `lastSeenSeq`（13r 的 id 是单调整数，见它的环头注）。
  //
  // 【为什么只在补发段里当闸门，而不是无条件 `id <= lastSeenSeq 就丢`】：13r 的 `eventStreamSeq`
  // 随进程走，服务重启后从 1 重新数。无条件水位会让「浏览器标签页活过一次服务重启」变成
  // 推送永久失聪（新帧 id 全都小于旧水位），那比本条要修的重复更严重。而重放【只可能】发生在
  // 补发段：13r 的连接处理里，从 `eventStreamClients.add(client)` 到写出 `presence.ack` 那一段
  // 是同步的（中间没有 await），所以补发的帧一定排在本连接的 `presence.ack` 之前，之后的都是
  // 现场直播。于是闸门只开在 presence.ack 之前那一截，重启后第一帧（在 presence.ack 之后）
  // 照常派发并把水位重置回去 —— 自愈。
  function dispatchFrame(frame) {
    if (!frame) return false;
    frames += 1;
    const seq = Number(frame.id || 0);
    if (replayWindow && Number.isFinite(seq) && seq > 0 && seq <= lastSeenSeq) { replayed += 1; return false; }
    // presence.ack 是连接私有帧、不带 id（13r 环头注）：它就是补发段的收尾标记。
    if (frame.event === 'presence.ack') replayWindow = false;
    if (frame.id) { lastEventId = String(frame.id); if (Number.isFinite(seq)) lastSeenSeq = seq; }
    if (!frame.event) return false;
    emit(frame.event, frame.data);
    return true;
  }

  async function readLoop(response, gen) {
    const body = response && response.body;
    if (!body || typeof body.getReader !== 'function') return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (gen !== generation) { try { await reader.cancel(); } catch { /* ignore */ } return; }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      // 帧之间是一个空行。\r\n\r\n 也收（13r 只写 \n\n，但解析器不该对代理改写敏感）。
      for (;;) {
        const lf = buffer.indexOf('\n\n');
        const crlf = buffer.indexOf('\r\n\r\n');
        const cut = lf < 0 ? crlf : (crlf < 0 ? lf : Math.min(lf, crlf));
        if (cut < 0) break;
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + (cut === crlf ? 4 : 2));
        dispatchFrame(parseEventStreamBlock(block));
      }
    }
  }

  async function connect() {
    if (!started) return false;
    clearRetry();
    const request = requestOf();
    if (typeof request !== 'function') return false;
    abortCurrent();
    const gen = ++generation;
    const presence = presenceOf();
    presenceKey = presence.key;
    const ac = new AbortController();
    controller = ac;
    connects += 1;
    let response = null;
    try {
      response = await request(urlFor(presence), {
        method: 'GET',
        // 断线补发：只带【带 id 的】那一帧的位置（presence.ack 不带 id，见 13r 的环头注）。
        // 鉴权头由 apiRaw 内部拼（还带 403 换 token 重放一次）。
        headers: lastEventId ? { 'last-event-id': lastEventId } : {},
        signal: ac.signal,
        cache: 'no-store',
      });
    } catch {
      response = null;                    // 连不上（服务端没起／被掐）：走退避
    }
    if (gen !== generation) return false; // 期间已经被换掉（换视角／stop）
    if (!response || !response.ok) {
      setConnected(false);
      if (controller === ac) controller = null;
      scheduleReconnect();
      return false;
    }
    retryMs = EVENT_STREAM_RETRY_MIN_MS;  // 连上了就把退避打回底
    // 每条新连接都从「补发段」开始：13r 先把 Last-Event-ID 之后的帧重发，再写 presence.ack。
    replayWindow = true;
    setConnected(true);
    try { await readLoop(response, gen); }
    catch { /* 断了：与正常收尾同一条路 */ }
    if (gen !== generation) return true;  // 新连接已经接手，状态归它管
    if (controller === ac) controller = null;
    setConnected(false);
    scheduleReconnect();
    return true;
  }

  // 在场信号变了 → 去抖 300 ms 后重连（服务端没有别的写口，见文件头注 ②）。
  function sync() {
    if (!started) return false;
    const next = presenceOf();
    if (next.key === presenceKey && connected) return false;
    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      presenceTimer = 0;
      if (!started) return;
      const now = presenceOf();
      if (now.key === presenceKey && connected) return;
      retryMs = EVENT_STREAM_RETRY_MIN_MS;
      void connect();
    }, EVENT_STREAM_PRESENCE_DEBOUNCE_MS);
    return true;
  }

  // 视角变化自己看得见（data-shell-mode 是全仓唯一的视角状态源）；换会话没有 DOM 信号，
  // 由组合根在 openSession 之后调 sync()。
  function bind() {
    if (bound) return false;
    const doc = docOf();
    if (!doc) return false;
    bound = true;
    if (globalThis.MutationObserver && doc.documentElement) {
      new globalThis.MutationObserver(() => { sync(); })
        .observe(doc.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    // 页面隐藏【不】断连（在场信号要真）；关页／前进后退缓存才收摊。
    if (globalThis.addEventListener) globalThis.addEventListener('pagehide', () => { stop(); });
    // 治抖动那批（34 号文 §13.6 登记④）：bfcache 冻结不是关页——`pagehide` 上面那行已经
    // `stop()` 过（`started=false`），但 JS 堆原样保留；`pageshow` 恢复时(`event.persisted`
    // 为真)如果什么都不做，`started` 还停在 false，推送这条线就永远死着，只能刷新页面才能救回来。
    // 直接复用既有的 `start()`（内部就是 `bind()`(已绑过，no-op) + `connect()`/退避），不写第二条。
    if (globalThis.addEventListener) globalThis.addEventListener('pageshow', event => {
      if (event && event.persisted) start();
    });
    return true;
  }

  function start() {
    if (started) return false;
    started = true;
    bind();
    void connect();
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    generation += 1;      // 让在飞的读循环收尾时不再改状态、不再重连
    clearRetry();
    if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = 0; }
    abortCurrent();
    presenceKey = '';
    setConnected(false);
    return true;
  }

  // 128f-⑫：页内广播 —— 同一页里一处做完了动作、别的面该跟着刷时用（例：设置里清空管家记忆 → 口袋角标）。
  // 不经服务端、不进断线补发、不推 Last-Event-ID；订阅者与服务端来的同名帧走同一个 emit。
  function publishLocal(name, payload) { return emit(name, payload); }

  return Object.freeze({
    start,
    stop,
    sync,
    on,
    off,
    publishLocal,
    isConnected: () => connected === true,
    // 只读实况（给 e2e 与诊断用；不挂全局、不给写口）。
    stats: () => ({ connected, frames, connects, lastEventId, presenceKey, retryMs, lastSeenSeq, replayed, replayWindow }),
  });
}
