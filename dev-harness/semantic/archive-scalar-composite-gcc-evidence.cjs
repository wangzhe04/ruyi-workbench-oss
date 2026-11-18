'use strict';
// Frozen evidence only: no native/model/test execution, no v6 or new GCC outputs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),z=require('node:zlib'),a=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),base='docs/optimization-plan/evidence/semantic-retrieval-20261116';
const destination=base+'/s3c-scalar-composite-gcc-reviewed-r1',gcc='output/semantic-native-mingw-research';
const at=f=>path.isAbsolute(f)?f:path.join(repo,f),read=f=>JSON.parse(fs.readFileSync(at(f),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),hash=f=>sha(fs.readFileSync(at(f)));
const bindingsFile='output/semantic-scalar-producer-development-final-v1/bindings.json',bindings=read(bindingsFile);
const publicFile='output/semantic-scalar-public-consumer-final-v1/receipt.json',pub=read(publicFile);
const independentFile='output/semantic-scalar-composite-independent-review-r1.json',ind=read(independentFile);
const replayFile='output/semantic-scalar-producer-development-final-v1/replay.json',replay=read(replayFile);
const nativeFile='output/semantic-scalar-producer-native-sanity-v2.json',native=read(nativeFile);
const staticReceipt=read(gcc+'/static-receipt.json'),comparison=read(gcc+'/runtime-comparison-v1.json');
const entries=new Map();function add(file,group,status='CURRENT_SCOPED_EVIDENCE'){
 const source=path.relative(repo,at(file)).replaceAll('\\','/');a(!source.startsWith('..'));if(!entries.has(source))entries.set(source,{source,group,status});
}
const checks=[];function check(name,fn){fn();checks.push({name,passed:true});}
check('composite/final replay/native/independent frozen bindings',()=>{
 a.equal(hash(bindingsFile),'cdbffe7fc413a33b0775f83847cb04b7bff55fb0b566a8e1610c3710517f28d8');
 a.equal(hash(replayFile),'d8f551b380b813a992ec41b835da09f046c2e88ae55418d8190a62a5fd71f115');
 a.equal(hash(nativeFile),'ddb52f98194798489dda1095583da2fead4db891160076e985b8fc94580b5281');
 a.equal(hash(independentFile),'584cd8a22c43bf9046c7ab37dd6fa76e096773f51c010dc2ce107890d8c835a0');
 for(const x of bindings.files){a.equal(hash(x.file),x.sha256);add(x.file,'composite-source');}
 for(const x of ind.sourceHashes)a.equal(hash(x.file),x.sha256);
 a.equal(hash('dev-harness/semantic/scalar-composite-research-bind.cjs'),bindings.bindingScriptSha256);
 a.equal(bindings.tests.exitCode,0);a(bindings.tests.stdout.includes('tests 30'));a.equal(bindings.sourceStable,true);
 a.equal(replay.replayOnly,true);a.equal(replay.nativeStarts,0);a.equal(replay.coverage.completedQueries,248);a.equal(replay.coverage.complete,true);a.equal(replay.scalarWrites,128);a.equal(replay.sourceBindingsStable,true);
 a.equal(native.pairs.length,2);a.equal(native.stats.verified,2);a.equal(native.cleanup.cleanupStatus,'observed');a.equal(native.cleanup.workerExited,true);a.equal(native.sourceStable,true);a.equal(native.guardCalls,22);a.equal(native.transportGuardCalls,12);
 a(bindings.privateDiagnostics.includes('WeakMap'));
 for(const x of ind.independentFake){a.equal(hash(x.file),x.sha256);add(x.file,'independent-fake');const script=x.file.replace(/\.json$/,'.cjs');if(fs.existsSync(at(script)))add(script,'independent-fake-source');}
});
// Reconstruct from the recorded finite recipe, without evaluating source code.
const snapshotRoot='output/semantic-scalar-composite-archive-source-r1';fs.mkdirSync(at(snapshotRoot));
function reconstruct(name,sourceFile,recipe,patchesKey){
 let text=fs.readFileSync(at(sourceFile),'utf8');a.equal(sha(text),recipe.originalSha256);
 const patches=recipe[patchesKey];a(Array.isArray(patches));
 for(const patch of patches){a.equal(typeof patch.before,'string');a.equal(typeof patch.after,'string');const count=patch.count===undefined?1:patch.count;a.equal(text.split(patch.before).length-1,count);text=text.split(patch.before).join(patch.after);}
 a.equal(sha(text),recipe.transformedSha256);const file=snapshotRoot+'/'+name;fs.writeFileSync(at(file),text,{flag:'wx'});add(file,'finite-recipe-snapshot');add(sourceFile,'original-recipe-base');return {file,sha256:sha(text),patchCount:patches.length};
}
const snapshots=[];
check('finite composite and public recipes reproduce exact full source',()=>{
 snapshots.push(reconstruct('composite-producer.cjs','ruyi-workbench/app/src/13ap-session-fulltext-index.js',bindings.recipe,'patches'));
 snapshots.push(reconstruct('composite-consumer.cjs','ruyi-workbench/app/src/13as-session-fulltext-consumers.js',bindings.consumerRecipe,'patches'));
 a.equal(hash('output/semantic-scalar-producer-development-final-v1/research-producer.cjs'),bindings.recipe.transformedSha256);
 snapshots.push(reconstruct('public-producer.cjs','ruyi-workbench/app/src/13ap-session-fulltext-index.js',pub.producer,'recipe'));
 snapshots.push(reconstruct('public-consumer.cjs','ruyi-workbench/app/src/13as-session-fulltext-consumers.js',pub.consumer,'recipe'));
});
check('separate public consumer8 fake/source proof',()=>{
 a.equal(hash(publicFile),'95ad1d4b4863e3bd1892c109053638dc71e8504d53b506e599efacff3f3cb4a4');
 a.equal(pub.status,'PASS_PUBLIC_CONSUMER_FAKE_NOT_NATIVE_QUALITY');a.equal(pub.tests.exitCode,0);a(pub.tests.stdout.includes('tests 8'));a.equal(pub.nativeStarts,0);a.equal(pub.sourceStable,true);
 for(const x of pub.sourceBefore){a.equal(hash(x.file),x.sha256);add(x.file,'public-consumer-fake-source');}
 a.equal(hash('dev-harness/semantic/scalar-public-consumer-bind.cjs'),pub.binderSha256);
});
check('GCC static five-delta/source/license metadata and numerical RED',()=>{
 a.equal(hash(gcc+'/static-receipt.json'),'ac97b212e1b9e8280b809bfbaf095233c3984cfb3c0420ff93f9fd5803bad587');
 a.equal(hash(gcc+'/config-diagnostic-r1.json'),'10c649aef6ecba3698adc36f0bc43f3a7eb273d9c773fef0c25bf76c05dd615b');
 a.equal(staticReceipt.binary.bytes,22605545);
 // Binary hash comes from producer receipt; binary/objects are not read or archived here.
 for(const [file,expected]of Object.entries(staticReceipt.hashes)){a.equal(hash(gcc+'/'+file),expected);add(gcc+'/'+file,'gcc-static');}
 for(const [file,expected]of Object.entries(staticReceipt.licenseFiles)){a.equal(hash(gcc+'/licenses/'+file),expected);add(gcc+'/licenses/'+file,'gcc-free-license-original');}
 a.equal(read(gcc+'/source-differences.json').onlyChanged.length,5);
 a.equal(comparison.status,'RED_NUMERICAL');a.equal(comparison.summary.allRankThresholdsAgree,false);
 a.equal(comparison.summary.maxEmbeddingAbsolute,0.01319030299782753);a.equal(comparison.summary.minEmbeddingCosine,0.9978567850230692);a.equal(comparison.summary.maxRankDifference,0.005041996017098427);
 a.equal(hash(gcc+'/gcc-development-contract-v1.json'),'f9aa955631196820d8ce4555ec2d6bfc04d3cdbffb78e257533475d64f06e506');
});
for(const file of [bindingsFile,replayFile,nativeFile,independentFile])add(file,'composite-research');
add('output/semantic-scalar-producer-development-final-v1/research-producer.cjs','composite-source-snapshot');
add('dev-harness/semantic/scalar-composite-research-bind.cjs','composite-source');add('dev-harness/semantic/scalar-public-consumer-bind.cjs','public-consumer-fake-source');add(publicFile,'public-consumer-fake');
for(const file of ['static-receipt.json','config-diagnostic-r1.json','runtime-comparison-v1.json','runtime-comparison-v1.cjs','runtime-comparison-v1.log'])add(gcc+'/'+file,'gcc-static-or-red-comparison');
add(gcc+'/gcc-development-contract-v1.json','gcc-separate-candidate-contract','PENDING_SEPARATE_PROFILE_QUALIFICATION');
add('dev-harness/semantic/archive-scalar-composite-gcc-evidence.cjs','archive-tool');
const flags=[];
function inspect(value,key,file){
 if(Array.isArray(value)){for(let i=0;i<value.length;i++){if(typeof value[i]==='string'&&/^--api[-_]?key(?:-file)?$/i.test(value[i])&&i+1<value.length)flags.push({file,path:key+'['+(i+1)+']',reason:'argv credential operand'});inspect(value[i],key+'['+i+']',file);}}
 else if(value&&typeof value==='object'){for(const [name,v]of Object.entries(value)){if(/^(api[-_]?key|authorization|bearer|access[-_]?token)$/i.test(name)&&v)flags.push({file,path:key+'.'+name,reason:'credential property'});inspect(v,key+'.'+name,file);}}
 else if(typeof value==='string'&&/(?:Bearer\s+[A-Za-z0-9_-]{12,}|--api[-_]?key(?:\s+|=)\S+|sk-[A-Za-z0-9_-]{28,}|hf_[A-Za-z0-9]{28,})/i.test(value))flags.push({file,path:key,reason:'credential-like string'});
}
for(const entry of entries.values()){
 const data=fs.readFileSync(at(entry.source));a(data.length<=16*1024*1024,entry.source);a(!/\.(?:gguf|onnx|safetensors|exe|dll|obj|o|a|lib|zip|whl|docx)$/i.test(entry.source));a(!entry.source.includes('acceptance-v6'));a(!/gcc-development-(?:observations|evaluation|receipt|delta|pair-ledger)/.test(entry.source));
 if(entry.source.endsWith('.json'))inspect(JSON.parse(data),'$',entry.source);
}
if(flags.length){const file='output/scalar-composite-gcc-sensitive-inputs.json';fs.writeFileSync(at(file),JSON.stringify({status:'BLOCK_ARCHIVAL_REPORT_TO_ROOT',flags},null,2)+'\n',{flag:'wx'});throw Error('Sensitive JSON input; see '+file);}
fs.mkdirSync(at(destination));const records=[];
for(const [index,entry]of [...entries.values()].entries()){
 const data=fs.readFileSync(at(entry.source)),compressed=z.gzipSync(data,{level:9,mtime:0});a(z.gunzipSync(compressed).equals(data));const archive=destination+'/'+String(index+1).padStart(3,'0')+'-'+path.basename(entry.source)+'.gz';fs.writeFileSync(at(archive),compressed,{flag:'wx'});a.equal(hash(entry.source),sha(data));records.push({...entry,archive,sha256:sha(data),bytes:data.length,gzipSha256:sha(compressed),gzipBytes:compressed.length});
}
const manifest={schema:1,createdAt:new Date().toISOString(),status:'COMPOSITE_RESEARCH_AND_PUBLIC_FAKE_SCOPED_PASS_GCC_EQUIVALENCE_RED',checks,records,snapshots,
 composite:{bindingSha256:hash(bindingsFile),fakeTests:30,replay:{queries:248,usesRecordedVectorsAndScalars:true,nativeStarts:0,scalarWrites:128},nativeSanity:{pairs:2,guardCalls:22,transportGuardCalls:12,cleanup:'observed'},independentSha256:hash(independentFile),privateDiagnostics:'WeakMap only; public result policy/status/counts, no raw-derived identities.'},
 publicConsumer:{receiptSha256:hash(publicFile),fakeTests:8,nativeStarts:0,status:'SEPARATE_PUBLIC_API_FAKE_NOT_NATIVE_OR_INDEPENDENT_QUALITY'},
 gcc:{binaryBytes:22605545,binarySha256:staticReceipt.binary.sha256,binaryArchived:false,sourceDeltas:5,compiler:staticReceipt.buildConstraints.compiler,staticOnly:true,osUcrtRequired:true,comparisonStatus:comparison.status,...comparison.summary,rankShortSamples:16,requestedRankShortSamples:20,stderrRetained:false,diagnosticCauseAttribution:'none; config facts only',newContract:{path:gcc+'/gcc-development-contract-v1.json',sha256:hash(gcc+'/gcc-development-contract-v1.json'),status:'PENDING_SEPARATE_PROFILE_QUALIFICATION',newOutputsReadOrArchived:false}},
 limits:['248 producer replay uses prerecorded real vectors/scalars and starts no native models;30fake and2native illustrative pairs are not all actual-model consumers, independent quality, performance or combined resources.', 'Public8 uses actual source/privacy/13as/UI13d/tool13g with injected synthetic encoder/scalar; separate fake proof only.', 'Finite recipe reconstruction is pure string transformation verified against pinned base and final SHA; it does not execute changed production.', 'Private detailed identities/revisions/epochs/scores stay in exact-result WeakMaps and synthetic harness evidence; no public UI/model raw-derived identity claim.', 'GCC comparison remains RED: embedding maxAbs.0131903/minCos.9978568,rank maxDelta.005042 and.95 threshold disagreement.16rank short samples below20; discarded stderr prevents backend/kernel/repack attribution.', 'OpenMP-off is a build fact, not an isolated causal explanation. Single AVX2 Windows10+ static executable still imports OS UCRT; clean-machine/multiCPU/source-license completeness remain unqualified.', 'GPL/runtime-exception/MinGW/winpthread/MIT source texts retained with hashes; this does not prove the toolchain vendor binary build provenance or close redistribution qualification.', 'New GCC contract is preserved only as a distinct candidate pending review; no new collection/evaluation output was opened or archived and prior v6 decision is unchanged.', 'No v6/query or other holdout access, models/tests/compilers launched, product/default/manifest/gate-state changes by archive tool.'],
 pending:['Actual-model public consumer and remaining independent entry-point wiring','Real producer/native complete replay','Independent frozen v6','1000-fragment fresh/repeated full-chain latency','Two-model total resources/lifecycle','Fresh package/regression and applicable redistribution conditions']};
const file=destination+'/manifest.json';fs.writeFileSync(at(file),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:file,sha256:hash(file),records:records.length,checks:checks.length,rawBytes:records.reduce((n,x)=>n+x.bytes,0),gzipBytes:records.reduce((n,x)=>n+x.gzipBytes,0),sensitiveFlags:flags.length,snapshots}));
