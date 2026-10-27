'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(process.env.RUYI_MAINTENANCE_WORKER_SOURCE || path.join(__dirname,'../../ruyi-workbench/app/src/13ai-work-data-worker.js'),'utf8');
const {constBlock}=require('../lib/source-slice');
const Recovery=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/01t-work-data-recovery.js'),'utf8'),'WorkDataRecovery')+'\nWorkDataRecovery',{require,Buffer,process});
const RestoreUploads=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13at-work-data-restore-uploads.js'),'utf8'),'WorkDataRestoreUploads')+'\nWorkDataRestoreUploads',{require,Buffer,process,WorkDataRecovery:Recovery});
// The real claim owner: these cases must bind to 13av's schema, CAS and location,
// not to a local imitation of them.
const Claim=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13av-work-data-handoff-claim.js'),'utf8'),'WorkDataHandoffClaim')+'\nWorkDataHandoffClaim',{require,Buffer,process});
const Worker=vm.runInNewContext(source+'\nWorkDataMaintenanceWorker;', {require,Buffer,process,WorkDataRestoreUploads:RestoreUploads});
// A real base directory is required: the claim owner re-reads its device/inode on
// every write. Each fixture gets its own TEMP so records never cross attempts.
const scratch=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-worker-unit-')));
const base=path.join(scratch,'base');fs.mkdirSync(base);
const backup=path.resolve(__dirname,'backups');
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
let claimSerial=0;
const identityOf=async root=>{const stat=await fsp.lstat(root,{bigint:true});return {dev:String(stat.dev),ino:String(stat.ino)};};
const id='a'.repeat(48), nonce='c'.repeat(64);
// Parser fixture only: this structural handoff is not an issued upload grant or a verified file.
const uploadRoot=path.resolve(__dirname,'upload-custody'),restoreUpload=Object.freeze({schema:1,base,root:uploadRoot,rootIdentity:{dev:'1',ino:'2'},rootNonce:'d'.repeat(64),uploadId:'b'.repeat(48),jobId:id,nonce,file:path.join(uploadRoot,'restore-upload-'+'b'.repeat(48)+'.sealed'),identity:{dev:'1',ino:'3'},bytes:1,sha256:'e'.repeat(64),marker:{dev:'1',ino:'4',sha256:'f'.repeat(64)}});
// A real broker over a real custody directory. The synthetic sealed container is
// only structurally valid; no restore here decrypts it.
async function restoreBroker(jobId){
 const custody=path.join(scratch,'custody-'+jobId.slice(0,8));await fsp.mkdir(custody);
 const ownership={roots:[base,custody]};
 const broker=await RestoreUploads.create({base,root:custody,ownership,assertExclusive:candidate=>candidate===ownership,flush:async()=>{}});
 const bytes=Buffer.from(JSON.stringify({kind:Recovery.KIND,version:Recovery.VERSION,exportId:'a'.repeat(32),kdf:{name:'scrypt',N:32768,r:8,p:1,salt:Buffer.alloc(16).toString('base64')},cipher:'aes-256-gcm',nonce:Buffer.alloc(12).toString('base64'),tag:Buffer.alloc(16).toString('base64'),data:Buffer.from('SYNTHETIC CIPHERTEXT').toString('base64')}));
 let uploadId;try{uploadId=await broker.put(bytes);}finally{bytes.fill(0);}
 const grant=await broker.resolveUpload(uploadId,{jobId});
 return {broker,uploadId,grant,custody};
}
const request=()=>({id,operation:'enable',password:'synthetic password only',expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupDirectory:backup});
const payload=()=>({schema:1,id,nonce,base,parentPid:111,operation:'enable',password:'synthetic password only',
  expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},paths:{backupDirectory:backup,targetDirectory:null,uploadFile:null,uploadSha256:null},serve:{host:'127.0.0.1',port:12345}});
