#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：待决的权限活过「刷新页面」（体验走查 #4 收尾）。
//
// 走查原话：「工作台回合绑在页面连接上：刷新、关窗或断网 = 回合中止，待决的权限被自动『已拒绝 · turn
// disconnected』，写入失败。」killOnDisconnect 缺省已改 false；这一件钉的是用户真正在乎的那一串：
//   R1 回合来要写文件的权限 → 弹窗出来；
//   R2 刷新页面 → 回合没被结束，权限还在服务端等着（不是「已拒绝 · turn disconnected」）；
//   R3 页面回来后，那一个待决重新摆到面前（弹窗或内联按钮，能直接点）；
//   R4 点「允许」→ 文件真的写出来，回合收尾。
// 判定行：`PERMISSION SURVIVES RELOAD BROWSER E2E: ALL PASS`。
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
      ok, prefix: 'ruyi-perm-reload-',
      config: { permissionMode: 'default', uiMode: 'simple', killOnDisconnect: undefined },
      provider: async ctx => {
        if (!ctx.answered) { ctx.toolCall('file_write', { path: path.join(workDir, 'notes.md'), content: '第一行\n第二行\n' }); return; }
        ctx.text('写好了。'); ctx.stop();
      },
      prepare: async f => { workDir = f.work; },
    });
    const target = path.join(fx.work, 'notes.md');
    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    await fx.evaluate(`(document.getElementById('newSessionBtn') || { click() {} }).click(), true`);
    await sleep(800);
    await fx.evaluate(`(() => {
      const i = document.getElementById('promptInput');
      i.focus(); i.value = '记两行笔记'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const first = await fx.waitForEval(`document.querySelector('.modal-backdrop.permission-modal') ? (window.state.currentId || window.state.selectedId || '') || 'shown' : null`, 200);
    ok(Boolean(first), 'R1 回合来要写文件的权限 → 弹窗出来了');
    const sessionId = await fx.evaluate(`String((window.state && (window.state.currentId || window.state.selectedId || (window.state.session && window.state.session.id))) || '')`);

    await fx.evaluate(`(location.reload(), true)`).catch(() => {});
    await sleep(1500);
    await fx.waitForEval(`window.state && window.state.config ? 1 : null`, 300);

    // 服务端那一侧：待决还在、回合没被结束。
    const pending = await fx.request('GET', '/api/interventions').catch(() => null);
    const sessions = await fx.request('GET', '/api/sessions').catch(() => null);
    const perms = ((pending && pending.json && pending.json.pending) || []).filter(iv => iv.type === 'permission');
    ok(perms.length === 1 && perms[0].toolName === 'file_write' && perms[0].deliverable === true && perms[0].live === true,
      `R2 刷新后权限还在服务端等着、回合还活着（/api/interventions 实测 ${JSON.stringify(perms.map(p => ({ tool: p.toolName, deliverable: p.deliverable, live: p.live })))}）`);

    // 页面回来后：那一个待决重新摆到面前。给页面自己找回会话的机会；找不回就是缺陷（R3 会红）。
    const again = await fx.waitForEval(`(() => {
      const modal = document.querySelector('.modal-backdrop.permission-modal');
      if (modal) return { kind: 'modal' };
      const inline = [...document.querySelectorAll('button')].find(b => /允许/.test(b.textContent || '') && b.offsetParent);
      return inline ? { kind: 'inline' } : null;
    })()`, 200);
    ok(Boolean(again), `R3 页面回来后，待决的权限重新摆到面前（实测 ${JSON.stringify(again)}；会话 ${sessionId}；会话表 ${sessions && sessions.json ? (sessions.json.sessions || []).length : '?'} 条）`);
    if (again) {
      await fx.evaluate(`(() => {
        const modal = document.querySelector('.modal-backdrop.permission-modal');
        const btn = modal ? [...modal.querySelectorAll('button')].find(b => b.classList.contains('primary'))
          : [...document.querySelectorAll('button')].find(b => /允许/.test(b.textContent || '') && b.offsetParent);
        btn.click(); return true;
      })()`);
    }
    let written = false;
    for (let i = 0; i < 100 && !written; i++) { written = fs.existsSync(target); if (!written) await sleep(100); }
    ok(written, 'R4 点「允许」→ notes.md 真的写出来了');
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nPERMISSION SURVIVES RELOAD BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
