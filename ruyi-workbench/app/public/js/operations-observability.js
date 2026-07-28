'use strict';

// EC-D 第59波：运维可观测域（审计、存储与性能指标）。
//
// 三个面板都遵循「打开时懒加载、手动刷新、缓存重绘、无轮询」的生命周期，
// 由同一模块持有加载状态，避免组合根直接读写各面板的内部状态。
import { $, el, fmtBytes, toast } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { getLocale, t } from './i18n.js';

const STORAGE_STORE_KEYS = [
  'logs',
  'sessions',
  'checkpoints',
  'agentRuns',
  'webcache',
  'uploads',
  'usage',
  'memory',
  'playbooks',
  'skills',
  'generated',
  'agentWorkflows',
  'agentWorktrees',
];

export function formatObservabilityTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleString(getLocale());
}

export function createOperationsObservabilityDomain({
  apiErrText = fallbackApiErrText,
} = {}) {
  const auditState = { entries: [], sources: null, loaded: false, loading: false };
  const storageState = { loaded: false, loading: false, data: null };
  const metricsState = { loaded: false, loading: false, data: null };

  async function loadAudit() {
    if (auditState.loading) return;
    auditState.loading = true;
    const list = $('auditList');
    if (list && !auditState.loaded) {
      list.textContent = '';
      list.appendChild(el('div', 'audit-empty', t('audit.loading')));
    }
    try {
      const result = await api('/api/audit?limit=200');
      auditState.entries = Array.isArray(result.entries) ? result.entries : [];
      auditState.sources = result.sources || null;
      auditState.loaded = true;
    } catch (error) {
      auditState.entries = [];
      auditState.sources = null;
      if (list) {
        list.textContent = '';
        list.appendChild(el('div', 'audit-empty', t('audit.loadFailed', { reason: apiErrText(error) })));
      }
      auditState.loading = false;
      return;
    }
    auditState.loading = false;
    renderAuditList();
  }

  function renderAuditList() {
    const list = $('auditList');
    if (!list) return;
    list.textContent = '';
    if (auditState.sources && auditState.sources.desktop === 'unavailable') {
      list.appendChild(el('div', 'audit-note', t('audit.desktopUnavailable')));
    }
    const sourceFilter = $('auditSourceFilter')?.value || '';
    const typeFilter = ($('auditTypeFilter')?.value || '').trim().toLowerCase();
    const rows = auditState.entries.filter(entry => {
      if (sourceFilter && entry.source !== sourceFilter) return false;
      if (typeFilter && !String(entry.type || '').toLowerCase().includes(typeFilter)) return false;
      return true;
    });
    if (!rows.length) {
      list.appendChild(el('div', 'audit-empty', t('audit.empty')));
      return;
    }
    for (const entry of rows) {
      const row = el('div', 'audit-row');
      const head = el('div', 'audit-head');
      head.appendChild(el('span', 'audit-time', formatObservabilityTime(entry.ts)));
      const badge = el('span', 'audit-badge ' + (entry.source === 'desktop' ? 'src-desktop' : 'src-workbench'));
      badge.appendChild(el('span', 'audit-dot'));
      badge.appendChild(el('span', null, entry.source === 'desktop'
        ? t('audit.source.desktop')
        : t('audit.source.workbench')));
      head.appendChild(badge);
      head.appendChild(el('span', 'audit-type', String(entry.type || '')));
      head.appendChild(el('span', 'audit-summary', String(entry.summary || '')));
      head.appendChild(el('span', 'audit-caret', '▸'));
      row.appendChild(head);
      let detail = null;
      head.onclick = () => {
        if (row.classList.contains('open')) {
          row.classList.remove('open');
          if (detail) {
            detail.remove();
            detail = null;
          }
          return;
        }
        row.classList.add('open');
        detail = el('pre', 'audit-detail');
        try {
          detail.textContent = JSON.stringify(entry.detail, null, 2);
        } catch {
          detail.textContent = String(entry.detail);
        }
        row.appendChild(detail);
      };
      list.appendChild(row);
    }
  }

  function applyStoragePolicyToForm(policy) {
    if (!policy) return;
    const logs = $('storagePolicyLogsDays');
    const compress = $('storagePolicyCompressDays');
    const webcache = $('storagePolicyWebcacheMax');
    const transcripts = $('storagePolicyTranscriptDays');
    if (logs) logs.value = policy.logsKeepDays;
    if (compress) compress.value = policy.agentRunEventsCompressDays;
    if (webcache) webcache.value = policy.webcacheMaxEntries;
    if (transcripts) transcripts.value = policy.engineTranscriptDays;
  }

  async function loadStorage() {
    if (storageState.loading) return;
    storageState.loading = true;
    const host = $('storageSummary');
    if (host && !storageState.loaded) {
      host.textContent = '';
      host.appendChild(el('div', 'audit-empty', t('storage.loading')));
    }
    try {
      const result = await api('/api/storage/summary');
      storageState.data = result;
      storageState.loaded = true;
      applyStoragePolicyToForm(result && result.policy);
    } catch (error) {
      storageState.data = null;
      storageState.loaded = true;
      if (host) {
        host.textContent = '';
        host.appendChild(el('div', 'audit-empty', t('storage.loadFailed', { err: apiErrText(error) })));
      }
      storageState.loading = false;
      return;
    }
    storageState.loading = false;
    renderStorage(storageState.data);
  }

  function renderStorage(data) {
    const host = $('storageSummary');
    if (!host) return;
    host.textContent = '';
    if (!data || data.ok === false) {
      host.appendChild(el('div', 'audit-empty', t('storage.unavailable')));
      return;
    }
    const total = el('div', 'storage-total');
    total.appendChild(el('span', 'storage-total-label', t('storage.totalLabel')));
    total.appendChild(el('span', 'storage-total-value', fmtBytes(data.totalBytes)));
    host.appendChild(total);
    const table = el('div', 'storage-table');
    const stores = data.stores || {};
    for (const key of STORAGE_STORE_KEYS) {
      const store = stores[key];
      if (!store) continue;
      const row = el('div', 'storage-row');
      row.appendChild(el('span', 'storage-name', t('storage.store.' + key)));
      row.appendChild(el('span', 'storage-bytes', fmtBytes(store.bytes) + (store.truncated ? '+' : '')));
      row.appendChild(el('span', 'storage-files muted', t('storage.fileCount', { n: store.files })));
      table.appendChild(row);
    }
    host.appendChild(table);
    if (data.engineTranscripts) {
      const transcripts = data.engineTranscripts;
      host.appendChild(el('div', 'storage-note muted', t('storage.transcriptNote', {
        bytes: fmtBytes(transcripts.bytes),
        n: transcripts.files,
      })));
    }
    if (data.sweep && data.sweep.lastAt) {
      const last = data.sweep.lastResult || {};
      host.appendChild(el('div', 'storage-note muted', t('storage.lastSweepNote', {
        when: formatObservabilityTime(data.sweep.lastAt),
        bytes: fmtBytes(last.freedBytes || 0),
        n: last.actions || 0,
      })));
    }
  }

  async function saveStoragePolicy() {
    const body = {
      logsKeepDays: Number($('storagePolicyLogsDays')?.value),
      agentRunEventsCompressDays: Number($('storagePolicyCompressDays')?.value),
      webcacheMaxEntries: Number($('storagePolicyWebcacheMax')?.value),
      engineTranscriptDays: Number($('storagePolicyTranscriptDays')?.value),
    };
    try {
      const result = await api('/api/storage/policy', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      applyStoragePolicyToForm(result && result.policy);
      toast(t('toast.policySaved'), 'ok');
    } catch (error) {
      toast(t('toast.policySaveFail', { err: apiErrText(error) }), 'err');
    }
  }

  async function cleanStorage() {
    const button = $('storageCleanBtn');
    if (button) button.disabled = true;
    try {
      const result = await api('/api/storage/clean', {
        method: 'POST',
        body: JSON.stringify({ target: 'all' }),
      });
      const actions = Array.isArray(result && result.actions) ? result.actions.length : 0;
      toast(actions
        ? t('storage.cleanDone', { bytes: fmtBytes(result.freedBytes), n: actions })
        : t('storage.cleanNothing'), 'ok');
    } catch (error) {
      toast(t('toast.cleanFail', { err: apiErrText(error) }), 'err');
    }
    if (button) button.disabled = false;
    storageState.loaded = false;
    loadStorage();
  }

  async function loadMetrics() {
    if (metricsState.loading) return;
    metricsState.loading = true;
    const host = $('metricsPanel');
    if (host && !metricsState.loaded) {
      host.textContent = '';
      host.appendChild(el('div', 'audit-empty', t('metrics.loading')));
    }
    try {
      metricsState.data = await api('/api/metrics');
      metricsState.loaded = true;
    } catch (error) {
      metricsState.data = null;
      metricsState.loaded = true;
      if (host) {
        host.textContent = '';
        host.appendChild(el('div', 'audit-empty', t('metrics.loadFailed', { err: apiErrText(error) })));
      }
      metricsState.loading = false;
      return;
    }
    metricsState.loading = false;
    renderMetrics(metricsState.data);
  }

  function renderMetrics(data) {
    const host = $('metricsPanel');
    if (!host) return;
    host.textContent = '';
    if (!data || data.ok === false) {
      host.appendChild(el('div', 'audit-empty', t('metrics.unavailable')));
      return;
    }
    const memory = data.memory || {};
    const memoryRow = el('div', 'storage-row');
    memoryRow.appendChild(el('span', 'storage-name', t('metrics.processLabel')));
    memoryRow.appendChild(el('span', 'storage-bytes', fmtBytes(memory.rssOs || memory.rss || 0)));
    const uptime = Number(data.uptimeSec) || 0;
    const uptimeText = uptime >= 3600
      ? Math.floor(uptime / 3600) + t('metrics.hours') + Math.floor((uptime % 3600) / 60) + t('metrics.mins')
      : uptime >= 60
        ? Math.floor(uptime / 60) + t('metrics.minsWithSpace') + (uptime % 60) + t('metrics.secs')
        : uptime + t('metrics.secs');
    memoryRow.appendChild(el('span', 'storage-files muted', t('metrics.uptimeLabel', { dur: uptimeText })));
    host.appendChild(memoryRow);

    for (const child of (Array.isArray(data.children) ? data.children : [])) {
      const row = el('div', 'storage-row');
      row.appendChild(el('span', 'storage-name', child.kind === 'engine-turn'
        ? t('metrics.childEngineTurn')
        : t('metrics.childMcpBridge')));
      row.appendChild(el('span', 'storage-bytes', child.rss ? fmtBytes(child.rss) : '—'));
      row.appendChild(el('span', 'storage-files muted', 'pid ' + child.pid + (child.ref ? ' · ' + child.ref : '')));
      host.appendChild(row);
    }

    const requests = data.requests || { total: 0, buckets: [0, 0, 0, 0, 0, 0], slowest: [] };
    host.appendChild(el('div', 'storage-note muted', t('metrics.reqDistLabel', { n: requests.total })));
    const edges = ['<10ms', '<50ms', '<200ms', '<1s', '<5s', '≥5s'];
    const buckets = Array.isArray(requests.buckets) ? requests.buckets : [];
    const maxBucket = Math.max(1, ...buckets);
    const bars = el('div', 'metrics-bars');
    buckets.forEach((count, index) => {
      const row = el('div', 'metrics-bar-row');
      row.appendChild(el('span', 'metrics-bar-label', edges[index] || ''));
      const track = el('span', 'metrics-bar-track');
      const fill = el('span', 'metrics-bar-fill');
      fill.style.width = Math.round((count / maxBucket) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'metrics-bar-count muted', String(count)));
      bars.appendChild(row);
    });
    host.appendChild(bars);

    if (requests.slowest && requests.slowest.length) {
      host.appendChild(el('div', 'storage-note muted', t('metrics.slowestLabel')));
      const table = el('div', 'storage-table');
      for (const request of requests.slowest) {
        const row = el('div', 'storage-row');
        row.appendChild(el('span', 'storage-name', request.m + ' ' + request.p));
        row.appendChild(el('span', 'storage-bytes', request.ms + ' ms'));
        table.appendChild(row);
      }
      host.appendChild(table);
    }

    const trend = Array.isArray(data.storageTrend) ? data.storageTrend : [];
    if (trend.length) {
      host.appendChild(el('div', 'storage-note muted', t('metrics.storageTrendLabel')));
      const table = el('div', 'storage-table');
      for (const point of trend.slice(-12).reverse()) {
        const row = el('div', 'storage-row');
        row.appendChild(el('span', 'storage-name', formatObservabilityTime(point.ts)));
        row.appendChild(el('span', 'storage-bytes', fmtBytes(point.totalBytes)));
        row.appendChild(el('span', 'storage-files muted', point.engineBytes
          ? t('metrics.engineTranscriptPrefix', { bytes: fmtBytes(point.engineBytes) })
          : ''));
        table.appendChild(row);
      }
      host.appendChild(table);
    }
  }

  function openAuditTab() {
    if (!auditState.loaded) loadAudit();
    else renderAuditList();
  }

  function openStorageTab() {
    if (!storageState.loaded) loadStorage();
    else renderStorage(storageState.data);
    if (!metricsState.loaded) loadMetrics();
    else renderMetrics(metricsState.data);
  }

  function bindOperationsObservability() {
    const auditRefresh = $('auditRefreshBtn');
    if (auditRefresh) auditRefresh.onclick = () => {
      auditState.loaded = false;
      loadAudit();
    };
    const storageRefresh = $('storageRefreshBtn');
    if (storageRefresh) storageRefresh.onclick = () => {
      storageState.loaded = false;
      loadStorage();
    };
    const metricsRefresh = $('metricsRefreshBtn');
    if (metricsRefresh) metricsRefresh.onclick = () => {
      metricsState.loaded = false;
      loadMetrics();
    };
    const clean = $('storageCleanBtn');
    if (clean) clean.onclick = cleanStorage;
    const savePolicy = $('storagePolicySaveBtn');
    if (savePolicy) savePolicy.onclick = saveStoragePolicy;
    const sourceFilter = $('auditSourceFilter');
    if (sourceFilter) sourceFilter.onchange = renderAuditList;
    const typeFilter = $('auditTypeFilter');
    if (typeFilter) typeFilter.oninput = renderAuditList;
  }

  function refreshLocalizedObservability() {
    if (auditState.loaded) renderAuditList();
    if (storageState.data) renderStorage(storageState.data);
    if (metricsState.data) renderMetrics(metricsState.data);
  }

  return Object.freeze({
    bindOperationsObservability,
    openAuditTab,
    openStorageTab,
    refreshLocalizedObservability,
  });
}
