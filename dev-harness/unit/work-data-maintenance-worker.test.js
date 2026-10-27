'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(process.env.RUYI_MAINTENANCE_WORKER_SOURCE || path.join(__dirname,'../../ruyi-workbench/app/src/13ai-work-data-worker.js'),'utf8');
const {constBlock}=require('../lib/source-slice');
const Recovery=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/01t-work-data-recovery.js'),'utf8'),'WorkDataRecovery')+'\nWorkDataRecovery',{require,Buffer,process});
const RestoreUploads=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13at-work-data-restore-uploads.js'),'utf8'),'WorkDataRestoreUploads')+'\nWorkDataRestoreUploads',{require,Buffer,process,WorkDataRecovery:Recovery});
const Worker=vm.runInNewContext(source+'\nWorkDataMaintenanceWorker;', {require,Buffer,process,WorkDataRestoreUploads:RestoreUploads});
const base=path.resolve(__dirname,'source'), backup=path.resolve(__dirname,'backups');
const id='a'.repeat(48), nonce='c'.repeat(64);
// Parser fixture only: this structural handoff is not an issued upload grant or a verified file.
const uploadRoot=path.resolve(__dirname,'upload-custody'),restoreUpload=Object.freeze({schema:1,base,root:uploadRoot,rootIdentity:{dev:'1',ino:'2'},rootNonce:'d'.repeat(64),uploadId:'b'.repeat(48),jobId:id,nonce,file:path.join(uploadRoot,'restore-upload-'+'b'.repeat(48)+'.sealed'),identity:{dev:'1',ino:'3'},bytes:1,sha256:'e'.repeat(64),marker:{dev:'1',ino:'4',sha256:'f'.repeat(64)}});
const request=()=>({id,operation:'enable',password:'synthetic password only',expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupDirectory:backup});
const payload=()=>({schema:1,id,nonce,base,parentPid:111,operation:'enable',password:'synthetic password only',
  expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},paths:{backupDirectory:backup,targetDirectory:null,uploadFile:null,uploadSha256:null},serve:{host:'127.0.0.1',port:12345}});
