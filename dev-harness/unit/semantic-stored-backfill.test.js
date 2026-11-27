'use strict';
// 152 L4: a Gemma request may use a persisted window vector only after re-reading the original text through the
// caller's resolveTexts and matching the stored sha256. Anything else falls back to encoding that window live.
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function setup() {
  const token = Object.freeze({});
  const c = vm.createContext({ require, Buffer, Date, WeakRef, crypto, setTimeout, clearTimeout,
    SemanticRuntimeTransportProof: Object.freeze({ snapshot: () => token, verify: result => ({ ...result, vectors: result.vectors.map(v => v.slice()) }), method: () => token, isMethod: v => v === token, lifecycle: () => token }) });
  vm.runInContext(source('06h9-semantic-policy.js') + '\n' + source('06ha-semantic-retrieval.js'), c);
  const model = vm.runInContext('SemanticWindowPolicy.CONTRACT', c), calls = [];
  const runtime = {
    prepare: async () => ({ available: true, policyReady: true, modelId: model.modelId, modelFingerprint: model.modelFingerprint, retrievalThresholds: { search: .70, automatic: null } }),
    encode: async (texts, opts) => { calls.push({ role: opts.role, texts: [...texts] }); return { ok: true, modelFingerprint: model.modelFingerprint, vectors: texts.map(() => unit(opts.role === 'query' ? 0 : 1)) }; },
  };
  const scorer = vm.runInContext('SemanticRetrieval', c).create(runtime);
  return { scorer, calls };
}
function unit(axis) { const v = Array(768).fill(0); v[axis] = Math.fround(0.6); v[2] = Math.fround(0.8); return v; }
const originals = ['Original Spelling one', 'Original Spelling two'];
const docs = originals.map(text => text.toUpperCase());           // lexical shard text, as the session index passes it
const stored = digests => async () => n => ({ vector: Float32Array.from(unit(1)), digest: digests[n] });
const options = (extra = {}) => ({ scopeId: 'session-search', purpose: 'rerank', deadline: Date.now() + 5000, identities: docs.map((_, n) => ['w', n]),
  resolveTexts: async batch => batch.map(n => originals[n]), ...extra });

test('a stored vector whose digest matches the re-read original is used without encoding the document', async () => {
  const f = setup();
  // Pre-fix: 06ha skipped stored() for the Gemma model and encoded both windows live.
  const result = await f.scorer.score('query', docs, options({ stored: stored(originals.map(sha)) }));
  a.equal(result.status, 'ready');
  a.equal(result.coverage.complete, true);
  a.equal(f.calls.filter(call => call.role === 'document').length, 0);
  const live = await setup().scorer.score('query', docs, options());
  a.deepEqual(Array.from(result.scores), Array.from(live.scores), 'restored float32 values score exactly like live Gemma output');
});

test('a digest mismatch or a missing original falls back to live encoding of exactly that window', async () => {
  const f = setup();
  const result = await f.scorer.score('query', docs, options({ stored: stored([sha('something else'), sha(originals[1])]) }));
  a.equal(result.coverage.complete, true);
  a.deepEqual(f.calls.filter(call => call.role === 'document').flatMap(call => call.texts), [originals[0]]);
  const g = setup();
  await g.scorer.score('query', docs, options({ stored: stored(originals.map(sha)), resolveTexts: async batch => batch.map(n => n === 1 ? null : originals[n]) }));
  a.ok(!g.calls.some(call => call.role === 'document' && call.texts.includes(originals[0])), 'the verified window is not re-encoded');
});

test('a stored vector without a digest (schema 1) is never trusted for Gemma', async () => {
  const f = setup();
  await f.scorer.score('query', docs, options({ stored: async () => () => Float32Array.from(unit(1)) }));
  a.equal(f.calls.filter(call => call.role === 'document').reduce((n, call) => n + call.texts.length, 0), 2);
});
