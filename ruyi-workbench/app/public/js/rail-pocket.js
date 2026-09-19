'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// rail-pocket.js — 左栏栏底的「口袋」（121 波 K7，34 号文 §2.3 末段／§7.2／§7.3）。
//
// §2.3 原话：「口袋（栏底，常驻，取代头像菜单）：定时任务（带数量）、行动流水、记得的关于你
// （新写入 24h 带「新」）、体检 · 用量（**不带金额**）。这四样今天藏在头像菜单里，用户找不到
// —— 这就是『稀疏但没功能』的另一半。」
//
// 这片叶子只做三件事，一件都不多：
//   ① 画四枚按钮（图标 ＋ 短词 ＋ 可选的小计数／角标）。字形全部取自 icons.js 的 ICONS 表
//      （K8 已备好 originSchedule／ledger／memory／stethoscope 四枚），本文件零 SVG 路径字面量。
//   ② 点一下 → deep link 到那一样东西真正住的面板。deep link 的两条路都是【注入】进来的：
//      管家的三样走 openStewardPanel(section)（steward-settings.js 的 openPanel，切「管家」页签
//      并把对应 <section> 滚进视野）；「体检 · 用量」两视角两条路（见 RAIL_POCKET_ITEMS 头注）。
//      本模块不认识任何一个设置页 id，也不自己开弹层。
//   ③ 两枚数据信号，各只有一处判据：
//      · 定时任务的数量 —— GET /api/scheduler/tasks（119 波的读面）；
//      · 「记得的关于你」的「新」—— GET /api/steward/memory 的 counts.isNew（**24 小时窗口那条
//        判据在服务端 13g stewardMemoryPanelRow 一处**，客户端不再算第二遍）；
//      · 「体检」的待办计数读的是【已经在手里的】state.status.health（health-i18n.js 的
//        healthSummaryText 一处判据，与设置按钮上那枚红点同源）—— 零新增请求。
//
// 三条纪律（K2b／K4 立的，本刀照办）：
//   · **零计时器**：本文件一个 setInterval／setTimeout 都没有（静态锁看住）。数据靠「打开时刷一次
//     ＋ 推送帧到达时刷一次 ＋ 点自己那一下之后刷一次」，不加第二条轮询。
//   · **零金额**（§7.2 那条红线）：四枚按钮的文本与 title 一律**不带金额**；「体检 · 用量」
//     只是【入口】，数目字住在右栏「用量」页签与体检页里（本文件在那把静态锁的扫描清单上）。
//   · **零 innerHTML**：全部 createElement ＋ textContent。
//
// ≤980（§7.3）：左栏折成 56px 图标栏时口袋只剩图标 —— DOM 一个节点不少，收起来的是样式层
// （css/layout.css 那一档里把 .rail-pocket-label／-n／-new 收掉）。
// ─────────────────────────────────────────────────────────────────────────────

import { icon } from './icons.js';
// 体检待办的计数与色调：与「设置」按钮上那枚 .health-entry-dot 同一份判据（provider-settings.js
// 用的就是这两个导出），本文件不数第二遍，也不发第二发请求。
import { healthSummaryText, HEALTH_ALIAS_IDS } from './health-i18n.js';

// 口袋四项。顺序即屏幕上的顺序（§2.3 的原文顺序，别重排）。
//   icon    —— icons.js 的字形名（§2.10.1 尺寸阶梯：口袋 14px）
//   labelKey—— 短词（≤4 字优先，§2.10.4）
//   panel   —— openStewardPanel(section) 的 section 名；'' = 不走管家设置页（见 doctor 那一条）
// 「体检 · 用量」两视角两条路（§7.2 表末行「口袋入口（不带金额）→ 右栏『用量』页签」）：
//   · 工作台视角 → 右栏「用量」页签（openUsage：openToolPane() + switchTab('usage')）；
//   · 管家视角   → 设置的「体检」页（openDoctor：设置弹层 + switchSettingsTab('doctor')）——
//     管家视角没有右栏页签，把用户丢进一个他此刻看不见的面是假入口。
export const RAIL_POCKET_ITEMS = Object.freeze([
  Object.freeze({ id: 'schedule', icon: 'originSchedule', labelKey: 'rail.pocket.schedule', panel: 'schedule' }),
  Object.freeze({ id: 'decisions', icon: 'ledger', labelKey: 'rail.pocket.decisions', panel: 'decisions' }),
  Object.freeze({ id: 'memory', icon: 'memory', labelKey: 'rail.pocket.memory', panel: 'memory' }),
  Object.freeze({ id: 'doctor', icon: 'stethoscope', labelKey: 'rail.pocket.doctor', panel: '' }),
]);
export const RAIL_POCKET_ICON_SIZE = 14;   // §2.10.1 尺寸阶梯最后一行

