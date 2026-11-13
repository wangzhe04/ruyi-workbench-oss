'use strict';
// Isolated real-file state machine only. Ownership is a simulated assertion, receipts are synthetic;
// this does not qualify actual server ownership, provider dispatch, ACC/native IO or restart replay.
const {test:nodeTest,after}=require('node:test');
const test=(name,fn)=>nodeTest(name,{skip:process.platform==='win32'},fn); // POSIX private-file feature; Windows legacy remains separate.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-execution-ledger-'));
for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR'])process.env[key]=path.join(root,key);
process.env.RUYI_HOME=path.join(root,'data');process.env.WIN_CLAUDE_WORKBENCH_HOME=process.env.RUYI_HOME;
const {loadServerInternals}=require('../lib/server-internals');
const {DesktopExecutionLedger:Ledger,DurableJsonStore}=loadServerInternals(['DesktopExecutionLedger','DurableJsonStore']);
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let count=0;
function fixture(extra={}){
  const directory=path.join(root,'ledger-'+(++count));let owned=true,ownerNumber=0;
  const options={directory,isOwner:()=>owned,isTurnCurrent:()=>true,...extra};
  return {directory,file:path.join(directory,'state.json'),create:()=>{const current=++ownerNumber;return Ledger.create({...options,isOwner:()=>owned&&current===ownerNumber});},loseOwner:()=>{owned=false;}};
}
const client={clientId:'1'.repeat(32),accWorkerId:'2'.repeat(32),accPid:12345,contextRequired:true};
const input=(id='call')=>({sessionId:'sess_fixture',turnSeq:1,admissionId:hash('actual-host-driver'),callIdHash:hash(id),toolName:'wait',args:{seconds:0,private_note:'private-你好'},client});
function receipt(preparation,result={ok:true},change=()=>{}){
  const meta=preparation.metadata,rootOp='3'.repeat(32),toolOp='4'.repeat(32);
  const base={schema:1,invocation_id:meta.invocation_id,acc_worker_id:client.accWorkerId,acc_pid:client.accPid};
  const flags={};for(const key of ['ok','action_sent','acted','cancelled','confirmed','outcome','code'])if(Object.hasOwn(result,key))flags[key]=result[key];
  const records=[{...base,stage:'acc_request_accepted',operation_id:rootOp,session_id:meta.session_id,turn_seq:meta.turn_seq,
    call_id_hash:meta.call_id_hash,tool:meta.tool_name,caller_args_sha256:meta.args_sha256,caller_args_codec:meta.args_codec,
    caller_semantic_sha256:meta.args_semantic_sha256,received_semantic_sha256:meta.args_semantic_sha256,args_semantic_codec:meta.args_semantic_codec},
    {...base,stage:'tool_entered',operation_id:toolOp,parent_operation_id:rootOp,tool:meta.tool_name},
    {...base,stage:'tool_terminal',operation_id:toolOp,tool:meta.tool_name,...flags},
    {...base,stage:'acc_request_terminal',operation_id:rootOp,ok:true}];
  records.forEach((row,index)=>{row.sequence=index+1;});
  const value={ok:true,schema:1,invocation_id:meta.invocation_id,execution_receipt_version:1,incomplete:false,request_terminal_observed:true,records,
    semantic_validation:{semantic_version:1,invocation_id:meta.invocation_id,records_validated:records.length,lifecycle_unknown:false,
      request_terminal_observed:true,request_transport_returned:true,reported_unknown_operation_ids:[],unresolved_operation_ids:[]}};
  change(value);return value;
}
async function dispatched(ledger,id='call'){
  const prepared=await ledger.prepare(input(id));await ledger.markDispatch(prepared.invocationId,()=>true);return prepared;
}

