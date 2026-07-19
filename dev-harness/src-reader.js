'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// src-reader.js — 后端「逻辑全文」统一读取口(第 42a 波)
//
// 为什么存在:dev-harness 里 ~20 件 e2e 直接 readFileSync('app/server.js') 做源码形状锁。
// 第 43 波构建期拼接模块化后,单体 server.js 变成 src/ 多模块 —— 若每件测试各自读路径,
// 拆分当天就是 20 件测试一起红。统一走本模块:
//   · 今天(单体时代):直接读 app/server.js;
//   · 拆分后:读 app/src/manifest.json(模块清单,按序),依序拼接为「逻辑全文」返回。
//     清单顺序 == 原单体声明顺序(43 波铁律),因此:
//       - 存在性锁(/pattern/.test(src))跨拆分原样成立;
//       - 排序性锁(indexOf(A)…indexOf(B) 切片)在声明顺序不变时同样成立。
// 测试永远只面对逻辑全文,不关心物理布局。新增源码锁一律 const src = readServerSource()。
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'ruyi-workbench', 'app');
const SINGLE_FILE = path.join(APP, 'server.js');
const MANIFEST = path.join(APP, 'src', 'manifest.json');

let cache = null; // 单测进程内只读一次(源码在测试运行期不变)

function readServerSource() {
  if (cache) return cache;
  if (fs.existsSync(MANIFEST)) {
    const mods = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).modules;
    cache = mods.map(m => fs.readFileSync(path.join(APP, 'src', m), 'utf8')).join('\n');
  } else {
    cache = fs.readFileSync(SINGLE_FILE, 'utf8');
  }
  return cache;
}

module.exports = { readServerSource, SINGLE_FILE, MANIFEST };
