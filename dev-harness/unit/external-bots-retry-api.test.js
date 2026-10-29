'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto'),{EventEmitter}=require('node:events');
const repo=p.resolve(__dirname,'../..'),{retryCoreSource,replyRetryContracts,replyRetrySourceV2}=require('../lib/external-bots-source-history'),source=fs.readFileSync(p.join(repo,'ruyi-workbench/app/src/13w-external-bots.js'),'utf8');
const {fixture,plain,until}=require(repo+'/dev-harness/lib/external-bots-inbox-fixture'),{functionBlock,constBlock}=require(repo+'/dev-harness/lib/source-slice');
const target='/api/external-bots/deliveries/retry',request=(x,id='retry_request_00000001')=>({id:x.id,expectedAttemptId:x.delivery.attemptId,retryRequestId:id});
function make({worker=false,...options}={}) {
 const f=fixture({source,...options});f.trace={wakes:0,acks:0,bodyReads:0};f.auth={token:true,origin:true};
 Object.assign(f.context,{tokenOk:()=>f.auth.token,originOk:()=>f.auth.origin,json:(body,status=200)=>({body,status}),apiFailure:(code,params,message,status)=>({body:{ok:false,error:code},status}),send:(res,result)=>{f.trace.acks++;res.result=plain(result);res.writableEnded=true;}});
 vm.runInContext('api.http=handleExternalBotApiRoutes;api.workerBusy=()=>externalBotWorkerBusy;api.workerAgain=()=>externalBotWorkerAgain;api.workerStopped=value=>{externalBotWorkerStopped=value;};api.retry=body=>runKeyedChain(externalBotChains,"state",()=>externalBotRetryReply(body,EXTERNAL_BOT_LOCAL_REPLY_RETRY));',f.context);
 f.context.onWake=()=>{f.trace.wakes++;};
 vm.runInContext('const originalWake=externalBotWakeWorker;externalBotWakeWorker=()=>{onWake();return originalWake();};',f.context);
 f.api.workerStopped(!worker);
 f.call=(body,options={})=>{
  const req=new EventEmitter(),res=new EventEmitter();req.url=options.url||target;req.method=options.method||'POST';req.complete=true;req.headers=options.headers||{};
  req.pause=()=>{};req.destroy=()=>{req.destroyed=true;};res.destroyed=options.lost===true;res.writableEnded=false;res.setHeader=()=>{};
  const promise=f.api.http(req,res,options.pathname||new URL(req.url,'http://localhost').pathname);
  queueMicrotask(()=>{if(req.listenerCount('data')){f.trace.bodyReads++;req.emit('data',options.raw||Buffer.from(JSON.stringify(body)));req.emit('end');}});
  return promise.then(handled=>({handled,result:res.result,res}));
 };return f;
}
async function failed(options={},errorCode='external_delivery.predispatch'){
 const f=make(options);await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});
 await f.api.accept(f.message());await f.api.finish(await f.api.next(),{ok:true,say:'EXACT BUSINESS REPLY MUST NOT RERUN',turnSeq:1});
 await f.api.finish(await f.api.next(),{status:'failed',errorCode});return f;
}
async function item(f){return(await f.api.read()).items[0];}
function channel(f){
 const messages=[],requests=[];
 f.context.require=name=>{a.equal(name,'node:https');return{request(options,cb){const req=new EventEmitter();req.destroy=()=>{};req.end=bytes=>{requests.push(options.path);if(!options.path.includes('getAppAccessToken'))messages.push(Buffer.from(bytes));queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};cb(res);res.emit('data',Buffer.from(JSON.stringify(options.path.includes('getAppAccessToken')?{access_token:'FAKE'}:{id:'official_reply'})));res.emit('end');});};return req;}};};
 f.context.PrivacyGateway={withPolicy:(_scope,work)=>work(),disclosurePolicyGuard:()=>()=>{},prepareDisclosure:async()=>({receipt:{}}),refreshDisclosure:async()=> 'PROTECTED_REPLY',assertDisclosure(){}};
 vm.runInContext(fs.readFileSync(p.join(repo,'ruyi-workbench/app/src/13x-external-channel-delivery.js'),'utf8'),f.context);return{messages,requests};
}
test('exact route is token only; old auth rows and full core invert byte exactly',()=>{
 // Reconstruct the exact pre-retention registry before applying this historical retry insertion lock.
 // The retention fixture hashes both complete registries and removes only its two exact POST rows;
 // current retention auth/origin behavior is independently asserted in external-bots-retention-api.
 const auth=require('../lib/external-bots-source-history').beforeRetentionAuth(fs.readFileSync(p.join(repo,'ruyi-workbench/app/src/01b-route-auth.js'),'utf8')),context=vm.createContext({});vm.runInContext(auth+';globalThis.rows=ROUTE_AUTH;',context);const rows=plain(context.rows);
 a.deepEqual(rows.filter(x=>x.p===target),[{m:'POST',p:target,auth:'token'}]);const spans={spans:replyRetryContracts.apiSpans,auth:replyRetryContracts.auth};let inverse=replyRetrySourceV2(source);
 for(const row of spans.spans.toReversed()){a.equal(inverse.split(row.after).length,2);inverse=inverse.replace(row.after,row.before);}a.equal(inverse,retryCoreSource(source));
 // spans.auth.base 钉的是「重试那一行落地之前」01b-route-auth.js 的整文件字节。这张表是所有特性共用的路由清单,
 // 后来者(如 /api/work-data/uploads)往同一张表追加自己的 auth 行,整文件 hash 就会合法地变,而重试那一行的字节
 // 一字未动。所以整文件身份改成:删掉后来追加的整条路由行(至多三条)必须精确回到 base,且被删掉的必须是完整路由行、
 // 不碰 /api/external-bots/;重试自己那一段的插入形状与字节仍然钉死。超过这个形状就是读者真的和历史错位了。
 const sha256=value=>c.createHash('sha256').update(value).digest('hex'),splicedAuth=auth.replace(spans.auth.after,spans.auth.before);
 a.equal(auth.split(spans.auth.after).length,2,'重试那一行在路由表里恰出现一次');
 a.equal(spans.auth.after.slice(spans.auth.before.length),`\n  { m: 'POST', p: '${target}', auth: 'token' },`,'重试提交只在这张表上加了这一行');
 const driftRows=value=>{const lines=value.split('\n'),rowIdx=lines.map((line,j)=>/^  \{ m: '[A-Z]+', p: '/.test(line)?j:-1).filter(j=>j>=0),drop=idx=>sha256(lines.filter((_,j)=>!idx.includes(j)).join('\n'));
  for(const i of rowIdx){if(drop([i])===spans.auth.base)return[lines[i]];for(const k of rowIdx)if(k>i&&drop([i,k])===spans.auth.base)return[lines[i],lines[k]];}
  const workData=rowIdx.filter(i=>lines[i].includes('/api/work-data/'));for(const i of workData)for(const k of workData)for(const j of workData)if(new Set([i,k,j]).size===3&&drop([i,k,j])===spans.auth.base)return[lines[i],lines[k],lines[j]];return null;};
 if(sha256(splicedAuth)!==spans.auth.base){const drift=driftRows(splicedAuth);
  a.ok(drift,`整文件身份只允许被其它特性追加的整条路由行挪动(实测 ${sha256(splicedAuth)} 回不到 ${spans.auth.base})`);
  for(const row of drift){a.match(row,/^  \{ m: '[A-Z]+', p: '\/[^']*', auth: '[a-z-]+'(, prefix: true)? \},$/,'被追加的必须是完整路由行');a.ok(!row.includes('/api/external-bots/'),'被追加的路由行不得碰外部机器人');}}
 for(const name of ['externalBotRetryReply','externalBotCancellationWindow','externalBotCancelDelivery','externalBotNextJob','externalBotFinishJob','externalBotPrepareReply','externalBotRecover','externalBotDrain','externalBotWakeWorker'])a.equal(functionBlock(replyRetrySourceV2(source),name),functionBlock(inverse,name));
 a.equal(constBlock(source,'externalBotStore'),constBlock(inverse,'externalBotStore'));
});
test('token and origin gates refuse before reading request body or touching ledger',async()=>{
 for(const gate of ['token','origin']){const f=await failed(),body=request(await item(f)),bytes=f.disk(),writes=f.counts().writes;f.auth[gate]=false;const r=await f.call(body);
 a.equal(r.result.status,403);a.equal(r.result.body.error,'auth.'+(gate==='token'?'token_invalid':'origin_rejected'));a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);a.equal(f.trace.bodyReads,0);a.equal(f.trace.wakes,0);}
});
test('exact path and POST only; query refuses before body, no similar prefix accepted',async()=>{
 const f=await failed(),body=request(await item(f)),bytes=f.disk();
 a.equal((await f.call(body,{url:target+'/extra'})).handled,false);
 for(const method of ['GET','PUT','DELETE'])a.equal((await f.call(body,{method})).result.status,405);
 a.equal((await f.call(body,{url:target+'?x=1'})).result.body.error,'external_channel.request_invalid');a.equal(f.disk(),bytes);a.equal(f.trace.wakes,0);a.equal(f.trace.bodyReads,0);
});
test('strict JSON UTF8/body bound and exact three fields cannot mint authority or change payload',async()=>{
 const f=await failed(),body=request(await item(f)),bytes=f.disk();
 for(const raw of [Buffer.from('[]'),Buffer.from('{'),Buffer.from([0xc0,0xaf])])a.equal((await f.call(body,{raw})).result.body.error,'external_channel.body_invalid');
 for(const patch of [{authority:true},{localAuthorized:true},{attemptId:'injected'},{retryRequestId:'short'},{expectedAttemptId:''}])a.equal((await f.call({...body,...patch})).result.body.error,'external_channel.request_invalid');
 a.equal((await f.call(body,{headers:{'content-length':'65537'}})).result.status,413);a.equal(f.disk(),bytes);a.equal(f.trace.wakes,0);
});
test('new HTTP action commits same pending attempt and history then wakes original worker once',async()=>{
 const f=await failed(),old=plain(await item(f)),writes=f.counts().writes,r=await f.call(request(old)),state=await f.api.read();
 a.equal(r.handled,true,'exact local retry route must be handled');a.equal(r.result.status,200);a.equal(r.result.body.alreadyRetried,false);a.equal(state.schema,4);a.equal(state.items[0].delivery.status,'pending');a.equal(state.items[0].replyHistory.length,1);
 a.deepEqual(plain(state.items[0].replyHistory[0].attempt),old.delivery);a.deepEqual(plain(state.items[0].execution),old.execution);a.equal(f.counts().writes,writes+1);a.equal(f.trace.wakes,1);a.equal(f.counts().runs,0);a.equal(f.counts().sends,0);
});
test('pending durability blocks ACK and wake; write failure produces neither',async()=>{
 const f=await failed(),body=request(await item(f)),bytes=f.disk(),writes=f.counts().writes;let release,settled=false;f.gate(new Promise(r=>release=r));
 const pending=f.call(body).then(r=>{settled=true;return r;});await until(()=>f.counts().writes===writes+1);a.equal(settled,false);a.equal(f.trace.wakes,0);a.equal(f.trace.acks,0);a.equal(f.disk(),bytes);release();await pending;a.equal(f.trace.wakes,1);
 const g=await failed(),before=g.disk();g.fail(true);const r=await g.call(request(await item(g)));a.equal(r.result.body.error,'external_channel.storage_unavailable');a.equal(g.trace.wakes,0);a.equal(g.disk(),before);
});
test('lost ACK after durable commit: stable request resumes same pending attempt without write',async()=>{
 const f=await failed(),body=request(await item(f)),first=await f.call(body,{lost:true});a.equal(first.result,undefined);a.equal(f.trace.wakes,1);
 const bytes=f.disk(),writes=f.counts().writes,second=await f.call(body);a.equal(second.result.body.alreadyRetried,true);a.equal(second.result.body.receipt.previousAttemptId,body.expectedAttemptId);a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);a.equal(f.trace.wakes,2);
});
test('commit succeeded but writer reports lost result: same human receipt resumes only own pending',async()=>{
 const f=await failed(),body=request(await item(f)),writer=f.context.atomicWriteJson;f.context.atomicWriteJson=async(...args)=>{await writer(...args);throw Error('synthetic lost commit result');};
 const first=await f.call(body);a.equal(first.result.body.error,'external_channel.storage_unavailable');a.equal(f.trace.wakes,0);f.context.atomicWriteJson=writer;
 const bytes=f.disk(),writes=f.counts().writes,second=await f.call(body);a.equal(second.result.body.alreadyRetried,true);a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);a.equal(f.trace.wakes,1);
});
test('historical same request after sent cancelled unknown or later attempt returns exact original receipt without wake',async()=>{
 for(const status of ['sent','cancelled','unknown','later']){const f=await failed(),body=request(await item(f)),first=(await f.call(body)).result.body;
 if(status==='cancelled'){const cur=await item(f);await f.api.cancel({id:cur.id,attemptId:cur.delivery.attemptId});}
 else {await f.api.finish(await f.api.next(),status==='sent'?{status:'sent',messageId:'official_reply'}:status==='unknown'?{status:'unknown',errorCode:'external_channel.delivery_unknown'}:{status:'failed',errorCode:'external_delivery.token_network'});if(status==='later')await f.call(request(await item(f),'retry_request_00000002'));}
 const bytes=f.disk(),writes=f.counts().writes,wakes=f.trace.wakes,again=(await f.call(body)).result.body;
 a.equal(again.alreadyRetried,true);a.deepEqual(again.receipt,first.receipt);a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);a.equal(f.trace.wakes,wakes);a.equal(f.counts().runs,0);}
});
test('unsafe unknown sent cancelled pending sending and non-whitelisted failed provenance refuse with zero wake',async()=>{
 for(const status of ['unknown','sent','cancelled','pending','sending','429']){const f=await failed({},status==='429'?'external_delivery.rate_limited':'external_delivery.predispatch');
 if(status!=='429'){const state=plain(await f.api.read());state.items[0].delivery.status=status;state.items[0].delivery.messageId=status==='sent'?'message':'';if(status==='cancelled'){state.schema=3;for(const row of state.items)row.archivedAt='';state.items[0].delivery.cancelledAt=new Date().toISOString();state.items[0].delivery.errorCode='external_channel.delivery_cancelled';}await f.api.write(state);}
 const bytes=f.disk(),r=await f.call(request(await item(f)));a.equal(r.result.body.error,'external_channel.delivery_cannot_retry');a.equal(f.disk(),bytes);a.equal(f.trace.wakes,0);a.equal(f.counts().runs,0);}
});
test('concurrent same request serializes one durable attempt, allowed pending wakes never mint another',async()=>{
 const f=await failed(),body=request(await item(f)),writes=f.counts().writes,[one,two]=await Promise.all([f.call(body),f.call(body)]);
 a.equal(one.result.body.alreadyRetried,false);a.equal(two.result.body.alreadyRetried,true);a.deepEqual(one.result.body.receipt,two.result.body.receipt);a.equal(f.counts().writes,writes+1);a.equal(f.trace.wakes,2);
});
test('different request IDs race for predecessor; one succeeds and old-attempt replay conflicts',async()=>{
 const f=await failed(),body=request(await item(f)),outcomes=await Promise.all([f.call(body),f.call({...body,retryRequestId:'retry_request_00000002'})]);a.equal(outcomes[0].result.status,200);a.equal(outcomes[1].result.body.error,'external_channel.delivery_changed');a.equal(f.trace.wakes,1);a.equal((await item(f)).replyHistory.length,1);
});
test('cancel/retry both orderings use shared state chain; old cancellation cannot cancel successor',async()=>{
 for(const cancelFirst of [true,false]){const f=await failed(),old=await item(f),retry=()=>f.call(request(old)),cancel=()=>f.call({id:old.id,attemptId:old.delivery.attemptId},{url:'/api/external-bots/deliveries/cancel'}),results=await Promise.all(cancelFirst?[cancel(),retry()]:[retry(),cancel()]);
 a.equal(results[cancelFirst?1:0].result.status,200);a.equal(results[cancelFirst?0:1].result.body.error,cancelFirst?'external_channel.delivery_cannot_cancel':'external_channel.delivery_changed');a.equal((await item(f)).delivery.status,'pending');a.equal(f.trace.wakes,1);}
});
test('accurate successor cancellation retains payload4 history and later old retry cannot resurrect it',async()=>{
 const f=await failed(),body=request(await item(f)),first=(await f.call(body)).result.body,current=await item(f);
 const cancel=await f.call({id:current.id,attemptId:current.delivery.attemptId},{url:'/api/external-bots/deliveries/cancel'});a.equal(cancel.result.status,200);a.equal((await f.api.read()).schema,4);
 const bytes=f.disk(),again=(await f.call(body)).result.body;a.deepEqual(again.receipt,first.receipt);a.equal(again.item.delivery.status,'cancelled');a.equal(f.disk(),bytes);a.equal(f.trace.wakes,1);
});
test('actual wake/drain/next/13x message path sends only original reply, never original completed business again',async()=>{
 const f=await failed({worker:true}),old=plain(await item(f)),channelResult=channel(f),body=request(old),res=await f.call(body);
 a.equal(res.result.body.alreadyRetried,false);await until(()=>!f.api.workerBusy());a.equal((await item(f)).delivery.status,'sent');a.equal(f.counts().runs,0);a.equal(channelResult.requests.length,2);a.equal(channelResult.messages.length,1);a.match(channelResult.messages[0].toString(),/PROTECTED_REPLY/);a.doesNotMatch(channelResult.messages[0].toString(),/EXACT BUSINESS REPLY/);
 const again=await f.call(body);a.equal(again.result.body.alreadyRetried,true);await f.api.drain();a.equal(f.trace.wakes,1);a.equal(channelResult.messages.length,1);a.equal(f.counts().runs,0);a.deepEqual(plain((await item(f)).execution),old.execution);
});
test('real original 40MiB pretty capacity refuses route before durable write or wake in both Store modes',async()=>{
 for(const enabled of [false,true]){const f=await failed({enabled}),state=plain(await f.api.read()),seed=state.items[0],count=40;
 state.items=Array.from({length:count},(_,n)=>{const row=plain(seed);row.id='physical_item_'+n;row.messageId='physical_message_'+n;row.eventId='physical_event_'+n;row.sourceKey=JSON.stringify([row.connectionId,row.tenantId,row.conversationId,row.messageId]);row.execution.replyText='X'.repeat(1024*1024);return row;});
 const targetBytes=f.api.limits.stateBytes-1,size=Buffer.byteLength(JSON.stringify(state,null,2));a.ok(size>targetBytes);state.items.at(-1).execution.replyText=state.items.at(-1).execution.replyText.slice(0,-(size-targetBytes));a.equal(Buffer.byteLength(JSON.stringify(state,null,2)),targetBytes);a.equal(f.api.valid(state),true);await f.api.write(state);
 const body=request((await f.api.read()).items[0]),bytes=f.disk(),writes=f.counts().writes,r=await f.call(body);a.equal(r.result.body.error,'external_channel.inbox_full');a.equal(f.trace.wakes,0);a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);await f.api.read();}
});

