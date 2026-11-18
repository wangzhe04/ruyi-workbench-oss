'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./scalar-window-public-consumer-fixture.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'window-v2' };
test('metadata raw window crossing a secret projects the entire admitted field before masking and never slices safe offsets', async () => {
  const calls = [], key = 'sk-' + 'A1b2C3d4'.repeat(6), prefix = 'orchid ' + 'x '.repeat(35), title = prefix + key + ' complete metadata tail';
  const runtime = { prepare: async () => ({ available: true, modelId: 'synthetic', modelFingerprint: 'coarse', retrievalThresholds: { search: -1, automatic: null } }),
    encode: async (texts, opts) => { await opts.beforeEncode?.(); return { ok: true, modelFingerprint: 'coarse', vectors: texts.map(text => opts.role === 'query' || text.includes('orchid') ? [1, 0] : [.1, 1]) }; } };
  const scalarHost = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({ cleanupStatus: 'observed', workerExited: true }),
    verify: async (_query, source, opts) => { await opts.beforeVerify(); calls.push(source); return { ok: true, ...fp, score: .99, accepted: true }; } };
  const f = await fixture({ enabled: true, runtime, scalarHost });
  try {
    await f.put('Meta', [{ role: 'user', id: 'm1', content: 'ordinary unrelated body' }], { head: { title, summary: 'sibling summary must not substitute' } });
    f.changeConfig({ privacyModeV1: 'basic' });
    const result = await f.ui('orchid missing'); assert.equal(result.results.length, 1);
    const hit = result.results[0], proof = calls.find(source => source.identity.field === 'metadata.title'); assert.ok(proof);
    assert.ok(proof.identity.start <= prefix.length && proof.identity.end > prefix.length && proof.identity.end < prefix.length + key.length);
    assert.equal(proof.text.length, 96); assert.ok(proof.text.includes(key.slice(0, 16)));
    assert.equal(hit.reference, null); assert.equal(hit.matchKind, 'metadata-context'); assert.equal(hit.snippet, hit.title);
    assert.notEqual(hit.snippet.length, title.length); assert.ok(hit.snippet.includes('complete metadata tail'));
    assert.doesNotMatch(hit.snippet, new RegExp(key.slice(0, 16))); assert.doesNotMatch(hit.snippet, new RegExp(key.slice(-16)));
    assert.notEqual(hit.snippet, 'sibling summary must not substitute');
    assert.doesNotMatch(JSON.stringify(result), /"(?:identity|epoch|contentRevision|rawFieldSha256|rawWindowSha256)"\s*:/);
    const tool = await f.installEntrypoints().threadHistorySearch({ q: 'orchid missing' }, f.ctx);
    assert.equal(tool.results[0].reference, undefined); assert.equal(tool.results[0].snippet, undefined);
  } finally { await f.close(); }
});
