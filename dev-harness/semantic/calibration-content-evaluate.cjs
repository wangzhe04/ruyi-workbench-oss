'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixture=require(fixturePath);
const {metrics,qualityPasses,passes,identifiers}=require('./calibration-policy.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const rawPath=path.resolve(process.argv[2]||'output/semantic-calibration-v2-vectors.json'),contentPath=path.resolve(process.argv[3]||'output/semantic-calibration-content-v1-vectors.json'),output=path.resolve(process.argv[4]||'output/semantic-calibration-content-v1-selection.json');
if(fs.existsSync(output))throw Error('Use a new output file; failed strategies are retained.');
const raw=JSON.parse(fs.readFileSync(rawPath,'utf8')),content=JSON.parse(fs.readFileSync(contentPath,'utf8'));
if(raw.status!=='PASS'||content.status!=='PASS'||raw.fixtureSha256!==hash(fs.readFileSync(fixturePath))||raw.fixtureSha256!==content.fixtureSha256||raw.ready.modelFingerprint!==content.ready.modelFingerprint)throw Error('Fixture/model fingerprint mismatch.');
const ds=new Map(raw.documents.map(row=>[row.id,row.vector])),rawQ=new Map(raw.queries.map(row=>[row.id,row.vector])),contentQ=new Map(content.queries.map(row=>[row.id,row.vector]));
const matrix=map=>Object.fromEntries(fixture.queries.map(query=>{const q=map.get(query.id);return[query.id,fixture.documents.map(doc=>q?q.reduce((n,value,i)=>n+value*ds.get(doc.id)[i],0):null)];}));
const rawScores=matrix(rawQ),contentScores=matrix(contentQ),allowed=Object.fromEntries(fixture.queries.map(query=>{const ids=identifiers(query.text);return[query.id,fixture.documents.map(doc=>ids.every(id=>identifiers(doc.text).includes(id)))];}));
const admit=(query,scores,policy)=>({status:'evaluated',policyId:policy.id,accepted:scores.map((score,i)=>Number.isFinite(contentScores[query.id][i])&&score>=policy.minRaw&&contentScores[query.id][i]>=policy.minContent&&contentScores[query.id][i]-score>=policy.minLift&&allowed[query.id][i])});
const compact=value=>({quality:value.quality,searchNegativeAdmission:value.searchNegativeAdmission,oodAdmission:value.oodAdmission,unsupportedAnswerDiagnostic:value.unsupportedAnswerDiagnostic,allNoAnswerAdmission:value.allNoAnswerAdmission});
const results=[];
for(let rawValue=22;rawValue<=34;rawValue+=2)for(let contentValue=22;contentValue<=66;contentValue+=2)for(const minLift of [-2,-.12,-.08,-.04,0,.04]){
 const policy={id:`content-v1-r${rawValue}-c${contentValue}-l${minLift}`,minRaw:rawValue/100,minContent:contentValue/100,minLift,structuredIdentifiers:true,contentPolicyId:content.contentPolicy.id};
 const train=metrics(fixture,rawScores,policy,'train',{admit}),calibration=metrics(fixture,rawScores,policy,'calibration',{admit});
 results.push({policy,qualityPreserving:qualityPasses(train)&&qualityPasses(calibration),passes:passes(train)&&passes(calibration),train:compact(train),calibration:compact(calibration)});
}
const ordered=results.filter(row=>row.qualityPreserving).sort((a,b)=>Number(b.passes)-Number(a.passes)||Math.max(a.train.searchNegativeAdmission.rate,a.calibration.searchNegativeAdmission.rate)-Math.max(b.train.searchNegativeAdmission.rate,b.calibration.searchNegativeAdmission.rate)||a.calibration.searchNegativeAdmission.rate-b.calibration.searchNegativeAdmission.rate||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||b.train.quality.all.mrr-a.train.quality.all.mrr||a.policy.minLift-b.policy.minLift);
const selected=ordered[0]||null,baseline={id:'simple-0.34-plus-id',minScore:.34,minGap:0,minZ:0,identifiers:true};
const report={schemaVersion:1,generatedAt:new Date().toISOString(),fixtureSha256:raw.fixtureSha256,rawVectorsSha256:hash(fs.readFileSync(rawPath)),contentVectorsSha256:hash(fs.readFileSync(contentPath)),modelFingerprint:raw.ready.modelFingerprint,contentPolicy:content.contentPolicy,
 selection:'Train/calibration only. Preserve natural Chinese and both cross-language recall floors and MRR, minimize worst search-negative admission FPR, then calibration FPR and maximize MRR. Original raw cosine always determines ranking.',status:selected?.passes?'DEVELOPMENT_CANDIDATE':'RED',selected,
 check:selected?metrics(fixture,rawScores,selected.policy,'check',{admit}):null,baselineCheck:metrics(fixture,rawScores,baseline,'check'),results,
 limits:['Root acceptance-v2/v3 are not opened.','Development check is diagnostic and not the independent release holdout.','Content query measures a second relevance view, not factual entailment.','Automatic remains null; actual lexical/index union must be evaluated separately.']};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,status:report.status,selected,check:report.check&&compact(report.check),baselineCheck:compact(report.baselineCheck)}));