test('preparation commits only hashes/identities before returning an immutable dispatchable value',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const args=input();const prepared=await ledger.prepare(args);
  args.args.private_note='changed';assert.equal(prepared.snapshot.private_note,'private-你好');
  const persisted=fs.readFileSync(f.file,'utf8');assert.ok(!persisted.includes('private-你好'));
  const value=JSON.parse(persisted),row=value.entries[0];assert.equal(row.phase,'prepared');
  assert.equal(row.argsSha256,hash(prepared.json));assert.equal(row.argsSemanticSha256,prepared.metadata.args_semantic_sha256);
  assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(Object.isFrozen(prepared.snapshot),true);
  assert.equal((await ledger.guard('sess_fixture')).ok,true);
});
test('simultaneous preparations serialize without losing records or confusing a just-committed live preparation',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();
  const values=await Promise.all(Array.from({length:8},(_,index)=>ledger.prepare(input('call-'+index))));
  assert.equal((await ledger.entries()).length,8);assert.equal(new Set(values.map(row=>row.invocationId)).size,8);
  assert.equal((await ledger.guard('sess_fixture')).ok,true);
});
test('every pending prior-epoch phase becomes a durable hold on reopen without invoking any tool',async()=>{
  for(const phase of ['prepared','dispatching','returned']){
    const f=fixture(),first=f.create();await first.open();const prepared=await first.prepare(input());
    if(phase!=='prepared')await first.markDispatch(prepared.invocationId,()=>true);
    if(phase==='returned')await first.recordResult(prepared.invocationId,{ok:true},receipt(prepared));
    const second=f.create();await second.open();const row=(await second.entries())[0];
    assert.equal(row.phase,'unknown');assert.equal(row.holdReason,'host_restarted');assert.equal((await second.guard('sess_fixture')).ok,false);
    await assert.rejects(second.prepare(input('new')),{code:'execution_reconciliation_required'});
    assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).entries[0].phase,'unknown');
  }
});
test('a duplicate call identity never becomes a second dispatch, even after a verified result and delivery',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared));await ledger.markDelivered(prepared.invocationId,hash('saved-history'));
  await assert.rejects(ledger.prepare(input()),{code:'execution_duplicate_call'});assert.equal((await ledger.entries()).length,1);
  const reopened=f.create();await reopened.open();assert.equal((await reopened.guard('sess_fixture')).ok,true);
  assert.equal((await reopened.entries())[0].phase,'returned');
});
test('ordinary returned results require matching actual worker/tool/argument and terminal facts',async()=>{
  for(const change of [value=>{value.records[0].received_semantic_sha256='0'.repeat(64);},
    value=>{value.records[1].acc_worker_id='0'.repeat(32);},value=>{value.records[0].tool='other';},
    value=>{value.semantic_validation.lifecycle_unknown=true;},value=>{value.records[3].operation_id='0'.repeat(32);},
    value=>{value.records[2].ok=false;}]){
    const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
    const row=await ledger.recordResult(prepared.invocationId,{ok:true,private_result:'do-not-store'},receipt(prepared,{ok:true},change));
    assert.equal(row.phase,'unknown');assert.equal(row.holdReason,'receipt_unverified');
    assert.equal((await ledger.guard('sess_fixture')).ok,false);assert.ok(!fs.readFileSync(f.file,'utf8').includes('do-not-store'));
    await assert.rejects(ledger.markDelivered(prepared.invocationId,hash('not-saved')),{code:'execution_delivery_refused'});
  }
});
test('reported unknown is held independently of a claimed complete lifecycle; failed tools are not claimed undispatched',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  const failed={ok:false,action_sent:true,outcome:'unknown'};
  assert.equal((await ledger.recordResult(prepared.invocationId,failed,receipt(prepared,failed))).phase,'unknown');
  const other=fixture(),normal=other.create();await normal.open();const sent=await dispatched(normal);
  const completedFailure={ok:false,action_sent:true};const row=await normal.recordResult(sent.invocationId,completedFailure,receipt(sent,completedFailure));
  assert.equal(row.phase,'returned');assert.equal(row.observed.flags.action_sent,true);assert.equal(row.observed.flags.outcome,undefined);
  assert.equal((await normal.guard('sess_fixture')).ok,false); // actual history has not committed yet
});
test('client replacement or lost ownership prevents a preparation being used for dispatch',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const prepared=await ledger.prepare(input());
  await assert.rejects(ledger.markDispatch(prepared.invocationId,()=>false),{code:'execution_dispatch_refused'});
  assert.equal((await ledger.guard('sess_fixture')).ok,false);
  const other=fixture(),owned=other.create();await owned.open();const next=await owned.prepare(input());other.loseOwner();
  await assert.rejects(owned.markDispatch(next.invocationId,()=>true),{code:'execution_owner_lost'});
});
test('storage failure after dispatch leaves a durable hold and never substitutes a memory-only success',async()=>{
  let fail=false;const f=fixture({makeStore:options=>{const store=DurableJsonStore.create(options);return {...store,write:value=>fail?Promise.reject(Object.assign(new Error('synthetic ENOSPC'),{code:'ENOSPC'})):store.write(value)};}});
  const ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);fail=true;
  await assert.rejects(ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared)),{code:'ENOSPC'});fail=false;
  assert.equal((await ledger.guard('sess_fixture')).ok,false);assert.equal((await ledger.entries())[0].phase,'dispatching');
});
test('corrupt, missing and replaced storage is refused rather than reinitialized as empty',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();await ledger.prepare(input());
  fs.writeFileSync(f.file,'{',{mode:0o600});await assert.rejects(ledger.entries());assert.equal(fs.readFileSync(f.file,'utf8'),'{');
  fs.unlinkSync(f.file);await assert.rejects(f.create().open(),{code:'ENOENT'});assert.equal(fs.existsSync(f.file),false);
  const other=fixture(),opened=other.create();await opened.open();fs.renameSync(other.directory,other.directory+'-original');fs.mkdirSync(other.directory,{mode:0o700});
  await assert.rejects(opened.entries(),{code:'execution_storage_changed'});
});
test('capacity refuses without pruning any unresolved row',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();await ledger.prepare(input());
  const value=JSON.parse(fs.readFileSync(f.file,'utf8')),base=value.entries[0];
  value.entries=Array.from({length:Ledger.limits.maxEntries},(_,index)=>({...base,invocationId:(index+1).toString(16).padStart(32,'0'),
    sessionId:'sess_capacity_'+index,callIdHash:hash('row-'+index),phase:'unknown',holdReason:'fixture_unknown'}));
  fs.writeFileSync(f.file,JSON.stringify(value,null,2),{mode:0o600});const before=fs.readFileSync(f.file);
  await assert.rejects(ledger.prepare(input('new-capacity-call')),{code:'execution_ledger_capacity'});
  assert.ok(fs.readFileSync(f.file).equals(before));assert.equal((await ledger.entries()).length,256);
});
test('retirement requires verified delivered records and a root-side closed-history/ACC-retention confirmation',async()=>{
  let confirmation=false;const f=fixture({confirmRetirement:async()=>confirmation}),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared));
  await assert.rejects(ledger.retireTurn('sess_fixture',1),{code:'execution_retirement_refused'});
  await ledger.markDelivered(prepared.invocationId,hash('saved-history'));
  await assert.rejects(ledger.retireTurn('sess_fixture',1),{code:'execution_retirement_refused'});assert.equal((await ledger.entries()).length,1);
  confirmation=true;assert.equal(await ledger.retireTurn('sess_fixture',1),1);assert.equal((await ledger.entries()).length,0);
});
test('unknown records cannot be retired even if a caller confirms closure',async()=>{
  const f=fixture({confirmRetirement:async()=>true}),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  await ledger.recordUnknown(prepared.invocationId,'transport_lost');
  await assert.rejects(ledger.retireTurn('sess_fixture',1),{code:'execution_retirement_refused'});assert.equal((await ledger.entries())[0].phase,'unknown');
});

