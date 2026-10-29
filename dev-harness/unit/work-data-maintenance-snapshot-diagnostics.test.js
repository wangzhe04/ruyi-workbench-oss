'use strict';
// Pure in-memory capture faults only: no service, network, IPC or native probe.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {capturePackageSnapshot,maintenanceIsQuiet,waitMaintenanceQuiet}=require('../work-data-production-maintenance.e2e');
const core=require('../lib/work-data-production-upload-core');
const fixture={base:path.resolve('synthetic-maintenance-data'),backups:path.resolve('synthetic-maintenance-backups')};
const roots=[path.join(fixture.base,'.work-data'),fixture.backups,path.join(fixture.base,'sessions','sess_maintenance_synthetic.json')];
const names=['control','backup','session'];
function memory(failAt,error){
 const calls=[],rows=[{files:[{file:'control-row'}],directories:[]},{files:[{file:'backup-row'}],directories:[]},{row:{file:'session-row'}}];
 const read=file=>{const index=roots.indexOf(file);assert.notEqual(index,-1);calls.push(file);if(index===failAt)throw error;return rows[index];};
 return{calls,rows,source:{inventory:read,read}};
}
for(const when of ['before','after'])for(let index=0;index<3;index++)test(when+' '+names[index]+' ENOENT retains the first error and never retries a capture',()=>{
 const file=index===2?roots[index]:path.join(roots[index],'generations','synthetic','index.1234.tmp');
 const error=Object.assign(Error('SYNTHETIC password and raw body are not metadata'),{code:'ENOENT',syscall:'lstat',path:file});
 const f=memory(index,error),observations=[];
 assert.throws(()=>capturePackageSnapshot(fixture,when,value=>observations.push(value),f.source),found=>found===error);
 assert.deepEqual(f.calls,roots.slice(0,index+1),'the failing component is captured once and later components are never read');
 assert.equal(observations.length,1);
 const value=observations[0];
 assert.equal(value.when,when);assert.equal(value.component,names[index]);assert.deepEqual(value.completedComponents,names.slice(0,index));
 assert.equal(value.code,'ENOENT');assert.equal(value.syscall,'lstat');
 assert.equal(value.path,index===2?'.':path.join('generations','synthetic','index.1234.tmp'));
 assert.equal(value.pathSha256,core.H(Buffer.from(file)));assert.equal(value.rawMessagesAndBodiesOmitted,true);
 assert.equal(JSON.stringify(value).includes('password'),false);assert.equal(JSON.stringify(value).includes(fixture.base),false);
});
test('a complete capture keeps every original scope and inventory row for the unchanged equality assertion',()=>{
 const f=memory(-1),value=capturePackageSnapshot(fixture,'before',()=>assert.fail('unexpected diagnostic'),f.source);
 assert.deepEqual(f.calls,roots);assert.deepEqual(Object.keys(value),names);
 assert.strictEqual(value.control,f.rows[0]);assert.strictEqual(value.backup,f.rows[1]);assert.strictEqual(value.session,f.rows[2].row);
});
test('diagnostic sink failure leaves the original capture error as the failure',()=>{
 const original=Object.assign(Error('original capture error'),{code:'ENOENT'}),f=memory(0,original);
 assert.throws(()=>capturePackageSnapshot(fixture,'after',()=>{throw Error('diagnostic write failed');},f.source),error=>error===original);
 assert.deepEqual(f.calls,[roots[0]]);
});
test('outside or relative error paths are hashed without disclosing them or inventing a missing path',()=>{
 for(const file of [path.resolve('outside-private','password-value'),path.join('..','password-value')]){
  const error=Object.assign(Error('raw message'),{code:'ENOENT',syscall:'lstat',path:file}),f=memory(0,error),rows=[];
  assert.throws(()=>capturePackageSnapshot(fixture,'before',value=>rows.push(value),f.source),found=>found===error);
  assert.equal(rows[0].path,null);assert.equal(rows[0].pathSha256,core.H(Buffer.from(file)));
  assert.equal(JSON.stringify(rows[0]).includes('password-value'),false);
 }
 const original=Error('unknown missing path'),f=memory(0,original),rows=[];
 assert.throws(()=>capturePackageSnapshot(fixture,'before',value=>rows.push(value),f.source),error=>error===original);
 assert.equal(rows[0].path,null);assert.equal(rows[0].pathSha256,null);assert.equal(rows[0].code,null);assert.equal(rows[0].syscall,null);
});
test('assertion capture failures omit assertion values and do not evaluate metadata getters',()=>{
 let reads=0;const error=Object.assign(new assert.AssertionError({actual:'SECRET body',expected:'SECRET body2',operator:'deepStrictEqual'}),{code:'not a bounded code',syscall:'SECRET syscall'});
 Object.defineProperty(error,'path',{get(){reads++;throw Error('must not read path');}});
 const f=memory(1,error),rows=[];
 assert.throws(()=>capturePackageSnapshot(fixture,'after',value=>rows.push(value),f.source),found=>found===error);
 assert.equal(reads,0);assert.equal(rows[0].code,null);assert.equal(rows[0].syscall,null);assert.equal(rows[0].path,null);
 assert.equal(rows[0].errorName,'AssertionError');assert.equal(JSON.stringify(rows[0]).includes('SECRET'),false);
});

