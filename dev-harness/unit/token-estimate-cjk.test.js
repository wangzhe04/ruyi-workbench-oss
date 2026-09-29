'use strict';
// 性能批 C2:09d countCjkCodeUnits 与修前的 str.match(CJK_RE).length 逐个相同。
//   [T1] 全部 65536 个 UTF-16 码元逐个比对(区间边界、代理区一个不漏)
//   [T2] 随机串(混 ASCII / 汉字 / 韩文 / 全角 / emoji 代理对)比对计数与 estimateTextTokens 结果
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { readServerSource } = require('../src-reader');
const { functionBlock, constBlock } = require('../lib/source-slice');
const source = readServerSource();
const ctx = vm.createContext({});
vm.runInContext([constBlock(source, 'CJK_RE'), functionBlock(source, 'countCjkCodeUnits'),
  'globalThis.api = { CJK_RE, countCjkCodeUnits };'].join('\n'), ctx);
const { CJK_RE, countCjkCodeUnits } = ctx.api;
const byRegex = s => (s.match(CJK_RE) || []).length;

test('[T1] 每个码元单独比对', () => {
  for (let c = 0; c < 0x10000; c++) {
    const s = String.fromCharCode(c);
    assert.equal(countCjkCodeUnits(s), byRegex(s), `U+${c.toString(16)}`);
  }
});

test('[T2] 随机串计数一致', () => {
  let seed = 42;
  const r = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const pools = ['abc XYZ 123 {}[]', '中文汉字测试压缩', '한국어텍스트', 'ＡＢＣ１２３，。', '😀🎉𝄞', '⺀鿿가힣豈﫿︰﹏＀￯⹿ꀀ힤︯﹐￰'];
  for (let k = 0; k < 500; k++) {
    let s = '';
    const n = Math.floor(r() * 400);
    for (let i = 0; i < n; i++) { const p = pools[Math.floor(r() * pools.length)]; s += p[Math.floor(r() * p.length)]; }
    assert.equal(countCjkCodeUnits(s), byRegex(s));
  }
});
