'use strict';
import { el, button } from './steward-chips.js';

// 一处语言监听，只遍历仍在页面上的节点；弱引用不保留已移除卡片或异步预览。
const deliveryLabels = new WeakMap();
function relabelDeliveryNode(node) {
  const value = deliveryLabels.get(node);
  if (value) node.textContent = value.t(value.key, value.params) + (value.suffix ? ' · ' + value.t(value.suffix) : '');
}
function deliveryLabel(node, t, key, params = {}, suffix = '') {
  node.dataset.deliveryI18n = '';
  deliveryLabels.set(node, { t, key, params, suffix });
  relabelDeliveryNode(node);
  return node;
}
try { globalThis.addEventListener('i18n:change', () => {
  for (const node of document.querySelectorAll('.steward-deliverable [data-delivery-i18n]')) relabelDeliveryNode(node);
}); } catch { /* 无 DOM 的模块检查 */ }

export function invalidateStewardDeliveryPanels(root, sessionId, t) {
  if (!root) return;
  for (const panel of root.querySelectorAll('.steward-delivery-panel')) {
    if (panel.dataset.sessionId !== sessionId) continue;
    if (!panel.querySelector('.steward-delivery-outdated')) panel.prepend(deliveryLabel(el('p', 'steward-delivery-note steward-delivery-outdated'), t, 'delivery.revisionStarted'));
    for (const check of panel.querySelectorAll('[data-applicable="true"]')) {
      check.dataset.applicable = 'false';
      const label = check.querySelector('.steward-delivery-check-label');
      if (label && deliveryLabels.has(label)) { deliveryLabels.get(label).suffix = 'delivery.checkHistorical'; relabelDeliveryNode(label); }
    }
    for (const feedback of [panel.querySelector('.steward-delivery-feedback'), panel.parentNode?.querySelector('.steward-delivery-revision-feedback')]) {
      if (feedback) { feedback.textContent = ''; deliveryLabels.delete(feedback); }
    }
  }
}

