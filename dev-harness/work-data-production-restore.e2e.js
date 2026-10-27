'use strict';
// Permanent ROOT serial acceptance for the production restore path. The complete
// checked-in server is launched as-is (`serve`), the real worker/cold process and
// the real same-port successor are spawned by the product, and every observation
// is a product fact: runtime.json pid/token, the real 13av claim API in TEMP, the
// cold listener's read-only HTTP, the durable maintenance result, CIM identities
// and the restored target's actual bytes. No worker/owner/Setup/broker/native/CLI
// stub is used and no test process ever poses as the restored root.
//
// Journey A (plain generation-zero source): synthetic sealed package -> POST 201
// -> restore 202 -> durable armed claim -> old serve natural exit (committed) ->
// cold listener holding the real source owner (owned) -> real restore + the
// product's own cold verifyFresh child -> same-port successor reading the
// unchanged source. The same admitted upload is used after every pre-admission
// refusal, which proves none of them consumed its grant. Claim phases are
// proven by product ordering, never by polling the record mid-write: on this
// host a read handle makes the product's atomic rename fail with EPERM.
//
// Journey B (real encrypted source): a real `enable` round and a real `export`
// round run on a second synthetic source, then the exported encrypted package is
// uploaded and restored with the EXPORT password (different from the password
// that enabled the source). Restore never depends on the source master keys:
// it authenticates the package with its own password and stages the target key
// header under fresh DPAPI protection, which is asserted on the target bytes.
//
// Deliberately NOT triggered here: a wrong restore password or a post-admission
// on-disk package tamper. Those fail inside the owned cold process, and by
// product design (13ak/13am hold) the cold listener then keeps the source owner
// and the port alive awaiting a recovery owner - an E2E that continued would leak
// a live product process. Both are covered by the real cold-operations unit
// tests; this file says so instead of manufacturing a dangerous kill.
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),c=require('node:crypto'),a=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),{createProcesses,createStrictStop}=require('./lib/work-data-production-upload-process');
const upload=require('./work-data-production-upload.e2e');
const PACKAGE_PASSWORD='SYNTHETIC production restore package 2026';
const SOURCE_PASSWORD='SYNTHETIC production restore source enable 2026';
const EXPORT_PASSWORD='SYNTHETIC production restore export only 2026';
const SESSION_ID='sess_restore_synthetic';
const SESSION_BYTES=JSON.stringify({id:SESSION_ID,private:'完整合成恢复源，保持原字节。',title:'Synthetic restore session',messages:[]});
const AUTHORITY0=Object.freeze({generation:0,id:null,mode:'plain',sha256:null});
const BUDGET=Object.freeze({...upload.BUDGET,handoff:60000,claim:30000,coldPort:30000,coldOperation:240000,successor:120000,keeper:90000});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const TRANSPORT=new Set(['ECONNREFUSED','ECONNRESET','EPIPE','EHOSTUNREACH','ENOTFOUND','EAI_AGAIN']);
const isTransport=error=>TRANSPORT.has(error?.code)||/test HTTP observation deadline|socket hang up|test response aborted|test response closed before end/i.test(String(error?.message||''));
function safeFailureLocation(error){
 let name='UnknownError',stack='';try{if(['Error','AssertionError','TypeError','RangeError'].includes(error?.name))name=error.name;}catch{}try{if(typeof error?.stack==='string')stack=error.stack;}catch{}
 const frame=stack.split(/\r?\n/).filter(line=>/^\s+at /.test(line)).map(line=>/work-data-production-restore\.e2e\.js:(\d+):(\d+)\)?$/.exec(line)).find(Boolean);
 return {errorName:name,failureLocation:frame?{file:'work-data-production-restore.e2e.js',line:Number(frame[1]),column:Number(frame[2])}:null};
}
const targetFromArgs=argv=>{a.equal(argv.length,0,'permanent E2E uses the current complete product build');return core.loadProductTarget(__dirname);};

