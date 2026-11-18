'use strict';
// One-shot independent quality collection. Importing this module never loads
// the holdout. Its exact fixture is loaded only by an explicitly frozen run.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hashFile=file=>hash(fs.readFileSync(file));
const FIXTURE_SHA='b1a48d749af8977cc0fc655197aa1bcfb4e4c26c09e0637ab3361ecc55f447df';
const BASE_SHA='e6b152e79bf5f07f375d2a1f704a93e3de34ce6ce09cbe02bde57f6e3fda6ff1';
const baseFile=path.join(__dirname,'scalar-composite-live-development.cjs');
let source=fs.readFileSync(baseFile,'utf8');
if(hash(source)!==BASE_SHA)throw Error('v6.base_runner_changed');
function adaptFixture(raw){
  for(const name of ['documents','queries','noAnswer','unsupported','exact'])if(!Array.isArray(raw[name]))throw Error('v6.fixture_shape');
  return {documents:raw.documents,queries:[
    ...raw.queries.map(q=>({...q,split:'acceptance',kind:'positive'})),
    ...raw.noAnswer.map((text,n)=>({id:'v6-ood-'+n,text,split:'acceptance',kind:'ood',group:raw.noAnswerLabels?.[n]?.language||'ood',relevant:[]})),
    ...raw.unsupported.map((text,n)=>({id:'v6-missing-'+n,text,split:'acceptance',kind:'missing-field',group:'related-missing-fact',relevant:raw.unsupportedLabels?.[n]?.related||[]})),
    ...raw.exact.map(q=>({...q,split:'acceptance',kind:'exact',group:'exact'})),
  ]};
}
const recipe=[];
function one(before,after){if(source.split(before).length!==2)throw Error('v6.runner_boundary_changed: '+before.slice(0,50));source=source.replace(before,after);recipe.push({before,after});}
one("'calibration-fixture.cjs'","'acceptance-v6-fixture.cjs'");
one("'ce9cde6ac1ac5d44f838b2cba291398d047cfa0ff725646301eb4468e49f7c25'",JSON.stringify(FIXTURE_SHA));
one('const corpus = options.corpus || require(fixturePath);','const corpus = options.corpus || adaptV6Fixture(require(fixturePath));');
one("if (native && (options.corpus || corpus.releaseHoldout !== false))",'if (native && options.corpus)');
one("const queries = corpus.queries.filter(query => ['train', 'calibration'].includes(query.split));",'const queries = corpus.queries;');
one('corpus.documents.length !== 60 || queries.length !== 248','corpus.documents.length !== 80 || queries.length !== 184');
one("Object.fromEntries(['train', 'calibration'].map(split", "Object.fromEntries(['acceptance'].map(split");
one('Exact60 raw development fields','Exact80 raw independently frozen fields');
one('Development integration and coverage study, not independent acceptance or production/default adoption.',
  'Independent v6 quality collection through the source/public-consumer chain; not production/default adoption or the1000-fragment latency qualification.');
one("if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });",'');
source=source.replaceAll('COMPLETE_LIVE_DEVELOPMENT_NOT_ACCEPTANCE','COMPLETE_INDEPENDENT_V6_QUALITY_COLLECTION')
  .replaceAll('PARTIAL_LIVE_DEVELOPMENT_NOT_ACCEPTANCE','PARTIAL_INDEPENDENT_V6_QUALITY_COLLECTION');
