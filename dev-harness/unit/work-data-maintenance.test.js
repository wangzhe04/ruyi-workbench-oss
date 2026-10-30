'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {constBlock,functionBlock}=require('../lib/source-slice');
const source=name=>fs.readFileSync(path.join(process.env.RUYI_MAINTENANCE_DRAFT||path.resolve(__dirname,'../../ruyi-workbench/app/src'),name),'utf8');
const api=vm.runInNewContext(constBlock(source('13ag-work-data-maintenance.js'),'WorkDataMaintenance')+'\nWorkDataMaintenance',{require,Promise,Set,Object,Error,TypeError});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(setImmediate), turns=async()=>{for(let i=0;i<6;i++)await tick();};
function fixture(){const owners=new Set(),state={busy:{},pending:[],dirty:0,paused:0,resumed:0,flushes:0};
 const host={owns:owner=>owners.has(owner),snapshot:()=>({busy:state.busy,pending:state.pending,dirty:state.dirty}),pause:()=>{state.paused++;return{saved:true};},resume:saved=>{assert.equal(saved.saved,true);state.resumed++;},progress:async()=>{},flush:async()=>{state.flushes++;},yield:tick};
 const m=api.create(host);return{m,host,state,owners};}
test('close intake while existing root and exact owner receipts finish without cancellation',async()=>{
 const f=fixture(),hold=deferred(),owner={aborted:false};f.owners.add(owner);let entered=false;
 const task=f.m.run('turn',async()=>{entered=true;await hold.promise;return f.m.run('save',async()=>42);});assert.equal(entered,true);
 const lease=f.m.begin();await assert.rejects(f.m.run('turn',()=>assert.fail('new turn ran')),/maintenance_busy/);
 assert.equal(await f.m.continueOwner(owner,()=>17),17);await assert.rejects(f.m.continueOwner({},()=>assert.fail()),/owner_unavailable/);
 let idle=false;const waiting=lease.idle().then(()=>{idle=true;});await turns();assert.equal(idle,false);assert.equal(owner.aborted,false);
 hold.resolve();assert.equal(await task,42);await waiting;assert.equal(lease.assertIdle().phase,'idle');assert.equal(f.state.paused,1);lease.resume();assert.equal(f.state.resumed,1);assert.equal(await f.m.run('turn',()=>1),1);
});
test('nested work admitted before close outlives its parent and cannot disappear from idle',async()=>{
 const f=fixture(),hold=deferred();let nested;
 await f.m.run('turn',async()=>{nested=f.m.run('background-agent',async()=>{await hold.promise;return f.m.run('final-save',()=>9);});});
 const lease=f.m.begin();let done=false;const wait=lease.idle().then(()=>{done=true;});await turns();assert.equal(done,false);hold.resolve();assert.equal(await nested,9);await wait;lease.resume();
});
test('detached expired ALS continuation cannot resurrect admission',async()=>{
 const f=fixture(),later=deferred();let stale;
 await f.m.run('turn',async()=>{stale=later.promise.then(()=>f.m.run('late-save',()=>assert.fail('stale save ran')));});
 later.resolve();await assert.rejects(stale,/stale_continuation/);
});
test('repeated chain identity census catches a chain enqueued by the drained chain',async()=>{
 const f=fixture(),first=deferred(),second=deferred();f.state.pending=[first.promise];let secondDone=false;
 first.promise.then(()=>{f.state.pending=[second.promise];});const lease=f.m.begin();let idle=false;const wait=lease.idle().then(()=>{idle=true;});
 await turns();first.resolve();await turns();assert.equal(idle,false);second.promise.then(()=>{secondDone=true;});second.resolve();await wait;assert.equal(secondDone,true);assert.ok(f.state.flushes>=3);lease.resume();
});
test('writer scheduled during flush and deferred index dirty state require another full pass',async()=>{
 const f=fixture(),write=deferred();let once=false;f.state.dirty=1;
 f.host.flush=async()=>{f.state.flushes++;f.state.dirty=0;if(!once){once=true;f.m.track(write.promise);}};
 const lease=f.m.begin();let idle=false;const wait=lease.idle().then(()=>{idle=true;});await turns();assert.equal(idle,false);write.resolve();await wait;assert.ok(f.state.flushes>=3);lease.resume();
});
test('cancel only resumes intake; existing task and its pending writer continue',async()=>{
 const f=fixture(),hold=deferred(),ctrl=new AbortController();let finished=false;
 const task=f.m.run('turn',async()=>{await hold.promise;finished=true;});const lease=f.m.begin({signal:ctrl.signal}),wait=lease.idle();await turns();ctrl.abort();
 await assert.rejects(wait,/cancelled/);assert.equal(f.m.status().phase,'open');assert.equal(finished,false);assert.equal(f.state.resumed,1);hold.resolve();await task;assert.equal(finished,true);
});
test('flush failure stays quiesced and cannot become idle until explicitly resumed',async()=>{
 const f=fixture();f.host.flush=async()=>{throw Error('storage failure');};const lease=f.m.begin();await assert.rejects(lease.idle(),/storage failure/);assert.equal(f.m.status().phase,'waiting');assert.throws(()=>lease.retire(),/not_idle/);lease.resume();
});
test('a late writer invalidates an idle receipt; retirement requires a fresh quiet pass',async()=>{
 const f=fixture(),write=deferred();const lease=f.m.begin();await lease.idle();f.m.track(write.promise);assert.throws(()=>lease.assertIdle(),/not_idle/);write.resolve();await lease.idle();lease.retire();assert.equal(f.m.status().phase,'retired');await assert.rejects(f.m.run('turn',()=>1),/busy/);assert.throws(()=>lease.resume(),/lease_expired/);
});
test('actual runSessionTurn gate runs before its initial config await and new turn IO',async()=>{
 const f=fixture(),hold=deferred(),sentinel=Error('finish admitted turn');let reads=0;
 const run=vm.runInNewContext(functionBlock(source('10-context-governance.js'),'runSessionTurn')+'\nrunSessionTurn',{WorkDataMaintenanceHooks:f.m,readConfig:async()=>{reads++;await hold.promise;throw sentinel;}});
 const task=run({});const lease=f.m.begin();await assert.rejects(run({}),/maintenance_busy/);assert.equal(reads,1);hold.resolve();await assert.rejects(task,error=>error===sentinel);await lease.idle();lease.resume();
});
test('actual scheduler dispatch cannot claim a new task while intake is paused',()=>{
 const f=fixture(),lease=f.m.begin(),runtime={inFlightTaskIds:new Set()};let calls=0;
 const dispatch=vm.runInNewContext(functionBlock(source('13s-scheduler.js'),'schedulerDispatchFire')+'\nschedulerDispatchFire',{WorkDataMaintenanceHooks:f.m,schedulerRuntime:runtime,schedulerFireOnce:async()=>{calls++;}});
 dispatch({id:'pending'},'late',123);assert.equal(calls,0);assert.equal(runtime.inFlightTaskIds.size,0);lease.resume();
});
test('actual consumer denies new RPC but its existing cancellation receipt remains live',async()=>{
 const f=fixture(),lease=f.m.begin(),ctrl=new AbortController(),connection={inflight:new Map([['string:old',ctrl]])};let reads=0;
 const run=vm.runInNewContext(functionBlock(source('13ac-mcp-consumer.js'),'run')+'\nrun',{WorkDataMaintenanceHooks:f.m,PrivacyGateway:{disclosurePolicyGuard:()=>()=>{}},configReadGeneration:0,assertCurrent:()=>{},readConfig:async()=>{reads++;},deny:code=>{throw Error(code);}});
 await assert.rejects(run({},connection,{jsonrpc:'2.0',id:1,method:'initialize'},()=>{}),/maintenance_busy/);assert.equal(reads,0);
 await run({},connection,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'old'}},()=>{});assert.equal(ctrl.signal.aborted,true);lease.resume();
});

