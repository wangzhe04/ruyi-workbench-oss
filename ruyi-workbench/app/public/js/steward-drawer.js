'use strict';

import './mission-state.js';
import { authHeaders } from './net.js';
import { acceptanceItems, activeAcceptanceIndex, taskProgress, elapsedLabel } from './preview-task-sheet.js';
import { describeTurnActivity } from './turn-activity.js';
import { createQuickSwitchChips } from './steward-chips.js';

// 第117波 117d：线程抽屉（27 号文 §8.2 L2 / §8.13 逐条）。
//
// 它回答的是「用户不看 2.0 消息流也要知道线程在说什么、该对它说什么」。区块顺序是契约（骨架静态写在
// index.html 里，本文件只填内容），自上而下：
//   ① 事项行 ② 线程页签 ③ 线程头 ④ 快切 chip ⑤ 它刚说 ⑥ 你可以说 ⑦ 接力 ⑧ 三问 ⑨ 验收项 ⑩ 现场 ⑪ 底部
//
// 复用而不是复制（117d 门）：
//   · 验收项 → preview-task-sheet.js 的 acceptanceItems / activeAcceptanceIndex / taskProgress / elapsedLabel；
//   · 三问   → turn-activity.js 的 describeTurnActivity（本文件不定义同名函数）；
//   · 五态   → mission-state.js 的 fromCard（UMD，import 后挂在 globalThis.MissionState，与 preview-shell 同款）；
//   · 快切   → steward-chips.js 的 createQuickSwitchChips（117g 的 2.0 顶栏与 117h 的看板行 mount 同一个工厂）。
//     本文件【不自己实现权限档的 PATCH】——线程权限只有 steward-chips.js 一个写口。
//
// 轮询纪律（延续 117b 的 C2a，本文件自己那一份）：全文件恰好一处 setInterval（startPolling）与一处
// clearInterval（stopPolling），唯一入口 syncPolling() 先判「抽屉开着 && 管家模式 && 页面可见」，
// 任一为否即停。触发点：抽屉开关、data-shell-mode 的 MutationObserver、visibilitychange。
//
// 「不经管家」（§8.13）：你可以说与底部输入框直接对线程说话 —— 线程在途走 POST /api/steer（插话通道），
// 空闲走 POST /api/chat/stream 开一个新回合（抽屉不渲染流，只把响应体读完就算送达）。

export const STEWARD_QUICK_REPLIES_MAX = 3;
export const STEWARD_DRAWER_POLL_MS_MIN = 5000;
export const STEWARD_DRAWER_POLL_MS_DEFAULT = 15000;
export const STEWARD_LAST_SAY_SENTENCES = 3;
export const STEWARD_NEW_THREAD_EVENT = 'steward:new-thread';
// 117h：抽屉的两种挂法（一份实现，不存在第二份抽屉区块渲染）。
//   overlay —— 用户主动打开的那一份：<1000px 全屏覆盖并补 aria-modal，≥1000px 右侧 390px 栏；
//   docked  —— 117h 的「现在这一件」：同一个 #stewardDrawer 节点被挪进 #stewardNowBody 常驻右栏。
// 挂法只影响「它挂在哪个父节点、要不要 aria-modal」，区块渲染与取数逐字节共用。
export const STEWARD_DRAWER_MOUNTS = Object.freeze(['overlay', 'docked']);
// 区块顺序即锁：静态件按这个数组在 index.html 里的出现顺序核对（改顺序＝改契约）。
export const STEWARD_DRAWER_BLOCK_IDS = Object.freeze([
  'stewardDrawerMission',
  'stewardDrawerTabs',
  'stewardDrawerHead',
  'stewardDrawerChips',
  'stewardDrawerLastSay',
  'stewardDrawerQuickReplies',
  'stewardDrawerRelay',
  'stewardDrawerActivity',
  'stewardDrawerAcceptance',
  'stewardDrawerScene',
  'stewardDrawerFoot',
]);

// 「它刚说」= 最后一条助手消息的【原话】前 ≤3 句（§8.13：不是模型另写的摘要）。中英句末标点同表。
export function lastSaySentences(text, max = STEWARD_LAST_SAY_SENTENCES) {
  const clean = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!clean) return '';
  const parts = clean.match(/[^。！？.!?]+[。！？.!?]*/g) || [clean];
  return parts.slice(0, Math.max(1, max)).join('').trim();
}