// 交付卡的文件、检查与修订。每块只写自己的 DOM；刷新或异步预览不触碰其它卡片与草稿。
export function attachStewardDeliveryPanel(block, source, { api, t, renderFilePreviewInto, prepareRevision } = {}) {
  const panel = el('section', 'steward-delivery-panel');
  // 保留同一个工作台入口；与检查、刷新一起收进低频操作区，不再重复铺一排小按钮。
  const fullTextAction = block.querySelector('.steward-deliverable-full');
  if (fullTextAction) { deliveryLabel(fullTextAction, t, 'stewardShell.chat.deliverableFull'); fullTextAction.remove(); }
  const primaryActions = block.querySelector('.steward-deliverable-acts');
  const expand = block.querySelector('.steward-deliverable-more');
  panel.hidden = Boolean(expand && expand.getAttribute('aria-expanded') !== 'true');
  block.addEventListener('delivery:expand', event => {
    if (event.target !== block.querySelector('.steward-deliverable-body')) return;
    panel.hidden = !event.detail.expanded;
  });
  const copy = (tag, cls, key, params) => deliveryLabel(el(tag, cls), t, key, params);
  const control = (cls, key, run, params) => deliveryLabel(button(cls, '', run), t, key, params);
  const feedback = (node, key) => deliveryLabel(node, t, key);
  panel.dataset.sessionId = source.sessionId;
  panel.dataset.i18nAttr = 'aria-label:delivery.details';
  panel.setAttribute('aria-label', t('delivery.details'));
  block.appendChild(panel);
  const revisionFeedback = el('p', 'steward-delivery-feedback steward-delivery-revision-feedback');
  revisionFeedback.setAttribute('role', 'status');
  block.insertBefore(revisionFeedback, panel);
  let generation = 0;
  const endpoint = '/api/steward/delivery?sessionId=' + encodeURIComponent(source.sessionId) + '&turnSeq=' + encodeURIComponent(source.turnSeq);
  async function refresh() {
    const mine = ++generation;
    panel.setAttribute('aria-busy', 'true');
    try {
      const data = await api(endpoint);
      if (mine !== generation || !panel.isConnected) return;
      if (!data || data.ok !== true) throw new Error('delivery unavailable');
      paint(data);
    } catch (error) {
      if (mine !== generation || !panel.isConnected) return;
      panel.textContent = '';
      panel.append(copy('p', 'steward-delivery-note', error && error.status === 404 ? 'delivery.sourceMissing' : 'delivery.loadFailed'), control('steward-delivery-action', 'delivery.refresh', refresh));
      if (fullTextAction) panel.appendChild(fullTextAction);
    } finally { if (mine === generation) panel.removeAttribute('aria-busy'); }
  }
  function paint(data) {
    panel.textContent = '';
    revisionFeedback.textContent = ''; deliveryLabels.delete(revisionFeedback);
    if (data.outdated) panel.appendChild(copy('p', 'steward-delivery-note steward-delivery-outdated', 'delivery.outdated', { seq: data.latestTurnSeq }));
    if (data.inProgress) panel.appendChild(copy('p', 'steward-delivery-note', 'delivery.inProgress'));
    if (!data.evidenceRecorded) panel.appendChild(copy('p', 'steward-delivery-note', 'delivery.evidenceUnrecorded'));
    const files = Array.isArray(data.files) ? data.files : [];
    const checks = Array.isArray(data.checks) ? data.checks : [];
    if (files.some(file => file.status !== 'same') && files.length) panel.appendChild(copy('p', 'steward-delivery-note', 'delivery.filesNeedReview'));
    const actions = el('div', 'steward-delivery-actions');
    const more = el('details', 'steward-delivery-more');
    more.appendChild(copy('summary', 'steward-delivery-action', 'delivery.more'));
    const moreActions = el('div', 'composer-more-pop'); more.appendChild(moreActions);
    const fileBox = el('div', 'steward-delivery-files'); fileBox.hidden = !files.length;
    const checkBox = el('div', 'steward-delivery-checks'); checkBox.hidden = true;
    const preview = el('div', 'steward-delivery-preview'); preview.hidden = true;
    let previewGeneration = 0;
    const note = el('p', 'steward-delivery-feedback'); note.setAttribute('role', 'status');
    const disclosure = (key, count, target, parent = actions) => {
      const toggle = control(parent === actions ? 'steward-delivery-action' : 'cm-item steward-delivery-action', key, () => {
        target.hidden = !target.hidden;
        toggle.setAttribute('aria-expanded', String(!target.hidden));
        more.open = false;
      }, { count });
      toggle.setAttribute('aria-expanded', 'false'); parent.appendChild(toggle);
    };
    files.forEach((file, index) => {
      const row = el('div', 'steward-delivery-file');
      const open = button('steward-delivery-file-open', file.name, async () => {
        const mine = ++previewGeneration;
        open.disabled = true;
        try {
          preview.hidden = false;
          const destination = el('div', 'steward-delivery-preview-content');
          preview.replaceChildren(destination);
          const load = () => api(endpoint + '&file=' + index + '&fingerprint=' + encodeURIComponent(file.fingerprint) + '&sourceStamp=' + encodeURIComponent(data.sourceStamp));
          if (/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i.test(file.path)) {
            await load();
            if (mine !== previewGeneration || !open.isConnected) return;
            const opened = await api('/api/file/reveal', { method: 'POST', body: JSON.stringify({ path: file.path, sessionId: source.sessionId, mode: 'open' }) });
            if (mine !== previewGeneration || !open.isConnected) return;
            feedback(note, opened && opened.ok ? 'delivery.opened' : 'delivery.filePreviewFailed');
            preview.hidden = true;
            return;
          }
          await renderFilePreviewInto(destination, file.path, { sessionId: source.sessionId, open: false,
            load });
        } catch { if (mine === previewGeneration && open.isConnected) feedback(note, 'delivery.filePreviewFailed'); }
        finally { open.disabled = false; }
      });
      open.title = file.path;
      open.disabled = !file.fingerprint || typeof renderFilePreviewInto !== 'function' || ['missing', 'blocked', 'unavailable'].includes(file.status);
      const status = copy('span', 'steward-delivery-file-status', 'delivery.file.' + file.status);
      row.dataset.state = file.status;
      row.append(open, status);
      if (files.filter(other => other.name === file.name).length > 1) row.appendChild(el('span', 'steward-delivery-file-path', file.path));
      fileBox.appendChild(row);
    });
    if (data.filesTruncated) fileBox.appendChild(copy('p', 'muted', 'delivery.filesTruncated'));
    disclosure('delivery.showChecks', checks.length, checkBox, moreActions);
    if (!checks.length) checkBox.appendChild(copy('p', 'muted', data.checksRecorded ? 'delivery.checksEmpty' : 'delivery.checksUnrecorded'));
    checks.forEach(check => {
      const row = el('div', 'steward-delivery-check');
      let key = check.provenance === 'human' ? 'delivery.checkHuman' : check.checkState === 'fail' ? 'delivery.checkFail'
        : check.provenance === 'machine' && check.checkState === 'pass' ? 'delivery.checkMachine'
        : check.status === 'done' ? 'delivery.checkSelf' : 'delivery.checkOpen';
      row.dataset.provenance = check.provenance || 'open';
      row.dataset.applicable = String(check.applicable === true);
      row.append(el('span', 'steward-delivery-check-desc', check.desc), deliveryLabel(el('span', 'steward-delivery-check-label'), t, key, {}, check.applicable ? '' : 'delivery.checkHistorical'));
      if (check.checkedAt || check.checkDetail || check.evidence) row.appendChild(el('p', 'steward-delivery-check-detail', [check.checkedAt, check.checkDetail, check.evidence].filter(Boolean).join(' · ')));
      checkBox.appendChild(row);
    });
    const revise = control('steward-delivery-action steward-delivery-revise', 'delivery.revise', async () => {
      const revisionGeneration = generation;
      revise.disabled = true;
      try {
        // 先刷新版本,再准备草稿；用户按发送时服务端还会再比对一次。
        const latest = await api(endpoint);
        if (!revise.isConnected || revisionGeneration !== generation) return;
        if (!latest || !latest.ok || latest.sourceStamp !== data.sourceStamp) { feedback(revisionFeedback, 'delivery.sourceChanged'); return; }
        const result = typeof prepareRevision === 'function' ? prepareRevision(latest) : null;
        if (result && result.ok) { revisionFeedback.textContent = ''; deliveryLabels.delete(revisionFeedback); }
        else feedback(revisionFeedback, 'delivery.draftBusy');
      } catch { if (revise.isConnected && revisionGeneration === generation) feedback(revisionFeedback, 'delivery.loadFailed'); }
      finally { revise.disabled = false; }
    });
    moreActions.appendChild(control('cm-item steward-delivery-action', 'delivery.refresh', refresh));
    if (fullTextAction) {
      fullTextAction.classList.add('cm-item');
      deliveryLabel(fullTextAction, t, 'stewardShell.chat.deliverableFull');
      moreActions.appendChild(fullTextAction);
    }
    if (primaryActions) {
      primaryActions.querySelector('.steward-delivery-revise')?.remove();
      primaryActions.appendChild(revise);
    } else actions.appendChild(revise);
    actions.appendChild(more);
    panel.append(fileBox, preview, actions, checkBox, note);
  }
  panel.appendChild(copy('p', 'muted', 'delivery.loading'));
  void refresh();
  return panel;
}
