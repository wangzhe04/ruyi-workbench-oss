// M5-W: bounded sequential continuation of explicitly selected existing threads.
// Contract and execution receipts use the existing M3 agent-run snapshot owner. No
// new scheduler, permission store, history-completion heuristic or replay engine.
const ThreadRelay = (() => {
  const chains = new Map(), admissions = new WeakSet();
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const failure = code => { throw Object.assign(new Error('thread_relay.' + code), { code: 'thread_relay.' + code, apiCode: 'thread_relay.' + code, statusCode: 409 }); };
  const id = value => safeSessionId(value) || failure('invalid_id');
  const identity = (...parts) => 'run_' + hash(parts).slice(0, 32);
  function policy(config, source, target) {
    // A snapshot can restrict admission, never grant permission. The turn itself
    // resolves current session/global permissions and current grants as usual.
    return hash([config, ...[source, target].map(session => [session.id, session.cwd,
      resolvePermissionMode({ session: applySessionPermissionModeOverride(session), config }),
      (autonomyGrants.get(session.id) || []).map(grant => [grant.grantId, grant.revoked, grant.expiresAt])])]);
  }
  async function session(sessionId) {
    const value = await loadSession(id(sessionId));
    if (!value || value.kind === 'steward' || sessionSaveIsTombstoned(value)) failure('thread_missing');
    return value;
  }
  async function snapshot(sessionId, runId) {
    try { return await readAgentRunSnapshot(sessionId, runId, { strict: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function idle(value) {
    return threadGate(value.id);
  }
  function completionId(sessionId) {
    // Same M3 task/snapshot owner, deliberately outside the runnable run_ list.
    return 'delivery_' + hash(sessionId).slice(0, 32); // One bounded latest fact per thread.
  }
  async function completion(sessionId, ref) {
    if (!ref || ref.latestTurnSeq !== ref.turnSeq) return { status: 'unknown' };
    const receiptId = completionId(sessionId, ref), record = await snapshot(sessionId, receiptId);
    const receipt = record?.deliveryCompletion;
    if (record?.kind !== 'thread_delivery_completion' || record.id !== receiptId || record.sessionId !== sessionId
        || receipt?.schema !== 1 || hash(receipt.reference) !== hash(reference(ref))
        || !receipt.execution?.driverRunId || !receipt.execution?.serverInstanceId) return { status: 'unknown' };
    return { ...receipt, identity: receiptId };
  }
  async function captureTurn({ session: completed, owner, config, result, error, stopped }) {
    const sessionId = completed.id;
    if (completed.kind === 'steward' || !owner || turnSettlers.get(sessionId) !== owner || result?.superseded) return { status: 'unknown' };
    const current = await session(sessionId);
    if (Number(current.turnSeq) !== Number(completed.turnSeq) || Number(current.rewindGen || 0) !== Number(completed.rewindGen || 0)) return { status: 'unknown' };
    const projected = await StewardHooks.deliveryProjection(sessionId, Number(completed.turnSeq), config, { skipRelayCompletion: true });
    if (!projected.ok || turnSettlers.get(sessionId) !== owner) return { status: 'unknown' };
    const ref = reference(projected), receiptId = completionId(sessionId, ref);
    const status = stopped || owner.cancelRequested || result?.aborted ? 'stopped'
      : !error && result?.ok === true ? 'succeeded' : result ? 'failed' : 'unknown';
    const receipt = { schema: 1, status, reference: ref, at: nowIso(),
      execution: sessionExecutionSnapshot(sessionId), error: String(error || result?.errorClass || '') };
    const record = { schemaVersion: 4, id: receiptId, sessionId, kind: 'thread_delivery_completion',
      status, nodes: [], createdAt: receipt.at, deliveryCompletion: receipt };
    // Do not call saveAgentRun: this fact is not a runnable workflow, notification,
    // index update or session-head mutation. Existing session GET/ETag bytes stay unchanged.
    const committed = await runKeyedChain(agentRunWriteChains, receiptId, async () => {
      if (turnSettlers.get(sessionId) !== owner) return false;
      await agentRunSnapshotStore(sessionId, receiptId).write(JSON.stringify(record)); return true;
    });
    return committed ? { ...receipt, identity: receiptId } : { status: 'unknown' };
  }
  async function threadGate(sid, { run = null, owner = null, ownRequests = new Map(), expectedCwd, expectedTurnSeq, changed = 'target_changed' } = {}) {
    const ownPending = (kind, requestId) => {
      const proof = ownRequests.get(kind + ':' + requestId);
      const pendingOwner = (kind === 'permission' ? pendingPermissions : kind === 'question' ? pendingQuestions : pendingPlans).get(requestId);
      if (!owner || proof?.owner !== owner || turnSettlers.get(sid) !== owner || pendingOwner?.sessionId !== sid) return false;
      if (!proof.pendingOwner) proof.pendingOwner = pendingOwner;
      return proof.pendingOwner === pendingOwner;
    };
    const assertLive = () => {
      const currentOwner = turnSettlers.get(sid);
      if (owner && (currentOwner !== owner || owner.cancelRequested)) failure('thread_blocked');
      if (currentOwner && currentOwner !== owner || turnOutcomePending.has(sid)
          || [...activeAgentRuns.values()].some(live => live.run.sessionId === sid && live.run !== run)) failure('target_busy');
      const child = activeChildren.get(sid);
      if (child && (!owner || child.executionOwner !== owner)) failure('target_busy');
      // These are the original pending owners, including requests not yet on disk.
      for (const row of interventionRecordCache.values()) if (row.sessionId === sid && row.status === 'pending'
          && !ownPending(row.type, row.id)) failure('decision_pending');
      for (const [kind, map] of [['permission', pendingPermissions], ['question', pendingQuestions], ['plan', pendingPlans]]) {
        for (const [requestId, entry] of map) if (entry.sessionId === sid && !ownPending(kind, requestId)) failure('decision_pending');
      }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      assertLive();
      const revision = sessionDiskWriteSeqOf(sid), current = await session(sid);
      const pending = await readInterventionsWithMeta(sid, { strict: true });
      if (revision !== sessionDiskWriteSeqOf(sid)) continue;
      if (expectedCwd !== undefined && current.cwd !== expectedCwd
          || expectedTurnSeq !== undefined && !owner && (Number(current.turnSeq) || 0) !== expectedTurnSeq) failure(changed);
      if (pending.degraded || pending.interventions.some(row => row.status === 'pending' && !ownPending(row.type, row.id))) failure('decision_pending');
      if (stewardThreadStateFromHead(current, owner ? { queued: false } : undefined).state === 'stopped') failure('thread_blocked');
      const assert = () => { assertLive(); if (revision !== sessionDiskWriteSeqOf(sid)) failure(changed); };
      assert(); return { assert };
    }
    failure(changed);
  }
  async function targetGate(run, owner = null, ownRequests = new Map()) {
    const spec = run.threadRelayExecution;
    return threadGate(run.sessionId, { run, owner, ownRequests, expectedCwd: spec.targetCwd, expectedTurnSeq: spec.targetTurnSeq });
  }
  function reference(value) {
    if (!value || !Number.isSafeInteger(value.turnSeq) || value.turnSeq < 1
        || !Number.isSafeInteger(value.latestTurnSeq) || value.latestTurnSeq !== value.turnSeq
        || !/^[a-f0-9]{64}$/.test(value.sourceStamp || '') || !/^[a-f0-9]{64}$/.test(value.fileStamp || '')) failure('source_invalid');
    return { turnSeq: value.turnSeq, latestTurnSeq: value.latestTurnSeq, sourceStamp: value.sourceStamp, fileStamp: value.fileStamp };
  }
  async function material(sourceId, input, config) {
    const source = await session(sourceId);
    const sourceAdmission = await threadGate(source.id, { changed: 'source_changed' });
    const ref = reference(input.reference);
    const checked = await StewardHooks.validateDeliveryReference(source.id, ref, config);
    if (!checked.ok) failure('source_changed');
    if ((await completion(source.id, ref)).status !== 'succeeded') failure('source_unverified');
    const delivery = await StewardHooks.deliveryProjection(source.id, ref.turnSeq, config);
    if (delivery.inProgress || delivery.outdated) failure('source_unverified');
    if (input.accepted !== true) failure('acceptance_required');
    const selected = input.materials;
    if (!selected || typeof selected.text !== 'boolean' || !Array.isArray(selected.files) || selected.files.length > 8
        || !selected.text && !selected.files.length || new Set(selected.files).size !== selected.files.length) failure('materials_invalid');
    const revisionGuard = StewardHooks.deliveryRevisionGuard(source, ref,
      selected.files.map(selectedPath => delivery.files.find(file => file.path === selectedPath && file.status === 'same') || failure('material_changed')),
      agentRunFile(source.id, completionId(source.id)));
    // Only host-loaded rows from this exact delivery may be restored. An alias
    // supplied by a browser, another scope or a model is never restoration proof.
    const original = StewardHooks.deliverySource(source, ref.turnSeq);
    if (!original?.rows.some(row => row.role === 'assistant' && !row.meta?.imported && Number(row.turnSummary?.turnSeq) === ref.turnSeq)) failure('source_unverified');
    const protectedRows = selected.text ? original.rows.filter(row => row.role === 'assistant' && !row.meta?.imported) : [];
    const restored = await PrivacyGateway.prepareLocalDisclosure(source.id, () => PrivacyGateway.restoreHistory(source.id, { messages: protectedRows }));
    const parts = selected.text ? restored.value.messages.map(row => String(row.content || '')) : [];
    const approvedFiles = [];
    for (const selectedPath of selected.files) {
      const file = delivery.files.find(row => row.path === selectedPath && row.status === 'same');
      if (!file) failure('material_changed');
      const read = await StewardHooks.inspectDeliveryFile(file, source, config, { bytes: 0 }, true);
      if (!read.bytes || read.fingerprint !== file.fingerprint || read.bytes.length > 128 * 1024 || read.bytes.includes(0)) failure('material_unreadable');
      const text = read.bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(read.bytes)) failure('material_unreadable');
      approvedFiles.push({ path: file.path, fingerprint: file.fingerprint });
      parts.push(file.name + '\n' + text);
    }
    const text = parts.join('\n\n');
    if (!text.trim() || Buffer.byteLength(text) > 256 * 1024 || text.includes('[[RUYI_PVT:')) failure('foreign_reference');
    restored.assert();
    // Re-check file/source revision after all asynchronous reads, before binding.
    const finalCheck = await StewardHooks.validateDeliveryReference(source.id, ref, await readConfig());
    if (!finalCheck.ok) failure('source_changed');
    const assert = () => { sourceAdmission.assert(); revisionGuard(); restored.assert(); };
    assert();
    return { source, text, assert, binding: { sessionId: source.id, reference: ref,
      materials: { text: selected.text, files: approvedFiles }, hash: hash(text),
      acceptance: { kind: 'human', at: nowIso(), sourceStamp: ref.sourceStamp, fileStamp: ref.fileStamp } } };
  }
  async function read(rootId, relayId) {
    const run = await snapshot(id(rootId), id(relayId));
    if (!run || run.kind !== 'thread_relay' || run.sessionId !== rootId || run.threadRelay?.schema !== 1) failure('not_found');
    return run;
  }
  async function reconcile(run) {
    for (const edge of run.threadRelay.edges) {
      if (!edge.submittedAt || ['accepted', 'cancelled'].includes(edge.state)) continue;
      const waited = await waitForAgentRunResults(edge.targetSessionId, [edge.runId], 0);
      const envelope = waited.runs?.find(row => row.runId === edge.runId);
      const row = await readAgentRunRecord(edge.targetSessionId, edge.runId);
      const execution = row?.run?.threadRelayExecution;
      const receipt = execution?.receipt;
      if (!matchesExecution(row?.run, run, edge)) { edge.state = 'unknown'; continue; }
      if (receipt?.identity !== edge.runId) { edge.state = 'unknown'; continue; }
      if (receipt.status === 'succeeded' && envelope?.live !== true) { edge.state = 'review'; edge.resultTurnSeq = receipt.turnSeq; }
      else if (['failed', 'stopped'].includes(receipt.status)) edge.state = receipt.status;
      // The original wrapper can stop before it ever enters runSessionTurn.
      // A running/unknown receipt or an entered target remains unknown instead.
      else if (envelope?.live !== true && receipt.status === 'intent' && ['stopped', 'failed'].includes(row.run.status)
          && (execution.entryPhase === 'not_entered' || !execution.entryPhase && row.run.nodes?.every(node => !node.attempts && !node.startedAt && !node.modelStartedAt))) {
        edge.state = row.run.status;
        edge.reason = row.run.error || row.run.nodes?.find(node => node.error)?.error || 'thread_relay.' + (edge.state === 'stopped' ? 'stopped' : 'target_failed');
        edge.receipt = receipt; continue;
      }
      else edge.state = envelope?.live === true ? 'running' : 'unknown';
      edge.receipt = receipt;
      edge.reason = receipt.error || '';
    }
    return run;
  }
  const taskStamp = value => typeof value?.task === 'string' ? hash(value.task) : value?.taskHash;
  function matchesExecution(executionRun, master, edge) {
    const spec = executionRun?.threadRelayExecution;
    return executionRun?.kind === 'existing_thread_relay' && executionRun.id === edge.runId && executionRun.sessionId === edge.targetSessionId
      && spec?.relayId === master.id && spec.rootId === master.sessionId && spec.edgeId === edge.id
      && hash(spec.source) === hash(edge.source) && spec.policyStamp === edge.policyStamp
      && spec.targetCwd === edge.targetCwd && spec.targetTurnSeq === edge.targetTurnSeq
      && /^[a-f0-9]{64}$/.test(taskStamp(spec) || '') && taskStamp(spec) === taskStamp(edge)
      && spec.receipt?.identity === edge.runId;
  }
  async function retireHistory(sessionId, runId) {
    const original = await snapshot(sessionId, runId);
    if (!original || !['thread_relay', 'existing_thread_relay'].includes(original.kind)) failure('not_found');
    const relayId = original.kind === 'thread_relay' ? runId : original.threadRelayExecution?.relayId;
    return runKeyedChain(chains, relayId, async () => {
      if (activeAgentRuns.has(runId)) failure('target_busy');
      const current = await snapshot(sessionId, runId);
      if (!current || current.kind !== original.kind) failure('identity_conflict');
      // Re-read under the same relay lock as submit; never write the DELETE
      // route's old copy. saveAgentRun alone owns its snapshot write chain.
      const run = { schemaVersion: current.schemaVersion, id: current.id, sessionId: current.sessionId, kind: current.kind,
        status: current.status, createdAt: current.createdAt, completedAt: current.completedAt, error: current.error,
        historyDeletedAt: current.historyDeletedAt || nowIso(), nodes: [] };
      if (current.kind === 'thread_relay') {
        run.status = 'cancelled';
        run.threadRelay = { schema: 1, requestHash: current.threadRelay.requestHash, cancelled: true, retiredAt: run.historyDeletedAt,
          edges: current.threadRelay.edges.map(edge => ({ id: edge.id, dependsOn: edge.dependsOn, targetSessionId: edge.targetSessionId,
            targetCwd: edge.targetCwd, targetTurnSeq: edge.targetTurnSeq, attempt: edge.attempt, runId: edge.runId,
            state: edge.state, source: edge.source, policyStamp: edge.policyStamp, taskHash: taskStamp(edge),
            submittedAt: edge.submittedAt, receipt: edge.receipt, resultTurnSeq: edge.resultTurnSeq, reason: edge.reason })) };
      } else {
        const spec = current.threadRelayExecution;
        run.threadRelayExecution = { relayId: spec.relayId, rootId: spec.rootId, edgeId: spec.edgeId, source: spec.source,
          policyStamp: spec.policyStamp, targetCwd: spec.targetCwd, targetTurnSeq: spec.targetTurnSeq,
          taskHash: taskStamp(spec), entryPhase: spec.entryPhase, receipt: spec.receipt };
        run.nodes = (current.nodes || []).map(node => ({ id: node.id, status: node.status, attempts: node.attempts,
          startedAt: node.startedAt, modelStartedAt: node.modelStartedAt, error: node.error, errorClass: node.errorClass }));
      }
      await saveAgentRun(run);
    });
  }
  async function create(body) {
    const rootId = id(body.sessionId), key = id(body.requestId), relayId = identity('relay', rootId, key);
    return runKeyedChain(chains, relayId, async () => {
      const existing = await snapshot(rootId, relayId);
      const requestHash = hash({ source: body.source, targets: body.targets });
      if (existing) {
        if (existing.kind !== 'thread_relay' || existing.threadRelay?.requestHash !== requestHash) failure('identity_conflict');
        return reconcile(existing);
      }
      if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 7) failure('chain_bounds');
      const config = await readConfig(), approved = await material(rootId, body.source, config);
      const seen = new Set([rootId]), edges = [];
      for (const [index, target] of body.targets.entries()) {
        const targetId = id(target.sessionId);
        if (seen.has(targetId)) failure('thread_repeated');
        seen.add(targetId);
        const thread = await session(targetId);
        const task = String(target.task || '').trim();
        if (!task || task.length > 8000 || task.includes('[[RUYI_PVT:')) failure('task_invalid');
        const edgeId = 'edge_' + hash([relayId, index]).slice(0, 24);
        const edge = { id: edgeId, dependsOn: index ? edges[index - 1].id : null, targetSessionId: targetId,
          targetTitle: sessionDisplayTitle(thread), targetCwd: thread.cwd, targetTurnSeq: Number(thread.turnSeq) || 0,
          task, attempt: 1, runId: identity(relayId, edgeId, index ? null : approved.binding.reference, targetId, 1), state: index ? 'waiting' : 'ready',
          ...(index ? {} : { source: approved.binding, policyStamp: policy(config, approved.source, thread) }) };
        const previous = index ? null : await snapshot(targetId, edge.runId);
        if (previous) {
          const spec = previous.threadRelayExecution;
          if (previous.kind !== 'existing_thread_relay' || previous.id !== edge.runId || previous.sessionId !== targetId
              || spec?.relayId !== relayId || spec.rootId !== rootId || spec.edgeId !== edgeId || taskStamp(spec) !== hash(task)
              || spec.receipt?.identity !== edge.runId || spec.source?.sessionId !== rootId
              || spec.source.hash !== approved.binding.hash || hash(spec.source.reference) !== hash(approved.binding.reference)
              || hash(spec.source.materials) !== hash(approved.binding.materials)) failure('identity_conflict');
          Object.assign(edge, { source: spec.source, policyStamp: spec.policyStamp, targetCwd: spec.targetCwd,
            targetTurnSeq: spec.targetTurnSeq, submittedAt: spec.receipt.at || previous.createdAt, state: 'unknown' });
          if (!edge.submittedAt) failure('result_unverified');
        } else await idle(thread);
        edges.push(edge);
      }
      const run = { schemaVersion: 4, id: relayId, sessionId: rootId, title: 'Existing thread relay',
        kind: 'thread_relay', status: 'relay_ready', createdAt: nowIso(), nodes: [],
        threadRelay: { schema: 1, requestHash, cancelled: false, edges } };
      await saveAgentRun(run); return reconcile(run);
    });
  }
  async function submit(rootId, relayId, edgeId) {
    return runKeyedChain(chains, relayId, async () => {
      const run = await reconcile(await read(rootId, relayId)), chain = run.threadRelay;
      if (chain.cancelled) failure('cancelled');
      const edge = chain.edges.find(row => row.id === edgeId);
      if (!edge) failure('edge_missing');
      if (edge.submittedAt) return run; // Same identity always returns the same receipt, including unknown.
      // An existing target receipt is authoritative even if a degraded/older
      // master has lost its intent. Never overwrite it with another intent.
      const previous = await snapshot(edge.targetSessionId, edge.runId);
      if (previous) {
        if (!matchesExecution(previous, run, edge)) failure('identity_conflict');
        edge.submittedAt = previous.threadRelayExecution.receipt.at || previous.createdAt;
        if (!edge.submittedAt) failure('result_unverified');
        edge.state = 'unknown'; await saveAgentRun(run); return reconcile(run);
      }
      if (edge.state !== 'ready' || edge.dependsOn && !chain.edges.some(row => row.id === edge.dependsOn && row.state === 'accepted')) failure('dependency_unaccepted');
      const config = await readConfig(), target = await session(edge.targetSessionId);
      await idle(target);
      if (target.cwd !== edge.targetCwd || (Number(target.turnSeq) || 0) !== edge.targetTurnSeq) failure('target_changed');
      const approved = await material(edge.source.sessionId, { reference: edge.source.reference, accepted: true,
        materials: { text: edge.source.materials.text, files: edge.source.materials.files.map(file => file.path) } }, config);
      if (approved.binding.hash !== edge.source.hash) failure('material_changed');
      if (policy(config, approved.source, target) !== edge.policyStamp) failure('permission_changed');
      // Durable intent precedes both the execution record and the launch call.
      edge.submittedAt = nowIso(); edge.state = 'unknown';
      await saveAgentRun(run);
      const execution = { schemaVersion: 4, id: edge.runId, sessionId: target.id, cwd: target.cwd,
        turnSeq: target.turnSeq, kind: 'existing_thread_relay', background: true, launchedByModel: false,
        status: 'queued', createdAt: nowIso(), concurrency: 1, poolPolicy: 'off', taskPool: [], messages: [],
        threadRelayExecution: { relayId, rootId, edgeId, source: edge.source, policyStamp: edge.policyStamp,
          targetCwd: edge.targetCwd, targetTurnSeq: edge.targetTurnSeq, task: edge.task, entryPhase: 'not_entered',
          receipt: { identity: edge.runId, status: 'intent', at: nowIso() } },
        nodes: [{ id: 'continue', task: edge.task, dependsOn: [], resources: [], toolTier: 'exec', engine: 'openai',
          status: 'queued', attempts: 0, maxRetries: 0, failurePolicy: 'block', dependencyPolicy: 'all_success',
          degradedPolicy: 'fail', maxIters: 100 }] };
      await saveAgentRun(execution);
      const admission = Object.freeze({}); admissions.add(admission);
      const launched = await launchPersistedAgentRun({ sessionId: target.id, runId: edge.runId, relayAdmission: admission });
      edge.state = launched.ok ? 'running' : 'unknown';
      await saveAgentRun(run); return reconcile(run);
    });
  }
  async function accept(body) {
    return runKeyedChain(chains, body.relayId, async () => {
      const run = await reconcile(await read(body.sessionId, body.relayId)), chain = run.threadRelay;
      if (chain.cancelled) failure('cancelled');
      const edge = chain.edges.find(row => row.id === body.edgeId);
      if (!edge || edge.state !== 'review' || !edge.receipt || edge.receipt.status !== 'succeeded') failure('result_unverified');
      const approved = await material(edge.targetSessionId, body.source, await readConfig());
      if (approved.binding.reference.turnSeq !== edge.receipt.turnSeq) failure('source_changed');
      edge.state = 'accepted'; edge.acceptedDelivery = approved.binding;
      const next = chain.edges.find(row => row.dependsOn === edge.id);
      if (next) {
        const target = await session(next.targetSessionId); await idle(target);
        if (target.cwd !== next.targetCwd || (Number(target.turnSeq) || 0) !== next.targetTurnSeq) failure('target_changed');
        next.source = approved.binding; next.policyStamp = policy(await readConfig(), approved.source, target); next.state = 'ready';
        next.runId = identity(run.id, next.id, approved.binding.reference, next.targetSessionId, next.attempt);
      }
      run.status = chain.edges.every(row => row.state === 'accepted') ? 'succeeded' : 'relay_ready';
      await saveAgentRun(run); return run;
    });
  }
  async function cancel(body) {
    return runKeyedChain(chains, body.relayId, async () => {
      const run = await read(body.sessionId, body.relayId);
      run.threadRelay.cancelled = true; run.status = 'cancelled';
      // Persist retirement first; a late success can never reopen a cancelled chain.
      await saveAgentRun(run);
      for (const edge of run.threadRelay.edges) {
        const live = activeAgentRuns.get(edge.runId);
        if (live) { live.stopRequested = true; live.ctrl?.abort(); }
        const owner = turnSettlers.get(edge.targetSessionId);
        if (owner?.requestMeta?.relayExecutionId === edge.runId) requestSessionExecutionStop(edge.targetSessionId, sessionExecutionSnapshot(edge.targetSessionId), 'stopped');
        if (edge.state !== 'accepted') edge.state = 'cancelled';
      }
      await saveAgentRun(run); return run;
    });
  }
  function admit(run, capability) {
    if (run.kind !== 'existing_thread_relay') return;
    if (!admissions.delete(capability) || run.threadRelayExecution?.receipt?.status !== 'intent') failure('replay_forbidden');
  }
  async function execute(run, node, signal, onEvent) {
    try { return await executeTarget(run, node, signal, onEvent); }
    catch (error) {
      const spec = run.threadRelayExecution;
      if (spec?.receipt?.status === 'intent') {
        const receipt = { ...spec.receipt, status: signal?.aborted ? 'stopped' : 'failed', error: signal?.aborted ? 'thread_relay.stopped' : String(error.code || error.message || error), at: nowIso() };
        await saveAgentRun({ ...run, threadRelayExecution: { ...spec, receipt } });
        spec.receipt = receipt;
      }
      throw error;
    }
  }
  async function executeTarget(run, node, signal, onEvent) {
    const spec = run.threadRelayExecution;
    if (!spec || spec.receipt.status !== 'intent') failure('replay_forbidden');
    const master = await read(spec.rootId, spec.relayId), edge = master.threadRelay.edges.find(row => row.id === spec.edgeId);
    if (master.threadRelay.cancelled || !edge || edge.runId !== run.id || !edge.submittedAt || signal?.aborted) failure('cancelled');
    await targetGate(run);
    const config = await readConfig(), target = await session(run.sessionId);
    const approved = await material(spec.source.sessionId, { reference: spec.source.reference, accepted: true,
      materials: { text: spec.source.materials.text, files: spec.source.materials.files.map(file => file.path) } }, config);
    if (approved.binding.hash !== spec.source.hash || policy(config, approved.source, target) !== spec.policyStamp) failure('permission_changed');
    // Admission borrows the existing workspace lease. Once the original turn
    // owner is registered it takes over execution/arbiter/tool leases; retaining
    // a second group here would deadlock that owner's own file tools.
    let lease = await acquireResourceLease('turn:' + target.id + ':' + (Number(target.turnSeq) + 1),
      normalizeAgentResources(['workspace:' + target.cwd], target.cwd), signal,
      blockers => onEvent({ type: 'agent_resource', state: 'waiting', resources: [target.cwd], blockers }));
    try {
      if (signal?.aborted) failure('cancelled');
      (await targetGate(run)).assert();
      let ownOwner = null;
      const ownRequests = new Map();
      const targetEvent = event => {
        if (ownOwner && turnSettlers.get(target.id) === ownOwner) {
          const kind = event?.type === 'permission_request' ? 'permission' : event?.type === 'ask_user' ? 'question' : event?.type === 'plan' ? 'plan' : '';
          const requestId = kind === 'permission' ? event.requestId : kind === 'question' ? event.questionId : event?.planId;
          if (kind && requestId) ownRequests.set(kind + ':' + requestId, { owner: ownOwner, pendingOwner: null });
        }
        onEvent(event);
      };
      // Persist the boundary before calling the original target turn owner.
      // Only not_entered intent can later use a wrapper-only terminal fact.
      spec.entryPhase = 'entering';
      await saveAgentRun(run);
      // The target receives host-restored originals as fresh input. Its ordinary
      // PrivacyGateway projects/re-signs them under the target conversation scope.
      const result = await PrivacyGateway.run(target.id, config, () => SessionExecutionHooks.runTurn({ sessionId: target.id, source: 'thread_relay',
        expectedCwd: spec.targetCwd, expectedTurnSeq: spec.targetTurnSeq,
        message: spec.task + '\n\n' + approved.text, messageMeta: { origin: 'thread_relay', relayExecutionId: run.id },
        requestMeta: { relayExecutionId: run.id }, onEvent: targetEvent,
        relayLifecycle: {
          identity: run.id, signal,
          prepareAdmission: () => targetGate(run),
          async registered(owner, currentConfig, currentSession) {
            if (owner.requestMeta?.relayExecutionId !== run.id || turnSettlers.get(target.id) !== owner) failure('target_busy');
            ownOwner = owner;
            const targetAdmission = await targetGate(run, owner, ownRequests);
            const currentMaster = await read(spec.rootId, spec.relayId);
            if (currentMaster.threadRelay.cancelled) failure('cancelled');
            if (signal?.aborted || policy(currentConfig, approved.source, currentSession) !== spec.policyStamp) failure('permission_changed');
            const receipt = { identity: run.id, status: 'running', execution: sessionExecutionSnapshot(target.id), at: nowIso() };
            await saveAgentRun({ ...run, threadRelayExecution: { ...spec, receipt } });
            targetAdmission.assert();
            spec.receipt = receipt;
            releaseResourceLease(lease); lease = '';
          },
          async beforeDispatch() {
            const assertConfig = configReadFence();
            const sourceRevision = sessionDiskWriteSeqOf(spec.source.sessionId);
            const currentMaster = await read(spec.rootId, spec.relayId);
            if (currentMaster.threadRelay.cancelled || signal?.aborted) failure('cancelled');
            const currentConfig = await readConfig(), currentSource = await session(spec.source.sessionId);
            const checked = await StewardHooks.validateDeliveryReference(currentSource.id, spec.source.reference, currentConfig);
            if (!checked.ok) failure('source_changed');
            const currentTarget = await session(target.id);
            if (policy(currentConfig, currentSource, currentTarget) !== spec.policyStamp) failure('permission_changed');
            const targetAdmission = await targetGate(run, ownOwner, ownRequests);
            const sourceAdmission = await threadGate(currentSource.id, { changed: 'source_changed' });
            const assert = () => {
              if (signal?.aborted || ownOwner?.cancelRequested) failure('cancelled');
              if (sourceRevision !== sessionDiskWriteSeqOf(spec.source.sessionId)) failure('source_changed');
              sourceAdmission.assert();
              approved.assert(); assertConfig();
              if (policy(currentConfig, currentSource, currentTarget) !== spec.policyStamp) failure('permission_changed');
              targetAdmission.assert();
            };
            assert(); return { assert };
          },
          async settled(outcome) {
            const status = outcome.stopped ? 'stopped' : outcome.ok && outcome.result?.ok === true && !outcome.result.aborted && !outcome.result.superseded
              ? outcome.deliveryCompletion?.status === 'succeeded' ? 'succeeded' : 'unknown' : 'failed';
            const receipt = { ...spec.receipt, status, turnSeq: outcome.turnSeq, error: outcome.error || '',
              deliveryCompletion: outcome.deliveryCompletion?.identity || '', at: nowIso() };
            await saveAgentRun({ ...run, threadRelayExecution: { ...spec, receipt } });
            spec.receipt = receipt;
          },
        } }));
      return { ok: spec.receipt.status === 'succeeded' && result.ok && !result.stopped && result.result?.ok === true && !result.result.aborted && !result.result.superseded,
        result: '', error: result.stopped ? 'thread_relay.stopped' : result.error || (result.result?.ok === true ? '' : 'thread_relay.target_failed') };
    } finally { releaseResourceLease(lease); }
  }
  async function route(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/thread-relays') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'invalid token', 403));
      const query = new URL(req.url, 'http://x').searchParams;
      const rootId = id(query.get('sessionId')), relayId = query.get('relayId');
      const rows = relayId ? [await reconcile(await read(rootId, relayId))]
        : await Promise.all((await listAgentRuns(rootId)).filter(run => run.kind === 'thread_relay').map(reconcile));
      return send(res, json({ ok: true, relays: rows }));
    }
    if (req.method !== 'POST' || pathname !== '/api/thread-relays') return;
    const body = await readJsonBody(req);
    if (!tokenMatches(body.token)) return send(res, apiFailure('auth.token_invalid', {}, 'invalid token', 403));
    const run = body.action === 'create' ? await create(body) : body.action === 'start' ? await submit(id(body.sessionId), id(body.relayId), id(body.edgeId))
      : body.action === 'accept' ? await accept(body) : body.action === 'cancel' ? await cancel(body) : failure('action_invalid');
    return send(res, json({ ok: true, relay: run }));
  }
  return Object.freeze({ create, submit, accept, cancel, read, reconcile, admit, execute, route, material, captureTurn, completion, targetGate, retireHistory });
})();
Object.assign(ThreadRelayHooks, { admit: ThreadRelay.admit, execute: ThreadRelay.execute, route: ThreadRelay.route,
  captureTurn: ThreadRelay.captureTurn, completion: ThreadRelay.completion, retireHistory: ThreadRelay.retireHistory });