test('actual agent launch service and workflow close admission before owner IO',async()=>{
 const f=fixture(),lease=f.m.begin();let effects=0;
 const context={WorkDataMaintenanceHooks:f.m,sessionSaveIsTombstoned:()=>{effects++;},readConfig:async()=>{effects++;},loadSession:async()=>{effects++;}};
 const workflow=vm.runInNewContext(functionBlock(source('09-workflow.js'),'runAgentWorkflow')+'\nrunAgentWorkflow',context);
 const launch=vm.runInNewContext(functionBlock(source('13ae-cli-business-services.js'),'cliAgentLaunchService')+'\ncliAgentLaunchService',context);
 await assert.rejects(workflow({parentSession:{id:'sid'}}),/maintenance_busy/);await assert.rejects(launch({sessionId:'sid'},{ownerCheck:()=>{effects++;}}),/maintenance_busy/);assert.equal(effects,0);lease.resume();
});

test('accepted inbox queue drains through its exact intrinsic owner while intake is closed',async()=>{
 const f=fixture(),hold=deferred(),runtime={queue:[{id:'one'}],stopped:false,inflight:null,debounceTimer:null,debounceMs:-1};let callback,started=0;
 f.owners.add(runtime);f.host.snapshot=()=>({pending:[],busy:{queue:runtime.queue.length},dirty:0});
 const context={WorkDataMaintenanceHooks:f.m,stewardRunnerRuntime:runtime,Math,STEWARD_INBOX_EVENTS_PER_TURN:30,stewardInboxDebounceMs:()=>5,stewardHoldViewedEvents:rows=>rows,stewardInboxRetryDelay:()=>0,
  setTimeout:fn=>{callback=fn;return{unref(){}};},clearTimeout:()=>{},runStewardTurn:input=>f.m.run('steward-turn',async()=>{started++;assert.equal(input.events.length,1);await hold.promise;return{ok:true};})};
 const schedule=vm.runInNewContext(functionBlock(source('13q-steward-runner-turn.js'),'stewardScheduleInboxDrain')+'\nstewardScheduleInboxDrain',context);
 schedule();const lease=f.m.begin();let idle=false;const wait=lease.idle().then(()=>{idle=true;});assert.equal(runtime.queue.length,1);callback();await turns();assert.equal(started,1);assert.equal(idle,false);hold.resolve();await wait;lease.resume();
});

