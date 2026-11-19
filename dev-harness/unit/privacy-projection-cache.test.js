'use strict';
// 150 P14: history projection cache. Hits must be byte-identical to the uncached gateway, every
// input that can change a projection must miss, limits replay exactly, and errors still surface.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway, loadPrimitives } = require('../lib/privacy-test-fixture');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/03a-privacy-gateway.js'), 'utf8');
const config = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [{ id: 'x', apiKey: 'fixture-auth-key' }] };
const REF = /\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g;

// Reference implementation: the same gateway with both cache entry points switched off.
function uncachedSource() {
  const swaps = [['trustedToolSchemas: true, historyCache: true,', 'trustedToolSchemas: true, historyCache: false,'],
    ['const cacheRows = !referenceHints && scope && cacheContext?.scope === scope;', 'const cacheRows = false;']];
  let text = source;
  for (const [from, to] of swaps) { assert.equal(text.split(from).length, 2, 'uncached reference anchor drifted: ' + from); text = text.replace(from, to); }
  return text;
}
// Type-, prototype- and hole-aware rendering: stricter than the JSON sent on the wire.
function exact(value) {
  if (Array.isArray(value)) return '[' + Array.from({ length: value.length }, (_, i) => i in value ? exact(value[i]) : '<hole>').join(',') + ']';
  if (value && typeof value === 'object') return (Object.getPrototypeOf(value) === null ? 'N{' : 'P{') + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ':' + exact(v)).join(',') + '}';
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value + ':' + (Object.is(value, -0) ? '-0' : String(value));
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-pcache-'));
  t.after(() => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-privacy-pcache-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = fixture(options.fixture), api = gateway(root, f, options.gateway);
  api.configure(options.config || config);
  // A second process view over the same mapping file and vault, without any cache.
  const plain = (policy = options.config || config) => { const g = gateway(root, f, { ...options.gateway, source: uncachedSource() }); g.configure(policy); return g; };
  // Hits a cold (empty-cache) gateway gets for the same request from the same persisted state.
  // A learning request legitimately hits its own earlier pass; anything above that is stale reuse.
  const coldHits = async (policy, scopeId, body) => {
    const g = gateway(root, f, options.gateway); g.configure(policy);
    await g.run(scopeId, policy, () => g.beforeModelRequest(structuredClone(body)));
    return g.projectionCacheStats().hits;
  };
  return { root, f, api, plain, coldHits };
}
// Request hit delta on the warm gateway.
async function warmHits(api, policy, scopeId, body) {
  const before = hits(api); let wire;
  await api.run(scopeId, policy, async () => { wire = await api.beforeModelRequest(structuredClone(body)); });
  return { wire, delta: hits(api) - before };
}
const hits = api => api.projectionCacheStats().hits;
const email = 'cache-contact@example.test', phone = '13800138000';
function chatBody(tail = 'continue') {
  return { model: 'fake', stream: true, tools: [{ type: 'function', function: { name: 'file_read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], messages: [
    { role: 'user', content: '请联系 ' + email + '，电话 ' + phone + '。普通说明。' },
    { role: 'assistant', content: 'Reading it.', name: undefined, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: 'notes/' + email + '.md' }) } }] },
    { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ ok: true, content: 'line one\nowner: ' + email + '\n"quoted"\t-0', size: -0 }) },
    { role: 'tool', tool_call_id: 'call-2', content: '{"apiKey":null,"phone":13600005555}' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'user', content: tail },
  ] };
}
function anthropicBody(tail = 'continue') {
  return { model: 'fake', system: 'public', messages: [
    { role: 'user', content: [{ type: 'text', text: 'mail ' + email }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu-1', name: 'file_read', input: { path: 'a/' + email } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'result for ' + phone }] },
    { role: 'user', content: [{ type: 'text', text: tail }] },
  ] };
}
function responsesBody(tail = 'continue') {
  return { model: 'fake', instructions: 'public', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'reach ' + email }] },
    { type: 'reasoning', summary: [{ type: 'reasoning_text', text: 'thinking about ' + phone }] },
    { type: 'function_call', call_id: 'fc-1', name: 'file_read', arguments: JSON.stringify({ path: email }) },
    { type: 'function_call_output', call_id: 'fc-1', output: '{"password":null}' },
    { role: 'user', content: [{ type: 'input_text', text: tail }] },
  ] };
}