// Thin observation/fault layer over the real 13av instance for one fixture.
function claimHarness(timeline){
 const dir=path.join(scratch,'temp-'+(++claimSerial));fs.mkdirSync(dir);
 const events=[];let failPhase=null,failRemove=false,held=null;
 const inner=Claim.create({temp:dir,flush:async()=>{}});
 const log=label=>{events.push(label);timeline.push('claim:'+label);};
 const api={
  async inspect(options){log('inspect');return inner.inspect(options);},
  async write(record,previous){
   log('attempt:'+record?.phase);
   if(held&&held.phase===record?.phase)await held.promise;
   if(failPhase===record?.phase)throw Object.assign(Error('synthetic claim write refusal'),{code:'work_data_claim.write_failed'});
   const receipt=await inner.write(record,previous);
   log('wrote:'+record.phase);
   return receipt;
  },
  async remove(receipt){log('remove');if(failRemove)throw Object.assign(Error('synthetic claim remove refusal'),{code:'work_data_claim.remove_failed'});return inner.remove(receipt);},
 };
 const found=async () => inner.inspect({base});
 return {api,events,dir,
  value:async()=>{const current=await found();return current.present?current.value:null;},
  receipt:async()=>{const current=await found();return current.present?current.receipt:null;},
  // A record exactly as the warm parent persists it before it may send `go`.
  async seed(change={}){
   const record={schema:1,base,baseIdentity:await identityOf(base),id,nonce,parentPid:111,childPid:222,
    operation:'enable',serve:{host:'127.0.0.1',port:12345},phase:'armed',
    createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
   // A function mutates the template (so a case can drop or add nothing); an object
   // supplies explicit field overrides.
   if(typeof change==='function')change(record);else Object.assign(record,change);
   if(record.base!==base)await fsp.mkdir(record.base,{recursive:true});
   log('seed');
   return inner.write(record,null);
  },
  async advance(phase){const current=await found();log('advance:'+phase);
   return inner.write({...current.value,phase,updatedAt:new Date().toISOString()},current.receipt);},
  writings:()=>events.filter(entry=>entry.startsWith('wrote:')).map(entry=>entry.slice(6)),
  failWrite(phase){failPhase=phase;},failRemove(value){failRemove=value;},
  hold(phase){let release;const promise=new Promise(resolve=>{release=resolve});held={phase,promise};return()=>{held=null;release();};}};
}

// The cold fixture's own pid is 222 and the departed parent is 111, so a record
// seeded before the go binds exactly those two PIDs.
function fixture(options={}){
 const calls=[],timeline=[],timers=new Set();let captured,stopped=0,exited=0;
 const claims=options.claims===undefined?null:claimHarness(timeline);
 const child=new EventEmitter();child.pid=333;child.stdin=new EventEmitter();
 child.stdin.end=(bytes,done)=>{captured=JSON.parse(bytes.toString());done();};
 child.send=(msg,done)=>{calls.push(msg.kind);timeline.push('send:'+msg.kind);done();};
 const host={pid:222,env:{RUYI_INTERNAL_MCP_CAP:'secret',RUYI_MEMORY_CAP:'secret',WCW_TOKEN:'secret',NODE_OPTIONS:'--require bad',
   RUYI_TEST_SERVER_JS:'other',WIN_CLAUDE_WORKBENCH_HOME:'other',HOME:'fixture-home'},
  base:async()=>base,canonical:async p=>p,listener:()=>({host:'127.0.0.1',port:12345}),spawn:()=>child,
  setTimeout:(cb,ms)=>{const t=setTimeout(cb,ms);timers.add(t);return t;},clearTimeout:t=>{clearTimeout(t);timers.delete(t);},
  stopUncommitted:async()=>{stopped++;timeline.push('stop');},exitParent:async()=>{exited++;timeline.push('exit-parent');},
  waitParentExit:async()=>{calls.push('parent-dead');timeline.push('parent-dead');},
  acquire:async roots=>{calls.push('acquire');timeline.push('acquire');return {roots,release:async()=>{calls.push('release');timeline.push('release');}};},
  readAuthority:async()=>{calls.push('authority');timeline.push('authority');return {generation:0,id:null,mode:'plain',proof:{sha256:null}};},
  execute:async context=>{assert.equal(context.assertExclusive(context.ownership),true);assert.equal(context.assertExclusive({roots:[base]}),false);calls.push('execute');timeline.push('execute');return {phase:'done'};},
  helperMayStillRun:()=>false};
 if(claims)host.claim=claims.api;
 if(options.uploads)host.uploads=options.uploads;
 const worker=Worker.create(host);
 const channel={parentConnected:()=>true,parentPid:()=>111,readInput:async()=>Buffer.from(JSON.stringify(payload())),
  send:async msg=>{calls.push(msg.kind);timeline.push('channel:'+msg.kind);},waitCommand:async options=>{await options.onListening();return 'go';}};
 return {worker,host,child,channel,calls,timeline,claims,
  claim:()=>claims?claims.value():Promise.resolve(null),
  seedClaim:overrides=>{assert.ok(claims,'seedClaim needs a claim harness');return claims.seed(overrides);},
  captured:()=>captured,stopped:()=>stopped,exited:()=>exited,
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


// --- Handoff claim lifecycle (warm armed -> cold committed -> owned -> removed) ---
const tick=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
const until=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setImmediate(r));}throw Error('condition did not settle');};