function fixture(){
 const calls=[], timers=new Set(); let captured, stopped=0, exited=0;
 const child=new EventEmitter(); child.stdin=new EventEmitter();
 child.stdin.end=(bytes,done)=>{captured=JSON.parse(bytes.toString());done();};
 child.send=(msg,done)=>{calls.push(msg.kind);done();};
 const host={pid:222,env:{RUYI_INTERNAL_MCP_CAP:'secret',RUYI_MEMORY_CAP:'secret',WCW_TOKEN:'secret',NODE_OPTIONS:'--require bad',
   RUYI_TEST_SERVER_JS:'other',WIN_CLAUDE_WORKBENCH_HOME:'other',HOME:'fixture-home'},
  base:async()=>base,canonical:async p=>p,listener:()=>({host:'127.0.0.1',port:12345}),spawn:()=>child,
  setTimeout:(cb,ms)=>{const t=setTimeout(cb,ms);timers.add(t);return t;},clearTimeout:t=>{clearTimeout(t);timers.delete(t);},
  stopUncommitted:async()=>{stopped++;},exitParent:async()=>{exited++;},
  waitParentExit:async()=>{calls.push('parent-dead');},
  acquire:async roots=>{calls.push('acquire');return {roots,release:async()=>calls.push('release')};},
  readAuthority:async()=>{calls.push('authority');return {generation:0,id:null,mode:'plain',proof:{sha256:null}};},
  execute:async context=>{assert.equal(context.assertExclusive(context.ownership),true);assert.equal(context.assertExclusive({roots:[base]}),false);calls.push('execute');return {phase:'done'};},
  helperMayStillRun:()=>false};
 const worker=Worker.create(host);
 const channel={parentConnected:()=>true,parentPid:()=>111,readInput:async()=>Buffer.from(JSON.stringify(payload())),
  send:async msg=>{calls.push(msg.kind);},waitCommand:async options=>{await options.onListening();return 'go';}};
 return {worker,host,child,channel,calls,captured:()=>captured,stopped:()=>stopped,exited:()=>exited,
  message:kind=>child.emit('message',{schema:1,id,nonce:captured.nonce,kind}),cleanup:()=>{for(const timer of timers)clearTimeout(timer);}};
}
test('child readiness alone cannot execute or release/exit parent',async()=>{
 const f=fixture();try{const h=await f.worker.start(request());f.message('ready');await h.ready;
  assert.equal(f.exited(),0);assert.deepEqual(f.calls,[]);assert.equal(f.worker.busy(),true);
  await h.cancel();assert.equal(f.stopped(),1);assert.equal(f.worker.busy(),false);
 }finally{f.cleanup();}
});
test('go plus authenticated armed receipt precedes parent exit; committed cancellation refuses',async()=>{
 const f=fixture();try{const h=await f.worker.start(request());f.message('ready');await h.ready;
  const handed=h.handoff();await new Promise(r=>setImmediate(r));assert.deepEqual(f.calls,['go']);assert.equal(f.exited(),0);
  await assert.rejects(h.cancel(),e=>e.operationMayHaveExecuted===true&&e.retry===false);
  f.child.emit('message',{schema:1,id,nonce:'d'.repeat(64),kind:'armed'});await new Promise(r=>setImmediate(r));assert.equal(f.exited(),0);
  f.message('armed');await handed;assert.equal(f.exited(),1);
 }finally{f.cleanup();}
});
test('lost commitment receipt fails closed and never reopens admission or kills possibly executing child',async()=>{
 const f=fixture();try{const h=await f.worker.start(request());f.message('ready');await h.ready;
  const handed=h.handoff();await new Promise(r=>setImmediate(r));f.child.emit('disconnect');
  await assert.rejects(handed,e=>e.operationMayHaveExecuted===true&&e.retry===false);
  assert.equal(f.worker.busy(),true);assert.equal(f.stopped(),0);assert.equal(f.exited(),0);
 }finally{f.cleanup();}
});
test('concurrent launches register one child across async base resolution',async()=>{
 const f=fixture();try{const settled=await Promise.allSettled([f.worker.start(request()),f.worker.start({...request(),id:'b'.repeat(48)})]);
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);const h=settled.find(r=>r.status==='fulfilled').value;await h.cancel();
 }finally{f.cleanup();}
});
test('transport contains password only in bounded stdin, strips all inherited execution capabilities',async()=>{
 const f=fixture();try{const h=await f.worker.start(request());const p=f.captured();assert.equal(p.password,'synthetic password only');
  const env=f.worker.environment(base);assert.deepEqual(Object.keys(env).sort(),['HOME','RUYI_HOME']);assert.equal(env.RUYI_HOME,base);
  assert.equal(JSON.stringify(h).includes('password'),false);await h.cancel();
 }finally{f.cleanup();}
});
test('cold execution requires go, parent death, actual OS owner then exact authority before execute',async()=>{
 const f=fixture();const result=await f.worker.runCold(f.channel);assert.equal(result.phase,'done');
 assert.deepEqual(f.calls,['ready','armed','parent-dead','acquire','authority','execute','release']);
});
test('cancelled child cannot read authority/acquire/mutate source',async()=>{
 const f=fixture();f.channel.waitCommand=async options=>{await options.onListening();return 'cancel';};
 assert.equal((await f.worker.runCold(f.channel)).phase,'cancelled');assert.deepEqual(f.calls,['ready']);
});
test('a live or uncertain parent refuses even if its ownership handle was released',async()=>{
 const f=fixture();f.host.waitParentExit=async()=>{throw Object.freeze(Object.assign(new Error('EPERM'),{code:'EPERM'}));};
 await assert.rejects(f.worker.runCold(f.channel),e=>e.operationMayHaveExecuted===true&&e.retry===false);
 assert.deepEqual(f.calls,['ready','armed']);
});
test('fresh authority mismatch leaves business source untouched',async()=>{
 const f=fixture();f.host.readAuthority=async()=>({generation:1,proof:{sha256:'e'.repeat(64)}});
 await assert.rejects(f.worker.runCold(f.channel),e=>e.cause.code==='work_data_setup.authority_changed');
 assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.at(-1),'release');
});
test('native helper uncertainty retains OS exclusion through process exit',async()=>{
 const f=fixture();f.host.helperMayStillRun=()=>true;f.host.execute=async()=>{throw Object.freeze(Object.assign(new Error('delayed helper'),{retry:true,operationMayHaveExecuted:false}));};
 await assert.rejects(f.worker.runCold(f.channel),e=>e.operationMayHaveExecuted===true&&e.retry===false);
 assert.equal(f.calls.includes('release'),false);
});
test('a concrete frozen helper failure retains source ownership before outer host latch',async()=>{
 const f=fixture();f.host.execute=async()=>{throw Object.freeze(Object.assign(Error('native still active'),{helperMayStillRun:true}));};
 await assert.rejects(f.worker.runCold(f.channel),error=>error.helperMayStillRun===true&&error.operationMayHaveExecuted===true);
 assert.equal(f.calls.includes('release'),false);
});
test('null/string/frozen owner failures become controlled nonretryable postcommit failures',async()=>{
 for(const thrown of [null,'failure',Object.freeze(new Error('frozen'))]){const f=fixture();f.host.execute=async()=>{throw thrown;};
  await assert.rejects(f.worker.runCold(f.channel),e=>e.operationMayHaveExecuted===true&&e.retry===false&&e.cause===thrown);
 }
});
test('no authenticated IPC, wrong parent PID, oversized input refuse before readiness',async()=>{
 for(const mode of ['noIPC','wrongPID','oversize']){const f=fixture();
  if(mode==='noIPC')f.channel.parentConnected=()=>false;
  if(mode==='wrongPID')f.channel.parentPid=()=>999;
  if(mode==='oversize')f.channel.readInput=async()=>Buffer.alloc(Worker.MAX_INPUT+1);
  await assert.rejects(f.worker.runCold(f.channel));assert.deepEqual(f.calls,[]);
 }
});
test('restore must select absent disjoint root and private upload file; malformed target/authority rejected',()=>{
 for(const mutate of [p=>p.paths.backupDirectory=base,p=>p.paths.targetDirectory=base,p=>p.expectedAuthority.sha256='bad',
   p=>p.serve.host='0.0.0.0',p=>p.password='short',p=>p.extra=true]){
  const p=payload();mutate(p);assert.throws(()=>Worker.validate(p));
 }
 const p=payload();p.operation='restore';p.upload=restoreUpload;p.paths.targetDirectory=path.resolve(__dirname,'restored');p.paths.uploadFile=restoreUpload.file;p.paths.uploadSha256='e'.repeat(64);
 assert.equal(Worker.validate(p),p);
});
test('restore input binds exact encrypted upload bytes; passwords obey the same strict UTF8 byte contract as the controller',()=>{
 const p=payload();p.operation='restore';p.upload=restoreUpload;p.paths.targetDirectory=path.resolve(__dirname,'restored');p.paths.uploadFile=restoreUpload.file;
 assert.throws(()=>Worker.validate(p));p.paths.uploadSha256='e'.repeat(64);assert.equal(Worker.validate(p),p);
 for(const password of ['中'.repeat(342),'abcdefghijkl\ud800']){const bad=payload();bad.password=password;assert.throws(()=>Worker.validate(bad));}
 const ancestor=payload();ancestor.paths.backupDirectory=path.dirname(base);assert.throws(()=>Worker.validate(ancestor));
});
test('a generation-zero legacy mode change is an authority conflict before any executor IO',async()=>{
 const f=fixture();f.host.readAuthority=async()=>({generation:0,id:null,mode:'encrypted',proof:{sha256:null}});
 await assert.rejects(f.worker.runCold(f.channel),e=>e.cause.code==='work_data_setup.authority_changed');
 assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.at(-1),'release');
});

