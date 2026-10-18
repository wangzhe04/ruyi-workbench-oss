'use strict';
import { el } from './util.js';
import { buildModal } from './modal.js';
import { apiErrorInfo } from './net.js';
import { EVENT_STREAM_ROW_EVENTS } from './event-stream.js';

const CACHE_KEY = 'ruyi.steward.decisions.v1';
const MAX_ROWS = 500;
const keyOf = iv => JSON.stringify([iv.sessionId, iv.id]);
const terminal = status => ['allowed', 'denied', 'answered', 'approved', 'rejected', 'cancelled', 'cancelled_restart', 'expired', 'indeterminate'].includes(status);

// 事项身份与待决身份都不取标题；同文问题仍是独立决定。
export function groupStewardDecisions(items) {
  const groups = new Map();
  for (const item of items) {
    const id = item.missionId || item.sessionId;
    if (!groups.has(id)) groups.set(id, { id, title: item.missionTitle || item.title || id, items: [] });
    groups.get(id).items.push(item);
  }
  return [...groups.values()];
}

export function createStewardDecisions({ api, t, isStewardMode, eventStream, openThread } = {}) {
  const records = new Map();
  let modal = null, list = null, notice = null, counter = null, refreshButton = null;
  let readSeq = 0, stale = true, queued = null, refreshFlight = null, refreshAgain = false;
  const labels = new WeakMap();
  const text = (node, key, params = {}) => {
    labels.set(node, { key, params }); node.textContent = t(key, params); return node;
  };
  const copy = (tag, cls, key, params) => text(el(tag, cls), key, params);
  const button = (key, run, cls = 'mini') => { const b = copy('button', cls, key); b.type = 'button'; b.onclick = run; return b; };
  function saveReceipts() {
    // 可恢复的界面缓存，不存答案、工具参数或授权；权威回执仍在原待决日志。
    const rows = [...records.values()].filter(r => r.attempt).slice(-100).map(r => ({
      sessionId: r.iv.sessionId, id: r.iv.id, missionId: r.iv.missionId, type: r.iv.type,
      title: r.iv.title, missionTitle: r.iv.missionTitle, version: r.iv.interventionVersion,
      attempt: r.attempt, action: r.action, at: r.at || Date.now(),
    }));
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows)); } catch { /* 存储不可用时仍可当页核对 */ }
  }
  function restoreReceipts() {
    try {
      const rows = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '[]');
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(-100)) {
        if (!row || typeof row.id !== 'string' || typeof row.sessionId !== 'string' || !/^[\w-]+$/.test(row.id) || !/^[\w-]+$/.test(row.sessionId) || Date.now() - row.at > 86400000) continue;
        const iv = { ...row, interventionVersion: row.version };
        records.set(keyOf(iv), { iv, phase: 'unknown', attempt: row.attempt, action: row.action, at: row.at });
      }
    } catch { /* 缓存损坏不变成决定 */ }
  }
  restoreReceipts();
  function viewingChanged() { document.dispatchEvent(new CustomEvent('steward:decisions-view')); }
  function close() {
    readSeq++; modal?.close(); modal = null;
    viewingChanged();
  }
  function update(r) {
    if (!r.node) return;
    r.node.dataset.phase = r.phase;
    r.node.setAttribute('aria-busy', String(r.phase === 'sending'));
    const busy = stale || r.phase !== 'pending' && r.phase !== 'failed';
    for (const control of r.controls) control.disabled = busy || r.iv.deliverable !== true || control.dataset.incomplete === 'true';
    text(r.receipt, 'decisions.phase.' + r.phase, { status: t('decisions.status.' + (r.status || 'unknown')) });
    if (r.badge) {
      r.badge.hidden = r.phase === 'pending';
      text(r.badge, ['success', 'settled'].includes(r.phase) ? 'decisions.status.' + (r.status || 'unknown') : 'decisions.phase.' + r.phase);
    }
    r.check.hidden = !['unknown', 'changed', 'missing'].includes(r.phase);
    r.check.disabled = r.checking === true;
  }
  async function history(iv) {
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const data = await api('/api/interventions/' + encodeURIComponent(iv.sessionId) + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (data?.ok !== true || !Array.isArray(data.interventions) || data.integrity?.degraded === true) throw new Error('invalid history');
      const found = data.interventions.find(row => row.id === iv.id && row.sessionId === iv.sessionId);
      if (found) return found;
      cursor = data.nextCursor;
      if (!cursor) return null;
    }
    return null;
  }
  async function checkReceipt(r) {
    if (r.checking || r.phase === 'sending') return;
    r.checking = true; update(r);
    try {
      const found = await history(r.iv);
      if (found && terminal(found.status)) {
        r.phase = 'settled'; r.status = found.status;
        // 显示权威状态，不把他处的批准或拒绝说成本按钮的成功。
      } else if (found?.status === 'applying') r.phase = 'unknown';
      else if (found?.status === 'pending' && r.attempt) r.phase = 'unknown';
      else r.phase = 'missing';
    } catch { r.phase = 'unknown'; }
    finally { r.checking = false; update(r); }
  }
  async function decide(r, action, payload = {}) {
    if (stale || !['pending', 'failed'].includes(r.phase) || !r.iv.deliverable) return;
    r.attempt = 'steward-item-' + crypto.randomUUID(); r.action = action; r.at = Date.now();
    r.phase = 'sending'; saveReceipts(); update(r);
    const body = { expectedVersion: r.iv.interventionVersion, idempotencyKey: r.attempt, action, ...payload };
    try {
      const result = await api('/api/missions/' + encodeURIComponent(r.iv.sessionId) + '/interventions/' + encodeURIComponent(r.iv.id) + '/decision', { method: 'POST', body: JSON.stringify(body) });
      const expected = { allow: 'allowed', deny: 'denied', approve: 'approved', reject: 'rejected', answer: 'answered' }[action];
      if (result?.ok !== true || result.interventionId !== r.iv.id || result.missionId !== r.iv.sessionId || result.action !== action || result.status !== expected) throw new Error('unconfirmed decision');
      r.phase = 'success'; r.status = result.status;
    } catch (error) {
      const code = apiErrorInfo(error).code.split('.').pop();
      if (code === 'persist_failed' || code === 'payload_invalid' || code === 'delivery_unavailable' || code === 'run_not_live' || code === 'run_paused') r.phase = 'failed';
      else if (['version_conflict', 'already_terminal', 'not_pending', 'expired', 'not_found'].includes(code)) r.phase = 'changed';
      else r.phase = 'unknown';
    }
    update(r);
    // 只读对账；不因回包丢失自动重投决定。
    if (r.phase === 'changed') await checkReceipt(r);
    void refresh();
  }
  function questionForm(r, body) {
    const readers = [];
    for (const q of r.iv.questions || []) {
      const field = el('fieldset', 'steward-decision-question'); field.append(el('legend', '', q.question || q.header));
      const selections = [];
      const mode = q.answerMode || (q.multiSelect ? 'multiple' : 'single');
      if (mode !== 'text') for (const option of q.options || []) {
        const label = el('label', 'steward-decision-option');
        const input = el('input'); input.type = mode === 'multiple' ? 'checkbox' : 'radio'; input.name = keyOf(r.iv) + q.id;
        input.value = option.id; selections.push(input); r.controls.push(input);
        label.append(input, el('span', '', option.label + (option.description ? ' · ' + option.description : ''))); field.append(label);
      }
      const answer = el('textarea'); answer.rows = 2; answer.maxLength = 6000;
      answer.setAttribute('aria-label', q.question || q.header || t('decisions.answer'));
      if (mode === 'text' || q.allowOther === true) { field.append(answer); r.controls.push(answer); }
      readers.push(() => ({ questionId: q.id, selectedOptionIds: selections.filter(input => input.checked).map(input => input.value), otherText: answer.value }));
      body.append(field);
    }
    const send = button('decisions.answer', () => {
      const answers = readers.map(read => read());
      if (!answers.length || answers.some(a => !a.selectedOptionIds.length && !a.otherText.trim())) { text(r.receipt, 'decisions.answerRequired'); return; }
      void decide(r, 'answer', { answer: { answers } });
    });
    if (!readers.length || readers.length > 3) send.dataset.incomplete = 'true';
    r.controls.push(send); body.append(send);
  }
  function buildRow(r) {
    const iv = r.iv;
    const row = el('details', 'steward-decision'); row.dataset.sessionId = iv.sessionId; row.dataset.interventionId = iv.id;
    const summary = el('summary', 'steward-decision-heading');
    summary.append(copy('span', 'steward-decision-type', 'decisions.type.' + iv.type), el('span', '', String(iv.questionSummary || iv.planSummary || iv.replanSummary || iv.task || iv.toolName || iv.id).slice(0, 160)),
      el('span', 'steward-decision-source', (iv.title || iv.sessionId) + ' · ' + iv.sessionId.slice(-6) + ' · ' + iv.id.slice(-6)));
    r.badge = el('span', 'steward-decision-source'); r.badge.dataset.receiptBadge = ''; summary.append(r.badge);
    const body = el('div', 'steward-decision-body');
    body.append(el('p', 'muted', (iv.title || iv.sessionId) + ' · ' + iv.sessionId + ' · ' + iv.id));
    body.append(copy('p', 'steward-decision-effect', 'decisions.effect.' + iv.type));
    const open = button('decisions.openSource', () => { close(); openThread(iv.sessionId); }); body.append(open);
    r.controls = []; r.receipt = el('p', 'steward-decision-receipt'); r.receipt.setAttribute('role', 'status');
    if (iv.type === 'question') {
      if (iv.context) body.append(el('pre', 'steward-decision-context', iv.context));
      questionForm(r, body);
    } else {
      if (iv.detailsText) body.append(el('pre', 'steward-decision-context', iv.detailsText));
      if (!iv.detailsComplete) body.append(copy('p', 'muted', 'decisions.incomplete'));
      const positive = iv.type === 'permission' ? 'allow' : 'approve';
      const negative = iv.type === 'permission' ? 'deny' : 'reject';
      const actions = el('div', 'steward-decision-actions');
      if (['permission', 'plan', 'pool', 'replan'].includes(iv.type)) for (const action of [negative, positive]) {
        const control = button('decisions.' + action, () => { void decide(r, action); });
        control.dataset.action = action;
        if (action === positive && !iv.detailsComplete) control.dataset.incomplete = 'true';
        actions.append(control); r.controls.push(control);
      }
      body.append(actions);
    }
    if (iv.deliverable === false) body.append(copy('p', 'muted', 'decisions.unavailable'));
    r.check = button('decisions.check', () => { void checkReceipt(r); });
    body.append(r.receipt, r.check); row.append(summary, body); r.node = row;
    row.addEventListener('toggle', () => {
      if (row.open && list) for (const other of list.querySelectorAll('details.steward-decision[open]')) if (other !== row) other.open = false;
      viewingChanged();
    });
    update(r); return row;
  }
  function paint() {
    if (!list) return;
    const restore = document.activeElement;
    const groups = groupStewardDecisions([...records.values()].map(r => r.iv));
    const sections = [];
    for (const group of groups) {
      const section = el('section', 'steward-decision-group'); section.dataset.missionId = group.id;
      section.append(el('h4', '', group.title + (groups.filter(other => other.title === group.title).length > 1 ? ' · ' + group.id.slice(-6) : '')));
      for (const iv of group.items) { const r = records.get(keyOf(iv)); section.append(r.node || buildRow(r)); update(r); }
      sections.push(section);
    }
    list.replaceChildren(...sections);
    if (restore?.isConnected) restore.focus({ preventScroll: true });
    if (!records.size) list.append(copy('p', 'muted', 'decisions.empty'));
    viewingChanged();
  }
  async function refresh() {
    if (!modal || !isStewardMode()) return;
    if (refreshFlight) { refreshAgain = true; return refreshFlight; }
    const seq = readSeq;
    refreshButton.disabled = true;
    refreshFlight = (async () => {
      try {
        const items = []; let cursor = '', total = 0;
        do {
          const data = await api('/api/interventions?view=steward&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
          if (data?.ok !== true || data.index?.degraded?.active === true || !Array.isArray(data.pending) || !data.pending.every(iv => iv && typeof iv.id === 'string' && typeof iv.sessionId === 'string' && Number.isInteger(iv.interventionVersion))) throw new Error('invalid pending');
          items.push(...data.pending); cursor = data.nextCursor; total = data.counts?.total || 0;
        } while (cursor && items.length < MAX_ROWS);
        if (seq !== readSeq || !modal) return;
        const seen = new Set();
        for (const iv of items) {
          const key = keyOf(iv); seen.add(key); const old = records.get(key);
          if (old && !['pending', 'failed', 'missing'].includes(old.phase)) { old.iv = { ...old.iv, ...iv }; continue; }
          if (old && old.iv.interventionVersion === iv.interventionVersion && old.iv.detailsText === iv.detailsText && old.iv.deliverable === iv.deliverable) { old.iv = iv; if (old.phase === 'missing' && !old.attempt) old.phase = 'pending'; }
          else records.set(key, { iv, phase: 'pending' });
        }
        for (const [key, r] of records) if (!seen.has(key) && ['pending', 'failed'].includes(r.phase)) r.phase = 'missing';
        const oldReceipts = [...records].filter(([key, r]) => !seen.has(key) && r.phase !== 'sending');
        for (const [key] of oldReceipts.slice(0, Math.max(0, oldReceipts.length - 100))) records.delete(key);
        stale = false;
        text(notice, cursor ? 'decisions.truncated' : 'decisions.current');
        text(counter, 'decisions.count', { count: total });
        paint();
        for (const r of records.values()) if (['unknown', 'missing', 'changed'].includes(r.phase)) void checkReceipt(r);
      } catch {
        if (seq !== readSeq || !modal) return;
        stale = true; text(notice, 'decisions.readFailed'); for (const r of records.values()) update(r);
      } finally {
        refreshFlight = null;
        if (modal && seq === readSeq) refreshButton.disabled = false;
        if (refreshAgain) { refreshAgain = false; void refresh(); }
      }
    })();
    return refreshFlight;
  }
  function open() {
    if (!isStewardMode() || modal) return;
    const body = el('div', 'steward-task-decisions');
    notice = copy('p', 'muted', 'decisions.loading'); notice.setAttribute('role', 'status');
    counter = copy('p', 'steward-decisions-count', 'decisions.count', { count: 0 });
    list = el('div', 'steward-decisions-list');
    refreshButton = button('decisions.refresh', () => { void refresh(); });
    body.append(counter, notice, refreshButton, list);
    modal = buildModal({ title: t('decisions.title'), body, size: 'large', extraClass: 'steward-decisions-modal', onCancel: () => { modal = null; readSeq++; queueMicrotask(viewingChanged); } });
    stale = true; paint(); void refresh();
  }
  function scheduleRefresh() {
    if (!modal || queued) return;
    queued = setTimeout(() => { queued = null; void refresh(); }, 120);
  }
  function bind() {
    const control = document.getElementById('stewardDecisionsBtn'); if (control) control.onclick = open;
    for (const name of EVENT_STREAM_ROW_EVENTS) eventStream?.on(name, scheduleRefresh);
    eventStream?.on('server.instance', () => { readSeq++; stale = true; if (notice) text(notice, 'decisions.loading'); for (const r of records.values()) update(r); scheduleRefresh(); });
    eventStream?.on('connection', data => { if (data?.connected) scheduleRefresh(); });
    globalThis.addEventListener('i18n:change', () => {
      if (!modal) return;
      for (const node of modal.backdrop.querySelectorAll('*')) { const value = labels.get(node); if (value) text(node, value.key, value.params); }
      const heading = modal.backdrop.querySelector('.modal-head h3'); if (heading) heading.textContent = t('decisions.title');
      modal.backdrop.querySelector('.modal')?.setAttribute('aria-label', t('decisions.title'));
      for (const r of records.values()) update(r);
    });
    new MutationObserver(() => { if (!isStewardMode()) close(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
  }
  return Object.freeze({ bind, open, close, refresh });
}
