'use strict';
// 11 globToRegExp:glob 匹配器(file_search 的 glob、glob 工具、授权书的 pathGlob 共用)。
// 修前把 glob 译成正则,`*a*a*a*a*a*b` 这类 glob 在长文件名上多项式回溯、卡死主线程;现在是逐字符推进的 NFA。
//   [G1] 与参照正则译法在随机 glob × 随机路径的网格上逐格一致(参照实现是修前那段代码,只按 2026-10 工具走查改了
//        `**/` 一处语义:段首的 `**/` = 零个或多个【完整】目录段 `(?:[^/]+/)*` —— 修前是「任意字符 + 可省分隔符」,
//        `**/test.py` 连 `mytest.py` 也配上;不在段首的 `**` 仍是 `.*`,其后的分隔符照常必须出现);
//   [G2] 手写的边角:`**/x` 配根下的 x、两种分隔符互认、`*`/`?` 不跨段、大小写不敏感、整串锚定、正则元字符当字面;
//   [G3] 病态 glob 对长文件名:修前的正则要跑几秒,匹配器在 50ms 内给出同样的答案。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readServerSource } = require('../src-reader');
const { functionBlock } = require('../lib/source-slice');

const globToMatcher = new Function(functionBlock(readServerSource(), 'globToRegExp') + '\nreturn globToRegExp;')();

// 参照实现:glob → 锚定、大小写不敏感的正则(修前那段代码 + 段首 `**/` 的语义修正,见头注)。
function legacyGlobToRegExp(glob) {
  const g = String(glob || '');
  let re = '';
  let segStart = true;
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (segStart && (g[i + 1] === '/' || g[i + 1] === '\\')) { re += '(?:[^\\\\/]+[\\\\/])*'; i += 1; segStart = true; continue; }
        re += '.*';
      } else re += '[^\\\\/]*';
    } else if (c === '?') re += '[^\\\\/]';
    else if (c === '/' || c === '\\') { re += '[\\\\/]'; segStart = true; continue; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    segStart = false;
  }
  return new RegExp('^' + re + '$', 'i');
}

function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('[G1] 随机网格上与修前的正则译法逐格一致', () => {
  const r = rng(20260930);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const globAtoms = ['*', '**', '?', '/', '\\', 'a', 'B', '.', 'x', 'js', '**/', '(', '+', '['];
  const pathAtoms = ['a', 'b', 'A', 'x', '.', 'js', '/', '\\', 'src', '(', '+', '['];
  let cells = 0;
  for (let gi = 0; gi < 400; gi += 1) {
    let glob = '';
    const gl = 1 + Math.floor(r() * 7);
    for (let k = 0; k < gl; k += 1) glob += pick(globAtoms);
    const legacy = legacyGlobToRegExp(glob);
    const now = globToMatcher(glob);
    for (let pi = 0; pi < 60; pi += 1) {
      let p = '';
      const pl = Math.floor(r() * 9);
      for (let k = 0; k < pl; k += 1) p += pick(pathAtoms);
      assert.equal(now.test(p), legacy.test(p), `glob ${JSON.stringify(glob)} path ${JSON.stringify(p)}`);
      cells += 1;
    }
  }
  assert.ok(cells >= 24000);
});

test('[G2] 边角语义', () => {
  const m = g => globToMatcher(g);
  assert.equal(m('**/x.js').test('x.js'), true, '`**/` 可省:根下的 x.js');
  assert.equal(m('**/x.js').test('a/b/x.js'), true);
  assert.equal(m('src/*.js').test('src\\a.js'), true, '两种分隔符互认');
  assert.equal(m('src/*.js').test('src/a/b.js'), false, '`*` 不跨段');
  assert.equal(m('?.js').test('/.js'), false, '`?` 不配分隔符');
  assert.equal(m('*.JS').test('a.js'), true, '大小写不敏感');
  assert.equal(m('*.js').test('a.jsx'), false, '整串锚定');
  assert.equal(m('a+(b).js').test('a+(b).js'), true, '正则元字符当字面');
  assert.equal(m('a+(b).js').test('aa(b)xjs'), false);
  assert.equal(m('').test(''), true);
  assert.equal(m('').test('a'), false);
  assert.equal(typeof m('*').test, 'function');
});

test('[G3] 病态 glob 对长文件名:线性时间内给出与参照相同的答案', () => {
  const glob = '*a*a*a*a*a*a*a*b';
  const name = 'a'.repeat(120);
  const t0 = process.hrtime.bigint();
  const got = globToMatcher(glob).test(name);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(got, false);
  assert.ok(ms < 50, `matcher took ${ms.toFixed(1)} ms`);
  // 参照答案用短一点的名字算(修前的正则在 120 字上要跑很久,这正是修的东西)
  assert.equal(globToMatcher(glob).test('a'.repeat(12)), legacyGlobToRegExp(glob).test('a'.repeat(12)));
});
