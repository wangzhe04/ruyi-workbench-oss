'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const crypto=require('node:crypto'),{EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const repo=process.env.RUYI_SETUP_REPO||path.resolve(__dirname,'../..'),draft=process.env.RUYI_SETUP_DRAFT||(fs.existsSync(path.join(__dirname,'13ah-work-data-setup.js'))?__dirname:path.join(repo,'ruyi-workbench/app/src')),{constBlock,functionBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const sourceFile=name=>fs.existsSync(path.join(draft,'src',name))?path.join(draft,'src',name):fs.existsSync(path.join(draft,name))?path.join(draft,name):path.join(repo,'ruyi-workbench/app/src',name);
const setupSource=fs.readFileSync(sourceFile('13ah-work-data-setup.js'),'utf8'),maintenanceSource=fs.readFileSync(sourceFile('13ag-work-data-maintenance.js'),'utf8');
const SetupOwnership=vm.runInNewContext(constBlock(fs.readFileSync(sourceFile('01g-server-ownership.js'),'utf8'),'ServerOwnership')+'\nServerOwnership',{require,Buffer,process});
const SetupRecovery=vm.runInNewContext(constBlock(fs.readFileSync(sourceFile('01t-work-data-recovery.js'),'utf8'),'WorkDataRecovery')+'\nWorkDataRecovery',{require,Buffer,process});
// Stable IDs belong only to this isolated upload-broker fixture, not production crypto.
const SetupUploads=vm.runInNewContext(constBlock(fs.readFileSync(sourceFile('13at-work-data-restore-uploads.js'),'utf8'),'WorkDataRestoreUploads')+'\nWorkDataRestoreUploads',{require:name=>name==='node:crypto'?{...crypto,randomBytes:size=>Buffer.alloc(size,0xbb)}:require(name),Buffer,process,WorkDataRecovery:SetupRecovery});
const context={require,Buffer,AbortController,Promise,Set,Map,WeakMap,Object,Error,TypeError,WorkDataRestoreUploads:SetupUploads};
const Setup=vm.runInNewContext(constBlock(setupSource,'WorkDataSetup')+'\nWorkDataSetup',context),Maintenance=vm.runInNewContext(constBlock(maintenanceSource,'WorkDataMaintenance')+'\nWorkDataMaintenance',context);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};},tick=()=>new Promise(setImmediate),until=async predicate=>{for(let i=0;i<60;i++){if(await predicate())return;await tick();}throw Error('condition did not settle');};
const authority={generation:0,id:null,mode:'plain',sha256:null},clone=value=>JSON.parse(JSON.stringify(value)),secret='synthetic setup password only';
function request(body,method='POST'){const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));return{method,async *[Symbol.asyncIterator](){yield bytes;}};}
function fixture(){let counter=0,response;const owners=new Set(),events=[],queue=[],state={authority:clone(authority),resume:0,flush:0},ready=deferred();
 const m=Maintenance.create({owns:owner=>owners.has(owner),snapshot:()=>({busy:{},pending:[],dirty:0}),pause:()=>{events.push('pause');return{};},resume:()=>{state.resume++;events.push('resume');},progress:async()=>{},flush:async()=>{state.flush++;},yield:tick});
 const handle={ready:ready.promise,cancel:async()=>{events.push('cancel-child');},handoff:async()=>{events.push('handoff');}};
 const worker={start:async input=>{state.workerInput=input;events.push('start');return handle;}};
 const host={maintenance:m,inspect:async()=>({authority:clone(state.authority),base:'C:/synthetic/base',configMirror:false}),validateDirectories:async()=>{events.push('validate-paths');},worker:()=>worker,id:()=>String(++counter).padStart(48,'a'),now:()=>'',defer:work=>queue.push(work),respond:(_res,body,status)=>{response={body,status};},receiptPath:p=>p==='/api/permission/decision',receiptOwner:(_p,body)=>body.requestId==='old'?state.owner:null};
 const api=Setup.create(host),body=(patch={})=>({operation:'enable',password:secret,expectedAuthority:clone(state.authority),backupDirectory:'C:/synthetic/backups',...patch});
 const get=async id=>{await api.handle({method:'GET'},{},'/api/work-data/jobs/'+id);return response.body.job;};
 return{api,m,host,worker,handle,state,ready,events,queue,body,owners,get,response:()=>response,start:()=>queue.shift()()};
}


