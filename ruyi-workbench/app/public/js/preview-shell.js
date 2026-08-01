'use strict';

// 第76–78波：默认关闭的新任务台壳层、原始任务单与交办台首页。领域事实只读自
// Mission/Intervention/Session API；五态只调用 mission-state.js，消息正文只调用经典 renderer；
// 交办写动作经组合根注入的单一 command，Preview 不复制 Session/Mission/stream 业务状态机。
import './mission-state.js';
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

export const SHELL_MODE_STORAGE_KEY = 'wcw.shellMode';
export const SHELL_MODES = Object.freeze(['classic', 'preview']);
export const PREVIEW_UI_STATE_STORAGE_KEY = 'wcw.previewUiState.v1';
export const PREVIEW_DOCK_INITIAL_RENDER = 40;

export function normalizePreviewUiState(value) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  const missions = {};
  const source = input && typeof input === 'object' && !Array.isArray(input) && input.missions && typeof input.missions === 'object'
    ? input.missions : {};
  for (const [missionId, raw] of Object.entries(source).slice(-1000)) {
    if (!missionId || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = { pinned: raw.pinned === true, archived: raw.archived === true };
    const revision = Number(raw.lastSeenRevision);
    if (Number.isSafeInteger(revision) && revision >= 0) item.lastSeenRevision = revision;
    if (typeof raw.updatedAt === 'string' && raw.updatedAt) item.updatedAt = raw.updatedAt.slice(0, 40);
    missions[String(missionId).slice(0, 180)] = item;
  }
  return { version: 1, missions };
}

export function readPreviewUiState(storage = globalThis.localStorage) {
  try { return normalizePreviewUiState(storage?.getItem(PREVIEW_UI_STATE_STORAGE_KEY)); }
  catch { return normalizePreviewUiState(null); }
}