test('client facts and receipt content are snapshotted before asynchronous ledger IO',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const request=input();request.client={...client};
  const pending=ledger.prepare(request);request.client.accWorkerId='9'.repeat(32);const prepared=await pending;
  assert.equal((await ledger.entries())[0].accWorkerId,client.accWorkerId);
  await ledger.markDispatch(prepared.invocationId,()=>true);
  const evidence=receipt(prepared),result=ledger.recordResult(prepared.invocationId,{ok:true},evidence);
  evidence.records[0].acc_worker_id='9'.repeat(32);
  assert.equal((await result).phase,'returned');
});
test('a prepared sibling is refused if another call becomes uncertain before its dispatch marker',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const a=await dispatched(ledger,'a'),b=await ledger.prepare(input('b'));
  await ledger.recordUnknown(a.invocationId,'transport_lost');
  await assert.rejects(ledger.markDispatch(b.invocationId,()=>true),{code:'execution_reconciliation_required'});
  assert.equal((await ledger.entries())[1].phase,'prepared');
});
test('two live authorities for the same canonical directory cannot create independent write chains',async()=>{
  const directory=path.join(root,'exclusive-ledger');const options={directory,isOwner:()=>true,isTurnCurrent:()=>true};
  const first=Ledger.create(options);await first.open();const second=Ledger.create(options);
  await assert.rejects(second.open(),{code:'execution_owner_conflict'});await first.prepare(input());assert.equal((await first.entries()).length,1);
});

