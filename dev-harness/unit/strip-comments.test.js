#!/usr/bin/env node
// Unit tests for stripJsComments() — the state-machine comment stripper.
// Uses Node built-in test runner (node:test), zero dependencies.
//
// 第46波46a: require 真身(dev-harness/lib/port-audit.js),不再测复制重实现的副本。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripJsComments } = require('../lib/port-audit');

describe('stripJsComments', () => {
  // ── Line comments ──
  it('strips single-line // comment', () => {
    assert.equal(stripJsComments('const a = 1; // hello\nconst b = 2;'), 'const a = 1; \nconst b = 2;');
  });
  it('strips // at start of line', () => {
    assert.equal(stripJsComments('// entire line\nnext'), '\nnext');
  });
  it('preserves newline after line comment', () => {
    assert.equal(stripJsComments('a;//\nb'), 'a;\nb');
  });

  // ── Block comments ──
  it('strips /* block comment */', () => {
    assert.equal(stripJsComments('a;/* block */b'), 'a;b');
  });
  it('preserves newlines inside block comment', () => {
    // 3 lines: line1\nline2\nline3 → 2 newlines preserved
    // (the */ at the end consumes the last line without adding a trailing \n)
    assert.equal(stripJsComments('a;/* line1\nline2\nline3 */b'), 'a;\n\nb');
  });
  it('handles empty block comment', () => {
    assert.equal(stripJsComments('a;/**/b'), 'a;b');
  });
  it('handles multi-line block comment with leading newline', () => {
    const input = 'const x = 1;\n/*\n * Multi-line\n * comment\n */\nconst y = 2;';
    // 5 newlines in input (after ;, after /*, after Multi-line, after comment, after */)
    // Block preserves 3 of them (after ;, after /*, after Multi-line, after comment)
    // The \n after */ is written in code state
    const result = stripJsComments(input);
    assert.ok(result.startsWith('const x = 1;\n'));
    assert.ok(result.endsWith('\nconst y = 2;'));
    // Total newlines = 5 (all preserved, just comment content removed)
    const nlCount = (result.match(/\n/g) || []).length;
    assert.equal(nlCount, 5);
  });

  // ── String literals (should NOT strip comments inside strings) ──
  it('preserves // inside single-quoted string', () => {
    assert.equal(stripJsComments("const url = 'http://example.com';"), "const url = 'http://example.com';");
  });
  it('preserves // inside double-quoted string', () => {
    assert.equal(stripJsComments('const url = "http://example.com";'), 'const url = "http://example.com";');
  });
  it('preserves /* */ inside single-quoted string', () => {
    assert.equal(stripJsComments("const s = '/* not a comment */';"), "const s = '/* not a comment */';");
  });
  it('preserves /* */ inside double-quoted string', () => {
    assert.equal(stripJsComments('const s = "/* not a comment */";'), 'const s = "/* not a comment */";');
  });

  // ── Template literals ──
  it('preserves // inside template literal', () => {
    assert.equal(stripJsComments('const s = `http://example.com`;'), 'const s = `http://example.com`;');
  });
  it('preserves /* */ inside template literal', () => {
    assert.equal(stripJsComments('const s = `/* not a comment */`;'), 'const s = `/* not a comment */`;');
  });

  // ── Escape sequences ──
  it('handles escaped single quote in string', () => {
    assert.equal(stripJsComments("const s = 'it\\'s // not a comment';"), "const s = 'it\\'s // not a comment';");
  });
  it('handles escaped double quote in string', () => {
    assert.equal(stripJsComments('const s = "say \\"hi\\" // not a comment";'), 'const s = "say \\"hi\\" // not a comment";');
  });

  // ── Port detection (the real use case) ──
  it('preserves port numbers in strings while stripping comments mentioning ports', () => {
    const input = '// use port 8700\nconst url = "http://127.0.0.1:8700";';
    const result = stripJsComments(input);
    assert.ok(!result.includes('use port'));
    assert.ok(result.includes('8700'));
  });

  // ── Empty / trivial input ──
  it('returns empty string for empty input', () => {
    assert.equal(stripJsComments(''), '');
  });
  it('returns code unchanged when no comments', () => {
    assert.equal(stripJsComments('const a = 1;'), 'const a = 1;');
  });

  // ── Idempotency ──
  it('stripping already-stripped code is idempotent', () => {
    const code = 'const a = 1; // comment\nconst b = "str//ing";';
    const once = stripJsComments(code);
    const twice = stripJsComments(once);
    assert.equal(once, twice);
  });

  // ── PORT_BAND regex (integration with port detection) ──
  it('PORT_BAND matches 8700-9199 range', () => {
    const PORT_BAND = /\b(8[7-9]\d\d|9[01]\d\d)\b/g;
    const body = 'const a = 8700; const b = 9199; const c = 8699; const d = 9200;';
    const ports = [...body.matchAll(PORT_BAND)].map(m => m[1]);
    assert.deepEqual(ports, ['8700', '9199']);
  });

  // ── Complex real-world input ──
  it('handles complex real-world e2e file content', () => {
    const input = [
      '// This is a comment with port 8700',
      "const PORT = 8700; // actual port",
      'const url = `http://127.0.0.1:${PORT}`;',
      '/* multi-line',
      '   comment with 8800 */',
      "const other = 'http://localhost:8900/path';",
      '// const old = 9000;',
    ].join('\n');
    const result = stripJsComments(input);
    assert.ok(!result.includes('This is a comment'));
    assert.ok(!result.includes('actual port'));
    assert.ok(!result.includes('multi-line'));
    assert.ok(!result.includes('const old'));
    assert.ok(result.includes('8700'));
    assert.ok(result.includes('PORT'));
    assert.ok(result.includes('8900'));
  });
});
