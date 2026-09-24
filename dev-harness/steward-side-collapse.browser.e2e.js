#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 2026-09-24(用户:「现在的管家界面,右边的线程永远收不起来,那么管家的打开线程点击了会像没有反应一样……
// 或许有按钮的话默认直接打开工作台里的对应线程也行」):管家视角右栏可收起 ＋「打开」去工作台 ＋ 工作台线程头
// 「回到管家」。真浏览器(公共夹具 lib/browser-fixture:假 provider ＋ 隔离家目录 ＋ 无头 Edge),1440×900。
// 判据全读 DOM／localStorage／视角属性,不碰模块私有状态:
//   A 右栏可收起:栏头开关 → data-collapsed="1"、列宽收到 44px、抽屉那一份收摊(hidden、回 overlay 挂法)、
//     偏好 wcw.stewardSideCollapsed=1;
//   B 偏好活过刷新:reload 之后仍是收起的(不闪一下展开再收);
//   C 收起时管家聚焦新线程【不自动展开】:派 steward:focus-thread(B) → 仍收起、抽屉没以覆盖式开出来、
//     窄条亮一颗「有新动静」的点;点窄条 → 展开,抽屉开在 B(钉子照记);
//   D Esc 在常驻栏上 → 收起,且 1.5 s 内没有被 syncNow 顶回;
//   E 对话流里管家那枚「打开「X」」act → 切到工作台并选中那条线程(视角 classic、#sessionTitle 是它);
//   F 工作台线程头有「回到管家」入口:点它 → 回管家视角、右栏展开着焦点就是刚看的这条;
//   G 全程零未捕获异常。
// 判定行:`STEWARD SIDE COLLAPSE BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep, waitForTarget, CdpClient } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const TITLE_A = '整理下载文件夹';
const TITLE_B = '写周报初稿';
const TITLE_C = '核对三月账单';

const SIDE = `(() => {
  const side = document.getElementById('stewardSide');
  const drawer = document.getElementById('stewardDrawer');
  const strip = document.getElementById('stewardSideStrip');
  const toggle = document.getElementById('stewardSideToggleBtn');
  const rect = node => node ? Math.round(node.getBoundingClientRect().width) : -1;
  return {
    mode: document.documentElement.getAttribute('data-shell-mode') || '',
    vt: document.documentElement.dataset.vt || '',
    hidden: side ? side.hidden : null,
    collapsed: side ? (side.dataset.collapsed || '') : '',
    sideWidth: rect(side),
    stripHidden: strip ? strip.hidden : null,
    stripFresh: strip ? (strip.dataset.fresh || '') : '',
    stripBadges: strip ? [...strip.querySelectorAll('.steward-side-strip-badge')].map(node => node.dataset.tone + ':' + node.textContent) : [],
    toggleVisible: Boolean(toggle) && toggle.offsetParent !== null,
    toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') : '',
    drawerHidden: drawer ? drawer.hidden : null,
    drawerMount: drawer ? (drawer.dataset.mount || '') : '',
    drawerParent: drawer && drawer.parentElement ? drawer.parentElement.id : '',
    drawerTitle: ((document.getElementById('stewardDrawerTitle') || {}).textContent || '').trim(),
    pref: (() => { try { return localStorage.getItem('wcw.stewardSideCollapsed') || ''; } catch { return 'ERR'; } })(),
    active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
    sessionTitle: ((document.getElementById('sessionTitle') || {}).textContent || '').trim(),
    backBtn: (() => { const b = document.getElementById('threadBackToStewardBtn'); return b ? { visible: b.offsetParent !== null, text: (b.textContent || '').trim() } : null; })(),
  };
})()`;

