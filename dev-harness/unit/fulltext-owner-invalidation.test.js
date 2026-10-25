'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,root}=require('../lib/work-data-session-fulltext-fixture.js');
const withFixture=async(work,options)=>{const f=await fixture(options);try{await work(f);}finally{await f.close();}};
const row=content=>({role:'user',content});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const ownerWithIO=(f,overrides)=>{
  const proxy={...fs,...overrides},code=sync.readFileSync(path.join(root,'ruyi-workbench/app/src','13ap-session-fulltext-index.js'),'utf8');
  return vm.runInNewContext(code+'\nSessionFullTextIndex;',{
    ...f.hookContext,require:name=>name==='node:fs/promises'?proxy:require(name),
  }).create(f.host);
};
test('completed invalidate retires an old selection even when its source epoch is unchanged',()=>withFixture(async f=>{
  await f.put('Changing',[row('ordinaryinvalidationneedle')]);await f.index.step();
  const original=f.host.epoch,expected=await original('Changing');let invalidated=false;
  f.host.epoch=async sid=>{const observed=await original(sid);f.host.epoch=original;await f.index.invalidate('Changing');invalidated=true;return observed;};
  let result;await assert.doesNotReject(async()=>{result=await f.index.search('ordinaryinvalidationneedle');});
  assert.equal(invalidated,true);assert.equal(await original('Changing'),expected);assert.equal(result.results.length,0);assert.equal(result.coverage.pendingSessions,1);
}));
test('mid-purge old reader sees pending after manifest retirement before a removed shard',()=>withFixture(async f=>{
  await f.put('Middle',[row('middlepurgeuniqueneedle')]);await f.index.step();
  const directory=path.join(f.sessions,'_fulltext-index-v1','Middle'),manifestFile=path.join(directory,'manifest.json'),selected=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  const deleted=deferred(),release=deferred(),deletions=[];let invalidation;
  const owner=ownerWithIO(f,{unlink:async file=>{await fs.unlink(file);deletions.push(path.basename(file));if(path.basename(file)===selected.generation+'.0.json'){deleted.resolve();await release.promise;}}});
  const original=f.host.epoch,expected=await original('Middle');
  f.host.epoch=async sid=>{const observed=await original(sid);f.host.epoch=original;invalidation=owner.invalidate(sid);await deleted.promise;return observed;};
  try{
    let result;await assert.doesNotReject(async()=>{result=await owner.search('middlepurgeuniqueneedle');});
    assert.equal(deletions[0],'manifest.json','retire pointer before deleting any shard');
    await assert.rejects(fs.stat(manifestFile),{code:'ENOENT'});assert.equal(await original('Middle'),expected);
    assert.equal(result.results.length,0);assert.equal(result.coverage.pendingSessions,1);
  }finally{f.host.epoch=original;release.resolve();if(invalidation)await invalidation;}
  await assert.rejects(fs.stat(directory),{code:'ENOENT'});
}));
test('purge validates all unknown entries before retiring the manifest or deleting a shard',()=>withFixture(async f=>{
  await f.put('Unknown',[row('unknown namespace needle')]);await f.index.step();
  const directory=path.join(f.sessions,'_fulltext-index-v1','Unknown'),manifestFile=path.join(directory,'manifest.json');
  const before=await fs.readFile(manifestFile),files=await fs.readdir(directory);await fs.writeFile(path.join(directory,'foreign-owner.bin'),'KEEP');
  const deletions=[],owner=ownerWithIO(f,{unlink:async file=>{deletions.push(file);return fs.unlink(file);}});
  await assert.rejects(owner.invalidate('Unknown'),{code:'session_fulltext.owned_namespace_changed'});
  assert.deepEqual(deletions,[]);assert.deepEqual(await fs.readFile(manifestFile),before);
  for(const file of files)assert.ok((await fs.stat(path.join(directory,file))).isFile());
  assert.equal(await fs.readFile(path.join(directory,'foreign-owner.bin'),'utf8'),'KEEP');
}));
test('purge validates every owned file before the first deletion even if the invalid file sorts later',()=>withFixture(async f=>{
  await f.put('Alias',[row('hardlink derived owner needle')]);await f.index.step();
  const directory=path.join(f.sessions,'_fulltext-index-v1','Alias'),manifestFile=path.join(directory,'manifest.json'),before=await fs.readFile(manifestFile);
  const foreign=path.join(f.directory,'outside-owned-file'),alias=path.join(directory,'f'.repeat(32)+'.999.json');await fs.writeFile(foreign,'KEEP');await fs.link(foreign,alias);
  const deletions=[],owner=ownerWithIO(f,{unlink:async file=>{deletions.push(file);return fs.unlink(file);}});
  await assert.rejects(owner.invalidate('Alias'),{code:'session_fulltext.owned_namespace_changed'});assert.deepEqual(deletions,[]);assert.deepEqual(await fs.readFile(manifestFile),before);assert.equal(await fs.readFile(foreign,'utf8'),'KEEP');
}));
for(const kind of ['malformed-json','missing-current-shard','key-authentication'])test('retirement check does not soften '+kind+' while current manifest remains authoritative',()=>withFixture(async f=>{
  await f.put('Stable',[row('stable current guarded needle')]);await f.index.step();
  const directory=path.join(f.sessions,'_fulltext-index-v1','Stable'),manifestFile=path.join(directory,'manifest.json'),before=await fs.readFile(manifestFile,'utf8');
  const plaintext=kind==='key-authentication'?await f.fx.store.createText({file:()=>manifestFile,purpose:'search-index',schema:1,scopeId:'sessions',recordId:'fulltext-index:Stable:manifest',chunked:true,maxPlaintextBytes:4*1024*1024,keys:f.keys,enabled:async()=>true,writeJson:f.fx.atomicWriteJson}).read():before;
  const manifest=JSON.parse(plaintext),shard=path.join(directory,manifest.generation+'.0.json');
  const original=f.host.epoch;let errorCode;
  if(kind==='missing-current-shard')await fs.unlink(shard);
  if(kind==='malformed-json')await fs.writeFile(shard,'{invalid-json');
  if(kind==='key-authentication'){
    const keyFailure=Object.assign(Error('simulated key failure'),{code:'work_data_key.unavailable'});
    f.host.epoch=async sid=>{const value=await original(sid);f.host.epoch=original;f.keys.unlock=async()=>{throw keyFailure;};return value;};
  }
  try{await f.index.search('stable current guarded needle');}catch(error){errorCode=error.code;}
  assert.equal(errorCode,kind==='malformed-json'?'session_fulltext.record_invalid':kind==='key-authentication'?'work_data_key.unavailable':'session_fulltext.shard_invalid');
  assert.equal(await fs.readFile(manifestFile,'utf8'),before);
},kind==='key-authentication'?{enabled:true}:undefined));
