#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-③(48 号文 §2-c)的前端那一半:/api/status 在桌面组件探测还在飞时回 desktopMcp.probing,不再让整个界面等 Python。
// 前端要自己把结果补回来 —— 但只能补那两处(桌面组件那一行状态、体检面板),不能整页回填设置(fillSettings 会把用户
// 正在改的输入框冲回服务端的值,「写回没读到的状态」那个模具的镜像)。
// 判据(真浏览器;合成的桌面组件根;测试口让探测确定性地在飞 DELAY 毫秒;服务子进程的 TMP 指到新目录绕开磁盘缓存):
//   D1 页面是在探测在飞时起来的:首个 /api/status 秒回(远小于 DELAY),state.status.desktopMcp.probing;
//   D2 设置里桌面组件那一行写「正在检测…」;
//   D3 (模拟用户)在另一个设置输入框里改了一个值、还没保存;
//   D4 探测完之后那一行自己更新成探测结果(不再是「正在检测…」),state.status.desktopMcp 不再 probing;
//   D5 用户改到一半的那个输入框原封不动(跟进没有整页回填)。
// 判定行:`DESKTOP PROBE FOLLOW BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

const DELAY = 6000;   // D1 门槛取它的一半:并行负载下也远在其内,反向(等探测)至少 DELAY
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {
  let fx = null;
  let extra = '';
  try {
    extra = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ruyi-128f3b-'));
    const tmp = path.join(extra, 'tmp');
    const acc = path.join(extra, 'acc');
    for (const d of [tmp, path.join(acc, 'src', 'ai_computer_control')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(acc, 'src', 'ai_computer_control', 'server.py'), '# synthetic stand-in (128f-3 browser e2e)\n');
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-probe-follow-', width: 1280, height: 860,
      config: { uiMode: 'pro', desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true } },
      serverEnv: { TMP: tmp, TEMP: tmp, AI_COMPUTER_CONTROL_HOME: acc, WCW_TEST_DESKTOP_PROBE_DELAY_MS: String(DELAY) },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    const snap = await fx.evaluate(`(() => {
      const st = performance.getEntriesByType('resource').find(e => /\\/api\\/status$/.test(e.name));
      return { probing: Boolean(window.state && window.state.status && window.state.status.desktopMcp && window.state.status.desktopMcp.probing),
        statusMs: st ? Math.round(st.duration) : -1,
        line: (document.getElementById('cfgDesktopMcpStatus') || {}).textContent || '' };
    })()`);
    ok(snap.probing && snap.statusMs >= 0 && snap.statusMs < DELAY / 2,
      `D1 页面在探测在飞时起来:首个 /api/status ${snap.statusMs} ms(探测至少 ${DELAY} ms),state 里 probing=${snap.probing}`);
    ok(snap.line === zh['mcp.probing'], `D2 桌面组件那一行写「${zh['mcp.probing']}」(实「${snap.line}」)`);
    const TYPED = 'http://typed-by-user-not-saved.invalid';
    await fx.evaluate(`(() => { const box = document.getElementById('cfgSearchBaseUrl'); box.value = ${JSON.stringify(TYPED)};
      box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    ok((await fx.evaluate(`document.getElementById('cfgSearchBaseUrl').value`)) === TYPED, 'D3 (模拟用户)在另一个设置输入框里改了一个值、还没保存');
    const done = await fx.waitForEval(`(() => {
      const s = window.state && window.state.status;
      const line = (document.getElementById('cfgDesktopMcpStatus') || {}).textContent || '';
      return s && s.desktopMcp && !s.desktopMcp.probing && line && line !== ${JSON.stringify(zh['mcp.probing'])} ? { line } : null;
    })()`);   // 默认 800 拍 ≈ 35 s:测试口 5 s ＋ 本机真探 Python 候选约 10 s
    if (!done) console.log('D4-DIAG ' + JSON.stringify(await fx.evaluate('(window.state && window.state.status && window.state.status.desktopMcp) || null')));
    ok(Boolean(done), `D4 探测完之后那一行自己更新(实「${done && done.line}」),state.status.desktopMcp 不再 probing`);
    const kept = await fx.evaluate(`document.getElementById('cfgSearchBaseUrl').value`);
    ok(kept === TYPED, `D5 用户改到一半的输入框原封不动 —— 跟进只补那两处、没有整页回填(实「${kept}」)`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
    if (extra) { try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* 句柄 */ } }
  }
  console.log(fail === 0 ? 'DESKTOP PROBE FOLLOW BROWSER E2E: ALL PASS' : `DESKTOP PROBE FOLLOW BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
