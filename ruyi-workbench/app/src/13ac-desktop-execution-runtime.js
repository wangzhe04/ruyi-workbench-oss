// Root execution authority. MCP children never open this ledger; they need the root service.
const DesktopExecutionRuntime = (() => {
  let state = null;
  const admissions = new Map();
  const contexts = new WeakMap(), peers = new WeakMap(), pendingMain = new Map();
  const sendPermits = new WeakMap();
  const workflowOrigins = new WeakMap(), nodeKeys = new WeakMap(), nodeAdmissions = new Map();
  const dispatchTails = new Map();
  const modelScope = new (require('async_hooks').AsyncLocalStorage)();
  const enabled = () => process.platform === 'darwin' && process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS === '1';
  const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
  const generation = session => session.rewindGen === undefined ? 0 : session.rewindGen;
  function rootOwned() {
    if (!state || !state.dataIdentity || !state.ownership.isHeld() || !state.ownership.isRootCurrent(state.canonicalRoot)) return false;
    try {
      const named = fs.statSync(paths.data, { bigint: true }), canonical = fs.statSync(state.canonicalRoot, { bigint: true });
      return [named, canonical].every(stat => stat.isDirectory() && stat.dev === state.dataIdentity.dev
        && stat.ino === state.dataIdentity.ino && stat.birthtimeNs === state.dataIdentity.birthtimeNs);
    } catch { return false; }
  }
  function authority() {
    if (!state || state.phase !== 'ready' || !rootOwned()) {
      throw fail('execution_owner_lost', '桌面执行记录的服务所有权不可用，已停止继续执行。');
    }
    return state;
  }
  function current(scope) {
    const node = nodeAdmissions.get(scope.admissionId);
    if (node) return scope.sessionId === node.session.id && scope.turnSeq === node.turnSeq
      && scope.rewindGen === node.rewindGen && nodeCurrent(node);
    const admitted = admissions.get(scope.sessionId);
    return !!admitted && !!state && state.phase === 'ready' && rootOwned()
      && admitted.id === scope.admissionId && admitted.turnSeq === scope.turnSeq && admitted.rewindGen === scope.rewindGen
      && admitted.session.turnSeq === scope.turnSeq && generation(admitted.session) === scope.rewindGen
      && turnSettlers.get(scope.sessionId) === admitted.owner && !admitted.owner.cancelRequested
      && admitted.owner.driverRunId === admitted.driverRunId;
  }
  async function initialize(ownership) {
    if (process.platform !== 'darwin') return;
    if (state) throw fail('execution_runtime_initialized', '桌面执行记录已经初始化；本进程不能再次接管。');
    if (!ownership || typeof ownership.isHeld !== 'function' || !ownership.isHeld()) {
      throw fail('execution_owner_required', '桌面执行记录需要实际的服务所有权。');
    }
    state = { phase: 'opening', ownership, ledger: null, dataIdentity: null, canonicalRoot: null };
    try {
      state.canonicalRoot = await ServerOwnership.canonicalRoot(paths.data);
      if (!ownership.isHeld() || !ownership.roots.includes(state.canonicalRoot) || !ownership.isRootCurrent(state.canonicalRoot)) {
        throw fail('execution_owner_lost', '服务没有持有当前数据目录的实际所有权。');
      }
      await fsp.mkdir(paths.data, { recursive: true });
      await ownership.confirmRoot(paths.data);
      state.dataIdentity = await fsp.stat(paths.data, { bigint: true });
      if (!rootOwned()) throw fail('execution_owner_lost', '数据目录在初始化期间发生变化。');
      const ledger = DesktopExecutionLedger.create({ directory: path.join(paths.data, 'desktop-executions-v1'),
        isOwner: rootOwned, isTurnCurrent: current });
      await ledger.open();
      if (!rootOwned()) throw fail('execution_owner_lost', '服务所有权在恢复期间失效。');
      state.ledger = ledger;
      state.phase = 'ready';
    } catch (error) { state.phase = 'failed'; throw error; }
  }
  async function guard(sessionId) {
    // Non-serve consumers do not acquire or mutate shared execution state.
    if (!state) return;
    const root = authority();
    let observed = await root.ledger.guard(sessionId);
    const deadline=Date.now()+10000;
    while (!observed.ok && Date.now()<deadline) {
      const calls = [...Array.from(pendingMain.values()).flatMap(list => Array.from(list)),
        ...Array.from(nodeAdmissions.values()).flatMap(node => Array.from(node.pending))];
      const waiting = calls.filter(call => call.session.id === sessionId && call.deliveryWait
        && observed.pending.includes(call.invocationId) && (call.node ? nodeCurrent(call.node)
          : current({sessionId,turnSeq:call.turnSeq,rewindGen:call.rewindGen,admissionId:call.admissionId})));
      if (waiting.length) {
        // A current sibling is publishing an actual result. Wait outside the ledger
        // queue so its strict history barrier can complete; never waive an unknown.
        let timer;
        try { await Promise.race([Promise.all(waiting.map(call => call.deliveryWait.promise)),
          new Promise(resolve => { timer = setTimeout(resolve, Math.max(1,deadline-Date.now())); })]); }
        finally { clearTimeout(timer); }
        observed = await root.ledger.guard(sessionId);
      } else break;
    }
    authority();
    if (!observed.ok) throw fail('execution_reconciliation_required',
      '上次桌面操作的执行或结果保存尚未确认，已暂停本会话的自动继续，请先核实执行记录。');
  }
  function admit(session, owner) {
    if (!state) return null;
    authority();
    if (!owner || turnSettlers.get(session.id) !== owner || owner.cancelRequested
        || typeof owner.driverRunId !== 'string' || !owner.driverRunId
        || !Number.isSafeInteger(session.turnSeq) || session.turnSeq < 1
        || !Number.isSafeInteger(generation(session)) || generation(session) < 0) {
      throw fail('execution_admission_lost', '桌面执行需要当前服务实际持有的回合身份。');
    }
    const old = admissions.get(session.id), rewindGen = generation(session);
    if (old && old.session === session && old.owner === owner && old.turnSeq === session.turnSeq && old.rewindGen === rewindGen) return old.id;
    const entry = { id: crypto.randomBytes(32).toString('hex'), session, owner,
      driverRunId: owner.driverRunId, turnSeq: session.turnSeq, rewindGen };
    admissions.set(session.id, entry);
    return entry.id;
  }
  function release(sessionId, owner) {
    if (admissions.get(sessionId)?.owner === owner) admissions.delete(sessionId);
    for (const [session, calls] of pendingMain) {
      for (const call of calls) if (session.id === sessionId && call.owner === owner) { calls.delete(call); call.deliveryWait?.resolve(); call.releaseDispatch?.(); }
      if (!calls.size) pendingMain.delete(session);
    }
    for (const node of nodeAdmissions.values()) if (node.session.id === sessionId && node.owner === owner) releaseNode(node.key);
  }
  function workflowOrigin(session, owner) {
    if (!enabled()) return null;
    const parentId = admit(session, owner), parent = admissions.get(session.id);
    const key = Object.freeze(Object.create(null));
    workflowOrigins.set(key, { session, owner, parentId, turnSeq: parent.turnSeq, rewindGen: parent.rewindGen });
    return key;
  }
  function nodeCurrent(node) {
    if (!node) return false;
    const parent = admissions.get(node.session.id);
    return !!parent && parent.session === node.session && parent.owner === node.owner && parent.id === node.parentId
      && current({ sessionId: node.session.id, turnSeq: node.turnSeq, rewindGen: node.rewindGen, admissionId: node.parentId })
      && !sessionSaveIsTombstoned(node.session) && !sessionObjectIsStale(node.session)
      && (sessionRewindGenHighWater.get(node.session.id) || 0) <= node.rewindGen
      && activeAgentRuns.get(node.run.id) === node.runtime && node.runtime.run === node.run
      && node.run.sessionId === node.session.id && node.run.turnSeq === node.turnSeq && node.run.status === 'running'
      && node.run.background !== true && !node.runtime.closing && !node.runtime.paused && !node.runtime.stopRequested
      && !node.waitingResource && !node.runtime.permissionWaits?.has(node.nodeId)
      && !!node.runtime.ctrl && !node.runtime.ctrl.signal.aborted
      && node.run.nodes.includes(node.node) && node.node.id === node.nodeId && node.node.attempts === node.attempt
      && node.node.status === 'running' && node.runtime.nodeControls.get(node.nodeId) === node.ctrl && !node.ctrl.signal.aborted;
  }
  function admitNode(originKey, runtime, node, ctrl, subagentId) {
    if (!enabled() || !originKey) return null;
    authority();
    const origin = workflowOrigins.get(originKey);
    if (!origin || !runtime || !node || !ctrl || !Number.isSafeInteger(node.attempts) || node.attempts < 1
        || typeof subagentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subagentId)) {
      throw fail('execution_admission_lost', '子代理没有真实前台工作流身份。');
    }
    const key = Object.freeze(Object.create(null)), id = crypto.randomBytes(32).toString('hex');
    const entry = { ...origin, id, key, runtime, run: runtime.run, node, nodeId: node.id, attempt: node.attempts,
      ctrl, subagentId, history: null, pending: new Set() };
    if (!nodeCurrent(entry)) throw fail('execution_admission_lost', '子代理的主回合、节点或控制器已失效。');
    nodeKeys.set(key, entry); nodeAdmissions.set(id, entry);
    return key;
  }
  function releaseNode(key) {
    const node = nodeKeys.get(key);
    if (node) { nodeAdmissions.delete(node.id); nodeKeys.delete(key); for (const call of node.pending) {call.deliveryWait?.resolve();call.releaseDispatch?.();} node.pending.clear(); }
  }
  function nodeHistory(key, history) {
    if (!key) return;
    const node = nodeKeys.get(key);
    if (!node || !nodeCurrent(node) || !Array.isArray(history) || node.history && node.history !== history) {
      throw fail('execution_admission_lost', '子代理历史没有当前实际节点身份。');
    }
    node.history = history;
  }
  function nodeWaiting(key,waiting) {
    const node=nodeKeys.get(key);if(node)node.waitingResource=waiting===true;
  }
  function nodeContext(key, batchId, callId) {
    if (!enabled() || !key) return null;
    const node = nodeKeys.get(key);
    if (!node || !nodeCurrent(node) || !node.history || node.batchId !== batchId
        || !node.batch?.tool_calls?.some(call => call.id === callId)
        || ![batchId, callId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024)) {
      throw fail('execution_admission_lost', '子代理调用没有当前批次身份。');
    }
    const contextKey = Object.freeze(Object.create(null));
    contexts.set(contextKey, { session: node.session, owner: node.owner, admissionId: node.id, node,
      batchId, callId, invocationId: null, staged: null });
    return contextKey;
  }
  async function nodeBatch(key,batchId) {
    if (!enabled() || !key) return;
    const node=nodeKeys.get(key);
    if (!node || !nodeCurrent(node) || !/^[A-Za-z0-9_-]{1,128}$/.test(batchId)
        || node.history?.at(-1)?.role!=='assistant' || !node.history.at(-1).tool_calls?.length) {
      throw fail('execution_admission_lost','子代理工具意图没有实际节点历史。');
    }
    node.batchId=batchId;node.batch=node.history.at(-1);
    await authority().ledger.saveNodeIntent(node.history,{sessionId:node.session.id,turnSeq:node.turnSeq,
      rewindGen:node.rewindGen,admissionId:node.id,runId:node.run.id,nodeId:node.nodeId,attempt:node.attempt,
      subagentId:node.subagentId,batchId},()=>nodeCurrent(node));
  }
  function canWriteStartupError() {
    return process.platform !== 'darwin' || rootOwned();
  }
  // Preparation uses this exact admitted session object, never caller-provided turn numbers.
  async function prepare({ session, owner, callId, toolName, args, client }) {
    const root = authority(), admitted = admissions.get(session.id);
    if (!admitted || admitted.session !== session || admitted.owner !== owner || typeof callId !== 'string' || !callId) {
      throw fail('execution_admission_lost', '工具调用没有当前回合的实际准入身份。');
    }
    return root.ledger.prepare({ sessionId: session.id, turnSeq: admitted.turnSeq, rewindGen: admitted.rewindGen,
      admissionId: admitted.id, callIdHash: crypto.createHash('sha256').update(admitted.driverRunId + '\0' + callId).digest('hex'),
      toolName, args, client });
  }
  function desktopClient(client) {
    return client?.id === 'ai-computer-control' || isEquivalentDesktopAccServer(client)
      || typeof client?.serverInfo?.name === 'string'
        && client.serverInfo.name.toLowerCase().replace(/[\s_-]/g, '') === 'aicomputercontrol';
  }
  function callRefusal(client, toolName, args, options = {}) {
    if (!enabled() || !desktopClient(client) || toolName === 'execution_receipt') return null;
    const permit = sendPermits.get(options.executionCheck);
    if (client instanceof McpStdioClient && permit && !permit.used && permit.client === client
        && permit.toolName === toolName && permit.args === args && permit.meta === options.meta && permit.verify()) return null;
    return { ok: false, code: 'execution_metadata_required', outcome: 'not_dispatched', action_sent: false,
      error: '桌面组件业务调用需要当前服务已保存的派发许可，未派发。' };
  }
  function clientEnvironment(id, env, descriptor = { id }) {
    if (!enabled() || !desktopClient(descriptor)) return env;
    authority();
    return { ...env, RUYI_EXECUTION_CONTEXT_REQUIRED: '1' };
  }
  function liveClient(client, child) {
    return rootOwned() && client instanceof McpStdioClient && desktopClient(client)
      && mcpClients.get(client.id) === client && !client.dead && !!child && client.child === child
      && client.executionContextRequired === true;
  }
  async function peerFor(client) {
    authority();
    const child = client?.child;
    if (!liveClient(client, child)) throw fail('execution_client_unverified', '桌面组件不是当前服务持有的必要上下文实例。');
    let pending = peers.get(client);
    if (!pending) {
      pending = (async () => {
        const probe = await probeDesktopExecutionReceipts(client);
        if (!probe.ok || !liveClient(client, child)) throw fail('execution_client_unverified', '桌面组件未确认执行回执协议。');
        return Object.freeze({ clientId: crypto.randomBytes(16).toString('hex'), accWorkerId: probe.accWorkerId,
          accPid: probe.accPid, contextRequired: true, child });
      })();
      peers.set(client, pending);
    }
    try { const peer = await pending;
      if (!liveClient(client, peer.child)) throw fail('execution_client_changed', '桌面组件实例已更换。');
      return peer;
    } catch (error) { if (peers.get(client) === pending) peers.delete(client); throw error; }
  }
  async function readiness(client) {
    const peer = await peerFor(client);
    const result = await client.callTool('execution_receipt', { invocation_id: '0'.repeat(32), control: 'readiness' });
    if (!liveClient(client, peer.child) || result?.ok !== true || result.readiness?.ok !== true) {
      throw fail('execution_control_unavailable', '桌面组件的只读状态检查失败。');
    }
    return result.readiness;
  }
  function context(session, owner, callId, toolCallId=callId) {
    if (!enabled()) return null;
    const id = admit(session, owner);
    if (!id || ![callId,toolCallId].every(value=>typeof value==='string'&&value.length>0&&value.length<=1024)) throw fail('execution_admission_lost', '工具调用缺少实际回合身份。');
    const key = Object.freeze(Object.create(null));
    contexts.set(key, { session, owner, callId,toolCallId, admissionId: id, turnSeq:session.turnSeq,rewindGen:generation(session),invocationId: null, staged: null });
    return key;
  }
  async function takeDispatch(call,signal) {
    // This ticket deliberately spans invoke's return and the later strict history
    // barrier. Waiting occurs outside the ledger queue, so its holder can commit.
    const id=call.session.id,previous=dispatchTails.get(id)||Promise.resolve();
    let unlock,released=false;
    const held=new Promise(resolve=>{unlock=resolve;}),tail=previous.then(()=>held);
    dispatchTails.set(id,tail);
    const release=()=>{if(!released){released=true;unlock();}};
    tail.then(()=>{if(dispatchTails.get(id)===tail)dispatchTails.delete(id);});
    let abort;
    try {
      await Promise.race([previous,new Promise((_resolve,reject)=>{
        abort=()=>reject(fail('execution_admission_lost','等待桌面结果保存时，当前调用已取消。'));
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      })]);
      return release;
    } catch(error){release();throw error;}
    finally{if(abort)signal?.removeEventListener('abort',abort);}
  }
  async function invoke(client, toolName, args, options = {}, key = null) {
    const guardedSession = contexts.get(key)?.session.id || options.executionSessionId;
    if (enabled() && guardedSession) await guard(guardedSession);
    if (!enabled() || !desktopClient(client)) return client.callTool(toolName, args, undefined, options);
    // The existing exact contextless control reports historical uncertainty. It is
    // not a new desktop action and must not turn a missing queried receipt into a
    // freshly prepared unknown business invocation.
    if (toolName === 'execution_receipt') return client.callTool(toolName,args,undefined,options);
    const call = contexts.get(key);
    if (!call || call.invocationId || (call.node ? !nodeCurrent(call.node) : admissions.get(call.session.id)?.id !== call.admissionId)) {
      throw fail('execution_admission_lost', '桌面调用没有当前主回合的执行身份，未派发。');
    }
    const releaseDispatch=await takeDispatch(call,call.node?.ctrl.signal||options.signal);
    let retained=false;
    try {
    await guard(call.session.id);
    if (call.node ? !nodeCurrent(call.node) : admissions.get(call.session.id)?.id!==call.admissionId) {
      throw fail('execution_admission_lost','等待桌面结果保存后，调用身份已失效。');
    }
    const root = authority(), peer = await peerFor(client);
    const facts = { clientId: peer.clientId, accWorkerId: peer.accWorkerId, accPid: peer.accPid, contextRequired: true };
    const prepared = call.node
      ? await root.ledger.prepare({ sessionId: call.session.id, turnSeq: call.node.turnSeq, rewindGen: call.node.rewindGen,
        admissionId: call.admissionId, callIdHash: crypto.createHash('sha256').update('workflow-node-v1\0' + call.node.id + '\0' + call.batchId + '\0' + call.callId).digest('hex'),
        toolName, args, client: facts, nodeDelivery: {kind:'foreground_workflow_node',runId:call.node.run.id,nodeId:call.node.nodeId,
          attempt:call.node.attempt,subagentId:call.node.subagentId,batchId:call.batchId,toolCallId:call.callId} })
      : await prepare({ session: call.session, owner: call.owner, callId: call.callId, toolName, args, client: facts });
    call.invocationId = prepared.invocationId;
    let list = call.node ? call.node.pending : pendingMain.get(call.session);
    if (!list) { list = new Set(); pendingMain.set(call.session, list); }
    let delivered;
    call.deliveryWait = { promise: new Promise(resolve => { delivered = resolve; }), resolve: () => delivered() };
    call.releaseDispatch=releaseDispatch;retained=true;
    list.add(call);
    const verify = () => liveClient(client, peer.child) && current({ sessionId: call.session.id,
      turnSeq: prepared.metadata.turn_seq, rewindGen: generation(call.session), admissionId: call.admissionId });
    try {
      await root.ledger.markDispatch(prepared.invocationId, verify);
      const meta = copyOrdinaryJsonData({ 'org.ruyi.workbench/execution-v1': prepared.metadata });
      const metaJson = JSON.stringify(meta);
      const permit = { client, toolName, args: prepared.snapshot, meta, verify, used: false };
      const executionCheck = packet => {
          if (sendPermits.get(executionCheck) !== permit || permit.used) throw fail('execution_permit_invalid', '派发许可已失效。');
          if (!verify() || packet.method !== 'tools/call' || packet.params?.name !== toolName
              || JSON.stringify(packet.params.arguments) !== prepared.json
              || JSON.stringify(packet.params._meta) !== metaJson) {
            throw fail('execution_packet_changed', '实际发送的参数、元数据或执行身份发生变化，未发送。');
          }
          permit.used = true;
      };
      sendPermits.set(executionCheck, permit);
      let result;
      try { result = await client.callTool(toolName, prepared.snapshot, undefined, { ...options, meta, executionCheck }); }
      finally { sendPermits.delete(executionCheck); }
      const receipt = await client.callTool('execution_receipt', { invocation_id: prepared.invocationId });
      const observed = await root.ledger.recordResult(prepared.invocationId, result, receipt);
      if (observed.phase !== 'returned') throw fail('execution_reconciliation_required', '桌面结果的执行回执未确认，已停止自动继续。');
      return result;
    } catch (error) {
      try { await root.ledger.recordUnknown(prepared.invocationId, 'host_call_incomplete'); } catch { /* durable gate already holds on storage/result failure */ }
      list.delete(call);call.deliveryWait.resolve();releaseDispatch();retained=false;
      if (!call.node && !list.size) pendingMain.delete(call.session);
      throw error;
    }
    } finally {if(!retained)releaseDispatch();}
  }
  function stageMain(key, index, images = []) {
    if (!enabled() || !key) return;
    const call = contexts.get(key);
    if (!call?.invocationId || !pendingMain.get(call.session)?.has(call)) return;
    if(call.session.providerHistory[index]?.tool_call_id!==call.toolCallId)throw fail('execution_delivery_invalid','主回合工具结果的调用身份发生变化。');
    call.staged = stageHistory(call.session.providerHistory,index,images);
  }
  function stageHistory(history,index,images) {
    const row=history[index];
    if(!Number.isSafeInteger(index)||row?.role!=='tool')throw fail('execution_delivery_invalid','工具结果没有进入实际历史。');
    const imageIndices=images.map((parts,offset)=>{
      const position=history.length-images.length+offset;
      // The actual newly appended parts must be this call's object, not an older
      // screenshot whose pixels and note happen to be identical.
      if(position<=index||history[position]?.role!=='user'||history[position].content!==parts) {
        throw fail('execution_delivery_invalid','当前调用的实际图片行未进入历史。');
      }
      return position;
    });
    return {index,row:JSON.stringify(copyOrdinaryJsonData(row)),images:images.map(parts=>JSON.stringify(copyOrdinaryJsonData(parts))),imageIndices};
  }
  function stageNode(key, index, images = []) {
    if (!enabled() || !key) return;
    const call = contexts.get(key), node = call?.node;
    if (!call?.invocationId || !node?.pending.has(call)) return;
    const row = node.history[index];
    if (!Number.isSafeInteger(index) || row?.role !== 'tool' || row.tool_call_id !== call.callId) {
      throw fail('execution_delivery_invalid', '子代理工具结果未进入实际批次历史。');
    }
    call.staged = stageHistory(node.history,index,images);
  }
  async function flushNode(key) {
    const node = nodeKeys.get(key);
    if (!node?.pending.size) return;
    const root = authority(), calls = Array.from(node.pending), snapshot = copyOrdinaryJsonData(node.history);
    if (!nodeCurrent(node) || calls.some(call => !call.staged || !mainDeliveryMatches(snapshot, call.staged))) {
      throw fail('execution_delivery_changed', '子代理结果或图片未完整进入当前实际历史。');
    }
    for (const call of calls) {
      const proof = await root.ledger.saveNodeDelivery(call.invocationId, snapshot, { kind: 'foreground_workflow_node',
        runId: node.run.id, nodeId: node.nodeId, attempt: node.attempt, subagentId: node.subagentId,
        batchId: call.batchId, toolCallId: call.callId, index: call.staged.index, images: call.staged.images,imageIndices:call.staged.imageIndices }, () => nodeCurrent(node));
      await root.ledger.markNodeDelivered(call.invocationId, proof);
      node.pending.delete(call);call.deliveryWait.resolve();call.releaseDispatch?.();
    }
  }
  function appendMainTool(history, batch, row) {
    if (!enabled()) { history.push(row); return history.length - 1; }
    const anchor = history.indexOf(batch?.assistant);
    if (anchor < 0 || anchor !== batch.start - 1 || row?.role !== 'tool'
        || !batch.assistant.tool_calls?.some(call => String(call.id) === String(row.tool_call_id))) {
      throw fail('execution_history_changed', '工具批次的历史位置或请求身份发生变化。');
    }
    let index = batch.start;
    while (history[index]?.role === 'tool') index++;
    history.splice(index, 0, row);
    return index;
  }
  function mainDeliveryMatches(history, staged) {
    try {
      if (JSON.stringify(copyOrdinaryJsonData(history[staged.index])) !== staged.row || !Array.isArray(staged.images)
          ||!Array.isArray(staged.imageIndices)||staged.images.length!==staged.imageIndices.length
          ||new Set(staged.imageIndices).size!==staged.images.length) return false;
      return staged.images.every((image,offset)=>{
        const index=staged.imageIndices[offset],row=history[index];
        return Number.isSafeInteger(index)&&index>staged.index&&row?.role==='user'&&JSON.stringify(copyOrdinaryJsonData(row.content))===image;
      });
    } catch { return false; }
  }
  async function flushMain(session, saveOptions) {
    const list = pendingMain.get(session);
    if (!list?.size) return;
    const root = authority(), calls = Array.from(list);
    if (calls.some(call => !call.staged)) throw fail('execution_delivery_invalid', '尚有桌面结果未进入历史。');
    const snapshot = copyOrdinaryJsonData(session.providerHistory), json = JSON.stringify(snapshot);
    for (const call of calls) if (!mainDeliveryMatches(snapshot, call.staged)) {
      throw fail('execution_delivery_changed', '待保存的工具结果或图像不完整，已停止自动继续。');
    }
    const turnSeq = session.turnSeq, rewindGen = generation(session);
    await saveSession(session, { ...saveOptions, requirePersisted: true, writer: 'desktop-execution-delivery' });
    const disk = await loadSession(session.id);
    if (!disk || disk.turnSeq !== turnSeq || generation(disk) !== rewindGen || JSON.stringify(copyOrdinaryJsonData(disk.providerHistory)) !== json) {
      throw fail('execution_delivery_unverified', '无法核实实际保存的工具历史，已停止自动继续。');
    }
    const digest = crypto.createHash('sha256').update(json).digest('hex');
    for (const call of calls) { await root.ledger.markDelivered(call.invocationId, digest); list.delete(call);call.deliveryWait.resolve();call.releaseDispatch?.(); }
    if (!list.size) pendingMain.delete(session);
  }
  function run(session, work) { return enabled() ? modelScope.run({ sessionId: session.id }, work) : work(); }
  function runNode(key, work) {
    const node = nodeKeys.get(key);
    return enabled() && node ? modelScope.run({ sessionId: node.session.id, nodeKey: key }, work) : work();
  }
  function assertNode(key) {
    if (enabled() && key && !nodeCurrent(nodeKeys.get(key))) throw fail('execution_admission_lost','子代理的真实执行身份已失效。');
  }
  async function beforeModelRequest(explicitSessionId) {
    const scope = modelScope.getStore(), sessionId = scope?.sessionId || explicitSessionId;
    if (enabled() && sessionId) await guard(sessionId);
    if (enabled() && scope?.nodeKey && !nodeCurrent(nodeKeys.get(scope.nodeKey))) {
      throw fail('execution_admission_lost', '子代理模型请求的实际节点身份已失效。');
    }
  }
  return Object.freeze({ initialize, guard, admit, release, prepare, canWriteStartupError,
    enabled, clientEnvironment, readiness, context, invoke, stageMain, flushMain, run, beforeModelRequest,
    mainDeliveryMatches, callRefusal, appendMainTool, workflowOrigin, admitNode, releaseNode, nodeHistory, nodeContext, nodeBatch, stageNode, flushNode, runNode, assertNode, nodeWaiting });
})();
Object.assign(DesktopExecutionHooks, DesktopExecutionRuntime);
ProviderHttpHooks.beforeModelRequest = DesktopExecutionRuntime.beforeModelRequest;
