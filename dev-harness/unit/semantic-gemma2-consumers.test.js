'use strict';
// Real encrypted-source/index/UI/PG consumers, synthetic768 encoder only.
// No model assets, quality fixture, or blind dataset is loaded by this file.
const {test}=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),{fixture,actual}=require('../lib/fulltext-consumer-fixture');
async function setup(t){
  const f=await fixture({enabled:true});
  t.after(()=>f.close());
  // These cases test source and DTO correctness. The fixture clock keeps encrypted
  // I/O and machine load from consuming the real consumer and encoder budgets.
  let now=Date.now();
  f.context.Date=class extends Date { static now(){return now;} };
  const fakeToken=Object.freeze({});let mode='ready';f.context.SemanticRuntimeTransportProof=Object.freeze({snapshot:()=>fakeToken,verify:result=>({...result,vectors:result.vectors.map(v=>v.slice()),truncated:result.truncated?.slice()}),method:()=>mode==='legacy'?null:fakeToken,isMethod:value=>mode!=='legacy'&&value===fakeToken,lifecycle:()=>fakeToken});vm.runInContext(actual('06h9-semantic-policy.js')+'\n'+actual('06ha-semantic-retrieval.js'),f.context);const MODEL=vm.runInContext('SemanticWindowPolicy.CONTRACT.modelFingerprint',f.context);let mutate=null,calls=0;const descriptor={available:true,policyReady:true,state:'ready',modelId:'embeddinggemma-2-text-q4',modelFingerprint:MODEL,retrievalThresholds:{search:.70,automatic:null}};f.context.SemanticRuntimeHooks={descriptor:()=>mode==='loading'?{available:false,state:'loading'}:descriptor,prepare:async()=>['loading','unavailable','missing','timeout'].includes(mode)?{available:false,reason:mode==='timeout'?'timeout':'unavailable',state:mode==='loading'?'loading':'failed'}:mode==='legacy'?{...descriptor,modelId:'legacy-fake',modelFingerprint:'legacy-fake'}:descriptor,encode:async(texts,opts)=>{calls+=texts.length;if(mode==='partial'&&opts.role==='document')return {ok:false,reason:'timeout'};await opts.beforeEncode?.();if(opts.role==='document'&&mutate){const callback=mutate;mutate=null;await callback();}return{ok:true,modelFingerprint:mode==='legacy'?'legacy-fake':MODEL,vectors:texts.map(text=>{const c=opts.role==='query'?1:/cedar violet/i.test(text)?.99:/accepted/i.test(text)?.9:.1;return[c,Math.sqrt(1-c*c),...Array(766).fill(0)];})};}};return{f,advance:ms=>{now+=ms;},setMode:value=>{mode=value;},calls:()=>calls,mutate:fn=>{mutate=fn;}};}
