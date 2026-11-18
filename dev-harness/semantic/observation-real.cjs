'use strict';
// Actual model -> existing observation query -> typed source reference -> read.
require('../lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {setTimeout:pause}=require('node:timers/promises');
const root=path.resolve(__dirname,'../..'),assets=path.resolve(process.argv[2]||'output/semantic-runtime-win32-x64'),output=path.resolve(process.argv[3]||'output/semantic-observation-real.json');
if(fs.existsSync(output))throw Error('Use a new evidence path.');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-observation-real-'));
Object.assign(process.env,{RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home,RUYI_DISABLE_SEMANTIC:'0',RUYI_SEMANTIC_RUNTIME_ROOT:assets});
const config={configSchema:14,permissionMode:'bypass',semanticRetrievalV1:true,runtimeObservationReducerV1:true,runtimeObservationRecallV1:true,privacyModeV1:'off',autoImportClaudeCodeMcp:false};
fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(config));
const app=path.join(root,'ruyi-workbench/app'),manifest=JSON.parse(fs.readFileSync(path.join(app,'src/manifest.json'),'utf8'));
const source=()=>manifest.modules.map(m=>fs.readFileSync(path.join(app,'src',typeof m==='string'?m:m.file),'utf8')).join('\n'),code=source(),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const mod=new Module(path.join(app,'server.js'),module);mod.filename=path.join(app,'server.js');mod.paths=Module._nodeModulePaths(app);
mod._compile(code+'\nmodule.exports.__real={runAutoCompaction,stop:()=>SemanticRuntimeHooks.stop(),prepare:()=>SemanticRuntimeHooks.prepare({budgetMs:20000}),descriptor:()=>SemanticRuntimeHooks.descriptor()};',mod.filename);
const srv=mod.exports,api=srv.__real,report={schema:1,createdAt:new Date().toISOString(),status:'RUNNING',sourceSha256:hash(code),checks:[],states:[],limitations:['Synthetic trusted main-turn host and isolated plaintext committed messages.','Real local tokenizer/ONNX and real compaction/query/reference/read; not a multi-engine or independent quality gate.']};
function check(value,name){report.checks.push({name,passed:!!value});assert.ok(value,name);}
(async()=>{try{
 const original='忘记口令时使用已绑定邮箱的验证码重设登录密码。',query='I cannot remember the credential for signing in.';
 const session=await srv.createSession({title:'Source evidence',cwd:home});session.turnSeq=2;
 session.messages=[{id:'original-user',role:'user',turnSeq:1,content:original}];
 session.providerHistory=[{role:'user',content:original},{role:'assistant',content:'',tool_calls:[{id:'fixture-tool',type:'function',function:{name:'file_read',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'fixture-tool',content:'Synthetic unrelated tool output. '.repeat(6000)},{role:'assistant',content:'ok'},{role:'user',content:'next'},{role:'assistant',content:'ok'}];await srv.saveSession(session);
 const history=session.providerHistory;const compacted=await api.runAutoCompaction({history,privacyHistoryOwner:session,scope:'main',provider:{id:'synthetic'},model:'synthetic',sys:'',tools:[],config,budget:100,window:10000,watermark:0,snapshot:()=>srv.writeHistorySnapshot(session.id,session.turnSeq,history,true),onEvent:()=>{}});
 check(compacted.compacted===true,'actual compaction executes before recovery');
 check((await api.prepare()).available,'actual offline runtime ready');
 const ctx={session,sessionId:session.id,mainTurn:true};let result,hit;
 for(let n=0;n<8;n++){
  result=await srv.toolCall('observation_recall',{query},ctx);report.states.push(result.semantic);
  hit=result.candidates?.find(x=>x.kind==='message'&&x.snippet===original&&Number.isFinite(x.semanticScore));
  if(hit)break;await pause(100);
 }
 check(result.ok&&!!hit,'cross-language query locates committed original message through real embeddings');
 check(typeof hit.messageRef==='string'&&hit.role==='user','result retains typed original-message evidence role');
 const page=await srv.toolCall('observation_recall',{messageRef:hit.messageRef,offset:hit.offset,maxChars:1000},ctx);
 check(page.ok&&page.content===original&&page.coordinate==='privacy-projected-utf16','typed reference re-reads original source exactly');
 session.messages[0].content='Source changed after citation.';await srv.saveSession(session);
 let denied=false;try{await srv.toolCall('observation_recall',{messageRef:hit.messageRef,offset:hit.offset,maxChars:1000},ctx);}catch{denied=true;}
 check(denied,'committed rewrite invalidates the real-model citation');
 check(hash(source())===report.sourceSha256,'source modules unchanged during qualification');
 report.model=api.descriptor();report.hit=hit;report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
finally{api.stop();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,status:report.status,checks:report.checks,error:report.error}));}})();
