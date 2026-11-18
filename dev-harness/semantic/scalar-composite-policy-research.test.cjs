'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createCompositePolicy } = require('./scalar-composite-policy-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
const row = (fieldKey, text, extra = {}) => ({ fieldKey, text, metadata: false, order: fieldKey, ...extra });
function setup(rows, overrides = {}) {
  const calls = [], sources = rows.map((r, n) => ({ identity: { sourceId: r.sourceId || 'session', field: r.fieldKey, revision: 'rev', start: 0, end: r.text.length }, text: r.text, fieldText: r.full || r.text }));
  const host = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({}), verify: async (query, source, options) => {
    await options.beforeVerify(); calls.push({ query, source, deadline: options.deadline });
    if (overrides.response) return overrides.response(source);
    return { ok: true, ...fp, score: .99, accepted: true };
  } };
  const bridge = createScalarVerifierBridge(host);
  const policy = createCompositePolicy({ bridge, identify: text => text.match(/ID-\d+/g) || [], normalize: text => text.toUpperCase(), terms: text => text.split(/\s+/) });
  const evaluate = options => policy.evaluate({ query: 'orchid missing', rows, lexical: [], scores: rows.map((_, i) => .8 - i * .1), complete: true,
    scopeId: 'scope', deadline: Date.now() + 1000, resolve: async (index, whole) => whole ? { ...sources[index], text: sources[index].fieldText,
      identity: { ...sources[index].identity, end: sources[index].fieldText.length } } : sources[index], beforeVerify: async () => {}, ...options });
  return { evaluate, calls, sources };
}
test('one global top1 across fragments, not one per batch or source; no coarse cosine threshold', async () => {
  const rows = [row('a', 'first'), row('b', 'second'), row('c', 'third'), row('d', 'fourth')], f = setup(rows);
  const output = await f.evaluate({ scores: [.1, .2, .19, -.3] });
  assert.deepEqual(output.report.globalSelectedIndices, [1]); assert.deepEqual(output.accepted, [false, true, false, false]); assert.equal(f.calls.length, 1);
});
test('strong selected field bypasses without refilling K; its sibling field needs its own scalar', async () => {
  const rows = [row('content', 'orchid missing exact'), row('blocks.0', 'orchid unrelated')], f = setup(rows);
  const output = await f.evaluate({ lexical: [{ key: 'content', index: 0 }, { key: 'blocks.0', index: 1 }] });
  assert.deepEqual(output.accepted, [false, false]); assert.equal(output.lexical.get('content'), true); assert.equal(output.lexical.get('blocks.0'), true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].source.identity.field, 'blocks.0');
});
test('metadata competes in same global rank and cannot lend its verdict to a body field', async () => {
  const rows = [row('content', 'orchid body'), row('title', 'orchid title', { metadata: true })], f = setup(rows);
  const output = await f.evaluate({ scores: [.4, .8], lexical: [{ key: 'content', index: 0 }] });
  assert.deepEqual(output.report.globalSelectedIndices, [1]); assert.deepEqual(output.accepted, [false, true]);
  assert.equal(output.metadata.get('title'), true); assert.equal(f.calls.length, 2); assert.equal(new Set(f.calls.map(c => c.source.identity.field)).size, 2);
});
test('unavailable verification leaves weak and semantic unknown, partial and never true', async () => {
  const rows = [row('content', 'orchid body')], f = setup(rows, { response: () => ({ ok: false, reason: 'timeout' }) });
  const output = await f.evaluate({ lexical: [{ key: 'content', index: 0 }] });
  assert.equal(output.accepted[0], null); assert.equal(output.lexical.get('content'), null); assert.equal(output.complete, false);
});
test('incomplete coarse universe cannot promote an observed local winner but still verifies explicit weak work', async () => {
  const rows = [row('content', 'orchid body'), row('other', 'unknown source')], f = setup(rows);
  const output = await f.evaluate({ scores: [.9, null], complete: false, lexical: [{ key: 'content', index: 0 }] });
  assert.deepEqual(output.report.globalSelectedIndices, []); assert.deepEqual(output.accepted, [false, false]); assert.equal(output.lexical.get('content'), true); assert.equal(output.complete, false);
});
test('same absolute deadline includes source guards; no independent verifier budget is created', async () => {
  const rows = [row('content', 'orchid body')], f = setup(rows), deadline = Date.now() + 35;
  const output = await f.evaluate({ deadline, beforeVerify: async ({ phase }) => { if (phase === 'resolved') await new Promise(resolve => setTimeout(resolve, 45)); } });
  assert.equal(output.complete, false); assert.equal(output.accepted[0], null); assert.equal(f.calls.length, 0);
});
test('deterministic zero eligible documents can be complete while an unknown pool is partial', async () => {
  const f = setup([]), output = await f.evaluate({ query: 'ID-12 facts' }); assert.equal(output.complete, true); assert.deepEqual(output.accepted, []);
  const partial = await f.evaluate({ complete: false }); assert.equal(partial.complete, false);
});
test('complete IDs are checked against original whole field, never another sibling', async () => {
  const rows = [row('content', 'facts ID-13'), row('blocks.0', 'facts ID-12')], f = setup(rows);
  const output = await f.evaluate({ query: 'ID-12 facts', lexical: [{ key: 'content', index: 0 }] });
  assert.equal(output.accepted[0], false); assert.equal(output.lexical.get('content'), false); assert.equal(f.calls.length, 0);
  assert.deepEqual(output.report.globalSelectedIndices, [1]); assert.equal(output.report.excludedIdentifierRows, 1);
});
test('wrong-ID metadata cannot occupy K before a lower-scored eligible body field', async () => {
  const rows = [row('metadata.title', 'wrong ID-13', { metadata: true }), row('content', 'eligible ID-12')], f = setup(rows);
  const output = await f.evaluate({ query: 'ID-12 details', scores: [.99, .1] });
  assert.deepEqual(output.report.globalSelectedIndices, [1]); assert.equal(output.report.excludedIdentifierRows, 1);
  assert.equal(output.metadata.get('metadata.title'), false); assert.equal(output.complete, true);
});
