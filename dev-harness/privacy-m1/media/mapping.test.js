'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetector, mapWords } = require('./prototype');
test('real PrivacyCore intervals map all OCR words in a multi-word secret', () => {
  const { detector } = loadDetector();
  const words = ['PUBLIC', 'ALPHA', 'BRAVO', 'CHARLIE', 'count'].map((text, i) => ({ text, line: 0, box: [10 + i * 60, 10, 65 + i * 60, 30] }));
  const result = mapWords(words, detector, 400, 60);
  assert.equal(result.hitCount, 1);
  assert.equal(result.matchedWords, 3);
  assert.equal(result.boxes.length, 3);
  assert.equal(result.crossWord, true);
});
test('UTF-16 span units remain aligned after astral Unicode', () => {
  const { detector } = loadDetector();
  const words = ['😀', 'local.fixture@example.test', 'PUBLIC'].map((text, i) => ({ text, line: 0, box: [10 + i * 100, 10, 90 + i * 100, 30] }));
  const result = mapWords(words, detector, 400, 60);
  assert.equal(result.matchedWords, 1);
  assert.deepEqual(result.categories, ['EMAIL']);
});
test('invalid boxes and empty recognized results fail closed', () => {
  const { detector } = loadDetector();
  assert.throws(() => mapWords([], detector, 400, 60), { code: 'unrecognized' });
  assert.throws(() => mapWords([{ text: 'local.fixture@example.test', line: 0, box: [0, 0, 900, 50] }], detector, 400, 60), { code: 'invalid-ocr' });
});
