'use strict';
// 151 阶段 3D(150 号文 W12):原生 broker 命令的超时与 uncertain 解耦。真实 13u 源码切片 + 假子进程/假计时器
// (与 migration-capsule-helper-lifetime 同一种夹具);不起 PowerShell。
//   - 心跳行 {"progress":n}(n 单调递增)只给当前命令续期,从不结算它;
//   - 真的停滞(120 s 没有任何一行)才超时,超时码带类型化详情 timeout{kind,command,stallSeconds,elapsedSeconds,heartbeats};
//   - 非递增的「心跳」不是心跳,按不可理解的回复处理。
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const repo=process.env.RUYI_CAPSULE_REPO||process.cwd();
const {functionBlock,constBlock,bracedBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const source=fs.readFileSync(process.env.RUYI_CAPSULE_HELPER_SOURCE||path.join(repo,'ruyi-workbench/app/src/13u-migration-center.js'),'utf8');
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture({killCloses=false}={}){
 const children=[],timers=new Map();let sequence=0;
 const spawn=(...args)=>{const child=new EventEmitter();
  Object.assign(child,{pid:424242,exitCode:null,signalCode:null,ends:0,kills:0,args});child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.resume=()=>{};
  child.stdin.write=(text,callback)=>{child.input=text;callback?.();return true;};
  child.stdin.end=()=>{child.ends++;};child.kill=()=>{child.kills++;if(killCloses)queueMicrotask(()=>child.emit('close',1,null));return false;};children.push(child);return child;};
 const context={Buffer,process:{platform:'win32',env:{},hrtime:{bigint:()=>0n}},MigrationHooks:{},MIGRATION_SKILL_CAPSULE_NATIVE:'unchanged native fixture',MIGRATION_CAPSULE_ARCHIVE_LIMIT:1024,
   migrationRecoverSkillBackups:async()=>{},createMigrationBackupOwner(){},migrationScan(){},migrationApply(){},migrationUndo(){},migrationRecycle(){},migrationCopySkills(){},
   readWorkDataControlPreserved(){throw Error('outside fixture');},queueMicrotask,Date,
   require:name=>name==='node:child_process'?{spawn}:name==='node:timers'?{setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)}:require(name)};
 const fragments=['migrationCapsuleCode','migrationChain','migrationRecoveryNeeded','migrationBackupAuthority','migrationCapsuleIssuedChildren','migrationCapsuleBrokerChildren'].map(name=>constBlock(source,name));
 fragments.push(...['migrationCapsuleFail','migrationSerial','migrationCapsuleBroker'].map(name=>functionBlock(source,name)),bracedBlock(source,'Object.assign(MigrationHooks,')+');');
 assert.ok(fragments.every(Boolean));vm.createContext(context);vm.runInContext(fragments.join('\n')+'\nthis.make=migrationCapsuleBroker;',context);
 const stall=()=>[...timers.values()].filter(value=>value.ms===120000);
 const fire=ms=>{const entry=[...timers].find(([,value])=>value.ms===ms);assert.ok(entry,'actual timer '+ms+' exists');timers.delete(entry[0]);entry[1].fn();};
 return {make:context.make,children,timers,stall,fire,unknown:()=>context.MigrationHooks.helperMayStillRun(),
  finish:async()=>{for(const child of children){child.emit('close',0,null);child.emit('exit',0,null);}await tick();}};
}
const observe=promise=>{const state={done:false,value:null,error:null};state.promise=promise.then(value=>{state.done=true;state.value=value;},error=>{state.done=true;state.error=error;});return state;};
const line=(child,value)=>child.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n'));

test('heartbeat lines renew the stall deadline of the pending command and never settle it',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0];try{
  const pending=observe(broker.command({cmd:'capture-preserved-census-first',root:'SYNTHETIC'}));
  assert.equal(f.stall().length,1);const first=f.stall()[0];
  for(let n=1;n<=3;n++){line(child,{progress:n});await tick();assert.equal(pending.done,false,'a heartbeat never settles the command');assert.equal(f.stall().length,1,'exactly one live stall timer');}
  assert.notEqual(f.stall()[0],first,'the original deadline was replaced');
  line(child,{ok:true,value:{done:1}});await pending.promise;assert.equal(pending.value.done,1);assert.equal(f.stall().length,0);
  // A later command starts with a fresh full stall window and its own heartbeat count.
  const next=observe(broker.command({cmd:'store-info',root:'SYNTHETIC'}));line(child,{progress:1});await tick();assert.equal(next.done,false);
  line(child,{ok:true,value:{n:2}});await next.promise;assert.equal(next.value.n,2);
 }finally{await f.finish();}
});

