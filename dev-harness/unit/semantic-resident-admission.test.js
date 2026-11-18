'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');
const api=vm.runInNewContext(source+'\nSemanticRetrieval;',{require,Buffer,Date,setTimeout,clearTimeout});
const descriptor={available:true,modelId:'resident-test',modelFingerprint:'resident-same-model',retrievalThresholds:{search:.7,automatic:null}};
const vectors=texts=>({ok:true,modelFingerprint:descriptor.modelFingerprint,vectors:texts.map(()=>[1,0])});
async function rejection(p){try{await p;assert.fail('expected rejection');}catch(error){return error;}}
test('warming remains loading to search callers while source guards still run',async()=>{
 let guards=0,encodes=0;const semantic=api.create({prepare:async()=>({available:false,reason:'unavailable',state:'warming'}),encode:async()=>{encodes++;}});
 const value=await semantic.score('query',['source'],{scopeId:'A',beforeEncode:async()=>{guards++;}});
 assert.equal(value.status,'loading');assert.equal(value.coverage.complete,false);assert.equal(value.scores[0],null);assert.equal(guards,1);assert.equal(encodes,0);
 const denied=Object.assign(Error('denied'),{code:'privacy.denied'});
 assert.equal(await rejection(semantic.score('query',['source'],{scopeId:'A',beforeEncode:async()=>{throw denied;}})),denied);
});
test('falsy cancellation after prepare and source resolution is preserved without user text writes',async()=>{
 for(const reason of [0,false,''])for(const phase of ['prepare','source']){
  const abort=new AbortController();let documentCalls=0;
  const semantic=api.create({prepare:async()=>{if(phase==='prepare')abort.abort(reason);return descriptor;},encode:async(texts,options)=>{if(options.role==='document')documentCalls++;return vectors(texts);}});
  assert.equal(await rejection(semantic.score('query',['metadata'],{scopeId:'A',signal:abort.signal,resolveTexts:async()=>{abort.abort(reason);return ['private source'];}})),reason);
  assert.equal(documentCalls,0);
 }
});
test('falsy cancellation after inference rejects and never caches its output',async()=>{
 for(const reason of [0,false,'']){
  const abort=new AbortController();let calls=0,cancel=true;
  const semantic=api.create({prepare:async()=>descriptor,encode:async texts=>{calls++;if(cancel){cancel=false;abort.abort(reason);}return vectors(texts);}});
  assert.equal(await rejection(semantic.score('query',['source'],{scopeId:'A',signal:abort.signal})),reason);
  const value=await semantic.score('query',['source'],{scopeId:'A'});
  assert.equal(value.coverage.complete,true);assert.equal(calls,3,'query must be encoded again before the document');
 }
});
test('lifecycle invalidation fences pending output and re-encodes after same-model re-enable',async()=>{
 let registered,release,entered;const encoding=new Promise(resolve=>entered=resolve);let pause=true,queries=0,documents=0;
 const semantic=api.create({registerCache:clear=>{registered=clear;},prepare:async()=>descriptor,encode:async(texts,options)=>{if(options.role==='query')queries++;else{documents++;if(pause){pause=false;entered();await new Promise(resolve=>release=resolve);}}return vectors(texts);}});
 assert.equal(typeof registered,'function');
 const pending=semantic.score('query',['source'],{scopeId:'A',identities:['same-source']});await encoding;
 registered();release();const stale=await pending;
 assert.equal(stale.status,'unavailable');assert.equal(stale.coverage.complete,false);assert.equal(stale.scores[0],null);
 const fresh=await semantic.score('query',['source'],{scopeId:'A',identities:['same-source']});
 assert.equal(fresh.coverage.complete,true);assert.equal(queries,2);assert.equal(documents,2);
});
test('source error still wins if lifecycle is invalidated during its final guard',async()=>{
 let clear;const failure=Object.assign(Error('source revoked'),{code:'privacy.denied'});
 const semantic=api.create({registerCache:fn=>{clear=fn;},prepare:async()=>descriptor,encode:async texts=>vectors(texts)});
 assert.equal(await rejection(semantic.score('query',['source'],{scopeId:'A',beforeEncode:async()=>{clear();throw failure;}})),failure);
});
test('an explicit new codec cannot silently replace the qualified retrieval policy',async()=>{
 let encodes=0,guards=0;
 const semantic=api.create({prepare:async()=>({...descriptor,modelId:'embeddinggemma-2-text-q4',retrievalThresholds:{search:.7,automatic:null}}),encode:async texts=>{encodes++;return vectors(texts);}});
 const value=await semantic.score('query',['source'],{scopeId:'A',beforeEncode:async()=>{guards++;}});
 assert.equal(value.status,'unavailable');assert.equal(value.coverage.complete,false);assert.equal(encodes,0);assert.equal(guards,1);
});
