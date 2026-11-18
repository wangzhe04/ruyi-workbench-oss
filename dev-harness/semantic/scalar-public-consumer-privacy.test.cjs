'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./scalar-public-consumer-fixture.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
async function setup(options = {}) {
  const runtime = { prepare: async () => ({ available: true, modelId: 'synthetic', modelFingerprint: 'coarse', retrievalThresholds: { search: -1, automatic: null } }),
    encode: async (texts, opts) => { await opts.beforeEncode?.(); return { ok: true, modelFingerprint: 'coarse', vectors: texts.map(text => text.includes('orchid') ? [1, 0] : [.1, 1]) }; } };
  const scalarHost = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({ cleanupStatus: 'observed', workerExited: true }),
    verify: async (_query, _source, opts) => { await opts.beforeVerify(); return { ok: true, ...fp, score: .99, accepted: true }; } };
  return fixture({ enabled: true, runtime, scalarHost, ...options });
}
test('actual privacy policy changes after prepared metadata invalidate disclosure without config generation changes', async () => {
  let f, changed = false;
  f = await setup({ observeMetadataProjection: () => { if (!changed) { changed = true; f.privacy.configure({ ...f.config, privacyModeV1: 'basic' }); } } });
  try { await f.put('Meta', [{ role: 'user', id: 'm1', content: 'ordinary body' }], { head: { title: 'orchid metadata', summary: 'unrelated summary' } });
    await assert.rejects(f.ui('orchid missing'), error => typeof error?.code === 'string' && error.code.startsWith('privacy.'));
    assert.equal(changed, true); assert.equal(f.context.configReadGeneration, 0);
  } finally { await f.close(); }
});
test('approved raw title projects its own credential-redacted value instead of borrowing unreviewed summary', async () => {
  const f = await setup(), key = 'sk-' + 'a'.repeat(48), title = 'orchid ' + key;
  try { await f.put('Meta', [{ role: 'user', id: 'm1', content: 'ordinary body' }], { head: { title, summary: 'unrelated summary' } });
    const found = await f.ui('orchid missing'); assert.equal(found.results.length, 1);
    assert.equal(found.results[0].snippet, found.results[0].title); assert.notEqual(found.results[0].snippet, 'unrelated summary');
    assert.doesNotMatch(found.results[0].snippet, new RegExp(key));
  } finally { await f.close(); }
});
