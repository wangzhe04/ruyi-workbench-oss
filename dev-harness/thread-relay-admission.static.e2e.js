'use strict';
// PURE R1 regression: real turn outcome/capture slices, watched/state helpers,
// relay owner and session ETag functions; all data/keys/turns are in-memory.
// No server import, HTTP, engine, worker, native operation, timer or cleanup.
// --observe-before reads the pinned gzip snapshot named by RUYI_RELAY_BEFORE.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { constBlock, functionBlock, sliceBlock } = require('./lib/source-slice');
const { createRunner } = require('./lib/harness');
const before = process.argv.includes('--observe-before');
const test = createRunner(before ? 'THREAD RELAY R1 BEFORE' : 'THREAD RELAY R1'); const { ok } = test;
const root = path.resolve(__dirname, '../ruyi-workbench/app/src');
const snapshot = process.env.RUYI_RELAY_SNAPSHOT || (before ? process.env.RUYI_RELAY_BEFORE : '');
const read = file => snapshot && ['09c-thread-relay.js', '10-context-governance.js'].includes(file)
  ? zlib.gunzipSync(fs.readFileSync(path.join(snapshot, 'ruyi-workbench/app/src', file + '.gz'))).toString('utf8')
  : fs.readFileSync(path.join(root, file), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value)), hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const turn = functionBlock(read('10-context-governance.js'), 'runSessionTurn');
// The combined finalizer computes ownership before its scheduler/ordinary branch.
const outcomeClause = sliceBlock(turn, '    const outcomeId = session.id;',
  turn.includes('const schedulerPublishes =') ? '    if (outcomePatch || outcomePublicationError)' : '    const turnStillOwned =');
const captureClause = sliceBlock(turn, "    let deliveryCompletion = { status: 'unknown' };", "    if (source === 'thread_relay' && body.relayLifecycle)");
const core = read('06i-steward-core.js');
const helpers = vm.runInNewContext(constBlock(core, 'STEWARD_THREAD_STATE_RULES') + '\n' + ['stewardPendingTotal', 'deriveStewardThreadState', 'stewardThreadTurnQueued',
  'stewardCoveringLastTurn', 'stewardThreadStateFromHead', 'stewardWatchedThread'].map(name => functionBlock(core, name)).join('\n')
  + '\n({stewardThreadStateFromHead,stewardCoveringLastTurn,stewardWatchedThread})', { StewardHooks: {}, stewardStateLabel: value => value });
