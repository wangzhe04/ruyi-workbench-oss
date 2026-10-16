'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const runner = createRunner('RUN HEALTH BROWSER');
const { ok } = runner;

// Actual HTTP reads of isolated persisted runs through the production reader and both renderers.
// Flags are seeded historical facts: this does NOT claim to induce the backend disk-write failure chain.
// fetch interception below supplies failures/delays only; successful snapshots always come from the server.
(async () => {
  let fx, sid, runFile;
  const shots = process.env.WCW_BROWSER_SCREENSHOT_DIR;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-run-health-', width: 1440, height: 960,
      config: { theme: 'light', schedulerEnabledV1: false },
      prepare: async started => {
        fx = started;
        const created = await fx.request('POST', '/api/sessions', { title: '运行质量验收', cwd: fx.work });
        sid = created?.json?.session?.id;
        if (!sid) throw new Error('fixture session creation failed');
        const dir = path.join(fx.home, 'agent-runs', sid); fs.mkdirSync(dir, { recursive: true });
        runFile = path.join(dir, 'run_abcd.json');
        const run = { id: 'run_abcd', sessionId: sid, title: '故障读取验收', status: 'interrupted', eventSeq: 1,
          createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-15T01:00:00Z', persistenceDegraded: true, idleAborted: true,
          nodes: [{ id: 'worker', roleLabel: '核验成员', status: 'failed', idleAborted: true, task: '保留已知任务', progressLog: [{ text: '已知进度' }] }],
          taskPool: [{ id: 'pending', proposedBy: 'worker', task: '保留待确认任务', status: 'proposed' }], messages: [] };
        fs.writeFileSync(runFile, JSON.stringify(run));
        const served = await fx.request('GET', '/api/agent-runs?sessionId=' + sid);
        ok(served?.json?.runs?.[0]?.persistenceDegraded === true && served.json.runs[0].idleAborted === true, 'H0 real server reads seeded fault facts; historical run has no live key');
      } });
    await fx.setLens('classic');
    await fx.evaluate(`(async () => {
      const { api } = await import('/js/net.js');
      state.currentSession=(await api('/api/sessions/${sid}')).session;
      state.config.monitorIncremental=true;
      window.healthMode='ok';window.healthRequests=[];window.healthRealFetch=window.fetch;
      window.fetch=async(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.pathname.startsWith('/api/agent-runs')){
          healthRequests.push(url.pathname+url.search);
          if(healthMode==='list-fail'&&url.pathname==='/api/agent-runs')throw new TypeError('Injected network failure');
          if(healthMode==='detail-fail'&&url.pathname==='/api/agent-runs/run_abcd')throw new TypeError('Injected detail failure');
          if(healthMode==='delay'){healthMode='ok';await new Promise(resolve=>window.healthRelease=resolve);}
        }
        return healthRealFetch(input,init);
      };
      window.healthDomain=(await import('/js/agent-workflows.js')).createAgentWorkflowsDomain();
      healthDomain.bindWorkbench();await healthDomain.loadAgentRuns(true);
      document.getElementById('mainViewTabCanvas').click();
    })()`);
    const act = source => fx.evaluate(`(async()=>{${source}})()`);
    const both = expression => fx.evaluate(`['#agentRunsList','#wbOverview'].every(sel=>{const root=document.querySelector(sel);return ${expression};})`);
    ok(await both(`root.querySelectorAll('[data-health-kind]').length===2`), 'H1 toolbox and crew show persistence and idle faults together from the same HTTP snapshot');
    ok(await fx.evaluate(`document.querySelector('#wbOverview [data-health-node="worker"]').dataset.fk==='health:idle:worker'`), 'H2 crew fault action has stable keyboard identity');
    await act(`document.querySelector('#wbOverview [data-health-node="worker"]').focus();healthMode='list-fail';await healthDomain.loadAgentRuns(true)`);
    ok(await both(`root.querySelector('.workflow-read-health') && root.querySelectorAll('[data-health-kind]').length===2`), 'H3 read failure coexists with both run faults; previous facts remain');
    ok(await fx.evaluate(`document.activeElement.dataset.fk==='health:idle:worker' && document.querySelector('#agentRunsList .pool-section').textContent.includes('保留待确认任务')`), 'H4 failure redraw preserves focus and pending facts');
    await fx.evaluate(`document.getElementById('mainViewTabChat').click();document.getElementById('mainViewTabCanvas').click()`);
    ok(await fx.evaluate(`Boolean(document.querySelector('#wbOverview .workflow-read-health'))`), 'H5 changing views cannot erase stale quality');
    await sleep(400);
    const geometry = await fx.evaluate(`(()=>{const p=document.getElementById('workbenchView').getBoundingClientRect();return [...document.querySelectorAll('#wbOverview .workflow-read-health,#wbOverview .workflow-run-health,#wbOverview button')].map(n=>{const r=n.getBoundingClientRect();return {name:n.className,left:r.left,right:r.right,parentRight:p.right,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});})()`);
    console.log('GEOMETRY', JSON.stringify(geometry));
    ok(geometry.every(row => row.right <= row.parentRight + 1 && row.hit), 'H5b stable desktop health banners and actions fit the crew and their centers are reachable');
    if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'run-health-1440-light-zh.png'), await fx.screenshot()); }
    await fx.evaluate(`(async()=>{await (await import('/js/i18n.js')).setLocale('en-US');})()`);
    ok(await both(`root.querySelector('[data-health-kind="persistence"]').textContent.includes('Progress cannot be saved') && root.querySelector('.workflow-read-health').textContent.includes('Unable to refresh')`), 'H6 language change updates fault and read warnings without changing run data');
    await fx.resize(768, 960);
    await fx.evaluate(`document.documentElement.dataset.theme='dark'`);
    ok(await fx.evaluate(`document.getElementById('wbOverview').scrollWidth<=document.getElementById('wbOverview').clientWidth+2`), 'H7 tablet dark English overview has no horizontal overflow');
    if (shots) fs.writeFileSync(path.join(shots, 'run-health-768-dark-en.png'), await fx.screenshot());
    await fx.resize(390, 960);
    ok(await fx.evaluate(`document.getElementById('wbOverview').scrollWidth<=document.getElementById('wbOverview').clientWidth+2`), 'H8 narrow English warning wraps inside overview');
    if (shots) fs.writeFileSync(path.join(shots, 'run-health-390-dark-en.png'), await fx.screenshot());
    await act(`healthMode='ok';await healthDomain.loadAgentRuns(true)`);
    ok(await both(`!root.querySelector('.workflow-read-health') && root.querySelectorAll('[data-health-kind]').length===2`), 'H9 successful HTTP refresh clears only read failure, keeps actual faults');
    // A new reader has only digest identity until its first detail read succeeds.
    await act(`healthMode='detail-fail';window.firstReader=(await import('/js/agent-workflows.js')).createAgentWorkflowsDomain();firstReader.bindWorkbench();await firstReader.loadAgentRuns();document.getElementById('mainViewTabCanvas').click()`);
    ok(await both(`root.textContent.includes('run_abcd') && root.querySelector('.workflow-read-health')`), 'H10 first detail failure retains the known run identity in both views');
    ok(await fx.evaluate(`!document.querySelector('#wbCanvasWrap .wb-empty-title') && !document.querySelector('#agentRunsList .agent-run-controls')`), 'H11 unread details never become empty-workflow guidance or fabricated controls');
    await act(`healthMode='ok';await firstReader.loadAgentRuns()`);
    ok(await both(`!root.querySelector('.workflow-read-health') && root.querySelectorAll('[data-health-kind]').length===2`), 'H12 authoritative detail recovery restores the actual run');
    // The previous selection survives a top-level read failure and a real empty list is authoritative.
    const before = await fx.evaluate(`wbState.selectedRunId`);
    await act(`healthMode='delay';window.slowRead=firstReader.loadAgentRuns(true)`);
    await act(`healthMode='list-fail';await firstReader.loadAgentRuns(true);healthRelease();await slowRead`);
    ok(await fx.evaluate(`wbState.selectedRunId===${JSON.stringify(before)} && Boolean(document.querySelector('#wbOverview .workflow-read-health'))`), 'H13 late older success cannot clear newer failure or steal selection');
    await act(`healthMode='ok';await firstReader.loadAgentRuns(true)`);
    await fx.resize(1440, 960);
    await fx.evaluate(`if(!document.getElementById('appFrame').classList.contains('side-open'))document.getElementById('appSideToggleBtn').click();document.querySelector('#toolPane [data-tab="agent-runs"]').click()`);
    await sleep(300);
    await act(`await firstReader.loadAgentRuns(true);document.querySelector('#agentRunsList .agent-run-card').open=true;document.querySelector('#agentRunsList [data-health-node="worker"]').focus()`);
    ok(await fx.evaluate(`document.activeElement.dataset.fk==='health:idle:worker'`), 'H13b toolbox health action is keyboard reachable');
    const saved = JSON.parse(fs.readFileSync(runFile, 'utf8')); saved.persistenceDegraded = false; saved.idleAborted = false; saved.nodes[0].idleAborted = false;
    fs.writeFileSync(runFile, JSON.stringify(saved));
    await act(`await firstReader.loadAgentRuns(true)`);
    ok(await both(`!root.querySelector('.workflow-run-health')`), 'H14 removal of real fault facts clears both presentations symmetrically');
    ok(await fx.evaluate(`document.activeElement.matches('.agent-run-head')`), 'H14b vanished toolbox health action falls back to the safe run summary');
    await fx.enter();
    ok(await fx.evaluate(`document.activeElement.matches('.agent-run-head')`), 'H14c Enter after fault recovery stays on a read-only summary, not pause/resume');
    fs.unlinkSync(runFile); await act(`await firstReader.loadAgentRuns(true)`);
    ok(await fx.evaluate(`Boolean(document.querySelector('#wbCanvasWrap .wb-empty-title')) && !document.querySelector('#wbOverview .workflow-read-health')`), 'H15 only a valid successful empty list shows the empty workflow state');
    ok(fx.exceptions.length === 0, 'H16 no uncaught browser exceptions');
  } catch (error) { ok(false, error.stack || String(error)); }
  finally { if (fx) await fx.close(); runner.done({ exit: true }); }
})();
