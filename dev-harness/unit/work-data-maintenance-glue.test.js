'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),p=require('node:path'),vm=require('node:vm'),http=require('node:http');
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
  resolveBindHost:()=> '127.0.0.1',dataRoot:()=>'/root',dataRootSource:()=>'default',defaultDataRoots:()=>({legacy:'/legacy',next:'/next'}),lstatOrNull:()=>null,isDirectServeInvocation:()=>false,process:{env:{}},
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

// P2-4: `doctor --clear-boot-root` is the only operational exit for the boot-root
// preference. It must never acquire the data root, start a serve, run a migration or
// fall through to the ordinary doctor, and it may only use the inspected receipt.
const clearContext=(owner,extra={})=>{
 const calls=[],lines=[];
 const context={process:{argv:['node','server.js','doctor','--clear-boot-root']},Object,console:{log:line=>lines.push(line)},
  WorkDataVerifierEntry:{COMMAND:'work-data-verify'},WorkDataMaintenanceRuntimeHooks:{rootPreference:owner},
  withSelectedWorkDataRoot:()=>{throw Error('root acquisition forbidden');},
  doctor:()=>{throw Error('ordinary doctor forbidden');},
  startWorkbenchServe:()=>{throw Error('serve forbidden');},
  installIntegration:()=>{throw Error('install forbidden');},startMcp:()=>{throw Error('mcp forbidden');},
  ...extra};
 const fn=vm.runInNewContext(parse+'\n'+functionBlock(main,'clearBootRootPreference')+'\n'+functionBlock(main,'main')+'\nmain;',context);
 return {fn,context,calls,lines};
};
const clearOwner=({present=true,remove=null}={})=>{
 const calls=[];let reads=0;
 const receipt=Object.freeze({base:'C:\\restored\\root',sha256:'a'.repeat(64),dev:'11',ino:'22'});
 const owner={inspect:async()=>{calls.push('inspect');reads++;if(!present)return{present:false};return reads===1?{present:true,receipt}:{present:false};},
  remove:async value=>{calls.push(['remove',value]);return remove?remove(value):true;}};
 return {owner,calls,receipt};
};
test('doctor --clear-boot-root removes exactly the inspected receipt and stops there',async()=>{
 const {owner,calls,receipt}=clearOwner();
 const {fn,lines}=clearContext(owner);
 await fn();
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),['inspect',['remove',{...receipt}],'inspect']);
 assert.deepEqual(lines,['boot-root preference: cleared'],'one concise line, no path or secret');
});
test('doctor --clear-boot-root is idempotent when no preference exists',async()=>{
 const {owner,calls}=clearOwner({present:false});
 const {fn,lines}=clearContext(owner);
 await fn();await fn();
 assert.deepEqual(calls,['inspect','inspect'],'nothing is removed when the record is absent');
 assert.deepEqual(lines,['boot-root preference: absent','boot-root preference: absent']);
});
test('doctor --clear-boot-root refuses typed and never swallows a failure',async()=>{
 const failing=clearOwner({remove:()=>{throw Object.assign(Error('modeled CAS refusal'),{code:'work_data_boot_root.record_changed'});}});
 const failed=clearContext(failing.owner);
 await assert.rejects(()=>failed.fn(),{code:'work_data_setup.root_preference_remove_failed'});
 assert.deepEqual(failed.lines,[],'a refusal never prints success');

 const unreadable=clearContext({inspect:async()=>{throw Object.assign(Error('modeled unreadable'),{code:'work_data_boot_root.inspect_failed'});},remove:async()=>true});
 await assert.rejects(()=>unreadable.fn(),{code:'work_data_setup.root_preference_unreadable'});

 const missing=clearContext(undefined);
 await assert.rejects(()=>missing.fn(),{code:'work_data_setup.root_preference_unavailable'});

 const partial=clearContext({inspect:async()=>({present:false})});
 await assert.rejects(()=>partial.fn(),{code:'work_data_setup.root_preference_unavailable'},'inspect without remove is not a clear capability');

 const rider=clearOwner(),riderContext=clearContext(rider.owner);
 riderContext.context.process.argv=['node','server.js','doctor','--clear-boot-root','--human'];
 await assert.rejects(()=>riderContext.fn(),{code:'work_data_setup.private_command_invalid'});
 assert.deepEqual(rider.calls,[],'a rider flag never falls through to an acquisition or the ordinary doctor');
});
test('doctor --clear-boot-root asks the 13au seam before refusing a missing owner',async()=>{
 const hooks={},calls=[],lines=[],owner={inspect:async()=>{calls.push('inspect');return{present:false};},remove:async()=>{calls.push('remove');return true;}};
 const context={process:{argv:['node','server.js','doctor','--clear-boot-root']},Object,console:{log:line=>lines.push(line)},
  WorkDataVerifierEntry:{COMMAND:'work-data-verify'},WorkDataMaintenanceRuntimeHooks:hooks,
  WorkDataRuntimeHost:{installRootPreference:()=>{calls.push('install');hooks.rootPreference=owner;return owner;}},
  withSelectedWorkDataRoot:()=>{throw Error('root acquisition forbidden');},doctor:()=>{throw Error('ordinary doctor forbidden');},
  startWorkbenchServe:()=>{throw Error('serve forbidden');}};
 const fn=vm.runInNewContext(parse+'\n'+functionBlock(main,'clearBootRootPreference')+'\n'+functionBlock(main,'main')+'\nmain;',context);
 await fn();
 assert.deepEqual(calls,['install','inspect'],'the idempotent seam runs before the refusal path');
 assert.deepEqual(lines,['boot-root preference: absent']);
});
test('doctor --clear-boot-root drives the real 13aw owner against the real home record',async t=>{
 const sourceRoot=p.join(__dirname,'../../ruyi-workbench/app/src');
 const boot=fs.readFileSync(p.join(sourceRoot,'00-boot.js'),'utf8');
 const start=boot.indexOf('const BOOT_ROOT_PREFERENCE_DIR');
 const marker='const BootRootPreference = Object.freeze({';
 const codec=boot.slice(start,boot.indexOf('});',boot.indexOf(marker))+3);
 const context=vm.createContext({require,Buffer,process,os,path:p,fs,console:{log:()=>{}}});
 vm.runInContext(codec+'\n'+fs.readFileSync(p.join(sourceRoot,'13aw-work-data-root-preference.js'),'utf8'),context,{filename:'13aw-work-data-root-preference.js'});
 const {WorkDataRootPreference}=vm.runInContext('({WorkDataRootPreference})',context);
 const home=fs.mkdtempSync(p.join(os.tmpdir(),'glue-boot-root-home-')),target=fs.mkdtempSync(p.join(os.tmpdir(),'glue-boot-root-target-'));
 t.after(()=>{fs.rmSync(home,{recursive:true,force:true});fs.rmSync(target,{recursive:true,force:true});});
 const owner=WorkDataRootPreference.create({home,flush:async()=>{}});
 const stat=fs.lstatSync(target,{bigint:true});
 const file=p.join(home,'.ruyi','boot-root-v1.json');
 await owner.write({schema:1,kind:'restored-boot-root',base:p.resolve(target),
   baseIdentity:{dev:String(stat.dev),ino:String(stat.ino)},
   authority:{generation:0,id:null,mode:'plain',sha256:null},
   resultId:'a'.repeat(48),resultSha256:'c'.repeat(64),createdAt:'2026-10-28T00:00:00.000Z'},null);
 assert.equal(fs.existsSync(file),true);

 const lines=[],fn=vm.runInNewContext(functionBlock(main,'clearBootRootPreference')+'\nclearBootRootPreference;',
   {console:{log:line=>lines.push(line)},WorkDataMaintenanceRuntimeHooks:{rootPreference:owner}});
 await fn();
 assert.equal(fs.existsSync(file),false,'the real record is deleted once');
 assert.deepEqual(lines,['boot-root preference: cleared']);
 assert.equal((await owner.inspect()).present,false);
 await fn();
 assert.deepEqual(lines,['boot-root preference: cleared','boot-root preference: absent']);
});
