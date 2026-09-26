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
//   N6 服务端那句兜底也说人话：/api/steward/message 在没模型时回的 message 不含配置键名。
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
