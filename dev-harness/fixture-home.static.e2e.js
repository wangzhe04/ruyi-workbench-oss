#!/usr/bin/env node
// ── 夹具 HOME 守卫的锁(27 号文 §11.21.7 债④) ────────────────────────────────────────
//
// ① 静态扫:dev-harness 下每一处 spawn-family 调用,凡 options.env 带 RUYI_HOME,就必须
//    spread process.env —— 那是 run-all 注入的【临时 USERPROFILE/HOME】唯一的来路;不 spread
//    就只剩「没设家目录」或「显式写死真机家」两种形状,前者子进程的 os.homedir() 落回真机家。
//    同时钉住处数,防「扫描器匹配到 0 处」式假绿(件数变了就把常量跟着改,并在注释里写来路)。
// ② 接线锁:守卫文件、run-all 的注入与 --require 装法都不许被悄悄摘掉。
// ③ 行为探针:真起 4 个 node 子进程(装法照抄 run-all),验证守卫红/绿分明。
//
// 扫描面 = dev-harness/*.js(不含子目录)。子目录 lib/ 里只放 runner 自己的基础设施,
// 且守卫文件本身"只读 env 不设 RUYI_HOME",纳入扫描没有判据意义。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HARNESS = __dirname;
const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ── ① 静态扫 ──────────────────────────────────────────────────────────────────────────
// 实测(2026-09-11):117 处 / 99 个文件,其中 *.e2e.js 内 113 处 / 97 个文件。
// 交接稿写的 119 处我没能复现(同一扫描器下 all-.js=120、only-e2e=116,都不是 119)。
// 121-K0b 新增 dev-harness/mission-index-late-materialize.e2e.js(一处带 RUYI_HOME 的 spawn),
// 120 -> 121 / 116 -> 117 的来路就是它。
// 121-K1(34 号文 §8.1):交办台退役删掉 16 件 pretender-*.e2e.js(另两件改名保留,spawn 点跟着走),
// 121 -> 113 / 117 -> 109 的来路就是它 —— 删的全是 *.e2e.js,所以两个数各降 8。
// 121-K2a(34 号文 §6.1):新增 dev-harness/event-stream.e2e.js(一处带 RUYI_HOME 的 spawn),
// 113 -> 114 / 109 -> 110 的来路就是它。
// 121-K3(34 号文 §4.1–§4.5):新增 dev-harness/thread-index-visibility.e2e.js 与
// dev-harness/steward-presence-gate.e2e.js(各一处带 RUYI_HOME 的 spawn),
// 114 -> 116 / 110 -> 112 的来路就是它们。
// 121-K3-2(34 号文 §13.3):新增 dev-harness/mission-index-boot-race.e2e.js —— 它只有【一处】
// spawn 调用(spawnServer 这个小工厂),两支各调它一次,所以 116 -> 117 / 112 -> 113 只加 1。
// 121-K2b(34 号文 §6.2/§6.3):新增 dev-harness/event-stream-client.browser.e2e.js(一处带 RUYI_HOME
// 的 spawn —— 那一发起服务;浏览器那一发 spawn 不带 RUYI_HOME,不计入),
// 117 -> 118 / 113 -> 114 的来路就是它。
// 121-K4-4(34 号文 §2.2/§2.3/§2.9):新增 dev-harness/one-workbench-frame.browser.e2e.js
// (一处带 RUYI_HOME 的 spawn —— 那一发起服务;浏览器那一发 spawn 不带 RUYI_HOME,不计入),
// 118 -> 119 / 114 -> 115 的来路就是它。
// 121-治抖动那批(34 号文 §13.6 登记④):新增 dev-harness/event-stream-pageshow.browser.e2e.js
// (一处带 RUYI_HOME 的 spawn —— 那一发起服务;浏览器那一发 spawn 不带 RUYI_HOME,不计入),
// 119 -> 120 / 115 -> 116 的来路就是它。
// 121-K6a(34 号文 §4.3):新增 dev-harness/quiet-card.browser.e2e.js(一处带 RUYI_HOME 的 spawn ——
// 那一发起服务;浏览器那一发 spawn 不带 RUYI_HOME,不计入),120 -> 121 / 116 -> 117 的来路就是它。
// 121-K6b(34 号文 §2.6):新增 dev-harness/focus-rail.browser.e2e.js(一处带 RUYI_HOME 的 spawn ——
// 那一发起服务;浏览器那一发 spawn 不带 RUYI_HOME,不计入),121 -> 122 / 117 -> 118 的来路就是它。
// 121-K7(34 号文 §2.3 末段/§8.4):新增 dev-harness/rail-pocket.browser.e2e.js。它有【两处】
// 带 RUYI_HOME 的 spawn —— 一台跑口袋与「接下来」，另一台用【全新 HOME】走向导（§8.4 拍板③）；
// 两个无头 Edge 那两发 spawn 不带 RUYI_HOME，不计入。122 -> 124 / 118 -> 120 的来路就是它。
// 121 走查修复第一轮：新增 dev-harness/walkthrough-round1.browser.e2e.js（一处带 RUYI_HOME 的
// spawn —— 那一发起服务；浏览器那一发 spawn 不带 RUYI_HOME，不计入），124 -> 125 / 120 -> 121
// 的来路就是它。
// 122-§2.4（L2 刀）：新增 dev-harness/mission-start-race.e2e.js（一处带 RUYI_HOME 的 spawn ——
// 那一发起服务；fake provider 是本进程内的 http.createServer，不 spawn），125 -> 126 的来路就是它。
// 122-§2.5（L2 刀）：新增 dev-harness/boot-listen-budget.e2e.js（一处带 RUYI_HOME 的 spawn ——
// 那一发起服务），126 -> 127 的来路就是它。
// 122-§2.6（L2 刀）：新增 dev-harness/mcp-import-origin.e2e.js（一处带 RUYI_HOME 的 spawn ——
// spawnWb() 这个小工厂，四次启动都调它），127 -> 128 的来路就是它。
// 122-L1a（36 号文 §2.1–2.3，主会话合并时合数）：新增 shell-mode-late-config.browser／quiet-card-typing.browser／
// event-stream-replay.browser 三件，各一处带 RUYI_HOME 的 spawn（无头 Edge 那发不带，不计入），128 -> 131。
// 122-L1b（36 号文 §2.11–§2.14）：新增 walkthrough-round2.browser 与 a11y-walkthrough.browser 两件，
// 各一处带 RUYI_HOME 的 spawn（那一发起服务；无头 Edge 那发不带，不计入），131 -> 133。
// 123-M1（37 号文 §3.2–§3.4）：新增 scheduler.e2e.js／scheduler-crash.e2e.js／scheduler-api.e2e.js
// 三件，各一处带 RUYI_HOME 的 spawn（三件都用一个 spawnWb/内联 spawn 工厂，崩溃件的四次重启与
// API 件的两份数据根都走同一处），133 -> 136。
// 123-N2：新增 new-thread-engine-default.e2e.js（一处带 RUYI_HOME 的 spawn —— 那一发起服务；
// fake provider 是本进程内的 http.createServer，不 spawn），136 -> 137（合并时合数） 的来路就是它。
// 同刀的 new-thread-engine-default.static.e2e.js 是纯读文件的静态件，零 spawn，不计入。
// 123-M2（37 号文 §3.5–§3.6）：新增 quiet-card-snooze.browser.e2e.js 与 scheduler-ui.browser.e2e.js
// 两件，各一处带 RUYI_HOME 的 spawn（那一发起服务 —— 后者一趟里起三次，但走的是同一个 spawnWb
// 工厂那一处；无头 Edge 那发不带 RUYI_HOME，不计入），137 -> 139。同刀的
// scheduler-steward.e2e.js 与 scheduler-ui.static.e2e.js 都是进程内 require(server.js) 的直测件，
// 零 spawn，不计入。
// 123-P1 ①（38 号文）：新增 dev-harness/steward-contract-guard.e2e.js（一处带 RUYI_HOME 的 spawn ——
// 那一发起服务；fake-openai 那一发不带 RUYI_HOME，不计入），139 -> 140 的来路就是它。
// 124-P2（40 号文 §2 ②）：新增 dev-harness/thread-commission.browser.e2e.js（一处带 RUYI_HOME 的
// spawn —— 那一发起服务；无头 Edge 与进程内的 fake provider 都不带 RUYI_HOME，不计入），
// 140 -> 141 的来路就是它。同刀的 thread-commission.static.e2e.js 是纯读文件的静态件，零 spawn。
// 125-P2(42 号文 §1 ③):新增 dev-harness/stale-source-badge.browser.e2e.js(一处带 RUYI_HOME 的
// spawn —— 那一发起服务;无头 Edge 与 fake-openai 那两发都不带 RUYI_HOME,不计入),
// 141 -> 142 的来路就是它。
// 127-114b(45 号文 §2 ②):新增 dev-harness/asr-transcribe.e2e.js(一处带 RUYI_HOME 的 spawn ——
// spawnWB 那一发起服务;fake-openai 那一发不带 RUYI_HOME,不计入),142 -> 143 的来路就是它。
// 127-A-S02(45 号文 §2 ⑥):新增 dev-harness/service-match.browser.e2e.js(一处带 RUYI_HOME 的
// spawn —— spawnWb 那一发起服务;headless Edge 那一发不带 RUYI_HOME,不计入),143 -> 144 的来路就是它。
const RUYI_HOME_SPAWN_SITES = 144;
const RUYI_HOME_SPAWN_FLOOR = 100;   // 扫描器还能"看见东西"的下限,防正则失效后静默全绿

