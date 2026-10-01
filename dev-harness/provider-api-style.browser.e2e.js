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
//   S4 全程零未捕获异常;
//   S5 (2026-10 补字段)「协议与能力」里的新字段:思考强度下拉随「推理链」置灰/可用、写 p.reasoningEffort;语音转写地址空=不落字段;
//      子代理模型下拉候选来自该卡片模型清单;Anthropic 专属三项只在协议登记表 anthropicOptions 为真的协议下显示,
//      认证/思考方式的缺省(空)不落字段,拒答改派取消勾选 = 'off'。
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

    // S5 2026-10 补字段:都在「协议与能力」折叠组里(默认折起也在 DOM 里,直接读写)。S3 之后协议是 chat。
    const s5a = await fx.evaluate(`(async () => {
      const card = document.querySelector('#providersList .prov-card');
      const rc = card.querySelector('.prov-cap .prov-reason input[type=checkbox]');
      const effort = card.querySelector('.prov-effort-select');
      const anth = card.querySelector('.prov-anthropic-opts');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      const d = window.state.providersDraft[0];
      rc.checked = false; fire(rc, 'change');
      const disabledWhenOff = effort.disabled;
      rc.checked = true; fire(rc, 'change');
      const enabledWhenOn = !effort.disabled;
      effort.value = 'high'; fire(effort, 'change');
      const efforts = [...effort.options].map(o => o.value);
      const audio = card.querySelector('.prov-audio-base input');
      audio.value = ' https://asr.example.com/v1 '; fire(audio, 'input');
      const audioSet = d.audioBaseUrl;
      audio.value = ''; fire(audio, 'input');
      const audioCleared = !('audioBaseUrl' in d);
      const sub = card.querySelector('.prov-subagent-select');
      const subOptions = [...sub.options].map(o => o.value);
      return { disabledWhenOff, enabledWhenOn, reasoningEffort: d.reasoningEffort, reasoning: d.reasoning, efforts, audioSet, audioCleared,
        subFirst: subOptions[0], subHasMain: !d.model || subOptions.includes(d.model), anthHiddenOnChat: anth.style.display === 'none' };
    })()`);
    ok(s5a.disabledWhenOff === true && s5a.enabledWhenOn === true && s5a.reasoning === true && s5a.reasoningEffort === 'high'
      && s5a.efforts[0] === '' && s5a.efforts.includes('xhigh'),
      `S5 思考强度:推理链关着置灰、开着可选并写进草稿(${JSON.stringify(s5a)})`);
    ok(s5a.audioSet === 'https://asr.example.com/v1' && s5a.audioCleared === true, `S5 语音转写地址:trim 后写草稿,清空就删字段(${JSON.stringify([s5a.audioSet, s5a.audioCleared])})`);
    ok(s5a.subFirst === '' && s5a.subHasMain === true, `S5 子代理模型下拉:首项是「跟随主模型」(空值),候选含该卡片的主模型(${JSON.stringify([s5a.subFirst, s5a.subHasMain])})`);
    ok(s5a.anthHiddenOnChat === true, 'S5 chat 协议下 Anthropic 专属三项隐藏');

    const s5b = await fx.evaluate(`(async () => {
      const card = document.querySelector('#providersList .prov-card');
      const sc = card.querySelector('.prov-style-select');
      const anth = card.querySelector('.prov-anthropic-opts');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      const d = window.state.providersDraft[0];
      sc.value = 'anthropic'; fire(sc, 'change');
      const shown = anth.style.display !== 'none';
      const auth = anth.querySelector('.prov-anthropic-auth select');
      const thinking = anth.querySelector('.prov-anthropic-thinking select');
      const fb = anth.querySelector('.prov-anthropic-fallbacks input');
      const authValues = [...auth.options].map(o => o.value);
      auth.value = 'bearer'; fire(auth, 'change');
      thinking.value = 'adaptive'; fire(thinking, 'change');
      const afterPick = { anthropicAuth: d.anthropicAuth, anthropicThinking: d.anthropicThinking };
      const fallbacksDefaultOn = fb.checked;
      fb.checked = false; fire(fb, 'change');
      const off = d.anthropicFallbacks;
      fb.checked = true; fire(fb, 'change');
      const backOn = !('anthropicFallbacks' in d);
      auth.value = ''; fire(auth, 'change');
      thinking.value = ''; fire(thinking, 'change');
      const cleared = !('anthropicAuth' in d) && !('anthropicThinking' in d);
      sc.value = 'chat'; fire(sc, 'change');
      return { shown, authValues, afterPick, fallbacksDefaultOn, off, backOn, cleared, hiddenAgain: anth.style.display === 'none' };
    })()`);
    ok(s5b.shown === true && JSON.stringify(s5b.authValues) === JSON.stringify(['', 'x-api-key', 'bearer'])
      && s5b.afterPick.anthropicAuth === 'bearer' && s5b.afterPick.anthropicThinking === 'adaptive',
      `S5 切到 anthropic:专属三项出现,选值写草稿(${JSON.stringify(s5b)})`);
    ok(s5b.fallbacksDefaultOn === true && s5b.off === 'off' && s5b.backOn === true && s5b.cleared === true && s5b.hiddenAgain === true,
      `S5 拒答改派缺省勾选、取消 = 'off'、勾回删字段;认证/思考方式选回「自动」删字段;切回 chat 再隐藏(${JSON.stringify(s5b)})`);
    await sleep(100);
    ok(fx.exceptions.length === before, `S4 全程零未捕获异常(${JSON.stringify(fx.exceptions.slice(before))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
