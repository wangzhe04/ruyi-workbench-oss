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
//   A3b(第三波复核)自动切换会切回:敲到 …/anthropic 的前缀会切过去,继续敲成 …/anthropic-proxy/v1 要切回 chat、提示收掉;
//       改粘别的地址也切回;切换前是 responses 的卡切回 responses 并且「服务端搜索」没丢;
//   A4b 手动选过协议后,地址怎么改都不自动切(也不会被「切回」动到);存量就是 Anthropic 的卡,地址改成别的不被切走;
//   A3c 粘完整端点(…/v1/messages)失焦剥掉后缀后,协议不会因为「剥完的地址推断不出来了」被切回(证据随后缀一起走了,这次切换就定下来);
//   A7 全程零未捕获异常;
//   A9 向导重开后再粘完整端点:复用已存的那条服务商(不重复建 -2、不要求重填 key);
//   A8(第三波复核)英文界面下向导「测试连接」的失败文案是英文(按 provider.test_* code 取词,与设置页同一张表),也不再说中文「端点地址」;
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

    // ── A3b / A4b 自动切换会切回;手动选过的不动 ──
    const a3b = await fx.evaluate(`(async () => {
      const sel = document.getElementById('providerPresetSelect');
      sel.value = 'openai-compatible';
      const cardOf = n => document.querySelectorAll('#providersList .prov-card')[n];
      const typeInto = async (card, url) => {
        const bi = card.querySelector('[data-prov-field=baseUrl]');
        let v = '';
        for (const ch of url) { v += ch; bi.value = v; bi.dispatchEvent(new Event('input', { bubbles: true })); }
        return bi;
      };
      // ① 逐键敲 …/anthropic-proxy/v1:中途切到 Anthropic,敲到「-」切回 chat,提示收掉
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      let n = window.state.providersDraft.length - 1;
      let d = window.state.providersDraft[n];
      const styleOf = () => document.querySelectorAll('#providersList .prov-card')[n].querySelector('.prov-style-select').value;
      const noteOf = () => { const e = document.querySelectorAll('#providersList .prov-card')[n].querySelector('.prov-url-note'); return { text: e.textContent, hidden: e.hidden }; };
      let bi = await typeInto(cardOf(n), 'https://x.example/openai/anthropic');
      const mid = { style: styleOf(), apiStyle: d.apiStyle || '', note: noteOf() };
      bi = await typeInto(cardOf(n), 'https://x.example/openai/anthropic-proxy/v1');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const typed = { style: styleOf(), apiStyle: d.apiStyle || '', note: noteOf(), baseUrl: d.baseUrl };
      // ② 粘 /anthropic(切)→ 改粘 chat 地址(切回)
      await typeInto(cardOf(n), 'https://api.deepseek.com/anthropic');
      const pasted = { style: styleOf(), apiStyle: d.apiStyle || '' };
      bi = await typeInto(cardOf(n), 'https://api.deepseek.com/v1');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const back = { style: styleOf(), apiStyle: d.apiStyle || '', noteHidden: noteOf().hidden };
      // ③ 切换前是 responses 且勾了服务端搜索:切走再切回,协议与「服务端搜索」都回来
      d.apiStyle = 'responses'; d.serverWebSearch = true; d.baseUrl = 'https://api.example.com';
      document.getElementById('addProviderBtn').click();   // 整张重画,卡片按草稿重建
      await new Promise(r => setTimeout(r, 80));
      const styleResp = styleOf();
      await typeInto(cardOf(n), 'https://api.example.com/anthropic');
      const toAnth = { style: styleOf(), sws: d.serverWebSearch === true };
      bi = await typeInto(cardOf(n), 'https://api.example.com');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const fromAnth = { style: styleOf(), apiStyle: d.apiStyle || '', sws: d.serverWebSearch === true, swsChecked: !!cardOf(n).querySelector('.prov-server-search input').checked };
      // A4b ④ 手动选过 anthropic:地址落空也不切回;存量就是 anthropic 的卡:地址改成别的不被切走
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      n = window.state.providersDraft.length - 1; d = window.state.providersDraft[n];
      const sc = cardOf(n).querySelector('.prov-style-select');
      sc.value = 'anthropic'; sc.dispatchEvent(new Event('change', { bubbles: true }));
      await typeInto(cardOf(n), 'https://api.deepseek.com/anthropic');
      bi = await typeInto(cardOf(n), 'https://api.deepseek.com/v1');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const manual = { style: styleOf(), apiStyle: d.apiStyle || '' };
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      n = window.state.providersDraft.length - 1; d = window.state.providersDraft[n];
      d.apiStyle = 'anthropic'; d.baseUrl = 'https://api.deepseek.com/anthropic';
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      bi = await typeInto(cardOf(n), 'https://my-own-gateway.example/anthropic-ish');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const saved = { style: styleOf(), apiStyle: d.apiStyle || '' };
      return { mid, typed, pasted, back, styleResp, toAnth, fromAnth, manual, saved };
    })()`);
    ok(a3b.mid.style === 'anthropic' && a3b.mid.apiStyle === 'anthropic', `A3b 敲到 …/anthropic 先切到 Anthropic(${JSON.stringify(a3b.mid)})`);
    ok(a3b.typed.style === 'chat' && a3b.typed.apiStyle === '' && a3b.typed.note.hidden && a3b.typed.baseUrl === 'https://x.example/openai/anthropic-proxy/v1',
      `A3b 继续敲成 …/anthropic-proxy/v1:切回 chat、提示收掉(${JSON.stringify(a3b.typed)})`);
    ok(a3b.pasted.style === 'anthropic' && a3b.back.style === 'chat' && a3b.back.apiStyle === '' && a3b.back.noteHidden,
      `A3b 粘 /anthropic 切过去,改粘 chat 地址切回(${JSON.stringify([a3b.pasted, a3b.back])})`);
    ok(a3b.styleResp === 'responses' && a3b.toAnth.style === 'anthropic' && a3b.fromAnth.style === 'responses' && a3b.fromAnth.apiStyle === 'responses' && a3b.fromAnth.sws && a3b.fromAnth.swsChecked,
      `A3b 切换前是 responses:切回 responses,且「服务端搜索」没丢(${JSON.stringify([a3b.styleResp, a3b.toAnth, a3b.fromAnth])})`);
    ok(a3b.manual.style === 'anthropic' && a3b.manual.apiStyle === 'anthropic', `A4b 手动选过 Anthropic:地址落空也不切回(${JSON.stringify(a3b.manual)})`);
    ok(a3b.saved.style === 'anthropic' && a3b.saved.apiStyle === 'anthropic', `A4b 存量就是 Anthropic 的卡:地址改成别的不被切走(${JSON.stringify(a3b.saved)})`);

    const a3c = await fx.evaluate(`(async () => {
      document.getElementById('providerPresetSelect').value = 'openai-compatible';
      document.getElementById('addProviderBtn').click();
      await new Promise(r => setTimeout(r, 80));
      const n = window.state.providersDraft.length - 1, d = window.state.providersDraft[n];
      const card = () => document.querySelectorAll('#providersList .prov-card')[n];
      const bi = card().querySelector('[data-prov-field=baseUrl]');
      const type = url => { let v = ''; for (const ch of url) { v += ch; bi.value = v; bi.dispatchEvent(new Event('input', { bubbles: true })); } };
      type('https://gw.example/v1/messages');
      bi.dispatchEvent(new Event('change', { bubbles: true }));
      const pasted = { style: card().querySelector('.prov-style-select').value, baseUrl: d.baseUrl, apiStyle: d.apiStyle || '' };
      type('https://gw.example/x');
      return { pasted, after: { style: card().querySelector('.prov-style-select').value, apiStyle: d.apiStyle || '' } };
    })()`);
    ok(a3c.pasted.style === 'anthropic' && a3c.pasted.baseUrl === 'https://gw.example', `A3c 粘 …/v1/messages 失焦:协议是 Anthropic、后缀剥掉了(${JSON.stringify(a3c.pasted)})`);
    ok(a3c.after.style === 'anthropic' && a3c.after.apiStyle === 'anthropic', `A3c 剥完之后接着编辑地址:不因为推断落空被切回(${JSON.stringify(a3c.after)})`);

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

    // ── A8 英文界面下向导「测试连接」的失败文案(第三波复核):按 provider.test_* code 取词,不再把服务端的中文兜底句端出来 ──
    await fx.close(); fx = null;
    const KEY = 'sk-gw-key';
    const gw2 = await startFakeAnthropic({ models: null, handler: ctx => {
      if (ctx.headers['x-api-key'] !== KEY) return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
      if (ctx.body && ctx.body.model === 'no-such-model') return { status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'model: no-such-model' } } };
      return messageEvents({ text: 'pong', model: 'gw-model' });
    } });
    try {
      fx = await startBrowserFixture({ ok, prefix: 'ruyi-anth-wiz-', config: { locale: 'en-US', providers: [], activeProvider: '' } });
      const wBefore = fx.exceptions.length;
      await fx.evaluate(`(document.getElementById('reopenOnboardingBtn').click(), true)`);
      ok(Boolean(await fx.waitForEval(`document.querySelector('.onboard-wiz-next') ? 1 : null`, 200)), 'A8 英文向导打开了');
      await fx.evaluate(`(document.querySelector('.onboard-wiz-next').click(), true)`);
      await sleep(300);
      await fx.evaluate(`(document.querySelectorAll('.onboard-wiz-engine .onboard-wiz-card')[0].click(), true)`);
      await sleep(200);
      await fx.evaluate(`(document.querySelector('.onboard-wiz-next').click(), true)`);
      await sleep(400);
      const wizTest = async (apiKey, model) => fx.evaluate(`(async () => {
        const q = s => document.querySelector(s);
        const adv = q('.onboard-wiz-advanced'); if (adv) adv.open = true;
        const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(q('.onboard-wiz-baseurl'), ${JSON.stringify(gw2.url + '/anthropic/v1/messages')});
        set([...document.querySelectorAll('.onboard-wiz-body input')].find(i => i.type === 'password'), ${JSON.stringify(apiKey)});
        set(q('.onboard-wiz-model'), ${JSON.stringify(model)});
        const before = (q('.onboard-wiz-status') || {}).textContent || '';
        q('.onboard-wiz-test').click();
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 100));
          const st = q('.onboard-wiz-status');
          if (st && st.textContent.trim() && st.textContent !== before && /err|ok/.test(st.className)) return { text: st.textContent.trim(), cls: st.className };
        }
        return { text: 'timeout' };
      })()`);
      const noCjk = text => !/[\u3400-\u9fff]/.test(text);
      const w1 = await wizTest(KEY, '');
      ok(/err/.test(w1.cls) && /model/i.test(w1.text) && noCjk(w1.text), `A8 没填模型 → 英文的「先填模型名」(${JSON.stringify(w1)})`);
      const w2 = await wizTest('sk-wrong', 'gw-model');
      ok(/err/.test(w2.cls) && /key/i.test(w2.text) && noCjk(w2.text), `A8 错 key → 英文的「密钥无效」(${JSON.stringify(w2)})`);
      const w3 = await wizTest(KEY, 'no-such-model');
      ok(/err/.test(w3.cls) && /model name/i.test(w3.text) && !/address/i.test(w3.text) && noCjk(w3.text), `A8 模型名写错(404 正文点名模型)→ 英文的「模型名可能不对」,不是「地址不对」(${JSON.stringify(w3)})`);
      const w4 = await wizTest(KEY, 'gw-model');
      ok(/ok/.test(w4.cls) && noCjk(w4.text), `A8 填对之后测通(${JSON.stringify(w4)})`);
      ok(fx.exceptions.length === wBefore, `A8 英文向导零未捕获异常(${JSON.stringify(fx.exceptions.slice(wBefore))})`);
    } finally { await gw2.close(); }

    // ── A9 向导重开后再粘完整端点:已存的服务商地址是剥过后缀的,比较要过同一道剥除 → 复用它(沿用它存好的 key),不重复建 -2 ──
    await fx.close(); fx = null;
    const gw3 = await startFakeAnthropic({ models: null, handler: ctx => (ctx.headers['x-api-key'] === 'sk-saved-key' ? messageEvents({ text: 'pong', model: 'gw-model' }) : { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }) });
    try {
      fx = await startBrowserFixture({ ok, prefix: 'ruyi-anth-reuse-', config: { locale: 'en-US', activeProvider: 'openai-compatible', providers: [
        { id: 'openai-compatible', label: 'Custom', type: 'openai-compat', apiStyle: 'anthropic', baseUrl: gw3.url + '/anthropic', apiKey: 'sk-saved-key', model: 'gw-model', models: [{ id: 'gw-model', label: 'gw-model' }] },
      ] } });
      await fx.evaluate(`(document.getElementById('reopenOnboardingBtn').click(), true)`);
      ok(Boolean(await fx.waitForEval(`document.querySelector('.onboard-wiz-next') ? 1 : null`, 200)), 'A9 向导打开了');
      await fx.evaluate(`(document.querySelector('.onboard-wiz-next').click(), true)`);
      await sleep(300);
      await fx.evaluate(`(document.querySelectorAll('.onboard-wiz-engine .onboard-wiz-card')[0].click(), true)`);
      await sleep(200);
      await fx.evaluate(`(document.querySelector('.onboard-wiz-next').click(), true)`);
      await sleep(400);
      const a9 = await fx.evaluate(`(async () => {
        const q = s => document.querySelector(s);
        const adv = q('.onboard-wiz-advanced'); if (adv) adv.open = true;
        const url = q('.onboard-wiz-baseurl');
        url.value = ${JSON.stringify(gw3.url + '/anthropic/v1/messages')}; url.dispatchEvent(new Event('input', { bubbles: true }));
        const sent = [];
        const realFetch = window.fetch;
        window.fetch = async (input, init) => { try { if (String(input).includes('/api/provider/test')) sent.push(JSON.parse(init.body).provider); } catch {} return realFetch(input, init); };
        q('.onboard-wiz-test').click();
        for (let i = 0; i < 100; i++) {
          await new Promise(r => setTimeout(r, 100));
          const st = q('.onboard-wiz-status');
          if (st && st.textContent.trim() && /err|ok/.test(st.className)) { window.fetch = realFetch; return { text: st.textContent.trim(), cls: st.className, sentIds: sent.map(x => x.id), sentKeyMasked: sent.map(x => String(x.apiKey || '').startsWith('•')) }; }
        }
        window.fetch = realFetch;
        return { text: 'timeout', sentIds: sent.map(x => x.id) };
      })()`);
      ok(/ok/.test(a9.cls) && JSON.stringify(a9.sentIds) === '["openai-compatible"]' && a9.sentKeyMasked[0] === true,
        `A9 粘完整端点、没重填 key:复用已存的 openai-compatible(沿用它的 key),测试连接发的是它(${JSON.stringify(a9)})`);
    } finally { await gw3.close(); }
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
    await gw.close();
  }
  t.done({ exit: true });
})();
