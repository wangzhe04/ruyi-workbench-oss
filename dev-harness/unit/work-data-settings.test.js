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
test('closed restore stays unavailable while export no longer depends on any download capability',async()=>{
 const f=fixture(respond);await f.panel.refresh();await populate(f);assert.equal(f.find('workDataUnavailable').hidden,true);
 f.change('workDataOperation','export','change');
 f.change('workDataPassword','a long private password');f.change('workDataPasswordConfirm','a long private password');
 assert.equal(f.find('workDataUnavailable').hidden,true,'export must not be gated by download=false');
 assert.equal(f.find('workDataSubmit').disabled,false,'export is a backup-directory product, not a download');
 assert.equal(f.find('workDataRestoreFile').disabled,true);
 f.change('workDataOperation','restore','change');
 f.change('workDataPassword','a long private password');f.change('workDataPasswordConfirm','a long private password');
 assert.match(f.find('workDataUnavailable').textContent,/work_data_setup\.restore_unavailable/);
 assert.equal(f.find('workDataSubmit').disabled,true,'restore stays refused even with a complete form');
 f.click('workDataSubmit');
 assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0,'a closed restore must not create a job');
 assert.equal(f.find('workDataRestoreFile').disabled,true);
 const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/js/work-data-settings.js'),'utf8');
 assert.doesNotMatch(source,/capabilities\.download|work-data\/download|download\s*=/,'the UI must not add a download entry or dependency');
 f.panel.dispose();
 const g=fixture(()=>status({capabilities:{worker:false,upload:false,download:false}}));await g.panel.refresh();assert.match(g.find('workDataUnavailable').textContent,/worker_unavailable/);g.panel.dispose();
});
test('a disconnected write is never retried; read-only polling reconnects to the actual job',async()=>{
 let posted=false;const f=fixture(route=>{if(route==='/api/pick-folder')return{ok:true,path:'E:\\Synthetic Backup'};if(route==='/api/work-data/jobs'){posted=true;throw new TypeError('Failed to fetch');}if(route.includes('/jobs/'))return{ok:true,job:job({state:'uncertain',cancellable:false,takeover:true})};return status({job:posted?job({state:'uncertain',cancellable:false,takeover:true}):null});});await f.panel.refresh();await populate(f);f.click('workDataSubmit');await f.flush();assert.match(f.find('workDataNotice').textContent,/interrupted/);assert.equal(f.find('workDataSubmit').disabled,true);assert.equal(f.find('workDataPassword').disabled,true);await f.poll();await f.poll();assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs'&&x.method==='POST').length,1);assert.equal(f.find('workDataCancel').disabled,true);assert.match(f.find('workDataProgress').textContent,/not yet confirmed/);assert.equal(f.find('workDataSummary').dataset.mode,'plain');f.panel.dispose();
});
test('failed status reads label cached mode as last confirmed and prohibit stale-authority writes',async()=>{
 let fail=false;const f=fixture(route=>{if(fail&&route==='/api/work-data/status')throw new TypeError('Failed to fetch');return respond(route);});await f.panel.refresh();await populate(f);fail=true;await f.panel.refresh();assert.match(f.find('workDataSummary').textContent,/Last confirmed/);assert.equal(f.find('workDataSubmit').disabled,true);f.click('workDataSubmit');assert.equal(f.calls.filter(x=>x.route==='/api/work-data/jobs').length,0);f.panel.dispose();
});
test('cancel uses backend eligibility and a lost cancel receipt cannot cause a repeated cancel write',async()=>{
 const f=fixture(route=>{if(route.endsWith('/cancel'))throw new TypeError('Failed to fetch');if(route.includes('/jobs/'))return{ok:true,job:job()};return status({job:job()});});await f.panel.refresh();assert.equal(f.find('workDataCancel').disabled,false);f.click('workDataCancel');f.click('workDataCancel');await f.flush();assert.equal(f.find('workDataCancel').disabled,true);assert.equal(f.calls.filter(x=>x.route.endsWith('/cancel')).length,1);f.panel.dispose();
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
