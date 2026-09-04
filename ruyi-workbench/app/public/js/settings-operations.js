'use strict';

// EC-D 第58波：设置域中的运维子域（更新中心 + MCP 运维）。
//
// 两块功能共享“设置页签内的远程读写 + 状态渲染”边界，但不应继续占用 app.js
// 的全局作用域。基础能力直接依赖稳定模块；结构化 API 错误翻译与已有 MCP 导入器
// 由组合根注入，避免反向依赖 app.js。
import { $, el, toast } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { t } from './i18n.js';

export function createSettingsOperationsDomain({
  apiErrText = fallbackApiErrText,
  importMcpFromFolder = async () => {},
  // 118a: 「重新打开引导」。组合根注入与两壳同一个 onboarding-wizard.js 实例。
  openOnboarding = () => {},
} = {}) {
  let overlayZipPath = '';
  let mcpConnectorCache = [];

  /* ---------------- 更新中心 ---------------- */
  function renderOverlayResult(className, text, withRecovery = false) {
    const host = $('ovResult');
    if (!host) return;
    const status = el('span', className, String(text || ''));
    if (!withRecovery) {
      host.replaceChildren(status);
      return;
    }
    const recover = el('button', 'mini', t('settings.update.rollback'));
    recover.type = 'button';
    recover.onclick = overlayRollback;
    host.replaceChildren(status, document.createTextNode(' '), recover);
  }

  async function refreshOverlayStatus() {
    try {
      const status = await api('/api/overlay/status');
      const current = $('ovCurrent');
      const hint = $('ovCurrentHint');
      const audit = $('ovAudit');
      if (status.current) {
        current.textContent = `v${status.current.version}  ·  ${new Date(status.current.appliedAt).toLocaleString()}`;
        hint.textContent = status.backups && status.backups.length
          ? t('settings.update.backupsCount', { p1: status.backups.length })
          : t('settings.update.noBackups');
      } else {
        current.textContent = t('settings.update.notApplied');
        hint.textContent = '';
      }
      if (audit) {
        const entries = Array.isArray(status.audit) ? status.audit : [];
        if (!entries.length) {
          audit.textContent = t('settings.update.noAudit');
        } else {
          const fragment = document.createDocumentFragment();
          for (const entry of entries.slice().reverse()) {
            const version = entry.version ? ` v${String(entry.version)}` : '';
            const error = entry.error ? `  (${String(entry.error)})` : '';
            fragment.appendChild(el('div', '', `#${entry.seq} ${String(entry.action)}${version} -> ${String(entry.result)}${error}`));
          }
          audit.replaceChildren(fragment);
        }
      }
    } catch { /* status 失败不阻断 UI */ }
  }

  async function overlayPickZip() {
    try {
      const result = await api('/api/pick-file', {
        method: 'POST',
        body: JSON.stringify({ filter: 'Zip 包 (*.zip)|*.zip|所有文件|*.*' }),
      });
      if (!result || result.cancelled) return;
      if (!result.ok) {
        toast(result.error || t('settings.update.pickFailed'), 'err');
        return;
      }
      overlayZipPath = result.path;
      const pathLabel = $('ovZipPath'); if (pathLabel) pathLabel.textContent = result.path;
      const applyButton = $('ovApplyBtn'); if (applyButton) applyButton.disabled = true;
      const precheckHint = $('ovPrecheckHint'); if (precheckHint) precheckHint.textContent = '';
      const preview = $('ovPreviewBox'); if (preview) preview.style.display = 'none';
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
  }

  async function overlayPrecheck() {
    if (!overlayZipPath) {
      toast(t('settings.update.pickFirst'), 'err');
      return;
    }
    const hint = $('ovPrecheckHint'); if (hint) hint.textContent = t('settings.update.prechecking');
    const previewBox = $('ovPreviewBox'); if (previewBox) previewBox.style.display = 'none';
    const applyButton = $('ovApplyBtn'); if (applyButton) applyButton.disabled = true;
    try {
      const result = await api('/api/overlay/precheck', {
        method: 'POST',
        body: JSON.stringify({ zipPath: overlayZipPath }),
      });
      if (result.ok) {
        if (hint) {
          hint.textContent = Array.isArray(result.warnings) && result.warnings.length
            ? result.warnings.join('; ')
            : t('settings.update.precheckOk', { p1: result.version });
        }
        const preview = result.preview || {};
        const setCount = (id, value) => { const target = $(id); if (target) target.textContent = value; };
        setCount('ovNew', (preview.new || []).length);
        setCount('ovOverw', (preview.overwritten || []).length);
        setCount('ovUnch', (preview.unchanged || []).length);
        setCount('ovDel', (preview.deleted || []).length);
        const compat = $('ovCompat');
        if (compat) compat.textContent = t('settings.update.compatInfo', { p1: result.hostVersion || '?', p2: result.minHostVersion || '?' });
        const errors = $('ovErrors');
        if (errors) { errors.style.display = 'none'; errors.textContent = ''; }
        const enabledApply = $('ovApplyBtn'); if (enabledApply) enabledApply.disabled = false;
      } else {
        if (hint) hint.textContent = t('settings.update.precheckFailed');
        const errors = $('ovErrors');
        if (errors) { errors.style.display = 'block'; errors.textContent = (result.errors || []).join('; '); }
        const disabledApply = $('ovApplyBtn'); if (disabledApply) disabledApply.disabled = true;
      }
      if (previewBox) previewBox.style.display = 'block';
    } catch (error) {
      if (hint) hint.textContent = t('settings.update.precheckFailed') + ': ' + apiErrText(error);
    }
  }

  async function overlayApply() {
    if (!overlayZipPath) {
      toast(t('settings.update.pickFirst'), 'err');
      return;
    }
    const forceCheckbox = $('ovForceChk');
    const force = Boolean(forceCheckbox && forceCheckbox.checked);
    const applyButton = $('ovApplyBtn');
    if (applyButton) { applyButton.disabled = true; applyButton.textContent = t('settings.update.applying'); }
    const resultBox = $('ovResultBox'); if (resultBox) resultBox.style.display = 'none';
    try {
      const result = await api('/api/overlay/apply', {
        method: 'POST',
        body: JSON.stringify({ zipPath: overlayZipPath, force }),
      });
      if (resultBox) resultBox.style.display = 'block';
      if (result.ok) {
        renderOverlayResult('ok', t('settings.update.applyOk', { p1: String(result.version) }));
        toast(t('settings.update.restartNeeded'), 'ok');
        if (applyButton) { applyButton.disabled = false; applyButton.textContent = t('settings.update.apply'); }
        refreshOverlayStatus();
      } else if (result.idempotent) {
        renderOverlayResult('warn', t('settings.update.idempotent'));
        if (applyButton) { applyButton.disabled = false; applyButton.textContent = t('settings.update.apply'); }
      } else if (result.rejected) {
        renderOverlayResult('err', t('settings.update.precheckFailed') + ': ' + (result.errors || []).join('; '));
        if (applyButton) { applyButton.disabled = false; applyButton.textContent = t('settings.update.apply'); }
      } else {
        const error = result.error || (result.verify && result.verify.mismatches && result.verify.mismatches.length
          ? result.verify.mismatches.join('; ')
          : t('settings.update.applyFailed'));
        renderOverlayResult('err', t('settings.update.applyFailed') + ': ' + String(error), true);
        if (applyButton) { applyButton.disabled = false; applyButton.textContent = t('settings.update.apply'); }
        toast(t('settings.update.applyFailed'), 'err');
      }
    } catch (error) {
      renderOverlayResult('err', apiErrText(error));
      if (resultBox) resultBox.style.display = 'block';
      if (applyButton) { applyButton.disabled = false; applyButton.textContent = t('settings.update.apply'); }
    }
  }

  async function overlayRollback() {
    const hint = $('ovRollbackHint'); if (hint) hint.textContent = t('settings.update.rollingBack');
    try {
      const result = await api('/api/overlay/rollback', { method: 'POST', body: '{}' });
      if (result.ok) {
        if (hint) hint.textContent = t('settings.update.rolledBack', { p1: result.restored });
        toast(t('settings.update.rolledBackShort'), 'ok');
        refreshOverlayStatus();
      } else {
        if (hint) hint.textContent = result.error || t('settings.update.rollbackFailed');
        toast(result.error || t('settings.update.rollbackFailed'), 'err');
      }
    } catch (error) {
      if (hint) hint.textContent = apiErrText(error);
    }
  }

  /* ---------------- MCP 运维页签 ---------------- */
  const MCP_SOURCE_KEYS = { desktop: 'settings.mcp.source.desktop', config: 'settings.mcp.source.config', 'drop-in': 'settings.mcp.source.dropIn' };
  const MCP_HEALTH_KEYS = { ok: 'settings.mcp.health.ok', degraded: 'settings.mcp.health.degraded', failed: 'settings.mcp.health.failed', disabled: 'settings.mcp.health.disabled' };
  const MCP_CAT_KEYS = { auth: 'settings.mcp.cat.auth', startup: 'settings.mcp.cat.startup', network: 'settings.mcp.cat.network', timeout: 'settings.mcp.cat.timeout', security: 'settings.mcp.cat.security', tool_registration: 'settings.mcp.cat.toolRegistration', protocol: 'settings.mcp.cat.protocol', unknown: 'settings.mcp.cat.unknown' };

  function mcpHealthLampClass(item) {
    if (!item || item.enabled === false) return 'mcp-lamp-disabled';
    const health = item.health;
    if (!health || !health.status) return '';
    if (health.status === 'ok') return 'mcp-lamp-ok';
    if (health.status === 'degraded') return 'mcp-lamp-degraded';
    if (health.status === 'failed') return 'mcp-lamp-failed';
    return 'mcp-lamp-disabled';
  }

  function mcpHealthText(item) {
    if (item && item.enabled === false) return t('settings.mcp.health.disabled');
    const health = item && item.health;
    if (!health || !health.status) return t('settings.mcp.health.unknown');
    const parts = [t(MCP_HEALTH_KEYS[health.status] || 'settings.mcp.health.unknown')];
    if (health.category) parts.push(t(MCP_CAT_KEYS[health.category] || 'settings.mcp.cat.unknown'));
    if (typeof health.toolCount === 'number') parts.push(t('settings.mcp.toolCount', { p1: health.toolCount }));
    if (typeof health.latencyMs === 'number') parts.push(health.latencyMs + 'ms');
    if (health.message) parts.push(String(health.message));
    return parts.join(' · ');
  }

  async function refreshMcpOps(probe) {
    const hint = $('mcpListHint');
    if (hint) hint.textContent = t(probe ? 'settings.mcp.probing' : 'settings.mcp.loading');
    const button = $('mcpRefreshBtn'); if (button) button.disabled = true;
    try {
      const result = await api('/api/mcp/connectors' + (probe ? '?probe=1' : ''));
      mcpConnectorCache = Array.isArray(result.connectors) ? result.connectors : [];
      renderMcpCompat(result.compat);
      renderMcpConnList();
      if (hint) hint.textContent = t('settings.mcp.count', { p1: mcpConnectorCache.length });
    } catch (error) {
      if (hint) hint.textContent = apiErrText(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderMcpCompat(compat) {
    const box = $('mcpCompatBox'); if (!box) return;
    box.textContent = '';
    const entries = compat && typeof compat === 'object' ? Object.values(compat) : [];
    for (const capability of entries) {
      const item = el('div', 'mcp-compat-item');
      const head = el('div'); head.append(el('code', '', String(capability.transport || '')));
      item.append(
        head,
        el('div', 'mcp-compat-line', t('settings.mcp.capabilities') + ': ' + (Array.isArray(capability.capabilities) ? capability.capabilities.join(', ') : '')),
        el('div', 'mcp-compat-line', t('settings.mcp.limitations') + ': ' + (Array.isArray(capability.limitations) ? capability.limitations.join('; ') : '')),
      );
      box.append(item);
    }
  }

  function renderMcpConnList() {
    const list = $('mcpConnList'); if (!list) return;
    list.textContent = '';
    if (!mcpConnectorCache.length) {
      list.append(el('p', 'muted', t('settings.mcp.empty')));
      return;
    }
    for (const item of mcpConnectorCache) list.append(mcpConnItemEl(item));
  }

  function mcpConnItemEl(item) {
    const root = el('div', 'mcp-conn-item');
    const main = el('div', 'mcp-conn-main');
    const title = el('div', 'mcp-conn-title');
    const badgeClass = item.source === 'desktop' ? 'mcp-badge-desktop' : item.source === 'drop-in' ? 'mcp-badge-dropin' : 'mcp-badge-config';
    title.append(
      el('span', ('mcp-lamp ' + mcpHealthLampClass(item)).trim()),
      el('strong', '', String(item.label || item.id || '')),
      el('span', 'mcp-badge ' + badgeClass, t(MCP_SOURCE_KEYS[item.source] || 'settings.mcp.source.config')),
      el('code', 'mcp-transport', String(item.transport || 'stdio')),
      el('span', 'muted', item.enabled === false ? t('settings.mcp.status.disabled') : t('settings.mcp.status.enabled')),
    );
    const sub = el('div', 'mcp-conn-sub'); sub.append(el('code', '', String(item.commandOrUrl || '')));
    const healthData = item.health;
    const healthClass = item.enabled === false || !healthData || !healthData.status
      ? ''
      : healthData.status === 'ok'
        ? 'mcp-health-ok'
        : healthData.status === 'degraded'
          ? 'mcp-health-degraded'
          : healthData.status === 'failed' ? 'mcp-health-failed' : '';
    const health = el('div', 'mcp-conn-health'); health.append(el('span', healthClass, mcpHealthText(item)));
    main.append(title, sub, health);

    const actions = el('div', 'mcp-conn-actions');
    const retest = el('button', 'mini', t('settings.mcp.action.retest')); retest.type = 'button';
    retest.disabled = item.enabled === false;
    if (item.enabled === false) retest.title = t('settings.mcp.retestDisabledHint');
    else retest.onclick = () => mcpRetest(item.id);
    actions.append(retest);

    const toggle = el('button', 'mini', item.enabled === false ? t('settings.mcp.action.enable') : t('settings.mcp.action.disable')); toggle.type = 'button';
    const remove = el('button', 'mini', t('settings.mcp.action.remove')); remove.type = 'button';
    if (item.source !== 'config') {
      const reason = item.source === 'desktop' ? t('settings.mcp.guardDesktop') : t('settings.mcp.guardDropIn');
      toggle.disabled = true; remove.disabled = true; toggle.title = reason; remove.title = reason;
    } else {
      toggle.onclick = () => mcpToggle(item.id, item.enabled !== false);
      remove.onclick = () => mcpRemove(item.id);
    }
    actions.append(toggle, remove);
    root.append(main, actions);
    return root;
  }

  async function mcpRetest(id) {
    try {
      const result = await api('/api/mcp/connectors/health', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      const health = result && result.health;
      const item = mcpConnectorCache.find(connector => connector.id === id);
      if (item && health) item.health = health;
      renderMcpConnList();
      if (health && health.status === 'ok') toast(t('settings.mcp.retestOk', { p1: id, p2: health.toolCount || 0 }), 'ok');
      else if (health) toast(mcpHealthText({ health, enabled: true }), 'err');
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
  }

  async function mcpToggle(id, currentlyEnabled) {
    try {
      const result = await api('/api/mcp/connectors/toggle', {
        method: 'POST',
        body: JSON.stringify({ id, enabled: !currentlyEnabled }),
      });
      if (result && result.ok) {
        toast(t(!currentlyEnabled ? 'settings.mcp.enabledOk' : 'settings.mcp.disabledOk', { p1: id }), 'ok');
        if (result.warning) toast(String(result.warning));
      }
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
    await refreshMcpOps(false);
  }

  async function mcpRemove(id) {
    if (!confirm(t('settings.mcp.removeConfirm', { p1: id }))) return;
    try {
      const result = await api('/api/mcp/connectors', {
        method: 'POST',
        headers: { 'x-http-method': 'DELETE' },
        body: JSON.stringify({ id }),
      });
      if (result && result.ok) {
        toast(t('settings.mcp.removedOk', { p1: id }), 'ok');
        if (result.warning) toast(String(result.warning));
      }
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
    await refreshMcpOps(false);
  }

  function bindSettingsOperations() {
    const refreshMcp = $('mcpRefreshBtn'); if (refreshMcp) refreshMcp.onclick = () => refreshMcpOps(true);
    const importMcp = $('mcpImportBtn');
    if (importMcp) importMcp.onclick = async () => { await importMcpFromFolder(importMcp); refreshMcpOps(false); };
    const pickOverlay = $('ovPickBtn'); if (pickOverlay) pickOverlay.onclick = overlayPickZip;
    const precheckOverlay = $('ovPrecheckBtn'); if (precheckOverlay) precheckOverlay.onclick = overlayPrecheck;
    const applyOverlay = $('ovApplyBtn'); if (applyOverlay) applyOverlay.onclick = overlayApply;
    const rollbackOverlay = $('ovRollbackBtn'); if (rollbackOverlay) rollbackOverlay.onclick = overlayRollback;
    const refreshOverlay = $('ovRefreshBtn'); if (refreshOverlay) refreshOverlay.onclick = refreshOverlayStatus;
    // 118a: 设置 → 基础 里的「重新打开引导」。向导可跳过，也必须可重开。
    const reopenOnboarding = $('reopenOnboardingBtn'); if (reopenOnboarding) reopenOnboarding.onclick = () => openOnboarding();
  }

  return Object.freeze({
    bindSettingsOperations,
    refreshMcpOps,
    refreshOverlayStatus,
  });
}
