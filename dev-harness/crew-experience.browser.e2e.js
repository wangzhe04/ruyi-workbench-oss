'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const runner = createRunner('CREW EXPERIENCE BROWSER');
const { ok } = runner;

// Real production domain + CSS, injected run snapshots and deferred action responses.
// No model calls: verify navigation, draft ownership, keyboard and actual layout bounds.
(async () => {
  let fx;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-crew-ux-', width: 1440, height: 960, config: { theme: 'light' }, prepare: async started => { fx = started; } });
    await fx.setLens('classic');
    await fx.evaluate(`(async () => {
      const { createWorkbenchDomain } = await import('/js/workbench.js');
      const { t } = await import('/js/i18n.js');
      window.crewActions = [];
      window.crewDomain = createWorkbenchDomain({
        agentRunActive: new Set(['running', 'waiting_pool']),
        agentRunStatusLabel: s => ({running:'运行中',succeeded:'已完成',failed:'失败',queued:'排队中',skipped:'已跳过'}[s] || s),
        nodeDisplayStatus: n => n.status,
        steerAgentNode: (...args) => new Promise(resolve => { crewActions.push(args); window.finishSteer = resolve; }),
        poolDecide: async (...args) => crewActions.push(args)
      });
      window.crewRuns = [{ id:'run-research-20261015', title:'调研与交付', live:true, status:'running',
        nodes:[
          {id:'plan',roleLabel:'任务规划',status:'succeeded',task:'整理研究问题',dependsOn:[]},
          {id:'research',roleLabel:'资料研究',status:'running',task:'核对资料来源',model:'research-model',dependsOn:['plan'],progressLog:[{text:'正在核对第三份资料'}]},
          {id:'review',roleLabel:'结果审核',status:'running',task:'交叉核验结论',dependsOn:['plan']},
          {id:'report',roleLabel:'报告整理',status:'failed',task:'生成交付报告',error:'输出文件暂不可用',dependsOn:['research','review']},
          {id:'skip',roleLabel:'可选附录',status:'skipped',dependsOn:['report']}
        ], taskPool:[{id:'pool-1',status:'proposed',task:'补充核对一份来源',roleId:'review'}], messages:[], totalTokens:23400
      }, {id:'run-older',title:'上一轮资料整理',status:'succeeded',live:false,nodes:[{id:'plan',status:'succeeded',roleLabel:'任务规划',task:'旧任务'}]}];
      crewDomain.bindWorkbench(); crewDomain.wbOnRuns(crewRuns);
      document.getElementById('mainViewTabCanvas').click();
      return true;
    })()`);
    const read = expr => fx.evaluate(`(${expr})`);
    ok(await read(`document.querySelector('#wbOverview').textContent.includes('2 / 5') === false && document.querySelector('#wbOverview').textContent.includes('1 / 5')`), 'C1 成功计数不把跳过与失败算成完成');
    ok(await read(`document.querySelector('.wb-node-title').textContent === '任务规划'`), 'C2 卡片优先显示角色名称');
    await fx.evaluate(`document.querySelector('[data-fk="overview:details"]').focus(); document.querySelector('[data-fk="overview:details"]').click()`);
    ok(await read(`document.querySelector('#wbSide [data-sec="pool"]').classList.contains('open')`), 'C3 待审批入口直接展开任务池');
    await fx.evaluate(`document.querySelector('#wbSide .wb-side-close').click(); document.querySelector('[data-node-id="research"]').click(); document.getElementById('wbSteerInput').value='只给研究员的草稿'; document.getElementById('wbSteerInput').dispatchEvent(new Event('input')); document.getElementById('wbSteerInput').blur(); crewRuns[0].nodes[1].progressLog.push({text:'新的进度'}); crewDomain.wbOnRuns(crewRuns);`);
    ok(await read(`document.getElementById('wbSteerInput').value === '只给研究员的草稿'`), 'C4 输入失焦后，数据刷新仍保留草稿');
    await fx.evaluate(`document.querySelector('[data-node-id="review"]').click()`);
    ok(await read(`document.getElementById('wbSteerInput').value === ''`), 'C5 切到其他成员不会带入前一位的草稿');
    await fx.evaluate(`document.querySelector('[data-node-id="research"]').click(); document.querySelector('[data-fk="steer:send"]').click(); document.querySelector('[data-node-id="review"]').click(); document.getElementById('wbSteerInput').value='审核员草稿'; document.getElementById('wbSteerInput').dispatchEvent(new Event('input')); finishSteer(false);`);
    ok(await read(`document.getElementById('wbSteerInput').value === '审核员草稿' && crewActions.length === 1 && crewActions[0][1] === 'research'`), 'C6 迟到的发送失败不覆盖另一成员的草稿');
    await fx.evaluate(`document.querySelector('[data-node-id="research"]').click()`);
    ok(await read(`document.getElementById('wbSteerInput').value === '只给研究员的草稿'`), 'C7 回到原成员可找回发送失败的文本');
    await fx.evaluate(`document.querySelector('[data-fk="steer:send"]').click(); document.getElementById('wbSteerInput').value='稍后补充'; document.getElementById('wbSteerInput').dispatchEvent(new Event('input')); crewRuns[0].updatedAt='sending'; crewDomain.wbOnRuns(crewRuns); document.querySelector('[data-fk="steer:send"]').click()`);
    ok(await read(`crewActions.length === 2 && document.querySelector('[data-fk="steer:send"]').disabled`), 'C7b 请求未返回时，刷新后仍防止重复提交');
    await fx.evaluate(`finishSteer(false)`);
    ok(await read(`document.getElementById('wbSteerInput').value === '只给研究员的草稿 稍后补充' && !document.querySelector('[data-fk="steer:send"]').disabled`), 'C7c 失败文本和等待期间的新草稿都保留，可重试');
    await fx.evaluate(`document.querySelector('#wbSide .wb-side-close').click(); document.querySelector('#wbRunbar [aria-selected="true"]').focus()`);
    await fx.key('ArrowRight', { keyCode:39 });
    ok(await read(`wbState.selectedRunId === 'run-older' && document.activeElement.dataset.fk === 'run:run-older'`), 'C8 运行页签支持方向键且焦点随选择移动');
    await fx.key('Home', { keyCode:36 });
    await fx.evaluate(`crewRuns[0].updatedAt='refresh'; crewDomain.wbOnRuns(crewRuns)`);
    ok(await read(`document.activeElement.dataset.fk === 'run:run-research-20261015'`), 'C9 刷新保留运行页签的键盘焦点');

    // Deliberately constrain only the work area while keeping a wide viewport.
    await fx.evaluate(`document.getElementById('workbenchView').style.width='650px'`);
    ok(await read(`getComputedStyle(document.getElementById('wbSide')).visibility === 'hidden'`), 'C10 宽窗口中的窄工作区也收起详情，隐藏区不进键盘焦点序列');
    await fx.evaluate(`document.querySelector('[data-fk="overview:details"]').focus(); document.querySelector('[data-fk="overview:details"]').click()`);
    ok(await read(`getComputedStyle(document.getElementById('wbSide')).visibility === 'visible' && !document.getElementById('wbSideBackdrop').hidden`), 'C11 抽屉和遮罩一起打开');
    ok(await read(`(() => { const r=document.getElementById('wbSide').getBoundingClientRect(),v=document.getElementById('workbenchView').getBoundingClientRect();return r.width>300 && r.left>=v.left && r.right<=v.right+1;})()`), 'C11b 成员抽屉完整位于班组区，未落到网格外');
    await fx.escape();
    ok(await read(`getComputedStyle(document.getElementById('wbSide')).visibility === 'hidden' && document.activeElement.dataset.fk === 'overview:details'`), 'C12 Escape 关闭抽屉并将焦点还给入口');
    await fx.evaluate(`document.getElementById('workbenchView').style.width=''; crewRuns[0].nodes = Array.from({length:12},(_,i)=>({id:'wide-'+i,roleLabel:'成员 '+i,status:'queued',dependsOn:[]})); crewDomain.wbOnRuns(crewRuns); document.querySelector('[data-fk="zoom:fit"]').click()`);
    ok(await read(`document.getElementById('wbCanvasWrap').scrollWidth <= document.getElementById('wbCanvasWrap').clientWidth + 2 && wbState.zoom < .75`), 'C13 大班组适应视图真正容下全部横向节点');

    const shots = process.env.RUYI_SHOT_DIR;
    await fx.evaluate(`document.getElementById('toastTray').replaceChildren()`);
    for (const width of [1440, 390]) {
      await fx.resize(width, 960);
      await fx.evaluate(`crewRuns[0].nodes = [
        {id:'plan',roleLabel:'任务规划',status:'succeeded',dependsOn:[]},
        {id:'research',roleLabel:'资料研究',status:'running',model:'research-model',dependsOn:['plan'],progressLog:[{text:'正在核对第三份资料'}]},
        {id:'review',roleLabel:'结果审核',status:'failed',error:'需要补充来源',dependsOn:['research']}
      ]; crewDomain.wbOnRuns(crewRuns); document.querySelector('[data-fk="zoom:fit"]').click()`);
      ok(await read(`['wbOverview','wbUsage','wbCanvasWrap'].every(id => { const n=document.getElementById(id); return n.scrollWidth <= n.clientWidth + 2; })`), 'C14@'+width+' 摘要、用量与适应后的画布无横向溢出');
      if (shots) { fs.mkdirSync(shots,{recursive:true}); fs.writeFileSync(path.join(shots,`crew-${width}-light.png`),await fx.screenshot()); }
    }
    await fx.resize(1440,960);
    await fx.evaluate(`document.documentElement.dataset.theme='dark'; document.querySelector('[data-fk="zoom:fit"]').click()`);
    await sleep(400);
    if (shots) fs.writeFileSync(path.join(shots,'crew-1440-dark.png'),await fx.screenshot());
    await fx.resize(1920,960);
    await fx.evaluate(`document.querySelector('[data-node-id="research"]').click()`);
    ok(await read(`getComputedStyle(document.getElementById('wbSide')).position !== 'absolute' && getComputedStyle(document.getElementById('wbSide')).visibility === 'visible'`), 'C16 充足宽度时详情常驻，与窄工作区的抽屉共用同一份内容');
    await fx.evaluate(`(async () => { await (await import('/js/i18n.js')).setLocale('en-US'); crewRuns[0].updatedAt='english'; crewDomain.wbOnRuns(crewRuns); })()`);
    await fx.resize(390,960);
    await fx.evaluate(`document.querySelector('.wb-side-close').click(); document.querySelector('[data-fk="zoom:fit"]').click()`);
    ok(await read(`document.getElementById('wbOverview').textContent.includes('members completed') && ['wbOverview','wbUsage'].every(id => { const n=document.getElementById(id); return n.scrollWidth <= n.clientWidth + 2; })`), 'C17 英文窄屏摘要与用量不溢出');
    await fx.resize(1440,960);
    await fx.evaluate(`document.getElementById('closeToolPaneBtn').focus(); document.getElementById('closeToolPaneBtn').click()`);
    ok(await read(`getComputedStyle(document.getElementById('toolPane')).display === 'none' && document.activeElement.id === 'toggleToolsBtn'`), 'T1 桌面工具箱可直接关闭，焦点回到工具箱入口');
    await fx.evaluate(`document.getElementById('toggleToolsBtn').click(); document.querySelector('#toolPane [data-tab="files"]').click(); const list=document.getElementById('fileTree'); list.replaceChildren(); for(let i=0;i<80;i++){ const row=document.createElement('div');row.textContent='Report '+i+'.md';row.style.padding='12px';list.appendChild(row); } document.getElementById('toolPane').scrollTop=650;`);
    ok(await read(`(() => { const p=document.getElementById('toolPane').getBoundingClientRect(), t=document.querySelector('#toolPane > .tool-tabs').getBoundingClientRect(); return t.top >= p.top && t.bottom < p.bottom; })()`), 'T2 长文件列表滚动时，工具分类仍可见');
    await fx.evaluate(`document.querySelector('#toolPane [data-tab="artifacts"]').click()`);
    ok(await read(`document.getElementById('toolPane').scrollTop === 0 && document.getElementById('tab-artifacts').classList.contains('active')`), 'T3 切换工具分类从顶部开始，不继承上个列表的滚动位置');
    await fx.resize(390,960);
    await fx.evaluate(`document.getElementById('toggleToolsBtn').click()`);
    await sleep(400);
    ok(await read(`(() => { const p=document.getElementById('toolPane'),r=p.getBoundingClientRect();return getComputedStyle(p).visibility === 'visible' && p.scrollWidth <= p.clientWidth+2 && r.left >= 0 && r.right <= innerWidth+1; })()`), 'T4 英文窄屏工具箱完整位于视口内且无横向溢出');
    ok(await read(`[...document.querySelectorAll('#toolPane .tool-tabs button, #closeToolPaneBtn')].filter(n=>n.getClientRects().length).every(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})`), 'T4b 分类与关闭按钮位于遮罩上方，真实点击可达');
    ok(await read(`document.getElementById('toolPane').getBoundingClientRect().left >= document.querySelector('.app-shell').getBoundingClientRect().left`), 'T4c 工具箱左缘不被任务栏和父容器裁掉');
    if (shots) fs.writeFileSync(path.join(shots,'toolbox-390-dark.png'),await fx.screenshot());
    await fx.evaluate(`document.getElementById('closeToolPaneBtn').click()`);
    ok(await read(`!document.querySelector('.app-shell').classList.contains('tools-open')`), 'T5 窄屏工具箱保留原有抽屉关闭方式');
    await fx.evaluate(`document.getElementById('appSideToggleBtn').click(); document.getElementById('closeToolPaneBtn').click()`);
    ok(await read(`!document.getElementById('appFrame').classList.contains('side-open') && document.getElementById('appSideToggleBtn').getAttribute('aria-expanded') === 'false'`), 'T6 从全局右栏入口打开时，面板关闭按钮也能收起');
    await fx.resize(1440,960);
    await fx.evaluate(`window.savedCrewSession = state.currentSession; state.currentSession = null; window.manyCrewRuns = Array.from({length:30},(_,i)=>({...crewRuns[0],id:'history-'+i,title:'资料整理',createdAt:new Date(Date.UTC(2026,9,15-i)).toISOString()})); crewDomain.wbOnRuns(manyCrewRuns); const s=document.querySelector('.wb-run-select'); s.value='history-29'; s.dispatchEvent(new Event('change'));`);
    ok(await read(`wbState.selectedRunId === 'history-29' && document.querySelector('.wb-run-select').options.length === 30 && document.querySelector('.wb-run-select').selectedOptions[0].textContent.includes('2026')`), 'H1 30 次同名运行可通过日期选择最早记录');
    await fx.evaluate(`manyCrewRuns.unshift({...crewRuns[0],id:'history-new'}); crewDomain.wbOnRuns(manyCrewRuns)`);
    ok(await read(`wbState.selectedRunId === 'history-29' && document.querySelector('.wb-run-select').value === 'history-29'`), 'H2 新运行到达和刷新不抢走正在查看的旧记录');
    await fx.resize(390,960);
    ok(await read(`document.getElementById('wbRunbar').scrollWidth <= document.getElementById('wbRunbar').clientWidth+2`), 'H3 窄屏大量历史入口不横向溢出');
    await fx.evaluate(`document.querySelector('.wb-node').click()`);
    await sleep(250);
    ok(await read(`(() => {const n=document.querySelector('.wb-side-close'),r=n.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) && document.getElementById('wbSide').scrollTop===0;})()`), 'H3b 窄屏选中成员后，详情从顶部开始且关闭按钮可真实点击');
    await fx.evaluate(`state.currentSession = {id:'native-history-test', messages:Array.from({length:12},(_,i)=>({role:'assistant',turnSeq:i+1,content:'第 '+(i+1)+' 轮完成',nativeAgents:[{toolUseId:'child-'+i,roleLabel:'资料研究',ok:true,result:'核对完毕',startedAt:'2026-10-15T01:00:00Z'}]}))}; crewDomain.wbOnRuns([]);`);
    ok(await read(`wbState.lastRuns.length === 12 && document.querySelector('.wb-run-select').options.length === 12 && wbState.lastRuns.some(r=>r.turnSeq===1)`), 'H4 Claude 原生班组恢复 12 轮历史，最早一轮不被 8 次上限截断');
    await fx.evaluate(`state.currentSession = savedCrewSession; crewDomain.wbOnRuns(crewRuns)`);
    // Real toolbox renderer: pending actions stay visible while verbose member/history content folds.
    await fx.resize(1440,960);
    await fx.evaluate(`(async () => {
      await (await import('/js/i18n.js')).setLocale('zh-CN');
      document.documentElement.dataset.uiMode='pro'; document.documentElement.dataset.theme='light';
      state.currentSession={id:'toolbox-compact-test'};state.config.monitorIncremental=false;
      window.aiTestRuns=[{id:'compact-run',title:'资料核验',live:true,status:'running',totalTokens:23400,summary:'完整运行总结',nodes:[
        {id:'research',roleLabel:'资料研究',status:'running',task:'完整任务说明',progressLog:[{text:'正在核对第三份资料'}]},
        {id:'review',roleLabel:'结果审核',status:'failed',error:'缺少来源',progressLog:[]}
      ],taskPool:[{id:'pending',proposedBy:'review',task:'补充核对来源',status:'proposed',maxIters:8},{id:'decided',task:'之前已确认的任务',status:'approved'}]}];
      window.aiTestActions=[];window.aiRealFetch=window.fetch;
      window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);let payload;
        if(url.pathname==='/api/agent-runs')payload={ok:true,runs:aiTestRuns};
        else if(url.pathname==='/api/agent-runs/compact-run' && init?.method==='POST'){const action=JSON.parse(init.body);aiTestActions.push(action);if(action.action==='pool_approve')aiTestRuns[0].taskPool[0].status='approved';payload={ok:true};}
        if(payload)return Promise.resolve(new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}}));return aiRealFetch(input,init);
      };
      window.aiTestDomain=(await import('/js/agent-workflows.js')).createAgentWorkflowsDomain();
      document.getElementById('appSideToggleBtn').click();document.querySelector('#toolPane [data-tab="agent-runs"]').click();
      await aiTestDomain.loadAgentRuns(true);
    })()`);
    ok(await read(`!document.querySelector('.agent-run-details').open && !document.querySelector('.agent-node').open && !document.querySelector('.agent-node-task').checkVisibility() && document.querySelector('.ar-agg-live').textContent.includes('资料研究：正在核对第三份资料')`), 'A1 默认显示角色与当前进度，成员任务及日志折叠');
    ok(await read(`document.querySelector('.agent-run-card > .pool-section .pool-actions button').getClientRects().length > 0 && document.querySelector('.agent-run-issues').getClientRects().length > 0 && !document.querySelector('.ps-approved').checkVisibility() && !document.querySelector('.workflow-launch').open`), 'A2 待审批和异常入口直接可见，已处理任务与模板折叠');
    await fx.evaluate(`document.querySelector('.agent-run-issues').click()`);
    ok(await read(`document.querySelector('.agent-run-details').open && document.querySelector('[data-node-id="review"].agent-node').open && document.querySelector('.agent-node-error').getClientRects().length > 0 && document.activeElement.closest('.agent-node').dataset.nodeId==='review'`), 'A3 查看异常直接展开对应成员并移入焦点');
    await fx.evaluate(`(async () => {aiTestRuns[0].nodes[0].progressLog.push({text:'来源已核对，正在整理说明'}); await aiTestDomain.loadAgentRuns(true);})()`);
    ok(await read(`document.querySelector('.agent-run-details').open && document.querySelector('[data-node-id="review"].agent-node').open && document.querySelector('.ar-agg-live').textContent.includes('来源已核对')`), 'A4 进度更新保留手动展开的详情与成员');
    await fx.evaluate(`(async () => {document.querySelector('.agent-run-details').open=false;aiTestRuns[0].updatedAt='next';await aiTestDomain.loadAgentRuns(true);document.getElementById('toolPane').scrollTop=0;})()`);
    ok(await read(`!document.querySelector('.agent-run-details').open`), 'A5 手动收起详情后刷新不会重新撑开');
    await fx.resize(390,960);
    await fx.evaluate(`document.getElementById('toggleToolsBtn').click();document.getElementById('toolPane').scrollTop=0`);
    await sleep(300);
    ok(await read(`(() => {const p=document.getElementById('toolPane'),b=document.querySelector('.agent-run-card > .pool-section .pool-actions button'),r=b.getBoundingClientRect();return p.scrollWidth<=p.clientWidth+2 && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), 'A6 中文窄屏无横向溢出，默认审批按钮直接可点');
    await fx.evaluate(`document.querySelector('.agent-run-card > .pool-section .pool-actions button').click()`);
    await fx.waitForEval(`aiTestActions.length===1 && !document.querySelector('.agent-run-card > .pool-section') ? true:null`);
    ok(await read(`aiTestActions[0].action==='pool_approve' && aiTestActions[0].poolId==='pending' && !document.querySelector('.agent-run-details').open`), 'A7 审批仍提交原操作，处理后记录移入折叠详情');
    await fx.evaluate(`window.fetch=aiRealFetch;state.currentSession=savedCrewSession;document.querySelector('#toolPane [data-tab="files"]').click()`);
    ok(fx.exceptions.length === 0, 'C15 无未捕获的浏览器异常: '+fx.exceptions.join('; '));
  } catch (error) { runner.fail(error.stack || String(error)); }
  finally { if (fx) await fx.close({ keepRoot: runner.failures > 0 }); }
  runner.done({exit:true});
})();
