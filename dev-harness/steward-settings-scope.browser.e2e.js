'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep, READY } = require('./lib/browser-fixture');
const t = createRunner('STEWARD SETTINGS SCOPE BROWSER'); const { ok } = t;
let fx, taskId, heldModel, release;
const exceptions = [];
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-settings-scope-ui-', ok, width: 1440,
      config: { newThreadEngine: 'last', stewardPollMs: 120000, lastUsedEngineRoute: { engine: 'openai', providerId: 'fake', model: 'fake-model' } },
      provider: async ctx => {
        const lastUser = ctx.messages.findLastIndex(m => m.role === 'user');
        const text = String(ctx.messages[lastUser]?.content || '');
        const tools = ctx.messages.slice(lastUser + 1).filter(m => m.role === 'tool');
        if (text.includes('SETTINGS_WAIT_NATIVE')) {
          if (!tools.length) ctx.toolCall('steward_config_get', { keys: ['questionTimeoutMs'] });
          else if (tools.length === 1) ctx.toolCall('steward_config_set', { patch: { questionTimeoutMs: 360000 }, expected: { questionTimeoutMs: JSON.parse(tools[0].content).values.questionTimeoutMs } });
          else { ctx.text(JSON.stringify({ say: '等待设置已保存。', why: '用户要求', acts: [], actions: [] })); ctx.stop(); }
        } else if (text.includes('SCOPE_HOLD')) {
          heldModel = ctx.body.model; ctx.text('当前执行仍用 ' + heldModel);
          await new Promise(resolve => { release = () => { ctx.stop(); resolve(); }; });
        } else { ctx.text(text.includes('SCOPE_ECHO') ? 'MODEL=' + ctx.body.model : JSON.stringify({ say: '无需操作。', why: '', acts: [], actions: [] })); ctx.stop(); }
      },
      prepare: async fixture => {
        fx = fixture;
        const cfg = (await fixture.request('GET', '/api/status')).json.config;
        await fixture.request('POST', '/api/config', { providers: cfg.providers.map(p => ({ ...p, models: [{ id: 'fake-model' }, { id: 'strong-model' }] })) });
        const made = await fixture.request('POST', '/api/sessions', { title: '作用域测试任务', cwd: fixture.work });
        taskId = made.json.session.id;
      } });
    fx.cdp.on('Runtime.exceptionThrown', detail => exceptions.push(detail.exceptionDetails?.text || 'browser exception'));
    await fx.setLens('steward');
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');i.value='SETTINGS_WAIT_NATIVE：把提问等待改为六分钟';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('stewardComposerSend').click();return true;})()");
    ok(await fx.waitForEval("document.querySelector('#stewardFeed [data-receipt=settings]')?.textContent.includes('360000')?1:null", 240), '真工具循环的设置直调生成可见实际值回执');
    const readConfig = async () => (await fx.request('GET', '/api/status')).json.config;
    ok((await readConfig()).questionTimeoutMs === 360000, '回执与设置页所读真配置一致');
    ok(await fx.waitForEval("window.state.config.questionTimeoutMs===360000&&document.getElementById('cfgQuestionTimeout')?.value==='360000'?1:null"), '真实设置控件随回执重读，不停在旧值');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate("(() => {const n=document.querySelector('#stewardFeed [data-receipt=settings]');return n&&n.scrollWidth<=n.clientWidth+1&&n.getBoundingClientRect().right<=innerWidth;})()"), width + 'px 回执完整换行，无横向溢出');
      fs.writeFileSync(path.join(fx.root, 'settings-' + width + '.png'), await fx.screenshot());
    }
    await fx.resize(1440, 960);
    await fx.cdp.send('Page.reload'); await fx.waitForEval(READY, 160); await fx.setLens('steward');
    ok(await fx.waitForEval("document.querySelector('#stewardFeed [data-receipt=settings]')?.textContent.includes('读取新配置后')?1:null", 160), '刷新历史仍显示值与真实生效时机');
    await fx.request('POST', '/api/config', { questionTimeoutMs: 420000 });
    await fx.evaluate("document.querySelector('#stewardFeed [data-receipt=settings] button').click();true");
    ok(await fx.waitForEval("document.querySelector('#stewardFeed [data-undo-state=conflict]')?1:null"), '旧回执撤销冲突如实显示，不覆盖后来改动');
    ok((await readConfig()).questionTimeoutMs === 420000, '冲突后真实配置保留');
    // 同一生产渲染器用于成功、丢回包及英文界面，写入仍走真实 act/config 工具。
    const changed = await fx.request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_config_set', args: { patch: { questionTimeoutMs: 480000 } } } });
    await fx.evaluate(`import('/js/steward-settings-receipt.js').then(async m=>{const {t,setLocale}=await import('/js/i18n.js');await setLocale('en-US');const host=document.createElement('div');host.id='scopeReceiptProbe';document.getElementById('stewardFeed').appendChild(host);const api=async(url,init)=>{const r=await fetch(url,{...init,headers:{'content-type':'application/json','x-wcw-token':${JSON.stringify(fx.token)}}});return r.json();};m.appendSettingsReceipt(host,${JSON.stringify(changed.json.result)},{t,api});return true;})`);
    ok(await fx.evaluate("document.querySelector('#scopeReceiptProbe').textContent.includes('Scope: application')&&document.querySelector('#scopeReceiptProbe').textContent.includes('waits created with fresh')"), '英文回执说明应用范围和下次等待时机');
    fs.writeFileSync(path.join(fx.root, 'settings-en.png'), await fx.screenshot());
    await fx.evaluate("document.querySelector('#scopeReceiptProbe button').click();true");
    ok(await fx.waitForEval("document.querySelector('#scopeReceiptProbe [data-undo-state=done]')?1:null"), '真实撤销成功后按恢复后的值回显');
    ok((await readConfig()).questionTimeoutMs === 420000, '撤销确实恢复原值');
    ok(await fx.waitForEval("document.getElementById('cfgQuestionTimeout')?.value==='420000'?1:null"), '撤销后真实设置控件同步恢复值');
    await fx.evaluate("document.getElementById('cfgStewardDecisionsRefreshBtn').click();true");
    ok(await fx.waitForEval("document.querySelector('#cfgStewardDecisions [data-receipt=settings]')?.textContent.includes('waits created with fresh')?1:null"), '行动流水重用同一设置回执与撤销入口');
    const lost = await fx.request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_config_set', args: { patch: { questionTimeoutMs: 600000 } } } });
    await fx.evaluate(`import('/js/steward-settings-receipt.js').then(async m=>{const {t}=await import('/js/i18n.js');const host=document.createElement('div');host.id='scopeLostProbe';document.getElementById('stewardFeed').appendChild(host);const api=async(url,init)=>{await fetch(url,{...init,headers:{'content-type':'application/json','x-wcw-token':${JSON.stringify(fx.token)}}});throw new Error('lost response');};m.appendSettingsReceipt(host,${JSON.stringify(lost.json.result)},{t,api});host.querySelector('button').click();return true;})`);
    ok(await fx.waitForEval("document.querySelector('#scopeLostProbe [data-undo-state=unknown]')?1:null"), '真实撤销已提交但回包丢失时只说未确认');
    ok((await readConfig()).questionTimeoutMs === 420000 && await fx.evaluate("document.querySelector('#scopeLostProbe button').disabled"), '未确认入口禁用，不自动重发');
    // 用任务顶部的既有模型菜单，在正在跑的回合中切换。
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('zh-CN'))");
    await fx.setLens('classic');
    await fx.waitForEval(`document.querySelector('#railList .steward-board-thread[data-session-id="${taskId}"] .steward-board-thread-title')?1:null`, 160);
    await fx.evaluate(`document.querySelector('#railList .steward-board-thread[data-session-id="${taskId}"] .steward-board-thread-title').click();true`);
    await fx.waitForEval(`window.state.currentSession?.id===${JSON.stringify(taskId)}?1:null`);
    const running = fx.request('POST', '/api/chat/stream', { sessionId: taskId, message: 'SCOPE_HOLD', cwd: fx.work });
    for (let i = 0; i < 120 && !release; i++) await sleep(50);
    ok(heldModel === 'fake-model', '在途回合在开始时绑定原模型');
    await fx.evaluate("document.querySelector('#threadChips [data-chip=model]').click();true");
    await fx.waitForEval("document.querySelector('#threadChips [data-model-id=strong-model]')?1:null");
    await fx.evaluate("document.querySelector('#threadChips [data-model-id=strong-model]').click();true");
    ok(await fx.waitForEval("document.querySelector('#threadChips [data-chip=model]')?.textContent.includes('strong-model')?1:null"), '任务模型入口显示下一回合选择');
    ok(await fx.evaluate("document.body.textContent.includes('仅此任务已选择模型 strong-model')&&!document.body.textContent.includes('仅此任务已选择模型 {model}')"), '模型选择提示插入真实模型名，并说明仅此任务和下一回合');
    ok(heldModel === 'fake-model', '切换不替换在途回合的模型');
    release(); release = null; await running;
    await fx.request('POST', '/api/chat/stream', { sessionId: taskId, message: 'SCOPE_ECHO', cwd: fx.work });
    const session = (await fx.request('GET', '/api/sessions/' + taskId)).json.session;
    ok(session.messages.filter(m => m.role === 'assistant').at(-1)?.content === 'MODEL=strong-model', '下一回合真实请求使用所选模型');
    const next = (await fx.request('POST', '/api/sessions', { title: '下一条', cwd: fx.work })).json.session;
    ok(next.engineRoute.model === 'fake-model' && (await readConfig()).lastUsedEngineRoute.model === 'fake-model', '执行过仅此任务的模型后，新任务及上次默认仍保持原选择');
    await fx.evaluate("document.querySelector('#threadChips [data-chip=model]').click();true");
    await fx.waitForEval("document.querySelector('#threadChips [data-chip-action=setDefault]')?1:null");
    await fx.evaluate("document.querySelector('#threadChips [data-chip-action=setDefault]').click();true");
    for (let i=0;i<100 && (await readConfig()).lastUsedEngineRoute.model !== 'strong-model';i++) await sleep(40);
    const explicitDefault = (await fx.request('POST', '/api/sessions', { title: '明确改默认之后', cwd: fx.work })).json.session;
    ok(explicitDefault.engineRoute.model === 'strong-model', '只有显式设为新任务默认才改变后续任务模型');
    ok(exceptions.length === 0, '完整设置旅程没有未捕获浏览器异常');
    console.log('ARTIFACTS ' + fx.root);
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { release?.(); if (fx) await fx.close({ keepRoot: true }); t.done({ exit: true }); }
})();
