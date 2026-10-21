'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createGateway,LIMIT}=require('./gateway-broker');
const {startFakeProvider}=require('../../lib/fake-openai-provider');
const request=content=>({version:1,id:crypto.randomUUID(),operation:'model-request',recipient:'m1-synthetic-provider',purpose:'model-inference',method:'POST',path:'/v1/chat/completions',bodyBase64:Buffer.from(JSON.stringify({model:'synthetic-m1',stream:true,messages:[{role:'user',content}]})).toString('base64')});
test('actual PrivacyCore protects raw and projected prompt strings before captured HTTP bytes',async()=>{
  const provider=await startFakeProvider({handler:()=> 'safe'});
  try {const broker=createGateway({upstream:provider.url});for(const text of ['SYNTHETIC_M1_CONTACT_SECRET',broker.projectedPrompt])assert.equal((await broker.handle(request(text))).status,200);assert.equal(provider.requests.length,2);assert(provider.requests.every(r=>!r.raw.includes('SYNTHETIC_M1_CONTACT_SECRET')));assert.equal(broker.evidence.requests[0].matches,1);assert.equal(broker.evidence.requests[1].matches,0);assert(broker.evidence.requests.every(r=>r.delivery==='confirmed'));assert.equal(JSON.stringify(broker.evidence).includes('SYNTHETIC_M1_CONTACT_SECRET'),false);}
  finally {await provider.close();}
});
test('recipient, purpose, route, method, frame extensions, base64, limit and unknown references stop before upstream',async()=>{
  const provider=await startFakeProvider();
  try {const broker=createGateway({upstream:provider.url});for(const mutate of [r=>r.recipient='other',r=>r.purpose='exec',r=>r.path='/arbitrary',r=>r.method='CONNECT',r=>r.url='http://arbitrary',r=>r.bodyBase64='%%%invalid',r=>r.bodyBase64='A'.repeat(Math.ceil(LIMIT/3)*4+1)]){const value=request('safe');mutate(value);await assert.rejects(broker.handle(value));}await assert.rejects(broker.handle(request('[[RUYI_PVT:INTERNAL:'+('a'.repeat(32))+']]')));assert.equal(provider.requests.length,0);assert.equal(broker.evidence.requests.length,0);}
  finally {await provider.close();}
});
test('expired request has zero submit; timeout after submission remains unknown',async()=>{
  const provider=await startFakeProvider({handler:()=>null});
  try {const expired=createGateway({upstream:provider.url,deadline:Date.now()-1});await assert.rejects(expired.handle(request('safe')));assert.equal(expired.evidence.requests.length,0);
    const live=createGateway({upstream:provider.url,deadline:Date.now()+200});await assert.rejects(live.handle(request('safe')));assert.equal(provider.requests.length,1);assert.equal(live.evidence.requests[0].delivery,'submitted-result-unknown');}
  finally {await provider.close();}
});
test('fetch adapter denies other targets without invoking exchange and bounds body before IPC',async()=>{
  const {createFetchAdapter}=await import('./fetch-adapter.mjs');let count=0;const adapter=createFetchAdapter(async value=>{count++;return {id:value.id,status:200,contentType:'text/event-stream',bodyBase64:Buffer.from('data: done\n\n').toString('base64')};});
  for(const url of ['http://privacy-gateway.invalid/v1/models','https://other.invalid/v1/models','https://privacy-gateway.invalid/arbitrary','https://privacy-gateway.invalid/v1/models?url=other','https://user@privacy-gateway.invalid/v1/models'])await assert.rejects(adapter(url));
  await assert.rejects(adapter('https://privacy-gateway.invalid/v1/chat/completions',{method:'POST',body:'x'.repeat(LIMIT+1)}));assert.equal(count,0);
  const response=await adapter('https://privacy-gateway.invalid/v1/chat/completions',{method:'POST',body:'{}'});assert.equal(await response.text(),'data: done\n\n');assert.equal(count,1);
});
test('fetch adapter rejects canceled requests and invalid or excessive replies',async()=>{
  const {createFetchAdapter}=await import('./fetch-adapter.mjs');const canceled=new AbortController();canceled.abort();let calls=0;
  await assert.rejects(createFetchAdapter(()=>{calls++;})('https://privacy-gateway.invalid/v1/models',{signal:canceled.signal}));assert.equal(calls,0);
  for(const change of [r=>r.id='wrong',r=>r.contentType='text/html',r=>r.bodyBase64='A'.repeat(Math.ceil(LIMIT/3)*4+1)]) {
    const adapter=createFetchAdapter(async value=>{const reply={id:value.id,status:200,contentType:'application/json',bodyBase64:'e30='};change(reply);return reply;});await assert.rejects(adapter('https://privacy-gateway.invalid/v1/models'));
  }
});
test('abort on final body read and already-aborted pipe submission produce zero exchange/write',async()=>{
  const {createFetchAdapter,writePipeFrame}=await import('./fetch-adapter.mjs');const control=new AbortController();let exchanges=0,writes=0;
  const stream=new ReadableStream({pull(controller){controller.close();control.abort();}});
  const adapter=createFetchAdapter(()=>{exchanges++;});await assert.rejects(adapter('https://privacy-gateway.invalid/v1/chat/completions',{method:'POST',body:stream,duplex:'half',signal:control.signal}));assert.equal(exchanges,0);
  assert.throws(()=>writePipeFrame({write(){writes++;}},{},control.signal));assert.equal(writes,0);
});
test('echo-only, user/meta/log rows and tool rows cannot establish the provider challenge',()=>{
  const {createAssistantObserver,controlEvent}=require('./run'),challenge='HOST_ONLY_NONCE',observer=createAssistantObserver(challenge);
  for(const value of [{role:'user',content:challenge},{role:'meta',content:challenge},{stage:'cleanup',content:challenge},{role:'assistant',content:challenge,tool_calls:[{}]}])observer.write(JSON.stringify(value)+'\n');
  observer.write('raw-log '+challenge+'\n');assert.equal(observer.observed,false);
  observer.write('{"role":"assistant","content":"HOST_');observer.write('ONLY_NONCE"}\n');assert.equal(observer.observed,true);
  assert.deepEqual(controlEvent({stage:'cleanup',profileDirectoryAbsent:true,payload:'SYNTHETIC_SPOOF_BODY'}),{stage:'cleanup',profileDirectoryAbsent:true});
  assert.deepEqual(controlEvent({stage:'error',errorType:'Exception',errorHresult:123,error:'SYNTHETIC_SPOOF_BODY'}),{stage:'error',errorType:'Exception',errorHresult:123});
  assert.equal(controlEvent({stage:'broker-request',request:{}}),null);
});
