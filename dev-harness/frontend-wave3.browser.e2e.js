#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 第三波前端走查修复（W3-ui）的真浏览器回归。每一项都在【它坏过的宽度与语言】上量，不是只在 1280 中文下点一下。
//
//   H1  顶栏盾牌（权限档）菜单：宽度在视口里、说明句折行不溢出框（修前 zh 1280 宽 1011、en 1280 宽 2130 且 left=-948、≤390 只有 51px）；
//   H2  顶栏：分段钮与状态胶囊／盾牌／停机／右栏／齿轮两两不重叠、分段钮不出左缘、齿轮不出右缘
//       （修前 en 空闲 ~700–850、en 在跑 1180→700、zh 在跑 700–860 重叠，en 500 分段钮 left=-36），空闲与「有任务在跑」两态各量；
//   H3  左栏线程行：长标题时色点与标题同一行、行高不涨到三行；英文「等你放行」药丸不独占整行；
//   H4  ≤1180 关着的右抽屉：visibility:hidden、Tab 走 40 下焦点不进抽屉、.app-shell 不被横向滚走；开着时能进，收起时焦点还给「右栏」钮；
//   H5  管家设置「新建定时任务」表单：hidden 就是不显示；「新建」显示、选「只这一次」时「星期几」不显示、选「每周」才显示、「取消」收回；
//   H6  ≤640 设置页签条：页签两两不叠、宽度不再是「组宽的百分比」、切到后面的页签时激活钮被滚进条的可见区；
//   M1  390 子代理卡片头：标题不被状态句挤成 0；
//   M2  390 工具卡「人话动词」不被路径挤成一字一行；
//   M3  管家视角右抽屉开着、弹窗叠在上面时，第一下 Esc 关弹窗、抽屉不动；
//   M4  英文界面：新建「自定义」服务商的显示名无中文；左栏「等你放行」一行按界面语言重拼；子代理进度带 noteCode；
//   M5  档名统一：英文向导 "Ask me every step"／"Edit files without asking"；定时任务权限下拉顺序是 默认／改文件不问／只做计划／智能自动；
//   M6  服务商卡「测试连接」的结果紧跟卡头（不在 ~900px 之外的卡底）；
//   M8  英文线程头：chip 的值不收成 0 宽；390 下管家条的复选框有可见文字。
//
// 反向验证（先破坏、看真红、再还原）：本件在修前的树（e59d976）上跑过，H1–H6 与 M 组各自红，记在提交说明里。
// 判定行：`FRONTEND WAVE3 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('FRONTEND WAVE3 BROWSER');
const { ok } = t;
const ROOT = path.join(__dirname, '..', 'ruyi-workbench', 'app');
const LOCALES = path.join(ROOT, 'public', 'locales');
const ZH = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en-US.json'), 'utf8'));
const CJK = /[㐀-鿿]/;

// 确定性 provider：HOLD → 先说半句、等放行再说完（线程停在「在跑」）；ASKME → 一条单选提问；PERM → 写一个文件（待权限放行）；其余「好。」。
const gates = [];
const releaseHolds = () => { for (const release of gates.splice(0)) release(); };
async function script(ctx) {
  const last = ctx.messages[ctx.messages.length - 1] || {};
  const text = last.role === 'user' ? String(last.content || '') : '';
  if (/ASKME/.test(text) && !ctx.answered) {
    ctx.toolCall('request_user_input', { questions: [{
      id: 'q1', header: '确认', question: '这件事要等吗？', answerMode: 'single',
      options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
    }] });
    return;
  }
  if (/PERM/.test(text) && !ctx.answered) {
    ctx.toolCall('file_write', { path: path.join(fixtureWork, 'pdir', 'report.md'), content: '# 周报\n' });   // 必须落在该线程自己的 cwd（pdir）里：写到工作夹外面是直接拒绝、不会弹权限
    return;
  }
  if (/HOLD/.test(text)) {
    ctx.text('先说一句，');
    await new Promise(resolve => gates.push(resolve));
    ctx.text('再说完。');
    ctx.stop();
    return;
  }
  ctx.text('好。');
  ctx.stop();
}
let fixtureWork = '';

const ids = {};
const rowSel = id => `#railList li.steward-board-thread[data-session-id="${id}"]`;
const LONG_TITLE = '你好,帮我看看这个项目的结构,这是一个比较长的线程标题用来测试省略号是否正常工作';

function fireAndForget(fx, pathname, body) {
  const raw = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: fx.appPort, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': fx.token, 'content-length': Buffer.byteLength(raw) } }, res => { res.resume(); });
  req.on('error', () => {});
  req.write(raw); req.end();
}