test('an already emptied inbox queue clears its timer without inventing an owner',async()=>{
 const f=fixture(),runtime={queue:[{}],stopped:false,inflight:null,debounceTimer:null,debounceMs:-1};let callback;
 const context={WorkDataMaintenanceHooks:f.m,stewardRunnerRuntime:runtime,Math,stewardInboxDebounceMs:()=>5,setTimeout:fn=>{callback=fn;return{unref(){}};},clearTimeout:()=>{}};
 const schedule=vm.runInNewContext(functionBlock(source('13q-steward-runner-turn.js'),'stewardScheduleInboxDrain')+'\nstewardScheduleInboxDrain',context);schedule();runtime.queue=[];const lease=f.m.begin();callback();assert.equal(runtime.debounceTimer,null);assert.equal(runtime.debounceMs,-1);lease.resume();
});

test('actual bot worker completes an already acquired job but never dequeues the next one',async()=>{
 const f=fixture(),acquired=deferred(),job=deferred(),finished=deferred();let dequeues=0,runs=0,completions=0;
 const context={WorkDataMaintenanceHooks:f.m,externalBotWorkerStopped:false,externalBotWorkerBusy:false,externalBotWorkerAgain:false,externalBotWorkerError:'',externalBotWorkerSignal:null,externalBotRecoveryDone:true,
  externalBotActors:new WeakMap(),externalBotActiveActors:new Map(),externalBotDeliveries:new Map(),externalBotUnsettled:new Map(),externalBotRecover:async()=>{},
  externalBotNextJob:async(sendOnly=false)=>{if(sendOnly)return null;dequeues++;acquired.resolve();await job.promise;return{kind:'run',actor:{},item:{id:'accepted',text:'old'}};},
  runStewardTurn:async()=>{assert.equal(f.m.active(),true);runs++;await finished.promise;return{ok:true};},externalBotFinishJob:async(current,result)=>{assert.equal(current.kind,'run');assert.equal(current.item.id,'accepted');assert.equal(result.ok,true);completions++;}};
 const run=vm.runInNewContext(functionBlock(source('13w-external-bots.js'),'externalBotRunWithFeedback')+'\n'+functionBlock(source('13w-external-bots.js'),'externalBotDrain')+'\nexternalBotDrain',context);
 const task=run();await acquired.promise;const lease=f.m.begin();job.resolve();await turns();assert.equal(runs,1);let idle=false;const wait=lease.idle().then(()=>{idle=true;});await turns();assert.equal(idle,false);finished.resolve();await task;await wait;assert.equal(completions,1);assert.equal(dequeues,1);lease.resume();
});

