'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),p=require('node:path'),{fixture}=require('../lib/fulltext-consumer-fixture.js');
const row=content=>({role:'user',id:'actual_msg',turnSeq:4,content});
async function fx(t,options){const f=await fixture(options);t.after(()=>f.close());return f;}
test('authenticated UI and normal model retain existing cross-project search, filter only shrinks results and coverage',async t=>{const f=await fx(t),a=p.join(f.directory,'A'),b=p.join(f.directory,'B');await f.put('Alpha',[row('cross project needle')],{head:{title:'Alpha',cwd:a}});await f.put('Beta',[row('cross project needle')],{head:{title:'Beta',cwd:b}});assert.equal((await f.model('cross project needle')).results.length,2);const narrowed=await f.ui('cross project needle',f.projectKey(a));assert.equal(narrowed.results.length,1);assert.equal(narrowed.results[0].id,'Alpha');assert.equal(narrowed.coverage.sessions,1);assert.equal(narrowed.coverage.indexedSessions,1);});
test('JSON/model claims cannot forge the missing private search scope',async t=>{const f=await fx(t);await assert.rejects(()=>f.hooks.search('needle',10),error=>error.code==='session_search.scope_required');await assert.rejects(()=>f.hooks.withModel({scope:'all',sessionId:'Destination'},'threads_search',null,()=>f.hooks.search('needle',10)),error=>error.code==='session_search.model_scope_required');});
test('UI token/request liveness and config generation are rechecked after await and immediately before emit',async t=>{for(const kind of ['token','disconnect','config']){const f=await fx(t);await f.put('Visible',[row('visible needle')]);let sent=0;const{req,res}=f.request();await assert.rejects(()=>f.hooks.withUI(req,res,null,async()=>{const value=await f.hooks.search('visible needle',10);if(kind==='token')f.context.RUNTIME.token='REVOKED';if(kind==='disconnect')res.emit('close');if(kind==='config')f.context.configReadGeneration++;return f.hooks.emitUI(value,()=>{sent++;});}),error=>error.code==='session_search.destination_changed');assert.equal(sent,0);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}});
test('model cancellation and execution owner replacement revoke the issued destination',async t=>{for(const kind of ['abort','owner']){const f=await fx(t);await f.put('Visible',[row('visible needle')]);await assert.rejects(()=>f.hooks.withModel(f.ctx,'threads_search',null,async()=>{const value=await f.hooks.search('visible needle',10);if(kind==='abort')f.controller.abort();else f.context.turnSettlers.set('Destination',{});return value;}),error=>error.code==='session_search.destination_changed');}});
test('source edit after a computed hit refuses instead of publishing a stale body or metadata',async t=>{const f=await fx(t);await f.put('Mutable',[row('old needle')]);const{req,res}=f.request();let sent=0;await assert.rejects(()=>f.hooks.withUI(req,res,null,async()=>{const value=await f.hooks.search('old needle',10);await f.put('Mutable',[row('new changed body')]);return f.hooks.emitUI(value,()=>{sent++;});}),error=>error.code==='session_search.source_changed');assert.equal(sent,0);const next=await f.ui('old needle');assert.equal(next.results.length,0);});
test('source encrypted under previous ON cannot derive plaintext fulltext shards after OFF',async t=>{const f=await fx(t,{enabled:true});await f.put('Encrypted',[row('encrypted old needle')]);f.enable(false);f.changeConfig({workDataEncryptionV1:false});await assert.rejects(()=>f.ui('encrypted old needle'),error=>error.code==='session_fulltext.source_policy_conflict');const files=await fs.readdir(p.join(f.sessions,'_fulltext-index-v1')).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error));assert.equal(files.filter(name=>name!=='state.json').length,0);});
test('OFF privacy creates no privacy mappings and still searches complete long source',async t=>{const f=await fx(t);await f.put('Off',[row('x'.repeat(16000)+' off tail needle')]);const found=await f.ui('off tail needle');assert.equal(found.results.length,1);assert.deepEqual(await fs.readdir(f.privacyRoot),[]);});
test('persisted attachment preview is searchable but never counted as complete attachment extraction',async t=>{const f=await fx(t);await f.put('Attachment',[{...row('ordinary'),attachments:[{textPreview:'preview '.repeat(1500)+' attachment tail needle'}]}]);const found=await f.ui('attachment tail needle');assert.equal(found.results.length,1);assert.equal(found.coverage.complete,false);assert.equal(found.coverage.attachments.unverifiedFullText,1);});
let attachmentModules;
async function attachmentFixture(t,options){
  const f=await fx(t,options),uploads=p.join(f.directory,'uploads');
  await fs.mkdir(uploads);
  require('../lib/self-isolate-home');
  attachmentModules??=require('../lib/server-internals').loadServerInternals([
    'WorkDataAttachmentRuntime','MediaImageHooks','FileVisualIo','decodeTextFileBytes','sanitizeFsSegmentName',
  ]);
  Object.assign(f.context,attachmentModules);
  f.context.paths.uploads=uploads;
  f.keys.snapshot=async()=>{const key=Buffer.from(f.master);return{key,instanceId:f.instanceId,release:()=>key.fill(0)};};
  return {...f,uploads};
}
test('original uploaded text yields tail offsets, refuses mutation before emission and retires stale attachment shards',async t=>{
  const f=await attachmentFixture(t),attachment={id:'file_0123456789abcdef',name:'report.txt',textPreview:'preview only',path:'ignored'};
  const prefix='earlier '.repeat(2000),needle='OriginalUploadTail',content=prefix+needle;
  attachment.size=Buffer.byteLength(content);
  const folder=p.join(f.uploads,attachment.id),file=p.join(folder,attachment.name);
  await fs.mkdir(folder);await fs.writeFile(file,content);
  await f.put('AttachmentTail',[{...row('ordinary'),attachments:[attachment]}]);
  const result=await f.ui(needle),hit=result.results[0];
  assert.equal(hit?.reference.source,'attachments.0.extractedText');
  assert.equal(hit.reference.matchStart,prefix.length);
  assert.equal(hit.reference.matchEnd,content.length);
  assert.equal(result.coverage.attachments.unverifiedFullText,0);
  assert.equal(result.coverage.complete,true);
  const dir=p.join(f.sessions,'_fulltext-index-v1','AttachmentTail'),manifestFile=p.join(dir,'manifest.json');
  const selected=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  await assert.rejects(()=>f.ui(needle,null,async({hooks})=>{
    const value=await hooks.search(needle);
    assert.equal(value.results.length,1);
    await fs.unlink(file);
    return value;
  }),{code:'session_search.source_changed'});
  const retired=await f.ui(needle);
  assert.equal(retired.results.length,0);
  assert.equal(retired.coverage.attachments.unverifiedFullText,1);
  assert.equal(retired.coverage.complete,false);
  const replaced=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  assert.notEqual(replaced.generation,selected.generation);
  for(const {ordinal}of selected.shards)await assert.rejects(fs.stat(p.join(dir,selected.generation+'.'+ordinal+'.json')),{code:'ENOENT'});
  const replacement='ReplacementText!!!';
  assert.equal(replacement.length,needle.length);
  await fs.writeFile(file,prefix+replacement);
  const fresh=await f.ui(replacement);
  assert.equal(fresh.results[0]?.reference.matchStart,prefix.length);
  assert.notEqual(fresh.results[0].reference.contentRevision,hit.reference.contentRevision);
  assert.equal(fresh.coverage.complete,true);
});
test('encrypted attachment lookup accepts only the authenticated original and seals extracted shards',async t=>{
  const f=await attachmentFixture(t,{enabled:true});
  const prefix='earlier '.repeat(2000),needle='SealedOriginalTail',data=Buffer.from(prefix+needle);
  const attachment={id:'file_0123456789abcdef',name:'report.txt',size:data.length};
  const runtime=f.context.WorkDataAttachmentRuntime.create({root:f.uploads,keys:f.keys,enabled:()=>true});
  await runtime.seal({id:attachment.id,kind:'original',logicalName:attachment.name,mime:'text/plain',data});
  const other={id:'file_abcdef0123456789',name:'retained.txt',size:19};
  const rawFolder=p.join(f.uploads,other.id);await fs.mkdir(rawFolder);
  await fs.writeFile(p.join(rawFolder,other.name),'RetainedRawOnlyText');
  await f.put('SealedAttachment',[{...row('ordinary'),attachments:[attachment,other]}]);
  const result=await f.model(needle),hit=result.results[0];
  assert.equal(hit?.reference.source,'attachments.0.extractedText');
  assert.equal(hit.reference.matchStart,prefix.length);
  assert.equal(result.coverage.attachments.unverifiedFullText,1);
  assert.equal((await f.ui('RetainedRawOnlyText')).results.length,0);
  const owned=p.join(f.sessions,'_fulltext-index-v1','SealedAttachment');
  for(const name of await fs.readdir(owned)){
    const carrier=await fs.readFile(p.join(owned,name),'utf8');
    assert.equal(JSON.parse(carrier.split('\n')[0]).purpose,'search-index');
    assert.equal(carrier.includes(needle),false);
    assert.equal(carrier.includes('RetainedRawOnlyText'),false);
  }
  const chunk=p.join(f.uploads,runtime.opaqueFor(attachment.id),runtime.revisionFor(data),'part-000000.json');
  const changed=await fs.readFile(chunk);
  changed[40]^=1;
  assert.equal((await runtime.stat(attachment.id)).sha256.length,64);
  await assert.rejects(()=>f.ui(needle,null,async({hooks})=>{
    const value=await hooks.search(needle);
    assert.equal(value.results.length,1);
    await fs.writeFile(chunk,changed);
    assert.equal((await runtime.stat(attachment.id)).sha256.length,64);
    return value;
  }),{code:'session_search.source_changed'});
});
test('attachment lookup refuses path aliases, invalid references, binary text and unavailable documents',async t=>{
  const f=await attachmentFixture(t),home=p.join(f.uploads,'file_0123456789abcdef');
  await fs.mkdir(home);
  const outside=p.join(f.directory,'external.txt'),outsideBytes='ExternalAttachmentNeedle';
  await fs.writeFile(outside,outsideBytes);
  await fs.link(outside,p.join(home,'alias.txt'));
  const binary=Buffer.from('BinaryAttachmentNeedle\0');
  await fs.writeFile(p.join(home,'binary.txt'),binary);
  const refs=[{name:'alias.txt',size:outsideBytes.length},{name:'../external.txt',size:outsideBytes.length},{name:'binary.txt',size:binary.length},
    {name:'document.pdf',size:100}].map(item=>({id:'file_0123456789abcdef',...item}));
  await f.put('UnsafeAttachment',[{...row('ordinary'),attachments:refs}]);
  for(const query of ['ExternalAttachmentNeedle','BinaryAttachmentNeedle']){
    const result=await f.ui(query);
    assert.equal(result.results.length,0);
    assert.equal(result.coverage.attachments.unverifiedFullText,4);
  }
});
test('Office and PDF indexing uses the protected in-memory parser and counts its refusals as unverified',async t=>{
  const f=await attachmentFixture(t),id='file_0123456789abcdef',folder=p.join(f.uploads,id);
  await fs.mkdir(folder);
  const doc=Buffer.from('SYNTHETIC CLEAN OFFICE DATA'),hidden=Buffer.from('SYNTHETIC HIDDEN PDF DATA');
  await fs.writeFile(p.join(folder,'report.docx'),doc);await fs.writeFile(p.join(folder,'hidden.pdf'),hidden);
  const original=attachmentModules.MediaImageHooks.runLocalMediaHelper,seen=new Set();
  f.context.MediaImageHooks={...f.context.MediaImageHooks,availability:async()=>({available:true})};
  attachmentModules.MediaImageHooks.runLocalMediaHelper=async(name,args,bytes)=>{
    assert.equal(name,'native-file-read.py');
    assert.equal(args[0],'--protected');
    assert.equal(JSON.parse(args[2]).visual,false);
    seen.add(args[1]);
    if(args[1]==='.pdf'){
      assert.deepEqual(bytes,hidden);
      return{ok:false,code:'document_hidden_content',hint:'Hidden content requires a clean copy'};
    }
    assert.equal(args[1],'.docx');
    assert.deepEqual(bytes,doc);
    return{ok:true,mode:'document',projection:'document-text',content:'DocumentBodyTail',images:[]};
  };
  try{
    await f.put('Documents',[{...row('ordinary'),attachments:[{id,name:'report.docx',size:doc.length},{id,name:'hidden.pdf',size:hidden.length}]}]);
    const found=await f.ui('DocumentBodyTail');
    assert.equal(found.results[0]?.reference.source,'attachments.0.extractedText');
    assert.equal(found.coverage.attachments.unverifiedFullText,1);
    assert.equal(found.coverage.complete,false);
    assert.deepEqual([...seen].sort(),['.docx','.pdf']);
  }finally{attachmentModules.MediaImageHooks.runLocalMediaHelper=original;}
});
test('an unchanged document deferred by the runtime gets a bounded retry without claiming coverage',async t=>{
  const f=await attachmentFixture(t),id='file_0123456789abcdef',folder=p.join(f.uploads,id),bytes=Buffer.from('SYNTHETIC OFFICE DATA');
  await fs.mkdir(folder);
  await fs.writeFile(p.join(folder,'report.docx'),bytes);
  const original=attachmentModules.MediaImageHooks.runLocalMediaHelper;
  let available=false,attempts=0;
  f.context.MediaImageHooks={...f.context.MediaImageHooks,availability:async()=>({available:true})};
  attachmentModules.MediaImageHooks.runLocalMediaHelper=async()=>{
    attempts++;
    if(!available)throw Object.assign(Error('synthetic busy worker'),{code:'privacy.image_worker_busy'});
    return{ok:true,mode:'document',projection:'document-text',content:'DeferredDocumentTail',images:[]};
  };
  try{
    await f.put('DeferredDocument',[{...row('ordinary'),attachments:[{id,name:'report.docx',size:bytes.length}]}]);
    const deferred=await f.ui('DeferredDocumentTail');
    assert.equal(deferred.results.length,0);
    assert.equal(deferred.coverage.attachments.unverifiedFullText,1);
    assert.equal(deferred.coverage.complete,false);
    assert.equal((await f.ui('DeferredDocumentTail')).results.length,0);
    assert.equal(attempts,1);
    const file=p.join(f.sessions,'_fulltext-index-v1','DeferredDocument','manifest.json');
    const pending=JSON.parse(await fs.readFile(file,'utf8'));
    assert.ok(pending.attachmentsRetryAt>Date.now());
    await fs.writeFile(file,JSON.stringify({...pending,attachmentsRetryAt:1}));
    available=true;
    const found=await f.ui('DeferredDocumentTail');
    assert.equal(found.results[0]?.reference.source,'attachments.0.extractedText');
    assert.equal(found.coverage.complete,true);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).attachmentRevision,pending.attachmentRevision);
  }finally{attachmentModules.MediaImageHooks.runLocalMediaHelper=original;}
});
test('bounded attachment probes leave skipped references visible as incomplete coverage',async t=>{
  const f=await attachmentFixture(t),id='file_0123456789abcdef',folder=p.join(f.uploads,id),text='AttachmentBeyondSessionBudget';
  await fs.mkdir(folder);
  await fs.writeFile(p.join(folder,'tail.txt'),text);
  const head=Array.from({length:4},(_,index)=>({
    role:'user',id:'budget_row_'+index,content:'ordinary',attachments:Array.from({length:16},()=>({id:'not-owned',name:'invalid.txt',size:1})),
  }));
  await f.put('Budget',[...head,{role:'user',id:'tail_row',content:'ordinary',attachments:[{id,name:'tail.txt',size:text.length}]}]);
  const result=await f.ui(text);
  assert.equal(result.results.length,0);
  assert.equal(result.coverage.attachments.unverifiedFullText,65);
  assert.equal(result.coverage.complete,false);
});
test('full source is protected before snippet boundary slicing in enhanced UI and model destinations',async t=>{for(const destination of ['ui','model']){const f=await fx(t,{privacy:'enhanced'}),secret='sk-'+('A1b2c3d4'.repeat(15)),content='public prefix '+secret+' scope needle public tail';await f.put('Secret',[row(content)],{head:{title:'Owned secret test'}});const value=await f[destination]('scope needle'),encoded=JSON.stringify(value);assert.equal(value.results.length,1);assert.equal(encoded.includes(secret),false);assert.equal(encoded.includes(secret.slice(-40)),false);assert.match(value.results[0].snippet,/scope needle/);assert.ok(encoded.length<32768);}});
test('actual projectSource receives complete original field, including secret outside the bounded snippet',async t=>{const content='prefix '.repeat(1500)+'sk-'+('A1b2c3d4'.repeat(15))+' scope needle public tail';let calls=0;const f=await fx(t,{privacy:'enhanced',observeProjectSource:async text=>{calls++;assert.equal(text,content);}});await f.put('Whole',[row(content)]);await assert.doesNotReject(()=>f.ui('scope needle'));assert.ok(calls>0);});
test('consumer search tolerates actual index retirement after epoch observation and exposes pending coverage',async t=>{const f=await fx(t),vm=require('node:vm'),original=f.context.createSessionFullTextSource;let armed=false,calls=0;
f.context.createSessionFullTextSource=()=>{const source=original();return{...source,epoch:async sid=>{const epoch=await source.epoch(sid);if(armed&&++calls===2){armed=false;await vm.runInContext('sessionFullTextOwner',f.context).invalidate(sid);}return epoch;}};};
await f.put('Retired',[row('old retirement needle')]);assert.equal((await f.ui('retirement needle')).results.length,1);armed=true;calls=0;const value=await f.ui('retirement needle');assert.equal(armed,false);assert.equal(value.results.length,0);assert.equal(value.coverage.pendingSessions,1);});
test('disabled body search remains explicit metadata-only without building or reading old body index',async t=>{const f=await fx(t);await f.put('Disabled',[row('body-only-needle')],{head:{title:'metadata title needle'}});f.changeConfig({sessionSearchIndexV1:false});const value=await f.model('metadata title');assert.equal(value.results.length,1);assert.equal(value.scope.mode,'metadata_only');assert.equal(value.scope.fullText,false);assert.equal((await f.model('body-only-needle')).results.length,0);await assert.rejects(()=>fs.stat(p.join(f.sessions,'_fulltext-index-v1')),error=>error.code==='ENOENT');});
test('user pause keeps verified shards searchable and resuming admits missing sources',async t=>{
  const f=await fx(t);
  await f.put('Ready',[row('ReadyBodyNeedle')]);
  assert.equal((await f.ui('ReadyBodyNeedle')).results[0]?.id,'Ready');
  f.changeConfig({sessionSearchIndexPausedV1:true});
  await f.put('Pending',[row('PendingBodyNeedle')]);
  const paused=await f.ui('ReadyBodyNeedle');
  assert.equal(paused.results[0]?.id,'Ready');
  assert.equal(paused.coverage.phase,'paused');
  assert.equal(paused.coverage.indexedSessions,1);
  assert.equal(paused.coverage.pendingSessions,1);
  assert.equal((await f.ui('PendingBodyNeedle')).results.length,0);
  await assert.rejects(fs.stat(p.join(f.sessions,'_fulltext-index-v1','Pending','manifest.json')),{code:'ENOENT'});
  f.changeConfig({sessionSearchIndexPausedV1:false});
  const resumed=await f.ui('PendingBodyNeedle');
  assert.equal(resumed.results[0]?.id,'Pending');
  assert.equal(resumed.coverage.phase,'idle');
  assert.equal(resumed.coverage.complete,true);
});
test('pausing during a pending source build refuses publication before any manifest or shard is selected',async t=>{
  const f=await fx(t);
  await f.put('BuildPause',[row('PendingPauseNeedle')]);
  const original=f.context.createSessionFullTextSource;
  let visits=0;
  f.context.createSessionFullTextSource=()=>{
    const source=original();
    return {...source,scan:(id,visit)=>source.scan(id,async(...args)=>{
      await visit(...args);
      if(++visits===2)f.changeConfig({sessionSearchIndexPausedV1:true});
    })};
  };
  await assert.rejects(f.ui('PendingPauseNeedle'),{code:'session_search.destination_changed'});
  assert.equal(visits,2);
  const folder=p.join(f.sessions,'_fulltext-index-v1','BuildPause');
  assert.deepEqual(await fs.readdir(folder).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error)),[]);
  assert.equal((await f.ui('PendingPauseNeedle')).coverage.phase,'paused');
});
test('legal text alongside unknown array and block payloads never claims complete coverage',async t=>{const f=await fx(t),a=p.join(f.directory,'A'),b=p.join(f.directory,'B');await f.put('ArrayBody',[row([{type:'text',text:'legal array needle'},'second string',{type:'future_payload',data:'unverified'}])],{head:{cwd:a}});await f.put('BlocksBody',[{...row(null),blocks:[{type:'text',text:'block needle'},{type:'future_payload',data:'unverified'}]}],{head:{cwd:b}});const value=await f.ui('array needle');assert.equal(value.coverage.messages.unverifiedText,2);assert.equal(value.coverage.complete,false);assert.equal(value.scope.fullText,false);const narrow=await f.ui('array needle',f.projectKey(a));assert.equal(narrow.coverage.sessions,1);assert.equal(narrow.coverage.messages.unverifiedText,1);assert.equal(narrow.coverage.complete,false);});

