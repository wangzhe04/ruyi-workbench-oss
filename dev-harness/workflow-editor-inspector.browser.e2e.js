#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：两处「局部变量 t 遮住 i18n 的 t()」的回归（2026-09 README 截图走查时撞见）。
//
// ① 工作流图形编辑器的节点检查器：五个下拉的选项表写成 `for (const [v, t] of [['', t('…')], …])` ——
//    for…of 头里的绑定名 t 在求值右边那张表时还处于暂时性死区，`t('…')` 抛 ReferenceError。
//    后果：打开编辑器（它会选中第一个节点）或点任何一个节点，检查器整块空白，节点的任务 / 角色 / 引擎 /
//    质量门都改不了。原来那件 agent-workflow-editor-ui.e2e 只读源码字面量，从没真跑过这段。
// ② 命令面板「把当前输入存为模板」：函数里 `const t = getTemplates()` 让同一函数里前面的 `t('…')`
//    落进死区，一按就抛错，模板从来存不进去。
//
// 覆盖：
//   W1 打开编辑器零未捕获异常，检查器里真画出了任务框和引擎下拉（引擎下拉带「OpenAI Provider」一项）；
//   W2 点另一张节点卡，检查器跟着换成那个节点的任务，且不抛 setPointerCapture 的 InvalidStateError（③ 同批修的小洞）；
//   W3 质量门 / 失败策略 / 依赖策略 / 工具级别四个下拉都画出来了（同一族写法的另外四处）；
//   P1 命令面板存模板：localStorage 里多出这条模板，零未捕获异常。
// 判定行：`WORKFLOW EDITOR INSPECTOR BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('WORKFLOW EDITOR INSPECTOR BROWSER');
const { ok } = t;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-wf-inspector-' });
    await fx.waitForEval(`document.getElementById('workflowEditorBtn') ? 1 : null`, 300);
    await sleep(300);
    const before = fx.exceptions.length;
    await fx.evaluate(`document.getElementById('workflowEditorBtn').click()`);
    const opened = await fx.waitForEval(`document.querySelector('textarea[data-wf-field="task"]') ? 1 : null`, 200);
    const w1 = await fx.evaluate(`(() => {
      const task = document.querySelector('textarea[data-wf-field="task"]');
      const selects = [...document.querySelectorAll('select')].filter(s => s.offsetParent);
      const engine = selects.find(s => [...s.options].some(o => o.value === 'openai'));
      return { task: task ? task.value.slice(0, 60) : null, engineLabels: engine ? [...engine.options].map(o => o.textContent) : null };
    })()`);
    ok(opened === 1 && fx.exceptions.length === before,
      `W1 打开编辑器：检查器画出任务框、零未捕获异常（异常 ${JSON.stringify(fx.exceptions.slice(before))}）`);
    ok(Array.isArray(w1.engineLabels) && w1.engineLabels.includes('OpenAI Provider') && w1.engineLabels.length === 3 && w1.engineLabels[0].length > 0,
      `W1b 引擎下拉三项、第一项是本地化的「自动」文案（实测 ${JSON.stringify(w1.engineLabels)}）`);

    // 点另一张节点卡（与用户点卡片同一条 pointerdown 路径）。换选时 flushInspector 会重画图、被点的那张卡
    // 已脱离文档，修前 setPointerCapture 在这里抛 InvalidStateError（未捕获异常，这一下拖不动）。
    const w2 = await fx.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('[data-node-id]')].filter(c => c.offsetParent);
      const other = cards.find(c => !c.classList.contains('selected') && !c.classList.contains('sel')) || cards[1];
      if (!other) return { error: 'no second card' };
      const r = other.getBoundingClientRect();
      const opts = { button: 0, buttons: 1, bubbles: true, pointerId: 1, clientX: r.left + 10, clientY: r.top + 10 };
      other.dispatchEvent(new PointerEvent('pointerdown', opts));
      document.dispatchEvent(new PointerEvent('pointerup', opts));
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      await new Promise(r => setTimeout(r, 300));
      const all = [...document.querySelectorAll('textarea[data-wf-field="task"]')];
      const task = all.find(x => x.offsetParent) || all[0];
      return { picked: other.dataset.nodeId, task: task ? task.value.slice(0, 60) : null };
    })()`);
    ok(!w2.error && w2.task !== null && w2.task !== w1.task && fx.exceptions.length === before,
      `W2 点另一张节点卡（${w2.picked}）后检查器换成它的任务、零未捕获异常（前「${w1.task}」→ 后「${w2.task}」；异常 ${JSON.stringify(fx.exceptions.slice(before))}）`);

    const w3 = await fx.evaluate(`(() => {
      const selects = [...document.querySelectorAll('select')].filter(s => s.offsetParent);
      const has = values => selects.some(s => values.every(v => [...s.options].some(o => o.value === v)));
      return { gate: has(['review', 'verify']), failure: has(['block', 'continue', 'retry']), deps: has(['all_success', 'all_settled']), tier: has(['read', 'edit']) };
    })()`);
    ok(w3.gate && w3.failure && w3.deps && w3.tier, `W3 质量门 / 失败策略 / 依赖策略 / 工具级别四个下拉都画出来了（${JSON.stringify(w3)}）`);
    await fx.evaluate(`(() => { const x = [...document.querySelectorAll('button')].find(b => b.offsetParent && /^(取消|Cancel)$/.test(b.textContent.trim())); if (x) x.click(); return true; })()`);
    await sleep(300);

    const p0 = fx.exceptions.length;
    const p1 = await fx.evaluate(`(async () => {
      try { localStorage.removeItem('wcw.templates'); } catch {}
      window.prompt = () => '回归模板';
      const input = document.getElementById('promptInput');
      input.value = '每周一把上周新增文件整理成清单';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const q = document.getElementById('paletteInput');
      if (!q) return { error: 'no palette' };
      const items = [...document.querySelectorAll('#paletteList .palette-item')];
      const item = items.find(i => /模板|template/i.test(i.textContent));
      if (!item) return { error: 'no template item', items: items.map(i => i.textContent).slice(0, 20) };
      item.click();
      await new Promise(r => setTimeout(r, 300));
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem('wcw.templates') || '[]'); } catch {}
      return { saved };
    })()`);
    ok(!p1.error && Array.isArray(p1.saved) && p1.saved.some(x => x && x.name === '回归模板') && fx.exceptions.length === p0,
      `P1 命令面板「把当前输入存为模板」真存进去了、零未捕获异常（${JSON.stringify(p1)}；异常 ${JSON.stringify(fx.exceptions.slice(p0))}）`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
