'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises');
const p=require('node:path'),os=require('node:os'),vm=require('node:vm'),c=require('node:crypto'),{spawn}=require('node:child_process');
const SOURCE=process.env.CLAIM_CANDIDATE||p.join(__dirname,'../../ruyi-workbench/app/src/13av-work-data-handoff-claim.js');
const api=vm.runInNewContext(fs.readFileSync(SOURCE,'utf8')+'\nWorkDataHandoffClaim;',{require,Buffer,process});
const fold=value=>process.platform==='win32'?value.toLowerCase():value;
const digest=value=>c.createHash('sha256').update(Buffer.from(fold(value),'utf8')).digest('hex');
const claimDir=(temp,base)=>p.join(temp,'ruyi-work-data-handoff-'+digest(base));
const clone=value=>JSON.parse(JSON.stringify(value));
const omit=(value,key)=>{const copy={...value};delete copy[key];return copy;};
const errCode=code=>error=>error?.code===code;
const resultFor=(record,overrides={})=>({id:record.id,operation:record.operation,...overrides});
const dead=()=>{throw Object.assign(new Error('no such process'),{code:'ESRCH'});};
const alive=()=>true;
const unknown=()=>{throw Object.assign(new Error('access denied'),{code:'EACCES'});};
async function fixture(t,{probe}={}){
 const root=await io.mkdtemp(p.join(os.tmpdir(),'ruyi-claim-unit-')),temp=p.join(root,'temp'),base=p.join(root,'base');
 await io.mkdir(temp);await io.mkdir(base);
 t.after(async()=>{assert.equal(p.dirname(root),p.resolve(os.tmpdir()));assert.ok(p.basename(root).startsWith('ruyi-claim-unit-'));await io.rm(root,{recursive:true,force:true});});
 const stat=await io.lstat(base,{bigint:true}),baseIdentity={dev:String(stat.dev),ino:String(stat.ino)};
 const facts={calls:0,failAt:-1,flushes:[]};
 const flush=async paths=>{facts.calls++;facts.flushes.push([...paths]);if(facts.calls-1===facts.failAt)throw Object.freeze(new Error('simulated flush refusal'));};
 const host={temp,flush,...(probe?{probe}:{})};
 const value=overrides=>({schema:1,base,baseIdentity:{...baseIdentity},id:'a'.repeat(48),nonce:'b'.repeat(64),
  parentPid:process.pid,childPid:999999,operation:'enable',serve:{host:'127.0.0.1',port:32123},phase:'armed',
  createdAt:'2026-10-27T00:00:00.000Z',updatedAt:'2026-10-27T00:00:00.000Z',...overrides});
 const advance=(record,phase)=>({...clone(record),phase,updatedAt:new Date(Date.parse(record.updatedAt)+1000).toISOString()});
 const dir=claimDir(temp,base);
 return {root,temp,base,baseIdentity,facts,host,owner:api.create(host),value,advance,dir,file:p.join(dir,api.NAME)};
}
const activationPath=(temp,target)=>p.join(temp,'ruyi-work-data-activation-'+digest(target));
async function activationFixture(t){
 const f=await fixture(t),target=p.join(f.root,'target');await io.mkdir(target);
 const stat=await io.lstat(target,{bigint:true}),identity={dev:String(stat.dev),ino:String(stat.ino)};
 const authority={generation:0,id:null,mode:'plain',sha256:null};
 const activation=overrides=>({schema:1,activation:'separate-fresh-root',operation:'restore',base:target,
  baseIdentity:{...identity},authority:{...authority},id:'d'.repeat(48),nonce:'e'.repeat(64),
  parentPid:process.pid,resultSha256:'f'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',...overrides});
 const activationDir=activationPath(f.temp,target);
 return {...f,target,identity,authority,activation,activationDir,activationFile:p.join(activationDir,api.ACTIVATION_NAME)};
}
test('create requires a canonical absolute temp root and a flush seam',async t=>{
 const f=await fixture(t);
 assert.throws(()=>api.create({temp:'relative',flush:async()=>{}}),errCode('work_data_claim.host_invalid'));
 assert.throws(()=>api.create({temp:f.temp}),errCode('work_data_claim.host_invalid'));
 assert.throws(()=>api.create({temp:p.parse(f.temp).root,flush:async()=>{}}),errCode('work_data_claim.host_invalid'));
 assert.throws(()=>api.create({temp:f.temp,flush:async()=>{},probe:'not a function'}),errCode('work_data_claim.host_invalid'));
 for(const key of ['inspect','write','remove','classify'])assert.equal(typeof f.owner[key],'function');
});
test('inspection creates nothing and the first write requires an absent claim',async t=>{
 const f=await fixture(t);
 assert.equal((await f.owner.inspect({base:f.base})).present,false);
 assert.deepEqual(await io.readdir(f.temp),[]);
 const receipt=await f.owner.write(f.value());
 assert.equal(f.facts.calls,2);
 assert.deepEqual(f.facts.flushes[0],[f.dir,f.temp]);
 assert.deepEqual(await io.readdir(f.dir),[api.NAME]);
 const found=await f.owner.inspect({base:f.base});
 assert.equal(found.present,true);assert.equal(found.value.phase,'armed');
 assert.equal(found.receipt.sha256,receipt.sha256);assert.equal(Object.isFrozen(found.value),true);
 assert.equal(Object.isFrozen(found.value.serve),true);assert.equal(Object.isFrozen(found.receipt),true);
 const fresh=api.create(f.host),seen=await fresh.inspect({base:f.base});
 assert.equal(seen.receipt.sha256,receipt.sha256);assert.equal(seen.receipt.ino,receipt.ino);
 await assert.rejects(fresh.write(f.value()),errCode('work_data_claim.claim_exists'));
 await assert.rejects(f.owner.write(f.value()),errCode('work_data_claim.claim_exists'));
 await assert.rejects(api.create(f.host).write(f.value()),errCode('work_data_claim.claim_exists'));
 assert.deepEqual(await io.readFile(f.file),Buffer.from(JSON.stringify(f.value())));
 assert.deepEqual(await io.readdir(f.base),[]);
 assert.equal(p.dirname(f.dir),f.temp);
 assert.equal(p.basename(f.dir),'ruyi-work-data-handoff-'+digest(f.base));
 await assert.rejects(f.owner.inspect({base:f.base,extra:1}),errCode('work_data_claim.observation_invalid'));
});
test('records are strict fixed-shape UTF-8 JSON bounded to 16KiB',async t=>{
 const f=await fixture(t),value=f.value();
 const decoded=api.decode(Buffer.from(JSON.stringify(value)));
 assert.equal(Object.isFrozen(decoded),true);assert.equal(Object.isFrozen(decoded.baseIdentity),true);
 assert.equal(api.LIMIT,16384);
 assert.throws(()=>api.decode(Buffer.alloc(api.LIMIT+1,0x20)),errCode('work_data_claim.claim_invalid'));
 assert.throws(()=>api.decode(Buffer.from([0x7b,0xff,0x7d])),errCode('work_data_claim.claim_invalid'));
 const wrong=[
  {...value,extra:1},omit(value,'serve'),{...value,schema:2},{...value,id:'A'.repeat(48)},
  {...value,nonce:'b'.repeat(63)},{...value,parentPid:0},{...value,parentPid:process.pid,childPid:process.pid},
  {...value,phase:'prepared'},{...value,serve:{host:'0.0.0.0',port:32123}},
  {...value,serve:{host:'127.0.0.1',port:0}},{...value,createdAt:'2026-10-27T00:00:00Z'},
  {...value,updatedAt:'2026-10-26T23:59:59.000Z'},{...value,base:'relative'},
  {...value,baseIdentity:{dev:'x',ino:'1'}},
 ];
 for(const bad of wrong)assert.equal(api.validate(bad),false,JSON.stringify(bad));
 await assert.rejects(f.owner.write({...value,extra:1}),errCode('work_data_claim.claim_invalid'));
 await assert.rejects(f.owner.write({...value,phase:'owned'}),errCode('work_data_claim.phase_invalid'));
 assert.equal(fs.existsSync(f.file),false);assert.deepEqual(await io.readdir(f.temp),[]);
});
test('malformed oversized or secret-bearing claim bytes are refused and never repaired',async t=>{
 const f=await fixture(t);await io.mkdir(f.dir);
 for(const bytes of [Buffer.from([0xff]),Buffer.alloc(api.LIMIT+1,0x20),Buffer.from('{}'),Buffer.from(JSON.stringify({...f.value(),password:'PRIVATE'}))]){
  await io.writeFile(f.file,bytes);
  await assert.rejects(f.owner.inspect({base:f.base}),errCode('work_data_claim.claim_invalid'));
  assert.deepEqual(await io.readFile(f.file),bytes);
 }
});
test('the first claim is armed and every later write is exact sha/dev/ino CAS with one-step phase advance',async t=>{
 const f=await fixture(t),armed=f.value();
 for(const bad of [f.value({phase:'committed'}),f.value({phase:'owned'}),
  f.value({updatedAt:new Date(Date.parse(armed.createdAt)+1000).toISOString()})])
  await assert.rejects(f.owner.write(bad),errCode('work_data_claim.phase_invalid'));
 assert.equal(fs.existsSync(f.file),false);
 const r1=await f.owner.write(armed),committed=f.advance(armed,'committed'),owned=f.advance(committed,'owned');
 await assert.rejects(f.owner.write(owned,r1),errCode('work_data_claim.phase_invalid'));
 for(const changed of [
  {...committed,id:'c'.repeat(48)},{...committed,nonce:'d'.repeat(64)},{...committed,parentPid:12345},
  {...committed,childPid:23456},{...committed,operation:'disable'},{...committed,serve:{host:'127.0.0.1',port:32124}},
  {...committed,baseIdentity:{...committed.baseIdentity,dev:String(BigInt(committed.baseIdentity.dev)+1n)}},
  {...committed,createdAt:'2026-10-26T23:00:00.000Z'},
 ])await assert.rejects(f.owner.write(changed,r1),errCode('work_data_claim.binding_changed'));
 for(const bad of [{...r1,sha256:'0'.repeat(64)},{...r1,ino:String(BigInt(r1.ino)+1n)}])
  await assert.rejects(f.owner.write(committed,bad),errCode('work_data_claim.claim_changed'));
 for(const bad of [{...r1,name:'other.json'},{...r1,extra:1}])
  await assert.rejects(f.owner.write(committed,bad),errCode('work_data_claim.receipt_invalid'));
 const r2=await api.create(f.host).write({...committed,baseIdentity:{ino:committed.baseIdentity.ino,dev:committed.baseIdentity.dev},
  serve:{port:committed.serve.port,host:committed.serve.host}},{...r1});
 await assert.rejects(f.owner.write(committed,r1),errCode('work_data_claim.claim_changed'));
 await assert.rejects(f.owner.write(committed,r2),errCode('work_data_claim.phase_invalid'));
 const r3=await f.owner.write(owned,r2);
 await assert.rejects(f.owner.write(committed,r3),errCode('work_data_claim.phase_invalid'));
 await assert.rejects(f.owner.write(owned,r2),errCode('work_data_claim.claim_changed'));
 const found=await f.owner.inspect({base:f.base});
 assert.equal(found.value.phase,'owned');assert.equal(found.receipt.sha256,r3.sha256);
});
test('a failed directory flush retains one stage and blocks every later write',async t=>{
 const f=await fixture(t);f.facts.failAt=0;
 await assert.rejects(f.owner.write(f.value()),error=>error.code==='work_data_claim.write_failed'
  &&error.retry===false&&error.cause instanceof Error);
 assert.equal(fs.existsSync(f.file),false);
 const names=await io.readdir(f.dir);
 assert.equal(names.length,1);assert.ok(names[0].startsWith(api.STAGE));
 await assert.rejects(f.owner.inspect({base:f.base}),errCode('work_data_claim.stage_pending'));
 await assert.rejects(f.owner.write(f.value()),errCode('work_data_claim.stage_pending'));
 assert.equal((await io.readdir(f.dir)).length,1);
});
test('a failure after rename retains a valid selected claim but issues no receipt',async t=>{
 const f=await fixture(t);f.facts.failAt=1;
 await assert.rejects(f.owner.write(f.value()),errCode('work_data_claim.write_failed'));
 assert.equal(f.facts.calls,2);assert.equal(fs.existsSync(f.file),true);
 const found=await f.owner.inspect({base:f.base});
 assert.equal(found.present,true);assert.equal(found.value.phase,'armed');
 assert.deepEqual(await io.readdir(f.dir),[api.NAME]);
});
test('readback hash rejects a host callback that rewrites the selected claim after rename',async t=>{
 const f=await fixture(t);let calls=0;
 const host={...f.host,flush:async()=>{if(++calls===2)await io.writeFile(f.file,Buffer.concat([await io.readFile(f.file),Buffer.from(' ')]));}};
 const owner=api.create(host);
 await assert.rejects(owner.write(f.value()),errCode('work_data_claim.claim_changed'));
 await assert.rejects(owner.write(f.value()),errCode('work_data_claim.claim_exists'));
 assert.equal((await io.readFile(f.file)).at(-1),0x20);
 assert.deepEqual(await io.readdir(f.dir),[api.NAME]);
});
test('remove is exact-receipt CAS, idempotent only after its own deletion, and never deletes a foreign identity',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value());
 await assert.rejects(f.owner.remove({...receipt,sha256:'0'.repeat(64)}),errCode('work_data_claim.claim_changed'));
 await assert.rejects(f.owner.remove({...receipt,ino:String(BigInt(receipt.ino)+1n)}),errCode('work_data_claim.claim_changed'));
 await assert.rejects(f.owner.remove({...receipt,extra:1}),errCode('work_data_claim.receipt_invalid'));
 assert.equal(fs.existsSync(f.file),true);
 await io.writeFile(p.join(f.dir,api.STAGE+'orphan'),'KEEP ORPHAN');
 await assert.rejects(f.owner.remove(receipt),errCode('work_data_claim.stage_pending'));
 assert.equal(fs.existsSync(f.file),true);
 await io.unlink(p.join(f.dir,api.STAGE+'orphan'));
 assert.equal(await api.create(f.host).remove(receipt),true);
 assert.equal(fs.existsSync(f.file),false);assert.deepEqual(await io.readdir(f.dir),[]);
 assert.equal(await f.owner.remove(receipt),true);
 assert.equal(await f.owner.remove({...receipt,base:p.join(f.root,'elsewhere')}),true);
 assert.equal(fs.existsSync(f.file),false);
});
test('a flush failure after unlink never resurrects the claim and the same receipt is idempotent',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value());
 f.facts.failAt=2;
 await assert.rejects(f.owner.remove(receipt),errCode('work_data_claim.remove_failed'));
 assert.equal(fs.existsSync(f.file),false);
 assert.equal(await f.owner.remove(receipt),true);
 assert.deepEqual(await io.readdir(f.dir),[]);
});
test('hardlinked claim bytes cannot be inspected updated or removed',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value());
 await io.link(f.file,p.join(f.root,'alias.json'));
 assert.equal((await io.stat(f.file)).nlink,2);
 await assert.rejects(f.owner.inspect({base:f.base}),errCode('work_data_claim.claim_invalid'));
 await assert.rejects(f.owner.write(f.advance(f.value(),'committed'),receipt),errCode('work_data_claim.claim_invalid'));
 await assert.rejects(f.owner.remove(receipt),errCode('work_data_claim.claim_invalid'));
 assert.equal(fs.existsSync(f.file),true);
});
test('a replacement with new native identity invalidates the old receipt',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value()),bytes=await io.readFile(f.file);
 await io.rename(f.file,f.file+'.old');
 await io.writeFile(f.file,Buffer.concat([bytes,Buffer.from('\n')]));
 await assert.rejects(f.owner.write(f.advance(f.value(),'committed'),receipt),errCode('work_data_claim.claim_changed'));
 await assert.rejects(f.owner.remove(receipt),errCode('work_data_claim.claim_changed'));
 assert.equal(fs.existsSync(f.file),true);
});
test('a first write with a wrong baseIdentity is refused before creating the claim namespace',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.owner.write(f.value({baseIdentity:{...f.baseIdentity,
  dev:String(BigInt(f.baseIdentity.dev)+1n)}})),errCode('work_data_claim.base_changed'));
 assert.deepEqual(await io.readdir(f.temp),[]);
});
test('a replaced base directory is detected by its recorded native identity',async t=>{
 const f=await fixture(t);await f.owner.write(f.value());
 await io.rename(f.base,f.base+'.old');await io.mkdir(f.base);
 await assert.rejects(f.owner.inspect({base:f.base}),errCode('work_data_claim.base_changed'));
});
test('remove refuses to delete a claim whose recorded base was replaced',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value()),before=await io.readFile(f.file);
 await io.rename(f.base,f.base+'.old');await io.mkdir(f.base);
 await assert.rejects(f.owner.remove(receipt),errCode('work_data_claim.base_changed'));
 assert.deepEqual(await io.readFile(f.file),before);
});
test('base replacement during the durable stage blocks rename and retains one stage',async t=>{
 const f=await fixture(t);let calls=0;
 const host={...f.host,flush:async paths=>{f.facts.calls++;f.facts.flushes.push([...paths]);
  if(++calls===1){await io.rename(f.base,f.base+'.old');await io.mkdir(f.base);}}};
 const owner=api.create(host);
 await assert.rejects(owner.write(f.value()),errCode('work_data_claim.base_changed'));
 assert.equal(fs.existsSync(f.file),false);
 const names=await io.readdir(f.dir);
 assert.equal(names.length,1);assert.ok(names[0].startsWith(api.STAGE));
});
test('aliased temp or claim directories are refused without touching the target',async t=>{
 const f=await fixture(t),target=p.join(f.root,'target');
 await io.mkdir(target);await io.mkdir(p.join(target,'nested'));
 const tempLink=p.join(f.root,'temp-link');
 await io.symlink(target,tempLink,'junction');
 const linked=api.create({temp:tempLink,flush:async()=>{}});
 await assert.rejects(linked.inspect({base:f.base}),errCode('work_data_claim.path_alias'));
 const expected=claimDir(f.temp,f.base);
 await io.symlink(target,expected,'junction');
 await assert.rejects(f.owner.inspect({base:f.base}),errCode('work_data_claim.path_alias'));
 assert.deepEqual(await io.readdir(target),['nested']);
 await assert.rejects(api.create({temp:p.join(f.root,'missing'),flush:async()=>{}}).inspect({base:f.base}),
  errCode('work_data_claim.temp_invalid'));
});
test('a base that would contain or sit inside the claim namespace is refused',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.owner.write(f.value({base:f.temp})),errCode('work_data_claim.base_invalid'));
 await assert.rejects(f.owner.write(f.value({base:f.root})),errCode('work_data_claim.base_invalid'));
 await assert.rejects(f.owner.write(f.value({base:'relative'})),errCode('work_data_claim.claim_invalid'));
 await assert.rejects(f.owner.inspect({base:'relative'}),errCode('work_data_claim.base_invalid'));
 assert.deepEqual(await io.readdir(f.temp),[]);
});
test('a case-variant base string is refused instead of silently rebinding the claim',async t=>{
 if(process.platform!=='win32')return t.skip('case-insensitive paths are Windows-only');
 const f=await fixture(t),receipt=await f.owner.write(f.value()),upper=f.base.toUpperCase();
 assert.notEqual(upper,f.base);
 await assert.rejects(f.owner.inspect({base:upper}),errCode('work_data_claim.base_changed'));
 await assert.rejects(f.owner.write(f.advance(f.value({base:upper}),'committed'),receipt),errCode('work_data_claim.base_changed'));
 assert.equal((await f.owner.inspect({base:f.base})).value.phase,'armed');
});
test('a non-ASCII canonical base is bound byte-for-byte and isolated from other bases',async t=>{
 const f=await fixture(t),base=p.join(f.root,'基础-数据');
 await io.mkdir(base);
 const stat=await io.lstat(base,{bigint:true});
 const value=f.value({base,baseIdentity:{dev:String(stat.dev),ino:String(stat.ino)}});
 const receipt=await f.owner.write(value);
 assert.notEqual(claimDir(f.temp,base),claimDir(f.temp,f.base));
 const found=await f.owner.inspect({base});
 assert.equal(found.value.base,base);assert.equal(found.receipt.sha256,receipt.sha256);
 assert.deepEqual((await io.readdir(f.temp)).sort(),[p.basename(claimDir(f.temp,base))]);
});
test('caller or flush mutations cannot change the committed record or authorize success',async t=>{
 const f=await fixture(t),value=f.value(),original=clone(value);
 const host={...f.host,flush:async()=>{value.id='f'.repeat(48);value.phase='owned';value.baseIdentity.dev='0';}};
 const owner=api.create(host),receipt=await owner.write(value);
 const expected=c.createHash('sha256').update(Buffer.from(JSON.stringify(original))).digest('hex');
 assert.equal(receipt.sha256,expected);
 const found=await owner.inspect({base:f.base});
 assert.equal(found.value.id,original.id);assert.equal(found.value.phase,'armed');
 assert.equal(found.value.baseIdentity.dev,original.baseIdentity.dev);
 await assert.rejects(owner.write(original),errCode('work_data_claim.claim_exists'));
});
test('classification only completes an owned claim with a matching result record',async t=>{
 const f=await fixture(t,{probe:dead}),armed=f.value(),r1=await f.owner.write(armed);
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:false}),'inert');
 assert.equal(await f.owner.classify({base:f.base,hasIntent:false,hasResult:false}),'inert');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(armed)}),'inert');
 assert.equal(await f.owner.classify({base:f.base,hasIntent:true,hasResult:false}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:true,result:resultFor(armed)}),'pending');
 const committed=f.advance(armed,'committed'),r2=await f.owner.write(committed,r1);
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:false}),'inert');
 assert.equal(await api.create({...f.host,probe:alive}).classify({base:f.base,intent:false,result:false}),'pending');
 assert.equal(await api.create({...f.host,probe:unknown}).classify({base:f.base,intent:false,result:false}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(committed)}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(committed,{id:'c'.repeat(48)})}),'inert');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(committed,{operation:'disable'})}),'inert');
 assert.equal(await api.create({...f.host,probe:alive}).classify({base:f.base,intent:false,result:resultFor(committed,{id:'c'.repeat(48)})}),'pending');
 assert.equal(await api.create({...f.host,probe:alive}).classify({base:f.base,intent:false,result:resultFor(committed)}),'pending');
 const owned=f.advance(committed,'owned'),r3=await f.owner.write(owned,r2);
 assert.equal(r3.sha256,(await f.owner.inspect({base:f.base})).receipt.sha256);
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:false}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:null}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:undefined}),'pending');
 assert.equal(await api.create({...f.host,probe:alive}).classify({base:f.base,intent:false,result:false}),'pending');
 assert.equal(await api.create({...f.host,probe:unknown}).classify({base:f.base,intent:false,result:false}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(owned)}),'complete');
 assert.equal(await api.create({...f.host,probe:alive}).classify({base:f.base,intent:false,result:resultFor(owned)}),'complete');
 assert.equal(await api.create({...f.host,probe:unknown}).classify({base:f.base,intent:false,result:resultFor(owned)}),'complete');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:{...resultFor(owned),schema:1,state:'published'}}),'complete');
 assert.equal(await f.owner.classify({base:f.base,hasIntent:false,hasResult:resultFor(owned)}),'complete');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(owned,{id:'c'.repeat(48)})}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(owned,{operation:'disable'})}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:true,result:resultFor(owned)}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:true,result:false}),'pending');
 assert.equal(await f.owner.classify({base:p.join(f.root,'absent-base'),intent:false,result:false}),'absent');
 await assert.rejects(f.owner.classify({base:f.base,intent:1,result:false}),errCode('work_data_claim.observation_invalid'));
 await assert.rejects(f.owner.classify({base:f.base,intent:false,result:false,phase:'owned'}),errCode('work_data_claim.observation_invalid'));
 for(const bad of [true,1,'result',[],{},[resultFor(owned)],{id:owned.id},{operation:owned.operation}])
  await assert.rejects(f.owner.classify({base:f.base,intent:false,result:bad}),errCode('work_data_claim.observation_invalid'));
 await assert.rejects(f.owner.classify({base:f.base,hasIntent:false,hasResult:true}),errCode('work_data_claim.observation_invalid'));
 assert.equal((await f.owner.inspect({base:f.base})).receipt.sha256,r3.sha256);
});

