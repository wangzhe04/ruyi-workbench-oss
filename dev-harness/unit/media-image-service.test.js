'use strict';
// Pure in-memory contracts only. No server, socket, Python, native helper or
// actual OCR/QR validation is exercised by this file.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['01i-privacy-rules.js', '01h-privacy-core.js', '13ba-media-image-contract.js', '13bd-media-image-service.js']
  .map(name => fs.readFileSync(path.join(sourceRoot, name), 'utf8')).join('\n');
const api = vm.runInNewContext(sources + ';({MediaImageContract,MediaImageService});', { require, Buffer, Headers, setTimeout, clearTimeout });
function fixture({ words = [{ text: 'secret@example.test', line: 0, box: [1,1,5,5] }], attested = false } = {}) {
  let time = Date.now(), sourceChanged = false, policyChanged = false, processorChanged = false, sessionId = 'sess_one', released = false;
  const bytes = Buffer.alloc(32,7), scope = sha(sessionId).slice(0,32), config = { personal: true, knownSecrets: [], rules: [] };
  const source = { id:'file_one', name:'private-name.png', snapshot: { bytes, hash:sha(bytes), revision:'r1', scope },
    assert() { if (sourceChanged) throw Object.assign(Error('source'),{code:'privacy.image_source_changed'}); return true; }, release: async () => { released = true; } };
  const policy = { config, hash:sha(JSON.stringify(config)), rulesHash:sha('rules'), revision:'p1', assert() {
    if (policyChanged) throw Object.assign(Error('policy'),{code:'privacy.policy_changed'}); return true;
  } };
  const snapshot = { hash:sha('processor'), version:'v1' };
  let actualFrame;
  const processor = { capture:()=>snapshot, assert() { if(processorChanged)throw Object.assign(Error('processor'),{code:'privacy.image_processor_owner_changed'});return true; },
    start() { actualFrame = { rgba:Buffer.alloc(12*12*4,255), width:12, height:12, sourceHash:source.snapshot.hash, processorHash:snapshot.hash,
      frames:1, orientationApplied:true, ocrComplete:true, codesComplete:true, transform:{width:12,height:12,orientation:1}, words, codes:[] };
      return { promise:Promise.resolve(actualFrame), finish:()=>({closed:true,helperMayStillRun:false,ownershipRetained:false}) }; },
    ...(attested ? { assertCoverage: frame => { assert.equal(frame,actualFrame); return true; } } : {}) };
  const stored = new Map(); let storageReads = 0;
  const service = api.MediaImageService.create({ now:()=>time, context:()=>({scopeId:sessionId}), storeFor:async ({authority})=>({
    async put(value) { const captured = await authority.capture(value.sourceId); authority.assert(captured);
      stored.set('mimg_a', { ...value, bytes:Buffer.from(value.bytes), captured }); return {id:'mimg_a'}; },
    async read(id) { storageReads++; const value=stored.get(id); if(!value)throw Error('missing'); const copy=Buffer.from(value.bytes);let dead=false;
      return { bytes:copy,manifest:value.manifest,assert(){assert.equal(dead,false);authority.assert(value.captured);assert.equal(sha(copy),value.manifest.payloadHash);return true;},release(){dead=true;copy.fill(0);} }; },
    async remove(id){ const value=stored.get(id);value?.bytes.fill(0);stored.delete(id);return true;},
  }) });
  const recipient = api.MediaImageService.recipientHash('http://localhost/v1/chat/completions',{'authorization':'Bearer synthetic'});
  return { service, source, policy, processor, recipient, stored,
    prepare:()=>service.prepare({sessionId:'sess_one',source,policy,processor,recipient}),
    attachment:result=>({id:source.id,name:source.name,path:'C:/never-read/raw.png',sendPath:'C:/never-read/send.jpg',kind:'image',protectedImage:{reference:result.reference}}),
    setSourceChanged:()=>{sourceChanged=true;},setPolicyChanged:()=>{policyChanged=true;},setProcessorChanged:()=>{processorChanged=true;},
    setScope:value=>{sessionId=value;},expire:()=>{time+=61000;},released:()=>released,storageReads:()=>storageReads };
}
test('empty OCR supplied as arrays without a detector owner proof retains the old refusal',async()=>{
  const f=fixture({words:[]});await assert.rejects(f.prepare(),error=>error.code==='privacy.image_unrecognized');assert.equal(f.released(),true);
});
test('a trusted internal coverage proof admits an actual completed no-text frame in the contract model',async()=>{
  const f=fixture({words:[],attested:true});const prepared=await f.prepare();
  const borrowed=await f.service.borrow(prepared.id);assert.equal(borrowed.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(prepared.recognitionConfidence,'unknown');borrowed.release();await f.service.remove(prepared.id);
});
test('preview and wire delivery read the same stored PNG and never read attachment raw/send paths',async()=>{
  const f=fixture();const prepared=await f.prepare(), attachment=f.attachment(prepared);
  const ref=f.service.referenceFor(attachment);assert.equal(ref,prepared.reference);
  const preview=await f.service.borrow(prepared.id);const previewHash=sha(preview.bytes);preview.release();
  for(const part of [{type:'image_url',image_url:{url:ref}},{type:'input_image',image_url:ref},{type:'image',source:{type:'url',url:ref}}]){
    const projected=f.service.projectPart(part,{scopeId:'sess_one',pointer:'/messages/0/content/0'});assert.ok(projected);
    const batch=await f.service.delivery({messages:[{role:'user',content:[part]}]},f.recipient);
    batch.assert();const actual=batch.body.messages[0].content[0];
    const b64=actual.source?.data || (typeof actual.image_url==='string'?actual.image_url:actual.image_url.url).split(',')[1];
    assert.equal(sha(Buffer.from(b64,'base64')),previewHash);batch.release();
  }
  assert.equal(f.storageReads(),4);await f.service.remove(prepared.id);assert.equal(f.stored.size,0);assert.equal(f.released(),true);
});
for(const mutation of ['setSourceChanged','setPolicyChanged','setProcessorChanged'])test(`final assertion rejects ${mutation} after last storage await`,async()=>{
  const f=fixture(),prepared=await f.prepare();const batch=await f.service.delivery({messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]},f.recipient);
  f[mutation]();assert.throws(()=>batch.assert());batch.release();await f.service.remove(prepared.id);
});
test('scope, recipient, expiry and a forged reference each reject without plaintext fallback',async()=>{
  const f=fixture(),prepared=await f.prepare();const body={messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]};
  await assert.rejects(f.service.delivery(body,sha('foreign')),error=>error.code==='privacy.image_recipient_changed');
  f.setScope('sess_foreign');assert.throws(()=>f.service.referenceFor(f.attachment(prepared)),error=>error.code==='privacy.image_scope_changed');f.setScope('sess_one');
  assert.throws(()=>f.service.referenceFor({...f.attachment(prepared),id:'file_other'}),error=>error.code==='privacy.image_source_changed');
  f.expire();await assert.rejects(f.service.borrow(prepared.id),error=>error.code==='privacy.image_expired');await f.service.remove(prepared.id);
  const fake='https://ruyi.invalid/protected-image/'+'b'.repeat(32);
  await assert.rejects(f.service.delivery({messages:[{role:'user',content:[{type:'image_url',image_url:{url:fake}}]}]},f.recipient));
});
test('references in tool/assistant blocks cannot acquire a user image disclosure',async()=>{
  const f=fixture(),prepared=await f.prepare();
  for(const role of ['tool','assistant'])await assert.rejects(f.service.delivery({messages:[{role,content:[{type:'image_url',image_url:{url:prepared.reference}}]}]},f.recipient),error=>error.code==='privacy.image_media_position');
  await f.service.remove(prepared.id);
});
test('revocation zeroes outstanding preview borrows and the source is kept outside the derived store',async()=>{
  const f=fixture(),prepared=await f.prepare(),borrowed=await f.service.borrow(prepared.id);
  await f.service.revokeScope('sess_one');assert.equal(borrowed.bytes.every(byte=>byte===0),true);assert.throws(()=>borrowed.assert());borrowed.release();
  assert.equal(borrowed.bytes.every(byte=>byte===0),true);assert.equal(f.source.snapshot.bytes.every(byte=>byte===7),true);
});
test('unknown image POST outcome prevents an automatic submission retry; acknowledged requests retain continuity',async()=>{
  const f=fixture(),prepared=await f.prepare(),body={messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]};
  const first=await f.service.delivery(body,f.recipient);first.submit();first.complete(true);first.release();
  const second=await f.service.delivery(body,f.recipient);second.submit();second.complete(false);second.release();
  const retry=await f.service.delivery(body,f.recipient);assert.throws(()=>retry.submit(),error=>error.code==='privacy.image_delivery_unknown');retry.release();
  await f.service.remove(prepared.id);
});

