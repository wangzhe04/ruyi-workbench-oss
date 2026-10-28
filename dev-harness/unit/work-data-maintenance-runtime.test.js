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

// ---------------------------------------------------------------------------
// B2: fresh-root activation. A restore successor serves the committed target
// root; the ordinary serve/CLI paths never read or remove that TEMP receipt.
// ---------------------------------------------------------------------------
const nodeCrypto=require('node:crypto');
// Runtime values are created inside their own vm realm, so structural assertions
// compare plain JSON copies instead of cross-realm prototypes.
const plain=value=>JSON.parse(JSON.stringify(value));
const SHA=bytes=>nodeCrypto.createHash('sha256').update(bytes).digest('hex');
const activationStore=()=>{
 const rows=new Map(),calls={write:[],inspect:[],remove:[],order:[]};
 return {rows,calls,
  async write(value){calls.write.push(value);calls.order.push('activation-write');
   if(rows.has(value.base))throw Object.assign(Error('work_data_claim.claim_exists'),{code:'work_data_claim.claim_exists'});
   const receipt=Object.freeze({base:value.base,sha256:SHA(Buffer.from(JSON.stringify(value))),dev:'11',ino:'22'});
   rows.set(value.base,{value,receipt});return receipt;},
  async inspect({base}={}){calls.inspect.push(base);const row=rows.get(base);
   return row?{present:true,value:row.value,receipt:row.receipt}:{present:false};},
  async remove(receipt){calls.remove.push(receipt);const row=rows.get(receipt.base);
   if(!row||row.receipt.sha256!==receipt.sha256||row.receipt.dev!==receipt.dev||row.receipt.ino!==receipt.ino)
    throw Object.assign(Error('work_data_claim.claim_changed'),{code:'work_data_claim.claim_changed'});
   rows.delete(receipt.base);return true;}};
};
const activationValue=async(f,{id='a'.repeat(48),nonce='b'.repeat(64),parentPid=88,resultSha256='c'.repeat(64),base,patch={}}={})=>({
  schema:1,activation:'separate-fresh-root',operation:'restore',base:base||await f.host.canonical(f.base),baseIdentity:{dev:'1',ino:'2'},
  authority:{generation:0,id:null,mode:'plain',sha256:null},id,nonce,parentPid,resultSha256,createdAt:'2026-10-01T00:00:00.000Z',...patch});
const sealRecord=value=>Object.freeze({base:value.base,sha256:SHA(Buffer.from(JSON.stringify(value))),dev:'11',ino:'22'});
const activationInput=(f,extra={})=>successorInput(f,{activation:{kind:'separate-fresh-root',resultSha256:'c'.repeat(64)},...extra});
const restoreEnvelope=(f,{target,identity,authority,resultSha256='c'.repeat(64)}={})=>({id:'a'.repeat(48),operation:'restore',base:f.base,
  listener:{...f.context.listener},expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupPath:p.join(f.root,'backup'),
  activationTarget:{target:target||p.join(f.root,'target'),identity:identity||{dev:'1',ino:'2'},
    authority:authority||{generation:0,id:null,mode:'plain',sha256:null},resultSha256}});
const exportEnvelope=f=>({id:'a'.repeat(48),operation:'export',base:f.base,listener:{...f.context.listener},
  expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupPath:p.join(f.root,'backup')});
const fakeSuccessor=state=>{
 const {EventEmitter}=require('node:events'),child=new EventEmitter();
 child.pid=555;child.unref=()=>{state.unrefs++;};
 child.stdin={once(){},end(bytes,callback){
   const input=JSON.parse(Buffer.from(bytes).toString('utf8'));state.inputs.push(input);if(callback)callback();
   child.emit('message',{schema:1,kind:'serve-ready',id:input.id,nonce:input.nonce,pid:child.pid,port:input.serve.port,
     host:input.serve.host,authority:{...input.expectedAuthority}});}};
 return child;
};
// Drives the real runCold -> launchSuccessor seam with a stubbed worker body.
const successorRun=async(f,{result,activation,http,events=[]}={})=>{
 const state={inputs:[],envs:[],spawns:0,unrefs:0,acquired:[],events};
 if(activation!==undefined)f.host.activation=activation;else delete f.host.activation;
 f.host.acquire=async roots=>{state.acquired.push(roots);return f.ownership;};
 f.host.httpApi=http||{create:options=>{state.status=options.readStatus;return{listen:async()=>{},close:async()=>{}};}};
 f.host.workerApi.create=()=>({environment:base=>{state.envs.push(base);return{RUYI_HOME:base};},
   runCold:async()=>result,execute:async()=>{throw Error('unexpected cold execute');}});
 f.host.workerApi.spawnCold=(spec,env)=>{state.spawns++;state.spawnSpec=spec;state.spawnEnv=env;state.events.push('spawn');return fakeSuccessor(state);};
 const runtime=Runtime.create(f.host);
 state.pending=runtime.runCold({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.alloc(0)});
 return state;
};
const settle=async promise=>Promise.race([promise.then(value=>({value}),error=>({error})),
  new Promise(resolve=>setTimeout(()=>resolve({pending:true}),120))]);
