'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, declarationInfo, buildGraph } = require('../module-dependency-graph');

function marks(source, name) {
  const tokens = tokenize(source), marked = declarationInfo(tokens).declarationTokenIndexes;
  return tokens.flatMap((token, i) => token.value === name ? [marked.has(i)] : []);
}
test('generator parameters and local functions do not hide outside references', () => {
  assert.deepEqual(marks('function* run(text = external) { use(text); } use(text);', 'text'), [true, true, false]);
  assert.deepEqual(marks('function* run(text = external) { use(text); }', 'external'), [false]);
  assert.deepEqual(marks('(() => { function helper() {} helper(); })(); helper();', 'helper'), [true, true, false]);
});
test('IIFE bindings and defaults retain independent global references', () => {
  assert.deepEqual(marks('(() => { const crypto = require("crypto"); crypto.run(); })(); crypto.run();', 'crypto'), [true, true, false]);
  assert.deepEqual(marks('function f(text, spans = other(text)) { return spans; }', 'other'), [false]);
  assert.deepEqual(marks('function f(text, spans = other(text)) { return spans; }', 'text'), [true, true]);
  assert.deepEqual(marks('(() => { const f = function helper() { helper(); }; helper(); })();', 'helper'), [true, true, false]);
  assert.deepEqual(marks('(() => { for (let text of xs) use(text); use(text); })();', 'text').slice(-1), [false]);
  assert.deepEqual(marks('function f({item: text}, value = outside) { return text; }', 'outside'), [false]);
});
test('async function and generator expression names do not escape their bodies', () => {
  for (const star of ['', '*']) {
    assert.deepEqual(marks(`(() => { const f = async function${star} helper() { helper(); }; helper(); })();`, 'helper'), [true, true, false]);
    assert.deepEqual(marks(`(() => { async function${star} helper() { helper(); } helper(); })(); helper();`, 'helper'), [true, true, true, false]);
  }
});
test('actual lazy authority edges remain while false local edges disappear', () => {
  const graph = buildGraph(), edge = (from, to) => graph.edges.find(e => e.from === from && e.to === to);
  assert.equal(edge('06h9-semantic-policy.js', '06ha-semantic-retrieval.js'), undefined);
  assert.ok(edge('06ha-semantic-retrieval.js', '06h9-semantic-policy.js')?.symbols.includes('SemanticOriginalWindows'));
  for (const core of ['06h9-semantic-policy.js','06hb-semantic-runtime.js','06ha-semantic-retrieval.js']) {
    for (const host of ['00-boot.js','01-config.js','13-http-router.js','10-context-governance.js']) assert.equal(edge(core,host),undefined,core+' must not query '+host);
  }
  assert.ok(edge('06ha-semantic-retrieval.js', '06hb-semantic-runtime.js')?.symbols.includes('SemanticRuntimeTransportProof'));
  assert.equal(edge('06h9-semantic-policy.js', '10-context-governance.js'), undefined);
  assert.equal(edge('06h9-semantic-policy.js', '00-boot.js'), undefined);
});