const SPAWN_CALL = /\.(spawn|spawnSync|execFile|execFileSync|exec|fork)\s*\(/g;

// 取一个调用点从 '(' 到配对 ')' 的整段实参文本(带字符串态,防括号出现在字面量里)。
function argsTextAt(src, callIndex, openParen) {
  let i = openParen + 1;
  let depth = 1;
  let inStr = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return src.slice(openParen + 1, i - 1);
}

function scanRuyiHomeSpawnSites() {
  const sites = [];
  // 本件自己不进判据:探针必须【故意】构造"数据家设了、家目录没隔离"的 env 去打守卫
  // (经 PROBE_SPEC 字符串传下去),它是判据的测试者,不是判据的对象。
  const SELF = path.basename(__filename);
  for (const file of fs.readdirSync(HARNESS).filter(f => f.endsWith('.js') && f !== SELF).sort()) {
    const src = fs.readFileSync(path.join(HARNESS, file), 'utf8');
    let m;
    SPAWN_CALL.lastIndex = 0;
    while ((m = SPAWN_CALL.exec(src))) {
      const openParen = src.indexOf('(', m.index + m[0].length - 1);
      const args = argsTextAt(src, m.index, openParen);
      if (!/RUYI_HOME/.test(args)) continue;
      sites.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        method: m[1],
        spread: /\.\.\.process\.env/.test(args),
      });
    }
  }
  return sites;
}

