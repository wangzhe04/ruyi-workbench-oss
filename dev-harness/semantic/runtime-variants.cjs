'use strict';
// Resource experiment only. Generates an isolated worker copy, never edits model assets.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),readline=require('node:readline');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'ruyi-workbench/semantic-runtime');
const assets=path.resolve(process.argv[2]||'output/semantic-runtime-win32-x64'),output=path.resolve(process.argv[3]||'output/semantic-s2b-runtime-variants.json');
const corpus=require('./pilot-fixture.cjs'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const sourceAt=process.argv.indexOf('--source');
const original=fs.readFileSync(sourceAt>=0?path.resolve(process.argv[sourceAt+1]):path.join(runtime,'worker.cjs'),'utf8');
let code=original.replace("require('./protocol.cjs')",'require('+JSON.stringify(path.join(runtime,'protocol.cjs'))+')').replace("require('./verify.cjs')",'require('+JSON.stringify(path.join(runtime,'verify.cjs'))+')');
code=code.replace('session_options: { intraOpNumThreads:', "session_options: { graphOptimizationLevel: process.env.RUYI_PROBE_GRAPH, intraOpNumThreads:");
if(process.argv.includes('--direct-ort')){
 const line=code.split('\n').find(line=>line.includes('const encoder = await AutoModel.from_pretrained'));
 if(line)code=code.replace(line,`  const ort = require(path.join(root,'node_modules','onnxruntime-node'));
  const session = await ort.InferenceSession.create(path.join(modelDir,model.files.find(file=>file.path.endsWith('.onnx')).path), {executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1,logSeverityLevel:4,graphOptimizationLevel:process.env.RUYI_PROBE_GRAPH,...(disableArena?{enableCpuMemArena:false,enableMemPattern:false}:{})});
  const encoder = async inputs => {const feeds={};for(const name of session.inputNames){const value=inputs[name];if(!value)throw Error('MODEL_INPUT_MISSING');feeds[name]=new ort.Tensor(value.type,value.data,value.dims);}return session.run(feeds);};
  encoder.dispose = () => session.release();`);
}
if(!code.includes('graphOptimizationLevel:'))code=code.replace("executionProviders: ['cpu'],", "executionProviders: ['cpu'], graphOptimizationLevel: process.env.RUYI_PROBE_GRAPH,");
const probe=phase=>`send({type:'probe',phase:${JSON.stringify(phase)},memory:process.memoryUsage(),rssBytes:process.memoryUsage().rss,peakRssBytes:process.resourceUsage().maxRSS*1024});`;
code=code.replace('  const tokenizer =', '  '+probe('before-tokenizer')+'\n  const tokenizer =');
code=code.replace('  const disableArena =', '  '+probe('after-tokenizer')+'\n  const disableArena =');
const loadMarker=code.includes('  const session =')?'  const session =':'  const encoder =';
code=code.replace(loadMarker, "  if(process.env.RUYI_PROBE_GC==='1')global.gc?.();\n"+loadMarker);
code=code.replace('  const queue =', "  if(process.env.RUYI_PROBE_GC==='1')global.gc?.();\n  const queue =");
code=code.replace('  const queue =', '  '+probe('after-model')+'\n  const queue =');
if(code===original||!/graphOptimizationLevel:\s*process\.env\.RUYI_PROBE_GRAPH/.test(code))throw Error('worker experiment patch did not apply');
const experiment=path.join(root,'output/semantic-s2b-worker-experiment.cjs');fs.writeFileSync(experiment,code);
const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1];
async function run(graph,arena,gc=false){
 const start=performance.now(),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC)$/i.test(key)));
 env.RUYI_PROBE_GRAPH=graph;env.RUYI_PROBE_GC=gc?'1':'0';env.RUYI_SEMANTIC_DISABLE_ARENA=arena?'0':'1';
 const child=cp.spawn(process.execPath,[...(gc?['--expose-gc']:[]),experiment,'--root',assets],{cwd:root,windowsHide:true,env,stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',resolve)),pending=new Map(),probes=[],samples=[];let serial=0,metrics=null,stderrBytes=0,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const startup=setTimeout(()=>rejectReady(Error('startup_timeout')),30000);
 child.stderr.on('data',part=>{stderrBytes+=part.length;});child.on('error',rejectReady);
 child.on('exit',()=>{rejectReady(Error('worker_exit'));for(const entry of pending.values())entry.reject(Error('worker_exit'));});
 readline.createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return rejectReady(Error('invalid_ndjson'));}
  if(value.type==='probe'){probes.push(value);return;}if(value.type==='ready'){clearTimeout(startup);return value.ok?resolveReady(value):rejectReady(Error(value.error?.code||'not_ready'));}
  const entry=pending.get(value.requestId);if(entry){pending.delete(value.requestId);clearTimeout(entry.timer);metrics=value.metrics||metrics;value.ok?entry.resolve(value):entry.reject(Error(value.error?.code||'encode_failed'));}
 });
 async function encode(role,texts){const requestId=String(++serial);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('request_timeout'));},30000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({requestId,op:'encode',role,texts,deadlineMs:Date.now()+29000})+'\n');});}
 async function vectors(role,texts){const result=[];for(let at=0;at<texts.length;at+=8)result.push(...(await encode(role,texts.slice(at,at+8))).vectors);return result;}
 try{
  const descriptor=await ready,coldReadyMs=performance.now()-start;
  const docs=await vectors('document',corpus.documents.map(d=>d.text)),queries=await vectors('query',corpus.queries.map(q=>q.text));
  const ranks=queries.map((v,n)=>{const ranked=docs.map((d,i)=>({id:corpus.documents[i].id,score:d.reduce((s,x,j)=>s+x*v[j],0)})).sort((a,b)=>b.score-a.score);return {id:corpus.queries[n].id,rank:ranked.findIndex(d=>corpus.queries[n].relevant.includes(d.id))+1};});
  for(let i=0;i<30;i++){const at=performance.now();await encode('query',[corpus.queries[i%corpus.queries.length].text]);samples.push(performance.now()-at);}
  return {graph,arena,gc,coldReadyMs,modelFingerprint:descriptor.modelFingerprint,probes,metrics,stderrBytes,warmQuery:{samplesMs:samples,p95Ms:p95(samples)},quality:{recallAt5:ranks.filter(r=>r.rank>0&&r.rank<=5).length/ranks.length,mrr:ranks.reduce((s,r)=>s+(r.rank>0?1/r.rank:0),0)/ranks.length},vectorSha256:hash(JSON.stringify([docs,queries])),vectors:[...docs,...queries]};
 }finally{clearTimeout(startup);for(const item of pending.values())clearTimeout(item.timer);child.stdin.destroy();child.kill();await closed;}
}
async function main(){
 const report={schema:1,createdAt:new Date().toISOString(),workerSourceSha256:hash(original),experimentSha256:hash(code),fixtureSha256:hash(fs.readFileSync(path.join(__dirname,'pilot-fixture.cjs'))),node:process.version,directOrt:process.argv.includes('--direct-ort'),variants:[],limitations:['Resource experiments on the prior development pilot, not release holdout acceptance.','Options are confined to the generated experimental worker. Production fingerprint/options require explicit adoption and fresh validation.','RSS sampling at phase boundaries; maxRSS comes from worker process lifetime.']};
 let baseline;
 const variants=process.argv.includes('--gc')?[['all',true,false],['all',true,true],['all',false,true]]:[['all',true],['all',false],['extended',false],['basic',false],['disabled',false]];
 for(const [graph,arena,gc] of variants){
  try{const result=await run(graph,arena,gc);baseline??=result.vectors;result.maxVectorDifference=Math.max(...result.vectors.map((v,n)=>Math.max(...v.map((x,i)=>Math.abs(x-baseline[n][i])))));delete result.vectors;report.variants.push(result);console.log(JSON.stringify({graph,arena,gc,rss:result.metrics,coldReadyMs:result.coldReadyMs,p95Ms:result.warmQuery.p95Ms,quality:result.quality,maxVectorDifference:result.maxVectorDifference}));}
  catch(error){report.variants.push({graph,arena,error:error.message});process.exitCode=1;}
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