test('strict root record validation rejects contradictory returned-unknown state without resetting the file',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared));await ledger.markDelivered(prepared.invocationId,hash('history'));
  const value=JSON.parse(fs.readFileSync(f.file,'utf8'));value.entries[0].observed.flags.outcome='unknown';
  const corrupt=JSON.stringify(value,null,2);fs.writeFileSync(f.file,corrupt,{mode:0o600});
  await assert.rejects(ledger.entries(),{code:'EDURABLE_VALIDATE'});assert.equal(fs.readFileSync(f.file,'utf8'),corrupt);
});
test('SDK validation failure may prove non-dispatch only with no actual wrapper and no conflicting action flags',async()=>{
  for(const actionSent of [undefined,true]){
    const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
    const result={ok:false,...(actionSent===undefined?{}:{action_sent:actionSent})};
    const evidence=receipt(prepared,result,value=>{
      value.records=[value.records[0],value.records[3]];value.records[1].sequence=2;
      value.records[1].ok=false;value.records[1].outcome='not_dispatched';
      value.semantic_validation.records_validated=2;value.semantic_validation.request_transport_returned=false;
    });
    const row=await ledger.recordResult(prepared.invocationId,result,evidence);
    assert.equal(row.phase,actionSent===undefined?'returned':'unknown');
  }
});
test('the root ledger does not execute inherited serialization hooks during prepare, receipt validation or delivery',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();
  const arrayBefore=Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'),objectBefore=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');let invoked=0;
  try{
    Object.defineProperty(Array.prototype,'toJSON',{configurable:true,value(){invoked++;return [];}});
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){invoked++;return {schema:1,entries:[]};}});
    const prepared=await dispatched(ledger);assert.equal((await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared))).phase,'returned');
    await ledger.markDelivered(prepared.invocationId,hash('durable-history'));await ledger.prepare(input('next-call'));
    assert.equal((await ledger.entries()).length,2);assert.equal(invoked,0);
  }finally{
    if(arrayBefore)Object.defineProperty(Array.prototype,'toJSON',arrayBefore);else delete Array.prototype.toJSON;
    if(objectBefore)Object.defineProperty(Object.prototype,'toJSON',objectBefore);else delete Object.prototype.toJSON;
  }
});
test('loss of authority during the actual write cannot return a dispatchable preparation',async()=>{
  let lose=false;const f=fixture({makeStore:options=>{const store=DurableJsonStore.create(options);return {...store,write:async value=>{
    const written=await store.write(value);if(lose)f.loseOwner();return written;
  }};}}),ledger=f.create();await ledger.open();lose=true;
  await assert.rejects(ledger.prepare(input()),{code:'execution_owner_lost'});
  assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).entries[0].phase,'prepared');
});

