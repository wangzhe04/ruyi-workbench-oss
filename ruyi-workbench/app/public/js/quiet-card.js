'use strict';

import { byId, doc, el, clear } from './steward-chips.js';
import { icon } from './icons.js';
import { stewardThreadHueFor } from './steward-conversation.js';
import { isQuietTime, readNotifySettings } from './notify-policy.js';

// ─────────────────────────────────────────────────────────────────────────────
// quiet-card.js — 安静卡（121 波 K6a，34 号文 §4.3「在场信号与打扰纪律」／§2.6）。
//
// 工作台里管家的唯一打扰形态：用户在工作台、坐在【别的】线程上时，管家开的（或被交给管家盯的）
// 线程有事要说，右下角起一张卡——不弹窗、不切视角、不抢焦点（本体 aria-live="polite"，按钮可
// Tab 到但不自动 focus，见 mount() 里【没有】任何 .focus() 调用）。
//
// 数据源：src/13i-steward-inbox.js 的在场门已经把「要不要出卡」判完（②情形打 payload.quiet:true），
// 本文件【只消费】事件流的 inbox.appended 帧（quiet／ask／options／interventionId／answerQuestionId），
// 不重新判一次在场——但仍在客户端补两条属于渲染层、不属于在场门的规则：
//   · 视角必须是工作台（data-shell-mode==='classic'）——管家视角下服务端在场门③已经不会给这类
//     事件打 quiet，这里只是双保险，不新起第二套判据；
//   · 静默时段（js/notify-policy.js 的 quietStart／quietEnd）——不出卡，只让左栏（已经在吃
//     thread.needs_you／thread.state 那几路推送）照常更新。
//
// 去重／基线／静默三件事全部问 notify-policy.js 要（isQuietTime 直接复用）；系统通知的「去重」
// 没有套用它的 reconcileNotifications——那份 API 是为轮询快照设计的（每一拍给「当前完整待决集合」，
// 靠 primed 基线避免启动时把历史积压一次性炸出来）。安静卡是纯事件驱动：每一帧都是刚刚发生的
// 新鲜事（13i 自己的 30s 合并窗 + 本文件的 5 分钟同线程同类合并已经把重复摊平成一次「新建」），
// 不存在「启动时的历史积压」——所以系统通知按「只在新建卡片那一刻发一次」去重，足够、且不必再引入
// 第二套为快照设计的状态机。
// ─────────────────────────────────────────────────────────────────────────────

export const QUIET_CARD_MERGE_WINDOW_MS = 5 * 60 * 1000; // §4.3：5 分钟同线程同类合并成一张
export const QUIET_CARD_HOST_ID = 'quietCardHost';
// done 永不出卡（§4.3 明说）；服务端的在场门②本来就不会给 done 打 quiet:true，这里再挡一次
// 双保险——反向验证（拔掉这道过滤）在 quiet-card.browser.e2e.js 里钉。
// 123-M2（37 号文 §3.5）：第五类 reminder —— 定时任务到点／错过跳过／连败熔断。它与前四类的
// 不同在于**它可以不属于任何一条线程**：「明天九点提醒我交周报」那条 reminder 没有 sessionId，
// 而前四类恒有（它们都在说某条线程怎么样了）。所以下面 isEligible 对它松一格，卡的身份改用
// quietCardIdentity（无线程时退到 taskId）。
export const QUIET_CARD_KINDS = Object.freeze(['needs_you', 'failed', 'stalled', 'budget', 'reminder']);

export function quietCardKey(sessionId, kind) {
  return `${String(sessionId || '')}|${String(kind || '')}`;
}
// 一张卡的身份：有线程就是线程，没有线程（只可能是 reminder）就是那条定时任务。
// **不能只用 kind**：那样两条不同的提醒会互相合并成一张，第二条的正文把第一条顶掉。
export function quietCardIdentity(frame) {
  const sessionId = String((frame && frame.sessionId) || '');
  if (sessionId) return sessionId;
  const taskId = String((frame && frame.taskId) || '');
  return taskId ? `task:${taskId}` : '';
}

// needs_you 印问句前 22 字；failed/stalled/budget 印一句事实（同一个 ask 字段，见 13i 头注）。
export function quietCardHeadline(kind, ask) {
  const text = String(ask || '').trim();
  if (!text) return '';
  return kind === 'needs_you' && text.length > 22 ? text.slice(0, 22) + '…' : text;
}

