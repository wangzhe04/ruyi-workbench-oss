#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 150 号文 U8 / 151 阶段 4「首屏 CLS ≤0.1」(真浏览器,无头 Edge/Chrome)。
// 修前:管家视角开机后 0.3–0.6 s 里,右栏那一列(左栏第一批行到了才知道有没有焦点线程)带着过渡展开、
// 到访那一句问候把头像从头部搬进消息(头部收成紧凑式)—— 头部与对话流整块横移又上移,本机实测首屏 CLS 0.47–0.55。
// 修后:css/views/steward-shell.css 的 [data-boot] 定形闸 + js/steward-shell.js armStewardBoot(两样都到了才摘闸,
// 摘之前在 transition:none 下把栅格算定;1.5 s 延时动画兜底)。
// 判据(CLS 按 Chromium 的会话窗口口径:间隔 <1 s、窗口 ≤5 s 的 layout-shift 之和取最大;排除 hadRecentInput):
//   C1 老用户(12 条线程、默认管家视角)连续三次刷新,每次首屏 CLS ≤ 0.1;
//   C2 全新安装(一条线程都没有、首跑自我介绍)首屏 CLS ≤ 0.1;
//   C3 闸最终摘掉(data-boot 不留在页面上),且输入区在定形期间一直可见(闸不挡打字);
//   C4 摘闸之后右栏与头部都在屏上(闸只藏不拆:定形后内容完整可见)。
//   C6 到访失败(/api/steward/visit 回 500)时闸照样摘掉,之后切走再切回管家视角头部当场可见。
// 判定行:`FIRST SCREEN CLS BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('FIRST SCREEN CLS BROWSER');
const { ok } = t;
const CLS_MAX = 0.1;

// 读整页的 layout-shift(buffered:先前已经记下的也拿得到),按会话窗口求 CLS。
const MEASURE = `new Promise(resolve => {
  const entries = [];
  const po = new PerformanceObserver(list => { for (const e of list.getEntries()) entries.push(e); });
  po.observe({ type: 'layout-shift', buffered: true });
  setTimeout(() => {
    po.disconnect();
    let max = 0, cur = 0, start = -1, prev = -1;
    const worst = [];
    for (const e of entries) {
      if (e.hadRecentInput) continue;
      if (prev >= 0 && e.startTime - prev < 1000 && e.startTime - start < 5000) cur += e.value; else { cur = e.value; start = e.startTime; }
      prev = e.startTime; max = Math.max(max, cur);
      if (e.value > 0.02) worst.push(Math.round(e.startTime) + 'ms:' + e.value.toFixed(3) + ':' + (e.sources || []).map(s => s.node && (s.node.id || s.node.nodeName)).join('/'));
    }
    resolve({ cls: Number(max.toFixed(4)), worst: worst.slice(0, 4) });
  }, 150);
})`;

// 定形期间每一帧记一次:闸还在不在、输入区是否可见。注入在新文档最前面,开机那几百毫秒都看得见。
const BOOT_WATCH = `
  window.__bootFrames = [];
  const tick = () => {
    const shell = document.getElementById('stewardShell');
    const composer = document.getElementById('stewardComposer');
    if (shell && document.documentElement.getAttribute('data-shell-mode') === 'steward') {
      window.__bootFrames.push({ boot: shell.hasAttribute('data-boot'),
        composerVisible: !!composer && getComputedStyle(composer).visibility === 'visible' });
    }
    if (window.__bootFrames.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);`;

async function settledFirstScreen(fx) {
  await fx.waitForEval(`(() => document.readyState === 'complete' ? 1 : null)()`);
  await fx.waitForEval(`(() => document.getElementById('stewardFeed') && document.getElementById('stewardFeed').firstElementChild ? 1 : null)()`);
  await sleep(2500);   // 越过 1.5 s 兜底与右栏抽屉的异步取数,首屏该落的都落了
  return fx.evaluate(MEASURE);
}

