'use strict';
// ROOT SERIAL synthetic acceptance for the production maintenance loop.
//
// Real normal serve is launched as-is; the real cold worker is spawned by that
// serve, performs actual DPAPI/NTFS work on a synthetic root, then starts a real
// successor on the same root and port. Nothing here models the four processes:
// the simulated fixture (lib/work-data-maintenance-runtime-process-fixture.cjs)
// stays transport-only evidence and is never imported by this file.
//
// The only observation channels are product-published facts: the ChildProcess
// close event, runtime.json's pid/token, claim-v1.json through the real 13av
// API, the cold worker's read-only HTTP, and CIM <pid,creation> identities.
// No sleep is used as a wait, and no PID is ever guessed or scanned for.
//
// Scope and lifetime of the one owned Job (lib/work-data-production-maintenance-outer-job.ps1):
// the boot verdicts run first because they are independent of any handoff, then
// the three handoff rounds, then the last successor is the only process handed to
// the Job. A Job around old serve would make the product's detached cold launch
// un-detachable on this host (measured: the cold worker dies the moment serve
// exits), so the test never puts serve in a Job. A failure keeps the fixture, the
// cold worker and its successor; nothing here kills a product process.
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),vm=require('node:vm'),cp=require('node:child_process'),c=require('node:crypto'),a=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),{createProcesses,createStrictStop}=require('./lib/work-data-production-upload-process');
const upload=require('./work-data-production-upload.e2e');
const {releaseEnvironment}=require('./lib/release-checks'),{snapshotProcessTable,ownDescendants}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const PASSWORD='SYNTHETIC production maintenance only 2026',SESSION_ID='sess_maintenance_synthetic';
const SESSION_BYTES=JSON.stringify({id:SESSION_ID,private:'完整合成维护源，保持原字节。',title:'Synthetic maintenance session',messages:[]});
// Waits are event- or product-fact-anchored; these are deadlines, not latencies.
const BUDGET=Object.freeze({...upload.BUDGET,handoff:45000,claim:30000,coldPort:30000,coldOperation:180000,successor:90000,jobRelease:60000});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const AUTHORITY0=Object.freeze({generation:0,id:null,mode:'plain',sha256:null});
const TRANSPORT=new Set(['ECONNREFUSED','ECONNRESET','EPIPE','EHOSTUNREACH','ENOTFOUND','EAI_AGAIN']);
function isTransport(error){return TRANSPORT.has(error?.code)||/test HTTP observation deadline|socket hang up|test response aborted|test response closed before end/i.test(String(error?.message||''));}
function safeFailureLocation(error){
 let name='UnknownError',stack='';try{if(['Error','AssertionError','TypeError','RangeError'].includes(error?.name))name=error.name;}catch{}try{if(typeof error?.stack==='string')stack=error.stack;}catch{}
 const frame=stack.split(/\r?\n/).filter(line=>/^\s*at /.test(line)).map(line=>/work-data-production-maintenance\.e2e\.js:(\d+):(\d+)\)?$/.exec(line)).find(Boolean);
 return {errorName:name,failureLocation:frame?{file:'work-data-production-maintenance.e2e.js',line:Number(frame[1]),column:Number(frame[2])}:null};
}
const targetFromArgs=argv=>{a.equal(argv.length,0,'permanent E2E uses the current complete product build');return core.loadProductTarget(__dirname);};
function run(command,args,options){return new Promise((resolve,reject)=>{let child;try{child=cp.spawn(command,args,options);}catch(error){reject(error);return;}child.once('error',reject);child.once('close',code=>resolve({code,child}));});}

