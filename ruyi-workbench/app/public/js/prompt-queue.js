'use strict';
import { preserveListFocus } from './util.js';

// prompt-queue.js — 「等你处理」队列（135，用户 2026-09-23：多条提问／权限同时来时依次排队，
// 最小化到右下角小窗并显示每条的等待时长；要考虑权限申请很多的情况）。
//
// 修前三处毛病（interaction-prompts.js / chat-stream-runtime.js 实测）：
//   ① 第二条提问到达时把第一条的弹窗 __cancel 掉 —— 第一条线程收到一句「用户取消」；
//   ② 权限弹窗无去重无上限地叠在一起，一次 Esc 把叠着的全部拒掉；回到仍在跑的线程时事件重放又弹一遍；
//   ③ 后台线程的权限申请根本不弹，没人看见就在 120 s 后被自动拒绝。
//
// 这个叶子只管【排队、角标、计时、对账】，弹窗长什么样仍归 interaction-prompts.js（openItem 回调）。
// 拍板四条（用户 2026-09-23）：
//   · 打扰：没有别的弹窗、你没把队列最小化、也不在打字时才自动弹队首；否则只进右下角小窗；
//   · 排序：先来先答；剩余 <30 s 的置顶（按截止时刻），免得静默被拒；
//   · 批量：小窗按线程分组；同一线程同一只读/编辑档工具有 ≥2 条时给「都允许」；
//   · 超时：后端语义不变，小窗里显示已等多久、还剩多久。
// 事实源：本页收到的实时事件（最快）＋ GET /api/interventions（跨会话登记簿，兜住别的页面／
// 定时任务／刷新前就挂着的申请）。登记簿里消失 = 已在别处决定或超时，从队列里撤掉。

const URGENT_MS = 30000;
const RECONCILE_BUSY_MS = 5000;
const RECONCILE_IDLE_MS = 15000;
// 实时事件比登记簿落盘早一拍：新入队的条目在这个窗口内不因「登记簿里还没有」被撤掉。
const RECONCILE_GRACE_MS = 8000;
const TYPING_QUIET_MS = 2500;
const MIN_RECONCILE_GAP_MS = 1000;
const STEWARD_SESSION_ID = 'steward';
// 2026-09-24(用户:「默认提问/权限改成无限久，超过一段时间之后（管家也没批的话）就自动最小化收起」):
// 后端默认不限时,截止时刻落在 ~24.8 天后(04 PROMPT_WAIT_UNLIMITED_MS)。超过一周的截止时刻不算「真截止」——
// 不显示倒计时、不参与「快超时置顶」。弹出来的那一条若 AUTO_MINIMIZE_MS 内没人碰(管家代批了会直接从队列
// 撤掉,轮不到这一步),就收进右下角小窗,与用户按「稍后处理」同一个效果。
const DEADLINE_HORIZON_MS = 7 * 24 * 3600 * 1000;
const AUTO_MINIMIZE_MS = 120000;
// 小窗在哪些视角里出现。修前只有工作台;用户要求管家视角里也看得到。
const DOCK_SHELL_MODES = Object.freeze(['classic', 'steward']);

