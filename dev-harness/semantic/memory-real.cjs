'use strict';
// Actual existing memory tool, files, local runtime and shared admission.
// Synthetic trusted host and memory data; independent quality gate is separate.
require('../lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const root=path.resolve(__dirname,'../..'),assets=path.resolve(process.argv[2]||'output/semantic-runtime-win32-x64'),output=path.resolve(process.argv[3]||'output/semantic-memory-real.json');
if(fs.existsSync(output))throw Error('Use a new output receipt.');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-memory-real-'));
Object.assign(process.env,{RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home,RUYI_DISABLE_SEMANTIC:'0',RUYI_SEMANTIC_RUNTIME_ROOT:assets});
const config={configSchema:14,permissionMode:'bypass',semanticRetrievalV1:true,runtimeMemoryVectorRecallV1:true,privacyModeV1:'off',autoImportClaudeCodeMcp:false};
const configFile=path.join(home,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
const app=path.join(root,'ruyi-workbench/app'),manifest=JSON.parse(fs.readFileSync(path.join(app,'src/manifest.json'),'utf8'));
const sources=manifest.modules.map(row=>fs.readFileSync(path.join(app,'src',typeof row==='string'?row:row.file),'utf8'));
const code=sources.join('\n'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const report={schema:1,scope:'explicit-memory-real-runtime-wiring',createdAt:new Date().toISOString(),status:'RUNNING',sourceSha256:hash(code),checks:[],states:[],limitations:['Synthetic trusted in-process tool host and memory files.','Small wiring fixture, not a substitute for independent quality or final package acceptance.']};
const mod=new Module(path.join(app,'server.js'),module);mod.filename=path.join(app,'server.js');mod.paths=Module._nodeModulePaths(app);
mod._compile(code+'\nmodule.exports.__semanticTest={activeChildren,stop:()=>SemanticRuntimeHooks.stop(),descriptor:()=>SemanticRuntimeHooks.descriptor()};',mod.filename);
const srv=mod.exports,api=srv.__semanticTest;
function check(value,name){report.checks.push({name,passed:!!value});assert.ok(value,name);}
(async()=>{
 try{
  const cwd=path.join(home,'project');fs.mkdirSync(cwd);
  for(const memory of [
   {id:'record-alpha',name:'账号帮助',description:'忘记口令时使用已绑定邮箱的验证码重设登录密码。'},
   {id:'record-beta',name:'园艺约定',description:'植物换盆后放在阴凉通风处，避免烈日曝晒。'},
  ])check((await srv.saveMemory({...memory,scope:'project',type:'reference',body:'Synthetic body not used for embedding.'},cwd)).ok,'memory created: '+memory.id);
  const session=await srv.createSession({title:'Memory semantic integration',cwd});session.turnSeq=1;api.activeChildren.set(session.id,{state:'running',session});
  const ctx={session,sessionId:session.id,workingDir:cwd,turnSeq:1,config};
  const query='I cannot remember the credential for signing in.';
  fs.writeFileSync(configFile,JSON.stringify({...config,semanticRetrievalV1:false}));
  const baseline=await srv.toolCall('workbench_memory_list',{query},ctx);
  check(baseline.ok&&!baseline.memories.some(row=>row.id==='record-alpha'),'disabled lexical baseline has no translated match');
  fs.writeFileSync(configFile,JSON.stringify(config));
  let result;
  for(let attempt=0;attempt<24;attempt++){
   result=await srv.toolCall('workbench_memory_list',{query},ctx);report.states.push(result.semantic);
   if(result.semantic?.status==='ready'&&result.semantic.coverage?.complete)break;
   await pause(150);
  }
  check(result?.ok&&result.semantic?.status==='ready'&&result.semantic.coverage.complete,'real runtime completes eligible metadata coverage');
  const hit=result.memories.find(row=>row.id==='record-alpha');
  check(hit?.retrieval?.kind==='semantic'&&Number.isFinite(hit.retrieval.semanticScore),'existing tool discovers cross-language header through admission');
  check(result.semantic.automaticCandidates===false,'explicit search does not authorize automatic additions');
  report.model=api.descriptor();report.result=result;
  check(!JSON.stringify(result).includes('Synthetic body not used'),'tool returns metadata without memory body');
  check(hash(manifest.modules.map(row=>fs.readFileSync(path.join(app,'src',typeof row==='string'?row:row.file),'utf8')).join('\n'))===report.sourceSha256,'source tree unchanged during qualification');
  report.status='PASS';
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
 finally{api.stop();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,status:report.status,checks:report.checks,error:report.error}));}
})();