test('warm persists one armed claim bound to both PIDs before ready resolves and never before the child reports ready',async()=>{
 const f=fixture({claims:true});try{
  const h=await f.worker.start(request());
  assert.equal(await f.claim(),null,'no record may exist before the child is listening');
  f.message('ready');await h.ready;
  // The record is produced inside the claim owner's VM realm: compare fields as
  // plain host values rather than cross-realm object identities.
  const claim=JSON.parse(JSON.stringify(await f.claim()));
  assert.deepEqual({schema:claim.schema,base:claim.base,id:claim.id,nonce:claim.nonce,parentPid:claim.parentPid,
    childPid:claim.childPid,operation:claim.operation,serve:claim.serve,phase:claim.phase},
    {schema:1,base,id,nonce:f.captured().nonce,parentPid:222,childPid:333,operation:'enable',serve:{host:'127.0.0.1',port:12345},phase:'armed'});
  assert.deepEqual(claim.baseIdentity,await identityOf(base));
  assert.equal(claim.createdAt,claim.updatedAt,'a first record carries one timestamp');
  assert.deepEqual(f.calls,[],'ready alone still cannot send go or exit');
  const handed=h.handoff();await tick();assert.deepEqual(f.calls,['go']);
  f.message('armed');await handed;
  // The warm side only ever writes `armed`; advancing belongs to the cold child.
  assert.deepEqual(f.claims.writings(),['armed']);assert.equal((await f.claim()).phase,'armed');assert.equal(f.exited(),1);
 }finally{f.cleanup();}
});

test('a restore job is claimed: the armed record names restore and cancel clears only its own record',async()=>{
 const {broker,uploadId,grant}=await restoreBroker(id),target=path.join(scratch,'restored-target');
 const f=fixture({claims:true,uploads:broker});try{
  const h=await f.worker.start({id,operation:'restore',password:'synthetic password only',
   expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupDirectory:backup,targetDirectory:target,uploadId,uploadGrant:grant});
  assert.equal(await f.claim(),null,'no record may exist before the child is listening');
  f.message('ready');await h.ready;
  const claim=JSON.parse(JSON.stringify(await f.claim()));
  assert.equal(claim.operation,'restore');assert.equal(claim.phase,'armed');assert.equal(claim.base,base);
  const input=f.captured();
  assert.equal(input.operation,'restore');assert.equal(input.paths.targetDirectory,target);
  assert.equal(input.upload.uploadId,uploadId);assert.equal(input.paths.uploadFile,input.upload.file);assert.equal(input.paths.uploadSha256,input.upload.sha256);
  assert.deepEqual(f.calls,[],'ready alone still cannot send go or exit');
  await h.cancel();
  assert.equal(await f.claim(),null,'the attempt retires exactly its own restore record');
  assert.equal(f.stopped(),1);
 }finally{f.cleanup();}
});

