'use strict';

// EC-D：会话侧栏、任务/授权状态、历史渲染、空态与 Playbook 领域。
import { state, MSG_WINDOW_STEP, MSG_WINDOW_TAIL, MSG_WINDOW_THRESHOLD } from './state.js';
import { api } from './net.js';
import { $, el, autoGrow, fileBasename, toast, chatProviders } from './util.js';
import { icon } from './icons.js';
import { getLocale, setLocale, t, tCount } from './i18n.js';
// 118a: 壳无关欢迎向导。经典壳与预览壳引用同一个模块;provider 序列化复用设置页的同一实现。
// 118d: registerOnboardingWizard 把本壳持有的唯一实例登记给帮助菜单复用(同 registerHelpViewer 口径)。
import { createOnboardingWizardDomain, registerOnboardingWizard, shouldShowOnboarding } from './onboarding-wizard.js';
// 118a-fix: 应用内手册阅读器。与向导同一口径:模块壳无关,由本壳注入环境依赖后持有唯一实例。
import { createHelpViewerDomain, registerHelpViewer } from './help-viewer.js';
// 118b: 体检项的人话映射(纯函数)。首跑卡的「体检摘要」与设置页的体检行读同一张表。
import { healthSummaryText } from './health-i18n.js';
import { providerDraftFromPreset } from './provider-settings.js';
import {
  activeTurnUserIsPersisted,
  captureScrollAnchor,
  messageDomKey,
  messageRenderSignature,
  restoreScrollAnchor,
  visibleSessionMessageEntries,
  weightedMessageTailStart,
} from './turn-narrative.js';
import { ARTIFACT_KIND_ICON } from './artifact-changes.js';
// 121-K2b（34 号文 §6.2）：线上事件名的那一份登记表（与 13r 的显式登记一一对拍，不各写一遍）。
import { EVENT_STREAM_ROW_EVENTS, EVENT_STREAM_LIVE_EVENT } from './event-stream.js';

