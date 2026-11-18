'use strict';
// Real Job helper, real listener/PID proof and real HTTP; synthetic Node
// endpoint only, no model, no source text or API key written to the receipt.
// Asset integrity is deliberately bypassed solely in this test harness.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),crypto=require('node:crypto');
const out=path.resolve('output/semantic-gcc-coarse-real-fault-v1.json');
if(fs.existsSync(out))throw Error('use a new immutable result');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-gcc-synthetic-fault-')),server=path.join(temp,'server.cjs'),events=path.join(temp,'events.log');
fs.writeFileSync(server,`const http=require('node:http'),fs=require('node:fs');const a=process.argv,port=+a[a.indexOf('--port')+1],key=a[a.indexOf('--api-key')+1],log=${JSON.stringify(events)};
http.createServer((q,r)=>{fs.appendFileSync(log,q.url+'\\n');if(q.headers.authorization!=='Bearer '+key){r.writeHead(401);return r.end()}let b='';q.on('data',x=>b+=x);q.on('end',()=>{r.setHeader('content-type','application/json');if(q.url==='/health')return r.end('{}');if(q.url==='/slots')return r.end(JSON.stringify([{n_ctx:1024}]));if(q.url==='/tokenize')return r.end(JSON.stringify({tokens:[1,151643]}));if(q.url==='/slots/0?action=erase')return r.end(JSON.stringify({id_slot:0,n_erased:0}));if(q.url==='/v1/embeddings')return r.end(JSON.stringify({data:[{embedding:[1,...Array(1023).fill(0)]}],usage:{prompt_tokens:2}}));r.writeHead(404);r.end('{}');});}).listen(port,'127.0.0.1');`);
const file=path.join(__dirname,'gcc-coarse-native-research.cjs'),original=fs.readFileSync(file,'utf8'),anchor='const compiled = new Module(__filename, module);';
if(original.split(anchor).length!==2)throw Error('test transform boundary changed');
const launchReplacement='args.unshift('+JSON.stringify(server)+'); const command = verified.lock.runtimeEntry,';
let wrapper=original.replace(anchor,`source=source.replace("const verified = await verify(root, deadline, signal);", "const verified = {lock:{modelPath:'synthetic',runtimeEntry:process.execPath,contract:CONTRACT,retrievalThresholds:{search:null,automatic:null}}};");
source=source.replace("const command = verified.lock.runtimeEntry,", ${JSON.stringify(launchReplacement)});\n`+anchor);
const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(wrapper,file);
const report={status:'RUNNING',scope:'Real Windows Job helper, netstat PID check and local HTTP against a synthetic Node endpoint; model/asset IO intentionally bypassed.',cases:[]};
let failed;
(async()=>{try{
 for(const [name,failAt] of [['after-tokenize',4],['after-erase',5]]){
  fs.writeFileSync(events,'');const client=compiled.exports.create(),denied=Error('synthetic authority revoked');let guards=0,caught=false;
  try{const ready=await client.prepare({budgetMs:10000,deadline:Date.now()+10000});if(!ready.ok)throw Error('synthetic listener not ready');
   fs.writeFileSync(events,'');try{await client.encode(['synthetic only'],{role:'document',deadline:Date.now()+1000,beforeEncode:async()=>{if(++guards===failAt)throw denied;}});}catch(error){caught=error===denied;}
  }finally{const cleanup=await client.stop();const seen=fs.readFileSync(events,'utf8').trim().split(/\r?\n/).filter(Boolean);
   const entry={name,guards,caught,tokenize:seen.includes('/tokenize'),erase:seen.includes('/slots/0?action=erase'),embedding:seen.includes('/v1/embeddings'),cleanup};report.cases.push(entry);
   if(!caught||!entry.tokenize||entry.embedding||entry.erase!==(failAt===5)||cleanup.cleanupStatus!=='observed'||cleanup.workerExited!==true)throw Error('real lifecycle fault expectation failed');}
 }
 report.status='PASS_SYNTHETIC_REAL_JOB_AND_HTTP_ONLY';
}catch(error){failed=error;report.status='FAIL';report.error=String(error?.stack||error);}finally{
 report.sourceSha256=crypto.createHash('sha256').update(original).digest('hex');fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 fs.rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(report));if(failed)process.exitCode=1;
}})();
