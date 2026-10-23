'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const rules = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01i-privacy-rules.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01h-privacy-core.js'), 'utf8');
// Test-only visibility added in VM; the production module's exports are unchanged.
const load = () => vm.runInNewContext(rules + '\n' + source.replace('seal, open, configHooks });',
  'seal, open, configHooks, __cache: learnedIndexCache, __makeCache: createLearnedIndexCache });') + '\nPrivacyCore', { require, Buffer });
const plain = value => JSON.parse(JSON.stringify(value));
const create = (core, id) => core.createScope({ scopeId: id, detector: { detect: () => [] } });
const fail = (work, suffix = 'learned_scan_limit') => assert.throws(work, error => error.code === 'privacy.' + suffix);
const allow = scopeId => ({ scopeId, tool: 'local', pointer: '/value', authorize: () => true });

test('admission reserves typed arrays and scratch before build, then shrinks to exact retained counts', () => {
  const core = load(), cache = core.__makeCache({ bytes: 4096, indexes: 2, patterns: 4, branchMaps: 2, branchEdges: 4 });
  const ticket = cache.reserve({ typedBytes: 220, scratchBytes: 40, patterns: 1 });
  assert.deepEqual(plain(cache.snapshot()), { bytes: 644, typedBytes: 220, scratchBytes: 40, stringBytes: 0, indexes: 1, patterns: 1,
    branchMaps: 0, branchEdges: 0, retained: 0, pending: 1, evictions: 0, commits: 0,
    limits: { bytes: 4096, indexes: 2, patterns: 4, branchMaps: 2, branchEdges: 4 } });
  const item = { synthetic: 1 }, handle = cache.commit(ticket, item, { typedBytes: 220, patterns: 1 });
  cache.release(ticket); cache.release(ticket);
  assert.equal(cache.get(handle), item);
  const snapshot = cache.snapshot(); assert.equal(snapshot.pending, 0); assert.equal(snapshot.scratchBytes, 0); assert.equal(snapshot.bytes, 604);
  cache.drop(handle); assert.equal(cache.snapshot().bytes, 0);
});

test('LRU eviction is global, count caps are independent and oversized reservation leaves current cache intact', () => {
  const core = load(), cache = core.__makeCache({ bytes: 4096, indexes: 2, patterns: 4, branchMaps: 2, branchEdges: 4 });
  const add = name => { const ticket = cache.reserve({ typedBytes: 4, patterns: 1 }); return cache.commit(ticket, { name }, { typedBytes: 4, patterns: 1 }); };
  const a = add('a'), b = add('b'); cache.get(a); const c = add('c');
  assert.equal(cache.get(b), null); assert.equal(cache.get(a).name, 'a'); assert.equal(cache.get(c).name, 'c');
  assert.equal(cache.snapshot().evictions, 1); assert.equal(cache.snapshot().retained, 2);
  const before = plain(cache.snapshot()); fail(() => cache.reserve({ typedBytes: 4096, patterns: 1 }));
  assert.deepEqual(plain(cache.snapshot()), before);
  cache.drop(a); cache.drop(c);
  const pendingA = cache.reserve({ typedBytes: 4, patterns: 1 }), pendingB = cache.reserve({ typedBytes: 4, patterns: 1 });
  fail(() => cache.reserve({ typedBytes: 4, patterns: 1 }));
  cache.release(pendingA); cache.release(pendingA); cache.release(pendingB);
  assert.equal(cache.snapshot().bytes, 0); assert.equal(cache.snapshot().indexes, 0);
  const metaCache = core.__makeCache({ bytes: 1000000, indexes: 64, patterns: 1, branchMaps: 1, branchEdges: 2 });
  const first = metaCache.reserve({ typedBytes: 4, patterns: 1 });
  fail(() => metaCache.reserve({ typedBytes: 4, patterns: 1 })); metaCache.release(first);
});

test('failed AC or single-long KMP construction releases all reservations and never installs a partial cache', () => {
  for (const count of [1, 2]) {
    const core = load(), s = create(core, 'failure-' + count);
    for (let i = 0; i < count; i++) s.protectValue('long-' + i + '-' + 'a'.repeat(10000), 'INTERNAL');
    const before = plain(s.exportState());
    fail(() => s.detectLearned('z'.repeat(15000), { budget: core.createMatchBudget(20) }));
    assert.equal(core.__cache.snapshot().pending, 0); assert.equal(core.__cache.snapshot().retained, 0); assert.equal(core.__cache.snapshot().bytes, 0);
    assert.deepEqual(plain(s.exportState()), before);
    assert.deepEqual(plain(s.detectLearned('z'.repeat(15000))), []);
    assert.equal(core.__cache.snapshot().retained, 1);
    s.clear(); assert.equal(core.__cache.snapshot().bytes, 0);
  }
});

