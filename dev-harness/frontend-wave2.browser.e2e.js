#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 第二波前端走查修复（W2-frontend）的真浏览器回归。快通道（纯函数／静态契约）在 dev-harness/unit/frontend-w2-fixes.test.js。
//
//   F1  管家左栏：行上「N 分钟前」换字不再整行重建（节点不换、键盘焦点还在标题按钮上）；真被重建（组折叠换了组头、行改名）时
//       焦点在新节点上还原，不掉回 body；
//   F2  工作台线程头：任何宽度、中英文下，线程头里的控件互不覆盖、线程名不被压成 0、药丸里的内容不溢出自己；窄了先收管家话；
//   F3  ≤640：线程头不再整体溢出被裁（修前 .topbar 的通用 flex-wrap 把 column 容器的两行撑到 989px），
//       上下文量表／工作文件夹／工具开关／管家开关 390 宽下都在视口里够得着；
//   F4  回合进行中打字：「插话方式」下拉不再把输入框压成 5px；发送后输入框高度不再停在窄宽时量到的值（宽度变了会重量）；
//   F5  英文界面左栏行与抽屉的「等待原因」不印服务端中文；
//   F7a 「管家」设置页记忆／决策两块的空态切语言后跟着换；
//   F8  英文设置导航组头不被裁（换行）；
//   F9  左栏「它在问你」行悬停不再变高（「⋯」出流，不再把自己折到下一行）；
//   F10 附件「上传中…」占位有 ×：点了就中止、占位撤掉、发送不再被拦；换线程（清场）时在飞上传作废、不落进新线程；
//   K   Ctrl+K 只开命令面板（焦点在面板输入框，不在左栏搜索框）；帮助弹窗的快捷键表有 Ctrl+` 与 Ctrl+Enter；
//   M   记忆检索回执：零命中的规则补位另说一句「另补入默认规则 N 条」，「匹配 N 条」只数真命中。
//
// 反向验证（先破坏、看真红、再还原；不在本件里自动做 —— 会把生产文件写脏）已逐组在本机独立跑过，记在提交说明里。
// 判定行：`FRONTEND WAVE2 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('FRONTEND WAVE2 BROWSER');
const { ok } = t;
const LOCALES = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales');
const ZH = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en-US.json'), 'utf8'));
const CJK = /[\u3400-\u9fff]/;

// 确定性 provider：ASKME → 一条单选 request_user_input（线程停在「等你」）；HOLD → 先说半句、等放行再说完；MEMO → 一句话；其余「好。」。
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

const ids = {};
const rowSel = id => `#railList li.steward-board-thread[data-session-id="${id}"]`;
const HEAD_WIDTHS = [390, 480, 560, 640, 760, 900, 1024, 1180, 1280, 1440, 1920];

// 线程头探针：控件互不覆盖／线程名宽／必须够得着的控件在视口里／没有横向溢出（每一项都是「坏的数量」，全 0 才算好）。
const HEAD_PROBE = `(() => {
  const head = document.querySelector('.thread-head');
  const vw = document.documentElement.clientWidth;
  const vis = n => n && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const items = [...head.querySelectorAll('button, input, select, [role=button], #sessionTitle, #threadState')].filter(vis);
  const nm = n => (n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + String(n.className).slice(0, 14));
  const over = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
    if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 2 && h > 2) over.push(nm(items[i]) + ' x ' + nm(items[j]) + ' (' + Math.round(w) + 'px)');
  }
  const must = ['#contextMeter', '#workspacePicker', '#toggleToolsBtn', '#threadStewardWatch', '#threadBackToStewardBtn'].map(s => {
    const n = document.querySelector(s); if (!n) return s + ':缺';
    const r = n.getBoundingClientRect();
    return (r.width && r.left >= -1 && r.right <= vw + 1) ? null : s + '@' + Math.round(r.left) + '-' + Math.round(r.right);
  }).filter(Boolean);
  const title = head.querySelector('.topbar-title'), strong = document.getElementById('sessionTitle'), pill = head.querySelector('.th-steward');
  const tr = title.getBoundingClientRect(), sr = strong.getBoundingClientRect();
  const rows = [...head.querySelectorAll('.th-row')];
  return {
    vw, headW: head.clientWidth, h: Math.round(head.getBoundingClientRect().height), over, must,
    titleW: Math.round(tr.width), titleSpill: sr.right > tr.right + 1, headOverflow: head.scrollWidth > head.clientWidth + 1,
    rowOverflow: rows.filter(r => r.scrollWidth > r.clientWidth + 1).length, pillClip: pill.scrollWidth > pill.clientWidth + 1,
    textShown: Boolean(vis(head.querySelector('.th-steward-text'))), docOverflow: document.documentElement.scrollWidth > vw,
  };
})()`;

function fireAndForget(fx, pathname, body) {
  const raw = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: fx.appPort, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': fx.token, 'content-length': Buffer.byteLength(raw) } }, res => res.resume());
  req.on('error', () => {});
  req.write(raw); req.end();
}

