'use strict';
// Actual source owner/index/projection with synthetic encoder and scalar host.
// This checks composition, never model relevance or native performance.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { transform } = require('./scalar-producer-research-source.cjs');
const { createCompositePolicy } = require('./scalar-composite-policy-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const source = fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js', 'utf8'), transformed = transform(source);
const directory = path.resolve('output/semantic-scalar-producer-adversarial'), modulePath = path.join(directory, transformed.transformedSha256 + '.cjs');
fs.mkdirSync(directory, { recursive: true }); if (!fs.existsSync(modulePath)) fs.writeFileSync(modulePath, transformed.source, { flag: 'wx' });
const primitive = vm.runInNewContext(fs.readFileSync('ruyi-workbench/app/src/06ha-semantic-retrieval.js', 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
const normalize = vm.runInNewContext(source.match(/^  const canonicalText=.*;$/m)[0] + '\n' + source.match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
async function setup(input, scalar = () => .99, rank = (_, index) => index / 100) {
  const f = await fixture({ enabled: true, module: modulePath }), writes = [], batches = [];
  f.hookContext.SemanticRetrieval = primitive;
  for (const [sid, rows] of Object.entries(input)) await f.put(sid, rows);
  const host = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({}), verify: async (query, field, options) => {
    await options.beforeVerify(); writes.push(field); const score = scalar(field);
    return score === null ? { ok: false, reason: 'timeout' } : { ok: true, ...fp, score, accepted: score >= .95 };
  } };
  const policy = createCompositePolicy({ bridge: createScalarVerifierBridge(host), identify: primitive.structuredIds, normalize, terms: f.api.terms });
  const scorer = { clear() {}, async score(query, docs, options) {
    const originals = [];
    // Multiple physical-resolution batches must not each get their own K1.
    for (let start = 0; start < docs.length; start += 2) { const indices = docs.slice(start, start + 2).map((_, n) => start + n); batches.push(indices); originals.push(...await options.resolveTexts(indices)); await options.beforeEncode(); }
    const scores = originals.map(rank); return { status: 'ready', scores, modelFingerprint: 'synthetic-raw', minScore: .46, coverage: { total: docs.length, cached: scores.filter(Number.isFinite).length, complete: scores.every(Number.isFinite) } };
  } };
  const indexHost = { ...f.host, semantic: scorer, scalarComposite: policy, resultUnit: 'sessions' };
  const index = vm.runInNewContext('SessionFullTextIndex;', f.hookContext).create(indexHost);
  await index.prepare(null); return { f, index, indexHost, writes, batches };
}
test('actual producer uses one global K1 after many physical fragment resolution batches', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid growth information '.repeat(16) }], B: [{ role: 'user', id: 'm1', content: 'another unrelated message' }] });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 });
    assert.ok(t.batches.length > 2); assert.equal(t.index.researchReport(found).globalSelectedIndices.length, 1);
    assert.equal(t.index.researchReport(found).requiredWork.filter(x => x.role === 'semantic').length, 1);
    assert.equal(t.index.researchReport(found).globalSelectedIndices[0], t.index.researchReport(found).globalCandidateCount - 1);
    assert.equal(found.results.filter(hit => hit.semanticScore !== undefined).length, 1);
    assert.deepEqual(Object.keys(found.scalarResearch).sort(), ['candidateFragments', 'complete', 'partial', 'policyId', 'scalarPairs']);
    assert.equal(t.index.researchReport(JSON.parse(JSON.stringify(found))), null, 'private source proof cannot be reconstructed from a public DTO clone');
  } finally { await t.f.close(); }
});
test('actual sibling field cannot borrow strong lexical content or scalar approval', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid missing full evidence', blocks: ['orchid sibling unrelated'] }] }, field => field.identity.field === 'blocks.0' ? .01 : .99,
    text => text.includes('sibling') ? .9 : .1);
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 });
    assert.equal(found.results.length, 1); assert.equal(found.results[0].reference.source, 'content');
    assert.ok(t.writes.some(field => field.identity.field === 'blocks.0')); assert.ok(!t.writes.some(field => field.identity.field === 'content'));
  } finally { await t.f.close(); }
});
test('actual unverified weak result is withheld with partial, unlike feature-off lexical mode', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid unrelated' }] }, () => null);
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 });
    assert.equal(found.results.length, 0); assert.equal(t.index.researchReport(found).partial, true); assert.equal(found.lexicalAdmission.partial, true);
    const lexical = vm.runInNewContext('SessionFullTextIndex;', t.f.hookContext).create({ ...t.f.host, resultUnit: 'sessions' });
    const ordinary = await lexical.search('orchid missing', null, 50); assert.equal(ordinary.results.length, 1); assert.equal(ordinary.scalarResearch, undefined);
  } finally { await t.f.close(); }
});
test('actual metadata winner and body weak verdict remain separate for same session', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid body unrelated' }] }, field => field.identity.field.startsWith('metadata.') ? .99 : .01,
    text => text.includes('title') ? .9 : .8);
  try { const meta = { sid: 'A', field: 'title', text: 'orchid title unrelated', epoch: await t.f.host.epoch('A') };
    const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500, metadataEntries: [meta], verifyMetadata: async () => true });
    assert.equal(found.results.length, 0); assert.equal(t.index.researchReport(found).globalSelectedIndices.length, 1);
    assert.equal(t.index.metadataAdmission(found, 'A', 'title', null), true);
    assert.ok(t.writes.some(field => field.identity.field === 'content')); assert.ok(t.writes.some(field => field.identity.field === 'metadata.title'));
  } finally { await t.f.close(); }
});
test('actual complete ID mismatch leaves a complete deterministic empty eligible pool', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'ID-13 stuff' }] });
  try { const found = await t.index.search('ID-12 stuff', null, 50, { deadline: Date.now() + 2500 });
    assert.equal(found.results.length, 0); assert.equal(found.semantic.coverage, 'complete'); assert.equal(t.index.researchReport(found).deterministicEmptyEligiblePool, true); assert.equal(t.writes.length, 0);
  } finally { await t.f.close(); }
});
test('actual wrong-ID unencoded metadata is excluded before global K without causing false partial', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'ID-12 body facts' }] }, () => .99, text => text.includes('wrong') ? null : .1);
  try { const meta = { sid: 'A', field: 'title', text: 'ID-13 wrong metadata', epoch: await t.f.host.epoch('A') };
    const found = await t.index.search('ID-12 details', null, 50, { deadline: Date.now() + 2500, metadataEntries: [meta], verifyMetadata: async () => true });
    assert.equal(found.semantic.coverage, 'complete'); assert.equal(t.index.researchReport(found).eligibleCandidateCount, 1); assert.equal(t.index.researchReport(found).excludedIdentifierRows, 1);
    assert.equal(t.index.researchReport(found).globalSelectedIndices[0], 1); assert.equal(t.index.metadataAdmission(found, 'A', 'title', null), false);
    assert.equal(found.results.length, 1); assert.equal(found.results[0].reference.source, 'content'); assert.equal(t.writes.length, 0);
  } finally { await t.f.close(); }
});
test('actual source reads cooperate with the shared semantic deadline and return honest partial', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid unrelated' }] }); let first = true;
  t.f.scan(async () => { if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 1050)); } });
  try { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 });
    assert.equal(t.index.researchReport(found).reason, 'semantic-deadline'); assert.equal(t.index.researchReport(found).complete, false);
    assert.equal(found.results.length, 0); assert.equal(t.writes.length, 0); assert.equal(found.lexicalAdmission.partial, true);
  } finally { await t.f.close(); }
});
test('late source permission error is primary even after semantic deadline passes', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid unrelated' }] }), denied = Error('source EACCES');
  t.f.scan(async () => { await new Promise(resolve => setTimeout(resolve, 1050)); throw denied; });
  try { await assert.rejects(t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }), error => error === denied); assert.equal(t.writes.length, 0); }
  finally { await t.f.close(); }
});
test('source-read cancellation retains falsy reason and no scalar write is issued', async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid unrelated' }] }), controller = new AbortController();
  t.f.scan(async () => controller.abort(0));
  let observed = Symbol();
  try { try { await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500, signal: controller.signal }); } catch (error) { observed = error; }
    assert.equal(observed, 0); assert.equal(t.writes.length, 0);
  } finally { await t.f.close(); }
});
for (const mode of ['deadline', 'permission']) test('specifically added rawCoverage scan cooperates and preserves ' + mode, async () => {
  const t = await setup({ A: [{ role: 'user', id: 'm1', content: 'orchid first' }, { role: 'user', id: 'm2', content: 'orchid second' }] });
  const scan = t.indexHost.scan, denied = Error('coverage EACCES'); let delayed = false, budgetCoverageVisits = 0;
  t.indexHost.scan = async (sid, visit, options) => {
    const addedCoverage = String(visit).includes('inspectSources(row).unverified') && options?.check?.name === 'researchCheck';
    return scan(sid, async (row, ordinal) => {
      if (addedCoverage) { budgetCoverageVisits++; if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 1050)); if (mode === 'permission') throw denied; } }
      return visit(row, ordinal);
    }, options);
  };
  try {
    if (mode === 'permission') await assert.rejects(t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }), error => error === denied);
    else { const found = await t.index.search('orchid missing', null, 50, { deadline: Date.now() + 2500 }); assert.equal(t.index.researchReport(found).reason, 'semantic-deadline'); assert.equal(found.results.length, 0); }
    assert.equal(delayed, true, 'instrumentation reached the added coverage scan, not coarse resolution'); assert.equal(budgetCoverageVisits, 1, 'next committed row was not visited after budget expired'); assert.equal(t.writes.length, 0);
  } finally { await t.f.close(); }
});
