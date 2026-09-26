#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：权限弹窗说人话、而且马上弹（体验走查 #5 / #12，外加 #4 的默认值）。
//
// 走查原话：
//   #5 发出请求后 0.5 s 进入待决，但屏幕上没有「允许／拒绝」—— 实测是「2.5 s 内按过键＝正在打字」这道闸：
//      回车刚把话发出去，框已经空了，弹窗还要白等 2.5 s；
//   #12 弹窗正文是「file_write」＋整段 JSON 参数（右侧被截断）—— 给程序员看的；
//   #4 刷新／关窗 = 回合中止、待决的权限被自动拒绝：新装的 killOnDisconnect 缺省改成 false。
//
// 覆盖：
//   P1 从工作台输入框发出一句话、回合来要写文件的权限 → 弹窗出来了（快不快由 unit prompt-queue ⑩ 确定性地钉）；
//   P2 正文第一句是人话「写入文件「report.md」（3 行）」；
//   P3 要写的内容给了预览；
//   P4 原始工具名与 JSON 收在「技术详情」里、默认收起；
//   P5 收起的技术详情之外，看不到 file_write 这种标识；
//   P6 点「允许」→ 文件真的写出来；
//   P7 新装的 config.killOnDisconnect 是 false。
// 判定行：`PERMISSION PLAIN BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  let workDir = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-perm-plain-',
      config: { permissionMode: 'default', uiMode: 'simple', killOnDisconnect: undefined },
      provider: async ctx => {
        if (!ctx.answered) { ctx.toolCall('file_write', { path: path.join(workDir, 'report.md'), content: '# 周报\n本周完成三件事\n下周计划\n' }); return; }
        ctx.text('写好了。'); ctx.stop();
      },
      prepare: async f => { workDir = f.work; },
    });
    const target = path.join(fx.work, 'report.md');
    const killOnDisconnect = await fx.waitForEval(`window.state && window.state.config && 'killOnDisconnect' in window.state.config ? String(window.state.config.killOnDisconnect) : null`, 200);
    ok(killOnDisconnect === 'false', `P7 新装的 killOnDisconnect 缺省是 false（实测 ${killOnDisconnect}）`);

    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    await fx.evaluate(`(document.getElementById('newSessionBtn') || { click() {} }).click(), true`);
    await sleep(800);
    const sentAt = Date.now();
    await fx.evaluate(`(() => {
      const i = document.getElementById('promptInput');
      i.focus(); i.value = '写一份周报'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const modal = await fx.waitForEval(`(() => {
      const m = document.querySelector('.modal-backdrop.permission-modal');
      if (!m) return null;
      const tech = m.querySelector('details.perm-tech');
      const clone = m.cloneNode(true);
      const techClone = clone.querySelector('details.perm-tech');
      if (techClone) techClone.remove();
      return {
        plain: (m.querySelector('.perm-plain') || {}).textContent || '',
        preview: (m.querySelector('.perm-preview') || {}).textContent || '',
        techOpen: tech ? tech.open : null,
        techText: tech ? tech.textContent : '',
        outside: clone.textContent,
      };
    })()`, 200);
    const waited = Date.now() - sentAt;
    // 「多快」的判据是确定性的那一条：unit/prompt-queue.test.js ⑩（框空了就不算在打字）。这里只断「弹出来了」，耗时只打印。
    ok(Boolean(modal), `P1 发出一句话、回合来要权限 → 弹窗出来了（发出后约 ${waited} ms；打字闸的判据见 prompt-queue ⑩）`);
    ok(Boolean(modal) && modal.plain === '写入文件「report.md」（3 行）', `P2 第一句是人话（实测 ${JSON.stringify(modal && modal.plain)}）`);
    ok(Boolean(modal) && modal.preview.includes('本周完成三件事'), 'P3 要写的内容给了预览');
    ok(Boolean(modal) && modal.techOpen === false && modal.techText.includes('file_write') && modal.techText.includes('"path"'),
      `P4 原始工具名与 JSON 收在默认收起的「技术详情」里（实测 open=${modal && modal.techOpen}）`);
    ok(Boolean(modal) && !/file_write/.test(modal.outside), 'P5 技术详情之外看不到 file_write');

    await fx.evaluate(`(() => { const m = document.querySelector('.modal-backdrop.permission-modal'); [...m.querySelectorAll('button')].find(b => b.classList.contains('primary')).click(); return true; })()`);
    let written = false;
    for (let i = 0; i < 100 && !written; i++) { written = fs.existsSync(target); if (!written) await sleep(100); }
    ok(written, 'P6 点「允许」→ report.md 真的写出来了');
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nPERMISSION PLAIN BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
