'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'), 'utf8');
const api = vm.runInNewContext(source + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const prepared = { available: true, modelId: 'budget-fixture', modelFingerprint: 'budget-v1', retrievalThresholds: { search: .34, automatic: null } };
const vector = n => { const length = Math.hypot(1, n + 1); return [1 / length, (n + 1) / length]; };

// The first test charges its fixture costs (source resolve 75 ms, authority guard 15 ms, encode 1 ms) to a
// virtual clock instead of sleeping on the wall clock. 06ha reads time only through Date.now(), so a sandbox
// Date whose now() is virtual makes the budget arithmetic exact and the test pins the batching algorithm for
// these costs. The wall-clock version left 200 - (15 + 75 + 15) - 64 = 31 ms of slack per batch; Windows rounds
// every setTimeout up to ~15.6 ms (delay(1) measured 16 ms, delay(15) 16-34 ms under 4-way test concurrency),
// so whole attempts encoded nothing and 10 attempts sometimes did not finish. Real guard I/O growing under load
// until it eats a fixed budget is the product issue tracked as 150 §S8; this test does not measure it.
function virtualClock(start = 1e6) {
  let now = start;
  class VirtualDate extends Date { static now() { return now; } }
  return { Date: VirtualDate, now: () => now, delay: async ms => { now += ms; await new Promise(resolve => setImmediate(resolve)); } };
}

test('delayed source resolve and final guard shrink batches and make cache progress with correct identities', async () => {
  const clock = virtualClock();
  // Any real timer in 06ha would silently escape the virtual clock: fail loudly instead.
  const realTimer = () => { throw Error('06ha started a real timer; this test assumes Date.now() is its only clock'); };
  const virtualApi = vm.runInNewContext(source + '\nSemanticRetrieval;', { require, Buffer, Date: clock.Date, setTimeout: realTimer, clearTimeout: realTimer });
  const encoded = [], batches = []; let guards = 0, resolves = 0;
  const semantic = virtualApi.create({ prepare: async () => prepared, encode: async (texts, opts) => {
    if (opts.deadline - clock.now() < opts.minimumBudgetMs) return { ok: false, reason: 'timeout' };
    await clock.delay(1);
    if (opts.role === 'query') return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: [[1, 0]] };
    const ids = texts.map(text => Number(/^payload:(\d+)$/.exec(text)[1]));
    batches.push(ids); encoded.push(...ids);
    return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: ids.map(vector) };
  } });
  const docs = Array(9).fill('same metadata'), identities = docs.map((_, n) => ['source', n, 'revision-one']);
  const progress = []; let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = await semantic.score('query', docs, { scopeId: 'scope', identities, deadlineMs: 200,
      beforeEncode: async () => { guards++; await clock.delay(15); },
      resolveTexts: async indices => { resolves++; await clock.delay(75); return indices.map(n => 'payload:' + n); } });
    progress.push(result.coverage.cached); if (result.coverage.complete) break;
  }
  assert.ok(progress.some(count => count > 0), 'late source work must not produce a permanent zero-progress fixed point');
  assert.equal(result.coverage.complete, true, 'bounded retries eventually encode the complete authorized library');
  assert.deepEqual(encoded.slice().sort((a, b) => a - b), docs.map((_, n) => n), 'each original source identity is cached exactly once');
  assert.ok(batches.some(batch => batch.length < 4), 'the actual submitted prefix shrinks after source awaits');
  result.scores.forEach((score, n) => assert.ok(Math.abs(score - vector(n)[0]) < 1e-12, 'vector stays with source index ' + n));
  assert.ok(guards > 0 && resolves > 0);
});

test('revocation during delayed source resolution rejects before document encoding', async () => {
  const revoked = new Error('source.permission_revoked'); let allowed = true, documentCalls = 0;
  const semantic = api.create({ prepare: async () => prepared, encode: async (texts, opts) => {
    if (opts.role === 'document') documentCalls++;
    return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: texts.map(() => [1, 0]) };
  } });
  await assert.rejects(semantic.score('query', ['metadata'], { scopeId: 'scope', deadlineMs: 1000,
    beforeEncode: async () => { if (!allowed) throw revoked; },
    resolveTexts: async () => { await delay(15); allowed = false; return ['payload:0']; } }), error => error === revoked);
  assert.equal(documentCalls, 0);
});

