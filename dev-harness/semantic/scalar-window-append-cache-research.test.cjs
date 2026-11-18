'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { fixture, root } = require('../lib/work-data-session-fulltext-fixture');
const { transform } = require('./scalar-window-append-cache-research-source.cjs');
const source = fs.readFileSync(path.join(root,'ruyi-workbench/app/src/13ap-session-fulltext-index.js'),'utf8');
const primitiveSource = fs.readFileSync(path.join(root,'ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');
const primitive = vm.runInNewContext(primitiveSource+'\nSemanticRetrieval;',{require,Date});
const row = (id,text) => ({role:'user',id,content:text});
async function setup(t,attachmentSource=null) {
  const f=await fixture({enabled:true}); t.after(()=>f.close());
  const recipe=transform(source), api=vm.runInNewContext(recipe.source+'\nSessionFullTextIndex;',{...f.hookContext});
  let counts={query:0,document:0},model='fake-v1',scope='destination',scans=0,projections=0,identities=[];
  const runtime={prepare:async()=>({available:true,modelFingerprint:model}),encode:async(texts,{role})=>{
    counts[role]+=texts.length;return {ok:true,modelFingerprint:model,vectors:texts.map(()=>[1,0])};}};
  const host={...f.host,...(attachmentSource?{attachmentSource}:{}),scope:async()=>({...await f.host.scope(),scopeId:scope}),
    assertScope:(ctx,access)=>access.scopeId===scope&&f.host.assertScope(ctx,access),
    scan:async(...args)=>{scans++;return f.host.scan(...args);},
    project:async(...args)=>{projections++;return f.host.project(...args);}};
  const core=primitive.create(runtime),semantic={score:(query,docs,options)=>{identities=options.identities.map(value=>Array.from(value));return core.score(query,docs,options);}};
  const index=api.create({...host,semantic});
  async function search(options={}) {counts={query:0,document:0};scans=0;projections=0;
    const result=await index.search('needle',null,20,options);return {result,counts:{...counts},scans,projections};}
  async function put(rows){await f.put('A',rows);await index.step(16);}
  return {f,index,put,search,identities:()=>identities,setModel:value=>model=value,setScope:value=>scope=value};
}
test('encrypted append encodes only the new message, while warm hits still scan and project current source',async t=>{
  const x=await setup(t),rows=Array.from({length:11},(_,i)=>row('m'+i,'needle original '+i));
  await x.put(rows);assert.equal((await x.search()).counts.document,11);
  const warm=await x.search();assert.equal(warm.counts.document,0);assert.ok(warm.scans>0&&warm.projections>0);
  await x.put([...rows,row('m11','needle appended')]);const result=await x.search();
  assert.equal(result.counts.document,1);assert.equal(result.result.semantic.coverage,'complete');assert.ok(result.scans>0&&result.projections>0);
  assert.ok(result.result.results.some(r=>r.snippet.includes('needle appended')));
});
test('raw case/content, ordinal shifts, scope and model cannot borrow the wrong cached vector',async t=>{
  const x=await setup(t),rows=[row('a','needle Alpha'),row('b','needle Beta'),row('c','needle Gamma')];await x.put(rows);
  assert.equal((await x.search()).counts.document,3);
  await x.put([rows[0],row('b','needle BETA'),rows[2]]);assert.equal((await x.search()).counts.document,1);
  await x.put([rows[0],row('b','needle completely replaced'),rows[2]]);assert.equal((await x.search()).counts.document,1);
  await x.put([row('new','needle inserted'),rows[0],row('b','needle completely replaced'),rows[2]]);
  assert.equal((await x.search()).counts.document,4);
  x.f.changeScope();assert.equal((await x.search()).counts.document,0);
  x.setScope('other-destination');assert.equal((await x.search()).counts.document,4);
  x.setModel('fake-v2');assert.equal((await x.search()).counts.document,4);
});
test('revocation and cancellation reject or withhold cached evidence',async t=>{
  const x=await setup(t);await x.put([row('a','needle sensitive')]);await x.search();
  x.f.allowed.set('A',false);assert.equal((await x.search()).result.results.length,0);
  x.f.allowed.set('A',true);const controller=new AbortController();controller.abort(0);let reason=Symbol();
  try{await x.search({signal:controller.signal});}catch(error){reason=error;}
  assert.equal(reason,0);
});
test('source epoch change while an authorized cached candidate is scanned cannot disclose it',async t=>{
  const x=await setup(t);await x.put([row('a','needle old')]);await x.search();let changed=false;
  x.f.scan(async(id)=>{if(id==='A'&&!changed){changed=true;await x.f.put('A',[row('a','replacement without prior text')]);}});
  let result,error;try{result=await x.search();}catch(e){error=e;}
  assert.equal(changed,true);assert.ok(error||!result.result.results.some(r=>r.snippet.includes('needle old')));
});
test('a forged encrypted shard cannot reuse a vector for a false original window',async t=>{
  const x=await setup(t);await x.put([row('a','needle genuine source')]);await x.search();
  const record=(name,max=256*1024)=>x.f.fx.store.createText({file:()=>path.join(x.f.sessions,'_fulltext-index-v1','A',name),
    purpose:'search-index',schema:1,scopeId:'sessions',recordId:'fulltext-index:A:'+name.replace(/\.json$/,''),
    chunked:true,maxPlaintextBytes:max,keys:x.f.keys,enabled:()=>true,writeJson:x.f.fx.atomicWriteJson});
  const manifest=JSON.parse(await record('manifest.json',4*1024*1024).read());
  const name=manifest.generation+'.0.json',shard=JSON.parse(await record(name).read());
  shard.rows[0].start++;shard.rows[0].end++;for(const run of shard.rows[0].ranges){run[2]++;if(run.length===4)run[3]++;}
  const text=JSON.stringify(shard);await record(name).write(text);manifest.shards[0].sha256=crypto.createHash('sha256').update(text).digest('hex');
  await record('manifest.json',4*1024*1024).write(JSON.stringify(manifest));
  await assert.rejects(x.search(),error=>error.code==='session_fulltext.shard_source_mismatch');
});
test('all embedded attachment fields keep the original session-version cache identity',async t=>{
  const x=await setup(t),first={...row('a','needle body'),attachments:[{textPreview:'needle preview'}]};
  await x.put([first]);assert.equal((await x.search()).counts.document,2);
  await x.put([first,row('b','needle new')]);const next=await x.search();
  assert.equal(next.counts.document,2);assert.equal(next.result.semantic.coverage,'partial');
});
test('extracted-attachment cache hits still revalidate the attachment and refuse a changed source',async t=>{
  let version='v1',selects=0,verifications=0;
  const attachment={isDocument:()=>true,select:async()=>{selects++;return {revision:version};},
    read:async()=>({text:'needle extracted evidence'}),verify:async()=>{verifications++;return true;}};
  const x=await setup(t,attachment),first={...row('a','needle body'),attachments:[{name:'synthetic'}]};
  await x.put([first]);await x.search();selects=0;verifications=0;
  const warm=await x.search();assert.equal(warm.counts.document,0);assert.ok(selects>0&&verifications>0);
  await x.put([first,row('b','needle appended')]);assert.equal((await x.search()).counts.document,2);
  version='v2';const changed=await x.search();
  assert.ok(!changed.result.results.some(item=>item.snippet.includes('needle extracted evidence')));
  assert.equal(changed.result.semantic.coverage,'partial');
});
test('metadata identity remains tied to its original epoch when unrelated messages are appended',async t=>{
  const x=await setup(t),first=row('a','needle body');await x.put([first]);
  const metadata=async()=>({sid:'A',field:'title',text:'needle title',epoch:await x.f.host.epoch('A'),sequence:x.f.host.sourceSequence('A')});
  const options=async()=>({metadataEntries:[await metadata()],verifyMetadata:async()=>true});
  await x.search(await options());const firstIdentity=x.identities().find(item=>item[0]==='metadata');
  assert.ok(firstIdentity);await x.put([first,row('b','needle new')]);await x.search(await options());
  const secondIdentity=x.identities().find(item=>item[0]==='metadata');assert.ok(secondIdentity);
  assert.notEqual(firstIdentity[3],secondIdentity[3]);
});
test('privacy projection failure and cancellation during a cached source scan are not hidden',async t=>{
  const x=await setup(t);await x.put([row('a','needle protected')]);await x.search();
  const denied=Object.assign(Error('privacy policy revoked'),{code:'privacy.denied'});
  x.f.project(async()=>{throw denied;});await assert.rejects(x.search(),error=>error===denied);
  x.f.project(null);const controller=new AbortController();let during=false;
  x.f.scan(async id=>{if(id==='A'&&!during){during=true;controller.abort(0);}});
  let reason=Symbol();try{await x.search({signal:controller.signal,check:()=>{if(controller.signal.aborted)throw controller.signal.reason;}});}catch(error){reason=error;}
  assert.equal(during,true);assert.equal(reason,0);
});
test('actual enhanced privacy gateway is re-entered for cached evidence after a policy change',async t=>{
  const recipe=transform(source),directory=path.join(root,'output/semantic-scalar-window-append-cache-fakes');
  fs.mkdirSync(directory,{recursive:true});const modulePath=path.join(directory,recipe.transformedSha256+'.cjs');
  if(!fs.existsSync(modulePath))fs.writeFileSync(modulePath,recipe.source);
  let projections=0;const f=await require('../lib/fulltext-consumer-fixture').fixture({enabled:true,privacy:'enhanced',module:modulePath,
    observeProjectSource:async()=>{projections++;}});t.after(()=>f.close());
  let documents=0;f.context.SemanticRetrieval=primitive;f.context.SemanticRuntimeHooks={
    prepare:async()=>({available:true,modelFingerprint:'fake-private'}),
    encode:async(texts,{role})=>{if(role==='document')documents+=texts.length;return {ok:true,modelFingerprint:'fake-private',vectors:texts.map(()=>[1,0])};}};
  await f.put('A',[row('a','needle user evidence')]);const first=await f.ui('needle');assert.equal(first.results.length,1);assert.equal(documents,1);
  documents=0;projections=0;f.changeConfig({privacyModeV1:'strict'});const second=await f.ui('needle');
  assert.equal(second.results.length,1);assert.equal(documents,0);assert.ok(projections>0);
});
