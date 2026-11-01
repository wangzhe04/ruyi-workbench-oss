'use strict';
// Inert I/O host for the original workflow producer, node event,1500ms
// throttle/save and original verified callback/witness/CAS path. No scheduler,
// node result, terminal or pending proposal is fabricated by this helper.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),a=require('node:assert/strict');
const {fixture}=require('./external-bots-human-decisions-fixture'),{functionBlock,constBlock,bracedBlock}=require('./source-slice');
const source=name=>fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src',name),'utf8');
async function producerFixture(t,options={}){
 const f=await fixture(t,'pool',{strictRoles:true,signed:true,...options}),{c,run,head}=f;
 const journal=path.join(c.paths.sessions,head.id+'.interventions.ndjson');fs.writeFileSync(journal,'');c.interventionRecordCache.clear();c.interventionAppendCounts.clear();run.taskPool.length=0;
 Object.assign(c,{run,runtime:c.activeAgentRuns.get(run.id),node:run.nodes[0],parentSession:head,config:f.config,roleLibrary:new Map(),onEvent:evt=>f.events.push(evt),nowIso:()=>new Date(c.Date.now()).toISOString()});
 run.createdAt=c.nowIso();
 const workflow=source('09-workflow.js'),runs=source('08-agent-runs.js'),autonomy=source('07-autonomy.js'),ledger=source('09b-replan-ledger.js');
 const slices=[...['PROGRESS_SAVE_INTERVAL_MS','lastProgressSaveAt','progressSaveTimer','poolPolicy','wfCwd'].map(name=>[name,constBlock(workflow,name)]),
  ...['flushProgressSave','throttledSaveRun','proposeTaskImpl','nodeEvent'].map(name=>[name,bracedBlock(workflow,'const '+name+' =')+';']),
  ...['poolChainDepth','recordAgentNodeProgress','recordRunStalledEvent','accumulateRunUsage'].map(name=>[name,functionBlock(runs,name)]),
  ['recordNodeContinuation',functionBlock(ledger,'recordNodeContinuation')],...['POOL_MAX_TOTAL','POOL_CHAIN_MAX'].map(name=>[name,constBlock(autonomy,name)])];
 for(const[name,text]of slices)a.ok(text.length>10,name);
 const timers=[],oldTimeout=c.setTimeout,oldClear=c.clearTimeout;
 c.setTimeout=(callback,delay)=>{const token={callback,delay,unref(){}};timers.push(token);return token;};
 c.clearTimeout=token=>{if(timers.includes(token))token.cleared=true;else oldClear(token);};
 vm.runInContext(slices.map(row=>row[1]).join('\n')+'\nglobalThis.poolProducer={proposeTaskImpl,nodeEvent,flushProgressSave,throttledSaveRun};',c);
 c.poolProducer.nodeEvent({type:'subagent_progress',chars:1}); // original leading save
 f.f.advance(10);
 const adoptProposal=async proposal=>{a.equal(proposal.ok,true);a.equal(proposal.status,'proposed');const iv=(await f.api.readInterventions(head.id)).find(row=>row.id===proposal.poolId);a.ok(iv);Object.assign(f.iv,JSON.parse(JSON.stringify(iv)));};
 const proposal=options.deferProposal?null:await c.poolProducer.proposeTaskImpl('origin',{task:'C2_POOL_HELPER',reason:'C2 real proposal'});
 if(proposal){await adoptProposal(proposal);a.equal(timers.length,1);a.ok(timers[0].delay>0&&timers[0].delay<=1500);}
 let chars=1;
 const progress=()=>{f.f.advance(1500);c.poolProducer.nodeEvent({type:'subagent_progress',chars:++chars});timers[0].callback();};
 t.after(()=>{c.setTimeout=oldTimeout;c.clearTimeout=oldClear;});
 return {...f,journal,proposal,adoptProposal,progress,timers,slices};
}
module.exports={producerFixture};
