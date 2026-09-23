'use strict';

// background-tray.js — 线程内「后台任务」条（135c，用户 2026-09-23：会话内的后台任务进度也要有类似
// 「等你处理」的显示，但要做点小差别，而且只在对应线程下显示那个线程的）。
//
// 与 prompt-queue.js（等你处理）的差别是刻意的，四条拍板（用户 2026-09-23）：
//   · 位置：贴在【当前线程】输入框上沿，只看这一条线程的；等你处理仍在窗口最右下、跨线程；
//   · 打扰：从不弹窗、不抢焦点、不跳动 —— 它是「在跑什么」的旁注，不是「要你做什么」；
//   · 跑完即消失：结果照旧走 background.completed 的 toast 与对话里的回执，这里不留；
//   · 能停，停之前确认一次（confirm-panel.js，与看板「停掉占用者」同一个确认件）。
// 另外：别的线程有后台任务在跑时，只在左栏那一行打一个「⟳N」小标记，不展开细节。
//
// 事实源：GET /api/sessions/:id/background（13d：后台命令 + 后台子代理 + 班组，只列活着的）与
// GET /api/sessions/background-counts（各线程件数）。推送 thread.live / thread.state /
// background.completed 一到就对一次，平时有任务 3 s、没任务 10 s 轮询兜底，页面在后台不拉。

const POLL_BUSY_MS = 3000;
const POLL_IDLE_MS = 10000;
const COUNTS_POLL_MS = 10000;
const MIN_GAP_MS = 1000;
const OUTPUT_POLL_MS = 2000;

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// 纯函数：一行的「进度」文字。命令给最近一行输出；子代理/班组给「N/M 步」＋最近一条进度。
export function rowProgressText(item, t) {
  const parts = [];
  if (item && item.kind !== 'shell' && item.progress && Number(item.progress.total) > 1) {
    parts.push(t('bgTray.row.steps', { done: Number(item.progress.done) || 0, total: Number(item.progress.total) || 0 }));
  }
  if (item && item.status === 'paused') parts.push(t('bgTray.row.paused'));
  if (item && item.status === 'stopping') parts.push(t('bgTray.row.stopping'));
  if (item && item.tail) parts.push(String(item.tail));
  return parts.join(' · ');
}

// 纯函数：左栏标记要画成什么。自己这条线程不画（输入框上沿已经有那一条了）。
export function railMarks(counts, currentId) {
  const out = new Map();
  for (const [sid, n] of Object.entries(counts || {})) {
    const count = Number(n) || 0;
    if (count > 0 && sid !== currentId) out.set(sid, count);
  }
  return out;
}

