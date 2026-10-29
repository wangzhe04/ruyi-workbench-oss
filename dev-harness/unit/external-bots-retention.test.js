'use strict';
// Real 13w functions and WorkDataStore chunks with synthetic TEMP data and synthetic keys only.
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {fixture,plain,until}=require('../lib/external-bots-inbox-fixture');
const {beforeRetention}=require('../lib/external-bots-source-history');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/13w-external-bots.js'),'utf8');
function make(options={}) {
  const f=fixture(options);
  vm.runInContext(`Object.assign(api,{
    preview:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionPreview(body)),
    reclaim:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionCommit(body)),
    retry:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetryReply(body,EXTERNAL_BOT_LOCAL_REPLY_RETRY)),
    actors:externalBotActiveActors,retention:EXTERNAL_BOT_RETENTION,eligible:externalBotRetentionEligible,
  });`,f.context);return f;
}
const retryBody=item=>({id:item.id,expectedAttemptId:item.delivery.attemptId,retryRequestId:'retention_retry_000001'});
const request=(requestId='retention_request_000001',retainDays=30)=>({requestId,retainDays});
const commit=preview=>({requestId:preview.requestId,previewToken:preview.previewToken});
async function age(f) {
  const state=plain(await f.api.read()),old=new Date(Date.now()-100*86400000).toISOString();
  for(const item of state.items){item.receivedAt=old;if(item.execution){item.execution.startedAt=old;item.execution.finishedAt=old;}if(item.delivery){item.delivery.updatedAt=old;if(item.delivery.cancelledAt)item.delivery.cancelledAt=old;}for(const row of item.replyHistory||[]){row.requestedAt=old;row.attempt.updatedAt=old;}}
  await f.api.write(state);return state.items[0];
}
async function inbox(options={}) {
  const f=make(options);await f.api.update({op:'upsert',connection:f.connection});await f.api.accept(f.message());
  const state=plain(await f.api.read());state.items[0].readAt=new Date().toISOString();await f.api.write(state);await age(f);return f;
}
async function terminal(options={},status='sent') {
  const f=make(options);await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});
  await f.api.accept(f.message());await f.api.finish(await f.api.next(),{ok:true,say:'SECRET_REPLY_TO_RECLAIM',turnSeq:1});
  f.api.actors.clear(); // This manually driven fixture now simulates the real drain's actor finally.
  if(status==='cancelled'){const item=(await f.api.read()).items[0];await f.api.cancel({id:item.id,attemptId:item.delivery.attemptId});}
  else await f.api.finish(await f.api.next(),status==='sent'?{status:'sent',messageId:'sent_receipt'}:{status,errorCode:'external_delivery.predispatch'});
  await f.api.archive({id:(await f.api.read()).items[0].id,archived:true});await age(f);return f;
}
for(const enabled of [false,true]) {
  test(`manual preview has no write and reclaim removes inbox body, keeps durable conflict/dedup, sealed=${enabled}`,async()=>{
    const f=await inbox({enabled}),writes=f.counts().writes,before=f.disk(),preview=await f.api.preview(request());
    a.equal(preview.count,1);a.equal(preview.eligible,1);a.equal(f.disk(),before);a.equal(f.counts().writes,writes);
    a.equal(JSON.stringify(preview).includes(f.message().text),false);
    const result=await f.api.reclaim(commit(preview)),state=await f.api.read();a.equal(state.schema,5);a.equal(state.items.length,0);a.equal(result.receipt.count,1);a.equal(result.retained,0);a.equal(f.counts().writes,writes+1);
    const receipt=plain(state.retentionReceipts[0]);a.equal(receipt.kind,'inbox');a.equal(receipt.execution,null);a.equal(receipt.delivery,null);
    for(const text of [f.message().text,'room_a','user_a','event_a','离线测试'])a.equal(JSON.stringify(receipt).includes(text),false);
    await f.api.accept(f.message());a.equal((await f.api.read()).items.length,0);
    await a.rejects(f.api.accept(f.message({text:'changed'})),{code:'external_channel.message_conflict'});
    const cold=make({enabled,key:f.key});cold.setDisk(f.disk());await cold.api.accept(cold.message());a.equal((await cold.api.read()).items.length,0);
    await a.rejects(cold.api.accept(cold.message({text:'changed'})),{code:'external_channel.message_conflict'});
    const again=await cold.api.reclaim(commit(preview));a.equal(again.alreadyReclaimed,true);a.deepEqual(plain(again.receipt),plain(result.receipt));
    await a.rejects(cold.api.reclaim({...commit(preview),previewToken:preview.previewToken.replace(/.$/,preview.previewToken.endsWith('0')?'1':'0')}),{code:'external_channel.retention_changed'});
    await cold.api.accept(cold.message({messageId:'new_message',eventId:'new_event'}));const after=await cold.api.read();a.equal(after.schema,5);a.deepEqual(plain(after.items[0].replyHistory),[]);a.equal(after.retentionReceipts.length,1);a.equal(cold.counts().runs,0);a.equal(cold.counts().sends,0);
  });
  test(`all actual payload1–4 readers reject entire reclaimed ledger, sealed=${enabled}`,async()=>{
    const f=await terminal({enabled});await f.api.reclaim(commit(await f.api.preview(request())));
    const old=fixture({enabled,key:f.key,source:beforeRetention(source)});old.setDisk(f.disk());const before=old.disk();await a.rejects(old.api.read(),{code:'external_channel.storage_unavailable'});await a.rejects(old.api.accept(old.message()),{code:'external_channel.storage_unavailable'});a.equal(old.disk(),before);
  });
}
test('terminal control receipt retains separate acceptance/execution/sending and drops both bodies',async()=>{
  for(const status of ['sent','failed','cancelled']) {
    const f=await terminal({},status),item=plain((await f.api.read()).items[0]);await f.api.reclaim(commit(await f.api.preview(request())));
    const state=await f.api.read(),row=state.retentionReceipts[0];a.equal(row.execution.status,'completed');a.equal(row.delivery.status,status);a.equal(row.delivery.attemptId,item.delivery.attemptId);a.equal(row.execution.turnSeq,1);
    a.equal(JSON.stringify(state).includes('SECRET_REPLY_TO_RECLAIM'),false);a.equal(JSON.stringify(state).includes(f.message().text),false);a.equal(f.counts().runs,0);a.equal(f.counts().sends,0);
    if(status==='cancelled'){const before=f.disk(),again=await f.api.cancel({id:item.id,attemptId:item.delivery.attemptId});a.equal(again.alreadyCancelled,true);a.equal(again.item.reclaimed,true);a.equal(f.disk(),before);}
    await a.rejects(f.api.cancel({id:item.id,attemptId:'retired_attempt'}),{code:'external_channel.delivery_changed'});
  }
});
test('reclaimed retry history keeps exact old stable requests and cannot create a new attempt',async()=>{
  const f=await terminal({},'failed'),body=retryBody((await f.api.read()).items[0]),first=await f.api.retry(body);await f.api.finish(await f.api.next(),{status:'sent',messageId:'confirmed_reply'});f.advance(101*86400000);
  const beforeHistory=plain((await f.api.read()).items[0].replyHistory);await f.api.reclaim(commit(await f.api.preview(request())));
  const cold=make({key:f.key});cold.setDisk(f.disk());const before=cold.disk(),res=await cold.api.retry(body);a.equal(res.alreadyRetried,true);a.equal(res.item.reclaimed,true);a.deepEqual(plain(res.receipt),plain(first.receipt));a.deepEqual(plain((await cold.api.read()).retentionReceipts[0].replyHistory),beforeHistory);a.equal(cold.disk(),before);
  await a.rejects(cold.api.retry({...body,retryRequestId:'retention_retry_000002'}),{code:'external_channel.delivery_cannot_retry'});a.equal(cold.counts().runs,0);a.equal(cold.counts().sends,0);
});
test('retry, cancel, archive and fresh admissions never downgrade payload5 or erase active history',async()=>{
  const f=await terminal({},'failed');await f.api.accept(f.message({messageId:'second_message',eventId:'second_event'}));await f.api.finish(await f.api.next(),{ok:true,say:'second_reply',turnSeq:2});await f.api.finish(await f.api.next(),{status:'failed',errorCode:'external_delivery.predispatch'});
  const old=plain((await f.api.read()).items[1]),body=retryBody(old);await f.api.retry(body);await f.api.cancel({id:old.id,attemptId:(await f.api.read()).items[1].delivery.attemptId});
  await f.api.reclaim(commit(await f.api.preview(request())));a.equal((await f.api.read()).schema,5);await f.api.archive({id:old.id,archived:true});await f.api.archive({id:old.id,archived:false});
  await f.api.accept(f.message({messageId:'third_message',eventId:'third_event'}));const state=await f.api.read();a.equal(state.schema,5);a.equal(state.items[0].replyHistory.length,1);a.deepEqual(plain(state.items[1].replyHistory),[]);a.equal(state.retentionReceipts.length,1);
});
test('every unresolved/live state is excluded, including read inbox with live owner',async()=>{
  const f=await terminal(),seed=plain((await f.api.read()).items[0]),cutoff=Date.now()-30*86400000;
  for(const [group,key,value] of [['execution','status','queued'],['execution','status','running'],['execution','status','unknown'],['execution','proposals',1],['execution','actionFailures',1],['execution','contractIncomplete',true],['delivery','status','pending'],['delivery','status','sending'],['delivery','status','unknown']]){const row=plain(seed);row[group][key]=value;a.equal(f.api.eligible(row,cutoff),false,`${group}.${key}=${value}`);}
  a.equal(f.api.eligible({...seed,archivedAt:''},cutoff),false);
  for(const map of [f.api.actors,f.api.live,f.api.unsettled]){map.set(seed.id,{});a.equal((await f.api.preview(request())).count,0);map.delete(seed.id);}
  const inb=await inbox(),row=plain((await inb.api.read()).items[0]);a.equal(inb.api.eligible({...row,readAt:''},cutoff),false);inb.api.actors.set(row.id,{});a.equal((await inb.api.preview(request())).count,0);
});
test('minimum age uses latest business or delivery/retry fact; preview expiry/restart cannot authorize deletion',async()=>{
  const f=await terminal(),state=plain(await f.api.read());state.items[0].delivery.updatedAt=new Date().toISOString();await f.api.write(state);a.equal((await f.api.preview(request())).count,0);await age(f);
  const preview=await f.api.preview(request()),before=f.disk();f.advance(f.api.retention.previewMs);await a.rejects(f.api.reclaim(commit(preview)),{code:'external_channel.retention_preview_expired'});a.equal(f.disk(),before);
  const cold=make({key:f.key});cold.setDisk(before);await a.rejects(cold.api.reclaim(commit(preview)),{code:'external_channel.retention_preview_expired'});a.equal(cold.disk(),before);
});
test('commit revalidates complete fingerprint and all live ownership, with no partial receipts',async()=>{
  for(const mode of ['fingerprint','actors','live','unsettled']){const f=await terminal(),preview=await f.api.preview(request());if(mode==='fingerprint'){const state=plain(await f.api.read());state.items[0].readAt=new Date().toISOString();await f.api.write(state);}else f.api[mode].set((await f.api.read()).items[0].id,{});const before=f.disk(),writes=f.counts().writes;await a.rejects(f.api.reclaim(commit(preview)),{code:'external_channel.retention_changed'});a.equal(f.disk(),before);a.equal(f.counts().writes,writes);a.equal((await f.api.read()).retentionReceipts,undefined);}
});
test('failed write preserves both bodies and receipts; pending write cannot ACK or admit callback early',async()=>{
  const f=await inbox(),preview=await f.api.preview(request()),before=f.disk();f.fail(true);await a.rejects(f.api.reclaim(commit(preview)),{code:'external_channel.storage_unavailable'});a.equal(f.disk(),before);f.fail(false);
  let release,acked=false,callbackDone=false;f.gate(new Promise(r=>release=r));const writes=f.counts().writes,reclaim=f.api.reclaim(commit(preview)).then(r=>{acked=true;return r;});await until(()=>f.counts().writes===writes+1);const callback=f.api.accept(f.message()).then(()=>callbackDone=true);await new Promise(r=>setImmediate(r));a.equal(acked,false);a.equal(callbackDone,false);a.equal(f.disk(),before);release();await reclaim;await callback;a.equal((await f.api.read()).items.length,0);a.equal((await f.api.read()).retentionReceipts.length,1);
});
test('concurrent same request writes once; another request cannot reclaim stale selection',async()=>{
  const f=await inbox(),one=await f.api.preview(request()),two=await f.api.preview(request('retention_request_000002')),writes=f.counts().writes;
  const [first,second]=await Promise.all([f.api.reclaim(commit(one)),f.api.reclaim(commit(one))]);a.equal(first.alreadyReclaimed,false);a.equal(second.alreadyReclaimed,true);a.deepEqual(plain(first.receipt),plain(second.receipt));a.equal(f.counts().writes,writes+1);await a.rejects(f.api.reclaim(commit(two)),{code:'external_channel.retention_changed'});
});
test('full active body capacity is actually freed and stale page cursors fail deterministically',async()=>{
  const f=await terminal(),state=plain(await f.api.read()),seed=state.items[0];state.items=Array.from({length:1000},(_,i)=>{const row=plain(seed);row.id='capacity_'+i;row.messageId='capacity_message_'+i;row.eventId='capacity_event_'+i;row.sourceKey=JSON.stringify([row.connectionId,row.tenantId,row.conversationId,row.messageId]);return row;});await f.api.write(state);
  const page=await f.api.page('limit=100&archive=all');a.ok(page.nextCursor);await a.rejects(f.api.accept(f.message({messageId:'new_capacity',eventId:'new_capacity_event'})),{code:'external_channel.inbox_full'});
  let batches=0;while((await f.api.read()).items.length){const preview=await f.api.preview(request('retention_capacity_'+String(batches++).padStart(8,'0')));a.equal(preview.count,100);await f.api.reclaim(commit(preview));}a.equal(batches,10);a.equal((await f.api.read()).retentionReceipts.length,1000);await a.rejects(f.api.page('limit=100&archive=all&cursor='+page.nextCursor),{code:'external_channel.cursor_invalid'});
  await f.api.accept(f.message({messageId:'new_capacity',eventId:'new_capacity_event'}));a.equal((await f.api.read()).items.length,1);await f.api.accept(f.message({messageId:'capacity_message_0',eventId:'other_event'}));a.equal((await f.api.read()).items.length,1);
});
test('receipt and request capacity never prune old idempotency authority',async()=>{
  for(const kind of ['receipts','requests']){const f=await inbox();await f.api.reclaim(commit(await f.api.preview(request())));await f.api.accept(f.message({messageId:'fresh',eventId:'fresh_event'}));const state=plain(await f.api.read());state.items[0].readAt=new Date().toISOString();state.items[0].receivedAt=new Date(Date.now()-100*86400000).toISOString();if(kind==='receipts'){const seed=state.retentionReceipts[0];state.retentionReceipts=Array.from({length:f.api.retention.receipts},(_,i)=>({...seed,id:'bound_'+i,sourceHash:crypto.createHash('sha256').update('bound_'+i).digest('hex')}));}else{const seed=state.retentionRequests[0];state.retentionRequests=Array.from({length:f.api.retention.requests},(_,i)=>({...seed,requestId:'retention_bound_'+String(i).padStart(8,'0')}));}a.equal(f.api.valid(state),true);await f.api.write(state);const before=f.disk();await a.rejects(f.api.preview(request('retention_fresh_00001')),{code:'external_channel.retention_receipts_full'});a.equal(f.disk(),before);}
});
test('strict new payload rejects extra body fields, duplicate sources and incomplete receipt arrays',async()=>{
  const f=await inbox();await f.api.reclaim(commit(await f.api.preview(request())));const state=plain(await f.api.read());for(const corrupt of [s=>s.retentionReceipts[0].text='leak',s=>s.retentionReceipts.push(plain(s.retentionReceipts[0])),s=>delete s.retentionRequests,s=>s.schema=4]){const copy=plain(state);corrupt(copy);a.equal(f.api.valid(copy),false);}
});
test('manual requests reject unsupported periods, extra fields and token tampering without writes',async()=>{
  const f=await inbox(),before=f.disk();for(const bad of [{...request(),retainDays:0},{...request(),retainDays:1},{...request(),automatic:true},{...request(),requestId:'short'},null])await a.rejects(f.api.preview(bad),{code:'external_channel.request_invalid'});
  const preview=await f.api.preview(request());await a.rejects(f.api.reclaim({...commit(preview),previewToken:preview.previewToken.replace(/.$/,preview.previewToken.endsWith('0')?'1':'0')}),{code:'external_channel.retention_preview_expired'});a.equal(f.disk(),before);
});
test('prepared HTTP/browser fixture is accepted by the real validator and selects four terminal/read bodies',async()=>{
  const f=make(),seed=require('../lib/external-bots-retention-seed').retentionSeed();a.equal(f.api.valid(seed),true);f.setDisk(JSON.stringify(seed,null,2));const preview=await f.api.preview(request());a.equal(preview.count,4);a.deepEqual(plain(preview.items.map(row=>row.id)),['body_read','body_sent','body_failed','body_cancelled']);
});
test('re-pairing cannot repurpose a reclaimed message identity or bypass its changed-content conflict',async()=>{
  const f=await inbox();await f.api.reclaim(commit(await f.api.preview(request())));await f.api.update({op:'disable',id:f.connection.id});const snapshot=await f.api.snapshot(f.connection.id);const pairing=await f.api.setupOp({op:'pair_start',connectionId:f.connection.id,expectedSetupToken:snapshot.expectedSetupToken});
  const before=f.disk();await f.api.accept(f.message());a.equal(f.disk(),before);await a.rejects(f.api.accept(f.message({text:pairing.pairing.code})),{code:'external_channel.message_conflict'});a.equal((await f.api.snapshot(f.connection.id)).pairing.state,'waiting');a.equal((await f.api.read()).setupReceipts,undefined);
});
test('a failed label with an unknown error, submitted message id or unknown provenance is never enough',async()=>{
  const f=await terminal({},'failed'),seed=plain((await f.api.read()).items[0]),cutoff=Date.now()-30*86400000;
  for(const errorCode of ['external_delivery.network','external_delivery.timeout','external_delivery.invalid_response','external_delivery.unconfirmed','external_channel.delivery_unknown','future.failure']){const row=plain(seed);row.delivery.errorCode=errorCode;a.equal(f.api.eligible(row,cutoff),false,errorCode);}
  const row=plain(seed);row.delivery.messageId='already_submitted';a.equal(f.api.eligible(row,cutoff),false);
});
test('real 13x adapter results, persisted by real finishJob, distinguish definite failures from unknown sends',async()=>{
  const {EventEmitter}=require('node:events');
  for(const mode of ['token-network','token-429','token-400','token-500','token-invalid','message-network','message-429','message-400','message-500','message-invalid','message-ok']){
    const f=await terminal({},'failed'),first=(await f.api.read()).items[0];await f.api.retry(retryBody(first));const job=await f.api.next(),requests=[];
    f.context.require=name=>{a.equal(name,'node:https');return{request(options,callback){const req=new EventEmitter(),token=options.path.includes('getAppAccessToken');req.destroy=()=>{};req.end=()=>{requests.push(options.path);queueMicrotask(()=>{const target=token?'token':'message';if(mode===target+'-network'){req.emit('error',Error('synthetic transport failure'));return;}const response=new EventEmitter();response.statusCode=mode===target+'-429'?429:mode===target+'-400'?400:mode===target+'-500'?500:200;response.headers={};response.destroy=()=>{};callback(response);response.emit('data',Buffer.from(mode===target+'-invalid'?'{}':JSON.stringify(token?{access_token:'SYNTHETIC_TOKEN'}:{id:'synthetic_confirmed_message'})));response.emit('end');});};return req;}};};
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/13x-external-channel-delivery.js'),'utf8')+';api.adapter=ExternalChannelDelivery.sendReply;',f.context);
    const result=await f.api.adapter({...job.connection,botSecret:'SYNTHETIC_SECRET'},job.item,job.item.execution.replyText,{attemptId:job.item.delivery.attemptId});await f.api.finish(job,result);f.advance(101*86400000);const preview=await f.api.preview(request());
    const unknown=['message-network','message-500','message-invalid'].includes(mode);a.equal(result.status,unknown?'unknown':mode==='message-ok'?'sent':'failed',mode);a.equal(preview.count,unknown?0:1,mode);if(!unknown){await f.api.reclaim(commit(preview));a.equal((await f.api.read()).retentionReceipts[0].delivery.status,result.status);}
    a.equal(f.counts().runs,0);a.equal(requests.length,mode.startsWith('token')?1:2);
  }
});
test('actual reclaimed producer rejects malformed attempt ID types on cold plain and sealed reads',async()=>{
  for(const enabled of [false,true]){
    const f=make({enabled});await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});await f.api.accept(f.message());await f.api.drain();await f.api.archive({id:(await f.api.read()).items[0].id,archived:true});await age(f);await f.api.reclaim(commit(await f.api.preview(request())));
    const good=plain(await f.api.read());a.equal(good.retentionReceipts[0].delivery.status,'sent');a.equal(typeof good.retentionReceipts[0].delivery.attemptId,'string');
    for(const bad of [null,7,true,false,0,-1,[],['attempt'],{},'','bad space','x'.repeat(51)]){
      const state=plain(good);state.retentionReceipts[0].delivery.attemptId=bad;a.equal(f.api.valid(state),false,JSON.stringify({enabled,bad}));
      const cold=make({enabled,key:f.key});if(enabled)await cold.seal(JSON.stringify(state));else cold.setDisk(JSON.stringify(state,null,2));const before=cold.disk();
      await a.rejects(cold.api.read(),{code:'external_channel.storage_unavailable'});await a.rejects(cold.api.accept(cold.message()),{code:'external_channel.storage_unavailable'});await a.rejects(cold.api.next(),{code:'external_channel.storage_unavailable'});a.equal(cold.disk(),before);a.equal(cold.counts().runs,0);a.equal(cold.counts().sends,0);
    }
  }
});
test('setup counters explicitly describe retained bodies and never reinterpret a reclaimed platform confirmation',async()=>{
  const f=make();await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});await f.api.accept(f.message());await f.api.drain();const before=plain(await f.api.setup({op:'inspect'},{}));a.deepEqual(before.connections[0].evidence,{scope:'retained_bodies',receivedMessages:1,confirmedReplies:1});
  await f.api.archive({id:(await f.api.read()).items[0].id,archived:true});await age(f);await f.api.reclaim(commit(await f.api.preview(request())));const after=plain(await f.api.setup({op:'inspect'},{}));a.deepEqual(after.connections[0].evidence,{scope:'retained_bodies',receivedMessages:0,confirmedReplies:0});a.match(after.guidance.evidence,/不是累计历史/);a.match(after.guidance.evidence,/不表示从未受理或撤销已确认/);const receipt=(await f.api.read()).retentionReceipts[0];a.equal(receipt.execution.status,'completed');a.equal(receipt.delivery.status,'sent');a.equal(receipt.delivery.messageId,'platform_reply');a.deepEqual(f.counts().runs,1);a.deepEqual(f.counts().sends,1);
  const english=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/locales/en-US.json'),'utf8'))['botSetup.evidenceHint'],chinese=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/public/locales/zh-CN.json'),'utf8'))['botSetup.evidenceHint'];a.match(english,/currently retained body records, not lifetime totals/);a.match(english,/undo an already confirmed platform reply/);a.match(chinese,/仅覆盖当前保留的正文记录，不是累计历史/);a.match(chinese,/不表示从未受理或撤销已确认/);
});
