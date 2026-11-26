const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {sr2Accepted}=require(process.cwd()+'/dev-harness/lib/semantic-release-gates.cjs');
const dir=process.argv[2];
const load=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
const q=load('quality-once.json'), p=load('performance.json'), sustained=load('sustained.json'), recovery=load('sustained-retry.json');
if(!q.completed||!p.completed||!sustained.completed||!recovery.completed||recovery.samples.length!==20||q.samples.length!==268||p.samples.length!==20||sustained.samples.length!==20)throw Error('Incomplete execution');
function group(xs){
 const n=xs.length, hits=xs.filter(x=>x.rank>0).length;
 return {n,hits,recallAt5:hits/n,mrr:xs.reduce((s,x)=>s+(x.rank>0?1/x.rank:0),0)/n,anyResult:xs.filter(x=>x.hits>0).length,errors:xs.filter(x=>x.error).length,complete:xs.filter(x=>x.coverage==='complete').length};
}
const groups=Object.fromEntries([...new Set(q.samples.map(x=>x.group))].map(k=>[k,group(q.samples.filter(x=>x.group===k))]));
const pos=group(q.samples.filter(x=>x.kind==='positive')), ood=groups['negative-ood'];
function perf(x){
 const s=x.samples,enc=s.filter(r=>r.encodeMs?.length===1).map(r=>r.encodeMs[0]);
 const percentile=xs=>xs.length?xs.slice().sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1]:null;
 return {fragments:Math.min(...s.map(r=>r.fragments||0)),complete:s.filter(r=>r.coverage==='complete').length,errors:s.filter(r=>r.error).length,availableEncodes:enc.length,totalP95:percentile(s.map(r=>r.ms).filter(Number.isFinite)),encodeP95:percentile(enc),cachedRange:[Math.min(...s.map(r=>r.cached||0)),Math.max(...s.map(r=>r.cached||0))],prewarmMs:x.prewarmMs,indexBuildMs:x.indexBuildMs,coldReadyMs:x.coldReadyMs};
}
const details=perf(p);
const receipt={schema:1,kind:'semantic-sr2-acceptance',realModel:true,encryptedSource:true,frozenBeforeEvaluation:true,fixtureSha256:q.fixtureSha256,quality:{noAnswerCount:ood.n,chineseRecallAt5:groups['zh-zh'].recallAt5,zhEnRecallAt5:groups['zh-en'].recallAt5,enZhRecallAt5:groups['en-zh'].recallAt5,mrr:pos.mrr,noAnswerFalsePositiveRate:ood.errors?null:ood.anyResult/ood.n,completeCoverage:q.samples.every(r=>r.coverage==='complete')},performance:{fragments:details.fragments,warmSamplesMs:p.samples.map(r=>r.ms??null),warmQueryEncodeSamplesMs:p.samples.map(r=>r.encodeMs?.length===1?r.encodeMs[0]:null),completeCoverage:details.complete===20,includesSourceAndPrivacy:true,coldReadyMs:p.coldReadyMs,indexBuildMs:p.indexBuildMs,prewarmMs:p.prewarmMs},rawEvidence:['quality.json','quality-once.json','performance.json','sustained.json','sustained-recovery.json','sustained-retry.json','freeze.json','execution-amendment.json'].map(n=>({path:dir+'/'+n,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')}))};
const summary={passed:sr2Accepted(receipt),groups,positive:pos,qualityComplete:q.samples.filter(r=>r.coverage==='complete').length,qualityErrors:q.samples.filter(r=>r.error).length,initial:details,sustained:perf(sustained),sustainedRecovery:perf(recovery)};
for(const [file,obj] of [['acceptance.json',receipt],['summary.json',summary]]) fs.writeFileSync(path.join(dir,file),JSON.stringify(obj,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