const sites = scanRuyiHomeSpawnSites();
const offenders = sites.filter(s => !s.spread);
const e2eOnly = sites.filter(s => s.file.endsWith('.e2e.js'));

ok(sites.length >= RUYI_HOME_SPAWN_FLOOR,
  `静态扫〔带 RUYI_HOME 的 spawn-family 调用〕扫到了东西(${sites.length} 处 >= 下限 ${RUYI_HOME_SPAWN_FLOOR})`);
ok(sites.length === RUYI_HOME_SPAWN_SITES,
  `件数锁定:${sites.length} 处 == 常量 ${RUYI_HOME_SPAWN_SITES}(新增/删除夹具后请同步常量并注明来路;` +
  `其中 *.e2e.js 内 ${e2eOnly.length} 处)`);
ok(offenders.length === 0,
  '每一处都 spread process.env —— 隔离子进程的家目录只有这一条来路' +
  (offenders.length ? ' → 违规:' + JSON.stringify(offenders.map(o => o.file + ':' + o.line + '(' + o.method + ')')) : ''));

// ── ② 接线锁 ──────────────────────────────────────────────────────────────────────────
const guardSrc = fs.readFileSync(path.join(HARNESS, 'lib', 'fixture-home-guard.js'), 'utf8');
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  ok(new RegExp(`'${method}'`).test(guardSrc), `守卫覆盖 child_process.${method}`);
}
const homeSrc = fs.readFileSync(path.join(HARNESS, 'lib', 'fixture-home.js'), 'utf8');
ok(/RUYI_REAL_HOME/.test(homeSrc), '判据源从 RUYI_REAL_HOME 取真机家(run-all 注入后夹具看不见真机家)');
const runAllSrc = fs.readFileSync(path.join(HARNESS, 'run-all.js'), 'utf8');
ok(/require\('\.\/lib\/fixture-home'\)/.test(runAllSrc), 'run-all 引入了判据源 lib/fixture-home');
// 122 波 §2.7:run-all 的 spawn 处改用 fixtureChildEnv({ perTest: true })(每件独立临时家,
// 不再整轮共用),字面调用形态从 `env: fixtureChildEnv()` 变成解构 `fixtureChildEnv({ perTest: true })`
// —— 锁改成钉"确实用了 perTest 形态"这件事本身,而不是钉旧写法的字面文本(32 号文 §4 纪律5)。
ok(/fixtureChildEnv\(\{\s*perTest:\s*true\s*\}\)/.test(runAllSrc), 'run-all 给夹具子进程按【每件独立】注入临时家(fixtureChildEnv({ perTest: true }))');
ok(/'--require', FIXTURE_GUARD/.test(runAllSrc), 'run-all 以 --require 把守卫装进每件夹具');
ok(!/NODE_OPTIONS[\s\S]{0,80}fixture-home-guard/.test(runAllSrc),
  '反向:NODE_OPTIONS 那套没被误用(它吃引号/反斜杠,本仓路径含空格必挂)');

