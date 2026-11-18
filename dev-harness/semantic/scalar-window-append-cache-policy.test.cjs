'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { transform } = require('./scalar-window-append-cache-research-source.cjs');
const { createCompositePolicy } = require('./scalar-window-policy-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const original = fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js', 'utf8'), derived = transform(original), directory = path.resolve('output/semantic-scalar-window-append-cache-fakes');
fs.mkdirSync(directory, { recursive: true }); const modulePath = path.join(directory, derived.transformedSha256 + '.cjs'); if (!fs.existsSync(modulePath)) fs.writeFileSync(modulePath, derived.source);
const primitive = vm.runInNewContext(fs.readFileSync('ruyi-workbench/app/src/06ha-semantic-retrieval.js', 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
const normalize = vm.runInNewContext(original.match(/^  const canonicalText=.*;$/m)[0] + '\n' + original.match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'window-v2' };
async function setup(input, options = {}) {
  const f = await fixture({ enabled: true, module: modulePath }); f.hookContext.SemanticRetrieval = primitive;
  for (const [sid, rows] of Object.entries(input)) await f.put(sid, rows);
  const calls = [], coarse = { clear() {}, async score(query, docs, opts) { const raw = await opts.resolveTexts(docs.map((_, n) => n)); await opts.beforeEncode();
    const scores = raw.map((text, n) => options.rank ? options.rank(text, n) : n === 0 ? .9 : .1);
    return { status: 'ready', scores, modelFingerprint: 'injected-complete-coarse', coverage: { total: docs.length, cached: scores.filter(Number.isFinite).length, complete: scores.every(Number.isFinite) } }; } };
  const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }), stop: async () => ({}), verify: async (query, source, opts) => {
    await opts.beforeVerify(); calls.push(source);
    if (source.text.length > 512 || options.unknown) return { ok: false, reason: 'unavailable' };
    const probability = options.probability ? options.probability(source) : .99;
    return { ok: true, ...fp, score: probability, accepted: probability >= .95 };
  } });
  const policy = options.policy || createCompositePolicy({ bridge, identify: primitive.structuredIds, normalize, terms: f.api.terms });
  const index = vm.runInNewContext('SessionFullTextIndex;', f.hookContext).create({ ...f.host, resultUnit: 'sessions', semantic: coarse, scalarComposite: policy }); await index.prepare(null);
  return { f, index, calls };
}
test('long whole field no longer causes permanent partial when its fixed best window is admitted', async () => {
  const text = 'orchid documented evidence. ' + 'a '.repeat(1200), t = await setup({ A: [{ role: 'user', id: 'm1', content: text }] });
  try { for (let run = 0; run < 2; run++) { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }), detail = t.index.researchReport(found);
      assert.equal(found.semantic.coverage, 'complete'); assert.equal(found.lexicalAdmission.partial, false); assert.equal(found.results.length, 1);
      assert.equal(detail.scalarPairs, 1); assert.equal(detail.requiredWork.length, 2); assert.ok(detail.requiredWork.every(work => work.identity.end - work.identity.start === 96));
      assert.equal(found.results[0].reference.matchStart, 0); assert.equal(found.results[0].reference.matchEnd, 96); assert.ok(found.results[0].snippet.includes(text.slice(0, 96)));
      assert.equal(detail.scores[0].cached, run === 1);
    } assert.equal(t.calls.length, 1); assert.equal(t.calls[0].text.length, 96);
  } finally { await t.f.close(); }
});
test('weak field first lexical position is replaced by its fixed admitted later window, not a sibling score', async () => {
  const a = 'orchid early weak words. ' + 'padding '.repeat(45) + 'TARGET fixed later evidence '.repeat(5);
  const b = 'OTHER global candidate', t = await setup({ A: [{ role: 'user', id: 'm1', content: a, blocks: ['orchid sibling must reject'] }], B: [{ role: 'user', id: 'm1', content: b }] },
    { rank: text => text.startsWith('OTHER') ? .99 : text.includes('TARGET') ? .8 : .1, probability: source => source.identity.field === 'blocks.0' ? .01 : .99 });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }), hit = found.results.find(hit => hit.reference.sessionId === 'A'), detail = t.index.researchReport(found);
    assert.ok(hit); assert.equal(hit.reference.source, 'content'); assert.equal(hit.reference.matchKind, 'verified-window'); assert.ok(hit.reference.matchStart > 0);
    const work = detail.requiredWork.find(work => work.role === 'weak-lexical' && work.identity.field === 'content' && work.identity.sessionId === 'A');
    assert.equal(hit.reference.matchStart, work.identity.start); assert.equal(hit.reference.matchEnd, work.identity.end);
    assert.ok(hit.snippet.includes(a.slice(work.identity.start, work.identity.end))); assert.ok(t.calls.some(source => source.identity.field === 'blocks.0'));
  } finally { await t.f.close(); }
});
test('different weak fields/windows remain distinct even when one global source is approved', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid field one', blocks: ['orchid field two'] }] }, { probability: source => source.identity.field === 'content' ? .99 : .01 });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }); assert.equal(t.calls.length, 2);
    assert.equal(found.results.length, 1); assert.equal(found.results[0].reference.source, 'content');
  } finally { await t.f.close(); }
});
test('partial coarse pool cannot pick an easier weak window or claim complete', async () => {
  const text = 'orchid first. ' + 'padding '.repeat(30), t = await setup({ A: [{ role: 'user', id: 'm1', content: text }] }, { rank: (_text, n) => n === 0 ? .9 : null });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }); assert.equal(found.semantic.coverage, 'partial'); assert.equal(found.results.length, 0); assert.equal(t.calls.length, 0); }
  finally { await t.f.close(); }
});
test('rejected/over-limit best window stays unknown without trying a lower-ranked window', async () => {
  const text = 'orchid first. ' + 'padding '.repeat(30), t = await setup({ A: [{ role: 'user', id: 'm1', content: text }] }, { unknown: true });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }); assert.equal(found.semantic.coverage, 'partial'); assert.equal(found.results.length, 0); assert.equal(t.calls.length, 1); assert.equal(t.calls[0].identity.start, 0); }
  finally { await t.f.close(); }
});
test('unknown weak contribution cannot remove an independently admitted semantic hit or add lexical RRF', async () => {
  const policy = { contract: { id: 'independent-path-regression' }, evaluate: async input => {
    await input.resolve(0, false); await input.beforeVerify({ phase: 'finish', source: null });
    return { accepted: input.rows.map((_, n) => n === 0), lexical: new Map(), metadata: new Map(), complete: false,
      report: { scalarPairs: 0, complete: false, partial: true } };
  } };
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid evidence' }] }, { policy });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }); assert.equal(found.results.length, 1); assert.equal(found.lexicalAdmission.partial, true);
    assert.equal(found.results[0].semanticScore, .9); assert.equal(found.results[0].rankScore, 1 / 61);
  } finally { await t.f.close(); }
});
