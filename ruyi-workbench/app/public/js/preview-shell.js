'use strict';

// 第76–78波：默认关闭的新任务台壳层、原始任务单与交办台首页。领域事实只读自
// Mission/Intervention/Session API；五态只调用 mission-state.js，消息正文只调用经典 renderer；
// 交办写动作经组合根注入的单一 command，Preview 不复制 Session/Mission/stream 业务状态机。
import './mission-state.js';
import './preview-narrative.js';
import './preview-notifications.js';
import { icon } from './icons.js';
import { MSG_WINDOW_STEP, MSG_WINDOW_TAIL, MSG_WINDOW_THRESHOLD } from './state.js';
import { getLocale } from './i18n.js';
import {
  captureScrollAnchor,
  messageDomKey,
  messageRenderSignature,
  restoreScrollAnchor,
  visibleSessionMessageEntries,
  weightedMessageTailStart,
} from './turn-narrative.js';
import { createChatScrollController } from './chat-scroll.js';
import { missionCardSignature } from './preview-dock-home.js';
import {
  narrativePlainText,
  reportConclusionExcerpt,
  reportDeliveryText,
  reportPreviewText,
} from './preview-finish.js';
import { hasCrewActivity } from './preview-lenses.js';
import {
  PREVIEW_UI_STATE_STORAGE_KEY,
  normalizePreviewUiState,
  readPreviewUiState,
  writePreviewMissionUiState,
} from './preview-store.js';
import { acceptanceItems, activeAcceptanceIndex, elapsedLabel, pendingCount, taskProgress } from './preview-task-sheet.js';

export const SHELL_MODE_STORAGE_KEY = 'wcw.shellMode';
export const SHELL_MODES = Object.freeze(['classic', 'preview']);
export { PREVIEW_UI_STATE_STORAGE_KEY, normalizePreviewUiState, readPreviewUiState, writePreviewMissionUiState };
export const PREVIEW_DOCK_INITIAL_RENDER = 40;

export function normalizeShellMode(value) {
  return value === 'preview' ? 'preview' : 'classic';
}

export function dockToneForMissionState(value) {
  if (value === 'needs_you') return 'attention';
  if (value === 'running' || value === 'dispatching') return 'active';
  return 'quiet';
}