test('cache hits are byte-identical to the uncached gateway across chat, Anthropic and Responses bodies', async t => {
  const { api, plain } = setup(t);
  for (const [name, build] of [['chat', chatBody], ['anthropic', anthropicBody], ['responses', responsesBody]]) {
    const scopeId = 'diff-' + name;
    let first, second, third, reference;
    await api.run(scopeId, config, async () => {
      // An already-issued reference inside history takes the validated-reference path.
      reference = api.active().scope.protectValue('issued-before@example.test', 'EMAIL');
      const body = build();
      (body.messages || body.input)[0] = name === 'chat' ? { role: 'user', content: 'see ' + reference + ' and ' + email } : (body.messages || body.input)[0];
      first = await api.beforeModelRequest(structuredClone(body));
      const before = hits(api);
      second = await api.beforeModelRequest(structuredClone(body));
      assert.ok(hits(api) - before >= (body.messages || body.input).length - 1, name + ': repeated history slots are served from the cache');
      third = await api.beforeModelRequest(build('next step'));
    });
    const other = plain();
    let expected, expectedNext;
    await other.run(scopeId, config, async () => {
      const body = build();
      (body.messages || body.input)[0] = name === 'chat' ? { role: 'user', content: 'see ' + reference + ' and ' + email } : (body.messages || body.input)[0];
      expected = await other.beforeModelRequest(body);
      expectedNext = await other.beforeModelRequest(build('next step'));
    });
    assert.equal(exact(second), exact(expected), name + ': hit equals the uncached projection');
    assert.equal(exact(first), exact(second), name + ': hit equals the first (uncached) projection');
    assert.equal(JSON.stringify(second), JSON.stringify(expected), name + ': identical wire bytes');
    assert.equal(exact(third), exact(expectedNext), name + ': changed tail with cached history equals uncached');
    assert.ok(!JSON.stringify(second).includes(email) && !JSON.stringify(second).includes(phone), name + ': originals never leave');
  }
});

