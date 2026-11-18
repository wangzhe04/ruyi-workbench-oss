'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const fp = { modelFingerprint: 'model', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
const row = (sourceId, text, extra = {}) => ({ identity: { sourceId, field: 'content', revision: 'rev1', start: 0, end: text.length, ...extra }, text });
const options = (extra = {}) => ({ scopeId: 'scope', deadline: 1000, beforeVerify: async () => {}, ...extra });
const make = (overrides = {}, extra = {}) => {
  let calls = 0, prepares = 0, stops = 0;
  const host = { prepare: async () => { prepares++; return { ok: true, ...fp }; },
    verify: async (_q, source) => { calls++; return { ok: true, ...fp, score: source.text === 'yes' ? 1 : 0, accepted: source.text === 'yes' }; },
    stop: async () => { stops++; return { cleanupStatus: 'unknown', workerExited: false }; }, ...overrides };
  const underlyingVerify = host.verify; host.verify = async (query, source, opts) => { await opts.beforeVerify(); return underlyingVerify(query, source, opts); };
  const bridge = createScalarVerifierBridge(host, { now: () => 0, ...extra });
  return { bridge, counts: () => ({ calls, prepares, stops }) };
};

test('scalar endpoints 0 and 1 retain distinct same-field verdicts and cache only exact identities', async () => {
  const { bridge, counts } = make(), input = [row('a', 'yes'), row('a', 'no', { field: 'other' })];
  const first = await bridge.verify('question', input, options());
  assert.deepEqual(first.results, [{ identity: input[0].identity, accepted: true, score: 1, cached: false }, { identity: input[1].identity, accepted: false, score: 0, cached: false }]);
  assert.equal(first.coverage.complete, true); const second = await bridge.verify('question', input, options());
  assert.ok(second.results.every(item => item.cached)); assert.equal(counts().calls, 2);
  await bridge.verify('question', [row('a', 'yes', { revision: 'rev2' })], options());
  await bridge.verify('different', [row('a', 'yes')], options());
  await bridge.verify('question', [row('a', 'yes')], options({ scopeId: 'other' }));
  assert.equal(counts().calls, 5);
});

test('model/template/runtime/policy changes independently invalidate cache', async () => {
  for (const changed of Object.keys(fp)) {
    let current = { ...fp }, calls = 0;
    const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...current }), verify: async (_q, _s, opts) => { await opts.beforeVerify(); calls++; return { ok: true, ...current, score: 0.5, accepted: false }; }, stop: async () => {} }, { now: () => 0 });
    await bridge.verify('q', [row('a', 'abc')], options()); current = { ...current, [changed]: 'changed' };
    await bridge.verify('q', [row('a', 'abc')], options()); assert.equal(calls, 2, changed);
  }
});

test('snapshots before any await and never binds mutated caller values to the cached result', async () => {
  const calls = [], input = [row('a', 'yes')];
  const { bridge } = make({ verify: async (_q, source) => { calls.push(source); assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source.identity)); return { ok: true, ...fp, score: 1, accepted: true }; } });
  const output = await bridge.verify('q', input, options({ beforeVerify: async ({ phase }) => { if (phase === 'start') { input[0].text = 'not'; input[0].identity.sourceId = 'changed'; } } }));
  assert.equal(output.results[0].identity.sourceId, 'a'); assert.ok(Object.isFrozen(output.results[0].identity));
  assert.equal(calls[0].text, 'yes'); assert.equal(calls[0].identity.sourceId, 'a');
  await bridge.verify('q', [row('a', 'yes')], options()); assert.equal(calls.length, 1);
  await bridge.verify('q', [row('changed', 'not')], options()); assert.equal(calls.length, 2);
});

test('revocation on cache hit and during inference propagates and never caches invalid response', async () => {
  let allowed = true, calls = 0; const denied = Error('authority revoked');
  const { bridge } = make({ verify: async () => { calls++; if (calls === 2) allowed = false; return { ok: true, ...fp, score: 1, accepted: true }; } });
  const guard = async () => { if (!allowed) throw denied; };
  await bridge.verify('q', [row('a', 'yes')], options({ beforeVerify: guard }));
  allowed = false; await assert.rejects(bridge.verify('q', [row('a', 'yes')], options({ beforeVerify: guard })), error => error === denied);
  allowed = true; await assert.rejects(bridge.verify('q', [row('b', 'yes')], options({ beforeVerify: guard })), error => error === denied);
  allowed = true; await bridge.verify('q', [row('b', 'yes')], options({ beforeVerify: guard })); assert.equal(calls, 3);
});