// ── ③ 行为探针:4 个真子进程 ───────────────────────────────────────────────────────────
// 探针本体写进临时目录(不落进 dev-harness,免得污染检出):它按 PROBE_SPEC 组装 env,
// 再 spawn 一个真孙进程 —— 守卫要么放过,要么在【探针进程里】当场红退出。
const PROBE_SPAWNER = [
  "'use strict';",
  "const cp = require('child_process');",
  'const spec = JSON.parse(process.env.PROBE_SPEC);',
  'const env = spec.spread ? { ...process.env, ...spec.overrides } : { ...spec.overrides };',
  "const r = cp.spawnSync(process.execPath, ['-e', '0'], { env, windowsHide: true });",
  "if (r.status !== 0) { process.stderr.write('probe 内部 spawn 失败 status=' + r.status + '\\n'); process.exit(9); }",
  "process.stdout.write('PROBE_ALLOWED\\n');",
  'process.exit(0);',
].join('\n');

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-fixture-home-probe-'));
const spawnerPath = path.join(probeRoot, 'probe-spawner.js');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-fixture-home-fake-'));
const { GUARD_FILE, REAL_HOME, isRealHome } = require('./lib/fixture-home');

function runProbe(spec) {
  const r = cp.spawnSync(process.execPath, ['--require', GUARD_FILE, spawnerPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    // 探针自己的 env 绝不许带「数据家」变量:否则守卫会在【本件进程】里先红掉(本件也由 run-all 装守卫)。
    env: { ...process.env, PROBE_SPEC: JSON.stringify(spec) },
  });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

try {
  fs.writeFileSync(spawnerPath, PROBE_SPAWNER + '\n');

  // 探针 1(绿):数据家与家目录一起隔离 —— spawn-family 的标准形状,必须放行。
  const p1 = runProbe({ spread: true, overrides: { RUYI_HOME: fakeHome, USERPROFILE: fakeHome, HOME: fakeHome } });
  ok(p1.status === 0 && /PROBE_ALLOWED/.test(p1.out),
    `探针①(绿)带 RUYI_HOME 且家目录同指临时家 -> 放行(status=${p1.status})` +
    (p1.status === 0 ? '' : ' err=' + p1.err.split('\n').filter(Boolean).slice(0, 3).join(' | ')));

  // 探针 2(红):守的正是本债的形状 —— 只设数据家、家目录没隔离(env 没 spread process.env)。
  const p2 = runProbe({ spread: false, overrides: { RUYI_HOME: fakeHome } });
  ok(p2.status === 1 && /夹具 HOME 守卫红/.test(p2.err) && /USERPROFILE 没设/.test(p2.err),
    `探针②(红)不 spread process.env -> 守卫当场红退出(status=${p2.status})`);

  // 探针 3(红):家目录被显式写死成真机家 —— 隔离了又自己指回去,同样是真读真写。
  const p3 = runProbe({ spread: true, overrides: { RUYI_HOME: fakeHome, USERPROFILE: REAL_HOME, HOME: fakeHome } });
  ok(p3.status === 1 && /夹具 HOME 守卫红/.test(p3.err) && /USERPROFILE 就是真机家/.test(p3.err),
    `探针③(红)USERPROFILE 指向真机家 ${REAL_HOME} -> 守卫当场红退出(status=${p3.status})`);

  // 探针 4(绿):不带 RUYI_HOME 的子进程根本不进判据 —— 守卫不许把无关调用也拦下来。
  const p4 = runProbe({ spread: false, overrides: { PATH: process.env.PATH || '' } });
  ok(p4.status === 0 && /PROBE_ALLOWED/.test(p4.out),
    `探针④(绿)不带 RUYI_HOME 的子进程照常放行(status=${p4.status})`);

  // 自我一致性:本件自己算出来的"真机家"必须不是临时家(否则说明本件也被注入了假家,判据失效)。
  ok(!!REAL_HOME && !REAL_HOME.startsWith(probeRoot.toLowerCase()) && !isRealHome(fakeHome),
    `本件语境自洽:真机家 ${REAL_HOME} 与探针临时家不同`);
} finally {
  try { fs.rmSync(probeRoot, { recursive: true, force: true }); } catch { /* 回收不了就算了 */ }
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* 同上 */ }
}

