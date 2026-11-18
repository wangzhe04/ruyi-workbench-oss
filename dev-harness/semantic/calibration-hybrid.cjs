'use strict';
// Capture production lexical candidates once, select a policy on train/cal only,
// and verify the selected RRF replay against the actual production index.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {fixture:sourceFixture}=require('../lib/fulltext-owned-producer-fixture');
const {assess,candidates,qualityPasses}=require('./calibration-policy.cjs');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixture=require(fixturePath);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/13ap-session-fulltext-index.js'));
const input=path.resolve(process.argv[2]||'output/semantic-calibration-minilm-v3-vectors.json'),output=path.resolve(process.argv[3]||'output/semantic-calibration-hybrid-v1.json');
if(fs.existsSync(output))throw Error('Use a new output report.');
const vectors=JSON.parse(fs.readFileSync(input,'utf8'));
if(vectors.status!=='PASS'||vectors.fixtureSha256!==hash(fs.readFileSync(fixturePath))||fixture.documents.some(doc=>doc.text.length>96))throw Error('Provenance/window mismatch.');
const qv=new Map(vectors.queries.map(row=>[row.id,row.vector])),dv=new Map(vectors.documents.map(row=>[row.id,row.vector]));
const matrix=Object.fromEntries(fixture.queries.map(q=>[q.id,fixture.documents.map(doc=>qv.get(q.id).reduce((n,v,i)=>n+v*dv.get(doc.id)[i],0))]));
const normalize=text=>text.normalize('NFKC').toUpperCase(),docIndex=new Map(fixture.documents.map((doc,n)=>[doc.id,n])),byText=new Map(fixture.documents.map(doc=>[normalize(doc.text),doc.id])),byQuery=new Map(fixture.queries.map(q=>[q.text,q]));
const compact=value=>{const {rows,...rest}=value;return rest;};
function metrics(rows,split){
 rows=rows.filter(q=>!split||q.split===split);const positive=rows.filter(q=>q.kind==='positive');
 const quality=values=>({count:values.length,recallAt5:values.length?values.filter(q=>q.rank>0).length/values.length:null,mrr:values.length?values.reduce((n,q)=>n+(q.rank?1/q.rank:0),0)/values.length:null});
 const rate=kinds=>{const values=rows.filter(q=>kinds.includes(q.kind));return{count:values.length,anyResultFpr:values.filter(q=>q.top.length).length/values.length,semanticOnlyResultFpr:values.filter(q=>q.top.some(hit=>hit.semanticOnly)).length/values.length};};
 return{quality:{all:quality(positive),groups:Object.fromEntries([...new Set(positive.map(q=>q.group))].map(group=>[group,quality(positive.filter(q=>q.group===group))]))},searchNegatives:rate(['ood','entity-mismatch']),ood:rate(['ood']),entityMismatch:rate(['entity-mismatch']),unsupportedAnswerDiagnostics:rate(['missing-field','missing-number']),rows};
}
function replay(query,lexical,policy){
 const scores=matrix[query.id],admission=assess(query.text,fixture.documents.map(doc=>doc.text),scores,policy),lexicalIds=new Set(lexical.map(hit=>hit.id)),fused=new Map();
 lexical.forEach((hit,n)=>fused.set(hit.id,{...hit,rankScore:1/(61+n),exact:hit.reference?.matchKind==='lexical-entity'||normalize(fixture.documents[docIndex.get(hit.id)].text).includes(normalize(query.text)),semanticOnly:false}));
 const semantic=fixture.documents.map((doc,n)=>({id:doc.id,score:scores[n],accepted:admission.accepted[n]})).filter(hit=>hit.accepted===true).sort((a,b)=>b.score-a.score||docIndex.get(a.id)-docIndex.get(b.id));
 semantic.forEach((hit,n)=>{const prior=fused.get(hit.id);if(prior){prior.rankScore+=1/(61+n);if(!prior.exact)prior.score=hit.score;}else fused.set(hit.id,{id:hit.id,score:hit.score,rankScore:1/(61+n),exact:false,semanticOnly:!lexicalIds.has(hit.id)});});
 const top=[...fused.values()].map(hit=>({...hit,rankScore:hit.rankScore+(hit.exact?1:0)})).sort((a,b)=>b.rankScore-a.rankScore||b.score-a.score||docIndex.get(a.id)-docIndex.get(b.id)).slice(0,5);
 return{id:query.id,split:query.split,kind:query.kind,group:query.group,rank:top.findIndex(hit=>query.relevant.includes(hit.id))+1,top};
}
async function main(){
 const f=await sourceFixture({enabled:true}),sidToId=new Map(),idToSid=new Map(),report={schemaVersion:1,status:'RUNNING',startedAt:new Date().toISOString(),fixtureSha256:vectors.fixtureSha256,vectorsSha256:hash(fs.readFileSync(input)),modelFingerprint:vectors.ready.modelFingerprint,indexSourceSha256:hash(source),liveWorker:false,lexicalSource:'actual encrypted production index',results:[]};
 const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 try{
  for(let i=0;i<fixture.documents.length;i++){const sid='HYC'+String(i).padStart(3,'0'),doc=fixture.documents[i];sidToId.set(sid,doc.id);idToSid.set(doc.id,sid);await f.put(sid,[{role:'user',id:'m1',content:doc.text}]);}
  f.hookContext.SemanticRetrieval=vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8')+'\nSemanticRetrieval;',{require,Buffer,Date,setTimeout,clearTimeout});
  const ns=vm.runInNewContext('SessionFullTextIndex',f.hookContext),lexical=ns.create({...f.host,resultUnit:'sessions'});await lexical.prepare(null);const captured={};
  for(const query of fixture.queries){const found=await lexical.search(query.text,null,50);if(found.results.length>=50)throw Error('Lexical capture reached cap; cannot prove complete RRF replay.');captured[query.id]=found.results.map(hit=>({id:sidToId.get(hit.reference.sessionId),score:hit.score,reference:hit.reference}));if(Object.keys(captured).length%50===0){report.phase='capturing-lexical';report.capturedQueries=Object.keys(captured).length;save();console.log('Captured '+report.capturedQueries);}}
  report.lexical=captured;report.phase='selecting-train-calibration';save();console.log('Lexical capture complete: '+fixture.queries.length);
  if(process.argv.includes('--capture-only')){report.status='PASS_CAPTURE';report.phase='capture-only';return;}
  for(const policy of candidates(10,98)){
   const rows=fixture.queries.filter(q=>q.split!=='check').map(q=>replay(q,captured[q.id],policy)),train=compact(metrics(rows,'train')),calibration=compact(metrics(rows,'calibration'));
   const qualityPreserving=qualityPasses(train)&&qualityPasses(calibration),passes=qualityPreserving&&train.searchNegatives.anyResultFpr<=.05&&calibration.searchNegatives.anyResultFpr<=.05;
   report.results.push({policy,qualityPreserving,passes,train,calibration});
  }
  const complexity=p=>Number(p.minGap>0)+Number(p.minZ>0);
  const ordered=report.results.filter(row=>row.qualityPreserving).sort((a,b)=>Number(b.passes)-Number(a.passes)||Math.max(a.train.searchNegatives.anyResultFpr,a.calibration.searchNegatives.anyResultFpr)-Math.max(b.train.searchNegatives.anyResultFpr,b.calibration.searchNegatives.anyResultFpr)||a.calibration.searchNegatives.anyResultFpr-b.calibration.searchNegatives.anyResultFpr||complexity(a.policy)-complexity(b.policy)||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||b.policy.minScore-a.policy.minScore);
  report.selected=ordered[0]||null;
  if(!report.selected)throw Error('No quality-preserving hybrid candidate.');
  const selected=report.selected.policy,rows=fixture.queries.map(q=>replay(q,captured[q.id],selected));report.candidate=Object.fromEntries(['train','calibration','check'].map(split=>[split,metrics(rows,split)]));report.phase='verifying-production-replay';save();console.log('Selection complete: '+selected.id);
  const baseline={id:'current-0.34-plus-id',minScore:.34,minGap:0,minZ:0,identifiers:true},oldRows=fixture.queries.map(q=>replay(q,captured[q.id],baseline));report.baseline=Object.fromEntries(['train','calibration','check'].map(split=>[split,metrics(oldRows,split)]));
  const scorer={score:async(text,docs,options)=>{const query=byQuery.get(text),scores=docs.map(value=>matrix[query.id][docIndex.get(byText.get(normalize(value)))]);if(scores.some(x=>!Number.isFinite(x)))throw Error('Unmeasured production window');await options.beforeEncode?.();return{status:'ready',scores,modelFingerprint:vectors.ready.modelFingerprint,minScore:selected.minScore,coverage:{cached:docs.length,total:docs.length,complete:true},admission:assess(text,docs,scores,selected)};}};
  const index=ns.create({...f.host,resultUnit:'sessions',semantic:scorer}),verified=[];
  for(const query of fixture.queries){const actual=await index.search(query.text,null,50),ids=actual.results.slice(0,5).map(hit=>sidToId.get(hit.reference.sessionId)),expected=rows.find(row=>row.id===query.id).top.map(hit=>hit.id);if(JSON.stringify(ids)!==JSON.stringify(expected))throw Error('Production RRF replay mismatch: '+query.id);verified.push({id:query.id,top:ids});}
  report.productionReplay={queries:verified.length,identical:true,rows:verified};report.status=report.selected.passes?'DEVELOPMENT_CANDIDATE':'RED_PARTIAL_IMPROVEMENT';
  report.selectionRule='Actual production lexical candidates stay unchanged. Train/cal only: preserve zh/cross-language recall/MRR floors, minimize worst hybrid any-result FPR, then calibration FPR; prefer no background statistic then MRR. Check used only after selection. Selected replay must match actual index top5 on every development query.';
  report.limits=['No root acceptance-v2/v3 is loaded.','Real native vectors replayed; this is not a latency or live-worker claim.','Production lexical index only; generic fixture metadata excludes public UI metadata matches.','Near-topic missing fields are not primary retrieval negatives. Automatic stays null.'];
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
 finally{await f.close();report.finishedAt=new Date().toISOString();save();}
 console.log(JSON.stringify({output,status:report.status,selected:report.selected,check:report.candidate&&compact(report.candidate.check),error:report.error}));
}
async function offline(lexicalPath){
 const captured=JSON.parse(fs.readFileSync(lexicalPath));if(captured.fixtureSha256!==vectors.fixtureSha256||!captured.lexical||fixture.queries.some(q=>!Array.isArray(captured.lexical[q.id])))throw Error('Incomplete frozen lexical provenance');
 const results=[];for(const policy of candidates(10,98)){const rows=fixture.queries.filter(q=>q.split!=='check').map(q=>replay(q,captured.lexical[q.id],policy)),train=compact(metrics(rows,'train')),calibration=compact(metrics(rows,'calibration')),qualityPreserving=qualityPasses(train)&&qualityPasses(calibration),passes=qualityPreserving&&train.searchNegatives.anyResultFpr<=.05&&calibration.searchNegatives.anyResultFpr<=.05;results.push({policy,qualityPreserving,passes,train,calibration});}
 const complexity=p=>Number(p.minGap>0)+Number(p.minZ>0),ordered=results.filter(x=>x.qualityPreserving).sort((a,b)=>Number(b.passes)-Number(a.passes)||Math.max(a.train.searchNegatives.anyResultFpr,a.calibration.searchNegatives.anyResultFpr)-Math.max(b.train.searchNegatives.anyResultFpr,b.calibration.searchNegatives.anyResultFpr)||a.calibration.searchNegatives.anyResultFpr-b.calibration.searchNegatives.anyResultFpr||complexity(a.policy)-complexity(b.policy)||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||b.policy.minScore-a.policy.minScore),selected=ordered[0]||null;
 const rows=selected?fixture.queries.map(q=>replay(q,captured.lexical[q.id],selected.policy)):null,report={schemaVersion:1,generatedAt:new Date().toISOString(),status:selected?.passes?'OFFLINE_DEVELOPMENT_CANDIDATE':selected?'RED_PARTIAL_IMPROVEMENT':'RED_NO_POLICY',fixtureSha256:vectors.fixtureSha256,modelFingerprint:vectors.ready.modelFingerprint,representationFingerprint:vectors.representationFingerprint||null,inputTransform:vectors.inputTransform?{id:vectors.inputTransform.id,sourceSha256:vectors.inputTransform.sourceSha256,parserSha256:vectors.inputTransform.parserSha256}:null,vectorsSha256:hash(fs.readFileSync(input)),lexicalCaptureSha256:hash(fs.readFileSync(lexicalPath)),lexicalIndexSourceSha256:captured.indexSourceSha256,selected,candidate:rows?Object.fromEntries(['train','calibration','check'].map(split=>[split,metrics(rows,split)])):null,results,limits:['Frozen actual production lexical candidates reused without changes.','Original query/documents remain authoritative for structured-ID consistency, relevance and citations.','Threshold selection uses train/cal only; check is evaluated after selection.','This is offline RRF replay, not fresh integrated production validation or latency evidence.','No root v2/v3 loaded; automatic remains null.']};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,selected,check:report.candidate&&compact(report.candidate.check)}));
}
const reusedAt=process.argv.indexOf('--reuse-lexical');(reusedAt>=0?offline(path.resolve(process.argv[reusedAt+1])):main()).catch(error=>{console.error(error);process.exitCode=1;});
