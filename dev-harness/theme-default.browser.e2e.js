#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：新装的主题跟随系统（体验走查 #17）。
//
// 走查原话：「主题没有『跟随系统』，默认强制深色（系统偏好浅色时也是深色）；语言有『跟随系统』，主题没有。」
// 三态（dark / light / system）早就有了，缺的是默认：服务端 defaultConfig().theme、index.html 预绘、applyTheme
// 的兜底三处都写死 'dark'。现在三处都是 'system'；存过 dark / light 的老用户不受影响。
//
// 覆盖：
//   T1 没存过主题（config 里没有 theme、本机也没有 wcw.theme）+ 系统浅色 → 页面是浅色；
//   T2 页面开着时系统切到深色 → 跟着变深（matchMedia 监听）；
//   T3 服务端给的 config.theme 就是 'system'；
//   T4 显式存过 'dark' 的人：系统浅色也仍是深色（不改老用户）。
// 判定行：`THEME DEFAULT BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-theme-default-', config: { theme: undefined } });
    const scheme = value => fx.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    await scheme('light');
    await fx.evaluate(`(() => { try { localStorage.removeItem('wcw.theme'); } catch {} return true; })()`);
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await fx.waitForEval(`window.state && window.state.config && window.state.config.theme ? 1 : null`, 300);
    await sleep(300);
    const t1 = await fx.evaluate(`({ theme: document.documentElement.getAttribute('data-theme'), cfg: window.state.config.theme })`);
    ok(t1.theme === 'light', `T1 没存过主题、系统浅色 → 页面浅色（实测 ${JSON.stringify(t1)}）`);
    ok(t1.cfg === 'system', `T3 服务端缺省 config.theme 是 'system'（实测 ${t1.cfg}）`);
    await scheme('dark');
    const t2 = await fx.waitForEval(`document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : null`, 100);
    ok(t2 === 'dark', `T2 页面开着时系统切到深色 → 跟着变深（实测 ${t2}）`);

    const saved = await fx.request('POST', '/api/config', { theme: 'dark' });
    ok(Boolean(saved && saved.status === 200), 'T4a 显式存成 dark');
    await scheme('light');
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await fx.waitForEval(`window.state && window.state.config && window.state.config.theme === 'dark' ? 1 : null`, 300);
    await sleep(300);
    const t4 = await fx.evaluate(`document.documentElement.getAttribute('data-theme')`);
    ok(t4 === 'dark', `T4 存过 dark 的人：系统浅色也仍是深色（实测 ${t4}）`);
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nTHEME DEFAULT BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
