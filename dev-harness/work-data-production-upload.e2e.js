'use strict';
// Permanent offline E2E candidate. ROOT serial actual only. The normal complete
// server is launched directly; no tiny HTTP, native/owner/Setup/broker stubs.
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),vm=require('node:vm'),http=require('node:http'),net=require('node:net'),c=require('node:crypto'),a=require('node:assert/strict');
const core=require('./lib/work-data-production-upload-core'),{createProcesses,createStrictStop}=require('./lib/work-data-production-upload-process');
const PASSWORD='SYNTHETIC full serve upload only 2026',SESSION_ID='sess_upload_synthetic';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),BUDGET=Object.freeze({startup:20000,request:15000,childClose:20000});
function safeJobResponse(response){
 const known=new Set(['api.internal_error','work_data_setup.worker_unavailable','work_data_setup.busy','auth.token_invalid','auth.origin_rejected','work_data_setup.restore_unavailable','work_data_setup.mode_conflict','work_data_setup.authority_changed','work_data_setup.password_invalid','work_data_setup.path_invalid','work_data_setup.request_invalid','work_data_setup.intent_pending','work_data_setup.handoff_pending','work_data_setup.claim_unavailable','work_data_upload.grant_unavailable','work_data_claim.claim_invalid','work_data_claim.write_failed']);
 const code=response?.value?.error?.code,message=response?.value?.error?.message;
 return {schema:1,status:Number.isInteger(response?.status)?response.status:null,responseBytes:response.raw.length,responseSha256:core.H(response.raw),code:known.has(code)?code:'UNRECOGNIZED',codeSha256:typeof code==='string'?core.H(Buffer.from(code)):null,messageBytes:typeof message==='string'?Buffer.byteLength(message):null,messageSha256:typeof message==='string'?core.H(Buffer.from(message)):null,messageMatchesWorkerUnavailable:message==='work_data_setup.worker_unavailable',rawMessagesAndBodiesOmitted:true};
}
// Only a bounded, prefixed API code is journaled verbatim. Anything else is
// reduced to UNRECOGNIZED plus its hash, so a first red is diagnosable from the
// journal without ever retaining a raw body or message.
const SAFE_CODE=/^(?:work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}|api\.[a-z0-9_.-]{1,96}|auth\.[a-z0-9_.-]{1,96})$/;
function safeErrorCode(response){
 const code=response?.value?.error?.code,known=typeof code==='string'&&code.length<=120&&SAFE_CODE.test(code);
 return {code:known?code:'UNRECOGNIZED',codeSha256:typeof code==='string'?core.H(Buffer.from(code)):null};
}
function safeFailureLocation(error){
 let name='UnknownError',stack='';try{if(['Error','AssertionError','TypeError','RangeError'].includes(error?.name))name=error.name;}catch{}try{if(typeof error?.stack==='string')stack=error.stack;}catch{}
 const frame=stack.split(/\r?\n/).filter(line=>/^\s*at /.test(line)).map(line=>/work-data-production-upload\.e2e\.js:(\d+):(\d+)\)?$/.exec(line)).find(Boolean);
 return {errorName:name,failureLocation:frame?{file:'work-data-production-upload.e2e.js',line:Number(frame[1]),column:Number(frame[2])}:null};
}
function targetFromArgs(argv){a.equal(argv.length,0,'permanent E2E uses current complete product build');return core.loadProductTarget(__dirname);}
function loadPure(source,name){a.match(name,/^[A-Za-z_$][\w$]*$/);const allowed=new Set(['node:crypto','node:buffer','net','fs','path','os','crypto','node:timers','node:fs/promises','node:path']);return vm.runInNewContext(source+'\n;'+name+';',{Buffer,process,require:n=>{a.ok(allowed.has(n),'undeclared pure/owner import '+n);return require(n);}},{filename:'EXACT_PINNED_'+name+'.js'});}
function makeHttp(record,path,bytes,{method='GET',headers={},auth=true,timeout=BUDGET.request,guard=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  let req,timer,done=false,ended=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){reject(error);req?.destroy();}else resolve(value);};
  const guarded=fn=>{if(done)return;try{guard();return fn();}catch(error){finish(error);}};
  guarded(()=>{
   const combined={host:'127.0.0.1:'+record.port,connection:'close',...(auth?{'x-wcw-token':record.token}:{}),...(bytes?{'content-length':String(bytes.length)}:{}),...headers};for(const key of Object.keys(combined))if(combined[key]===undefined)delete combined[key];
   guard();req=http.request({hostname:'127.0.0.1',port:record.port,path,method,agent:false,headers:combined},res=>{
    // Observe errors even if revocation happened before the response callback.
    res.on('error',error=>finish(error));res.on('aborted',()=>finish(Error('test response aborted')));res.on('close',()=>{if(!ended)finish(Error('test response closed before end'));});
    const parts=[];let size=0;
    res.on('data',part=>guarded(()=>{size+=part.length;if(size>65536)throw Error('bounded test response');parts.push(part);}));
    res.on('end',()=>guarded(()=>{ended=true;const raw=Buffer.concat(parts,size);let value;try{value=JSON.parse(raw.toString('utf8'));}catch{}finish(null,{status:res.statusCode,headers:res.headers,raw,value});}));
    guarded(()=>{});
   });
   req.on('error',error=>finish(error));timer=setTimeout(()=>finish(Error('test HTTP observation deadline')),timeout);guard();req.end(bytes);
  });
 });
}
function truncatedHttp(record,bytes,{guard=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  let socket,timer,used=0,closed=false,errorCode=null,done=false;const parts=[];
  const fail=error=>{if(done)return;done=true;clearTimeout(timer);reject(error);socket?.destroy();};
  const guarded=fn=>{if(done)return;try{guard();return fn();}catch(error){fail(error);}};
  guarded(()=>{
   guard();socket=net.createConnection({host:'127.0.0.1',port:record.port});timer=setTimeout(()=>fail(Error('truncated client observation deadline')),BUDGET.request);
   socket.on('data',b=>guarded(()=>{used+=b.length;if(used>65536)throw Error('raw response capacity');parts.push(b);}));
   socket.on('error',error=>{errorCode=error.code||null;});
   socket.on('close',()=>{closed=true;guarded(()=>{done=true;clearTimeout(timer);const raw=Buffer.concat(parts,used),match=/^HTTP\/1\.[01] (\d{3}) /.exec(raw.toString('latin1'));resolve({status:match?Number(match[1]):null,closed,errorCode,raw});});});
   socket.on('connect',()=>guarded(()=>{const head=Buffer.from('POST /api/work-data/uploads HTTP/1.1\r\nHost: 127.0.0.1:'+record.port+'\r\nOrigin: http://127.0.0.1:'+record.port+'\r\nx-wcw-token: '+record.token+'\r\nContent-Type: application/octet-stream\r\nContent-Length: '+String(bytes.length+7)+'\r\nConnection: close\r\n\r\n');guard();socket.end(Buffer.concat([head,bytes]));}));
  });
 });
}
async function runActual(argv=process.argv.slice(2)){
 if(process.platform!=='win32'){a.equal(argv.length,0,'ROOT candidate actual requires Windows');console.log('SKIP Windows native full-serve upload E2E');require(p.join(__dirname,'lib/harness')).createRunner('WORK DATA PRODUCTION UPLOAD').done();return{skipped:true};}
 const target=targetFromArgs(argv);a.equal(Number(process.versions.node.split('.')[0]),24);
 const harness=p.join(target.repo,'dev-harness');require(p.join(harness,'lib/self-isolate-home'));const {releaseEnvironment}=require(p.join(harness,'lib/release-checks')),{snapshotProcessTable,ownDescendants}=require(p.join(harness,'lib/kill-own-tree')),{getFreePort}=require(p.join(harness,'free-port'));
 const t=require(p.join(harness,'lib/harness')).createRunner('WORK DATA PRODUCTION UPLOAD'),temp=p.resolve(os.tmpdir()),root=fs.mkdtempSync(p.join(temp,'ruyi-full-serve-upload-')),evidence=p.join(root,'evidence');a.equal(p.dirname(root),temp);fs.mkdirSync(evidence);
 const ctx={unknown:false,failure:null,failureSet:false,holdTimer:null,leases:new Set(),checks:[],phase:'initialization',root,evidence},outputFD=new Map();let manager,journalFD;
 const latch=error=>{ctx.unknown=true;if(!ctx.failureSet){ctx.failureSet=true;ctx.failure=error;}};
 function healthy(){if(ctx.unknown)throw Error('unknown forbids new test work');}
 function sourceGate(){healthy();try{target.recheck();}catch(error){latch(error);throw error;}healthy();}
 function work(fn){healthy();return fn();}
 async function request(rt,path,bytes,options={}){healthy();const result=await makeHttp(rt,path,bytes,{...options,guard:healthy});healthy();return result;}
 async function truncated(rt,bytes){healthy();const result=await truncatedHttp(rt,bytes,{guard:healthy});healthy();return result;}
 process.stdout.on('error',latch);process.stderr.on('error',latch);
 function rawWrite(fd,bytes){let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(n<1)throw Error('test evidence short write');offset+=n;}}
 function record(row){try{a.ok(!ctx.unknown,'test observation already failed');rawWrite(journalFD,Buffer.from(JSON.stringify({...row,at:new Date().toISOString()})+'\n'));fs.fsyncSync(journalFD);}catch(error){latch(error);throw error;}}
 function checkpoint(name,value){try{a.match(name,/^[a-z0-9-]+$/);const file=p.join(evidence,name+'.json'),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx',0o600);try{rawWrite(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const captured=core.read(file);a.equal(captured.row.sha256,core.H(bytes));record({kind:'checkpoint',name,...captured.row});return captured.row;}catch(error){latch(error);throw error;}}
 function checked(label){a.equal(ctx.unknown,false,'unknown forbids new test success');ctx.checks.push(label);record({kind:'assertion-pass',label});}
 function openOutput(label){for(const kind of ['stdout','stderr'])outputFD.set(label+':'+kind,fs.openSync(p.join(evidence,label+'-'+kind+'.log'),'wx',0o600));}
 function sourceProtected(before,after,names){for(const relative of names){const file=p.join(before.base,...relative.split('/')),old=before.files.find(r=>core.norm(r.file)===core.norm(file)),now=after.files.find(r=>core.norm(r.file)===core.norm(file));a.ok(old&&now,relative);core.samePinned(now,old);}}
 function dataSnapshot(base){return{base,...core.inventory(base,{directoryMetadata:true})};}
 function custody(tempRoot){const names=fs.readdirSync(tempRoot).filter(n=>n.startsWith('ruyi-work-data-upload-'));a.equal(names.length,1,'one fresh custody per normal startup attempt');const dir=p.join(tempRoot,names[0]),st=fs.lstatSync(dir,{bigint:true});a.ok(st.isDirectory()&&!st.isSymbolicLink());return{dir,dev:String(st.dev),ino:String(st.ino)};}
 const config=workspace=>({configSchema:14,locale:'en-US',workDataEncryptionV1:false,permissionMode:'ask',stewardEnabledV1:false,schedulerEnabledV1:false,autoImportClaudeCodeMcp:false,importAgentInstructions:false,includeWorkbenchMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[],providers:[],defaultWorkspace:workspace});
 function fixture(label){healthy();const base=p.join(root,label+'-data'),home=p.join(root,label+'-home'),env=releaseEnvironment(home,base);fs.mkdirSync(base);fs.mkdirSync(p.join(base,'sessions'));fs.writeFileSync(p.join(base,'config.json'),JSON.stringify(config(root)),{flag:'wx'});fs.writeFileSync(p.join(base,'sessions',SESSION_ID+'.json'),JSON.stringify({id:SESSION_ID,private:'完整合成上传源，保持原字节。',title:'Synthetic upload session',messages:[]}),{flag:'wx'});return{base,home,env,temp:p.resolve(env.TEMP)};}
 function spawnServe(f,label,port){healthy();openOutput(label);return manager.start(process.execPath,[target.server,'serve','--host','127.0.0.1','--port',String(port)],{cwd:p.dirname(target.server),env:f.env,windowsHide:true,stdio:['ignore','pipe','pipe']},label);}
 async function ready(handle,f){healthy();const deadline=Date.now()+BUDGET.startup;while(Date.now()<deadline){if(ctx.unknown)throw Error('unknown during ready');a.equal(manager.inspect(handle).closeSeen,false,'normal serve exited before ready');let rt;try{rt=core.json(p.join(f.base,'runtime.json'));}catch(error){if(error.code!=='ENOENT')throw error;}if(rt?.pid===manager.pid(handle)){a.equal(rt.host,'127.0.0.1');a.ok(Number.isInteger(rt.port)&&rt.port>0&&rt.port<=65535);a.equal(typeof rt.token==='string'&&/^[a-f0-9]{32}$/.test(rt.token),true,'runtime token format');const health=await request(rt,'/health',undefined,{auth:false,timeout:Math.max(1,Math.min(BUDGET.request,deadline-Date.now()))});if(health.status===200&&health.value?.ok===true)return rt;}await sleep(50);}throw Error('complete normal serve startup observation deadline');}
 async function status(rt){const response=await request(rt,'/api/work-data/status');a.equal(response.status,200);core.assertStatus(response.value,{worker:true});core.assertNoKernelHooks(response.value,{worker:true});return response.value;}
 // startWorkbenchServe listens before activateServe, so the worker capability is a
 // real readiness fact, not a constant of the build. This waits for the product to
 // advertise it instead of racing the listen/activate window.
 async function waitWorker(rt){const deadline=Date.now()+BUDGET.startup;for(;;){const value=await status(rt);if(value.capabilities.worker===true)return value;if(Date.now()>=deadline)throw Error('worker capability never became ready');await sleep(50);}}
 try{
  journalFD=fs.openSync(p.join(evidence,'events.jsonl'),'wx',0o600);record({kind:'fixture-owner',root,temp,nonce:c.randomBytes(32).toString('hex'),targetServer:target.server,sourceIdentitySha256:target.sourceIdentitySha256,sourceReviewSha256:target.sourceReviewSha256,executionInputSha256:target.executionInputSha256,executionInputs:target.boundFiles.length,inputFiles:target.boundFiles,scope:'Synthetic normal full serve upload E2E only;not restoration completion.'});
  manager=createProcesses({record,writeOutput(label,kind,bytes){try{rawWrite(outputFD.get(label+':'+kind),bytes);}catch(error){latch(error);throw error;}},latch,isUnknown:()=>ctx.unknown,beforeStart:sourceGate,killOwnTree:createStrictStop({snapshotProcessTable,ownDescendants,latch,isUnknown:()=>ctx.unknown}),snapshotProcessTable,ownDescendants});
  const recovery=loadPure(core.read(p.join(target.src,'01t-work-data-recovery.js')).bytes.toString('utf8'),'WorkDataRecovery'),ownerApi=loadPure(core.read(p.join(target.src,'01g-server-ownership.js')).bytes.toString('utf8'),'ServerOwnership');
  const sealed=Buffer.from(await work(()=>recovery.seal({appVersion:'3.0.1',generation:0,createdAt:'2026-10-27T00:00:00.000Z',directories:[],keys:[],files:[{path:'config.json',data:Buffer.from('{"synthetic":"上传包"}'),keyRefs:[]}],auxiliaries:[]},PASSWORD)));healthy();a.equal(recovery.inspectSealed(sealed.toString('utf8')),true);
  ctx.phase='normal-startup';const normal=fixture('normal'),before=dataSnapshot(normal.base);checkpoint('normal-before-start',before);const child=spawnServe(normal,'normal-server',await work(()=>getFreePort('127.0.0.1')));await child.spawned;healthy();const rt=await ready(child,normal);manager.snapshot(child,'ready');ctx.phase='initial-native-birth-pairs';await manager.captureNativeBirths(child);sourceGate();ctx.phase='worker-readiness';const initial=await waitWorker(rt),readySnapshot=dataSnapshot(normal.base);checkpoint('normal-after-ready',readySnapshot);sourceProtected(before,readySnapshot,['sessions/'+SESSION_ID+'.json']);checked('complete normal server uses real runtime token and exposes upload only, with unchanged source session');
  const box=custody(normal.temp),marker=core.json(p.join(box.dir,'restore-upload-owner.json'));a.equal(core.norm(marker.base),core.norm(normal.base));a.equal(core.norm(marker.root),core.norm(box.dir));a.match(marker.nonce,/^[a-f0-9]{64}$/);a.deepEqual(fs.readdirSync(box.dir),['restore-upload-owner.json']);const boxBefore=core.inventory(box.dir);checkpoint('custody-before-upload',boxBefore);
  ctx.phase='sealed-upload';const upload=await request(rt,'/api/work-data/uploads',sealed,{method:'POST',headers:{origin:'http://127.0.0.1:'+rt.port,'sec-fetch-site':'same-origin','content-type':'application/octet-stream'}});a.equal(upload.status,201);a.equal(upload.value?.ok,true);a.match(upload.value.uploadId,/^[a-f0-9]{48}$/);const payload=core.read(p.join(box.dir,'restore-upload-'+upload.value.uploadId+'.sealed'));a.ok(payload.bytes.equals(sealed));const boxAfter=core.inventory(box.dir);checkpoint('custody-after-sealed-upload',{...boxAfter,uploaded:{id:upload.value.uploadId,bytes:sealed.length,sha256:core.H(sealed),file:payload.row}});checked('real sealed POST201 returns48hex id and exact bytes in genuine joint-owner custody');
  const negatives=[['plaintext',Buffer.from('{"private":"UNSEALED_SYNTHETIC_SENTINEL"}'),{},409,'work_data_recovery.invalid'],['invalid-utf8',Buffer.from([0xff]),{},409,'work_data_upload.sealed_required'],['unauthenticated',sealed,{auth:false},403],['foreign-origin',sealed,{headers:{origin:'http://example.invalid'}},403],['cross-site',sealed,{headers:{'sec-fetch-site':'cross-site'}},403],['encoded',sealed,{headers:{'content-encoding':'gzip'}},400],['chunked',sealed,{headers:{'transfer-encoding':'chunked','content-length':undefined}},400],['zero-length',Buffer.alloc(0),{headers:{'content-length':'0'}},411]];
  for(const [label,body,options,expected,expectedCode]of negatives){ctx.phase='http-negative-'+label;const response=await request(rt,'/api/work-data/uploads',body,{method:'POST',...options,headers:{origin:'http://127.0.0.1:'+rt.port,'content-type':'application/octet-stream',...options.headers}});const observed=safeErrorCode(response);record({kind:'http-negative',label,status:response.status,statusExpected:expected,code:observed.code,codeSha256:observed.codeSha256,codeExpected:expectedCode??null,responseBytes:response.raw.length,responseSha256:core.H(response.raw)});a.equal(response.status,expected,label);if(expectedCode!==undefined)a.equal(response.value?.error?.code,expectedCode,label+' stable api code');a.deepEqual(core.inventory(box.dir),boxAfter,label+' must not write an upload');await status(rt);checked(label+' is refused by real full-server HTTP before custody publication');}
  ctx.phase='wrong-length-truncated';const short=await truncated(rt,sealed.subarray(0,Math.min(64,sealed.length)));a.ok(short.status===400||short.status===null&&short.closed,'truncated body must yield parser400 or closed transport,never201/500');a.ok(short.errorCode===null||short.errorCode==='ECONNRESET','only actual peer reset is accepted for incomplete HTTP');record({kind:'http-negative',label:'wrong-length-truncated',status:short.status,closed:short.closed,errorCode:short.errorCode,responseSha256:core.H(short.raw)});a.deepEqual(core.inventory(box.dir),boxAfter);await status(rt);checked('wrong content-length with actual half-close publishes no payload and normal service stays healthy');
  // With the production worker merged, a missing-worker 501 is no longer a fact.
  // What must still hold is that every refusal decided before worker.start leaves
  // the serve running, publishes no authority, registers no job, writes no claim,
  // starts no maintenance intent and creates no backup. Restore is admitted now:
  // an unknown upload id is refused by the real broker after every admission
  // check, so it must be a typed 409 that consumes no upload grant and creates no
  // target. Nowhere in this list may a real grant, claim or backup be consumed.
  ctx.phase='job-refusal-setup';const backupDirectory=p.join(root,'unused-backups');fs.mkdirSync(backupDirectory);
  const claimNames=()=>fs.readdirSync(normal.temp).filter(name=>name.startsWith('ruyi-work-data-handoff-'));
  const restoreTarget=p.join(root,'restore-target');
  const jobNegatives=[
   ['restore-unknown-upload',{operation:'restore',password:PASSWORD,expectedAuthority:initial.authority,backupDirectory,targetDirectory:restoreTarget,uploadId:'f'.repeat(48)},409,'work_data_upload.grant_unavailable'],
   ['disable-without-encryption',{operation:'disable',password:PASSWORD,expectedAuthority:initial.authority,backupDirectory,confirmPlaintext:true},409,'work_data_setup.mode_conflict'],
   ['stale-authority',{operation:'enable',password:PASSWORD,expectedAuthority:{generation:1,id:'a'.repeat(48),mode:'plain',sha256:'b'.repeat(64)},backupDirectory},409,'work_data_setup.authority_changed'],
   ['short-password',{operation:'enable',password:'short',expectedAuthority:initial.authority,backupDirectory},400,'work_data_setup.password_invalid'],
   ['backup-inside-base',{operation:'enable',password:PASSWORD,expectedAuthority:initial.authority,backupDirectory:p.join(normal.base,'inside')},400,'work_data_setup.path_invalid'],
   ['wrong-confirmation-shape',{operation:'enable',password:PASSWORD,expectedAuthority:initial.authority,backupDirectory,confirmPlaintext:'yes'},400,'work_data_setup.request_invalid'],
  ];
  for(const [label,body,expectedStatus,expectedCode]of jobNegatives){
   ctx.phase='job-negative-'+label;
   const bytes=Buffer.from(JSON.stringify(body));let response;
   try{response=await request(rt,'/api/work-data/jobs',bytes,{method:'POST',headers:{'content-type':'application/json'}});}finally{bytes.fill(0);}
   checkpoint('job-refusal-'+label,safeJobResponse(response));
   a.equal(response.status,expectedStatus,label);
   a.equal(response.value?.error?.code,expectedCode,label+' stable api code');
   a.equal(response.value?.error?.message,expectedCode,label+' message is the stable code');
   const observed=await status(rt);
   a.deepEqual(observed.authority,initial.authority,label+' never publishes authority');
   a.equal(observed.job,null,label+' never registers a job');
   a.equal(observed.capabilities.worker,true,label+' is decided with the real worker available');
   a.equal(fs.existsSync(p.join(normal.base,'.work-data','active-v1.json')),false,label+' never starts maintenance intent');
   a.deepEqual(fs.readdirSync(backupDirectory),[],label+' never creates a backup');
   a.deepEqual(claimNames(),[],label+' never writes a handoff claim');
   a.equal(fs.existsSync(restoreTarget),false,label+' never creates a restore target');
   a.deepEqual(core.inventory(box.dir),boxAfter,label+' leaves the admitted upload custody byte-identical');
   a.equal(manager.inspect(child).closeSeen,false,label+' leaves the serve running');
   checked(label+' is refused before worker.start with no durable side effect');
  }
  ctx.phase='job-refusal-final';const finalStatus=await status(rt);a.deepEqual(finalStatus.authority,initial.authority);a.equal(finalStatus.job,null);a.equal(fs.existsSync(p.join(normal.base,'.work-data','active-v1.json')),false);a.deepEqual(fs.readdirSync(backupDirectory),[]);a.deepEqual(claimNames(),[]);a.equal(fs.existsSync(restoreTarget),false);a.deepEqual(core.inventory(box.dir),boxAfter);
  checked('no refusal drains the service,publishes authority,registers a job,creates a backup or target,writes a claim,or consumes the admitted upload');
  const afterHTTP=dataSnapshot(normal.base);checkpoint('normal-after-http',afterHTTP);sourceProtected(readySnapshot,afterHTTP,['config.json','sessions/'+SESSION_ID+'.json']);checkpoint('normal-observed-data-difference',core.observeDifference(readySnapshot,afterHTTP));target.recheck();
  ctx.phase='verified-normal-cleanup';await manager.cleanupKnown(child,async()=>{await status(rt);a.deepEqual(core.inventory(box.dir),boxAfter);sourceProtected(readySnapshot,dataSnapshot(normal.base),['config.json','sessions/'+SESSION_ID+'.json']);});healthy();checkpoint('normal-process-terminal',manager.inspect(child));checkpoint('normal-after-test-cleanup',dataSnapshot(normal.base));a.deepEqual(core.inventory(box.dir),boxAfter);checked('owned test cleanup request is separate from actual server close and actual sampled CIM absence');
  ctx.phase='pending-intent-refusal';const pending=fixture('pending'),backup=p.join(root,'pending-backup.ruyi-backup');fs.writeFileSync(backup,sealed,{flag:'wx'});fs.mkdirSync(p.join(pending.base,'.work-data'));fs.writeFileSync(p.join(pending.base,'.work-data','maintenance-v1.json'),JSON.stringify({schema:1,id:'e'.repeat(48),operation:'enable',phase:'prepared',createdAt:'2026-10-27T00:00:00.000Z',expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backup:{path:backup,sha256:core.H(sealed)},candidate:null}),{flag:'wx'});const pendingBefore=dataSnapshot(pending.base);checkpoint('pending-before',pendingBefore);const refused=spawnServe(pending,'pending-server',await work(()=>getFreePort('127.0.0.1')));await refused.spawned;healthy();const terminal=await manager.waitClose(refused,BUDGET.childClose);healthy();a.equal(terminal.code,1);a.equal(terminal.signal,null);
  await manager.certifyExpectedRefusal(refused,async()=>{const pendingAfter=dataSnapshot(pending.base);a.deepEqual(pendingAfter,pendingBefore);const empty=custody(pending.temp);a.deepEqual(fs.readdirSync(empty.dir),[]);a.equal(fs.existsSync(p.join(pending.base,'runtime.json')),false);a.equal(fs.existsSync(p.join(pending.base,'last-start-error.json')),false);let own,keeper;try{own=await work(()=>ownerApi.acquire([pending.base,empty.dir]));ctx.leases.add(own);healthy();const canonical=await work(()=>ownerApi.canonicalRoot(pending.base));healthy();keeper=work(()=>ownerApi.createSourceKeeper(own,canonical));const canonicalAgain=await work(()=>ownerApi.canonicalRoot(pending.base));healthy();a.equal(ownerApi.isSourceKeeper(keeper,own,canonicalAgain),true);a.equal(ownerApi.owns(own,empty.dir),true);a.equal(ownerApi.owns(own,pending.base),true);await work(()=>keeper.releaseOwner(()=>{healthy();return true;}));ctx.leases.delete(own);a.equal(ownerApi.owns(own,pending.base),false);}catch(error){latch(error);throw error;}checkpoint('pending-after-refusal',{...pendingAfter,custody:empty,custodyEntries:[],newGenuineJointAcquireAndCheckedRelease:true,fastRefusalCreationIdentityMayBeUnavailable:true});});healthy();checkpoint('pending-process-terminal',manager.inspect(refused));checked('pending intent refuses before root bind/broker writes,all source fields stay equal and genuine source/custody owner reacquire succeeds');
  const inputsAfter=target.recheck();a.equal(inputsAfter.files,target.boundFiles.length,'recheck covers every pinned execution input');a.equal(inputsAfter.executionInputSha256,target.executionInputSha256,'recheck re-derives the pinned execution input digest');checkpoint('execution-inputs-after',inputsAfter);a.equal(ctx.unknown,false);a.equal(manager.hasUnclosed(),false);a.equal(manager.hasUnverifiedSpawn(),false);a.equal(ctx.leases.size,0);checkpoint('result',{schema:1,passed:ctx.checks.length,checks:ctx.checks,root,targetServer:target.server,sourceIdentitySha256:target.sourceIdentitySha256,sourceReviewSha256:target.sourceReviewSha256,executionInputSha256:inputsAfter.executionInputSha256,executionInputs:inputsAfter.files,normalServer:manager.inspect(child),pendingRefusal:manager.inspect(refused),inputProof:inputsAfter,workingDataLimit:'Full inventories retained;normal startup/log additions listed,protected session/config strict. No ordinary atime or NTFS metadata preservation claim.',processEvidenceLimit:'Actual server lifecycle plus actual sampled CIM identity/lineage. Native helpers have source/API completion guards but no fabricated complete helper event triples.',worker:true,upload:true,download:false,crashClaim:false,activation:false,restorationComplete:false,whole3_1Complete:false});
  for(const [name,fd]of outputFD){fs.fsyncSync(fd);fs.closeSync(fd);outputFD.delete(name);}fs.fsyncSync(journalFD);fs.closeSync(journalFD);journalFD=null;for(const label of ctx.checks)t.ok(true,label);console.log('Retained synthetic full-serve evidence '+root);t.done();return{passed:true,root};
 }catch(error){latch(error);const projected={schema:1,stage:ctx.phase,lastPassed:ctx.checks.at(-1)||null,code:typeof error?.code==='string'&&/^[A-Z0-9_.-]{1,80}$/i.test(error.code)?error.code:'E2E_FAILURE',rawMessagesAndBodiesOmitted:true,...safeFailureLocation(error)};const retain=ctx.leases.size>0||manager&&(manager.hasUnclosed()||manager.hasUnverifiedSpawn());if(retain){
   // Retain references/lifetime before fallible diagnostic output. This is test
   // uncertainty;do not infer component ownerHeld or kill a potentially live owner.
   ctx.holdTimer=setInterval(()=>{void manager;void ctx.leases;},60000);ctx.holdTimer.ref();process.exitCode=1;try{fs.writeFileSync(p.join(evidence,'failure-summary.json'),JSON.stringify(projected,null,2)+'\n',{flag:'wx'});}catch{}try{process.stderr.write('Retained unverified full-serve fixture '+root+'; no automatic process cleanup.\n');}catch{}return await new Promise(()=>{});
  }process.exitCode=1;try{fs.writeFileSync(p.join(evidence,'failure-summary.json'),JSON.stringify(projected,null,2)+'\n',{flag:'wx'});}catch{}try{process.stderr.write('Full-serve E2E failed; retained fixture '+root+'\n');}catch{}throw error;
 }
}
module.exports={targetFromArgs,loadPure,makeHttp,truncatedHttp,BUDGET,runActual,safeJobResponse,safeFailureLocation};
if(require.main===module)runActual().catch(error=>{try{process.stderr.write(((error&&error.message||String(error)))+String.fromCharCode(10));}catch{}process.exitCode=1;});
