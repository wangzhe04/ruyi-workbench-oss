'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const t = createRunner('MACOS CAPABILITY POPOVER');
(async () => {
  let fx;
  try {
    if (process.platform !== 'darwin') { console.log('SKIP real Mac capability popover requires macOS'); return; }
    fx = await startBrowserFixture({ ok: t.ok, prefix: 'ruyi-capability-popover-', config: { uiMode: 'pro' } });
    await fx.evaluate(`(async()=>{
      const module=await import('/js/navigation-controls.js');
      window.capDomain=module.createNavigationControlsDomain({});
      window.capBaseline=await window.capDomain.fetchCapabilities(true);
      window.capDomain.openCapPopover(document.querySelector('#appGearBtn'));
      return true;
    })()`);
    const ready = await fx.waitForEval(`document.querySelectorAll('.cap-pop [data-capability] .cap-v.ok').length===3`);
    t.ok(ready, 'real helper API renders three ready execution capabilities in the opened popover');
    await fx.waitForEval(`!document.documentElement.dataset.vt && document.querySelector('.popover').getAnimations({subtree:true}).every(animation=>animation.playState==='finished')`);
    const capture = async name => {
      if (!process.env.RUYI_E2E_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.RUYI_E2E_SCREENSHOT_DIR, { recursive: true });
      const shot = await fx.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.RUYI_E2E_SCREENSHOT_DIR, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    t.ok(await fx.evaluate(`(()=>{const b=document.querySelector('#stewardNewConversation').getBoundingClientRect();return document.querySelector('.popover').contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))})()`), 'capability popover intercepts input above underlying conversation controls');
    await capture('ready');
    await fx.evaluate(`(()=>{
      window.capOriginalFetch=window.fetch;
      window.capRequests=[];
      window.fetch=(input,...args)=>String(input).includes('/api/capabilities')
        ?new Promise((resolve,reject)=>window.capRequests.push({resolve,reject})):window.capOriginalFetch(input,...args);
      window.resolveCap=(index,ready)=>{
        const payload=structuredClone(window.capBaseline);
        for(const capability of Object.values(payload.runtime.capabilities))capability.ready=ready;
        window.capRequests[index].resolve(new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}}));
      };
      window.capDomain.fetchCapabilities(true);
      return true;
    })()`);
    t.ok(await fx.waitForEval(`document.querySelectorAll('.cap-pop [data-capability] .cap-v').length===3 && [...document.querySelectorAll('.cap-pop [data-capability] .cap-v')].every(node=>node.textContent==='检查中')`),
      'in-flight refresh displays checking instead of stale ready status');
    await fx.evaluate('window.resolveCap(0,false);true');
    t.ok(await fx.waitForEval(`document.querySelectorAll('.cap-pop [data-capability] .cap-v.bad').length===3`),
      'unavailable response updates the already-open popover');
    await capture('unavailable');
    await fx.evaluate('window.capDomain.fetchCapabilities(true);window.capDomain.fetchCapabilities(true);true');
    await fx.waitForEval('window.capRequests.length===3');
    await fx.evaluate('window.resolveCap(2,false);true');
    await fx.waitForEval(`document.querySelectorAll('.cap-pop [data-capability] .cap-v.bad').length===3`);
    await fx.evaluate('window.resolveCap(1,true);true'); await sleep(100);
    t.ok(await fx.evaluate(`document.querySelectorAll('.cap-pop [data-capability] .cap-v.bad').length===3`),
      'late older response cannot overwrite the latest unavailable state');
    await fx.evaluate('window.capDomain.fetchCapabilities(true);true');
    await fx.waitForEval('window.capRequests.length===4');
    await fx.evaluate('window.capRequests[3].reject(new Error("synthetic probe failure"));true');
    t.ok(await fx.waitForEval(`[...document.querySelectorAll('.cap-pop [data-capability] .cap-v')].every(node=>node.textContent==='未知')`),
      'failed refresh shows unknown rather than preserving a readiness claim');
    const bounds = await fx.evaluate(`(()=>{const r=document.querySelector('.popover').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()`);
    t.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, 'refreshed popover is repositioned inside the viewport');
    await fx.evaluate(`(async()=>{(await import('/js/popover.js')).closePopover();window.fetch=window.capOriginalFetch;return true})()`);
    t.ok(await fx.evaluate(`!document.querySelector('.cap-pop')`), 'closing popover removes the active capability view');
    t.ok(fx.exceptions.length === 0, 'capability updates produce no uncaught browser exceptions');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (fx) await fx.close({ keepRoot: t.failures > 0 }); }
  t.done();
})();
