'use strict';
// 151 阶段 3D(150 号文 W12):冷进程握手的固定超时改成心跳续期。真实 13ai 源码 + 假子进程/假计时器:
//   - 父进程在 ready 之后、go 之前每 2 s 发 hold;发出 go 后不再发;
//   - 父进程 arm 计时被子进程的 arming 心跳续期,只有真的没有心跳才 worker_arm_timeout(仍按已承诺报不确定);
//   - 子进程等 go 的计时被 hold 续期(总等待有上限);子进程在承诺记录落盘期间发 arming。
const {test,after}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(process.env.RUYI_MAINTENANCE_WORKER_SOURCE||path.join(__dirname,'../../ruyi-workbench/app/src/13ai-work-data-worker.js'),'utf8');
const Worker=vm.runInNewContext(source+'\nWorkDataMaintenanceWorker;',{require,Buffer,process,setTimeout,clearTimeout,setInterval,clearInterval,Date,Promise});
const scratch=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-worker-heartbeat-')));
const base=path.join(scratch,'base');fs.mkdirSync(base);
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const id='a'.repeat(48),backup=path.join(scratch,'backups');
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
const request=()=>({id,operation:'export',password:'synthetic password only',expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},backupDirectory:backup});

test('private child spawn keeps the packaged application entry point and IPC',()=>{
 const spawned={};
 const worker=vm.runInNewContext(source+'\nWorkDataMaintenanceWorker;',{
  process,require:name=>name==='node:child_process'?{spawn:(command,args,options)=>Object.assign(spawned,{command,args,options})}:require(name)
 });
 const env={RUYI_HOME:base,PKG_EXECPATH:'Ruyi.exe'};
 assert.equal(worker.spawnCold({command:'Ruyi.exe',args:['work-data-maintenance']},env),spawned);
 assert.equal(spawned.command,'Ruyi.exe');
 assert.deepEqual(spawned.args,['work-data-maintenance']);
 assert.deepEqual({...spawned.options.env},{RUYI_HOME:base,PKG_EXECPATH:''});
 assert.deepEqual([...spawned.options.stdio],['pipe','ignore','ignore','ipc']);
 assert.equal(env.PKG_EXECPATH,'Ruyi.exe');
});

function parentFixture({claim}={}){
 const timers=new Map();let sequence=0,captured=null;const sent=[];
 const child=new EventEmitter();child.pid=333;child.stdin=new EventEmitter();
 child.stdin.end=(bytes,done)=>{captured=JSON.parse(bytes.toString());done?.();};
 child.send=(message,done)=>{sent.push(message.kind);done?.();};
 const host={pid:222,env:{},base:async()=>base,canonical:async p=>p,listener:()=>({host:'127.0.0.1',port:12345}),spawn:()=>child,
  setTimeout:(fn,ms)=>{const timer=++sequence;timers.set(timer,{fn,ms});return timer;},clearTimeout:timer=>timers.delete(timer),
  stopUncommitted:async()=>{},exitParent:async()=>{},helperMayStillRun:()=>false,...(claim?{claim}:{})};
 const worker=Worker.create(host);
 const fire=ms=>{const entry=[...timers].find(([,value])=>value.ms===ms);assert.ok(entry,'timer '+ms);timers.delete(entry[0]);entry[1].fn();};
 const count=ms=>[...timers.values()].filter(value=>value.ms===ms).length;
 return {worker,child,sent,timers,fire,count,message:kind=>child.emit('message',{schema:1,id,nonce:captured.nonce,kind})};
}

test('parent: hold heartbeats flow only between ready and go; arming renews the arm deadline',async()=>{
 const f=parentFixture(),h=await f.worker.start(request());f.message('ready');await h.ready;
 f.fire(2000);f.fire(2000);await tick();assert.deepEqual(f.sent,['hold','hold'],'hold is sent while the parent has not committed');
 const committing=h.commit();await tick();assert.deepEqual(f.sent,['hold','hold','go']);
 assert.equal(f.count(15000),1,'one arm deadline');
 for(let n=0;n<5;n++){f.message('arming');await tick();assert.equal(f.count(15000),1,'arming replaces the arm deadline');}
 f.fire(2000);await tick();assert.deepEqual(f.sent,['hold','hold','go'],'no hold after go');assert.equal(f.count(2000),0,'the hold chain ends once committing');
 f.message('armed');await committing;assert.equal(f.count(15000),0);
});

test('parent: a committed child without any heartbeat still times out as uncertain',async()=>{
 const f=parentFixture(),h=await f.worker.start(request());f.message('ready');await h.ready;
 const committing=h.commit().then(()=>null,error=>error);await tick();f.message('arming');await tick();f.fire(15000);
 const error=await committing;assert.equal(error.code,'work_data_setup.handoff_uncertain');assert.equal(error.operationMayHaveExecuted,true);
 const failure=await h.failure;assert.equal(failure.code,'work_data_setup.worker_arm_timeout');assert.equal(failure.operationMayHaveExecuted,true);
});