test('actual globalK1 strong body bypass never refills with another semantic field',async t=>{const {f}=await setup(t);await f.put('Strong',[{id:'m1',role:'user',content:'cedar violet'}],{head:{title:'ordinary title'}});await f.put('Other',[{id:'m2',role:'user',content:'accepted different topic'}],{head:{title:'other title'}});const value=await f.ui('cedar violet');a.deepEqual(Array.from(value.results,row=>row.id),['Strong']);a.ok(value.results[0].reference);a.equal(value.results[0].snippet,'cedar violet');a.equal(value.semantic.admission.policyId,'embeddinggemma2-global-eligible-k1-cos070-window-v1');});
test('actual metadata supplement displays admitted title, never unreviewed summary sibling',async t=>{const {f}=await setup(t);await f.put('A',[{id:'m',role:'user',content:'ordinary material'}],{head:{title:'accepted cedar title',summary:'cedar wrong summary'}});const value=await f.ui('cedar violet'),row=value.results.find(row=>row.id==='A');a.ok(row);a.equal(row.reference,null);a.equal(row.snippet,'accepted cedar title');a.notEqual(row.snippet,'cedar wrong summary');a.equal(row.matchKind,'metadata-context');});
test('actual weak body uses admitted96 window and preserves authenticated original coordinates',async t=>{const {f}=await setup(t);const body='x'.repeat(150)+' accepted cedar subject '+'y'.repeat(1800);await f.put('A',[{id:'m',role:'user',content:body}],{head:{title:'ordinary'}});const value=await f.ui('cedar violet'),row=value.results.find(row=>row.id==='A');a.ok(row?.reference);a.equal(row.reference.source,'content');a.equal(row.reference.matchEnd-row.reference.matchStart,96);a.ok(body.slice(row.reference.matchStart,row.reference.matchEnd).includes('accepted'));a.ok(row.snippet.includes('accepted'));a.ok(row.reference.snippetStart<=row.reference.matchStart);a.doesNotMatch(JSON.stringify(value),/sourceRevision|windowWitness|fieldWitness|encodedTexts/);});
test('actual source rewrite during vector inference refuses, never substitutes stale cached field',async t=>{const {f,mutate}=await setup(t);await f.put('A',[{id:'m',role:'user',content:'accepted cedar subject'}],{head:{title:'ordinary'}});mutate(()=>f.put('A',[{id:'m',role:'user',content:'replacement source'}],{head:{title:'ordinary'}}));await a.rejects(f.ui('cedar violet'),error=>/source_changed|disclosure_changed/.test(error.code||error.message));});
test('actual13g/13k mapped tool DTO preserves approved body reference and never emits a metadata-only snippet',async t=>{const {f}=await setup(t);await f.put('A',[{id:'m',role:'user',content:'accepted cedar subject'}],{head:{title:'ordinary title',kind:'mission',cwd:f.directory}});const entry=f.installEntrypoints(),body=await entry.threadHistorySearch({q:'cedar violet'},f.ctx);a.equal(body.results[0].reference.messageId,'m');a.match(body.results[0].snippet,/accepted/);await f.put('A',[{id:'m',role:'user',content:'ordinary text'}],{head:{title:'accepted cedar title',kind:'mission',cwd:f.directory}});const metadata=await entry.threadHistorySearch({q:'cedar violet'},f.ctx);a.equal(metadata.results[0].reference,undefined);a.equal(metadata.results[0].snippet,undefined);a.doesNotMatch(JSON.stringify(metadata),/sourceRevision|fieldWitness|encodedTexts/);});
test('actual13k mapping retains the private source capability through its last awaited projection',async t=>{const {f}=await setup(t);await f.put('A',[{id:'m',role:'user',content:'accepted cedar subject'}],{head:{title:'ordinary title',kind:'mission',cwd:f.directory}});const entry=f.installEntrypoints();f.context.getPretenderProjectionIndex=async()=>{await f.put('A',[{id:'m',role:'user',content:'replaced after search'}],{head:{title:'ordinary title',kind:'mission',cwd:f.directory}});return null;};await a.rejects(entry.threadHistorySearch({q:'cedar violet'},f.ctx),error=>/source_changed|disclosure_changed/.test(error.code||error.message));});
test('strong metadata belongs to the same coarse K pool and never refills to a lower body candidate',async t=>{const {f}=await setup(t);await f.put('Strong',[{id:'m1',role:'user',content:'ordinary'}],{head:{title:'cedar violet'}});await f.put('Other',[{id:'m2',role:'user',content:'accepted other subject'}],{head:{title:'ordinary'}});const value=await f.ui('cedar violet');a.deepEqual(Array.from(value.results,row=>row.id),['Strong']);a.equal(value.results[0].reference,null);a.equal(value.results[0].snippet,'cedar violet');a.ok(value.semantic.candidateFragments>=3);});
test('strong title does not promote sibling summary/gist/recent request into UI or mapped model context',async t=>{const {f}=await setup(t);await f.put('A',[{id:'m',role:'user',content:'ordinary'}],{head:{title:'cedar violet',summary:'cedar rejected context',threadBrief:{title:'identity label',gist:'cedar rejected gist'},recentUserRequest:{text:'UNREVIEWED REQUEST'},kind:'mission',cwd:f.directory}});const ui=await f.ui('cedar violet'),row=ui.results[0];a.equal(row.title,'cedar violet');a.equal(row.summary,'');a.equal(row.brief.gist,'');a.equal(row.briefGist,'');a.equal(row.recentUserRequest,undefined);a.doesNotMatch(JSON.stringify(ui),/rejected context|rejected gist|UNREVIEWED REQUEST/);const entry=f.installEntrypoints(),model=await entry.threadHistorySearch({q:'cedar violet'},f.ctx);a.equal(model.results[0].lastAssistantText,'');a.equal(model.results[0].brief.gist,'');a.equal(model.results[0].recentUserRequest,undefined);a.doesNotMatch(JSON.stringify(model),/rejected context|rejected gist|UNREVIEWED REQUEST/);});
test('selected Gemma2 loading/unavailable/timeout/partial never enters legacy weak metadata mode',async t=>{const {f,setMode}=await setup(t);await f.put('A',[],{head:{title:'cedar violet',summary:'cedar UNREVIEWED CONTEXT'}});await f.put('Weak',[],{head:{title:'cedar unrelated'}});for(const mode of ['loading','unavailable','missing','timeout','partial']){setMode(mode);const value=await f.ui('cedar violet');a.deepEqual(Array.from(value.results,row=>row.id),['A'],mode);a.equal(value.results[0].summary,'',mode);a.equal(value.semantic.coverage,'partial',mode);a.doesNotMatch(JSON.stringify(value),/UNREVIEWED CONTEXT/);}});
test('explicit legacy selection keeps its existing source metadata DTO contract',async t=>{const {f,setMode}=await setup(t);setMode('legacy');await f.put('A',[],{head:{title:'cedar violet',summary:'LEGACY CONTEXT'}});const value=await f.ui('cedar violet');a.equal(value.results[0].summary,'LEGACY CONTEXT');});

