'use strict';
// Actual full app/API/engine chips/privacy form; synthetic isolated data only.
// Model-withheld and authorized-local result views are deliberately distinct.
// Assert both actual receivers; never replace the local result with a fake card.
require('./lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRunner}=require('./lib/harness');
const {startBrowserFixture}=require('./lib/browser-fixture');
const {getFreePort}=require('./free-port');
const t=createRunner('PRIVACY FAILURE UX');
async function probes(fx){await fx.evaluate(`(()=>{
  window.p0Writes=[];window.p0Warmups=[];window.p0ImagePrepare=[];window.p0Mic=0;window.p0RecorderStarts=0;window.p0Graphs=0;
  const realFetch=window.fetch;window.fetch=async(...args)=>{
    const method=String(args[1]?.method||'GET').toUpperCase(),url=new URL(String(args[0]),location.href);
    if(method!=='GET')window.p0Writes.push({method,path:url.pathname});
    const response=await realFetch(...args);
    if(method==='POST'&&url.pathname==='/api/audio/warmup'){const body=await response.clone().json();window.p0Warmups.push({status:response.status,ready:body.ready,skipped:body.skipped});}
    if(method==='POST'&&url.pathname==='/api/media/images/prepare'){
      const body=await response.clone().json();
      window.p0ImagePrepare.push({status:response.status,code:body.error?.code});
    }
    if(method==='POST'&&url.pathname==='/api/audio/stream/sessions'&&window.p0HoldStream){
      const hold=value=>new Promise(resolve=>{window.p0StreamHeld=true;window.p0StreamHeldStatus=response.status;window.p0ReleaseStream=()=>resolve(value);});
      if(window.p0HoldStream==='response')return hold(response);
      const json=response.json.bind(response);response.json=async()=>hold(await json());
    }
    return response;
  };
  const media=navigator.mediaDevices,native=media.getUserMedia.bind(media);media.getUserMedia=async(...args)=>{
    window.p0Mic++;const stream=await native(...args);window.p0LatestMedia=stream;
    if(window.p0HoldMic)return new Promise(resolve=>{window.p0ReleaseMic=()=>resolve(stream);});return stream;
  };
  const start=MediaRecorder.prototype.start;MediaRecorder.prototype.start=function(...args){window.p0RecorderStarts++;return start.apply(this,args);};
  const Ctx=window.AudioContext||window.webkitAudioContext;if(Ctx){const create=Ctx.prototype.createMediaStreamSource;Ctx.prototype.createMediaStreamSource=function(...args){window.p0Graphs++;return create.apply(this,args);};}
  return true;
})()`);}
async function knownPrivacy(fx,kind){await fx.request('POST','/api/privacy/settings',{mode:'enhanced',technical:false,rules:[]});await fx.evaluate(`window.state.config.privacyModeV1=${JSON.stringify(kind==='paused'?'off':'enhanced')};window.state.config.privacyPolicyRecoveryRequiredV1=${kind==='paused'};true`);}
async function click(fx,selector){
  if(!await fx.waitForEval(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';})()`))throw Error('enabled visible target did not appear: '+selector);
  await fx.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}),true`);
  if(!await fx.waitForEval(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`))throw Error('actual pointer target did not become reachable: '+selector);
  const box=await fx.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();if(!n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('target lost pointer reachability: '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await fx.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await fx.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
}
async function setLens(fx,lens){if(!await fx.setLens(lens))throw Error('actual shell mode was not entered: '+lens);}
async function ready(fx,sid){
  if(!await fx.waitForEval(`window.state?.currentSession?.id===${JSON.stringify(sid)}&&!!document.querySelector('#threadChips [data-chip="engine"]')&&!!document.getElementById('promptInput')`))throw Error('actual conversation not ready');
}
async function reload(fx,sid){await fx.evaluate(`localStorage.setItem('wcw.lastSession',${JSON.stringify(sid)}),true`);const old=await fx.evaluate('performance.timeOrigin');await fx.cdp.send('Page.reload');if(!await fx.waitForEval(`performance.timeOrigin!==${old}&&!!window.state?.config?.configSchema`))throw Error('reload failed');await ready(fx,sid);if(!await fx.waitForEval(`document.documentElement.lang===window.state.config.locale`))throw Error('configured locale did not finish loading after reload');await setLens(fx,'classic');}
async function send(fx,text){await fx.evaluate(`(()=>{const box=document.getElementById('promptInput');box.value=${JSON.stringify(text)};box.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);await click(fx,'#sendBtn');}
async function checkMissingProtectedImage(fx, strings, label, countRequests) {
  const name = 'public-pixel.png';
  const file = path.join(fx.work, name);
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const before = countRequests();
  const {root} = await fx.cdp.send('DOM.getDocument', {depth:0});
  const {nodeId} = await fx.cdp.send('DOM.querySelector', {nodeId:root.nodeId, selector:'#fileInput'});
  await fx.cdp.send('DOM.setFileInputFiles', {nodeId, files:[file]});
  const draft = `(() => {
    const [attachment] = window.state.attachments;
    return !window.state.uploading && attachment?.name === ${JSON.stringify(name)} &&
      attachment.imageReviewRequired === true && !attachment.protectedImage && !attachment.previewUrl &&
      !document.querySelector('#attachmentTray .attach-pill-thumb');
  })()`;
  const retained = await fx.waitForEval(draft);
  const preparations = await fx.evaluate('window.p0ImagePrepare');
  const missing = preparations.length === 1 && preparations[0].status === 409 && preparations[0].code === 'privacy.image_processor_dependency_failed';
  if (!retained || !missing) console.log('P0-IMAGE-DIAG', JSON.stringify({ label, retained, preparations }));
  t.ok(retained && missing,
    label + ': actual browser upload preserves a reviewable image without a raw preview when Full resources are missing');
  const message = 'P0_SYNTHETIC_MISSING_IMAGE';
  const writes = await fx.evaluate('window.p0Writes.length');
  await send(fx, message);
  t.ok(await fx.waitForEval(`document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['mediaImage.reviewRequired'])})`) &&
    await fx.evaluate(`${draft} && document.getElementById('promptInput').value === ${JSON.stringify(message)} &&
      !window.p0Writes.slice(${writes}).some(row=>row.path.startsWith('/api/chat/'))`) &&
    countRequests() === before, label + ': browser Send preserves the text and attachment draft with zero model requests');
  await click(fx, '#attachmentTray .attach-x');
  await fx.evaluate("(() => { const box = document.getElementById('promptInput'); box.value = ''; box.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
}
async function engine(fx,key){
  await click(fx,'#threadChips [data-chip="engine"]');await click(fx,`.steward-chip-menu[data-kind="engine"] [data-engine-key="${key}"]`);
  const [kind,id]=key.split(':'),matches=route=>kind==='agent'?route?.engine==='agent'&&route.agentCliType===id:route?.engine==='openai'&&route.providerId===id;
  // The product closes this menu before awaiting PATCH. Wait for its actual
  // response to update the session, rather than sending on the old route.
  const routeCheck=kind==='agent'?`r?.engine==='agent'&&r.agentCliType===${JSON.stringify(id)}`:`r?.engine==='openai'&&r.providerId===${JSON.stringify(id)}`;
  if(!await fx.waitForEval(`(()=>{const r=window.state.currentSession?.engineRoute;return document.querySelector('#threadChips [data-chip="engine"]').getAttribute('aria-expanded')==='false'&&(${routeCheck});})()`))throw Error('engine selection did not persist');
  const sid=await fx.evaluate('window.state.currentSession.id'),saved=await fx.request('GET','/api/sessions/'+encodeURIComponent(sid));
  if(saved.status!==200||!matches(saved.json?.session?.engineRoute))throw Error('selected engine differs from authoritative session route');
}
async function selectCardAction(fx,label,keyboard=false){
  const focused=await fx.evaluate(`(()=>{for(const old of document.querySelectorAll('#privacy-error-action'))old.removeAttribute('id');const n=[...document.querySelectorAll('.error-card-btn')].findLast(n=>n.textContent===${JSON.stringify(label)});if(!n)throw Error('missing action');n.id='privacy-error-action';n.focus();return document.activeElement===n&&n.type==='button';})()`);
  if(keyboard)await fx.enter();else await click(fx,'#privacy-error-action');return focused;
}
(async()=>{
  if(process.platform!=='win32'){console.log('SKIP actual encrypted policy recovery requires Windows');return;}
  for(const locale of ['zh-CN','en-US']){
    let fx,providerRequests=0,allProviderRequests=0,sid;
    const wires=[], secret='p0-synthetic-private@example.test';
    const extra=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-p0-voice-')),toolboxHome=path.join(extra,'toolbox'),streamPort=await getFreePort();
    fs.mkdirSync(path.join(toolboxHome,'components'),{recursive:true});
    fs.writeFileSync(path.join(toolboxHome,'components','p0-stream.json'),JSON.stringify({schema:1,id:'p0-stream',kind:'service',name:'Synthetic P0 stream',version:'0.0.1',run:{command:process.execPath,args:[path.resolve(__dirname,'lib/fake-stream-component.js')],cwd:path.resolve(__dirname,'lib'),env:{}},service:{port:streamPort,portEnv:'FAKE_STREAM_PORT',health:'/health',component:'fake-stream-component'},provides:[{type:'asr-stream',basePath:'/v1',model:'fake-stream-model'}],registeredAt:new Date().toISOString()}));
    const strings=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../ruyi-workbench/app/public/locales',locale+'.json'),'utf8'));
    try{
      fx=await startBrowserFixture({ok:t.ok,prefix:'ruyi-privacy-failure-',serverEnv:{RUYI_TOOLBOX_HOME:toolboxHome,
        RUYI_MEDIA_RESOURCE_PROFILE:'legacy-full-4987-v1',RUYI_MEDIA_RUNTIME_ROOT:path.join(extra,'missing-runtime'),
        RUYI_MEDIA_SOURCES_ROOT:path.join(extra,'missing-sources')},browserArgs:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],config:{locale,privacyModeV1:'enhanced',credentialEncryptionV1:true,privacyRulesV1:[],
        schedulerEnabledV1:false,stewardEnabledV1:true,stewardVisitIdleMinutes:1440,stewardThreadBriefV1:false,importAgentInstructions:false,permissionMode:'bypass',toolLoadingMode:'full',
        bridgeExternalToolsToProvider:false,runtimeOptimizationShadowV1:false,contextAutoCompactEnabled:false,memoryAutoProposeEnabled:false,missionAutoContinue:false,
        asrProviderId:'fake',asrModel:'fake-model',asrFixMode:'off',allowCommandTools:true,allowDesktopTools:false,desktopMcp:{enabled:false,autodetect:false}},
        provider:ctx=>{
          allProviderRequests++;
          if(ctx.body.stream){providerRequests++;wires.push(structuredClone(ctx.body));}
          const last=ctx.messages.findLast(row=>row.role==='user'), tool=ctx.messages.findLast(row=>row.role==='tool'&&row.tool_call_id==='p0-one-write');
          if(String(last?.content||'').includes('P0_SYNTHETIC_PROVIDER_ERROR')){
            ctx.sse({error:{code:'synthetic_provider_failure',message:'Synthetic provider said privacy.policy_changed as ordinary prose'}});ctx.stop();
          }else if(String(last?.content||'').includes('P0_SYNTHETIC_MCP_RECEIPT')){
            const receipt=ctx.messages.findLast(row=>row.role==='tool'&&row.tool_call_id==='p0-explicit-receipt');
            if(!receipt)ctx.toolCall('p0ux__receipt_probe',{},'p0-explicit-receipt');
            else{ctx.text('P0_SYNTHETIC_RECEIPT_COMPLETE');ctx.stop();}
          }else if(String(last?.content||'').includes('P0_SYNTHETIC_WITHHELD_WRITE')){
            if(!tool)ctx.toolCall('powershell_run',{command:"Add-Content -LiteralPath './p0-counter.txt' -Value '1'; Get-Content -Raw -LiteralPath './p0-source.json'"},'p0-one-write');
            else{ctx.text('P0_SYNTHETIC_WITHHELD_COMPLETE');ctx.stop();}
          }else{ctx.text('P0_SYNTHETIC_NATIVE_DONE');ctx.stop();}
        },
        prepare:async f=>{
          const marker=path.join(f.work,'unexpected-cli-business.txt'),fakeCli=path.join(f.work,'synthetic-cli.cmd');
          fs.writeFileSync(fakeCli,'@echo off\r\nif "%~1"=="--version" (echo synthetic-cli & exit /b 0)\r\necho business>>"'+marker+'"\r\nexit /b 1\r\n');
          await f.request('POST','/api/config',{claudePath:fakeCli,asrStreamProviderId:'toolbox-p0-stream',asrStreamModel:'fake-stream-model',
            providers:[{id:'fake',label:'Fake',type:'openai-compat',baseUrl:'http://127.0.0.1:'+f.providerPort,
              apiKey:'browser-fixture-auth-only',model:'fake-model',models:[{id:'fake-model',label:'Fake'}],vision:true}]});
          fs.writeFileSync(path.join(f.work,'p0-source.json'),JSON.stringify({password:null,email:secret}));
          const created=await f.request('POST','/api/sessions',{title:'Synthetic privacy UX '+locale,cwd:f.work});sid=created.json?.session?.id||created.json?.id;if(!sid)throw Error('session creation failed');
        }});
      await reload(fx,sid);
      await fx.evaluate(`window.state.config.asrStreamProviderId='';window.state.config.asrStreamModel='';true`);
      await probes(fx);
      await engine(fx,'agent:claude');
      await send(fx,'P0_SYNTHETIC_CLI_REFUSAL');
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes(${JSON.stringify(strings['privacy.failure.engine'])})`),locale+': actual protected CLI chat displays actionable localized refusal');
      t.ok(providerRequests===0&&!fs.existsSync(path.join(fx.work,'unexpected-cli-business.txt')),locale+': refused chat starts neither CLI business nor provider transport');
      const writes=await fx.evaluate('window.p0Writes.length');
      const engineActionFocused=await selectCardAction(fx,strings['privacy.failure.chooseEngine'],true);
      t.ok(engineActionFocused&&await fx.waitForEval(`document.querySelector('#threadChips [data-chip="engine"]').getAttribute('aria-expanded')==='true'&&document.activeElement===document.querySelector('#threadChips [data-chip="engine"]')`)&&await fx.evaluate('window.p0Writes.length')===writes&&providerRequests===0,locale+': focused native button activates by Enter and only opens existing conversation selector');
      await click(fx,'.steward-chip-menu[data-kind="engine"] [data-engine-key="openai:fake"]');
      await fx.waitForEval(`window.state.currentSession.engineRoute?.providerId==='fake'`);
      t.ok(providerRequests===0,locale+': explicit engine selection itself never resends the refused message');
      await send(fx,'P0_SYNTHETIC_EXPLICIT_RETRY');
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes('P0_SYNTHETIC_NATIVE_DONE')`)&&providerRequests===1,locale+': one explicit user retry reaches the synthetic native provider once');
      if (!await fx.waitForEval('!window.state.streaming')) throw Error('native turn did not settle');
      await checkMissingProtectedImage(fx, strings, locale, () => allProviderRequests);
      // Fresh forged references are strict model-preparation errors. Typed user
      // content instead has an existing safe-withheld recovery contract, so it
      // must not be used as an oracle for a top-level failure. Keep this refused
      // history in a separate real session.
      const failedSession=await fx.request('POST','/api/sessions',{title:'Synthetic persisted privacy error '+locale,cwd:fx.work});
      const failedSid=failedSession.json?.session?.id||failedSession.json?.id;if(!failedSid)throw Error('persisted-failure session creation failed');
      await reload(fx,failedSid);const beforePersisted=providerRequests;
      await send(fx,'P0_SYNTHETIC_PERSISTED_FAILURE [[RUYI_PVT:EMAIL:'+ 'f'.repeat(32)+']]');
      const refused=await fx.waitForEval(`!window.state.streaming&&!![...document.querySelectorAll('#messages .error-card')].find(n=>n.textContent.includes(${JSON.stringify(strings['privacy.failure.reference'])}))`)&&providerRequests===beforePersisted;
      if(!refused)console.log('DIAGNOSTIC persisted failure',JSON.stringify({failedSid,beforePersisted,providerRequests,dom:await fx.evaluate("document.getElementById('messages').textContent.slice(-3000)")}));
      t.ok(refused,locale+': actual fresh unknown reference refuses before provider bytes with localized error');
      if(!refused)throw Error('actual strict reference refusal not observed');
      const failedMessages=fs.readFileSync(path.join(fx.home,'sessions',failedSid+'.messages.ndjson'),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
      t.ok(failedMessages.some(message=>message.role==='assistant'&&message.segments?.some(segment=>segment.type==='error'&&segment.code==='privacy.reference_unknown')),locale+': actual error segment is saved in the ordinary NDJSON body by the turn builder');
      await reload(fx,failedSid);
      t.ok(await fx.waitForEval(`!![...document.querySelectorAll('#messages .error-card')].find(n=>n.textContent.includes(${JSON.stringify(strings['privacy.failure.reference'])}))`)&&providerRequests===beforePersisted,locale+': reload renders the real persisted privacy error as the same localized card without resend');
      const genericSession=await fx.request('POST','/api/sessions',{title:'Synthetic ordinary provider error '+locale,cwd:fx.work});
      const genericSid=genericSession.json?.session?.id||genericSession.json?.id;if(!genericSid)throw Error('generic-error session creation failed');
      await reload(fx,genericSid);const beforeGeneric=providerRequests;await send(fx,'P0_SYNTHETIC_PROVIDER_ERROR');
      t.ok(await fx.waitForEval(`!window.state.streaming&&[...document.querySelectorAll('#messages .error-card')].some(card=>card.querySelector('.error-card-title')?.textContent===${JSON.stringify(strings['error.providerError'])}&&card.textContent.includes(${JSON.stringify(strings['error.providerError.next'])})&&!card.textContent.includes(${JSON.stringify(strings['privacy.failure.title'])}))`)&&providerRequests===beforeGeneric+1,locale+': actual ordinary provider error keeps the existing generic class despite privacy-code prose and does not auto-retry');
      const limitedSession=await fx.request('POST','/api/sessions',{title:'Synthetic privacy scan limit '+locale,cwd:fx.work});
      const limitedSid=limitedSession.json?.session?.id||limitedSession.json?.id;if(!limitedSid)throw Error('scan-limit session creation failed');
      await reload(fx,limitedSid);const beforeLimit=providerRequests;
      await fx.request('POST','/api/privacy/settings',{mode:'enhanced',technical:false,rules:[{id:'synthetic-limit',kind:'literal',value:'SYNTHETIC_LIMIT_MATCH',category:'INTERNAL'}]});
      await send(fx,'SYNTHETIC_LIMIT_MATCH '.repeat(10001));
      const limitCard=`!![...document.querySelectorAll('#messages .error-card')].find(card=>card.textContent.includes(${JSON.stringify(strings['privacy.failure.scanLimit'])})&&!card.querySelector('.error-card-btn'))`;
      const limitRefused=await fx.waitForEval(`!window.state.streaming&&${limitCard}`)&&providerRequests===beforeLimit;
      if(!limitRefused)console.log('LIMIT-DIAGNOSTIC '+JSON.stringify({locale,beforeLimit,providerRequests,dom:await fx.evaluate("document.getElementById('messages').textContent.slice(-1800)")}));
      t.ok(limitRefused,locale+': real scan-limit refusal has localized recovery guidance and sends zero provider bytes');
      await reload(fx,limitedSid);
      t.ok(await fx.waitForEval(limitCard)&&providerRequests===beforeLimit,locale+': persisted resource-limit guidance survives reload without automatic resend');
      await click(fx,'#resumeBanner .resume-banner-btn');
      const resumed=await fx.waitForEval("!window.state.streaming&&document.getElementById('messages').textContent.includes('P0_SYNTHETIC_NATIVE_DONE')")&&providerRequests===beforeLimit+1;
      t.ok(resumed&&!JSON.stringify(wires.at(-1)).includes('SYNTHETIC_LIMIT_MATCH'),locale+': Continue resumes the same thread with privacy still enabled and excludes the rejected input');
      const beforeOff=providerRequests;
      await fx.request('POST','/api/privacy/settings',{mode:'off',technical:false,rules:[]});
      await reload(fx,limitedSid);
      const doneCount="(document.getElementById('messages').textContent.match(/P0_SYNTHETIC_NATIVE_DONE/g)||[]).length";
      const beforeDone=await fx.evaluate(doneCount);
      await send(fx,'P0_SYNTHETIC_CONTINUE_AFTER_PRIVACY_OFF');
      t.ok(await fx.waitForEval("!window.state.streaming&&"+doneCount+"==="+(beforeDone+1))&&providerRequests===beforeOff+1,locale+': same session continues after a privacy failure and explicit disable despite its retained history');
      await fx.request('POST','/api/privacy/settings',{mode:'enhanced',technical:false,rules:[]});
      await reload(fx,sid);await probes(fx);
      for(const [lens,button]of [['classic','#composerVoiceBtn'],['steward','#stewardComposerVoice']]){
        await setLens(fx,lens);await click(fx,button);
        t.ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(button)}).dataset.state==='error'&&document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['privacy.failure.media'])})`)&&await fx.evaluate(`window.p0Mic===0&&!window.p0Writes.some(row=>row.path.startsWith('/api/audio/'))`),locale+'/'+lens+': known protection gives typed-text guidance without microphone permission or audio requests');
      }
      await fx.request('POST','/api/privacy/settings',{mode:'off',technical:false,rules:[]});
      await fx.evaluate(`Object.assign(window.state.config,{privacyModeV1:'off',asrProviderId:'fake',asrModel:'fake-model',asrStreamProviderId:'',asrStreamModel:''});true`);await setLens(fx,'classic');
      await click(fx,'#composerVoiceBtn');
      t.ok(await fx.waitForEval(`document.getElementById('composerVoiceBtn').dataset.state==='recording'`)&&await fx.evaluate('window.p0Mic===1'),locale+': ordinary configured OFF still starts actual synthetic microphone recording');
      await fx.escape();
      t.ok(await fx.waitForEval(`document.getElementById('composerVoiceBtn').dataset.state!=='recording'`)&&await fx.evaluate(`!window.p0Writes.some(row=>row.path.startsWith('/api/audio/'))`),locale+': explicit cancellation keeps OFF recording local without outbound audio');
      for(const [lens,button]of [['classic','#composerVoiceBtn'],['steward','#stewardComposerVoice']])for(const kind of ['on','paused']){
        await fx.request('POST','/api/privacy/settings',{mode:'off',technical:false,rules:[]});
        await fx.evaluate(`Object.assign(window.state.config,{privacyModeV1:'off',privacyPolicyRecoveryRequiredV1:false,asrProviderId:'fake',asrStreamProviderId:'',asrStreamModel:''});window.p0HoldMic=true;window.p0ReleaseMic=null;true`);await setLens(fx,lens);
        const before=await fx.evaluate('({starts:window.p0RecorderStarts,writes:window.p0Writes.length})');await click(fx,button);
        if(!await fx.waitForEval(`typeof window.p0ReleaseMic==='function'`))throw Error('actual synthetic getUserMedia was not held');
        await knownPrivacy(fx,kind);await fx.evaluate(`window.p0HoldMic=false;window.p0ReleaseMic();true`);
        const key=kind==='paused'?'privacy.failure.unavailable':'privacy.failure.media';
        t.ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(button)}).dataset.state==='error'&&window.p0LatestMedia.getTracks().every(track=>track.readyState==='ended')&&document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings[key])})`)&&await fx.evaluate(`window.p0RecorderStarts===${before.starts}&&!window.p0Writes.slice(${before.writes}).some(row=>row.path.startsWith('/api/audio/'))`),locale+'/'+lens+'/'+kind+': policy change while getUserMedia waits stops returned tracks before recording or transport');
      }
      for(const [lens,button]of [['classic','#composerVoiceBtn'],['steward','#stewardComposerVoice']])for(const kind of ['on','paused'])for(const stage of ['response','json']){
        await fx.request('POST','/api/privacy/settings',{mode:'off',technical:false,rules:[]});
        await fx.evaluate(`Object.assign(window.state.config,{privacyModeV1:'off',privacyPolicyRecoveryRequiredV1:false,asrProviderId:'fake',asrStreamProviderId:'toolbox-p0-stream',asrStreamModel:'fake-stream-model'});window.p0HoldStream=${JSON.stringify(stage)};window.p0StreamHeld=false;window.p0ReleaseStream=null;true`);await setLens(fx,lens);
        const before=await fx.evaluate('({starts:window.p0RecorderStarts,graphs:window.p0Graphs,writes:window.p0Writes.length})');await click(fx,button);
        if(!await fx.waitForEval(`window.p0StreamHeld&&window.p0StreamHeldStatus===200`))throw Error('actual successful stream open was not held');
        const health=await(await fetch('http://127.0.0.1:'+streamPort+'/health')).json();
        await knownPrivacy(fx,kind);await fx.evaluate(`window.p0HoldStream='';window.p0ReleaseStream();true`);
        const key=kind==='paused'?'privacy.failure.unavailable':'privacy.failure.media';
        t.ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(button)}).dataset.state==='error'&&window.p0LatestMedia.getTracks().every(track=>track.readyState==='ended')&&document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings[key])})`)&&await fx.evaluate(`window.p0RecorderStarts===${before.starts}&&window.p0Graphs===${before.graphs}&&!window.p0Writes.slice(${before.writes}).some(row=>/\\/(?:audio|finish)$|\\/transcribe/.test(row.path))`),locale+'/'+lens+'/'+kind+'/'+stage+': changed policy after real stream-open await never builds recording/PCM graph or submits audio');
        let cleaned=false;for(let i=0;i<100&&!cleaned;i++){const current=await(await fetch('http://127.0.0.1:'+streamPort+'/health')).json();cleaned=current.deleted>health.deleted&&current.sessions===0;if(!cleaned)await new Promise(resolve=>setTimeout(resolve,25));}
        t.ok(cleaned,locale+'/'+lens+'/'+kind+'/'+stage+': exact opened synthetic stream is reclaimed by body-free DELETE under changed policy');
      }
      for(const [lens,button]of [['classic','#composerVoiceBtn'],['steward','#stewardComposerVoice']]){
        await fx.request('POST','/api/privacy/settings',{mode:'off',technical:false,rules:[]});
        await fx.evaluate(`Object.assign(window.state.config,{privacyModeV1:'off',privacyPolicyRecoveryRequiredV1:false,asrProviderId:'toolbox-p0-fixture',asrModel:'fake-model',asrStreamProviderId:'',asrStreamModel:''});true`);await setLens(fx,lens);
        let paused;const listener=event=>{paused=event.requestId;};fx.cdp.on('Fetch.requestPaused',listener);
        await fx.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/audio/warmup',requestStage:'Request'}]});
        const warmBefore=await fx.evaluate('({mic:window.p0Mic,responses:window.p0Warmups.length})');await click(fx,button);
        for(let i=0;i<100&&!paused;i++)await new Promise(resolve=>setTimeout(resolve,25));if(!paused)throw Error('actual warmup was not held');
        await knownPrivacy(fx,'on');
        await fx.cdp.send('Fetch.continueRequest',{requestId:paused});await fx.cdp.send('Fetch.disable');
        t.ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(button)}).dataset.state==='error'&&document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['privacy.failure.media'])})`)&&await fx.evaluate(`window.p0Mic===${warmBefore.mic}&&window.p0Warmups.length===${warmBefore.responses+1}&&window.p0Warmups.at(-1).status===200&&window.p0Warmups.at(-1).ready===true&&window.p0Warmups.at(-1).skipped==='remote'`),locale+'/'+lens+': known policy change during held real warmup completion stops before microphone access after an actual remote-skip 200');
      }
      await fx.evaluate(`window.state.config.privacyModeV1='enhanced';window.state.config.privacyPolicyRecoveryRequiredV1=false;window.state.config.asrProviderId='fake';true`);
      await setLens(fx,'classic');
      // Keep the real previous-config backup protected before corrupting the current file.
      await fx.request('POST','/api/privacy/settings',{mode:'enhanced',technical:false,rules:[]});
      const beforeRecovery=providerRequests;fs.writeFileSync(path.join(fx.home,'config.json'),'{"broken":');
      const status=await fx.request('GET','/api/privacy/status');t.ok(status.json?.recoveryRequired===true,locale+': actual corrupt config recovery pauses external traffic');
      await reload(fx,sid);
      await probes(fx);
      for(const [lens,button]of [['classic','#composerVoiceBtn'],['steward','#stewardComposerVoice']]){
        await setLens(fx,lens);await click(fx,button);
        const recoveredVoice=await fx.waitForEval(`document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['privacy.failure.unavailable'])})`)&&await fx.evaluate(`window.p0Mic===0&&!window.p0Writes.some(row=>row.path.startsWith('/api/audio/'))`);
        if(!recoveredVoice)console.log('P0-RECOVERY-VOICE-DIAGNOSTIC '+JSON.stringify({locale,lens,...await fx.evaluate(`({htmlLocale:document.documentElement.lang,configuredLocale:window.state.config.locale,mode:window.state.config.privacyModeV1,recoveryRequired:window.state.config.privacyPolicyRecoveryRequiredV1,buttonState:document.querySelector(${JSON.stringify(button)})?.dataset.state,expectedToast:document.getElementById('toastTray').textContent.includes(${JSON.stringify(strings['privacy.failure.unavailable'])}),microphoneCalls:window.p0Mic,audioWrites:window.p0Writes.filter(row=>row.path.startsWith('/api/audio/')).length})`)}));
        t.ok(recoveredVoice,locale+'/'+lens+': actual recovered paused config rejects voice with review guidance before microphone access');
      }
      await setLens(fx,'classic');
      await send(fx,'P0_SYNTHETIC_PAUSED');
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes(${JSON.stringify(strings['privacy.failure.unavailable'])})`)&&providerRequests===beforeRecovery,locale+': paused chat remains readable and performs no automatic retry');
      const fileBefore=fs.readFileSync(path.join(fx.home,'config.json'),'utf8');
      const privacyActionFocused=await selectCardAction(fx,strings['privacy.failure.openSettings'],true);
      t.ok(privacyActionFocused&&await fx.waitForEval(`!document.getElementById('privacyPolicyRecoveryNotice').hidden&&!document.getElementById('privacySave').disabled&&!!document.activeElement?.closest('#settingsModal')`),locale+': focused recovery action opens the existing form with Enter and moves focus into settings');
      t.ok(fs.readFileSync(path.join(fx.home,'config.json'),'utf8')===fileBefore&&providerRequests===beforeRecovery,locale+': opening privacy settings makes no configuration/business change');
      t.ok(await fx.evaluate(`document.getElementById('privacyMode').value!=='off'&&document.getElementById('privacyEncryption').checked`),locale+': recovered form preserves protected encrypted settings for review');
      await click(fx,'#privacyCompatibility > summary');
      const coverage=await fx.request('GET','/api/privacy/status');
      t.ok(coverage.json?.channels?.find(row=>row.id==='standaloneMcp')?.supported===false&&coverage.json?.channels?.find(row=>row.id==='authenticatedMcpText')?.supported===true&&await fx.waitForEval(`(()=>{const fold=document.getElementById('privacyCompatibility'),rows=[...document.querySelectorAll('#privacyCoverage li')].map(n=>n.textContent);return !!fold?.open&&rows.includes(${JSON.stringify(strings['privacy.channel.standaloneMcp']+' · '+strings['privacy.blocked'])})&&rows.includes(${JSON.stringify(strings['privacy.channel.authenticatedMcpText']+' · '+strings['privacy.supportedText'])})&&fold.textContent.includes(${JSON.stringify(strings['privacy.coverage'])})&&fold.textContent.includes('capabilities/workspace');})()`),locale+': actual status and visible coverage distinguish unissued direct access from bounded authorized 8b template/subscription resources');
      await click(fx,'#privacySave');
      t.ok(await fx.waitForEval(`document.getElementById('privacyPolicyRecoveryNotice').hidden`),locale+': explicit existing save confirms recovered policy');
      const final=await fx.request('GET','/api/privacy/status');t.ok(final.json?.recoveryRequired===false&&final.json?.mode!=='off'&&final.json?.encryption===true&&providerRequests===beforeRecovery,locale+': recovery retains protection and the existing credential-encryption setting without automatically resending');
      await fx.key('Escape',{keyCode:27});await send(fx,'P0_SYNTHETIC_AFTER_REVIEW');
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes('P0_SYNTHETIC_AFTER_REVIEW')&&!window.state.streaming`)&&providerRequests===beforeRecovery+1,locale+': fresh retry after explicit review reaches provider once');
      const beforeWrite=wires.length;await send(fx,'P0_SYNTHETIC_WITHHELD_WRITE');
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes('P0_SYNTHETIC_WITHHELD_COMPLETE')&&!window.state.streaming`),locale+': real synthetic write finishes despite a withheld model result');
      const actualWire=wires.slice(beforeWrite), receiptText=actualWire.at(-1)?.messages?.findLast(row=>row.role==='tool'&&row.tool_call_id==='p0-one-write')?.content;
      let receipt;try{receipt=JSON.parse(receiptText);}catch{}
      t.ok(actualWire.length===2&&receipt?.code==='privacy.tool_result_withheld'&&receipt.operationMayHaveExecuted===true&&receipt.resultUnavailable===true&&!JSON.stringify(actualWire).includes(secret),locale+': actual next model POST receives withheld execution uncertainty, without originals or hidden retry');
      const counter=path.join(fx.work,'p0-counter.txt'), count=()=>fs.readFileSync(counter,'utf8').trim().split(/\r?\n/).length;
      t.ok(fs.existsSync(counter)&&count()===1,locale+': actual local PowerShell side effect occurs exactly once');
      await fx.evaluate(`(()=>{const cards=[...document.querySelectorAll('#messages details.tool-card')];for(const card of cards)if(card.textContent.includes('p0-source.json'))card.open=true;return true;})()`);
      t.ok(await fx.waitForEval(`(()=>{const card=[...document.querySelectorAll('#messages details.tool-card')].findLast(n=>n.textContent.includes('p0-source.json'));return !!card&&card.open&&card.textContent.includes(${JSON.stringify(secret)})&&!card.textContent.includes(${JSON.stringify(strings['privacy.failure.withheld'])});})()`),locale+': authorized local tool view retains its actual result rather than the separate model receipt');
      t.ok(await fx.evaluate(`!document.querySelector('#messages .message:last-child .error-card-noop')`)&&count()===1,locale+': local execution view does not falsely say no files changed or rerun to recover the withheld model copy');
      await reload(fx,sid);
      t.ok(await fx.waitForEval(`document.getElementById('messages').textContent.includes(${JSON.stringify(secret)})`)&&count()===1,locale+': persisted authorized local result survives reload without replay');
      // A real synthetic MCP protocol error tests the explicit isError receipt
      // path. The adapter normalizes it to ok:false; no fake UI card or turn
      // metadata is inserted, and the service call itself is counted once.
      const receiptServer=path.join(fx.work,'p0-receipt-mcp.cjs'),receiptCalls=path.join(fx.work,'p0-receipt-calls.txt');
      fs.writeFileSync(receiptServer,[
        "const fs=require('node:fs'),readline=require('node:readline');",
        "readline.createInterface({input:process.stdin}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(message.id===undefined)return;let result;",
        "if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic-p0-receipt',version:'1'}};",
        "else if(message.method==='tools/list')result={tools:[{name:'receipt_probe',description:'Returns a synthetic explicit error receipt',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};",
        "else if(message.method==='tools/call'){fs.appendFileSync("+JSON.stringify(receiptCalls)+",'1\\n');result={isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:'privacy.tool_result_withheld',operationMayHaveExecuted:true,resultUnavailable:true,retry:false})}]};}",
        "else if(message.method==='ping')result={};else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported fixture method'}})+'\\n');return;}",
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');});"
      ].join('\n'));
      await fx.request('POST','/api/config',{bridgeExternalToolsToProvider:true,externalMcpServers:[{id:'p0ux',transport:'stdio',command:process.execPath,args:[receiptServer],cwd:fx.work,enabled:true}]});
      const beforeReceipt=wires.length;await send(fx,'P0_SYNTHETIC_MCP_RECEIPT');
      const receiptCard=`(()=>{const card=[...document.querySelectorAll('#messages details.tool-card')].at(-1);return !!card&&!!card.querySelector('.error-card')&&card.textContent.includes(${JSON.stringify(strings['privacy.failure.withheld'])})&&!card.querySelector('.error-card-noop')&&!card.querySelector('.error-card-btn');})()`;
      t.ok(await fx.waitForEval(`!window.state.streaming&&document.getElementById('messages').textContent.includes('P0_SYNTHETIC_RECEIPT_COMPLETE')&&${receiptCard}`),locale+': actual isError MCP receipt renders localized uncertainty without no-change claim or retry action');
      const receiptWire=wires.slice(beforeReceipt).at(-1)?.messages?.findLast(row=>row.role==='tool'&&row.tool_call_id==='p0-explicit-receipt')?.content;
      let explicitReceipt;try{explicitReceipt=JSON.parse(receiptWire);}catch{}
      const receiptCount=()=>fs.readFileSync(receiptCalls,'utf8').trim().split(/\r?\n/).length;
      t.ok(wires.length-beforeReceipt===2&&explicitReceipt?.ok===false&&explicitReceipt?.code==='privacy.tool_result_withheld'&&explicitReceipt.operationMayHaveExecuted===true&&explicitReceipt.resultUnavailable===true&&receiptCount()===1,locale+': actual MCP transport receipt reaches the next model POST once without service replay');
      await reload(fx,sid);
      t.ok(await fx.waitForEval(receiptCard)&&receiptCount()===1&&count()===1,locale+': reloaded explicit receipt remains localized while both synthetic operation counts stay one');
      t.ok(fx.exceptions.length===0,locale+': no uncaught UI exception');
    }finally{if(fx){if(fx.cdp){await fx.cdp.close();fx.cdp=null;}await fx.close();}fs.rmSync(extra,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  }
})().catch(error=>{console.error(error.stack);t.fail('uncaught P0 browser draft error');}).finally(()=>t.done());