test('timeouts and unavailable keep prior scores, mark remaining unknown and never cache unknown', async () => {
  let calls = 0, available = false; const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }),
    verify: async (_q, source, opts) => { await opts.beforeVerify(); calls++; return source.identity.sourceId === 'b' && !available ? { ok: false, reason: 'timeout' } : { ok: true, ...fp, score: 0, accepted: false }; }, stop: async () => {} }, { now: () => 0 });
  const sources = [row('a', 'yes'), row('b', 'yes')], first = await bridge.verify('q', sources, options());
  assert.equal(first.status, 'partial'); assert.equal(first.reason, 'timeout'); assert.deepEqual(first.coverage, { total: 2, completed: 1, complete: false }); assert.equal(first.results[1].accepted, null);
  available = true; const second = await bridge.verify('q', sources, options()); assert.equal(second.coverage.complete, true); assert.equal(second.results[0].cached, true); assert.equal(second.results[1].cached, false); assert.equal(calls, 3);
});

test('deadline after final authority check remains partial, including completed scores', async () => {
  let time = 0; const { bridge } = make({}, { now: () => time });
  const result = await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5, beforeVerify: async ({ phase }) => { if (phase === 'finish') time = 5; } }));
  assert.equal(result.results[0].accepted, true); assert.equal(result.status, 'partial'); assert.equal(result.reason, 'timeout'); assert.equal(result.coverage.complete, false);
});

test('hard native error and falsy abort or guard reasons propagate unchanged', async () => {
  const hard = Error('native protocol'); const { bridge } = make({ verify: async () => { throw hard; } });
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options()), error => error === hard);
  for (const value of [0, false, '']) {
    const controller = new AbortController(); controller.abort(value); let observed = Symbol();
    try { await bridge.verify('q', [row('a', 'yes')], options({ signal: controller.signal })); } catch (error) { observed = error; }
    assert.equal(observed, value);
    observed = Symbol(); try { await bridge.verify('q', [row('a', 'yes')], options({ beforeVerify: () => { throw value; } })); } catch (error) { observed = error; }
    assert.equal(observed, value);
  }
});

test('mismatched fingerprints and invalid scalar responses are hard errors, not cached', async () => {
  for (const response of [{ ...fp, modelFingerprint: 'wrong', score: 1, accepted: true }, { ...fp, score: [1], accepted: true }, { ...fp, score: NaN, accepted: false }, { ...fp, score: 0.5, accepted: null }]) {
    let calls = 0; const { bridge } = make({ verify: async () => { calls++; return { ok: true, ...response }; } });
    await assert.rejects(bridge.verify('q', [row('a', 'yes')], options())); await assert.rejects(bridge.verify('q', [row('a', 'yes')], options())); assert.equal(calls, 2);
  }
});

test('bounded LRU evicts old verdicts and stop does not invent cleanup proof', async () => {
  const { bridge, counts } = make({}, { cacheLimit: 1 });
  await bridge.verify('q', [row('a', 'yes')], options()); await bridge.verify('q', [row('b', 'yes')], options());
  await bridge.verify('q', [row('a', 'yes')], options()); assert.equal(counts().calls, 3);
  assert.deepEqual(await bridge.stop(), { cleanupStatus: 'unknown', workerExited: false });
});

test('rejects identity aliasing, nested objects, getters and inconsistent window coordinates', async () => {
  const { bridge } = make(), nested = row('a', 'yes', { owner: { id: 'x' } }), wrong = row('a', 'yes', { end: 4 });
  const getter = row('a', 'yes'); Object.defineProperty(getter.identity, 'epoch', { enumerable: true, get() { throw Error('must not invoke'); } });
  for (const item of [nested, wrong, getter]) await assert.rejects(bridge.verify('q', [item], options()), /scalar.source_invalid/);
});