test('reads different original sources concurrently before submitting a Gemma2 document batch', async t => {
  const { f } = await setup(t);
  await f.put('A', [{ id: 'a', role: 'user', content: 'accepted alternative subject' }], { head: { title: 'First' } });
  await f.put('B', [{ id: 'b', role: 'user', content: 'unrelated material' }], { head: { title: 'Second' } });
  const runtime = f.context.SemanticRuntimeHooks;
  const encode = runtime.encode;
  let readingDocuments = false;
  let readers = 0;
  let peak = 0;
  runtime.encode = async (texts, options) => {
    readingDocuments = options.role === 'query';
    return encode(texts, options);
  };
  const source = f.api.source;
  f.context.createSessionFullTextSource = () => ({
    ...source,
    async scan(...args) {
      if (!readingDocuments) return source.scan(...args);
      readers++;
      peak = Math.max(peak, readers);
      try {
        await new Promise(resolve => setImmediate(resolve));
        return await source.scan(...args);
      } finally {
        readers--;
      }
    },
  });
  const result = await f.ui('cedar violet');
  a.equal(peak, 2, 'both authenticated source reads start before the first one resolves');
  a.equal(result.semantic.coverage, 'complete');
  a.deepEqual(Array.from(result.results, row => row.id), ['A']);
});

test('actual metadata planner distinguishes exactly256 eligible fields from257 before producer dispatch',async t=>{for(const extra of [false,true]){const {f}=await setup(t);for(let n=0;n<64;n++)await f.put('S'+n,[],{head:{title:'cedar title',summary:'cedar summary',threadBrief:{title:'cedar name',gist:'cedar gist'}}});if(extra)await f.put('Extra',[],{head:{title:'cedar extra'}});const original=f.context.SessionFullTextHooks.bindSessions,stop=Object.freeze({plannerProbe:true});let observed=null;f.context.SessionFullTextHooks.bindSessions=(...args)=>{const index=original(...args);return {...index,search:async(_q,_ctx,_limit,options)=>{observed={fields:options.metadataEntries.length,truncated:options.metadataEntriesTruncated,method:options.method};throw stop;}};};let caught;try{await f.ui('cedar violet');}catch(error){caught=error;}a.equal(caught,stop);a.equal(observed.fields,256);a.equal(observed.truncated,extra);a.ok(observed.method,'selected opaque method reaches producer independently of runtime state');}});
test('actual producer marks over256 metadata windows partial even when eligible field count is only4',async t=>{const {f,setMode}=await setup(t);setMode('loading');const long='cedar '+ 'x'.repeat(5990);await f.put('A',[],{head:{title:long,summary:long,threadBrief:{title:long,gist:long}}});const value=await f.ui('cedar violet');a.equal(value.semantic.candidateFragments,256);a.equal(value.semantic.truncated,true);a.equal(value.semantic.coverage,'partial');a.equal(value.results.length,0);});
test('strong summary is the admitted context; weak title/path remain source identification without a borrowed quote',async t=>{const {f}=await setup(t);await f.put('A',[],{head:{title:'cedar identifying label',summary:'cedar violet',threadBrief:{title:'cedar alternative label',gist:'cedar REJECTED GIST'},cwd:f.directory}});const value=await f.ui('cedar violet'),row=value.results[0];a.equal(row.snippet,'cedar violet');a.equal(row.summary,'cedar violet');a.equal(row.reference,null);a.equal(row.title,'cedar identifying label');a.equal(row.briefTitle,'cedar alternative label');a.equal(row.briefGist,'');a.notEqual(row.snippet,row.title);a.notEqual(row.snippet,row.cwd);});
test('actual13k index-disabled path uses selected field policy, never concatenated raw metadata fallback',async t=>{const {f}=await setup(t);f.changeConfig({sessionSearchIndexV1:false});await f.put('Cross',[],{head:{title:'needle',summary:'fact',kind:'mission',cwd:f.directory}});await f.put('Strong',[],{head:{title:'needle fact',summary:'UNREVIEWED CONTEXT',threadBrief:{title:'source label',gist:'UNREVIEWED GIST'},recentUserRequest:{text:'UNREVIEWED REQUEST'},kind:'mission',cwd:f.directory}});const entry=f.installEntrypoints(),value=await entry.threadHistorySearch({q:'needle fact'},f.ctx);a.deepEqual(Array.from(value.results,row=>row.sessionId),['Strong']);a.equal(value.degraded,'index_disabled');a.equal(value.results[0].lastAssistantText,'');a.equal(value.results[0].brief.gist,'');a.equal(value.results[0].recentUserRequest,undefined);a.equal(value.results[0].snippet,undefined);a.doesNotMatch(JSON.stringify(value),/UNREVIEWED/);});

