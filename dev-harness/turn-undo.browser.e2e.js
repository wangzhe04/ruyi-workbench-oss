#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：聊天里「本轮变更」卡的撤销（体验走查 #13 / #14）。
//
// 走查原话：
//   #13 撤销确认用的是浏览器原生 confirm()，标题「127.0.0.1:8790 显示」，像钓鱼框；而且撤销一个【新建】的
//       文件，文案写「恢复到改动前的内容」—— 实际是把它删掉。
//   #14 撤销之后刷新页面，变更卡上的「撤销」「打开 report.md」又恢复成可点，文件却已经不在了。
//
// 覆盖：
//   A 一个回合新建 report.md（假模型调 file_write），卡片上有「撤销」；
//   B 点「撤销」→ 应用内确认面板（不是原生 confirm，原生那条一次都没被叫到），正文说的是「删除」；
//     点确认 → 文件真的没了、按钮变「已撤销」；
//   C 刷新页面、重开线程 → 卡片上那一行画「已撤销」（不是可点的按钮）、「撤销整轮」也不再可点、
//     产物 chip 不再给已经删掉的 report.md 一个「打开」。
//   D（代码走查 C6／走查 U9）整轮撤销只撤回了一部分 → 如实说；撤回的那几行当场改成「已撤销」；
//   E（走查 #9）本机端点（127.0.0.1、没填密钥）时，工作台空状态不再催「填写 … 密钥」；
//   E2（走查 #19）用不了的「一键任务」卡排在能用的后面。
// 反向验证：把 session-experience.js 里 f.reverted 那一支删掉 → C1 当场红；把 confirmDanger 换回 confirm → B1 红。
//
// 判定行：`TURN UNDO BROWSER E2E: ALL PASS`。
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const THREAD = '撤销走查线程';
const THREAD2 = '部分撤销线程';

function runTurn(port, token, sessionId, message, cwd) {
  return new Promise(resolve => {
    const raw = JSON.stringify({ sessionId, message, cwd });
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(raw); req.end();
  });
}

