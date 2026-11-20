'use strict';
// 151 阶段 3A(150 号文 W5、149 号文 r48):普通 serve 在只读启动闸门被「维护没收尾」拒绝时,先起一个与隐藏
// doctor 命令完全相同的子进程,交给已审查的恢复主人自动收尾,再重新启动。这里只钉 14-main 的编排:哪些码、
// 什么时候、起哪条 doctor、失败与重试的边界(只重试会自己消失的原因、整次有总上限、单次有上限)、桌面壳认的标记、
// 失败时原样抛出原拒绝且只回显稳定码。恢复主人本身(13au recoverCompletedIntent / recoverSource)的判据由各自的
// 单测与 e2e 钉着;真进程走 e2e。
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo=path.resolve(__dirname,'../..'),{constBlock,functionBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const mainSource=fs.readFileSync(process.env.RUYI_BOOT_HEAL_SOURCE||path.join(repo,'ruyi-workbench/app/src/14-main.js'),'utf8');
const refusal=code=>Object.assign(Error(code),{code});
const CONSTS=['WORK_DATA_BOOT_RECOVERY','WORK_DATA_BOOT_HEALING_MARKER','WORK_DATA_BOOT_HEAL_BUDGET_MS','WORK_DATA_BOOT_RECOVERY_PAUSES_MS','WORK_DATA_RECOVERY_CAUSES_TAG','WORK_DATA_BOOT_TRANSIENT_CAUSES','WORK_DATA_BOOT_GUIDANCE'];
const FUNCTIONS=['workDataRecoveryCauseCodes','workDataRecoveryCausesFrom','recoverWorkDataBoot','preflightWorkDataBoot','serveWithWorkDataBootRecovery','reportWorkDataRecoveryCauses'];
const causesLine=codes=>'RUYI-RECOVERY-CAUSES '+JSON.stringify(codes);
// `starts` is the sequence of readonly gate verdicts: an Error is a refusal, anything else
// passes. The single real serve start happens afterwards and returns {server:true}.
// `doctor(flag,attempt,timeoutMs,calls)` returns {code,stderr[,timedOut]}; it may advance calls.clock.
function load({starts=[],doctor,rootReady=false,helper=false,acquireFails=false,helperUnknown=()=>false}={}){
 const calls={doctor:[],timeouts:[],starts:0,inspections:0,releases:0,errors:[],announced:[],logs:[],pauses:[],clock:1000,held:0};
 const context={Object,Error,String,Promise,JSON,Set,Array,Number,
  Date:{now:()=>calls.clock},setTimeout:(fn,ms)=>{calls.pauses.push(ms);calls.clock+=ms;fn();},
  console:{log:line=>calls.logs.push(line),error:line=>(/RUYI-BOOT-HEALING v1/.test(line)?calls.announced:calls.errors).push(line)},
  dataRoot:()=>'C:\\synthetic\\data',
  ServerOwnership:{acquire:async roots=>{if(acquireFails)throw Error('busy');return {roots,release:async()=>{calls.releases++;}};},canonicalRoot:async value=>value},
  WorkDataRootHooks:{ready:()=>rootReady},
  WorkDataMaintenanceRuntimeHooks:{helperMayStillRun:()=>helper,inspectBoot:async()=>{const next=starts[calls.inspections++];if(next instanceof Error)throw next;return true;}},
  workDataCliHelperUnknown:error=>helperUnknown(error),holdWorkDataCliOwner:()=>{calls.held++;},
  runWorkDataRecoveryDoctor:async(flag,timeoutMs)=>{calls.doctor.push(flag);calls.timeouts.push(timeoutMs);return doctor?doctor(flag,calls.doctor.length,timeoutMs,calls):{code:0,stderr:''};},
  startWorkbenchServe:async()=>{calls.starts++;return {server:true};}};
 const source=[...CONSTS.map(name=>constBlock(mainSource,name)),...FUNCTIONS.map(name=>functionBlock(mainSource,name))].join('\n');
 vm.runInNewContext(source+'\nthis.serve=serveWithWorkDataBootRecovery;this.codes=workDataRecoveryCauseCodes;this.report=reportWorkDataRecoveryCauses;this.BUDGET=WORK_DATA_BOOT_HEAL_BUDGET_MS;',context);
 return {serve:context.serve,codes:context.codes,report:context.report,BUDGET:context.BUDGET,calls};
}
for(const [code,flag] of [['work_data_setup.intent_pending','--recover-work-data-intent'],['work_data_setup.handoff_pending','--recover-work-data-source']])
 test('3A W5: a '+code+' boot refusal is completed by a fresh doctor '+flag+' child before the single serve start',async()=>{
  const {serve,calls}=load({starts:[refusal(code)]});
  assert.deepEqual(await serve({}),{server:true});
  assert.deepEqual(calls.doctor,[flag]);assert.equal(calls.starts,1,'the serve composition runs exactly once');assert.equal(calls.releases,1,'the preflight lease is released before serve');
  assert.equal(calls.errors.length,0);assert.match(calls.logs[0],/recovered automatically/);
  assert.equal(calls.announced.length,1,'the recovery is announced once on stderr before the doctor runs');
  assert.ok(calls.announced[0].includes('RUYI-BOOT-HEALING v1 '+code),'the desktop shell marker names the stable refusal code only');
 });
test('3A W5: a refused automatic completion prints human guidance with only a stable code and leaves the gate to serve',async()=>{
 const {serve,calls}=load({starts:[refusal('work_data_setup.intent_pending')],doctor:()=>({code:1,stderr:'Error: work_data_host.complete_recovery_result_mismatch\n    at fail (C:\\Users\\someone\\secret\\server.js:1:1)'})});
 assert.deepEqual(await serve({}),{server:true},'the real serve then gates (and refuses) on its own');
 assert.equal(calls.starts,1);assert.equal(calls.errors.length,1);
 assert.match(calls.errors[0],/work_data_setup\.intent_pending \(work_data_host\.complete_recovery_result_mismatch\)/);assert.match(calls.errors[0],/没有改动任何数据/);
 assert.ok(!calls.errors[0].includes('someone'),'no path or stack text from the doctor is echoed');
 assert.equal(calls.doctor.length,1,'a definite ineligibility refuses at once and never delays boot');assert.deepEqual(calls.pauses,[]);
});
// review 应改 2:the outer wrapper code says nothing about whether the cause settles. A broken
// key and a missing backup are wrapped in the same source_recovery_unverified/recovery_unverified.
for(const [name,codes] of [
 ['a broken source key',['work_data_claim.source_recovery_unverified','work_data_keys.unwrap_failed']],
 ['a mismatched result',['work_data_claim.recovery_unverified','work_data_host.complete_recovery_result_mismatch']],
 ['an unverifiable wrapper with no transient cause',['work_data_claim.source_recovery_unverified']],
])test('3A W5: '+name+' wrapped in the generic outer code is never retried',async()=>{
 const {serve,calls}=load({starts:[refusal('work_data_setup.handoff_pending')],doctor:()=>({code:1,stderr:causesLine(codes)+'\nError: '+codes[0]})});
 await serve({});
 assert.equal(calls.doctor.length,1);assert.deepEqual(calls.pauses,[]);assert.match(calls.errors[0],new RegExp('\\('+codes[0].replace('.','\\.')+'\\)'));
});
for(const transient of ['work_data_backup.idle_win32_32','work_data_backup.metadata_changed','work_data_claim.recovery_process_pending','work_data_setup.rehearsal_retained'])
 test('3A W5: a transient cause ('+transient+') is retried a bounded number of times, then the original gate stands',async()=>{
  const {serve,calls}=load({starts:[refusal('work_data_setup.intent_pending')],doctor:()=>({code:1,stderr:causesLine(['work_data_claim.recovery_unverified',transient])})});
  await serve({});
  assert.equal(calls.doctor.length,4);assert.deepEqual(calls.pauses,[1000,3000,6000]);
  assert.match(calls.errors[0],/\(work_data_claim\.recovery_unverified\)/);
 });
test('3A W5: a transient refusal (crashed processes still being reaped) heals on the bounded retry',async()=>{
 const {serve,calls}=load({starts:[refusal('work_data_setup.intent_pending')],doctor:(_flag,attempt)=>attempt<2?{code:1,stderr:causesLine(['work_data_claim.recovery_process_pending'])}:{code:0,stderr:''}});
 await serve({});assert.equal(calls.doctor.length,2);assert.equal(calls.errors.length,0);assert.equal(calls.starts,1);
});
test('3A W5: an older doctor without a cause line retries only on a transient outer code',async()=>{
 const pending=load({starts:[refusal('work_data_setup.intent_pending')],doctor:()=>({code:1,stderr:'Error: work_data_claim.recovery_process_pending'})});
 await pending.serve({});assert.equal(pending.calls.doctor.length,4);
 const wrapped=load({starts:[refusal('work_data_setup.intent_pending')],doctor:()=>({code:1,stderr:'Error: work_data_claim.recovery_unverified'})});
 await wrapped.serve({});assert.equal(wrapped.calls.doctor.length,1,'a bare wrapper code is not evidence of a transient cause');
});
test('3A W5: the whole automatic completion is bounded: each doctor run gets only the remaining budget and no retry starts past it',async()=>{
 const {serve,calls,BUDGET}=load({starts:[refusal('work_data_setup.intent_pending')],doctor:(_flag,_attempt,timeoutMs,state)=>{
  state.clock+=Math.min(timeoutMs,0.6*BUDGET);return {code:1,stderr:causesLine(['work_data_claim.recovery_unverified','work_data_backup.metadata_changed'])};}});
 const started=calls.clock;await serve({});
 assert.equal(calls.timeouts[0],BUDGET,'the first run is bounded by the whole budget');
 assert.ok(calls.doctor.length<=2,'a slow doctor leaves no room for the full ladder');
 assert.ok(calls.timeouts.every(ms=>ms>0&&ms<=BUDGET));
 assert.ok(calls.clock-started<=BUDGET,'retries never run past the budget the desktop window was extended for');
});
test('3A W5: a doctor run stopped at its bound is a definite failure with its own stable code',async()=>{
 const {serve,calls}=load({starts:[refusal('work_data_setup.handoff_pending')],doctor:()=>({code:-2,stderr:'',timedOut:true})});
 await serve({});assert.equal(calls.doctor.length,1);assert.match(calls.errors[0],/\(work_data_setup\.boot_recovery_timeout\)/);
});
test('3A W5: a passing gate, other refusals, a bound root, a live native helper or a busy root never trigger recovery',async()=>{
 for(const [name,options] of [
  ['gate passes',{starts:[]}],
  ['other code',{starts:[refusal('work_data_setup.boot_control_pending')]}],
  ['root already bound',{starts:[refusal('work_data_setup.intent_pending')],rootReady:true}],
  ['native helper may still run',{starts:[refusal('work_data_setup.handoff_pending')],helper:true}],
  ['root busy',{starts:[refusal('work_data_setup.intent_pending')],acquireFails:true}],
 ]){
  const {serve,calls}=load(options);
  assert.deepEqual(await serve({}),{server:true},name);
  assert.equal(calls.doctor.length,0,name);assert.equal(calls.starts,1,name);assert.deepEqual(calls.announced,[],name);
 }
});
// review 建议 7:a refusal that may still have a native helper running keeps the preflight lease.
test('3A W5: a gate refusal that may still have a native helper keeps the preflight lease and holds like the CLI commands',async()=>{
 const uncertain=Object.assign(refusal('work_data_setup.intent_pending'),{helperMayStillRun:true});
 const {serve,calls}=load({starts:[uncertain],helperUnknown:error=>error===uncertain});
 await assert.rejects(serve({}),error=>error===uncertain);
 assert.equal(calls.releases,0,'the lease is not released');assert.equal(calls.held,1);assert.equal(calls.doctor.length,0);assert.equal(calls.starts,0);
});
test('3A W5: the doctor reports only stable cause codes from data descriptors, outermost first',()=>{
 const {codes,report,calls}=load();
 const leaf=Object.assign(Error('C:\\secret\\path'),{code:'work_data_backup.idle_win32_32'});
 const wrapped=Object.assign(Error('wrapped'),{code:'work_data_claim.recovery_unverified',cause:Object.assign(new AggregateError([leaf,{code:'not_ours.code'}],'x'),{code:'work_data_host.complete_recovery_profile_invalid'})});
 assert.deepEqual(JSON.parse(JSON.stringify(codes(wrapped))),['work_data_claim.recovery_unverified','work_data_host.complete_recovery_profile_invalid','work_data_backup.idle_win32_32']);
 const trap=Object.defineProperty(Object.assign(Error('t'),{code:'work_data_x.y'}),'cause',{get(){throw Error('getter must not run');}});
 assert.deepEqual(JSON.parse(JSON.stringify(codes(trap))),['work_data_x.y']);
 report(wrapped);assert.equal(calls.errors.length,1);assert.equal(calls.errors[0],'RUYI-RECOVERY-CAUSES ["work_data_claim.recovery_unverified","work_data_host.complete_recovery_profile_invalid","work_data_backup.idle_win32_32"]');
 assert.ok(!calls.errors[0].includes('secret'));
});
// The doctor child uses the ordinary CLI identity (same executable and script) and
// exactly the two-argument doctor form 14-main accepts; it is stopped at its bound.
function loadDoctor(){
 const spawned=[],timers=[];const {EventEmitter}=require('node:events');
 const context={Promise,Number,process:{env:{RUYI_HOME:'C:\\synthetic\\data'}},
  setTimeout:(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cleared=true;},
  WorkDataVerifierEntry:{command:()=>({command:'C:\\node.exe',args:['C:\\app\\server.js','work-data-verifier']})},
  require:name=>{assert.equal(name,'node:child_process');return {spawn:(command,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.killed=0;child.kill=()=>{child.killed++;};spawned.push({command,args,options,child});return child;}};}};
 vm.runInNewContext(functionBlock(mainSource,'runWorkDataRecoveryDoctor')+'\nthis.run=runWorkDataRecoveryDoctor;',context);
 return {run:context.run,spawned,timers};
}
test('3A W5: the recovery child is the exact ordinary doctor command with the same environment',async()=>{
 const {run,spawned,timers}=loadDoctor();
 const pending=run('--recover-work-data-intent',5000);
 const {child}=spawned[0];child.stderr.emit('data','Error: work_data_x.y');child.emit('close',3);
 assert.deepEqual(JSON.parse(JSON.stringify(await pending)),{code:3,stderr:'Error: work_data_x.y'});
 assert.equal(spawned.length,1);assert.equal(spawned[0].command,'C:\\node.exe');assert.deepEqual(JSON.parse(JSON.stringify(spawned[0].args)),['C:\\app\\server.js','doctor','--recover-work-data-intent']);
 assert.equal(spawned[0].options.env,context_env(spawned));assert.equal(spawned[0].options.windowsHide,true);
 assert.equal(timers.length,1);assert.equal(timers[0].ms,5000);assert.equal(timers[0].cleared,true,'a finished run clears its bound');assert.equal(child.killed,0);
});
function context_env(spawned){return spawned[0].options.env;}
test('3A W5: a doctor run that outlives its bound is stopped and reported as timed out',async()=>{
 const {run,spawned,timers}=loadDoctor();
 const pending=run('--recover-work-data-source',7000);timers[0].fn();
 assert.deepEqual(JSON.parse(JSON.stringify(await pending)),{code:-2,stderr:'',timedOut:true});assert.equal(spawned[0].child.killed,1);
 spawned[0].child.emit('close',1);// a late close after the bound changes nothing
});