// ── 125 治抖（40 号文 §8.4 ⓪）：开浏览器的夹具必须收尸 ──────────────────────────────────
// 117q 那次普查逮到 10 件漏调 stopRuyiTestBrowsers,补完就散了 —— 没留锁。于是 dom-screenshot
// 一直漏着（它走 spawnSync,「回来了就没了」的直觉是错的:Chromium 的 renderer/GPU/crashpad 活过
// 父进程），而它恰恰就是那件老抖的、症状是「截图这一步没成」的件。断头 Edge 攒起来把冷启动从 4 s
// 拖到 86 s 是有记录的老账。本锁按机械判据钉住:凡是自己开浏览器的夹具(命令行里有
// --user-data-dir),就必须调 stopRuyiTestBrowsers。
{
  const harnessDir = __dirname;
  // 静态件按定义不开进程（它们只读文件），本件自己就是其中之一 —— 不剔掉的话，它因为注释里写着
  // `--user-data-dir` 而把自己算成「开了浏览器却没收尸」（第一版实测就是这么自己红的）。
  const files = fs.readdirSync(harnessDir).filter(name => name.endsWith('.e2e.js') && !name.includes('.static.'));
  const owners = [];
  const missing = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(harnessDir, name), 'utf8');
    if (!text.includes('--user-data-dir')) continue;
    owners.push(name);
    // 判【调用】而不是「这几个字出现过」:第一版写成 includes(名字),把它改名成 XXX 之后锁照样绿
    // —— 反向当场逮到这把松锁(本会话第三次同一族:锁要钉行为,不钉字符串出现过)。
    if (!/\bstopRuyiTestBrowsers\s*\(/.test(text)) missing.push(name);
  }
  ok(owners.length >= 15, `开浏览器的夹具扫得到（实得 ${owners.length} 件；扫不到 = 本条静默失效）`);
  ok(missing.length === 0, `每一件都收尸（stopRuyiTestBrowsers）—— 漏的会攒断头 Edge，把后面所有件的冷启动拖慢${missing.length ? '；实得漏了：' + missing.join('、') : ''}`);
}

