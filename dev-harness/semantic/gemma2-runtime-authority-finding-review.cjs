'use strict';
// Reproduce the retained pre-fix finding. Never runs the live app or a model.
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict'),path=require('node:path');
async function main(){
  const root=path.resolve(__dirname,'../..'),dir=path.join(root,'output/semantic-gemma2-root-runtime-authority-finding-r1');
  const source=fs.readFileSync(path.join(dir,'scorer-source.js')),finding=JSON.parse(fs.readFileSync(path.join(dir,'finding.json')));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'ff66e25cf3b5d776d07047f4c806fd13e1b0ca03eb70faaff7bd78e520652df3');
  assert.equal(finding.modelLoaded,false);assert.equal(finding.holdoutRead,false);
  const MODEL='sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e';
  const S=vm.runInNewContext(source.toString('utf8')+'\nSemanticRetrieval;',{require,Buffer,Date});let calls=0;
  const fake={prepare:async()=>({available:true,modelId:'embeddinggemma-2-text-q4',modelFingerprint:MODEL,policyReady:true,retrievalThresholds:{search:.7,automatic:null}}),
    encode:async texts=>{calls++;return {ok:true,modelFingerprint:MODEL,vectors:texts.map(()=>[1,...Array(767).fill(0)])};}};
  const result=await S.create(fake).score('public synthetic query',['public synthetic document'],{purpose:'rerank',scopeId:'public-synthetic-scope',identities:[['public synthetic source']]});
  const proof=S.readScoreEvidence(result,{query:'public synthetic query',scopeId:'public-synthetic-scope',modelFingerprint:MODEL});
  assert.equal(calls,2);assert.equal(proof.scores[0],1);
  console.log(JSON.stringify({status:'RETAINED_PRE_FIX_RUNTIME_AUTHORITY_FINDING_REPRODUCED',syntheticEncodes:calls,productionSealAccepted:true,modelLoaded:false,holdoutRead:false}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});module.exports={main};
