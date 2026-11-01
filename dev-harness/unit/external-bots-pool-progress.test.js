'use strict';
require('../lib/media-artifact-test-guard');
const{test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{producerFixture}=require('../lib/external-bots-pool-producer-fixture');
const{fixture}=require('../lib/external-bots-human-decisions-fixture');
function journal(f){return fs.readFileSync(f.journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
const semantic=run=>JSON.stringify({...run,updatedAt:undefined,nodes:run.nodes.map(({progressLog,lastActivityAt,...node})=>node)});
for(const action of ['approve','reject'])for(const phase of ['before-worker','own-applying',...(action==='approve'?['preflight-role','last-effect-cache']:[])])test('original signed '+action+' accepts original node progress/throttled save at '+phase+' and remains once',async t=>{
 const f=await producerFixture(t),{c,run}=f;if(phase==='last-effect-cache')f.config.agentAutoModelTiering=true;
 const offered=await f.offer();await f.decide(action,offered.code);const original=semantic(run),updated=run.updatedAt,log=JSON.stringify(run.nodes[0].progressLog),activity=run.nodes[0].lastActivityAt;
 let flushes=0;const progress=()=>{f.progress();flushes++;a.equal(semantic(run),original);a.notEqual(run.updatedAt,updated);a.notEqual(JSON.stringify(run.nodes[0].progressLog),log);a.notEqual(run.nodes[0].lastActivityAt,activity);};
 if(phase==='before-worker')progress();
 if(phase==='preflight-role'){const roles=c.getAgentRoleLibrary;c.getAgentRoleLibrary=async(...args)=>{const value=await roles(...args);progress();return value;};}
 if(phase==='last-effect-cache'){let reads=0;f.setCacheRead(async()=>{if(++reads===2)progress();return{models:[]};});}
 if(phase==='own-applying'){let ready=false;f.setFault((row,when)=>{if(row.status==='applying'&&when==='after')ready=true;return false;});const read=c.externalBotReadState;c.externalBotReadState=async(...args)=>{const value=await read(...args);if(ready){ready=false;progress();}return value;};}
 await f.perform();a.equal(flushes,1);const row=(await f.f.api.read()).remoteActions[0];a.equal(row.status,'applied');
 const rows=journal(f);a.deepEqual(rows.map(row=>row.status),['pending','applying',action==='approve'?'approved':'rejected']);a.equal(rows.at(-1).source,'external_human');a.equal(rows.at(-1).interventionVersion,2);a.equal(rows.at(-1).idempotencyKey,row.claim.idempotencyKey);a.equal(rows.at(-1).decisionFingerprint,row.claim.decisionFingerprint);
 a.equal(run.nodes.length,action==='approve'?2:1);if(action==='approve'){a.equal(run.nodes[1].id,rows.at(-1).decisionResponse.nodeId);a.deepEqual(Array.from(run.nodes[1].dependsOn),['origin']);}
 const before=fs.readFileSync(f.journal,'utf8'),nodes=run.nodes.map(node=>node.id).join();await f.decide(action,offered.code);const duplicate=await f.f.api.next(true);a.notEqual(duplicate?.kind,'remote');a.equal(fs.readFileSync(f.journal,'utf8'),before);a.equal(run.nodes.map(node=>node.id).join(),nodes);a.equal((await f.f.api.read()).remoteActions[0].status,'applied');
});
test('real producer source rejects semantic changes during the last original cache await',async t=>{
 for(const cause of ['run-revision','run-status','permission','proposal','node-task','node-tier','node-engine','node-model','node-role','node-resource','node-status','node-extra-semantic','node-pointer','node-list','run-pointer','live-pointer','ctrl-pointer','stop','abort','closing','config','budget-reader','budget-counter']){
  const f=await producerFixture(t),{c,run}=f,live=c.activeAgentRuns.get(run.id);f.config.agentAutoModelTiering=true;run.originTurnAgentCap=5;let used=0;
  live.admitPoolNode=consume=>{if(consume)used++;return{ok:true};};live.poolDecisionBudget=()=>{const value=used;return{material:[5,value],assert(){if(used!==value)throw Error('budget changed');}};};
  const o=await f.offer();await f.decide('approve',o.code);let reads=0;
  f.setCacheRead(async()=>{if(++reads===2){f.progress();const node=run.nodes[0];
   if(cause==='run-revision')run.revision=1;else if(cause==='run-status')run.status='paused';else if(cause==='permission')run.permissionCeiling='readonly';else if(cause==='proposal')run.taskPool[0].task='unshown task';
   else if(cause==='node-task')node.task='unshown origin';else if(cause==='node-tier')node.toolTier='exec';else if(cause==='node-engine')node.engine='claude';else if(cause==='node-model')node.model='unshown';else if(cause==='node-role')node.roleSnapshot={prompt:'unshown'};else if(cause==='node-resource')node.resources=['write:C:/other'];else if(cause==='node-status')node.status='succeeded';else if(cause==='node-extra-semantic')node.futureAuthority='changed';
   else if(cause==='node-pointer')run.nodes[0]={...node};else if(cause==='node-list')run.nodes=[...run.nodes];else if(cause==='run-pointer')live.run={...run};else if(cause==='live-pointer')c.activeAgentRuns.set(run.id,{...live});else if(cause==='ctrl-pointer')live.ctrl=new AbortController();else if(cause==='stop')live.stopRequested=true;else if(cause==='abort')live.ctrl.abort();else if(cause==='closing')live.closing=true;else if(cause==='config')f.changeConfig();else if(cause==='budget-reader')live.poolDecisionBudget=()=>({material:[5,0],assert(){}});else if(cause==='budget-counter')used++;
  }return{models:[]};});await f.perform();a.equal(run.nodes.length,1,cause);a.equal((await f.f.api.read()).remoteActions[0].status,'unknown',cause);a.equal(journal(f).some(row=>row.status==='approved'),false,cause);
 }
});
test('live and cold original replan retain timestamp and stable-file fences',async t=>{
 for(const cold of [false,true]){const f=await fixture(t,'replan');if(cold){await f.c.agentRunSnapshotStore(f.head.id,f.run.id).write(JSON.stringify(f.run));f.c.activeAgentRuns.delete(f.run.id);}const o=await f.offer();await f.decide('approve',o.code);
  if(cold){const file=f.c.agentRunFile(f.head.id,f.run.id),body=fs.readFileSync(file);fs.writeFileSync(file+'.new',body);fs.renameSync(file+'.new',file);}else f.run.updatedAt='changed authority timestamp';
  await f.perform();a.equal((await f.f.api.read()).remoteActions[0].status,'unknown');a.equal(f.run.nodes[0].toolTier,'edit');
 }
});
