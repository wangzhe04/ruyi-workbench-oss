'use strict';
// Real privacy primitive source: long-pattern matching and cache eviction preserve authority.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const core = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01i-privacy-rules.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01h-privacy-core.js'), 'utf8') + '\nPrivacyCore', { require, Buffer });
const scope = options => core.createScope({ scopeId: 'draft', detector: { detect: () => [] }, ...options });
const plain = value => JSON.parse(JSON.stringify(value));
const code = (work, suffix) => assert.throws(work, error => error.code === 'privacy.' + suffix);
const spans = matches => plain(matches).map(({ start, end, category }) => ({ start, end, category }));
const allow = { scopeId: 'draft', tool: 'test', pointer: '/value', authorize: () => true, allowCredentialEmbedding: true };

test('threshold 4096/4097, long suffix outputs and UTF16 offsets remain exact', () => {
  const s = scope(), a = 'a'.repeat(4096), b = a + 'b', c = 'z' + b, unicode = '😀'.repeat(2100);
  for (const [value, category] of [[a, 'INTERNAL'], [b, 'INTERNAL'], [c, 'CREDENTIAL'], [unicode, 'INTERNAL']]) s.protectValue(value, category);
  assert.deepEqual(spans(s.detectLearned('!' + c + '!' + unicode)), [
    { start: 1, end: 1 + c.length, category: 'CREDENTIAL' },
    { start: c.length + 2, end: c.length + 2 + unicode.length, category: 'INTERNAL' },
  ]);
});

test('short discoveries retain a built long index; long changes force a budgeted complete rebuild', () => {
  const s = scope(), long = 'L' + 'a'.repeat(4999);
  s.protectValue(long, 'INTERNAL'); s.detectLearned(long);
  s.protectValue('new-short-value', 'INTERNAL');
  assert.equal(s.detectLearned(long, { budget: core.createMatchBudget(2 * long.length + 200) }).length, 1,
    'two warm scans fit; rebuilding the long trie would exceed this budget');
  s.protectValue(long + 'b', 'INTERNAL');
  code(() => s.detectLearned(long + 'b', { budget: core.createMatchBudget(2 * long.length + 200) }), 'learned_scan_limit');
  assert.equal(s.detectLearned(long + 'b').length, 1, 'budget failure leaves no half-built cache');
});

test('a short leaf does not build even the first long index', () => {
  const s = scope(); s.protectValue('LONG-' + 'a'.repeat(350000), 'INTERNAL');
  assert.deepEqual(plain(s.detectLearned('z', { budget: core.createMatchBudget(1) })), []);
  s.protectValue('abc', 'INTERNAL');
  assert.deepEqual(plain(s.detectLearned('z', { budget: core.createMatchBudget(10) })), []);
});

test('long membership changes preserve the short cache and invalid imports preserve both caches', () => {
  const s = scope(), short = 'value', long = 'b'.repeat(5000);
  s.protectValue(short, 'INTERNAL'); s.detectLearned(short);
  s.protectValue(long, 'INTERNAL');
  assert.equal(s.detectLearned(short, { budget: core.createMatchBudget(9) }).length, 1,
    'a cold short rebuild would exceed nine comparisons');
  s.detectLearned(long);
  const state = plain(s.exportState());
  code(() => s.importState({ ...state, entries: [...state.entries, state.entries[1]] }), 'state_invalid');
  assert.equal(s.detectLearned(long, { budget: core.createMatchBudget(2 * long.length + 10) }).length, 1,
    'failed import must not clear either valid complete index');
});

test('comparison and premerge hit budgets are shared by short and long tries', () => {
  const s = scope(), long = 'x'.repeat(4097);
  s.protectValue('x', 'INTERNAL'); s.protectValue(long, 'INTERNAL'); s.detectLearned(long);
  code(() => s.detectLearned(long, { budget: core.createMatchBudget(2 * long.length - 1) }), 'learned_scan_limit');
  code(() => s.detectLearned(long, { budget: core.createMatchBudget(undefined, long.length) }), 'learned_scan_limit');
  const reused = core.createMatchBudget(3 * long.length + 20);
  s.detectLearned(long, { budget: reused });
  code(() => s.detectLearned('x'.repeat(21), { budget: reused }), 'learned_scan_limit');
});