// Independent source leases model the host's already-open handle and owned
// buffer. Admission tests exercise the real service and image contract rather
// than substituting a fake busy implementation or reusing an accepted source.
function admissionFixture({ blockFirst = false } = {}) {
  const sessionId='sess_admission', scope=sha(sessionId).slice(0,32), config={personal:true,rules:[]};
  let currentScope=sessionId, serial=0, starts=0, unblock;
  const policy={config,hash:sha(JSON.stringify(config)),rulesHash:sha('rules'),revision:'policy1',assert:()=>true};
  const snapshot={hash:sha('admission-processor'),version:'processor1'};
  const processor={capture:()=>snapshot,assert:()=>true,start(request){
    starts++;
    const frame={rgba:Buffer.alloc(12*12*4,255),width:12,height:12,sourceHash:request.sourceHash,processorHash:snapshot.hash,frames:1,
      orientationApplied:true,ocrComplete:true,codesComplete:true,transform:{width:12,height:12,orientation:1},
      words:[{text:'private@example.test',line:0,box:[1,1,5,5]}],codes:[]};
    const promise=blockFirst&&starts===1?new Promise(resolve=>{unblock=()=>resolve(frame);}):Promise.resolve(frame);
    return {promise,finish:()=>({closed:true,helperMayStillRun:false,ownershipRetained:false})};
  }};
  const service=api.MediaImageService.create({context:()=>({scopeId:currentScope}),storeFor:async({authority})=>{
    let stored;
    return {async put(value){const captured=await authority.capture(value.sourceId);authority.assert(captured);stored={...value,bytes:Buffer.from(value.bytes),captured};return{id:'mimg_admission'};},
      async read(){const bytes=Buffer.from(stored.bytes);return {bytes,manifest:stored.manifest,assert(){authority.assert(stored.captured);return true;},release(){bytes.fill(0);}};},
      async remove(){stored?.bytes.fill(0);stored=null;return true;}};
  }});
  function lease(){
    const index=++serial, bytes=Buffer.alloc(32,index);let held=true,releaseCalls=0;
    const source={id:'file_'+index,name:'image_'+index+'.png',snapshot:{bytes,hash:sha(bytes),revision:'source_'+index,scope},
      assert(){assert.equal(held,true,'accepted source lease must remain held');return true;},
      async release(){releaseCalls++;held=false;bytes.fill(0);}};
    return {source,held:()=>held,releases:()=>releaseCalls,bytes};
  }
  const recipient=sha('admission-recipient');
  return {service,lease,starts:()=>starts,unblock:()=>unblock(),setScope:value=>{currentScope=value;},
    prepare:(owned,overrides={})=>service.prepare({sessionId,source:owned.source,policy,processor,recipient,...overrides})};
}
function assertReleased(owned){assert.equal(owned.releases(),1);assert.equal(owned.held(),false);assert.equal(owned.bytes.every(byte=>byte===0),true);}
test('full four-record capacity releases every rejected new source without retiring accepted artifacts',async()=>{
  const f=admissionFixture(),accepted=[];
  try{
    for(let i=0;i<4;i++){const owned=f.lease(),prepared=await f.prepare(owned);accepted.push({owned,prepared});assert.equal(owned.releases(),0);}
    for(let i=0;i<3;i++){const rejected=f.lease();await assert.rejects(f.prepare(rejected),error=>error.code==='privacy.image_busy');assertReleased(rejected);}
    assert.equal(f.starts(),4);
    for(const {owned,prepared} of accepted){assert.equal(owned.held(),true);const preview=await f.service.borrow(prepared.id);preview.assert();preview.release();}
  }finally{for(const {prepared}of accepted)await f.service.remove(prepared.id);}
  for(const {owned}of accepted)assertReleased(owned);
});
test('busy rejection releases its own source and cannot clear another in-flight preparation lock',async()=>{
  const f=admissionFixture({blockFirst:true}),first=f.lease(),pending=f.prepare(first);let prepared;
  try{
    assert.equal(f.starts(),1);assert.equal(first.held(),true);
    for(let i=0;i<2;i++){const rejected=f.lease();await assert.rejects(f.prepare(rejected),error=>error.code==='privacy.image_busy');assertReleased(rejected);assert.equal(f.starts(),1);}
    assert.equal(first.releases(),0);f.unblock();prepared=await pending;
    const preview=await f.service.borrow(prepared.id);preview.assert();preview.release();assert.equal(first.held(),true);
  }finally{if(!prepared){f.unblock();prepared=await pending;}await f.service.remove(prepared.id);}
  assertReleased(first);
});
test('scope mismatch before admission releases its source and leaves the next valid preparation usable',async()=>{
  const f=admissionFixture(),rejected=f.lease();f.setScope('sess_other');
  await assert.rejects(f.prepare(rejected),error=>error.code==='privacy.image_scope_changed');assertReleased(rejected);assert.equal(f.starts(),0);
  f.setScope('sess_admission');const accepted=f.lease(),prepared=await f.prepare(accepted);
  const preview=await f.service.borrow(prepared.id);preview.assert();preview.release();await f.service.remove(prepared.id);assertReleased(accepted);
});
test('host validation before admission releases a supplied source and does not take the preparation lock',async()=>{
  const f=admissionFixture(),rejected=f.lease();
  await assert.rejects(f.prepare(rejected,{recipient:'invalid'}),error=>error.code==='privacy.image_host_required');assertReleased(rejected);assert.equal(f.starts(),0);
  const accepted=f.lease(),prepared=await f.prepare(accepted);await f.service.remove(prepared.id);assertReleased(accepted);
});

