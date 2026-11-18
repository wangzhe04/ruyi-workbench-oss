'use strict';
// Compare only independently collected development vectors. Never loads a
// release acceptance fixture, and never converts raw ranking into answerability.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixture=require(fixturePath);
const {metrics}=require('./calibration-policy.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),output=path.resolve(args.shift()||'output/semantic-calibration-model-comparison-v1.json');
const trainCalOnly=args.includes('--train-cal-only'),inputs=args.filter(arg=>arg!=='--train-cal-only'),splits=trainCalOnly?['train','calibration']:['train','calibration','check'];
if(fs.existsSync(output)||!args.length)throw Error('Supply a new output path and measured vector reports.');
const lock=require('../../ruyi-workbench/semantic-runtime/models.lock.json');
const compact=value=>{const{rows,...rest}=value;return rest;};
const models=inputs.map(input=>{
  const report=JSON.parse(fs.readFileSync(input,'utf8'));
  if(report.status!=='PASS'||report.fixtureSha256!==hash(fs.readFileSync(fixturePath)))throw Error('Invalid development vector provenance.');
  const docs=new Map(report.documents.map(row=>[row.id,row.vector])),queries=new Map(report.queries.map(row=>[row.id,row.vector]));
  const matrix=Object.fromEntries(fixture.queries.filter(query=>!trainCalOnly||query.split!=='check').map(query=>[query.id,fixture.documents.map(doc=>queries.get(query.id).reduce((n,v,i)=>n+v*docs.get(doc.id)[i],0))]));
  const model=lock.models.find(row=>row.id===report.ready.modelId),requests=report.requests.filter(row=>row.role==='query'),totalMs=requests.reduce((n,row)=>n+row.elapsedMs,0),totalTexts=requests.reduce((n,row)=>n+row.count,0);
  return{modelId:report.ready.modelId,modelFingerprint:report.ready.modelFingerprint,vectorsSha256:hash(fs.readFileSync(input)),modelBytes:model?.files.reduce((n,row)=>n+row.bytes,0)??report.modelBytes,coldReadyMs:report.coldReadyMs,peakRssBytes:report.peakRssBytes,
    queryEncoding:{texts:totalTexts,totalMs,amortizedMsPerText:totalMs/totalTexts,note:'Serial physical batch 1; NDJSON batches of 8. Includes IPC and tokenization, not end-to-end search latency.'},
    raw:Object.fromEntries(splits.map(split=>[split,compact(metrics(fixture,matrix,{id:'raw-unthresholded',minScore:-1,minGap:0,minZ:0,identifiers:false},split))]))};
});
const result={schemaVersion:1,generatedAt:new Date().toISOString(),fixtureSha256:hash(fs.readFileSync(fixturePath)),models,
 limits:['Same development fixture, not independent release acceptance.','Unthresholded raw rankings include all documents and do not represent production lexical union.','Memory samples are process resourceUsage peaks for each complete encode run, not controlled idle/warm lifecycle comparisons.','Automatic remains unapproved.']};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,models:models.map(row=>({id:row.modelId,bytes:row.modelBytes,rss:row.peakRssBytes,msPerText:row.queryEncoding.amortizedMsPerText,quality:Object.fromEntries(splits.map(split=>[split,row.raw[split].quality]))}))}));
