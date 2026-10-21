import { api } from './net.js';
import { state } from './state.js';
import { t } from './i18n.js';

// Initial owner setup only. Credentials are downloaded once for the explicitly
// named receiving application, never displayed in the list or kept as a default.
export async function mountMcpConsumers(host) {
  if (!host || host.dataset.mounted || host.dataset.mounting) return;
  host.dataset.mounting = 'true';
  try {
  // Opening settings can race the first status response. Resolve an authoritative
  // default before capturing the displayed grant; never permanently mount empty.
  let grantedWorkspace = state.currentSession?.cwd || state.config?.defaultWorkspace;
  if (!grantedWorkspace) {
    const status = await api('/api/status');
    grantedWorkspace = state.currentSession?.cwd || state.config?.defaultWorkspace || status.config?.defaultWorkspace;
  }
  if (!grantedWorkspace) throw new Error(t('mcpConsumer.required'));
  host.dataset.mounted = 'true';
  const node = (tag, text) => { const item = document.createElement(tag); if (text) item.textContent = text; return item; };
  const title = node('h4', t('mcpConsumer.title')), help = node('p', t('mcpConsumer.help'));
  const applicationLabel = node('label', t('mcpConsumer.application')), application = node('input');
  application.type = 'text'; application.maxLength = 100; application.autocomplete = 'off'; applicationLabel.append(application);
  const writeLabel = node('label', t('mcpConsumer.writes')), writes = node('input'); writes.type = 'checkbox'; writeLabel.prepend(writes); writeLabel.className = 'privacy-check';
  const workspace = node('p'), issue = node('button', t('mcpConsumer.issue')), status = node('p'), list = node('div');
  issue.type = 'button'; status.setAttribute('role', 'status');
  // The exact workspace displayed for this setup action remains its grant source.
  workspace.textContent = t('mcpConsumer.workspace') + ': ' + grantedWorkspace;
  host.append(title, help, applicationLabel, workspace, writeLabel, issue, status, list);
  const call = body => api('/api/mcp/consumers', { method: 'POST', body: JSON.stringify(body) });
  async function refresh() {
    const value = await call({ op: 'list' }); list.replaceChildren();
    for (const consumer of value.consumers) {
      const row = node('div'), label = node('span', consumer.label + ' 路 ' + consumer.workspace), revoke = node('button', t('mcpConsumer.revoke'));
      revoke.type = 'button'; revoke.disabled = !consumer.enabled;
      revoke.onclick = async () => { revoke.disabled = true; try { await call({ op: 'revoke', id: consumer.id }); await refresh(); status.textContent = t('mcpConsumer.revoked'); }
        catch { status.textContent = t('mcpConsumer.failed'); revoke.disabled = false; } };
      row.append(label, revoke); list.append(row);
    }
  }
  issue.onclick = async () => {
    const label = application.value.trim(), root = grantedWorkspace;
    if (!label || !root) { status.textContent = t('mcpConsumer.required'); return; }
    issue.disabled = true;
    try {
      const tools = ['file_read', 'file_list', 'file_search'];
      if (writes.checked) tools.push('file_write', 'file_edit', 'file_copy', 'file_move');
      const value = await call({ op: 'create', label, workspace: root, tools, resources: ['capabilities', 'workspace'] });
      const blob = new Blob([JSON.stringify(value.configuration, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob);
      const download = node('a'); download.href = url; download.download = 'ruyi-mcp-connection.json'; download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // The reusable credential remains only in the user's explicit configuration copy.
      delete value.configuration; status.textContent = t('mcpConsumer.created'); application.value = ''; writes.checked = false; await refresh();
    } catch { status.textContent = t('mcpConsumer.failed'); }
    finally { issue.disabled = false; }
  };
  try { await refresh(); } catch { status.textContent = t('mcpConsumer.failed'); }
  } finally { delete host.dataset.mounting; }
}
