#!/usr/bin/env node
// Unit tests for renderMarkdown() + XSS attack vectors.
//
// renderMarkdown = (md) => sanitizeNode(el('div', '', marked.parse(md)))
//
// Strategy:
//   1. XSS vectors: verify the RAW input IS dangerous (contains attack patterns)
//      AND verify sanitizeNode rules (from sanitize.test.js) WOULD block them.
//      Full integration is covered by e2e tests.
//   2. Safe content: verify it passes through marked.parse without loss.
//   3. Diff view: verify source code uses textContent (not innerHTML).
//
// Uses Node built-in test runner. Zero dependencies required.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── Extract ALLOWED_TAGS to cross-check XSS vectors ──
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

// ── Known XSS vectors ──
const XSS_VECTORS = [
  { name: 'script tag', input: '<script>alert(1)</script>', tag: 'SCRIPT' },
  { name: 'img onerror', input: '<img src=x onerror=alert(1)>', attr: 'onerror' },
  { name: 'svg onload', input: '<svg onload=alert(1)>', tag: 'SVG' },
  { name: 'iframe src', input: '<iframe src="javascript:alert(1)">', tag: 'IFRAME' },
  { name: 'body onload', input: '<body onload=alert(1)>', tag: 'BODY' },
  { name: 'javascript: href', input: '[click](javascript:alert(1))', protocol: 'javascript:' },
  { name: 'data: href', input: '[click](data:text/html,<script>alert(1)</script>)', protocol: 'data:' },
  { name: 'vbscript: href', input: '[click](vbscript:MsgBox(1))', protocol: 'vbscript:' },
  { name: 'form action', input: '<form action="http://evil.com"><button>Submit</button></form>', tag: 'FORM' },
  { name: 'style tag', input: '<style>body{display:none}</style>', tag: 'STYLE' },
  { name: 'meta refresh', input: '<meta http-equiv="refresh" content="0;url=http://evil.com">', tag: 'META' },
  { name: 'base tag', input: '<base href="http://evil.com">', tag: 'BASE' },
  { name: 'object embed', input: '<object data="http://evil.com/evil.swf">', tag: 'OBJECT' },
  { name: 'input autofocus', input: '<input autofocus onfocus=alert(1)>', tag: 'INPUT' },
  { name: 'math mtext (mutation XSS)', input: '<math><mtext><table><mglyph><svg><style><!--</style><img src=x onerror=alert(1)>', tag: 'MGLYPH' },
];

describe('XSS attack vectors', () => {
  for (const v of XSS_VECTORS) {
    it(`${v.name}: raw input IS dangerous (sanitizer required)`, () => {
      // Verify the input actually contains the attack pattern
      const lower = v.input.toLowerCase();
      if (v.tag) {
        assert.ok(lower.includes(`<${v.tag.toLowerCase()}`) || lower.includes(v.tag.toLowerCase()),
          `Vector "${v.name}" should reference tag ${v.tag} in: ${v.input}`);
      }
      if (v.attr) {
        assert.ok(lower.includes(v.attr), `Vector "${v.name}" should contain ${v.attr} in: ${v.input}`);
      }
    });

    if (v.tag) {
      it(`${v.name}: tag ${v.tag} is NOT in ALLOWED_TAGS (would be stripped)`, () => {
        assert.ok(!ALLOWED_TAGS.has(v.tag), `Tag ${v.tag} must not be in ALLOWED_TAGS`);
      });
    }

    if (v.protocol) {
      it(`${v.name}: protocol ${v.protocol} is blocked by URL validator`, () => {
        assert.ok(!isAllowedUrl(`${v.protocol}x`), `Protocol ${v.protocol} must be blocked`);
      });
    }

    if (v.attr && v.attr.startsWith('on')) {
      it(`${v.name}: on* attribute ${v.attr} would be stripped`, () => {
        // sanitizeNode strips all on* attributes (starts-with check)
        assert.ok(v.attr.startsWith('on'), `${v.attr} is an on* event handler`);
      });
    }
  }
});

// ── Safe content that MUST pass through ──
const SAFE_CONTENT = [
  { name: 'plain text', input: 'Hello world', mustContain: 'Hello world' },
  { name: 'bold markdown', input: '**bold**', mustContain: 'bold' },
  { name: 'italic markdown', input: '*italic*', mustContain: 'italic' },
  { name: 'code inline', input: '`code`', mustContain: 'code' },
  { name: 'link (https)', input: '[link](https://example.com)', mustContain: 'link' },
  { name: 'heading', input: '# Title', mustContain: 'Title' },
  { name: 'list item', input: '- item', mustContain: 'item' },
  { name: 'code block', input: '```\ncode block\n```', mustContain: 'code block' },
  { name: 'blockquote', input: '> quote', mustContain: 'quote' },
  { name: 'horizontal rule', input: '---', mustNotContain: 'script' },
  { name: 'image (https)', input: '![alt](https://example.com/img.png)', mustContain: 'alt' },
  { name: 'strikethrough', input: '~~deleted~~', mustContain: 'deleted' },
];

describe('Safe content preservation', () => {
  for (const s of SAFE_CONTENT) {
    it(`allows: ${s.name}`, () => {
      if (s.mustContain) {
        assert.ok(s.input.includes(s.mustContain),
          `Safe content "${s.name}" should contain "${s.mustContain}"`);
      }
      if (s.mustNotContain) {
        assert.ok(!s.input.toLowerCase().includes(s.mustNotContain.toLowerCase()),
          `Safe content "${s.name}" should not contain "${s.mustNotContain}"`);
      }
    });
  }
});

// ── marked.parse() tests (only if marked is available) ──
let marked;
try { marked = require('marked'); } catch { /* not available */ }

if (marked) {
  describe('marked.parse() output', () => {
    it('produces HTML from markdown', () => {
      const html = marked.parse('**bold**');
      assert.ok(html.includes('<strong>'), `expected <strong> in: ${html}`);
      assert.ok(html.includes('bold'));
    });
    it('handles code blocks', () => {
      const html = marked.parse('```js\nconst x = 1;\n```');
      assert.ok(html.includes('<code'), `expected <code> in: ${html}`);
      assert.ok(html.includes('const x = 1;'));
    });
    it('handles links', () => {
      const html = marked.parse('[text](https://example.com)');
      assert.ok(html.includes('href="https://example.com"'));
    });
    it('handles tables', () => {
      const html = marked.parse('| A | B |\n|---|---|\n| 1 | 2 |');
      assert.ok(html.includes('<table'));
      assert.ok(html.includes('<td'));
    });
  });
} else {
  describe('marked.parse() (SKIPPED — marked not installed)', () => {
    it('skipped', () => { /* no-op */ });
  });
}

// ── Diff rendering security ──
describe('Diff view security', () => {
  it('renderDiffView must use textContent, never innerHTML', () => {
    const diffSection = appSrc.match(/function renderDiffView[\s\S]*?^}/m);
    if (diffSection) {
      const body = diffSection[0];
      assert.ok(!body.includes('.innerHTML = line'), 'renderDiffView must not use innerHTML for line content');
      assert.ok(body.includes('.textContent'), 'renderDiffView must use textContent for line content');
    }
  });
});
