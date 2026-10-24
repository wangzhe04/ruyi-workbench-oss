'use strict';
// Real Node stdin/IPC, PID death, OS pipe exclusion, same-port HTTP and Windows
// outer Job. Business operations and native flush are explicit simulations;
// actual DPAPI/migration acceptance lives in work-data-cold-operations.e2e.js.
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const runner=require('./lib/harness').createRunner('WORK DATA MAINTENANCE RUNTIME');
const {releaseEnvironment}=require('./lib/release-checks'),{killOwnTree}=require('./lib/kill-own-tree');
async function run(command,args,env){
 const child=cp.spawn(command,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
 const timeout=setTimeout(()=>{void killOwnTree(child);},65000);
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,output);console.log(output.trim());return output;}
 finally{clearTimeout(timeout);await killOwnTree(child);}
}
(async()=>{
 const parent=path.resolve(os.tmpdir()),root=await io.mkdtemp(path.join(parent,'ruyi-runtime-acceptance-'));let passed=false;
 try{
  const env=releaseEnvironment(path.join(root,'home'),path.join(root,'process-data'));
  const output=await run(process.execPath,['--test',path.join(__dirname,'lib/work-data-maintenance-runtime-process-check.cjs')],env);assert.match(output,/(?:pass 4|# pass 4)/);assert.match(output,/(?:fail 0|# fail 0)/);
  runner.ok(true,'four real process cases: success and owned operation/authority-reader/authority-conflict failures');
  if(process.platform==='win32'){
   const base=path.join(root,'base'),backups=path.join(root,'backups');await io.mkdir(base);await io.mkdir(backups);await io.writeFile(path.join(base,'config.json'),'{}');
   const jobEnv={...releaseEnvironment(path.join(root,'job-home'),base),RUYI_RUNTIME_UNIT_ROOT:root,RUYI_RUNTIME_UNIT_SCENARIO:'success',RUYI_RUNTIME_OUTER_JOB:'1',RUYI_RUNTIME_NODE_EXE:process.execPath,RUYI_RUNTIME_FIXTURE:path.join(__dirname,'lib/work-data-maintenance-runtime-process-fixture.cjs')};
   await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'lib/work-data-maintenance-runtime-outer-job.ps1')],jobEnv);
   const receipt=JSON.parse(await io.readFile(path.join(root,'outer-job-result.json'),'utf8'));assert.equal(receipt.ok,true);assert.equal(receipt.workerExited,true);assert.equal(receipt.successorSurvivedWorker,true);assert.equal(receipt.outerJobKilledSuccessor,true);
   runner.ok(true,'actual outer Job closes detached successor after original serve and worker both exited');
  }
  passed=true;
 }finally{if(passed){assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('ruyi-runtime-acceptance-'));await io.rm(root,{recursive:true,force:true});}else console.error('Retained owned runtime acceptance fixture '+root);}
})().catch(error=>runner.fail(error.stack||String(error))).finally(()=>runner.done({exit:true}));
