'use strict';
// Explicit train/cal evidence archiving. No fixture/model execution or holdout access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),z=require('node:zlib'),a=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),root='output/semantic-qwen-reranker-official-v1',base='docs/optimization-plan/evidence/semantic-retrieval-20261116';
const out=base+'/s3c-scalar-development-reviewed-r1';
const read=f=>JSON.parse(fs.readFileSync(path.join(repo,f),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),fh=f=>hash(fs.readFileSync(path.isAbsolute(f)?f:path.join(repo,f)));
const evidence=[];const add=(prefix,files)=>evidence.push(...files.map(x=>prefix+'/'+x));
add(root,['calibration-protocol-v2.json','development-freeze-v2.json','development-pair-plan-v2.json','current90a-lexical-capture-v2.json','current90a-observed-index.cjs','repro/pair-plan-capture-v2.cjs','development-scalars-v1.json','development-selection-v1.json','minilm-train-cal-vectors-v1.json','qwen-prior-evidence-train-cal-vectors-v1.json','runtime/rank-buffer-t6.lock.json','erase-contract-rankbuffer-final.json']);
add('dev-harness/semantic',['qwen-reranker-calibration-protocol.cjs','qwen-reranker-native.cjs','qwen-reranker-development-collect.cjs','qwen-reranker-development-evaluate.cjs','qwen-reranker-pair-plan.cjs','qwen-reranker-erase-contract.cjs','native-job-launcher.cjs','native-job-host.cs','scalar-verifier-bridge-prototype.cjs','scalar-verifier-bridge-prototype.test.cjs','archive-scalar-development-evidence.cjs']);
add('output',['semantic-reranker-development-independent-r2.json','semantic-reranker-development-independent-r2.cjs','scalar-verifier-bridge-prototype-receipt-r1.json','scalar-verifier-bridge-prototype-receipt-r2.json','scalar-verifier-bridge-prototype-test-r3.log']);
// Only metadata/paragraph references, not DOCX/TXT/full paragraphs or terms bodies.
add('output/semantic-rank-redist-licenses-v1',['downloads.lock.json','extraction-r2.json','license-review-r1.json','deployment-plan-license-update-r1.json','final-receipt-r1.json']);
const checks=[];function check(name,fn){fn();checks.push({name,passed:true});}
const raw=read(root+'/development-scalars-v1.json'),selected=read(root+'/development-selection-v1.json'),plan=read(root+'/development-pair-plan-v2.json'),capture=read(root+'/current90a-lexical-capture-v2.json'),independent=read('output/semantic-reranker-development-independent-r2.json');
check('final explicit collector adapter evaluator and independent identities',()=>{
 a.equal(fh(root+'/development-selection-v1.json'),'d39c6a3e9f3e0ee716c18d71322470c93add734e6ed685c8ba65075fc1c8a0c4');
 a.equal(fh('output/semantic-reranker-development-independent-r2.json'),'b04d5a0a6ef7f407c7518b7f3413e7d17c25afc80c30d570dbfea80980d40dc5');
 a.equal(fh(root+'/development-scalars-v1.json'),'1c4f876f3363c80e89cb9e36ca801bf39b56831d196e18d5039e78fc2021909a');
 a.equal(raw.collectorSourceSha256,fh('dev-harness/semantic/qwen-reranker-development-collect.cjs'));
 a.equal(raw.adapterSourceSha256,fh('dev-harness/semantic/qwen-reranker-native.cjs'));
 a.equal(selected.evaluatorScriptSha256,fh('dev-harness/semantic/qwen-reranker-development-evaluate.cjs'));
 for(const x of read(root+'/development-freeze-v2.json').sources)a.equal(fh(x.file),x.sha256,x.file);
 for(const x of raw.sourceBindings)a.equal(fh(x.file),x.sha256,x.file);
 for(const [file,sha] of Object.entries(independent.hashes))a.equal(fh(file),sha,file);
 a.equal(raw.runtimeLockSha256,fh(root+'/runtime/rank-buffer-t6.lock.json'));
});
check('850 unique complete actual scalar records and observed cleanup',()=>{
 a.equal(raw.status,'COMPLETE_SCALAR_COLLECTION_NOT_QUALITY_VERDICT');a.equal(raw.pairs.length,850);a.equal(new Set(raw.pairs.map(x=>x.pairId)).size,850);
 a.equal(raw.coverage.complete,true);a.equal(raw.coverage.refusedPairs,0);a.equal(raw.guardCalls,4310);a.equal(Math.max(...raw.pairs.map(x=>x.jointTokens)),121);
 a(raw.pairs.every(x=>Number.isFinite(x.probability)&&x.probability>=0&&x.probability<=1&&x.jointTokens>0&&x.jointTokens<=512));
 a.equal(raw.cleanup.cleanupStatus,'observed');a.equal(raw.cleanup.workerExited,true);a.equal(raw.nativeStats.rankWrites,850);a.equal(raw.nativeStats.embeddingWrites,0);a.equal(raw.sourceBindingsStable,true);
 a.deepEqual(raw.pairs.map(x=>x.pairId).sort(),plan.pairs.map(x=>x.pairId).sort());
});
check('train/cal-only views and current90a capture source identity',()=>{
 a.equal(plan.queries.length,248);a(plan.queries.every(x=>['train','calibration'].includes(x.split)));
 a.equal(capture.scope,'train-calibration-only');a.equal(capture.sourceStable,true);a.equal(capture.observation.originalIndexSha256,'90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f');
 a(capture.rows.every(x=>['train','calibration'].includes(x.split)));
 const ids=plan.queries.map(x=>x.queryId).sort();a.equal(new Set(ids).size,248);a.deepEqual(capture.rows.map(x=>x.queryId).sort(),ids);
 for(const file of ['minilm-train-cal-vectors-v1.json','qwen-prior-evidence-train-cal-vectors-v1.json']){
  const view=read(root+'/'+file);a.equal(view.documents.length,60);a.deepEqual(view.queries.map(x=>x.id).sort(),ids);
 }
});
check('fixed36 development strategies selected qwenK1 scalar095 independently reproduced',()=>{
 a.equal(selected.candidates.length,36);a.equal(selected.passingPolicies,32);a.equal(selected.selected.profile,'qwen-k1');a.equal(selected.selected.threshold,.95);
 a.equal(independent.matchingPolicies,36);a.equal(independent.passing,32);a.equal(independent.strongEvidence,96);a.equal(independent.weakEvidence,7);
 a.equal(independent.selected.profile,selected.selected.profile);a.equal(independent.selected.threshold,.95);
 for(const split of ['train','calibration']){
  const x=selected.selected[split];a.equal(x.quality.all.recallAt5,1);a.equal(x.quality.all.mrr,1);a.equal(x.pureOod.anyResultFpr,0);a.equal(x.entityMismatch.anyResultFpr,0);
 }
 a.equal(selected.selected.train.quality.all.count+selected.selected.calibration.quality.all.count,96);
 a.equal(selected.selected.train.pureOod.count+selected.selected.calibration.pureOod.count,80);
 a.equal(selected.selected.train.entityMismatch.count+selected.selected.calibration.entityMismatch.count,24);
 a.equal(selected.selected.train.cost.requiredPairs+selected.selected.calibration.cost.requiredPairs,128);
});
check('bridge final fake18 source binding is not native hookup evidence',()=>{
 const r=read('output/scalar-verifier-bridge-prototype-receipt-r2.json');a.equal(r.status,'PASS_FAKE_PROTOTYPE_ONLY');a.equal(r.tests.count,18);a.equal(r.tests.failures,0);a.equal(r.tests.modelRuns,0);
 for(const [file,sha]of Object.entries(r.hashes))a.equal(fh(file),sha,file);
 a.equal(fh(r.supersedes.file),r.supersedes.sha256);
});
// Validate all input size/type before creating archive, avoiding partial publication.
for(const source of evidence){const b=fs.readFileSync(path.join(repo,source));a(b.length<=16*1024*1024,source);a(!/\.(gguf|onnx|safetensors|exe|dll|whl|zip|docx)$/i.test(source));a(!source.includes('acceptance-v6-fixture'));a(!/(?:sk-[A-Za-z0-9_-]{28,}|hf_[A-Za-z0-9]{28,}|ghp_[A-Za-z0-9]{28,}|(?:X-Amz-Signature|X-Xet-Cas-Uid)=[A-Za-z0-9+/]{16,})/i.test(b.toString('utf8')));}
fs.mkdirSync(path.join(repo,out));const records=[];
for(const [i,source]of evidence.entries()){
 const data=fs.readFileSync(path.join(repo,source)),gz=z.gzipSync(data,{level:9,mtime:0});a(z.gunzipSync(gz).equals(data));
 const archive=out+'/'+String(i+1).padStart(3,'0')+'-'+path.basename(source)+'.gz';fs.writeFileSync(path.join(repo,archive),gz,{flag:'wx'});a.equal(fh(source),hash(data));
 records.push({source,archive,sha256:hash(data),bytes:data.length,gzipSha256:hash(gz),gzipBytes:gz.length,status:source.endsWith('prototype-receipt-r1.json')?'SUPERSEDED_BY_PROTOTYPE_RECEIPT_R2':'CURRENT_SCOPED_EVIDENCE'});
}
// Copy freeze bytes only. Do NOT parse/load the v6 fixture or its queries.
const freezeSource='dev-harness/semantic/acceptance-v6/freeze.json',freezeDestination=base+'/v6-fixture-freeze.json',freezeBytes=fs.readFileSync(path.join(repo,freezeSource));
if(fs.existsSync(path.join(repo,freezeDestination)))a(fs.readFileSync(path.join(repo,freezeDestination)).equals(freezeBytes));else fs.writeFileSync(path.join(repo,freezeDestination),freezeBytes,{flag:'wx'});
const decision=base+'/v6-candidate-decision.json';a(fh(decision).startsWith('590176'));
const manifest={schema:1,createdAt:new Date().toISOString(),status:'REAL_SCALAR_TRAIN_CAL_SELECTED_NOT_INDEPENDENT_ACCEPTANCE_OR_PRODUCTION_QUALIFICATION',checks,records,
 v6FreezeCopy:{source:freezeSource,destination:freezeDestination,bytes:freezeBytes.length,sha256:hash(freezeBytes),fixtureQueriesOpened:false,fixtureExecuted:false,decision:{path:decision,sha256:fh(decision)}},
 development:{queries:248,documents:60,uniqueRealPairs:850,refused:0,maxJointTokens:121,guardCalls:4310,elapsedSeconds:(Date.parse(raw.finishedAt)-Date.parse(raw.startedAt))/1000,cleanup:'observed',fixedPolicies:36,passing:32,selected:{profile:'qwen-k1',threshold:.95,positiveCount:96,recallAt5:1,mrr:1,pureOodCount:80,pureOodFalsePositives:0,entityMismatchCount:24,entityMismatchFalsePositives:0,strongEvidence:96,weakEvidence:7,selectedPairBudget:128}},
 limits:['Train/cal candidate selection only; no v6 actual query opened, no check or other holdout used for selection by this archival task.', 'Root independent development r2 is final; any superseded prototype receipt is explicitly marked. Producer source hashes distinguish collector, adapter, evaluator and protocol.', 'Offline replay is limited to this synthetic single-lexical-source fixture; missing-field strong lexical returns do not establish answerability and do not dilute pure OOD denominator.', '850 actual scalar collection and211.9s run are not500ms/product end-to-end/combined two-model RSS qualification.', 'Bridge92ac source and18fake tests are unregistered research; native beforeVerify/beforeRerank transport wiring and four genuine consumers remain pending.', 'License archives contain only metadata, paragraph references, observations and planning gaps; complete Microsoft EULA DOCX/TXT/paragraph bodies remain ignored output and are not redistributed through this git evidence.', 'All SR remain pending, latest independent quality remains v5RED, and production/default/model manifest are unchanged.'],
 pending:['Four-entry native scalar bridge wiring','Real producer end-to-end replay and authority/privacy/source/cancel verification','Fresh independent v6 evaluation after fixed decision','1000-fragment fresh/repeat query performance with actual verifier counts','Two-model combined resources and lifecycle','New package/full regression and applicable redistribution grant']};
const file=out+'/manifest.json';fs.writeFileSync(path.join(repo,file),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({manifest:file,sha256:fh(file),records:records.length,checks:checks.length,rawBytes:records.reduce((n,x)=>n+x.bytes,0),gzipBytes:records.reduce((n,x)=>n+x.gzipBytes,0),v6Freeze:{path:freezeDestination,bytes:freezeBytes.length,sha256:hash(freezeBytes)},development:manifest.development}));
