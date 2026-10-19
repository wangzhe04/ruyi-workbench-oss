'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, READY } = require('./lib/browser-fixture');
const t = createRunner('STEWARD MULTISTEP BROWSER'); const { ok } = t;
let fx, release, sid;
const exceptions = [];
const USER_TEXT = 'MULTISTEP_UI 先核对资料，再写比较报告，请作为一件事分两步办理。';
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-multistep-ui-', ok, width: 1440,
      config: { subagentMaxPerTurn: 4, stewardPollMs: 120000 },
      provider: async ctx => {
        const last = ctx.messages.findLastIndex(m => m.role === 'user'), text = String(ctx.messages[last]?.content || '');
        const tools = ctx.messages.slice(last + 1).filter(m => m.role === 'tool');
        if (text.includes('UI_FIRST')) { ctx.text('第一步核对中'); await new Promise(resolve => { release = () => { ctx.stop(); resolve(); }; }); }
        else if (text.includes('UI_SECOND')) { ctx.text('第二步已收到第一步结论。'); ctx.stop(); }
        else if (text.includes('MULTISTEP_UI')) {
          if (!tools.length) ctx.toolCall('steward_thread_new', { title: '资料汇总后写报告', brief: { userText: USER_TEXT }, steps: [{ task: 'UI_FIRST 先核对资料' }, { task: 'UI_SECOND 再写比较报告' }] });
          else { const receipt = JSON.parse(tools[0].content); sid = receipt.sessionId; ctx.text(JSON.stringify({ say: '已交办，先核对资料，再写报告；尚未完成。', why: '', actions: [], acts: [{ kind: 'open_thread', sessionId: sid, label: '查看任务' }] })); ctx.stop(); }
        } else { ctx.text('统一交付：两步均已完成，结论见任务记录。'); ctx.stop(); }
      }, prepare: async fixture => { fx = fixture; } });
    fx.cdp.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.text || 'exception'));
    await fx.setLens('steward');
    await fx.evaluate("(() => { const i=document.getElementById('stewardComposerInput'); i.value='MULTISTEP_UI 先核对资料，再写比较报告，请作为一件事分两步办理。'; i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('stewardComposerSend').click(); return true; })()");
    for (let i = 0; i < 300 && (!sid || !release); i++) await new Promise(resolve => setTimeout(resolve, 40));
    ok(!!sid && !!release, '真实管家工具循环创建单事项并启动第一步');
    await fx.setLens('classic');
    await fx.waitForEval(`document.querySelector('#railList [data-session-id="${sid}"] .steward-board-thread-title')?1:null`, 240);
    await fx.evaluate(`document.querySelector('#railList [data-session-id="${sid}"] .steward-board-thread-title').click(); true`);
    await fx.waitForEval(`window.state.currentSession?.id===${JSON.stringify(sid)}?1:null`, 160);
    await fx.evaluate("document.querySelector('[data-tab=\"agent-runs\"]').click();true");
    ok(await fx.waitForEval("document.querySelectorAll('#agentRunsList .agent-node').length===2?1:null", 240), '原有工作流面板显示同一 run 的两个步骤');
    const runs = (await fx.request('GET', '/api/agent-runs?sessionId=' + sid)).json.runs;
    ok(runs.length === 1 && runs[0].nodes[0].status === 'running' && runs[0].nodes[1].status === 'queued', '页面所读权威运行中，后序仍排队');
    await fx.evaluate("document.getElementById('mainViewTabCanvas').click();true");
    ok(await fx.waitForEval("document.querySelectorAll('#workbenchView .wb-node').length===2?1:null", 240), '班组画布可直接查看两步骤');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate("(() => {const v=document.getElementById('workbenchView');return v.getBoundingClientRect().width>0&&getComputedStyle(v).display!=='none'&&v.querySelectorAll('.wb-node').length===2;})()"), width + 'px 可见画布中的两步骤状态仍可查看');
      fs.writeFileSync(path.join(fx.root, 'steps-' + width + '.png'), await fx.screenshot());
    }
    await fx.cdp.send('Page.reload'); await fx.waitForEval(READY, 240);
    ok((await fx.request('GET', '/api/agent-runs?sessionId=' + sid)).json.runs.length === 1, '处理中刷新不重复创建 run');
    release(); release = null;
    for (let i = 0; i < 300; i++) { const r = (await fx.request('GET', '/api/agent-runs?sessionId=' + sid)).json.runs[0]; if (r.status === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 40)); }
    const completed = (await fx.request('GET', '/api/agent-runs?sessionId=' + sid)).json.runs[0];
    ok(completed.status === 'succeeded' && completed.nodes.every(n => n.status === 'succeeded'), '刷新后既有执行继续，最终两步真实成功');
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('en-US'))");
    await fx.evaluate("document.documentElement.dataset.theme='light';true");
    fs.writeFileSync(path.join(fx.root, 'steps-en-light.png'), await fx.screenshot());
    ok(exceptions.length === 0, '浏览器无未捕获异常');
    console.log('ARTIFACTS ' + fx.root);
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (release) release(); if (fx) await fx.close({ keepRoot: true }); t.done({ exit: true }); }
})();
