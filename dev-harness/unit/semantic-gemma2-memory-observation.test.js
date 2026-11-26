'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{functionBlock,constBlock}=require('../lib/source-slice');
const source=name=>fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src',name),'utf8');
function setup(){const fakeToken=Object.freeze({});const c=vm.createContext({require,Buffer,Date,WeakRef,crypto,MemorySemanticHooks:{},SemanticRuntimeTransportProof:Object.freeze({snapshot:()=>fakeToken,verify:result=>({...result,vectors:result.vectors.map(v=>v.slice()),truncated:result.truncated?.slice()}) ,method:()=>fakeToken,isMethod:value=>value===fakeToken,lifecycle:()=>fakeToken})}),retrieval=source('06h-retrieval-index.js');vm.runInContext([constBlock(source('00-boot.js'),'SemanticFailurePolicy'),source('06h9-semantic-policy.js'),source('06ha-semantic-retrieval.js'),constBlock(retrieval,'RETRIEVAL_TEXT_CAP'),functionBlock(retrieval,'retrievalTerms'),source('06hc-memory-semantic.js'),functionBlock(source('10-context-governance.js'),'observationWindowAdmission')].join('\n'),c);const model=vm.runInContext('SemanticWindowPolicy.CONTRACT',c),calls=[];c.testRuntime={descriptor:()=>({modelId:model.modelId}),prepare:async()=>({available:true,policyReady:true,modelId:model.modelId,modelFingerprint:model.modelFingerprint,retrievalThresholds:{search:.70,automatic:null}}),encode:async(texts,opts)=>{calls.push({role:opts.role,texts:[...texts]});await opts.beforeEncode?.();return {ok:true,modelFingerprint:model.modelFingerprint,vectors:texts.map(text=>{const score=opts.role==='query'?1:/needle fact/.test(text)?.99:/accepted/.test(text)?.9:.1;return[score,Math.sqrt(1-score*score),...Array(766).fill(0)];})};}};const api=vm.runInContext('const scorer=SemanticRetrieval.create(testRuntime);let observationSemanticRetrieval=scorer;({MemorySemanticRecall,observationWindowAdmission,SemanticRetrieval,score:scorer.score});',c);return{c,api,calls,model};}
function memory(f,entries){return f.api.MemorySemanticRecall.create({fallback:()=>({entries,fillKeys:new Set()}),enabled:()=>true,budgetSafe:()=>true,lexical:(_r,q)=>entries.map(entry=>({entry,shared:entry.text.includes('needle')?1:0,score:1})),key:entry=>entry.id,text:entry=>entry.text,searchText:entry=>entry.text,descriptor:f.c.testRuntime.descriptor,score:f.api.score});}
const context=()=>({scopeId:'scope',check:async()=>{}});
test('actual memory Gemma2 global strongK bypass preserves lexical and never refills semantic winner',async()=>{const f=setup(),entries=[{id:'strong',memoryVersion:'1',text:'needle fact'},{id:'other',memoryVersion:'1',text:'accepted other text'}],r=await memory(f,entries).search(entries,'needle fact',5,{},context());a.deepEqual(Array.from(r.matched,e=>e.id),['strong']);a.equal(r.semantic.coverage.complete,true);a.equal(r.semantic.admissionPolicy,'embeddinggemma2-memory-distinct-k3-cos070-v1');});
test('actual memory weak header is independently admitted, rejected sibling not retained as match',async()=>{const f=setup(),entries=[{id:'good',memoryVersion:'1',text:'accepted needle subject'},{id:'bad',memoryVersion:'1',text:'needle unrelated'}],r=await memory(f,entries).search(entries,'needle fact',5,{},context());a.deepEqual(Array.from(r.matched,e=>e.id),['good']);a.equal(r.matches.has('bad'),false);a.equal(r.semantic.coverage.complete,true);});
test('actual memory authority denial after prepare preserves original falsy reason and sends no document',async()=>{const f=setup(),entries=[{id:'one',memoryVersion:'1',text:'accepted needle subject'}];let count=0,caught=Symbol();try{await memory(f,entries).search(entries,'needle fact',5,{}, {scopeId:'scope',check:async()=>{if(++count===2)throw 0;}});}catch(e){caught=e;}a.equal(caught,0);a.equal(f.calls.length,0);});
test('actual automatic memory uses existing candidates only and keeps rule membership with automatic:null',async()=>{const f=setup(),entries=[{id:'a',text:'needle subject'},{id:'b',text:'accepted needle subject'}],r=await memory(f,entries).rank(entries,'needle fact',2,{},context());a.deepEqual(new Set(Array.from(r.entries,e=>e.id)),new Set(['a','b']));a.equal(r.semantic.automaticCandidates,false);a.equal(r.semantic.mode,'rerank-only');});
function observationArgs(f,fragments,extra={}){return{scopeId:'observation:scope',deadline:Date.now()+1000,poolComplete:true,check:async()=>{},fieldText:row=>row.full,identity:row=>({sourceId:row.id,field:'tool.content',revision:'r',epoch:'e',sourceRevision:'sr'}),coordinates:row=>[row.start,row.start+row.text.length],order:row=>[row.id],identities:fragments.map(row=>[row.id,row.start]),...extra};}
test('actual observation helper raw snapshot obeys one globalK and independent weak windows',async()=>{const f=setup(),fragments=[{id:'A',start:0,text:'accepted needle subject',full:'accepted needle subject'},{id:'B',start:0,text:'needle unrelated',full:'needle unrelated'}],r=await f.api.observationWindowAdmission('needle fact',fragments,observationArgs(f,fragments));a.deepEqual(Array.from(r.scored.admission.accepted),[true,false]);a.equal(r.weak.get(r.keys[0]),true);a.equal(r.weak.get(r.keys[1]),false);a.equal(r.complete,true);});
test('actual committed-message helper never uses raw hidden ID for whole-field eligibility or encode',async()=>{const f=setup(),mask='[[RUYI_PVT:KEY:'+('a'.repeat(32))+']]',projected='accepted '+mask+' subject',fragments=[{id:'A',start:0,text:projected,full:projected,raw:'OP-12 private hidden value'}],r=await f.api.observationWindowAdmission('Decision OP-12',fragments,observationArgs(f,fragments,{geometry:'privacy-projected-v1'}));a.deepEqual(Array.from(r.scored.admission.accepted),[false]);a.ok(f.calls.every(call=>call.texts.every(text=>!text.includes('private hidden value'))));a.equal(r.complete,true);});
test('actual observation authority denial and falsy cancellation remain original and produce no inference',async()=>{for(const value of [0,false,'']){const f=setup(),fragments=[{id:'A',start:0,text:'accepted subject',full:'accepted subject'}],signal=new AbortController();signal.abort(value);let caught=Symbol();try{await f.api.observationWindowAdmission('needle fact',fragments,observationArgs(f,fragments,{signal:signal.signal}));}catch(e){caught=e;}a.equal(caught,value);a.equal(f.calls.length,0);}});

