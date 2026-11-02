'use strict';
// Real encrypted source/export → actual settings/File restore. Only the native
// folder picker is substituted; no synthetic encrypted recovery package exists.
require('./lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),upload=require('./work-data-production-upload.e2e');
const restore=require('./work-data-production-restore.e2e'),plainBrowser=require('./work-data-production-restore.browser.e2e');
const {attachProductionBrowser,safeFailure}=require('./lib/work-data-production-browser-attach');
const {releaseEnvironment}=require('./lib/release-checks'),{snapshotProcessTable,ownDescendants}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const SOURCE_ID='sess_restore_synthetic',PAYLOAD_ID='sess_encrypted_browser_payload';
const BODY_TERM='M3EncryptedBodyOnly20261101',BODY='Nonempty synthetic restored message '+BODY_TERM+' 已认证正文。';
const ENABLE_PASSWORD='SYNTHETIC encrypted browser enable 2026',EXPORT_PASSWORD='SYNTHETIC encrypted browser export only 2026';
function bindTarget(){
 const original=plainBrowser.bindTarget(),extra=core.read(__filename).row;
 const files=[...original.boundFiles.filter(row=>core.norm(row.file)!==core.norm(extra.file)),extra];
 const digest=()=>core.H(Buffer.from(JSON.stringify(files.map(row=>({file:core.norm(row.file),bytes:row.bytes,sha256:row.sha256})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0))));
 const executionInputSha256=digest();
 return{...original,boundFiles:files,executionInputSha256,recheck(){original.recheck();core.read(extra.file,extra);assert.equal(digest(),executionInputSha256);return{sameInputs:true,files:files.length,executionInputSha256,browserAssetsPinned:true};}};
}
function seed(f){
 const configFile=path.join(f.base,'config.json'),config=core.json(configFile);assert.equal(config.locale,'en-US');
 config.onboarding={completedAt:'2026-11-01T00:00:00.000Z',version:1,skipped:false};fs.writeFileSync(configFile,JSON.stringify(config));
 const head={id:PAYLOAD_ID,title:'Encrypted restored message fixture',cwd:'',createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:01.000Z',
  messages:[{id:'msg_encrypted_browser_user',role:'user',content:BODY},{id:'msg_encrypted_browser_assistant',role:'assistant',content:'Acknowledged synthetic restored body.'}]};
 assert.equal(head.title.includes(BODY_TERM),false,'query exists in body only');fs.writeFileSync(path.join(f.base,'sessions',PAYLOAD_ID+'.json'),JSON.stringify(head),{flag:'wx'});
 return head;
}
async function preparePackage(w,f,initial,recovery){
 const enable=await w.runMaintenanceRound(f,initial,{phase:'encrypted-browser-enable',operation:'enable',
  body:({source})=>({operation:'enable',password:ENABLE_PASSWORD,expectedAuthority:source,backupDirectory:f.backups}),
  verify:async({status,jobId,source})=>{
   w.assertCapabilities(status,'encrypted browser enable',true);assert.equal(status.job,null);
   const saved=status.lastResult;assert.equal(saved.id,jobId);assert.equal(saved.operation,'enable');assert.equal(saved.state,'published');
   assert.deepEqual(saved.sourceAuthority,source);assert.equal(saved.authority.generation,source.generation+1);assert.equal(saved.authority.mode,'encrypted');
   assert.deepEqual(status.authority,saved.authority);assert.equal(status.configMirror,true);w.assertNoIntent(f,'encrypted browser enable');
   w.checked('the same real product enabled the source and served its encrypted successor');return{};
  }});
 const exported=await w.runMaintenanceRound(f,enable.next,{phase:'encrypted-browser-export',operation:'export',
  body:({source})=>({operation:'export',password:EXPORT_PASSWORD,expectedAuthority:source,backupDirectory:f.backups}),
  verify:async({status,jobId,source})=>{
   w.assertCapabilities(status,'encrypted browser export',true);assert.equal(status.job,null);
   const saved=status.lastResult;assert.equal(saved.id,jobId);assert.equal(saved.operation,'export');assert.equal(saved.state,'verified');
   assert.deepEqual(saved.authority,source);assert.deepEqual(saved.sourceAuthority,source);assert.equal(source.mode,'encrypted');w.assertNoIntent(f,'encrypted browser export');
   return{backup:{...saved.backup}};
  }});
 const backup=exported.next.status.lastResult.backup,captured=core.read(backup.path);
 assert.equal(captured.row.sha256,backup.sha256);assert.equal(captured.bytes.length,backup.bytes);
 assert.ok(captured.bytes.length>0&&captured.bytes.length<=1024*1024,'real export must fit the unchanged browser1MiB bound');
 assert.equal(recovery.inspectSealed(captured.bytes.toString('utf8')),true);
 const opened=await recovery.open(captured.bytes.toString('utf8'),EXPORT_PASSWORD);
 try{
  assert.equal(opened.snapshot.generation,exported.next.status.authority.generation);assert.ok(opened.snapshot.keys.length>=1,'real encrypted export has its own masters');
  const prefix='.work-data/generations/'+exported.next.status.authority.id+'/';
  assert.ok(opened.snapshot.files.some(row=>row.path===prefix+'work-data-key-v1.json'));
  assert.ok(opened.snapshot.files.some(row=>row.path===prefix+'sessions/'+PAYLOAD_ID+'.json'),'real export includes the encrypted nonempty session head');
  assert.ok(opened.snapshot.auxiliaries.some(row=>row.type==='skill-backup-portable'));
 }finally{opened.release();}
 w.record({kind:'encrypted-browser-real-export',source:'actual enable then actual export result.backup.path',file:captured.row.file,bytes:captured.row.bytes,sha256:captured.row.sha256,authority:exported.next.status.authority,packageBuiltByPureSeal:false});
 w.checked('the actual export backup carries encrypted data and independent masters, with a distinct package password');
 return{enable,exported,sealed:captured.bytes,packageFile:backup.path,packageRow:captured.row};
}
async function verifyHandoff({w,f,facts,sealed,jobId,markers}){
 assert.equal(facts.uploads.length,1);assert.equal(facts.jobs.length,1);assert.equal(facts.folderChoices.length,2);
 const observed=facts.uploads[0],id=observed.accepted.uploadId,received=observed.receiver;
 assert.equal(observed.status,201);assert.equal(facts.jobs[0].status,202);assert.equal(facts.jobs[0].accepted.id,jobId);
 assert.equal(received.source,'receiver-custody-readback');assert.equal(received.uploadId,id);assert.equal(received.bytes,sealed.length);assert.equal(received.sha256,core.H(sealed));
 assert.equal(facts.jobs[0].body.uploadId,id);assert.equal(facts.jobs[0].body.passwordMatched,true);
 if(observed.body){assert.equal(observed.body.bytes,sealed.length);assert.equal(observed.body.sha256,core.H(sealed));}
 else{assert.equal(observed.body,null);assert.equal(observed.postData.unavailableReason,'cdp-file-body-not-exposed');}
 const custody=w.custodyWithUpload(f,id),disk=core.read(path.join(custody.dir,'restore-upload-'+id+'.sealed'),received.row);
 try{core.samePinned(disk.row,received.row);assert.ok(disk.bytes.equals(sealed));}finally{disk.bytes.fill(0);}
 const marker=markers.get(id);assert.ok(marker);const current=core.read(marker.row.file,marker.row);current.bytes.fill(0);
 const names=fs.readdirSync(custody.dir).filter(name=>/^handoff-[a-f0-9]{48}-[a-f0-9]{64}\.json$/.test(name));assert.equal(names.length,1);
 const raw=core.read(path.join(custody.dir,names[0]));let handoff;try{handoff=JSON.parse(raw.bytes);}finally{raw.bytes.fill(0);}
 assert.equal(handoff.schema,1);assert.equal(handoff.jobId,jobId);assert.equal(handoff.uploadId,id);
 assert.equal(core.norm(handoff.base),core.norm(f.base));assert.equal(core.norm(handoff.root),core.norm(custody.dir));assert.equal(core.norm(handoff.file),core.norm(received.row.file));
 assert.equal(handoff.bytes,sealed.length);assert.equal(handoff.sha256,core.H(sealed));assert.deepEqual(handoff.identity,{dev:received.row.dev,ino:received.row.ino});
 assert.deepEqual(handoff.marker,{dev:marker.row.dev,ino:marker.row.ino,sha256:marker.row.sha256});assert.equal(handoff.rootNonce,marker.value.nonce);
 const stat=fs.lstatSync(custody.dir,{bigint:true});assert.deepEqual(handoff.rootIdentity,{dev:String(stat.dev),ino:String(stat.ino)});
 return{id,receiverSha256:received.sha256};
}
async function assertOwners(w,f,target,ownership){
 let held=false;try{const lease=await ownership.acquire([await ownership.canonicalRoot(target)]);await lease.release();}
 catch(error){held=/DATA_ROOT_IN_USE/.test(String(error?.code||error?.message||''));if(!held)throw error;}assert.equal(held,true,'encrypted target has the real OS owner');
 const source=await ownership.acquire([await ownership.canonicalRoot(f.base)]);assert.ok(source);await source.release();w.healthy();
}
async function assertActivationConsumed(w,f,target,ownership){
 const canonical=await ownership.canonicalRoot(target),file=path.join(f.temp,'ruyi-work-data-activation-'+core.H(Buffer.from(canonical,'utf8')),'activation-v1.json'),deadline=Date.now()+25000;
 while(fs.existsSync(file)){w.healthy();if(Date.now()>=deadline)throw Error('activation consumption deadline');await new Promise(resolve=>setTimeout(resolve,25));}
 assert.equal((await w.claimApi(f.temp).activation.inspect({base:canonical})).present,false);
}
async function runActual(argv=process.argv.slice(2)){
 assert.equal(argv.length,0,'permanent encrypted browser entry uses the complete current product');
 const runner=require('./lib/harness').createRunner('WORK DATA ENCRYPTED RESTORE BROWSER');
 if(process.platform!=='win32'){console.log('SKIP Windows encrypted native browser restore');runner.done();return;}
 assert.equal(Number(process.versions.node.split('.')[0]),24);
 const target=bindTarget(),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-encrypted-browser-restore-')),evidence=path.join(root,'evidence');fs.mkdirSync(evidence);
 const w=restore.createWorld({root,evidence,target,harness:__dirname,releaseEnvironment,snapshotProcessTable,ownDescendants,getFreePort});
 w.openJournal();let browser=null,submissionStarted=false,packageBytes=null;
 try{
  w.record({kind:'fixture-owner',root,inputFiles:target.boundFiles,executionInputSha256:target.executionInputSha256,nativeFolderDialogSubstituted:true,workDataHttpSubstituted:false,scope:'One nonempty synthetic encrypted-browser restore; not all families, attachments, complete index or whole3.1.'});
  w.ctx.phase='encrypted-browser-source';const f=w.fixture('encrypted-browser');seed(f);
  const port=await getFreePort('127.0.0.1'),handle=w.spawnServe(f,'encrypted-browser-initial-serve',port);await handle.spawned;
  const initial=await w.readyWarm(handle,f);await w.manager.captureNativeBirths(handle);await w.waitWorkerReady(initial);
  const recovery=upload.loadPure(core.read(path.join(target.src,'01t-work-data-recovery.js')).bytes.toString('utf8'),'WorkDataRecovery');
  const prepared=await preparePackage(w,f,initial,recovery);packageBytes=prepared.sealed;
  const ref=prepared.exported.next;
  // Deliberate source divergence happens after export, before restore admission.
  const request=(url,bytes,options={})=>upload.makeHttp(ref,url,bytes,{...options,guard:w.healthy,timeout:restore.BUDGET.request});
  const sentinel=await request('/api/sessions',Buffer.from(JSON.stringify({title:'Encrypted browser source-only sentinel'})),{method:'POST',headers:{'content-type':'application/json'}});
  assert.equal(sentinel.status,200);assert.equal(sentinel.value?.ok,true);const sentinelId=sentinel.value.session.id;assert.match(sentinelId,/^[A-Za-z0-9_-]{1,64}$/);
  for(const id of [SOURCE_ID,PAYLOAD_ID]){const deleted=await request('/api/sessions/'+encodeURIComponent(id),undefined,{method:'DELETE'});assert.equal(deleted.status,200);assert.equal(deleted.value?.ok,true);}
  const sourceIds=await w.sessionIds(ref);assert.ok(sourceIds.includes(sentinelId));for(const id of [SOURCE_ID,PAYLOAD_ID])assert.equal(sourceIds.includes(id),false);
  const ready=await w.waitWorkerReady(ref);assert.deepEqual(ready.authority,ref.status.authority,'post-export real session mutations preserve the exact authority');
  const targetDirectory=path.join(f.targets,'restored-encrypted-browser'),expectedJob={operation:'restore',password:EXPORT_PASSWORD,expectedAuthority:ready.authority,backupDirectory:f.backups,targetDirectory},markers=new Map();
  const prePreference=w.assertBootRootPreferenceAbsent(f,'encrypted-browser');
  core.read(prepared.packageFile,prepared.packageRow).bytes.fill(0);
  browser=await attachProductionBrowser({harness:__dirname,root,url:'http://127.0.0.1:'+ref.port+'/',directories:[f.backups,f.targets],selectedBytes:prepared.sealed,expectedJob,record:w.record,guard:w.healthy,
   captureReceivedUpload:id=>{
    const custody=w.custodyWithUpload(f,id),captured=core.read(path.join(custody.dir,'restore-upload-'+id+'.sealed'));
    try{const marker=core.read(path.join(custody.dir,'restore-upload-owner.json'));try{const value=JSON.parse(marker.bytes);assert.equal(value.schema,1);assert.equal(core.norm(value.base),core.norm(f.base));assert.equal(core.norm(value.root),core.norm(custody.dir));assert.match(value.nonce,/^[a-f0-9]{64}$/);markers.set(id,{row:marker.row,value});}finally{marker.bytes.fill(0);}return captured;}catch(error){captured.bytes.fill(0);throw error;}
   }});
  await browser.prepare({packageFile:prepared.packageFile,targetName:path.basename(targetDirectory)});
  core.read(prepared.packageFile,prepared.packageRow).bytes.fill(0);
  w.checked('actual settings selects the same real export file and only native folder pickers are substituted');
  const ownership=upload.loadPure(core.read(path.join(target.src,'01g-server-ownership.js')).bytes.toString('utf8'),'ServerOwnership');
  const round=await w.runMaintenanceRound(f,ref,{phase:'encrypted-browser-restore',operation:'restore',targetDirectory,
   protected:['.work-data/active-v1.json','.work-data/generations/'+ready.authority.id+'/work-data-key-v1.json'],
   body:({source})=>({...expectedJob,expectedAuthority:source}),
   submit:async(_ref,body)=>{assert.deepEqual(body.expectedAuthority,expectedJob.expectedAuthority);submissionStarted=true;return browser.submit();},
   verify:async({next,status,jobId,source})=>{
    w.assertCapabilities(status,'encrypted browser target',true);assert.equal(status.authority.mode,'encrypted');assert.equal(status.configMirror,true);assert.deepEqual(status.authority,source);assert.equal(status.job,null);assert.notEqual(status.lastResult?.id,jobId);
    w.assertTargetAuthority({target:targetDirectory,authority:status.authority,label:'encrypted browser target'});
    const result=w.assertRestoreResult({f,id:jobId,targetPath:targetDirectory,source,uploaded:prepared.sealed});
    const started=await w.assertStartedTarget({target:targetDirectory,sealed:prepared.sealed,password:EXPORT_PASSWORD,label:'encrypted browser target',successor:next,encrypted:true});
    const ids=await w.sessionIds(next);for(const id of [SOURCE_ID,PAYLOAD_ID])assert.ok(ids.includes(id));assert.equal(ids.includes(sentinelId),false);
    w.assertNoIntent(f,'encrypted browser target');await assertActivationConsumed(w,f,targetDirectory,ownership);await assertOwners(w,f,targetDirectory,ownership);
    const preference=await w.readBootRootPreference({f,target:targetDirectory,authority:status.authority,resultId:jobId,resultSha256:result.row.sha256,name:'encrypted-browser',notBefore:prePreference.at});
    const facts=await browser.assertTargetServing(targetDirectory),handoff=await verifyHandoff({w,f,facts,sealed:prepared.sealed,jobId,markers});
    w.checkpoint('encrypted-browser-network',facts);
    w.checked('one real201 and202 bind the export File, complete receiver and native handoff to the encrypted committed target');
    const readable=await browser.assertReadableRestoredSession({sessionId:PAYLOAD_ID,bodyTerm:BODY_TERM});
    w.checked('actual body-only search and message DOM read the nonempty restored encrypted session');
    return{result,started,preference,readable,handoff,ids,sourcePins:w.sourcePins(f,['.work-data/active-v1.json','.work-data/generations/'+source.id+'/work-data-key-v1.json'])};
   }});
  const browserClosed=await browser.close();browser=null;
  await w.waitWorkerReady(round.next);
  const sourceServe=await w.runSourceServeCheck({f,target:targetDirectory,targetRef:round.next,packagePaths:round.verified.started.packagePaths,expectedAuthority:ready.authority,jobId:round.jobId,expectPresent:[sentinelId],expectAbsent:[SOURCE_ID,PAYLOAD_ID],label:'encrypted-browser'});
  for(const pin of round.verified.sourcePins)core.samePinned(core.read(path.join(f.base,...pin.relative.split('/'))).row,pin.row);
  core.samePinned(core.read(round.verified.result.resultPath).row,round.verified.result.row);core.samePinned(core.read(round.verified.preference.file).row,round.verified.preference.row);
  await w.reclaimSuccessor('encrypted-browser-target',round.next);
  const preferenceBoots=[];for(const label of ['encrypted-browser-preference-1','encrypted-browser-preference-2']){
   preferenceBoots.push(await w.runPreferenceBoot({f,label,target:targetDirectory,expectedAuthority:ready.authority,jobId:round.jobId,expectPresent:[SOURCE_ID,PAYLOAD_ID],expectAbsent:[sentinelId],preference:round.verified.preference}));
   core.samePinned(core.read(round.verified.preference.file).row,round.verified.preference.row);
  }
  core.samePinned(core.read(round.verified.result.resultPath).row,round.verified.result.row);
  core.read(prepared.packageFile,prepared.packageRow).bytes.fill(0);
  for(const pin of round.verified.sourcePins)core.samePinned(core.read(path.join(f.base,...pin.relative.split('/'))).row,pin.row);
  w.checked('two ordinary serves without root overrides select the restored encrypted target and keep exact boot preference');
  const after=target.recheck();assert.equal(w.manager.hasUnclosed(),false);assert.equal(w.manager.hasUnverifiedSpawn(),false);assert.equal(w.ctx.unknown,false);
  w.checkpoint('result',{schema:1,passed:w.ctx.checks.length,checks:w.ctx.checks,inputProof:after,authority:ready.authority,sourceResultId:round.jobId,export:{bytes:prepared.packageRow.bytes,sha256:prepared.packageRow.sha256},browserClosed,readable:round.verified.readable,preferenceBoots,sourceSessions:sourceServe.ids,exactlyOneUpload:true,exactlyOneRestoreJob:true,nativeFolderDialogSubstituted:true,workDataHttpSubstituted:false,retainedPlaintext:'Synthetic pre-enable legacy originals and historical representations remain; this batch proves active encrypted reads and authenticated package transport, not erasure.',allFamiliesComplete:false,attachmentsVerified:false,fullIndexMatrixComplete:false,whole3_1Complete:false});
  for(const label of w.ctx.checks)runner.ok(true,label);w.close();console.log('Retained synthetic encrypted browser restore evidence '+root);runner.done();
 }catch(error){
  const phase=w.ctx.phase;let browserFailure=browser?.failureDiagnostic()||error.browserFailure||null;
  if(browser){try{browserFailure={...browserFailure,cleanup:await browser.close({failure:true})};}catch(cleanupError){browserFailure={...browserFailure,cleanupFailure:safeFailure(cleanupError)};}}
  w.latch(error);const diagnosis={schema:1,phase,error:safeFailure(w.ctx.failure||error),submissionStarted,nativeUnknown:w.ctx.unknown,browser:browserFailure,rawBodiesPasswordsAndTokensOmitted:true};
  try{const fd=fs.openSync(path.join(evidence,'failure-summary.json'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(diagnosis,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
  try{console.error('ENCRYPTED-BROWSER-DIAG '+JSON.stringify({root,...diagnosis}));}catch{}
  try{w.close();}catch{}process.exit(1);
 }finally{packageBytes?.fill(0);}
}
module.exports={bindTarget,preparePackage,verifyHandoff,runActual};
if(require.main===module)runActual().catch(error=>{console.error('ENCRYPTED-BROWSER-DIAG '+JSON.stringify(safeFailure(error)));process.exitCode=1;});

