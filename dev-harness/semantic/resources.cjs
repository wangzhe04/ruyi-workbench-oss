'use strict';
// Actual production bridge/worker lifecycle; synthetic strings, no user history.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'../..'),runtimeRoot=path.resolve(process.argv[2]||'output/semantic-runtime-win32-x64'),output=path.resolve(process.argv[3]||'output/semantic-s2b-resources.json');
if(fs.existsSync(output))throw Error('Use a new receipt; prior measurements are immutable.');
const source=fs.readFileSync(path.join(root,'ruyi-workbench/app/src/06hb-semantic-runtime.js'),'utf8');
const context=vm.createContext({require,Buffer,Date,setTimeout,clearTimeout,SemanticRuntimeHooks:{}});
const Type=vm.runInContext(source+'\nSemanticRuntimeClient;',context);
let enabled=false,lastMetrics=null;
const children=[],checks=[];
const client=Type.create({enabled:async()=>enabled,settings:()=>({command:process.execPath,args:[path.join(root,'ruyi-workbench/semantic-runtime/worker.cjs'),'--root',runtimeRoot],cwd:root,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC)$/i.test(key)))}),spawn(...args){
 const child=cp.spawn(...args),item={pid:child.pid,started:performance.now()};children.push(item);
 item.closed=new Promise(resolve=>child.once('close',(code,signal)=>{item.close={code,signal,elapsedMs:performance.now()-item.started};resolve(item.close);}));
 let buffer='';child.stdout.on('data',part=>{buffer+=part;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const value=JSON.parse(line);if(value.metrics)lastMetrics=value.metrics;}catch{}}});return child;
}});
const check=(name,passed)=>{checks.push({name,passed:!!passed});if(!passed)process.exitCode=1;};
async function closedWithin(item,ms){let timer;try{return await Promise.race([item.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('worker did not exit within lifecycle deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function main(){
 const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const runtimeSources=Object.fromEntries(['worker.cjs','protocol.cjs','verify.cjs','models.lock.json'].map(name=>[name,sha(fs.readFileSync(path.join(root,'ruyi-workbench/semantic-runtime',name)))]));
 const report={schema:1,createdAt:new Date().toISOString(),bridgeSha256:sha(source),runtimeSources,node:process.version,checks,limitations:['RSS of isolated Node harness and actual child; not a before/after measurement of the full desktop application.','1000-fragment cache memory is measured separately in the performance receipt.','RSS is resident memory, not exclusively private or guaranteed incremental physical memory.']};
 try{
  report.disabledHost=process.memoryUsage();const disabled=await client.prepare({budgetMs:20000});check('disabled mode creates no worker',!disabled.available&&children.length===0);
  enabled=true;const begin=performance.now();const ready=await client.prepare({budgetMs:20000});report.coldReadyMs=performance.now()-begin;report.ready=ready;check('on-demand model ready',ready.available);
  if(!ready.available)throw Error('model unavailable');
  const encoded=await client.encode(['A synthetic resource measurement for local retrieval.'],{role:'query',deadline:Date.now()+5000});check('actual query encoded',encoded.ok);report.afterQueryHost=process.memoryUsage();report.afterQueryWorker=lastMetrics;
  const idleStart=performance.now();await closedWithin(children[0],65000);report.idleExitMs=performance.now()-idleStart;report.afterIdleHost=process.memoryUsage();check('default 60-second idle worker exits',report.idleExitMs>=59000&&report.idleExitMs<65000);
  const restarted=await client.prepare({budgetMs:20000});check('worker restarts after idle',restarted.available&&children.length===2);
  enabled=false;const off=await client.prepare({budgetMs:20000});await closedWithin(children[1],5000);check('disable stops the active worker',!off.available);report.afterDisableHost=process.memoryUsage();
 }catch(error){report.error=error.message;process.exitCode=1;}
 finally{client.stop('disabled');report.children=await Promise.all(children.map(async item=>({pid:item.pid,close:await closedWithin(item,5000)})));fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify({output,checks,error:report.error,worker:report.afterQueryWorker,idleExitMs:report.idleExitMs}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
