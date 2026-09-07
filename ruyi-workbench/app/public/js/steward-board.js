'use strict';

import './mission-state.js';
import { authHeaders } from './net.js';
import { elapsedLabel } from './preview-task-sheet.js';
import { dockToneForMissionState } from './preview-shell.js';
import { createQuickSwitchChips } from './steward-chips.js';
import { stewardThreadRunAction, stewardThreadStop } from './steward-drawer.js';

// 第117波 117h：一行状态 → 看板 → 「现在这一件」（27 号文 §8.2 L1／§8.10 多线程看板与注意力预算）。
//
// 三件事，一个模块：
//   ① 一行状态 `#stewardStatusLine`：「N 个事项 · A 条在跑，B 条等你」，点开即看板（aria-expanded）；
//      一条线程都没有时说 §8.9 那句「还没有任务，直接说你想做什么」。
//   ② 看板 `#stewardBoard`：从状态行下拉的面板（role="region"，Esc 关）。顶部是并发上限就地可调、
//      在跑／排队计数、「全部暂停」「整体切到 2.0」；正文按【事项】分组，事项行给聚合态与验收 a/b，
//      线程行给五态点、耗时、快切 chip、单一的等待原因与悬停操作。
//   ③ 「现在这一件」`#stewardNow`：≥1000px 常驻右栏，内容就是【同一个】线程抽屉以 docked 挂法挂进来
//      （steward-drawer.js 的 setMount('docked') 把 #stewardDrawer 节点搬进 #stewardNowBody）——
//      不存在第二份抽屉区块渲染。焦点线程由纯函数 focusThreadFor 决定，用户显式选过就钉住。
//
// 不另起判据（§8.10 逐条）：
//   · 事项聚合态【只读】行上的 `aggregateState`（116g 由 06i 的 aggregateMissionState 单点算出），
//     本模块不写「任一 needs_you 则…」这类字面判定；
//   · 线程五态经 mission-state.js 的 fromCard（全仓唯一判据，与抽屉、交办台逐字节同源）；
//   · 等待原因只有 `wait.label` 一处（116h 的 waitReasonFor 单点判定），本模块没有第二套等待文案；
//   · 权限／模型快切经 steward-chips.js 的同一个工厂（紧凑模式），本模块不自己 PATCH 会话。
//
// 刷新纪律（对 27 号文 §5 117h「刷新纪律」的一处收紧，见文件尾的说明）：本模块恰好一处 setInterval
// 与一处 clearInterval，唯一入口 syncPolling() 先判「看板打开 && 管家模式 && 页面可见」，任一为否
// 立刻停表；「现在这一件」的内容由抽屉自己那一份轮询刷新（同一份实现），行数据在进壳／开看板／
// 焦点事件／写动作／页面重新可见这五个确定性时刻各刷一次 —— 于是管家壳在看板关着时【不多】一条
// 后台计时器（§3.4 红线的延伸）。

export const STEWARD_BOARD_POLL_MS_MIN = 5000;
export const STEWARD_BOARD_POLL_MS_DEFAULT = 15000;
export const STEWARD_NOW_CLOSED_KEY = 'wcw.stewardNowClosed';
export const STEWARD_NOW_MIN_WIDTH = 1000;
// 与 01-config.js 的 stewardMaxParallelThreads 校验同一区间（[1,32]，默认 5）。
export const STEWARD_MAX_PARALLEL_MIN = 1;
export const STEWARD_MAX_PARALLEL_MAX = 32;
export const STEWARD_NEW_THREAD_EVENT = 'steward:new-thread';
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread';
export const STEWARD_OPEN_THREAD_EVENT = 'steward:open-thread';

// ── 焦点线程：等你 ＞ 在跑 ＞ 失败 ＞ 最近更新（§8.10／§5 117h 行）──────────────────
// 纯函数、零 DOM、零 import 依赖：dev-harness/unit/steward-focus-thread.test.js 直接 import 跑真值表。
// 入参是【已经带好五态】的行（五态由调用方经 mission-state.js 算出，本函数不认识卡片形状，也就
// 不可能在这里长出第二套五态判据）。
// 「失败」在五态里没有独立枚举 —— mission-state.js 的诚实说法是 `stopped`（已停工：活没在干），
// 所以第三优先级取 stopped，不自造一个 failed 态。
export function focusThreadFor(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && row.sessionId);
  if (!list.length) return null;
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const pick = state => list.filter(row => row.state === state).sort(newest)[0] || null;
  return pick('needs_you') || pick('running') || pick('stopped') || list.slice().sort(newest)[0] || null;
}

