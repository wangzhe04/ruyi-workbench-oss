'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),p=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const runtimeSource=process.env.RUNTIME_CANDIDATE||p.join(__dirname,'../../ruyi-workbench/app/src/13am-work-data-maintenance-runtime.js');
const runtimeGlobals={};
const load=(file,symbol)=>vm.runInNewContext(fs.readFileSync(file==='13am-work-data-maintenance-runtime.js'?runtimeSource:p.join(__dirname,'../../ruyi-workbench/app/src',file),'utf8')+'\n'+symbol,{require,Buffer,process,http,crypto:require('node:crypto'),URL,setTimeout,clearTimeout,...runtimeGlobals});
const GenuineOwnership=load('01g-server-ownership.js','ServerOwnership');runtimeGlobals.ServerOwnership=GenuineOwnership;
const Runtime=load('13am-work-data-maintenance-runtime.js','WorkDataMaintenanceRuntime'),Result=load('01ae-work-data-maintenance-result.js','WorkDataMaintenanceResult'),Control=load('13aj-work-data-control.js','WorkDataMaintenanceControl'),Manifest=load('01v-work-data-manifest.js','WorkDataManifest');
async function fixture(t){
 const root=await io.mkdtemp(p.join(os.tmpdir(),'ruyi-runtime-unit-')),base=p.join(root,'base');await io.mkdir(base);
 const canonicalBase=await GenuineOwnership.canonicalRoot(base),ownership=await GenuineOwnership.acquire([base]),sourceKeeper=GenuineOwnership.createSourceKeeper(ownership,canonicalBase);
 const server=http.createServer();
 t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await sourceKeeper.releaseChecked(()=>GenuineOwnership.owns(ownership,canonicalBase));await ownership.release();assert.equal(p.dirname(root),p.resolve(os.tmpdir()));assert.ok(p.basename(root).startsWith('ruyi-runtime-unit-'));await io.rm(root,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 // This fixture's real keeper spans the entire test, including parked no-IO failure progress.
 const scoped=async(owner,work)=>{if(!GenuineOwnership.owns(owner,canonicalBase)||!sourceKeeper.assertExclusive(owner))throw Object.assign(Error('fixture source owner unavailable'),{code:'work_data_setup.ownership_required'});return work();};
 const workerHooks={},state={ready:true,helpers:false,retired:false,creates:[],starts:[],exits:[],reads:0,fresh:0};
 const host={process:{pid:12345,ppid:88,env:{}},workerHooks,workerApi:{create:args=>{state.creates.push(args);return {start:async value=>{state.starts.push(value);return {ready:Promise.resolve()};},runCold:async()=>({phase:'cancelled'})};},spawnCold:()=>{throw Error('unexpected spawn');},processChannel:()=>({parentConnected:()=>false}),waitForProcessExit:async()=>{}},
  httpApi:{create:()=>{throw Error('unexpected cold HTTP');}},resultApi:Result,controlApi:Control,
  base:async()=>base,canonical:async value=>p.resolve(value).toLowerCase(),acquire:async()=>ownership,readAuthority:async()=>{state.reads++;return Manifest.create({base}).readActive();},operations:()=>({execute:async()=>{throw Error('unexpected execute');}}),
  assertOwnership:(owner,requested)=>sourceKeeper.assertExclusive(owner)&&GenuineOwnership.owns(owner,requested),withColdSource:(context,work)=>scoped(context.ownership,work),withWarmSource:(_request,work)=>scoped(ownership,work),
  adaptersReady:()=>state.ready,helperMayStillRun:()=>state.helpers,isRetired:()=>state.retired,stopUncommitted:async()=>{},exit:async code=>state.exits.push(code),command:mode=>({command:process.execPath,args:['fixture',mode]}),startFreshServe:async()=>{state.fresh++;}};
 const runtime=Runtime.create(host),context={base,ownership,server,listener:{host:'127.0.0.1',port:server.address().port}};return {root,base,host,runtime,context,state,workerHooks,server,ownership};
}
test('missing real adapter capability captures actual owner/readResult but never advertises start',async t=>{
 const f=await fixture(t);f.state.ready=false;assert.equal(await f.runtime.captureServe(f.context),false);assert.equal(f.runtime.activateServe(),false);assert.equal(f.workerHooks.start,undefined);assert.equal(typeof f.workerHooks.readResult,'function');assert.equal(await f.workerHooks.readResult(),null);assert.equal(f.state.creates.length,0);
});
test('only exact true readiness and false helper status can advertise a worker',async t=>{
 for(const mode of ['truthy','helper-unknown']){const f=await fixture(t);if(mode==='truthy')f.state.ready='yes';else f.state.helpers=undefined;assert.equal(await f.runtime.captureServe(f.context),false);assert.equal(f.workerHooks.start,undefined);}
});
test('actual listener port host and captured OS-owner root must agree',async t=>{
 for(const change of [f=>f.context.listener.port++,f=>f.context.listener.host='::1',f=>f.context.ownership={roots:[f.root]}]){const f=await fixture(t);change(f);await assert.rejects(()=>f.runtime.captureServe(f.context));assert.equal(f.workerHooks.start,undefined);}
});
test('handshake may start after drain but old process exits only on exactly retired admission',async t=>{
 const f=await fixture(t);assert.equal(await f.runtime.captureServe(f.context),true);assert.equal(f.workerHooks.start,undefined);f.runtime.activateServe();await f.workerHooks.start({id:'a'.repeat(48)});assert.equal(f.state.starts.length,1);
 const core=f.state.creates[0];for(const retired of [false,'retired',undefined]){f.state.retired=retired;await assert.rejects(()=>core.exitParent(),{code:'work_data_setup.handoff_not_retired'});}
 assert.equal(f.state.exits.length,0);f.state.retired=true;await core.exitParent();assert.deepEqual(f.state.exits,[0]);
});
test('readiness loss closed listener and duplicate capture cannot launch a new child',async t=>{
 const f=await fixture(t);await f.runtime.captureServe(f.context);f.runtime.activateServe();f.state.ready=false;await assert.rejects(()=>f.workerHooks.start({}),{code:'work_data_setup.worker_unavailable'});f.state.ready=true;
 await assert.rejects(()=>f.runtime.captureServe(f.context),{code:'work_data_setup.runtime_already_bound'});await new Promise(resolve=>f.server.close(resolve));await assert.rejects(()=>f.workerHooks.start({}),{code:'work_data_setup.listener_changed'});assert.equal(f.state.starts.length,0);
});
test('bounded nested native cause inspection permanently latches helper uncertainty before finally',async t=>{
 const f=await fixture(t),cause=Object.freeze({helperMayStillRun:true}),error=Object.freeze(Object.assign(Error('opaque native failure'),{cause:{cause}}));
 await assert.rejects(()=>f.runtime.guardNative(async()=>{throw error;}),value=>value===error);assert.equal(f.runtime.helperMayStillRun(),true);assert.equal(await f.runtime.captureServe(f.context),false);assert.equal(f.workerHooks.start,undefined);
});
test('ordinary startup refuses pending intent before any manifest/config read or startup write',async t=>{
 const f=await fixture(t),control=p.join(f.base,'.work-data');await io.mkdir(control);const bytes=JSON.stringify({schema:1,id:'a'.repeat(48),operation:'enable',phase:'prepared',createdAt:new Date().toISOString(),expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backup:{path:p.join(f.root,'backup'),sha256:'b'.repeat(64)},candidate:null});await io.writeFile(p.join(control,'maintenance-v1.json'),bytes);
 await assert.rejects(()=>f.runtime.inspectBoot({base:f.base,ownership:f.ownership}),{code:'work_data_setup.intent_pending'});assert.equal(f.state.reads,0);assert.equal(await io.readFile(p.join(control,'maintenance-v1.json'),'utf8'),bytes);assert.equal(fs.existsSync(p.join(f.base,'last-start-error.json')),false);
});
test('unknown stages and control entries block ordinary boot without mkdir repair or deletion',async t=>{
 for(const name of ['.active-v1.stage-'+'a'.repeat(48)+'.json',Result.STAGE+'retained.json','UNKNOWN']){const f=await fixture(t),control=p.join(f.base,'.work-data');await io.mkdir(control);await io.writeFile(p.join(control,name),'PRESERVE');
  await assert.rejects(()=>f.runtime.inspectBoot({base:f.base,ownership:f.ownership}),{code:'work_data_setup.boot_control_pending'});assert.equal(f.state.reads,0);assert.deepEqual(await io.readdir(control),[name]);}
});
test('new absent ordinary base needs no directory creation to pass readonly pending gate',async t=>{
 const f=await fixture(t);await io.rmdir(f.base);assert.equal(await f.runtime.inspectBoot({base:f.base,ownership:f.ownership}),true);assert.equal(fs.existsSync(f.base),false);assert.equal(f.state.reads,0);
});
test('cold and successor commands cannot fall into warm serve or trust user-forged strict-port options',async t=>{
 const f=await fixture(t);await f.runtime.captureServe(f.context);await assert.rejects(()=>f.runtime.runCold(),{code:'work_data_setup.worker_unavailable'});assert.equal(f.runtime.strictSamePort({host:'127.0.0.1',port:1234}),false);assert.equal(f.state.fresh,0);
});
test('successor requires live parent IPC and exact bounded schema before normal serve entry',async t=>{
 let f=await fixture(t);await assert.rejects(()=>f.runtime.runSuccessor(),{code:'work_data_setup.successor_unavailable'});assert.equal(f.state.fresh,0);
 f=await fixture(t);const bad={schema:1,id:'a'.repeat(48),parentPid:88,nonce:'b'.repeat(64),base:f.base,serve:{host:'127.0.0.1',port:1},expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},password:'MUST NOT ENTER SUCCESSOR'};
 await assert.rejects(()=>f.runtime.runSuccessor({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.from(JSON.stringify(bad))}),{code:'work_data_setup.successor_input_invalid'});assert.equal(f.state.fresh,0);
});
test('unconfigured production hooks retain readonly boot refusal and never manufacture worker capability',async t=>{
 const f=await fixture(t),hooks={},Worker=load('13ai-work-data-worker.js','WorkDataMaintenanceWorker'),Http=load('13al-work-data-maintenance-http.js','WorkDataMaintenanceHttp'),Ownership=GenuineOwnership;
 vm.runInNewContext(fs.readFileSync(runtimeSource,'utf8'),{require,Buffer,process,http,crypto:require('node:crypto'),URL,setTimeout,clearTimeout,
  WorkDataMaintenanceRuntimeHooks:hooks,WorkDataMaintenanceWorker:Worker,WorkDataMaintenanceHttp:Http,WorkDataMaintenanceResult:Result,WorkDataMaintenanceControl:Control,ServerOwnership:Ownership,WorkDataManifest:Manifest});
 assert.equal(hooks.captureServe(f.context),false);assert.equal(hooks.activateServe(),false);assert.throws(()=>hooks.runCold(),{code:'work_data_setup.worker_unavailable'});assert.throws(()=>hooks.runSuccessor(),{code:'work_data_setup.worker_unavailable'});
 const control=p.join(f.base,'.work-data');await io.mkdir(control);await io.writeFile(p.join(control,'UNKNOWN'),'KEEP');await assert.rejects(()=>hooks.inspectBoot({base:f.base,ownership:f.ownership}),{code:'work_data_setup.boot_control_pending'});assert.equal(await io.readFile(p.join(control,'UNKNOWN'),'utf8'),'KEEP');
});

