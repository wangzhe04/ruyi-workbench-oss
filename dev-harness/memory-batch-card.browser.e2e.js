#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 浏览器 e2e(61 号文 C3:记忆批量提案的卡片)。真服务 + 假 provider + 无头浏览器,走用户真正看到的那条路:
//   C1 回合里模型调 workbench_memory_propose{items:[3 条]} → 回合一结束,对话里出现【一张】批量卡、三行、默认全勾;
//   C2 卡在窄屏下不横向溢出、每行的勾选框和名称在同一行可点;
//   C3 取消第 2 条 → 「保存选中」上的数跟着变成 2;点它 → 卡片收起、提示「已保存 2 条记忆」;
//   C4 盘上正好落了勾上的两条(正文对得上),第 2 条没写;候选状态里三条各自的结论如实(saved/dismissed/saved);
//   X  页面没有未捕获异常。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('MEMORY BATCH CARD BROWSER');
const { ok } = t;

const ITEMS = [
  { name: '构建产物不手改', description: '修改 server.js 这类生成文件时适用', type: 'convention', scope: 'project', body: '只改 app/src 下的源模块,改完跑 build 重新生成。', reason: '用户确认的项目约定' },
  { name: '测试收尾只杀自己的进程树', description: '写 e2e 清理子进程时适用', type: 'lesson', scope: 'project', body: '用 killOwnTree,不要 taskkill /T,也不要裸 child.kill()。', reason: '撞号误杀踩过坑' },
  { name: '路径按 Windows 形取文件名', description: '处理模型给的路径时适用', type: 'convention', scope: 'project', body: '取文件名用 path.win32.basename,它同时认反斜杠与正斜杠。', reason: 'Windows 是一等目标' },
];

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-memory-batch-card-', width: 1280, height: 900,
      config: { permissionMode: 'bypass', stewardEnabledV1: false },
      provider: async ctx => {
        const offered = (ctx.body.tools || []).some(x => x && x.function && x.function.name === 'workbench_memory_propose');
        if (!ctx.answered && offered) ctx.toolCall('workbench_memory_propose', { items: ITEMS }, 'call_mem_batch');
        else ctx.text('已把这三条合成一张候选卡,等你确认。');
        ctx.stop();
      },
    });
    await fx.evaluate(`(() => { try { localStorage.setItem('wcw.shellMode', 'classic'); } catch (e) {} location.reload(); return true; })()`);
    await sleep(600);
    ok(Boolean(await fx.waitForEval(`(() => document.getElementById('promptInput') && document.getElementById('newSessionBtn') ? 1 : null)()`, 600)), 'C0 经典壳就绪');
    await fx.evaluate(`(() => { document.getElementById('newSessionBtn').click(); return true; })()`);
    await fx.waitForEval(`(window.state && window.state.currentSession && window.state.currentSession.id) ? 1 : null`, 400);
    await fx.evaluate(`(() => {
      window.__toasts = [];
      const tray = document.getElementById('toastTray');
      if (tray) new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) window.__toasts.push(String(n.textContent || '')); }).observe(tray, { childList: true });
      const input = document.getElementById('promptInput');
      input.value = '把这三条项目约定记下来,以后都按这个来。';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const card = await fx.waitForEval(`(() => {
      const cards = document.querySelectorAll('#messages .memory-proposal-card');
      const c = cards[cards.length - 1];
      if (!c || !c.classList.contains('memory-proposal-batch')) return null;
      const rows = [...c.querySelectorAll('.memory-proposal-item')];
      return { cards: cards.length, rows: rows.map(r => r.querySelector('.memory-proposal-title').textContent),
        checked: [...c.querySelectorAll('input[type="checkbox"]')].map(b => b.checked),
        save: (c.querySelectorAll('.memory-proposal-actions button')[1] || {}).textContent || '' };
    })()`, 1200);
    ok(card && card.cards === 1 && card.rows.length === 3 && card.rows.join('|') === ITEMS.map(x => x.name).join('|'),
      `C1 回合结束后对话里出现一张批量卡、三行(got ${JSON.stringify(card)})`);
    ok(card && card.checked.every(Boolean) && /3/.test(card.save), 'C1b 默认全勾,「保存选中」带着 3');

    await fx.resize(420, 900);
    const narrow = await fx.evaluate(`(() => {
      const c = document.querySelector('#messages .memory-proposal-batch');
      const rows = [...c.querySelectorAll('.memory-proposal-item-head')].map(h => {
        const box = h.querySelector('input').getBoundingClientRect(); const name = h.querySelector('.memory-proposal-title').getBoundingClientRect();
        return { sameLine: box.top < name.bottom && name.top < box.bottom, boxW: box.width };
      });
      return { overflow: c.scrollWidth - c.clientWidth, rows };
    })()`);
    ok(narrow && narrow.overflow <= 1 && narrow.rows.every(r => r.sameLine && r.boxW > 0), `C2 窄屏(420px)不横向溢出,勾选框与名称同一行(got ${JSON.stringify(narrow)})`);
    await fx.resize(1280, 900);

    const after = await fx.evaluate(`(() => {
      const c = document.querySelector('#messages .memory-proposal-batch');
      c.querySelectorAll('input[type="checkbox"]')[1].click();
      return (c.querySelectorAll('.memory-proposal-actions button')[1] || {}).textContent || '';
    })()`);
    ok(/2/.test(after) && !/3/.test(after), `C3 取消第 2 条后「保存选中」变成 2(got ${JSON.stringify(after)})`);
    await fx.evaluate(`(() => { document.querySelector('#messages .memory-proposal-batch .memory-proposal-actions button.primary').click(); return true; })()`);
    const gone = await fx.waitForEval(`(() => document.querySelector('#messages .memory-proposal-card') ? null : (window.__toasts || []).join(' | ') || 'gone')()`, 400);
    ok(Boolean(gone), 'C3b 点「保存选中」后卡片收起');
    ok(typeof gone === 'string' && /已保存 2 条记忆/.test(gone), `C3c 提示说存了 2 条(got ${JSON.stringify(gone)})`);

    const projectDir = path.join(fx.home, 'memory', 'project');
    const files = fs.existsSync(projectDir) ? fs.readdirSync(projectDir, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(projectDir, f), 'utf8')) : [];
    ok(files.length === 2 && files.some(x => x.includes(ITEMS[0].body)) && files.some(x => x.includes(ITEMS[2].body)) && !files.some(x => x.includes(ITEMS[1].body)),
      `C4 盘上正好落了勾上的两条,第 2 条没写(实得 ${files.length} 个)`);
    const sid = await fx.evaluate('window.state.currentSession.id');
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(fx.home, 'memory', 'proposals', sid + '.json'), 'utf8')); } catch { st = null; }
    ok(st && st.current && st.current.status === 'saved' && st.current.proposal.items.map(x => x.status).join() === 'saved,dismissed,saved',
      'C4b 候选状态里三条各自的结论如实(saved/dismissed/saved)');
    ok(fx.exceptions.length === 0, `X 页面没有未捕获异常(${fx.exceptions.join(' | ')})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done();
  }
})();
