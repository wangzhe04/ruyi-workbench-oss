#!/usr/bin/env node
// Unit tests for the 117q-G1 spread/rest-dots fix in module-dependency-graph.js.
// Uses Node built-in test runner (node:test), zero dependencies.
//
// 117q-G1: tokenize() renders a rest/spread marker `...` as three consecutive '.' punct tokens (there is no
// dedicated token type for it). The cross-module requires scan in buildGraph() decides "is this identifier a
// genuine reference, or a property read I should ignore" by checking whether the immediately preceding token
// is '.' - which is also exactly what precedes a spread/rest TARGET (`[a, ...B]`, `{...B}`, `fn(...B)` all put
// a single '.' right before `B`, indistinguishable from `x.B` by a one-token lookback). Before this fix, every
// spread target was silently dropped as if it were a property access - which is how
// `06f-autonomy-grants.js`'s `[/regex/, ...AUTOEXEC_DENYLIST]` reference to 03-bridge-guard.js's exported
// `AUTOEXEC_DENYLIST` went unrecorded in the generated dependency graph (docs/architecture/module-dependency-
// graph.json), even though `node --check` sees it as a real read.
//
// These tests exercise the exported precededByRestDots()/isMemberAccessSkip() helpers (used by buildGraph()'s
// requires scan) and declarationInfo() (used for the companion destructuring-rest-declaration fix) directly
// against small snippets - the same style dev-harness/unit/module-dependency-graph-params.test.js already
// uses for the sibling 110-h1 arrow-parameter fix.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, declarationInfo, precededByRestDots, isMemberAccessSkip } = require('../module-dependency-graph');

// Finds the token index of the first occurrence of `name` and returns whether isMemberAccessSkip() would
// make buildGraph()'s requires scan skip it (true = skipped / NOT recorded as a reference).
function skipDecisionFor(source, name) {
  const tokens = tokenize(source);
  const index = tokens.findIndex(token => token.type === 'id' && token.value === name);
  assert.ok(index > -1, `expected an occurrence of "${name}" in: ${source}`);
  return isMemberAccessSkip(tokens, index);
}

describe('module-dependency-graph spread/rest-dots reference detection (117q-G1)', () => {
  it('does NOT skip an array-literal spread target - the exact 06f/03 AUTOEXEC_DENYLIST shape', () => {
    assert.equal(skipDecisionFor('const arr = [a, ...AUTOEXEC_DENYLIST];', 'AUTOEXEC_DENYLIST'), false);
  });

  it('does NOT skip an object-literal spread target', () => {
    assert.equal(skipDecisionFor('const obj = { ...AUTOEXEC_DENYLIST, extra: 1 };', 'AUTOEXEC_DENYLIST'), false);
  });

  it('does NOT skip a call-argument spread target', () => {
    assert.equal(skipDecisionFor('fn(a, ...AUTOEXEC_DENYLIST);', 'AUTOEXEC_DENYLIST'), false);
  });

  it('does NOT skip a spread target that is itself a call expression (spreading a call result)', () => {
    // Real shape from 13f-native-tool-schemas.js: `...adaptiveMetaToolSchemas(true)`.
    assert.equal(skipDecisionFor('const arr = [...adaptiveMetaToolSchemas(true), extra];', 'adaptiveMetaToolSchemas'), false);
  });

  it('still skips genuine member access (single preceding dot, not a spread)', () => {
    assert.equal(skipDecisionFor('const v = x.AUTOEXEC_DENYLIST;', 'AUTOEXEC_DENYLIST'), true);
  });

  it('still skips an object-literal key (identifier followed by ":")', () => {
    assert.equal(skipDecisionFor('const o = { AUTOEXEC_DENYLIST: 1 };', 'AUTOEXEC_DENYLIST'), true);
  });

  it('still skips optional-chaining member access', () => {
    assert.equal(skipDecisionFor('const v = x?.AUTOEXEC_DENYLIST;', 'AUTOEXEC_DENYLIST'), true);
  });

  it('precededByRestDots is false for a plain single dot (member access)', () => {
    const tokens = tokenize('x.B');
    const index = tokens.findIndex(t => t.value === 'B');
    assert.equal(precededByRestDots(tokens, index), false);
  });

  it('precededByRestDots is true for a genuine spread marker', () => {
    const tokens = tokenize('[...B]');
    const index = tokens.findIndex(t => t.value === 'B');
    assert.equal(precededByRestDots(tokens, index), true);
  });

  it('marks a destructured rest binding as a local declaration (const { a, ...rest } = Foo;)', () => {
    // Companion fix: once the requires scan above stops blanket-skipping every preceding-'.' identifier, a
    // destructured rest *declaration* site (which also has a single '.' right before it) must be recorded in
    // declarationTokenIndexes - otherwise a rest name that collides with another module's top-level export
    // would look like a genuine reference to it instead of a local binding. This is the "误记" failure mode
    // the brief warned is worse than under-recording: a false edge, not a missed one.
    const src = 'const { a, ...rest } = Foo;';
    const tokens = tokenize(src);
    const { declarationTokenIndexes } = declarationInfo(tokens);
    const restIndex = tokens.findIndex(t => t.type === 'id' && t.value === 'rest');
    assert.ok(restIndex > -1);
    assert.equal(declarationTokenIndexes.has(restIndex), true);
    // The RHS reference itself must stay a genuine, unmarked reference.
    const fooIndex = tokens.findIndex(t => t.type === 'id' && t.value === 'Foo');
    assert.equal(declarationTokenIndexes.has(fooIndex), false);
  });

  it('still recognizes a plain (non-rest) destructured binding as local, unaffected by the rest-dots carve-out', () => {
    const src = 'const { a, b } = Foo;';
    const tokens = tokenize(src);
    const { declarationTokenIndexes } = declarationInfo(tokens);
    const aIndex = tokens.findIndex(t => t.type === 'id' && t.value === 'a');
    const bIndex = tokens.findIndex(t => t.type === 'id' && t.value === 'b');
    assert.equal(declarationTokenIndexes.has(aIndex), true);
    assert.equal(declarationTokenIndexes.has(bIndex), true);
  });

  it('a destructured rest binding whose name collides with an external symbol is NOT eligible as a reference', () => {
    // End-to-end guard for the same companion fix, checked the way buildGraph() would see it: the rest
    // binding's own token must be both (a) recorded as local and (b) not member-access-skippable-as-a-
    // reference in a way that would matter, i.e. buildGraph()'s declarationTokenIndexes check already short-
    // circuits it before isMemberAccessSkip() is even consulted.
    const src = 'const { a, ...AUTOEXEC_DENYLIST } = Foo;';
    const tokens = tokenize(src);
    const { declarationTokenIndexes } = declarationInfo(tokens);
    const index = tokens.findIndex(t => t.type === 'id' && t.value === 'AUTOEXEC_DENYLIST');
    assert.equal(declarationTokenIndexes.has(index), true, 'rest binding must be local, not a free reference');
  });

  it('template-literal interpolation references are still visible (unrelated to spread, verifying no regression)', () => {
    assert.equal(skipDecisionFor('const s = `hi ${AUTOEXEC_DENYLIST}`;', 'AUTOEXEC_DENYLIST'), false);
  });

  it('a symbol name inside a regex body produces no token at all (must not be countable as a reference)', () => {
    const tokens = tokenize('const re = /AUTOEXEC_DENYLIST/;');
    assert.equal(tokens.some(t => t.value === 'AUTOEXEC_DENYLIST'), false);
  });
});
