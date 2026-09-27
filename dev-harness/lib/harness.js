'use strict';
// e2e 的断言计数器与判定行 —— 取代每件各抄一份的 `let fail = 0; const ok = …` 与末行
// `NAME E2E: ALL PASS | FAIL (n)`(2026-09 盘点:416 件里约 310 件各有一份)。零依赖,只用 console/process。
//
// 打印口径与 run-all.js 的解析一一对应,不要改:
//   · 每条断言一行 `PASS <label>` / `FAIL <label>`,行首无缩进 —— run-all 用 /^\s*FAIL\b/ 收「FAIL 行」
//     (失败件的「--- FAIL 行」清单与 flaky 件的「[首跑]」诊断都靠它)。FAIL 一律走 stdout,与 PASS 同序。
//   · 收尾一行 `\n<NAME> E2E: ALL PASS` 或 `\n<NAME> E2E: FAIL (<n>)`(与多数件的末行逐字同形)。
//   · 退出码:有 FAIL → 1,否则 0。run-all 只认退出码判红绿;判定行给人看、给 CONTRIBUTING 的「全绿为过」看。
//
// 用法(新件照这个写):
//   const { createRunner } = require('./lib/harness');
//   const t = createRunner('MY FEATURE');          // 判定行 → `MY FEATURE E2E: ALL PASS`
//   const { ok } = t;                               // 解构出来的 ok 仍叫 ok(…):lib/wallclock-window-scan 只认裸 ok(
//   ok(a === 1, 'A1 某条判据');
//   try { … } catch (e) { t.fail('fatal: ' + (e && e.stack || e)); }   // 打一行 FAIL 并计数
//   t.done();                                       // 打判定行、设 process.exitCode;要硬退就 t.done({ exit: true })
//
// t.fail() 不带参数只计数不打印 —— 给「自己已经打过诊断行(ERROR …)、只差把失败记上」的旧件平移用。
// t.failures 是 getter(别解构它,解构拿到的是那一刻的快照)。

function createRunner(name) {
  if (!name || typeof name !== 'string') throw new TypeError('createRunner(name): name 必须是非空字符串(判定行的前缀)');
  let failures = 0;
  function ok(cond, label) {
    if (cond) { console.log('PASS ' + label); return true; }
    failures += 1;
    console.log('FAIL ' + label);
    return false;
  }
  function fail(label) {
    failures += 1;
    if (label !== undefined) console.log('FAIL ' + label);
  }
  function verdict() {
    return name + ' E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS');
  }
  function done(opts = {}) {
    console.log('\n' + verdict());
    const code = failures ? 1 : 0;
    process.exitCode = code;
    if (opts.exit) process.exit(code);
    return failures;
  }
  return {
    ok, fail, done, verdict,
    get failures() { return failures; },
  };
}

module.exports = { createRunner };
