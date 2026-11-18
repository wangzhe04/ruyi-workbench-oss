'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { run, metrics, classify } = require('./scalar-composite-live-development.cjs');
const { aggregate } = require('./scalar-live-memory-snapshot.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
function profile(options = {}) {
  let encoderStops = 0, scalarStops = 0; const counter = { query: 0, document: 0, scalar: 0 };
  return { id: 'synthetic-no-native', kind: 'synthetic-test', bindings: [], descriptor: { native: false }, counter,
    encoder: { prepare: async () => ({ available: true, modelId: 'synthetic', modelFingerprint: 'coarse', retrievalThresholds: { search: -1, automatic: null } }),
      encode: async (texts, opts) => { await opts.beforeEncode?.(); counter[opts.role] += texts.length;
        return { ok: true, modelFingerprint: 'coarse', vectors: texts.map(text => text.includes('orchid') ? [1, 0] : [.1, 1]) }; },
      stop: () => { encoderStops++; if (options.encoderStopError !== undefined) throw options.encoderStopError; return { workerExited: true }; }, stats: () => ({ starts: 0, counter }) },
    scalarHost: { prepare: async () => ({ ok: true, ...fp }),
      verify: async (query, _source, opts) => { await opts.beforeVerify(); counter.scalar++; if (options.partial && query.includes('unknown')) return { ok: false, reason: 'timeout' };
        return { ok: true, ...fp, score: query.includes('orchid') ? .99 : .01, accepted: query.includes('orchid') }; },
      stop: async () => { scalarStops++; return { cleanupStatus: 'observed', workerExited: true }; }, stats: () => ({ starts: 0, rankWrites: counter.scalar }) },
    counts: () => ({ encoderStops, scalarStops }) };
}
function directory(label) { const value = path.resolve('output/semantic-scalar-live-runner-tests', label + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)); fs.mkdirSync(value, { recursive: true }); return value; }
const corpus = { releaseHoldout: false, documents: [{ id: 'orchid', text: 'orchid opens at dawn' }, { id: 'other', text: 'a quiet unrelated field' }], queries: [
  { id: 'positive', text: 'orchid time', kind: 'positive', split: 'train', group: 'zh-zh', relevant: ['orchid'] },
  { id: 'negative', text: 'unknown weather', kind: 'ood', split: 'calibration', group: 'negative-ood', relevant: [] }] };
test('native-free actual consumer runner never fills partial OOD as a true negative and keeps each query once', async () => {
  const p = profile({ partial: true }), result = await run({ directory: directory('partial'), profile: p, corpus });
  assert.equal(result.report.prewarmComplete, true); assert.equal(result.report.measuredQueries, 2); assert.equal(result.report.rows.length, 2);
  assert.equal(result.report.metrics.calibration.pureOod.trueNegatives, 0); assert.equal(result.report.metrics.calibration.pureOod.partialNoResultUnknown, 1);
  assert.equal(result.report.metrics.calibration.pureOod.conservativeFprUpperBound, 1); assert.equal(result.failed, true);
  assert.equal(result.report.allWorkersObservedExited, true); assert.deepEqual(p.counts(), { encoderStops: 1, scalarStops: 1 });
});
test('synchronous encoder cleanup failure cannot prevent scalar cleanup or yield a successful verdict', async () => {
  const p = profile({ encoderStopError: 0 }), result = await run({ directory: directory('cleanup'), profile: p, corpus });
  assert.equal(result.report.status, 'FAIL_UNCONFIRMED_WORKER_EXIT'); assert.equal(result.failed, true); assert.deepEqual(p.counts(), { encoderStops: 1, scalarStops: 1 });
});
test('paired memory aggregate uses same snapshot identities and never adds missing/mismatched/duplicate process rows', () => {
  const expected = { coarse: { pid: 11, creationFileTime: '101' }, scalar: { pid: 12, creationFileTime: '102' } }, rows = [
    { role: 'coarse', alive: true, pid: 11, creationFileTime: '101', workingSetBytes: 100, privateBytes: 90 },
    { role: 'scalar', alive: true, pid: 12, creationFileTime: '102', workingSetBytes: 200, privateBytes: 180 }];
  const good = aggregate({ rows }, expected); assert.equal(good.combinedWorkingSetBytes, 300); assert.equal(good.combinedPrivateBytes, 270);
  for (const bad of [rows.slice(0, 1), [...rows, rows[0]], [rows[0], { ...rows[1], creationFileTime: '103' }], [rows[0], { ...rows[1], alive: false }]]) {
    const result = aggregate({ rows: bad }, expected); assert.equal(result.complete, false); assert.equal(result.combinedWorkingSetBytes, undefined);
  }
});
test('metrics keep prescribed positive and negative denominators even when results are partial', () => {
  const values = metrics([{ kind: 'positive', group: 'zh-en', complete: false, rank: 0, results: [] }, { kind: 'ood', complete: false, rank: 0, results: [] }]);
  assert.equal(values.quality.all.count, 1); assert.equal(values.quality.all.recallAt5, 0); assert.equal(values.pureOod.count, 1); assert.equal(values.pureOod.trueNegatives, 0); assert.equal(values.pureOod.conservativeFprUpperBound, 1);
});
test('semantic-only FPR does not count a separately admitted same-field weak lexical result', () => {
  const identity = { sourceId: JSON.stringify(['A', 'm1']), field: 'content', revision: 'r', start: 0, end: 10 };
  const hit = { reference: { sessionId: 'A', messageId: 'm1', messageOrdinal: 0, source: 'content' }, semanticScore: .5 };
  const diagnostic = { requiredWork: [{ role: 'weak-lexical', identity }], scores: [{ identity, accepted: true }], strongEvidence: [] };
  assert.equal(classify(hit, diagnostic).semanticOnly, false); assert.equal(classify(hit, diagnostic).weakLexical, true);
  diagnostic.scores[0].accepted = false; assert.equal(classify(hit, diagnostic).semanticOnly, true);
});