(async () => {
  let fx = null;
  // W2_PHASES=F4,K 只跑点名的几组（本机迭代用；全跑是默认，CI 不设）。
  const only = String(process.env.W2_PHASES || '').split(',').filter(Boolean);
  const phase = async (name, fn) => {
    if (only.length && !only.some(p => name.startsWith(p))) return;
    try { await fn(); } catch (error) { t.fail(`${name} 未预期异常：${error && error.stack || error}`); }
  };
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-frontend-wave2-', width: 1280, height: 900, provider: script,
      // 无头浏览器默认报 (hover: none)（走触屏那套常显规则）；本件量的是桌面的悬停行为，所以声明「有鼠标」。触屏那一支用 CDP 触控模拟单测。
      browserArgs: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
      prepare: async f => {
        const make = async title => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await f.request('POST', '/api/sessions', { title, cwd: f.work }, 120000);
            if (r && r.json && r.json.session && r.json.session.id) return r.json.session.id;
          }
          return '';
        };
        ids.A = await make('线程甲');
        ids.B = await make('线程乙');
        ids.C = await make('线程丙');
        ids.H = await make('线程头那条');
        ids.Q = await make('等你拍板那条');
        ok(Object.values(ids).every(Boolean), `F0f 五条线程都建出来了（${JSON.stringify(ids)}）`);
        await f.request('POST', '/api/chat/stream', { sessionId: ids.H, message: '你好', cwd: f.work }, 300000);   // 线程头那条跑过一轮：五态药丸、上下文量表都在
      },
    });
    const ev = expression => fx.evaluate(expression);
    const waitFor = (expression, attempts) => fx.waitForEval(expression, attempts);
    const setLocale = async locale => {
      await ev(`import('/js/i18n.js').then(m => m.setLocale('${locale}')).then(() => document.documentElement.lang)`);
      await sleep(500);
    };
    // 键盘焦点只有页面「有焦点」时才稳：无头浏览器里补一发 Emulation，免得 document.hasFocus()=false 时 activeElement 行为漂移。
    try { await fx.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 旧内核没有就算了 */ }

    /* ═════════ F1：管家左栏焦点 ═════════ */
    await phase('F1', async () => {
      ok(Boolean(await fx.setLens('steward')), 'F1.0 管家视角');
      ok(Boolean(await waitFor(`[${[ids.A, ids.B, ids.C].map(id => `'${id}'`)}].every(id => document.querySelector('#railList li.steward-board-thread[data-session-id="' + id + '"]')) ? 1 : null`, 600)),
        'F1.1 左栏三条线程都画出来了');
      await sleep(1500);   // 开机那几发（首趟取行、在场回执）落定
      const rowTitle = id => `${rowSel(id)} .steward-board-thread-title`;
      const metaOf = id => ev(`(() => { const m = document.querySelector('${rowSel(id)} .steward-board-meta'); return m ? m.textContent : null; })()`);
      const before = await metaOf(ids.A);
      ok(typeof before === 'string' && before.length > 0, `F1.2 线程甲行右侧有一句时间（「${before}」）`);
      ok(await ev(`(() => {
        for (const id of ['${ids.A}', '${ids.B}']) { const li = document.querySelector('#railList li.steward-board-thread[data-session-id="' + id + '"]'); li.__w2 = 1; li.querySelector('.steward-board-thread-title').__w2 = 1; }
        const b = document.querySelector('${rowTitle(ids.A)}'); b.focus(); return document.activeElement === b;
      })()`), 'F1.3 焦点放在线程甲的标题按钮上');
      // 把时间拨快 10 分钟再触发一拍（与 steward-shell-wave1 的 S-03 同款：行没变、304，左栏按此刻重算时间）。
      await ev(`(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 10 * 60 * 1000; return true; })()`);
      try {
        await ev(`document.dispatchEvent(new Event('visibilitychange')), true`);
        const moved = await waitFor(`(() => { const m = document.querySelector('${rowSel(ids.A)} .steward-board-meta'); return m && m.textContent !== ${JSON.stringify(before)} ? m.textContent : null; })()`, 250);
        ok(Boolean(moved), `F1.4 时间标签换了字（「${before}」→「${moved}」）`);
        const state = await ev(`(() => {
          const a = document.querySelector('${rowSel(ids.A)}'), b = document.querySelector('${rowSel(ids.B)}');
          const active = document.activeElement;
          return {
            sameRowA: Boolean(a && a.__w2 === 1), sameRowB: Boolean(b && b.__w2 === 1), sameTitle: Boolean(a && a.querySelector('.steward-board-thread-title').__w2 === 1),
            activeIsTitle: Boolean(active && active.classList && active.classList.contains('steward-board-thread-title') && a && a.contains(active)),
            activeTag: active ? active.tagName + '.' + String(active.className).slice(0, 30) : null,
            title: (a.querySelector('.steward-board-meta') || {}).title || '',
          };
        })()`);
        ok(state.sameRowA && state.sameRowB && state.sameTitle,
          `F1.5 只换字、不重建：两行与标题按钮都还是原来的节点（修前整行重建；实测 ${JSON.stringify(state)}）`);
        ok(state.activeIsTitle, `F1.6 键盘焦点还在线程甲的标题按钮上（修前被拔回 BODY；实测 ${state.activeTag}）`);
        ok(state.title.indexOf(String(moved)) >= 0, `F1.7 悬停提示跟着换了（「${state.title}」）`);

        // 真被重建的路径 ①：组头折叠（headSig 变 → 组头重建）—— 用真键盘 Enter 按下去，焦点要在新组头按钮上。
        const group = await ev(`(() => {
          const li = document.querySelector('${rowSel(ids.A)}'); const sec = li.closest('.rail-group'); const toggle = sec.querySelector('.rail-gh-toggle');
          toggle.__old = 1; toggle.focus(); return { key: sec.dataset.group, ok: document.activeElement === toggle };
        })()`);
        ok(group.ok, `F1.8 焦点放在「${group.key}」组头的折叠按钮上`);
        await fx.enter();
        const folded = await waitFor(`(() => { const sec = document.querySelector('#railList .rail-group[data-group="${group.key}"]'); const t = sec && sec.querySelector('.rail-gh-toggle'); return t && t.getAttribute('aria-expanded') === 'false' ? { rebuilt: !t.__old, focused: document.activeElement === t } : null; })()`, 150);
        ok(Boolean(folded) && folded.rebuilt === true, `F1.9 组头真的被重建了（本断言保证 F1.10 有证明力；实测 ${JSON.stringify(folded)}）`);
        ok(Boolean(folded) && folded.focused === true, 'F1.10 重建之后焦点在新的组头按钮上（修前掉回 BODY）');
        await fx.enter();   // 再展开
        ok(Boolean(await waitFor(`(() => { const t = document.querySelector('#railList .rail-group[data-group="${group.key}"] .rail-gh-toggle'); return t && t.getAttribute('aria-expanded') === 'true' && document.activeElement === t ? 1 : null; })()`, 150)),
          'F1.11 再按一次展开，焦点仍在组头按钮上');

        // 真被重建的路径 ②：切语言（railStamp 变了 → 整栏的件全部重建），焦点要在新行的标题按钮上。
        await ev(`(() => { const b = document.querySelector('${rowTitle(ids.B)}'); b.focus(); window.__oldLi = document.querySelector('${rowSel(ids.B)}'); return document.activeElement === b; })()`);
        await setLocale('en-US');
        const switched = await waitFor(`(() => { const li = document.querySelector('${rowSel(ids.B)}'); const b = li && li.querySelector('.steward-board-thread-title'); return li && li !== window.__oldLi ? { rebuilt: !window.__oldLi.isConnected, focused: document.activeElement === b } : null; })()`, 250);
        ok(Boolean(switched) && switched.rebuilt === true, `F1.12 切语言之后整行被重建了（证明力；实测 ${JSON.stringify(switched)}）`);
        ok(Boolean(switched) && switched.focused === true, 'F1.13 行被重建之后焦点在新行的标题按钮上（修前掉回 BODY）');
        await setLocale('zh-CN');
      } finally { await ev(`(() => { if (window.__realNow) Date.now = window.__realNow; return true; })()`); }
    });

    /* ═════════ F2／F3：工作台线程头 ═════════ */
    await phase('F2F3', async () => {
      ok(Boolean(await fx.setLens('classic')), 'F2.0 工作台视角');
      await ev(`(() => { const b = document.querySelector('${rowSel(ids.H)} .steward-board-thread-title'); if (b) b.click(); return true; })()`);
      ok(Boolean(await waitFor(`(() => { const band = document.getElementById('threadStewardBand'); const id = window.state && window.state.currentSession && window.state.currentSession.id; return band && !band.hidden && id === '${ids.H}' ? 1 : null; })()`, 400)),
        'F2.1 打开线程头那条，管家条出来了');
      for (const locale of ['zh-CN', 'en-US']) {
        await setLocale(locale);
        const bad = [];
        const seen = [];
        let shown1920 = null, shownNarrow = null;
        for (const width of HEAD_WIDTHS) {
          await fx.resize(width, 900);
          await sleep(200);
          const r = await ev(HEAD_PROBE);
          seen.push(`${width}:${r.headW}/${r.titleW}`);
          const problems = [];
          if (r.over.length) problems.push('控件互相覆盖 ' + r.over.join('; '));
          if (r.must.length) problems.push('够不着 ' + r.must.join(','));
          if (r.titleW < 80) problems.push('线程名被压成 ' + r.titleW + 'px');
          if (r.titleSpill) problems.push('线程名溢出自己的盒');
          if (r.headOverflow || r.docOverflow) problems.push('线程头／页面横向溢出');
          if (r.rowOverflow) problems.push(r.rowOverflow + ' 行内容溢出行');
          if (r.pillClip) problems.push('管家条内容溢出药丸自己');
          if (problems.length) bad.push(`${width}（头宽 ${r.headW}）：${problems.join(' | ')}`);
          if (width === 1920) shown1920 = r.textShown;
          if (width === 390) shownNarrow = r.textShown;
          if (width === 390) ok(r.h <= 230, `F3.${locale} 390 宽线程头高 ${r.h}px（两行各自允许再换一行，仍可控）`);
        }
        ok(bad.length === 0, `F2.${locale} ${HEAD_WIDTHS.length} 个宽度下线程头都不覆盖、不溢出、线程名不被压没、关键控件都够得着（头宽/线程名宽 ${seen.join(' ')}）${bad.length ? '；坏的：' + bad.join(' ‖ ') : ''}`);
        ok(shown1920 === true && shownNarrow === false, `F2.${locale}b 宽的时候管家话照常显示、窄的时候收起（1920：${shown1920}；390：${shownNarrow}）`);
      }
      // 收起文字之后控件的可访问名一个不少：开关的字还在 DOM 里（读屏读得到），悬停有 title，「回到管家」按钮有 aria-label。
      await fx.resize(1280, 900);
      await sleep(300);
      const names = await ev(`(() => {
        const label = document.querySelector('.th-steward-toggle'); const back = document.getElementById('threadBackToStewardBtn');
        return { toggleText: label.textContent.trim(), toggleTitle: label.title, backAria: back.getAttribute('aria-label') || '', backTitle: back.title };
      })()`);
      ok(names.toggleText === EN['threadHead.watch'] && names.toggleTitle === EN['threadHead.watch'] && names.backAria === EN['threadHead.backToSteward'] && names.backTitle === EN['threadHead.backToSteward'],
        `F2.names 窄档把字收起后可访问名与悬停提示都在（${JSON.stringify(names)}）`);
      await setLocale('zh-CN');
      await fx.resize(1280, 900);
    });

    /* ═════════ F4：回合进行中的插话下拉与输入框 ═════════ */
    await phase('F4', async () => {
      ok(Boolean(await fx.setLens('classic')), 'F4.0 工作台视角');
      await fx.resize(1280, 900);
      const cycle = async (locale) => {
        await setLocale(locale);
        await ev(`(() => { const ta = document.getElementById('promptInput'); ta.value = 'HOLD 一'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
        ok(Boolean(await waitFor(`window.state && window.state.streaming ? 1 : null`, 300)), `F4.${locale}.1 回合在跑（被 HOLD 住）`);
        await ev(`(() => { const ta = document.getElementById('promptInput'); ta.value = '${locale === 'zh-CN' ? '插话一二三' : 'one more thing'}'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        ok(Boolean(await waitFor(`(() => { const s = document.getElementById('steerDeliveryMode'); return s && !s.hidden ? 1 : null; })()`, 200)), `F4.${locale}.2 打字之后「插话方式」下拉出现了`);
        await sleep(300);
        const m = await ev(`(() => {
          const rect = s => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) }; };
          const box = document.querySelector('.composer-box');
          return { ta: rect('#promptInput'), sel: rect('#steerDeliveryMode'), send: rect('#sendBtn'), boxOverflow: box.scrollWidth > box.clientWidth + 1, boxH: Math.round(box.getBoundingClientRect().height) };
        })()`);
        ok(m.ta && m.ta.w >= 150, `F4.${locale}.3 输入框宽 ${m.ta && m.ta.w}px ≥ 150（修前右栏开着的 1280 下是 5px）`);
        // 一行放得下就在同一行（下拉在输入框与发送钮之间）；放不下就折成两行（输入框独占一行、下拉与发送在下一行），两种都不许互相覆盖。
        const sameRow = m.ta.y !== undefined && Math.abs((m.sel.y + m.sel.h / 2) - (m.ta.y + m.ta.h / 2)) < 20;
        const noOverlap = a => b => a.r <= b.x + 1 || b.r <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1;
        ok(m.sel && m.sel.w >= 70 && m.sel.w <= 260 && noOverlap(m.ta)(m.sel) && noOverlap(m.ta)(m.send) && noOverlap(m.sel)(m.send)
          && m.sel.r <= m.send.x + 1 && Math.abs((m.sel.y + m.sel.h / 2) - (m.send.y + m.send.h / 2)) < 20,
          `F4.${locale}.4 下拉与发送钮同一行、在发送钮左边，输入框与它们不重叠（${sameRow ? '一行' : '折成两行'}；${JSON.stringify(m)}）`);
        ok(m.boxOverflow === false, `F4.${locale}.5 输入胶囊没有横向溢出（胶囊高 ${m.boxH}px；${JSON.stringify(m)}；${JSON.stringify(await ev(`(() => { const b = document.querySelector('.composer-box'); const a = b.querySelector('.composer-actions'); return { boxClient: b.clientWidth, boxScroll: b.scrollWidth, actions: a.getBoundingClientRect().width, actionsScroll: a.scrollWidth, kids: [...a.children].filter(n => n.getClientRects().length).map(n => (n.id || n.className) + ':' + Math.round(n.getBoundingClientRect().width)) }; })()`))}）`);
        // 发送（插话）之后：输入清空、下拉收起、输入框高度回到单行（修前停在窄宽时量到的 144px）。
        await ev(`document.getElementById('sendBtn').click(), true`);
        ok(Boolean(await waitFor(`document.getElementById('promptInput').value === '' ? 1 : null`, 200)), `F4.${locale}.6 插话发出，输入框清空`);
        await sleep(400);
        const after = await ev(`({ h: parseFloat(document.getElementById('promptInput').style.height) || 0, hidden: document.getElementById('steerDeliveryMode').hidden })`);
        ok(after.hidden === true && after.h > 0 && after.h <= 60, `F4.${locale}.7 发送之后下拉收起、输入框高度 ${after.h}px 回到单行（修前 144px）`);
        releaseHolds();
        ok(Boolean(await waitFor(`window.state && !window.state.streaming ? 1 : null`, 400)), `F4.${locale}.8 放行之后回合收尾（${JSON.stringify(await ev(`({ streaming: window.state.streaming, msgs: [...document.querySelectorAll('#messages .message')].slice(-3).map(n => n.textContent.slice(0, 40)) })`))}）`);
      };
      await cycle('zh-CN');
      await cycle('en-US');
      await setLocale('zh-CN');
      // 宽度变了要重量：先在窄宽下把输入框撑成多行，再放宽 —— 不再有任何 input 事件，高度也要自己收回单行。
      const regrow = await ev(`(async () => {
        const ta = document.getElementById('promptInput');
        ta.style.flex = 'none'; ta.style.minWidth = '0'; ta.style.width = '70px';
        ta.value = 'aaaa bbbb cccc dddd';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const narrow = parseFloat(ta.style.height) || 0;
        ta.style.flex = ''; ta.style.minWidth = ''; ta.style.width = '';
        await new Promise(resolve => setTimeout(resolve, 400));
        const wide = parseFloat(ta.style.height) || 0;
        ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
        return { narrow, wide, w: Math.round(ta.getBoundingClientRect().width) };
      })()`);
      ok(regrow.narrow > 60 && regrow.wide < regrow.narrow && regrow.wide <= 30,
        `F4.9 输入框变宽后高度自己重量（窄宽 ${regrow.narrow}px → 放宽后 ${regrow.wide}px，中间没有任何 input 事件；宽 ${regrow.w}px）`);
    });

    /* ═════════ F7a／F8：设置页 ═════════ */
    await phase('F7aF8', async () => {
      await setLocale('zh-CN');
      await fx.resize(1280, 900);
      ok(Boolean(await waitFor(`window.state && window.state.config && window.state.config.stewardEnabledV1 === true ? 1 : null`, 300)), 'F7.0 管家开着（前端手上的配置读得到；机器忙时 /api/status 偶尔晚到，先等它）');
      await ev(`document.querySelector('.rail-pocket-item[data-pocket="memory"]').click(), true`);
      ok(Boolean(await waitFor(`(() => { const m = document.getElementById('settingsModal'); return m && !m.classList.contains('hidden') ? 1 : null; })()`, 300)), 'F7.1 口袋「记得的关于你」打开了设置弹层');
      const empties = () => ev(`({ memory: (document.querySelector('.steward-memory-empty') || {}).textContent || null, decisions: (document.querySelector('.steward-decisions-empty') || {}).textContent || null })`);
      ok(Boolean(await waitFor(`document.querySelector('.steward-memory-empty') && document.querySelector('.steward-decisions-empty') ? 1 : null`, 300)), 'F7.2 记忆与决策两块都画出了空态');
      const zhNow = await empties();
      ok(zhNow.memory === ZH['settings.steward.memory.empty'] && zhNow.decisions === ZH['settings.steward.decisions.empty'], `F7.3 中文空态（${JSON.stringify(zhNow)}；enabled=${await ev(`String(window.state.config.stewardEnabledV1)`)}）`);
      await setLocale('en-US');
      const enNow = await empties();
      ok(enNow.memory === EN['settings.steward.memory.empty'] && enNow.decisions === EN['settings.steward.decisions.empty'],
        `F7.4 运行时切到英文：两句空态跟着换（修前一直是中文；实测 ${JSON.stringify(enNow)}）`);
      await setLocale('zh-CN');
      const zhBack = await empties();
      ok(zhBack.memory === ZH['settings.steward.memory.empty'] && zhBack.decisions === ZH['settings.steward.decisions.empty'], 'F7.5 切回中文再换回来');

      // F8：英文下设置导航的组头不被裁（逐个比 scrollWidth 与 clientWidth）。
      await setLocale('en-US');
      await ev(`(() => { const b = document.querySelector('#settingsTabs .settings-nav-label[data-group="integrations"]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
      await sleep(300);
      const probeLabels = () => ev(`[...document.querySelectorAll('#settingsTabs .settings-nav-label')].map(b => { const span = b.querySelector('span:not(.settings-nav-chevron)'); const r = span.getBoundingClientRect(); const nav = b.getBoundingClientRect(); return { text: b.textContent.trim(), clipped: b.scrollWidth > b.clientWidth + 1 || r.right > nav.right + 0.5, sw: b.scrollWidth, cw: b.clientWidth, ws: getComputedStyle(b).whiteSpace }; })`);
      let labels = [];
      const clippedAt = [];
      for (const width of [1280, 1024, 900, 760]) {
        await fx.resize(width, 900);
        labels = await probeLabels();
        for (const l of labels.filter(x => x.clipped)) clippedAt.push(`${width}:${l.text}:${l.sw}/${l.cw}`);
      }
      await fx.resize(1280, 900);
      ok(labels.length >= 5 && clippedAt.length === 0, `F8.1 英文设置导航的 ${labels.length} 个组头在 1280／1024／900／760 宽下都没被裁（被裁的：${JSON.stringify(clippedAt)}）`);
      ok(labels.every(l => l.ws === 'normal'), 'F8.2 组头允许折行（white-space: normal）');
      await ev(`(() => { const b = document.querySelector('#settingsModal [data-close-modal]'); if (b) b.click(); return true; })()`);
      await setLocale('zh-CN');
    });

    /* ═════════ F5／F9：「等你」行的等待说明与悬停 ═════════ */
    await phase('F5F9', async () => {
      // 「等你」线程到这一组才起（弹层会盖住别组的页面操作，所以放在最后几组之前、用完收起）。
      fireAndForget(fx, '/api/chat/stream', { sessionId: ids.Q, message: 'ASKME 问我', cwd: fx.work });
      ok(Boolean(await waitFor(`(() => { const r = document.querySelector('${rowSel(ids.Q)}'); return r && r.querySelector('.steward-board-pill.is-asks-you') ? 1 : null; })()`, 600)),
        'F5.0 等你拍板那条出现在左栏，带「它在问你」');
      await fx.resize(1280, 900);
      const waitText = () => ev(`(() => { const w = document.querySelector('${rowSel(ids.Q)} .steward-board-wait'); return w ? w.textContent : null; })()`);
      ok((await waitText()) === ZH['stewardShell.wait.needsYou'].replace('{{n}}', '1'), `F5.1 中文界面：等待说明是「等你(1 条待决)」（实测「${await waitText()}」）`);
      await setLocale('en-US');
      ok(Boolean(await waitFor(`(() => { const w = document.querySelector('${rowSel(ids.Q)} .steward-board-wait'); return w && w.textContent === ${JSON.stringify(EN['stewardShell.wait.needsYou'].replace('{{n}}', '1'))} ? 1 : null; })()`, 200)),
        `F5.2 切到英文：左栏行的等待说明是「${EN['stewardShell.wait.needsYou'].replace('{{n}}', '1')}」，一个中文字都没有（实测「${await waitText()}」）`);

      // F9：悬停这一行，行高一个像素不变；「⋯」出现且在行头右端；时间被它让位（visibility，仍占位）。
      // 问题弹层此刻盖在整页上（鼠标够不着左栏）：Esc 是「收进右下角小窗」，先收起来。
      for (let i = 0; i < 3 && await ev(`Boolean(document.querySelector('.modal-backdrop.ask-modal:not(.hidden)'))`); i++) { await fx.escape(); await sleep(300); }
      const geo = () => ev(`(() => {
        const li = document.querySelector('${rowSel(ids.Q)}'); const b = li.getBoundingClientRect();
        const more = li.querySelector('.steward-board-more'); const meta = li.querySelector('.steward-board-thread-head > .steward-board-meta');
        const cs = more ? getComputedStyle(more) : null;
        return { h: Math.round(b.height), cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2), moreShown: Boolean(cs && cs.display !== 'none' && more.getClientRects().length), morePos: cs && cs.position,
          metaVis: meta ? getComputedStyle(meta).visibility : null };
      })()`);
      const idle = await geo();
      await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: idle.cx, y: idle.cy });
      await sleep(500);
      const hover = await geo();
      ok(idle.h === hover.h && idle.h > 0, `F9.1 悬停前后行高不变（${idle.h}px → ${hover.h}px；修前 98 → 126）`);
      ok(idle.moreShown === false && hover.moreShown === true && hover.morePos === 'absolute', `F9.2 悬停才出现「⋯」，且是出流定位（${idle.moreShown} → ${hover.moreShown}；position=${hover.morePos}）`);
      ok(idle.metaVis === 'visible' && hover.metaVis === 'hidden', `F9.3 悬停时右端那句时间让位给「⋯」（${idle.metaVis} → ${hover.metaVis}）`);
      await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
      // 触屏（hover:none）：没有悬停这回事，「⋯」常显、仍占流内位置（不盖时间）。
      await fx.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await sleep(400);
      const touch = await geo();
      const touchMq = await ev(`matchMedia('(hover: none)').matches`);
      ok(touchMq === true && touch.moreShown === true && touch.morePos === 'static' && touch.metaVis === 'visible',
        `F9.4 触屏（hover:none）：「⋯」常显、仍在流内、时间不被盖（${JSON.stringify({ touchMq, ...touch })}）`);
      await fx.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await sleep(300);

      // F5 抽屉：管家视角里点这一行，抽屉「在等什么」也是英文。
      ok(Boolean(await fx.setLens('steward')), 'F5.3 管家视角');
      await ev(`(() => { const b = document.querySelector('${rowSel(ids.Q)} .steward-board-thread-title'); if (b) b.click(); return true; })()`);
      ok(Boolean(await waitFor(`(() => { const d = document.getElementById('stewardDrawerActivityWaiting'); return d && d.textContent && d.textContent !== ${JSON.stringify(EN['stewardShell.drawer.none'])} ? 1 : null; })()`, 400)),
        'F5.4 抽屉的三问「在等什么」有内容了');
      const drawerWait = await ev(`document.getElementById('stewardDrawerActivityWaiting').textContent`);
      ok(drawerWait === EN['stewardShell.wait.needsYou'].replace('{{n}}', '1') && !CJK.test(drawerWait), `F5.5 抽屉「在等什么」是英文「${drawerWait}」，没有中文`);
      await setLocale('zh-CN');
      ok(Boolean(await waitFor(`(() => { const d = document.getElementById('stewardDrawerActivityWaiting'); return d && d.textContent === ${JSON.stringify(ZH['stewardShell.wait.needsYou'].replace('{{n}}', '1'))} ? 1 : null; })()`, 300)),
        'F5.6 切回中文，抽屉说回「等你(1 条待决)」');
      await fx.setLens('classic');
      // 收尾：问题弹层 Esc 是「收进右下角小窗」（不替用户答）；再把这条停在「等你」的回合停掉，后面几组不被它（弹层、在跑）挡着。
      for (let i = 0; i < 3 && await ev(`Boolean(document.querySelector('.modal-backdrop.ask-modal:not(.hidden)'))`); i++) { await fx.escape(); await sleep(300); }
      await fx.request('POST', '/api/stop', { sessionId: ids.Q });
      await sleep(600);
    });

    /* ═════════ F10：附件上传占位 ═════════ */
    await phase('F10', async () => {
      ok(Boolean(await fx.setLens('classic')), 'F10.0 工作台视角');
      await fx.resize(1280, 900);
      // 页内桩：/api/upload 默认「卡住」。abortable=true 时尊重 AbortSignal；false 时不理 signal，等我们手动放行（模拟「中止来不及、结果已在路上」）。
      await ev(`(() => {
        if (window.__up) return true;
        window.__up = { mode: 'stuck', abortable: true, calls: [], pending: [] };
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : String((input && input.url) || '');
          if (url.indexOf('/api/upload') < 0) return realFetch(input, init);
          const call = { aborted: false, name: '' };
          try { call.name = JSON.parse(init.body).name; } catch { /* ignore */ }
          window.__up.calls.push(call);
          const record = { file: { name: call.name, path: 'C:/fake/' + call.name, size: 3 } };
          const body = () => new Response(JSON.stringify(record), { status: 200, headers: { 'content-type': 'application/json' } });
          if (window.__up.mode === 'ok') return Promise.resolve(body());
          return new Promise((resolve, reject) => {
            window.__up.pending.push(() => resolve(body()));
            if (window.__up.abortable && init && init.signal) init.signal.addEventListener('abort', () => { call.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
          });
        };
        window.__upload = name => {
          const dt = new DataTransfer(); dt.items.add(new File(['abc'], name, { type: 'text/plain' }));
          const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        return true;
      })()`);
      const tray = () => ev(`({ uploading: document.querySelectorAll('#attachmentTray .attachment-pill.uploading').length, pills: document.querySelectorAll('#attachmentTray .attachment-pill').length, x: document.querySelectorAll('#attachmentTray .attachment-pill.uploading button.attach-x').length, state: window.state.uploading, attachments: window.state.attachments.length, toasts: [...document.querySelectorAll('#toastTray .toast, #toastTray > *')].map(n => n.textContent).join('|') })`);

      // ① 点 × 中止
      await ev(`window.__upload('stuck-a.txt'), true`);
      ok(Boolean(await waitFor(`document.querySelector('#attachmentTray .attachment-pill.uploading') ? 1 : null`, 150)), 'F10.1 上传卡住，托盘里有「上传中…」占位');
      let s = await tray();
      ok(s.uploading === 1 && s.x === 1 && s.state === 1, `F10.2 占位上有 ×，在飞数 1（${JSON.stringify(s)}）`);
      const aria = await ev(`document.querySelector('#attachmentTray .attachment-pill.uploading button.attach-x').getAttribute('aria-label')`);
      ok(aria === ZH['chat.attachCancelAria'].replace('{{name}}', 'stuck-a.txt'), `F10.3 × 的可访问名说清取消的是哪个文件（「${aria}」）`);
      await ev(`document.querySelector('#attachmentTray .attachment-pill.uploading button.attach-x').click(), true`);
      await sleep(300);
      s = await tray();
      const aborted = await ev(`window.__up.calls[0].aborted`);
      ok(s.uploading === 0 && s.state === 0 && s.attachments === 0 && aborted === true, `F10.4 点 ×：占位撤了、在飞数归零、这一发被 abort、没有附件混进来（${JSON.stringify(s)}；aborted=${aborted}）`);
      ok(s.toasts.indexOf(ZH['toast.uploadFail'].split('{{')[0]) < 0, `F10.5 取消不算失败：没有弹「上传失败」（${s.toasts}）`);
      await ev(`(() => { const ta = document.getElementById('promptInput'); ta.value = '发一句'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const sendGate = await ev(`(() => { const b = document.getElementById('sendBtn'); return { disabled: b.disabled, state: window.state.uploading }; })()`);
      ok(sendGate.state === 0 && sendGate.disabled === false, `F10.6 发送不再被「附件还在上传」拦着（${JSON.stringify(sendGate)}）`);
      await ev(`(() => { const ta = document.getElementById('promptInput'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

      // ② 换线程（清场）时在飞上传作废：中止来不及的那种（桩不理 signal），结果晚到也不落进新线程。
      await ev(`(() => { window.__up.abortable = false; window.__up.calls.length = 0; window.__up.pending.length = 0; window.__upload('late-b.txt'); return true; })()`);
      ok(Boolean(await waitFor(`window.state.uploading === 1 ? 1 : null`, 150)), 'F10.7 又一发上传在飞');
      const sidBefore = await ev(`window.state.currentSession && window.state.currentSession.id`);
      await ev(`document.getElementById('newSessionBtn').click(), true`);
      ok(Boolean(await waitFor(`(() => { const id = window.state.currentSession && window.state.currentSession.id; return id && id !== ${JSON.stringify(sidBefore)} ? 1 : null; })()`, 300)), 'F10.8 新开了一条线程（清场）');
      s = await tray();
      ok(s.uploading === 0 && s.state === 0, `F10.9 清场时占位撤了、在飞数归零（${JSON.stringify(s)}；修前 clearThreadStage 不碰在飞的上传）`);
      await ev(`window.__up.pending.forEach(release => release()), true`);   // 旧线程的上传结果「晚到」
      await sleep(600);
      s = await tray();
      ok(s.attachments === 0 && s.pills === 0, `F10.10 晚到的结果没落进新线程的托盘（${JSON.stringify(s)}）`);

      // ③ 正常路径没被碰坏：立刻成功的上传照常变成附件 pill。
      await ev(`(() => { window.__up.mode = 'ok'; window.__upload('good-c.txt'); return true; })()`);
      ok(Boolean(await waitFor(`window.state.attachments.length === 1 && document.querySelector('#attachmentTray .attachment-pill:not(.uploading)') ? 1 : null`, 200)), 'F10.11 正常上传照常落成附件 pill');
      ok(Boolean(await waitFor(`window.state.uploading === 0 ? 1 : null`, 100)), 'F10.12 占位随之撤掉');
      await ev(`(() => { document.querySelector('#attachmentTray .attachment-pill button.attach-x').click(); return true; })()`);
      ok((await tray()).attachments === 0, 'F10.13 已传好的附件仍能用 × 移除');
    });

    /* ═════════ K：Ctrl+K 与帮助弹窗快捷键表 ═════════ */
    await phase('K', async () => {
      ok(Boolean(await fx.setLens('classic')), 'K.0 工作台视角');
      await ev(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.__kFocus = []; document.addEventListener('focusin', e => window.__kFocus.push(e.target.id || e.target.tagName), true); return true; })()`);
      await fx.key('k', { code: 'KeyK', keyCode: 75, modifiers: 2 });
      ok(Boolean(await waitFor(`(() => { const m = document.getElementById('paletteModal'); return m && !m.classList.contains('hidden') ? 1 : null; })()`, 200)), 'K.1 Ctrl+K 打开命令面板');
      const focus = await ev(`({ active: document.activeElement && document.activeElement.id, search: document.activeElement === document.getElementById('sessionSearch') })`);
      ok(focus.active === 'paletteInput' && focus.search === false, `K.2 焦点在面板输入框里，不在左栏搜索框（${JSON.stringify(focus)}）`);
      const touched = await ev(`window.__kFocus`);
      ok(!touched.includes('sessionSearch'), `K.2b Ctrl+K 的过程中左栏搜索框一次焦点都没拿到过（修前 app-frame.js 的第二个监听先 focus() 它、面板再抢走；实测焦点依次落在 ${JSON.stringify(touched)}）`);
      await fx.escape();
      ok(Boolean(await waitFor(`document.getElementById('paletteModal').classList.contains('hidden') ? 1 : null`, 150)), 'K.3 Esc 关掉面板（一次 Esc 只关最上面一层）');
      await ev(`document.getElementById('helpBtn').click(), true`);
      ok(Boolean(await waitFor(`(() => { const m = document.getElementById('helpModal'); return m && !m.classList.contains('hidden') ? 1 : null; })()`, 150)), 'K.4 帮助弹窗打开');
      const rows = await ev(`[...document.querySelectorAll('#helpModal .kbd-table tr')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim())`);
      ok(rows.some(r => r.indexOf('`') >= 0 && r.indexOf(ZH['help.switchLens']) >= 0), `K.5 快捷键表有 Ctrl+\` 切视角（${JSON.stringify(rows)}）`);
      ok(rows.some(r => /Enter/.test(r) && r.indexOf(ZH['help.answerQuestion']) >= 0), 'K.6 快捷键表有问题卡的 Ctrl+Enter');
      await setLocale('en-US');
      const enRows = await ev(`[...document.querySelectorAll('#helpModal .kbd-table td:last-child')].map(td => td.textContent.trim())`);
      ok(enRows.includes(EN['help.switchLens']) && enRows.includes(EN['help.answerQuestion']) && enRows.every(text => !CJK.test(text)), `K.7 英文界面快捷键表零中文（${JSON.stringify(enRows)}）`);
      await ev(`(() => { const b = document.querySelector('#helpModal [data-close-modal]'); if (b) b.click(); return true; })()`);
      await setLocale('zh-CN');
    });

    /* ═════════ M：记忆检索回执的规则补位 ═════════ */
    await phase('M', async () => {
      await fx.request('POST', '/api/memory', { memory: { scope: 'project', type: 'convention', name: 'w2 zzz-rule', description: 'zzzz qqqq 补位用的默认规则', body: 'zzzz qqqq' }, cwd: fx.work });
      ok(Boolean(await fx.setLens('classic')), 'M.0 工作台视角');
      await setLocale('zh-CN');
      await ev(`document.getElementById('newSessionBtn').click(), true`);   // 干净的新线程（cwd 就是夹具的工作目录，项目记忆对得上）
      ok(Boolean(await waitFor(`window.state && !window.state.streaming ? 1 : null`, 150)), 'M.0b 此刻没有回合在跑');
      await ev(`(() => { const ta = document.getElementById('promptInput'); ta.value = 'MEMO hello'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
      const line = await waitFor(`(() => { const out = document.getElementById('toolOutput'); const all = out ? [...out.textContent.matchAll(/记忆=已检索[^\\n]*/g)] : []; return all.length ? all[all.length - 1][0] : null; })()`, 900);
      ok(Boolean(line), `M.1 回合起点的回执里有「记忆=已检索…」那一行（${line}；${JSON.stringify(await ev(`({ streaming: window.state.streaming, sid: window.state.currentSession && window.state.currentSession.id, lang: document.documentElement.lang, msgs: [...document.querySelectorAll('#messages .message')].slice(-2).map(n => n.textContent.slice(0, 60)), toasts: [...document.querySelectorAll('#toastTray > *')].map(n => n.textContent.slice(0, 80)), uploading: window.state.uploading, att: window.state.attachments.length, btn: document.getElementById('sendBtn').textContent.trim(), val: document.getElementById('promptInput').value, out: String((document.getElementById('toolOutput') || {}).textContent || '').slice(-400), modals: [...document.querySelectorAll('.modal-backdrop:not(.hidden)')].map(n => n.id || n.className) })`))}）`);
      const matched = /匹配 (\d+) 条（项目 (\d+) \/ 全局 (\d+)）/.exec(line || '');
      ok(Boolean(matched) && matched[1] === '0' && matched[2] === '0' && matched[3] === '0', `M.2 「匹配」只数真命中：一句无关的话是 0，不是把补位也算进去（${line}）`);
      ok((line || '').indexOf(ZH['memory.check.fill'].replace('{{fill}}', '1')) >= 0, `M.3 补位另说一句「${ZH['memory.check.fill'].replace('{{fill}}', '1')}」（${line}）`);
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