async function bindRestoreUpload(f,t){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-setup-upload-unit-')),base=path.join(root,'base'),custody=path.join(root,'custody');await fsp.mkdir(base);await fsp.mkdir(custody);
 const ownership=await SetupOwnership.acquire([base,custody]),canonicalBase=await SetupOwnership.canonicalRoot(base),canonicalCustody=await SetupOwnership.canonicalRoot(custody),keeper=SetupOwnership.createSourceKeeper(ownership,canonicalBase);
 t.after(async()=>{await keeper.releaseChecked(()=>SetupOwnership.owns(ownership,canonicalBase)&&SetupOwnership.owns(ownership,canonicalCustody));await ownership.release();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ruyi-setup-upload-unit-'));await fsp.rm(root,{recursive:true,force:true});});
 const exclusive=candidate=>keeper.assertExclusive(candidate)&&SetupOwnership.owns(candidate,canonicalCustody);
 const broker=await SetupUploads.create({base:canonicalBase,root:canonicalCustody,ownership,assertExclusive:exclusive,flush:async()=>{}});
 // The controller only inspects container syntax; this synthetic cryptogram is never decrypted.
 const bytes=Buffer.from(JSON.stringify({kind:SetupRecovery.KIND,version:SetupRecovery.VERSION,exportId:'a'.repeat(32),kdf:{name:'scrypt',N:32768,r:8,p:1,salt:Buffer.alloc(16).toString('base64')},cipher:'aes-256-gcm',nonce:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64'),data:Buffer.from('SYNTHETIC CIPHERTEXT').toString('base64')}));
 let uploadId;try{uploadId=await broker.put(bytes);}finally{bytes.fill(0);}assert.equal(uploadId,'b'.repeat(48));assert.equal(SetupUploads.isBroker(broker),true);
 const inspect=f.host.inspect;f.host.inspect=async()=>({...await inspect(),base:canonicalBase});f.worker.resolveUpload=(id,options)=>broker.resolveUpload(id,options);
 return {broker,canonicalBase};
}

test('202 job waits for an admitted old HTTP root, then follows ready/assertIdle/retire/handoff without claiming completion',async()=>{
 const f=fixture(),old=deferred();let effect=false;const ordinary=f.api.runHttp({method:'POST'},'/api/config',async()=>{await old.promise;effect=true;});
 await f.api.handle(request(f.body()),{},'/api/work-data/jobs');assert.equal(f.response().status,202);const id=f.response().body.job.id;assert.equal(f.response().body.job.state,'queued');assert.equal(f.events.includes('pause'),false);
 f.start();await until(()=>f.m.status().phase==='waiting');await tick();assert.equal(f.events.includes('start'),false);assert.equal(effect,false);old.resolve();await ordinary;
 await until(()=>f.events.includes('start'));assert.equal(f.state.workerInput.password,secret);assert.equal(f.m.status().phase,'idle');assert.equal(f.events.includes('handoff'),false);f.ready.resolve();await until(()=>f.events.includes('handoff'));
 const job=await f.get(id);assert.equal(job.state,'handoff');assert.equal(job.takeover,true);assert.equal(job.cancellable,false);assert.equal(f.m.status().phase,'retired');assert.equal(f.state.resume,0);assert.equal(JSON.stringify(await f.api.status()).includes(secret),false);
});

test('cancel queued work prevents maintenance and child launch and keeps passwords out of public state',async()=>{
 const f=fixture(),job=await f.api.submit(f.body());assert.equal(JSON.stringify(job).includes(secret),false);assert.equal((await f.api.cancel(job.id)).state,'cancel_requested');f.start();await until(async()=>(await f.get(job.id)).state==='cancelled');assert.equal(f.events.includes('pause'),false);assert.equal(f.events.includes('start'),false);assert.equal(f.m.accepting(),true);assert.equal(JSON.stringify(await f.get(job.id)).includes(secret),false);
});

test('cancel during drain resumes intake without cancelling the in-flight business owner',async()=>{
 const f=fixture(),old=deferred();let completed=false;const task=f.m.run('turn',async()=>{await old.promise;completed=true;});const job=await f.api.submit(f.body());f.start();await until(()=>f.m.status().phase==='waiting');await f.api.cancel(job.id);
 await until(async()=>(await f.get(job.id)).state==='cancelled');assert.equal(f.m.accepting(),true);assert.equal(completed,false);assert.equal(f.events.includes('start'),false);old.resolve();await task;assert.equal(completed,true);
});

test('cancel while start resolves later kills only the waiting child and never sends go',async()=>{
 const f=fixture(),started=deferred();f.worker.start=async()=>{f.events.push('start');return started.promise;};const job=await f.api.submit(f.body());f.start();await until(()=>f.events.includes('start'));await f.api.cancel(job.id);started.resolve(f.handle);
 await until(async()=>(await f.get(job.id)).state==='cancelled');assert.equal(f.events.includes('cancel-child'),true);assert.equal(f.events.includes('handoff'),false);assert.equal(f.m.accepting(),true);f.ready.reject(Error('owned child closed'));
});

test('late tracked writer invalidates ready receipt before commitment and causes safe child cancellation/resume',async()=>{
 const f=fixture(),write=deferred(),job=await f.api.submit(f.body());f.start();await until(()=>f.events.includes('start'));f.m.track(write.promise);f.ready.resolve();await until(async()=>['failed','handoff','uncertain'].includes((await f.get(job.id)).state));assert.equal((await f.get(job.id)).state,'failed');
 assert.equal(f.events.includes('handoff'),false);assert.equal(f.events.includes('cancel-child'),true);assert.equal(f.m.accepting(),true);assert.equal((await f.get(job.id)).takeover,false);write.resolve();
});

test('cancel while awaiting ready promptly cancels its own child even if ready never settles',async()=>{
 const f=fixture(),job=await f.api.submit(f.body());f.start();await until(()=>f.events.includes('start'));await tick();await f.api.cancel(job.id);
 await until(async()=>(await f.get(job.id)).state==='cancelled');assert.equal(f.events.includes('cancel-child'),true);assert.equal(f.events.includes('handoff'),false);assert.equal(f.m.accepting(),true);
});

test('handoff failure stays retired and uncertain with no warm resume, retry or cancel',async()=>{
 const f=fixture();f.handle.handoff=async()=>{f.events.push('handoff');throw Object.assign(Error(secret),{code:'ESECRET'});};const job=await f.api.submit(f.body());f.start();await until(()=>f.events.includes('start'));f.ready.resolve();await until(async()=>['uncertain','failed','handoff'].includes((await f.get(job.id)).state));await tick();assert.equal((await f.get(job.id)).state,'uncertain');
 const result=await f.get(job.id);assert.equal(result.error,'work_data_setup.worker_failed');assert.equal(result.operationMayHaveExecuted,true);assert.equal(f.m.status().phase,'retired');assert.equal(f.state.resume,0);assert.equal(f.events.includes('cancel-child'),false);await assert.rejects(f.api.cancel(job.id),/cancel_too_late/);await assert.rejects(f.api.submit(f.body()),/busy/);assert.equal(JSON.stringify(result).includes(secret),false);
});

test('authority changes after 202 fail before pause or launch, without optimistic completion',async()=>{
 const f=fixture(),job=await f.api.submit(f.body());f.state.authority={generation:1,id:'b'.repeat(48),mode:'encrypted',sha256:'c'.repeat(64)};f.start();for(let i=0;i<12;i++)await tick();assert.equal((await f.get(job.id)).state,'failed');assert.equal((await f.get(job.id)).error,'work_data_setup.authority_changed');assert.equal(f.events.includes('pause'),false);assert.equal(f.events.includes('start'),false);
});

test('launch failure before ready resumes admission, emits only a typed code and never retries',async()=>{
 const f=fixture();f.worker.start=async()=>{f.events.push('start');throw Error(secret);};const job=await f.api.submit(f.body());f.start();await until(async()=>(await f.get(job.id)).state==='failed');assert.equal(f.m.accepting(),true);assert.equal(f.state.resume,1);assert.equal(f.events.filter(row=>row==='start').length,1);assert.equal((await f.get(job.id)).error,'work_data_setup.worker_failed');assert.equal(JSON.stringify(await f.get(job.id)).includes(secret),false);
});

test('strict operation/password/full authority/field validation refuses before scheduling work',async()=>{
 for(const patch of [{password:'short'},{password:'x'.repeat(1025)},{password:'x'.repeat(12)+'\ud800'},{operation:'repair'},{unexpected:1},{expectedAuthority:{generation:0,sha256:null}},{expectedAuthority:{...authority,extra:1}},{targetDirectory:'C:/bad'},{operation:'restore',targetDirectory:'C:/target',uploadId:'bad'}]){const f=fixture();await assert.rejects(f.api.submit(f.body(patch)));assert.equal(f.queue.length,0);assert.equal(f.m.accepting(),true);}
 const f=fixture();f.state.authority.mode='encrypted';await assert.rejects(f.api.submit(f.body({operation:'disable'})),/plaintext_confirmation_required/);assert.equal(f.queue.length,0);
});

test('unbound worker/upload hooks report typed unavailable without accepting fake work or downloads',async()=>{
 const f=fixture();delete f.worker.start;await assert.rejects(f.api.submit(f.body()),error=>error.statusCode===501&&/worker_unavailable/.test(error.code));assert.equal(f.queue.length,0);assert.deepEqual(clone((await f.api.status()).capabilities),{worker:false,upload:false,download:false});
 const g=fixture();await assert.rejects(g.api.submit(g.body({operation:'restore',targetDirectory:'C:/target',uploadId:'a'.repeat(48)})),error=>error.statusCode===501&&/restore_unavailable/.test(error.code));assert.equal(g.queue.length,0);
 // Restore admission is closed: the ordinary input refusals still run first, and no
 // upload grant is resolved whether or not a worker could start.
 const h=fixture(),restoreBody=patch=>h.body({operation:'restore',targetDirectory:'C:/target',uploadId:'a'.repeat(48),...patch});let resolved=0;h.worker.resolveUpload=async()=>{resolved++;return null;};delete h.worker.start;
 await assert.rejects(h.api.submit(restoreBody({uploadId:'bad'})),error=>error.statusCode===400&&/restore_input_invalid/.test(error.code));
 assert.equal(resolved,0);
 await assert.rejects(h.api.submit(restoreBody()),error=>error.statusCode===501&&/restore_unavailable/.test(error.code));
 assert.equal(resolved,0,'a closed restore must not consume the upload grant');
 assert.equal(h.queue.length,0);assert.equal(h.m.accepting(),true);assert.equal(h.events.includes('pause'),false);
});

test('real job inputs retain exact authority and directory bindings while restore is refused before any grant',async t=>{
 for(const operation of ['enable','disable','export']){const f=fixture();if(operation==='disable')f.state.authority.mode='encrypted';
  const body=f.body({operation,...(operation==='disable'?{confirmPlaintext:true}:{})}),expected=clone(body.expectedAuthority),job=await f.api.submit(body);f.start();await until(()=>f.events.includes('start'));
  assert.equal(f.state.workerInput.operation,operation);assert.deepEqual(clone(f.state.workerInput.expectedAuthority),expected);assert.equal(f.state.workerInput.backupDirectory,'C:/synthetic/backups');assert.equal(f.state.workerInput.confirmPlaintext,operation==='disable');
  await f.api.cancel(job.id);await until(async()=>(await f.get(job.id)).state==='cancelled');assert.equal(f.events.includes('handoff'),false);
 }
 // Restore keeps its exact input checks but is refused before any upload grant, queue
 // entry, drain or worker start.
 const f=fixture();await bindRestoreUpload(f,t);let grants=0;const resolve=f.worker.resolveUpload;f.worker.resolveUpload=async(id,options)=>{grants++;return resolve(id,options);};
 await assert.rejects(f.api.submit(f.body({operation:'restore',targetDirectory:'C:/synthetic/target',uploadId:'b'.repeat(48)})),error=>error.statusCode===501&&error.code==='work_data_setup.restore_unavailable'&&error.apiCode===error.code);
 assert.equal(grants,0);assert.equal(f.queue.length,0);assert.equal(f.events.includes('pause'),false);assert.equal(f.events.includes('start'),false);assert.equal(f.m.accepting(),true);
});

test('bounded strict UTF8 object JSON refuses oversized/invalid input before submitting a job',async()=>{
 const f=fixture();for(const raw of ['x'.repeat(16385),'[]','null','{"broken":'])await assert.rejects(f.api.handle(request(raw),{},'/api/work-data/jobs'));assert.equal(f.queue.length,0);
 const req={async *[Symbol.asyncIterator](){yield Buffer.from([255]);}};await assert.rejects(Setup.readJson(req),/body_invalid/);
 await assert.rejects(Setup.readJson(request({text:'x'.repeat(16385)})),error=>error.statusCode===413&&error.code==='work_data_setup.body_too_large');
});

test('closed ordinary mutation and GET refuse before reading their body or performing delayed side effects',async()=>{
 const f=fixture(),lease=f.m.begin();let reads=0,effects=0;const req={method:'POST',async *[Symbol.asyncIterator](){reads++;yield Buffer.from('{}');}};
 await assert.rejects(f.api.runHttp(req,'/api/config',async()=>{effects++;}),/busy/);await assert.rejects(f.api.runHttp({method:'GET'},'/api/status',async()=>{effects++;}),/busy/);assert.equal(reads,0);assert.equal(effects,0);lease.resume();
});

test('closed receipt uses the exact registered owner and cached bounded body; forged receipt cannot enter',async()=>{
 const f=fixture(),owner={};f.state.owner=owner;f.owners.add(owner);const lease=f.m.begin(),req=request({requestId:'old'});let writes=0;
 await f.api.runHttp(req,'/api/permission/decision',async()=>{assert.equal(f.api.cachedBody(req).requestId,'old');assert.equal(f.m.active(),true);writes++;});assert.equal(writes,1);assert.equal(f.api.cachedBody(req),undefined);
 await assert.rejects(f.api.runHttp(request({requestId:'forged'}),'/api/permission/decision',()=>assert.fail()),/receipt_owner_unavailable/);f.owners.delete(owner);await assert.rejects(f.api.runHttp(request({requestId:'old'}),'/api/permission/decision',()=>assert.fail()),/owner_unavailable/);lease.resume();
});

test('signed internal relay and event stream bypass the generic HTTP root and retain their own gates',async()=>{
 const f=fixture(),lease=f.m.begin();for(const [method,p]of [['POST','/api/mcp/internal/request'],['POST','/api/memory-cli'],['GET','/api/events/stream'],['POST','/api/bootstrap']])assert.equal(await f.api.runHttp({method},p,async()=>{assert.equal(f.m.active(),false);return true;}),true);lease.resume();
});

test('real inspect reads bound manifest and bounded raw config without any readConfig/ensure/repair write',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-setup-inspect-')),config=path.join(root,'config.json');t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fsp.rm(root,{recursive:true,force:true});});await fsp.writeFile(config,'{"workDataEncryptionV1":false}');
 const raw=await fsp.readFile(config),selected={canonicalBase:root,generation:0,id:null,proof:{sha256:null}},current={generation:0,id:null,mode:'plain',proof:{sha256:null}};
 const run=vm.runInNewContext(functionBlock(setupSource,'workDataSetupInspect')+'\nworkDataSetupInspect',{fsp,Buffer,paths:{config},WorkDataRootHooks:{ready:()=>true},WorkDataRootAuthority:{selected:()=>selected,mode:mirror=>mirror},WorkDataManifest:{create:()=>({readActive:async()=>current})},readConfig:()=>assert.fail('readConfig may mutate')});
 assert.equal((await run()).authority.mode,'plain');assert.deepEqual(await fsp.readFile(config),raw);current.generation=1;await assert.rejects(run(),/authority_changed/);current.generation=0;await fsp.writeFile(config,'broken');await assert.rejects(run(),/config_unavailable/);assert.equal(await fsp.readFile(config,'utf8'),'broken');
});

test('actual router checks auth first and holds a GET with hidden writes inside admission across awaits',async()=>{
 const f=fixture(),raw=fs.readFileSync(sourceFile('13-http-router.js'),'utf8'),held=deferred();let authorized=false,reads=0,responses=0;
 const context={WorkDataSetupHooks:f.api,WorkDataMaintenanceHooks:f.m,authorizeRoute:()=>authorized?null:'missing or invalid workbench token',apiFailure:(code,_data,_message,status)=>({code,status}),json:(body,status=200)=>({body,status}),send:()=>{responses++;},
  InternalMcpHooks:{},MemoryCliHooks:{},ExternalBotHooks:{},readConfig:async()=>{reads++;await held.promise;return{};},URL,getCapabilities:async()=>({ok:true})};
 const run=vm.runInNewContext(functionBlock(raw,'handleApi')+'\nhandleApi',context),req={method:'GET',url:'/api/capabilities',headers:{}};
 await run(req,{},'/api/capabilities');assert.equal(reads,0);assert.equal(responses,1);authorized=true;const old=run(req,{},'/api/capabilities');await until(()=>reads===1);const lease=f.m.begin();
 await assert.rejects(run(req,{},'/api/capabilities'),/busy/);assert.equal(reads,1);let idle=false;const wait=lease.idle().then(()=>{idle=true;});await tick();assert.equal(idle,false);held.resolve();await old;await wait;assert.equal(responses,2);lease.resume();
});

test('actual receipt lookup binds pending/session/execution identity and grants only stop on a registered run or shell',()=>{
 const owner={},other={},shell={running:true,sessionId:'sess_one'},runOwner={run:{sessionId:'sess_one'}},entry={sessionId:'sess_one'};
 const context={safeSessionId:value=>/^sess_/.test(String(value||''))?value:null,sessionExecutionCheck:(sid,expected)=>({ok:sid==='sess_one'&&expected?.driverRunId==='old',owner}),
  pendingQuestions:new Map([['q',entry]]),pendingPermissions:new Map([['p',entry]]),pendingPlans:new Map(),turnSettlers:new Map([['sess_one',owner],['sess_other',other]]),activeAgentRuns:new Map([['run_one',runOwner]]),shellSessions:new Map([['shell_one',shell]])};
 const lookup=vm.runInNewContext(functionBlock(setupSource,'workDataSetupReceiptOwner')+'\nworkDataSetupReceiptOwner',context);
 assert.equal(lookup('/api/permission/decision',{requestId:'p'}),owner);assert.equal(lookup('/api/chat/answer',{questionId:'q',sessionId:'sess_other'}),null);
 assert.equal(lookup('/api/stop',{sessionId:'sess_one',expectedExecution:{driverRunId:'old'}}),owner);assert.equal(lookup('/api/stop',{sessionId:'sess_one',expectedExecution:{driverRunId:'new'}}),null);
 assert.equal(lookup('/api/missions/sess_other/interventions/p/decision',{}),null);assert.equal(lookup('/api/agent-runs/run_one',{sessionId:'sess_one',action:'resume'}),null);assert.equal(lookup('/api/agent-runs/run_one',{sessionId:'sess_one',action:'stop'}),runOwner);
 assert.equal(lookup('/api/sessions/sess_one/background/stop',{id:'shell:shell_one'}),shell);shell.running=false;assert.equal(lookup('/api/sessions/sess_one/background/stop',{id:'shell:shell_one'}),null);
});

test('real setup directory validation creates nothing and refuses base overlap, missing backup and an existing restore target',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-setup-directories-')),base=path.join(root,'base'),backup=path.join(root,'backup'),target=path.join(root,'restored');t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fsp.rm(root,{recursive:true,force:true});});await fsp.mkdir(base);await fsp.mkdir(backup);
 const run=vm.runInNewContext(functionBlock(setupSource,'workDataSetupDirectories')+'\nworkDataSetupDirectories',{fsp,path,process});
 await run({base,backupDirectory:backup,targetDirectory:target});assert.equal(fs.existsSync(target),false);
 for(const args of [{base,backupDirectory:base},{base,backupDirectory:path.join(root,'missing')},{base,backupDirectory:backup,targetDirectory:base}])await assert.rejects(run(args),error=>error.apiCode==='work_data_setup.path_invalid');
 await fsp.mkdir(target);await assert.rejects(run({base,backupDirectory:backup,targetDirectory:target}),/path_invalid/);assert.equal(fs.existsSync(target),true);
});

test('actual signed memory relay retains an admitted root after its CLI owner disappears during a possible config write',async t=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-setup-memory-'));t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fsp.rm(root,{recursive:true,force:true});});
 const f=fixture(),entered=deferred(),held=deferred(),children=new Map(),settlers=new Map(),runs=new Map();let configFinished=false;
 const context={dataRoot:()=>root,require,Buffer,TextDecoder,AbortController,crypto,path,fsp,activeChildren:children,turnSettlers:settlers,activeAgentRuns:runs,AGENT_RUN_TERMINAL:new Set(),safeSessionId:value=>String(value||''),commandForSelfMcp:()=>({command:process.execPath,args:['synthetic-only.js']}),paths:{data:root,generated:root},RUNTIME:{port:12345},RUYI_MCP_SERVER_ID:'ruyi',VERSION:'unit',MCP_TOOLS:[{name:'workbench_memory_list'},{name:'workbench_memory_read'}],PrivacyGateway:{assertSupported:()=>{}},readConfig:async()=>{entered.resolve();await held.promise;configFinished=true;return{workDataEncryptionV1:true};},atomicWriteJson:async(file,value)=>fsp.writeFile(file,JSON.stringify(value)),requestIsLoopback:()=>true,json:(body,status=200)=>({body,status}),send:(res,value)=>{res.payload=value;res.writableEnded=true;}};
 const relay=vm.runInNewContext(constBlock(fs.readFileSync(sourceFile('13ad-memory-cli-relay.js'),'utf8'),'MemoryCliRelay')+'\nMemoryCliRelay',context),owner={driverRunId:'owned'},session={id:'sess_owner',cwd:root,turnSeq:1};settlers.set(session.id,owner);f.owners.add(owner);
 const grant=await relay.create({session,executionOwner:owner,config:{workDataEncryptionV1:true,includeWorkbenchMcp:false}}),child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null}),reg={child,kind:'claude',state:'running',exited:false,session,executionOwner:owner};children.set(session.id,reg);relay.bind(grant,reg,owner);relay.Hooks.run=(work,actual)=>f.m.continueOwner(actual,work);
 const req=Readable.from([Buffer.from('{"op":"list"}')]);req.method='POST';req.headers={'x-ruyi-memory-cap':grant.definition.env.RUYI_MEMORY_CAP};const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false}),pending=relay.handle(req,res,'/api/memory-cli');await entered.promise;
 settlers.clear();children.clear();f.owners.delete(owner);const lease=f.m.begin();let idle=false;const wait=lease.idle().then(()=>{idle=true;});for(let i=0;i<8;i++)await tick();const idleWhileConfigPending=idle;
 held.resolve();await pending;await wait;lease.resume();assert.equal(idleWhileConfigPending,false);assert.equal(configFinished,true);assert.equal(res.payload.status,403);assert.equal(res.payload.body.result,undefined);
});

