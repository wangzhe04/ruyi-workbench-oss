'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {fixture}=require('./journals-host.test.cjs');
const {functionBlock,constBlock}=require(path.join(process.cwd(),'dev-harness/lib/source-slice'));
const source=name=>fs.readFileSync(path.join(__dirname,'src',name),'utf8');
const original=name=>fs.readFileSync(path.join(process.cwd(),'ruyi-workbench/app/src',name),'utf8');
function domain(kind){
 const f=fixture(kind),events=[],logs=[],runtime={loaded:false,lastMaintenanceAt:0,generation:0};
 const context={require,Buffer,fs,fsp:f.io,path,setTimeout,clearTimeout,console,WorkDataJournals:f.journals,WorkDataStore:f.store,
  readConfig:async()=>({workDataEncryptionV1:f.state.enabled}),atomicWriteJson:f.base.atomicWriteJson,
  paths:{data:f.dir,agentRuns:f.dir},safeSessionId:s=>s,nowIso:()=>new Date(0).toISOString(),
  safeJsonParse:(s,v)=>{try{return JSON.parse(s);}catch{return v;}},logEvent:event=>logs.push(event),
  RUYI_EVENTS:{emit:(...args)=>events.push(args)},stewardRuntime:runtime,
  STEWARD_INBOX_FULL_READ_BYTES:8*1024*1024,STEWARD_INBOX_TAIL_BYTES:1024*1024,STEWARD_INBOX_MAINTENANCE_MS:100,
  STEWARD_INBOX_RETENTION_MS:1000,STEWARD_INBOX_HISTORY_MAX:2,STEWARD_DEDUPE_TAIL_ROWS:2000,
  STEWARD_DIR_NAME:'steward',STEWARD_INBOX_FILE:'inbox-v1.ndjson',STEWARD_CURSOR_FILE:'cursor-v1.json',
  STEWARD_CURSOR_SCHEMA:1,STEWARD_CURSOR_MAX_SESSIONS:500,STEWARD_CURSOR_MAX_RUNS:500,STEWARD_CURSOR_MAX_PENDING:500,
  STEWARD_CURSOR_MEM_MAX_SESSIONS:20000,STEWARD_CURSOR_MEM_MAX_RUNS:20000,STEWARD_TICK_MAX_EVENTS:200,STEWARD_CARRY_MAX_EVENTS:1000,STEWARD_SEEN_MAX_KEYS:10000,STEWARD_MERGE_WINDOW_MS:30000,
  STEWARD_MERGE_ACCUMULATE_KEYS:{nodeId:'nodeIds',errorClass:'errorClasses'},StewardHooks:{},
  STEWARD_EVENT_KINDS:['needs_you','failed','done','stalled','budget','adopted','reminder'],
  STEWARD_MERGED_SEQS_MAX:20,stewardEventDedupeKey:e=>e.seq,
  stewardCursorStore:{read:async()=>null},
  sessionAssociatedSaveIsTombstoned:()=>false,agentRunDir:()=>f.dir,
  readFileTail:async(file,n)=>{const raw=await fsp.readFile(file);return {buf:raw.subarray(-n),bytesRead:Math.min(raw.length,n)};},
  stewardCollectEvents:async()=>({events:(f.state.testEvents||[]).splice(0),activeSessionIds:['s1','s2'],activeRunIds:[]}),stewardApplyPresenceGate:events=>events,
 };
 const source13i=source('13i-steward-inbox.js'),source13j=source('13j-steward-tool-base.js'),source08=source('08-agent-runs.js');
 const iNames=['stewardDir','stewardInboxPath','stewardCursorPath','stewardInboxJournal','stewardReadInboxLegacyText','stewardReadInboxText','stewardParseInboxText','stewardReadInboxRows','stewardResetRuntimeState','stewardInboxRowDedupeKeys','stewardInboxPendingState','stewardLoadState','stewardMaintainInbox','stewardAppendInboxRows','stewardInboxCounts','stewardEventDedupeKey','stewardMergeAccumulate','stewardMergeInboxEvents','stewardTrimCursorMap','stewardSaveCursor','stewardTickOnce'];
 const jNames=['stewardDecisionsPath','stewardDecisionJournal','stewardAppendDecision','stewardReadDecisionsLegacyText','stewardReadDecisionsText'];
 const eNames=['agentRunEventsFile','agentRunEventsJournal','syncRunEventSeq','appendAgentRunEvent','flushAgentRunEvents','parseEventWindow','readAgentRunEvents','mapPool','autoResumeInterruptedRuns','markInterruptedAgentRuns'];
 const chunks=[functionBlock(original('00-boot.js'),'runKeyedChain'),functionBlock(original('02-session-store.js'),'repairMissionChangeTornTail'),
  ...iNames.map(n=>functionBlock(source13i,n)),...jNames.map(n=>n==='stewardDecisionsPath'?source13j.split('\n').find(line=>line.startsWith('const stewardDecisionsPath =')):functionBlock(source13j,n)),...eNames.map(n=>functionBlock(source08,n))];
 for(const chunk of chunks)assert.ok(chunk.length>40);
 const exports=iNames.concat(jNames,eNames);
 const declarations='let stewardAppendChain=Promise.resolve(),stewardDecisionChain=Promise.resolve(),stewardDecisionSeq=0,stewardInboxCountsMemo=null;const agentRunEventChains=new Map(),AGENT_RUN_EVENTS_TAIL_BYTES=512*1024,AGENT_RUN_EVENTS_PAGE_MAX=500,STEWARD_DECISIONS_FILE="decisions-v1.ndjson",STEWARD_DECISIONS_FULL_READ_BYTES=8*1024*1024,STEWARD_DECISIONS_TAIL_BYTES=1024*1024;';
 const ctx=vm.createContext(context);
 const api=vm.runInContext(declarations+chunks.join('\n')+'\n({'+exports.join(',')+',flushDecision:()=>stewardDecisionChain,flushInbox:()=>stewardAppendChain})',ctx);
 // Reuse native WorkDataStore fixture keys through the late hook, as production does.
 f.store.Hooks.keys={snapshot:async()=>{f.state.acquires++;if(f.state.keyError)throw f.state.keyError;const key=Buffer.from(f.key);return {key,instanceId:f.state.instanceId,release:()=>{f.state.releases++;key.fill(0);}};}};
 ctx.stewardCursorStore=f.store.createText({file:()=>api.stewardCursorPath(),purpose:'queue',schema:1,scopeId:'global',recordId:'steward-cursor',enabled:async()=>f.state.enabled,writeJson:f.base.atomicWriteJson});
 return {...f,api,ctx,runtime,events,logs};
}
const row=seq=>({inboxSeq:seq,kind:'done',sessionId:'sid',seq,at:new Date(0).toISOString(),payload:{summary:'secret-'+seq}});
test('real inbox append/read/count warm caches and loaded dedupe refuse missing or replaced keys',async()=>{
 const f=domain('steward-inbox');await f.api.stewardAppendInboxRows([row(7),row(9)]);assert.equal(f.events.length,2);
 const file=f.api.stewardInboxPath(),raw=await fsp.readFile(file,'utf8');assert.equal(raw.includes('secret-7'),false);
 const counts=await f.api.stewardInboxCounts();assert.equal(counts.byKind.done,2);await f.api.stewardLoadState();assert.equal(f.runtime.inboxSeq,9);
 const before=await fsp.readFile(file),seen=[...f.runtime.seen];f.state.keyError=Object.assign(Error('missing'),{code:'work_data_key.absent'});
 await assert.rejects(f.api.stewardInboxCounts(),{code:'work_data_key.absent'});await assert.rejects(f.api.stewardLoadState(),{code:'work_data_key.absent'});assert.deepEqual([...f.runtime.seen],seen);assert.ok((await fsp.readFile(file)).equals(before));
 f.state.keyError=null;f.state.instanceId='e'.repeat(32);await assert.rejects(f.api.stewardInboxCounts(),{code:'work_data.authenticate_failed'});assert.equal(f.events.length,2);
});
test('real inbox retention authenticates then writes sealed fresh ordinals and keeps latest water mark',async()=>{
 const f=domain('steward-inbox');await f.api.stewardAppendInboxRows([row(1),row(2),row(3)]);f.runtime.cursor={pendingIds:new Set()};f.runtime.lastMaintenanceAt=0;
 await f.api.stewardMaintainInbox(100000);const rows=await f.api.stewardReadInboxRows();assert.equal(rows.length,1);assert.equal(rows[0].inboxSeq,3);const raw=await fsp.readFile(f.api.stewardInboxPath(),'utf8');assert.equal(JSON.parse(raw.trim()).e.seq,0);assert.equal(raw.includes('secret-3'),false);
});
test('real decision logging failure is asynchronous code-only diagnostic and keeps completed action receipt',async()=>{
 const f=domain('steward-decisions');const sideEffectFile=path.join(f.dir,'completed-effect');await fsp.writeFile(sideEffectFile,'completed once');f.state.keyError=Object.assign(Error('private synthetic text'),{code:'work_data_key.absent'});
 const receipt=f.api.stewardAppendDecision({tool:'config_set',args:{secret:'do not emit'},undoRef:{large:'x'.repeat(1100000)}});assert.equal(receipt.seq,1);await f.api.flushDecision();assert.equal(await fsp.readFile(sideEffectFile,'utf8'),'completed once');assert.equal(fs.existsSync(f.api.stewardDecisionsPath()),false);assert.equal(f.logs.length,1);assert.equal(JSON.stringify(f.logs).includes('private synthetic text'),false);
 f.state.keyError=null;f.api.stewardAppendDecision({tool:'second',args:{},undoRef:{large:'x'.repeat(1100000)}});await f.api.flushDecision();const result=await f.api.stewardReadDecisionsText();assert.equal(JSON.parse(result.text).seq,2);
});
test('real event reader and sequence recovery use business seq instead of envelope physical ordinal',async()=>{
 const f=domain('agent-run-events'),run={id:'run_test',sessionId:'steward',eventSeq:900};
 f.api.appendAgentRunEvent(run,{type:'node_progress',data:{secret:'x'.repeat(1100000)}});f.api.appendAgentRunEvent(run,{type:'run_end'});await f.api.flushAgentRunEvents(run.id);
 const result=await f.api.readAgentRunEvents('steward',run.id,900,50);assert.deepEqual(Array.from(result.events,e=>e.seq),[901,902]);
 const recovered={id:run.id,sessionId:'steward',eventSeq:0};await f.api.syncRunEventSeq(recovered);assert.equal(recovered.eventSeq,902);f.state.keyError=Object.assign(Error('missing'),{code:'work_data_key.absent'});await assert.rejects(f.api.syncRunEventSeq(recovered),{code:'work_data_key.absent'});await assert.rejects(f.api.readAgentRunEvents('steward',run.id,0,50),{code:'work_data_key.absent'});assert.equal(recovered.eventSeq,902);
});
test('actual inbox next tick recovers partial business seq and seen before retrying failed batch carry',async()=>{
 const f=domain('steward-inbox');f.ctx.STEWARD_INBOX_RETENTION_MS=Number.MAX_SAFE_INTEGER;
 await f.api.stewardTickOnce();const cursorBefore=await fsp.readFile(f.api.stewardCursorPath());
 f.state.testEvents=[{kind:'done',sessionId:'s1',missionId:'s1',runId:'',seq:101,at:new Date(0).toISOString(),payload:{summary:'first'}},{kind:'done',sessionId:'s2',missionId:'s2',runId:'',seq:102,at:new Date(1).toISOString(),payload:{summary:'x'.repeat(200000)}}];
 f.state.appendTarget=f.api.stewardInboxPath();f.state.failAppend=true;f.state.failTruncate=true;
 await assert.rejects(f.api.stewardTickOnce(),{code:'work_data_journal.recovery_required'});assert.equal(f.runtime.carry.length,2);assert.equal(f.runtime.inboxSeq,0);assert.ok((await fsp.readFile(f.api.stewardCursorPath())).equals(cursorBefore));
 assert.equal(f.api.stewardInboxJournal().recoveryPending(),true);assert.equal((await f.api.stewardInboxCounts()).byKind.done,1);assert.equal(f.api.stewardInboxJournal().recoveryPending(),true);
 f.state.failAppend=false;f.state.failTruncate=false;const recovered=await f.api.stewardTickOnce();assert.equal(recovered.written,1);assert.equal(f.runtime.carry.length,0);
 const rows=await f.api.stewardReadInboxRows();assert.deepEqual(Array.from(rows,r=>[r.inboxSeq,r.seq]),[[1,101],[2,102]]);assert.equal(f.api.stewardInboxJournal().recoveryPending(),false);
});
