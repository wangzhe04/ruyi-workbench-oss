'use strict';
// Development-only open-set admission study. Never evaluates check/acceptance.
// The fixed Q4 model is unchanged. A study result is not a production policy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs');
const original=require(fixturePath),fixture={...original,queries:original.queries.filter(row=>['train','calibration'].includes(row.split))};
const {metrics,qualityPasses,assess}=require('./calibration-policy.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
if(fs.existsSync(output))throw Error('Immutable report exists');
const encoded=JSON.parse(fs.readFileSync(input));
if(encoded.status!=='PASS'||encoded.fixtureSha256!==hash(fs.readFileSync(fixturePath)))throw Error('Vector provenance mismatch');
const documents=new Map(encoded.documents.map(row=>[row.id,row.vector]));
// The existing container includes check rows; select train/cal IDs before use.
const allowed=new Set(fixture.queries.map(row=>row.id)),queries=new Map(encoded.queries.filter(row=>allowed.has(row.id)).map(row=>[row.id,row.vector]));
const matrix=Object.fromEntries(fixture.queries.map(row=>{const q=queries.get(row.id);return[row.id,fixture.documents.map(doc=>{const d=documents.get(doc.id);if(q.length!==1024||d.length!==1024)throw Error('Unexpected dimensions');return q.reduce((n,v,i)=>n+v*d[i],0);})];}));
const summary=value=>{const {rows,...rest}=value;return rest;};
const pass=value=>qualityPasses(value)&&value.oodAdmission.rate<=.05&&value.entityMismatchAdmission.rate<=.05;
const results=[];
for(let threshold=10;threshold<=98;threshold+=2)for(const gap of[0,.02,.05])for(const z of[0,1.5,2]){
 const policy={id:`qwen-developer-c${threshold}-g${gap}-z${z}`,minScore:threshold/100,minGap:gap,minZ:z,identifiers:true};
 const train=metrics(fixture,matrix,policy,'train'),calibration=metrics(fixture,matrix,policy,'calibration');
 results.push({policy,train:summary(train),calibration:summary(calibration),passed:pass(train)&&pass(calibration)});
}
const complexity=row=>Number(row.policy.minGap>0)+Number(row.policy.minZ>0);
const passing=results.filter(row=>row.passed).sort((a,b)=>Math.max(a.train.oodAdmission.rate,a.calibration.oodAdmission.rate)-Math.max(b.train.oodAdmission.rate,b.calibration.oodAdmission.rate)||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||complexity(a)-complexity(b)||b.policy.minScore-a.policy.minScore);
const selected=passing[0]||null;
const report={schema:1,createdAt:new Date().toISOString(),status:selected?'DEVELOPMENT_CANDIDATE_ONLY':'RED_NO_POLICY',sourceSha256:hash(fs.readFileSync(__filename)),fixtureSha256:encoded.fixtureSha256,vectorsSha256:hash(fs.readFileSync(input)),modelFingerprint:encoded.ready.modelFingerprint,selectionRule:'Fixed 405 score/gap/z policies, full structured IDs; require independent pure OOD<=.05 and entity mismatch<=.05 plus original quality floors on BOTH train/cal. Rank lower worst OOD, higher calibration MRR, fewer background features, higher cosine. No check/acceptance rows evaluated.',selected,passing:passing.length,results,limitations:['Only synthetic development data; repeated small splits can overfit.','Background gap/z is permitted only for complete source coverage; unknown must stay partial.','Any-result production lexical route must be measured separately.','No weights, dimensions, inference instruction, default, or release gates changed.']};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,passing:report.passing,selected:report.selected}));
