'use strict';
// Explicit small, synthetic research evidence only. Never launches a process.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'), output='docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-reranker-official-reviewed-r1';
const official='output/semantic-qwen-reranker-official-v1',independent='output/semantic-qwen-reranker-independent-v1',native='output/native-headless-qwen-research';
const read=f=>JSON.parse(fs.readFileSync(path.join(repo,f),'utf8').replace(/^\uFEFF/,''));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fileHash=f=>hash(fs.readFileSync(f));
const evidence=[];
function add(prefix,names){for(const name of names)evidence.push(prefix+'/'+name);}
add(official,[
 'metadata-receipt.json','download-receipt.json','conversion-inputs.lock.json','conversion-preflight.json',
 'converter-f16-strict-execution.json','converter-f16-strict.log',
 'converter-f16-invalid-isolation-attempt-execution.json','converter-f16-invalid-isolation-attempt.log',
 'converter-f16-intermediate-no-preflight-execution.json','converter-f16-intermediate-no-preflight.log',
 'invalid-isolation-metadata-audit.json','artifact-audit-r1-invalid-order-assumption.json','artifact-inventory.json',
 'head-proof-f16.json','head-proof-final.json','quantize-q4km-execution.json','quantize-q4km.log',
 'converter-input-requirements.txt','converter-requirements.lock.txt','converter-pip-freeze.txt','converter-wheel-lock.json',
 'toolchain/quantizer.lock.json','research.lock.json','NOTICE.txt',
 'licenses/receipt.json','licenses/Apache-2.0.txt','licenses/llama.cpp-MIT.txt',
 'source/Qwen3-Reranker-0.6B/config.json','source/Qwen3-Reranker-0.6B/generation_config.json',
 'source/Qwen3-Reranker-0.6B/chat_template.jinja','source/Qwen3-Reranker-0.6B/README.md',
 'sanity-v1.json','sanity-rerank-only-v2.json'
]);
add(independent,['bytes-r1.json','provenance-r1.json','provenance-r2.json','mmarco-r1.json','final-independent-receipt-r1.json','rank-endpoint-static-review-r1.json']);
add('output',['qwen-reranker-independent-bytes-r1.log','qwen-reranker-independent-provenance-r1.log','qwen-reranker-independent-provenance-r2.log','mmarco-dual-independent-r1.log']);
add('dev-harness/semantic',[
 'qwen-reranker-convert-run.cjs','qwen-reranker-converter-entry.py','qwen-reranker-head-proof.py','qwen-reranker-artifact-audit.py',
 'qwen-reranker-independent-bytes.py','qwen-reranker-independent-provenance.py','mmarco-dual-independent-audit.cjs',
 'qwen-reranker-native.cjs','qwen-reranker-sanity.cjs','archive-reranker-reviewed-evidence.cjs'
]);
add(native,[
 'qwen3-headless.patch','rank-safe-endpoint.patch','rank-safe-receipt.json','rank-safe-e2e.cjs','rank-safe-e2e-result.json',
 'rank-safe-inventory.json','control-inventory.json','rank-safe-source-differences.json','RANK-SAFE-NOTICE.md',
 'configure-rank-safe.bat','configure-rank-safe.log','build-rank-safe.bat','build-rank-safe.log','dependencies-rank-safe.bat','dependencies-rank-safe.log'
]);
const assertions=[];
function verify(name,fn){fn();assertions.push({name,passed:true});}
verify('scoped independent official receipt hashes and qualification boundary',()=>{
 const receipt=read(independent+'/final-independent-receipt-r1.json');
 assert.equal(receipt.status,'PASS_SCOPED_INDEPENDENT_READ_ONLY_AUDIT'); assert.equal(receipt.modelsRun,0);
 for(const item of [...receipt.reports,...receipt.sources])assert.equal(fileHash(item.file),item.sha256);
 assert.equal(receipt.f16.bytes,1197634304);assert.equal(receipt.q4.bytes,396476288);
 assert.equal(receipt.q4.classifierTypeCode,12);assert.equal(receipt.q4.numericalEquivalenceClaim,false);
 assert.equal(receipt.strictThirdRound.oldInvalidAndIntermediatePromoted,false);
});
verify('recorded conversion environment contains only the explicit nonsecret whitelist',()=>{
 const execution=read(official+'/converter-f16-strict-execution.json'),env=execution.environment;
 const keys=['SystemRoot','WINDIR','COMSPEC','PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','HF_HOME','TEMP','TMP','XDG_CACHE_HOME','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_DATASETS_OFFLINE','HF_HUB_DISABLE_TELEMETRY','OMP_NUM_THREADS','MKL_NUM_THREADS','CUDA_VISIBLE_DEVICES'];
 assert.deepEqual(Object.keys(env).sort(),keys.sort());
 assert.equal(execution.status,'PASS');assert.equal(execution.exitCode,0);
 assert.equal(execution.modelSourceBefore.sha256,execution.modelSourceAfter.sha256);
});
verify('rank-safe frozen receipt source and result identity',()=>{
 const receipt=read(native+'/rank-safe-receipt.json');assert.equal(receipt.status,'PASS_RESEARCH_LIMITED');
 for(const [name,sha] of Object.entries(receipt.hashes))assert.equal(fileHash(path.join(repo,native,name)),sha,name);
 const result=read(native+'/rank-safe-e2e-result.json');assert.equal(result.status,'PASS');
 assert.equal(fileHash(path.join(repo,native,'rank-safe-e2e.cjs')),result.sourceHash);
 assert.equal(result.rankModelHash,read(independent+'/bytes-r1.json').artifacts.q4_k_m.sha256);
 assert.equal(result.runs.length,4);assert.equal(result.rerankComparisons.length,3);
 assert(result.rerankComparisons.every(x=>Number.isFinite(x.control)&&x.control===x.safe&&x.diff===0));
 assert.equal(result.embedMaxAbs,0);
 const safe=result.runs[1];assert.equal(safe.mode,'rank');
 for(const endpoint of ['/embedding','/embeddings','/v1/embeddings']){
  const test=safe.cases.find(x=>x.endpoint===endpoint);assert(test);
  assert.equal(test.unauthorized,401);assert.equal(test.malformed,501);assert.equal(test.valid,501);assert(test.bodyRejectedBeforeJson);
 }
 for(const run of result.runs.slice(2)){assert.equal(run.mode,'embed');assert.equal(run.cases.length,3);assert(run.cases.every(x=>x.status===200));}
 const script=fs.readFileSync(path.join(repo,native,'rank-safe-e2e.cjs'),'utf8');
 assert(script.includes('finally{child.kill();await Promise.race([closed,'));
 const diff=read(native+'/rank-safe-source-differences.json');assert.equal(diff.fileCount,3619);
 assert.deepEqual(diff.onlyModified,['src\\models\\qwen3.cpp','tools\\server\\server-context.cpp']);
});
verify('actual recorded rank-safe and control small binary inventories',()=>{
 for(const [inventory,bin] of [['rank-safe-inventory.json','C:/r31-native-headless-research/build-rank-safe/bin'],['control-inventory.json','C:/r31-native-headless-research/build-control/bin']]){
  for(const item of read(native+'/'+inventory)){
   const f=path.join(bin,item.path);assert.equal(fs.statSync(f).size,item.bytes);assert.equal(fileHash(f),item.sha256,item.path);
  }
 }
});
verify('sanity baseline is separate and not a quality or 500ms qualification',()=>{
 const sanity=read(official+'/sanity-rerank-only-v2.json');assert.equal(sanity.status,'SANITY_PASS_NOT_QUALITY');
 assert.equal(sanity.nativeObservedMemory.PeakWorkingSet64,1431289856);
 assert.deepEqual(sanity.results.map(x=>x.elapsedMs),[720,729,639,626]);
 assert.equal(sanity.boundary.accepted512.elapsedMs,4091);assert(sanity.boundary.rejectedWithoutInference);
 assert.equal(sanity.stats.embeddingWrites,0);assert.equal(sanity.cleanup.cleanupStatus,'observed');
 assert.equal(read(official+'/sanity-v1.json').status,'FAIL');
});
// Check the whole input list before publishing any gzip members.
for(const source of evidence){
 const size=fs.statSync(path.join(repo,source)).size;
 assert(size<=(source===native+'/build-rank-safe.log'?8*1024*1024:1024*1024),'small evidence preflight '+source);
}
const records=[];
if(fs.existsSync(path.join(repo,output,'manifest.json')))throw Error('Preserve completed immutable archive.');
fs.mkdirSync(path.join(repo,output),{recursive:true});
for(const [index,source] of evidence.entries()){
 const actual=path.join(repo,source),data=fs.readFileSync(actual);
 assert(data.length<=(source===native+'/build-rank-safe.log'?8*1024*1024:1024*1024),'small evidence only '+source);
 assert(!/\.(?:gguf|safetensors|onnx|dll|exe|whl|zip)$/i.test(source));
 const text=data.toString('utf8');
 assert(!/(?:sk-[A-Za-z0-9_-]{28,}|hf_[A-Za-z0-9]{28,}|ghp_[A-Za-z0-9]{28,}|(?:X-Amz-Signature|X-Xet-Cas-Uid)=[A-Za-z0-9+/]{16,})/i.test(text),'potential credential '+source);
 const compressed=zlib.gzipSync(data,{level:9,mtime:0});assert(zlib.gunzipSync(compressed).equals(data));
 const archive=output+'/'+String(index+1).padStart(3,'0')+'-'+path.basename(source)+'.gz';
 if(fs.existsSync(path.join(repo,archive)))assert(fs.readFileSync(path.join(repo,archive)).equals(compressed),'existing partial archive bytes changed');
 else fs.writeFileSync(path.join(repo,archive),compressed,{flag:'wx'});
 assert.equal(fileHash(actual),hash(data));assert.equal(hash(zlib.gunzipSync(fs.readFileSync(path.join(repo,archive)))),hash(data));
 records.push({source,archive,sha256:hash(data),bytes:data.length,gzipSha256:hash(compressed),gzipBytes:compressed.length});
}
const manifest={schema:1,createdAt:new Date().toISOString(),status:'OFFICIAL_RERANKER_PROVENANCE_AND_RANK_SAFE_SCOPED_PASS_QUALITY_RED',assertions,
 archivePreparationHistory:{attempts:['output/archive-reranker-reviewed-r1.log','output/archive-reranker-reviewed-r2.log'].map(file=>({file,sha256:fileHash(path.join(repo,file)),exitCode:1})),reason:'First scanner matched its own pattern, then the 4.9MB plain-text compiler log exceeded a 1MiB default. Fixed value-only secret detection and explicit8MiB allowance for that one log, preflight all sizes. Incomplete gzip directory preserved under output/semantic-qwen-reranker-independent-v1/incomplete-archive-preparation-r1; final directory rebuilt fresh.'},
 limits:[
 'All evidence is small research/code/metadata/license data with gzip original-byte SHA and roundtrip; no weights, native binaries, wheels, tokenizer/vocabulary assets or credentials archived.',
 'Original invalid-isolation/intermediate/unsafe-RANK-embedding sanity failures remain distinct and are not promoted. Recorded safe whitelist paths/flags contain no auth secrets; not an OS sandbox proof.',
 'F16 to Q4_K_M is lossy weight quantization, distinct from graph/buffer runtime savings; Q4 classifier is Q4_K, not an unchanged F16 head.',
 'Prior embedding-only control1366.1/graph962.0/graph-buffer665.3MiB are different from new reranker baseline1431289856B; no-repack has numeric differences, MRL512/256 fail fixed development OOD policy.',
 'RANK safe aliases401/501 and three scalar/embedding comparisons are illustrative HTTP/numerical behavior checks, not quality/latency/resource qualification or generic C API compatibility.',
 'Reranker baseline four short requests626–729ms, accepted512-token4091ms and1.431GB isolated process peak remain unqualified; no production/default/manifest adoption or release gate closed.',
 'All SR1–SR8 remain pending and overall quality RED. New rank-buffer proposal/runtime work is excluded from this batch pass.'
 ],records};
const manifestFile=path.join(repo,output,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({manifest:path.relative(repo,manifestFile).replaceAll('\\','/'),sha256:fileHash(manifestFile),records:records.length,assertions:assertions.length,originalBytes:records.reduce((n,x)=>n+x.bytes,0),gzipBytes:records.reduce((n,x)=>n+x.gzipBytes,0)}));
