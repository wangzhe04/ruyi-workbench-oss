#!/usr/bin/env node
'use strict';
// Production Steward prepare -> dedicated local credentials -> signed pairing -> local CAS authorization.
// Windows-only: this journey deliberately exercises the real DPAPI password API; env fallback is covered by HTTP/unit tests.
// All platform transport is redirected by the fixed-host preload to this test's own fake server.
require('./lib/self-isolate-home.js');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createRunner}=require('./lib/harness');
const {startBrowserFixture,sleep}=require('./lib/browser-fixture');
const {FAKE_BOT_ENV,feishuEvent,feishuWire}=require('./lib/external-bot-fixtures');
const t=createRunner('EXTERNAL BOT SETUP BROWSER'),{ok}=t;
const zh=require('../ruyi-workbench/app/public/locales/zh-CN.json');
const shots=path.join(os.tmpdir(),'ruyi-bot-setup-shots-'+Date.now());
if(process.platform!=='win32'){console.log('SKIP EXTERNAL BOT SETUP BROWSER: real Windows DPAPI journey');process.exit(0);}
const canary='credential-only-'+crypto.randomBytes(20).toString('hex');
(async()=>{let fx,official;const modelRequests=[],consoleMessages=[],officialCalls=[];let prepares=0,queries=0;try{
 official=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;officialCalls.push({url:req.url});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.includes('tenant_access_token')?{code:0,tenant_access_token:'fixture-token',expire:7200}:{code:0,data:{message_id:'setup_reply'}}));});await new Promise(resolve=>official.listen(0,'127.0.0.1',resolve));
 const preload=path.resolve(__dirname,'lib/external-channel-delivery-preload.js');
 fx=await startBrowserFixture({ok,prefix:'ruyi-bot-setup-browser-',width:1440,height:1100,serverEnv:{RUYI_FAKE_EXTERNAL_API_PORT:String(official.address().port),NODE_OPTIONS:[process.env.NODE_OPTIONS||'', '--require='+JSON.stringify(preload)].join(' ')},provider:ctx=>{
  modelRequests.push(JSON.stringify(ctx.body));const at=ctx.messages.findLastIndex(m=>m.role==='user');const text=String(ctx.messages[at]?.content||'');const answered=ctx.messages.slice(at+1).some(m=>m.role==='tool');
  if(text.includes('SETUP_UI_APP')&&!answered){prepares++;ctx.toolCall('steward_bot_setup',{op:'prepare',platform:'feishu',appId:'cli_fixture',tenantId:'tenant_fixture',botUserId:'ou_bot',label:'SETUP_UI_APP'});return;}
  if(text.includes('REMOTE_SETUP_QUERY')&&!answered){queries++;ctx.toolCall('steward_self_status',{});return;}
  ctx.text(JSON.stringify({say:text.includes('REMOTE_SETUP_QUERY')?'REMOTE_SETUP_REPLY':'应用草稿已准备；请在本机继续配置。',why:'',acts:[],actions:[]}));ctx.stop();
 }});
 fx.cdp.on('Runtime.consoleAPICalled',event=>consoleMessages.push(JSON.stringify(event)));
 const ev=expr=>fx.evaluate(expr),click=selector=>ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;n.click();return true;})()`),wait=async expr=>{const value=await fx.waitForEval(expr,220);if(!value)throw Error('Timed out: '+expr);return value;};
 // Hold a real arrival response until a real user reply has rendered. A late arrival used to
 // clearFeed(), detaching the reply and its setup action even after the send had completed.
 await fx.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`
  localStorage.setItem('wcw.shellMode','classic');
  window.__arrivalProbeReady=true;
  const originalFetch=window.fetch.bind(window);let holdArrival=true;
  window.fetch=async(...args)=>{
   const arrivalHistory=window.__arrivalConsumed&&String(args[0])==='/api/sessions/steward';
   if(arrivalHistory)window.__arrivalHistoryRequested=true;
   const response=await originalFetch(...args);
   if(holdArrival&&String(args[0])==='/api/steward/visit'){
    holdArrival=false;window.__arrivalHeld=true;
    await new Promise(resolve=>{window.__releaseArrival=resolve;});
    const json=response.json.bind(response);
    response.json=async()=>{const value=await json();window.__arrivalConsumed=true;return value;};
   }
   if(arrivalHistory){const json=response.json.bind(response);response.json=async()=>{const value=await json();window.__arrivalHistoryConsumed=true;return value;};}
   return response;
  };`});
 await fx.cdp.send('Page.reload');await wait(`window.__arrivalProbeReady&&!!window.state?.config?.configSchema&&typeof document.querySelector('#lensSeg [data-lens]')?.onclick==='function'`);
 await fx.setLens('steward');await wait(`window.__arrivalHeld&&!document.getElementById('stewardComposerInput').disabled`);
 await ev(`(()=>{const n=document.getElementById('stewardComposerInput');n.value='SETUP_UI_APP 飞书 cli_fixture tenant_fixture ou_bot，请帮我配置机器人';n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
 ok(await wait(`Array.from(document.querySelectorAll('.steward-act')).some(n=>n.textContent==='继续配置机器人')`),'S1 production fake-provider prepare emits a real setup navigation card');
 await ev(`window.__arrivalCard=Array.from(document.querySelectorAll('.steward-act')).find(n=>n.textContent==='继续配置机器人'),window.__releaseArrival(),true`);
 await wait(`window.__arrivalConsumed`);
 await ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 if(await ev(`!!window.__arrivalHistoryRequested`))await wait(`window.__arrivalHistoryConsumed`);
 await ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 ok(await ev(`window.__arrivalCard.isConnected&&document.getElementById('stewardFeed').textContent.includes('SETUP_UI_APP')`),'S1b delayed arrival preserves the already-rendered user message and original reply card');
 const connections=await fx.request('GET','/api/external-bots/connections');const connection=connections?.json?.connections?.find(row=>row.label==='SETUP_UI_APP');if(!connection)throw Error('prepare did not create disabled connection');
 ok(prepares===1&&!connection.enabled&&connection.mode==='inbox'&&!connection.ownerSenderId,'S2 tool only creates a disabled connection with supplied non-secret identity');
 await ev(`(()=>{const real=window.fetch.bind(window);window.__setupCalls=[];window.fetch=(input,init)=>{const url=typeof input==='string'?input:String(input.url||input);window.__setupCalls.push({url,method:String(init?.method||'GET').toUpperCase()});return real(input,init);};return true;})()`);
 await ev(`Array.from(document.querySelectorAll('.steward-act')).find(n=>n.textContent==='继续配置机器人').click(),true`);
 ok(await wait(`!document.getElementById('cfgStewardBotSetup').hidden&&document.querySelector('#cfgStewardBotSetup [data-credential-slot="appSecret"]')`),'S3 card opens this connection guide from a real GET snapshot');
 ok(await ev(`!window.__setupCalls.some(c=>c.url.includes('/api/steward/act')&&c.method==='POST')`),'S4 navigation does not submit an act or authorize control');
 ok(await ev(`document.getElementById('cfgStewardBotSetup').textContent.includes('cli_fixture')&&document.querySelectorAll('#cfgStewardBotSetup input[type="password"]').length===3`),'S5 identity is prefilled and secrets have dedicated password inputs');
 fs.mkdirSync(shots,{recursive:true});
 for(const locale of ['zh-CN','en-US'])for(const theme of ['dark','light'])for(const width of [1440,768,390]){
  await fx.resize(width,1100);await ev(`(()=>{document.querySelector('#settingsTabs [data-stab="basic"]').click();const n=document.getElementById('cfgLocale');n.value=${JSON.stringify(locale)};n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await wait(`document.documentElement.lang===${JSON.stringify(locale)}`);await click('#settingsTabs [data-stab="steward"]');
  await wait(`document.getElementById('cfgStewardBotConnectionsStatus').dataset.state==='ok'&&!!document.querySelector('#cfgStewardBotConnections [data-bot-action="setup"]')`);await click('#cfgStewardBotConnections [data-bot-action="setup"]');await wait(`!document.getElementById('cfgStewardBotSetup').hidden&&document.getElementById('cfgStewardBotSetup').offsetHeight>0&&!!document.querySelector('#cfgStewardBotSetup [data-credential-slot="appSecret"]')`);
  await ev(`(()=>{document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.getElementById('cfgStewardBotSetup').scrollIntoView({block:'start'});const body=document.querySelector('#settingsModal .settings-main > .modal-body');const nav=document.querySelector('#stab-steward .settings-jumplist');if(body&&nav)body.scrollTop-=nav.getBoundingClientRect().height+48;return true;})()`);await sleep(100);
  ok(await ev(`(()=>{const n=document.getElementById('cfgStewardBotSetup'),r=n.getBoundingClientRect();return !n.hidden&&r.height>0&&r.top>=0&&r.top<innerHeight&&document.documentElement.scrollWidth<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1&&r.left>=-1&&r.right<=innerWidth+1;})()`),`V ${locale}/${theme}/${width} guide has no horizontal overflow`);fs.writeFileSync(path.join(shots,`guide-${locale}-${theme}-${width}.png`),await fx.screenshot());
 }
 // Restore a real Chinese settings journey, then save secrets only through dedicated password controls.
 await ev(`(()=>{document.querySelector('#settingsTabs [data-stab="basic"]').click();const n=document.getElementById('cfgLocale');n.value='zh-CN';n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await wait(`document.documentElement.lang==='zh-CN'`);await click('#settingsTabs [data-stab="steward"]');await wait(`document.getElementById('cfgStewardBotConnectionsStatus').dataset.state==='ok'&&!!document.querySelector('#cfgStewardBotConnections [data-bot-action="setup"]')`);await click('#cfgStewardBotConnections [data-bot-action="setup"]');await wait(`!document.getElementById('cfgStewardBotSetup').hidden&&document.getElementById('cfgStewardBotSetup').offsetHeight>0&&!!document.querySelector('#cfgStewardBotSetup [data-credential-slot="appSecret"]')`);
 await ev(`(()=>{const values=${JSON.stringify({verificationToken:FAKE_BOT_ENV.RUYI_BOT_TEST_F_TOKEN,encryptKey:FAKE_BOT_ENV.RUYI_BOT_TEST_F_KEY,appSecret:canary})};for(const [slot,value] of Object.entries(values))document.querySelector('#cfgStewardBotSetup [data-credential-slot="'+slot+'"]').value=value;return true;})()`);await click('#cfgStewardBotSetup [data-setup-action="credentials"]');
 ok(await wait(`Array.from(document.querySelectorAll('#cfgStewardBotSetup input[type="password"]')).every(n=>n.value==='')&&!document.querySelector('#cfgStewardBotSetup [data-setup-action="pair_start"]').disabled`),'S6 real credential API saves and clears password fields without a model request');
 let status=(await fx.request('GET','/api/external-bots/setup?connectionId='+connection.id)).json;
 ok(status.readiness.ingressReady&&status.readiness.replyReady&&status.readiness.credentialSources.appSecret.source==='local','S7 readiness reports local credential source independently of connectivity');
 ok(!JSON.stringify(status).includes(canary)&&modelRequests.every(raw=>!raw.includes(canary)),'S8 setup GET and all provider inputs contain no credential canary');
 await click('#cfgStewardBotSetup [data-setup-action="pair_start"]');ok(await wait(`!!document.querySelector('#cfgStewardBotSetup .external-bot-pair-code')`),'S9 explicit local action starts five-minute pairing');
 status=(await fx.request('GET','/api/external-bots/setup?connectionId='+connection.id)).json;const code=status.pairing.code;const beforeCalls=modelRequests.length;
 const callback=async(text,id)=>{const wire=feishuWire(feishuEvent({text,messageId:id,eventId:id,group:true}));const response=await fetch('http://127.0.0.1:'+fx.appPort+'/api/external-bots/callback/feishu?connectionId='+connection.id,{method:'POST',headers:wire.headers,body:wire.bytes,signal:AbortSignal.timeout(10000)});return response.status;};
 ok(await callback(code,'setup_pair_candidate')===200,'S10 signed owner group pairing callback is accepted');
 ok(await wait(`!!document.querySelector('#cfgStewardBotSetup [data-setup-action="activate"]')`),'S11 visible bounded polling reveals server-verified candidate');
 const paired=(await fx.request('GET','/api/external-bots/setup?connectionId='+connection.id)).json;
 ok(paired.pairing.candidate.senderId==='ou_person'&&paired.pairing.candidate.conversationId==='oc_room'&&paired.pairing.candidate.conversationType==='group'&&!paired.connection.enabled,'S12 candidate exact owner/chat/type are server-derived and still disabled');
 ok(modelRequests.length===beforeCalls&&officialCalls.length===0&&(await fx.request('GET','/api/external-bots/inbox?limit=50')).json.items.length===0,'S13 pairing message never enters runner, delivery or instruction inbox');
 for(const width of [1440,390]){await fx.resize(width,1100);await ev(`document.getElementById('cfgStewardBotSetup').lastElementChild.previousElementSibling.scrollIntoView({block:'center'}),true`);fs.writeFileSync(path.join(shots,'candidate-'+width+'.png'),await fx.screenshot());}
 await click('#cfgStewardBotSetup [data-setup-action="activate"]');ok(await wait(`!!document.querySelector('.confirm-panel [data-confirm="ok"]')`),'S14 activation requires explicit local shared-context and group-visibility confirmation');await click('.confirm-panel [data-confirm="cancel"]');await sleep(100);
 ok(!(await fx.request('GET','/api/external-bots/setup?connectionId='+connection.id)).json.connection.enabled,'S15 cancelling does not enable or fake owner confirmation');
 await click('#cfgStewardBotSetup [data-setup-action="activate"]');await wait(`!!document.querySelector('.confirm-panel [data-confirm="ok"]')`);await click('.confirm-panel [data-confirm="ok"]');
 ok(await wait(`document.getElementById('cfgStewardBotSetup').textContent.includes('等待来自绑定账号')`),'S16 actual CAS activation shows enabled, awaiting real instruction');
 ok(modelRequests.length===beforeCalls&&officialCalls.length===0,'S17 enabling does not send a synthetic model or platform test message');
 ok(await callback('REMOTE_SETUP_QUERY 查询如意状态','setup_real_instruction')===200,'S18 later signed owner @message becomes a real control instruction');
 let item;for(let i=0;i<180;i++){const inbox=(await fx.request('GET','/api/external-bots/inbox?limit=50')).json;item=inbox.items.find(row=>row.messageId==='setup_real_instruction');if(item?.delivery?.status==='sent')break;await sleep(80);}
 ok(queries===1&&item?.execution?.status==='completed'&&item?.delivery?.status==='sent'&&officialCalls.length===2,'S19 production runner invokes read tool and fake official API accepts one reply');
 await click('#cfgStewardBotInboxRefresh');ok(await wait(`document.getElementById('cfgStewardBotInbox').textContent.includes(${JSON.stringify(zh['externalBots.execution.completed'])})&&document.getElementById('cfgStewardBotInbox').textContent.includes(${JSON.stringify(zh['externalBots.delivery.sent'])})`),'S20 actual execution and platform delivery evidence remain separate');
 ok(modelRequests.every(raw=>!raw.includes(canary))&&consoleMessages.every(raw=>!raw.includes(canary)),'S21 no credential canary reaches model requests or browser console');
 ok(await ev(`!JSON.stringify({...localStorage}).includes(${JSON.stringify(canary)})&&!JSON.stringify({...sessionStorage}).includes(${JSON.stringify(canary)})&&!document.getElementById('stewardComposerInput').value.includes(${JSON.stringify(canary)})`),'S22 secret never enters composer, localStorage or sessionStorage');
 let leaked=false;function scan(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,ent.name);if(ent.isDirectory())scan(file);else if(fs.readFileSync(file).includes(Buffer.from(canary)))leaked=true;}}scan(fx.home);ok(!leaked,'S23 all persisted home files, logs and history contain no plaintext credential canary');
 await click('#cfgStewardBotSetup [data-setup-action="close"]');const reads=await ev(`window.__setupCalls.filter(c=>c.url.includes('/api/external-bots/setup')&&c.method==='GET').length`);await sleep(2200);ok(await ev(`window.__setupCalls.filter(c=>c.url.includes('/api/external-bots/setup')&&c.method==='GET').length===${reads}`),'S24 closed guide has no pairing poll');
 console.log('SCREENSHOTS '+shots);t.done();
}catch(error){if(fx?.cdp)try{console.log('FAILSTATE '+JSON.stringify(await fx.evaluate(`(()=>{const host=document.getElementById('cfgStewardBotSetup'),tab=document.getElementById('stab-steward');return{guideHidden:host?.hidden,guideHeight:host?.offsetHeight,active:tab?.className,only:tab?.dataset.only,status:document.getElementById('cfgStewardBotConnectionsStatus')?.dataset.state,rows:document.querySelectorAll('#cfgStewardBotConnections [data-connection-id]').length};})()`)));}catch{}ok(false,error?.stack||String(error));t.done();}finally{if(fx)await fx.close();if(official)await new Promise(resolve=>official.close(resolve));}})();
