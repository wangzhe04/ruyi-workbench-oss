'use strict';
// Reuse the actual runner's isolation, timeout, process ownership and retry code.
// This deliberately does not rerun the unit gate; report that receipt separately.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),harness=path.join(root,'dev-harness'),runnerFile=path.join(harness,'run-all.js');
const runnerSource=fs.readFileSync(runnerFile,'utf8'),footer='main().catch(e => { console.error(e); process.exit(2); });';
if(runnerSource.split(footer).length!==2)throw Error('Unexpected runner entry; do not execute an altered harness.');
const mod=new Module(runnerFile,module);mod.filename=runnerFile;mod.paths=Module._nodeModulePaths(harness);
mod._compile(runnerSource.replace(footer,'module.exports = { runWithRetry, listE2e, isFast };'),runnerFile);
const args=process.argv.slice(2),out=path.resolve(args.shift()||'output/semantic-scoped'),api=mod.exports;
if(fs.existsSync(out))throw Error('Use a new evidence directory.');fs.mkdirSync(out,{recursive:true});
const files=args[0]==='--static'?api.listE2e().filter(api.isFast):args;
if(!files.length||files.some(file=>path.basename(file)!==file||!file.endsWith('.e2e.js')||!fs.existsSync(path.join(harness,file))))throw Error('Explicit existing harness filenames required.');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const bound=[...fs.readdirSync(path.join(root,'ruyi-workbench/app/src')).filter(n=>n.endsWith('.js')||n==='manifest.json').map(n=>'ruyi-workbench/app/src/'+n),'ruyi-workbench/app/server.js','ruyi-workbench/semantic-runtime/worker.cjs','ruyi-workbench/semantic-runtime/models.lock.json','dev-harness/run-all.js',...files.map(n=>'dev-harness/'+n)];
const bindings=()=>Object.fromEntries(bound.map(file=>[file,sha(fs.readFileSync(path.join(root,file)))])),before=bindings();
const report={schema:1,createdAt:new Date().toISOString(),status:'RUNNING',scope:args[0]==='--static'?'all-static':'explicit-functional',runnerSha256:sha(runnerSource),runnerAdaptation:'Only final main invocation replaced with exports; runWithRetry/runOne are unchanged.',parallel:args[0]==='--static'?4:1,sourceBindings:before,results:[],limitations:['Unit gate is not rerun here; use the separately preserved full-unit receipt.','This does not assert the independent model quality or final package acceptance.']};
let next=0;
async function lane(){while(next<files.length){const file=files[next++],value=await api.runWithRetry(file),r=value.r,log=file+'.log';fs.writeFileSync(path.join(out,log),r.out);report.results.push({file,ok:r.ok,status:r.status,timedOut:r.timedOut,flaky:value.flaky,ms:r.ms,log,logSha256:sha(r.out)});console.log((r.ok?'PASS ':'FAIL ')+file+(value.flaky?' FLAKY':''));}}
(async()=>{try{await Promise.all(Array.from({length:report.parallel},lane));report.sourceStable=JSON.stringify(bindings())===JSON.stringify(before);report.passed=report.results.filter(r=>r.ok).length;report.failed=report.results.filter(r=>!r.ok).length;report.flaky=report.results.filter(r=>r.flaky).length;report.status=report.sourceStable&&!report.failed&&!report.flaky?'PASS_SCOPED':'FAIL';if(report.status!=='PASS_SCOPED')process.exitCode=1;}
catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({out,status:report.status,passed:report.passed,failed:report.failed,flaky:report.flaky,sourceStable:report.sourceStable,error:report.error}));}})();
