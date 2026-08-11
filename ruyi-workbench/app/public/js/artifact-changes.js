'use strict';

// EC-D 第59波：会话产物与变更历史领域。
//
// 这两个视图共享「从当前会话读取文件结果、按轮次组织、预览或回撤」的边界。
// 文件预览、工具调用和确认弹层仍由组合根注入，避免本模块反向依赖 app.js。
import { state } from './state.js';
import { $, el, fileBasename, fmtBytes, toast } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { t } from './i18n.js';

export const ARTIFACT_KIND_ICON = {
  img: '🖼',
  md: '📝',
  csv: '📊',
  txt: '📄',
  html: '🌐',
  xlsx: '📊',
  docx: '📄',
  pdf: '📕',
  other: '📎',
};

const CHANGE_TEXTISH_EXT = new Set([
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'ts', 'jsx', 'tsx',
  'py', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'sh',
  'ps1', 'bat', 'cmd', 'sql', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'rb', 'php',
  'toml',
]);

export function collectSessionArtifacts(session) {
  const byPath = new Map();
  for (const message of ((session && session.messages) || [])) {
    const summary = message && message.turnSummary;
    if (!summary || !Array.isArray(summary.artifacts)) continue;
    for (const artifact of summary.artifacts) {
      if (!artifact || !artifact.path) continue;
      byPath.set(String(artifact.path), {
        path: String(artifact.path),
        kind: artifact.kind || 'other',
        turnSeq: Number(summary.turnSeq) || 0,
      });
    }
  }
  const byTurn = new Map();
  for (const artifact of byPath.values()) {
    if (!byTurn.has(artifact.turnSeq)) byTurn.set(artifact.turnSeq, []);
    byTurn.get(artifact.turnSeq).push(artifact);
  }
  return [...byTurn.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([turnSeq, items]) => ({ turnSeq, items }));
}

export function crudeLineDiff(before, after) {
  const left = String(before).split('\n');
  const right = String(after).split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
  }
  const context = 2;
  const cap = 400;
  return {
    ctxBefore: left.slice(Math.max(0, start - context), start),
    removed: left.slice(start, Math.min(leftEnd, start + cap)),
    added: right.slice(start, Math.min(rightEnd, start + cap)),
    ctxAfter: left.slice(leftEnd, Math.min(left.length, leftEnd + context)),
  };
}