function readJsonLoose(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
// Same-port classifier. cold = the maintenance-only listener; warm = a normal
// serve (fresh or successor). Anything else is not claimed as either.
async function probePort(port,timeout=1500){
 let health;
 try{health=await upload.makeHttp({port,token:''},'/health',undefined,{auth:false,timeout});}
 catch(error){if(isTransport(error))return{kind:'none',port};return{kind:'error',port,code:String(error?.code||error?.message||'error')};}
 if(health.status!==200||health.value?.ok!==true)return{kind:'other',port,status:health.status};
 if(health.value.maintenance===true)return{kind:'cold',port,health:health.value};
 if(typeof health.value.app==='string'||typeof health.value.launchMode==='string')return{kind:'warm',port,health:health.value};
 return{kind:'other',port,status:health.status};
}

// Everything stateful for one run. No product module is stubbed: 13av and 01g are
// the actual sources, evaluated read-only with only their own declared imports.
function createWorld({root,evidence,target}){
 const ctx={unknown:false,failure:null,failureSet:false,checks:[],phase:'initialization',root,evidence};
 const latch=error=>{ctx.unknown=true;if(!ctx.failureSet){ctx.failureSet=true;ctx.failure=error;}};
 function healthy(){if(ctx.unknown)throw Error('unknown forbids new test work');}
 function rawWrite(fd,bytes){let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(n<1)throw Error('test evidence short write');offset+=n;}}
 let journalFD=null;
 function record(row){try{a.ok(!ctx.unknown,'test observation already failed');rawWrite(journalFD,Buffer.from(JSON.stringify({...row,at:new Date().toISOString()})+'\n'));fs.fsyncSync(journalFD);}catch(error){latch(error);throw error;}}
 function checkpoint(name,value){try{a.match(name,/^[a-z0-9-]+$/);const file=p.join(evidence,name+'.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx',0o600);try{rawWrite(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const captured=core.read(file);a.equal(captured.row.sha256,core.H(bytes));record({kind:'checkpoint',name,...captured.row});return captured.row;}catch(error){latch(error);throw error;}}
 function checked(label){a.equal(ctx.unknown,false,'unknown forbids new test success');ctx.checks.push(label);record({kind:'assertion-pass',label});}
 function openJournal(){journalFD=fs.openSync(p.join(evidence,'events.jsonl'),'wx',0o600);}

 const pure=(file,symbol)=>upload.loadPure(core.read(p.join(target.src,file)).bytes.toString('utf8'),symbol);
 let claimSource=null,ownershipSource=null;
 function claimApi(temp){
  if(!claimSource)claimSource=pure('13av-work-data-handoff-claim.js','WorkDataHandoffClaim');
  // flush is a test seam for precondition records only; this E2E never calls
  // write() on the live path, it only inspects what the product wrote.
  return claimSource.create({temp,flush:async()=>{}});
 }
 function ownership(){
  if(!ownershipSource)ownershipSource=pure('01g-server-ownership.js','ServerOwnership');
  return ownershipSource;
 }

 // CIM is the only process-identity source. <pid,creation> is the identity; a
 // recycled PID has a different creation time and therefore is not the same row.
 // The product's own canonical root (realpath plus the Windows lowercase fold)
 // is the only base string a claim record may be compared against.
 const canonicalBase=async f=>ownership().canonicalRoot(f.base);
 async function cimIdentity(pid,budget=15000){
  const deadline=Date.now()+budget;
  for(;;){
   const table=snapshotProcessTable();
   if(!Array.isArray(table)){latch(Error('actual CIM snapshot unavailable'));throw Error('actual CIM snapshot unavailable');}
   const row=table.find(entry=>entry.pid===pid);
   if(row)return{pid:row.pid,ppid:row.ppid,created:String(row.created),name:row.name};
   if(Date.now()>=deadline)throw Error('owned process creation identity unavailable');
   await sleep(25);
  }
 }
 async function absentByCim(identity,budget=20000){
  const deadline=Date.now()+budget;
  for(;;){
   const table=snapshotProcessTable();
   if(!Array.isArray(table)){latch(Error('actual CIM snapshot unavailable'));throw Error('actual CIM snapshot unavailable');}
   const row=table.find(entry=>entry.pid===identity.pid);
   if(!row||String(row.created)!==String(identity.created))return true;
   if(Date.now()>=deadline)return false;
   await sleep(50);
  }
 }

 const outputFD=new Map();
 function openOutput(label){for(const kind of ['stdout','stderr'])outputFD.set(label+':'+kind,fs.openSync(p.join(evidence,label+'-'+kind+'.log'),'wx',0o600));}
 const manager=createProcesses({record,writeOutput(label,kind,bytes){try{rawWrite(outputFD.get(label+':'+kind),bytes);}catch(error){latch(error);throw error;}},latch,isUnknown:()=>ctx.unknown,
  beforeStart(){healthy();try{target.recheck();}catch(error){latch(error);throw error;}healthy();},
  killOwnTree:createStrictStop({snapshotProcessTable,ownDescendants,latch,isUnknown:()=>ctx.unknown}),snapshotProcessTable,ownDescendants});
 function spawnServe(f,label,port){
  healthy();openOutput(label);
  // detached deliberately: libuv gives a non-detached child its own kill-on-close
  // Job. The cold worker is spawned detached by the product, so it would inherit
  // that inner Job and be killed the moment old serve exits - a topology the real
  // desktop never has (its outer lifetime owner outlives serve). Detached here
  // means the only Job is the owned outer one this test explicitly manages.
  return manager.start(process.execPath,[target.server,'serve','--host','127.0.0.1','--port',String(port)],{cwd:p.dirname(target.server),env:f.env,windowsHide:true,detached:true,stdio:['ignore','pipe','pipe']},label);
 }
 const config=workspace=>({configSchema:14,locale:'en-US',workDataEncryptionV1:false,permissionMode:'ask',stewardEnabledV1:false,schedulerEnabledV1:false,autoImportClaudeCodeMcp:false,importAgentInstructions:false,includeWorkbenchMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[],providers:[],defaultWorkspace:workspace});
 function fixture(label){
  healthy();const base=p.join(root,label+'-data'),home=p.join(root,label+'-home'),backups=p.join(root,label+'-backups'),env=releaseEnvironment(home,base);
  fs.mkdirSync(base);fs.mkdirSync(p.join(base,'sessions'));fs.mkdirSync(backups);
  fs.writeFileSync(p.join(base,'config.json'),JSON.stringify(config(root)),{flag:'wx'});
  fs.writeFileSync(p.join(base,'sessions',SESSION_ID+'.json'),SESSION_BYTES,{flag:'wx'});
  return{label,base,home,backups,env,temp:p.resolve(env.TEMP)};
 }
 async function readyWarm(handle,f){
  healthy();const deadline=Date.now()+BUDGET.startup;
  while(Date.now()<deadline){
   if(ctx.unknown)throw Error('unknown during ready');
   a.equal(manager.inspect(handle).closeSeen,false,'normal serve exited before ready');
   let rt=null;try{rt=core.json(p.join(f.base,'runtime.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(rt?.pid===manager.pid(handle)){
    a.equal(rt.host,'127.0.0.1');a.ok(Number.isInteger(rt.port)&&rt.port>0&&rt.port<=65535);
    a.equal(typeof rt.token==='string'&&/^[a-f0-9]{32}$/.test(rt.token),true,'runtime token format');
    const health=await upload.makeHttp({port:rt.port,token:rt.token},'/health',undefined,{auth:false,timeout:Math.max(1,Math.min(BUDGET.request,deadline-Date.now()))});
    if(health.status===200&&health.value?.ok===true){
     const identity=await cimIdentity(rt.pid);
     a.equal(identity.created.length>0,true);
     return{pid:rt.pid,port:rt.port,token:rt.token,handle,identity};
    }
   }
   await sleep(50);
  }
  throw Error('complete normal serve startup observation deadline');
 }
 async function statusOf(ref){
  healthy();
  for(;;){
   const response=await upload.makeHttp({port:ref.port,token:ref.token},'/api/work-data/status',undefined,{guard:healthy,timeout:BUDGET.request});
   if(response.status!==200)throw Object.assign(Error('status unavailable'),{code:'STATUS_'+response.status});
   healthy();return response.value;
  }
 }
 async function waitWorkerReady(ref){
  const deadline=Date.now()+BUDGET.startup;
  for(;;){
   const value=await statusOf(ref);
   if(value.capabilities?.worker===true)return value;
   if(Date.now()>=deadline)throw Error('worker capability never became ready');
   await sleep(50);
  }
 }
 async function submitJob(ref,body){
  healthy();const bytes=Buffer.from(JSON.stringify(body));
  try{
   const response=await upload.makeHttp({port:ref.port,token:ref.token},'/api/work-data/jobs',bytes,{method:'POST',headers:{'content-type':'application/json'},guard:healthy,timeout:BUDGET.request});
   record({kind:'job-response',status:response.status,code:response.value?.error?.code||null,id:response.value?.job?.id||null});
   a.equal(response.status,202,'job accepted');
   a.equal(response.value?.ok,true);
   a.match(response.value.job.id,/^[a-f0-9]{48}$/);
   return response.value.job.id;
  }finally{bytes.fill(0);}
 }
 async function claimObserver(f){
  const api=claimApi(f.temp),base=await canonicalBase(f),samples=[];let stopped=false;
  const done=(async()=>{
   while(!stopped){
    let row;
    try{const found=await api.inspect({base});row=found.present?{present:true,id:found.value.id,phase:found.value.phase,childPid:found.value.childPid,parentPid:found.value.parentPid,sha256:found.receipt.sha256,dev:found.receipt.dev,ino:found.receipt.ino}:{present:false};}
    catch(error){row={error:String(error?.code||error?.message||'inspect_failed')};}
    const key=row.present?row.id+':'+row.phase+':'+row.sha256:(row.error?'E:'+row.error:'absent');
    const last=samples.at(-1);
    if(!last||last.key!==key)samples.push({key,at:Date.now(),...row});
    await sleep(15);
   }
  })();
  return{samples,stop:async()=>{stopped=true;await done;}};
 }
 async function waitClaim(observer,{id,phase,budget=BUDGET.claim}){
  const deadline=Date.now()+budget;
  for(;;){
   const row=observer.samples.find(sample=>sample.present===true&&sample.id===id&&sample.phase===phase);
   if(row)return row;
   if(Date.now()>=deadline)throw Error('claim phase '+phase+' never observed');
   await sleep(15);
  }
 }

 // Read-only cold window: proves the maintenance listener refuses every write,
 // holds the real OS source owner, and exposes only status for this job.
 async function coldBatch(port,{base,jobId,source,staleToken}){
  const bare={port,token:''};
  try{
   const boot=await upload.makeHttp(bare,'/api/bootstrap',undefined,{method:'POST',auth:false,timeout:2500});
   a.equal(boot.status,200);
   a.match(boot.value?.token,/^[a-f0-9]{64}$/,'cold token is a fresh 32-byte secret');
   const record_={port,token:boot.value.token};
   const st=await upload.makeHttp(record_,'/api/work-data/status',undefined,{timeout:2500});
   a.equal(st.status,200);
   a.deepEqual(st.value.capabilities,{worker:false,upload:false,download:false},'cold listener advertises no transfer or worker');
   a.equal(st.value.lastResult,null);
   a.equal(st.value.job?.id,jobId);
   a.ok(['handoff','uncertain','failed'].includes(st.value.job?.state),'cold job state is a live handoff verdict');
   a.deepEqual(st.value.authority,source);
   const none=await upload.makeHttp(bare,'/api/work-data/status',undefined,{auth:false,timeout:2500});
   a.equal(none.status,403);a.equal(none.value?.error?.code,'auth.token_invalid');
   const post=await upload.makeHttp(record_,'/api/work-data/status',undefined,{method:'POST',timeout:2500});
   a.equal(post.status,409);a.equal(post.value?.error?.code,'work_data_setup.takeover_committed');
   // The body gate is decided before the method gate, so the two refusals need
   // separate requests: POST without a body is a write attempt, GET with a body
   // is a body attempt.
   const body=await upload.makeHttp(record_,'/api/work-data/status',Buffer.from('abc'),{method:'GET',timeout:2500});
   a.equal(body.status,413);a.equal(body.value?.error?.code,'work_data_setup.body_not_allowed');
   const stale=await upload.makeHttp({port,token:staleToken},'/api/work-data/status',undefined,{timeout:2500});
   a.equal(stale.status,403,'the retired warm token never authorizes the cold listener');
   let lease=null,refused=false;
   try{lease=await ownership().acquire([base]);}catch(error){refused=/DATA_ROOT_IN_USE/.test(String(error?.code||''))||/DATA_ROOT_IN_USE/.test(String(error?.message||''));if(!refused)throw error;}
   if(lease){try{await lease.release();}catch{/* the unexpected lease is reported below */}
    a.equal(false,true,'cold worker must hold the OS source owner');}
   a.equal(refused,true,'cold worker holds the real source owner');
   return{token:boot.value.token,job:st.value.job,authority:st.value.authority};
  }catch(error){if(isTransport(error))return null;throw error;}
 }
 async function coldWindow(port,options){
  const deadline=Date.now()+BUDGET.coldPort;let attempts=0;
  while(Date.now()<deadline){
   attempts++;
   const probe=await probePort(port);
   if(probe.kind==='cold'){
    const value=await coldBatch(port,options);
    if(value){
     record({kind:'cold-window-observed',attempts,port,jobState:value.job.state,error:value.job.error||null});
     // A failed/uncertain cold job never produces a successor; name the product
     // code here instead of waiting out the successor deadline.
     if(value.job.state!=='handoff')throw Error('cold job reported '+value.job.state+' ('+(value.job.error||'no-code')+') instead of handoff');
     return value;
    }
   }else if(probe.kind==='warm'){
    throw Error('COLD_WINDOW_MISSED: the same port already serves warm again');
   }
   await sleep(15);
  }
  throw Error('COLD_WINDOW_MISSED: no read-only maintenance listener observed within budget');
 }
 async function waitOldServeExit(ref,observer,{jobId,budget=BUDGET.handoff}){
  // The ChildProcess close event is the only exit fact; the CIM pair is the only
  // identity proof. Neither is a timeout that "usually" works.
  const gone=async()=>a.equal(await absentByCim(ref.identity,budget),true,'old serve creation identity is absent');
  if(ref.handle){
   const terminal=await manager.waitClose(ref.handle,budget);
   healthy();
   a.equal(terminal.code,0,'old serve exits only after the acknowledged handoff');
   a.equal(terminal.signal,null);
   await manager.certifyNaturalExit(ref.handle,{code:0,signal:null,verify:gone});
  }else{
   await gone();
  }
  const committedTime=observer.samples.find(sample=>sample.present===true&&sample.id===jobId&&sample.phase==='committed')?.at??null;
  return{closedAt:Date.now(),committedSeen:committedTime!==null};
 }
 // Test-side liveness of a product-published PID (the claim's childPid). Presence
 // and absence are recorded with the CIM creation identity; nothing is killed.
 function watchPid(pid){
  // A cheap existence probe only. CIM is reserved for identity at the few points
  // that need it; a synchronous PowerShell sample every tick would block the
  // event loop and could hide the very cold window this run must observe.
  const samples=[];let stopped=false,last=null;
  const done=(async()=>{
   while(!stopped){
    let key;
    try{process.kill(pid,0);key='present';}catch(error){key=error?.code==='EPERM'?'present':'absent';}
    if(key!==last){last=key;samples.push({key,at:Date.now(),pid});}
    await sleep(20);
   }
  })();
  return{samples,stop:async()=>{stopped=true;await done;}};
 }
 async function waitSuccessor(ref,f,jobId,{notPids}){
  const deadline=Date.now()+BUDGET.successor;
  for(;;){
   const rt=readJsonLoose(p.join(f.base,'runtime.json'));
   if(rt&&Number.isInteger(rt.pid)&&rt.pid!==ref.pid&&!notPids.includes(rt.pid)&&rt.port===ref.port&&rt.token!==ref.token){
    const probe=await probePort(ref.port);
    if(probe.kind==='warm'){
     let st=null;
     try{st=await upload.makeHttp({port:rt.port,token:rt.token},'/api/work-data/status',undefined,{timeout:5000});}catch(error){if(!isTransport(error))throw error;}
     if(st&&st.status===200&&st.value?.capabilities?.worker===true&&st.value.lastResult?.id===jobId){
      const identity=await cimIdentity(rt.pid);
      a.notEqual(rt.pid,ref.pid,'successor is a new process');
      a.notEqual(rt.token,ref.token,'successor publishes a new runtime token');
      a.equal(rt.host,'127.0.0.1');
      return{pid:rt.pid,port:rt.port,token:rt.token,handle:null,identity,status:st.value};
     }
    }
   }
   if(Date.now()>=deadline){
    // A cold worker that never hands over keeps its read-only listener and its
    // own verdict. Read it here so the first red names the product code instead
    // of only reporting a successor deadline.
    const held=await readColdVerdict(ref.port);
    if(held)throw Error('successor readiness deadline; cold job state='+held.job?.state+' phase='+held.job?.phase+' error='+held.job?.error);
    throw Error('successor readiness deadline; no cold verdict available on the same port');
   }
   await sleep(50);
  }
 }
 // Read-only: the cold listener's bootstrap token is its own, and this never
 // writes anything. Used only to explain a missed successor.
 async function readColdVerdict(port){
  try{
   const boot=await upload.makeHttp({port,token:''},'/api/bootstrap',undefined,{method:'POST',auth:false,timeout:2500});
   if(boot.status!==200||typeof boot.value?.token!=='string')return null;
   const st=await upload.makeHttp({port,token:boot.value.token},'/api/work-data/status',undefined,{timeout:2500});
   if(st.status!==200)return null;
   const value={job:st.value?.job??null,authority:st.value?.authority??null};
   record({kind:'cold-verdict',...value});
   ctx.diagnostics={...(ctx.diagnostics||{}),coldVerdict:value};
   return value;
  }catch{return null;}
 }

 function assertCapabilities(value){
  a.deepEqual(value.capabilities,{worker:true,upload:true,download:false},'only the real worker and upload are advertised');
  a.equal(Object.hasOwn(value.capabilities,'crashClaim'),false);
  a.equal(Object.hasOwn(value.capabilities,'activation'),false);
  a.equal(value.processRestartRequired,true);
 }
 function assertResult(f,st,{id,operation,state,source}){
  const saved=st.lastResult;
  a.ok(saved,'status must carry the durable maintenance result');
  a.equal(saved.schema,1);
  a.equal(saved.id,id);
  a.equal(saved.operation,operation);
  a.equal(saved.state,state);
  a.deepEqual(saved.sourceAuthority,source);
  a.deepEqual(saved.authority,st.authority);
  const expectedGeneration=operation==='export'?source.generation:source.generation+1;
  a.equal(saved.authority.generation,expectedGeneration);
  a.equal(saved.authority.mode,operation==='enable'?'encrypted':operation==='disable'?'plain':source.mode);
  a.match(saved.authority.id,/^[a-f0-9]{48}$/);
  a.match(saved.authority.sha256,/^[a-f0-9]{64}$/);
  const expectedBackup=p.join(f.backups,'ruyi-work-data-'+id+'.ruyi-backup');
  a.equal(saved.backup.path,expectedBackup);
  const payload=core.read(saved.backup.path);
  a.equal(payload.row.sha256,saved.backup.sha256,'backup hash is the real file hash');
  a.equal(payload.row.bytes,saved.backup.bytes);
  a.equal(payload.row.dev,saved.backup.identity.dev);
  a.equal(payload.row.ino,saved.backup.identity.ino);
  const resultFile=core.read(p.join(f.base,'.work-data','maintenance-result-v1.json'));
  const parsed=JSON.parse(resultFile.bytes);
  const {proof,...body}=saved;
  a.deepEqual(body,parsed,'durable result record equals the served lastResult minus its proof');
  a.equal(proof.sha256,resultFile.row.sha256);
  a.equal(proof.identity.dev,resultFile.row.dev);
  a.equal(proof.identity.ino,resultFile.row.ino);
  return saved;
 }
 function assertActive(f,st){
  const active=core.json(p.join(f.base,'.work-data','active-v1.json'));
  a.equal(active.schema,1);
  a.equal(active.generation,st.authority.generation);
  a.equal(active.id,st.authority.id);
  a.equal(active.mode,st.authority.mode);
  a.equal(active.activeRoot,'generations/'+active.id);
 }
 async function assertNoPendingIntent(f){
  const control=p.join(f.base,'.work-data');
  a.equal(fs.existsSync(p.join(control,'maintenance-v1.json')),false,'no pending intent survives a completed operation');
  const names=fs.readdirSync(control).sort();
  a.deepEqual(names.filter(name=>/^\.maintenance-v1\.stage-|^\.maintenance-result-v1\.stage-/.test(name)),[],'no staged control file survives');
  const allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
  for(const name of names)a.equal(allowed.has(name),true,'unexpected control entry '+name);
  const found=await claimApi(f.temp).inspect({base:await canonicalBase(f)});
  a.equal(found.present,false,'no handoff claim survives a completed operation');
 }
 function assertCustody(f,count){
  const names=fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-upload-'));
  a.equal(names.length,count,'one fresh custody root per normal serve start');
  for(const name of names)a.deepEqual(fs.readdirSync(p.join(f.temp,name)),['restore-upload-owner.json'],'custody holds only the broker owner marker without an admitted upload');
 }
 function sessionIntact(f,before){
  const now=core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).row;
  core.samePinned({...now,file:before.file},before);
 }
 async function runRound(f,ref,spec,state){
  const before=await statusOf(ref);
  assertCapabilities(before);
  a.equal(before.job,null);
  const source=before.authority;
  if(state.round===0)a.deepEqual(source,AUTHORITY0,'first authority is the plain generation zero');
  const sessionBefore=core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).row;
  const observer=await claimObserver(f);
  try{
   ctx.phase='submit-'+spec.operation;
   const jobId=await submitJob(ref,{operation:spec.operation,password:PASSWORD,expectedAuthority:source,backupDirectory:f.backups,...(spec.operation==='disable'?{confirmPlaintext:true}:{})});
   record({kind:'round-start',round:state.round,operation:spec.operation,jobId,sourceAuthority:source});
   const armed=await waitClaim(observer,{id:jobId,phase:'armed'});
   record({kind:'claim-armed',jobId,sha256:armed.sha256,childPid:armed.childPid});
   const coldChild=watchPid(armed.childPid);
   ctx.diagnostics={jobId,operation:spec.operation,claim:observer.samples,cold:coldChild.samples,armedAt:armed.at};
   try{
   ctx.phase='old-serve-exit-'+spec.operation;
   await waitOldServeExit(ref,observer,{jobId});
   const custodyBefore=fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-upload-')).length;
   ctx.phase='cold-window-'+spec.operation;
   const observed=await coldWindow(ref.port,{base:f.base,jobId,source,staleToken:ref.token});
   record({kind:'cold-status',jobId,authority:observed.authority,jobState:observed.job.state});
   ctx.phase='successor-'+spec.operation;
   const next=await waitSuccessor(ref,f,jobId,{notPids:[ref.pid,armed.childPid].filter(Number.isSafeInteger)});
   const owned=observer.samples.find(sample=>sample.present===true&&sample.id===jobId&&sample.phase==='owned');
   a.ok(owned,'the cold worker records ownership before touching the base');
   const committed=observer.samples.find(sample=>sample.present===true&&sample.id===jobId&&sample.phase==='committed');
   record({kind:'claim-timeline',jobId,armedAt:armed.at,committedAt:committed?.at??null,ownedAt:owned.at,successorAt:Date.now()});
   ctx.phase='verify-'+spec.operation;
   assertCapabilities(next.status);
   a.equal(next.status.job,null,'a new process never inherits the previous job');
   const saved=assertResult(f,next.status,{id:jobId,operation:spec.operation,state:spec.operation==='export'?'verified':'published',source});
   assertActive(f,next.status);
   await assertNoPendingIntent(f);
   assertCustody(f,custodyBefore+1);
   sessionIntact(f,sessionBefore);
   const configMirror=next.status.configMirror;
   a.equal(typeof configMirror,'boolean');
   a.equal(next.status.authority.mode==='encrypted',configMirror,'config mirror follows the published mode');
   const stale=await upload.makeHttp({port:next.port,token:ref.token},'/api/work-data/status',undefined,{timeout:BUDGET.request}).catch(error=>isTransport(error)?null:Promise.reject(error));
   if(stale)a.equal(stale.status,403,'the retired process token no longer authorizes');
   const jobLookup=await upload.makeHttp({port:next.port,token:next.token},'/api/work-data/jobs/'+jobId,undefined,{timeout:BUDGET.request});
   a.equal(jobLookup.status,404,'the successor did not inherit warm job state');
   a.equal(jobLookup.value?.error?.code,'work_data_setup.job_not_found');
   record({kind:'round-verified',round:state.round,operation:spec.operation,jobId,authority:next.status.authority,backup:saved.backup,state:saved.state});
   checked('round '+state.round+' '+spec.operation+' reached the same-root same-port successor with durable lastResult');
   return next;
   }finally{await coldChild.stop();}
  }finally{await observer.stop();}
 }

 function deadPid(){const result=cp.spawnSync(process.execPath,['-e',''],{stdio:'ignore',windowsHide:true});a.ok(Number.isSafeInteger(result.pid)&&result.pid>0,'a real exited PID for the precondition');return result.pid;}
 // Precondition records are written by the real 13av owner, phase by phase, with
 // the real base identity. Only the directory-flush seam is a test no-op here;
 // the product's own boot still decides every verdict from these files.
 async function writeClaim(f,{id,parentPid,childPid,phases}){
  const api=claimApi(f.temp),base=await canonicalBase(f),stat=fs.lstatSync(f.base,{bigint:true});
  const baseIdentity={dev:String(stat.dev),ino:String(stat.ino)};
  const createdAt=new Date().toISOString(),nonce=c.randomBytes(32).toString('hex');
  const value=phase=>({schema:1,base,baseIdentity,id,nonce,
   parentPid,childPid,operation:'enable',serve:{host:'127.0.0.1',port:39001},phase,createdAt,
   updatedAt:new Date(Date.parse(createdAt)+1000*phases.indexOf(phase)).toISOString()});
  let receipt=null;
  for(const phase of phases){receipt=await api.write(value(phase),receipt);}
  return{receipt,record:await api.inspect({base})};
 }
 function intentRecord(f,{id,backupFile,bytes}){
  return{schema:1,id,operation:'enable',phase:'complete',createdAt:new Date().toISOString(),
   expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},
   backup:{path:backupFile,sha256:core.H(bytes)},
   candidate:{id:'d'.repeat(48),mode:'encrypted',headerSha256:'e'.repeat(64)}};
 }
 function resultRecord({id,backupFile,bytes}){
  const stat=fs.lstatSync(backupFile,{bigint:true});
  const authority={generation:0,id:null,mode:'plain',sha256:null};
  return{schema:1,id,operation:'export',state:'verified',finishedAt:new Date().toISOString(),
   sourceAuthority:{...authority},authority:{...authority},
   backup:{path:backupFile,sha256:core.H(bytes),bytes:bytes.length,identity:{dev:String(stat.dev),ino:String(stat.ino)}}};
 }
 function stderrOf(label){try{return fs.readFileSync(p.join(evidence,label+'-stderr.log'),'utf8');}catch{return '';}}
 async function bootScenario(f,label,{refuse,expectedCode,verify}={}){
  ctx.phase='boot-'+label;
  const port=await getFreePort('127.0.0.1');
  const handle=spawnServe(f,label+'-server',port);
  await handle.spawned;healthy();
  if(refuse){
   const terminal=await manager.waitClose(handle,BUDGET.handoff);healthy();
   a.equal(terminal.code,1,label+' refuses with exit 1');
   a.equal(terminal.signal,null);
   await manager.certifyExpectedRefusal(handle,async()=>{if(verify)await verify();});
   if(expectedCode)a.ok(stderrOf(label+'-server').includes(expectedCode),label+' refusal names '+expectedCode);
   a.equal(fs.existsSync(p.join(f.base,'last-start-error.json')),false,label+' refusal never writes a startup error');
   const custody=fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-upload-'));
   a.equal(custody.length,1,label+' allocates exactly one custody root before refusing');
   a.deepEqual(fs.readdirSync(p.join(f.temp,custody[0])),[],label+' custody stays empty');
   record({kind:'boot-refusal',label,expectedCode,port});
   return null;
  }
  const ref=await readyWarm(handle,f);
  await manager.captureNativeBirths(handle);
  if(verify)await verify(ref);
  await manager.cleanupKnown(handle,async()=>{healthy();});
  return ref;
 }

 // Boot verdicts that only a real serve can make. Each precondition is either a
 // record written by the real 13av owner or the documented control file, and the
 // refusal must leave every byte and every native identity untouched.
 async function runBootNegatives(){
  const sleeper=async(label)=>{
   const handle=manager.start(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']},label);
   await handle.spawned;healthy();
   const identity=await cimIdentity(manager.pid(handle));
   await manager.captureNativeBirths(handle);
   return{handle,identity};
  };
  {
   const f=fixture('claim-armed'),child=await sleeper('armed-child'),before=core.inventory(f.base);
   const sessionBefore=core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).row;
   const configBefore=core.json(p.join(f.base,'config.json'));
   await writeClaim(f,{id:'1'.repeat(48),parentPid:deadPid(),childPid:child.identity.pid,phases:['armed']});
   await bootScenario(f,'claim-armed',{refuse:false,verify:async()=>{
    const found=await claimApi(f.temp).inspect({base:await canonicalBase(f)});
    a.equal(found.present,false,'an armed record with a dead parent is inert and cleared by boot');
    a.equal(await absentByCim(child.identity,1000),false,'boot never kills the unrelated live child');
    const after=core.inventory(f.base);
    // A normal boot rewrites config.json (schema/version bracketing) and adds the
    // usual startup artefacts; it may never remove or rewrite user content.
    for(const row of before.files){
     const now=after.files.find(entry=>core.norm(entry.file)===core.norm(row.file));
     a.ok(now,'boot never removes a pre-existing file '+row.file);
     if(core.norm(row.file)===core.norm(p.join(f.base,'config.json')))continue;
     core.samePinned(now,row);
    }
    sessionIntact(f,sessionBefore);
    const configAfter=core.json(p.join(f.base,'config.json'));
    a.equal(configAfter.workDataEncryptionV1===true,configBefore.workDataEncryptionV1===true,'the inert claim never changes the effective encryption mode');
    a.equal(configAfter.defaultWorkspace,configBefore.defaultWorkspace);
   }});
   await manager.cleanupKnown(child.handle,async()=>{healthy();});
   checked('go-before-parent-death: armed claim is inert, cleared, and no unrelated child is killed');
  }
  {
   const f=fixture('claim-committed'),child=await sleeper('committed-child');
   const before=await writeClaim(f,{id:'2'.repeat(48),parentPid:deadPid(),childPid:child.identity.pid,phases:['armed','committed']});
   const rootBefore=core.inventory(f.base,{directoryMetadata:true});
   await bootScenario(f,'claim-committed',{refuse:true,expectedCode:'work_data_setup.handoff_pending',verify:async()=>{
    const after=await claimApi(f.temp).inspect({base:await canonicalBase(f)});
    a.equal(after.present,true);a.equal(after.value.phase,'committed');
    a.deepEqual(after.receipt,before.receipt,'committed claim bytes and native identity stay unchanged');
    a.deepEqual(core.inventory(f.base,{directoryMetadata:true}),rootBefore,'a refused boot leaves the data root untouched');
   }});
   await manager.cleanupKnown(child.handle,async()=>{healthy();});
   checked('committed claim with a live cold child refuses a new serve and is never rewritten');
  }
  {
   const f=fixture('claim-owned');
   const before=await writeClaim(f,{id:'3'.repeat(48),parentPid:deadPid(),childPid:deadPid(),phases:['armed','committed','owned']});
   const rootBefore=core.inventory(f.base,{directoryMetadata:true});
   await bootScenario(f,'claim-owned',{refuse:true,expectedCode:'work_data_setup.handoff_pending',verify:async()=>{
    const after=await claimApi(f.temp).inspect({base:await canonicalBase(f)});
    a.equal(after.present,true);a.equal(after.value.phase,'owned');
    a.deepEqual(after.receipt,before.receipt,'owned claim stays pending even with a dead child and is never rewritten');
    a.deepEqual(core.inventory(f.base,{directoryMetadata:true}),rootBefore,'an owned claim with a dead child is never auto-repaired');
   }});
   checked('owned claim with a dead child stays pending for a recovery owner');
  }
  {
   const f=fixture('intent-complete'),intentId='4'.repeat(48);
   const backupFile=p.join(f.backups,'ruyi-work-data-'+intentId+'.ruyi-backup'),bytes=Buffer.from('SYNTHETIC INTENT BACKUP, not a package');
   fs.writeFileSync(backupFile,bytes,{flag:'wx'});
   const control=p.join(f.base,'.work-data'),intentFile=p.join(control,'maintenance-v1.json');
   fs.mkdirSync(control);
   fs.writeFileSync(intentFile,JSON.stringify(intentRecord(f,{id:intentId,backupFile,bytes})),{flag:'wx'});
   const before=core.read(intentFile).row;
   const rootBefore=core.inventory(f.base,{directoryMetadata:true});
   await bootScenario(f,'intent-complete',{refuse:true,expectedCode:'work_data_setup.intent_pending',verify:async()=>{
    core.samePinned(core.read(intentFile).row,before);
    a.deepEqual(core.inventory(f.base,{directoryMetadata:true}),rootBefore,'C10 intent is never rewritten or removed by boot');
   }});
   checked('C10: a complete intent without a result still refuses boot and is never rewritten');
  }
  {
   const f=fixture('intent-result'),intentId='5'.repeat(48),resultId='6'.repeat(48);
   const control=p.join(f.base,'.work-data'),intentFile=p.join(control,'maintenance-v1.json');
   const intentBackup=p.join(f.backups,'ruyi-work-data-'+intentId+'.ruyi-backup'),intentBytes=Buffer.from('SYNTHETIC INTENT BACKUP, not a package');
   const resultBackup=p.join(f.backups,'ruyi-work-data-'+resultId+'.ruyi-backup'),resultBytes=Buffer.from('SYNTHETIC RESULT BACKUP, not a package');
   fs.writeFileSync(intentBackup,intentBytes,{flag:'wx'});fs.writeFileSync(resultBackup,resultBytes,{flag:'wx'});
   fs.mkdirSync(control);
   fs.writeFileSync(intentFile,JSON.stringify(intentRecord(f,{id:intentId,backupFile:intentBackup,bytes:intentBytes})),{flag:'wx'});
   const resultFile=p.join(control,'maintenance-result-v1.json');
   fs.writeFileSync(resultFile,JSON.stringify(resultRecord({id:resultId,backupFile:resultBackup,bytes:resultBytes})),{flag:'wx'});
   const beforeIntent=core.read(intentFile).row,beforeResult=core.read(resultFile).row;
   const rootBefore=core.inventory(f.base,{directoryMetadata:true});
   await bootScenario(f,'intent-result',{refuse:true,expectedCode:'work_data_setup.intent_pending',verify:async()=>{
    core.samePinned(core.read(intentFile).row,beforeIntent);
    core.samePinned(core.read(resultFile).row,beforeResult);
    a.deepEqual(core.inventory(f.base,{directoryMetadata:true}),rootBefore,'C11 result plus intent is never rewritten or removed by boot');
   }});
   checked('C11: result plus complete intent still refuses boot and leaves both files untouched');
  }
 }
 async function waitFile(file,budget,label){
  const deadline=Date.now()+budget;
  while(Date.now()<deadline){if(fs.existsSync(file))return true;await sleep(25);}
  throw Error((label||'file')+' deadline');
 }
 async function waitJson(file,budget,label){
  const deadline=Date.now()+budget;
  for(;;){const value=readJsonLoose(file);if(value)return value;if(Date.now()>=deadline)throw Error((label||'json')+' deadline');await sleep(25);}
 }
 return{ctx,latch,healthy,record,checkpoint,checked,openJournal,manager,fixture,spawnServe,readyWarm,statusOf,waitWorkerReady,submitJob,
  claimApi,cimIdentity,absentByCim,coldWindow,waitSuccessor,runRound,bootScenario,writeClaim,intentRecord,resultRecord,waitFile,waitJson,runBootNegatives,stderrOf};
}

async function runActual(argv=process.argv.slice(2)){
 if(process.platform!=='win32'){a.equal(argv.length,0,'ROOT candidate actual requires Windows');console.log('SKIP Windows native production maintenance E2E');require(p.join(__dirname,'lib/harness')).createRunner('WORK DATA PRODUCTION MAINTENANCE').done();return{skipped:true};}
 const target=targetFromArgs(argv);a.equal(Number(process.versions.node.split('.')[0]),24);
 const harness=p.join(target.repo,'dev-harness');require(p.join(harness,'lib/self-isolate-home'));
 const t=require(p.join(harness,'lib/harness')).createRunner('WORK DATA PRODUCTION MAINTENANCE');
 const temp=p.resolve(os.tmpdir()),root=fs.mkdtempSync(p.join(temp,'ruyi-production-maintenance-')),evidence=p.join(root,'evidence');
 a.equal(core.norm(p.dirname(root)),core.norm(temp),'fixture root is a direct child of the tool temp');fs.mkdirSync(evidence);
 const w=createWorld({root,evidence,target});w.openJournal();
 let keeper=null,keeperExit=null,assigned=false,passed=false;
 try{
  w.record({kind:'fixture-owner',root,temp,nonce:c.randomBytes(32).toString('hex'),targetServer:target.server,executionInputSha256:target.executionInputSha256,executionInputs:target.boundFiles.length,inputFiles:target.boundFiles,scope:'Synthetic production maintenance E2E only;not restore, activation or complete 3.1.'});
  keeper=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',p.join(harness,'lib/work-data-production-maintenance-outer-job.ps1')],
   {cwd:harness,env:{...process.env,RUYI_PM_ROOT:root},stdio:'ignore',windowsHide:true});
  // A retained keeper must not become a reason the test cannot end: unref the
  // handle and wait for it only through a bounded, explicit poll on success.
  keeper.unref();
  await w.waitFile(p.join(root,'job-ready.json'),30000,'owned outer Job keeper');
  const f=w.fixture('main');
  const port=await getFreePort('127.0.0.1');
  const handle=w.spawnServe(f,'main-server',port);
  await handle.spawned;w.healthy();
  const initial=await w.readyWarm(handle,f);
  await w.manager.captureNativeBirths(handle);
  const ready=await w.waitWorkerReady(initial);
  w.checkpoint('initial-status',{authority:ready.authority,capabilities:ready.capabilities,lastResult:ready.lastResult,job:ready.job,maintenance:ready.maintenance});
  w.checked('real serve advertises the worker only after the runtime reports readiness');
  // The boot verdicts are independent of any handoff and each owns a separate
  // root, so they are decided first: a blocked handoff must not hide them.
  await w.runBootNegatives();
  let current=initial;const state={round:0};
  for(const spec of [{operation:'enable'},{operation:'export'},{operation:'disable'}]){current=await w.runRound(f,current,spec,state);state.round++;}
  // Only the last successor is handed to the owned Job. Assigning old serve
  // instead would make the product's detached cold launch un-detachable on this
  // host (measured: the cold worker dies the moment serve exits), and every
  // round's old serve is the previous round's successor.
  w.ctx.phase='outer-job-target';
  a.ok(current.handle===null,'the last successor is not a ChildProcess of this test');
  const member={pid:current.pid,cimCreated:current.identity.created};
  fs.writeFileSync(p.join(root,'job-target.json'),JSON.stringify({schema:1,...member}),{flag:'wx'});
  const claimed=await w.waitJson(p.join(root,'job-assigned.json'),BUDGET.jobRelease,'owned outer Job assignment');
  a.equal(claimed.pid,member.pid,'the owned Job holds the published successor identity');
  a.equal(claimed.cimCreated,member.cimCreated);
  assigned=true;
  w.checkpoint('outer-job-assigned',claimed);
  w.ctx.phase='outer-job-release';
  fs.writeFileSync(p.join(root,'job-release.json'),JSON.stringify({schema:1,released:true}),{flag:'wx'});
  const outer=await w.waitJson(p.join(root,'outer-job-result.json'),BUDGET.jobRelease,'outer Job receipt');
  a.equal(outer.ok,true,'the owned outer Job reclaimed every member');
  a.equal(outer.closed,true);
  a.deepEqual(outer.survived,[]);
  a.equal(outer.members.length,1,'the Job contains only the reclaimed successor');
  for(const row of outer.members)a.equal(await w.absentByCim({pid:row.pid,created:row.cimCreated}),true,'outer Job member identity is absent');
  const keeperDeadline=Date.now()+20000;
  while(keeper.exitCode===null&&Date.now()<keeperDeadline)await sleep(50);
  a.equal(keeper.exitCode,0,'the outer Job keeper exits cleanly after reclaiming the successor');
  w.record({kind:'outer-job',members:outer.members,survived:outer.survived,keeperCode:0});
  w.checkpoint('final-status',{authority:current.status.authority,lastResult:current.status.lastResult,capabilities:current.status.capabilities});
  w.checked('successor identity is absent after the owned Job closes');
  const inputsAfter=target.recheck();
  a.equal(inputsAfter.files,target.boundFiles.length,'recheck covers every pinned execution input');
  a.equal(inputsAfter.executionInputSha256,target.executionInputSha256,'recheck re-derives the pinned execution input digest');
  w.checkpoint('execution-inputs-after',inputsAfter);
  a.equal(w.ctx.unknown,false);a.equal(w.manager.hasUnclosed(),false);a.equal(w.manager.hasUnverifiedSpawn(),false);
  w.checkpoint('result',{schema:1,passed:w.ctx.checks.length,checks:w.ctx.checks,root,targetServer:target.server,
   executionInputSha256:inputsAfter.executionInputSha256,executionInputs:inputsAfter.files,inputProof:inputsAfter,
   outerJob:outer,initialServer:w.manager.inspect(handle),
   capabilities:{worker:true,upload:true,download:false,crashClaim:false,activation:false},
   processEvidenceLimit:'Real serve/cold/successor lifecycle plus actual sampled CIM identity. The simulated four-process fixture is not used as evidence here.',
   restorationComplete:false,whole3_1Complete:false});
  passed=true;
  for(const label of w.ctx.checks)t.ok(true,label);
  console.log('Retained synthetic production maintenance evidence '+root);
  t.done();return{passed:true,root};
 }catch(error){
  w.latch(error);
  const projected={schema:1,stage:w.ctx.phase,lastPassed:w.ctx.checks.at(-1)||null,
   code:typeof error?.code==='string'&&/^[A-Z0-9_.-]{1,80}$/i.test(error.code)?error.code:'E2E_FAILURE',
   rawMessagesAndBodiesOmitted:true,...safeFailureLocation(error),diagnostics:w.ctx.diagnostics||null};
  try{fs.writeFileSync(p.join(evidence,'failure-summary.json'),JSON.stringify(projected,null,2)+'\n',{flag:'wx'});}catch{}
  // A failure keeps the scene: the owned Job is never closed by the test. The
  // keeper is told either way so it cannot outlive the run; before a target is
  // assigned its Job is empty, so stopping the keeper kills no product process.
  try{fs.writeFileSync(p.join(root,'job-hold.json'),JSON.stringify({schema:1,held:true,reason:'test-failure',assigned}),{flag:'wx'});}catch{}
  // Bounded failure: evidence is flushed and then this process ends. Nothing the
  // product spawned is killed here, and staying alive just to hold test-owned
  // pipes would only turn a named red into an opaque harness TIMEOUT.
  try{fs.writeSync(2,Buffer.from('Retained production maintenance fixture '+root+'; no automatic cleanup of an unknown owner. stage='+w.ctx.phase+'\n'));}catch{}
  process.exit(1);
 }
}

module.exports={targetFromArgs,createWorld,probePort,BUDGET,runActual,safeFailureLocation};
if(require.main===module)runActual().catch(error=>{try{process.stderr.write(((error&&error.message||String(error)))+String.fromCharCode(10));}catch{}process.exitCode=1;});