test('root counter: same explicit human receipt resumes sole durable pending attempt after writer lost result',async()=>{
 const f=await failed({worker:true}),outbound=channel(f),body=request(await item(f)),writer=f.context.atomicWriteJson;
 f.context.atomicWriteJson=async(...args)=>{await writer(...args);throw Error('synthetic lost commit result');};
 const first=await f.call(body);a.equal(first.result.body.error,'external_channel.storage_unavailable');a.equal(f.trace.wakes,0);
 f.context.atomicWriteJson=writer;const pending=plain(await item(f)),bytes=f.disk(),writes=f.counts().writes;
 const again=await f.call(body);a.equal(again.result.body.alreadyRetried,true);a.equal(again.result.body.receipt.attemptId,pending.delivery.attemptId);
 for(let tick=0;tick<4;tick++)await new Promise(setImmediate);
 await until(()=>!f.api.workerBusy());
 const current=await item(f);console.log(JSON.stringify({counter:'root-lost-commit-result-human-reconcile',status:current.delivery.status,wakes:f.trace.wakes,businessRuns:f.counts().runs,messageRequests:outbound.messages.length,history:current.replyHistory.length,workerBusy:f.api.workerBusy()}));
 a.equal(current.delivery.status,'sent','same explicit human request must resume its one durable pending reply');a.equal(outbound.messages.length,1);a.equal(f.counts().runs,0);
 a.equal(current.replyHistory.length,1);a.equal(current.delivery.attemptId,pending.delivery.attemptId);a.equal(f.trace.wakes,1);a.equal(f.counts().writes,writes+2);
});
test('twenty concurrent stable receipt resumes produce one MESSAGE and no new attempt or business work',async()=>{
 const f=await failed({worker:true}),outbound=channel(f),body=request(await item(f)),writer=f.context.atomicWriteJson;
 f.context.atomicWriteJson=async(...args)=>{await writer(...args);throw Error('lost commit result');};await f.call(body);f.context.atomicWriteJson=writer;
 const pending=plain(await item(f)),responses=await Promise.all(Array.from({length:20},()=>f.call(body)));await until(()=>!f.api.workerBusy());
 for(const response of responses){a.equal(response.result.body.alreadyRetried,true);a.equal(response.result.body.receipt.attemptId,pending.delivery.attemptId);}
 const done=await item(f);a.equal(done.delivery.status,'sent');a.equal(done.delivery.attemptId,pending.delivery.attemptId);a.equal(done.replyHistory.length,1);a.equal(outbound.messages.length,1);a.equal(f.counts().runs,0);
 const wakes=f.trace.wakes,again=await f.call(body);a.equal(again.result.body.alreadyRetried,true);a.equal(f.trace.wakes,wakes);a.equal(outbound.messages.length,1);
});
test('old durable receipt never wakes a later pending attempt even when old request ID is valid',async()=>{
 const f=await failed(),one=request(await item(f)),first=await f.call(one);await f.api.finish(await f.api.next(),{status:'failed',errorCode:'external_delivery.token_network'});
 const two=request(await item(f),'retry_request_00000002');await f.call(two);const pending=await item(f),writes=f.counts().writes,wakes=f.trace.wakes,bytes=f.disk();
 const old=await f.call(one);a.equal(old.result.body.alreadyRetried,true);a.equal(old.result.body.item.delivery.status,'pending');a.notEqual(old.result.body.item.delivery.attemptId,old.result.body.receipt.attemptId);
 a.deepEqual(old.result.body.receipt,first.result.body.receipt);a.equal(f.trace.wakes,wakes);a.equal(f.disk(),bytes);a.equal(f.counts().writes,writes);a.equal((await item(f)).delivery.attemptId,pending.delivery.attemptId);
});
test('same durable pending receipt never bypasses current owner checks in actual worker',async()=>{
 const f=await failed({worker:true}),outbound=channel(f),body=request(await item(f)),writer=f.context.atomicWriteJson;
 f.context.atomicWriteJson=async(...args)=>{await writer(...args);throw Error('lost commit result');};await f.call(body);f.context.atomicWriteJson=writer;
 await f.api.update({op:'disable',id:f.connection.id});const again=await f.call(body);a.equal(again.result.body.alreadyRetried,true);await until(()=>!f.api.workerBusy());
 a.equal((await item(f)).delivery.status,'failed');a.equal((await item(f)).delivery.errorCode,'external_channel.control_revoked');a.equal(outbound.messages.length,0);a.equal(f.counts().runs,0);a.equal((await item(f)).replyHistory.length,1);
});
test('same durable pending receipt requires token and origin again before any resume wake',async()=>{
 for(const gate of ['token','origin']){const f=await failed(),body=request(await item(f));await f.call(body);const bytes=f.disk(),wakes=f.trace.wakes;f.auth[gate]=false;
 const result=await f.call(body);a.equal(result.result.status,403);a.equal(f.trace.wakes,wakes);a.equal(f.disk(),bytes);}
});
