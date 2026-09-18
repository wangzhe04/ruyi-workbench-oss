// Unit(107-F9b):测试浏览器的 profile 范围 —— run-all 收尸只收【这一件】的浏览器。
//
// 它修的是 F8 取证的测试框架缺陷：run-all.js 每件浏览器测试跑完调 stopRuyiTestBrowsers() 且不传目录，
// 不传目录 = 整台机器上所有 ruyi-/wcw- profile 的测试浏览器。`--parallel 4` 下一条车道收尾就把另外三条
// 车道正在用的浏览器杀掉，那几件的 CDP 调用永远不返回、挂到 120 s 超时。修法在 lib/browser-profile-scope.js
// （头注写全了：为什么改夹具进程的 os.tmpdir() 而不是设 TEMP —— 产品的 python 探针缓存在 TEMP 下）。
//
// 本件不开浏览器、不杀任何进程：夹具侧用真子进程（node --require 那个文件）看它把 os.tmpdir() 指到了哪、
// 拦不拦根外的 profile；run-all 侧用一个假收尸器记下它被怎样调用。
//
// 六条：
//   A 承重：装上范围的夹具里，mkdtemp(os.tmpdir()) 建的 profile 落在本件的根里 —— 收尸的针能扎到它，
//     别的车道的针扎不到它；
//   B 根外的 --user-data-dir 当场拦下（不许放出一个收尸收不到的浏览器），子进程根本没起；
//   C 根内的照常放行；
//   D 直跑（没有 run-all 注入的变量）什么都不做：os.tmpdir() 不动、根外的 profile 也不拦；
//   E reapScope 永远带范围：空范围一次都不调收尸器；有范围只调一次、针是「根＋分隔符」；根空了删、
//     根里有东西（截图、失败现场）一个字节不碰；
//   F run-all 里不带范围的收尸只剩开跑前那一处（那时没有车道在跑），每件收尾走的是 reapBrowserScope。
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const repo = path.resolve(__dirname, '../..');
const scopeLib = require(path.join(repo, 'dev-harness', 'lib', 'browser-profile-scope.js'));
const { SCOPE_ENV, SCOPE_FILE, createScope, reapScope } = scopeLib;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-browser-scope-unit-'));

// 在一个真子进程里跑一段探针：可选装上范围（--require 那个文件 + 注入环境变量），探针把读数打成一行 JSON。
function probe(script, { scope, extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv || {}) };
  delete env[SCOPE_ENV];
  if (scope) env[SCOPE_ENV] = scope;
  const args = scope ? ['--require', SCOPE_FILE, '-e', script] : ['-e', script];
  const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  const line = String(r.stdout || '').split(/\r?\n/).find(l => l.startsWith('PROBE '));
  return { status: r.status, out: line ? JSON.parse(line.slice(6)) : null, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}

// 探针：试着 spawnSync 一个「带 --user-data-dir 的子进程」（它只会写一个标记文件，不是浏览器）。
// 被拦下 → blocked:true 且标记文件不存在；放行 → 标记文件存在。
const SPAWN_WITH_PROFILE = `
  const cp = require('child_process'), fs = require('fs');
  const mark = process.env.PROBE_MARK, dir = process.env.PROBE_PROFILE;
  let blocked = false, message = '';
  try {
    const r = cp.spawnSync(process.execPath, ['-e', "require('fs').writeFileSync(process.env.PROBE_MARK, 'x')", '--', '--user-data-dir=' + dir], { windowsHide: true, timeout: 20000 });
    if (r.error) message = String(r.error);
  } catch (e) { blocked = true; message = e.message; }
  process.stdout.write('PROBE ' + JSON.stringify({ blocked, message, spawned: fs.existsSync(mark) }) + '\\n');
`;