const fs=require('node:fs'),vm=require('node:vm'),{constBlock,functionBlock}=require('../lib/source-slice');
const source=file=>fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src',file),'utf8');
const maintenance=vm.runInNewContext(constBlock(source('13ag-work-data-maintenance.js'),'WorkDataMaintenance')+'\nWorkDataMaintenance',{require});
const projection=source('13e-pretender-index.js'),harness=fs.readFileSync(path.join(__dirname,'../work-data-production-maintenance.e2e.js'),'utf8');
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate),turns=async()=>{for(let i=0;i<4;i++)await tick();};
function startup(){
 const reading=defer(),building=defer(),writing=defer(),counts={read:0,build:0,write:0,timers:0};
 const runtime={building:null,value:null,writeChain:Promise.resolve(),writers:0,persisted:true,verifyTimer:null,verifyScan:null,lastVerifyAt:Date.now()};
 const busy=()=>({turns:0,agentRuns:0,scheduler:0,steward:0,externalBots:0,consumers:0,internalMcp:0,index:Number(!!runtime.building)+runtime.writers,shells:0,services:0});
 const m=maintenance.create({owns:()=>false,snapshot:()=>({pending:[runtime.writeChain],busy:busy(),dirty:0}),pause:()=>null,resume:()=>{},flush:async()=>{},yield:tick});
 const context={WorkDataMaintenanceHooks:m,paths:{sessions:'MEMORY ONLY'},pretenderIndexRuntime:runtime,PRETENDER_VERIFY_MS:30000,Date,Math,
  fsp:{readdir:async()=>{counts.read++;return reading.promise;}},setTimeout:()=>{counts.timers++;return{unref(){}};},
  buildOrLoadPretenderIndex:async()=>{counts.build++;await building.promise;await api.write({});runtime.value={};return runtime.value;},
  writePretenderIndexFileNow:async()=>{counts.write++;runtime.writers++;try{return await writing.promise;}finally{runtime.writers--;}}};
 const code=['warmPretenderProjectionIndex','getPretenderProjectionIndex','getPretenderProjectionIndexShared','writePretenderIndexFile','pretenderScheduleVerify'].map(name=>functionBlock(projection,name)).join('\n');
 const api=vm.runInNewContext(code+'\n({warm:warmPretenderProjectionIndex,write:writePretenderIndexFile})',context);
 const status=()=>({capabilities:{worker:true},maintenance:m.status()});
 return{m,api,reading,building,writing,counts,runtime,status};
}
test('actual startup warm is admitted before its first read; worker-only readiness arrives before the tracked read/build/write finish',async()=>{
 const f=startup(),warm=f.api.warm();let complete=false;warm.then(()=>{complete=true;});
 assert.equal(f.counts.read,1);assert.equal(f.m.status().admitted,1);assert.equal(f.runtime.building,null);assert.equal(f.m.status().writers,0);
 assert.equal(maintenanceIsQuiet(f.status()),false,'admission closes the gap before build/write counters exist');
 const real=functionBlock(harness,'waitWorkerReady'),mutant=real.replace('&&maintenanceIsQuiet(value)','');
 assert.notEqual(mutant,real,'negative control removes only the new quiet precondition');
 const early=vm.runInNewContext(mutant+'\nwaitWorkerReady',{Date:{now:()=>0},BUDGET:{startup:1000,request:1000},statusOf:async()=>f.status(),sleep:()=>assert.fail('worker-only control unexpectedly waited')});
 assert.equal((await early({})).capabilities.worker,true);assert.equal(complete,false,'old worker-only predicate accepts the still-admitted startup read');
 let step=0;const seen=[];
 const strict=vm.runInNewContext(real+'\nwaitWorkerReady',{Date:{now:()=>0},BUDGET:{startup:1000,request:1000},maintenanceIsQuiet,
  statusOf:async()=>{const value=f.status();seen.push(value.maintenance);return value;},sleep:async()=>{
  if(step===0)f.reading.resolve(['sess_synthetic.json']);else if(step===1)f.building.resolve();else if(step===2)f.writing.resolve(true);else assert.fail('tracked operation never settled');
  step++;await turns();
 }});
 const result=await strict({});
 await warm;assert.equal(complete,true);assert.equal(maintenanceIsQuiet(result),true);assert.equal(step,3);
 assert.equal(seen[0].admitted,1);assert.ok(seen.some(value=>value.busy.index>0));assert.ok(seen.some(value=>value.writers>0));
 assert.equal(f.counts.write,1,'one original write, no retry or filesystem recapture');
});
test('package quiet observation waits for the same real admitted startup scope before its single snapshot',async()=>{
 const f=startup(),warm=f.api.warm();let snapshots=0,polls=0;
 const result=await waitMaintenanceQuiet(async()=>{polls++;assert.equal(snapshots,0);return f.status();},{deadline:1000,now:()=>0,yieldControl:async()=>{
  f.reading.resolve(['sess_synthetic.json']);f.building.resolve();f.writing.resolve(true);await turns();
 }});
 snapshots++;await warm;assert.equal(maintenanceIsQuiet(result),true);assert.equal(polls,2);assert.equal(snapshots,1);assert.equal(f.counts.write,1);
});
test('actual maintenance drain covers startup read through the final write and retirement refuses a fresh late warm before IO',async()=>{
 const f=startup(),warm=f.api.warm(),lease=f.m.begin();let idle=false;
 const drained=lease.idle().then(()=>{idle=true;});await turns();assert.equal(idle,false);
 f.reading.resolve(['sess_synthetic.json']);await turns();assert.equal(f.counts.build,1);assert.equal(idle,false);
 f.building.resolve();await turns();assert.equal(f.counts.write,1);assert.equal(idle,false);assert.equal(f.m.status().writers,1);
 f.writing.resolve(true);await warm;await drained;assert.equal(idle,true);assert.equal(f.counts.timers,0,'closed admission prevents a new verify timer');
 lease.retire();await assert.rejects(f.api.warm(),{code:'work_data.maintenance_busy'});assert.equal(f.counts.read,1);assert.equal(f.counts.write,1);
});
test('cancelled maintenance cannot retire or make the surviving startup scope look quiet',async()=>{
 const f=startup(),warm=f.api.warm(),controller=new AbortController(),lease=f.m.begin({signal:controller.signal});
 const draining=lease.idle();draining.catch(()=>{});await turns();controller.abort();
 await assert.rejects(draining,{code:'work_data.maintenance_cancelled'});assert.throws(()=>lease.retire(),{code:'work_data.maintenance_cancelled'});
 assert.equal(f.m.status().phase,'open');assert.equal(f.m.status().admitted,1);assert.equal(maintenanceIsQuiet(f.status()),false);
 f.reading.resolve(['sess_synthetic.json']);f.building.resolve();f.writing.resolve(true);await warm;
 assert.equal(maintenanceIsQuiet(f.status()),true);assert.equal(f.counts.write,1,'cancellation resumes intake and leaves the original business scope tracked until completion');
});
for(const stage of ['read','build','write'])test('actual startup '+stage+' failure settles admission and never launches a later write',async()=>{
 const f=startup(),error=Object.assign(Error('synthetic '+stage+' fault'),{code:'work_data.synthetic_fault'}),warm=f.api.warm();warm.catch(()=>{});
 if(stage==='read')f.reading.reject(error);else{f.reading.resolve(['sess_synthetic.json']);await turns();if(stage==='build')f.building.reject(error);else{f.building.resolve();await turns();f.writing.reject(error);}}
 if(stage==='read')assert.equal(await warm,null,'the existing absent-directory handling is unchanged');else await assert.rejects(warm,value=>value===error);
 await turns();assert.equal(f.m.status().admitted,0);assert.equal(f.m.status().writers,0);assert.equal(f.runtime.building,null);
 assert.equal(f.counts.write,stage==='write'?1:0);assert.equal(f.counts.timers,0);
});
test('maintenance quiet rejects missing or invalid known counters and uses the same finite deadline',async()=>{
 const f=startup();assert.equal(maintenanceIsQuiet(f.status()),true);
 for(const field of ['admitted','writers','dirty'])for(const value of [undefined,null,false,'0',NaN,1,-1]){
  const status=f.status();status.maintenance={...status.maintenance,[field]:value};assert.equal(maintenanceIsQuiet(status),false);
 }
 for(const key of Object.keys(f.status().maintenance.busy)){
  const status=f.status();status.maintenance={...status.maintenance,busy:{...status.maintenance.busy}};delete status.maintenance.busy[key];assert.equal(maintenanceIsQuiet(status),false);
 }
 let now=9,reads=0,yields=0;
 await assert.rejects(waitMaintenanceQuiet(async remaining=>{reads++;assert.equal(remaining,1);now=10;return f.status();},{deadline:10,now:()=>now,yieldControl:async()=>{yields++;}}),/maintenance readiness deadline/);
 assert.equal(reads,1);assert.equal(yields,0,'a late status response cannot extend the old deadline');
 now=10;await assert.rejects(waitMaintenanceQuiet(async()=>{reads++;return f.status();},{deadline:10,now:()=>now}),/maintenance readiness deadline/);assert.equal(reads,1,'expired budget starts no new request');
});
