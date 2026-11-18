'use strict';
// Offline development experiment. Fit uses train text vectors only, never labels.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);
function unit(vector){const norm=Math.sqrt(dot(vector,vector));if(!Number.isFinite(norm)||norm<1e-12)throw Error('abtt.degenerate_vector');return vector.map(value=>value/norm);}
function validate(vector,dimensions){if(!Array.isArray(vector)||vector.length!==dimensions||!vector.every(Number.isFinite))throw Error('abtt.vector_missing_or_invalid');return vector;}
function fitTransform(vectors,modelFingerprint,components=3){
 if(typeof modelFingerprint!=='string'||!modelFingerprint.startsWith('sha256:'))throw Error('abtt.model_unavailable');
 const dimensions=vectors[0]?.length;if(!dimensions||vectors.length<components+2)throw Error('abtt.insufficient_training_text');
 vectors.forEach(vector=>validate(vector,dimensions));
 const mean=Array(dimensions).fill(0);for(const vector of vectors)for(let i=0;i<dimensions;i++)mean[i]+=vector[i]/vectors.length;
 const centered=vectors.map(vector=>vector.map((value,i)=>value-mean[i]));
 const covariance=Array.from({length:dimensions},()=>new Float64Array(dimensions));
 for(const vector of centered)for(let i=0;i<dimensions;i++)for(let j=0;j<=i;j++)covariance[i][j]+=vector[i]*vector[j]/vectors.length;
 for(let i=0;i<dimensions;i++)for(let j=0;j<i;j++)covariance[j][i]=covariance[i][j];
 const multiply=vector=>covariance.map(row=>{let sum=0;for(let i=0;i<dimensions;i++)sum+=row[i]*vector[i];return sum;});
 const orthogonal=(vector,basis)=>{for(let pass=0;pass<2;pass++)for(const previous of basis){const coefficient=dot(vector,previous);for(let i=0;i<dimensions;i++)vector[i]-=coefficient*previous[i];}return vector;};
 const pcs=[],diagnostics=[];let seed=0x32e97c15;
 const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296-.5;};
 for(let component=0;component<components;component++){
  let vector=unit(orthogonal(Array.from({length:dimensions},random),pcs)),iterations=0,residual=Infinity,eigenvalue=0;
  for(;iterations<4000;iterations++){
   vector=unit(orthogonal(multiply(vector),pcs));const product=multiply(vector);eigenvalue=dot(vector,product);residual=Math.sqrt(product.reduce((sum,value,i)=>sum+(value-eigenvalue*vector[i])**2,0))/eigenvalue;
   if(residual<1e-9)break;
  }
  if(!Number.isFinite(residual)||residual>=1e-7)throw Error('abtt.pca_not_converged');
  const pivot=vector.reduce((best,value,i)=>Math.abs(value)>Math.abs(vector[best])?i:best,0);if(vector[pivot]<0)vector=vector.map(value=>-value);
  pcs.push(vector);diagnostics.push({component:component+1,iterations:Math.min(iterations+1,4000),eigenvalue,relativeResidual:residual});
 }
 const trace=covariance.reduce((sum,row,i)=>sum+row[i],0);
 return{schemaVersion:1,algorithm:'train-mean-orthogonal-power-iteration-v1',modelFingerprint,dimensions,trainingCount:vectors.length,mean,pcs,diagnostics,trace};
}
function applyTransform(vector,transform,remove,modelFingerprint){
 if(!modelFingerprint||modelFingerprint!==transform.modelFingerprint)throw Error('abtt.model_unavailable_or_changed');
 validate(vector,transform.dimensions);if(!Number.isInteger(remove)||remove<0||remove>transform.pcs.length)throw Error('abtt.components_invalid');
 const centered=vector.map((value,i)=>value-transform.mean[i]),result=centered.slice();
 for(const pc of transform.pcs.slice(0,remove)){const coefficient=dot(centered,pc);for(let i=0;i<result.length;i++)result[i]-=coefficient*pc[i];}
 return unit(result);
}
function main(args=process.argv.slice(2)){
 const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixture=require(fixturePath),{identifiers,qualityPasses}=require('./calibration-policy.cjs');
 const vectorPath=path.resolve(args[0]||'output/semantic-calibration-minilm-v3-vectors.json'),lexicalPath=path.resolve(args[1]||'output/semantic-calibration-lexical-v2.json'),output=path.resolve(args[2]||'output/semantic-calibration-abtt-v1.json'),matrixPath=output.replace(/\.json$/,'-matrix.json');
 if(output===matrixPath||fs.existsSync(output)||fs.existsSync(matrixPath))throw Error('Use new report and matrix paths.');
 const report={schemaVersion:1,status:'RUNNING',startedAt:new Date().toISOString(),experiment:'Train-only unsupervised fixed mean and all-but-top 0/1/2/3; no new model',results:[]};
 const read=file=>{const bytes=fs.readFileSync(file);return{value:JSON.parse(bytes),sha256:sha(bytes)};};
 try{
  const vectors=read(vectorPath),lexical=read(lexicalPath),prior=read(path.resolve('output/semantic-calibration-centered-v1.json')),encoded=vectors.value,capture=lexical.value,fixtureSha=sha(fs.readFileSync(fixturePath)),fingerprint=encoded.ready?.modelFingerprint;
  report.provenance={toolSha256:sha(fs.readFileSync(__filename)),fixtureSha256:fixtureSha,vectors:{path:vectorPath,sha256:vectors.sha256,modelFingerprint:fingerprint},lexical:{path:lexicalPath,sha256:lexical.sha256,indexSourceSha256:capture.indexSourceSha256},priorCentering:{sha256:prior.sha256,status:prior.value.status,hypothesis:prior.value.hypothesis,selectedTrainFpr:prior.value.selected.train.searchNegativeAdmission.rate,selectedCalibrationFpr:prior.value.selected.calibration.searchNegativeAdmission.rate}};
  // Lexical-only capture has no bi-encoder dependency. Authenticate its original
  // input separately before replaying that exact unchanged capture with E5.
  const lexicalVectorPath=path.resolve(args[3]||'output/semantic-calibration-minilm-v3-vectors.json'),lexicalVectors=read(lexicalVectorPath);
  report.provenance.lexical.originalVectorSource={path:lexicalVectorPath,sha256:lexicalVectors.sha256,modelFingerprint:lexicalVectors.value.ready?.modelFingerprint};
  if(encoded.status!=='PASS'||capture.status!=='PASS_CAPTURE'||encoded.fixtureSha256!==fixtureSha||capture.fixtureSha256!==fixtureSha||capture.vectorsSha256!==lexicalVectors.sha256||capture.modelFingerprint!==lexicalVectors.value.ready?.modelFingerprint||lexicalVectors.value.status!=='PASS'||lexicalVectors.value.fixtureSha256!==fixtureSha)throw Error('abtt.provenance_mismatch');
  if(!fingerprint||encoded.ready.dimensions!==384)throw Error('abtt.model_unavailable');
  const qv=new Map(encoded.queries.map(row=>[row.id,row.vector])),dv=new Map(encoded.documents.map(row=>[row.id,row.vector]));
  if(qv.size!==fixture.queries.length||dv.size!==fixture.documents.length)throw Error('abtt.vector_inventory_mismatch');
  const docs=fixture.documents.map(doc=>validate(dv.get(doc.id),384));for(const query of fixture.queries){validate(qv.get(query.id),384);if(!Array.isArray(capture.lexical[query.id]))throw Error('abtt.lexical_capture_missing');}
  // Only split and vector are passed to fitting. Query kinds, relevance, entity,
  // language, document texts and cal/check texts cannot affect this matrix.
  const training=fixture.queries.filter(query=>query.split==='train').map(query=>qv.get(query.id));
  const transform=fitTransform(training,fingerprint),serialized=JSON.stringify(transform)+'\n';fs.writeFileSync(matrixPath,serialized,{flag:'wx'});
  report.transform={path:matrixPath,sha256:sha(serialized),serializedBytes:Buffer.byteLength(serialized),float32PayloadBytes:384*4*4,fitTextPopulation:'Every train query text, including all kinds without consulting those labels; no document vectors, calibration or check vectors',trainingVectorSha256:sha(JSON.stringify(training)),...Object.fromEntries(['algorithm','dimensions','trainingCount','diagnostics','trace'].map(key=>[key,transform[key]]))};
  const normalize=text=>text.normalize('NFKC').toUpperCase(),docIndex=new Map(fixture.documents.map((doc,i)=>[doc.id,i]));
  function prepare(query){
   const required=identifiers(query.text),lex=capture.lexical[query.id].map((hit,n)=>{const i=docIndex.get(hit.id);if(i===undefined)throw Error('abtt.unknown_lexical_document');return{...hit,lexRank:n,exact:hit.reference?.matchKind==='lexical-entity'||normalize(fixture.documents[i].text).includes(normalize(query.text))};});
   return{query,lex,allowed:fixture.documents.map(doc=>required.every(id=>identifiers(doc.text).includes(id))),vector:qv.get(query.id)};
  }
  const docVariants={raw:docs};for(let remove=0;remove<=3;remove++)docVariants['pc'+remove]=docs.map(vector=>applyTransform(vector,transform,remove,fingerprint));
  function score(item,variant){const query=variant==='raw'?item.vector:applyTransform(item.vector,transform,Number(variant.slice(2)),fingerprint);return docVariants[variant].map(doc=>dot(query,doc));}
  const development=fixture.queries.filter(query=>query.split!=='check').map(prepare);
  for(const item of development)item.scores=Object.fromEntries(Object.keys(docVariants).map(variant=>[variant,score(item,variant)]));
  function replay(item,policy){
   const scores=item.scores[policy.variant],fused=new Map(item.lex.map(hit=>[hit.id,{id:hit.id,score:hit.score,rankScore:1/(61+hit.lexRank),exact:hit.exact,semanticOnly:false}]));
   const semantic=fixture.documents.map((doc,i)=>({id:doc.id,score:scores[i],allowed:!policy.identifiers||item.allowed[i]})).filter(hit=>hit.allowed&&Number.isFinite(hit.score)&&hit.score>=policy.minimum).sort((a,b)=>b.score-a.score||docIndex.get(a.id)-docIndex.get(b.id));
   semantic.forEach((hit,n)=>{const previous=fused.get(hit.id);if(previous){previous.rankScore+=1/(61+n);if(!previous.exact)previous.score=hit.score;}else fused.set(hit.id,{id:hit.id,score:hit.score,rankScore:1/(61+n),exact:false,semanticOnly:true});});
   const top=[...fused.values()].map(hit=>({...hit,rankScore:hit.rankScore+(hit.exact?1:0)})).sort((a,b)=>b.rankScore-a.rankScore||b.score-a.score||docIndex.get(a.id)-docIndex.get(b.id)).slice(0,5);
   return{id:item.query.id,split:item.query.split,kind:item.query.kind,group:item.query.group,rank:top.findIndex(hit=>item.query.relevant.includes(hit.id))+1,top};
  }
  function metrics(rows,split){
   rows=rows.filter(row=>row.split===split);const positive=rows.filter(row=>row.kind==='positive'),quality=values=>({count:values.length,recallAt5:values.filter(row=>row.rank>0).length/values.length,mrr:values.reduce((sum,row)=>sum+(row.rank?1/row.rank:0),0)/values.length}),rate=kinds=>{const values=rows.filter(row=>kinds.includes(row.kind));return{count:values.length,admittedQueries:values.filter(row=>row.top.length).length,anyResultFpr:values.filter(row=>row.top.length).length/values.length,semanticOnlyResultFpr:values.filter(row=>row.top.some(hit=>hit.semanticOnly)).length/values.length};};
   return{quality:{all:quality(positive),groups:Object.fromEntries([...new Set(positive.map(row=>row.group))].map(group=>[group,quality(positive.filter(row=>row.group===group))]))},searchNegatives:rate(['ood','entity-mismatch']),ood:rate(['ood']),entityMismatch:rate(['entity-mismatch']),unsupportedAnswerDiagnostics:rate(['missing-field','missing-number']),allNoAnswerDiagnostics:rate(['ood','entity-mismatch','missing-field','missing-number'])};
  }
  const passes=report=>qualityPasses(report)&&report.searchNegatives.anyResultFpr<=.05;
  for(const variant of Object.keys(docVariants))for(let threshold=10;threshold<=98;threshold+=2)for(const useIdentifiers of [false,true]){
   const policy={id:`abtt-${variant}-c${threshold}-id${Number(useIdentifiers)}`,variant,minimum:threshold/100,identifiers:useIdentifiers,rank:'transformed cosine, fixed lexical-v2 RRF',automatic:null},rows=development.map(item=>replay(item,policy)),train=metrics(rows,'train'),calibration=metrics(rows,'calibration');
   report.results.push({policy,qualityPreserving:qualityPasses(train)&&qualityPasses(calibration),passes:passes(train)&&passes(calibration),train,calibration});
  }
  const order=(a,b)=>Number(b.passes)-Number(a.passes)||Math.max(a.train.searchNegatives.anyResultFpr,a.calibration.searchNegatives.anyResultFpr)-Math.max(b.train.searchNegatives.anyResultFpr,b.calibration.searchNegatives.anyResultFpr)||a.calibration.searchNegatives.anyResultFpr-b.calibration.searchNegatives.anyResultFpr||b.calibration.quality.all.mrr-a.calibration.quality.all.mrr||a.policy.id.localeCompare(b.policy.id);
  report.selectionRule='Train/cal only: preserve existing Chinese and cross-language recall and MRR floors; prioritize passing both FPR gates, then smallest worst train/cal any-result search-negative FPR, then calibration FPR, then calibration MRR, then stable policy ID. Fixed 450 policies, no background statistics, no domain vocabulary. Check is evaluated once only after selecting one policy.';
  report.variantSummary=Object.keys(docVariants).map(variant=>({variant,qualityPreservingPolicies:report.results.filter(row=>row.policy.variant===variant&&row.qualityPreserving).length,passingPolicies:report.results.filter(row=>row.policy.variant===variant&&row.passes).length,best:report.results.filter(row=>row.policy.variant===variant&&row.qualityPreserving).sort(order)[0]||null}));
  report.selected=report.results.filter(row=>row.qualityPreserving).sort(order)[0]||null;
  // Selection is complete before any check query is scored or evaluated.
  if(report.selected){
   report.selectionLockedAt=new Date().toISOString();report.selectionFingerprint=sha(JSON.stringify({matrix:report.transform.sha256,policy:report.selected.policy}));
   const policy=report.selected.policy,rows=development.map(item=>replay(item,policy));
   const check=fixture.queries.filter(query=>query.split==='check').map(prepare);for(const item of check)item.scores={[policy.variant]:score(item,policy.variant)};
   const checkRows=check.map(item=>replay(item,policy));report.candidate={train:{...metrics(rows,'train'),rows:rows.filter(row=>row.split==='train')},calibration:{...metrics(rows,'calibration'),rows:rows.filter(row=>row.split==='calibration')},check:{...metrics(checkRows,'check'),rows:checkRows}};
   report.checkPasses=passes(report.candidate.check);report.status=report.selected.passes&&report.checkPasses?'DEVELOPMENT_CANDIDATE':'RED_QUALITY_OR_FPR';
  }else report.status='RED_NO_QUALITY_POLICY';
  report.limits=['No acceptance-v2/v3 or release holdout read. Existing development check is not a new blind release test.','No native model inference, worker/product change, production replay, full test suite, timing benchmark or release approval. Raw frozen vectors and lexical-v2 capture are replayed offline.','Missing/invalid vectors or mismatched model/provenance abort the experiment; transformed vectors are model-fingerprint bound. A product integration would need the same strict binding and fail-closed admission.','All train query kinds enter unsupervised covariance equally. Their labels are never passed to fitTransform. The tiny synthetic training corpus may encode language/topic direction; removing PCs can destroy useful semantics.','Current lexical results are retained even if they cause false positives. Search-negative FPR is distinct from unsupported near-topic answer diagnostics; no entailment or automatic-memory claim.'];
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
 report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,status:report.status,transform:report.transform,selected:report.selected,check:report.candidate?.check&&{...report.candidate.check,rows:undefined},error:report.error}));return report;
}
module.exports={fitTransform,applyTransform};if(require.main===module)main();
