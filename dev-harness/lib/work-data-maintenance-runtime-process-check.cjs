'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http'),vm=require('node:vm');
const repo=p.resolve(__dirname,'../..'),{releaseEnvironment}=require(p.join(repo,'dev-harness/lib/release-checks')),{killOwnTree}=require(p.join(repo,'dev-harness/lib/kill-own-tree'));
const Ownership=vm.runInNewContext(fs.readFileSync(p.join(repo,'ruyi-workbench/app/src/01g-server-ownership.js'),'utf8')+'\nServerOwnership;',{require,process});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=7000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(20);}throw Error('timeout '+label);}
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const gone=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
const request=(port,path,method='GET',headers={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers,agent:false},res=>{let body='';res.on('data',bytes=>body+=bytes.toString());res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));});req.on('error',reject);req.end();});
for(const scenario of ['success','ops-failure','authority-read-fail','authority-conflict'])test('actual old PID -> cold OS owner/read-only same port -> '+scenario,async()=>{
 const root=await io.mkdtemp(p.join(os.tmpdir(),'ruyi-runtime-process-')),base=p.join(root,'base');await io.mkdir(base);await io.mkdir(p.join(root,'backups'));await io.writeFile(p.join(base,'config.json'),'{}');
 const env=releaseEnvironment(p.join(root,'home'),base);Object.assign(env,{RUYI_RUNTIME_UNIT_ROOT:root,RUYI_RUNTIME_UNIT_SCENARIO:scenario});
 const child=cp.spawn(process.execPath,[p.join(__dirname,'work-data-maintenance-runtime-process-fixture.cjs'),'parent'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes.toString());child.stdout.resume();let workerPid,successorPid;
 try{
  const parent=await until(()=>read(p.join(root,'parent-ready.json')),'parent ready');await until(()=>gone(parent.pid),'actual old PID exit');
  if(scenario==='success'){
   const successor=await until(()=>read(p.join(root,'successor-ready.json')),'new successor ready');successorPid=successor.pid;assert.notEqual(successor.pid,parent.pid);assert.equal(successor.port,parent.port);
   const trace=fs.readFileSync(p.join(root,'trace.log'),'utf8').trim().split('\n').map(JSON.parse),execute=trace.find(row=>row.event==='execute'),listen=trace.find(row=>row.event==='successor-listen');workerPid=execute.pid;
   await until(()=>gone(workerPid),'cold worker exit before successor health');assert.equal(gone(successor.pid),false);
   const status=await request(successor.port,'/api/work-data/status');assert.equal(status.status,200);assert.equal(status.value.pid,successor.pid);assert.equal(status.value.lastResult.id,'a'.repeat(48));assert.equal(status.value.lastResult.operation,'export');
   assert.notEqual(execute.pid,successor.pid);assert.equal(execute.oldGone,true);assert.equal(listen.port,parent.port);assert.ok(trace.findIndex(row=>row.event==='operation-verified')<trace.findIndex(row=>row.event==='successor-listen'));
   await request(successor.port,'/__fixture_exit');await until(()=>gone(successor.pid),'successor cleanup');await until(()=>gone(workerPid),'cold worker exit after acknowledged fresh serve');
  }else if(scenario==='ops-failure'){
   const failed=await until(()=>read(p.join(root,'failure-ready.json')),'cold failure hold');workerPid=failed.pid;assert.equal(failed.port,parent.port);
   const boot=await until(async()=>{try{return await request(failed.port,'/api/bootstrap','POST');}catch{return null;}},'readonly bootstrap');const status=await until(async()=>{
    const value=await request(failed.port,'/api/work-data/status','GET',{'x-wcw-token':boot.value.token});
    if(value.status===503){assert.equal(value.value.error?.code,'work_data_setup.status_unavailable');return null;}
    assert.equal(value.status,200);assert.ok(value.value.job,'cold status must contain the actual job');
    return value.value.job.state==='handoff'?null:value;
   },'cold failure status after actual authority read');
   assert.equal(status.value.job.state,'uncertain');assert.equal(status.value.job.error,'work_data_setup.fixture_failure');assert.match(status.value.job.backupPath,/ruyi-work-data-a{48}\.ruyi-backup$/);assert.equal(status.value.job.cancellable,false);
   await assert.rejects(()=>Ownership.acquire([base]),{code:'DATA_ROOT_IN_USE'});await delay(100);assert.equal(gone(workerPid),false);assert.equal(fs.existsSync(p.join(root,'successor-ready.json')),false);assert.equal(fs.existsSync(p.join(base,'.work-data','maintenance-result-v1.json')),false);
   await until(()=>gone(workerPid),'fixture deadline cleanup',14000);
  }else{
   const failed=await until(()=>read(p.join(root,'preflight-ready.json')),'preexecute failure hold');workerPid=failed.pid;assert.equal(failed.port,parent.port);
   const boot=await until(async()=>{try{return await request(failed.port,'/api/bootstrap','POST');}catch{return null;}},'preflight bootstrap');const status=await request(failed.port,'/api/work-data/status','GET',{'x-wcw-token':boot.value.token});
   if(scenario==='authority-read-fail'){assert.equal(status.status,503);assert.equal(status.value.error.code,'work_data_setup.status_unavailable');assert.equal(status.value.authority,undefined);}
   else{assert.equal(status.status,200);assert.equal(status.value.authority.generation,1);assert.equal(status.value.authority.mode,'encrypted');assert.equal(status.value.job.error,'work_data_setup.authority_changed');assert.equal(status.value.job.state,'uncertain');}
   await assert.rejects(()=>Ownership.acquire([base]),{code:'DATA_ROOT_IN_USE'});const trace=fs.readFileSync(p.join(root,'trace.log'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(trace.some(row=>row.event==='execute'),false);
   assert.equal(fs.existsSync(p.join(root,'successor-ready.json')),false);assert.equal(fs.existsSync(p.join(base,'.work-data','maintenance-result-v1.json')),false);assert.equal(fs.readFileSync(p.join(base,'config.json'),'utf8'),'{}');
   await until(()=>gone(workerPid),'preflight fixture deadline cleanup',14000);
  }
  assert.equal(child.exitCode,0,stderr);console.log('PROCESS CASE RECEIPT '+JSON.stringify({oldPid:parent.pid,workerPid,successorPid,port:parent.port,pass:true}));
 }finally{
  await killOwnTree(child);if(successorPid&&!gone(successorPid)){try{await request(read(p.join(root,'successor-ready.json')).port,'/__fixture_exit');}catch{}}
  if(workerPid)await until(()=>gone(workerPid),'own worker bounded fixture cleanup',14000);
  assert.equal(p.dirname(root),p.resolve(os.tmpdir()));assert.ok(p.basename(root).startsWith('ruyi-runtime-process-'));await io.rm(root,{recursive:true,force:true});
 }
});
