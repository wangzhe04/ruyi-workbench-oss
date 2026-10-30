'use strict';
// PURE R3: real domain/DELETE/finally slices; --observe-r2 replays all 10 independent observations.
// against in-memory adapters. No server import, HTTP, engine, browser, native,
// DPAPI, scheduler, user-data access or process cleanup.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), old = process.argv.includes('--observe-r2');
const before = process.env.RUYI_RELAY_R2_BEFORE;
if (old) assert(before, 'RUYI_RELAY_R2_BEFORE is required');
const { constBlock, functionBlock, sliceBlock } = require(path.join(root, 'dev-harness/lib/source-slice'));
const file = name => old && fs.existsSync(path.join(before, 'ruyi-workbench/app/src', name + '.gz'))
  ? require('node:zlib').gunzipSync(fs.readFileSync(path.join(before, 'ruyi-workbench/app/src', name + '.gz'))).toString('utf8')
  : fs.readFileSync(path.join(root, 'ruyi-workbench/app/src', name), 'utf8');
const fixtureFile = path.join(root, 'dev-harness/thread-relay-admission.static.e2e.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8'), end = fixtureSource.indexOf('\n(async () => {');
assert(end > 5000);
const fixture = vm.runInNewContext(fixtureSource.slice(0, end) + '\nfixture', {
  require: createRequire(fixtureFile), __dirname: path.dirname(fixtureFile), Buffer, URL, process: { argv: [], env: old ? { RUYI_RELAY_SNAPSHOT: before } : {} },
});
const observations = [];
function record(name, value) { observations.push({ name, ...value }); process.stdout.write(name + '\n' + JSON.stringify(value) + '\n'); }
async function setup(key) {
  const f = fixture(); await f.seed('a'); await f.seed('b'); await f.seed('c');
  const chain = await f.make(key); return { f, chain };
}
const execute = f => f.relay.execute(f.admitted(), f.admitted().nodes[0], new AbortController().signal, () => {});
async function launch(f, chain) { await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id); }
async function attempt(work) { try { return { result: await work() }; } catch (error) { return { error: error.code || error.message }; } }
function deletionRoute(f) {
  return vm.runInNewContext(functionBlock(file('13d-core-domain-routes.js'), 'handleAgentRunApiRoutes') + '\nhandleAgentRunApiRoutes', {
    URL, ThreadRelayHooks: { retireHistory: f.relay.retireHistory }, activeAgentRuns: f.live, safeSessionId: f.sandbox.safeSessionId,
    agentRunFile: f.sandbox.agentRunFile, readAgentRunSnapshot: f.sandbox.readAgentRunSnapshot,
    agentRunEventsFile: (sid, rid) => sid + '/' + rid + '.events.ndjson',
    fsp: { unlink: async target => {
      if (target.endsWith('.json')) { const key = target.slice(0, -5); if (!f.records.delete(key)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); }
    } }, cleanupAgentWorktree: async () => { throw Error('not expected'); }, agentRunDigestWriteSeq: 0, agentRunDigestCache: new Map(),
    bumpMissionChangeSeq: async () => {}, RUYI_EVENTS: { emit() {} }, json: (body, status = 200) => ({ body, status }), send: (res, value) => value,
  });
}
async function remove(f, sid, rid) { return deletionRoute(f)({ method: 'DELETE', url: '/api/agent-runs/' + rid + '?sessionId=' + sid }, {}, '/api/agent-runs/' + rid); }
function useOriginalSnapshotWriter(f) {
  const inWrite = new Set(), keyed = f.sandbox.runKeyedChain;
  const snapshotOwner = {
    sessionAssociatedSaveIsTombstoned: () => false, nowIso: () => '2026-10-30T00:00:00Z',
    agentRunWriteChains: f.sandbox.agentRunWriteChains, agentRunSnapshotStore: f.sandbox.agentRunSnapshotStore,
    runKeyedChain: (map, key, work) => {
      assert(!inWrite.has(key), 'same original snapshot write chain must not nest');
      return keyed(map, key, async () => { inWrite.add(key); try { return await work(); } finally { inWrite.delete(key); } });
    },
    agentRunDir: sid => sid, fsp: { mkdir: async () => {} }, agentRunFile: f.sandbox.agentRunFile,
    agentRunDigestWriteSeq: 0, agentRunDigestCache: new Map(), markPretenderIndexDirty() {}, agentRunHealthChanged: () => false,
    agentRunLastSavedStatus: new Map(), RUYI_EVENTS: { emit() {} }, agentRunSaveFailures: new Map(), appendAgentRunEvent() {},
    activeAgentRuns: f.live, AGENT_RUN_PERSIST_DEGRADED_AFTER: 3, AGENT_RUN_PERSIST_PAUSE_AFTER: 5,
  };
  f.sandbox.saveAgentRun = vm.runInNewContext(functionBlock(file('08-agent-runs.js'), 'saveAgentRun') + '\nsaveAgentRun', snapshotOwner);
  return inWrite;
}
function holdSnapshotRead(f, sid, rid) {
  let seen, release, once = true;
  const read = f.sandbox.readAgentRunSnapshot, entered = new Promise(resolve => { seen = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.sandbox.readAgentRunSnapshot = async (sessionId, runId, metadata) => {
    const copy = await read(sessionId, runId, metadata);
    if (once && sessionId === sid && runId === rid) { once = false; seen(); await gate; }
    return copy;
  };
  return { entered, release };
}
async function deletionInterleavings() {
  const master = await setup('late_master_delete'); const inWrite = useOriginalSnapshotWriter(master.f);
  master.f.records.get('a/' + master.chain.id).messages = [{ content: 'REMOVE_MASTER_HISTORY_BODY' }];
  const hold = holdSnapshotRead(master.f, 'a', master.chain.id), deleting = remove(master.f, 'a', master.chain.id); await hold.entered;
  await launch(master.f, master.chain); await execute(master.f); master.f.live.clear();
  const rid = master.chain.threadRelay.edges[0].runId, receipt = JSON.stringify(master.f.records.get('b/' + rid).threadRelayExecution.receipt);
  hold.release(); assert.equal((await deleting).status, 200);
  const retired = master.f.records.get('a/' + master.chain.id);
  assert(retired.threadRelay.edges[0].submittedAt); assert(retired.threadRelay.cancelled); assert(!retired.messages);
  assert(!retired.threadRelay.edges[0].task); assert(retired.threadRelay.edges[0].taskHash);
  assert.equal(JSON.stringify(master.f.records.get('b/' + rid).threadRelayExecution.receipt), receipt);
  assert.equal(inWrite.size, 0); assert.equal((await attempt(async () => launch(master.f, await master.f.make('late_master_delete')))).error, 'thread_relay.cancelled');
  assert.equal(master.f.state.engines, 1);
  record('LATE_MASTER_DELETE_RELOADS_INTENT_AND_PRESERVES_RECEIPT', { controlledDispatches: 1, compact: true, nestedSnapshotWrites: false });

  for (const finishFirst of [true, false]) {
    const target = await setup('late_target_delete_' + finishFirst); useOriginalSnapshotWriter(target.f);
    let entered, allowLaunch;
    const beforeLaunch = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { allowLaunch = resolve; });
    const launcher = target.f.sandbox.launchPersistedAgentRun;
    target.f.sandbox.launchPersistedAgentRun = async input => { entered(); await gate; return launcher(input); };
    const starting = launch(target.f, target.chain); await beforeLaunch;
    const runId = target.chain.threadRelay.edges[0].runId;
    const oldTarget = target.f.records.get('b/' + runId); oldTarget.messages = [{ content: 'REMOVE_TARGET_HISTORY_BODY' }];
    oldTarget.nodes[0].result = 'REMOVE_NODE_RESULT'; oldTarget.nodes[0].continuation = { body: 'REMOVE_CONTINUATION' };
    const hold = holdSnapshotRead(target.f, 'b', runId), deleting = remove(target.f, 'b', runId); await hold.entered;
    if (finishFirst) {
      allowLaunch(); await starting; await execute(target.f); target.f.live.clear();
      hold.release(); assert.equal((await deleting).status, 200);
      const final = target.f.records.get('b/' + runId);
      assert.equal(final.threadRelayExecution.receipt.status, 'succeeded'); assert(!final.messages);
      assert(!final.threadRelayExecution.task && final.threadRelayExecution.taskHash);
      assert(!final.nodes[0].result && !final.nodes[0].continuation && !final.nodes[0].task);
      const reviewed = await target.f.relay.submit('a', target.chain.id, target.chain.threadRelay.edges[0].id);
      assert.equal(reviewed.threadRelay.edges[0].state, 'review'); assert.equal(target.f.state.engines, 1);
    } else {
      hold.release(); allowLaunch(); await starting;
      assert.equal((await deleting).status, 409); assert(!target.f.records.get('b/' + runId).historyDeletedAt);
      await execute(target.f); target.f.live.clear(); assert.equal(target.f.state.engines, 1);
    }
    record('LATE_TARGET_DELETE_' + (finishFirst ? 'KEEPS_NEW_SUCCESS' : 'REFUSES_LIVE_OWNER'), { controlledDispatches: 1, nestedSnapshotWrites: false });
  }
}

async function additional() {
  await deletionInterleavings();
  const legacy = await setup('missing_master_existing_receipt'); await launch(legacy.f, legacy.chain); await execute(legacy.f); legacy.f.live.clear();
  const edge = legacy.chain.threadRelay.edges[0], originalReceipt = JSON.stringify(legacy.f.records.get('b/' + edge.runId).threadRelayExecution.receipt);
  legacy.f.records.delete('a/' + legacy.chain.id); // Simulate an already missing legacy contract, not the new DELETE owner.
  const adopted = await legacy.f.make('missing_master_existing_receipt');
  assert.equal(adopted.id, legacy.chain.id); assert.equal(adopted.threadRelay.edges[0].state, 'review');
  await launch(legacy.f, adopted); assert.equal(legacy.f.state.engines, 1);
  assert.equal(JSON.stringify(legacy.f.records.get('b/' + edge.runId).threadRelayExecution.receipt), originalReceipt);
  record('LEGACY_MISSING_MASTER_ADOPTS_VERIFIED_TARGET_RECEIPT', { controlledDispatches: 1, receiptUnchanged: true });

  const stale = await setup('lost_intent_existing_receipt'); await launch(stale.f, stale.chain); await execute(stale.f); stale.f.live.clear();
  const saved = stale.f.records.get('a/' + stale.chain.id); delete saved.threadRelay.edges[0].submittedAt; saved.threadRelay.edges[0].state = 'ready';
  const restored = await stale.f.relay.submit('a', saved.id, saved.threadRelay.edges[0].id);
  assert.equal(restored.threadRelay.edges[0].state, 'review'); assert.equal(stale.f.state.engines, 1);
  record('STALE_MASTER_INTENT_CANNOT_OVERWRITE_EXISTING_RECEIPT', { controlledDispatches: 1 });

  const conflict = await setup('foreign_target_receipt');
  const foreignEdge = conflict.chain.threadRelay.edges[0];
  conflict.f.records.set('b/' + foreignEdge.runId, { id: foreignEdge.runId, sessionId: 'b', kind: 'ordinary', nodes: [] });
  assert.equal((await attempt(() => launch(conflict.f, conflict.chain))).error, 'thread_relay.identity_conflict');
  assert.equal(conflict.f.state.engines, 0);
  record('SAME_ID_FOREIGN_RECEIPT_IS_REFUSED', { controlledDispatches: 0 });

  const fresh = await setup('retired_then_explicit_new'); await launch(fresh.f, fresh.chain); await execute(fresh.f); fresh.f.live.clear();
  await remove(fresh.f, 'a', fresh.chain.id); await remove(fresh.f, 'b', fresh.chain.threadRelay.edges[0].runId);
  const next = await fresh.f.make('explicitly_new_request'); assert.notEqual(next.id, fresh.chain.id);
  await launch(fresh.f, next); await execute(fresh.f); fresh.f.live.clear(); assert.equal(fresh.f.state.engines, 2);
  record('EXPLICIT_NEW_REQUEST_CAN_START_NEW_RELAY', { distinctIdentity: true, controlledDispatches: 2 });

  const ordinary = await setup('ordinary_delete'); ordinary.f.records.set('a/run_ordinary', { id: 'run_ordinary', sessionId: 'a', nodes: [] });
  assert.equal((await remove(ordinary.f, 'a', 'run_ordinary')).status, 200); assert(!ordinary.f.records.has('a/run_ordinary'));
  const shadow = vm.runInNewContext(functionBlock(file('08-agent-runs.js'), 'agentRunDigestShadow') + '\nagentRunDigestShadow');
  assert.equal(shadow({ historyDeletedAt: 'now' }), null); assert.equal(shadow({ id: 'ordinary', nodes: [] }).id, 'ordinary');
  const list = vm.runInNewContext(functionBlock(file('08-agent-runs.js'), 'listAgentRuns') + '\nlistAgentRuns', {
    agentRunDir: sid => sid, fsp: { readdir: async () => ['run_aa.json', 'run_bb.json'] },
    readAgentRunSnapshot: async (sid, rid) => ({ id: rid, sessionId: sid, nodes: [], ...(rid === 'run_aa' ? { historyDeletedAt: 'now' } : {}) }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await list('a'))).map(row => row.id), ['run_bb']);
  record('ORDINARY_DELETE_AND_HISTORY_PROJECTIONS_PRESERVE_THEIR_CONTRACT', { ordinaryRemoved: true, relayHidden: true });

  const strict = vm.runInNewContext(functionBlock(file('07-autonomy.js'), 'readAgentRunSnapshot') + '\nreadAgentRunSnapshot', {
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    agentRunSnapshotStore: () => ({ read: async () => '{corrupt' }),
  });
  assert.equal(await strict('a', 'run_bad'), null);
  assert.equal((await attempt(() => strict('a', 'run_bad', { strict: true }))).error, 'agent_run.snapshot_invalid');
  const unavailable = await setup('degraded_identity'); const originalRead = unavailable.f.sandbox.readAgentRunSnapshot;
  unavailable.f.sandbox.readAgentRunSnapshot = async (sid, rid, metadata) => {
    if (metadata?.strict && rid.startsWith('run_')) throw Object.assign(Error('synthetic corrupt receipt'), { code: 'agent_run.snapshot_invalid' });
    return originalRead(sid, rid);
  };
  assert.equal((await attempt(() => launch(unavailable.f, unavailable.chain))).error, 'agent_run.snapshot_invalid');
  assert.equal((await remove(unavailable.f, 'a', unavailable.chain.id)).status, 404);
  assert(unavailable.f.records.has('a/' + unavailable.chain.id)); assert.equal(unavailable.f.state.engines, 0);
  record('CORRUPT_IDENTITY_READ_CANNOT_CREATE_OR_ERASE_FRESH_PERMISSION', { controlledDispatches: 0 });
  const absent = await setup('real_missing_snapshot_semantics'), normalRead = absent.f.sandbox.readAgentRunSnapshot;
  absent.f.sandbox.readAgentRunSnapshot = async (sid, rid, metadata) => {
    const value = await normalRead(sid, rid, metadata);
    if (!value) throw Object.assign(Error('missing original snapshot'), { code: 'ENOENT' });
    return value;
  };
  const brandNew = await absent.f.make('new_with_real_enoent'); assert(brandNew.id);
  absent.f.sessions.set('historic', { ...absent.f.value('a'), id: 'historic' });
  assert.equal((await absent.f.relay.completion('historic', absent.f.approval('historic').reference)).status, 'unknown');
  record('REAL_SNAPSHOT_ENOENT_IS_HANDLED_ONLY_AS_ABSENCE', { newContractSaved: true, missingHistoricalCompletion: 'unknown' });

  for (const [phase, receipt, status, expected] of [
    ['not_entered', 'intent', 'failed', 'failed'], ['entering', 'intent', 'stopped', 'unknown'],
    ['entering', 'running', 'stopped', 'unknown'], ['entering', 'unknown', 'failed', 'unknown'],
  ]) {
    const f = await setup('terminal_' + phase + receipt + status); await launch(f.f, f.chain); f.f.live.clear();
    const rid = f.chain.threadRelay.edges[0].runId, run = f.f.records.get('b/' + rid);
    run.status = status; run.error = 'specific original owner reason'; run.threadRelayExecution.entryPhase = phase; run.threadRelayExecution.receipt.status = receipt;
    const view = await f.f.relay.reconcile(await f.f.relay.read('a', f.chain.id));
    assert.equal(view.threadRelay.edges[0].state, expected);
    if (expected === 'failed') {
      assert.equal(view.threadRelay.edges[0].reason, run.error);
      assert.equal((await remove(f.f, 'b', rid)).status, 200);
      const compact = await f.f.relay.reconcile(await f.f.relay.read('a', f.chain.id));
      assert.equal(compact.threadRelay.edges[0].state, 'failed'); assert.equal(compact.threadRelay.edges[0].reason, run.error);
    }
    assert.equal(f.f.state.engines, 0);
    record('ORIGINAL_TERMINAL_' + phase + '_' + receipt + '_' + status, { state: expected, controlledDispatches: 0 });
  }

  const waiting = await setup('original_stop_during_lease'); await launch(waiting.f, waiting.chain);
  let notify; const enteredLease = new Promise(resolve => { notify = resolve; });
  waiting.f.sandbox.acquireResourceLease = async (key, resources, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(Error('lease cancelled'), { code: 'ABORT_ERR' })), { once: true }); notify();
  });
  const controller = new AbortController(), runtime = waiting.f.live.get(waiting.f.admitted().id);
  Object.assign(runtime, { ctrl: controller, resumeWaiters: [], paused: false });
  const pending = attempt(() => waiting.f.relay.execute(waiting.f.admitted(), waiting.f.admitted().nodes[0], controller.signal, () => {})); await enteredLease;
  const command = vm.runInNewContext(functionBlock(file('13d-core-domain-routes.js'), 'agentRunActionCommand') + '\nagentRunActionCommand', {
    activeAgentRuns: waiting.f.live, safeSessionId: waiting.f.sandbox.safeSessionId, nowIso: () => 'now', bumpRunIntervention() {}, appendAgentRunEvent() {}, saveAgentRun: waiting.f.sandbox.saveAgentRun,
  });
  await command({ sessionId: 'b', runId: runtime.run.id, action: 'stop' }); assert((await pending).error); waiting.f.live.clear();
  const stopped = await waiting.f.relay.reconcile(await waiting.f.relay.read('a', waiting.chain.id));
  assert.equal(stopped.threadRelay.edges[0].state, 'stopped'); assert.equal(stopped.threadRelay.edges[0].reason, 'thread_relay.stopped');
  assert.equal(waiting.f.state.engines, 0); assert.equal(waiting.f.records.get('b/' + runtime.run.id).threadRelayExecution.entryPhase, 'not_entered');
  record('ORIGINAL_STOP_AT_LEASE_WAIT_IS_KNOWN_WITHOUT_TARGET_ENTRY', { state: 'stopped', controlledDispatches: 0 });

  for (const at of ['registered', 'dispatch']) {
    const f = await setup('original_stop_' + at); await launch(f.f, f.chain);
    const controller = new AbortController(), runtime = f.f.live.get(f.f.admitted().id);
    Object.assign(runtime, { ctrl: controller, resumeWaiters: [], paused: false });
    const stop = vm.runInNewContext(functionBlock(file('13d-core-domain-routes.js'), 'agentRunActionCommand') + '\nagentRunActionCommand', {
      activeAgentRuns: f.f.live, safeSessionId: f.f.sandbox.safeSessionId, nowIso: () => 'now', bumpRunIntervention() {}, appendAgentRunEvent() {}, saveAgentRun: f.f.sandbox.saveAgentRun,
    });
    const turn = functionBlock(file('10-context-governance.js'), 'runSessionTurn');
    const finallyClause = sliceBlock(turn, "    let deliveryCompletion = { status: 'unknown' };", '    finished = true;');
    f.f.sandbox.SessionExecutionHooks.runTurn = async input => {
      const admission = await input.relayLifecycle.prepareAdmission(); admission.assert();
      const owner = { driverRunId: 'stopped-owner', snapshot: { serverInstanceId: 'r3', driverRunId: 'stopped-owner' }, requestMeta: input.requestMeta };
      f.f.owners.set('b', owner); let turnError = '';
      try {
        await input.relayLifecycle.registered(owner, f.f.config, { ...f.f.value('b') });
        const fence = at === 'dispatch' ? await input.relayLifecycle.beforeDispatch() : null;
        await stop({ sessionId: 'b', runId: runtime.run.id, action: 'stop' });
        if (fence) fence.assert(); else await input.relayLifecycle.beforeDispatch();
        throw Error('stop must refuse before dispatch');
      } catch (error) { turnError = error.code || error.message; }
      finally {
        await vm.runInNewContext('(async()=>{' + finallyClause + '})()', {
          session: f.f.value('b'), settleEntry: owner, storedConfig: f.f.config, lastResult: null, turnError,
          turnStopped: true, source: 'thread_relay', body: { relayLifecycle: input.relayLifecycle }, ThreadRelayHooks: {}, logEvent() {},
        });
        f.f.owners.delete('b');
      }
      return { ok: false, stopped: true, result: null, error: turnError };
    };
    await f.f.relay.execute(f.f.admitted(), f.f.admitted().nodes[0], controller.signal, () => {}); f.f.live.clear();
    const view = await f.f.relay.reconcile(await f.f.relay.read('a', f.chain.id));
    assert.equal(view.threadRelay.edges[0].state, 'stopped'); assert.equal(f.f.state.engines, 0);
    assert.equal(f.f.records.get('b/' + runtime.run.id).threadRelayExecution.entryPhase, 'entering');
    record('ORIGINAL_STOP_WITH_REAL_FINALLY_AT_' + at, { state: 'stopped', controlledDispatches: 0 });
  }

  for (const kind of ['permission', 'question', 'plan', 'replan']) for (const at of ['target-journal', 'afterFence']) {
    const f = await setup('source_pending_' + kind + at); await launch(f.f, f.chain);
    const insert = () => {
      f.f.cache.set('a\0source-pending', { id: 'source-pending', sessionId: 'a', type: kind, status: 'pending' });
      if (kind !== 'replan') f.f.sandbox[kind === 'permission' ? 'pendingPermissions' : kind === 'question' ? 'pendingQuestions' : 'pendingPlans'].set('source-pending', { sessionId: 'a' });
    };
    if (at === 'afterFence') f.f.setInject(phase => { if (phase === 'afterFence') insert(); });
    else { const read = f.f.sandbox.readInterventionsWithMeta; f.f.sandbox.readInterventionsWithMeta = async (sid, options) => { const result = await read(sid, options); if (sid === 'b' && f.f.state.phase === 'dispatch') insert(); return result; }; }
    assert.equal((await attempt(() => execute(f.f))).error, 'thread_relay.decision_pending'); assert.equal(f.f.state.engines, 0);
    record('FINAL_SOURCE_PENDING_' + kind + '_' + at, { controlledDispatches: 0 });
  }
  for (const code of ['EIO', 'work_data_keys.locked']) {
    const f = await setup('final_source_read_' + code.replaceAll('.', '_')); await launch(f.f, f.chain);
    const read = f.f.sandbox.readInterventionsWithMeta;
    f.f.sandbox.readInterventionsWithMeta = async (sid, options) => {
      if (sid === 'a' && f.f.state.phase === 'dispatch') { assert.equal(options?.strict, true); throw Object.assign(Error(code), { code }); }
      return read(sid, options);
    };
    assert.equal((await attempt(() => execute(f.f))).error, code); assert.equal(f.f.state.engines, 0);
    record('FINAL_SOURCE_STRICT_READ_' + code, { controlledDispatches: 0 });
  }
  for (const when of ['privacy', 'final']) {
    const f = await setup('provider_final_source_pending_' + when); await launch(f.f, f.chain);
    const context = vm.runInNewContext(file('03c-model-dispatch-context.js') + '\nModelDispatchContext', { require });
    const permission = file('04-permission-runtime.js');
    const hooks = vm.runInNewContext(sliceBlock(permission, 'SessionExecutionHooks.withDispatchOwner =', '// A logical driver owns')
      + '\n' + functionBlock(permission, 'assertSessionExecutionOwner') + '\nSessionExecutionHooks', {
      require, ModelDispatchContext: context, SessionExecutionHooks: {}, turnSettlers: f.f.owners,
    });
    const insert = () => f.f.cache.set('a\0late-replan', { id: 'late-replan', sessionId: 'a', type: 'replan', status: 'pending' });
    // Keep the text-only provider's actual registration cell alongside its original POST function.
    const post = vm.runInNewContext(constBlock(file('04h-provider-http.js'), 'ProviderMediaHooks') + '\n'
      + functionBlock(file('04h-provider-http.js'), 'providerModelPostOnce') + '\nproviderModelPostOnce', {
      ModelDispatchContext: context, fetch: () => { f.f.state.engines++; return { ok: true }; },
      PrivacyGateway: { active: () => null, withPolicy: (sid, work) => work(), disclosurePolicyGuard: () => () => {}, assertPolicyAvailable() {},
        beforeModelRequest: async body => { if (when === 'privacy') insert(); return body; } },
    });
    f.f.state.dispatch = async (owner, input) => {
      owner.sessionId = 'b'; owner.prepareDispatch = input.relayLifecycle.beforeDispatch;
      const original = hooks.assertDispatch;
      hooks.assertDispatch = (actual, fence) => { if (when === 'final') insert(); return original(actual, fence); };
      await hooks.withDispatchOwner(owner, () => post({ url: 'inert-provider', headers: {}, body: { messages: [] } }));
    };
    assert.equal((await attempt(() => execute(f.f))).error, 'thread_relay.decision_pending'); assert.equal(f.f.state.engines, 0);
    record('REAL_PROVIDER_SOURCE_PENDING_AT_' + when, { controlledDispatches: 0 });
  }
}