test('an existing proposed pool approval/rejection can continue only through its actual live run owner',async()=>{
 const f=fixture(),item={id:'pool_one',status:'proposed'},live={run:{sessionId:'sess_one',status:'running',taskPool:[item]}},runs=new Map([['run_one',live]]);
 const context={pendingPermissions:new Map(),pendingQuestions:new Map(),pendingPlans:new Map(),turnSettlers:new Map(),activeAgentRuns:runs,AGENT_RUN_TERMINAL:new Set(['succeeded','failed','stopped']),shellSessions:new Map()};
 const lookup=vm.runInNewContext(functionBlock(setupSource,'workDataSetupReceiptOwner')+'\nworkDataSetupReceiptOwner',context),receiptPath=vm.runInNewContext(functionBlock(setupSource,'workDataSetupReceiptPath')+'\nworkDataSetupReceiptPath',context);
 f.host.receiptPath=receiptPath;f.host.receiptOwner=lookup;f.owners.add(live);const api=Setup.create(f.host),lease=f.m.begin();let decisions=0;
 for(const action of ['pool_approve','pool_reject'])await api.runHttp(request({sessionId:'sess_one',action,poolId:'pool_one'}),'/api/agent-runs/run_one',async()=>{assert.equal(f.m.active(),true);decisions++;});
 for(const action of ['approve','reject'])await api.runHttp(request({action}),'/api/missions/sess_one/interventions/pool_one/decision',async()=>{assert.equal(f.m.active(),true);decisions++;});
 assert.equal(decisions,4);assert.equal(live.run.taskPool.length,1);assert.equal(live.run.taskPool[0],item);
 for(const body of [{sessionId:'sess_other',action:'pool_reject',poolId:'pool_one'},{sessionId:'sess_one',action:'pool_reject',poolId:'unknown'},{sessionId:'sess_one',action:'retry_node',poolId:'pool_one'}])await assert.rejects(api.runHttp(request(body),'/api/agent-runs/run_one',()=>assert.fail()),/receipt_owner_unavailable/);
 live.closing=true;assert.equal(lookup('/api/agent-runs/run_one',{sessionId:'sess_one',action:'pool_reject',poolId:'pool_one'}),null);live.closing=false;
 item.status='rejected';assert.equal(lookup('/api/missions/sess_one/interventions/pool_one/decision',{action:'reject'}),null);item.status='proposed';runs.delete('run_one');assert.equal(lookup('/api/missions/sess_one/interventions/pool_one/decision',{action:'approve'}),null);lease.resume();
});