// 119 波定时任务的读面。**今天没有生产者**（§13.5 原话：「'schedule' 今天无生产者（119 波零实现），
// 只留判据」），所以这条路由此刻是 404 —— 读不到就当零条：计数不印、焦点栏「接下来」整段不画。
// 这是【前向兼容的读法】，不是占位：119 波落地那天后端一上线，这里一个字都不用改。
export const SCHEDULE_TASKS_PATH = '/api/scheduler/tasks';
export const STEWARD_MEMORY_PATH = '/api/steward/memory';
// 焦点栏「接下来」印几条（§2.6「定时任务最近两条」）。
export const UP_NEXT_LIMIT = 2;

function asArray(value) { return Array.isArray(value) ? value : []; }

// 后端还没落地，所以读法要宽：整包可能是 {ok,tasks:[…]}／{tasks:[…]}／裸数组；每条任务的
// 「下次触发」在 119 的设计稿里叫 nextRunAt，这里同时认 nextRun／nextAt 两个同义名。
// 认不出名字或认不出时间的条目【丢掉】—— 印一行「未知任务 · 未知时间」比不印更糟。
export function normalizeScheduleTasks(payload) {
  const raw = Array.isArray(payload) ? payload
    : asArray(payload && (payload.tasks || payload.rows || payload.items));
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || item.title || item.label || '').trim();
    const at = Date.parse(String(item.nextRunAt || item.nextRun || item.nextAt || ''));
    if (!name || !Number.isFinite(at)) continue;
    out.push({ id: String(item.id || name), name, nextRunAt: at, enabled: item.enabled !== false });
  }
  return out;
}

// 「接下来」取哪两条：**开着的**、下次触发【还没到】的，按下次触发时间升序取前 N 条。
// 纯函数、零 DOM —— unit 真值表直接跑它。
export function upcomingSchedules(tasks, limit = UP_NEXT_LIMIT, nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const cap = Math.max(0, Number(limit) || 0);
  return asArray(tasks)
    .filter(task => task && task.enabled !== false && Number.isFinite(task.nextRunAt) && task.nextRunAt >= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, cap);
}

// 「多久之后」的 (value, unit) 两个数。它是 steward-conversation.js 的 stewardAgoParts 的镜像
// ——那一支【按设计拒绝未来时刻】（`at > now + 60000` 一律回 null），所以这里不是第二份实现，
// 是它够不着的那一半。人话同样交给 Intl.RelativeTimeFormat 说（零新增 i18n 键）。
export function scheduleWhenParts(atMs, nowMs = Date.now()) {
  const at = Number(atMs);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(at) || at < now - 60000) return null;
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  if (seconds < 60) return { value: seconds, unit: 'second' };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: 'minute' };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hour' };
  return { value: Math.round(hours / 24), unit: 'day' };
}
export function scheduleWhenLabel(atMs, lang, nowMs = Date.now()) {
  const parts = scheduleWhenParts(atMs, nowMs);
  if (!parts) return '';
  try {
    return new Intl.RelativeTimeFormat(String(lang || '') || undefined, { numeric: 'auto' }).format(parts.value, parts.unit);
  } catch { return ''; }   // 没有 Intl.RelativeTimeFormat 的宿主：不说，而不是吐一个英文串
}

// 定时任务的读口。**一处实现、两个消费者**（口袋的计数与焦点栏的「接下来」），所以它导出。
// 读不到（404／断网／坏 JSON）一律回空数组 —— 定时任务是旁路，读不到不该让左栏或右栏出错。
export async function readScheduleTasks(api) {
  try { return normalizeScheduleTasks(await api(SCHEDULE_TASKS_PATH)); }
  catch { return []; }
}

