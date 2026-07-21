#!/usr/bin/env node
// Unit tests for portAudit() — port collision detection.
// Uses Node built-in test runner + temp directories for fixture files.
//
// 第46波46a: require 真身(dev-harness/lib/port-audit.js),不再测复制重实现的副本。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { portAuditFromDir } = require('../lib/port-audit');

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
