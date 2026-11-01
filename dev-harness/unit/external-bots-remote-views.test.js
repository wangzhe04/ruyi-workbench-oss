'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {make,request}=require('../lib/external-bots-remote-views-fixture');
test('reserved deterministic parser rejects malformed commands and duplicate JSON without any model fallback',async t=>{
 const {f,api}=await make(t),code=f.context.externalBotRemoteNewCode().code,id='rv_'+Buffer.alloc(16,7).toString('base64url');
 for(const text of ['normal business text','please /pending later'])a.equal(api.parse(text),null);
 a.equal(api.parse('/pending').kind,'pending');a.equal(api.parse('/pending '+id+' 2').page,2);a.equal(api.parse('/revoke '+code).code,code);a.equal(api.parse('/decide '+code+' approve bounded feedback').feedback,'bounded feedback');a.equal(api.parse('/answer '+code+' [{"q":1,"options":[2]}]').answer[0].q,1);
 for(const text of ['/pending-extra','/pending bad','/pending '+id+' 0','/decide '+code+' allow hidden','/decide '+code+' allow extra fields','/answer '+code+' [{"q":1,"q":2,"text":"x"}]','/answer '+code+' [{"q":1,"options":[1,1]}]','/answer '+code+' [{"q":1,"text":"x","userPressed":true}]','/answer '+code+' [{"q":1,"text":"x"},{"q":1,"text":"y"}]','/revoke '+code+' extra','/decide invalid allow','/answer '+code+' '+ 'x'.repeat(4001)])a.throws(()=>api.parse(text),{code:'external_channel.request_invalid'});
 a.equal(f.counts().runs,0);a.equal(f.counts().sends,0);
});
test('all five strict typed sources preserve full content, protect before stable pages and require earlier page receipts',async t=>{
 const {api,state}=await make(t),tickets=await api.collect();a.equal(tickets.length,5);
 for(const ticket of tickets){const view=await api.project(ticket,'exact group audience'),parts=[];for(let i=1;i<=view.pages;i++){const page=await api.page(view.handle,i,'exact group audience');parts.push(page.text);a.equal(page.complete,view.pages===1);page.assert();}const text=parts.join('');a.equal(text.includes('PRIVATE_SOURCE_CANARY'),false);if(text.includes('long plan'))a.ok(text.length>6000);a.equal(JSON.stringify(view).includes('session'),false);}
 const plan=await api.project(await api.readSource('session','iv_plan'),'exact group audience');a.ok(plan.pages>1);const last=await api.page(plan.handle,plan.pages,'exact group audience');a.equal(last.complete,false);await a.rejects(api.page(plan.handle,1,'another group'));
 a.ok(state.strictReads>=10);
});
test('unknown/degraded/missing or nonlive sources fail closed and changed full material invalidates an already protected page',async t=>{
 const f=await make(t);f.state.degraded=true;await a.rejects(f.api.collect());f.state.degraded=false;
 for(const [type,mutate]of [['plan',()=>f.plans.delete('iv_plan')],['pool',()=>f.run.status='paused'],['replan',()=>f.run.replanPatches[0].changes=[]]]){const savedPlans=new Map(f.plans),run=structuredClone(f.run);mutate();await a.rejects(f.api.readSource('session','iv_'+type));f.plans.clear();for(const[key,value]of savedPlans)f.plans.set(key,value);Object.assign(f.run,run);}
 const view=await f.api.project(await f.api.readSource('session','iv_plan'),'group'),page=await f.api.page(view.handle,1,'group');f.plans.get('iv_plan').markdown+=' changed beyond summary';a.throws(page.assert);await a.rejects(f.api.page(view.handle,1,'group'));
 const question=await f.api.project(await f.api.readSource('session','iv_question'),'group'),qpage=await f.api.page(question.handle,1,'group');f.qs.get('iv_question').questions[0].options[0].label='changed';a.throws(qpage.assert);
 f.runs.clear();f.run.status='completed';const persisted=await f.api.project(await f.api.readSource('session','iv_replan'),'group'),rp=await f.api.page(persisted.handle,1,'group');fs.appendFileSync(f.runFile,'later persisted revision');a.throws(rp.assert);
});
test('policy, config, journal and session fences reject late changes without re-executing or reading a permissive source',async t=>{
 for(const cause of ['policy','config','journal','session']){const f=await make(t),view=await f.api.project(await f.api.readSource('session','iv_permission'),'group'),page=await f.api.page(view.handle,1,'group');if(cause==='policy')f.gateway.configure({privacyModeV1:'off',providers:[]});else if(cause==='config')f.state.generation++;else if(cause==='session')f.state.seq++;else fs.appendFileSync(f.journal,'later journal write');a.throws(page.assert);a.equal(f.f.counts().runs,0);a.equal(f.f.counts().sends,0);}
});
test('original ledger/outbox stages protected pages, arms only final fully shown offer, and emits code only at exact dispatch',async t=>{
 const {f,api}=await make(t),first=await request(f,'page_1'),recipient=(await api.context(first)).recipient,view=await api.project(await api.readSource('session','iv_plan'),recipient);let rawCode,offerId;
 for(let number=1;number<=view.pages;number++){
  const itemId=number===1?first:await request(f,'page_'+number),staged=await api.stage(itemId,view.handle,number);a.equal(Boolean(staged.offerId),number===view.pages);offerId=staged.offerId||offerId;
  const state=await f.api.read();a.equal(state.schema,7);a.equal(state.items.at(-1).execution.replyText.includes('PRIVATE_SOURCE_CANARY'),false);a.equal(state.items.at(-1).execution.replyText.includes('ra_'),false);
  await a.rejects(api.recordDelivery(itemId));const job=await f.api.next(),controller=new AbortController();f.api.live.set(itemId,{controller,attemptId:job.item.delivery.attemptId,submitted:false});
  await f.api.prepare(job,controller,prepared=>{a.equal(prepared.text.includes('PRIVATE_SOURCE_CANARY'),false);a.equal(/ra_[A-Za-z0-9_-]{22}/.test(prepared.text),number===view.pages);if(number===view.pages)rawCode=prepared.text.match(/ra_[A-Za-z0-9_-]{22}/)[0];a.throws(()=>prepared.assertCurrent({text:prepared.text.slice(0,-1)}));prepared.assertCurrent({text:prepared.text});return{status:'sent',messageId:'sent_'+number};});
  f.api.live.delete(itemId);await f.api.finish(job,{status:'sent',messageId:'sent_'+number});await api.recordDelivery(itemId);
 }
 a.ok(rawCode);a.equal(f.disk().includes(rawCode),false);a.equal(JSON.stringify(await f.api.page('limit=100')).includes(rawCode),false);a.equal((await f.api.read()).remoteActions[0].claim,null);
 const revokeMessage=await request(f,'revoke_owner'),revoked=await api.withdraw(revokeMessage,rawCode);a.equal(revoked.status,'revoked');a.equal(revoked.offerId,offerId);a.equal(f.disk().includes(rawCode),false);a.equal(f.counts().runs,0);a.equal(f.counts().sends,0);
});
test('volatile offers expire or revoke on a new boot without reconstructing a code or executing an action',async t=>{
 for(const reboot of [false,true]){const {f,api}=await make(t),itemId=await request(f,'expiry_message'),recipient=(await api.context(itemId)).recipient,view=await api.project(await api.readSource('session','iv_permission'),recipient),staged=await api.stage(itemId,view.handle,1);a.ok(staged.offerId);const job=await f.api.next();if(reboot)f.context.OVERLAY_ID='new_boot';else f.advance(300001);await api.expire();const row=(await f.api.read()).remoteActions[0];a.equal(row.status,reboot?'revoked':'expired');a.equal(row.claim,null);const controller=new AbortController();f.api.live.set(itemId,{controller,attemptId:job.item.delivery.attemptId,submitted:false});let dispatches=0;await a.rejects(f.api.prepare(job,controller,()=>{dispatches++;}));a.equal(dispatches,0);a.equal(f.counts().runs,0);a.equal(f.counts().sends,0);}
});
