'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notify-policy.js — 「需要你」本地提醒的纯策略层（121 波 K1，34 号文 §8.3 第 2 条）。
//
// 前身是 js/preview-notifications.js（第83波，交办台自带）。交办台退役后这一层不跟着死：
// 管家至今没有本地提醒策略，而去重、免打扰时段、启动先建基线（不补炸历史）这三件事与哪个视角
// 无关。改名搬家（拍板④），存储键随之升为 wcw.notifyPolicy.v1，旧键 wcw.previewNeedsNotifications.v1
// 只在新键缺席时读一次并迁移，用户已经调好的免打扰时段不丢。
//
// 边界：本文件只做状态转移，不碰 DOM、不发通知、不拉接口。真正把「谁该被提醒」喂进来、
// 把 notify/close 变成系统通知的适配器归 K6 的安静卡（§4.3）；本刀先把策略层与它的单测立住。
// 双导出（ESM 命名导出 + 供 e2e 直接 import()）与 mission-state.js 的 UMD 不同：这一层没有任何
// 浏览器全局消费者，不需要挂 window。
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFY_POLICY_STORAGE_KEY = 'wcw.notifyPolicy.v1';
// 交办台时代的键。只读、只迁移一次，永不再写。
export const LEGACY_NOTIFY_STORAGE_KEY = 'wcw.previewNeedsNotifications.v1';
export const DEFAULT_NOTIFY_SETTINGS = Object.freeze({ version: 1, enabled: false, quietStart: '22:00', quietEnd: '08:00' });

function validClock(value, fallback) {
  const text = String(value || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return fallback;
  return text;
}

export function normalizeNotifySettings(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    version: 1,
    enabled: source.enabled === true,
    quietStart: validClock(source.quietStart, DEFAULT_NOTIFY_SETTINGS.quietStart),
    quietEnd: validClock(source.quietEnd, DEFAULT_NOTIFY_SETTINGS.quietEnd),
  };
}

// 新键缺席时读一次旧键并就地迁移（写新键、删旧键）。迁移是尽力而为：storage 不可用时
// 退回默认设置，绝不抛。
export function readNotifySettings(storage = globalThis.localStorage) {
  try {
    const fresh = storage?.getItem(NOTIFY_POLICY_STORAGE_KEY);
    if (fresh != null) return normalizeNotifySettings(fresh);
    const legacy = storage?.getItem(LEGACY_NOTIFY_STORAGE_KEY);
    if (legacy == null) return normalizeNotifySettings(null);
    const migrated = normalizeNotifySettings(legacy);
    try {
      storage?.setItem(NOTIFY_POLICY_STORAGE_KEY, JSON.stringify(migrated));
      storage?.removeItem(LEGACY_NOTIFY_STORAGE_KEY);
    } catch { /* migration is best-effort */ }
    return migrated;
  } catch { return normalizeNotifySettings(null); }
}

export function writeNotifySettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeNotifySettings(settings);
  try { storage?.setItem(NOTIFY_POLICY_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* local preference is best-effort */ }
  return normalized;
}

function clockMinutes(value) {
  const [hours, minutes] = validClock(value, '00:00').split(':').map(Number);
  return hours * 60 + minutes;
}

// 开始时刻含、结束时刻不含；跨午夜和同日时段都可预测。起止相同表示不设免打扰。
export function isQuietTime(date, settings) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  const normalized = normalizeNotifySettings(settings);
  const start = clockMinutes(normalized.quietStart);
  const end = clockMinutes(normalized.quietEnd);
  if (start === end) return false;
  const now = value.getHours() * 60 + value.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '')).filter(Boolean))];
}

export function normalizeNotifyState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    primed: source.primed === true,
    known: uniqueIds(source.known).slice(-1000),
    active: uniqueIds(source.active).slice(-1000),
  };
}