export function createPreviewShellDomain({
  api,
  state,
  t,
  currentWorkspace = () => '',
  engineLabel = () => '',
  openSettings = () => {},
  closeSettings = () => {},
  openWorkspaceControl = () => {},
  openSafetyControl = () => {},
  openEngineControl = () => {},
  dispatchCommand = async () => ({}),
  openSession = async () => {},
  setClassicDraft = () => {},
  syncClassicIntervention = async () => {},
  steerAgentNode = async () => ({ ok: false }),
  runMissionControlTurn = async () => ({ ok: false }),
  saveMissionAsPlaybook = async () => {},
  saveMissionAsMemory = async () => {},
  apiErrText = error => String(error && error.message || error || ''),
  pickWorkspace = async () => {},
  playbookName = playbook => String(playbook && playbook.title || ''),
  playbookDescription = playbook => String(playbook && playbook.desc || ''),
  playbookUnavailableReason = () => '',
  renderMarkdownInto = (container, value) => {
    if (container) container.textContent = String(value || '');
    return container;
  },
  highlightIn = () => {},
  renderStaticMessage = () => null,
  getActiveTurnLines = () => [],
  notificationApi = globalThis.Notification,
  now = () => new Date(),
} = {}) {
  const missionState = globalThis.MissionState;
  const narrativeRules = globalThis.PreviewNarrative;
  const notificationRules = globalThis.PreviewNotifications;
  const recoverClassicShell = () => {
    try { document.documentElement.setAttribute('data-shell-mode', 'classic'); } catch { /* pre-DOM failure */ }
    try { localStorage.setItem(SHELL_MODE_STORAGE_KEY, 'classic'); } catch { /* local preference may be unavailable */ }
    try {
      const selector = document.getElementById('cfgShellMode');
      if (selector) selector.value = 'classic';
    } catch { /* pre-DOM failure */ }
    return 'classic';
  };
  if (!missionState || typeof missionState.fromCard !== 'function') {
    recoverClassicShell();
    const noOp = () => {};
    const noRefresh = async () => null;
    return Object.freeze({
      applyShellMode: recoverClassicShell,
      bindPreviewShell: recoverClassicShell,
      handlePreviewStreamEvent: noOp,
      isPreviewMode: () => false,
      refreshPreviewShell: noRefresh,
      refreshPreviewShellLabels: noOp,
      renderPreviewShell: noOp,
    });
  }

  let cards = [];
  let lastHomeSignature = null; // renderHome 数据签名：数据未变时跳过整树重建（第77波同款思路）
  let inboxCounts = { total: 0 };
  let pendingInterventions = [];
  let selectedMissionId = '';
  let activeView = 'home';
  let selectedSnapshot = null;
  let selectedSession = null;
  let selectedChanges = null;
  let detailBaselineRevision = null;
  let rawWindowStart = null;
  // 原始镜头跟手性:回合中流事件(工具卡/账本/班组)弄脏会话副本,下一次详情刷新必须重取会话,
  // 否则 renderedSession === session 的恒等短路会让原始镜头停在回合开始时的快照(第86波修复)。
  let rawDirty = false;
  let renderedSession = null;
  let renderedLocale = '';
  let bound = false;
  let pollTimer = null;
  let refreshPromise = null;
  let refreshEpoch = 0;
  let detailEpoch = 0;
  let detailRefreshTimer = null;
  let detailRefreshForce = false;
  let previewLive = null;
  // P2-4: raw 镜头粘性滚动状态机（复用 chat-scroll 的 createChatScrollController）。
  // 旧实现每帧强设 scrollTop，用户上滑时与滚轮对抗；改为跟踪 stickToBottom，仅粘性时跟随。
  let rawScrollController = null;
  let rawScrollBoundHost = null;
  let playbooks = [];
  let playbooksLoaded = false;
  let playbooksPromise = null;
  let dispatchText = '';
  let dispatchDraft = null;
  let dispatchBusy = false;
  let dispatchError = '';
  // 第96波(P4 交办台附件):与经典壳同一条 /api/upload 链路,上传后的服务端附件记录暂存于此,
  // 随 dispatchCommand → sendPrompt 落到 /api/chat/stream(后端早已支持 attachments 字段)。
  let dispatchAttachments = [];
  let archiveQuery = '';
  let archiveFilter = 'all';
  let archiveGroup = 'workspace';
  let archiveInputTimer = 0; // P2-3: 归档搜索防抖，避免每击键全量重建
  let previewUiState = readPreviewUiState();
  let renderedDockSignature = '';
  let dockRenderEpoch = 0;
  let needsDrawerOpen = false;
  let selectedCrewRunId = '';
  let selectedCrewNodeId = '';
  let crewRenderSignature = '';
  let controlBusy = '';
  let controlDraft = null;
  let controlError = '';
  let continueDraft = '';
  let runControlBusy = '';
  let selectedLens = 'scene';
  let liveActivity = null;
  let activityClockTimer = 0;
  let narrativeRenderedSession = '';
  let narrativeRenderedLocale = '';
  const narrativeFeeds = new Map();
  // 长跑内存护栏:每个叙事 feed 的 entries 只保留最近 N 条(渲染窗口 160,留 3 倍供"加载更早"翻页)。
  // 旧实现只 concat 不截断,任务持续活动几小时后 entries 无限增长 → 渲染进程内存爬升直至白屏。
  const NARRATIVE_ENTRIES_MAX = 480;
  let notificationSettings = notificationRules?.readNotificationSettings() || { version: 1, enabled: false, quietStart: '22:00', quietEnd: '08:00' };
  let notificationCoordinator = notificationRules?.normalizeCoordinatorState() || { primed: false, known: [], active: [] };
  let notificationRefreshPromise = null;
  const notificationHandles = new Map();
  const interventionDrafts = new Map();
  const crewDrafts = new Map();
  const crewDeliveryState = new Map();

  const byId = id => document.getElementById(id);
  const hasActiveEditor = root => {
    const active = document.activeElement;
    return Boolean(root && active && root.contains(active)
      && active.matches('input, textarea, select, [contenteditable="true"]')
      && !active.disabled);
  };
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  };
  const stateLabel = value => t(`previewShell.state.${value}`);
  const selectedCard = () => cards.find(card => card && card.missionId === selectedMissionId) || cards[0] || null;
  const selectedSessionId = () => activeView === 'mission' ? String(selectedCard()?.sessionId || '') : '';
  const missionUi = missionId => previewUiState.missions[String(missionId || '')] || { pinned: false, archived: false };
  const updateMissionUi = (missionId, patch) => { previewUiState = writePreviewMissionUiState(missionId, patch); return missionUi(missionId); };

  function storedShellMode() {
    try { return normalizeShellMode(localStorage.getItem(SHELL_MODE_STORAGE_KEY)); }
    catch { return 'classic'; }
  }

  function isPreviewMode() {
    return document.documentElement.getAttribute('data-shell-mode') === 'preview';
  }

  function setStoredShellMode(mode) {
    try { localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode); } catch { /* local preference may be unavailable */ }
  }

  function syncModeControl(mode) {
    const select = byId('cfgShellMode');
    if (select) select.value = mode;
  }

  function desktopNotificationBridge() {
    return globalThis.__ruyiDesktop === 1
      && globalThis.chrome?.webview
      && typeof globalThis.chrome.webview.postMessage === 'function';
  }

  function notificationPermission() {
    if (desktopNotificationBridge()) return 'granted';
    return notificationApi && typeof notificationApi.permission === 'string' ? notificationApi.permission : 'unsupported';
  }

  function closeNeedsNotification(id) {
    const key = String(id || '');
    const handle = notificationHandles.get(key);
    if (!handle) return;
    notificationHandles.delete(key);
    try { handle.close(); } catch { /* Notification close is best-effort */ }
  }

  function closeAllNeedsNotifications() {
    for (const id of [...notificationHandles.keys()]) closeNeedsNotification(id);
  }

  function notificationStatusText() {
    const permission = notificationPermission();
    if (permission === 'unsupported') return t('previewShell.notificationUnsupported');
    if (permission === 'denied') return t('previewShell.notificationDenied');
    if (!notificationSettings.enabled) return t('previewShell.notificationOff');
    return t('previewShell.notificationOn', { p1: notificationSettings.quietStart, p2: notificationSettings.quietEnd });
  }

  function syncNotificationControls() {
    const enabled = byId('cfgPreviewNotifications');
    const start = byId('cfgPreviewQuietStart');
    const end = byId('cfgPreviewQuietEnd');
    const status = byId('previewNotificationStatus');
    if (enabled) {
      enabled.checked = notificationSettings.enabled;
      enabled.disabled = notificationPermission() === 'unsupported';
    }
    if (start) start.value = notificationSettings.quietStart;
    if (end) end.value = notificationSettings.quietEnd;
    if (status) status.textContent = notificationStatusText();
  }

  function saveNotificationSettings(patch) {
    notificationSettings = notificationRules?.writeNotificationSettings({ ...notificationSettings, ...(patch || {}) })
      || { ...notificationSettings, ...(patch || {}) };
    syncNotificationControls();
    return notificationSettings;
  }

  function showNeedsNotification(item) {
    if (!item || !item.id) return;
    const id = String(item.id);
    const title = t('previewShell.notificationTitle');
    const body = t('previewShell.notificationBody', {
      p1: interventionTitle(item),
      p2: interventionTypeLabel(item.type),
      p3: interventionSummary(item),
    });
    if (desktopNotificationBridge()) {
      try { globalThis.chrome.webview.postMessage({ ruyiNotification: { id, title, body } }); } catch { /* native bridge is best-effort */ }
      return;
    }
    if (!notificationApi || typeof notificationApi !== 'function') return;
    try {
      const handle = new notificationApi(title, {
        body,
        tag: `ruyi-intervention-${id}`,
        renotify: false,
      });
      notificationHandles.set(id, handle);
      handle.onclose = () => notificationHandles.delete(id);
      handle.onclick = () => {
        try { handle.close(); } catch { /* best-effort */ }
        try { globalThis.focus?.(); } catch { /* best-effort */ }
        applyShellMode('preview', { focus: false });
        const card = cards.find(row => row && (row.missionId === item.missionId || row.sessionId === item.sessionId));
        if (card) openMissionCard(card, { focus: false });
        void refreshPreviewShell({ quiet: true, forceDetail: true }).then(() => setNeedsDrawer(true, { interventionId: id }));
      };
    } catch { /* OS/browser notification failure must not disturb the task surface */ }
  }

  function syncNeedsNotifications(items) {
    if (!notificationRules) return;
    const pending = Array.isArray(items) ? items.filter(item => item && item.id) : [];
    const transition = notificationRules.reconcileNeedsNotifications(
      notificationCoordinator,
      pending.map(item => item.id),
      {
        enabled: notificationSettings.enabled,
        permission: notificationPermission(),
        quiet: notificationRules.isQuietTime(now(), notificationSettings),
      },
    );
    notificationCoordinator = transition.state;
    for (const id of transition.close) closeNeedsNotification(id);
    const byIntervention = new Map(pending.map(item => [String(item.id), item]));
    for (const id of transition.notify) showNeedsNotification(byIntervention.get(String(id)));
  }

  async function refreshNotificationInbox() {
    if (!notificationSettings.enabled || notificationRefreshPromise) return notificationRefreshPromise;
    notificationRefreshPromise = api('/api/interventions?limit=100').then(response => {
      inboxCounts = response && response.counts || { total: 0 };
      pendingInterventions = Array.isArray(response && response.pending) ? response.pending : [];
      syncNeedsNotifications(pendingInterventions);
      if (isPreviewMode()) { renderFacts(); renderNeedsDrawer({ preserveEditor: true }); }
      return pendingInterventions;
    }).catch(() => null).finally(() => { notificationRefreshPromise = null; });
    return notificationRefreshPromise;
  }

  function startPolling() {
    if (pollTimer) return;
    // 轮询周期 10s → 30s：多历史任务时每轮全量拉取 200 条 mission（数百 KB JSON）+ 全量重建
    // 首页/码头 DOM，10s 频率是"进入交办台很卡、久久加载不完"的主要放大器；30s 对首页准实时
    // 场景无感，通知仍走独立收件箱通道。
    pollTimer = setInterval(() => {
      if (isPreviewMode() && (!document.hidden || notificationSettings.enabled)) void refreshPreviewShell({ quiet: true });
      else if (notificationSettings.enabled) void refreshNotificationInbox();
    }, 30000);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function syncPolling() {
    if (isPreviewMode() || notificationSettings.enabled) startPolling();
    else stopPolling();
  }

  function applyShellMode(value, { persist = true, focus = true } = {}) {
    const mode = normalizeShellMode(value);
    document.documentElement.setAttribute('data-shell-mode', mode);
    syncModeControl(mode);
    if (persist) setStoredShellMode(mode);
    if (mode === 'preview') {
      syncPolling();
      void refreshPreviewShell();
      if (focus) requestAnimationFrame(() => byId('previewMain')?.focus());
    } else {
      syncPolling();
      if (notificationSettings.enabled) void refreshNotificationInbox();
      if (needsDrawerOpen) setNeedsDrawer(false, { focus: false });
      if (focus) requestAnimationFrame(() => byId('sessionTitle')?.focus?.());
    }
    return mode;
  }

  function factValue(id, value, title = '') {
    const node = byId(id);
    if (!node) return;
    node.textContent = value || t('previewShell.unknown');
    if (title) node.title = title;
  }

  function basename(value) {
    const clean = String(value || '').replace(/[\\/]+$/, '');
    return clean.split(/[\\/]/).pop() || clean;
  }

  function permissionLabel() {
    const raw = String(state?.config?.permissionMode || 'default');
    const supported = new Set(['default', 'plan', 'acceptEdits', 'auto', 'bypass']);
    return t(`permission.mode.${supported.has(raw) ? raw : 'default'}.short`);
  }

  function renderFacts() {
    const card = activeView === 'mission' ? selectedCard() : null;
    const workspace = (card && card.cwd) || currentWorkspace() || '';
    factValue('previewWorkspaceValue', basename(workspace), workspace);
    factValue('previewSafetyValue', permissionLabel());
    factValue('previewEngineValue', engineLabel() || t('previewShell.unknown'));
    const total = Math.max(0, Number(inboxCounts && inboxCounts.total) || 0);
    factValue('previewNeedsValue', String(total));
    const fact = byId('previewNeedsFact');
    if (fact) {
      fact.classList.toggle('has-attention', total > 0);
      fact.setAttribute('aria-label', t('previewShell.needsYouAria', { p1: total }));
      fact.setAttribute('aria-expanded', needsDrawerOpen ? 'true' : 'false');
    }
  }

  function progressOf(card, snapshot = null) {
    return taskProgress(card, snapshot);
  }

  function titleOf(card) {
    return String(card && (card.title || card.mission?.goal) || t('previewShell.missionFallback'));
  }

  function firstGlyph(value) {
    return Array.from(String(value || '').trim())[0] || t('previewShell.sealFallback');
  }

  function renderDock() {
    const list = byId('previewMissionDock');
    if (!list) return;
    const dockCards = cards.filter(card => !missionUi(card && card.missionId).archived);
    const models = dockCards.filter(card => card && card.missionId).map(card => {
      const derived = missionState.fromCard(card);
      return { card, derived, titleValue: titleOf(card), progress: progressOf(card), ui: missionUi(card.missionId) };
    });
    const signature = `${getLocale()}\u001e${models.map(({ card, derived, titleValue, progress, ui }) => [
      card.missionId, card.sessionId || '', derived.state, titleValue, progress.percent, ui.pinned ? 1 : 0,
    ].join('\u001f')).join('\u001e')}`;
    if (signature !== renderedDockSignature) {
      const renderEpoch = ++dockRenderEpoch;
      const appendChunk = start => {
        if (renderEpoch !== dockRenderEpoch || signature !== renderedDockSignature) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(models.length, start + PREVIEW_DOCK_INITIAL_RENDER);
        for (let index = start; index < end; index++) {
          const { card, derived, titleValue, progress, ui } = models[index];
          const item = text('div', 'preview-dock-item', '');
          item.setAttribute('role', 'listitem');
          const button = text('button', 'preview-seal', '');
          button.type = 'button';
          button.dataset.missionId = String(card.missionId);
          button.dataset.sessionId = String(card.sessionId || '');
          button.dataset.missionState = derived.state;
          button.dataset.dockTone = dockToneForMissionState(derived.state);
          button.style.setProperty('--mission-progress', String(progress.percent));
          button.title = `${titleValue}\n${stateLabel(derived.state)}`;
          button.setAttribute('aria-label', t('previewShell.sealAria', { p1: titleValue, p2: stateLabel(derived.state), p3: progress.percent }));
          button.setAttribute('aria-pressed', activeView === 'mission' && card.missionId === selectedMissionId ? 'true' : 'false');
          const ring = text('span', 'preview-seal-ring', '');
          ring.setAttribute('aria-hidden', 'true');
          ring.appendChild(text('span', 'preview-seal-glyph', firstGlyph(titleValue)));
          button.append(ring, text('span', 'preview-seal-caption', stateLabel(derived.state)));
          item.appendChild(button);
          // 第95波:悬停快速操作 —— 右上角 ✕ 归档 / 📌 置顶,鼠标移过去即现即点,不必进归档页。
          const dockActions = text('div', 'preview-dock-actions', '');
          const dockArchive = actionButton('', 'preview-dock-quick-action is-archive', () => {
            updateMissionUi(card.missionId, { archived: true });
            renderDock();
            if (activeView === 'mission' && selectedMissionId === card.missionId) openDispatchHome();
            else if (isPreviewMode()) renderHome();
          }, 'dockArchive');
          dockArchive.title = t('previewShell.archiveAction');
          dockArchive.setAttribute('aria-label', t('previewShell.archiveAction'));
          const dockPin = actionButton('', 'preview-dock-quick-action is-pin', () => {
            updateMissionUi(card.missionId, { pinned: !missionUi(card.missionId).pinned });
            renderDock();
          }, 'dockPin');
          dockPin.title = ui.pinned ? t('previewShell.unpin') : t('previewShell.pin');
          dockPin.setAttribute('aria-label', dockPin.title);
          dockPin.setAttribute('aria-pressed', ui.pinned ? 'true' : 'false');
          dockActions.append(dockArchive, dockPin);
          item.appendChild(dockActions);
          fragment.appendChild(item);
        }
        list.appendChild(fragment);
        if (end < models.length) requestAnimationFrame(() => appendChunk(end));
      };
      list.replaceChildren();
      renderedDockSignature = signature;
      appendChunk(0);
    }
    for (const button of list.querySelectorAll('.preview-seal')) {
      button.setAttribute('aria-pressed', activeView === 'mission' && button.dataset.missionId === selectedMissionId ? 'true' : 'false');
    }
    const count = byId('previewDockCount');
    if (count) count.textContent = t('previewShell.taskCount', { p1: models.length });
  }

  function actionButton(label, className, handler, iconName) {
    const button = text('button', className, label);
    button.type = 'button';
    button.onclick = handler;
    // 第90波:可选图标 -- 在文本节点前 prepend SVG,由按钮类 CSS 的 inline-flex+gap 负责对齐。
    if (iconName) {
      const svg = icon(iconName, 15);
      if (svg) { svg.style.flexShrink = '0'; button.insertBefore(svg, button.firstChild); }
    }
    return button;
  }

  async function openSelectedInClassic(draft = '') {
    const card = selectedCard();
    applyShellMode('classic');
    if (card && card.sessionId) {
      await openSession(card.sessionId);
      if (draft) setClassicDraft(draft);
    }
  }

  function interventionTitle(item) {
    const card = cards.find(row => row && (row.missionId === item.missionId || row.sessionId === item.sessionId));
    return card ? titleOf(card) : t('previewShell.missionFallback');
  }

  function interventionTypeLabel(type) {
    return t(`previewShell.interventionType.${['permission', 'question', 'plan', 'pool', 'replan'].includes(type) ? type : 'unknown'}`);
  }

  function interventionSummary(item) {
    if (item.type === 'permission') return item.toolName || t('previewShell.permissionFallback');
    if (item.type === 'question') return item.questionSummary || item.questions?.[0]?.question || t('previewShell.questionFallback');
    if (item.type === 'plan') return item.planSummary || t('previewShell.planFallback');
    if (item.type === 'pool') return item.task || t('previewShell.poolFallback');
    if (item.type === 'replan') return item.replanSummary || t('previewShell.replanFallback');
    return t('previewShell.unknown');
  }

  function decisionKey(item, action) {
    const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `preview:${String(item.id || '').slice(0, 40)}:${String(action || '').slice(0, 16)}:${uuid}`.slice(0, 128);
  }

  function setNeedsDrawer(open, { focus = true, interventionId = '' } = {}) {
    needsDrawerOpen = open === true;
    const shell = byId('previewShell');
    const drawer = byId('previewNeedsDrawer');
    const scrim = byId('previewNeedsScrim');
    shell?.classList.toggle('needs-open', needsDrawerOpen);
    if (drawer) drawer.hidden = !needsDrawerOpen;
    if (scrim) scrim.hidden = !needsDrawerOpen;
    renderFacts();
    if (needsDrawerOpen) {
      renderNeedsDrawer();
      if (focus) requestAnimationFrame(() => {
        const target = interventionId
          ? byId('previewNeedsDrawer')?.querySelector(`[data-intervention-id="${CSS.escape(String(interventionId))}"]`)
          : null;
        if (target) { target.tabIndex = -1; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
        else byId('previewNeedsCloseBtn')?.focus();
      });
    } else if (focus) requestAnimationFrame(() => byId('previewNeedsFact')?.focus());
  }

  async function openInterventionInClassic(item) {
    setNeedsDrawer(false, { focus: false });
    applyShellMode('classic', { focus: false });
    if (item && item.sessionId) await openSession(item.sessionId);
  }

  function appendDecisionError(card, value) {
    const existing = card.querySelector('.preview-decision-error');
    if (existing) existing.remove();
    if (!value) return;
    const error = text('p', 'preview-decision-error', value);
    error.setAttribute('role', 'alert');
    card.appendChild(error);
  }

  function buildQuestionFields(item) {
    const form = text('div', 'preview-question-form', '');
    const questions = Array.isArray(item.questions) ? item.questions : [];
    for (const [index, question] of questions.entries()) {
      const options = Array.isArray(question.options) ? question.options : [];
      const requestedMode = String(question.answerMode || '').toLowerCase();
      let mode = ['single', 'multiple', 'text'].includes(requestedMode)
        ? requestedMode : (options.length ? (question.multiSelect ? 'multiple' : 'single') : 'text');
      if (!options.length && mode !== 'text') mode = 'text';
      const field = document.createElement('fieldset');
      field.className = 'preview-question-field';
      field.dataset.questionId = String(question.id || `question_${index + 1}`);
      field.dataset.answerMode = mode;
      const legend = text('legend', 'preview-question-legend', '');
      legend.append(text('span', 'preview-question-kicker', question.header || t('previewShell.questionNumber', { p1: index + 1 })),
        text('span', 'preview-question-mode', mode === 'multiple' ? t('previewShell.questionChooseMany') : (mode === 'text' ? t('previewShell.questionWrite') : t('previewShell.questionChooseOne'))));
      field.append(legend, text('p', 'preview-question-copy', question.question || question.header || ''));
      if (options.length && mode !== 'text') {
        const optionList = text('div', 'preview-question-options', '');
        for (const option of options) {
          const label = text('label', 'preview-question-option', '');
          const input = document.createElement('input');
          input.type = mode === 'multiple' ? 'checkbox' : 'radio';
          input.name = `preview-${item.id}-${field.dataset.questionId}`;
          input.dataset.optionId = String(option.id || '');
          const indicator = text('span', 'preview-question-indicator', ''); indicator.setAttribute('aria-hidden', 'true');
          const optionCopy = text('span', 'preview-question-option-copy', '');
          optionCopy.appendChild(text('strong', '', option.label || option.id || ''));
          if (option.description) optionCopy.appendChild(text('small', '', option.description));
          label.append(input, indicator, optionCopy); optionList.appendChild(label);
        }
        if (question.allowOther !== false) {
          const otherCard = text('div', 'preview-question-other-card', '');
          const otherChoice = text('label', 'preview-question-option preview-question-other-choice', '');
          const otherInput = document.createElement('input');
          otherInput.type = mode === 'multiple' ? 'checkbox' : 'radio';
          otherInput.name = `preview-${item.id}-${field.dataset.questionId}`;
          otherInput.dataset.otherChoice = 'true';
          const indicator = text('span', 'preview-question-indicator', ''); indicator.setAttribute('aria-hidden', 'true');
          const otherCopy = text('span', 'preview-question-option-copy', '');
          otherCopy.append(text('strong', '', question.otherLabel || t('previewShell.questionOther')),
            text('small', '', t('previewShell.questionOtherHint')));
          otherChoice.append(otherInput, indicator, otherCopy);
          const otherText = document.createElement('textarea'); otherText.rows = 2;
          otherText.dataset.otherText = 'true'; otherText.disabled = true;
          otherText.placeholder = question.otherPlaceholder || t('previewShell.questionPlaceholder');
          otherInput.addEventListener('change', () => {
            otherText.disabled = !otherInput.checked;
            if (otherInput.checked) requestAnimationFrame(() => otherText.focus());
          });
          otherText.addEventListener('input', () => {
            if (String(otherText.value || '').trim() && !otherInput.checked) {
              otherInput.checked = true; otherText.disabled = false;
            }
          });
          otherCard.append(otherChoice, otherText); optionList.appendChild(otherCard);
        }
        field.appendChild(optionList);
      } else {
        const answer = text('label', 'preview-question-text-answer', '');
        answer.appendChild(text('span', '', t('previewShell.questionAnswer')));
        const input = document.createElement('textarea'); input.rows = 3;
        input.dataset.otherText = 'true'; input.placeholder = question.otherPlaceholder || t('previewShell.questionPlaceholder');
        answer.appendChild(input); field.appendChild(answer);
      }
      form.appendChild(field);
    }
    return form;
  }

  function collectQuestionDecision(card) {
    const answers = [];
    for (const field of card.querySelectorAll('.preview-question-field')) {
      const selectedOptionIds = [...field.querySelectorAll('[data-option-id]:checked')].map(input => input.dataset.optionId || '');
      const otherChoice = field.querySelector('[data-other-choice]');
      const acceptsText = field.dataset.answerMode === 'text' || Boolean(otherChoice?.checked);
      const otherText = acceptsText ? String(field.querySelector('[data-other-text]')?.value || '').trim() : '';
      if (otherChoice?.checked && !otherText) return { ok: false, error: t('previewShell.questionRequired') };
      if (!selectedOptionIds.length && !otherText) return { ok: false, error: t('previewShell.questionRequired') };
      answers.push({ questionId: field.dataset.questionId || '', selectedOptionIds, otherText });
    }
    if (!answers.length) return { ok: false, error: t('previewShell.questionUnavailable') };
    return { ok: true, payload: { action: 'answer', answer: { answers } } };
  }

  function stageInterventionDecision(item, payload, { confirm = false } = {}) {
    const request = {
      payload,
      idempotencyKey: decisionKey(item, payload.action),
    };
    interventionDrafts.set(String(item.id), { request, confirm, busy: false, error: '' });
    if (confirm) renderNeedsDrawer();
    else void submitInterventionDecision(item, request);
  }

  async function submitInterventionDecision(item, request) {
    const id = String(item && item.id || '');
    const draft = interventionDrafts.get(id);
    if (!id || !request || draft?.busy) return;
    const next = draft || { request, confirm: false, busy: false, error: '' };
    next.request = request; next.confirm = false; next.busy = true; next.error = '';
    interventionDrafts.set(id, next); renderNeedsDrawer();
    try {
      const response = await api(`/api/missions/${encodeURIComponent(item.missionId)}/interventions/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: Math.max(0, Number(item.interventionVersion) || 0),
          idempotencyKey: request.idempotencyKey,
          ...request.payload,
        }),
      });
      if (!response || response.ok !== true) throw response || new Error(t('previewShell.decisionFailed'));
      interventionDrafts.delete(id);
      pendingInterventions = pendingInterventions.filter(row => String(row && row.id) !== id);
      inboxCounts = { ...inboxCounts, total: Math.max(0, (Number(inboxCounts.total) || 0) - 1) };
      renderPreviewShell();
      try {
        await syncClassicIntervention({
          ...response,
          sessionId: item.sessionId,
          interventionId: id,
          action: request.payload.action,
          feedback: request.payload.feedback || '',
        });
      } catch { /* authoritative decision succeeded; classic refresh is best-effort and safe to repeat */ }
      await refreshPreviewShell({ quiet: true, forceDetail: activeView === 'mission' && selectedSessionId() === item.sessionId });
    } catch (error) {
      next.busy = false;
      next.error = apiErrText(error) || t('previewShell.decisionFailed');
      interventionDrafts.set(id, next);
      renderNeedsDrawer();
      await refreshPreviewShell({ quiet: true });
    }
  }

  function buildInterventionCard(item) {
    const card = text('article', 'preview-intervention-card', '');
    card.dataset.interventionId = String(item.id || '');
    card.dataset.interventionType = String(item.type || '');
    const head = text('header', 'preview-intervention-head', '');
    const labels = text('div', 'preview-intervention-labels', '');
    labels.append(text('span', `preview-intervention-type type-${item.type || 'unknown'}`, interventionTypeLabel(item.type)),
      text('span', `preview-delivery-state ${item.deliverable ? 'is-live' : 'is-away'}`,
        item.deliverable ? t('previewShell.decisionLive') : t('previewShell.decisionAway')));
    head.append(labels, text('time', '', formatTaskTime(item.requestedAt)));
    const title = text('div', 'preview-intervention-title', '');
    title.append(text('strong', '', interventionTitle(item)), text('p', '', interventionSummary(item)));
    card.append(head, title);

    if (item.type === 'permission') {
      const trust = text('div', 'preview-permission-trust', '');
      trust.append(text('span', `preview-tier tier-${item.tier || 'exec'}`, item.tier || 'exec'),
        text('span', item.revertible ? 'is-revertible' : 'is-irreversible', item.revertible ? t('previewShell.revertible') : t('previewShell.irreversible')));
      const scope = text('pre', 'preview-permission-scope', '');
      try { scope.textContent = JSON.stringify(item.input || {}, null, 2); } catch { scope.textContent = String(item.input || ''); }
      card.append(trust, scope);
    } else if (item.type === 'question') {
      if (item.context) {
        const context = text('section', 'preview-question-context', '');
        context.append(text('span', 'preview-question-context-label', t('previewShell.questionContext')),
          text('p', '', String(item.context)));
        card.appendChild(context);
      }
      card.appendChild(buildQuestionFields(item));
    } else if (item.type === 'plan') {
      const note = text('label', 'preview-plan-feedback', t('previewShell.planFeedback'));
      const input = document.createElement('textarea'); input.rows = 2; input.dataset.planFeedback = 'true';
      input.placeholder = t('previewShell.planFeedbackPlaceholder'); note.appendChild(input); card.appendChild(note);
    }

    const draft = interventionDrafts.get(String(item.id));
    if (draft?.confirm) {
      const confirm = text('section', 'preview-decision-confirm', '');
      confirm.setAttribute('role', 'alertdialog');
      confirm.append(text('strong', '', t('previewShell.confirmApprovalTitle')),
        text('p', '', t('previewShell.confirmApprovalBody', { p1: interventionSummary(item) })));
      const actions = text('div', 'preview-intervention-actions', '');
      actions.append(actionButton(t('previewShell.cancel'), '', () => { interventionDrafts.delete(String(item.id)); renderNeedsDrawer(); }),
        actionButton(t('previewShell.confirmApproval'), 'primary', () => { void submitInterventionDecision(item, draft.request); }));
      confirm.appendChild(actions); card.appendChild(confirm);
    } else {
      const actions = text('div', 'preview-intervention-actions', '');
      if (!item.deliverable) {
        actions.appendChild(actionButton(t('previewShell.openMissionClassic'), '', () => { void openInterventionInClassic(item); }));
      } else if (item.type === 'permission') {
        actions.append(actionButton(t('previewShell.deny'), 'danger', () => stageInterventionDecision(item, { action: 'deny' })),
          actionButton(t('previewShell.allow'), 'primary', () => stageInterventionDecision(item, { action: 'allow' }, { confirm: true })));
      } else if (item.type === 'question') {
        actions.appendChild(actionButton(t('previewShell.sendAnswer'), 'primary', () => {
          const collected = collectQuestionDecision(card);
          if (!collected.ok) { appendDecisionError(card, collected.error); return; }
          stageInterventionDecision(item, collected.payload);
        }));
      } else if (item.type === 'plan') {
        actions.append(actionButton(t('previewShell.reject'), 'danger', () => {
          const feedback = String(card.querySelector('[data-plan-feedback]')?.value || '').trim();
          stageInterventionDecision(item, { action: 'reject', ...(feedback ? { feedback } : {}) });
        }), actionButton(t('previewShell.approve'), 'primary', () => {
          const feedback = String(card.querySelector('[data-plan-feedback]')?.value || '').trim();
          stageInterventionDecision(item, { action: 'approve', ...(feedback ? { feedback } : {}) }, { confirm: true });
        }));
      } else if (item.type === 'pool') {
        actions.append(actionButton(t('previewShell.reject'), 'danger', () => stageInterventionDecision(item, { action: 'reject' })),
          actionButton(t('previewShell.approve'), 'primary', () => stageInterventionDecision(item, { action: 'approve' }, { confirm: true })));
      } else if (item.type === 'replan') {
        actions.append(actionButton(t('previewShell.reject'), 'danger', () => stageInterventionDecision(item, { action: 'reject' })),
          actionButton(t('previewShell.approve'), 'primary', () => stageInterventionDecision(item, { action: 'approve' }, { confirm: true })));
      }
      card.appendChild(actions);
    }
    if (draft?.busy) {
      card.classList.add('is-busy');
      const busy = text('p', 'preview-decision-busy', t('previewShell.decisionSending')); busy.setAttribute('role', 'status');
      card.appendChild(busy);
      for (const control of card.querySelectorAll('button,input,textarea')) control.disabled = true;
    } else if (draft?.error) {
      appendDecisionError(card, draft.error);
      const retry = actionButton(t('previewShell.retrySameDecision'), '', () => { void submitInterventionDecision(item, draft.request); });
      retry.dataset.retrySameKey = draft.request.idempotencyKey;
      card.appendChild(retry);
    }
    return card;
  }

  function renderNeedsDrawer({ preserveEditor = false } = {}) {
    const drawer = byId('previewNeedsDrawer');
    if (!drawer || !needsDrawerOpen) return;
    if (preserveEditor && hasActiveEditor(drawer)) return;
    const head = text('header', 'preview-needs-head', '');
    const copy = text('div', '', '');
    copy.append(text('span', 'preview-eyebrow', t('previewShell.needsDrawerEyebrow')),
      text('h2', '', t('previewShell.needsDrawerTitle')),
      text('p', '', t('previewShell.needsDrawerBody', { p1: pendingInterventions.length })));
    const close = actionButton(t('previewShell.needsClose'), 'preview-needs-close', () => setNeedsDrawer(false));
    close.id = 'previewNeedsCloseBtn'; close.setAttribute('aria-label', t('previewShell.needsClose'));
    head.append(copy, close);
    const list = text('div', 'preview-intervention-list', '');
    if (pendingInterventions.length) {
      for (const item of pendingInterventions) list.appendChild(buildInterventionCard(item));
    } else {
      const empty = text('section', 'preview-needs-empty', '');
      empty.append(text('strong', '', t('previewShell.needsEmptyTitle')), text('p', '', t('previewShell.needsEmptyBody')));
      list.appendChild(empty);
    }
    drawer.replaceChildren(head, list);
  }

  function openDispatchHome({ focus = true } = {}) {
    activeView = 'home';
    clearPreviewLive();
    renderPreviewShell();
    if (focus) requestAnimationFrame(() => byId('previewDispatchInput')?.focus());
  }

  function startNewDispatch() {
    if (dispatchBusy) return;
    dispatchText = '';
    dispatchDraft = null;
    dispatchError = '';
    openDispatchHome();
  }

  function openArchive({ focus = true } = {}) {
    activeView = 'archive';
    clearPreviewLive();
    renderPreviewShell();
    if (focus) requestAnimationFrame(() => byId('previewArchiveSearch')?.focus());
  }

  function openMissionCard(card, { focus = true } = {}) {
    if (!card || !card.missionId) return;
    const switching = activeView !== 'mission' || card.missionId !== selectedMissionId;
    activeView = 'mission';
    if (switching) {
      selectedMissionId = card.missionId;
      resetSelectedDetail();
    }
    renderPreviewShell();
    void refreshSelectedMission({ forceSession: true });
    if (focus) byId('previewMain')?.focus();
  }

  function resetSelectedDetail() {
    detailEpoch += 1;
    selectedSnapshot = null;
    selectedSession = null;
    selectedChanges = null;
    detailBaselineRevision = null;
    rawWindowStart = null;
    rawDirty = false;
    renderedSession = null;
    renderedLocale = '';
    selectedCrewRunId = '';
    selectedCrewNodeId = '';
    crewRenderSignature = '';
    selectedLens = 'scene';
    liveActivity = null;
    if (activityClockTimer) { clearInterval(activityClockTimer); activityClockTimer = 0; }
    narrativeRenderedSession = '';
    narrativeRenderedLocale = '';
    // 第88波(安全):切任务时丢弃待确认的控制操作与任务级错误,防止「任务A点停止→切到B→确认栏仍挂在B→Enter误停B」的串台。
    // controlBusy 不在此清——它是异步执行中的态,由 performMissionControl 的 finally 自清;此处只清「待确认草稿」。
    controlDraft = null;
    controlError = '';
    continueDraft = '';
    clearPreviewLive();
  }

  function dispatchWorkspace() {
    return String((dispatchDraft && dispatchDraft.cwd) || currentWorkspace() || state?.config?.defaultWorkspace || '');
  }

  function dispatchPermissionModes() {
    const allowed = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypass']);
    const fromStatus = Array.isArray(state?.status?.permissionModes) ? state.status.permissionModes.filter(mode => allowed.has(mode)) : [];
    const modes = fromStatus.length ? fromStatus : [...allowed];
    const current = String(state?.config?.permissionMode || 'default');
    if (allowed.has(current) && !modes.includes(current)) modes.unshift(current);
    return modes;
  }

  function dispatchPermissionLabel(mode) {
    const value = dispatchPermissionModes().includes(mode) ? mode : 'default';
    return t(`permission.mode.${value}.short`);
  }

  function engineReadiness() {
    const providers = Array.isArray(state?.config?.providers) ? state.config.providers : [];
    const kimi = state?.config?.agentCliType === 'kimi';
    const cli = kimi
      ? Boolean(state?.config?.kimiPath || state?.status?.detectedKimiPath)
      : Boolean(state?.config?.claudePath || state?.status?.detectedClaudePath);
    return { ready: cli || providers.length > 0, label: engineLabel() || (cli ? (kimi ? 'Kimi Code' : 'Claude Code') : '') };
  }

  function formatTaskTime(value) {
    // 第89波:无时间戳不再回退 epoch(1970-01-01 假日期),直接留空由渲染侧省略。
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try { return new Intl.DateTimeFormat(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
    catch { return date.toISOString().slice(0, 16).replace('T', ' '); }
  }

  function homeMissionButton(card, className = '') {
    const derived = missionState.fromCard(card);
    const progress = progressOf(card);
    const button = text('button', `preview-home-task ${className}`.trim(), '');
    button.type = 'button';
    button.dataset.missionId = String(card.missionId || '');
    button.dataset.missionState = derived.state;
    button.onclick = () => openMissionCard(card);
    const header = text('span', 'preview-home-task-head', '');
    header.append(text('strong', 'preview-home-task-title', titleOf(card)), text('span', `preview-home-task-state state-${derived.state}`, stateLabel(derived.state)));
    const goal = text('span', 'preview-home-task-goal', card.mission?.goal || t('previewShell.goalFallback'));
    // 第87波 UX:续办卡内嵌一条细进度条,进行中任务的完成度一眼可见,不必点进去。
    // 第89波(a11y):进度值已在按钮 aria-label 内播报,bar 本体 aria-hidden 防读屏双播报。
    const bar = document.createElement('progress');
    bar.className = 'preview-home-task-bar'; bar.max = Math.max(1, progress.total); bar.value = progress.done;
    bar.setAttribute('aria-hidden', 'true');
    const meta = text('span', 'preview-home-task-meta', '');
    const enter = text('span', 'preview-home-task-enter', ''); enter.appendChild(icon('open', 13));
    meta.append(text('span', '', t('previewShell.progressPercent', { p1: progress.percent })),
      text('span', '', formatTaskTime(card.updatedAt || card.createdAt)),
      enter);
    button.append(header, goal, bar, meta);
    button.setAttribute('aria-label', t('previewShell.homeTaskAria', { p1: titleOf(card), p2: stateLabel(derived.state), p3: progress.percent }));
    // 第95波:首页卡(续办/最近收获)悬停右上角冒出 ✕ 归档 / 📌 置顶,点击即归档,不打断浏览。
    const wrap = text('div', 'preview-home-task-wrap', '');
    const quick = text('div', 'preview-home-quick-actions', '');
    const ui = missionUi(card.missionId);
    const pin = actionButton('', 'preview-home-quick-action is-pin', () => {
      updateMissionUi(card.missionId, { pinned: !missionUi(card.missionId).pinned });
      renderDock(); renderHome();
    }, 'pin');
    pin.title = ui.pinned ? t('previewShell.unpin') : t('previewShell.pin');
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', ui.pinned ? 'true' : 'false');
    const archive = actionButton('', 'preview-home-quick-action is-archive', () => {
      updateMissionUi(card.missionId, { archived: true });
      renderDock(); renderHome();
    }, 'archive');
    archive.title = t('previewShell.archiveAction');
    archive.setAttribute('aria-label', archive.title);
    quick.append(pin, archive);
    wrap.append(button, quick);
    return wrap;
  }

  function prepareDispatch(raw) {
    const prompt = String(raw == null ? dispatchText : raw).trim();
    if (!prompt) {
      dispatchError = t('previewShell.dispatchRequired');
      renderHome();
      byId('previewDispatchInput')?.focus();
      return;
    }
    if (/^[?？]/.test(prompt)) {
      void submitDispatch('quick_ask', prompt.replace(/^[?？]\s*/, ''));
      return;
    }
    dispatchError = '';
    dispatchDraft = {
      prompt,
      cwd: dispatchWorkspace(),
      permissionMode: dispatchPermissionModes().includes(state?.config?.permissionMode) ? state.config.permissionMode : 'default',
      // 第98波(P2c):执行模式显式选择 -- off 手动逐步 / until-done 全自动 / supervised 先暂停。默认全自动(沿用原硬编码)。
      autoMode: 'until-done',
      // 第96波(P4):附件随草稿进入审阅确认卡,确认后一并下发。
      attachments: dispatchAttachments.slice(),
    };
    renderHome();
    requestAnimationFrame(() => byId('previewDispatchStartBtn')?.focus());
  }

  async function submitDispatch(kind, rawPrompt = '') {
    if (dispatchBusy) return;
    const prompt = String(rawPrompt || dispatchDraft?.prompt || dispatchText).trim();
    if (!prompt) {
      dispatchError = t('previewShell.dispatchRequired');
      renderHome();
      return;
    }
    dispatchBusy = true; dispatchError = '';
    renderHome();
    try {
      const request = {
        kind,
        prompt,
        cwd: dispatchDraft?.cwd || dispatchWorkspace(),
        permissionMode: dispatchDraft?.permissionMode || state?.config?.permissionMode || 'default',
        autoMode: dispatchDraft?.autoMode || 'until-done', // 第98波(P2c):执行模式透传到 /api/mission action:start
        // 第96波(P4):附件记录透传到 startPreviewDispatchCommand → sendPrompt。
        attachments: (dispatchDraft?.attachments || dispatchAttachments).slice(),
      };
      const result = await dispatchCommand(request);
      if (!result || !result.sessionId) throw new Error(t('previewShell.dispatchStartFailed'));
      dispatchText = ''; dispatchDraft = null; dispatchAttachments = [];
      if (kind === 'quick_ask') {
        applyShellMode('classic');
        // dispatchCommand 已创建并选中该会话，sendPrompt 也已挂上乐观消息与实时回答。
        // 此时再次 openSession 会在首条消息落盘前把经典消息区重绘为空状态。
        if (state?.currentSession?.id !== result.sessionId) await openSession(result.sessionId);
        return;
      }
      selectedMissionId = result.sessionId;
      activeView = 'mission';
      resetSelectedDetail();
      await refreshPreviewShell({ quiet: true, forceDetail: true });
    } catch (error) {
      activeView = 'home';
      dispatchError = String(error && error.message || error || t('previewShell.dispatchStartFailed'));
      renderHome();
    } finally {
      dispatchBusy = false;
      if (activeView === 'home' && isPreviewMode()) renderHome();
    }
  }

  function buildFirstRunGuide() {
    const recent = Array.isArray(state?.config?.recentWorkspaces) ? state.config.recentWorkspaces : [];
    const ready = engineReadiness();
    // 第89波(首跑修复):完成判定从「有无 recentWorkspaces」改为显式设置完成度 —— 选了工作圈第1步一勾,
    // recentWorkspaces 就有值,旧条件会让第2/3步引导永不被看到。现在引导一直驻留到 工作圈+引擎 都就绪。
    const workspaceReady = recent.length > 0 || Boolean(state?.config?.defaultWorkspace);
    if (cards.length || (workspaceReady && ready.ready)) return null;
    const guide = text('section', 'preview-first-run', '');
    guide.setAttribute('aria-label', t('previewShell.firstRunTitle'));
    guide.appendChild(text('h2', '', t('previewShell.firstRunTitle')));
    const steps = text('div', 'preview-first-run-steps', '');
    const workspaceStep = workspaceReady
      ? text('div', 'preview-first-run-step is-ready', '')
      : actionButton(t('previewShell.firstRunWorkspaceAction'), 'preview-first-run-step preview-first-run-workspace', async () => {
        await pickWorkspace();
        renderFacts(); renderHome();
      });
    workspaceStep.replaceChildren(text('span', 'preview-first-run-number', '1'), text('span', 'preview-first-run-step-copy', workspaceReady
      ? t('previewShell.firstRunWorkspaceReady', { p1: basename(currentWorkspace() || state?.config?.defaultWorkspace || '') || t('previewShell.unknown') })
      : t('previewShell.firstRunWorkspace')));
    // 第89波:第2步从「看起来可点的假控件」改为真按钮 —— 点击打开安全档弹层(与 deskbar 安全档 fact 同链路)。
    const safety = actionButton(t('previewShell.safetySettings'), 'preview-first-run-step', function () { openSafetyControl(this); });
    safety.replaceChildren(text('span', 'preview-first-run-number', '2'), text('span', 'preview-first-run-step-copy', t('previewShell.firstRunSafety', { p1: permissionLabel() })));
    const engine = ready.ready
      ? text('div', 'preview-first-run-step is-ready', '')
      : actionButton(t('previewShell.firstRunEngineAction'), 'preview-first-run-step', () => openSettings('providers'));
    engine.replaceChildren(text('span', 'preview-first-run-number', '3'), text('span', 'preview-first-run-step-copy', ready.ready
      ? t('previewShell.firstRunEngineReady', { p1: ready.label || t('previewShell.unknown') })
      : t('previewShell.firstRunEngine')));
    steps.append(workspaceStep, safety, engine);
    guide.appendChild(steps);
    return guide;
  }

  function homeSectionHeading(index, title, trailing) {
    const head = text('div', 'preview-home-section-head', '');
    const number = text('span', 'preview-section-index', String(index).padStart(2, '0'));
    number.setAttribute('aria-hidden', 'true');
    const copy = text('div', 'preview-home-section-heading-copy', '');
    // 第86波减负:节标题只留一句话标题,说明段落(body)不再渲染 —— 界面不讲道理,直接给动作。
    copy.append(text('h2', '', title));
    head.append(number, copy);
    if (trailing) head.appendChild(trailing);
    return head;
  }

  // 第96波(P4):交办箱附件 —— 与经典壳同一 /api/upload 通道;添加即上传,托盘只保存服务端记录。
  function dispatchFmtBytes(value) {
    const size = Number(value) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1048576) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / 1048576).toFixed(1)}MB`;
  }

  function dispatchFileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('file read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function addDispatchFiles(files) {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return;
    let uploadError = '';
    for (const file of list) {
      if (file.size > 90 * 1048576) { uploadError = t('toast.fileTooLarge', { p1: file.name }); continue; }
      try {
        const data = await dispatchFileToBase64(file);
        const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
        if (res && res.file) dispatchAttachments.push(res.file);
      } catch (error) {
        uploadError = t('toast.uploadFail', { p1: String(error && error.message || error || '') });
      }
    }
    dispatchError = uploadError;
    if (dispatchDraft) dispatchDraft.attachments = dispatchAttachments.slice();
    renderHome();
  }

  function buildDispatchAttachmentTray() {
    const tray = text('div', 'preview-dispatch-attachments', '');
    tray.setAttribute('aria-label', t('previewShell.dispatchAttachmentsAria'));
    dispatchAttachments.forEach((file, index) => {
      const pill = text('span', 'preview-dispatch-attachment', '');
      pill.append(text('span', 'preview-dispatch-attachment-name', `${file.name} · ${dispatchFmtBytes(file.size)}`));
      const remove = actionButton(t('common.remove'), 'preview-dispatch-attachment-x', () => {
        dispatchAttachments.splice(index, 1);
        if (dispatchDraft) dispatchDraft.attachments = dispatchAttachments.slice();
        renderHome();
      }, 'close');
      remove.setAttribute('aria-label', t('chat.attachRemoveAria'));
      pill.appendChild(remove);
      tray.appendChild(pill);
    });
    return tray;
  }

  function buildDispatchComposer() {
    const section = text('section', 'preview-dispatch-box', '');
    section.setAttribute('aria-label', t('previewShell.dispatchBox'));
    const heading = homeSectionHeading(1, t('previewShell.dispatchBox'));
    const field = text('div', 'preview-dispatch-field', '');
    const mark = text('span', 'preview-dispatch-mark', ''); mark.setAttribute('aria-hidden', 'true'); mark.appendChild(icon('send', 15));
    const input = document.createElement('textarea');
    input.id = 'previewDispatchInput'; input.className = 'preview-dispatch-input'; input.rows = 2;
    input.value = dispatchText; input.placeholder = t('previewShell.dispatchPlaceholder'); input.disabled = dispatchBusy;
    input.setAttribute('aria-label', t('previewShell.dispatchInputAria'));
    // 第87波 UX:交办箱随内容自增高(单行起手,最多 10 行),不再常驻 166px 空块挤占首屏。
    const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; };
    input.oninput = () => { dispatchText = input.value; dispatchError = ''; autosize(); };
    input.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); prepareDispatch(input.value); }
    };
    // 第96波(P4):粘贴图片/文件直接进入附件托盘(截图 → Ctrl+V 一步到位)。
    input.onpaste = event => {
      const files = event.clipboardData && event.clipboardData.files ? [...event.clipboardData.files] : [];
      if (!files.length) return;
      event.preventDefault();
      void addDispatchFiles(files);
    };
    requestAnimationFrame(autosize);
    // 第96波(P4):📎 按钮 + 隐藏 file input;整个交办箱都是拖拽目标,拖入时高亮。
    const attachInput = document.createElement('input');
    attachInput.type = 'file'; attachInput.multiple = true; attachInput.hidden = true;
    attachInput.id = 'previewDispatchAttachInput';
    attachInput.onchange = () => { void addDispatchFiles(attachInput.files); attachInput.value = ''; };
    const attach = actionButton(t('previewShell.dispatchAttach'), 'preview-attach-action', () => attachInput.click(), 'paperclip');
    attach.id = 'previewDispatchAttachBtn'; attach.disabled = dispatchBusy;
    attach.setAttribute('aria-label', t('previewShell.dispatchAttachAria'));
    section.addEventListener('dragover', event => {
      if (!event.dataTransfer || ![...(event.dataTransfer.types || [])].includes('Files')) return;
      event.preventDefault();
      section.classList.add('is-dragover');
    });
    section.addEventListener('dragleave', event => {
      if (event.relatedTarget && section.contains(event.relatedTarget)) return;
      section.classList.remove('is-dragover');
    });
    section.addEventListener('drop', event => {
      section.classList.remove('is-dragover');
      const files = event.dataTransfer && event.dataTransfer.files ? [...event.dataTransfer.files] : [];
      if (!files.length) return;
      event.preventDefault();
      void addDispatchFiles(files);
    });
    const actions = text('div', 'preview-dispatch-actions', '');
    const quick = actionButton(t('previewShell.quickAsk'), 'preview-quick-action', () => { void submitDispatch('quick_ask', dispatchText.replace(/^[?？]\s*/, '')); }, 'quickask');
    const review = actionButton(t('previewShell.reviewDispatch'), 'primary preview-launch-action', () => prepareDispatch(dispatchText), 'dispatch');
    quick.id = 'previewQuickAskBtn'; review.id = 'previewDispatchReviewBtn';
    quick.disabled = dispatchBusy; review.disabled = dispatchBusy;
    actions.append(attach, quick, review);
    field.append(mark, input);
    section.append(heading, field);
    if (dispatchAttachments.length) section.appendChild(buildDispatchAttachmentTray());
    // 第97波(P4):一行轻提示告诉用户拖拽/粘贴也能进附件,不占视觉权重。
    const attachHint = text('p', 'preview-dispatch-hint', t('previewShell.dispatchDropHint'));
    section.append(actions, attachHint, attachInput);
    if (dispatchError) {
      const error = text('p', 'preview-dispatch-error', dispatchError); error.setAttribute('role', 'alert'); section.appendChild(error);
    }
    if (dispatchDraft) section.appendChild(buildDispatchConfirmation());
    return section;
  }

  function buildDispatchConfirmation() {
    const card = text('section', 'preview-dispatch-confirm', '');
    card.dataset.estimateVisible = 'false';
    card.setAttribute('aria-label', t('previewShell.confirmTitle'));
    const head = text('div', 'preview-confirm-head', '');
    head.append(text('span', 'preview-confirm-index', '02'), text('div', '', ''));
    head.lastChild.append(text('span', 'preview-eyebrow', t('previewShell.confirmEyebrow')), text('h3', '', t('previewShell.confirmTitle')));
    card.appendChild(head);
    const facts = text('div', 'preview-confirm-facts', '');
    const purpose = text('div', 'preview-confirm-fact preview-confirm-purpose', '');
    purpose.append(text('span', '', t('previewShell.confirmPurpose')), text('strong', '', dispatchDraft.prompt));
    const workspace = text('div', 'preview-confirm-fact', '');
    workspace.append(text('span', '', t('previewShell.confirmWorkspace')), text('strong', '', dispatchDraft.cwd || t('previewShell.unknown')));
    const safety = text('label', 'preview-confirm-fact', '');
    safety.appendChild(text('span', '', t('previewShell.confirmSafety')));
    const select = document.createElement('select'); select.id = 'previewDispatchSafety'; select.disabled = dispatchBusy;
    for (const mode of dispatchPermissionModes()) {
      const option = document.createElement('option'); option.value = mode; option.textContent = dispatchPermissionLabel(mode);
      option.selected = mode === dispatchDraft.permissionMode; select.appendChild(option);
    }
    select.onchange = () => { dispatchDraft.permissionMode = select.value; };
    safety.appendChild(select);
    // 第98波(P2c):执行模式显式选择 -- off 手动逐步 / until-done 全自动 / supervised 建完先暂停。原硬编码 until-done,用户无法改。
    const autoMode = text('label', 'preview-confirm-fact', '');
    autoMode.appendChild(text('span', '', t('previewShell.confirmAutoMode')));
    const autoSelect = document.createElement('select'); autoSelect.id = 'previewDispatchAutoMode'; autoSelect.disabled = dispatchBusy;
    for (const mode of ['off', 'until-done', 'supervised']) {
      const option = document.createElement('option'); option.value = mode; option.textContent = t(`previewShell.dispatchAutoMode.${mode}`);
      option.selected = mode === dispatchDraft.autoMode; autoSelect.appendChild(option);
    }
    autoSelect.onchange = () => { dispatchDraft.autoMode = autoSelect.value; };
    autoMode.appendChild(autoSelect);
    facts.append(purpose, workspace, safety, autoMode);
    // 第96波(P4):确认卡列出随任务下发的附件,避免"以为带上了其实没带上"。
    const draftAttachments = Array.isArray(dispatchDraft.attachments) ? dispatchDraft.attachments : [];
    if (draftAttachments.length) {
      const files = text('div', 'preview-confirm-fact preview-confirm-attachments', '');
      files.append(text('span', '', t('previewShell.confirmAttachments')),
        text('strong', '', draftAttachments.map(file => file.name).join('、')));
      facts.appendChild(files);
    }
    const note = text('p', 'preview-confirm-note', t('previewShell.confirmNoEstimate'));
    const actions = text('div', 'preview-confirm-actions', '');
    const back = actionButton(t('previewShell.confirmBack'), '', () => { dispatchDraft = null; renderHome(); byId('previewDispatchInput')?.focus(); });
    const start = actionButton(dispatchBusy ? t('previewShell.dispatchStarting') : t('previewShell.dispatchStart'), 'primary preview-launch-action', () => { void submitDispatch('mission'); });
    start.id = 'previewDispatchStartBtn'; back.disabled = dispatchBusy; start.disabled = dispatchBusy;
    actions.append(back, start);
    card.append(facts, note, actions);
    return card;
  }

  function buildContinueSection() {
    const section = text('section', 'preview-home-section preview-continue-section', '');
    const active = cards.filter(card => !missionUi(card && card.missionId).archived && ['dispatching', 'running', 'needs_you'].includes(missionState.fromCard(card).state)).slice(0, 4);
    if (!active.length) return null;
    const count = text('span', 'preview-home-section-count', String(active.length));
    const head = homeSectionHeading(2, t('previewShell.continueTitle'), count);
    const rail = text('div', 'preview-continue-rail', '');
    active.forEach(card => rail.appendChild(homeMissionButton(card, 'preview-continue-card')));
    section.append(head, rail);
    return section;
  }

  function buildPlaybookShelf() {
    const mode = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'simple' : 'pro';
    const visible = playbooks.filter(pb => pb && (!pb.uiMode || pb.uiMode === 'both' || pb.uiMode === mode)).slice(0, 4);
    if (!visible.length) return null;
    const section = text('section', 'preview-home-section preview-playbook-section', '');
    const head = homeSectionHeading(3, t('previewShell.playbookTitle'));
    const shelf = text('div', 'preview-playbook-shelf', '');
    for (const [index, pb] of visible.entries()) {
      const available = pb.available !== false;
      const item = text('button', `preview-playbook-card${available ? '' : ' unavailable'}`, '');
      item.type = 'button'; item.disabled = !available;
      item.title = available ? playbookDescription(pb) : playbookUnavailableReason(pb);
      const serial = text('span', 'preview-playbook-serial', String(index + 1).padStart(2, '0'));
      const body = text('span', 'preview-playbook-body', '');
      body.appendChild(text('strong', '', playbookName(pb)));
      // 第89波:剧本图标回退从 ◆ 改为 playbook SVG(与 trace 线条语言同构);enter 箭头与续办卡一致用 open。
      const pbIcon = text('span', 'preview-playbook-icon', '');
      if (pb.icon) pbIcon.textContent = String(pb.icon);
      else pbIcon.appendChild(icon('playbook', 15));
      const enter = text('span', 'preview-playbook-enter', ''); enter.appendChild(icon('open', 13));
      item.append(serial, pbIcon, body, enter);
      item.onclick = () => {
        dispatchText = String(pb.promptTemplate || playbookName(pb) || '').trim();
        dispatchDraft = null; dispatchError = '';
        renderHome(); byId('previewDispatchInput')?.focus();
      };
      shelf.appendChild(item);
    }
    section.append(head, shelf);
    return section;
  }

  function buildRecentSection() {
    const section = text('section', 'preview-home-section preview-recent-section', '');
    const recent = cards.filter(card => !missionUi(card && card.missionId).archived && ['done', 'stopped'].includes(missionState.fromCard(card).state)).slice(0, 3);
    if (!recent.length) return null;
    const head = homeSectionHeading(4, t('previewShell.recentTitle'));
    const grid = text('div', 'preview-recent-grid', '');
    recent.forEach(card => grid.appendChild(homeMissionButton(card, 'preview-recent-card')));
    section.append(head, grid);
    return section;
  }

  function archiveGroupLabel(key) {
    if (archiveGroup === 'state') return stateLabel(key);
    return key || t('previewShell.archiveUnknownWorkspace');
  }

  function archiveCard(card) {
    const derived = missionState.fromCard(card);
    const ui = missionUi(card.missionId);
    const row = text('article', 'preview-archive-card', '');
    row.dataset.missionState = derived.state;
    if (ui.pinned) row.dataset.pinned = 'true';
    if (ui.archived) row.dataset.archived = 'true';
    const open = text('button', 'preview-archive-open', '');
    open.type = 'button'; open.onclick = () => openMissionCard(card);
    const copy = text('span', 'preview-archive-copy', '');
    copy.append(text('strong', 'preview-archive-title', titleOf(card)),
      text('span', 'preview-archive-goal', card.mission?.goal || t('previewShell.goalFallback')));
    const meta = text('span', 'preview-archive-meta', '');
    meta.append(text('span', `preview-home-task-state state-${derived.state}`, stateLabel(derived.state)),
      text('span', '', basename(card.cwd) || t('previewShell.archiveUnknownWorkspace')),
      text('time', '', formatTaskTime(card.updatedAt || card.createdAt)));
    open.append(copy, meta);
    open.setAttribute('aria-label', t('previewShell.archiveOpenAria', { p1: titleOf(card), p2: stateLabel(derived.state) }));
    const actions = text('div', 'preview-archive-actions', '');
    const pin = actionButton(ui.pinned ? t('previewShell.unpin') : t('previewShell.pin'), 'preview-archive-action', () => {
      updateMissionUi(card.missionId, { pinned: !ui.pinned }); renderDock(); renderArchive();
    });
    pin.setAttribute('aria-pressed', ui.pinned ? 'true' : 'false');
    const archive = actionButton(ui.archived ? t('previewShell.unarchive') : t('previewShell.archiveAction'), 'preview-archive-action', () => {
      updateMissionUi(card.missionId, { archived: !ui.archived }); renderDock(); renderArchive();
    });
    archive.setAttribute('aria-pressed', ui.archived ? 'true' : 'false');
    actions.append(pin, archive);
    row.append(open, actions);
    return row;
  }

  function renderArchive() {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'archive'; delete main.dataset.missionId;
    if (archiveInputTimer) { clearTimeout(archiveInputTimer); archiveInputTimer = 0; }
    const article = text('article', 'preview-archive', '');
    const head = text('header', 'preview-archive-head', '');
    const heading = text('div', 'preview-archive-heading', '');
    heading.append(text('span', 'preview-eyebrow', t('previewShell.archiveEyebrow')),
      text('h1', '', t('previewShell.archiveTitle')));
    const terminal = cards.filter(card => ['done', 'stopped'].includes(missionState.fromCard(card).state));
    head.append(heading, text('strong', 'preview-archive-count', t('previewShell.archiveCount', { p1: terminal.length })));

    const controls = text('div', 'preview-archive-controls', '');
    const search = document.createElement('input');
    search.id = 'previewArchiveSearch'; search.type = 'search'; search.value = archiveQuery;
    search.placeholder = t('previewShell.archiveSearch'); search.setAttribute('aria-label', t('previewShell.archiveSearch'));
    // P2-3: 搜索输入防抖 + 仅重建 ledger（不重建控件/搜索框），避免每击键整树 replaceChildren 打断焦点。
    search.oninput = event => {
      archiveQuery = event.target.value;
      if (archiveInputTimer) clearTimeout(archiveInputTimer);
      archiveInputTimer = setTimeout(() => { archiveInputTimer = 0; replaceArchiveLedger(); }, 120);
    };
    const filters = text('div', 'preview-archive-filters', '');
    for (const value of ['all', 'done', 'stopped', 'pinned', 'archived']) {
      const button = actionButton(t(`previewShell.archiveFilter.${value}`), 'preview-archive-filter', () => { archiveFilter = value; syncArchiveFilterPressed(filters); replaceArchiveLedger(); });
      button.dataset.archiveFilter = value;
      button.setAttribute('aria-pressed', archiveFilter === value ? 'true' : 'false');
      filters.appendChild(button);
    }
    const group = document.createElement('select');
    group.id = 'previewArchiveGroup'; group.setAttribute('aria-label', t('previewShell.archiveGroupLabel'));
    for (const value of ['workspace', 'state']) {
      const option = document.createElement('option'); option.value = value; option.textContent = t(`previewShell.archiveGroup.${value}`); group.appendChild(option);
    }
    group.value = archiveGroup; group.onchange = event => { archiveGroup = event.target.value === 'state' ? 'state' : 'workspace'; replaceArchiveLedger(); };
    controls.append(search, filters, group);

    article.append(head, controls, buildArchiveLedger());
    main.replaceChildren(article);
  }

  // P2-3: 仅重建归档列表主体（含过滤/排序/分组），保留控件与搜索框不动 -> 输入焦点不丢、开销 O(可见)。
  function buildArchiveLedger() {
    const terminal = cards.filter(card => ['done', 'stopped'].includes(missionState.fromCard(card).state));
    const query = archiveQuery.trim().toLocaleLowerCase(getLocale());
    const filtered = terminal.filter(card => {
      const derived = missionState.fromCard(card); const ui = missionUi(card.missionId);
      if (archiveFilter === 'done' && derived.state !== 'done') return false;
      if (archiveFilter === 'stopped' && derived.state !== 'stopped') return false;
      if (archiveFilter === 'pinned' && !ui.pinned) return false;
      if (archiveFilter === 'archived' && !ui.archived) return false;
      if (!query) return true;
      return [titleOf(card), card.mission?.goal, card.cwd, stateLabel(derived.state)].some(value => String(value || '').toLocaleLowerCase(getLocale()).includes(query));
    }).sort((a, b) => (Number(missionUi(b.missionId).pinned) - Number(missionUi(a.missionId).pinned)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const groups = new Map();
    for (const card of filtered) {
      const key = archiveGroup === 'state' ? missionState.fromCard(card).state : (basename(card.cwd) || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    const ledger = text('div', 'preview-archive-ledger', '');
    for (const [key, groupCards] of groups) {
      const section = text('section', 'preview-archive-group', '');
      const groupHead = text('div', 'preview-archive-group-head', '');
      groupHead.append(text('h2', '', archiveGroupLabel(key)), text('span', '', String(groupCards.length).padStart(2, '0')));
      const rows = text('div', 'preview-archive-rows', '');
      groupCards.forEach(card => rows.appendChild(archiveCard(card)));
      section.append(groupHead, rows); ledger.appendChild(section);
    }
    if (!filtered.length) ledger.appendChild(text('p', 'preview-home-empty-copy', t('previewShell.archiveEmpty')));
    return ledger;
  }

  function replaceArchiveLedger() {
    const main = byId('previewMain');
    if (!main || main.dataset.view !== 'archive') return;
    const host = main.querySelector('.preview-archive-ledger');
    if (!host) { renderArchive(); return; }
    host.replaceWith(buildArchiveLedger());
    // P2-3: 计数徽章随列表同步--静默刷新更新 cards 时若用户正输入触发 ledger 重建,徽章不滞后于列表。
    const badge = main.querySelector('.preview-archive-count');
    if (badge) {
      const terminal = cards.filter(card => ['done', 'stopped'].includes(missionState.fromCard(card).state));
      badge.textContent = t('previewShell.archiveCount', { p1: terminal.length });
    }
  }

  function syncArchiveFilterPressed(filters) {
    for (const button of filters.children) {
      const value = button.dataset.archiveFilter;
      if (value) button.setAttribute('aria-pressed', archiveFilter === value ? 'true' : 'false');
    }
  }

  function renderHome() {
    const main = byId('previewMain');
    if (!main) return;
    // 第77波(perf)同款签名短路：数据无实质变化时跳过整树 replaceChildren 重建 —— 多历史任务 +
    // 30s 轮询下，每轮都重建首页是"进入交办台很卡"的典型浪费，且会打断交办箱输入焦点。
    // 只有从其它视图切回（main.dataset.view 非 home）才强制重建。
    const alreadyHome = main.dataset.view === 'home';
    const signature = homeDataSignature();
    if (alreadyHome && signature === lastHomeSignature) { syncHomeEditor(); return; }
    main.dataset.view = 'home'; delete main.dataset.missionId;
    lastHomeSignature = signature;
    const article = text('article', 'preview-dispatch-home', '');
    // 首页只保留一句人话标题；说明性眉题和导言退场，首屏直接进入操作。
    const intro = text('header', 'preview-home-intro', '');
    intro.appendChild(text('h1', '', t('previewShell.homeTitle')));
    article.appendChild(intro);
    const guide = buildFirstRunGuide();
    const sections = [guide, buildDispatchComposer(), buildContinueSection(), buildPlaybookShelf(), buildRecentSection()].filter(Boolean);
    article.append(...sections);
    main.replaceChildren(article);
  }

  // 首页渲染签名：覆盖 buildFirstRunGuide / buildDispatchComposer / buildContinueSection /
  // buildPlaybookShelf / buildRecentSection 的全部数据输入。dispatchText 不在签名内（打字态由
  // syncHomeEditor 就地同步，避免输入一半被整树重建打断）；程序性改 dispatchText 的调用点都会
  // 显式 renderHome()，签名不变时仍会经 syncHomeEditor 把值写回输入框。
  function homeDataSignature() {
    const locale = getLocale();
    const recent = Array.isArray(state?.config?.recentWorkspaces) ? state.config.recentWorkspaces : [];
    const workspaceReady = recent.length > 0 || Boolean(state?.config?.defaultWorkspace);
    const engineReady = engineReadiness().ready;
    const uiMode = document.documentElement.getAttribute('data-ui-mode') || 'pro';
    const workspaceLabel = currentWorkspace() || state?.config?.defaultWorkspace || '';
    const permissionMode = state?.config?.permissionMode || '';
    const cardSig = cards.map(card => missionCardSignature(card, missionUi(card && card.missionId))).join(';');
    return [locale, uiMode, workspaceReady ? 1 : 0, workspaceLabel, permissionMode, engineReady ? 1 : 0,
      playbooksLoaded ? playbooks.length : -1,
      dispatchBusy ? 1 : 0, dispatchDraft ? 1 : 0, dispatchError ? 1 : 0, dispatchAttachments.length, cardSig].join('\u001e');
  }

  // 签名未变时的就地同步：把程序性设置的 dispatchText/禁用态写回已存在的交办箱，不重建 DOM。
  function syncHomeEditor() {
    const input = byId('previewDispatchInput');
    if (input) {
      if (document.activeElement !== input && input.value !== dispatchText) input.value = dispatchText;
      input.disabled = dispatchBusy;
    }
    const attachBtn = byId('previewDispatchAttachBtn'); if (attachBtn) attachBtn.disabled = dispatchBusy;
    const quick = byId('previewQuickAskBtn'); if (quick) quick.disabled = dispatchBusy;
    const review = byId('previewDispatchReviewBtn'); if (review) review.disabled = dispatchBusy;
  }

  function renderEmptyMain() {
    renderHome();
  }

  function renderLoadingMain(card) {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'loading';
    main.dataset.missionId = String(card.missionId || '');
    const loading = text('section', 'preview-loading-card', '');
    loading.setAttribute('aria-busy', 'true');
    loading.append(text('span', 'preview-eyebrow', t('previewShell.taskEyebrow')),
      text('h1', '', titleOf(card)), text('p', 'preview-main-copy', t('previewShell.loadingTaskSheet')));
    main.replaceChildren(loading);
  }

  function compactNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    try { return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(number); }
    catch { return String(number); }
  }

  function usageCost(usage) {
    const entries = Object.entries(usage && usage.costsByCurrency || {}).filter(([, value]) => Number(value) > 0);
    if (!entries.length) return t('previewShell.noCost');
    return entries.map(([currency, value]) => `${currency} ${Number(value).toFixed(2)}`).join(' · ');
  }

  function pendingTotal(pending) {
    return pendingCount(pending);
  }

  function resultLabel(snapshot) {
    const status = String(snapshot && snapshot.result && snapshot.result.status || '');
    if (status === 'complete') return t('previewShell.resultComplete');
    if (status === 'stopped') return t('previewShell.resultStopped');
    return t('previewShell.resultPending');
  }

  // 第96波(Layout 精简):指标从四张边框卡改为一行内联文本(标签 muted + 数值同行),保留 data-slot 供表头刷新。
  function makeMetric(slot, label) {
    const metric = text('span', 'preview-task-metric', '');
    metric.append(text('span', 'preview-task-metric-label', label), text('strong', 'preview-task-metric-value', '—'));
    metric.querySelector('strong').dataset.slot = slot;
    return metric;
  }

  function crewStatusGroup(status) {
    if (status === 'running') return 'running';
    if (status === 'paused') return 'paused';
    if (['queued', 'waiting', 'waiting_resource'].includes(status)) return 'waiting';
    if (['succeeded', 'skipped'].includes(status)) return 'done';
    if (['failed', 'blocked', 'rejected', 'interrupted', 'cancelled', 'stopped'].includes(status)) return 'issue';
    return 'unknown';
  }

  function crewStatusLabel(status) {
    return t(`previewShell.crewStatus.${crewStatusGroup(String(status || ''))}`);
  }

  function crewDepths(nodes) {
    const byNode = new Map(nodes.map(node => [String(node && node.id || ''), node]));
    const memo = new Map();
    const visit = (id, visiting = new Set()) => {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return 0;
      const node = byNode.get(id);
      if (!node) return 0;
      const next = new Set(visiting); next.add(id);
      const deps = (Array.isArray(node.dependsOn) ? node.dependsOn : []).filter(dep => byNode.has(String(dep)));
      const depth = deps.length ? 1 + Math.max(...deps.map(dep => visit(String(dep), next))) : 0;
      memo.set(id, depth); return depth;
    };
    for (const id of byNode.keys()) visit(id);
    return memo;
  }

  // 第98波(P5-A):班组图分列用【真实调度波次】(后端 computeWaveSeq 下发),回退拓扑层(老快照/无 wave 时)。
  function crewWaves(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    if (list.some(node => node && typeof node.wave === 'number')) {
      const fallback = crewDepths(list);
      const waves = new Map();
      for (const node of list) {
        const id = String(node && node.id || '');
        const projected = Number(node && node.wave);
        waves.set(id, Number.isSafeInteger(projected) && projected >= 0 ? projected : (fallback.get(id) || 0));
      }
      return waves;
    }
    return crewDepths(nodes); // 回退:老快照无 wave,用依赖拓扑层
  }

  function crewRole(node, index) {
    return node.roleLabel || node.roleId || t('previewShell.crewMemberFallback', { p1: index + 1 });
  }

  function controlReason(reason) {
    const known = new Set(['terminal', 'already_paused', 'complete', 'turn_active', 'budget_exhausted', 'already_running',
      'mission_missing', 'not_terminal', 'already_manual', 'run_active', 'target_unknown', 'no_checkpoints', 'milestone_limit', 'unavailable']);
    return t(`previewShell.controlReason.${known.has(String(reason || '')) ? reason : 'unavailable'}`);
  }

  function scopeChip(scope) {
    return text('small', 'preview-control-scope', t(`previewShell.controlScope.${scope || 'mission'}`));
  }

  function controlButton(label, className, capability, onClick, iconName) {
    const button = actionButton('', className, onClick);
    // 第91波:可选图标 -- icon+label 包成一行(车钟按钮 column-flex,行内图标+标签,scope chip 在下行)。
    const labelRow = text('span', 'preview-control-btn-label', '');
    if (iconName) {
      const svg = icon(iconName, 14);
      if (svg) { svg.style.flexShrink = '0'; labelRow.appendChild(svg); }
    }
    labelRow.appendChild(text('span', '', label));
    button.append(labelRow, scopeChip(capability?.scope));
    button.disabled = controlBusy !== '' || !capability?.enabled;
    if (!capability?.enabled) button.title = controlReason(capability?.reason);
    return button;
  }

  function confirmationRail(message, confirmLabel, onConfirm, onCancel) {
    const rail = text('div', 'preview-control-confirm', '');
    rail.setAttribute('role', 'alert');
    const copy = text('p', '', message);
    const actions = text('div', 'preview-control-confirm-actions', '');
    const confirm = actionButton(confirmLabel, 'danger', onConfirm);
    const cancel = actionButton(t('previewShell.controlCancel'), 'ghost', onCancel);
    confirm.disabled = Boolean(controlBusy || runControlBusy);
    cancel.disabled = Boolean(controlBusy || runControlBusy);
    actions.append(confirm, cancel); rail.append(copy, actions);
    return rail;
  }

  async function performMissionControl(action, extraPrompt = '') {
    const sessionId = selectedSessionId();
    if (!sessionId || controlBusy) return;
    controlBusy = action; controlError = ''; renderTaskSheet(selectedCard());
    try {
      const response = await api(`/api/missions/${encodeURIComponent(sessionId)}/control`, {
        method: 'POST', body: JSON.stringify({ action, ...(extraPrompt ? { prompt: extraPrompt } : {}) }),
      });
      if (!response || response.ok !== true) throw response || new Error(t('previewShell.controlFailed'));
      if (selectedSnapshot) {
        selectedSnapshot.mission = response.mission || selectedSnapshot.mission;
        selectedSnapshot.result = response.mission?.result || null;
        selectedSnapshot.controls = response.controls || selectedSnapshot.controls;
      }
      controlDraft = null;
      await refreshPreviewShell({ quiet: true, forceDetail: true });
      if (response.requiresTurn) {
        const prompt = action === 'retry' ? t('previewShell.controlRetryPrompt') : action === 'next_turn' ? (extraPrompt || t('previewShell.controlContinuePrompt')) : t('previewShell.controlContinuePrompt');
        // 第97波:保持在任务单内推进 —— preview 壳经 previewStreamSink 承接回合流(raw 镜头 live 文本)+
        // 240ms 详情轮询刷新,不再 applyShellMode('classic') 跳经典壳。
        const started = await runMissionControlTurn({ sessionId, action, prompt });
        if (!started || started.ok === false) throw new Error(started && started.error || t('previewShell.controlTurnFailed'));
      }
    } catch (error) {
      controlError = apiErrText(error) || t('previewShell.controlFailed');
    } finally {
      controlBusy = ''; renderMain();
    }
  }

  async function performCheckpointRollback(entry) {
    if (!entry || controlBusy) return;
    controlBusy = `entry:${entry.turnSeq}:${entry.entrySeq}`; controlError = ''; renderTaskSheet(selectedCard());
    try {
      const response = await api('/api/checkpoints/rollback', {
        method: 'POST', body: JSON.stringify({ sessionId: selectedSessionId(), turnSeq: entry.turnSeq, entrySeq: entry.entrySeq }),
      });
      if (!response || response.ok !== true) throw response || new Error(t('previewShell.controlFailed'));
      controlDraft = null;
      await refreshPreviewShell({ quiet: true, forceDetail: true });
    } catch (error) {
      controlError = apiErrText(error) || t('previewShell.controlFailed');
    } finally {
      controlBusy = ''; renderMain();
    }
  }

  async function performRunControl(run, action) {
    if (!run || runControlBusy) return;
    runControlBusy = `${run.id}:${action}`; controlError = ''; crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot);
    try {
      const response = await api(`/api/agent-runs/${encodeURIComponent(run.id)}`, {
        method: 'POST', body: JSON.stringify({ sessionId: selectedSessionId(), action }),
      });
      if (!response || response.ok !== true) throw response || new Error(t('previewShell.controlFailed'));
      controlDraft = null;
      await refreshPreviewShell({ quiet: true, forceDetail: true });
    } catch (error) {
      controlError = apiErrText(error) || t('previewShell.controlFailed');
    } finally {
      runControlBusy = ''; crewRenderSignature = ''; renderMain();
    }
  }

  function buildCrewRunControls(run) {
    const panel = text('div', 'preview-run-control', '');
    panel.setAttribute('aria-label', t('previewShell.runControlTitle'));
    panel.appendChild(text('span', 'preview-run-control-label', t('previewShell.runControlTitle')));
    const buttons = text('div', 'preview-run-control-buttons', '');
    const pause = actionButton(t('previewShell.runPause'), '', () => { void performRunControl(run, 'pause'); }, 'pause');
    const resume = actionButton(t('previewShell.runContinue'), '', () => { void performRunControl(run, 'resume'); }, 'resume');
    const stop = actionButton(t('previewShell.runStop'), 'danger-ghost', () => {
      controlDraft = { kind: 'run', action: 'stop', runId: run.id }; crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot);
    }, 'stop');
    pause.disabled = Boolean(runControlBusy) || !run.live || run.paused;
    resume.disabled = Boolean(runControlBusy) || !(run.live && run.paused);
    stop.disabled = Boolean(runControlBusy) || !run.live;
    for (const button of [pause, resume, stop]) button.appendChild(scopeChip('run'));
    buttons.append(pause, resume, stop); panel.appendChild(buttons);
    if (controlDraft?.kind === 'run' && controlDraft.runId === run.id) {
      panel.appendChild(confirmationRail(t('previewShell.runStopConfirm'), t('previewShell.runStopConfirmAction'),
        () => { void performRunControl(run, 'stop'); }, () => { controlDraft = null; crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot); }));
    }
    return panel;
  }

  function foremanBrief(run, nodes) {
    const groups = nodes.reduce((counts, node) => {
      const group = crewStatusGroup(node.status); counts[group] = (counts[group] || 0) + 1; return counts;
    }, {});
    const current = nodes.find(node => node.status === 'running')
      || nodes.find(node => ['queued', 'waiting', 'waiting_resource'].includes(node.status))
      || nodes.find(node => node.progress) || nodes[0];
    const focus = current ? (current.progress || current.task || crewRole(current, nodes.indexOf(current))) : t('previewShell.crewNoFocus');
    return t('previewShell.crewForemanBrief', {
      p1: nodes.length,
      p2: groups.running || 0,
      p3: (groups.waiting || 0) + (groups.paused || 0),
      p4: groups.done || 0,
      p5: groups.issue || 0,
      p6: focus,
    });
  }

  function crewRunChoice(snapshot) {
    const runs = Array.isArray(snapshot && snapshot.runs) ? snapshot.runs.filter(Boolean) : [];
    if (!runs.length) return { runs, run: null };
    let run = runs.find(item => String(item.id || '') === selectedCrewRunId);
    if (!run) run = runs.find(item => item.live) || runs[0];
    selectedCrewRunId = String(run && run.id || '');
    return { runs, run };
  }

  function crewProposalNode(item, index, depths) {
    const dependencies = Array.isArray(item.dependsOn) && item.dependsOn.length
      ? item.dependsOn : (item.proposedBy ? [item.proposedBy] : []);
    const baseDepth = dependencies.reduce((max, id) => Math.max(max, depths.get(String(id)) ?? -1), -1);
    return { ...item, id: String(item.id || `proposal_${index}`), dependsOn: dependencies, proposal: true, depth: baseDepth + 1 };
  }

  function openCrewProposal(item) {
    const pending = pendingInterventions.find(row => row && String(row.id || '') === String(item && item.id || ''));
    if (pending) setNeedsDrawer(true, { interventionId: pending.id });
    else void refreshPreviewShell({ quiet: true, forceDetail: true }).then(() => setNeedsDrawer(true, { interventionId: item && item.id }));
  }

  function buildCrewMember(node, index) {
    const proposal = node.proposal === true;
    const group = proposal ? 'proposal' : crewStatusGroup(node.status);
    const button = actionButton('', `preview-crew-member is-${group}`, () => {
      if (proposal) { openCrewProposal(node); return; }
      selectedCrewNodeId = String(node.id || ''); crewRenderSignature = '';
      renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot);
      requestAnimationFrame(() => document.querySelector('.preview-crew-handoff textarea:not(:disabled)')?.focus());
    });
    button.dataset.crewNodeId = String(node.id || '');
    button.dataset.crewNodeStatus = String(node.status || '');
    if (proposal) button.dataset.interventionId = String(node.id || '');
    button.setAttribute('aria-pressed', !proposal && selectedCrewNodeId === String(node.id || '') ? 'true' : 'false');
    const number = text('span', 'preview-crew-number', String(index + 1).padStart(2, '0'));
    const copy = text('span', 'preview-crew-member-copy', '');
    const label = proposal
      ? t('previewShell.crewProposalRole', { p1: node.roleId || t('previewShell.crewMemberFallback', { p1: index + 1 }) })
      : crewRole(node, index);
    copy.append(text('strong', '', label), text('small', '', proposal ? t('previewShell.crewProposalStatus') : crewStatusLabel(node.status)));
    const pulse = text('span', 'preview-crew-status-dot', ''); pulse.setAttribute('aria-hidden', 'true');
    const task = text('span', 'preview-crew-task', node.progress || node.task || t('previewShell.crewNoFocus'));
    button.append(number, copy, pulse, task);
    if (node.dependsOn && node.dependsOn.length) {
      button.appendChild(text('span', 'preview-crew-deps', t('previewShell.crewAfter', { p1: node.dependsOn.join(' · ') })));
    }
    return button;
  }

  function crewSteerReason(node, run) {
    if (!run.live || node.steerReason === 'not_live') return t('previewShell.crewSteerNotLive');
    if (node.steerReason === 'deterministic_gate' || node.deterministic) return t('previewShell.crewSteerDeterministic');
    if (node.steerReason === 'terminal') return t('previewShell.crewSteerTerminal');
    return t('previewShell.crewSteerUnavailable');
  }

  function buildCrewHandoff(run, node, nodeIndex) {
    const panel = text('section', 'preview-crew-handoff', '');
    panel.dataset.crewSelected = String(node.id || '');
    const copy = text('div', 'preview-crew-handoff-copy', '');
    copy.append(text('span', 'preview-eyebrow', t('previewShell.crewSelectedEyebrow')),
      text('h3', '', crewRole(node, nodeIndex)),
      text('p', '', node.task || t('previewShell.crewNoTask')));
    const meta = text('div', 'preview-crew-handoff-meta', '');
    meta.append(text('span', `is-${crewStatusGroup(node.status)}`, crewStatusLabel(node.status)),
      text('code', '', node.id || ''),
      text('span', '', [node.engine, node.model].filter(Boolean).join(' · ') || t('previewShell.crewEngineUnknown')));
    copy.appendChild(meta);

    const key = `${run.id}:${node.id}`;
    const form = text('div', 'preview-crew-steer', '');
    const label = text('label', '', t('previewShell.crewSteerLabel', { p1: crewRole(node, nodeIndex) }));
    const input = document.createElement('textarea'); input.rows = 2;
    input.value = crewDrafts.get(key) || '';
    input.placeholder = node.steerable ? t('previewShell.crewSteerPlaceholder') : crewSteerReason(node, run);
    input.disabled = !node.steerable;
    input.dataset.crewSteerInput = key;
    input.addEventListener('input', () => crewDrafts.set(key, input.value));
    label.appendChild(input);
    const actions = text('div', 'preview-crew-steer-actions', '');
    const stateValue = crewDeliveryState.get(key) || null;
    const send = actionButton(t('previewShell.crewSteerSend'), 'primary', async () => {
      const value = String(input.value || '').trim();
      if (!value) { crewDeliveryState.set(key, { type: 'error', text: t('previewShell.crewSteerRequired') }); crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot); return; }
      crewDrafts.set(key, value); crewDeliveryState.set(key, { type: 'sending', text: t('previewShell.crewSteerSending') });
      crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot);
      const result = await steerAgentNode({ sessionId: selectedSessionId(), runId: run.id, nodeId: node.id, nodeStatus: node.status, engine: node.engine, text: value });
      if (result && result.ok) {
        crewDrafts.delete(key);
        crewDeliveryState.set(key, { type: 'success', text: result.immediate ? t('previewShell.crewSteerImmediate') : t('previewShell.crewSteerQueued') });
        scheduleDetailRefresh(false);
      } else {
        crewDeliveryState.set(key, { type: 'error', text: result && result.error || t('previewShell.crewSteerFailed') });
      }
      crewRenderSignature = ''; renderCrewLens(ensureTaskSheet(selectedCard()), selectedSnapshot);
      if (!(result && result.ok)) requestAnimationFrame(() => document.querySelector(`[data-crew-steer-input="${CSS.escape(key)}"]`)?.focus());
    });
    send.disabled = !node.steerable || stateValue?.type === 'sending';
    actions.appendChild(send);
    if (stateValue) {
      const status = text('p', `preview-crew-steer-state is-${stateValue.type}`, stateValue.text);
      status.setAttribute('role', stateValue.type === 'error' ? 'alert' : 'status'); actions.appendChild(status);
    } else if (!node.steerable) {
      actions.appendChild(text('p', 'preview-crew-steer-state', crewSteerReason(node, run)));
    } else {
      actions.appendChild(text('p', 'preview-crew-steer-state', node.status === 'running' ? t('previewShell.crewSteerLiveHint') : t('previewShell.crewSteerQueueHint')));
    }
    form.append(label, actions); panel.append(copy, form);
    return panel;
  }

  function renderCrewLens(article, snapshot) {
    const host = article?.querySelector('[data-slot="crewLens"]');
    if (!host) return;
    const { runs, run } = crewRunChoice(snapshot);
    const nodes = Array.isArray(run && run.nodes) ? run.nodes.filter(node => node && node.id) : [];
    const proposals = Array.isArray(run && run.proposals) ? run.proposals : [];
    if (!run || (!nodes.length && !proposals.length)) {
      host.hidden = true; host.replaceChildren(); crewRenderSignature = ''; return;
    }
    host.hidden = false;
    if (!nodes.some(node => String(node.id) === selectedCrewNodeId)) {
      selectedCrewNodeId = String((nodes.find(node => node.status === 'running') || nodes[0] || {}).id || '');
    }
    const signature = JSON.stringify({
      locale: getLocale(), runId: run.id, eventSeq: run.eventSeq, selectedCrewNodeId,
      runs: runs.map(item => [item.id, item.status, item.eventSeq]),
      nodes: nodes.map(node => [node.id, node.status, node.progress, node.steerable, node.steerReason]),
      proposals: proposals.map(item => [item.id, item.task, item.proposedBy]),
      deliveries: [...crewDeliveryState.entries()].filter(([key]) => key.startsWith(`${run.id}:`)),
      controlDraft, runControlBusy,
    });
    if (crewRenderSignature === signature && host.childElementCount) return;
    crewRenderSignature = signature;

    const head = text('header', 'preview-crew-head', '');
    const heading = text('div', 'preview-crew-heading', '');
    heading.append(text('span', 'preview-eyebrow', t('previewShell.crewEyebrow')),
      text('h2', '', t('previewShell.crewTitle')),
      text('p', 'preview-crew-foreman', foremanBrief(run, nodes)));
    const runTabs = text('div', 'preview-crew-runs', ''); runTabs.setAttribute('role', 'tablist');
    for (const [index, item] of runs.slice(0, 6).entries()) {
      const button = actionButton(t('previewShell.crewRunLabel', { p1: index + 1 }), `preview-crew-run is-${crewStatusGroup(item.status)}`, () => {
        selectedCrewRunId = String(item.id || ''); selectedCrewNodeId = ''; crewRenderSignature = '';
        renderCrewLens(article, snapshot);
      });
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(item.id) === String(run.id) ? 'true' : 'false');
      button.title = String(item.id || ''); runTabs.appendChild(button);
    }
    const runTools = text('div', 'preview-crew-run-tools', '');
    runTools.append(runTabs, buildCrewRunControls(run));
    head.append(heading, runTools);

    const depths = crewDepths(nodes);
    const waves = crewWaves(nodes);
    const graphNodes = nodes.map(node => ({ ...node, proposal: false, wave: waves.get(String(node.id)) ?? 0 }));
    const maxWave = graphNodes.reduce((max, node) => Math.max(max, node.wave || 0), 0);
    const stage = text('div', 'preview-crew-stage', ''); stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', t('previewShell.crewGraphAria'));
    for (let wave = 0; wave <= maxWave; wave++) {
      const lane = text('section', 'preview-crew-lane', ''); lane.dataset.crewDepth = String(wave);
      // 第98波(P5-A):分列改用后端真实调度波次(computeWaveSeq,纳入并发上限+wait),标签回到"第N波"。
      lane.appendChild(text('span', 'preview-crew-lane-label', t('previewShell.crewWave', { p1: wave + 1 })));
      const laneMembers = text('div', 'preview-crew-lane-members', '');
      for (const node of graphNodes.filter(item => item.wave === wave)) laneMembers.appendChild(buildCrewMember(node, graphNodes.indexOf(node)));
      lane.appendChild(laneMembers); stage.appendChild(lane);
    }
    // 第95波:提议中的子代理(proposal)不占执行层 —— 它们还没被批准,真实调度里也还没进 DAG;
    // 单独渲染在 stage 下方的"待批准提议"区,与已执行的层明确区分,消除"多出一列"的错位感。
    if (proposals.length) {
      const proposalsPanel = text('section', 'preview-crew-proposals', '');
      proposalsPanel.setAttribute('aria-label', t('previewShell.crewProposalsAria'));
      const proposalsHead = text('div', 'preview-crew-proposals-head', '');
      proposalsHead.append(text('span', 'preview-eyebrow', t('previewShell.crewProposalsEyebrow')),
        text('h3', '', t('previewShell.crewProposalsTitle')),
        text('span', 'preview-crew-proposals-count', String(proposals.length).padStart(2, '0')));
      const proposalsList = text('div', 'preview-crew-proposals-list', '');
      proposals.forEach((item, index) => proposalsList.appendChild(buildCrewMember(crewProposalNode(item, index, depths), nodes.length + index)));
      proposalsPanel.append(proposalsHead, proposalsList);
      stage.appendChild(proposalsPanel);
    }
    const selected = nodes.find(node => String(node.id) === selectedCrewNodeId) || nodes[0];
    host.replaceChildren(head, stage);
    if (selected) host.appendChild(buildCrewHandoff(run, selected, nodes.indexOf(selected)));
  }

  function narrativeFeed(sessionId) {
    const id = String(sessionId || '');
    if (!narrativeFeeds.has(id)) {
      narrativeFeeds.set(id, { sessionId: id, entries: [], cursor: 0, degraded: false, gap: null, currentRevision: 0, windowStart: null });
      if (narrativeFeeds.size > 32) narrativeFeeds.delete(narrativeFeeds.keys().next().value);
    }
    return narrativeFeeds.get(id);
  }

  function foldNarrativeResponse(sessionId, response) {
    const feed = narrativeFeed(sessionId);
    if (!narrativeRules || !response) return feed;
    const folded = narrativeRules.appendNarrativeEntries(feed.entries, response.changes);
    let entries = folded.entries;
    // 有界护栏:超过上限时丢弃最旧条目,并把 windowStart 前移相同量,保证它仍指向数组内的有效位置。
    if (entries.length > NARRATIVE_ENTRIES_MAX) {
      const drop = entries.length - NARRATIVE_ENTRIES_MAX;
      entries = entries.slice(drop);
      if (feed.windowStart != null) feed.windowStart = Math.max(0, feed.windowStart - drop);
    }
    feed.entries = entries;
    if (feed.windowStart == null) feed.windowStart = Math.max(0, feed.entries.length - 160);
    else if (feed.windowStart > 0 && folded.added.length) feed.windowStart = Math.min(feed.entries.length, feed.windowStart + folded.added.length);
    feed.degraded = response.degraded === true;
    feed.gap = response.gap || null;
    feed.currentRevision = Math.max(feed.currentRevision, Number(response.currentRevision) || 0);
    if (!feed.degraded) feed.cursor = Math.max(feed.cursor, Number(response.currentRevision) || folded.lastSeq);
    else if (response.gap?.prefix && Number(response.baseRevision) > feed.cursor) feed.cursor = Number(response.baseRevision);
    return feed;
  }

  function narrativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('previewShell.narrativeTimeUnknown');
    try { return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(date); }
    catch { return String(value || '').slice(11, 16) || t('previewShell.narrativeTimeUnknown'); }
  }

  function narrativeStatus(value) {
    const status = String(value || 'unknown');
    const known = new Set(['complete', 'stopped', 'allowed', 'denied', 'answered', 'cancelled', 'approved', 'rejected', 'cancelled_restart', 'unknown']);
    return t(`previewShell.narrativeStatus.${known.has(status) ? status : 'unknown'}`);
  }

  function narrativeError(value) {
    const errorClass = String(value || 'unknown');
    const known = new Set(['provider_misconfigured', 'network_down', 'tool_error', 'claude_cli_error', 'unknown']);
    return t(`previewShell.narrativeError.${known.has(errorClass) ? errorClass : 'unknown'}`);
  }

  function narrativeEngine(value) {
    if (value === 'openai') return 'OpenAI';
    if (value === 'claude') return 'Claude';
    return t('previewShell.narrativeCrew');
  }

  function narrativeTurnContext(entry) {
    if (!entry || entry.sentenceKey !== 'progress_turn') return null;
    const turnSeq = Number(entry.cursor && entry.cursor.turnSeq) || 0;
    const messages = Array.isArray(selectedSession?.messages) ? selectedSession.messages : [];
    const message = [...messages].reverse().find(item => item && item.role === 'assistant'
      && Number(item.turnSummary && item.turnSummary.turnSeq) === turnSeq);
    if (!message) return null;
    const summary = narrativePlainText(reportConclusionExcerpt(message.content, 520)).slice(0, 520);
    const files = Array.isArray(message.turnSummary?.filesChanged) ? message.turnSummary.filesChanged.filter(item => item && item.path) : [];
    const artifacts = Array.isArray(message.turnSummary?.artifacts) ? message.turnSummary.artifacts.filter(item => item && item.path) : [];
    return { summary, files, artifacts };
  }

  function narrativeSentence(entry) {
    const detail = entry.detail || {};
    const cursor = entry.cursor || {};
    switch (entry.sentenceKey) {
      case 'mission_started': return t('previewShell.narrativeSentence.mission_started', { p1: detail.milestonesTotal || 0 });
      case 'progress_turn': return t('previewShell.narrativeSentence.progress_turn', { p1: narrativeEngine(cursor.engine), p2: cursor.turnSeq || 0, p3: detail.filesChanged || 0, p4: detail.artifacts || 0, p5: detail.commands || 0 });
      case 'progress_check': return t('previewShell.narrativeSentence.progress_check', { p1: detail.passed || 0, p2: detail.checks || 0 });
      case 'progress_ledger': return t('previewShell.narrativeSentence.progress_ledger', { p1: detail.milestonesDone || 0, p2: detail.milestonesTotal || 0 });
      case 'failure': return t('previewShell.narrativeSentence.failure', { p1: narrativeEngine(cursor.engine), p2: narrativeError(detail.errorClass) });
      case 'budget': return t('previewShell.narrativeSentence.budget', { p1: narrativeEngine(cursor.engine), p2: compactNumber((Number(detail.inTok) || 0) + (Number(detail.outTok) || 0)), p3: detail.cost == null ? t('previewShell.noCost') : `${detail.currency || ''} ${Number(detail.cost).toFixed(2)}`.trim() });
      case 'intervention_pending': return t('previewShell.narrativeSentence.intervention_pending', { p1: interventionTypeLabel(detail.interventionType) });
      case 'intervention_resolved': return t('previewShell.narrativeSentence.intervention_resolved', { p1: interventionTypeLabel(detail.interventionType), p2: narrativeStatus(detail.status) });
      case 'result': return t('previewShell.narrativeSentence.result', { p1: narrativeStatus(detail.status) });
      case 'rewind': return t('previewShell.narrativeSentence.rewind', { p1: detail.removedTurns || 0, p2: detail.filesReverted || 0 });
      case 'run_deleted': return t('previewShell.narrativeSentence.run_deleted', { p1: detail.runId || cursor.runId || t('previewShell.unknown') });
      // 第86波:未知句式不再硬塞「0/0」假数字,复用变更描述(按 type 折算的人话),输出始终可读。
      default: return changeDescription(entry);
    }
  }

  function buildNarrativeEntry(entry) {
    const item = text('details', `preview-narrative-entry tone-${entry.tone || 'progress'}`, '');
    item.dataset.changeSeq = String(entry.seq || '');
    item.dataset.changeType = String(entry.type || '');
    const summary = text('summary', 'preview-narrative-summary', '');
    const time = text('time', 'preview-narrative-time', narrativeTime(entry.occurredAt));
    if (entry.occurredAt) time.dateTime = entry.occurredAt;
    const rail = text('span', 'preview-narrative-rail', ''); rail.setAttribute('aria-hidden', 'true');
    const copy = text('span', 'preview-narrative-copy', '');
    copy.append(text('span', 'preview-narrative-actor', t(`previewShell.narrativeActor.${entry.actor}`)),
      text('strong', '', narrativeSentence(entry)));
    const turnContext = narrativeTurnContext(entry);
    if (turnContext && turnContext.summary) copy.appendChild(text('span', 'preview-narrative-outcome', t('previewShell.narrativeOutcome', { p1: turnContext.summary })));
    if (turnContext && (turnContext.files.length || turnContext.artifacts.length)) {
      const names = [...turnContext.files, ...turnContext.artifacts].map(item => basename(item.path)).filter(Boolean).slice(0, 4);
      copy.appendChild(text('span', 'preview-narrative-deliveries', t('previewShell.narrativeDeliveries', { p1: names.join('、'), p2: turnContext.files.length, p3: turnContext.artifacts.length })));
    }
    const seq = text('code', 'preview-narrative-seq', `#${entry.seq}`);
    summary.append(time, rail, copy, seq);
    const evidence = text('div', 'preview-narrative-evidence', '');
    const evidenceHead = text('div', 'preview-narrative-evidence-head', '');
    evidenceHead.append(text('strong', '', t('previewShell.narrativeEvidence')),
      text('span', '', t('previewShell.narrativeEvidenceHint')));
    const facts = text('dl', 'preview-narrative-facts', '');
    for (const [label, value] of [
      [t('previewShell.narrativeFactType'), entry.type],
      [t('previewShell.narrativeFactTime'), entry.occurredAt || '—'],
      [t('previewShell.narrativeFactCursor'), JSON.stringify(entry.cursor || {})],
      [t('previewShell.narrativeFactDetail'), JSON.stringify(entry.detail || {})],
    ]) facts.append(text('dt', '', label), text('dd', '', value));
    evidence.append(evidenceHead, facts); item.append(summary, evidence);
    return item;
  }

  function renderNarrativeLens(article) {
    const host = article?.querySelector('[data-slot="narrativeLens"]');
    if (!host) return;
    const sessionId = selectedSessionId();
    const feed = narrativeFeed(sessionId);
    const locale = getLocale();
    let list = host.querySelector('.preview-narrative-list');
    if (narrativeRenderedSession !== sessionId || narrativeRenderedLocale !== locale || !list) {
      const head = text('header', 'preview-narrative-head', '');
      const heading = text('div', 'preview-narrative-heading', '');
      heading.append(text('span', 'preview-eyebrow', t('previewShell.narrativeEyebrow')),
        text('h2', '', t('previewShell.narrativeTitle')));
      const goal = text('p', 'preview-narrative-goal', ''); goal.dataset.slot = 'narrativeGoal';
      const meta = text('div', 'preview-narrative-meta', ''); meta.dataset.slot = 'narrativeMeta';
      heading.append(goal, meta);
      const count = text('strong', 'preview-narrative-count', '00'); count.dataset.slot = 'narrativeCount';
      head.append(heading, count);
      const warning = text('p', 'preview-narrative-warning', t('previewShell.narrativeDegraded'));
      warning.dataset.slot = 'narrativeWarning'; warning.setAttribute('role', 'alert');
      const earlier = actionButton('', 'preview-narrative-earlier', () => {
        feed.windowStart = Math.max(0, Number(feed.windowStart) - 160);
        narrativeRenderedSession = '';
        renderNarrativeLens(article);
        requestAnimationFrame(() => article.querySelector('.preview-narrative-earlier')?.focus());
      });
      earlier.dataset.slot = 'narrativeEarlier';
      list = text('div', 'preview-narrative-list', ''); list.setAttribute('role', 'feed');
      const empty = text('p', 'preview-narrative-empty', t('previewShell.narrativeEmpty')); empty.dataset.slot = 'narrativeEmpty';
      host.replaceChildren(head, warning, earlier, list, empty);
      narrativeRenderedSession = sessionId;
      narrativeRenderedLocale = locale;
    }
    const acceptance = selectedSnapshot?.acceptance || {};
    const changes = selectedSnapshot?.changes || {};
    const goal = host.querySelector('[data-slot="narrativeGoal"]');
    if (goal) goal.textContent = selectedSnapshot?.mission?.goal || selectedSnapshot?.title || t('previewShell.goalFallback');
    const meta = host.querySelector('[data-slot="narrativeMeta"]');
    if (meta) {
      const files = Array.isArray(changes.filesChanged) ? changes.filesChanged.length : 0;
      const artifacts = Array.isArray(changes.artifacts) ? changes.artifacts.length : 0;
      meta.replaceChildren(
        text('span', '', t('previewShell.narrativeAcceptance', { p1: Number(acceptance.done) || 0, p2: Number(acceptance.total) || 0 })),
        text('span', '', t('previewShell.narrativeChanges', { p1: files })),
        text('span', '', t('previewShell.narrativeArtifacts', { p1: artifacts })),
      );
    }
    const visibleEntries = feed.entries.slice(Math.max(0, Number(feed.windowStart) || 0));
    const visibleSeqs = new Set(visibleEntries.map(entry => String(entry.seq)));
    for (const row of list.querySelectorAll('[data-change-seq]')) if (!visibleSeqs.has(String(row.dataset.changeSeq || ''))) row.remove();
    const existing = new Set(Array.from(list.querySelectorAll('[data-change-seq]')).map(node => String(node.dataset.changeSeq || '')));
    const fragment = document.createDocumentFragment();
    for (const entry of visibleEntries) if (!existing.has(String(entry.seq))) fragment.appendChild(buildNarrativeEntry(entry));
    if (fragment.childNodes.length) list.appendChild(fragment);
    const count = host.querySelector('[data-slot="narrativeCount"]');
    if (count) count.textContent = String(feed.entries.length).padStart(2, '0');
    const warning = host.querySelector('[data-slot="narrativeWarning"]');
    if (warning) warning.hidden = !feed.degraded;
    const earlier = host.querySelector('[data-slot="narrativeEarlier"]');
    if (earlier) {
      const hiddenCount = Math.max(0, Number(feed.windowStart) || 0);
      earlier.hidden = hiddenCount === 0;
      earlier.textContent = t('previewShell.narrativeEarlier', { p1: Math.min(160, hiddenCount), p2: hiddenCount });
    }
    const empty = host.querySelector('[data-slot="narrativeEmpty"]');
    if (empty) empty.hidden = feed.entries.length > 0;
  }

  function renderLensSwitch(article, snapshot) {
    const host = article?.querySelector('[data-slot="lensSwitch"]');
    if (!host) return;
    const hasCrew = hasCrewActivity(snapshot);
    if (!['scene', 'raw'].includes(selectedLens)) selectedLens = 'scene';
    const tabs = [
      { id: 'scene', label: t('previewShell.lensScene'), target: 'sceneLens', disabled: !narrativeRules && !hasCrew, icon: 'narrative' },
      { id: 'raw', label: t('previewShell.lensRaw'), target: 'rawLens', disabled: false, icon: 'raw' },
    ];
    host.replaceChildren();
    for (const tab of tabs) {
      const button = actionButton(tab.label, `preview-lens-tab lens-${tab.id}`, () => {
        selectedLens = tab.id;
        renderLensSwitch(article, snapshot);
        if (tab.id === 'raw') {
          renderRawMessages(); replayActiveTurn();
          // 切入原始镜头时强制连会话重取一次 —— 回合中途从别的镜头切过来也要看到最新现场。
          scheduleDetailRefresh(true);
        }
        requestAnimationFrame(() => article.querySelector(`[data-slot="${tab.target}"]`)?.focus?.({ preventScroll: true }));
      }, tab.icon);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', selectedLens === tab.id ? 'true' : 'false');
      button.setAttribute('aria-controls', `preview-${tab.target}`);
      button.disabled = tab.disabled;
      host.appendChild(button);
    }
    for (const tab of tabs) {
      const panel = article.querySelector(`[data-slot="${tab.target}"]`);
      if (!panel) continue;
      panel.hidden = selectedLens !== tab.id;
      panel.tabIndex = selectedLens === tab.id ? 0 : -1;
    }
    const crew = article.querySelector('[data-slot="crewLens"]');
    if (crew) crew.hidden = !hasCrew;
  }

  function renderMissionControl(article, snapshot) {
    const host = article?.querySelector('[data-slot="missionControl"]');
    if (!host) return;
    const controls = snapshot.controls || { actions: {} };
    const actions = controls.actions || {};
    const mission = snapshot.mission || {};
    // 第96波(Layout 精简):控制台从「独立大标题区块」收敛为一行紧凑工具栏 ——
    // 驾驶组 + 任务组按钮居左,遥测 chips 居右;确认轨与忙/错提示仍在下方原位置。
    const telemetry = text('div', 'preview-control-telemetry', '');
    telemetry.append(
      text('span', mission.autoMode === 'until-done' ? 'is-live' : '', t(`previewShell.autoMode.${mission.autoMode || 'off'}`)),
      text('span', controls.activeTurn ? 'is-live' : '', controls.activeTurn ? t('previewShell.turnLive') : t('previewShell.turnQuiet')),
      text('span', controls.liveRuns ? 'is-live' : '', t('previewShell.liveRuns', { p1: controls.liveRuns || 0 })),
    );

    const board = text('div', 'preview-control-board', '');
    const driver = text('section', 'preview-control-group is-driver', '');
    driver.append(text('span', 'preview-control-group-label', t('previewShell.controlDriver')),
      controlButton(t('previewShell.controlPause'), '', actions.pause, () => { void performMissionControl('pause'); }, 'pause'),
      controlButton(t('previewShell.controlContinue'), 'primary', actions.continue, () => { void performMissionControl('continue'); }, 'resume'),
      controlButton(t('previewShell.controlTakeover'), '', actions.takeover, () => { void performMissionControl('takeover'); }, 'takeover'));
    const missionGroup = text('section', 'preview-control-group is-mission', '');
    missionGroup.append(text('span', 'preview-control-group-label', t('previewShell.controlMission')),
      controlButton(t('previewShell.controlStop'), 'danger-ghost', actions.stop, () => { controlDraft = { kind: 'mission', action: 'stop' }; renderTaskSheet(selectedCard()); }, 'stop'),
      controlButton(t('previewShell.controlRetry'), '', actions.retry, () => { controlDraft = { kind: 'mission', action: 'retry' }; renderTaskSheet(selectedCard()); }, 'refresh'));
    board.append(driver, missionGroup, telemetry);

    host.replaceChildren(board);
    if (controlDraft?.kind === 'mission' && ['stop', 'retry'].includes(controlDraft.action)) {
      const action = controlDraft.action;
      host.appendChild(confirmationRail(t(`previewShell.controlConfirm.${action}`), t(`previewShell.controlConfirmAction.${action}`),
        () => { void performMissionControl(action); }, () => { controlDraft = null; renderTaskSheet(selectedCard()); }));
    }
    if (controlBusy) {
      const busy = text('p', 'preview-control-state is-busy', t('previewShell.controlWorking'));
      busy.setAttribute('role', 'status'); host.appendChild(busy);
    } else if (controlError) {
      const error = text('p', 'preview-control-state is-error', controlError);
      error.setAttribute('role', 'alert'); host.appendChild(error);
    }
  }

  function ledgerOpLabel(value) {
    const op = ['create', 'modify', 'delete'].includes(String(value || '')) ? String(value) : 'change';
    return t(`previewShell.ledgerOp.${op}`);
  }

  function ledgerRecoveryLabel(value) {
    return t(`previewShell.recoverability.${['full', 'partial', 'none'].includes(value) ? value : 'none'}`);
  }

  function renderLedger(article, snapshot) {
    const host = article?.querySelector('[data-slot="ledger"]');
    if (!host) return;
    const ledgerWasOpen = host.querySelector('.preview-ledger-details')?.open === true;
    const irreversibleWasOpen = host.querySelector('.preview-ledger-irreversible')?.open === true;
    const ledger = snapshot.ledger || { entries: [], nonRevertibleFiles: [], irreversible: {} };
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    const controls = snapshot.controls || {};
    const rollbackCapability = controls.actions?.rollback || { enabled: false, reason: 'no_checkpoints', scope: 'mission' };
    const head = text('header', 'preview-ledger-tape-head', '');
    const heading = text('div', '', '');
    heading.append(text('span', 'preview-eyebrow', t('previewShell.ledgerEyebrow')),
      text('h2', '', t('previewShell.ledgerTitle')));
    const stamp = text('div', `preview-recovery-stamp is-${ledger.recoverability || 'none'}`, '');
    stamp.append(text('small', '', t('previewShell.recoveryLabel')), text('strong', '', ledgerRecoveryLabel(ledger.recoverability)),
      text('span', '', t('previewShell.recoveryCount', { p1: ledger.reversibleEntries || 0, p2: ledger.nonRevertibleEntries || 0 })));
    const whole = controlButton(t('previewShell.rollbackMission'), 'danger-ghost preview-ledger-whole-rollback', rollbackCapability, () => {
      controlDraft = { kind: 'mission', action: 'rollback' }; renderTaskSheet(selectedCard());
    });
    const actions = text('div', 'preview-ledger-head-actions', ''); actions.append(stamp, whole);
    head.append(heading, actions); host.replaceChildren(head);

    if (controlDraft?.kind === 'mission' && controlDraft.action === 'rollback') {
      host.appendChild(confirmationRail(t('previewShell.controlConfirm.rollback'), t('previewShell.controlConfirmAction.rollback'),
        () => { void performMissionControl('rollback'); }, () => { controlDraft = null; renderTaskSheet(selectedCard()); }));
    }

    const tape = text('div', 'preview-ledger-tape', '');
    if (ledger.truncated) tape.appendChild(text('p', 'preview-ledger-truncated', t('previewShell.ledgerTruncated', { p1: ledger.totalEntries || entries.length })));
    const byTurn = new Map();
    for (const entry of entries) {
      const seq = Number(entry && entry.turnSeq) || 0;
      if (!byTurn.has(seq)) byTurn.set(seq, []);
      byTurn.get(seq).push(entry);
    }
    for (const [turnSeq, rows] of [...byTurn.entries()].sort((a, b) => b[0] - a[0])) {
      const group = text('section', 'preview-ledger-turn', ''); group.dataset.turnSeq = String(turnSeq);
      const groupHead = text('div', 'preview-ledger-turn-head', '');
      groupHead.append(text('strong', '', t('previewShell.ledgerTurn', { p1: turnSeq })),
        text('span', '', t('previewShell.ledgerTurnCount', { p1: rows.length })));
      group.appendChild(groupHead);
      for (const entry of rows.slice().sort((a, b) => Number(b.entrySeq) - Number(a.entrySeq))) {
        const row = text('div', `preview-ledger-row${entry.revertible ? '' : ' is-irreversible'}`, '');
        row.dataset.ledgerEntry = `${entry.turnSeq}:${entry.entrySeq}`;
        const marker = text('span', 'preview-ledger-marker', String(entry.entrySeq || '').padStart(2, '0'));
        const copy = text('div', 'preview-ledger-copy', '');
        const title = text('div', 'preview-ledger-row-title', '');
        title.append(text('span', `preview-ledger-op op-${entry.op || 'change'}`, ledgerOpLabel(entry.op)),
          text('strong', '', basename(entry.path) || t('previewShell.unknown')),
          text('span', `preview-ledger-revertible is-${entry.revertible ? 'yes' : 'no'}`,
            entry.revertible ? t('previewShell.revertible') : t('previewShell.notRevertible')));
        const meta = text('div', 'preview-ledger-meta', '');
        const pathNode = text('code', '', entry.path || ''); pathNode.title = entry.path || '';
        meta.append(pathNode, text('span', '', [entry.tool || t('previewShell.unknown'), narrativeTime(entry.ts)].join(' · ')));
        copy.append(title, meta);
        const canRollback = entry.revertible && !controls.activeTurn && !(controls.liveRuns > 0);
        const rollback = actionButton(t('previewShell.rollbackEntry'), 'ghost preview-ledger-row-action', () => {
          controlDraft = { kind: 'entry', action: 'rollback', entry }; renderTaskSheet(selectedCard());
        });
        rollback.disabled = Boolean(controlBusy) || !canRollback;
        if (!canRollback) rollback.title = controlReason(!entry.revertible ? 'unavailable' : (controls.activeTurn ? 'turn_active' : 'run_active'));
        row.append(marker, copy, rollback); group.appendChild(row);
        if (controlDraft?.kind === 'entry' && Number(controlDraft.entry?.turnSeq) === Number(entry.turnSeq)
          && Number(controlDraft.entry?.entrySeq) === Number(entry.entrySeq)) {
          group.appendChild(confirmationRail(t('previewShell.entryRollbackConfirm', { p1: basename(entry.path) || entry.path }), t('previewShell.rollbackEntry'),
            () => { void performCheckpointRollback(entry); }, () => { controlDraft = null; renderTaskSheet(selectedCard()); }));
        }
      }
      tape.appendChild(group);
    }
    if (!entries.length) tape.appendChild(text('p', 'preview-ledger-empty', t('previewShell.ledgerEmpty')));

    const nonFiles = Array.isArray(ledger.nonRevertibleFiles) ? ledger.nonRevertibleFiles : [];
    const irreversible = Array.isArray(ledger.irreversible?.items) ? ledger.irreversible.items : [];
    const legacyCommands = Number(ledger.irreversible?.legacyCommands) || 0;
    const irreversibleCount = nonFiles.length + irreversible.length + legacyCommands;
    if (nonFiles.length || irreversible.length || Number(ledger.irreversible?.legacyCommands) > 0) {
      const section = document.createElement('details'); section.className = 'preview-ledger-irreversible';
      section.open = irreversibleWasOpen;
      const summary = text('summary', 'preview-ledger-irreversible-summary', '');
      summary.append(text('span', 'preview-eyebrow', t('previewShell.irreversibleEyebrow')),
        text('strong', '', t('previewShell.irreversibleTitle')),
        text('span', 'preview-ledger-irreversible-count', t('previewShell.irreversibleCount', { p1: irreversibleCount })));
      const body = text('div', 'preview-ledger-irreversible-body', '');
      body.appendChild(text('p', '', t('previewShell.irreversibleBody')));
      const list = text('ul', '', '');
      for (const file of nonFiles) list.appendChild(text('li', '', t('previewShell.irreversibleFile', { p1: file.path || t('previewShell.unknown'), p2: ledgerOpLabel(file.op) })));
      for (const item of irreversible) list.appendChild(text('li', '', t('previewShell.irreversibleCommand', { p1: item.name || item.kind || t('previewShell.unknown'), p2: item.turnSeq || 0 })));
      if (legacyCommands > 0) list.appendChild(text('li', '', t('previewShell.irreversibleLegacy', { p1: legacyCommands })));
      body.appendChild(list); section.append(summary, body); tape.appendChild(section);
    }
    const details = document.createElement('details'); details.className = 'preview-ledger-details';
    details.open = ledgerWasOpen || Boolean(controlDraft);
    details.append(text('summary', 'preview-ledger-details-summary', t('previewShell.ledgerDetailsSummary', {
      p1: entries.length,
      p2: irreversibleCount,
    })), tape);
    host.appendChild(details);
  }

  function ensureTaskSheet(card) {
    const main = byId('previewMain');
    const sessionId = String(card.sessionId || '');
    let article = main?.querySelector('.preview-task-sheet');
    if (article && article.dataset.sessionId === sessionId) return article;
    if (!main) return null;

    article = text('article', 'preview-task-sheet', '');
    article.dataset.sessionId = sessionId;
    const head = text('header', 'preview-task-head', '');
    const kicker = text('div', 'preview-eyebrow-row', '');
    const statePill = text('span', 'preview-state-pill', '');
    statePill.dataset.slot = 'state';
    // 第90波(误标修复):任务单头部 eyebrow 原误用 rawLens(原始镜头),实为任务单主头 -> 专属键。
    kicker.append(text('span', 'preview-eyebrow', t('previewShell.taskEyebrow')));
    const heading = text('h1', 'preview-mission-title', ''); heading.dataset.slot = 'title';
    const goal = text('p', 'preview-mission-goal', ''); goal.dataset.slot = 'goal';
    // 第86波:现场速报 —— 一句话回答「现在谁在干什么/在等什么」,常驻头部,随每次快照刷新。
    const activity = text('p', 'preview-activity', '');
    activity.setAttribute('aria-label', t('previewShell.activityLabel'));
    const activityDot = text('span', 'preview-activity-dot', ''); activityDot.setAttribute('aria-hidden', 'true');
    const activityText = text('span', 'preview-activity-text', ''); activityText.dataset.slot = 'activity';
    activity.append(activityDot, activityText);
    // 第96波(Layout 精简):进度从「盒装账本区」改为一条细行 —— 细条 + 计数同行,不再占一个卡片位。
    const progress = document.createElement('details');
    progress.className = 'preview-task-progress preview-progress-details';
    progress.setAttribute('aria-label', t('previewShell.progressLabel'));
    const progressSummary = text('summary', 'preview-progress-summary', '');
    const bar = document.createElement('progress');
    bar.className = 'preview-progress'; bar.max = 1; bar.value = 0; bar.dataset.slot = 'progress';
    const progressText = text('span', 'preview-task-progress-text', '—'); progressText.dataset.slot = 'progressText';
    const progressHint = text('span', 'preview-progress-hint', t('previewShell.progressExpand'));
    const progressList = text('ol', 'preview-progress-list', ''); progressList.dataset.slot = 'progressItems';
    progressSummary.append(bar, progressText, progressHint);
    progress.append(progressSummary, progressList);
    const metrics = text('div', 'preview-task-metrics', '');
    metrics.append(makeMetric('turns', t('previewShell.turns')), makeMetric('tokens', t('previewShell.tokens')),
      makeMetric('cost', t('previewShell.cost')), makeMetric('runs', t('previewShell.runs')));
    const identity = text('div', 'preview-task-identity', '');
    identity.append(kicker, heading, goal);
    const nowPanel = text('aside', 'preview-task-now', '');
    nowPanel.setAttribute('aria-label', t('previewShell.activityLabel'));
    nowPanel.append(statePill, activity);
    const overview = text('div', 'preview-task-overview', '');
    overview.append(identity, nowPanel);
    const progressRow = text('div', 'preview-task-progress-row', '');
    progressRow.append(progress, metrics);
    head.append(overview, progressRow);

    const missionControl = text('section', 'preview-mission-control', '');
    missionControl.dataset.slot = 'missionControl';
    missionControl.setAttribute('aria-label', t('previewShell.controlTitle'));

    const returnSummary = text('section', 'preview-return-summary', '');
    returnSummary.dataset.slot = 'returnSummary'; returnSummary.hidden = true;
    returnSummary.setAttribute('aria-label', t('previewShell.returnTitle'));

    const stopCard = text('section', 'preview-stop-card', '');
    stopCard.dataset.slot = 'stopCard'; stopCard.hidden = true;
    stopCard.setAttribute('aria-label', t('previewShell.stopCardTitle'));

    const finishCard = text('section', 'preview-finish-card', '');
    finishCard.dataset.slot = 'finishCard'; finishCard.hidden = true;
    finishCard.setAttribute('aria-label', t('previewShell.finishTitle'));

    const lensSwitch = text('nav', 'preview-lens-switch', '');
    lensSwitch.dataset.slot = 'lensSwitch'; lensSwitch.setAttribute('role', 'tablist');
    lensSwitch.setAttribute('aria-label', t('previewShell.lensLabel'));

    const sceneLens = text('section', 'preview-scene-lens', '');
    sceneLens.id = 'preview-sceneLens'; sceneLens.dataset.slot = 'sceneLens';
    sceneLens.setAttribute('role', 'tabpanel'); sceneLens.setAttribute('aria-label', t('previewShell.lensScene'));
    const narrativeLens = text('section', 'preview-narrative-lens', '');
    narrativeLens.id = 'preview-narrativeLens'; narrativeLens.dataset.slot = 'narrativeLens';
    narrativeLens.setAttribute('aria-label', t('previewShell.narrativeTitle'));

    const crewLens = text('section', 'preview-crew-lens', '');
    crewLens.id = 'preview-crewLens';
    crewLens.dataset.slot = 'crewLens'; crewLens.hidden = true;
    crewLens.setAttribute('aria-label', t('previewShell.crewTitle'));
    sceneLens.append(narrativeLens, crewLens);

    const body = text('div', 'preview-task-body', '');
    body.id = 'preview-rawLens'; body.dataset.slot = 'rawLens'; body.setAttribute('role', 'tabpanel');
    const worksite = text('section', 'preview-worksite', '');
    worksite.setAttribute('aria-label', t('previewShell.worksite'));
    const worksiteHead = text('div', 'preview-worksite-head', '');
    const worksiteTitle = text('div', '', '');
    worksiteTitle.append(text('h2', '', t('previewShell.worksite')));
    const cursor = text('span', 'preview-cursor', ''); cursor.dataset.slot = 'cursor';
    worksiteHead.append(worksiteTitle, cursor);
    const raw = text('div', 'messages preview-raw-messages', '');
    raw.id = 'previewRawMessages'; raw.tabIndex = 0; raw.setAttribute('role', 'log'); raw.setAttribute('aria-live', 'off');
    raw.setAttribute('aria-label', t('previewShell.rawMessagesLabel')); raw.dataset.renderer = 'chat-static-renderer';
    worksite.append(worksiteHead, raw);
    const intake = text('aside', 'preview-intake', '');
    intake.setAttribute('aria-label', t('previewShell.intakeDesk'));
    intake.appendChild(text('h2', 'preview-intake-title', t('previewShell.intakeDesk')));
    const panels = text('div', 'preview-intake-panels', ''); panels.dataset.slot = 'intake';
    intake.appendChild(panels);
    body.append(worksite);

    const ledger = text('section', 'preview-ledger-section', '');
    ledger.id = 'previewMissionLedger'; ledger.dataset.slot = 'ledger';
    ledger.setAttribute('aria-label', t('previewShell.ledgerTitle'));

    const processDetails = document.createElement('details');
    processDetails.className = 'preview-process-details'; processDetails.dataset.slot = 'processDetails';
    processDetails.open = true;
    const processSummary = text('summary', 'preview-process-summary', '');
    const processLabel = text('span', 'preview-process-summary-label', t('previewShell.processDetails'));
    const processActions = text('span', 'preview-process-actions', '');
    const processAction = (label, className, handler, iconName) => actionButton(label, className, event => {
      event.preventDefault(); event.stopPropagation(); handler();
    }, iconName);
    processActions.append(
      processAction(t('previewShell.openMissionClassic'), 'ghost', () => { void openSelectedInClassic(); }, 'open'),
      processAction(t('previewShell.refresh'), '', () => { void refreshPreviewShell({ forceDetail: true }); }, 'refresh'),
    );
    processSummary.append(processLabel, processActions);
    body.appendChild(ledger);
    processDetails.append(processSummary, lensSwitch, sceneLens, body);
    // 底部续办工作区：把“追加指令”与普通页面导航分组，状态、用途和快捷键一眼可见。
    const continueTurn = text('section', 'preview-continue-turn', '');
    continueTurn.setAttribute('aria-label', t('previewShell.continueTurnAria'));
    const continueHead = text('div', 'preview-continue-turn-head', '');
    const continueMark = text('span', 'preview-continue-turn-mark', '');
    continueMark.setAttribute('aria-hidden', 'true'); continueMark.appendChild(icon('resume', 17));
    const continueCopy = text('div', 'preview-continue-turn-copy', '');
    continueCopy.append(text('span', 'preview-eyebrow', t('previewShell.continueTurnEyebrow')),
      text('h2', '', t('previewShell.continueTurnTitle')),
      text('p', '', t('previewShell.continueTurnDescription')));
    const continueState = text('span', 'preview-continue-turn-state', ''); continueState.dataset.slot = 'continueState';
    continueHead.append(continueMark, continueCopy, continueState);
    const continueField = text('div', 'preview-continue-turn-field', '');
    const continueInput = document.createElement('textarea');
    continueInput.id = 'previewContinueInput'; continueInput.rows = 2;
    continueInput.className = 'preview-continue-turn-input';
    continueInput.value = continueDraft;
    continueInput.placeholder = t('previewShell.continueTurnPlaceholder');
    continueInput.setAttribute('aria-label', t('previewShell.continueTurnInputAria'));
    const autosizeContinue = () => { continueInput.style.height = 'auto'; continueInput.style.height = Math.min(continueInput.scrollHeight, 160) + 'px'; };
    continueInput.oninput = () => { continueDraft = continueInput.value; autosizeContinue(); };
    continueInput.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); const button = continueTurn.querySelector('.preview-continue-turn-submit'); if (button && !button.disabled) button.click(); }
    };
    const continueSubmit = actionButton(t('previewShell.continueTurnAction'), 'primary preview-continue-turn-submit', async () => {
      const value = String(continueDraft || '').trim();
      if (!value) { continueInput.focus(); return; }
      continueDraft = value;
      await performMissionControl('next_turn', value);
      // 发送成功后清空输入并重渲染,让输入框同步回空值:performMissionControl 在回合结束后
      // 已 renderMain 过一次,但那一刻草稿仍是旧值;这里清空后必须再渲染一次,否则 DOM 残留旧文字。
      // 失败保留草稿方便重试(controlError 显示在控制面板)。
      if (!controlError) { continueDraft = ''; renderMain(); }
    }, 'resume');
    continueSubmit.disabled = Boolean(controlBusy);
    continueField.append(continueInput, continueSubmit);
    const continueHint = text('div', 'preview-continue-turn-hint', '');
    continueHint.append(text('kbd', '', t('previewShell.continueTurnShortcut')),
      text('span', '', t('previewShell.continueTurnHint')));
    continueHint.lastChild.dataset.slot = 'continueHint';
    continueTurn.append(continueHead, continueField, continueHint);
    const statusSection = text('section', 'preview-task-status', '');
    statusSection.dataset.section = 'status'; statusSection.append(head, missionControl);
    const outcomeSection = text('section', 'preview-task-outcome', '');
    outcomeSection.dataset.section = 'outcome'; outcomeSection.append(returnSummary, stopCard, finishCard, intake, continueTurn);
    article.append(statusSection, outcomeSection, processDetails);
    main.replaceChildren(article);
    return article;
  }

  function setSlot(article, name, value) {
    const node = article?.querySelector(`[data-slot="${name}"]`);
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  // 现场速报派生:只看权威快照 —— 待决 > 班组当前工序 > 活回合 > 五态兜底,不猜 assistant 文本。
  function activityBrief(snapshot, derived) {
    const pending = pendingTotal(snapshot && snapshot.pending);
    if (pending > 0) return t('previewShell.activity.needsYou', { p1: pending });
    const runs = Array.isArray(snapshot && snapshot.runs) ? snapshot.runs : [];
    const nodes = runs.flatMap(run => (Array.isArray(run && run.nodes) ? run.nodes : []).filter(node => node && node.id));
    const current = nodes.find(node => node.status === 'running')
      || nodes.find(node => ['queued', 'waiting', 'waiting_resource'].includes(node.status));
    if (current) {
      const focus = current.progress || current.task || '';
      return focus
        ? t('previewShell.activity.crew', { p1: crewRole(current, nodes.indexOf(current)), p2: focus })
        : t('previewShell.activity.crewIdle', { p1: crewRole(current, nodes.indexOf(current)) });
    }
    if (snapshot && snapshot.controls && snapshot.controls.activeTurn) {
      const action = liveActivity && liveActivity.action ? liveActivity.action : t('previewShell.activity.workingAction');
      const startedAt = liveActivity && liveActivity.startedAt ? liveActivity.startedAt : activeTurnStartedAt(snapshot);
      const elapsed = elapsedLabel(startedAt, now());
      return elapsed ? t('previewShell.activity.liveAction', { p1: action, p2: elapsed }) : action;
    }
    if (derived.state === 'dispatching') return t('previewShell.activity.dispatching');
    if (derived.state === 'done') return t('previewShell.activity.done');
    if (derived.state === 'stopped') return t('previewShell.activity.stopped');
    return t('previewShell.activity.quiet');
  }

  function toolActivityLabel(name) {
    const raw = String(name || '').trim();
    const lower = raw.toLowerCase();
    if (/search|find|query|browse|web/.test(lower)) return t('previewShell.activity.actionResearch');
    if (/read|list|get|inspect|view|status/.test(lower)) return t('previewShell.activity.actionInspect');
    if (/write|edit|patch|create|save|update/.test(lower)) return t('previewShell.activity.actionEdit');
    if (/exec|command|shell|bash|powershell|terminal|test/.test(lower)) return t('previewShell.activity.actionRun');
    return raw ? t('previewShell.activity.actionTool', { p1: raw.replace(/[_-]+/g, ' ') }) : t('previewShell.activity.workingAction');
  }

  function activeTurnStartedAt(snapshot) {
    const turnSeq = Math.max(0, Number(snapshot && snapshot.cursor && snapshot.cursor.turnSeq) || 0);
    const messages = Array.isArray(selectedSession && selectedSession.messages) ? selectedSession.messages : [];
    const current = [...messages].reverse().find(message => message && message.role === 'user'
      && (!turnSeq || Number(message.turnSeq) === turnSeq));
    return current && current.createdAt || snapshot && snapshot.mission && snapshot.mission.updatedAt || '';
  }

  function ensureActivityClock(active) {
    if (!active) {
      if (activityClockTimer) clearInterval(activityClockTimer);
      activityClockTimer = 0;
      return;
    }
    if (activityClockTimer) return;
    activityClockTimer = setInterval(() => {
      const article = byId('previewMain')?.querySelector('.preview-task-sheet');
      const card = selectedCard();
      if (!article || !selectedSnapshot || !card || !isPreviewMode()) return;
      renderTaskHeader(article, card, selectedSnapshot);
    }, 1000);
  }

  function renderProgressItems(article, snapshot) {
    const host = article.querySelector('[data-slot="progressItems"]');
    if (!host) return;
    const items = acceptanceItems(snapshot);
    const activeIndex = activeAcceptanceIndex(items);
    if (!items.length) {
      host.replaceChildren(text('li', 'preview-progress-empty', t('previewShell.progressEmpty')));
      return;
    }
    host.replaceChildren(...items.map((item, index) => {
      const row = text('li', `preview-progress-item is-${item.status}${index === activeIndex ? ' is-current' : ''}`, '');
      row.dataset.progressId = item.id;
      const marker = text('span', 'preview-progress-marker', item.status === 'done' ? '✓' : item.status === 'blocked' ? '!' : String(index + 1));
      const copy = text('span', 'preview-progress-copy', '');
      copy.append(text('strong', '', item.desc || t('previewShell.progressUnnamed', { p1: index + 1 })),
        text('small', '', item.evidence
          ? t('previewShell.progressEvidence', { p1: item.evidence })
          : t(`previewShell.progressStatus.${item.status}`)));
      row.append(marker, copy);
      return row;
    }));
  }

  function renderTaskHeader(article, card, snapshot) {
    const derived = missionState.fromSnapshot(snapshot);
    const progress = progressOf(card, snapshot);
    setSlot(article, 'title', titleOf(card));
    setSlot(article, 'goal', snapshot.mission?.goal || card.mission?.goal || t('previewShell.goalFallback'));
    article.dataset.missionState = derived.state;
    const pill = setSlot(article, 'state', stateLabel(derived.state));
    if (pill) { pill.className = `preview-state-pill state-${derived.state}`; pill.dataset.missionState = derived.state; }
    setSlot(article, 'activity', activityBrief(snapshot, derived));
    // 第88波(待决可达):现场速报在「需要你」时变成可点击入口,直开 needs 抽屉,不再只是不可交互的文字。
    const activity = article.querySelector('.preview-activity');
    if (activity) {
      activity.dataset.state = derived.state;
      const pending = pendingTotal(snapshot && snapshot.pending);
      activity.classList.toggle('is-actionable', pending > 0);
      if (pending > 0) {
        activity.setAttribute('role', 'button');
        activity.tabIndex = 0;
        activity.onclick = () => setNeedsDrawer(true);
        activity.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setNeedsDrawer(true); } };
      } else {
        activity.removeAttribute('role');
        activity.tabIndex = -1;
        activity.onclick = null;
        activity.onkeydown = null;
      }
    }
    setSlot(article, 'progressText', t('previewShell.progressValue', { p1: progress.done, p2: progress.total }));
    renderProgressItems(article, snapshot);
    const bar = article.querySelector('[data-slot="progress"]');
    if (bar) {
      bar.max = Math.max(1, progress.total); bar.value = progress.done;
      bar.setAttribute('aria-label', t('previewShell.progressAria', { p1: progress.percent }));
    }
    const usage = snapshot.usage || {};
    setSlot(article, 'turns', compactNumber(usage.turns));
    setSlot(article, 'tokens', compactNumber((Number(usage.inTok) || 0) + (Number(usage.outTok) || 0)));
    setSlot(article, 'cost', usageCost(usage));
    setSlot(article, 'runs', compactNumber(Array.isArray(snapshot.runs) ? snapshot.runs.length : 0));
    const turnSeq = Math.max(0, Number(snapshot.cursor?.turnSeq) || 0);
    setSlot(article, 'cursor', t('previewShell.cursor', { p1: turnSeq }));
    ensureActivityClock(Boolean(snapshot.controls?.activeTurn));
    // 第95波:继续推进条状态同步 —— 依任务状态切换占位文案与可用性。
    const continueTurn = article.querySelector('.preview-continue-turn');
    if (continueTurn) {
      const input = continueTurn.querySelector('.preview-continue-turn-input');
      const submit = continueTurn.querySelector('.preview-continue-turn-submit');
      const hint = continueTurn.querySelector('[data-slot="continueHint"]');
      const stateBadge = continueTurn.querySelector('[data-slot="continueState"]');
      const nextTurn = (snapshot.controls?.actions || {}).next_turn || { enabled: false, reason: 'unavailable' };
      const active = Boolean(snapshot.controls?.activeTurn) || (Number(snapshot.controls?.liveRuns) || 0) > 0;
      continueTurn.dataset.state = derived.state;
      if (input) {
        input.placeholder = derived.state === 'done'
          ? t('previewShell.continueTurnPlaceholderDone')
          : derived.state === 'stopped'
            ? t('previewShell.continueTurnPlaceholderStopped')
            : t('previewShell.continueTurnPlaceholder');
      }
      if (submit) {
        // 第97波:推进按钮只在忙碌/活回合时禁用;next_turn 不可用(如里程碑上限/预算耗尽)时仍可点,
        // 由服务端权威校验并拒绝,错误经 controlError 明确反馈 —— 不再「按不动」无响应。
        submit.disabled = Boolean(controlBusy) || active;
        if (!nextTurn.enabled && !active) submit.title = controlReason(nextTurn.reason);
        else submit.title = '';
      }
      if (hint) {
        hint.textContent = active
          ? t('previewShell.continueTurnActiveHint')
          : (nextTurn.enabled ? t('previewShell.continueTurnHint') : controlReason(nextTurn.reason));
      }
      if (stateBadge) {
        stateBadge.textContent = active
          ? t('previewShell.continueTurnState.active')
          : (nextTurn.enabled
            ? t(derived.state === 'stopped' ? 'previewShell.continueTurnState.restart' : 'previewShell.continueTurnState.ready')
            : t('previewShell.continueTurnState.unavailable'));
        stateBadge.dataset.tone = active ? 'active' : (nextTurn.enabled ? 'ready' : 'quiet');
      }
    }
  }

  function renderStopCard(article, card, snapshot) {
    const host = article?.querySelector('[data-slot="stopCard"]');
    if (!host) return;
    const result = snapshot && snapshot.result;
    if (!result || result.status !== 'stopped') {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    host.hidden = false;
    const unfinished = Array.isArray(result.unfinished) ? result.unfinished.filter(Boolean) : [];
    const copy = text('div', 'preview-stop-copy', '');
    copy.append(text('span', 'preview-eyebrow', t('previewShell.stopCardEyebrow')),
      text('h2', '', t('previewShell.stopCardTitle')),
      text('p', '', snapshot.mission?.budgetExhaustedAt
        ? t('previewShell.stopCardBudgetReason', { p1: unfinished.length })
        : result.how === 'stop'
          ? t('previewShell.stopCardUserReason', { p1: unfinished.length })
          : ['supervised', 'manual', 'fixture'].includes(String(result.how || ''))
            ? t('previewShell.stopCardSupervisedReason', { p1: unfinished.length })
            : t('previewShell.stopCardReason', { p1: unfinished.length })));
    if (unfinished.length) {
      const list = text('ul', 'preview-stop-unfinished', '');
      for (const item of unfinished.slice(0, 3)) list.appendChild(text('li', '', item.desc || item.id || t('previewShell.unknown')));
      // 第88波:超过 3 项时补一条计数尾巴,让用户知道完整未完成范围,而非被静默截断。
      if (unfinished.length > 3) list.appendChild(text('li', 'preview-stop-more', t('previewShell.unfinishedMore', { p1: unfinished.length - 3 })));
      copy.appendChild(list);
    }
    const actions = text('div', 'preview-stop-actions', '');
    actions.append(
      actionButton(t('previewShell.stopRetry'), 'primary', () => {
        controlDraft = { kind: 'mission', action: 'retry' };
        renderTaskSheet(card);
        requestAnimationFrame(() => article?.querySelector('[data-slot="missionControl"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }),
      actionButton(t('previewShell.stopChangeApproach'), '', () => {
        void openSelectedInClassic(t('previewShell.stopChangeDraft', { p1: snapshot.mission?.goal || titleOf(card) }));
      }),
      actionButton(t('previewShell.stopGiveUp'), 'ghost', () => {
        updateMissionUi(card.missionId, { archived: true });
        openDispatchHome();
      }),
    );
    host.replaceChildren(copy, actions);
  }

  function renderFinishCard(article, card, snapshot) {
    const host = article?.querySelector('[data-slot="finishCard"]');
    if (!host) return;
    const missionId = String(card?.missionId || '');
    const reportWasOpen = host.dataset.finishMissionId === missionId
      && host.querySelector('.preview-finish-report')?.open === true;
    const artifactsWereOpen = host.dataset.finishMissionId === missionId
      && host.querySelector('.preview-finish-artifacts')?.open === true;
    const historyWasOpen = host.dataset.finishMissionId === missionId
      && host.querySelector('.preview-finish-history')?.open === true;
    const result = snapshot && snapshot.result;
    if (!result || result.status !== 'complete') {
      host.hidden = true;
      delete host.dataset.finishMissionId;
      host.replaceChildren();
      return;
    }
    host.hidden = false;
    host.dataset.finishMissionId = missionId;
    const acceptance = result.acceptance || {};
    const changes = result.changes || {};
    const usage = snapshot.usage || result.usage || {};
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter(item => item && item.path) : [];
    const unfinished = Array.isArray(result.unfinished) ? result.unfinished.filter(Boolean) : [];
    const files = Array.isArray(snapshot.changes?.filesChanged) ? snapshot.changes.filesChanged.filter(item => item && item.path) : [];
    const reportKind = files.length ? 'engineering' : (artifacts.length ? 'artifact' : 'text');

    // 优先 result.deliverableText(随 result 持久化+下发,不依赖 SSE 流到达时序;刷新也不丢当前输出)。
    let reportSource = String(result.deliverableText || '').trim();
    if (!reportSource) {
      const messages = Array.isArray(selectedSession?.messages) ? selectedSession.messages : [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message && message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
          reportSource = message.content;
          break;
        }
      }
    }
    if (!reportSource) reportSource = snapshot.summary;
    const reportText = reportDeliveryText(reportSource);

    const heading = text('header', 'preview-finish-head', '');
    const copy = text('div', 'preview-finish-copy', '');
    copy.append(text('span', 'preview-eyebrow', t('previewShell.finishEyebrow')),
      text('h2', '', t('previewShell.finishTitle')),
      text('p', '', t('previewShell.finishBody', { p1: Number(acceptance.done) || 0, p2: Number(acceptance.total) || 0 })));
    const stamp = text('div', 'preview-finish-stamp', '');
    stamp.append(text('span', '', t('previewShell.finishStamped')), text('strong', '', formatTaskTime(result.finishedAt)));
    heading.append(copy, stamp);

    const report = document.createElement('details');
    report.className = 'preview-finish-report';
    report.dataset.reportKind = reportKind;
    report.open = reportWasOpen;
    const reportHead = text('summary', 'preview-finish-report-head', '');
    const reportPreview = reportPreviewText(reportSource);
    reportHead.append(text('strong', '', t(`previewShell.finishReportTitle.${reportKind}`)),
      text('span', 'preview-finish-report-preview', reportPreview || t('previewShell.finishReportEmpty')),
      text('span', 'preview-finish-report-kind', t(`previewShell.finishReportKind.${reportKind}`)));
    report.appendChild(reportHead);
    if (reportText) {
      const reportCopy = text('div', 'preview-finish-report-copy md', '');
      const hydrateReport = () => {
        if (!report.open || reportCopy.dataset.markdownReady === 'true') return;
        renderMarkdownInto(reportCopy, reportText);
        highlightIn(reportCopy);
        reportCopy.dataset.markdownReady = 'true';
      };
      report.appendChild(reportCopy);
      report.addEventListener('toggle', hydrateReport);
      hydrateReport();
    } else report.appendChild(text('p', 'preview-finish-report-empty', t('previewShell.finishReportEmpty')));
    if (files.length) {
      const fileSection = text('section', 'preview-finish-files', '');
      fileSection.appendChild(text('h4', '', t('previewShell.finishReportFiles')));
      const list = text('ul', '', '');
      for (const file of files.slice(0, 8)) {
        const row = text('li', '', ''); row.title = String(file.path);
        row.append(text('strong', '', basename(file.path) || file.path), text('span', '', ledgerOpLabel(file.op)));
        list.appendChild(row);
      }
      if (files.length > 8) list.appendChild(text('li', 'preview-finish-more', t('previewShell.finishReportFilesMore', { p1: files.length - 8 })));
      fileSection.appendChild(list); report.appendChild(fileSection);
    }

    const facts = text('div', 'preview-finish-facts', '');
    const fact = (key, label, value, detail) => {
      const node = text('section', 'preview-finish-fact', ''); node.dataset.finishFact = key;
      node.append(text('span', '', label), text('strong', '', value), text('small', '', detail));
      return node;
    };
    const totalTokens = (Number(usage.inTok) || 0) + (Number(usage.outTok) || 0) || Number(result.usage?.tokens) || 0;
    const factNodes = [
      fact('acceptance', t('previewShell.finishAcceptance'), `${Number(acceptance.done) || 0}/${Number(acceptance.total) || 0}`, t('previewShell.finishAcceptanceHint')),
      fact('delivery', t('previewShell.finishDelivery'), t(`previewShell.finishReportKind.${reportKind}`), t('previewShell.finishDeliveryHint')),
    ];
    if (files.length) factNodes.push(fact('changes', t('previewShell.finishChanges'), compactNumber(files.length), t('previewShell.finishChangesHint', { p1: Number(changes.commands) || 0 })));
    if (artifacts.length) factNodes.push(fact('artifacts', t('previewShell.finishArtifacts'), compactNumber(artifacts.length), t('previewShell.finishArtifactsHint')));
    if (unfinished.length) factNodes.push(fact('unfinished', t('previewShell.finishUnfinished'), compactNumber(unfinished.length), t('previewShell.finishUnfinishedOpen')));
    factNodes.push(fact('usage', t('previewShell.finishUsage'), `${compactNumber(totalTokens)} ${t('previewShell.tokens')}`, usageCost(usage)));
    facts.append(...factNodes);

    // 第88波:未完成项给出明细(最多5条+计数),不再只给一个数字;收工但有未完成项是最该核对「还差哪几件」的场景。
    const unfinishedSection = (() => {
      if (!unfinished.length) return null;
      const section = text('section', 'preview-finish-unfinished', '');
      section.appendChild(text('h3', '', t('previewShell.finishUnfinishedList')));
      const list = text('ul', '', '');
      for (const item of unfinished.slice(0, 5)) list.appendChild(text('li', '', item.desc || item.id || t('previewShell.unknown')));
      if (unfinished.length > 5) list.appendChild(text('li', 'preview-finish-more', t('previewShell.unfinishedMore', { p1: unfinished.length - 5 })));
      section.appendChild(list);
      return section;
    })();

    const artifactSection = (() => {
      if (!artifacts.length) return null;
      const section = document.createElement('details');
      section.className = 'preview-finish-artifacts';
      section.open = artifactsWereOpen;
      const summary = text('summary', 'preview-finish-artifacts-head', '');
      summary.append(text('strong', '', t('previewShell.finishArtifactList')),
        text('span', 'preview-finish-artifacts-count', t('previewShell.finishArtifactCount', { p1: artifacts.length })),
        text('span', 'preview-finish-artifacts-hint', t('previewShell.finishArtifactExpand')));
      section.appendChild(summary);
      const list = text('ul', '', '');
      const status = text('p', 'preview-finish-artifact-status', '');
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const reveal = async (path, mode) => {
        status.classList.remove('is-error'); status.textContent = '';
        try {
          const response = await api('/api/file/reveal', {
            method: 'POST', body: JSON.stringify({ sessionId: card.sessionId, path, mode }),
          });
          if (!response || response.ok !== true) throw response || new Error(t('file.open.unavailable'));
          if (response.degradedTo && response.note) status.textContent = response.note;
        } catch (error) {
          status.classList.add('is-error');
          status.textContent = t('file.open.failed', { reason: apiErrText(error) || t('file.open.unavailable') });
        }
      };
      for (const item of artifacts.slice(0, 8)) {
        const path = String(item.path);
        const row = text('li', 'preview-finish-artifact-row', ''); row.title = path;
        const identity = text('div', 'preview-finish-artifact-identity', '');
        const fileMark = text('span', 'preview-finish-artifact-icon', ''); fileMark.setAttribute('aria-hidden', 'true'); fileMark.appendChild(icon('sheet', 15));
        const fileCopy = text('span', 'preview-finish-artifact-copy', '');
        fileCopy.append(text('strong', '', basename(path) || path), text('code', '', path));
        identity.append(fileMark, fileCopy);
        const rowActions = text('span', 'preview-finish-artifact-actions', '');
        const open = actionButton(t('file.open'), '', () => { void reveal(path, 'open'); }, 'open');
        const locate = actionButton(t('previewShell.finishArtifactLocate'), '', () => { void reveal(path, 'select'); }, 'folder');
        open.title = t('file.open'); locate.title = t('file.reveal');
        rowActions.append(open, locate);
        row.append(identity, rowActions);
        list.appendChild(row);
      }
      // 第88波:产物超 8 条补计数尾巴,不再静默截断交接清单。
      if (artifacts.length > 8) list.appendChild(text('li', 'preview-finish-more', t('previewShell.finishArtifactsMore', { p1: artifacts.length - 8 })));
      section.append(list, status);
      return section;
    })();

    const actions = text('div', 'preview-finish-actions', '');
    const playbook = actionButton(t('previewShell.finishSavePlaybook'), 'primary', event => {
      void saveMissionAsPlaybook(card.sessionId, event.currentTarget);
    });
    playbook.title = t('previewShell.finishSavePlaybookHint');
    const memory = actionButton(t('previewShell.finishSaveMemory'), '', event => {
      void saveMissionAsMemory(card.sessionId, event.currentTarget);
    });
    memory.title = t('previewShell.finishSaveMemoryHint');
    const archive = actionButton(t('previewShell.finishArchive'), 'ghost', () => {
      updateMissionUi(card.missionId, { archived: true }); openDispatchHome();
    });
    actions.append(playbook, memory, archive);

    // 历史轮次验收报告:next_turn/retry/rollback/再武装前归档的旧 result,可展开回看(不丢旧轮次)。
    // 历史轮全文在任务台内的阅读层打开，避免桌面 WebView 把 about:blank 当作外链交给系统。
    // 归档保留完整 deliverableText，阅读层继续用纯 DOM + renderMarkdownInto 安全渲染。
    const openHistoryFullText = (item) => {
      const full = String(item && item.deliverableText || '').trim();
      if (!full) return;
      document.querySelector('.preview-history-report-backdrop')?.remove();
      const previousFocus = document.activeElement;
      const backdrop = text('div', 'modal-backdrop preview-history-report-backdrop', '');
      const modal = text('section', 'modal preview-history-report-modal', '');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const titleId = `previewHistoryReportTitle-${Date.now()}`;
      modal.setAttribute('aria-labelledby', titleId);
      const head = text('header', 'modal-head preview-history-report-head', '');
      const title = text('h3', '', t('previewShell.finishHistoryTitle'));
      title.id = titleId;
      const closeReport = () => {
        backdrop.remove();
        if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) previousFocus.focus();
      };
      const close = actionButton('', 'icon-btn preview-history-report-close', closeReport, 'close');
      close.title = t('common.close');
      close.setAttribute('aria-label', close.title);
      head.append(title, close);
      const body = text('div', 'modal-body preview-history-report-body', '');
      const reportHost = text('article', 'preview-history-report-copy preview-finish-report-copy md', '');
      // 第97波对抗复审(F1):直接渲染归档的完整 deliverableText 原文 —— 不经 reportDeliveryText 二次
      // 裁剪(那个会把首个标题前的导语/叙述丢掉),「打开全文」必须是全文。
      renderMarkdownInto(reportHost, full);
      highlightIn(reportHost);
      body.appendChild(reportHost);
      modal.append(head, body);
      backdrop.appendChild(modal);
      backdrop.onclick = event => { if (event.target === backdrop) closeReport(); };
      backdrop.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closeReport(); } };
      document.body.appendChild(backdrop);
      close.focus();
    };

    const historySection = (() => {
      const history = Array.isArray(snapshot.resultHistory) ? snapshot.resultHistory : [];
      if (!history.length) return null;
      const section = document.createElement('details');
      section.className = 'preview-finish-history';
      section.open = historyWasOpen;
      const summary = text('summary', 'preview-finish-history-head', '');
      summary.append(text('strong', '', t('previewShell.finishHistoryTitle')),
        text('span', 'preview-finish-history-count', t('previewShell.finishHistoryCount', { p1: history.length })));
      section.appendChild(summary);
      const list = text('ol', 'preview-finish-history-list', '');
      for (const item of history) {
        if (!item) continue;
        const status = String(item.status || '');
        const row = text('li', 'preview-finish-history-row', ''); row.dataset.historyStatus = status;
        const head = text('div', 'preview-finish-history-row-head', '');
        const label = status === 'complete' ? t('previewShell.resultComplete')
          : (status === 'stopped' ? t('previewShell.resultStopped') : t('previewShell.resultPending'));
        const acc = item.acceptance || {};
        head.append(text('span', 'preview-finish-history-status', label),
          text('span', 'preview-finish-history-meta', t('previewShell.finishHistoryMeta', { p1: Number(acc.done) || 0, p2: Number(acc.total) || 0 })),
          text('time', 'preview-finish-history-time', formatTaskTime(item.finishedAt)));
        row.append(head);
        const excerpt = reportPreviewText(String(item.deliverableText || ''), 200);
        if (excerpt) row.append(text('p', 'preview-finish-history-excerpt', excerpt));
        // 第97波对抗复审(F9):deliverableText 为空的轮次(8a03cff 之前的旧归档)不渲染「打开全文」按钮,
        // 避免出现点了没反应的死按钮。
        if (String(item && item.deliverableText || '').trim()) {
          const fullButton = actionButton(t('previewShell.finishHistoryOpenFull'), 'preview-finish-history-open', () => openHistoryFullText(item), 'open');
          fullButton.title = t('previewShell.finishHistoryOpenFullHint');
          fullButton.type = 'button';
          row.append(fullButton);
        }
        list.appendChild(row);
      }
      section.append(list);
      return section;
    })();

    host.replaceChildren(...[heading, report, facts, unfinishedSection, artifactSection, historySection, actions].filter(Boolean));
  }

  function changeDescription(record) {
    const detail = record && record.detail || {};
    switch (record && record.type) {
      case 'mission_started': return t('previewShell.change.mission_started', { p1: detail.milestonesTotal || 0 });
      case 'progress': return t('previewShell.change.progress', { p1: detail.filesChanged || 0, p2: detail.artifacts || 0 });
      case 'failure': return t('previewShell.change.failure', { p1: detail.errorClass || t('previewShell.unknown') });
      case 'budget': return t('previewShell.change.budget', { p1: compactNumber((Number(detail.inTok) || 0) + (Number(detail.outTok) || 0)), p2: detail.cost == null ? t('previewShell.noCost') : `${detail.currency || ''} ${Number(detail.cost).toFixed(2)}`.trim() });
      case 'intervention_pending': return t('previewShell.change.intervention_pending', { p1: detail.interventionType || t('previewShell.unknown') });
      case 'intervention_resolved': return t('previewShell.change.intervention_resolved', { p1: detail.status || t('previewShell.unknown') });
      case 'result': return t('previewShell.change.result', { p1: detail.status || t('previewShell.unknown') });
      case 'rewind': return t('previewShell.change.rewind', { p1: detail.removedTurns || 0, p2: detail.filesReverted || 0 });
      case 'run_deleted': return t('previewShell.change.run_deleted', { p1: detail.runId || record.cursor?.runId || t('previewShell.unknown') });
      default: return t('previewShell.change.progress', { p1: 0, p2: 0 });
    }
  }

  function renderReturnSummary(article) {
    const host = article?.querySelector('[data-slot="returnSummary"]');
    if (!host) return;
    if (!selectedChanges) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    const changes = Array.isArray(selectedChanges.changes) ? selectedChanges.changes : [];
    const state = missionState.fromSnapshot(selectedSnapshot).state;
    if (state === 'done' || (!changes.length && selectedChanges.degraded !== true)) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    host.hidden = false;
    host.classList.toggle('is-degraded', selectedChanges.degraded === true);
    const head = text('div', 'preview-return-head', '');
    const heading = text('div', '', '');
    heading.append(text('span', 'preview-eyebrow', t('previewShell.returnEyebrow')),
      text('h2', '', t('previewShell.returnTitle')),
      text('p', '', changes.length ? t('previewShell.returnBody', { p1: selectedChanges.fromRevision, p2: selectedChanges.currentRevision }) : t('previewShell.returnCaughtUp')));
    head.append(heading, text('strong', 'preview-return-count', String(changes.length).padStart(2, '0')));
    const body = text('div', 'preview-return-body', '');
    if (selectedChanges.degraded) {
      const warning = text('p', 'preview-return-warning', t('previewShell.returnDegraded'));
      warning.setAttribute('role', 'alert'); body.appendChild(warning);
    }
    if (changes.length) {
      const list = text('ol', 'preview-return-list', '');
      for (const record of changes) {
        const item = text('li', 'preview-return-row', ''); item.dataset.changeSeq = String(record.seq || '');
        const marker = text('span', `preview-return-marker change-${record.type || 'progress'}`, String(record.seq || '').padStart(2, '0'));
        const copy = text('span', 'preview-return-copy', '');
        copy.append(text('strong', '', t(`previewShell.changeType.${record.type}`)), text('span', '', changeDescription(record)));
        const cursor = text('code', 'preview-return-cursor', JSON.stringify(record.cursor || {}));
        cursor.title = t('previewShell.returnCursor');
        item.append(marker, copy, cursor); list.appendChild(item);
      }
      body.appendChild(list);
    }
    host.replaceChildren(head, body);
  }

  function readonlyPanel(kind, titleValue, value, bodyValue) {
    const panel = text('section', `preview-intake-panel preview-intake-${kind}`, '');
    panel.dataset.kind = kind;
    panel.append(text('span', 'preview-intake-label', titleValue), text('strong', 'preview-intake-value', value),
      text('p', 'preview-intake-copy', bodyValue));
    return panel;
  }

  function renderIntakeDesk(article, snapshot) {
    const host = article.querySelector('[data-slot="intake"]');
    if (!host) return;
    const pending = pendingTotal(snapshot.pending);
    const changes = snapshot.changes || {};
    const artifacts = Array.isArray(changes.artifacts) ? changes.artifacts.length : 0;
    const files = Array.isArray(changes.filesChanged) ? changes.filesChanged.length : 0;
    const commands = Array.isArray(changes.commands) ? changes.commands.length : Math.max(0, Number(changes.commands) || 0);
    const checkpoints = Math.max(0, Number(snapshot.checkpoints?.entries) || 0);
    const irreversible = Math.max(0, Number(snapshot.irreversible?.total) || 0);
    const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
    const liveRuns = runs.filter(run => run && run.live).length;
    const maxRunCursor = runs.reduce((max, run) => Math.max(max, Number(run && run.eventSeq) || 0), 0);
    const needs = readonlyPanel('needs', t('previewShell.needsPanel'), String(pending),
      pending ? t('previewShell.needsPanelBodyGlobal', { p1: pending }) : t('previewShell.needsPanelEmpty'));
    needs.classList.toggle('has-attention', pending > 0);
    if (pending > 0) {
      needs.classList.add('is-actionable'); needs.tabIndex = 0; needs.setAttribute('role', 'button');
      needs.onclick = () => setNeedsDrawer(true);
      needs.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setNeedsDrawer(true); } };
    }
    const result = readonlyPanel('results', t('previewShell.resultsPanel'), resultLabel(snapshot),
      t('previewShell.resultsPanelBody', { p1: artifacts, p2: files }));
    // 第86波:成果不再是抽象计数 —— 直接列出产物文件名(悬停看全路径),「输出了什么」一眼可见。
    const artifactItems = (Array.isArray(changes.artifacts) ? changes.artifacts : []).filter(item => item && item.path).slice(0, 4);
    if (artifactItems.length) {
      const artifactList = text('ul', 'preview-intake-artifacts', '');
      for (const item of artifactItems) {
        const row = text('li', '', basename(item.path));
        row.title = String(item.path);
        artifactList.appendChild(row);
      }
      result.appendChild(artifactList);
    }
    const ledger = readonlyPanel('ledger', t('previewShell.ledgerPanel'), t('previewShell.ledgerValue', { p1: checkpoints }),
      t('previewShell.ledgerPanelBody', { p1: commands, p2: irreversible, p3: runs.length, p4: liveRuns, p5: maxRunCursor }));
    ledger.classList.add('is-actionable'); ledger.tabIndex = 0; ledger.setAttribute('role', 'button');
    const openLedger = () => article.querySelector('#previewMissionLedger')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    ledger.onclick = openLedger;
    ledger.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLedger(); } };
    host.replaceChildren(needs, result, ledger);
  }

  function previewWindowStartFor(messages) {
    const countStart = messages.length <= MSG_WINDOW_THRESHOLD ? 0 : Math.max(0, messages.length - MSG_WINDOW_TAIL);
    const weightedStart = weightedMessageTailStart(messages, { maxMessages: MSG_WINDOW_TAIL });
    const tailStart = Math.max(countStart, weightedStart);
    if (rawWindowStart == null) return tailStart;
    return Math.max(0, Math.min(rawWindowStart, tailStart));
  }

  function captureRawFocus(host) {
    const active = document.activeElement;
    if (!host || !active || (active !== host && !host.contains(active))) return null;
    if (active === host) return { host: true };
    const row = active.closest('[data-message-key]');
    if (!row) return null;
    const focusables = Array.from(row.querySelectorAll('button,[href],input,select,textarea,[tabindex]'));
    return { key: row.dataset.messageKey || '', index: Math.max(0, focusables.indexOf(active)) };
  }

  function restoreRawFocus(host, focus) {
    if (!host || !focus) return;
    if (focus.host) { host.focus({ preventScroll: true }); return; }
    const row = Array.from(host.querySelectorAll('[data-message-key]')).find(node => node.dataset.messageKey === focus.key);
    const target = row && row.querySelectorAll('button,[href],input,select,textarea,[tabindex]')[focus.index];
    target?.focus({ preventScroll: true });
  }

  function buildRawLoadEarlier(start) {
    const wrap = text('div', 'load-earlier-wrap preview-load-earlier', '');
    const step = Math.min(MSG_WINDOW_STEP, start);
    const more = actionButton(t('previewShell.loadEarlier', { p1: step, p2: start }), 'load-earlier', () => {
      rawWindowStart = Math.max(0, start - MSG_WINDOW_STEP);
      renderRawMessages({ force: true, scrollTop: true });
    });
    const all = actionButton(t('previewShell.expandAll'), 'load-earlier load-all', () => {
      rawWindowStart = 0;
      renderRawMessages({ force: true, scrollTop: true });
    });
    wrap.append(more, all);
    return wrap;
  }

  function renderRawMessages({ force = false, scrollTop = false } = {}) {
    const host = byId('previewRawMessages');
    const session = selectedSession;
    if (!host) return;
    if (!session || !Array.isArray(session.messages)) {
      host.replaceChildren(text('p', 'preview-raw-empty', t('previewShell.loadingMessages')));
      return;
    }
    const locale = getLocale();
    if (!force && renderedSession === session && renderedLocale === locale) {
      ensurePreviewLiveRow();
      return;
    }
    const anchor = captureScrollAnchor(host);
    const focus = captureRawFocus(host);
    const messages = session.messages;
    const start = previewWindowStartFor(messages);
    const existing = new Map(Array.from(host.querySelectorAll('[data-message-key]')).map(row => [row.dataset.messageKey, row]));
    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.appendChild(buildRawLoadEarlier(start));
    const entries = visibleSessionMessageEntries(messages, start, { activeTurnSeq: session.turnSeq, hasLiveTurn: Boolean(previewLive) });
    for (const { message, index } of entries) {
      const key = messageDomKey(message, index, session.id);
      const signature = messageRenderSignature(message, locale);
      let row = existing.get(key);
      if (!row || row.dataset.renderSignature !== signature) row = renderStaticMessage(message, key, signature, { readonly: true, idScope: 'preview' });
      if (row) fragment.appendChild(row);
    }
    if (!entries.length && start === 0) fragment.appendChild(text('p', 'preview-raw-empty', t('previewShell.noMessages')));
    if (previewLive && previewLive.sessionId === session.id && previewLive.row) fragment.appendChild(previewLive.row);
    host.setAttribute('aria-busy', 'true');
    host.replaceChildren(fragment);
    host.setAttribute('aria-busy', 'false');
    renderedSession = session;
    renderedLocale = locale;
    if (scrollTop) host.scrollTop = 0;
    else restoreScrollAnchor(host, anchor || { atBottom: true });
    restoreRawFocus(host, focus);
    // P2-4: 渲染后同步粘性状态到实际滚动位置（底部->粘性跟随；顶部/中部->不打扰）。
    const rawCtrl = getRawScrollController();
    if (rawCtrl) rawCtrl.syncStickToBottom();
  }

  function clearPreviewLive({ remove = true } = {}) {
    if (!previewLive) return;
    if (previewLive.rafId) cancelAnimationFrame(previewLive.rafId);
    if (remove) previewLive.row?.remove();
    previewLive = null;
  }

  function ensurePreviewLiveRow() {
    const sessionId = selectedSessionId();
    const host = byId('previewRawMessages');
    if (!host || !sessionId || !selectedSession || selectedSession.id !== sessionId) return null;
    if (previewLive && previewLive.sessionId === sessionId) {
      if (!previewLive.row.isConnected) host.appendChild(previewLive.row);
      return previewLive;
    }
    clearPreviewLive();
    const key = `${sessionId}:preview-live`;
    const row = renderStaticMessage({ role: 'assistant', content: '', createdAt: new Date().toISOString() }, key, 'preview-live', { readonly: true, idScope: 'preview' });
    if (!row) return null;
    row.dataset.previewLive = 'true';
    const bubble = row.querySelector('.bubble');
    if (!bubble) return null;
    bubble.classList.remove('md'); bubble.classList.add('plain', 'live-plain', 'stream-cursor');
    const node = document.createTextNode('');
    bubble.replaceChildren(node);
    previewLive = { sessionId, row, bubble, node, pending: [], rafId: 0 };
    host.appendChild(row);
    return previewLive;
  }

  // P2-4: 懒创建 raw 镜头滚动控制器并绑定 scroll 事件。host 一次性创建，但若被重建则重绑。
  function getRawScrollController() {
    const host = byId('previewRawMessages');
    if (!host) return null;
    if (rawScrollController && rawScrollBoundHost === host) return rawScrollController;
    // host 被全量重建后(任务单每 30s 刷新),旧控制器仍在 document 上挂着 wheel 监听器并闭包引用旧 host
    // → 分离 DOM + 监听器逐次泄漏。重建前先 dispose 旧实例(它会 removeEventListener + cancelAnimationFrame)。
    if (rawScrollController && typeof rawScrollController.dispose === 'function') rawScrollController.dispose();
    rawScrollController = createChatScrollController({
      getMessages: () => byId('previewRawMessages'),
      getJumpLatest: () => null,
      isStreaming: () => Boolean(previewLive),
    });
    host.addEventListener('scroll', rawScrollController.syncStickToBottom, { passive: true });
    rawScrollBoundHost = host;
    return rawScrollController;
  }

  function appendPreviewLiveText(value) {
    const live = ensurePreviewLiveRow();
    if (!live || !value) return;
    live.pending.push(String(value));
    if (live.rafId) return;
    live.rafId = requestAnimationFrame(() => {
      live.rafId = 0;
      if (!previewLive || previewLive !== live) return;
      const delta = live.pending.join(''); live.pending.length = 0;
      if (delta) live.node.appendData(delta);
      // P2-4: 仅在用户保持粘性（位于底部）时跟随；上滑阅读时不再强设 scrollTop 与滚轮对抗。
      const ctrl = getRawScrollController();
      if (ctrl) ctrl.maybeScrollToBottom();
    });
  }

  function replayActiveTurn() {
    if (previewLive || !isPreviewMode()) return;
    const sessionId = selectedSessionId();
    if (!sessionId) return;
    const parts = [];
    for (const line of getActiveTurnLines(sessionId) || []) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'assistant_delta' && event.text) parts.push(event.text);
    }
    if (parts.length) appendPreviewLiveText(parts.join(''));
  }

  function renderTaskSheet(card) {
    const main = byId('previewMain');
    if (!main || !selectedSnapshot) return;
    main.dataset.view = 'task-sheet';
    main.dataset.missionId = String(card.missionId || '');
    const article = ensureTaskSheet(card);
    if (!article) return;
    renderTaskHeader(article, card, selectedSnapshot);
    renderMissionControl(article, selectedSnapshot);
    // 第88波(IA):终态任务把控制面板(车钟)收起,让完成/停止卡成为视觉主角;若用户刚从停止卡点了重试(待确认)或动作执行中,则保留控制面板。
    const terminalState = missionState.fromSnapshot(selectedSnapshot);
    const mcHost = article.querySelector('[data-slot="missionControl"]');
    if (mcHost) mcHost.hidden = (terminalState.state === 'done' || terminalState.state === 'stopped') && !controlDraft && !controlBusy;
    const processDetails = article.querySelector('[data-slot="processDetails"]');
    if (processDetails) {
      const processMode = terminalState.state === 'running' ? 'active' : 'collapsed';
      if (processDetails.dataset.mode !== processMode) {
        processDetails.dataset.mode = processMode;
        processDetails.open = processMode === 'active';
      }
    }
    renderReturnSummary(article);
    renderStopCard(article, card, selectedSnapshot);
    renderFinishCard(article, card, selectedSnapshot);
    renderNarrativeLens(article);
    renderCrewLens(article, selectedSnapshot);
    renderIntakeDesk(article, selectedSnapshot);
    renderLedger(article, selectedSnapshot);
    if (selectedLens === 'raw') renderRawMessages();
    renderLensSwitch(article, selectedSnapshot);
    if (selectedLens === 'raw') replayActiveTurn();
  }

  function renderMain() {
    if (activeView === 'home') { renderHome(); return; }
    if (activeView === 'archive') { renderArchive(); return; }
    const card = selectedCard();
    if (!card) { activeView = 'home'; renderEmptyMain(); }
    else if (!selectedSnapshot) renderLoadingMain(card);
    else renderTaskSheet(card);
  }

  function renderError(error) {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'error';
    const card = text('section', 'preview-error-card', '');
    card.setAttribute('role', 'alert');
    const actions = text('div', 'preview-main-actions preview-error-actions', '');
    const retry = actionButton(t('previewShell.retry'), 'primary', () => { void refreshPreviewShell({ forceDetail: true }); });
    const classic = actionButton(t('previewShell.returnClassic'), '', () => applyShellMode('classic'));
    retry.id = 'previewErrorRetryBtn';
    classic.id = 'previewErrorClassicBtn';
    actions.append(retry, classic);
    card.append(text('h1', '', t('previewShell.loadFailed')), text('p', 'preview-main-copy', t('previewShell.loadFailedBody')),
      text('p', 'preview-error-detail', String(error && error.message || error || '')), actions);
    main.replaceChildren(card);
  }

  function renderPreviewShell({ preserveEditors = false } = {}) {
    renderFacts();
    renderDock();
    const main = byId('previewMain');
    if (!(preserveEditors && hasActiveEditor(main))) renderMain();
    renderNeedsDrawer({ preserveEditor: preserveEditors });
    byId('previewHomeBtn')?.setAttribute('aria-pressed', activeView === 'home' ? 'true' : 'false');
    byId('previewArchiveBtn')?.setAttribute('aria-pressed', activeView === 'archive' ? 'true' : 'false');
  }

  async function refreshSelectedMission({ forceSession = false, quiet = false } = {}) {
    const card = selectedCard();
    const sessionId = String(card && card.sessionId || '');
    if (!card || !sessionId) return null;
    const epoch = ++detailEpoch;
    try {
      const detail = await api(`/api/missions/${sessionId}`);
      let snapshot = detail && detail.snapshot;
      if (!snapshot || epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
      const snapshotRevision = Math.max(0, Number(snapshot.mission?.changeSeq) || 0);
      if (detailBaselineRevision == null) {
        previewUiState = readPreviewUiState();
        const storedRevision = Number(missionUi(card.missionId).lastSeenRevision);
        detailBaselineRevision = Number.isSafeInteger(storedRevision) && storedRevision >= 0 ? storedRevision : snapshotRevision;
      }
      const previousTurn = Number(selectedSnapshot?.cursor?.turnSeq);
      const nextTurn = Number(snapshot.cursor?.turnSeq);
      let session = selectedSession;
      // 原始镜头下回合中流事件已弄脏会话 → 随本次刷新重取,让工具卡/新消息即时上场。
      const needsSession = forceSession || !session || session.id !== sessionId || previousTurn !== nextTurn
        || (rawDirty && selectedLens === 'raw');
      const feed = narrativeFeed(sessionId);
      const returnChangesPromise = api(`/api/missions/${sessionId}/changes?after=${detailBaselineRevision}`);
      const narrativeChangesPromise = feed.cursor === detailBaselineRevision
        ? returnChangesPromise
        : api(`/api/missions/${sessionId}/changes?after=${feed.cursor}`);
      const [sessionResponse, changeResponse, narrativeResponse] = await Promise.all([
        needsSession ? api(`/api/sessions/${sessionId}`) : Promise.resolve(null),
        returnChangesPromise,
        narrativeChangesPromise,
      ]);
      if (epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
      if (sessionResponse) { session = sessionResponse.session; rawDirty = false; }
      // 返回摘要展示“自离开后的累计变更”窗口(fromRevision 固定=打开任务时的 lastSeenRevision)。
      // 不推进 detailBaselineRevision:推进后 selectedChanges 变增量,无新变更时 renderReturnSummary
      // 整段隐藏、有变更时 fromRevision 跳到新基线 -> 每 240ms 刷新在显/隐间闪烁(对抗审查发现回归)。
      // 本地工具载荷重传可忽略,正确性优先。`>` 补拉判定(下方)仍保留。
      // 仅在 changes 显示有更新的内容（currentRevision 领先快照）时才补拉完整快照；
      // 原 `!==` 判定在时序竞态下（changes 略旧于快照）也会触发一次无意义的二次全量请求。
      if (Number(changeResponse?.currentRevision) > snapshotRevision) {
        const refreshed = await api(`/api/missions/${sessionId}`);
        if (epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
        if (refreshed && refreshed.snapshot) snapshot = refreshed.snapshot;
      }
      selectedSnapshot = snapshot;
      selectedChanges = changeResponse;
      foldNarrativeResponse(sessionId, narrativeResponse);
      if (session) selectedSession = session;
      if (forceSession) clearPreviewLive();
      if (!(quiet && hasActiveEditor(byId('previewMain')))) renderTaskSheet(card);
      const rendered = byId('previewMain')?.querySelector('.preview-task-sheet');
      if (!changeResponse?.degraded && rendered && rendered.isConnected) {
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        if (epoch === detailEpoch && sessionId === selectedSessionId() && rendered.dataset.sessionId === sessionId && rendered.isConnected) {
          updateMissionUi(card.missionId, { lastSeenRevision: Math.max(0, Number(changeResponse.currentRevision) || 0) });
        }
      }
      return snapshot;
    } catch (error) {
      if (epoch === detailEpoch && (!quiet || !selectedSnapshot)) renderError(error);
      return null;
    }
  }

  function loadPlaybooksInBackground() {
    if (playbooksLoaded) return Promise.resolve(playbooks);
    if (playbooksPromise) return playbooksPromise;
    // Playbooks enrich the home screen but are not required to start or resume a mission. Keep their
    // provider/capability discovery off the first-interactive critical path, then refresh only the home view.
    playbooksPromise = api('/api/playbooks').catch(() => null).then(response => {
      playbooks = Array.isArray(response && response.playbooks) ? response.playbooks : [];
      playbooksLoaded = true;
      if (isPreviewMode() && activeView === 'home') renderHome();
      return playbooks;
    }).finally(() => { playbooksPromise = null; });
    return playbooksPromise;
  }

  async function refreshPreviewShell({ quiet = false, forceDetail = false } = {}) {
    if (!isPreviewMode()) return null;
    if (refreshPromise) {
      if (!forceDetail) return refreshPromise;
      return refreshPromise.then(() => refreshPreviewShell({ quiet, forceDetail: true }));
    }
    const epoch = ++refreshEpoch;
    const status = byId('previewShellStatus');
    if (status && !quiet) status.textContent = t('previewShell.loading');
    refreshPromise = (async () => {
      try {
        void loadPlaybooksInBackground();
        const [missionResponse, interventionResponse] = await Promise.all([
          api('/api/missions?limit=200'),
          api('/api/interventions?limit=100'),
        ]);
        if (epoch !== refreshEpoch) return null;
        cards = Array.isArray(missionResponse && missionResponse.missions) ? missionResponse.missions : [];
        inboxCounts = interventionResponse && interventionResponse.counts || { total: 0 };
        pendingInterventions = Array.isArray(interventionResponse && interventionResponse.pending) ? interventionResponse.pending : [];
        syncNeedsNotifications(pendingInterventions);
        const pendingIds = new Set(pendingInterventions.map(item => String(item && item.id || '')));
        for (const id of interventionDrafts.keys()) if (!pendingIds.has(id)) interventionDrafts.delete(id);
        const selectedExists = cards.some(card => card && card.missionId === selectedMissionId);
        if (activeView === 'mission' && !selectedExists) {
          activeView = 'home'; selectedMissionId = ''; resetSelectedDetail();
        } else if (activeView === 'home' && selectedMissionId && !selectedExists) {
          selectedMissionId = '';
        }
        renderPreviewShell({ preserveEditors: quiet });
        if (activeView === 'mission' && selectedMissionId) await refreshSelectedMission({ forceSession: forceDetail || !selectedSession, quiet });
        if (status) status.textContent = t('previewShell.updated');
        return { cards: cards.length, counts: inboxCounts };
      } catch (error) {
        if (epoch === refreshEpoch) {
          if (status) status.textContent = t('previewShell.updateFailed');
          if (!quiet || !cards.length) renderError(error);
        }
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function scheduleDetailRefresh(forceSession = false) {
    detailRefreshForce = detailRefreshForce || forceSession;
    if (detailRefreshTimer) return;
    detailRefreshTimer = setTimeout(() => {
      detailRefreshTimer = null;
      const force = detailRefreshForce;
      detailRefreshForce = false;
      if (isPreviewMode()) void refreshSelectedMission({ forceSession: force, quiet: true });
    }, detailRefreshForce ? 0 : 240);
  }

  function handlePreviewStreamEvent(envelope) {
    if (!envelope || !isPreviewMode() || String(envelope.sessionId || '') !== selectedSessionId()) return;
    if (envelope.type === 'start') {
      liveActivity = { action: t('previewShell.activity.workingAction'), startedAt: now().toISOString() };
      ensureActivityClock(true);
      if (selectedLens === 'raw') ensurePreviewLiveRow();
      return;
    }
    if (envelope.type === 'settled') {
      liveActivity = null;
      ensureActivityClock(false);
      if (previewLive?.rafId) cancelAnimationFrame(previewLive.rafId);
      if (previewLive?.pending.length) previewLive.node.appendData(previewLive.pending.join(''));
      if (previewLive) { previewLive.pending.length = 0; previewLive.rafId = 0; previewLive.bubble.classList.remove('stream-cursor'); }
      scheduleDetailRefresh(true);
      return;
    }
    if (envelope.type !== 'event' || !envelope.line) return;
    let event; try { event = JSON.parse(envelope.line); } catch { return; }
    if (event.type === 'assistant_delta') { if (selectedLens === 'raw') appendPreviewLiveText(event.text || ''); }
    else if (event.type === 'tool_use' && !event.subagentId) {
      liveActivity = { action: toolActivityLabel(event.name), startedAt: liveActivity?.startedAt || now().toISOString() };
      const article = byId('previewMain')?.querySelector('.preview-task-sheet');
      if (article && selectedSnapshot) renderTaskHeader(article, selectedCard(), selectedSnapshot);
    } else if (event.type === 'tool_result' && !event.subagentId) {
      if (liveActivity) liveActivity.action = t('previewShell.activity.workingAction');
      rawDirty = true;
      scheduleDetailRefresh(false);
    } else if (event.type === 'session' && event.session && event.session.id === selectedSessionId()) {
      selectedSession = event.session; renderedSession = null; if (selectedLens === 'raw') renderRawMessages();
    } else if (['mission', 'usage', 'agent_workflow'].includes(event.type)) {
      rawDirty = true; // 回合内产生了新事实;原始镜头下一次刷新连会话一起重取
      scheduleDetailRefresh(false);
    }
  }

  function refreshPreviewShellLabels() {
    syncModeControl(isPreviewMode() ? 'preview' : 'classic');
    renderedLocale = '';
    narrativeRenderedLocale = '';
    syncNotificationControls();
    renderPreviewShell();
  }

  function bindPreviewShell() {
    if (bound) return;
    bound = true;
    const selector = byId('cfgShellMode');
    if (selector) selector.onchange = event => {
      const mode = applyShellMode(event.target.value, { focus: false });
      closeSettings();
      requestAnimationFrame(() => (mode === 'preview' ? byId('previewMain') : byId('promptInput'))?.focus());
    };
    syncNotificationControls();
    const notificationToggle = byId('cfgPreviewNotifications');
    if (notificationToggle) notificationToggle.onchange = async event => {
      if (!event.target.checked) {
        saveNotificationSettings({ enabled: false });
        syncNeedsNotifications(pendingInterventions);
        closeAllNeedsNotifications();
        syncPolling();
        return;
      }
      let permission = notificationPermission();
      if (permission === 'default' && notificationApi && typeof notificationApi.requestPermission === 'function') {
        try { permission = await notificationApi.requestPermission(); } catch { permission = 'denied'; }
      }
      if (permission !== 'granted') {
        saveNotificationSettings({ enabled: false });
        return;
      }
      notificationCoordinator = notificationRules?.normalizeCoordinatorState() || { primed: false, known: [], active: [] };
      saveNotificationSettings({ enabled: true });
      syncPolling();
      await refreshNotificationInbox(); // first successful read only primes current items; no historical notification burst
    };
    for (const [id, key] of [['cfgPreviewQuietStart', 'quietStart'], ['cfgPreviewQuietEnd', 'quietEnd']]) {
      const input = byId(id);
      if (input) input.onchange = event => {
        saveNotificationSettings({ [key]: event.target.value });
        syncNeedsNotifications(pendingInterventions);
      };
    }
    const classic = byId('previewClassicBtn');
    if (classic) classic.onclick = () => applyShellMode('classic');
    const openPreview = byId('openPreviewBtn');
    if (openPreview) openPreview.onclick = () => applyShellMode('preview');
    const newMission = byId('previewNewMissionBtn');
    if (newMission) newMission.onclick = () => startNewDispatch();
    const home = byId('previewHomeBtn');
    if (home) home.onclick = () => openDispatchHome();
    const archive = byId('previewArchiveBtn');
    if (archive) archive.onclick = () => openArchive();
    const refresh = byId('previewRefreshBtn');
    if (refresh) refresh.onclick = () => { void refreshPreviewShell({ forceDetail: true }); };
    const settings = byId('previewSettingsBtn');
    if (settings) settings.onclick = () => openSettings('basic');
    const workspace = byId('previewWorkspaceFact');
    if (workspace) workspace.onclick = () => openWorkspaceControl(workspace);
    const safety = byId('previewSafetyFact');
    if (safety) safety.onclick = () => openSafetyControl(safety);
    const engine = byId('previewEngineFact');
    if (engine) engine.onclick = () => openEngineControl(engine);
    const needs = byId('previewNeedsFact');
    if (needs) needs.onclick = () => setNeedsDrawer(!needsDrawerOpen);
    const needsScrim = byId('previewNeedsScrim');
    if (needsScrim) needsScrim.onclick = () => setNeedsDrawer(false);
    const dock = byId('previewMissionDock');
    if (dock) dock.onclick = event => {
      const button = event.target.closest('.preview-seal');
      if (!button || !dock.contains(button)) return;
      const nextMissionId = button.dataset.missionId || '';
      openMissionCard(cards.find(card => card && card.missionId === nextMissionId));
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isPreviewMode()) void refreshPreviewShell({ quiet: true });
      else if (!document.hidden && notificationSettings.enabled) void refreshNotificationInbox();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      // 第88波:Esc 是肌肉记忆的「取消」--先关 needs 抽屉,再撤控制确认栏(动作执行中除外),再撤交办确认卡回输入框。
      if (needsDrawerOpen) { event.preventDefault(); setNeedsDrawer(false); return; }
      if (activeView === 'mission' && controlDraft && !controlBusy) {
        event.preventDefault(); controlDraft = null; renderMain(); return;
      }
      if (activeView === 'home' && dispatchDraft) {
        event.preventDefault(); dispatchDraft = null; dispatchError = ''; renderHome(); byId('previewDispatchInput')?.focus();
      }
    });
    applyShellMode(storedShellMode(), { persist: false, focus: false });
  }

  return Object.freeze({
    applyShellMode,
    bindPreviewShell,
    handlePreviewStreamEvent,
    isPreviewMode,
    refreshPreviewShell,
    refreshPreviewShellLabels,
    renderPreviewShell,
  });
}
