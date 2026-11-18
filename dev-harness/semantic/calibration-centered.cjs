'use strict';
// Offline hypothesis only. Raw measured cosine always determines result order.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixture=require(fixturePath);
const {metrics,qualityPasses,passes,identifiers}=require('./calibration-policy.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const input=path.resolve(process.argv[2]||'output/semantic-calibration-v2-vectors.json'),output=path.resolve(process.argv[3]||'output/semantic-calibration-centered-v1.json');
if(fs.existsSync(output))throw Error('Use a new report path.');
const encoded=JSON.parse(fs.readFileSync(input,'utf8'));
if(encoded.status!=='PASS'||encoded.fixtureSha256!==sha(fs.readFileSync(fixturePath)))throw Error('Fixture provenance mismatch.');
const queryMap=new Map(encoded.queries.map(row=>[row.id,row.vector])),docMap=new Map(encoded.documents.map(row=>[row.id,row.vector]));
const docs=fixture.documents.map(doc=>docMap.get(doc.id)),dimension=docs[0].length,mean=Array(dimension).fill(0);
docs.forEach(doc=>doc.forEach((value,i)=>{mean[i]+=value/docs.length;}));
const raw=Object.fromEntries(fixture.queries.map(query=>[query.id,docs.map(doc=>queryMap.get(query.id).reduce((n,value,i)=>n+value*doc[i],0))]));
const idAllowed=Object.fromEntries(fixture.queries.map(query=>{const ids=identifiers(query.text);return[query.id,fixture.documents.map(doc=>ids.every(id=>identifiers(doc.text).includes(id)))];}));
const centered={};
for(const alpha of [.25,.5,.75,1]){
 const normalize=vector=>{const shifted=vector.map((value,i)=>value-alpha*mean[i]),norm=Math.hypot(...shifted);return shifted.map(value=>value/norm);};
 const ds=docs.map(normalize);centered[alpha]=Object.fromEntries(fixture.queries.map(query=>{const q=normalize(queryMap.get(query.id));return[query.id,ds.map(doc=>q.reduce((n,value,i)=>n+value*doc[i],0))];}));
}
const admit=(query,scores,policy)=>({status:'evaluated',policyId:policy.id,accepted:scores.map((score,i)=>score>=policy.rawMinimum&&centered[policy.alpha][query.id][i]>=policy.centeredMinimum&&idAllowed[query.id][i])});
const compact=value=>({quality:value.quality,searchNegativeAdmission:value.searchNegativeAdmission,oodAdmission:value.oodAdmission,unsupportedAnswerDiagnostic:value.unsupportedAnswerDiagnostic});
const results=[];
for(const alpha of [.25,.5,.75,1])for(const rawMinimum of [.22,.26,.3,.34])for(let threshold=0;threshold<=60;threshold+=2){
 const policy={id:`centered-a${alpha}-r${rawMinimum}-c${threshold}`,alpha,rawMinimum,centeredMinimum:threshold/100};
 const train=metrics(fixture,raw,policy,'train',{admit}),calibration=metrics(fixture,raw,policy,'calibration',{admit});
 results.push({policy,qualityPreserving:qualityPasses(train)&&qualityPasses(calibration),passes:passes(train)&&passes(calibration),train:compact(train),calibration:compact(calibration)});
}
const chosen=results.filter(row=>row.qualityPreserving).sort((a,b)=>Math.max(a.train.searchNegativeAdmission.rate,a.calibration.searchNegativeAdmission.rate)-Math.max(b.train.searchNegativeAdmission.rate,b.calibration.searchNegativeAdmission.rate)||a.calibration.searchNegativeAdmission.rate-b.calibration.searchNegativeAdmission.rate||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr)[0];
const report={schemaVersion:1,generatedAt:new Date().toISOString(),fixtureSha256:encoded.fixtureSha256,modelFingerprint:encoded.ready.modelFingerprint,vectorsSha256:sha(fs.readFileSync(input)),hypothesis:'Subtract alpha times the current complete corpus mean, normalize, and use centered cosine ONLY as an admission feature. Keep raw cosine result order.',
 status:chosen?.passes?'DEVELOPMENT_CANDIDATE':'RED',selected:chosen||null,check:chosen?metrics(fixture,raw,chosen.policy,'check',{admit}):null,results,
 limits:['Offline development hypothesis; production policy is not changed.','Requires complete authorized background vectors; partial coverage would have to abstain.','Development check has been reused for diagnosis and is not a new blind release test. Root acceptance-v2 is never loaded.','No generative answerability guarantee and no automatic injection approval.']};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,status:report.status,selected:report.selected,check:report.check&&compact(report.check)}));
