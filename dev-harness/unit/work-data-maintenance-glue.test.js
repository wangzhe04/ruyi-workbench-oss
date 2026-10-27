'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {constBlock,functionBlock,bracedBlock,sliceBlock}=require('../lib/source-slice'),router=fs.readFileSync(process.env.GLUE_ROUTER_CANDIDATE||p.join(__dirname,'../../ruyi-workbench/app/src/13-http-router.js'),'utf8'),main=fs.readFileSync(process.env.GLUE_MAIN_CANDIDATE||p.join(__dirname,'../../ruyi-workbench/app/src/14-main.js'),'utf8');
const parse=functionBlock(router,'parseArgs');
const VerifierEntry=vm.runInNewContext(constBlock(fs.readFileSync(p.join(__dirname,'../../ruyi-workbench/app/src/13ar-work-data-verifier-entry.js'),'utf8'),'WorkDataVerifierEntry')+'\nWorkDataVerifierEntry',{require,Buffer,process});
test('private commands enter only the cold role without normal stores bootstrap or user supplied flags',async()=>{
 for(const mode of ['work-data-maintenance','work-data-successor']){
  const calls=[],hooks={runCold:async()=>calls.push('cold'),runSuccessor:async()=>calls.push('successor')},context={process:{argv:['node','server.js',mode]},Object,WorkDataVerifierEntry:VerifierEntry,WorkDataMaintenanceRuntimeHooks:hooks,startWorkbenchServe:()=>{throw Error('normal serve forbidden');}};
  const fn=vm.runInNewContext(parse+'\n'+functionBlock(main,'main')+'\nmain;',context);await fn();assert.deepEqual(calls,[mode==='work-data-maintenance'?'cold':'successor']);
  context.process.argv.push('--password','SHOULD_NOT_BE_LOGGED');await assert.rejects(()=>fn(),{code:'work_data_setup.private_command_invalid'});assert.equal(calls.length,1);
 }
 // The private verifier entry is wired: 13ar advertises the command and 14-main routes it
 // to that entry, so the adapter's capability list must not call it unsupported.
 const entryPath=p.join(__dirname,'synthetic-server.js');
 assert.deepEqual(JSON.parse(JSON.stringify(VerifierEntry.command({proc:{execPath:process.execPath},packaged:false,entry:entryPath}))),{command:process.execPath,args:[entryPath,VerifierEntry.COMMAND]});
 const routed=[],stub={COMMAND:VerifierEntry.COMMAND,create:()=>({run:async()=>{routed.push('verifier');return 'verified';}})};
 const verifierMain=vm.runInNewContext(parse+'\n'+functionBlock(main,'main')+'\nmain;',{process:{argv:['node','server.js',VerifierEntry.COMMAND]},Object,WorkDataVerifierEntry:stub,WorkDataMaintenanceRuntimeHooks:{},startWorkbenchServe:()=>{throw Error('normal serve forbidden');}});
 assert.equal(await verifierMain(),'verified');assert.deepEqual(routed,['verifier']);
});
test('ordinary serve retains bootstrap order and publishes maintenance capability only after inbox startup settles',async()=>{
 const events=[];let release,entered;const enteredPromise=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 const fn=vm.runInNewContext(functionBlock(main,'startWorkbenchServe')+'\nstartWorkbenchServe;',{
  startServer:async()=>{events.push('listen');return 'served';},readConfig:async()=>{events.push('read');return {};},startStewardInbox:async()=>{events.push('inbox');entered();await barrier;},WorkDataMaintenanceRuntimeHooks:{activateServe:()=>events.push('activate')}
 });const pending=fn({});await enteredPromise;assert.deepEqual(events,['listen','read','inbox']);release();assert.equal(await pending,'served');assert.deepEqual(events,['listen','read','inbox','activate']);
});
test('pending intent blocks direct admin CLI before binding and never flushes an already-bound old scope',async()=>{
 const calls=[],owner={release:async()=>calls.push('release')},error=Object.assign(Error('pending'),{code:'work_data_setup.intent_pending'});
 const fn=vm.runInNewContext(sliceBlock(main,'let workDataCliHelperHeld','// These commands read config through')+'\n'+functionBlock(main,'withSelectedWorkDataRoot')+'\nwithSelectedWorkDataRoot;',{
  dataRoot:()=>'/root',ServerOwnership:{acquire:async()=>{calls.push('acquire');return owner;},canonicalRoot:async root=>root},
  WorkDataMaintenanceRuntimeHooks:{inspectBoot:async()=>{calls.push('inspect');throw error;}},WorkDataRootHooks:{ready:()=>true,bind:async()=>calls.push('bind')},
  configMutateChain:{catch:()=>{calls.push('config-flush');}},configWriteChain:{catch:()=>{calls.push('write-flush');}},flushWorkbenchLogs:async()=>calls.push('logs-flush')
 });await assert.rejects(()=>fn(()=>calls.push('work')),value=>value===error);assert.deepEqual(calls,['acquire','inspect','release']);
});
test('pending boot never enters old startup-error writer even when an earlier root hook is already ready',async()=>{
 const calls=[],error=Object.assign(Error('pending'),{code:'work_data_setup.intent_pending'}),fn=vm.runInNewContext(functionBlock(router,'startServer')+'\nstartServer;',{
  resolveBindHost:()=> '127.0.0.1',dataRoot:()=>'/root',defaultDataRoots:()=>({legacy:'/legacy',next:'/next'}),lstatOrNull:()=>null,isDirectServeInvocation:()=>false,process:{env:{}},
  ServerOwnership:{acquire:async()=>({release:async()=>calls.push('release')}),canonicalRoot:async value=>value},WorkDataMaintenanceRuntimeHooks:{inspectBoot:async()=>{calls.push('inspect');throw error;}},WorkDataRootHooks:{ready:()=>true,bind:async()=>calls.push('bind')},
  START_ERROR_KINDS:[],PrivacyCore:{configHooks:{}},writeStartError:async()=>calls.push('startup-write'),finishBootCliPathProbes:()=>calls.push('memory-finish')
 });await assert.rejects(()=>fn({}),value=>value===error);assert.deepEqual(calls,['inspect','release']);
});
test('internal strictSamePort uses actual single bind failure while user-like flag keeps normal fallback contract',async t=>{
 const occupied=http.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>occupied.close(resolve)));const port=occupied.address().port,internal={};
 const code=['listenOnce','listenOnNextFreePort','listenWithFallback','listenForWorkbenchServe'].map(name=>functionBlock(router,name)).join('\n');
 const fn=vm.runInNewContext(code+'\nlistenForWorkbenchServe;',{WorkDataMaintenanceRuntimeHooks:{strictSamePort:options=>options===internal},PORT_FALLBACK_SPAN:9,START_NOTICE:{},console:{log:()=>{}}});
 const strict=http.createServer();t.after(()=>strict.listening?new Promise(resolve=>strict.close(resolve)):undefined);await assert.rejects(()=>fn(strict,port,'127.0.0.1',{},internal),{code:'EADDRINUSE'});assert.equal(strict.listening,false);
 const ordinary=http.createServer();t.after(()=>ordinary.listening?new Promise(resolve=>ordinary.close(resolve)):undefined);const actual=await fn(ordinary,port,'127.0.0.1',{}, {strictSamePort:true});assert.ok(actual>port&&actual<=port+9);assert.equal(ordinary.address().port,actual);
});
test('private commands prefer the 13au process composition and hand the successor the normal serve entry',async()=>{
 for(const mode of ['work-data-maintenance','work-data-successor']){
  const calls=[],started=[],hooks={runCold:async()=>calls.push('cold-hook'),runSuccessor:async()=>calls.push('successor-hook')};
  const runtimeHost={startColdMaintenance:async(...args)=>{calls.push(['cold',args.length]);return 'cold';},
   startSuccessorMaintenance:async options=>{calls.push(['successor',Object.keys(options)]);await options.startServe({host:'127.0.0.1',port:'4321'});return 'successor';}};
  const context={process:{argv:['node','server.js',mode]},Object,WorkDataVerifierEntry:VerifierEntry,WorkDataMaintenanceRuntimeHooks:hooks,WorkDataRuntimeHost:runtimeHost,
   startWorkbenchServe:async options=>{started.push(options);return 'served';}};
  const fn=vm.runInNewContext(parse+'\n'+functionBlock(main,'main')+'\nmain;',context);
  assert.equal(await fn(),mode==='work-data-maintenance'?'cold':'successor');
  if(mode==='work-data-maintenance'){assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['cold',0]]);assert.equal(started.length,0);}
  else{assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['successor',['startServe']]]);assert.deepEqual(JSON.parse(JSON.stringify(started)),[{host:'127.0.0.1',port:'4321'}]);}
  context.process.argv=['node','server.js',mode,'--port','1'];
  await assert.rejects(()=>fn(),{code:'work_data_setup.private_command_invalid'});
  assert.equal(calls.length,1,'a rider flag must never re-enter the private composition');
 }
});
test('runtime glue does not add or modify the production module.exports surface',()=>{
 // Exact reviewed export declaration from 27b1788d; no TEMP baseline file dependency.
 const declaration=bracedBlock(main,'module.exports = {');assert.ok(declaration.length>100);assert.equal(require('node:crypto').createHash('sha256').update(declaration).digest('hex'),'0099fa1678c03e487fab5da1f11973a879cde3348da67ea604b77c1a5a9821d9');
});
