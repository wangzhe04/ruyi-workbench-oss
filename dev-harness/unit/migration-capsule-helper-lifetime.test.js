'use strict';
// Actual source functions with fake child/timers only. No PowerShell/native/child spawn.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const repo=process.env.RUYI_CAPSULE_REPO||process.cwd();
const {functionBlock,constBlock,bracedBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const source=fs.readFileSync(process.env.RUYI_CAPSULE_HELPER_SOURCE||path.join(repo,'ruyi-workbench/app/src/13u-migration-center.js'),'utf8');
const ops=fs.readFileSync(process.env.RUYI_CAPSULE_OPERATIONS_SOURCE||path.join(repo,'ruyi-workbench/app/src/13ak-work-data-cold-operations.js'),'utf8');
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture(options={}){
 const children=[],timers=new Map();let sequence=0;
 const spawn=(...args)=>{if(options.spawnThrows)throw options.spawnThrows;const child=new EventEmitter();
  Object.assign(child,{pid:options.noPID?undefined:424242,exitCode:null,signalCode:null,ends:0,kills:0,args});child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.resume=()=>{};
  child.stdin.write=(text,callback)=>{child.input=text;if(options.writeThrows)throw options.writeThrows;callback?.(options.pipeError);return true;};
  child.stdin.end=()=>{child.ends++;if(options.endThrows)throw options.endThrows;};child.kill=()=>{child.kills++;if(options.killThrows)throw options.killThrows;return false;};children.push(child);return child;};
 const context={Buffer,process:{platform:'win32',env:{}},MigrationHooks:{},MIGRATION_SKILL_CAPSULE_NATIVE:'unchanged native fixture',MIGRATION_CAPSULE_ARCHIVE_LIMIT:1024,
   migrationRecoverSkillBackups:async()=>{},createMigrationBackupOwner(){},migrationScan(){},migrationApply(){},migrationUndo(){},migrationRecycle(){},migrationCopySkills(){},
   require:name=>name==='node:child_process'?{spawn}:name==='node:timers'?{setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)}:require(name)};
 const fragments=['migrationChain','migrationRecoveryNeeded','migrationBackupAuthority'].map(name=>constBlock(source,name));
 fragments.push(...['migrationCapsuleFail','migrationSerial','migrationCapsuleBroker'].map(name=>functionBlock(source,name)),bracedBlock(source,'Object.assign(MigrationHooks,')+');');
 assert.ok(fragments.every(Boolean));vm.createContext(context);vm.runInContext(fragments.join('\n')+'\nthis.make=migrationCapsuleBroker;this.serial=migrationSerial;',context);
 const fire=ms=>{const entry=[...timers].find(([,value])=>value.ms===ms);assert.ok(entry,'actual timer '+ms+' exists');timers.delete(entry[0]);entry[1].fn();};
 return {context,make:context.make,serial:context.serial,children,timers,fire,unknown:()=>context.MigrationHooks.helperMayStillRun(),
   finish:async()=>{for(const child of children){child.emit('close',0,null);child.emit('exit',0,null);}await tick();}};
}
const observe=promise=>{const state={done:false,value:null,error:null};state.promise=promise.then(value=>{state.done=true;state.value=value;},error=>{state.done=true;state.error=error;});return state;};
const respond=(child,value={})=>child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,value})+'\n'));

