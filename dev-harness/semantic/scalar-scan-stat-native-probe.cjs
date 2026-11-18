'use strict';
// Diagnostic only: real60 development sources and three fixed train queries.
// No vectors/scalars, acceptance data, quality fitting, or quality retries.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {fixture}=require('./scalar-scan-stat-fixture.cjs'),{createTiming}=require('./scalar-producer-phase-timing.cjs');
const {wrapScalarHost}=require('./scalar-budget-trace-research.cjs'),{complete}=require('./scalar-composite-live-development.cjs');
const corpus=require('./calibration-fixture.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function digest(file){const h=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))h.update(bytes);return h.digest('hex');}
async function run(directory,profile,profileBinding){
  if(profile.kind!=='native-research'||profile.descriptor?.policyId!=='qwen-prior-evidence-global-k1-rank095-best-field-window-v2')throw Error('probe.profile_contract');
  directory=path.resolve(directory);fs.mkdirSync(directory,{recursive:false});
  const files=['scalar-scan-stat-native-probe.cjs','scalar-scan-stat-layout.cjs','scalar-scan-stat-source.cjs','scalar-scan-stat-witness.cjs','scalar-scan-stat-fixture.cjs','scalar-producer-timing-layout.cjs','scalar-producer-phase-timing.cjs','scalar-coverage-reuse-layout.cjs','scalar-budget-trace-research.cjs','calibration-fixture.cjs'];
  const bindings=[...files.map(file=>({file:path.join(__dirname,file),sha256:hash(fs.readFileSync(path.join(__dirname,file)))})),...profile.bindings,profileBinding];
  const queries=['zh-zh','en-zh','exact-entity'].map(group=>corpus.queries.find(q=>q.split==='train'&&q.kind==='positive'&&q.group===group));if(queries.some(q=>!q))throw Error('probe.train_query_missing');
  const report={status:'PREDECLARED_REAL_DEVELOPMENT_DIAGNOSTIC',bindings,queries:[],prewarm:[],queryIds:queries.map(q=>q.id),limits:{semanticMs:1000,consumerMs:2500,coldPrepareMs:20000,maxPrewarm:64,queryAttempts:1},qualityQualification:false};
  fs.writeFileSync(path.join(directory,'plan.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const timing=createTiming(),scalar=wrapScalarHost(profile.scalarHost),coarseCalls=[];let f,failed=false;
  const encoder={...profile.encoder,encode:async(texts,opts)=>{const begin=performance.now();let result;try{result=await profile.encoder.encode(texts,opts);return result;}finally{coarseCalls.push({role:opts.role,texts:texts.length,elapsedMs:performance.now()-begin,ok:result?.ok===true,reason:result?.reason??null});}}};
  async function request(id,text){const from=coarseCalls.length;timing.reset();const started=performance.now(),value=await timing.withRequest(id,()=>f.ui(text,null,({hooks})=>hooks.search(text,5)));
    return {id,elapsedMs:performance.now()-started,complete:complete(value),coverage:value.coverage,semantic:value.semantic,lexicalAdmission:value.lexicalAdmission,resultCount:value.results.length,
      references:value.results.map(row=>row.reference),coarse:coarseCalls.slice(from),scalar:scalar.takeBudgetTraces(),timing:timing.snapshot()};}
  try{
    for(const item of bindings)if(await digest(item.file)!==item.sha256)throw Error('probe.binding_changed');
    f=await fixture({enabled:true,privacy:'enhanced',runtime:encoder,scalarHost:scalar,researchDirectory:path.join(directory,'source')});f.context.ResearchProducerTiming=timing;
    report.sourceContract={producerSha256:f.sources.producer.transformedSha256,consumerSha256:f.sources.consumer.transformedSha256,ownerSha256:f.sourceWitnessRecipe.ownerSha256,witnessSha256:f.sourceWitnessRecipe.witnessSha256};
    for(let n=0;n<corpus.documents.length;n++)await f.put('CAL'+String(n).padStart(3,'0'),[{role:'user',id:'m1',content:corpus.documents[n].text}],{head:{title:'',summary:'',cwd:'',kind:'mission'}});
    await f.index.prepare(null);
    let begin=performance.now();const coarseReady=await encoder.prepare({budgetMs:20000,deadline:Date.now()+20000});report.coarseColdMs=performance.now()-begin;if(!coarseReady.available)throw Error('probe.coarse_not_ready');
    begin=performance.now();const scalarReady=await scalar.prepare({deadline:Date.now()+20000});report.scalarColdMs=performance.now()-begin;if(!scalarReady.ok)throw Error('probe.scalar_not_ready');
    for(let n=0;n<64;n++){const row=await request('constant-prewarm-'+n,'semantic source coverage warmup');report.prewarm.push(row);if(row.complete)break;}
    if(!report.prewarm.at(-1)?.complete)throw Error('probe.prewarm_incomplete');
    for(const query of queries)report.queries.push(await request(query.id,query.text));
    report.bindingsStable=true;for(const item of bindings)if(await digest(item.file)!==item.sha256)report.bindingsStable=false;
    if(!report.bindingsStable)throw Error('probe.binding_drift');report.status='COMPLETE_DIAGNOSTIC_NOT_QUALITY';
  }catch(error){failed=true;report.status='FAILED_DIAGNOSTIC';report.error=String(error?.stack||error);}
  finally{
    const exited=await Promise.allSettled([Promise.resolve().then(()=>profile.encoder.stop('scan-stat-probe')),Promise.resolve().then(()=>scalar.stop())]);
    report.cleanup=Object.fromEntries(['coarse','scalar'].map((role,n)=>[role,exited[n].status==='fulfilled'?exited[n].value:{workerExited:false,error:String(exited[n].reason)}]));
    report.allWorkersObservedExited=Object.values(report.cleanup).every(value=>value.workerExited===true&&value.cleanupStatus==='observed');
    if(!report.allWorkersObservedExited)report.status='FAILED_UNCONFIRMED_EXIT';
    if(f){try{if(report.allWorkersObservedExited)await f.close();else{f.master.fill(0);report.retainedFixture=f.directory;}}catch(error){failed=true;report.fixtureCleanupError=String(error?.stack||error);if(report.allWorkersObservedExited)report.status='FAILED_FIXTURE_CLEANUP';}}
    fs.writeFileSync(path.join(directory,'receipt.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  return {report,failed:failed||!report.allWorkersObservedExited};
}
async function main(){const [directory,file,pin]=process.argv.slice(2);if(!directory||!file||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('Usage: <new-directory> <profile-path> <sha256>');
  const profilePath=path.resolve(file);if(await digest(profilePath)!==pin)throw Error('probe.profile_hash');const profile=require(profilePath).create();
  const value=await run(directory,profile,{file:profilePath,sha256:pin});console.log(JSON.stringify({status:value.report.status,output:path.resolve(directory,'receipt.json'),prewarm:value.report.prewarm.length,queries:value.report.queries.length,allWorkersObservedExited:value.report.allWorkersObservedExited}));if(value.failed)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
