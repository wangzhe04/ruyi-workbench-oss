'use strict';
// Real encrypted source + actual UI/PG/producer, immediate fake models only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {fixture}=require('./scalar-coverage-reuse-fixture.cjs'),{createTiming}=require('./scalar-producer-phase-timing.cjs');
const corpus=require('./calibration-fixture.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fp={modelFingerprint:'synthetic',templateFingerprint:'synthetic',runtimeFingerprint:'synthetic',policyFingerprint:'synthetic'};
async function run(reuse,directory){
  const timing=createTiming(),f=await fixture({reuse,enabled:true,privacy:'enhanced',researchDirectory:path.join(directory,reuse?'reuse':'baseline'),
    runtime:{prepare:async()=>({available:true,modelFingerprint:'synthetic'}),encode:async(texts,options)=>{await options.beforeEncode?.();return {ok:true,modelFingerprint:'synthetic',vectors:texts.map(()=>[1,0])};}},
    scalarHost:{prepare:async()=>({ok:true,...fp}),verify:async(_q,_s,options)=>{for(let n=0;n<4;n++)await options.beforeVerify();return {ok:true,...fp,score:.99,accepted:true};},stop:async()=>({workerExited:true,cleanupStatus:'observed'})}});
  f.context.ResearchProducerTiming=timing;const rows=[];
  try{
    for(let n=0;n<corpus.documents.length;n++)await f.put('CAL'+String(n).padStart(3,'0'),[{role:'user',id:'m1',content:corpus.documents[n].text}],{head:{title:'',summary:'',cwd:'',kind:'mission'}});
    await f.index.prepare(null);await f.ui('semantic index warmup');
    const chosen=corpus.queries.filter(q=>q.split==='train'&&q.kind==='positive');
    const queries=[chosen.find(q=>q.group==='en-zh'),chosen.find(q=>q.group==='exact-entity')];
    for(const query of queries)await f.ui(query.text);timing.reset();
    for(const query of queries){
      const start=performance.now(),value=await timing.withRequest(query.id,()=>f.ui(query.text));
      rows.push({queryId:query.id,elapsedMs:performance.now()-start,coverage:value.coverage,semantic:value.semantic,lexicalAdmission:value.lexicalAdmission,
        results:value.results.map(row=>({sessionId:row.sessionId,reference:row.reference,rankScore:row.rankScore}))});
    }
    return {reuse,rows,timing:timing.snapshot(),sourceSha256:f.sources.producer.transformedSha256,recipe:f.sources.producer.coverageReuseRecipe||null};
  }finally{await f.close();}
}
async function main(){
  const directory=path.resolve(process.argv[2]||'output/semantic-coverage-reuse-diagnostic-r1');fs.mkdirSync(directory,{recursive:false});
  const report={status:'SYNTHETIC_MODELS_ACTUAL_SOURCE_DIAGNOSTIC_NOT_QUALITY',nativeStarts:0,limitations:[
    'Timing labels are nested; inclusive times cannot be added. No native inference or formal latency qualification.',
    'Only final coverage can reuse the earlier scalar-precoverage proof; this does not increase scalar entry remaining budget.',
    'Same request only; original strict attachments0/generation/epoch/revision/sequence/authorizedEpoch predicate is unchanged.'],runs:[]};
  for(const reuse of [false,true])report.runs.push(await run(reuse,directory));
  report.samePublicResults=JSON.stringify(report.runs[0].rows.map(({results,coverage})=>({results,coverage})))===JSON.stringify(report.runs[1].rows.map(({results,coverage})=>({results,coverage})));
  report.bindings=['scalar-coverage-reuse-layout.cjs','scalar-coverage-reuse-fixture.cjs','scalar-producer-timing-layout.cjs','scalar-producer-phase-timing.cjs',path.basename(__filename)].map(file=>({file,sha256:hash(fs.readFileSync(path.join(__dirname,file)))}));
  const output=path.join(directory,'receipt.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,runs:report.runs.map(run=>({reuse:run.reuse,sourceSha256:run.sourceSha256,rows:run.rows,phases:run.timing.phases.filter(row=>row.key[1].startsWith('phase.')||row.key[1]==='host.scan')}))}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
