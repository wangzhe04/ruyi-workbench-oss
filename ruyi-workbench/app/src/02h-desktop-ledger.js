// Root-owned execution preparation/result ledger; this factory itself performs no MCP/native IO.
// The default-off root/provider candidate supplies actual OS ownership and live turn assertions.
// The state file holds identity fields, digests and flags. Explicit delivery snapshots are private, bounded,
// immutable files containing the actual projected consumer history, not raw ACC results.
const DesktopExecutionLedger = (() => {
  const TOKEN = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/;
  const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/, SESSION = /^[A-Za-z0-9_-]{1,128}$/;
  const MAX_ENTRIES = 256, MAX_CLOSED_SESSIONS = 4096, MAX_BYTES = 4 * 1024 * 1024;
  const MAX_DELIVERY_BYTES = 16 * 1024 * 1024;
  const owners = new Map(); // One authority per canonical directory in this process; the host owns the OS gate.
  const PHASES = new Set(['prepared', 'dispatching', 'returned', 'unknown']);
  const FLAGS = ['ok', 'action_sent', 'acted', 'cancelled', 'confirmed', 'outcome', 'code'];
  const OUTCOMES = new Set(['unknown', 'unconfirmed', 'not_dispatched', 'rolled_back']);
  const ROW_KEYS = ['invocationId','sessionId','turnSeq','rewindGen','admissionId','callIdHash','toolName','argsSha256','argsSemanticSha256','argsBytes',
    'ownerEpoch','clientId','accWorkerId','accPid','phase','createdAt','updatedAt','observed','deliverySha256','holdReason'];
  const RECEIPT_KEYS = ['sha256','requestOperationId','sequence','requestReturned'];
  const OBSERVED_KEYS = ['sha256','bytes','flags','receipt'];
  const NODE_SCOPE_KEYS = ['kind','runId','nodeId','attempt','subagentId','batchId','toolCallId'];
  const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
  const match = (pattern,value) => typeof value === 'string' && pattern.test(value);
  const integer = (value,min=1,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value>=min && value<=max;
  const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  const digest = value => crypto.createHash('sha256').update(value,'utf8').digest('hex');
  function error(code,message) { return Object.assign(new Error(message),{code}); }
  function need(condition,code,message) { if (!condition) throw error(code,message); }
  function flags(value) {
    need(value && typeof value==='object' && !Array.isArray(value),'execution_result_invalid','Tool result must be an object');
    // Match ACC's receipt flag projection. A business numeric exit code or structured outcome
    // is ordinary result data, not a typed native/receipt flag and never proves non-dispatch.
    const out=Object.create(null);
    for(const key of ['ok','action_sent','acted','cancelled'])if(typeof value[key]==='boolean')out[key]=value[key];
    if(Object.hasOwn(value,'confirmed')&&(value.confirmed===null||typeof value.confirmed==='boolean'))out.confirmed=value.confirmed;
    if(OUTCOMES.has(value.outcome))out.outcome=value.outcome;
    if(typeof value.code==='string')out.code=Array.from(value.code).slice(0,100).join('');
    need(typeof out.ok==='boolean','execution_result_invalid','Tool result lacks typed ok');
    return out;
  }

  function validObserved(value) {
    if (!ownKeys(value,OBSERVED_KEYS) || !match(HASH,value.sha256) || !integer(value.bytes,0,128*1024*1024)) return false;
    try {
      if(Object.keys(value.flags).some(key=>!FLAGS.includes(key)))return false;
      const normalized=flags(value.flags);
      if(Object.keys(normalized).length!==Object.keys(value.flags).length || Object.keys(normalized).some(key=>normalized[key]!==value.flags[key]))return false;
    } catch {return false;}
    const receipt=value.receipt;
    return receipt===null || ownKeys(receipt,RECEIPT_KEYS) && match(HASH,receipt.sha256)
      && match(TOKEN,receipt.requestOperationId) && integer(receipt.sequence,1,4096) && typeof receipt.requestReturned==='boolean';
  }
  function validRow(row) {
    const hasNode=!!row&&typeof row==='object'&&Object.hasOwn(row,'nodeDelivery');
    if (!ownKeys(row,hasNode?[...ROW_KEYS,'nodeDelivery']:ROW_KEYS) || !match(TOKEN,row.invocationId) || !match(SESSION,row.sessionId)
        || !integer(row.turnSeq) || !integer(row.rewindGen,0) || !match(NAME,row.toolName) || !integer(row.argsBytes,0,8*1024*1024)
        || !['admissionId','callIdHash','argsSha256','argsSemanticSha256'].every(key=>match(HASH,row[key]))
        || !['ownerEpoch','clientId','accWorkerId'].every(key=>match(TOKEN,row[key])) || !integer(row.accPid)
        || !PHASES.has(row.phase) || !stamp(row.createdAt) || !stamp(row.updatedAt)
        || !(row.observed===null || validObserved(row.observed))
        || !(row.deliverySha256===null || match(HASH,row.deliverySha256))
        || !(row.holdReason===null || match(NAME,row.holdReason))) return false;
    if(hasNode) {
      const node=row.nodeDelivery;
      if(!ownKeys(node,['schema','file','scope','historySha256','bindingSha256']) || node.schema!==1
          || node.file!=='delivery-'+row.invocationId+'.json' || !validNodeScope(node.scope)
          || !(node.historySha256===null&&node.bindingSha256===null || match(HASH,node.historySha256)&&match(HASH,node.bindingSha256))
          || row.deliverySha256!==null&&node.historySha256!==row.deliverySha256
          || row.deliverySha256===null&&node.historySha256!==null&&row.phase!=='unknown')return false;
    }
    if (row.phase==='prepared' || row.phase==='dispatching') return row.observed===null && row.deliverySha256===null && row.holdReason===null;
    if (row.phase==='unknown') return row.holdReason!==null && row.deliverySha256===null;
    return row.observed!==null && row.observed.receipt!==null && row.holdReason===null
      && row.observed.flags.outcome!=='unknown' && (row.observed.receipt.requestReturned ||
        row.observed.flags.ok===false && row.observed.flags.action_sent!==true && row.observed.flags.acted!==true
        && row.observed.flags.confirmed!==true && (row.observed.flags.outcome===undefined || row.observed.flags.outcome==='not_dispatched'));
  }
  function validNodeScope(scope) {
    return ownKeys(scope,NODE_SCOPE_KEYS) && scope.kind==='foreground_workflow_node' && integer(scope.attempt)
      && [scope.runId,scope.nodeId,scope.subagentId,scope.batchId].every(value=>match(SESSION,value))
      && typeof scope.toolCallId==='string'&&scope.toolCallId.length>0&&scope.toolCallId.length<=1024;
  }
  function metadata(row) {
    return Object.freeze(Object.assign(Object.create(null),{schema:1,invocation_id:row.invocationId,
      session_id:row.sessionId,turn_seq:row.turnSeq,call_id_hash:row.callIdHash,tool_name:row.toolName,
      args_sha256:row.argsSha256,args_codec:'javascript-json-utf8-v1',args_semantic_sha256:row.argsSemanticSha256,
      args_semantic_codec:'ruyi-sdk-json-v1'}));
  }
  function inspectReceipt(value,row,resultFlags) {
    const bad='execution_receipt_unverified';
    need(value?.ok===true && value.execution_receipt_version===1 && value.schema===1
      && value.invocation_id===row.invocationId && value.incomplete===false && value.request_terminal_observed===true,bad,'Incomplete execution receipt');
    const summary=value.semantic_validation, rows=Array.isArray(value.records)?Array.from(value.records):null;
    need(summary?.semantic_version===1 && summary.invocation_id===row.invocationId && summary.lifecycle_unknown===false
      && summary.request_terminal_observed===true && Array.isArray(summary.reported_unknown_operation_ids)
      && summary.reported_unknown_operation_ids.length===0 && Array.isArray(summary.unresolved_operation_ids)
      && summary.unresolved_operation_ids.length===0 && Array.isArray(rows) && rows.length>1 && rows.length<=4096
      && summary.records_validated===rows.length,bad,'Receipt semantics are incomplete');
    for (let index=0;index<rows.length;index++) {
      const record=rows[index];
      need(record?.schema===1 && record.invocation_id===row.invocationId && record.sequence===index+1
        && record.acc_worker_id===row.accWorkerId && record.acc_pid===row.accPid && match(TOKEN,record.operation_id) && record.outcome!=='unknown',bad,'Receipt worker or sequence changed');
    }
    const accepted=rows[0], terminal=rows[rows.length-1];
    const expected=metadata(row);
    const binding={session_id:'session_id',turn_seq:'turn_seq',call_id_hash:'call_id_hash',tool_name:'tool',
      args_sha256:'caller_args_sha256',args_codec:'caller_args_codec',args_semantic_sha256:'received_semantic_sha256',args_semantic_codec:'args_semantic_codec'};
    need(accepted.stage==='acc_request_accepted' && Object.entries(binding).every(([key,target])=>accepted[target]===expected[key])
      && accepted.caller_semantic_sha256===row.argsSemanticSha256 && terminal.stage==='acc_request_terminal'
      && terminal.operation_id===accepted.operation_id && typeof terminal.ok==='boolean'
      && summary.request_transport_returned===terminal.ok,bad,'Receipt does not match immutable preparation');
    const tops=rows.filter(record=>record.stage==='tool_entered' && record.parent_operation_id===accepted.operation_id);
    if (terminal.ok) {
      need(tops.length===1 && tops[0].tool===row.toolName,bad,'Top-level wrapper is missing');
      const ends=rows.filter(record=>record.stage==='tool_terminal' && record.operation_id===tops[0].operation_id);
      need(ends.length===1 && ends[0].tool===row.toolName,bad,'Top-level wrapper terminal is missing');
      const reported=flags(ends[0]);
      need(FLAGS.every(key=>Object.hasOwn(reported,key)===Object.hasOwn(resultFlags,key) && reported[key]===resultFlags[key]),bad,'Returned result flags differ from actual wrapper terminal');
    } else {
      need(terminal.outcome==='not_dispatched' && tops.length===0 && resultFlags.ok===false
        && resultFlags.action_sent!==true && resultFlags.acted!==true && resultFlags.confirmed!==true
        && (resultFlags.outcome===undefined || resultFlags.outcome==='not_dispatched')
        && !rows.some(record=>record.stage==='tool_entered' || record.stage.startsWith('native_')),bad,'Failed SDK request does not prove non-dispatch');
    }
    return Object.freeze({sha256:digest(JSON.stringify(copyOrdinaryJsonData(rows))),requestOperationId:accepted.operation_id,
      sequence:rows.length,requestReturned:terminal.ok});
  }
  function create({directory,isOwner,isTurnCurrent,confirmRetirement,makeStore=options=>DurableJsonStore.create(options)}={}) {
    need(typeof directory==='string' && path.isAbsolute(directory) && typeof isOwner==='function' && typeof isTurnCurrent==='function',
      'execution_owner_required','Execution ledger requires a trusted directory plus root ownership and live-turn assertions');
    const epoch=crypto.randomBytes(16).toString('hex'), chains=new Map(), live=new Set();
    const activity={epoch,isOwner,pending:0};
    const file=path.join(directory,'state.json');
    let opened=false, directoryIdentity=null, canonicalDirectory=null, rootId=null, store=null;
    const assertOwner=()=>need(isOwner()===true && (!canonicalDirectory || owners.get(canonicalDirectory)?.epoch===epoch),
      'execution_owner_lost','Root execution authority is unavailable');
    const sameFile=(a,b)=>a.dev===b.dev && a.ino===b.ino && a.birthtimeNs===b.birthtimeNs;
    async function checkDirectory() {
      assertOwner();
      const stat=await fsp.lstat(directory,{bigint:true});
      need(stat.isDirectory() && !stat.isSymbolicLink() && typeof process.getuid==='function'
        && stat.uid===BigInt(process.getuid()) && !(stat.mode&0o077n)
        && (!directoryIdentity || sameFile(stat,directoryIdentity)),'execution_storage_changed','Execution ledger directory changed');
      assertOwner();return stat;
    }
    async function read() {
      need(opened,'execution_ledger_unavailable','Execution ledger has not been opened');
      await checkDirectory();
      const before=await fsp.lstat(file,{bigint:true});
      need(before.isFile() && !before.isSymbolicLink(),'execution_storage_changed','Execution ledger file is not regular');
      const value=await store.read();
      const after=await fsp.lstat(file,{bigint:true});
      need(sameFile(before,after) && before.size===after.size && before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs,
        'execution_storage_changed','Execution ledger file changed during read');
      await checkDirectory();
      const snapshot=copyOrdinaryJsonData(value,false);let changed=false;
      for(const row of Array.from(snapshot.entries))if(row.nodeDelivery&&row.phase==='returned'&&row.deliverySha256!==null) {
        try {await readNodeDelivery(row,snapshot.rootId,row.deliverySha256,row.nodeDelivery.bindingSha256);}
        catch {
          // Preserve the original committed hashes/locator for reconciliation. A
          // missing consumer transcript cannot remain an acknowledged delivery.
          row.phase='unknown';row.holdReason='node_history_unverified';row.deliverySha256=null;row.updatedAt=nowIso();
          live.delete(row.invocationId);changed=true;
        }
      }
      if(changed){assertOwner();await store.write(snapshot);await checkDirectory();}
      return snapshot;
    }
    function enqueue(work) {
      activity.pending++;
      return runKeyedChain(chains,'ledger',async()=>{assertOwner();return work();}).finally(()=>{activity.pending--;});
    }
    async function update(id,work,committed) {
      return enqueue(async()=>{
        try {
          const value=await read(), row=id ? Array.from(value.entries).find(entry=>entry.invocationId===id) : null;
          if (id) need(row,'execution_identity_missing','Execution invocation is not in this ledger');
          const result=await work(value,row);
          assertOwner();await checkDirectory();await store.write(value);await checkDirectory();
          if(committed)committed(result);
          return result;
        } catch (cause) {if(id)live.delete(id);throw cause;}
      });
    }
    function reservationSnapshot(row) {
      return {schema:1,kind:'node_delivery_reservation',rootId,invocationId:row.invocationId,
        admissionId:row.admissionId,ownerEpoch:row.ownerEpoch};
    }
    function nodeStore(target,validate) {
      return makeStore({id:'desktop-node-history',file:target,schemaVersion:1,cache:false,
        strictRead:true,quarantine:false,maxBytes:MAX_DELIVERY_BYTES,canonicalRead:true,ownedRegular:true,
        ordinaryJson:true,mode:0o600,defaultValue:()=>null,validate});
    }
    async function readNodeDelivery(row,expectedRoot,historySha256,bindingSha256) {
      const scope=row.nodeDelivery.scope;
      const valid=value=>{
        if(!ownKeys(value,['schema','rootId','invocationId','sessionId','turnSeq','rewindGen','admissionId','historySha256','binding','history'])
            || value.schema!==1 || value.rootId!==expectedRoot || value.invocationId!==row.invocationId
            || value.sessionId!==row.sessionId || value.turnSeq!==row.turnSeq || value.rewindGen!==row.rewindGen
            || value.admissionId!==row.admissionId || !Array.isArray(value.history)
            || value.historySha256!==historySha256 || digest(JSON.stringify(value.history))!==historySha256
            || !ownKeys(value.binding,[...NODE_SCOPE_KEYS,'index','images','imageIndices'])
            || NODE_SCOPE_KEYS.some(key=>value.binding[key]!==scope[key])
            || digest(JSON.stringify(value.binding))!==bindingSha256)return false;
        const binding=value.binding;
        return integer(binding.index,0)&&value.history[binding.index]?.role==='tool'
          &&value.history[binding.index].tool_call_id===scope.toolCallId && Array.isArray(binding.images)&&Array.isArray(binding.imageIndices)
          &&binding.images.length===binding.imageIndices.length&&new Set(Array.from(binding.imageIndices)).size===binding.images.length
          &&Array.from(binding.images).every((image,offset)=>{const index=binding.imageIndices[offset],message=value.history[index];
            return typeof image==='string'&&integer(index,0)&&index>binding.index&&message?.role==='user'&&JSON.stringify(message.content)===image;});
      };
      await checkDirectory();
      const value=await nodeStore(path.join(directory,row.nodeDelivery.file),valid).read();
      need(valid(value),'execution_delivery_unverified','Stored node delivery is missing or inconsistent');
      await checkDirectory();return value;
    }
    async function saveImmutableNodeSnapshot(name,snapshot,verifyScope,reservation=null) {
      const actual=copyOrdinaryJsonData(snapshot),expected=JSON.stringify(actual),target=path.join(directory,name);
      need(Buffer.byteLength(JSON.stringify(actual,null,2),'utf8')<=MAX_DELIVERY_BYTES,
        'execution_delivery_capacity','Actual node history exceeds the bounded snapshot');
      await checkDirectory();
      // Explicit bounded refusal until the retention/ACK protocol is implemented.
      if(reservation) {
        const prior=await nodeStore(target,value=>JSON.stringify(value)===JSON.stringify(reservation)).read();
        need(JSON.stringify(prior)===JSON.stringify(reservation),'execution_delivery_exists','Node delivery reservation changed');
      } else {
        need((await fsp.readdir(directory)).length<1024,'execution_delivery_capacity','Node history file capacity exhausted');
        try {await fsp.lstat(target);throw error('execution_delivery_exists','Immutable node history evidence already exists');}
        catch(cause){if(cause.code!=='ENOENT')throw cause;}
      }
      const delivery=nodeStore(target,value=>JSON.stringify(value)===expected);
      need(verifyScope()===true,'execution_admission_lost','Node changed before history publication');
      await delivery.write(actual);await checkDirectory();
      const saved=await delivery.read();
      need(JSON.stringify(saved)===expected && verifyScope()===true,
        'execution_delivery_unverified','Cannot verify actual node history and owner after publication');
      return Object.freeze({historySha256:snapshot.historySha256,bindingSha256:snapshot.binding?digest(JSON.stringify(snapshot.binding)):null,file:name});
    }
    function held(entries,sessionId) {
      return Array.from(entries).filter(row=>row.sessionId===sessionId && (row.phase==='unknown'
        || row.phase==='returned' && row.deliverySha256===null
        || (row.phase==='prepared' || row.phase==='dispatching') && !(row.ownerEpoch===epoch && live.has(row.invocationId)
          && isTurnCurrent(scopeOf(row))===true)));
    }
    function closed(value,sessionId,turnSeq,rewindGen) {
      const mark=Array.from(value.closedTurns).find(entry=>entry.sessionId===sessionId);
      return !!mark && (rewindGen<mark.rewindGen || rewindGen===mark.rewindGen && turnSeq<=mark.turnSeq);
    }
    const scopeOf=({sessionId,turnSeq,rewindGen,admissionId})=>Object.freeze(Object.assign(Object.create(null),{sessionId,turnSeq,rewindGen,admissionId}));
    const requireAdmission=scope=>need(isTurnCurrent(scope)===true,'execution_admission_lost','Actual host turn admission is no longer current');
    const view=row=>copyOrdinaryJsonData(row);
    return Object.freeze({
      epoch,
      async open() {
        return enqueue(async()=>{
          if(opened){await read();return;}
          let created=false;
          try {await fsp.mkdir(directory,{mode:0o700});created=true;} catch(cause){if(cause.code!=='EEXIST')throw cause;}
          directoryIdentity=await checkDirectory();
          const canonical=await fsp.realpath(directory), previous=owners.get(canonical);
          need(!previous || previous.epoch===epoch || previous.pending===0,'execution_owner_draining','Previous authority still has pending IO');
          need(!previous || previous.epoch===epoch || previous.isOwner()===false,'execution_owner_conflict','Another execution authority owns this directory');
          owners.set(canonical,activity);canonicalDirectory=canonical;
          rootId=created?crypto.randomBytes(32).toString('hex'):null;
          store=makeStore({id:'desktop-executions-v1',file,schemaVersion:1,cache:false,strictRead:true,quarantine:false,
            maxBytes:MAX_BYTES,canonicalRead:true,ownedRegular:true,ordinaryJson:true,mode:0o600,
            defaultValue:()=>({schema:1,rootId,entries:[],closedTurns:[]}),validate:value=>{
              if(!ownKeys(value,['schema','rootId','entries','closedTurns']) || value.schema!==1 || !match(HASH,value.rootId) || (rootId!==null && value.rootId!==rootId)
                || !Array.isArray(value.entries) || value.entries.length>MAX_ENTRIES
                || !Array.isArray(value.closedTurns) || value.closedTurns.length>MAX_CLOSED_SESSIONS) return false;
              const ids=new Set(),calls=new Set();
              for(let i=0;i<value.entries.length;i++) {
                const row=value.entries[i];if(!validRow(row))return false;
                const call=row.sessionId+':'+row.rewindGen+':'+row.turnSeq+':'+row.callIdHash;
                if(ids.has(row.invocationId)||calls.has(call))return false;ids.add(row.invocationId);calls.add(call);
              }
              const sessions=new Set();
              for(let i=0;i<value.closedTurns.length;i++){const mark=value.closedTurns[i];
                if(!ownKeys(mark,['sessionId','rewindGen','turnSeq']) || !match(SESSION,mark.sessionId)
                  || !integer(mark.rewindGen,0) || !integer(mark.turnSeq) || sessions.has(mark.sessionId))return false;
                sessions.add(mark.sessionId);
              }
              return true;
            }});
          if(created) {await store.write({schema:1,rootId,entries:[],closedTurns:[]});await checkDirectory();}
          // A directory which already existed is evidence of initialization. Missing state is
          // not virgin empty state, including a failed/crashed initialization; require recovery.
          opened=true;
          try {
            const value=await read();rootId=value.rootId;let changed=false;
            for(let i=0;i<value.entries.length;i++) {
              const row=value.entries[i];
              if(row.phase!=='unknown' && !(row.phase==='returned' && row.deliverySha256!==null)) {
                row.phase='unknown';row.holdReason='host_restarted';row.updatedAt=nowIso();changed=true;
              }
            }
            if(changed){await store.write(value);await checkDirectory();}
          } catch(cause){opened=false;throw cause;}
        });
      },
      async prepare({sessionId,turnSeq,rewindGen=0,admissionId,callIdHash,toolName,args,client,nodeDelivery}={}) {
        assertOwner();
        need(match(SESSION,sessionId)&&integer(turnSeq)&&integer(rewindGen,0)&&match(HASH,admissionId)&&match(HASH,callIdHash)&&match(NAME,toolName),
          'execution_preparation_invalid','Invalid host execution identity');
        const admission=scopeOf({sessionId,turnSeq,rewindGen,admissionId});requireAdmission(admission);
        const nodeScope=nodeDelivery===undefined?null:copyOrdinaryJsonData(nodeDelivery);
        need(nodeScope===null||validNodeScope(nodeScope),'execution_preparation_invalid','Invalid node consumer identity');
        let peer;
        try {peer=copyOrdinaryJsonData(client);} catch {throw error('execution_client_unverified','Invalid host client facts');}
        need(peer?.contextRequired===true && match(TOKEN,peer.clientId)&&match(TOKEN,peer.accWorkerId)&&integer(peer.accPid),
          'execution_client_unverified','Required-context ACC worker has not been established');
        let prepared;try{prepared=prepareDesktopExecutionArguments(args);}catch{throw error('execution_arguments_invalid','Cannot prepare immutable JSON arguments');}
        const id=crypto.randomBytes(16).toString('hex'), at=nowIso();
        const result=await update(null,async value=>{
          requireAdmission(admission);
          need(!closed(value,sessionId,turnSeq,rewindGen),'execution_turn_closed','This host turn is already closed');
          need(held(value.entries,sessionId).length===0,'execution_reconciliation_required','Earlier execution evidence needs reconciliation');
          need(!Array.from(value.entries).some(row=>row.sessionId===sessionId&&row.rewindGen===rewindGen&&row.turnSeq===turnSeq&&row.callIdHash===callIdHash),
            'execution_duplicate_call','This call identity already has execution evidence');
          need(value.entries.length<MAX_ENTRIES,'execution_ledger_capacity','Execution ledger capacity is exhausted');
          const row={invocationId:id,sessionId,turnSeq,rewindGen,admissionId,callIdHash,toolName,argsSha256:prepared.sha256,
            argsSemanticSha256:prepared.semanticSha256,argsBytes:prepared.bytes,ownerEpoch:epoch,
            clientId:peer.clientId,accWorkerId:peer.accWorkerId,accPid:peer.accPid,phase:'prepared',createdAt:at,
            updatedAt:at,observed:null,deliverySha256:null,holdReason:null};
          if(nodeScope) {
            row.nodeDelivery={schema:1,file:'delivery-'+id+'.json',scope:nodeScope,historySha256:null,bindingSha256:null};
            // Claim a durable file slot before preparation/dispatch, so a known-full
            // snapshot namespace refuses before ACC can execute.
            await saveImmutableNodeSnapshot(row.nodeDelivery.file,reservationSnapshot(row),()=>isTurnCurrent(admission)===true);
          }
          value.entries[value.entries.length]=row;
          return Object.freeze({invocationId:id,metadata:metadata(row),snapshot:prepared.snapshot,json:prepared.json});
        },()=>{requireAdmission(admission);live.add(id);});
        return result;
      },
      async markDispatch(id,verifyClient) {
        need(typeof verifyClient==='function','execution_client_unverified','Missing actual client-incarnation check');
        let dispatchScope;
        const result=await update(id,async(value,row)=>{
          dispatchScope=scopeOf(row);requireAdmission(dispatchScope);
          need(!closed(value,row.sessionId,row.turnSeq,row.rewindGen),'execution_turn_closed','This host turn closed before dispatch');
          need(held(value.entries,row.sessionId).length===0,'execution_reconciliation_required','Earlier execution became uncertain before dispatch');
          need(live.has(id)&&row.ownerEpoch===epoch&&row.phase==='prepared'&&verifyClient()===true,
            'execution_dispatch_refused','Preparation or actual client is no longer current');
          if(row.nodeDelivery) {
            const reserved=reservationSnapshot(row),saved=await nodeStore(path.join(directory,row.nodeDelivery.file),
              value=>JSON.stringify(value)===JSON.stringify(reserved)).read();
            need(JSON.stringify(saved)===JSON.stringify(reserved),'execution_delivery_unverified','Node delivery reservation changed before dispatch');
            requireAdmission(dispatchScope);need(verifyClient()===true,'execution_client_changed','Client changed while verifying reserved delivery slot');
          }
          row.phase='dispatching';row.updatedAt=nowIso();return metadata(row);
        },()=>{const rowScope=dispatchScope;requireAdmission(rowScope);if(verifyClient()!==true)throw error('execution_client_changed','Actual client changed while recording dispatch');});
        return result;
      },
      async recordResult(id,result,receipt) {
        let observed=null, receiptSnapshot=null, invalidResult=false;
        try {receiptSnapshot=copyOrdinaryJsonData(receipt);} catch { /* missing/unreadable evidence stays unknown */ }
        try {
          const snapshot=copyOrdinaryJsonData(result), json=JSON.stringify(snapshot), bytes=Buffer.byteLength(json,'utf8');
          need(bytes<=128*1024*1024,'execution_result_invalid','Result exceeds evidence hashing capacity');
          observed={sha256:digest(json),bytes,flags:flags(snapshot),receipt:null};
        } catch {invalidResult=true;}
        const outcome=await update(id,async(_value,row)=>{
          need(live.has(id)&&row.ownerEpoch===epoch&&row.phase==='dispatching','execution_result_refused','No current dispatched invocation');
          let reason=invalidResult?'result_invalid':null;
          if(!reason) {try{observed.receipt=inspectReceipt(receiptSnapshot,row,observed.flags);}catch{reason='receipt_unverified';}}
          row.observed=observed;row.phase=reason?'unknown':'returned';row.holdReason=reason;row.updatedAt=nowIso();return view(row);
        });
        if(outcome.phase==='unknown')live.delete(id);return outcome;
      },
      async recordUnknown(id,reason='transport_lost') {
        need(match(NAME,reason),'execution_reason_invalid','Invalid host uncertainty reason');
        const outcome=await update(id,async(_value,row)=>{
          // A failed state transition may have removed the live dispatch permit.
          // The same root epoch may still preserve uncertainty; it cannot promote
          // a result or alter an acknowledged invocation through this path.
          need(row.ownerEpoch===epoch&&row.deliverySha256===null,'execution_result_refused','Invocation belongs to another owner or is already delivered');
          if(row.phase==='unknown')return view(row);
          row.phase='unknown';row.holdReason=reason;row.updatedAt=nowIso();return view(row);
        });
        live.delete(id);return outcome;
      },
      async markDelivered(id,deliverySha256) {
        need(match(HASH,deliverySha256),'execution_delivery_invalid','Missing actual durable-history digest');
        const outcome=await update(id,async(_value,row)=>{
          need(!row.nodeDelivery&&live.has(id)&&row.ownerEpoch===epoch&&row.phase==='returned'&&row.observed?.receipt,
            'execution_delivery_refused','No verified returned invocation awaiting delivery');
          row.deliverySha256=deliverySha256;row.updatedAt=nowIso();return view(row);
        });
        live.delete(id);return outcome;
      },
      async markNodeDelivered(id,proof) {
        need(proof&&match(HASH,proof.historySha256)&&match(HASH,proof.bindingSha256),'execution_delivery_invalid','Missing node delivery proof');
        const outcome=await update(id,async(_value,row)=>{
          need(row.nodeDelivery&&live.has(id)&&row.ownerEpoch===epoch&&row.phase==='returned'&&row.deliverySha256===null,
            'execution_delivery_refused','No node result awaiting actual history proof');
          need(proof.file===row.nodeDelivery.file,'execution_delivery_invalid','Node delivery locator changed');
          await readNodeDelivery(row,rootId,proof.historySha256,proof.bindingSha256);
          row.nodeDelivery.historySha256=proof.historySha256;row.nodeDelivery.bindingSha256=proof.bindingSha256;
          row.deliverySha256=proof.historySha256;row.updatedAt=nowIso();return view(row);
        });
        live.delete(id);return outcome;
      },
      async saveNodeDelivery(id, history, binding, verifyScope) {
        need(match(TOKEN,id) && Array.isArray(history) && typeof verifyScope==='function',
          'execution_delivery_invalid','Missing actual node delivery scope');
        // Copy all consumer bytes at the barrier. A later model projection/compaction
        // must not change this historical snapshot or borrow its delivery identity.
        const messages=copyOrdinaryJsonData(history), scope=copyOrdinaryJsonData(binding);
        need(ownKeys(scope,['kind','runId','nodeId','attempt','subagentId','batchId','toolCallId','index','images','imageIndices'])
          && scope.kind==='foreground_workflow_node' && [scope.runId,scope.nodeId,scope.subagentId,scope.batchId,scope.toolCallId].every(x=>typeof x==='string'&&x.length>0&&x.length<=1024)
          && integer(scope.attempt) && integer(scope.index,0) && Array.isArray(scope.images)&&Array.isArray(scope.imageIndices)
          && scope.images.length===scope.imageIndices.length&&new Set(Array.from(scope.imageIndices)).size===scope.images.length
          && messages[scope.index]?.role==='tool' && messages[scope.index].tool_call_id===scope.toolCallId
          && Array.from(scope.images).every((image,offset)=>{const index=scope.imageIndices[offset],message=messages[index];
            return typeof image==='string'&&integer(index,0)&&index>scope.index&&message?.role==='user'&&JSON.stringify(message.content)===image;}),
          'execution_delivery_invalid','Invalid node delivery binding');
        const historySha256=digest(JSON.stringify(messages));
        return enqueue(async()=>{
          const entries=(await read()).entries,row=Array.from(entries).find(entry=>entry.invocationId===id);
          need(row?.nodeDelivery && live.has(id) && row.ownerEpoch===epoch && row.phase==='returned' && row.deliverySha256===null
            && NODE_SCOPE_KEYS.every(key=>scope[key]===row.nodeDelivery.scope[key]),
            'execution_delivery_refused','No current verified result awaiting node history');
          need(verifyScope()===true,'execution_admission_lost','Actual node history owner changed');
          const snapshot={schema:1,rootId,invocationId:id,sessionId:row.sessionId,turnSeq:row.turnSeq,
            rewindGen:row.rewindGen,admissionId:row.admissionId,historySha256,binding:scope,history:messages};
          return saveImmutableNodeSnapshot(row.nodeDelivery.file,snapshot,verifyScope,reservationSnapshot(row));
        });
      },
      async saveNodeIntent(history,binding,verifyScope) {
        const messages=copyOrdinaryJsonData(history),scope=copyOrdinaryJsonData(binding);
        need(Array.isArray(messages) && ownKeys(scope,['sessionId','turnSeq','rewindGen','admissionId','runId','nodeId','attempt','subagentId','batchId'])
          && match(SESSION,scope.sessionId) && integer(scope.turnSeq) && integer(scope.rewindGen,0)
          && match(HASH,scope.admissionId) && integer(scope.attempt) && [scope.runId,scope.nodeId,scope.subagentId,scope.batchId].every(value=>match(SESSION,value))
          && typeof verifyScope==='function','execution_delivery_invalid','Invalid actual node intent history');
        return enqueue(async()=>{
          await read();requireAdmission(scope);
          const snapshot={schema:1,rootId,kind:'foreground_node_intent',...scope,historySha256:digest(JSON.stringify(messages)),history:messages};
          return saveImmutableNodeSnapshot('intent-'+digest(scope.admissionId+'\0'+scope.batchId)+'.json',snapshot,verifyScope);
        });
      },
      async guard(sessionId) {
        need(match(SESSION,sessionId),'execution_preparation_invalid','Invalid host session identity');
        return enqueue(async()=>{const rows=held((await read()).entries,sessionId);
          return Object.freeze({ok:rows.length===0,pending:Object.freeze(rows.map(row=>row.invocationId))});});
      },
      async entries() {return enqueue(async()=>copyOrdinaryJsonData((await read()).entries));},
      async retireTurn(sessionId,turnSeq,rewindGen=0) {
        need(match(SESSION,sessionId)&&integer(turnSeq)&&integer(rewindGen,0),'execution_preparation_invalid','Invalid retirement turn identity');
        return update(null,async value=>{
          const entries=Array.from(value.entries), retiring=entries.filter(row=>row.sessionId===sessionId&&row.turnSeq===turnSeq&&row.rewindGen===rewindGen);
          need(retiring.every(row=>row.phase==='returned'&&row.deliverySha256!==null),'execution_retirement_refused','Unresolved execution evidence cannot be retired');
          need(typeof confirmRetirement==='function' && await confirmRetirement(copyOrdinaryJsonData(retiring),copyOrdinaryJsonData({sessionId,turnSeq,rewindGen}))===true,
            'execution_retirement_refused','Closed-turn history and ACC retention have not been confirmed');
          assertOwner();
          const marks=Array.from(value.closedTurns), old=marks.find(mark=>mark.sessionId===sessionId);
          if(!old){need(marks.length<MAX_CLOSED_SESSIONS,'execution_ledger_capacity','Closed session watermark capacity is exhausted');marks.push({sessionId,rewindGen,turnSeq});}
          else if(rewindGen>old.rewindGen || rewindGen===old.rewindGen&&turnSeq>old.turnSeq){old.rewindGen=rewindGen;old.turnSeq=turnSeq;}
          value.closedTurns=marks;value.entries=entries.filter(row=>!retiring.includes(row));return retiring.length;
        });
      },
    });
  }
  return Object.freeze({create,metadata,inspectReceipt,limits:Object.freeze({maxEntries:MAX_ENTRIES,maxBytes:MAX_BYTES})});
})();
