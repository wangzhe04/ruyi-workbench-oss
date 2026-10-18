'use strict';

// 仅请求配置域重读；历史回放不派发，不把一条旧回执当成今天的配置。
export function refreshSettingsAfterReceipt() {
  try { globalThis.dispatchEvent(new CustomEvent('ruyi:settings-refresh')); } catch { /* 无 window 的宿主 */ }
}

// 只投影执行回包或既有行动日志，不把模型的 say / label 当作修改证据。
export function settingsReceiptOf(result) {
  const receipt = result?.ok === true ? result.receipt : null;
  const valid = receipt?.kind === 'settings' && receipt.object === 'ruyi' && Array.isArray(receipt.changes) && receipt.changes.length > 0 && receipt.changes.length <= 32
    && receipt.changes.every(change => change && typeof change.key === 'string' && change.key.length > 0 && Object.hasOwn(change, 'value')
      && ['application', 'steward', 'defaults', 'new_threads'].includes(change.scope)
      && ['next_read', 'next_turn', 'next_wait', 'new_threads'].includes(change.effective));
  return valid ? receipt : null;
}
export function settingsReceiptText(receipt, t) {
  if (!receipt || !Array.isArray(receipt.changes)) return '';
  return receipt.changes.map(change => {
    const value = item => {
      const raw = JSON.stringify(item);
      return raw === undefined ? t('settingsReceipt.unset') : raw.length > 2000 ? raw.slice(0, 2000) + t('settingsReceipt.clipped') : raw;
    };
    return `${change.help || change.key}: ${value(change.before)} → ${value(change.value)}\n${t('settingsReceipt.scope.' + change.scope)} · ${t('settingsReceipt.effective.' + change.effective)}`;
  }).join('\n');
}
export function appendSettingsReceipt(host, result, { t, api, refresh = () => {} }) {
  const receipt = settingsReceiptOf(result);
  if (!host || !receipt) return null;
  const doc = host.ownerDocument;
  const box = doc.createElement('section');
  box.className = 'steward-settings-receipt';
  box.dataset.receipt = 'settings';
  box.setAttribute('aria-label', t('settingsReceipt.title'));
  const text = doc.createElement('p'); text.className = 'steward-receipt';
  text.dataset.receipt = 'action'; text.dataset.receiptState = 'done';
  const paint = () => { text.textContent = t('settingsReceipt.title') + '\n' + settingsReceiptText(receipt, t); };
  paint(); box.appendChild(text);
  const action = result.undoRef?.action;
  if (action?.tool === 'steward_config_set' && action.args?.expected && typeof api === 'function') {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'steward-act';
    button.textContent = t('settingsReceipt.undo');
    const status = doc.createElement('p'); status.className = 'steward-receipt'; status.setAttribute('role', 'status');
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await api('/api/steward/act', { method: 'POST', body: JSON.stringify({ act: { kind: 'tool', tool: action.tool, args: { ...action.args, undo: true } } }) });
        if (response?.ok === true && response.result?.ok === true && settingsReceiptOf(response.result)) {
          status.textContent = t('settingsReceipt.undone') + '\n' + settingsReceiptText(response.result.receipt, t);
          box.dataset.undoState = 'done';
          try { await refresh(); } catch { /* 已收到真实回执，刷新失败不把撤销判失败 */ }
        } else {
          const conflict = response?.result?.error === 'config.conflict';
          status.textContent = t(conflict ? 'settingsReceipt.conflict' : 'settingsReceipt.unconfirmed');
          box.dataset.undoState = conflict ? 'conflict' : 'unknown';
        }
      } catch (error) {
        const conflict = error?.code === 'config.conflict' || error?.info?.code === 'config.conflict';
        status.textContent = t(conflict ? 'settingsReceipt.conflict' : 'settingsReceipt.unconfirmed');
        box.dataset.undoState = conflict ? 'conflict' : 'unknown';
      }
      refreshSettingsAfterReceipt();
      // 不自动重发；旧行仍是历史，现值只从设置页或新的回执读取。
    };
    box.append(button, status);
  } else {
    const note = doc.createElement('p'); note.className = 'steward-receipt'; note.textContent = t('settingsReceipt.noUndo'); box.appendChild(note);
  }
  host.appendChild(box);
  return box;
}
