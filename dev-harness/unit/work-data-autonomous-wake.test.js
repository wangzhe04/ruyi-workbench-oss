'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{AsyncResource}=require('node:async_hooks');
const repo=process.env.RUYI_WAKE_REPO||path.resolve(__dirname,'../..'),dir=process.env.RUYI_WAKE_SOURCE||(fs.existsSync(path.join(__dirname,'src/13ag-work-data-maintenance.js'))?path.join(__dirname,'src'):path.join(repo,'ruyi-workbench/app/src')),{constBlock,functionBlock}=require(path.join(repo,'dev-harness/lib/source-slice')),read=name=>fs.readFileSync(path.join(dir,name),'utf8'),maintenanceSource=read('13ag-work-data-maintenance.js');
const M=vm.runInNewContext(constBlock(maintenanceSource,'WorkDataMaintenance')+'\nWorkDataMaintenance',{require,Promise,Set,Object,Error,TypeError}),tick=()=>new Promise(setImmediate);
function fixture(){let calls=0,deferred=0;const callbacks=[],intervals=[],runtime={running:true,generation:1,wakeTimers:[],ticking:false,lastError:'',timer:null},m=M.create({owns:()=>false,snapshot:()=>({busy:{},pending:[],dirty:0}),pause:()=>({}),resume:()=>{},progress:async()=>{},flush:async()=>{},yield:tick}),hooks={...m,deferStewardWake:()=>{deferred++;}};
 const context={WorkDataMaintenanceHooks:hooks,workDataMaintenance:m,stewardRuntime:runtime,StewardHooks:{},STEWARD_WAKE_DELAYS_MS:[400,2500],setTimeout:fn=>{const timer={callback:AsyncResource.bind(fn),unref(){}};callbacks.push(timer);return timer;},clearTimeout:()=>{},setInterval:fn=>{const timer={callback:AsyncResource.bind(fn),unref(){}};intervals.push(timer);return timer;},clearInterval:()=>{},logEvent:()=>{},stewardTickOnce:()=>m.run('steward-intake',async()=>{calls++;return{written:0};})};
 vm.createContext(context);vm.runInContext(functionBlock(read('13i-steward-inbox.js'),'stewardClearWake')+'\n'+functionBlock(read('13i-steward-inbox.js'),'stewardRunTick')+'\n'+functionBlock(read('13i-steward-inbox.js'),'stewardScheduleWake')+'\n'+functionBlock(read('13i-steward-inbox.js'),'startStewardInbox'),context);
 for(const name of ['stewardTick','schedulerTick']){const line=maintenanceSource.split('\n').find(row=>row.startsWith('WorkDataMaintenanceHooks.'+name+' ='));if(line)vm.runInContext(line,context);}
 return{m,hooks,context,runtime,callbacks,intervals,calls:()=>calls,deferred:()=>deferred};
}
test('actual settled-turn wake timer reenters fresh admission instead of inheriting an expired turn token',async()=>{
 const f=fixture();await f.m.run('turn',async()=>f.context.stewardScheduleWake());assert.equal(f.callbacks.length,2);f.callbacks[0].callback();for(let i=0;i<4;i++)await tick();assert.equal(f.calls(),1,f.runtime.lastError);assert.equal(f.runtime.lastError,'');
});
test('actual inbox interval created inside an HTTP root remains runnable after that request finishes',async()=>{
 const f=fixture();f.runtime.running=false;await f.m.run('http',()=>f.context.startStewardInbox({stewardEnabledV1:true,stewardPollMs:120000}));assert.equal(f.calls(),1);assert.equal(f.intervals.length,1);f.intervals[0].callback();for(let i=0;i<4;i++)await tick();assert.equal(f.calls(),2,f.runtime.lastError);
});
test('closed intake defers a new steward wake and does not arm another timer or admit a poll',async()=>{
 const f=fixture(),lease=f.m.begin();f.context.stewardScheduleWake();assert.equal(f.callbacks.length,0);assert.equal(f.deferred(),1);if(f.hooks.stewardTick)await f.hooks.stewardTick();assert.equal(f.calls(),0);assert.equal(f.m.status().admitted,0);lease.resume();
});
test('actual scheduler interval creates a fresh autonomous root after the configuring HTTP request ends',async()=>{
 const f=fixture(),scheduler={enabled:true,started:true,tasks:[{}],lateQueue:[],timer:null};let ticks=0,error;
 f.context.schedulerRuntime=scheduler;f.context.schedulerTickMs=()=>1000;f.context.schedulerTick=async()=>{try{await f.m.run('scheduler-fire',async()=>{ticks++;});}catch(e){error=e.code;}};
 vm.runInContext(functionBlock(read('13s-scheduler.js'),'schedulerEnsureTimer'),f.context);await f.m.run('http',async()=>f.context.schedulerEnsureTimer());f.intervals[0].callback();for(let i=0;i<4;i++)await tick();assert.equal(ticks,1,error);
});