export function createBackgroundTray({
  api,
  t,
  el,
  confirmDanger = async () => false,
  currentSessionId = () => '',
  openCrew = () => {},
  toast = () => {},
  shellMode = () => document.documentElement.dataset.shellMode || 'classic',
  now = () => Date.now(),
  doc = () => document,
} = {}) {
  let sessionId = '';
  let items = [];
  let expanded = false;
  let tray = null, chip = null, chipCount = null, chipTime = null, panel = null, list = null;
  let structureSig = '';
  const rowCells = new Map();      // id -> { time, progress }
  const openOutputs = new Map();   // shellId -> { pre, timer }
  let pollTimer = null, countsTimer = null, kickTimer = null, ticker = null;
  let lastFetchAt = 0, fetching = false;
  let railCounts = {};
  let started = false;

  function visible() {
    try { return !doc().hidden; } catch { return true; }
  }

  // ── 数据 ─────────────────────────────────────────────────────────────────────────
  async function refresh() {
    if (fetching || !api) return;
    const sid = String(currentSessionId() || '');
    if (sid !== sessionId) { sessionId = sid; items = []; expanded = false; closeAllOutputs(); structureSig = ''; }
    if (!sid || !visible() || shellMode() !== 'classic') { render(); schedule(); return; }
    fetching = true; lastFetchAt = now();
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(sid)}/background`);
      if (String(currentSessionId() || '') === sid) items = Array.isArray(res && res.items) ? res.items : [];
    } catch { /* 旁注,拿不到就等下一拍 */ }
    finally { fetching = false; render(); schedule(); }
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, items.length ? POLL_BUSY_MS : POLL_IDLE_MS);
  }
  function kick() {
    clearTimeout(kickTimer);
    const wait = Math.max(200, MIN_GAP_MS - (now() - lastFetchAt));
    kickTimer = setTimeout(() => { refresh(); refreshCounts(); }, wait);
  }
  async function refreshCounts() {
    if (!api || !visible()) return;
    try {
      const res = await api('/api/sessions/background-counts');
      railCounts = (res && res.counts && typeof res.counts === 'object') ? res.counts : {};
    } catch { /* ignore */ }
    paintRail();
  }

  // ── 左栏标记 ─────────────────────────────────────────────────────────────────────
  // 左栏会整片重画，所以每秒对一次：少了就补、多了就撤、数变了就改，DOM 没变就一个字不碰。
  function paintRail() {
    let rows;
    try { rows = doc().querySelectorAll('#railList .steward-board-thread[data-session-id]'); } catch { return; }
    const marks = railMarks(railCounts, String(currentSessionId() || ''));
    for (const row of rows) {
      const sid = row.dataset.sessionId;
      const want = marks.get(sid) || 0;
      let mark = row.querySelector(':scope > .steward-board-thread-head > .rail-bg-mark');
      if (!want) { if (mark) mark.remove(); continue; }
      if (!mark) {
        const head = row.querySelector(':scope > .steward-board-thread-head');
        if (!head) continue;
        mark = el('span', 'rail-bg-mark');
        head.appendChild(mark);
      }
      const text = '⟳' + want;
      if (mark.textContent !== text) {
        mark.textContent = text;
        mark.title = t('bgTray.rail.hint', { count: want });
        mark.setAttribute('aria-label', t('bgTray.rail.hint', { count: want }));
      }
    }
  }

  // ── 输入框上沿那一条 ─────────────────────────────────────────────────────────────
  function composerHost() {
    try { return doc().querySelector('.chat-pane .composer'); } catch { return null; }
  }
  function ensureTray() {
    const host = composerHost();
    if (!host) return false;
    if (tray && tray.parentNode === host) return true;
    if (!tray) {
      tray = el('div', 'bg-tray');
      tray.setAttribute('role', 'region');
      tray.setAttribute('aria-label', t('bgTray.title'));
      chip = el('button', 'bg-tray-chip');
      chip.type = 'button';
      chip.setAttribute('aria-expanded', 'false');
      const spin = el('span', 'bg-tray-spin'); spin.setAttribute('aria-hidden', 'true');
      chipCount = el('span', 'bg-tray-count', '');
      chipTime = el('span', 'bg-tray-time', '');
      chip.append(spin, chipCount, chipTime);
      chip.onclick = () => { expanded = !expanded; if (!expanded) closeAllOutputs(); render(); };
      panel = el('div', 'bg-tray-panel');
      panel.hidden = true;
      const head = el('div', 'bg-tray-head');
      head.append(el('span', 'bg-tray-head-title', t('bgTray.title')));
      const collapse = el('button', 'bg-tray-collapse', t('bgTray.collapse'));
      collapse.type = 'button';
      collapse.onclick = () => { expanded = false; closeAllOutputs(); render(); try { chip.focus(); } catch { /* ignore */ } };
      head.append(collapse);
      list = el('div', 'bg-tray-list');
      panel.append(head, list);
      tray.append(panel, chip);
    }
    host.appendChild(tray);
    return true;
  }

  function kindLabel(kind) {
    return t(kind === 'shell' ? 'bgTray.kind.shell' : kind === 'agent' ? 'bgTray.kind.agent' : 'bgTray.kind.run');
  }

  function closeAllOutputs() {
    for (const [, o] of openOutputs) clearInterval(o.timer);
    openOutputs.clear();
  }
  async function loadOutput(shellId, pre) {
    try {
      const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}/background/output?shellId=${encodeURIComponent(shellId)}`);
      const text = String((res && res.output) || '').replace(/\r\n/g, '\n');
      const lines = text.split('\n').slice(-40).join('\n').trim();   // CLIXML 噪声服务端已剥(11 shellStripClixml)
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
      pre.textContent = lines || t('bgTray.output.empty');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch { pre.textContent = t('bgTray.output.gone'); }
  }
  function toggleOutput(item, rowEl, btn) {
    const existing = openOutputs.get(item.shellId);
    if (existing) {
      clearInterval(existing.timer); existing.pre.remove(); openOutputs.delete(item.shellId);
      btn.textContent = t('bgTray.action.output'); btn.setAttribute('aria-expanded', 'false');
      return;
    }
    const pre = el('pre', 'bg-tray-output', t('bgTray.output.loading'));
    rowEl.appendChild(pre);
    btn.textContent = t('bgTray.action.hideOutput'); btn.setAttribute('aria-expanded', 'true');
    loadOutput(item.shellId, pre);
    const timer = setInterval(() => { if (!pre.isConnected) { clearInterval(timer); openOutputs.delete(item.shellId); return; } loadOutput(item.shellId, pre); }, OUTPUT_POLL_MS);
    openOutputs.set(item.shellId, { pre, timer });
  }

  async function stopItem(item, btn) {
    const ok = await confirmDanger({
      titleKey: 'bgTray.stop.title',
      bodyKey: item.kind === 'shell' ? 'bgTray.stop.bodyShell' : 'bgTray.stop.bodyRun',
      // 真机走查:引原始命令读起来是一长串 PowerShell;模型给了名字就用名字,只有没名字时才退回命令原文。
      bodyParams: { name: (item.kind === 'shell' && (!item.name || item.name === item.shellId)) ? (item.command || item.name) : item.name },
      okKey: 'bgTray.stop.ok',
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/background/stop`, { method: 'POST', body: JSON.stringify({ id: item.id }) });
    } catch (e) {
      toast(t('bgTray.stop.failed'), 'err');
      btn.disabled = false;
    }
    kick();
  }

  function buildRows() {
    list.textContent = '';
    rowCells.clear();
    for (const item of items) {
      const row = el('div', `bg-tray-row bg-${item.kind}`);
      row.dataset.taskId = item.id;
      const top = el('div', 'bg-tray-row-top');
      top.append(el('span', 'bg-tray-kind', kindLabel(item.kind)), el('span', 'bg-tray-name', String(item.name || '')));
      row.append(top);
      if (item.kind === 'shell' && item.command && item.command !== item.name) row.append(el('code', 'bg-tray-command', item.command));
      const meta = el('div', 'bg-tray-meta');
      const time = el('span', 'bg-tray-elapsed', '');
      const progress = el('span', 'bg-tray-progress', '');
      meta.append(time, progress);
      row.append(meta);
      const actions = el('div', 'bg-tray-actions');
      if (item.kind === 'shell') {
        const out = el('button', 'bg-tray-btn', t('bgTray.action.output'));
        out.type = 'button'; out.setAttribute('aria-expanded', 'false');
        out.onclick = () => toggleOutput(item, row, out);
        actions.append(out);
      } else {
        const crew = el('button', 'bg-tray-btn', t('bgTray.action.crew'));
        crew.type = 'button';
        crew.onclick = () => { expanded = false; closeAllOutputs(); render(); openCrew(item.runId); };
        actions.append(crew);
      }
      const stop = el('button', 'bg-tray-btn bg-tray-stop', t('bgTray.action.stop'));
      stop.type = 'button';
      if (item.status === 'stopping') stop.disabled = true;
      stop.onclick = () => stopItem(item, stop);
      actions.append(stop);
      row.append(actions);
      list.append(row);
      rowCells.set(item.id, { time, progress });
    }
  }

  function render() {
    const show = items.length > 0 && shellMode() === 'classic' && !!sessionId && sessionId === String(currentSessionId() || '');
    if (!show) {
      if (tray) tray.hidden = true;
      structureSig = '';
      closeAllOutputs();
      return;
    }
    if (!ensureTray()) return;
    tray.hidden = false;
    const nowMs = now();
    const oldest = Math.min(...items.map(i => Date.parse(i.startedAt) || nowMs));
    chipCount.textContent = t('bgTray.chip.count', { count: items.length });
    chipTime.textContent = t('bgTray.chip.longest', { time: formatElapsed(nowMs - oldest) });
    chip.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    chip.setAttribute('aria-label', t('bgTray.chip.label', { count: items.length }));
    panel.hidden = !expanded;
    if (!expanded) return;
    const sig = items.map(i => i.id + ':' + i.status).join('|');
    if (sig !== structureSig) {
      structureSig = sig;
      // 重建会丢掉展开着的输出框；先记下哪些开着，重建后原样开回去。
      const reopen = [...openOutputs.keys()];
      closeAllOutputs();
      buildRows();
      for (const shellId of reopen) {
        const item = items.find(i => i.shellId === shellId);
        const rowEl = item && list.querySelector(`[data-task-id="${CSS.escape(item.id)}"]`);
        const btn = rowEl && rowEl.querySelector('.bg-tray-actions .bg-tray-btn');
        if (item && rowEl && btn) toggleOutput(item, rowEl, btn);
      }
    }
    for (const item of items) {
      const cell = rowCells.get(item.id);
      if (!cell) continue;
      cell.time.textContent = t('bgTray.row.elapsed', { time: formatElapsed(nowMs - (Date.parse(item.startedAt) || nowMs)) });
      cell.progress.textContent = rowProgressText(item, t);
    }
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    refreshCounts();
    countsTimer = setInterval(refreshCounts, COUNTS_POLL_MS);
    // 页面在后台时不拉(见 refresh);切回前台立刻对一次,不等下一拍(真机:最多要等 10 s 才露面)。
    try { doc().addEventListener('visibilitychange', () => { if (visible()) kick(); }); } catch { /* ignore */ }
    // 1 s 一拍：已跑时长走表、换了线程立刻换内容、左栏重画后补标记。
    ticker = setInterval(() => {
      if (String(currentSessionId() || '') !== sessionId) { kick(); }
      render();
      paintRail();
    }, 1000);
  }
  function bindEventStream(eventStream) {
    if (!eventStream || typeof eventStream.on !== 'function') return false;
    for (const name of ['thread.live', 'thread.state', 'background.completed']) {
      try {
        eventStream.on(name, data => {
          const sid = String((data && data.sessionId) || '');
          // 当前线程的推送 → 刷列表；别的线程的只影响左栏计数，交给 kick 里那一发 refreshCounts。
          if (!sid || sid === sessionId || name !== 'thread.live') kick();
        });
      } catch { /* 推送是旁路 */ }
    }
    return true;
  }

  return Object.freeze({
    start, refresh, kick, bindEventStream,
    items: () => items.slice(),
    _stopForTests: () => { clearTimeout(pollTimer); clearTimeout(kickTimer); clearInterval(countsTimer); clearInterval(ticker); closeAllOutputs(); },
  });
}