test('ordinary business exit codes remain result data and are not invented as receipt flags',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  const evidence=receipt(prepared,{ok:false});const row=await ledger.recordResult(prepared.invocationId,{ok:false,code:7},evidence);
  assert.equal(row.phase,'returned');assert.equal(row.observed.flags.code,undefined);assert.equal(row.observed.flags.action_sent,undefined);
});

test('receipt code projection uses Python code points and preserves astral-boundary distinctions',async()=>{
  for(const [returned,reported,expected] of [
    ['🚀'.repeat(50)+'X','🚀'.repeat(50)+'Y','unknown'],
    ['🚀'.repeat(99)+'X','🚀'.repeat(99)+'Y','unknown'],
    ['🚀'.repeat(100)+'X','🚀'.repeat(100),'returned']]){
    const f=fixture(),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
    const row=await ledger.recordResult(prepared.invocationId,{ok:false,code:returned},receipt(prepared,{ok:false,code:reported}));
    assert.equal(row.phase,expected);
    if(expected==='returned')assert.equal(Array.from(row.observed.flags.code).length,100);
  }
});

test('authority handover refuses until the old write has drained, then preserves it as an unknown record',async()=>{
  let pause=false,entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({makeStore:options=>{const store=DurableJsonStore.create(options);return {...store,write:async value=>{
    if(pause){entered();await gate;}return store.write(value);
  }};}}),first=f.create();await first.open();pause=true;
  const pending=first.prepare(input());await started;const second=f.create();
  await assert.rejects(second.open(),{code:'execution_owner_draining'});release();
  await assert.rejects(pending,{code:'execution_owner_lost'});pause=false;await second.open();
  const entries=await second.entries();assert.equal(entries.length,1);assert.equal(entries[0].phase,'unknown');
  assert.equal((await second.guard('sess_fixture')).ok,false);
});
test('retired turns remain closed across reopen and explicit newer rewind generation gets a distinct admission',async()=>{
  const f=fixture({confirmRetirement:async()=>true}),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared));await ledger.markDelivered(prepared.invocationId,hash('saved'));
  await ledger.retireTurn('sess_fixture',1);
  await assert.rejects(ledger.prepare(input()),{code:'execution_turn_closed'});
  const next=f.create();await next.open();await assert.rejects(next.prepare(input('different-id')),{code:'execution_turn_closed'});
  await next.prepare({...input('next-turn'),turnSeq:2});
  await next.prepare({...input('explicit-rewind'),rewindGen:1});
  assert.equal((await next.entries()).length,2);
});

test('prepare and dispatch require the explicit live host turn, not a caller-supplied newer generation',async()=>{
  const current={sessionId:'sess_fixture',turnSeq:1,rewindGen:0,admissionId:hash('actual-host-driver')};
  const f=fixture({isTurnCurrent:scope=>Object.keys(current).every(key=>scope[key]===current[key])}),ledger=f.create();await ledger.open();
  await assert.rejects(ledger.prepare({...input(),rewindGen:1}),{code:'execution_admission_lost'});
  const prepared=await ledger.prepare(input());current.admissionId=hash('new-host-driver');
  await assert.rejects(ledger.markDispatch(prepared.invocationId,()=>true),{code:'execution_admission_lost'});
  assert.equal((await ledger.entries())[0].phase,'prepared');
});
test('late actual results remain recordable after the host turn stops, while new dispatch is refused',async()=>{
  let current=true;const f=fixture({isTurnCurrent:()=>current}),ledger=f.create();await ledger.open();const prepared=await dispatched(ledger);
  current=false;assert.equal((await ledger.recordResult(prepared.invocationId,{ok:true},receipt(prepared))).phase,'returned');
  await assert.rejects(ledger.prepare(input('late-new')),{code:'execution_admission_lost'});
});
test('retirement confirmation receives an exact scope even when the turn has no records',async()=>{
  let received;const f=fixture({confirmRetirement:async(rows,scope)=>{received={length:rows.length,...scope};return true;}}),ledger=f.create();await ledger.open();
  assert.equal(await ledger.retireTurn('sess_fixture',1),0);assert.deepEqual(received,{length:0,sessionId:'sess_fixture',turnSeq:1,rewindGen:0});
  await assert.rejects(ledger.prepare(input()),{code:'execution_turn_closed'});
});

