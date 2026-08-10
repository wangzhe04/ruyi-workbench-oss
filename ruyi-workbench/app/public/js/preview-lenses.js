'use strict';

export function hasCrewActivity(snapshot) {
  const runs = Array.isArray(snapshot && snapshot.runs) ? snapshot.runs : [];
  return runs.some(run => (Array.isArray(run?.nodes) && run.nodes.length) || (Array.isArray(run?.proposals) && run.proposals.length));
}

export function defaultLensForState(state, snapshot) {
  if (state === 'running' && hasCrewActivity(snapshot)) return '现场';
  return state === 'done' || state === 'stopped' ? '结果' : '现场';
}