function fixture() {
  const sessions = new Map(), records = new Map(), owners = new Map(), live = new Map(), children = new Map(), journal = new Map(), cache = new Map();
  const permissions = new Map(), questions = new Map(), plans = new Map(), revisions = new Map();
  const config = { permissionMode: 'auto' }, state = { phase: '', engines: 0, hooks: 0, readLost: false, writeLost: false, completionFailed: false, injected: false };
  const now = () => '2026-10-30T00:00:00.000Z';
  const value = sid => sessions.get(sid), bump = sid => revisions.set(sid, (revisions.get(sid) || 0) + 1);
  const projection = sid => ({ ok: true, sessionId: sid, turnSeq: value(sid).turnSeq, latestTurnSeq: value(sid).turnSeq,
    sourceStamp: hash(value(sid).content), fileStamp: hash('no-files'), files: [], inProgress: false, outdated: false });
  const ref = sid => { const d = projection(sid); return { turnSeq: d.turnSeq, latestTurnSeq: d.latestTurnSeq, sourceStamp: d.sourceStamp, fileStamp: d.fileStamp }; };
  let relay, admitted, inject = () => {};
  const sandbox = { crypto, Buffer, URL, Object, Set, Map, WeakSet, JSON,
    safeSessionId: id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? id : null,
    nowIso: now, readConfig: async () => copy(config), applySessionPermissionModeOverride: s => s, resolvePermissionMode: ({ session, config }) => session.permissionMode || config.permissionMode,
    configReadFence: () => { const captured = hash(config); return () => { if (captured !== hash(config)) throw Object.assign(Error('policy changed'), { code: 'thread_relay.permission_changed' }); }; },
    autonomyGrants: new Map(), turnSettlers: owners, activeAgentRuns: live, activeChildren: children, turnOutcomePending: new Set(),
    pendingPermissions: permissions, pendingQuestions: questions, pendingPlans: plans, interventionRecordCache: cache,
    sessionDiskWriteSeqOf: sid => revisions.get(sid) || 0, agentRunWriteChains: new Map(),
    agentRunFile: (sid, rid) => sid + '/' + rid + '.json',
    sessionExecutionSnapshot: sid => owners.get(sid)?.snapshot || null, sessionSaveIsTombstoned: () => false,
    loadSession: async sid => value(sid) ? copy(value(sid)) : null,
    readInterventionsWithMeta: async sid => { const rows = copy(journal.get(sid) || []); if (state.phase === 'dispatch-read') inject(); return { degraded: false, interventions: rows }; },
    sessionDisplayTitle: s => s.title, ...helpers,
    saveAgentRun: async run => { records.set(run.sessionId + '/' + run.id, copy(run)); },
    agentRunSnapshotStore: (sid, rid) => ({ write: async text => {
      if (state.writeLost) throw Object.assign(Error('synthetic missing key'), { code: 'work_data_keys.locked' });
      records.set(sid + '/' + rid, JSON.parse(text));
    } }),
    readAgentRunSnapshot: async (sid, rid) => { if (state.readLost) throw Object.assign(Error('synthetic missing key'), { code: 'work_data_keys.locked' }); return copy(records.get(sid + '/' + rid) || null); },
    readAgentRunRecord: async (sid, rid) => { const run = live.get(rid)?.run || records.get(sid + '/' + rid); return run ? { run, live: live.has(rid) } : null; },
    waitForAgentRunResults: async (sid, ids) => ({ runs: ids.map(runId => ({ runId, live: live.has(runId) })) }),
    runKeyedChain: (map, key, work) => { const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(work); map.set(key, next); return next; },
    StewardHooks: { deliveryProjection: async sid => projection(sid), validateDeliveryReference: async (sid, r) => ({ ok: JSON.stringify(ref(sid)) === JSON.stringify(r) }),
      deliveryRevisionGuard: (s, reference) => () => { if (hash(value(s.id).content) !== reference.sourceStamp) throw Object.assign(Error('source changed'), { code: 'thread_relay.source_changed' }); },
      deliverySource: s => ({ rows: [{ role: 'assistant', content: s.content, turnSummary: { turnSeq: s.turnSeq } }] }) },
    PrivacyGateway: { run: async (sid, c, work) => work(), prepareLocalDisclosure: async (sid, work) => ({ value: await work(), assert() {} }), restoreHistory: async (sid, history) => history },
    acquireResourceLease: async () => 'synthetic-lease', releaseResourceLease() {}, normalizeAgentResources: r => r, requestSessionExecutionStop() {},
  };
  async function finish(sid, owner, result = { ok: true }, stopped = false) {
    const session = value(sid), inputs = { session, source: 'http', STEWARD_SESSION_ID: 'steward', lastResult: result, turnError: '', nowIso: now,
      todosStartSig: '', settleEntry: owner, turnSettlers: owners, turnOutcomePending: sandbox.turnOutcomePending, sessionMissionId: s => s.missionId, stewardWatchedThread: helpers.stewardWatchedThread };
    const patch = vm.runInNewContext('(function(){' + outcomeClause + '\nreturn outcomePatch;})()', inputs);
    if (patch) session.stewardLastTurn = copy(patch);
    sandbox.turnOutcomePending.delete(sid); // The synthetic metadata writer committed the patch above.
    if (!captureClause) return { status: 'unknown' };
    return vm.runInNewContext('(async()=>{' + captureClause + '\nreturn deliveryCompletion;})()', {
      session: copy(session), settleEntry: owner, storedConfig: config, lastResult: result, turnError: '', turnStopped: stopped,
      ThreadRelayHooks: { captureTurn: relay.captureTurn }, logEvent() {},
    });
  }
  sandbox.launchPersistedAgentRun = async args => {
    admitted = copy(records.get(args.sessionId + '/' + args.runId)); relay.admit(admitted, args.relayAdmission);
    live.set(admitted.id, { run: admitted, ctrl: { abort() {} } }); return { ok: true };
  };
  sandbox.SessionExecutionHooks = { runTurn: async input => {
    state.hooks++; state.phase = 'prepare';
    const admission = await input.relayLifecycle.prepareAdmission?.(); inject('afterPrepare'); admission?.assert();
    const owner = { driverRunId: 'driver-b', snapshot: { serverInstanceId: 'server-r1', driverRunId: 'driver-b' }, requestMeta: input.requestMeta };
    owners.set(input.sessionId, owner); inject('registered');
    await input.relayLifecycle.registered(owner, config, copy(value(input.sessionId)));
    children.set(input.sessionId, { executionOwner: owner }); state.phase = 'dispatch'; inject('dispatch', input, owner);
    const fence = await input.relayLifecycle.beforeDispatch(); inject('afterFence', input, owner); fence?.assert();
    if (state.dispatch) await state.dispatch(owner, input); else state.engines++;
    journal.clear(); cache.clear(); permissions.clear(); questions.clear(); plans.clear();
    const target = value(input.sessionId); target.turnSeq++; target.content = 'verified result ' + input.sessionId; bump(input.sessionId);
    if (state.completionFailed) state.writeLost = true;
    const deliveryCompletion = await finish(input.sessionId, owner);
    const result = { ok: true, stopped: false, turnSeq: target.turnSeq, result: { ok: true }, deliveryCompletion };
    await input.relayLifecycle.settled(result); owners.delete(input.sessionId); children.delete(input.sessionId); return result;
  } };
  relay = vm.runInNewContext(constBlock(read('09c-thread-relay.js'), 'ThreadRelay') + '\nThreadRelay', sandbox);
  const createSession = sid => { const s = { id: sid, title: 'Same title', kind: 'quick_ask', missionId: sid, mission: null, cwd: 'C:/synthetic-r1', turnSeq: 1, content: 'completed ' + sid }; sessions.set(sid, s); return s; };
  async function seed(sid, watched = false, result = { ok: true }, stopped = false) {
    const s = createSession(sid); if (watched) s.stewardWatch = true;
    const owner = { snapshot: { serverInstanceId: 'server-r1', driverRunId: 'driver-' + sid } }; owners.set(sid, owner);
    const receipt = await finish(sid, owner, result, stopped); owners.delete(sid); return receipt;
  }
  const approval = sid => ({ reference: ref(sid), accepted: true, materials: { text: true, files: [] } });
  const make = key => relay.create({ sessionId: 'a', requestId: key, source: approval('a'), targets: [{ sessionId: 'b', task: 'Continue in real B' }, { sessionId: 'c', task: 'Continue in real C' }] });
  function pending(id = 'foreign-pending', own = false, input, owner) {
    if (own) input.onEvent({ type: 'permission_request', requestId: id });
    const row = { id, type: 'permission', sessionId: 'b', status: 'pending' };
    cache.set('b\0' + id, row); journal.set('b', [row]); permissions.set(id, { sessionId: 'b' });
  }
  function change(kind, input, owner) {
    if (kind === 'pending') pending();
    if (kind === 'stopped') { value('b').stewardLastTurn = { seq: value('b').turnSeq, ok: false, aborted: true }; bump('b'); }
    if (kind === 'busy') owners.set('b', { snapshot: { serverInstanceId: 'other', driverRunId: 'other-driver' } });
    if (kind === 'workflow') live.set('other-run', { run: { id: 'other-run', sessionId: 'b' } });
    if (kind === 'cancel') owner.cancelRequested = true;
    if (kind === 'own-pending') pending('owned-request', true, input, owner);
    if (kind === 'own-change') { value('b').turnSeq++; value('b').content = 'own intermediate output'; bump('b'); }
  }
  return { relay, seed, make, sessions, records, owners, live, journal, cache, state, sandbox, approval, config,
    admitted: () => admitted, value, finish, change, setInject: fn => { inject = fn; } };
}
async function attempt(work) { try { return { value: await work() }; } catch (error) { return { error: error.code || error.message }; } }
(async () => {
  try {
    ok(outcomeClause.length > 1000 && outcomeClause.includes('!stewardWatchedThread'), 'real ordinary-success ETag suppression clause remains intact');
    const ordinary = fixture(); await ordinary.seed('a'); await ordinary.seed('b'); await ordinary.seed('c');
    ok(!helpers.stewardWatchedThread(ordinary.value('a'), 'a', 'a') && !ordinary.value('a').stewardLastTurn, 'ordinary successful source remains unwatched with no steward success ledger');
    const created = await attempt(() => ordinary.make('ordinary'));
    if (before) ok(created.error === 'thread_relay.source_unverified', 'OLD: real ordinary outcome is rejected without a delivery receipt');
    else {
      ok(!!created.value, 'NEW: real owner completion fact makes ordinary A an accepted source');
      const chain = created.value, edge = chain.threadRelay.edges[0];
      await ordinary.relay.submit('a', chain.id, edge.id);
      await ordinary.relay.execute(ordinary.admitted(), ordinary.admitted().nodes[0], new AbortController().signal, () => {}); ordinary.live.clear();
      const accepted = await ordinary.relay.accept({ sessionId: 'a', relayId: chain.id, edgeId: edge.id, source: ordinary.approval('b') });
      ok(!ordinary.value('b').stewardLastTurn && accepted.threadRelay.edges[1].state === 'ready', 'ordinary B success is durably verifiable and can unlock C without watch flags');
      const historic = fixture(); historic.sessions.set('a', copy(ordinary.value('a'))); historic.sessions.set('b', copy(ordinary.value('b'))); historic.sessions.set('c', copy(ordinary.value('c')));
      ok((await attempt(() => historic.make('history'))).error === 'thread_relay.source_unverified', 'historical prose with no trusted receipt remains unknown');
      for (const [result, stopped] of [[{ ok: false }, false], [{ ok: true }, true]]) {
        const denied = fixture(); await denied.seed('a', false, result, stopped); await denied.seed('b'); await denied.seed('c');
        ok(!!(await attempt(() => denied.make('failed-source'))).error, 'failed or stopped actual result never becomes an accepted completion');
      }
    }
    const cases = before ? [['intent', 'pending'], ['intent', 'stopped']] : [
      ['intent', 'pending'], ['intent', 'stopped'], ['intent', 'busy'], ['intent', 'workflow'],
      ['afterPrepare', 'pending'], ['afterPrepare', 'stopped'], ['registered', 'pending'], ['registered', 'stopped'],
      ['dispatch', 'pending'], ['dispatch', 'stopped'], ['dispatch', 'busy'], ['dispatch', 'workflow'], ['dispatch', 'cancel'],
    ];
    for (const [phase, kind] of cases) {
      const f = fixture(); await f.seed('a', true); await f.seed('b'); await f.seed('c');
      const chain = await f.make('case_' + phase + '_' + kind), edge = chain.threadRelay.edges[0]; await f.relay.submit('a', chain.id, edge.id);
      if (phase === 'intent') f.change(kind);
      else f.setInject((at, input, owner) => { if (at === phase && !f.state.injected) { f.state.injected = true; f.change(kind, input, owner); } });
      const outcome = await attempt(() => f.relay.execute(f.admitted(), f.admitted().nodes[0], new AbortController().signal, () => {}));
      ok(before ? f.state.engines === 1 : f.state.engines === 0 && !!outcome.error, (before ? 'OLD bypass: ' : 'NEW blocks: ') + phase + ' → ' + kind);
    }
    if (!before) {
      for (const kind of ['own-pending', 'own-change', 'none']) {
        const f = fixture(); await f.seed('a'); await f.seed('b'); await f.seed('c'); const chain = await f.make('positive_' + kind); await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id);
        f.setInject((at, input, owner) => { if (at === 'dispatch') f.change(kind, input, owner); });
        const r = await attempt(() => f.relay.execute(f.admitted(), f.admitted().nodes[0], new AbortController().signal, () => {}));
        ok(r.value?.ok === true && f.state.engines === 1, 'exact own owner/child/workflow allows ' + kind + ' without false busy');
      }
      for (const kind of ['pending', 'stopped', 'own-change', 'reused-request']) {
        const f = fixture(); await f.seed('a'); await f.seed('b'); await f.seed('c'); const chain = await f.make('fence_' + kind); await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id);
        f.setInject((at, input, owner) => {
          if (at === 'dispatch') { if (kind === 'reused-request') f.change('own-pending', input, owner); f.state.phase = 'dispatch-read'; }
          else if (!at && !f.state.injected) {
            f.state.injected = true;
            if (kind === 'reused-request') f.sandbox.pendingPermissions.set('owned-request', { sessionId: 'b' });
            else f.change(kind);
          }
        });
        const r = await attempt(() => f.relay.execute(f.admitted(), f.admitted().nodes[0], new AbortController().signal, () => {}));
        ok(kind === 'own-change' ? r.value?.ok === true && f.state.engines === 1 : !!r.error && f.state.engines === 0,
          'journal-read → synchronous fence preserves exact identity for ' + kind);
      }
      const lost = fixture(); lost.state.writeLost = true; await lost.seed('a', true); lost.state.writeLost = false; await lost.seed('b'); await lost.seed('c');
      ok((await attempt(() => lost.make('lost-write'))).error === 'thread_relay.source_unverified', 'M3 receipt write/key failure stays unknown even with a watched success ledger');
      const readLost = fixture(); await readLost.seed('a', true); await readLost.seed('b'); await readLost.seed('c'); readLost.state.readLost = true;
      ok((await attempt(() => readLost.make('lost-read'))).error === 'work_data_keys.locked', 'M3 lost-key read cannot fall back to plain success');
      const failedCompletion = fixture(); await failedCompletion.seed('a'); await failedCompletion.seed('b'); await failedCompletion.seed('c');
      const chain = await failedCompletion.make('target-receipt-fail'); await failedCompletion.relay.submit('a', chain.id, chain.threadRelay.edges[0].id); failedCompletion.state.completionFailed = true;
      await failedCompletion.relay.execute(failedCompletion.admitted(), failedCompletion.admitted().nodes[0], new AbortController().signal, () => {}); failedCompletion.live.clear();
      ok((await failedCompletion.relay.reconcile(await failedCompletion.relay.read('a', chain.id))).threadRelay.edges[0].state === 'unknown', 'B side effects plus failed completion commit remain unknown and cannot unlock C');
      const f = fixture(); await f.seed('a');
      const etagSource = read('13d-core-domain-routes.js'), head = JSON.stringify(f.value('a'));
      const etags = vm.runInNewContext(functionBlock(etagSource, 'sessionEnvelopeStamp') + '\n' + functionBlock(etagSource, 'sessionEnvelopeEtag') + '\n({sessionEnvelopeStamp,sessionEnvelopeEtag})', {
        crypto, safeSessionId: x => x, sessionBodyPaths: x => ({ messages: x + '-messages', provider: x + '-provider' }), readSessionHeadText: async () => head,
        fsp: { stat: async () => ({ size: 10, mtimeMs: 20, ino: 30 }) }, EventStreamHooks: { backgroundJobsStamp: async () => 'same-jobs' },
        sessionPermissionModeOverrides: new Map(), sessionDesktopToolsOverrides: new Map(), turnSettlers: new Map(),
        pretenderHash: hash, pretenderEtag: (prefix, h) => prefix + ':' + h,
      });
      const oldTag = etags.sessionEnvelopeEtag('a', await etags.sessionEnvelopeStamp('a'), {}, null);
      await f.seed('a');
      ok(oldTag === etags.sessionEnvelopeEtag('a', await etags.sessionEnvelopeStamp('a'), {}, null) && JSON.stringify(f.value('a')) === head,
        'real session GET stamp/ETag stays byte-identical when only the completion receipt is stored');
      ok(turn.includes('if (relayAdmission) relayAdmission.assert();') && turn.indexOf('if (relayAdmission) relayAdmission.assert();') < turn.indexOf('recordSessionExecutionOwner(session.id, settleEntry)'), 'original owner registration includes the final synchronous admission fence');
      const strictRead = vm.runInNewContext(functionBlock(read('02-session-store.js'), 'readInterventionsWithMeta') + '\nreadInterventionsWithMeta', {
        interventionWriteChains: new Map(), fsp: { readFile: async () => { throw Object.assign(Error('synthetic unreadable journal'), { code: 'EIO' }); } },
        interventionFilePath: x => x,
      });
      ok((await attempt(() => strictRead('b', { strict: true }))).error === 'EIO', 'real intervention owner reports unreadable admission facts instead of treating them as empty');
      ok((await strictRead('b')).interventions.length === 0, 'legacy non-admission intervention projection keeps its established best-effort behavior');
    }
  } catch (error) { test.fail(error.stack || String(error)); }
  test.done();
})();
