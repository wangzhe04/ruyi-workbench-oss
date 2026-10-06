#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 59 号文 §6(语音词库第二步「从修改里学」)的真浏览器件:麦克风 → 落字 → 用户改字 → 发送 → 学会 → 设置页看得见、能关。
//
// 形状:公共夹具 lib/browser-fixture 起工作台与无头浏览器(带假麦克风开关);一个进程内假端点(lib/fake-openai-provider)
// 同时当对话模型(回「好。」)与整段识别(/v1/audio/transcriptions 回一句「先把刀客装好再说」)。句尾改错关着(asrFixMode:off)
// → 只走读音规则:Docker 在原厂表里,一次就学会。
//   L1 首屏就绪,麦克风能录(配了语音识别)
//   L2 点麦克风 → 停 → 转写落进输入框(按停顿切段那一路)
//   L3 用户把「刀客」改成「Docker」、点发送 → 前端交给 /api/audio/lexicon/observe 的正是「机器写的那一句 ＋ 发出去的字」
//   L4 提示一句「记住了:刀客 → Docker」;盘上 voice-lexicon.json 里 Docker 是学来的、带错听样子
//   L5 设置 → 语音识别 → 语音词库:文本框里有「Docker = 刀客」、「从我的修改里学」勾着、计数说了学来几个
//   L6 取消勾选 → 落盘 learn:false、提示「已关闭」;再发一条 → 服务端回 learn:false、盘上不变
//   L7 管家视角的输入行发送也交给服务端(同一个发送事件)
//   L8 零未捕获异常
// 判定行:`VOICE LEARN BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { startFakeProvider } = require('./lib/fake-openai-provider');
const { createRunner } = require('./lib/harness');

const t = createRunner('VOICE LEARN BROWSER');
const { ok } = t;
const ZH = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const fill = (s, params) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));

