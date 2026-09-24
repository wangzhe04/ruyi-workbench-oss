#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128d(48 号文 §1;47 号文 G3 缺口③「人工键盘走查未做」的可自动化那一半):全键盘走查。
// 真读屏(NVDA／讲述人)仍留给人 —— 本件量的是【键盘本身】能不能用、看不看得见焦点。
//
//   K1 焦点看得见:从页面开头连按 Tab,每一站的焦点元素相对它【没焦点时】的样子必须有可见的变化
//      (轮廓／阴影;或祖先的 :focus-within 轮廓／阴影;底色／边框／字色变化记作「弱」)。两个视角 × 深浅两主题各走一遍。
//      每一站还要落在视口里(浏览器会把焦点元素滚进来;滚不进来 = 焦点被挡在外面)。
//   K2 没有键盘陷阱:Tab 能一路走回第一站(整页绕一圈)。管家输入框有候选线程时 Tab 被有意拿去「换目标」
//      (steward-composer.js cycleTarget 头注:Shift+Tab 永远能离开)—— 这一处按设计点名放行,K8 另钉它的契约。
//   K3 Shift+Tab 是 Tab 的镜像(抽样倒走几站,站名对得上)。
//   K4 齿轮菜单(role="menu"):Enter 打开 → 焦点进到第一项;↓／↑ 在项间移动,Home／End 到头尾;
//      Esc 收起并把焦点还给齿轮钮;Tab 在项间照走(walkthrough-round2 D6),走出最后一项才收起(K4g)。
//   K5 设置弹窗:从齿轮菜单用键盘打开 → 焦点在弹窗里;Tab／Shift+Tab 走很多下都出不去(焦点陷阱);
//      Esc 关掉后焦点回到一个【看得见】的控件(触发它的菜单项已随菜单收起,不能把焦点还给一个藏起来的节点)。
//   K6 Ctrl+` 在两个视角之间来回切;K6b 背靠背连按两下(第二下落在第一下的视图过渡中途)要落回原处、不冒未捕获异常 ——
//      修前两处都坏:被跳过的过渡 ready 没人接(AbortError 冒到页面上),「切到另一边」读的是还没落地的旧属性(停在管家)。
//   K7 管家视角:左栏线程标题上按 Enter,焦点卡换成这一条;Esc 之后焦点落进管家输入框(宽屏下焦点卡是常驻栏,
//      121-K6b:docked 不存在「关」)。
//   K8 管家输入框的 Tab 契约:有候选线程时 Tab 换目标、焦点不走;Shift+Tab 一定离开输入框。
// 判定行:`KEYBOARD WALKTHROUGH BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const WALK_MAX = 160;
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
const KEYS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'borderTopColor', 'color', 'textDecorationLine'];

// 走之前给页面上每个可聚焦元素(以及它往上三层祖先)记下【没焦点时】的样子。
const TAG_REST = `(() => {
  const keys = ${JSON.stringify(KEYS)};
  const snap = node => { const cs = getComputedStyle(node); return Object.fromEntries(keys.map(k => [k, cs[k]])); };
  try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
  let n = 0;
  for (const node of document.querySelectorAll(${JSON.stringify(FOCUSABLE)})) {
    node.__kbRest = snap(node);
    let a = node.parentElement;
    for (let i = 0; i < 3 && a; i++, a = a.parentElement) if (!a.__kbRest) a.__kbRest = snap(a);
    n++;
  }
  return n;
})()`;

