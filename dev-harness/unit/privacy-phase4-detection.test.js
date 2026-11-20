'use strict';
// 150 号文 §4 P12/P13/P17 (3.1 phase 4): false positives removed and false negatives closed without giving up
// the earlier corpora. Synthetic values only; the corpus lives in dev-harness/privacy-31/phase4-detection-corpus.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createPhase4Corpus, luhnComplete } = require('../privacy-31/phase4-detection-corpus');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const { core } = vm.runInNewContext(read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n({ core: PrivacyCore });', { require, Buffer });
const tierOptions = tier => tier === 'basic' ? {} : tier === 'technical' ? { personal: true, technical: true } : { personal: true };
const corpus = createPhase4Corpus();

for (const row of corpus.cases) test('phase 4 positive ' + row.id + ': complete value, nothing after it', () => {
  const scope = core.createScope({ scopeId: 'phase4-' + row.id, detector: core.createDetector(tierOptions(row.tier)) });
  try {
    const start = row.sample.indexOf(row.secret), matches = scope.detect(row.sample);
    assert.ok(matches.some(match => match.start <= start && match.end >= start + row.secret.length), row.sample);
    if (row.visible) {
      const at = row.sample.indexOf(row.visible, start + row.secret.length);
      assert.ok(!matches.some(match => match.start < at + row.visible.length && match.end > at), 'visible tail: ' + row.visible);
    }
    // Protection keeps original coordinates and spelling: restoring gives back the exact sample.
    const protectedText = scope.protectRaw(row.sample).text;
    assert.ok(!protectedText.includes(row.secret));
    assert.equal(scope.restoreForTool(protectedText, { scopeId: 'phase4-' + row.id, tool: 'unit', pointer: '/text', authorize: () => true, allowCredentialEmbedding: true }), row.sample);
  } finally { scope.clear(); }
});

test('phase 4 negatives stay visible under their tier', () => {
  for (const row of corpus.negatives) assert.deepEqual(JSON.parse(JSON.stringify(core.createDetector(tierOptions(row.tier)).detect(row.sample))), [], row.sample);
});

test('a single learned surname does not rewrite place names; a two-character name is learned', () => {
  const scope = core.createScope({ scopeId: 'phase4-surname', detector: core.createDetector({ personal: true }) });
  try {
    scope.protectRaw('姓名：王');
    assert.equal(scope.protectRaw('去王府井大街').text, '去王府井大街');
    scope.protectRaw('姓名：王芳');
    assert.ok(!scope.protectRaw('王芳下午到').text.includes('王芳'));
  } finally { scope.clear(); }
});

test('cards need Luhn and a network prefix; identity numbers are not cards; normalization maps spans back exactly', () => {
  const detector = core.createDetector({ personal: true });
  const valid = luhnComplete('453914880343646'), invalid = valid.slice(0, -1) + String((Number(valid.at(-1)) + 1) % 10);
  assert.ok(detector.detect('卡 ' + valid).some(match => match.ruleIds.includes('builtin.payment-card')));
  assert.equal(detector.detect('卡 ' + invalid).filter(match => match.ruleIds.includes('builtin.payment-card')).length, 0);
  assert.equal(detector.detect(luhnComplete('123456789012345')).filter(match => match.ruleIds.includes('builtin.payment-card')).length, 0, 'no network prefix');
  // Zero-width characters inside and around a value: the match covers the original characters only.
  const text = 'a\u200b 138\u200b0013\u200b8000\u200b b';
  const [match] = detector.detect(text);
  assert.equal(text.slice(match.start, match.end), '138\u200b0013\u200b8000');
  // The normalized pass does not run custom regex rules or recurse.
  const inputs = [];
  core.createDetector({ personal: true, rules: [{ id: 'custom', kind: 'regex', value: 'x', category: 'INTERNAL' }], regexMatches: input => { inputs.push(input); return []; } }).detect('１２\u200b３');
  assert.deepEqual(inputs, ['１２\u200b３']);
});
