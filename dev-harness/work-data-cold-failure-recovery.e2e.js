'use strict';
// ROOT SERIAL / Windows Node24. 151 阶段 3A(150 号文 W1/W7/W8):冷端备份写出之后的失败(verify-backup 失败、
// 备份文件夹 flush 失败)不再让冷进程 hold() 永不退出。真 serve → 真冷进程(真 DPAPI/NTFS 原生件、真演练恢复)→
// 在显式测试变量 RUYI_TEST_WORK_DATA_COLD_FAULT 指定的点注入一次类型化失败 → 冷端按身份清掉本次的备份包与演练、
// 撤交接记录 → 起恢复型后继回到原根,同端口、新令牌、服务可用,不需要任何 CLI。
// 观测只用产品公布的事实:旧 serve 的自然退出、runtime.json、真 13av claim API、后继的 HTTP 状态与作业读数。
// 失败时保留现场;这里不杀任何产品进程,后继交给 restore 世界里那个受控外层 Job 回收。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),restore=require('./work-data-production-restore.e2e'),upload=require('./work-data-production-upload.e2e');
const {bindTarget}=require('./lib/work-data-owned-claim-fixture');
const {releaseEnvironment}=require('./lib/release-checks'),{snapshotProcessTable,ownDescendants}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const PASSWORD='SYNTHETIC cold failure recovery only 2026',SESSION='sess_restore_synthetic';
const PLAINTEXT=[Buffer.from('Synthetic restore session'),Buffer.from(SESSION)];
async function runActual(argv=process.argv.slice(2)){
 assert.equal(argv.length,0);const runner=require('./lib/harness').createRunner('WORK DATA COLD FAILURE RECOVERY');
 if(process.platform!=='win32'){console.log('SKIP Windows native cold failure recovery');runner.done();return;}
 assert.equal(Number(process.versions.node.split('.')[0]),24);require('./lib/self-isolate-home');
 const target=bindTarget(__dirname,__filename),root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-cold-failure-')),evidence=path.join(root,'evidence');fs.mkdirSync(evidence);
 const w=restore.createWorld({root,evidence,target,harness:__dirname,releaseEnvironment,snapshotProcessTable,ownDescendants,getFreePort});w.openJournal();
 // Every entry of the backup directory, recursively: no plaintext, no rehearsal, no stage.
 const backupEntries=f=>{const seen=[];const walk=(dir,rel)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=rel?rel+'/'+entry.name:entry.name;seen.push(name);
  if(entry.isDirectory())walk(path.join(dir,entry.name),name);else{const bytes=fs.readFileSync(path.join(dir,entry.name));for(const marker of PLAINTEXT)assert.equal(bytes.includes(marker),false,'plaintext in backup '+name);}}};walk(f.backups,'');return seen;};
 const rehearsals=f=>fs.readdirSync(path.dirname(f.base)).filter(name=>name.startsWith('.ruyi-work-data-rehearsal-'));
 // W7 at every stage: names only while the job runs (reading the package itself could only add access-time
 // noise to the product's own checks). The only name ever allowed is this job's ciphertext package; any other
 // entry is read at once and checked for plaintext, and is a failure by itself.
 const watchBackups=(f,label)=>{
  const seen=new Set(),foreign=[];let scans=0,stopped=false;
  const scan=()=>{const walk=(dir,rel)=>{let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
   for(const entry of entries){const name=rel?rel+'/'+entry.name:entry.name;seen.add(name);if(/^ruyi-work-data-[a-f0-9]{48}.ruyi-backup$/.test(name)&&entry.isFile())continue;
    foreign.push(name);if(entry.isDirectory())walk(path.join(dir,entry.name),name);else{try{const bytes=fs.readFileSync(path.join(dir,entry.name));for(const marker of PLAINTEXT)if(bytes.includes(marker))foreign.push('PLAINTEXT:'+name);}catch{}}}};
   walk(f.backups,'');scans++;};
  const timer=setInterval(()=>{if(!stopped)scan();},25);
  return {stop(jobId){stopped=true;clearInterval(timer);scan();assert.ok(scans>=10,label+': the backup directory was scanned throughout the job ('+scans+')');
   assert.deepEqual(foreign,[],label+': only the ciphertext package ever appeared in the backup directory');
   for(const name of seen)assert.equal(name,'ruyi-work-data-'+jobId+'.ruyi-backup',label+': no other package name');return {scans,seen:[...seen]};}};
 };
 try{
  w.record({kind:'fixture-owner',root,inputFiles:target.boundFiles,executionInputSha256:target.executionInputSha256});
  for(const [fault,reason] of [['verify-backup','work_data_setup.test_fault_verify_backup'],['backup-flush','work_data_setup.test_fault_backup_flush']]){
   const label='fault-'+fault,f=w.fixture(label);f.env={...f.env,RUYI_TEST_HOOKS:'1',RUYI_TEST_WORK_DATA_COLD_FAULT:fault};
   const handle=w.spawnServe(f,label+'-serve',await getFreePort('127.0.0.1'));await handle.spawned;
   const ref=await w.readyWarm(handle,f);await w.manager.captureNativeBirths(handle);const before=await w.waitWorkerReady(ref);
   const source=before.authority,pins=w.sourcePins(f);
   w.ctx.phase=label+'-submit';const watch=watchBackups(f,label);
   const jobId=await w.submitAccepted(ref,{operation:'export',password:PASSWORD,expectedAuthority:source,backupDirectory:f.backups});
   w.ctx.phase=label+'-old-exit';await w.waitOldServeExit(ref);
   w.ctx.phase=label+'-successor';
   const next=await w.waitSuccessor(ref,f,{homeBase:f.base,jobId,expectedAuthority:source,requireResultId:null,forbidResultId:jobId,notPids:[ref.pid]});
   const scanned=watch.stop(jobId);w.record({kind:'backup-directory-watch',label,scans:scanned.scans,seen:scanned.seen});
   assert.deepEqual(next.status.authority,source,label+': the original root serves again with its unchanged authority');
   assert.equal(next.status.job,null);assert.equal(next.status.capabilities.worker,true,label+': the maintenance worker is available again');
   const job=await upload.makeHttp(next,'/api/work-data/jobs/'+jobId,undefined,{guard:w.healthy});
   assert.equal(job.status,200);assert.equal(job.value.job.id,jobId);assert.equal(job.value.job.state,'failed');assert.equal(job.value.job.recovered,true);
   assert.equal(job.value.job.error,'work_data_setup.preparation_failed');assert.equal(job.value.job.reason,reason);assert.equal(job.value.job.operationMayHaveExecuted,false);
   assert.deepEqual(backupEntries(f),[],label+': the package this attempt created is gone and no plaintext ever reached the backup directory');
   assert.deepEqual(rehearsals(f),[],label+': the private rehearsal beside the data root is gone');
   await w.assertClaimGone(f,label);w.assertNoIntent(f,label);
   for(const row of pins)core.samePinned(core.read(path.join(f.base,...row.relative.split('/'))).row,row.row);
   assert.ok((await w.sessionIds(next)).includes(SESSION),label+': ordinary data reads work on the recovered service');
   w.checked(label+': cold failure after the backup was written cleans up by identity and hands the original root back without any CLI');
   await w.reclaimSuccessor(label,next);
  }
  // W7 success path: the same watcher over a real export that verifies. The rehearsal (plaintext restore of the
  // package) runs beside the data root; the backup directory only ever holds this job's ciphertext package.
  {
   const label='success-export',f=w.fixture(label);
   const handle=w.spawnServe(f,label+'-serve',await getFreePort('127.0.0.1'));await handle.spawned;
   const ref=await w.readyWarm(handle,f);await w.manager.captureNativeBirths(handle);const before=await w.waitWorkerReady(ref);
   const source=before.authority,pins=w.sourcePins(f);
   w.ctx.phase=label+'-submit';const watch=watchBackups(f,label);
   const jobId=await w.submitAccepted(ref,{operation:'export',password:PASSWORD,expectedAuthority:source,backupDirectory:f.backups});
   w.ctx.phase=label+'-old-exit';await w.waitOldServeExit(ref);
   w.ctx.phase=label+'-successor';
   const next=await w.waitSuccessor(ref,f,{homeBase:f.base,jobId,requireResultId:jobId,notPids:[ref.pid]});
   const scanned=watch.stop(jobId);w.record({kind:'backup-directory-watch',label,scans:scanned.scans,seen:scanned.seen});
   assert.equal(next.status.lastResult.state,'verified');assert.deepEqual(next.status.authority,source);
   assert.deepEqual(backupEntries(f),['ruyi-work-data-'+jobId+'.ruyi-backup'],label+': exactly the ciphertext package remains and it holds no plaintext marker');
   assert.deepEqual(rehearsals(f),[],label+': the private rehearsal beside the data root is gone after success');
   for(const row of pins)core.samePinned(core.read(path.join(f.base,...row.relative.split('/'))).row,row.row);
   w.checked(label+': a verified export never puts plaintext or a rehearsal into the backup directory at any stage');
   await w.reclaimSuccessor(label,next);
  }
  const proof=target.recheck();assert.equal(w.manager.hasUnclosed(),false);assert.equal(w.manager.hasUnverifiedSpawn(),false);
  w.checkpoint('result',{schema:1,inputProof:proof,checks:w.ctx.checks});
  for(const check of w.ctx.checks)runner.ok(true,check);console.log('Retained synthetic cold failure evidence '+root);runner.done();
 }catch(error){
  const frame=String(error?.stack||'').split(/\r?\n/).map(line=>/work-data-cold-failure-recovery\.e2e\.js:(\d+):(\d+)/.exec(line)).find(Boolean);
  const failure={phase:w.ctx.phase,code:/^[a-zA-Z0-9_.-]{1,100}$/.test(error?.code||'')?error.code:'COLD_FAILURE_RECOVERY',location:frame?{line:Number(frame[1]),column:Number(frame[2])}:null,
   message:String(error?.message||'').slice(0,300),rawBodiesOmitted:true};
  w.latch(error);try{const fd=fs.openSync(path.join(evidence,'failure-summary.json'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(failure,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
  console.error('COLD-FAILURE-RECOVERY-DIAG '+JSON.stringify({root,...failure}));
  try{w.close();}catch{}
  process.exit(1);
 }finally{w.close();}
}
module.exports={runActual};
if(require.main===module)runActual().catch(error=>{console.error('COLD-FAILURE-RECOVERY-DIAG '+JSON.stringify({code:error?.code||'COLD_FAILURE_ENTRY',rawBodiesOmitted:true}));process.exitCode=1;});
