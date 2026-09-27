'use strict';
// 架构还债批 3·D:dev-harness/lib/source-slice.js 的真值表。
//   [S1] sliceBlock:字符串/正则两种标记、end 只在 start 之后找、找不到给 ''、inclusive。
//   [S2] constBlock:括号配对跨过字符串/模板/注释/正则里的闭括号;Object.freeze({…}) / new Set([…]) 整条;
//        链式初值([…].map(…))不在第一个闭括号处截断;标量初值切到分号;找不到给 ''。
//   [S3] functionBlock:async、带解构默认值的参数、函数体里的 '}' 字符串与正则;找不到给 ''。
//   [S4] bracedBlock:从标记切到其后第一个 { 的配对 },跨过模板里的 ${…}。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sliceBlock, constBlock, functionBlock, bracedBlock } = require('../lib/source-slice.js');

test('[S1] sliceBlock', () => {
  const src = 'a END b START x END y END';
  assert.equal(sliceBlock(src, 'START', 'END'), 'START x ');
  assert.equal(sliceBlock(src, 'START', 'END', { inclusive: true }), 'START x END');
  assert.equal(sliceBlock(src, /ST\w+/, /E\wD/), 'START x ');
  assert.equal(sliceBlock(src, 'NOPE', 'END'), '');
  assert.equal(sliceBlock(src, 'START', 'NOPE'), '');
});

test('[S2] constBlock', () => {
  const src = [
    "const A = Object.freeze({ a: '}', b: `x${ {c: 1}.c }]`, // } comment",
    "  d: /\\}[}\\]]/g, /* } */ e: [1, 2],",
    '});',
    'const B = new Set([',
    "  'x', 'y',",
    ']);',
    'const C = [1, 2]',
    '  .map(n => n * 2);',
    'const D = 42;',
    'export const E = { e: 1 }',
    'const F = 1;',
  ].join('\n');
  assert.equal(constBlock(src, 'A'), src.split('\n').slice(0, 3).join('\n'));
  assert.equal(constBlock(src, 'B'), "const B = new Set([\n  'x', 'y',\n]);");
  assert.equal(constBlock(src, 'C'), 'const C = [1, 2]\n  .map(n => n * 2);');
  assert.equal(constBlock(src, 'D'), 'const D = 42;');
  assert.equal(constBlock(src, 'E'), 'export const E = { e: 1 }');
  assert.equal(constBlock(src, 'Z'), '');
  assert.equal(constBlock('const AB = 1;\nconst A = 2;', 'A'), 'const A = 2;', '名字按整词匹配');
});

test('[S3] functionBlock', () => {
  const src = [
    'function other() { return 1; }',
    "async function target({ focus = false } = {}, re = /\\)/) {",
    "  if (x) { return '}'; }",
    '  return `${ {a: 1}.a }`;',
    '}',
    'function after() {}',
  ].join('\n');
  assert.equal(functionBlock(src, 'target'), src.split('\n').slice(1, 5).join('\n'));
  assert.equal(functionBlock(src, 'after'), 'function after() {}');
  assert.equal(functionBlock(src, 'missing'), '');
});

test('[S4] bracedBlock', () => {
  const src = "x();\nfor (const r of LIST) {\n  if (!ok(r)) { log(`skip ${r}`); continue; }\n  use(r);\n}\nafter();";
  assert.equal(bracedBlock(src, 'for (const r of LIST)'), src.split('\n').slice(1, 5).join('\n'));
  assert.equal(bracedBlock(src, 'while ('), '');
});
