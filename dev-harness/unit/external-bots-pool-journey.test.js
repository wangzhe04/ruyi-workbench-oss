'use strict';
require('../lib/media-artifact-test-guard');
const{test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const{producerFixture}=require('../lib/external-bots-pool-producer-fixture'),{functionBlock,constBlock,bracedBlock,sliceBlock}=require('../lib/source-slice');
const{scriptModel}=require('../lib/external-bots-c2/actual-http-fixture.cjs'),{inspectTerminal,actionCommand}=require('../lib/external-bots-c2/journey-contract.cjs');
const read=name=>fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src',name),'utf8');
const workflow=read('09-workflow.js'),runs=read('08-agent-runs.js');
const journeys=fs.readFileSync(process.env.RUYI_C2_POOL_JOURNEY_SOURCE||path.resolve(__dirname,'../lib/external-bots-c2/run-journeys.cjs'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function chain(t){
 const f=await producerFixture(t,{deferProposal:true}),{c,run}=f,output=path.join(path.dirname(f.journal),'journey-output');fs.mkdirSync(output);
 const model=scriptModel(()=>f.head.cwd,{output}),trace=[],runtime=c.activeAgentRuns.get(run.id),origin=run.nodes[0];let heldReady;const ready=new Promise(resolve=>{heldReady=resolve;});
 Object.assign(origin,{task:'C2_POOL_PROPOSER',dependsOn:[],resources:[],maxIters:100,attempts:1});
 for(const name of ['nodeControls','mailQueues','registeredAgentTools','autoSteerQueues','permissionWaits'])runtime[name]=new Map();
 Object.assign(c,{nodes:run.nodes,runId:run.id,provider:{id:'fake'},contextText:'',localCtrl:runtime.ctrl,permModeOverride:undefined,
  agentNodeContextWindow:()=>32000,buildUpstreamContext:()=>'',formatNodeEvidencePrompt:()=>'',resolveMemoryPreflight:async()=>({entries:[],coreEntries:[],status:{enabled:false}}),filterMemoryForNativeCli:x=>x,buildMemoryCheckPrompt:()=>'',buildMemoryPromptSection:()=>'',resolveProvider:()=>({id:'fake'}),deriveNodeOutputs:()=>{},indexNodeEvidence:()=>{},dropNodeMail:()=>{},drainNodeSteers:()=>'',sendToAgentImpl:()=>{throw Error('unexpected mail');}});
 c.runSubAgent=async args=>{
  trace.push('model:'+args.agentKey);const messages=[{role:'user',content:args.task}];
  let frames=await model.handler({body:{messages}}),call=frames.flatMap(frame=>frame.choices?.[0]?.delta?.tool_calls||[]).find(row=>row.function?.name==='propose_task');
  if(call){const proposal=await args.proposeTask(JSON.parse(call.function.arguments));await f.adoptProposal(proposal);args.onEvent({type:'subagent_pool_proposed',task:'C2_POOL_HELPER'});messages.push({role:'tool',content:JSON.stringify(proposal)});const pending=model.handler({body:{messages}});if(model.held.has('pool'))heldReady();frames=await pending;}
  const text=frames.map(frame=>frame.choices?.[0]?.delta?.content||'').join('');return{ok:true,result:text,iters:1,toolCalls:call?1:0};
 };
 const nodeBody=bracedBlock(workflow,'const runNode ='),step=functionBlock(runs,'computeSchedulerStep'),terminal=constBlock(workflow,'terminal');a.ok(nodeBody.length>18000&&step.length>1000);
 const dispatch=sliceBlock(workflow,'      runtime.registeredAgentTools.delete(node.id);','      let flight;');a.ok(dispatch.includes('node.attempts += 1'));
 c.startedCount=0;c.dispatched=0;
 vm.runInContext(step+'\n'+terminal+'\n'+nodeBody+';\nfunction dispatchOriginal(node){'+dispatch+'\nreturn runNode(node);}\nglobalThis.poolScheduler={runNode,dispatchOriginal,computeSchedulerStep,terminal};',c);
 const original=c.poolScheduler.runNode(origin);original.catch(()=>{});await Promise.race([ready,original.then(()=>{throw Error(JSON.stringify({origin,trace}));})]);a.equal(model.held.has('pool'),true);a.equal(run.taskPool.length,1);
 let dispatched=0;
 async function advance(){
  const held=model.held.has('pool'),before=c.poolScheduler.computeSchedulerStep(run.nodes,{inFlightIds:held?['origin']:[],concurrency:8,isTerminal:c.poolScheduler.terminal,failureContinues:()=>false});
  if(held){a.deepEqual(Array.from(before.toDispatch),[]);throw Error('original dependent helper cannot dispatch while proposer remains held');}
  await original;a.equal(origin.status,'succeeded');
  const step=c.poolScheduler.computeSchedulerStep(run.nodes,{inFlightIds:[],concurrency:8,isTerminal:c.poolScheduler.terminal,failureContinues:()=>false});
  for(const id of step.toDispatch){const node=run.nodes.find(row=>row.id===id);a.deepEqual(Array.from(node.dependsOn),['origin']);dispatched++;await c.poolScheduler.dispatchOriginal(node);}
 }
 const closeHeld=model.release;t.after(async()=>{closeHeld('pool');await original;});
 return{f,c,run,model,output,trace,advance,finishProposer:()=>original,get dispatched(){return dispatched;}};
}
for(const action of ['approve','reject'])test('original pool '+action+' journey releases the same held provider only after original terminal/claim then drives original scheduler/runNode once',async t=>{
 const h=await chain(t),{f,run,model}=h,events=[],idMap=new Map();let serial=0,ledger=await f.f.api.read(),sends=0;
 const fx={model,work:f.head.cwd,output:h.output,async createSession(){return f.head.id;},async launch(){return run.id;},async pending(){return f.iv;},bounded:value=>value,
  async wait(fn,label){if(label==='original proposer finishes after the verified decision')await h.finishProposer();if(label==='original scheduler consumes materialized pool node')await h.advance();const value=await fn();a.ok(value,label);return value;},
  async readRun(){return run;},journalFile:()=>f.journal,journal:()=>fs.readFileSync(f.journal,'utf8').trim().split('\n').map(JSON.parse),ledger:()=>ledger,nextId:kind=>kind+'_'+ ++serial,
  async offer(){events.push('offer');const value=await f.offer();ledger=await f.f.api.read();return{...value,pages:['complete original page']};},
  async callback(id,_text,_platform,options={}){if(options.badSignature||options.senderId)return{status:403};events.push('legitimate-callback');const item=await f.decide(action,(await f.f.api.read()).remoteActions[0]&&idMap.get('code'));idMap.set(id,item.id);await f.perform();ledger=await f.f.api.read();return{status:200};},
  async delivered(id){const item=ledger.items.find(row=>row.id===idMap.get(id));a.ok(item);f.f.advance(1001);const job=await f.f.api.next(true);a.ok(job&&job.kind==='send');await f.f.api.finish(job,{status:'sent',messageId:'original-inert-transport-receipt'});ledger=await f.f.api.read();sends++;events.push('strict-sent');return ledger.items.find(row=>row.id===item.id);},
  sent:()=>Array(sends),async command(){events.push('reuse');await f.decide(action,idMap.get('code'));ledger=await f.f.api.read();},
 };
 const offer=fx.offer;fx.offer=async(...args)=>{const value=await offer(...args);idMap.set('code',value.code);return value;};
 const release=model.release;model.release=kind=>{events.push('release');const row=ledger.remoteActions[0],terminal=inspectTerminal(fx.journal(),f.iv,'pool');a.equal(row.status,'applied');a.equal(row.claim.idempotencyKey,terminal.idempotencyKey);a.equal(row.claim.decisionFingerprint,terminal.decisionFingerprint);return release(kind);};
 const context={fs,path,NATIVE:['permission','question','plan'],PLATFORM:{pool:'feishu'},assertThat:(value,label)=>a.ok(value,label),actionCommand,inspectTerminal,
  browserPending:async()=>{},browserTerminal:async()=>{},modelAuthorityProbe:async()=>{events.push('forge-before-callback');a.equal(fx.journal().length,1);return{inertHostOnly:true};}};
 vm.createContext(context);vm.runInContext(functionBlock(journeys,'workflowPending')+'\n'+functionBlock(journeys,'assertEffect')+'\n'+functionBlock(journeys,'oneJourney')+'\nglobalThis.execute=oneJourney;',context);
 const result=await context.execute(fx,'pool',action,6,{ok:value=>a.ok(value)},h.output);
 a.equal(result.status,action==='approve'?'approved':'rejected');a.ok(events.indexOf('forge-before-callback')<events.indexOf('legitimate-callback'));a.ok(events.indexOf('strict-sent')<events.indexOf('release'));
 a.equal(h.dispatched,action==='approve'?1:0);a.equal(fx.journal().length,3);if(action==='approve')a.equal(run.nodes[1].result,'C2_POOL_HELPER_ACTUAL_CONSUMED');
});
test('effect oracle accepts only original succeeded status and exact helper result',async t=>{
 const h=await chain(t),{f,run,model}=h,o=await f.offer();await f.decide('approve',o.code);await f.perform();
 const row=(await f.f.api.read()).remoteActions[0],terminal=inspectTerminal(fs.readFileSync(f.journal,'utf8').trim().split('\n').map(JSON.parse),f.iv,'pool');a.equal(row.status,'applied');a.equal(row.claim.idempotencyKey,terminal.idempotencyKey);
 model.release('pool');await h.advance();a.equal(run.nodes[1].status,'succeeded');a.equal(run.nodes[1].attempts,1);
 const effect=vm.runInNewContext(functionBlock(journeys,'assertEffect')+'\nassertEffect',{fs,NATIVE:['permission','question','plan'],assertThat:(value,text)=>a.ok(value,text)}),scenario={type:'pool',action:'approve',sid:f.head.id,runId:run.id,iv:f.iv};
 const fx={readRun:async()=>run,wait:async fn=>{const value=await fn();a.ok(value,'exact original successful node required');return value;}};
 await effect(fx,scenario,terminal);
 for(const wrong of ['completed','failed','cancelled']){run.nodes[1].status=wrong;await a.rejects(effect(fx,scenario,terminal));}
 run.nodes[1].status='succeeded';run.nodes[1].result='C2_POOL_HELPER_ACTUAL_CONSUMED forged extra';await a.rejects(effect(fx,scenario,terminal));
});