// 顶栏探针：六个可见控件两两不叠、分段钮不出左缘、齿轮不出右缘。
const TOPBAR_PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const rect = sel => { const n = document.querySelector(sel); if (!n) return null; const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return null; const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null; };
  const items = { lens: rect('#lensSeg'), chip: rect('#appStatusChip'), shield: rect('.steward-shield-wrap'), stop: rect('#stewardStopBtn'), side: rect('#appSideToggleBtn'), gear: rect('#appGearBtn') };
  const keys = Object.keys(items).filter(k => items[k]);
  const overlap = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = items[keys[i]], b = items[keys[j]];
    if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1) overlap.push(keys[i] + 'x' + keys[j]);
  }
  const out = keys.filter(k => items[k].l < -1 || items[k].r > vw + 1);
  return { vw, overlap, out, chip: Boolean(items.chip) };
})()`;

(async () => {
  let fx = null;
  const only = String(process.env.W3_PHASES || '').split(',').filter(Boolean);
  const phase = async (name, fn) => {
    if (only.length && !only.some(p => name.startsWith(p))) return;
    try { await fn(); } catch (error) { t.fail(`${name} 未预期异常：${error && error.stack || error}`); }
  };
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-frontend-wave3-', width: 1280, height: 900, provider: script,
      // 无头浏览器默认报 (hover: none)（走触屏那套常显规则）；本件量桌面行为，声明「有鼠标」。
      browserArgs: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
      prepare: async f => {
        fixtureWork = f.work;
        fs.mkdirSync(path.join(f.work, 'pdir'), { recursive: true });   // 「等你放行」那条换一个工作夹：同夹的写锁被「等你拍板」那条占着时它进不了权限待决
        const make = async (title, cwd = f.work) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await f.request('POST', '/api/sessions', { title, cwd }, 120000);
            if (r && r.json && r.json.session && r.json.session.id) return r.json.session.id;
          }
          return '';
        };
        ids.S = await make('短标题');
        ids.L = await make(LONG_TITLE);
        ids.R = await make('在跑那条');
        ids.Q = await make('等你拍板那条');
        ids.P = await make('等你放行那条', path.join(f.work, 'pdir'));
        ok(Object.values(ids).every(Boolean), `F0f 五条线程都建出来了（${JSON.stringify(ids)}）`);
      },
    });
    const ev = expression => fx.evaluate(expression);
    const waitFor = (expression, attempts) => fx.waitForEval(expression, attempts);
    const setLocale = async locale => {
      await ev(`import('/js/i18n.js').then(m => m.setLocale('${locale}')).then(() => document.documentElement.lang)`);
      await sleep(500);
    };
    try { await fx.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 旧内核没有就算了 */ }
    const clickEsc = async () => { await fx.escape(); await sleep(250); };

    /* ═════════ H1：盾牌菜单 ═════════ */
    await phase('H1', async () => {
      ok(Boolean(await fx.setLens('steward')), 'H1.0 管家视角');
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        for (const w of [1280, 1024, 760, 500, 390]) {
          await fx.resize(w, 900);
          await ev(`(document.getElementById('stewardShieldBtn').click(), true)`);
          await sleep(300);
          const m = await ev(`(() => {
            const menu = document.getElementById('stewardShieldMenu'); const r = menu.getBoundingClientRect(); const vw = document.documentElement.clientWidth;
            const opts = [...menu.querySelectorAll('.steward-shield-option')];
            const spill = opts.filter(o => [...o.children].some(c => c.getBoundingClientRect().right > r.right + 1 || c.getBoundingClientRect().left < r.left - 1)).length;
            return { hidden: menu.hidden, l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), vw, n: opts.length, spill, tall: Math.round(r.height) };
          })()`);
          ok(!m.hidden && m.n === 5, `H1.1 [${locale} ${w}] 菜单开着、五档齐（实测 ${JSON.stringify(m)}）`);
          ok(m.l >= -1 && m.r <= m.vw + 1, `H1.2 [${locale} ${w}] 菜单整个在视口里（left ${m.l}、right ${m.r}、视口 ${m.vw}；修前 en 1280 left=-948）`);
          ok(m.w >= 180 && m.w <= (w <= 640 ? m.vw - 8 : 440), `H1.3 [${locale} ${w}] 菜单宽 ${m.w}px 在 180–${w <= 640 ? '视口-8（窄屏铺满）' : '440'} 之间（修前 zh 1011／en 2130／≤390 的 51）`);
          ok(m.spill === 0, `H1.4 [${locale} ${w}] 选项里的文字不溢出菜单框（${m.spill} 条溢出）`);
          await clickEsc();
          await ev(`(() => { const m = document.getElementById('stewardShieldMenu'); if (m && !m.hidden) document.getElementById('stewardShieldBtn').click(); return true; })()`);
        }
      }
      await setLocale('zh-CN');
    });

    /* ═════════ H2：顶栏重叠 ═════════ */
    await phase('H2', async () => {
      fireAndForget(fx, '/api/chat/stream', { sessionId: ids.R, message: 'HOLD 在跑', cwd: fx.work });
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        for (const lens of ['steward', 'classic']) {
          await fx.setLens(lens);
          await sleep(300);
          for (const state of ['running']) {
            // 在跑那条要真出了状态胶囊（它才是 en 在 1180→700 压住分段钮的那一枚）
            const chipUp = await waitFor(`(() => { const c = document.getElementById('appStatusChip'); return c && !c.hidden ? 1 : null; })()`, 400);
            ok(Boolean(chipUp), `H2.0 [${locale} ${lens}] 在跑那条让「N 在跑」胶囊出现了`);
            for (const w of [1280, 1180, 1100, 1024, 960, 900, 860, 820, 780, 760, 700, 640, 600, 500, 420, 390]) {
              await fx.resize(w, 900);
              await sleep(120);
              const m = await ev(TOPBAR_PROBE);
              ok(m.overlap.length === 0 && m.out.length === 0,
                `H2.1 [${locale} ${lens} ${state} ${w}] 顶栏控件不重叠、不出屏（重叠 ${JSON.stringify(m.overlap)}；出屏 ${JSON.stringify(m.out)}；胶囊${m.chip ? '在' : '已收'}）`);
            }
          }
        }
      }
      releaseHolds();
      await fx.resize(1280, 900);
      await setLocale('zh-CN');
      // 空闲（没有胶囊）也量一遍：等在跑的回合收尾
      await waitFor(`(() => { const c = document.getElementById('appStatusChip'); return !c || c.hidden ? 1 : null; })()`, 400);
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        for (const lens of ['steward', 'classic']) {
          await fx.setLens(lens);
          for (const w of [1024, 860, 820, 780, 760, 700, 640, 500, 390]) {
            await fx.resize(w, 900);
            await sleep(120);
            const m = await ev(TOPBAR_PROBE);
            ok(m.overlap.length === 0 && m.out.length === 0, `H2.2 [${locale} ${lens} 空闲 ${w}] 顶栏控件不重叠、不出屏（重叠 ${JSON.stringify(m.overlap)}；出屏 ${JSON.stringify(m.out)}）`);
          }
        }
      }
      await fx.resize(1280, 900);
      await setLocale('zh-CN');
    });

    /* ═════════ M3：弹窗上的 Esc 先关弹窗（排在 H3 之前：H3 会挂上提问／权限待决，它们的弹窗会在后面再冒出来、盖在快捷键弹窗上，那时第一下 Esc 关的是它们） ═════════ */
    await phase('M3', async () => {
      await fx.resize(1280, 900);
      await setLocale('zh-CN');
      await fx.setLens('steward');
      await ev(`(document.querySelector('${rowSel(ids.S)} .steward-board-thread-title')).click(), true`);
      ok(Boolean(await waitFor(`(() => { const d = document.querySelector('.steward-side'); return d && !d.hidden && getComputedStyle(d).visibility === 'visible' ? 1 : null; })()`, 400)), 'M3.1 管家右抽屉开着');
      await ev(`(document.getElementById('appGearBtn').click(), document.getElementById('helpBtn').click(), true)`);
      await sleep(500);
      ok(await ev(`!document.getElementById('helpModal').classList.contains('hidden')`), 'M3.2 快捷键弹窗开着');
      await fx.escape();
      await sleep(400);
      const after = await ev(`({ modal: !document.getElementById('helpModal').classList.contains('hidden'), drawer: (() => { const d = document.querySelector('.steward-side'); return !!d && !d.hidden && getComputedStyle(d).display !== 'none'; })(), focus: document.activeElement && (document.activeElement.id || document.activeElement.className) })`);
      ok(after.modal === false, `M3.3 第一下 Esc 就关了弹窗（修前要按两下；实测 ${JSON.stringify(after)}）`);
      ok(after.drawer === true, 'M3.4 抽屉没被这一下 Esc 收掉');
    });

    /* ═════════ H3：左栏行 ═════════ */
    await phase('H3', async () => {
      // 让「等你拍板」「等你放行」两条真的挂上（英文下药丸最长）
      fireAndForget(fx, '/api/chat/stream', { sessionId: ids.Q, message: 'ASKME', cwd: fx.work });
      await fx.request('POST', '/api/config', { permissionMode: 'default' });
      fireAndForget(fx, '/api/chat/stream', { sessionId: ids.P, message: 'PERM 写文件', cwd: path.join(fx.work, 'pdir') });
      ok(Boolean(await fx.setLens('steward')), 'H3.0 管家视角');
      ok(Boolean(await waitFor(`document.querySelectorAll('#railList .steward-board-pill.is-asks-you').length >= 2 ? 1 : null`, 600)), `H3.1 两条「它在问你」药丸都挂上了（${JSON.stringify(await ev(`[...document.querySelectorAll('#railList li.steward-board-thread')].map(li => [li.dataset.sessionId.slice(-4), li.dataset.state, !!li.querySelector('.is-asks-you'), (li.querySelector('.steward-board-sub') || {}).textContent, (li.querySelector('.steward-board-wait') || {}).textContent])`))}；ids=${JSON.stringify(ids)}）`);
      // 提问／权限弹窗会自己弹出来盖住后面的操作；Esc = 「稍后处理」（待决仍挂着，左栏行还在「等你」）。
      for (let i = 0; i < 4 && await ev(`!!document.querySelector('.modal-backdrop:not(.hidden)')`); i++) await clickEsc();
      const ROW = id => `(() => {
        const li = document.querySelector('${rowSel(id)}'); if (!li) return null;
        const head = li.querySelector('.steward-board-thread-head'); const dot = li.querySelector('.steward-tcard-dot'); const title = li.querySelector('.steward-board-thread-title');
        const pill = li.querySelector('.steward-board-pill.is-asks-you'); const hr = head.getBoundingClientRect(); const dr = dot.getBoundingClientRect(); const tr = title.getBoundingClientRect();
        const visible = [...head.children].filter(c => c.getClientRects().length);
        const lines = new Set(visible.map(c => Math.round(c.getBoundingClientRect().top / 12))).size;
        return { headH: Math.round(hr.height), dotMid: Math.round(dr.top + dr.height / 2), titleMid: Math.round(tr.top + tr.height / 2), titleW: Math.round(tr.width), lines,
          pillH: pill ? Math.round(pill.getBoundingClientRect().height) : 0, pillLines: pill ? Math.round(pill.getBoundingClientRect().height / 14) : 0 };
      })()`;
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        for (const w of [1280, 1024]) {
          await fx.resize(w, 900);
          await sleep(500);
          for (const [name, id] of [['长标题', ids.L], ['短标题', ids.S]]) {
            const m = await ev(ROW(id));
            ok(Boolean(m) && Math.abs(m.dotMid - m.titleMid) <= 6 && m.titleW >= 60,
              `H3.2 [${locale} ${w}] ${name}：色点与标题同一行、标题不被挤没（实测 ${JSON.stringify(m)}；修前长标题：色点在第 1 行、标题在第 2 行）`);
            ok(Boolean(m) && m.headH <= 48, `H3.3 [${locale} ${w}] ${name}：行头不超过两行高（${m && m.headH}px；修前长标题三行 ≥ 60）`);
          }
          const q = await ev(ROW(ids.P));
          ok(Boolean(q) && q.pillH > 0 && q.pillH <= 30, `H3.4 [${locale} ${w}] 「它在问你」药丸高 ${q && q.pillH}px，不是 40px 的大按钮`);
        }
      }
      await fx.resize(1280, 900);
      await setLocale('zh-CN');
    });

    /* ═════════ H4：关着的右抽屉 ═════════ */
    await phase('H4', async () => {
      for (const w of [1024, 760]) {
        await fx.resize(w, 900);
        ok(Boolean(await fx.setLens('classic')), `H4.0 [${w}] 工作台视角`);
        await ev(`(document.querySelector('${rowSel(ids.S)} .steward-board-thread-title') || document.getElementById('newSessionBtn')).click(), true`);
        await sleep(800);
        const closed = await ev(`(() => { const p = document.getElementById('toolPane'); const cs = getComputedStyle(p); return { vis: cs.visibility, tf: cs.transform, shadow: cs.boxShadow, open: document.getElementById('appFrame').classList.contains('side-open') || document.querySelector('.app-shell').classList.contains('tools-open') }; })()`);
        ok(closed.vis === 'hidden' && !closed.open, `H4.1 [${w}] 关着的工作区抽屉 visibility:hidden（实测 ${JSON.stringify(closed)}）`);
        ok(closed.shadow === 'none', `H4.2 [${w}] 关着的抽屉不带阴影（否则把 40px 软影漏进视口右缘；实测 ${closed.shadow}）`);
        await ev(`(document.getElementById('sendBtn').focus(), true)`);
        const seen = [];
        for (let i = 0; i < 40; i++) {
          await fx.tab();
          seen.push(await ev(`(() => { const a = document.activeElement; return a && a.closest ? (a.closest('#toolPane, .steward-side') ? 'IN:' + (a.id || a.className) : 'ok') : 'ok'; })()`));
        }
        const sl = await ev(`document.querySelector('.app-shell').scrollLeft`);
        ok(seen.every(s => !String(s).startsWith('IN:')), `H4.3 [${w}] Tab 走 40 下焦点没进关着的抽屉（${JSON.stringify(seen.filter(s => s !== 'ok').slice(0, 3))}）`);
        ok(sl === 0, `H4.4 [${w}] .app-shell 没被横向滚走（scrollLeft=${sl}；修前 392）`);
        // 开着时能进、收起时焦点还给「右栏」钮
        await ev(`(document.getElementById('appSideToggleBtn').click(), true)`);
        await sleep(500);
        const opened = await ev(`(() => { const p = document.getElementById('toolPane'); return getComputedStyle(p).visibility; })()`);
        ok(opened === 'visible', `H4.5 [${w}] 点「右栏」钮之后抽屉可见（${opened}）`);
        await ev(`(document.getElementById('closeToolPaneBtn').focus(), true)`);
        await ev(`(document.getElementById('appSideToggleBtn').click(), true)`);
        await sleep(500);
        const back = await ev(`document.activeElement && document.activeElement.id`);
        ok(back === 'appSideToggleBtn', `H4.6 [${w}] 抽屉里有焦点时收起，焦点还给「右栏」钮（${back}）`);
      }
      // 管家视角的右抽屉（.steward-side）同一套
      await fx.resize(1024, 900);
      await fx.setLens('steward');
      await ev(`(document.querySelector('${rowSel(ids.S)} .steward-board-thread-title')).click(), true`);
      await sleep(900);
      const st = await ev(`(() => { const d = document.querySelector('.steward-side'); if (!d || d.hidden) return null; const cs = getComputedStyle(d); return { vis: cs.visibility, shadow: cs.boxShadow, open: document.getElementById('appFrame').classList.contains('side-open') }; })()`);
      ok(Boolean(st) && st.open === false && st.vis === 'hidden' && st.shadow === 'none', `H4.7 [1024 管家视角] 关着的 .steward-side 同样 visibility:hidden 且无阴影（${JSON.stringify(st)}）`);
      await fx.resize(1280, 900);
    });

    /* ═════════ H5：定时任务表单 ═════════ */
    await phase('H5', async () => {
      await fx.resize(1280, 900);
      await ev(`(document.getElementById('appGearBtn').click(), document.getElementById('openSettingsBtn').click(), true)`);
      await sleep(500);
      await ev(`(document.querySelector('#settingsTabs [data-stab="steward"]').click(), true)`);
      await sleep(600);
      const probe = () => ev(`(() => {
        const f = document.getElementById('cfgStewardScheduleForm'); const d = document.getElementById('cfgStewardScheduleDaysBlock');
        const shown = n => !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0;
        return { formHidden: f.hidden, formShown: shown(f), daysHidden: d.hidden, daysShown: shown(d), leak: [...document.querySelectorAll('[hidden]')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.id || e.className).slice(0, 5) };
      })()`);
      let p = await probe();
      ok(p.formHidden && !p.formShown, `H5.1 表单 hidden 就是不显示（修前 hidden=true 仍 display:grid、600px 高；实测 ${JSON.stringify(p)}）`);
      await ev(`(document.getElementById('cfgStewardScheduleNewBtn').click(), true)`);
      await sleep(300);
      p = await probe();
      ok(!p.formHidden && p.formShown, `H5.2 点「新建」之后表单显示（${JSON.stringify(p)}）`);
      ok(p.daysHidden && !p.daysShown, `H5.3 默认「只这一次」时「星期几」不显示（修前 hidden=true 仍 display:flex；${JSON.stringify(p)}）`);
      await ev(`(() => { const s = document.getElementById('cfgStewardScheduleKind'); s.value = 'weekly'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await sleep(200);
      p = await probe();
      ok(!p.daysHidden && p.daysShown, `H5.4 选「每周」之后「星期几」才显示（${JSON.stringify(p)}）`);
      ok(p.leak.length === 0, `H5.5 此刻没有「hidden 却在显示」的元素（${JSON.stringify(p.leak)}）`);
      await ev(`(document.getElementById('cfgStewardScheduleCancelBtn').click(), true)`);
      await sleep(300);
      p = await probe();
      ok(p.formHidden && !p.formShown, `H5.6 点「取消」之后表单收回（${JSON.stringify(p)}）`);
      // M5：定时任务权限下拉的顺序与盾牌一致（默认／改文件不问／只做计划／智能自动）
      const order = await ev(`[...document.querySelectorAll('#cfgStewardSchedulePermission option')].map(o => o.value)`);
      ok(JSON.stringify(order) === JSON.stringify(['', 'default', 'acceptEdits', 'plan', 'auto']), `M5.1 定时任务权限下拉顺序 = 跟随全局／每步都问／改文件不问／只做计划／智能自动（${JSON.stringify(order)}）`);
    });

    /* ═════════ H6：≤640 设置页签条 ═════════ */
    await phase('H6', async () => {
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        for (const w of [390, 500, 640]) {
          await fx.resize(w, 900);
          await sleep(300);
          await ev(`(document.querySelector('#settingsTabs [data-stab="basic"]').click(), true)`);
          await sleep(300);
          const m = await ev(`(() => {
            const strip = document.getElementById('settingsTabs'); const btns = [...strip.querySelectorAll('button[data-stab]')].filter(b => b.getClientRects().length);
            const rs = btns.map(b => ({ l: b.getBoundingClientRect().left, r: b.getBoundingClientRect().right, w: b.getBoundingClientRect().width, id: b.dataset.stab }));
            const sorted = rs.slice().sort((a, b) => a.l - b.l);
            let overlap = 0; for (let i = 1; i < sorted.length; i++) if (sorted[i].l < sorted[i - 1].r - 1) overlap++;
            return { n: btns.length, overlap, maxW: Math.round(Math.max(...rs.map(x => x.w))), vw: document.documentElement.clientWidth, sw: strip.scrollWidth, cw: strip.clientWidth };
          })()`);
          ok(m.n >= 15 && m.overlap === 0, `H6.1 [${locale} ${w}] 页签条里 ${m.n} 枚页签两两不叠（${m.overlap} 对重叠；修前 241/457px 宽的钮互相压住）`);
          ok(m.maxW <= 300, `H6.2 [${locale} ${w}] 单枚页签宽 ${m.maxW}px 由文字撑开，不是「组宽的百分比」（修前 457）`);
          await ev(`(document.querySelector('#settingsTabs [data-stab="update"]').click(), true)`);
          await sleep(400);
          const vis = await ev(`(() => { const strip = document.getElementById('settingsTabs'); const a = strip.querySelector('button[data-stab].active'); const s = strip.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { id: a.dataset.stab, inView: r.left >= s.left - 1 && r.right <= s.right + 1 }; })()`);
          ok(vis.id === 'update' && vis.inView, `H6.3 [${locale} ${w}] 切到最后一页（${vis.id}）后激活的页签被滚进条的可见区（修前仍停在「基础」）`);
        }
      }
      await fx.resize(1280, 900);
      await ev(`(() => { document.querySelectorAll('#settingsModal [data-close-modal]').forEach(b => b.click()); return true; })()`);
      await sleep(300);
    });

    /* ═════════ M1／M2：390 下对话里的卡片（合成节点，量的是 CSS） ═════════ */
    await phase('M1M2', async () => {
      await fx.resize(390, 900);
      await fx.setLens('classic');
      await sleep(400);
      const m = await ev(`(() => {
        const host = document.getElementById('messages');
        const wrap = document.createElement('div'); wrap.id = 'w3synth'; wrap.style.cssText = 'padding:0 12px';
        wrap.innerHTML = '<details class="subagent-card sa-ok"><summary class="subagent-head"><span class="sa-icon">R</span><span class="sa-title">[n1] 子任务：NODE_A read stuff</span><span class="sa-status ok">✓ 完成 · 8 字结论 · read · fake-model · 依赖 n1</span></summary></details>'
          + '<details class="tool-card"><summary><span class="tc-icon"></span><span class="tc-name">file_write</span><span class="tc-verb">写入文件</span><span class="tc-arg">/tmp/ruyi-w3-chat-xAnLqe/work/report.md</span><span class="tc-dur">· 0.0s</span><span class="tc-status ok">完成</span></summary></details>';
        host.appendChild(wrap);
        document.documentElement.dataset.uiMode = 'simple';
        const title = wrap.querySelector('.sa-title').getBoundingClientRect(); const status = wrap.querySelector('.sa-status').getBoundingClientRect(); const card = wrap.querySelector('.subagent-card').getBoundingClientRect();
        const verb = wrap.querySelector('.tc-verb').getBoundingClientRect(); const verbLH = parseFloat(getComputedStyle(wrap.querySelector('.tc-verb')).lineHeight) || 18;
        const out = { titleW: Math.round(title.width), statusRight: Math.round(status.right), cardRight: Math.round(card.right), verbW: Math.round(verb.width), verbH: Math.round(verb.height), verbLH: Math.round(verbLH) };
        wrap.remove();
        return out;
      })()`);
      ok(m.titleW >= 80, `M1.1 子代理卡片头：标题宽 ${m.titleW}px，不被状态句挤成 0（修前 0）`);
      ok(m.statusRight <= m.cardRight + 1, `M1.2 状态句不被卡片右缘切掉（${m.statusRight} ≤ ${m.cardRight}）`);
      ok(m.verbW >= 40 && m.verbH <= m.verbLH * 1.6, `M2.1 工具卡的人话动词不被挤成一字一行（宽 ${m.verbW}、高 ${m.verbH}；修前 15px 宽、四行）`);
      await fx.resize(1280, 900);
    });

    /* ═════════ M4／M6／M8：英文界面 ═════════ */
    await phase('M4', async () => {
      await fx.resize(1280, 900);
      await setLocale('en-US');
      // ① 新建「自定义」服务商：显示名是英文
      await ev(`(document.getElementById('appGearBtn').click(), document.getElementById('openSettingsBtn').click(), true)`);
      await sleep(500);
      await ev(`(document.querySelector('#settingsTabs [data-stab="providers"]').click(), true)`);
      await sleep(500);
      const card = await ev(`(async () => {
        const sel = document.getElementById('providerPresetSelect'); sel.value = 'openai-compatible'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('addProviderBtn').click();
        await new Promise(r => setTimeout(r, 400));
        const labels = [...document.querySelectorAll('#stab-providers .prov-label')]; const last = labels[labels.length - 1];
        return { name: last.value, n: labels.length };
      })()`);
      ok(!CJK.test(card.name), `M4.1 英文界面新建「自定义」服务商，显示名无中文（「${card.name}」）`);
      // ② M6：「测试连接」的结果紧跟卡头
      const m6 = await ev(`(async () => {
        const labels = [...document.querySelectorAll('#stab-providers .prov-label')]; const last = labels[labels.length - 1]; const cardEl = last.closest('.prov-card');
        const btn = [...cardEl.querySelectorAll('button')].find(b => /test connection/i.test(b.textContent)); btn.click();
        await new Promise(r => setTimeout(r, 400));
        const st = cardEl.querySelector('[id^=provStatus_]'); const c = cardEl.getBoundingClientRect(); const s = st.getBoundingClientRect();
        return { text: st.textContent, fromTop: Math.round(s.top - c.top), cardH: Math.round(c.height) };
      })()`);
      ok(/base URL/i.test(m6.text) && m6.fromTop >= 0 && m6.fromTop <= 140, `M6.1 「测试连接」的结果紧跟卡头（距卡顶 ${m6.fromTop}px，卡高 ${m6.cardH}px；修前在卡底 ~880px；「${m6.text}」）`);
      await ev(`(() => { document.querySelectorAll('#settingsModal [data-close-modal]').forEach(b => b.click()); return true; })()`);
      await sleep(300);
      // ③ 左栏「等你放行」按语言重拼（真实一条权限待决；预览行只留前 22 字，全句在药丸的悬停提示里）
      await fx.setLens('steward');
      const asks = await waitFor(`(() => { const li = document.querySelector('${rowSel(ids.P)}'); if (!li) return null; const sub = li.querySelector('.steward-board-sub'); const pill = li.querySelector('.is-asks-you'); return sub && pill && /^Waiting for your/.test(sub.textContent) ? { sub: sub.textContent, title: pill.title } : null; })()`, 500);
      ok(Boolean(asks) && !CJK.test(asks.sub), `M4.2 英文界面左栏「等你放行」那一行是英文（「${asks && asks.sub}」；修前「等你放行:写入文件…」）`);
      ok(Boolean(asks) && /report\.md/.test(asks.title) && !CJK.test(asks.title.replace(/report\.md/g, '')), `M4.3 药丸悬停提示是整句英文并点名 report.md（「${asks && asks.title}」）`);
      // ④ 纯函数口径：缺字段退回服务端原句
      const pure = await ev(`import('/js/thread-facts.js').then(async m => { const i = await import('/js/i18n.js'); return { en: m.stewardAskText({ kind: 'permission', toolName: 'file_write', target: 'a.txt', text: '等你放行:写入文件「a.txt」' }, i.t), old: m.stewardAskText({ kind: 'permission', text: '等你放行:xx' }, i.t), q: m.stewardAskText({ kind: 'question', text: '要等吗?' }, i.t) }; })`);
      ok(pure.en === 'Waiting for your approval: Write file “a.txt”', `M4.4 stewardAskText：英文拼成「${pure.en}」`);
      ok(pure.old === '等你放行:xx' && pure.q === '要等吗?', 'M4.5 缺 toolName/target（老服务端）与 question 原样退回服务端原句');
      // ⑤ 子代理进度：服务端带 noteCode，前端词表两种语言都有
      const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      ok(/noteCode: 'streaming'/.test(server) && /noteCode: 'init'/.test(server) && /noteCode: 'generating'/.test(server), 'M4.6 服务端三处 subagent_progress 都带 noteCode');
      for (const code of ['init', 'streaming', 'generating', 'kimiRunning', 'kimiRunningFor', 'kimiPaused', 'kimiPausedWaiting']) {
        const key = `chat.subagent.note.${code}`;
        ok(typeof EN[key] === 'string' && !CJK.test(EN[key]) && typeof ZH[key] === 'string', `M4.7 词表有 ${key}（en 无中文）`);
      }
      // M8：线程头 chip 的值不收成 0 宽（英文 1280、右栏开着）；390 下管家条复选框有可见文字
      await fx.setLens('classic');
      await ev(`(document.querySelector('${rowSel(ids.S)} .steward-board-thread-title') || {click(){}}).click(), true`);
      await sleep(900);
      const chips = await ev(`[...document.querySelectorAll('#threadChips .steward-chip-value')].map(n => Math.round(n.getBoundingClientRect().width))`);
      ok(chips.length >= 3 && chips.every(w => w >= 24), `M8.1 [en 1280] 线程头三枚 chip 的值都有宽度（${JSON.stringify(chips)}；修前 Engine 的值 0 宽）`);
      await fx.resize(390, 900);
      await sleep(500);
      const band = await ev(`(() => { const s = document.querySelector('#threadStewardBand .th-steward-toggle > span'); if (!s) return null; const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      ok(Boolean(band) && band.w >= 40 && band.h >= 8, `M8.2 [en 390] 管家条的复选框有可见文字（${JSON.stringify(band)}；修前 1×1 的屏读文字）`);
      await fx.resize(1280, 900);
      await setLocale('zh-CN');
    });

    /* ═════════ M5：英文向导的档名 ═════════ */
    await phase('M5', async () => {
      ok(EN['onboarding.wizard.safety.default.title'] === 'Ask me every step', `M5.2 英文向导「每步都问」叫 Ask me every step（${EN['onboarding.wizard.safety.default.title']}）`);
      ok(EN['onboarding.wizard.safety.acceptEdits.title'] === 'Edit files without asking', `M5.3 英文向导「改文件不问」叫 Edit files without asking（${EN['onboarding.wizard.safety.acceptEdits.title']}）`);
      ok(EN['onboarding.wizard.safety.plan.title'] === 'Plan only', 'M5.4 Plan only');
      ok(!/Ask me every time/.test(EN['onboarding.wizard.safety.hint']), `M5.5 向导提示句也跟着改了（${EN['onboarding.wizard.safety.hint']}）`);
      ok(!/bypass/i.test(EN['settings.permissionBridge']) && !/bypass/i.test(ZH['settings.permissionBridge']), 'M5.6 「权限弹窗桥接」那句不再说 bypass，改说「全自动」档');
      ok(/全自动/.test(ZH['settings.permissionBridge']) && /Fully automatic/.test(EN['settings.permissionBridge']), 'M5.7 中英文都点名「全自动 / Fully automatic」');
    });
  } catch (error) {
    t.fail(`fatal: ${error && error.stack || error}`);
  } finally {
    releaseHolds();
    if (fx) {
      ok(fx.exceptions.length === 0, `Z1 页面没有未捕获异常（${JSON.stringify(fx.exceptions.slice(0, 3))}）`);
      await fx.close();
    }
  }
  t.done({ exit: true });
})();
