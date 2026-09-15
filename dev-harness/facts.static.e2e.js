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

// EC-A 真实基线:默认端口(00-boot.js DEFAULT_PORT 常量重算)。
const bootPort = parseInt((boot.match(/const DEFAULT_PORT = (\d+)/) || [])[1], 10);
ok(facts.defaultPort === bootPort, `facts.defaultPort(${facts.defaultPort}) == 00-boot.js DEFAULT_PORT(${bootPort})`);

// EC-A:token bootstrap 语义锁(47c S1)。锁语义不锁行号(允许重构迁移,只要模式不变):
// ① ROUTE_AUTH 表有 POST /api/bootstrap 标 auth='open'(浏览器拿 token 唯一通道);
// ② serveStatic 浏览器导航分支把 __WCW_TOKEN__ 置空(HTML 不再明文下发 token)。
ok(facts.tokenBootstrap === 'api-bootstrap', `facts.tokenBootstrap(${facts.tokenBootstrap}) == 'api-bootstrap'`);
ok(built.includes("p: '/api/bootstrap', auth: 'open'"), "ROUTE_AUTH 含 POST /api/bootstrap(auth=open,浏览器拿 token 唯一通道)");
ok(built.includes('__WCW_TOKEN__') && built.includes("browserNav ? ''"), "serveStatic 浏览器分支置空 token(HTML 不再明文下发)");

// EC-A:live probe 数 = SKIP 集大小;且每条 SKIP 条目文件名须含 'live' 或在白名单
// (防 SKIP 混入非 live 件如已知 flaky,使 liveProbes 语义失真)。deepseek-tools 文件名不含 live 但属 live probe(真 API 调用)。
ok(facts.liveProbes === skipped, `facts.liveProbes(${facts.liveProbes}) == SKIP 集大小(${skipped})`);
const skipFiles = (skipBlock.match(/'[^']+\.e2e\.js'/g) || []).map(s => s.slice(1, -1));
const LIVE_WHITELIST = new Set(['deepseek-tools.e2e.js']);
const nonLiveInSkip = skipFiles.filter(f => !/live/i.test(f) && !LIVE_WHITELIST.has(f));
ok(nonLiveInSkip.length === 0, `SKIP 集每条都是 live probe(非 live 混入: ${nonLiveInSkip.join(', ') || '无'})`);

// README 门面口径软锁:README 提到 ACC 工具数时必须与 facts 一致(防 99/100 双口径复发)。
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const accMentions = [...readme.matchAll(/(\d+)\s*个?(?:桌面| )?工具/g)].map(m => Number(m[1]));
const accClaimsOk = !accMentions.includes(99) && !accMentions.includes(98);
ok(accClaimsOk, `README 无过时 ACC 工具数口径(99/98 绝迹;现行 ${facts.accTools})`);

// 117m：README 的三个门面数字也跟 facts 对账。上面那条 ACC 软锁只拦住了 99/98 两个具体值，
// 而实测 README 已经漂到「89 个原生工具 / 243 项 e2e / 15 组 unit」，真值是 90 / 318 / 30 ——
// 漂了好几波没人发现，因为没有任何机器在看。这三条只要求「真值在 README 里出现过」，
// 不钉句式（README 改排版不该把门弄红）；数字一变而 README 没跟，这里就红。
// 126-111e 顺手收紧的一把松锁:这三条原本写成 `readmeNums.has(n)` —— 只问「这个数字在 README 里
// 【某处】出现过没有」。README 里到处都是别的数字(版本号、别的计数、表格里的数),于是它几乎永远
// 是绿的:实测 README 写着「48 组 unit suite」而 facts 已经是 49,这三条照样全过。锁写松了比没有锁
// 更糟 —— 它给的是假的把握。收紧成:**数字必须贴着它声称在数的那个词**,而且每一处都要对上。
// (本会话第四次同一族:锁要钉住判据本身,不是「这几个字/这个数出现过」。)
function readmeCounts(label, patterns) {
  const hits = [];
  for (const re of patterns) for (const m of readme.matchAll(re)) hits.push({ text: m[0].trim(), n: Number(m[1]) });
  ok(hits.length > 0, `README 里扫得到「${label}」的说法（实得 ${hits.length} 处；扫不到 = 本条静默失效）`);
  return hits;
}
for (const [label, value, patterns] of [
  ['原生工具数', facts.nativeTools, [/([0-9]+)\s*个原生工具/g, /\*\*([0-9]+) native built-in tools\*\*/g]],
  ['e2e 总数', facts.e2eCount, [/([0-9]+)\s*项\s*e2e/g, /\*\*([0-9]+) e2e cases\*\*/g]],
  ['unit suite 数', facts.unitSuites, [/([0-9]+)\s*组\s*unit suite/g, /plus ([0-9]+) unit suites/g]],
]) {
  const hits = readmeCounts(label, patterns);
  const wrong = hits.filter(h => h.n !== value);
  ok(wrong.length === 0,
    `README 里每一处「${label}」都与 facts 一致(现行 ${value}，实得 ${hits.length} 处)` +
    (wrong.length ? `；对不上的：${wrong.map(h => h.text).join('、')}` : ''));
}


console.log('\nFACTS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