test('owned failure hook exposes no password nonce or paths and cannot release owner by returning',async()=>{
 const f=fixture();let seen;f.host.readAuthority=async()=>{throw Object.assign(Error('read failed'),{code:'work_data_setup.authority_unavailable'});};
 f.host.onOwnedFailure=async value=>{seen=value;assert.deepEqual(Object.keys(value.input).sort(),['expectedAuthority','id','operation','parentPid','serve']);assert.equal(value.input.password,undefined);assert.equal(value.input.nonce,undefined);assert.equal(value.input.paths,undefined);assert.equal(value.assertExclusive(value.ownership),true);};
 await assert.rejects(f.worker.runCold(f.channel),error=>error.ownershipRetained===true&&error.helperMayStillRun!==true);assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.includes('release'),false);assert.equal(seen.assertExclusive(seen.ownership),true);
});
test('owned failure hook throw still retains exact owner without labelling a native helper uncertain',async()=>{
 const f=fixture();let seen;f.host.readAuthority=async()=>({generation:1,id:'b'.repeat(48),mode:'encrypted',proof:{sha256:'c'.repeat(64)}});f.host.onOwnedFailure=async value=>{seen=value;throw Object.freeze(Error('hook unexpectedly threw'));};
 await assert.rejects(f.worker.runCold(f.channel),error=>error.ownershipRetained===true&&error.helperMayStillRun!==true);assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.includes('release'),false);assert.equal(seen.assertExclusive(seen.ownership),true);
});
test('bound owned failure hook can wait while exact preexecute owner remains live',async()=>{
 const f=fixture();let seen,release,entered;const observed=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);f.host.readAuthority=async()=>{throw Error('unavailable actual authority');};
 f.host.onOwnedFailure=async value=>{seen=value;entered();await barrier;};const pending=f.worker.runCold(f.channel);await observed;
 assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.includes('release'),false);assert.equal(seen.assertExclusive(seen.ownership),true);release();await assert.rejects(pending,error=>error.ownershipRetained===true);assert.equal(f.calls.includes('release'),false);
});
