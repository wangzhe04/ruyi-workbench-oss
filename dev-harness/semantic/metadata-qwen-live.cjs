'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {fixture,actual}=require('../lib/fulltext-consumer-fixture'),{create}=require('./qwen-research-adapter.cjs');
const output=path.resolve(process.argv[2]||'output/semantic-metadata-qwen-live-v1.json');if(fs.existsSync(output))throw Error('Use a new report');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),files=['06ha-semantic-retrieval.js','13ap-session-fulltext-index.js','13as-session-fulltext-consumers.js'],source=()=>Object.fromEntries(files.map(file=>[file,sha(actual(file))]));
(async()=>{const f=await fixture({enabled:true}),runtime=create(),report={status:'RUNNING',source:source(),model:'local Qwen 0.6B q4 fixed threshold 0.44',synthetic:true,cases:[]};try{
 f.context.SemanticRetrieval=vm.runInContext(actual('06ha-semantic-retrieval.js')+'\nSemanticRetrieval;',f.context);f.context.SemanticRuntimeHooks=runtime;
 await f.put('A',[{role:'user',id:'m',content:'ordinary source record'}],{head:{title:'orchid botanical propagation'}});
 await f.put('B',[{role:'user',id:'m',content:'ordinary source record'}],{head:{title:'orchid bicycle repair'}});
 await f.put('C',[{role:'user',id:'m',content:'ordinary source record'}],{head:{title:'orchid greenhouse'}});
 const ready=await runtime.prepare({budgetMs:20000});if(!ready.ok)throw Error('worker unavailable '+JSON.stringify(ready));
 for(let n=0;n<12;n++){const start=Date.now(),r=await f.ui('orchid greenhouse'),row={attempt:n+1,elapsedMs:Date.now()-start,ids:r.results.map(x=>x.id),semantic:r.semantic,lexicalAdmission:r.lexicalAdmission};report.cases.push(row);if(r.semantic?.coverage==='complete'&&!r.lexicalAdmission?.partial)break;}
 report.sourceStable=JSON.stringify(source())===JSON.stringify(report.source);report.status='PASS_OBSERVATION';
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}finally{await runtime.stop();report.workerExited=!runtime.stats().processAlive;report.runtime=runtime.stats();await f.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,workerExited:report.workerExited,cases:report.cases,sourceStable:report.sourceStable,error:report.error}));}})().catch(error=>{console.error(error);process.exitCode=1;});
