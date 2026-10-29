'use strict';
// Permanent ROOT serial acceptance for the production restore path. The complete
// checked-in server is launched as-is (`serve`), the real worker/cold process and
// the real same-port successor are spawned by the product, and every observation
// is a product fact: runtime.json pid/token (source and target), the real 13av
// claim/activation API in TEMP, the cold listener's read-only HTTP, the durable
// source result, CIM identities and the started target's actual bytes.
//
// The committed restore starts the SUCCESSOR ON THE TARGET ROOT: the cold writes
// the TEMP activation receipt, spawns the successor with RUYI_HOME=target, and the
// successor proves receipt + target authority before it serves the same port. The
// source keeps its durable result/proof; the target may only carry package history
// as lastResult. Data origin is proven with a package-only session served by the
// target and absent from a separate plain serve on the source root.
//
// B3 continues after reclamation: the successor also wrote <home>/.ruyi/
// boot-root-v1.json (a strict eight-key preference, never an activation receipt).
// Two ordinary serves with RUYI_HOME/WIN_CLAUDE_WORKBENCH_HOME removed must start
// from that target through the preference, while an explicit RUYI_HOME=source
// serve still serves the source (env wins) and no ordinary start rewrites the
// preference.
//
// Journey A (plain generation-zero source): synthetic sealed package -> POST 201
// -> restore 202 -> durable armed claim -> old serve natural exit (committed) ->
// cold listener holding the real source owner (owned) -> real restore + the
// product's own cold verifyFresh child -> target successor on the same port. The
// same admitted upload is used after every pre-admission refusal, which proves
// none of them consumed its grant. Claim phases are proven by product ordering,
// never by polling the record mid-write: on this host a read handle makes the
// product's atomic rename fail with EPERM.
//
// Journey B (real encrypted source): a real `enable` round and a real `export`
// round run on a second synthetic source, then the exported encrypted package is
// uploaded and restored with the EXPORT password (different from the password
// that enabled the source). Restore never depends on the source master keys:
// it authenticates the package with its own password and stages the target key
// header under fresh DPAPI protection, which is asserted on the target bytes.
// The source session is removed through the real API after export, so the package
// session can only be served by the started target.
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
const PACKAGE_SESSION_ID='sess_restore_package_only';
const SESSION_BYTES=JSON.stringify({id:SESSION_ID,private:'完整合成恢复源，保持原字节。',title:'Synthetic restore session',cwd:'',createdAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:00.000Z',messages:[]});
const PACKAGE_SESSION_BYTES=JSON.stringify({id:PACKAGE_SESSION_ID,private:'仅存在于恢复包中的合成会话。',title:'Synthetic package-only session',cwd:'',createdAt:'2026-10-28T00:00:01.000Z',updatedAt:'2026-10-28T00:00:01.000Z',messages:[]});
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

 function spawnServe(f,label,port,{env=f.env}={}){
  healthy();openOutput(label);
  // detached deliberately (same reason as the maintenance E2E): libuv would give
  // a non-detached child a kill-on-close Job, and the product's detached cold
  // worker would inherit it and die the moment old serve exits.
  return manager.start(process.execPath,[target.server,'serve','--host','127.0.0.1','--port',String(port)],{cwd:p.dirname(target.server),env,windowsHide:true,detached:true,stdio:['ignore','pipe','pipe']},label);
 }
 // Explicit operational CLI only: the same source gate, output custody and
 // exact ChildProcess observer as serve. Callers certify the actual terminal;
 // an observation deadline never kills or counts as a successful release.
 function spawnCli(f,label,args,{env=f.env}={}){
  healthy();openOutput(label);
  return manager.start(process.execPath,[target.server,...args],{cwd:p.dirname(target.server),env,windowsHide:true,stdio:['ignore','pipe','pipe']},label);
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
 async function readyAt(handle,base){
  healthy();const deadline=Date.now()+BUDGET.startup;
  while(Date.now()<deadline){
   if(ctx.unknown)throw Error('unknown during ready');
   a.equal(manager.inspect(handle).closeSeen,false,'normal serve exited before ready');
   let rt=null;try{rt=core.json(p.join(base,'runtime.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
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
 const readyWarm=(handle,f)=>readyAt(handle,f.base);
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
 // That set is explicit and itemized; it is not a blanket "ignore anything".
 // Derived session indexes (sessions/index.json, _search-index-v1.json, the
 // fulltext namespace) are deliberately NOT in it: no real run required those
 // allowances at observation time, and a source-side index change must stay
 // visible instead of being silently swallowed. config.json and the session head
 // are separately pinned or byte-compared and never appear here.
 const generationPrefix=/^\.work-data\/generations\/[a-f0-9]{48}\//i;
 function isNormalStartupArtifact(relative){
  // After enable the live root is the active generation, so a normal boot writes
  // the same artifact names inside `.work-data/generations/<id>/`. Normalize that
  // prefix before classifying; config.json itself is never in this set.
  const stripped=relative.replace(generationPrefix,'');
  const name=stripped.toLowerCase();
  if(['runtime.json','config.json.prev','claude-settings-sync.json','install-registry.json','mcp-host-v1.json'].includes(name))return true;
  if(name==='sessions/.pretender'||name.startsWith('sessions/.pretender/'))return true;
  return /^(?:logs|generated|uploads|usage|checkpoints|agent-runs|memory)\//.test(name);
 }
 function isStartupDirectory(relative){
  const stripped=relative.replace(generationPrefix,'').toLowerCase();
  if(stripped==='sessions/.pretender'||stripped.startsWith('sessions/.pretender/'))return true;
  return /^(?:logs|generated|uploads|usage|checkpoints|agent-runs|agent-workflows|agent-worktrees|memory|playbooks|skills|webcache)(?:\/|$)/.test(stripped);
 }
 const sameAuthority=(left,right)=>!!left&&!!right&&left.generation===right.generation&&left.id===right.id&&left.mode===right.mode&&left.sha256===right.sha256;

 function assertCapabilities(value,label,download=value.lastResult!==null){
  // Package transfer is advertised only by an installed warm runtime that has a
  // current result; a restore target has none.
  a.deepEqual(value.capabilities,{worker:true,upload:true,download},label+': only the real worker, upload and a current package are advertised');
  a.equal(Object.hasOwn(value.capabilities,'crashClaim'),false);
  a.equal(Object.hasOwn(value.capabilities,'activation'),false);
  a.equal(value.processRestartRequired,true);
 }
 // The restore result is the SOURCE's durable record. The target's status may
 // only carry package history and is never used as this job's activation proof.
 function assertRestoreResult({f,id,targetPath,source,uploaded}){
  const resultPath=p.join(f.base,'.work-data','maintenance-result-v1.json');
  const file=core.read(resultPath),row=file.row;
  // The real 01ae owner runs in the pinned vm context, so its objects carry the
  // context's prototypes. Normalize to host objects before strict comparisons.
  const saved=JSON.parse(JSON.stringify(getResultOwner().decode(file.bytes)));
  a.equal(saved.schema,1);a.equal(saved.id,id);a.equal(saved.operation,'restore');a.equal(saved.state,'verified');
  a.deepEqual(saved.sourceAuthority,source,'restore keeps the source authority it was admitted against');
  a.deepEqual(saved.authority,source,'a restore publishes no new source generation');
  a.deepEqual(Object.keys(saved).sort(),['authority','backup','finishedAt','id','operation','restored','schema','sourceAuthority','state'],'the durable restore record has exactly its nine fields');
  for(const forbidden of ['restartRoot','publication','activationTarget'])a.equal(Object.hasOwn(saved,forbidden),false,'restore result carries no '+forbidden+' field');
  a.deepEqual(saved.restored,{activation:'separate-fresh-root',target:p.resolve(targetPath)});
  const expectedBackup=p.join(f.backups,'ruyi-work-data-'+id+'.ruyi-backup');
  a.equal(saved.backup.path,expectedBackup);
  a.equal(saved.backup.bytes,uploaded.length);
  a.equal(saved.backup.sha256,core.H(uploaded));
  const backup=core.read(expectedBackup);
  a.ok(backup.bytes.equals(uploaded),'backup bytes are byte-for-byte the uploaded package');
  a.equal(backup.row.dev,saved.backup.identity.dev);a.equal(backup.row.ino,saved.backup.identity.ino);
  a.equal(getRecovery().inspectSealed(backup.bytes.toString('utf8')),true);
  a.match(row.sha256,/^[a-f0-9]{64}$/);
  return {saved,row,resultPath,backupPath:expectedBackup};
 }
 // The target authority is verified against the real active manifest and its
 // proof hash, not against a status field alone. Generation zero has no pointer.
 function assertTargetAuthority({target,authority,label}){
  const control=p.join(target,'.work-data'),active=p.join(control,'active-v1.json');
  if(authority.generation===0){
   a.equal(authority.id,null,label+': generation zero has no id');
   a.equal(authority.sha256,null,label+': generation zero has no proof hash');
   a.equal(authority.mode,'plain',label+': generation zero is plain');
   a.equal(fs.existsSync(active),false,label+': generation zero has no active pointer');
   a.notEqual(core.json(p.join(target,'config.json')).workDataEncryptionV1,true,label+': the target config mirror is plain');
   return;
  }
  a.ok(fs.existsSync(active),label+': the target active pointer exists');
  const raw=core.read(active).bytes,state=JSON.parse(raw);
  a.equal(state.schema,1);a.equal(state.generation,authority.generation);a.equal(state.id,authority.id);a.equal(state.mode,authority.mode);
  a.equal(state.activeRoot,'generations/'+state.id);
  a.equal(core.H(raw),authority.sha256,label+': authority sha is the real active pointer proof');
  const generation=p.join(control,'generations',state.id);
  a.ok(fs.statSync(generation).isDirectory(),label+': the active generation directory exists');
  if(state.mode==='encrypted'){
   const header=p.join(generation,'work-data-key-v1.json');
   a.ok(fs.existsSync(header),label+': the encrypted active generation has a key header');
   a.match(core.json(header).instanceId,/^[a-f0-9]{32}$/);
  }
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
 function assertTargetControl(target,label){
  const control=p.join(target,'.work-data');
  a.equal(fs.existsSync(p.join(control,'maintenance-v1.json')),false,label+': the started target has no pending intent');
  if(!fs.existsSync(control))return;
  const names=fs.readdirSync(control).sort();
  a.deepEqual(names.filter(name=>/^\.maintenance-v1\.stage-|^\.maintenance-result-v1\.stage-|^\.activation-v1\.stage-/.test(name)),[],label+': no staged control file in the target');
  const allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
  for(const name of names)a.equal(allowed.has(name),true,label+': unexpected target control entry '+name);
 }
 async function sessionIds(ref){
  const response=await request(ref,'/api/sessions');
  a.equal(response.status,200,'GET /api/sessions succeeds');
  a.equal(response.value?.ok,true);
  a.ok(Array.isArray(response.value.sessions),'GET /api/sessions returns a session array');
  return response.value.sessions.map(session=>session&&session.id).filter(id=>typeof id==='string');
 }
 async function deleteSourceSession(ref,id){
  const response=await request(ref,'/api/sessions/'+encodeURIComponent(id),undefined,{method:'DELETE'});
  a.equal(response.status,200,'DELETE /api/sessions/'+id+' succeeds');
  a.equal(response.value?.ok,true);
  return response.value;
 }
 function activationRootPath(f,canonical){
  const digest=c.createHash('sha256').update(Buffer.from(canonical,'utf8')).digest('hex');
  return p.join(f.temp,'ruyi-work-data-activation-'+digest);
 }
 async function waitActivationGone(f,target,budget=25000){
  const canonical=await getOwnership().canonicalRoot(target),file=p.join(activationRootPath(f,canonical),'activation-v1.json');
  const deadline=Date.now()+budget;
  while(Date.now()<deadline){
   // existsSync uses attributes only (no read handle), so it cannot block the
   // successor's CAS removal of the receipt.
   if(!fs.existsSync(file))return {canonical,file};
   await sleep(25);
  }
  throw Error('activation receipt was never consumed');
 }
 async function assertActivationAbsent(f,target,label){
  const canonical=await getOwnership().canonicalRoot(target),root=activationRootPath(f,canonical);
  const found=await claimApi(f.temp).activation.inspect({base:canonical});
  a.equal(found.present,false,label+': the TEMP activation receipt was consumed');
  if(fs.existsSync(root))a.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.activation-v1.stage-')),[],label+': no staged activation receipt survives');
 }
 function coldChildrenOf(ref){
  const table=snapshotProcessTable();
  if(!Array.isArray(table)){latch(Error('actual CIM snapshot unavailable'));throw Error('actual CIM snapshot unavailable');}
  return table.filter(row=>row.ppid===ref.pid&&row.name!=='conhost.exe').map(row=>({pid:row.pid,created:String(row.created),name:row.name}));
 }
 async function assertOwnerFree(f,label){
  const lease=await getOwnership().acquire([await canonicalBase(f)]);
  a.ok(lease,label+': the source OS owner is released');
  await lease.release();
 }
 async function assertOwnerHeld(target,label){
  let held=false;
  try{
   const lease=await getOwnership().acquire([await getOwnership().canonicalRoot(target)]);
   await lease.release();
  }catch(error){
   held=/DATA_ROOT_IN_USE/.test(String(error?.code||''))||/DATA_ROOT_IN_USE/.test(String(error?.message||''));
   if(!held)throw error;
  }
  a.equal(held,true,label+': the target successor holds the real OS owner');
 }
 async function assertTargetOwnerFree(target,label){
  const lease=await getOwnership().acquire([await getOwnership().canonicalRoot(target)]);
  a.ok(lease,label+': the target OS owner is free');
  await lease.release();
 }
 const bootRootPreferenceFile=f=>p.join(f.home,'.ruyi','boot-root-v1.json');
 const bootRootPreferenceKeys='authority,base,baseIdentity,createdAt,kind,resultId,resultSha256,schema';
 // A stale preference from an earlier run would make the post-ready read look like
 // this activation's evidence. Prove the file is absent (and no stage is pending)
 // immediately before the restore is submitted; the later record must also carry
 // resultId/resultSha256 of this job and a createdAt not older than this check.
 function assertBootRootPreferenceAbsent(f,label){
  const file=bootRootPreferenceFile(f),directory=p.dirname(file);
  let dirStat=null;try{dirStat=fs.lstatSync(directory,{bigint:true});}catch{}
  if(dirStat){
   a.ok(dirStat.isDirectory()&&!dirStat.isSymbolicLink(),label+': <home>/.ruyi is a real directory');
   a.deepEqual(fs.readdirSync(directory).filter(name=>name==='boot-root-v1.json'||name.startsWith('.boot-root-v1.stage-')),[],label+': no stale boot preference or pending stage');
  }
  a.equal(fs.existsSync(file),false,label+': no boot-root preference exists before the restore submit');
  const at=Date.now();
  checkpoint('boot-root-preference-absent-'+label,{file,directory,dirExists:Boolean(dirStat),at:new Date(at).toISOString()});
  record({kind:'boot-root-preference-absent',label,file,directory,dirExists:Boolean(dirStat),at:new Date(at).toISOString()});
  return {file,at};
 }
 // The long-lived boot preference is product state, not an activation receipt:
 // eight keys, canonical target outside both roots, exact target identity and
 // authority, and the SOURCE result proof this restore committed.
 async function readBootRootPreference({f,target,authority,resultId,resultSha256,name,notBefore=0}){
  const file=bootRootPreferenceFile(f),deadline=Date.now()+25000;
  while(Date.now()<deadline){
   // existsSync holds no handle, so it cannot block the product's atomic rename.
   if(fs.existsSync(file))break;
   await sleep(25);
  }
  a.equal(fs.existsSync(file),true,name+': the boot-root preference was written');
  const directory=p.dirname(file),dirStat=fs.lstatSync(directory,{bigint:true});
  a.ok(dirStat.isDirectory()&&!dirStat.isSymbolicLink(),name+': .ruyi is a real directory');
  const captured=core.read(file),value=JSON.parse(captured.bytes);
  a.equal(Object.keys(value).sort().join(','),bootRootPreferenceKeys,name+': the preference has exactly its eight fields');
  a.equal(value.schema,1);a.equal(value.kind,'restored-boot-root');
  for(const forbidden of ['activation','nonce','parentPid'])a.equal(Object.hasOwn(value,forbidden),false,name+': the preference is not an activation receipt');
  const canonicalTarget=await getOwnership().canonicalRoot(target);
  a.equal(value.base,canonicalTarget,name+': the preference names the canonical target');
  a.ok(p.isAbsolute(value.base)&&p.resolve(value.base)===value.base);
  a.deepEqual(Object.keys(value.baseIdentity).sort(),['dev','ino']);
  const targetStat=fs.lstatSync(target,{bigint:true});
  a.equal(value.baseIdentity.dev,String(targetStat.dev),name+': preference target dev matches');
  a.equal(value.baseIdentity.ino,String(targetStat.ino),name+': preference target ino matches');
  a.deepEqual(value.authority,authority,name+': preference authority is the target authority');
  a.equal(value.resultId,resultId,name+': preference resultId is this restore job');
  a.equal(value.resultSha256,resultSha256,name+': preference resultSha256 is the source result proof');
  a.equal(value.createdAt,new Date(value.createdAt).toISOString(),name+': preference createdAt is a strict stamp');
  const created=Date.parse(value.createdAt);
  a.ok(created<=Date.now()&&created>=Date.now()-30*60*1000,name+': preference createdAt is a plausible real timestamp');
  a.ok(created>=notBefore,name+': preference createdAt is not older than the pre-restore absence check');
  const inside=(root,filePath)=>{const rel=p.relative(core.norm(root),core.norm(filePath));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  a.equal(inside(f.base,file),false,name+': the preference is outside the source base');
  a.equal(inside(target,file),false,name+': the preference is outside the target base');
  a.equal(core.norm(p.dirname(file)),core.norm(p.join(f.home,'.ruyi')),name+': the preference lives in <home>/.ruyi');
  checkpoint('boot-root-preference-'+name,{file,sha256:captured.row.sha256,bytes:captured.row.bytes,dev:captured.row.dev,ino:captured.row.ino,
   base:value.base,baseIdentity:value.baseIdentity,authority:value.authority,resultId:value.resultId,resultSha256:value.resultSha256,createdAt:value.createdAt});
  record({kind:'boot-root-preference',name,file,sha256:captured.row.sha256,base:value.base,baseIdentity:value.baseIdentity,authority:value.authority,resultId:value.resultId,resultSha256:value.resultSha256,createdAt:value.createdAt});
  return {file,row:captured.row,value};
 }
 function envWithoutRoot(f){
  const env={...f.env};
  for(const key of Object.keys(env)){const upper=key.toUpperCase();if(upper==='RUYI_HOME'||upper==='WIN_CLAUDE_WORKBENCH_HOME')delete env[key];}
  return env;
 }
 // An ordinary serve with NO explicit root env must resolve the target through
 // <home>/.ruyi/boot-root-v1.json. The proof is the target runtime/status, the
 // target-only session set and the unchanged preference bytes - not a field claim.
 async function runPreferenceBoot({f,label,target,expectedAuthority,jobId,expectPresent,expectAbsent,preference}){
  ctx.phase=label;
  const env=envWithoutRoot(f);
  a.equal(Object.keys(env).some(key=>/^(?:RUYI_HOME|WIN_CLAUDE_WORKBENCH_HOME)$/i.test(key)),false,label+': no explicit root env');
  a.equal(env.HOME,f.env.HOME,label+': HOME stays isolated');
  a.equal(env.USERPROFILE,f.env.USERPROFILE,label+': USERPROFILE stays isolated');
  a.equal(env.TEMP,f.env.TEMP,label+': TEMP stays isolated');
  const sourceRuntimeBefore=core.read(p.join(f.base,'runtime.json')).row;
  const preferenceBefore=core.read(preference.file).row;
  await assertTargetOwnerFree(target,label);
  await assertActivationAbsent(f,target,label+'-pre-start');
  const custodyBefore=custodyDirs(f).length;
  const port=await getFreePort('127.0.0.1');
  const sourceRuntimePort=core.json(p.join(f.base,'runtime.json')).port;
  const handle=spawnServe(f,label+'-serve',port,{env});
  await handle.spawned;healthy();
  const ref=await readyAt(handle,target);
  await manager.captureNativeBirths(handle);
  const status=await waitWorkerReady(ref);
  assertCapabilities(status,label);
  a.equal(status.job,null,label+': the preference-boot serve has no job');
  a.deepEqual(status.authority,expectedAuthority,label+': the preference-boot serve publishes the target authority');
  const runtime=core.json(p.join(target,'runtime.json'));
  a.equal(runtime.pid,manager.pid(handle),label+': the target runtime names this owned serve pid');
  a.equal(runtime.token,ref.token,label+': the target runtime names this owned serve token');
  a.equal(runtime.port,port,label+': the target runtime keeps the new port');
  a.equal(runtime.host,'127.0.0.1');
  a.notEqual(runtime.port,sourceRuntimePort,label+': the target runtime is not the old source record');
  core.samePinned(core.read(p.join(f.base,'runtime.json')).row,sourceRuntimeBefore);
  // The child owns the target root and not the source root: a real ownership probe.
  await assertOwnerHeld(target,label+'-target-owner');
  await assertOwnerFree(f,label+'-source-owner');
  const ids=await sessionIds(ref);
  for(const id of expectPresent)a.ok(ids.includes(id),label+': the target session is served ('+id+')');
  for(const id of expectAbsent)a.equal(ids.includes(id),false,label+': the source-only session is absent from the target boot ('+id+')');
  core.samePinned(core.read(preference.file).row,preferenceBefore);
  a.ok(!status.lastResult||status.lastResult.id!==jobId,label+': the target lastResult is not this restore job');
  a.equal(custodyDirs(f).length,custodyBefore+1,label+': one fresh custody root for the ordinary serve');
  await assertActivationAbsent(f,target,label+'-post-ready');
  await manager.cleanupKnown(handle,async()=>{healthy();});
  healthy();
  core.samePinned(core.read(preference.file).row,preferenceBefore);
  core.samePinned(core.read(p.join(f.base,'runtime.json')).row,sourceRuntimeBefore);
  checkpoint(label+'-summary',{port,pid:runtime.pid,authority:status.authority,sessions:ids,lastResultId:status.lastResult?.id||null,preferenceSha256:preferenceBefore.sha256});
  record({kind:'preference-boot',label,port,pid:runtime.pid,authority:status.authority,sessions:ids,lastResultId:status.lastResult?.id||null,preferenceSha256:preferenceBefore.sha256});
  return {port,status,sessions:ids,runtime:{pid:runtime.pid,port:runtime.port},preferenceSha256:preferenceBefore.sha256};
 }
 function walkTargetNames(target){
  const files=[],directories=[];
  (function walk(dir){
   for(const name of fs.readdirSync(dir).sort()){
    const file=p.join(dir,name),stat=fs.lstatSync(file);
    if(stat.isDirectory()){a.ok(!stat.isSymbolicLink(),'target directory alias '+file);directories.push(file);walk(file);}
    else{a.ok(stat.isFile()&&!stat.isSymbolicLink(),'target file type '+file);files.push(file);}
   }
  })(target);
  return {files,directories};
 }
 // Session index writes are debounced. The post-export sentinel creation/deletion
 // must be a pre-restore source action, so wait (bounded) for the index stamp to
 // stop changing before the restore round snapshots the source.
 async function waitSourceSessionIndexQuiet(f,generationId,budget=6000){
  const file=p.join(f.base,'.work-data','generations',generationId,'sessions','index.json');
  const stamp=()=>{try{const stat=fs.statSync(file,{bigint:true});return String(stat.size)+':'+String(stat.mtimeNs);}catch{return 'absent';}};
  let last=stamp(),stableSince=Date.now();const deadline=Date.now()+budget;
  while(Date.now()<deadline){
   await sleep(100);
   const now=stamp();
   if(now!==last){last=now;stableSince=Date.now();}
   else if(Date.now()-stableSince>=400)return {settled:true,stamp:now};
  }
  return {settled:false,stamp:last};
 }
 // The target is now the started live root: package bytes are preserved (key
 // headers re-protected, native-owner scope re-sealed), a normal-boot allowlist
 // covers its own runtime artifacts, and nothing else may appear.
 async function assertStartedTarget({target,sealed,password,label,successor,encrypted}){
  a.equal(fs.existsSync(target),true,label+': the restore target exists');
  const stat=fs.lstatSync(target,{bigint:true});
  a.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  const opened=await getRecovery().open(sealed.toString('utf8'),password);
  try{
   const snapshot=opened.snapshot;
   if(encrypted)a.equal(snapshot.generation,successor.status.authority.generation,label+': the package generation is the target authority generation');
   else a.equal(snapshot.generation,0,label+': the plain package is a generation-zero full base');
   const headers=packageHeaderPaths(snapshot);
   if(encrypted)a.ok(headers.size>=1,label+': the encrypted package has at least one key header');
   let nativeFiles=[];
   try{nativeFiles=getRecovery().skillBackupSource(snapshot.files,snapshot.directories).files.map(row=>row.path);}catch{/* no native scope in this package */}
   const native=new Set(nativeFiles);
   const pkg=new Map(snapshot.files.map(file=>[file.path,file.data]));
   const pkgDirs=new Set(snapshot.directories);
   const {files,directories}=walkTargetNames(target);
   const startup=[],restaged=[],seenPackage=new Set();
   for(const file of files){
    const relative=relativeTo(target,file),name=relative.toLowerCase();
    if(/(?:^|\/)(?:activation-v1\.json|\.activation-v1\.stage-|\.maintenance-v1\.stage-|\.maintenance-result-v1\.stage-)/.test(name))a.fail(label+': forbidden control/activation artifact '+relative);
    if(relative==='runtime.json'){
     const runtime=core.json(file);
     a.equal(runtime.pid,successor.pid,label+': runtime.json names the current successor pid');
     a.equal(runtime.token,successor.token,label+': runtime.json names the current successor token');
     a.equal(runtime.port,successor.port,label+': runtime.json keeps the same port');
     a.equal(runtime.host,'127.0.0.1');
     if(pkg.has('runtime.json')){
      seenPackage.add('runtime.json');
      const historical=JSON.parse(pkg.get('runtime.json').toString('utf8'));
      a.notEqual(runtime.token,historical.token,label+': the started runtime record replaced the package history');
     }
     continue;
    }
    if(pkg.has(relative)){
     seenPackage.add(relative);
     const bytes=core.read(file).bytes;
     if(headers.has(relative)){
      const before=JSON.parse(pkg.get(relative).toString('utf8')),after=JSON.parse(bytes.toString('utf8'));
      a.equal(after.instanceId,before.instanceId,label+': the staged key header keeps its instance');
      a.notEqual(after.protectedKey,before.protectedKey,label+': the target key header is re-protected under fresh DPAPI');
      restaged.push({path:relative,packageSha256:core.H(pkg.get(relative)),targetSha256:core.H(bytes)});
     }else if(native.has(relative)){
      a.ok(bytes.length>0,label+': the native-owned file exists in the target');
      restaged.push({path:relative,packageSha256:core.H(pkg.get(relative)),targetSha256:core.H(bytes)});
     }else if(isNormalStartupArtifact(relative)){
      // The package itself can carry an older copy of a normal-boot artifact
      // (logs, generated MCP config, install registry, projection index); the
      // boot replacing it is expected and recorded, never byte-compared.
      startup.push(relative);
     }else a.deepEqual(bytes,pkg.get(relative),label+': target bytes equal the authenticated package for '+relative);
     continue;
    }
    if(isNormalStartupArtifact(relative)){startup.push(relative);continue;}
    a.fail(label+': unknown file in the started target '+relative);
   }
   for(const relative of pkg.keys())a.ok(seenPackage.has(relative),label+': package file missing from the target '+relative);
   for(const directory of directories){
    const relative=relativeTo(target,directory);
    if(pkgDirs.has(relative)||isStartupDirectory(relative))continue;
    a.fail(label+': unknown directory in the started target '+relative);
   }
   for(const directory of snapshot.directories)a.ok(fs.lstatSync(p.join(target,...directory.split('/'))).isDirectory(),label+': package directory missing '+directory);
   assertTargetControl(target,label);
   if(encrypted){
    const active=core.json(p.join(target,'.work-data','active-v1.json'));
    a.equal(active.mode,'encrypted');
    a.equal(core.json(p.join(target,'.work-data','generations',active.id,'config.json')).workDataEncryptionV1,true,label+': the started generation config mirror is encrypted');
   }
   record({kind:'started-target',label,startupFiles:startup,restaged,packageFiles:pkg.size,packageDirectories:pkgDirs.size});
   return {startup,restaged,packagePaths:[...pkg.keys()]};
  }finally{opened.release();}
 }
 function targetStableState(target,packagePaths){
  return {runtime:core.read(p.join(target,'runtime.json')).row,
   package:packagePaths.map(relative=>({relative,row:core.read(p.join(target,...relative.split('/'))).row}))};
 }
 function assertStableStateUnchanged(before,after,label){
  a.equal(after.runtime.sha256,before.runtime.sha256,label+': target runtime bytes unchanged');
  a.equal(after.runtime.dev,before.runtime.dev);a.equal(after.runtime.ino,before.runtime.ino);
  a.deepEqual(after.package.map(row=>({relative:row.relative,sha256:row.row.sha256,bytes:row.row.bytes,dev:row.row.dev,ino:row.row.ino})),
   before.package.map(row=>({relative:row.relative,sha256:row.row.sha256,bytes:row.row.bytes,dev:row.row.dev,ino:row.row.ino})),label+': target package bytes unchanged');
 }
 // A plain serve on the SOURCE root, on a different port, must report the source
 // authority and must not see the package-only session. It also must not touch the
 // started target. This is the data-origin proof, not a runtime field claim.
 async function runSourceServeCheck({f,target,targetRef,packagePaths,expectedAuthority,jobId,expectPresent,expectAbsent,label}){
  ctx.phase=label+'-source-serve';
  const targetStatusBefore=await statusOf(targetRef);
  const stableBefore=targetStableState(target,packagePaths);
  const custodyBefore=custodyDirs(f).length;
  const port=await getFreePort('127.0.0.1');
  a.notEqual(port,targetRef.port,label+': the source serve uses a different port from the started target');
  const handle=spawnServe(f,label+'-source-serve',port);
  await handle.spawned;healthy();
  const ref=await readyWarm(handle,f);
  await manager.captureNativeBirths(handle);
  const status=await waitWorkerReady(ref);
  a.deepEqual(status.authority,expectedAuthority,label+': the plain source serve reports the source authority');
  a.equal(status.job,null,label+': the source serve has no inherited job');
  const ids=await sessionIds(ref);
  for(const id of expectPresent)a.ok(ids.includes(id),label+': the source serve still lists '+id);
  for(const id of expectAbsent)a.equal(ids.includes(id),false,label+': the package-only session is absent from the source serve ('+id+')');
  a.equal(status.lastResult?.id,jobId,label+': the normal source serve reads this restore result');
  a.equal(status.lastResult?.operation,'restore');
  a.equal(status.lastResult?.state,'verified');
  a.deepEqual(status.lastResult?.sourceAuthority,status.authority);
  a.deepEqual(status.lastResult?.authority,status.authority);
  a.equal(custodyDirs(f).length,custodyBefore+1,label+': the source serve allocates one custody root');
  // The target stays the same started process and the same package bytes.
  const targetStatusAfter=await statusOf(targetRef);
  a.equal(targetStatusAfter.job,null);
  a.deepEqual(targetStatusAfter.authority,targetStatusBefore.authority,label+': the target authority is unchanged by the source serve');
  a.equal(targetStatusAfter.lastResult?.id,targetStatusBefore.lastResult?.id,label+': the target historical result is unchanged');
  const stableAfter=targetStableState(target,packagePaths);
  assertStableStateUnchanged(stableBefore,stableAfter,label);
  await manager.cleanupKnown(handle,async()=>{healthy();});
  healthy();
  checkpoint('source-serve-'+label,{authority:status.authority,sessions:ids,lastResultId:status.lastResult?.id,lastResultOperation:status.lastResult?.operation,targetAuthority:targetStatusAfter.authority,port});
  return {status,ids,targetStatus:targetStatusAfter};
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
 async function waitSuccessor(ref,f,{homeBase=f.base,jobId,expectedAuthority=null,requireResultId=null,forbidResultId=null,notPids=[]}){
  const deadline=Date.now()+BUDGET.successor;
  for(;;){
   const rt=(()=>{try{return JSON.parse(fs.readFileSync(p.join(homeBase,'runtime.json'),'utf8'));}catch{return null;}})();
   if(rt&&Number.isInteger(rt.pid)&&rt.pid!==ref.pid&&!notPids.includes(rt.pid)&&rt.port===ref.port&&rt.token!==ref.token){
    const probe=await probePort(ref.port);
    if(probe.kind==='warm'){
     let st=null;
     try{st=await upload.makeHttp({port:rt.port,token:rt.token},'/api/work-data/status',undefined,{timeout:5000});}catch(error){if(!isTransport(error))throw error;}
     const ready=st&&st.status===200&&st.value?.capabilities?.worker===true&&st.value.job===null;
     const matched=ready&&(requireResultId===null||st.value.lastResult?.id===requireResultId)&&(expectedAuthority===null||sameAuthority(st.value.authority,expectedAuthority));
     if(matched){
      if(forbidResultId&&st.value.lastResult?.id===forbidResultId)throw Error('the successor inherited this job result on the fresh root');
      const identity=await cimIdentity(rt.pid);
      a.notEqual(rt.pid,ref.pid,'successor is a new process');
      a.notEqual(rt.token,ref.token,'successor publishes a new runtime token');
      a.equal(rt.port,ref.port,'successor keeps the old port');
      a.equal(rt.host,'127.0.0.1');
      a.equal(identity.pid,rt.pid);
      return{pid:rt.pid,port:rt.port,token:rt.token,host:rt.host,handle:null,identity,status:st.value,runtime:rt};
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
 // same-port successor -> verified result -> claim removed. For a restore the
 // successor serves the committed target root on the same port; every other
 // operation keeps serving the source root.
 async function runMaintenanceRound(f,ref,spec){
  const before=await statusOf(ref);assertCapabilities(before,'round');
  a.equal(before.job,null,'a new round starts with no inherited job');
  const source=before.authority;
  const sourceBefore=dataSnapshot(f.base);
  const pins=sourcePins(f,spec.protected||[]);
  a.equal(fs.existsSync(claimFile(f)),false,'a new round starts with no durable handoff claim');
  ctx.phase=spec.phase+'-submit';
  // An independent browser acceptance can supply its real UI submission. The
  // original plain/encrypted HTTP journeys keep the exact existing default.
  const submit=spec.submit===undefined?submitAccepted:spec.submit;
  a.equal(typeof submit,'function','maintenance submission adapter must be a function');
  const jobId=await submit(ref,spec.body({source}));
  a.match(jobId,/^[a-f0-9]{48}$/,'the real submission must return its accepted job id');
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
  const children=coldChildrenOf(ref);
  const nodeChildren=children.filter(row=>row.name==='node.exe');
  a.equal(nodeChildren.length,1,spec.phase+': the old serve has exactly one node child (the cold)');
  const coldChild=nodeChildren[0];
  record({kind:'cold-child-identity',phase:spec.phase,children,coldChild});
  ctx.phase=spec.phase+'-cold';
  const cold=await coldWindow(ref.port,{base:f.base,jobId,source,staleToken:ref.token,operation:spec.operation});
  // The cold listener exists only after `owned` was advanced and the real OS
  // source owner was acquired (13ai), so this is the owned proof.
  record({kind:'cold-status',phase:spec.phase,jobId,jobState:cold.job.state,authority:cold.authority,ownedProof:'cold-listener-with-real-source-owner'});
  ctx.diagnostics={jobId,operation:spec.operation,claimEvidence:{armedRecord:true,committedBy:'old-serve-exit-0',ownedBy:'cold-listener'},coldChild};
  ctx.phase=spec.phase+'-successor';
  const restoreTarget=spec.targetDirectory||null;
  const next=await waitSuccessor(ref,f,{homeBase:restoreTarget||f.base,jobId,
   expectedAuthority:restoreTarget?source:null,requireResultId:restoreTarget?null:jobId,forbidResultId:restoreTarget?jobId:null,
   notPids:[ref.pid,coldChild.pid]});
  a.notEqual(next.pid,coldChild.pid,'successor is not the cold process');
  a.equal(next.identity.ppid,coldChild.pid,'the successor is spawned by the observed cold process');
  a.equal(await absentByCim({pid:coldChild.pid,created:coldChild.created}),true,'the cold process ends after handing over');
  record({kind:'claim-timeline',phase:spec.phase,jobId,committedProofAt:exited.closedAt,ownedProofAt:Date.now(),successorAt:Date.now()});
  ctx.phase=spec.phase+'-verify';
  const verified=await spec.verify({next,status:next.status,jobId,source,sourceBefore,pins,custodyBefore,coldChild});
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
  // The package is a synthetic full base. Its config is the source's normalized
  // config (a real export captures the normalized bytes) and its session exists
  // only in the package, so only the started target may serve it.
  const normalizedConfig=core.read(p.join(f.base,'config.json')).bytes;
  const sealed=Buffer.from(await getRecovery().seal({appVersion:'3.0.1',generation:0,createdAt:'2026-10-28T00:00:00.000Z',directories:['sessions'],
   keys:[],files:[{path:'config.json',data:normalizedConfig,keyRefs:[]},{path:'sessions/'+PACKAGE_SESSION_ID+'.json',data:Buffer.from(PACKAGE_SESSION_BYTES),keyRefs:[]}],auxiliaries:[]},PACKAGE_PASSWORD));
  healthy();
  a.equal(getRecovery().inspectSealed(sealed.toString('utf8')),true);
  checkpoint('plain-package',{bytes:sealed.length,sha256:core.H(sealed),sealed:true,configSha256:core.H(normalizedConfig),session:PACKAGE_SESSION_ID});
  checked('plain: the synthetic package is sealed by the real WorkDataRecovery owner with a package-only session');

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
  // No stale long-lived preference may exist before this restore commits: the
  // post-ready record must be written by THIS activation, not inherited.
  const preRestorePreference=assertBootRootPreferenceAbsent(f,'plain');

  const targetDirectory=p.join(f.targets,'restored');
  const round=await runMaintenanceRound(f,initial,{
   phase:'plain-restore',operation:'restore',targetDirectory,
   body:({source})=>({operation:'restore',password:PACKAGE_PASSWORD,expectedAuthority:source,backupDirectory:f.backups,targetDirectory,uploadId}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    assertCapabilities(status,'plain restore successor',false);
    a.equal(status.job,null,'a new process never inherits the restore job');
    a.equal(status.configMirror,false,'the target mirror stays plain');
    a.deepEqual(status.authority,AUTHORITY0,'a restore keeps the plain generation-zero authority');
    assertTargetAuthority({target:targetDirectory,authority:status.authority,label:'plain target'});
    const result=assertRestoreResult({f,id:jobId,targetPath:targetDirectory,source,uploaded:sealed});
    assertNoIntent(f,'plain restore');
    const targetClaim=await claimApi(f.temp).inspect({base:await getOwnership().canonicalRoot(targetDirectory)});
    a.equal(targetClaim.present,false,'the started target has no handoff claim of its own');
    // The successor writes the long-lived preference after serve-ready, before it
    // consumes the TEMP activation receipt. Both facts are observed here.
    const preference=await readBootRootPreference({f,target:targetDirectory,authority:status.authority,resultId:jobId,resultSha256:result.row.sha256,name:'plain',notBefore:preRestorePreference.at});
    await waitActivationGone(f,targetDirectory);
    await assertActivationAbsent(f,targetDirectory,'plain restore');
    const started=await assertStartedTarget({target:targetDirectory,sealed,password:PACKAGE_PASSWORD,label:'plain restore',successor:next,encrypted:false});
    const targetSessions=await sessionIds(next);
    a.ok(targetSessions.includes(PACKAGE_SESSION_ID),'the package-only session is served by the started target');
    a.equal(targetSessions.includes(SESSION_ID),false,'the target is not serving the source session set');
    a.equal(status.lastResult,null,'the plain target carries no job result of its own');
    a.equal(fs.existsSync(result.backupPath),true);
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
    // The served root is the committed target: the real target owner is held by
    // the successor and the source owner is released.
    await assertOwnerHeld(targetDirectory,'plain restore');
    await assertOwnerFree(f,'plain restore');
    // The restored target is a separate fresh root: never the current source.
    a.notEqual(core.norm(targetDirectory),core.norm(f.base));
    a.equal(targetDirectory.toLowerCase().startsWith(f.base.toLowerCase()+p.sep),false,'target is not nested in the source');
    // Source protected bytes and explicit diff.
    const diff=core.observeDifference(sourceBefore,dataSnapshot(f.base));
    checkpoint('plain-source-difference',diff);
    a.deepEqual(diff.removed,[],'restore never removes a source file');
    const bootTouchedNorm=new Set(bootTouched.map(core.norm));
    const normal=file=>core.norm(file)===core.norm(result.resultPath)||bootTouchedNorm.has(core.norm(file))||isNormalStartupArtifact(relativeTo(f.base,file));
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
    record({kind:'round-verified',phase:'plain-restore',jobId,authority:status.authority,backup:result.saved.backup,state:result.saved.state,target:targetDirectory,targetSessions});
    checked('plain restore served the committed target on the same port: package bytes, package-only session, consumed activation receipt and a durable source result');
    return {target:targetDirectory,packagePaths:started.packagePaths,result,sourcePinsAfter:sourcePins(f),targetSessions,preference,preferenceAbsentAt:preRestorePreference.at};
   }
  });
  const verified=round.verified;
  const sourceServe=await runSourceServeCheck({f,target:targetDirectory,targetRef:round.next,packagePaths:verified.packagePaths,
   expectedAuthority:AUTHORITY0,jobId:round.jobId,expectPresent:[SESSION_ID],expectAbsent:[PACKAGE_SESSION_ID],label:'plain'});
  // The normal source serve must not rewrite this restore result, the source pins
  // or the long-lived boot preference (env wins; an ordinary start never writes it).
  core.samePinned(core.read(verified.result.resultPath).row,verified.result.row);
  for(const pin of verified.sourcePinsAfter)core.samePinned(core.read(p.join(f.base,...pin.relative.split('/'))).row,pin.row);
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  assertNoIntent(f,'plain source serve');
  await assertClaimGone(f,'plain source serve');
  a.notEqual(core.norm(verified.preference.value.base),core.norm(f.base),'plain: the preference target is not the source root');
  record({kind:'env-root-priority',label:'plain',preferenceBase:verified.preference.value.base,sourceBase:await getOwnership().canonicalRoot(f.base),preferenceAuthority:verified.preference.value.authority,sourceAuthority:sourceServe.status.authority,sourceSessions:sourceServe.ids});
  checkpoint('plain-final-status',{authority:round.next.status.authority,lastResult:round.next.status.lastResult,capabilities:round.next.status.capabilities,targetSessions:verified.targetSessions,sourceServe:{authority:sourceServe.status.authority,sessions:sourceServe.ids,lastResultId:sourceServe.status.lastResult?.id},bootRootPreference:verified.preference.value});
  await reclaimSuccessor('plain',round.next);
  checked('plain: the started target successor is reclaimed by the owned outer Job and its CIM identity is absent');
  // With the target successor gone, an ordinary serve with no root env must resolve
  // the target through <home>/.ruyi/boot-root-v1.json, twice, without rewriting it.
  const preferenceBoot1=await runPreferenceBoot({f,label:'plain-preference-1',target:targetDirectory,expectedAuthority:AUTHORITY0,jobId:round.jobId,
   expectPresent:[PACKAGE_SESSION_ID],expectAbsent:[SESSION_ID],preference:verified.preference});
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  const preferenceBoot2=await runPreferenceBoot({f,label:'plain-preference-2',target:targetDirectory,expectedAuthority:AUTHORITY0,jobId:round.jobId,
   expectPresent:[PACKAGE_SESSION_ID],expectAbsent:[SESSION_ID],preference:verified.preference});
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  core.samePinned(core.read(verified.result.resultPath).row,verified.result.row);
  checked('plain: two ordinary no-env serves start from the restored target through the boot preference and leave its bytes/identity unchanged');
  return{fixture:f,round,sourceServe,preference:verified.preference,preferenceBoots:[preferenceBoot1,preferenceBoot2]};
 }

 function packageHeaderPaths(snapshot){
  const paths=new Set();
  for(const file of snapshot.files){
   try{const value=JSON.parse(file.data.toString('utf8'));if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.instanceId==='string'&&typeof value.protectedKey==='string')paths.add(file.path);}catch{ }
  }
  return paths;
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
    assertCapabilities(status,'enable successor',true);
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
    assertCapabilities(status,'export successor',true);
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

  // Real product order: export -> create a post-export source-only sentinel
  // session -> delete the original source session. The sentinel is not in the
  // export package, so it can only come from the source root; it is pinned for the
  // restore round as a pre-restore precondition, never as a restore effect.
  ctx.phase='encrypted-source-sentinel';
  const sentinelResponse=await request(exported.next,'/api/sessions',Buffer.from(JSON.stringify({title:'Synthetic source sentinel'})),{method:'POST',headers:{'content-type':'application/json'}});
  a.equal(sentinelResponse.status,200,'POST /api/sessions succeeds');
  a.equal(sentinelResponse.value?.ok,true);
  const sentinelId=sentinelResponse.value.session?.id;
  a.match(sentinelId,/^[A-Za-z0-9_-]{1,64}$/,'the sentinel session id is a real safe session id');
  a.notEqual(sentinelId,SESSION_ID,'the sentinel is a distinct session');
  const generationId=exported.next.status.authority.id;
  const sentinelRelative='.work-data/generations/'+generationId+'/sessions/'+sentinelId+'.json';
  const sentinelFile=p.join(f.base,...sentinelRelative.split('/'));
  a.equal(fs.existsSync(sentinelFile),true,'the sentinel session head exists in the source generation');
  const sentinelBefore=core.read(sentinelFile).row;
  const sessionsWithSentinel=await sessionIds(exported.next);
  a.ok(sessionsWithSentinel.includes(sentinelId),'the source lists the sentinel session');
  a.ok(sessionsWithSentinel.includes(SESSION_ID),'the source still lists the original session before deletion');
  record({kind:'source-sentinel-created-for-provenance',sentinelId,relative:sentinelRelative,sha256:sentinelBefore.sha256});
  checkpoint('encrypted-source-sentinel',{sentinelId,relative:sentinelRelative,sha256:sentinelBefore.sha256});
  checked('encrypted: a post-export source-only sentinel session exists through the real API before the original source session is removed');

  ctx.phase='encrypted-source-session-removal';
  const deleted=await deleteSourceSession(exported.next,SESSION_ID);
  const sourceSessionsAfterDelete=await sessionIds(exported.next);
  a.equal(sourceSessionsAfterDelete.includes(SESSION_ID),false,'the source no longer lists the original session after the real DELETE');
  a.ok(sourceSessionsAfterDelete.includes(sentinelId),'the sentinel survives the original session deletion');
  const sentinelIndex=await waitSourceSessionIndexQuiet(f,generationId);
  a.equal(sentinelIndex.settled,true,'the source session index settles before the restore round');
  record({kind:'source-session-removed-for-provenance',sessionId:SESSION_ID,sentinelId,deleted:typeof deleted==='object',indexStable:sentinelIndex.settled});
  checked('encrypted: the source sentinel remains while the original source session is removed through the real API');

  ctx.phase='encrypted-upload';
  const uploadResponse=await request(exported.next,'/api/work-data/uploads',exportedBytes,{method:'POST',headers:{origin:'http://127.0.0.1:'+exported.next.port,'sec-fetch-site':'same-origin','content-type':'application/octet-stream'}});
  a.equal(uploadResponse.status,201);
  const uploadId=uploadResponse.value.uploadId;
  const custody=custodyWithUpload(f,uploadId);
  a.ok(core.read(p.join(custody.dir,'restore-upload-'+uploadId+'.sealed')).bytes.equals(exportedBytes));
  const openedExport=await getRecovery().open(exportedBytes.toString('utf8'),EXPORT_PASSWORD);
  try{
   a.ok(openedExport.snapshot.files.some(file=>file.path==='sessions/'+SESSION_ID+'.json'),'the exported package still carries the source session');
   a.equal(openedExport.snapshot.files.some(file=>file.path.split('/').pop()===sentinelId+'.json'),false,'the exported package predates the source sentinel');
  }finally{openedExport.release();}
  checkpoint('encrypted-custody-after-upload',{custody:custody.name,bytes:exportedBytes.length,sha256:core.H(exportedBytes)});
  checked('encrypted: the real exported package is admitted byte-for-byte under a package-only password');
  // The initial boot, enable and export must not have written any preference; this
  // restore's activation is the first writer.
  const preRestorePreference=assertBootRootPreferenceAbsent(f,'encrypted');

  const targetDirectory=p.join(f.targets,'restored');
  const round=await runMaintenanceRound(f,exported.next,{
   phase:'encrypted-restore',operation:'restore',targetDirectory,
   protected:['.work-data/active-v1.json','.work-data/generations/'+exported.next.status.authority.id+'/work-data-key-v1.json',sentinelRelative],
   body:({source})=>({operation:'restore',password:EXPORT_PASSWORD,expectedAuthority:source,backupDirectory:f.backups,targetDirectory,uploadId}),
   verify:async({next,status,jobId,source,sourceBefore,pins,custodyBefore:count})=>{
    a.ok(status.lastResult&&status.lastResult.id!==jobId,'the encrypted target carries package history, never this restore result');
    assertCapabilities(status,'encrypted restore successor',true);
    a.equal(status.job,null);
    a.equal(status.configMirror,true);
    a.equal(status.authority.mode,'encrypted','the target stays encrypted');
    a.deepEqual(status.authority,source);
    assertTargetAuthority({target:targetDirectory,authority:status.authority,label:'encrypted target'});
    const result=assertRestoreResult({f,id:jobId,targetPath:targetDirectory,source,uploaded:exportedBytes});
    assertNoIntent(f,'encrypted restore');
    const targetClaim=await claimApi(f.temp).inspect({base:await getOwnership().canonicalRoot(targetDirectory)});
    a.equal(targetClaim.present,false,'the started target has no handoff claim of its own');
    const preference=await readBootRootPreference({f,target:targetDirectory,authority:status.authority,resultId:jobId,resultSha256:result.row.sha256,name:'encrypted',notBefore:preRestorePreference.at});
    await waitActivationGone(f,targetDirectory);
    await assertActivationAbsent(f,targetDirectory,'encrypted restore');
    const started=await assertStartedTarget({target:targetDirectory,sealed:exportedBytes,password:EXPORT_PASSWORD,label:'encrypted restore',successor:next,encrypted:true});
    const targetSessions=await sessionIds(next);
    a.ok(targetSessions.includes(SESSION_ID),'the package session is served by the started target');
    a.equal(targetSessions.includes(sentinelId),false,'the target does not carry the post-export source sentinel');
    a.ok(!status.lastResult||status.lastResult.id!==jobId,'the target lastResult is not this restore job');
    if(status.lastResult)a.notEqual(status.lastResult.operation,'restore','the target historical result is not a restore record');
    record({kind:'target-historical-result',id:status.lastResult?.id||null,operation:status.lastResult?.operation||null,jobId});
    a.equal(custodyDirs(f).length,count+1);
    const handoffs=fs.readdirSync(custody.dir).filter(name=>/^handoff-[a-f0-9]{48}-[a-f0-9]{64}\.json$/.test(name));
    a.equal(handoffs.length,1);
    const handoff=JSON.parse(core.read(p.join(custody.dir,handoffs[0])).bytes);
    a.equal(handoff.jobId,jobId);a.equal(handoff.uploadId,uploadId);a.equal(handoff.sha256,core.H(exportedBytes));
    await assertOwnerHeld(targetDirectory,'encrypted restore');
    await assertOwnerFree(f,'encrypted restore');
    a.notEqual(core.norm(targetDirectory),core.norm(f.base));
    a.equal(targetDirectory.toLowerCase().startsWith(f.base.toLowerCase()+p.sep),false,'target is not nested in the source');
    const diff=core.observeDifference(sourceBefore,dataSnapshot(f.base));
    checkpoint('encrypted-source-difference',diff);
    a.deepEqual(diff.removed,[],'restore never removes a source file');
    const bootTouchedNorm=new Set(bootTouched.map(core.norm));
    const normal=file=>core.norm(file)===core.norm(result.resultPath)||bootTouchedNorm.has(core.norm(file))||isNormalStartupArtifact(relativeTo(f.base,file));
    const unexpectedChanged=diff.changed.map(row=>row.after.file).filter(file=>!normal(file));
    a.deepEqual(unexpectedChanged,[],'restore changed an unexpected source file');
    const unexpectedAdded=diff.added.filter(file=>!normal(file));
    a.deepEqual(unexpectedAdded,[],'restore added an unexpected source file');
    for(const pin of pins)core.samePinned(core.read(p.join(f.base,...pin.relative.split('/'))).row,pin.row);
    a.deepEqual(core.read(p.join(f.base,'sessions',SESSION_ID+'.json')).bytes,Buffer.from(SESSION_BYTES),'the historical source session bytes are unchanged');
    const jobLookup=await upload.makeHttp({port:next.port,token:next.token},'/api/work-data/jobs/'+jobId,undefined,{timeout:BUDGET.request});
    a.equal(jobLookup.status,404);
    record({kind:'round-verified',phase:'encrypted-restore',jobId,authority:source,backup:result.saved.backup,state:result.saved.state,target:targetDirectory,targetSessions});
    checked('encrypted restore served the committed encrypted target on the same port with the package-only session and a consumed activation receipt');
    return {target:targetDirectory,packagePaths:started.packagePaths,result,sourcePinsAfter:sourcePins(f,['.work-data/active-v1.json','.work-data/generations/'+source.id+'/work-data-key-v1.json',sentinelRelative]),targetSessions,preference,preferenceAbsentAt:preRestorePreference.at};
   }
  });
  const verified=round.verified;
  const sourceServe=await runSourceServeCheck({f,target:targetDirectory,targetRef:round.next,packagePaths:verified.packagePaths,
   expectedAuthority:round.source,jobId:round.jobId,expectPresent:[sentinelId],expectAbsent:[SESSION_ID],label:'encrypted'});
  core.samePinned(core.read(verified.result.resultPath).row,verified.result.row);
  for(const pin of verified.sourcePinsAfter)core.samePinned(core.read(p.join(f.base,...pin.relative.split('/'))).row,pin.row);
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  // The sentinel is a pre-restore precondition: present before the round, byte-identical
  // after the started target and the later source serve.
  core.samePinned(core.read(sentinelFile).row,sentinelBefore);
  record({kind:'source-sentinel-preserved',sentinelId,relative:sentinelRelative,sha256:sentinelBefore.sha256});
  assertNoIntent(f,'encrypted source serve');
  await assertClaimGone(f,'encrypted source serve');
  a.notEqual(core.norm(verified.preference.value.base),core.norm(f.base),'encrypted: the preference target is not the source root');
  record({kind:'env-root-priority',label:'encrypted',preferenceBase:verified.preference.value.base,sourceBase:await getOwnership().canonicalRoot(f.base),preferenceAuthority:verified.preference.value.authority,sourceAuthority:sourceServe.status.authority,sourceSessions:sourceServe.ids,sentinelId});
  checkpoint('encrypted-final-status',{authority:round.next.status.authority,lastResult:round.next.status.lastResult,capabilities:round.next.status.capabilities,targetSessions:verified.targetSessions,sourceServe:{authority:sourceServe.status.authority,sessions:sourceServe.ids,lastResultId:sourceServe.status.lastResult?.id},bootRootPreference:verified.preference.value});
  await reclaimSuccessor('encrypted',round.next);
  checked('encrypted: the started target successor is reclaimed by the owned outer Job and its CIM identity is absent');
  const preferenceBoot1=await runPreferenceBoot({f,label:'encrypted-preference-1',target:targetDirectory,expectedAuthority:round.source,jobId:round.jobId,
   expectPresent:[SESSION_ID],expectAbsent:[sentinelId],preference:verified.preference});
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  const preferenceBoot2=await runPreferenceBoot({f,label:'encrypted-preference-2',target:targetDirectory,expectedAuthority:round.source,jobId:round.jobId,
   expectPresent:[SESSION_ID],expectAbsent:[sentinelId],preference:verified.preference});
  core.samePinned(core.read(verified.preference.file).row,verified.preference.row);
  core.samePinned(core.read(verified.result.resultPath).row,verified.result.row);
  checked('encrypted: two ordinary no-env serves start from the restored encrypted target through the boot preference and leave its bytes/identity unchanged');
  return{fixture:f,round,enable,exported,sourceServe,sentinel:{id:sentinelId,relative:sentinelRelative,sha256:sentinelBefore.sha256},preference:verified.preference,preferenceBoots:[preferenceBoot1,preferenceBoot2]};
 }

 async function run(){
  ctx.phase='plain-journey';
  const plain=await runPlainJourney();
  ctx.phase='encrypted-journey';
  const encrypted=await runEncryptedJourney();
  return{plain,encrypted};
 }

 return{ctx,latch,healthy,record,checkpoint,checked,openJournal,close,manager,fixture,spawnServe,spawnCli,readyWarm,statusOf,waitWorkerReady,submitAccepted,postJob,
  claimApi,claimFile,waitClaimRecord,assertClaimGone,custodyDirs,custodyWithUpload,dataSnapshot,sourcePins,assertNoIntent,coldWindow,waitOldServeExit,
  waitSuccessor,runMaintenanceRound,reclaimSuccessor,assertStartedTarget,assertTargetAuthority,assertRestoreResult,assertCapabilities,run,
  assertBootRootPreferenceAbsent,readBootRootPreference,runPreferenceBoot,
  sessionIds,runSourceServeCheck,cimIdentity,absentByCim};
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
  world.record({kind:'fixture-owner',root,temp,nonce:c.randomBytes(32).toString('hex'),targetServer:target.server,executionInputSha256:target.executionInputSha256,executionInputs:target.boundFiles.length,inputFiles:target.boundFiles,scope:'Synthetic production restore E2E only;real fresh-root activation,not a completed 3.1.'});
  const outcome=await world.run();
  const inputsAfter=target.recheck();
  a.equal(inputsAfter.files,target.boundFiles.length,'recheck covers every pinned execution input');
  a.equal(inputsAfter.executionInputSha256,target.executionInputSha256,'recheck re-derives the pinned execution input digest');
  world.checkpoint('execution-inputs-after',inputsAfter);
  a.equal(world.ctx.unknown,false);a.equal(world.manager.hasUnclosed(),false);a.equal(world.manager.hasUnverifiedSpawn(),false);
  world.checkpoint('result',{schema:1,passed:world.ctx.checks.length,checks:world.ctx.checks,root,targetServer:target.server,
   executionInputSha256:inputsAfter.executionInputSha256,executionInputs:inputsAfter.files,inputProof:inputsAfter,
   plain:{authority:outcome.plain.round.next.status.authority,target:outcome.plain.round.verified.target,targetSessions:outcome.plain.round.verified.targetSessions,targetLastResult:outcome.plain.round.next.status.lastResult,
    sourceResultId:outcome.plain.round.verified.result.saved.id,sourceResultProofSha256:outcome.plain.round.verified.result.row.sha256,
    sourceServe:{authority:outcome.plain.sourceServe.status.authority,sessions:outcome.plain.sourceServe.ids,lastResultId:outcome.plain.sourceServe.status.lastResult?.id},
    bootRootPreference:outcome.plain.preference.value,preferenceBoots:outcome.plain.preferenceBoots,preferenceAbsentAt:new Date(outcome.plain.round.verified.preferenceAbsentAt).toISOString()},
   encrypted:{authority:outcome.encrypted.round.next.status.authority,target:outcome.encrypted.round.verified.target,targetSessions:outcome.encrypted.round.verified.targetSessions,targetLastResult:outcome.encrypted.round.next.status.lastResult,
    enableAuthority:outcome.encrypted.enable.next.status.authority,exportBackup:outcome.encrypted.exported.next.status.lastResult.backup,
    sourceSentinel:outcome.encrypted.sentinel,
    sourceResultId:outcome.encrypted.round.verified.result.saved.id,sourceResultProofSha256:outcome.encrypted.round.verified.result.row.sha256,
    sourceServe:{authority:outcome.encrypted.sourceServe.status.authority,sessions:outcome.encrypted.sourceServe.ids,lastResultId:outcome.encrypted.sourceServe.status.lastResult?.id},
    bootRootPreference:outcome.encrypted.preference.value,preferenceBoots:outcome.encrypted.preferenceBoots,preferenceAbsentAt:new Date(outcome.encrypted.round.verified.preferenceAbsentAt).toISOString()},
   capabilities:outcome.encrypted.round.next.status.capabilities,crashClaim:false,
   restoredActivation:'separate-fresh-root',restartRootPublished:false,currentRootIsTarget:true,activationCompleted:true,
   activationEvidence:'The restore successor serves the committed target root on the source port. It read the TEMP activation receipt (13am verifies base/identity/authority/id/nonce/resultSha256 before serve-ready), the receipt was removed by CAS after ready, the target authority is verified against the active manifest proof, the target owner is held by the successor while the source owner is free, and a package-only session is served by the target but absent from a separate plain serve on the source root. The target status lastResult is package history, never this job.',
   bootRootEvidence:'Before the restore was submitted, <home>/.ruyi/boot-root-v1.json was proven absent (no file, no pending stage) in both journeys, so the post-ready record cannot be a stale file from an earlier boot/enable/export. After serve-ready the successor wrote that eight-key record (canonical target outside both roots, target dev/ino, target authority, this job id, the source result proof and a createdAt not older than the absence check) and only then consumed the TEMP activation receipt. With the target successor reclaimed, two ordinary serves started with RUYI_HOME/WIN_CLAUDE_WORKBENCH_HOME removed resolved the same target through that preference (target runtime/status, target-only session set, source runtime untouched, preference bytes/dev/ino unchanged). The explicit RUYI_HOME=source serve still served the source and did not rewrite the preference: env wins.',
   coldVerifyEvidence:'13ak host.verifyFresh runs a separate cold node verifier child before the verified result exists. This file observes the cold listener holding the real OS source owner, the source durable result bound to the actual backup, and compares the started target bytes with the package authenticated by the real WorkDataRecovery owner. The verifier child receipt itself is not persisted by the product, so no fabricated verifier receipt is claimed.',
   claimEvidence:'armed: durable 13av record existence (no read handle against the product rename); committed: old serve natural exit 0 only after the go/armed handshake; owned: cold listener exists only after the owned advance and real OS source owner acquisition; cleanup: post-operation 13av inspect reports absent for source and target. Mid-flight polling was removed because on this host a read handle blocks the atomic rename with EPERM (verified standalone).',
   negativeCoverage:{e2ePreAdmission:['target exists','target nested in source','target inside backup directory','target equals source','backup in source','source in backup','unknown upload id','stale authority','missing upload id','plaintext package','invalid utf-8 package'],unitOnly:['wrong restore password','post-admission on-disk package tamper','post-owned crash recovery']},
   processEvidenceLimit:'Real serve/cold/successor lifecycle plus actual sampled CIM identity, the observed cold child that spawns the successor, and an owned outer Job reclaiming the target successor. No simulated four-process fixture is used.',
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