(async () => {
  let fx = null;
  let workDir = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-turn-undo-',
      // 假模型就在 127.0.0.1 上、密钥留空 —— 与走查 #9 的现场一致（本机端点本来就不要密钥）。
      config: { permissionMode: 'bypass', uiMode: 'pro' },
      prepare: async f => {
        workDir = f.work;
        const cfgPath = path.join(f.home, 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        cfg.providers = cfg.providers.map(p => ({ ...p, apiKey: '' }));
        await f.request('POST', '/api/config', { providers: cfg.providers });
      },
      provider: async ctx => {
        const lastUser = [...ctx.messages].reverse().find(m => m && m.role === 'user');
        if (/改两个文件/.test(String(lastUser && lastUser.content || ''))) {
          const tools = ctx.messages.slice(ctx.messages.lastIndexOf(lastUser)).filter(m => m && m.role === 'tool').length;
          if (tools === 0) { ctx.toolCall('file_write', { path: path.join(workDir, 'big.log'), content: 'short\n' }); return; }
          if (tools === 1) { ctx.toolCall('file_write', { path: path.join(workDir, 'note.md'), content: '# note\n' }); return; }
          ctx.text('改好了。'); ctx.stop(); return;
        }
        if (!ctx.answered) { ctx.toolCall('file_write', { path: path.join(workDir, 'report.md'), content: '# 报告\n一行\n' }); return; }
        ctx.text('写好了。'); ctx.stop();
      },
    });
    const target = path.join(fx.work, 'report.md');

    /* ═════════ A 一个回合新建 report.md ═════════ */
    const created = await fx.request('POST', '/api/sessions', { title: THREAD, cwd: fx.work });
    const sid = created && created.json && (created.json.session ? created.json.session.id : created.json.id);
    ok(Boolean(sid), `A0 线程已建（${sid}）`);
    ok(await runTurn(fx.appPort, fx.token, sid, '写一份报告', fx.work), 'A1 回合跑完');
    ok(fs.existsSync(target), 'A2 report.md 真的写出来了');

    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    /* ═════════ E 本机端点不催密钥（走查 #9） ═════════ */
    await fx.evaluate(`(document.getElementById('newSessionBtn') || { click() {} }).click(), true`);
    // 空状态先画一版（配置还没到，没有引擎名、也没有按钮），配置到了再重画：等引擎那一行写上 Fake 再量。
    await fx.waitForEval(`(() => { const e = document.querySelector('.empty-state .empty-engine'); return e && /Fake/.test(e.textContent) ? 1 : null; })()`, 300);
    await sleep(500);
    const empty = await fx.waitForEval(`(() => {
      const box = document.querySelector('.empty-state');
      if (!box) return null;
      const cta = box.querySelector('.empty-cta');
      return { cta: cta ? cta.textContent : '', key: String((window.state.config.providers || []).find(p => p.id === window.state.config.activeProvider)?.apiKey || '') };
    })()`, 300);
    ok(Boolean(empty) && empty.key === '' && !/密钥/.test(empty.cta),
      `E1 本机端点、密钥为空：空状态不催「填写 … 密钥」（实测 ${JSON.stringify(empty)}）`);
    // E2（走查 #19）：用不了的「一键任务」卡（需要配置／离线）排在能用的后面，不占首屏位置。
    const cards = await fx.evaluate(`[...document.querySelectorAll('.empty-state .pb-grid .pb-card')].map(c => c.classList.contains('unavailable') ? 0 : 1)`);
    const firstUnavailable = cards.indexOf(0);
    ok(cards.length > 0 && (firstUnavailable < 0 || cards.slice(firstUnavailable).every(v => v === 0)),
      `E2 用不了的一键任务卡都排在能用的后面（实测 ${JSON.stringify(cards)}）`);
    const openThread = (title = THREAD) => fx.evaluate(`(() => {
      const item = [...document.querySelectorAll('#railList .steward-board-thread')].find(node => node.textContent.includes(${JSON.stringify(title)}));
      if (!item) return false;
      item.querySelector('.steward-board-thread-title').click();
      return true;
    })()`);
    await fx.waitForEval(`[...document.querySelectorAll('#railList .steward-board-thread')].some(n => n.textContent.includes(${JSON.stringify(THREAD)})) ? 1 : null`, 300);
    await openThread();
    const card = await fx.waitForEval(`(() => {
      const row = [...document.querySelectorAll('.turn-summary-file')].find(r => r.textContent.includes('report.md'));
      const btn = row && row.querySelector('button.ts-undo');
      return btn ? { text: btn.textContent } : null;
    })()`, 300);
    ok(Boolean(card), `A3 「本轮变更」卡上 report.md 那一行有「撤销」（实测 ${JSON.stringify(card)}）`);

    /* ═════════ B 应用内确认，说的是「删除」 ═════════ */
    await fx.evaluate(`(() => { window.__nativeConfirm = 0; window.confirm = () => { window.__nativeConfirm += 1; return true; }; return true; })()`);
    await fx.evaluate(`(() => {
      const row = [...document.querySelectorAll('.turn-summary-file')].find(r => r.textContent.includes('report.md'));
      row.querySelector('button.ts-undo').click();
      return true;
    })()`);
    const panel = await fx.waitForEval(`(() => {
      const p = document.querySelector('.modal-backdrop.confirm-panel');
      return p ? { text: p.textContent, native: window.__nativeConfirm } : null;
    })()`, 200);
    ok(Boolean(panel) && panel.native === 0, `B1 弹的是应用内确认面板，原生 confirm 一次都没叫（实测 native=${panel && panel.native}）`);
    ok(Boolean(panel) && /删除/.test(panel.text) && !/恢复到改动前/.test(panel.text),
      `B2 撤销「新建」的说法是删除，不是「恢复到改动前」（实测 ${JSON.stringify(panel && panel.text.slice(0, 120))}）`);
    await fx.evaluate(`(document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]').click(), true)`);
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) { gone = !fs.existsSync(target); if (!gone) await sleep(100); }
    ok(gone, 'B3 确认之后 report.md 真的被删掉了');
    const doneLive = await fx.waitForEval(`(() => {
      const row = [...document.querySelectorAll('.turn-summary-file')].find(r => r.textContent.includes('report.md'));
      const b = row && row.querySelector('.ts-undo');
      return b && b.classList.contains('done') ? b.textContent : null;
    })()`, 200);
    ok(Boolean(doneLive), `B4 当场变成「已撤销」（实测 ${JSON.stringify(doneLive)}）`);

    /* ═════════ C 刷新之后仍然是「已撤销」 ═════════ */
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await fx.waitForEval(`window.state && window.state.config ? 1 : null`, 300);
    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    await fx.waitForEval(`[...document.querySelectorAll('#railList .steward-board-thread')].some(n => n.textContent.includes(${JSON.stringify(THREAD)})) ? 1 : null`, 300);
    await openThread();
    const after = await fx.waitForEval(`(() => {
      const row = [...document.querySelectorAll('.turn-summary-file')].find(r => r.textContent.includes('report.md'));
      if (!row) return null;
      const card = row.closest('.turn-summary');
      const undoBtn = row.querySelector('button.ts-undo');
      const undoAllBtn = card && card.querySelector('button.ts-undo-all');
      const main = card && card.parentElement;
      const chip = main && [...main.querySelectorAll('.artifact-chip')].find(c => c.textContent.includes('report.md'));
      return { rowText: row.textContent, undoBtn: Boolean(undoBtn), undoAllBtn: Boolean(undoAllBtn), chip: Boolean(chip) };
    })()`, 300);
    ok(Boolean(after) && !after.undoBtn && /已撤销/.test(after.rowText),
      `C1 刷新后那一行画「已撤销」，不是一枚可点的「撤销」（实测 ${JSON.stringify(after)}）`);
    ok(Boolean(after) && !after.undoAllBtn, 'C2 刷新后「撤销整轮」不再可点（这一轮已经没有可撤的文件）');
    ok(Boolean(after) && !after.chip, 'C3 产物 chip 不再给已经删掉的 report.md 一个「打开」');

    /* ═════════ D 整轮撤销只撤回了一部分（代码走查 C6 / 走查 U9） ═════════ */
    // big.log 改前 6MB，超过留底上限 → 撤不回；note.md 是新建的 → 撤得回。修前：按钮写「已撤销」、提示说成功，
    // 逐个文件的「撤销」按钮也还挂着（再点报「撤销失败」）。
    const big = path.join(fx.work, 'big.log'), note = path.join(fx.work, 'note.md');
    fs.writeFileSync(big, 'x'.repeat(6 * 1024 * 1024));
    const created2 = await fx.request('POST', '/api/sessions', { title: THREAD2, cwd: fx.work });
    const sid2 = created2 && created2.json && (created2.json.session ? created2.json.session.id : created2.json.id);
    ok(await runTurn(fx.appPort, fx.token, sid2, '改两个文件', fx.work) && fs.existsSync(note) && fs.statSync(big).size < 100, 'D0 第二个线程的回合改了两个文件');
    await fx.waitForEval(`[...document.querySelectorAll('#railList .steward-board-thread')].some(n => n.textContent.includes(${JSON.stringify(THREAD2)})) ? 1 : null`, 300);
    await openThread(THREAD2);
    await fx.waitForEval(`document.querySelector('.turn-summary button.ts-undo-all') && [...document.querySelectorAll('.turn-summary-file')].some(r => r.textContent.includes('note.md')) ? 1 : null`, 300);
    await fx.evaluate(`(document.querySelector('.turn-summary button.ts-undo-all').click(), true)`);
    await fx.waitForEval(`document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]') ? 1 : null`, 200);
    await fx.evaluate(`(document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]').click(), true)`);
    const partial = await fx.waitForEval(`(() => {
      const toast = [...document.querySelectorAll('#toastTray .toast')].map(n => n.textContent).find(x => /没能撤回/.test(x));
      if (!toast) return null;
      const card = [...document.querySelectorAll('.turn-summary')].find(c => c.textContent.includes('note.md'));
      const row = name => [...card.querySelectorAll('.turn-summary-file')].find(r => r.textContent.includes(name));
      return {
        toast, head: (card.querySelector('.ts-undo-all') || {}).textContent || '',
        noteDone: Boolean(row('note.md').querySelector('.ts-undo.done')) && !row('note.md').querySelector('button.ts-undo'),
        bigText: row('big.log').textContent,
      };
    })()`, 200);
    ok(Boolean(partial) && /撤回了 1 个文件，另有 1 个没能撤回/.test(partial.toast) && /没有留底/.test(partial.toast),
      `D1 一部分撤不回 → 如实说撤回了几个、几个没撤回、为什么（实测 ${JSON.stringify(partial && partial.toast)}）`);
    ok(Boolean(partial) && partial.head === '部分已撤销', `D2 「撤销整轮」改成「部分已撤销」，不说「已撤销」（实测 ${JSON.stringify(partial && partial.head)}）`);
    ok(Boolean(partial) && partial.noteDone, 'D3 撤回了的 note.md 那一行当场改成「已撤销」，不再挂着可点的「撤销」');
    ok(Boolean(partial) && !/已撤销/.test(partial.bigText) && !fs.existsSync(note) && fs.statSync(big).size < 100,
      `D4 撤不回的 big.log 那一行不说「已撤销」；note.md 真的删了、big.log 没被动（实测 ${JSON.stringify(partial && { bigText: partial.bigText, note: fs.existsSync(note), big: fs.statSync(big).size })}）`);
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nTURN UNDO BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