test('a failed armed claim write rejects ready with no go, stops the child and leaves no record',async()=>{
 const f=fixture({claims:true});f.claims.failWrite('armed');try{
  const h=await f.worker.start(request());f.message('ready');
  await assert.rejects(h.ready,error=>error.code==='work_data_setup.claim_failed'&&error.retry===false
    &&error.operationMayHaveExecuted===false&&error.cause?.code==='work_data_claim.write_failed');
  assert.deepEqual(f.calls,[]);assert.equal(f.stopped(),1);assert.equal(f.worker.busy(),false);assert.equal(await f.claim(),null);
  await assert.rejects(h.handoff(),error=>error.code==='work_data_setup.claim_failed');
  await h.cancel();assert.equal(f.stopped(),1,'a cancelled failed attempt must not stop twice');
 }finally{f.cleanup();}
});

test('duplicate and early messages cannot write the claim twice, arm early or exit before go',async()=>{
 const f=fixture({claims:true});try{
  const h=await f.worker.start(request());
  f.message('ready');f.message('ready');f.message('armed');
  await h.ready;
  assert.deepEqual(f.claims.writings(),['armed'],'exactly one registration despite duplicate ready');
  assert.equal(f.exited(),0);
  f.message('armed');await tick();
  assert.equal(f.calls.includes('go'),false);assert.equal(f.exited(),0);
  const handed=h.handoff();await tick();f.message('armed');f.message('armed');await handed;
  assert.equal(f.exited(),1);assert.equal(f.calls.filter(kind=>kind==='go').length,1);
 }finally{f.cleanup();}
});

test('a child death during registration never resolves ready and clears its own inert armed record',async()=>{
 const f=fixture({claims:true});try{
  const release=f.claims.hold('armed');const h=await f.worker.start(request());f.message('ready');await until(()=>f.claims.events.includes('attempt:armed'));
  assert.equal(f.claims.events.includes('attempt:armed'),true);
  f.child.emit('exit');release();
  await assert.rejects(h.ready,error=>error.code==='work_data_setup.worker_exited');
  await tick();assert.equal(await f.claim(),null);assert.equal(f.calls.includes('go'),false);
 }finally{f.cleanup();}
});

test('cancel clears only its own armed claim and only before the child is stopped',async()=>{
 const f=fixture({claims:true});try{
  const h=await f.worker.start(request());f.message('ready');await h.ready;
  assert.equal((await f.claim()).phase,'armed');
  await h.cancel();
  assert.equal(await f.claim(),null);assert.equal(f.stopped(),1);assert.equal(f.worker.busy(),false);
  assert.ok(f.timeline.indexOf('claim:remove')<f.timeline.indexOf('stop'),'claim cleanup precedes the stop');
  assert.equal(f.timeline.includes('send:cancel'),true);
 }finally{f.cleanup();}
});

test('cancel racing an in-flight armed write removes that record and stops once',async()=>{
 const f=fixture({claims:true});try{
  const release=f.claims.hold('armed');const h=await f.worker.start(request());f.message('ready');await until(()=>f.claims.events.includes('attempt:armed'));
  const first=h.cancel(),second=h.cancel();await tick();assert.equal(f.stopped(),0);
  release();await Promise.all([first,second]);
  await tick();assert.equal(await f.claim(),null);assert.equal(f.stopped(),1);
  await assert.rejects(h.handoff(),error=>error.code==='work_data_setup.handoff_invalid'||error.code==='work_data_setup.cancelled');
 }finally{f.cleanup();}
});

