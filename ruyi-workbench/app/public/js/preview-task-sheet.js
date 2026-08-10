'use strict';

export function pendingCount(pending) {
  return ['permissions', 'questions', 'plans', 'pool']
    .reduce((sum, key) => sum + Math.max(0, Number(pending && pending[key]) || 0), 0);
}

export function taskProgress(card, snapshot = null) {
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

export function acceptanceItems(snapshot) {
  const source = Array.isArray(snapshot && snapshot.acceptance && snapshot.acceptance.items)
    ? snapshot.acceptance.items : [];
  return source.map((item, index) => ({
    id: String(item && item.id || `item-${index + 1}`),
    desc: String(item && item.desc || '').trim(),
    status: ['done', 'blocked', 'pending'].includes(String(item && item.status)) ? String(item.status) : 'pending',
    evidence: String(item && item.evidence || '').trim(),
    checkType: String(item && item.checkType || 'none'),
  }));
}

export function activeAcceptanceIndex(items) {
  const list = Array.isArray(items) ? items : [];
  const pending = list.findIndex(item => item && item.status === 'pending');
  if (pending >= 0) return pending;
  return list.findIndex(item => item && item.status === 'blocked');
}

export function elapsedLabel(startedAt, current = new Date()) {
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt || ''));
  const end = current instanceof Date ? current.getTime() : Date.parse(String(current || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