const nodeScope={kind:'foreground_workflow_node',runId:'run_fixture',nodeId:'worker',attempt:1,subagentId:'sub_fixture',batchId:'dbatch_fixture',toolCallId:'image_call'};
function nodeHistory(){return [{role:'user',content:'actual node task'},{role:'assistant',content:'',tool_calls:[{id:'image_call',function:{name:'fixture_image',arguments:'{}'}}]},
  {role:'tool',tool_call_id:'image_call',content:'projected image result'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}];}
async function nodeReturned(f){const ledger=f.create();await ledger.open();const p=await ledger.prepare({...input(),nodeDelivery:nodeScope});await ledger.markDispatch(p.invocationId,()=>true);await ledger.recordResult(p.invocationId,{ok:true},receipt(p));return {ledger,p};}
async function nodeDelivered(f){const {ledger,p}=await nodeReturned(f),history=nodeHistory(),binding={...nodeScope,index:2,images:[JSON.stringify(history[3].content)],imageIndices:[3]};
  const proof=await ledger.saveNodeDelivery(p.invocationId,history,binding,()=>true);await ledger.markNodeDelivered(p.invocationId,proof);return {ledger,p,history,binding,proof};}
test('node delivery reserves a private slot before dispatch, pins exact actual history and survives cold read',async()=>{
  const f=fixture(),{ledger,p,history,proof}=await nodeDelivered(f);assert.equal(proof.historySha256,hash(JSON.stringify(history)));
  const file=path.join(f.directory,proof.file),stored=JSON.parse(fs.readFileSync(file));assert.deepEqual(stored.history,history);assert.equal(stored.admissionId,hash('actual-host-driver'));
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal((await ledger.guard('sess_fixture')).ok,true);
  const cold=f.create();await cold.open();assert.equal((await cold.guard('sess_fixture')).ok,true);assert.equal((await cold.entries())[0].nodeDelivery.historySha256,proof.historySha256);
});
test('deleting or tampering acknowledged node snapshot causes durable hold on actual cold reopen',async()=>{
  for(const corruption of ['missing','history','binding','image_binding']){
    const f=fixture(),{p,proof}=await nodeDelivered(f),file=path.join(f.directory,proof.file);
    if(corruption==='missing')fs.unlinkSync(file);else{const data=JSON.parse(fs.readFileSync(file));if(corruption==='history')data.history[2].content='tampered';if(corruption==='binding')data.binding.nodeId='other';if(corruption==='image_binding')data.binding.images=[];fs.writeFileSync(file,JSON.stringify(data,null,2));}
    const cold=f.create();await cold.open();const row=(await cold.entries())[0];assert.equal(row.phase,'unknown');assert.equal(row.holdReason,'node_history_unverified');assert.equal(row.deliverySha256,null);
    assert.equal(row.nodeDelivery.historySha256,proof.historySha256);assert.equal((await cold.guard('sess_fixture')).ok,false);await assert.rejects(cold.prepare(input('after-loss')),{code:'execution_reconciliation_required'});
  }
});
test('warm guard validates node snapshot and generic main acknowledgement cannot bypass node proof',async()=>{
  const f=fixture(),{ledger,p}=await nodeReturned(f);await assert.rejects(ledger.markDelivered(p.invocationId,hash('invented-history')),{code:'execution_delivery_refused'});
  assert.equal((await ledger.guard('sess_fixture')).ok,false);
  const g=fixture(),delivered=await nodeDelivered(g);fs.unlinkSync(path.join(g.directory,delivered.proof.file));assert.equal((await delivered.ledger.guard('sess_fixture')).ok,false);
  assert.equal(JSON.parse(fs.readFileSync(g.file)).entries[0].phase,'unknown');
});
test('node snapshot capacity refuses before preparation and reserved slot remains usable when namespace becomes full',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();for(let i=0;i<1023;i++)fs.writeFileSync(path.join(f.directory,'filler-'+i),'');
  await assert.rejects(ledger.prepare({...input(),nodeDelivery:nodeScope}),{code:'execution_delivery_capacity'});assert.equal((await ledger.entries()).length,0);
  const g=fixture(),second=g.create();await second.open();for(let i=0;i<1022;i++)fs.writeFileSync(path.join(g.directory,'filler-'+i),'');
  const p=await second.prepare({...input(),nodeDelivery:nodeScope});assert.equal(fs.readdirSync(g.directory).length,1024);
  const reservation=JSON.parse(fs.readFileSync(path.join(g.directory,'delivery-'+p.invocationId+'.json')));assert.equal(reservation.kind,'node_delivery_reservation');
  await second.markDispatch(p.invocationId,()=>true);await second.recordResult(p.invocationId,{ok:true},receipt(p));const history=nodeHistory();
  const proof=await second.saveNodeDelivery(p.invocationId,history,{...nodeScope,index:2,images:[JSON.stringify(history[3].content)],imageIndices:[3]},()=>true);await second.markNodeDelivered(p.invocationId,proof);
  assert.equal((await second.guard('sess_fixture')).ok,true);await assert.rejects(second.prepare({...input('second'),nodeDelivery:{...nodeScope,toolCallId:'second'}}),{code:'execution_delivery_capacity'});
});
test('missing required image parts and scope changes cannot replace a node reservation or acknowledge delivery',async()=>{
  const f=fixture(),{ledger,p}=await nodeReturned(f),history=nodeHistory(),file=path.join(f.directory,'delivery-'+p.invocationId+'.json'),before=fs.readFileSync(file);
  await assert.rejects(ledger.saveNodeDelivery(p.invocationId,history.slice(0,3),{...nodeScope,index:2,images:[JSON.stringify(history[3].content)],imageIndices:[3]},()=>true),{code:'execution_delivery_invalid'});
  await assert.rejects(ledger.saveNodeDelivery(p.invocationId,history,{...nodeScope,nodeId:'other',index:2,images:[],imageIndices:[]},()=>true),{code:'execution_delivery_refused'});
  assert.deepEqual(fs.readFileSync(file),before);assert.equal((await ledger.guard('sess_fixture')).ok,false);
});

