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
 const host={process:{pid:12345,ppid:88,env:{}},workerHooks,claim:state.claim,legacyNoClaim:state.claim===undefined,workerApi:{create:args=>{state.creates.push(args);return {start:async value=>{state.starts.push(value);return {ready:Promise.resolve()};},runCold:async()=>({phase:'cancelled'})};},spawnCold:()=>{throw Error('unexpected spawn');},processChannel:()=>({parentConnected:()=>false}),waitForProcessExit:async()=>{}},
  httpApi:{create:()=>{throw Error('unexpected cold HTTP');}},resultApi:Result,controlApi:Control,
  base:async()=>base,canonical:async value=>p.resolve(value).toLowerCase(),acquire:async()=>ownership,readAuthority:async()=>{state.reads++;return Manifest.create({base}).readActive();},operations:()=>({execute:async()=>{throw Error('unexpected execute');}}),
  assertOwnership:(owner,requested)=>sourceKeeper.assertExclusive(owner)&&GenuineOwnership.owns(owner,requested),withColdSource:(context,work)=>scoped(context.ownership,work),withWarmSource:(_request,work)=>scoped(ownership,work),
  adaptersReady:()=>state.ready,helperMayStillRun:()=>state.helpers,isRetired:()=>state.retired===true,
  retiredReceipt:()=>state.retired===true?{phase:'retired',admitted:0,writers:0,dirty:0,busy:{}}:null,
  stopUncommitted:async()=>{},exit:async code=>state.exits.push(code),command:mode=>({command:process.execPath,args:['fixture',mode]}),startFreshServe:async()=>{state.fresh++;}};
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
});

const successorInput=(f,extra={})=>({schema:1,id:'a'.repeat(48),parentPid:88,nonce:'b'.repeat(64),base:f.base,
  serve:{host:'127.0.0.1',port:f.context.listener.port},expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},...extra});
const successorChannel=(f,body,{send=async()=>{},parentPid=88,connected=true}={})=>({parentConnected:()=>connected,parentPid:()=>parentPid,
  readInput:async()=>Buffer.from(JSON.stringify(typeof body==='function'?body(f):body)),send});