(async () => {
  let fx = null;
  const ids = {};
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-side-collapse-', width: 1440, height: 900,
      prepare: async f => {
        for (const [key, title] of [['a', TITLE_A], ['b', TITLE_B], ['c', TITLE_C]]) {
          const created = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          ids[key] = created && created.json && created.json.session && created.json.session.id;
          // 各跑一回合(假 provider 一句就收):行上才有「最后动静」,问候语里才有「打开「X」」那一枚 act。
          if (ids[key]) await f.request('POST', '/api/chat/stream', { sessionId: ids[key], message: '开始吧', cwd: f.work }, 120000);
        }
        ok(Boolean(ids.a && ids.b && ids.c), 'S00 三条线程已建并各跑一回合');
      },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    ok(Boolean(await fx.setLens('steward')), 'S00b 在管家视角');
    const snap = () => fx.evaluate(SIDE);
    const waitSide = (predicate, attempts = 300) => fx.waitForEval(`(() => { const s = ${SIDE}; return (${predicate})(s) ? s : null; })()`, attempts);

    /* ═════════ A 右栏可收起 ═════════ */
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.a)} } })), true`);
    const shown = await waitSide(`s => s.hidden === false && s.collapsed === '' && s.drawerTitle === ${JSON.stringify(TITLE_A)} && s.sideWidth >= 390`);
    ok(Boolean(shown) && shown.toggleVisible && shown.toggleExpanded === 'true' && shown.stripHidden === true,
      `A1 右栏展开着焦点卡(A),栏头有开关钮(aria-expanded=true)、窄条藏着(实测 ${JSON.stringify(shown && { w: shown.sideWidth, toggle: shown.toggleVisible, strip: shown.stripHidden })})`);
    await fx.evaluate(`document.getElementById('stewardSideToggleBtn').click(), true`);
    const collapsed = await waitSide(`s => s.collapsed === '1' && s.sideWidth <= 60`);
    ok(Boolean(collapsed) && collapsed.hidden === false && collapsed.stripHidden === false && collapsed.toggleVisible === false,
      `A2 点开关 → 右栏收成窄条(data-collapsed=1、宽 ${collapsed && collapsed.sideWidth}px、栏本身不 hidden、窄条可见、开关随栏收起)`);
    ok(Boolean(collapsed) && collapsed.drawerHidden === true && collapsed.drawerMount === 'overlay' && collapsed.drawerParent === 'stewardShell',
      `A3 收起时抽屉那一份收摊(hidden、回 overlay 挂法,不在 #stewardFocus 里;实测 ${JSON.stringify(collapsed && { hidden: collapsed.drawerHidden, mount: collapsed.drawerMount, parent: collapsed.drawerParent })})`);
    ok(Boolean(collapsed) && collapsed.pref === '1', `A4 偏好记在本机 wcw.stewardSideCollapsed=1(实测「${collapsed && collapsed.pref}」)`);
    ok(Boolean(collapsed) && collapsed.active === 'stewardSideStrip', `A5 收起后焦点送到窄条上(键盘用户不落到 body;实测 ${collapsed && collapsed.active})`);
    const stripLabel = await fx.evaluate(`(document.getElementById('stewardSideStrip').getAttribute('aria-label') || '')`);
    ok(stripLabel.indexOf(zh['stewardShell.side.expand']) === 0, `A6 窄条的可访问名以「${zh['stewardShell.side.expand']}」开头(实测「${stripLabel}」)`);

    /* ═════════ B 偏好活过刷新 ═════════ */
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(800);
    // 重载偶发换了渲染进程、旧 target 的 socket 随之关掉(首轮实测 readyState=3):按 /json/list 重新找到
    // 指向本页的 target、换一条 CDP 连接接着量。找得到就是同一个页面,找不到才算真死。
    if (!fx.cdp.socket || fx.cdp.socket.readyState !== 1) {
      const appUrl = `http://127.0.0.1:${fx.appPort}/`;
      const found = await waitForTarget(fx.debugPort, appUrl, fx.browser);
      ok(Boolean(found.target), `B0pre 重载后旧连接关了,按 /json/list 重新连上本页(${found.target ? 'ok' : found.why})`);
      if (!found.target) throw new Error('CDP target lost after reload: ' + found.why);
      fx.cdp.close();
      fx.cdp = new CdpClient(found.target.webSocketDebuggerUrl);
      await fx.cdp.connect();
      await fx.cdp.send('Page.enable');
      await fx.cdp.send('Runtime.enable');
      await fx.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    }
    ok(Boolean(await fx.waitForEval(`(() => (window.state && window.state.config && document.getElementById('railList')) ? 1 : null)()`)), 'B0 刷新后首屏就绪');
    ok(Boolean(await fx.waitForEval(`(() => document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null)()`)), 'B0b 仍在管家视角');
    const afterReload = await waitSide(`s => s.hidden === false && s.collapsed === '1'`);
    ok(Boolean(afterReload) && afterReload.sideWidth <= 60 && afterReload.drawerHidden === true,
      `B1 刷新后右栏仍是收起的(宽 ${afterReload && afterReload.sideWidth}px、抽屉没开;偏好活过刷新)`);
    // 反向的一半:刷新之后的几拍里没有被自动挑选顶开。
    await sleep(1500);
    const held = await snap();
    ok(held.collapsed === '1' && held.drawerHidden === true, `B2 之后 1.5 s 仍收着(实测 collapsed=「${held.collapsed}」drawerHidden=${held.drawerHidden})`);

    /* ═════════ C 收起时管家聚焦新线程不自动展开 ═════════ */
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.b)} } })), true`);
    await sleep(900);
    const focusedWhileCollapsed = await snap();
    ok(focusedWhileCollapsed.collapsed === '1' && focusedWhileCollapsed.drawerHidden === true,
      `C1 派 steward:focus-thread(B):右栏仍收着、抽屉没以覆盖式开出来(实测 collapsed=「${focusedWhileCollapsed.collapsed}」drawerHidden=${focusedWhileCollapsed.drawerHidden} mount=${focusedWhileCollapsed.drawerMount})`);
    ok(focusedWhileCollapsed.stripFresh === '1',
      `C2 窄条亮了一颗「有新动静」的点(data-fresh=1;实测「${focusedWhileCollapsed.stripFresh}」)`);
    await fx.evaluate(`document.getElementById('stewardSideStrip').click(), true`);
    // 列宽是过渡的(steward-shell.css 给 grid-template-columns 上了 --dur-fast):宽度也进等待判据,别在动画中途量。
    const expanded = await waitSide(`s => s.collapsed === '' && s.drawerHidden === false && s.drawerParent === 'stewardFocus' && s.drawerTitle === ${JSON.stringify(TITLE_B)} && s.sideWidth >= 390`);
    ok(Boolean(expanded) && expanded.pref === '0' && expanded.stripFresh === '',
      `C3 点窄条 → 展开,抽屉开在收起期间聚焦的那条 B、点擦掉、偏好写回 0(实测「${expanded && expanded.drawerTitle}」pref=「${expanded && expanded.pref}」)`);

    /* ═════════ D Esc 在常驻栏上收起、不被顶回 ═════════ */
    await fx.evaluate(`(() => { const t = document.getElementById('stewardDrawerTitle'); t && t.focus(); return true; })()`);
    await fx.escape();
    const escCollapsed = await waitSide(`s => s.collapsed === '1' && s.drawerHidden === true`);
    ok(Boolean(escCollapsed), 'D1 Esc(焦点在焦点卡上)→ 右栏收成窄条、抽屉收摊');
    ok(Boolean(escCollapsed) && escCollapsed.active === 'stewardComposerInput', `D1b Esc 之后焦点回到管家输入框(实测 ${escCollapsed && escCollapsed.active})`);
    await sleep(1500);
    const escHeld = await snap();
    ok(escHeld.collapsed === '1' && escHeld.drawerHidden === true, `D2 1.5 s 内没有被 syncNow 按自动挑选顶回(实测 collapsed=「${escHeld.collapsed}」)`);
    // 收摊 D:展开回来,给 E/F 一个「右栏展开着」的起点。
    await fx.evaluate(`document.getElementById('stewardSideStrip').click(), true`);
    ok(Boolean(await waitSide(`s => s.collapsed === '' && s.drawerHidden === false`)), 'D3 再点窄条展开(收摊)');

    /* ═════════ E 对话流里的「打开「X」」act → 去工作台 ═════════ */
    // 问候语(renderDigest)里那一枚 primary act:label 是 stewardShell.chat.openFocus 套上焦点线程的名字。
    const openAct = await fx.waitForEval(`(() => {
      const prefix = ${JSON.stringify(String(zh['stewardShell.chat.openFocus']).split('{{')[0])};
      const btn = [...document.querySelectorAll('#stewardFeed .steward-act')].find(node => (node.textContent || '').indexOf(prefix) === 0);
      return btn ? { label: btn.textContent, disabled: btn.disabled } : null;
    })()`, 200);
    ok(Boolean(openAct), `E0 问候语下有一枚「打开「X」」的 act(实测 ${JSON.stringify(openAct)})`);
    const actTitle = openAct ? String(openAct.label).replace(/^[^「]*「/, '').replace(/」[^」]*$/, '') : '';
    await fx.evaluate(`(() => {
      const prefix = ${JSON.stringify(String(zh['stewardShell.chat.openFocus']).split('{{')[0])};
      const btn = [...document.querySelectorAll('#stewardFeed .steward-act')].find(node => (node.textContent || '').indexOf(prefix) === 0);
      if (btn) btn.click();
      return Boolean(btn);
    })()`);
    const wentClassic = await waitSide(`s => s.mode === 'classic' && !s.vt && s.sessionTitle === ${JSON.stringify(actTitle)}`);
    ok(Boolean(wentClassic), `E1 点它 → 切到工作台并选中那条线程(实测 mode=${wentClassic && wentClassic.mode} title=「${wentClassic && wentClassic.sessionTitle}」,应为「${actTitle}」)`);
    ok(Boolean(wentClassic) && wentClassic.hidden === true, `E2 管家视角的右栏随视角一起收起(实测 hidden=${wentClassic && wentClassic.hidden})`);

    /* ═════════ F 工作台线程头「回到管家」 ═════════ */
    const backBtn = await fx.waitForEval(`(() => { const s = ${SIDE}; return s.backBtn && s.backBtn.visible ? s.backBtn : null; })()`, 200);
    ok(Boolean(backBtn) && backBtn.text === zh['threadHead.backToSteward'],
      `F1 线程头管家条里有「${zh['threadHead.backToSteward']}」入口且看得见(实测 ${JSON.stringify(backBtn)})`);
    // 先在工作台换到另一条线程(C),再按「回到管家」:焦点该落在【刚看的这条】(C),不是之前的焦点。
    await fx.evaluate(`(() => { const row = document.querySelector('#railList .steward-board-thread[data-session-id="${ids.c}"] .steward-board-thread-title'); row && row.click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => ((document.getElementById('sessionTitle') || {}).textContent || '').trim() === ${JSON.stringify(TITLE_C)} ? 1 : null)()`)), `F2 工作台换到线程 C(「${TITLE_C}」)`);
    await fx.evaluate(`document.getElementById('threadBackToStewardBtn').click(), true`);
    const backHome = await waitSide(`s => s.mode === 'steward' && !s.vt && s.hidden === false && s.collapsed === '' && s.drawerTitle === ${JSON.stringify(TITLE_C)}`);
    ok(Boolean(backHome), `F3 点「回到管家」→ 管家视角、右栏展开着、焦点就是刚看的 C(实测 mode=${backHome && backHome.mode} title=「${backHome && backHome.drawerTitle}」)`);
    // 收着的右栏不被「回到管家」顶开:只让钉子记住,窄条亮点。
    await fx.evaluate(`document.getElementById('stewardSideToggleBtn').click(), true`);
    ok(Boolean(await waitSide(`s => s.collapsed === '1'`)), 'F4a 先把右栏收起');
    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    ok(Boolean(await fx.waitForEval(`(() => document.documentElement.getAttribute('data-shell-mode') === 'classic' && !document.documentElement.dataset.vt ? 1 : null)()`)), 'F4b 切到工作台');
    await fx.evaluate(`document.getElementById('threadBackToStewardBtn').click(), true`);
    const backCollapsed = await waitSide(`s => s.mode === 'steward' && !s.vt && s.hidden === false`);
    await sleep(600);
    const backCollapsedHeld = await snap();
    ok(Boolean(backCollapsed) && backCollapsedHeld.collapsed === '1' && backCollapsedHeld.drawerHidden === true,
      `F4 右栏是收着的时候「回到管家」不把它顶开(实测 collapsed=「${backCollapsedHeld.collapsed}」drawerHidden=${backCollapsedHeld.drawerHidden})`);

    ok(fx.exceptions.length === 0, `G1 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'STEWARD SIDE COLLAPSE BROWSER E2E: ALL PASS' : `STEWARD SIDE COLLAPSE BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
