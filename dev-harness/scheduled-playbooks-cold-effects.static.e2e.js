'use strict';
// Source VM + owned tiny FS only. Real saveSession/head M3 codec, scheduler
// task/journal owners, recovery and inbox collection; no engine/server/HTTP,
// scheduler activation, native command, browser, platform key or process runs.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock, constBlock, bracedBlock } = require('./lib/source-slice');
const { loadWorkDataJournals } = require('./lib/work-data-journals-fixture');
const t = createRunner('SCHEDULED PLAYBOOK COLD EFFECTS STATIC');
const repo = path.resolve(__dirname, '..'), flag = process.argv.find(arg => arg.startsWith('--baseline-root='));
const root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : repo;
const read = name => fs.readFileSync(path.join(root, 'ruyi-workbench/app/src', name), 'utf8');
const shared = name => fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src', name), 'utf8');
const store = read('02-session-store.js'), scheduler = read('13s-scheduler.js'), inbox = read('13i-steward-inbox.js'), core = read('06i-steward-core.js');
const provider = read('06-provider-engine.js'), boot = shared('00-boot.js'), calendar = read('06j-scheduler-core.js');
const names = (source, keys, kind = functionBlock) => keys.map(key => kind(source, key)).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
const collector = names(inbox, ['STEWARD_EVENT_KINDS', 'STEWARD_SOURCE_EVENT_MAP', 'STEWARD_SUMMARY_CHARS', 'STEWARD_RUN_TERMINAL', 'STEWARD_ACTIVE_WINDOW_MS', 'stewardHeldTurnSessions'], constBlock)
  + '\n' + names(inbox, ['stewardResolveMissionResultKind', 'stewardResolveRunEndKind', 'stewardResolveNodeSettledKind', 'stewardResolveSessionTurnKind']) + '\n' + constBlock(inbox, 'STEWARD_KIND_RESOLVERS')
  + '\n' + names(inbox, ['stewardKindFor', 'stewardClipSummary', 'stewardIsoAt', 'stewardNormalizeSessionTurn', 'stewardReadTurnHead', 'stewardThreadBackgroundBusy', 'stewardCollectSessionTurn'])
  + '\n' + names(core, ['stewardCoveringLastTurn', 'stewardWatchedThread']);