test('hard transport error remains primary if cancellation races with it', async () => {
  const controller = new AbortController(), hard = Error('protocol failure');
  const { bridge } = make({ verify: async () => { controller.abort(false); throw hard; } });
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options({ signal: controller.signal })), error => error === hard);
});

test('deadline during prepare or verification never caches a late response', async () => {
  let time = 0, calls = 0;
  const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }), verify: async (_q, _s, opts) => { await opts.beforeVerify(); calls++; time = 5; return { ok: true, ...fp, score: 1, accepted: true }; }, stop: async () => {} }, { now: () => time });
  const first = await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5 }));
  assert.equal(first.reason, 'timeout'); assert.equal(first.results[0].accepted, null);
  time = 0; await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5 })); assert.equal(calls, 2);
  time = 5; const before = calls; const expired = await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5 })); assert.equal(expired.reason, 'timeout'); assert.equal(calls, before);
});

test('identity requires a plain own-data object and never invokes inherited getters', async () => {
  const { bridge } = make(); let invoked = false;
  const identity = Object.assign(Object.create({ get sourceId() { invoked = true; return 'forged'; } }), { field: 'content', revision: 'rev', start: 0, end: 3 });
  await assert.rejects(bridge.verify('q', [{ identity, text: 'yes' }], options()), /scalar.source_invalid/); assert.equal(invoked, false);
});

test('clear invalidates pending cache hits and in-flight responses', async () => {
  let calls = 0, clearDuringVerify = false; let bridge;
  bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }), verify: async (_q, _s, opts) => { await opts.beforeVerify(); calls++; if (clearDuringVerify) bridge.clear(); return { ok: true, ...fp, score: 1, accepted: true }; }, stop: async () => {} }, { now: () => 0 });
  await bridge.verify('q', [row('a', 'yes')], options());
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options({ beforeVerify: ({ phase }) => { if (phase === 'cached') bridge.clear(); } })), /scalar.cache_invalidated/);
  clearDuringVerify = true; await assert.rejects(bridge.verify('q', [row('a', 'yes')], options()), /scalar.cache_invalidated/);
  clearDuringVerify = false; await bridge.verify('q', [row('a', 'yes')], options()); assert.equal(calls, 3);
});

test('transport hook blocks a real text write after source revocation inside host await', async () => {
  let allowed = true, writes = 0; const denied = Error('source revoked inside transport');
  const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }),
    verify: async (_q, _source, opts) => { await Promise.resolve(); allowed = false; await opts.beforeVerify(); writes++; return { ok: true, ...fp, score: 1, accepted: true }; }, stop: async () => {} }, { now: () => 0 });
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options({ beforeVerify: () => { if (!allowed) throw denied; } })), error => error === denied);
  assert.equal(writes, 0);
});

test('transport hook blocks a real text write after clear during host await', async () => {
  let writes = 0, bridge;
  bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }),
    verify: async (_q, _source, opts) => { await Promise.resolve(); bridge.clear(); await opts.beforeVerify(); writes++; return { ok: true, ...fp, score: 1, accepted: true }; }, stop: async () => {} }, { now: () => 0 });
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options()), /scalar.cache_invalidated/); assert.equal(writes, 0);
});

test('transport hook blocks writes after deadline and reports partial without caching', async () => {
  let time = 0, writes = 0, calls = 0;
  const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }),
    verify: async (_q, _source, opts) => { calls++; await Promise.resolve(); time = 5; await opts.beforeVerify(); writes++; return { ok: true, ...fp, score: 1, accepted: true }; }, stop: async () => {} }, { now: () => time });
  const result = await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5 })); assert.equal(result.reason, 'timeout'); assert.equal(result.results[0].accepted, null); assert.equal(writes, 0);
  time = 0; await bridge.verify('q', [row('a', 'yes')], options({ deadline: 5 })); assert.equal(calls, 2);
});

test('a successful host response without its transport guard is a hard failure', async () => {
  const bridge = createScalarVerifierBridge({ prepare: async () => ({ ok: true, ...fp }),
    verify: async () => ({ ok: true, ...fp, score: 1, accepted: true }), stop: async () => {} }, { now: () => 0 });
  await assert.rejects(bridge.verify('q', [row('a', 'yes')], options()), /scalar.transport_guard_missing/);
});
