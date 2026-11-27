'use strict';
// Usage: pinned-node gemma-worker-qualification.cjs <pre-D5 checkout> <base profile> <consumed V7-R3 fixture> <new report> threads|geometry
// D5 qualification uses the frozen tokenizer, graph, normalization and output validation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const percentile = (values,q) => values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
async function main() {
  const [repo, profile, corpusFile, output, mode] = process.argv.slice(2);
  assert.ok(['threads','geometry'].includes(mode) && output && !fs.existsSync(output), 'require a mode and new report path');
  const fixtureHash=sha(fs.readFileSync(corpusFile));
  assert.equal(fixtureHash,'63a03095d788dbf4cb0275037145cb6584cb971501f42ccd9999456d55e89dc3');
  const corpus=require(path.resolve(corpusFile));
  const lockBytes=fs.readFileSync(path.join(profile,'asset-lock.json')),lock=JSON.parse(lockBytes);
  assert.equal(sha(lockBytes),'7edf09ad7e849a8e5f84402ce94fa522ed15ca0a4bd3e93186075d6f4af8950b');
  const contract=require(path.join(repo,'ruyi-workbench/semantic-runtime/gemma2-profile-validation.cjs')).validate(lock);
  await contract.verify(lock);
  assert.equal(sha(fs.readFileSync(process.execPath)),lock.node.sha256);
  const worker=require(lock.workerFile);
  const rt=createRequire(path.join(lock.runtimeRoot,'package.json'));
  const {Tokenizer}=rt('@huggingface/tokenizers'), ort=rt('onnxruntime-node');
  const asset=name=>JSON.parse(fs.readFileSync(path.join(lock.assetsRoot,name)));
  const config=asset('config.json'),tk=new Tokenizer(asset('tokenizer.json'),asset('tokenizer_config.json'));
  async function session(threads){
    return ort.InferenceSession.create(path.join(lock.assetsRoot,'onnx/model_q4.onnx'),{executionProviders:['cpu'],intraOpNumThreads:threads,interOpNumThreads:1,logSeverityLevel:4});
  }
  async function encode(handle,input){
    assert.ok(input.ids.length<=512,'token limit');
    const int=data=>new ort.Tensor('int64',BigInt64Array.from(data,BigInt),[1,data.length]);
    const empty=()=>new ort.Tensor('float32',new Float32Array(0),[0,512]);
    const out=await handle.run({input_ids:int(input.ids),attention_mask:int(input.mask),image_features:empty(),video_features:empty(),audio_features:empty()});
    return Float32Array.from(worker.validateOutput(out,input));
  }
  const report={kind:mode,fixtureHash,lockSha256:sha(lockBytes),model:contract.fingerprint(lock),node:process.version,
    availableParallelism:require('node:os').availableParallelism(),configurations:[]};
  if (mode==='threads') {
    const queries=corpus.queries.filter((q,i)=>i%2===0).slice(0,112);
    const samples=[...corpus.documents.map(d=>({role:'document',text:Array.from(d.text).slice(0,512).join('')})),...queries.map(q=>({role:'query',text:q.text}))];
    assert.ok(new Set(samples.map(x=>x.text)).size>=200);
    const inputs=samples.map(s=>worker.tokenize(s.text,s.role,tk,config)), lengths=inputs.map(i=>i.ids.length);
    Object.assign(report,{count:inputs.length,documents:corpus.documents.length,queries:queries.length,tokens:[Math.min(...lengths),percentile(lengths,.5),Math.max(...lengths)],sampleSha256:sha(JSON.stringify(samples)),eachConfigurationUsesFreshProcess:true});
    const childThreads=Number(process.argv[7]);
    if(childThreads) {
      assert.ok([1,2,3,4,6].includes(childThreads));
      const handle=await session(childThreads), vectors=[], timings=[];
      try {
        for(const input of inputs){
          const then=performance.now(),vector=await encode(handle,input);
          vectors.push(Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength));
          timings.push(performance.now()-then);
        }
      } finally { await handle.release(); }
      const packed=Buffer.concat(vectors);
      process.stdout.write(JSON.stringify({vectors:packed.toString('base64'),medianMs:percentile(timings,.5),p95Ms:percentile(timings,.95)}));
      return;
    }
    let reference;
    for(const n of [2,1,3,4,6]){
      const env={...process.env,OMP_NUM_THREADS:String(n),MKL_NUM_THREADS:String(n)};
      const result=require('node:child_process').spawnSync(process.execPath,[__filename,repo,profile,corpusFile,output,mode,String(n)],{env,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
      if(result.error) throw result.error;
      assert.equal(result.status,0,result.stderr);
      const sample=JSON.parse(result.stdout),bytes=Buffer.from(sample.vectors,'base64');
      assert.equal(bytes.length,inputs.length*768*4);
      if(!reference)reference=bytes;
      let maxAbs=0,nonidentical=0;
      for(let i=0;i<inputs.length;i++){
        const start=i*768*4,end=start+768*4;
        if(!bytes.subarray(start,end).equals(reference.subarray(start,end))) nonidentical++;
        for(let pos=start;pos<end;pos+=4) maxAbs=Math.max(maxAbs,Math.abs(bytes.readFloatLE(pos)-reference.readFloatLE(pos)));
      }
      const config={threads:n,nonidentical,maxAbs,sha256:sha(bytes),medianMs:sample.medianMs,p95Ms:sample.p95Ms};
      report.configurations.push(config);console.log(JSON.stringify(config));
    }
  } else if (mode==='geometry') {
    const handle=await session(2);
    try {
      const run=async(text,role)=>encode(handle,worker.tokenize(text,role,tk,config));
      const queries=[];for(const q of corpus.queries) queries.push(await run(q.text,'query'));
      const norm=v=>Math.sqrt(v.reduce((s,x)=>s+x*x,0));
      for(const size of [96,192,320]){
        const docs=[];let windows=0,maxTokens=0;
        for(const doc of corpus.documents){
          const parts=[];
          const trail = pos => doc.text.charCodeAt(pos) >= 0xdc00 && doc.text.charCodeAt(pos) <= 0xdfff;
          for(let s=0;s<doc.text.length;){
            let end=Math.min(s+size,doc.text.length);
            if(end<doc.text.length && trail(end)) end--;
            const t=doc.text.slice(s,end),input=worker.tokenize(t,'document',tk,config);
            maxTokens=Math.max(maxTokens,input.ids.length);
            const v=await encode(handle,input);parts.push({v,norm:norm(v)});windows++;if(end===doc.text.length)break;
            s=end-16;if(trail(s))s--;
          }
          docs.push(parts);
        }
        const groups={};let positive=0,hit5=0,hit1=0,negative=0,fp=0,mrr=0;
        corpus.queries.forEach((row,i)=>{
          const q=queries[i],qn=norm(q);
          const fields=docs.map((parts,j)=>({id:corpus.documents[j].id,score:Math.max(...parts.map(({v,norm})=>v.reduce((sum,x,k)=>sum+x*q[k],0)/(norm*qn)))})).sort((a,b)=>b.score-a.score);
          const top=fields.filter(f=>f.score>=.70).slice(0,5);
          const group=groups[row.group+'/'+row.kind]||={count:0,hits5:0,falsePositives:0,maxScores:[]};group.count++;group.maxScores.push(fields[0].score);
          if(row.kind==='positive'){positive++;const rank=top.findIndex(f=>row.relevant.includes(f.id))+1;if(rank){hit5++;group.hits5++;mrr+=1/rank;}if(rank===1)hit1++;}
          else{negative++;if(top.length){fp++;group.falsePositives++;}}
        });
        for(const group of Object.values(groups)){
          group.maxScoreQuantiles=[0,.5,.95,1].map(q=>q===0?Math.min(...group.maxScores):percentile(group.maxScores,q));
          delete group.maxScores;
        }
        const result={size,overlap:16,windows,maxTokens,positive,hit1,hit5,negative,fp,mrr:mrr/positive,groups};report.configurations.push(result);console.log(size,hit5,fp);
      }
    } finally{await handle.release();}
  } else throw Error('qualification mode required');
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