export function writePreviewMissionUiState(missionId, patch, storage = globalThis.localStorage) {
  const id = String(missionId || '').slice(0, 180);
  if (!id) return normalizePreviewUiState(null);
  const state = readPreviewUiState(storage);
  const previous = state.missions[id] || { pinned: false, archived: false };
  const next = { ...previous };
  if (patch && typeof patch === 'object') {
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
    if (typeof patch.archived === 'boolean') next.archived = patch.archived;
    const revision = Number(patch.lastSeenRevision);
    if (Number.isSafeInteger(revision) && revision >= 0) next.lastSeenRevision = Math.max(Number(previous.lastSeenRevision) || 0, revision);
  }
  next.updatedAt = new Date().toISOString();
  state.missions[id] = next;
  try { storage?.setItem(PREVIEW_UI_STATE_STORAGE_KEY, JSON.stringify(state)); } catch { /* UI state is best-effort */ }
  return state;
}

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
  dispatchCommand = async () => ({}),
  openSession = async () => {},
  setClassicDraft = () => {},
  syncClassicIntervention = async () => {},
  apiErrText = error => String(error && error.message || error || ''),
  pickWorkspace = async () => {},
  playbookName = playbook => String(playbook && playbook.title || ''),
  playbookDescription = playbook => String(playbook && playbook.desc || ''),
  playbookUnavailableReason = () => '',
  renderStaticMessage = () => null,
  getActiveTurnLines = () => [],
} = {}) {
  const missionState = globalThis.MissionState;
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
  let inboxCounts = { total: 0 };
  let pendingInterventions = [];
  let selectedMissionId = '';
  let activeView = 'home';
  let selectedSnapshot = null;
  let selectedSession = null;
  let selectedChanges = null;
  let detailBaselineRevision = null;
  let rawWindowStart = null;
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
  let playbooks = [];
  let playbooksLoaded = false;
  let dispatchText = '';
  let dispatchDraft = null;
  let dispatchBusy = false;
  let dispatchError = '';
  let archiveQuery = '';
  let archiveFilter = 'all';
  let archiveGroup = 'workspace';
  let previewUiState = readPreviewUiState();
  let renderedDockSignature = '';
  let dockRenderEpoch = 0;
  let needsDrawerOpen = false;
  const interventionDrafts = new Map();

  const byId = id => document.getElementById(id);
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

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!document.hidden && isPreviewMode()) void refreshPreviewShell({ quiet: true });
    }, 10000);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function applyShellMode(value, { persist = true, focus = true } = {}) {
    const mode = normalizeShellMode(value);
    document.documentElement.setAttribute('data-shell-mode', mode);
    syncModeControl(mode);
    if (persist) setStoredShellMode(mode);
    if (mode === 'preview') {
      startPolling();
      void refreshPreviewShell();
      if (focus) requestAnimationFrame(() => byId('previewMain')?.focus());
    } else {
      stopPolling();
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
    if (snapshot && snapshot.acceptance) {
      const total = Math.max(0, Number(snapshot.acceptance.total) || 0);
      const done = Math.min(total, Math.max(0, Number(snapshot.acceptance.done) || 0));
      return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
    }
    const mission = card && card.mission || {};
    const total = Math.max(0, Number(mission.milestonesTotal) || 0);
    const done = Math.min(total, Math.max(0, Number(mission.done) || 0));
    return { total, done, percent: total ? Math.round(done * 100 / total) : 0 };
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
      return { card, derived, titleValue: titleOf(card), progress: progressOf(card) };
    });
    const signature = `${getLocale()}\u001e${models.map(({ card, derived, titleValue, progress }) => [
      card.missionId, card.sessionId || '', derived.state, titleValue, progress.percent,
    ].join('\u001f')).join('\u001e')}`;
    if (signature !== renderedDockSignature) {
      const renderEpoch = ++dockRenderEpoch;
      const appendChunk = start => {
        if (renderEpoch !== dockRenderEpoch || signature !== renderedDockSignature) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(models.length, start + PREVIEW_DOCK_INITIAL_RENDER);
        for (let index = start; index < end; index++) {
          const { card, derived, titleValue, progress } = models[index];
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

  function actionButton(label, className, handler) {
    const button = text('button', className, label);
    button.type = 'button';
    button.onclick = handler;
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
    return t(`previewShell.interventionType.${['permission', 'question', 'plan', 'pool'].includes(type) ? type : 'unknown'}`);
  }

  function interventionSummary(item) {
    if (item.type === 'permission') return item.toolName || t('previewShell.permissionFallback');
    if (item.type === 'question') return item.questionSummary || item.questions?.[0]?.question || t('previewShell.questionFallback');
    if (item.type === 'plan') return item.planSummary || t('previewShell.planFallback');
    if (item.type === 'pool') return item.task || t('previewShell.poolFallback');
    return t('previewShell.unknown');
  }

  function decisionKey(item, action) {
    const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `preview:${String(item.id || '').slice(0, 40)}:${String(action || '').slice(0, 16)}:${uuid}`.slice(0, 128);
  }

  function setNeedsDrawer(open, { focus = true } = {}) {
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
      if (focus) requestAnimationFrame(() => byId('previewNeedsCloseBtn')?.focus());
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
      const field = document.createElement('fieldset');
      field.className = 'preview-question-field';
      field.dataset.questionId = String(question.id || `question_${index + 1}`);
      field.dataset.answerMode = String(question.answerMode || (question.multiSelect ? 'multiple' : 'single'));
      const legend = text('legend', '', question.header || t('previewShell.questionNumber', { p1: index + 1 }));
      field.append(legend, text('p', 'preview-question-copy', question.question || question.header || ''));
      const mode = field.dataset.answerMode;
      for (const option of Array.isArray(question.options) ? question.options : []) {
        const label = text('label', 'preview-question-option', '');
        const input = document.createElement('input');
        input.type = mode === 'multiple' ? 'checkbox' : 'radio';
        input.name = `preview-${item.id}-${field.dataset.questionId}`;
        input.dataset.optionId = String(option.id || '');
        const optionCopy = text('span', '', '');
        optionCopy.append(text('strong', '', option.label || option.id || ''), text('small', '', option.description || ''));
        label.append(input, optionCopy); field.appendChild(label);
      }
      if (mode === 'text' || question.allowOther === true) {
        const otherLabel = text('label', 'preview-question-other', question.otherLabel || (mode === 'text' ? t('previewShell.questionAnswer') : t('previewShell.questionOther')));
        const input = document.createElement('textarea'); input.rows = mode === 'text' ? 3 : 2;
        input.dataset.otherText = 'true';
        input.placeholder = question.otherPlaceholder || t('previewShell.questionPlaceholder');
        otherLabel.appendChild(input); field.appendChild(otherLabel);
      }
      form.appendChild(field);
    }
    return form;
  }

  function collectQuestionDecision(card) {
    const answers = [];
    for (const field of card.querySelectorAll('.preview-question-field')) {
      const selectedOptionIds = [...field.querySelectorAll('[data-option-id]:checked')].map(input => input.dataset.optionId || '');
      const otherText = String(field.querySelector('[data-other-text]')?.value || '').trim();
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

  function renderNeedsDrawer() {
    const drawer = byId('previewNeedsDrawer');
    if (!drawer || !needsDrawerOpen) return;
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
    renderedSession = null;
    renderedLocale = '';
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
    const claude = Boolean(state?.config?.claudePath || state?.status?.detectedClaudePath);
    return { ready: claude || providers.length > 0, label: engineLabel() || (claude ? 'Claude CLI' : '') };
  }

  function formatTaskTime(value) {
    const date = new Date(value || 0);
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
    const meta = text('span', 'preview-home-task-meta', '');
    meta.append(text('span', '', t('previewShell.progressPercent', { p1: progress.percent })),
      text('span', '', formatTaskTime(card.updatedAt || card.createdAt)),
      text('span', 'preview-home-task-enter', '↗'));
    button.append(header, goal, meta);
    button.setAttribute('aria-label', t('previewShell.homeTaskAria', { p1: titleOf(card), p2: stateLabel(derived.state), p3: progress.percent }));
    return button;
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
      };
      const result = await dispatchCommand(request);
      if (!result || !result.sessionId) throw new Error(t('previewShell.dispatchStartFailed'));
      dispatchText = ''; dispatchDraft = null;
      if (kind === 'quick_ask') {
        applyShellMode('classic');
        await openSession(result.sessionId);
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
    if (cards.length || recent.length) return null;
    const guide = text('section', 'preview-first-run', '');
    guide.setAttribute('aria-label', t('previewShell.firstRunTitle'));
    guide.append(text('span', 'preview-eyebrow', t('previewShell.firstRunEyebrow')),
      text('h2', '', t('previewShell.firstRunTitle')),
      text('p', 'preview-home-section-copy', t('previewShell.firstRunBody')));
    const steps = text('div', 'preview-first-run-steps', '');
    const workspace = actionButton(t('previewShell.firstRunWorkspaceAction'), 'preview-first-run-step preview-first-run-workspace', async () => {
      await pickWorkspace();
      renderFacts(); renderHome();
    });
    workspace.replaceChildren(text('span', 'preview-first-run-number', '1'), text('span', 'preview-first-run-step-copy', t('previewShell.firstRunWorkspace')));
    const safety = text('div', 'preview-first-run-step', '');
    safety.append(text('span', 'preview-first-run-number', '2'), text('span', 'preview-first-run-step-copy', t('previewShell.firstRunSafety', { p1: permissionLabel() })));
    const ready = engineReadiness();
    const engine = ready.ready
      ? text('div', 'preview-first-run-step is-ready', '')
      : actionButton(t('previewShell.firstRunEngineAction'), 'preview-first-run-step', () => openSettings('providers'));
    engine.replaceChildren(text('span', 'preview-first-run-number', '3'), text('span', 'preview-first-run-step-copy', ready.ready
      ? t('previewShell.firstRunEngineReady', { p1: ready.label || t('previewShell.unknown') })
      : t('previewShell.firstRunEngine')));
    steps.append(workspace, safety, engine);
    guide.appendChild(steps);
    return guide;
  }

  function homeSectionHeading(index, title, body, trailing) {
    const head = text('div', 'preview-home-section-head', '');
    const number = text('span', 'preview-section-index', String(index).padStart(2, '0'));
    number.setAttribute('aria-hidden', 'true');
    const copy = text('div', 'preview-home-section-heading-copy', '');
    copy.append(text('h2', '', title), text('p', 'preview-home-section-copy', body));
    head.append(number, copy);
    if (trailing) head.appendChild(trailing);
    return head;
  }

  function buildDispatchComposer() {
    const section = text('section', 'preview-dispatch-box', '');
    section.setAttribute('aria-label', t('previewShell.dispatchBox'));
    const mode = text('span', 'preview-dispatch-mode', t('previewShell.quickAskHint'));
    const heading = homeSectionHeading(1, t('previewShell.dispatchBox'), t('previewShell.dispatchBoxBody'), mode);
    const field = text('div', 'preview-dispatch-field', '');
    const mark = text('span', 'preview-dispatch-mark', '›'); mark.setAttribute('aria-hidden', 'true');
    const input = document.createElement('textarea');
    input.id = 'previewDispatchInput'; input.className = 'preview-dispatch-input'; input.rows = 5;
    input.value = dispatchText; input.placeholder = t('previewShell.dispatchPlaceholder'); input.disabled = dispatchBusy;
    input.setAttribute('aria-label', t('previewShell.dispatchInputAria'));
    input.oninput = () => { dispatchText = input.value; dispatchError = ''; };
    input.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); prepareDispatch(input.value); }
    };
    const actions = text('div', 'preview-dispatch-actions', '');
    const quick = actionButton(t('previewShell.quickAsk'), 'preview-quick-action', () => { void submitDispatch('quick_ask', dispatchText.replace(/^[?？]\s*/, '')); });
    const review = actionButton(t('previewShell.reviewDispatch'), 'primary preview-launch-action', () => prepareDispatch(dispatchText));
    quick.id = 'previewQuickAskBtn'; review.id = 'previewDispatchReviewBtn';
    quick.disabled = dispatchBusy; review.disabled = dispatchBusy;
    actions.append(text('span', 'preview-dispatch-keyhint', t('previewShell.dispatchKeyHint')), quick, review);
    field.append(mark, input);
    section.append(heading, field, actions);
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
    facts.append(purpose, workspace, safety);
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
    const count = text('span', 'preview-home-section-count', String(active.length));
    const head = homeSectionHeading(2, t('previewShell.continueTitle'), t('previewShell.continueBody'), count);
    const rail = text('div', 'preview-continue-rail', '');
    if (active.length) active.forEach(card => rail.appendChild(homeMissionButton(card, 'preview-continue-card')));
    else rail.appendChild(text('p', 'preview-home-empty-copy', t('previewShell.continueEmpty')));
    section.append(head, rail);
    return section;
  }

  function buildPlaybookShelf() {
    const mode = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'simple' : 'pro';
    const visible = playbooks.filter(pb => pb && (!pb.uiMode || pb.uiMode === 'both' || pb.uiMode === mode)).slice(0, 4);
    const section = text('section', 'preview-home-section preview-playbook-section', '');
    const head = homeSectionHeading(3, t('previewShell.playbookTitle'), t('previewShell.playbookBody'));
    const shelf = text('div', 'preview-playbook-shelf', '');
    if (!visible.length) shelf.appendChild(text('p', 'preview-home-empty-copy', t('previewShell.playbookEmpty')));
    for (const [index, pb] of visible.entries()) {
      const available = pb.available !== false;
      const item = text('button', `preview-playbook-card${available ? '' : ' unavailable'}`, '');
      item.type = 'button'; item.disabled = !available;
      const serial = text('span', 'preview-playbook-serial', String(index + 1).padStart(2, '0'));
      const body = text('span', 'preview-playbook-body', '');
      body.append(text('strong', '', playbookName(pb)),
        text('span', 'preview-playbook-copy', available ? playbookDescription(pb) : playbookUnavailableReason(pb)));
      item.append(serial, text('span', 'preview-playbook-icon', pb.icon || '◆'), body, text('span', 'preview-playbook-enter', '↗'));
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
    const head = homeSectionHeading(4, t('previewShell.recentTitle'), t('previewShell.recentBody'));
    const recent = cards.filter(card => !missionUi(card && card.missionId).archived && ['done', 'stopped'].includes(missionState.fromCard(card).state)).slice(0, 3);
    const grid = text('div', 'preview-recent-grid', '');
    if (recent.length) recent.forEach(card => grid.appendChild(homeMissionButton(card, 'preview-recent-card')));
    else grid.appendChild(text('p', 'preview-home-empty-copy', t('previewShell.recentEmpty')));
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
    const article = text('article', 'preview-archive', '');
    const head = text('header', 'preview-archive-head', '');
    const heading = text('div', 'preview-archive-heading', '');
    heading.append(text('span', 'preview-eyebrow', t('previewShell.archiveEyebrow')),
      text('h1', '', t('previewShell.archiveTitle')),
      text('p', '', t('previewShell.archiveBody')));
    const terminal = cards.filter(card => ['done', 'stopped'].includes(missionState.fromCard(card).state));
    head.append(heading, text('strong', 'preview-archive-count', t('previewShell.archiveCount', { p1: terminal.length })));

    const controls = text('div', 'preview-archive-controls', '');
    const search = document.createElement('input');
    search.id = 'previewArchiveSearch'; search.type = 'search'; search.value = archiveQuery;
    search.placeholder = t('previewShell.archiveSearch'); search.setAttribute('aria-label', t('previewShell.archiveSearch'));
    search.oninput = event => {
      archiveQuery = event.target.value;
      renderArchive();
      requestAnimationFrame(() => { const next = byId('previewArchiveSearch'); next?.focus(); next?.setSelectionRange(archiveQuery.length, archiveQuery.length); });
    };
    const filters = text('div', 'preview-archive-filters', '');
    for (const value of ['all', 'done', 'stopped', 'pinned', 'archived']) {
      const button = actionButton(t(`previewShell.archiveFilter.${value}`), 'preview-archive-filter', () => { archiveFilter = value; renderArchive(); });
      button.setAttribute('aria-pressed', archiveFilter === value ? 'true' : 'false');
      filters.appendChild(button);
    }
    const group = document.createElement('select');
    group.id = 'previewArchiveGroup'; group.setAttribute('aria-label', t('previewShell.archiveGroupLabel'));
    for (const value of ['workspace', 'state']) {
      const option = document.createElement('option'); option.value = value; option.textContent = t(`previewShell.archiveGroup.${value}`); group.appendChild(option);
    }
    group.value = archiveGroup; group.onchange = event => { archiveGroup = event.target.value === 'state' ? 'state' : 'workspace'; renderArchive(); };
    controls.append(search, filters, group);

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
    article.append(head, controls, ledger);
    main.replaceChildren(article);
  }

  function renderHome() {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'home'; delete main.dataset.missionId;
    const article = text('article', 'preview-dispatch-home', '');
    const intro = text('header', 'preview-home-intro', '');
    const introMeta = text('div', 'preview-home-intro-meta', '');
    introMeta.append(text('span', 'preview-eyebrow', t('previewShell.homeEyebrow')), text('span', 'preview-home-coordinate', '01 — 04'));
    intro.append(introMeta, text('h1', '', t('previewShell.homeTitle')),
      text('p', 'preview-home-lead', t('previewShell.homeBody')), text('span', 'preview-home-axis', ''));
    article.appendChild(intro);
    const guide = buildFirstRunGuide();
    if (guide) article.appendChild(guide);
    article.append(buildDispatchComposer(), buildContinueSection(), buildPlaybookShelf(), buildRecentSection());
    main.replaceChildren(article);
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
    loading.append(text('span', 'preview-eyebrow', t('previewShell.rawLens')),
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
    return ['permissions', 'questions', 'plans', 'pool'].reduce((sum, key) => sum + Math.max(0, Number(pending && pending[key]) || 0), 0);
  }

  function resultLabel(snapshot) {
    const status = String(snapshot && snapshot.result && snapshot.result.status || '');
    if (status === 'complete') return t('previewShell.resultComplete');
    if (status === 'stopped') return t('previewShell.resultStopped');
    return t('previewShell.resultPending');
  }

  function makeMetric(slot, label) {
    const metric = text('div', 'preview-task-metric', '');
    metric.append(text('span', 'preview-task-metric-label', label), text('strong', 'preview-task-metric-value', '—'));
    metric.querySelector('strong').dataset.slot = slot;
    return metric;
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
    kicker.append(text('span', 'preview-eyebrow', t('previewShell.rawLens')), statePill);
    const heading = text('h1', 'preview-mission-title', ''); heading.dataset.slot = 'title';
    const goal = text('p', 'preview-mission-goal', ''); goal.dataset.slot = 'goal';
    const progress = text('section', 'preview-mission-ledger preview-task-progress', '');
    progress.setAttribute('aria-label', t('previewShell.progressLabel'));
    const progressHead = text('div', 'preview-ledger-head', '');
    progressHead.append(text('strong', '', t('previewShell.progressLabel')), text('span', '', '—'));
    progressHead.lastChild.dataset.slot = 'progressText';
    const bar = document.createElement('progress');
    bar.className = 'preview-progress'; bar.max = 1; bar.value = 0; bar.dataset.slot = 'progress';
    progress.append(progressHead, bar);
    const metrics = text('div', 'preview-task-metrics', '');
    metrics.append(makeMetric('turns', t('previewShell.turns')), makeMetric('tokens', t('previewShell.tokens')),
      makeMetric('cost', t('previewShell.cost')), makeMetric('runs', t('previewShell.runs')));
    head.append(kicker, heading, goal, progress, metrics);

    const returnSummary = text('section', 'preview-return-summary', '');
    returnSummary.dataset.slot = 'returnSummary'; returnSummary.hidden = true;
    returnSummary.setAttribute('aria-label', t('previewShell.returnTitle'));

    const stopCard = text('section', 'preview-stop-card', '');
    stopCard.dataset.slot = 'stopCard'; stopCard.hidden = true;
    stopCard.setAttribute('aria-label', t('previewShell.stopCardTitle'));

    const body = text('div', 'preview-task-body', '');
    const worksite = text('section', 'preview-worksite', '');
    worksite.setAttribute('aria-label', t('previewShell.worksite'));
    const worksiteHead = text('div', 'preview-worksite-head', '');
    const worksiteTitle = text('div', '', '');
    worksiteTitle.append(text('h2', '', t('previewShell.worksite')), text('p', '', t('previewShell.worksiteHint')));
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
    body.append(worksite, intake);

    const foot = text('footer', 'preview-main-actions preview-task-actions', '');
    foot.append(actionButton(t('previewShell.backHome'), '', () => openDispatchHome()),
      actionButton(t('previewShell.openMissionClassic'), 'primary', () => { void openSelectedInClassic(); }),
      actionButton(t('previewShell.refresh'), '', () => { void refreshPreviewShell({ forceDetail: true }); }));
    article.append(head, returnSummary, stopCard, body, foot);
    main.replaceChildren(article);
    return article;
  }

  function setSlot(article, name, value) {
    const node = article?.querySelector(`[data-slot="${name}"]`);
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  function renderTaskHeader(article, card, snapshot) {
    const derived = missionState.fromSnapshot(snapshot);
    const progress = progressOf(card, snapshot);
    setSlot(article, 'title', titleOf(card));
    setSlot(article, 'goal', snapshot.mission?.goal || card.mission?.goal || t('previewShell.goalFallback'));
    const pill = setSlot(article, 'state', stateLabel(derived.state));
    if (pill) { pill.className = `preview-state-pill state-${derived.state}`; pill.dataset.missionState = derived.state; }
    setSlot(article, 'progressText', t('previewShell.progressValue', { p1: progress.done, p2: progress.total }));
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
      text('p', '', result.how === 'stop'
        ? t('previewShell.stopCardUserReason', { p1: unfinished.length })
        : t('previewShell.stopCardReason', { p1: unfinished.length })));
    if (unfinished.length) {
      const list = text('ul', 'preview-stop-unfinished', '');
      for (const item of unfinished.slice(0, 3)) list.appendChild(text('li', '', item.desc || item.id || t('previewShell.unknown')));
      copy.appendChild(list);
    }
    const actions = text('div', 'preview-stop-actions', '');
    actions.append(
      actionButton(t('previewShell.stopRetry'), 'primary', () => {
        void openSelectedInClassic(t('previewShell.stopRetryDraft', { p1: snapshot.mission?.goal || titleOf(card) }));
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
    if (!host || !selectedChanges) return;
    host.hidden = false;
    host.classList.toggle('is-degraded', selectedChanges.degraded === true);
    const changes = Array.isArray(selectedChanges.changes) ? selectedChanges.changes : [];
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
    const ledger = readonlyPanel('ledger', t('previewShell.ledgerPanel'), t('previewShell.ledgerValue', { p1: checkpoints }),
      t('previewShell.ledgerPanelBody', { p1: commands, p2: irreversible, p3: runs.length, p4: liveRuns, p5: maxRunCursor }));
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

  function appendPreviewLiveText(value) {
    const live = ensurePreviewLiveRow();
    if (!live || !value) return;
    live.pending.push(String(value));
    if (live.rafId) return;
    const host = byId('previewRawMessages');
    const follow = host ? host.scrollHeight - host.scrollTop - host.clientHeight < 120 : true;
    const savedTop = host?.scrollTop || 0;
    live.rafId = requestAnimationFrame(() => {
      live.rafId = 0;
      if (!previewLive || previewLive !== live) return;
      const delta = live.pending.join(''); live.pending.length = 0;
      if (delta) live.node.appendData(delta);
      if (host) host.scrollTop = follow ? host.scrollHeight : savedTop;
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
    renderReturnSummary(article);
    renderStopCard(article, card, selectedSnapshot);
    renderIntakeDesk(article, selectedSnapshot);
    renderRawMessages();
    replayActiveTurn();
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

  function renderPreviewShell() {
    renderFacts();
    renderDock();
    renderMain();
    renderNeedsDrawer();
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
      const needsSession = forceSession || !session || session.id !== sessionId || previousTurn !== nextTurn;
      const [sessionResponse, changeResponse] = await Promise.all([
        needsSession ? api(`/api/sessions/${sessionId}`) : Promise.resolve(null),
        api(`/api/missions/${sessionId}/changes?after=${detailBaselineRevision}`),
      ]);
      if (epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
      if (sessionResponse) session = sessionResponse.session;
      if (Number(changeResponse?.currentRevision) !== snapshotRevision) {
        const refreshed = await api(`/api/missions/${sessionId}`);
        if (epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
        if (refreshed && refreshed.snapshot) snapshot = refreshed.snapshot;
      }
      selectedSnapshot = snapshot;
      selectedChanges = changeResponse;
      if (session) selectedSession = session;
      if (forceSession) clearPreviewLive();
      renderTaskSheet(card);
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
        const [missionResponse, interventionResponse, playbookResponse] = await Promise.all([
          api('/api/missions?limit=200'),
          api('/api/interventions?limit=100'),
          playbooksLoaded ? Promise.resolve(null) : api('/api/playbooks').catch(() => null),
        ]);
        if (epoch !== refreshEpoch) return null;
        cards = Array.isArray(missionResponse && missionResponse.missions) ? missionResponse.missions : [];
        inboxCounts = interventionResponse && interventionResponse.counts || { total: 0 };
        pendingInterventions = Array.isArray(interventionResponse && interventionResponse.pending) ? interventionResponse.pending : [];
        const pendingIds = new Set(pendingInterventions.map(item => String(item && item.id || '')));
        for (const id of interventionDrafts.keys()) if (!pendingIds.has(id)) interventionDrafts.delete(id);
        if (!playbooksLoaded) {
          playbooks = Array.isArray(playbookResponse && playbookResponse.playbooks) ? playbookResponse.playbooks : [];
          playbooksLoaded = true;
        }
        const selectedExists = cards.some(card => card && card.missionId === selectedMissionId);
        if (activeView === 'mission' && !selectedExists) {
          activeView = 'home'; selectedMissionId = ''; resetSelectedDetail();
        } else if (activeView === 'home' && selectedMissionId && !selectedExists) {
          selectedMissionId = '';
        }
        renderPreviewShell();
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
      ensurePreviewLiveRow();
      return;
    }
    if (envelope.type === 'settled') {
      if (previewLive?.rafId) cancelAnimationFrame(previewLive.rafId);
      if (previewLive?.pending.length) previewLive.node.appendData(previewLive.pending.join(''));
      if (previewLive) { previewLive.pending.length = 0; previewLive.rafId = 0; previewLive.bubble.classList.remove('stream-cursor'); }
      scheduleDetailRefresh(true);
      return;
    }
    if (envelope.type !== 'event' || !envelope.line) return;
    let event; try { event = JSON.parse(envelope.line); } catch { return; }
    if (event.type === 'assistant_delta') appendPreviewLiveText(event.text || '');
    else if (event.type === 'session' && event.session && event.session.id === selectedSessionId()) {
      selectedSession = event.session; renderedSession = null; renderRawMessages();
    } else if (['mission', 'usage', 'agent_workflow', 'tool_result'].includes(event.type)) scheduleDetailRefresh(false);
  }

  function refreshPreviewShellLabels() {
    syncModeControl(isPreviewMode() ? 'preview' : 'classic');
    renderedLocale = '';
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
    const classic = byId('previewClassicBtn');
    if (classic) classic.onclick = () => applyShellMode('classic');
    const home = byId('previewHomeBtn');
    if (home) home.onclick = () => openDispatchHome();
    const archive = byId('previewArchiveBtn');
    if (archive) archive.onclick = () => openArchive();
    const refresh = byId('previewRefreshBtn');
    if (refresh) refresh.onclick = () => { void refreshPreviewShell({ forceDetail: true }); };
    const settings = byId('previewSettingsBtn');
    if (settings) settings.onclick = () => openSettings('basic');
    const workspace = byId('previewWorkspaceFact');
    if (workspace) workspace.onclick = () => openSettings('basic');
    const safety = byId('previewSafetyFact');
    if (safety) safety.onclick = () => openSettings('basic');
    const engine = byId('previewEngineFact');
    if (engine) engine.onclick = () => openSettings('providers');
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
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && needsDrawerOpen) { event.preventDefault(); setNeedsDrawer(false); }
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