async function fixture({ newTarget = false, legacy = false, legacyPrompt = false } = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-schedule-cold-source-')), sessions = path.join(directory, 'sessions');
  await fsp.mkdir(sessions);
  const master = crypto.randomBytes(32), state = { lostKey: false, failHead: false, businessExecutions: 0 }, notices = [];
  const io = { ...fsp, rename: async (from, to) => {
    if (state.failHead && path.dirname(path.resolve(to)) === sessions && String(to).endsWith('.json')) throw Object.assign(Error('synthetic session commit rejected'), { code: 'EIO' });
    if (state.failTasks && String(to).endsWith('tasks-v1.json')) throw Object.assign(Error('synthetic task commit rejected'), { code: 'EIO' });
    const result = await fsp.rename(from, to);
    if (state.armFireFailure && path.dirname(path.resolve(to)) === sessions && String(to).endsWith('.json')) state.failFires = true;
    return result;
  }, open: async (file, flags, ...args) => {
    if (state.failFires && String(file).endsWith('fires-v1.ndjson') && flags === 'a') throw Object.assign(Error('synthetic fire append rejected'), { code: 'EIO' });
    return fsp.open(file, flags, ...args);
  } };
  const keys = { snapshot: async () => {
    if (state.lostKey) throw Object.assign(Error('synthetic unavailable machine key'), { code: 'work_data_key.absent' });
    const key = Buffer.from(master); return { key, instanceId: 'scheduler-source-cold', release: () => key.fill(0) };
  } };
  const close = async () => { master.fill(0); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fsp.rm(directory, { recursive: true, force: true }); };
  async function cold() {
    const fx = loadWorkDataJournals({ fsp: io, io, require: name => name === 'node:fs/promises' ? io : require(name) }); fx.store.Hooks.keys = keys;
    const now = Date.parse('2026-10-30T09:05:00Z'); let api;
    const context = vm.createContext({ require, Buffer, crypto, fs, fsp: io, path, process: { env: {} },
      WorkDataStore: fx.store, WorkDataJournals: fx.WorkDataJournals, workDataKeys: keys, atomicWriteJson: fx.atomicWriteJson,
      paths: { data: directory, sessions }, sessionPath: id => path.join(sessions, id + '.json'), assertSessionIdForPath: id => id,
      readConfig: async () => ({ workDataEncryptionV1: true, schedulerEnabledV1: true, permissionMode: 'auto' }), nowIso: () => new Date(now).toISOString(),
      ensureDirs: () => fsp.mkdir(sessions, { recursive: true }), sessionOmittedProviderHistory: () => false,
      sessionEngineRouteOverrides: new Map(), sessionEngineRouteScopeOverrides: new Map(), missionChangeSeqHighWater: new Map(),
      applySessionTitleOverride() {}, applySessionPermissionModeOverride() {}, applySessionDesktopToolsOverride() {}, sessionRecentUserRequest: () => null,
      sessionMeta: s => ({ id: s.id, turnSeq: s.turnSeq }), sessionBodyState: new Map(), sessionWriteChains: new Map(), sessionRewindGenHighWater: new Map(),
      // Empty body arrays in these metadata controls: no body/tool result is
      // manufactured. The complete production save function still owns its
      // owner checks, head serialization, M3 write and commit acknowledgement.
      recoverSessionBodyState: async () => ({ bodiesOk: true, msg: {}, prov: {} }), rebaseStaleSessionBody: async () => false,
      planSessionBodyAppend: rows => { assert.equal(rows.length, 0); return { appendLines: [], allLines: [] }; },
      sessionBodyFileStamp: async () => '', sessionBodyRecord: () => ({}), setSessionBodyState() {}, sessionSaveIsTombstoned: () => false,
      bumpSessionDiskWriteSeq() {}, scheduleSessionIndexUpdate() {}, markPretenderIndexDirty() {}, logEvent() {},
      SessionExecutionHooks: { owns: (sid, owner) => context.turnSettlers.get(sid) === owner },
      activeChildren: new Map(), turnSettlers: new Map(), turnOutcomePending: new Map(), activeAgentRuns: new Map(),
      EventStreamHooks: { backgroundShells: { rows: () => [] } }, StewardHooks: {}, stewardSanitizeText: String,
      stewardRuntime: { cold: false, cursor: { sessionTurns: { sess_cold: { turnSeq: 1, stamp: 'old-cursor' } } }, sourcesSeen: { sessionTurns: 0 } },
      safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
      loadSession: async id => { try { const head = JSON.parse(await api.readSessionHeadText(id)); return { ...head, messages: [], providerHistory: [] }; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
      setTimeout() { throw Error('no app timer capability'); }, clearTimeout() {}, setInterval() { throw Error('no scheduler timer capability'); }, clearInterval() {},
      runSessionTurn() { state.businessExecutions++; throw Error('no engine capability'); } });
    const constants = names(store, ['SESSION_STORAGE_VERSION', 'SESSION_HEAD_ADAPTER_SCHEMA', 'sessionFullTextHeadWriteSeq', 'sessionFullTextHeadWrites', 'sessionMetaDeferChains', 'SESSION_META_DEFER_TIMEOUT_MS', 'SESSION_META_STALE_REPLAYS', 'sessionMutateChains', 'STEWARD_WATCH_NOTE_MAX', 'SESSION_HEAD_READ_RETRIES', 'SESSION_HEAD_TRANSIENT'], constBlock);
    const methods = names(store, ['sessionBodyPaths', 'sessionBodyDanglingFromLines', 'sessionHeadStore', 'readSessionHeadText', 'writeSessionHead', 'readSessionHeadResilient', 'sessionSchedulerTurnReceipt', 'sessionSchedulerTurnMatches', 'sessionStampSchedulerTurn', 'applySessionMetaPatch', 'stewardWatchNoteFrom', 'withSessionMutateLock', 'updateSessionMeta', 'updateSessionMetaAttempt', 'saveSession', 'repairMissionChangeTornTail']);
    const pb = names(provider, ['PLAYBOOK_INPUT_TYPES', 'PLAYBOOK_REQUIRES', 'PLAYBOOK_SERVICES', 'PLAYBOOK_REUSE_OPEN'], constBlock) + '\n' + names(provider, ['normalizePlaybookReuse', 'playbookReuseTemplate', 'normalizePlaybook']);
    const source = constants + '\n' + names(boot, ['RUYI_EVENT_SUBSCRIBERS', 'RUYI_EVENTS'], constBlock) + '\n' + functionBlock(boot, 'runKeyedChain')
      + '\n' + functionBlock(shared('01-config.js'), 'readFileTail') + '\n' + methods + '\n' + calendar + '\n' + pb + '\n' + functionBlock(core, 'stewardAssemblePlaybookPrompt')
      + '\n' + scheduler + '\n' + collector + '\nStewardHooks.normalizePlaybook=normalizePlaybook; SchedulerHooks.onSchedulerNotice=async row=>__notices.push(row); schedulerClockNow=()=>__now;';
    context.__notices = notices; context.__now = now;
    api = vm.runInContext(source + '\n({saveSession,readSessionHeadText,updateSessionMeta,schedulerRuntime,normalizePlaybook,normalizeSchedulerTask,schedulerOccurrenceSnapshot,occurrenceKey,schedulerSaveTasks,schedulerAppendFire,schedulerLoad,schedulerRecover,schedulerReadFireRows,schedulerMergeRuns,schedulerFiresPath,schedulerTasksPath,schedulerFireOnce,schedulerRunNow,handleSchedulerApiRoutes,schedulerBindPlaybookBody,schedulerNormalizePlaybookPayload,schedulerRestorePersistedState,schedulerPermissionModeFor,schedulerTaskAdmission,schedulerTaskPayload,schedulerReadTasksFile,sessionSchedulerTurnReceipt,nextFireAt,missedOccurrence,collect:stewardCollectSessionTurn})', context, { timeout: 2000 });
    return { api, context, poll: () => api.collect('sess_cold', 'sess_cold', { sourceStamp: 'source-control-' + crypto.randomBytes(3).toString('hex') }, now), head: async () => JSON.parse(await api.readSessionHeadText('sess_cold')) };
  }
  try {
  const warm = await cold(), due = Date.parse('2026-10-30T09:00:00Z'), sid = 'sess_cold';
  const template = warm.api.normalizePlaybook({ id: 'pb_cold', title: 'Original copy', inputs: [], requires: [], promptTemplate: 'PINNED_OLD_CONTENT' });
  const normalized = warm.api.normalizeSchedulerTask({ id: 'sch_cold', title: 'Cold check', schedule: { kind: 'daily', at: '09:00', tz: 'UTC' }, payload: legacyPrompt ? { kind: 'prompt', text: 'PINNED_LEGACY_PROMPT' } : { kind: 'playbook', template, playbookId: template.id, revision: template.revision, values: {}, checks: ['Use this run evidence'] }, target: newTarget ? { mode: 'new-session' } : { mode: 'existing-session', sessionId: sid } }, due - 1000);
  assert.equal(normalized.ok, true); const task = normalized.task, key = warm.api.occurrenceKey(task.id, due), runId = 'run_cold';
  const snapshot = warm.api.schedulerOccurrenceSnapshot(task); snapshot.occurrence = { key, dueAt: new Date(due).toISOString(), mode: 'ontime' };
  task.state.inFlightRunId = runId; if (!legacyPrompt) task.state.inFlightSnapshot = snapshot; task.state.nextFireAt = new Date(due).toISOString();
  Object.assign(warm.api.schedulerRuntime, { loaded: true, tasks: [task] }); await warm.api.schedulerSaveTasks();
  for (const phase of ['registered', 'dispatched', 'running']) await warm.api.schedulerAppendFire({ taskId: task.id, runId, phase, occurrenceKey: key, dueAt: new Date(due).toISOString(), mode: 'ontime', sessionId: sid, ...(!legacyPrompt ? { snapshot } : {}) });
  const owner = { source: 'scheduler', driverRunId: 'driver_cold', requestMeta: { taskId: task.id, runId, occurrenceKey: key } };
  warm.context.turnSettlers.set(sid, owner);
  const session = { id: sid, turnSeq: 2, messages: [], providerHistory: [], launchedBy: 'steward', stewardLastTurn: { seq: 1, ok: true, quiet: true } };
  await warm.api.saveSession(session, { executionOwner: owner }); warm.context.turnSettlers.clear();
  if (legacy || legacyPrompt) { session.stewardLastTurn = { seq: 1, ok: true, quiet: true }; await warm.api.saveSession(session); }
  const initial = await warm.head(); assert.equal(initial.turnSeq, 2);
  const cipher = await fsp.readFile(path.join(sessions, sid + '.json'), 'utf8'); assert.equal(cipher.includes('scheduler_pending'), false); assert.equal(cipher.includes('PINNED_OLD_CONTENT'), false);
  return { directory, state, notices, warm, task, key, runId, snapshot, owner, initial, cold, close };
  } catch (error) { await close(); throw error; }
}
async function coldControls() {
  for (const newTarget of [false, true]) for (const order of ['collect-first', 'recover-first']) {
    const f = await fixture({ newTarget }); try {
      const c = await f.cold(); assert.equal(c.context.turnOutcomePending.size, 0); const rows = await c.api.schedulerLoad();
      let observed; if (order === 'collect-first') observed = await c.poll(); await c.api.schedulerRecover(rows); if (order === 'recover-first') observed = await c.poll();
      const head = await c.head(), receipts = await c.api.schedulerReadFireRows(), recovered = receipts.at(-1);
      assert.equal(recovered.outcome, 'unknown'); assert.equal(recovered.occurrenceKey, f.key); assert.equal(c.api.schedulerRuntime.lateQueue.length, 0); assert.equal(f.state.businessExecutions, 0);
      assert.ok(f.notices.some(row => row.kind === 'unknown'));
      if (flag) { assert.equal(observed.kind, 'done'); assert.equal(head.stewardLastTurn.seq, 1); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2); }
      else { assert.equal(observed, null); assert.equal(head.stewardLastTurn.scheduler.state, 'unknown'); assert.equal(recovered.sessionId, 'sess_cold'); assert.equal(recovered.turnSeq, 2); assert.equal(c.api.schedulerMergeRuns(receipts, 'sch_cold')[0].turnSeq, 2); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1); assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, ''); }
      assert.deepEqual(clone(recovered.snapshot), clone(f.snapshot));
      t.ok(true, (flag ? 'expected RED cold false done: ' : 'real M3 head/task/journal cold barrier: ') + (newTarget ? 'new target ' : 'existing target ') + order + ', original content/key and zero replay retained');
      if (!flag) {
        const restart = await f.cold(); await restart.api.schedulerLoad(); assert.equal(await restart.poll(), null); assert.equal(restart.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1);
        t.ok(true, order + ': unknown remains correlated after another cold VM and retired task');
      }
    } finally { await f.close(); }
  }
  if (flag) return;
  const appendFailure = await fixture(); try {
    const c = await appendFailure.cold(), rows = await c.api.schedulerLoad(); appendFailure.state.armFireFailure = true;
    await assert.rejects(c.api.schedulerRecover(rows)); assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'unknown'); assert.equal(await c.poll(), null);
    assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, appendFailure.runId);
    appendFailure.state.armFireFailure = false; appendFailure.state.failFires = false;
    const retry = await appendFailure.cold(), original = await retry.api.schedulerLoad(); await retry.api.schedulerRecover(original);
    assert.equal((await retry.api.schedulerReadFireRows()).at(-1).turnSeq, 2); assert.equal(await retry.poll(), null);
    t.ok(true, 'unknown head committed but fire append rejected: retained inFlight and cold retry preserve association without replay');
  } finally { await appendFailure.close(); }
  for (const reason of ['lost key', 'session write rejected']) {
    const f = await fixture(); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad();
      if (reason === 'lost key') f.state.lostKey = true; else f.state.failHead = true;
      await assert.rejects(c.api.schedulerRecover(rows)); assert.equal(await c.poll(), null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1);
      assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, f.runId);
      f.state.lostKey = false; f.state.failHead = false;
      const retry = await f.cold(), loaded = await retry.api.schedulerLoad(); await retry.api.schedulerRecover(loaded); assert.equal((await retry.head()).stewardLastTurn.scheduler.state, 'unknown'); assert.equal(await retry.poll(), null);
      assert.equal(f.state.businessExecutions, 0); t.ok(true, reason + ': original durable inFlight/pending survive rejection and cold retry');
    } finally { await f.close(); }
  }
  for (const outcome of ['quiet', 'changed', 'failed']) {
    const f = await fixture(); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad();
      const pending = (await c.head()).stewardLastTurn;
      const result = { ...pending, ok: outcome !== 'failed', quiet: outcome === 'quiet', errorClass: outcome === 'failed' ? 'source_missing' : '', scheduler: { ...pending.scheduler, state: 'settled' } };
      await c.api.updateSessionMeta('sess_cold', { stewardLastTurn: result }, { waitForCommit: true, expectedSchedulerOutcome: { ...pending.scheduler, seq: 2 } });
      await c.api.schedulerRecover(rows); const observed = await c.poll(); assert.equal(observed?.kind || null, outcome === 'quiet' ? null : outcome === 'changed' ? 'done' : 'failed');
      assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'settled'); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2);
      t.ok(true, 'confirmed durable ' + outcome + ' result survives unknown fire recovery and releases only its own turn');
    } finally { await f.close(); }
  }
  const f = await fixture(); try {
    const c = await f.cold(), rows = await c.api.schedulerLoad(); await c.api.schedulerRecover(rows);
    const head = await c.head(); head.turnSeq = 3; head.messages = []; head.providerHistory = [];
    c.context.turnOutcomePending.set('sess_cold', { outcomeSeq: 2 }); await c.api.saveSession(head);
    const ordinary = await c.poll(); assert.equal(ordinary.kind, 'done'); assert.equal(ordinary.seq, 3);
    t.ok(true, 'exact old unknown/pending seq2 does not block unrelated ordinary turn3');
  } finally { await f.close(); }
  const late = await fixture(); try {
    const c = await late.cold(), rows = await c.api.schedulerLoad(); await c.api.schedulerRecover(rows); const unknown = (await c.head()).stewardLastTurn;
    await c.api.updateSessionMeta('sess_cold', { stewardLastTurn: { ...unknown, ok: false, errorClass: 'source_missing', scheduler: { ...unknown.scheduler, state: 'settled' } } }, { waitForCommit: true, expectedSchedulerOutcome: { ...unknown.scheduler, state: ['pending', 'unknown'], seq: 2 } });
    assert.equal((await c.poll()).kind, 'failed'); t.ok(true, 'late genuine bound result is not swallowed by a consumed unknown cursor');
  } finally { await late.close(); }
  const newer = await fixture(); try {
    const c = await newer.cold(), rows = await c.api.schedulerLoad(), old = (await c.head()).stewardLastTurn;
    const head = await c.head(); head.turnSeq = 3; head.messages = []; head.providerHistory = [];
    head.stewardLastTurn = { seq: 3, ok: false, errorClass: 'new_ordinary_failure' }; await c.api.saveSession(head);
    await c.api.updateSessionMeta('sess_cold', { stewardLastTurn: { ...old, scheduler: { ...old.scheduler, state: 'unknown' } } }, { waitForCommit: true, expectedSchedulerOutcome: { ...old.scheduler, seq: 2 } });
    await c.api.schedulerRecover(rows); assert.equal((await c.head()).stewardLastTurn.errorClass, 'new_ordinary_failure'); assert.equal((await c.poll()).kind, 'failed');
    t.ok(true, 'metadata CAS and recovery cannot replace a newer ordinary turn/result or guess its identity');
  } finally { await newer.close(); }
}
function effectControls() {
  const fire = functionBlock(scheduler, 'schedulerFireOnce'), context = vm.createContext({ path, nowIso: () => '2026-10-30T09:00:00Z', meaningfulChange: false, pendingAsks: new Set(), permissionDenied: 0, costTokens: 0, askOpenSince: 0, askClosedMs: 0, askCapMs: 1000, executionFinished: false, timer: null, queueTimedOut: false, timedOut: false, task: { id: 'sch_effects', payload: { kind: 'playbook' } }, runId: 'run_effects', occKey: 'sch_effects@2026-10-30T09:00:00.000Z' });
  const source = shared('02f-turn-effect-kinds.js') + '\n' + constBlock(store, 'ARTIFACT_IMG_EXTS') + '\n' + names(store, ['asResultObject', 'kindForPath', 'buildTurnSummary']) + '\n' + functionBlock(scheduler, 'schedulerTurnOutcome') + '\n' + bracedBlock(fire, 'const onEvent = evt =>') + ';\n({summary:buildTurnSummary,onEvent,outcome:({' + bracedBlock(fire, 'schedulerOutcome: turn =>') + '}).schedulerOutcome})';
  const api = vm.runInContext(source, context, { timeout: 1000 });
  const cases = [
    ['read', [{ name: 'file_read', input: { path: 'C:/synthetic/a.txt' }, result: { ok: true, content: 'UNCHANGED' } }], [], true],
    ['noop command', [{ name: 'powershell_run', input: { command: "Write-Output 'UNCHANGED'" }, result: { ok: true, stdout: 'UNCHANGED', exitCode: 0 } }], [], true],
    ['idempotent write skip', [{ name: 'file_write', input: { path: 'C:/synthetic/a.txt' }, result: { ok: true, op: 'skip' } }], [], true],
    ['changed file', [{ name: 'file_write', input: { path: 'C:/synthetic/a.txt' }, result: { ok: true, op: 'modify' } }], [], false],
    ['journal artifact', [], [{ path: 'C:/synthetic/report.pdf', op: 'create', entrySeq: 1 }], false],
  ];
  for (const [label, records, journal, quiet] of cases) {
    context.meaningfulChange = false; const summary = api.summary(2, records, 'openai', journal); api.onEvent({ type: 'turn_summary', ...summary }); const result = api.outcome({ ok: true, turnSeq: 2, result: { ok: true } });
    const expected = flag && label === 'noop command' ? false : quiet; assert.equal(result.quiet === true, expected);
    if (label === 'noop command') { assert.equal(summary.commands, 1); assert.equal(summary.irreversible.length, 1); }
    t.ok(true, (flag && label === 'noop command' ? 'expected RED command count alerts despite unchanged result: ' : 'real summary/event/outcome: ') + label);
  }
  context.meaningfulChange = false; const failure = api.outcome({ ok: true, turnSeq: 2, result: { ok: false, errorClass: 'source_missing' } }); assert.equal(failure.ok, false); assert.equal(failure.quiet, undefined);
  t.ok(true, 'real failure remains non-quiet, command execution history retained; no shell text parser');
}
module.exports = { fixture };
if (require.main === module) (async () => { try { await coldControls(); effectControls(); } catch (error) { t.fail(error.stack || String(error)); } finally { t.done({ exit: true }); } })();
