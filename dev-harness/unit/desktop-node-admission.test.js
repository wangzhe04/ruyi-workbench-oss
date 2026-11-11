'use strict';
// Actual root OS ownership + private runtime admissions with synthetic workflow/controller identities.
// Tests durable intent files, not actual orchestrator/SDK/native dispatch (qualified separately).
const {test:nodeTest,after}=require('node:test');
const test=(name,fn)=>nodeTest(name,{skip:process.platform!=='darwin'},fn);
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=fs.mkdtempSync(path.join(process.platform==='darwin'?'/tmp':require('node:os').tmpdir(),'rna-'));
for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR']){process.env[key]=path.join(root,key);fs.mkdirSync(process.env[key]);}
process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='1';
const {loadServerInternals}=require('../lib/server-internals');
after(()=>fs.rmSync(root,{recursive:true,force:true}));let count=0;
async function fixture(){
  const data=path.join(root,'data-'+(++count));fs.mkdirSync(data);process.env.RUYI_HOME=data;process.env.WIN_CLAUDE_WORKBENCH_HOME=data;
  const api=loadServerInternals(['ServerOwnership','DesktopExecutionRuntime','turnSettlers','activeAgentRuns','sessionRewindGenHighWater','markSessionDeleted']);
  const ownership=await api.ServerOwnership.acquire([data]);await api.DesktopExecutionRuntime.initialize(ownership);
  const session={id:'sess_node',turnSeq:1,rewindGen:0,createdAt:new Date().toISOString()},owner={driverRunId:'drun_node',cancelRequested:false};
  api.turnSettlers.set(session.id,owner);const runtimeApi=api.DesktopExecutionRuntime;runtimeApi.admit(session,owner);
  const origin=runtimeApi.workflowOrigin(session,owner),node={id:'worker',attempts:1,status:'running'},ctrl=new AbortController();
  const run={id:'run_node',sessionId:session.id,turnSeq:1,status:'running',background:false,nodes:[node]},runtime={run,ctrl:new AbortController(),nodeControls:new Map([[node.id,ctrl]]),permissionWaits:new Map(),closing:false,paused:false,stopRequested:false};
  api.activeAgentRuns.set(run.id,runtime);
  return {...api,api:runtimeApi,ownership,session,owner,origin,node,ctrl,run,runtime,data};
}
function history(){return [{role:'user',content:'private actual node task'},{role:'assistant',content:'',tool_calls:[{id:'call_one',function:{name:'wait',arguments:'{}'}}]}];}
test('opaque node scope requires exact registered runtime, node, controller and origin identities',async()=>{
  const f=await fixture();try{
    assert.throws(()=>f.api.admitNode({...f.origin},f.runtime,f.node,f.ctrl,'sub_one'),{code:'execution_admission_lost'});
    assert.throws(()=>f.api.admitNode(f.origin,{...f.runtime},f.node,f.ctrl,'sub_one'),{code:'execution_admission_lost'});
    assert.throws(()=>f.api.admitNode(f.origin,f.runtime,{...f.node},f.ctrl,'sub_one'),{code:'execution_admission_lost'});
    assert.throws(()=>f.api.admitNode(f.origin,f.runtime,f.node,new AbortController(),'sub_one'),{code:'execution_admission_lost'});
    const key=f.api.admitNode(f.origin,f.runtime,f.node,f.ctrl,'sub_one');assert.doesNotThrow(()=>f.api.assertNode(key));f.api.nodeWaiting(key,true);assert.throws(()=>f.api.assertNode(key),{code:'execution_admission_lost'});f.api.nodeWaiting(key,false);assert.doesNotThrow(()=>f.api.assertNode(key));f.api.releaseNode(key);assert.throws(()=>f.api.assertNode(key),{code:'execution_admission_lost'});
  }finally{await f.ownership.release();}
});
test('actual node intent is private, strict and bound before any call context is issued',async()=>{
  const f=await fixture();try{
    const key=f.api.admitNode(f.origin,f.runtime,f.node,f.ctrl,'sub_one'),messages=history();f.api.nodeHistory(key,messages);
    assert.throws(()=>f.api.nodeContext(key,'dbatch_one','call_one'),{code:'execution_admission_lost'});
    await f.api.nodeBatch(key,'dbatch_one');const files=fs.readdirSync(path.join(f.data,'desktop-executions-v1')).filter(x=>x.startsWith('intent-'));assert.equal(files.length,1);
    const file=path.join(f.data,'desktop-executions-v1',files[0]),saved=JSON.parse(fs.readFileSync(file));assert.deepEqual(saved.history,messages);assert.equal(saved.nodeId,'worker');assert.equal(saved.attempt,1);assert.equal(fs.statSync(file).mode&0o777,0o600);
    assert.ok(f.api.nodeContext(key,'dbatch_one','call_one'));assert.throws(()=>f.api.nodeContext(key,'dbatch_one','other'),{code:'execution_admission_lost'});
    assert.throws(()=>f.api.nodeHistory(key,history()),{code:'execution_admission_lost'});
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'desktop-executions-v1/state.json'))).entries.length,0);f.api.releaseNode(key);
  }finally{await f.ownership.release();}
});
test('cancel, pause, replacement, attempt, rewind and deletion revoke real node authority',async()=>{
  const mutations=[f=>f.ctrl.abort(),f=>f.runtime.ctrl.abort(),f=>{f.runtime.paused=true;},f=>f.runtime.permissionWaits.set(f.node.id,Date.now()),f=>{f.runtime.stopRequested=true;},f=>{f.runtime.closing=true;},f=>{f.node.attempts++;},f=>{f.node.status='waiting_resource';},f=>f.runtime.nodeControls.set(f.node.id,new AbortController()),f=>f.activeAgentRuns.set(f.run.id,{...f.runtime}),f=>{f.owner.cancelRequested=true;},f=>f.turnSettlers.set(f.session.id,{...f.owner}),f=>{f.session.turnSeq++;},f=>f.sessionRewindGenHighWater.set(f.session.id,1),f=>f.markSessionDeleted(f.session.id)];
  for(const mutate of mutations){const f=await fixture();try{const key=f.api.admitNode(f.origin,f.runtime,f.node,f.ctrl,'sub_one');mutate(f);assert.throws(()=>f.api.assertNode(key),{code:'execution_admission_lost'});await assert.rejects(f.api.runNode(key,()=>f.api.beforeModelRequest()),{code:'execution_admission_lost'});}finally{await f.ownership.release();}}
});
test('background or stale-origin workflows cannot borrow the foreground parent admission',async()=>{
  const f=await fixture();try{f.run.background=true;assert.throws(()=>f.api.admitNode(f.origin,f.runtime,f.node,f.ctrl,'sub_one'),{code:'execution_admission_lost'});f.run.background=false;f.session.turnSeq=2;assert.throws(()=>f.api.admitNode(f.origin,f.runtime,f.node,f.ctrl,'sub_one'),{code:'execution_admission_lost'});assert.equal(f.api.admitNode(null,f.runtime,f.node,f.ctrl,'sub_one'),null);}finally{await f.ownership.release();}
});
test('heartbeats and mail do not falsely release UI resource wait; actual acquisition or call completion does',()=>{
  const {recordAgentNodeProgress}=loadServerInternals(['recordAgentNodeProgress']),run={},node={status:'running'};
  recordAgentNodeProgress(run,node,{type:'agent_resource',state:'waiting',resources:['desktop']});assert.equal(node.status,'waiting_resource');
  for(const event of [{type:'subagent_progress',note:'tool heartbeat'},{type:'subagent_mail_in',sender:'other',text:'message'},{type:'subagent_steered',text:'steer'}]){
    recordAgentNodeProgress(run,node,event);assert.equal(node.status,'waiting_resource');assert.deepEqual(node.waitingForResources,['desktop']);
  }
  recordAgentNodeProgress(run,node,{type:'agent_resource',state:'acquired',resources:['desktop']});assert.equal(node.status,'running');
  recordAgentNodeProgress(run,node,{type:'agent_resource',state:'waiting',resources:['desktop']});recordAgentNodeProgress(run,node,{type:'tool_result',isError:true,id:'failed_lease'});assert.equal(node.status,'running');
});
test('candidate CLI child refuses before resolving or starting an unimplemented direct ACC relay',async()=>{
  const {runClaudeSubAgentOnce}=loadServerInternals(['runClaudeSubAgentOnce']);
  await assert.rejects(runClaudeSubAgentOnce({}),{code:'execution_cli_unavailable'});
});
test('exact read-only receipt control never creates a new business invocation for historical uncertainty',async()=>{
  const f=await fixture();try{let calls=0;const result=await f.api.invoke({id:'ai-computer-control',async callTool(name,args){calls++;assert.equal(name,'execution_receipt');assert.equal(args.invocation_id,'0'.repeat(32));return {ok:false,outcome:'unknown',incomplete:true};}},'execution_receipt',{invocation_id:'0'.repeat(32)});
    assert.equal(calls,1);assert.equal(result.outcome,'unknown');assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'desktop-executions-v1/state.json'))).entries.length,0);
  }finally{await f.ownership.release();}
});
