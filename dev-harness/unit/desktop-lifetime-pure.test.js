'use strict';
// Pure source factories only: no server import, subprocess, native API, socket or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { constBlock, functionBlock, sliceBlock } = require('../lib/source-slice.js');
const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13ax-desktop-lifetime.js'), 'utf8');
const factory = constBlock(source, 'DesktopLifetime'); assert.ok(factory.length > 3000);
const diagnostic = constBlock(source, 'DesktopLifetimeDiagnostic'); assert.ok(diagnostic.length > 1500);
const diagnosticFs = { writeSync() {} }; // Inert diagnostic sink; no descriptor write in pure tests.
const api = vm.runInNewContext(diagnostic + '\n' + factory + '\nDesktopLifetime', { Buffer, fs: diagnosticFs });
const cap = 'a'.repeat(64), nextCap = 'b'.repeat(64), id = 'c'.repeat(48), nonce = 'd'.repeat(64);
const nextPipe='ruyi-desktop-'+'f'.repeat(64);
const bootstrap = JSON.stringify({ schema: 1, pipe: 'ruyi-desktop-' + 'e'.repeat(64), cap, role: 'serve' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ stop = async () => true, reply } = {}) {
  const socket = new EventEmitter(), frames = [], exits = [], timers = new Map(); let index = 0, refs = 0;
  socket.setEncoding = () => {}; socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = (bytes, callback) => {
    const value = JSON.parse(bytes); frames.push(value); callback?.();
    queueMicrotask(() => {
      const response = reply ? reply(value) : { schema: 1, seq: value.seq, kind: 'ok', ...(value.kind === 'issue' ? { cap: nextCap,pipe:nextPipe } : {}) };
      if (response) socket.emit('data', JSON.stringify(response) + '\n'+(value.kind==='hello'?'{"schema":1,"seq":0,"kind":"active"}\n':''));
    });
  };
  const clock = { setTimeout(fn) { timers.set(++index, fn); return index; }, clearTimeout(key) { timers.delete(key); },
    setInterval() { refs++; return { ref() {} }; } };
  const client = api.create({ bootstrap, clock, proc: { pid: 123, exit: code => exits.push(code) }, stop,
    connect: name => { assert.equal(name, '\\\\.\\pipe\\ruyi-desktop-' + 'e'.repeat(64)); queueMicrotask(() => socket.emit('connect')); return socket; } });
  return { client, socket, frames, exits, timers, clock, refs: () => refs, close() { socket.emit('data', '{"schema":1,"seq":0,"kind":"close"}\n'); } };
}
test('descriptor rejects extra fields, nonlocal names, invalid roles and budgets', () => {
  assert.equal(api.descriptor(bootstrap).role, 'serve');
  for (const value of [null, '{}', 'x', ' '.repeat(1025), JSON.stringify({ ...JSON.parse(bootstrap), command: 'run' }),
    bootstrap.replace('ruyi-desktop-', '\\\\remote\\pipe\\'), bootstrap.replace('"serve"', '"model"'), bootstrap.replace(cap, 'a')])
    assert.throws(() => api.descriptor(value), { code: 'desktop_lifetime.bootstrap_invalid' });
});
test('private capability is consumed before an inherited child environment can be copied', () => {
  const boot = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/00-boot.js'), 'utf8');
  const declaration = constBlock(boot, 'desktopLifetimeBootstrap'); assert.ok(declaration.length > 100);
  const env = { RUYI_DESKTOP_CONTROL_V1: bootstrap, SAFE: 'kept' };
  assert.equal(vm.runInNewContext(declaration + '\ndesktopLifetimeBootstrap', { process: { env } }), bootstrap);
  assert.deepEqual(env, { SAFE: 'kept' });
});
test('hello is bound to this process, role grants are explicit, and messages are sequenced', async () => {
  const f = fixture(); await f.client.open();
  assert.deepEqual(f.frames[0], { schema: 1, seq: 1, kind: 'hello', cap, pid: 123 });
  const grant = await f.client.issue('cold', id, nonce); assert.equal(grant.role, 'cold'); assert.equal(grant.cap, nextCap);
  assert.equal(grant.pipe,nextPipe);assert.notEqual(grant.pipe,JSON.parse(bootstrap).pipe);
  await f.client.transfer(grant); await f.client.serving({ host: '127.0.0.1', port: 12345 });
  assert.deepEqual(f.frames.map(row => row.kind), ['hello', 'issue', 'transfer', 'serving']);
  assert.deepEqual(f.frames.map(row => row.seq), [1, 2, 3, 4]); assert.equal(f.refs(), 0);
  await assert.rejects(f.client.issue('shell', id, nonce), { code: 'desktop_lifetime.grant_invalid' });
  await assert.rejects(f.client.transfer({ ...grant, pipe: 'different' }), { code: 'desktop_lifetime.grant_invalid' });
});
test('a close is idempotent and cannot acknowledge before the actual owner promise settles', async () => {
  let release, calls = 0; const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ stop: async () => { calls++; await held; return true; } }); await f.client.open(); f.close(); f.close(); await tick();
  assert.equal(calls, 1); assert.equal(f.client.closing(), true); assert.equal(f.exits.length, 0);
  assert.equal(f.frames.some(row => row.kind === 'finished'), false);
  release(); await tick(); assert.deepEqual(f.exits, [0]); assert.equal(f.frames.filter(row => row.kind === 'finished').length, 1);
  assert.equal(f.client.unknown(), true, 'a returned process.exit never proves a successful exit');
});
test('committed maintenance defers desktop close to the authenticated successor', async () => {
  const f = fixture({ stop: async () => false }); await f.client.open(); f.close(); await tick();
  assert.equal(f.frames.some(row => row.kind === 'finished'), false); assert.deepEqual(f.exits, []); assert.equal(f.client.unknown(), false);
});
test('a rejected stop keeps the channel reference and cannot finish or exit', async () => {
  const f = fixture({ stop: async () => { throw Object.freeze({ helperMayStillRun: true }); } }); await f.client.open(); f.close(); await tick();
  assert.equal(f.client.unknown(), true); assert.equal(f.refs(), 1); assert.deepEqual(f.exits, []);
  assert.equal(f.frames.some(row => row.kind === 'finished'), false); assert.equal(f.frames.at(-1).kind, 'uncertain');
});
test('falsy thrown reasons still permanently retain the lifetime owner', async () => {
  for(const reason of [null,false,0,'',undefined]){
    const f=fixture({stop:async()=>{throw reason;}});await f.client.open();f.close();await tick();
    assert.equal(f.client.unknown(),true);assert.equal(f.refs(),1);assert.deepEqual(f.exits,[]);
    await assert.rejects(f.client.serving({host:'127.0.0.1',port:12345}),error=>error===reason);
  }
});
test('a failed extra hold timer cannot throw out of uncertainty handling or exit', async () => {
  const f=fixture({stop:async()=>{throw null;}});f.clock.setInterval=()=>{throw Error('modeled timer failure');};
  await f.client.open();f.close();await tick();assert.equal(f.client.unknown(),true);assert.deepEqual(f.exits,[]);
});
test('wrong sequence, unknown shape and frame overflow revoke only this owner and retain uncertainty', async () => {
  for (const response of ['{"schema":1,"seq":99,"kind":"ok"}\n', '{"schema":1,"seq":0,"kind":"close","command":"x"}\n', 'x'.repeat(api.MAX_FRAME)]) {
    const f = fixture(); await f.client.open(); f.socket.emit('data', response);
    assert.equal(f.client.unknown(), true); assert.equal(f.refs(), 1); assert.deepEqual(f.exits, []);
  }
});
test('a withheld host ACK times out without inventing a completed handoff', async () => {
  const f = fixture({ reply: value => value.kind === 'hello' ? { schema: 1, seq: value.seq, kind: 'ok' } : null });
  await f.client.open(); const issued = f.client.issue('cold', id, nonce); await tick();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  await assert.rejects(issued, { code: 'desktop_lifetime.response_timeout' }); assert.equal(f.client.unknown(), true);
});
test('ChildProcess exit does not erase an owned close obligation', async () => {
  const children = new Map(), child = new EventEmitter(); child.pid = 123; child.exitCode = null;
  const maintenance=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ag-work-data-maintenance.js'),'utf8');
  const track = vm.runInNewContext(functionBlock(maintenance, 'workDataTrackChildClose') + '\nworkDataTrackChildClose',
    { workDataChildClosures: children, workDataInfrastructureFailure(){}, Promise, Number });
  track(child); let settled = false; children.get(child).done.then(() => { settled = true; });
  child.exitCode = 0; child.emit('exit', 0); await tick(); assert.equal(settled, false); assert.equal(children.has(child), true);
  child.emit('close', 0); await tick(); assert.equal(settled, true); assert.equal(children.size, 0);
});
function stopFixture({ committed = false, helper = false } = {}) {
  const events = [], children = new Map(); let release; const owner = { promise: new Promise(resolve => { release = resolve; }), cancel: () => events.push('cancel') };
  const globals = { desktopLifetimeStopping: false,desktopLifetimeFailureSet:false,desktopLifetimeClient:null, WorkDataSetupHooks: { closeForDesktop: async () => { events.push('setup'); return !committed; } },
    WorkDataMaintenanceHooks: { prepareInfrastructure:()=>({}),closeInfrastructure:async()=>{events.push('toolbox','kimi');},begin() { events.push('begin'); return { idle: async () => events.push('drain'), assertIdle: () => events.push('idle'), retire: () => events.push('retired') }; } },
    turnSettlers: new Map([['owner', owner]]), activeAgentRuns: new Map(), stopAllActiveTurnsSync: () => events.push('stop'),
    PrivacyLocalDriveProbe: { stopSync() {} }, ExternalBotHooks: {}, StewardHooks: {}, stopScheduler() {},
    ToolboxHooks: { stopForDesktop: async () => events.push('toolbox') }, stopKimiModelProbes() {}, stopKimiServer: async () => events.push('kimi'),
    killAllMcpClients() {}, killAllShellSessions() {}, desktopLifetimeChildren: children,
    LocalSecretCrypto: { helperMayStillRun: () => helper }, MigrationHooks: { helperMayStillRun: () => false }, WorkDataMaintenanceRuntimeHooks: { helperMayStillRun: () => false },
    desktopLifetimeServer: { listening: true, close: callback => { events.push('listener'); callback(); }, closeAllConnections() {} } };
  const stop = vm.runInNewContext(diagnostic+'\n'+functionBlock(source,'desktopLifetimeStopInfrastructure')+'\n'+functionBlock(source, 'desktopLifetimeStop') + '\ndesktopLifetimeStop', { ...globals, fs: diagnosticFs });
  return { stop, events, release, children };
}
test('normal close uses original cancellation, waits for settle, drains and checks helpers before retirement', async () => {
  const f = stopFixture(); const pending = f.stop(); await tick();
  assert.deepEqual(f.events, ['setup', 'begin', 'cancel', 'stop', 'toolbox', 'kimi']);
  f.release(); assert.equal(await pending, true);
  assert.deepEqual(f.events.slice(-6), ['drain', 'idle', 'listener', 'drain', 'idle', 'retired']);
});
test('retired takeover never opens a second drain or stops the user task', async () => {
  const f = stopFixture({ committed: true }); assert.equal(await f.stop(), false); assert.deepEqual(f.events, ['setup']);
});
test('helper uncertainty leaves the listener and ownership intact', async () => {
  const f = stopFixture({ helper: true }); const pending = f.stop(); f.release(); await assert.rejects(pending, /helper_uncertain/);
  assert.equal(f.events.includes('listener'), false); assert.equal(f.events.includes('retired'), false);
});
function kimiStopFixture(starting=false){
  const kimi=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/05b-kimi-bridge.js'),'utf8'),timers=new Map();let timer=0,kills=0,aborts=0,releaseClose,releaseStart;
  const child={pid:123,exitCode:null,signalCode:null,kill(){throw Error('must not kill only the wrapper');}},state={child:starting?null:child,port:12345,token:'synthetic',starting:null};
  const closes=new WeakMap([[child,new Promise(resolve=>{releaseClose=resolve;})]]);
  if(starting)state.starting=new Promise(resolve=>{releaseStart=()=>{state.child=child;resolve();};});
  const context={kimiBridgeState:state,kimiHttpControllers:new Set([{abort(){aborts++;}}]),kimiChildCloses:closes,kimiServerClosing:false,
    setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);},killChildTree(){kills++;}};
  const stop=vm.runInNewContext(functionBlock(kimi,'stopKimiServer')+'\nstopKimiServer',context);
  return {stop,state,timers,child,releaseClose,releaseStart,kills:()=>kills,aborts:()=>aborts};
}
test('Kimi helper exitCode and tree-kill request do not settle its close promise',async()=>{
  const f=kimiStopFixture();let done=false;const pending=f.stop().then(()=>{done=true;});assert.equal(f.kills(),1);
  f.child.exitCode=0;await tick();assert.equal(done,false);assert.equal(f.state.child,f.child);
  assert.equal(f.timers.size,1,'only the final close deadline remains; no repeated PID kill');
  f.releaseClose();await pending;assert.equal(f.state.child,null);assert.equal(f.timers.size,0);
});
test('an unobserved Kimi close deadline rejects and retains its child identity',async()=>{
  const f=kimiStopFixture();const pending=f.stop();[...f.timers.values()][0]();
  await assert.rejects(pending,/kimi_close_timeout/);assert.equal(f.state.child,f.child);
});
test('desktop stop aborts private Kimi HTTP and waits for a late starting helper and its actual close',async()=>{
  const f=kimiStopFixture(true);let done=false;const pending=f.stop({shutdown:true}).then(()=>{done=true;});
  assert.equal(f.aborts(),1);assert.equal(f.kills(),0);f.releaseStart();await tick();assert.equal(f.kills(),1);assert.equal(done,false);
  f.releaseClose();await pending;assert.equal(done,true);
});
test('Toolbox desktop stop waits for startup and owned close without killing an adopted service',async()=>{
  const toolbox=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/04f-toolbox-services.js'),'utf8');
  let releaseStart,releaseClose;const starting=new Promise(resolve=>{releaseStart=resolve;}),closed=new Promise(resolve=>{releaseClose=resolve;}),kills=[];
  const child={pid:123,exitCode:null,signalCode:null},own={owned:true,child,state:'running',stopping:false,starting},adopted={owned:false,child:null,state:'running',stopping:false};
  const context={toolboxServices:new Map([['own',own],['adopted',adopted]]),ToolboxHooks:{},WorkDataMaintenanceHooks:{awaitChild:()=>closed},killChildTree:pid=>kills.push(pid)};
  const code=['toolboxKillTree','stopToolboxService','stopAllToolboxServicesSync'].map(name=>functionBlock(toolbox,name)).join('\n')+'\n'+sliceBlock(toolbox,'ToolboxHooks.stopAll =','ToolboxHooks.ensureForProvider');
  vm.runInNewContext(code,context);let done=false;const pending=context.ToolboxHooks.stopAll().then(()=>{done=true;});
  assert.deepEqual(kills,[123]);assert.equal(done,false);releaseStart();await tick();assert.equal(done,false);assert.equal(own.stopping,true);
  releaseClose();await pending;assert.deepEqual(kills,[123]);assert.equal(own.stopping,false);assert.equal(adopted.stopping,false);
});
function infrastructureFixture(){
  const maintenance=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ag-work-data-maintenance.js'),'utf8');
  const hooks={},events=[],state={phase:'idle',normal:false};
  const context={WorkDataMaintenanceHooks:hooks,workDataMaintenance:{status:()=>({phase:state.phase})},DesktopLifetimeHooks:{normalCloseRequested:()=>state.normal},
    PrivacyLocalDriveProbe:{stopSync:()=>events.push('drive')},ToolboxHooks:{stopAll:async()=>events.push('toolbox')},
    stopKimiModelProbes:()=>events.push('probes'),stopKimiServer:async()=>events.push('kimi'),killAllMcpClients:()=>events.push('mcp'),killAllShellSessions:()=>events.push('shell')};
  const block=sliceBlock(maintenance,'// Completion obligations belong','WorkDataMaintenanceHooks.deferStewardWake');assert.ok(block.length>1500);
  vm.runInNewContext(block,context);return{hooks,events,state};
}
test('shared maintenance pause is reversible without stopping or replacing resident owners',()=>{
  const f=infrastructureFixture(),ticket=f.hooks.prepareInfrastructure();assert.deepEqual(f.events,[]);
  assert.throws(()=>f.hooks.admitHelper(),{code:'work_data.maintenance_busy'});
  assert.throws(()=>f.hooks.resumeInfrastructure({}),/infrastructure_uncertain/);
  f.hooks.resumeInfrastructure(ticket);f.hooks.admitHelper();assert.deepEqual(f.events,[]);
});
test('ordinary CLI maintenance closes the same owned infrastructure and waits for close rather than exit',async()=>{
  const f=infrastructureFixture(),child=new EventEmitter();child.pid=123;f.hooks.trackChild(child);
  const ticket=f.hooks.prepareInfrastructure();let done=false;const pending=f.hooks.closeInfrastructure(ticket).then(()=>{done=true;});await tick();
  assert.deepEqual(f.events,['drive','toolbox','probes','kimi','mcp','shell']);child.emit('exit',0);await tick();assert.equal(done,false);
  child.emit('close',0);await pending;assert.equal(done,true);assert.throws(()=>f.hooks.resumeInfrastructure(ticket),/infrastructure_uncertain/);
  assert.throws(()=>f.hooks.admitHelper(),{code:'work_data.maintenance_busy'});
});
test('shared no-PID launch failure can settle, but a known child error permanently retains uncertainty including null',async()=>{
  const f=infrastructureFixture(),missing=new EventEmitter();f.hooks.trackChild(missing);missing.emit('error',Error('no launch'));assert.equal(f.hooks.helperMayStillRun(),false);
  const child=new EventEmitter();child.pid=123;f.hooks.trackChild(child);child.emit('error',null);await tick();
  assert.equal(f.hooks.helperMayStillRun(),true);child.emit('close',0);assert.equal(f.hooks.helperMayStillRun(),true);
  assert.throws(()=>f.hooks.prepareInfrastructure(),/infrastructure_unavailable/);assert.throws(()=>f.hooks.admitHelper(),{code:'work_data.maintenance_busy'});
});
test('a normal close may stop active owners only under the authenticated desktop close phase',()=>{
  const f=infrastructureFixture();f.state.phase='waiting';assert.throws(()=>f.hooks.prepareInfrastructure({normalClose:true}),/not_idle/);
  f.state.normal=true;assert.ok(f.hooks.prepareInfrastructure({normalClose:true}));
});
function setupInfrastructureFixture(){
  const setup=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ah-work-data-setup.js'),'utf8');
  const maintenance=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ag-work-data-maintenance.js'),'utf8');
  const context={Buffer,AbortController,require,Promise};
  const Setup=vm.runInNewContext(constBlock(setup,'WorkDataSetup')+'\nWorkDataSetup',context),Maintenance=vm.runInNewContext(constBlock(maintenance,'WorkDataMaintenance')+'\nWorkDataMaintenance',context);
  const events=[],queue=[];let ready,closed,failClose;const readyPromise=new Promise(resolve=>{ready=resolve;}),closedPromise=new Promise((resolve,reject)=>{closed=resolve;failClose=reject;});
  const m=Maintenance.create({owns:()=>false,snapshot:()=>({busy:{},pending:[],dirty:0}),pause:()=>({}),resume:()=>events.push('resume'),flush:async()=>{},yield:tick});
  const ticket={},authority={generation:0,id:null,mode:'plain',sha256:null};
  const host={maintenance:m,inspect:async()=>({authority,base:'C:/synthetic/base',configMirror:false}),validateDirectories:async()=>{},id:()=>id,now:()=>0,defer:work=>queue.push(work),
    worker:()=>({start:async()=>({ready:readyPromise,failure:new Promise(()=>{}),cancel:async()=>events.push('cancel-child'),commit:async()=>events.push('armed'),assertArmed:()=>events.push('assert-armed'),handoff:async()=>events.push('handoff')})}),
    infrastructure:{prepareInfrastructure:()=>{events.push('infra-pause');return ticket;},closeInfrastructure:async value=>{assert.equal(value,ticket);events.push('infra-close');await closedPromise;},resumeInfrastructure:()=>events.push('infra-resume')}};
  const api=Setup.create(host),submit=()=>api.submit({operation:'enable',password:'synthetic lifetime password',expectedAuthority:authority,backupDirectory:'C:/synthetic/backup'});
  return{api,events,m,submit,ready,closed,failClose,start:()=>queue.shift()()};
}
async function untilPure(predicate){for(let i=0;i<100;i++){if(await predicate())return;await tick();}throw Error('pure fixture did not settle');}
test('maintenance cancellation before the cutoff preserves resident infrastructure',async()=>{
  const f=setupInfrastructureFixture(),job=await f.submit();f.start();await untilPure(async()=>f.m.status().phase==='idle');
  await f.api.cancel(job.id);await untilPure(async()=>(await f.api.status()).job===null);
  assert.equal(f.events.includes('infra-close'),false);assert.equal(f.events.includes('handoff'),false);assert.equal(f.m.accepting(),true);
});
test('the cutoff precedes resident close and parent handoff waits for its real settlement and a second drain',async()=>{
  const f=setupInfrastructureFixture(),job=await f.submit();f.start();f.ready();await untilPure(()=>f.events.includes('infra-close'));
  assert.ok(f.events.indexOf('armed')<f.events.indexOf('infra-close'));
  await assert.rejects(f.api.cancel(job.id),{code:'work_data_setup.cancel_too_late'});assert.equal(f.events.includes('handoff'),false);assert.equal(f.m.status().phase,'idle');
  f.closed();await untilPure(()=>f.events.includes('handoff'));assert.equal(f.m.status().phase,'retired');
  assert.ok(f.events.indexOf('assert-armed')>f.events.indexOf('infra-close'));
  assert.equal(f.events.includes('infra-resume'),false);
});
test('uncertain infrastructure close never retires or hands off, and never reopens admission',async()=>{
  const f=setupInfrastructureFixture();await f.submit();f.start();f.ready();await untilPure(()=>f.events.includes('infra-close'));
  f.failClose(Object.freeze({helperMayStillRun:true}));await untilPure(async()=>(await f.api.status()).job.state==='uncertain');
  assert.equal(f.events.includes('handoff'),false);assert.equal(f.events.includes('infra-resume'),false);assert.equal(f.m.accepting(),false);
});
test('the original boot warmup owns all derived asynchronous work until every promise settles',async()=>{
  const router=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13-http-router.js'),'utf8');
  const events=[];let warmed,derived;const warm=new Promise(resolve=>{warmed=resolve;}),held=new Promise(resolve=>{derived=resolve;});
  const context={startScheduler:async()=>events.push('scheduler'),ToolboxHooks:{reconcile:async()=>events.push('toolbox')},ensureDesktopMcpWarm:()=>warm,
    syncMcpServersToClaude:()=>{events.push('claude');return held;},syncAgentCliMcpManifests:async()=>events.push('manifests'),getCapabilities:async()=>events.push('capabilities'),generateMcpConfig:async()=>'/synthetic/config',console:{log(){}}};
  const work=vm.runInNewContext(functionBlock(router,'warmWorkbenchServices')+'\nwarmWorkbenchServices',context);let done=false;const pending=work({}).then(()=>{done=true;});
  await tick();assert.deepEqual(events,['scheduler','toolbox']);warmed();await tick();assert.equal(done,false);assert.ok(events.includes('claude'));
  derived();await pending;assert.equal(done,true);
});

