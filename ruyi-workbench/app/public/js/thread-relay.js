'use strict';
import { state } from './state.js';
import { api, apiErrorInfo, wcwToken } from './net.js';
import { el, toast } from './util.js';
import { hasTranslation, t } from './i18n.js';

// A bounded sequence, with a fresh, explicit delivery review between steps.
// Session option values are real IDs; duplicate titles remain distinguishable.
export async function openThreadRelay({ buildModal, openExistingThread = async () => {} }) {
  const body = el('div', 'thread-relay'), foot = el('div', 'modal-actions');
  const close = el('button', '', t('common.close')); foot.append(close);
  const modal = buildModal(t('relay.title'), body, foot); close.onclick = () => modal.close();
  let disposed = false, rootId = state.currentSession?.id || '', delivery = null, selected = null;
  const requestId = 'relay_' + crypto.randomUUID().replaceAll('-', '');
  const hint = el('p', 'muted', t('relay.description')), feedback = el('p', 'muted');
  body.append(hint);
  const sessions = (await api('/api/sessions')).sessions.filter(row => row.kind !== 'steward');
  const field = (label, input) => { const wrap = el('label', 'workflow-field'); wrap.append(el('span', '', label), input); return wrap; };
  const choose = value => {
    const select = document.createElement('select');
    for (const row of sessions) { const option = document.createElement('option'); option.value = row.id; option.textContent = (row.title || t('relay.untitled')) + ' · ' + row.id; select.append(option); }
    select.value = sessions.some(row => row.id === value) ? value : sessions[0]?.id || ''; return select;
  };
  const source = choose(rootId), review = el('section', 'thread-relay-review'), steps = el('div', 'thread-relay-steps');
  rootId = source.value;
  source.dataset.relayField = 'source';
  const load = el('button', 'mini thread-relay-inspect', t('relay.inspect')), add = el('button', 'mini thread-relay-add', t('relay.addStep'));
  const create = el('button', 'primary thread-relay-save', t('relay.save')), refresh = el('button', 'thread-relay-refresh', t('relay.refresh'));
  const history = el('div', 'thread-relay-history');
  body.append(field(t('relay.source'), source), load, review, steps, add, create, refresh, feedback, history);
  const targets = [];
  function addStep() {
    if (targets.length >= 7) return;
    const row = el('div', 'thread-relay-step'), target = choose(sessions.find(item => item.id !== source.value && !targets.some(entry => entry.target.value === item.id))?.id);
    target.dataset.relayField = 'target';
    const task = document.createElement('textarea'); task.rows = 2; task.maxLength = 8000; task.placeholder = t('relay.task');
    const remove = el('button', 'mini', t('common.delete')); row.append(field(t('relay.target', { n: targets.length + 1 }), target), task, remove);
    const entry = { row, target, task }; targets.push(entry); steps.append(row);
    remove.onclick = () => { targets.splice(targets.indexOf(entry), 1); row.remove(); };
  }
  add.onclick = addStep; addStep();
  function error(error) {
    const code = apiErrorInfo(error).code;
    const suffix = String(code).replace(/^thread_relay\./, '');
    const key = 'relay.error.' + suffix;
    feedback.textContent = hasTranslation(key) ? t(key) : t('relay.failed');
  }
  async function inspect(sessionId, turnSeq) {
    review.textContent = ''; selected = null; delivery = null;
    const session = (await api('/api/sessions/' + encodeURIComponent(sessionId))).session;
    const seq = turnSeq || session.turnSeq;
    const value = await api('/api/steward/delivery?sessionId=' + encodeURIComponent(sessionId) + '&turnSeq=' + seq);
    delivery = value;
    const content = session.messages.filter(row => row.role === 'assistant' && row.turnSeq === seq).map(row => row.content || '').join('\n\n');
    review.append(el('h3', '', t('relay.delivery', { n: seq })), el('pre', 'thread-relay-text', content));
    const text = document.createElement('input'); text.type = 'checkbox'; text.checked = true;
    review.append(field(t('relay.includeText'), text));
    const files = [];
    for (const file of value.files) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = file.status !== 'same';
      review.append(field(file.path + (check.disabled ? ' · ' + t('relay.fileUnavailable') : ''), check)); files.push({ path: file.path, check });
    }
    for (const check of value.checks) review.append(el('p', 'muted', check.desc + ' · ' + t(check.status === 'done' && check.applicable ? 'relay.checkPassed' : 'relay.checkOpen')));
    const accepted = document.createElement('input'); accepted.type = 'checkbox';
    accepted.className = 'thread-relay-accept';
    if (value.relayCompletion !== 'succeeded') {
      accepted.disabled = true;
      review.append(el('p', 'muted thread-relay-completion-unknown', t('relay.verifyCompletion')));
      const open = el('button', 'thread-relay-open-source', t('relay.openSource'));
      open.onclick = async () => { disposed = true; modal.close(); await openExistingThread(sessionId); };
      review.append(open);
    }
    review.append(field(t('relay.acceptExact'), accepted));
    selected = () => ({ reference: { turnSeq: value.turnSeq, latestTurnSeq: value.latestTurnSeq, sourceStamp: value.sourceStamp, fileStamp: value.fileStamp },
      accepted: accepted.checked, materials: { text: text.checked, files: files.filter(file => file.check.checked).map(file => file.path) } });
  }
  async function post(action, detail) {
    const result = await api('/api/thread-relays', { method: 'POST', body: JSON.stringify({ token: wcwToken(), action, sessionId: rootId, ...detail }) });
    return result.relay;
  }
  async function renderHistory() {
    if (!rootId || disposed) return;
    const result = await api('/api/thread-relays?sessionId=' + encodeURIComponent(rootId));
    history.textContent = '';
    for (const run of result.relays) {
      const card = el('section', 'thread-relay-card'); card.dataset.relayId = run.id;
      const cancel = el('button', 'mini danger thread-relay-cancel', t('relay.cancel'));
      cancel.disabled = run.threadRelay.cancelled || run.status === 'succeeded';
      cancel.onclick = async () => { try { await post('cancel', { relayId: run.id }); await renderHistory(); } catch (e) { error(e); } };
      card.append(el('h3', '', t('relay.savedChain')), cancel);
      for (const [index, edge] of run.threadRelay.edges.entries()) {
        const row = el('div', 'thread-relay-edge'); row.dataset.edgeId = edge.id;
        row.append(el('p', '', (index + 1) + '. ' + edge.targetTitle + ' · ' + edge.targetSessionId), el('p', '', edge.task), el('strong', '', t('relay.state.' + edge.state)));
        if (edge.source) row.append(el('p', 'muted', t('relay.boundDelivery', { n: edge.source.reference.turnSeq })), el('p', 'muted', edge.source.materials.files.map(file => file.path).join('\n') || t('relay.textOnly')));
        if (edge.state === 'ready') {
          const start = el('button', 'primary thread-relay-start', t('relay.start'));
          start.onclick = async () => { start.disabled = true; try { await post('start', { relayId: run.id, edgeId: edge.id }); await renderHistory(); } catch (e) { error(e); start.disabled = false; } };
          row.append(start);
        }
        if (edge.state === 'review') {
          const inspectResult = el('button', 'thread-relay-review-result', t('relay.reviewResult'));
          inspectResult.onclick = async () => {
            try {
              await inspect(edge.targetSessionId, edge.resultTurnSeq);
              const accept = el('button', 'primary thread-relay-accept-result', t('relay.acceptContinue'));
              review.append(accept);
              accept.onclick = async () => { try { await post('accept', { relayId: run.id, edgeId: edge.id, source: selected() }); review.textContent = ''; selected = null; await renderHistory(); } catch (e) { error(e); } };
            } catch (e) { error(e); }
          }; row.append(inspectResult);
        }
        if (['unknown', 'failed', 'stopped'].includes(edge.state)) row.append(el('p', 'muted', t('relay.recovery')));
        if (edge.reason?.startsWith('thread_relay.')) {
          const key = 'relay.error.' + edge.reason.slice('thread_relay.'.length);
          if (hasTranslation(key)) row.append(el('p', 'muted', t(key)));
        }
        card.append(row);
      }
      history.append(card);
    }
  }
  load.onclick = async () => { try { await inspect(source.value); } catch (e) { error(e); } };
  source.onchange = () => { rootId = source.value; delivery = null; selected = null; review.textContent = ''; renderHistory().catch(error); };
  create.onclick = async () => {
    if (!selected || delivery?.sessionId !== source.value) { feedback.textContent = t('relay.inspectFirst'); return; }
    create.disabled = true;
    try {
      rootId = source.value;
      await post('create', { requestId, source: selected(), targets: targets.map(entry => ({ sessionId: entry.target.value, task: entry.task.value })) });
      await renderHistory(); toast(t('relay.saved'), 'ok');
    } catch (e) { error(e); } finally { create.disabled = false; }
  };
  refresh.onclick = () => renderHistory().catch(error);
  const oldClose = close.onclick; close.onclick = () => { disposed = true; oldClose(); };
  await renderHistory();
}
