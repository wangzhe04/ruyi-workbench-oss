'use strict';
// Combined original turn/relay/permission/metadata owners in one VM. The engine
// boundary is an inert in-memory adapter: no server, HTTP, model, CLI or timer.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { constBlock, functionBlock, sliceBlock } = require('./lib/source-slice');
const { createRunner } = require('./lib/harness');
const t = createRunner('WORKFLOW COMBINATION STATIC'), src = path.resolve(__dirname, '../ruyi-workbench/app/src');
const baselineFlag = process.argv.find(value => value.startsWith('--baseline-root=')), baseline = Boolean(baselineFlag);
const read = name => fs.readFileSync(path.join(baseline && name === '10-context-governance.js' ? path.resolve(baselineFlag.slice('--baseline-root='.length), 'ruyi-workbench/app/src') : src, name), 'utf8'), clone = value => JSON.parse(JSON.stringify(value));
const fixtureFile = path.join(__dirname, 'thread-relay-admission.static.e2e.js'), fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const relayFixture = vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\n(async () => {')) + '\nfixture', {
  require: createRequire(fixtureFile), __dirname, Buffer, URL, process: { argv: [], env: {} },
});
async function combined() {
  const f = relayFixture(); for (const id of ['a', 'b', 'c']) await f.seed(id);
  const box = f.sandbox, order = [], engineOwners = [], publications = [], authorities = [];
  let ids = 0, beforeEngine = () => {}, admission = async () => true;
  const writeRun = box.saveAgentRun;
  box.saveAgentRun = async run => { if (run.threadRelayExecution?.receipt?.status === 'running') order.push('relay-registered'); return writeRun(run); };
  Object.assign(box, { require, AbortController, turnOutcomePending: new Map(), sessionLastExecutions: new Map(), sessionExecutionEvictionGeneration: 0, OVERLAY_ID: 'combined-vm',
    SessionExecutionHooks: {}, ThreadRelayHooks: { captureTurn: async args => { order.push('capture:' + args.owner.source); return f.relay.captureTurn(args); } },
    SchedulerHooks: { sessionTurnAdmission: async head => { order.push('schedule-admission:' + box.turnSettlers.get(head.id)?.source); return admission(head); } },
    sessionEngineRouteScopeOverrides: new Map(), agentWakeChain: new Map(), agentWakeSuppressed: new Set(), activeDriverRuns: new Map(), driverAutoSessions: new Set(),
    AGENT_WAKE_SOURCE: 'agent_wake', EXCLUSIVE_TURN_SOURCES: new Set(['scheduler', 'agent_wake', 'thread_relay']), STEWARD_SESSION_ID: 'steward',
    configForSessionEngineRoute: config => config, inferSessionEngineRoute: () => ({ engine: 'openai', providerId: 'inert' }),
    sessionEngineRouteFromConfig: () => null, rememberLastUsedEngineRoute() {}, activeOpenAiProvider: () => ({ id: 'inert' }), sessionMessagesStamp: () => 'inert-transport-stamp',
    makeId: prefix => prefix + '_' + ++ids, bindDriverRun: (sid, id) => box.activeDriverRuns.set(sid, id), revokeGrantsForRun() {},
    nowIso: () => '2026-10-30T12:00:00Z', EventStreamHooks: {}, sessionMissionId: s => s.missionId,
    maybeWriteThreadBrief() { throw Error('unexpected first-turn auxiliary execution'); }, settleThreadBrief() {}, logEvent() {},
    runClaudeTurn() { throw Error('no CLI capability'); }, runMissionDriver() { throw Error('no mission driver capability'); },
    updateSessionMeta: async (sid, patch, options) => {
      order.push('publish:' + (patch.stewardLastTurn?.scheduler?.state || 'ordinary'));
      const head = f.value(sid); box.applySessionMetaPatch(head, patch, options); publications.push({ sid, patch: clone(patch), options: clone(options || {}) }); return clone(head);
    },
    runOpenAiTurn: async args => {
      // This adapter does no model/tool work. Production runSessionTurn owns all
      // admission, lifecycle, result sampling and finally calls around it.
      beforeEngine(args); box.assertSessionExecutionOwner(args.session.id, args.executionOwner);
      order.push('inert-boundary:' + args.executionOwner.source); engineOwners.push(args.executionOwner);
      args.session.turnSeq++; args.session.content = 'inert completed ' + args.session.id;
      box.sessionStampSchedulerTurn(args.session, args.executionOwner); f.sessions.set(args.session.id, clone(args.session));
      args.onEvent({ type: 'result', ok: true });
    },
  });
  Object.assign(box.PrivacyGateway, { enabled: () => false });
  const runtime = read('04-permission-runtime.js'), store = read('02-session-store.js');
  const code = read('01e-permission-modes.js') + '\n' + read('03c-model-dispatch-context.js')
    + '\n' + ['recordSessionExecutionOwner', 'sessionExecutionSnapshot', 'assertSessionExecutionOwner', 'revalidateSessionExecutionPermission'].map(n => functionBlock(runtime, n)).join('\n')
    + '\n' + sliceBlock(runtime, 'SessionExecutionHooks.withDispatchOwner =', '// A logical driver owns')
    + '\n' + ['sessionTodosSignature', 'sessionSchedulerTurnReceipt', 'sessionSchedulerTurnMatches', 'sessionStampSchedulerTurn', 'applySessionMetaPatch'].map(n => functionBlock(store, n)).join('\n')
    + '\n' + constBlock(read('06i-steward-core.js'), 'STEWARD_PERMISSION_RANK') + '\n' + functionBlock(read('06i-steward-core.js'), 'stewardPermissionRank')
    + '\n' + functionBlock(read('13s-scheduler.js'), 'schedulerPermissionModeFor') + '\n' + functionBlock(read('13s-scheduler.js'), 'schedulerTurnOutcome')
    + '\n' + functionBlock(read('10-context-governance.js'), 'runSessionTurn') + '\nSessionExecutionHooks.runTurn=runSessionTurn;';
  vm.runInNewContext(code, box, { timeout: 1000 });
  return { f, box, order, engineOwners, publications, authorities, setBefore: fn => { beforeEngine = fn; }, setAdmission: fn => { admission = fn; } };
}
async function relayControls() {
  const c = await combined(), { f, box, order } = c;
  const original = box.ThreadRelayHooks.captureTurn;
  box.ThreadRelayHooks.captureTurn = async args => { assert.equal(box.turnSettlers.get(args.session.id), args.owner); return original(args); };
  c.setBefore(args => { assert.equal(args.executionOwner.sessionId, 'b'); assert.equal(args.executionOwner.authority, null); assert.equal(args.executionOwner.turnSeqAtStart, 1); });
  const chain = await f.make('combined_original_owner'); await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id);
  const run = f.admitted(); const result = await f.relay.execute(run, run.nodes[0], new AbortController().signal, () => {});
  assert.equal(result.ok, true); assert.equal(c.engineOwners.length, 1); assert.equal(run.threadRelayExecution.receipt.status, 'succeeded');
  assert.deepEqual(order, ['relay-registered', 'schedule-admission:thread_relay', 'inert-boundary:thread_relay', 'capture:thread_relay']);
  assert.equal(f.owners.size, 0); assert.equal(box.activeDriverRuns.size, 0); assert.equal(box.turnOutcomePending.size, 0);
  t.ok(true, 'real runSessionTurn admits W B once through the original owner, scheduler admission, completion and relay settlement');
  // This fixture runs the real turn and relay executor, while the outer workflow
  // reducer is inert. Release only its original synthetic registration now.
  f.live.delete(run.id); run.status = 'succeeded';
  const cSource = await f.relay.create({ sessionId: 'b', requestId: 'combined_B_source', source: f.approval('b'), targets: [{ sessionId: 'c', task: 'Continue' }] });
  assert.equal(cSource.threadRelay.edges[0].source.sessionId, 'b');
  t.ok(true, 'B trusted completion from the shared full turn owner becomes an admissible W source');
  for (const fault of ['admission-read', 'late-stop']) {
    const q = await combined(); if (fault === 'admission-read') q.setAdmission(async () => { throw Object.assign(Error('owned history unavailable'), { code: 'EIO' }); });
    else q.setBefore(args => { args.executionOwner.cancel('stopped'); });
    const chain = await q.f.make('combined_' + fault); await q.f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id); const run = q.f.admitted();
    const result = await q.f.relay.execute(run, run.nodes[0], new AbortController().signal, () => {});
    assert.equal(result.ok, false); assert.equal(q.engineOwners.length, 0); assert.notEqual(run.threadRelayExecution.receipt.status, 'succeeded'); assert.equal(q.f.owners.size, 0);
    t.ok(true, fault + ' rejects before the inert boundary and unwinds the same W/T owner');
  }
}
async function schedulerAndPublicControls() {
  const c = await combined(), { f, box } = c, requestMeta = { taskId: 'sch_shared', runId: 'run_shared', occurrenceKey: 'sch_shared@2026-10-30T12:00:00Z' };
  let checks = 0, refreshes = 0; const authority = { assertCurrent() { checks++; }, async revalidate() { refreshes++; } };
  const cap = box.schedulerPermissionModeFor({ autonomy: { permissionMode: 'auto' } }, { permissionMode: 'auto' }, { autonomy: { permissionMode: 'plan' } }); assert.equal(cap, 'plan');
  c.setBefore(args => { assert.equal(args.executionOwner.authority, authority); assert.equal(args.config.permissionMode, 'plan'); });
  const result = await box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'scheduler', requestMeta, permissionMode: cap, executionAuthority: authority,
    schedulerOutcome: turn => ({ ...box.schedulerTurnOutcome(turn).patch, scheduler: { ...requestMeta, state: 'settled' } }) });
  assert.equal(result.ok, true); assert.ok(checks >= 3); assert.equal(refreshes, 1); assert.equal(c.publications.at(-1).options.waitForCommit, true);
  assert.equal(f.value('b').stewardLastTurn.scheduler.state, 'settled'); assert.equal(f.owners.size, 0); assert.equal(box.turnOutcomePending.size, 0);
  assert.deepEqual(c.order, ['inert-boundary:scheduler', 'capture:scheduler', 'publish:settled']);
  t.ok(true, 'scheduler uses the same turn owner with the live permission cap, private pending stamp and awaited final publication');
  const old = clone(f.value('b')), receipt = clone(old.stewardLastTurn), completions = f.records.size;
  assert.throws(() => box.applySessionMetaPatch(f.value('b'), { stewardLastTurn: { seq: 99, ok: true, scheduler: requestMeta } }, { external: true }), e => e.code === 'SESSION_METADATA_INTERNAL');
  box.applySessionMetaPatch(f.value('b'), { threadRelay: {}, threadRelayExecution: {}, deliveryCompletion: {} }, { external: true });
  assert.deepEqual(clone(f.value('b')), old); assert.equal(f.records.size, completions);
  t.ok(true, 'public JSON cannot forge scheduler or relay completion facts or erase the existing private receipt');
  c.setBefore(args => { assert.equal(args.executionOwner.authority, null); assert.equal(args.config.permissionMode, 'auto'); });
  const ordinary = await box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'http', executionAuthority: authority });
  for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary)); assert.equal(refreshes, 1); assert.equal(c.engineOwners.at(-1).source, 'http'); assert.equal(c.engineOwners.at(-1).authority, null);
  assert.equal(f.value('b').stewardLastTurn.seq, receipt.seq + 1); assert.equal(f.value('b').stewardLastTurn.scheduler, undefined); assert.equal(box.turnOutcomePending.size, 0);
  const next = await f.relay.create({ sessionId: 'b', requestId: 'ordinary_after_scheduled', source: f.approval('b'), targets: [{ sessionId: 'c', task: 'Next' }] });
  assert.equal(next.threadRelay.edges[0].source.sessionId, 'b');
  t.ok(true, 'a later ordinary owner retains its own mode and completion; an older scheduled receipt does not contaminate W source admission');
}
async function noAdvanceControls() {
  const c = await combined(), { f, box } = c;
  const first = await box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'http' });
  assert.equal(first.ok, true); assert.equal(first.turnSeq, 2);
  const reference = f.approval('b').reference, trusted = clone(await f.relay.completion('b', reference)); assert.equal(trusted.status, 'succeeded');
  const oldHead = clone(f.value('b')), records = JSON.stringify([...f.records]), published = c.publications.length;
  box.activeOpenAiProvider = () => null;
  const failed = await box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'http', onEvent: event => { if (event.type === 'error') c.order.push('missing-provider-error'); } });
  for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(failed.ok, false); assert.match(failed.error, /Provider/); assert.equal(failed.turnSeq, 2); assert.equal(c.engineOwners.length, 1);
  assert.ok(c.order.includes('missing-provider-error')); assert.equal(f.owners.size, 0);
  const after = clone(await f.relay.completion('b', reference));
  if (baseline) {
    assert.equal(after.status, 'unknown'); assert.notEqual(JSON.stringify([...f.records]), records);
    assert.equal(f.value('b').stewardLastTurn.ok, false); assert.equal(f.value('b').stewardLastTurn.seq, 2);
    t.ok(true, 'expected RED: real missing-provider guard, engine0 for attempt, overwrites prior trusted success2 with unknown and failed2');
  } else {
    assert.deepEqual(after, trusted); assert.equal(JSON.stringify([...f.records]), records); assert.deepEqual(clone(f.value('b')), oldHead); assert.equal(c.publications.length, published);
    await f.relay.create({ sessionId: 'b', requestId: 'prior_success_retained', source: f.approval('b'), targets: [{ sessionId: 'c', task: 'Still trusted' }] });
    t.ok(true, 'failed ordinary attempt with no real sequence advance reports its error and preserves the prior trusted W completion and source admission');
  }
  const advanced = await combined(); advanced.setBefore(args => { args.session.turnSeq++; advanced.f.sessions.set(args.session.id, clone(args.session)); throw Error('inert failure after real head advance'); });
  const genuine = await advanced.box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'http' }); for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(genuine.ok, false); assert.equal(genuine.turnSeq, 2); assert.equal(advanced.f.value('b').stewardLastTurn.seq, 2); assert.equal(advanced.f.value('b').stewardLastTurn.ok, false);
  t.ok(true, 'an actual turnSeq advance still publishes its new failure and cannot reuse the old trusted success');
}
async function actualRelayBoundaryControls() {
  // The actual HTTP fixture used a pre-acceptance placeholder for C. Exercise
  // original acceptance, registry readers and DELETE, keeping storage inert.
  const c = await combined(), { f, box } = c, routeSource = read('13d-core-domain-routes.js');
  const retirementFile = path.join(__dirname, 'thread-relay-retirement.static.e2e.js');
  const retirementSource = fs.readFileSync(retirementFile, 'utf8');
  const deleteRoute = vm.runInNewContext(retirementSource.slice(0, retirementSource.indexOf('\n(async () => {')) + '\ndeletionRoute', {
    require: createRequire(retirementFile), __dirname, Buffer, URL, process: { argv: [], env: {} },
  })(f);
  const remove = (sid, rid) => deleteRoute({ method: 'DELETE', url: '/api/agent-runs/' + rid + '?sessionId=' + sid }, {}, '/api/agent-runs/' + rid);
  box.buildAgentRunEnvelope = run => ({ runId: run.id, status: run.status }); // Only envelope content is inert; live comes from the original reader.
  box.waitAgentsMaxMs = () => 300000;
  vm.runInNewContext(constBlock(read('09-workflow.js'), 'AGENT_RUN_TERMINAL') + '\n'
    + functionBlock(read('08-agent-runs.js'), 'readAgentRunRecord') + '\n'
    + functionBlock(read('09-workflow.js'), 'waitForAgentRunResults') + '\n'
    + functionBlock(read('04-permission-runtime.js'), 'sessionExecutionObservation'), box);
  const publicLive = vm.runInNewContext(functionBlock(routeSource, 'sessionEnvelopeLiveParts') + '\nsessionEnvelopeLiveParts', box);
  const chain = await f.make('actual_current_accepted_identity'), first = chain.threadRelay.edges[0], placeholder = clone(chain.threadRelay.edges[1]);
  await f.relay.submit('a', chain.id, first.id); let run = f.admitted();
  await f.relay.execute(run, run.nodes[0], new AbortController().signal, () => {});
  assert.equal((await f.relay.reconcile(await f.relay.read('a', chain.id))).threadRelay.edges[0].state, 'running');
  assert.equal((await remove('b', first.runId)).status, 409); assert.equal(publicLive('b').live, true);
  f.live.delete(run.id); run.status = 'succeeded';
  assert.equal((await f.relay.reconcile(await f.relay.read('a', chain.id))).threadRelay.edges[0].state, 'review');
  assert.equal(publicLive('b').live, false); assert.equal(publicLive('b').execution, null);
  t.ok(true, 'original registry keeps a successful relay running and DELETE blocked until its public live owner releases');
  const accepted = await f.relay.accept({ sessionId: 'a', relayId: chain.id, edgeId: first.id, source: f.approval('b') });
  const next = accepted.threadRelay.edges[1];
  assert.equal(next.id, placeholder.id); assert.notEqual(next.runId, placeholder.runId);
  assert.equal(next.source.sessionId, 'b'); assert.equal(next.source.reference.turnSeq, 2);
  await f.relay.submit('a', chain.id, next.id); run = f.admitted();
  assert.equal(run.id, next.runId); await f.relay.execute(run, run.nodes[0], new AbortController().signal, () => {});
  f.live.delete(run.id); run.status = 'succeeded';
  const current = await f.relay.reconcile(await f.relay.read('a', chain.id));
  assert.equal(current.threadRelay.edges[1].state, 'review'); assert.equal(current.threadRelay.edges[1].runId, next.runId);
  assert.equal((await remove('c', placeholder.runId)).status, 404);
  assert.equal((await remove('b', first.runId)).status, 200); assert.equal((await remove('a', chain.id)).status, 200);
  assert.equal((await remove('c', next.runId)).status, 200);
  t.ok(true, 'accepted B binds the stable C edge to its current execution identity; old placeholder DELETE is 404 and all three current history rows delete with 200');
  await assert.rejects(() => f.relay.submit('a', chain.id, next.id), e => e.code === 'thread_relay.cancelled');
  assert.equal(c.engineOwners.length, 2); assert.equal((await f.relay.read('a', chain.id)).threadRelay.edges[1].runId, next.runId);
  t.ok(true, 'a submitted C identity survives retirement and cancellation cannot dispatch it again');

  // Hold the original trusted completion write after its engine result. The real
  // HTTP shell must not end until runSessionTurn finishes publication/ownership.
  const h = await combined(), events = [], source = h.f.approval('a');
  let entered, release; const atWrite = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const store = h.box.agentRunSnapshotStore;
  h.box.agentRunSnapshotStore = (sid, rid) => { const target = store(sid, rid); return { write: async text => {
    if (sid === 'a' && JSON.parse(text).kind === 'thread_delivery_completion') { entered(); await gate; }
    return target.write(text);
  } }; };
  const req = { socket: { setNoDelay() {} }, on() {} }, res = { writableEnded: false, destroyed: false,
    writeHead() {}, flushHeaders() {}, on() {}, write(text) { events.push(JSON.parse(text)); }, end() { this.writableEnded = true; } };
  h.box.readJsonBody = async () => ({ sessionId: 'a', message: 'second source', cwd: h.f.value('a').cwd });
  h.box.PrivacyGateway.createDisplayStream = (sid, write) => ({ write: async event => write(event), flush: async () => {}, close() {} });
  const shell = vm.runInNewContext(functionBlock(read('10-context-governance.js'), 'streamChat') + '\nstreamChat', h.box);
  const running = shell(req, res);
  await Promise.race([atWrite, running.then(() => { throw Error('HTTP shell ended before completion write: ' + JSON.stringify({ events, order: h.order })); })]);
  assert.ok(events.some(row => row.type === 'result')); assert.equal(res.writableEnded, false);
  assert.ok(h.box.sessionExecutionSnapshot('a')); assert.equal((await h.f.relay.completion('a', source.reference)).status, 'succeeded');
  release(); await running;
  assert.equal(res.writableEnded, true); assert.equal(h.box.sessionExecutionSnapshot('a'), null);
  assert.equal((await h.f.relay.completion('a', h.f.approval('a').reference)).status, 'succeeded');
  t.ok(true, 'real HTTP shell result can precede trusted publication, while transport end waits for publication and the original turn owner release');

  for (const change of ['next-turn', 'same-turn-text', 'same-turn-file']) {
    const q = await combined(), prior = q.f.approval('a'), pending = await q.f.make('changed_source_' + change);
    const project = q.box.StewardHooks.deliveryProjection;
    let changedFile = false;
    q.box.StewardHooks.deliveryProjection = async (...args) => { const value = await project(...args); return changedFile ? { ...value, fileStamp: 'f'.repeat(64) } : value; };
    // Real revision validator, using the fixture's inert projection I/O.
    q.box.StewardHooks.validateDeliveryReference = vm.runInNewContext(functionBlock(read('13aa-steward-delivery.js'), 'stewardValidateDeliveryReference') + '\nstewardValidateDeliveryReference', {
      stewardDeliveryProjection: (...args) => q.box.StewardHooks.deliveryProjection(...args), stewardFail: error => ({ ok: false, error }),
    });
    if (change === 'next-turn') await q.box.SessionExecutionHooks.runTurn({ sessionId: 'a', source: 'http' });
    else {
      if (change === 'same-turn-text') q.f.value('a').content = 'edited same source turn'; else changedFile = true;
      const owner = { driverRunId: 'new_source_fact', snapshot: { serverInstanceId: 'new_source', driverRunId: 'new_source_fact' } };
      q.f.owners.set('a', owner);
      await q.f.relay.captureTurn({ session: clone(q.f.value('a')), owner, config: q.f.config, result: { ok: true } });
      q.f.owners.delete('a');
    }
    assert.equal((await q.f.relay.completion('a', prior.reference)).status, 'unknown');
    const before = q.engineOwners.length;
    await assert.rejects(() => q.f.relay.submit('a', pending.id, pending.threadRelay.edges[0].id), e => e.code === 'thread_relay.source_changed');
    assert.equal(q.engineOwners.length, before); assert.equal(q.f.admitted(), undefined);
    assert.equal((await q.f.relay.read('a', pending.id)).threadRelay.edges[0].submittedAt, undefined);
    t.ok(true, change + ' source change reports exact revalidation code before a missing old single-slot completion, with no target intent/dispatch');
  }
  const missing = await combined();
  for (const [key, value] of missing.f.records) if (value.kind === 'thread_delivery_completion' && value.sessionId === 'a') missing.f.records.delete(key);
  await assert.rejects(() => missing.f.make('unchanged_missing_completion'), e => e.code === 'thread_relay.source_unverified');
  assert.equal(missing.engineOwners.length, 0); assert.equal(missing.f.admitted(), undefined);
  t.ok(true, 'unchanged source with no trusted completion remains source_unverified with zero target dispatch');
}
(async () => { try { if (!baseline) { await relayControls(); await schedulerAndPublicControls(); } await noAdvanceControls(); if (!baseline) await actualRelayBoundaryControls(); } catch (e) { t.fail(e.stack || String(e)); } finally { t.done({ exit: true }); } })();
