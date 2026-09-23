require('./lib/self-isolate-home.js');
const { startBrowserFixture } = require('./lib/browser-fixture');
let failed = 0;
const ok = (value, label) => { console.log((value ? 'PASS ' : 'FAIL ') + label); if (!value) failed++; };
(async () => {
  let fx;
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-ui-polish-', ok });
    await fx.setLens('classic');
    const result = await fx.cdp.evaluate(`(async () => {
      const { createBackgroundTray } = await import('/js/background-tray.js');
      const { createPromptQueue } = await import('/js/prompt-queue.js');
      const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; };
      const t = (key, params) => key + (params ? JSON.stringify(params) : '');
      const host = el('div', 'composer'); host.style.cssText = 'position:fixed;top:100px;left:100px;z-index:5000';
      const input = el('textarea'); host.append(input); document.body.append(host);
      const fakeDoc = { hidden:false, body:document.body, get activeElement(){return document.activeElement;}, addEventListener(){},
        querySelector: s => s === '.chat-pane .composer' ? host : s === '#promptInput' ? input : null, querySelectorAll: () => [] };
      let items = [{ id:'a',kind:'shell',shellId:'a',name:'A',startedAt:new Date().toISOString() }, { id:'b',kind:'shell',shellId:'b',name:'B',startedAt:new Date().toISOString() }];
      let offline = false, sid = 'sess_a', resolveConfirm, stoppedUrl = '';
      const tray = createBackgroundTray({ el, t, doc:()=>fakeDoc, shellMode:()=> 'classic', currentSessionId:()=>sid,
        confirmDanger:()=>new Promise(r=>{resolveConfirm=r;}), api:async(url, opts)=>{
          if (opts) { stoppedUrl=url; return {ok:true}; }
          if(offline) throw Error('offline'); return {items};
        }});
      const checks = {};
      try {
        await tray.refresh(); host.querySelector('.bg-tray-chip').click();
        host.querySelector('[data-focus-key="b:output"]').focus();
        items = [{id:'c',kind:'shell',shellId:'c',name:'C',startedAt:new Date().toISOString()}, ...items];
        await tray.refresh(); checks.trayKeepsFocus = document.activeElement.dataset.focusKey === 'b:output';
        input.focus(); items = items.slice(1); await tray.refresh(); checks.noFocusSteal = document.activeElement === input;
        offline=true; await tray.refresh(); checks.stale = host.querySelector('.bg-tray').classList.contains('is-stale') && host.querySelector('.bg-tray-time').textContent.includes('bgTray.stale');
        offline=false; await tray.refresh(); checks.recovered = !host.querySelector('.bg-tray').classList.contains('is-stale');
        host.querySelector('[data-focus-key="a:stop"]').click(); sid='sess_b'; await tray.refresh(); resolveConfirm(true);
        await new Promise(r=>setTimeout(r,0)); checks.stopOriginalThread = stoppedUrl === '/api/sessions/sess_a/background/stop';
      } finally { tray._stopForTests(); host.querySelector('.bg-tray')?.remove(); }
      let ctx;
      const queue = createPromptQueue({el,t,doc:()=>fakeDoc,shellMode:()=> 'classic',openItem:(_item,c)=>{ctx=c;return {close(){}};}});
      const offer = id => queue.offer({id,type:'question',sessionId:'sess_a',payload:{questions:[{question:id}]}});
      try {
        offer('q1'); queue.minimizeActive(); offer('q2');
        document.querySelector('.prompt-dock-pill').click();
        document.querySelector('[data-intervention-id="q2"]').focus(); offer('q3');
        checks.queueKeepsFocus = document.activeElement.dataset.interventionId === 'q2';
        queue.settle('q2'); checks.queueFallback = document.activeElement.dataset.interventionId === 'q3';
        queue.settle('q1'); queue.settle('q3'); checks.emptyQueueFocus = document.activeElement === input;
      } finally { for(const item of queue.list())queue.settle(item.id); document.querySelector('.prompt-dock')?.remove(); host.remove(); }
      const { createStewardConversation } = await import('/js/steward-conversation.js');
      let response = {ok:true,result:{ok:false,error:'invalid_request'}}, calls=0;
      const conversation = createStewardConversation({t,api:async()=>{calls++;return response;}});
      const actionRoot = el('div'); document.body.append(actionRoot);
      const action = {kind:'tool',tool:'steward_schedule_create',args:{},label:'排13:00提醒',primary:true};
      const wait = () => new Promise(r=>setTimeout(r,0));
      try {
        conversation.renderActs(actionRoot,[action]);
        let btn=actionRoot.querySelector('button'); btn.click(); await wait();
        checks.invalidButtonDisabled=btn.disabled && actionRoot.textContent.includes('stewardShell.chat.errInvalidAct');
        btn.click(); await wait(); checks.invalidNotRetried=calls===1;
        actionRoot.textContent=''; response={ok:true};
        conversation.renderActs(actionRoot,[action]); btn=actionRoot.querySelector('button'); btn.click(); await wait();
        checks.noFalseSuccess=btn.disabled && actionRoot.textContent.includes('stewardShell.chat.actUnconfirmed') && !actionRoot.querySelector('.steward-receipt');
        actionRoot.textContent=''; response={ok:true,result:{ok:true}};
        conversation.renderActs(actionRoot,[action]); actionRoot.querySelector('button').click(); await wait();
        checks.successReceipt=!!actionRoot.querySelector('.steward-receipt') && !actionRoot.querySelector('.steward-act');
        actionRoot.textContent=''; response={ok:true,result:{ok:false,error:'steward.busy'}};
        conversation.renderActs(actionRoot,[action]); btn=actionRoot.querySelector('button'); btn.click(); await wait();
        checks.busyCanRetry=!btn.disabled;
        response={ok:true,result:{ok:true}}; btn.click(); await wait();
        checks.retryClearsError=!!actionRoot.querySelector('.steward-receipt') && !actionRoot.querySelector('.steward-act-problem');
      } finally {actionRoot.remove();}
      return checks;
    })()`);
    for (const [name, value] of Object.entries(result)) ok(value, name);
  } catch (error) { ok(false, error.stack || error.message); }
  finally { if (fx) await fx.close(); }
  console.log('UI POLISH BROWSER E2E: ' + (failed ? 'FAIL (' + failed + ')' : 'ALL PASS'));
  process.exitCode = failed ? 1 : 0;
})();