// 「新」角标的判据：**服务端算好的那一个数**（13g stewardMemoryPanelRow 的 isNew，窗口 24 小时）。
// 客户端不认识那个窗口 —— 认识了就是第二份判据，24 小时改成 48 小时时它不会跟着变。
export function memoryIsNewCount(payload) {
  const counts = payload && payload.counts;
  const n = Number(counts && counts.isNew);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 体检待办：读【已经在手里的】 state.status.health，与设置按钮上那枚红点同一份判据。
export function healthBadgeOf(status, translate) {
  const items = asArray(status && status.health).filter(h => h && !HEALTH_ALIAS_IDS.includes(h.id));
  return healthSummaryText(items, translate);
}

export function createRailPocket({
  api = async () => null,
  state = null,
  t = key => key,
  // 管家三样的 deep link（steward-shell.js 里 settings.openPanel 的那一份，组合根转注入）。
  openStewardPanel = null,
  // 「体检 · 用量」两视角两条路（见 RAIL_POCKET_ITEMS 头注）。
  openUsage = null,
  openDoctor = null,
  isStewardMode = () => false,
  // 121-K2b 的那一条推送。口袋只订两类帧（收件箱有新东西／线程状态变了）——它不是第二条轮询，
  // 是「有事发生了才刷」。缺席时口袋照常工作，只是不自动刷（打开与点击那两个时刻仍然刷）。
  eventStream = null,
  documentRef = globalThis.document,
} = {}) {
  const doc = () => documentRef || null;
  const byId = id => { try { return doc()?.getElementById(id) || null; } catch { return null; } };
  const host = () => byId('railPocket');
  const lang = () => { try { return doc()?.documentElement?.lang || ''; } catch { return ''; } };

  // 已画出来的四枚按钮（id → 节点），刷新时只改数字与角标，不重画 —— 用户正按着某一枚时
  // 把它连根拔掉是 K4／K6b 都踩过的那条毛病。
  const buttons = new Map();
  let scheduleCount = 0;

  function openItem(item) {
    if (item.id === 'doctor') {
      if (!isStewardMode() && typeof openUsage === 'function') return openUsage();
      if (typeof openDoctor === 'function') return openDoctor();
      return null;
    }
    if (typeof openStewardPanel === 'function') return openStewardPanel(item.panel);
    return null;
  }

  function build() {
    const nav = host();
    if (!nav || buttons.size) return buttons.size;
    for (const item of RAIL_POCKET_ITEMS) {
      const button = doc().createElement('button');
      button.type = 'button';
      button.className = 'rail-pocket-item';
      button.dataset.pocket = item.id;
      const glyph = icon(item.icon, RAIL_POCKET_ICON_SIZE);
      if (glyph) button.appendChild(glyph);
      const label = doc().createElement('span');
      label.className = 'rail-pocket-label';
      label.textContent = t(item.labelKey);
      button.appendChild(label);
      // 计数与「新」角标各自一个空槽（:empty 时样式层收掉）—— 刷新只写 textContent。
      const count = doc().createElement('span');
      count.className = 'rail-pocket-n';
      button.appendChild(count);
      const badge = doc().createElement('span');
      badge.className = 'rail-pocket-new';
      button.appendChild(badge);
      button.title = t(item.labelKey);
      button.setAttribute('aria-label', t(item.labelKey));
      button.onclick = () => { openItem(item); void refresh(); };
      nav.appendChild(button);
      buttons.set(item.id, { button, label, count, badge });
    }
    return buttons.size;
  }

  // 文案随语言切换重写（applyTranslations 走的是 [data-i18n]，本模块的节点是 JS 建的，
  // 所以自己重写一遍；数字与角标不动）。
  function retitle() {
    for (const item of RAIL_POCKET_ITEMS) {
      const parts = buttons.get(item.id);
      if (!parts) continue;
      parts.label.textContent = t(item.labelKey);
      parts.button.title = t(item.labelKey);
      parts.button.setAttribute('aria-label', t(item.labelKey));
    }
    paintHealth();
    paintSchedule();
    return buttons.size;
  }

  function paintSchedule() {
    const parts = buttons.get('schedule');
    if (!parts) return 0;
    parts.count.textContent = scheduleCount > 0 ? String(scheduleCount) : '';
    // 数量进可访问名（图标不作唯一信号，F5a 纪律）。
    const name = scheduleCount > 0
      ? `${t('rail.pocket.schedule')} · ${scheduleCount}`
      : t('rail.pocket.schedule');
    parts.button.title = name;
    parts.button.setAttribute('aria-label', name);
    return scheduleCount;
  }

  function paintMemory(isNew) {
    const parts = buttons.get('memory');
    if (!parts) return 0;
    parts.badge.textContent = isNew > 0 ? t('rail.pocket.new') : '';
    const name = isNew > 0
      ? `${t('rail.pocket.memory')} · ${t('rail.pocket.newHint')}`
      : t('rail.pocket.memory');
    parts.button.title = name;
    parts.button.setAttribute('aria-label', name);
    return isNew;
  }

  function paintHealth() {
    const parts = buttons.get('doctor');
    if (!parts) return null;
    const summary = healthBadgeOf(state && state.status, t);
    parts.count.textContent = summary ? String(summary.count) : '';
    parts.count.dataset.tone = summary ? summary.tone : '';
    const name = summary ? `${t('rail.pocket.doctor')} · ${summary.text}` : t('rail.pocket.doctor');
    parts.button.title = name;
    parts.button.setAttribute('aria-label', name);
    return summary;
  }

  // 一发刷新 = 两条读（定时任务、管家记忆）＋ 一次本地重算（体检）。**串行合并**：上一发还没回来
  // 就不再开第二发（推送连着来时不至于把口袋变成一条轮询）。
  //
  // 127-F6：合并【不等于】可以把那一帧丢掉。在飞那一发的两条读都发生在这一帧之前，读回来的是
  // 帧之前的旧事实；而本模块零计时器、除了推送没有第二条通道 —— 丢掉就是永远不纠正。真红的形状
  // （scheduler-ui.browser B1，探针实测）：定时任务到点派四帧 registered→dispatched→
  // inbox.appended→reconciled，第一帧开的那一发在 /api/steward/memory 上停了 246 ms，reconciled
  // 那一帧正落在这个窗口里（帧 653 ms、那一发 654 ms 回来，差 1 ms）→ 角标停在「2」不再动，
  // 界面与服务端从此长期不一致。修法：在飞期间来过帧就记一笔，等这一发落地之后补刷一次；帧连着来
  // 也只补一次（收敛，不成风暴），仍然一个计时器都不加。
  let inflight = null;
  let missedWhileInflight = false;
  function refresh() {
    if (inflight) missedWhileInflight = true;
    if (inflight) return inflight;
    inflight = (async () => {
      build();
      paintHealth();
      const tasks = await readScheduleTasks(api);
      scheduleCount = tasks.length;
      paintSchedule();
      let memory = null;
      try { memory = await api(STEWARD_MEMORY_PATH); } catch { memory = null; }
      paintMemory(memoryIsNewCount(memory));
      return { schedule: scheduleCount, memoryNew: memoryIsNewCount(memory) };
    })().finally(() => {
      inflight = null;
      if (missedWhileInflight) { missedWhileInflight = false; void refresh(); }
    });
    return inflight;
  }

  function bind() {
    if (!doc()) return 0;
    build();
    paintHealth();
    void refresh();
    // 推送：收件箱多了东西／某条线程换了状态时顺手刷一次（§2.3 的「数据靠推送＋动作刷新」）。
    // 123-M2（37 号文 §3.6）：第三类帧 schedule.changed —— 定时任务建/改/删/四段触发各派一帧
    // （13r 只转发 taskId/phase/outcome 三个枚举与 id，正文不进这条线）。加它是为了让口袋上那个
    // 计数【零轮询】地跟着变：修前只有「打开时刷一次 ＋ 收件箱有新东西时顺手刷」，而建一条定时
    // 任务既不写收件箱也不改线程状态，那个数要等下一次打开左栏才对得上。**仍然零计时器**。
    if (eventStream && typeof eventStream.on === 'function') {
      // 128f-⑫：第四类 steward.memory.changed 是【页内】广播（设置里清空管家记忆之后，steward-settings 发）。
      for (const name of ['inbox.appended', 'thread.state', 'schedule.changed', 'steward.memory.changed']) {
        try { eventStream.on(name, () => { void refresh(); }); } catch { /* 推送是旁路 */ }
      }
    }
    // 语言切换：本模块的节点是 JS 建的，applyTranslations 走的是 [data-i18n]，够不着它们 ——
    // 所以听 i18n.js setLocale 末尾派的那一发 `i18n:change`（window 上，全仓唯一一处）自己重写。
    try { globalThis.addEventListener('i18n:change', () => { retitle(); }); } catch { /* ignore */ }
    return buttons.size;
  }

  return Object.freeze({
    bind,
    refresh,
    retitle,
    itemCount: () => buttons.size,
    scheduleCount: () => scheduleCount,
  });
}

// 组合根用的那一行：建域 ＋ 立刻绑定，返回句柄（与 notify-policy.js 的 bindNotifySettings 同款
// —— app.js 只多 import 与这一行调用，不再多一行构造）。
export function bindRailPocket(deps = {}) {
  const pocket = createRailPocket(deps);
  pocket.bind();
  return pocket;
}
