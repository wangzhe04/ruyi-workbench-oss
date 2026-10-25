'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs/promises'),p=require('node:path'),c=require('node:crypto'),vm=require('node:vm'),{fixture,actual,repo}=require('../lib/fulltext-consumer-fixture.js'),{functionBlock,constBlock}=require('../lib/source-slice');
const source=actual('02-session-store.js'),sanitize=vm.runInNewContext(constBlock(source,'IMPORTED_MESSAGE_ROLE_MAX')+'\n'+functionBlock(source,'sanitizeImportedSessionMessages')+'\nsanitizeImportedSessionMessages;');
const row=content=>({role:'user',id:'message_array',turnSeq:12,content});
async function fx(t,options){const f=await fixture(options);t.after(()=>f.close());return f;}
test('actual import producer preserves legal array text; complete long fields have exact canonical field coordinates',async t=>{
 const f=await fx(t),long='prefix '.repeat(1500)+'数组真实尾部needle',message=sanitize([row(['first literal needle',{type:'input_text',text:long},{type:'output_text',text:'third output needle'}])])[0];
 a.equal(message.meta.imported,true);await f.put('Imported',[message]);
 for(const [q,field,text]of [['first literal needle','content.0',message.content[0]],['数组真实尾部needle','content.1.text',long],['third output needle','content.2.text',message.content[2].text]]){
  const value=await f.ui(q),hit=value.results[0];a.equal(value.results.length,1);a.equal(value.coverage.messages.unverifiedText,0);a.equal(value.coverage.complete,true);a.equal(hit.reference.source,field);a.equal(hit.reference.turnSeq,12);a.equal(hit.reference.messageId,'message_array');a.equal(hit.reference.contentRevision,c.createHash('sha256').update(JSON.stringify(message)).digest('hex'));a.equal(text.slice(hit.reference.matchStart,hit.reference.matchEnd),q);a.equal(hit.reference.coordinate,'utf16');a.equal(JSON.stringify(value).includes('sourceText'),false);
 }
});
test('blocks and existing segment text are indexed without JSON stringification or fabricated joined offsets',async t=>{
 const f=await fx(t),message=sanitize([{...row(null),blocks:['raw block needle',{type:'text',text:'object block needle'}],segments:[{type:'text',text:'segment exact needle'}]}])[0];await f.put('Blocks',[message]);
 for(const [q,field]of [['raw block needle','blocks.0'],['object block needle','blocks.1.text'],['segment exact needle','segments.0.text']]){const value=await f.model(q);a.equal(value.results.length,1);a.equal(value.results[0].reference.source,field);a.equal(value.coverage.complete,true);a.equal(value.coverage.messages.unverifiedText,0);}
});
test('nontext or unknown array members remain counted as unverified even alongside indexed text',async t=>{
 const f=await fx(t);await f.put('Unknown',[row([{type:'text',text:'known text needle'},{type:'input_image',image_url:'data:image/png;base64,TEST'},['nested unknown needle']])]);const value=await f.ui('known text needle');a.equal(value.results.length,1);a.equal(value.coverage.messages.unverifiedText,1);a.equal(value.coverage.complete,false);a.equal(value.scope.fullText,false);a.equal((await f.ui('nested unknown needle')).results.length,0);
});
test('null/empty legal text arrays are complete zero-text sources',async t=>{
 const f=await fx(t);await f.put('Empty',[row([]),{role:'assistant',id:'empty_null',content:null,blocks:[]}],{head:{title:'empty metadata needle'}});const value=await f.ui('empty metadata needle');a.equal(value.results.length,1);a.equal(value.coverage.complete,true);a.equal(value.coverage.messages.unverifiedText,0);
});
test('same-epoch legacy manifest stays pending and rebuilds rather than silently omitting new array sources',async t=>{
 const f=await fx(t);await f.put('LegacyManifest',[row([{type:'text',text:'legacy upgrade needle'}])]);await f.ui('legacy upgrade needle');const root=p.join(f.sessions,'_fulltext-index-v1','LegacyManifest'),file=p.join(root,'manifest.json'),value=JSON.parse(await fs.readFile(file,'utf8')),generation=value.generation;
 for(const shard of value.shards)await fs.unlink(p.join(root,generation+'.'+shard.ordinal+'.json'));delete value.format;delete value.normalizer;value.chunks=0;value.shards=[];await fs.writeFile(file,JSON.stringify(value));
 const{req,res}=f.request();await f.hooks.withUI(req,res,null,async()=>{const owner=vm.runInContext('sessionFullTextOwner',f.context),coverage=await owner.coverage();a.equal(coverage.pendingSessions,1);a.equal(coverage.indexedSessions,0);a.equal(coverage.complete,false);a.equal((await owner.search('legacy upgrade needle')).results.length,0);});
 const rebuilt=await f.ui('legacy upgrade needle');a.equal(rebuilt.results.length,1);a.equal(rebuilt.coverage.complete,true);const current=JSON.parse(await fs.readFile(file,'utf8'));a.equal(current.format,3);a.notEqual(current.generation,generation);
});
test('array edits after computation revoke the source proof and reordering never returns old field coordinates',async t=>{
 const f=await fx(t);await f.put('Edited',[row(['prefix',{type:'text',text:'obsoletecontentneedle'}])]);const{req,res}=f.request();let sent=0;await a.rejects(()=>f.hooks.withUI(req,res,null,async()=>{const value=await f.hooks.search('obsoletecontentneedle');await f.put('Edited',[row([{type:'text',text:'freshcontentneedle'},'prefix'])]);return f.hooks.emitUI(value,()=>sent++);}),error=>error.code==='session_search.source_changed');a.equal(sent,0);a.equal((await f.ui('obsoletecontentneedle')).results.length,0);const fresh=await f.ui('freshcontentneedle');a.equal(fresh.results[0].reference.source,'content.0.text');
});
test('array field projection receives full original text before secret boundary clipping',async t=>{
 const secret='sk-'+('A1b2c3d4'.repeat(15)),text='prefix '.repeat(1500)+secret+' protected array needle';let calls=0;const f=await fx(t,{privacy:'enhanced',observeProjectSource:async original=>{calls++;a.equal(original,text);}});await f.put('Protected',[row([{type:'text',text}])]);const result=await f.model('protected array needle'),serialized=JSON.stringify(result);a.equal(result.results.length,1);a.equal(result.results[0].reference.source,'content.0.text');a.equal(serialized.includes(secret),false);a.equal(serialized.includes(secret.slice(-40)),false);a.ok(calls>0);a.ok(serialized.length<32768);
});
test('encrypted array shards retain purpose-bound Store carriers and OFF never derives plaintext',async t=>{
 const f=await fx(t,{enabled:true});await f.put('EncryptedArray',[row([{type:'text',text:'encrypted array needle'}])]);a.equal((await f.ui('encrypted array needle')).results.length,1);const file=p.join(f.sessions,'_fulltext-index-v1','EncryptedArray','manifest.json'),bytes=await fs.readFile(file,'utf8');a.equal(bytes.includes('encrypted array needle'),false);a.equal(bytes.includes('"format":2'),false);await vm.runInContext('sessionFullTextOwner',f.context).invalidate('EncryptedArray');f.enable(false);f.changeConfig({workDataEncryptionV1:false});await a.rejects(()=>f.ui('encrypted array needle'),error=>['session_fulltext.source_policy_conflict','work_data_store.downgrade_refused'].includes(error.code));await a.rejects(()=>fs.stat(file),error=>error.code==='ENOENT');
});
test('unrecognized manifest payload version refuses without repair or a false complete result',async t=>{
 const f=await fx(t);await f.put('Future',[row('future format needle')]);await f.ui('future format needle');const file=p.join(f.sessions,'_fulltext-index-v1','Future','manifest.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.format=99;const bytes=JSON.stringify(value);await fs.writeFile(file,bytes);await a.rejects(()=>f.ui('future format needle'),error=>error.code==='session_fulltext.manifest_invalid');a.equal(await fs.readFile(file,'utf8'),bytes);
});