// 纯函数:把截止时刻归一 —— 没有、或远在一周之外(不限时)一律当 0。
export function promptDeadline(value, nowMs) {
  const at = Number(value) || 0;
  return at > 0 && at - Number(nowMs) <= DEADLINE_HORIZON_MS ? at : 0;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// 纯函数：队列顺序。快超时的（剩余 <30 s 且还没过期）按截止时刻排最前，其余先来先答。
export function orderQueue(items, nowMs) {
  const urgent = [], rest = [];
  for (const item of items) {
    const remain = item.deadlineAt > 0 ? item.deadlineAt - nowMs : Infinity;
    if (remain > 0 && remain <= URGENT_MS) urgent.push(item); else rest.push(item);
  }
  urgent.sort((a, b) => a.deadlineAt - b.deadlineAt);
  rest.sort((a, b) => (a.requestedAt - b.requestedAt) || String(a.id).localeCompare(String(b.id)));
  return urgent.concat(rest);
}

// 纯函数：按线程分组，组的次序跟随组内最靠前那一条。
export function groupQueue(ordered) {
  const groups = new Map();
  for (const item of ordered) {
    if (!groups.has(item.sessionId)) groups.set(item.sessionId, []);
    groups.get(item.sessionId).push(item);
  }
  return [...groups.entries()].map(([sessionId, rows]) => ({ sessionId, rows }));
}

// 纯函数：一组里可以「都允许」的工具 —— 只读/编辑档、同一工具 ≥2 条。执行/桌面档永远逐条按。
export function bulkAllowCandidates(rows) {
  const byTool = new Map();
  for (const item of rows) {
    if (item.type !== 'permission') continue;
    const tier = String(item.payload && item.payload.tier || '');
    if (tier !== 'read' && tier !== 'edit') continue;
    const tool = String(item.payload && item.payload.toolName || '');
    if (!tool) continue;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(item);
  }
  return [...byTool.entries()].filter(([, list]) => list.length >= 2).map(([tool, list]) => ({ tool, items: list }));
}

export function createPromptQueue({
  api,
  t,
  el,
  openItem,                 // (item, ctx) => { close() } —— ctx: { queuedCount, minimize, done }
  allowToolForThread,       // (sessionId, tool, items) => Promise
  humanizeToolName = name => name,
  sessionTitle = () => '',
  shellMode = () => document.documentElement.dataset.shellMode || 'classic',
  now = () => Date.now(),
  doc = () => document,
} = {}) {
  const items = new Map();       // id -> { id, type, sessionId, requestedAt, deadlineAt, payload, addedAt }
  const settled = new Set();     // 已答/已决定的 id：重放与对账都不许把它复活
  let active = null;             // { id, handle }
  let minimized = false;         // 用户按过「稍后处理」：不再自动弹，直到队列清空
  let expanded = false;
  let dock = null, pill = null, panel = null, list = null, countEl = null, longestEl = null;
  let structureSig = '';
  const timeCells = new Map();   // id -> { row, time }
  let ticker = null, reconcileTimer = null, reconciling = false;
  let lastTypingAt = 0;
  let lastModalActivityAt = 0;   // 弹窗里的点按／键入:有人在处理就不自动收起
  let lastReconcileAt = 0;

  // 3.0 预览收口(quiet-card-typing D1/D5/D7):粘贴、输入法上屏、Input.insertText 不发 keydown,
  // 只听 keydown 会把正在输入的人当成「空闲」—— input 事件一起算。
  try {
    const markTyping = e => {
      const tag = String(e.target && e.target.tagName || '');
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) lastTypingAt = now();
    };
    doc().addEventListener('keydown', markTyping, true);
    doc().addEventListener('input', markTyping, true);
    const markModal = e => {
      try { if (e.target && e.target.closest && e.target.closest('.prompt-queue-modal')) lastModalActivityAt = now(); } catch { /* ignore */ }
    };
    doc().addEventListener('pointerdown', markModal, true);
    doc().addEventListener('keydown', markModal, true);
    doc().addEventListener('input', markModal, true);
  } catch { /* 无 DOM 的测试环境 */ }

  // J04(36 号文 §2.2「焦点不动…不开弹层」):焦点停在一段没发出去的草稿上,就不算「空闲」——
  // 停笔超过 TYPING_QUIET_MS 也一样。条目留在右下角小窗里,草稿发出去或焦点离开输入框后再自动弹。
  function composingDraft() {
    try {
      const a = doc().activeElement;
      if (!a) return false;
      if (a.isContentEditable) return String(a.textContent || '').trim() !== '';
      const tag = String(a.tagName || '');
      const texty = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|)$/i.test(String(a.type || '')));
      return texty && String(a.value || '').trim() !== '';
    } catch { return false; }
  }

  function ordered() { return orderQueue([...items.values()], now()); }

  function otherModalOpen() {
    try {
      return [...doc().querySelectorAll('.modal-backdrop')].some(m => !m.classList.contains('hidden') && !m.classList.contains('prompt-queue-modal'));
    } catch { return false; }
  }

  function offer(raw) {
    const id = String(raw && raw.id || '');
    if (!id || settled.has(id)) return false;
    const sessionId = String(raw.sessionId || '');
    if (!sessionId || sessionId === STEWARD_SESSION_ID) return false;
    const existing = items.get(id);
    if (existing) {
      // 同一条又来一次（重放／对账）：只补字段，不重排、不重弹。
      if (!existing.deadlineAt && raw.deadlineAt) existing.deadlineAt = promptDeadline(raw.deadlineAt, now());
      if (raw.payload) existing.payload = { ...raw.payload, ...existing.payload };
      if (!existing.title && raw.title) existing.title = String(raw.title);
      render();
      return false;
    }
    items.set(id, {
      id,
      type: raw.type === 'question' ? 'question' : 'permission',
      sessionId,
      requestedAt: Number(raw.requestedAt) || now(),
      deadlineAt: promptDeadline(raw.deadlineAt, now()),
      payload: raw.payload || {},
      title: String(raw.title || ''),
      addedAt: now(),
    });
    ensureTicker();
    pump();
    render();
    pulse();
    return true;
  }

  // 已经有结果了（答了、批了、拒了、别处决定了、超时了）：撤掉并记住。
  function settle(id) {
    const key = String(id || '');
    if (!key) return;
    settled.add(key);
    const wasActive = active && active.id === key;
    items.delete(key);
    if (wasActive) {
      const handle = active.handle;
      active = null;
      try { handle && handle.close && handle.close(); } catch { /* 已关 */ }
    }
    if (!items.size) { minimized = false; expanded = false; }
    pump();
    render();
  }
  function isSettled(id) { return settled.has(String(id || '')); }
  function has(id) { return items.has(String(id || '')); }

  function openNow(item) {
    if (!item) return;
    if (active && active.id === item.id) return;
    if (active) minimizeActive(false);
    const id = item.id;
    const ctx = {
      queuedCount: Math.max(0, items.size - 1),
      // 「稍后处理」、✕、点背影、Esc：都只是收起，不替用户做决定。
      minimize: () => { if (active && active.id === id) { active = null; minimized = true; render(); } },
      done: () => settle(id),
    };
    const handle = openItem(item, ctx);
    if (!handle) { settle(id); return; }
    active = { id, handle, openedAt: now() };
    lastModalActivityAt = 0;
    render();
  }

  function minimizeActive(userAction = true) {
    if (!active) return;
    const handle = active.handle;
    active = null;
    if (userAction) minimized = true;
    try { handle && handle.close && handle.close(); } catch { /* 已关 */ }
    render();
  }

  // 弹出来的那一条放着没人管:收进小窗(= 用户按「稍后处理」),不再抢着挡在屏幕中间。弹窗里有过点按／
  // 键入就从那一刻重新计时;焦点停在一段没发出去的回答草稿上也不收。
  function autoMinimize() {
    if (!active) return;
    const since = Math.max(Number(active.openedAt) || 0, lastModalActivityAt);
    if (now() - since < AUTO_MINIMIZE_MS) return;
    if (composingDraft()) return;
    minimizeActive(true);
  }

  function pump() {
    if (active || minimized || !items.size) return;
    if (otherModalOpen()) return;
    if (now() - lastTypingAt < TYPING_QUIET_MS) return;
    if (composingDraft()) return;
    const head = ordered()[0];
    if (head) openNow(head);
  }

  function openById(id) {
    const item = items.get(String(id || ''));
    if (!item) return;
    minimized = false;
    expanded = false;
    openNow(item);
  }

  // ── 对账：跨会话登记簿 ────────────────────────────────────────────────────────────
  async function reconcile() {
    if (reconciling || !api) return;
    // 页面在后台就先不拉,但【照样排下一拍】—— 修前这里直接 return,切走一次对账链就断了。
    try { if (doc().hidden) { scheduleReconcile(); return; } } catch { /* ignore */ }
    reconciling = true;
    lastReconcileAt = now();
    try {
      const res = await api('/api/interventions?limit=100');
      const pending = Array.isArray(res && res.pending) ? res.pending : [];
      const seen = new Set();
      for (const iv of pending) {
        if (!iv || (iv.type !== 'permission' && iv.type !== 'question')) continue;
        const id = String(iv.id || '');
        if (!id) continue;
        seen.add(id);
        const current = items.get(id);
        if (current) {
          // 截止时刻以登记簿为准（存档暂停延长、提问心跳续期都只在那边）；提问取两边更晚的那个。
          const next = promptDeadline(iv.deadlineAt, now());
          if (next > 0) current.deadlineAt = current.type === 'question' ? Math.max(current.deadlineAt, next) : next;
          if (!current.title && iv.title) current.title = String(iv.title);
          continue;
        }
        if (iv.deliverable === false) continue;   // 送不到（回合已经没了）：弹出来也按不动
        offer({
          id,
          type: iv.type,
          sessionId: iv.sessionId,
          title: iv.title || '',
          requestedAt: Date.parse(iv.requestedAt) || now(),
          deadlineAt: Number(iv.deadlineAt) || 0,
          payload: iv.type === 'permission'
            ? { requestId: id, toolName: iv.toolName, tier: iv.tier, revertible: iv.revertible === true, input: iv.input || {} }
            : { questions: Array.isArray(iv.questions) ? iv.questions : [], context: iv.context || '' },
        });
      }
      for (const item of [...items.values()]) {
        if (seen.has(item.id)) continue;
        if (now() - item.addedAt < RECONCILE_GRACE_MS) continue;
        settle(item.id);
      }
    } catch { /* 对账是兜底，拿不到就等下一拍 */ }
    finally { reconciling = false; scheduleReconcile(); }
  }
  function scheduleReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, items.size ? RECONCILE_BUSY_MS : RECONCILE_IDLE_MS);
  }

  // ── 计时 ─────────────────────────────────────────────────────────────────────────
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!items.size) { clearInterval(ticker); ticker = null; return; }
      autoMinimize();
      pump();
      render();
    }, 1000);
  }

  // ── 右下角小窗 ───────────────────────────────────────────────────────────────────
  function ensureDock() {
    if (dock) return;
    const d = doc();
    dock = el('div', 'prompt-dock');
    dock.id = 'promptDock';
    dock.setAttribute('role', 'region');
    dock.setAttribute('aria-label', t('promptQueue.dock.title'));
    pill = el('button', 'prompt-dock-pill');
    pill.type = 'button';
    pill.setAttribute('aria-expanded', 'false');
    const dot = el('span', 'pd-dot'); dot.setAttribute('aria-hidden', 'true');
    countEl = el('b', 'pd-count', '0');
    longestEl = el('span', 'pd-longest', '');
    pill.append(dot, el('span', 'pd-label', t('promptQueue.dock.label')), countEl, longestEl);
    pill.onclick = () => { expanded = !expanded; render(); };
    panel = el('div', 'prompt-dock-panel');
    panel.hidden = true;
    const head = el('div', 'pd-head');
    head.append(el('span', 'pd-head-title', t('promptQueue.dock.title')));
    const collapse = el('button', 'pd-collapse', t('promptQueue.dock.collapse'));
    collapse.type = 'button';
    collapse.onclick = () => { expanded = false; render(); try { pill.focus(); } catch { /* ignore */ } };
    head.append(collapse);
    list = el('div', 'pd-list');
    panel.append(head, list);
    dock.append(panel, pill);
    d.body.appendChild(dock);
  }

  // 右下角正好是输入框的发送键(真机走查:小窗压住了「发送」)。有可见的输入框就浮到它上沿之上 8px;
  // 没有(设置页、管家视角之外的别的视图)就贴底。只写一个 CSS 变量,安静卡与 toast 跟着它让位。
  function placeAboveComposer() {
    let bottom = 0;
    try {
      // 135c:输入框上沿若挂着「后台任务」那一枚,就再浮到它之上 —— 两枚都在右边,不许叠在一起。
      // (量整个 .bg-tray:它展开时面板也在里面,小窗得浮到面板之上。)
      // 管家视角没有 .chat-pane(藏着,量出来是 0),改量管家自己的输入框;右侧线程抽屉开着时它的底栏
      // (「直接对这条线程说」)正好在小窗底下,先让它。取第一个真在屏上的。
      const candidates = ['.chat-pane .bg-tray:not([hidden])', '.chat-pane .composer-box',
        '.steward-drawer:not([hidden]) .steward-drawer-foot', '#stewardComposer'];
      for (const selector of candidates) {
        const box = doc().querySelector(selector);
        const r = box && box.getBoundingClientRect();
        if (r && r.height > 0 && r.width > 0) { bottom = Math.max(0, Math.round(window.innerHeight - r.top + 8)); break; }
      }
    } catch { /* ignore */ }
    const value = bottom ? bottom + 'px' : '';
    if (doc().body.style.getPropertyValue('--prompt-dock-bottom') !== value) {
      if (value) doc().body.style.setProperty('--prompt-dock-bottom', value);
      else doc().body.style.removeProperty('--prompt-dock-bottom');
    }
  }

  function pulse() {
    if (!dock) return;
    dock.classList.remove('pd-pulse');
    void dock.offsetWidth;   // 重启动画
    dock.classList.add('pd-pulse');
  }

  function itemSummary(item) {
    if (item.type === 'question') {
      const qs = Array.isArray(item.payload.questions) ? item.payload.questions : [];
      const first = qs[0] || {};
      return String(first.question || first.header || t('promptQueue.row.questionFallback')).replace(/\s+/g, ' ').slice(0, 60);
    }
    return humanizeToolName(item.payload.toolName || '');
  }

  function timeText(item, nowMs) {
    const waited = t('promptQueue.row.waited', { time: formatDuration(nowMs - item.requestedAt) });
    if (!(item.deadlineAt > 0)) return waited;
    const remain = item.deadlineAt - nowMs;
    const tail = remain > 0 ? t('promptQueue.row.remain', { time: formatDuration(remain) }) : t('promptQueue.row.expiring');
    return `${waited} · ${tail}`;
  }

  function buildStructure(groups) {
    const restoreFocus = preserveListFocus(list, pill);
    list.textContent = '';
    timeCells.clear();
    for (const group of groups) {
      const section = el('section', 'pd-group');
      const gh = el('div', 'pd-group-head');
      gh.append(el('span', 'pd-group-title', sessionTitle(group.sessionId) || group.rows[0].title || t('promptQueue.thread.unknown')),
        el('span', 'pd-group-count', String(group.rows.length)));
      section.append(gh);
      for (const item of group.rows) {
        const row = el('button', `pd-row pd-${item.type}`);
        row.type = 'button';
        row.dataset.interventionId = item.id;
        row.dataset.focusKey = item.id;
        const kind = el('span', 'pd-kind', t(item.type === 'question' ? 'promptQueue.row.question' : 'promptQueue.row.permission'));
        const main = el('span', 'pd-row-main');
        const time = el('span', 'pd-time', '');
        main.append(el('span', 'pd-summary', itemSummary(item)), time);
        row.append(kind, main);
        row.onclick = () => openById(item.id);
        section.append(row);
        timeCells.set(item.id, { row, time });
      }
      for (const cand of bulkAllowCandidates(group.rows)) {
        const bulk = el('button', 'pd-bulk', t('promptQueue.group.allowTool', { tool: humanizeToolName(cand.tool), count: cand.items.length }));
        bulk.type = 'button';
        bulk.dataset.focusKey = JSON.stringify([group.sessionId, cand.tool, 'bulk']);
        bulk.title = t('promptQueue.group.allowToolHint', { count: cand.items.length });
        bulk.onclick = async () => {
          bulk.disabled = true;
          try {
            await allowToolForThread(group.sessionId, cand.tool, cand.items.map(i => i.payload));
            for (const i of cand.items) settle(i.id);
          } catch { bulk.disabled = false; }
        };
        section.append(bulk);
      }
      list.append(section);
    }
    restoreFocus();
  }

  function render() {
    const show = items.size > 0 && !active && DOCK_SHELL_MODES.includes(shellMode());
    if (!show) {
      if (!items.size && dock?.contains(doc().activeElement)) doc().querySelector('#promptInput')?.focus();
      if (dock) { dock.hidden = true; doc().body.classList.remove('has-prompt-dock'); }
      structureSig = '';
      return;
    }
    ensureDock();
    dock.hidden = false;
    doc().body.classList.add('has-prompt-dock');
    placeAboveComposer();
    const nowMs = now();
    const ord = ordered();
    const groups = groupQueue(ord);
    countEl.textContent = String(items.size);
    const oldest = Math.min(...ord.map(i => i.requestedAt));
    longestEl.textContent = t('promptQueue.dock.longest', { time: formatDuration(nowMs - oldest) });
    const anyUrgent = ord.some(i => i.deadlineAt > 0 && i.deadlineAt - nowMs <= URGENT_MS);
    dock.classList.toggle('pd-urgent', anyUrgent);
    pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    pill.setAttribute('aria-label', t('promptQueue.dock.pillLabel', { count: items.size }));
    panel.hidden = !expanded;
    if (!expanded) return;
    const sig = groups.map(g => g.sessionId + ':' + g.rows.map(r => r.id).join(',')).join('|');
    if (sig !== structureSig) { structureSig = sig; buildStructure(groups); }
    for (const item of ord) {
      const cell = timeCells.get(item.id);
      if (!cell) continue;
      cell.time.textContent = timeText(item, nowMs);
      cell.row.classList.toggle('pd-warn', item.deadlineAt > 0 && item.deadlineAt - nowMs <= URGENT_MS);
    }
  }

  function start() {
    reconcile();
    // 135c 同一处发现:页面在后台时对账只排不拉,切回前台立刻对一次,别让等你的那条再晚 5～15 s 露面。
    try { doc().addEventListener('visibilitychange', () => { try { if (!doc().hidden) kick(); } catch { /* ignore */ } }); } catch { /* ignore */ }
  }
  // 推送来了(有线程在等你 / 线程状态变了)就尽快对一次账,不必等 5／15 s 的轮询 —— 真机验证:
  // 后台线程的申请只靠空闲轮询要 ~17 s 才露面,而默认 120 s 就自动拒绝。250 ms 合并一串连发的帧。
  // 真机量过:回合跑起来时 thread.state 一秒好几帧,不设下限会把对账打成每秒数发。两次对账至少隔 1 s。
  let kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    const wait = Math.max(250, MIN_RECONCILE_GAP_MS - (now() - lastReconcileAt));
    kickTimer = setTimeout(() => { clearTimeout(reconcileTimer); reconcile(); }, wait);
  }
  function bindEventStream(eventStream) {
    if (!eventStream || typeof eventStream.on !== 'function') return false;
    for (const name of ['thread.needs_you', 'thread.state']) {
      try { eventStream.on(name, kick); } catch { /* 推送是旁路,轮询兜底 */ }
    }
    return true;
  }

  return Object.freeze({
    offer, settle, isSettled, has, openById, minimizeActive, reconcile, start, kick, bindEventStream,
    size: () => items.size,
    list: () => ordered(),
    queuedBehind: () => Math.max(0, items.size - (active ? 1 : 0)),
    activeId: () => (active ? active.id : ''),
    timeText: id => { const item = items.get(String(id || '')); return item ? timeText(item, now()) : ''; },
  });
}
