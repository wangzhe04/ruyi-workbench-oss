#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 151 阶段 3G(150 W3/W4):加密设置面板里的「数据根体检与残留文件」端到端。真 serve、真路由(13ah → 01ac)、
// 隔离数据根(夹具 home),无头浏览器里用真实 DOM 与真键盘:体检只读、计划列出将移动的文件、确认段键盘可达
// (焦点落在「返回」、Esc 只关这一段并把焦点还给触发按钮、Shift+Tab 到「确认移入」再 Enter)、移入后磁盘上
// 原文件确实到了 quarantine-v1/<stamp>/data/ 且字节不变、太新的残留不动、撤销后逐字节回到原处。
// 设 RUYI_SHOT_DIR 时把三张截图(体检结果、确认段、移入后可撤销)落到那个目录供人眼核对。
const fs=require('node:fs'),path=require('node:path');
const {startBrowserFixture}=require('./lib/browser-fixture');
const {createRunner}=require('./lib/harness');
const runner=createRunner('WORK DATA HYGIENE BROWSER'),{ok}=runner;
const LEFTOVERS=['sessions/sess_hygiene.json.corrupt','memory/notes.json.corrupt-1731900000000'],FRESH='sessions/sess_fresh.json.corrupt';
const bytesOf=rel=>'SYNTHETIC LEFTOVER '+rel;
(async()=>{let fx;try{
 fx=await startBrowserFixture({ok,prefix:'ruyi-work-data-hygiene-',width:1280,height:1000,config:{locale:'en-US',stewardEnabledV1:false},
  beforeServe:async f=>{
   const past=new Date(Date.now()-3600000);
   for(const rel of LEFTOVERS){const file=path.join(f.home,...rel.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytesOf(rel));fs.utimesSync(file,past,past);}
   fs.writeFileSync(path.join(f.home,...FRESH.split('/')),'FRESH LEFTOVER');
  }});
 const at=rel=>path.join(fx.home,...rel.split('/')),present=()=>LEFTOVERS.every(rel=>fs.existsSync(at(rel))&&fs.readFileSync(at(rel),'utf8')===bytesOf(rel));
 const shots=process.env.RUYI_SHOT_DIR||'',shoot=async name=>{if(!shots)return;fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,name),await fx.screenshot());};
 // The real route first: read-only, the documented schema, nothing touched.
 const direct=await fx.request('GET','/api/work-data/hygiene');
 const leftovers=direct?.json?.inspection?.verdicts?.find(row=>row.code==='work_data_hygiene.leftovers_present');
 ok(direct?.status===200&&direct.json.ok===true&&direct.json.inspection.schema===1&&leftovers?.params?.count===3,'GET /api/work-data/hygiene reports the three leftovers on the isolated data root ('+JSON.stringify(leftovers?.params?.count)+')');
 ok(present()&&fs.existsSync(at(FRESH)),'the read-only inspection moved nothing');
 const refused=await fx.request('POST','/api/work-data/hygiene/quarantine',{token:'x'});
 ok(refused?.status===400&&refused.json?.error?.code==='work_data_setup.request_invalid'&&present(),'a malformed confirmation is refused with a stable code and moves nothing');

 await fx.evaluate(`document.getElementById('openSettingsBtn').click();document.querySelector('#settingsTabs [data-stab="security"]').click();true`);
 ok(!!await fx.waitForEval(`(()=>{const b=document.getElementById('workDataHygieneInspect');return b&&!b.disabled?true:null;})()`),'the security tab shows the data root check, idle and enabled');
 await fx.evaluate(`document.getElementById('workDataHygiene').scrollIntoView({block:'start'});document.getElementById('workDataHygieneInspect').click();true`);
 ok(!!await fx.waitForEval(`document.getElementById('workDataHygieneVerdicts')?true:null`),'clicking Check data root renders the verdicts');
 const view=await fx.evaluate(`(()=>{const q=id=>document.getElementById(id);return {verdict:q('workDataHygieneVerdicts').textContent,prediction:q('workDataHygienePrediction').textContent,state:q('workDataHygienePrediction').dataset.state,
  summary:q('workDataHygieneSummary').textContent,readOnly:q('workDataHygieneReadOnly').textContent,move:!q('workDataHygieneQuarantine').hidden&&!q('workDataHygieneQuarantine').disabled};})()`);
 ok(/sessions\/sess_hygiene\.json\.corrupt/.test(view.verdict)&&/3 files/.test(view.verdict),'the leftover verdict names the files and their count');
 ok(view.state==='ok'&&/expected to work/.test(view.prediction),'leftovers alone predict that enable/export can proceed');
 ok(/files and \d+ folders/.test(view.summary)&&/no file was changed, moved or deleted/.test(view.readOnly)&&view.move,'size summary, read-only receipt and the move action are shown');
 ok(present(),'the panel inspection moved nothing either');
 await shoot('3g-inspect.png');

 // Plan → confirmation. Focus lands on Back; real Escape closes only this question.
 await fx.evaluate(`document.getElementById('workDataHygieneQuarantine').click();true`);
 ok(!!await fx.waitForEval(`(()=>{const b=document.getElementById('workDataHygieneConfirm');return !b.hidden&&getComputedStyle(b).display!=='none'&&document.activeElement===document.getElementById('workDataHygieneBack')?true:null;})()`),'the move confirmation is visible with keyboard focus on Back');
 const planView=await fx.evaluate(`(()=>({files:[...document.querySelectorAll('#workDataHygieneFiles li')].map(li=>li.textContent),more:document.getElementById('workDataHygieneMore').textContent,title:document.getElementById('workDataHygieneConfirmTitle').textContent}))()`);
 ok(planView.files.length===2&&planView.files.some(text=>text.startsWith('sessions/sess_hygiene.json.corrupt'))&&planView.files.some(text=>text.startsWith('memory/notes.json.corrupt-1731900000000')),'the confirmation lists exactly the two files that will move');
 ok(/changed within the last two minutes/.test(planView.more)&&/Move these 2 files/.test(planView.title),'the recently changed leftover is named as skipped');
 await shoot('3g-confirm.png');
 await fx.escape();
 ok(!!await fx.waitForEval(`(()=>document.getElementById('workDataHygieneConfirm').hidden&&document.activeElement===document.getElementById('workDataHygieneQuarantine')?true:null)()`),'Escape closes the confirmation and returns focus to Move to quarantine');
 ok(await fx.evaluate(`!document.getElementById('settingsModal').classList.contains('hidden')`),'Escape did not close the settings dialog');
 ok(present(),'cancelling moved nothing');

 // Keyboard-only confirmation: Shift+Tab from Back reaches «Move them», Enter confirms.
 await fx.evaluate(`document.getElementById('workDataHygieneQuarantine').click();true`);
 ok(!!await fx.waitForEval(`document.activeElement===document.getElementById('workDataHygieneBack')?true:null`),'reopened confirmation focuses Back again');
 await fx.tab(true);
 ok(await fx.evaluate(`document.activeElement===document.getElementById('workDataHygieneGo')`),'Shift+Tab reaches the confirm button');
 await fx.enter();
 ok(!!await fx.waitForEval(`document.getElementById('workDataHygieneNotice').dataset.state==='ok'&&document.getElementById('workDataHygieneAreasQuarantine')?true:null`),'Enter moves the files and the re-check lists the quarantine area');
 const notice=await fx.evaluate(`document.getElementById('workDataHygieneNotice').textContent`);
 ok(/Moved 2 files into the quarantine area inside the data root/.test(notice)&&/Nothing was deleted/.test(notice),'the receipt says what moved, where, and that nothing was deleted');
 const area=fs.readdirSync(path.join(fx.home,'quarantine-v1')).filter(name=>/^\d{4}-/.test(name));
 ok(area.length===1,'one quarantine area inside the data root');
 const moved=LEFTOVERS.every(rel=>!fs.existsSync(at(rel))&&fs.readFileSync(path.join(fx.home,'quarantine-v1',area[0],'data',...rel.split('/')),'utf8')===bytesOf(rel));
 ok(moved,'both files left their place and sit byte-identical under quarantine-v1/<stamp>/data/');
 ok(fs.readFileSync(at(FRESH),'utf8')==='FRESH LEFTOVER','the recently changed leftover was not moved');
 ok(JSON.parse(fs.readFileSync(path.join(fx.home,'quarantine-v1',area[0],'manifest-v1.json'),'utf8')).state==='moved','the manifest records the finished move');
 await fx.evaluate(`document.getElementById('workDataHygiene').scrollIntoView({block:'start'});true`);
 await shoot('3g-moved.png');

 // Undo through the panel restores every byte.
 ok(await fx.evaluate(`(()=>{const b=document.getElementById('workDataHygieneUndo0');return !!b&&!b.disabled&&b.dataset.stamp===${JSON.stringify(area[0])};})()`),'the moved area offers Undo');
 await fx.evaluate(`document.getElementById('workDataHygieneUndo0').click();true`);
 ok(!!await fx.waitForEval(`/Moved 2 files back/.test(document.getElementById('workDataHygieneNotice').textContent)?true:null`),'Undo reports the files moved back');
 ok(present(),'undo restored both files byte-identical at their original paths');
 ok(JSON.parse(fs.readFileSync(path.join(fx.home,'quarantine-v1',area[0],'manifest-v1.json'),'utf8')).state==='restored','the manifest records the undo');
 ok(!!await fx.waitForEval(`(()=>{const list=document.getElementById('workDataHygieneAreasQuarantine');return list&&/undone/.test(list.textContent)&&!document.getElementById('workDataHygieneUndo0')?true:null;})()`),'the re-check shows the area as undone without a second Undo');

 for(const width of [1280,390]){await fx.resize(width,1000);const fit=await fx.evaluate(`(()=>{const w=document.getElementById('workDataSettings'),r=w.getBoundingClientRect();return r.width>0&&w.scrollWidth<=w.clientWidth+2;})()`);ok(fit,'work data panel with the check fits '+width+'px');}
 ok(fx.exceptions.length===0,'no uncaught browser errors');
 }catch(error){runner.fail('fatal: '+(error?.stack||error));}finally{if(fx)await fx.close({keepRoot:runner.failures>0});}runner.done({exit:true});})();
