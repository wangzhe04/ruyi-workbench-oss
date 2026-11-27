'use strict';
// Retrospective attribution on an already consumed holdout. No threshold or product admission.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const readline=require('node:readline');
const assert=require('node:assert/strict');
const [mode,root,profile,file,output,matrixOutput]=process.argv.slice(2);
async function main(){
  const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
  const fixtureSha256=digest(fs.readFileSync(file));
  assert.equal(fixtureSha256,'63a03095d788dbf4cb0275037145cb6584cb971501f42ccd9999456d55e89dc3');
  const corpus=require(path.resolve(file));
  const node=path.join(root,'runtime/node/node.exe');
  let settings={command:node,args:[path.join(root,'semantic-runtime/worker.cjs'),'--root',path.join(root,'semantic-runtime')],cwd:root,env:process.env};
  let provider;
  if(mode==='gemma'){
    provider=require(path.join(root,'semantic-runtime/gemma2-provider.cjs')).create({enabled:()=>true,directory:profile,lockSha256:digest(fs.readFileSync(path.join(profile,'asset-lock.json'))),clientFactory:x=>x});
    settings=provider.settings();await provider.verify(settings,()=>{});
  } else assert.equal(mode,'minilm');
  const child=cp.spawn(settings.command,settings.args,{cwd:settings.cwd,env:settings.env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  const lines=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();
  async function read(){const line=await lines.next();assert.ok(!line.done);return JSON.parse(line.value);}
  try{
    const ready=await read();assert.equal(ready.ok,true);provider?.validateReady(ready);
    assert.equal(ready.modelId,mode==='gemma'?'embeddinggemma-2-text-q4':'paraphrase-multilingual-MiniLM-L12-v2');
    let seq=0,truncated=0;
    async function encode(role,texts){
      const out=[];
      for(let i=0;i<texts.length;i+=4){
        const requestId='batch'+(++seq);
        child.stdin.write(JSON.stringify({requestId,op:'encode',role,texts:texts.slice(i,i+4),deadlineMs:Date.now()+60000})+'\n');
        const r=await read();assert.equal(r.ok,true,r.error?.code);assert.equal(r.requestId,requestId);
        truncated+=r.truncated.filter(Boolean).length;out.push(...r.vectors);
      }
      return out;
    }
    const chunks=[];
    for(const [doc,d] of corpus.documents.entries()){
      for(let at=0;at<d.text.length;at+=80){
        chunks.push({doc,text:d.text.slice(at,at+96)});
        if(at+96>=d.text.length)break;
      }
    }
    const vectors=await encode('document',chunks.map(c=>c.text));
    const queries=await encode('query',corpus.queries.map(q=>q.text));
    const scores=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0)/(Math.hypot(...a)*Math.hypot(...b));
    const samples=corpus.queries.map((q,i)=>{
      const maxima=corpus.documents.map(()=>-Infinity);
      for(let j=0;j<vectors.length;j++){const doc=chunks[j].doc;maxima[doc]=Math.max(maxima[doc],scores(queries[i],vectors[j]));}
      const top=maxima.map((v,k)=>({v,k})).sort((a,b)=>b.v-a.v||a.k-b.k).slice(0,5);
      return {group:q.group,kind:q.kind,rank:top.findIndex(x=>q.relevant?.includes(corpus.documents[x.k].id))+1};
    });
    const comparisonTruncated = truncated;
    if (matrixOutput) {
      const { anchors, memoryCorpus } = require('./admission-dev-corpus.cjs');
      const references = await encode('document', anchors);
      function pool(name, corpus, chunks, vectors, queries) {
        const windows = chunks.map(chunk => corpus.documents[chunk.doc].id);
        return { name, windows, queries: corpus.queries.map((q, i) => ({
          group: q.group, kind: q.kind, relevant: q.relevant,
          scores: vectors.map(v => scores(queries[i], v)),
          referenceScores: references.map(v => scores(queries[i], v)),
        })) };
      }
      const development = memoryCorpus();
      const headers = development.documents.flatMap((d, doc) => {
        const rows = [];
        for (let at = 0; at < d.text.length; at += 80) {
          rows.push({ doc, text: d.text.slice(at, at + 96) });
          if (at + 96 >= d.text.length) break;
        }
        return rows;
      });
      const headerVectors = await encode('document', headers.map(h => h.text));
      const memoryQueries = await encode('query', development.queries.map(q => q.text));
      const pools = [pool('v7-r3', corpus, chunks, vectors, queries),
        pool('memory-128', development, headers, headerVectors, memoryQueries)];
      // Use the first service's five topics plus seven ordinary fields. Positives for excluded
      // fields do not become unanswerable controls. Their wording can still match retained fields.
      const smallFieldIds = new Set([...development.documents.slice(0, 5), ...development.documents.slice(40, 47)].map(d => d.id));
      const keep = headers.flatMap((h, i) => smallFieldIds.has(development.documents[h.doc].id) ? [i] : []);
      const full = pools[1];
      pools.push({ name: 'memory-12', windows: keep.map(i => full.windows[i]),
        queries: full.queries.filter(q => q.kind !== 'positive' || q.relevant.some(id => smallFieldIds.has(id)))
          .map(q => ({ ...q, scores: keep.map(i => q.scores[i]) })) });
      const matrix = { schema: 1, model: ready.modelId, fingerprint: ready.modelFingerprint, fixtureSha256,
        developmentCorpusSha256: digest(JSON.stringify(development)),
        anchorsSha256: digest(JSON.stringify(anchors)), truncatedEncodes: truncated, pools };
      const zlib = require('node:zlib');
      fs.writeFileSync(matrixOutput, zlib.gzipSync(JSON.stringify(matrix)), { flag: 'wx' });
    }
    fs.writeFileSync(output,JSON.stringify({model:ready.modelId,fingerprint:ready.modelFingerprint,fixtureSha256,documents:corpus.documents.length,windows:chunks.length,truncated:comparisonTruncated,method:'96 UTF-16 units, stride 80; maximum cosine per document, unconditional top 5; no answerability or product latency inference',samples},null,2)+'\n',{flag:'wx'});
  }finally{child.stdin.end();await closed;settings.onObservedExit?.();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