function createWorld({root,evidence,target,harness,releaseEnvironment,snapshotProcessTable,ownDescendants,getFreePort}){
 const ctx={unknown:false,failure:null,failureSet:false,checks:[],phase:'initialization',root,evidence,diagnostics:null};
 const latch=error=>{ctx.unknown=true;if(!ctx.failureSet){ctx.failureSet=true;ctx.failure=error;}};
 function healthy(){if(ctx.unknown)throw Error('unknown forbids new test work');}
 function sourceGate(){healthy();try{target.recheck();}catch(error){latch(error);throw error;}healthy();}
 function rawWrite(fd,bytes){let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(n<1)throw Error('test evidence short write');offset+=n;}}
 let journalFD=null;
 function openJournal(){journalFD=fs.openSync(p.join(evidence,'events.jsonl'),'wx',0o600);}
 function close(){for(const [name,fd]of outputFD){fs.fsyncSync(fd);fs.closeSync(fd);outputFD.delete(name);}if(journalFD!==null){fs.fsyncSync(journalFD);fs.closeSync(journalFD);journalFD=null;}}
 function record(row){try{a.ok(!ctx.unknown,'test observation already failed');rawWrite(journalFD,Buffer.from(JSON.stringify({...row,at:new Date().toISOString()})+'\n'));fs.fsyncSync(journalFD);}catch(error){latch(error);throw error;}}
 function checkpoint(name,value){try{a.match(name,/^[a-z0-9-]+$/);const file=p.join(evidence,name+'.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx',0o600);try{rawWrite(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const captured=core.read(file);a.equal(captured.row.sha256,core.H(bytes));record({kind:'checkpoint',name,...captured.row});return captured.row;}catch(error){latch(error);throw error;}}
 function checked(label){a.equal(ctx.unknown,false,'unknown forbids new test success');ctx.checks.push(label);record({kind:'assertion-pass',label});}

 const pure=(file,symbol)=>upload.loadPure(core.read(p.join(target.src,file)).bytes.toString('utf8'),symbol);
 let recovery=null,resultOwner=null,claimSource=null,ownershipSource=null;
 const getRecovery=()=>recovery||(recovery=pure('01t-work-data-recovery.js','WorkDataRecovery'));
 const getResultOwner=()=>resultOwner||(resultOwner=pure('01ae-work-data-maintenance-result.js','WorkDataMaintenanceResult'));
 const getOwnership=()=>ownershipSource||(ownershipSource=pure('01g-server-ownership.js','ServerOwnership'));
 function claimApi(temp){
  if(!claimSource)claimSource=pure('13av-work-data-handoff-claim.js','WorkDataHandoffClaim');
  // flush is a test seam for observation only; this E2E never writes a claim.
  return claimSource.create({temp,flush:async()=>{}});
 }
 const canonicalBase=f=>getOwnership().canonicalRoot(f.base);

 const outputFD=new Map();
 function openOutput(label){for(const kind of ['stdout','stderr'])outputFD.set(label+':'+kind,fs.openSync(p.join(evidence,label+'-'+kind+'.log'),'wx',0o600));}
 const manager=createProcesses({record,writeOutput(label,kind,bytes){try{rawWrite(outputFD.get(label+':'+kind),bytes);}catch(error){latch(error);throw error;}},latch,isUnknown:()=>ctx.unknown,
  beforeStart:sourceGate,killOwnTree:createStrictStop({snapshotProcessTable,ownDescendants,latch,isUnknown:()=>ctx.unknown}),snapshotProcessTable,ownDescendants});

 function spawnServe(f,label,port){
  healthy();openOutput(label);
  // detached deliberately (same reason as the maintenance E2E): libuv would give
  // a non-detached child a kill-on-close Job, and the product's detached cold
  // worker would inherit it and die the moment old serve exits.
  return manager.start(process.execPath,[target.server,'serve','--host','127.0.0.1','--port',String(port)],{cwd:p.dirname(target.server),env:f.env,windowsHide:true,detached:true,stdio:['ignore','pipe','pipe']},label);
 }
 const config=workspace=>({configSchema:14,locale:'en-US',workDataEncryptionV1:false,permissionMode:'ask',stewardEnabledV1:false,schedulerEnabledV1:false,autoImportClaudeCodeMcp:false,importAgentInstructions:false,includeWorkbenchMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[],providers:[],defaultWorkspace:workspace});
 function fixture(label){
  healthy();const base=p.join(root,label+'-data'),home=p.join(root,label+'-home'),backups=p.join(root,label+'-backups'),targets=p.join(root,label+'-targets'),env=releaseEnvironment(home,base);
  fs.mkdirSync(base);fs.mkdirSync(p.join(base,'sessions'));fs.mkdirSync(backups);fs.mkdirSync(targets);
  fs.writeFileSync(p.join(base,'config.json'),JSON.stringify(config(root)),{flag:'wx'});
  fs.writeFileSync(p.join(base,'sessions',SESSION_ID+'.json'),SESSION_BYTES,{flag:'wx'});
  return{label,base,home,backups,targets,env,temp:p.resolve(env.TEMP)};
 }

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

 async function request(ref,path,bytes,options={}){healthy();const result=await upload.makeHttp({port:ref.port,token:ref.token},path,bytes,{...options,guard:healthy});healthy();return result;}
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
    if(health.status===200&&health.value?.ok===true){const identity=await cimIdentity(rt.pid);return{pid:rt.pid,port:rt.port,token:rt.token,handle,identity};}
   }
   await sleep(50);
  }
  throw Error('complete normal serve startup observation deadline');
 }
 async function statusOf(ref){healthy();const response=await request(ref,'/api/work-data/status');a.equal(response.status,200);return response.value;}
 async function waitWorkerReady(ref){
  const deadline=Date.now()+BUDGET.startup;
  for(;;){const value=await statusOf(ref);if(value.capabilities?.worker===true)return value;if(Date.now()>=deadline)throw Error('worker capability never became ready');await sleep(50);}
 }
 async function postJob(ref,body){
  healthy();const bytes=Buffer.from(JSON.stringify(body));
  try{
   const response=await request(ref,'/api/work-data/jobs',bytes,{method:'POST',headers:{'content-type':'application/json'}});
   record({kind:'job-response',status:response.status,safe:upload.safeJobResponse(response)});
   return response;
  }finally{bytes.fill(0);}
 }
 async function submitAccepted(ref,body){
  const response=await postJob(ref,body);
  a.equal(response.status,202,'job accepted');
  a.equal(response.value?.ok,true);
  a.match(response.value.job.id,/^[a-f0-9]{48}$/);
  return response.value.job.id;
 }

 // The 13av record is only read when the product cannot be writing it. On this
 // host a rename over a file another process holds open for read fails with
 // EPERM (standalone probe), so a polling observer would be able to break the
 // product's atomic claim write. Instead the armed record is proven by its safe
 // existence check (no handle), committed by the old serve's exit 0 after the
 // handshake, owned by the cold listener (created only after `owned` is written),
 // and the final absence by an inspect after the operation is over.
 function claimRoot(f){
  const fold=process.platform==='win32'?p.resolve(f.base).toLowerCase():p.resolve(f.base);
  const digest=c.createHash('sha256').update(Buffer.from(fold,'utf8')).digest('hex');
  return p.join(f.temp,'ruyi-work-data-handoff-'+digest);
 }
 const claimFile=f=>p.join(claimRoot(f),'claim-v1.json');
 async function waitClaimRecord(f,budget=BUDGET.claim){
  const deadline=Date.now()+budget;
  for(;;){
   if(fs.existsSync(claimFile(f)))return claimFile(f);
   if(Date.now()>=deadline)throw Error('durable handoff claim record never appeared');
   await sleep(25);
  }
 }
 async function assertClaimGone(f,label){
  const found=await claimApi(f.temp).inspect({base:await canonicalBase(f)});
  a.equal(found.present,false,label+': no handoff claim survives a completed operation');
  if(fs.existsSync(claimRoot(f)))a.deepEqual(fs.readdirSync(claimRoot(f)).filter(name=>name.startsWith('.claim-v1.stage-')),[],label+': no staged claim file survives');
 }

 function custodyDirs(f){return fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-upload-'));}
 function custodyWithUpload(f,uploadId){
  const matches=custodyDirs(f).filter(name=>fs.existsSync(p.join(f.temp,name,'restore-upload-'+uploadId+'.sealed')));
  a.equal(matches.length,1,'exactly one custody root holds the admitted upload');
  return{name:matches[0],dir:p.join(f.temp,matches[0])};
 }
 function dataSnapshot(base){return{base,...core.inventory(base)};}
 function sourcePins(f,extra=[]){
  const files=['config.json','sessions/'+SESSION_ID+'.json',...extra];
  return files.map(relative=>({relative,row:core.read(p.join(f.base,...relative.split('/'))).row}));
 }
 function relativeTo(base,file){return p.relative(base,file).split(p.sep).join('/');}
 // A normal serve boot rewrites its own runtime artifacts (runtime.json, the MCP
 // host/install mirrors, generated config, logs, the pretender projection index).
 // That set is explicit; it is not a blanket "ignore anything". config.json and
 // the session head are separately pinned byte-for-byte and never appear here.
 function isNormalStartupArtifact(relative){
  // After enable the live root is the active generation, so a normal boot writes
  // the same artifact names inside `.work-data/generations/<id>/`. Normalize that
  // prefix before classifying; config.json itself is never in this set.
  const stripped=relative.replace(/^\.work-data\/generations\/[a-f0-9]{48}\//i,'');
  const name=stripped.toLowerCase();
  if(['runtime.json','config.json.prev','claude-settings-sync.json','install-registry.json','mcp-host-v1.json'].includes(name))return true;
  if(name==='sessions/.pretender'||name.startsWith('sessions/.pretender/'))return true;
  return /^(?:logs|generated|uploads|usage|checkpoints|agent-runs|memory)\//.test(name);
 }

 function assertCapabilities(value,label){
  a.deepEqual(value.capabilities,{worker:true,upload:true,download:false},label+': only the real worker and upload are advertised');
  a.equal(Object.hasOwn(value.capabilities,'crashClaim'),false);
  a.equal(Object.hasOwn(value.capabilities,'activation'),false);
  a.equal(value.processRestartRequired,true);
 }
 function assertRestoreResult({f,status,id,targetPath,source,uploaded}){
  const saved=status.lastResult;
  a.ok(saved,'status must carry the durable restore result');
  a.equal(saved.schema,1);a.equal(saved.id,id);a.equal(saved.operation,'restore');a.equal(saved.state,'verified');
  a.deepEqual(saved.sourceAuthority,source,'restore keeps the source authority it was admitted against');
  a.deepEqual(saved.authority,status.authority);
  a.deepEqual(saved.authority,source,'a restore publishes no new source generation');
  // The durable restore record has exactly these keys; restartRoot/publication
  // belong to enable/export and are never invented for a restore.
  a.equal(Object.hasOwn(saved,'restartRoot'),false,'restore result carries no restartRoot field');
  a.equal(Object.hasOwn(saved,'publication'),false,'restore result carries no publication field');
  a.deepEqual(Object.keys(saved.restored||{}).sort(),['activation','target']);
  a.equal(saved.restored.activation,'separate-fresh-root');
  a.equal(saved.restored.target,p.resolve(targetPath));
  const expectedBackup=p.join(f.backups,'ruyi-work-data-'+id+'.ruyi-backup');
  a.equal(saved.backup.path,expectedBackup);
  a.equal(saved.backup.bytes,uploaded.length);
  a.equal(saved.backup.sha256,core.H(uploaded));
  const backup=core.read(expectedBackup);
  a.ok(backup.bytes.equals(uploaded),'backup bytes are byte-for-byte the uploaded package');
  a.equal(backup.row.dev,saved.backup.identity.dev);a.equal(backup.row.ino,saved.backup.identity.ino);
  a.equal(getRecovery().inspectSealed(backup.bytes.toString('utf8')),true);
  const resultPath=p.join(f.base,'.work-data','maintenance-result-v1.json');
  const resultFile=core.read(resultPath);
  const parsed=JSON.parse(resultFile.bytes);
  const {proof,...body}=saved;
  a.deepEqual(body,parsed,'durable restore record equals the served lastResult minus its proof');
  a.equal(proof.sha256,resultFile.row.sha256);
  a.equal(proof.identity.dev,resultFile.row.dev);
  a.equal(proof.identity.ino,resultFile.row.ino);
  a.equal(getResultOwner().decode(resultFile.bytes).id,id,'the real result owner decodes the durable restore record');
  return {saved,resultPath,backupPath:expectedBackup};
 }
 function assertNoIntent(f,label){
  const control=p.join(f.base,'.work-data');
  a.equal(fs.existsSync(p.join(control,'maintenance-v1.json')),false,label+': no pending intent survives a restore');
  if(fs.existsSync(control)){
   const names=fs.readdirSync(control).sort();
   a.deepEqual(names.filter(name=>/^\.maintenance-v1\.stage-|^\.maintenance-result-v1\.stage-/.test(name)),[],label+': no staged control file survives');
   const allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
   for(const name of names)a.equal(allowed.has(name),true,label+': unexpected control entry '+name);
  }
 }

 // The cold listener is the only witness that execution moved into a new process:
 // it binds the old port after old serve died, holds the real OS source owner and
 // exposes read-only status for exactly this job.
 function probePort(port,timeout=1500){
  return (async()=>{
   let health;
   try{health=await upload.makeHttp({port,token:''},'/health',undefined,{auth:false,timeout});}
   catch(error){if(isTransport(error))return{kind:'none',port};return{kind:'error',port,code:String(error?.code||error?.message||'error')};}
   if(health.status!==200||health.value?.ok!==true)return{kind:'other',port,status:health.status};
   if(health.value.maintenance===true)return{kind:'cold',port,health:health.value};
   if(typeof health.value.app==='string'||typeof health.value.launchMode==='string')return{kind:'warm',port,health:health.value};
   return{kind:'other',port,status:health.status};
  })();
 }
 async function coldBatch(port,{base,jobId,source,staleToken,operation}){
  const bare={port,token:''};
  try{
   const boot=await upload.makeHttp(bare,'/api/bootstrap',undefined,{method:'POST',auth:false,timeout:2500});
   a.equal(boot.status,200);
   a.match(boot.value?.token,/^[a-f0-9]{64}$/,'cold token is a fresh 32-byte secret');
   const selected={port,token:boot.value.token};
   const st=await upload.makeHttp(selected,'/api/work-data/status',undefined,{timeout:2500});
   a.equal(st.status,200);
   a.deepEqual(st.value.capabilities,{worker:false,upload:false,download:false},'cold listener advertises no transfer or worker');
   a.equal(st.value.lastResult,null);
   a.equal(st.value.job?.id,jobId);
   a.equal(st.value.job?.operation,operation);
   a.ok(['handoff','uncertain','failed'].includes(st.value.job?.state),'cold job state is a live handoff verdict');
   a.deepEqual(st.value.authority,source);
   const none=await upload.makeHttp(bare,'/api/work-data/status',undefined,{auth:false,timeout:2500});
   a.equal(none.status,403);a.equal(none.value?.error?.code,'auth.token_invalid');
   const post=await upload.makeHttp(selected,'/api/work-data/status',undefined,{method:'POST',timeout:2500});
   a.equal(post.status,409);a.equal(post.value?.error?.code,'work_data_setup.takeover_committed');
   const body=await upload.makeHttp(selected,'/api/work-data/status',Buffer.from('abc'),{method:'GET',timeout:2500});
   a.equal(body.status,413);a.equal(body.value?.error?.code,'work_data_setup.body_not_allowed');
   const stale=await upload.makeHttp({port,token:staleToken},'/api/work-data/status',undefined,{timeout:2500});
   a.equal(stale.status,403,'the retired warm token never authorizes the cold listener');
   let lease=null,refused=false;
   try{lease=await getOwnership().acquire([base]);}catch(error){refused=/DATA_ROOT_IN_USE/.test(String(error?.code||''))||/DATA_ROOT_IN_USE/.test(String(error?.message||''));if(!refused)throw error;}
   if(lease){try{await lease.release();}catch{/* the unexpected lease is reported below */}
    a.equal(false,true,'cold worker must hold the OS source owner');}
   a.equal(refused,true,'cold worker holds the real source owner while executing');
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
     record({kind:'cold-window-observed',attempts,port,jobState:value.job.state,jobPhase:value.job.phase||null,error:value.job.error||null});
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
 async function readColdVerdict(port){
  try{
   const boot=await upload.makeHttp({port,token:''},'/api/bootstrap',undefined,{method:'POST',auth:false,timeout:2500});
   if(boot.status!==200||typeof boot.value?.token!=='string')return null;
   const st=await upload.makeHttp({port,token:boot.value.token},'/api/work-data/status',undefined,{timeout:2500});
   if(st.status!==200)return null;
   const value={job:st.value?.job??null,authority:st.value?.authority??null};
   record({kind:'cold-verdict',...value});return value;
  }catch{return null;}
 }
 async function waitOldServeExit(ref,{budget=BUDGET.handoff}={}){
  const gone=async()=>a.equal(await absentByCim(ref.identity,budget),true,'old serve creation identity is absent');
  if(ref.handle){
   const terminal=await manager.waitClose(ref.handle,budget);healthy();
   a.equal(terminal.code,0,'old serve exits only after the acknowledged handoff');
   a.equal(terminal.signal,null);
   await manager.certifyNaturalExit(ref.handle,{code:0,signal:null,verify:gone});
  }else await gone();
  return{closedAt:Date.now()};
 }
 async function waitSuccessor(ref,f,jobId,{notPids}){
  const deadline=Date.now()+BUDGET.successor;
  for(;;){
   const rt=(()=>{try{return JSON.parse(fs.readFileSync(p.join(f.base,'runtime.json'),'utf8'));}catch{return null;}})();
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
    const held=await readColdVerdict(ref.port);
    if(held)throw Error('successor readiness deadline; cold job state='+held.job?.state+' phase='+held.job?.phase+' error='+held.job?.error);
    throw Error('successor readiness deadline; no cold verdict available on the same port');
   }
   await sleep(50);
  }
 }

 // One real maintenance round: POST job -> durable armed claim record -> old
 // serve natural exit (committed) -> cold listener (owned, real OS owner) ->
 // same-port successor -> verified result -> claim removed.
 async function runMaintenanceRound(f,ref,spec){
  const before=await statusOf(ref);assertCapabilities(before,'round');
  a.equal(before.job,null,'a new round starts with no inherited job');
  const source=before.authority;
  const sourceBefore=dataSnapshot(f.base);
  const pins=sourcePins(f,spec.protected||[]);
  a.equal(fs.existsSync(claimFile(f)),false,'a new round starts with no durable handoff claim');
  ctx.phase=spec.phase+'-submit';
  const jobId=await submitAccepted(ref,spec.body({source}));
  record({kind:'round-start',phase:spec.phase,operation:spec.operation,jobId,sourceAuthority:source});
  const recordFile=await waitClaimRecord(f);
  record({kind:'claim-armed-record',phase:spec.phase,jobId,file:recordFile,proof:'existence-only;no-read-handle-against-the-product-rename'});
  const custodyBefore=custodyDirs(f).length;
  ctx.phase=spec.phase+'-old-exit';
  const exited=await waitOldServeExit(ref,{budget:BUDGET.handoff});
  // 13ai sends `go`, the cold writes `committed` and acknowledges `armed`, and
  // only then does the parent exit 0. A natural 0 exit therefore proves the
  // committed record was durably written; it is not inferred from a poll.
  record({kind:'claim-committed-proof',phase:spec.phase,jobId,by:'old-serve-exit-0',closedAt:exited.closedAt});
  ctx.phase=spec.phase+'-cold';
  const cold=await coldWindow(ref.port,{base:f.base,jobId,source,staleToken:ref.token,operation:spec.operation});
  // The cold listener exists only after `owned` was advanced and the real OS
  // source owner was acquired (13ai), so this is the owned proof.
  record({kind:'cold-status',phase:spec.phase,jobId,jobState:cold.job.state,authority:cold.authority,ownedProof:'cold-listener-with-real-source-owner'});
  ctx.diagnostics={jobId,operation:spec.operation,claimEvidence:{armedRecord:true,committedBy:'old-serve-exit-0',ownedBy:'cold-listener'}};
  ctx.phase=spec.phase+'-successor';
  const next=await waitSuccessor(ref,f,jobId,{notPids:[ref.pid]});
  record({kind:'claim-timeline',phase:spec.phase,jobId,armedAt:null,committedProofAt:exited.closedAt,ownedProofAt:Date.now(),successorAt:Date.now()});
  ctx.phase=spec.phase+'-verify';
  const verified=await spec.verify({next,status:next.status,jobId,source,sourceBefore,pins,custodyBefore});
  await assertClaimGone(f,spec.phase);
  return{next,jobId,source,verified};
 }
 // The successor is not a ChildProcess of this test (the product spawns it). The
 // owned outer Job is the only mechanism that may reclaim it: the exact
 // <pid, creation> pair is assigned, the Job is closed, absence is checked.
 async function reclaimSuccessor(label,ref){
  const dir=p.join(root,label+'-keeper');fs.mkdirSync(dir,{recursive:true});
  const keeper=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',p.join(harness,'lib/work-data-production-maintenance-outer-job.ps1')],
   {cwd:harness,env:{...process.env,RUYI_PM_ROOT:dir},stdio:'ignore',windowsHide:true});
  keeper.unref();
  const waitFile=async(file,budget,name)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){if(fs.existsSync(file))return true;await sleep(25);}throw Error(name+' deadline');};
  const waitJson=async(file,budget,name)=>{const deadline=Date.now()+budget;for(;;){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{ }if(Date.now()>=deadline)throw Error(name+' deadline');await sleep(25);}};
  await waitFile(p.join(dir,'job-ready.json'),30000,label+' owned outer Job keeper');
  const member={pid:ref.pid,cimCreated:ref.identity.created};
  fs.writeFileSync(p.join(dir,'job-target.json'),JSON.stringify({schema:1,...member}),{flag:'wx'});
  const assigned=await waitJson(p.join(dir,'job-assigned.json'),BUDGET.keeper,label+' owned Job assignment');
  a.equal(assigned.pid,member.pid,'the owned Job holds the published successor identity');
  a.equal(assigned.cimCreated,member.cimCreated);
  fs.writeFileSync(p.join(dir,'job-release.json'),JSON.stringify({schema:1,released:true}),{flag:'wx'});
  const outer=await waitJson(p.join(dir,'outer-job-result.json'),BUDGET.keeper,label+' owned Job receipt');
  a.equal(outer.ok,true,'the owned outer Job reclaimed every member');
  a.equal(outer.closed,true);
  a.deepEqual(outer.survived,[]);
  a.equal(outer.members.length,1,'the Job contains only the reclaimed successor');
  a.equal(await absentByCim(ref.identity),true,'successor identity is absent after the owned Job closes');
  const deadline=Date.now()+20000;while(keeper.exitCode===null&&Date.now()<deadline)await sleep(50);
  a.equal(keeper.exitCode,0,'the outer Job keeper exits cleanly');
  checkpoint('outer-job-'+label,{assigned,outer,keeperCode:0});
 }

 // ── journey A: plain generation-zero source ────────────────────────────────
 async function runPlainJourney(){
  const f=fixture('plain');
  // A normal boot legitimately writes its own runtime artifacts. Capture exactly
  // which paths the first boot touches, so the successor's boot may only touch
  // that same set (plus the new result); the protected files stay pinned below.
  const pristine=dataSnapshot(f.base);
  const port=await getFreePort('127.0.0.1');
  const handle=spawnServe(f,'plain-serve',port);
  await handle.spawned;healthy();
  const initial=await readyWarm(handle,f);
  const bootDiff=core.observeDifference(pristine,dataSnapshot(f.base));
  const bootTouched=[...new Set([...bootDiff.added,...bootDiff.changed.map(row=>row.after.file)])];
  checkpoint('plain-boot-effects',{added:bootDiff.added,changed:bootDiff.changed.map(row=>row.after.file),removed:bootDiff.removed});
  await manager.captureNativeBirths(handle);
  const ready=await waitWorkerReady(initial);
  checkpoint('plain-initial-status',{authority:ready.authority,capabilities:ready.capabilities,job:ready.job,lastResult:ready.lastResult});
  a.deepEqual(ready.authority,AUTHORITY0,'the plain fixture starts at generation zero');
  checked('plain: the real serve advertises the worker and upload on a generation-zero source');

  ctx.phase='plain-package';
  const sealed=Buffer.from(await getRecovery().seal({appVersion:'3.0.1',generation:0,createdAt:'2026-10-28T00:00:00.000Z',directories:['sessions'],
   keys:[],files:[{path:'config.json',data:Buffer.from(JSON.stringify(config(root))),keyRefs:[]},{path:'sessions/'+SESSION_ID+'.json',data:Buffer.from(SESSION_BYTES),keyRefs:[]}],auxiliaries:[]},PACKAGE_PASSWORD));
  healthy();
  a.equal(getRecovery().inspectSealed(sealed.toString('utf8')),true);
  checkpoint('plain-package',{bytes:sealed.length,sha256:core.H(sealed),sealed:true});
  checked('plain: the synthetic package is sealed by the real WorkDataRecovery owner');

  ctx.phase='plain-upload';
  const uploadResponse=await request(initial,'/api/work-data/uploads',sealed,{method:'POST',headers:{origin:'http://127.0.0.1:'+initial.port,'sec-fetch-site':'same-origin','content-type':'application/octet-stream'}});
  a.equal(uploadResponse.status,201);a.equal(uploadResponse.value?.ok,true);a.match(uploadResponse.value.uploadId,/^[a-f0-9]{48}$/);
  const uploadId=uploadResponse.value.uploadId;
  const custody=custodyWithUpload(f,uploadId),custodyNames=fs.readdirSync(custody.dir).sort();
  a.deepEqual(custodyNames,['restore-upload-'+uploadId+'.sealed','restore-upload-owner.json'].sort());
  a.ok(core.read(p.join(custody.dir,'restore-upload-'+uploadId+'.sealed')).bytes.equals(sealed));
  checkpoint('plain-custody-after-upload',{custody:custody.name,...core.inventory(custody.dir)});
  checked('plain: the real POST 201 stores the exact sealed bytes in genuine joint-owner custody');

  // Pre-admission refusals. Every one of them is decided before worker.start, so
  // none may consume the admitted upload: the same uploadId is used below.
  ctx.phase='plain-negatives';
  const negativeTargets={
   nested:p.join(f.base,'restored-inside'),
   backupNested:p.join(f.backups,'restored-inside-backup'),
   unknown:p.join(f.targets,'unknown-upload-target'),
   stale:p.join(f.targets,'stale-authority-target')
  };
  const existing=p.join(f.targets,'pre-existing');
  fs.mkdirSync(existing);fs.writeFileSync(p.join(existing,'sentinel.bin'),Buffer.from('SYNTHETIC pre-existing target bytes'),{flag:'wx'});
  const existingBefore=core.inventory(existing);
  const custodyBefore=core.inventory(custody.dir);
  const backupsBefore=fs.readdirSync(f.backups).sort();
  const claimRootsBefore=fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-handoff-'));
  a.deepEqual(claimRootsBefore,[]);
  const restoreBody=(overrides={})=>({operation:'restore',password:PACKAGE_PASSWORD,expectedAuthority:ready.authority,backupDirectory:f.backups,targetDirectory:negativeTargets.unknown,uploadId,...overrides});
  // The directory owner refuses containment in both directions: a target nested
  // in the source or in the backup directory, a target that is the source itself,
  // an existing target, a backup inside the source and a source inside the backup.
  const jobNegatives=[
   ['restore-target-inside-source',restoreBody({targetDirectory:negativeTargets.nested}),400,'work_data_setup.path_invalid'],
   ['restore-target-inside-backup',restoreBody({targetDirectory:negativeTargets.backupNested}),400,'work_data_setup.path_invalid'],
   ['restore-target-equals-source',restoreBody({targetDirectory:f.base}),400,'work_data_setup.path_invalid'],
   ['restore-target-already-exists',restoreBody({targetDirectory:existing}),400,'work_data_setup.path_invalid'],
   ['restore-backup-inside-source',restoreBody({backupDirectory:p.join(f.base,'backups-inside')}),400,'work_data_setup.path_invalid'],
   ['restore-source-inside-backup',restoreBody({backupDirectory:p.dirname(f.base)}),400,'work_data_setup.path_invalid'],
   ['restore-unknown-upload',restoreBody({uploadId:'f'.repeat(48)}),409,'work_data_upload.grant_unavailable'],
   ['restore-stale-authority',restoreBody({targetDirectory:negativeTargets.stale,expectedAuthority:{generation:1,id:'a'.repeat(48),mode:'plain',sha256:'b'.repeat(64)}}),409,'work_data_setup.authority_changed'],
   ['restore-missing-upload-id',(()=>{const body=restoreBody({targetDirectory:p.join(f.targets,'missing-id-target')});delete body.uploadId;return body;})(),400,'work_data_setup.restore_input_invalid']
  ];
  for(const [label,body,expectedStatus,expectedCode]of jobNegatives){
   ctx.phase='plain-negative-'+label;
   const response=await postJob(initial,body);
   checkpoint('negative-'+label,upload.safeJobResponse(response));
   a.equal(response.status,expectedStatus,label);
   a.equal(response.value?.error?.code,expectedCode,label+' stable api code');
   a.equal(response.value?.error?.message,expectedCode,label+' message is the stable code');
   const observed=await statusOf(initial);
   a.deepEqual(observed.authority,ready.authority,label+' never publishes authority');
   a.equal(observed.job,null,label+' never registers a job');
   a.equal(fs.existsSync(p.join(f.base,'.work-data','maintenance-v1.json')),false,label+' never starts a maintenance intent');
   a.deepEqual(fs.readdirSync(f.backups).sort(),backupsBefore,label+' never creates a backup');
   a.deepEqual(fs.readdirSync(f.temp).filter(name=>name.startsWith('ruyi-work-data-handoff-')),[],label+' never writes a handoff claim');
   a.deepEqual(core.inventory(custody.dir),custodyBefore,label+' leaves the admitted upload byte-identical');
   a.equal(fs.existsSync(p.join(f.base,'runtime.json')),true,label+' keeps the warm runtime record');
   a.equal(manager.inspect(handle).closeSeen,false,label+' leaves the serve running');
   for(const target of [negativeTargets.nested,negativeTargets.backupNested,negativeTargets.unknown,negativeTargets.stale])a.equal(fs.existsSync(target),false,label+' never creates '+target);
   checked(label+' is refused at pre-admission with no grant, backup, target, intent or claim');
  }
  // Two structurally invalid packages are refused by the real upload route and
  // never reach custody.
  for(const [label,bytes,expectedCode]of [['restore-upload-plaintext',Buffer.from('{"private":"UNSEALED_RESTORE_SENTINEL"}'),'work_data_recovery.invalid'],['restore-upload-invalid-utf8',Buffer.from([0xff]),'work_data_upload.sealed_required']]){
   ctx.phase='plain-negative-'+label;
   const response=await request(initial,'/api/work-data/uploads',bytes,{method:'POST',headers:{origin:'http://127.0.0.1:'+initial.port,'sec-fetch-site':'same-origin','content-type':'application/octet-stream'}});
   checkpoint('negative-'+label,upload.safeJobResponse(response));
   a.equal(response.status,409,label);
   a.equal(response.value?.error?.code,expectedCode,label+' stable api code');
   a.deepEqual(core.inventory(custody.dir),custodyBefore,label+' must not publish a custody artifact');
   a.equal(fs.existsSync(p.join(f.base,'.work-data','maintenance-v1.json')),false,label+' never starts a maintenance intent');
   await statusOf(initial);
   checked(label+' is refused by the real upload route before custody publication');
  }
  a.deepEqual(core.inventory(existing),existingBefore,'a refused existing target is never modified');
  checkpoint('plain-custody-before-restore',core.inventory(custody.dir));

  const targetDirectory=p.join(f.targets,'restored');
  const round=await runMaintenanceRound(f,initial,{
   phase:'plain-restore',operation:'restore',
   body:({source})=>({operation:'restore',password:PACKAGE_PASSWORD,expectedAuthority:source,backupDirectory:f.backups,targetDirectory,uploadId}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    assertCapabilities(status,'plain restore successor');
    a.equal(status.job,null,'a new process never inherits the restore job');
    a.equal(status.configMirror,false,'the plain source mirror stays plain');
    a.deepEqual(status.authority,AUTHORITY0,'the plain source authority is unchanged by a restore');
    const {saved,resultPath,backupPath}=assertRestoreResult({f,status,id:jobId,targetPath:targetDirectory,source,uploaded:sealed});
    assertNoIntent(f,'plain restore');
    a.deepEqual(status.lastResult.restored,{target:p.resolve(targetDirectory),activation:'separate-fresh-root'});
    a.equal(fs.existsSync(backupPath),true);
    a.equal(custodyDirs(f).length,count+1,'one fresh custody root per normal serve start');
    const restoredCustody=custodyDirs(f).find(name=>name!==custody.name&&fs.existsSync(p.join(f.temp,name,'restore-upload-owner.json')));
    a.ok(restoredCustody,'the successor allocates its own custody root');
    a.deepEqual(fs.readdirSync(p.join(f.temp,restoredCustody)),['restore-upload-owner.json'],'the successor custody holds only the broker owner marker');
    // The consumed grant's custody is intact: marker, exact upload bytes, one
    // handoff record bound to this job and package. Nothing is rewritten.
    const names=fs.readdirSync(custody.dir).sort();
    a.ok(names.includes('restore-upload-'+uploadId+'.sealed'));
    a.ok(core.read(p.join(custody.dir,'restore-upload-'+uploadId+'.sealed')).bytes.equals(sealed));
    const handoffs=names.filter(name=>/^handoff-[a-f0-9]{48}-[a-f0-9]{64}\.json$/.test(name));
    a.equal(handoffs.length,1,'exactly one handoff record was published for the consumed grant');
    const handoff=JSON.parse(core.read(p.join(custody.dir,handoffs[0])).bytes);
    a.equal(handoff.schema,1);
    a.equal(handoff.jobId,jobId);
    a.equal(handoff.uploadId,uploadId);
    a.equal(core.norm(handoff.base),core.norm(f.base));
    a.equal(core.norm(handoff.file),core.norm(p.join(custody.dir,'restore-upload-'+uploadId+'.sealed')));
    a.equal(handoff.bytes,sealed.length);
    a.equal(handoff.sha256,core.H(sealed));
    await assertPlainTarget({target:targetDirectory,sealed,label:'plain restore'});
    // The restored target is a separate fresh root: never the current source.
    a.notEqual(core.norm(targetDirectory),core.norm(f.base));
    a.equal(targetDirectory.toLowerCase().startsWith(f.base.toLowerCase()+p.sep),false,'target is not nested in the source');
    // Source protected bytes and explicit diff.
    const diff=core.observeDifference(sourceBefore,dataSnapshot(f.base));
    checkpoint('plain-source-difference',diff);
    a.deepEqual(diff.removed,[],'restore never removes a source file');
    const bootTouchedNorm=new Set(bootTouched.map(core.norm));
    const normal=file=>core.norm(file)===core.norm(resultPath)||bootTouchedNorm.has(core.norm(file))||isNormalStartupArtifact(relativeTo(f.base,file));
    const unexpectedChanged=diff.changed.map(row=>row.after.file).filter(file=>!normal(file));
    a.deepEqual(unexpectedChanged,[],'restore changed an unexpected source file');
    const unexpectedAdded=diff.added.filter(file=>!normal(file));
    a.deepEqual(unexpectedAdded,[],'restore added an unexpected source file');
    for(const pin of pins)core.samePinned(core.read(p.join(f.base,...pin.relative.split('/'))).row,pin.row);
    a.deepEqual(core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).bytes,Buffer.from(SESSION_BYTES),'source session bytes are unchanged');
    const stale=await upload.makeHttp({port:next.port,token:next.token},'/api/work-data/status',undefined,{timeout:BUDGET.request}).catch(error=>isTransport(error)?null:Promise.reject(error));
    a.ok(stale&&stale.status===200);
    const retired=await upload.makeHttp({port:next.port,token:initial.token},'/api/work-data/status',undefined,{timeout:BUDGET.request}).catch(error=>isTransport(error)?null:Promise.reject(error));
    if(retired)a.equal(retired.status,403,'the retired process token no longer authorizes');
    const jobLookup=await upload.makeHttp({port:next.port,token:next.token},'/api/work-data/jobs/'+jobId,undefined,{timeout:BUDGET.request});
    a.equal(jobLookup.status,404,'the successor did not inherit warm job state');
    a.equal(jobLookup.value?.error?.code,'work_data_setup.job_not_found');
    record({kind:'round-verified',phase:'plain-restore',jobId,authority:status.authority,backup:saved.backup,state:saved.state,target:targetDirectory});
    checked('plain restore reached the same-port successor with a durable verified result, exact backup bytes and an independent fresh target');
    return {target:targetDirectory};
   }
  });
  checkpoint('plain-final-status',{authority:round.next.status.authority,lastResult:round.next.status.lastResult,capabilities:round.next.status.capabilities});
  await reclaimSuccessor('plain',round.next);
  checked('plain: the retained restore successor is reclaimed by the owned outer Job and its CIM identity is absent');
  return{fixture:f,round};
 }

 function packageHeaderPaths(snapshot){
  const paths=new Set();
  for(const file of snapshot.files){
   try{const value=JSON.parse(file.data.toString('utf8'));if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.instanceId==='string'&&typeof value.protectedKey==='string')paths.add(file.path);}catch{ }
  }
  return paths;
 }
 async function assertPlainTarget({target,sealed,label}){
  a.equal(fs.existsSync(target),true,label+': the restore target exists');
  const stat=fs.lstatSync(target,{bigint:true});
  a.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  const opened=await getRecovery().open(sealed.toString('utf8'),PACKAGE_PASSWORD);
  try{
   const snapshot=opened.snapshot;
   a.equal(snapshot.generation,0,'the plain package is a generation-zero full base');
   const tree=core.inventory(target);
   const files=new Map(tree.files.map(row=>[relativeTo(target,row.file),row]));
   const expected=new Map(snapshot.files.map(row=>[row.path,row.data]));
   a.deepEqual([...files.keys()].sort(),[...expected.keys()].sort(),label+': target files are exactly the authenticated package files');
   for(const [relative,row] of files){a.deepEqual(core.read(p.join(target,...relative.split('/'))).bytes,expected.get(relative),label+': target bytes equal the authenticated package for '+relative);}
   const directories=tree.directories.map(row=>relativeTo(target,row.file)).filter(Boolean).sort();
   a.deepEqual(directories,[...snapshot.directories].sort(),label+': target directories are exactly the package directories');
   a.equal(fs.existsSync(p.join(target,'.work-data')),false,label+': a plain restored target carries no work-data control project');
   a.equal(fs.existsSync(p.join(target,'runtime.json')),false,label+': a restored target is not a started root');
  }finally{opened.release();}
 }
 // ── journey B: real encrypted source (enable -> export -> restore) ─────────
 async function runEncryptedJourney(){
  const f=fixture('encrypted');
  const pristine=dataSnapshot(f.base);
  const port=await getFreePort('127.0.0.1');
  const handle=spawnServe(f,'encrypted-serve',port);
  await handle.spawned;healthy();
  const initial=await readyWarm(handle,f);
  const bootDiff=core.observeDifference(pristine,dataSnapshot(f.base));
  const bootTouched=[...new Set([...bootDiff.added,...bootDiff.changed.map(row=>row.after.file)])];
  checkpoint('encrypted-boot-effects',{added:bootDiff.added,changed:bootDiff.changed.map(row=>row.after.file),removed:bootDiff.removed});
  await manager.captureNativeBirths(handle);
  const ready=await waitWorkerReady(initial);
  a.deepEqual(ready.authority,AUTHORITY0);
  checked('encrypted: a real generation-zero source is serving before enable');

  ctx.phase='encrypted-enable';
  const enable=await runMaintenanceRound(f,initial,{
   phase:'encrypted-enable',operation:'enable',
   body:({source})=>({operation:'enable',password:SOURCE_PASSWORD,expectedAuthority:source,backupDirectory:f.backups}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    assertCapabilities(status,'enable successor');
    a.equal(status.job,null);
    const saved=status.lastResult;
    a.ok(saved);a.equal(saved.id,jobId);a.equal(saved.operation,'enable');a.equal(saved.state,'published');
    a.deepEqual(saved.sourceAuthority,source);
    a.equal(saved.authority.generation,source.generation+1);
    a.equal(saved.authority.mode,'encrypted');
    a.match(saved.authority.id,/^[a-f0-9]{48}$/);a.match(saved.authority.sha256,/^[a-f0-9]{64}$/);
    a.deepEqual(status.authority,saved.authority);
    a.equal(status.configMirror,true);
    const active=core.json(p.join(f.base,'.work-data','active-v1.json'));
    a.equal(active.mode,'encrypted');a.equal(active.id,saved.authority.id);a.equal(active.generation,saved.authority.generation);
    a.equal(fs.existsSync(p.join(f.base,'.work-data','generations',saved.authority.id,'work-data-key-v1.json')),true,'the encrypted source has a real generation key header');
    assertNoIntent(f,'enable');
    a.equal(custodyDirs(f).length,count+1);
    // The encrypted config mirror lives in the active generation; the top-level
    // source config is the pre-enable plain mirror and is not rewritten.
    const generationConfig=core.json(p.join(f.base,'.work-data','generations',saved.authority.id,'config.json'));
    a.equal(generationConfig.workDataEncryptionV1,true,'the active generation config mirror is encrypted');
    a.equal(core.json(p.join(f.base,'config.json')).workDataEncryptionV1,undefined,'the top-level source config is not rewritten by enable');
    a.deepEqual(core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).bytes,Buffer.from(SESSION_BYTES),'enable keeps the session bytes');
    record({kind:'round-verified',phase:'encrypted-enable',jobId,authority:saved.authority,backup:saved.backup,state:saved.state});
    checked('encrypted: a real enable round published an encrypted generation and a same-port successor');
    return{};
   }
  });
  a.equal(enable.next.status.authority.mode,'encrypted','the encrypted source authority is live on the successor');

  ctx.phase='encrypted-export';
  const exported=await runMaintenanceRound(f,enable.next,{
   phase:'encrypted-export',operation:'export',
   body:({source})=>({operation:'export',password:EXPORT_PASSWORD,expectedAuthority:source,backupDirectory:f.backups}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    assertCapabilities(status,'export successor');
    a.equal(status.job,null);
    const saved=status.lastResult;
    a.ok(saved);a.equal(saved.id,jobId);a.equal(saved.operation,'export');a.equal(saved.state,'verified');
    a.deepEqual(saved.sourceAuthority,source);a.deepEqual(saved.authority,source,'export never changes the source authority');
    a.equal(saved.authority.mode,'encrypted');
    assertNoIntent(f,'export');
    a.equal(custodyDirs(f).length,count+1);
    const backup=core.read(saved.backup.path);
    a.equal(backup.row.sha256,saved.backup.sha256);
    a.equal(getRecovery().inspectSealed(backup.bytes.toString('utf8')),true);
    const opened=await getRecovery().open(backup.bytes.toString('utf8'),EXPORT_PASSWORD);
    try{
     a.equal(opened.snapshot.generation,source.generation);
     a.ok(opened.snapshot.keys.length>=1,'the exported package carries its own masters, so a restore needs no source key owner');
     a.ok(opened.snapshot.files.some(file=>/^\.work-data\/generations\/[a-f0-9]{48}\/work-data-key-v1\.json$/.test(file.path)),'the exported package contains the encrypted generation key header');
     a.ok(opened.snapshot.auxiliaries.some(row=>row.type==='skill-backup-portable'),'the exported package carries the portable skill-backup auxiliary for its own native owner');
    }finally{opened.release();}
    record({kind:'round-verified',phase:'encrypted-export',jobId,authority:source,backup:saved.backup,state:saved.state});
    checked('encrypted: a real export produced a sealed package carrying its own masters');
    return{};
   }
  });
  const exportBackup=exported.next.status.lastResult.backup.path;
  const exportedBytes=core.read(exportBackup).bytes;
  a.ok(exportedBytes.length>1);

  ctx.phase='encrypted-upload';
  const uploadResponse=await request(exported.next,'/api/work-data/uploads',exportedBytes,{method:'POST',headers:{origin:'http://127.0.0.1:'+exported.next.port,'sec-fetch-site':'same-origin','content-type':'application/octet-stream'}});
  a.equal(uploadResponse.status,201);
  const uploadId=uploadResponse.value.uploadId;
  const custody=custodyWithUpload(f,uploadId);
  a.ok(core.read(p.join(custody.dir,'restore-upload-'+uploadId+'.sealed')).bytes.equals(exportedBytes));
  checkpoint('encrypted-custody-after-upload',{custody:custody.name,bytes:exportedBytes.length,sha256:core.H(exportedBytes)});
  checked('encrypted: the real exported package is admitted byte-for-byte under a package-only password');

  const targetDirectory=p.join(f.targets,'restored');
  const round=await runMaintenanceRound(f,exported.next,{
   phase:'encrypted-restore',operation:'restore',
   protected:['.work-data/active-v1.json','.work-data/generations/'+exported.next.status.authority.id+'/work-data-key-v1.json'],
   body:({source})=>({operation:'restore',password:EXPORT_PASSWORD,expectedAuthority:source,backupDirectory:f.backups,targetDirectory,uploadId}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    assertCapabilities(status,'encrypted restore successor');
    a.equal(status.job,null);
    a.equal(status.configMirror,true);
    a.equal(status.authority.mode,'encrypted','the source stays encrypted across a restore');
    a.deepEqual(status.authority,source);
    const {saved,resultPath}=assertRestoreResult({f,status,id:jobId,targetPath:targetDirectory,source,uploaded:exportedBytes});
    assertNoIntent(f,'encrypted restore');
    a.equal(custodyDirs(f).length,count+1);
    const handoffs=fs.readdirSync(custody.dir).filter(name=>/^handoff-[a-f0-9]{48}-[a-f0-9]{64}\.json$/.test(name));
    a.equal(handoffs.length,1);
    const handoff=JSON.parse(core.read(p.join(custody.dir,handoffs[0])).bytes);
    a.equal(handoff.jobId,jobId);a.equal(handoff.uploadId,uploadId);a.equal(handoff.sha256,core.H(exportedBytes));
    await assertEncryptedTarget({target:targetDirectory,sealed:exportedBytes,source,label:'encrypted restore'});
    // The copied runtime record is the seal-time source record, never a new boot
    // of the restored root: it must not carry the live restore successor's token
    // (pid reuse across the exited old serves is possible, the token is not).
    const targetRuntime=core.json(p.join(targetDirectory,'runtime.json'));
    const sourceRuntime=core.json(p.join(f.base,'runtime.json'));
    a.notEqual(targetRuntime.token,next.token,'the target runtime record was not minted for the restore');
    a.notEqual(targetRuntime.token,sourceRuntime.token,'the target runtime record is not the live source record');
    record({kind:'restored-target-not-started',target:targetDirectory,targetRuntimePid:targetRuntime.pid,successorPid:next.pid});
    a.notEqual(core.norm(targetDirectory),core.norm(f.base));
    a.equal(targetDirectory.toLowerCase().startsWith(f.base.toLowerCase()+p.sep),false,'target is not nested in the source');
    const diff=core.observeDifference(sourceBefore,dataSnapshot(f.base));
    checkpoint('encrypted-source-difference',diff);
    a.deepEqual(diff.removed,[],'restore never removes a source file');
    const bootTouchedNorm=new Set(bootTouched.map(core.norm));
    const normal=file=>core.norm(file)===core.norm(resultPath)||bootTouchedNorm.has(core.norm(file))||isNormalStartupArtifact(relativeTo(f.base,file));
    const unexpectedChanged=diff.changed.map(row=>row.after.file).filter(file=>!normal(file));
    a.deepEqual(unexpectedChanged,[],'restore changed an unexpected source file');
    const unexpectedAdded=diff.added.filter(file=>!normal(file));
    a.deepEqual(unexpectedAdded,[],'restore added an unexpected source file');
    for(const pin of pins)core.samePinned(core.read(p.join(f.base,...pin.relative.split('/'))).row,pin.row);
    a.deepEqual(core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).bytes,Buffer.from(SESSION_BYTES),'source session bytes are unchanged');
    const jobLookup=await upload.makeHttp({port:next.port,token:next.token},'/api/work-data/jobs/'+jobId,undefined,{timeout:BUDGET.request});
    a.equal(jobLookup.status,404);
    record({kind:'round-verified',phase:'encrypted-restore',jobId,authority:source,backup:saved.backup,state:saved.state,target:targetDirectory});
    checked('encrypted restore reused the export package only, kept the encrypted source authority, and produced an independent fresh encrypted root');
    return{};
   }
  });
  checkpoint('encrypted-final-status',{authority:round.next.status.authority,lastResult:round.next.status.lastResult,capabilities:round.next.status.capabilities});
  await reclaimSuccessor('encrypted',round.next);
  checked('encrypted: the retained restore successor is reclaimed by the owned outer Job and its CIM identity is absent');
  return{fixture:f,round,enable,exported};
 }

 async function assertEncryptedTarget({target,sealed,source,label}){
  a.equal(fs.existsSync(target),true,label+': the restore target exists');
  const stat=fs.lstatSync(target,{bigint:true});
  a.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  const opened=await getRecovery().open(sealed.toString('utf8'),EXPORT_PASSWORD);
  try{
   const snapshot=opened.snapshot;
   a.equal(snapshot.generation,source.generation);
   const headers=packageHeaderPaths(snapshot);
   a.ok(headers.size>=1,'the encrypted package has at least one key header');
   // The skill-backup native owner re-seals its own scoped files into the fresh
   // target; the product's recovery owner names that exact namespace. Everything
   // outside the key headers and that native scope must be byte-identical.
   let nativeFiles=[];
   try{nativeFiles=getRecovery().skillBackupSource(snapshot.files,snapshot.directories).files.map(row=>row.path);}catch{/* no native scope in this package */}
   const special=new Set(nativeFiles);
   const tree=core.inventory(target);
   const files=new Map(tree.files.map(row=>[relativeTo(target,row.file),row]));
   const expected=new Map(snapshot.files.map(row=>[row.path,row.data]));
   a.deepEqual([...files.keys()].sort(),[...expected.keys()].sort(),label+': target files are exactly the authenticated package files');
   const restaged=[];
   for(const [relative,row] of files){
    const bytes=core.read(p.join(target,...relative.split('/'))).bytes;
    if(headers.has(relative)){
     const before=JSON.parse(expected.get(relative).toString('utf8')),after=JSON.parse(bytes.toString('utf8'));
     a.equal(after.instanceId,before.instanceId,label+': the staged key header keeps its instance');
     a.notEqual(after.protectedKey,before.protectedKey,label+': the target key header is re-protected under fresh DPAPI, not copied from the source');
    }else if(special.has(relative)){
     a.ok(bytes.length>0,label+': the native-owned file exists in the target');
     restaged.push({path:relative,packageSha256:core.H(expected.get(relative)),targetSha256:core.H(bytes)});
    }else a.deepEqual(bytes,expected.get(relative),label+': target bytes equal the authenticated package for '+relative);
   }
   record({kind:'encrypted-native-owner-restaged',files:restaged,scope:'work-data/skill-backups and the generation skill-backup bindings from the real recovery owner'});
   const directories=tree.directories.map(row=>relativeTo(target,row.file)).filter(Boolean).sort();
   a.deepEqual(directories,[...snapshot.directories].sort(),label+': target directories are exactly the package directories');
   const active=core.json(p.join(target,'.work-data','active-v1.json'));
   a.equal(active.mode,'encrypted');a.equal(active.generation,source.generation);a.equal(active.id,source.id);
   a.equal(core.json(p.join(target,'.work-data','generations',active.id,'config.json')).workDataEncryptionV1,true,'the restored generation config mirror is encrypted');
   // A full-base package legitimately carries the source's historical runtime.json
   // (the last serve record at seal time). It is byte-identical to the package -
   // asserted in the loop above - and it is not a fresh boot of this target.
   a.equal(fs.existsSync(p.join(target,'.work-data','maintenance-v1.json')),false,label+': the restored target has no pending intent');
  }finally{opened.release();}
 }

 async function run(){
  ctx.phase='plain-journey';
  const plain=await runPlainJourney();
  ctx.phase='encrypted-journey';
  const encrypted=await runEncryptedJourney();
  return{plain,encrypted};
 }

 return{ctx,latch,healthy,record,checkpoint,checked,openJournal,close,manager,fixture,spawnServe,readyWarm,statusOf,waitWorkerReady,submitAccepted,postJob,
  claimApi,claimFile,waitClaimRecord,assertClaimGone,custodyDirs,custodyWithUpload,dataSnapshot,sourcePins,assertNoIntent,coldWindow,waitOldServeExit,
  waitSuccessor,runMaintenanceRound,reclaimSuccessor,assertPlainTarget,assertEncryptedTarget,assertRestoreResult,assertCapabilities,run,
  cimIdentity,absentByCim};
}