// 当前这一站:谁、看不看得见焦点、在不在视口里。
const STOP = `(() => {
  const keys = ${JSON.stringify(KEYS)};
  const node = document.activeElement;
  if (!node || node === document.body || node === document.documentElement) return { body: true };
  const desc = node.id ? '#' + node.id : (node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''))
    + ((node.getAttribute('aria-label') || node.textContent || '').trim() ? '「' + (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 14) + '」' : '');
  const snap = n => { const cs = getComputedStyle(n); return Object.fromEntries(keys.map(k => [k, cs[k]])); };
  const strong = (now, rest) => {
    const outline = now.outlineStyle !== 'none' && parseFloat(now.outlineWidth) >= 1
      && (now.outlineStyle !== rest.outlineStyle || now.outlineWidth !== rest.outlineWidth || now.outlineColor !== rest.outlineColor);
    const shadow = now.boxShadow !== 'none' && now.boxShadow !== rest.boxShadow;
    const border = now.borderTopColor !== rest.borderTopColor;
    return outline ? 'outline' : shadow ? 'shadow' : border ? 'border' : '';
  };
  let rest = node.__kbRest;
  if (!rest) {   // 走的途中重画出来的新节点:先摘焦点量一次静止样子,再还回去
    node.blur(); rest = snap(node); node.focus({ preventScroll: true });
  }
  const now = snap(node);
  let indicator = strong(now, rest);
  if (!indicator) {
    let a = node.parentElement;
    for (let i = 0; i < 3 && a && !indicator; i++, a = a.parentElement) {
      if (a.__kbRest) { const s = strong(snap(a), a.__kbRest); if (s) indicator = 'within:' + s; }
    }
  }
  if (!indicator && ['backgroundColor', 'color', 'textDecorationLine'].some(k => now[k] !== rest[k])) indicator = 'weak';
  const b = node.getBoundingClientRect();
  const root = document.documentElement;
  return {
    desc,
    key: node.id ? '#' + node.id : desc + '@' + [...document.querySelectorAll('*')].indexOf(node),   // 有 id 的按 id 认(重画挪不动它)
    indicator: indicator || 'none',
    inView: b.width > 1 && b.height > 1 && b.bottom > 0 && b.right > 0 && b.top < root.clientHeight && b.left < root.clientWidth,
    composer: node.id === 'stewardComposerInput',
  };
})()`;

// 管家输入框把 Tab 拿去换目标时,走查从它【之后】的下一个可 Tab 元素接着走(按 DOM 次序;不是键盘能走到的路,
// 所以这一跳本身不算一站,只记一笔)。
const JUMP_PAST_COMPOSER = `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(FOCUSABLE)})].filter(n => n.tabIndex >= 0 && !n.disabled && n.offsetParent !== null);
  const composer = document.getElementById('stewardComposer') || document.getElementById('stewardComposerInput');
  const next = all.find(n => composer && (composer.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && !composer.contains(n));
  if (next) next.focus();
  return Boolean(next);
})()`;

