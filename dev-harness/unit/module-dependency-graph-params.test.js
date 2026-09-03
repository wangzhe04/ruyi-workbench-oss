#!/usr/bin/env node
// Unit tests for the 110-h1 arrow-function-parameter local-binding fix in module-dependency-graph.js.
// Uses Node built-in test runner (node:test), zero dependencies.
//
// 110-h1: the scanner's cross-module requires pass treats any identifier that textually matches another
// module's unique top-level `provides` as a reference to that module, unless the identifier's own token
// index was recorded as a local binding. Before this fix, only TOP-LEVEL function/class names and
// const/let/var binders (declarationInfo's `atTop` loop) were recorded that way, so an arrow function's
// parameters - which can appear at any depth - were invisible to the exclusion check. A parameter named the
// same as another module's top-level export (e.g. `text`, matching 00-boot.js's `function text(...)`)
// produced a false cross-module edge. These tests exercise declarationInfo()/tokenize() (already exported
// by module-dependency-graph.js; no new export was needed) directly against small snippets and assert that
// every occurrence of a bound arrow-parameter name within its own scope is recorded in
// declarationTokenIndexes, while genuine free references are not.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, declarationInfo } = require('../module-dependency-graph');

// Returns, for every token whose value === name, {index, marked}. Order matches source occurrence order.
function occurrencesOf(source, name) {
  const tokens = tokenize(source);
  const { declarationTokenIndexes } = declarationInfo(tokens);
  const hits = [];
  tokens.forEach((token, index) => {
    if (token.type === 'id' && token.value === name) hits.push({ index, marked: declarationTokenIndexes.has(index) });
  });
  return hits;
}

// Convenience: assert every occurrence of `name` is marked local (true) or free (false).
function assertAllMarked(source, name, expected) {
  const hits = occurrencesOf(source, name);
  assert.ok(hits.length > 0, `expected at least one occurrence of "${name}" in: ${source}`);
  for (const hit of hits) assert.equal(hit.marked, expected, `token #${hit.index} ("${name}") in: ${source}`);
}

describe('module-dependency-graph arrow-parameter local bindings (110-h1)', () => {
  it('marks a bare single-identifier arrow parameter and its body use as local', () => {
    assertAllMarked('const f = text => String(text);', 'text', true);
  });

  it('marks a parenthesized single parameter and its body use as local', () => {
    assertAllMarked('const f = (text) => String(text);', 'text', true);
  });

  it('marks every parameter in a multi-parameter arrow, plus nested-block reads, as local', () => {
    const src = "const appendText = (type, text) => { const value = String(text || ''); return value; };";
    assertAllMarked(src, 'text', true);
    assertAllMarked(src, 'type', true);
  });

  it('reproduces and fixes the exact 02c-turn-segments.js false positive against 00-boot.js text()', () => {
    // Real shape of the code that produced a bogus 02c-turn-segments.js->00-boot.js(text) edge before the
    // fix: 00-boot.js's top-level `function text(data, status, headers)` collided with this local param.
    const src = [
      'function createTurnSegmentBuilder() {',
      "  const appendText = (type, text) => {",
      "    const value = String(text || '');",
      '    if (!value) return;',
      '  };',
      '  return appendText;',
      '}',
    ].join('\n');
    assertAllMarked(src, 'text', true);
  });

  it('marks an async parenthesized parameter and its await-body use as local', () => {
    assertAllMarked('const f = async (text) => { await use(text); };', 'text', true);
  });

  it('marks an async bare parameter as local', () => {
    assertAllMarked('const f = async text => use(text);', 'text', true);
  });

  it('marks a defaulted parameter as local, while a default-value reference to another name stays free', () => {
    const src = 'const f = (text = otherModuleSymbol) => use(text);';
    assertAllMarked(src, 'text', true);
    // The default expression's own identifier is a genuine reference and must stay visible to the
    // cross-module scan - it must NOT be swept up as local just because it sits inside the param list.
    assertAllMarked(src, 'otherModuleSymbol', false);
  });

  it('marks a rest parameter (tokenized as three separate "." tokens) as local at both its declaration and use', () => {
    // tokenize() emits `...` as three consecutive '.' punct tokens (see module-dependency-graph.js), which
    // is easy to confuse with member-access '.'; this specifically guards the rest-parameter declaration
    // site itself (not just later reads) against that ambiguity.
    assertAllMarked('const f = (...text) => text.join(",");', 'text', true);
  });

  it('marks a single-level destructured object parameter as local', () => {
    assertAllMarked('const f = ({ text }) => use(text);', 'text', true);
  });

  it('marks a renamed destructured object parameter by its bound (right-hand) name only', () => {
    const src = 'const f = ({ raw: text }) => use(text);';
    assertAllMarked(src, 'text', true);
    // "raw" is the source object's key, never a local binding - it must stay eligible for the
    // cross-module scan (though in this snippet no other module provides "raw").
    assertAllMarked(src, 'raw', false);
  });

  it('marks a destructured object parameter with a default value as local', () => {
    assertAllMarked('const f = ({ text = 1 }) => use(text);', 'text', true);
  });

  it('marks a rest binding inside a destructured object parameter as local', () => {
    assertAllMarked('const f = ({ a, ...text }) => use(text);', 'text', true);
  });

  it('marks a single-level destructured array parameter as local', () => {
    assertAllMarked('const f = ([text]) => use(text);', 'text', true);
  });

  it('marks a parameter of an arrow nested inside a regular function as local', () => {
    const src = 'function outer() { return list.map(text => text.length); }';
    assertAllMarked(src, 'text', true);
  });

  it('does not mark a free reference to the same name occurring after the arrow scope ends', () => {
    const src = 'const f = text => use(text); realOuterRef(text);';
    const hits = occurrencesOf(src, 'text');
    assert.equal(hits.length, 3);
    assert.equal(hits[0].marked, true); // parameter declaration
    assert.equal(hits[1].marked, true); // in-body use
    assert.equal(hits[2].marked, false); // free reference outside the arrow, must stay eligible
  });

  it('does not treat a property access sharing a parameter name as a new local (member access "." guard holds)', () => {
    // `evt.text` reads a property named text; it must not be conflated with a `text` parameter binding.
    const src = "const f = (evt) => { appendText('text', evt.text); };";
    const tokens = tokenize(src);
    const { declarationTokenIndexes } = declarationInfo(tokens);
    const propertyAccessIndex = tokens.findIndex((token, index) => token.value === 'text' && tokens[index - 1] && tokens[index - 1].value === '.');
    assert.ok(propertyAccessIndex > -1, 'fixture must contain evt.text');
    assert.equal(declarationTokenIndexes.has(propertyAccessIndex), false);
  });
});
