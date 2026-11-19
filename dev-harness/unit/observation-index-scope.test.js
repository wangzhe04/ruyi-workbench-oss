'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {fixture}=require('../lib/fulltext-consumer-fixture');
test('observation index prepares only its own session without purging another index',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('Own',[{role:'user',id:'u',turnSeq:1,content:'own old needle'}]);await f.put('Other',[{role:'user',id:'v',turnSeq:1,content:'foreign secret needle'}]);
 const base=f.context.createSessionFullTextSource,accessed=[];f.context.createSessionFullTextSource=()=>{const source=base();return {...source,inspect:async id=>{accessed.push(id);return source.inspect(id);},scan:async(id,...args)=>{accessed.push(id);return source.scan(id,...args);}};};
 f.context.observationMainReadAllowed=ctx=>ctx?.mainTurn===true;await f.ui('foreign secret');const other=path.join(f.sessions,'_fulltext-index-v1','Other','manifest.json');assert.ok((await fs.stat(other)).isFile());await f.index.invalidate('Own',true);accessed.length=0;
 const ctx={session:{id:'Own',kind:'mission',turnSeq:1},sessionId:'Own',turnSeq:1,mainTurn:true};f.context.turnSettlers.set('Own',{});
 const result=await f.hooks.withObservation(ctx,()=>f.hooks.search('own old',5));assert.ok(result.results.some(hit=>hit.id==='Own'));assert.deepEqual([...new Set(accessed)],['Own']);assert.ok((await fs.stat(other)).isFile(),'single-session preparation must not purge other manifests');
 assert.throws(()=>f.hooks.withObservation({...ctx,mainTurn:false},()=>{}),/scope_required/);
});
test('session identity cannot change while the observation capability is being issued',async t=>{
 const f=await fixture();t.after(()=>f.close());f.context.observationMainReadAllowed=ctx=>ctx?.mainTurn===true;let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{entered=resolve;}),read=f.context.readConfig;
 f.context.readConfig=async()=>{entered();await blocked;return read();};const ctx={session:{id:'Own',kind:'mission',turnSeq:1},mainTurn:true};f.context.turnSettlers.set('Other',{});
 const pending=f.hooks.withObservation(ctx,()=>f.hooks.search('needle',5));await seen;ctx.session.id='Other';release();await assert.rejects(pending,{code:'session_search.destination_changed'});
});
test('empty-source coverage shortcut still refuses a source created before final disclosure',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('Empty',[]);await f.put('Visible',[{role:'user',id:'m',turnSeq:1,content:'visible needle'}]);
 const create=f.context.createSessionFullTextSource;let changed=false,armed=false;f.context.createSessionFullTextSource=()=>{const source=create();return {...source,epoch:async sid=>{const value=await source.epoch(sid);if(armed&&sid==='Empty'&&!changed){changed=true;await f.put('Empty',[{role:'user',id:'new',turnSeq:1,content:'new material'}]);}return value;}};};
 await f.ui('visible needle');armed=true;await assert.rejects(f.ui('visible needle'),error=>['session_search.source_changed','session_fulltext.disclosure_changed'].includes(error.code));assert.equal(changed,true);
});
// 151 阶段 2C:索引 revalidate 在「检索以来索引没被写过」时不再重读 manifest(mutationSerial 捷径),注入点从
// revalidate 里的 manifest 读挪到 revalidate 里仍然存在的那次源头 epoch 复核(命中来源逐个重读 epoch)。
// 断言的结局不变;mutated/retired 仍钉住注入确实发生。
const hookRevalidateEpoch=(f,armed,effect)=>{const create=f.context.createSessionFullTextSource;let fired=false;f.context.createSessionFullTextSource=()=>{const source=create();return {...source,epoch:async sid=>{const value=await source.epoch(sid);if(!fired&&armed()&&sid==='A'&&String(new Error().stack).includes('Object.revalidate')){fired=true;await effect();}return value;}};};return ()=>fired;};
test('external source rewrite during index revalidation cannot disclose a stale snippet',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('A',[{role:'user',id:'m',turnSeq:1,content:'needle old committed evidence'}]);
 const body=path.join(f.sessions,'A.messages.ndjson');let armed=false;
 const mutated=hookRevalidateEpoch(f,()=>armed,async()=>{const bytes=await fs.readFile(body,'utf8');await fs.writeFile(body,bytes.replace('needle old committed evidence','changed external evidence'));});
 await f.ui('needle');armed=true;
 await assert.rejects(f.ui('needle'),error=>/source_changed|disclosure_changed/.test(error.code||''));assert.equal(mutated(),true);
});
test('index retired during its own revalidation yields pending, not stale results',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('A',[{role:'user',id:'m',turnSeq:1,content:'needle old committed evidence'}]);let armed=false;
 const retired=hookRevalidateEpoch(f,()=>armed,async()=>{await require('node:vm').runInContext('sessionFullTextOwner',f.context).invalidate('A');});
 await f.ui('needle');armed=true;
 const result=await f.ui('needle');assert.equal(retired(),true);assert.equal(result.results.length,0);assert.equal(result.coverage.pendingSessions,1);
});
test('model and observation reject source or privacy policy changes while withPolicy exits',async t=>{
 const vm=require('node:vm'),{actual}=require('../lib/fulltext-consumer-fixture'),{functionBlock}=require('../lib/source-slice');
 for(const kind of ['model','observation'])for(const mutation of ['source','policy']){
  const f=await fixture({privacy:'enhanced',observeProjectSource:async()=>{}});t.after(()=>f.close());await f.put('A',[{role:'user',id:'m',turnSeq:1,content:'needle old committed evidence'}]);if(kind==='observation')vm.runInContext(functionBlock(actual('10-context-governance.js'),'observationMainReadAllowed'),f.context);
  const ctx={...f.ctx,session:{id:'A',kind:'mission',cwd:f.directory,turnSeq:1},sessionId:'A',turnSeq:1,mainTurn:true};f.context.turnSettlers.set('A',{});const invoke=()=>kind==='model'?f.model('needle'):f.hooks.withObservation(ctx,()=>f.hooks.search('needle',20));assert.equal((await invoke()).results.length,1);
  const original=f.privacy.withPolicy.bind(f.privacy),scope=kind==='model'?f.ctx.session.id:'A';let changed=false;f.privacy.withPolicy=(id,work)=>original(id,async()=>{const value=await work();if(id===scope&&value?.ok&&Array.isArray(value.results)&&!changed){changed=true;if(mutation==='source')await fs.writeFile(path.join(f.sessions,'A.messages.ndjson'),JSON.stringify({role:'user',id:'m',turnSeq:1,content:'replacement'})+'\n');else f.changeConfig({privacyModeV1:'strict'});}return value;});
  await assert.rejects(invoke(),error=>['session_search.source_changed','session_search.destination_changed','privacy.policy_changed'].includes(error.code));assert.equal(changed,true);
 }
});
test('model and observation cannot return retired citations when withPolicy exits',async t=>{
 const vm=require('node:vm'),{actual}=require('../lib/fulltext-consumer-fixture'),{functionBlock}=require('../lib/source-slice');
 for(const kind of ['model','observation']){
  const f=await fixture({privacy:'enhanced',observeProjectSource:async()=>{}});t.after(()=>f.close());await f.put('A',[{role:'user',id:'m',turnSeq:1,content:'needle old committed evidence'}]);if(kind==='observation')vm.runInContext(functionBlock(actual('10-context-governance.js'),'observationMainReadAllowed'),f.context);
  const ctx={...f.ctx,session:{id:'A',kind:'mission',cwd:f.directory,turnSeq:1},sessionId:'A',turnSeq:1,mainTurn:true};f.context.turnSettlers.set('A',{});const invoke=()=>kind==='model'?f.model('needle'):f.hooks.withObservation(ctx,()=>f.hooks.search('needle',20));assert.equal((await invoke()).results.length,1);
  const original=f.privacy.withPolicy.bind(f.privacy),scope=kind==='model'?f.ctx.session.id:'A';let retired=false;f.privacy.withPolicy=(id,work)=>original(id,async()=>{const value=await work();if(id===scope&&value?.ok&&Array.isArray(value.results)&&!retired){retired=true;await vm.runInContext('sessionFullTextOwner',f.context).invalidate('A');}return value;});
  let result;try{result=await invoke();}catch(error){assert.match(error.code||'',/changed/);}assert.equal(retired,true);if(result)assert.equal(result.results.length,0);
 }
});
