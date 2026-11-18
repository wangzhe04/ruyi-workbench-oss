'use strict';
// Opt-in developer study. Same pinned weights, documents, pooling and 1024dim;
// only the query instruction changes. No check or acceptance query is scored.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),original=require(fixturePath);
const fixture={...original,queries:original.queries.filter(q=>['train','calibration'].includes(q.split))};
const {metrics,qualityPasses}=require('./calibration-policy.cjs');
const {create,CONTRACT}=require('./qwen-research-adapter.cjs');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'output/semantic-qwen3-q4-research-v1');
const output=path.resolve(process.argv[2]||path.join(root,'output/semantic-qwen3-instruction-study-v1.json'));
if(fs.existsSync(output))throw Error('Use a new immutable study report');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const input=path.join(base,'vectors-v1.json'),encoded=JSON.parse(fs.readFileSync(input));
if(encoded.status!=='PASS'||encoded.fixtureSha256!==sha(fs.readFileSync(fixturePath)))throw Error('Vector/fixture provenance mismatch');
const allowed=new Set(fixture.queries.map(q=>q.id));
const docVectors=new Map(encoded.documents.map(d=>[d.id,d.vector]));
const oldQueries=new Map(encoded.queries.filter(q=>allowed.has(q.id)).map(q=>[q.id,q.vector]));
const candidates=[
 {id:'prior-evidence',task:'Given a user question, retrieve prior messages that contain evidence relevant to answering it'},
 {id:'explicit-evidence',task:'Given a question, retrieve passages containing explicit information needed to answer it, excluding unrelated or merely similar topics'},
];
const prefix=task=>'Instruct: '+task+'\nQuery:';
const client=create({root:base});
const report={schema:1,status:'RUNNING',createdAt:new Date().toISOString(),sourceSha256:sha(fs.readFileSync(__filename)),adapterSha256:sha(fs.readFileSync(path.join(__dirname,'qwen-research-adapter.cjs'))),fixtureSha256:encoded.fixtureSha256,originalVectorsSha256:sha(fs.readFileSync(input)),foundationFingerprint:encoded.ready.modelFingerprint,contract:CONTRACT,
 decision:'Two predeclared task-specific query prefixes; score train/cal only, fixed 45 thresholds .10...98 step.02 plus complete IDs. Require original language/MRR floors and pure OOD/entity mismatch<=.05 on BOTH splits. Rank lower worst OOD, higher cal MRR, higher score, shorter task. Do not select against check or any acceptance set.',
 queryInstructions:candidates,documents:fixture.documents.length,developmentQueries:fixture.queries.length,variants:[],limits:['No new model or dependency download; no production/default/threshold change.','Existing container includes check vectors, but only train/cal IDs enter this study.','Documents reuse real measured vectors from the identical weights/full encoding contract; new queries are real native inference.','Manual prefix uses document role solely to bypass the adapter fixed query prefix; a baseline sanity check verifies exact numerical equivalence.','Developer batch budget20s is not the production 1s or consumer2.5s latency claim.','Synthetic development corpus does not prove independent quality or answerability.']};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const compact=value=>{const{rows,...rest}=value;return rest;};
const good=value=>qualityPasses(value)&&value.oodAdmission.rate<=.05&&value.entityMismatchAdmission.rate<=.05;
function evaluate(id,vectors){const matrix=Object.fromEntries(fixture.queries.map(q=>{const a=vectors.get(q.id);if(!a)throw Error('Missing query vector');return[q.id,fixture.documents.map(d=>a.reduce((sum,n,i)=>sum+n*docVectors.get(d.id)[i],0))];}));const policies=[];for(let c=10;c<=98;c+=2){const policy={id:id+'-c'+c,minScore:c/100,minGap:0,minZ:0,identifiers:true},train=metrics(fixture,matrix,policy,'train'),calibration=metrics(fixture,matrix,policy,'calibration');policies.push({policy,train:compact(train),calibration:compact(calibration),passed:good(train)&&good(calibration)});}return{fixed44:policies.find(p=>p.policy.minScore===.44),policies};}
async function main(){save();try{
 report.ready=await client.prepare({budgetMs:20000});if(!report.ready.available)throw Error('Native unavailable');
 report.sanity=[];for(const q of fixture.queries.slice(0,2)){const result=await client.encode([CONTRACT.queryPrefix+q.text],{role:'document',budgetMs:20000});if(!result.ok)throw Error('Baseline sanity inference incomplete');const diff=Math.max(...result.vectors[0].map((n,i)=>Math.abs(n-oldQueries.get(q.id)[i])));report.sanity.push({id:q.id,maxDiff:diff});if(diff>1e-6)throw Error('Manual query-prefix encoding does not match baseline');}
 report.baseline=evaluate('web-search-baseline',oldQueries);
 for(const candidate of candidates){const variant={id:candidate.id,prefix:prefix(candidate.task),representationFingerprint:'sha256:'+sha(JSON.stringify([encoded.ready.modelFingerprint,CONTRACT,prefix(candidate.task)])),queries:[],completed:0};report.variants.push(variant);save();
  for(let start=0;start<fixture.queries.length;start+=4){const batch=fixture.queries.slice(start,start+4),result=await client.encode(batch.map(q=>variant.prefix+q.text),{role:'document',budgetMs:20000});if(!result.ok||result.vectors.length!==batch.length)throw Error('Incomplete native study encoding');batch.forEach((q,i)=>variant.queries.push({id:q.id,vector:result.vectors[i],tokens:result.encodedTokens[i]}));variant.completed+=batch.length;if(variant.completed%32===0)console.log(candidate.id+' '+variant.completed+'/'+fixture.queries.length);save();}
  Object.assign(variant,evaluate(candidate.id,new Map(variant.queries.map(q=>[q.id,q.vector]))));save();
 }
 const passing=report.variants.flatMap(variant=>variant.policies.filter(p=>p.passed).map(row=>({...row,instruction:variant.id,prefix:variant.prefix,representationFingerprint:variant.representationFingerprint})));
 passing.sort((a,b)=>Math.max(a.train.oodAdmission.rate,a.calibration.oodAdmission.rate)-Math.max(b.train.oodAdmission.rate,b.calibration.oodAdmission.rate)||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||b.policy.minScore-a.policy.minScore||a.prefix.length-b.prefix.length);
 report.selected=passing[0]||null;report.status=report.selected?'DEVELOPMENT_CANDIDATE_ONLY':'RED_NO_INSTRUCTION_POLICY';
 }catch(error){report.status='FAIL_INCOMPLETE';report.error=String(error.code||error.message);process.exitCode=1;}
 finally{report.runtimeStats=client.stats();report.runtimeStop=await client.stop('disabled');report.finishedAt=new Date().toISOString();report.sourceStable=sha(fs.readFileSync(__filename))===report.sourceSha256&&sha(fs.readFileSync(path.join(__dirname,'qwen-research-adapter.cjs')))===report.adapterSha256;save();}
 console.log(JSON.stringify({output,status:report.status,sanity:report.sanity,variants:report.variants.map(v=>({id:v.id,completed:v.completed,fixed44:v.fixed44})),selected:report.selected,sourceStable:report.sourceStable,runtimeStop:report.runtimeStop}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