export function createSessionExperienceDomain({
  // 121-K2b（34 号文 §6.2）：组合根那【一条】事件流。工作台视角用它两件事：①「它正在跑」那张卡
  // 改吃 thread.live（3 s 轮询降为断连兜底）；②换会话时报一次新的在场信号（§4.3 —— 服务端只在
  // 连接时读 ?lens=&sessionId=，所以换会话＝重连，这是唯一的写口）。
  eventStream = null,
  apiErrText = error => String(error && error.message || error || ''),
  // 118a-fix: 手册正文的落 DOM 与高亮。组合根透进来的就是 chat-render-primitives 那一份已消毒管线,
  // 阅读器不另造解析器,也不自己拼 HTML。
  renderMarkdownInto = container => container,
  highlightIn = () => {},
  openModal = () => {},
  switchSettingsTab = () => {},
  activeTurns = new Map(),
  openCapPopover = () => {},
  openPermPopover = () => {},
  sendPrompt = async () => {},
  syncStreamingUi = () => {},
  updateSendBtn = () => {},
  messageShell,
  buildModal = () => null,
  renderContextMeter = () => {},
  isProviderMode = () => false,
  activeProviderObj = () => null,
  currentEngineMeta = () => ({}),
  engineVisual = () => ({}),
  engineLabel = () => '',
  currentModelId = () => '',
  openRenamePopover = () => {},
  steerPendingList = [],
  steeredSeen = [],
  resetStickyScroll = () => {},
  scrollMessagesToBottom = () => {},
  mountActiveTurn = () => false,
  renderWorkspacePicker = () => {},
  updateSkillBadge = () => {},
  updateEngineDependentUI = () => {},
  renderStaticMessage = () => null,
  latestUsage = () => null,
  pickWorkspaceNative = async () => '',
  playbookDisplayName = playbook => String(playbook && playbook.title || ''),
  playbookDisplayDescription = playbook => String(playbook && playbook.desc || ''),
  playbookDisplayUnavailableReason = () => '',
  playbookStatusText = () => '', // 127-⑧:状态一句话(skills-memory 那一份);缺席时不出状态行
  playbookInputLabel = (_playbook, input) => String(input && input.label || ''),
  // 121-K7（§8.4）：向导完成页要落在管家视角。组合根注入 js/shell-mode.js 那一个 applyShellMode
  // （唯一写者不变，本域只转手）；缺席时回落成「不切」，向导照常走完。
  applyShellMode = () => 'classic',
  // 128f-⑫（审计 D／E）：右栏打开着的页签（变更、文件、审计…）重读一遍。组合根注入 navigation-controls 那一份。
  refreshToolPane = () => {},
} = {}) {
// 118a: 本壳持有的向导实例。经典壳有原生文件夹选择器与设置页入口,直接注入;向导模块本身壳无关。
// 118a-fix: 手册阅读器实例。向导完成页的「打开手册」落在这里:取 /api/help/doc 的 markdown,
// 用上面这条既有管线渲染在应用内,不再给用户一行路径让他自己去开文件。
// 118b: 建好后立刻登记为全应用共用实例,设置域的体检行「怎么办」经 openSharedHelpDoc() 复用同一个,
// 不再多造一个阅读器,也不用往组合根加接线。
const helpViewer = registerHelpViewer(createHelpViewerDomain({ api, el, t, toast, apiErrText, getLocale, renderMarkdownInto, highlightIn }));
function openHelpViewer(options) { return helpViewer.openHelpViewer(options); }
const onboardingWizard = registerOnboardingWizard(createOnboardingWizardDomain({
  state,
  api,
  el,
  t,
  toast,
  apiErrText,
  getLocale,
  setLocale,
  providerDraftFromPreset,
  pickWorkspace: () => pickWorkspaceNative(),
  openSettings: tab => { openModal('settingsModal'); switchSettingsTab(tab || 'basic', true); },
  openPlaybook: playbook => openPlaybookModal(playbook),
  openHelpViewer: (...args) => openHelpViewer(...args), // 118a-fix: 完成页「打开手册」走应用内阅读器
  onConfigChanged: () => { updateEngineDependentUI(); renderWorkspacePicker(); },
  // 121-K7（34 号文 §8.4「完成页落在管家视角」）：走完向导切回管家。转注入组合根那一个
  // applyShellMode（js/shell-mode.js 仍是 data-shell-mode 的唯一写者，这里只是把它递下去）。
  onFinished: () => applyShellMode('steward'),
}));
// 「开始引导」/「重新打开引导」共用的入口。设置页按钮由组合根注入本函数。
function openOnboardingWizard() { return onboardingWizard.openOnboardingWizard(); }
function groupKey(iso) {
  const d = new Date(iso); const now = new Date();
  const days = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (days <= 0) return 'session.today';
  if (days === 1) return 'session.yesterday';
  if (days <= 7) return 'session.thisWeek';
  return 'session.earlier';
}
// 113b: 内容搜索的客户端状态。旧的子串过滤一字未改，作为回退路径一直在：
// 端点关闭、请求失败、还没返回时，侧栏看上去就是今天的样子，不会变成空白或报错。
let sessionSearchState = { query: '', results: null, loading: false, failed: false };
let sessionSearchTimer = 0;
let sessionSearchSeq = 0;
const SESSION_SEARCH_MIN_QUERY = 2;
const SESSION_SEARCH_DEBOUNCE_MS = 200;

function sessionSearchQuery() {
  return String($('sessionSearch')?.value || '').trim();
}

// 去抖 200ms；每次发请求带一个递增序号，只采信最新一次的结果（快打字时先发后到会把
// 旧结果盖到新查询上）。不取消已发的请求：本机调用代价比 AbortController 的复杂度低。
function scheduleSessionSearch() {
  const q = sessionSearchQuery();
  if (sessionSearchTimer) { clearTimeout(sessionSearchTimer); sessionSearchTimer = 0; }
  if (q.length < SESSION_SEARCH_MIN_QUERY) {
    // 序号同样要推进:清空搜索框时可能还有一次请求在飞,不推序号的话它回来后会把
    // 已经清掉的搜索态又写回去(渲染时虽有 query 比对兑底,但状态本身不该脏)。
    sessionSearchSeq += 1;
    sessionSearchState = { query: q, results: null, loading: false, failed: false };
    renderSessions();
    return;
  }
  sessionSearchState = { ...sessionSearchState, query: q, loading: true };
  renderSessions();
  sessionSearchTimer = setTimeout(async () => {
    sessionSearchTimer = 0;
    const seq = ++sessionSearchSeq;
    try {
      const res = await api(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=30`);
      if (seq !== sessionSearchSeq) return;
      if (res && res.ok && Array.isArray(res.results)) {
        sessionSearchState = { query: q, results: res.results, loading: false, failed: false };
      } else {
        sessionSearchState = { query: q, results: null, loading: false, failed: true };
      }
    } catch {
      if (seq !== sessionSearchSeq) return;
      sessionSearchState = { query: q, results: null, loading: false, failed: true };
    }
    renderSessions();
  }, SESSION_SEARCH_DEBOUNCE_MS);
}

// 121-K4（34 号文 §2.3 末条）：2.0 的会话列表 `#sessionList` 由左栏的【任务索引】取代 ——
// 同一份 DOM 两视角共用，行由 js/steward-board.js 的 renderRail 画（按任务归组、按聚合五态分五组）。
// 本函数因此只剩【一个转接口】：名字与所有调用点一个字没动（开／建／改名／删／搜索之后仍是它被调），
// 但它自己不再画一行 —— 画行的地方全仓只剩那一处，不存在「2.0 一份、管家一份」两套列表。
// 注入的 renderRail 缺席时（组合根没把管家域接进来）就什么都不做：那时左栏本来也没人填。
let railRenderer = null;
function setRailRenderer(render) {
  railRenderer = typeof render === 'function' ? render : null;
  return Boolean(railRenderer);
}
// 137x（用户 2026-09-24）：本页自己起的回合也要有「运行中」的左下角小动效(css/states/chat-live.css
// 挂在 .live-turn 这枚已有类上——与管家开的临时卡共用同一枚类/同一份 CSS，见 buildLiveTurnCard)。
// 那只气泡的壳(createLiveAssistantShell)与收尾(finalizeLive)都在 chat-stream-runtime.js 里
// （本刀纪律：尽量不改那个文件——另一位执行者正并行改它），改从这里的既成事实拿信号：
// renderSessions() 在那个文件里恰好卡在回合起(sendPrompt)/回合中途(会话元信息更新)/回合讫(finally,
// activeTurns.delete 之后)三处都会调一次，够当「回合状态变了」的节拍用，不必另起观察者或计时器。
// openSession() 里 mountActiveTurn 之后再补调一次——那条路径(切回一条仍在跑的会话)不经过
// sendPrompt，回合起点不会自己触发 renderSessions()。
function syncOwnTurnLiveIndicator() {
  const box = $('messages');
  if (!box) return;
  const id = state.currentSession?.id || '';
  const turn = id ? activeTurns.get(id) : null;
  const liveRow = turn && turn.main && typeof turn.main.closest === 'function' ? turn.main.closest('.message') : null;
  for (const row of box.querySelectorAll('.message[data-own-live="1"]')) {
    if (row !== liveRow) { row.classList.remove('live-turn'); delete row.dataset.ownLive; }
  }
  if (liveRow && liveRow.isConnected && !liveRow.classList.contains('live-turn')) {
    liveRow.classList.add('live-turn'); liveRow.dataset.ownLive = '1';
  }
}
function renderSessions() {
  if (!railRenderer) return false;
  try { railRenderer(); } catch { /* 左栏画不出来不该把调用方（开会话／改名／删除）打回去 */ }
  syncOwnTurnLiveIndicator();
  return true;
}
// 113b 的内容搜索结果快照：左栏的过滤要用它（命中的是【正文】，不是标题，所以子串过滤替代不了）。
// 请求、去抖、序号丢弃仍然只在本文件一处 —— 左栏只读这个快照，不发第二发请求。
function sessionSearchSnapshot() {
  return { query: sessionSearchState.query, results: sessionSearchState.results };
}

// 121-K4：左栏行上那三枚会话级动作（置顶／重命名／删除）的接线。
// 画按钮的是 js/steward-board.js（左栏那一份渲染），动手的仍然是本文件这三份既有实现 ——
// 一条事件委托把两边接起来，于是「会话怎么改」全仓仍然只有一处，左栏不认识 /api/sessions。
// 委托挂在 #railList 上（不是 document）：左栏重画多少次都不用重新绑，也不会碰到别处的点击。
function bindRailSessionActions() {
  const host = $('railList');
  if (!host) return false;
  host.addEventListener('click', event => {
    const button = event.target && event.target.closest ? event.target.closest('[data-session-action]') : null;
    if (!button) return;
    event.stopPropagation();
    const id = String(button.dataset.sessionId || '');
    if (!id) return;
    const session = state.sessions.find(item => item && String(item.id) === id) || { id };
    const action = String(button.dataset.sessionAction || '');
    if (action === 'pin') { patchSession(id, { pinned: !(session && session.pinned) }); return; }
    if (action === 'rename') { openRenamePopover(button, session); return; }
    if (action === 'delete' && confirm(t('session.delete.confirm'))) removeSession(id);
  });
  return true;
}

async function refreshSessions() {
  const res = await api('/api/sessions');
  state.sessions = res.sessions || [];
  renderSessions();
}
// 128f（c3a3585 全量里 workbench-thread-head 的偶发，负载复现取证）：打开会话【后发先至】。开机那一发 openSession(B)
// 在负载下还没回来，用户已经点了 C；C 先回来、页面画成 C，B 晚到又把 state.currentSession 与标题写回 B ——
// 线程头、chip 从此绑在 B 上，用户以为在改 C 的模型，PATCH 落在 B。修：每一次「换到哪条会话」取一个序号，
// 回来时已经不是最新那一次就整个丢掉（最新的那一次说了算）。newSession 也取号：它一出手，在飞的打开都作废。
// 「最新的说了算」对开机那一发不成立：bootData 的「打开上次那条」要等 /api/status 与 /api/sessions 都回来才发，
// 而左栏行早就点得了 —— 用户先点了 C、它后发，按序号它反倒赢（负载复现 6×2 里 A11 两次红就是这个）。
// 它是缺省，不是选择：opts.restore 为真时，只要此前已经有过一次真的选择（非 restore 的打开／新建）就整个让路；
// 没有的话照常取号，之后用户再点一条仍然盖过它。
let sessionOpenSeq = 0;
let sessionChoices = 0;
async function openSession(id, opts = {}) {
  const restore = Boolean(opts && opts.restore === true);
  if (restore && sessionChoices > 0) return;
  if (!restore) sessionChoices += 1;
  const seq = ++sessionOpenSeq;
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
  if (seq !== sessionOpenSeq) return;   // 已经有更新的一次「换会话」了，这一发晚到的回包不许再写回去
  const prevId = state.currentSession?.id;
  const switchedSession = prevId !== id;
  state.currentSession = res.session;
  currentChangedWhileAway = false;   // 128f-⑫：刚整份读过，「离开期间动过」那一笔作废
  state.resumable = res.resumable || null; // v0.8-S0 A6: dangling-turn info for the resume banner
  captureLiveTurn(id, res); // 117m-A5: 在途回合的活文本跟着同一发 GET 回来，零新请求
  state.msgWindowStart = null; // v1.0-S7 (perf): each session opens windowed to its tail (recompute per open)
  try { localStorage.setItem('wcw.lastSession', id); } catch { /* ignore */ }
  // v1.9.1: 会话切换清空 steer 状态(模块级单例不按会话隔离,否则 A 的插话卡片/steeredSeen 残留到 B;
  //   切到流式会话 setStreaming(true) 不清空 -> B 看到 A 的插话 + ×按钮报错 + steeredSeen 孤儿吞事件)。对抗验证发现。
  if (switchedSession) {
    steerPendingList.length = 0; steeredSeen.length = 0; resetStickyScroll(); // EC-D 57: 切会话 -> 恢复跟随最新
    const h = $('composerHint'); if (h) { h.innerHTML = ''; h.style.display = 'none'; }
  }
  updateEngineDependentUI();
  renderSessions();
  renderCurrentSession();
  if (switchedSession) scrollMessagesToBottom(); // 旧会话的阅读锚点不能泄漏到新会话
  renderResumeBanner();
  syncStreamingUi();
  mountActiveTurn(id);
  syncOwnTurnLiveIndicator(); // 137x：切回一条仍在跑的会话——这条路径不经过 sendPrompt，补一次同步
  syncLivePolling(); // 117m-A5: 唯一的开表入口 —— 该不该开由 liveTurnPollable() 一处判
  if (switchedSession && eventStream && typeof eventStream.sync === 'function') eventStream.sync(); // 121-K2b: 在场信号改了(§4.3) —— 服务端只在连接时读它,所以换会话就是重连(去抖 300ms)
  // The global status denominator describes the new-session default. Resolve this session's pinned route
  // after every switch so the context meter and model list do not lag behind until the next completed turn.
  api(`/api/status?sessionId=${encodeURIComponent(id)}`).then(fresh => {
    if (state.currentSession?.id !== id || !fresh) return;
    if (state.status) {
      state.status.contextWindowResolved = fresh.contextWindowResolved || null;
      if (Array.isArray(fresh.models)) state.status.models = fresh.models;
    }
    updateEngineDependentUI();
    renderContextMeter(latestUsage(state.currentSession));
  }).catch(() => {});
}
// v0.8-S0 A6: show a lightweight banner above the composer when the opened session has a dangling
// (interrupted) turn. "继续" resends a prompt asking the model to finish; the banner then hides.
/* ---------------- v0.8-S3: task-list step-bar ---------------- */
// The step-bar shows the current task list. Summary (collapsed) reads "✓ 已完成 j/N · <in-progress text>";
// clicking the head expands the full list (pending ○ / in_progress ◐ / done ●). `todos` is an array of
// {id,text,status}; pass [] (or nothing) to hide the bar entirely.
const STEP_MARK = { done: '●', in_progress: '◐', pending: '○' };
function renderStepBar(todos) {
  const bar = $('stepBar');
  if (!bar) return;
  const items = Array.isArray(todos) ? todos : [];
  if (!items.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const done = items.filter(t => t && t.status === 'done').length;
  const current = items.find(t => t && t.status === 'in_progress') || items.find(t => t && t.status !== 'done') || items[items.length - 1];
  const sum = $('stepBarSummary');
  if (sum) {
    sum.innerHTML = '';
    sum.append(el('span', 'sb-count', `已完成 ${done}/${items.length}`));
    if (current && current.text) { sum.append(document.createTextNode(' · ')); sum.append(el('span', 'sb-cur', current.text)); }
  }
  const list = $('stepBarList');
  if (list) {
    list.innerHTML = '';
    for (const t of items) {
      if (!t) continue;
      const status = (t.status === 'done' || t.status === 'in_progress') ? t.status : 'pending';
      const li = el('li', status);
      li.append(el('span', 'sb-mark', STEP_MARK[status] || '○'), el('span', 'sb-text', t.text || ''));
      list.appendChild(li);
    }
  }
}
function toggleStepBar(force) {
  const head = $('stepBarToggle'), list = $('stepBarList');
  if (!head || !list) return;
  const open = force != null ? force : list.classList.contains('hidden');
  list.classList.toggle('hidden', !open);
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// 第26波b: 任务账本进度条。mission=null 或无里程碑 → 隐藏(非账本会话零显示)。
const MISSION_MARK = { done: '●', blocked: '▲', pending: '○' };
const MISSION_MODE_KEY = { 'until-done': 'mission.autoProgress', supervised: 'mission.waitingConfirmation', off: '' };
function renderMissionBar(mission) {
  const bar = $('missionBar');
  if (!bar) return;
  const ms = mission && Array.isArray(mission.milestones) ? mission.milestones : [];
  if (!mission || !mission.goal || !ms.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const done = ms.filter(m => m && m.status === 'done').length;
  const sum = $('missionBarSummary');
  if (sum) { sum.innerHTML = ''; sum.append(el('span', 'mb-goal', mission.goal), el('span', 'mb-count', ` · ${done}/${ms.length}`)); }
  const modeEl = $('missionBarMode');
  if (modeEl) {
    const labelKey = MISSION_MODE_KEY[mission.autoMode] || '';
    const label = labelKey ? t(labelKey) : '';
    modeEl.textContent = label ? '· ' + label + (mission.autoMode === 'until-done' && mission.budget ? ` (${(mission.spent && mission.spent.autoTurns) || 0}/${mission.budget.maxAutoTurns})` : '') : '';
    modeEl.className = 'mission-bar-mode' + (mission.autoMode === 'until-done' ? ' mb-active' : mission.autoMode === 'supervised' ? ' mb-warn' : '');
  }
  const stopBtn = $('missionStopBtn');
  if (stopBtn) stopBtn.classList.toggle('hidden', mission.autoMode !== 'until-done');
  const list = $('missionBarList');
  if (list) {
    list.innerHTML = '';
    for (const m of ms) {
      if (!m) continue;
      const status = (m.status === 'done' || m.status === 'blocked') ? m.status : 'pending';
      const li = el('li', status);
      li.append(el('span', 'mb-mark', MISSION_MARK[status] || '○'), el('span', 'mb-text', m.desc || m.id));
      if (m.evidence) li.title = m.evidence;
      list.appendChild(li);
    }
  }
}
// 账本状态卡(完成/停滞/预算耗尽)—— 插入对话流,借用 plan/error 卡的视觉语言。
function missionStateCard(evt) {
  const meta = {
    complete: { cls: 'ok', icon: '✓', title: t('mission.complete.title'), body: t('mission.complete.description') },
    stuck: { cls: 'warn', icon: '⚠', title: t('mission.stuck.title'), body: evt.reason || t('mission.stuck.description') },
    budget_exhausted: { cls: 'warn', icon: '⏸', title: t('mission.budgetPaused.title'), body: evt.reason || t('mission.budgetPaused.description') },
  }[evt.state] || { cls: '', icon: '·', title: t('common.unknown'), body: '' };
  const card = el('div', 'mission-card mission-card-' + meta.cls);
  card.append(el('div', 'mission-card-head', `${meta.icon} ${meta.title}`));
  if (meta.body) card.append(el('div', 'mission-card-body', meta.body));
  return card;
}
async function stopMission() {
  const s = state.currentSession; if (!s || !s.mission) return;
  try { const r = await api('/api/mission', { method: 'POST', body: JSON.stringify({ sessionId: s.id, action: 'stop' }) }); if (r && r.ok) { s.mission = r.mission; renderMissionBar(r.mission); toast(t('mission.stop.success'), 'ok'); } }
  catch (e) { toast(t('mission.stop.failed', { reason: apiErrText(e) }), 'err'); }
}

/* ---------------- 第27波:自主性授权书 ---------------- */
// 档位色(复用权限徽章语义):read=安全 / edit=可撤 / exec=高危。exec 视觉上必须更重。
function grantTierLabel(tier) {
  return { read: t('permission.read'), edit: t('permission.edit'), exec: t('permission.execute') }[tier] || tier;
}
function grantTierOf(tool) {
  if (tool === 'powershell_run' || tool === 'script_run' || tool === 'Bash') return 'exec';
  if (tool === 'file_read' || tool === 'file_list') return 'read';
  return 'edit';
}
function fmtRemain(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60
    ? t('permission.duration.hours', { hours: Math.floor(m / 60), minutes: m % 60 })
    : t('permission.duration.minutes', { minutes: m });
}
// 渲染活动授权列表(read-only 展示 + 撤销)。grants 为 listGrantsView 形状。
function renderAutonomyBar(grants) {
  const bar = $('autonomyBar'); if (!bar) return;
  const list = Array.isArray(grants) ? grants : [];
  const ul = $('autonomyBarList');
  const count = $('autonomyBarCount');
  const revokeAll = $('autonomyRevokeAll');
  const formOpen = $('autonomyIssueForm') && !$('autonomyIssueForm').classList.contains('hidden');
  // 有活动授权、或签发表单展开时,抽屉显示。
  if (!list.length && !formOpen) { bar.classList.add('hidden'); }
  else bar.classList.remove('hidden');
  if (count) count.textContent = list.length ? '· ' + t('permission.activeCount', { count: list.length }) : '';
  if (revokeAll) revokeAll.classList.toggle('hidden', list.length < 2);
  if (!ul) return;
  ul.innerHTML = '';
  for (const g of list) {
    const tier = g.tier || grantTierOf(g.tool);
    const li = el('li', 'autonomy-grant tier-' + tier);
    const badge = el('span', 'ag-badge ag-' + tier, grantTierLabel(tier));
    const name = el('span', 'ag-tool', g.tool);
    const scope = el('span', 'ag-scope', g.scope === 'run' ? t('permission.scope.run') : t('permission.scope.session'));
    const detail = el('span', 'ag-detail', tier === 'exec' ? (g.cmdAllow || []).join(' / ') : (g.pathGlob || []).join(' , '));
    if (tier === 'exec' && g.netAllowed) detail.append(el('span', 'ag-net', ' ⚠' + t('permission.network')));
    const uses = el('span', 'ag-uses', t('permission.uses', { used: g.usedCount || 0, max: g.maxUses }));
    const ttl = el('span', 'ag-ttl', t('permission.remaining', { duration: fmtRemain(g.remainingMs) }));
    const x = el('button', 'ag-revoke', '✕'); x.title = t('permission.revoke'); x.onclick = () => revokeOneGrant(g.grantId);
    li.append(badge, name, scope, detail, uses, ttl, x);
    ul.appendChild(li);
  }
}
async function loadAutonomyGrants() {
  const s = state.currentSession; if (!s) { renderAutonomyBar([]); return; }
  try { const r = await api('/api/autonomy/grants?sessionId=' + encodeURIComponent(s.id)); renderAutonomyBar(r && r.ok ? r.grants : []); }
  catch { renderAutonomyBar([]); }
}
async function revokeOneGrant(grantId) {
  const s = state.currentSession; if (!s) return;
  try { const r = await api('/api/autonomy/revoke', { method: 'POST', body: JSON.stringify({ sessionId: s.id, grantId }) }); if (r && r.ok) { renderAutonomyBar(r.grants); toast(t('permission.grantRevoked'), 'ok'); } }
  catch (e) { toast(t('permission.revoke.failed', { reason: apiErrText(e) }), 'err'); }
}
async function revokeAllAutonomyGrants() {
  const s = state.currentSession; if (!s) return;
  if (!confirm(t('permission.revokeAll.confirm'))) return;
  try { const r = await api('/api/autonomy/revoke', { method: 'POST', body: JSON.stringify({ sessionId: s.id, all: true }) }); if (r && r.ok) { renderAutonomyBar(r.grants); toast(t('permission.revokeAll.success', { count: r.revoked }), 'ok'); } }
  catch (e) { toast(t('permission.revoke.failed', { reason: apiErrText(e) }), 'err'); }
}
// 签发表单:工具切换 → 联动显示 glob(文件族)或 cmdAllow(exec)。
function autonomyFormSync() {
  const tool = $('agTool') && $('agTool').value;
  const tier = grantTierOf(tool);
  document.querySelectorAll('.ag-file-only').forEach(e => e.classList.toggle('hidden', tier === 'exec'));
  document.querySelectorAll('.ag-exec-only').forEach(e => e.classList.toggle('hidden', tier !== 'exec'));
  const form = $('autonomyIssueForm');
  if (form) form.classList.toggle('is-exec', tier === 'exec');
}
function autonomyIssuePayload() {
  const s = state.currentSession; if (!s) return null;
  const tool = $('agTool').value;
  const tier = grantTierOf(tool);
  const splitList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    sessionId: s.id, tool, scope: $('agScope').value,
    pathGlob: tier === 'exec' ? [] : splitList($('agGlob').value),
    cmdAllow: tier === 'exec' ? splitList($('agCmd').value) : [],
    netAllowed: tier === 'exec' && $('agNet') && $('agNet').checked,
    maxUses: Math.max(1, Number($('agMaxUses').value) || 10),
    ttlMs: Number($('agTtl').value) || 3600000,
  };
}
async function previewGrant() {
  const p = autonomyIssuePayload(); if (!p) return;
  const box = $('agDryRun'); if (box) box.textContent = t('permission.preview.loading');
  try {
    const r = await api('/api/autonomy/grant', { method: 'POST', body: JSON.stringify({ ...p, preview: true }) });
    if (r && r.ok) {
      const bits = [];
      if (grantTierOf(p.tool) !== 'exec') bits.push(t('permission.preview.files', { count: r.dryRun ? r.dryRun.count : 0, truncated: r.dryRun && r.dryRun.truncated ? t('permission.preview.truncated') : '' }));
      else bits.push(t('permission.preview.commands', { commands: (r.grant.cmdAllow || []).join(' / ') }));
      if (r.dropped && r.dropped.length) bits.push(t('permission.preview.dropped', { count: r.dropped.length, reasons: r.dropped.map(d => d.reason).join(';') }));
      if (box) box.textContent = bits.join(';');
    } else if (box) box.textContent = t('permission.preview.failed', { reason: r && r.error || t('common.unknown') });
  } catch (e) { if (box) box.textContent = t('permission.preview.failed', { reason: apiErrText(e) }); }
}
async function submitGrant(ev) {
  if (ev) ev.preventDefault();
  const p = autonomyIssuePayload(); if (!p) return;
  const tier = grantTierOf(p.tool);
  if (tier === 'exec') {
    if (!p.cmdAllow.length) { toast(t('permission.execution.required'), 'err'); return; }
    if (!confirm(t('permission.executionWarning', { tool: p.tool, commands: p.cmdAllow.join(' / '), network: p.netAllowed ? t('common.yes') : t('common.no'), uses: p.maxUses }))) return;
  }
  try {
    const r = await api('/api/autonomy/grant', { method: 'POST', body: JSON.stringify(p) });
    if (r && r.ok) {
      toast(r.dropped && r.dropped.length ? t('permission.grantIssuedWithDrops', { count: r.dropped.length }) : t('permission.grantIssued'), 'ok');
      $('autonomyIssueForm').classList.add('hidden');
      await loadAutonomyGrants();
    } else { toast(t('permission.grant.failed', { reason: r && r.error || t('common.unknown') }), 'err'); }
  } catch (e) { toast(t('permission.grant.failed', { reason: apiErrText(e) }), 'err'); }
}

/* ---------------- v0.8-S3: 「本轮变更」turn-summary card ---------------- */
// Renders message.turnSummary (static) or a live turn_summary event: a low-key card listing files changed
// (path + op) and a command count. When nothing changed AND no commands ran, shows the reassurance line
// 「本次未改动任何文件」(C5/C6 seed). Returns a DOM node.
function turnSummaryCard(summary) {
  const s = summary || {};
  const files = Array.isArray(s.filesChanged) ? s.filesChanged : [];
  const commands = Number(s.commands) || 0;
  const turnSeq = Number(s.turnSeq);
  const hasRevertible = files.some(f => f && f.revertible);
  const card = el('div', 'turn-summary');
  const head = el('div', 'turn-summary-head');
  head.append(el('span', '', t('changes.title')));
  // v0.8-S4b: 「撤销整轮」— rolls back every journaled file of this turn (default entrySeq). Only shown when
  // there is at least one revertible file AND we know the turnSeq (static or live event both carry it).
  if (hasRevertible && Number.isFinite(turnSeq)) {
    const undoAll = el('button', 'ts-undo-all', t('changes.revertTurn'));
    undoAll.onclick = () => { if (!confirm(t('changes.revertTurn.confirm'))) return; rollbackTurn(turnSeq, undefined, undoAll, t('changes.turnLabel')); };
    head.append(undoAll);
  }
  card.append(head);
  const body = el('div', 'turn-summary-body');
  if (!files.length && commands === 0) {
    body.append(el('div', 'turn-summary-empty', t('changes.empty')));
  } else {
    for (const f of files) {
      if (!f) continue;
      const row = el('div', 'turn-summary-file');
      const op = (f.op === 'create' || f.op === 'modify' || f.op === 'delete') ? f.op : 'unknown';
      const opLabel = op === 'create' ? t('changes.create') : op === 'modify' ? t('changes.modify') : op === 'delete' ? t('changes.delete') : t('common.unknown');
      row.append(el('span', `ts-op ${op}`, opLabel), el('span', 'ts-path', f.path || ''));
      // v0.8-S4b: per-file 「撤销」— rolls back a single entry (turnSeq + entrySeq). Only for revertible
      // files that carry an entrySeq (journal-driven). Non-revertible files show nothing extra.
      if (f.revertible && Number.isFinite(turnSeq) && Number.isFinite(Number(f.entrySeq))) {
        const undo = el('button', 'ts-undo', t('changes.revert'));
        undo.onclick = () => { if (!confirm(t('changes.revert.confirm', { path: f.path || '' }))) return; rollbackTurn(turnSeq, Number(f.entrySeq), undo, f.path || ''); };
        row.append(undo);
      }
      body.append(row);
    }
    const bits = [];
    if (files.length) bits.push(t('changes.fileCount', { count: files.length }));
    if (commands) bits.push(t('changes.commandCount', { count: commands }));
    if (bits.length) body.append(el('div', 'turn-summary-cmds', bits.join(' · ')));
    // commands can't be auto-undone — say so, once, when any command ran (C6/B3 discipline).
    if (commands > 0) body.append(el('div', 'turn-summary-warn', `⚠ ${t('changes.commandNotRevertible')}`));
  }
  card.append(body);
  return card;
}
// v1.0.2 (G2): 消息尾部生成文件 chip 行。数据源 summary.artifacts([{path, kind}])。每个 chip:kind 图标 +
// 文件名 + 两个小按钮(打开 / 📂 定位),走 POST /api/file/reveal。无 artifacts → 返回 null(调用处不追加)。
// 文件名一律 textContent(el 内部)——XSS 红线:artifacts 来自模型/文件系统。
function turnArtifactChips(summary) {
  const arts = summary && Array.isArray(summary.artifacts) ? summary.artifacts.filter(a => a && a.path) : [];
  if (!arts.length) return null;
  const wrap = el('div', 'turn-artifacts');
  // de-dup by path, keep first (newest-in-turn insertion order preserved).
  const seen = new Set();
  for (const a of arts) {
    const p = String(a.path);
    if (seen.has(p)) continue; seen.add(p);
    const chip = el('span', 'artifact-chip');
    chip.append(el('span', 'artifact-chip-icon', ARTIFACT_KIND_ICON[a.kind] || ARTIFACT_KIND_ICON.other));
    const nameEl = el('span', 'artifact-chip-name', fileBasename(p)); nameEl.title = p; // XSS-safe textContent
    chip.append(nameEl);
    const openBtn = el('button', 'artifact-chip-btn', t('file.open')); openBtn.type = 'button'; openBtn.title = t('file.open');
    openBtn.onclick = () => revealArtifact(p, 'open');
    const locBtn = el('button', 'artifact-chip-btn', `📂 ${t('file.reveal')}`); locBtn.type = 'button'; locBtn.title = t('file.reveal');
    locBtn.onclick = () => revealArtifact(p, 'select');
    chip.append(openBtn, locBtn);
    wrap.append(chip);
  }
  return wrap;
}
// v1.0.2 (G2): POST /api/file/reveal {sessionId, path, mode}. 成功时:若响应带 degradedTo(可执行/脚本文件
// 「打开」被降级为「定位」),toast 其 note;否则静默(资源管理器已弹出)。失败(400/403/404/非 win)toast 人话。
async function revealArtifact(fullPath, mode) {
  const sid = state.currentSession?.id || '';
  try {
    const r = await api('/api/file/reveal', { method: 'POST', body: JSON.stringify({ sessionId: sid, path: fullPath, mode }) });
    if (!r || !r.ok) { toast((r && r.error) || t('file.open.unavailable'), 'err'); return; }
    if (r.degradedTo && r.note) toast(r.note, '');
  } catch (e) {
    toast(t('file.open.failed', { reason: apiErrText(e) }), 'err');
  }
}
/* ---------------- v0.9-S1 (C6): error human-card ---------------- */
// Known machine classes render through the local catalog. The server's legacy zh/next table is retained only
// for unknown classes from an older/newer server, so it is no longer the UI's sole error-language contract.
const ERROR_CLASS_I18N = {
  provider_misconfigured: { title: 'error.providerMisconfigured', next: 'error.providerMisconfigured.next' },
  network_down: { title: 'error.networkDown', next: 'error.networkDown.next' },
  permission_denied: { title: 'error.permissionDenied', next: 'error.permissionDenied.next' },
  tool_error: { title: 'error.toolFailed' },
  idle_timeout: { title: 'error.idleTimeout' },
  tool_loop: { title: 'error.toolLoop' },
};
const ERROR_CLASSES_LEGACY = {
  provider_misconfigured: { zh: () => t('error.providerMisconfigured'), next: () => t('error.providerMisconfigured.next') },
  network_down: { zh: () => t('error.networkDown'), next: () => t('error.networkDown.next') },
  permission_denied: { zh: () => t('error.permissionDenied'), next: () => t('error.permissionDenied.next') },
  tool_error: { zh: () => t('error.toolFailed'), next: () => t('error.toolFailed.next') },
  idle_timeout: { zh: () => t('error.idleTimeout'), next: () => t('error.idleTimeout.next') },
  tool_loop: { zh: () => t('error.toolLoop'), next: () => t('error.toolLoop.next') },
};
function errorClassInfo(cls) {
  const local = ERROR_CLASS_I18N[cls];
  if (local) return { title: t(local.title), next: local.next ? t(local.next) : '' };
  const table = (state.status && state.status.errorClasses) || ERROR_CLASSES_LEGACY;
  const legacy = table[cls] || ERROR_CLASSES_LEGACY[cls];
  return legacy ? { title: (typeof legacy.zh === 'function' ? legacy.zh() : legacy.zh), next: (typeof legacy.next === 'function' ? legacy.next() : legacy.next) } : null;
}
// Map an errorClass → a concrete 「下一步」 action (button). Not every class gets a button (tool_loop is
// text-only per spec — there's nothing single-click actionable). Returns {label, run} or null.
function errorClassAction(cls) {
  switch (cls) {
    case 'provider_misconfigured':
      return { label: t('provider.configureApiKey'), run: () => { openModal('settingsModal'); switchSettingsTab('providers'); } };
    case 'network_down':
      return { label: t('capability.view'), run: () => { if (typeof openCapPopover === 'function') openCapPopover(); } };
    case 'permission_denied':
      // v1.0-S2 (IA): 权限收敛为顶栏「安全」chip + 安全弹层；此处打开该弹层并给出人话提示。
      return { label: t('permission.title'), run: () => { if (typeof openPermPopover === 'function') openPermPopover(); toast(t('error.permissionDenied.next'), 'ok'); } };
    default:
      return null; // tool_error / idle_timeout / tool_loop → text-only guidance
  }
}
// Render the human error card. `noFilesChanged` appends the reassurance line 「本次未改动任何文件」 (C6) when
// this turn's turn_summary was empty (a failed turn that touched nothing shouldn't leave the user unsure).
function errorCard(cls, rawError, noFilesChanged) {
  const info = errorClassInfo(cls);
  const card = el('div', 'error-card');
  const head = el('div', 'error-card-head');
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', (info && info.title) || t('error.generic.title')));
  card.append(head);
  const body = el('div', 'error-card-body');
  if (info && info.next) body.append(el('div', 'error-card-next', info.next));
  else body.append(el('div', 'error-card-next', rawError ? String(rawError) : t('error.generic.description')));
  const act = errorClassAction(cls);
  if (act) {
    const btn = el('button', 'error-card-btn', act.label);
    btn.onclick = () => { try { act.run(); } catch { /* ignore */ } };
    body.append(btn);
  }
  if (noFilesChanged) body.append(el('div', 'error-card-noop', t('changes.empty')));
  card.append(body);
  return card;
}
// v1.0.2 (F6c): CLI 缺失的友好引导卡。后端契约:聊天错误事件带 code:'cli-missing'(另一 agent 正在实现)。
// 向后兼容:没有 code 字段时走原始错误渲染,不依赖后端已上线 —— 只有 code==='cli-missing' 才走这张卡。
// 主张「推荐直接配置 API 引擎」+ 按钮直达设置 Providers 页签;次链接给「配置 Claude CLI 路径」。
function cliMissingCard() {
  const cliName = engineLabel() || 'Agent CLI';
  const card = el('div', 'error-card cli-missing-card');
  const head = el('div', 'error-card-head');
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', t('error.cliMissing.title', { engine: cliName })));
  card.append(head);
  const body = el('div', 'error-card-body');
  body.append(el('div', 'error-card-next', t('error.cliMissing.description', { engine: cliName })));
  const btn = el('button', 'error-card-btn', t('error.cliMissing.configureApi'));
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  body.append(btn);
  const alt = el('button', 'error-card-alt', t('error.cliMissing.configureCli', { engine: cliName }));
  alt.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
  body.append(alt);
  card.append(body);
  return card;
}

// v0.8-S4b: roll back a turn (entrySeq omitted) or a single file (entrySeq given). On success the button
// becomes 「已撤销」+ disabled; on failure a toast surfaces the error. Uses api() (carries the UI token).
async function rollbackTurn(turnSeq, entrySeq, btn, label) {
  const sid = state.currentSession?.id;
  if (!sid) { toast(t('error.generic.description'), 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = t('changes.revert'); }
  try {
    const payload = { sessionId: sid, turnSeq };
    if (entrySeq !== undefined) payload.entrySeq = entrySeq;
    const r = await api('/api/checkpoints/rollback', { method: 'POST', body: JSON.stringify(payload) });
    if (!r || !r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? t('changes.revertTurn') : t('changes.revert'); }
      toast(t('changes.revert.failed', { reason: (r && r.error) || (r && r.failed && r.failed.length ? r.failed[0].reason : t('common.unknown')) }), 'err');
      return;
    }
    if (btn) { btn.textContent = t('changes.revert.done'); btn.classList.add('done'); btn.disabled = true; }
    try { refreshToolPane(); } catch { /* 128f-⑫：右栏「变更」页签开着的话，刚撤掉的那几处要当场消失 */ }
    const n = (r.reverted || []).length;
    toast(t('changes.reverted', { label: `${label}${n ? ` (${t('changes.fileCount', { count: n })})` : ''}` }), 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? t('changes.revertTurn') : t('changes.revert'); }
    toast(t('changes.revert.failed', { reason: apiErrText(e) }), 'err');
  }
}

function renderResumeBanner() {
  const box = $('resumeBanner');
  if (!box) return;
  box.innerHTML = '';
  const info = state.resumable;
  if (!info || !info.dangling) { box.classList.add('hidden'); return; }
  const sessionId = state.currentSession && state.currentSession.id;
  const dismissKey = sessionId ? `wcw.resumeDismissed.${sessionId}` : '';
  const fingerprint = `${Number(info.turnSeq) || 0}:${Number(info.historyLength) || 0}:${String(info.kind || '')}`;
  let dismissed = info.dismissed === true;
  try { if (!dismissed && dismissKey) dismissed = localStorage.getItem(dismissKey) === fingerprint; } catch { /* storage unavailable */ }
  if (dismissed) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const label = el('span', 'resume-banner-text', t('chat.resume.title'));
  const btn = el('button', 'resume-banner-btn', t('chat.resume.action'));
  btn.onclick = () => {
    try { if (dismissKey) localStorage.removeItem(dismissKey); } catch { /* ignore */ }
    state.resumable = null;
    box.classList.add('hidden');
    box.innerHTML = '';
    sendPrompt(t('chat.resume.prompt'));
  };
  const dismiss = el('button', 'resume-banner-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = t('chat.resume.dismiss');
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.onclick = () => {
    info.dismissed = true;
    try { if (dismissKey) localStorage.setItem(dismissKey, fingerprint); } catch { /* ignore */ }
    box.classList.add('hidden');
    box.innerHTML = '';
  };
  box.append(label, btn, dismiss);
}

// 50-fix:未命名标题的本地化占位显示(后端占位 'New session' / 历史中文占位 '新会话' 均视为未命名)。
function isUntitledTitle(tt) { const v = String(tt || '').trim(); return !v || v === 'New session' || v === t('chat.newSession'); }
// 116-5b(27 号文 §11.8.5「消费面」):经典壳这一面的显示名。优先级与服务端 02-session-store 的
// sessionDisplayTitle 【逐条相同】:人起的名字 > 自动生成的名字 > 原话。原话不被改写,它仍是权威
// (也是下面 s-title 的 hover 全文与这里的最后回退)。
// 为什么这一面还要再算一次、而管家壳那边是服务端算好直出的:本函数【本来就是】经典壳唯一的显示名
// 判据 —— 「未命名 → 本地化占位」那条规则依赖 t(),服务端不认识它。把显示名拆成「服务端算一半、
// 前端算一半」只会多出一个分叉点。public/ 下读 brief.title / titleSource 的地方只有这一处,
// 由 thread-brief.static ③ 机械看住。
function sessionGeneratedTitle(s) {
  if (!s || s.titleSource === 'user') return '';
  const brief = (s.brief && typeof s.brief === 'object') ? s.brief : null;
  return String((brief && brief.title) || '').trim();
}
function sessionDisplayTitle(s) {
  const generated = sessionGeneratedTitle(s);
  if (generated) return generated;
  return isUntitledTitle(s && s.title) ? t('session.new') : String(s.title).trim();
}
async function newSession(options = {}) {
  const cwd = options.cwd != null ? String(options.cwd) : (state.config.defaultWorkspace || '');
  ++sessionOpenSeq; sessionChoices += 1;   // 128f：新建也是一次「换会话」，在飞的 openSession 回来时不许把它盖掉（见 openSession 头注）
  // 50-fix(标题不生成):不再把本地化占位名(新会话/New chat)当标题传给后端 —— 后端回合结束的
  // 自动命名以 'New session' 占位判定,中文占位名永不匹配导致所有会话标题卡死。传空串,
  // 后端默认 'New session' → 首轮结束自动命名生效;展示侧经 sessionDisplayTitle 本地化占位。
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '', cwd }) });
  state.currentSession = res.session;
  state.resumable = null; // fresh session never dangles
  try { localStorage.setItem('wcw.lastSession', res.session.id); } catch { /* ignore */ }
  await refreshSessions();
  updateEngineDependentUI();
  renderCurrentSession();
  renderResumeBanner();
  syncStreamingUi();
  if (options.focus !== false) $('promptInput').focus();
  return res.session;
}
async function patchSession(id, patch) {
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-http-method': 'PATCH' }, body: JSON.stringify(patch) });
  if (state.currentSession?.id === id) Object.assign(state.currentSession, patch);
  await refreshSessions();
  renderCurrentSession();
}
// 128f-⑫（用户 2026-09-19「删除线程没有及时的界面反馈，要点别处才刷新消失」）：删除要有三拍反馈 ——
// 点下去这一行立刻变灰（请求在飞）；服务端删完立刻不画（不等 /api/missions）；删不掉就恢复原样并说清原因。
// 修前三拍都没有：请求在飞时行一动不动；删完左栏按旧行重画（管家视角还不补拉）；失败是一个没人接的 rejection。
// 状态记在 state.sessionRemoval（左栏那一份渲染 steward-board.js 读它，见 removalOf 头注）。
function sessionRemoval() {
  if (!state.sessionRemoval || !(state.sessionRemoval.pending instanceof Set) || !(state.sessionRemoval.done instanceof Set)) {
    state.sessionRemoval = { pending: new Set(), done: new Set() };
  }
  return state.sessionRemoval;
}
async function removeSession(id) {
  const removal = sessionRemoval();
  removal.pending.add(id);
  renderSessions();
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-http-method': 'DELETE' } });
  } catch (e) {
    removal.pending.delete(id);
    renderSessions();
    toast(t('session.delete.failed', { reason: apiErrText(e) }), 'err');
    return false;
  }
  removal.pending.delete(id);
  removal.done.add(id);
  if (state.currentSession?.id === id) state.currentSession = null;
  await refreshSessions();
  renderCurrentSession();
  return true;
}

function openBulkCleanupModal() {
  const currentId = state.currentSession?.id || '';
  // The server repeats these guards authoritatively. Keeping the preview aligned makes the destructive
  // action legible before the user confirms it.
  const candidates = state.sessions.filter(s => s && !s.pinned && s.id !== currentId && !activeTurns.has(s.id));
  if (!candidates.length) { toast(t('session.bulkCleanup.empty'), ''); return; }

  const count = candidates.length;
  const body = el('div');
  body.append(el('p', '', t('session.bulkCleanup.description', { count })));
  const note = el('p', 'muted', t('session.bulkCleanup.note'));
  body.append(note);
  const purgeLabel = el('label', 'check');
  const purgeBox = document.createElement('input');
  purgeBox.type = 'checkbox'; purgeBox.checked = true;
  purgeLabel.append(purgeBox, document.createTextNode(' ' + t('session.bulkCleanup.purgeAssociated')));
  body.append(purgeLabel);
  body.append(el('p', 'muted', t('session.bulkCleanup.purgeHint')));

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const go = el('button', 'danger', t('session.bulkCleanup.action', { count }));
  foot.append(cancel, go);
  const modal = buildModal(t('session.bulkCleanup.title'), body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('common.loading');
    try {
      const r = await api('/api/sessions/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ preserveSessionId: currentId, purgeAssociated: purgeBox.checked }),
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'unknown error');
      modal.close();
      const removal = sessionRemoval();   // 128f-⑫：删掉的那些立刻不画（同 removeSession）
      for (const deletedId of (Array.isArray(r.deleted) ? r.deleted : [])) removal.done.add(String(deletedId));
      await refreshSessions();
      toast(t('session.bulkCleanup.success', { count: r.deletedCount || 0 }), 'ok');
    } catch (e) {
      go.disabled = false; go.textContent = t('session.bulkCleanup.action', { count });
      toast(t('session.bulkCleanup.failed', { reason: apiErrText(e) }), 'err');
    }
  };
}

/* ---------------- message rendering ---------------- */
let kimiContextRefreshSeq = 0;
function refreshKimiContextForSession(session) {
  // `agentCliType` is only the fallback Agent driver. While an OpenAI-compatible Provider is active,
  // its compacted providerHistory is authoritative; a late Kimi status response must not restore the
  // pre-compaction numerator over the freshly reloaded Provider usage row.
  if (!session || isProviderMode() || currentEngineMeta().agentCliType !== 'kimi' || !session.id) return;
  const sid = session.id;
  const seq = ++kimiContextRefreshSeq;
  api(`/api/kimi/status?sessionId=${encodeURIComponent(sid)}`).then(result => {
    if (seq !== kimiContextRefreshSeq || state.currentSession?.id !== sid || !result?.ok || !result.usage) return;
    state.shownUsage = result.usage;
    renderContextMeter(result.usage);
  }).catch(() => {});
}
/* ---------------- 117m-A5：在途回合的临时气泡（用户第六轮走查①「看全文，还是啥也看不到」） ------- */
// 根因：助手消息在【回合收尾】才落盘，而管家派出去的回合没有任何客户端挂在它的流上。用户真机上那条
// 线程跑了 15 分钟、53 次工具调用，sessions/<id>.messages.ndjson 只有那条 user 消息一行；经典壳
// （renderCurrentSession）只渲染已落盘的 messages，所以「看全文」切过来就是一张交办书 ＋ 一片空白。
// 修法不是提前落盘（那会把半截正文写进正文数据面），而是把服务端内存里那份活文本画出来：
// 04 的累加器已经扩成「本回合正文 + 最近工具名」，13d 把它挂在既有 GET /api/sessions/:id 的信封上。
// 三条纪律：
//   ① 这张气泡【不是消息】—— 带 data-live="1"，绝不写进 state.currentSession.messages；
//   ② 只有「当前会话有活回合 && 不是自己的流在跑」才画：自己发起的回合有实时那一张，别画两遍；
//   ③ 回合一结束服务端就不再下发 liveTail，那一拍整份重拉会话，临时气泡换成真消息，不留残影。
// 文案说明：本切片的文件白名单不含 locales 那四份目录（另有切片在改），所以这三句先按经典壳既有
// 惯例（renderStepBar 的「已完成 j/N」同款）写死中文，可复用的既有键（停止/已停止）仍走 t()。
const LIVE_TURN_POLL_MS = 3000;
// Localized fallbacks for engines without a narrative snapshot.
const liveTurnEmpty = () => t('chat.liveTurn.empty');
const liveTurnUsing = () => t('chat.liveTurn.using');
let liveTurnTail = null;      // 最近一次 GET 带回来的 liveTail（服务端没下发就是 null）
// 117o-A7（用户第七轮，两张截图对照：「为啥这个查看全文，不能像 2.0 那样显示呢？第二张图是 2.0 的」）：
// A5 那张气泡是一坨纯文本，因为服务端只送了一段拼好的文字。现在服务端在同一个信封上多送一个
// liveTurn ＝ 在途回合的【有序叙事账本】（02c 的 segments，回合落盘后经典壳重建叙事靠的也是它）。
// 前端据此把它组装成一条与落盘助手消息【同形】的对象，交给 renderStaticMessage() ——
// 也就是经典壳画一条落盘助手消息的那个入口 —— 去画，思考块 / 过程记录 / 工具卡 / 完成徽章
// 全部同源。**不写第二套简版渲染器**：经典壳以后怎么改，在途回合当场跟着改。
let liveTurnNarrative = null; // 最近一次 GET 带回来的 liveTurn（服务端没下发/这条路没有账本就是 null）
let liveTurnSessionId = '';   // 这份活文本属于哪条会话：切会话立刻作废，别把 A 的正文画到 B 上
let liveTurnLive = false;     // resumable.live —— 服务端对「这条会话有没有活回合」的判定
let liveTurnCardEls = null;   // 挂在 DOM 上的那张气泡的构件（就地刷新，不整份重绘）
let liveTurnTimer = 0;        // 本模块唯一的 setInterval 句柄（见 syncLivePolling）
let liveStreamConnected = false; // 121-K2b：推送连着没有（连着就不开表，见 liveTurnPollable）
let liveTurnPushBusy = false;    // 121-K2b：推送驱动的那一趟在飞（合并、串行；本模块不加第二个计时器）
let liveTurnPushAgain = false;

function captureLiveTurn(sessionId, res) {
  liveTurnSessionId = String(sessionId || '');
  liveTurnTail = res && res.liveTail && typeof res.liveTail === 'object' ? res.liveTail : null;
  liveTurnNarrative = res && res.liveTurn && typeof res.liveTurn === 'object' ? res.liveTurn : null;
  liveTurnLive = Boolean(res && res.resumable && res.resumable.live === true);
  // 117s-G：与 liveTail/liveTurn 同一发 GET 回来的 relay —— 「这条线程此刻该走哪条递话通道」。
  // 服务端空闲时整个键都不下发，这里就归 null（= 走正常回合那条路）。
  state.sessionRelay = res && res.relay && typeof res.relay === 'object'
    ? { sessionId: String(sessionId || ''), live: liveTurnLive, channel: String(res.relay.channel || ''), wait: res.relay.wait || null }
    : liveTurnLive ? { sessionId: String(sessionId || ''), live: true, channel: '' } : null;
  updateSendBtn();
}
// 该不该画这张气泡。四条都为真才画 —— 任一为否，renderCurrentSession 就当它不存在。
function liveTurnVisible() {
  const id = state.currentSession?.id || '';
  if (!id || liveTurnSessionId !== id) return false; // 手上这份活文本不是当前会话的
  if (!liveTurnLive) return false;                   // 服务端说这条会话没有活回合
  if (activeTurns.has(id)) return false;             // 自己的流正在跑：实时那一张已经在画了
  return true;
}
// 该不该开表。在 liveTurnVisible 之上再加两道「零后台活动」的门：页面不可见不轮询；不在经典壳里
// 不轮询（管家壳有它自己的节拍，这张气泡那时根本不在屏幕上）。
// 121-K2b（§6.2）：第四道门 —— 事件流连着就【不开表】。这张卡的每一次变化都有一帧 thread.live
// （§6.1 每会话 ≥500 ms 一条）或 thread.state／done 打头，推送到达时走的是同一个 refreshLiveTurn()，
// 所以表在连接期间纯属白烧（而且它比推送慢：3 s 一拍 vs ≤1 s）。断连即回到 3 s，一个字没变。
function liveTurnPollable() {
  if (!liveTurnVisible()) return false;
  if (liveStreamConnected) return false;
  const doc = globalThis.document || null;
  if (!doc || doc.hidden) return false;
  const mode = (doc.documentElement && doc.documentElement.getAttribute('data-shell-mode')) || 'classic';
  return mode === 'classic';
}
// 全模块唯一的 setInterval／clearInterval 都在这里（抄 steward-drawer.js 的 syncPolling 写法）：
// 开关只有一处，条件只有 liveTurnPollable() 一条，别处一律只调这个函数。
function syncLivePolling() {
  const want = liveTurnPollable();
  if (want && !liveTurnTimer) liveTurnTimer = setInterval(() => { refreshLiveTurn(); }, LIVE_TURN_POLL_MS);
  else if (!want && liveTurnTimer) { clearInterval(liveTurnTimer); liveTurnTimer = 0; }
}
// 121-K2b（§6.2）：推送驱动的那一拍。**走的就是上面那个 refreshLiveTurn()**，不写第二套刷新路径 ——
// 推送改的只是「什么时候拉」（它真动了才拉，而不是每 3 秒猜一次）。三道门：
//   · 只认当前会话（别把 A 的活文本画到 B 上，与 liveTurnVisible 同一条判据）；
//   · 自己的流在跑时不拉（实时那一张已经在画了，与 liveTurnVisible 第三条同源）；
//   · 只在工作台视角里拉（管家视角这张卡根本不在屏幕上，与 liveTurnPollable 第三条同源）。
// 合并用「在飞 + 还要再来一趟」两个位，不加计时器（live-full-text.static C1/C2 钉着本模块
// 恰好一处 setInterval／clearInterval，而那一对是 syncLivePolling 的）。
// 128f-⑫（审计 E）：管家视角里动了当前这条线程（整单回退、撤回、行动流水「撤销」、递话之后它跑完……），推送来了，
// 可中栏那条对话与右栏页签在管家视角下不在屏上，本函数照旧不拉（见上面第二条）。修前切回工作台，看到的仍是切走之前
// 那一份，要换一次会话才重读。现在记一笔「离开期间它动过」，切回工作台那一刻重读一次（reloadCurrentSessionAfterAway）。
let currentChangedWhileAway = false;
async function pushLiveTurn(sessionId) {
  const id = String(state.currentSession?.id || '');
  if (!id || String(sessionId || '') !== id) return false;
  const doc = globalThis.document || null;
  const mode = (doc && doc.documentElement && doc.documentElement.getAttribute('data-shell-mode')) || 'classic';
  if (mode !== 'classic') { currentChangedWhileAway = true; return false; }
  if (activeTurns.has(id) || state.streaming) return false;
  if (liveTurnPushBusy) { liveTurnPushAgain = true; return false; }
  liveTurnPushBusy = true;
  try { await refreshLiveTurn(); } finally { liveTurnPushBusy = false; }
  if (liveTurnPushAgain) { liveTurnPushAgain = false; return pushLiveTurn(id); }
  return true;
}
function bindLiveEventStream() {
  if (!eventStream || typeof eventStream.on !== 'function') return false;
  eventStream.on('background.completed', data => {
    if (!data || !data.sessionId) return;
    toast(t('chat.background.' + data.status), data.status === 'succeeded' ? 'ok' : 'err');
    // Fetch only on completion push, never a polling timer. Do not replace a streaming message tree.
    void (async () => {
      const id = data.sessionId;
      if (state.currentSession?.id !== id) return;
      const response = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (!response?.ok || state.currentSession?.id !== id) return;
      const fresh = (response.session.messages || []).filter(m => m.backgroundJobId);
      // D2 (live-full-text): the client message array is the on-disk plane; a session view without it
      // gets the receipts through the next openSession merge instead of a local reassignment here.
      const current = Array.isArray(state.currentSession.messages) ? state.currentSession.messages : null;
      if (!current) return;
      const known = new Set(current.map(m => m.backgroundJobId).filter(Boolean));
      for (const message of fresh) {
        if (known.has(message.backgroundJobId)) continue;
        current.push(message); known.add(message.backgroundJobId);
        // 2026-09-24:回执只进数据面、不进对话流(同 visibleSessionMessageEntries 那道滤网),屏上没有东西要重画。
      }
    })().catch(() => { /* durable receipt is restored when the session is opened again */ });
  });
  liveStreamConnected = typeof eventStream.isConnected === 'function' ? eventStream.isConnected() === true : false;
  eventStream.on('connection', payload => {
    liveStreamConnected = Boolean(payload && payload.connected);
    syncLivePolling();   // 断连即回到 3 s 那一档；连上即停表（唯一的开关表入口仍然只有它）
  });
  for (const name of [EVENT_STREAM_LIVE_EVENT, ...EVENT_STREAM_ROW_EVENTS]) {
    eventStream.on(name, data => { void pushLiveTurn(data && data.sessionId); });
  }
  const docEl = globalThis.document && globalThis.document.documentElement;
  if (docEl && typeof globalThis.MutationObserver === 'function') {
    new globalThis.MutationObserver(() => {
      if (docEl.getAttribute('data-shell-mode') !== 'classic' || !currentChangedWhileAway) return;
      currentChangedWhileAway = false;
      void reloadCurrentSessionAfterAway();
    }).observe(docEl, { attributes: true, attributeFilter: ['data-shell-mode'] });
  }
  return true;
}
// 切回工作台时重读当前会话（只在离开期间真的来过它的推送时才走到这里）。自己的流在跑就不动：那一张正在实时画。
async function reloadCurrentSessionAfterAway() {
  const id = String(state.currentSession?.id || '');
  if (!id || activeTurns.has(id) || state.streaming) return false;
  let res = null;
  try { res = await api(`/api/sessions/${encodeURIComponent(id)}`); } catch { res = null; }
  if (!res || !res.ok || state.currentSession?.id !== id || activeTurns.has(id) || state.streaming) return false;
  state.currentSession = res.session;
  state.resumable = res.resumable || null;
  captureLiveTurn(id, res);
  liveTurnCardEls = null;
  renderCurrentSession();
  renderResumeBanner();
  syncLivePolling();
  try { refreshToolPane(); } catch { /* 页签重读失败不该把中栏打回去 */ }
  return true;
}
bindLiveEventStream();
// 一拍：重取信封 → 还在跑就只刷这张气泡（整份重绘会抹掉阅读位置，长会话还很贵）；
// 已经跑完就把服务端刚落盘的正文整份换上来，临时气泡随之消失。
async function refreshLiveTurn() {
  const id = state.currentSession?.id || '';
  if (!id) { syncLivePolling(); return; }
  let res = null;
  try { res = await api(`/api/sessions/${encodeURIComponent(id)}`); } catch { res = null; }
  if (!res || !res.ok || state.currentSession?.id !== id) { syncLivePolling(); return; }
  const wasLive = liveTurnVisible();
  captureLiveTurn(id, res);
  if (liveTurnVisible()) {
    if (!paintLiveTurnCard()) renderCurrentSession(); // 气泡不在 DOM 上（刚切回来）才重绘一次
  } else if (wasLive && !state.streaming && !activeTurns.has(id)) {
    state.currentSession = res.session;
    state.resumable = res.resumable || null;
    liveTurnCardEls = null;
    renderCurrentSession();
    renderResumeBanner();
  }
  syncLivePolling();
}
function buildLiveTurnCard() {
  const { row, main } = messageShell('assistant', undefined, currentEngineMeta());
  row.classList.add('live-turn');
  row.dataset.live = '1';
  // 117o-A7：截断提示。服务端砍的是【头部】（用户要看的是它现在在说什么），所以这句话在最上面。
  const cut = el('div', 'live-turn-truncated');
  // 117o-A7：2.0 那套真实渲染落在这里。内容由 renderStaticMessage()（画落盘助手消息的同一个入口）
  // 生成，本模块只负责把它搬进这张临时壳里，不自己画一个像素级仿制品。
  const narrative = el('div', 'live-turn-narrative');
  // A5 的纯文本兜底：服务端没送 liveTurn（旧版本/这条引擎路径还没挂账本），或者这一回合还一个段都
  // 没有（刚起、只挂着一个待决）时，仍然要有话给用户看，不能退回一片空白。
  const body = el('div', 'live-turn-body');
  const tool = el('div', 'live-turn-tool');
  main.append(cut, narrative, body, tool);
  liveTurnCardEls = { row, cut, narrative, body, tool, narrativeSig: '' };
  // 117m-A6（审查报回 P2）：这一刻 row 还没被 append 进文档，isConnected 恒为 false。
  // 不带 mounted 地调会被那道守卫直接退回去，于是首帧正文区一片空白（连空态文案都没有），
  // 要等 3 秒后下一拍才自愈。首次填内容明确告诉它「现在还没挂上去」。
  paintLiveTurnCard({ mounted: false });
  return row;
}
// 就地把手上这份活文本写进气泡。返回 false = 气泡不在 DOM 上（调用方据此决定要不要重绘）。
function paintLiveTurnCard(opts) {
  const els = liveTurnCardEls;
  if (!els) return false;
  // mounted:false = 调用方自己知道气泡还没挂上去（刚造出来），跳过这道守卫。
  // 守卫本身不能去：它是「气泡被整份重绘换掉了」的判据，返回 false 让调用方去重绘。
  if (!(opts && opts.mounted === false) && !els.row.isConnected) return false;
  // 117r-D4：这张卡的正文不再有自己的 max-height（那条内滚动条正是用户看到的「窗中窗」），于是
  // 每 3 秒一拍的重绘会真的改变整页高度 —— 用户滚上去看历史时会被顶得乱跳。用 renderCurrentSession()
  // 那对现成的原语兜住：换之前记下阅读位置，换完还回去（在底部就继续贴底跟随，不在底部就原地不动）。
  // 括号开在这一层而不是 paintLiveTurnNarrative 里：本函数还会改 cut/body/tool 三处文本，
  // 其中 body 的 max-height 也在本刀里撤掉了（没有账本时它就是全部正文），narrative 那一层管不到。
  // 气泡还没挂进文档时（buildLiveTurnCard 的首帧）不做：那一刻外层 renderCurrentSession 自己正拿着锚点。
  const box = els.row.isConnected ? $('messages') : null;
  const scroll = box ? captureScrollAnchor(box) : null;
  const tail = liveTurnTail;
  const full = String((tail && tail.full) || '');
  // 117o-A7：有账本就画 2.0 那一套（同一个渲染器），没有才回落到 A5 的纯文本。两条路互斥，
  // 屏幕上永远只有一份正文 —— 否则同一段话会出现两遍。
  const turn = liveTurnNarrative;
  const segments = Array.isArray(turn && turn.segments) ? turn.segments.filter(Boolean) : [];
  const narrated = segments.length > 0 && paintLiveTurnNarrative(els, turn, segments);
  els.narrative.hidden = !narrated;
  els.body.hidden = narrated;
  if (!narrated) { els.narrative.replaceChildren(); els.narrativeSig = ''; }
  els.cut.textContent = (narrated ? Boolean(turn && turn.truncated) : false) ? t('chat.liveTurn.truncated') : '';
  els.cut.hidden = !els.cut.textContent;
  // truncated：04 是从【头部】丢弃的（用户要看的是它现在在说什么），所以省略号标在开头。
  els.body.textContent = full ? ((tail && tail.truncated) ? `…${full}` : full) : liveTurnEmpty();
  els.body.classList.toggle('is-empty', !full);
  const tools = Array.isArray(tail && tail.tools) ? tail.tools : [];
  const last = tools.length ? tools[tools.length - 1] : null;
  const name = String((last && last.name) || '');
  els.tool.textContent = name ? `${liveTurnUsing()}${name}${last.status === 'running' ? '' : ' ✓'}` : '';
  els.tool.hidden = narrated || !name;
  // 这张气泡没有 data-message-key，keyed 那条路找不到自己的锚点，会落到「在底部就贴底 / 不在底部
  // 就按数值 scrollTop 复位」两条兜底 —— 本场景（内容只在页尾长出来）够用。
  if (box) restoreScrollAnchor(box, scroll);
  return true;
}
// 117o-A7：把 liveTurn 画成 2.0 的样子。返回 false = 这一份账本画不出东西（调用方据此回落到纯文本）。
// 唯一的渲染来源是 renderStaticMessage()：经典壳画一条【落盘助手消息】用的就是它，所以在途回合与
// 回合结束后的那条真消息在结构上一模一样（思考块、过程记录组、工具卡、完成徽章）。
// 组装出来的对象与落盘助手消息同形：{ role:'assistant', segments, toolCalls }。
//   · readonly:true —— 在途回合没有「重跑 / 回退 / 复制这条」这些落盘消息才有的动作，也没有本轮变更；
//   · idScope:'live' —— 工具卡的锚点 id 与落盘消息的不撞车；
//   · running:true —— 137x：在途回合不出「本轮记录 · N 次工具调用」那张索引卡(chat-static-renderer.js
//     的 turnToolIndexCard)——那张卡读着就是回合结束的总结语气，管家开的线程在跑的时候每 3 秒/每条
//     推送重画一次，看着像回合反复「结束」。回合真结束后走静态重渲染(不传这个键)照常显示。
//   · 只把它 .msg-main 里的正文搬过来，不搬它自己那一行引擎徽标头（这张卡有自己的标题行）。
function paintLiveTurnNarrative(els, turn, segments) {
  const signature = liveTurnNarrativeSignature(turn, segments);
  if (els.narrativeSig === signature && els.narrative.firstChild) return true;
  const rendered = renderStaticMessage(
    { role: 'assistant', segments, toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls : [] },
    '', '', { readonly: true, idScope: 'live', running: true },
  );
  const main = rendered && typeof rendered.querySelector === 'function' ? rendered.querySelector('.msg-main') : null;
  const nodes = main ? Array.from(main.children).filter(node => !node.classList.contains('msg-head')) : [];
  if (!nodes.length) return false;
  // 3 秒一拍地整份换掉正文会把用户刚展开的工具卡/思考块又合上。换之前记下哪些开着，换完照原样开回去。
  const open = captureOpenDetails(els.narrative);
  els.narrative.replaceChildren(...nodes);
  restoreOpenDetails(els.narrative, open);
  els.narrativeSig = signature;
  return true;
}
// 内容有没有变的判据。只看会改变屏幕的东西（段的身份/类型/状态/文本长度、工具行的状态与摘要长度），
// 不序列化正文本身 —— 一回合的正文可以有一万多字，每 3 秒 stringify 一遍是白烧。
function liveTurnNarrativeSignature(turn, segments) {
  const tools = Array.isArray(turn && turn.toolCalls) ? turn.toolCalls : [];
  return [
    turn && turn.truncated ? 't' : 'f',
    segments.map(s => `${s.id || ''}:${s.type || ''}:${s.status || ''}:${String(s.text || s.markdown || '').length}`).join(','),
    tools.map(tc => `${(tc && tc.id) || ''}:${(tc && tc.status) || ''}:${String((tc && tc.inputPreview) || '').length}`).join(','),
  ].join('|');
}
// 展开态的身份：优先用元素自己的 id（工具卡有稳定锚点 id），没有 id 的按「同类里的第几个」定位。
// 两个函数用同一套键，配对使用。
function openDetailsKey(node, seen) {
  if (node.id) return `#${node.id}`;
  const cls = node.className || 'details';
  const n = seen.get(cls) || 0;
  seen.set(cls, n + 1);
  return `${cls}#${n}`;
}
function captureOpenDetails(host) {
  const open = new Set();
  if (!host) return open;
  const seen = new Map();
  for (const node of host.querySelectorAll('details')) {
    const key = openDetailsKey(node, seen);
    if (node.open) open.add(key);
  }
  return open;
}
function restoreOpenDetails(host, open) {
  if (!host || !open || !open.size) return;
  const seen = new Map();
  for (const node of host.querySelectorAll('details')) {
    if (open.has(openDetailsKey(node, seen))) node.open = true;
  }
}
function renderCurrentSession() {
  const session = state.currentSession;
  state.shownUsage = null;
  $('sessionTitle').textContent = isUntitledTitle(session?.title) ? t('session.untitled') : session.title.trim(); // 121-K8（§13.7 ⑤）：未命名线程的回落不再是 navigation.workbench「工作台」——那是视角名，印在线程标题上等于说「这条线程叫工作台」
  $('sessionMeta').textContent = session ? (session.cwd || '') : '';
  renderWorkspacePicker(); // v0.9-S3 (C3): keep the top-bar picker in sync with this session's cwd
  updateSkillBadge(); // v1 技能体系: 会话切换时刷新 composer 技能徽标(已启用技能数)
  renderStepBar(session && session.todos); // v0.8-S3: show the task-list bar if this session has todos
  renderMissionBar(session && session.mission); // 第26波b: 会话切换时刷新账本进度条(无账本→隐藏)
  loadAutonomyGrants(); // 第27波: 会话切换时拉取活动授权书(无授权→隐藏抽屉)
  const box = $('messages');
  const anchor = captureScrollAnchor(box);
  const previousLive = box.getAttribute('aria-live') || 'polite';
  box.setAttribute('aria-live', 'off'); // static reconciliation must not make a screen reader replay history
  box.setAttribute('aria-busy', 'true');
  const settleLog = () => {
    box.setAttribute('aria-busy', 'false');
    queueMicrotask(() => box.setAttribute('aria-live', previousLive === 'off' ? 'polite' : previousLive));
  };
  const liveForSession = session ? activeTurns.get(session.id) : null;
  // 117m-A5：一条【别处起的】回合可能一条落盘消息都没有（管家新建线程 → 交办书还没写完就开跑），
  // 那时也不能落空态 —— 空态会把「它正在跑」这张气泡整个吞掉。
  if (!session || (!session.messages?.length && !liveForSession && !liveTurnVisible())) {
    box.replaceChildren(buildEmptyState());
    settleLog();
    renderContextMeter(null);
    refreshKimiContextForSession(session);
    return;
  }
  // v1.0-S7 / 第77波(perf): render only a count/weight bounded tail so opening a long or payload-heavy
  // conversation does not build an unbounded DOM. `start` = index of the first message we render.
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const start = windowStartFor(msgs);
  // When windowed (start > 0), prepend a「加载更早的 N 条」button that reveals MSG_WINDOW_STEP more per click
  // (repeatable to full). It sits above the first rendered message so earlier turns become reachable — this
  // is what keeps rewind/checkpoint targets on off-screen messages recoverable (click up until they render).
  const existing = new Map(Array.from(box.querySelectorAll('[data-message-key]')).map(row => [row.dataset.messageKey, row]));
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.appendChild(buildLoadEarlierButton(start));
  // EC-D 56/56b: 插话已作为 segment 内嵌在助手回合 narrative 内时,跳过其独立 user 行防重复。
  //   ① 活动 live turn(已内嵌 live;turn 结束 activeTurns.delete 后 liveForSession 空 -> 此条失效);
  //   ② 助手回合 segments 已含 steer 段(刷新后静态内嵌,56b)-> 跳过独立行。
  //   旧会话(无 steer segment)不命中 ② -> 仍按独立行渲染(向后兼容)。steered 行恒在助手回合之前(push 顺序),
  //   故 steered 行在窗口内(i>=start)时其助手回合必也在窗口内(j>i>=start),跳过不会丢内容。
  const visibleEntries = visibleSessionMessageEntries(msgs, start, {
    activeTurnSeq: session.turnSeq,
    hasLiveTurn: Boolean(liveForSession),
  });
  for (const { message: m, index: i } of visibleEntries) {
    const key = messageDomKey(m, i, session.id);
    const signature = messageRenderSignature(m, getLocale());
    let row = existing.get(key);
    if (!row || row.dataset.renderSignature !== signature) row = renderStaticMessage(m, key, signature);
    // 132a（53 号文 §1.2）：委托书线程的【第一条】消息 —— 气泡正文只印用户原话，管家补充收进一个折叠块（见 decorateCommissionedFirstMessage）。
    // 行是按 renderSignature 复用的，所以这一步必须幂等；改的是显示层，消息本身一个字没动。
    decorateCommissionedFirstMessage(row, m, i, session);
    fragment.appendChild(row);
  }
  const optimisticPersisted = activeTurnUserIsPersisted(msgs, liveForSession);
  if (liveForSession?.optimisticUserRow && !optimisticPersisted) fragment.appendChild(liveForSession.optimisticUserRow);
  // Locale/config refreshes may legitimately call this while the current turn is streaming. Keep its live
  // keyed shell attached instead of reproducing the old "innerHTML clears the answer in progress" failure.
  const activeRow = activeTurns.get(session.id)?.live?.narrative?.closest('.message');
  if (activeRow && activeRow.isConnected) fragment.appendChild(activeRow);
  // 117m-A5：在途回合的临时气泡挂在会话末尾。它不是消息，上面那一圈窗口化／签名复用逻辑一个字没改，
  // state.currentSession.messages 也一个字没多 —— 回合结束后 liveTurnVisible() 转假，它就自己不见了。
  if (liveTurnVisible()) fragment.appendChild(buildLiveTurnCard());
  else liveTurnCardEls = null;
  box.replaceChildren(fragment);
  settleLog();
  restoreScrollAnchor(box, anchor || { atBottom: true });
  renderContextMeter(latestUsage(session));
  refreshKimiContextForSession(session);
}
// v1.0-S7 (perf): compute the first-rendered-message index for the current window. Returns 0 (render all)
// for a small session or once the user has expanded to the top. state.msgWindowStart is the persisted
// expansion cursor: null means "not yet windowed" → default to the tail; a number is an explicit cursor set
// by「加载更早」(clamped so it can never exceed the tail default or go below 0).
function windowStartFor(msgs) {
  const n = Array.isArray(msgs) ? msgs.length : 0;
  const countTailStart = n <= MSG_WINDOW_THRESHOLD ? 0 : Math.max(0, n - MSG_WINDOW_TAIL);
  const weightedTailStart = weightedMessageTailStart(msgs, { maxMessages: MSG_WINDOW_TAIL });
  const tailStart = Math.max(countTailStart, weightedTailStart);
  if (tailStart === 0) return 0; // small/light session → full render, zero change
  if (state.msgWindowStart == null) return tailStart; // fresh open → show the tail window
  return Math.max(0, Math.min(state.msgWindowStart, tailStart));
}
// v1.0-S7 (perf): the「加载更早」control. Shows how many earlier messages are hidden; clicking reveals
// MSG_WINDOW_STEP more (or all remaining, whichever is smaller) by moving the window cursor up and
// re-rendering. Preserves the reading position by anchoring scroll to the previously-first row.
function buildLoadEarlierButton(start) {
  const wrap = el('div', 'load-earlier-wrap');
  const step = Math.min(MSG_WINDOW_STEP, start);
  const btn = el('button', 'load-earlier', t('chat.loadEarlier', { count: step, remaining: start }));
  btn.type = 'button';
  // v1.0 收官(对抗复核·视图):流式回合期间禁止窗口重绘。renderCurrentSession 会 innerHTML='' 抹掉在途的
  // 流式 row/live.bubble,导致「回答正在生成、点侧栏它就凭空消失」的信任观感事故(数据本身无损,已磁盘验证)。
  // 与 rewind/compact 同款守卫:流式中提示稍候,不重绘。
  btn.onclick = () => {
    if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; }
    state.msgWindowStart = Math.max(0, start - MSG_WINDOW_STEP);
    renderCurrentSession();
    // Anchor to the top so the newly-revealed batch reads from its start (don't jump to bottom).
    const box = $('messages');
    if (box) box.scrollTop = 0;
  };
  wrap.appendChild(btn);
  // 「展开全部」— one-click full expand (also the reachable path exercising expandMessageWindowFully, the
  // designated fallback for any future jump-to-message/search flow that must reach an off-screen message).
  const all = el('button', 'load-earlier load-all', t('chat.expandAll'));
  all.type = 'button';
  all.onclick = () => { if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; } expandMessageWindowFully(); const box = $('messages'); if (box) box.scrollTop = 0; };
  wrap.appendChild(all);
  return wrap;
}
// v1.0-S7 (perf): fully expand the window (render every message). Used as the fallback for jump-to-message /
// search flows so a target on an off-screen message is guaranteed reachable. Idempotent; re-renders once.
function expandMessageWindowFully() {
  state.msgWindowStart = 0;
  renderCurrentSession();
}
// 132a（53 号文 §1；用户 2026-09-21 反馈后重设计）：委托书线程的【第一条】消息 ——
// 气泡正文只印【用户原话】（它本来就是用户说的话），管家补充收进气泡里一个 <details>，
// `<steward-brief …>` 围栏标签不上屏。开合按线程记在内存，刷新回默认合上。
// 三条纪律：① 只认 session.brief（用户自己开的线程没有委托书，一个字不动）；② 幂等（行按 renderSignature 复用）；
// ③ 改的是显示不是数据 —— session.messages[0].content 仍是整段原件，回退／检查点／复制读的都是它。
// （2026-09-22：线程头下那条委托书横幅已按用户拍板整条退役 —— 委托内容本就留在历史第一条消息里，
// 这个折叠块就是它现在的唯一界面形态。）
const COMMISSION_FENCE_OPEN = '<steward-brief added-by="steward">';
const originalOpenIn = new Set();   // 哪几条线程上用户把管家补充展开着（sessionId 表，不是单个游标）
function threadCommissionOriginalText(session) {
  const brief = (session && session.brief && typeof session.brief === 'object') ? session.brief : null;
  return String((brief && brief.userText) || '').trim();
}
function commissionedFirstMessage(message, index, session) {
  if (index !== 0 || !message || message.role !== 'user') return null;
  const userText = threadCommissionOriginalText(session);
  const content = String(message.content || '');
  if (!userText || !content.startsWith(userText) || !content.includes(COMMISSION_FENCE_OPEN)) return null;
  const brief = session.brief;
  const fields = (brief && brief.fields && typeof brief.fields === 'object') ? brief.fields : null;
  const count = fields ? ['acceptance', 'context', 'preferences', 'constraints'].reduce((n, k) => n + (Array.isArray(fields[k]) ? fields[k].length : 0), 0) : 0;
  return { userText, supplement: String(brief.supplement || ''), count };
}
function decorateCommissionedFirstMessage(row, message, index, session) {
  const info = commissionedFirstMessage(message, index, session);
  const bubble = row && row.querySelector('.bubble');
  if (!info || !bubble) return false;
  const open = originalOpenIn.has(String((session && session.id) || ''));
  let fence = bubble.querySelector('details.brief-fence');
  if (!fence) {
    bubble.textContent = info.userText;
    fence = document.createElement('details');
    fence.className = 'brief-fence';
    const summary = document.createElement('summary');
    summary.textContent = info.count ? t('threadCommission.fenceSummary', { count: info.count }) : t('threadCommission.fenceSummaryPlain');
    const pre = document.createElement('pre');
    pre.className = 'brief-fence-body';
    pre.textContent = info.supplement;
    fence.append(summary, pre);
    fence.addEventListener('toggle', () => {
      const id = String((state.currentSession && state.currentSession.id) || '');
      if (fence.open) originalOpenIn.add(id); else originalOpenIn.delete(id);
    });
    bubble.appendChild(fence);
    row.classList.add('is-commissioned');
  }
  if (fence.open !== open) fence.open = open;
  return true;
}

// v1.0-S3 (A): 首跑引导触发条件 —— 会话列表为空 && config.recentWorkspaces 为空数组。纯派生状态，无持久化
// 标记；一旦选了文件夹（recentWorkspaces 非空）或建了会话，条件不再满足，自动回到常规空状态。
function isFirstRun() {
  const noSessions = !(state.sessions && state.sessions.length);
  const rw = state.config && state.config.recentWorkspaces;
  const noWorkspaces = !(Array.isArray(rw) && rw.length);
  return noSessions && noWorkspaces;
}
// v1.0-S3 (A3): 从 state 派生「AI 引擎是否就绪」。就绪来源二选一：所选 Agent CLI 被检出/已配置路径，或已配置任一 provider。
// 返回 { ready, name } —— name 是就绪引擎的人话名（供绿点行显示）。做成小函数，不嵌进模板。
function engineReadiness() {
  const cliType = state.config?.agentCliType === 'kimi' ? 'kimi' : 'claude';
  const cliReady = cliType === 'kimi'
    ? !!(state.config?.kimiPath || state.status?.detectedKimiPath)
    : !!(state.config?.claudePath || state.status?.detectedClaudePath);
  const cliLabel = cliType === 'kimi' ? 'Kimi Code' : 'Claude Code';
  const providers = chatProviders(state.config);   // 「已经有对话引擎了吗」:自动接入的本地语音识别不算
  const providerReady = providers.length > 0;
  if (isProviderMode()) {
    const p = activeProviderObj();
    if (p) return { ready: true, name: p.label || p.id };
  }
  if (cliReady) return { ready: true, name: cliLabel };
  if (providerReady) { const p = providers[0]; return { ready: true, name: (p && (p.label || p.id)) || t('onboarding.engine.providerFallback') }; }
  return { ready: false, name: '' };
}
// v1.0-S3 (A2): 大拖放引导区 —— 点击走既有 pickWorkspace()；拖拽走既有的 shell 级 drop 处理（v0.9-S3 已实现，
// 这里只把心智可视化，不重做 drop 逻辑）。hover/dragover 用 --accent 描边 + --accent-soft 底（同 dropHint 心智）。
function buildOnboardDropZone() {
  const zone = el('button', 'onboard-drop');
  zone.type = 'button';
  zone.appendChild(el('div', 'onboard-drop-icon', '📁'));
  zone.appendChild(el('div', 'onboard-drop-title', t('onboarding.drop.title')));
  zone.appendChild(el('div', 'onboard-drop-sub', t('onboarding.drop.description')));
  // v1.0.2 (G6): 引导区「点击选择」保持一键直开原生选择器(不弹粘贴 popover —— 引导区语义即「点击选择」)。
  zone.onclick = () => pickWorkspaceNative();
  // dragover 视觉反馈：加 .dragging 类（CSS 用 --accent 描边 + --accent-soft 底）。真正的落盘解析仍由 shell
  // 级 drop 监听器处理——这里 preventDefault 让浏览器允许 drop 冒泡到 shell。
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', () => zone.classList.remove('dragging'));
  return zone;
}
// v1.0-S3 (A3): 引擎状态一眼判断卡。就绪 → 绿点 + 「AI 引擎已就绪：<引擎名>」；不可用 → 暖提示卡 + 「去设置」
// 按钮（打开设置 modal 的 Providers 页签）。
function buildOnboardEngine() {
  const r = engineReadiness();
  if (r.ready) {
    const line = el('div', 'onboard-engine ready');
    line.appendChild(el('span', 'onboard-eng-dot'));
    line.appendChild(el('span', '', t('onboarding.engine.readyWithName', { name: r.name })));
    return line;
  }
  // v1.0.2 (F6a):无可用引擎时 —— API 引擎优先。主卡片推荐配 API Key(DeepSeek 注册即得免费额度),
  // 「去配置」直达设置 Providers 页签;Claude CLI 收进折叠的次要入口(details),不再与 API 并列抢注意力。
  const card = el('div', 'onboard-engine warn');
  card.appendChild(el('div', 'onboard-eng-warn-title', t('onboarding.engine.configureKey.title')));
  card.appendChild(el('div', 'onboard-eng-sub', t('onboarding.engine.configureKey.description')));
  const btn = el('button', 'primary', t('onboarding.engine.configureKey.action'));
  btn.type = 'button';
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  card.appendChild(btn);
  // 次要入口:我有 Claude CLI（折叠）。展开后给一个直达 Claude CLI 设置页签的链接式按钮。
  const adv = document.createElement('details'); adv.className = 'onboard-eng-adv';
  const sum = document.createElement('summary'); sum.textContent = t('onboarding.engine.advancedClaude');
  adv.appendChild(sum);
  const advBtn = el('button', 'ghost onboard-eng-adv-btn', t('onboarding.engine.configureClaude'));
  advBtn.type = 'button';
  advBtn.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
  adv.appendChild(advBtn);
  card.appendChild(adv);
  return card;
}
// 118b: 体检摘要红点。没有任何待办时返回 null -- 一个恒亮的「一切正常」徽标只会变成噪音,用户很快
// 就不再看它;只有真有事时才出现,出现就是可点的真动作(直接打开体检页,不是提示用户「去设置里找找」)。
function buildHealthSummaryChip() {
  const summary = healthSummaryText((state.status && state.status.health) || [], t);
  if (!summary) return null;
  const chip = el('button', `health-summary-chip tone-${summary.tone}`);
  chip.type = 'button';
  chip.append(el('span', 'health-summary-dot', '●'), el('span', 'health-summary-text', summary.text));
  chip.append(el('span', 'health-summary-go', t('health.summary.open')));
  chip.onclick = () => { openModal('settingsModal'); switchSettingsTab('doctor', true); };
  return chip;
}
// v1.0-S1 收官补:如意标(SVG)——JS 重建空状态时与 index.html 静态版完全同参(路径/填色/viewBox),
// 不再回退到旧 Claude 字母 "C"。theme.e2e.js 守着此模式不得回潮。
function buildRuyiLogo() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('width', '48'); svg.setAttribute('height', '48');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', t('brand.name'));
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', 'rotate(42 60 60)');
  const head = document.createElementNS(NS, 'path');
  head.setAttribute('fill', 'var(--brand-qh)');
  head.setAttribute('d', 'M60 62 C46 55 30 44 30 32 A13 13 0 0 1 53 24 A7.5 7.5 0 1 1 67 24 A13 13 0 0 1 90 32 C90 44 74 55 60 62 Z');
  const stem = document.createElementNS(NS, 'path');
  stem.setAttribute('fill', 'none'); stem.setAttribute('stroke', 'var(--brand-qh)');
  stem.setAttribute('stroke-width', '11'); stem.setAttribute('stroke-linecap', 'round');
  stem.setAttribute('d', 'M60 57 C53.5 73.7 66.5 90.3 57.7 107');
  const star = document.createElementNS(NS, 'circle');
  star.setAttribute('fill', 'var(--brand-au)'); star.setAttribute('cx', '27'); star.setAttribute('cy', '21'); star.setAttribute('r', '7.5');
  g.append(head, stem); svg.append(g, star);
  const box = el('div', 'empty-logo'); box.setAttribute('aria-hidden', 'true'); box.appendChild(svg);
  return box;
}
function buildEmptyState() {
  // v1.0-S3 (A): 首跑引导变体 —— 会话空 && 无最近工作区时渲染，否则走常规空状态。
  if (isFirstRun()) return buildFirstRunState();
  const wrap = el('div', 'empty-state');
  wrap.appendChild(buildRuyiLogo());
  wrap.appendChild(el('h2', '', t('emptyState.title')));
  // Engine line: "当前引擎：{engineLabel} · {model}" with a colored engine dot.
  const meta = currentEngineMeta();
  const vis = engineVisual(meta);
  const engLine = el('div', 'empty-engine');
  const dot = el('span', 'empty-eng-dot'); dot.style.background = vis.colorVar;
  engLine.append(dot, el('span', '', t('emptyState.currentEngine', { engine: engineLabel(), model: currentModelId() || t('provider.defaultModel') })));
  wrap.appendChild(engLine);
  wrap.appendChild(el('p', '', t('emptyState.description')));
  // Conditional CTA (at most one). Claude + CLI not detected -> set path; provider + no key -> fill key.
  const cta = buildEmptyCTA();
  if (cta) wrap.appendChild(cta);
  // v0.9-S2 (C2): playbook card grid. In simple mode the cards are the primary entry (starters区 hidden by
  // [data-ui-mode]); pro mode keeps both. Unavailable cards render greyed + a one-line reason (never hidden).
  const pbSection = buildPlaybookSection();
  if (pbSection) wrap.appendChild(pbSection);
  return wrap;
}
// v1.0-S3 (A): 首跑引导变体。自上而下：如意标（buildRuyiLogo，与 index.html 静态版同参）；大拖放引导区；
// 引擎状态一眼判断；任务卡（既有 playbook 首页渲染，保留在引导变体下方，不动其逻辑）。DOM 全走
// createElement/textContent（禁 innerHTML）。
function buildFirstRunState() {
  const wrap = el('div', 'empty-state onboard');
  wrap.appendChild(buildRuyiLogo());
  wrap.appendChild(el('h2', '', t('onboarding.title')));
  wrap.appendChild(el('p', '', t('onboarding.description')));
  // 118a: 首跑卡的主行动是走一遍向导(语言/引擎/密钥/文件夹/安全档/试跑),拖放区与引擎卡留作老手直达路径。
  const guideBtn = el('button', 'primary onboard-start-guide', t('onboarding.wizard.start'));
  guideBtn.type = 'button';
  guideBtn.onclick = () => openOnboardingWizard();
  wrap.appendChild(guideBtn);
  if (shouldShowOnboarding(state.config, state.sessions)) wrap.appendChild(el('p', 'onboard-start-hint muted', t('onboarding.wizard.startHint')));
  // 118b: 体检摘要红点。首跑用户根本不知道设置里藏着一页体检,所以把「有几项要处理」直接摆在首屏,
  // 一点就打开体检页(force=true:体检本来就在简易模式白名单里,这里只是不让页签收敛把人弹回基础页)。
  const healthSummary = buildHealthSummaryChip();
  if (healthSummary) wrap.appendChild(healthSummary);
  wrap.appendChild(buildOnboardDropZone());
  wrap.appendChild(buildOnboardEngine());
  // 任务卡（既有 playbook 首页渲染，不动其逻辑）。
  const pbSection = buildPlaybookSection();
  if (pbSection) wrap.appendChild(pbSection);
  return wrap;
}

/* ---------------- v0.9-S2: Playbooks (§7.8 / §4 C2) ---------------- */
// Fetch the playbook list (built-in ∪ user, each with availability) into state, then re-render the empty
// state if it's currently showing. Best-effort — a failure leaves the cards absent, never throws to boot.
async function refreshPlaybooks() {
  try { const r = await api('/api/playbooks'); state.playbooks = (r && r.playbooks) || []; }
  catch { state.playbooks = []; }
  // If the empty state is on screen, refresh it so the freshly-loaded cards appear.
  const box = $('messages');
  if (box && box.querySelector('.empty-state') && (!state.currentSession || !(state.currentSession.messages || []).length)) {
    box.innerHTML = ''; box.appendChild(buildEmptyState());
  }
}
// Build the playbook card grid section, filtered by the current uiMode (a card's uiMode:'simple'|'pro'|'both'
// gates where it shows). Returns null when there are no cards to show. XSS discipline: all playbook text goes
// through el()/textContent — never innerHTML.
function buildPlaybookSection() {
  const mode = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'simple' : 'pro';
  const cards = (state.playbooks || []).filter(pb => pb && (pb.uiMode === 'both' || pb.uiMode === mode || !pb.uiMode));
  if (!cards.length) return null;
  const sec = el('div', 'pb-section');
  sec.appendChild(el('div', 'pb-section-title', t('skills.group.playbooks')));
  const grid = el('div', 'pb-grid');
  for (const pb of cards) grid.appendChild(buildPlaybookCard(pb));
  sec.appendChild(grid);
  return sec;
}
// A single playbook card. Available → clickable (opens the input form modal). Unavailable → greyed +
// a one-line reason (C2: 不隐藏,给一行原因), not clickable.
function buildPlaybookCard(pb) {
  const available = pb.available !== false;
  const card = el(available ? 'button' : 'div', 'pb-card' + (available ? '' : ' unavailable'));
  const head = el('div', 'pb-card-head');
  head.append(el('span', 'pb-card-icon', pb.icon || '📄'), el('span', 'pb-card-title', playbookDisplayName(pb)));
  card.appendChild(head);
  const description = playbookDisplayDescription(pb);
  if (description) card.appendChild(el('div', 'pb-card-desc', description));
  // 127-⑧:未知/需配置/离线降级一句话(可用 → 不建节点);离线那句已含原因,不再叠 ⛔ 原因行。
  const statusText = playbookStatusText(pb);
  if (statusText) card.appendChild(el('div', 'muted pb-card-status', statusText)).dataset.status = pb.status || 'unknown';
  if (!available && !(statusText && pb.status === 'unavailable')) card.appendChild(el('div', 'pb-card-reason', playbookDisplayUnavailableReason(pb) || t('skills.unavailable')));
  if (available) card.onclick = () => openPlaybookModal(pb);
  return card;
}
// Open the input form modal for a playbook. Renders one field per input (folder type = textbox + a hint that
// visual选择 arrives in v0.9-S3). On confirm, assemble the prompt by substituting {key} placeholders and
// call sendPrompt. XSS-safe: labels/hints via el()/textContent.
function openPlaybookModal(pb) {
  const body = el('div', 'pb-form');
  const description = playbookDisplayDescription(pb);
  if (description) body.appendChild(el('p', 'pb-form-desc', description));
  const fields = new Map(); // key -> input element
  for (const inp of (pb.inputs || [])) {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', playbookInputLabel(pb, inp)));
    const ta = el('textarea', 'pb-field-input');
    ta.rows = (inp.type === 'text') ? 3 : 1;
    ta.placeholder = inp.type === 'folder' ? t('skills.playbook.folderPlaceholder') : (inp.type === 'file' ? t('skills.playbook.filePlaceholder') : '');
    // v0.9-S3 (C3): folder inputs get a 📁 button that pops the native picker and fills the field.
    if (inp.type === 'folder') {
      const row = el('div', 'pb-field-folder');
      const pick = el('button', 'file-label pb-pick', t('skills.playbook.pickFolder'));
      pick.onclick = async () => {
        let r;
        try { r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
        catch (e) { toast(t('skills.playbook.pickerError', { reason: apiErrText(e) }), 'err'); return; }
        if (r && r.ok && r.path) { ta.value = r.path; }
        else if (r && !r.ok) toast(t('skills.playbook.pickerUnavailable', { reason: r.error || t('common.unknown') }), 'err');
      };
      row.append(ta, pick);
      field.appendChild(row);
    } else {
      field.appendChild(ta);
    }
    fields.set(inp.key, ta);
    body.appendChild(field);
  }
  if (pb.promptTemplate) {
    const guide = el('details', 'pb-guide');
    guide.appendChild(el('summary', '', t('skills.playbook.viewGuide')));
    guide.appendChild(el('pre', 'pb-guide-text', pb.promptTemplate));
    body.appendChild(guide);
  }
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const go = el('button', 'primary', t('skills.playbook.start'));
  foot.append(cancel, go);
  const modal = buildModal(playbookDisplayName(pb) || t('skills.group.playbooks'), body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    const values = {};
    for (const [key, ta] of fields) values[key] = ta.value.trim();
    const prompt = assemblePlaybookPrompt(pb, values);
    modal.close();
    if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; }
    sendPrompt(prompt);
  };
}
// Pure placeholder substitution: replace every {key} in the template with the user's value (missing values
// become an empty string). Extracted so the e2e can drive the same assembly logic deterministically. Only
// keys the playbook declares are substituted (a stray {foo} in the template is left as-is).
function assemblePlaybookPrompt(pb, values) {
  let out = String(pb.promptTemplate || '');
  for (const inp of (pb.inputs || [])) {
    const v = (values && values[inp.key] != null) ? String(values[inp.key]) : '';
    out = out.split('{' + inp.key + '}').join(v);
  }
  return out;
}
// The single conditional call-to-action for the empty state (§4.7), or null when everything's healthy.
function buildEmptyCTA() {
  if (!isProviderMode()) {
    const kimi = state.config?.agentCliType === 'kimi';
    const detected = kimi ? state.status?.detectedKimiPath : state.status?.detectedClaudePath;
    const configured = kimi ? state.config?.kimiPath : state.config?.claudePath;
    if (!detected && !configured) {
      const b = el('button', 'primary empty-cta', t('emptyState.configureClaude'));
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
      return b;
    }
  } else {
    const p = activeProviderObj();
    if (p && !(p.apiKey && String(p.apiKey).trim())) {
      const b = el('button', 'primary empty-cta', t('emptyState.configureProviderKey', { provider: p.label || p.id }));
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
      return b;
    }
  }
  return null;
}
// meta (optional, assistant only): engine identity used to render the source badge + colored avatar
// so a multi-engine session shows WHICH engine/model produced each reply (A4/§4.4).
  // 117m-A5：页面藏起来／回到前台就重判一次表。挂在本域内，组合根零改动（app.js 不在本切片白名单）。
  try { globalThis.document.addEventListener('visibilitychange', () => syncLivePolling()); }
  catch { /* 非浏览器宿主（静态件 import 本模块时）：没有表可开 */ }
  return Object.freeze({
    autonomyFormSync,
    buildEmptyState,
    cliMissingCard,
    errorCard,
    isFirstRun,
    isUntitledTitle,
    loadAutonomyGrants,
    newSession,
    onboardingStepsFor: onboardingWizard.onboardingStepsFor,
    openBulkCleanupModal,
    openOnboardingWizard,
    openPlaybookModal,
    openSession,
    patchSession,
    previewGrant,
    refreshPlaybooks,
    refreshSessions,
    renderAutonomyBar,
    renderCurrentSession,
    renderMissionBar,
    renderResumeBanner,
    renderSessions,
    renderStepBar,
    // 121-K4：左栏是两视角共用的那一份 DOM。组合根在管家域构造好之后把「重画左栏」的口递进来
    // （迟绑定：session-experience 比 steward-shell 先构造），本文件因此不 import 任何管家侧模块。
    bindRailSessionActions, // 121-K4：左栏行上三枚会话级动作的委托（组合根绑一次）
    setRailRenderer,
    sessionSearchSnapshot, // 121-K4：左栏搜索读它（113b 的结果快照）
    scheduleSessionSearch, // 113b
    revokeAllAutonomyGrants,
    rollbackTurn,
    stopMission,
    submitGrant,
    syncLivePolling, // 117m-A5: 在途回合气泡的唯一开关表入口
    toggleStepBar,
    turnArtifactChips,
    turnSummaryCard,
  });
}
