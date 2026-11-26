'use strict';
// Controlled late delivery of genuine Gemma document vectors. Uses synthetic data only.
require('../lib/self-isolate-home');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const {fixture}=require('../lib/fulltext-consumer-fixture');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
  const server=path.resolve(process.argv[2],'app/server.js');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-slice-'));
  process.env.RUYI_HOME=process.env.WIN_CLAUDE_WORKBENCH_HOME=home;
  const mod=new Module(server,module);
  mod.filename=server;mod.paths=Module._nodeModulePaths(path.dirname(server));
  mod._compile(fs.readFileSync(server,'utf8')+'\nmodule.exports.slicePorts={SemanticRuntimeHooks,SemanticRuntimeTransportProof,SemanticWindowPolicy,SemanticRetrieval,SemanticOriginalWindows};',server);
  const ports=mod.exports.slicePorts, runtime=ports.SemanticRuntimeHooks;
  const f=await fixture({enabled:true,privacy:'enhanced'});
  try{
    const until=Date.now()+60000;
    let descriptor;
    do{descriptor=await runtime.prepare({deadline:until});if(!descriptor.available)await delay(100);}while(!descriptor.available&&Date.now()<until);
    assert.equal(descriptor.modelId,'embeddinggemma-2-text-q4');assert.equal(descriptor.available,true);
    const progress=process.argv[3]==='progress';
    let delayed=false, completedDocuments=0;
    const submitted=[];
    Object.assign(f.context,ports,{SemanticRuntimeHooks:{...runtime,encode:async(texts,options)=>{
      const dispatched=Date.now();
      if(progress && options.role==='document'){
        // Hold dispatch long enough to exhaust the scheduling slice. The real
        // transport still enforces its original absolute deadline and provenance.
        await delay(1100);
        submitted.push(texts.length);
      }
      const result=await runtime.encode(texts,options);
      if(result.ok && options.role==='document')completedDocuments+=texts.length;
      if(!progress && result.ok && options.role==='document' && !delayed){
        delayed=true;
        await delay(Math.max(0,dispatched+1020-Date.now()));
      }
      return result;
    }}});
    const records=['周日浇灌花园里的植物。','仓库每月清点一次库存。','出差报销时请同时提交车票和付款凭证。','公路自行车需要定期检查刹车。','暴雨过后检查屋顶是否漏水。','博物馆的门票可以提前预约。'];
    for(const [i,content] of records.entries())await f.put('S'+i,[{role:'user',id:'m'+i,content}]);
    await f.index.prepare(null);
    if(progress){
      const checkpoints=[];
      for(let i=0;i<records.length;i++){
        const result=await f.ui('Which receipts are required for business travel reimbursement?');
        checkpoints.push(result.semantic.cachedFragments);
        if(result.semantic.coverage==='complete'){
          assert.deepEqual(Array.from(result.results,row=>row.id),['S2']);
          break;
        }
      }
      console.log(JSON.stringify({checkpoints,submitted,completedDocuments}));
      assert.ok(checkpoints.every((n,i)=>n>(checkpoints[i-1]??0)));
      assert.equal(checkpoints.at(-1),records.length);
      assert.equal(completedDocuments,records.length);
      return;
    }
    const result=await f.ui('Which receipts are required for business travel reimbursement?');
    const ids=Array.from(result.results,row=>row.id);
    console.log(JSON.stringify({delayed,ids,status:result.semantic.status,coverage:result.semantic.coverage,cached:result.semantic.cachedFragments,total:result.semantic.candidateFragments}));
    assert.equal(delayed,true);assert.equal(result.semantic.coverage,'complete');assert.deepEqual(ids,['S2']);
  }finally{await runtime.shutdown();await f.close();fs.rmSync(home,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