describe('测试浏览器 profile 范围（107-F9b）', () => {
  it('A 承重：夹具里 mkdtemp(os.tmpdir()) 建的 profile 落在本件的根里，收尸的针扎得到、别的车道的针扎不到', () => {
    const scope = createScope(work);
    const otherLane = createScope(work);
    const p = probe(`
      const fs = require('fs'), os = require('os'), path = require('path');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-settings-'));
      const profile = path.join(root, 'profile');
      process.stdout.write('PROBE ' + JSON.stringify({ tmpdir: os.tmpdir(), profile }) + '\\n');
    `, { scope });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.tmpdir, scope,
      `装上范围之后夹具的 os.tmpdir() 必须是本件的根（实得 ${p.out.tmpdir} —— 夹具建的 profile 落在全机共用的临时目录里，按根收尸收不到它）`);
    // 收尸器（lib/browser-cleanup.js）带范围时的判据就是「命令行含这根针」：原样比对子串。
    const commandLineFragment = '--user-data-dir=' + p.out.profile;
    assert.ok(commandLineFragment.includes(scope + path.sep), '本件收尸的针（根＋分隔符）扎得到本件的浏览器');
    assert.ok(!commandLineFragment.includes(otherLane + path.sep), '别的车道收尸的针扎不到本件的浏览器（F8 的原形就是一条车道收尾杀了别的车道）');
  });

  it('B 根外的 --user-data-dir 当场拦下，子进程根本没起', () => {
    const scope = createScope(work);
    const outside = path.join(work, 'ruyi-not-in-scope-' + Date.now(), 'profile');
    const mark = path.join(work, 'mark-B-' + Date.now());
    const p = probe(SPAWN_WITH_PROFILE, { scope, extraEnv: { PROBE_MARK: mark, PROBE_PROFILE: outside } });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.blocked, true, `根外的 profile 必须被拦下（实得放行 —— 这个浏览器按根收尸收不到，漏出来的 Edge 再没人收）`);
    assert.equal(p.out.spawned, false, '被拦下的那一发子进程不许起');
    assert.ok(/FAIL 测试浏览器 profile 越界/.test(p.stderr), 'stderr 打出 FAIL 横幅（run-all 的失败行摘录抓得到它）');
  });

  it('C 根内的照常放行', () => {
    const scope = createScope(work);
    const inside = path.join(scope, 'ruyi-x-abc', 'profile');
    const mark = path.join(work, 'mark-C-' + Date.now());
    const p = probe(SPAWN_WITH_PROFILE, { scope, extraEnv: { PROBE_MARK: mark, PROBE_PROFILE: inside } });
    assert.ok(p.out, `探针要交回读数（status=${p.status} stderr=${p.stderr.slice(-300)}）`);
    assert.equal(p.out.blocked, false, `根内的 profile 不许误拦（${p.out.message}）`);
    assert.equal(p.out.spawned, true, '根内那一发子进程照常起了');
  });

  it('D 直跑（没有 run-all 注入的变量）什么都不做', () => {
    const outside = path.join(work, 'ruyi-direct-run', 'profile');
    const mark = path.join(work, 'mark-D-' + Date.now());
    const t = probe(`process.stdout.write('PROBE ' + JSON.stringify({ tmpdir: require('os').tmpdir() }) + '\\n');`);
    assert.equal(t.out && t.out.tmpdir, os.tmpdir(), '直跑时 os.tmpdir() 原样不动');
    // 直跑时即使 --require 了这个文件（变量没设）也不装：用 --require 但不给变量。
    const env = { ...process.env, PROBE_MARK: mark, PROBE_PROFILE: outside };
    delete env[SCOPE_ENV];
    const r = cp.spawnSync(process.execPath, ['--require', SCOPE_FILE, '-e', SPAWN_WITH_PROFILE], { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
    const line = String(r.stdout || '').split(/\r?\n/).find(l => l.startsWith('PROBE '));
    const out = line ? JSON.parse(line.slice(6)) : null;
    assert.ok(out && out.blocked === false && out.spawned === true, `没有注入变量时不查 profile（实得 ${JSON.stringify(out)}）`);
  });

  it('E reapScope 永远带范围：空范围不收；有范围只收一次、针是根＋分隔符；根空了删、有东西不碰', () => {
    const calls = [];
    const fake = needle => { calls.push(needle); return 3; };
    const r1 = reapScope('', fake);
    // 先断「没调」（理由在这一条），返回值放后面 —— 反向时红在哪一条就是理由。
    assert.deepEqual(calls, [], `空范围一次都不许调收尸器（实得 ${JSON.stringify(calls)} —— 收尸器拿到空针就是整机收尸，F8 的原形）`);
    assert.equal(r1, 0);
    assert.equal(reapScope(undefined, fake), 0);
    assert.deepEqual(calls, [], '没给范围（undefined）同样一次都不调');

    const empty = createScope(work);
    assert.equal(reapScope(empty, fake), 3, '返回收尸器报的个数');
    assert.deepEqual(calls, [empty + path.sep], '只调一次，针是「根＋分隔符」（不会顺带扎到名字以它开头的别的根）');
    assert.ok(!fs.existsSync(empty), '根空了就删');

    const kept = createScope(work);
    const shot = path.join(kept, 'ruyi-shots', 'frame.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, 'png');
    reapScope(kept, fake);
    assert.ok(fs.existsSync(shot), '根里夹具留下的东西（截图、失败现场）一个字节不碰');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(n => n && n.length > path.sep.length), '每一次收尸都带着非空的针');
  });

  it('F run-all 里不带范围的收尸只剩开跑前那一处，每件收尾走 reapBrowserScope', () => {
    const src = fs.readFileSync(path.join(repo, 'dev-harness', 'run-all.js'), 'utf8');
    // 判【调用】的形状，不判「名字出现过」：空括号调用 = 整机收尸。
    const unscoped = [...src.matchAll(/\bstopRuyiTestBrowsers\s*\(\s*\)/g)].map(m => src.slice(0, m.index).split('\n').length);
    const mainAt = src.search(/\nasync function main\(\)\s*\{/);
    assert.ok(mainAt >= 0, 'run-all 的 main() 扫得到（扫不到 = 本条静默失效）');
    const mainLine = src.slice(0, mainAt + 1).split('\n').length;   // 「async function main」所在行
    assert.equal(unscoped.length, 1, `run-all 里不带范围的收尸只许一处（实得 ${unscoped.length} 处，行 ${unscoped.join('、')} —— 多出来的那处在车道跑着的时候会整机收尸）`);
    assert.ok(unscoped[0] > mainLine && unscoped[0] <= mainLine + 4, `那一处必须在 main() 开头（开跑前、还没有车道；实得第 ${unscoped[0]} 行，main 在第 ${mainLine} 行）`);
    const perCase = [...src.matchAll(/\breapBrowserScope\s*\(\s*browserScope\s*,\s*stopRuyiTestBrowsers\s*\)/g)];
    assert.ok(perCase.length >= 1, '每件收尾按本件的根收尸（reapBrowserScope(browserScope, stopRuyiTestBrowsers)）');
    assert.ok(/\['--require', FIXTURE_GUARD, \.\.\.scopeArgs, full\]/.test(src), '开浏览器的件以 --require 装上 browser-profile-scope');
  });
});

process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } });
