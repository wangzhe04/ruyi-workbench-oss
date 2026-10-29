'use strict';
// ROOT SERIAL / Windows Node24. Constructed C11 crash windows using actual
// production enable/disable results, generations and packages, then actual
// owner/native-flush/control/claim modules and abnormal producer death. This is
// not a captured natural cold-worker crash or a rerun of 01ad's lost equivalence
// maps. C10/no result remains unknown. Ordinary files and settled empty special
// stores only; no whole M3-3/3.1 or package release claim.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),restore=require('./work-data-production-restore.e2e'),upload=require('./work-data-production-upload.e2e');
const {bindTarget,createProducer,sourceProof,safeProducerError}=require('./lib/work-data-owned-claim-fixture');
const {releaseEnvironment}=require('./lib/release-checks'),{snapshotProcessTable,ownDescendants}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const PASSWORD='SYNTHETIC C11 result revalidation only 2026',SESSION='sess_restore_synthetic';
const normalized=value=>JSON.parse(JSON.stringify(value));
async function runActual(argv=process.argv.slice(2)){
 assert.equal(argv.length,0);const runner=require('./lib/harness').createRunner('WORK DATA COMPLETED INTENT RECOVERY');
 if(process.platform!=='win32'){console.log('SKIP Windows native completed-intent recovery');runner.done();return;}
 assert.equal(Number(process.versions.node.split('.')[0]),24);require('./lib/self-isolate-home');
 const target=bindTarget(__dirname,__filename),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-c11-recovery-')),evidence=path.join(root,'evidence');fs.mkdirSync(evidence);
 const w=restore.createWorld({root,evidence,target,harness:__dirname,releaseEnvironment,snapshotProcessTable,ownDescendants,getFreePort}),producers=[];w.openJournal();
 const output=label=>({stdout:fs.readFileSync(path.join(evidence,label+'-stdout.log'),'utf8'),stderr:fs.readFileSync(path.join(evidence,label+'-stderr.log'),'utf8')});
 const side=f=>({backups:core.inventory(f.backups,{directoryMetadata:true}),targets:core.inventory(f.targets,{directoryMetadata:true}),
  temp:fs.readdirSync(f.temp).filter(name=>/^ruyi-work-data-(?:upload|activation)-/.test(name)).sort().map(name=>({name,tree:core.inventory(path.join(f.temp,name),{directoryMetadata:true})})),
  preference:fs.existsSync(path.join(f.home,'.ruyi','boot-root-v1.json'))?core.read(path.join(f.home,'.ruyi','boot-root-v1.json')).row:null});
 const snapshot=f=>({source:core.inventory(f.base,{directoryMetadata:true}),claim:core.inventory(path.dirname(w.claimFile(f)),{directoryMetadata:true}),side:side(f)});
 function assertRetiredTree(before,after,removed,changedDirectory){
  assert.deepEqual(after.files,before.files.filter(row=>row.file.toLowerCase()!==removed.toLowerCase()));
  assert.equal(after.directories.length,before.directories.length);
  for(let index=0;index<before.directories.length;index++){
   const old=before.directories[index],now=after.directories[index];
   if(old.file.toLowerCase()!==changedDirectory.toLowerCase()){assert.deepEqual(now,old);continue;}
   for(const key of Object.keys(old)){
    if(key==='mtimeNs'||key==='ctimeNs')continue; // This exact parent directory lost one named entry.
    assert.deepEqual(now[key],key==='entries'?old.entries.filter(name=>name.toLowerCase()!==path.basename(removed).toLowerCase()):old[key]);
   }
  }
 }
 async function doctor(f,label,{success,saved,produced}={}){
  w.ctx.phase=label;const before=snapshot(f),handle=w.spawnCli(f,label,['doctor','--recover-work-data-intent']);
  await handle.spawned;const ended=await w.manager.waitClose(handle,180000),observed=output(label);
  if(!success){
   assert.deepEqual(ended,{code:1,signal:null});assert.equal(observed.stdout.trim(),'');
   assert.match(observed.stderr,/work_data(?:_[a-z0-9]+)*\.[a-z0-9_.]+/);
   await w.manager.certifyExpectedRefusal(handle,async()=>assert.deepEqual(snapshot(f),before));
   w.checked(label+': real doctor refuses without changing complete source, claim or side inventories');return;
  }
  assert.deepEqual(ended,{code:0,signal:null});assert.equal(observed.stderr,'');const lines=observed.stdout.trim().split(/\r?\n/);assert.equal(lines.length,1);
  const dto=JSON.parse(lines[0]);assert.equal(dto.kind,'completed-intent-recovery');assert.equal(dto.schema,1);assert.equal(dto.id,saved.id);
  assert.equal(dto.completionEvidence,'existing-durable-result');assert.equal(dto.intentRetired,true);assert.equal(dto.claimRetired,true);assert.equal(dto.currentSourceReadable,true);assert.equal(dto.sourceProofPhase,'before-intent-retirement');
  assert.deepEqual(dto.authority,normalized(saved.authority));assert.deepEqual(dto.sourceProof,sourceProof(produced.canonical,before.source));
  for(const key of ['bytes','files','directories'])assert.ok(Number.isSafeInteger(dto.sourceProof[key])&&dto.sourceProof[key]>=0);
  const after=snapshot(f),intentFile=path.join(f.base,'.work-data','maintenance-v1.json');
  assertRetiredTree(before.source,after.source,intentFile,path.dirname(intentFile));assertRetiredTree(before.claim,after.claim,w.claimFile(f),path.dirname(w.claimFile(f)));assert.deepEqual(after.side,before.side);
  assert.equal((await w.claimApi(f.temp).inspect({base:produced.canonical})).present,false);
  await w.manager.certifyNaturalExit(handle,{code:0,signal:null,verify:async()=>assert.equal(fs.existsSync(intentFile),false)});
  w.checkpoint(label+'-proof',{dto,before,after,originalClaim:produced.claimRaw.row,constructedCrashWindow:true,maintenanceReplayed:false});
  w.checked(label+': real doctor retires only exact complete intent and owned claim after full source/result verification');
 }
 try{
  w.record({kind:'fixture-owner',root,constructedCrashWindow:true,inputFiles:target.boundFiles,executionInputSha256:target.executionInputSha256});
  for(const operation of ['enable','disable']){
   const f=w.fixture(operation),initialHandle=w.spawnServe(f,operation+'-initial',await getFreePort('127.0.0.1'));await initialHandle.spawned;
   const initial=await w.readyWarm(initialHandle,f);await w.manager.captureNativeBirths(initialHandle);await w.waitWorkerReady(initial);
   // The fixture intentionally starts with a legacy inline-message session.
   // Complete its normal first-read migration before taking any C11 baseline.
   const legacy=core.read(path.join(f.base,'sessions',SESSION+'.json')),firstRead=await upload.makeHttp(initial,'/api/sessions/'+SESSION,undefined,{guard:w.healthy});
   assert.equal(firstRead.status,200);assert.equal(firstRead.value?.session?.id,SESSION);
   const {messages,...originalSession}=JSON.parse(legacy.bytes);assert.deepEqual(messages,[]);
   const expectedSession={...originalSession,schemaVersion:1,turnSeq:0,attachments:[],todos:[],mission:null,skills:[],memories:[],memoriesExplicit:false,memoryExclusions:[],storageVersion:2,messageCount:0,providerHistoryCount:0};
   assert.deepEqual(core.read(path.join(f.base,'sessions',SESSION+'.json')).bytes,Buffer.from(JSON.stringify(expectedSession,null,2)));
   for(const kind of ['messages','provider'])assert.equal(core.read(path.join(f.base,'sessions',SESSION+'.'+kind+'.ndjson')).row.bytes,0);
   w.checkpoint(operation+'-legacy-normalized',{legacy:legacy.row,normalized:core.read(path.join(f.base,'sessions',SESSION+'.json')).row});
   let current=initial,last;
   for(const op of operation==='enable'?['enable']:['enable','disable']){
    last=await w.runMaintenanceRound(f,current,{phase:operation+'-seed-'+op,operation:op,
     body:({source})=>({operation:op,password:PASSWORD,expectedAuthority:source,backupDirectory:f.backups,...(op==='disable'?{confirmPlaintext:true}:{})}),
     verify:async({status,jobId})=>{assert.equal(status.lastResult.id,jobId);assert.equal(status.lastResult.operation,op);assert.equal(status.lastResult.state,'published');w.assertNoIntent(f,operation+' seed '+op);return{};}});
    current=last.next;
   }
   const saved=normalized(current.status.lastResult);await w.reclaimSuccessor(operation+'-seed',current);assert.equal(await w.absentByCim(initial.identity),true);
   const headerFile=path.join(f.base,'.work-data','generations',saved.authority.id,'work-data-key-v1.json'),header=core.read(headerFile);
   const completeIntent={schema:1,id:saved.id,operation,phase:'complete',createdAt:new Date(Date.parse(saved.finishedAt)-2000).toISOString(),expectedAuthority:saved.sourceAuthority,
    backup:{path:saved.backup.path,sha256:saved.backup.sha256},candidate:{id:saved.authority.id,mode:saved.authority.mode,headerSha256:header.row.sha256}};
   const producer=createProducer({world:w,target,harness:__dirname,root,evidence,label:operation+'-producer'});producers.push(producer);
   const produced=await producer.run({f,parent:initial,id:saved.id,operation,ownedAt:saved.finishedAt,completeIntent});producer.assertClosed();assert.equal(produced.owned.completeIntentConstructed,true);
   const resultFile=path.join(f.base,'.work-data','maintenance-result-v1.json'),result=core.read(resultFile),backup=core.read(saved.backup.path);
   if(operation==='enable'){
    // Fault baselines begin after each deliberate fixture injection. Restoration
    // is done by the fixture, retaining original identities where available.
    const heldResult=path.join(root,'c10-original-result.held');fs.renameSync(resultFile,heldResult);const heldPin=core.read(heldResult);
    assert.equal(heldPin.row.dev,result.row.dev);assert.equal(heldPin.row.ino,result.row.ino);assert.deepEqual(heldPin.bytes,result.bytes);
    try{await doctor(f,'c10-no-result');core.samePinned(core.read(heldResult).row,heldPin.row);}finally{fs.renameSync(heldResult,resultFile);}
    const mismatch={...JSON.parse(result.bytes),operation:'export',state:'verified',sourceAuthority:saved.authority};
    fs.writeFileSync(resultFile,JSON.stringify(mismatch));try{await doctor(f,'c11-operation-mismatch');}finally{fs.writeFileSync(resultFile,result.bytes);}
    fs.writeFileSync(saved.backup.path,Buffer.alloc(backup.bytes.length,0x58));try{await doctor(f,'c11-bad-backup');}finally{fs.writeFileSync(saved.backup.path,backup.bytes);}
    fs.renameSync(headerFile,headerFile+'.held');try{await doctor(f,'c11-missing-key');}finally{fs.renameSync(headerFile+'.held',headerFile);}
    const stage=path.join(f.base,'.work-data','.maintenance-v1.stage-unknown');fs.writeFileSync(stage,'SYNTHETIC STAGE',{flag:'wx'});try{await doctor(f,'c11-stage');}finally{fs.unlinkSync(stage);}
   }
   await doctor(f,operation+'-doctor',{success:true,saved,produced});
   const business=[resultFile,saved.backup.path,path.join(f.base,'.work-data','active-v1.json'),headerFile,path.join(f.base,'.work-data','generations',saved.authority.id,'sessions',SESSION+'.json')].map(file=>core.read(file).row);
   const handle=w.spawnServe(f,operation+'-after-doctor',await getFreePort('127.0.0.1'));await handle.spawned;const ref=await w.readyWarm(handle,f);await w.manager.captureNativeBirths(handle);const status=await w.waitWorkerReady(ref);
   assert.deepEqual(status.authority,saved.authority);assert.equal(status.job,null);assert.equal(status.lastResult.id,saved.id);assert.ok((await w.sessionIds(ref)).includes(SESSION));
   const read=await upload.makeHttp(ref,'/api/sessions/'+SESSION,undefined,{guard:w.healthy});assert.equal(read.status,200);assert.equal(read.value?.session?.id,SESSION);assert.equal(read.value?.session?.title,'Synthetic restore session');
   for(const row of business)core.samePinned(core.read(row.file).row,row);await w.manager.cleanupKnown(handle,async()=>w.healthy());
   w.checked(operation+': subsequent ordinary source serve acquires real owner and reads unchanged business data and existing result');
  }
  const proof=target.recheck();assert.equal(w.manager.hasUnclosed(),false);assert.equal(w.manager.hasUnverifiedSpawn(),false);for(const producer of producers)producer.assertClosed();
  w.checkpoint('result',{schema:1,inputProof:proof,checks:w.ctx.checks,constructedCrashWindow:true,completionEvidence:'existing-durable-result',originalMigrationEquivalenceReproved:false,whole3_1Complete:false});
  for(const check of w.ctx.checks)runner.ok(true,check);console.log('Retained synthetic C11 evidence '+root);runner.done();
 }catch(error){
  for(const producer of producers){try{producer.holdFailure();}catch{}}
  const frame=String(error?.stack||'').split(/\r?\n/).map(line=>/work-data-completed-intent-recovery\.e2e\.js:(\d+):(\d+)/.exec(line)).find(Boolean);
  const failure={phase:w.ctx.phase,code:/^[a-zA-Z0-9_.-]{1,100}$/.test(error?.code||'')?error.code:'C11_ACCEPTANCE_FAILURE',location:frame?{line:Number(frame[1]),column:Number(frame[2])}:null,
   ...safeProducerError(error),producers:producers.map(producer=>producer.diagnostic()),rawBodiesOmitted:true};
  w.latch(error);try{const fd=fs.openSync(path.join(evidence,'failure-summary.json'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(failure,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
  console.error('C11-RECOVERY-DIAG '+JSON.stringify({root,...failure}));
  // Flush the retained creation identities and logs, then hand any live source,
  // doctor or held producer back to the root owner for audited reclamation.
  // Exit synchronously after closing logs so their still-referenced pipes cannot
  // keep this test alive or dispatch another write to a closed evidence FD.
  try{w.close();}catch{}
  process.exit(1);
 }finally{w.close();}
}
module.exports={runActual};
if(require.main===module)runActual().catch(error=>{console.error('C11-RECOVERY-DIAG '+JSON.stringify({code:error?.code||'C11_ENTRY_FAILURE',rawBodiesOmitted:true}));process.exitCode=1;});