async function finalAdmissionFixture(t, effect, atFinish=false) {
  const {f}=await setup(t);
  await f.put('Strong',[{id:'m',role:'user',content:'cedar violet'}],{
    head:{title:'cedar violet',summary:'UNREVIEWED CONTEXT'},
  });
  await f.put('Weak',[{id:'m',role:'user',content:atFinish?'accepted cedar material':'accepted semantic-only material'}],{
    head:{title:'ordinary'},
  });
  let clock=Date.now(), intercepted=false, crossedThisSearch=false;
  const startEpochs=new Set();
  f.context.Date=class extends Date { static now(){return clock;} };
  const bind=f.context.SessionFullTextHooks.bindSessions;
  f.context.SessionFullTextHooks.bindSessions=(...args)=>{
    const index=bind(...args);
    return {...index,search(...options) {
      crossedThisSearch=false;
      startEpochs.clear();
      return index.search(...options);
    }};
  };
  const source=f.api.source;
  f.context.createSessionFullTextSource=()=>({
    ...source,
    async epoch(...args) {
      // Intercept source I/O after the admission guard and before its revalidation returns.
      const stack=String(Error().stack);
      // 151 阶段 2(S8):窗口策略的权威回验从 beforeEncode 挪到同一处的 authoritative(start/finish 两次);两个名字都认。
      if(!crossedThisSearch&&/\b(?:beforeEncode|authoritative)\b/.test(stack)&&/\bbeforeVerify\b/.test(stack)) {
        if(atFinish && args[0]!=='Weak')return source.epoch(...args);
        if(atFinish && !startEpochs.has(args[0])){startEpochs.add(args[0]);return source.epoch(...args);}
        crossedThisSearch=true;
        intercepted=true;
        clock+=1001;
        await effect(f);
      }
      return source.epoch(...args);
    },
  });
  const {handleSessionApiRoutes}=f.installEntrypoints();
  const {req,res}=f.request();
  Object.assign(req,{method:'GET',url:'/api/sessions/search?q=cedar%20violet'});
  return {
    search:()=>handleSessionApiRoutes(req,res,'/api/sessions/search'),
    intercepted:()=>intercepted,
    emitted:()=>res.writableEnded,
  };
}

test('final Gemma2 source deadline returns partial admission without semantic-only results',async t=>{
  const {search,intercepted,emitted}=await finalAdmissionFixture(t,()=>{});
  const value=await search();
  a.equal(emitted(),true);
  a.equal(intercepted(),true);
  a.equal(value.ok,true);
  a.equal(value.semantic.status,'timeout');
  a.equal(value.semantic.coverage,'partial');
  a.equal(value.semantic.admission.status,'partial');
  a.deepEqual(Array.from(value.results,row=>row.id),['Strong']);
  a.equal(value.results[0].snippet,'cedar violet');
  a.doesNotMatch(JSON.stringify(value),/UNREVIEWED CONTEXT|semantic-only material|semanticSourceBudget/);
});

