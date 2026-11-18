'use strict';
// Explicit owned controller; requires a separately reviewed signed-by-hash freeze.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),policy=require('./controller-policy.cjs');
const businessPolicy=require('./business-policy.cjs');
const strictKind='FROZEN_M5_HTTP_EXECUTABLE', businessKind='FROZEN_M5_HTTP_BUSINESS_ONLY';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function verify(contract,pin,businessOnly=false){const bytes=fs.readFileSync(contract);if(hash(bytes)!==pin)throw Error('M5_CONTRACT_HASH');const f=JSON.parse(bytes);if(f.status!==(businessOnly?businessKind:strictKind)||!Array.isArray(f.bindings)||!f.bindings.length||!['external-bots-group-decisions.e2e.js','external-bots-human-decisions.e2e.js'].includes(f.fixture))throw Error('M5_CONTRACT_SHAPE');for(const row of f.bindings){const b=fs.readFileSync(row.path);if(b.length!==row.bytes||hash(b)!==row.sha256)throw Error('M5_INPUT_DRIFT');}return f;}
function helperPins(f) {
 const keys = {RUYI_M5_FLUSH_POWERSHELL_SHA256:f.powershell,
  RUYI_M5_FLUSH_SERVER_SHA256:path.join(f.root,'ruyi-workbench','app','server.js'),
  RUYI_M5_FLUSH_SOURCE_SHA256:path.join(f.root,'ruyi-workbench','app','src','01w-work-data-native-publish.js')};
 const env = {};
 for (const [key,file] of Object.entries(keys)) {
  const row = f.bindings.find(row => row.path === file);
  if (!row || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('M5_HELPER_BINDING');
  env[key] = row.sha256;
 }
 return env;
}
async function run(contract,pin,spawn=cp.spawn,businessOnly=false){const f=verify(contract,pin,businessOnly),plan=policy.buildPlan(f),helperEnv=helperPins(f),result={status:'RUNNING',fixture:f.fixture},files={stdout:fs.openSync(path.join(f.output,'stdout.log'),'wx')};try{files.stderr=fs.openSync(path.join(f.output,'stderr.log'),'wx');}catch(e){fs.closeSync(files.stdout);throw e;}const evidence=businessOnly&&f.fixture==='external-bots-human-decisions.e2e.js'?path.join(f.output,'human-business-evidence'):null;let child;try{child=spawn(plan.node,plan.args,{cwd:plan.cwd,env:{...plan.env,...helperEnv,...(evidence?{RUYI_C2_EVIDENCE_DIR:evidence}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){fs.closeSync(files.stdout);fs.closeSync(files.stderr);throw e;}let exited=null,closed=null,stdoutEnd=false,stderrEnd=false,timeout=false,processError=null;const max=2*1024*1024;let bytes=0,filesOpen=true;for(const name of ['stdout','stderr']){child[name].on('data',b=>{try{if(!filesOpen)throw Error('M5_OUTPUT_AFTER_CLOSE');const chunk=Buffer.from(b),available=Math.max(0,max-bytes);if(available){let off=0,limit=Math.min(chunk.length,available);while(off<limit){const n=fs.writeSync(files[name],chunk,off,limit-off);if(n<=0)throw Error('M5_OUTPUT_SHORT_WRITE');off+=n;}}bytes+=chunk.length;if(bytes>max){processError='M5_OUTPUT_LIMIT';try{child.kill();}catch{}}}catch{processError=processError||'M5_OUTPUT_WRITE_ERROR';try{child.kill();}catch{}}});child[name].once('end',()=>{if(name==='stdout')stdoutEnd=true;else stderrEnd=true;});child[name].on('error',()=>{processError='M5_PIPE_ERROR';});}child.once('error',()=>{processError='M5_CHILD_ERROR';});child.once('exit',(code,signal)=>{exited={code,signal};});const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed={code,signal};resolve();}));const timer=setTimeout(()=>{timeout=true;try{child.kill();}catch{}},plan.budgets.runnerMs);let tailTimer;await Promise.race([done,new Promise(resolve=>{tailTimer=setTimeout(resolve,plan.budgets.runnerMs+5000);})]);clearTimeout(timer);clearTimeout(tailTimer);filesOpen=false;for(const n of ['stdout','stderr'])try{fs.closeSync(files[n]);}catch{processError=processError||'M5_OUTPUT_CLOSE_ERROR';}let stable=true;try{verify(contract,pin,businessOnly);}catch{stable=false;}const lines=file=>fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x.replace(/^\uFEFF/,'')));let matched=false;
if(businessOnly){
 result.lane='business-only';
 try {
  const stdout=fs.readFileSync(path.join(f.output,'stdout.log'),'utf8');
  const report=evidence?JSON.parse(fs.readFileSync(path.join(evidence,'ACTUAL-RESULT.json'),'utf8')):null;
  result.businessAssertions=businessPolicy.businessAssertions(f.fixture,stdout,report);
  result.guardLifecycles=businessPolicy.guardLifecycles(f.fixture,lines(path.join(f.output,'guard-child-events.jsonl')),
   lines(path.join(f.output,'guard-flush-events.jsonl')),child.pid);
  matched=result.businessAssertions&&result.guardLifecycles;
 }catch{result.businessEvidenceReadError='M5_BUSINESS_EVIDENCE_UNAVAILABLE';}
}else{
 try{matched=policy.matchIdentity(lines(path.join(f.output,'guard-child-events.jsonl')),policy.completeSamples(fs.readFileSync(path.join(f.output,'job-member-complete-samples.jsonl'),'utf8')),child.pid,plan.node,process.pid,f.fixture);}catch{result.identityReadError='M5_IDENTITY_STREAM_UNAVAILABLE';}
 result.identityMatched=matched;
}
result.exit=exited;result.close=closed;result.stdoutEnd=stdoutEnd;result.stderrEnd=stderrEnd;result.timeout=timeout;result.processError=processError;result.bindingsStable=stable;const pass=businessOnly?'BUSINESS_ASSERTIONS_AND_GUARD_CLOSE_REQUIRE_OUTER_JOB':'CONTROLLER_SUCCESS_REQUIRES_OUTER_JOB';result.status=matched&&stable&&!processError&&!timeout&&exited?.code===0&&closed?.code===0&&!exited.signal&&!closed.signal&&stdoutEnd&&stderrEnd?pass:'FAIL_OR_UNKNOWN';fs.writeFileSync(path.join(f.output,'controller-receipt.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});if(result.status!==pass)process.exitCode=1;return result;}
if(require.main===module){const [, ,op,contract,pin]=process.argv;if(op!=='run'&&op!=='run-business')throw Error('M5_USAGE');run(contract,pin,cp.spawn,op==='run-business').catch(e=>{console.error(e.code||e.message);process.exitCode=1;});}
module.exports={verify,run};
