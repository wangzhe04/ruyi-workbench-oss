'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {fixture,actual}=require('../lib/fulltext-consumer-fixture');
async function setup(t){const f=await fixture();t.after(()=>f.close());let mode='ready',mutate=null;
 // 2C 复审应改 2:冻结夹具时钟(同 semantic-gemma2-consumers),负载下 1 s 语义预算不再被机器吃光、把「Reject」误判成未评分。
 const now=Date.now();f.context.Date=class extends Date{static now(){return now;}};
 const api=vm.runInContext(actual('06ha-semantic-retrieval.js')+'\nSemanticRetrieval;',f.context);
 Object.assign(f.context,{SemanticRetrieval:api,SemanticRuntimeHooks:{prepare:async()=>mode==='disabled'?{available:false,reason:'disabled'}:{available:true,modelId:'metadata-fake',modelFingerprint:'metadata-fake-v1',retrievalThresholds:{search:.44}},encode:async(texts,options)=>{if(mode==='timeout')return{ok:false,reason:'timeout'};if(options.role==='document'&&mutate){const fn=mutate;mutate=null;await fn();}await options.beforeEncode?.();return{ok:true,modelFingerprint:'metadata-fake-v1',vectors:texts.map(text=>options.role==='query'||text.includes('accepted')?[1,0]:[0,1])};}}});
 return{f,setMode:value=>mode=value,setMutate:fn=>mutate=fn};}
test('metadata weak field uses its own semantic evidence and preserves strong/fallback',async t=>{const {f,setMode}=await setup(t);for(const [id,title]of [['Reject','cedar unrelated'],['Accept','cedar accepted'],['Strong','cedar violet']])await f.put(id,[{role:'user',id:'m',content:'ordinary material'}],{head:{title}});
 const full=await f.ui('cedar violet'),ids=full.results.map(row=>row.id);assert.ok(ids.includes('Strong'));assert.ok(ids.includes('Accept'));assert.ok(!ids.includes('Reject'));assert.equal(full.lexicalAdmission.partial,false);
 setMode('disabled');const partial=await f.ui('cedar violet');assert.ok(partial.results.some(row=>row.id==='Reject'));assert.equal(partial.lexicalAdmission.partial,true);
});
test('metadata scoring refuses owner rewrite during inference',async t=>{const {f,setMutate}=await setup(t);await f.put('Mutable',[{role:'user',id:'m',content:'ordinary material'}],{head:{title:'cedar unrelated'}});setMutate(()=>f.put('Mutable',[{role:'user',id:'m',content:'ordinary material'}],{head:{title:'cedar revised'}}));await assert.rejects(f.ui('cedar violet'),error=>/source_changed/.test(error.code));});
test('metadata scoring timeout remains lexical fallback and explicit partial',async t=>{const {f,setMode}=await setup(t);await f.put('Slow',[{role:'user',id:'m',content:'ordinary material'}],{head:{title:'cedar unrelated'}});setMode('timeout');const result=await f.ui('cedar violet');assert.ok(result.results.some(row=>row.id==='Slow'));assert.equal(result.lexicalAdmission.partial,true);});

test('oversized metadata is not treated as fully scored rejection',async t=>{const {f}=await setup(t);await f.put('Long',[{role:'user',id:'m',content:'ordinary material'}],{head:{title:'cedar '+ 'x'.repeat(8300)}});const result=await f.ui('cedar violet');assert.ok(result.results.some(row=>row.id==='Long'));assert.equal(result.lexicalAdmission.partial,true);});

test('metadata and message decisions never borrow one another by session id',async t=>{const {f}=await setup(t);await f.put('Mixed',[{role:'user',id:'m',content:'accepted message unrelated'}],{head:{title:'cedar unrelated'}});const value=await f.ui('cedar violet');const row=value.results.find(x=>x.id==='Mixed');assert.ok(row);assert.ok(row.reference,'accepted message remains its own cited hit');assert.notEqual(row.snippet,'cedar unrelated','rejected metadata is not admitted by the message vector');});
