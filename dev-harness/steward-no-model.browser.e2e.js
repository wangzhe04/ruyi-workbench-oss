#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：还没接模型时，管家首页不许让人走进死胡同（体验走查 #1）。
//
// 走查原话：全新安装 → 不走向导、直接在管家输入框发一句话 → 「管家本版只支持 OpenAI 兼容端点，当前主端点是
// claude；请在设置里为管家单独指定一个 OpenAI 兼容端点(stewardProviderId)」＋ 顶部红点「上一步失败」。
//
// 覆盖：
//   N1 没有任何 OpenAI 兼容端点：管家首页是「先接一个模型」那张卡（一枚主按钮），不是自我介绍／问候；
//   N2 输入框置灰，占位说清原因（不能先发一句再失败）；
//   N3 卡片与页面上都不出现配置键名（stewardProviderId）与用户没选过的「claude」；
//   N4 点「接一个模型」→ 向导打开、直接落在「用哪种引擎」那一步；
//   N5 接上一个端点（写 config）并刷新 → 卡片消失、输入框可用、回到首跑那条自我介绍；
//   N6 服务端那句兜底也说人话：/api/steward/message 在没模型时回的 message 不含配置键名；
//   N8/N9 管家页开着时模型掉线又接回：当场换成「先接一个模型」卡，接回后重新到访（代码走查 C15）；
//   N10 管家视角下提示条不压右栏、点击穿透（走查 U13）；N11 用户新开的空线程落「新开的」不落「排队」（走查 U2）。
// 判定行：`STEWARD NO MODEL BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  try {
    // 夹具默认带一个 fake 端点；这里把它拿掉 —— 与全新安装同一个起点（主端点落回命令行引擎）。
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-steward-nomodel-', config: { activeProvider: undefined, providers: undefined } });
    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="steward"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);
    const PROBE = `(() => {
      const feed = document.getElementById('stewardFeed');
      const input = document.getElementById('stewardComposerInput');
      const acts = feed ? [...feed.querySelectorAll('.steward-act')].map(n => n.textContent.trim()) : [];
      return { text: feed ? feed.textContent : '', acts, disabled: input ? input.disabled : null, placeholder: input ? input.placeholder : '',
        examples: feed ? feed.querySelectorAll('.steward-example').length : 0 };
    })()`;
    const gate = await fx.waitForEval(`(() => { const p = ${PROBE}; return p.acts.includes('接一个模型') ? p : null; })()`, 400) || await fx.evaluate(PROBE);
    ok(gate && gate.acts.includes('接一个模型') && gate.examples === 0 && !/你回来了/.test(gate.text),
      `N1 没接模型：管家首页是「先接一个模型」卡（实测 ${JSON.stringify(gate && { acts: gate.acts, text: gate.text.slice(0, 80) })}）`);
    ok(gate && gate.disabled === true && /先接一个模型/.test(gate.placeholder),
      `N2 输入框置灰、占位说清原因（实测 disabled=${gate && gate.disabled} placeholder=${JSON.stringify(gate && gate.placeholder)}）`);
    // N2b（Windows CI 首跑红过一次：disabled=true 但占位还是默认那句）：语言包晚到时会按 data-i18n-attr 把全页重新套一遍，
    // 修前它把「先接一个模型」写回默认句。这里确定性地重新套一遍再量。
    const reapplied = await fx.evaluate(`import('/js/i18n.js').then(m => { m.applyTranslations(document); const i = document.getElementById('stewardComposerInput'); return { disabled: i.disabled, placeholder: i.placeholder }; })`);
    ok(reapplied && reapplied.disabled === true && /先接一个模型/.test(reapplied.placeholder),
      `N2b 语言包重新套用之后占位仍说清原因（实测 ${JSON.stringify(reapplied)}）`);
    ok(gate && !/stewardProviderId/.test(gate.text) && !/claude/i.test(gate.text),
      'N3 不出配置键名，也不出用户没选过的「claude」');
    // N1b（走查 U12）：没接模型时左栏空态也别说「直接说你想做什么」—— 输入框是灰的，说了发不出去。
    const railEmpty = await fx.waitForEval(`(() => { const n = document.querySelector('.steward-board-empty-say'); return n && n.textContent ? n.textContent : null; })()`, 200);
    ok(Boolean(railEmpty) && /先接一个模型/.test(railEmpty), `N1b 没接模型：左栏空态先说「先接一个模型」（实测 ${JSON.stringify(railEmpty)}）`);

    await fx.evaluate(`(() => { const b = [...document.querySelectorAll('#stewardFeed .steward-act')].find(n => n.textContent.trim() === '接一个模型'); b && b.click(); return true; })()`);
    const wizard = await fx.waitForEval(`(() => {
      const w = document.querySelector('.modal.onboard-wizard');
      if (!w) return null;
      const cur = w.querySelector('.onboard-wiz-rail-item.current');
      return { step: cur ? cur.textContent : '' };
    })()`, 300);
    ok(Boolean(wizard) && wizard.step === '引擎', `N4 点它 → 向导打开、直接落在「引擎」那一步（实测 ${JSON.stringify(wizard)}）`);
    await fx.evaluate(`(() => { const bd = document.querySelector('.onboard-wizard-backdrop'); if (bd && bd.__close) bd.__close(); return true; })()`);

    const turn = await fx.request('POST', '/api/steward/message', { text: '你好', message: '你好' });
    const turnText = JSON.stringify(turn && turn.json || {});
    ok(!/stewardProviderId/.test(turnText) && /模型/.test(turnText), `N6 服务端兜底那句也说人话（实测 ${turnText.slice(0, 200)}）`);

    // 接上一个端点：写 config（与向导「保存并继续」写的是同一组字段），刷新后管家应当回到首跑那条。
    const saved = await fx.request('POST', '/api/config', {
      activeProvider: 'fake',
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fx.providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    });
    ok(Boolean(saved && saved.status === 200), `N5a 写入一个端点（HTTP ${saved && saved.status}）`);
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await fx.waitForEval(`window.state && window.state.config && window.state.config.activeProvider === 'fake' ? 1 : null`, 300);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);
    const ready = await fx.waitForEval(`(() => { const p = ${PROBE}; return p.examples === 3 ? p : null; })()`, 400) || await fx.evaluate(PROBE);
    ok(ready && ready.examples === 3 && !ready.acts.includes('接一个模型') && ready.disabled === false,
      `N5 接上之后：卡片消失、输入框可用、回到首跑那条自我介绍（实测 ${JSON.stringify(ready && { acts: ready.acts, disabled: ready.disabled, examples: ready.examples })}）`);
    // N7（走查 #19）：首跑那三条示例看起来要像能点的按钮 —— 常驻一道可见边框，不是透明边框＋灰字。
    const chip = await fx.evaluate(`(() => {
      const b = document.querySelector('#stewardFeed .steward-example');
      if (!b) return null;
      const cs = getComputedStyle(b);
      const m = cs.borderTopColor.match(/rgba?\\(([^)]+)\\)/);
      const alpha = m ? (m[1].split(',').length === 4 ? Number(m[1].split(',')[3]) : 1) : 0;
      return { tag: b.tagName, border: cs.borderTopWidth, color: cs.borderTopColor, alpha, cursor: cs.cursor };
    })()`);
    ok(chip && chip.tag === 'BUTTON' && chip.border !== '0px' && chip.alpha > 0 && chip.cursor === 'pointer',
      `N7 首跑示例长得像按钮：可见边框、手形光标（实测 ${JSON.stringify(chip)}）`);
    // N8/N9（代码走查 C15）：管家页开着的时候模型掉线又接回来 —— 不切视角、不刷新页面，只是配置刷新了一次。
    // 修前：掉线时只把输入框置灰、不画「先接一个模型」卡；接回来之后也不重新到访（到访门一直关着）。
    const refreshConfig = () => fx.evaluate(`(() => { const b = document.querySelector('#settingsTabs button[data-stab="doctor"]'); b && b.click(); return Boolean(b); })()`);
    const offline = await fx.request('POST', '/api/config', { activeProvider: '', providers: [] });
    ok(Boolean(offline && offline.status === 200), `N8a 把端点撤掉（HTTP ${offline && offline.status}）`);
    await refreshConfig();
    const gated = await fx.waitForEval(`(() => { const p = ${PROBE}; return p.acts.includes('接一个模型') ? p : null; })()`, 300) || await fx.evaluate(PROBE);
    ok(gated && gated.acts.includes('接一个模型') && gated.disabled === true,
      `N8 管家页开着时模型掉线 → 当场换成「先接一个模型」卡、输入框置灰（实测 ${JSON.stringify(gated && { acts: gated.acts, disabled: gated.disabled })}）`);
    await fx.request('POST', '/api/config', {
      activeProvider: 'fake',
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fx.providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    });
    await refreshConfig();
    const back = await fx.waitForEval(`(() => { const p = ${PROBE}; return !p.acts.includes('接一个模型') && p.disabled === false && p.examples === 3 ? p : null; })()`, 300) || await fx.evaluate(PROBE);
    ok(back && !back.acts.includes('接一个模型') && back.disabled === false && back.examples === 3,
      `N9 接回来 → 卡片撤掉、重新到访、输入框可用（实测 ${JSON.stringify(back && { acts: back.acts, disabled: back.disabled, examples: back.examples })}）`);
    // N10（走查 U13）：管家视角下提示条不压右栏（修前「引导完成」压着右栏底部的「停止」），而且点击穿过去。
    const toastBox = await fx.evaluate(`import('/js/util.js').then(m => {
      m.toast('提示条位置探针');
      const tray = document.getElementById('toastTray');
      const side = document.getElementById('stewardSide');
      const t = tray.getBoundingClientRect(), s = side ? side.getBoundingClientRect() : null;
      return { pe: getComputedStyle(tray).pointerEvents, right: t.right, bottom: t.bottom, vw: innerWidth, vh: innerHeight, sideLeft: s && s.width ? s.left : null };
    })`);
    ok(Boolean(toastBox) && toastBox.pe === 'none' && toastBox.right < toastBox.vw - 100 && toastBox.bottom <= toastBox.vh - 90
      && (toastBox.sideLeft === null || toastBox.right <= toastBox.sideLeft),
      `N10 管家视角：提示条不压右栏、点击穿透（实测 ${JSON.stringify(toastBox)}）`);
    // N11（走查 U2）：用户自己新开、还没开口的空线程不是「排队」：左栏落「新开的」，右栏不挂「在排队」那一段与插队／并发上限。
    // 反向验证：stewardThreadStateOf 里去掉 threadIsBlank 那一句 → 落回「排队」、⑧ 那一段露出来，N11 红。
    const blank = await fx.request('POST', '/api/sessions', { title: '空线程探针' });
    const blankId = blank && blank.json && blank.json.session && blank.json.session.id;
    const railProbe = `(() => { const row = document.querySelector('#railList .steward-board-thread[data-session-id="${blankId}"]');
      const group = row && row.closest('.rail-group'); return group ? group.dataset.group : null; })()`;
    const blankGroup = await fx.waitForEval(railProbe, 300) || await fx.evaluate(railProbe);
    await fx.evaluate(`(document.querySelector('#railList .steward-board-thread[data-session-id="${blankId}"]') || { click() {} }).click(), true`);
    const drawer = await fx.waitForEval(`(() => { const s = document.getElementById('stewardDrawerState'); const q = document.getElementById('stewardDrawerQueue');
      return s && s.textContent.trim() ? { state: s.textContent.trim(), queueHidden: !q || q.hidden } : null; })()`, 100);
    ok(Boolean(blankId) && blankGroup === 'fresh' && drawer && drawer.state === '还没开始' && drawer.queueHidden === true,
      `N11 空线程落「新开的」、态是「还没开始」、没有排队那一段（实测 组=${blankGroup} ${JSON.stringify(drawer)}）`);
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nSTEWARD NO MODEL BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
