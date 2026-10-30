'use strict';
// PURE: reads source text only, evaluates the real 09c owner in a VM with small
// in-memory storage/turn/permission adapters. No server import, HTTP, provider,
// scheduler, engine, native calls, processes, user-data access or timers.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock, functionBlock } = require('./lib/source-slice');
const { createRunner } = require('./lib/harness');
const test = createRunner('THREAD RELAY CONTRACT'); const { ok } = test;
const root = path.resolve(__dirname, '../ruyi-workbench/app/src');
const src = fs.readFileSync(path.join(root, '09c-thread-relay.js'), 'utf8');
const block = constBlock(src, 'ThreadRelay');
const copy = value => JSON.parse(JSON.stringify(value));
const sessions = new Map(), runs = new Map(), chains = new Map(), interventions = new Map();
const activeAgentRuns = new Map(), activeChildren = new Map(), turnSettlers = new Map();
const interventionRecordCache = new Map(), pendingPermissions = new Map(), pendingQuestions = new Map(), pendingPlans = new Map();
let starts = 0, admitted = null, message = '', changedPolicy = false, privateConfig = null, targetWireMessage = '', refuseSuccessSave = false;
const stamp = text => crypto.createHash('sha256').update(text).digest('hex');
const config = () => ({ permissionMode: changedPolicy ? 'plan' : 'auto', ...(privateConfig || {}) });
const makeSession = name => { const row = { id: name, title: 'Same title', cwd: 'C:/synthetic', turnSeq: 1, content: 'approved ' + name, stewardLastTurn: { seq: 1, ok: true } }; sessions.set(name, row); return row; };
for (const name of ['source_a', 'target_b', 'target_c', 'target_d']) makeSession(name);
const projection = sid => { const s = sessions.get(sid); return { ok: true, sessionId: sid, turnSeq: s.turnSeq, latestTurnSeq: s.turnSeq,
  sourceStamp: stamp(s.content), fileStamp: stamp('no-files'), evidenceRecorded: true, files: [], inProgress: false, outdated: false }; };