// Actual setup, maintenance, worker and IPC parser, with modeled timers. No
// process is spawned; parent death and the original 120s probe are pure inputs.
function ipcInfrastructureFixture({withholdGo=false,withholdArmed=false,withholdReady=false,desktop=true}={}){
  const read=name=>fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src',name),'utf8');
  const timers=new Map(),events=[];let serial=0,now=0,parentDead=false,coldFailure=null,coldResult=null,deferred,releaseClose;
  const timeout=(work,ms)=>{const timer={id:++serial,work,ms,at:now+ms};timers.set(timer.id,timer);return timer;},clear=timer=>{if(timer)timers.delete(timer.id);};
  const context={require,Buffer,process,AbortController,setTimeout:timeout,clearTimeout:clear,...(desktop?{DesktopLifetimeHooks:{reportUncertain:async()=>events.push('desktop-uncertain')}}:{})};
  const Worker=vm.runInNewContext(constBlock(read('13ai-work-data-worker.js'),'WorkDataMaintenanceWorker')+'\nWorkDataMaintenanceWorker',context);
  const Setup=vm.runInNewContext(constBlock(read('13ah-work-data-setup.js'),'WorkDataSetup')+'\nWorkDataSetup',context);
  const Maintenance=vm.runInNewContext(constBlock(read('13ag-work-data-maintenance.js'),'WorkDataMaintenance')+'\nWorkDataMaintenance',context);
  const child=new EventEmitter(),proc=new EventEmitter();Object.assign(child,{pid:222,exitCode:null,signalCode:null});Object.assign(proc,{pid:222,ppid:111,connected:true});
  proc.send=(message,callback)=>{queueMicrotask(()=>{events.push('cold:'+message.kind);if(!(withholdArmed&&message.kind==='armed'||withholdReady&&message.kind==='ready'))child.emit('message',message);callback();});};
  child.send=(message,callback)=>{queueMicrotask(()=>{events.push('parent:'+message.kind);if(!(withholdGo&&message.kind==='go'))proc.emit('message',message);callback();});};
  const base=path.resolve(__dirname,'SYNTHETIC-NOT-CREATED','base'),backup=path.resolve(__dirname,'SYNTHETIC-NOT-CREATED','backup'),authority={generation:0,id:null,mode:'plain',sha256:null};
  const cold=Worker.create({pid:222,base:async()=>base,canonical:async value=>value,
    waitParentExit:pid=>Worker.waitForProcessExit(pid,{probe:()=>{if(parentDead)throw Object.assign(Error('modeled exit'),{code:'ESRCH'});},delay:ms=>new Promise(resolve=>timeout(resolve,ms)),now:()=>now}),
    acquire:async roots=>{events.push('acquire');return{roots,release:async()=>events.push('release-owner')};},readAuthority:async()=>({...authority,proof:{sha256:null}}),
    execute:async()=>{events.push('execute');return{phase:'complete'};},helperMayStillRun:()=>false});
  child.stdin=new EventEmitter();child.stdin.end=(bytes,callback)=>{const payload=Buffer.from(bytes),channel=Worker.processChannel(proc);
    void cold.runCold({...channel,readInput:async()=>payload}).then(value=>{coldResult=value;},error=>{coldFailure=error;events.push('cold-failed');child.exitCode=1;child.emit('exit',1);});callback();};
  const warm=Worker.create({pid:111,env:{},base:async()=>base,listener:()=>({host:'127.0.0.1',port:12345}),spawn:()=>child,setTimeout:timeout,clearTimeout:clear,
    stopUncommitted:async()=>events.push('cancel-child'),exitParent:async()=>{events.push('exit-parent');parentDead=true;}});
  const maintenance=Maintenance.create({owns:()=>false,snapshot:()=>({busy:{},pending:[],dirty:0}),pause:()=>({}),resume:()=>events.push('resume'),flush:async()=>{},yield:tick});
  const held=new Promise(resolve=>{releaseClose=resolve;});
  const setup=Setup.create({maintenance,inspect:async()=>({authority,base}),validateDirectories:async()=>{},worker:()=>warm,id:()=>id,now:()=>0,defer:work=>{deferred=work;},
    infrastructure:{prepareInfrastructure:()=>({}),resumeInfrastructure:()=>events.push('resume-infra'),closeInfrastructure:async()=>{events.push('infra-close-start');await held;events.push('infra-close-done');}}});
  return{events,timers,setup,maintenance,releaseClose,child,coldFailure:()=>coldFailure,coldResult:()=>coldResult,
    start:async()=>{await setup.submit({operation:'enable',password:'synthetic only password',expectedAuthority:authority,backupDirectory:backup});deferred();},
    async advance(ms){now+=ms;for(const timer of [...timers.values()])if(timer.at<=now&&timers.delete(timer.id))timer.work();await tick();},
  };
}
test('a valid 16-second resident close follows armed, preserves the 120s parent wait and reaches actual modeled execution',async()=>{
  const f=ipcInfrastructureFixture();await f.start();await untilPure(()=>f.events.includes('infra-close-start'));
  assert.ok(f.events.indexOf('cold:armed')<f.events.indexOf('infra-close-start'));
  assert.equal([...f.timers.values()].some(timer=>timer.ms===15000),false,'both original short handshakes ended before close');
  await f.advance(16000);assert.equal(f.coldFailure(),null);assert.equal(f.events.includes('exit-parent'),false);
  await assert.rejects(f.setup.cancel(id),{code:'work_data_setup.cancel_too_late'});
  f.releaseClose();await untilPure(()=>f.events.includes('exit-parent'));await f.advance(50);await untilPure(()=>f.coldResult()!==null);
  assert.equal(f.coldResult().phase,'complete');assert.equal(f.coldFailure(),null);assert.equal(f.maintenance.status().phase,'retired');
  assert.equal(f.events.includes('desktop-uncertain'),false);
  assert.ok(f.events.indexOf('exit-parent')>f.events.indexOf('infra-close-done'));assert.ok(f.events.indexOf('execute')>f.events.indexOf('exit-parent'));
});
test('unverified parent exit still times out at the original budget and refuses retirement after close',async()=>{
  const f=ipcInfrastructureFixture();await f.start();await untilPure(()=>f.events.includes('infra-close-start'));
  await f.advance(120000);await untilPure(()=>f.coldFailure()!==null);assert.equal(f.coldFailure().cause.code,'work_data_setup.parent_exit_timeout');
  f.releaseClose();await untilPure(async()=>(await f.setup.status()).job.state==='uncertain');
  assert.equal(f.events.includes('exit-parent'),false);assert.equal(f.events.includes('execute'),false);assert.notEqual(f.maintenance.status().phase,'retired');
  assert.equal(f.events.includes('resume'),false);assert.equal(f.events.includes('resume-infra'),false);assert.equal(f.maintenance.accepting(),false);
  assert.equal(f.events.includes('desktop-uncertain'),true,'a deferred desktop close must receive the existing unknown status');
});
test('cold timeout updates the original job while resident close stays pending, with one notification and no late handoff in Desktop or CLI',async()=>{
  for(const desktop of [true,false]){
    const f=ipcInfrastructureFixture({desktop});await f.start();await untilPure(()=>f.events.includes('infra-close-start'));
    await f.advance(120000);await untilPure(()=>f.coldFailure()!==null);
    assert.equal(f.coldFailure().cause.code,'work_data_setup.parent_exit_timeout');
    await untilPure(async()=>(await f.setup.status()).job.state==='uncertain');
    const observed=(await f.setup.status()).job;assert.equal(observed.error,'work_data_setup.worker_exited');assert.equal(observed.cancellable,false);
    assert.equal(f.events.includes('infra-close-done'),false,'the original resident close is still unresolved');
    assert.equal(f.events.filter(value=>value==='desktop-uncertain').length,desktop?1:0);
    assert.equal(f.maintenance.accepting(),false);assert.notEqual(f.maintenance.status().phase,'retired');
    for(const event of ['close','disconnect','error'])f.child.emit(event,event==='error'?Error('late child event'):1);
    f.releaseClose();await untilPure(()=>f.events.includes('infra-close-done'));for(let n=0;n<4;n++)await tick();
    const late=(await f.setup.status()).job;assert.equal(late.state,'uncertain');assert.equal(late.error,observed.error);
    assert.equal(f.events.filter(value=>value==='desktop-uncertain').length,desktop?1:0);
    for(const event of ['exit-parent','execute','resume','resume-infra'])assert.equal(f.events.includes(event),false);
    assert.equal(f.maintenance.accepting(),false);assert.notEqual(f.maintenance.status().phase,'retired');
  }
});
test('exact committed child close, channel disconnect and errors remain observable after ready and armed have settled',async()=>{
  for(const [event,code]of [['close','worker_closed'],['disconnect','worker_disconnected'],['error','worker_launch_failed'],['input-error','worker_input_failed']]){
    const f=ipcInfrastructureFixture();await f.start();await untilPure(()=>f.events.includes('infra-close-start'));
    if(event==='input-error')f.child.stdin.emit('error',Error('modeled input error'));else f.child.emit(event,event==='error'?Error('modeled child error'):1);
    await untilPure(async()=>(await f.setup.status()).job.state==='uncertain');
    assert.equal((await f.setup.status()).job.error,'work_data_setup.'+code);
    assert.equal(f.events.includes('infra-close-done'),false);assert.equal(f.events.includes('exit-parent'),false);
    assert.equal(f.events.filter(value=>value==='desktop-uncertain').length,1);assert.notEqual(f.maintenance.status().phase,'retired');assert.equal(f.maintenance.accepting(),false);
  }
});
test('cancelling the actual uncommitted worker does not turn its later close or disconnect into takeover uncertainty',async()=>{
  const f=ipcInfrastructureFixture({withholdReady:true});await f.start();await untilPure(()=>f.events.includes('cold:ready'));
  await f.setup.cancel(id);await untilPure(async()=>(await f.setup.status()).job===null);
  f.child.emit('exit',0);f.child.emit('close',0);f.child.emit('disconnect');await tick();
  assert.equal(f.events.includes('infra-close-start'),false);assert.equal(f.events.includes('desktop-uncertain'),false);assert.equal(f.events.includes('exit-parent'),false);
  assert.equal(f.events.includes('cancel-child'),true);assert.equal(f.maintenance.accepting(),true);
});
test('missing go or armed retains the original 15s handshake refusal before resident close',async()=>{
  for(const option of [{withholdGo:true},{withholdArmed:true}]){
    const f=ipcInfrastructureFixture(option);await f.start();await untilPure(()=>f.events.includes('parent:go'));await f.advance(15000);
    await untilPure(async()=>(await f.setup.status()).job.state==='uncertain');assert.equal(f.events.includes('infra-close-start'),false);
    assert.equal(f.events.includes('exit-parent'),false);assert.equal(f.events.includes('execute'),false);assert.equal(f.maintenance.accepting(),false);
    assert.equal(f.events.includes('desktop-uncertain'),true);
  }
});
test('desktop boot and both private grant environments exclude case-insensitive Node diagnostics before capability injection',()=>{
  const desktop=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/desktop/DesktopLifetimeHost.cs'),'utf8');
  const start=desktop.slice(desktop.indexOf('public bool Start('),desktop.indexOf('private static string Quote'));
  assert.ok(start.includes('StringComparer.OrdinalIgnoreCase'));
  const removals=[...start.matchAll(/env\.Remove\("([A-Z_]+)"\)/g)].map(match=>match[1]);
  for(const key of ['NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE']){
    assert.ok(removals.includes(key));assert.ok(start.indexOf('env.Remove("'+key+'")')<start.indexOf('env["RUYI_DESKTOP_CONTROL_V1"]'));
  }
  const hooks={};vm.runInNewContext(source,{Buffer,DesktopLifetimeHooks:hooks});
  const worker=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ai-work-data-worker.js'),'utf8');
  const Worker=vm.runInNewContext(constBlock(worker,'WorkDataMaintenanceWorker')+'\nWorkDataMaintenanceWorker',{require,Buffer,process});
  for(const role of ['cold','successor']){
    const inherited={nOdE_dEbUg:'*',node_debug_native:'*',NODE_OPTIONS:'--require unsafe',node_path:'unsafe',rUyI_dEsKtOp_CoNtRoL_V1:'old',SAFE:'kept'};
    const normal=Worker.create({env:inherited}).environment(path.resolve(__dirname,'NOT-CREATED'));
    const env=hooks.environment(inherited,{...JSON.parse(bootstrap),role});
    for(const value of [normal,env])for(const key of Object.keys(value))assert.equal(/^NODE_(DEBUG|DEBUG_NATIVE|OPTIONS|PATH)$/i.test(key),false);
    assert.equal(env.SAFE,'kept');assert.equal(Object.keys(env).filter(key=>/^RUYI_DESKTOP_CONTROL_/i.test(key)).length,1);
    assert.equal(JSON.parse(env.RUYI_DESKTOP_CONTROL_V1).role,role);
  }
});
test('exact Node spawn debug logger leaks the negative-control cap and cannot leak after desktop initial diagnostics removal',()=>{
  const util=require('node:util'),embedded=process.binding('natives'),writes=[];let nativeStubCalls=0;
  const noop=()=>{},ctx={process:{platform:'win32',pid:123,env:{},stderr:{write:text=>writes.push(text)}},
    ArrayIsArray:Array.isArray,ArrayPrototypeSlice:value=>value.slice(),ArrayPrototypeUnshift:(value,item)=>value.unshift(item),ArrayPrototypePush:(value,item)=>value.push(item),
    ArrayPrototypeFilter:(value,callback)=>value.filter(callback),ArrayPrototypeSort:value=>value.sort(),StringPrototypeToUpperCase:value=>value.toUpperCase(),SafeSet:Set,
    RegExpPrototypeExec:(regex,value)=>regex.exec(value),validateString:noop,validateArgumentNullCheck:noop,validateArgumentsNullCheck:noop,validateObject:noop,validateBoolean:noop,
    validateTimeout:noop,validateAbortSignal:noop,sanitizeKillSignal:()=> 'SIGTERM',copyProcessEnvToEnv:noop,isZOS:false,permission:{isEnabled:()=>false},
    ChildProcess:class{spawn(){nativeStubCalls++;}},debugImpls:{},noop,emitWarningIfNeeded:noop,lazyUtilColors:()=>({shouldColorize:()=>false}),inspect:util.inspect,format:util.format,formatWithOptions:util.formatWithOptions};
  vm.createContext(ctx);vm.runInContext(functionBlock(embedded['internal/util/debuglog'],'initializeDebugEnv')+'\n'+functionBlock(embedded['internal/util/debuglog'],'debuglogImpl')+'\n'
    +functionBlock(embedded.child_process,'normalizeSpawnArguments')+'\n'+functionBlock(embedded.child_process,'spawn')+'\nmodeledSpawn=spawn;',ctx);
  const desktop=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/desktop/DesktopLifetimeHost.cs'),'utf8');
  const initial=desktop.slice(desktop.indexOf('public bool Start('),desktop.indexOf('private static string Quote'));
  const removals=[...initial.matchAll(/env\.Remove\("([A-Z_]+)"\)/g)].map(match=>match[1]);
  for(const diagnostic of ['child_process','*','http,CHILD_*'])for(const fixed of [false,true]){
    const initialEnv={nOdE_dEbUg:diagnostic,NODE_DEBUG_NATIVE:'*'};
    if(fixed)for(const key of Object.keys(initialEnv))if(removals.includes(key.toUpperCase()))delete initialEnv[key];
    ctx.debugSetting=Object.entries(initialEnv).find(([key])=>key.toUpperCase()==='NODE_DEBUG')?.[1];
    vm.runInContext('initializeDebugEnv(debugSetting);debug=debuglogImpl(testEnabled("CHILD_PROCESS"),"CHILD_PROCESS");',ctx);
    writes.length=0;ctx.modeledSpawn('synthetic-node.exe',[],{env:{RUYI_DESKTOP_CONTROL_V1:bootstrap},windowsHide:true,stdio:'ignore'});
    assert.equal(writes.some(value=>value.includes(cap)),!fixed);assert.equal(writes.length,fixed?0:1);
  }
  assert.equal(nativeStubCalls,6,'only inert native-boundary stubs ran');
});
test('role grants reject missing, non-string or reused endpoints before they can be forwarded to a child',async()=>{
  for(const pipe of [undefined,JSON.parse(bootstrap).pipe,[],['ruyi-desktop-'+'f'.repeat(64)],'\\\\other\\pipe\\name']){
    const f=fixture({reply:value=>({schema:1,seq:value.seq,kind:'ok',...(value.kind==='issue'?{cap:nextCap,...(pipe===undefined?{}:{pipe})}:{})})});
    await f.client.open();await assert.rejects(f.client.issue('cold',id,nonce),{code:'desktop_lifetime.protocol'});assert.equal(f.client.unknown(),true);
  }
});
test('C# publishes only precreated exclusive role endpoints and never recreates one after any first connection',()=>{
  const desktop=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/desktop/DesktopLifetimeHost.cs'),'utf8');
  const create=desktop.slice(desktop.indexOf('private Grant CreateGrant('),desktop.indexOf('private void Accept('));
  const accept=desktop.slice(desktop.indexOf('private void Accept('),desktop.indexOf('private void SendClose('));
  const serve=desktop.slice(desktop.indexOf('private void Serve('),desktop.indexOf('private void Publish('));
  const start=desktop.slice(desktop.indexOf('public bool Start('),desktop.indexOf('private static string Quote'));
  assert.ok(create.includes('PipeName="ruyi-desktop-"+RandomHex()'));
  assert.match(create,/CreateNamedPipe\(@"\\\\\.\\pipe\\"\+grant\.PipeName,0x00000003\|0x40000000\|0x00080000,0,1,Limit,Limit,0,ref attributes\)/);
  assert.ok(create.indexOf('CreateNamedPipe(')<create.indexOf('grants.Add('));assert.ok(create.indexOf('grants.Add(')<create.indexOf('return grant;'));
  assert.ok(create.includes('if(handle.IsInvalid)'));assert.ok(create.includes('Inherit=false'));assert.equal(desktop.includes('PipeAccessRights.FullControl'),false);
  assert.ok(start.indexOf('CreateGrant("serve"')<start.indexOf('env["RUYI_DESKTOP_CONTROL_V1"]'));
  assert.match(serve,/CreateGrant\(role,client\.Grant\.Cap,id,nonce\);Reply\(client,client\.Sequence,issued\)/);
  assert.ok(accept.includes('grant.Endpoint.WaitForConnection();Serve(grant);'));assert.equal(/while\s*\(|CreateGrant\(|CreateNamedPipe\(|Dispose\(/.test(accept),false);
  assert.ok(serve.includes('Text(hello,"cap")!=grant.Cap'));assert.ok(serve.includes('GetNamedPipeClientProcessId'));assert.ok(serve.includes('GetProcessTimes'));assert.ok(serve.includes('IsProcessInJob'));
  assert.equal(serve.includes('if (client == null) pipe.Dispose()'),false,'an invalid first peer cannot free the reserved name for interception');
  assert.ok(desktop.includes('!client.Exited||!client.ChannelClosed'));
});
test('the late-bound drive host uses the original maintenance gate and preserves its actual child-close obligation',async()=>{
  const drive=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/03b-privacy-local-drive.js'),'utf8');
  const maintenance=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13ag-work-data-maintenance.js'),'utf8');
  const f=infrastructureFixture(),children=[];
  const probe=vm.runInNewContext(constBlock(drive,'PrivacyLocalDriveProbe')+'\nPrivacyLocalDriveProbe',{
    require:name=>{if(name==='node:path')return path;if(name!=='node:child_process')throw Error('unexpected builtin');return{spawn(){
      const child=Object.assign(new EventEmitter(),{pid:222,exitCode:null,signalCode:null,kill(){},ref(){},unref(){}});
      for(const key of ['stdin','stdout','stderr'])child[key]=Object.assign(new EventEmitter(),{destroy(){},ref(){},unref(){},setEncoding(){},write(){}});
      children.push(child);return child;
    }};},process:{platform:'win32',env:{SystemRoot:'C:\\Windows'},once(){}},setTimeout:()=>({unref(){}}),clearTimeout(){},
  });
  const binding=maintenance.slice(maintenance.lastIndexOf('\nPrivacyLocalDriveProbe.setHost('));assert.ok(binding.length>50);
  vm.runInNewContext(binding,{PrivacyLocalDriveProbe:probe,workDataAdmitHelper:f.hooks.admitHelper,workDataTrackChildClose:f.hooks.trackChild});
  const ticket=f.hooks.prepareInfrastructure();await assert.rejects(probe.query(['C:\\']),/drive_probe_unavailable/);assert.equal(children.length,0);
  f.hooks.resumeInfrastructure(ticket);const query=probe.query(['C:\\']);assert.equal(children.length,1);
  const child=children[0];let closed=false;const done=f.hooks.awaitChild(child).then(()=>{closed=true;});
  child.stdout.emit('data','C:Fixed\n');assert.equal((await query).get('C:\\'),'Fixed');probe.stopSync();
  child.emit('exit',0);await tick();assert.equal(closed,false);child.emit('close',0);await done;assert.equal(closed,true);
});
test('combined CLI spawn boundaries preserve maintenance admission and recheck the exact WT owner and permission fence after synchronous supersession',async()=>{
  const runtime=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/04-permission-runtime.js'),'utf8');
  const dispatch=sliceBlock(runtime,'SessionExecutionHooks.assertDispatch =','// A logical driver');assert.ok(dispatch.length>250);
  for(const file of ['05-claude-engine.js','05b-kimi-bridge.js']){
    const text=fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src',file),'utf8');
    const begin=text.indexOf('    const spawnFence =')>=0?text.indexOf('    const spawnFence ='):text.indexOf('  const spawnFence =');
    const track=text.indexOf('WorkDataMaintenanceHooks.trackChild(child);',begin),end=text.indexOf('\n',track);
    assert.ok(begin>0&&track>begin&&end>track);const boundary=text.slice(begin,end);
    for(const mode of ['accept','maintenance-closed','owner-replaced-at-stop','permission-revoked-at-stop']){
      const f=infrastructureFixture(),settlers=new Map(),children=new Map();let spawns=0,fenceValid=true;
      const fence={assert(){if(!fenceValid)throw Object.assign(Error('permission revoked'),{code:'PERMISSION_REVOKED'});}};
      const owner={sessionId:'combined',prepareDispatch:async()=>fence};settlers.set(owner.sessionId,owner);
      if(mode.endsWith('-at-stop'))children.set(owner.sessionId,{});
      if(mode==='maintenance-closed')f.hooks.prepareInfrastructure();
      const context={SessionExecutionHooks:{},turnSettlers:settlers,activeChildren:children,session:{id:owner.sessionId},executionOwner:owner,
        WorkDataMaintenanceHooks:f.hooks,workingDir:'SYNTHETIC-NOT-CREATED',env:{},spawnCmd:'synthetic',spawnArgs:[],spawnOpts:{},spawn:{command:'synthetic',args:[],opts:{}},
        stopSession(){children.delete(owner.sessionId);if(mode==='owner-replaced-at-stop')settlers.set(owner.sessionId,{});if(mode==='permission-revoked-at-stop')fenceValid=false;},
        cp:{spawn(){spawns++;return Object.assign(new EventEmitter(),{pid:222,exitCode:null,signalCode:null});}}};
      vm.createContext(context);vm.runInContext(functionBlock(runtime,'assertSessionExecutionOwner')+'\n'+dispatch,context);
      const run=vm.runInContext('(async()=>{'+(file.startsWith('05b-')?'let child;':'')+boundary+'\nreturn child;})',context);
      if(mode==='accept'){const child=await run();assert.equal(spawns,1);child.emit('close',0);await f.hooks.awaitChild(child);}
      else{await assert.rejects(run(),{code:mode==='maintenance-closed'?'work_data.maintenance_busy':mode==='owner-replaced-at-stop'?'STEWARD_TURN_CANCELLED':'PERMISSION_REVOKED'});assert.equal(spawns,0);}
    }
  }
});