// v2(审查 M1):子进程等 go 的计时从它报 ready 起算,父进程随后要先登记 claim(写+刷盘)。登记超过 15 s 时
// 若不发 hold,子进程会 commit_timeout;改后 registering 期间同样发 hold,登记慢也能完成交接。
test('parent: hold is also sent while the claim registration after ready is still in flight (> 15 s)',async()=>{
 let releaseWrite=null;
 const claim={inspect:async()=>({present:false}),write:()=>new Promise(resolve=>{releaseWrite=()=>resolve({receipt:1});}),remove:async()=>{}};
 const g=parentFixture({claim}),h=await g.worker.start(request());g.message('ready');
 for(let n=0;n<50&&!releaseWrite;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(typeof releaseWrite,'function','claim write in flight');
 for(let n=0;n<8;n++){g.fire(2000);await tick();}
 assert.equal(g.sent.filter(kind=>kind==='hold').length,8,'16 s of registration keeps the waiting child alive: '+g.sent.join(','));
 releaseWrite();await h.ready;const committing=h.commit();await tick();assert.equal(g.sent.at(-1),'go');g.message('armed');await committing;
});

test('parent: arming heartbeats cannot extend the arm phase past its total ceiling',async()=>{
 const f=parentFixture(),h=await f.worker.start(request());f.message('ready');await h.ready;
 const committing=h.commit().then(()=>null,error=>error);await tick();assert.equal(f.count(Worker.ARM_MAX_MS),1,'one arm ceiling');
 for(let n=0;n<20;n++){f.message('arming');await tick();}
 assert.equal(f.count(15000),1);f.fire(Worker.ARM_MAX_MS);
 const error=await committing;assert.equal(error.code,'work_data_setup.handoff_uncertain');
 const failure=await h.failure;assert.equal(failure.code,'work_data_setup.worker_arm_timeout');assert.equal(failure.operationMayHaveExecuted,true);
});

test('child: hold renews the wait for go within its total bound; silence times out',async()=>{
 const proc=new EventEmitter();proc.connected=true;proc.send=(message,done)=>{done?.();};proc.ppid=111;proc.stdin=new EventEmitter();
 const channel=Worker.processChannel(proc),nonce='c'.repeat(64),hold=()=>proc.emit('message',{schema:1,id,nonce,kind:'hold'});
 const waiting=channel.waitCommand({id,nonce,schema:1,timeoutMs:60,onListening:()=>{}});
 for(let n=0;n<5;n++){await new Promise(resolve=>setTimeout(resolve,40));hold();}
 proc.emit('message',{schema:1,id,nonce,kind:'go'});assert.equal(await waiting,'go','200 ms of holds kept a 60 ms wait open');
 const silent=channel.waitCommand({id,nonce,schema:1,timeoutMs:60,onListening:()=>{}});
 await assert.rejects(silent,error=>error.code==='work_data_setup.commit_timeout');
});

test('child: arming heartbeats are sent while the committed claim is being written',{timeout:20000},async()=>{
 const sent=[],record={schema:1,base,baseIdentity:{dev:'1',ino:'2'},id,nonce:'c'.repeat(64),parentPid:111,childPid:222,operation:'export',serve:{host:'127.0.0.1',port:12345},phase:'armed',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
 const claim={inspect:async()=>({present:true,value:record,receipt:{}}),write:async next=>{if(next.phase==='committed')await new Promise(resolve=>setTimeout(resolve,2600));return {written:true};},remove:async()=>{}};
 const host={pid:222,env:{},claim,canonical:async p=>p,base:async()=>base,waitParentExit:async()=>{sent.push('parent-dead');},
  acquire:async roots=>({roots,release:async()=>{}}),readAuthority:async()=>({generation:0,id:null,mode:'plain',proof:{sha256:null}}),execute:async()=>({phase:'done'}),helperMayStillRun:()=>false};
 const payload={schema:1,id,nonce:'c'.repeat(64),base,parentPid:111,operation:'export',password:'synthetic password only',expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},
  paths:{backupDirectory:backup,targetDirectory:null,uploadFile:null,uploadSha256:null},serve:{host:'127.0.0.1',port:12345}};
 const channel={parentConnected:()=>true,parentPid:()=>111,readInput:async()=>Buffer.from(JSON.stringify(payload)),send:async message=>{sent.push(message.kind);},waitCommand:async options=>{await options.onListening();return 'go';}};
 await Worker.create(host).runCold(channel);
 const armed=sent.indexOf('armed');assert.ok(armed>0);
 assert.ok(sent.slice(0,armed).filter(kind=>kind==='arming').length>=1,'arming heartbeats during a 2.6 s claim write: '+sent.join(','));
 assert.equal(sent.slice(armed+1).includes('arming'),false,'no arming after armed');
});

// v3(审查 R2-3):arm 上限由两次刷盘的合法上界推出(不是魔数),并与 01w 导出的上界一致;
// 不确定的失败(arm 心跳超时)结算后,上限计时器不再挂着。
test('arm ceiling is derived from two flush bounds plus margin and matches the 01w flush bound',()=>{
 const publish=require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../ruyi-workbench/app/src/01w-work-data-native-publish.js'),'utf8')+'\nWorkDataNativePublish;',{Buffer,require,process:{platform:'linux',env:{}},WorkDataManifest:{Hooks:{}},setTimeout,clearTimeout});
 assert.equal(Worker.FLUSH_BOUND_MS,publish.FLUSH_BOUND_MS,'the standalone fallback equals the exported 01w bound');
 assert.ok(Worker.ARM_MAX_MS>=2*publish.FLUSH_BOUND_MS,'room for both claim flushes of the arm phase');assert.equal(Worker.ARM_MAX_MS,240000);
});
test('an uncertain arm failure clears the arm ceiling timer',async()=>{
 const f=parentFixture(),h=await f.worker.start(request());f.message('ready');await h.ready;
 const committing=h.commit().then(()=>null,error=>error);await tick();assert.equal(f.count(Worker.ARM_MAX_MS),1);
 f.fire(15000);const error=await committing;assert.equal(error.code,'work_data_setup.handoff_uncertain');
 assert.equal(f.count(Worker.ARM_MAX_MS),0,'no arm ceiling outlives the settled uncertain failure');
});