// 「你可以说」的来源是【确定性优先级】，不是模型生成（§8.13）：
//   待决的选项（question 的候选答案 / permission 的允许·拒绝） > 最后一句是问句 > 五态默认。
// 纯函数、零 DOM、零 import 依赖 —— dev-harness/unit/steward-quick-replies.test.js 直接 import 跑真值表。
export function quickRepliesFor({ pending = null, lastAssistantText = '', state = '', t = key => key } = {}) {
  const label = key => String(t(key));
  const type = String((pending && pending.type) || '');
  if (type === 'question') {
    const questions = Array.isArray(pending.questions) ? pending.questions : [];
    const question = questions[0] || null;
    const options = (question && Array.isArray(question.options)) ? question.options : [];
    const replies = options.slice(0, STEWARD_QUICK_REPLIES_MAX)
      .map(option => ({
        kind: 'question',
        interventionId: String(pending.id || ''),
        questionId: String((question && question.id) || ''),
        optionId: String((option && option.id) || ''),
        // §「问句选项 opt.label || opt.value」——与 interaction-prompts.js 同一取值口径。
        label: String((option && (option.label || option.value)) || ''),
      }))
      .filter(reply => reply.optionId && reply.label);
    if (replies.length) return replies;
  }
  if (type === 'permission') {
    return [
      { kind: 'permission', interventionId: String(pending.id || ''), behavior: 'allow', label: label('stewardShell.drawer.reply.allow') },
      { kind: 'permission', interventionId: String(pending.id || ''), behavior: 'deny', label: label('stewardShell.drawer.reply.deny') },
    ];
  }
  const tail = String(lastAssistantText || '').trim();
  if (/[？?]$/.test(tail)) {
    return [
      { kind: 'say', text: label('stewardShell.drawer.reply.yes'), label: label('stewardShell.drawer.reply.yes') },
      { kind: 'say', text: label('stewardShell.drawer.reply.no'), label: label('stewardShell.drawer.reply.no') },
    ];
  }
  const say = key => ({ kind: 'say', text: label(key), label: label(key) });
  if (state === 'running' || state === 'dispatching') return [say('stewardShell.drawer.reply.holdOn')];
  if (state === 'stopped' || state === 'done') {
    return [say('stewardShell.drawer.reply.continue'), say('stewardShell.drawer.reply.otherWay')];
  }
  return [say('stewardShell.drawer.reply.continue')];
}

// ── 线程动作原语（117d 抽屉与 117h 看板行【共用同一段】，不复制）────────────────────
// 暂停／继续只对「还活着的那一条 run」有意义：快照里最后一条 live run 就是它（与抽屉底部按钮
// 二选一的判据同源）。看板行拿到的是 GET /api/missions/:id 的同一份快照，所以判据也是同一个。
export function pausableRunOf(snapshot) {
  const runs = (snapshot && Array.isArray(snapshot.runs)) ? snapshot.runs : [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run && run.live === true) return run;
  }
  return null;
}
// 统一 Run 控制端点（pause／resume／retry_node…）。返回稳定信封，调用方自己说人话。
export async function stewardThreadRunAction({ api, sessionId, runId, action }) {
  if (typeof api !== 'function' || !sessionId || !runId) return { ok: false, error: 'not_found' };
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, {
      method: 'POST', body: JSON.stringify({ sessionId, action }),
    });
    return (result && result.ok === true) ? result : { ok: false, error: (result && result.error) || 'run_action_failed' };
  } catch (error) { return { ok: false, error }; }
}
// 停任何回合（含仲裁器队列里还没轮到的那一条：116h 的 cancelQueuedTurn 就挂在这条路由上）。
// 117h 的「停掉占用者」用的也是它 —— 等锁那一行点一下，停的就是 blockedBy 指的那条线程。
export async function stewardThreadStop({ api, sessionId }) {
  if (typeof api !== 'function' || !sessionId) return { ok: false, error: 'not_found' };
  try {
    const stopped = await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
    return (stopped && stopped.ok === false) ? { ok: false, error: stopped.error || 'stop_failed' } : { ok: true };
  } catch (error) { return { ok: false, error }; }
}

