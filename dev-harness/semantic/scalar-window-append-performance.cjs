'use strict';
// Explicit 1000-fragment research benchmark. Full encrypted source, actual UI
// consumer and privacy gateway; no fixture vectors, no acceptance data, no
// production registration. This is an integration/performance study only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{performance}=require('node:perf_hooks');
const {fixture}=require('./scalar-window-append-public-consumer-fixture.cjs');
const {snapshot}=require('./scalar-live-memory-snapshot.cjs');
const {complete,classify}=require('./scalar-composite-live-development.cjs');
const repo=path.resolve(__dirname,'../..'), oldFixture=path.join(__dirname,'performance.cjs');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex'), fileHash=file=>hash(fs.readFileSync(file));
async function digest(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
const quantile=(arr,p)=>arr.length?arr.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(arr.length*p)-1)]:null;
function fixedFixture() {
  const old=fs.readFileSync(oldFixture,'utf8');
  if(hash(old)!=='ae19f03b437f4d78277d1316da0a3e50fcd7293143b21f5da5624dcdc2f8d924')throw Error('Original varied fixture source changed');
  const theme=old.match(/const themes=(\[[^\r\n]+\]);/),queries=old.match(/const queries=(\[[^\r\n]+\]);/);
  if(!theme||!queries)throw Error('Original varied fixture boundary changed');
  const themes=vm.runInNewContext(theme[1]),naturalQueries=vm.runInNewContext(queries[1]);
  if(themes.length!==25||naturalQueries.length!==30||new Set(naturalQueries).size!==30)throw Error('Original varied fixture cohort changed');
  return {documents:themes.map((value,n)=>({id:'P'+String(n).padStart(3,'0'),text:'Document '+n+' '+(value+' ').repeat(150).slice(0,3180)})),
    queries:Array.from(naturalQueries),originSha256:hash(old)};
}
const names=['scalar-window-append-performance.cjs','performance.cjs','scalar-window-append-public-consumer-fixture.cjs','scalar-window-append-live-layout.cjs',
  'scalar-window-public-consumer-fixture.cjs','scalar-window-live-layout.cjs','scalar-window-policy-research.cjs','scalar-window-producer-research-source.cjs',
  'scalar-window-consumer-research-source.cjs','scalar-window-append-cache-research-source.cjs','scalar-public-consumer-fixture.cjs','scalar-live-research-layout.cjs',
  'scalar-producer-research-source.cjs','scalar-composite-policy-research.cjs','scalar-consumer-research-source.cjs','scalar-consumer-live-research-source.cjs',
  'scalar-verifier-bridge-prototype.cjs','scalar-composite-live-development.cjs','scalar-live-memory-snapshot.cjs'];
const other=['dev-harness/lib/fulltext-consumer-fixture.js','dev-harness/lib/work-data-session-fulltext-fixture.js',
  'ruyi-workbench/app/src/02-session-store.js','ruyi-workbench/app/src/03a-privacy-gateway.js','ruyi-workbench/app/src/06ha-semantic-retrieval.js',
  'ruyi-workbench/app/src/13ap-session-fulltext-index.js','ruyi-workbench/app/src/13as-session-fulltext-consumers.js'];
