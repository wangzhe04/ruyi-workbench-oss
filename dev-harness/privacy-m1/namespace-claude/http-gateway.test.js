'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {startGateway}=require('./http-gateway');
const {startFakeAnthropic}=require('../../lib/fake-anthropic-provider');
test('fixed HTTP routes reuse real PrivacyCore and body hashes, arbitrary proxy destinations denied',async()=>{
  const fake=await startFakeAnthropic({handler:()=> 'hostonlynonce-test'}),gateway=await startGateway({upstream:fake.url,responseChallenge:'hostonlynonce-test'});
  try{
    for(const route of ['/','/v1/messages?beta=false','/v1/messages?beta=true&url=http://example.com','/v1/messages?beta=true&beta=true','/v1/messages?x=1&beta=true','/v1/models']){
      const r=await fetch(gateway.url+route,{method:'POST',body:'{}'});assert.equal(r.status,403);
    }
    const body={model:'synthetic-m1',messages:[{role:'user',content:'SYNTHETIC_M1_CONTACT_SECRET'}],stream:true};
    for(const route of ['/v1/messages','/v1/messages?beta=true']){
      const r=await fetch(gateway.url+route,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200);assert.match(await r.text(),/hostonlynonce-test/);
    }
    assert.equal(fake.requests.length,2);assert.ok(fake.requests.every(r=>!r.raw.includes('SYNTHETIC_M1_CONTACT_SECRET')));
    assert.deepEqual(fake.requests.map(r=>crypto.createHash('sha256').update(r.raw).digest('hex')),gateway.evidence.requests.map(r=>r.upstreamBodySha256));
    assert.equal((await fetch(gateway.url+'/v1/messages',{method:'POST',body:JSON.stringify({...body,model:'other'})})).status,403);
  }finally{await gateway.close();await fake.close();}
});