test('cached indexes never cache authority: alias category, revoke, expiry and imports stay live', () => {
  let now = 0;
  const s = scope({ clock: () => now, ttlMs: 1000 }), long = '\\u0061'.repeat(700), decoded = 'a'.repeat(700);
  const longToken = s.protectAlias(long, decoded, 'INTERNAL');
  s.detectLearned(long); s.detectLearned(decoded);
  s.protectValue(decoded, 'CREDENTIAL');
  assert.equal(s.detectLearned(long)[0].category, 'CREDENTIAL');
  assert.equal(s.restoreForTool(longToken, allow), long);
  const copy = scope({ clock: () => now, ttlMs: 1000 }); copy.importState(plain(s.exportState()));
  assert.equal(copy.detectLearned(long)[0].category, 'CREDENTIAL');
  const decodedToken = copy.exportState().entries.find(entry => entry.value === decoded).token;
  copy.revoke(decodedToken); code(() => copy.detectLearned(long), 'reference_revoked');
  const revokedCopy = scope({ clock: () => now }); revokedCopy.importState(plain(copy.exportState()));
  code(() => revokedCopy.detectLearned(long), 'reference_revoked');
  now = 1001; code(() => s.detectLearned(long), 'reference_expired');
  copy.clear(); assert.deepEqual(plain(copy.detectLearned(long)), []);
  copy.protectValue(long, 'INTERNAL'); assert.equal(copy.detectLearned(long).length, 1);
  copy.clear(); copy.protectValue('replacement', 'INTERNAL'); assert.deepEqual(plain(copy.detectLearned(long)), []);
});

test('a revoked long pattern is a tombstone, while cached PHONE boundary filtering is unchanged', () => {
  const s = scope(), phone = '1'.repeat(5000), token = s.protectValue(phone, 'PHONE');
  assert.equal(s.detectLearned(phone).length, 1);
  assert.deepEqual(plain(s.detectLearned('9' + phone + '9')), []);
  s.revoke(token); code(() => s.detectLearned(phone), 'reference_revoked');
  const copy = scope(); copy.importState(plain(s.exportState())); code(() => copy.detectLearned(phone), 'reference_revoked');
});

test('retained imported long whitespace restores locally but is never a global learned pattern', () => {
  const s = scope(), token = '[[RUYI_PVT:INTERNAL:' + 'a'.repeat(32) + ']]', value = ' '.repeat(5000);
  s.importState({ version: 1, scopeId: 'draft', entries: [{ token, value, category: 'INTERNAL', expiresAt: Date.now() + 60000 }] });
  assert.equal(s.restoreForTool(token, allow), value);
  assert.deepEqual(plain(s.detectLearned(value, { budget: core.createMatchBudget(1) })), []);
});

function oracle(text, patterns) {
  const found = [];
  for (const { value, category } of patterns) {
    for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + 1)) found.push({ start, end: start + value.length, category });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const hit of found) {
    const last = out.at(-1);
    if (last && hit.start < last.end) { last.end = Math.max(last.end, hit.end); if (hit.category === 'CREDENTIAL') last.category = 'CREDENTIAL'; }
    else out.push({ ...hit });
  }
  return out;
}
test('seeded exact-match oracle covers mixed long/short suffixes, Unicode, rebuild and round-trip state', () => {
  let seed = 0x51ac13;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['a', 'b', 'c', '界', '😀'];
  const word = n => Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join('');
  for (let iteration = 0; iteration < 160; iteration++) {
    let s = scope();
    const patterns = new Map(), add = value => patterns.set(value, { value, category: random(4) ? 'INTERNAL' : 'CREDENTIAL' });
    for (let n = 0; n < 8; n++) add(word(2 + random(8)));
    const base = word(4100); add(base); add(base.slice(1)); add(base.slice(2));
    for (const { value, category } of patterns.values()) s.protectValue(value, category);
    const text = word(20) + base + word(10) + [...patterns.keys()][random(8)] + word(20);
    s.detectLearned(text);
    add(word(3)); const fresh = [...patterns.values()].at(-1); s.protectValue(fresh.value, fresh.category);
    if (iteration % 2) { const copy = scope(); copy.importState(plain(s.exportState())); s = copy; }
    assert.deepEqual(spans(s.detectLearned(text)), oracle(text, [...patterns.values()]), 'iteration ' + iteration);
  }
});