test('host history rows: cached clean rows rebuild the same copies, originals links and refusals', async t => {
  const { api, plain } = setup(t);
  const forged = '[[RUYI_PVT:EMAIL:' + 'e'.repeat(32) + ']]';
  let rows, reference, first, second, restored;
  await api.run('host-diff', config, async () => {
    reference = api.active().scope.protectValue('host-row@example.test', 'EMAIL');
    rows = [
      { role: 'user', content: 'valid ' + reference },
      { role: 'assistant', content: [{ type: 'text', text: 'ok ' + reference }, { type: 'tool_use', id: 'u', name: 'file_read', input: { path: reference } }], tool_calls: [{ id: 'c', function: { name: 'file_read', arguments: '{"path":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'forged ' + forged },
      { role: 'assistant', content: 'plain narration' },
      { role: 'user', content: 'mentions host-row@example.test in plain text' },
    ];
    const owner = {}; api.bindHostHistory(owner, rows);
    const tail = { role: 'user', content: 'current question' };
    first = api.projectHostHistory(owner, [...rows, tail]);
    const before = hits(api);
    second = api.projectHostHistory(owner, [...rows, tail]);
    assert.ok(hits(api) - before >= 3, 'clean historical rows hit');
    restored = api.restoreHostHistoryProjection(owner, second);
    await api.beforeModelRequest({ messages: [{ role: 'user', content: 'persist' }] });
  });
  const other = plain(); let expected;
  await other.run('host-diff', config, async () => { const owner = {}; other.bindHostHistory(owner, rows); expected = other.projectHostHistory(owner, [...rows, { role: 'user', content: 'current question' }]); });
  assert.equal(exact(second), exact(expected)); assert.equal(exact(first), exact(second));
  assert.ok(second[2].content.includes('privacy.reference_unavailable_history'), 'forged reference still refused on a repeated projection');
  assert.notEqual(second[1], rows[1], 'assistant rows are still projected copies');
  assert.equal(restored[1], rows[1], 'copies made on a hit still restore to their originals');
  assert.equal(restored[0], rows[0]);
});

test('policy, rule, mode and detector option changes never reuse a cached projection', async t => {
  const { api, plain, coldHits } = setup(t);
  const body = { messages: [{ role: 'user', content: 'project codename ORCHID-LAKE-7 details' }, { role: 'user', content: 'go' }] };
  await warmHits(api, config, 'policy', body); assert.ok((await warmHits(api, config, 'policy', body)).delta >= 2, 'precondition: warm');
  // Rule added: the cached history text must now be protected.
  const ruled = { ...config, privacyRulesV1: [{ id: 'codename', kind: 'literal', value: 'ORCHID-LAKE-7', category: 'INTERNAL' }] };
  api.configure(ruled);
  const cold = await coldHits(ruled, 'policy', body), warm = await warmHits(api, ruled, 'policy', body);
  assert.ok(!JSON.stringify(warm.wire).includes('ORCHID-LAKE-7'), 'new literal rule applies to cached history');
  assert.ok(warm.delta <= cold, 'no entry from before the rule change is reused: ' + warm.delta + ' > ' + cold);
  const other = plain(ruled); let expected;
  await other.run('policy', ruled, async () => { expected = await other.beforeModelRequest(structuredClone(body)); });
  assert.equal(JSON.stringify(warm.wire).replace(REF, 'R'), JSON.stringify(expected).replace(REF, 'R'));
  // Mode change basic -> enhanced: personal detection starts applying to cached history.
  const basic = { ...config, privacyModeV1: 'basic' };
  const mail = { messages: [{ role: 'user', content: 'mail mode-switch@example.test now' }, { role: 'user', content: 'go' }] };
  api.configure(basic);
  await warmHits(api, basic, 'mode', mail); const basicWarm = await warmHits(api, basic, 'mode', mail);
  assert.ok(JSON.stringify(basicWarm.wire).includes('mode-switch@example.test') && basicWarm.delta >= 2, 'basic mode leaves e-mail, warm (precondition)');
  api.configure(config);
  const modeCold = await coldHits(config, 'mode', mail), enhanced = await warmHits(api, config, 'mode', mail);
  assert.ok(!JSON.stringify(enhanced.wire).includes('mode-switch@example.test'), 'enhanced mode protects cached history');
  assert.ok(enhanced.delta <= modeCold, 'no entry from basic mode is reused');
  // Technical flag is a detector option (policy signature) as well.
  const technical = { ...config, privacyTechnicalV1: true };
  await warmHits(api, config, 'tech', mail); assert.ok((await warmHits(api, config, 'tech', mail)).delta >= 2);
  api.configure(technical);
  const techCold = await coldHits(technical, 'tech', mail), tech = await warmHits(api, technical, 'tech', mail);
  assert.ok(tech.delta <= techCold, 'technical option change misses');
});

test('learned values added later rewrite cached history in the same request and afterwards', async t => {
  const { api, plain } = setup(t);
  const secret = 'Xq7-learned-' + 'k'.repeat(12);
  const history = [{ role: 'user', content: 'note that ' + secret + ' was mentioned in passing' }, { role: 'assistant', content: 'noted' }];
  let wire, next;
  await api.run('learn', config, async () => {
    const plainWire = await api.beforeModelRequest({ messages: [...history, { role: 'user', content: 'hello' }] });
    assert.ok(JSON.stringify(plainWire).includes(secret), 'precondition: not yet sensitive');
    await api.beforeModelRequest({ messages: [...history, { role: 'user', content: 'hello' }] });
    wire = await api.beforeModelRequest({ messages: [...history, { role: 'user', content: 'password: ' + secret }] });
    next = await api.beforeModelRequest({ messages: [...history, { role: 'user', content: 'hello' }] });
  });
  assert.ok(!JSON.stringify(wire).includes(secret), 'tail learning rewrites cached history in the same request');
  assert.ok(!JSON.stringify(next).includes(secret), 'and every later request');
  const other = plain(); let expected;
  await other.run('learn', config, async () => { expected = await other.beforeModelRequest({ messages: [...history, { role: 'user', content: 'hello' }] }); });
  assert.equal(JSON.stringify(next), JSON.stringify(expected));
});

test('revocation invalidates cached request slots and host-history verdicts', async t => {
  const { api } = setup(t);
  await api.run('revoke', config, async () => {
    const value = 'revoked-later@example.test', token = api.active().scope.protectValue(value, 'EMAIL');
    const rows = [{ role: 'user', content: 'contact ' + value }, { role: 'tool', tool_call_id: 'c', content: 'echo ' + token }];
    const body = () => ({ messages: [rows[0], { role: 'user', content: 'go' }] });
    await api.beforeModelRequest(body()); await api.beforeModelRequest(body());
    const owner = {}; api.bindHostHistory(owner, rows);
    api.projectHostHistory(owner, rows); const clean = api.projectHostHistory(owner, rows);
    assert.equal(clean[1], rows[1], 'precondition: valid reference row is clean');
    api.active().scope.revoke(token);
    // Host rows first: no store has happened since the revocation, so only the key can reject them.
    const after = api.projectHostHistory(owner, rows);
    assert.match(after[1].content, /privacy\.reference_unavailable_history/, 'revoked reference row is refused, not reused');
    assert.notEqual(after[0], rows[0], 'revoked original in history is withheld');
    await assert.rejects(api.beforeModelRequest(body()), /privacy\.reference_revoked/, 'revoked value is not served from the cache');
  });
});

test('rule catalog version, scope identity and policy epoch are part of every key', async t => {
  const f = fixture(), core = { ...f.PrivacyCore, configHooks: { sealLocal: f.vault.sealLocal, openLocal: f.vault.openLocal } };
  const { api, coldHits } = setup(t, { fixture: undefined, gateway: { core } });
  const body = () => ({ messages: [{ role: 'user', content: 'catalog ' + email }, { role: 'user', content: 'go' }] });
  let a, b;
  await api.run('catalog', config, async () => { await api.beforeModelRequest(body()); a = await api.beforeModelRequest(body()); });
  core.ruleCatalogVersion = (core.ruleCatalogVersion || 1) + 1;
  let h = hits(api);
  await api.run('catalog', config, async () => { b = await api.beforeModelRequest(body()); });
  assert.equal(hits(api), h, 'rule catalog version change misses');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same rules, same projection');
  // Another conversation scope with identical content never hits.
  const otherCold = await coldHits(config, 'catalog-other', body());
  const { wire: foreign, delta } = await warmHits(api, config, 'catalog-other', body());
  assert.ok(delta <= otherCold, 'different scope never reuses the slots of another scope');
  assert.notEqual(JSON.stringify(foreign).match(REF)[0], JSON.stringify(b).match(REF)[0], 'each scope issues its own references');
  // Unavailable policy refuses even fully cached bodies; recovery starts a new epoch.
  api.markUnavailable();
  await assert.rejects(api.run('catalog', config, () => api.beforeModelRequest(body())), /privacy\.policy_unavailable/);
  api.configure(config); h = hits(api);
  await api.run('catalog', config, async () => { await api.beforeModelRequest(body()); });
  assert.equal(hits(api), h, 'new policy epoch misses');
});

test('absolute pointers are part of the key: a field rule on a shifted slot is applied', async t => {
  const ruled = { ...config, privacyRulesV1: [{ id: 'second-slot', kind: 'field', value: '/messages/2/content', category: 'INTERNAL' }] };
  const { api, plain } = setup(t, { config: ruled });
  const row = { role: 'user', content: 'ordinary slot text' };
  let shifted;
  await api.run('pointer', ruled, async () => {
    const first = await api.beforeModelRequest({ messages: [row, { role: 'user', content: 'a' }] });
    assert.ok(JSON.stringify(first).includes('ordinary slot text'), 'precondition: /messages/1 is not covered');
    await api.beforeModelRequest({ messages: [row, { role: 'user', content: 'a' }] });
    shifted = await api.beforeModelRequest({ messages: [{ role: 'user', content: 'b' }, row] });
  });
  const other = plain(ruled); let expected;
  await other.run('pointer', ruled, async () => { expected = await other.beforeModelRequest({ messages: [{ role: 'user', content: 'b' }, row] }); });
  assert.equal(JSON.stringify(shifted), JSON.stringify(expected));
  assert.ok(!JSON.stringify(shifted).includes('ordinary slot text'), 'same content at the ruled pointer is protected');
});

test('fingerprints keep lone surrogates, holes, null, -0 and undefined apart', async t => {
  const { api } = setup(t);
  const variants = [
    { role: 'user', content: 'lone \uD800 high' }, { role: 'user', content: 'lone \uDBFF high' },
    // eslint-disable-next-line no-sparse-arrays
    { role: 'user', content: [, { type: 'text', text: 'after hole' }] }, { role: 'user', content: [null, { type: 'text', text: 'after hole' }] },
    { role: 'assistant', content: 'n', extra: 0 }, { role: 'assistant', content: 'n', extra: -0 },
    { role: 'assistant', content: 'u', extra: undefined }, { role: 'assistant', content: 'u', extra: null },
  ];
  await api.run('fingerprint', config, async () => {
    const seen = [];
    for (const row of [...variants, ...variants]) {
      const wire = await api.beforeModelRequest({ messages: [row, { role: 'user', content: 'go' }] });
      seen.push(exact(wire.messages[1]));
    }
    for (let i = 0; i < variants.length; i++) {
      assert.equal(seen[i + variants.length], seen[i], 'repeat of variant ' + i + ' is stable');
      if (i % 2) assert.notEqual(seen[i], seen[i - 1], 'variant ' + i + ' is not confused with its look-alike');
    }
  });
});

test('reference expiry invalidates cached slots although the scope revision is unchanged', async t => {
  let now = Date.UTC(2026, 0, 1);
  class FakeDate extends Date { static now() { return now; } }
  const { api } = setup(t, { fixture: { primitives: loadPrimitives({ Date: FakeDate }) } });
  const value = 'expiring@example.test';
  await api.run('expiry', config, async () => {
    const token = api.active().scope.protectValue(value, 'EMAIL');
    const rows = [{ role: 'user', content: 'mail ' + value }, { role: 'tool', tool_call_id: 'c', content: 'ref ' + token }];
    const body = () => ({ messages: [rows[0], { role: 'user', content: 'go' }] });
    await api.beforeModelRequest(body()); await api.beforeModelRequest(body());
    const owner = {}; api.bindHostHistory(owner, rows); api.projectHostHistory(owner, rows);
    assert.equal(api.projectHostHistory(owner, rows)[1], rows[1]);
    const revision = api.active().scope.revision();
    now += 366 * 86400000;
    assert.equal(api.active().scope.revision(), revision, 'expiry does not bump revision');
    await assert.rejects(api.beforeModelRequest(body()), /privacy\.reference_expired/);
    assert.match(api.projectHostHistory(owner, rows)[1].content, /privacy\.reference_unavailable_history/);
  });
});

test('hits replay node and match budgets so request limits fail exactly as without the cache', async t => {
  const { api, plain } = setup(t);
  const learned = 'limit-replay@example.test ';
  const history = [{ role: 'user', content: learned.repeat(1500) }, { role: 'user', content: learned.repeat(1500) }];
  const matchBodies = [{ messages: history }, { messages: history }, { messages: [...history, { role: 'user', content: learned.repeat(3000) }] }];
  const outcomes = async (g, bodies, send = 'beforeModelRequest') => {
    const result = [];
    await g.run('limits', config, async () => {
      if (g === api && !api.active().scope.size()) api.active().scope.protectValue(learned.trim(), 'EMAIL');
      for (const body of bodies) { try { await g[send](body); result.push('ok'); } catch (error) { result.push(error.code); } }
    });
    return result;
  };
  // Match budget: the uncached gateway over the same mapping is the reference.
  const cached = await outcomes(api, matchBodies), reference = await outcomes(plain(), matchBodies);
  assert.deepEqual(cached, reference);
  assert.deepEqual(cached, ['ok', 'ok', 'privacy.learned_scan_limit'], 'the tail alone fits; history plus tail exceeds the request budget');
  // Node budget (50000 per request): a cached 36000-node history plus a 15000-node tail must still fail.
  // Cheap string leaves keep this fast; the uncached outcome of these sizes is pinned literally.
  // beforeRequest has no content-recovery prepass, whose own node counter would mask the transform's.
  const leaves = n => Array.from({ length: n }, () => 'p');
  const wide = [{ role: 'user', content: leaves(36000) }];
  assert.deepEqual(await outcomes(api, [{ messages: wide }, { messages: wide }, { messages: [{ role: 'user', content: leaves(15000) }] }, { messages: [...wide, { role: 'user', content: leaves(15000) }] }], 'beforeRequest'),
    ['ok', 'ok', 'ok', 'privacy.structure_limit']);
});

test('core accessors: budget replay is atomic and the expiry horizon follows the scope clock', () => {
  const { PrivacyCore: core } = loadPrimitives();
  const budget = core.createMatchBudget(10, 5);
  const left = () => { const { comparisons, matches } = core.budgetRemaining(budget); return { comparisons, matches }; };
  assert.deepEqual(left(), { comparisons: 10, matches: 5 });
  assert.equal(core.replayBudget(budget, { comparisons: 4, matches: 6 }), false, 'insufficient matches');
  assert.deepEqual(left(), { comparisons: 10, matches: 5 }, 'a refused replay spends nothing');
  assert.equal(core.replayBudget(budget, { comparisons: 4, matches: 5 }), true);
  assert.deepEqual(left(), { comparisons: 6, matches: 0 });
  assert.throws(() => core.replayBudget(budget, { comparisons: -1, matches: 0 }), /scan_budget_invalid/);
  assert.throws(() => core.budgetRemaining({}), /scan_budget_invalid/);
  let now = 1000;
  const scope = core.createScope({ scopeId: 'horizon', detector: core.createDetector(), ttlMs: 100, clock: () => now });
  assert.equal(scope.expiryHorizon(), Infinity);
  scope.protectValue('first@example.test', 'EMAIL'); now = 1050; scope.protectValue('second@example.test', 'EMAIL');
  assert.equal(scope.expiryHorizon(), 1100); assert.equal(scope.reachedHorizon(1100), false);
  now = 1100; assert.equal(scope.reachedHorizon(1100), true, 'expiry at the horizon instant counts as reached');
  assert.equal(scope.expiryHorizon(), 1150, 'already expired entries do not hold the horizon down');
  // Learned-index builds are reported apart from scan work; warming an existing index is free.
  const learned = core.createScope({ scopeId: 'index-cost', detector: core.createDetector(), ttlMs: 1000 });
  for (let i = 0; i < 50; i++) learned.protectValue('index-cost-' + i + '@example.test', 'EMAIL');
  const first = core.createMatchBudget(); learned.detect('plain text', { budget: first });
  const built = core.budgetRemaining(first);
  assert.ok(built.indexBuilt > 0 && built.touches[0] === 1, 'first scan builds and charges the index');
  const second = core.createMatchBudget(); learned.detect('plain text', { budget: second });
  assert.equal(core.budgetRemaining(second).indexBuilt, 0, 'a cached index costs nothing');
  const warm = core.createMatchBudget(); learned.warmLearnedIndexes([0], warm);
  assert.deepEqual([core.budgetRemaining(warm).indexBuilt, core.budgetRemaining(warm).comparisons], [0, core.LIMITS.learnedComparisons]);
  learned.protectValue('index-cost-new@example.test', 'EMAIL');
  const rebuilt = core.createMatchBudget(); learned.warmLearnedIndexes([0], rebuilt);
  const state = core.budgetRemaining(rebuilt);
  assert.ok(state.indexBuilt > 0 && state.indexBuilt === core.LIMITS.learnedComparisons - state.comparisons, 'warming a missing index charges exactly its build');
  assert.throws(() => learned.warmLearnedIndexes([2], rebuilt), /scan_budget_invalid/);
});

test('two scopes at the same revision with the same content never share a slot', async t => {
  const { api } = setup(t);
  const body = () => ({ messages: [{ role: 'user', content: 'twin ' + email + ' and ' + phone }, { role: 'user', content: 'go' }] });
  const wires = {};
  for (const scopeId of ['twin-a', 'twin-b']) {
    await api.run(scopeId, config, async () => {
      await api.beforeModelRequest(body()); wires[scopeId] = await api.beforeModelRequest(body());
      // Every reference sent for this scope must belong to this scope.
      for (const token of JSON.stringify(wires[scopeId]).match(REF)) api.active().scope.validateProtected(token);
    });
  }
  assert.notEqual(JSON.stringify(wires['twin-a']), JSON.stringify(wires['twin-b']));
});

test('host media projections, errors and cancellation are never served from the cache', async t => {
  const { api } = setup(t); let mediaCalls = 0;
  api.setHost({ projectMediaPart: item => item?.type === 'image_ref' ? (mediaCalls++, { type: 'image_ref', ref: 'host-owned' }) : null });
  const media = () => ({ messages: [{ role: 'user', content: [{ type: 'image_ref', ref: 'x' }, { type: 'text', text: 'see image' }] }, { role: 'user', content: 'go' }] });
  await api.run('media', config, async () => {
    await api.beforeModelRequest(media()); await api.beforeModelRequest(media());
    assert.equal(mediaCalls, 2, 'host media capability is consulted on every request');
    const typed = { messages: [{ role: 'user', content: '{"apiKey":null}' }, { role: 'user', content: 'go' }] };
    await assert.rejects(api.beforeRequest(structuredClone(typed)), /privacy\.typed_sensitive/);
    await assert.rejects(api.beforeRequest(structuredClone(typed)), /privacy\.typed_sensitive/, 'failing slots are never cached');
    const body = { messages: [{ role: 'user', content: 'cached ' + email }, { role: 'user', content: 'go' }] };
    await api.beforeModelRequest(body); await api.beforeModelRequest(body);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.beforeModelRequest(body, { signal: controller.signal }), error => error.name === 'AbortError');
    const controls = { messages: body.messages, metadata: { apiKey: null } };
    await assert.rejects(api.beforeModelRequest(controls), /privacy\.typed_sensitive/, 'control data still refused next to cached history');
  });
});

test('cached outputs are isolated from callers, bounded, memory-only and absent when privacy is off', async t => {
  const { api, root } = setup(t);
  const body = () => ({ messages: [{ role: 'user', content: 'isolated ' + email }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: 'go' }] });
  await api.run('isolation', config, async () => {
    const first = await api.beforeModelRequest(body());
    first.messages[1].content = 'tampered'; first.messages[2].content[0].text = 'tampered';
    const second = await api.beforeModelRequest(body());
    second.messages[1].content = 'tampered again';
    const third = await api.beforeModelRequest(body());
    assert.ok(!JSON.stringify(third).includes('tampered'), 'callers cannot mutate a cached projection');
    // Capacity: many distinct slots stay within the entry/byte caps.
    for (let round = 0; round < 3; round++) {
      await api.beforeModelRequest({ messages: Array.from({ length: 3000 }, (_, i) => ({ role: 'user', content: 'row ' + round + '-' + i })) });
    }
  });
  const stats = api.projectionCacheStats();
  assert.ok(stats.entries <= stats.maxEntries && stats.bytes <= stats.maxBytes && stats.evictions > 0, JSON.stringify(stats));
  const files = fs.readdirSync(root, { recursive: true }).map(String).sort();
  assert.ok(files.every(name => name === 'privacy-scopes' || /^privacy-scopes[\\/][a-f0-9]{64}\.json$/.test(name)), 'only the encrypted mapping is written: ' + files.join(','));
  const off = { ...config, privacyModeV1: 'off' };
  api.configure(off);
  assert.equal(api.projectionCacheStats().entries, 0, 'policy change drops the whole cache');
  const raw = body(); assert.equal(await api.beforeModelRequest(raw), raw, 'off keeps the identity path');
  assert.equal(api.projectionCacheStats().entries, 0, 'off performs no cache work');
});

// --- Review round 2 (2E-v2): exact index-build replay, memory bound, TOCTOU, remanence, equivalences.
function budgetGateway(t, cached, limit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-pcache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  const core = { ...f.PrivacyCore, configHooks: { sealLocal: f.vault.sealLocal, openLocal: f.vault.openLocal },
    createMatchBudget: (...args) => limit.value ? f.PrivacyCore.createMatchBudget(limit.value) : f.PrivacyCore.createMatchBudget(...args) };
  const g = gateway(root, f, { core, ...(cached ? {} : { source: uncachedSource() }) }); g.configure(config); return Object.assign(Object.create(g), { core: f.PrivacyCore });
}
test('a hit never replays a one-off learned-index build: cached and uncached pass and fail at the same budget', async t => {
  // Sizes from the review probe: an inflated replay of the slot that first built the index still
  // fits the budget, so it would starve the later slots instead of falling back to an exact walk.
  const history = { role: 'user', content: 'y'.repeat(20000) };
  const trial = async (cached, budget) => {
    const limit = { value: null }, g = budgetGateway(t, cached, limit); let outcome;
    await g.run('index-budget', config, async () => {
      const scope = g.active().scope;
      for (let i = 0; i < 400; i++) scope.protectValue('learned-' + i + '-' + 'q'.repeat(30) + '@example.test', 'EMAIL');
      await g.beforeRequest({ messages: [history, { role: 'user', content: 'go' }] });   // builds the index, warms the cache
      limit.value = budget;
      try { await g.beforeRequest({ messages: [history, { role: 'user', content: 'z'.repeat(30000) }] }); outcome = 'ok'; } catch (error) { outcome = error.code; }
      limit.value = null;
    });
    return outcome;
  };
  let low = 1, high = 4 * 1024 * 1024;
  while (low < high) { const mid = (low + high) >>> 1; if (await trial(false, mid) === 'ok') high = mid; else low = mid + 1; }
  assert.deepEqual([await trial(false, low - 1), await trial(false, low)], ['privacy.learned_scan_limit', 'ok'], 'uncached threshold ' + low);
  assert.deepEqual([await trial(true, low - 1), await trial(true, low)], ['privacy.learned_scan_limit', 'ok'], 'cached threshold equals uncached');
});
test('a hit after the learned index was dropped charges its rebuild exactly as the uncached scan would', async t => {
  // A fresh learned value drops the index; the next request's first scanning slot rebuilds it.
  const outcome = async (cached, budget) => {
    const limit = { value: null }, g = budgetGateway(t, cached, limit); let result;
    await g.run('rebuild', config, async () => {
      const scope = g.active().scope;
      for (let i = 0; i < 300; i++) scope.protectValue('rebuild-' + i + '-' + 'r'.repeat(30) + '@example.test', 'EMAIL');
      const history = { role: 'user', content: 'x'.repeat(4000) };
      await g.beforeRequest({ messages: [history, { role: 'user', content: 'go' }] });
      // Evict this scope's learned index from the shared index cache without touching its revision.
      for (let i = 0; i < 80; i++) { const other = g.core.createScope({ scopeId: 'evict-' + i, detector: g.core.createDetector() }); other.protectValue('evict-' + i + '-' + 'e'.repeat(20) + '@example.test', 'EMAIL'); other.detect('evict'); }
      const revision = scope.revision();
      limit.value = budget;
      try { await g.beforeRequest({ messages: [history, { role: 'user', content: 'go' }] }); result = 'ok'; } catch (error) { result = error.code; }
      limit.value = null;
      assert.equal(scope.revision(), revision);
    });
    return result;
  };
  let low = 1, high = 4 * 1024 * 1024;
  while (low < high) { const mid = (low + high) >>> 1; if (await outcome(false, mid) === 'ok') high = mid; else low = mid + 1; }
  assert.deepEqual([await outcome(true, low - 1), await outcome(true, low)], ['privacy.learned_scan_limit', 'ok']);
});
test('the stored-size estimate bounds the retained heap for placeholder-dense CJK and structure-dense slots', async t => {
  require('node:v8').setFlagsFromString('--expose-gc');
  const gc = require('node:vm').runInNewContext('gc');
  const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
  const shapes = {
    cjk: i => ({ role: 'user', content: '第' + i + '条 ' + '联系 a@b.cn 和 c@d.cn，'.repeat(150) }),
    dense: i => ({ role: 'user', content: Array.from({ length: 120 }, (_, k) => ({ type: 'text', text: 'w' + (k % 10) })).concat([{ type: 'text', text: 'id' + i }]) }),
  };
  const rounds = { cjk: 25, dense: 12 };
  for (const [shape, slot] of Object.entries(shapes)) {
    const measure = async cached => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-pcache-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const f = fixture(), g = gateway(root, f, cached ? {} : { source: uncachedSource() }); g.configure(config); let before;
      await g.run('memory', config, async () => {
        await g.beforeRequest({ messages: [slot(-1), { role: 'user', content: 'go' }] });
        before = heap();
        for (let r = 0; r < rounds[shape]; r++) await g.beforeRequest({ messages: Array.from({ length: 10 }, (_, i) => slot(r * 10 + i)) });
      });
      return { delta: heap() - before, stats: g.projectionCacheStats(), g };
    };
    const plainRun = await measure(false), cachedRun = await measure(true);
    const retained = cachedRun.delta - plainRun.delta;
    assert.ok(cachedRun.stats.entries >= 10 * rounds[shape], shape + ' entries ' + cachedRun.stats.entries);
    assert.ok(retained <= cachedRun.stats.bytes, shape + ': estimate ' + cachedRun.stats.bytes + ' must bound retained ' + retained);
    void plainRun.g; void cachedRun.g;
  }
});
test('a slot edited while its walk yields is not stored under the digest of its earlier content', async t => {
  const { api, plain } = setup(t);
  const build = () => ({ role: 'user', content: Array.from({ length: 3000 }, (_, k) => ({ type: 'text', text: 'part ' + k })) });
  for (const g of [api, plain()]) {
    let first, replay;
    await g.run('toctou', config, async () => {
      const live = build();
      setImmediate(() => { live.content[2999].text = 'EDITED-DURING-WALK'; });
      first = await g.beforeRequest({ messages: [live, { role: 'user', content: 'go' }] });
      replay = await g.beforeRequest({ messages: [build(), { role: 'user', content: 'go' }] });
    });
    assert.ok(JSON.stringify(first).includes('EDITED-DURING-WALK'), 'precondition: the edit landed mid-walk');
    assert.ok(!JSON.stringify(replay).includes('EDITED-DURING-WALK'), 'the original content is projected as itself');
  }
});
test('learning mid-walk by a concurrent request is never stored; regex rules and recovered slots match the uncached gateway', async t => {
  const { api, plain } = setup(t);
  const secret = 'Zk9-concurrent-' + 'm'.repeat(10);
  const slot = () => ({ role: 'user', content: Array.from({ length: 3000 }, (_, k) => ({ type: 'text', text: k === 2999 ? 'tail mentions ' + secret : 'part ' + k })) });
  let later;
  const stores = api.projectionCacheStats().stores;
  const walking = api.run('concurrent', config, () => api.beforeRequest({ messages: [slot(), { role: 'user', content: 'go' }] }));
  await new Promise(resolve => setImmediate(resolve));
  await api.run('concurrent', config, () => api.beforeRequest({ messages: [{ role: 'user', content: 'password: ' + secret }] }));
  await walking.catch(() => {});
  await api.run('concurrent', config, async () => { later = await api.beforeRequest({ messages: [slot(), { role: 'user', content: 'go' }] }); });
  assert.ok(!JSON.stringify(later).includes(secret), 'a projection made before the value was learned is not reused');
  assert.ok(api.projectionCacheStats().stores > stores);
  // A slot recovered for the model view is never served to the strict path.
  const typed = () => ({ messages: [{ role: 'user', content: '{"apiKey":null}' }, { role: 'user', content: 'go' }] });
  await api.run('recovered', config, async () => {
    const view = await api.beforeModelRequest(typed()); await api.beforeModelRequest(typed());
    assert.equal(view.messages[1].content, '[RUYI_LOCAL_DATA_WITHHELD]');
    await assert.rejects(api.beforeRequest(typed()), /privacy\.typed_sensitive/);
  });
  // Regex rules: hits equal the uncached gateway (references normalised; each gateway issues its own).
  const rules = { ...config, privacyRulesV1: [{ id: 'project', kind: 'regex', value: 'PRJ-[0-9]{4}', category: 'INTERNAL' }] };
  const run = async g => {
    g.configure(rules); const out = [];
    await g.run('regex-' + (g === api ? 'a' : 'b'), rules, async () => {
      for (let i = 0; i < 3; i++) out.push(JSON.stringify(await g.beforeModelRequest({ messages: [{ role: 'user', content: 'see PRJ-1234 and PRJ-9876' }, { role: 'user', content: 'go ' + i }] })));
    });
    return out.map(text => text.replace(REF, 'R'));
  };
  const hitsBefore = hits(api), cachedOut = await run(api), plainOut = await run(plain(rules));
  assert.deepEqual(cachedOut, plainOut); assert.ok(hits(api) > hitsBefore, 'regex bodies are served from the cache');
  assert.ok(cachedOut.every(text => !text.includes('PRJ-')));
});
test('entries of a scope are released when it moves to a newer revision, is closed or superseded', async t => {
  const { api } = setup(t);
  const body = tail => ({ messages: [{ role: 'user', content: 'release ' + email }, { role: 'assistant', content: 'ok' }, { role: 'user', content: tail }] });
  await api.run('release', config, async () => {
    await api.beforeRequest(body('a')); await api.beforeRequest(body('a'));
    const warm = api.projectionCacheStats();
    await api.beforeRequest(body('password: ReleaseSecret-' + 'k'.repeat(10)));
    await api.beforeRequest(body('a'));
    const after = api.projectionCacheStats();
    assert.ok(after.purges > warm.purges, 'a newer revision purges the older entries');
    assert.ok(after.entries <= warm.entries + 1, 'old-revision entries do not accumulate: ' + warm.entries + ' -> ' + after.entries);
  });
  const connection = api.createConnectionScope();
  await connection.run(async () => { await api.beforeRequest(body('c')); await api.beforeRequest(body('c')); });
  const open = api.projectionCacheStats().entries;
  connection.close();
  assert.ok(api.projectionCacheStats().entries < open, 'closing a connection scope releases its entries');
  // Superseding a scope (detector options change) releases the old scope's entries even without a global clear.
  const entriesBefore = api.projectionCacheStats().entries;
  assert.ok(entriesBefore > 0);
  const ruled = { ...config, privacyRulesV1: [{ id: 'lit', kind: 'literal', value: 'never-present-literal', category: 'INTERNAL' }] };
  await api.run('release', ruled, async () => {});
  assert.equal(api.projectionCacheStats().entries, 0, 'superseded scope entries are gone');
});
test('slots above the per-entry cap are not fingerprinted into one giant string', async t => {
  const { api } = setup(t);
  const leaf = 'a'.repeat(900 * 1024);
  const big = { role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'text', text: leaf })) };
  const { stores, oversize } = api.projectionCacheStats();
  await api.run('huge', config, async () => { await api.beforeRequest({ messages: [big, { role: 'user', content: 'go' }] }); });
  assert.equal(api.projectionCacheStats().stores - stores, 2, 'only the system notice and the tail are stored; the 4.5M-char slot is skipped');
  assert.equal(api.projectionCacheStats().oversize - oversize, 1, 'the oversized slot is refused while counting, before any digest string is joined');
});
