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

// 109a: 可选载荷(OPTIONAL_PAYLOAD_FILES)。上游 MIT 发布物由维护者手工放入 vendor/,
// 前端懒加载且缺失时降级,所以它「已登记」但「可以不在磁盘上」:参与 ③ 的登记判定,不进 ② 的存在判定。
const optionalBlock = (boSrc.match(/const OPTIONAL_PAYLOAD_FILES = \[([\s\S]*?)\];/) || [])[1] || '';
const optional = new Set([...optionalBlock.matchAll(/'(app\/[^']+)'/g)].map(m => m[1]));
ok(optional.has('app/public/vendor/mermaid.min.js'), '109a 可选 vendor mermaid 已登记(文件缺失不阻塞打包)');
ok([...optional].every(f => !payload.has(f)), '109a 可选载荷不与必需载荷重复');
ok(/OPTIONAL_PAYLOAD_FILES[\s\S]{0,600}fs\.existsSync\(src\)/.test(boSrc), '109a 打包器对可选载荷做存在性跳过而非报错');

// ② 每条载荷在磁盘存在。
const missingOnDisk = [...payload].filter(f => !fs.existsSync(path.join(ROOT, f)));
ok(missingOnDisk.length === 0, '② 载荷表每条在磁盘存在' + (missingOnDisk.length ? '(缺: ' + missingOnDisk.join(', ') + ')' : ''));

// ACP 的 loader/register 是标准 npm 直连启动的运行时依赖；只要漏出 overlay，离线包就会静默退回
// 未打补丁的 Kimi CLI。把这两个跨目录依赖单独锁住，避免只靠 PAYLOAD_FILES 正则重建时漏审。
const kimiCompatResources = ['resources/kimi-acp-compat-register.mjs', 'resources/kimi-acp-compat-loader.mjs'];
ok(kimiCompatResources.every(file => payload.has(file)), '② Kimi ACP loader/register 均登记进 overlay 载荷');
const registerSource = fs.readFileSync(path.join(ROOT, 'resources', 'kimi-acp-compat-register.mjs'), 'utf8');
ok(registerSource.includes("./kimi-acp-compat-loader.mjs"), '② Kimi ACP register 的 loader 依赖仍在资源包内');

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
// 107-P0(46 号文 §1.1 ③):修前只扫 app/public/js|locales|vendor 与 app/src —— 于是 resources/playbooks 整目录
// 漏发(127-S01 改的 13 个模板与新增的 scheduled-digest.json 覆盖升级拿不到),app/public/css 也在盲区里。
// 现在:app/public 整棵扫(静态服务器把这棵树整个对外,css 与将来新增的子目录一并进判据),外加服务端运行时
// 从 resources/ 读的三个目录。
const RESOURCE_DIRS = [
  'resources/playbooks',                                              // 06 builtinPlaybooksDir:整目录 *.json
  'resources/plugins/win-workbench-offline/offline-toolkit/skills',   // 12 loadSkillRegistry:<id>/SKILL.md
  'resources/plugins/win-workbench-offline/offline-toolkit/commands', // 12 loadSkillRegistry:*.md
];
const sensitiveDirs = ['app/public', 'app/src', ...RESOURCE_DIRS];
const unregistered = [];
const scannedCount = {};
for (const d of sensitiveDirs) {
  const files = walk(path.join(ROOT, d));
  scannedCount[d] = files.length;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (!payload.has(rel) && !optional.has(rel)) unregistered.push(rel);
  }
}
// 先钉住「扫得到东西」,免得目录改名后这条对一个空目录恒绿。
ok(sensitiveDirs.every(d => scannedCount[d] > 0), '③ 每个敏感目录都扫到了文件(实得 ' + sensitiveDirs.map(d => d + '=' + scannedCount[d]).join('、') + ')');
ok(unregistered.length === 0, '③ 敏感目录(app/public 整棵、app/src、resources 下运行时读的三个目录)无未登记文件' + (unregistered.length ? '(漏登记: ' + unregistered.join(', ') + ')' : ''));

// ③b 107-P0:上面那张目录表本身也是手攒的,所以再对一次账 —— 服务端源码里每一处
// `path.join(externalRoot(), 'resources', …)` 读口,要么是登记过的单个文件,要么落在 ③ 在扫的目录里
// (或它下面有 ③ 在扫的子目录)。下次服务端新开一个 resources 读口而没人来这里补,本条当场红并点名。
{
  const srcText = srcModules.map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  const readPoints = new Set();
  for (const m of srcText.matchAll(/path\.join\(\s*externalRoot\(\)\s*,\s*'resources'((?:\s*,\s*'[^']+')*)\s*\)/g)) {
    const parts = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    readPoints.add(['resources', ...parts].join('/'));
  }
  // 'resources' 根本身只出现在 doctor 的 resourcesRoot 字段(13-http-router 打印路径,不读内容),不算读口。
  readPoints.delete('resources');
  ok(readPoints.size >= 4, `③b 服务端 resources 读口扫得到(实得 ${readPoints.size} 处:${[...readPoints].join('、')})`);
  const uncovered = [...readPoints].filter(rp => {
    const abs = path.join(ROOT, rp);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return !payload.has(rp);
    return !sensitiveDirs.some(d => d === rp || d.startsWith(rp + '/') || rp.startsWith(d + '/'));
  });
  ok(uncovered.length === 0, '③b 每个服务端 resources 读口都有载荷覆盖(文件已登记／目录在 ③ 扫描里)' + (uncovered.length ? '(没覆盖: ' + uncovered.join(', ') + ')' : ''));
}

console.log('\nOVERLAY PAYLOAD LOCK STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