test('actual cold consumer uses one admitted private preparation and warm search never rebuilds',async t=>{
  const f=await fx(t),total=33;for(let n=0;n<total;n++)await f.put('Consumer_'+String(n).padStart(3,'0'),[row(n===total-1?'consumer-private-prepare-needle':'ordinary complete text '+n)]);
  let scans=0,prepares=0,gates=0;const create=f.context.createSessionFullTextSource;f.context.createSessionFullTextSource=()=>{const source=create();return{...source,scan:async(...args)=>{scans++;return source.scan(...args);}};};
  const bind=f.context.SessionFullTextHooks.bindSessions;f.context.SessionFullTextHooks.bindSessions=disclosure=>{const index=bind(disclosure);return Object.freeze({...index,prepare:async context=>{prepares++;return index.prepare(context);},step(){throw Error('production preparation must not restart public step');}});};
  const run=f.context.WorkDataMaintenanceHooks.run;f.context.WorkDataMaintenanceHooks.run=(kind,work)=>{assert.equal(kind,'session-fulltext-index');gates++;return run(kind,work);};
  const cold=await f.ui('consumer-private-prepare-needle');assert.equal(cold.coverage.complete,true);assert.equal(cold.results[0].id,'Consumer_032');assert.equal(prepares,1);assert.equal(gates,1);assert.ok(scans<=total*4+3,'complete source scan calls remain linear, not a timing threshold');
  assert.equal((await f.ui('consumer-private-prepare-needle')).results[0].id,'Consumer_032');assert.equal(prepares,1);assert.equal(gates,1);
});
test('actual consumer private preparation cannot bypass a closed maintenance admission',async t=>{
  const f=await fx(t);await f.put('MaintenancePrepare',[row('maintenance-private-prepare-needle')]);const fault=Object.assign(Error('maintenance admission closed'),{code:'fixture.maintenance_closed'});f.context.WorkDataMaintenanceHooks.run=()=>Promise.reject(fault);await assert.rejects(()=>f.ui('maintenance-private-prepare-needle'),error=>error===fault);await assert.rejects(()=>fs.stat(p.join(f.sessions,'_fulltext-index-v1')),error=>error.code==='ENOENT');
});
test('actual consumer preserves a falsy private preparation failure without retry or fallback',async t=>{
  const f=await fx(t);await f.put('FalsyPrepare',[row('falsy-prepare-needle')]);const create=f.context.createSessionFullTextSource;f.context.createSessionFullTextSource=()=>({...create(),scan:async()=>{throw undefined;}});let failed=false,error;try{await f.ui('falsy-prepare-needle');}catch(value){failed=true;error=value;}assert.equal(failed,true);assert.strictEqual(error,undefined);
});
