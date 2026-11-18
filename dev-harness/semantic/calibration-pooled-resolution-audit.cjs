'use strict';
// Read saved train/cal summaries only. Never train, score new data or select on check.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const gates={zhRecall:.90,zhEnRecall:.85,enZhRecall:.85,mrr:.75,oodFpr:.05};
function pooled(a,b){
 const average=(left,right)=>{if(!left||!right||![left.count,right.count].every(x=>Number.isInteger(x)&&x>0))throw Error('Missing/invalid count');const count=left.count+right.count;return{count,recallAt5:(left.recallAt5*left.count+right.recallAt5*right.count)/count,mrr:(left.mrr*left.count+right.mrr*right.count)/count};};
 const groups={};for(const group of Object.keys(a.quality.groups)){if(!b.quality.groups[group])throw Error('Group mismatch');groups[group]=average(a.quality.groups[group],b.quality.groups[group]);}
 const ood=row=>{const x=row.ood??row.oodAdmission;if(!x||!Number.isInteger(x.count)||x.count<=0)throw Error('Pure OOD metric unavailable');const rate=x.anyResultFpr??x.rate,hits=x.admittedQueries??Math.round(rate*x.count);if(!Number.isFinite(rate)||rate<0||rate>1||Math.abs(hits-rate*x.count)>1e-7)throw Error('Nonintegral OOD rate');return{count:x.count,hits};};
 const x=ood(a),y=ood(b),result={quality:{all:average(a.quality.all,b.quality.all),groups},ood:{count:x.count+y.count,admittedQueries:x.hits+y.hits,rate:(x.hits+y.hits)/(x.count+y.count)}};
 for(const q of [result.quality.all,...Object.values(groups)])if(![q.recallAt5,q.mrr].every(n=>Number.isFinite(n)&&n>=0&&n<=1+1e-12))throw Error('Invalid quality metric');return result;
}
function passesQuality(x){return x.quality.groups['zh-zh'].recallAt5>=gates.zhRecall&&x.quality.groups['zh-en'].recallAt5>=gates.zhEnRecall&&x.quality.groups['en-zh'].recallAt5>=gates.enZhRecall&&x.quality.all.mrr>=gates.mrr;}
function passes(x){return passesQuality(x)&&x.ood.rate<=gates.oodFpr;}
function axes(x){return[x.quality.groups['zh-zh'].recallAt5,x.quality.groups['zh-en'].recallAt5,x.quality.groups['en-zh'].recallAt5,x.quality.all.mrr,-x.ood.rate];}
function frontier(rows){
 const unique=new Map();for(const row of rows){const values=axes(row.pooled),key=values.map(n=>n.toFixed(12)).join('/');if(!unique.has(key))unique.set(key,{axes:values,candidates:[]});unique.get(key).candidates.push(row.index);}
 const points=[...unique.values()];return points.filter(a=>!points.some(b=>b!==a&&b.axes.every((value,i)=>value>=a.axes[i]-1e-12)&&b.axes.some((value,i)=>value>a.axes[i]+1e-12)));
}
function main(output=process.argv[2]||'output/semantic-calibration-pooled-resolution-audit-v1.json'){
 if(fs.existsSync(output))throw Error('Use a new output path');
 const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),fixtureHash=sha(fs.readFileSync(fixturePath));
 const files=['v1-selection','v1-pareto','v2-pareto','hybrid-v1','centered-v1','content-v1-selection','abtt-v1','id-strip-v1-selection','id-strip-v1-hybrid','bge-v1-selection','e5-v2-selection','e5official-v1-selection','e5official-abtt-v1','e5base-v1-hybrid','labse-v1-hybrid','reranker-v1-selection','reranker-script-v1-selection','reranker-confidence-v1-selection','reranker-joint-v1','bge-reranker-v1-selection','bge-reranker-script-v1-selection','bge-reranker-confidence-v1-selection','pooled-policy-v1','role-centering-v1','language-projection-v1'].map(name=>'output/semantic-calibration-'+name+'.json');
 const report={schemaVersion:1,status:'RUNNING',generatedAt:new Date().toISOString(),sourceSha256:sha(fs.readFileSync(__filename)),fixtureSha256:fixtureHash,gates,method:'Sample-count weighted train+cal recall for each group and MRR; pure OOD admitted query counts only. Pareto axes: zh-zh recall, zh-en recall, en-zh recall, overall MRR (maximize), pure OOD FPR (minimize).',sources:[],collections:[],excluded:[],results:[]};
 for(const file of files){
  if(!fs.existsSync(file)){report.excluded.push({file,reason:'Source absent'});continue;}
  const bytes=fs.readFileSync(file),source=JSON.parse(bytes);if((source.fixtureSha256??source.provenance?.fixtureSha256)!==fixtureHash)throw Error('Fixture mismatch '+file);
  report.sources.push({file,bytes:bytes.length,sha256:sha(bytes),originalStatus:source.status??null,modelFingerprint:source.modelFingerprint??source.crossEncoderFingerprint??null});
  function collect(node,pointer,context={}){
   if(Array.isArray(node.results)&&node.results.length){
    const rows=[],collection={file,pointer,context,savedCandidates:node.results.length,mergedCandidates:0,pooledPassing:0,perSplitPassingPureOod:0,pooledOnlyPassing:0};
    for(let n=0;n<node.results.length;n++){
     const row=node.results[n];if(!row.train||!row.calibration){report.excluded.push({file,pointer:pointer+'.results',count:node.results.length,reason:'Saved candidates lack both train and calibration summaries; not reconstructed or retrained.'});break;}
     const value=pooled(row.train,row.calibration),splitTrain=pooled(row.train,row.train),splitCal=pooled(row.calibration,row.calibration);splitTrain.ood.count/=2;splitTrain.ood.admittedQueries/=2;splitCal.ood.count/=2;splitCal.ood.admittedQueries/=2;
     if(value.quality.all.count!==96||value.ood.count!==80||['zh-zh','zh-en','en-zh'].some(group=>value.quality.groups[group].count!==12))throw Error('Unexpected sample inventory '+file+pointer);
     const policy=row.policy??Object.fromEntries(Object.entries(row).filter(([key])=>['mode','minimum','variant','count','alpha','modelIndex'].includes(key))),candidate={index:report.results.length,source:file,pointer:pointer+'.results['+n+']',context,policy,originalFlags:{qualityPreserving:row.qualityPreserving??null,passes:row.passes??null,trainPassed:row.train.passed??null,calibrationPassed:row.calibration.passed??null},pooled:value,passesPooled:passes(value),passesEachSplitPureOod:passes(splitTrain)&&passes(splitCal),passesPooledQuality:passesQuality(value),passesEachSplitQuality:passesQuality(splitTrain)&&passesQuality(splitCal)};
     rows.push(candidate);report.results.push(candidate);
    }
    collection.mergedCandidates=rows.length;collection.pooledPassing=rows.filter(row=>row.passesPooled).length;collection.perSplitPassingPureOod=rows.filter(row=>row.passesEachSplitPureOod).length;collection.pooledOnlyPassing=rows.filter(row=>row.passesPooled&&!row.passesEachSplitPureOod).length;
    collection.pooledQualityOnlyCandidates=rows.filter(row=>row.passesPooledQuality&&!row.passesEachSplitQuality).length;
    collection.frontier=frontier(rows);const quality=rows.filter(row=>row.passesPooledQuality).sort((a,b)=>a.pooled.ood.rate-b.pooled.ood.rate||b.pooled.quality.all.mrr-a.pooled.quality.all.mrr||a.index-b.index);
    collection.minimumPureOodFprPreservingPooledQuality=quality[0]?.pooled.ood.rate??null;collection.bestQualityCandidateIndex=quality[0]?.index??null;report.collections.push(collection);
   }
   // Deliberately whitelist only original candidate containers. Do not recurse
   // into check, selected, candidate, baseline or saved held-out evaluations.
   for(const key of ['models','variants'])if(Array.isArray(node[key]))node[key].forEach((child,n)=>collect(child,pointer+'.'+key+'['+n+']',{...context,...(child.modelId?{modelId:child.modelId}:{}),...(child.mode?{mode:child.mode}:{}),...(child.option?{option:child.option}:{})}));
  }
  collect(source,'$');
 }
 report.passingCandidateIndices=report.results.filter(row=>row.passesPooled).map(row=>row.index);report.pooledOnlyCandidateIndices=report.results.filter(row=>row.passesPooled&&!row.passesEachSplitPureOod).map(row=>row.index);report.pooledQualityOnlyIndices=report.results.filter(row=>row.passesPooledQuality&&!row.passesEachSplitQuality).map(row=>row.index);report.frontier=frontier(report.results);
 report.status=report.passingCandidateIndices.length?'POOLED_CANDIDATES_REQUIRE_INDEPENDENT_VALIDATION':'NO_SAVED_CANDIDATE_PASSES_POOLED_TARGETS';
 report.resolution={trainLanguageCount:9,calibrationLanguageCount:3,pooledLanguageCount:12,perSplitCalibrationRequiredHits:3,pooledRequiredHits:{zhZh:11,zhEn:11,enZh:11},pooledOodCount:80,maximumPooledOodAdmitted:4,note:'3 calibration samples require3/3 at.90 or.85, but combined12 allow1 miss. Aggregation can change candidate ordering;80 OOD counts must not be diluted with24 entity-mismatch negatives.'};
 report.limits=['Only saved candidate train/cal results read for pooling/Pareto; check never enters any score or selection. No vectors loaded, new scores, models, fitting, expanded grid or label changes.','Original source reports and their per-split failures remain unchanged. Any pooled pass is a candidate only and does not change v3 release gates or establish held-out performance.','Pareto is based on five release axes; every language group recall/MRR and weighted overall MRR are retained. Duplicate policies/reports are preserved by source index; frontier metric points group equivalent candidates.','MMARCO joint logistic report only saved per-candidate calibration, so missing train summaries are explicitly excluded instead of fabricated.','The fixed input list includes saved MiniLM variants, BGE bi/cross, E5 family, LaBSE and MMARCO. Other models and root acceptance-v2/v3 are not loaded.'];
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,status:report.status,sources:report.sources.length,candidates:report.results.length,pooledPassing:report.passingCandidateIndices.length,pooledOnly:report.pooledOnlyCandidateIndices.length,collections:report.collections.map(x=>({file:x.file,pointer:x.pointer,context:x.context,count:x.mergedCandidates,passes:x.pooledPassing,minQualityOod:x.minimumPureOodFprPreservingPooledQuality})),passing:report.passingCandidateIndices.slice(0,15).map(i=>report.results[i])}));return report;
}
module.exports={pooled,passes,passesQuality,frontier};if(require.main===module)main();