test('actual destination revocation wins over the final Gemma2 source deadline',async t=>{
  const {search,intercepted,emitted}=await finalAdmissionFixture(t,f=>{f.context.RUNTIME.token='revoked';});
  await a.rejects(search(),error=>/^(session_search\.destination_changed|fulltext_index\.disclosure_changed)$/.test(error.code));
  a.equal(intercepted(),true);
  a.equal(emitted(),false);
});

test('actual source rewrite wins over the final Gemma2 source deadline',async t=>{
  const {search,intercepted,emitted}=await finalAdmissionFixture(t,f=>f.put('Strong',[{id:'m',role:'user',content:'replaced'}],{
    head:{title:'replaced'},
  }));
  await a.rejects(search(),error=>/\.(source_changed|disclosure_changed)$/.test(error.code));
  a.equal(intercepted(),true);
  a.equal(emitted(),false);
});

test('a completed final encode at the slice deadline still returns its verified semantic hit',async t=>{
  const {f,mutate,advance}=await setup(t);
  await f.put('Match',[{id:'m',role:'user',content:'accepted unrelated wording'}]);
  mutate(()=>advance(1001));
  const result=await f.ui('cedar violet');
  a.deepEqual(Array.from(result.results,row=>row.id),['Match']);
  a.equal(result.results[0].matchMode,'semantic');
  a.equal(result.semantic.coverage,'complete');
  a.equal(result.semantic.status,'ready');
});

test('the outer request deadline still stops disclosure after a late encode',async t=>{
  const {f,mutate,advance}=await setup(t);
  await f.put('Match',[{id:'m',role:'user',content:'accepted unrelated wording'}]);
  mutate(()=>advance(16000));
  const result=await f.ui('cedar violet');
  a.equal(result.reason,'deadline');
  a.equal(result.results.length,0);
});

test('a partial scoring slice retains a fully scored lexical field only',async t=>{
  const {f,mutate,advance}=await setup(t);
  await f.put('A',[{role:'user',id:'known',content:'accepted cedar subject'}]);
  await f.put('B',[{role:'user',id:'pure',content:'accepted unrelated topic'}]);
  await f.put('C',[{role:'user',id:'incomplete',content:'accepted cedar '+ 'x'.repeat(400)}]);
  mutate(()=>advance(1001));
  const value=await f.ui('cedar violet');
  a.equal(value.semantic.coverage,'partial');
  a.equal(value.semantic.status,'timeout');
  a.equal(value.results.length,1);
  a.equal(value.results[0].reference.messageId,'known');
});

test('a semantic-only search finishes a progressing cold query in the same request',async t=>{
  const {f,mutate,advance,calls}=await setup(t);
  const messages=Array.from({length:6},(_,n)=>({
    id:'m'+n,role:'user',content:n===5?'accepted final evidence':'ordinary unrelated text '+n,
  }));
  await f.put('Match',messages);
  mutate(()=>advance(1001));
  const result=await f.ui('cedar violet');
  a.equal(result.semantic.coverage,'complete');
  a.equal(result.results[0].reference.messageId,'m5');
  a.equal(calls(),7,'the continuation reuses the query and the first four documents');
});

test('soft deadline during final epoch checks keeps the already validated lexical window',async t=>{
  const {search,intercepted}=await finalAdmissionFixture(t,()=>{},true);
  const result=await search();
  a.equal(intercepted(),true);
  a.equal(result.semantic.coverage,'partial');
  a.equal(result.results.find(row=>row.id==='Weak')?.reference?.messageId,'m');
});

test('slow singleton estimates and changing queries still advance the authorized document cache',async t=>{
  const {f,advance}=await setup(t);
  const runtime=f.context.SemanticRuntimeHooks,encode=runtime.encode,submitted=[];
  runtime.estimateEncodingBudget=(role,count)=>(role==='document'?3600:1200)*count;
  runtime.encode=async(texts,options)=>{
    const remaining=options.deadline-f.context.Date.now();
    a.ok(remaining>=runtime.estimateEncodingBudget(options.role,texts.length));
    if(options.role==='document'){
      a.equal(texts.length,1);
      submitted.push(texts[0]);
      advance(3100);
    }else advance(1100);
    return encode(texts,options);
  };
  const messages=Array.from({length:4},(_,n)=>({id:'m'+n,role:'user',content:'accepted document '+n}));
  await f.put('Match',messages);
  for(let n=0;n<messages.length;n++){
    const result=await f.ui('cedar violet '+String.fromCharCode(97+n));
    a.equal(result.semantic.cachedFragments,n+1);
    if(n===messages.length-1)a.equal(result.semantic.coverage,'complete');
  }
  a.deepEqual(submitted.slice().sort(),messages.map(row=>row.content).sort());
});

