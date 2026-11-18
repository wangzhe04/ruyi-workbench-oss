'use strict';
// Independent offline verification/archiving only; never compiles or infers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),z=require('node:zlib'),a=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),root='output/native-headless-qwen-research';
const out='docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-reranker-runtime-reviewed-r2';
const read=f=>JSON.parse(fs.readFileSync(path.join(repo,f),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fh=f=>hash(fs.readFileSync(path.join(repo,f)));
const parent='docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-reranker-official-reviewed-r1/manifest.json';
const evidence=['rank-buffer-receipt.json','rank-buffer-proposal.patch','rank-buffer-inventory.json','rank-buffer-source-differences.json','rank-buffer-comparison.cjs','rank-buffer-comparison.json','rank-buffer-comparison.log','rank-buffer-threads68-receipt.json','rank-buffer-threads68.cjs','rank-buffer-threads68.json','rank-buffer-threads68.log','RANK-BUFFER-NOTICE.md','configure-rank-buffer.bat','configure-rank-buffer.log','build-rank-buffer.bat','build-rank-buffer.log'].map(f=>root+'/'+f);
evidence.push('output/semantic-qwen-reranker-independent-v1/rank-buffer-static-review-r1.json','dev-harness/semantic/archive-rank-buffer-reviewed-evidence.cjs');
const checks=[];function check(name,fn){fn();checks.push({name,passed:true});}
check('immutable parent and both final receipt identities',()=>{
 a.equal(fh(parent),'86006a765f8cae0e9e8b807d8c2d75d9ff5e1705ea970eeaa76c9bc836e8d669');
 a.equal(fh(root+'/rank-buffer-receipt.json'),'ec311bb5081602f9f3ab709472f67847150e4713a28270f8d544bcb7e9fb2401');
 a.equal(fh(root+'/rank-buffer-threads68-receipt.json'),'e67661bf50fb216221c66d3de4187f74a11a2df80e41eb9e3043d77763043f35');
 for(const name of ['rank-buffer-receipt.json','rank-buffer-threads68-receipt.json']){
  const r=read(root+'/'+name);a.equal(r.status,'PASS_RESEARCH_LIMITED');
  for(const [file,sha]of Object.entries(r.hashes))a.equal(fh(root+'/'+file),sha,file);
 }
});
const first=read(root+'/rank-buffer-comparison.json'),extra=read(root+'/rank-buffer-threads68.json');
check('actual source/artifact/record bounds',()=>{
 for(const [report,script]of [[first,'rank-buffer-comparison.cjs'],[extra,'rank-buffer-threads68.cjs']]){
  a.equal(report.status,'PASS');a.equal(report.sourceHash,fh(root+'/'+script));
  a.equal(report.modelHash,'9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7');
  a.equal(report.comparisons.length,44);
  for(const r of report.runs){
   a.equal(r.actualCtx,1024);a.equal(r.modelSha256,report.modelHash);a.equal(r.records.length,22);
   a.equal(r.records.filter(x=>x.phase==='short').length,20);
   a.equal(r.records.filter(x=>x.phase==='long').length,1);
   for(const x of r.records){a(Number.isFinite(x.score)&&x.tokens>0&&x.tokens<=512);a(Number.isFinite(x.inferenceMs)&&x.inferenceMs>0);a(Number.isFinite(x.totalMs)&&x.totalMs>=x.inferenceMs);if(x.phase==='long')a.equal(x.tokens,512);}
   a.equal(fh(root+'/'+script).length,64);
   a(fs.readFileSync(path.join(repo,root,script),'utf8').includes('finally{child.kill();await Promise.race([closed,'));
  }
 }
 a.deepEqual(first.runs.map(x=>[x.kind,x.threads]),[['rank-safe',2],['rank-buffer',2],['rank-safe',4],['rank-buffer',4]]);
 a.deepEqual(extra.runs.map(x=>[x.kind,x.threads]),[['rank-buffer',6],['rank-buffer',8]]);
});
function compare(left,right){
 a.equal(left.records.length,right.records.length);
 for(let i=0;i<left.records.length;i++){
  const x=left.records[i],y=right.records[i];
  for(const key of ['id','phase','repeat','tokens','tokenHash','score'])a.equal(x[key],y[key],key);
 }
}
check('independent exact44 paired variant records and44 cross-thread records',()=>{
 compare(first.runs[0],first.runs[1]);compare(first.runs[2],first.runs[3]);
 for(const r of extra.runs)compare(first.runs[3],r);
 for(const report of [first,extra])for(const x of report.comparisons){a.equal(x.control,x.patched);a.equal(x.difference,0);}
 for(const r of [...first.runs,...extra.runs]){
  const seen=new Map();for(const x of r.records.filter(x=>x.phase==='short')){if(seen.has(x.id))a.equal(x.score,seen.get(x.id));else seen.set(x.id,x.score);}
 }
});
check('actual rank-buffer small binaries and exact narrow source delta',()=>{
 const inventory=read(root+'/rank-buffer-inventory.json');a.equal(inventory.length,8);
 for(const x of inventory){const f='C:/r31-native-headless-research/build-rank-buffer/bin/'+x.path;a.equal(fs.statSync(f).size,x.bytes);a.equal(hash(fs.readFileSync(f)),x.sha256);}
 const old=fs.readFileSync('C:/r31-native-headless-research/source-rank-safe/src/llama-context.cpp','utf8');
 const actual=fs.readFileSync('C:/r31-native-headless-research/source-rank-buffer/src/llama-context.cpp','utf8');
 const needle='bool has_logits     = true;',replacement='bool has_logits     = !(model.arch == LLM_ARCH_QWEN3 && cparams.embeddings && cparams.pooling_type == LLAMA_POOLING_TYPE_RANK && sampling.samplers.empty());';
 a.equal(old.split(needle).length,2);a.equal(old.replace(needle,replacement),actual);
 for(const file of ['src/models/qwen3.cpp','tools/server/server-context.cpp'])a(fs.readFileSync('C:/r31-native-headless-research/source-rank-safe/'+file).equals(fs.readFileSync('C:/r31-native-headless-research/source-rank-buffer/'+file)));
});
function quantile(values,q){const s=[...values].sort((x,y)=>x-y);return s[Math.ceil(s.length*q)-1];}
const resources=[...first.runs,...extra.runs].map(r=>{const short=r.records.filter(x=>x.phase==='short');return {kind:r.kind,threads:r.threads,actualCtx:r.actualCtx,shortSamples:short.length,readyWorkingSetBytes:r.readyMemory.WorkingSet64,peakWorkingSetBytes:r.lastMemory.PeakWorkingSet64,peakMiB:r.lastMemory.PeakWorkingSet64/1048576,shortNativeP50Ms:quantile(short.map(x=>x.inferenceMs),.5),shortNativeP95Ms:quantile(short.map(x=>x.inferenceMs),.95),shortEraseAndNativeP95Ms:quantile(short.map(x=>x.totalMs),.95),mediumSingleNativeMs:r.records.find(x=>x.phase==='medium').inferenceMs,long512SingleNativeMs:r.records.find(x=>x.phase==='long').inferenceMs};});
// Validate every source before creating the final output directory.
for(const source of evidence){const data=fs.readFileSync(path.join(repo,source));a(data.length<=8*1024*1024);a(!/\.(gguf|onnx|safetensors|exe|dll|whl|zip)$/i.test(source));a(!/(?:sk-[A-Za-z0-9_-]{28,}|hf_[A-Za-z0-9]{28,}|ghp_[A-Za-z0-9]{28,}|(?:X-Amz-Signature|X-Xet-Cas-Uid)=[A-Za-z0-9+/]{16,})/i.test(data.toString('utf8')));}
fs.mkdirSync(path.join(repo,out));const records=[];
for(const [i,source]of evidence.entries()){
 const data=fs.readFileSync(path.join(repo,source)),compressed=z.gzipSync(data,{level:9,mtime:0});a(z.gunzipSync(compressed).equals(data));
 const archive=out+'/'+String(i+1).padStart(3,'0')+'-'+path.basename(source)+'.gz';fs.writeFileSync(path.join(repo,archive),compressed,{flag:'wx'});
 a.equal(fh(source),hash(data));a.equal(hash(z.gunzipSync(fs.readFileSync(path.join(repo,archive)))),hash(data));
 records.push({source,archive,sha256:hash(data),bytes:data.length,gzipSha256:hash(compressed),gzipBytes:compressed.length});
}
const manifest={schema:1,createdAt:new Date().toISOString(),status:'RANK_BUFFER_SCOPED_NUMERICAL_AND_RESOURCE_RESEARCH_PASS_QUALITY_RED',parent:{path:parent,sha256:fh(parent)},checks,modelsRunByAuditor:0,records,resources,percentileMethod:'nearest rank ceil(q*N)-1;20 measured short requests per worker,2 warmup excluded',
 limits:['Dedicated fresh fixed two-label Qwen3 RANK context only; no sampling/get_logits/dynamic modes/optimizer/generic C API guarantee.', '44 variant pairs at2/4threads and44 cross-thread pairs against4thread baseline are saved finite scalar equality checks, not retrieval/OOD qualification.', 'Original stock1.431GB peak/626–729ms belongs to an earlier baseline; compare rank-safe vs rank-buffer within this new same-input2/4thread protocol, not a controlled three-way stock comparison.', 'Six/eight thread long samples occur once each; do not infer a stable preferred thread setting or claim product p95.', 'Measured native request excludes tokenization/source/privacy/controller work; erase+native timing also separately reported, not whole product latency.', 'threads68 producer records exactEqual but does not throw for nonzero values; this independent auditor additionally asserts all actual records/repeats are exactly equal.', 'No model/compile was run by auditor; runtime evidence is producer-owned and hash-verified, current source/binaries verified read-only.', 'All SR pending, quality RED, production default/manifest unchanged; no commit/push/public release or package qualification.']};
const file=out+'/manifest.json';fs.writeFileSync(path.join(repo,file),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:file,sha256:fh(file),records:records.length,checks:checks.length,resources,originalBytes:records.reduce((n,x)=>n+x.bytes,0),gzipBytes:records.reduce((n,x)=>n+x.gzipBytes,0)}));
