'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep, READY } = require('./lib/browser-fixture');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD DECISIONS BROWSER'); const { ok } = t;
let fx; const ids = {};
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-decisions-ui-', ok, width: 1440,
      config: { stewardMaxParallelThreads: 8, permissionMode: 'default' },
      provider: ctx => {
        const text = ctx.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
        if (ctx.answered) { ctx.text('已收到本条决定。'); ctx.stop(); }
        else if (text.includes('DECISION_PERMISSION')) ctx.toolCall('powershell_run', { command: 'Write-Output decision-fixture' });
        else if (text.includes('DECISION_QUESTION')) ctx.toolCall('request_user_input', { questions: [{ header: '取舍', question: '同样的问题？', options: [{ label: '方案甲' }, { label: '方案乙' }], allowOther: true }] });
        else if (text.includes('DECISION_PLAN')) { ctx.text('PLAN:\n' + '计划说明。\n'.repeat(100) + '完整计划结尾'); ctx.stop(); }
        else { ctx.text('无需动作。'); ctx.stop(); }
      },
      prepare: async fixture => {
        fx = fixture;
        await fixture.request('POST', '/api/steward/visit', {});
        process.env.RUYI_HOME = fixture.home; process.env.WIN_CLAUDE_WORKBENCH_HOME = fixture.home;
        const s = loadServerInternals(['createSession', 'saveSession', 'createMissionContainer']);
        const m1 = (await s.createMissionContainer({ title: '季度事项' })).mission;
        const m2 = (await s.createMissionContainer({ title: '季度事项' })).mission;
        for (const [name, command] of [['a', 'DECISION_PERMISSION'], ['b', 'DECISION_PERMISSION'], ['q', 'DECISION_QUESTION'], ['q2', 'DECISION_QUESTION'], ['plan', 'DECISION_PLAN']]) {
          const cwd = path.join(fixture.work, name); fs.mkdirSync(cwd);
          const session = await s.createSession({ title: '同名任务', cwd });
          session.missionId = name === 'plan' ? m2.missionId : m1.missionId;
          if (name === 'plan') session.permissionMode = 'plan';
          await s.saveSession(session); ids[name] = session.id;
          const launched = await fixture.request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: session.id, message: command } }, attemptId: 'decision-seed-' + name });
          if (!launched.json?.executed) throw new Error('launch failed '+JSON.stringify(launched.json));
        }
        let pending;
        for (let i = 0; i < 240; i++) { pending = (await fixture.request('GET', '/api/interventions?view=steward&limit=100')).json?.pending; if (pending?.length === 5) break; await sleep(50); }
        if (pending?.length !== 5) throw new Error('pending fixtures not ready '+JSON.stringify(pending));
        for (const [name, sid] of Object.entries(ids)) ids[name + 'Iv'] = pending.find(iv => iv.sessionId === sid);
      } });
    const open = async () => {
      await fx.setLens('steward');
      await fx.evaluate("(() => {for(const m of document.querySelectorAll('.prompt-queue-modal'))m.__cancel?.();document.getElementById('stewardDecisionsBtn').click();return true;})()");
      if (!await fx.waitForEval("document.querySelectorAll('.steward-decisions-modal .steward-decision').length===5 ? 1 : null", 200)) throw new Error('decision list unavailable');
    };
    const selector = name => '.steward-decisions-modal .steward-decision[data-intervention-id="' + ids[name + 'Iv'].id + '"]';
    const expand = name => fx.evaluate(`document.querySelector(${JSON.stringify(selector(name))}).open=true;true`);
    const click = (name, label) => fx.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector(name))});const b=[...r.querySelectorAll('button')].find(n=>n.textContent===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`);
    const phase = (name, value) => fx.waitForEval(`document.querySelector(${JSON.stringify(selector(name))})?.dataset.phase===${JSON.stringify(value)} ? 1 : null`, 200);
    await open();
    await fx.cdp.send('Page.bringToFront');
    await fx.evaluate("(() => {const original=window.fetch;window.decisionViewingUrls=[];window.fetch=function(url,...args){if(String(url).includes('/api/events/stream'))window.decisionViewingUrls.push(String(url));return original.call(this,url,...args);};return true;})()");
    ok(await fx.evaluate("document.querySelectorAll('.steward-decision-group').length===2"), '同名事项按身份分为两组,同文问题保留五条独立待决');
    await expand('plan');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(selector('plan'))}).textContent.includes('完整计划结尾')`), '审批展示完整计划,没有只给前 500 字摘要');
    await expand('q2');
    await fx.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector('q2') + ' textarea')});input.value='保留这份回答草稿';input.focus();input.dispatchEvent(new Event('pointerdown',{bubbles:true}));return true;})()`);
    ok(await fx.waitForEval(`window.decisionViewingUrls.some(url=>new URL(url,location.href).searchParams.get('viewing')===${JSON.stringify(ids.q2)}) ? 1 : null`, 200), '在场信号只报告当前展开的待决,不包含被模态遮住的来源');
    await fx.evaluate("(() => {window.decisionFetch=window.fetch;window.failDecisionRead=true;window.decisionPosts=[];window.fetch=async function(url,init){const u=String(url);if(u.includes('/interventions/')&&init?.method==='POST')window.decisionPosts.push(JSON.parse(init.body));if(u.includes('/api/interventions?view=steward')&&window.failDecisionRead){if(window.failDecisionRead==='degraded')return new Response(JSON.stringify({ok:true,pending:[],counts:{total:0},index:{degraded:{active:true}}}),{status:200});return new Response(JSON.stringify({ok:false,error:{code:'fixture.read_failed'}}),{status:500});}return window.decisionFetch.apply(this,arguments);};document.querySelector('.steward-task-decisions button').click();return true;})()");
    ok(await fx.waitForEval("document.querySelector('.steward-task-decisions').textContent.includes('保留上次清单') ? 1 : null"), '读取失败保留原清单并标明过时');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(selector('q2') + ' textarea')}).value==='保留这份回答草稿'&&document.querySelector(${JSON.stringify(selector('q2') + ' textarea')}).disabled`), '刷新失败不清空回答,过时快照不能提交');
    await fx.evaluate("window.failDecisionRead='degraded';document.querySelector('.steward-task-decisions button').click();true");
    await sleep(200);
    ok(await fx.evaluate("document.querySelectorAll('.steward-decision').length===5&&document.querySelector('.steward-task-decisions').textContent.includes('保留上次清单')"), '不完整的索引不能冒充空清单或成功刷新');
    await fx.evaluate("window.failDecisionRead=false;document.querySelector('.steward-task-decisions button').click();true");
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(selector('q2') + ' textarea')})?.disabled===false ? 1 : null`), '刷新恢复后原草稿仍可继续');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate("(() => {const p=document.querySelector('.steward-decisions-modal .modal');return p.scrollWidth<=p.clientWidth+1&&p.getBoundingClientRect().right<=innerWidth;})()"), width + 'px 待决、来源与操作不横向溢出');
      fs.writeFileSync(path.join(fx.root, 'decisions-' + width + '.png'), await fx.screenshot());
    }
    await fx.resize(1440, 960);
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('en-US')).then(()=>{document.documentElement.dataset.theme='light';return true;})");
    ok(await fx.evaluate("document.querySelector('.steward-decisions-modal').textContent.includes('Task decisions')&&document.querySelector('.steward-decisions-modal').textContent.includes('Send this answer')&&document.querySelector('.steward-decisions-modal .modal').getAttribute('aria-label')==='Task decisions'"), '切换英文浅色保留表单并更新操作文字和无障碍标题');
    fs.writeFileSync(path.join(fx.root, 'decisions-en-light.png'), await fx.screenshot());
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('zh-CN'))");
    await expand('b');
    await fx.evaluate(`(() => {window.fetch=async function(url,init){if(String(url).includes('/interventions/${ids.bIv.id}/decision')&&init?.method==='POST')return new Response(JSON.stringify({ok:false,error:{code:'intervention.persist_failed'}}),{status:503});return window.decisionFetch.apply(this,arguments);};return true;})()`);
    await click('b', '允许这一次');
    ok(await phase('b', 'failed'), '单项写盘失败如实留在原行');
    await fx.evaluate('window.fetch=window.decisionFetch;true');
    await expand('q');
    await fx.evaluate(`document.querySelectorAll(${JSON.stringify(selector('q') + ' input')})[1].click();true`);
    await click('q', '提交本条回答');
    ok(await phase('q', 'success'), '另一项回答独立成功');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(selector('q2') + ' textarea')}).value==='保留这份回答草稿'&&document.querySelector(${JSON.stringify(selector('b'))}).dataset.phase==='failed'`), '同文问题没有被批成同一答案,失败项也没有被隐藏');
    ok(await fx.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector('b'))});return !r.open&&r.querySelector('[data-receipt-badge]').textContent.includes('本次未应用');})()`), '另一项成功后,折叠行仍直接展示失败回执');
    const external = await fx.request('POST', '/api/missions/' + ids.b + '/interventions/' + ids.bIv.id + '/decision', { expectedVersion: 0, idempotencyKey: 'other-entry-deny', action: 'deny' });
    ok(external.json?.status === 'denied', '在另一个入口拒绝同一待决');
    await fx.evaluate("document.querySelector('.steward-task-decisions button').click();true");
    ok(await phase('b', 'settled'), '他处已答后显示原拒绝状态并禁用旧按钮');
    await expand('a');
    await fx.evaluate(`(() => {window.fetch=async function(url,init){const response=await window.decisionFetch.apply(this,arguments);if(String(url).includes('/interventions/${ids.aIv.id}/decision')&&init?.method==='POST')await new Promise(resolve=>window.releaseDecisionReply=resolve);return response;};return true;})()`);
    await click('a', '拒绝这一次');
    ok(await phase('a', 'sending'), '回包尚未确认时显示提交中');
    await fx.evaluate("document.querySelector('.steward-task-decisions button').click();true");
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(selector('a'))}).querySelector('[data-action="allow"]').disabled`), '处理中刷新不会恢复批准按钮');
    let loaded;
    const loading = new Promise(resolve => fx.cdp.on('Page.loadEventFired', resolve)); await fx.cdp.send('Page.reload'); await loading;
    await fx.waitForEval(READY); await open();
    ok(await phase('a', 'settled'), '处理中整页刷新后从原日志恢复回执,不重发决定');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(selector('a'))}).textContent.includes('已拒绝')`), '原拒绝不会变成批准');
    const history = (await fx.request('GET', '/api/interventions/' + ids.a + '?limit=100')).json;
    ok(history.interventions.find(iv => iv.id === ids.aIv.id).interventionVersion === 2, '刷新没有重复执行,日志只走一次 pending→applying→denied');
    await fx.escape();
    ok(await fx.evaluate("!document.querySelector('.steward-decisions-modal')"), '关闭清单只是收起,不代替任何待决做决定');
    const remaining = (await fx.request('GET', '/api/interventions?view=steward&limit=100')).json.pending;
    ok(remaining.some(iv => iv.id === ids.q2Iv.id) && remaining.some(iv => iv.id === ids.planIv.id), '收起后剩余问题和计划仍待决');
    await fx.evaluate(`import('/js/steward-decisions.js').then(({createStewardDecisions})=>import('/js/i18n.js').then(({t})=>{
      sessionStorage.removeItem('ruyi.steward.decisions.v1');const handlers={};let calls=0;
      const api=()=>new Promise(resolve=>{if(++calls===1)window.oldDecisionRead=resolve;else{window.freshDecisionRead=resolve;window.freshDecisionStarted=true;}});
      window.decisionRace=createStewardDecisions({api,t,isStewardMode:()=>true,eventStream:{on:(key,fn)=>handlers[key]=fn},openThread:()=>{}});
      window.decisionRace.bind();window.decisionRace.open();handlers['server.instance']();
      window.oldDecisionRead({ok:true,pending:[{id:'iv-old',sessionId:'source-old',type:'permission',interventionVersion:0,deliverable:true,detailsComplete:true,detailsText:'{}'}],counts:{total:1}});return true;
    }))`);
    await fx.waitForEval('window.freshDecisionStarted ? 1 : null', 100);
    ok(await fx.evaluate("!document.querySelector('.steward-decision[data-intervention-id=\"iv-old\"]')"), '服务换进程后迟到的旧清单不能恢复可批准按钮');
    await fx.evaluate("window.freshDecisionRead({ok:true,pending:[],counts:{total:0}});true");
    ok(await fx.waitForEval("document.querySelector('.steward-task-decisions')?.textContent.includes('当前没有待决') ? 1 : null", 100), '换进程后重新读取新快照');
    await fx.evaluate('window.decisionRace.close();true');
    ok(fx.exceptions.length === 0, '无未捕获界面异常');
    console.log('SCREENSHOTS ' + fx.root);
    await fx.close({ keepRoot: true }); fx = null;
  } catch (error) { t.fail(error.stack); if (fx) { try { console.log('BROWSER-DIAG '+JSON.stringify(await fx.evaluate("({text:document.body.textContent.slice(-2500),errors:window.state?.status})"))); } catch {} } }
  finally { if (fx) await fx.close(); }
  t.done({ exit: true });
})();
