#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// W4b(用户 2026-09-25:「右边的线程永远收不起来……帮忙重新设计管家界面的 UI/UX 吧」的第二轮 —— 上一轮把功能修对了,
// 这一轮是【视觉与信息层级】):主会话看截图挑出的八条,逐条在真浏览器里钉住。公共夹具 lib/browser-fixture
// (假 provider ＋ 隔离家目录 ＋ 无头 Edge),1440×900;三条线程各跑一回合(假 provider 一句就收 → 都是「已收工」)。
// 判据全读 DOM／计算样式／几何,不碰模块私有状态:
//   A 走查①:右栏线程标题被程序性聚焦(activeElement 就是它)时【不画焦点环】(box-shadow/outline 都是 none);
//   B 走查②:左栏「今天收工」的行收成一行 —— 行高 ≤44、与组头重复的「已收工」药丸与「我开的」人形只在紧凑密度不画
//     (节点还在,看板密度一开又回来)、右侧时间说「刚刚」而不是「0s 前有动静」;
//   C 走查③:中栏是【同一条居中的对话列】—— 头部与输入框同宽(720),右栏展开／收起两态宽度不变;
//   D 走查④:右栏减控件 —— 单线程任务不印页签行、已收工的线程不印「停止」、「发给它」搬到输入框旁、
//     跟全局一样的三枚 chip 收成无边小字、没有验收项就不印那一格;主动作只有「在工作台打开」一枚金色;
//   E 走查⑤:头部一句话状态 —— 0 计数不说(状态行空着、不占位),只有一颗状态点(旧的 ::before 那颗退役);
//   F 走查⑥:递送 chip 的默认态收成「@」圆键,label 文字仍是「→ 如意」(读屏),点它照样开候选;
//   G 走查⑦:元信息一行安静地印工作区【名字】,不印路径;
//   H 走查⑧:390px 顶栏分段钮与右侧按钮不重叠、整页无横向滚动,且「@」与输入框同行;
//   I 全程零未捕获异常。
// 反向验证(各条对应的产品改动摘掉即红):A 删 steward-drawer.css 的 .steward-drawer-title:focus-visible;
// B 删 steward-board.css 紧凑密度那组 display:none;C 把 --steward-col-w 改回 880px;D 删 renderTabs 的 host.hidden／
// renderFoot 的 stop.hidden／gradeFootActions 的 .steward-drawer-say;E 把 steward-avatar.css 的 ::before 那颗点加回来;
// F 删 renderChip 的 is-quiet;G 删 renderMeta 的工作区那段;H 删 layout.css ≤640/≤480 两档容器查询。
// 判定行:`STEWARD SHELL REDESIGN BROWSER E2E: ALL PASS`。
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const TITLE_A = '整理下载文件夹';
const TITLE_B = '写周报初稿';
const TITLE_C = '核对三月账单';