(async () => {
  let fx = null, fake = null;
  try {
    fake = await startFakeProvider({
      handler: () => '好。',
      fallback(req, res) {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ text: '先把刀客装好再说' }));
            return;
          }
          res.writeHead(404); res.end();
        });
      },
    });
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-voice-learn-', width: 1400, height: 900,
      browserArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      config: {
        uiMode: 'pro',
        providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model',
          models: [{ id: 'fake-model', label: 'Fake' }, { id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }] }],
        activeProvider: 'fake', asrProviderId: 'fake', asrModel: 'whisper-1', asrFixMode: 'off',
      },
    });
    const lexDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(fx.home, 'voice-lexicon.json'), 'utf8')); } catch { return null; } };

    /* ── L1 首屏 ── */
    ok(Boolean(await fx.setLens('classic')), 'L1a 工作台视角');
    ok(Boolean(await fx.waitForEval(`(() => { const b = document.getElementById('composerVoiceBtn'); return b && b.dataset.state === 'idle' ? 1 : null; })()`, 300)), 'L1b 麦克风能录(配了语音识别)');
    await fx.evaluate(`(() => {
      if (window.__learnProbe) return true;
      const probe = window.__learnProbe = { observe: [], toasts: [], errors: [] };
      const original = window.fetch;
      window.fetch = function (input, init) {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (url.indexOf('/api/audio/lexicon/observe') >= 0) {
          const entry = { body: (() => { try { return JSON.parse(String(init && init.body || '{}')); } catch { return null; } })(), reply: null };
          probe.observe.push(entry);
          return original.apply(this, arguments).then(res => { res.clone().json().then(j => { entry.reply = j; }).catch(() => {}); return res; });
        }
        return original.apply(this, arguments);
      };
      window.addEventListener('error', event => probe.errors.push(String(event.message || 'error')));
      window.addEventListener('unhandledrejection', event => probe.errors.push('unhandled: ' + String(event.reason && (event.reason.message || event.reason))));
      const scan = () => { for (const n of document.querySelectorAll('.toast')) { if (!n.__seen) { n.__seen = true; probe.toasts.push(n.textContent || ''); } } };
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);
    const PROBE = `(() => { const p = window.__learnProbe; return JSON.parse(JSON.stringify({ observe: p.observe, toasts: p.toasts, errors: p.errors })); })()`;

    /* ── L2 录一句 ── */
    await fx.evaluate(`(() => { const box = document.getElementById('promptInput'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); box.focus(); return true; })()`);
    await fx.evaluate(`(document.getElementById('composerVoiceBtn').click(), true)`);
    ok(Boolean(await fx.waitForEval(`(() => { const b = document.getElementById('composerVoiceBtn'); return b && b.dataset.state === 'recording' ? 1 : null; })()`, 300)), 'L2a 点麦克风进入录音态');
    await sleep(900);
    await fx.evaluate(`(document.getElementById('composerVoiceBtn').click(), true)`);
    const heard = await fx.waitForEval(`(() => { const v = document.getElementById('promptInput').value; return v.includes('先把刀客装好再说') ? v : null; })()`, 400);
    ok(heard === '先把刀客装好再说', `L2b 转写落进输入框(实得 ${JSON.stringify(heard)})`);

    /* ── L3 改字、发送 ── */
    await fx.evaluate(`(() => { const box = document.getElementById('promptInput'); box.value = box.value.replace('刀客', 'Docker'); box.dispatchEvent(new Event('input', { bubbles: true })); return box.value; })()`);
    await fx.evaluate(`(document.getElementById('sendBtn').click(), true)`);
    const sent = await fx.waitForEval(`(() => { const p = window.__learnProbe; return p.observe.length && p.observe[0].reply ? 1 : null; })()`, 300);
    const p1 = await fx.evaluate(PROBE);
    const o1 = p1.observe[0] || {};
    ok(Boolean(sent) && JSON.stringify(o1.body) === JSON.stringify({ sentences: [{ text: '先把刀客装好再说', first: '先把刀客装好再说' }], final: '先把Docker装好再说' }),
      `L3 发送时交给服务端的是「机器写的那一句 ＋ 发出去的字」(实得 ${JSON.stringify(o1.body)})`);

    /* ── L4 学会了 ── */
    const want = fill(ZH['composer.voice.learned'], { heard: '刀客', term: 'Docker', more: '' });
    const toast = await fx.waitForEval(`(() => window.__learnProbe.toasts.find(x => x.includes(${JSON.stringify(want)})) || null)()`, 200);
    ok(Boolean(toast) && o1.reply && o1.reply.learned && o1.reply.learned[0].term === 'Docker', `L4a 提示一句「${want}」(实得 toasts=${JSON.stringify(p1.toasts)})`);
    const d1 = lexDisk();
    ok(Boolean(d1) && d1.terms.docker && d1.terms.docker.src === 'learned' && d1.terms.docker.heard.join() === '刀客', `L4b 盘上 Docker 是学来的、带错听样子(实得 ${JSON.stringify(d1 && d1.terms)})`);

    /* ── L5 设置页 ── */
    // 与待开启的麦克风同一条路:派「去语音识别设置」那一帧(打开设置弹窗、落在语音识别页签,卡片随之重读)
    await fx.evaluate(`(() => { document.dispatchEvent(new CustomEvent('ruyi:open-voice-settings')); return true; })()`);
    const card = await fx.waitForEval(`(() => {
      const block = document.querySelector('#stab-voice .asr-lexicon');
      if (!block) return null;
      const area = block.querySelector('.asr-lexicon-text'), learn = block.querySelector('.asr-lexicon-learn input'), count = block.querySelector('.asr-lexicon-count');
      if (!area || !learn || !/Docker/.test(area.value)) return null;
      return { text: area.value, learn: learn.checked, learnLabel: block.querySelector('.asr-lexicon-learn span').textContent, count: count.textContent, order: [...block.children].map(n => n.className).join('|') };
    })()`, 300);
    ok(Boolean(card) && card.text.split('\n').includes('Docker = 刀客') && card.learn === true && card.learnLabel === ZH['settings.asrLexicon.learn'],
      `L5a 语音词库卡:文本框里有「Docker = 刀客」、「从我的修改里学」勾着(实得 ${JSON.stringify(card && { text: card.text, learn: card.learn })})`);
    ok(Boolean(card) && card.count === fill(ZH['settings.asrLexicon.countLearned.one'], { count: 1, learned: 1, typed: 0, pending: 0 }), `L5b 计数说了学来几个(实得 ${JSON.stringify(card && card.count)})`);
    ok(Boolean(card) && /asr-lexicon-actions\|asr-lexicon-toggle asr-lexicon-learn\|asr-lexicon-toggle asr-lexicon-base/.test(card.order), `L5c 开关排在保存那一行之后、内置表开关之前(实得 ${card && card.order})`);

    /* ── L6 关掉 ── */
    await fx.evaluate(`(document.querySelector('#stab-voice .asr-lexicon-learn input').click(), true)`);
    const off = await fx.waitForEval(`(() => { const b = document.querySelector('#stab-voice .asr-lexicon-learn input'); return b && !b.disabled && !b.checked ? 1 : null; })()`, 200);
    await sleep(200);
    ok(Boolean(off) && (lexDisk() || {}).learn === false, 'L6a 取消勾选 → 落盘 learn:false');
    const p6 = await fx.evaluate(PROBE);
    ok(p6.toasts.some(x => x.includes(ZH['settings.asrLexicon.learnOff'])), 'L6b 提示「已关闭」');
    await fx.escape();
    ok(Boolean(await fx.waitForEval(`(() => { const m = document.getElementById('settingsModal'); return m && !m.getClientRects().length ? 1 : null; })()`, 100)), 'L6c0 关掉设置');
    const before = fs.readFileSync(path.join(fx.home, 'voice-lexicon.json'), 'utf8');
    await fx.evaluate(`(() => { const box = document.getElementById('promptInput'); box.value = '再看下 FooBar 的日志'; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await fx.waitForEval(`(() => { const s = document.getElementById('sendBtn'); return s && !s.disabled ? 1 : null; })()`, 200);
    await fx.evaluate(`(document.getElementById('sendBtn').click(), true)`);
    const second = await fx.waitForEval(`(() => { const p = window.__learnProbe; return p.observe.length >= 2 && p.observe[1].reply ? p.observe[1] : null; })()`, 300);
    ok(Boolean(second) && second.reply.learn === false && second.body.final === '再看下 FooBar 的日志' && JSON.stringify(second.body.sentences) === '[]' && fs.readFileSync(path.join(fx.home, 'voice-lexicon.json'), 'utf8') === before,
      `L6c 关着时:没用麦克风的消息照样交(只有打的字)、服务端回 learn:false、盘上不变(实得 ${JSON.stringify(second && second.reply)})`);

    /* ── L7 管家输入行 ── */
    ok(Boolean(await fx.setLens('steward')), 'L7a 管家视角');
    const n7 = (await fx.evaluate(PROBE)).observe.length;
    await fx.waitForEval(`(() => document.getElementById('stewardComposerInput') && document.getElementById('stewardComposerSend') ? 1 : null)()`, 300);
    await fx.evaluate(`(() => { const box = document.getElementById('stewardComposerInput'); box.focus(); box.value = '管家这边也说一句'; box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('stewardComposerSend').click(); return true; })()`);
    const stewardSent = await fx.waitForEval(`(() => { const p = window.__learnProbe; return p.observe.length > ${n7} ? p.observe[p.observe.length - 1].body : null; })()`, 300);
    ok(Boolean(stewardSent) && stewardSent.final === '管家这边也说一句', `L7b 管家输入行发送也交给服务端(实得 ${JSON.stringify(stewardSent)})`);

    /* ── L8 ── */
    const p8 = await fx.evaluate(PROBE);
    ok(p8.errors.length === 0 && fx.exceptions.length === 0, `L8 零未捕获异常(实得 ${JSON.stringify([...p8.errors, ...fx.exceptions]).slice(0, 300)})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close().catch(() => {});
    if (fake) await fake.close().catch(() => {});
  }
  t.done({ exit: true });
})();
