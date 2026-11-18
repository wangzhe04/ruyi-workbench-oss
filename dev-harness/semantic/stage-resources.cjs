'use strict';
// Isolated diagnostic: attribute resident/JS/native allocation by loading stage.
// Not an EXE/desktop incremental measurement or a production GC change.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{pathToFileURL}=require('node:url');
const {performance}=require('node:perf_hooks'),{functionBlock}=require('../lib/source-slice');
const root=path.resolve(__dirname,'../..'),runtime=path.join(root,'ruyi-workbench/semantic-runtime'),assets=path.resolve(process.argv[2]||'output/semantic-runtime-win32-x64'),out=path.resolve(process.argv[3]||'output/semantic-stage-resources.json');
if(fs.existsSync(out))throw Error('Use a new report.');
const worker=fs.readFileSync(path.join(runtime,'worker.cjs'),'utf8'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const production=vm.runInNewContext(functionBlock(worker,'denyNetwork')+'\n'+functionBlock(worker,'modelFeeds')+'\n({denyNetwork,modelFeeds});',{require,globalThis,BigInt64Array});
const report={schema:1,createdAt:new Date().toISOString(),status:'RUNNING',workerSha256:sha(worker),node:process.version,stages:[],limitations:['Fresh isolated Node diagnostic, not whole desktop incremental RAM.','Memory stage differences include allocator/GC timing and are not exclusive ownership accounting.','Session release does not guarantee immediate OS resident-memory return.']};
let session;
const stamp=name=>{report.stages.push({name,elapsedMs:performance.now()-start,...process.memoryUsage(),peakRssBytes:process.resourceUsage().maxRSS*1024});};
const start=performance.now();stamp('start');
(async()=>{try{
 const verified=await require(path.join(runtime,'verify.cjs')).verify(assets);report.model={id:verified.model.id,fingerprint:verified.modelFingerprint};stamp('verified');
 production.denyNetwork();
 const {env,AutoTokenizer}=await import(pathToFileURL(path.join(assets,'node_modules/@huggingface/transformers/dist/transformers.node.mjs')));
 env.allowRemoteModels=false;env.allowLocalModels=true;env.useBrowserCache=false;env.useFSCache=false;stamp('library-imported');
 const tokenizer=await AutoTokenizer.from_pretrained(verified.modelDir,{local_files_only:true});stamp('tokenizer-loaded');
 const ort=require(path.join(assets,'node_modules/onnxruntime-node')),graph=verified.model.files.filter(file=>file.path.endsWith('.onnx'));if(graph.length!==1)throw Error('Expected one verified graph');
 session=await ort.InferenceSession.create(path.join(verified.modelDir,graph[0].path),{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1,logSeverityLevel:4});stamp('native-session-loaded');
 const inputs=tokenizer([verified.model.prefix.query+'A synthetic local memory diagnostic.'],{padding:true,truncation:true,max_length:verified.model.maxTokens});
 const output=await session.run(production.modelFeeds(ort,session,inputs));if(!output.last_hidden_state)throw Error('Missing hidden states');stamp('query-inferred');
 await session.release();session=null;stamp('session-released');report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
finally{if(session)await session.release();fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify({out,status:report.status,stages:report.stages,error:report.error})+'\n');}})();
