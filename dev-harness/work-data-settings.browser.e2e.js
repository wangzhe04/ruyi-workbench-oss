#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// Parent-run serial gate. Actual application assets + browser DOM/layout; job
// mutations use an explicit client transport fixture, never the real worker.
// This tests UI receipts, not encryption/migration/DPAPI execution.
const fs=require('node:fs'),path=require('node:path');
const {startBrowserFixture}=require('./lib/browser-fixture');
const {createRunner}=require('./lib/harness');
const runner=createRunner('WORK DATA SETTINGS BROWSER'),{ok}=runner;
(async()=>{let fx;try{
 fx=await startBrowserFixture({ok,prefix:'ruyi-work-data-settings-',width:1440,height:1000,config:{locale:'en-US',stewardEnabledV1:false}});
 const status=await fx.request('GET','/api/work-data/status');ok(status?.status===200&&status.json?.ok&&['plain','encrypted'].includes(status.json.authority?.mode),'actual setup status supplies authority');
 await fx.evaluate(`document.getElementById('openSettingsBtn').click();document.querySelector('#settingsTabs [data-stab="security"]').click();true`);
 ok(!!await fx.waitForEval(`document.getElementById('workDataOperation')?true:null`),'settings composition mounts the work data panel');
 const sibling=await fx.evaluate(`(()=>{const p=document.getElementById('privacySettings'),w=document.getElementById('workDataSettings');return p.parentElement===w.parentElement&&!p.contains(w);})()`);ok(sibling,'work data controls remain outside privacy render scope');
 const backup=path.join(fx.root,'synthetic-backup');fs.mkdirSync(backup);
 await fx.evaluate(`(()=>{const original=window.fetch;window.__workDataUiFixture={posts:[],job:null};const a={generation:0,id:null,mode:'plain',sha256:null};window.fetch=async(input,options={})=>{const url=String(typeof input==='string'?input:input.url),s=window.__workDataUiFixture;let body;const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});if(url==='/api/work-data/status')return response({ok:true,authority:a,job:s.job,lastResult:null,capabilities:{worker:true,upload:false,download:false}});if(url==='/api/pick-folder')return response({ok:true,path:${JSON.stringify(backup)}});if(url==='/api/work-data/jobs'&&options.method==='POST'){body=JSON.parse(options.body);s.posts.push({operation:body.operation,authority:body.expectedAuthority,keys:Object.keys(body),passwordCorrect:body.password==='SYNTH_UI_SECRET_ONLY_123'});s.job={id:'a'.repeat(48),operation:body.operation,state:'handoff',cancellable:false,takeover:true,retry:false,error:null};return response({ok:true,job:s.job});}if(url==='/api/work-data/jobs/'+'a'.repeat(48))return response({ok:true,job:s.job});return original(input,options);};return true;})()`);
 // refresh() returns the panel's in-flight read, so a status read started by the composition
 // mount before the transport swap can satisfy the awaited call without the mock ever being
 // consulted. Await that read out, then refresh until the mocked capability is what renders.
 ok(await fx.evaluate(`(async()=>{const m=await import('/js/work-data-settings.js'),panel=m.mountWorkDataSettings();const mocked=()=>document.getElementById('workDataUnavailable').hidden===true;for(let attempt=0;attempt<4&&!mocked();attempt++){await panel.refresh();if(!mocked())await new Promise(r=>setTimeout(r,50));}return mocked();})()`),'mocked worker capability is applied by an actual refresh');
 await fx.evaluate(`document.getElementById('workDataPickBackup').click();true`);ok(!!await fx.waitForEval(`document.getElementById('workDataBackupDirectory').value?true:null`),'actual directory picker receipt fills the controlled field');
 await fx.evaluate(`(()=>{for(const id of ['workDataPassword','workDataPasswordConfirm']){const e=document.getElementById(id);e.value='SYNTH_UI_SECRET_ONLY_123';e.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
 ok(await fx.evaluate(`document.getElementById('workDataSubmit').disabled===false`),'validated password pair and chosen folder enable one submit');
 await fx.evaluate(`document.getElementById('workDataSubmit').click();document.getElementById('workDataSubmit').click();true`);ok(!!await fx.waitForEval(`window.__workDataUiFixture.posts.length===1?true:null`),'double click causes one mutation request');
 const receipt=await fx.evaluate(`(()=>{const s=window.__workDataUiFixture,p=document.getElementById('workDataPassword'),q=document.getElementById('workDataPasswordConfirm');return {post:s.posts[0],empty:!p.value&&!q.value,cancelDisabled:document.getElementById('workDataCancel').disabled,mode:document.getElementById('workDataSummary').dataset.mode,storage:[...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>String(v).includes('SYNTH_UI_SECRET_ONLY_123'))};})()`);
 ok(receipt.empty&&!receipt.storage,'both secrets clear after POST and neither storage area contains the password');ok(receipt.post.passwordCorrect&&receipt.post.authority.mode==='plain'&&receipt.post.authority.generation===0&&receipt.post.keys.includes('expectedAuthority'),'POST uses the actual authority and one-time password');ok(receipt.cancelDisabled&&receipt.mode==='plain','handoff does not offer cancellation or declare an encrypted root');
 for(const width of [1440,768,390]){await fx.resize(width,1000);const fit=await fx.evaluate(`(()=>{const w=document.getElementById('workDataSettings'),r=w.getBoundingClientRect();return r.width>0&&w.scrollWidth<=w.clientWidth+2;})()`);ok(fit,'work data panel fits '+width+'px layout');}
 ok(fx.exceptions.length===0,'no uncaught browser errors');
 }catch(error){runner.fail('fatal: '+(error?.stack||error));}finally{if(fx)await fx.close({keepRoot:runner.failures>0});}runner.done({exit:true});})();
