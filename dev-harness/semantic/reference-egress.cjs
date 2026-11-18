'use strict';
// Independent actual HTTP provider boundary check for legacy reducer references.
// Synthetic data only. This verifies transport and readback, not model quality.
require('../lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {setTimeout:pause}=require('node:timers/promises');
const {startFakeProvider,textFrames,toolCallFrames}=require('../lib/fake-openai-provider');
const {getFreePort}=require('../free-port');
const {killOwnTree}=require('../lib/kill-own-tree');
const root=path.resolve(__dirname,'../..'),app=path.join(root,'ruyi-workbench/app'),output=path.resolve(process.argv[2]||'output/semantic-reference-egress-v1.json');
if(fs.existsSync(output))throw Error('Use a new evidence path.');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-reference-egress-'));
const shape=process.argv[3]||'text-reducer';
if(!['text-reducer','json-reducer','tool-replay','message-query'].includes(shape))throw Error('Unknown fixture shape.');
Object.assign(process.env,{RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home,RUYI_DISABLE_SEMANTIC:'1'});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const bound=['server.js','src/05-claude-engine.js','src/09-workflow.js','src/10-context-governance.js','src/12-tool-dispatch.js','src/13as-session-fulltext-consumers.js'];
const source=()=>Object.fromEntries(bound.map(file=>[file,hash(fs.readFileSync(path.join(app,file)))]));
const report={schema:1,createdAt:new Date().toISOString(),status:'RUNNING',shape,sourceBindings:source(),checks:[],limitations:['Actual local HTTP provider and tool execution with deterministic scripted responses; no real language model.','Synthetic privacy rule and synthetic history in isolated temporary root; not a desktop or installer check.']};
function check(value,name){report.checks.push({name,passed:!!value});assert.ok(value,name);}
function request(port,method,route,body,token){return new Promise((resolve,reject)=>{const raw=body===undefined?null:JSON.stringify(body);const req=http.request({host:'127.0.0.1',port,method,path:route,timeout:60000,headers:{...(raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{}),...(token?{'x-wcw-token':token}:{})}},res=>{let text='';res.on('data',part=>text+=part);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,text,json});});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTP timeout')));if(raw)req.write(raw);req.end();});}
let child,fake,stderr='';
(async()=>{try{
 let calls=0,issued;
 fake=await startFakeProvider({handler(req){
   calls++;const wire=JSON.stringify(req.body);
   check(!/history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/.test(wire),'provider request '+calls+' contains no legacy digest reference');
   check(!wire.includes('3141'),'provider request '+calls+' hides protected PIN');
   if(shape==='message-query'){
     if(calls===1)return toolCallFrames('observation_recall',{query:'publicneedle'},'find-message');
     if(calls===2){const raw=req.messages.find(row=>row.role==='tool'&&row.tool_call_id==='find-message');const result=JSON.parse(raw?.content||'null');report.messageQuery={ok:result?.ok,reason:result?.reason,code:result?.code,snippets:result?.candidates?.filter(row=>row.kind==='message').map(row=>row.snippet)};check(result?.ok===true&&!result.privacyFiltered,'model receives usable enhanced-privacy message query');const hit=result.candidates.find(row=>row.kind==='message'&&row.snippet.includes('receipt-id=7'));check(!!hit?.messageRef?.startsWith('message:v2:'),'model receives opaque message reference');check(hit.snippet.includes('[[RUYI_PVT:'),'model query preserves an actual protected alias');check(result.candidates.filter(row=>row.kind==='message').length===1,'one committed source is deduplicated across query branches');issued=hit.messageRef;return toolCallFrames('observation_recall',{messageRef:issued},'read-original');}
   }else if(calls===1){issued=wire.match(/history:v2:[a-f0-9]{32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];check(!!issued,'real provider body contains opaque migrated reference');return toolCallFrames('observation_recall',{rawRef:issued},'read-original');}
   check(req.messages.some(row=>row.role==='tool'&&row.tool_call_id==='read-original'&&String(row.content).includes('receipt-id=7')),'opaque reference reads original evidence through actual tool execution');return textFrames('verified');
 }});
 const config={configSchema:14,permissionMode:'bypass',defaultWorkspace:home,autoImportClaudeCodeMcp:false,includeWorkbenchMcp:false,semanticRetrievalV1:false,runtimeObservationReducerV1:true,runtimeObservationRecallV1:true,autoCompactThreshold:.99,privacyModeV1:'off',privacyRulesV1:[],providers:[{id:'fake',label:'Fake',type:'openai-compat',baseUrl:fake.url,apiKey:'synthetic',model:'fake-model',contextWindow:2000000}],activeProvider:'fake'};
 fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(config));
 const srv=require(path.join(app,'server.js'));
 await srv.mutateConfig(current=>Object.assign(current,{credentialEncryptionV1:true,privacyModeV1:'enhanced',privacyRulesV1:[{id:'synthetic-pin',kind:'literal',value:'3141',category:'INTERNAL'}]}));
 const session=await srv.createSession({title:'synthetic old reducer',cwd:home});session.turnSeq=1;
 const original='publicneedle 3141; receipt-id=7.';
 const history=[{role:'user',content:'read evidence'},{role:'assistant',content:null,tool_calls:[{id:'prior-read',type:'function',function:{name:'file_read',arguments:'{}'}}]},{role:'tool',tool_call_id:'prior-read',content:original},{role:'assistant',content:'prior read complete'}];
 const prefix=await srv.writeHistorySnapshot(session.id,1,history,true),legacy=prefix+':2:'+hash(original).slice(0,16);check(/^history:\d+:[a-f0-9]{16}:2:[a-f0-9]{16}$/.test(legacy),'fixture has an actual verifiable old snapshot');
 const reduced=shape==='json-reducer'?JSON.stringify({_ruyiObservation:{reduced:true,rawRef:legacy},text:'The protected PIN is 3141; incomplete.'}):shape==='tool-replay'?JSON.stringify({ok:true,rawRef:legacy,content:'Old protected PIN is 3141; incomplete.'}):'[Ruyi observation reduced · policy=fixture · originalChars='+original.length+' · rawRef='+legacy+']\nThe protected PIN is 3141; incomplete.';
 session.providerHistory=shape==='message-query'?[{role:'user',content:original},{role:'assistant',content:'prior evidence recorded'}]:history.map(row=>row.role==='tool'?{...row,content:reduced}:shape==='tool-replay'&&row.role==='assistant'&&row.tool_calls?{...row,tool_calls:[{id:'prior-read',type:'function',function:{name:'observation_recall',arguments:JSON.stringify({rawRef:legacy})}}]}:row);session.messages=[{role:'user',content:shape==='message-query'?original:'read evidence',turnSeq:1},{role:'assistant',content:'prior read complete',turnSeq:1}];session.providerHistoryCursor=2;session.engineRoute={engine:'openai',providerId:'fake',model:'fake-model'};await srv.saveSession(session);
 const port=await getFreePort();child=cp.spawn(process.execPath,['server.js','serve','--port',String(port)],{cwd:app,windowsHide:true,env:{...process.env}});child.stdout.resume();child.stderr.on('data',part=>stderr+=part);
 let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('Server exited: '+stderr.slice(-2000));try{if((await request(port,'GET','/health')).status===200){ready=true;break;}}catch{}await pause(100);}check(ready,'actual workbench server starts');
 const html=await request(port,'GET','/'),token=html.text.match(/name="wcw-token"\s+content="([a-f0-9]+)"/)?.[1];check(!!token,'real HTTP CSRF token obtained');
 const result=await request(port,'POST','/api/chat/stream',{sessionId:session.id,message:'Read the omitted prior evidence once and finish.'},token);
 const events=result.text.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);const terminal=events.findLast(row=>row.type==='result');
 report.transport={status:result.status,providerCalls:calls,error:result.json,events:events.filter(row=>['error','result','stderr'].includes(row.type))};
 check(calls===(shape==='message-query'?3:2)&&terminal&&terminal.ok!==false,'actual provider turn completes after opaque reference read');
 const current=(await request(port,'GET','/api/sessions/'+session.id,undefined,token)).json.session;
 if(shape!=='message-query')check(current.providerHistory.some(row=>row.role==='tool'&&row.content===reduced),'migration leaves original persisted reducer bytes unchanged');
 check(JSON.stringify(source())===JSON.stringify(report.sourceBindings),'source stays unchanged during acceptance');report.status='PASS';report.providerCalls=calls;report.referenceChars=issued.length;
}catch(error){report.status='FAIL';report.error=String(error.stack||error);report.stderr=stderr.slice(-3000);process.exitCode=1;}finally{if(child?.pid)killOwnTree(child);if(fake)await fake.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,status:report.status,checks:report.checks,error:report.error}));}})();