async function walk(fx, label) {
  await fx.evaluate(TAG_REST);
  // 起点:整页第一枚可聚焦元素(跳转链接,a11y-walkthrough B3 钉着它是第一站)。不能靠 blur() 回到页首 ——
  // Chrome 的「顺序导航起点」会停在刚失焦的那个元素上,下一下 Tab 从那里接着走。它获焦会滑进来(挂着过渡),等过渡走完再量。
  await fx.evaluate(`(() => { window.scrollTo(0, 0); const n = document.getElementById('skipToComposer'); if (n) n.focus(); return Boolean(n); })()`);
  await sleep(400);
  const stops = [];
  let first = null;
  let wrapped = false;
  let captured = 0;
  let prevKey = '';
  { const at0 = await fx.evaluate(STOP); if (!at0.body) { first = at0.key; prevKey = at0.key; stops.push(at0); } }
  for (let i = 0; i < WALK_MAX; i++) {
    await fx.tab();
    const at = await fx.evaluate(STOP);
    if (at.body) continue;
    if (first && at.key === first) { wrapped = true; break; }
    if (!first) first = at.key;
    if (at.key === prevKey && at.composer) {
      captured += 1;
      await fx.evaluate(JUMP_PAST_COMPOSER);
      prevKey = '';
      continue;
    }
    prevKey = at.key;
    stops.push(at);
  }
  const noIndicator = stops.filter(s => s.indicator === 'none');
  const weak = stops.filter(s => s.indicator === 'weak');
  const outOfView = stops.filter(s => !s.inView);
  console.log(`NOTE ${label}:走了 ${stops.length} 站,绕回第一站=${wrapped},管家输入框拿走 Tab ${captured} 次;` +
    `指示方式分布 ${JSON.stringify(stops.reduce((m, s) => { const k = s.indicator.split(':').pop(); m[k] = (m[k] || 0) + 1; return m; }, {}))}`);
  if (weak.length) console.log(`NOTE ${label}:只有底色/字色变化(弱)的站:${weak.map(s => s.desc).join('、')}`);
  ok(stops.length >= 15, `K1a ${label}:Tab 走得出东西(${stops.length} 站)`);
  ok(noIndicator.length === 0, `K1 ${label}:每一站焦点都看得见(看不见的 ${noIndicator.length} 站${noIndicator.length ? ':' + noIndicator.map(s => s.desc).slice(0, 12).join('、') : ''})`);
  ok(outOfView.length === 0, `K1b ${label}:每一站都在视口里(在外面的 ${outOfView.length} 站${outOfView.length ? ':' + outOfView.map(s => s.desc).slice(0, 8).join('、') : ''})`);
  ok(wrapped, `K2 ${label}:Tab 能绕回第一站(没有键盘陷阱;${WALK_MAX} 下内${wrapped ? '' : '没'}绕回)`);
  return stops;
}

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-kbwalk-',
      width: 1440,
      height: 900,
      config: { uiMode: 'pro', theme: 'dark' },
      prepare: async f => {
        for (const title of ['键盘走查甲', '键盘走查乙']) {
          const created = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          const sid = created && created.json && created.json.session && created.json.session.id;
          ok(Boolean(sid), `K0 线程「${title}」已建`);
          if (sid) await f.request('POST', '/api/chat/stream', { sessionId: sid, message: '一句', cwd: f.work }, 120000);
        }
      },
    });
    const ev = expr => fx.evaluate(expr);
    const active = () => ev(`(() => { const n = document.activeElement; return n ? (n.id || n.tagName) : ''; })()`);

    /* ═════════ K1／K2 两视角 × 两主题 ═════════ */
    const setTheme = async theme => {
      for (let i = 0; i < 4; i++) {
        const now = await ev(`document.documentElement.getAttribute('data-theme')`);
        if (now === theme) return true;
        await ev(`(() => { document.getElementById('themeToggle').click(); return true; })()`);
        await sleep(200);
      }
      return (await ev(`document.documentElement.getAttribute('data-theme')`)) === theme;
    };
    let classicDarkStops = [];
    for (const theme of ['dark', 'light']) {
      ok(await setTheme(theme), `K0b 主题切到 ${theme}`);
      for (const lens of ['steward', 'classic']) {
        ok(Boolean(await fx.setLens(lens)), `K0c 视角 ${lens}`);
        await sleep(300);
        const stops = await walk(fx, `${lens}·${theme}`);
        if (lens === 'classic' && theme === 'dark') classicDarkStops = stops;
      }
    }
    await setTheme('dark');

    /* ═════════ K3 Shift+Tab 是镜像 ═════════ */
    await fx.setLens('classic');
    await ev(TAG_REST);
    await ev(`(() => { const n = document.getElementById('skipToComposer'); if (n) n.focus(); return true; })()`);
    if (classicDarkStops.length >= 8) {
      // 从第一站重走到第 8 站,再倒走 4 站,站名应当依次是第 7、6、5、4 站。
      for (let i = 0; i < 40; i++) {
        await fx.tab();
        const at = await ev(STOP);
        if (!at.body && at.key === classicDarkStops[7].key) break;
      }
      const back = [];
      for (let i = 0; i < 4; i++) { await fx.tab(true); back.push((await ev(STOP)).key); }
      const expected = [6, 5, 4, 3].map(i => classicDarkStops[i].key);
      ok(JSON.stringify(back) === JSON.stringify(expected), `K3 Shift+Tab 倒走 4 站与正走对得上(实 ${JSON.stringify(back)} / 应 ${JSON.stringify(expected)})`);
    } else ok(false, `K3 正走的站不够 8 个,没法抽样(${classicDarkStops.length})`);

    /* ═════════ K4 齿轮菜单 ═════════ */
    await ev(`(() => { document.getElementById('appGearBtn').focus(); return true; })()`);
    await fx.enter();
    await sleep(150);
    const menuItems = await ev(`[...document.querySelectorAll('#appGearMenu [role="menuitem"]')].filter(n => n.offsetParent !== null).map(n => n.id)`);
    const opened = await ev(`document.getElementById('appGearMenu').hidden === false`);
    ok(opened, 'K4a 齿轮钮上按 Enter,菜单打开');
    ok((await active()) === menuItems[0], `K4 打开后焦点进到第一项(实 ${await active()} / 应 ${menuItems[0]})`);
    await fx.key('ArrowDown', { keyCode: 40 });
    ok((await active()) === menuItems[1], `K4b ↓ 到第二项(实 ${await active()} / 应 ${menuItems[1]})`);
    await fx.key('ArrowUp', { keyCode: 38 });
    await fx.key('ArrowUp', { keyCode: 38 });
    ok((await active()) === menuItems[menuItems.length - 1], `K4c 在第一项上 ↑ 绕到最后一项(实 ${await active()})`);
    await fx.key('Home', { keyCode: 36 });
    ok((await active()) === menuItems[0], `K4d Home 回第一项(实 ${await active()})`);
    await fx.key('End', { keyCode: 35 });
    ok((await active()) === menuItems[menuItems.length - 1], `K4e End 到最后一项(实 ${await active()})`);
    await fx.escape();
    await sleep(100);
    const afterEsc = { hidden: await ev(`document.getElementById('appGearMenu').hidden`), focus: await active(), expanded: await ev(`document.getElementById('appGearBtn').getAttribute('aria-expanded')`) };
    ok(afterEsc.hidden && afterEsc.focus === 'appGearBtn' && afterEsc.expanded === 'false',
      `K4f Esc 收起菜单、焦点还给齿轮钮、aria-expanded 回 false(${JSON.stringify(afterEsc)})`);
    // K4g Tab 在项间照走(walkthrough-round2 D6 更早钉下的契约),走出最后一项菜单才收起。128d 首版「Tab 即收」
    // 把 D6 弄红过(全量回归查出)—— 这里把两半一起钉住:走的途中菜单开着,走出去之后收起、焦点不在藏起来的项上。
    await fx.enter();
    await sleep(150);
    const tabWalk = [];
    for (let i = 0; i < menuItems.length; i++) {
      await fx.tab();
      tabWalk.push(await ev(`(() => { const a = document.activeElement; return {
        at: (a && a.id) || '', tag: a ? a.tagName : '', open: document.getElementById('appGearMenu').hidden === false,
      }; })()`));
    }
    const walkIn = tabWalk.slice(0, -1);
    const out = tabWalk[tabWalk.length - 1] || {};
    ok(walkIn.every(s => s.open && menuItems.includes(s.at)) && new Set(walkIn.map(s => s.at)).size === menuItems.length - 1,
      `K4g Tab 在项间走、菜单一直开着(${JSON.stringify(walkIn.map(s => s.at))})`);
    ok(out.open === false && !menuItems.includes(out.at) && out.tag !== '' && out.tag !== 'BODY',
      `K4g2 走出最后一项:菜单收起、焦点落到菜单外一个真控件上(${JSON.stringify(out)})`);
    await ev(`(() => { document.getElementById('appGearBtn').focus(); return true; })()`);

    /* ═════════ K5 设置弹窗 ═════════ */
    await fx.enter();                       // 焦点在齿轮钮上:再开菜单,焦点落第一项「设置」
    await sleep(150);
    ok((await active()) === 'openSettingsBtn', `K5a 菜单第一项是「设置」且有焦点(实 ${await active()})`);
    await fx.enter();
    const modalOpen = await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 100);
    await sleep(150);
    ok(Boolean(modalOpen), 'K5b Enter 打开设置弹窗');
    const inside = `(() => { const m = document.getElementById('settingsModal'); return Boolean(document.activeElement) && m.contains(document.activeElement); })()`;
    ok(await ev(inside), `K5c 焦点进了弹窗(实 ${await active()})`);
    let leaked = 0;
    for (let i = 0; i < 60; i++) { await fx.tab(); if (!(await ev(inside))) leaked += 1; }
    for (let i = 0; i < 20; i++) { await fx.tab(true); if (!(await ev(inside))) leaked += 1; }
    ok(leaked === 0, `K5d Tab×60 ＋ Shift+Tab×20 焦点一次都没出弹窗(漏出 ${leaked} 次)`);
    await fx.escape();
    await sleep(200);
    const closed = await ev(`(() => {
      const n = document.activeElement;
      return { closed: document.getElementById('settingsModal').classList.contains('hidden'),
        focus: n ? (n.id || n.tagName) : '', visible: Boolean(n) && n !== document.body && n.offsetParent !== null };
    })()`);
    ok(closed.closed, 'K5e Esc 关掉设置弹窗');
    ok(closed.visible, `K5 关掉后焦点落在一个看得见的控件上(实 ${closed.focus})—— 触发它的菜单项已随菜单收起`);

    /* ═════════ K6 Ctrl+` 切视角 ═════════ */
    const lensNow = () => ev(`document.documentElement.getAttribute('data-shell-mode')`);
    const before = await lensNow();
    await fx.key('`', { code: 'Backquote', keyCode: 192, modifiers: 2 });
    await sleep(400);
    const mid = await lensNow();
    await fx.key('`', { code: 'Backquote', keyCode: 192, modifiers: 2 });
    await sleep(400);
    const after = await lensNow();
    ok(mid !== before && after === before, `K6 Ctrl+\` 来回切视角(${before} → ${mid} → ${after})`);
    // 快切:两下 Ctrl+` 背靠背发出 —— 第二下落在第一下的视图过渡 ready 之前(第一下被跳过)。落点要回到原处,且页面上不许冒
    // 未捕获的 AbortError(修前 shell-mode.js 只接了 transition.finished,被跳过的那次 ready 没人接,见 K9)。
    const exBefore = fx.exceptions.length;
    await Promise.all([   // 两下背靠背发出去(不等第一下的往返),第二下一定落在第一下的 ready 之前
      fx.key('`', { code: 'Backquote', keyCode: 192, modifiers: 2 }),
      fx.key('`', { code: 'Backquote', keyCode: 192, modifiers: 2 }),
    ]);
    await sleep(900);
    const fast = await lensNow();
    ok(fast === before && fx.exceptions.length === exBefore, `K6b 连按两下 Ctrl+\`(背靠背)落回原视角、不冒未捕获异常(落点 ${fast};新增异常 ${fx.exceptions.length - exBefore}${fx.exceptions.length > exBefore ? ':' + fx.exceptions.slice(exBefore).join(' | ') : ''})`);

    /* ═════════ K7 管家视角:标题上 Enter 开焦点卡,Esc 把焦点送进输入框 ═════════ */
    // 宽屏(本件 1440)下焦点卡是【常驻栏】。2026-09-24 起 Esc 在它上面＝把右栏收成窄条并把焦点送回管家
    // 输入框(closeDrawer({ focusComposer: true }) → closeNow → setSideCollapsed(true);收起的行为由
    // steward-side-collapse.browser 与 steward-board.e2e F 组钉)。本件钉的是键盘这条路走得通:Enter 让焦点卡
    // 换成这一条(右栏收着也会为这一下展开),Esc 之后焦点有去处、且是看得见的输入框。
    await fx.setLens('steward');
    await sleep(300);
    const focusedTitle = await ev(`(() => {
      const t = [...document.querySelectorAll('#railList .steward-board-thread-title')].find(n => (n.textContent || '').includes('键盘走查甲'));
      if (!t) return '';
      t.focus();
      return (t.textContent || '').trim();
    })()`);
    await fx.enter();
    const drawerTitle = await fx.waitForEval(`(() => {
      const d = document.getElementById('stewardDrawer');
      const t = document.getElementById('stewardDrawerTitle');
      return d && d.hidden === false && t && (t.textContent || '').includes('键盘走查甲') ? t.textContent.trim() : null;
    })()`, 200);
    ok(Boolean(focusedTitle) && Boolean(drawerTitle), `K7a 在左栏标题「${focusedTitle}」上按 Enter,焦点卡换成这一条(卡头「${drawerTitle}」)`);
    await fx.escape();
    await sleep(250);
    const k7 = await ev(`(() => { const n = document.activeElement; return { focus: n ? (n.id || n.className) : '', visible: Boolean(n) && n.offsetParent !== null }; })()`);
    ok(k7.focus === 'stewardComposerInput' && k7.visible, `K7 Esc 之后焦点落进管家输入框(${JSON.stringify(k7)})`);

    /* ═════════ K8 管家输入框的 Tab 契约 ═════════ */
    // 候选线程来自输入即预判(/api/steward/preroute 命中)与「见过的线程」回忆池。先打一句带线程标题的话,
    // 等预判落定(去抖 150 ms ＋ 一次往返),chip 上出现「像是接着『…』」再按 Tab。
    const label = () => ev(`((document.querySelector('#stewardTarget .steward-target-label') || {}).textContent || '').trim()`);
    await ev(`(() => { const i = document.getElementById('stewardComposerInput'); i.value = ''; i.focus(); return true; })()`);
    await fx.cdp.send('Input.insertText', { text: '键盘走查甲 接着做' });
    const hinted = await fx.waitForEval(`(() => { const c = document.getElementById('stewardTarget'); return c && c.classList.contains('is-thread') ? 1 : null; })()`, 100);
    const chip0 = await label();
    ok(Boolean(hinted), `K8a 打一句带线程标题的话,预判出候选(chip「${chip0}」)`);
    await fx.tab();
    const chip1 = await label();
    const stay = await active();
    ok(stay === 'stewardComposerInput' && chip1 !== chip0, `K8b 有候选时 Tab 换目标、焦点不走(「${chip0}」→「${chip1}」,焦点 ${stay})`);
    await fx.tab(true);
    const left = await active();
    ok(left !== 'stewardComposerInput', `K8 Shift+Tab 一定离开输入框(实 ${left})—— 键盘用户永远出得去`);
    await ev(`(() => { const i = document.getElementById('stewardComposerInput'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);

    ok(fx.exceptions.length === 0, `K9 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'KEYBOARD WALKTHROUGH BROWSER E2E: ALL PASS' : `KEYBOARD WALKTHROUGH BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
