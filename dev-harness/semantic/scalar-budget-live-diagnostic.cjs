'use strict';
// Small synthetic live diagnostic; no quality dataset or production change.
// The shared 1s/2.5s budgets, all real guards and the transport stay unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {fixture}=require('./scalar-window-append-public-consumer-fixture.cjs');
const {wrapScalarHost}=require('./scalar-budget-trace-research.cjs');
const {complete}=require('./scalar-composite-live-development.cjs');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function digest(file){const h=crypto.createHash('sha256');for await(const part of fs.createReadStream(file))h.update(part);return h.digest('hex');}
const topics=['garden irrigation schedule','rail travel luggage','piano practice lesson','database backup restore','cooking tomato pasta','household budget savings'];
const queries=['garden watering details','railway journey planning','piano lesson progress','database restore steps','preparing a tomato meal','monthly household costs'];
async function run({directory,profile,testCorpus}) {
  if(!profile||!['native-research','synthetic-test'].includes(profile.kind)||!Array.isArray(profile.bindings))throw TypeError('diagnostic.invalid_profile');
  const native=profile.kind==='native-research';if(native&&profile.descriptor?.policyId!=='qwen-prior-evidence-global-k1-rank095-best-field-window-v2')throw Error('diagnostic.policy_mismatch');
  if(native&&testCorpus)throw Error('diagnostic.native_corpus_override');
  const usedTopics=testCorpus?.topics||topics,usedQueries=testCorpus?.queries||queries,documentCount=testCorpus?.documents||60;
  if(!Array.isArray(usedTopics)||!usedTopics.length||!Array.isArray(usedQueries)||!usedQueries.length||!Number.isSafeInteger(documentCount)||documentCount<1)throw Error('diagnostic.invalid_corpus');
  directory=path.resolve(directory);fs.mkdirSync(directory,{recursive:true});const output=path.join(directory,'receipt.json'),planFile=path.join(directory,'plan.json');
  if(fs.existsSync(output)||fs.existsSync(planFile))throw Error('Use a new immutable diagnostic directory.');
  const sourceFiles=['scalar-budget-live-diagnostic.cjs','scalar-budget-trace-research.cjs','scalar-window-append-public-consumer-fixture.cjs','scalar-window-append-live-layout.cjs','scalar-window-live-layout.cjs','scalar-window-producer-research-source.cjs','scalar-window-append-cache-research-source.cjs','scalar-window-policy-research.cjs','scalar-verifier-bridge-prototype.cjs','scalar-composite-live-development.cjs'].map(n=>path.join(__dirname,n));
  sourceFiles.push(...['02-session-store.js','03a-privacy-gateway.js','06ha-semantic-retrieval.js','13ap-session-fulltext-index.js','13as-session-fulltext-consumers.js'].map(n=>path.resolve('ruyi-workbench/app/src',n)));
  const bindings=[...sourceFiles.map(file=>({file,sha256:hash(fs.readFileSync(file))})),...profile.bindings];
  const plan={status:'PREDECLARED',scope:'60 synthetic short source fields, one fixed warmup and six distinct synthetic queries; no labels, no acceptance/v6 data',
    topics:usedTopics.length,documents:documentCount,queries:usedQueries.map(hash),semanticBudgetMs:1000,consumerBudgetMs:2500,maxPrewarm:64,bindings};
  fs.writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  const report={status:'RUNNING',planSha256:hash(fs.readFileSync(planFile)),bindings,prewarm:[],queries:[],limits:[
    'Timings are nested: do not add host, guard, HTTP and total request durations.',
    'Source guards and local inference stay active; instrumentation wraps but does not read HTTP bodies or headers.',
    'Single sequential request stream; global fetch trace cannot attribute unrelated concurrent HTTP calls.',
    'Synthetic diagnostics only, no quality, fixed performance or packaged application qualification.']};
  let f,failure,observations=[],coarseCalls=[];const scalar=wrapScalarHost(profile.scalarHost);
  const encoder={...profile.encoder,async encode(texts,options){
    const started=performance.now(),guards=[],original=options.beforeEncode;let result;
    try{result=await profile.encoder.encode(texts,{...options,beforeEncode:async()=>{const begin=performance.now();try{return await original?.();}finally{guards.push(performance.now()-begin);}}});return result;}
    finally{coarseCalls.push({role:options.role,texts:texts.length,elapsedMs:performance.now()-started,guards,ok:result?.ok===true,reason:result?.reason||null});}
  }};
  async function request(query){
    observations=[];const from=coarseCalls.length,start=performance.now();
    const result=await f.ui(query,null,({hooks})=>hooks.search(query,5)),elapsedMs=performance.now()-start,detail=observations.at(-1)?.detail;
    return {elapsedMs,complete:complete(result),coverage:result.coverage,semantic:result.semantic,lexicalAdmission:result.lexicalAdmission,
      resultCount:result.results?.length||0,coarse:coarseCalls.slice(from),scalar:scalar.takeBudgetTraces(),
      privateSummary:{candidateCount:detail?.globalCandidateCount??null,scalarPairs:detail?.scalarPairs??null,reason:detail?.reason??null}};
  }
  try{
    for(const item of bindings)if(await digest(item.file)!==item.sha256)throw Error('diagnostic.binding_changed');
    f=await fixture({enabled:true,privacy:'enhanced',runtime:encoder,scalarHost:scalar,observeSearch:(result,detail)=>observations.push({result,detail}),researchDirectory:path.join(directory,'source')});
    for(let n=0;n<documentCount;n++)await f.put('D'+String(n).padStart(3,'0'),[{role:'user',id:'m',content:'Synthetic note '+n+' '+usedTopics[n%usedTopics.length]}],{head:{title:'',summary:'',cwd:'',kind:'mission'}});
    await f.index.prepare(null);let begin=performance.now();const ready=await profile.encoder.prepare({budgetMs:20000,deadline:Date.now()+20000});report.coarseReadyMs=performance.now()-begin;
    if(!ready.available)throw Error('coarse preparation failed');begin=performance.now();const rank=await scalar.prepare({deadline:Date.now()+20000});report.scalarReadyMs=performance.now()-begin;
    if(!rank.ok)throw Error('scalar preparation failed');
    for(let n=0;n<64;n++){const row=await request('synthetic warmup purpose');report.prewarm.push(row);if(row.complete)break;}
    if(!report.prewarm.at(-1)?.complete)throw Error('diagnostic.prewarm_incomplete');
    for(const query of usedQueries)report.queries.push(await request(query));
    report.bindingsStable=true;for(const item of bindings)if(await digest(item.file)!==item.sha256)report.bindingsStable=false;
    if(!report.bindingsStable)throw Error('diagnostic.binding_drift');
    report.status='COMPLETE_DIAGNOSTIC_NOT_QUALITY';
  }catch(error){failure=error;report.status='FAIL_DIAGNOSTIC';report.error=String(error?.stack||error);}
  finally{
    const values=await Promise.allSettled([Promise.resolve().then(()=>profile.encoder.stop('diagnostic-stop')),Promise.resolve().then(()=>scalar.stop())]);
    report.cleanup=Object.fromEntries(['coarse','scalar'].map((role,n)=>[role,values[n].status==='fulfilled'?values[n].value:{workerExited:false,error:String(values[n].reason)}]));
    report.allWorkersObservedExited=['coarse','scalar'].every(role=>report.cleanup[role].workerExited===true&&report.cleanup[role].cleanupStatus==='observed');
    if(f){try{if(report.allWorkersObservedExited)await f.close();else{f.master.fill(0);report.retainedFixtureDirectory=f.directory;}}catch(error){failure=error;report.status='FAIL_FIXTURE_CLEANUP';}}
    if(!report.allWorkersObservedExited)report.status='FAIL_UNCONFIRMED_WORKER_EXIT';
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({output,status:report.status,prewarm:report.prewarm.length,queries:report.queries.length,error:report.error}));
  return {report,failed:!!failure||!report.allWorkersObservedExited};
}
async function main(){const dir=process.argv[2],file=process.argv[3]&&path.resolve(process.argv[3]),pin=process.argv[4];
  if(!dir||!file||!/^[a-f0-9]{64}$/.test(pin||'')||hash(fs.readFileSync(file))!==pin)throw Error('Usage: <new-dir> <profile> <sha256>');
  const profile=require(file).create();profile.bindings=[...profile.bindings,{file,sha256:pin}];const value=await run({directory:dir,profile});if(value.failed)process.exitCode=1;}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
