'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture } = require('./lib/browser-fixture');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD DELIVERY HISTORY BROWSER'); const { ok } = t;
let fx, sid, artifact, before, calls = 0;
// Drawers can repaint between CDP evaluations. Locate, validate and click in one browser turn.
async function clickWhenReady(selector, text = '') {
  const clicked = await fx.waitForEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.textContent.includes(${JSON.stringify(text)})) return null;
    el.click(); return 1;
  })()`);
  if (!clicked) throw new Error('delivery control did not become ready: ' + selector);
}
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-delivery-history-', ok, width: 1440,
      provider: ctx => { calls++; ctx.text('unexpected model call'); ctx.stop(); },
      prepare: async fixture => {
        process.env.RUYI_HOME = fixture.home; process.env.WIN_CLAUDE_WORKBENCH_HOME = fixture.home;
        const s = loadServerInternals(['createSession', 'saveSession', 'stewardCaptureDelivery']);
        const session = await s.createSession({ title: '历史两步交付', cwd: fixture.work }); sid = session.id;
        artifact = path.join(fixture.work, '汇总.md'); fs.writeFileSync(artifact, '# 汇总\n4 单，3000 元。');
        session.turnSeq = 1;
        const summary = { turnSeq: 1, artifacts: [{ path: artifact }], filesChanged: [] };
        await s.stewardCaptureDelivery(session, summary, { startedAt: Date.now() - 86400000 });
        session.messages = [{ role: 'user', content: '汇总订单', turnSeq: 1, createdAt: new Date(Date.now() - 86400000).toISOString() },
          { role: 'assistant', content: '已完成两步汇总，4 单、3000 元。', turnSeq: 1, turnSummary: summary, createdAt: new Date(Date.now() - 86399000).toISOString() }];
        await s.saveSession(session); before = JSON.stringify(session.messages);
        // 没有管家收件箱历史，模拟新到访/历史已清理；交付必须从原任务读取。
      } });
    // Make the independently loaded delivery controls arrive after the card body, as on CI.
    await fx.evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('/api/steward/delivery?')) await new Promise(resolve => setTimeout(resolve, 300));
        return response;
      };
      return true;
    })()`);
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:open-thread',{detail:{sessionId:${JSON.stringify(sid)}}}));true`);
    ok(await fx.waitForEval("document.getElementById('stewardDrawerFullTextBtn')?.textContent.includes('查看交付') ? 1 : null"), '任务抽屉提供已有交付入口');
    await clickWhenReady('#stewardDrawerFullTextBtn', '查看交付');
    const card = `.steward-deliverable[data-session-id="${sid}"][data-turn-seq="1"]`;
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(card)})?.textContent.includes('已完成两步汇总') ? 1 : null`), '无到访历史也能重开准确回合交付卡');
    // Switching lens/repainting the drawer is asynchronous; open the same actual task again.
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:open-thread',{detail:{sessionId:${JSON.stringify(sid)}}}));true`);
    if (!await fx.waitForEval("document.getElementById('stewardDrawerFullTextBtn')?.textContent.includes('查看交付') ? 1 : null")) throw new Error('history delivery control did not reload');
    await clickWhenReady('#stewardDrawerFullTextBtn', '查看交付');
    ok(await fx.evaluate(`document.querySelectorAll(${JSON.stringify(card)}).length===1`), '重复打开定位现有交付而不重复插卡');
    if (!await fx.waitForEval(`document.querySelector(${JSON.stringify(card + ' .steward-deliverable-more')})`)) throw new Error('history delivery body did not load');
    await clickWhenReady(card + ' .steward-deliverable-more');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(card + ' .steward-deliverable-more')}).getAttribute('aria-expanded')==='true'`), '重开的历史交付可展开全文');
    // The card body renders before the delivery API response paints its revision control.
    await clickWhenReady(card + ' .steward-delivery-revise');
    ok(await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label')?.textContent.includes('修订第 1 轮') ? 1 : null"), '历史交付继续修改挂接同一真实修订输入区');
    if (!await fx.waitForEval(`(() => {
      const input = document.getElementById('stewardComposerInput');
      const cancel = document.getElementById('stewardComposerCancelTarget');
      if (!input || !cancel || cancel.hidden) return null;
      input.value = '只改标题'; cancel.click(); return 1;
    })()`)) throw new Error('delivery revision cancel control did not become ready');
    ok(await fx.evaluate("document.getElementById('stewardComposerCancelTarget').hidden&&document.getElementById('stewardComposerInput').value==='只改标题'"), '历史交付修订可独立取消并保留草稿');
    const result = await fx.request('GET', '/api/sessions/' + sid);
    ok(JSON.stringify(result.json.session.messages) === before && result.json.session.turnSeq === 1, '查看与取消不新增任务回合或改变原执行记录');
    ok(fs.readFileSync(artifact, 'utf8') === '# 汇总\n4 单，3000 元。' && calls === 0, '操作不调用模型、不修改已有产物');
    ok(fx.exceptions.length === 0, '无未捕获浏览器异常');
  } catch (error) { t.fail(error.stack); }
  finally { if (fx) await fx.close(); }
  t.done({ exit: true });
})();