// A real result record plus a real backup: executeBody's activation binding is only
// accepted against the record 01ae actually reads back.
const recordHandoff=async(f,{operation='restore',target,restoredTarget,restartRoot,identity,authority}={})=>{
 const id='a'.repeat(48),recordAuthority={generation:0,id:null,mode:'plain',sha256:null};
 f.host.readAuthority=async()=>({generation:0,id:null,mode:'plain',proof:{sha256:null}});
 const backupFile=p.join(f.root,'ruyi-work-data-'+id+'.ruyi-backup'),backupBytes=Buffer.from('{"sealed":true}');
 await io.writeFile(backupFile,backupBytes);
 const stat=await io.lstat(backupFile,{bigint:true});
 const backup={path:backupFile,sha256:SHA(backupBytes),bytes:backupBytes.length,identity:{dev:String(stat.dev),ino:String(stat.ino)}};
 const targetPath=target||p.join(f.root,'target');await io.mkdir(targetPath,{recursive:true});
 const targetStat=await io.lstat(targetPath,{bigint:true});
 const record={schema:1,id,operation,state:'verified',finishedAt:'2026-10-01T00:00:00.000Z',
   sourceAuthority:{...recordAuthority},authority:{...recordAuthority},backup,
   ...(operation==='restore'?{restored:{target:restoredTarget||targetPath,activation:'separate-fresh-root'}}:{})};
 const control=p.join(f.base,'.work-data');await io.mkdir(control,{recursive:true});
 const recordBytes=Buffer.from(JSON.stringify(record));await io.writeFile(p.join(control,'maintenance-result-v1.json'),recordBytes);
 const result={id,operation,state:'verified',backup:{path:backupFile},restartRoot:restartRoot||f.base,publication:'fresh-process-required',profile:{},
   ...(operation==='restore'?{restored:record.restored,activation:'separate-fresh-root',
     activationTarget:{target:targetPath,identity:identity||{dev:String(targetStat.dev),ino:String(targetStat.ino)},
       authority:authority||{...recordAuthority}}}:{})};
 return {id,record,recordBytes,result,target:targetPath,targetIdentity:{dev:String(targetStat.dev),ino:String(targetStat.ino)},recordAuthority};
};
const coldExecute=async(f,{result}={})=>{
 const state={};
 f.host.httpApi={create:options=>{state.status=options.readStatus;return{listen:async()=>{},close:async()=>{}};}};
 f.host.operations=()=>({execute:async()=>result});
 const runtime=Runtime.create(f.host);
 await runtime.runCold({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.alloc(0)});
 return {execute:f.state.creates.at(-1).execute,state};
};
const coldContext=(f,id,operation)=>({id,operation,base:f.base,serve:{...f.context.listener},
  expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},ownership:f.ownership,assertExclusive:()=>true});

