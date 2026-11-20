'use strict';
// 4B review v2/v3: no positive that rule catalog v6 detected may become a miss or change category in the current
// catalog. The v6 coverage of every positive sample (spans and categories) is frozen in
// fixtures/privacy-phase4/v6-positive-coverage.json (computed from 45aed447). A row passes when
//   (a) a known secret v6 covered completely is still covered completely,
//   (b) every ASCII letter or digit v6 covered is still covered, and
//   (c) the current match over each such character has v6's category, or a change listed in ALLOWED_CATEGORY.
// CJK prose v6 swallowed after a value may shrink (150 P12); review probes carry their value as a secret so a
// CJK-only value (a bank branch, a name) cannot silently disappear.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { samples } = require('../lib/privacy-positive-samples');
const frozen = require('../fixtures/privacy-phase4/v6-positive-coverage.json');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const core = vm.runInNewContext(read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\nPrivacyCore', { require, Buffer });
const optionsFor = tier => tier === 'basic' ? {} : tier === 'technical' ? { personal: true, technical: true } : tier === 'all' ? { personal: true, technical: true, confidential: true } : { personal: true };
// Deliberate category changes (key → [v6, current]); empty: v7 keeps every v6 category.
const ALLOWED_CATEGORY = Object.freeze({});

function verdict(detect) {
  const byKey = new Map(frozen.rows.map(row => [row.key, row]));
  let compared = 0;
  const lost = [];
  for (const row of samples()) {
    const old = byKey.get(row.key);
    if (!old) continue;   // a sample added after the freeze has its own positive test
    assert.equal(crypto.createHash('sha256').update(row.sample).digest('hex').slice(0, 16), old.sha256, 'sample drifted: ' + row.key);
    compared++;
    const matches = detect(row);
    const at = (start, end) => matches.find(match => match.start <= start && match.end >= end);
    if (row.secret) {
      const start = row.sample.indexOf(row.secret), end = start + row.secret.length;
      if (start >= 0 && old.spans.some(([s, e]) => s <= start && e >= end) && !at(start, end)) lost.push(row.key + ' secret');
    }
    for (const [s, e, category] of old.spans) for (let i = s; i < e; i++) {
      if (!/[A-Za-z0-9]/.test(row.sample[i])) continue;
      const match = at(i, i + 1);
      if (!match) { lost.push(row.key + ' @' + i); break; }
      const allowed = ALLOWED_CATEGORY[row.key];
      if (match.category !== category && !(allowed && allowed[0] === category && allowed[1] === match.category)) { lost.push(row.key + ' ' + category + '->' + match.category); break; }
    }
  }
  return { compared, lost };
}
const current = row => core.createDetector(optionsFor(row.tier)).detect(row.sample);

test('every v6 positive is still detected by the current catalog with the same category', () => {
  assert.equal(frozen.catalogVersion, 6);
  assert.ok(frozen.rows.every(row => row.spans.every(span => span.length === 3)), 'categories are frozen');
  const { compared, lost } = verdict(current);
  assert.ok(compared >= 370, 'compared ' + compared);
  assert.deepEqual(lost, []);
});

test('the lock sees relabelled, shortened and dropped matches (mutation check)', () => {
  const relabel = verdict(row => current(row).map(match => ({ ...match, category: 'PATH' })));
  assert.ok(relabel.lost.length > 300, 'relabel all as PATH: ' + relabel.lost.length);
  const shorten = verdict(row => current(row).map(match => ({ ...match, end: Math.max(match.start + 1, match.end - 1) })));
  assert.ok(shorten.lost.length > 100, 'drop the last character: ' + shorten.lost.length);
  const dropCjk = verdict(row => current(row).filter(match => !/^[\u4e00-\u9fff]/.test(row.sample.slice(match.start, match.end))));
  assert.ok(dropCjk.lost.some(key => key.startsWith('review:')), 'a dropped CJK-led review value is caught');
});
