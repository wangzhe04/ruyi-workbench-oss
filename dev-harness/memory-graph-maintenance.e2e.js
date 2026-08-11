'use strict';
// R4-S3:deterministic memory clustering + review-only expiry suggestions. Offline,pure-function driven.
const fs = require('fs'), path = require('path'), os = require('os');

const HOME = path.join(os.tmpdir(), 'r4s3-memory-maintenance-' + process.pid);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME;

const {
  saveMemory, listMemoryRelations, proposeMemoryRelation, confirmMemoryRelation,
  analyzeMemoryMaintenance,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (value, label) => value ? console.log('PASS ' + label) : (failures++, console.error('FAIL ' + label));
const PROJ_A = path.join(HOME, 'project-a');
const PROJ_B = path.join(HOME, 'project-b');

(async () => {
  const save = (id, cwd, scope = 'project') => saveMemory({ id, scope, name: id, description: id + ' description', type: 'reference', body: id + ' body' }, cwd);
  const a = await save('mem-new', PROJ_A);
  const b = await save('mem-old', PROJ_A);
  const c = await save('mem-peer', PROJ_A);
  const d = await save('mem-isolated', PROJ_A);
  const other = await save('mem-other-project', PROJ_B);
  const global = await save('mem-global', PROJ_A, 'global');
  ok([a, b, c, d, other, global].every(x => x.ok), 'fixtures: project/global memories saved');

  async function confirmed(type, from, to) {
    const proposed = await proposeMemoryRelation({ type, from, to, scope: 'project' }, PROJ_A);
    if (!proposed.ok) return proposed;
    return confirmMemoryRelation(proposed.relation.id, PROJ_A);
  }
  const supersedes = await confirmed('supersedes', 'mem-new', 'mem-old');
  const supports = await confirmed('supports', 'mem-old', 'mem-peer');
  const contradicts = await confirmed('contradicts', 'mem-old', 'mem-peer');
  const pending = await proposeMemoryRelation({ type: 'supports', from: 'mem-isolated', to: 'mem-new', scope: 'project' }, PROJ_A);
  ok(supersedes.ok && supports.ok && contradicts.ok && pending.ok && pending.relation.confirmed === false, 'fixtures: 3 confirmed + 1 pending relation');

  const now = '2100-01-01T00:00:00.000Z'; // every fixture is older than staleDays; graph membership decides outcome
  const report = await analyzeMemoryMaintenance(PROJ_A, 'project', { now, staleDays: 180 });
  ok(report.ok && report.scope === 'project' && report.stats.memories === 4, 'report is scoped to current project (4 memories only)');
  ok(report.clusters.length === 1 && report.clusters[0].memoryIds.join(',') === 'mem-new,mem-old,mem-peer', 'confirmed relations form one deterministic 3-memory cluster');
  ok(report.clusters[0].relationTypes.join(',') === 'contradicts,supersedes,supports' && report.clusters[0].conflictCount === 1, 'cluster preserves relation types and conflict count');
  ok(!report.clusters[0].memoryIds.includes('mem-isolated'), 'pending edge does not pull an isolated memory into a cluster');
  const oldSuggestion = report.expirySuggestions.find(s => s.memoryId === 'mem-old');
  ok(oldSuggestion && oldSuggestion.reason === 'superseded' && oldSuggestion.priority === 'high' && oldSuggestion.replacementMemoryIds[0] === 'mem-new' && oldSuggestion.autoApplied === false, 'confirmed supersedes yields high-priority review-only suggestion');
  const isolatedSuggestion = report.expirySuggestions.find(s => s.memoryId === 'mem-isolated');
  ok(isolatedSuggestion && isolatedSuggestion.reason === 'stale_isolated' && isolatedSuggestion.priority === 'low' && isolatedSuggestion.action === 'review', 'old memory with no confirmed links yields low-priority review suggestion');
  ok(!report.expirySuggestions.some(s => s.memoryId === 'mem-new' || s.memoryId === 'mem-peer'), 'old but linked memories are not mislabeled stale merely by creation age');

  const repeated = await analyzeMemoryMaintenance(PROJ_A, 'project', { now, staleDays: 180 });
  ok(JSON.stringify(repeated) === JSON.stringify(report), 'same graph + clock produces byte-stable cluster/suggestion output');
  const relationsAfter = await listMemoryRelations(PROJ_A, 'project', { includePending: true });
  ok(relationsAfter.confirmed.length === 3 && relationsAfter.pending.length === 1 && fs.existsSync(b.memory.file) && fs.existsSync(d.memory.file), 'analysis is read-only: no relation confirmation or memory deletion');

  const otherReport = await analyzeMemoryMaintenance(PROJ_B, 'project', { now, staleDays: 180 });
  ok(otherReport.stats.memories === 1 && otherReport.clusters.length === 0 && !JSON.stringify(otherReport).includes('mem-old'), 'project scope does not leak memories or clusters across cwd');
  const globalReport = await analyzeMemoryMaintenance(PROJ_A, 'global', { now, staleDays: 180 });
  ok(globalReport.stats.memories === 1 && globalReport.clusters.length === 0 && globalReport.expirySuggestions[0].memoryId === 'mem-global', 'global analysis is separate from project graph');

  // A deleted endpoint leaves relation cleanup to the user. S3 must surface the orphan,not crash or silently
  // treat it as graph evidence.
  fs.unlinkSync(c.memory.file);
  const orphanReport = await analyzeMemoryMaintenance(PROJ_A, 'project', { now, staleDays: 180 });
  ok(orphanReport.orphanedRelations.length === 2 && orphanReport.orphanedRelations.every(r => r.missing.includes('mem-peer')), 'missing relation endpoints are surfaced as cleanup candidates');
  ok(orphanReport.clusters.length === 1 && orphanReport.clusters[0].memoryIds.join(',') === 'mem-new,mem-old', 'orphaned edges are excluded while remaining confirmed graph still clusters');

  console.log('\n' + (failures ? failures + ' FAIL' : 'ALL PASS') + ' (R4-S3 memory maintenance)');
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});
