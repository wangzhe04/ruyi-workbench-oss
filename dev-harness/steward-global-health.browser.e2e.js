'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { startBrowserFixture, waitForHttp, WB, sleep } = require('./lib/browser-fixture');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const runner = createRunner('STEWARD GLOBAL HEALTH BROWSER');
const { ok } = runner;

// Persisted fixture facts are read by the real page through production HTTP. Interception only injects
// read failures or delays. The same page survives an actual process crash/restart on the same port.
(async () => {
  let fx, sid, runFile, headFile;
  const shots = process.env.WCW_BROWSER_SCREENSHOT_DIR;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-global-health-', width: 1440, height: 960,
      config: { theme: 'light', schedulerEnabledV1: false, stewardPollMs: 120000 },
      prepare: async started => {
        fx = started;
        const made = await fx.request('POST', '/api/sessions', { title: '全局故障读取验收', cwd: fx.work });
        sid = made?.json?.session?.id; if (!sid) throw new Error('session fixture failed');
        headFile = path.join(fx.home, 'sessions', sid + '.json');
        const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
        head.mission = { goal: 'Global read health', autoMode: 'off', milestones: [{ id: 'ms', desc: 'HEALTH_ACCEPT_A', status: 'pending', evidence: '' }], budget: {}, spent: {} };
        fs.writeFileSync(headFile, JSON.stringify(head));
        const pending = { id: 'iv_health_a', type: 'question', status: 'pending', sessionId: sid, requestedAt: new Date().toISOString(), interventionVersion: 0, questions: [{ question: 'HEALTH_PENDING_A', options: [] }] };
        fs.writeFileSync(path.join(fx.home, 'sessions', sid + '.interventions.ndjson'), JSON.stringify(pending) + '\n');
        const dir = path.join(fx.home, 'agent-runs', sid); fs.mkdirSync(dir, { recursive: true }); runFile = path.join(dir, 'run_acde.json');
        fs.writeFileSync(runFile, JSON.stringify({ id: 'run_acde', sessionId: sid, status: 'failed', title: '历史运行故障', eventSeq: 1,
          createdAt: '2026-10-16T01:00:00Z', updatedAt: '2026-10-16T01:00:00Z', persistenceDegraded: true, idleAborted: true,
          nodes: [{ id: 'worker', status: 'failed', idleAborted: true, task: 'Read known facts' }], taskPool: [] }));
        const served = await fx.request('GET', '/api/missions?limit=200');
        const row = served?.json?.missions?.find(item => item.sessionId === sid);
        ok(row?.healthRuns?.[0]?.health?.persistenceDegraded === true && row.healthRuns[0].health.idleAborted === true, 'G0 production mission card carries both bounded historical fault facts');
      } });
    const act = source => fx.evaluate(`(async()=>{${source}})()`);
    const focus = () => fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread',{detail:{sessionId:${JSON.stringify(sid)}}}));true`);
    await fx.setLens('classic');
    await fx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.classicArbiterReads=0;const bootFetch=window.fetch;window.fetch=function(input,init){if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/steward/arbiter')window.classicArbiterReads++;return bootFetch.call(this,input,init);};` });
    await fx.cdp.send('Page.reload');
    ok(Boolean(await fx.waitForEval(`document.documentElement.dataset.shellMode==='classic'&&document.getElementById('stewardBoardReadHealth')?.hidden === true`)),
      'G0b classic startup completes both shared rail reads without entering Steward');
    ok(await fx.evaluate('window.classicArbiterReads===1'), 'G0c classic initialization reads arbiter exactly once');
    await fx.evaluate(String.raw`(()=>{
      window.healthPageNonce=Math.random();window.healthInitialNonce=healthPageNonce;
      window.healthModes={};window.healthReadRequests=[];window.healthAcks=[];window.healthHeld=[];
      window.healthHoldFresh=false;window.healthDelayOld=false;window.healthOldRelease=null;
      window.healthOriginalFetch=window.fetch;
      window.fetch=async(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        let source='';
        if(url.pathname==='/api/missions')source='missions';
        else if(url.pathname==='/api/steward/arbiter')source='arbiter';
        else if(url.pathname==='/api/sessions/${sid}')source='session';
        else if(url.pathname==='/api/interventions'&&url.searchParams.get('sessionId')==='${sid}')source='pending';
        else if(url.pathname==='/api/missions/${sid}')source='snapshot';
        if(source){
          healthReadRequests.push({source,inm:new Headers(init?.headers).get('if-none-match'),at:healthAcks[healthAcks.length-1]||''});
          if(healthModes[source]==='fail')throw new TypeError('injected read failure');
          if(healthModes[source]==='malformed')return new Response(JSON.stringify({ok:true,missions:null}),{headers:{'content-type':'application/json'}});
        }
        const response=await healthOriginalFetch(input,init);
        if(url.pathname==='/api/events/stream'&&response.ok&&response.body){
          let text='';const transform=new TransformStream({transform(chunk,controller){
            text+=new TextDecoder().decode(chunk);let split;
            while((split=text.indexOf('\n\n'))>=0){const block=text.slice(0,split);text=text.slice(split+2);if(block.includes('event: presence.ack')){const id=block.match(/"serverInstanceId":"([^"]+)"/);if(id)healthAcks.push(id[1]);}}
            controller.enqueue(chunk);
          }});return new Response(response.body.pipeThrough(transform),{status:response.status,headers:response.headers});
        }
        if(source==='pending'&&healthDelayOld){healthDelayOld=false;await new Promise(resolve=>healthOldRelease=resolve);}
        if(source&&healthHoldFresh)await new Promise(resolve=>healthHeld.push(resolve));
        return response;
      };
    })()`);
    await fx.setLens('steward'); await focus();
    ok(Boolean(await fx.waitForEval(`document.querySelector('#railList [data-session-id="${sid}"] .steward-health-badge')&&document.querySelectorAll('#stewardDrawerReadHealth [data-health-kind]').length===2`)), 'G1 real board and drawer both render the same two run faults');
    ok(Boolean(await fx.waitForEval(`document.getElementById('stewardDrawerAsk').textContent.includes('HEALTH_PENDING_A')&&!document.getElementById('stewardDrawerAsk').hidden`)), 'G2 real pending decision is visible before failures');
    ok(Boolean(await fx.waitForEval(`document.getElementById('stewardDrawerAcceptanceList').textContent.includes('HEALTH_ACCEPT_A')`)), 'G3 actual acceptance snapshot is visible');
    ok(Boolean(await fx.waitForEval(`healthAcks.length>0`)), 'G4 observe the original process epoch through the actual SSE connection');
    await fx.evaluate(`(()=>{const input=document.getElementById('stewardDrawerAskInput');input.value='UNSENT_ANSWER';input.focus();input.setSelectionRange(2,7);window.healthDraftInput=input;})()`);
    await act(`window.healthOriginalEpoch=healthAcks[healthAcks.length-1];window.healthOriginalToken=(await import('/js/net.js')).wcwToken();healthModes={missions:'fail',arbiter:'fail',session:'fail',pending:'fail',snapshot:'fail'}`);
    await focus();
    ok(Boolean(await fx.waitForEval(`document.querySelector('#stewardBoardReadHealth .workflow-read-health')&&document.querySelector('#stewardDrawerReadHealth .workflow-read-health')`)), 'G5 top-level and per-resource read failures are visible');
    ok(await fx.evaluate(`document.getElementById('stewardDrawerAsk').textContent.includes('HEALTH_PENDING_A')&&!document.getElementById('stewardDrawerAsk').hidden&&document.getElementById('stewardDrawerAcceptanceList').textContent.includes('HEALTH_ACCEPT_A')`), 'G6 failed pending/snapshot reads preserve known decisions and acceptance');
    ok(await fx.evaluate(`healthDraftInput===document.activeElement&&healthDraftInput.value==='UNSENT_ANSWER'&&healthDraftInput.selectionStart===2&&healthDraftInput.selectionEnd===7`), 'G6b failed-read redraw preserves the answer draft, focus and text selection');
    await fx.evaluate(`healthModes.missions='malformed'`); await focus();
    ok(await fx.evaluate(`Boolean(document.querySelector('#railList [data-session-id="${sid}"]'))&&!document.querySelector('#railList .steward-board-empty')`), 'G7 malformed HTTP 200 is not authoritative empty data');
    if (shots) fs.mkdirSync(shots, { recursive: true });
    for (const [width, locale, theme] of [[1440,'zh-CN','light'],[768,'en-US','dark'],[390,'en-US','dark']]) {
      await fx.resize(width,960); await act(`await (await import('/js/i18n.js')).setLocale('${locale}');document.documentElement.dataset.theme='${theme}'`); await sleep(400);
      await focus();
      ok(await fx.evaluate(`(()=>{const n=document.getElementById('stewardDrawerReadHealth');const r=n.getBoundingClientRect();return !n.hidden&&n.getClientRects().length>0&&r.width>0&&n.scrollWidth<=n.clientWidth+2&&r.left>=0&&r.right<=innerWidth+1;})()`), 'G8@'+width+' visible warnings stay within the viewport');
      if (shots) fs.writeFileSync(path.join(shots,`steward-global-health-${width}-${theme}-${locale}.png`),await fx.screenshot());
    }
    await fx.resize(1440,960); await fx.evaluate(`(()=>{const input=document.getElementById('stewardDrawerAskInput');input.focus();input.setSelectionRange(2,7);healthModes={};})()`); await focus();
    ok(Boolean(await fx.waitForEval(`!document.querySelector('#stewardDrawerReadHealth .workflow-read-health')`)), 'G9 valid successful reads clear read quality and retain real fault facts');
    ok(await fx.evaluate(`healthDraftInput.value==='UNSENT_ANSWER'&&document.activeElement===healthDraftInput&&healthDraftInput.selectionStart===2&&healthDraftInput.selectionEnd===7`), 'G9b successful reads preserve the unsent draft and its selection');
    await fx.evaluate(`healthDelayOld=true`); await focus();
    ok(Boolean(await fx.waitForEval(`typeof healthOldRelease==='function'`)), 'G10 hold an actual old-process pending response before crash');
    await fx.evaluate(`healthHoldFresh=true`);
    const oldServer = fx.server;
    await new Promise(resolve => { oldServer.once('exit', resolve); killOwnTree(oldServer); });
    const run = JSON.parse(fs.readFileSync(runFile,'utf8'));run.persistenceDegraded=false;run.idleAborted=false;run.nodes[0].idleAborted=false;fs.writeFileSync(runFile,JSON.stringify(run));
    const head = JSON.parse(fs.readFileSync(headFile,'utf8'));head.mission.milestones[0].desc='HEALTH_ACCEPT_B';fs.writeFileSync(headFile,JSON.stringify(head));
    fx.server = cp.spawn(process.execPath,['app/server.js','serve','--port',String(fx.appPort)],{
      cwd:WB,env:{...process.env,...fixtureChildEnv(),RUYI_HOME:fx.home,WIN_CLAUDE_WORKBENCH_HOME:fx.home,HOME:fx.home,USERPROFILE:fx.home},windowsHide:true,stdio:'ignore',
    });
    ok(Boolean(await waitForHttp(fx.appPort,'GET','/health',result=>result.status===200)), 'G11 process B starts on the exact same port and data root');
    ok(Boolean(await fx.waitForEval(`healthAcks.some(id=>id!==healthOriginalEpoch)`)), 'G12 unchanged page reconnects and sees the new server epoch');
    ok(await fx.evaluate(`(async()=>healthPageNonce===healthInitialNonce&&(await import('/js/net.js')).wcwToken()!==healthOriginalToken)()`), 'G13 no reload: expired token refreshes automatically');
    ok(await fx.evaluate(`document.getElementById('stewardBoardReadHealth').textContent.includes('restarted')||document.getElementById('stewardDrawerReadHealth').textContent.includes('restarted')`), 'G14 new process is explicitly marked unverified while authoritative reads are held');
    ok(await fx.evaluate(`healthDraftInput.value==='UNSENT_ANSWER'&&document.activeElement===healthDraftInput&&healthDraftInput.selectionStart===2&&healthDraftInput.selectionEnd===7`), 'G14b epoch warning preserves the current unsent answer, focus and selection');
    ok(await fx.evaluate(`healthReadRequests.some(row=>row.at!==healthOriginalEpoch&&row.at&&row.source==='missions'&&!row.inm)`), 'G15 new epoch forces an unconditional mission snapshot');
    await fx.evaluate(`healthHoldFresh=false;healthHeld.splice(0).forEach(resolve=>resolve())`);
    ok(Boolean(await fx.waitForEval(`document.getElementById('stewardDrawerAcceptanceList').textContent.includes('HEALTH_ACCEPT_B')&&!document.querySelector('#stewardDrawerReadHealth .workflow-read-health')`)), 'G16 authoritative B snapshot replaces A acceptance and clears quality');
    ok(await fx.evaluate(`!document.querySelector('#railList [data-session-id="${sid}"] .steward-health-badge')&&!document.querySelector('#stewardDrawerReadHealth [data-health-kind]')&&document.getElementById('stewardDrawerAsk').hidden`), 'G17 new server clears recovered faults and restart-cancelled pending decisions');
    await fx.evaluate(`healthOldRelease()`); await sleep(300);
    ok(await fx.evaluate(`document.getElementById('stewardDrawerAsk').hidden&&document.getElementById('stewardDrawerAcceptanceList').textContent.includes('HEALTH_ACCEPT_B')&&!document.querySelector('#stewardDrawerReadHealth .workflow-read-health')`), 'G18 late old-process response cannot resurrect a pending decision or overwrite current quality');
    ok(await fx.evaluate(`healthReadRequests.some(row=>row.at!==healthOriginalEpoch&&row.at&&row.source==='arbiter')&&healthReadRequests.some(row=>row.at!==healthOriginalEpoch&&row.at&&row.source==='snapshot')`), 'G19 reconnect refresh covers arbiter and drawer authority, not just rows');
    ok(fx.exceptions.length===0,'G20 no uncaught browser exceptions: '+fx.exceptions.join('; '));
    await fx.setLens('classic');
    ok(await act(`return (await (await import('/js/net.js')).api('/api/config',{method:'POST',body:JSON.stringify({stewardEnabledV1:false})})).ok===true`), 'G21 explicitly disable Steward through production configuration');
    await fx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.disabledArbiterRequests=0;const originalFetch=window.fetch;window.fetch=function(input,init){if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/steward/arbiter')window.disabledArbiterRequests++;return originalFetch.call(this,input,init);};` });
    await fx.cdp.send('Page.reload');
    ok(Boolean(await fx.waitForEval(`window.state?.config?.stewardEnabledV1===false&&document.getElementById('stewardBoardReadHealth')?.hidden===true`)), 'G22 disabled classic startup has no inapplicable arbiter loading/failure notice');
    ok(await fx.evaluate(`window.disabledArbiterRequests===0`), 'G23 disabled classic startup does not request the disabled arbiter endpoint');
  } catch(error) { runner.fail(error.stack||String(error)); }
  finally { if(fx) await fx.close(); runner.done({exit:true}); }
})();
