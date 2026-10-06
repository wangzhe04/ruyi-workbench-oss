#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E:设置页里接一个 Anthropic 兼容网关(2026-10 用户报「Anthropic API 的设置接入似乎有问题而且太复杂」,给的是
// DeepSeek 的 https://api.deepseek.com/anthropic)。假网关是 lib/fake-anthropic-provider.js(models:null = 不提供模型清单)。
//   A1 不另设协议预设:「自定义」卡粘 https://api.deepseek.com/anthropic,协议即自动是 Anthropic;
//   A2 Anthropic 卡片:协议下拉在 Base URL 正下方(不在折叠组里)、提示与占位符按协议;「思考」是唯一的思考开关
//      (通用「推理链」隐藏),语音转写两项隐藏,认证方式收在「连接细节」里,拒答改派在非官方地址上不显示;
//   A3 在一张 OpenAI 兼容卡上粘 …/anthropic/v1/messages:协议自动切到 Anthropic 并提示;失焦后剥掉端点后缀;
//   A4 用户手动选过协议后,再改地址不再被自动切换;
//   A5 「测试连接」:网关没有模型清单 → 用填好的模型发一次试探,状态行说「连接成功 + 不提供模型清单」,不再报「端点地址可能不对」;
//   A6 向导与设置页共用的 normalizeProviderDraftEndpoint:OpenAI 兼容预设 + /anthropic 地址 → 草稿补上 apiStyle、剥掉端点后缀;
//   A7 全程零未捕获异常。
// 判定行:`ANTHROPIC PROVIDER SETUP BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');

const t = createRunner('ANTHROPIC PROVIDER SETUP BROWSER');
const { ok } = t;

