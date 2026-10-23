'use strict';
// Real source consumers and shared codecs/atomic writer, synthetic owned key leases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { functionBlock, constBlock } = require('../lib/source-slice');
const { loadWorkDataJournals } = require('../lib/work-data-journals-fixture');
const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-aux-journal-'));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = { enabled: true, acquires: 0, releases: 0 }, master = crypto.randomBytes(32), logs = [], events = [];
  const io = { ...fsp, stat: async (file, options) => file === state.frozenFile && state.frozenStat ? state.frozenStat : fsp.stat(file, options), truncate: async (...args) => {
    if (state.failTruncate) throw Object.assign(Error('rollback denied'), { code: 'EIO' });
    return fsp.truncate(...args);
  }, open: async (file, mode, ...args) => {
    const handle = await fsp.open(file, mode, ...args);
    if (file === state.appendTarget && mode === 'a' && state.failAppend) {
      let writes = 0;
      return new Proxy(handle, { get(target, property) {
        if (property === 'write') return async (...writeArgs) => {
          if (++writes > 1) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
          return target.write(...writeArgs);
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    return new Proxy(handle, { get(target, property) {
      if (property === 'stat' && file === state.frozenFile && state.frozenStat) return async () => state.frozenStat;
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const shared = loadWorkDataJournals({ io });
  shared.WorkDataStore.Hooks.keys = { snapshot: async () => {
    state.acquires++; if (state.keyError) throw state.keyError;
    const key = Buffer.from(master);
    return { key, instanceId: state.instanceId || 'a'.repeat(32), release: () => { state.releases++; key.fill(0); } };
  } };
  const context = vm.createContext({ ...shared, require, Buffer, crypto, fs, fsp: io, path, zlib,
    structuredClone, setTimeout, clearTimeout, Date, process, console,
    paths: { data: dir, agentRuns: dir }, EventStreamHooks: {}, StewardHooks: {},
    STEWARD_EVENT_KINDS: ['needs_you','failed','done','stalled','budget','adopted','reminder'],
    RUYI_EVENTS: { emit: (...args) => events.push(args), subscribe() {} },
    readConfig: async () => ({ workDataEncryptionV1: state.enabled, stewardEnabledV1: true }),
    safeSessionId: value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) ? value : null,
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    nowIso: () => new Date().toISOString(), logEvent: row => logs.push(row),
    agentRunDir: () => dir, sessionAssociatedSaveIsTombstoned: () => false,
    readFileTail: async (file, count) => { const handle = await fsp.open(file, 'r'); try {
      const { size } = await handle.stat(), buf = Buffer.alloc(Math.min(size, count));
      const { bytesRead } = await handle.read(buf, 0, buf.length, Math.max(0, size - count)); return { buf, bytesRead };
    } finally { await handle.close(); } },
  });
  const i = source('13i-steward-inbox.js'), j = source('13j-steward-tool-base.js'), e = source('08-agent-runs.js');
  const names = ['agentRunEventsFile', 'agentRunEventsJournal', 'agentRunEventsArchiveStore', 'agentRunEventsArchiveText',
    'agentRunEventWindow', 'syncRunEventSeqWithin', 'syncRunEventSeq', 'appendAgentRunEvent', 'flushAgentRunEvents', 'parseEventWindow', 'readAgentRunEvents'];
  const jNames = ['stewardDecisionJournal', 'stewardPreflightDecision', 'stewardAppendDecision', 'stewardReadDecisionsLegacyText', 'stewardReadDecisionsText'];
  const archiveHook = e.slice(e.indexOf('EventStreamHooks.archiveAgentRunEvents ='), e.indexOf('// 对抗轮修(第25波): 从磁盘装载 run 后'));
  const code = [functionBlock(source('00-boot.js'), 'runKeyedChain'), functionBlock(source('02-session-store.js'), 'repairMissionChangeTornTail'), i,
    'const agentRunEventChains=new Map(), AGENT_RUN_EVENTS_TAIL_BYTES=512*1024, AGENT_RUN_EVENTS_PAGE_MAX=500;',
    ...names.map(name => functionBlock(e, name)), archiveHook,
    'const stewardDecisionsPath=()=>path.join(stewardDir(),"decisions-v1.ndjson");let stewardDecisionChain=Promise.resolve(),stewardDecisionSeq=0;',
    'const STEWARD_DECISIONS_FULL_READ_BYTES=8*1024*1024,STEWARD_DECISIONS_TAIL_BYTES=1024*1024;',
    ...jNames.map(name => functionBlock(j, name)),
    '({stewardRuntime,stewardInboxPath,stewardInboxJournal,stewardReadInboxRows,stewardAppendInboxRows,stewardInboxCounts,stewardLoadState,stewardMaintainInbox,stewardTickOnce,stewardCursorPath,stewardDecisionsPath,' + names.concat(jNames).join(',') + ',flushDecision:()=>stewardDecisionChain})'];
  const api = vm.runInContext(code.join('\n'), context);
  return { dir, state, master, context, api, logs, events, shared, io };
}
const row = seq => ({ inboxSeq: seq, kind: 'done', sessionId: 'sess_x', seq, at: new Date(0).toISOString(), payload: { summary: 'private-' + seq } });

test('counts memo skips only business parsing after fresh same-stat plaintext reads', async t => {
  const f = fixture(t); f.state.enabled = false;
  await fsp.mkdir(path.dirname(f.api.stewardInboxPath()), { recursive: true });
  await fsp.writeFile(f.api.stewardInboxPath(), JSON.stringify(row(1)) + '\n');
  let parses = 0; const parse = f.context.stewardParseInboxText;
  f.context.stewardParseInboxText = (...args) => { parses++; return parse(...args); };
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1);
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1); assert.equal(parses, 1);
  const file = f.api.stewardInboxPath(), before = await fsp.readFile(file);
  f.state.frozenFile = file; f.state.frozenStat = await fsp.stat(file, { bigint: true });
  const replacement = { ...row(1), kind: 'failed', payload: { summary: 'ivate-1' } };
  const changed = Buffer.from(JSON.stringify(replacement) + '\n'); assert.equal(changed.length, before.length);
  await fsp.writeFile(file, changed);
  const current = await f.api.stewardInboxCounts(); assert.equal(current.byKind.done, 0); assert.equal(current.byKind.failed, 1);
  assert.equal(current.inboxSeq, 1); assert.equal(parses, 2);
  await f.api.stewardInboxCounts(); assert.equal(parses, 2);
});

test('warm counts memo never authorizes same-stat damaged ciphertext or changed instance', async t => {
  const f = fixture(t); await f.api.stewardAppendInboxRows([row(1)]);
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1);
  const file = f.api.stewardInboxPath(), before = await fsp.readFile(file);
  f.state.frozenFile = file; f.state.frozenStat = await fsp.stat(file, { bigint: true });
  const damaged = JSON.parse(before.toString('utf8'));
  const ciphertext = damaged.e.envelope.ciphertext;
  damaged.e.envelope.ciphertext = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
  const bytes = Buffer.from(JSON.stringify(damaged) + '\n'); assert.equal(bytes.length, before.length); await fsp.writeFile(file, bytes);
  await assert.rejects(f.api.stewardInboxCounts(), { code: 'work_data_record.authenticate_failed' });
  assert.ok((await fsp.readFile(file)).equals(bytes));
  await fsp.writeFile(file, before); f.state.instanceId = 'b'.repeat(32);
  await assert.rejects(f.api.stewardInboxCounts(), error => String(error.code).startsWith('work_data_'));
  assert.ok((await fsp.readFile(file)).equals(before));
});

test('ON warm legacy counts acquire current keys before reusing a plaintext memo', async t => {
  const f = fixture(t); f.state.enabled = false;
  await fsp.mkdir(path.dirname(f.api.stewardInboxPath()), { recursive: true });
  await fsp.writeFile(f.api.stewardInboxPath(), JSON.stringify(row(1)) + '\n');
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1);
  f.state.enabled = true; assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1);
  const acquisitions = f.state.acquires;
  f.state.keyError = Object.assign(Error('missing'), { code: 'work_data_key.absent' });
  await assert.rejects(f.api.stewardInboxCounts(), { code: 'work_data_key.absent' });
  assert.equal(f.state.acquires, acquisitions + 1);
});

test('counts memo distinguishes identical window text with a dropped head', async t => {
  const f = fixture(t); f.state.enabled = false; const file = f.api.stewardInboxPath(); await fsp.mkdir(path.dirname(file), { recursive: true });
  const value = row(9); value.payload.summary = '';
  const tailBytes = 1024 * 1024, overhead = Buffer.byteLength(JSON.stringify(value) + '\n');
  value.payload.summary = 'x'.repeat(tailBytes - overhead);
  const text = JSON.stringify(value) + '\n'; assert.equal(Buffer.byteLength(text), tailBytes);
  await fsp.writeFile(file, text); assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1);
  // The original tail reader drops its first physical line even when the window
  // happens to begin exactly on a line boundary. Its bytes alone are not the key.
  await fsp.writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1) + '\n' + text);
  const current = await f.api.stewardInboxCounts(); assert.equal(current.byKind.done, 0); assert.equal(current.inboxSeq, 0);
});
test('real inbox warm reads/load and retention authenticate current bytes and current keys', async t => {
  const f = fixture(t); await f.api.stewardAppendInboxRows([row(1), row(2), row(3)]);
  const file = f.api.stewardInboxPath(); assert.equal((await fsp.readFile(file, 'utf8')).includes('private-'), false);
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 3); await f.api.stewardLoadState();
  const seen = [...f.api.stewardRuntime.seen], before = await fsp.readFile(file);
  f.state.keyError = Object.assign(Error('private error text'), { code: 'work_data_key.absent' });
  await assert.rejects(f.api.stewardInboxCounts(), { code: 'work_data_key.absent' });
  await assert.rejects(f.api.stewardLoadState(), { code: 'work_data_key.absent' });
  assert.deepEqual([...f.api.stewardRuntime.seen], seen); assert.ok((await fsp.readFile(file)).equals(before));
  f.state.keyError = null; await f.api.stewardMaintainInbox(Date.now());
  assert.deepEqual(Array.from(await f.api.stewardReadInboxRows(), value => value.inboxSeq), [3]);
  assert.equal(JSON.parse((await fsp.readFile(file, 'utf8')).trim()).e.seq, 0);
});
test('ON absent key stops the actual tick before collect, cursor or sequence mutation', async t => {
  const f = fixture(t); let collects = 0;
  f.context.stewardCollectEvents = async () => { collects++; f.api.stewardRuntime.cursor.agentRuns.run_x = 88; return { events: [], activeSessionIds: [], activeRunIds: [] }; };
  f.state.keyError = Object.assign(Error('missing'), { code: 'work_data_key.absent' });
  const before = structuredClone(f.api.stewardRuntime.cursor);
  await assert.rejects(f.api.stewardTickOnce(), { code: 'work_data_key.absent' });
  assert.equal(collects, 0); assert.deepEqual(structuredClone(f.api.stewardRuntime.cursor), before); assert.equal(f.api.stewardRuntime.inboxSeq, 0);
  assert.equal(fs.existsSync(f.api.stewardCursorPath()), false);
});
test('actual event append/read/recovery separates business seq from physical ordinal and does not advance failed receipts', async t => {
  const f = fixture(t), run = { id: 'run_test', sessionId: 'sess_x', eventSeq: 900 };
  f.api.appendAgentRunEvent(run, { type: 'node_progress', data: { text: 'x'.repeat(1100000) } });
  f.api.appendAgentRunEvent(run, { type: 'run_end' }); await f.api.flushAgentRunEvents(run.id);
  const result = await f.api.readAgentRunEvents(run.sessionId, run.id, 900, 50);
  assert.deepEqual(Array.from(result.events, value => value.seq), [901, 902]); assert.equal(run.eventSeq, 902);
  const recovered = { ...run, eventSeq: 0 }; await f.api.syncRunEventSeq(recovered); assert.equal(recovered.eventSeq, 902);
  const before = await fsp.readFile(f.api.agentRunEventsFile(run.sessionId, run.id));
  f.state.keyError = Object.assign(Error('private error text'), { code: 'work_data_key.absent' });
  f.api.appendAgentRunEvent(run, { type: 'after_effect' }); await f.api.flushAgentRunEvents(run.id);
  assert.equal(run.eventSeq, 902); assert.ok((await fsp.readFile(f.api.agentRunEventsFile(run.sessionId, run.id))).equals(before));
  await assert.rejects(f.api.syncRunEventSeq(recovered), { code: 'work_data_key.absent' });
  assert.equal(JSON.stringify(f.logs).includes('private error text'), false);
});
test('actual gzip maintenance seals and validates archive before retiring source; locked fallback hard fails', async t => {
  const f = fixture(t), run = { id: 'run_archive', sessionId: 'sess_x', eventSeq: 0 };
  f.api.appendAgentRunEvent(run, { type: 'run_end', data: { secret: 'archive-private' } }); await f.api.flushAgentRunEvents(run.id);
  const file = f.api.agentRunEventsFile(run.sessionId, run.id);
  assert.equal(await f.context.EventStreamHooks.archiveAgentRunEvents(run.sessionId, run.id), true);
  assert.equal(fs.existsSync(file), false); const archive = await fsp.readFile(file + '.gz');
  assert.notEqual(archive[0], 0x1f); assert.equal(archive.includes(Buffer.from('archive-private')), false);
  assert.equal((await f.api.readAgentRunEvents(run.sessionId, run.id, 0, 50)).events[0].data.secret, 'archive-private');
  f.state.keyError = Object.assign(Error('missing'), { code: 'work_data_key.absent' });
  await assert.rejects(f.api.readAgentRunEvents(run.sessionId, run.id, 0, 50), { code: 'work_data_key.absent' });
  assert.ok((await fsp.readFile(file + '.gz')).equals(archive));
  f.state.keyError = null; f.state.enabled = false;
  await assert.rejects(f.api.syncRunEventSeq({ ...run, eventSeq: 0 }), { code: 'work_data_journal.downgrade_refused' });
});
test('completed action decision receipt failure is code-only and does not allocate a committed sequence', async t => {
  const f = fixture(t); let effects = 1;
  f.state.keyError = Object.assign(Error('private synthetic detail'), { code: 'work_data_key.absent' });
  const receipt = f.api.stewardAppendDecision({ tool: 'after_effect', args: { secret: 'synthetic' } });
  await f.api.flushDecision(); assert.equal(effects, 1); assert.equal(receipt.seq, 0); assert.equal(fs.existsSync(f.api.stewardDecisionsPath()), false);
  assert.equal(JSON.stringify(f.logs).includes('private synthetic detail'), false);
  f.state.keyError = null; const committed = f.api.stewardAppendDecision({ tool: 'next', args: {} }); await f.api.flushDecision();
  assert.equal(committed.seq, 1); assert.equal(JSON.parse((await f.api.stewardReadDecisionsText()).text).seq, 1);
});
test('actual workflow resume authenticates event journal before changing queued nodes or invoking business work', async t => {
  const f = fixture(t); Object.assign(f.context, { getAgentRoleLibrary: async () => [], normalizeCwd: value => value,
    activeAgentRuns: new Map(), resumeInFlight: new Set(), sessionSaveIsTombstoned: () => false });
  const workflow = vm.runInContext(functionBlock(source('09-workflow.js'), 'runAgentWorkflow') + '\nrunAgentWorkflow;', f.context);
  f.state.keyError = Object.assign(Error('missing'), { code: 'work_data_key.absent' });
  const run = { id: 'run_resume', sessionId: 'sess_x', eventSeq: 7, nodes: [{ id: 'n1', status: 'failed', error: 'old' }] };
  await assert.rejects(workflow({ parentSession: { id: 'sess_x', cwd: f.dir }, config: {}, existingRun: run }), { code: 'work_data_key.absent' });
  assert.equal(run.nodes[0].status, 'failed'); assert.equal(run.nodes[0].error, 'old'); assert.equal(run.eventSeq, 7);
  assert.equal(f.context.resumeInFlight.size, 0);
});
test('actual tick rebuilds committed partial batch seq/seen before retrying the remaining source events', async t => {
  const f = fixture(t), runtime = f.api.stewardRuntime;
  let candidates = [];
  f.context.stewardCollectEvents = async () => {
    const events = candidates.filter(event => event.seq > (runtime.cursor.missionChanges[event.sessionId] || 0));
    for (const event of events) runtime.cursor.missionChanges[event.sessionId] = event.seq;
    return { events, activeSessionIds: ['sess_a', 'sess_b'], activeRunIds: [] };
  };
  await f.api.stewardTickOnce(); const cursor = await fsp.readFile(f.api.stewardCursorPath());
  candidates = [{ kind: 'done', sessionId: 'sess_a', seq: 101, at: new Date().toISOString(), payload: { summary: 'first' } },
    { kind: 'done', sessionId: 'sess_b', seq: 102, at: new Date().toISOString(), payload: { summary: 'x'.repeat(200000) } }];
  f.state.appendTarget = f.api.stewardInboxPath(); f.state.failAppend = true; f.state.failTruncate = true;
  await assert.rejects(f.api.stewardTickOnce(), { code: 'work_data_journal.recovery_required' });
  assert.equal(runtime.inboxSeq, 0); assert.deepEqual(Object.keys(runtime.cursor.missionChanges), []);
  assert.ok((await fsp.readFile(f.api.stewardCursorPath())).equals(cursor));
  assert.equal((await f.api.stewardInboxCounts()).byKind.done, 1); assert.equal(f.api.stewardInboxJournal().recoveryPending(), true);
  f.state.failAppend = false; f.state.failTruncate = false;
  let leasesAtDispatch;
  f.context.StewardHooks.onInboxBatch = () => { leasesAtDispatch = [f.state.acquires, f.state.releases]; };
  assert.equal((await f.api.stewardTickOnce()).written, 1);
  assert.deepEqual(Array.from(await f.api.stewardReadInboxRows(), value => [value.inboxSeq, value.seq]), [[1, 101], [2, 102]]);
  assert.equal(f.api.stewardInboxJournal().recoveryPending(), false); assert.equal(leasesAtDispatch[0], leasesAtDispatch[1]);
});
test('actual decision producer tool gate blocks effects but completed user stop remains a truthful receipt', async t => {
  const f = fixture(t), g = source('13g-steward.js'), h = source('13h-steward-runner.js'); let effects = 0;
  Object.assign(f.context, { stewardCtxIsSteward: () => true, stewardArgTypeProblems: () => [],
    stewardAuthorizeExternalContext: async value => value, stewardWithTurnTrigger: value => value, stewardTaintGateApplies: () => false,
    stewardFail: (error, message) => ({ ok: false, error, message }), stewardReadSessionHead: async id => ({ id, kind: 'task' }),
    stewardRawKind: head => head.kind, stewardThreadPermissionMode: () => 'auto',
    stewardArbiterPrioritize: () => { effects++; return { ok: true, prioritized: true }; },
    waitReasonFor: () => null, stewardArbiterWait: () => null });
  vm.runInContext([constBlock(g, 'STEWARD_DECISION_TOOLS'), functionBlock(g, 'stewardToolHandler'),
    functionBlock(h, 'stewardImplThreadPrioritize'), functionBlock(h, 'stewardAppendUserStop')].join('\n'), f.context);
  f.state.keyError = Object.assign(Error('private key error detail'), { code: 'work_data_key.absent' });
  const tool = f.context.stewardToolHandler('steward_thread_prioritize', f.context.stewardImplThreadPrioritize);
  assert.equal((await tool({ sessionId: 'sess_x' }, {})).error, 'work_data_key.absent'); assert.equal(effects, 0);
  const stopped = await f.context.stewardAppendUserStop('sess_x', { stopped: true });
  assert.equal(stopped, true); await f.api.flushDecision(); assert.equal(fs.existsSync(f.api.stewardDecisionsPath()), false);
  assert.equal(JSON.stringify(f.logs).includes('private key error detail'), false);
});
test('current source is reauthenticated after archive verification despite complete stat collisions', async t => {
  for (const replacement of ['tampered', 'different']) {
    const f = fixture(t), run = { id: 'run_retire', sessionId: 'sess_x', eventSeq: 0 };
    f.api.appendAgentRunEvent(run, { type: 'run_end', data: { secret: 'archive-a' } }); await f.api.flushAgentRunEvents(run.id);
    const file = f.api.agentRunEventsFile(run.sessionId, run.id), before = await fsp.readFile(file, 'utf8');
    f.state.frozenFile = file; f.state.frozenStat = await fsp.stat(file, { bigint: true });
    let changed;
    if (replacement === 'tampered') {
      const row = JSON.parse(before), cipher = row.e.envelope.ciphertext;
      row.e.envelope.ciphertext = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1); changed = JSON.stringify(row) + '\n';
    } else {
      const body = JSON.parse((await f.api.agentRunEventsJournal(run.sessionId, run.id).readWindow(Infinity, 1)).text);
      body.data.secret = 'archive-b';
      const factory = f.shared.WorkDataRecords.encodeRecordFactory(JSON.stringify(body), f.master,
        { kind: 'agent-run-events', sessionId: run.sessionId, runId: run.id, ordinal: 0, instanceId: 'a'.repeat(32) }, 256 * 1024 * 1024);
      changed = ''; try { for await (const part of factory()) changed += part; } finally { factory.dispose(); }
    }
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(before));
    const readArchive = f.context.agentRunEventsArchiveText; let changedOnce = false;
    f.context.agentRunEventsArchiveText = async (...args) => {
      const result = await readArchive(...args);
      if (!changedOnce) { changedOnce = true; await fsp.writeFile(file, changed); }
      return result;
    };
    await assert.rejects(f.context.EventStreamHooks.archiveAgentRunEvents(run.sessionId, run.id),
      { code: replacement === 'tampered' ? 'work_data_record.authenticate_failed' : 'work_data_journal.source_changed' });
    assert.equal(await fsp.readFile(file, 'utf8'), changed); assert.equal(changedOnce, true);
  }
});
test('boot interruption and auto-resume stop before mailbox, node, pool, sequence or launch effects', async t => {
  const f = fixture(t), e = source('08-agent-runs.js'); await fsp.mkdir(path.join(f.dir, 'sess_boot'));
  const run = { id: 'run_boot', sessionId: 'sess_boot', status: 'running', eventSeq: 4,
    nodes: [{ id: 'n1', status: 'running' }], messages: [{ deliveredAt: null, dropped: false }],
    taskPool: [{ id: 'p1', status: 'proposed' }] };
  let saves = 0, settlements = 0, launches = 0;
  Object.assign(f.context, { listAgentRuns: async () => [run], activeAgentRuns: new Map(),
    readConfig: async () => ({ workDataEncryptionV1: true, autonomyAutoResume: true }),
    saveAgentRun: async () => { saves++; }, settleIntervention: () => { settlements++; },
    launchPersistedAgentRun: async () => { launches++; }, agentRunPermissionMode: async () => 'auto',
    classifyRunResumeTier: () => ({ tier: 'auto_resumable', reasons: [] }) });
  vm.runInContext([constBlock(e, 'AUTO_RESUME_MAX'), functionBlock(e, 'mapPool'),
    functionBlock(e, 'markInterruptedAgentRuns'), functionBlock(e, 'autoResumeInterruptedRuns')].join('\n'), f.context);
  f.state.keyError = Object.assign(Error('absent'), { code: 'work_data_key.absent' });
  const before = structuredClone(run); await f.context.markInterruptedAgentRuns(); assert.deepEqual(run, before);
  run.status = 'interrupted'; await f.context.autoResumeInterruptedRuns();
  assert.equal(run.status, 'interrupted'); assert.equal(run.autoResumeCount, undefined); assert.equal(run.eventSeq, 4);
  assert.equal(saves + settlements + launches, 0);
});
test('direct arbiter HTTP and memory panel consumers authenticate decisions before their actual mutation callback', async t => {
  const f = fixture(t), g = source('13g-steward.js'), h = source('13h-steward-runner.js'); let effects = 0;
  Object.assign(f.context, { tokenOk: () => true, readJsonBody: async () => ({ sessionId: 'sess_x' }),
    stewardImplThreadPrioritize: async () => { effects++; return { ok: true }; }, stewardFail: error => ({ ok: false, error }),
    stewardSanitizeText: value => String(value || ''), memoryProposalLooksSensitive: () => false,
    STEWARD_MEMORY_KINDS: ['fact'], STEWARD_MEMORY_LIMITS: { textChars: 1000 },
    stewardMutateMemory: async () => { effects++; return { ok: true }; } });
  vm.runInContext([functionBlock(h, 'handleStewardRunnerApiRoutes'), functionBlock(g, 'stewardMemoryPanelEdit'),
    functionBlock(g, 'stewardMemoryPanelRestore'), functionBlock(g, 'stewardMemoryPanelClear')].join('\n'), f.context);
  f.state.keyError = Object.assign(Error('absent'), { code: 'work_data_key.absent' });
  await assert.rejects(f.context.handleStewardRunnerApiRoutes({ method: 'POST' }, {}, '/api/steward/arbiter/prioritize'), { code: 'work_data_key.absent' });
  for (const mutate of [() => f.context.stewardMemoryPanelEdit({ id: 'm1', text: 'synthetic', kind: 'fact' }),
    () => f.context.stewardMemoryPanelRestore('m1'), () => f.context.stewardMemoryPanelClear('clear')])
    await assert.rejects(mutate, { code: 'work_data_key.absent' });
  assert.equal(effects, 0);
});
