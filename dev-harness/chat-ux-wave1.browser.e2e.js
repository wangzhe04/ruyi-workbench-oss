#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：前端走查第一波·聊天区（W1-chat）十五条 + 补充三条的回归。
// 做法：公共夹具 lib/browser-fixture 起隔离工作台 + 假 provider + 无头浏览器，判据全落在真页面的真 DOM / 真键鼠事件上。
// 两套夹具：A（默认权限档，覆盖大部分）、B（计划档，覆盖计划卡相关两条）。
//
//   F1  计划等待批准时切会话再切回:实时壳重建后计划卡的批准 / 修改意见 / 放弃按钮还在(查活 DOM 去重,不查页面级 Set);
//       已批准的计划切回来是收起的已决态,不再亮按钮。
//   F2  空会话里对同一句连按两次 Enter:只建一个会话、只发一遍。
//   F3  Esc 只管自己这一层:附件大图查看器按 Esc → 只关查看器(不停回合),焦点回到缩略图;左栏搜索框按 Esc → 不停回合;
//       焦点在页面上(不在输入框)时 Esc 仍然停回合(对照)。补充 A:叠层弹窗一次 Esc 只关最上面一层。
//       补充 B:查看器 aria-modal、打开时聚焦。
//   F4  提问弹窗写了一半的回答(文字 + 多选)Esc 收起、从右下角小窗重开后原样回填。
//   F5  鼠标点「发送」后焦点回到输入框,紧接着的空格不会把回合停掉。
//   F6  粘贴时剪贴板同时有文字和图片:不拦截(文字照常粘),只有图片时才当附件。
//   F7  往输入框里拖文字:不拦截、不弹「拖文件」遮罩;拖文件才接管。
//   F8  见 composer-voice-stream.browser.e2e.js 的 D3(语音 Esc 取消后在途回包不再落字)。
//   F9  「重试」带上原附件;流式中点「重试」被挡下(不变成插话);「编辑重发」把附件放回托盘、输入框有草稿时不覆盖。
//   F10 计划待批准时按「停止」:状态条不再停在「等你拍板」,计划卡按钮禁用、标成已失效。
//   F11 变更页签:没有译文的工具名 / 操作名回落到原名,不再显示 `[changes.tool.xxx]`;补上的几个键有译文。
//   F12 对话卡里的「允许」在请求失败时:申请不出队、按钮恢复,重新点才算数。
//   F13 附件上传期间:托盘有「上传中…」占位、发送被拦并提示;缩略图 blob URL 在移除 / 发送后释放。
//   F14 单文件撤回失败后按钮文字回到「撤销」,不是 tooltip 长句。
//   F15 切走再切回正在跑的会话:已完成工具的耗时按真实时间差显示,不再全是「· 0.0s」。
//   补充 C 提问没送达:提示用人话(toast.answerNotDelivered),不再是「回答发送失败：answer was not delivered」(代码级,见单测)。
// 判定行:`CHAT UX WAVE1 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('CHAT UX WAVE1 BROWSER');
const { ok } = t;

const ROOT = path.resolve(__dirname, '..');
const ZH = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/public/locales/zh-CN.json'), 'utf8'));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 假 provider 的挂起点:文字里带 HOLD 的回合在回一句话之后一直占着连接,直到测试放行(releaseAll)。
const holds = [];
const releaseAll = () => { while (holds.length) holds.pop()(); };
const hold = () => new Promise(resolve => holds.push(resolve));
const calls = [];   // 每一发请求里最后一条 user 文字