const SNAP = `(() => {
  const q = s => document.querySelector(s);
  const byId = id => document.getElementById(id);
  const rect = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const visible = n => Boolean(n) && n.offsetParent !== null && n.getBoundingClientRect().width > 0;
  const cs = (n, p, pseudo) => n ? getComputedStyle(n, pseudo || null)[p] : '';
  const title = byId('stewardDrawerTitle');
  const rows = [...document.querySelectorAll('#railList .steward-board-thread')];
  const chipHost = byId('stewardDrawerChips');
  const firstChip = chipHost ? chipHost.querySelector('.steward-chip') : null;
  const send = byId('stewardDrawerSendBtn');
  const target = byId('stewardTarget');
  const foot = q('#stewardDrawerFoot .steward-drawer-foot-actions');
  return {
    mode: document.documentElement.getAttribute('data-shell-mode') || '',
    collapsed: (byId('stewardSide') || { dataset: {} }).dataset.collapsed || '',
    drawerTitle: ((title || {}).textContent || '').trim(),
    titleFocused: Boolean(title) && document.activeElement === title,
    titleShadow: cs(title, 'boxShadow'), titleOutline: cs(title, 'outlineStyle'),
    rows: rows.map(row => ({
      h: Math.round(row.getBoundingClientRect().height),
      headH: Math.round((row.querySelector('.steward-board-thread-head') || row).getBoundingClientRect().height),
      state: row.dataset.state || '',
      pill: (() => { const p = row.querySelector('.steward-board-thread-head > .steward-board-pill[data-state]'); return p ? { state: p.dataset.state, visible: visible(p), text: p.textContent.trim() } : null; })(),
      origin: (() => { const o = row.querySelector('.rail-origin'); return o ? { origin: o.dataset.origin, visible: visible(o) } : null; })(),
      meta: (() => { const m = row.querySelector('.steward-board-meta'); return m ? { text: m.textContent.trim(), title: m.title, visible: visible(m) } : null; })(),
    })),
    header: rect(q('.steward-header')), composer: rect(q('.steward-composer')),
    tabs: (() => { const t = byId('stewardDrawerTabs'); return t ? { hidden: t.hidden, visible: visible(t), n: t.querySelectorAll('[role="tab"]').length } : null; })(),
    stop: (() => { const s = byId('stewardDrawerStopBtn'); return s ? { hidden: s.hidden, visible: visible(s) } : null; })(),
    sendInSay: Boolean(send) && Boolean(send.parentElement) && send.parentElement.classList.contains('steward-drawer-say')
      && Boolean(send.parentElement.querySelector('#stewardDrawerInput')),
    sendText: send ? send.textContent.trim() : '', sendIcons: send ? send.querySelectorAll('svg.ic').length : 0,
    sendVisibleW: send ? Math.round(send.getBoundingClientRect().width) : 0,
    footVisible: foot ? [...foot.querySelectorAll(':scope > .steward-drawer-btn')].filter(visible).map(n => n.id) : null,
    footPrimary: foot ? [...foot.querySelectorAll('.steward-drawer-btn.is-primary')].map(n => n.id) : null,
    chipsDefault: Boolean(chipHost) && chipHost.classList.contains('is-default'),
    chipBorder: cs(firstChip, 'borderTopColor'), chipVisible: visible(firstChip), chipCount: chipHost ? chipHost.querySelectorAll('.steward-chip').length : 0,
    acceptance: (() => { const a = byId('stewardDrawerMissionAcceptance'); return a ? { hidden: a.hidden, text: a.textContent } : null; })(),
    statusText: ((byId('stewardStatusLine') || {}).textContent || ''), statusDisplay: cs(byId('stewardStatusLine'), 'display'),
    presenceText: ((byId('stewardPresenceText') || {}).textContent || '').trim(),
    presenceBefore: cs(byId('stewardPresenceText'), 'content', '::before'),
    presenceDotVisible: visible(byId('stewardPresenceDot')),
    presenceDotW: byId('stewardPresenceDot') ? Math.round(byId('stewardPresenceDot').getBoundingClientRect().width) : 0,
    targetQuiet: Boolean(target) && target.classList.contains('is-quiet'),
    targetLabel: target ? ((target.querySelector('.steward-target-label') || {}).textContent || '') : '',
    targetLabelVisible: target ? visible(target.querySelector('.steward-target-label')) : null,
    targetAtVisible: target ? visible(target.querySelector('.steward-target-at')) : null,
    targetAria: target ? (target.getAttribute('aria-label') || '') : '',
    targetW: target ? Math.round(target.getBoundingClientRect().width) : 0,
    pickerHidden: (byId('stewardTargetPicker') || {}).hidden,
    workspace: (() => { const w = byId('stewardDrawerWorkspace'); return w ? { hidden: w.hidden, visible: visible(w), text: w.textContent, title: w.title } : null; })(),
    drawerText: ((byId('stewardDrawer') || {}).textContent || ''),
    lens: rect(byId('lensSeg')), shield: rect(byId('stewardShieldBtn')), gear: rect(byId('appGearBtn')), stopBtn: rect(byId('stewardStopBtn')),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    targetRect: rect(target), rowRect: rect(q('.steward-composer-row')),
    vw: document.documentElement.clientWidth,
  };
})()`;

