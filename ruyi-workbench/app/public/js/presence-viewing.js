'use strict';

// presence-viewing.js —— 「用户此刻正看着哪几条线程的提问／权限」（2026-10，用户：「如果用户在看提问、权限，
// 管家被立刻唤醒也不要插手」）。
//
// 智能自动下待决一产生，服务端就会提前叫醒管家（13i stewardScheduleWake）。可如果那道权限／提问这会儿正摆在
// 用户面前、用户也在跟前，管家抢先替他点掉，就是当着他的面插手。这里判出那几条线程，经事件流的在场信号
// （`?viewing=`，见 event-stream.js 与 13r）报给服务端；服务端的在场门把它们的待决【扣住】、代批工具拒绝动手，
// 用户收起弹窗或人走开，再交还管家。
//
// 「看着」= 候选线程（由组合根给：开着的权限/提问弹窗、展开的待办小窗、管家焦点栏里有待决的那一条）
//          且 用户在跟前：页面可见、窗口有焦点、近 VIEWING_IDLE_MS 内有过键鼠操作。
// 第二个条件是故意的：弹窗会在没人碰的时候自己弹出来（prompt-queue 的 pump），用户不在电脑前时
// 那并不是「在看」—— 那种时候正该让管家接手，所以人一走开（无操作超过一分钟）就不再报。
//
// 只读 DOM 事件、不发请求；变了只调 onChange（组合根接 eventStream.sync()，由它去抖重连）。

export const VIEWING_IDLE_MS = 60000;
export const VIEWING_MAX = 8;
export const VIEWING_RECHECK_MS = 10000;

// 纯函数：候选 → 规范化的线程 id 列表（去空、去重、排序、封顶）。
export function normalizeViewing(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))].sort();
  return list.slice(0, VIEWING_MAX);
}

// 纯函数：人在不在跟前。
export function userAttending({ visible, focused, lastInputAt, nowMs }) {
  return visible === true && focused === true && Number(nowMs) - Number(lastInputAt) <= VIEWING_IDLE_MS;
}

export function createViewingTracker({
  candidates = () => [],
  onChange = () => {},
  now = () => Date.now(),
  doc = () => globalThis.document || null,
  win = () => globalThis.window || null,
} = {}) {
  let lastInputAt = now();   // 页面刚打开 = 人刚来过
  let lastKey = '';
  let timer = null;

  function attending() {
    const d = doc();
    if (!d) return false;
    let focused = true;
    try { focused = typeof d.hasFocus === 'function' ? d.hasFocus() : true; } catch { focused = false; }
    return userAttending({ visible: d.visibilityState !== 'hidden' && !d.hidden, focused, lastInputAt, nowMs: now() });
  }

  function current() {
    if (!attending()) return [];
    let ids = [];
    try { ids = candidates(); } catch { ids = []; }
    return normalizeViewing(ids);
  }

  // 「人走开了」（一分钟无操作）没有 DOM 事件，只能隔一会儿看一眼 —— 但只在【正报着 viewing】时才看：
  // 没东西摆在面前就不留任何计时器（零后台活动）。
  function armRecheck(need) {
    if (need && !timer) {
      timer = setInterval(check, VIEWING_RECHECK_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } else if (!need && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function check() {
    const key = current().join(',');
    armRecheck(key !== '');
    if (key === lastKey) return false;
    lastKey = key;
    try { onChange(); } catch { /* 在场信号是旁路，不许掀翻调用方 */ }
    return true;
  }

  function markInput() { lastInputAt = now(); }
  // 点按／键入往往紧跟着「打开了什么」（弹窗、焦点栏）—— 那是在本次事件的处理器里才发生的，这一刻还看不见，
  // 所以过一小会儿再判一次（同时最多挂一个）。
  let lateTimer = null;
  function markInputAndCheck() {
    markInput();
    check();
    if (lateTimer) return;
    lateTimer = setTimeout(() => { lateTimer = null; check(); }, 400);
    if (lateTimer && typeof lateTimer.unref === 'function') lateTimer.unref();
  }

  function start() {
    const d = doc();
    const w = win();
    try {
      if (d) {
        // pointermove 只记时刻（太密，不逐次判）；点按与键入顺手判一次（打开／关掉弹窗多半紧跟着它们）。
        d.addEventListener('pointermove', markInput, { capture: true, passive: true });
        d.addEventListener('wheel', markInput, { capture: true, passive: true });
        d.addEventListener('pointerdown', markInputAndCheck, true);
        d.addEventListener('keydown', markInputAndCheck, true);
        d.addEventListener('visibilitychange', check);
      }
      if (w) {
        w.addEventListener('focus', check);
        w.addEventListener('blur', check);
      }
    } catch { /* 无 DOM 的测试环境 */ }
    check();
    return true;
  }

  return Object.freeze({ current, check, start, attending });
}