test('successor preparation rejects bad input, parent, base and listener before any serve entry',async t=>{
 const cases=[
  ['no live parent',f=>({channel:{parentConnected:()=>false,parentPid:()=>88,readInput:async()=>Buffer.from('{}')},base:f.base})],
  ['extra secret field',f=>({channel:successorChannel(f,successorInput(f,{password:'MUST NOT ENTER SUCCESSOR'})),base:f.base})],
  ['wrong parent',f=>({channel:successorChannel(f,successorInput(f),{parentPid:89}),base:f.base})],
  ['forged listener host',f=>({channel:successorChannel(f,successorInput(f,{serve:{host:'0.0.0.0',port:1}})),base:f.base})],
  ['foreign base',f=>({channel:successorChannel(f,successorInput(f)),base:p.join(f.base,'other')})],
  ['relative base',f=>({channel:successorChannel(f,successorInput(f)),base:'relative/base'})],
 ];
 for(const [name,make] of cases){
  const f=await fixture(t),{channel,base}=make(f);
  await assert.rejects(()=>f.runtime.prepareSuccessor(channel,{base}),error=>/^work_data_setup\.successor_(unavailable|input_invalid)$/.test(error.code),name);
  assert.equal(f.state.fresh,0,name+' must not enter a fresh serve');
  assert.equal(f.workerHooks.start,undefined);
 }
});
test('successor preparation registers exactly one strict-port options object and only one pending attempt',async t=>{
 const f=await fixture(t),first=successorChannel(f,successorInput(f));
 const options=await f.runtime.prepareSuccessor(first,{base:f.base});
 assert.deepEqual({...options},{host:'127.0.0.1',port:String(f.context.listener.port)});
 assert.equal(f.runtime.strictSamePort(options),true);
 assert.equal(f.runtime.strictSamePort({...options}),false,'a clone of the options is not the strict ticket');
 assert.equal(f.runtime.strictSamePort({host:'127.0.0.1',port:String(f.context.listener.port)}),false);
 await assert.rejects(()=>f.runtime.prepareSuccessor(successorChannel(f,successorInput(f)),{base:f.base}),{code:'work_data_setup.successor_unavailable'});
 await assert.rejects(()=>f.runtime.completeSuccessor(),{code:'work_data_setup.successor_not_captured'});
});
test('successor completion never publishes serve-ready without a captured warm server and a readable matching result',async t=>{
 const hole=await fixture(t),emptySent=[],emptyChannel=successorChannel(hole,successorInput(hole),{send:async message=>emptySent.push(message)});
 await assert.rejects(()=>hole.runtime.completeSuccessor(),{code:'work_data_setup.successor_not_prepared'});
 await hole.runtime.prepareSuccessor(emptyChannel,{base:hole.base});
 await assert.rejects(()=>hole.runtime.completeSuccessor(),{code:'work_data_setup.successor_not_captured'});
 assert.equal(emptySent.length,0);
 const f=await fixture(t),sent=[],channel=successorChannel(f,successorInput(f),{send:async message=>sent.push(message)});
 await f.runtime.prepareSuccessor(channel,{base:f.base});
 await f.runtime.captureServe(f.context);
 await assert.rejects(()=>f.runtime.completeSuccessor(),{code:'work_data_setup.successor_result_unreadable'});
 assert.equal(sent.length,0,'a failed completion must not announce a second owner');
 await assert.rejects(()=>f.runtime.completeSuccessor(),{code:'work_data_setup.successor_not_prepared'});
 assert.equal(sent.length,0);
});
test('successor preparation runs before the single production configure and keeps the same strict ticket',async t=>{
 const f=await fixture(t),hooks={},Worker=load('13ai-work-data-worker.js','WorkDataMaintenanceWorker'),Http=load('13al-work-data-maintenance-http.js','WorkDataMaintenanceHttp');
 vm.runInNewContext(fs.readFileSync(runtimeSource,'utf8'),{require,Buffer,process,http,crypto:require('node:crypto'),URL,setTimeout,clearTimeout,
  WorkDataMaintenanceRuntimeHooks:hooks,WorkDataMaintenanceWorker:Worker,WorkDataMaintenanceHttp:Http,WorkDataMaintenanceResult:Result,WorkDataMaintenanceControl:Control,ServerOwnership:GenuineOwnership,WorkDataManifest:Manifest});
 assert.equal(hooks.workerReady(),false);
 const options=await hooks.prepareSuccessor(successorChannel(f,successorInput(f)),{base:f.base});
 assert.equal(hooks.strictSamePort(options),true,'the pre-configure ticket must remain strict for the later listener');
 assert.equal(hooks.strictSamePort({...options}),false);
 hooks.configure(f.host);
 assert.equal(hooks.strictSamePort(options),true,'configure must not replace the registered ticket');
 assert.throws(()=>hooks.configure(f.host),{code:'work_data_setup.runtime_already_configured'});
 assert.equal(hooks.workerReady(),true);
 await assert.rejects(()=>hooks.completeSuccessor(),{code:'work_data_setup.successor_not_captured'});
 await assert.rejects(()=>hooks.prepareSuccessor(successorChannel(f,successorInput(f)),{base:f.base}),{code:'work_data_setup.successor_unavailable'});
});
test('production warm and cold entries require a claim API and inject that exact capability',async t=>{
 const f=await fixture(t);delete f.host.legacyNoClaim;
 await f.runtime.captureServe(f.context);
 assert.throws(()=>f.runtime.activateServe(),{code:'work_data_setup.claim_unavailable'});
 assert.equal(f.workerHooks.start,undefined);
 const claim={inspect:async()=>({present:false}),write:async()=>({}),remove:async()=>true,classify:async()=>'absent'};
 const runtime=Runtime.create({...f.host,claim});
 await runtime.captureServe(f.context);
 assert.equal(runtime.activateServe(),true);
 assert.equal(f.state.creates.at(-1).claim,claim,'the warm worker gets the same claim API identity');
 const g=await fixture(t);delete g.host.legacyNoClaim;
 await assert.rejects(()=>g.runtime.runCold(),{code:'work_data_setup.claim_unavailable'});
 assert.equal(g.state.creates.length,0);
 // The cold body is reached through the exact seam 13ai uses, and still refuses
 // to read or mutate the base once its claim writer disappears.
 const h=await fixture(t),created=[];delete h.host.legacyNoClaim;
 h.host.claim=claim;h.host.workerApi.create=options=>{created.push(options);return {runCold:async()=>({phase:'cancelled'}),environment:()=>({})};};
 const cold=Runtime.create(h.host);
 await cold.runCold({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.alloc(0)});
 const execute=created.at(-1).execute;assert.equal(created.at(-1).claim,claim);
 delete h.host.claim;
 await assert.rejects(()=>execute({id:'a'.repeat(48),operation:'export',base:h.base,serve:h.context.listener,
   expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},ownership:h.ownership,assertExclusive:()=>true}),{code:'work_data_setup.claim_unavailable'});
 assert.equal(h.state.reads,0,'a cold operation without a claim writer must not even read the base');
});
test('cold operation body forwards the bounded claim capability from the worker unchanged',async t=>{
 const expected={generation:0,id:null,mode:'plain',sha256:null};
 const capability=Object.freeze({finish:async()=>{},abandon:async()=>{}});
 const f=await fixture(t),created=[];let seen;
 f.host.claim={inspect:async()=>({present:false}),write:async()=>({}),remove:async()=>true,classify:async()=>'absent'};
 const runtime=Runtime.create(f.host);
 f.host.workerApi.create=options=>{created.push(options);return {runCold:async()=>({phase:'cancelled'}),environment:()=>({})};};
 await runtime.runCold({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.alloc(0)});
 f.host.readAuthority=async()=>({generation:0,id:null,mode:'plain',proof:{sha256:null}});
 f.host.httpApi={create:()=>({listen:async()=>{},close:async()=>{}})};
 f.host.operations=()=>({execute:async context=>{seen=context;throw Error('synthetic native failure');}});
 created.at(-1).execute({id:'a'.repeat(48),operation:'export',base:f.base,serve:f.context.listener,expectedAuthority:expected,
   ownership:f.ownership,assertExclusive:()=>true,claim:capability}).catch(()=>{});
 for(let count=0;count<40&&!seen;count++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(seen.claim,capability,'the worker-built finish/abandon capability must travel unchanged');
 assert.deepEqual(Object.keys(seen.claim).sort(),['abandon','finish']);
});
test('exitParent needs a real retired receipt and never a boolean promotion',async t=>{
 const f=await fixture(t);f.host.isRetired=()=>true;delete f.host.retiredReceipt;
 const runtime=Runtime.create(f.host);
 await runtime.captureServe(f.context);runtime.activateServe();
 await assert.rejects(()=>f.state.creates.at(-1).exitParent(),{code:'work_data_setup.handoff_not_retired'});
 assert.equal(f.state.exits.length,0);
 for(const receipt of [{phase:'retired',admitted:1},{phase:'retired',busy:{turns:1}},{phase:'idle'},null,'retired',true]){
  const g=await fixture(t);g.host.retiredReceipt=()=>receipt;
  const instance=Runtime.create(g.host);await instance.captureServe(g.context);instance.activateServe();
  await assert.rejects(()=>g.state.creates.at(-1).exitParent(),{code:'work_data_setup.handoff_not_retired'});
  assert.equal(g.state.exits.length,0);
 }
});
test('ordinary boot classifies the handoff claim only after the intent gate and cleans just inert or complete records',async t=>{
 for(const [outcome,code] of [['absent',null],['inert',null],['complete',null],['pending','work_data_setup.handoff_pending'],['armed','work_data_setup.boot_control_pending']]){
  const f=await fixture(t),removed=[],seen=[],receipt={base:f.base,name:'claim-v1.json',sha256:'a'.repeat(64),dev:'1',ino:'2'};
  f.host.claim={classify:async args=>{seen.push(args);return outcome;},inspect:async()=>({present:true,receipt}),
    write:async()=>receipt,remove:async value=>{removed.push(value);return true;}};
  const runtime=Runtime.create(f.host);
  if(code)await assert.rejects(()=>runtime.inspectBoot({base:f.base,ownership:f.ownership}),{code},outcome);
  else assert.equal(await runtime.inspectBoot({base:f.base,ownership:f.ownership}),true,outcome);
  assert.deepEqual(JSON.parse(JSON.stringify(seen.map(value=>({hasIntent:value.hasIntent,hasResult:value.hasResult,base:value.base.toLowerCase()})))),[{hasIntent:false,hasResult:null,base:f.base.toLowerCase()}]);
  assert.equal(removed.length,code||outcome==='absent'?0:1,outcome+' removal count');
  if(removed.length)assert.equal(removed[0],receipt,'only the inspected receipt may authorize the TEMP cleanup');
  assert.equal(f.state.reads,0,'ordinary boot must not read or repair base authority to classify a claim');
 }
 const f=await fixture(t),control=p.join(f.base,'.work-data');await io.mkdir(control);
 const bytes=JSON.stringify({schema:1,id:'a'.repeat(48),operation:'enable',phase:'prepared',createdAt:new Date().toISOString(),expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backup:{path:p.join(f.root,'backup'),sha256:'b'.repeat(64)},candidate:null});
 await io.writeFile(p.join(control,'maintenance-v1.json'),bytes);
 let classified=0;f.host.claim={classify:async()=>{classified++;return 'inert';},inspect:async()=>{classified++;return {present:false};},
  write:async()=>assert.fail('no claim write belongs to boot'),remove:async()=>assert.fail('an unfinished intent must never be cleaned')};
 const runtime=Runtime.create(f.host);
 await assert.rejects(()=>runtime.inspectBoot({base:f.base,ownership:f.ownership}),{code:'work_data_setup.intent_pending'});
 assert.equal(classified,0,'the intent gate precedes any claim classification');
 assert.equal(await io.readFile(p.join(control,'maintenance-v1.json'),'utf8'),bytes);
 assert.deepEqual(await io.readdir(control),['maintenance-v1.json']);
});

// Real 13av owner, real TERM claim record and real result record: the boot gate must
// hand the owner a digest, so a stale result can never finish a new handoff.
const claimHelpers=()=>{
 const HandoffClaim=load('13av-work-data-handoff-claim.js','WorkDataHandoffClaim'),createdAt='2026-10-01T00:00:00.000Z';
 const setup=async t=>{
  const f=await fixture(t),temp=p.join(f.root,'temp');await io.mkdir(temp);
  const claim=HandoffClaim.create({temp,flush:async()=>{} });f.host.claim=claim;
  const stat=await io.lstat(f.base,{bigint:true}),base=await f.host.canonical(f.base);
  return {f,claim,temp,base,baseIdentity:{dev:String(stat.dev),ino:String(stat.ino)}};
 };
 const record=(ctx,patch={})=>({schema:1,base:ctx.base,baseIdentity:ctx.baseIdentity,id:'a'.repeat(48),nonce:'b'.repeat(64),
  parentPid:88,childPid:77777,operation:'export',serve:{host:'127.0.0.1',port:ctx.f.context.listener.port},
  phase:'armed',createdAt,updatedAt:createdAt,...patch});
 const own=async(ctx,id)=>{let receipt=await ctx.claim.write(record(ctx,{id}),null);
  for(const [phase,stamp] of [['committed','2026-10-01T00:00:01.000Z'],['owned','2026-10-01T00:00:02.000Z']])
   receipt=await ctx.claim.write(record(ctx,{id,phase,updatedAt:stamp}),receipt);
  return receipt;};
 const writeResult=async(ctx,{id='a'.repeat(48),operation='export'}={})=>{
  const control=p.join(ctx.f.base,'.work-data');await io.mkdir(control,{recursive:true});
  const authority={generation:0,id:null,mode:'plain',sha256:null};
  const value={schema:1,id,operation,state:'verified',finishedAt:createdAt,sourceAuthority:authority,authority,
   backup:{path:p.join(ctx.f.root,'ruyi-work-data-'+id+'.ruyi-backup'),sha256:'c'.repeat(64),bytes:1024,identity:{dev:'1',ino:'2'}}};
  const bytes=Buffer.from(JSON.stringify(value));await io.writeFile(p.join(control,'maintenance-result-v1.json'),bytes);
  return bytes;};
 return {setup,record,own,writeResult};
};
const {setup:claimSetup,own:ownClaim,writeResult:writeClaimResult}=claimHelpers();
test('real 13av keeps a claim when the stored result belongs to another job',async t=>{
 const ctx=await claimSetup(t);
 await ownClaim(ctx,'a'.repeat(48));await writeClaimResult(ctx,{id:'d'.repeat(48)});
 const before=await ctx.claim.inspect({base:ctx.base});assert.equal(before.present,true);
 // Record exactly what the boot gate asks the owner, without changing the owner.
 let seen=null;const realClassify=ctx.claim.classify;
 ctx.f.host.claim={...ctx.claim,classify:async observation=>{seen=observation;return realClassify(observation);}};
 const runtime=Runtime.create(ctx.f.host);
 await assert.rejects(()=>runtime.inspectBoot({base:ctx.f.base,ownership:ctx.f.ownership}),{code:'work_data_setup.handoff_pending'});
 assert.equal(seen.hasIntent,false);
 assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(seen.hasResult).sort())),['id','operation'],'the boot gate must hand the owner the exact {id,operation} digest');
 assert.deepEqual(JSON.parse(JSON.stringify(seen.hasResult)),{id:'d'.repeat(48),operation:'export'},'the digest is the stored result, not the claim identity');
 const after=await ctx.claim.inspect({base:ctx.base});
 assert.equal(after.present,true,'the stale result must leave the handoff record in place');
 assert.equal(after.value.id,'a'.repeat(48));
 assert.equal(after.value.phase,'owned');
 assert.equal(after.receipt.sha256,before.receipt.sha256,'the stale result must leave the record byte-identical');
 assert.equal(after.receipt.dev,before.receipt.dev);assert.equal(after.receipt.ino,before.receipt.ino);
});
test('real 13av cleans the claim for the one matching owned result',async t=>{
 const ctx=await claimSetup(t);
 await ownClaim(ctx,'a'.repeat(48));await writeClaimResult(ctx,{id:'a'.repeat(48)});
 const before=await ctx.claim.inspect({base:ctx.base});assert.equal(before.present,true);
 const runtime=Runtime.create(ctx.f.host);
 assert.equal(await runtime.inspectBoot({base:ctx.f.base,ownership:ctx.f.ownership}),true);
 assert.equal((await ctx.claim.inspect({base:ctx.base})).present,false,'a matching owned result is the only completion proof');
});
test('real 13av claim survives an unfinished intent and is never classified',async t=>{
 const ctx=await claimSetup(t),control=p.join(ctx.f.base,'.work-data');await io.mkdir(control,{recursive:true});
 const intent=Buffer.from(JSON.stringify({schema:1,id:'e'.repeat(48),operation:'enable',phase:'prepared',createdAt:'2026-10-01T00:00:00.000Z',
  expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backup:{path:p.join(ctx.f.root,'backup'),sha256:'f'.repeat(64)},candidate:null}));
 await io.writeFile(p.join(control,'maintenance-v1.json'),intent);
 await ownClaim(ctx,'a'.repeat(48));const resultBytes=await writeClaimResult(ctx,{id:'a'.repeat(48)});
 const before=await ctx.claim.inspect({base:ctx.base});assert.equal(before.present,true);
 let classified=0;ctx.f.host.claim={...ctx.claim,classify:async observation=>{classified++;return ctx.claim.classify(observation);}};
 const runtime=Runtime.create(ctx.f.host);
 await assert.rejects(()=>runtime.inspectBoot({base:ctx.f.base,ownership:ctx.f.ownership}),{code:'work_data_setup.intent_pending'});
 assert.equal(classified,0,'the intent gate must precede any claim classification');
 const after=await ctx.claim.inspect({base:ctx.base});
 assert.equal(after.present,true,'C10/C11 must not be cleaned through the claim');
 assert.equal(after.receipt.sha256,before.receipt.sha256,'the unfinished intent must leave the record byte-identical');
 assert.deepEqual(await io.readFile(p.join(control,'maintenance-v1.json')),intent);
 assert.deepEqual(await io.readFile(p.join(control,'maintenance-result-v1.json')),resultBytes);
});
