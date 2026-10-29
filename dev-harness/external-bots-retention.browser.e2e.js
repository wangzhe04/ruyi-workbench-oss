'use strict';
require('./lib/self-isolate-home');
// PREPARED FOR INDEPENDENT EXECUTION: actual product DOM/HTTP/disk with synthetic aged terminal data.
// The author has not run this browser/product-server case. No platform or model work is requested.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{startBrowserFixture}=require('./lib/browser-fixture'),{FAKE_BOT_ENV}=require('./lib/external-bot-fixtures'),{retentionSeed}=require('./lib/external-bots-retention-seed');
const {createRetentionEvidence}=require('./lib/external-bots-retention-evidence');
const runner=createRunner('EXTERNAL BOTS RETENTION BROWSER'),{ok}=runner,check=(value,label)=>{ok(Boolean(value),label);assert.ok(value,label);};
function transportObserver(capture=false){const real=window.fetch.bind(window);window.__retentionUi={calls:[],lose:false};window.fetch=async(input,init)=>{const url=typeof input==='string'?input:String(input.url||input),method=String(init?.method||'GET').toUpperCase();window.__retentionUi.calls.push({url,method,body:init?.body||''});if(capture&&url.includes('/api/external-bots/retention/'))console.log('RUYI_RETENTION_EVIDENCE',JSON.stringify({phase:'request',url,method,body:init?.body||''}));const response=await real(input,init);if(capture&&url.includes('/api/external-bots/retention/'))console.log('RUYI_RETENTION_EVIDENCE',JSON.stringify({phase:'response',url,method,body:init?.body||'',status:response.status,bytes:Array.from(new Uint8Array(await response.clone().arrayBuffer()))}));if(method==='POST'&&url.endsWith('/api/external-bots/retention/commit')&&window.__retentionUi.lose){window.__retentionUi.lose=false;window.__retentionUi.actualCommit={status:response.status,body:await response.clone().json()};throw Error('synthetic response lost after actual commit');}return response;};}
(async()=>{const evidence=createRetentionEvidence('browser');let fx,providerCalls=0,originalFailure;try{
  fx=await startBrowserFixture({ok,prefix:'ruyi-retention-browser-',width:1440,height:1000,serverEnv:{...FAKE_BOT_ENV},config:{schedulerEnabledV1:false},evidenceObserver:evidence?.observer,provider:ctx=>{providerCalls++;ctx.text('UNEXPECTED_MODEL_CALL');ctx.stop();},prepare:async f=>{const dir=path.join(f.home,'external-bots');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state-v1.json'),JSON.stringify(retentionSeed(),null,2));evidence?.event('seed-order',{phase:'after-server-ready-before-browser',serverPid:f.server.pid});evidence?.captureFile('seed-before-browser.bin',path.join(dir,'state-v1.json'));evidence?.captureFile('config-before-browser.bin',path.join(f.home,'config.json'));}});
  evidence?.observeCdp(fx.cdp);
  const ev=expr=>fx.evaluate(expr),wait=async(expr,label)=>check(await fx.waitForEval(expr,200),label),click=selector=>ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;n.click();return true;})()`),file=path.join(fx.home,'external-bots/state-v1.json');
  const posts=()=>ev("window.__retentionUi.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/api/external-bots/retention/commit')).map(c=>JSON.parse(c.body))");
  async function clickVisible(selector) {
  function pointerProbe(selector) {
    const n = document.querySelector(selector);
    if (!n || n.disabled) return {location:null,found:Boolean(n),disabled:Boolean(n?.disabled)};
    n.scrollIntoView({block:'center',inline:'nearest'});
    const r = n.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
    const at = document.elementFromPoint(x,y), s = getComputedStyle(n);
    const describe = v => v ? {tag:v.tagName,id:v.id,className:typeof v.className === 'string' ? v.className : null} : null;
    const chain = []; for(let v=at;v&&chain.length<8;v=v.parentElement)chain.push(describe(v));
    const visible = r.width > 0 && r.height > 0 && s.visibility === 'visible'
      && s.display !== 'none' && at && (at === n || n.contains(at));
    return {location:visible ? {x,y} : null,found:true,disabled:false,target:describe(n),
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},point:{x,y},hit:describe(at),hitAncestors:chain,
      style:{visibility:s.visibility,display:s.display,opacity:s.opacity,pointerEvents:s.pointerEvents},
      viewport:{width:innerWidth,height:innerHeight},viewTransition:document.documentElement.dataset.vt || null,
      shellMode:document.documentElement.getAttribute('data-shell-mode'),
      openDialogs:[...document.querySelectorAll('dialog[open],[aria-modal="true"]')].filter(v=>{const b=v.getBoundingClientRect();return b.width&&b.height&&getComputedStyle(v).visibility!=='hidden';}).map(describe)};
  }
  const probe = await fx.evaluate('('+pointerProbe.toString()+')('+JSON.stringify(selector)+')');
  evidence?.event('pointer-probe', {selector,probe});
  if (!probe?.location) {
    try { evidence?.captureBytes('unavailable-target.png', await fx.screenshot()); }
    catch (error) { evidence?.event('failure-screenshot-unavailable',{code:typeof error?.code==='string'?error.code:null}); }
  }
  assert.ok(probe?.location, 'Visible, unobscured user target: ' + selector);
  const location = probe.location;
  evidence?.event('pointer-target', { selector, ...location });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await fx.cdp.send('Input.dispatchMouseEvent', { type, ...location, button:'left', clickCount:1 });
  }
}

  const observerProgram='('+transportObserver.toString()+')('+(evidence?'true':'')+');true';evidence?.captureBytes('cdp-transport-program.bin',Buffer.from(observerProgram,'utf8'));await ev(observerProgram);
  await wait("!document.documentElement.dataset.vt", 'N0 initial shell transition finished');
  const naturalBefore=fs.readFileSync(file);
  check(await ev("localStorage.getItem('wcw.settingsNavGroups') === null"),'N1 fresh navigation state');
  await clickVisible('#appGearBtn');await wait("!document.getElementById('appGearMenu').hidden",'N2 gear menu opens');
  await clickVisible('#openSettingsBtn');await wait("!document.getElementById('settingsModal').classList.contains('hidden')",'N3 settings opens');
  const group='#settingsTabs .settings-nav-group[data-group="steward"]';
  check(await ev(`!document.querySelector(${JSON.stringify(group)}).classList.contains('is-open')`),'N4 steward group initially collapsed');
  await clickVisible(group+' > .settings-nav-label');await wait(`document.querySelector(${JSON.stringify(group+' > .settings-nav-label')}).getAttribute('aria-expanded') === 'true'`,'N5 steward group expands');
  await clickVisible('#settingsTabs [data-stab="steward"]');await wait("document.querySelector('#settingsTabs [data-stab=\"steward\"]').classList.contains('active')",'N6 steward tab selected');
  await clickVisible('#cfgStewardBotDeliverySection > summary');await wait("document.getElementById('cfgStewardBotDeliverySection').open && document.getElementById('cfgStewardBotDeliveryStatus').dataset.state === 'ok'",'N7 delivery section opens');
  if(evidence)evidence.captureBytes('natural-entry.png',await fx.screenshot());
  await clickVisible('#cfgStewardBotRetentionPreview');await wait("!document.getElementById('cfgStewardBotRetentionCommit').hidden && !document.getElementById('cfgStewardBotRetentionCommit').disabled",'N8 preview reachable');
  check(fs.readFileSync(file).equals(naturalBefore)&&(await posts()).length===0,'N9 natural preview does not mutate ledger or commit');
  check(providerCalls===0&&fx.exceptions.length===0&&fx.consoleErrors.length===0,'N10 natural journey has no model or browser errors');
  if(evidence){evidence.captureBytes('natural-preview.png',await fx.screenshot());evidence.captureFile('ledger-after-preview.bin',file);}
  await fx.escape();await wait("document.getElementById('settingsModal').classList.contains('hidden')",'N11 natural settings closes');await fx.setLens('steward');
  const open=async()=>{if(await ev("document.getElementById('settingsModal').classList.contains('hidden')"))await click('#openSettingsBtn');await ev("(()=>{document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(n=>n.classList.add('is-open'));document.querySelector('#settingsTabs [data-stab=\"steward\"]').click();document.getElementById('cfgStewardBotDeliverySection').open=true;return true;})()");await wait("document.getElementById('cfgStewardBotDeliveryStatus').dataset.state==='ok'",'RB1 authoritative delivery panel ready');};
  await open();check(await ev("document.getElementById('cfgStewardBotRetentionDays').value==='30'&&document.getElementById('cfgStewardBotRetentionCommit').hidden"),'RB2 default thirty-day manual policy has no implicit commit');
  const before=fs.readFileSync(file,'utf8');evidence?.captureFile('ledger-before.bin',file);await click('#cfgStewardBotRetentionPreview');await wait("!document.getElementById('cfgStewardBotRetentionCommit').hidden&&!document.getElementById('cfgStewardBotRetentionCommit').disabled",'RB3 preview allows explicit confirmation');check((await posts()).length===0&&fs.readFileSync(file,'utf8')===before,'RB4 preview has no durable mutation');check(await ev("document.getElementById('cfgStewardBotRetentionNote').textContent.includes('4')&&document.getElementById('cfgStewardBotRetentionNote').textContent.includes('4096')"),'RB5 selected batch and bounded receipts visible');
  await ev("window.__retentionUi.lose=true;document.getElementById('cfgStewardBotRetentionCommit').focus();true");await fx.enter();await wait("window.__retentionUi.actualCommit?.status===200&&document.getElementById('cfgStewardBotRetentionNote').dataset.tone==='err'",'RB6 actual committed response lost to UI is unconfirmed');const original=(await posts())[0];check((await posts()).length===1,'RB7 lost ACK does not auto-POST');
  await fx.escape();await wait("document.getElementById('settingsModal').classList.contains('hidden')",'RB8 real Escape closes settings');await open();check((await posts()).length===1,'RB9 reopening does not POST');await ev("document.getElementById('cfgStewardBotRetentionCommit').focus();true");await fx.enter();await wait("document.getElementById('cfgStewardBotRetentionCommit').hidden&&document.getElementById('cfgStewardBotInboxStatus').dataset.state==='ok'",'RB10 explicit same-request confirmation refreshes both lists');const requests=await posts();check(requests.length===2&&JSON.stringify(requests[1])===JSON.stringify(original),'RB11 exact request and preview token reused after lost ACK');
  evidence?.captureFile('ledger-after.bin',file);const state=JSON.parse(fs.readFileSync(file,'utf8'));check(state.schema===5&&state.items.length===4&&state.retentionReceipts.length===4&&state.retentionRequests.length===1,'RB12 durable body removal and dedup receipts agree with UI');for(const id of ['read','sent','failed','cancelled'])check(!fs.readFileSync(file,'utf8').includes('RECLAIM_PRIVATE_BODY_'+id)&&!fs.readFileSync(file,'utf8').includes('RECLAIM_PRIVATE_REPLY_'+id),'RB13 actual old body removed '+id);
  for(const locale of ['en-US','zh-CN']){await click('#settingsTabs [data-stab="basic"]');await ev(`(()=>{const n=document.getElementById('cfgLocale');n.value=${JSON.stringify(locale)};n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await wait('document.documentElement.lang==='+JSON.stringify(locale),'RB14 locale applied '+locale);await click('#settingsTabs [data-stab="steward"]');check(await ev("(()=>{const text=document.querySelector('[data-i18n=\"externalBots.retentionPrivacy\"]').textContent;return text.includes('SSD')&&(document.documentElement.lang==='zh-CN'?text.includes('旧版无法打开整份记录'):text.includes('older versions cannot open the entire record'))&&!text.includes('payload5')&&!text.includes('externalBots.');})()"),'RB15 localized deletion and compatibility boundaries '+locale);}
  await fx.resize(420,1000);check(await ev("(()=>{const n=document.querySelector('.external-bots-retention');return n.scrollWidth<=n.clientWidth+1;})()"),'RB16 retention controls fit narrow viewport');check(providerCalls===0,'RB17 reclaim journey never invokes model');check(fx.exceptions.length===0&&fx.consoleErrors.length===0,'RB18 no uncaught browser errors');
}catch(error){originalFailure=error;runner.fail(error.message||String(error));throw error;}finally{try{const owned=fx||evidence?.fixture;if(evidence&&owned)evidence.captureFile('ledger-final.bin',path.join(owned.home,'external-bots/state-v1.json'));if(fx)await fx.close();else if(evidence?.fixture)await evidence.fixture.close();evidence?.finish(originalFailure);}catch(error){runner.fail('cleanup: '+(error.message||String(error)));throw error;}finally{runner.done();}}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