test('multi-command responses retain normal business and close waits actualclose, idempotently',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0];try{
  const a=broker.command({cmd:'capture',root:'SYNTHETIC'});respond(child,{one:1});assert.equal((await a).one,1);
  const b=broker.command({cmd:'store-info',root:'SYNTHETIC'});respond(child,{two:2});assert.equal((await b).two,2);
  const first=broker.close(),second=broker.close(),closed=observe(first);assert.equal(first,second);assert.equal(child.ends,1);child.emit('exit',0,null);await tick();assert.equal(closed.done,false);
  child.emit('close',0,null);await closed.promise;assert.equal(closed.error,null);assert.equal(f.unknown(),false);assert.equal(f.timers.size,0);
 }finally{await f.finish();}
});
test('runtime error on an issued PID cannot reject pending work or close before actualclose',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0],pending=observe(broker.command({cmd:'capture'}));try{
  const cause=Object.assign(Error('private runtime detail'),{code:'EPERM'});child.emit('error',cause);await tick();assert.equal(pending.done,false);assert.equal(child.kills,1);
  const closing=observe(broker.close());await tick();assert.equal(closing.done,false);child.emit('close',1,null);await pending.promise;await closing.promise;
  assert.equal(pending.error.code,'work_data_backup.native_unavailable');assert.equal(pending.error.cause,cause);assert.equal(pending.error.helperMayStillRun,undefined);assert.equal(pending.error.message,pending.error.code);assert.equal(f.unknown(),false);
 }finally{await f.finish();}
});
test('close without exit event is actual lifetime proof',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0];try{const pending=broker.command({cmd:'capture'});respond(child);await pending;
  const closing=observe(broker.close());child.emit('close',0,null);await tick();assert.equal(closing.done,true);await closing.promise;assert.equal(closing.error,null);assert.equal(child.exitCode,null);assert.equal(f.timers.size,0);
 }finally{await f.finish();}
});
test('normal close missing actualclose becomes bounded permanent uncertainty and blocks respawn',async()=>{
 const f=fixture(),broker=await f.make(),child=f.children[0];try{const closing=observe(broker.close());child.emit('exit',0,null);await tick();assert.equal(closing.done,false);f.fire(2000);await closing.promise;
  assert.equal(closing.error.helperMayStillRun,true);assert.equal(closing.error.cause.code,'work_data_backup.native_close_timeout');assert.equal(f.unknown(),true);child.emit('close',0,null);assert.equal(f.unknown(),true);await assert.rejects(f.make(),error=>error.helperMayStillRun===true);assert.equal(f.children.length,1);assert.equal(f.timers.size,0);
 }finally{await f.finish();}
});
for(const mode of ['timeout','kill-throws','stdin-event','stdout-event','stderr-event','pipe-callback','pipe-throw','output-limit'])test(mode+' waits actualclose or bounded unknown; first typed reason retained',async()=>{
 const failure=Error('private pipe/kill detail'),f=fixture(mode==='kill-throws'?{killThrows:failure}:mode==='pipe-callback'?{pipeError:failure}:mode==='pipe-throw'?{writeThrows:failure}:{});
 const broker=await f.make(),child=f.children[0],pending=observe(broker.command({cmd:'capture'}));try{
  if(mode==='timeout'||mode==='kill-throws')f.fire(120000);
  if(mode==='stdin-event')child.stdin.emit('error',failure);if(mode==='stdout-event')child.stdout.emit('error',failure);if(mode==='stderr-event')child.stderr.emit('error',failure);
  if(mode==='output-limit')child.stdout.emit('data',Buffer.alloc(1025,97));
  await tick();assert.equal(pending.done,false);assert.equal(child.kills,1);f.fire(2000);await pending.promise;
  assert.equal(pending.error.helperMayStillRun,true);assert.equal(f.unknown(),true);assert.equal(pending.error.message,pending.error.code);assert.equal(pending.error.message.includes('private'),false);
  const expected=mode==='timeout'||mode==='kill-throws'?'native_timeout':mode==='output-limit'?'native_limit':'native_pipe';assert.equal(pending.error.cause.code,'work_data_backup.'+expected);
  const closing=observe(broker.close());await closing.promise;assert.equal(closing.error.helperMayStillRun,true);child.emit('close',0,null);assert.equal(f.unknown(),true);assert.equal(f.timers.size,0);
 }finally{await f.finish();}
});
test('confirmed noPID spawn failure and synchronous spawn throw have no unknown helper',async()=>{
 const cause=Object.assign(Error('private launch detail'),{syscall:'spawn powershell.exe',code:'ENOENT'}),f=fixture({noPID:true});const broker=await f.make(),pending=observe(broker.command({cmd:'capture'}));
 f.children[0].emit('error',cause);await pending.promise;assert.equal(pending.error.helperMayStillRun,undefined);const closing=observe(broker.close());await closing.promise;assert.equal(closing.error.cause,cause);assert.equal(f.unknown(),false);assert.equal(f.timers.size,0);
 const thrown=fixture({spawnThrows:cause});await assert.rejects(thrown.make(),error=>error.code==='work_data_backup.native_unavailable'&&error.cause===cause&&error.helperMayStillRun===undefined);assert.equal(thrown.children.length,0);assert.equal(thrown.unknown(),false);
});
test('queued migration and future skill read admission cannot continue after global helper uncertainty',async()=>{
 const f=fixture();let release,entered=0;const gate=new Promise(resolve=>release=resolve),first=observe(f.serial(async()=>{entered++;await gate;}));await tick();const queued=observe(f.context.MigrationHooks.withSkillRead(async()=>{entered++;}));
 const broker=await f.make(),closing=observe(broker.close());f.fire(2000);await closing.promise;release();await first.promise;await queued.promise;
 assert.equal(first.error.helperMayStillRun,true);assert.equal(queued.error.helperMayStillRun,true);assert.equal(entered,1);await assert.rejects(f.serial(async()=>entered++),error=>error.helperMayStillRun===true);assert.equal(entered,1);await f.finish();
});
test('cold-operation exact release function refuses a washed cause through global capsule latch',async()=>{
 let unknown=false,releases=0;const owner={release:async()=>releases++},context={MigrationHooks:{helperMayStillRun:()=>unknown},LocalSecretCrypto:{},host:{helperMayStillRun:()=>false},owned:new Set([owner]),owner,
   fail:(suffix,extra)=>Object.assign(Error(suffix),{code:suffix,...extra})};
 vm.createContext(context);vm.runInContext('let helperUncertain=false;'+constBlock(ops,'retainHelper')+'\n'+constBlock(ops,'release')+'\nthis.releaseOwner=release;this.inspect=retainHelper;',context);
 assert.equal(context.inspect(null),false);unknown=true;await assert.rejects(context.releaseOwner(owner),error=>error.helperMayStillRun===true);assert.equal(releases,0);assert.equal(context.owned.has(owner),true);unknown=false;assert.equal(context.inspect(null),true);
});
test('cold-operation exact release still releases proven settled owners once',async()=>{
 let releases=0;const owner={release:async()=>releases++},context={MigrationHooks:{helperMayStillRun:()=>false},LocalSecretCrypto:{helperMayStillRun:()=>false},host:{helperMayStillRun:()=>false},owned:new Set([owner]),owner,fail:suffix=>Error(suffix)};
 vm.createContext(context);vm.runInContext('let helperUncertain=false;'+constBlock(ops,'retainHelper')+'\n'+constBlock(ops,'release')+'\nthis.releaseOwner=release;',context);await context.releaseOwner(owner);assert.equal(releases,1);assert.equal(context.owned.has(owner),false);
});