// ── 125 治抖（43 号文 §3）：自己算 P95 的夹具必须排进独占桶 ────────────────────────────
// run-all 的 PARALLEL_EXCLUSIVE 是逐件按事故补起来的，16 个成员全是真浏览器件 —— 于是两件
// 【自己算百分位】的墙钟性能门一直漏在并行桶里，而 2026-09-15 那轮全量唯二上榜的就是它们：
// mission-index-scale 的「(e) 详情冷P95≤800ms」红在 1101 ms（空闲单跑 617／535／538，同件的
// 低配×2 判据在那一跑里是绿的 —— 产品没退化，是闸在负载下量不准）；ec-d-performance 首跑
// 连 CDP 都没挂上。判据取机械形状：**文件里出现 percentile 调用**（实得 2 件，零误报）。
// 宁可宽一点：万一某件只是提了一嘴，代价也只是多排进独占桶（墙钟），不会误判对错。
// 与上一条同一个教训 —— 补完要留锁，不然下一个漏网的还是这么漏。
{
  const runAll = fs.readFileSync(path.join(HARNESS, 'run-all.js'), 'utf8');
  const block = /const PARALLEL_EXCLUSIVE = new Set\(\[([\s\S]*?)\]\);/.exec(runAll);
  ok(Boolean(block), 'run-all 的 PARALLEL_EXCLUSIVE 名单扫得到（扫不到 = 本条静默失效）');
  const listed = new Set(block ? [...block[1].matchAll(/'([^']+\.e2e\.js)'/g)].map(m => m[1]) : []);
  const timed = [];
  const notExclusive = [];
  for (const name of fs.readdirSync(HARNESS).filter(n => n.endsWith('.e2e.js') && !n.includes('.static.'))) {
    if (!/percentile\w*\s*\(/.test(fs.readFileSync(path.join(HARNESS, name), 'utf8'))) continue;
    timed.push(name);
    if (!listed.has(name)) notExclusive.push(name);
  }
  ok(timed.length >= 2, `自己算 P95 的夹具扫得到（实得 ${timed.length} 件；扫不到 = 本条静默失效）`);
  ok(notExclusive.length === 0, `每一件都排进独占桶 —— 墙钟判据在并行桶里量的是调度噪声，不是产品${notExclusive.length ? '；实得漏了：' + notExclusive.join('、') : ''}`);

  // 同一把锁的第二条判据（第三批）：**一次性启动浏览器**的夹具也必须进独占桶。
  // 判据形状：spawnSync ＋（`--dump-dom` 或 `--screenshot=`）—— 这类件把【启动结果本身】当断言，
  // 没有 CDP 那条「连不上就重连」的重试面。连着两轮全量里唯一的红/flaky 都出自这 2 件，退出码
  // 一模一样(-1)，分别单跑全绿。实得 2 件、零误报。
  const oneShot = [];
  const oneShotMissing = [];
  for (const name of fs.readdirSync(HARNESS).filter(n => n.endsWith('.e2e.js') && !n.includes('.static.'))) {
    const text = fs.readFileSync(path.join(HARNESS, name), 'utf8');
    if (!/\bspawnSync\s*\(/.test(text)) continue;
    if (!/'--dump-dom'|--screenshot=/.test(text)) continue;
    oneShot.push(name);
    if (!listed.has(name)) oneShotMissing.push(name);
  }
  ok(oneShot.length >= 2, `一次性启动浏览器的夹具扫得到（实得 ${oneShot.length} 件；扫不到 = 本条静默失效）`);
  ok(oneShotMissing.length === 0, `每一件都排进独占桶 —— 把启动结果当断言的件对启动期抢占最敏感${oneShotMissing.length ? '；实得漏了：' + oneShotMissing.join('、') : ''}`);
}

console.log('\nFIXTURE HOME STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