function lastUserText(ctx) {
  const last = [...ctx.messages].reverse().find(m => m.role === 'user');
  return !last ? '' : (typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
}

async function main() {
  let fx = null;
  try {
    /* ═════════════ 夹具 A:默认权限档 ═════════════ */
    const workFile = { path: '' };
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-chat-ux-a-',
      config: { stewardEnabledV1: false },
      provider: async ctx => {
        const text = lastUserText(ctx);
        // 自动起标题的那一发(「用户原话:…」)不是回合,别记、别挂起。
        if (/^用户原话:/.test(text)) { ctx.text('标题'); ctx.stop(); return; }
        calls.push(text);
        if (/ASK me/.test(text)) {
          if (!ctx.answered) {
            ctx.toolCall('request_user_input', { questions: [
              { id: 'q1', question: '项目叫什么?', answerMode: 'text' },
              { id: 'q2', question: '选哪些?', answerMode: 'multiple', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
            ] }, 'call_ask1');
            return;
          }
          ctx.text('收到,');
          await hold();
          ctx.text('完成');
          ctx.stop();
          return;
        }
        if (/PERM write/.test(text)) {
          if (!ctx.answered) { ctx.toolCall('file_write', { path: workFile.path, content: 'hello' }, 'call_perm1'); return; }
          ctx.text('写好了'); ctx.stop(); return;
        }
        // 不加行尾锚:带附件的消息文字后面还跟着 <attached_files> 段,而且每条消息末尾会被附上「本条消息发送于…」。
        if (/HOLD-(focus|attach)/.test(text)) { ctx.text('先说一句,'); await hold(); ctx.text('再说完'); ctx.stop(); return; }
        ctx.text('好的:' + text.slice(0, 20)); ctx.stop();
      },
    });
    workFile.path = path.join(fx.work, 'perm-target.txt');

    const click = async sel => {
      const rect = await fx.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!rect) throw new Error('click target missing: ' + sel);
      await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await fx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    };
    const setText = value => fx.evaluate(`(() => { const t = document.getElementById('promptInput'); t.focus(); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const streaming = () => fx.evaluate(`Boolean(window.state.streaming)`);
    const waitIdle = (attempts = 400) => fx.waitForEval(`window.state.streaming === false ? 1 : null`, attempts);
    const waitStreaming = (attempts = 400) => fx.waitForEval(`window.state.streaming === true ? 1 : null`, attempts);
    const key = (k, code, vk, text) => fx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: vk })
      .then(() => fx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }));
    const esc = () => key('Escape', 'Escape', 27);
    const upload = name => fx.evaluate(`(async () => {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': ${JSON.stringify(fx.token)} }, body: JSON.stringify({ name: ${JSON.stringify(name)}, data: ${JSON.stringify(PNG)} }) });
      return (await r.json()).file;
    })()`);
    const newThread = async () => {
      const before = await fx.evaluate(`window.state.currentSession && window.state.currentSession.id`);
      await fx.evaluate(`document.getElementById('newSessionBtn').click()`);
      await fx.waitForEval(`(window.state.currentSession && window.state.currentSession.id) !== ${JSON.stringify(before || null)} ? 1 : null`, 200);
      await sleep(300);
    };
    const openThread = async sid => {
      await fx.evaluate(`(() => { const row = [...document.querySelectorAll('#railList [data-session-id]')].find(n => n.dataset.sessionId === ${JSON.stringify(sid)}); if (!row) throw new Error('rail row missing'); row.click(); return true; })()`);
      await fx.waitForEval(`window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(sid)} ? 1 : null`, 200);
      await sleep(500);
    };
    await fx.waitForEval(`!!(window.state && window.state.sessions && document.getElementById('promptInput'))`);
    await sleep(800);
    // 记下被释放的 blob URL(F13)。
    await fx.evaluate(`(() => { window.__revoked = []; const o = URL.revokeObjectURL; URL.revokeObjectURL = u => { window.__revoked.push(String(u)); return o.call(URL, u); }; return true; })()`);

    /* ───────── F2 空会话里连按两次 Enter ───────── */
    {
      // 机器忙时偶发请求超时(request 回 null):多试几次再下结论。
      let before = null;
      for (let i = 0; i < 5 && !(before && before.json); i++) { before = await fx.request('GET', '/api/sessions'); if (!(before && before.json)) await sleep(500); }
      const cur0 = await fx.evaluate(`window.state.currentSession && window.state.currentSession.id`);
      ok(before && before.json && before.json.sessions.length === 0 && !cur0, `F2-0 前提:全新家目录、没有会话(实得 ${JSON.stringify([before && before.json && before.json.sessions.length, cur0])})`);
      await setText('DOUBLE-ENTER-ONCE');
      for (let i = 0; i < 2; i++) { await key('Enter', 'Enter', 13, '\r'); await sleep(40); }
      await fx.waitForEval(`document.querySelectorAll('.message.assistant').length >= 1 && window.state.streaming === false ? 1 : null`, 300);
      await sleep(600);
      const sessions = await fx.request('GET', '/api/sessions');
      ok(sessions.json.sessions.length === 1, `F2-1 连按两次 Enter 只建一个会话(实得 ${sessions.json.sessions.length} 个)`);
      const turnsSent = calls.filter(x => x.includes('DOUBLE-ENTER-ONCE')).length;   // 不加行尾锚:消息后面还会被附上「本条消息发送于…」的时间戳
      ok(turnsSent === 1, `F2-2 同一句话只发一遍(实得 ${turnsSent} 遍)`);
      ok(await fx.evaluate(`document.querySelectorAll('.message.user').length`) === 1, 'F2-3 屏上只有一条用户消息');
    }

    /* ───────── F5 + F3(搜索框 Esc / 对照)───────── */
    {
      await setText('HOLD-focus');
      await click('#sendBtn');
      ok(await waitStreaming(), 'F5-0 真鼠标点「发送」后回合起来了');
      const active = await fx.evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
      ok(active === 'promptInput', `F5-1 点发送后焦点回到输入框(实得 ${active})`);
      await key(' ', 'Space', 32, ' ');
      await sleep(500);
      ok(await streaming(), 'F5-2 紧接着按空格:回合没被停掉(修前焦点还在「停止」钮上,空格 = 点停止)');
      await fx.evaluate(`(() => { const t = document.getElementById('promptInput'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

      // F3:左栏搜索框里按 Esc 不停回合
      await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.focus(); s.value = 'abc'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await esc();
      await sleep(600);
      ok(await streaming(), 'F3-1 焦点在左栏搜索框时按 Esc:不停回合');
      await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); s.blur(); return true; })()`);
      // 对照:焦点不在任何输入框(页面上)按 Esc,仍然停回合
      await fx.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
      await esc();
      ok(Boolean(await waitIdle(100)), 'F3-2 对照:焦点不在输入框时 Esc 仍然是「停止」');
      releaseAll();
      await sleep(300);
    }

    /* ───────── F3(查看器)+ F9(重试 / 编辑重发)───────── */
    let attachedThread = '';
    {
      await newThread();
      const rec = await upload('shot.png');
      await fx.evaluate(`(() => { window.state.attachments.push(${JSON.stringify(rec)}); return true; })()`);
      await setText('HOLD-attach');
      await fx.evaluate(`document.getElementById('sendBtn').click()`);
      ok(await waitStreaming(), 'F3-3 带附件的回合起来了');
      attachedThread = await fx.evaluate(`window.state.currentSession.id`);
      await fx.waitForEval(`(() => { const i = document.querySelector('.msg-attachment-thumb img'); return i && i.src ? 1 : null; })()`, 200);
      await fx.evaluate(`(() => { const b = document.querySelector('.msg-attachment-thumb'); b.focus(); b.click(); return true; })()`);
      const viewer = await fx.evaluate(`(() => { const v = document.querySelector('.attachment-viewer-backdrop'); return v ? { modal: v.getAttribute('aria-modal'), role: v.getAttribute('role'), focused: document.activeElement === v } : null; })()`);
      ok(Boolean(viewer), 'F3-4 点缩略图打开大图查看器');
      ok(viewer && viewer.modal === 'true' && viewer.role === 'dialog', `补充B-1 查看器是 role=dialog + aria-modal=true(实得 ${JSON.stringify(viewer)})`);
      ok(viewer && viewer.focused, '补充B-2 打开时焦点进了查看器');
      await esc();
      await sleep(500);
      const afterEsc = await fx.evaluate(`({ open: !!document.querySelector('.attachment-viewer-backdrop'), streaming: window.state.streaming, onThumb: document.activeElement && document.activeElement.classList.contains('msg-attachment-thumb') })`);
      ok(!afterEsc.open, 'F3-5 Esc 关掉了大图查看器');
      ok(afterEsc.streaming === true, 'F3-6 关查看器的那一下 Esc 没有把正在跑的回合停掉');
      ok(afterEsc.onThumb === true, '补充B-3 关闭后焦点回到触发的缩略图');

      // F9:流式中点「重试」→ 被挡下,不变成插话
      const callsBefore = calls.length;
      await fx.evaluate(`(() => { const bar = document.querySelector('.message.user .msg-actions'); const b = [...bar.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(ZH['chat.retry'])}); b.click(); return true; })()`);
      await sleep(700);
      const guarded = await fx.evaluate(`({ steered: document.querySelectorAll('[data-steered="true"]').length, toast: [...document.querySelectorAll('.toast')].map(n => n.textContent).join('|') })`);
      ok(calls.length === callsBefore && guarded.steered === 0, `F9-1 流式中点「重试」:没有新请求、没变成插话(请求 ${callsBefore}→${calls.length},插话行 ${guarded.steered})`);
      ok(guarded.toast.includes(ZH['chat.retryWaitTurn']), `F9-2 给出「等回合结束再重试」的提示(实得 ${JSON.stringify(guarded.toast)})`);
      // 收尾:放行,等回合自然结束
      releaseAll();
      ok(Boolean(await waitIdle(300)), 'F9-3 回合结束');
      await sleep(600);

      // F9:重试带附件 —— 这条消息文字里有 HOLD,重试会再次挂起,正好看请求里的附件
      await fx.evaluate(`(() => { const bar = document.querySelector('.message.user .msg-actions'); const b = [...bar.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(ZH['chat.retry'])}); b.click(); return true; })()`);
      ok(await waitStreaming(), 'F9-4 回合结束后点「重试」:新回合起来了');
      await sleep(400);
      ok(/shot\.png/.test(calls[calls.length - 1] || ''), `F9-5 重试的请求带着原附件(最后一发里含 shot.png:${JSON.stringify((calls[calls.length - 1] || '').slice(-120))})`);
      releaseAll();
      await waitIdle(300);
      await sleep(600);

      // F9:编辑重发 —— 附件放回托盘;输入框有草稿时不覆盖
      const editLabel = ZH['chat.editResend'];
      const clickEdit = () => fx.evaluate(`(() => { const bars = [...document.querySelectorAll('.message.user .msg-actions')]; const bar = bars[0]; const b = [...bar.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(editLabel)}); b.click(); return true; })()`);
      await setText('');
      await clickEdit();
      const edited = await fx.evaluate(`({ value: document.getElementById('promptInput').value, att: window.state.attachments.length, pills: document.querySelectorAll('#attachmentTray .attachment-pill').length })`);
      ok(edited.value === 'HOLD-attach' && edited.att === 1 && edited.pills === 1, `F9-6 编辑重发:文字回到输入框、附件放回托盘(实得 ${JSON.stringify(edited)})`);
      await setText('我自己写了一半的草稿');
      await clickEdit();
      const kept = await fx.evaluate(`({ value: document.getElementById('promptInput').value, att: window.state.attachments.length, toast: [...document.querySelectorAll('.toast')].map(n => n.textContent).join('|') })`);
      ok(kept.value === '我自己写了一半的草稿' && kept.att === 1, `F9-7 输入框已有草稿时,编辑重发不覆盖它、也不重复放附件(实得 ${JSON.stringify({ v: kept.value, att: kept.att })})`);
      ok(kept.toast.includes(ZH['chat.editResendKeepDraft']), 'F9-8 并提示原因');
      // 清场:点托盘的 × 移除附件
      await fx.evaluate(`(() => { const x = document.querySelector('#attachmentTray .attach-x'); if (x) x.click(); return true; })()`);
      await setText('');
      ok(await fx.evaluate(`window.state.attachments.length`) === 0, 'F9-9 托盘清空');
    }

    /* ───────── F6 粘贴 / F13 上传中 / F7 拖拽 ───────── */
    {
      await newThread();
      const pasteResult = await fx.evaluate(`(async () => {
        const ta = document.getElementById('promptInput');
        const bytes = Uint8Array.from(atob(${JSON.stringify(PNG.split(',')[1])}), c => c.charCodeAt(0));
        const mk = withText => {
          const dt = new DataTransfer();
          if (withText) { dt.setData('text/plain', 'Q1\\t100'); dt.setData('text/html', '<table><tr><td>Q1</td></tr></table>'); }
          dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
          return new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        };
        ta.focus();
        const mixed = mk(true);
        const mixedPrevented = !ta.dispatchEvent(mixed);
        await new Promise(r => setTimeout(r, 800));
        const mixedAttachments = window.state.attachments.length;
        // 只有图片:拦截并上传;上传刚开始就看托盘占位、计数、发送门(同一个同步片段里,不依赖时序)
        const only = mk(false);
        const onlyPrevented = !ta.dispatchEvent(only);
        const uploading = window.state.uploading;
        const placeholder = document.querySelectorAll('#attachmentTray .attachment-pill.uploading').length;
        ta.value = '上传中就发'; ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('sendBtn').click();
        const gate = { streaming: window.state.streaming, kept: ta.value, toast: [...document.querySelectorAll('.toast')].map(n => n.textContent).join('|') };
        return { mixedPrevented, mixedAttachments, onlyPrevented, uploading, placeholder, gate };
      })()`);
      ok(pasteResult.mixedPrevented === false && pasteResult.mixedAttachments === 0, `F6-1 剪贴板同时有文字和图片:不拦截、图片不当附件(实得 ${JSON.stringify([pasteResult.mixedPrevented, pasteResult.mixedAttachments])})`);
      ok(pasteResult.onlyPrevented === true, 'F6-2 只有图片:照旧拦截当附件');
      ok(pasteResult.uploading === 1 && pasteResult.placeholder === 1, `F13-1 上传刚开始:托盘有「上传中…」占位、state.uploading=1(实得 ${JSON.stringify([pasteResult.uploading, pasteResult.placeholder])})`);
      ok(pasteResult.gate.streaming === false && pasteResult.gate.kept === '上传中就发', `F13-2 上传中点发送:不发、话留在框里(实得 ${JSON.stringify(pasteResult.gate)})`);
      ok(pasteResult.gate.toast.includes(ZH['toast.uploadInProgress']), 'F13-3 并提示「附件还在上传」');
      await fx.waitForEval(`window.state.uploading === 0 && window.state.attachments.length === 1 ? 1 : null`, 300);
      const done = await fx.evaluate(`({ pill: document.querySelectorAll('#attachmentTray .attachment-pill').length, uploading: document.querySelectorAll('#attachmentTray .attachment-pill.uploading').length, preview: String(window.state.attachments[0].previewUrl || '') })`);
      ok(done.pill === 1 && done.uploading === 0 && /^blob:/.test(done.preview), `F13-4 上传完成:占位换成真附件、有缩略图预览(实得 ${JSON.stringify(done)})`);
      // 移除 → 释放 blob URL
      await fx.evaluate(`document.querySelector('#attachmentTray .attach-x').click()`);
      ok(await fx.evaluate(`window.__revoked.includes(${JSON.stringify(done.preview)})`), 'F13-5 移除附件时释放缩略图 blob URL');
      // 发送出去 → 同样释放
      await fx.evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1,2,3])], 'again.png', { type: 'image/png' })); const ta = document.getElementById('promptInput'); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
      await fx.waitForEval(`window.state.uploading === 0 && window.state.attachments.length === 1 ? 1 : null`, 300);
      const sentPreview = await fx.evaluate(`String(window.state.attachments[0].previewUrl || '')`);
      await setText('发出去就释放');
      await fx.evaluate(`document.getElementById('sendBtn').click()`);
      await waitIdle(300);
      ok(sentPreview.startsWith('blob:') && await fx.evaluate(`window.__revoked.includes(${JSON.stringify(sentPreview)})`), 'F13-6 发送出去后释放缩略图 blob URL');

      // F7 拖拽
      const drag = await fx.evaluate(`(() => {
        const ta = document.getElementById('promptInput');
        const hint = document.getElementById('dropHint');
        const fire = (type, dt) => { const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }); return { prevented: !ta.dispatchEvent(ev) }; };
        const text = new DataTransfer(); text.setData('text/plain', '从别处拖来的文字');
        const r = { text: ['dragenter', 'dragover', 'drop'].map(type => fire(type, text).prevented), hintAfterText: !hint.classList.contains('hidden') };
        const files = new DataTransfer(); files.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
        r.fileEnter = fire('dragenter', files).prevented;
        r.fileOver = fire('dragover', files).prevented;
        r.hintAfterFile = !hint.classList.contains('hidden');
        fire('dragleave', files);
        r.hintAfterLeave = !hint.classList.contains('hidden');
        return r;
      })()`);
      ok(drag.text.every(x => x === false) && drag.hintAfterText === false, `F7-1 拖文字:三个事件都不拦截、不弹遮罩(实得 ${JSON.stringify(drag)})`);
      ok(drag.fileEnter === true && drag.fileOver === true && drag.hintAfterFile === true && drag.hintAfterLeave === false, 'F7-2 拖文件:照旧接管、弹遮罩、离开后收起');
    }

    /* ───────── 补充 A 叠层 Esc 只关最上面一层 ───────── */
    {
      const r = await fx.evaluate(`(() => {
        const settings = document.getElementById('settingsModal');
        settings.classList.remove('hidden');
        const top = document.createElement('div');
        top.className = 'modal-backdrop dynamic';
        top.__cancel = () => top.remove();
        document.body.appendChild(top);
        return true;
      })()`);
      await esc();
      await sleep(300);
      const afterOne = await fx.evaluate(`({ top: !!document.querySelector('.modal-backdrop.dynamic'), settings: !document.getElementById('settingsModal').classList.contains('hidden') })`);
      ok(r && afterOne.top === false && afterOne.settings === true, `补充A-1 叠层时第一次 Esc 只关最上面那层,下面的设置页还在(实得 ${JSON.stringify(afterOne)})`);
      await esc();
      await sleep(300);
      ok(await fx.evaluate(`document.getElementById('settingsModal').classList.contains('hidden')`), '补充A-2 第二次 Esc 才关设置页');
    }

    /* ───────── F11 + F14 变更页签 ───────── */
    {
      await fx.evaluate(`(() => {
        if (window.__changesPatched) return true;
        window.__changesPatched = true;
        const orig = window.fetch;
        window.__rollbackCalls = 0;
        window.fetch = function (input, init) {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          if (/\\/api\\/checkpoints\\?sessionId=/.test(url)) {
            return Promise.resolve(new Response(JSON.stringify({ ok: true, entries: [
              { turnSeq: 1, entrySeq: 1, tool: 'edit_file', path: 'C:\\\\w\\\\a.txt', op: 'modify', bytes: 10, currentBytes: 12 },
              { turnSeq: 1, entrySeq: 2, tool: 'write_docx', path: 'C:\\\\w\\\\b.docx', op: 'create', currentBytes: 100 },
              { turnSeq: 1, entrySeq: 3, tool: 'window_screenshot', path: 'C:\\\\w\\\\c.png', op: 'create', currentBytes: 100 },
              { turnSeq: 1, entrySeq: 4, tool: 'get_clipboard_image', path: 'C:\\\\w\\\\d.png', op: 'create', currentBytes: 100 },
              { turnSeq: 1, entrySeq: 5, tool: 'brand_new_tool', path: 'C:\\\\w\\\\e.txt', op: 'wiggle', bytes: 3, currentBytes: 4 },
            ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
          }
          if (/\\/api\\/checkpoints\\/rollback/.test(url)) {
            window.__rollbackCalls += 1;
            return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'disk said no' }), { status: 200, headers: { 'content-type': 'application/json' } }));
          }
          return orig.apply(this, arguments);
        };
        return true;
      })()`);
      await fx.evaluate(`document.querySelector('.tool-pane .tool-tabs button[data-tab="changes"]').click()`);
      await fx.waitForEval(`document.querySelectorAll('#changesList .change-row').length === 5 ? 1 : null`, 200);
      const labels = await fx.evaluate(`({
        tools: [...document.querySelectorAll('#changesList .change-tool')].map(n => n.textContent),
        ops: [...document.querySelectorAll('#changesList .change-op')].map(n => n.textContent),
        all: document.getElementById('changesList').textContent,
      })`);
      ok(!/\[changes\./.test(labels.all), `F11-1 变更页签里没有 [changes.…] 这种漏出来的键名(实得 ${JSON.stringify(labels.all.match(/\[changes\.[^\]]*\]/g))})`);
      ok(labels.tools.includes(ZH['changes.tool.edit_file']) && labels.tools.includes(ZH['changes.tool.write_docx']) && labels.tools.includes(ZH['changes.tool.window_screenshot']) && labels.tools.includes(ZH['changes.tool.get_clipboard_image']),
        `F11-2 edit_file / write_docx / window_screenshot / get_clipboard_image 都有译文(实得 ${JSON.stringify(labels.tools)})`);
      ok(labels.tools.includes('brand_new_tool'), 'F11-3 没有译文的工具名回落到原名');
      ok(labels.ops.includes(ZH['changes.op.modify']), `F11-4 未知操作类型回落到「修改」(实得 ${JSON.stringify(labels.ops)})`);
      // F14:单文件撤回失败后按钮文字回到「撤销」
      const revertLabel = ZH['changes.revert'];
      ok(revertLabel === '撤销' && ZH['changes.revertTitle'] !== revertLabel, 'F14-0 前提:按钮文案 ≠ tooltip 文案');
      await fx.evaluate(`document.querySelector('#changesList .change-undo').click()`);
      await fx.waitForEval(`document.querySelector('.modal-backdrop.dynamic .confirm-foot .primary') ? 1 : null`, 100);
      await fx.evaluate(`document.querySelector('.modal-backdrop.dynamic .confirm-foot .primary').click()`);
      await fx.waitForEval(`window.__rollbackCalls >= 1 ? 1 : null`, 200);
      await sleep(400);
      const btn = await fx.evaluate(`(() => { const b = document.querySelector('#changesList .change-undo'); return { text: b.textContent, disabled: b.disabled }; })()`);
      ok(btn.text === revertLabel && btn.disabled === false, `F14-1 撤回失败后按钮文字是「${revertLabel}」且可再点(实得 ${JSON.stringify(btn)})`);
    }

    /* ───────── F4 + F15 提问弹窗草稿 / 重放耗时 ───────── */
    let askThread = '';
    {
      await newThread();
      await setText('ASK me');
      await fx.evaluate(`document.getElementById('sendBtn').click()`);
      ok(Boolean(await fx.waitForEval(`document.querySelector('.ask-modal') ? 1 : null`, 300)), 'F4-0 提问弹窗出来了');
      askThread = await fx.evaluate(`window.state.currentSession.id`);
      const fill = () => fx.evaluate(`(() => {
        const cards = document.querySelectorAll('.ask-modal .ask-question-card');
        const ta = cards[0].querySelector('textarea');
        ta.value = '写了一半的回答'; ta.dispatchEvent(new Event('input', { bubbles: true }));
        const b = cards[1].querySelector('input[value="b"]');
        b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      const read = () => fx.evaluate(`(() => {
        const cards = document.querySelectorAll('.ask-modal .ask-question-card');
        if (cards.length < 2) return null;
        return { text: cards[0].querySelector('textarea').value, a: cards[1].querySelector('input[value="a"]').checked, b: cards[1].querySelector('input[value="b"]').checked };
      })()`);
      await fill();
      await esc();
      await sleep(500);
      ok(await fx.evaluate(`!document.querySelector('.ask-modal')`), 'F4-1 Esc 把提问收进右下角小窗');
      await fx.evaluate(`document.querySelector('.prompt-dock-pill').click()`);
      await sleep(250);
      await fx.evaluate(`document.querySelector('.pd-row').click()`);
      await fx.waitForEval(`document.querySelector('.ask-modal') ? 1 : null`, 100);
      const restored = await read();
      ok(restored && restored.text === '写了一半的回答' && restored.b === true && restored.a === false, `F4-2 从小窗重开后文字与多选原样回填(实得 ${JSON.stringify(restored)})`);
      // 提交;距 tool_use 已过去一阵,工具卡耗时会 ≥ 1s
      await sleep(1500);
      await fx.evaluate(`document.querySelector('.ask-modal .ask-submit').click()`);
      await fx.waitForEval(`!document.querySelector('.ask-modal') ? 1 : null`, 200);
      await fx.waitForEval(`(document.getElementById('messages').innerText || '').includes('收到') ? 1 : null`, 300);
      ok(await streaming(), 'F15-0 回答送达后回合继续(挂在假 provider 的 HOLD 上)');
      // 切走再切回
      await newThread();
      await openThread(askThread);
      const dur = await fx.evaluate(`(() => {
        const cards = [...document.querySelectorAll('#messages .tool-card')];
        const ask = cards.find(c => /request_user_input|question|提问|询问/.test(c.textContent));
        const target = ask || cards[0];
        return target ? { text: (target.querySelector('.tc-dur') || {}).textContent || '', count: cards.length } : null;
      })()`);
      const seconds = dur && /([\d.]+)s/.exec(dur.text) ? Number(/([\d.]+)s/.exec(dur.text)[1]) : -1;
      ok(Boolean(dur) && seconds >= 1, `F15-1 切走再切回:已完成工具的耗时是真实时间差,不是「· 0.0s」(实得 ${JSON.stringify(dur)})`);
      ok(await fx.evaluate(`!document.querySelector('.ask-modal')`), 'F15-2 重放时已答的提问不再弹窗');
      releaseAll();
      await waitIdle(300);
    }

    /* ───────── F12 对话卡里「允许」失败 ───────── */
    {
      await newThread();
      await fx.evaluate(`(() => {
        if (window.__decisionPatched) return true;
        window.__decisionPatched = true; window.__failDecision = false; window.__decisionCalls = 0;
        const orig = window.fetch;
        window.fetch = function (input, init) {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          if (/\\/api\\/permission\\/decision/.test(url)) {
            window.__decisionCalls += 1;
            if (window.__failDecision) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'try again' }), { status: 503, headers: { 'content-type': 'application/json' } }));
          }
          return orig.apply(this, arguments);
        };
        return true;
      })()`);
      await setText('PERM write');
      await fx.evaluate(`document.getElementById('sendBtn').click()`);
      ok(Boolean(await fx.waitForEval(`document.querySelector('.permission-modal') ? 1 : null`, 300)), 'F12-0 权限弹窗出来了');
      await esc();   // 收进小窗,对话里的卡带「允许 / 拒绝」
      await sleep(400);
      ok(Boolean(await fx.waitForEval(`document.querySelector('#messages .narrative-perm-actions button') ? 1 : null`, 200)), 'F12-1 对话里的待决权限卡带「允许 / 拒绝」');
      await fx.evaluate(`window.__failDecision = true`);
      await fx.evaluate(`document.querySelector('#messages .narrative-perm-actions button').click()`);
      await sleep(900);
      const failed = await fx.evaluate(`({
        calls: window.__decisionCalls,
        enabled: [...document.querySelectorAll('#messages .narrative-perm-actions button')].map(b => !b.disabled),
        dock: (() => { const d = document.getElementById('promptDock'); return !!d && !d.hidden; })(),
        count: (document.querySelector('.pd-count') || {}).textContent || '',
      })`);
      ok(failed.calls >= 1 && failed.enabled.length === 2 && failed.enabled.every(Boolean), `F12-2 请求失败:卡上两枚按钮恢复可点(实得 ${JSON.stringify(failed)})`);
      ok(failed.dock && failed.count === '1', `F12-3 请求失败:申请仍在队列里、没被撤掉(小窗 ${JSON.stringify([failed.dock, failed.count])})`);
      await fx.evaluate(`window.__failDecision = false`);
      await fx.evaluate(`document.querySelector('#messages .narrative-perm-actions button').click()`);
      ok(Boolean(await waitIdle(400)), 'F12-4 重新点「允许」成功:回合继续并结束');
      ok(fs.existsSync(workFile.path), 'F12-5 工具真的执行了(文件已写出)');
      ok(await fx.evaluate(`(() => { const d = document.getElementById('promptDock'); return !d || d.hidden; })()`), 'F12-6 成功后队列清空');
    }

    ok(fx.exceptions.length === 0, `A-X 夹具 A 零未捕获异常(${JSON.stringify(fx.exceptions)})`);
    await fx.close({ keepRoot: t.failures > 0 });
    fx = null;
    releaseAll();

    /* ═════════════ 夹具 B:计划档 ═════════════ */
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-chat-ux-b-',
      config: { stewardEnabledV1: false, permissionMode: 'plan' },
      provider: async ctx => {
        const text = lastUserText(ctx);
        const spoken = ctx.messages.some(m => m.role === 'assistant');
        if (/PLAN (one|two)/.test(text) && !spoken) { ctx.text('PLAN: 1. 读文件 2. 改文件'); ctx.stop(); return; }
        ctx.text('开始执行,');
        await hold();
        ctx.text('做完了');
        ctx.stop();
      },
    });
    const clickB = sel => fx.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const setTextB = value => fx.evaluate(`(() => { const t = document.getElementById('promptInput'); t.focus(); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const newThreadB = async () => {
      const before = await fx.evaluate(`window.state.currentSession && window.state.currentSession.id`);
      await clickB('#newSessionBtn');
      await fx.waitForEval(`(window.state.currentSession && window.state.currentSession.id) !== ${JSON.stringify(before || null)} ? 1 : null`, 200);
      await sleep(300);
    };
    const openThreadB = async sid => {
      await fx.evaluate(`(() => { const row = [...document.querySelectorAll('#railList [data-session-id]')].find(n => n.dataset.sessionId === ${JSON.stringify(sid)}); if (!row) throw new Error('rail row missing'); row.click(); return true; })()`);
      await fx.waitForEval(`window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(sid)} ? 1 : null`, 200);
      await sleep(500);
    };
    await fx.waitForEval(`!!(window.state && window.state.sessions && document.getElementById('promptInput'))`);
    await sleep(800);
    const planState = () => fx.evaluate(`({
      cards: document.querySelectorAll('#messages .plan-card').length,
      buttons: [...document.querySelectorAll('#messages .plan-card .plan-card-foot button')].map(b => !b.disabled),
      decided: [...document.querySelectorAll('#messages .plan-card')].map(c => c.classList.contains('decided')),
      expired: [...document.querySelectorAll('#messages .plan-card')].map(c => c.classList.contains('plan-expired')),
      bar: (() => { const b = document.getElementById('turnActivityBar'); return b && !b.classList.contains('hidden') ? b.textContent : ''; })(),
      hint: (document.getElementById('composerHint') || {}).textContent || '',
    })`);

    /* ───────── F1 切会话再切回,计划卡按钮还在 ───────── */
    {
      await setTextB('PLAN one');
      await clickB('#sendBtn');
      await fx.waitForEval(`document.querySelectorAll('#messages .plan-card .plan-card-foot button').length === 3 ? 1 : null`, 300);
      const sid = await fx.evaluate(`window.state.currentSession.id`);
      const first = await planState();
      ok(first.cards === 1 && first.buttons.length === 3 && first.buttons.every(Boolean), `F1-1 计划卡出来了,三枚按钮可点(实得 ${JSON.stringify(first)})`);
      await newThreadB();
      await openThreadB(sid);
      const back = await planState();
      ok(back.cards === 1 && back.buttons.length === 3 && back.buttons.every(Boolean), `F1-2 切走再切回:计划卡重建,批准 / 修改意见 / 放弃三枚按钮都在(实得 ${JSON.stringify(back)})`);
      ok(/等你拍板/.test(back.bar), `F1-3 切回后状态条仍说「等你拍板」(实得 ${JSON.stringify(back.bar)})`);
      // 批准 → 回合继续(挂在 HOLD);再切走切回:计划卡是收起的已决态、不再亮按钮
      await clickB('#messages .plan-card .plan-card-foot button.primary');
      await fx.waitForEval(`document.querySelector('#messages .plan-card.decided') ? 1 : null`, 200);
      await fx.waitForEval(`(document.getElementById('messages').innerText || '').includes('开始执行') ? 1 : null`, 300);
      await newThreadB();
      await openThreadB(sid);
      const decided = await planState();
      ok(decided.cards === 1 && decided.decided[0] === true && decided.buttons.every(b => b === false), `F1-4 已批准的计划切回来是收起的已决态(实得 ${JSON.stringify(decided)})`);
      ok(!/等你拍板/.test(decided.bar), `F1-5 批准之后状态条不再说「等你拍板」(实得 ${JSON.stringify(decided.bar)})`);
      releaseAll();
      await fx.waitForEval(`window.state.streaming === false ? 1 : null`, 300);
    }

    /* ───────── F10 计划待批准时按停止 ───────── */
    {
      await newThreadB();
      await setTextB('PLAN two');
      await clickB('#sendBtn');
      await fx.waitForEval(`document.querySelectorAll('#messages .plan-card .plan-card-foot button').length === 3 ? 1 : null`, 300);
      const pending = await planState();
      ok(/等你拍板/.test(pending.bar) && pending.hint.length > 0, `F10-1 前提:待批准时状态条「等你拍板」、输入框上有等批准提示(实得 ${JSON.stringify([pending.bar, pending.hint])})`);
      await clickB('#sendBtn');   // 输入框是空的 → 这一枚是「停止」
      await fx.waitForEval(`window.state.streaming === false ? 1 : null`, 200);
      await sleep(500);
      const stopped = await planState();
      ok(!/等你拍板/.test(stopped.bar), `F10-2 停止后状态条不再停在「等你拍板」(实得 ${JSON.stringify(stopped.bar)})`);
      ok(stopped.buttons.length === 3 && stopped.buttons.every(b => b === false) && stopped.expired[0] === true, `F10-3 计划卡按钮全部禁用、标成已失效(实得 ${JSON.stringify(stopped)})`);
      ok(stopped.hint === '', `F10-4 「AI 在等你批准计划」提示收掉了(实得 ${JSON.stringify(stopped.hint)})`);
    }
    ok(fx.exceptions.length === 0, `B-X 夹具 B 零未捕获异常(${JSON.stringify(fx.exceptions)})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    releaseAll();
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
}
main();