test('a real stall times out with a typed timeout detail; heartbeats before it make the kind stalled',async()=>{
 for(const [beats,kind] of [[0,'no-progress'],[2,'stalled']]){
  const f=fixture({killCloses:true}),broker=await f.make(),child=f.children[0];try{
   const pending=observe(broker.command({cmd:'capture-preserved-census-first',root:'SYNTHETIC'}));
   for(let n=1;n<=beats;n++){line(child,{progress:n});await tick();}
   f.fire(120000);await tick();await pending.promise;
   const error=pending.error;assert.equal(error.code,'work_data_backup.native_timeout');assert.equal(error.retry,false);
   assert.equal(error.helperMayStillRun,undefined,'a confirmed close after the stall is not an unknown helper');
   assert.deepEqual({...error.timeout,elapsedSeconds:0},{kind,command:'capture-preserved-census-first',stallSeconds:120,elapsedSeconds:0,heartbeats:beats});
   assert.ok(Number.isSafeInteger(error.timeout.elapsedSeconds)&&error.timeout.elapsedSeconds>=0);
   assert.equal(JSON.stringify(error.timeout).includes('SYNTHETIC'),false,'no path in the timeout detail');
  }finally{await f.finish();}
 }
});

// v2(审查 L2):心跳续期之外还有按普查预算推算的兜底总上限(10 分钟 + 200,001 × 50 ms),到点报 kind 'ceiling'。
test('a command that keeps sending heartbeats still stops at its budget-derived ceiling with a typed timeout',async()=>{
 const f=fixture({killCloses:true}),broker=await f.make(),child=f.children[0];try{
  const CEILING=600000+200001*50;
  const pending=observe(broker.command({cmd:'capture-preserved-census-first',root:'SYNTHETIC'}));
  assert.equal([...f.timers.values()].filter(value=>value.ms===CEILING).length,1,'one ceiling per command');
  for(let n=1;n<=5;n++){line(child,{progress:n});await tick();}
  f.fire(CEILING);await tick();await pending.promise;
  assert.equal(pending.error.code,'work_data_backup.native_timeout');assert.equal(pending.error.timeout.kind,'ceiling');assert.equal(pending.error.timeout.heartbeats,5);
  assert.equal(pending.error.timeout.command,'capture-preserved-census-first');
  assert.equal([...f.timers.values()].filter(value=>value.ms===CEILING).length,0,'the ceiling timer is cleared once the command settles');
 }finally{await f.finish();}
 const g=fixture(),other=await g.make(),child2=g.children[0];try{
  const done=observe(other.command({cmd:'store-info',root:'SYNTHETIC'}));line(child2,{ok:true,value:{}});await done.promise;
  assert.equal([...g.timers.values()].filter(value=>value.ms===600000+200001*50).length,0,'a settled command leaves no ceiling behind');
  // v2(审查 L3):助手不继承宿主 cwd。
  assert.match(String(child2.args[2]?.cwd),/^[A-Za-z]:\\[^\\]+\\System32$/i);
 }finally{await g.finish();}
});

test('a non-increasing progress line is not a heartbeat and fails the command instead of extending it',async()=>{
 const f=fixture({killCloses:true}),broker=await f.make(),child=f.children[0];try{
  const pending=observe(broker.command({cmd:'capture',root:'SYNTHETIC'}));line(child,{progress:2});await tick();line(child,{progress:2});await tick();
  await pending.promise;assert.equal(pending.error.code,'work_data_backup.native_unavailable');
 }finally{await f.finish();}
});

test('close-time heartbeats renew the bounded close window; silence after them still latches an uncertain helper',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0];try{
  const done=observe(broker.command({cmd:'capture',root:'SYNTHETIC'}));line(child,{ok:true,value:{}});await done.promise;
  const closing=observe(broker.close());child.emit('exit',0,null);await tick();
  const windowOf=()=>[...f.timers.values()].filter(value=>value.ms===2000);assert.equal(windowOf().length,1);const first=windowOf()[0];
  for(let n=10;n<13;n++){line(child,{progress:n});await tick();assert.equal(windowOf().length,1);assert.equal(closing.done,false);}
  assert.notEqual(windowOf()[0],first,'the close window was renewed by heartbeats');
  line(child,{progress:5});line(child,{other:1});await tick();
  f.fire(2000);await closing.promise;assert.equal(closing.error.helperMayStillRun,true);assert.equal(closing.error.cause.code,'work_data_backup.native_close_timeout');
  assert.equal(f.unknown(),true,'a helper that stops reporting during close is still uncertain');
 }finally{await f.finish();}
});

test('the native helper emits heartbeats from its census, file IO and per-node loops only inside the command loop',()=>{
 const beat=source.slice(source.indexOf('  static void Beat()'),source.indexOf('\n',source.indexOf('  static void Beat()')));
 assert.ok(beat.includes('BeatClock.ElapsedMilliseconds < 1000'),'at most one line per second (inside the 2 s close window)');assert.ok(beat.includes('!BeatEnabled'));
 assert.ok(/static void Walk\([^]*?path=NativePath\(path\); Beat\(\);/.test(source),'every census entry is a progress point');
 assert.ok(/static byte\[\] Read\(SafeFileHandle handle\)[^]*?Beat\(\); byte\[\] buffer/.test(source));
 assert.ok(/static void Write\(SafeFileHandle handle, byte\[\] bytes\)[^]*?Beat\(\); byte\[\] buffer/.test(source));
 const run=source.slice(source.indexOf('  public static void Run() {'),source.indexOf('int censusPhase=0',source.indexOf('  public static void Run() {')));
 assert.ok(run.includes('BeatEnabled = true'),'heartbeats are enabled only by the command loop');
});