test('Gemma2 searches short memory headers beyond the first 64 without filling unrelated matches',async()=>{
  const f=setup();
  const entries=Array.from({length:90},(_,i)=>({id:'m'+i,memoryVersion:'1',text:'unrelated '+i}));
  entries[89].text='accepted needle subject';
  const result=await memory(f,entries).search(entries,'needle fact',128,{},context());
  a.deepEqual(Array.from(result.matched,entry=>entry.id),['m89']);
  a.equal(result.semantic.coverage.selectedHeaders,90);
  a.equal(result.semantic.coverage.complete,true);
});

test('Gemma2 explicit recall can return more than 64 individually matched memories',async()=>{
  const f=setup();
  const entries=Array.from({length:90},(_,i)=>({id:'m'+i,memoryVersion:'1',text:'needle fact '+i}));
  const result=await memory(f,entries).search(entries,'needle fact',85,{},context());
  a.equal(new Set(Array.from(result.matched,entry=>entry.id)).size,85);
  a.equal(result.semantic.coverage.complete,true);
});

test('explicit semantic memory search admits up to three different matching facts',async()=>{
  const f=setup(), entries=['accepted one','accepted two','accepted three','accepted four','unrelated'].map((text,i)=>({id:'m'+i,text,memoryVersion:'1'}));
  const r=await memory(f,entries).search(entries,'how to divide a rollout',8,{},context());
  a.deepEqual(Array.from(r.matched,e=>e.id),['m0','m1','m2']);
  a.equal(r.semantic.coverage.complete,true);
});

test('a named literal is checked on the visible field, while unlabelled acronyms can paraphrase',async()=>{
  const f=setup(),entries=['accepted light','accepted shipyard','accepted label: SHIP.'].map((text,i)=>({id:'d'+i,text,memoryVersion:'1'}));
  const search=query=>memory(f,entries).search(entries,query,8,{},context());
  for(const q of ['编号 SHIP','keyword:SHIP','标记：SHIP']){
    const r=await search(q);
    a.deepEqual(Array.from(r.matched,e=>e.id),['d2'],q);
  }
  a.equal((await search('how does HTTP work')).matched.length,3);
});