export function createArtifactChangesDomain({
  apiErrText = fallbackApiErrText,
  renderFilePreviewInto = async () => {},
  runTool = async () => {},
  rollbackTurn = async () => {},
  buildModal = () => ({ close() {} }),
} = {}) {
  const changesState = { loading: false };

  async function renderArtifactsGallery() {
    const sessionId = state.currentSession?.id;
    if (sessionId) {
      try {
        const result = await api(`/api/sessions/${sessionId}`);
        if (result && result.session && state.currentSession?.id === sessionId) {
          state.currentSession = result.session;
        }
      } catch {
        // 拉取失败静默沿用旧数据，不清空已有产物。
      }
    }
    renderArtifactsFromState();
  }

  function renderArtifactsFromState() {
    const list = $('artifactsList');
    if (!list) return;
    list.textContent = '';
    $('artifactPreview')?.classList.add('hidden');
    const groups = collectSessionArtifacts(state.currentSession);
    const total = groups.reduce((count, group) => count + group.items.length, 0);
    if (!total) {
      list.appendChild(el('div', 'artifacts-empty', t('tool.artifacts.empty')));
      return;
    }
    for (const group of groups) {
      list.appendChild(el('div', 'artifacts-turn-head', t('tool.artifacts.turn', { turn: group.turnSeq })));
      for (const artifact of group.items) {
        const row = el('div', 'artifact-row');
        row.append(
          el('span', 'artifact-icon', ARTIFACT_KIND_ICON[artifact.kind] || ARTIFACT_KIND_ICON.other),
          el('span', 'artifact-name', fileBasename(artifact.path)),
        );
        row.querySelector('.artifact-name').title = artifact.path;
        const actions = el('span', 'artifact-actions');
        const preview = el('button', 'mini', t('common.preview'));
        preview.onclick = () => renderFilePreviewInto($('artifactPreview'), artifact.path);
        const open = el('button', 'mini', t('common.open'));
        open.onclick = () => runTool('office_open', { path: artifact.path });
        actions.append(preview, open);
        row.appendChild(actions);
        list.appendChild(row);
      }
    }
  }

  function changeToolLabel(entry) {
    const tool = String(entry && entry.tool || '').replace(/^.+?__/, '');
    return tool ? (t('changes.tool.' + tool) || tool) : '';
  }

  function changeSizeTransition(entry) {
    const beforeBytes = Number(entry && entry.bytes);
    const currentBytes = Number(entry && entry.currentBytes);
    const before = Number.isFinite(beforeBytes) && beforeBytes > 0 ? fmtBytes(beforeBytes) : null;
    const current = Number.isFinite(currentBytes) && currentBytes >= 0 ? fmtBytes(currentBytes) : null;
    if (entry && entry.op === 'create') {
      return current ? t('changes.sizeCreateSized', { size: current }) : t('changes.sizeCreate');
    }
    if (entry && entry.op === 'delete') {
      return before ? t('changes.sizeDelete', { size: before }) : t('changes.sizeDeleted');
    }
    if (before && current) return `${before} → ${current}`;
    return before ? `原 ${before}` : '';
  }

  function isTextishPath(pathValue) {
    const match = String(pathValue || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? CHANGE_TEXTISH_EXT.has(match[1]) : true;
  }

  function changeKindIcon(pathValue) {
    const match = String(pathValue || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    const extension = match ? match[1] : '';
    if (/^(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/.test(extension)) return ARTIFACT_KIND_ICON.img;
    if (extension === 'md' || extension === 'markdown') return ARTIFACT_KIND_ICON.md;
    if (extension === 'csv' || extension === 'tsv') return ARTIFACT_KIND_ICON.csv;
    if (extension === 'xlsx' || extension === 'xls') return ARTIFACT_KIND_ICON.xlsx;
    if (extension === 'docx' || extension === 'doc') return ARTIFACT_KIND_ICON.docx;
    if (extension === 'pdf') return ARTIFACT_KIND_ICON.pdf;
    if (extension === 'html' || extension === 'htm') return ARTIFACT_KIND_ICON.html;
    if (/^(txt|log|json|js|ts|py|md|css|xml|yml|yaml|ini|cfg|conf)$/.test(extension)) {
      return ARTIFACT_KIND_ICON.txt;
    }
    return ARTIFACT_KIND_ICON.other;
  }

  async function loadChanges() {
    if (changesState.loading) return;
    const list = $('changesList');
    if (!list) return;
    const sessionId = state.currentSession?.id;
    if (!sessionId) {
      list.textContent = '';
      list.appendChild(el('div', 'changes-empty', t('changes.emptyHint')));
      return;
    }
    changesState.loading = true;
    list.textContent = '';
    list.appendChild(el('div', 'changes-empty', t('common.loading')));
    let entries = [];
    try {
      const result = await api('/api/checkpoints?sessionId=' + encodeURIComponent(sessionId));
      entries = result && Array.isArray(result.entries) ? result.entries : [];
    } catch (error) {
      if (state.currentSession?.id === sessionId) {
        list.textContent = '';
        list.appendChild(el('div', 'changes-empty', t('changes.loadFailed') + apiErrText(error)));
      }
      changesState.loading = false;
      return;
    }
    changesState.loading = false;
    if (state.currentSession?.id !== sessionId) return;
    renderChanges(entries);
  }

  function renderChanges(entries) {
    const list = $('changesList');
    if (!list) return;
    list.textContent = '';
    $('changesPreview')?.classList.add('hidden');
    const valid = (entries || []).filter(entry => entry && entry.path);
    if (!valid.length) {
      list.appendChild(el('div', 'changes-empty', t('changes.emptyHint')));
      return;
    }
    const byTurn = new Map();
    for (const entry of valid) {
      const turnSeq = Number(entry.turnSeq) || 0;
      if (!byTurn.has(turnSeq)) byTurn.set(turnSeq, []);
      byTurn.get(turnSeq).push(entry);
    }
    const rounds = [...byTurn.entries()].sort((left, right) => right[0] - left[0]);
    for (const [turnSeq, items] of rounds) {
      items.sort((left, right) => Number(right.entrySeq) - Number(left.entrySeq));
      const card = el('div', 'change-card');
      const head = el('div', 'change-card-head');
      head.append(el('span', 'change-round-title', t('changes.roundTitle', { n: turnSeq })));
      head.append(el('span', 'change-round-count muted', t('changes.roundCount', { n: items.length })));
      const roundActions = el('span', 'change-round-actions');
      if (items.some(entry => !entry.skipped)) {
        const undoAll = el('button', 'mini change-undo-all', t('changes.revertTurn'));
        undoAll.onclick = () => rollbackTurn(turnSeq, undefined, undoAll, t('changes.turnLabel'));
        roundActions.append(undoAll);
      }
      if (items.some(entry => !entry.skipped && isTextishPath(entry.path))) {
        const nativeDiff = el('button', 'mini change-open-turn', t('changes.openTurnExternalDiff'));
        nativeDiff.onclick = () => openExternalChange({ turnSeq }, nativeDiff);
        roundActions.append(nativeDiff);
      }
      if (roundActions.childNodes.length) head.append(roundActions);
      card.append(head);
      const body = el('div', 'change-card-body');
      for (const entry of items) {
        const pathValue = String(entry.path);
        const operation = ['create', 'modify', 'delete'].includes(entry.op) ? entry.op : 'unknown';
        const row = el('div', 'change-row' + (entry.skipped ? ' skipped' : ''));
        const rowHead = el('div', 'change-row-head');
        rowHead.append(el('span', 'change-op ' + operation, t('changes.op.' + operation) || t('changes.op.modify')));
        rowHead.append(el('span', 'change-icon', changeKindIcon(pathValue)));
        const name = el('span', 'change-name', fileBasename(pathValue));
        name.title = pathValue;
        rowHead.append(name);
        if (entry.skipped) {
          rowHead.append(el('span', 'change-skip', t('changes.skippedLabel')));
        } else {
          const undo = el('button', 'mini change-undo', t('changes.revert'));
          undo.title = t('changes.revertTitle');
          undo.onclick = () => confirmRollbackEntry(entry, pathValue, undo);
          rowHead.append(undo);
        }
        row.append(rowHead);
        const meta = el('div', 'change-row-meta muted');
        const tool = changeToolLabel(entry);
        if (tool) meta.append(el('span', 'change-tool', tool));
        const size = changeSizeTransition(entry);
        if (size) meta.append(el('span', 'change-size', size));
        if (!entry.skipped) {
          if (isTextishPath(pathValue)) {
            const view = el('button', 'link-mini change-view', t('changes.viewDiff'));
            view.onclick = () => openChangeDiff(entry);
            const nativeDiff = el('button', 'link-mini change-native-diff', t('changes.openExternalDiff'));
            nativeDiff.onclick = () => openExternalChange(entry, nativeDiff);
            meta.append(view, nativeDiff);
          } else if (entry.op !== 'delete') {
            const open = el('button', 'link-mini change-view', t('common.open'));
            open.onclick = () => runTool('office_open', { path: pathValue });
            meta.append(open);
          }
        }
        row.append(meta);
        body.append(row);
      }
      card.append(body);
      list.append(card);
    }
  }

  async function openExternalChange(entry, button) {
    const sessionId = state.currentSession?.id;
    if (!sessionId) return toast(t('toast.noSession'), 'err');
    const original = button && button.textContent;
    if (button) { button.disabled = true; button.textContent = t('changes.openingExternal'); }
    try {
      const body = { sessionId, turnSeq: Number(entry.turnSeq), action: entry.action === 'open' ? 'open' : 'diff' };
      if (entry.entrySeq !== undefined && entry.entrySeq !== null) body.entrySeq = Number(entry.entrySeq);
      const result = await api('/api/checkpoints/open-external', { method: 'POST', body: JSON.stringify(body) });
      const first = result && Array.isArray(result.opened) ? result.opened[0] : null;
      const app = first && first.editor || t('changes.localEditor');
      const count = result && Array.isArray(result.opened) ? result.opened.length : 1;
      if (first && first.mode === 'diff' && first.diffSupported !== false) {
        toast(t('toast.externalDiffOpened', { app, count }));
      } else {
        toast(t('toast.externalDiffFallback', { app }));
      }
      if (result && Array.isArray(result.failed) && result.failed.length) {
        toast(t('toast.externalDiffPartial', { count: result.failed.length }), 'err');
      }
    } catch (error) {
      toast(t('toast.externalDiffFailed', { err: apiErrText(error) }), 'err');
    } finally {
      if (button) { button.disabled = false; button.textContent = original; }
    }
  }

  function createChangeDiffWindow(entry) {
    let popup = null;
    try {
      popup = window.open('', '_blank', 'popup=yes,width=1100,height=780,resizable=yes,scrollbars=yes');
    } catch {
      // 弹窗被浏览器阻止时回退到当前页预览。
    }
    if (!popup) return null;
    try {
      const popupDocument = popup.document;
      const root = document.documentElement;
      popupDocument.documentElement.setAttribute('data-theme', root.getAttribute('data-theme') || 'dark');
      popupDocument.documentElement.setAttribute('data-ui-mode', root.getAttribute('data-ui-mode') || 'pro');
      popupDocument.title = `${fileBasename(entry.path)} · ${t('changes.viewDiff')}`;
      const charset = popupDocument.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      const viewport = popupDocument.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'width=device-width, initial-scale=1';
      const stylesheet = popupDocument.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('styles.css', window.location.href).href;
      popupDocument.head.replaceChildren(charset, viewport, popupDocument.createElement('title'), stylesheet);
      popupDocument.head.querySelector('title').textContent = popupDocument.title;
      const page = popupDocument.createElement('main');
      page.className = 'change-diff-page';
      const host = popupDocument.createElement('section');
      host.className = 'changes-preview change-diff-standalone';
      page.appendChild(host);
      popupDocument.body.replaceChildren(page);
      popup.focus();
      return { popup, host };
    } catch {
      try { popup.close(); } catch { /* ignore */ }
      return null;
    }
  }

  async function openChangeDiff(entry) {
    const sessionId = state.currentSession?.id;
    if (!sessionId) return;
    const standalone = createChangeDiffWindow(entry);
    const box = standalone?.host || $('changesPreview');
    if (!box) return;
    box.classList.remove('hidden');
    box.textContent = '';
    box.append(el('div', 'cdiff-note muted', t('changes.loadingDiff')));
    if (!standalone) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let diff = null;
    try {
      diff = await api(`/api/checkpoints/diff?sessionId=${encodeURIComponent(sessionId)}&turnSeq=${Number(entry.turnSeq)}&entrySeq=${Number(entry.entrySeq)}`);
    } catch (error) {
      box.textContent = '';
      box.append(el('div', 'cdiff-note muted', t('changes.diffLoadFailed') + apiErrText(error)));
      return;
    }
    if (standalone && standalone.popup.closed) return;
    box.textContent = '';
    renderChangeDiffInto(box, diff, entry, standalone);
  }

  function renderChangeDiffInto(box, diffData, entry, standalone) {
    const head = el('div', 'cdiff-head');
    head.append(el('span', 'cdiff-name', fileBasename(entry.path)));
    if (entry.op !== 'delete') {
      const open = el('button', 'link-mini', t('changes.openCurrentFile'));
      open.onclick = () => openExternalChange({ ...entry, action: 'open' }, open);
      head.append(open);
    }
    const close = el('button', 'link-mini', standalone ? t('common.close') : t('changes.collapse'));
    close.onclick = () => standalone ? standalone.popup.close() : box.classList.add('hidden');
    head.append(close);
    box.append(head);
    if (!diffData || diffData.ok === false) {
      box.append(el('div', 'cdiff-note muted', t('changes.diffUnavailable', {
        err: (diffData && diffData.error) || t('common.unknown'),
      })));
      return;
    }
    if (diffData.skipped) {
      box.append(el('div', 'cdiff-note muted', t('changes.diffSkipped')));
      return;
    }
    if (!diffData.isText) {
      const before = Number.isFinite(diffData.beforeBytes) ? fmtBytes(diffData.beforeBytes) : '—';
      const after = Number.isFinite(diffData.afterBytes) ? fmtBytes(diffData.afterBytes) : '—';
      box.append(el('div', 'cdiff-note muted', t('changes.diffBinary', { before, after })));
      if (diffData.op !== 'delete') {
        const open = el('button', 'mini', t('changes.openFileView'));
        open.onclick = () => runTool('office_open', { path: entry.path });
        box.append(open);
      }
      return;
    }
    const diff = crudeLineDiff(diffData.before || '', diffData.after || '');
    box.append(el('div', 'cdiff-note muted', `+${diff.added.length} 行 / −${diff.removed.length} 行`));
    const body = el('div', 'cdiff-body');
    const addLine = (className, gutter, text) => {
      const line = el('div', 'cdiff-line ' + className);
      line.append(el('span', 'cdiff-gutter', gutter));
      line.append(el('span', 'cdiff-text', text));
      body.append(line);
    };
    for (const line of diff.ctxBefore) addLine('ctx', ' ', line);
    for (const line of diff.removed) addLine('del', '−', line);
    for (const line of diff.added) addLine('add', '+', line);
    for (const line of diff.ctxAfter) addLine('ctx', ' ', line);
    if (!diff.removed.length && !diff.added.length) {
      const unchanged = el('div', 'cdiff-line ctx');
      unchanged.append(el('span', 'cdiff-text', t('common.noChange')));
      body.append(unchanged);
    }
    box.append(body);
  }

  function confirmRollbackEntry(entry, fullPath, button) {
    const turnSeq = Number(entry.turnSeq);
    const entrySeq = Number(entry.entrySeq);
    const body = el('div', 'confirm-body');
    body.append(el('p', '', t('changes.confirmRollbackBody', {
      path: fileBasename(fullPath),
      turn: turnSeq || 0,
    })));
    const foot = el('div', 'confirm-foot');
    const cancel = el('button', '', t('common.cancel'));
    const confirm = el('button', 'primary', t('changes.revert'));
    foot.append(cancel, confirm);
    const modal = buildModal(t('changes.confirmRollbackTitle'), body, foot);
    cancel.onclick = () => modal.close();
    confirm.onclick = async () => {
      modal.close();
      await rollbackChangeEntry(turnSeq, entrySeq, fullPath, button);
    };
  }

  async function rollbackChangeEntry(turnSeq, entrySeq, fullPath, button) {
    const sessionId = state.currentSession?.id;
    if (!sessionId) {
      toast(t('toast.noSession'), 'err');
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = t('changes.reverting');
    }
    try {
      const result = await api('/api/checkpoints/rollback', {
        method: 'POST',
        body: JSON.stringify({ sessionId, turnSeq, entrySeq }),
      });
      if (!result || !result.ok || (result.failed || []).length) {
        if (button) {
          button.disabled = false;
          button.textContent = t('changes.revertTitle');
        }
        const reason = (result && result.error)
          || (result && result.failed && result.failed[0] && result.failed[0].reason)
          || t('common.unknownError');
        toast(t('toast.rollbackFail', { p1: reason }), 'err');
        return;
      }
      toast(t('toast.rollbackDone', { p1: fileBasename(fullPath) }), 'ok');
      loadChanges();
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = t('changes.revertTitle');
      }
      toast(t('toast.rollbackFail', { p1: apiErrText(error) }), 'err');
    }
  }

  function bindArtifactChanges() {
    const artifactRefresh = $('artifactsRefreshBtn');
    if (artifactRefresh) artifactRefresh.onclick = renderArtifactsGallery;
    const changesRefresh = $('changesRefreshBtn');
    if (changesRefresh) changesRefresh.onclick = loadChanges;
  }

  function refreshLocalizedArtifactChanges() {
    if (document.querySelector('.tool-tabs button.active')?.dataset.tab === 'artifacts') {
      renderArtifactsFromState();
    }
  }

  return Object.freeze({
    bindArtifactChanges,
    loadChanges,
    refreshLocalizedArtifactChanges,
    renderArtifactsGallery,
  });
}