(async () => {
  let fx = null;
  try {
    // ── C1 老用户:12 条线程,默认管家视角 ──
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-first-cls-', width: 1280, height: 900,
      prepare: async f => {
        for (let i = 0; i < 12; i++) await f.request('POST', '/api/sessions', { title: '首屏线程 ' + i, cwd: f.work });
      },
    });
    await fx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT_WATCH });
    for (let round = 1; round <= 3; round++) {
      await fx.cdp.send('Page.reload', { ignoreCache: true });
      await sleep(200);
      const m = await settledFirstScreen(fx);
      ok(m && m.cls <= CLS_MAX, `C1.${round} 老用户刷新后首屏 CLS ≤ ${CLS_MAX}(got ${m && m.cls}${m && m.worst.length ? ';' + m.worst.join(' ') : ''})`);
      if (round === 1) {
        const frames = await fx.evaluate('window.__bootFrames || []');
        const gated = frames.filter(f => f.boot);
        ok(frames.length > 0 && frames[frames.length - 1].boot === false,
          `C3a 定形闸最终摘掉(帧 ${frames.length},最后一帧 boot=${frames.length ? frames[frames.length - 1].boot : '?'})`);
        ok(gated.every(f => f.composerVisible), `C3b 定形期间输入区一直可见(闸住的帧 ${gated.length})`);
        const shown = await fx.evaluate(`(() => {
          const v = id => { const n = document.getElementById(id); return !!n && !n.hidden && getComputedStyle(n).visibility === 'visible' && n.getBoundingClientRect().width > 0; };
          return { side: v('stewardSide'), header: v('stewardHeader'), feed: v('stewardFeed'), boot: document.getElementById('stewardShell').hasAttribute('data-boot') };
        })()`);
        ok(shown && shown.side && shown.header && shown.feed && !shown.boot, `C4 定形后右栏、头部、对话流都在屏上(got ${JSON.stringify(shown)})`);
      }
    }
    await fx.close(); fx = null;

    // ── C2 全新安装:一条线程都没有 ──
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-first-cls-fresh-', width: 1280, height: 900 });
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(200);
    const fresh = await settledFirstScreen(fx);
    ok(fresh && fresh.cls <= CLS_MAX, `C2 全新安装首屏 CLS ≤ ${CLS_MAX}(got ${fresh && fresh.cls}${fresh && fresh.worst.length ? ';' + fresh.worst.join(' ') : ''})`);
    ok(fx.exceptions.length === 0, `C5 页面无未捕获异常(got ${JSON.stringify(fx.exceptions.slice(0, 3))})`);

    // ── C6 到访失败(4C 审查建议 4):/api/steward/visit 回 500,对话流一行都没有 —— 闸照样摘掉,且之后切走再切回
    //    管家视角时头部当场可见(修前 data-boot 一直挂着,每次切回都重放 1.5 s 的藏起)。
    let failedVisits = 0;
    fx.cdp.on('Fetch.requestPaused', p => {
      failedVisits += 1;
      void fx.cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from('{"ok":false,"error":{"code":"steward.visit_failed","message":"injected"}}').toString('base64') }).catch(() => {});
    });
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/steward/visit*' }] });
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(200);
    await fx.waitForEval(`(() => document.readyState === 'complete' ? 1 : null)()`);
    for (let i = 0; i < 200 && failedVisits === 0; i++) await sleep(50);
    const released = await fx.waitForEval(`(() => document.getElementById('stewardShell').hasAttribute('data-boot') ? null : 1)()`, 100);
    const feedRows = await fx.evaluate(`document.getElementById('stewardFeed').childElementCount`);
    ok(failedVisits > 0 && Boolean(released), `C6a 到访失败时闸照样摘掉(注入失败 ${failedVisits} 次,对话流 ${feedRows} 行)`);
    await fx.setLens('classic');
    await fx.setLens('steward');
    await sleep(120);
    const headerVis = await fx.evaluate(`getComputedStyle(document.getElementById('stewardHeader')).visibility`);
    ok(headerVis === 'visible', `C6b 切走再切回管家视角,头部当场可见、不重放藏起(got ${headerVis})`);
    await fx.cdp.send('Fetch.disable').catch(() => {});
  } catch (error) {
    t.fail('fatal: ' + ((error && error.stack) || error));
  } finally {
    if (fx) await fx.close();
  }
  t.done({ exit: true });
})();
