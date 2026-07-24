#!/usr/bin/env node
// 静态锁 (EC-A 真实基线): manifest.json 行区间防漂移。
// build.js 自动回填 + --check 校验已能拦 0/0 与过期区间;本件【独立重算】每个模块的期望区间
// 并逐一断言(无 0/0 / 与产物实际位置一致 / 模块间连续无缝隙 / 覆盖产物末尾),
// 使行区间契约在 run-all/CI 显式可见,即使有人绕过 build --check 也跑不红。
// 算法与 build.js computeRanges 同源:src 文件以 \n 结尾,故 endLine = startLine + 该模块换行数。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const man = JSON.parse(fs.readFileSync(path.join(APP, 'src', 'manifest.json'), 'utf8'));
ok(Array.isArray(man.modules) && man.modules.length > 0, 'manifest.modules 非空');

const built = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
let line = 1, prevEnd = 0;
for (const m of man.modules) {
  const body = fs.readFileSync(path.join(APP, 'src', m.file), 'utf8');
  const nl = (body.match(/\n/g) || []).length;
  const expStart = line, expEnd = line + nl;
  ok(m.startLine !== 0 && m.endLine !== 0, `${m.file} 非 0/0(声明 [${m.startLine},${m.endLine}])`);
  ok(m.startLine === expStart && m.endLine === expEnd, `${m.file} 区间 == 实际(声明 [${m.startLine},${m.endLine}] == 预期 [${expStart},${expEnd}])`);
  if (prevEnd) ok(m.startLine === prevEnd + 1, `${m.file} 与上一模块连续(startLine ${m.startLine} == 上 endLine+1 ${prevEnd + 1})`);
  prevEnd = m.endLine;
  line = expEnd + 1;
}
const totalLines = built.split('\n').length;
ok(Math.abs(prevEnd - totalLines) <= 1, `末模块 endLine(${prevEnd}) 覆盖产物末尾(${totalLines})`);

console.log('\nMANIFEST RANGES STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
