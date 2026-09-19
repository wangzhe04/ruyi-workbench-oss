#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-⑤(Brief §4.2 第 21 条「模型菜单首开会挪位」)。
// 修前:模型菜单第一次打开才去拉用量(GET /api/usage/summary),约 140 ms 后到货,「常用」那一段插进列表顶部、整段下挪约 43 px。
// 124 起只在「指针悬停在菜单里」时不重画 —— 挡得住鼠标,挡不住没有悬停的触屏／笔与键盘用户,他们的手指／光标底下那一行变了。
// 修后:① 用量在【有意图】的那一刻就去拉(指针进来／按下／焦点落上);② 开着的菜单不再因用量晚到而重画(下一次打开再画)。
// 判据(真浏览器,管家视角抽屉里的模型 chip;盘上种了这条线程所用模型的用量;CDP Fetch 扣住用量回包):
//   N1 一下点开(没有悬停/焦点那一步)、用量在菜单开着时才到货 —— 每一行的位置与分段标题【一个都不变】,也不插「常用」;
//   N2 关上再开:「常用」出现了(用量确实到过,这次不是没数据);
//   N3 新页面里指针先进到 chip 上:那一发用量在点开之前就回来了,第一次打开的第一帧就有「常用」。
// 判定行:`MODEL MENU NO SHIFT BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const TITLE = '模型菜单不挪位那一条';

const MENU = `(() => {
  const menu = document.querySelector('#stewardDrawerChips .steward-chip-menu[data-kind="model"]');
  if (!menu || menu.hidden) return null;
  const list = menu.querySelector('.steward-chip-list');
  const kids = [...(list ? list.children : [])];
  return {
    groups: kids.filter(n => String(n.className || '').split(' ').includes('steward-chip-group')).map(n => n.textContent.trim()),
    rows: [...menu.querySelectorAll('.steward-chip-option')].map(n => {
      const b = n.getBoundingClientRect();
      return (n.dataset.modelId != null ? n.dataset.modelId : (n.dataset.modelFollow ? 'follow' : '?')) + '@' + Math.round(b.top);
    }),
  };
})()`;

(async () => {
  let fx = null;
  let sessionId = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-model-menu-', width: 1440, height: 900,
      prepare: async f => {
        // 「常用」读的是 usage/YYYY-MM.jsonl(每一行一个回合)。给这条线程所用的模型种一行「一天前用过」。
        const at = new Date(Date.now() - 25 * 60 * 60 * 1000);
        fs.mkdirSync(path.join(f.home, 'usage'), { recursive: true });
        fs.writeFileSync(path.join(f.home, 'usage', `${at.toISOString().slice(0, 7)}.jsonl`), JSON.stringify({
          ts: at.toISOString(), engine: 'openai', provider: 'fake', model: 'fake-model', sessionId: 'seed-fake', inTok: 100, outTok: 20, cachedInTok: 0, kind: 'turn',
        }) + '\n', 'utf8');
        const created = await f.request('POST', '/api/sessions', { title: TITLE, cwd: f.work });
        sessionId = created && created.json && created.json.session && created.json.session.id;
        ok(Boolean(sessionId), 'N00 线程已建、用量已种');
      },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    const RECENT = zh['stewardShell.chips.groupRecent'];
    const focusThread = async () => {
      await fx.setLens('steward');
      await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(sessionId)} } })), true`);
      return fx.waitForEval(`(() => { const b = document.querySelector('#stewardDrawerChips [data-chip="model"]'); return b && !b.disabled ? 1 : null; })()`);
    };
    ok(Boolean(await focusThread()), 'N0 抽屉里模型 chip 可点');

    // 扣住用量回包:模式 hold 时记下 requestId 不放,pass 时直接放。
    let mode = 'hold';
    const held = [];
    fx.cdp.on('Fetch.requestPaused', async p => {
      try {
        if (mode === 'hold') held.push(p.requestId);
        else await fx.cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch { /* 页面已走 */ }
    });
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/usage/summary*' }] });

    /* ── N1 一下点开、用量晚到 ── */
    await fx.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="model"]').click(), true`);
    const s1 = await fx.waitForEval(MENU);
    for (let i = 0; i < 100 && !held.length; i++) await sleep(50);
    ok(held.length > 0 && Boolean(s1) && !s1.groups.includes(RECENT), `N1a 菜单开着、用量那一发被扣住、此刻没有「常用」(分段 ${JSON.stringify(s1 && s1.groups)})`);
    for (const id of held.splice(0)) { try { await fx.cdp.send('Fetch.continueRequest', { requestId: id }); } catch { /* 页面已走 */ } }
    mode = 'pass';
    await fx.waitForEval(`performance.getEntriesByType('resource').some(e => e.name.includes('/api/usage/summary') && e.responseEnd > 0) ? 1 : null`);
    await sleep(500);
    const s2 = await fx.evaluate(MENU);
    ok(Boolean(s2) && JSON.stringify(s2.rows) === JSON.stringify(s1.rows) && JSON.stringify(s2.groups) === JSON.stringify(s1.groups),
      `N1 用量在菜单开着时到货:每一行位置与分段标题一个都没变(前 ${JSON.stringify(s1 && s1.rows)} / 后 ${JSON.stringify(s2 && s2.rows)})`);

    /* ── N2 关上再开 ── */
    await fx.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="model"]').click(), true`);   // 收起
    await fx.waitForEval(`(() => { const m = document.querySelector('#stewardDrawerChips .steward-chip-menu[data-kind="model"]'); return m && m.hidden ? 1 : null; })()`);
    await fx.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="model"]').click(), true`);   // 再开
    const s3 = await fx.waitForEval(MENU);
    ok(Boolean(s3) && s3.groups.includes(RECENT), `N2 关上再开:「${RECENT}」出现了 —— 用量确实到过(分段 ${JSON.stringify(s3 && s3.groups)})`);

    /* ── N3 新页面、指针先进来 ── */
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await fx.waitForEval(`(() => document.readyState === 'complete' && window.state && window.state.status ? 1 : null)()`);
    ok(Boolean(await focusThread()), 'N3a 新页面里抽屉的模型 chip 可点');
    await fx.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="model"]').dispatchEvent(new PointerEvent('pointerenter')), true`);
    const prefetched = await fx.waitForEval(`performance.getEntriesByType('resource').some(e => e.name.includes('/api/usage/summary') && e.responseEnd > 0) ? 1 : null`);
    await fx.evaluate(`document.querySelector('#stewardDrawerChips [data-chip="model"]').click(), true`);
    const s4 = await fx.waitForEval(MENU);
    ok(Boolean(prefetched) && Boolean(s4) && s4.groups.includes(RECENT),
      `N3 指针先进到 chip 上:用量在点开之前就回来了,第一次打开的第一帧就有「${RECENT}」(分段 ${JSON.stringify(s4 && s4.groups)})`);
    await fx.cdp.send('Fetch.disable');
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'MODEL MENU NO SHIFT BROWSER E2E: ALL PASS' : `MODEL MENU NO SHIFT BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