const wireSource=['04h-provider-http.js','04i-provider-anthropic.js'].map(name=>fs.readFileSync(path.join(sourceRoot,name),'utf8')).join('\n');
const wireOwners=vm.runInNewContext(wireSource+';({providerRequestHeaders,providerCompletionUrl,providerResponsesBase,anthropicRequestHeaders,anthropicMessagesUrl});',{require,Buffer});
for(const style of ['chat','responses','anthropic'])test(`${style} real wire headers bind custom credentials and tenant to the artifact recipient`,async()=>{
  const f=fixture(),provider={baseUrl:'https://api.example.test',apiKey:'synthetic-account-key',model:'synthetic-model',
    extraHeaders:{'X-Custom-Token':'synthetic-custom-token','X-Tenant':'tenant-one'}};
  const headers=current=>style==='anthropic'?wireOwners.anthropicRequestHeaders(current,{model:current.model}):wireOwners.providerRequestHeaders(current);
  const url=style==='anthropic'?wireOwners.anthropicMessagesUrl(provider.baseUrl):style==='responses'?wireOwners.providerResponsesBase(provider.baseUrl)+'/responses':wireOwners.providerCompletionUrl(provider.baseUrl,false);
  const recipient=api.MediaImageService.recipientHash(url,headers(provider));
  const prepared=await f.service.prepare({sessionId:'sess_one',source:f.source,policy:f.policy,processor:f.processor,recipient});
  const body={messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]};
  try{
    const normal=await f.service.delivery(body,api.MediaImageService.recipientHash(url,headers(provider)));normal.assert();normal.release();
    for(const key of ['X-Custom-Token','X-Tenant']){
      const changed={...provider,extraHeaders:{...provider.extraHeaders,[key]:'different-'+key}};
      await assert.rejects(f.service.delivery(body,api.MediaImageService.recipientHash(url,headers(changed))),error=>error.code==='privacy.image_recipient_changed');
    }
  }finally{await f.service.remove(prepared.id);}
});
test('recipient header canonicalization follows Fetch names, order and whitespace semantics without exposing values',()=>{
  const first={'Content-Type':'application/json','X-Custom-Token':'  custom-token  ','X-Tenant':'tenant-one','Authorization':'Bearer synthetic'};
  const reordered={authorization:'Bearer synthetic','x-tenant':'tenant-one','x-custom-token':'custom-token','content-type':'application/json'};
  const url='https://api.example.test/v1/chat/completions',recipient=api.MediaImageService.recipientHash(url,first);
  assert.equal(recipient,api.MediaImageService.recipientHash(url,reordered));assert.match(recipient,/^[a-f0-9]{64}$/);
  assert.equal(recipient.includes('custom-token'),false);
  const duplicate={'X-Tenant':'one','x-tenant':'two'};
  assert.equal(api.MediaImageService.recipientHash(url,duplicate),api.MediaImageService.recipientHash(url,new Headers(duplicate)));
  assert.notEqual(api.MediaImageService.recipientHash(url,duplicate),api.MediaImageService.recipientHash(url,{'x-tenant':'two','X-Tenant':'one'}));
});
test('invalid header names or values fail at recipient capture using the same Headers parser as fetch',()=>{
  for(const headers of [{'X-Custom-Token':'bad\nvalue'},{'bad header':'value'}])assert.throws(()=>api.MediaImageService.recipientHash('https://api.example.test',headers),error=>error.code==='privacy.image_recipient_invalid');
});
test('custom recipient header changed after the delivery borrow await is rejected at final assertion',async()=>{
  const f=fixture(),url='https://api.example.test/v1/chat/completions',headers=wireOwners.providerRequestHeaders({apiKey:'synthetic',extraHeaders:{'X-Custom-Token':'original','X-Tenant':'tenant-one'}});
  const currentRecipient=()=>api.MediaImageService.recipientHash(url,headers),recipient=currentRecipient();
  const prepared=await f.service.prepare({sessionId:'sess_one',source:f.source,policy:f.policy,processor:f.processor,recipient});
  let batch;
  try{
    batch=await f.service.delivery({messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]},recipient,undefined,currentRecipient);
    headers['X-Tenant']='tenant-two';
    assert.throws(()=>batch.assert(),error=>error.code==='privacy.image_recipient_changed');
    assert.throws(()=>batch.submit(),error=>error.code==='privacy.image_recipient_changed');
  }finally{batch?.release();await f.service.remove(prepared.id);}
});
