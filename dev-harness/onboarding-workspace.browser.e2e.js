#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：向导「选一个工作文件夹」这一步，原生选择器用不了时不许把人卡死（体验走查 #8）。
//
// 走查原话：「向导『选择文件夹』失败时没有任何反馈，也没有输入框可以手填。」非 Windows 下 /api/pick-folder
// 回 { ok:false, error:'原生文件夹选择器仅支持 Windows', hint:'请在文件夹输入框中直接粘贴完整路径' }，可向导
// 既没显示、也没有那个输入框；Windows 上 WinForms 起不来是同一条静默路径。
//
// 覆盖：
//   W1 这一步常驻一个手填框（知道路径的人直接粘贴更快）；
//   W2 点「选择文件夹」→ 选择器打不开 → 向导里就地出现一句 role=alert 的原因（服务端 hint 优先），
//      焦点落到手填框上；（Windows 上选择器是真的，这两条只在非 Windows 跑 —— 那里接口必然回 ok:false）
//   W3 粘贴一个带引号的完整路径、按「用这个文件夹」→ 成为默认工作文件夹（config.defaultWorkspace）、
//      向导里「当前：…」换成它、那句原因消失。
// 判定行：`ONBOARDING WORKSPACE BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-onboard-ws-' });
    const target = path.join(fx.root, 'my-folder');
    fs.mkdirSync(target, { recursive: true });

    await fx.evaluate(`(document.getElementById('reopenOnboardingBtn').click(), true)`);
    ok(Boolean(await fx.waitForEval(`document.querySelector('.onboard-wiz-next') ? 1 : null`, 200)), 'W0 向导打开了');
    for (let i = 0; i < 8; i++) {
      const at = await fx.evaluate(`Boolean(document.querySelector('.onboard-wiz-workspace'))`);
      if (at) break;
      // 服务商那一步没有「下一步」，前进键是「先跳过」。
      await fx.evaluate(`((document.querySelector('.onboard-wiz-next') || document.querySelector('.onboard-wiz-skipstep')).click(), true)`);
      await sleep(250);
    }
    const step = await fx.waitForEval(`(() => {
      const w = document.querySelector('.onboard-wiz-workspace');
      if (!w) return null;
      const input = w.querySelector('.onboard-wiz-path-input');
      return { input: Boolean(input), label: input ? input.getAttribute('aria-label') : '', use: Boolean(w.querySelector('.onboard-wiz-path-use')) };
    })()`, 200);
    ok(Boolean(step) && step.input && step.use && Boolean(step.label), `W1 这一步常驻一个手填框和「用这个文件夹」（实测 ${JSON.stringify(step)}）`);

    if (process.platform !== 'win32') {
      await fx.evaluate(`(document.querySelector('.onboard-wiz-workspace .onboard-wiz-pick').click(), true)`);
      const err = await fx.waitForEval(`(() => {
        const e = document.querySelector('.onboard-wiz-workspace .onboard-wiz-error');
        return e ? { text: e.textContent, role: e.getAttribute('role'), focus: document.activeElement && document.activeElement.classList.contains('onboard-wiz-path-input') } : null;
      })()`, 200);
      ok(Boolean(err) && err.role === 'alert' && /Windows/.test(err.text) && /粘贴/.test(err.text) && !/object Object/.test(err.text),
        `W2 选择器打不开：向导里就地说清原因（role=alert，服务端那句人话、不是「[object Object]」；实测 ${JSON.stringify(err)}）`);
      ok(Boolean(err) && err.focus, 'W2b 焦点落到手填框上');
    }

    await fx.evaluate(`(() => {
      const input = document.querySelector('.onboard-wiz-workspace .onboard-wiz-path-input');
      input.value = ${JSON.stringify('"' + target + '"')};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.onboard-wiz-workspace .onboard-wiz-path-use').click();
      return true;
    })()`);
    // 比「文件夹名」而不是整条路径：Windows 上服务端会把 8.3 短名（RUNNER~1）等归一化，整条逐字比会假红。
    const done = await fx.waitForEval(`(() => {
      const w = document.querySelector('.onboard-wiz-workspace');
      if (!w || !/[\\\\/]my-folder$/.test(String(window.state.config.defaultWorkspace || ''))) return null;
      const r = { current: w.textContent.includes('my-folder'), error: Boolean(w.querySelector('.onboard-wiz-error')) };
      return r.current && !r.error ? r : null;   // state 先变、保存回包后才重画：等屏幕上那一版
    })()`, 300) || await fx.evaluate(`(() => { const w = document.querySelector('.onboard-wiz-workspace'); return w ? { current: w.textContent.includes('my-folder'), error: Boolean(w.querySelector('.onboard-wiz-error')), dw: window.state.config.defaultWorkspace } : null; })()`);
    ok(Boolean(done) && done.current && !done.error, `W3 粘贴带引号的完整路径 → 成为默认工作文件夹、原因那句消失（实测 ${JSON.stringify(done)}）`);
    let saved = '';
    for (let i = 0; i < 50 && saved !== target; i++) {
      try { saved = JSON.parse(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8')).defaultWorkspace || ''; } catch { saved = ''; }
      if (saved !== target) await sleep(100);
    }
    ok(saved === target, `W3b 落盘：config.json 的 defaultWorkspace 就是它（实测 ${saved}）`);
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nONBOARDING WORKSPACE BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
