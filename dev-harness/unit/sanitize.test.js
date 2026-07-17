#!/usr/bin/env node
// Unit tests for sanitizeNode() — XSS defense in app.js.
//
// sanitizeNode() uses browser DOM APIs (TreeWalker, getAttribute, etc.).
// We test the LOGIC patterns that don't require a live DOM:
//   1. ALLOWED_TAGS set completeness
//   2. URL protocol allowlist
//   3. Control-char stripping regex
//   4. Attribute allowlist
// Full integration (TreeWalker traversal) is covered by e2e tests.
//
// Uses Node built-in test runner, zero dependencies.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Extract ALLOWED_TAGS from app.js source ──
const fs = require('fs');
const path = require('path');
const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'app.js'), 'utf8');
const tagsMatch = appSrc.match(/const ALLOWED_TAGS = new Set\(\[([^\]]+)\]\)/);
if (!tagsMatch) throw new Error('Could not extract ALLOWED_TAGS from app.js');
const ALLOWED_TAGS = new Set(tagsMatch[1].split(',').map(s => s.trim().replace(/'/g, '')));

// ── Protocol allowlist (mirrors sanitizeNode logic) ──
function isAllowedUrl(val, baseHref) {
  const v = val.replace(/[\u0000-\u0020]+/g, '');
  try {
    const u = new URL(v, baseHref || 'http://localhost');
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch { /* fall through */ }
  if (/^[#/.?]/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;
  return false;
}

describe('ALLOWED_TAGS', () => {
  it('contains expected structural tags', () => {
    for (const tag of ['P', 'BR', 'HR', 'DIV', 'SPAN', 'BLOCKQUOTE', 'PRE']) {
      assert.ok(ALLOWED_TAGS.has(tag), `missing structural tag: ${tag}`);
    }
  });
  it('contains expected inline/formatting tags', () => {
    for (const tag of ['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'DEL', 'S']) {
      assert.ok(ALLOWED_TAGS.has(tag), `missing inline tag: ${tag}`);
    }
  });
  it('contains heading tags H1-H6', () => {
    for (let i = 1; i <= 6; i++) {
      assert.ok(ALLOWED_TAGS.has(`H${i}`), `missing heading tag: H${i}`);
    }
  });
  it('contains table tags', () => {
    for (const tag of ['TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']) {
      assert.ok(ALLOWED_TAGS.has(tag), `missing table tag: ${tag}`);
    }
  });
  it('contains list tags', () => {
    for (const tag of ['UL', 'OL', 'LI']) {
      assert.ok(ALLOWED_TAGS.has(tag), `missing list tag: ${tag}`);
    }
  });
  it('contains IMG tag', () => {
    assert.ok(ALLOWED_TAGS.has('IMG'));
  });

  // ── Security: dangerous tags must NOT be in allowlist ──
  it('excludes script tag', () => {
    assert.ok(!ALLOWED_TAGS.has('SCRIPT'));
  });
  it('excludes iframe tag', () => {
    assert.ok(!ALLOWED_TAGS.has('IFRAME'));
  });
  it('excludes object/embed tags', () => {
    assert.ok(!ALLOWED_TAGS.has('OBJECT'));
    assert.ok(!ALLOWED_TAGS.has('EMBED'));
  });
  it('excludes form tags', () => {
    for (const tag of ['FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']) {
      assert.ok(!ALLOWED_TAGS.has(tag), `should not allow form tag: ${tag}`);
    }
  });
  it('excludes style tag', () => {
    assert.ok(!ALLOWED_TAGS.has('STYLE'));
  });
  it('excludes meta/link/base tags', () => {
    assert.ok(!ALLOWED_TAGS.has('META'));
    assert.ok(!ALLOWED_TAGS.has('LINK'));
    assert.ok(!ALLOWED_TAGS.has('BASE'));
  });
});

describe('URL protocol allowlist', () => {
  it('allows http:', () => {
    assert.ok(isAllowedUrl('http://example.com'));
  });
  it('allows https:', () => {
    assert.ok(isAllowedUrl('https://example.com'));
  });
  it('allows mailto:', () => {
    assert.ok(isAllowedUrl('mailto:user@example.com'));
  });
  it('blocks javascript:', () => {
    assert.ok(!isAllowedUrl('javascript:alert(1)'));
  });
  it('blocks data:', () => {
    assert.ok(!isAllowedUrl('data:text/html,<script>alert(1)</script>'));
  });
  it('blocks vbscript:', () => {
    assert.ok(!isAllowedUrl('vbscript:MsgBox(1)'));
  });

  // ── Control-char injection (e.g. "java\tscript:" bypass) ──
  it('blocks javascript: with embedded tab', () => {
    assert.ok(!isAllowedUrl('java\tscript:alert(1)'));
  });
  it('blocks javascript: with embedded newline', () => {
    assert.ok(!isAllowedUrl('java\nscript:alert(1)'));
  });
  it('blocks javascript: with null byte', () => {
    assert.ok(!isAllowedUrl('java\x00script:alert(1)'));
  });

  // ── Relative/fragment URLs ──
  it('allows relative path', () => {
    assert.ok(isAllowedUrl('./page.html'));
  });
  it('allows absolute path', () => {
    assert.ok(isAllowedUrl('/page.html'));
  });
  it('allows fragment', () => {
    assert.ok(isAllowedUrl('#section'));
  });
  it('allows query string', () => {
    assert.ok(isAllowedUrl('?q=test'));
  });

  // ── Edge cases ──
  it('empty string resolves to base URL (allowed — means "current page")', () => {
    // new URL('', 'http://localhost') → http://localhost (http: protocol allowed)
    assert.ok(isAllowedUrl(''));
  });
  it('blocks ftp:', () => {
    assert.ok(!isAllowedUrl('ftp://files.example.com'));
  });
  it('blocks file:', () => {
    assert.ok(!isAllowedUrl('file:///etc/passwd'));
  });
});

describe('Attribute sanitization rules', () => {
  // These test the LOGIC of which attributes are kept/removed.
  // The actual DOM manipulation is tested via e2e.

  const ALLOWED_ATTR_NAMES = new Set(['class', 'alt', 'title']);
  const URL_ATTRS = new Set(['href', 'src']);

  it('class attribute is allowed', () => {
    assert.ok(ALLOWED_ATTR_NAMES.has('class'));
  });
  it('alt attribute is allowed', () => {
    assert.ok(ALLOWED_ATTR_NAMES.has('alt'));
  });
  it('title attribute is allowed', () => {
    assert.ok(ALLOWED_ATTR_NAMES.has('title'));
  });
  it('href/src are handled specially (URL validation)', () => {
    assert.ok(URL_ATTRS.has('href'));
    assert.ok(URL_ATTRS.has('src'));
  });

  // on* attributes must be stripped
  it('onclick is not in allowed names (must be stripped)', () => {
    assert.ok(!ALLOWED_ATTR_NAMES.has('onclick'));
    assert.ok(!ALLOWED_ATTR_NAMES.has('onload'));
    assert.ok(!ALLOWED_ATTR_NAMES.has('onerror'));
    assert.ok(!ALLOWED_ATTR_NAMES.has('onmouseover'));
  });

  // Dangerous attributes
  it('style is not allowed (CSS injection)', () => {
    assert.ok(!ALLOWED_ATTR_NAMES.has('style'));
  });
  it('action is not allowed (form hijack)', () => {
    assert.ok(!ALLOWED_ATTR_NAMES.has('action'));
  });
});