test('entry eviction leaves scope tokens and tombstones intact, rebuild consumes the same caller budget', () => {
  const core = load(), scopes = [];
  for (let i = 0; i < 80; i++) {
    const s = create(core, 'scope-' + i), value = 'value-' + i, token = s.protectValue(value, 'INTERNAL');
    s.detectLearned(value); scopes.push({ s, value, token });
  }
  const first = scopes[0], state = plain(first.s.exportState());
  assert.equal(core.__cache.snapshot().retained, 64); assert.equal(core.__cache.snapshot().evictions, 16);
  assert.equal(first.s.restoreForTool(first.token, allow('scope-0')), first.value);
  fail(() => first.s.detectLearned(first.value, { budget: core.createMatchBudget(1) }));
  assert.equal(core.__cache.snapshot().pending, 0); assert.deepEqual(plain(first.s.exportState()), state);
  assert.equal(first.s.detectLearned(first.value).length, 1);
  first.s.revoke(first.token); fail(() => first.s.detectLearned(first.value), 'reference_revoked');
  for (const { s } of scopes) s.clear();
  assert.equal(core.__cache.snapshot().retained, 0); assert.equal(core.__cache.snapshot().bytes, 0);
});

test('128 retained scopes cannot multiply the cache-byte budget; clear/import/revoke keep authority separate', () => {
  const core = load(), scopes = [], publicText = 'z'.repeat(33000);
  for (let i = 0; i < 128; i++) {
    const s = create(core, 'large-' + i);
    s.protectValue('A-' + i + '-' + 'a'.repeat(32000), 'INTERNAL');
    s.protectValue('B-' + i + '-' + 'b'.repeat(32000), 'INTERNAL');
    s.detectLearned(publicText); scopes.push(s);
    const snapshot = core.__cache.snapshot();
    assert.ok(snapshot.bytes <= 64 * 1024 * 1024); assert.ok(snapshot.typedBytes <= snapshot.bytes);
    assert.equal(snapshot.pending, 0); assert.equal(snapshot.scratchBytes, 0); assert.ok(snapshot.retained <= 64);
    assert.ok(snapshot.patterns <= 40000); assert.ok(snapshot.branchMaps <= 40000); assert.ok(snapshot.branchEdges <= 80000);
  }
  assert.ok(core.__cache.snapshot().evictions > 0);
  const first = scopes[0], saved = plain(first.exportState());
  first.importState(saved); assert.deepEqual(plain(first.detectLearned(publicText)), []);
  first.revoke(saved.entries[0].token);
  fail(() => first.detectLearned(saved.entries[0].value), 'reference_revoked');
  const copy = create(core, 'large-0'); copy.importState(plain(first.exportState()));
  fail(() => copy.detectLearned(saved.entries[0].value), 'reference_revoked');
  for (const s of scopes) s.clear(); copy.clear();
  assert.equal(core.__cache.snapshot().bytes, 0); assert.equal(core.__cache.snapshot().retained, 0);
});

test('single long KMP cache is four bytes per code unit; a second pattern changes only that bucket to AC', () => {
  const core = load(), s = create(core, 'hybrid'), long = 'L' + 'a'.repeat(10000);
  s.protectValue(long, 'INTERNAL'); s.detectLearned(long);
  assert.equal(core.__cache.snapshot().typedBytes, 4 * long.length);
  assert.equal(core.__cache.snapshot().stringBytes, 2 * (long.length + s.exportState().entries[0].token.length));
  s.protectValue('short', 'INTERNAL'); s.detectLearned(long);
  const mixed = core.__cache.snapshot(); assert.equal(mixed.retained, 2);
  s.protectValue(long + 'b', 'INTERNAL');
  assert.equal(core.__cache.snapshot().retained, 1, 'long change removes only the old KMP cache');
  s.detectLearned(long + 'b');
  assert.ok(core.__cache.snapshot().typedBytes > 22 * long.length);
  s.clear(); assert.equal(core.__cache.snapshot().typedBytes, 0);
});

test('caller-supplied comparison budget is not reset when another scope uses the same global cache', () => {
  const core = load(), a = create(core, 'shared-a'), b = create(core, 'shared-b');
  a.protectValue('a', 'INTERNAL'); b.protectValue('b', 'INTERNAL');
  a.detectLearned('z'); b.detectLearned('z');
  const budget = core.createMatchBudget(2500);
  assert.deepEqual(plain(a.detectLearned('z'.repeat(2000), { budget })), []);
  fail(() => b.detectLearned('z'.repeat(2000), { budget }));
  assert.equal(core.__cache.snapshot().pending, 0);
});
