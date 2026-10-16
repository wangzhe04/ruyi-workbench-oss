'use strict';

// Presentation facts only: neither read failures nor run faults change business state.
export function runFaults(run, nodeStatus = node => node.status) {
  if (!run) return [];
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const faults = [];
  if (run.persistenceDegraded === true) faults.push({ kind: 'persistence' });
  const idle = nodes.find(node => node && node.idleAborted === true);
  if (run.idleAborted === true || idle) faults.push({ kind: 'idle', nodeId: idle?.id });
  const blocked = run.live === true ? nodes.filter(node => node && nodeStatus(node) === 'waiting_resource' && Array.isArray(node.resourceBlockers) && node.resourceBlockers.length) : [];
  if (blocked.length) faults.push({ kind: 'resource', count: blocked.length, nodeId: blocked[0].id });
  return faults;
}

export function readQualitySignature(quality) {
  if (!quality) return '';
  const failed = Object.entries(quality.perRun || {}).filter(([, row]) => row.state !== 'ok');
  return JSON.stringify([quality.state, quality.state === 'failed' ? quality.lastSuccessAt : 0, failed]);
}

export function hasReadFailure(quality) {
  return quality?.state === 'failed' || Object.values(quality?.perRun || {}).some(row => row.state !== 'ok');
}

export function hasReadNotice(quality) {
  return quality?.state === 'loading' || hasReadFailure(quality);
}

const identified = row => row && typeof row === 'object' && typeof row.id === 'string' && !!row.id.trim() && typeof row.status === 'string' && !!row.status.trim();
const objects = rows => Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && !Array.isArray(row));
const flagsValid = row => ['live', 'paused', 'persistenceDegraded', 'idleAborted'].every(key => row[key] === undefined || typeof row[key] === 'boolean');
export function validRunSnapshot(run, id) {
  if (!identified(run) || (id && run.id !== id) || !flagsValid(run) || !Array.isArray(run.nodes) || !run.nodes.every(identified)) return false;
  // These collections are optional on historical snapshots, but malformed rows must not reach renderers.
  if (['taskPool', 'messages'].some(key => run[key] !== undefined && !objects(run[key]))) return false;
  return run.nodes.every(node => ['progressLog', 'resourceBlockers'].every(key => node[key] === undefined || objects(node[key])));
}

export function validRunList(value, full) {
  return value?.ok === true && Array.isArray(value.runs) && value.runs.every(row => full ? validRunSnapshot(row) : identified(row) && flagsValid(row) && typeof row.live === 'boolean' && Number.isSafeInteger(row.eventSeq) && row.eventSeq >= 0);
}

export function validRunEvents(value) {
  return value?.ok === true && Array.isArray(value.events) && value.events.every(row => {
    if (!row || !Number.isSafeInteger(row.seq) || row.seq <= 0 || typeof row.type !== 'string' || !row.type) return false;
    if (['node_start', 'node_progress'].includes(row.type) && (typeof row.nodeId !== 'string' || !row.nodeId)) return false;
    return row.type !== 'node_progress' || (row.data && typeof row.data.text === 'string');
  });
}

export function appendReadHealth(host, quality, { el, t, locale }) {
  if (!hasReadNotice(quality)) return;
  const box = el('div', 'workflow-read-health');
  box.setAttribute('role', 'status');
  const append = (key, row, id = '') => {
    const line = el('div', 'workflow-read-line');
    line.appendChild(el('span', '', t(key, { id })));
    if (row?.lastSuccessAt) line.appendChild(el('span', 'workflow-health-time', t('workflow.health.lastRead', { time: new Date(row.lastSuccessAt).toLocaleString(locale) })));
    box.appendChild(line);
  };
  if (quality.state === 'loading') append('workflow.health.loading', quality);
  if (quality.state === 'failed') append(quality.lastSuccessAt ? 'workflow.health.listStale' : 'workflow.health.listUnavailable', quality);
  for (const [id, row] of Object.entries(quality.perRun || {})) {
    if (row.state !== 'ok') append(row.state === 'unavailable' ? 'workflow.health.detailUnavailable' : 'workflow.health.detailStale', row, row.digest?.title || id);
  }
  host.appendChild(box);
}

export function appendRunFaults(host, run, { el, t, nodeStatus, onView }) {
  const faults = runFaults(run, nodeStatus);
  if (!faults.length) return;
  const box = el('div', 'workflow-run-health'); box.setAttribute('role', 'status');
  for (const fault of faults) {
    const line = el('div', 'workflow-health-line'); line.dataset.healthKind = fault.kind;
    line.appendChild(el('span', '', t('workflow.health.' + fault.kind, { count: fault.count })));
    if (fault.nodeId && onView) {
      const view = el('button', 'mini', t('workflow.health.viewMember'));
      view.dataset.healthNode = fault.nodeId; view.dataset.fk = `health:${fault.kind}:${fault.nodeId}`;
      view.onclick = () => onView(fault.nodeId);
      line.appendChild(view);
    }
    box.appendChild(line);
  }
  host.appendChild(box);
}
