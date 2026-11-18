'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const H=b=>crypto.createHash('sha256').update(b).digest('hex');
function main(){
  const root=path.resolve(__dirname,'../..');
  const dir=path.join(root,'output/semantic-gemma-q4-basic-guard-diagnostic-v1');
  const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8').replace(/^\uFEFF/,''));
  const contractBytes=fs.readFileSync(path.join(dir,'contract.json')), contract=JSON.parse(contractBytes);
  assert.equal(H(contractBytes),'2e0104d40bde7ed970101c46d1fcadcc7ac23cc52be368450a75584629384118');
  for(const b of contract.bindings){const raw=fs.readFileSync(b.file);assert.equal(raw.length,b.bytes,b.file);assert.equal(H(raw),b.sha256,b.file);}
  assert.equal(contract.bindings.length,186);
  const lines=n=>fs.readFileSync(path.join(dir,n),'utf8').trim().split(/\r?\n/).map(v=>JSON.parse(v));
  const basic=lines('basic-guard-diagnostic.jsonl');
  assert.deepEqual(basic,[{branch:'held-basic',scope:'rehearsal',path:'',fields:['time.access']}]);
  const stages=lines('backup-diagnostic.jsonl');
  for(const stage of ['seal','space','save-backup','rehearsal-absent','rehearsal-acquire']){
    assert.equal(stages.filter(x=>x.stage===stage&&x.event==='after').length,1);
  }
  assert.deepEqual(stages.at(-1),{stage:'restore',event:'error',errors:[{name:'Error',code:'work_data_full.restore_failed'},{name:'Error',code:'work_data_backup.metadata_changed'}]});
  const bootstrap=read('bootstrap-receipt.json'), outer=read('outer-job-receipt.json');
  assert.equal(bootstrap.bindingsStable,true);assert.equal(bootstrap.semanticOff.configSemanticEnabled,false);assert.equal(bootstrap.semanticOff.disableSemanticEnv,true);
  assert.equal(bootstrap.keeperCleanup.closeObserved,true);assert.equal(bootstrap.keeperCleanup.identityAbsent,true);assert.equal(bootstrap.keeperCleanup.unknown,false);
  assert.equal(bootstrap.trackedManager.unclosed,false);assert.equal(bootstrap.trackedManager.unverified,false);
  assert.equal(outer.controllerExitCode,0);assert.equal(outer.accounting.active,0);assert.deepEqual(outer.accounting.members,[]);
  assert.equal(outer.terminationRequested,true);assert.equal(outer.terminationCallSucceeded,true);
  const receipt={schema:1,status:'ROOT_REVIEWED_DIAGNOSTIC_COMPLETE_RESTORE_FAIL_NOT_PRODUCT_ACCEPTANCE',contractSha256:H(contractBytes),bindingsVerified:contract.bindings.length,rootSyntheticTests:9,
    basicMismatch:basic[0],lastStage:stages.at(-1),bootstrapReceiptSha256:H(fs.readFileSync(path.join(dir,'bootstrap-receipt.json'))),outerJobReceiptSha256:H(fs.readFileSync(path.join(dir,'outer-job-receipt.json'))),
    diagnosticsSha256:H(fs.readFileSync(path.join(dir,'basic-guard-diagnostic.jsonl'))),job:{active:0,members:[],historicalTotal:outer.accounting.totalProcesses,terminationRequested:true},
    limits:['Root reviewed all186 frozen input bytes and terminal metadata;9 synthetic transform tests independently passed.',
      'Derived immutable source, no live source dependency; tracing preserves original rejection. No model/search/generation publication.',
      'Held Basic mismatch is rehearsal root Access time; this identifies a field and location, not the actor or sufficient fix.',
      'Inner keeper observed closed; outer private Job reaped remaining owned cold process. Local ownershipUnknown is retained from incomplete inner discovery, not rewritten as normal shutdown.',
      'Actual backup restore and encrypted enable remain failed; all release gates pending.']};
  const out=path.join(dir,'root-review.json');assert.equal(fs.existsSync(out),false);fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:receipt.status,bindings:receipt.bindingsVerified,path:path.relative(root,out).replaceAll('\\','/'),sha256:H(fs.readFileSync(out))}));
}
if(require.main===module)main();module.exports={main};