const reference = sid => { const d = projection(sid); return { turnSeq: d.turnSeq, latestTurnSeq: d.latestTurnSeq, sourceStamp: d.sourceStamp, fileStamp: d.fileStamp }; };
const source = sid => ({ reference: reference(sid), accepted: true, materials: { text: true, files: [] } });
let relay;
const sandbox = { crypto, Buffer, URL, Object, Set, Map, WeakSet, JSON,
  safeSessionId: value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : null,
  readConfig: async () => config(), applySessionPermissionModeOverride: value => value,
  configReadFence: () => { const captured = JSON.stringify(config()); return () => { if (captured !== JSON.stringify(config())) throw Object.assign(Error('policy changed'), { code: 'thread_relay.permission_changed' }); }; },
  resolvePermissionMode: ({ session, config }) => session.permissionMode || config.permissionMode,
  autonomyGrants: new Map(), activeAgentRuns, activeChildren, turnSettlers, turnOutcomePending: new Set(),
  interventionRecordCache, pendingPermissions, pendingQuestions, pendingPlans, sessionDiskWriteSeqOf: () => 0,
  agentRunWriteChains: new Map(),
  agentRunFile: (sid, rid) => sid + '/' + rid + '.json',
  agentRunSnapshotStore: (sid, rid) => ({ write: async text => { runs.set(sid + '/' + rid, JSON.parse(text)); } }),
  stewardCoveringLastTurn: (outcome, seq) => outcome?.seq === seq ? outcome : null,
  loadSession: async sid => sessions.has(sid) ? copy(sessions.get(sid)) : null,
  sessionSaveIsTombstoned: () => false, sessionExecutionSnapshot: sid => turnSettlers.get(sid)?.snapshot || null,
  readInterventionsWithMeta: async sid => ({ degraded: false, interventions: interventions.get(sid) || [] }),
  stewardThreadStateFromHead: value => ({ state: value.stopped || value.stewardLastTurn?.ok === false ? 'stopped' : 'done' }),
  sessionDisplayTitle: value => value.title,
  nowIso: () => '2026-10-30T00:00:00.000Z',
  saveAgentRun: async run => {
    if (refuseSuccessSave && run.threadRelayExecution?.receipt?.status === 'succeeded') throw Object.assign(Error('synthetic disk failure'), { code: 'synthetic_disk_failure' });
    runs.set(run.sessionId + '/' + run.id, copy(run));
  },
  readAgentRunSnapshot: async (sid, rid) => runs.has(sid + '/' + rid) ? copy(runs.get(sid + '/' + rid)) : null,
  readAgentRunRecord: async (sid, rid) => { const run = activeAgentRuns.get(rid)?.run || runs.get(sid + '/' + rid); return run ? { run: copy(run), live: activeAgentRuns.has(rid) } : null; },
  listAgentRuns: async sid => [...runs.values()].filter(run => run.sessionId === sid).map(copy),
  waitForAgentRunResults: async (sid, ids) => ({ runs: ids.map(runId => ({ runId, live: activeAgentRuns.has(runId) })) }),
  runKeyedChain: (map, key, work) => { const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(work); map.set(key, next); return next; },
  StewardHooks: {
    validateDeliveryReference: async (sid, ref) => ({ ok: JSON.stringify(reference(sid)) === JSON.stringify(ref) }),
    deliveryProjection: async sid => projection(sid),
    deliveryRevisionGuard: (source, reference) => () => { if (stamp(sessions.get(source.id).content) !== reference.sourceStamp) throw Object.assign(Error('source changed'), { code: 'thread_relay.source_changed' }); },
    deliverySource: value => ({ rows: [{ role: 'assistant', content: value.content, turnSummary: { turnSeq: value.turnSeq } }] }),
  },
  PrivacyGateway: { run: async (sid, config, work) => work(), prepareLocalDisclosure: async (sid, work) => ({ value: await work(), assert: () => {} }),
    restoreHistory: async (sid, value) => value },
  acquireResourceLease: async () => 'synthetic-lease', releaseResourceLease: () => {}, normalizeAgentResources: value => value,
  requestSessionExecutionStop: sid => { sessions.get(sid).stopped = true; },
  launchPersistedAgentRun: async args => {
    const run = copy(runs.get(args.sessionId + '/' + args.runId)); relay.admit(run, args.relayAdmission);
    starts++; admitted = run; activeAgentRuns.set(run.id, { run, ctrl: { abort() {} } });
    return { ok: true, accepted: true, runId: run.id };
  },
  SessionExecutionHooks: { runTurn: async input => {
    const target = sessions.get(input.sessionId);
    if (target.cwd !== input.expectedCwd || target.turnSeq !== input.expectedTurnSeq) throw Error('changed');
    const admission = await input.relayLifecycle.prepareAdmission(); admission.assert();
    const owner = { snapshot: { serverInstanceId: 'synthetic-server', driverRunId: 'same-driver' }, requestMeta: input.requestMeta };
    turnSettlers.set(target.id, owner);
    await input.relayLifecycle.registered(owner, config(), copy(target));
    const fence = await input.relayLifecycle.beforeDispatch(); fence?.assert(); message = input.message;
    if (sandbox.PrivacyGateway.beforeRequest) {
      const wire = await sandbox.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: input.message }] });
      targetWireMessage = wire.messages.at(-1).content;
    }
    target.turnSeq++; target.content = 'completed target'; target.stewardLastTurn = { seq: target.turnSeq, ok: true };
    const result = { ok: true, stopped: false, turnSeq: target.turnSeq, result: { ok: true } };
    result.deliveryCompletion = await relay.captureTurn({ session: copy(target), owner, config: config(), result: result.result, error: '', stopped: false });
    await input.relayLifecycle.settled(result); turnSettlers.delete(target.id); return result;
  } },
};
async function rejects(work, code, label) { try { await work(); ok(false, label); } catch (error) { ok(error.code === 'thread_relay.' + code, label); } }
async function complete(sid) {
  const value = sessions.get(sid), owner = { snapshot: { serverInstanceId: 'synthetic-server', driverRunId: 'initial-' + sid } };
  turnSettlers.set(sid, owner);
  await relay.captureTurn({ session: copy(value), owner, config: config(), result: { ok: true }, error: '', stopped: false });
  turnSettlers.delete(sid);
}
(async () => {
  try {
    ok(block.length > 10000, 'real domain owner is sliced, not a mirrored test implementation');
    vm.runInNewContext(block + '\nthis.relay = ThreadRelay;', sandbox); relay = sandbox.relay;
    for (const sid of sessions.keys()) await complete(sid);
    const initialFacts = runs.size;
    const body = { sessionId: 'source_a', requestId: 'click_1', source: source('source_a'),
      targets: [{ sessionId: 'target_b', task: 'Continue in B' }, { sessionId: 'target_c', task: 'Continue in C' }] };
    const [one, duplicate] = await Promise.all([relay.create(body), relay.create(body)]);
    ok(one.id === duplicate.id && runs.size === initialFacts + 1, 'duplicate clicks persist one stable contract');
    ok(one.threadRelay.edges[0].source.acceptance.sourceStamp === body.source.reference.sourceStamp
      && one.threadRelay.edges[1].dependsOn === one.threadRelay.edges[0].id, 'exact accepted revision and sequential dependency are durable');
    const first = one.threadRelay.edges[0], second = one.threadRelay.edges[1];
    sessions.get('source_a').stewardLastTurn.ok = false;
    await rejects(() => relay.submit('source_a', one.id, first.id), 'thread_blocked', 'a failed source is not promoted by accepted assistant prose'); sessions.get('source_a').stewardLastTurn.ok = true;
    sessions.get('target_b').stopped = true;
    await rejects(() => relay.submit('source_a', one.id, first.id), 'thread_blocked', 'a stopped existing target cannot be restarted by a relay'); sessions.get('target_b').stopped = false;
    sessions.get('target_b').cwd = 'C:/different';
    await rejects(() => relay.submit('source_a', one.id, first.id), 'target_changed', 'workspace switch cannot silently retarget an existing edge'); sessions.get('target_b').cwd = 'C:/synthetic';
    await rejects(() => relay.submit('source_a', one.id, second.id), 'dependency_unaccepted', 'no downstream start before real acceptance');
    interventions.set('target_b', [{ status: 'pending' }]);
    await rejects(() => relay.submit('source_a', one.id, first.id), 'decision_pending', 'pending decision blocks target admission'); interventions.clear();
    turnSettlers.set('target_b', { snapshot: { driverRunId: 'busy' } });
    await rejects(() => relay.submit('source_a', one.id, first.id), 'target_busy', 'busy target is never superseded'); turnSettlers.clear();
    changedPolicy = true;
    await rejects(() => relay.submit('source_a', one.id, first.id), 'permission_changed', 'current permission changes invalidate approval'); changedPolicy = false;
    sessions.get('source_a').content = 'edited';
    await rejects(() => relay.submit('source_a', one.id, first.id), 'source_changed', 'source edits cannot silently replace approved material'); sessions.get('source_a').content = 'approved source_a';
    await Promise.all([relay.submit('source_a', one.id, first.id), relay.submit('source_a', one.id, first.id)]);
    ok(starts === 1 && admitted.threadRelayExecution.source.hash === first.source.hash, 'parallel starts admit one execution identity after durable intent');
    await rejects(() => Promise.resolve(relay.admit(admitted, {})), 'replay_forbidden', 'resume without the private single-use admission cannot replay execution');
    const result = await relay.execute(admitted, admitted.nodes[0], new AbortController().signal, () => {});
    activeAgentRuns.delete(admitted.id);
    const reviewed = await relay.reconcile(await relay.read('source_a', one.id));
    ok(result.ok && message.includes('approved source_a') && sessions.get('target_b').turnSeq === 2, 'execution continues B with authorized material in its original identity');
    ok(reviewed.threadRelay.edges[0].state === 'review' && reviewed.threadRelay.edges[1].state === 'waiting', 'real success receipt still waits for delivery acceptance');
    const accepted = await relay.accept({ sessionId: 'source_a', relayId: one.id, edgeId: first.id, source: source('target_b') });
    ok(accepted.threadRelay.edges[1].state === 'ready' && accepted.threadRelay.edges[1].source.sessionId === 'target_b'
      && accepted.threadRelay.edges[1].source.reference.turnSeq === 2, 'next edge binds the explicitly accepted B delivery');
    await relay.submit('source_a', one.id, second.id); activeAgentRuns.clear();
    const unknown = await relay.reconcile(await relay.read('source_a', one.id));
    ok(unknown.threadRelay.edges[1].state === 'unknown', 'restart without a terminal receipt is unknown');
    await relay.submit('source_a', one.id, second.id);
    ok(starts === 2, 'unknown identity lookup never creates a new attempt or replays C');
    const cancelled = await relay.cancel({ sessionId: 'source_a', relayId: one.id });
    ok(cancelled.threadRelay.cancelled && cancelled.threadRelay.edges[1].state === 'cancelled', 'explicit cancellation retires the entire sequence');
    await rejects(() => relay.submit('source_a', one.id, second.id), 'cancelled', 'late success or duplicate start cannot reopen cancellation');
    const foreign = makeSession('foreign_source'); foreign.content = '[[RUYI_PVT:foreign:token]]';
    await complete(foreign.id);
    await rejects(() => relay.create({ ...body, sessionId: foreign.id, requestId: 'foreign_click', source: source(foreign.id) }), 'foreign_reference', 'foreign scope alias is refused rather than forwarded');
    // Run the real privacy core/gateway with encrypted records in a synthetic
    // Map filesystem. The vault protector is an explicit in-memory test adapter;
    // no DPAPI, native process, actual model or mapping file is used.
    const { fixture } = require('./lib/privacy-test-fixture');
    const primitives = fixture(), files = new Map(); let serial = 0;
    const missing = () => Object.assign(Error('missing'), { code: 'ENOENT' });
    const stat = file => { const row = files.get(file); if (!row) throw missing(); return { isFile: () => true, isSymbolicLink: () => false,
      dev: 1n, ino: 1n, size: Buffer.byteLength(JSON.stringify(row.value)), mtimeNs: BigInt(row.serial), ctimeNs: BigInt(row.serial) }; };
    const fileApi = { lstat: async file => stat(file), mkdir: async () => {} };
    const core = { ...primitives.PrivacyCore, configHooks: { sealLocal: primitives.vault.sealLocal, openLocal: primitives.vault.openLocal } };
    const privacy = vm.runInNewContext(constBlock(fs.readFileSync(path.join(root, '03a-privacy-gateway.js'), 'utf8'), 'PrivacyGateway') + '\nPrivacyGateway', {
      require: name => name === 'node:fs' ? { promises: fileApi, lstatSync: stat } : require(name), Buffer, URL, structuredClone, setImmediate,
      PrivacyCore: core, PrivacyRegex: primitives.PrivacyRegex,
    });
    privacy.setHost({ data: 'C:/synthetic/privacy', makeStore: file => ({
      read: async () => { const row = files.get(file); if (!row) throw missing(); return copy(row.value); },
      write: async value => { files.set(file, { value: copy(value), serial: ++serial }); },
    }) });
    privateConfig = { privacyModeV1: 'enhanced', privacyRulesV1: [] }; privacy.configure(config());
    const privateSource = makeSession('private_source'), privateTarget = makeSession('private_target'), secret = 'relay-contact@example.test';
    const wire = await privacy.run(privateSource.id, config(), () => privacy.beforeRequest({ messages: [{ role: 'assistant', content: secret }] }));
    privateSource.content = wire.messages.at(-1).content;
    sandbox.PrivacyGateway = privacy;
    await complete(privateSource.id); await complete(privateTarget.id);
    const privateRelay = await relay.create({ sessionId: privateSource.id, requestId: 'private_click', source: source(privateSource.id), targets: [{ sessionId: privateTarget.id, task: 'Continue with approved contact' }] });
    await relay.submit(privateSource.id, privateRelay.id, privateRelay.threadRelay.edges[0].id);
    await relay.execute(admitted, admitted.nodes[0], new AbortController().signal, () => {}); activeAgentRuns.clear();
    ok(message.includes(secret) && !message.includes(privateSource.content) && !targetWireMessage.includes(secret)
      && targetWireMessage.includes('[[RUYI_PVT:') && !targetWireMessage.includes(privateSource.content), 'real gateway restores approved source material and re-signs it in target scope before the model wire');
    try {
      await privacy.run(privateTarget.id, config(), () => privacy.beforeRequest({ messages: [{ role: 'user', content: privateSource.content }] }));
      ok(false, 'source scope alias cannot be submitted directly to target');
    } catch (error) { ok(error.code === 'privacy.reference_unknown', 'source scope alias cannot be submitted directly to target'); }
    const durableTarget = makeSession('durable_target');
    await complete(durableTarget.id);
    const durableRelay = await relay.create({ sessionId: privateSource.id, requestId: 'durable_click', source: source(privateSource.id), targets: [{ sessionId: durableTarget.id, task: 'Verify durable receipt' }] });
    await relay.submit(privateSource.id, durableRelay.id, durableRelay.threadRelay.edges[0].id);
    refuseSuccessSave = true;
    try { await relay.execute(admitted, admitted.nodes[0], new AbortController().signal, () => {}); ok(false, 'failed receipt commit remains unknown'); }
    catch (error) { ok(error.code === 'synthetic_disk_failure' && admitted.threadRelayExecution.receipt.status === 'running', 'failed receipt commit never exposes an uncommitted success'); }
    refuseSuccessSave = false; activeAgentRuns.clear(); turnSettlers.clear();
    const durableUnknown = await relay.reconcile(await relay.read(privateSource.id, durableRelay.id));
    ok(durableUnknown.threadRelay.edges[0].state === 'unknown', 'target side effects without a durable success receipt cannot unlock another thread');
    const workflow = fs.readFileSync(path.join(root, '09-workflow.js'), 'utf8');
    ok(functionBlock(workflow, 'launchPersistedAgentRun').includes('ThreadRelayHooks.admit') && workflow.includes('ThreadRelayHooks.execute(run, node'), 'relay uses original persisted workflow launcher and execution shell');
    const turn = functionBlock(fs.readFileSync(path.join(root, '10-context-governance.js'), 'utf8'), 'runSessionTurn');
    ok(turn.indexOf('recordSessionExecutionOwner') < turn.indexOf('await lifecycle.registered')
      && turn.includes('settleEntry.prepareDispatch = body.relayLifecycle.beforeDispatch') && turn.includes('SessionExecutionHooks.assertDispatch(settleEntry, fence)'), 'durable receipt uses the original execution owner before engine dispatch');
  } catch (error) { test.fail(error.stack || String(error)); }
  test.done();
})();