// 一次状态转移：拿上一次的协调状态 + 这一刻的待决 id 表，算出该新提醒谁、该撤回谁。
// primed:false 是「启动第一拍」——只建基线，一条都不炸（历史待决不该在开机时集体弹出来）。
export function reconcileNotifications(previous, pendingIds, context = {}) {
  const state = normalizeNotifyState(previous);
  const pending = uniqueIds(pendingIds).slice(-1000);
  const pendingSet = new Set(pending);
  const known = new Set(state.known);
  const enabled = context.enabled === true;
  const permitted = context.permission === 'granted';
  const quiet = context.quiet === true;

  let close = state.active.filter(id => !pendingSet.has(id));
  if (!enabled || !permitted) close = uniqueIds(close.concat(state.active));

  if (!state.primed) {
    for (const id of pending) known.add(id);
    return {
      state: { primed: true, known: [...known].slice(-1000), active: [] },
      notify: [], close: uniqueIds(state.active),
    };
  }

  const fresh = pending.filter(id => !known.has(id));
  for (const id of pending) known.add(id);
  const notify = enabled && permitted && !quiet ? fresh : [];
  const closed = new Set(close);
  const active = state.active.filter(id => pendingSet.has(id) && !closed.has(id));
  for (const id of notify) if (!active.includes(id)) active.push(id);
  return {
    state: { primed: true, known: [...known].slice(-1000), active: active.slice(-1000) },
    notify,
    close,
  };
}

// ── 设置块（「提醒」）的绑定：只管本机偏好的读写与系统通知授权，不发通知 ────────────────
// 提醒的【投递】（谁进待决表、什么时候弹）随交办台一起退役，K6 的安静卡把它接回来。
// 这里保留设置块是为了让用户已经调好的开关与免打扰时段在退役期间不丢、也不需要重新发明控件。
export function bindNotifySettings({
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  notificationApi = globalThis.Notification,
  t = key => key,
} = {}) {
  const byId = id => {
    try { return documentRef?.getElementById(id) || null; } catch { return null; }
  };
  let settings = readNotifySettings(storage);

  function permission() {
    // 桌面壳（WebView2）自带托盘通道，权限恒为已授予。
    if (globalThis.__ruyiDesktop === 1 && globalThis.chrome?.webview
      && typeof globalThis.chrome.webview.postMessage === 'function') return 'granted';
    return notificationApi && typeof notificationApi.permission === 'string' ? notificationApi.permission : 'unsupported';
  }

  function statusText() {
    const granted = permission();
    if (granted === 'unsupported') return t('notify.unsupported');
    if (granted === 'denied') return t('notify.denied');
    if (!settings.enabled) return t('notify.off');
    return t('notify.on', { p1: settings.quietStart, p2: settings.quietEnd });
  }

  function syncControls() {
    const toggle = byId('cfgNotifyEnabled');
    const start = byId('cfgNotifyQuietStart');
    const end = byId('cfgNotifyQuietEnd');
    const status = byId('notifyStatus');
    if (toggle) {
      toggle.checked = settings.enabled;
      toggle.disabled = permission() === 'unsupported';
    }
    if (start) start.value = settings.quietStart;
    if (end) end.value = settings.quietEnd;
    if (status) status.textContent = statusText();
  }

  function save(patch) {
    settings = writeNotifySettings({ ...settings, ...(patch || {}) }, storage);
    syncControls();
    return settings;
  }

  const toggle = byId('cfgNotifyEnabled');
  if (toggle) {
    toggle.onchange = async event => {
      if (!event.target.checked) { save({ enabled: false }); return; }
      let granted = permission();
      if (granted === 'default' && notificationApi && typeof notificationApi.requestPermission === 'function') {
        try { granted = await notificationApi.requestPermission(); } catch { granted = 'denied'; }
      }
      save({ enabled: granted === 'granted' });
    };
  }
  const start = byId('cfgNotifyQuietStart');
  if (start) start.onchange = event => save({ quietStart: event.target.value });
  const end = byId('cfgNotifyQuietEnd');
  if (end) end.onchange = event => save({ quietEnd: event.target.value });
  syncControls();
  return settings;
}
