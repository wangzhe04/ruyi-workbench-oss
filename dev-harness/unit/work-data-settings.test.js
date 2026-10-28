'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,authority,job,status,deferred}=require('../lib/work-data-settings-fixture');
const populate=async f=>{f.click('workDataPickBackup');await f.flush();f.change('workDataPassword','a long private password');f.change('workDataPasswordConfirm','a long private password');};
const respond=(route,options)=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}:status();
test('mount once preserves the draft and displays actual authority independently of config mirror',async()=>{
 const f=fixture(()=>status({configMirror:true}));await f.panel.refresh();assert.equal(f.find('workDataSummary').dataset.mode,'plain');f.change('workDataPassword','typed draft');assert.equal(f.mount(),f.panel);await f.flush();assert.equal(f.find('workDataPassword').value,'typed draft');assert.equal(f.host.children.filter(e=>e.id==='workDataHeading').length,1);f.panel.dispose();
 const html=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/index.html'),'utf8');assert.match(html,/id="privacySettings"[^>]*><\/section>\s*<section[^>]*id="workDataSettings"/);
});
test('password confirmation, byte bound, selected existing backup folder and current mode gate real submit',async()=>{
 const f=fixture(respond);await f.panel.refresh();assert.equal(f.find('workDataSubmit').disabled,true);await populate(f);assert.equal(f.find('workDataSubmit').disabled,false);f.change('workDataPasswordConfirm','other');assert.equal(f.find('workDataSubmit').disabled,true);f.change('workDataPassword','密'.repeat(400));f.change('workDataPasswordConfirm','密'.repeat(400));assert.equal(f.find('workDataSubmit').disabled,true);f.change('workDataPassword','short');f.change('workDataPasswordConfirm','short');assert.equal(f.find('workDataSubmit').disabled,true);assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0);f.panel.dispose();
});
test('one actual POST clears both secrets immediately and handoff never reports migration success or offers cancellation',async()=>{
 const hold=deferred(),a=authority();const f=fixture(route=>route==='/api/work-data/jobs'?hold.promise:respond(route));await f.panel.refresh();await populate(f);f.click('workDataSubmit');f.click('workDataSubmit');assert.equal(f.find('workDataPassword').value,'');assert.equal(f.find('workDataPasswordConfirm').value,'');const writes=f.calls.filter(x=>x.route==='/api/work-data/jobs');assert.equal(writes.length,1);assert.deepEqual(writes[0].body.expectedAuthority,a);assert.equal(writes[0].body.password,'a long private password');assert.deepEqual(Object.keys(writes[0].body).sort(),['backupDirectory','expectedAuthority','operation','password']);hold.resolve({ok:true,job:job({state:'handoff',takeover:true,cancellable:false})});await f.flush();assert.equal(f.find('workDataCancel').disabled,true);assert.match(f.find('workDataProgress').textContent,/Handing off/);assert.doesNotMatch(f.find('workDataProgress').textContent,/successfully|completed/i);assert.equal(f.find('workDataSummary').dataset.mode,'plain');f.panel.dispose();
});
test('disable requires explicit plaintext confirmation and sends only the complete expected authority',async()=>{
 const a=authority('encrypted');const f=fixture(route=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}:route==='/api/work-data/jobs'?{ok:true,job:job({operation:'disable'})}:status({authority:a}));await f.panel.refresh();f.change('workDataOperation','disable','change');await populate(f);assert.equal(f.find('workDataSubmit').disabled,true);f.change('workDataConfirmPlaintext',true);assert.equal(f.find('workDataSubmit').disabled,false);f.click('workDataSubmit');await f.flush();const body=f.calls.find(x=>x.route==='/api/work-data/jobs').body;assert.equal(body.confirmPlaintext,true);assert.deepEqual(body.expectedAuthority,a);assert.equal(f.find('workDataConfirmPlaintext').checked,false);f.panel.dispose();
});
// ── restore: one real upload, then one job ───────────────────────────────────
const uploadReady=()=>({capabilities:{worker:true,upload:true,download:false}});
const ticket='e'.repeat(48);
const backupFile=(text='sealed restore package')=>new File([Buffer.from(text)],'restore.ruyi',{type:'application/octet-stream'});
const restoreStatus=extra=>status({...uploadReady(),...extra});
const restoreForm=async f=>{await populate(f);f.change('workDataOperation','restore','change');f.click('workDataPickParent');await f.flush();f.change('workDataRestoreName','Restored');f.change('workDataPassword','a long private password');f.change('workDataPasswordConfirm','a long private password');};
const json=(value,statusCode)=>new Response(JSON.stringify(value),{status:statusCode,headers:{'content-type':'application/json'}});
const restoreAccept=(route,options)=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}
  :route==='/api/work-data/jobs'?{ok:true,job:job({operation:'restore',state:'queued'})}:restoreStatus();