test('lost or replaced node reservation is refused at dispatch before any ACC send',async()=>{
  for(const damage of ['missing','changed']){
    const f=fixture(),ledger=f.create();await ledger.open();const p=await ledger.prepare({...input(),nodeDelivery:nodeScope}),file=path.join(f.directory,'delivery-'+p.invocationId+'.json');
    if(damage==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,JSON.stringify({schema:1,kind:'wrong reservation'},null,2));
    await assert.rejects(ledger.markDispatch(p.invocationId,()=>true));assert.equal((await ledger.entries())[0].phase,'prepared');assert.equal((await ledger.guard('sess_fixture')).ok,false);
  }
});
test('failed transition can retain durable unknown after its live permit is lost without rewriting an earlier reason',async()=>{
  const f=fixture(),ledger=f.create();await ledger.open();const p=await ledger.prepare({...input(),nodeDelivery:nodeScope});
  fs.unlinkSync(path.join(f.directory,'delivery-'+p.invocationId+'.json'));await assert.rejects(ledger.markDispatch(p.invocationId,()=>true));
  await ledger.recordUnknown(p.invocationId,'reservation_unverified');assert.equal((await ledger.entries())[0].phase,'unknown');
  await ledger.recordUnknown(p.invocationId,'later_transport_error');assert.equal((await ledger.entries())[0].holdReason,'reservation_unverified');
});
