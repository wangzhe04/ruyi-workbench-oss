'use strict';
// Fixed receipts/source only; no changing live runner/layout, model or v6 access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),z=require('node:zlib'),a=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),base='docs/optimization-plan/evidence/semantic-retrieval-20261116',out=base+'/s3c-gcc-window-append-reviewed-r1',gcc='output/semantic-native-mingw-research';
const at=f=>path.isAbsolute(f)?f:path.join(repo,f),read=f=>JSON.parse(fs.readFileSync(at(f),'utf8')),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),fh=f=>hash(fs.readFileSync(at(f)));
const entries=new Map(),checks=[],skippedAssetBindings=[];
const excluded=/scalar-window-(?:append-)?live-layout|scalar-composite-live-development|scalar-window-development-replay/;
function add(file,group,status='CURRENT_SCOPED_EVIDENCE') {const source=path.relative(repo,at(file)).replaceAll('\\','/');a(!source.startsWith('..'));a(!excluded.test(source),'mutable runner/layout excluded');if(!entries.has(source))entries.set(source,{source,group,status});}
function bound(file,expected,group){a.equal(fh(file),expected,file);if(group)add(file,group);}
function check(name,fn){fn();checks.push({name,passed:true});}
const receipt=read(gcc+'/gcc-development-receipt-v1.json'),observations=read(gcc+'/gcc-development-observations-v1.json'),evaluation=read(gcc+'/gcc-development-evaluation-v1.json'),rootReview=read(gcc+'/root-fixed-development-review-r1.json');
check('frozen independent GCC development and root fixed-policy recheck',()=>{
 bound(gcc+'/gcc-development-receipt-v1.json','f101577bd1b9d33e89b8b06b4d743a929fd0bec842d7f0dd84fa229276e2a055','gcc-development');
 for(const [file,sha]of Object.entries(receipt.hashes))bound(gcc+'/'+file,sha,'gcc-development-source-data');
 a.equal(observations.documents.length,60);a.equal(observations.queries.length,248);a.equal(observations.pairs.length,128);a.equal(new Set(observations.pairs.map(x=>x.pairId)).size,128);
 a(observations.queries.every(x=>['train','calibration'].includes(x.split)));a(observations.pairs.every(x=>Number.isFinite(x.probability)&&x.jointTokens<=512));a.equal(Math.max(...observations.pairs.map(x=>x.jointTokens)),121);
 a.equal(observations.embedCleanup.cleanupStatus,'observed');a.equal(observations.rankCleanup.cleanupStatus,'observed');a.equal(observations.embedRepeatMaxAbs,0);a.equal(observations.rankRepeatMaxAbs,0);
 a.equal(evaluation.profile.coarse,'raw K1');a.equal(evaluation.profile.threshold,.95);
 for(const x of rootReview.sources)bound(x.file,x.sha256);
 a.equal(rootReview.neededPairs,128);a.equal(rootReview.strongCount,96);a.equal(rootReview.weakCount,7);
 for(const split of ['train','calibration']){const x=rootReview.results[split];a.equal(x.quality.recallAt5,1);a.equal(x.quality.mrr,1);a.equal(x.pureOod.anyResultFpr,0);a.equal(x.entityMismatch.anyResultFpr,0);}
 add(gcc+'/root-fixed-development-review-r1.json','root-independent-fixed-development');
 const script=gcc+'/root-fixed-development-review-r1.cjs';if(fs.existsSync(at(script)))add(script,'root-independent-source');
});
const smokePlan=read(gcc+'/gcc-live-profile-smoke-plan-v1.json'),smoke=read(gcc+'/gcc-live-profile-smoke-v1.json');
check('GCC factory exact pinned source,40 recorded vector comparisons and final cleanup',()=>{
 a.equal(smoke.status,'PASS_RESEARCH_SMOKE_ONLY');a.equal(smoke.rows.length,40);a(smoke.rows.every(x=>x.maxAbs===0));a.equal(smoke.planSha256,fh(gcc+'/gcc-live-profile-smoke-plan-v1.json'));
 bound('dev-harness/semantic/scalar-live-gcc-smoke.cjs',smokePlan.sourceSha256,'gcc-factory-smoke-source');
 for(const x of smokePlan.bindings){if(/\.(?:exe|dll|gguf|onnx|safetensors)$/i.test(x.file)){skippedAssetBindings.push(x);continue;}bound(x.file,x.sha256,'gcc-factory-frozen-source');}
 a.equal(smoke.cleanup.coarse.cleanupStatus,'observed');a.equal(smoke.cleanup.coarse.workerExited,true);a.equal(smoke.cleanup.scalar.cleanupStatus,'observed');a.equal(smoke.cleanup.scalar.workerExited,true);a(Number.isFinite(smoke.scalar.score));
 add(gcc+'/gcc-live-profile-smoke-plan-v1.json','gcc-factory-smoke');add(gcc+'/gcc-live-profile-smoke-v1.json','gcc-factory-smoke');
});
const longOld='output/semantic-scalar-long-field-repro-v1/receipt.json',longFile='output/semantic-scalar-long-field-repro-v2/receipt.json',windowFile='output/semantic-scalar-window-long-field-v1/receipt.json';
const long=read(longFile),win=read(windowFile);
check('long field corrected raw witness and fixed-window fake proof',()=>{
 bound(longOld,'885a6f17ba4cfa7ff4d90115438e7821b407b59fc377193473d7330ff589ca17','historical-misjudgment','unused');
 entries.get(longOld).status='INVALID_VERDICT_ASSUMPTION_SUPERSEDED_BY_REPRO_V2_RAW_OBSERVATIONS_RETAINED';
 bound(longFile,'6f06b3163ef7217b4b86166e8e56948ebc2bb5434b973cd39ea327444499c7df','long-field-repro');
 bound(windowFile,'3cacf43fdb9654f74ef6a155ce469207a8faf4ce22ad5f7c9df3f5940f670162','fixed-window-proof');
 bound('dev-harness/semantic/scalar-long-field-repro.cjs',long.scriptSha256,'long-field-source');bound('dev-harness/semantic/scalar-window-long-field-proof.cjs',win.scriptSha256,'fixed-window-source');
 for(const [r,folder]of [[long,'output/semantic-scalar-long-field-repro-v2'],[win,'output/semantic-scalar-window-long-field-v1']]){a.equal(r.modelStarts,0);a.equal(r.tokens.fullJointTokens,1281);a.equal(r.tokens.first96JointTokens,115);bound(folder+'/producer.cjs',r.derivedProducerSha256,'fixed-derived-source');}
 a.equal(long.runs.length,2);a(long.runs.every(x=>x.resultCount===0&&x.semantic.coverage==='partial'));
 a.equal(win.runs.length,2);a(win.runs.every(x=>x.resultCount===1&&x.semantic.coverage==='complete'&&!x.lexical.partial));a.equal(win.scalarInputs.length,1);a.equal(win.scalarInputs[0].characters,96);
 bound('dev-harness/semantic/scalar-composite-policy-research.cjs',long.policySha256,'old-fullfield-policy-source');bound('dev-harness/semantic/scalar-window-policy-research.cjs',win.policySha256,'fixed-window-source');
 bound('ruyi-workbench/app/src/06ha-semantic-retrieval.js',long.semanticSourceSha256,'frozen-core-source');
 add('dev-harness/semantic/scalar-producer-research-source.cjs','old-fullfield-source');add('dev-harness/semantic/scalar-window-producer-research-source.cjs','fixed-window-source');
});
const rootWindowFile='output/semantic-window-append-root-review-r1.json',rootWindow=read(rootWindowFile);
check('append frozen16 plus root grouped16/22 and baseline mistaken assertion retained',()=>{
 bound(rootWindowFile,'7eec87fc04de00cc78869ca61cd3c14369aaeb580306027dda4dbb2c0560a659','root-window-append-review');
 for(const x of rootWindow.bindings)bound(x.file,x.sha256,'window-append-frozen-source');
 a.equal(rootWindow.independentRuns[0].pass,16);a.equal(rootWindow.independentRuns[1].pass,22);a(rootWindow.independentRuns.every(x=>x.fail===0&&x.skip===0&&x.exit===0));
 add('output/semantic-window-append-root-review-r1.cjs','root-review-source');
 bound('output/semantic-window-append-cache-research-v1.log','4952c91fccf070d3f5c87d1cde0b13f20dd406dfb8fd6828a523cfede8b8a8b0','append16-test-log');
 bound('output/semantic-message-append-cache-independent-v2.cjs','1d2b465a920630ad929d7c9d64e028cc2ee36365036e3970d1820b9db59e61ae','append-independent-source');
 bound('output/semantic-message-append-cache-independent-v2.json','f613502629394e87c43a8c514e1a15e1cd0a2d2b85b0fe1e7aaff1244f410fc7','append-independent-baseline');
 add('output/semantic-message-append-cache-independent-v1.json','historical-misjudgment','ASSERTION_ERROR_SUPERSEDED_BY_INDEPENDENT_V2_NOT_PRODUCT_FAILURE');add('output/semantic-message-append-cache-independent-v1.cjs','historical-source');add('output/semantic-message-append-cache-repro-v1.json','append-original-baseline');
});
check('real Job and synthetic HTTP fault proof is not GGUF fault injection',()=>{
 const file='output/semantic-gcc-coarse-real-fault-v1.json',r=read(file);bound(file,'1d3bec06f0b528294be1bff116495a39bbafc7c15ff8f2da53ca5b63a7935d36','job-http-synthetic-fault');
 bound('dev-harness/semantic/gcc-coarse-native-real-fault.cjs','70fccc3ac76e78cb92a1c65e5468805f29bd5fbf6f2df100fdd76e09dde1be41','job-http-synthetic-fault-source');
 a.equal(r.status,'PASS_SYNTHETIC_REAL_JOB_AND_HTTP_ONLY');a.equal(r.cases.length,2);a(r.cases.every(x=>x.caught&&x.embedding===false&&x.cleanup.cleanupStatus==='observed'&&x.cleanup.workerExited));bound('dev-harness/semantic/gcc-coarse-native-research.cjs',r.sourceSha256);
});
add('dev-harness/semantic/archive-gcc-window-append-evidence.cjs','archive-tool');
const credentialFlags=[];
function scan(v,p,file){if(Array.isArray(v)){v.forEach((x,i)=>{if(typeof x==='string'&&/^--api[-_]?key(?:-file)?$/i.test(x)&&i+1<v.length)credentialFlags.push({file,path:p+'['+(i+1)+']'});scan(x,p+'['+i+']',file);});}else if(v&&typeof v==='object'){for(const [key,x]of Object.entries(v)){if(/^(api[-_]?key|authorization|bearer|access[-_]?token)$/i.test(key)&&x)credentialFlags.push({file,path:p+'.'+key});scan(x,p+'.'+key,file);}}else if(typeof v==='string'&&/Bearer\s+[A-Za-z0-9_-]{12,}|--api[-_]?key(?:\s+|=)\S+|sk-[A-Za-z0-9_-]{28,}|hf_[A-Za-z0-9]{28,}/i.test(v))credentialFlags.push({file,path:p});}
for(const x of entries.values()){a(!/acceptance-v6|\.exe$|\.dll$|\.gguf$|\.onnx$|\.zip$|\.obj$/.test(x.source));const data=fs.readFileSync(at(x.source));a(data.length<=16*1024*1024);if(x.source.endsWith('.json'))scan(JSON.parse(data),'$',x.source);}
if(credentialFlags.length){fs.writeFileSync(at('output/gcc-window-append-sensitive-inputs.json'),JSON.stringify(credentialFlags,null,2)+'\n',{flag:'wx'});throw Error('Sensitive JSON inputs; report root before archival.');}
fs.mkdirSync(at(out));const records=[];
for(const [i,x]of [...entries.values()].entries()){const raw=fs.readFileSync(at(x.source)),gz=z.gzipSync(raw,{level:9,mtime:0});a(z.gunzipSync(gz).equals(raw));const archive=out+'/'+String(i+1).padStart(3,'0')+'-'+path.basename(x.source)+'.gz';fs.writeFileSync(at(archive),gz,{flag:'wx'});a.equal(fh(x.source),hash(raw));records.push({...x,archive,bytes:raw.length,sha256:hash(raw),gzipBytes:gz.length,gzipSha256:hash(gz)});}
const manifest={schema:1,createdAt:new Date().toISOString(),status:'GCC_FIXED_DEVELOPMENT_SMOKE_WINDOW_APPEND_SCOPED_PROOFS_NOT_RELEASE',checks,records,assetBindingsPreservedAsMetadataOnly:skippedAssetBindings,
 gccDevelopment:{documents:60,queries:248,newScalarPairs:128,threshold:.95,rawK:1,trainPositive:72,calibrationPositive:24,pureOod:80,idMismatch:24,developmentResults:rootReview.results,compilerEquivalent:false},
 factorySmoke:{encodes:40,uniqueDocuments:10,uniqueTrainQueries:10,orders:2,maxAbs:0,scalarSmoke:true,finalCleanup:smoke.cleanup,bodyStatsAreNotFinalExitProof:true},
 longField:{oldVerdictMisjudgmentPreserved:true,fullTokens:1281,windowTokens:115,oldFullfield:{resultsPerRun:[0,0],partial:true},fixedWindow:{resultsPerRun:[1,1],complete:true,actualScalarInputs:1,characters:96,modelInference:false}},
 append:{tests:16,rootGroups:[16,22],overlap:6,notClaimed38Unique:true,scope:'Only ordinary-message encoding identity excludes session-wide authority changes; scope/model/purpose/normalizer/canonical text/row revision/window remain. Metadata/attachments retain old keys. Authority/citation validation remains every use.'},
 faultProof:{cases:2,realWindowsJobAndHttp:true,syntheticNodeEndpoint:true,modelAssetValidation:false,actualGgufFaultTest:false,embeddingWrites:0,cleanup:'observed'},
 limits:['GCC is a separate fixed development profile, not MSVC numerical equivalence; earlier comparison RED and priorv6 decision remain.', 'Factory smoke validates selected forward/reverse vectors and normal scalar/ownership, not complete actual consumers, cold/idle/disable,1000-fragment or combined residency.', 'Long-field/window/append tests inject coarse/scalar encoders. Official tokenizer counts are real; no model inference in those proofs. Their live effect remains pending.', 'Root16 and22 grouped runs have6 overlaps; no38unique claim. Root receipt is a frozen historical proof; changing live runner/layout and runner tests are not archived.', 'Old longfieldNOT_REPRODUCED verdict and appendv1 assertion error remain with explicit superseding interpretation; original observations are not rewritten.', 'No candidate binary/weight was read or copied; their producer hash bindings are metadata only. Archived code/data source hashes were rechecked.', 'No v6 query/fixture or mutable live runner/layout was read, no model/compile/install/default/production/gate status changed by archival.']};
const file=out+'/manifest.json';fs.writeFileSync(at(file),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:file,sha256:fh(file),records:records.length,checks:checks.length,rawBytes:records.reduce((s,x)=>s+x.bytes,0),gzipBytes:records.reduce((s,x)=>s+x.gzipBytes,0),credentialFlags:credentialFlags.length}));