test('restore uploads exactly one real package then submits one complete job with its ticket and target',async()=>{
 const file=backupFile();
 const f=fixture(restoreAccept,()=>json({ok:true,uploadId:ticket},201));
 await f.panel.refresh();await restoreForm(f);
 assert.equal(f.find('workDataUnavailable').hidden,true,'worker+upload are both advertised');
 assert.equal(f.find('workDataSubmit').disabled,true,'a restore without a chosen package cannot be submitted');
 f.selectFile('workDataRestoreFile',file);
 assert.equal(f.find('workDataSubmit').disabled,false);
 f.click('workDataSubmit');f.click('workDataSubmit');
 assert.equal(f.find('workDataPassword').value,'','the password is cleared as soon as submission starts');
 assert.equal(f.find('workDataPasswordConfirm').value,'');
 await f.flush();
 assert.equal(f.rawCalls.length,1,'exactly one upload');
 const raw=f.rawCalls[0];
 assert.equal(raw.route,'/api/work-data/uploads');assert.equal(raw.method,'POST');
 assert.equal(raw.headers['content-type'],'application/octet-stream');
 assert.equal(raw.body,file,'the File itself is the request body (not a JSON projection of it)');
 assert.equal(raw.noTokenReplay,true,'a 403 token refresh must never silently retransmit the package');
 assert.deepEqual(raw.bytes,Buffer.from('sealed restore package'));
 const writes=f.calls.filter(x=>x.route==='/api/work-data/jobs');
 assert.equal(writes.length,1,'exactly one job');
 assert.equal(writes[0].seq>raw.seq,true,'the job is submitted only after the upload returned a ticket');
 assert.equal(writes[0].noTokenReplay,true,'the restore job POST must not be replayed after a 403 token refresh either');
 assert.equal(writes[0].body.operation,'restore');assert.equal(writes[0].body.uploadId,ticket);
 assert.equal(writes[0].body.targetDirectory,'E:\\Synthetic Backup\\Restored');
 assert.equal(writes[0].body.backupDirectory,'E:\\Synthetic Backup');
 assert.equal(writes[0].body.password,'a long private password');
 assert.deepEqual(writes[0].body.expectedAuthority,authority());
 assert.deepEqual(Object.keys(writes[0].body).sort(),['backupDirectory','expectedAuthority','operation','password','targetDirectory','uploadId']);
 assert.equal(f.find('workDataSummary').dataset.mode,'plain');
 f.panel.dispose();
});
test('restore stays refused without the upload capability while export never depends on download',async()=>{
 const f=fixture(route=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}
  :route==='/api/work-data/jobs'?{ok:true,job:job({operation:'export',state:'queued'})}:status(),()=>json({ok:true,uploadId:ticket},201));
 await f.panel.refresh();await restoreForm(f);f.selectFile('workDataRestoreFile',backupFile());
 assert.match(f.find('workDataUnavailable').textContent,/work_data_setup\.restore_unavailable/);
 assert.equal(f.find('workDataSubmit').disabled,true,'restore is refused when upload=false even with a complete form');
 assert.equal(f.find('workDataRestoreFile').disabled,false,'the file picker is disabled only by the ordinary disabled state');
 f.click('workDataSubmit');await f.flush();
 assert.equal(f.rawCalls.length,0,'a refused restore never uploads a package');
 assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0,'and never creates a job');
 f.change('workDataOperation','export','change');await populate(f);
 assert.equal(f.find('workDataUnavailable').hidden,true,'export must not be gated by download=false');
 assert.equal(f.find('workDataSubmit').disabled,false,'export is a backup-directory product, not a download');
 f.click('workDataSubmit');await f.flush();
 const writes=f.calls.filter(x=>x.route==='/api/work-data/jobs');
 assert.equal(writes.length,1);assert.equal(writes[0].body.operation,'export');
 assert.equal(f.calls.filter(x=>/download/.test(x.route)).length,0);
 // The one download entry is the current result's id-scoped route; there is no
 // directory, path or historical-package entry anywhere in the UI.
 const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/js/work-data-settings.js'),'utf8');
 assert.match(source,/\/api\/work-data\/results\/' \+ result\.id \+ '\/package/);
 assert.equal(f.find('workDataDownload').hidden,true,'no current result means no package action is offered');
 assert.equal(f.rawCalls.length,0);
 f.panel.dispose();
 const g=fixture(()=>status({capabilities:{worker:false,upload:true,download:false}}));await g.panel.refresh();assert.match(g.find('workDataUnavailable').textContent,/worker_unavailable/);g.panel.dispose();
});
test('restore requires exactly one non-empty file before any upload happens',async()=>{
 const f=fixture(restoreAccept,()=>json({ok:true,uploadId:ticket},201));
 await f.panel.refresh();await restoreForm(f);
 const submitDisabled=()=>f.find('workDataSubmit').disabled;
 assert.equal(submitDisabled(),true,'no file selected');
 f.selectFile('workDataRestoreFile',new File([],'empty.ruyi',{type:'application/octet-stream'}));
 assert.equal(submitDisabled(),true,'an empty package is not a real restore input');
 f.selectFile('workDataRestoreFile',null);
 assert.equal(submitDisabled(),true,'clearing the picker closes the gate again');
 f.selectFile('workDataRestoreFile',[backupFile(),backupFile()]);
 assert.equal(submitDisabled(),true,'exactly one package, never a second file');
 f.selectFile('workDataRestoreFile',{name:'forged.ruyi'});
 assert.equal(submitDisabled(),true,'an object without a real byte size is not a File');
 f.selectFile('workDataRestoreFile',backupFile());
 assert.equal(submitDisabled(),false);
 f.click('workDataSubmit');await f.flush();
 assert.equal(f.rawCalls.length,1,'only the real File reached the upload route');
 f.panel.dispose();
});
test('an upload 4xx refusal re-enables the form, creates no job and is never retried',async()=>{
 const f=fixture(restoreAccept,()=>json({ok:false,error:{code:'work_data_setup.body_too_large'}},413));
 await f.panel.refresh();await restoreForm(f);f.selectFile('workDataRestoreFile',backupFile());
 f.click('workDataSubmit');await f.flush();
 assert.match(f.find('workDataNotice').textContent,/work_data_setup\.body_too_large/);
 assert.equal(f.find('workDataPassword').disabled,false,'an explicit 4xx refusal allows correction');
 assert.equal(f.find('workDataPassword').value,'');
 assert.equal(f.rawCalls.length,1);assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0,'no job after a refused upload');
 await f.poll();
 assert.equal(f.rawCalls.length,1,'the refused upload is not retried automatically');
 f.panel.dispose();
});
test('upload 5xx, a lost response and a malformed success stay uncertain without a job or a retransmission',async()=>{
 const failures=[
  ()=>json({ok:false,error:{code:'work_data_setup.upload_unavailable'}},503),
  ()=>{throw new TypeError('Failed to fetch');},
  ()=>json({ok:true,uploadId:'not-a-ticket'},201),
  ()=>json({ok:true,uploadId:'E'.repeat(48)},201),
  ()=>json({ok:false,uploadId:ticket},201),
 ];
 for(const [index,failure] of failures.entries()){
  const f=fixture(restoreAccept,failure);
  await f.panel.refresh();await restoreForm(f);f.selectFile('workDataRestoreFile',backupFile());
  f.click('workDataSubmit');await f.flush();
  assert.equal(f.find('workDataPassword').disabled,true,`case ${index}: an unconfirmed upload locks the form`);
  assert.equal(f.rawCalls.length,1,`case ${index}: one upload attempt`);
  assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0,`case ${index}: no job without a ticket`);
  await f.poll();
  assert.equal(f.rawCalls.length,1,`case ${index}: the package is never uploaded twice`);
  assert.equal(f.find('workDataPassword').disabled,true,`case ${index}: still uncertain after a status read`);
  f.panel.dispose();
 }
});
test('a failed restore job never uploads the package a second time',async()=>{
 for(const statusCode of [409,503]){
  let raw=0;
  const f=fixture(route=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}
   :route==='/api/work-data/jobs'?(()=>{throw Object.assign(Error('job refused'),{status:statusCode,code:'work_data_setup.authority_changed'});})():restoreStatus(),
   ()=>{raw+=1;return json({ok:true,uploadId:ticket},201);});
  await f.panel.refresh();await restoreForm(f);f.selectFile('workDataRestoreFile',backupFile());
  f.click('workDataSubmit');await f.flush();
  assert.equal(f.rawCalls.length,1,`${statusCode}: the package is uploaded once`);
  assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,1,`${statusCode}: the job is submitted once`);
  assert.equal(f.find('workDataPassword').disabled,statusCode>=500,`${statusCode}: only a 4xx refusal reopens the form`);
  await f.poll();
  assert.equal(f.rawCalls.length,1,`${statusCode}: a failed job does not re-upload`);
  assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,1,`${statusCode}: and does not resubmit`);
  f.panel.dispose();
 }
});
test('a disconnected write is never retried; read-only polling reconnects to the actual job',async()=>{
 let posted=false;const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs'){posted=true;throw new TypeError('Failed to fetch');}if(route.includes('/jobs/'))return{ok:true,job:job({state:'uncertain',cancellable:false,takeover:true})};return status({job:posted?job({state:'uncertain',cancellable:false,takeover:true}):null});});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();assert.match(f.find('workDataNotice').textContent,/interrupted/);assert.equal(f.find('workDataSubmit').disabled,true);assert.equal(f.find('workDataPassword').disabled,true);await f.poll();await f.poll();assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs'&&x.method==='POST').length,1);assert.equal(f.find('workDataCancel').disabled,true);assert.match(f.find('workDataProgress').textContent,/not yet confirmed/);assert.equal(f.find('workDataSummary').dataset.mode,'plain');f.panel.dispose();
});
test('failed status reads label cached mode as last confirmed and prohibit stale-authority writes',async()=>{
 let fail=false;const f=fixture(route=>{if(fail&&route==='/api/work-data/status')throw new TypeError('Failed to fetch');return respond(route);});await f.panel.refresh();await populate(f);fail=true;await f.panel.refresh();assert.match(f.find('workDataSummary').textContent,/Last confirmed/);assert.equal(f.find('workDataSubmit').disabled,true);f.click('workDataSubmit');assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0);f.panel.dispose();
});
test('cancel uses backend eligibility and a lost cancel receipt cannot cause a repeated cancel write',async()=>{
 const f=fixture(route=>{if(route.endsWith('/cancel'))throw new TypeError('Failed to fetch');if(route.includes('/jobs/'))return{ok:true,job:job()};return status({job:job()});});await f.panel.refresh();assert.equal(f.find('workDataCancel').disabled,false);f.click('workDataCancel');f.click('workDataCancel');await f.flush();assert.equal(f.find('workDataCancel').disabled,true);const cancels=f.calls.filter(x=>x.route.endsWith('/cancel'));assert.equal(cancels.length,1);assert.equal(cancels[0].noTokenReplay,true,'a cancel POST must not be replayed after a 403 token refresh');f.panel.dispose();
});
test('an old maintenance receipt cannot resolve an unknown new submission',async()=>{
 const receipt={id:'d'.repeat(48),phase:'complete'};const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs')throw new TypeError('Failed to fetch');return status({lastResult:receipt});});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();await f.poll();assert.equal(f.find('workDataSubmit').disabled,true);assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,1);assert.match(f.find('workDataNotice').textContent,/interrupted/);f.panel.dispose();
});
test('HTTP 5xx, malformed success and unclassified throws remain uncertain and cannot enable a replacement write',async()=>{
 for(const failure of [Object.assign(Error('server response'),{status:503,code:'work_data_setup.result_unavailable'}),new SyntaxError('truncated success JSON'),Object.assign(Error('unclassified'),{code:'work_data_setup.worker_failed'})]){
  const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs')throw failure;return status();});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();assert.equal(f.find('workDataPassword').disabled,true);await f.poll();assert.equal(f.find('workDataPassword').disabled,true);assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,1);f.panel.dispose();
 }
});
test('an explicit HTTP 4xx refusal allows correction without automatically repeating the request',async()=>{
 const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs')throw Object.assign(Error('refused before acceptance'),{status:409,code:'work_data_setup.authority_changed'});return status();});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();assert.equal(f.find('workDataPassword').disabled,false);assert.equal(f.find('workDataPassword').value,'');assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,1);f.panel.dispose();
});
test('a status response from before cancellation cannot reopen the cancel button or overwrite its receipt',async()=>{
 let delay=false;const held=deferred();const f=fixture(route=>{if(route.endsWith('/cancel'))return{ok:true,job:job({state:'cancel_requested',cancellable:false})};if(route.includes('/jobs/'))return delay?held.promise:{ok:true,job:job()};return status({job:job()});});await f.panel.refresh();delay=true;const read=f.panel.refresh();await f.flush();f.click('workDataCancel');await f.flush();assert.equal(f.find('workDataCancel').disabled,true);held.resolve({ok:true,job:job()});await read;assert.equal(f.find('workDataCancel').disabled,true);assert.match(f.find('workDataProgress').textContent,/cancellation requested/);assert.equal(f.calls.filter(x=>x.route.endsWith('/cancel')).length,1);f.panel.dispose();
});
test('terminal job remains readable by its tracked id after the controller clears active status',async()=>{
 let posted=false;const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs'){posted=true;return{ok:true,job:job({state:'queued'})};}if(route.includes('/jobs/'))return{ok:true,job:job({state:'failed',error:'work_data_setup.worker_failed',cancellable:false})};return status({job:null});});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();assert.equal(posted,true);await f.poll();assert.match(f.find('workDataProgress').textContent,/did not finish/);assert.match(f.find('workDataProgress').textContent,/work_data_setup.worker_failed/);assert.equal(f.find('workDataProgress').hidden,false);f.panel.dispose();
});
test('locale refresh preserves secret draft and all four flat catalogs share the added keys',async()=>{
 const f=fixture(respond);await f.panel.refresh();f.change('workDataPassword','draft only');f.language('zh-CN');assert.equal(f.find('workDataHeading').textContent,'工作数据加密与迁移');assert.equal(f.find('workDataPassword').value,'draft only');f.panel.dispose();assert.equal(f.find('workDataPassword').value,'');const root=path.resolve(__dirname,'../..'),keys=[];for(const family of ['docs/i18n/locales','ruyi-workbench/app/public/locales'])for(const locale of ['zh-CN','en-US']){const catalog=JSON.parse(fs.readFileSync(path.join(root,family,locale+'.json'),'utf8'));keys.push(Object.keys(catalog).filter(k=>k.startsWith('workData.')).sort());}for(const k of keys)assert.deepEqual(k,keys[0]);assert.ok(keys[0].length>35);
});
test('export submits against the chosen backup directory while download stays false',async()=>{
 const f=fixture(route=>route==='/api/pick-folder'?{ok:true,path:'E:\\Synthetic Backup'}:route==='/api/work-data/jobs'?{ok:true,job:job({operation:'export',state:'queued'})}:status());
 await f.panel.refresh();await populate(f);
 f.change('workDataOperation','export','change');await populate(f);
 assert.equal(f.find('workDataSubmit').disabled,false);
 f.click('workDataSubmit');await f.flush();
 const writes=f.calls.filter(x=>x.route==='/api/work-data/jobs');
 assert.equal(writes.length,1);assert.equal(writes[0].body.operation,'export');
 assert.deepEqual(Object.keys(writes[0].body).sort(),['backupDirectory','expectedAuthority','operation','password']);
 assert.equal(writes[0].body.backupDirectory,'E:\\Synthetic Backup');
 assert.match(writes[0].body.backupDirectory,/^[A-Za-z]:\\/,'the export body must carry a real absolute Windows directory, not a swallowed escape');
 assert.equal(f.calls.filter(x=>/download/.test(x.route)).length,0);
 f.panel.dispose();
});
// ── B4: saving the one current recovery package ──────────────────────────────
const packageId='d'.repeat(48),packageBytes=Buffer.from('synthetic recovery package bytes');
const savedResult=()=>({schema:1,id:packageId,operation:'export',state:'verified',finishedAt:'2026-10-24T00:00:00.000Z',
 sourceAuthority:authority(),authority:authority(),
 backup:{path:'E:\\Synthetic Backup\\ruyi-work-data-'+packageId+'.ruyi-backup',bytes:packageBytes.length,sha256:'e'.repeat(64),identity:{dev:'1',ino:'2'}}});