test('committed cancellation still refuses and leaves the armed record for classification',async()=>{
 const f=fixture({claims:true});try{
  const h=await f.worker.start(request());f.message('ready');await h.ready;
  const handed=h.handoff();await tick();
  await assert.rejects(h.cancel(),error=>error.code==='work_data_setup.handoff_committed'&&error.operationMayHaveExecuted===true);
  assert.equal((await f.claim()).phase,'armed');assert.equal(f.claims.events.includes('remove'),false);
  f.message('armed');await handed;
 }finally{f.cleanup();}
});

test('cold verifies the armed record, persists committed before the armed ack and owned before authority',async()=>{
 const f=fixture({claims:true});await f.seedClaim();try{
  const result=await f.worker.runCold(f.channel);
  assert.equal(result.phase,'done');
  assert.deepEqual(f.calls,['ready','armed','parent-dead','acquire','authority','execute','release']);
  assert.deepEqual(f.claims.writings(),['committed','owned']);
  assert.ok(f.timeline.indexOf('claim:wrote:committed')<f.timeline.indexOf('channel:armed'),'committed is durable before the ack');
  assert.ok(f.timeline.indexOf('channel:armed')<f.timeline.indexOf('parent-dead'));
  assert.ok(f.timeline.indexOf('claim:wrote:owned')<f.timeline.indexOf('authority'),'ownership is recorded before authority');
  assert.ok(f.timeline.indexOf('acquire')<f.timeline.indexOf('claim:wrote:owned'));
  assert.equal((await f.claim()).phase,'owned');
 }finally{f.cleanup();}
});

for(const [label,mutate] of [
 ['child pid',record=>{record.childPid=999;}],['nonce',record=>{record.nonce='f'.repeat(64);}],
 ['job id',record=>{record.id='b'.repeat(48);}],['base',record=>{record.base=path.join(scratch,'other-base');}],
 ['parent pid',record=>{record.parentPid=999;}],['listener',record=>{record.serve={host:'127.0.0.1',port:54321};}],
 ['operation',record=>{record.operation='export';}],['base identity',record=>{record.baseIdentity={dev:'1',ino:'2'};}],
 ])test('cold refuses an armed record whose '+label+' is not this attempt',async()=>{
 const f=fixture({claims:true});try{
  // Structurally valid alternatives are persisted; a mismatched base identity is
  // refused by the owner itself. Either way this attempt owns no record.
  await f.seedClaim(mutate).catch(()=>{});
  await assert.rejects(f.worker.runCold(f.channel),error=>error.code==='work_data_setup.worker_failed'
    &&error.cause?.code==='work_data_setup.claim_invalid'&&error.operationMayHaveExecuted===false);
  assert.deepEqual(f.calls,['ready'],'no ack, no acquire, no authority, no execute');
  assert.deepEqual(f.claims.writings(),[]);
 }finally{f.cleanup();}
});

test('cold refuses a record already advanced past armed',async()=>{
 const f=fixture({claims:true});await f.seedClaim();await f.claims.advance('committed');try{
  await assert.rejects(f.worker.runCold(f.channel),error=>error.cause?.code==='work_data_setup.claim_invalid');
  assert.deepEqual(f.calls,['ready']);assert.equal((await f.claim()).phase,'committed');
 }finally{f.cleanup();}
});

test('cold refuses when the parent never persisted an armed record',async()=>{
 const f=fixture({claims:true});try{
  await assert.rejects(f.worker.runCold(f.channel),error=>error.cause?.code==='work_data_setup.claim_invalid');
  assert.deepEqual(f.calls,['ready']);assert.equal(await f.claim(),null);
 }finally{f.cleanup();}
});

test('a failed committed CAS refuses before the ack and before any ownership',async()=>{
 const f=fixture({claims:true});await f.seedClaim();f.claims.failWrite('committed');try{
  await assert.rejects(f.worker.runCold(f.channel),error=>error.code==='work_data_setup.worker_failed'
    &&error.operationMayHaveExecuted===false&&error.cause?.code==='work_data_claim.write_failed');
  assert.deepEqual(f.calls,['ready']);assert.deepEqual(f.claims.writings(),[]);assert.equal((await f.claim()).phase,'armed');
 }finally{f.cleanup();}
});