test('upload broker refusals keep their own code as the client-visible apiCode',async t=>{
 const f=fixture(),{broker}=await bindRestoreUpload(f,t);
 await assert.rejects(broker.put(Buffer.from([0xff,0xfe,0xfd])),error=>error.code==='work_data_upload.sealed_required'&&error.apiCode==='work_data_upload.sealed_required'&&error.statusCode===409&&error.retry===false);
 await assert.rejects(broker.resolveUpload('a'.repeat(48),{jobId:'c'.repeat(48)}),error=>error.code==='work_data_upload.grant_unavailable'&&error.apiCode===error.code);
 await assert.rejects(broker.put(Buffer.alloc(0)),error=>error.code==='work_data_upload.capacity'&&error.apiCode===error.code);
});

test('status keeps the three capability keys, follows real readiness and never advertises a download',async()=>{
 const f=fixture();f.worker.download=async()=>assert.fail('no download endpoint may exist');
 const first=await f.api.status();
 assert.deepEqual(Object.keys(first.capabilities).sort(),['download','upload','worker']);
 assert.equal(first.capabilities.download,false,'a worker download method must not become a capability');
 assert.equal(first.capabilities.worker,true);
 let ready=false;f.host.workerReady=()=>ready;
 assert.equal((await f.api.status()).capabilities.worker,false,'readiness loss must retract the worker capability');
 ready=true;assert.equal((await f.api.status()).capabilities.worker,true);
 f.host.workerReady=()=>{throw Error('private readiness reader');};
 assert.equal((await f.api.status()).capabilities.worker,false,'an unreadable readiness state must fail closed');
});
test('closed restore refuses before any grant, drain, queue entry or worker start',async t=>{
 const f=fixture();await bindRestoreUpload(f,t);let grants=0,validated=0;
 const resolve=f.worker.resolveUpload;f.worker.resolveUpload=async(id,options)=>{grants++;return resolve(id,options);};
 const validate=f.host.validateDirectories;f.host.validateDirectories=async value=>{validated++;return validate(value);};
 await assert.rejects(()=>f.api.submit(f.body({operation:'restore',targetDirectory:'C:/synthetic/target',uploadId:'b'.repeat(48)})),
   error=>error.statusCode===501&&error.code==='work_data_setup.restore_unavailable'&&error.apiCode===error.code&&error.retry===false);
 assert.equal(grants,0,'no upload grant may be resolved for a closed restore');
 assert.equal(validated,0);assert.equal(f.queue.length,0);assert.equal(f.events.includes('pause'),false);assert.equal(f.events.includes('start'),false);
 assert.equal(f.m.accepting(),true);assert.equal((await f.api.status()).job,null);
 await assert.rejects(()=>f.api.submit(f.body({operation:'restore',targetDirectory:'',uploadId:'b'.repeat(48)})),
   error=>error.statusCode===400&&error.code==='work_data_setup.restore_input_invalid');
 await assert.rejects(()=>f.api.submit(f.body({operation:'restore',targetDirectory:'C:/synthetic/target',uploadId:'bad'})),
   error=>error.statusCode===400&&error.code==='work_data_setup.restore_input_invalid');
 assert.equal(grants,0);
});