const compiled=new Module(__filename,module);compiled.filename=__filename;compiled.paths=Module._nodeModulePaths(__dirname);
compiled._compile('const adaptV6Fixture='+adaptFixture.toString()+';\n'+source,__filename);
function qualify(report){
  const rows=report.rows||[],positive=rows.filter(r=>r.kind==='positive'),ood=rows.filter(r=>r.kind==='ood'),exact=rows.filter(r=>r.kind==='exact');
  const thresholds={chineseRecallAt5:.90,crossLanguageRecallAt5:.85,mrr:.75,pureOodFpr:.05};
  // Recompute from every prescribed raw row, independently of the collection
  // runner's aggregate. Incomplete empty OOD is unknown, never a true negative.
  const quality=values=>({count:values.length,recallAt5:values.length?values.filter(r=>r.rank>0&&r.rank<=5).length/values.length:null,
    mrr:values.length?values.reduce((n,r)=>n+(r.rank>0&&r.rank<=5?1/r.rank:0),0)/values.length:null});
  const metrics={quality:{all:quality(positive),groups:Object.fromEntries(['zh-zh','en-zh','zh-en','en-en'].map(group=>[group,quality(positive.filter(r=>r.group===group))]))},
    pureOod:{count:ood.length,conservativeFprUpperBound:ood.length?ood.filter(r=>(r.results?.length||0)>0||!r.complete).length/ood.length:null}};
  const collected=report.metrics?.acceptance;
  const checks={prescribedCohort:rows.length===184&&positive.length===80&&ood.length===80&&exact.length===8&&rows.filter(r=>r.kind==='missing-field').length===16,
    rawRowsValid:rows.every(r=>Array.isArray(r.results)&&Number.isSafeInteger(r.rank)&&r.rank>=0&&r.rank<=5&&r.rank<=r.results.length),
    metricsFinite:[metrics.quality.all.mrr,metrics.pureOod.conservativeFprUpperBound,...Object.values(metrics.quality.groups).map(g=>g.recallAt5)]
      .every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1),
    allCoverageComplete:report.coverageComplete===true&&rows.every(r=>r.complete),
    balancedDirections:['zh-zh','en-zh','zh-en','en-en'].every(group=>positive.filter(r=>r.group===group).length===20),
    chineseRecall:metrics?.quality?.groups?.['zh-zh']?.recallAt5>=thresholds.chineseRecallAt5,
    forwardCrossLanguageRecall:metrics?.quality?.groups?.['zh-en']?.recallAt5>=thresholds.crossLanguageRecallAt5,
    reverseCrossLanguageRecall:metrics?.quality?.groups?.['en-zh']?.recallAt5>=thresholds.crossLanguageRecallAt5,
    mrr:metrics?.quality?.all?.mrr>=thresholds.mrr,
    pureOod:metrics?.pureOod?.conservativeFprUpperBound<=thresholds.pureOodFpr,
    collectedMetricsAgree:collected?.quality?.all?.mrr===metrics.quality.all.mrr
      &&collected?.pureOod?.conservativeFprUpperBound===metrics.pureOod.conservativeFprUpperBound
      &&['zh-zh','en-zh','zh-en','en-en'].every(group=>collected?.quality?.groups?.[group]?.recallAt5===metrics.quality.groups[group].recallAt5),
    exactPreserved:exact.length===8&&exact.every(r=>r.rank>0&&r.rank<=5),
    sourceBindingsStable:report.bindingsStable===true,workersObservedExited:report.allWorkersObservedExited===true};
  return {thresholds,recomputedMetrics:metrics,checks,qualityGatePassed:Object.values(checks).every(Boolean),
    limits:['Related missing facts are diagnostic, not pure OOD or a promise that a search result answers the question.',
      'SR2 latency/resources and SR1/SR3-SR8 remain independently pending; this quality review cannot close them.']};
}
function assertBlindInputEligibility(){
  const registerFile=path.resolve(__dirname,'../../docs/optimization-plan/evidence/semantic-retrieval-20261116/holdout-exposure-register.json');
  const register=JSON.parse(fs.readFileSync(registerFile,'utf8'));
  const entry=register.events?.find(row=>row.fixture==='dev-harness/semantic/acceptance-v6-fixture.cjs'||row.fixtureSha256===FIXTURE_SHA);
  if(!entry||entry.blindFinalQualificationAllowed!==true)throw Error('v6.holdout_exposed_requires_new_fixture');
}
async function main(){
  // Reject before reading the actual fixture or creating the one-shot marker.
  assertBlindInputEligibility();
  const [directory,decisionPath,decisionSha]=process.argv.slice(2);
  if(!directory||!decisionPath||!/^[a-f0-9]{64}$/.test(decisionSha||'')||hashFile(decisionPath)!==decisionSha)throw Error('v6.requires_frozen_execution_decision');
  const decision=JSON.parse(fs.readFileSync(decisionPath,'utf8'));
  if(decision.allowedEvaluationCount!==1||decision.runnerSha256!==hashFile(__filename)||decision.fixtureSha256!==FIXTURE_SHA
    ||decision.profileSha256!==hashFile(decision.profileFile)||decision.developmentQualified!==true)throw Error('v6.execution_decision_mismatch');
  if(!Array.isArray(decision.bindings)||decision.bindings.length===0)throw Error('v6.execution_bindings_missing');
  if(hashFile(path.join(__dirname,'acceptance-v6-fixture.cjs'))!==FIXTURE_SHA)throw Error('v6.fixture_changed');
  const target=path.resolve(directory);
  if(fs.existsSync(target)&&(!fs.statSync(target).isDirectory()||fs.readdirSync(target).length>0))throw Error('v6.requires_fresh_output_directory');
  for(const item of decision.bindings)if(!/^[a-f0-9]{64}$/.test(item.sha256||'')||hashFile(item.file)!==item.sha256)throw Error('v6.execution_binding_changed');
  const marker=path.resolve('output/semantic-acceptance-v6/CONSUMED.json');fs.mkdirSync(path.dirname(marker),{recursive:true});
  fs.writeFileSync(marker,JSON.stringify({startedAt:new Date().toISOString(),decisionPath,decisionSha,fixtureSha256:FIXTURE_SHA,directory:path.resolve(directory)})+'\n',{flag:'wx'});
  const profile=require(path.resolve(decision.profileFile)).create();
  profile.bindings.push({file:__filename,sha256:hashFile(__filename)},{file:path.resolve(decisionPath),sha256:decisionSha});
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort(Error('research.cancelled')));process.once('SIGTERM',()=>controller.abort(Error('research.cancelled')));
  const result=await compiled.exports.run({directory,profile,controller});
  const review={schema:1,createdAt:new Date().toISOString(),report:result.output,reportSha256:hashFile(result.output),decisionSha256:decisionSha,...qualify(result.report)};
  const reviewFile=path.join(path.resolve(directory),'quality-review.json');fs.writeFileSync(reviewFile,JSON.stringify(review,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({reviewFile,qualityGatePassed:review.qualityGatePassed,checks:review.checks}));
  if(result.failed||!review.qualityGatePassed)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={adaptFixture,qualify,recipe,BASE_SHA,FIXTURE_SHA,assertBlindInputEligibility};