function summarize(rows) {
  const ms=rows.map(row=>row.elapsedMs),completeRows=rows.filter(row=>row.complete);
  return {count:rows.length,complete:completeRows.length,partial:rows.length-completeRows.length,
    p50Ms:quantile(ms,.5),p95Ms:quantile(ms,.95),completeOnlyP95Ms:quantile(completeRows.map(row=>row.elapsedMs),.95),
    withResults:rows.filter(row=>row.resultCount>0).length,withWeakLexical:rows.filter(row=>row.classes.weakLexical>0).length,
    withSemanticOnly:rows.filter(row=>row.classes.semanticOnly>0).length,queryEncodeTexts:rows.reduce((sum,row)=>sum+row.calls.queryTexts,0),
    scalarInvocations:rows.reduce((sum,row)=>sum+row.calls.scalarVerifications,0),
    scalarRankWrites:rows.reduce((sum,row)=>sum+(row.calls.scalarRankWrites??0),0),
    scalarRankAccountingComplete:rows.every(row=>row.calls.scalarRankWrites!==null),
    withWeakWork:rows.filter(row=>row.privateSummary.weakWork>0).length,
    queryEncodedOnce:rows.filter(row=>row.calls.queryTexts===1).length,queryCacheHits:rows.filter(row=>row.calls.queryTexts===0).length };
}
async function run(options) {
  const directory=path.resolve(options.directory),profile=options.profile,native=profile?.kind==='native-research';
  if(!profile||!['native-research','synthetic-test'].includes(profile.kind)||!profile.encoder||!profile.scalarHost||!Array.isArray(profile.bindings))throw TypeError('Invalid profile');
  if(native&&(options.corpus||profile.descriptor?.policyId!=='qwen-prior-evidence-global-k1-rank095-best-field-window-v2'))throw Error('Native profile or corpus override invalid');
  const corpus=options.corpus||fixedFixture();
  if(!Array.isArray(corpus.documents)||!Array.isArray(corpus.queries)||!corpus.documents.length||!corpus.queries.length||new Set(corpus.queries).size!==corpus.queries.length)throw Error('Invalid distinct fixture');
  if(native&&(corpus.documents.length!==25||corpus.queries.length!==30))throw Error('Fixed workload mismatch');
  fs.mkdirSync(directory,{recursive:true});const output=path.join(directory,'receipt.json');if(fs.existsSync(output))throw Error('Use new immutable output directory');
  const paths=[...names.map(name=>path.join(__dirname,name)),...other.map(name=>path.join(repo,name))],bindings=[...paths.map(file=>({file,sha256:fileHash(file)})),...profile.bindings];
  const report={schema:1,status:'RUNNING',startedAt:new Date().toISOString(),bindings,profile:{id:profile.id,descriptor:profile.descriptor},
    contract:{source:'actual encrypted WorkData source + UI consumer + enhanced privacy gateway',docs:corpus.documents.length,naturalQueries:corpus.queries.length,
      measurement:'Every distinct natural query once with warm index and new query vector, then same queries in repeat group; no partial discarded.',
      queryBudgetMs:1000,consumerBudgetMs:2500,prewarmMaxRequests:512,queryEncodingTargetMs:150,endToEndP95TargetMs:500,
      queryThreshold:'query encoding call duration includes native tokenize and slot erase; not an end-to-end query latency.',
      memory:'same OS batch measures both current owned PIDs/creation identities; no independent process peaks are added.'},
    source:corpus.originSha256,phases:{},prewarm:[],fresh:[],repeat:[],memory:[],limitations:[
      'Synthetic encrypted corpus and fake key; real profile is local research, not a packaged application or release-quality evaluation.',
      'Prewarm query is distinct from all measured queries. New and repeated queries are reported separately, including incomplete responses.',
      'Memory samples occur outside timed queries and report paired current working sets/private bytes, not process peaks or exclusive RAM.',
      'Source, index read and privacy timings are nested and must not be added together.',
      'Actual scalar work depends on candidate admission and deadline; partial/no-result is not interpreted as a true negative.',
      'Foreground deadline is cooperative and source/security cleanup may exceed it; no hard wall-clock claim.' ]};
  const controller=options.controller||new AbortController(),signal=controller.signal;
  const aborted=()=>{if(signal.aborted)throw signal.reason===undefined?Error('research.cancelled'):signal.reason;};
  let f,observations=[],phase='setup',calls=[],expectedMemory=null,failure,measurements=null;
  const stats=()=>{const s=profile.scalarHost.stats();return {scalarVerifications:s.verified||0,scalarStarts:s.starts||0,scalarNative:s.nativeStats||null};};
  const encoder={...profile.encoder,async encode(texts,opts){const begin=performance.now();let result;
    try{result=await profile.encoder.encode(texts,opts);return result;}
    finally{calls.push({phase,role:opts.role,texts:texts.length,elapsedMs:performance.now()-begin,ok:result?.ok===true,completed:result?.ok?result.vectors.length:result?.completed||0});}}};
  async function sample(label){
    if(!native){report.memory.push({label,complete:false,reason:'synthetic-profile'});return;}
    const owned=profile.ownedIdentities();if(!owned.coarse||!owned.scalar){report.memory.push({label,complete:false,reason:'both-owned-identities-required'});return;}
    const rebound=!expectedMemory||['coarse','scalar'].some(role=>owned[role].pid!==expectedMemory[role].pid||owned[role].creationFileTime&&expectedMemory[role].creationFileTime&&String(owned[role].creationFileTime)!==String(expectedMemory[role].creationFileTime));
    if(rebound)expectedMemory=JSON.parse(JSON.stringify(owned));const value=await snapshot(expectedMemory,path.join(directory,'memory-home'));
    if(value.complete)for(const role of ['coarse','scalar'])if(!expectedMemory[role].creationFileTime)expectedMemory[role].creationFileTime=value.rows.find(row=>row.role===role).creationFileTime;
    report.memory.push({label,rebound,...value,nodeHarness:process.memoryUsage()});
  }
  async function request(query,label){
    aborted();phase=label;observations=[];measurements={scan:{calls:0,ms:0},inspect:{calls:0,ms:0},epoch:{calls:0,ms:0},privacy:{calls:0,ms:0},indexRead:{calls:0,ms:0}};
    const before=stats(),callStart=calls.length,begin=performance.now();
    const result=await f.ui(query,null,async({req,hooks})=>{const abort=()=>{req.aborted=true;req.emit('aborted');};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();try{return await hooks.search(query,5);}finally{signal.removeEventListener('abort',abort);}});
    const elapsedMs=performance.now()-begin;aborted();const after=stats(),detail=observations.at(-1)?.detail,sourceMeasurements=measurements;measurements=null;
    const kinds={strongLexical:0,weakLexical:0,semanticOnly:0};for(const hit of result.results||[]){const c=classify(hit,detail);for(const key of Object.keys(kinds))if(c[key])kinds[key]++;}
    const own=calls.slice(callStart),queryCalls=own.filter(call=>call.role==='query'),docCalls=own.filter(call=>call.role==='document');
    return {querySha256:hash(query),elapsedMs,complete:complete(result),coverage:result.coverage,semantic:result.semantic,lexicalAdmission:result.lexicalAdmission,
      resultCount:result.results?.length||0,classes:kinds,scalarReport:result.scalarResearch||null,
      calls:{queryTexts:queryCalls.reduce((n,row)=>n+row.texts,0),queryEncodeMs:queryCalls.map(row=>row.elapsedMs),documentTexts:docCalls.reduce((n,row)=>n+row.texts,0),
        scalarVerifications:after.scalarVerifications-before.scalarVerifications,
        scalarRankWrites:!after.scalarNative||!before.scalarNative||after.scalarStarts!==before.scalarStarts||((after.scalarNative.rankWrites||0)<(before.scalarNative.rankWrites||0))
          ?null:(after.scalarNative?.rankWrites||0)-(before.scalarNative?.rankWrites||0),
        scalarCacheHits:(detail?.scores||[]).filter(row=>row.cached).length},
      sourceMeasurements,privateSummary:{candidates:detail?.globalCandidateCount??null,coarseComplete:detail?.globalCoarseComplete??null,
        weakWork:(detail?.requiredWork||[]).filter(row=>row.role==='weak-lexical').length,scalarPairs:detail?.scalarPairs??null,reason:detail?.reason??null}};
  }
  try {
    let started=performance.now();for(const item of bindings)if(await digest(item.file)!==item.sha256)throw Error('binding changed: '+item.file);
    report.phases.bindingVerificationMs=performance.now()-started;
    const fixtureFactory=!native&&options.fixtureFactory?options.fixtureFactory:fixture;
    f=await fixtureFactory({enabled:true,privacy:'enhanced',runtime:encoder,scalarHost:profile.scalarHost,observeSearch:(result,detail)=>observations.push({result,detail}),researchDirectory:path.join(directory,'source')});
    // Durations are nested and must not be added: an index read may be inside a
    // source operation, and final privacy checks may include source checks.
    const store=f.context.WorkDataStore;f.context.WorkDataStore={...store,createText:options=>{const item=store.createText(options);return {...item,read:async(...args)=>{const start=performance.now();try{return await item.read(...args);}finally{if(measurements){measurements.indexRead.calls++;measurements.indexRead.ms+=performance.now()-start;}}}};}};
    const sourceFactory=f.context.createSessionFullTextSource;f.context.createSessionFullTextSource=()=>{const source=sourceFactory(),wrapped={...source};
      for(const name of ['scan','inspect','epoch'])wrapped[name]=async(...args)=>{const start=performance.now();try{return await source[name](...args);}finally{if(measurements){measurements[name].calls++;measurements[name].ms+=performance.now()-start;}}};return wrapped;};
    const privacy=f.context.PrivacyGateway,proxy={...privacy};for(const name of ['prepareLocalDisclosure','prepareDisclosure','prepareMultiSourceDisclosure','projectSource'])
      if(typeof privacy[name]==='function')proxy[name]=async(...args)=>{const start=performance.now();try{return await privacy[name](...args);}finally{if(measurements){measurements.privacy.calls++;measurements.privacy.ms+=performance.now()-start;}}};
    f.context.PrivacyGateway=proxy;
    started=performance.now();for(const doc of corpus.documents)await f.put(doc.id,[{role:'user',id:'m',turnSeq:1,content:doc.text}],{head:{title:'',summary:'',cwd:'',kind:'mission'}});
    report.phases.sourceCreateMs=performance.now()-started;started=performance.now();await f.index.prepare(null);report.phases.indexBuildMs=performance.now()-started;
    report.fixtureRecipe=f.fixtureRecipe;report.producerRecipe=f.sources.producer;report.consumerRecipe={...f.sources.consumer,source:undefined};
    started=performance.now();report.phases.coarseReady=await profile.encoder.prepare({deadline:Date.now()+20000,budgetMs:20000,signal});report.phases.coarseReadyMs=performance.now()-started;
    if(!report.phases.coarseReady.available)throw Error('coarse preparation failed');
    started=performance.now();report.phases.scalarReady=await profile.scalarHost.prepare({deadline:Date.now()+20000,signal});report.phases.scalarReadyMs=performance.now()-started;
    if(!report.phases.scalarReady.ok)throw Error('scalar preparation failed');await sample('both-ready');
    const warmQuery='distinct performance warmup phrase';if(corpus.queries.includes(warmQuery))throw Error('warmup overlaps measured query');
    started=performance.now();let warmed=false;const maxPrewarm=Number.isSafeInteger(options.prewarmMax)?Math.min(512,Math.max(1,options.prewarmMax)):512;
    for(let n=0;n<maxPrewarm;n++){const row=await request(warmQuery,'prewarm');report.prewarm.push(row);if(row.complete){warmed=true;break;}}
    report.phases.prewarmMs=performance.now()-started;report.phases.prewarmComplete=warmed;
    const candidateCount=report.prewarm.at(-1)?.semantic?.candidateFragments||0;report.phases.prewarmCandidates=candidateCount;
    if(!warmed||native&&candidateCount<1000)throw Error('prewarm incomplete or fewer than1000 fragments; no measured queries run');
    await sample('prewarm-complete');
    for(const q of corpus.queries)report.fresh.push(await request(q,'fresh'));
    await sample('fresh-finished');
    for(const q of corpus.queries)report.repeat.push(await request(q,'repeat'));
    await sample('repeat-finished');
    report.summary={fresh:summarize(report.fresh),repeat:summarize(report.repeat)};
    const queryEncodes=calls.filter(row=>row.phase==='fresh'&&row.role==='query').map(row=>row.elapsedMs);
    report.summary.freshQueryEncoding={calls:queryEncodes.length,p50Ms:quantile(queryEncodes,.5),p95Ms:quantile(queryEncodes,.95),
      atMost150Ms:queryEncodes.filter(ms=>ms<=150).length};
    report.bindingsStable=true;for(const item of bindings)if(await digest(item.file)!==item.sha256)report.bindingsStable=false;
    if(!report.bindingsStable)throw Error('source or asset binding drift');
    const allComplete=report.fresh.every(row=>row.complete)&&report.repeat.every(row=>row.complete);
    const workloadValid=report.summary.fresh.queryEncodedOnce===corpus.queries.length&&report.summary.repeat.queryCacheHits===corpus.queries.length
      &&(!native||[...report.fresh,...report.repeat].every(row=>(row.semantic?.candidateFragments||0)>=1000))
      &&report.summary.fresh.withResults===corpus.queries.length&&report.summary.repeat.withResults===corpus.queries.length
      &&report.summary.fresh.scalarRankAccountingComplete&&report.summary.repeat.scalarRankAccountingComplete
      &&report.summary.fresh.withWeakWork+report.summary.repeat.withWeakWork>0
      &&report.summary.fresh.scalarRankWrites+report.summary.repeat.scalarRankWrites>0;
    report.workloadValid=workloadValid;
    report.status=allComplete?'COMPLETE_RESEARCH_NOT_RELEASE':'PARTIAL_RESEARCH_NOT_RELEASE';
    report.queryEncodingTargetMet=queryEncodes.length===corpus.queries.length&&report.summary.freshQueryEncoding.p95Ms<=150;
    report.performanceTargetMet=allComplete&&workloadValid&&report.queryEncodingTargetMet&&report.summary.fresh.p95Ms<=500&&report.summary.repeat.p95Ms<=500;
  }catch(error){failure=error;report.status='FAIL_RESEARCH';report.error=String(error?.stack||error);}
  finally{
    report.encoderCalls=calls;const stopped=await Promise.allSettled([Promise.resolve().then(()=>profile.encoder.stop('research-stop')),Promise.resolve().then(()=>profile.scalarHost.stop())]);
    report.cleanup=Object.fromEntries(['coarse','scalar'].map((name,n)=>[name,stopped[n].status==='fulfilled'?stopped[n].value:{workerExited:false,error:String(stopped[n].reason)}]));
    const exited=['coarse','scalar'].every(name=>report.cleanup[name].workerExited===true&&report.cleanup[name].cleanupStatus==='observed');report.allWorkersObservedExited=exited;
    if(f){try{if(exited)await f.close();else{f.master.fill(0);report.retainedFixtureDirectory=f.directory;}}catch(error){report.status='FAIL_FIXTURE_CLEANUP';report.fixtureCleanupError=String(error);}}
    if(!exited)report.status='FAIL_UNCONFIRMED_WORKER_EXIT';report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({output,status:report.status,prewarm:report.prewarm.length,fresh:report.fresh.length,repeat:report.repeat.length,summary:report.summary,error:report.error}));
  return {report,output,failed:!!failure||report.status.startsWith('FAIL_')||!report.allWorkersObservedExited||(native&&!report.performanceTargetMet)};
}
async function main(){
  const directory=process.argv[2],modulePath=process.argv[3]&&path.resolve(process.argv[3]),pin=process.argv[4];
  if(!directory||!modulePath||!/^[a-f0-9]{64}$/.test(pin||'')||fileHash(modulePath)!==pin)throw Error('Usage: <new-dir> <locked-profile-module> <exact-sha256>');
  const profile=require(modulePath).create();profile.bindings=[...profile.bindings,{file:modulePath,sha256:pin}];
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort(Error('research.cancelled')));process.once('SIGTERM',()=>controller.abort(Error('research.cancelled')));
  const value=await run({directory,profile,controller});if(value.failed)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run,summarize,fixedFixture};