async function completedClaim(t, options = {}) {
 const f=await fixture(t,{probe:dead,...options}),armed=f.value();
 const committed=f.advance(armed,'committed'),owned=f.advance(committed,'owned');
 let receipt=await f.owner.write(armed);receipt=await f.owner.write(committed,receipt);receipt=await f.owner.write(owned,receipt);
 return {...f,owned,receipt};
}
test('completed recovery proves both original processes dead, verifies twice and retires only its exact receipt',async t=>{
 const f=await completedClaim(t),seen=[];const flushes=f.facts.calls;
 assert.equal(await f.owner.recoverCompleted(f.receipt,async value=>{seen.push(value);assert.equal(value.id,f.owned.id);assert.equal(Object.isFrozen(value),true);return true;}),true);
 assert.equal(seen.length,2);assert.equal(seen[0],seen[1]);assert.equal(f.facts.calls,flushes+1);
 assert.equal((await f.owner.inspect({base:f.base})).present,false);
 await assert.rejects(f.owner.recoverCompleted(f.receipt,async()=>true),errCode('work_data_claim.claim_changed'));
 assert.deepEqual(await io.readdir(f.base),[],'recovery retires only TEMP metadata');
});
test('matching classification never lets a live unknown or false-returning process probe authorize recovery',async t=>{
 for(const state of ['parent-alive','child-alive','parent-unknown','child-unknown','false']){
  const f=await completedClaim(t),before=await io.readFile(f.file);let calls=0;
  const probe=pid=>{if(state==='false')return false;const role=pid===f.owned.parentPid?'parent':'child';if(state===role+'-alive')return true;if(state===role+'-unknown')return unknown();return dead();};
  const recovery=api.create({...f.host,probe});
  assert.equal(await recovery.classify({base:f.base,intent:false,result:resultFor(f.owned)}),'complete');
  await assert.rejects(recovery.recoverCompleted(f.receipt,async()=>{calls++;return true;}),errCode('work_data_claim.recovery_process_pending'));
  assert.equal(calls,0);assert.deepEqual(await io.readFile(f.file),before);
 }
});
test('recovery refuses unowned phases and absent invalid callbacks without deleting metadata',async t=>{
 const f=await fixture(t,{probe:dead}),armed=f.value(),r1=await f.owner.write(armed);let calls=0;
 const verify=async()=>{calls++;return true;};
 await assert.rejects(f.owner.recoverCompleted(r1,verify),errCode('work_data_claim.recovery_phase_invalid'));
 const r2=await f.owner.write(f.advance(armed,'committed'),r1);
 await assert.rejects(f.owner.recoverCompleted(r2,verify),errCode('work_data_claim.recovery_phase_invalid'));
 for(const value of [undefined,null,true,{}])await assert.rejects(f.owner.recoverCompleted(r2,value),errCode('work_data_claim.recovery_unverified'));
 assert.equal(calls,0);assert.equal((await f.owner.inspect({base:f.base})).value.phase,'committed');
});
test('recovery verification must return exact true twice and preserves the original thrown evidence',async t=>{
 for(const mode of ['false','truthy','second-false','throw']){
  const f=await completedClaim(t),before=await io.readFile(f.file),cause=Object.freeze(Error('synthetic verification failure'));let calls=0;
  await assert.rejects(f.owner.recoverCompleted(f.receipt,async()=>{calls++;if(mode==='throw')throw cause;if(mode==='truthy')return {};return mode==='second-false'?calls===1:false;}),error=>error.code==='work_data_claim.recovery_unverified'&&(mode!=='throw'||error.cause===cause));
  assert.equal(calls,mode==='second-false'?2:1);assert.deepEqual(await io.readFile(f.file),before);
 }
});
test('recovery rechecks process liveness after verification and never promotes a PID reused during IO',async t=>{
 const f=await completedClaim(t);let reused=false,calls=0;
 const owner=api.create({...f.host,probe:pid=>{if(reused&&pid===f.owned.childPid)return true;return dead();}}),before=await io.readFile(f.file);
 await assert.rejects(owner.recoverCompleted(f.receipt,async()=>{calls++;reused=true;return true;}),errCode('work_data_claim.recovery_process_pending'));
 assert.equal(calls,1);assert.deepEqual(await io.readFile(f.file),before);
});
test('recovery detects claim replacement during either verification callback',async t=>{
 for(const at of [1,2]){
  const f=await completedClaim(t);let calls=0;const foreign=Buffer.from(JSON.stringify({...f.owned,nonce:'e'.repeat(64)}));
  await assert.rejects(f.owner.recoverCompleted(f.receipt,async()=>{if(++calls===at){await io.rename(f.file,f.file+'.retained');await io.writeFile(f.file,foreign);}return true;}),errCode('work_data_claim.claim_changed'));
  assert.equal(calls,at);assert.deepEqual(await io.readFile(f.file),foreign);assert.equal(fs.existsSync(f.file+'.retained'),true);
 }
});
test('recovery holds the claim mutation gate across awaited verification and refuses a new stage',async t=>{
 const f=await completedClaim(t),before=await io.readFile(f.file);let calls=0;
 await assert.rejects(f.owner.recoverCompleted(f.receipt,async()=>{
  calls++;await assert.rejects(f.owner.remove(f.receipt),errCode('work_data_claim.busy'));
  await assert.rejects(f.owner.recoverCompleted(f.receipt,async()=>true),errCode('work_data_claim.busy'));
  await io.writeFile(p.join(f.dir,api.STAGE+'foreign'),'PRESERVE');return true;
 }),errCode('work_data_claim.stage_pending'));
 assert.equal(calls,1);assert.deepEqual(await io.readFile(f.file),before);
 assert.equal(await io.readFile(p.join(f.dir,api.STAGE+'foreign'),'utf8'),'PRESERVE');
});
test('restore uses the same strict schema, one-step CAS and result classification',async t=>{
 const f=await fixture(t),armed=f.value({operation:'restore'});
 assert.equal(api.validate(armed),true);assert.equal(api.validate({...armed,phase:'prepared'}),false);
 const r1=await f.owner.write(armed);
 assert.equal((await f.owner.inspect({base:f.base})).value.operation,'restore');
 const committed=f.advance(armed,'committed'),r2=await f.owner.write(committed,r1);
 const owned=f.advance(committed,'owned'),r3=await f.owner.write(owned,r2);
 const current=await f.owner.inspect({base:f.base});
 assert.equal(current.value.phase,'owned');assert.equal(current.value.operation,'restore');assert.equal(current.receipt.sha256,r3.sha256);
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(owned)}),'complete');
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:resultFor(owned,{operation:'export'})}),'pending');
 assert.equal(await f.owner.classify({base:f.base,intent:true,result:resultFor(owned)}),'pending','restore does not borrow an intent phase');
});
test('activation receipt is create-only metadata bound to the canonical target and its authority',async t=>{
 const f=await activationFixture(t),record=f.activation();
 assert.equal(api.ACTIVATION_NAME,'activation-v1.json');assert.equal(api.ACTIVATION_STAGE,'.activation-v1.stage-');
 assert.equal(api.validateActivation(record),true);assert.equal(Object.isFrozen(api.decodeActivation(Buffer.from(JSON.stringify(record)))),true);
 const receipt=await f.owner.activation.write(record);
 assert.deepEqual(Object.keys(receipt).sort(),['base','dev','ino','sha256']);
 assert.equal(f.activationFile,p.join(activationPath(f.temp,f.target),api.ACTIVATION_NAME));
 assert.deepEqual(await io.readdir(f.activationDir),[api.ACTIVATION_NAME]);
 const found=await f.owner.activation.inspect({base:f.target});
 assert.equal(found.present,true);assert.equal(found.value.activation,'separate-fresh-root');assert.equal(found.value.operation,'restore');
 assert.equal(found.receipt.sha256,receipt.sha256);assert.equal(found.receipt.base,f.target);
 assert.equal(await f.owner.activation.remove(found.receipt),true);
 assert.equal((await f.owner.activation.inspect({base:f.target})).present,false);
 assert.equal(await f.owner.activation.remove(receipt),true,'removal is idempotent only after its own deletion');
 // A non-zero generation authority requires an identifier and sha, and both are
 // preserved byte-for-byte in the inspected value.
 const genN={generation:2,id:'a'.repeat(48),mode:'encrypted',sha256:'b'.repeat(64)};
 const second=await f.owner.activation.write(f.activation({authority:genN}));
 assert.match(second.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(JSON.parse(JSON.stringify((await f.owner.activation.inspect({base:f.target})).value.authority)),genN);
 await f.owner.activation.remove(second);
 assert.deepEqual(await io.readdir(f.activationDir),[]);
});
test('activation records are strict fixed-shape and bounded to 16KiB',async t=>{
 const f=await activationFixture(t),record=f.activation();
 assert.throws(()=>api.decodeActivation(Buffer.alloc(api.LIMIT+1,0x20)),{code:'work_data_claim.claim_invalid'});
 assert.throws(()=>api.decodeActivation(Buffer.from([0xff])),{code:'work_data_claim.claim_invalid'});
 for(const bad of [
  {...record,extra:1},omit(record,'authority'),{...record,schema:2},{...record,activation:'activated'},
  {...record,operation:'export'},{...record,base:'relative'},{...record,id:'A'.repeat(48)},
  {...record,nonce:'e'.repeat(63)},{...record,parentPid:0},{...record,resultSha256:'f'.repeat(63)},
  {...record,createdAt:'2026-10-27T00:00:00Z'},{...record,baseIdentity:{dev:'x',ino:'1'}},
  {...record,authority:{generation:0,id:'a'.repeat(48),mode:'plain',sha256:null}},
  {...record,authority:{generation:0,id:null,mode:'plain',sha256:'b'.repeat(64)}},
  {...record,authority:{generation:2,id:'a'.repeat(47),mode:'plain',sha256:'b'.repeat(64)}},
  {...record,authority:{generation:2,id:'a'.repeat(48),mode:'plain',sha256:null}},
  {...record,authority:{generation:2,id:'a'.repeat(48),mode:'plain',sha256:'b'.repeat(63)}},
  {...record,authority:{generation:2,id:'a'.repeat(48),mode:'binary',sha256:'b'.repeat(64)}},
 ]) await assert.rejects(f.owner.activation.write(bad),{code:'work_data_claim.claim_invalid'});
 assert.equal(fs.existsSync(f.activationDir),false,'an invalid activation write creates no namespace');
});
test('a second activation write cannot replace the selected record',async t=>{
 const f=await activationFixture(t),receipt=await f.owner.activation.write(f.activation());
 await assert.rejects(f.owner.activation.write(f.activation()),{code:'work_data_claim.claim_exists'});
 await assert.rejects(f.owner.activation.write(f.activation({createdAt:'2026-10-27T00:00:01.000Z'})),{code:'work_data_claim.claim_exists'});
 const found=await f.owner.activation.inspect({base:f.target});
 assert.equal(found.receipt.sha256,receipt.sha256);assert.deepEqual(await io.readdir(f.activationDir),[api.ACTIVATION_NAME]);
});
test('activation removal is exact sha/dev/ino CAS and tampering never authorizes deletion',async t=>{
 const f=await activationFixture(t),receipt=await f.owner.activation.write(f.activation());
 await assert.rejects(f.owner.activation.remove({...receipt,ino:String(BigInt(receipt.ino)+1n)}),{code:'work_data_claim.claim_changed'});
 await assert.rejects(f.owner.activation.remove({...receipt,dev:String(BigInt(receipt.dev)+1n)}),{code:'work_data_claim.claim_changed'});
 await assert.rejects(f.owner.activation.remove({...receipt,extra:1}),{code:'work_data_claim.receipt_invalid'});
 await io.appendFile(f.activationFile,' ');
 await assert.rejects(f.owner.activation.remove(receipt),{code:'work_data_claim.claim_changed'});
 const drifted=await f.owner.activation.inspect({base:f.target});
 assert.notEqual(drifted.receipt.sha256,receipt.sha256);
 assert.equal(await f.owner.activation.remove(drifted.receipt),true,'only the exact current receipt may remove');
 await io.writeFile(f.activationFile,Buffer.from(JSON.stringify({...f.activation(),extra:1})));
 await assert.rejects(f.owner.activation.inspect({base:f.target}),{code:'work_data_claim.claim_invalid'});
 await assert.rejects(f.owner.activation.remove({base:f.target,sha256:'0'.repeat(64),dev:'1',ino:'2'}),{code:'work_data_claim.claim_invalid'});
});
test('an activation stage blocks inspect write and remove without being repaired',async t=>{
 const f=await activationFixture(t),record=f.activation();
 await io.mkdir(f.activationDir);
 const stage=p.join(f.activationDir,api.ACTIVATION_STAGE+'orphan');await io.writeFile(stage,'KEEP STAGE');
 await assert.rejects(f.owner.activation.inspect({base:f.target}),{code:'work_data_claim.stage_pending'});
 await assert.rejects(f.owner.activation.write(record),{code:'work_data_claim.stage_pending'});
 await assert.rejects(f.owner.activation.remove({base:f.target,sha256:'0'.repeat(64),dev:'1',ino:'2'}),{code:'work_data_claim.stage_pending'});
 assert.equal(await io.readFile(stage,'utf8'),'KEEP STAGE');
 assert.equal(fs.existsSync(f.activationFile),false);
});
test('a replaced or aliased activation target and a replaced TEMP namespace fail closed',async t=>{
 const f=await activationFixture(t),receipt=await f.owner.activation.write(f.activation());
 await io.rename(f.target,f.target+'.old');await io.mkdir(f.target);
 await assert.rejects(f.owner.activation.inspect({base:f.target}),{code:'work_data_claim.base_changed'});
 await assert.rejects(f.owner.activation.write(f.activation()),{code:'work_data_claim.base_changed'});
 await assert.rejects(f.owner.activation.remove(receipt),{code:'work_data_claim.base_changed'});
 assert.ok(fs.existsSync(f.activationFile),'a replaced target never authorizes deleting the record');
 const g=await activationFixture(t);
 await io.rename(g.target,g.target+'.real');await io.symlink(g.target+'.real',g.target,'junction');
 await assert.rejects(g.owner.activation.write(g.activation()),{code:'work_data_claim.path_alias'});
 const h=await activationFixture(t);
 await io.mkdir(h.activationDir);await io.rename(h.activationDir,h.activationDir+'.real');
 await io.symlink(h.activationDir+'.real',h.activationDir,'junction');
 await assert.rejects(h.owner.activation.inspect({base:h.target}),{code:'work_data_claim.path_alias'});
 const box=p.join(h.root,'box');await io.mkdir(box);await io.mkdir(p.join(box,'nested'));
 const aliasTemp=p.join(h.root,'temp-alias');await io.symlink(box,aliasTemp,'junction');
 const linked=api.create({temp:aliasTemp,flush:async()=>{}});
 await assert.rejects(linked.activation.inspect({base:h.target}),{code:'work_data_claim.path_alias'});
});
test('the default probe uses a real ESRCH and never treats an unknown error as death',async t=>{
 const f=await fixture(t);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>{try{child.kill();}catch{}});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const armed=f.value({childPid:child.pid}),r1=await f.owner.write(armed);
 const committed=f.advance(armed,'committed');
 await f.owner.write(committed,r1);
 assert.equal(await f.owner.classify({base:f.base,intent:false,result:false}),'pending');
 const exited=new Promise(resolve=>child.once('exit',resolve));
 child.kill();
 await exited;
 let verdict='pending';
 for(const deadline=Date.now()+3000;Date.now()<deadline;){
  verdict=await f.owner.classify({base:f.base,intent:false,result:false});
  if(verdict==='inert')break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.equal(verdict,'inert');
});
