'use strict';
// Public synthetic inputs, actual strict provider and production transport/scorer.
// Consumer registrations/config are synthetic; this does not qualify HTTP/source/quality.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),cp=require('node:child_process'),assert=require('node:assert/strict'),{promisify}=require('node:util');
const ROOT=path.resolve(__dirname,'../..'),PROFILE=path.join(ROOT,'output/embeddinggemma2-live-host-profile-v1');
const PIN='df0842983e334a247b96c8d010afaf7d6dca5225e729ada75a26d36cbf1268e6',MODEL='sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e';
const H=b=>crypto.createHash('sha256').update(b).digest('hex'),modules=['06h9-semantic-policy.js','06ha-semantic-retrieval.js','06hb-semantic-runtime.js'];
function read(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function verifyBindings(f){for(const r of f.bindings){const b=fs.readFileSync(r.file);assert.equal(b.length,r.bytes,r.file);assert.equal(H(b),r.sha256,r.file);}}
async function osIdentity(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);const script='$p=Get-Process -Id '+pid+' -ErrorAction SilentlyContinue;if($p){[ordered]@{exists=$true;pid=$p.Id;creationFileTime=[string]$p.StartTime.ToUniversalTime().ToFileTimeUtc()}|ConvertTo-Json -Compress}else{[ordered]@{exists=$false;pid='+pid+'}|ConvertTo-Json -Compress}';const {stdout}=await promisify(cp.execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,encoding:'utf8'});return JSON.parse(stdout.trim());}
async function profile(){assert.equal(H(fs.readFileSync(path.join(PROFILE,'asset-lock.json'))),PIN);const lock=read(path.join(PROFILE,'asset-lock.json')),C=require(path.join(ROOT,'ruyi-workbench/semantic-runtime/gemma2-profile-validation.cjs')).validate(lock);await C.verify(lock);return {C,lock};}
async function freeze(directory){
  directory=path.resolve(directory);assert.ok(directory.startsWith(path.join(ROOT,'output')+path.sep));assert.equal(fs.existsSync(directory),false);
  await profile();const inputs=[...modules.map(n=>path.join(ROOT,'ruyi-workbench/app/src',n)),__filename,path.join(ROOT,'dev-harness/semantic/gemma2-transport-proof-smoke-keeper.ps1'),path.join(ROOT,'ruyi-workbench/semantic-runtime/gemma2-provider.cjs'),path.join(ROOT,'ruyi-workbench/semantic-runtime/gemma2-profile-validation.cjs'),path.join(PROFILE,'asset-lock.json'),process.execPath];
  const bindings=inputs.map(file=>{const b=fs.readFileSync(file);return {file,bytes:b.length,sha256:H(b)};});
  const f={schema:1,status:'FROZEN_PUBLIC_SYNTHETIC_TRANSPORT_AUTHORITY_SMOKE_NOT_RUN',directory,bindings,profileLockSha256:PIN,modelFingerprint:MODEL,deadlineMs:90000,
    cases:['public warm ready','real strict runtime/scorer score certificate','cached score certificate','clone/query/scope replay denied','fake runtime cannot obtain production seal','disable invalidates cached scorer and previously issued score certificates','normal shutdown observed'],
    scope:'Actual production06h9/06ha/06hb and genuine strict Gemma2 provider/worker; synthetic VM config and four consumer registration labels. No HTTP/source/DPAPI/quality/hard-parent-exit qualification.'};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'OWNER.json'),JSON.stringify({owner:'gemma2-production-transport-proof-smoke',synthetic:true})+'\n',{flag:'wx'});const file=path.join(directory,'freeze.json');fs.writeFileSync(file,JSON.stringify(f,null,2)+'\n',{flag:'wx'});return {file,sha256:H(fs.readFileSync(file))};
}
async function run(file,pin){
  assert.equal(H(fs.readFileSync(file)),pin);const f=read(file);assert.equal(f.status,'FROZEN_PUBLIC_SYNTHETIC_TRANSPORT_AUTHORITY_SMOKE_NOT_RUN');verifyBindings(f);const {C,lock}=await profile();
  const homes=path.join(PROFILE,'resident-homes'),emptyHomes=()=>!fs.existsSync(homes)||fs.readdirSync(homes).length===0;assert.ok(emptyHomes(),'Existing home is not adopted or deleted');
  fs.writeFileSync(path.join(f.directory,'CONSUMED'),JSON.stringify({freezeSha256:pin,at:new Date().toISOString()})+'\n',{flag:'wx'});
  const receipt={schema:1,status:'RUNNING',freezeSha256:pin,scope:f.scope,cases:[],identities:[]};let hooks,watchdog;
  try{
    let config={semanticRetrievalV1:true,workDataEncryptionV1:false};hooks={};
    const context=vm.createContext({require,Buffer,Date,setTimeout,clearTimeout,WeakRef,SemanticRuntimeHooks:hooks,process:{env:{...process.env,RUYI_DISABLE_SEMANTIC:'0',RUYI_SEMANTIC_BACKEND:'gemma2',RUYI_SEMANTIC_GEMMA2_ROOT:PROFILE,RUYI_SEMANTIC_GEMMA2_LOCK_SHA256:PIN},execPath:process.execPath,platform:process.platform},readConfig:async()=>config,externalRoot:()=>path.join(ROOT,'ruyi-workbench'),isPkg:()=>false,fs,path,cp});
    for(const name of modules)vm.runInContext(fs.readFileSync(path.join(ROOT,'ruyi-workbench/app/src',name),'utf8'),context);
    vm.runInContext("for(const kind of ['session','memory','observation-snapshot','observation-message'])SemanticPolicyConsumers.add(kind);",context);
    const S=vm.runInContext('SemanticRetrieval',context),W=vm.runInContext('SemanticOriginalWindows',context);
    watchdog=setTimeout(()=>{void hooks.shutdown().catch(()=>{});},f.deadlineMs);watchdog.unref?.();
    const warm=await hooks.prewarm();assert.equal(warm.available,true);assert.equal(hooks.descriptor().policyReady,true);const identity=hooks.identity();assert.ok(identity?.creationFileTime);const initialOs=await osIdentity(identity.pid);assert.equal(initialOs.exists,true);assert.equal(initialOs.creationFileTime,identity.creationFileTime);receipt.identities.push(identity);receipt.initialOs=initialOs;receipt.cases.push({case:'public warm ready',passed:true});
    const scorer=S.create(hooks),query='A public local runtime lifecycle check.',docs=['Public documentation describes a local model lifecycle.'],scopeId='public-synthetic-transport',identities=[['public-document',0,docs[0].length]];
    const policyContext=W.createRequest({query,scopeId,modelFingerprint:MODEL}),options={scopeId,identities,policyContext,purpose:'search',beforeEncode:async()=>{assert.equal(config.semanticRetrievalV1,true);}};
    const result=await scorer.score(query,docs,options);assert.equal(result.coverage.complete,true);const proof=S.readScoreEvidence(result,{query,scopeId,modelFingerprint:MODEL});assert.equal(proof.scores.length,1);assert.ok(Number.isFinite(proof.scores[0]));
    receipt.cases.push({case:'strict runtime score certificate',passed:true,score:proof.scores[0]});
    const cached=await scorer.score(query,docs,options);assert.equal(cached.coverage.complete,true);assert.deepEqual(Array.from(S.readScoreEvidence(cached,{query,scopeId,modelFingerprint:MODEL}).scores),Array.from(proof.scores));receipt.cases.push({case:'cached score certificate',passed:true});
    for(const [value,q,s]of [[{...result},query,scopeId],[result,query+' changed',scopeId],[result,query,scopeId+' changed']])assert.throws(()=>S.readScoreEvidence(value,{query:q,scopeId:s,modelFingerprint:MODEL}));
    receipt.cases.push({case:'clone/query/scope replay denied',passed:true});
    let fakeCalls=0;const fake={prepare:async()=>({available:true,modelId:'embeddinggemma-2-text-q4',modelFingerprint:MODEL,policyReady:true,retrievalThresholds:{search:.7,automatic:null}}),encode:async texts=>{fakeCalls++;return {ok:true,modelFingerprint:MODEL,vectors:texts.map(()=>[1,...Array(767).fill(0)])};}};
    let fakeResult=null,fakeError=false;try{fakeResult=await S.create(fake).score(query,docs,{scopeId,identities,purpose:'rerank'});}catch{fakeError=true;}
    assert.ok(fakeError||!S.hasScoreEvidence(fakeResult));if(fakeResult)assert.throws(()=>S.readScoreEvidence(fakeResult,{query,scopeId,modelFingerprint:MODEL}));receipt.cases.push({case:'fake runtime seal denied',passed:true,fakeCalls});
    const before=config;config={...config,semanticRetrievalV1:false};const stopped=await hooks.configChanged(before,config);assert.equal(stopped.cleanupStatus,'observed');assert.equal(stopped.workerExited,true);assert.equal(hooks.identity(),null);assert.ok(emptyHomes());for(const old of [result,cached])assert.throws(()=>S.readScoreEvidence(old,{query,scopeId,modelFingerprint:MODEL}));const after=await scorer.score(query,docs,{...options,beforeEncode:async()=>{assert.equal(config.semanticRetrievalV1,false);}});assert.equal(after.coverage.complete,false);assert.ok(!S.hasScoreEvidence(after));receipt.cases.push({case:'disable invalidates cache and issued certificates',passed:true,cleanupStatus:stopped.cleanupStatus});
    receipt.status='PASS_GENUINE_PRODUCTION_TRANSPORT_SCORER_SCOPED_NOT_FULL_APP';
  }catch(e){receipt.status='FAIL_TRANSPORT_PROOF_NO_RETRY';receipt.errorCode=e?.code||e?.message||'unknown';}
  finally{
    clearTimeout(watchdog);if(hooks)try{receipt.cleanup=await hooks.shutdown();receipt.homesEmpty=emptyHomes();if(receipt.cleanup.cleanupStatus!=='observed'||receipt.cleanup.workerExited!==true||!receipt.homesEmpty)receipt.status='FAIL_TRANSPORT_CLEANUP';}catch(e){receipt.status='FAIL_TRANSPORT_CLEANUP';receipt.cleanupErrorCode=e?.code||e?.message||'unknown';}
    for(const identity of receipt.identities)try{const observed=await osIdentity(identity.pid);assert.ok(!observed.exists||observed.creationFileTime!==identity.creationFileTime);(receipt.finalOs||=[]).push({identity,observed});}catch(e){receipt.status='FAIL_TRANSPORT_OS_OBSERVATION';receipt.osError=e?.code||e?.message||'unknown';}
    try{verifyBindings(f);await C.verify(lock);receipt.bindingsStable=true;}catch(e){receipt.status='FAIL_TRANSPORT_BINDING_DRIFT';receipt.bindingError=e?.code||e?.message||'unknown';}
    const out=path.join(f.directory,'receipt.json');fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  }
  return {status:receipt.status,cases:receipt.cases.length,cleanup:receipt.cleanup,bindingsStable:receipt.bindingsStable,receiptSha256:H(fs.readFileSync(path.join(f.directory,'receipt.json')))};
}
if(require.main===module){const [mode,...args]=process.argv.slice(2);Promise.resolve().then(()=>mode==='freeze'?freeze(...args):mode==='run'?run(...args):Promise.reject(Error('freeze <new output> or run <freeze> <sha>'))).then(r=>{console.log(JSON.stringify(r));if(r.status?.startsWith('FAIL'))process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});}module.exports={freeze,run};