(async () => {
  // The real ordinary DELETE endpoint allows deletion of the non-live relay
  // contract; target execution receipt remains. Re-delivery of the same request
  // must not overwrite that receipt and launch the same stable identity again.
  const { f, chain } = await setup('same_click_after_record_delete');
  await launch(f, chain); await execute(f); f.live.clear();
  const firstId = chain.threadRelay.edges[0].runId, firstReceipt = f.records.get('b/' + firstId).threadRelayExecution.receipt;
  assert.equal(firstReceipt.status, 'succeeded');
  const deleteRoute = deletionRoute(f);
  const deleted = await deleteRoute({ method: 'DELETE', url: '/api/agent-runs/' + chain.id + '?sessionId=a' }, {}, '/api/agent-runs/' + chain.id);
  assert.equal(deleted.status, 200); assert.equal(deleted.body.ok, true);
  assert.equal(f.records.get('b/' + firstId).threadRelayExecution.receipt.status, 'succeeded');
  const repeated = await f.make('same_click_after_record_delete');
  assert.equal(repeated.id, chain.id); assert.equal(repeated.threadRelay.edges[0].runId, firstId);
  if (!old) {
    assert.equal((await attempt(() => launch(f, repeated))).error, 'thread_relay.cancelled');
    assert.equal(f.records.get('b/' + firstId).threadRelayExecution.receipt.status, 'succeeded');
    assert(f.records.get('a/' + chain.id).historyDeletedAt);
    assert.equal(f.state.engines, 1);
    record('DELETE_RETIRES_MASTER_AND_PRESERVES_SAME_ID_RECEIPT', { sameRelayId: true, controlledDispatches: 1 });
  } else {
  await launch(f, repeated);
  const overwritten = f.records.get('b/' + firstId).threadRelayExecution.receipt.status;
  assert.equal(overwritten, 'intent');
  await execute(f); f.live.clear();
  assert.equal(f.state.engines, 2);
  record('P1_DELETE_RECREATE_REPLAYS_SAME_EXECUTION_ID', { deleteStatus: deleted.status, sameRelayId: true, sameExecutionId: true,
    receiptBeforeDelete: firstReceipt.status, receiptOverwrittenByRepeatedSubmit: overwritten, controlledDispatches: f.state.engines,
    firstReceiptTurn: firstReceipt.turnSeq, finalReceiptTurn: f.records.get('b/' + firstId).threadRelayExecution.receipt.turnSeq });
  }

  const targetOnly = await setup('target_then_master_delete');
  await launch(targetOnly.f, targetOnly.chain); await execute(targetOnly.f); targetOnly.f.live.clear();
  const targetId = targetOnly.chain.threadRelay.edges[0].runId;
  assert.equal((await remove(targetOnly.f, 'b', targetId)).status, 200);
  const stillSubmitted = await targetOnly.f.relay.submit('a', targetOnly.chain.id, targetOnly.chain.threadRelay.edges[0].id);
  assert.equal(stillSubmitted.threadRelay.edges[0].state, old ? 'unknown' : 'review'); assert.equal(targetOnly.f.state.engines, 1);
  record(old ? 'CONTROL_TARGET_DELETE_ALONE_REMAINS_UNKNOWN_WITHOUT_REPLAY' : 'TARGET_HISTORY_DELETE_REUSES_RECEIPT_WITHOUT_REPLAY', { edgeState: stillSubmitted.threadRelay.edges[0].state, controlledDispatches: 1 });
  assert.equal((await remove(targetOnly.f, 'a', targetOnly.chain.id)).status, 200);
  const neitherReceipt = await targetOnly.f.make('target_then_master_delete');
  assert.equal(neitherReceipt.threadRelay.edges[0].runId, targetId);
  if (!old) {
    assert.equal((await attempt(() => launch(targetOnly.f, neitherReceipt))).error, 'thread_relay.cancelled');
    assert(targetOnly.f.records.get('b/' + targetId).historyDeletedAt);
    assert.equal(targetOnly.f.records.get('b/' + targetId).threadRelayExecution.receipt.status, 'succeeded');
    assert.equal(targetOnly.f.state.engines, 1);
    record('BOTH_DELETE_RETAIN_ORIGINAL_M3_IDENTITIES_WITHOUT_REPLAY', { sameExecutionId: true, controlledDispatches: 1 });
  } else {
  await launch(targetOnly.f, neitherReceipt); await execute(targetOnly.f); targetOnly.f.live.clear();
  assert.equal(targetOnly.f.state.engines, 2);
  record('P1_BOTH_RECORDS_DELETE_REPLAYS_SAME_EXECUTION_ID', { sameExecutionId: true, controlledDispatches: 2,
    note: 'record absence is not proof this identity was never submitted' });
  }

  // A lost submit acknowledgement without record deletion is already safe.
  const ack = await setup('lost_master_ack');
  const saveAck = ack.f.sandbox.saveAgentRun, launchAck = ack.f.sandbox.launchPersistedAgentRun;
  let submittedMasterSaves = 0, launchCount = 0;
  ack.f.sandbox.saveAgentRun = async run => {
    if (run.kind === 'thread_relay' && run.threadRelay.edges[0].submittedAt && ++submittedMasterSaves === 2) throw Object.assign(Error('synthetic ACK save failure'), { code: 'EIO' });
    return saveAck(run);
  };
  ack.f.sandbox.launchPersistedAgentRun = async input => { launchCount++; return launchAck(input); };
  assert.equal((await attempt(() => launch(ack.f, ack.chain))).error, 'EIO');
  await launch(ack.f, ack.chain); assert.equal(launchCount, 1);
  await execute(ack.f); ack.f.live.clear();
  const afterAck = await ack.f.relay.submit('a', ack.chain.id, ack.chain.threadRelay.edges[0].id);
  assert.equal(afterAck.threadRelay.edges[0].state, 'review'); assert.equal(launchCount, 1);
  record('CONTROL_LOST_ACK_REUSES_DURABLE_INTENT_AND_TARGET_RECEIPT', { launchCount, edgeState: afterAck.threadRelay.edges[0].state });

  // Check the precise gap in lazy pending-entry binding. This is a domain
  // invariant counterexample; public generators normally allocate random IDs.
  const g = (await setup('pending_first_binding')).f;
  const gChain = await g.make('pending_first_binding'); await launch(g, gChain);
  let oldEntry, replacement;
  g.setInject((at, input, owner) => {
    if (at !== 'dispatch') return;
    g.change('own-pending', input, owner);
    oldEntry = g.sandbox.pendingPermissions.get('owned-request');
    replacement = { sessionId: 'b', origin: 'different-entry-before-first-proof-bind' };
    g.sandbox.pendingPermissions.set('owned-request', replacement);
  });
  const gResult = await execute(g);
  assert.notEqual(oldEntry, replacement); assert.equal(gResult.ok, true); assert.equal(g.state.engines, 1);
  record('INVARIANT_PENDING_ENTRY_IS_FIRST_BOUND_AFTER_REPLACEMENT', { differentEntryAtFirstCheck: true, controlledDispatches: g.state.engines,
    status: g.admitted().threadRelayExecution.receipt.status, limitation: 'domain invariant; actual request generators use makeId, no public same-ID replacement path established' });

  // Positive control: an entry replaced AFTER it was first bound is rejected.
  const h = (await setup('pending_after_binding')).f;
  const hChain = await h.make('pending_after_binding'); await launch(h, hChain);
  h.setInject((at, input, owner) => {
    if (at === 'dispatch') { h.change('own-pending', input, owner); h.state.phase = 'dispatch-read'; }
    else if (!at && !h.state.injected) { h.state.injected = true; h.sandbox.pendingPermissions.set('owned-request', { sessionId: 'b' }); }
  });
  const hResult = await attempt(() => execute(h)); assert(hResult.error); assert.equal(h.state.engines, 0);
  record('CONTROL_PENDING_REPLACEMENT_AFTER_BINDING_REJECTED', { error: hResult.error, controlledDispatches: h.state.engines });

  // Do not infer a product failure from a VM hook missing runSessionTurn's real
  // try/finally. The real finally settles a known pre-dispatch refusal as failed.
  const turn = functionBlock(file('10-context-governance.js'), 'runSessionTurn');
  const finalClause = sliceBlock(turn, "    let deliveryCompletion = { status: 'unknown' };", '    finished = true;');
  assert(finalClause.includes('await body.relayLifecycle.settled'));
  const k = (await setup('known_refusal_finally')).f;
  const kChain = await k.make('known_refusal_finally'); await launch(k, kChain);
  k.sandbox.SessionExecutionHooks.runTurn = async input => {
    const admission = await input.relayLifecycle.prepareAdmission(); admission.assert();
    const owner = { driverRunId: 'known-refusal-owner', snapshot: { serverInstanceId: 'review-r2', driverRunId: 'known-refusal-owner' }, requestMeta: input.requestMeta };
    k.owners.set('b', owner);
    let turnError = '';
    try {
      await input.relayLifecycle.registered(owner, k.config, { ...k.value('b') });
      k.change('pending');
      const fence = await input.relayLifecycle.beforeDispatch(); fence.assert();
      throw Error('the pending guard should have refused');
    } catch (error) { turnError = error.message; }
    finally {
      await vm.runInNewContext('(async()=>{' + finalClause + '})()', {
        session: k.value('b'), settleEntry: owner, storedConfig: k.config, lastResult: null, turnError,
        turnStopped: false, source: 'thread_relay', body: { relayLifecycle: input.relayLifecycle }, ThreadRelayHooks: {}, logEvent() {},
      });
      k.owners.delete('b'); k.journal.clear(); k.cache.clear(); k.sandbox.pendingPermissions.clear();
    }
    return { ok: false, stopped: false, result: null, error: turnError };
  };
  const kResult = await execute(k); k.live.clear();
  const reconciled = await k.relay.reconcile(await k.relay.read('a', kChain.id));
  assert.equal(kResult.ok, false); assert.equal(reconciled.threadRelay.edges[0].state, 'failed');
  assert.equal(reconciled.threadRelay.edges[0].reason, 'thread_relay.decision_pending');
  record('CONTROL_REAL_FINALLY_PERSISTS_KNOWN_REFUSAL', { state: reconciled.threadRelay.edges[0].state, reason: reconciled.threadRelay.edges[0].reason });

  // Cancellation is durable before late receipts and does not reopen the chain.
  const j = (await setup('cancel_late_success')).f;
  const jChain = await j.make('cancel_late_success'); await launch(j, jChain);
  await j.relay.cancel({ sessionId: 'a', relayId: jChain.id });
  const jId = jChain.threadRelay.edges[0].runId;
  j.records.get('b/' + jId).threadRelayExecution.receipt = { identity: jId, status: 'succeeded', turnSeq: 2 };
  j.live.clear();
  const late = await j.relay.reconcile(await j.relay.read('a', jChain.id));
  assert.equal(late.threadRelay.cancelled, true); assert.equal(late.threadRelay.edges[0].state, 'cancelled');
  assert.equal((await attempt(() => launch(j, late))).error, 'thread_relay.cancelled');
  record('CONTROL_CANCELLED_CHAIN_REJECTS_LATE_SUCCESS_REPLAY', { cancelled: true, edgeState: late.threadRelay.edges[0].state });

  // A normal workflow Stop before its only node is dispatched never enters
  // runSessionTurn. Its authenticated run snapshot has a known stopped status,
  // but reconcile ignores that original owner's terminal fact and shows unknown.
  const stopped = await setup('ordinary_control_stop_before_dispatch'); await launch(stopped.f, stopped.chain);
  const stoppedId = stopped.chain.threadRelay.edges[0].runId, runtime = stopped.f.live.get(stoppedId);
  Object.assign(runtime, { ctrl: new AbortController(), resumeWaiters: [], paused: false });
  const command = vm.runInNewContext(functionBlock(file('13d-core-domain-routes.js'), 'agentRunActionCommand') + '\nagentRunActionCommand', {
    activeAgentRuns: stopped.f.live, safeSessionId: stopped.f.sandbox.safeSessionId, nowIso: () => '2026-10-30T00:00:00Z',
    bumpRunIntervention() {}, appendAgentRunEvent() {}, saveAgentRun: stopped.f.sandbox.saveAgentRun,
  });
  const stopResponse = await command({ sessionId: 'b', runId: stoppedId, action: 'stop' });
  assert.equal(stopResponse.body.state, 'stopping'); assert.equal(runtime.stopRequested, true); assert.equal(runtime.ctrl.signal.aborted, true);
  const statusClause = sliceBlock(file('09-workflow.js'), '  const failed = nodes.filter(n => n.status !==', '  run.completedAt =');
  assert(statusClause.includes("run.status = (runtime.stopRequested || parentStopped) ? 'stopped'"));
  vm.runInNewContext(statusClause, { runtime, parentStopped: false, nodes: runtime.run.nodes, run: runtime.run });
  await stopped.f.sandbox.saveAgentRun(runtime.run); stopped.f.live.delete(stoppedId);
  const stoppedView = await stopped.f.relay.reconcile(await stopped.f.relay.read('a', stopped.chain.id));
  assert.equal(runtime.run.status, 'stopped'); assert.equal(runtime.run.threadRelayExecution.receipt.status, 'intent');
  assert.equal(stoppedView.threadRelay.edges[0].state, old ? 'unknown' : 'stopped');
  if (!old) assert.equal(stoppedView.threadRelay.edges[0].reason, 'thread_relay.stopped'); assert.equal(stopped.f.state.engines, 0);
  record(old ? 'P2_KNOWN_PRE_DISPATCH_STOP_IS_REPORTED_UNKNOWN' : 'ORIGINAL_PRE_DISPATCH_STOP_HAS_TERMINAL_REASON', { normalControlState: stopResponse.body.state,
    persistedOriginalWorkflowStatus: runtime.run.status, executionReceipt: runtime.run.threadRelayExecution.receipt.status,
    relayView: stoppedView.threadRelay.edges[0].state, relayReason: stoppedView.threadRelay.edges[0].reason || '', controlledDispatches: 0 });
  if (!old) {
    assert.equal((await remove(stopped.f, 'b', stoppedId)).status, 200);
    const compactStop = await stopped.f.relay.reconcile(await stopped.f.relay.read('a', stopped.chain.id));
    assert.equal(compactStop.threadRelay.edges[0].state, 'stopped'); assert.equal(compactStop.threadRelay.edges[0].reason, 'thread_relay.stopped');
    record('RETIRED_STOP_PRESERVES_ORIGINAL_TERMINAL_REASON', { state: 'stopped', reason: 'thread_relay.stopped' });
  }

  // Source admission still uses the legacy best-effort read, unlike targetGate.
  // Exercise the REAL intervention reader and registration owner: a pending
  // source replan remains in its authoritative cache while its journal is EIO.
  const io = fixture(); await io.seed('a'); await io.seed('b'); await io.seed('c');
  const sessionStore = file('02-session-store.js');
  const intervention = vm.runInNewContext(functionBlock(sessionStore, 'foldInterventionJournalText') + '\n'
    + functionBlock(sessionStore, 'readInterventionsWithMeta') + '\n' + functionBlock(sessionStore, 'registerIntervention')
    + '\n({readInterventionsWithMeta,registerIntervention})', {
    Buffer, interventionWriteChains: new Map(), interventionRecordCache: io.cache, ivCacheKey: (sid, id) => sid + '\0' + id,
    nowIso: () => '2026-10-30T00:00:00Z', RUYI_EVENTS: { emit() {} }, appendIntervention: async () => true, bumpMissionChangeSeq: async () => {},
    interventionFilePath: sid => sid, decodeSessionJournalText: async (sid, kind, text) => text,
    fsp: { readFile: async sid => { if (sid === 'a') throw Object.assign(Error('synthetic source journal unreadable'), { code: 'EIO' }); return ''; } },
  });
  intervention.registerIntervention('a', 'replan', 'pending-source-replan', { runId: 'already-finished-background-run' });
  assert.equal([...io.cache.values()][0].status, 'pending');
  assert.equal((await attempt(() => intervention.readInterventionsWithMeta('a', { strict: true }))).error, 'EIO');
  io.sandbox.readInterventionsWithMeta = intervention.readInterventionsWithMeta;
  if (!old) {
    assert.equal((await attempt(() => io.make('source_journal_eio'))).error, 'thread_relay.decision_pending');
    assert.equal(io.state.engines, 0);
    io.cache.clear();
    assert.equal((await attempt(() => io.make('source_journal_eio_no_cache'))).error, 'EIO');
    record('SOURCE_PENDING_AND_STRICT_JOURNAL_ERROR_BOTH_BLOCK', { controlledDispatches: 0, strictReaderRejects: 'EIO' });
  } else {
  const ioChain = await io.make('source_journal_eio'); await launch(io, ioChain);
  let sourceStillPendingAtDispatch = false;
  io.state.dispatch = async () => { sourceStillPendingAtDispatch = [...io.cache.values()].some(row => row.sessionId === 'a' && row.status === 'pending'); io.state.engines++; };
  const ioResult = await execute(io); assert.equal(ioResult.ok, true); assert.equal(io.state.engines, 1);
  assert(sourceStillPendingAtDispatch);
  record('P2_SOURCE_PENDING_JOURNAL_EIO_IS_TREATED_AS_EMPTY', { pendingSourceIntervention: 'replan', sourceStillPendingAtDispatch,
    strictReaderRejects: 'EIO', relayAcceptedAndDispatched: ioResult.ok, controlledDispatches: io.state.engines });
  }

  if (!old) await additional();
  const evidence = path.join(root, 'runtime/m5-existing-thread-relay-r3-20261030'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, old ? 'r2-observations.json' : 'r3-observations.json'), JSON.stringify({ schema: 1, scope: 'real source slices with inert storage/turn/route adapters', observations }, null, 2) + '\n');
  process.stdout.write((old ? 'THREAD RELAY R3 R2 NEGATIVE E2E: ALL PASS\n' : 'THREAD RELAY R3 E2E: ALL PASS\n'));
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
