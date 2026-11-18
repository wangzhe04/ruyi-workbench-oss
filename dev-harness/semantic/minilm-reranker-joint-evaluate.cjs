'use strict';
// Fixed3642 train/cal matrix. No inference, fitting, check or acceptance inputs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {functionBlock,constBlock}=require('../lib/source-slice'),{identifiers}=require('./calibration-policy.cjs');
const PROTOCOL_SHA='3642ddb334a58b5249aa85c9c2cdceb6aa2a9bd9ebb1bdfe8e3aac56f077a1f1';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),fileHash=file=>hash(fs.readFileSync(file));
const pairKey=p=>JSON.stringify([p.queryId,p.fixtureDocumentId,p.start,p.end]);
const queryModelKey=(queryId,model)=>JSON.stringify([queryId,model]);
function unique(rows,key,label){const value=new Map(rows.map(row=>[key(row),row]));if(value.size!==rows.length)throw Error('Duplicate '+label);return value;}
function replayQuery(ctx,query,coarseModel,verifier,policy){
  const raw=ctx.ranks.get(queryModelKey(query.id,coarseModel)),captured=ctx.captures.get(query.id),strongIds=new Set(captured.hits.filter(h=>h.strong).map(h=>h.fixtureDocumentId));
  // Cut K on the full eligible original rank BEFORE strong exemption or cosine.
  const selected=raw.slice(0,policy.k),semantic=selected.filter(item=>!strongIds.has(item.id)&&(policy.coarseMinimum===null||item.cosine>=policy.coarseMinimum));
  const required=new Map();
  const add=(id,role,rank=null,cosine=null)=>{const doc=ctx.documents.get(id),key=pairKey({queryId:query.id,fixtureDocumentId:id,start:0,end:doc.text.length}),pair=ctx.pairs.get(key);
    if(!pair)throw Error('Public union missing prescribed pair '+key);if(!required.has(key))required.set(key,{pair,uses:[]});required.get(key).uses.push({role,rank,cosine});};
  for(const item of semantic)add(item.id,'semantic',item.rank,item.cosine);
  // Weak source fields are independent work. The coarse gate never prunes them.
  for(const hit of captured.hits)if(!hit.strong)add(hit.fixtureDocumentId,'weak-lexical');
  const decisions=new Map(),unknown=[];let tokens=0,inferenceMs=0;
  for(const [key,item]of required){const value=ctx.scores.get(verifier).get(key),known=value?.status==='SCORED'&&Number.isFinite(value.logit)&&Number.isInteger(value.tokens)&&value.tokens>0&&value.tokens<=512;
    decisions.set(key,known?value.logit>=policy.logitMinimum:null);if(known){tokens+=value.tokens;inferenceMs+=value.inferenceMs||0;}else unknown.push({pair:key,reason:value?.status||'MISSING_SCORE'});
  }
  const fused=new Map();let lexicalRank=0;
  for(const hit of captured.hits){const doc=ctx.documents.get(hit.fixtureDocumentId),key=pairKey({queryId:query.id,fixtureDocumentId:doc.id,start:0,end:doc.text.length});
    if(!hit.strong&&decisions.get(key)!==true)continue;
    const facts=ctx.lexicalFacts(query,doc),rankScore=1/(61+lexicalRank++)+(facts.exact?1:0);
    fused.set(doc.id,{id:doc.id,strong:hit.strong,weakLexical:!hit.strong,lexical:true,semantic:false,exact:facts.exact,score:facts.score,rankScore,reference:hit.reference});
  }
  let semanticRank=0;
  for(const item of semantic){const doc=ctx.documents.get(item.id),key=pairKey({queryId:query.id,fixtureDocumentId:doc.id,start:0,end:doc.text.length});if(decisions.get(key)!==true)continue;
    const prior=fused.get(item.id);if(prior){prior.rankScore+=1/(61+semanticRank);prior.semantic=true;if(!prior.exact)prior.score=item.cosine;}
    else fused.set(item.id,{id:item.id,strong:false,weakLexical:false,lexical:false,semantic:true,exact:false,score:item.cosine,rankScore:1/(61+semanticRank)});semanticRank++;
  }
  // Actual90a compare: rankScore, then hit score, then stable CAL ordinal. The
  // fixed corpus has one field/window per source and at most one lexical field.
  const admitted=[...fused.values()].sort((a,b)=>b.rankScore-a.rankScore||b.score-a.score||ctx.documents.get(a.id).ordinal-ctx.documents.get(b.id).ordinal),top=admitted.slice(0,5);
  return {queryId:query.id,split:query.split,kind:query.kind,group:query.group,complete:unknown.length===0,rank:top.findIndex(hit=>query.relevant.includes(hit.id))+1,
    top,admittedBeforeFinalCap:admitted,selectedRawIds:selected.map(x=>x.id),requiredPairs:required.size,jointTokens:tokens,recordedInferenceSumMs:inferenceMs,unknown};
}
function metrics(rows){
  const quality=values=>({count:values.length,recallAt5:values.length?values.filter(x=>x.rank>0).length/values.length:null,mrr:values.length?values.reduce((sum,x)=>sum+(x.rank?1/x.rank:0),0)/values.length:null,partial:values.filter(x=>!x.complete).length});
  const positive=rows.filter(x=>x.kind==='positive'),rate=kinds=>{const values=rows.filter(x=>kinds.includes(x.kind)),n=values.length,observed=values.filter(x=>x.top.length).length,unknown=values.filter(x=>!x.complete&&!x.top.length).length;
    return {count:n,anyResultQueries:observed,anyResultFpr:n?observed/n:null,unknownNoResult:unknown,trueNegatives:values.filter(x=>x.complete&&!x.top.length).length,conservativeFprUpperBound:n?(observed+unknown)/n:null,
      semanticOnlyAdmissionFpr:n?values.filter(x=>x.admittedBeforeFinalCap.some(h=>h.semantic&&!h.lexical)).length/n:null,weakLexicalResultFpr:n?values.filter(x=>x.top.some(h=>h.weakLexical)).length/n:null,strongEvidenceResultFpr:n?values.filter(x=>x.top.some(h=>h.strong)).length/n:null};};
  return {coverage:{queries:rows.length,complete:rows.filter(x=>x.complete).length,partial:rows.filter(x=>!x.complete).length},quality:{all:quality(positive),groups:Object.fromEntries([...new Set(positive.map(x=>x.group))].map(group=>[group,quality(positive.filter(x=>x.group===group))]))},
    pureOod:rate(['ood']),entityMismatch:rate(['entity-mismatch']),missingFieldDiagnostic:rate(['missing-field']),missingNumberDiagnostic:rate(['missing-number']),cost:{requiredPairs:rows.reduce((sum,x)=>sum+x.requiredPairs,0),jointTokens:rows.reduce((sum,x)=>sum+x.jointTokens,0),recordedInferenceSumMs:rows.reduce((sum,x)=>sum+x.recordedInferenceSumMs,0)}};
}
function qualityPasses(value){const group=name=>value.quality.groups[name]?.recallAt5;return group('zh-zh')>=.90&&group('zh-en')>=.85&&group('en-zh')>=.85&&value.quality.all.mrr>=.75;}
function passes(value){return value.coverage.queries>0&&value.coverage.partial===0&&qualityPasses(value)&&value.pureOod.count>0&&value.pureOod.conservativeFprUpperBound<=.05&&value.entityMismatch.count>0&&value.entityMismatch.conservativeFprUpperBound<=.05&&value.quality.groups['exact-entity']?.recallAt5===1;}
function contextFromInputs({fixture,ledger,vectors,capture,scoreReports,bindings,protocol}){
  const queries=fixture.queries.filter(q=>['train','calibration'].includes(q.split)),documents=new Map(fixture.documents.map((doc,ordinal)=>[doc.id,{...doc,ordinal}]));
  if(queries.length!==248||documents.size!==60||[...documents.values()].some(d=>d.text.length>96))throw Error('Only the prescribed60 single-field short sources/248 train-cal queries are supported.');
  const allowed=new Set(queries.map(q=>q.id)),captures=unique(capture.rows,r=>r.queryId,'captures');
  if(capture.status!=='PASS_CURRENT_COMPLETE_CAPTURE'||!capture.sourceStable||capture.fixtureSha256!==bindings.fixtureSha256||captures.size!==248||capture.rows.some(r=>!allowed.has(r.queryId)||r.hits.length>1||!r.coverage.sourceComplete||!r.coverage.candidateSelectionComplete||r.preFinalLimit.candidateCount!==r.hits.length))throw Error('Capture needs broader actual-producer RRF replay, or is partial.');
  if(capture.sourceBefore?.[0]?.sha256!=='90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f')throw Error('Not the frozen90a producer capture.');
  if(ledger.status!=='PASS'||ledger.fixtureSha256!==bindings.fixtureSha256||ledger.vectorSha256!==bindings.vectorSha256||ledger.captureSha256!==bindings.captureSha256||vectors.fixtureSha256!==bindings.fixtureSha256||vectors.protocolSha256!==PROTOCOL_SHA||vectors.status!=='COMPLETE_THREE_COARSE_TRAIN_CAL_AND_FIXED_LOSSY_SAMPLES_NOT_ACCEPTANCE'||vectors.bindingsStable!==true||vectors.allWorkersObservedExited!==true)throw Error('Unbound union/vector inputs.');
  const plans=unique(ledger.queries,q=>q.queryId,'query plans'),pairs=unique(ledger.pairs,pairKey,'pairs');if(plans.size!==248||ledger.queries.some(q=>!allowed.has(q.queryId)))throw Error('Forbidden/missing query plan.');
  for(const pair of pairs.values()){const doc=documents.get(pair.fixtureDocumentId);if(!allowed.has(pair.queryId)||!doc||pair.start!==0||pair.end!==doc.text.length||pair.rawWindowSha256!==hash(doc.text))throw Error('Unbound pair field/window.');}
  const ranks=new Map(),coarseIds=protocol.coarseModels;
  if(vectors.models.length!==3||new Set(vectors.models.map(m=>m.id)).size!==3||coarseIds.some(id=>!vectors.models.some(m=>m.id===id)))throw Error('Coarse model set changed.');
  for(const model of vectors.models){if(model.status!=='COMPLETE_TRAIN_CAL_COARSE_COLLECTION'||model.pooling!=='attention-mask-mean'||model.normalize!=='L2'||model.dimensions!==384||!/^sha256:[0-9a-f]{64}$/.test(model.modelFingerprint||'')||model.cleanup?.workerExited!==true||model.cleanup?.cleanupStatus!=='observed'||model.cleanup?.code!==0||model.cleanup?.signal!==null||ledger.models.find(m=>m.id===model.id)?.fingerprint!==model.modelFingerprint)throw Error('Coarse contract/cleanup invalid.');
    const dv=unique(model.documents,d=>d.id,'doc vectors'),qv=unique(model.queries,q=>q.id,'query vectors');if(dv.size!==60||qv.size!==248||model.queries.some(q=>!allowed.has(q.id)))throw Error('Forbidden/incomplete vector cohort.');
    for(const doc of documents.values()){const value=dv.get(doc.id);if(!value||value.ordinal!==doc.ordinal||value.textSha256!==hash(doc.text)||value.truncated!==false||!Array.isArray(value.vector)||value.vector.length!==384||!value.vector.every(Number.isFinite)||Math.abs(Math.hypot(...value.vector)-1)>1e-4)throw Error('Invalid doc vector.');}
    for(const [ordinal,q]of queries.entries()){const value=qv.get(q.id);if(!value||value.ordinal!==ordinal||value.split!==q.split||value.querySha256!==hash(q.text)||value.truncated!==false||!Array.isArray(value.vector)||value.vector.length!==384||!value.vector.every(Number.isFinite)||Math.abs(Math.hypot(...value.vector)-1)>1e-4)throw Error('Invalid query vector.');
      const required=identifiers(q.text),order=[...documents.values()].filter(doc=>required.every(id=>identifiers(doc.text).includes(id))).map(doc=>({id:doc.id,ordinal:doc.ordinal,cosine:value.vector.reduce((sum,x,n)=>sum+x*dv.get(doc.id).vector[n],0)/(Math.hypot(...value.vector)*Math.hypot(...dv.get(doc.id).vector))})).sort((a,b)=>b.cosine-a.cosine||a.ordinal-b.ordinal).map((item,n)=>({...item,rank:n+1}));ranks.set(queryModelKey(q.id,model.id),order);
      const strong=new Set(captures.get(q.id).hits.filter(h=>h.strong).map(h=>h.fixtureDocumentId));
      for(const item of order.slice(0,5).filter(item=>!strong.has(item.id))){const doc=documents.get(item.id),p=pairs.get(pairKey({queryId:q.id,fixtureDocumentId:item.id,start:0,end:doc.text.length}));if(!p?.roles.some(role=>role.kind==='coarse'&&role.model===model.id&&role.rank===item.rank&&Math.abs(role.cosine-item.cosine)<1e-12))throw Error('Ledger coarse order/score mismatch.');}
    }
  }
  const scores=new Map();for(const report of scoreReports){const id=report.model.repository;if(!protocol.verificationModels.includes(id)||scores.has(id)||!['PASS','PARTIAL'].includes(report.status)||report.fixtureSha256!==bindings.fixtureSha256||report.ledgerSha256!==bindings.ledgerSha256||report.graph!=='onnx/model_quint8_avx2.onnx'||report.model.files.find(file=>file.path===report.graph)?.sha256!==report.graphSha256||!/^[a-f0-9]{64}$/.test(report.graphSha256||'')||!/^[a-f0-9]{64}$/.test(report.tokenizerAuditSha256||''))throw Error('Verifier inputs/provenance invalid.');
    const values=unique(report.pairs,pairKey,'scored pairs');for(const [key,row]of values){const pair=pairs.get(key);if(!pair||row.rawWindowSha256!==pair.rawWindowSha256||!['SCORED','UNKNOWN_OVER_512'].includes(row.status)||!Number.isInteger(row.tokens)||row.tokens<1||row.status==='UNKNOWN_OVER_512'&&(row.tokens<=512||row.logit!==null)||row.status==='SCORED'&&(!Number.isFinite(row.logit)||row.tokens>512||!Number.isFinite(row.inferenceMs)||row.inferenceMs<0))throw Error('Invalid verifier pair result.');}scores.set(id,values);
  }if(scores.size!==3)throw Error('Three independently collected verifier models are required.');
  for(const q of queries){const row=captures.get(q.id),plan=plans.get(q.id);if(row.querySha256!==hash(q.text)||plan.split!==q.split||JSON.stringify(plan.strongEvidence)!==JSON.stringify(row.hits.filter(h=>h.strong)))throw Error('Query/strong evidence mismatch.');for(const hit of row.hits){const doc=documents.get(hit.fixtureDocumentId);if(!doc||hit.rawFieldSha256!==hash(doc.text)||hit.reference?.source!=='content'||hit.reference?.messageId!=='m1')throw Error('Captured source mismatch.');if(!hit.strong){const pair=pairs.get(pairKey({queryId:q.id,fixtureDocumentId:doc.id,start:0,end:doc.text.length}));if(!pair?.roles.some(role=>role.kind==='weak-lexical'))throw Error('Missing independent weak field.');}}}
  const indexSource=fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js','utf8'),retrievalSource=fs.readFileSync('ruyi-workbench/app/src/06h-retrieval-index.js','utf8');if(hash(indexSource)!==capture.sourceBefore[0].sha256||capture.sourceBefore.some(item=>fileHash(item.file)!==item.sha256))throw Error('Producer/helper source drift.');
  const normalize=vm.runInNewContext(indexSource.match(/^  const canonicalText=.*;$/m)[0]+'\n'+indexSource.match(/^  const normalize=.*;$/m)[0]+'\nnormalize;'),terms=vm.runInNewContext(constBlock(retrievalSource,'RETRIEVAL_TEXT_CAP')+'\n'+functionBlock(retrievalSource,'retrievalTerms')+'\nretrievalTerms;');
  const lexicalFacts=(q,doc)=>{const text=normalize(doc.text),phrase=normalize(q.text),ids=identifiers(q.text),matched=[...new Set(terms(q.text).filter(t=>!t.startsWith('#')).map(normalize))].filter(t=>text.includes(t)).length,hasPhrase=text.includes(phrase);return {exact:ids.length>0||hasPhrase,score:ids.length?(hasPhrase?90:60)+matched:(hasPhrase?30:0)+matched};};
  return {queries,documents,captures,pairs,scores,ranks,lexicalFacts,coarseIds,verifierIds:protocol.verificationModels};
}
function evaluate(ctx,protocol){const candidates=[];
  for(const coarseModel of ctx.coarseIds)for(const verifier of ctx.verifierIds)for(const k of protocol.developmentMatrix.coarseTopK)for(const coarseMinimum of protocol.developmentMatrix.coarseMinimums)for(const logitMinimum of protocol.developmentMatrix.verificationLogitMinimums){const policy={coarseModel,verifier,k,coarseMinimum,logitMinimum},rows=ctx.queries.map(q=>replayQuery(ctx,q,coarseModel,verifier,policy)),train=metrics(rows.filter(q=>q.split==='train')),calibration=metrics(rows.filter(q=>q.split==='calibration'));candidates.push({policy,train,calibration,qualityPreserving:qualityPasses(train)&&qualityPasses(calibration),passes:passes(train)&&passes(calibration)});}
  const passing=candidates.filter(x=>x.passes).sort((a,b)=>a.train.cost.requiredPairs+a.calibration.cost.requiredPairs-b.train.cost.requiredPairs-b.calibration.cost.requiredPairs||Math.max(a.train.pureOod.anyResultFpr,a.calibration.pureOod.anyResultFpr)-Math.max(b.train.pureOod.anyResultFpr,b.calibration.pureOod.anyResultFpr)||Math.min(b.train.quality.all.mrr,b.calibration.quality.all.mrr)-Math.min(a.train.quality.all.mrr,a.calibration.quality.all.mrr)||JSON.stringify(a.policy).localeCompare(JSON.stringify(b.policy)));
  return {candidates,passing,illustrativeDevelopmentPolicy:passing[0]?.policy||null,selectedRows:passing.length?ctx.queries.map(q=>replayQuery(ctx,q,passing[0].policy.coarseModel,passing[0].policy.verifier,passing[0].policy)):null};
}
async function main(){
  const [ledgerPath,vectorPath,capturePath,...rest]=process.argv.slice(2),[l6Path,l12Path,mmarcoPath,runPath,output]=rest;if(!output||fs.existsSync(output))throw Error('Use <union-ledger> <vectors> <90a-capture> <l6-q8> <l12-q8> <mmarco-q8> <observed-run-receipt> <new-output>.');
  const protocolPath=path.join(__dirname,'minilm-family-matrix-protocol.json');if(fileHash(protocolPath)!==PROTOCOL_SHA)throw Error('Protocol drift.');
  const protocol=JSON.parse(fs.readFileSync(protocolPath)),fixturePath=path.join(__dirname,'calibration-fixture.cjs');if(fileHash(fixturePath)!==protocol.data.fixtureSha256)throw Error('Fixture drift.');
  const read=file=>JSON.parse(fs.readFileSync(file)),scorePaths=[l6Path,l12Path,mmarcoPath],runs=read(runPath);if(runs.status!=='PASS'||runs.collectorSha256!==fileHash(path.join(__dirname,'minilm-reranker-matrix-collect.cjs'))||scorePaths.some(file=>!runs.runs.some(run=>run.graph==='q8'&&run.code===0&&run.signal===null&&run.cleanup==='close-observed'&&run.outputSha256===fileHash(file))))throw Error('Missing observed verifier process exit or bound Q8 outputs.');
  const bindings={fixtureSha256:fileHash(fixturePath),ledgerSha256:fileHash(ledgerPath),vectorSha256:fileHash(vectorPath),captureSha256:fileHash(capturePath)};
  const ctx=contextFromInputs({fixture:require(fixturePath),ledger:read(ledgerPath),vectors:read(vectorPath),capture:read(capturePath),scoreReports:scorePaths.map(read),bindings,protocol}),result=evaluate(ctx,protocol);
  const report={schemaVersion:1,status:result.passing.length?'TRAIN_CAL_CANDIDATES_REQUIRE_ACTUAL_PRODUCER_AND_RESOURCES':'RED_NO_BOTH_SPLIT_POLICY',protocolSha256:PROTOCOL_SHA,evaluatorSha256:fileHash(__filename),bindings,inputFiles:[ledgerPath,vectorPath,capturePath,...scorePaths,runPath].map(file=>({file:path.resolve(file),sha256:fileHash(file)})),candidateCount:result.candidates.length,passingPolicies:result.passing.length,...result,
    selectionBoundary:'Illustrative development ordering prefers fewer actual prescribed pairs, then worst OOD and worst MRR, with stable ties. No final model is selected without actual warm latency, paired memory, size and independent quality adjudication.',
    limits:['Only248 allowlisted train/cal queries and60 original short single-field documents participate. The shared fixture module constructs all authored records; no check query, vector, score or metric enters this computation. No acceptance fixture is loaded.','Exact fixed-corpus90a RRF replay requires <=1 actual lexical field per query, complete candidate capture and all fields<=96. Metadata, multiple fields/windows, truncation and general producer integration still require real replay.','Unknown required pairs are withheld and partial in original denominators, never true negatives. Independent weak lexical work bypasses the coarse cosine gate.','Recorded inference sums exclude source guards, coarse query encoding, queue/IPC and loading. No offline pass implies500ms, combined RSS, packaged or release qualification.']};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,candidates:report.candidateCount,passing:report.passingPolicies,illustrative:report.illustrativeDevelopmentPolicy}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={replayQuery,metrics,qualityPasses,passes,contextFromInputs,evaluate,PROTOCOL_SHA,pairKey,queryModelKey};