async function runActual(argv=process.argv.slice(2)){
 if(process.platform!=='win32'){a.equal(argv.length,0,'ROOT candidate actual requires Windows');console.log('SKIP Windows native production restore E2E');require(p.join(__dirname,'lib/harness')).createRunner('WORK DATA PRODUCTION RESTORE').done();return{skipped:true};}
 const target=targetFromArgs(argv);a.equal(Number(process.versions.node.split('.')[0]),24);
 const harness=p.join(target.repo,'dev-harness');require(p.join(harness,'lib/self-isolate-home'));
 const {releaseEnvironment}=require(p.join(harness,'lib/release-checks'));
 const {snapshotProcessTable,ownDescendants}=require(p.join(harness,'lib/kill-own-tree'));
 const {getFreePort}=require(p.join(harness,'free-port'));
 const t=require(p.join(harness,'lib/harness')).createRunner('WORK DATA PRODUCTION RESTORE');
 const temp=p.resolve(os.tmpdir()),root=fs.mkdtempSync(p.join(temp,'ruyi-production-restore-')),evidence=p.join(root,'evidence');
 a.equal(core.norm(p.dirname(root)),core.norm(temp),'fixture root is a direct child of the tool temp');fs.mkdirSync(evidence);
 // The world needs the same module instances the entry uses; the process manager
 // and fixture helpers are constructed from the pinned harness paths above.
 const world=createWorld({root,evidence,target,harness,releaseEnvironment,snapshotProcessTable,ownDescendants,getFreePort});
 world.openJournal();
 try{
  world.record({kind:'fixture-owner',root,temp,nonce:c.randomBytes(32).toString('hex'),targetServer:target.server,executionInputSha256:target.executionInputSha256,executionInputs:target.boundFiles.length,inputFiles:target.boundFiles,scope:'Synthetic production restore E2E only;not activation,not a started restored root and not complete 3.1.'});
  const outcome=await world.run();
  const inputsAfter=target.recheck();
  a.equal(inputsAfter.files,target.boundFiles.length,'recheck covers every pinned execution input');
  a.equal(inputsAfter.executionInputSha256,target.executionInputSha256,'recheck re-derives the pinned execution input digest');
  world.checkpoint('execution-inputs-after',inputsAfter);
  a.equal(world.ctx.unknown,false);a.equal(world.manager.hasUnclosed(),false);a.equal(world.manager.hasUnverifiedSpawn(),false);
  world.checkpoint('result',{schema:1,passed:world.ctx.checks.length,checks:world.ctx.checks,root,targetServer:target.server,
   executionInputSha256:inputsAfter.executionInputSha256,executionInputs:inputsAfter.files,inputProof:inputsAfter,
   plain:{authority:outcome.plain.round.next.status.authority,lastResult:outcome.plain.round.next.status.lastResult,target:outcome.plain.round.verified.target},
   encrypted:{authority:outcome.encrypted.round.next.status.authority,lastResult:outcome.encrypted.round.next.status.lastResult,enableAuthority:outcome.encrypted.enable.next.status.authority,exportBackup:outcome.encrypted.exported.next.status.lastResult.backup},
   capabilities:{worker:true,upload:true,download:false,crashClaim:false,activation:false},
   restoredActivation:'separate-fresh-root',restartRootPublished:false,currentRootIsTarget:false,
   coldVerifyEvidence:'13ak host.verifyFresh runs a separate cold node verifier child before the verified result exists. This file observes the cold listener holding the real OS source owner, the durable result bound to the actual backup, and compares the target bytes with the package authenticated by the real WorkDataRecovery owner. The verifier child receipt itself is not persisted by the product, so no fabricated verifier receipt is claimed.',
   claimEvidence:'armed: durable 13av record existence (no read handle against the product rename); committed: old serve natural exit 0 only after the go/armed handshake; owned: cold listener exists only after the owned advance and real OS source owner acquisition; cleanup: post-operation 13av inspect reports absent. Mid-flight polling was removed because on this host a read handle blocks the atomic rename with EPERM (verified standalone).',
   negativeCoverage:{e2ePreAdmission:['target exists','target nested in source','target inside backup directory','target equals source','backup in source','source in backup','unknown upload id','stale authority','missing upload id','plaintext package','invalid utf-8 package'],unitOnly:['wrong restore password','post-admission on-disk package tamper','post-owned crash recovery']},
   processEvidenceLimit:'Real serve/cold/successor lifecycle plus actual sampled CIM identity and an owned outer Job reclaiming the successor. No simulated four-process fixture is used.',
   restorationComplete:false,whole3_1Complete:false});
  for(const label of world.ctx.checks)t.ok(true,label);
  world.close();
  console.log('Retained synthetic production restore evidence '+root);
  t.done();return{passed:true,root};
 }catch(error){
  world.latch(error);
  const projected={schema:1,stage:world.ctx.phase,lastPassed:world.ctx.checks.at(-1)||null,
   code:typeof error?.code==='string'&&/^[A-Z0-9_.-]{1,80}$/i.test(error.code)?error.code:'E2E_FAILURE',
   rawMessagesAndBodiesOmitted:true,...safeFailureLocation(error),diagnostics:world.ctx.diagnostics||null};
  try{fs.writeFileSync(p.join(evidence,'failure-summary.json'),JSON.stringify(projected,null,2)+'\n',{flag:'wx'});}catch{}
  // Bounded failure: evidence is flushed, the fixture is kept for diagnosis and
  // this process ends. Nothing the product spawned is killed here.
  try{fs.writeSync(2,Buffer.from('Retained production restore fixture '+root+'; no automatic cleanup of an unknown owner. stage='+world.ctx.phase+'\n'));}catch{}
  process.exit(1);
 }
}
module.exports={targetFromArgs,createWorld,BUDGET,runActual,safeFailureLocation};
if(require.main===module)runActual().catch(error=>{try{process.stderr.write(((error&&error.message||String(error)))+String.fromCharCode(10));}catch{}process.exitCode=1;});
