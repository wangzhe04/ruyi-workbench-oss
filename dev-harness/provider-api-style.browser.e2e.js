#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E:设置页服务商卡片的「协议」下拉(58 号方案批 1 起由前端协议登记表 provider-api-styles.js 生成)。
//
// 修前下拉写死 chat / responses 两项,「服务端搜索」开关的显隐只认 'responses';现在选项、默认值与显隐都问登记表,
// 批 2 加 Anthropic 只在表里加一行。本件在真浏览器里把用户会做的事走一遍:
//   S1 打开设置页,服务商卡片的协议下拉按登记表顺序列出全部协议(值与服务端 PROVIDER_WIRE_PROTOCOLS 的键相同、文案本地化),
//      没配 apiStyle 的服务商(服务端归一成 'chat' 下发)显示缺省协议 chat,「服务端搜索」开关隐藏;
//   S2 切到 responses:草稿写上 apiStyle:'responses',开关出现;勾上 → 草稿 serverWebSearch:true;
//   S3 切回 chat:草稿删掉 apiStyle 与 serverWebSearch(缺省不落字段,存量 config 零漂移),开关隐藏且视觉上不再勾选;
//   S4 全程零未捕获异常。
// 判定行:`PROVIDER API STYLE BROWSER E2E: ALL PASS`。
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('PROVIDER API STYLE BROWSER');
const { ok } = t;

(async () => {
  let fx = null;
  try {
    const { PROVIDER_WIRE_PROTOCOLS } = require(path.resolve(__dirname, '../ruyi-workbench/app/server.js'));
    const serverIds = Object.keys(PROVIDER_WIRE_PROTOCOLS);
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-api-style-' });
    const before = fx.exceptions.length;
    await fx.evaluate(`(() => { document.getElementById('appGearBtn').click(); document.getElementById('openSettingsBtn').click(); return true; })()`);
    const ready = await fx.waitForEval(`document.querySelector('#providersList .prov-style-select') ? 1 : null`, 200);
    ok(ready === 1, 'S1 设置页里画出了服务商卡片的协议下拉');
    const s1 = await fx.evaluate(`(() => {
      const sc = document.querySelector('#providersList .prov-style-select');
      const lbl = document.querySelector('#providersList .prov-server-search');
      return { values: [...sc.options].map(o => o.value), labels: [...sc.options].map(o => o.textContent), value: sc.value,
        searchShown: lbl ? lbl.style.display !== 'none' : null, draft: window.state.providersDraft && window.state.providersDraft[0] };
    })()`);
    ok(JSON.stringify(s1.values) === JSON.stringify(serverIds), `S1 下拉选项 = 服务端登记表的键(实测 ${JSON.stringify(s1.values)})`);
    ok(s1.labels.every(label => label && !/^provider\./.test(label)), `S1 选项文案已本地化(${JSON.stringify(s1.labels)})`);
    // 服务端 sanitizeProvider 把缺省协议归一成 'chat' 下发,所以草稿里是 'chat'(或没有这个键)。
    ok(s1.value === 'chat' && s1.searchShown === false && s1.draft && (s1.draft.apiStyle || 'chat') === 'chat',
      `S1 没配协议的服务商显示 chat、服务端搜索开关隐藏(value=${s1.value} shown=${s1.searchShown} draft=${s1.draft && s1.draft.apiStyle})`);

    const s2 = await fx.evaluate(`(async () => {
      const sc = document.querySelector('#providersList .prov-style-select');
      sc.value = 'responses'; sc.dispatchEvent(new Event('change', { bubbles: true }));
      const lbl = document.querySelector('#providersList .prov-server-search');
      const box = lbl.querySelector('input[type=checkbox]');
      const shownAfterSwitch = lbl.style.display !== 'none';
      box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const d = window.state.providersDraft[0];
      return { shownAfterSwitch, apiStyle: d.apiStyle, serverWebSearch: d.serverWebSearch };
    })()`);
    ok(s2.shownAfterSwitch === true && s2.apiStyle === 'responses' && s2.serverWebSearch === true,
      `S2 切到 responses:开关出现,草稿写上 apiStyle/serverWebSearch(${JSON.stringify(s2)})`);

    const s3 = await fx.evaluate(`(async () => {
      const sc = document.querySelector('#providersList .prov-style-select');
      sc.value = 'chat'; sc.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const lbl = document.querySelector('#providersList .prov-server-search');
      const d = window.state.providersDraft[0];
      return { shown: lbl.style.display !== 'none', checked: lbl.querySelector('input[type=checkbox]').checked, hasApiStyle: 'apiStyle' in d, hasSearch: 'serverWebSearch' in d };
    })()`);
    ok(!s3.shown && !s3.checked && !s3.hasApiStyle && !s3.hasSearch,
      `S3 切回 chat:开关隐藏且不再勾选,草稿删掉 apiStyle 与 serverWebSearch(${JSON.stringify(s3)})`);
    await sleep(100);
    ok(fx.exceptions.length === before, `S4 全程零未捕获异常(${JSON.stringify(fx.exceptions.slice(before))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
