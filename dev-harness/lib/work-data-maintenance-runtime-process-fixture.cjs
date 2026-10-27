'use strict';
// Process transport fixture. Uses the real worker/OS pipe owner/HTTP/result owner
// with a deliberately simulated operation body and flush seam. No native helper.
const fs=require('node:fs'),io=require('node:fs/promises'),p=require('node:path'),http=require('node:http'),c=require('node:crypto'),vm=require('node:vm'),assert=require('node:assert/strict');
const dir=p.resolve(__dirname,'../../ruyi-workbench/app/src'),root=process.env.RUYI_RUNTIME_UNIT_ROOT,base=p.join(root,'base'),backups=p.join(root,'backups'),scenario=process.env.RUYI_RUNTIME_UNIT_SCENARIO;
const load=(file,symbol,extra={})=>vm.runInNewContext(fs.readFileSync(p.join(dir,file),'utf8')+'\n'+symbol,{require,Buffer,process,http,crypto:c,setTimeout,clearTimeout,URL,...extra});
const Worker=load('13ai-work-data-worker.js','WorkDataMaintenanceWorker'),Control=load('13aj-work-data-control.js','WorkDataMaintenanceControl'),Result=load('01ae-work-data-maintenance-result.js','WorkDataMaintenanceResult'),Http=load('13al-work-data-maintenance-http.js','WorkDataMaintenanceHttp'),Ownership=load('01g-server-ownership.js','ServerOwnership'),Manifest=load('01v-work-data-manifest.js','WorkDataManifest'),Runtime=load('13am-work-data-maintenance-runtime.js','WorkDataMaintenanceRuntime',{ServerOwnership:Ownership});
const PASSWORD='runtime fixture password only',id='a'.repeat(48),mode=process.argv[2],hash=bytes=>c.createHash('sha256').update(bytes).digest('hex'),hooks={},legacyNoClaim=true;let retired=false,runtime,warm=null;
const trace=value=>{if(value.event==='execute')fs.writeFileSync(p.join(root,'worker-pid.txt'),String(process.pid));fs.appendFileSync(p.join(root,'trace.log'),JSON.stringify({...value,pid:process.pid})+'\n');};
// A failed probe is never allowed to leave a server behind indefinitely. This is
// fixture cleanup only; every hold assertion is made long before this deadline.
if(process.env.RUYI_RUNTIME_OUTER_JOB!=='1')setTimeout(()=>process.exit(0),12000).unref();
// This harness is a legacy transport/state-machine simulation: it deliberately
// has no durable handoff claim (the production claim closed loop has its own
// real E2E). The runtime declares that absence explicitly via legacyNoClaim,
// but forwards it as `claim:null`; 13ai's documented no-claim path is an absent
// `claim` property. Drop only that declared null — never forge a claim writer.
const legacyCreate=options=>{if(!legacyNoClaim||!options||options.claim!==null)return Worker.create(options);const {claim,...rest}=options;return Worker.create(rest);};
const actualWorker={...Worker,create:legacyCreate,spawnCold:(command,env)=>{const child=Worker.spawnCold(command,env);trace({event:'child-spawn',mode:command.args.at(-1),child:child.pid});return child;}};
// Source-scope seams. Like the production runtime host, both seams require a
// genuine held lease for the exact base, run the work under a real source pin,
// and never substitute success for a lost owner. The warm handoff intentionally
// leaves its pin held: only old-process death may free the source for takeover.
const ownershipRequired=()=>Object.assign(Error('fixture source owner unavailable'),{code:'work_data_setup.ownership_required',retry:false});
const assertSourceLease=(owner,root)=>{if(!Ownership.isLease(owner)||!Ownership.owns(owner,root))throw ownershipRequired();return true;};
async function withWarmSource(_request,work){
 const captured=warm;
 if(!captured||typeof work!=='function')throw Object.assign(Error('fixture warm source unavailable'),{code:'work_data_setup.worker_unavailable',retry:false});
 assertSourceLease(captured.ownership,captured.base);
 const pin=Ownership.createSourceKeeper(captured.ownership,captured.base);let handle;
 try{
  handle=await work();
  if(!Ownership.isSourceKeeper(pin,captured.ownership,captured.base)||!pin.assertExclusive(captured.ownership)
    ||!handle||!handle.ready||typeof handle.ready.then!=='function'||typeof handle.cancel!=='function'||typeof handle.handoff!=='function')throw Object.assign(Error('fixture worker contract unavailable'),{code:'work_data_setup.worker_contract_invalid',retry:false});
 }catch(error){try{pin.retainUnknown(error);}catch{}throw error;}
 const ready=Promise.resolve(handle.ready).then(value=>{assertSourceLease(captured.ownership,captured.base);if(!Ownership.isSourceKeeper(pin,captured.ownership,captured.base))throw ownershipRequired();return value;});
 void ready.catch(()=>{});
 return Object.freeze({ready,async cancel(){
  try{await handle.cancel();assertSourceLease(captured.ownership,captured.base);await pin.releaseChecked(()=>{assertSourceLease(captured.ownership,captured.base);return true;});}
  catch(error){try{pin.retainUnknown(error);}catch{}throw error;}
 },async handoff(){
  try{await handle.handoff();}catch(error){try{pin.retainUnknown(error);}catch{}throw error;}
  // An acknowledged handoff that returned to the old process never releases
  // its source owner or pretends the parent exited.
  throw Object.assign(Error('fixture parent exit returned after handoff'),{code:'work_data_setup.parent_exit_returned',helperMayStillRun:true,ownershipRetained:true,retry:false});
 }});
}
async function withColdSource(context,work){
 const owner=context?.ownership,root=context?.base;
 assertSourceLease(owner,root);if(typeof work!=='function')throw ownershipRequired();
 const keeper=Ownership.createSourceKeeper(owner,root);let value;
 try{
  value=await work();
  if(!Ownership.isSourceKeeper(keeper,owner,root)||!keeper.assertExclusive(owner))throw ownershipRequired();
 }catch(error){try{keeper.retainUnknown(error);}catch{}throw error;}
 // Release only the real lease, after a final helper-uncertainty admission.
 await keeper.releaseOwner(()=>{try{return runtime.helperMayStillRun()===false;}catch{return false;}});
 return value;
}
const host={process,workerApi:actualWorker,httpApi:Http,resultApi:Result,controlApi:Control,workerHooks:hooks,
 base:async()=>base,canonical:Ownership.canonicalRoot,acquire:roots=>Ownership.acquire(roots),readAuthority:async()=>{
  if(mode==='work-data-maintenance'&&['authority-read-fail','authority-conflict'].includes(scenario)){
   const parent=JSON.parse(await io.readFile(p.join(root,'parent-ready.json'),'utf8'));fs.writeFileSync(p.join(root,'preflight-ready.json'),JSON.stringify({pid:process.pid,port:parent.port}));
   trace({event:'preflight-authority',scenario});
   if(scenario==='authority-read-fail')throw Object.assign(Error('simulated authority reader failure'),{code:'work_data_setup.authority_unavailable'});
   const manifest=Manifest.create({base,publish:async({stage,target})=>io.rename(stage,target)}),before=await manifest.readActive();
   // Explicit fault injection: a new actual manifest appears after handoff. The
   // planned operation never runs and the changed authority must not be hidden.
   if(before.generation===0){const candidate=await manifest.prepare({expected:before,mode:'encrypted'});await manifest.commit({expected:before,candidate});}
  }
  return Manifest.create({base}).readActive();
 },
 assertOwnership:(owner,requested)=>Ownership.isLease(owner)&&Ownership.owns(owner,requested),withColdSource,withWarmSource,legacyNoClaim,
 retiredReceipt:()=>retired?Object.freeze({phase:'retired',admitted:0,writers:0,dirty:0,busy:Object.freeze({})}):null,
 adaptersReady:()=>true,helperMayStillRun:()=>false,isRetired:()=>retired,stopUncommitted:async child=>{if(child.connected)child.disconnect();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));},
 command:command=>({command:process.execPath,args:[__filename,command]}),exit:code=>{trace({event:'exit',code});process.exit(code);},
 operations:({guardNative,helperMayStillRun,progress})=>({execute:async ctx=>{
  let oldGone=false;try{process.kill(ctx.parentPid,0);}catch(error){oldGone=error.code==='ESRCH';}assert.equal(oldGone,true);assert.equal(ctx.assertExclusive(ctx.ownership),true);
  await assert.rejects(()=>Ownership.acquire([base]),{code:'DATA_ROOT_IN_USE'});assert.equal(ctx.password,PASSWORD);
  assert.ok(!process.argv.some(arg=>arg.includes(PASSWORD)));assert.ok(!Object.values(process.env).some(value=>String(value).includes(PASSWORD)));
  trace({event:'execute',oldGone,parent:ctx.parentPid});await progress({id:ctx.id,operation:ctx.operation,phase:'verify-backup'});
  const path=p.join(backups,'ruyi-work-data-'+id+'.ruyi-backup'),bytes=Buffer.from('SIMULATED OPERATION PACKAGE, not a native/capsule acceptance claim');await io.writeFile(path,bytes,{flag:'wx'});const stat=await io.stat(path,{bigint:true}),backup={path,bytes:bytes.length,sha256:hash(bytes),identity:{dev:String(stat.dev),ino:String(stat.ino)}};
  if(scenario==='ops-failure'){
   fs.writeFileSync(p.join(root,'failure-ready.json'),JSON.stringify({pid:process.pid,port:ctx.serve.port}));
   await guardNative(async()=>{throw Object.assign(Error('simulated native uncertainty'),{code:'work_data_setup.fixture_failure',operationMayHaveExecuted:true,backupPath:path,cause:{helperMayStillRun:true}});});
   throw Error('unreachable after guard');
  }
  const active=await host.readAuthority(),authority={generation:active.generation,id:active.id,mode:active.mode,sha256:active.proof.sha256},result=Result.create({base,ownership:ctx.ownership,assertExclusive:ctx.assertExclusive,readAuthority:host.readAuthority,assertDurableBackup:async proof=>proof.sha256===backup.sha256,flush:async()=>{}});
  const receipt=await result.write({schema:1,id,operation:'export',state:'verified',finishedAt:new Date().toISOString(),sourceAuthority:authority,authority,backup});assert.equal(await result.verify(receipt),true);assert.equal(helperMayStillRun(),false);
  trace({event:'operation-verified'});return {id,operation:'export',state:'verified',backup,restartRoot:base};
 }}),
 startFreshServe:async options=>{
  assert.equal(runtime.strictSamePort(options),true);assert.equal(runtime.strictSamePort({...options}),false);
  const owner=await Ownership.acquire([base]);await runtime.inspectBoot({base,ownership:owner});const server=http.createServer(async(req,res)=>{
   if(req.url==='/__fixture_exit'){res.end('{}');server.close(()=>process.exit(0));return;}
   const lastResult=await hooks.readResult();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({pid:process.pid,lastResult}));
  });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(options.port),options.host,resolve);});
  await io.writeFile(p.join(base,'runtime.json'),JSON.stringify({pid:process.pid}));await runtime.captureServe({base,ownership:owner,server,listener:{host:options.host,port:Number(options.port)}});
  warm={ownership:owner,base:await Ownership.canonicalRoot(base)};
  runtime.activateServe();
  fs.writeFileSync(p.join(root,'successor-pid.txt'),String(process.pid));trace({event:'successor-listen',port:server.address().port});fs.writeFileSync(p.join(root,'successor-ready.json'),JSON.stringify({pid:process.pid,port:server.address().port}));
 }
};runtime=Runtime.create(host);
async function parent(){
 if(process.env.RUYI_RUNTIME_OUTER_JOB==='1'){for(let attempt=0;!fs.existsSync(p.join(root,'outer-job-assigned'));attempt++){if(attempt>=400)throw Error('outer Job assignment missing');await new Promise(resolve=>setTimeout(resolve,10));}}

 const owner=await Ownership.acquire([base]);await runtime.inspectBoot({base,ownership:owner});const server=http.createServer((_req,res)=>res.end('{}'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await io.writeFile(p.join(base,'runtime.json'),JSON.stringify({pid:process.pid}));
 await runtime.captureServe({base,ownership:owner,server,listener:{host:'127.0.0.1',port}});warm={ownership:owner,base:await Ownership.canonicalRoot(base)};assert.equal(hooks.start,undefined);runtime.activateServe();const handle=await hooks.start({id,operation:'export',password:PASSWORD,expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupDirectory:backups});
 await handle.ready;retired=true;fs.writeFileSync(p.join(root,'parent-ready.json'),JSON.stringify({pid:process.pid,port}));await handle.handoff();
}
(mode==='parent'?parent():mode==='work-data-maintenance'?runtime.runCold():runtime.runSuccessor()).catch(error=>{trace({event:'failure',code:error.code});console.error(error.stack);process.exitCode=1;});
