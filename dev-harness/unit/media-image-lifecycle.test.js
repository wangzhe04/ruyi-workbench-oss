'use strict';
// In-memory lifecycle tests. Frames are synthetic contract inputs, not evidence
// of native OCR/QR. No sockets, processes, browser or filesystem purge occurs.
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto');
const sourceRoot=p.resolve(__dirname,'../../ruyi-workbench/app/src');
const serviceSource=fs.readFileSync(p.join(sourceRoot,'13bd-media-image-service.js'),'utf8');
const sources=['01i-privacy-rules.js','01h-privacy-core.js','13ba-media-image-contract.js'].map(name=>fs.readFileSync(p.join(sourceRoot,name),'utf8')).join('\n');
const api=vm.runInNewContext(sources+'\n'+serviceSource+';({MediaImageService});',{require,Buffer,Headers,setTimeout,clearTimeout});
const sha=x=>c.createHash('sha256').update(x).digest('hex');
function gate(){let resume,arrive;const entered=new Promise(r=>arrive=r),wait=new Promise(r=>resume=r);return{entered,resume,async stop(){arrive();await wait;}};}
function fixture(block,options={}){
  let contextScope='scope_A',serial=0,starts=0,kills=0,finishes=0;
  const gates=new Map(),stores=[],leases=[],processorSnapshot={hash:sha('processor'),version:'v1'},recipient=sha('recipient');
  function checkpoint(where){if(block===where&&(!options.blockStart||where!=='processor'||starts===options.blockStart)){let g=gates.get(where);if(!g){g=gate();gates.set(where,g);}return g.stop();}return Promise.resolve();}
  const config={personal:true,rules:[]},policy={config,hash:sha(JSON.stringify(config)),rulesHash:sha('rules'),revision:'p1',assert:()=>true};
  const processor={capture:()=>processorSnapshot,assert:()=>true,start(request){starts++;return{promise:checkpoint('processor').then(()=>({rgba:Buffer.alloc(12*12*4,255),width:12,height:12,sourceHash:request.sourceHash,processorHash:processorSnapshot.hash,
    frames:1,orientationApplied:true,ocrComplete:true,codesComplete:true,transform:{width:12,height:12,orientation:1},words:[{text:'person@example.test',line:0,box:[1,1,5,5]}],codes:[]})),
    finish(){finishes++;if(options.unknownClosure) return{closed:false,helperMayStillRun:true,ownershipRetained:true};return{closed:true,helperMayStillRun:false,ownershipRetained:false};},kill(){kills++;throw Error('never kill');}};}};
  const service=api.MediaImageService.create({context:()=>({scopeId:contextScope}),storeFor:async({authority})=>{
    await checkpoint('storeFor');let value,removes=0,disposed=0;
    const store={async put(input){const captured=await authority.capture(input.sourceId);authority.assert(captured);value={...input,bytes:Buffer.from(input.bytes),captured};await checkpoint('put');return{id:'mimg_'+String(stores.length).padStart(32,'0')};},
      async read(){const bytes=Buffer.from(value.bytes);await checkpoint('read');return{bytes,manifest:value.manifest,assert(){authority.assert(value.captured);return true;},release(){bytes.fill(0);}};},
      async remove(){removes++;await checkpoint('remove');if(options.cleanupFails)throw Object.assign(Error('unlink uncertain'),{code:'fixture.cleanup'});value?.bytes.fill(0);value=null;},
      async dispose(){disposed++;if(options.cleanupFails)throw Object.assign(Error('unlink uncertain'),{code:'fixture.cleanup'});value?.bytes.fill(0);value=null;},
      hasValue:()=>!!value,removed:()=>removes,disposed:()=>disposed};stores.push(store);return store;
  }});
  function lease(scope=contextScope){const i=++serial,bytes=Buffer.alloc(32,i);let releases=0;
    const source={id:'file_'+i,name:'image.png',snapshot:{bytes,hash:sha(bytes),revision:'r'+i,scope:sha(scope).slice(0,32)},assert(){a.equal(releases,0);return true;},async release(){releases++;bytes.fill(0);}};
    const result={source,releases:()=>releases};leases.push(result);return result;}
  async function at(where){for(let i=0;i<100&&!gates.has(where);i++)await Promise.resolve();const g=gates.get(where);a.ok(g,'gate reached '+where);await g.entered;return g;}
  return{service,processor,stores,policy,recipient,lease,at,starts:()=>starts,finishes:()=>finishes,kills:()=>kills,setScope:s=>contextScope=s,
    prepare:(owned,scope=contextScope,extra={})=>service.prepare({sessionId:scope,source:owned.source,policy,processor,recipient,...extra})};
}
for(const boundary of ['processor','storeFor','put'])test('scope revoke while awaiting '+boundary+' cannot publish a late artifact',async()=>{
  const f=fixture(boundary),owned=f.lease(),pending=f.prepare(owned);const rejected=a.rejects(pending,error=>/privacy.image_(?:revoked|expired)/.test(error.code||''));
  const g=await f.at(boundary);await f.service.revokeScope('scope_A');a.equal(owned.releases(),0,'pending source remains with its real owner until await settles');
  g.resume();await rejected;a.equal(owned.releases(),1);a.equal(f.kills(),0);a.ok(f.stores.every(store=>!store.hasValue()));
});
test('beginScope captures pre-service host work and cannot be forged or revived by same-id reuse',async()=>{
  const f=fixture(),old=f.service.beginScope('scope_A');old.assert();await f.service.revokeScope('scope_A');a.throws(()=>old.assert(),e=>e.code==='privacy.image_revoked');
  const fresh=f.service.beginScope('scope_A');fresh.assert();const owned=f.lease();await a.rejects(f.prepare(owned,'scope_A',{scopeOwner:old}),e=>e.code==='privacy.image_revoked');a.equal(owned.releases(),1);fresh.assert();
  const forged=f.lease();await a.rejects(f.prepare(forged,'scope_A',{scopeOwner:{assert:()=>true,release:()=>{throw Error('forged cleanup');}}}),e=>e.code==='privacy.image_scope_changed');a.equal(forged.releases(),1);
  const accepted=f.lease(),prepared=await f.prepare(accepted,'scope_A',{scopeOwner:fresh});await f.service.remove(prepared.id);a.throws(()=>fresh.assert(),e=>e.code==='privacy.image_revoked');
});
test('revocation of another scope leaves a pending prepare and its epoch untouched',async()=>{
  const f=fixture('processor'),owned=f.lease(),pending=f.prepare(owned),g=await f.at('processor');
  await f.service.revokeScope('scope_B');g.resume();const prepared=await pending;const preview=await f.service.borrow(prepared.id);preview.assert();preview.release();await f.service.remove(prepared.id);a.equal(owned.releases(),1);
});
test('revoke marks all matching records dead synchronously before the first unlink await',async()=>{
  const f=fixture('remove'),items=[];
  for(let i=0;i<2;i++){const owned=f.lease(),prepared=await f.prepare(owned);items.push({owned,prepared});}
  const refs=items.map(({owned,prepared})=>({id:owned.source.id,name:owned.source.name,protectedImage:{reference:prepared.reference}}));
  const revoked=f.service.revokeScope('scope_A');const g=await f.at('remove');
  try{for(const ref of refs)a.throws(()=>f.service.referenceFor(ref));}finally{g.resume();await revoked;}
  for(const {owned}of items)a.equal(owned.releases(),1);
});
test('revoked store-read and its late copied pixels never escape as an owned preview',async()=>{
  const f=fixture('read'),owned=f.lease(),prepared=await f.prepare(owned),pending=f.service.borrow(prepared.id);const rejected=a.rejects(pending);
  const g=await f.at('read');await f.service.revokeScope('scope_A');g.resume();await rejected;a.equal(owned.releases(),1);
});
test('cleanup error retains refusal and does not resurrect other records or release source twice',async()=>{
  const f=fixture('put',{cleanupFails:true}),owned=f.lease(),pending=f.prepare(owned),rejected=a.rejects(pending,e=>e.code==='privacy.image_cleanup_failed'&&e.ownershipRetained===true);
  const g=await f.at('put');await f.service.revokeScope('scope_A');g.resume();await rejected;a.equal(owned.releases(),1);a.equal(f.kills(),0);
});
test('unknown helper closure remains unknown after revocation without killing it',async()=>{
  const f=fixture('processor',{unknownClosure:true}),owned=f.lease(),pending=f.prepare(owned),rejected=a.rejects(pending,e=>e.helperMayStillRun===true&&e.ownershipRetained===true);
  const g=await f.at('processor');await f.service.revokeScope('scope_A');g.resume();await rejected;a.equal(f.kills(),0);a.equal(f.finishes(),1);a.equal(owned.releases(),1);
});
test('global policy invalidation includes pending epochs without granting their late results',async()=>{
  const f=fixture('processor'),owned=f.lease(),pending=f.prepare(owned),rejected=a.rejects(pending);
  const g=await f.at('processor');await f.service.invalidate();g.resume();await rejected;a.equal(owned.releases(),1);
});
test('pending host epochs use the four-owner budget and release only their own admission',async()=>{
  const f=fixture(),owners=Array.from({length:4},(_,i)=>f.service.beginScope('pending_'+i));
  a.throws(()=>f.service.beginScope('pending_overflow'),e=>e.code==='privacy.image_busy');
  await f.service.revokeScope('pending_0');a.throws(()=>f.service.beginScope('still_overflow'),e=>e.code==='privacy.image_busy');
  owners[0].release();owners[0].release();const next=f.service.beginScope('pending_next');next.assert();
  for(const owner of owners.slice(1))owner.assert();next.release();for(const owner of owners)owner.release();
  const owned=f.lease(),prepared=await f.prepare(owned);await f.service.remove(prepared.id);a.equal(owned.releases(),1);
});
test('reusing a transferred scope lease cannot release the original pending owner',async()=>{
  const f=fixture('processor'),owner=f.service.beginScope('scope_A'),first=f.lease(),pending=f.prepare(first,'scope_A',{scopeOwner:owner});const g=await f.at('processor');
  const second=f.lease();await a.rejects(f.prepare(second,'scope_A',{scopeOwner:owner}),e=>e.code==='privacy.image_scope_owner_transferred');a.equal(second.releases(),1);a.equal(first.releases(),0);owner.assert();
  g.resume();const result=await pending;const preview=await f.service.borrow(result.id);preview.assert();preview.release();await f.service.remove(result.id);a.equal(first.releases(),1);
});
test('an existing other-session artifact remains valid while the revoked prepare settles',async()=>{
  const f=fixture('processor',{blockStart:2});f.setScope('scope_B');const b=f.lease(),preparedB=await f.prepare(b);
  f.setScope('scope_A');const owned=f.lease(),pending=f.prepare(owned),rejected=a.rejects(pending);const g=await f.at('processor');await f.service.revokeScope('scope_A');
  f.setScope('scope_B');const preview=await f.service.borrow(preparedB.id);preview.assert();preview.release();g.resume();await rejected;
  const again=await f.service.borrow(preparedB.id);again.assert();again.release();await f.service.remove(preparedB.id);a.equal(b.releases(),1);a.equal(owned.releases(),1);
});
test('revocation after delivery await zeros captured pixels and refuses final assertion and submit',async()=>{
  const f=fixture(),owned=f.lease(),prepared=await f.prepare(owned);
  const batch=await f.service.delivery({messages:[{role:'user',content:[{type:'image_url',image_url:{url:prepared.reference}}]}]},f.recipient);
  await f.service.revokeScope('scope_A');a.throws(()=>batch.assert());a.throws(()=>batch.submit());batch.release();a.equal(owned.releases(),1);
});