export function createStewardDrawer({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  applyShellMode = null,
  openSession = async () => {},
} = {}) {
  const doc = () => globalThis.document || null;
  const byId = id => (doc() ? doc().getElementById(id) : null);

  let sessionId = '';
  let session = null;             // GET /api/sessions/:id 的 session
  let resumable = null;           // 同一响应的 resumable（live 判定：在途才走插话通道）
  let missionRows = [];           // GET /api/missions 里与本线程同事项的行（线程行）
  let missionRow = null;          // 其中本线程自己那一行
  let snapshot = null;            // GET /api/missions/:id 的 snapshot（验收项与控制面）
  let pendingForThread = null;    // GET /api/interventions 里本线程最早的一条未决
  // 117g/117h 的三条迟绑定接线（与 117c 的 setPickTargetHandler 同一纪律：不让抽屉 import 那两个
  // 模块，也不动 steward-shell.js 里被静态锁逐字钉住的那一行构造调用）。
  let mountMode = 'overlay';      // 'overlay' | 'docked'（见 STEWARD_DRAWER_MOUNTS）
  let onClosed = () => {};        // 117h：关抽屉时告诉「现在这一件」它被关掉了
  let openClassicWindow = null;   // 117g：统一的「2.0 视窗」入口（切经典壳＋选中会话＋顶部返回带）

  const chips = createQuickSwitchChips({
    api, t, state,
    // chip 改完立即回填：PATCH 的响应已经把新 session 交回来了，这里只需把抽屉其它面刷新一遍。
    onChanged: next => { session = next || session; renderAll(); },
  });

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
    const target = byId('stewardDrawerNote');
    if (target) target.textContent = String(text || '');
  }
  function failNote(error) {
    note(t('stewardShell.drawer.failed', { error: String((error && error.message) || error || 'failed') }));
  }

  // ── 五态：只经 mission-state.js（全仓唯一判据），人话走 i18n（LABELS 是中文单语） ──────
  function threadStateOf(card) {
    const missionState = globalThis.MissionState;
    if (!card || !missionState || typeof missionState.fromCard !== 'function') return '';
    return String(missionState.fromCard(card).state || '');
  }
  function stateLabel(value) {
    return value ? t(`stewardShell.drawer.state.${value}`) : '';
  }

  function isLive() {
    if (resumable && resumable.live === true) return true;
    return Boolean(missionRow) && threadStateOf(missionRow) === 'running';
  }

  // ── 取数 ────────────────────────────────────────────────────────────────────
  async function loadThreadSlice() {
    if (!sessionId) return;
    const id = sessionId;
    const [sessionRes, interventionsRes] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(id)}`).catch(() => null),
      api('/api/interventions?limit=100').catch(() => null),
    ]);
    if (id !== sessionId) return;                    // 期间用户切了线程，这一趟作废
    if (sessionRes && sessionRes.ok !== false && sessionRes.session) {
      session = sessionRes.session;
      resumable = sessionRes.resumable || null;
    }
    const list = (interventionsRes && Array.isArray(interventionsRes.pending)) ? interventionsRes.pending : [];
    pendingForThread = list.find(item => item && String(item.sessionId) === id) || null;
  }

  async function loadMissionSlice() {
    if (!sessionId) return;
    const id = sessionId;
    const [missionsRes, snapshotRes] = await Promise.all([
      api('/api/missions?limit=200').catch(() => null),
      api(`/api/missions/${encodeURIComponent(id)}`).catch(() => null),
    ]);
    if (id !== sessionId) return;
    const rows = (missionsRes && Array.isArray(missionsRes.missions)) ? missionsRes.missions : [];
    missionRow = rows.find(row => row && String(row.sessionId) === id) || null;
    const missionId = String((missionRow && missionRow.missionId) || (session && session.missionId) || '');
    missionRows = missionId ? rows.filter(row => row && String(row.missionId) === missionId) : (missionRow ? [missionRow] : []);
    snapshot = (snapshotRes && snapshotRes.snapshot) || null;
  }

  // ── ① 事项行 ────────────────────────────────────────────────────────────────
  function renderMission() {
    const titleNode = byId('stewardDrawerMissionTitle');
    const acceptanceNode = byId('stewardDrawerMissionAcceptance');
    const costNode = byId('stewardDrawerMissionCost');
    if (!titleNode || !acceptanceNode || !costNode) return;
    // 事项【容器】的标题不在 GET /api/missions 的行里（那些行是线程行，只带 missionId 与聚合事实；
    // 容器标题目前只有 steward_missions 工具面拿得到）。所以按确定性顺序回落：
    //   ① 「自成事项」的那条线程（sessionId === missionId）的标题就是事项标题；
    //   ② 显式事项容器：退到【本线程】自己的标题（不猜、不拿兄弟线程的名字冒充事项名）；
    //   ③ 一条行都没有（线程还没进投影）：说「未归事项」。
    const missionId = String((missionRow && missionRow.missionId) || '');
    const root = missionRows.find(row => String(row.sessionId) === missionId) || missionRow || null;
    titleNode.textContent = root ? String(root.title || missionId) : t('stewardShell.drawer.missionUnfiled');
    const acceptance = (missionRow && missionRow.acceptance) || null;
    const total = Math.max(0, Number(acceptance && acceptance.total) || 0);
    acceptanceNode.textContent = total
      ? t('stewardShell.drawer.acceptanceCount', { done: Math.max(0, Number(acceptance.done) || 0), total })
      : t('stewardShell.drawer.acceptanceNone');
    costNode.textContent = costText();
  }

  function costText() {
    const costs = (missionRow && missionRow.cost && missionRow.cost.costsByCurrency) || {};
    const spent = Object.entries(costs)
      .filter(([, amount]) => Number.isFinite(Number(amount)))
      .map(([currency, amount]) => `${currency} ${Number(amount).toFixed(4)}`)
      .join(' · ');
    if (!spent) return t('stewardShell.drawer.costNone');
    const budget = (missionRow && missionRow.budget) || {};
    const maxCost = Number(budget.maxCost);
    if (Number.isFinite(maxCost) && maxCost > 0) {
      return t('stewardShell.drawer.costBudget', { cost: spent, budget: `${String(budget.currency || '')} ${maxCost}`.trim() });
    }
    return t('stewardShell.drawer.cost', { cost: spent });
  }

  // ── ② 线程页签 ──────────────────────────────────────────────────────────────
  function renderTabs() {
    const host = clear(byId('stewardDrawerTabs'));
    if (!host) return;
    for (const row of missionRows) {
      const tab = el('button', 'steward-drawer-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      const selected = String(row.sessionId) === sessionId;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.dataset.sessionId = String(row.sessionId);
      const dot = el('span', 'steward-drawer-dot');
      dot.dataset.state = threadStateOf(row);
      tab.append(dot, el('span', 'steward-drawer-tab-title', String(row.title || row.sessionId)));
      tab.onclick = () => { if (!selected) openThread(String(row.sessionId)); };
      host.appendChild(tab);
    }
    // 「＋ 线程」：创建本身仍经管家（委托书表单归 117e），这里只派事件 + 把输入区 chip 置为
    // 「在事项下新开」，让用户下一句话直接落到这个事项里。
    const add = el('button', 'steward-drawer-tab', t('stewardShell.drawer.newThread'));
    add.type = 'button';
    add.dataset.newThread = '1';
    add.title = t('stewardShell.drawer.newThreadHint');
    add.onclick = () => {
      const missionId = String((missionRow && missionRow.missionId) || '');
      try {
        doc().dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId, fromSessionId: sessionId } }));
      } catch { /* 无 CustomEvent 的宿主 */ }
    };
    host.appendChild(add);
  }

  // ── ③ 线程头 ────────────────────────────────────────────────────────────────
  function renderHead() {
    const titleNode = byId('stewardDrawerTitle');
    const stateNode = byId('stewardDrawerState');
    const waitNode = byId('stewardDrawerWait');
    if (titleNode) titleNode.textContent = String((session && session.title) || (missionRow && missionRow.title) || sessionId);
    if (stateNode) stateNode.textContent = stateLabel(threadStateOf(missionRow));
    if (!waitNode) return;
    const wait = (missionRow && missionRow.wait) || null;
    const label = wait ? String(wait.label || '') : '';
    waitNode.textContent = label;
    waitNode.hidden = !label;
  }

  // ── ⑤ 它刚说 ────────────────────────────────────────────────────────────────
  function lastAssistantText() {
    const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === 'assistant' && String(message.content || '').trim()) return String(message.content);
    }
    return '';
  }

  function renderLastSay() {
    const quote = byId('stewardDrawerLastSayText');
    if (!quote) return;
    const said = lastSaySentences(lastAssistantText());
    quote.textContent = said || t('stewardShell.drawer.lastSayEmpty');
  }

  // ── ⑥ 你可以说 ──────────────────────────────────────────────────────────────
  function renderQuickReplies() {
    const host = clear(byId('stewardDrawerQuickRepliesRow'));
    if (!host) return;
    const replies = quickRepliesFor({
      pending: pendingForThread,
      // 问句判定看的是【整条原话】的收尾，不是「它刚说」那 ≤3 句的截断 —— 把问句截掉再判，
      // 就会把「它在问你」误报成「它没在问」。
      lastAssistantText: lastAssistantText(),
      state: threadStateOf(missionRow),
      t,
    }).slice(0, STEWARD_QUICK_REPLIES_MAX);
    for (const reply of replies) {
      const button = el('button', 'steward-drawer-reply', reply.label);
      button.type = 'button';
      button.dataset.replyKind = reply.kind;
      button.onclick = () => runQuickReply(reply);
      host.appendChild(button);
    }
  }

  // ── ⑦ 接力关系（本波只列同事项其它线程；真正的接力图归 120） ────────────────
  function renderRelay() {
    const section = byId('stewardDrawerRelay');
    const list = clear(byId('stewardDrawerRelayList'));
    if (!section || !list) return;
    const others = missionRows.filter(row => String(row.sessionId) !== sessionId);
    section.hidden = others.length === 0;
    for (const row of others) {
      const item = el('li');
      const dot = el('span', 'steward-drawer-dot');
      dot.dataset.state = threadStateOf(row);
      item.append(dot, doc().createTextNode(` ${String(row.title || row.sessionId)} · ${stateLabel(threadStateOf(row))}`));
      list.appendChild(item);
    }
  }

  // ── ⑧ 三问 ──────────────────────────────────────────────────────────────────
  // 没有「拿 turnActivity 快照」的 HTTP 面：预览壳那一份是它自己的事件流喂出来的累加器
  // （preview-shell.js 的 turnActivity.consume(event)），抽屉这一路只轮询，拿不到那条流。
  // 所以这里【只用权威字段】拼一个最小快照喂给同一个 describeTurnActivity：真有未决就是 waiting_you，
  // 真在等锁/等并发位/等预算（116h 的 wait）就是 waiting_resource，其余一律 idle → 显示「暂无」。
  // 绝不因为「线程在跑」就编一个 thinking（§8.1 原则 2：不知道就说不知道）。
  function activitySnapshot() {
    const wait = (missionRow && missionRow.wait) || null;
    const reason = String((wait && wait.reason) || '');
    if (pendingForThread) {
      return { phase: 'waiting_you', waiting: { kind: String(pendingForThread.type || ''), label: String(pendingForThread.toolName || '') }, turnActive: false, notices: [] };
    }
    if (reason && reason !== 'user') {
      const blockedBy = wait && wait.blockedBy ? [String(wait.blockedBy)] : [];
      return { phase: 'waiting_resource', resourceWait: { resources: [String(wait.label || reason)], blockers: blockedBy }, turnActive: false, notices: [] };
    }
    return null;
  }

  function renderActivity() {
    const doing = byId('stewardDrawerActivityDoing');
    const progress = byId('stewardDrawerActivityProgress');
    const waiting = byId('stewardDrawerActivityWaiting');
    const view = describeTurnActivity(activitySnapshot(), t);
    if (doing) doing.textContent = (view && view.head) || t('stewardShell.drawer.none');
    if (progress) progress.textContent = progressText();
    if (waiting) {
      const wait = (missionRow && missionRow.wait) || null;
      waiting.textContent = (wait && wait.label) || (view && view.action) || t('stewardShell.drawer.none');
    }
  }

  // 「干到哪」只报可核验的事实：验收 a/b（taskProgress）＋ 从建线程到现在的耗时（elapsedLabel）。
  function progressText() {
    const parts = [];
    const bar = taskProgress(null, snapshot);
    if (bar.total > 0) parts.push(t('stewardShell.drawer.acceptanceCount', { done: bar.done, total: bar.total }));
    const started = (snapshot && snapshot.createdAt) || (session && session.createdAt) || '';
    const elapsed = started ? elapsedLabel(started, new Date()) : '';
    if (elapsed) parts.push(elapsed);
    return parts.length ? parts.join(' · ') : t('stewardShell.drawer.none');
  }

  // ── ⑨ 验收项 ────────────────────────────────────────────────────────────────
  function renderAcceptance() {
    const list = clear(byId('stewardDrawerAcceptanceList'));
    if (!list) return;
    const items = acceptanceItems(snapshot);
    const active = activeAcceptanceIndex(items);
    if (!items.length) {
      const empty = el('li', 'steward-drawer-scene-empty', t('stewardShell.drawer.acceptanceEmpty'));
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const row = el('li', index === active ? 'is-active' : '', item.desc);
      row.dataset.status = item.status;
      if (index === active) row.title = t('stewardShell.drawer.acceptanceActive');
      list.appendChild(row);
    });
  }

  // ── ⑪ 底部按钮态：暂停／继续按五态二选一显示 ────────────────────────────────
  // 判据住在模块顶层的 pausableRunOf（117h 看板行复用同一段），这里只喂本抽屉的快照。
  function pausableRun() { return pausableRunOf(snapshot); }

  function renderFoot() {
    const pause = byId('stewardDrawerPauseBtn');
    const resume = byId('stewardDrawerResumeBtn');
    const run = pausableRun();
    const paused = Boolean(run && run.paused === true);
    if (pause) pause.hidden = !run || paused;
    if (resume) resume.hidden = !run || !paused;
  }

  function renderAll() {
    chips.setSession(session);
    renderMission();
    renderTabs();
    renderHead();
    renderLastSay();
    renderQuickReplies();
    renderRelay();
    renderActivity();
    renderAcceptance();
    renderFoot();
  }

  // ── 直连发话（§8.13「不经管家」）────────────────────────────────────────────
  // 在途 → 插话通道；空闲 → 开一个新回合。抽屉不渲染流，把响应体读完就算送达（读完＝服务端
  // 那一路已经落盘，用户回 2.0 视窗看得到；这里不做第二个消息渲染器）。
  async function sayToThread(text) {
    const message = String(text || '').trim();
    if (!message || !sessionId) return false;
    try {
      if (isLive()) {
        const steered = await api('/api/steer', { method: 'POST', body: JSON.stringify({ sessionId, text: message }) });
        if (!steered || steered.ok === false) { failNote((steered && steered.error) || 'steer_failed'); return false; }
        note(t('stewardShell.drawer.steered'));
        return true;
      }
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, message }),
      });
      if (!response.ok) { failNote(await response.text()); return false; }
      await response.text();       // 读到结束即送达；NDJSON 正文由 2.0 视窗与经典流负责呈现
      note(t('stewardShell.drawer.sent'));
      return true;
    } catch (error) { failNote(error); return false; }
  }

  async function runQuickReply(reply) {
    if (!reply) return;
    try {
      if (reply.kind === 'permission') {
        const decided = await api('/api/permission/decision', {
          method: 'POST',
          body: JSON.stringify({ requestId: reply.interventionId, behavior: reply.behavior }),
        });
        if (!decided || decided.ok !== true) { failNote((decided && decided.error) || 'decision_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } else if (reply.kind === 'question') {
        const answered = await api('/api/chat/answer', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            questionId: reply.interventionId,
            answers: [{ questionId: reply.questionId, selectedOptionIds: [reply.optionId], otherText: '' }],
            content: reply.label,
          }),
        });
        if (!answered || answered.ok !== true) { failNote((answered && answered.error) || 'answer_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } else if (!(await sayToThread(reply.text))) return;
    } catch (error) { failNote(error); return; }
    await refreshOnce();
  }

  // ── ③/⑩ 2.0 视窗：切到经典壳并选中该会话（顶部返回带归 117g） ────────────────
  // 117g 起，「2.0 视窗」「看全文」「看改动」三处统一调 openClassicWindow(sessionId)：切经典壳 +
  // 选中该会话 + 显示顶部返回带。注入缺席时退回 117d 的两步做法（切壳 + 选中，只是没有返回带）。
  async function openClassicView() {
    const id = sessionId;
    closeDrawer();
    if (typeof openClassicWindow === 'function') { try { await openClassicWindow(id); } catch (error) { failNote(error); } return; }
    if (typeof applyShellMode === 'function') applyShellMode('classic');
    if (id) { try { await openSession(id); } catch (error) { failNote(error); } }
  }

  // ── ⑪ 整单回退：退到本线程【第一条用户消息】那一回合之前 ─────────────────────
  // 口径与 117d 第 0 步同款：rewindSession 按「要删掉的那一回合的第一条用户消息」定位，所以
  // targetTurnSeq 取 messages 里第一条 user 消息自己的 turnSeq（S4b 起每条新用户消息都打了戳），
  // 没有戳的老会话回落 1（第一回合）。
  function firstUserTurnSeq() {
    const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
    for (const message of messages) {
      if (!message || message.role !== 'user') continue;
      const seq = Number(message.turnSeq);
      return Number.isFinite(seq) && seq > 0 ? seq : 1;
    }
    return 0;
  }

  async function rewindAll() {
    const target = firstUserTurnSeq();
    if (!target) { note(t('stewardShell.drawer.rewindNoTarget')); return; }
    if (globalThis.confirm && !globalThis.confirm(t('stewardShell.drawer.rewindConfirm'))) return;
    try {
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
      const rewound = await api('/api/session/rewind', {
        method: 'POST',
        body: JSON.stringify({ sessionId, targetTurnSeq: target, rollbackFiles: true }),
      });
      if (!rewound || rewound.ok === false) { failNote((rewound && rewound.error) || 'rewind_failed'); return; }
      note(t('stewardShell.drawer.rewindDone'));
    } catch (error) { failNote(error); return; }
    await refreshOnce();
  }

  async function runAction(action) {
    const run = pausableRun();
    if (!run) { note(t('stewardShell.drawer.noPausableRun')); return; }
    const result = await stewardThreadRunAction({ api, sessionId, runId: run.id, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return; }
    await refreshOnce();
  }

  async function stopThread() {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return; }
    await refreshOnce();
  }

  // ── 刷新与轮询 ──────────────────────────────────────────────────────────────
  async function refreshOnce() {
    await loadThreadSlice();
    await loadMissionSlice();
    renderAll();
  }

  // 轮询只刷新「本线程切片」这两面（§117d 刷新纪律逐字）：会话原文与未决清单。事项聚合与验收快照
  // 在打开、切线程、任一写动作之后各刷一次 —— 它们不会因为等待而秒变。
  async function pollSlice() {
    await loadThreadSlice();
    renderAll();
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_DRAWER_POLL_MS_MIN, raw) : STEWARD_DRAWER_POLL_MS_DEFAULT;
  }

  let pollTimer = 0;
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollSlice, pollIntervalMs());
  }
  // 唯一入口：抽屉开着 且 还在管家模式 且 页面可见 —— 任一为否立刻停表（零后台活动）。
  function syncPolling() {
    if (isOpen() && isStewardMode() && !(doc() && doc().hidden)) startPolling();
    else stopPolling();
  }

  // ── 开关 ────────────────────────────────────────────────────────────────────
  function isOpen() {
    const drawer = byId('stewardDrawer');
    return Boolean(drawer) && drawer.hidden === false;
  }

  function applyModal() {
    const drawer = byId('stewardDrawer');
    if (!drawer) return;
    const narrow = Boolean(globalThis.matchMedia) && !globalThis.matchMedia('(min-width: 1000px)').matches;
    // docked（「现在这一件」）永远是常驻栏，不是模态 —— 它只在 ≥1000px 存在，窄屏一律回 overlay。
    if (narrow && mountMode !== 'docked') drawer.setAttribute('aria-modal', 'true');
    else drawer.removeAttribute('aria-modal');
  }

  // 117h：换挂法 = 把【同一个】 #stewardDrawer 节点搬到另一个父节点下，并打上 data-mount 供样式层
  // 改定位（docked 交给 #stewardNow 那条常驻右栏，overlay 回到管家壳自己）。区块渲染一个字节不改。
  function setMount(mode) {
    const next = mode === 'docked' ? 'docked' : 'overlay';
    const drawer = byId('stewardDrawer');
    if (!drawer) return mountMode;
    mountMode = next;
    drawer.dataset.mount = next;
    const host = next === 'docked' ? byId('stewardNowBody') : byId('stewardShell');
    if (host && drawer.parentNode !== host) host.appendChild(drawer);
    applyModal();
    return mountMode;
  }

  async function openThread(nextId) {
    const id = String(nextId || '');
    if (!id) return;
    const drawer = byId('stewardDrawer');
    const shell = byId('stewardShell');
    if (!drawer) return;
    sessionId = id;
    session = null; resumable = null; snapshot = null; pendingForThread = null;
    missionRow = null; missionRows = [];
    drawer.hidden = false;
    if (shell) shell.dataset.drawer = 'open';
    applyModal();
    note('');
    renderAll();
    syncPolling();
    const title = byId('stewardDrawerTitle');
    if (title && typeof title.focus === 'function') { title.tabIndex = -1; title.focus(); }
    await refreshOnce();
  }

  // 「交回管家」＝关抽屉、焦点回输入框、输入区 chip 恢复「→ 如意」（composer.resetComposer 由宿主接）。
  function closeDrawer({ focusComposer = false } = {}) {
    const drawer = byId('stewardDrawer');
    const shell = byId('stewardShell');
    const wasOpen = isOpen();
    if (drawer) { drawer.hidden = true; drawer.removeAttribute('aria-modal'); }
    if (shell) delete shell.dataset.drawer;
    chips.closeMenu();
    sessionId = '';
    stopPolling();
    // 117h：docked 那一份被关掉 = 用户「关掉」了「现在这一件」（Esc 与 × 也算），本机偏好由
    // steward-board.js 记；抽屉自己不认识 localStorage。
    if (wasOpen) { try { onClosed(mountMode); } catch { /* 宿主收摊失败不该把抽屉留在半开 */ } }
    if (!focusComposer) return;
    const input = byId('stewardComposerInput');
    if (input && typeof input.focus === 'function') input.focus();
  }

  function bindStewardDrawer() {
    const chipsHost = byId('stewardDrawerChips');
    if (chipsHost) chips.mount(chipsHost);

    const on = (id, handler) => { const node = byId(id); if (node) node.onclick = handler; };
    on('stewardDrawerCloseBtn', () => closeDrawer());
    on('stewardDrawerHandBackBtn', () => closeDrawer({ focusComposer: true }));
    on('stewardDrawerClassicBtn', () => { openClassicView(); });
    on('stewardDrawerFullTextBtn', () => { openClassicView(); });
    on('stewardDrawerChangesBtn', () => { openClassicView(); });
    on('stewardDrawerSendBtn', () => { submitDirect(); });
    on('stewardDrawerPauseBtn', () => { runAction('pause'); });
    on('stewardDrawerResumeBtn', () => { runAction('resume'); });
    on('stewardDrawerStopBtn', () => { stopThread(); });
    on('stewardDrawerRewindBtn', () => { rewindAll(); });

    const input = byId('stewardDrawerInput');
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        submitDirect();
      });
    }

    const document_ = doc();
    if (document_) {
      document_.addEventListener('steward:open-thread', event => { openThread(event && event.detail && event.detail.sessionId); });
      document_.addEventListener('steward:focus-thread', event => { openThread(event && event.detail && event.detail.sessionId); });
      document_.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) { event.stopPropagation(); closeDrawer({ focusComposer: true }); }
      });
      document_.addEventListener('visibilitychange', syncPolling);
    }
    // 切离管家模式即收摊（谁改的 data-shell-mode 都算）。与 steward-shell.js 的对话观察者各自独立：
    // 那一条的形状被 117c 的静态锁逐字钉住，不能把两件事塞进同一个回调里。
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      new MutationObserver(() => { if (!isStewardMode()) closeDrawer(); else syncPolling(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia('(min-width: 1000px)').addEventListener('change', applyModal); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
    }
    return true;
  }

  async function submitDirect() {
    const input = byId('stewardDrawerInput');
    const text = input ? String(input.value || '').trim() : '';
    if (!text) return;
    if (input) input.value = '';
    if (await sayToThread(text)) await refreshOnce();
  }

  return Object.freeze({
    bindStewardDrawer,
    openThread,
    closeDrawer,
    isOpen,
    // 117h「现在这一件」与 117g 顶栏复用：当前线程与 chip 控件本体（同一份数据，不复制状态）。
    currentSessionId: () => sessionId,
    // 117g/117h：三条迟绑定接线 + 挂法开关（构造调用那一行被 steward-drawer.static I3 逐字钉住，
    // 新依赖一律走 setter，不加构造参数）。
    setClassicWindow: handler => { openClassicWindow = typeof handler === 'function' ? handler : null; },
    setOnClosed: handler => { onClosed = typeof handler === 'function' ? handler : () => {}; },
    setMount,
    mountMode: () => mountMode,
    refreshOnce,
    chips,
  });
}
