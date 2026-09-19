#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-⑭(用户 2026-09-19:「当前前端并没有语音输入和语音转文字的入口」;拍板 A:未配置也显示,点它去设置里开启)。
//
// 修前:输入框麦克风只在「语音识别配好」时才建节点;设置页「语音识别」那一栏只在某个模型被标成可语音识别时才出现 ——
// 而界面上没有任何地方能标它(只能手改 config.json)。一台正常装好的机器上,语音入口一个都看不见。
// 判据(真服务 ＋ 无头浏览器;夹具的服务商只有一个聊天模型,没有任何可语音识别的模型):
//   V1 没配语音识别:两个视角的输入框里都有一枚待开启的麦克风(data-state="setup"),提示说清「还没开启、点这里去设置」。
//   V2 点工作台那一枚:设置页打开、落在「服务商」页签、「语音识别」那一栏在(无候选也渲染),焦点落在「模型名」输入框。
//   V3 在那一栏里选服务商、填模型名、点「添加并启用」:配置里那个服务商多了一条带 asr 能力的模型、语音识别选中了它;
//      【密钥没被冲掉】(整份 providers 回写要经服务端的掩码合并 —— 读盘上的 config.json 核)。
//   V4 不用重载:两个视角的麦克风都从待开启变成能录(data-state="idle");设置页那一栏变成选择器且选中了它。
//   V5 选择器切回「不启用」:两枚麦克风回到待开启(修前是整个拆掉)。
// 判定行:`VOICE SETUP BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const ZH = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-voice-setup-', width: 1400, height: 900 });
    const mic = id => fx.evaluate(`(() => { const b = document.getElementById(${JSON.stringify(id)});
      return b ? { state: b.dataset.state || '', title: b.title || '', label: b.getAttribute('aria-label') || '', pressed: b.getAttribute('aria-pressed') } : null; })()`);
    const waitMic = (id, state) => fx.waitForEval(`(() => { const b = document.getElementById(${JSON.stringify(id)}); return b && b.dataset.state === ${JSON.stringify(state)} ? 1 : null; })()`, 150);

    /* ── V1 两个视角都有待开启的麦克风 ── */
    ok(Boolean(await fx.setLens('classic')), 'V0 工作台视角');
    ok(Boolean(await waitMic('composerVoiceBtn', 'setup')), 'V1a 工作台输入框里有一枚待开启的麦克风(data-state="setup")');
    const wb = await mic('composerVoiceBtn');
    ok(Boolean(wb) && wb.title === ZH['composer.voice.setupHint'] && wb.label === ZH['composer.voice.label'] && wb.pressed === 'false',
      `V1b 提示说清「还没开启、点这里去设置」,可访问名仍是「语音输入」(实测 ${JSON.stringify(wb)})`);
    ok(Boolean(await fx.setLens('steward')), 'V1c 管家视角');
    ok(Boolean(await waitMic('stewardComposerVoice', 'setup')), 'V1d 管家输入框里也有一枚待开启的麦克风');
    ok(Boolean(await fx.setLens('classic')), 'V1e 回到工作台视角');

    /* ── V2 点它 → 设置页落在语音识别那一栏 ── */
    await fx.evaluate(`(document.getElementById('composerVoiceBtn').click(), true)`);
    const landed = await fx.waitForEval(`(() => {
      const modal = document.getElementById('settingsModal');
      const tab = document.getElementById('stab-providers');
      const block = document.querySelector('#stab-providers .asr-settings');
      const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      if (!visible(modal) || !visible(tab) || !block) return null;
      const active = document.activeElement;
      return { focused: active ? active.className : '', text: block.textContent, hasAdd: Boolean(block.querySelector('.asr-add-provider') && block.querySelector('.asr-add-model') && block.querySelector('.asr-add-btn')) };
    })()`, 150);
    ok(Boolean(landed) && landed.hasAdd && landed.text.includes(ZH['settings.asr.none']),
      `V2 设置页打开、落在「服务商」页签,「语音识别」那一栏无候选也在,带添加口(实测 ${JSON.stringify(landed && { hasAdd: landed.hasAdd, focused: landed.focused })})`);
    ok(Boolean(landed) && /asr-add-model/.test(landed.focused), `V2b 焦点落在「模型名」输入框(实测 activeElement.className=${landed && landed.focused})`);

    /* ── V3 添加并启用 ── */
    const before = JSON.parse(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8'));
    const keyBefore = ((before.providers || []).find(p => p && p.id === 'fake') || {}).apiKey;
    await fx.evaluate(`(() => {
      const block = document.querySelector('#stab-providers .asr-settings');
      block.querySelector('.asr-add-provider').value = 'fake';
      const input = block.querySelector('.asr-add-model');
      input.value = 'fake-asr';
      block.querySelector('.asr-add-btn').click();
      return true;
    })()`);
    const saved = await fx.waitForEval(`(() => { const c = window.state && window.state.config; return c && c.asrProviderId === 'fake' && c.asrModel === 'fake-asr' ? 1 : null; })()`, 150);
    const disk = JSON.parse(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8'));
    const fake = (disk.providers || []).find(p => p && p.id === 'fake') || {};
    const asrModel = (fake.models || []).find(m => m && typeof m === 'object' && m.id === 'fake-asr');
    ok(Boolean(saved) && disk.asrProviderId === 'fake' && disk.asrModel === 'fake-asr' && Boolean(asrModel) && Array.isArray(asrModel.caps) && asrModel.caps.includes('asr'),
      `V3 添加并启用:盘上 config.json 里服务商多了一条带 asr 能力的模型、语音识别选中了它(实测 asr=${disk.asrProviderId}/${disk.asrModel} 模型 ${JSON.stringify(asrModel)})`);
    ok(Boolean(keyBefore) && fake.apiKey === keyBefore, `V3b 整份服务商回写没冲掉密钥(前 ${keyBefore ? '有' : '无'}、后 ${fake.apiKey === keyBefore ? '原样' : '变了:' + String(fake.apiKey).slice(0, 6)})`);
    ok((fake.models || []).some(m => (m && typeof m === 'object' ? m.id : m) === 'fake-model'), 'V3c 原来那个聊天模型还在');

    /* ── V4 不用重载,两枚麦克风都能录了 ── */
    ok(Boolean(await waitMic('composerVoiceBtn', 'idle')), `V4a 工作台那一枚当场变成能录(实测 ${JSON.stringify(await mic('composerVoiceBtn'))})`);
    const select = await fx.waitForEval(`(() => { const s = document.querySelector('#stab-providers .asr-settings .asr-select'); return s && s.value && s.value.includes('fake-asr') ? 1 : null; })()`, 100);
    ok(Boolean(select), '设置页那一栏变成选择器、选中了刚添加的模型'.replace(/^/, 'V4b '));
    await fx.escape();
    ok(Boolean(await fx.setLens('steward')) && Boolean(await waitMic('stewardComposerVoice', 'idle')), 'V4c 管家那一枚也当场变成能录');

    /* ── V5 切回「不启用」→ 回到待开启(不是拆掉) ── */
    ok(Boolean(await fx.setLens('classic')), 'V5a 回到工作台');
    // 能录态点麦克风是开始录音(无头环境没有假麦克风),这里直接派「去语音识别设置」那一帧打开设置页。
    await fx.evaluate(`(() => { document.dispatchEvent(new CustomEvent('ruyi:open-voice-settings')); return true; })()`);
    await sleep(300);
    const offed = await fx.evaluate(`(() => { const s = document.querySelector('#stab-providers .asr-settings .asr-select'); if (!s) return false; s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    ok(offed, 'V5b 设置页选择器切到「不启用」');
    ok(Boolean(await waitMic('composerVoiceBtn', 'setup')), `V5 麦克风回到待开启、没被拆掉(实测 ${JSON.stringify(await mic('composerVoiceBtn'))})`);

    ok(fx.exceptions.length === 0, `V9 页面没有未捕获异常(${fx.exceptions.slice(0, 3).join(' | ') || '无'})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: false });
  }
  console.log(fail === 0 ? 'VOICE SETUP BROWSER E2E: ALL PASS' : `VOICE SETUP BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
