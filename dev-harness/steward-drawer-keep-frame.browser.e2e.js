#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-④(Brief §4.2 第 23 条):从工作台切回管家,焦点卡标题每次都闪一下「读取中…」。
// 抽屉离开管家视角即收摊,回来 openThread 把手上的一切清空、落 117k 的「读取中」闸再整份重取。117k 的闸防的是
// 「还没读到就说假话」;而重开【同一条】时手上有它刚刚还是真的那一帧 —— 先画它、后台刷新。
// 判据(真浏览器,管家视角,宽屏常驻右栏):
//   K0 线程 A 在焦点卡里(标题是它的名字);
//   K1 切到工作台、(期间)把 A 改名、切回管家 —— 标题的每一次变化里【没有一次】是「读取中…」,回来第一帧就是 A 的旧名;
//   K2 后台刷新到了:标题最终变成新名字(不是停在上一帧);
//   K3 对照(117k 的闸没被拆掉):焦点换到一条【从没开过】的线程 C,那一次照旧先落「读取中…」。
// 判定行:`STEWARD DRAWER KEEP FRAME BROWSER E2E: ALL PASS`。
const { startBrowserFixture } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const A_OLD = '保留上一帧那一条';
const A_NEW = '改过名字的那一条';
const C_TITLE = '从来没打开过的那一条';

(async () => {
  let fx = null;
  const ids = {};
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-keep-frame-', width: 1440, height: 900,
      prepare: async f => {
        for (const [key, title] of [['a', A_OLD], ['c', C_TITLE]]) {
          const created = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          ids[key] = created && created.json && created.json.session && created.json.session.id;
        }
        ok(Boolean(ids.a && ids.c), 'K00 两条线程已建');
      },
    });
    ok(Boolean(await fx.setLens('steward')), 'K00b 在管家视角');
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    const LOADING = zh['stewardShell.drawer.loading'];
    const titleIs = text => `(() => ((document.getElementById('stewardDrawerTitle') || {}).textContent || '').trim() === ${JSON.stringify(text)} ? 1 : null)()`;
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.a)} } })), true`);
    ok(Boolean(await fx.waitForEval(titleIs(A_OLD))), `K0 线程 A 在焦点卡里(「${A_OLD}」)`);
    // 标题每一次变化都记下来(含 characterData 与子节点替换)。
    await fx.evaluate(`(() => {
      window.__titles = [];
      const node = document.getElementById('stewardDrawerTitle');
      const rec = () => window.__titles.push((node.textContent || '').trim());
      new MutationObserver(rec).observe(node, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    ok(Boolean(await fx.setLens('classic')), 'K1a 切到工作台');
    const renamed = await fx.evaluate(`(async () => {
      const token = sessionStorage.getItem('wcw.token') || '';
      const r = await fetch('/api/sessions/' + encodeURIComponent(${JSON.stringify(ids.a)}), { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-http-method': 'PATCH', 'x-wcw-token': token }, body: JSON.stringify({ title: ${JSON.stringify(A_NEW)} }) });
      return r.status;
    })()`);
    ok(renamed === 200, `K1b 离开期间把 A 改名(HTTP ${renamed})`);
    await fx.evaluate('(window.__titles = [], true)');
    ok(Boolean(await fx.setLens('steward')), 'K1c 切回管家');
    const settled = await fx.waitForEval(titleIs(A_NEW));
    const seen = await fx.evaluate('window.__titles || []');
    const firstReal = seen.find(t => t && t !== LOADING) || '';
    ok(!seen.includes(LOADING) && firstReal === A_OLD,
      `K1 切回来没有闪「${LOADING}」,第一帧就是上一帧的旧名(标题变化序列 ${JSON.stringify(seen.slice(0, 6))})`);
    ok(Boolean(settled), `K2 后台刷新到了:标题最终变成新名字「${A_NEW}」`);
    // 对照:从没开过的 C —— 117k 的「读取中」闸照旧。
    await fx.evaluate('(window.__titles = [], true)');
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.c)} } })), true`);
    ok(Boolean(await fx.waitForEval(titleIs(C_TITLE))), `K3a 焦点换到 C(「${C_TITLE}」)`);
    const seenC = await fx.evaluate('window.__titles || []');
    ok(seenC.includes(LOADING), `K3 对照:头一次打开的 C 照旧先落「${LOADING}」闸(序列 ${JSON.stringify(seenC.slice(0, 6))})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'STEWARD DRAWER KEEP FRAME BROWSER E2E: ALL PASS' : `STEWARD DRAWER KEEP FRAME BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
