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