test('a busy resident worker and slow source scan can finish the first authorized fragment',async t=>{
  const {f,advance}=await setup(t);
  await f.put('Match',[{id:'m',role:'user',content:'accepted unrelated wording'}]);
  const runtime=f.context.SemanticRuntimeHooks,encode=runtime.encode,source=f.api.source;
  let scanPending=false,retries=0,slowReads=0;
  f.context.setTimeout=(callback,ms)=>{advance(ms);return setImmediate(callback);};
  runtime.encode=async(texts,options)=>{
    if(options.role==='query')scanPending=true;
    if(options.role==='document'&&retries++<10)return {ok:false,reason:'overloaded'};
    return encode(texts,options);
  };
  f.context.createSessionFullTextSource=()=>({...source,async scan(...args){
    if(scanPending){scanPending=false;slowReads++;advance(1250);}
    return source.scan(...args);
  }});
  const result=await f.ui('cedar violet');
  a.equal(slowReads,1);
  a.equal(retries,11);
  a.equal(result.semantic.coverage,'complete');
  a.deepEqual(Array.from(result.results,row=>row.id),['Match']);
});

test('a source that exhausts the first reservation gets enough time on the next request',async t=>{
  const {f,advance}=await setup(t);
  await f.put('Match',[{id:'m',role:'user',content:'accepted unrelated wording'}]);
  const runtime=f.context.SemanticRuntimeHooks,encode=runtime.encode,source=f.api.source;
  let scanPending=false,reads=0;
  runtime.encode=async(texts,options)=>{
    if(options.role==='query')scanPending=true;
    return encode(texts,options);
  };
  f.context.createSessionFullTextSource=()=>({...source,async scan(...args){
    if(scanPending){scanPending=false;reads++;advance(3500);}
    return source.scan(...args);
  }});
  const first=await f.ui('cedar violet');
  a.equal(first.semantic.cachedFragments,0);
  const next=await f.ui('cedar indigo');
  a.equal(reads,2);
  a.equal(next.semantic.coverage,'complete');
  a.deepEqual(Array.from(next.results,row=>row.id),['Match']);
});

test('a verified body window can supply a lexical or semantic snippet after one source scan',async t=>{
  const {f}=await setup(t);
  const text='accepted cedar violet with original spelling';
  await f.put('Match',[{id:'m',role:'user',content:text}]);
  const source=f.api.source;
  let scans=0;
  f.context.createSessionFullTextSource=()=>({...source,async scan(...args){scans++;return source.scan(...args);}});
  await f.ui('cedar violet');
  for(const query of ['cedar violet','unrelated query']){
    scans=0;
    const value=await f.ui(query);
    a.equal(value.results[0].snippet,text);
    a.equal(value.results[0].reference.messageId,'m');
    a.equal(scans,1);
  }
});

test('a rewrite between window admission and snippet reuse blocks disclosure',async t=>{
  const {f}=await setup(t);
  await f.put('Match',[{id:'m',role:'user',content:'cedar violet'}]);
  const source=f.api.source;
  let rewrite=true;
  f.context.createSessionFullTextSource=()=>({...source,async epoch(sid){
    if(rewrite&&sid==='Match'&&String(Error().stack).includes('verifySource')){
      rewrite=false;
      await f.put(sid,[{id:'m',role:'user',content:'replacement'}]);
    }
    return source.epoch(sid);
  }});
  await a.rejects(f.ui('cedar violet'),error=>/source_changed|disclosure_changed/.test(error.code));
  a.equal(rewrite,false);
});

test('continuation predicts completion from work done this slice, excluding earlier requests',async t=>{
  const {f,advance}=await setup(t);
  await f.put('Many',Array.from({length:40},(_,n)=>({role:'user',id:'m'+n,content:'ordinary subject '+n})));
  const runtime=f.context.SemanticRuntimeHooks,encode=runtime.encode;
  let batches=0,prior=0;
  runtime.encode=async(texts,options)=>{
    if(options.role==='document'){batches++;advance(1001);}
    return encode(texts,options);
  };
  for(let i=0;i<5;i++){
    batches=0;
    const result=await f.ui('cedar violet');
    a.equal(batches,1,'the remaining corpus requires more than the two available continuation slices');
    a.ok(result.semantic.cachedFragments>prior);
    prior=result.semantic.cachedFragments;
  }
});
