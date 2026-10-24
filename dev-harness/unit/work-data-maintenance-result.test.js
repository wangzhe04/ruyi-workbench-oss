'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),p=require('node:path'),os=require('node:os'),vm=require('node:vm'),c=require('node:crypto');
const SOURCE=process.env.RESULT_CANDIDATE||p.join(__dirname,'../../ruyi-workbench/app/src/01ae-work-data-maintenance-result.js');
const api=vm.runInNewContext(fs.readFileSync(SOURCE,'utf8')+'\nWorkDataMaintenanceResult;',{require,Buffer,process});
const manifestSource=p.join(__dirname,'../../ruyi-workbench/app/src/01v-work-data-manifest.js');
const manifestApi=vm.runInNewContext(fs.readFileSync(manifestSource,'utf8')+'\nWorkDataManifest;',{require,Buffer,process});
const hash=bytes=>c.createHash('sha256').update(bytes).digest('hex'),id='a'.repeat(48),full=value=>({generation:value.generation,id:value.id,mode:value.mode,sha256:value.proof.sha256});
async function fixture(t){
 const root=await io.mkdtemp(p.join(os.tmpdir(),'ruyi-result-unit-')),base=p.join(root,'base'),outside=p.join(root,'backup');await io.mkdir(base);await io.mkdir(outside);
 t.after(async()=>{assert.equal(p.dirname(root),p.resolve(os.tmpdir()));assert.ok(p.basename(root).startsWith('ruyi-result-unit-'));await io.rm(root,{recursive:true,force:true});});
 const manifest=manifestApi.create({base,publish:async({stage,target})=>io.rename(stage,target)}),source=full(await manifest.readActive()),ownership={roots:[base]},state={owned:true,durable:true,flush:async()=>{},events:[]};
 const backupPath=p.join(outside,'ruyi-work-data-'+id+'.ruyi-backup'),bytes=Buffer.from('actual encrypted package bytes for transport owner unit');await io.writeFile(backupPath,bytes);
 const stat=await io.stat(backupPath,{bigint:true}),backup={path:backupPath,sha256:hash(bytes),bytes:bytes.length,identity:{dev:String(stat.dev),ino:String(stat.ino)}};
 const host={base,ownership,assertExclusive:async owner=>state.owned&&owner===ownership,readAuthority:()=>manifest.readActive(),assertDurableBackup:async supplied=>{
   state.events.push('backup-proof');return state.durable&&supplied.path===backup.path&&supplied.sha256===backup.sha256&&supplied.bytes===backup.bytes&&supplied.identity.ino===backup.identity.ino;
 },flush:async roots=>{state.events.push('flush');await state.flush(roots);}},owner=api.create(host);
 const value={schema:1,id,operation:'export',state:'verified',finishedAt:new Date().toISOString(),sourceAuthority:source,authority:source,backup};
 return {root,base,outside,manifest,ownership,state,backup,host,owner,value,file:p.join(base,'.work-data',api.NAME)};
}
test('real file write fresh reader backup hash and issued receipt verify use exact current manifest',async t=>{
 const f=await fixture(t);assert.equal(await f.owner.read(),null);const receipt=await f.owner.write(f.value);assert.equal(await f.owner.verify(receipt),true);
 assert.equal(receipt.name,'.work-data/maintenance-result-v1.json');assert.equal(receipt.sha256,hash(await io.readFile(f.file)));
 assert.ok(f.state.events.filter(value=>value==='flush').length===2);const fresh=api.create({base:f.base,ownership:f.ownership,assertExclusive:f.host.assertExclusive,readAuthority:f.host.readAuthority});
 const result=await fresh.read();assert.equal(result.id,id);assert.equal(result.operation,'export');assert.equal(result.state,'verified');assert.equal(result.proof.sha256,receipt.sha256);
 await assert.rejects(()=>fresh.write(f.value),{code:'work_data_result.writer_unavailable'});await assert.rejects(()=>fresh.verify(receipt),{code:'work_data_result.receipt_invalid'});
});
test('pure portable schema decoder never reads old backup absolute paths or invents restore activation',async t=>{
 const f=await fixture(t),value={...f.value,operation:'restore',restored:{target:p.join(f.root,'target'),activation:'separate-fresh-root'}};
 await io.unlink(f.backup.path);assert.equal(api.validate(value),true);const decoded=api.decode(Buffer.from(JSON.stringify(value)));assert.equal(decoded.restored.activation,'separate-fresh-root');
 assert.equal(api.validate({...value,restored:{...value.restored,activation:'activated'}}),false);assert.throws(()=>api.decode(Buffer.from(JSON.stringify({...value,password:'PRIVATE'}))),{code:'work_data_result.record_invalid'});
});
test('enable records require generation plus mode transition and a real newly published manifest',async t=>{
 const f=await fixture(t),before=await f.manifest.readActive(),candidate=await f.manifest.prepare({expected:before,mode:'encrypted'}),active=await f.manifest.commit({expected:before,candidate});
 const value={...f.value,operation:'enable',state:'published',authority:full(active)};assert.equal(api.validate(value),true);const receipt=await f.owner.write(value);assert.equal(await f.owner.verify(receipt),true);assert.equal((await f.owner.read()).authority.id,active.id);
 assert.equal(api.validate({...value,authority:{...value.authority,generation:3}}),false);assert.equal(api.validate({...value,state:'verified'}),false);
});
test('backup receipt denial missing backup changed bytes or byte-identical new native identity refuse',async t=>{
 for(const mode of ['denied','missing','changed','new-id']){
  const f=await fixture(t);if(mode==='denied')f.state.durable=false;
  if(mode==='missing')await io.unlink(f.backup.path);if(mode==='changed')await io.writeFile(f.backup.path,Buffer.alloc(f.backup.bytes,88));
  if(mode==='new-id'){await io.rename(f.backup.path,f.backup.path+'.saved');await io.copyFile(f.backup.path+'.saved',f.backup.path);}
  await assert.rejects(()=>f.owner.write(f.value));assert.equal(fs.existsSync(f.file),false);
 }
});
test('fresh normal reader checks actual backup identity bytes and hash while pure decode remains historical',async t=>{
 const f=await fixture(t);await f.owner.write(f.value);await io.writeFile(f.backup.path,Buffer.alloc(f.backup.bytes,88));
 assert.equal(api.decode(await io.readFile(f.file)).id,id);await assert.rejects(()=>f.owner.read(),{code:'work_data_result.backup_changed'});
});
test('stale authority never becomes a current completion receipt and write refuses wrong authority',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value),before=await f.manifest.readActive(),candidate=await f.manifest.prepare({expected:before,mode:'encrypted'});await f.manifest.commit({expected:before,candidate});
 assert.equal(await f.owner.read(),null);await assert.rejects(()=>f.owner.verify(receipt),{code:'work_data_result.record_changed'});await assert.rejects(()=>f.owner.write(f.value),{code:'work_data_result.authority_changed'});
});
test('unknown staged result blocks reads and writes without deleting retained bytes',async t=>{
 const f=await fixture(t);await io.mkdir(p.dirname(f.file));const stage=p.join(p.dirname(f.file),api.STAGE+'orphan.json');await io.writeFile(stage,'PRESERVE ORPHAN');
 await assert.rejects(()=>f.owner.read(),{code:'work_data_result.stage_pending'});await assert.rejects(()=>f.owner.write(f.value),{code:'work_data_result.stage_pending'});assert.equal(await io.readFile(stage,'utf8'),'PRESERVE ORPHAN');
});
test('flush failure retains actual stage and never issues a successful result',async t=>{
 const f=await fixture(t);f.state.flush=async()=>{throw Error('simulated native flush failure');};await assert.rejects(()=>f.owner.write(f.value));
 assert.equal(fs.existsSync(f.file),false);const names=await io.readdir(p.dirname(f.file));assert.equal(names.filter(name=>name.startsWith(api.STAGE)).length,1);await assert.rejects(()=>f.owner.read(),{code:'work_data_result.stage_pending'});
});
test('private result snapshot survives caller and host callback mutations across awaits',async t=>{
 const f=await fixture(t),value=JSON.parse(JSON.stringify(f.value));let release,entered;const waiting=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 f.host.assertDurableBackup=async backup=>{entered();await barrier;try{backup.sha256='0'.repeat(64);}catch{}return true;};const owner=api.create(f.host),pending=owner.write(value);await waiting;
 value.operation='restore';value.backup.path=p.join(f.root,'do-not-read');value.state='published';release();const receipt=await pending;
 const actual=await owner.read();assert.equal(actual.operation,'export');assert.equal(actual.backup.path,f.backup.path);assert.equal(await owner.verify(receipt),true);
});
test('owner loss native identity replacement and forged receipts cannot verify stored success',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value);await assert.rejects(()=>f.owner.verify({...receipt}),{code:'work_data_result.receipt_invalid'});
 f.state.owned=false;await assert.rejects(()=>f.owner.read(),{code:'work_data_result.ownership_required'});f.state.owned=true;
 const bytes=await io.readFile(f.file);await io.rename(f.file,f.file+'.old');await io.writeFile(f.file,bytes);await assert.rejects(()=>f.owner.verify(receipt),{code:'work_data_result.record_changed'});
});
test('bounded strict records reject invalid UTF8 oversized unknown and secret-bearing shapes',async t=>{
 const f=await fixture(t);for(const raw of [Buffer.from([255]),Buffer.alloc(16385,32),Buffer.from('{}'),Buffer.from(JSON.stringify({...f.value,password:'PRIVATE'}))])assert.throws(()=>api.decode(raw),{code:'work_data_result.record_invalid'});
 const bad={...f.value,backup:{...f.backup,identity:{dev:'0',ino:'bogus'}}};assert.equal(api.validate(bad),false);
});
test('source-contained backup metadata cannot authorize a completion record',async t=>{
 const f=await fixture(t),file=p.join(f.base,'ruyi-work-data-'+id+'.ruyi-backup');await io.copyFile(f.backup.path,file);const stat=await io.stat(file,{bigint:true}),value={...f.value,backup:{...f.backup,path:file,identity:{dev:String(stat.dev),ino:String(stat.ino)}}};
 assert.equal(api.validate(value),true);await assert.rejects(()=>f.owner.write(value),{code:'work_data_result.backup_invalid'});
});