test('a failed owned write blocks authority and execute and retains the exact owner through the owned-failure hook',async()=>{
 const f=fixture({claims:true});await f.seedClaim();const seen=[];f.claims.failWrite('owned');
 f.host.onOwnedFailure=async value=>{seen.push(value);assert.equal(value.assertExclusive(value.ownership),true);};try{
  await assert.rejects(f.worker.runCold(f.channel),error=>error.code==='work_data_setup.worker_failed_after_handoff'
    &&error.ownershipRetained===true&&error.operationMayHaveExecuted===true&&error.cause?.code==='work_data_claim.write_failed');
  assert.equal(f.calls.includes('authority'),false);assert.equal(f.calls.includes('execute'),false);assert.equal(f.calls.includes('release'),false);
  assert.equal(seen.length,1);assert.equal((await f.claim()).phase,'committed','a durable phase never claims ownership it did not record');
 }finally{f.cleanup();}
});

test('a failed owned write without a hook releases the base and keeps the committed record',async()=>{
 const f=fixture({claims:true});await f.seedClaim();f.claims.failWrite('owned');try{
  await assert.rejects(f.worker.runCold(f.channel),error=>error.operationMayHaveExecuted===true);
  assert.equal(f.calls.includes('authority'),false);assert.equal(f.calls.at(-1),'release');assert.equal((await f.claim()).phase,'committed');
 }finally{f.cleanup();}
});

test('the operation body receives only bounded finish/abandon and retires the owned record once',async()=>{
 const f=fixture({claims:true});await f.seedClaim();const seen=[];f.host.execute=async context=>{
  seen.push(context.claim);
  assert.equal(Object.isFrozen(context.claim),true);
  assert.deepEqual(Object.keys(context.claim).sort(),['abandon','finish']);
  assert.equal((await f.claim()).phase,'owned');
  await context.claim.finish();await context.claim.finish();
  return {phase:'done'};
 };try{
  await f.worker.runCold(f.channel);
  assert.equal(seen.length,1);assert.equal(await f.claim(),null);
  assert.equal(f.claims.events.filter(entry=>entry==='remove').length,1);
 }finally{f.cleanup();}
});

test('a refused claim removal keeps the record and the same capability can be retried',async()=>{
 const f=fixture({claims:true});await f.seedClaim();f.claims.failRemove(true);
 f.host.execute=async context=>{
  await assert.rejects(context.claim.finish(),error=>error.code==='work_data_claim.remove_failed');
  assert.equal((await f.claim()).phase,'owned');
  f.claims.failRemove(false);await context.claim.finish();assert.equal(await f.claim(),null);
  return {phase:'done'};
 };try{await f.worker.runCold(f.channel);assert.equal(await f.claim(),null);}finally{f.cleanup();}
});

test('a host claim API that is present but malformed refuses before spawn or readiness',async()=>{
 for(const broken of [{inspect(){}},{},null]){
  const f=fixture();f.host.claim=broken;
  await assert.rejects(f.worker.start(request()),error=>error.code==='work_data_setup.claim_host_invalid');
  await assert.rejects(f.worker.runCold(f.channel),error=>error.code==='work_data_setup.claim_host_invalid');
  assert.deepEqual(f.calls,[]);f.cleanup();
 }
});

test('without host.claim the legacy fixture path is byte-identical and never inspects a record',async()=>{
 const f=fixture();try{
  const h=await f.worker.start(request());f.message('ready');await h.ready;
  assert.deepEqual(f.calls,[]);assert.equal(f.worker.busy(),true);
  const handed=h.handoff();await tick();f.message('armed');await handed;
  assert.deepEqual(f.calls,['go']);assert.equal(f.exited(),1);
  const cold=fixture();assert.equal((await cold.worker.runCold(cold.channel)).phase,'done');
  assert.deepEqual(cold.calls,['ready','armed','parent-dead','acquire','authority','execute','release']);
 }finally{f.cleanup();}
});