test('closed inbox drains accepted carry and adopted records without polling source journals or pruning cursor owners',async()=>{
 const f=fixture(),lease=f.m.begin();let polls=0,written,cursorIds;
 const cursor={missionChanges:{mission:3},agentRuns:{run:8},sessionTurns:{quick:{turnSeq:1}},budgetSeen:new Set(['budget\u0000at']),pendingIds:new Set(['pending'])};
 const record=id=>({kind:'done',sessionId:id,at:'2026-10-24T00:00:00Z'});
 const runtime={generation:1,cursor,adopted:[record('adopted')],adoptedRecent:[],sourcesSeen:{},carry:[record('carry')],seen:new Set(),inboxSeq:0};
 const context={WorkDataMaintenanceHooks:f.m,stewardRuntime:runtime,structuredClone,stewardLoadState:async()=>{},stewardCollectEvents:async()=>{polls++;throw Error('new journal intake');},
  stewardNormalizeThreadAdopted:row=>row,stewardApplyPresenceGate:rows=>rows,stewardEventDedupeKey:row=>row.sessionId,stewardMergeInboxEvents:rows=>rows,STEWARD_TICK_MAX_EVENTS:200,STEWARD_MERGE_WINDOW_MS:1,STEWARD_SEEN_MAX_KEYS:2000,
  StewardHooks:{},stewardAppendInboxRows:async rows=>{written=rows;},stewardInboxRowDedupeKeys:row=>[row.sessionId],stewardSaveCursor:async(sids,rids)=>{cursorIds={sids:[...sids],rids:[...rids]};},stewardMaintainInbox:async()=>{},nowIso:()=>'',logEvent:()=>{}};
 const run=vm.runInNewContext(functionBlock(source('13i-steward-inbox.js'),'stewardTickInboxWithin')+'\nstewardTickInboxWithin',context);
 assert.equal((await run({})).written,2);assert.equal(polls,0);assert.deepEqual(Array.from(written,row=>row.sessionId),['carry','adopted']);
 assert.deepEqual(cursorIds,{sids:['mission','quick','budget'],rids:['run']});assert.equal(cursor.pendingIds.has('pending'),true);assert.equal(runtime.adopted.length,0);assert.equal(runtime.carry.length,0);lease.resume();
 await assert.rejects(run({}),/new journal intake/);assert.equal(polls,1);
});

test('actual queued projection writer remains tracked before its private chain can start',async()=>{
 const f=fixture(),held=deferred();let published=0;
 const context={WorkDataMaintenanceHooks:f.m,pretenderIndexRuntime:{writeChain:held.promise},writePretenderIndexFileNow:async()=>{published++;return true;}};
 const write=vm.runInNewContext(functionBlock(source('13e-pretender-index.js'),'writePretenderIndexFile')+'\nwritePretenderIndexFile',context);
 const pending=write({}),lease=f.m.begin();let idle=false;const wait=lease.idle().then(()=>{idle=true;});await turns();assert.equal(idle,false);assert.equal(published,0);assert.equal(f.m.status().writers,1);
 held.resolve();assert.equal(await pending,true);await wait;assert.equal(published,1);lease.resume();
});

test('projection producer timers cannot arm while closed; autonomous verify reenters freshly after an expired HTTP context',async()=>{
 const f=fixture(),runtime={persistTimer:null,verifyTimer:null,verifyScan:null,lastVerifyAt:0};let callback,calls=0;
 const context={WorkDataMaintenanceHooks:f.m,pretenderIndexRuntime:runtime,PRETENDER_PERSIST_DEBOUNCE_MS:5,PRETENDER_VERIFY_MS:5,Date,Math,setTimeout:fn=>{callback=fn;return{unref(){}};},pretenderRunVerify:()=>f.m.run('projection-verify',async()=>{calls++;}),flushPretenderPersist:async()=>{calls++;}};
 const api=vm.runInNewContext(functionBlock(source('13e-pretender-index.js'),'schedulePretenderPersist')+'\n'+functionBlock(source('13e-pretender-index.js'),'pretenderScheduleVerify')+'\n({persist:schedulePretenderPersist,verify:pretenderScheduleVerify})',context);
 const lease=f.m.begin();api.persist();api.verify();assert.equal(callback,undefined);assert.equal(runtime.persistTimer,null);assert.equal(runtime.verifyTimer,null);lease.resume();
 let later;await f.m.run('http',async()=>{api.verify();later=callback;});later();await turns();assert.equal(calls,1);
});