(async () => {
  let fx = null;
  const gw = await startFakeAnthropic({ models: null, handler: () => messageEvents({ text: 'pong', model: 'gw-model' }) });
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-anth-setup-' });
    const before = fx.exceptions.length;
    await fx.evaluate(`(() => { document.getElementById('appGearBtn').click(); document.getElementById('openSettingsBtn').click(); return true; })()`);
    ok((await fx.waitForEval(`document.querySelector('#providersList .prov-style-select') ? 1 : null`, 200)) === 1, 'A0 设置页画出了服务商卡片');

    // ── A1 「自定义」卡粘 /anthropic 地址 ──
    // 不另设「Anthropic 协议」预设(用户 2026-09-27:预设只留本机两条 + 自定义):协议由地址推断,
    // 用户照服务商文档粘 https://api.deepseek.com/anthropic 就够了。
    const a1 = await fx.evaluate(`(async () => {
      const sel = document.getElementById('providerPresetSelect');
      sel.value = 'openai-compatible';
      const n0 = document.querySelectorAll('#providersList .prov-card').length;
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      const cards = document.querySelectorAll('#providersList .prov-card');
      const card = cards[cards.length - 1];
      const d = window.state.providersDraft[window.state.providersDraft.length - 1];
      const bi = card.querySelector('[data-prov-field=baseUrl]');
      bi.value = 'https://api.deepseek.com/anthropic';
      bi.dispatchEvent(new Event('input', { bubbles: true }));
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      return { added: cards.length === n0 + 1, style: card.querySelector('.prov-style-select').value, apiStyle: d.apiStyle, baseUrl: d.baseUrl };
    })()`);
    ok(a1.added && a1.style === 'anthropic' && a1.apiStyle === 'anthropic' && a1.baseUrl === 'https://api.deepseek.com/anthropic',
      `A1 「自定义」卡粘 …/anthropic 地址即是 Anthropic 协议(${JSON.stringify(a1)})`);

    // ── A2 卡片形状 ──
    const a2 = await fx.evaluate(`(() => {
      const cards = document.querySelectorAll('#providersList .prov-card');
      const card = cards[cards.length - 1];
      const shown = el => !!el && el.style.display !== 'none' && !el.closest('[style*="display: none"]');
      const style = card.querySelector('.prov-style-select');
      const anth = card.querySelector('.prov-anthropic-opts');
      return {
        styleInCap: !!style.closest('.prov-cap'),
        styleNearUrl: !!style.closest('.field-block') && !!style.closest('.field-block').querySelector('[data-prov-field=baseUrl]'),
        hint: card.querySelector('.prov-style-hint').textContent,
        placeholder: card.querySelector('[data-prov-field=baseUrl]').placeholder,
        anthShown: shown(anth), anthInCap: !!anth.closest('.prov-cap'),
        thinkingShown: shown(card.querySelector('.prov-anthropic-thinking select')),
        reasonShown: shown(card.querySelector('.prov-cap .prov-reason')),
        asrShown: shown(card.querySelector('.prov-asr-protocol')), audioShown: shown(card.querySelector('.prov-audio-base')),
        authInDetails: !!card.querySelector('.prov-anthropic-more .prov-anthropic-auth select'),
        fallbacksShown: shown(card.querySelector('.prov-anthropic-fallbacks')),
      };
    })()`);
    ok(!a2.styleInCap && a2.styleNearUrl, `A2 协议下拉在 Base URL 那一块里、不在折叠组(${JSON.stringify([a2.styleInCap, a2.styleNearUrl])})`);
    ok(/\/anthropic/.test(a2.hint) && /anthropic/i.test(a2.placeholder) && !/^\[provider\./.test(a2.hint), `A2 提示与占位符按 Anthropic 写(${JSON.stringify([a2.hint.slice(0, 40), a2.placeholder])})`);
    ok(a2.anthShown && !a2.anthInCap && a2.thinkingShown && !a2.reasonShown, `A2 「思考」在主区且是唯一的思考开关(${JSON.stringify([a2.anthShown, a2.anthInCap, a2.thinkingShown, a2.reasonShown])})`);
    ok(!a2.asrShown && !a2.audioShown, 'A2 语音转写两项在 Anthropic 卡片上隐藏');
    ok(a2.authInDetails && !a2.fallbacksShown, `A2 认证方式收进「连接细节」;非官方地址不显示拒答改派(${JSON.stringify([a2.authInDetails, a2.fallbacksShown])})`);

    // ── A3 / A4 在 OpenAI 兼容卡上粘地址 ──
    const gwUrl = gw.url + '/anthropic';
    const a3 = await fx.evaluate(`(async () => {
      const sel = document.getElementById('providerPresetSelect');
      sel.value = 'openai-compatible';
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      const cards = document.querySelectorAll('#providersList .prov-card');
      const card = cards[cards.length - 1];
      const d = window.state.providersDraft[window.state.providersDraft.length - 1];
      const bi = card.querySelector('[data-prov-field=baseUrl]');
      const style0 = card.querySelector('.prov-style-select').value;
      bi.value = ${JSON.stringify(gwUrl + '/v1/messages')}; bi.dispatchEvent(new Event('input', { bubbles: true }));
      const afterInput = { style: card.querySelector('.prov-style-select').value, apiStyle: d.apiStyle, note: card.querySelector('.prov-url-note').textContent, noteShown: !card.querySelector('.prov-url-note').hidden };
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const afterBlur = { value: bi.value, baseUrl: d.baseUrl, note: card.querySelector('.prov-url-note').textContent };
      // A4:手动改回 chat,再改地址 —— 不再自动切
      const sc = card.querySelector('.prov-style-select');
      sc.value = 'chat'; sc.dispatchEvent(new Event('change', { bubbles: true }));
      bi.value = ${JSON.stringify(gwUrl)}; bi.dispatchEvent(new Event('input', { bubbles: true }));
      const afterManual = { style: sc.value, apiStyle: d.apiStyle || '' };
      return { style0, afterInput, afterBlur, afterManual };
    })()`);
    ok(a3.style0 === 'chat' && a3.afterInput.style === 'anthropic' && a3.afterInput.apiStyle === 'anthropic' && a3.afterInput.noteShown && /Anthropic/.test(a3.afterInput.note),
      `A3 粘 …/anthropic/v1/messages:协议自动切到 Anthropic 并提示(${JSON.stringify(a3.afterInput)})`);
    ok(a3.afterBlur.value === gwUrl && a3.afterBlur.baseUrl === gwUrl,
      `A3 失焦后剥掉端点后缀(${JSON.stringify(a3.afterBlur)})`);
    ok(a3.afterManual.style === 'chat' && a3.afterManual.apiStyle === '', `A4 手动选过协议后不再被地址改掉(${JSON.stringify(a3.afterManual)})`);

    // ── A5 测试连接(网关没有模型清单) ──
    const a5 = await fx.evaluate(`(async () => {
      const cards = document.querySelectorAll('#providersList .prov-card');
      const idx = cards.length - 2;   // A1 加的那张 Anthropic 卡
      const d = window.state.providersDraft[idx];
      d.baseUrl = ${JSON.stringify(gwUrl)}; d.apiKey = 'sk-gw'; d.model = 'gw-model'; d.models = [{ id: 'gw-model', label: 'gw-model' }];
      cards[idx].querySelector('.prov-head .file-label').click();
      for (let i = 0; i < 300; i++) {   // 30 秒:并行四个浏览器件时试探往返可能要好几秒
        await new Promise(r => setTimeout(r, 100));
        const st = document.getElementById('provStatus_' + idx);
        if (st && /[✓✗]/.test(st.textContent)) return { text: st.textContent, good: st.classList.contains('good') };
      }
      return { text: (document.getElementById('provStatus_' + idx) || {}).textContent || '', good: false };
    })()`);
    ok(a5.good && /gw-model/.test(a5.text) && !/端点地址/.test(a5.text), `A5 没有模型清单的网关用填好的模型测通(${JSON.stringify(a5)})`);
    ok(gw.requests.some(r => r.stream === false && r.headers['x-api-key'] === 'sk-gw' && /\/anthropic\/v1\/messages$/.test(r.url)), 'A5 试探请求打到 /anthropic/v1/messages、带 x-api-key');

    // ── A6 向导共用的草稿收拾 ──
    const a6 = await fx.evaluate(`(async () => {
      const mod = await import('/js/provider-settings.js');
      const draft = mod.normalizeProviderDraftEndpoint({ id: 'openai-compatible', baseUrl: ' https://api.deepseek.com/anthropic/v1/messages ' });
      const keep = mod.normalizeProviderDraftEndpoint({ id: 'x', apiStyle: 'responses', baseUrl: 'https://api.example.com/anthropic' });
      return { draft, keep };
    })()`);
    ok(a6.draft.apiStyle === 'anthropic' && a6.draft.baseUrl === 'https://api.deepseek.com/anthropic', `A6 OpenAI 兼容预设 + /anthropic 地址 → 补协议、剥后缀(${JSON.stringify(a6.draft)})`);
    ok(a6.keep.apiStyle === 'responses', 'A6 草稿已写了协议就不改');

    await sleep(100);
    ok(fx.exceptions.length === before, `A7 全程零未捕获异常(${JSON.stringify(fx.exceptions.slice(before))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
    await gw.close();
  }
  t.done({ exit: true });
})();
