#!/usr/bin/env node
// 静态锁 (第47波47d · X2): overlay 载荷漂移锁 —— PAYLOAD_FILES 与实际运行时依赖集机械对账。
//
// 教训(43e 对抗轮真机事故):前端模块化只发了 icons.js,app.js import 全 5 模块 → overlay 用户白屏。
// PAYLOAD_FILES 手工枚举,新增运行时文件忘登记即静默漏发。本锁三个方向都焊死:
//   ① index.html / app.js 显式引用的每个运行时资源(script/link/module import/locale)必须在载荷表;
//   ② 载荷表每条必须在磁盘存在(防写错路径);
//   ③ 载荷敏感目录(app/public/js|locales|vendor、app/src)磁盘上的每个文件必须在表里
//      (防"新文件忘登记" —— 43e 同款事故的预防针)。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'ruyi-workbench');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const boSrc = fs.readFileSync(path.join(ROOT, 'tools', 'build-overlay.js'), 'utf8');
// 重建载荷清单:字面条目 + manifest 驱动的 src 模块(与 build-overlay.js:21-22 同构)。
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'src', 'manifest.json'), 'utf8'));
const srcModules = manifest.modules.map(m => 'app/src/' + (typeof m === 'string' ? m : m.file));
const arrayBlock = (boSrc.match(/const PAYLOAD_FILES = \[([\s\S]*?)\];/) || [])[1] || '';
const literals = [...arrayBlock.matchAll(/'((?:app|Start|resources|tools)\/[^']+|Start-Workbench\.cmd)'/g)].map(m => m[1]);
const payload = new Set([...literals, ...srcModules]);
ok(literals.length > 10 && srcModules.length > 5, `载荷清单可重建(字面 ${literals.length} + src 模块 ${srcModules.length})`);

// ② 每条载荷在磁盘存在。
const missingOnDisk = [...payload].filter(f => !fs.existsSync(path.join(ROOT, f)));
ok(missingOnDisk.length === 0, '② 载荷表每条在磁盘存在' + (missingOnDisk.length ? '(缺: ' + missingOnDisk.join(', ') + ')' : ''));

// ① index.html / app.js 显式引用 ∈ 载荷表。
const html = fs.readFileSync(path.join(ROOT, 'app', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
const refs = new Set();
for (const m of html.matchAll(/<script[^>]+src="\/([^"]+)"|<link[^>]+href="\/([^"]+)"/g)) refs.add('app/public/' + (m[1] || m[2]));
for (const m of appJs.matchAll(/from '\.\/((?:js|locales)\/[^']+)'/g)) refs.add('app/public/' + m[1]);
for (const m of appJs.matchAll(/fetch\('\/(locales\/[^']+)'/g)) refs.add('app/public/' + m[1]);
const refsMissing = [...refs].filter(f => !payload.has(f));
ok(refs.size >= 8, `① 引用面可枚举(${refs.size} 项)`);
ok(refsMissing.length === 0, '① index.html/app.js 引用全在载荷表' + (refsMissing.length ? '(漏: ' + refsMissing.join(', ') + ')' : ''));

// ③ 敏感目录磁盘文件 ⊆ 载荷表(新文件忘登记 = 红)。
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const sensitiveDirs = ['app/public/js', 'app/public/locales', 'app/public/vendor', 'app/src'];
const unregistered = [];
for (const d of sensitiveDirs) {
  for (const abs of walk(path.join(ROOT, d))) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (!payload.has(rel)) unregistered.push(rel);
  }
}
ok(unregistered.length === 0, '③ 敏感目录(js/locales/vendor/src)无未登记文件' + (unregistered.length ? '(漏登记: ' + unregistered.join(', ') + ')' : ''));

console.log('\nOVERLAY PAYLOAD LOCK STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
