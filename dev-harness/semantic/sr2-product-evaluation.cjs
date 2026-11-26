'use strict';
// Evaluate the shipped scorer through the encrypted source owner and UI disclosure path.
require('../lib/self-isolate-home');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {fixture} = require('../lib/fulltext-consumer-fixture');
const [mode, packageRoot, output, holdout] = process.argv.slice(2);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtureHash = '63a03095d788dbf4cb0275037145cb6584cb971501f42ccd9999456d55e89dc3';
const topics = ['delivery schedule','garden watering','inventory records','camera lenses','building insulation','railway routes','book lending','weather station','office supplies','bicycle repair'];
async function main() {
  assert.ok(['smoke','performance','sustained','quality','quality-warm'].includes(mode));
  const server = path.resolve(packageRoot,'app/server.js');
  const bytes = fs.readFileSync(server);
  assert.equal(sha(bytes),sha(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/server.js'))));
  const handle = fs.openSync(output,'wx');
  const report = {mode,serverSha256:sha(bytes),samples:[],encryptedSource:true,privacy:'enhanced',model:null};
  const save = () => fs.writeFileSync(output, JSON.stringify(report,null,2)+'\n');
  fs.closeSync(handle);
  let f, runtime;
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'sr2-home-'));
  try {
    process.env.RUYI_HOME=home;
    process.env.WIN_CLAUDE_WORKBENCH_HOME=home;
    delete process.env.RUYI_SEMANTIC_GEMMA2_ROOT;
    delete process.env.RUYI_SEMANTIC_GEMMA2_LOCK_SHA256;
    process.env.RUYI_DISABLE_SEMANTIC='0';
    const mod = new Module(server,module);
    mod.filename=server; mod.paths=Module._nodeModulePaths(path.dirname(server));
    mod._compile(bytes.toString()+'\nmodule.exports.sr2={SemanticRuntimeHooks,SemanticRetrieval,SemanticRuntimeTransportProof,SemanticOriginalWindows,SemanticWindowPolicy};',server);
    const ports=mod.exports.sr2;
    runtime=ports.SemanticRuntimeHooks;
    const cold=performance.now();
    let ready;
    do {
      ready=await runtime.prepare({deadline:Date.now()+(mode==='sustained'?60000:15000)});
      if(ready.available || (ready.state!=='loading' && mode!=='sustained'))break;
      await new Promise(r=>setTimeout(r,100));
    } while(performance.now()-cold<(mode==='sustained'?90000:30000));
    assert.equal(ready.available,true,JSON.stringify(ready));
    assert.equal(ready.modelId,'embeddinggemma-2-text-q4');
    report.coldReadyMs=performance.now()-cold; report.model=ready.modelFingerprint;
    let timings=[];
    f=await fixture({enabled:true,privacy:'enhanced'});
    Object.assign(f.context,ports,{SemanticRuntimeHooks:{...runtime,encode:async(texts,options)=>{
      const start=performance.now();
      try{return await runtime.encode(texts,options);}
      finally{if(options.role==='query')timings.push(performance.now()-start);}
    }}});
    let corpus;
    if(mode.startsWith('quality')){
      assert.equal(sha(fs.readFileSync(holdout)),fixtureHash);
      report.fixtureSha256=fixtureHash;
      corpus=require(path.resolve(holdout));
      assert.equal(corpus.documents.length,96); assert.equal(corpus.queries.length,268);
    }
    const map=new Map();
    const n=mode.startsWith('quality')?96:mode==='smoke'?2:25;
    for(let i=0;i<n;i++){
      const sid='S'+String(i).padStart(3,'0');
      const texts=corpus?[corpus.documents[i].text]:Array.from({length:mode==='smoke'?2:40},(_,j)=>topics[(i+j)%topics.length]+' notes for inspection batch '+i+' section '+j);
      map.set(sid,corpus?corpus.documents[i].id:sid);
      await f.put(sid,texts.map((content,j)=>({role:'user',id:'m'+j,turnSeq:1,content})),{head:{title:'',summary:'',cwd:''}});
    }
    const build=performance.now();
    await f.index.prepare(null);
    report.indexBuildMs=performance.now()-build;
    async function search(q) {
      timings=[];const start=performance.now();
      const r=await f.ui(q,null,()=>f.hooks.search(q,5));
      return {ms:performance.now()-start,encodeMs:timings.slice(),status:r.semantic?.status,coverage:r.semantic?.coverage,fragments:r.semantic?.candidateFragments,cached:r.semantic?.cachedFragments,policy:r.semantic?.admission?.policyId,top:r.results.map(v=>map.get(v.reference?.sessionId??v.id))};
    }
    const warm=performance.now();
    report.prewarm=[];
    do {
      let r;
      try { r=await search('inspection notes for maintenance'); }
      catch(error){
        report.prewarm.push({error:error.message});
        if(mode!=='sustained' && mode!=='quality-warm')break;
        await new Promise(resolve=>setTimeout(resolve,500));
        continue;
      }
      const {top,...counts}=r; report.prewarm.push(counts); if(mode==='sustained')save();
      assert.equal(r.policy,'embeddinggemma2-global-eligible-k1-cos070-window-v1');
      if(r.coverage==='complete'||(mode==='quality-warm' && r.cached===r.fragments && r.cached>0))break;
    } while(performance.now()-warm<(mode==='sustained'?300000:mode==='quality-warm'?180000:30000));
    report.prewarmMs=performance.now()-warm;
    const queries=corpus?corpus.queries:Array.from({length:mode==='smoke'?2:20},(_,i)=>({text:'Which '+topics[i%10]+' tasks need '+(i<10?'inspection':'additional review')+'?',group:'performance'}));
    for(const q of queries){
      let r;
      try { r=await search(q.text); }
      catch(error){report.samples.push({group:q.group,kind:q.kind,error:error.message});save();continue;}
      assert.ok(r.top.every(Boolean));
      const rank=corpus?r.top.findIndex(id=>q.relevant?.includes(id))+1:undefined;
      const {top,...metrics}=r;
      report.samples.push({...metrics,group:q.group,kind:q.kind,hits:top.length,rank});
      save();
    }
    report.completed=true;
  } catch(e){report.error=e.message;throw e;}
  finally{save();if(runtime)await runtime.shutdown();if(f)await f.close();fs.rmSync(home,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
