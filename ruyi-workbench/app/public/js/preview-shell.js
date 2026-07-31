'use strict';

// 第76–77波：默认关闭的新任务台壳层 + 原始任务单。领域事实只读自 Mission/Intervention/
// Session API；五态只调用 mission-state.js，消息正文只调用经典 chat-static-renderer。
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
  openSession = async () => {},
  renderStaticMessage = () => null,
  getActiveTurnLines = () => [],
} = {}) {
  const missionState = globalThis.MissionState;
  if (!missionState || typeof missionState.fromCard !== 'function') throw new Error('mission-state.js unavailable');

  let cards = [];
  let inboxCounts = { total: 0 };
  let selectedMissionId = '';
  let selectedSnapshot = null;
  let selectedSession = null;
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

  const byId = id => document.getElementById(id);
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  };
  const stateLabel = value => t(`previewShell.state.${value}`);
  const selectedCard = () => cards.find(card => card && card.missionId === selectedMissionId) || cards[0] || null;
  const selectedSessionId = () => String(selectedCard()?.sessionId || '');

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
    const card = selectedCard();
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
    const fragment = document.createDocumentFragment();
    for (const card of cards) {
      if (!card || !card.missionId) continue;
      const derived = missionState.fromCard(card);
      const titleValue = titleOf(card);
      const progress = progressOf(card);
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
      button.setAttribute('aria-pressed', card.missionId === selectedMissionId ? 'true' : 'false');
      const ring = text('span', 'preview-seal-ring', '');
      ring.setAttribute('aria-hidden', 'true');
      ring.appendChild(text('span', 'preview-seal-glyph', firstGlyph(titleValue)));
      button.append(ring, text('span', 'preview-seal-caption', stateLabel(derived.state)));
      item.appendChild(button);
      fragment.appendChild(item);
    }
    list.replaceChildren(fragment);
    const count = byId('previewDockCount');
    if (count) count.textContent = t('previewShell.taskCount', { p1: cards.length });
  }

  function actionButton(label, className, handler) {
    const button = text('button', className, label);
    button.type = 'button';
    button.onclick = handler;
    return button;
  }

  async function openSelectedInClassic() {
    const card = selectedCard();
    applyShellMode('classic');
    if (card && card.sessionId) await openSession(card.sessionId);
  }

  function resetSelectedDetail() {
    detailEpoch += 1;
    selectedSnapshot = null;
    selectedSession = null;
    rawWindowStart = null;
    renderedSession = null;
    renderedLocale = '';
    clearPreviewLive();
  }

  function renderEmptyMain() {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'empty';
    delete main.dataset.missionId;
    const card = text('section', 'preview-empty-card', '');
    card.append(text('span', 'preview-eyebrow', t('previewShell.previewLabel')),
      text('h1', '', t('previewShell.emptyTitle')),
      text('p', 'preview-main-copy', t('previewShell.emptyBody')),
      actionButton(t('previewShell.openClassic'), 'primary', () => applyShellMode('classic')));
    main.replaceChildren(card);
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
    foot.append(actionButton(t('previewShell.openMissionClassic'), 'primary', () => { void openSelectedInClassic(); }),
      actionButton(t('previewShell.refresh'), '', () => { void refreshPreviewShell({ forceDetail: true }); }));
    article.append(head, body, foot);
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
      pending ? t('previewShell.needsPanelBody', { p1: pending }) : t('previewShell.needsPanelEmpty'));
    needs.classList.toggle('has-attention', pending > 0);
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
    renderIntakeDesk(article, selectedSnapshot);
    renderRawMessages();
    replayActiveTurn();
  }

  function renderMain() {
    const card = selectedCard();
    if (!card) renderEmptyMain();
    else if (!selectedSnapshot) renderLoadingMain(card);
    else renderTaskSheet(card);
  }

  function renderError(error) {
    const main = byId('previewMain');
    if (!main) return;
    main.dataset.view = 'error';
    const card = text('section', 'preview-error-card', '');
    card.setAttribute('role', 'alert');
    card.append(text('h1', '', t('previewShell.loadFailed')), text('p', 'preview-main-copy', t('previewShell.loadFailedBody')),
      text('p', 'preview-error-detail', String(error && error.message || error || '')),
      actionButton(t('previewShell.retry'), 'primary', () => { void refreshPreviewShell({ forceDetail: true }); }));
    main.replaceChildren(card);
  }

  function renderPreviewShell() {
    renderFacts();
    renderDock();
    renderMain();
  }

  async function refreshSelectedMission({ forceSession = false, quiet = false } = {}) {
    const card = selectedCard();
    const sessionId = String(card && card.sessionId || '');
    if (!card || !sessionId) return null;
    const epoch = ++detailEpoch;
    try {
      const detail = await api(`/api/missions/${sessionId}`);
      const snapshot = detail && detail.snapshot;
      if (!snapshot || epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
      const previousTurn = Number(selectedSnapshot?.cursor?.turnSeq);
      const nextTurn = Number(snapshot.cursor?.turnSeq);
      let session = selectedSession;
      if (forceSession || !session || session.id !== sessionId || previousTurn !== nextTurn) {
        const response = await api(`/api/sessions/${sessionId}`);
        if (epoch !== detailEpoch || sessionId !== selectedSessionId()) return null;
        session = response && response.session;
      }
      selectedSnapshot = snapshot;
      if (session) selectedSession = session;
      if (forceSession) clearPreviewLive();
      renderTaskSheet(card);
      return snapshot;
    } catch (error) {
      if (epoch === detailEpoch && (!quiet || !selectedSnapshot)) renderError(error);
      return null;
    }
  }

  async function refreshPreviewShell({ quiet = false, forceDetail = false } = {}) {
    if (!isPreviewMode()) return null;
    if (refreshPromise) return refreshPromise;
    const epoch = ++refreshEpoch;
    const status = byId('previewShellStatus');
    if (status && !quiet) status.textContent = t('previewShell.loading');
    refreshPromise = (async () => {
      try {
        const [missionResponse, interventionResponse] = await Promise.all([
          api('/api/missions?limit=200'),
          api('/api/interventions?limit=1'),
        ]);
        if (epoch !== refreshEpoch) return null;
        cards = Array.isArray(missionResponse && missionResponse.missions) ? missionResponse.missions : [];
        inboxCounts = interventionResponse && interventionResponse.counts || { total: 0 };
        const previous = selectedMissionId;
        if (!cards.some(card => card && card.missionId === selectedMissionId)) selectedMissionId = cards[0]?.missionId || '';
        if (selectedMissionId !== previous) resetSelectedDetail();
        renderPreviewShell();
        if (selectedMissionId) await refreshSelectedMission({ forceSession: forceDetail || !selectedSession, quiet });
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
    const dock = byId('previewMissionDock');
    if (dock) dock.onclick = event => {
      const button = event.target.closest('.preview-seal');
      if (!button || !dock.contains(button)) return;
      const nextMissionId = button.dataset.missionId || '';
      if (nextMissionId !== selectedMissionId) { selectedMissionId = nextMissionId; resetSelectedDetail(); }
      renderPreviewShell();
      void refreshSelectedMission({ forceSession: true });
      byId('previewMain')?.focus();
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isPreviewMode()) void refreshPreviewShell({ quiet: true });
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
