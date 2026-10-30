'use strict';
// Permanent offline source/FS end-to-end: verified QQ/Feishu inbound wires ->
// original encrypted queue/worker -> original disclosure continuation -> actual
// fixed HTTPS adapter bytes -> synthetic API response -> durable receipt.
// No HTTP listener/socket/provider/engine/platform account/native/browser runs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createRunner}=require('./lib/harness'),{fixture,defer,turns}=require('./lib/external-bots-progress-fixture');
const t=createRunner('EXTERNAL BOTS PROGRESS SOURCE');
const flag=process.argv.find(a=>a.startsWith('--baseline-root=')),baselineRoot=flag?path.resolve(flag.slice('--baseline-root='.length)):null;
const negativeFlag=process.argv.find(a=>a.startsWith('--query-negative-root=')),queryNegativeRoot=negativeFlag?path.resolve(negativeFlag.slice('--query-negative-root='.length)):null;
const messages=f=>f.requests.filter(r=>!r.token),clone=v=>JSON.parse(JSON.stringify(v));
async function configure(f,progress=true){await f.api.update({op:'upsert',connection:{...f.connection,...(progress?{progressUpdates:true}:{})},controlConfirmed:true});}
async function baselineControls(){
 const f=await fixture({baselineRoot});try{await configure(f,false);await f.accept('/status');const item=(await f.api.read()).items[0];assert.equal(item.execution.status,'queued');assert.equal((await f.api.next()).kind,'run');t.ok(true,'expected RED: signed status query is admitted as a new business turn in old source');
 const c={...f.connection,botSecret:'synthetic'},message={...item,conversationId:'qq_room',senderId:'qq_person'};await f.api.adapter(c,message,'public progress',{attemptId:'first',messageSeq:2});assert.equal(messages(f)[0].body.msg_seq,1);t.ok(true,'expected RED: old adapter ignores reserved subsequent sequence and reuses QQ seq1');}finally{await f.close();}
}
async function workerControls(platform){
 const f=await fixture({platform});try{
  await configure(f);await f.accept('Begin this controlled request','business');const accepted=await f.api.read();assert.equal(accepted.schema,6);const original=accepted.items[0],key=original.sourceKey;
  const draining=f.start();await f.started.promise;await f.waitCommit(event=>event.job.slot==='progress');assert.equal(f.state.businessEntries,1);assert.equal(f.api.busy(),true);
  assert.equal(messages(f).length,1,'automatic starting notice while original host boundary remains pending');
  const running=(await f.api.read()).items[0];assert.equal(running.execution.status,'running');assert.equal(running.feedback.progress.delivery.status,'sent');assert.equal(running.delivery,null);
  if(platform==='qq'){assert.equal(messages(f)[0].body.msg_seq,1);assert.equal(messages(f)[0].body.msg_id,'business');}else assert.ok(messages(f)[0].body.uuid);
  t.ok(true,platform+': automatic legal-window starting notice is independent of business completion; real adapter receipt committed');
  f.advance(1100);await f.accept(platform==='qq'?'进度':'/status','query');f.api.wake();await f.waitCommit(event=>event.job.item.messageId==='query');
  const query=(await f.api.read()).items.find(i=>i.messageId==='query');assert.equal(query.execution.status,'completed');assert.equal(query.delivery.status,'sent');assert.equal(query.feedback.queryId,original.id);assert.equal(f.state.businessEntries,1);assert.match(query.execution.replyText,/处理中|processing/);
  t.ok(true,platform+': verified same-owner read-only status reply pumps during the one pending business owner; no second business entry');
  await f.accept(platform==='qq'?'进度':'/status','query');f.api.wake();await turns();assert.equal(messages(f).length,2);assert.equal(f.state.businessEntries,1);
  t.ok(true,platform+': duplicate query wire keeps original receipt/attempt and does not resend or run work');
  f.advance(1100);f.run.reject(Error('no engine capability in this fixture'));await draining;const after=(await f.api.read()).items[0];
  assert.equal(after.execution.status,'unknown');assert.equal(after.delivery.status,'sent');assert.equal(after.sourceKey,key);assert.equal(after.feedback.progress.delivery.status,'sent');
  const final=messages(f).at(-1);if(platform==='qq'){assert.equal(final.body.msg_seq,2);assert.equal(final.body.msg_id,'business');}else assert.notEqual(final.body.uuid,messages(f)[0].body.uuid);
  assert.equal(f.state.businessEntries,1);assert.ok(f.projections.length>=3);for(const p of f.projections){assert.equal(p.binding.purpose,'external-bot-reply');const recipient=JSON.parse(p.binding.recipient);assert.equal(recipient[0],f.connection.id);assert.equal(recipient[6],f.connection.ownerConversationId);assert.equal(recipient[7],f.connection.ownerSenderId);}
  t.ok(true,platform+': truthful unknown business outcome uses final sequence/uuid distinct from progress; all real send continuations bind original recipient projection');
  await f.api.recover();assert.equal(f.state.businessEntries,1);assert.equal(await f.api.next(),null);const raw=await fs.promises.readFile(path.join(f.directory,'external-bots/state-v1.json'),'utf8');assert.equal(raw.includes('Begin this controlled request'),false);
  t.ok(true,platform+': authenticated payload6 persisted; recovery never replays completed/unknown business or confirmed notices');
 }finally{await f.close();}
}
async function boundaryControls(){
 for(const mode of ['expired','token-expiry','lost-ack','429','revoked']){
  const f=await fixture();try{await configure(f);await f.accept('Controlled request','one');const run=await f.api.next();assert.equal(run.kind,'run');
   if(mode==='expired')f.advance(300001);if(mode==='token-expiry')f.state.tokenAdvance=300001;if(mode==='lost-ack')f.state.messageMode='lost-ack';if(mode==='429')f.state.messageMode='429';
   if(mode==='expired'){assert.equal(await f.api.next(true),null);const item=(await f.api.page()).items[0];assert.equal(item.feedback.progressWaiting,'window_closed');assert.equal(f.requests.length,0);}
   else{const send=await f.api.next(true);assert.equal(send.slot,'progress');
    if(mode==='revoked')await f.api.update({op:'disable',id:f.connection.id});await f.api.send(send);
    const item=(await f.api.read()).items[0];const expected=mode==='token-expiry'?'pending':mode==='lost-ack'?'unknown':'failed';assert.equal(item.feedback.progress.delivery.status,expected);
    if(['token-expiry','revoked'].includes(mode))assert.equal(messages(f).length,0);
    if(mode==='429'){assert.equal(Date.parse(item.feedback.cooldownUntil),f.now()+7000);assert.equal(await f.api.next(true),null);}
    if(mode==='lost-ack'){await f.api.recover();assert.equal(await f.api.next(true),null);assert.equal(item.feedback.reservations.length,1);}
   }
   assert.equal(f.state.businessEntries,0);t.ok(true,mode+': local pending/known rejection/unknown remains separate from execution; no forbidden proactive send or replay');
  }finally{await f.close();}
 }
 const f=await fixture();try{
  await configure(f);await f.accept('Do not expose this request','private');const original=(await f.api.read()).items[0];
  await f.accept('/status '+original.id,'same');assert.equal((await f.api.read()).items.at(-1).feedback.queryId,original.id);
  // An allowed inbox sender is still not the bound controlling owner.
  await f.api.update({op:'upsert',connection:{...f.connection,progressUpdates:true,allowedSenderIds:[f.connection.ownerSenderId,'other_person']},controlConfirmed:true});
  await f.accept('/status '+original.id,'other',{senderId:'other_person'});const other=(await f.api.read()).items.at(-1);assert.equal(other.control,null);assert.equal(other.execution,null);assert.equal(other.feedback,undefined);
  await f.accept('/status '+original.id,'changed');const changed=(await f.api.read()).items.at(-1);assert.equal(changed.feedback.queryId,'not_found');assert.equal(changed.execution.replyText.includes(original.id),false);
  t.ok(true,'other sender and changed control revision cannot query old work; same conversation/owner alone never expands a grant');
  const {beforeProgress}=require('./lib/external-bots-source-history'),history=require('./fixtures/external-bots-progress/history.json');
  const oldText=beforeProgress(fs.readFileSync(path.resolve(__dirname,'../ruyi-workbench/app/src/13w-external-bots.js'),'utf8'));
  assert.equal(require('node:crypto').createHash('sha256').update(oldText).digest('hex'),history.baseSha256);
  const current=await f.api.read();f.context.__newPayload=current;assert.equal(vm.runInContext('externalBotValidState(__newPayload)',f.context),true);
  // The original validator is evaluated in its own lexical namespaced wrapper;
  // all existing owner helpers are the same definitions available in this VM.
  const {functionBlock}=require('./lib/source-slice');f.context.__oldValid=vm.runInContext('('+functionBlock(oldText,'externalBotValidState')+')',f.context);assert.equal(f.context.__oldValid(current),false);
  t.ok(true,'tracked inverse recovers exact payload5 hash; payload6 explicitly refuses old reader; M3 queue envelope is not confused with business payload version');
  f.state.lostKey=true;await assert.rejects(f.api.read());f.state.lostKey=false;const before=await f.api.read();f.state.failWrite=true;await assert.rejects(f.accept('/status','write_fail'));f.state.failWrite=false;assert.equal((await f.api.read()).items.length,before.items.length);
  t.ok(true,'lost key or rejected durable query acceptance cannot ACK a new intent or weaken old dedupe receipts');
 }finally{await f.close();}
}
async function retentionControls(){
 for(const progress of [false,true]){const f=await fixture();try{
  await configure(f,progress);await f.accept('public fixture body','retain');const run=await f.api.next();
  if(progress){const notice=await f.api.next(true);await f.api.send(notice);}
  // Durable-writer positive, not an engine-success fixture. Retire only the
  // exact actor reference obtained above, as the original worker finally does.
  await f.api.finish(run,{ok:true,say:'public saved fixture reply',turnSeq:1});f.api.retireActor(run);f.advance(1100);
  const sending=await f.api.next(true);await f.api.send(sending);const item=(await f.api.read()).items[0];
  f.advance(8*86400000);await f.api.archive({id:item.id,archived:true});
  if(progress){const unknown=clone(item);unknown.feedback.progress.delivery.status='unknown';assert.equal(f.api.retentionEligible(unknown,f.now()-7*86400000),false);t.ok(true,'terminal business/final receipt cannot make an unresolved progress slot reclaimable');}
  const requestId='retention_b2_'+(progress?'new_00000001':'old_00000001'),preview=await f.api.preview({requestId,retainDays:7});assert.equal(preview.count,1);
  f.state.failWrite=true;await assert.rejects(f.api.reclaim({requestId,previewToken:preview.previewToken}));f.state.failWrite=false;assert.equal((await f.api.read()).items.length,1);
  await f.api.reclaim({requestId,previewToken:preview.previewToken});const state=await f.api.read();assert.equal(state.schema,progress?6:5);assert.equal(state.items.length,0);assert.equal(state.retentionReceipts.length,1);const receipt=state.retentionReceipts[0];assert.equal(f.api.validReceipt(receipt),true);
  if(progress){assert.equal(receipt.feedback.finalSeq,2);assert.equal(receipt.feedback.progress.delivery.attemptId,item.feedback.progress.delivery.attemptId);assert.equal(receipt.feedback.reservations.length,2);}else assert.equal(receipt.feedback,undefined);
  await f.accept('public fixture body','retain');assert.equal((await f.api.read()).items.length,0);assert.equal(f.state.businessEntries,0);
  t.ok(true,progress?'payload6 retention keeps progress receipt/seq, refuses rejected commit ACK, and never downgrades to5 or loses original dedupe':'normal no-progress reclamation retains original schema5 semantics and exact dedupe after a rejected write');
 }finally{await f.close();}}
}
async function coldControls(){
 for(const phase of ['pending','sending','final']){const f=await fixture();let cold;try{
  await configure(f);await f.accept('cold controlled body','cold');const run=await f.api.next(),notice=phase==='pending'?null:await f.api.next(true);
  if(phase==='final'){await f.api.send(notice);await f.api.finish(run,{ok:false,executionUnknown:true});f.api.retireActor(run);f.advance(1100);await f.api.next(true);}
  const before=(await f.api.read()).items[0];f.api.stop();cold=await f.cold();assert.equal(cold.state.businessEntries,0);await cold.api.recover();const after=(await cold.api.read()).items[0];
  assert.equal(after.feedback.finalSeq,2);assert.equal(after.sourceKey,before.sourceKey);assert.equal(after.feedback.progress.delivery.attemptId,before.feedback.progress.delivery.attemptId);
  if(phase==='pending'){assert.equal(after.execution.status,'unknown');assert.equal(after.feedback.progress.delivery.status,'failed');assert.equal(after.feedback.progress.delivery.errorCode,'external_delivery.progress_superseded');}
  else if(phase==='sending'){assert.equal(after.execution.status,'unknown');assert.equal(after.feedback.progress.delivery.status,'unknown');}else{assert.equal(after.delivery.status,'unknown');assert.equal(after.delivery.attemptId,before.delivery.attemptId);assert.equal(after.feedback.progress.delivery.status,'sent');}
  assert.equal(await cold.api.next(),null);assert.equal(cold.requests.length,0);assert.equal(cold.state.businessEntries,0);
  t.ok(true,phase==='pending'?'cold interrupted run retires stale unsent starting notice, preserving intent/seq without a permanent misleading pending state':phase==='sending'?'fresh cold owner preserves progress seq/attempt and interrupted business unknown without message or engine replay':'fresh cold owner preserves final unknown and original seq2 alongside confirmed seq1 progress; no send/business replay');
 }finally{if(cold)await cold.close();await f.close();}}
}
async function raceControls(){
 for(const mode of ['revoke-token','progress-off-token','cancel-final']){const f=await fixture();try{
  await configure(f);await f.accept('controlled wait','race');const run=await f.api.next();
  if(mode==='cancel-final'){await f.api.send(await f.api.next(true));await f.api.finish(run,{ok:false,executionUnknown:true});f.api.retireActor(run);f.advance(1100);}
  const send=await f.api.next(true),entered=defer();f.state.tokenGate=defer();f.state.onRequest=request=>{if(request.token)entered.resolve();};const sending=f.api.send(send);await entered.promise;
  if(mode==='revoke-token')await f.api.update({op:'disable',id:f.connection.id});else if(mode==='progress-off-token')await f.api.update({op:'upsert',connection:{...f.connection,progressUpdates:false},controlConfirmed:true});else await f.api.cancel({id:send.item.id,attemptId:send.item.delivery.attemptId});
  f.state.tokenGate.resolve();await sending;const item=(await f.api.read()).items[0];
  assert.equal(messages(f).length,mode==='cancel-final'?1:0);assert.equal(f.state.businessEntries,0);
  if(mode==='cancel-final'){assert.equal(item.delivery.status,'cancelled');assert.equal(item.feedback.progress.delivery.status,'sent');assert.equal(item.feedback.finalSeq,2);assert.equal(item.execution.status,'unknown');}
  else assert.equal(item.feedback.progress.delivery.status,'failed');
  t.ok(true,mode+': actual token await cannot escape original authority/cancellation latch or overwrite prior progress/business facts');
 }finally{await f.close();}}
 const f=await fixture();let cold;try{await configure(f);await f.accept('unconfirmed receipt','uncertain');await f.api.next();const send=await f.api.next(true);f.state.failAfterMessage=true;await assert.rejects(f.api.send(send));
  assert.equal(messages(f).length,1);assert.equal((await f.api.read()).items[0].feedback.progress.delivery.status,'sending');assert.equal((await f.api.page()).items[0].feedback.progress.status,'unknown');f.api.stop();cold=await f.cold();await cold.api.recover();assert.equal((await cold.api.read()).items[0].feedback.progress.delivery.status,'unknown');assert.equal(await cold.api.next(),null);assert.equal(cold.state.businessEntries,0);assert.equal(cold.requests.length,0);
  t.ok(true,'platform ACK followed by rejected result commit stays unknown across fresh cold owner, never replays progress or business');
 }finally{if(cold)await cold.close();await f.close();}
 const admission=await fixture();try{await configure(admission);await admission.accept('uncertain admission','admission');await admission.api.next();
  const write=admission.context.externalBotWriteState;let armed=true;admission.context.externalBotWriteState=async state=>{await write(state);if(armed&&state.items[0].feedback.progress.delivery.status==='sending'){armed=false;throw Object.assign(Error('committed original queue header, lost result'),{code:'EIO'});}};
  await assert.rejects(admission.api.next(true));assert.equal((await admission.api.page()).items[0].feedback.progress.status,'unknown');assert.equal(admission.requests.length,0);
  await admission.api.recover();assert.equal((await admission.api.read()).items[0].feedback.progress.delivery.status,'unknown');assert.equal(await admission.api.next(),null);
  t.ok(true,'original sending admission committed then lost result stays unknown, with no message request or replay from a pending projection');
 }finally{await admission.close();}
}
async function queryUnknownControls(negativeRoot=null){
 for(const mode of ['completion','final-receipt']){const f=await fixture({baselineRoot:negativeRoot});try{
  await configure(f);await f.accept('controlled original request','uncertain_'+mode);
  if(mode==='completion'){
   const draining=f.start();await f.started.promise;await f.waitCommit(event=>event.job.slot==='progress');
   f.state.failWrite=true;f.run.reject(Error('host outcome unavailable'));await draining;f.state.failWrite=false;
  }else{
   // Original durable-writer positive, not an engine-success fixture.
   const run=await f.api.next();await f.api.send(await f.api.next(true));
   await f.api.finish(run,{ok:true,say:'controlled saved reply',turnSeq:1});f.api.retireActor(run);f.advance(1100);
   const send=await f.api.next(true);f.state.failAfterMessage=true;await assert.rejects(f.api.send(send));f.state.failWrite=false;f.state.failAfterMessage=false;
  }
  const target=(await f.api.read()).items[0],projected=(await f.api.page()).items[0],field=mode==='completion'?'execution':'delivery';
  assert.equal(target[field].status,mode==='completion'?'running':'sending');assert.equal(projected[field].status,'unknown');
  const identity={id:target.id,sourceKey:target.sourceKey,control:clone(target.control),seq:target.feedback.finalSeq,progressAttempt:target.feedback.progress.delivery.attemptId,finalAttempt:target.delivery?.attemptId};
  const sentBefore=messages(f).length,businessBefore=f.state.businessEntries;
  await f.accept('/status '+target.id,'query_'+mode);const query=(await f.api.read()).items.at(-1);
  assert.equal(query.feedback.queryId,target.id);assert.equal(query.execution.turnSeq,0);assert.equal(query.messageId,'query_'+mode);
  assert.equal(query.delivery.status,'pending');assert.equal(query.feedback.finalSeq,1);assert.notEqual(query.delivery.attemptId,target.delivery?.attemptId);
  const truthful=mode==='completion'?/Execution: unconfirmed; check existing work before issuing the instruction again/:/Reply: unconfirmed; check existing work before issuing the instruction again/;
  const stale=mode==='completion'?/Execution: processing/:/Reply: sending; receipt not confirmed/;
  assert.match(query.execution.replyText,negativeRoot?stale:truthful);assert.doesNotMatch(query.execution.replyText,negativeRoot?truthful:stale);
  f.advance(1100);await f.api.drain();const settled=await f.api.read(),after=settled.items.find(row=>row.id===target.id),answer=settled.items.find(row=>row.id===query.id);
  assert.equal(after[field].status,'unknown');assert.equal(answer.delivery.status,'sent');assert.equal(answer.execution.replyText,query.execution.replyText);
  assert.equal(messages(f).length,sentBefore+1);assert.equal(messages(f).at(-1).body.msg_id,query.messageId);assert.equal(messages(f).at(-1).body.msg_seq,1);
  assert.equal(f.state.businessEntries,businessBefore);assert.equal(businessBefore,mode==='completion'?1:0);
  assert.deepEqual({id:after.id,sourceKey:after.sourceKey,control:clone(after.control),seq:after.feedback.finalSeq,progressAttempt:after.feedback.progress.delivery.attemptId,finalAttempt:after.delivery?.attemptId},identity);
  assert.equal(await f.api.next(),null);assert.equal(f.state.businessEntries,businessBefore);
  t.ok(true,(negativeRoot?'expected RED: ':'')+mode+': '+(negativeRoot?'raw disk state freezes a stale query despite authoritative unknown':'query preserves authoritative unknown through recovery and its own receipt; target identity/sequence and one business entry stay fixed'));
 }finally{await f.close();}}
}
async function deferredWakeControls() {
 const { AsyncLocalStorage } = require('node:async_hooks');
 const { constBlock } = require('./lib/source-slice');
 const maintenanceSource = fs.readFileSync(path.resolve(__dirname,'../ruyi-workbench/app/src/13ag-work-data-maintenance.js'),'utf8');
 const maintenanceFactory = vm.runInNewContext(constBlock(maintenanceSource,'WorkDataMaintenance')+'\nWorkDataMaintenance;', {
  require(name) { assert.equal(name,'node:async_hooks'); return { AsyncLocalStorage }; },
 });
 function attach(f) {
  const outOfOwner=AsyncLocalStorage.snapshot();
  const errors=[],drains=[];
  const maintenance=maintenanceFactory.create({ snapshot:()=>({busy:{},pending:[],dirty:0}), owns:()=>false, pause:()=>({}),
   resume() { if(vm.runInContext('externalBotWorkerAgain',f.context)) f.api.wake(); }, flush:async()=>{}, yield:async()=>{},
  });
  f.context.WorkDataMaintenanceHooks=maintenance;
  // Node timers retain AsyncLocalStorage from their scheduling call. A plain
  // callback array would silently erase the retired-owner bug this test guards.
  f.context.setTimeout=(callback,ms)=>{const captured=AsyncLocalStorage.snapshot(),timer={active:true,at:f.now()+ms,unref(){},callback:()=>captured(callback)};f.timers.push(timer);return timer;};
  const drain=f.context.externalBotDrain;
  f.context.externalBotDrain=(...args)=>{const pending=drain(...args);drains.push(pending);pending.catch(error=>errors.push(error.code||error.message));return pending;};
  const fire=async()=>{for(const timer of [...f.timers])if(timer.active&&timer.at<=f.now()){timer.active=false;timer.callback();}await turns();};
  return {maintenance,errors,drains,fire,outOfOwner};
 }
 for(const mode of ['feishu','qq','closed','cold','fresh-rejected']) {
  const f=await fixture({platform:mode==='qq'||mode==='cold'?'qq':'feishu'}),owner=attach(f);let cold;
  try {
   await configure(f);await f.accept('one controlled owner','deferred_business');
   const running=f.start();await f.started.promise;await f.waitCommit(event=>event.job.slot==='progress');
   await f.accept('/status','deferred_query');f.api.wake();await turns();
   f.advance(1100);await owner.fire();await f.waitCommit(event=>event.job.item.messageId==='deferred_query');
   f.run.resolve({ok:true,say:'controlled final',turnSeq:18});await running;
   const before=(await f.api.read()).items.find(item=>item.messageId==='deferred_business');
   assert.equal(before.execution.status,'completed');assert.equal(before.delivery.status,'pending');assert.equal(messages(f).length,2);
   assert.equal(owner.maintenance.status().admitted,0);assert.equal(f.api.busy(),false);assert.equal(f.state.businessEntries,1);
   if(mode==='cold') {
    f.api.stop();cold=await f.cold();const nextOwner=attach(cold);await cold.api.recover();await cold.api.wake();
    assert.equal((await cold.api.read()).items[0].delivery.status,'pending');assert.equal(nextOwner.maintenance.status().admitted,0);
    cold.advance(1100);await nextOwner.fire();await Promise.allSettled(nextOwner.drains);const after=(await cold.api.read()).items[0];
    assert.equal(after.delivery.status,'sent');assert.equal(after.delivery.attemptId,before.delivery.attemptId);assert.equal(after.feedback.progress.delivery.status,'sent');
    assert.equal(messages(cold).length,1);assert.equal(messages(cold)[0].body.msg_seq,2);assert.equal(cold.state.businessEntries,0);assert.deepEqual(nextOwner.errors,[]);
    await Promise.allSettled(nextOwner.drains);assert.equal(nextOwner.maintenance.status().admitted,0);
   } else {
    let lease;
    if(mode==='closed') { lease=owner.maintenance.begin();await lease.idle(); }
    if(mode==='fresh-rejected') {
     f.context.WorkDataMaintenanceHooks={...owner.maintenance,fresh(kind,work){owner.outOfOwner(()=>{lease=owner.maintenance.begin();});return owner.maintenance.fresh(kind,work);}};
    }
    const tokenEntered=defer();f.state.tokenGate=defer();f.state.onRequest=request=>{if(request.token)tokenEntered.resolve();};
    f.advance(1100);await owner.fire();assert.deepEqual(owner.errors,[]);
    if(lease) {
     assert.equal((await f.api.read()).items[0].delivery.status,'pending');assert.equal(messages(f).length,2);assert.equal(owner.maintenance.status().admitted,0);
     assert.equal(vm.runInContext('externalBotWorkerAgain',f.context),true);
     if(mode==='fresh-rejected')assert.equal(f.api.workerError(),'external_channel.storage_unavailable');
     f.context.WorkDataMaintenanceHooks=owner.maintenance;lease.resume();await turns();
    }
    await tokenEntered.promise;
    assert.equal(owner.maintenance.status().admitted,1,'fresh owner must remain live while original final adapter is pending');
    assert.equal(f.api.busy(),true);assert.equal(f.state.businessEntries,1);assert.equal(messages(f).length,2);
    f.state.tokenGate.resolve();await f.waitCommit(event=>event.job.item.messageId==='deferred_business'&&event.job.kind==='send'&&event.job.slot!=='progress');
    await turns();await Promise.allSettled(owner.drains);const after=(await f.api.read()).items[0];
    assert.equal(after.delivery.status,'sent');assert.equal(after.delivery.attemptId,before.delivery.attemptId);assert.equal(after.feedback.progress.delivery.status,'sent');
    assert.equal(messages(f).length,3);assert.equal(f.state.businessEntries,1);assert.equal(owner.maintenance.status().admitted,0);assert.equal(f.api.busy(),false);assert.deepEqual(owner.errors,[]);
   }
   t.ok(true,mode+': captured deferred timer resumes only original outbox; fresh lease lasts through drain, closed intake defers and cold recovery never reruns business');
  } finally { if(cold)await cold.close();await f.close();await Promise.allSettled(owner.drains); }
 }
}

(async()=>{try{if(queryNegativeRoot)await queryUnknownControls(queryNegativeRoot);else if(baselineRoot)await baselineControls();else{await workerControls('qq');await workerControls('feishu');await boundaryControls();await retentionControls();await coldControls();await raceControls();await queryUnknownControls();await deferredWakeControls();}}catch(error){t.fail(error.stack||String(error));}finally{t.done({exit:true});}})();