test('restore result binds one strict activation target and the source result proof',async t=>{
 const f=await fixture(t),h=await recordHandoff(f),{execute}=await coldExecute(f,{result:h.result});
 const value=await execute(coldContext(f,h.id,'restore'));
 assert.equal(value.operation,'restore');
 assert.equal(value.base,f.base,'the source stays the restart root of the cold envelope');
 assert.deepEqual(plain(value.activationTarget),{target:await f.host.canonical(h.target),identity:{...h.targetIdentity},
   authority:{...h.recordAuthority},resultSha256:SHA(h.recordBytes)});
 assert.deepEqual(Object.keys(value.activationTarget).sort(),['authority','identity','resultSha256','target']);
});
test('non-restore handoff carries no activation target and keeps its old envelope',async t=>{
 const f=await fixture(t),h=await recordHandoff(f,{operation:'export'}),{execute}=await coldExecute(f,{result:h.result});
 const value=await execute(coldContext(f,h.id,'export'));
 assert.deepEqual(Object.keys(value).sort(),['backupPath','base','expectedAuthority','id','listener','operation']);
 assert.equal(Object.hasOwn(value,'activationTarget'),false);
});
test('restore result refuses activation target drift instead of handing off',async t=>{
 const cases=[
  ['target differs from the record','result_unverified',async f=>{const other=p.join(f.root,'other-target');await io.mkdir(other);return recordHandoff(f,{restoredTarget:other});}],
  ['target is the source root','result_unverified',async f=>recordHandoff(f,{target:f.base,restoredTarget:f.base})],
  ['identity is not decimal','result_unverified',async f=>recordHandoff(f,{identity:{dev:'x1',ino:'2'}})],
  ['identity is numeric','result_unverified',async f=>recordHandoff(f,{identity:{dev:1,ino:2}})],
  ['authority is truncated','result_unverified',async f=>recordHandoff(f,{authority:{generation:0,id:null,mode:'plain'}})],
  ['authority identity is unproven','result_unverified',async f=>recordHandoff(f,{authority:{generation:1,id:'a'.repeat(48),mode:'encrypted',sha256:null}})],
  ['restart root moved to the target','result_invalid',async f=>{const h=await recordHandoff(f);h.result.restartRoot=h.result.activationTarget.target;return h;}],
 ];
 for(const [name,code,make] of cases){
  const f=await fixture(t),h=await make(f),{execute,state}=await coldExecute(f,{result:h.result});
  const outcome=await settle(execute(coldContext(f,h.id,'restore')));
  assert.equal(outcome.pending,true,name+' must never hand off');
  assert.equal(state.status().job.error,'work_data_setup.'+code,name);
  assert.equal(state.status().job.state,'failed',name);
 }
});
test('restore successor writes the receipt before spawn and serves the target root',async t=>{
 const f=await fixture(t),store=activationStore(),result=restoreEnvelope(f);
 const state=await successorRun(f,{result,activation:store,events:store.calls.order});
 await state.pending;
 assert.equal(state.spawns,1);assert.deepEqual(state.events,['activation-write','spawn'],'the receipt precedes the child');
 const target=await f.host.canonical(result.activationTarget.target);
 assert.equal(state.envs.at(-1),target,'RUYI_HOME must be the target, never the source');
 assert.deepEqual(f.state.exits,[0]);
 const input=state.inputs[0];
 assert.deepEqual(Object.keys(input).sort(),['activation','base','expectedAuthority','id','nonce','parentPid','schema','serve']);
 assert.equal(input.base,target);assert.deepEqual(plain(input.expectedAuthority),{...result.activationTarget.authority});
 assert.deepEqual(input.activation,{kind:'separate-fresh-root',resultSha256:'c'.repeat(64)});
 const written=store.calls.write[0];
 assert.deepEqual(Object.keys(written).sort(),['activation','authority','base','baseIdentity','createdAt','id','nonce','operation','parentPid','resultSha256','schema']);
 assert.equal(written.base,target);assert.equal(written.operation,'restore');assert.equal(written.activation,'separate-fresh-root');assert.equal(written.schema,1);
 assert.deepEqual(plain(written.baseIdentity),{dev:'1',ino:'2'});assert.deepEqual(plain(written.authority),{...result.activationTarget.authority});
 assert.equal(written.id,result.id);assert.equal(written.nonce,input.nonce,'the receipt binds the successor nonce');
 assert.equal(written.parentPid,12345,'the receipt binds the cold parent pid');
 assert.equal(written.resultSha256,'c'.repeat(64));assert.equal(new Date(written.createdAt).toISOString(),written.createdAt);
});
test('non-restore successor keeps the source root and never touches activation',async t=>{
 const f=await fixture(t),store=activationStore(),state=await successorRun(f,{result:exportEnvelope(f),activation:store,events:store.calls.order});
 await state.pending;
 assert.equal(state.spawns,1);assert.deepEqual(store.calls.order,['spawn']);
 assert.equal(store.calls.write.length,0);assert.equal(store.calls.inspect.length,0);
 assert.equal(state.envs.at(-1),f.base);assert.equal(Object.hasOwn(state.inputs[0],'activation'),false);
 assert.deepEqual(f.state.exits,[0]);
});
test('a restore envelope without an activation target refuses instead of starting a source successor',async t=>{
 // executeBody never emits this envelope, but the launcher must not treat a lost
 // target as permission to hand off to the source root.
 const f=await fixture(t),store=activationStore(),result=restoreEnvelope(f);
 delete result.activationTarget;
 assert.equal(Object.hasOwn(result,'activationTarget'),false);
 const state=await successorRun(f,{result,activation:store});
 const outcome=await settle(state.pending);
 assert.equal(outcome.pending,true);
 assert.equal(state.spawns,0,'no successor child is spawned');
 assert.equal(state.envs.length,0,'no RUYI_HOME is even derived for a source fallback');
 assert.deepEqual(f.state.exits,[],'the cold parent never exits for a refused handoff');
 assert.equal(store.calls.write.length,0,'no activation receipt is written without a target');
 assert.equal(store.calls.remove.length,0);
 assert.equal(state.status().job.error,'work_data_setup.activation_target_missing');
 assert.equal(state.status().job.state,'uncertain');
 assert.deepEqual(plain(state.acquired[0]),[f.base],'the diagnostic hold reports the envelope base; it is not a successor root');
});
test('restore successor refuses target==source and a missing activation owner without falling back',async t=>{
 let f=await fixture(t);
 let state=await successorRun(f,{result:restoreEnvelope(f,{target:f.base}),activation:activationStore()});
 let outcome=await settle(state.pending);
 assert.equal(outcome.pending,true);
 assert.equal(state.spawns,0);assert.deepEqual(f.state.exits,[]);
 assert.equal(state.status().job.error,'work_data_setup.successor_target_invalid');
 assert.deepEqual(plain(state.acquired[0]),[f.base],'the failure is reported against the actual base');

 f=await fixture(t);const target=p.join(f.root,'target');await io.mkdir(target);
 state=await successorRun(f,{result:restoreEnvelope(f,{target})});
 outcome=await settle(state.pending);
 assert.equal(outcome.pending,true);
 assert.equal(state.spawns,0);assert.deepEqual(f.state.exits,[]);
 assert.equal(state.status().job.error,'work_data_setup.activation_unavailable','a missing owner fails closed');
 assert.deepEqual(plain(state.acquired[0]),[target],'the failed handoff is reported against the target, not the source');
 assert.equal(Object.hasOwn(f.host,'activation'),false);
});
test('restore successor keeps the receipt as diagnosis and never retries a failed launch',async t=>{
 let f=await fixture(t);
 const failing={write:async()=>{throw Object.assign(Error('modeled write failure'),{code:'work_data_setup.activation_failed'});},
   inspect:async()=>({present:false}),remove:async()=>true};
 let state=await successorRun(f,{result:restoreEnvelope(f),activation:failing});
 let outcome=await settle(state.pending);
 assert.equal(outcome.pending,true);
 assert.equal(state.spawns,0);assert.deepEqual(f.state.exits,[]);
 assert.equal(state.status().job.error,'work_data_setup.activation_failed');

 f=await fixture(t);const store=activationStore();let status=null,spawns=0;
 f.host.activation=store;f.host.acquire=async()=>f.ownership;
 f.host.httpApi={create:options=>{status=options.readStatus;return{listen:async()=>{},close:async()=>{}};}};
 f.host.workerApi.create=()=>({environment:base=>({RUYI_HOME:base}),runCold:async()=>restoreEnvelope(f),execute:async()=>{throw Error('unexpected');}});
 f.host.workerApi.spawnCold=()=>{spawns++;throw Object.assign(Error('modeled spawn failure'),{code:'work_data_setup.successor_launch_failed'});};
 outcome=await settle(Runtime.create(f.host).runCold({parentConnected:()=>true,parentPid:()=>88,readInput:async()=>Buffer.alloc(0)}));
 assert.equal(outcome.pending,true);
 assert.equal(spawns,1,'a failed launch is never retried');
 assert.equal(store.calls.write.length,1,'the receipt stays behind as diagnosis');
 assert.equal(store.calls.remove.length,0,'a failed launch never removes its own receipt');
 assert.equal(status().job.state,'uncertain');
});
test('successor preparation reads the receipt and binds every field before serve entry',async t=>{
 const f=await fixture(t),store=activationStore(),value=await activationValue(f);
 store.rows.set(value.base,{value,receipt:sealRecord(value)});
 const runtime=Runtime.create({...f.host,activation:store});
 const options=await runtime.prepareSuccessor(successorChannel(f,activationInput(f)),{base:f.base});
 assert.deepEqual({...options},{host:'127.0.0.1',port:String(f.context.listener.port)});
 assert.equal(runtime.strictSamePort(options),true);
 assert.equal(runtime.strictSamePort({...options}),false,'a clone of the options is not the strict ticket');
 assert.equal(store.calls.inspect.length,1,'prepare reads the durable receipt');
 const plan=[
  ['job id',      {id:'d'.repeat(48)}],
  ['nonce',       {nonce:'e'.repeat(64)}],
  ['parent pid',  {parentPid:89}],
  ['operation',   {operation:'export'}],
  ['activation',  {activation:'other-root'}],
  ['schema',      {schema:2}],
  ['authority',   {authority:{generation:0,id:null,mode:'plain',sha256:'f'.repeat(64)}}],
  ['result proof',{resultSha256:'d'.repeat(64)}],
  ['base',        {base:p.join(f.root,'elsewhere')}],
  ['base identity',{baseIdentity:{dev:'x',ino:'2'}}],
  ['created at',  {createdAt:'2026-10-01T00:00:00Z'}],
  ['extra key',   {publication:'fresh-process-required'}],
 ];
 for(const [name,patch] of plan){
  const g=await fixture(t),relay=activationStore(),canonicalBase=await g.host.canonical(g.base);
  const drifted=await activationValue(g,{patch});
  if(name==='base')drifted.base=p.join(g.root,'elsewhere');
  relay.rows.set(canonicalBase,{value:drifted,receipt:sealRecord(drifted)});
  const instance=Runtime.create({...g.host,activation:relay});
  await assert.rejects(()=>instance.prepareSuccessor(successorChannel(g,activationInput(g)),{base:g.base}),
    {code:'work_data_setup.successor_input_invalid'},name+' drift must refuse the input');
  assert.equal(instance.strictSamePort({host:'127.0.0.1',port:String(g.context.listener.port)}),false,name);
 }
 // Input-side activation shape, an absent receipt and a missing owner all refuse.
 const h=await fixture(t),owner=activationStore();
 for(const activation of [{kind:'other-root',resultSha256:'c'.repeat(64)},{kind:'separate-fresh-root',resultSha256:'c'},
   {kind:'separate-fresh-root',resultSha256:'c'.repeat(64),extra:1},{resultSha256:'c'.repeat(64)}]){
  const instance=Runtime.create({...h.host,activation:owner});
  await assert.rejects(()=>instance.prepareSuccessor(successorChannel(h,activationInput(h,{activation})),{base:h.base}),
    {code:'work_data_setup.successor_input_invalid'},'activation input shape');
 }
 const i=await fixture(t),empty=activationStore(),absent=Runtime.create({...i.host,activation:empty});
 await assert.rejects(()=>absent.prepareSuccessor(successorChannel(i,activationInput(i)),{base:i.base}),
  {code:'work_data_setup.successor_input_invalid'},'an absent receipt must refuse');
 assert.equal(absent.strictSamePort({host:'127.0.0.1',port:String(i.context.listener.port)}),false);
 const j=await fixture(t),missing=Runtime.create({...j.host});
 await assert.rejects(()=>missing.prepareSuccessor(successorChannel(j,activationInput(j)),{base:j.base}),
  {code:'work_data_setup.activation_unavailable'},'a missing owner fails closed');
 // The pre-configure production path keeps the same strict portal and only inspects.
 const k=await fixture(t),hooks={},Worker=load('13ai-work-data-worker.js','WorkDataMaintenanceWorker'),Http=load('13al-work-data-maintenance-http.js','WorkDataMaintenanceHttp'),relay=activationStore();
 const canonicalBase=await GenuineOwnership.canonicalRoot(k.base),seeded=await activationValue(k,{base:canonicalBase});
 relay.rows.set(canonicalBase,{value:seeded,receipt:sealRecord(seeded)});
 vm.runInNewContext(fs.readFileSync(runtimeSource,'utf8'),{require,Buffer,process,http,crypto:require('node:crypto'),URL,setTimeout,clearTimeout,
  WorkDataMaintenanceRuntimeHooks:hooks,WorkDataMaintenanceWorker:Worker,WorkDataMaintenanceHttp:Http,WorkDataMaintenanceResult:Result,WorkDataMaintenanceControl:Control,ServerOwnership:GenuineOwnership,WorkDataManifest:Manifest});
 hooks.activation=relay;
 const prepared=await hooks.prepareSuccessor(successorChannel(k,activationInput(k)),{base:k.base});
 assert.equal(hooks.strictSamePort(prepared),true);
 assert.equal(relay.calls.inspect.length,1);
 assert.equal(relay.calls.write.length,0,'the pre-configure path can only inspect the receipt');
});
// Counts every result-adapter entry point so the boot gate cannot hide a read.
const countingResult=()=>{
 const calls={create:0,inspect:0,read:0};
 return {calls,api:{create:options=>{calls.create++;const reader=Result.create(options);
   return{...reader,inspect:async()=>{calls.inspect++;return reader.inspect();},read:async()=>{calls.read++;return reader.read();}};}}};
};
const seenClaim=()=>{const seen=[];return {seen,api:{classify:async observation=>{seen.push(observation);return 'absent';},
  inspect:async()=>({present:false}),write:async()=>assert.fail('boot never writes a claim'),remove:async()=>true}};};