export function createQuietCard({
  t = key => key,
  state = null,
  api = async () => null,
  // 当前视角：唯一状态源是 documentElement 的 data-shell-mode（js/shell-mode.js 写），本文件不
  // 缓存第二份、只读。
  shellModeOf = () => { const d = doc(); return d ? String(d.documentElement.dataset.shellMode || '') : ''; },
  // 左栏已经取回来的那一行（GET /api/missions）——问它要任务名与色号，不裸发第二份（thread-head.js
  // 同一手法：missionRowOf 由 steward-shell.js 迟绑定到 board.missionRowFor）。
  missionRowOf = () => null,
  // 「去看」＝换焦点／选中该会话，不切视角（安静卡只在工作台出现，本来就不需要切）。
  openSession = async () => {},
  notifySettingsOf = () => readNotifySettings(),
  notificationApi = globalThis.Notification,
  now = () => Date.now(),
} = {}) {
  const cards = new Map(); // key -> { node, sessionId, kind, count, updatedAt, frame }
  const notified = new Set(); // 已经发过系统通知的 key（同一张卡合并更新期间不再发第二次）

  function host() {
    return byId(QUIET_CARD_HOST_ID);
  }
  function currentSessionId() {
    return state && state.currentSession ? String(state.currentSession.id || '') : '';
  }
  function notificationPermission() {
    if (globalThis.__ruyiDesktop === 1 && globalThis.chrome?.webview
      && typeof globalThis.chrome.webview.postMessage === 'function') return 'granted';
    return notificationApi && typeof notificationApi.permission === 'string' ? notificationApi.permission : 'unsupported';
  }

  function isEligible(frame) {
    if (!frame || frame.quiet !== true) return false;
    if (!QUIET_CARD_KINDS.includes(String(frame.kind || ''))) return false;
    const sessionId = String(frame.sessionId || '');
    // 123-M2：reminder 允许没有线程（「九点提醒我交周报」不属于任何线程），但仍要有一个身份
    // ——否则两条提醒会合并成一张。其余四类必须有 sessionId（它们讲的就是某条线程的事）。
    if (!quietCardIdentity(frame)) return false;
    if (!sessionId && String(frame.kind || '') !== 'reminder') return false;
    if (shellModeOf() !== 'classic') return false;          // 只在工作台
    if (sessionId && sessionId === currentSessionId()) return false; // 不是当前坐着的那条（双保险）
    return true;
  }

  function removeCard(key) {
    const entry = cards.get(key);
    if (!entry) return false;
    try { entry.node.remove(); } catch { /* 已经不在树上 */ }
    cards.delete(key);
    notified.delete(key);
    return true;
  }

  function dismissStale() {
    const cutoff = now() - QUIET_CARD_MERGE_WINDOW_MS;
    for (const [key, entry] of cards) if (entry.updatedAt < cutoff) removeCard(key);
  }

  async function answerOption(entry, option) {
    const frame = entry.frame;
    if (!frame || !frame.interventionId || !frame.answerQuestionId || !option || !option.id) return null;
    try {
      const response = await api('/api/chat/answer', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: frame.sessionId,
          questionId: frame.interventionId,
          answers: [{ questionId: frame.answerQuestionId, selectedOptionIds: [option.id] }],
        }),
      });
      if (response && response.ok === true) removeCard(entry.key);
      return response;
    } catch { return null; }
  }

  function buildActions(entry) {
    const wrap = el('div', 'quiet-card-actions');
    const frame = entry.frame;
    // 候选答案（needs_you 有 options 时）。
    if (frame.kind === 'needs_you' && Array.isArray(frame.options) && frame.options.length) {
      for (const option of frame.options.slice(0, 4)) {
        const button = el('button', 'quiet-card-btn quiet-card-btn-option', option.label);
        button.type = 'button';
        button.onclick = () => { void answerOption(entry, option); };
        wrap.appendChild(button);
      }
    }
    // 「去看」只在真有线程可看时才画（123-M2：不属于任何线程的 reminder 没有落点，
    // 画一枚按下去什么都不发生的按钮比不画更糟）。
    if (entry.sessionId) {
      const goButton = el('button', 'quiet-card-btn quiet-card-btn-go', t('quietCard.go'));
      goButton.type = 'button';
      goButton.onclick = () => { void openSession(entry.sessionId); removeCard(entry.key); };
      wrap.appendChild(goButton);
    }
    const laterButton = el('button', 'quiet-card-btn quiet-card-btn-later', t('quietCard.later'));
    laterButton.type = 'button';
    laterButton.onclick = () => removeCard(entry.key);
    wrap.appendChild(laterButton);
    return wrap;
  }

  function renderInto(entry) {
    const node = entry.node;
    clear(node);
    const dot = el('span', 'quiet-card-dot');
    dot.dataset.threadHue = String(stewardThreadHueFor(entry.sessionId));
    node.appendChild(dot);
    const body = el('div', 'quiet-card-body');
    const row = missionRowOf(entry.sessionId) || {};
    const title = String(row.missionTitle || row.title || '').trim();
    if (title) body.appendChild(el('div', 'quiet-card-title', title));
    const line = el('div', 'quiet-card-line', quietCardHeadline(entry.kind, entry.frame && entry.frame.ask));
    if (entry.count > 1) {
      const countBadge = el('span', 'quiet-card-count', String(entry.count));
      line.appendChild(countBadge);
    }
    body.appendChild(line);
    body.appendChild(buildActions(entry));
    node.appendChild(body);
    const closeButton = el('button', 'quiet-card-close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', t('quietCard.later'));
    closeButton.title = t('quietCard.later');
    const closeGlyph = icon('close', 13);
    if (closeGlyph) closeButton.appendChild(closeGlyph);
    closeButton.onclick = () => removeCard(entry.key);
    node.appendChild(closeButton);
  }

  function buildCard(entry) {
    const node = el('div', 'quiet-card');
    node.dataset.sessionId = entry.sessionId;
    node.dataset.kind = entry.kind;
    node.setAttribute('role', 'status');
    // 不抢焦点：卡片本体只报告，不代表交互式控件——aria-live 让读屏在下一次空闲时念出，
    // 不用 alert/assertive 打断用户正在做的事（F5a 纪律：图标永不作为唯一信号，文案永远同时在场）。
    node.setAttribute('aria-live', 'polite');
    entry.node = node;
    return node;
  }

  function maybeNotify(entry) {
    if (notified.has(entry.key)) return;
    notified.add(entry.key);
    const settings = notifySettingsOf();
    if (settings.enabled !== true) return;
    if (notificationPermission() !== 'granted') return;
    if (typeof notificationApi !== 'function') return;
    const row = missionRowOf(entry.sessionId) || {};
    const title = String(row.missionTitle || row.title || t('quietCard.fallbackTitle'));
    const body = quietCardHeadline(entry.kind, entry.frame && entry.frame.ask);
    try { new notificationApi(title, { body, tag: entry.key }); } catch { /* 通知失败不影响卡片 */ }
  }

  function upsert(frame) {
    dismissStale();
    const key = quietCardKey(quietCardIdentity(frame), frame.kind);
    const existing = cards.get(key);
    const nowMs = now();
    if (existing && (nowMs - existing.updatedAt) <= QUIET_CARD_MERGE_WINDOW_MS) {
      existing.count += 1;
      existing.updatedAt = nowMs;
      existing.frame = frame;
      renderInto(existing);
      return existing;
    }
    if (existing) removeCard(key);
    const entry = { key, sessionId: String(frame.sessionId || ''), kind: String(frame.kind || ''), count: 1, updatedAt: nowMs, frame, node: null };
    buildCard(entry);
    renderInto(entry);
    const h = host();
    if (h) h.appendChild(entry.node);
    cards.set(key, entry);
    maybeNotify(entry);
    return entry;
  }

  function onFrame(frame) {
    if (!isEligible(frame)) return;
    // 静默时段（§4.3）：不出卡，只更新左栏——左栏已经在吃 thread.needs_you／thread.state 那几路
    // 推送（K2b 交付），本文件什么都不用做就是「只更新左栏」。
    if (isQuietTime(new Date(now()), notifySettingsOf())) return;
    upsert(frame);
  }

  function bind(eventStream) {
    if (!eventStream || typeof eventStream.on !== 'function') return false;
    eventStream.on('inbox.appended', onFrame);
    return true;
  }

  return Object.freeze({
    bind,
    onFrame,
    // 供真夹具直接断言（不必去解析 DOM 文案）：当前有几张卡、某张卡的原始帧是什么。
    cardCount: () => cards.size,
    cardFor: sessionId => {
      for (const entry of cards.values()) if (entry.sessionId === String(sessionId || '')) return entry;
      return null;
    },
  });
}