(async () => {
  let fx = null;
  const ids = {};
  let work = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-shell-redesign-', width: 1440, height: 900,
      prepare: async f => {
        work = String(f.work || '');
        for (const [key, title] of [['a', TITLE_A], ['b', TITLE_B], ['c', TITLE_C]]) {
          const created = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          ids[key] = created && created.json && created.json.session && created.json.session.id;
          if (ids[key]) await f.request('POST', '/api/chat/stream', { sessionId: ids[key], message: '开始吧', cwd: f.work }, 120000);
        }
        ok(Boolean(ids.a && ids.b && ids.c), 'S00 三条线程已建并各跑一回合');
      },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    ok(Boolean(await fx.setLens('steward')), 'S00b 在管家视角');
    const snap = () => fx.evaluate(SNAP);
    const waitSnap = (predicate, attempts = 300) => fx.waitForEval(`(() => { const s = ${SNAP}; return (${predicate})(s) ? s : null; })()`, attempts);

    /* ═════════ A 走查①:程序性聚焦的标题不画焦点环 ═════════ */
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.a)} } })), true`);
    const opened = await waitSnap(`s => s.collapsed === '' && s.drawerTitle === ${JSON.stringify(TITLE_A)} && s.titleFocused && s.rows.length === 3`);
    ok(Boolean(opened), `A0 右栏开在 A、标题拿着程序性焦点(实测 title=「${opened && opened.drawerTitle}」focused=${opened && opened.titleFocused})`);
    ok(Boolean(opened) && opened.titleShadow === 'none' && opened.titleOutline === 'none',
      `A1 焦点在标题上时【没有】焦点环(box-shadow=${opened && opened.titleShadow} outline=${opened && opened.titleOutline}) —— 它是 tabindex=-1 的程序性落点,Tab 走不到,环只像个输入框`);

    /* ═════════ B 走查②:左栏收工行收成一行 ═════════ */
    const rows = opened ? opened.rows : [];
    ok(rows.length === 3 && rows.every(row => row.state === 'done'),
      `B0 三条行都在「已收工」(实测 ${JSON.stringify(rows.map(row => row.state))})`);
    ok(rows.length === 3 && rows.every(row => row.h <= 44 && row.headH <= 26),
      `B1 每行一行放下:行高 ≤44、卡头 ≤26(实测 ${JSON.stringify(rows.map(row => row.h + '/' + row.headH))};修前「已收工＋人形」把时间挤到第二行)`);
    ok(rows.length === 3 && rows.every(row => row.pill && row.pill.state === 'done' && row.pill.visible === false && row.pill.text === zh['mission.state.done']),
      `B2 与组头重复的「已收工」药丸【节点照建、紧凑密度不画】(实测 ${JSON.stringify(rows.map(row => row.pill && (row.pill.text + ':' + row.pill.visible)))})`);
    ok(rows.length === 3 && rows.every(row => row.origin && row.origin.origin === 'user' && row.origin.visible === false),
      `B3 「我开的」人形是缺省值不是信息:data-origin 照写、不画(实测 ${JSON.stringify(rows.map(row => row.origin && (row.origin.origin + ':' + row.origin.visible)))})`);
    ok(rows.length === 3 && rows.every(row => row.meta && row.meta.visible && row.meta.text === zh['rail.justNow'] && row.meta.title.indexOf(zh['rail.justNow']) >= 0),
      `B4 右侧只印相对时间「${zh['rail.justNow']}」,整话退到 title(实测 ${JSON.stringify(rows.map(row => row.meta && row.meta.text))};修前是「0s 前有动静」)`);
    // 看板密度一开,药丸与人形回来 —— 收的是视觉,不是信息。
    await fx.evaluate(`document.getElementById('railBoardBtn').click(), true`);
    const dense = await waitSnap(`s => s.rows.length === 3 && s.rows.every(row => row.pill && row.pill.visible)`);
    ok(Boolean(dense) && dense.rows.every(row => row.origin && row.origin.visible),
      `B5 看板密度(440px)下五态药丸与来源图形照印(实测 ${JSON.stringify(dense && dense.rows.map(row => row.pill.visible + '/' + row.origin.visible))})`);
    await fx.evaluate(`document.getElementById('railBoardBtn').click(), true`);
    ok(Boolean(await waitSnap(`s => s.rows.length === 3 && s.rows.every(row => row.pill && !row.pill.visible)`)), 'B6 切回紧凑密度(收摊)');

    /* ═════════ C 走查③:同一条居中的对话列 ═════════ */
    const wide = await snap();
    ok(wide.header && wide.composer && wide.header.w === 720 && wide.composer.w === 720 && wide.header.x === wide.composer.x,
      `C1 右栏展开:头部与输入框同宽 720、同左缘(实测 header=${JSON.stringify(wide.header)} composer=${JSON.stringify(wide.composer)})`);
    await fx.evaluate(`document.getElementById('stewardSideToggleBtn').click(), true`);
    // 列宽是过渡的(steward-shell.css 给 grid-template-columns 上了 --dur-fast):data-collapsed 一落地就量的话,
    // 居中的头部还停在过渡起点 —— 等它真的挪过去(x 变大)再判宽度,别在动画中途量(首跑 C2 就是这么红的)。
    const narrowSide = await waitSnap(`s => s.collapsed === '1' && s.header && s.header.x > ${wide.header.x}`);
    ok(Boolean(narrowSide) && narrowSide.header.w === 720 && narrowSide.composer.w === 720 && narrowSide.header.x === narrowSide.composer.x,
      `C2 右栏收起:还是那条 720 的列,只是居中位置随中栏变(实测 header.x ${wide.header.x} → ${narrowSide && narrowSide.header.x}, w=${narrowSide && narrowSide.header.w}/${narrowSide && narrowSide.composer.w})`);
    await fx.evaluate(`document.getElementById('stewardSideStrip').click(), true`);
    ok(Boolean(await waitSnap(`s => s.collapsed === '' && s.drawerTitle === ${JSON.stringify(TITLE_A)}`)), 'C3 再展开(收摊)');

    /* ═════════ D 走查④:右栏减控件 ═════════ */
    const drawer = await waitSnap(`s => s.drawerTitle === ${JSON.stringify(TITLE_A)} && s.tabs && s.stop && s.footVisible`);
    ok(Boolean(drawer) && drawer.tabs.hidden === true && drawer.tabs.visible === false && drawer.tabs.n === 1,
      `D1 单线程任务:页签行整行不印(那唯一一枚与卡头同名;实测 hidden=${drawer && drawer.tabs.hidden} tabs=${drawer && drawer.tabs.n})`);
    ok(Boolean(drawer) && drawer.stop.hidden === true && drawer.stop.visible === false,
      `D2 已收工的线程不印「停止」(按下去什么都不会发生的按钮;实测 hidden=${drawer && drawer.stop.hidden})`);
    ok(Boolean(drawer) && drawer.sendInSay && drawer.sendIcons === 1 && drawer.sendText === zh['stewardShell.drawer.send'] && drawer.sendVisibleW <= 36,
      `D3 「发给它」搬到输入框旁、收成圆键(同一枚节点:字形 ${drawer && drawer.sendIcons}、人话「${drawer && drawer.sendText}」给读屏、宽 ${drawer && drawer.sendVisibleW}px)`);
    ok(Boolean(drawer) && JSON.stringify(drawer.footVisible) === JSON.stringify(['stewardDrawerClassicBtn']) && JSON.stringify(drawer.footPrimary) === JSON.stringify(['stewardDrawerClassicBtn']),
      `D4 动作行此刻只有一枚看得见的按钮,就是金色的「在工作台打开」(其余按态出现或收进「更多」;实测 ${JSON.stringify(drawer && drawer.footVisible)} primary=${JSON.stringify(drawer && drawer.footPrimary)})`);
    ok(Boolean(drawer) && drawer.chipsDefault && drawer.chipCount === 3 && drawer.chipVisible && drawer.chipBorder === 'rgba(0, 0, 0, 0)',
      `D5 跟全局一样的三枚 chip 收成无边小字(节点与可点性都在:${drawer && drawer.chipCount} 枚、可见=${drawer && drawer.chipVisible}、边=${drawer && drawer.chipBorder})`);
    ok(Boolean(drawer) && drawer.acceptance && drawer.acceptance.hidden === true && drawer.acceptance.text === '',
      `D6 没有验收项就不印「没有验收项」那一格(实测 hidden=${drawer && drawer.acceptance && drawer.acceptance.hidden})`);

    /* ═════════ E 走查⑤:头部一句话状态 ═════════ */
    ok(drawer && drawer.statusText === '' && drawer.statusDisplay === 'none',
      `E1 0 条在跑、0 条等你 → 状态行空着、不占位(实测 text=「${drawer && drawer.statusText}」display=${drawer && drawer.statusDisplay};修前印「3 个任务 · 0 条在跑,0 条等你」)`);
    ok(drawer && drawer.presenceText === zh['stewardShell.presence.idle'] && drawer.presenceDotVisible && drawer.presenceDotW === 6,
      `E2 头部只剩 presence 那一句「${zh['stewardShell.presence.idle']}」＋ 一颗 6px 状态点(实测「${drawer && drawer.presenceText}」dot=${drawer && drawer.presenceDotW}px)`);
    ok(drawer && (drawer.presenceBefore === 'none' || drawer.presenceBefore === ''),
      `E3 旧的第二颗点(steward-avatar.css 的 ::before)已退役 —— 「• • 空闲」只剩一颗(实测 ::before content=${drawer && drawer.presenceBefore})`);

    /* ═════════ F 走查⑥:递送 chip 的默认态 ═════════ */
    ok(drawer && drawer.targetQuiet && drawer.targetLabelVisible === false && drawer.targetAtVisible === true && drawer.targetW <= 30,
      `F1 默认递给如意时 chip 收成「@」圆键(is-quiet;label 收起、@ 露出、宽 ${drawer && drawer.targetW}px)`);
    ok(drawer && drawer.targetLabel === zh['stewardShell.compose.targetSteward'] && drawer.targetAria === zh['stewardShell.compose.targetLabel'],
      `F2 换皮不换字:label 仍是「${zh['stewardShell.compose.targetSteward']}」、可访问名仍是「${zh['stewardShell.compose.targetLabel']}」(实测「${drawer && drawer.targetLabel}」/「${drawer && drawer.targetAria}」)`);
    await fx.evaluate(`document.getElementById('stewardTarget').click(), true`);
    const picked = await waitSnap(`s => s.pickerHidden === false`);
    ok(Boolean(picked), 'F3 点「@」照样开候选列表(功能一个没少)');
    await fx.escape();
    ok(Boolean(await waitSnap(`s => s.pickerHidden === true`)), 'F4 Esc 收起(收摊)');

    /* ═════════ G 走查⑦:元信息一行印工作区名、不印路径 ═════════ */
    const wsName = path.basename(work.replace(/[\\/]+$/, ''));
    const withWs = await snap();
    ok(Boolean(withWs.workspace) && withWs.workspace.hidden === false && withWs.workspace.visible && withWs.workspace.text === wsName && wsName.length > 0,
      `G1 元信息一行安静地印工作区名「${wsName}」(实测「${withWs.workspace && withWs.workspace.text}」visible=${withWs.workspace && withWs.workspace.visible})`);
    ok(Boolean(withWs.workspace) && withWs.workspace.title === String(zh['stewardShell.drawer.workspace']).replace('{{name}}', wsName)
      && withWs.drawerText.indexOf(work) < 0 && !/[\\/]/.test(withWs.workspace.text),
      `G2 悬停出「${String(zh['stewardShell.drawer.workspace']).replace('{{name}}', wsName)}」,整张焦点卡上没有完整路径(实测 title=「${withWs.workspace && withWs.workspace.title}」)`);

    /* ═════════ H 走查⑧:390px 顶栏不重叠、@ 与输入框同行 ═════════ */
    await fx.resize(390, 800);
    await sleep(500);
    const phone = await waitSnap(`s => s.vw === 390 && s.lens && s.shield && s.gear`);
    ok(Boolean(phone) && phone.lens.r <= phone.shield.x && phone.shield.r <= phone.gear.x && phone.gear.r <= 390 && phone.lens.x >= 0,
      `H1 390px:分段钮 → 盾牌 → 齿轮从左到右互不重叠、都在视口里(实测 lens=[${phone && phone.lens.x},${phone && phone.lens.r}] shield=[${phone && phone.shield.x},${phone && phone.shield.r}] gear=[${phone && phone.gear.x},${phone && phone.gear.r}])`);
    ok(Boolean(phone) && phone.overflow <= 1, `H2 390px 整页无横向滚动(差 ${phone && phone.overflow}px)`);
    ok(Boolean(phone) && phone.targetRect && phone.rowRect && phone.rowRect.y < phone.targetRect.b && phone.rowRect.x >= phone.targetRect.r,
      `H3 「@」与输入行同一行(实测 @=${JSON.stringify(phone && phone.targetRect)} row=${JSON.stringify(phone && phone.rowRect)};修前 @ 独占一行、输入框掉到第二行)`);
    await fx.resize(1440, 900);
    await sleep(400);

    ok(fx.exceptions.length === 0, `I1 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'STEWARD SHELL REDESIGN BROWSER E2E: ALL PASS' : `STEWARD SHELL REDESIGN BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