test('post-inference source guard rejects without caching vectors for a revoked batch', async () => {
  const revoked = new Error('source.changed_after_inference'); let allowed = true, revokeNext = true, documentCalls = 0;
  const semantic = api.create({ prepare: async () => prepared, encode: async (texts, opts) => {
    await delay(5);
    if (opts.role === 'document') { documentCalls++; if (revokeNext) { revokeNext = false; allowed = false; } }
    return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: texts.map(() => [1, 0]) };
  } });
  const options = { scopeId: 'scope', identities: ['source-revision'], deadlineMs: 1000,
    beforeEncode: async () => { if (!allowed) throw revoked; }, resolveTexts: async () => ['payload:0'] };
  await assert.rejects(semantic.score('query', ['metadata'], options), error => error === revoked);
  allowed = true;
  const result = await semantic.score('query', ['metadata'], options);
  assert.equal(result.coverage.complete, true); assert.equal(documentCalls, 2, 'revoked output was not silently inserted in the cache');
});

test('runtime cost above the host cap shrinks batches and steadily completes slow documents', async () => {
  const encoded = [], batches = [];
  // A runtime may conservatively reserve more than the host's capped history.
  const estimate = (role, count) => role === 'document' ? Math.ceil(500 * 1.2 * count + 32) : 64;
  const runtime = { prepare: async () => prepared, estimateEncodingBudget: estimate,
    encode: async (texts, opts) => {
      if (opts.deadline - Date.now() < estimate(opts.role, texts.length)) return { ok: false, reason: 'timeout' };
      if (opts.role === 'query') return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: [[1, 0]] };
      const ids = texts.map(text => Number(/^payload:(\d+)$/.exec(text)[1]));
      assert.equal(texts.length, 1, 'two documents cannot fit the runtime prediction in one second');
      await delay(360 * texts.length); batches.push(ids); encoded.push(...ids);
      return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: ids.map(vector) };
    } };
  const semantic = api.create(runtime), docs = Array(7).fill('metadata'), progress = []; let result;
  for (let attempt = 0; attempt < 16; attempt++) {
    result = await semantic.score('query', docs, { scopeId: 'slow-scope', identities: docs.map((_, n) => n), deadlineMs: 1000,
      beforeEncode: async () => { await delay(2); },
      resolveTexts: async indices => { await delay(5); return indices.map(n => 'payload:' + n); } });
    progress.push(result.coverage.cached); if (result.coverage.complete) break;
  }
  assert.ok(progress.some(count => count > 0), 'the runtime/host cost mismatch cannot remain a zero-progress fixed point');
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(encoded.slice().sort((a, b) => a - b), docs.map((_, n) => n));
  result.scores.forEach((score, n) => assert.ok(Math.abs(score - vector(n)[0]) < 1e-12));
  assert.ok(batches.length > 1);
});

test('cost hints must be synchronous finite milliseconds in range, and cannot suppress revocation', async () => {
  for (const hint of [NaN, Infinity, -1, 60001, '200', null, Promise.resolve(50)]) {
    let calls = 0;
    const semantic = api.create({ prepare: async () => prepared, estimateEncodingBudget: () => hint,
      encode: async () => { calls++; return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: [[1, 0]] }; } });
    await assert.rejects(semantic.score('query', ['metadata'], { scopeId: 'bad-hint' }), /semantic\.invalid_budget_hint/);
    assert.equal(calls, 0);
  }
  let hints = 0; const revoked = new Error('source.permission_revoked');
  const semantic = api.create({ prepare: async () => prepared, estimateEncodingBudget: () => { hints++; return NaN; }, encode: async () => assert.fail('unauthorized encoding') });
  await assert.rejects(semantic.score('query', ['metadata'], { scopeId: 'revoked', beforeEncode: async () => { throw revoked; } }), error => error === revoked);
  assert.equal(hints, 0, 'the source guard retains precedence over cost scheduling');
});

test('send preflight can join a contended query before its deadline without encoding cold documents', async () => {
  const clock = virtualClock();
  const timers = (fn, ms) => clock.delay(ms).then(fn);
  const retrieval = vm.runInNewContext(source + '\nSemanticRetrieval;', { require, Buffer, Date: clock.Date, setTimeout: timers });
  let attempts = 0;
  const scorer = retrieval.create({
    prepare: async options => {
      assert.equal(options.budgetMs, 250);
      await clock.delay(180);
      return prepared;
    },
    encode: async (texts, options) => {
      assert.equal(options.role, 'query');
      if (++attempts === 1) return { ok: false, reason: 'overloaded' };
      await clock.delay(50);
      return { ok: true, modelFingerprint: prepared.modelFingerprint, vectors: texts.map(() => vector(0)) };
    },
  });
  const deadline = clock.now() + 400;
  const result = await scorer.score('question', ['memory'], {
    scopeId: 'send', purpose: 'search', waitForCompletion: true, deadline, maxEncodeDocuments: 0,
  });
  assert.equal(attempts, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.cached, 0);
  assert.ok(clock.now() <= deadline);
});
