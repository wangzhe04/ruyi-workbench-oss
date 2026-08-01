'use strict';

// 第83波：本地「需要你」通知的纯策略层。浏览器 Notification 只是适配器；去重、免打扰、
// 终态撤回与“启动先建基线、不补炸历史”均在可由 Node e2e 直接验证的状态转移中完成。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PreviewNotifications = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const STORAGE_KEY = 'wcw.previewNeedsNotifications.v1';
  const DEFAULT_SETTINGS = Object.freeze({ version: 1, enabled: false, quietStart: '22:00', quietEnd: '08:00' });

  function validClock(value, fallback) {
    const text = String(value || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return fallback;
    return text;
  }

  function normalizeNotificationSettings(value) {
    let source = value;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch { source = null; }
    }
    source = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return {
      version: 1,
      enabled: source.enabled === true,
      quietStart: validClock(source.quietStart, DEFAULT_SETTINGS.quietStart),
      quietEnd: validClock(source.quietEnd, DEFAULT_SETTINGS.quietEnd),
    };
  }

  function readNotificationSettings(storage = globalThis.localStorage) {
    try { return normalizeNotificationSettings(storage?.getItem(STORAGE_KEY)); }
    catch { return normalizeNotificationSettings(null); }
  }

  function writeNotificationSettings(settings, storage = globalThis.localStorage) {
    const normalized = normalizeNotificationSettings(settings);
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* local preference is best-effort */ }
    return normalized;
  }

  function clockMinutes(value) {
    const [hours, minutes] = validClock(value, '00:00').split(':').map(Number);
    return hours * 60 + minutes;
  }

  // 开始时刻含、结束时刻不含；跨午夜和同日时段都可预测。起止相同表示不设免打扰。
  function isQuietTime(date, settings) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return false;
    const normalized = normalizeNotificationSettings(settings);
    const start = clockMinutes(normalized.quietStart);
    const end = clockMinutes(normalized.quietEnd);
    if (start === end) return false;
    const now = value.getHours() * 60 + value.getMinutes();
    return start < end ? now >= start && now < end : now >= start || now < end;
  }

  function uniqueIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '')).filter(Boolean))];
  }

  function normalizeCoordinatorState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      primed: source.primed === true,
      known: uniqueIds(source.known).slice(-1000),
      active: uniqueIds(source.active).slice(-1000),
    };
  }

  function reconcileNeedsNotifications(previous, pendingIds, context = {}) {
    const state = normalizeCoordinatorState(previous);
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

  return {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    normalizeNotificationSettings,
    readNotificationSettings,
    writeNotificationSettings,
    isQuietTime,
    normalizeCoordinatorState,
    reconcileNeedsNotifications,
  };
});
