'use strict';
// Real host cache -> processor/contract/service -> maintenance -> serve observer.
// Only files, child events, pipe, and clocks are inert; no native or HTTP work.
require('../lib/media-artifact-test-guard');
const {test}=require('node:test');
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {constBlock,functionBlock,sliceBlock}=require('../lib/source-slice');
const sourceDir=path.resolve(__dirname,'../../ruyi-workbench/app/src');
const read=name=>fs.readFileSync(path.join(sourceDir,name),'utf8');
const names=['01j-local-crypto.js','01i-privacy-rules.js','01h-privacy-core.js','13ba-media-image-contract.js','13bc-media-image-processor.js','13bd-media-image-service.js','13be-media-image-host.js','13ag-work-data-maintenance.js','13u-migration-center.js','13au-work-data-runtime-host.js'];
const sources=Object.fromEntries(names.map(name=>[name,read(name)]));
const hasDesktop=fs.existsSync(path.join(sourceDir,'13ax-desktop-lifetime.js'));
if(hasDesktop)sources['13ax-desktop-lifetime.js']=read('13ax-desktop-lifetime.js');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<50;i++){if(predicate())return;await tick();}a.fail('synthetic transition not reached');}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

function fixture({verification}={}){
  const timers=new Map(),keepers=[],children=[],exits=[],frames=[];
  let nextTimer=0,verifications=0,kills=0,opens=0,closes=0,stopResult,stopError;
  const timeout=(fn,ms)=>{const id=++nextTimer;if(ms===25)queueMicrotask(fn);else timers.set(id,{fn,ms});return id;};
  const clear=id=>timers.delete(id),interval=(fn,ms)=>{const row={fn,ms,ref(){}};keepers.push(row);return row;};
  const proof={schema:1,verificationKind:'offline-artifact-inventory',dependencyFilesVerified:true,pythonVersion:'3.12.10',runtimeArtifacts:4987,verifiedRuntimeBytes:413946142,sourceArchiveVerified:true,verifiedSourceBytes:19922194,installsPerformed:false,mediaProcessingEnabled:false,mediaEgressEnabled:false};
  const stat={dev:1n,ino:2n,size:32n,mtimeNs:3n,ctimeNs:4n,nlink:1n,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
  const directory={isDirectory:()=>true,isSymbolicLink:()=>false},io={lstat:async()=>stat,realpath:async value=>value};
  const childProcess={spawn(){const child=new EventEmitter();child.pid=456+children.length;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=(_wire,callback)=>queueMicrotask(()=>{child.emit('spawn');callback?.();});child.kill=()=>{kills++;return true;};children.push(child);return child;}};
  const load=name=>name==='node:fs/promises'?io:name==='node:child_process'?childProcess:name==='node:timers'?{setTimeout:timeout,clearTimeout:clear,setInterval:interval,clearInterval(){}}:name==='../tools/verify-media-artifacts.cjs'?{verifyMediaArtifacts:async()=>{verifications++;if(verification)await verification.promise;return proof;}}:require(name);
  const config={privacyModeV1:'on',workDataEncryptionV1:false},policyConfig={personal:true,rules:[]};
  const policy={config:policyConfig,hash:sha(JSON.stringify(policyConfig)),rulesHash:sha('rules'),revision:'p1',assert:()=>true};
  const ctx={require:load,Buffer,Headers,AbortController,crypto,path,queueMicrotask,
    process:{platform:process.platform,env:{},pid:123},setTimeout:timeout,clearTimeout:clear,setInterval:interval,clearInterval(){},
    fs:{writeSync(){},existsSync(){throw Error('unexpected real filesystem query');},lstatSync:file=>file.endsWith('.png')?stat:directory,fstatSync:()=>stat,realpathSync:{native:file=>file}},
    fsp:{async open(){opens++;let read=false;return{fd:7,async close(){closes++;},async read(bytes,offset,length){if(read)return{bytesRead:0};read=true;bytes.fill(7,offset,offset+length);return{bytesRead:length};}};}},
    paths:{uploads:path.resolve('synthetic-uploads'),data:path.resolve('synthetic-data')},appRoot:()=>path.resolve('synthetic-app'),
    assertSessionIdForPath:id=>id,sanitizeFsSegmentName:name=>name,readConfig:async()=>config,loadSession:async id=>({id}),sessionSaveIsTombstoned:()=>false,
    PrivacyGateway:{active:()=>({scopeId:'synthetic_scope'}),run:(_id,_config,work)=>work(),captureMediaPolicy:()=>policy,setHost(){}},
    WorkDataStore:{requireKeys:()=>({})},MediaDerivedStore:{create(){throw Error('failed preparation must not reach storage');}},atomicWriteJson(){throw Error('actual writes forbidden');},
    activeOpenAiProvider:()=>({vision:true,model:'synthetic',baseUrl:'https://model.invalid'}),providerWireProtocol:()=>({completionUrl:value=>value,requestHeaders:()=>({'X-Tenant':'synthetic'})}),
    ProviderMediaHooks:{},VisualMediaHooks:{},MediaImageHooks:{},DesktopLifetimeHooks:{},WorkDataMaintenanceHooks:{},WorkDataSetupHooks:{closeForDesktop:async()=>true},WorkDataMaintenanceRuntimeHooks:{},
    turnSettlers:new Map(),activeAgentRuns:new Map(),shellSessions:new Map(),activeChildren:new Map(),turnOutcomePending:new Map(),toolboxServices:new Map(),pendingSessionIndex:new Map(),inflightSessionIndex:new Map(),sessionIndexRebuildsActive:0,
    configMutateChain:Promise.resolve(),configWriteChain:Promise.resolve(),usageLedgerChain:Promise.resolve(),engineTranscriptLedgerChain:Promise.resolve(),sessionIndexChain:Promise.resolve(),memoryUsageWriteChain:Promise.resolve(),agentInstructionChain:Promise.resolve(),toolboxReconcileChain:Promise.resolve(),stewardDecisionChain:Promise.resolve(),stewardMemoryChain:Promise.resolve(),stewardAppendChain:Promise.resolve(),schedulerTasksChain:Promise.resolve(),schedulerFiresChain:Promise.resolve(),migrationChain:Promise.resolve(),
    McpConsumers:{maintenanceState:()=>({pending:[],active:0})},SessionFullTextHooks:{},InternalMcpHooks:{Hooks:{},maintenanceState:()=>({active:0})},MemoryCliHooks:{Hooks:{}},PrivacyLocalDriveProbe:{setHost(){},stopSync(){}},
    sessionIndexFlushTimer:null,logStream:null,pretenderIndexRuntime:{writeChain:Promise.resolve(),value:null,writers:0},schedulerRuntime:{ticking:false,inFlightTaskIds:new Set()},stewardRuntime:{ticking:false,carry:[],adopted:[],wakeTimers:[]},stewardRunnerRuntime:{inflight:null,queue:[],viewHeld:[]},stewardUserWaiters:[],stewardArbiter:{draining:false},
    externalBotInflight:0,externalBotWorkerBusy:false,externalBotDiscoveryBusy:false,externalBotActiveActors:new Set(),externalBotUnsettled:new Set(),externalBotDeliveries:new Set(),externalBotWorkerAgain:false,
    kimiBridgeState:{starting:null},kimiHttpControllers:new Set(),kimiModelProbeChildren:new Set(),agentWakeTimers:new Map(),
    stewardClearWake(){},flushSessionIndex:async()=>{},flushPretenderPersist:async()=>{},flushWorkbenchLogs:async()=>{},ToolboxHooks:{stopAll:async()=>{}},stopKimiModelProbes(){},stopKimiServer:async()=>{},killAllMcpClients(){},killAllShellSessions(){},ExternalBotHooks:{},StewardHooks:{},stopScheduler(){},stopAllActiveTurnsSync(){},desktopLifetimeBootstrap:null,
  };
  for(const name of ['kimiMcpSyncChains','sessionWriteChains','sessionNotesWriteChains','sessionScratchpadChains','interventionWriteChains','missionChangeWriteChains','sessionMetaDeferChains','sessionMutateChains','journalWriteChains','journalRevertChains','missionContainerChains','voiceLexiconChains','memoryProposalStateChains','agentRunWriteChains','agentRunEventChains','backgroundJobChains','fileToolWriteChains','proxyModelsCacheChains','sessionSearchRefreshChains','stewardArchiveChains','externalBotChains'])ctx[name]=new Map();
  vm.createContext(ctx);
  const modules=['01j-local-crypto.js','01i-privacy-rules.js','01h-privacy-core.js','13ba-media-image-contract.js','13bc-media-image-processor.js','13bd-media-image-service.js','13ag-work-data-maintenance.js','13be-media-image-host.js'];
  if(hasDesktop)modules.push('13ax-desktop-lifetime.js');
  vm.runInContext(modules.map(name=>sources[name]).join('\n'),ctx);
  const migrationObserver=sources['13u-migration-center.js'].split('\n').find(line=>line.trim().startsWith('helperMayStillRun: () => migrationCapsuleBroker.helperMayStillRun'));
  a.ok(migrationObserver,'original migration observer');
  vm.runInContext(functionBlock(sources['13u-migration-center.js'],'migrationCapsuleBroker')+'\nconst MigrationHooks={'+migrationObserver+'};\n'+constBlock(sources['13au-work-data-runtime-host.js'],'WorkDataServeUploadBootstrap')+'\n'+
    "const serveUploads=WorkDataServeUploadBootstrap.create({ownership:{acquire(){},canonicalRoot(){},isLease(){},owns(){},createSourceKeeper(){},isSourceKeeper(){}},hostApi:{create(){}},proc:process,temp:require('node:path').resolve('synthetic-temp')});WorkDataMaintenanceRuntimeHooks.helperMayStillRun=serveUploads.helperMayStillRun;",ctx);
  const api=vm.runInContext('({MediaImageHost,MediaImageHooks,WorkDataMaintenanceHooks,WorkDataMaintenanceRuntimeHooks,local:()=>LocalSecretCrypto.helperMayStillRun(),migration:()=>MigrationHooks.helperMayStillRun()})',ctx);
  const prepare=signal=>api.WorkDataMaintenanceHooks.run('http',()=>api.MediaImageHost.prepare({sessionId:'synthetic_scope',id:'file_one',name:'image.png'},signal));
  async function abortActive(){
    const controller=new AbortController();let failure;
    const observed=prepare(controller.signal).catch(error=>{failure=error;});
    await until(()=>children.length===1);a.equal(api.WorkDataMaintenanceHooks.status().admitted,1,'HTTP/media share the real token');
    controller.abort();await observed;
    a.equal(failure.code,'privacy.image_processor_close_unknown');a.equal(failure.helperMayStillRun,true);a.equal(failure.ownershipRetained,true);
    a.equal(kills,1);a.equal(opens,1);a.equal(closes,1,'service finally released source');a.equal(api.WorkDataMaintenanceHooks.status().admitted,0,'both token references released');
    return failure;
  }
  async function cleanOwner(){const controller=new AbortController();controller.abort();await a.rejects(prepare(controller.signal),error=>error.code==='privacy.image_cancelled');a.equal(children.length,0);a.equal(verifications,1);}
  async function desktopClose(){
    a.equal(hasDesktop,true);
    const socket=new EventEmitter();socket.setEncoding=()=>{};socket.destroy=()=>{socket.destroyed=true;};
    socket.write=(wire,callback)=>{const value=JSON.parse(wire);frames.push(value);callback?.();if(value.seq>0)queueMicrotask(()=>socket.emit('data',JSON.stringify({schema:1,seq:value.seq,kind:'ok'})+'\n'+(value.kind==='hello'?'{"schema":1,"seq":0,"kind":"active"}\n':'')));};
    ctx.syntheticSocket=socket;ctx.syntheticClock={setTimeout:timeout,clearTimeout:clear,setInterval:interval};ctx.syntheticProcess={pid:123,exit(code){exits.push(code);}};
    ctx.syntheticConnect=()=>{queueMicrotask(()=>socket.emit('connect'));return socket;};ctx.recordStop=value=>{stopResult=value;};ctx.recordError=error=>{stopError=error;};
    ctx.syntheticServer={listening:true,close(callback){this.listening=false;callback();},closeAllConnections(){}};
    vm.runInContext("desktopLifetimeServer=syntheticServer;desktopLifetimeClient=DesktopLifetime.create({bootstrap:JSON.stringify({schema:1,pipe:'ruyi-desktop-'+'e'.repeat(64),cap:'a'.repeat(64),role:'serve'}),proc:syntheticProcess,clock:syntheticClock,connect:syntheticConnect,stop:async()=>{try{const value=await desktopLifetimeStop();recordStop(value);return value;}catch(error){recordError(error);throw error;}}});",ctx);
    await vm.runInContext('desktopLifetimeClient.open()',ctx);socket.emit('data','{"schema":1,"seq":0,"kind":"close"}\n');
    await until(()=>frames.some(row=>row.kind==='uncertain'||row.kind==='finished'));await tick();
    return{stopResult,stopError,frames,exits,status:api.WorkDataMaintenanceHooks.status(),unknown:vm.runInContext('desktopLifetimeClient.unknown()',ctx)};
  }
  return{api,ctx,children,keepers,prepare,abortActive,cleanOwner,desktopClose,stats:()=>({verifications,kills,opens,closes})};
}

test('uninitialized and pending verification create no helper; real admission covers the unresolved owner',async()=>{
  const verification=deferred(),f=fixture({verification}),hooks=f.api.WorkDataMaintenanceHooks;
  a.equal(f.api.MediaImageHooks.helperMayStillRun(),false);a.equal(hooks.helperMayStillRun(),false);a.equal(f.stats().verifications,0);
  const controller=new AbortController(),pending=f.prepare(controller.signal);void pending.catch(()=>{});
  await until(()=>f.stats().verifications===1);a.equal(f.children.length,0);a.equal(hooks.status().admitted,1);a.equal(hooks.helperMayStillRun(),false);
  controller.abort();verification.resolve();await a.rejects(pending,error=>error.code==='privacy.image_cancelled');a.equal(hooks.status().admitted,0);
});

test('resolved clean owner stays cached across environment changes without creating or granting another worker',async()=>{
  const f=fixture();await f.cleanOwner();
  a.equal(f.api.MediaImageHooks.helperMayStillRun(),false);a.equal(f.api.WorkDataMaintenanceHooks.helperMayStillRun(),false);a.equal(f.api.WorkDataMaintenanceRuntimeHooks.helperMayStillRun(),false);
  f.ctx.process.env.RUYI_MEDIA_RUNTIME_ROOT=path.resolve('different-runtime');f.ctx.process.env.RUYI_MEDIA_OCR_LANGUAGE='en-US';
  await f.cleanOwner();a.equal(f.stats().verifications,1,'original cached owner is retained');a.equal(f.children.length,0);
});

test('cached initialization rejection is not unknown helper and does not retry under changed configuration',async()=>{
  const verification=deferred(),f=fixture({verification});
  const pending=f.prepare();void pending.catch(()=>{});await until(()=>f.stats().verifications===1);verification.reject(Error('synthetic verification failure'));
  await a.rejects(pending);f.ctx.process.env.RUYI_MEDIA_RUNTIME_ROOT=path.resolve('different-runtime');await a.rejects(f.prepare());
  a.equal(f.stats().verifications,1);a.equal(f.children.length,0);a.equal(f.api.WorkDataMaintenanceHooks.helperMayStillRun(),false);
});

test('real cached processor abort permanently propagates unknown after source/token release and late child close',async()=>{
  const f=fixture();await f.abortActive();
  a.equal(f.api.MediaImageHooks.helperMayStillRun(),true);a.equal(f.api.WorkDataMaintenanceHooks.helperMayStillRun(),true);a.equal(f.api.WorkDataMaintenanceRuntimeHooks.helperMayStillRun(),true);
  a.equal(f.api.local(),false);a.equal(f.api.migration(),false);a.equal(f.keepers.length,2,'genuine media and serve unknown keepers');
  f.children[0].emit('exit',0);f.children[0].emit('close',0);await tick();
  a.equal(f.api.MediaImageHooks.helperMayStillRun(),true);a.equal(f.api.WorkDataMaintenanceHooks.helperMayStillRun(),true);a.equal(f.api.WorkDataMaintenanceRuntimeHooks.helperMayStillRun(),true);
  const verifications=f.stats().verifications;
  await a.rejects(f.prepare(),error=>error.helperMayStillRun===true);a.equal(f.stats().verifications,verifications,'unknown owner is not replaced or reverified');a.equal(f.children.length,1);
});

test('resolved owner query missing, throwing or non-false is fail closed through the actual cache slice',async()=>{
  // Defensive boundary only. The abort counterexample above uses the full host
  // and genuine frozen processor; these inert owners exercise malformed queries.
  const cache=sliceBlock(sources['13be-media-image-host.js'],'  let processorPromise =','  function assertAncestors');
  const observe=functionBlock(sources['13ag-work-data-maintenance.js'],'workDataHelpersMayStillRun');
  a.ok(cache.length>500&&observe.length>200,'real private cache and maintenance observer');
  for(const [owner,expected]of [[{},true],[{helperMayStillRun(){throw Error('synthetic owner query');}},true],[{helperMayStillRun:()=>undefined},true],[{helperMayStillRun:()=>false},false]]){
    let creates=0;const ctx={path,process:{platform:process.platform,env:{}},appRoot:()=>path.resolve('synthetic-app'),MediaImageProcessor:{create:async()=>{creates++;return owner;}},workDataInfrastructureFailureSet:false};
    const api=vm.runInNewContext(cache+'\nconst MediaImageHooks={helperMayStillRun};\n'+observe+'\n({processor,inspect:workDataHelpersMayStillRun})',ctx);
    a.equal(api.inspect(),false);a.equal(creates,0);await api.processor();a.equal(creates,1);
    a.equal(api.inspect(),expected);
    await api.processor();a.equal(creates,1,'query cannot create or replace cached resources');
  }
});

test('malformed or throwing hook query fails closed and the original serve observer retains that uncertainty',async()=>{
  const f=fixture();await f.cleanOwner();const hooks=f.api.MediaImageHooks,maintenance=f.api.WorkDataMaintenanceHooks;
  const original=hooks.helperMayStillRun;hooks.helperMayStillRun=42;a.equal(maintenance.helperMayStillRun(),true);
  hooks.helperMayStillRun=()=>undefined;a.equal(maintenance.helperMayStillRun(),true);
  Object.defineProperty(hooks,'helperMayStillRun',{configurable:true,get(){throw Error('synthetic observer failure');}});
  a.equal(maintenance.helperMayStillRun(),true);a.equal(f.api.WorkDataMaintenanceRuntimeHooks.helperMayStillRun(),true);
  Object.defineProperty(hooks,'helperMayStillRun',{configurable:true,writable:true,value:original});
  a.equal(maintenance.helperMayStillRun(),false);a.equal(f.api.WorkDataMaintenanceRuntimeHooks.helperMayStillRun(),true,'serve owner never clears retained unknown');
});

test('maintenance waiting still rejects fresh admission after media uncertainty',async()=>{
  const f=fixture();await f.abortActive();const hooks=f.api.WorkDataMaintenanceHooks,lease=hooks.begin();
  a.equal(hooks.accepting(),false);await a.rejects(hooks.fresh('media-image',()=>a.fail('fresh callback must not run')),error=>error.code==='work_data.maintenance_busy');
  a.equal(hooks.status().admitted,0);lease.resume();a.equal(hooks.helperMayStillRun(),true,'resuming maintenance cannot erase media unknown');
});

test('Desktop transport refuses retire, finished and exit after genuine media unknown and late close',{skip:!hasDesktop},async()=>{
  const f=fixture();await f.abortActive();f.children[0].emit('exit',0);f.children[0].emit('close',0);await tick();
  const result=await f.desktopClose();
  a.equal(result.frames.some(row=>row.kind==='finished'),false,'permanent media unknown must not be announced finished');a.deepEqual(result.exits,[]);
  a.equal(result.stopResult,undefined);a.equal(result.stopError?.message,'desktop_lifetime.helper_uncertain');a.equal(result.status.phase,'idle');a.equal(result.status.admitted,0);a.equal(result.unknown,true);
  a.throws(()=>f.api.WorkDataMaintenanceHooks.admitHelper(),error=>error.code==='work_data.maintenance_busy');
  a.equal(f.api.MediaImageHooks.helperMayStillRun(),true);
});

test('Desktop normal close still accepts an initialized clean owner',{skip:!hasDesktop},async()=>{
  const f=fixture();await f.cleanOwner();const result=await f.desktopClose();
  a.equal(result.stopError,undefined);a.equal(result.stopResult,true);a.equal(result.frames.some(row=>row.kind==='finished'),true);a.deepEqual(result.exits,[0]);a.equal(result.status.phase,'retired');
  // The synthetic exit records a request; its later continuation is not native proof.
});
