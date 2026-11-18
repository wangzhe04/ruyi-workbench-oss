'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./scalar-public-consumer-fixture.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
async function setup(options = {}) {
  let f; const calls = [];
  const scalarHost = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({ cleanupStatus: 'observed', workerExited: true }),
    verify: async (query, source, transport) => { await transport.beforeVerify(); calls.push(source); if (options.afterVerify) await options.afterVerify(f);
      const score = options.score ? options.score(source) : .99;
      return score === null ? { ok: false, reason: 'timeout' } : { ok: true, ...fp, score, accepted: score >= .95 }; } };
  const runtime = { prepare: async () => ({ available: true, modelId: 'synthetic-qwen-coarse', modelFingerprint: 'coarse-fp', retrievalThresholds: { search: -1, automatic: null } }),
    encode: async (texts, opts) => { await opts.beforeEncode?.(); return { ok: true, modelFingerprint: 'coarse-fp', vectors: texts.map(text => opts.role === 'query' || text.includes('orchid') ? [1, 0] : [.1, 1]) }; } };
  f = await fixture({ enabled: true, ...(options.featureOff ? {} : { scalarHost, runtime }),
    ...(options.projection ? { observeMetadataProjection: () => options.projection(f) } : {}) });
  await f.put('Meta', [{ role: 'user', id: 'm1', content: 'ordinary body' }], { head: { title: options.title || 'unrelated title', summary: options.summary || 'unrelated summary', kind: 'mission', cwd: f.directory } });
  return { f, calls };
}
async function http(f, query) { const entry = f.installEntrypoints(), { req, res } = f.request(); req.method = 'GET'; req.url = '/api/sessions/search?q=' + encodeURIComponent(query);
  await entry.handleSessionApiRoutes(req, res, '/api/sessions/search'); return res.payload; }
function noPrivate(value) { assert.doesNotMatch(JSON.stringify(value), /"(?:contentRevision|sourceRevision|epoch|identity|rawFieldSha256|rawWindowSha256|templateFingerprint|runtimeFingerprint|policyFingerprint)"\s*:/); }
test('actual13d typed HTTP title-only scalar approval displays projected title, never sibling summary', async () => {
  const t = await setup({ title: 'orchid title evidence', summary: 'summary must not become snippet' });
  try { const found = await http(t.f, 'orchid missing'); assert.equal(found.results.length, 1); assert.equal(found.results[0].snippet, 'orchid title evidence');
    assert.equal(found.results[0].reference, null); assert.ok(t.calls.some(source => source.identity.field === 'metadata.title')); noPrivate(found);
  } finally { await t.f.close(); }
});
test('actual13as model result uses approved summary and13g retains its metadata-without-citation DTO', async () => {
  const t = await setup({ title: 'title must not become snippet', summary: 'orchid summary evidence' });
  try { const model = await t.f.model('orchid missing'); assert.equal(model.results.length, 1); assert.equal(model.results[0].snippet, 'orchid summary evidence'); noPrivate(model);
    const found = await t.f.installEntrypoints().threadHistorySearch({ q: 'orchid missing' }, t.f.ctx); assert.equal(found.results.length, 1);
    assert.equal(found.results[0].reference, undefined); assert.equal(found.results[0].snippet, undefined); noPrivate(found); }
  finally { await t.f.close(); }
});
test('actual13as two weak sibling fields require independent verdicts and use only approved field', async () => {
  const t = await setup({ title: 'orchid approved title', summary: 'orchid rejected summary', score: source => source.identity.field === 'metadata.title' ? .99 : .01 });
  try { const found = await t.f.ui('orchid missing'); assert.equal(found.results.length, 1); assert.equal(found.results[0].snippet, 'orchid approved title');
    assert.ok(t.calls.some(source => source.identity.field === 'metadata.title')); assert.ok(t.calls.some(source => source.identity.field === 'metadata.summary')); noPrivate(found);
  } finally { await t.f.close(); }
});
test('actual13as unknown weak metadata is withheld and partial, not a complete negative', async () => {
  const t = await setup({ title: 'orchid unknown title', score: () => null });
  try { const found = await t.f.ui('orchid missing'); assert.equal(found.results.length, 0); assert.equal(found.lexicalAdmission.partial, true); assert.equal(found.semantic.coverage, 'partial'); noPrivate(found); }
  finally { await t.f.close(); }
});
test('feature-off keeps explicit ordinary lexical metadata mode and its old snippet behavior', async () => {
  const t = await setup({ title: 'orchid weak title', summary: 'ordinary summary', featureOff: true });
  try { const found = await t.f.ui('orchid missing'); assert.equal(found.results.length, 1); assert.equal(found.results[0].snippet, 'ordinary summary'); assert.equal(t.calls.length, 0); noPrivate(found); }
  finally { await t.f.close(); }
});
test('strong same-field title bypass selects title while unrelated summary cannot substitute', async () => {
  const t = await setup({ title: 'orchid missing exact title', summary: 'unrelated summary', score: () => .01 });
  try { const found = await t.f.ui('orchid missing'); assert.equal(found.results.length, 1); assert.equal(found.results[0].snippet, 'orchid missing exact title'); noPrivate(found); }
  finally { await t.f.close(); }
});
test('source replacement/revocation during scalar await refuses public metadata before disclosure', async () => {
  let changed = false; const t = await setup({ title: 'orchid old title', afterVerify: async f => { if (!changed) { changed = true; await f.put('Meta', [{ role: 'user', id: 'm1', content: 'withdrawn' }], { head: { title: 'withdrawn', kind: 'steward' } }); } } });
  try { await assert.rejects(t.f.ui('orchid missing'), error => /source_changed|source_denied|disclosure_changed/.test(error?.code)); assert.equal(changed, true); }
  finally { await t.f.close(); }
});
test('actual metadata privacy projection invalidation refuses before UI emission', async () => {
  let invalidated = false; const t = await setup({ title: 'orchid projected title', projection: f => { if (!invalidated) { invalidated = true; f.changeConfig({ privacyModeV1: 'personal' }); } } });
  try { await assert.rejects(t.f.ui('orchid missing'), error => /destination_changed|privacy\./.test(error?.code)); assert.equal(invalidated, true); }
  finally { await t.f.close(); }
});