for(const phase of ['operation','successor'])test('failure progress never substitutes expected authority: '+phase,async t=>{
  const f=await fixture(t),expected={generation:0,id:null,mode:'plain',sha256:null};let observed,reads=0,resolveBound;
  const bound=new Promise(resolve=>resolveBound=resolve);
  f.host.readAuthority=async()=>{if(phase==='operation'&&reads++===0)return expected;throw Error('actual authority reader unavailable');};
  f.host.httpApi={create:options=>({listen:async()=>{observed=options.readStatus;if(phase==='successor')resolveBound();},close:async()=>{}})};
  f.host.operations=()=>({execute:async()=>{throw Error('operation failed after possible authority change');}});
  f.host.workerApi.create=options=>({environment:()=>({}),runCold:async()=>phase==='successor'?{id:'a'.repeat(48),operation:'export',base:f.base,listener:f.context.listener,expectedAuthority:expected,backupPath:'actual-backup'}:options.execute({id:'a'.repeat(48),operation:'export',base:f.base,serve:f.context.listener,expectedAuthority:expected,ownership:f.ownership,assertExclusive:()=>true})});
  const runtime=Runtime.create(f.host);runtime.runCold().catch(()=>{});
  if(phase==='successor')await bound;else for(let count=0;count<30&&(!observed||observed().job.state==='handoff');count++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(observed().authority,null,phase+' status must become typed unavailable');assert.equal(observed().job.state,phase==='successor'?'uncertain':'failed');
});

for(const kind of ['deep','cycle','function'])test('independent helper uncertainty cannot disappear through '+kind+' causes',async t=>{
 const f=await fixture(t);let error;
 if(kind==='deep'){error={helperMayStillRun:true};for(let i=0;i<20;i++)error={cause:error};}
 if(kind==='cycle'){error={};error.cause=error;}
 if(kind==='function'){error=function nativeError(){};error.helperMayStillRun=true;}
 await assert.rejects(()=>f.runtime.guardNative(async()=>{throw error;}),e=>e===error);
 assert.equal(f.runtime.helperMayStillRun(),true,'unknown native outcome must retain exclusion');
 assert.equal(await f.runtime.captureServe(f.context),false);
});