test('activation successor boot never inspects or reads a result on the target and reports no digest',async t=>{
 // The target really carries a valid result record: the activation boot must ignore it.
 const f=await fixture(t),handed=await recordHandoff(f,{operation:'export'}),store=activationStore();
 const result=countingResult(),claim=seenClaim(),value=await activationValue(f);
 f.host.resultApi=result.api;f.host.claim=claim.api;
 store.rows.set(value.base,{value,receipt:sealRecord(value)});
 const runtime=Runtime.create({...f.host,activation:store});
 await runtime.prepareSuccessor(successorChannel(f,activationInput(f)),{base:f.base});
 assert.equal(await runtime.inspectBoot({base:f.base,ownership:f.ownership}),true);
 assert.deepEqual(result.calls,{create:0,inspect:0,read:0},'no target result adapter is even created for a fresh-root successor');
 assert.equal(claim.seen.length,1);
 assert.equal(claim.seen[0].hasIntent,false);
 assert.equal(claim.seen[0].hasResult,null,'the activation path must not hand the claim owner a target digest');
 assert.equal(store.calls.inspect.length,2,'prepare and boot both re-read the receipt');

 // A tampered receipt refuses the boot before any result consultation.
 const tampered=await activationValue(f,{patch:{id:'d'.repeat(48)}});
 store.rows.set(value.base,{value:tampered,receipt:sealRecord(value)});
 await assert.rejects(()=>runtime.inspectBoot({base:f.base,ownership:f.ownership}),{code:'work_data_setup.successor_activation_changed'});
 assert.deepEqual(result.calls,{create:0,inspect:0,read:0});
 assert.equal(claim.seen.length,1,'a refused boot never classifies with an invented digest');
 assert.equal(handed.id,'a'.repeat(48));
});
test('non-activation boot keeps its exact result inspection and digest',async t=>{
 // A successor without activation still inspects and reads the result record.
 const f=await fixture(t),handed=await recordHandoff(f,{operation:'export'});
 const result=countingResult(),claim=seenClaim(),store=activationStore();
 f.host.resultApi=result.api;f.host.claim=claim.api;
 const runtime=Runtime.create({...f.host,activation:store});
 await runtime.prepareSuccessor(successorChannel(f,successorInput(f)),{base:f.base});
 assert.equal(await runtime.inspectBoot({base:f.base,ownership:f.ownership}),true);
 assert.deepEqual(result.calls,{create:1,inspect:1,read:1},'the ordinary successor still inspects and reads exactly once');
 assert.deepEqual(plain(claim.seen[0].hasResult),{id:handed.id,operation:'export'},'the digest is the stored result, never fabricated');
 assert.equal(store.calls.inspect.length,0,'only an activation input reads the receipt');

 // A successor whose result does not match refuses, after inspecting and reading.
 const mismatched=await fixture(t),other=await recordHandoff(mismatched,{operation:'export'});
 const second=countingResult();
 mismatched.host.resultApi=second.api;
 const instance=Runtime.create({...mismatched.host});
 await instance.prepareSuccessor(successorChannel(mismatched,successorInput(mismatched,{id:'d'.repeat(48)})),{base:mismatched.base});
 await assert.rejects(()=>instance.inspectBoot({base:mismatched.base,ownership:mismatched.ownership}),{code:'work_data_setup.successor_result_changed'});
 assert.deepEqual(second.calls,{create:1,inspect:1,read:1});
 assert.equal(other.id,'a'.repeat(48));
});
test('ordinary boot keeps its presence-only inspection and never touches activation',async t=>{
 const f=await fixture(t),handed=await recordHandoff(f,{operation:'export'});
 const result=countingResult(),claim=seenClaim(),store=activationStore(),value=await activationValue(f);
 f.host.resultApi=result.api;f.host.claim=claim.api;
 store.rows.set(value.base,{value,receipt:sealRecord(value)});
 const runtime=Runtime.create({...f.host,activation:store});
 await runtime.captureServe(f.context);
 assert.equal(await runtime.inspectBoot({base:f.base,ownership:f.ownership}),true);
 assert.deepEqual(result.calls,{create:1,inspect:1,read:0},'ordinary boot inspects presence and never reads the record');
 assert.deepEqual(plain(claim.seen[0].hasResult),{id:handed.id,operation:'export'});
 assert.equal(store.calls.inspect.length,0,'ordinary serve must not inspect activation');
 assert.equal(store.calls.remove.length,0,'ordinary serve must not remove activation');
});
test('successor completion proves the receipt and target authority, then consumes it by CAS',async t=>{
 const run=async(f,{send,store}={})=>{
  const owner=store||activationStore(),sent=[],value=await activationValue(f);
  owner.rows.set(value.base,{value,receipt:sealRecord(value)});
  let reads=0;
  const initial={...owner.rows.get(value.base)},host={...f.host,activation:owner,
    resultApi:{create:options=>{const reader=Result.create(options);return{...reader,read:async()=>{reads++;return reader.read();}};}}};
  const runtime=Runtime.create(host);
  await runtime.prepareSuccessor(successorChannel(f,activationInput(f),{send:async message=>{sent.push(message);if(send)await send(message,owner);}}),{base:f.base});
  await runtime.captureServe(f.context);
  return {runtime,host,owner,sent,reads:()=>reads,receipt:initial.receipt};
 };
 let f=await fixture(t),run1=await run(f);
 assert.equal(await run1.runtime.completeSuccessor(),f.server,'serve-ready then a completed handoff');
 assert.equal(run1.sent.length,1);assert.deepEqual(Object.keys(run1.sent[0]).sort(),['authority','host','id','kind','nonce','pid','port','schema']);
 assert.deepEqual(plain(run1.sent[0].authority),{generation:0,id:null,mode:'plain',sha256:null});
 assert.equal(run1.owner.calls.remove.length,1,'the receipt is consumed only after serve-ready');
 assert.equal(run1.owner.calls.remove[0].sha256,run1.receipt.sha256);
 assert.equal(run1.owner.rows.size,0,'the CAS removal drops the record');
 assert.equal(run1.reads(),0,'the target carries no result of this job and none is read');

 // A failed removal neither withdraws the ready nor replays the message.
 f=await fixture(t);const stubborn=activationStore();
 stubborn.remove=async()=>{throw Object.assign(Error('modeled removal failure'),{code:'work_data_claim.remove_failed'});};
 const run2=await run(f,{store:stubborn});
 assert.equal(await run2.runtime.completeSuccessor(),f.server);
 assert.equal(run2.sent.length,1,'a failed removal never resends serve-ready');

 // A replaced receipt is refused before the ready is published.
 f=await fixture(t);const run3=await run(f);
 const row=run3.owner.rows.get(run3.receipt.base);
 run3.owner.rows.set(run3.receipt.base,{value:{...row.value,id:'d'.repeat(48)},receipt:run3.receipt});
 await assert.rejects(()=>run3.runtime.completeSuccessor(),{code:'work_data_setup.successor_activation_changed'});
 assert.equal(run3.sent.length,0,'a tampered receipt must not announce a second owner');
 assert.equal(run3.owner.calls.remove.length,0);

 // A target authority change refuses completion.
 f=await fixture(t);const run4=await run(f);
 run4.host.readAuthority=async()=>({generation:1,id:'a'.repeat(48),mode:'encrypted',proof:{sha256:'b'.repeat(64)}});
 await assert.rejects(()=>run4.runtime.completeSuccessor(),{code:'work_data_setup.successor_authority_changed'});
 assert.equal(run4.sent.length,0);assert.equal(run4.owner.calls.remove.length,0);
});
