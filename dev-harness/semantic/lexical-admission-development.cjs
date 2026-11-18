'use strict';
// Replay REAL measured development vectors through the actual encrypted-source
// production index. This measures ranking/admission, not live-worker latency.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {fixture:sourceFixture}=require('../lib/fulltext-owned-producer-fixture');
const fixturePath=path.join(__dirname,'calibration-fixture.cjs'),corpus=require(fixturePath);
const root=path.resolve(__dirname,'../..'),src=name=>fs.readFileSync(path.join(root,'ruyi-workbench/app/src',name),'utf8');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const primitive=vm.runInNewContext(src('06ha-semantic-retrieval.js')+'\nSemanticRetrieval;',{require,Buffer,Date,setTimeout,clearTimeout});
const normalize=text=>text.normalize('NFKC').toUpperCase();
async function main(){
 const input=path.resolve(process.argv[2]||'output/semantic-calibration-v2-vectors.json'),output=path.resolve(process.argv[3]||'output/semantic-calibration-production-v1.json');
 if(fs.existsSync(output))throw Error('Prior evidence cannot be overwritten.');
 const encoded=JSON.parse(fs.readFileSync(input,'utf8'));if(encoded.status!=='PASS'||encoded.fixtureSha256!==hash(fs.readFileSync(fixturePath)))throw Error('Measured vector provenance mismatch.');
 const documentVectors=new Map(encoded.documents.map(row=>[row.id,row.vector])),queryVectors=new Map(encoded.queries.map(row=>[row.id,row.vector]));
 const byText=new Map(corpus.documents.map(doc=>[normalize(doc.text),doc.id])),byQuery=new Map(corpus.queries.map(query=>[query.text,query]));
 const requested=corpus.queries.filter(query=>query.split==='train'||query.split==='calibration');
 const f=await sourceFixture({enabled:true}),ids=new Map();
 const report={schemaVersion:1,status:'RUNNING',startedAt:new Date().toISOString(),fixtureSha256:encoded.fixtureSha256,measuredVectorsSha256:hash(fs.readFileSync(input)),modelFingerprint:encoded.ready.modelFingerprint,
  measuredNativeVectors:true,liveWorker:false,encryptedSources:true,scope:'development-train-calibration-only',sourceHashes:Object.fromEntries(['06ha-semantic-retrieval.js','13ap-session-fulltext-index.js'].map(name=>[name,hash(src(name))])),variants:{},
  limits:['Development only; root acceptance-v2 is never loaded.','Native vectors are replayed; this is not a live-worker or search-latency claim.','Production index only; generic fixture metadata does not model every public consumer UI metadata route.','Near-topic missing facts remain answerability diagnostics even when useful context is retrieved.']};
 const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n','utf8');
 f.hookContext.SemanticRetrieval=primitive;const namespace=vm.runInNewContext('SessionFullTextIndex',f.hookContext);
 const metrics=rows=>{
  const positive=rows.filter(row=>row.kind==='positive');
  const quality=values=>({count:values.length,recallAt5:values.length?values.filter(row=>row.rank>0).length/values.length:null,mrr:values.length?values.reduce((n,row)=>n+(row.rank?1/row.rank:0),0)/values.length:null});
  const rates=kinds=>{const values=rows.filter(row=>kinds.includes(row.kind));return{count:values.length,anyResultFpr:values.length?values.filter(row=>row.count>0).length/values.length:null,semanticOnlyResultFpr:values.length?values.filter(row=>row.semanticOnlyCount>0).length/values.length:null};};
  return{quality:{all:quality(positive),groups:Object.fromEntries([...new Set(positive.map(row=>row.group))].map(group=>[group,quality(positive.filter(row=>row.group===group))]))},searchNegatives:rates(['ood','entity-mismatch']),ood:rates(['ood']),entityMismatch:rates(['entity-mismatch']),unsupportedAnswerDiagnostics:rates(['missing-field','missing-number'])};
 };
 try{
  for(let i=0;i<corpus.documents.length;i++){const sid='CAL'+String(i).padStart(3,'0');ids.set(sid,corpus.documents[i].id);await f.put(sid,[{role:'user',id:'m1',content:corpus.documents[i].text}]);}
  const lexical=namespace.create({...f.host,resultUnit:'sessions'});await lexical.prepare(null);const lexicalIds=new Map();
  const runVariant=async(name,index)=>{const rows=[];for(const query of requested){const found=await index.search(query.text,null,50),all=found.results.map(hit=>({id:ids.get(hit.reference.sessionId),semantic:hit.semanticScore!==undefined,snippet:hit.snippet,reference:hit.reference,score:hit.score})),top=all.slice(0,5);
    if(name==='lexical')lexicalIds.set(query.id,new Set(all.map(hit=>hit.id)));
    const lexicalSet=lexicalIds.get(query.id)||new Set(),rank=top.findIndex(hit=>query.relevant.includes(hit.id))+1;
    rows.push({id:query.id,split:query.split,kind:query.kind,group:query.group,rank,count:top.length,semanticOnlyCount:top.filter(hit=>hit.semantic&&!lexicalSet.has(hit.id)).length,top,semantic:found.semantic});}
   report.variants[name]={metrics:metrics(rows),bySplit:Object.fromEntries(['train','calibration'].map(split=>[split,metrics(rows.filter(row=>row.split===split))])),rows};save();console.log(name+' complete');};
  await runVariant('lexical',lexical);
  for(const name of ['qwen-frozen-0.44']){
   const scorer={score:async(query,docs,options)=>{const record=byQuery.get(query);if(!record)throw Error('Unknown synthetic query');
    const q=queryVectors.get(record.id),scores=docs.map(text=>{const id=byText.get(normalize(text)),d=documentVectors.get(id);if(!d)throw Error('Unexpected source window; do not fake a vector');return q.reduce((n,value,i)=>n+value*d[i],0);});
    await options.beforeEncode?.();return{status:'ready',scores,modelFingerprint:encoded.ready.modelFingerprint,minScore:.44,coverage:{cached:docs.length,total:docs.length,complete:true}};}};
   const index=namespace.create({...f.host,resultUnit:'sessions',semantic:scorer});await runVariant(name,index);
  }
  report.status='PASS_REPLAY_MEASUREMENT';
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
 finally{await f.close();report.finishedAt=new Date().toISOString();save();}
 console.log(JSON.stringify({output,status:report.status,metrics:Object.fromEntries(Object.entries(report.variants).map(([name,value])=>[name,value.metrics]))}));
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
