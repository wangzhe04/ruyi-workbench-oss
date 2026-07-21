#!/usr/bin/env node
// 静态锁 (第46波46f): facts.json 单一事实源防漂移。
// facts-generate.js 生成 repo 根 facts.json;本件【独立重算】全部静态可算字段并逐一比对 ——
// 改了工具数/e2e 件数/版本号而没跑生成器,这里即红(D1:门面数字五口径并存的机制性解法第一步)。
// accTools 轴:本机有 ACC venv 时做活注册表对账(与 CI acc-smoke job 同款探针),无 venv 时
// 只校验它是正整数(CI 的 acc-smoke job 负责活对账,两处互补不重叠)。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const facts = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'facts.json'), 'utf8')); } catch { return null; } })();
ok(!!facts && facts.schema === 1, 'facts.json 存在且 schema=1(不存在则跑 node dev-harness/facts-generate.js)');
if (!facts) { console.log('\nFACTS STATIC E2E: FAIL (1)'); process.exit(1); }

// 版本一致三角:package.json == 00-boot.js VERSION == facts.workbenchVersion。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'package.json'), 'utf8'));
const boot = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '00-boot.js'), 'utf8');
const bootV = (boot.match(/const VERSION = '([^']+)'/) || [])[1];
ok(pkg.version === bootV, `版本一致: package.json(${pkg.version}) == 00-boot.js(${bootV})`);
ok(facts.workbenchVersion === pkg.version, `facts.workbenchVersion(${facts.workbenchVersion}) == package.json(${pkg.version})`);

// 产物里的版本(防改了 src 忘 build)。
const built = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'), 'utf8');
ok(built.includes(`const VERSION = '${pkg.version}'`), `产物 server.js 版本与 package.json 一致(${pkg.version})`);

// 原生工具数:require 产物真身重算。
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const native = Object.keys(srv.TOOL_HANDLERS || {}).length;
ok(facts.nativeTools === native, `facts.nativeTools(${facts.nativeTools}) == TOOL_HANDLERS 重算(${native})`);

// e2e 件数与 live 跳过数。
const e2eCount = fs.readdirSync(__dirname).filter(f => f.endsWith('.e2e.js')).length;
ok(facts.e2eCount === e2eCount, `facts.e2eCount(${facts.e2eCount}) == 目录重算(${e2eCount})`);
const runall = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
const skipBlock = (runall.match(/const SKIP = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
const skipped = (skipBlock.match(/'[^']+\.e2e\.js'/g) || []).length;
ok(facts.e2eLiveSkipped === skipped, `facts.e2eLiveSkipped(${facts.e2eLiveSkipped}) == SKIP 表重算(${skipped})`);

// unit / ACC smoke 件数。
const unitSuites = fs.readdirSync(path.join(__dirname, 'unit')).filter(f => f.endsWith('.test.js')).length;
ok(facts.unitSuites === unitSuites, `facts.unitSuites(${facts.unitSuites}) == 目录重算(${unitSuites})`);
const accSmokes = fs.readdirSync(path.join(ROOT, 'mcp', 'ai-computer-control', 'tests')).filter(f => /^smoke_.*\.py$/.test(f)).length;
ok(facts.accSmokes === accSmokes, `facts.accSmokes(${facts.accSmokes}) == 目录重算(${accSmokes})`);

// ACC 版本:pyproject 重算。
const pyproj = fs.readFileSync(path.join(ROOT, 'mcp', 'ai-computer-control', 'pyproject.toml'), 'utf8');
const accV = (pyproj.match(/^version = "([^"]+)"/m) || [])[1] || '';
ok(facts.accVersion === accV, `facts.accVersion(${facts.accVersion}) == pyproject(${accV})`);

// ACC 工具数:venv 在 → 活注册表对账;不在 → 形状校验(CI acc-smoke 补活对账)。
const venvPy = path.join(ROOT, 'mcp', 'ai-computer-control', '.venv', 'Scripts', 'python.exe');
if (fs.existsSync(venvPy)) {
  const r = cp.spawnSync(venvPy, ['-X', 'utf8', '-c',
    "import sys; sys.path.insert(0, r'mcp/ai-computer-control/src'); import ai_computer_control.server as s; print(len(s.mcp._tool_manager.list_tools()))"],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const live = parseInt(String(r.stdout || '').trim().split(/\r?\n/).pop(), 10);
  ok(facts.accTools === live, `facts.accTools(${facts.accTools}) == 活注册表(${live})`);
} else {
  ok(Number.isInteger(facts.accTools) && facts.accTools > 0, `facts.accTools(${facts.accTools}) 是正整数(无 venv,活对账由 CI acc-smoke 承担)`);
}

// README 门面口径软锁:README 提到 ACC 工具数时必须与 facts 一致(防 99/100 双口径复发)。
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const accMentions = [...readme.matchAll(/(\d+)\s*个?(?:桌面| )?工具/g)].map(m => Number(m[1]));
const accClaimsOk = !accMentions.includes(99) && !accMentions.includes(98);
ok(accClaimsOk, `README 无过时 ACC 工具数口径(99/98 绝迹;现行 ${facts.accTools})`);

console.log('\nFACTS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