const packageStatus=extra=>status({lastResult:savedResult(),capabilities:{worker:true,upload:false,download:true},...extra});
const packageResponse=()=>new Response(packageBytes,{status:200,headers:{'content-type':'application/octet-stream','content-length':String(packageBytes.length)}});
test('the package action is offered only for the advertised transfer and saves the current result bytes',async()=>{
 const f=fixture(()=>packageStatus(),(route)=>{assert.equal(route,'/api/work-data/results/'+packageId+'/package');return packageResponse();});
 await f.panel.refresh();
 const button=f.find('workDataDownload');
 assert.equal(button.hidden,false,'a current result offers the save action');
 assert.equal(button.disabled,false);
 assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');
 button.click();button.click();await f.flush();
 assert.equal(f.rawCalls.length,1,'one click issues one package request');
 const call=f.rawCalls[0];
 assert.equal(call.method,'GET');assert.equal(call.body,undefined,'a package download sends no request body');
 assert.equal(call.noTokenReplay,false,'a read may refresh an expired token once');
 const anchor=f.created.filter(element=>element.tagName==='A').at(-1);
 assert.ok(anchor,'the bytes are handed to the browser through a download anchor');
 assert.equal(anchor.download,'ruyi-work-data-'+packageId+'.ruyi-backup');
 assert.match(String(anchor.href),/^blob:/);
 assert.equal(anchor.parentNode,null,'the temporary anchor is removed after the click');
 assert.match(f.find('workDataNotice').textContent,/handed to the browser/);
 assert.equal(f.find('workDataPassword').value,'','saving a package never touches the password draft');
 f.panel.dispose();
 // A fresh status without the current result stops offering the action.
 const g=fixture(()=>status({capabilities:{worker:true,upload:false,download:true}}));await g.panel.refresh();
 assert.equal(g.find('workDataDownload').hidden,true,'no result, no package action');
 assert.equal(g.rawCalls.length,0);g.panel.dispose();
});
test('a typed package refusal is shown and a stale status disables the action without a second request',async()=>{
 const refuse=(code,statusCode)=>new Response(JSON.stringify({ok:false,error:{code}}),{status:statusCode,headers:{'content-type':'application/json'}});
 for(const [code,statusCode] of [['work_data_setup.package_unavailable',503],['work_data_setup.package_not_found',404],['work_data_setup.busy',409]]){
  const f=fixture(()=>packageStatus(),()=>refuse(code,statusCode));await f.panel.refresh();
  f.find('workDataDownload').click();await f.flush();
  assert.match(f.find('workDataNotice').textContent,new RegExp(code.replace(/\./g,'\\.')),code+' must be shown to the user');
  assert.equal(f.created.filter(element=>element.tagName==='A').length,0,'a refusal never creates a download');
  assert.equal(f.rawCalls.length,1,'a refused download is not retried automatically');
  assert.equal(f.find('workDataDownload').disabled,false,'an explicit refusal leaves the action available');
  f.panel.dispose();
 }
 // A status read that fails marks the receipt stale and disables the action.
 let fail=false;const f=fixture(route=>{if(fail&&route==='/api/work-data/status')throw new TypeError('Failed to fetch');return packageStatus();});
 await f.panel.refresh();assert.equal(f.find('workDataDownload').disabled,false);
 fail=true;await f.panel.refresh();
 assert.equal(f.find('workDataDownload').disabled,true,'a stale receipt cannot be saved');
 f.find('workDataDownload').click();await f.flush();assert.equal(f.rawCalls.length,0);
 f.panel.dispose();
});
test('a result whose capability is not advertised keeps the package action disabled',async()=>{
 const f=fixture(()=>status({lastResult:savedResult(),capabilities:{worker:true,upload:false,download:false}}));
 await f.panel.refresh();
 assert.equal(f.find('workDataDownload').hidden,false);
 assert.equal(f.find('workDataDownload').disabled,true,'download=false disables the save action');
 f.find('workDataDownload').click();await f.flush();
 assert.equal(f.rawCalls.length,0,'no request is made without the advertised transfer');
 f.panel.dispose();
});