export function createStewardBoard({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  drawer = null,
  saveConfigPartial = async () => false,
  // 117g：「整体切到 2.0」与看板每行的「2.0」都走它（切经典壳＋选中会话＋顶部返回带）。
  openClassicWindow = async () => {},
  switchWholeShell = () => {},
  // 117g：行数据到手就通知返回带重画一次 —— 带上的「事项名」读的正是本模块取回来的这批行
  // （missionTitleOf）。不通知的话，进壳后立刻开 2.0 视窗会赶在第一趟取数之前，事项名那段空着。
  onRowsChanged = () => {},
} = {}) {
  const doc = () => globalThis.document || null;
  const byId = id => (doc() ? doc().getElementById(id) : null);

  let rows = [];                    // GET /api/missions 的线程行（卡片形状 + 116g/117h-0 的追加字段）
  let arbiter = null;               // GET /api/steward/arbiter 的只读状态
  let missionsEtag = '';            // 带 If-None-Match 走，没变就连解析都省了
  let pinnedId = '';                // 用户显式选过的线程（steward:open-thread / focus-thread / 看板行）
  let suppressCloseRecord = false;  // 程序性关抽屉（窄屏／切壳）不该被记成用户「关掉」了这一件
  const chipsBySession = new Map(); // sessionId -> chips 控件（每行一份实例，读同一份数据）
  const sessionCache = new Map();   // sessionId -> 会话（chip 补齐或 PATCH 回来的那一份）

  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    if (!node) return null;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function note(text) {
    const target = byId('stewardBoardNote');
    if (target) target.textContent = String(text || '');
  }
  function failNote(error) {
    note(t('stewardShell.board.failed', { error: String((error && error.message) || error || 'failed') }));
  }

  // ── 五态与聚合态：只读，不判 ────────────────────────────────────────────────────
  function threadStateOf(card) {
    const missionState = globalThis.MissionState;
    if (!card || !missionState || typeof missionState.fromCard !== 'function') return '';
    return String(missionState.fromCard(card).state || '');
  }
  // 人话复用抽屉那一组键（stewardShell.drawer.state.*），不再开第二套五态文案。
  function stateLabel(value) {
    return value ? t(`stewardShell.drawer.state.${value}`) : '';
  }
  function paintDot(node, value) {
    node.dataset.state = value;
    node.dataset.tone = dockToneForMissionState(value);
    return node;
  }

  // 焦点线程的入参：把卡片行折成 { sessionId, state, updatedAt } —— 纯函数只认这三个字段。
  function threadViews() {
    return rows.map(row => ({
      sessionId: String(row.sessionId || ''),
      state: threadStateOf(row),
      updatedAt: String(row.updatedAt || ''),
    }));
  }

  // ── 取数 ────────────────────────────────────────────────────────────────────────
  async function loadMissions() {
    try {
      const headers = authHeaders(missionsEtag ? { 'if-none-match': missionsEtag } : {});
      const response = await fetch('/api/missions?limit=200', { headers });
      if (response.status === 304) return false;          // 没变：不重画，chip 菜单也就不会被打断
      if (!response.ok) return false;
      missionsEtag = response.headers.get('etag') || '';
      const payload = await response.json();
      rows = Array.isArray(payload && payload.missions) ? payload.missions : [];
      return true;
    } catch { return false; }
  }

  async function loadArbiter() {
    try {
      const response = await api('/api/steward/arbiter');
      arbiter = (response && response.ok === true) ? response : null;
    } catch { arbiter = null; }   // 开关关时后端给 409：仲裁面整块留空，不编数字
    return arbiter;
  }

  // ── ① 一行状态 ──────────────────────────────────────────────────────────────────
  function renderStatusLine() {
    const line = byId('stewardStatusLine');
    if (!line) return '';
    const views = threadViews();
    if (!views.length) {
      line.textContent = t('stewardShell.board.statusEmpty');
      return line.textContent;
    }
    const missions = new Set(rows.map(row => String(row.missionId || row.sessionId))).size;
    const running = views.filter(view => view.state === 'running').length;
    const needsYou = views.filter(view => view.state === 'needs_you').length;
    line.textContent = t('stewardShell.board.statusLine', { missions, running, needsYou });
    return line.textContent;
  }

  // ── ② 看板顶部：并发上限就地可调 + 在跑／排队计数 ───────────────────────────────
  function renderArbiterFacts() {
    const input = byId('stewardBoardMax');
    if (input && doc().activeElement !== input) {
      const configured = Number(state && state.config && state.config.stewardMaxParallelThreads);
      const live = arbiter ? Number(arbiter.maxParallel) : NaN;
      const value = Number.isFinite(live) ? live : (Number.isFinite(configured) ? configured : 5);
      input.value = String(value);
    }
    const running = byId('stewardBoardRunning');
    const queued = byId('stewardBoardQueued');
    const runningCount = arbiter && Array.isArray(arbiter.running) ? arbiter.running.length : 0;
    const queuedCount = arbiter && Array.isArray(arbiter.queue) ? arbiter.queue.length : 0;
    if (running) running.textContent = t('stewardShell.board.running', { n: runningCount });
    if (queued) queued.textContent = t('stewardShell.board.queued', { n: queuedCount });
    return { runningCount, queuedCount };
  }

  async function saveMaxParallel(raw) {
    const value = Math.min(STEWARD_MAX_PARALLEL_MAX, Math.max(STEWARD_MAX_PARALLEL_MIN, Math.round(Number(raw) || 0)));
    if (!Number.isFinite(value)) return false;
    const saved = await saveConfigPartial({ stewardMaxParallelThreads: value });
    if (!saved) { note(t('stewardShell.board.maxParallelFailed')); return false; }
    // 116h 的 arbiterRefresh 让它即时生效（不需重启）；回读仲裁面确认，界面只说后端真答应了的数。
    await loadArbiter();
    renderArbiterFacts();
    note(t('stewardShell.board.maxParallelSaved', { n: value }));
    return true;
  }

  // ── ② 看板正文：按事项分组 ──────────────────────────────────────────────────────
  function groupRows() {
    const groups = new Map();
    for (const row of rows) {
      const missionId = String(row.missionId || row.sessionId || '');
      if (!groups.has(missionId)) {
        groups.set(missionId, {
          missionId,
          // 117h 第 0 步：事项标题／目标／验收项整表都由 GET /api/missions 的行直出，界面不再猜。
          title: String(row.missionTitle || row.title || t('stewardShell.drawer.missionUnfiled')),
          aggregateState: String(row.aggregateState || ''),
          threadCount: Number(row.threadCount) || 0,
          acceptance: row.acceptance || { done: 0, total: 0 },
          budget: row.budget || {},
          cost: row.cost || {},
          rows: [],
        });
      }
      groups.get(missionId).rows.push(row);
    }
    return [...groups.values()];
  }

  function costText(group) {
    const costs = (group.cost && group.cost.costsByCurrency) || {};
    const spent = Object.entries(costs)
      .filter(([, amount]) => Number.isFinite(Number(amount)))
      .map(([currency, amount]) => `${currency} ${Number(amount).toFixed(4)}`)
      .join(' · ');
    if (!spent) return t('stewardShell.board.costNone');
    const maxCost = Number(group.budget && group.budget.maxCost);
    if (Number.isFinite(maxCost) && maxCost > 0) {
      return t('stewardShell.board.costBudget', { cost: spent, budget: `${String(group.budget.currency || '')} ${maxCost}`.trim() });
    }
    return t('stewardShell.board.cost', { cost: spent });
  }

  function acceptanceText(group) {
    const total = Math.max(0, Number(group.acceptance && group.acceptance.total) || 0);
    if (!total) return t('stewardShell.board.acceptanceNone');
    return t('stewardShell.board.acceptance', { done: Math.max(0, Number(group.acceptance.done) || 0), total });
  }

  function chipsFor(sessionId) {
    let control = chipsBySession.get(sessionId);
    if (!control) {
      control = createQuickSwitchChips({
        api, t, state,
        compact: true,                                   // §8.10 线程行：权限＋模型，引擎收进模型菜单
        // 卡片行没有 permissionMode/engineRoute（GET /api/missions 返回的是任务卡，不是会话元数据）。
        // 打开菜单前按需补一次真会话，补到的那一份进缓存，下一次渲染就喂它。
        hydrate: async id => {
          try {
            const response = await api(`/api/sessions/${encodeURIComponent(id)}`);
            const session = (response && response.session) || null;
            if (session) sessionCache.set(id, session);
            return session;
          } catch { return null; }
        },
        onChanged: session => { if (session && session.id) sessionCache.set(String(session.id), session); },
      });
      chipsBySession.set(sessionId, control);
    }
    return control;
  }

  // chip 要的是【会话】而不是任务卡：先用补齐过的那一份，否则退到组合根已经持有的会话元数据
  // （state.sessions 里的 permissionMode 是权威字段，零新增请求），最后才退到只有 id 的空壳。
  function sessionForRow(row) {
    const id = String(row.sessionId || '');
    if (sessionCache.has(id)) return sessionCache.get(id);
    const metas = (state && Array.isArray(state.sessions)) ? state.sessions : [];
    return metas.find(meta => meta && String(meta.id) === id) || { id, title: row.title || '' };
  }

  function boardButton(labelKey, handler, dataset) {
    const button = el('button', 'steward-board-btn', t(labelKey));
    button.type = 'button';
    if (dataset) Object.assign(button.dataset, dataset);
    button.onclick = handler;
    return button;
  }

  function renderThreadRow(row) {
    const sessionId = String(row.sessionId || '');
    const item = el('li', 'steward-board-thread');
    item.dataset.sessionId = sessionId;
    const threadState = threadStateOf(row);

    const head = el('div', 'steward-board-thread-head');
    head.appendChild(paintDot(el('span', 'steward-board-dot'), threadState));
    // 116-5b(§11.8.5):显示名由服务端一处算好(13d buildMissionCard 的 displayTitle,判据在 02 的
    // sessionDisplayTitle),看板只读结果 —— 与本行的 stateLabel / wait.label 同一条纪律。
    // 原话挂 hover(它没被改写,仍是权威);没有摘要时 displayTitle 逐字等于 title,不挂重复的提示。
    const title = el('button', 'steward-board-thread-title', String(row.displayTitle || row.title || sessionId));
    if (row.title && row.displayTitle && row.title !== row.displayTitle) title.title = String(row.title);
    title.type = 'button';
    title.onclick = () => focusThread(sessionId);
    head.appendChild(title);
    const elapsed = elapsedLabel(row.updatedAt, new Date());
    if (elapsed) head.appendChild(el('span', 'steward-board-meta', t('stewardShell.board.updated', { elapsed })));
    item.appendChild(head);

    const chipHost = el('div', 'steward-board-chips');
    item.appendChild(chipHost);
    const control = chipsFor(sessionId);
    control.mount(chipHost);
    control.setSession(sessionForRow(row));

    // 单一的等待原因（§8.10「排队可解释」）：`wait.label` 是全仓唯一判据的输出，本模块只渲染它这一处；
    // 没在等的时候如实显示五态人话，不另编一句「正在忙」。
    const wait = (row.wait && typeof row.wait === 'object') ? row.wait : null;
    const waitLine = el('p', 'steward-board-wait', wait ? String(wait.label || '') : stateLabel(threadState));
    if (wait && Number.isFinite(Number(wait.ahead)) && Number(wait.ahead) > 0) waitLine.dataset.ahead = String(wait.ahead);
    item.appendChild(waitLine);

    const actions = el('div', 'steward-board-actions');
    // 116h 交付记录的登记项①在这里落地：等锁时占用者就在 wait.blockedBy 里，给一个「停掉占用者」。
    if (wait && String(wait.reason) === 'lock' && wait.blockedBy) {
      actions.appendChild(boardButton('stewardShell.board.stopBlocker',
        () => stopBlocker(String(wait.blockedBy)), { action: 'stop-blocker' }));
    }
    const lastRun = (row.lastRun && typeof row.lastRun === 'object') ? row.lastRun : null;
    if (lastRun && lastRun.live === true && lastRun.paused !== true) {
      actions.appendChild(boardButton('stewardShell.board.pause',
        () => runAction(sessionId, String(lastRun.id || ''), 'pause'), { action: 'pause' }));
    }
    if (lastRun && lastRun.live === true && lastRun.paused === true) {
      actions.appendChild(boardButton('stewardShell.board.resume',
        () => runAction(sessionId, String(lastRun.id || ''), 'resume'), { action: 'resume' }));
    }
    actions.appendChild(boardButton('stewardShell.board.prioritize', () => prioritize(sessionId), { action: 'prioritize' }));
    actions.appendChild(boardButton('stewardShell.board.stop', () => stopThread(sessionId), { action: 'stop' }));
    actions.appendChild(boardButton('stewardShell.board.openThread', () => openThread(sessionId), { action: 'open' }));
    actions.appendChild(boardButton('stewardShell.board.classicView', () => openClassic(sessionId), { action: 'classic' }));
    item.appendChild(actions);
    return item;
  }

  function renderMissionGroup(group) {
    const section = el('section', 'steward-board-mission');
    section.dataset.missionId = group.missionId;
    const head = el('header', 'steward-board-mission-head');
    // 事项聚合态【只读】行上的 aggregateState —— 本模块不写第二套聚合判据。
    head.appendChild(paintDot(el('span', 'steward-board-dot'), group.aggregateState));
    head.appendChild(el('strong', 'steward-board-mission-title', group.title));
    head.appendChild(el('span', 'steward-board-pill', t('stewardShell.board.threadCount', { n: group.threadCount || group.rows.length })));
    head.appendChild(el('span', 'steward-board-pill', acceptanceText(group)));
    head.appendChild(el('span', 'steward-board-pill', costText(group)));
    head.appendChild(boardButton('stewardShell.board.newThread', () => newThread(group.missionId), { newThread: '1' }));
    section.appendChild(head);
    const list = el('ul', 'steward-board-threads');
    for (const row of group.rows) list.appendChild(renderThreadRow(row));
    section.appendChild(list);
    return section;
  }

  function renderBoard() {
    renderStatusLine();
    renderArbiterFacts();
    const host = clear(byId('stewardBoardList'));
    if (!host) return 0;
    const groups = groupRows();
    if (!groups.length) {
      host.appendChild(el('p', 'steward-board-empty', t('stewardShell.board.statusEmpty')));
      return 0;
    }
    for (const group of groups) host.appendChild(renderMissionGroup(group));
    return groups.length;
  }

  // ── 行动作（全部经 steward-drawer.js 导出的那一段原语，不复制）─────────────────
  async function runAction(sessionId, runId, action) {
    const result = await stewardThreadRunAction({ api, sessionId, runId, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return false; }
    note(t(action === 'pause' ? 'stewardShell.board.paused' : 'stewardShell.board.resumed'));
    await refreshBoard();
    return true;
  }

  async function stopThread(sessionId) {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopped'));
    await refreshBoard();
    return true;
  }

  // 116h 登记项①：停在「等你」的线程仍持着 cwd 写锁，会挡住同目录所有线程。看到就能一键停掉它。
  async function stopBlocker(blockedBy) {
    const blocker = rows.find(row => String(row.sessionId) === blockedBy) || null;
    const title = blocker ? String(blocker.title || blockedBy) : blockedBy;
    if (globalThis.confirm && !globalThis.confirm(t('stewardShell.board.stopBlockerConfirm', { title }))) return false;
    const stopped = await stewardThreadStop({ api, sessionId: blockedBy });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopBlockerDone', { title }));
    await refreshBoard();
    return true;
  }

  async function prioritize(sessionId) {
    try {
      const result = await api('/api/steward/arbiter/prioritize', { method: 'POST', body: JSON.stringify({ sessionId }) });
      if (!result || result.ok !== true) { failNote((result && result.error) || 'prioritize_failed'); return false; }
      // 语义刻意做窄（116h）：只有【还在排队】的那一条能被提到队首；不在队列里不是错误，如实说。
      note(t(result.prioritized === true ? 'stewardShell.board.prioritized' : 'stewardShell.board.notQueued'));
    } catch (error) { failNote(error); return false; }
    await refreshBoard();
    return true;
  }

  // 批量只提供这一项（§8.10）：把每一条【还活着且没暂停】的班组回合逐条暂停。只有在跑的对话回合
  // （没有班组 run）暂停不了 —— 如实报数，不假装批量成功。
  async function pauseAll() {
    const pausable = rows.filter(row => row.lastRun && row.lastRun.live === true && row.lastRun.paused !== true);
    const turnsOnly = rows.filter(row => row.activeTurn === true && !(row.lastRun && row.lastRun.live === true));
    let done = 0;
    for (const row of pausable) {
      const result = await stewardThreadRunAction({ api, sessionId: String(row.sessionId), runId: String(row.lastRun.id || ''), action: 'pause' });
      if (result && result.ok === true) done += 1;
    }
    note(t('stewardShell.board.pauseAllDone', { done, turns: turnsOnly.length }));
    await refreshBoard();
    return done;
  }

  function newThread(missionId) {
    try {
      doc().dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId, fromSessionId: '' } }));
    } catch { /* 无 CustomEvent 的宿主 */ }
    setBoardOpen(false);
    return missionId;
  }

  async function openClassic(sessionId) {
    setBoardOpen(false);
    try { await openClassicWindow(sessionId); } catch (error) { failNote(error); }
    return sessionId;
  }

  // 焦点线程：用户显式点过就【钉住】，之后的自动挑选不再把它换掉（换回自动要么关掉这一件、
  // 要么点别的线程）。宽屏常驻时抽屉就是右栏本身（同一个节点），窄屏才退回覆盖式打开。
  function focusThread(sessionId) {
    pinnedId = String(sessionId || '');
    if (!syncNow() && drawer && typeof drawer.openThread === 'function') drawer.openThread(pinnedId);
    return pinnedId;
  }
  // 「打开」= 打开抽屉那一份并把看板收起来（不然它盖着自己要看的东西）。
  // 它同时把「关掉」过的偏好清掉：关掉的意思是「别自己占着右栏」，而不是「以后都别给我看」——
  // 用户显式点「打开」就是要看，这也是关掉之后把「现在这一件」请回来的那条路（否则没有回头路）。
  function openThread(sessionId) {
    setNowClosed(false);
    const id = focusThread(sessionId);
    setBoardOpen(false);
    return id;
  }

  // ── ③ 「现在这一件」：≥1000px 常驻，内容是同一个抽屉的 docked 挂法 ──────────────
  function nowClosed() {
    try { return localStorage.getItem(STEWARD_NOW_CLOSED_KEY) === '1'; }
    catch { return false; }
  }
  function setNowClosed(closed) {
    try {
      if (closed) localStorage.setItem(STEWARD_NOW_CLOSED_KEY, '1');
      else localStorage.removeItem(STEWARD_NOW_CLOSED_KEY);
    } catch { /* 本机偏好不可用时不影响本次会话 */ }
    return closed;
  }
  function wideEnough() {
    if (!globalThis.matchMedia) return true;
    return globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).matches;
  }

  function currentFocusId() {
    if (pinnedId && rows.some(row => String(row.sessionId) === pinnedId)) return pinnedId;
    const focus = focusThreadFor(threadViews());
    return focus ? String(focus.sessionId) : '';
  }

  function syncNow() {
    const now = byId('stewardNow');
    if (!now || !drawer) return false;
    const focusId = currentFocusId();
    const show = isStewardMode() && wideEnough() && !nowClosed() && Boolean(focusId);
    now.hidden = !show;
    if (!show) {
      // 程序性收起（窄屏／切壳／没有可看的线程）不是用户「关掉」，不落本机偏好。
      suppressCloseRecord = true;
      try { if (drawer.mountMode() === 'docked') drawer.closeDrawer(); drawer.setMount('overlay'); }
      finally { suppressCloseRecord = false; }
      return false;
    }
    drawer.setMount('docked');
    if (drawer.currentSessionId() !== focusId) drawer.openThread(focusId);
    return true;
  }

  function closeNow() {
    setNowClosed(true);
    pinnedId = '';
    syncNow();
    return true;
  }

  // ── 看板开关 ────────────────────────────────────────────────────────────────────
  function isBoardOpen() {
    const board = byId('stewardBoard');
    return Boolean(board) && board.hidden === false;
  }
  function setBoardOpen(open) {
    const board = byId('stewardBoard');
    const line = byId('stewardStatusLine');
    if (!board) return false;
    board.hidden = !open;
    if (line) line.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncPolling();
    if (open) void refreshBoard();
    return open;
  }

  // ── 刷新与轮询 ──────────────────────────────────────────────────────────────────
  // 行没变（304）就不重画正文 —— 既省事，也不会在用户正开着某个 chip 菜单时把它连根拔掉。
  async function refreshBoard() {
    const changed = await loadMissions();
    await loadArbiter();
    if (changed) renderBoard();
    else { renderStatusLine(); renderArbiterFacts(); }
    syncNow();
    if (changed) { try { onRowsChanged(rows.length); } catch { /* 宿主重画失败不该把看板打回去 */ } }
    return rows.length;
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_BOARD_POLL_MS_MIN, raw) : STEWARD_BOARD_POLL_MS_DEFAULT;
  }

  let pollTimer = 0;
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void refreshBoard(); }, pollIntervalMs());
  }
  // 唯一入口：看板打开 且 还在管家模式 且 页面可见 —— 任一为否立刻停表（零后台活动）。
  function syncPolling() {
    if (isBoardOpen() && isStewardMode() && !(doc() && doc().hidden)) startPolling();
    else stopPolling();
  }

  // 切离管家模式：看板收起、右栏收起、计时器清干净（本机的「关掉」偏好不受影响）。
  function leaveSteward() {
    const board = byId('stewardBoard');
    if (board) board.hidden = true;
    const line = byId('stewardStatusLine');
    if (line) line.setAttribute('aria-expanded', 'false');
    pinnedId = '';
    syncNow();
    stopPolling();
    return true;
  }

  function bindStewardBoard() {
    const line = byId('stewardStatusLine');
    if (line) {
      line.setAttribute('aria-expanded', 'false');
      line.onclick = () => setBoardOpen(!isBoardOpen());
    }
    const max = byId('stewardBoardMax');
    if (max) max.onchange = () => { void saveMaxParallel(max.value); };
    const pause = byId('stewardBoardPauseAllBtn');
    if (pause) pause.onclick = () => { void pauseAll(); };
    const classic = byId('stewardBoardClassicBtn');
    if (classic) classic.onclick = () => { setBoardOpen(false); switchWholeShell(); };
    const close = byId('stewardNowCloseBtn');
    if (close) close.onclick = () => closeNow();

    if (drawer && typeof drawer.setOnClosed === 'function') {
      // 关掉 docked 那一份（×／Esc／「交回管家」）＝ 关掉「现在这一件」，回单列并记住。
      drawer.setOnClosed(mount => { if (mount === 'docked' && !suppressCloseRecord) closeNow(); });
    }

    const document_ = doc();
    if (document_) {
      const focusFrom = event => {
        const id = event && event.detail && event.detail.sessionId;
        if (id) { pinnedId = String(id); syncNow(); }
      };
      document_.addEventListener(STEWARD_FOCUS_THREAD_EVENT, focusFrom);
      document_.addEventListener(STEWARD_OPEN_THREAD_EVENT, focusFrom);
      document_.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isBoardOpen()) { event.stopPropagation(); setBoardOpen(false); }
      });
      document_.addEventListener('visibilitychange', () => {
        syncPolling();
        if (isStewardMode() && !document_.hidden) void refreshBoard();
      });
    }
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      new MutationObserver(() => { if (isStewardMode()) void enterSteward(); else leaveSteward(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).addEventListener('change', () => syncNow()); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
    }
    if (isStewardMode()) void enterSteward();
    return true;
  }

  // 进壳：刷一次行与仲裁面（一次性，不起计时器），状态行随即有真数字，「现在这一件」随即就位。
  async function enterSteward() {
    await refreshBoard();
    syncPolling();
    return rows.length;
  }

  return Object.freeze({
    bindStewardBoard,
    setBoardOpen,
    isBoardOpen,
    refreshBoard,
    enterSteward,
    closeNow,
    syncNow,
    // 117g：返回带要显示「事项名」，读的是本模块已经取回来的那一份行（不另发请求、不另存一份）。
    missionTitleFor: sessionId => {
      const row = rows.find(item => String(item.sessionId) === String(sessionId));
      return row ? String(row.missionTitle || row.title || '') : '';
    },
    focusThreadId: () => currentFocusId(),
  });
}