test('unknown stage created by actual post-rename flush blocks completion receipt and remains intact',async t=>{
 const f=await fixture(t),stage=p.join(p.dirname(f.file),api.STAGE+'post-rename.json');let count=0;
 f.state.flush=async()=>{if(++count===2)await io.writeFile(stage,'PRESERVE UNKNOWN STAGE',{flag:'wx'});};
 await assert.rejects(()=>f.owner.write(f.value),{code:'work_data_result.stage_pending'});
 assert.equal(await io.readFile(stage,'utf8'),'PRESERVE UNKNOWN STAGE');assert.equal(fs.existsSync(f.file),true);
});
test('an issued prior receipt cannot finish after a later unknown result stage appears',async t=>{
 const f=await fixture(t),receipt=await f.owner.write(f.value),stage=p.join(p.dirname(f.file),api.STAGE+'late.json');await io.writeFile(stage,'KEEP LATE');
 await assert.rejects(()=>f.owner.verify(receipt),{code:'work_data_result.stage_pending'});assert.equal(await io.readFile(stage,'utf8'),'KEEP LATE');
});
test('readAuthority callback stage creation is caught again before normal reader declares success',async t=>{
 const f=await fixture(t);await f.owner.write(f.value);const stage=p.join(p.dirname(f.file),api.STAGE+'callback.json');let injected=false;
 const reader=api.create({...f.host,readAuthority:async()=>{if(!injected){injected=true;await io.writeFile(stage,'KEEP CALLBACK');}return f.manifest.readActive();}});
 await assert.rejects(()=>reader.read(),{code:'work_data_result.stage_pending'});assert.equal(await io.readFile(stage,'utf8'),'KEEP CALLBACK');
});
