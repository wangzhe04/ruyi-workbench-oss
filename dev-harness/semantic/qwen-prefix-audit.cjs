'use strict';
// Fixed offline output-prefix comparison. No fitting, threshold selection,
// inference, check-query evaluation, or production configuration changes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),fixturePath=path.join(__dirname,'calibration-fixture.cjs');
const fixture=require(fixturePath),policyPath=path.join(__dirname,'calibration-policy.cjs'),{identifiers}=require(policyPath);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function prefix(vector,dimensions){
 if(!Array.isArray(vector)||vector.length!==1024||!vector.every(Number.isFinite))throw Error('prefix.invalid_vector');
 const values=vector.slice(0,dimensions),norm=Math.hypot(...values);
 if(!(norm>0))throw Error('prefix.zero_norm');return values.map(value=>value/norm);
}
function metrics(rows){
 const positive=rows.filter(row=>row.kind==='positive');
 const quality=values=>({count:values.length,recalled:values.filter(row=>row.rank>0).length,recallAt5:values.length?values.filter(row=>row.rank>0).length/values.length:null,mrr:values.length?values.reduce((sum,row)=>sum+(row.rank?1/row.rank:0),0)/values.length:null});
 const rate=kind=>{const values=rows.filter(row=>row.kind===kind),admitted=values.filter(row=>row.top.length>0).length;return{count:values.length,admittedQueries:admitted,anyResultFpr:values.length?admitted/values.length:null,semanticOnlyResultFpr:values.length?values.filter(row=>row.top.some(hit=>hit.semanticOnly)).length/values.length:null};};
 const result={queries:rows.length,quality:{all:quality(positive),groups:Object.fromEntries([...new Set(positive.map(row=>row.group))].map(group=>[group,quality(positive.filter(row=>row.group===group))]))},pureOod:rate('ood'),identifierMismatch:rate('entity-mismatch')};
 result.meetsQualityAndPureOodTargets=result.quality.groups['zh-zh']?.recallAt5>=.90&&result.quality.groups['en-zh']?.recallAt5>=.85&&result.quality.groups['zh-en']?.recallAt5>=.85&&result.quality.all.mrr>=.75&&result.pureOod.anyResultFpr<=.05;
 return result;
}
function main(){
 const vectorPath=path.join(repo,'output/semantic-qwen3-q4-research-v1/vectors-v1.json'),lexicalPath=path.join(repo,'output/semantic-calibration-lexical-v2.json'),output=path.resolve(process.argv[2]||path.join(repo,'output/semantic-qwen3-q4-research-v1/prefix-train-cal-fixed044-v1.json'));
 if(fs.existsSync(output))throw Error('prefix.output_exists');
 const vectorBytes=fs.readFileSync(vectorPath),lexicalBytes=fs.readFileSync(lexicalPath),encoded=JSON.parse(vectorBytes),capture=JSON.parse(lexicalBytes),fixtureHash=sha(fs.readFileSync(fixturePath));
 if(encoded.status!=='PASS'||encoded.fixtureSha256!==fixtureHash||encoded.ready?.dimensions!==1024||!encoded.ready?.modelFingerprint||capture.status!=='PASS_CAPTURE'||capture.fixtureSha256!==fixtureHash)throw Error('prefix.provenance_mismatch');
 // Only train/calibration query IDs enter a vector map, scoring, ranking, or
 // metrics. The fixed document corpus remains common to all three dimensions.
 const queries=fixture.queries.filter(query=>query.split==='train'||query.split==='calibration'),allowed=new Set(queries.map(query=>query.id));
 const queryVectors=new Map(encoded.queries.filter(row=>allowed.has(row.id)).map(row=>[row.id,row.vector])),docVectors=new Map(encoded.documents.map(row=>[row.id,row.vector]));
 const docIndex=new Map(fixture.documents.map((doc,n)=>[doc.id,n])),docIdentifiers=fixture.documents.map(doc=>identifiers(doc.text));
 for(const query of queries)if(!queryVectors.has(query.id)||!Array.isArray(capture.lexical[query.id]))throw Error('prefix.missing_development_query');
 if(fixture.documents.some(doc=>!docVectors.has(doc.id)))throw Error('prefix.missing_document');
 const normalized=text=>text.normalize('NFKC').toUpperCase(),results=[];
 for(const dimensions of [1024,512,256]){
  const docs=fixture.documents.map(doc=>prefix(docVectors.get(doc.id),dimensions));
  const prepared=queries.map(query=>{const vector=prefix(queryVectors.get(query.id),dimensions),required=identifiers(query.text),semantic=docs.map((doc,n)=>({id:fixture.documents[n].id,index:n,score:vector.reduce((sum,value,i)=>sum+value*doc[i],0),semanticOnly:true})).filter(hit=>hit.score>=.44&&required.every(id=>docIdentifiers[hit.index].includes(id))).sort((a,b)=>b.score-a.score||a.index-b.index);
   const lexical=capture.lexical[query.id].map((hit,n)=>{if(!docIndex.has(hit.id))throw Error('prefix.unknown_lexical_document');return{...hit,rankScore:1/(61+n),semanticOnly:false,exact:hit.reference?.matchKind==='lexical-entity'||normalized(fixture.documents[docIndex.get(hit.id)].text).includes(normalized(query.text))};});return{query,semantic,lexical};});
  for(const route of ['semantic-only','frozen-lexical-v2-rrf']){
   const rows=prepared.map(({query,semantic,lexical})=>{let top;
    if(route==='semantic-only')top=semantic.slice(0,5);
    else{const fused=new Map(lexical.map(hit=>[hit.id,{...hit}]));semantic.forEach((hit,n)=>{const prior=fused.get(hit.id);if(prior){prior.rankScore+=1/(61+n);if(!prior.exact)prior.score=hit.score;}else fused.set(hit.id,{...hit,rankScore:1/(61+n),exact:false});});top=[...fused.values()].map(hit=>({...hit,rankScore:hit.rankScore+(hit.exact?1:0)})).sort((a,b)=>b.rankScore-a.rankScore||b.score-a.score||docIndex.get(a.id)-docIndex.get(b.id)).slice(0,5);}
    return{split:query.split,group:query.group,kind:query.kind,rank:top.findIndex(hit=>query.relevant.includes(hit.id))+1,top};});
   results.push({dimensions,route,policy:{minimumCosine:.44,structuredIdentifiers:true,automatic:null,fit:false},train:metrics(rows.filter(row=>row.split==='train')),calibration:metrics(rows.filter(row=>row.split==='calibration')),pooledTrainCalibration:metrics(rows)});
  }
 }
 const report={schemaVersion:1,status:'OFFLINE_DEV_FIXED_POLICY_COMPARISON',generatedAt:new Date().toISOString(),sourceSha256:sha(fs.readFileSync(__filename)),fixtureSha256:fixtureHash,policyHelperSha256:sha(fs.readFileSync(policyPath)),provenance:{vectors:{path:vectorPath,sha256:sha(vectorBytes),modelId:encoded.ready.modelId,modelFingerprint:encoded.ready.modelFingerprint},lexical:{path:lexicalPath,sha256:sha(lexicalBytes),indexSourceSha256:capture.indexSourceSha256,originalVectorSourceSha256:capture.vectorsSha256}},developmentQueries:queries.length,documents:fixture.documents.length,dimensions:[1024,512,256],selection:false,results,
 cachePayload8192Vectors:[1024,512,256].map(dimensions=>({dimensions,float32Bytes:8192*dimensions*4,MiB:8192*dimensions*4/1024**2,savedVs1024Bytes:8192*(1024-dimensions)*4})),modelBytes:encoded.modelBytes,limits:['Prefix truncation plus L2 renormalization only; fixed .44+ID, no training/calibration fit or threshold search.','Only developer train/calibration queries are scored. No check query/label/vector evaluation and no acceptance-v2/v3/v4 fixture or quality report used.','All fixed corpus document vectors are retained for retrieval; no label-based corpus selection.','The lexical route is the historical lexical-v2 capture, not a claim of final source-authenticated weak-lexical/metadata runtime behavior.','Pure OOD and entity-mismatch rates are separate; neither denominator dilutes the other. Small development metrics do not replace independent release validation.','Theoretical Float32 vector payload excludes Map/key/array/copy overhead; current JS Number-array cache may occupy more.','Output truncation does not reduce the 396474560-byte model weights or main model-inference memory; no memory/inference benchmark performed.','No production/default model/manifest/worker changes, check selection, or release approval.']};
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,developmentQueries:queries.length,documents:fixture.documents.length,summary:results.map(row=>({dimensions:row.dimensions,route:row.route,train:row.train,calibration:row.calibration,pooled:row.pooledTrainCalibration})),cache:report.cachePayload8192Vectors}));
}
if(require.main===module){try{main();}catch(error){console.error(error);process.exitCode=1;}}
module.exports={prefix,metrics};
