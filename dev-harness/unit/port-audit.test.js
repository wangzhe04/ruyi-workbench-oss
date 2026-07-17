#!/usr/bin/env node
// Unit tests for portAudit() — port collision detection in run-all.js.
// Uses Node built-in test runner + temp directories for fixture files.
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Re-implement portAudit logic from run-all.js for isolated testing ──
const PORT_BAND = /\b(8[7-9]\d\d|9[01]\d\d)\b/g;

function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = 'code';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i++; continue; }
      if (c === '"') { st = 'dq'; out += c; i++; continue; }
      if (c === '`') { st = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') { if (c === '\n') { out += '\n'; st = 'code'; } i++; continue; }
    if (st === 'block') { if (c === '*' && d === '/') { st = 'code'; i += 2; continue; } if (c === '\n') out += '\n'; i++; continue; }
    const term = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    out += c; i++;
    if (c === term) st = 'code';
  }
  return out;
}

function portAuditFromDir(dir) {
  const claims = new Map();
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.e2e.js'))) {
    const body = stripJsComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of body.matchAll(PORT_BAND)) {
      if (!claims.has(m[1])) claims.set(m[1], new Set());
      claims.get(m[1]).add(f);
    }
  }
  const collisions = [...claims.entries()].filter(([, set]) => set.size > 1)
    .map(([p, set]) => `${p} <- ${[...set].join(', ')}`);
  return { count: claims.size, collisions };
}

// ── Fixture helpers ──
let tmpDir;
function writeFile(name, content) {
  fs.writeFileSync(path.join(tmpDir, name), content);
}

describe('portAudit', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-audit-test-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects no collisions when ports are unique', () => {
    // Clean dir
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', 'const PORT = 8700;');
    writeFile('b.e2e.js', 'const PORT = 8800;');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.collisions.length, 0);
    assert.equal(audit.count, 2);
  });

  it('detects collision when two files share a port', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', 'const PORT = 8700;');
    writeFile('b.e2e.js', 'const PORT = 8700;');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.collisions.length, 1);
    assert.ok(audit.collisions[0].includes('8700'));
  });

  it('ignores port mentions in comments', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', '// old port was 8700\nconst PORT = 8800;');
    writeFile('b.e2e.js', 'const PORT = 8700;');
    const audit = portAuditFromDir(tmpDir);
    // 8700 only appears in b.e2e.js (comment in a.e2e.js is stripped)
    assert.equal(audit.collisions.length, 0);
    assert.equal(audit.count, 2);
  });

  it('counts ports inside string literals', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', 'const url = "http://127.0.0.1:8700";');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.count, 1);
    assert.equal(audit.collisions.length, 0);
  });

  it('handles multiple ports in one file', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', 'const P1 = 8700; const P2 = 8800; const P3 = 8900;');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.count, 3);
    assert.equal(audit.collisions.length, 0);
  });

  it('ignores non-.e2e.js files', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('helper.js', 'const PORT = 8700;');  // not .e2e.js
    writeFile('a.e2e.js', 'const PORT = 8700;');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.count, 1);
    assert.equal(audit.collisions.length, 0);
  });

  it('handles empty directory', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.count, 0);
    assert.equal(audit.collisions.length, 0);
  });

  it('PORT_BAND regex boundary: 8699 and 9200 excluded', () => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
    writeFile('a.e2e.js', 'const A = 8699; const B = 8700; const C = 9199; const D = 9200;');
    const audit = portAuditFromDir(tmpDir);
    assert.equal(audit.count, 2); // only 8700, 9199
  });
});
