#!/usr/bin/env node
// lib/harness.js 的单测:打印口径必须是 run-all.js 解析的那一套(PASS/FAIL 行、判定行、退出码)。
// 真起子进程跑 —— done() 会动 process.exitCode / process.exit,不能在 node --test 的进程里直调。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'harness.js');

function runScript(body) {
  const src = `const { createRunner } = require(${JSON.stringify(LIB)});\n${body}`;
  const r = cp.spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: String(r.stdout).split(/\r?\n/) };
}

describe('lib/harness createRunner', () => {
  it('all-pass: PASS lines, ALL PASS verdict, exit 0', () => {
    const r = runScript(`const t = createRunner('DEMO'); const { ok } = t; ok(true, 'A1 一'); ok(1, 'A2 二'); t.done();`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.filter(l => /^(PASS|FAIL)\b/.test(l)), ['PASS A1 一', 'PASS A2 二']);
    assert.equal(r.lines.filter(Boolean).pop(), 'DEMO E2E: ALL PASS');
    assert.equal(r.stderr, '');
  });

  it('failures: FAIL lines on stdout, FAIL (n) verdict, exit 1; fail() with/without label', () => {
    const r = runScript(`const t = createRunner('DEMO X'); const { ok } = t;
      const a = ok(false, 'B1 坏'); const b = ok(true, 'B2 好');
      t.fail('fatal: boom'); t.fail();
      console.log('failures=' + t.failures + ' a=' + a + ' b=' + b);
      t.done();`);
    assert.equal(r.status, 1);
    assert.deepEqual(r.lines.filter(l => /^(PASS|FAIL)\b/.test(l)), ['FAIL B1 坏', 'PASS B2 好', 'FAIL fatal: boom']);
    assert.ok(r.lines.includes('failures=3 a=false b=true'));
    assert.equal(r.lines.filter(Boolean).pop(), 'DEMO X E2E: FAIL (3)');
    // run-all.js failLines() 的判据:/^\s*FAIL\b/ —— 判定行本身不能被当成一条断言
    const runAllFailLines = r.lines.filter(l => /^\s*FAIL\b/.test(l));
    assert.equal(runAllFailLines.length, 2);
  });

  it('done({ exit: true }) exits immediately with the verdict code even with pending handles', () => {
    const r = runScript(`const t = createRunner('HARD'); t.ok(false, 'C1'); setInterval(() => {}, 1000); t.done({ exit: true });`);
    assert.equal(r.status, 1);
    assert.equal(r.lines.filter(Boolean).pop(), 'HARD E2E: FAIL (1)');
  });

  it('verdict() and a bad name', () => {
    const { createRunner } = require(LIB);
    const t = createRunner('V');
    assert.equal(t.verdict(), 'V E2E: ALL PASS');
    assert.throws(() => createRunner(''), TypeError);
  });
});
