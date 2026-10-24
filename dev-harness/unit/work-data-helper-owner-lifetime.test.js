'use strict';
// Exact runtime/main functions with process/owner seams; no OS owner, child,
// socket, native helper, live server or real timer is created.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo=process.env.RUYI_CAPSULE_REPO||process.cwd();
const {constBlock,functionBlock,bracedBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const runtimeSource=fs.readFileSync(process.env.RUYI_CAPSULE_RUNTIME_SOURCE||path.join(repo,'ruyi-workbench/app/src/13am-work-data-maintenance-runtime.js'),'utf8');
const mainSource=fs.readFileSync(process.env.RUYI_CAPSULE_MAIN_SOURCE||path.join(repo,'ruyi-workbench/app/src/14-main.js'),'utf8');
const tick=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function runtime(globals={}){
 const context={require,Buffer,process:{platform:'win32'},setTimeout(){throw Error('no actual timers');},clearTimeout(){},...globals};
 const api=vm.runInNewContext(constBlock(runtimeSource,'WorkDataMaintenanceRuntime')+'\nWorkDataMaintenanceRuntime;',context),state={starts:0,exits:0,retired:false},workerHooks={},owner={roots:['C:\\SYNTHETIC']};let core;
 const host={process:{pid:42,env:{}},workerHooks,workerApi:{create:options=>{core=options;return{start:async()=>{state.starts++;return{};}};},spawnCold(){throw Error('no actual child');},processChannel(){},waitForProcessExit(){}},
  httpApi:{create(){}},resultApi:{create(){}},controlApi:{create(){}},base:async()=>owner.roots[0],canonical:async value=>value,acquire(){throw Error('no actual owner');},readAuthority:async()=>({}),operations(){throw Error('no operations');},
  adaptersReady:()=>true,helperMayStillRun:()=>false,isRetired:()=>state.retired,stopUncommitted:async()=>{},exit:async()=>state.exits++,command:()=>({command:'SYNTHETIC',args:[]})};
 const instance=api.create(host),capture={base:owner.roots[0],ownership:owner,server:{listening:true,address:()=>({address:'127.0.0.1',port:12345})},listener:{host:'127.0.0.1',port:12345}};
 return {context,state,workerHooks,instance,capture,get core(){return core;}};
}
for(const key of ['MigrationHooks','LocalSecretCrypto'])test(key+' global unknown blocks warm start and permanently latches',async()=>{
 let unknown=false;const f=runtime({[key]:{helperMayStillRun:()=>unknown}});assert.equal(await f.instance.captureServe(f.capture),true);assert.equal(f.instance.activateServe(),true);
 unknown=true;await assert.rejects(f.workerHooks.start({}),{code:'work_data_setup.worker_unavailable'});assert.equal(f.state.starts,0);assert.equal(f.instance.helperMayStillRun(),true);
 unknown=false;await assert.rejects(f.workerHooks.start({}),{code:'work_data_setup.worker_unavailable'});assert.equal(f.state.starts,0);
});
for(const key of ['MigrationHooks','LocalSecretCrypto'])test(key+' unknown between start and retired handoff prevents exitParent',async()=>{
 let unknown=false;const f=runtime({[key]:{helperMayStillRun:()=>unknown}});await f.instance.captureServe(f.capture);f.instance.activateServe();await f.workerHooks.start({});assert.equal(f.state.starts,1);
 f.state.retired=true;unknown=true;await assert.rejects(f.core.exitParent(),error=>error.code==='work_data_setup.native_helper_uncertain'&&error.helperMayStillRun===true);assert.equal(f.state.exits,0);assert.equal(f.capture.server.listening,true);
});
test('runtime globals are optional in old contexts and proven-close normal handoff still exits',async()=>{
 const f=runtime();assert.equal(await f.instance.captureServe(f.capture),true);f.instance.activateServe();f.state.retired=true;await f.core.exitParent();assert.equal(f.state.exits,1);assert.equal(f.instance.helperMayStillRun(),false);
});
for(const kind of ['getter','throw','nonfalse'])test('runtime '+kind+' uncertainty reader fails closed',async()=>{
 const hooks=kind==='getter'?Object.defineProperty({},'helperMayStillRun',{get(){throw Error('private getter');}}):{helperMayStillRun:()=>{if(kind==='throw')throw Error('private reader');return null;}};
 const f=runtime({MigrationHooks:hooks});assert.equal(await f.instance.captureServe(f.capture),false);assert.equal(f.instance.helperMayStillRun(),true);assert.equal(f.workerHooks.start,undefined);
});
function cli(globals={}){
 const state={exits:[],holds:[],unrefs:0,releases:0,logs:[],flushes:0},owner={release:async()=>state.releases++},process={exitCode:0,exit:code=>state.exits.push(code)},module={};
 const context={process,module,require:{main:module},console:{error:value=>state.logs.push(String(value))},
  ServerOwnership:{acquire:async()=>owner,canonicalRoot:async value=>value},dataRoot:()=>'/synthetic/base',WorkDataRootHooks:{bind:async()=>{},ready:()=>true},WorkDataMaintenanceRuntimeHooks:{},
  configMutateChain:Promise.resolve(),configWriteChain:Promise.resolve(),flushWorkbenchLogs:async()=>state.flushes++,PrivacyCore:{configHooks:{startupGuidance:()=>null}},
  setInterval(fn,ms){const timer={fn,ms,unref(){state.unrefs++;}};state.holds.push(timer);return timer;},...globals};
 const helpers=[constBlock(mainSource,'workDataCliHelperHeld'),constBlock(mainSource,'workDataCliHelperHoldTimer'),...['workDataCliHelperUnknown','holdWorkDataCliOwner','withSelectedWorkDataRoot'].map(name=>functionBlock(mainSource,name))];
 // The baseline has no new helper declarations; omit only absent declarations
 // so its actual existing withSelected/main handlers can serve as a negative.
 vm.createContext(context);vm.runInContext(helpers.filter(Boolean).join('\n')+'\nthis.select=withSelectedWorkDataRoot;',context);
 return {context,state,owner,async invoke(work){context.main=()=>{context.pending=context.select(work);return context.pending;};vm.runInContext(bracedBlock(mainSource,'if (require.main === module)'),context);await context.pending.catch(()=>{});await tick();}};
}
for(const key of ['MigrationHooks','LocalSecretCrypto'])test('actual direct CLI '+key+' unknown retains selected owner and ref hold without exiting',async()=>{
 let unknown=false;const f=cli({[key]:{helperMayStillRun:()=>unknown}});
 await f.invoke(async()=>{unknown=true;throw Error('washed public failure');});assert.equal(f.state.releases,0);assert.equal(f.state.exits.length,0);assert.equal(f.context.process.exitCode,1);assert.equal(f.state.holds.length,1);assert.equal(f.state.unrefs,0);
 assert.deepEqual(f.state.logs,['work_data_setup.native_helper_uncertain']);
});
test('successful work cannot return success if helper became unknown before selected-root cleanup',async()=>{
 let unknown=false;const f=cli({MigrationHooks:{helperMayStillRun:()=>unknown}});await f.invoke(async()=>{unknown=true;return 'must not succeed';});
 assert.equal(f.state.releases,0);assert.equal(f.state.exits.length,0);assert.equal(f.state.holds.length,1);assert.equal(f.context.process.exitCode,1);
});
test('normal CLI failure and proven closed helpers retain original release and fast exit',async()=>{
 const f=cli({MigrationHooks:{helperMayStillRun:()=>false},LocalSecretCrypto:{helperMayStillRun:()=>false}});await f.invoke(async()=>{throw Error('ordinary failure');});
 assert.equal(f.state.releases,1);assert.deepEqual(f.state.exits,[1]);assert.equal(f.state.holds.length,0);assert.equal(f.state.unrefs,0);assert.equal(f.state.flushes,1);
});
test('old CLI VM context without optional global readers keeps normal release/exit',async()=>{
 const f=cli();await f.invoke(async()=>{throw Error('ordinary failure');});assert.equal(f.state.releases,1);assert.deepEqual(f.state.exits,[1]);assert.equal(f.state.holds.length,0);
});
test('CLI reader property failure permanently retains owner instead of forcing process exit',async()=>{
 const hooks=Object.defineProperty({},'helperMayStillRun',{get(){throw Error('private helper getter');}}),f=cli({MigrationHooks:hooks});await f.invoke(async()=>{throw Error('washed');});assert.equal(f.state.releases,0);assert.equal(f.state.exits.length,0);assert.equal(f.state.holds.length,1);
});
