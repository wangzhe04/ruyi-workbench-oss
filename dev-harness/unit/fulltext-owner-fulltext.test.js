'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {fixture,root}=require('../lib/work-data-session-fulltext-fixture.js');
const withFixture=async(fn,options)=>{const f=await fixture(options);try{await fn(f);}finally{await f.close();}};
const row=(content,extra={})=>({role:'user',content,...extra});
test('complete long message tail after 8192, canonical tuple and original Unicode coordinates',()=>withFixture(async f=>{
  const content='ordinary '.repeat(1800)+'独特尾部 ＡＢＣ e\u0301 🙂';await f.put('Tail',[row(content,{id:'msg_Actual',turnSeq:17})]);
  assert.equal((await f.index.coverage()).pendingSessions,1);await f.index.step();
  const result=await f.index.search('独特尾部 abc');assert.equal(result.coverage.complete,true);assert.ok(result.results.length);
  const hit=result.results[0];assert.equal(hit.reference.sessionId,'Tail');assert.equal(hit.reference.messageId,'msg_Actual');assert.equal(hit.reference.turnSeq,17);
  assert.equal(content.slice(hit.reference.matchStart,hit.reference.matchEnd).includes('独特尾部'),true);
  assert.ok(hit.reference.snippetEnd<=content.length);assert.equal(content.slice(hit.reference.snippetStart,hit.reference.snippetEnd),hit.snippet);
  assert.match(hit.snippet,/独特尾部/);assert.equal(result.scope.sampling,false);
}));
test('cross-shard phrase is found once with exact original UTF16 match coordinates',()=>withFixture(async f=>{
  const content='z'.repeat(4090)+'cross boundary phrase'+'q'.repeat(3000);await f.put('Boundary',[row(content)]);await f.index.step();
  const hits=(await f.index.search('cross boundary phrase')).results;assert.equal(hits.length,1);
  assert.equal(hits[0].reference.messageIdBasis,'physical-ordinal');assert.equal(hits[0].reference.chunkOrdinal,1);
}));
test('all persisted attachment text indexed without claiming full attachment extraction',()=>withFixture(async f=>{
  await f.put('Attachment',[row('ordinary',{segments:[{text:'another source'}],attachments:[{textPreview:'preview '.repeat(2000)+'attachment-tail-unique'}]})]);await f.index.step();
  const result=await f.index.search('attachment-tail-unique');assert.ok(result.results.some(hit=>hit.reference.source==='attachments.0.textPreview'));
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.attachments.unverifiedFullText,1);
}));
test('legacy source is read whole and remains byte-identical without migration',()=>withFixture(async f=>{
  await f.put('Legacy',[row('x'.repeat(14000)+'legacy-tail-marker')],{legacy:true});const file=path.join(f.sessions,'Legacy.json'),before=await fs.readFile(file);
  await f.index.step();assert.ok((await f.index.search('legacy-tail-marker')).results.length);assert.deepEqual(await fs.readFile(file),before);
  await assert.rejects(fs.stat(path.join(f.sessions,'Legacy.messages.ndjson')),{code:'ENOENT'});
}));
test('real encrypted head, per-record body and shards hide content and bind each shard purpose',()=>withFixture(async f=>{
  await f.put('Encrypted',[row('x'.repeat(10000)+'encrypted-tail-needle')]);await f.index.step();
  assert.ok((await f.index.search('encrypted-tail-needle')).results.length);
  const dir=path.join(f.sessions,'_fulltext-index-v1','Encrypted'),names=await fs.readdir(dir);
  for(const name of names)assert.equal((await fs.readFile(path.join(dir,name),'utf8')).includes('encrypted-tail-needle'),false);
  const shard=names.find(name=>name!=='manifest.json'),other=shard.replace(/\.\d+\.json$/,'.999.json');await fs.copyFile(path.join(dir,shard),path.join(dir,other));
  const wrong=f.fx.store.createText({file:()=>path.join(dir,other),purpose:'search-index',schema:1,scopeId:'sessions',recordId:'fulltext-index:Encrypted:'+other.slice(0,-5),chunked:true,maxPlaintextBytes:256*1024,keys:f.keys,enabled:async()=>true,writeJson:f.fx.atomicWriteJson});
  await assert.rejects(wrong.read());
},{enabled:true}));
test('edit, rewind and archive change source epoch; stale shards never disclose and rebuild succeeds',()=>withFixture(async f=>{
  await f.put('Mutable',[row('obsoleteoriginalneedle'),row('rollbackdeletedneedle')]);await f.index.step();await f.put('Mutable',[row('updatedfreshneedle')],{head:{archived:true,permissionMode:'ask'}});
  assert.equal((await f.index.search('obsoleteoriginalneedle')).results.length,0);assert.equal((await f.index.search('rollbackdeletedneedle')).results.length,0);
  assert.equal((await f.index.coverage()).pendingSessions,1);await f.index.step();assert.ok((await f.index.search('updatedfreshneedle')).results.length);
}));
test('source change during async destination projection suppresses old match',()=>withFixture(async f=>{
  await f.put('Changed',[row('private old needle')]);await f.index.step();let once=false;f.project(async()=>{if(!once){once=true;await f.put('Changed',[row('replacement text')]);}});
  assert.equal((await f.index.search('private old needle')).results.length,0);
}));
test('revoked authorization and changed target scope during awaits reject disclosure',()=>withFixture(async f=>{
  await f.put('Protected',[row('secret-needle-value email user@example.test')]);await f.index.step();
  const protectedHit=(await f.index.search('secret-needle-value')).results[0];assert.ok(protectedHit);assert.equal(protectedHit.snippet.includes('secret-needle-value'),false);
  f.project(async()=>f.allowed.set('Protected',false));assert.equal((await f.index.search('secret-needle-value')).results.length,0);
  f.allowed.set('Protected',true);f.project(async()=>f.changeScope());await assert.rejects(f.index.search('secret-needle-value'),{code:'session_fulltext.disclosure_changed'});
}));
test('pause survives owner recreation and resumes completed sessions without sampling',()=>withFixture(async f=>{
  await f.put('First',[row('first marker')]);await f.put('Second',[row('second marker')]);await f.index.step(1);await f.index.pause();
  const cold=f.restart();assert.equal((await cold.restorePause()).phase,'paused');assert.equal((await cold.step()).indexedSessions,1);
  await cold.resume();assert.equal((await cold.step()).indexedSessions,2);assert.ok((await cold.search('second marker')).results.length);
}));
test('in-flight source build pause leaves no published partial manifest',()=>withFixture(async f=>{
  await f.put('Pause',[row('long '.repeat(10000))]);let pause;f.scan(async()=>{if(!pause)pause=f.index.pause();});
  const result=await f.index.step();await pause;assert.equal(result.phase,'paused');assert.equal(result.indexedSessions,0);
  await assert.rejects(fs.stat(path.join(f.sessions,'_fulltext-index-v1','Pause','manifest.json')),{code:'ENOENT'});
}));
test('read-only committed source ignores uncommitted tail but rejects missing committed body without repair',()=>withFixture(async f=>{
  await f.put('Commit',[row('committeduniqueneedle')]);const file=path.join(f.sessions,'Commit.messages.ndjson');await fs.appendFile(file,'{"role":"user","content":"uncommitteduniqueneedle"}\npartial');const before=await fs.readFile(file);
  await f.index.step();assert.equal((await f.index.search('uncommitteduniqueneedle')).results.length,0);assert.deepEqual(await fs.readFile(file),before);
  await f.put('Broken',[row('one')]);await fs.writeFile(path.join(f.sessions,'Broken.messages.ndjson'),'');
  await assert.rejects(f.api.source.scan('Broken',async()=>{}),{code:'session_fulltext_source.committed_body_missing'});assert.equal((await fs.readFile(path.join(f.sessions,'Broken.messages.ndjson'))).length,0);
}));
test('deleted source and active write are rejected, physical removal purges owned derived files',()=>withFixture(async f=>{
  await f.put('Delete',[row('delete needle')]);await f.index.step();f.context.sessionWriteChains.set('Delete',Promise.resolve());await assert.rejects(f.api.source.epoch('Delete'),{code:'session_fulltext_source.busy'});f.context.sessionWriteChains.delete('Delete');
  f.context.sessionDeleteTombstones.set('Delete',{at:Date.now()});f.catalog.splice(0);await f.index.step();assert.equal((await f.index.search('delete needle')).results.length,0);
  await assert.rejects(fs.stat(path.join(f.sessions,'_fulltext-index-v1','Delete')),{code:'ENOENT'});
}));
test('actual production composition rejects missing scope binding and enumerates true heads without creating a session',()=>withFixture(async f=>{
  const hooks=f.hookContext.SessionFullTextHooks;assert.equal(hooks.maintenanceState().active,0);assert.throws(()=>hooks.bind({}),{code:'session_fulltext.scope_binding_required'});
  await f.put('Production',[row('production tail '.repeat(900)+'actual-owner-needle')]);
  const names=['scope','authorize','assertAuthorized','project','assertScope'],disclosure=Object.fromEntries(names.map(name=>[name,f.host[name]]));
  const owner=hooks.bind(disclosure);assert.equal((await owner.coverage()).pendingSessions,1);await owner.step();assert.ok((await owner.search('actual-owner-needle')).results.length);
  assert.throws(()=>hooks.bind(disclosure),{code:'session_fulltext.already_bound'});assert.equal(f.catalog.length,1);
}));
test('actual maintenance engine pauses and drains bound fulltext owner, blocks fresh builds and restores prior user pause',()=>withFixture(async f=>{
  const vm=require('node:vm'),sync=require('node:fs'),{constBlock}=require(root+'/dev-harness/lib/source-slice');
  const code=sync.readFileSync(root+'/ruyi-workbench/app/src/13ag-work-data-maintenance.js','utf8');
  const domain=vm.runInNewContext(constBlock(code,'WorkDataMaintenance')+'\nWorkDataMaintenance;',{require});
  const hooks=f.hookContext.SessionFullTextHooks;
  const maintenance=domain.create({owns:()=>false,snapshot:()=>{const state=hooks.maintenanceState();return {pending:state.pending,busy:{index:state.active},dirty:0};},
    pause:()=>hooks.maintenancePause(),resume:saved=>hooks.maintenanceResume(saved),flush:async()=>{},yield:()=>new Promise(resolve=>setImmediate(resolve))});
  f.hookContext.WorkDataMaintenanceHooks.run=maintenance.run;
  const names=['scope','authorize','assertAuthorized','project','assertScope'],owner=hooks.bind(Object.fromEntries(names.map(name=>[name,f.host[name]])));
  await f.put('Quiet',[row('quiet owner phrase')]);await owner.step();await owner.pause();
  const lease=maintenance.begin();await lease.idle();assert.equal(lease.assertIdle().phase,'idle');
  await assert.rejects(owner.step(),{code:'work_data.maintenance_busy'});lease.resume();await Promise.all(hooks.maintenanceState().pending);
  assert.equal((await owner.coverage()).phase,'paused');await owner.resume();assert.equal((await owner.coverage()).phase,'idle');
}));
test('concurrent metadata/head writer blocks source proof and Unicode folding retains exact decomposed source coordinates',()=>withFixture(async f=>{
  const content='prefix ＡＢＣ e\u0301 suffix';await f.put('Unicode',[row(content)]);
  const unlock=f.keys.unlock;let entered=false,release;const held=new Promise(resolve=>release=resolve);f.keys.unlock=async()=>{entered=true;await held;return unlock();};
  const pending=f.api.writeSessionHead('Unicode',JSON.stringify({id:'Unicode',storageVersion:2,messageCount:1,archived:true}));
  try{while(!entered)await new Promise(resolve=>setImmediate(resolve));f.keys.unlock=unlock;await assert.rejects(f.api.source.epoch('Unicode'),{code:'session_fulltext_source.busy'});}
  finally{release();await pending;f.keys.unlock=unlock;}
  await f.index.step();const hit=(await f.index.search('abc é')).results[0];assert.ok(hit);assert.equal(content.slice(hit.reference.matchStart,hit.reference.matchEnd),'ＡＢＣ e\u0301');
},{enabled:true}));
test('query coverage contains only authorized sessions, including attachment pending counts',()=>withFixture(async f=>{
  await f.put('Visible',[row('visible scope needle')]);await f.put('Unseen',[row('hidden scope needle',{attachments:[{textPreview:'hidden attachment'}]})]);await f.index.step(16);f.allowed.set('Unseen',false);
  const result=await f.index.search('scope needle');assert.equal(result.coverage.sessions,1);assert.equal(result.coverage.indexedSessions,1);assert.equal(result.coverage.attachments.unverifiedFullText,0);
  assert.ok(result.results.every(hit=>hit.reference.sessionId==='Visible'));
}));
test('entire reference is projected into destination scope without raw citation fields added afterward',()=>withFixture(async f=>{
  await f.put('Citation',[row('citation scope needle')]);await f.index.step();f.host.project=async()=>({reference:{scopeId:'destination',handle:'opaque-ref-1'},snippet:'protected disclosure'});
  const result=await f.index.search('citation scope needle');assert.equal(JSON.stringify(result.results).includes('Citation'),false);
  assert.equal(result.results[0].reference.handle,'opaque-ref-1');assert.equal(result.results[0].snippet,'protected disclosure');
}));
test('derived namespace junction refuses reads and purge without deleting the external target',()=>withFixture(async f=>{
  await f.put('Alias',[row('alias scope needle')]);const external=path.join(f.directory,'separate-owned-target');await fs.mkdir(external);await fs.writeFile(path.join(external,'manifest.json'),'KEEP');
  await fs.mkdir(path.join(f.sessions,'_fulltext-index-v1'));await fs.symlink(external,path.join(f.sessions,'_fulltext-index-v1','Alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.index.search('alias scope needle'),{code:'session_fulltext.owned_namespace_changed'});
  await assert.rejects(f.index.invalidate('Alias',true),{code:'session_fulltext.owned_namespace_changed'});assert.equal(await fs.readFile(path.join(external,'manifest.json'),'utf8'),'KEEP');
}));

test('more than 8192 actual persisted message chunks retain the final unsampled hit',()=>withFixture(async f=>{
  const rows=Array.from({length:8193},(_,n)=>row(n===8192?'after8192uniquechunkneedle':'x',{id:'actual_'+n,turnSeq:n+1}));
  await f.put('NoSample',rows);await f.index.step();
  const manifest=JSON.parse(await fs.readFile(path.join(f.sessions,'_fulltext-index-v1','NoSample','manifest.json'),'utf8'));
  assert.equal(manifest.chunks,8193);assert.equal(manifest.messages,8193);assert.ok(manifest.shards.length>128);
  const result=await f.index.search('after8192uniquechunkneedle');assert.equal(result.coverage.complete,true);assert.equal(result.results[0].reference.messageId,'actual_8192');assert.equal(result.results[0].reference.turnSeq,8193);
}));

for(const carrier of ['head','body'])test('OFF refuses encrypted '+carrier+' source before creating any plaintext content shard',()=>withFixture(async f=>{
  await f.put('Conflict',[row('DO_NOT_DERIVE_PLAINTEXT_TAIL')],{legacy:carrier==='head'});f.enable(false);
  // Seed a cold mixed-format artifact; the normal writer correctly refuses an
  // in-place encrypted-head downgrade, and is not the operation under test.
  if(carrier==='body')await fs.writeFile(path.join(f.sessions,'Conflict.json'),JSON.stringify({id:'Conflict',storageVersion:2,messageCount:1}));
  await assert.rejects(f.index.step(),{code:'session_fulltext.source_policy_conflict'});
  await assert.rejects(fs.stat(path.join(f.sessions,'_fulltext-index-v1','Conflict')),{code:'ENOENT'});
  assert.equal((await f.api.source.scan('Conflict',async()=>{})).requiresEncryption,true);
},{enabled:true}));

test('coverage scope is synchronously revalidated after async enumeration and rejects a late permission change',()=>withFixture(async f=>{
  await f.put('Revoked',[row('scope late revoke needle')]);await f.index.step();let catalogs=0;
  f.onCatalog(async()=>{if(++catalogs===2)f.allowed.set('Revoked',false);});
  await assert.rejects(f.index.search('scope late revoke needle'),{code:'session_fulltext.disclosure_changed'});
}));

for(const carrier of ['head','body'])test('committed source refuses hardlinked '+carrier+' carrier without reading an external owner alias',()=>withFixture(async f=>{
  await f.put('Linked',[row('outside-owner-secret')]);
  const file=path.join(f.sessions,'Linked'+(carrier==='head'?'.json':'.messages.ndjson')),external=path.join(f.directory,'external-'+carrier);
  await fs.rename(file,external);await fs.link(external,file);
  await assert.rejects(f.api.source.scan('Linked',async()=>{}),{code:'session_fulltext_source.owner_alias'});
  assert.equal((await fs.readFile(external,'utf8')).includes('outside-owner-secret'),carrier==='body');
}));

test('session IDs follow actual safeSessionId and committed head intrinsic owner must match exact case',()=>withFixture(async f=>{
  assert.equal(f.api.safeSessionId('search'),'search');await f.put('search',[row('canonical search id needle')]);await f.index.step();assert.ok((await f.index.search('canonical search id needle')).results.length);
  await f.put('Exact_Case',[row('wrong owner must refuse')],{head:{id:'exact_case'}});
  await assert.rejects(f.api.source.scan('Exact_Case',async()=>{}),{code:'session_fulltext_source.session_owner_required'});
}));

test('duplicate intrinsic message ID refuses a canonical tuple alias before content shards are written',()=>withFixture(async f=>{
  await f.put('Repeated',[row('same text',{id:'same_message',turnSeq:1}),row('same text',{id:'same_message',turnSeq:1})]);
  await assert.rejects(f.index.step(),{code:'session_fulltext.message_owner_ambiguous'});
  await assert.rejects(fs.stat(path.join(f.sessions,'_fulltext-index-v1','Repeated')),{code:'ENOENT'});
}));

test('public production coverage and operation statistics include only destination-authorized sessions',()=>withFixture(async f=>{
  await f.put('Visible',[row('visible scope needle')]);await f.put('Unseen',[row('hidden scope needle',{attachments:[{textPreview:'hidden attachment'}]})]);
  const names=['scope','authorize','assertAuthorized','project','assertScope'],owner=f.hookContext.SessionFullTextHooks.bind(Object.fromEntries(names.map(name=>[name,f.host[name]])));
  await owner.step(16,{destination:'restricted'});f.allowed.set('Unseen',false);
  for(const status of [await owner.coverage({destination:'restricted'}),await owner.step(16,{destination:'restricted'}),await owner.restorePause({destination:'restricted'})]){
    assert.equal(status.sessions,1);assert.equal(status.indexedSessions,1);assert.equal(status.attachments.unverifiedFullText,0);assert.equal(status.complete,true);
  }
}));

test('public coverage rejects scope, permission and source sequence changes after its own awaits',()=>withFixture(async f=>{
  await f.put('Visible',[row('visible source needle')]);await f.index.step();
  const original=f.host.epoch;
  for(const cut of ['scope','permission','sequence']){
    f.allowed.set('Visible',true);f.host.epoch=async id=>{const value=await original(id);if(cut==='scope')f.changeScope();if(cut==='permission')f.allowed.set(id,false);if(cut==='sequence')f.context.sessionDiskWriteSeq.set(id,(f.context.sessionDiskWriteSeq.get(id)||0)+1);return value;};
    await assert.rejects(f.index.coverage({destination:'restricted'}),error=>['session_fulltext.disclosure_changed','session_fulltext.source_changed'].includes(error.code));
  }
  f.host.epoch=original;
}));

test('public coverage and build statistics forward the exact destination context to scope checks',()=>withFixture(async f=>{
  await f.put('Scoped',[row('private scope needle')]);const expected={destination:'explicit-authority'},scope=f.host.scope;let calls=0;
  f.host.scope=async context=>{assert.equal(context,expected);calls++;return scope(context);};
  const names=['scope','authorize','assertAuthorized','project','assertScope'],owner=f.hookContext.SessionFullTextHooks.bind(Object.fromEntries(names.map(name=>[name,f.host[name]])));
  await owner.step(1,expected);await owner.coverage(expected);await owner.restorePause(expected);assert.equal(calls,3);
}));

test('ordinary completed rebuild retires an old search generation without reporting corrupt data',()=>withFixture(async f=>{
  await f.put('Changing',[row('oldrebuildneedle')]);await f.index.step();const original=f.host.epoch;let rebuilt=false;
  f.host.epoch=async sid=>{const observed=await original(sid);f.host.epoch=original;await f.put('Changing',[row('newrebuildneedle')]);await f.index.step();rebuilt=true;return observed;};
  let result;await assert.doesNotReject(async()=>{result=await f.index.search('oldrebuildneedle');});assert.equal(rebuilt,true);assert.equal(result.results.length,0);
}));

test('a missing shard in the stable current manifest remains a hard failure without repair',()=>withFixture(async f=>{
  await f.put('Stable',[row('stablemanifestneedle')]);await f.index.step();const directory=path.join(f.sessions,'_fulltext-index-v1','Stable'),manifestFile=path.join(directory,'manifest.json'),before=await fs.readFile(manifestFile,'utf8'),manifest=JSON.parse(before);
  await fs.unlink(path.join(directory,manifest.generation+'.0.json'));await assert.rejects(f.index.search('stablemanifestneedle'),{code:'session_fulltext.shard_invalid'});assert.equal(await fs.readFile(manifestFile,'utf8'),before);
}));

// Private production preparation keeps all source proofs but visits the catalog once.
test('private preparation is one linear catalog/build pass plus one final coverage',()=>withFixture(async f=>{
  const total=33;for(let n=0;n<total;n++)await f.put('Linear_'+String(n).padStart(3,'0'),[row('complete source '+n+' linear-prepare-needle',{id:'linear_'+n})]);
  let catalogs=0,scans=0;const catalog=f.host.catalog,scan=f.host.scan;f.host.catalog=async()=>{catalogs++;return catalog();};f.host.scan=async(...args)=>{scans++;return scan(...args);};
  const value=await f.index.prepare();assert.equal(value.complete,true);assert.equal(value.indexedSessions,total);assert.equal(catalogs,2);assert.equal(scans,total*3);assert.equal(f.index.busy(),false);
  const hit=await f.index.search('linear-prepare-needle');assert.ok(hit.results.length);assert.equal(hit.coverage.complete,true);
}));
test('public step still limits successful builds to16 while private preparation completes remaining sources',()=>withFixture(async f=>{
  for(let n=0;n<18;n++)await f.put('Step_'+n,[]);const stepped=await f.index.step(999);assert.equal(stepped.indexedSessions,16);assert.equal(stepped.pendingSessions,2);assert.equal((await f.index.prepare()).complete,true);
}));
test('private preparation responds to pause during original source scan and resumes through the same serial owner',()=>withFixture(async f=>{
  await f.put('PausePrepare',[row('pause-original-needle')]);let paused,once=true;f.scan(async()=>{if(once){once=false;paused=f.index.pause();}});const result=await f.index.prepare();await paused;assert.equal(result.phase,'paused');assert.equal(result.complete,false);assert.equal(result.pendingSessions,1);assert.equal(f.index.isPaused(),true);f.scan(null);await f.index.resume();assert.equal((await f.index.prepare()).complete,true);
}));
test('private preparation rejects a scope change after catalog await before source builds',()=>withFixture(async f=>{
  await f.put('ScopePrepare',[row('scope-original-needle')]);const body=path.join(f.sessions,'ScopePrepare.messages.ndjson'),before=await fs.readFile(body);let once=true;f.onCatalog(async()=>{if(once){once=false;f.changeScope();}});await assert.rejects(()=>f.index.prepare(),error=>error.code==='session_fulltext.disclosure_changed');assert.deepEqual(await fs.readFile(body),before);assert.equal(f.index.busy(),false);await assert.rejects(()=>fs.stat(path.join(f.sessions,'_fulltext-index-v1/ScopePrepare/manifest.json')),error=>error.code==='ENOENT');
}));
for(const reason of [Object.assign(Error('typed prepare source failure'),{code:'fixture.prepare_source'}),null,undefined,false,0,''])test('private preparation never swallows nonpaused source rejection '+String(reason),()=>withFixture(async f=>{
  await f.put('FailedPrepare',[row('failed-source-original')]);f.scan(async()=>{throw reason;});let failed=false,actual;try{await f.index.prepare();}catch(error){failed=true;actual=error;}assert.equal(failed,true);assert.strictEqual(actual,reason);assert.equal(f.index.busy(),false);await assert.rejects(()=>fs.stat(path.join(f.sessions,'_fulltext-index-v1/FailedPrepare/manifest.json')),error=>error.code==='ENOENT');
}));
test('private preparation preserves falsy source failure plus state-cleanup error and ownership uncertainty',()=>withFixture(async f=>{
  await f.put('DoublePrepare',[row('original-double-failure')]);f.scan(async()=>{throw null;});const write=f.host.writeJson,fault=Object.assign(Error('idle state write failure'),{code:'fixture.prepare_idle',ownershipRetained:true});f.host.writeJson=async(file,value,...args)=>{if(path.basename(file)==='state.json'&&typeof value==='string'&&JSON.parse(value).phase==='idle'){f.changeScope();throw fault;}return write(file,value,...args);};let actual;try{await f.index.prepare();}catch(error){actual=error;}assert.deepEqual(Array.from(actual.errors),[null,fault]);assert.strictEqual(actual.cause,null);assert.equal(actual.cleanupFailed,true);assert.equal(actual.ownershipRetained,true);assert.equal(f.index.busy(),false);
}));

test('private preparation paused during its initial async scope still returns honest paused coverage',()=>withFixture(async f=>{
  await f.put('EarlyPausePrepare',[row('early pause original')]);const scope=f.host.scope;let pause,once=true;f.host.scope=async(...args)=>{const value=await scope(...args);if(once){once=false;pause=f.index.pause();}return value;};const result=await f.index.prepare();await pause;assert.equal(result.phase,'paused');assert.equal(result.complete,false);assert.equal(result.pendingSessions,1);assert.equal(f.index.busy(),false);
}));

for(const point of ['cleanup-idle','coverage-scope'])test('private preparation cannot rebind its original access during '+point+' await',()=>withFixture(async f=>{
  await f.put('FinalScopePrepare',[row('original final scope source')]);let changed=false,calls=0;const write=f.host.writeJson,scope=f.host.scope;
  if(point==='cleanup-idle')f.host.writeJson=async(file,value,...args)=>{const result=await write(file,value,...args),plain=typeof value==='string'?JSON.parse(value):value;if(path.basename(file)==='state.json'&&plain.phase==='idle'){changed=true;f.changeScope();}return result;};
  else f.host.scope=async(...args)=>{if(++calls===2){changed=true;f.changeScope();}return scope(...args);};
  await assert.rejects(()=>f.index.prepare(),error=>error?.code==='session_fulltext.disclosure_changed');assert.equal(changed,true);assert.equal(f.index.busy(),false);
}));
