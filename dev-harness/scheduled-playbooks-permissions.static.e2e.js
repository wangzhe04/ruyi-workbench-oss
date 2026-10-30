'use strict';
// Source-slice VM only: no server import, timers, engine, HTTP, provider, native
// process, key adapter or workspace-file tools. Capture functions are not real
// execution-success fixtures. --baseline-source supports an explicit old source
// tree for the two independent-review negative controls.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock, constBlock, bracedBlock } = require('./lib/source-slice');
const t = createRunner('SCHEDULED PLAYBOOK PERMISSIONS STATIC');
const repo = path.resolve(__dirname, '..'), src = path.join(repo, 'ruyi-workbench/app/src');
const oldFlag = process.argv.find(value => value.startsWith('--baseline-source='));
const baseline = oldFlag ? path.resolve(oldFlag.slice('--baseline-source='.length)) : null;
const read = name => fs.readFileSync(path.join(src, name), 'utf8');
const sched = baseline ? fs.readFileSync(path.join(baseline, '13s-scheduler.js'), 'utf8') : read('13s-scheduler.js');
const core = read('06i-steward-core.js'), modes = read('01e-permission-modes.js'), boot = read('00-boot.js');
const runtime = read('04-permission-runtime.js'), governance = read('10-context-governance.js'), decision = read('13d-core-domain-routes.js');
const provider = read('09-workflow.js'), tools = read('12-tool-dispatch.js'), autonomy = read('07-autonomy.js');
const fire = functionBlock(sched, 'schedulerFireOnce');
const bindingStart = fire.indexOf('    const task = executionTask;');
const bindingEnd = fire.indexOf('    const config = await readConfig();', bindingStart) + '    const config = await readConfig();'.length;
assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
const binding = fire.slice(bindingStart, bindingEnd);
const callStart = fire.indexOf('result = await runSessionTurn({'), callEnd = fire.indexOf('\n        });', callStart) + '\n        });'.length;
assert.ok(callStart > 0 && callEnd > callStart);
const dispatch = fire.slice(callStart, callEnd);
const common = constBlock(modes, 'PERMISSION_MODES') + '\n' + constBlock(core, 'STEWARD_PERMISSION_RANK') + '\n'
  + functionBlock(core, 'stewardPermissionRank') + '\n'
  + functionBlock(sched, 'schedulerPermissionModeFor') + '\n' + functionBlock(sched, 'schedulerOccurrenceSnapshot') + '\n'
  + functionBlock(read('06j-scheduler-core.js'), 'occurrenceKey');
function fixture(snapshotMode = 'auto', liveMode = snapshotMode, globalMode = 'auto') {
  let captured, effects = 0, eventCount = 0, storageFailure = null;
  const config = { permissionMode: globalMode };
  const live = { id: 'sch_control', title: 'Original content', revision: 1, schedule: { kind: 'daily', at: '09:00', tz: 'UTC' },
    payload: { kind: 'playbook', playbookId: 'pb_original', revision: 'a'.repeat(64), text: 'PINNED_OLD_CONTENT' },
    target: { mode: 'new-session' }, autonomy: { permissionMode: snapshotMode }, policy: {}, state: { enabled: true, inFlightRunId: 'run_control' } };
  const context = vm.createContext({ console: { log() {} }, AbortController, schedulerRuntime: { tasks: [live] },
    readConfig: async () => ({ ...config }), schedulerLoad: async () => { if (storageFailure) throw storageFailure; },
    runSessionTurn: async body => { captured = body; return { captureOnly: true }; },
    sessionId: 'sess_control', session: { id: 'sess_control', cwd: 'C:/synthetic-unused' }, runId: 'run_control', schedMode: 'late', schedTask: live,
    onEvent: () => { eventCount++; },
    activeChildren: new Map(), stopSession: () => { throw Error('no actual engine capability'); },
    executionAbort: new AbortController(), settleResolve: null, driverRunId: 'driver_control', turnStopped: false,
    makeId: () => 'permission_control', toolIsRevertible: () => true,
    registerIntervention() {}, settleIntervention() {}, pendingPermissions: new Map(),
    setTimeout: fn => ({ callbackOnly: fn }), clearTimeout() {}, schedulerAskWaitOverrideMs: () => 1000, promptWaitMs: () => 1000,
    TOOL_HANDLERS: { file_write: { handler: () => { effects++; return { captureOnly: true }; } } },
    NATIVE_COMMAND_TOOL_NAMES: new Set(), NATIVE_DESKTOP_TOOL_NAMES: new Set(),
    nativeToolDisabledByPolicy: () => '', normalizeMetaToolArgs: (_name, args) => args, validateNativeToolArgs: () => null,
  });
  let source = common;
  if (!baseline) source += '\n' + constBlock(boot, 'RUYI_EVENT_SUBSCRIBERS') + '\n' + constBlock(boot, 'RUYI_EVENTS') + '\n'
    + constBlock(runtime, 'turnSettlers') + '\n' + functionBlock(runtime, 'assertSessionExecutionOwner') + '\n'
    + functionBlock(runtime, 'revalidateSessionExecutionPermission') + '\n' + functionBlock(sched, 'schedulerExecutionAuthority') + '\n'
    + functionBlock(autonomy, 'requestNativePermission') + '\n' + functionBlock(tools, 'toolCall');
  const names = ['schedulerOccurrenceSnapshot', 'schedulerPermissionModeFor', 'occurrenceKey', 'stewardPermissionRank'];
  if (!baseline) names.push('schedulerExecutionAuthority', 'RUYI_EVENTS', 'turnSettlers', 'revalidateSessionExecutionPermission', 'requestNativePermission', 'toolCall');
  const api = vm.runInContext(source + '\n({' + names.join(',') + '});', context, { timeout: 1000 });
  const snapshot = api.schedulerOccurrenceSnapshot(live), original = JSON.stringify(snapshot);
  live.autonomy.permissionMode = liveMode; live.revision = 2;
  const key = api.occurrenceKey(live.id, Date.parse('2026-10-30T09:00:00Z'));
  context.executionTask = snapshot; context.occKey = key;
  let authority = null;
  const dispatchActual = async () => {
    const authorityLine = baseline ? '' : fire.slice(fire.indexOf('      const authority = '), fire.indexOf('\n', fire.indexOf('      const authority = ')));
    assert.ok(baseline || authorityLine.includes('schedulerExecutionAuthority'));
    await vm.runInContext('(async()=>{\n' + binding + '\nlet result;\n' + authorityLine + '\n' + dispatch + '\n})()', context, { timeout: 1000 });
    authority = captured.executionAuthority;
    if (!baseline) {
      context.body = captured; context.source = 'scheduler';
      const ownerSource = constBlock(governance, 'settleEntry');
      const owner = vm.runInContext('(function(){' + ownerSource + '\nreturn settleEntry;})()', context, { timeout: 1000 });
      api.turnSettlers.set(context.sessionId, owner);
      context.owner = owner;
    }
    assert.equal(captured.message, snapshot.payload.text); assert.equal(captured.requestMeta.playbookRevision, snapshot.payload.revision);
    assert.equal(captured.requestMeta.occurrenceKey, key); assert.equal(JSON.stringify(snapshot), original);
    return captured;
  };
  const emitTask = () => api.RUYI_EVENTS.emit('schedule.changed', { taskId: live.id });
  const emitGlobal = value => { config.permissionMode = value; api.RUYI_EVENTS.emit('config.written', { schedulerEnabledV1: true, permissionMode: value }); };
  return { api, context, live, config, snapshot, key, dispatchActual, emitTask, emitGlobal,
    captured: () => captured, effects: () => effects, eventCount: () => eventCount,
    loseStorage: () => { storageFailure = Object.assign(Error('synthetic missing key'), { code: 'work_data_key.absent' }); },
    invariant() { assert.equal(JSON.stringify(snapshot), original); assert.equal(captured.requestMeta.occurrenceKey, key); },
    close() { if (authority) authority.dispose(); },
  };
}
async function pendingDecision(f) {
  const answer = f.api.requestNativePermission(f.context.sessionId, 'file_write', { path: 'C:/synthetic-unused/old.md' }, f.context.onEvent, 1000, 'edit', null);
  const entry = f.context.pendingPermissions.get('permission_control'); assert.ok(entry);
  Object.assign(f.context, { type: 'permission', action: 'allow', payload: {}, missionId: f.context.sessionId, interventionId: 'permission_control', runtimeEntry: entry });
  const text = functionBlock(decision, 'decideIntervention');
  const preflight = bracedBlock(text, 'const preflight = async authoritative =>') + ';', execute = bracedBlock(text, 'const execute = () =>') + ';';
  const resolverStart = text.indexOf('resolveStatus: ') + 'resolveStatus: '.length;
  const resolverEnd = text.indexOf(',\n        extra:', resolverStart);
  assert.ok(resolverEnd > resolverStart);
  const parts = vm.runInContext('(function(){' + preflight + '\n' + execute + '\nreturn {preflight, execute, status:' + text.slice(resolverStart, resolverEnd) + '};})()', f.context, { timeout: 1000 });
  return { answer, entry, parts };
}
const revoked = error => error && ['SCHEDULER_AUTHORITY_REVOKED', 'STEWARD_TURN_CANCELLED'].includes(error.code);
(async () => {
  try {
    const cases = [
      ['unchanged', 'auto', 'auto', 'auto', 'auto'],
      ['old auto / live plan', 'auto', 'plan', 'auto', 'plan'],
      ['old acceptEdits / live default', 'acceptEdits', 'default', 'auto', 'default'],
      ['global plan', 'auto', 'auto', 'plan', 'plan'],
      ['old narrower snapshot', 'plan', 'auto', 'auto', 'plan'],
    ];
    let violations = 0;
    for (const [name, snapshotMode, liveMode, globalMode, expected] of cases) {
      const f = fixture(snapshotMode, liveMode, globalMode);
      const captured = await f.dispatchActual();
      if (baseline && captured.permissionMode !== expected) { violations++; t.ok(!!['old auto / live plan', 'old acceptEdits / live default'].includes(name), 'expected RED old dispatch: ' + name + ' -> ' + captured.permissionMode); }
      else t.ok(captured.permissionMode === expected, 'actual rank + dispatch slice: ' + name + ' -> ' + expected);
      f.invariant(); f.close();
    }
    if (baseline) { assert.equal(violations, 2); t.ok(true, 'old candidate has exactly the two independently confirmed violations; original content/revision/key unchanged'); return; }
    for (const phase of ['before permission', 'pending decision', 'between decision and execute', 'between approval and handler']) {
      const f = fixture(); await f.dispatchActual();
      if (phase === 'before permission') {
        f.live.autonomy.permissionMode = 'plan'; f.emitTask();
        assert.throws(() => f.api.requestNativePermission(f.context.sessionId, 'file_write', {}, f.context.onEvent, 1000, 'edit'), revoked);
        assert.equal(f.eventCount(), 0);
      } else {
        const p = await pendingDecision(f);
        if (phase === 'between decision and execute') await p.parts.preflight({ type: 'permission' });
        if (phase === 'between approval and handler') {
          await p.parts.preflight({ type: 'permission' });
          const delivered = p.parts.execute(); assert.equal(delivered.ok, true); assert.equal((await p.answer).behavior, 'allow');
          f.context.PrivacyGateway = { active: () => true, assertToolChannel() {}, withExecution: async (_name, args, _ctx, invoke) => {
            f.live.autonomy.permissionMode = 'plan'; f.emitTask(); return invoke(args);
          } };
          await assert.rejects(() => f.api.toolCall('file_write', {}, { sessionId: f.context.sessionId, executionOwner: f.context.owner, config: {} }), revoked);
        } else {
          f.live.autonomy.permissionMode = 'plan'; f.emitTask();
          await p.parts.preflight({ type: 'permission' });
          const denied = p.parts.execute();
          assert.equal(p.parts.status(denied), 'denied'); assert.equal(denied.reason, 'authorization_revoked');
          assert.equal((await p.answer).behavior, 'deny');
        }
      }
      assert.equal(f.effects(), 0); f.invariant(); f.close(); t.ok(true, phase + ': narrowing rejects old authority with no handler call, old content/key retained');
    }
    for (const change of ['task default', 'global plan', 'deleted', 'paused', 'global plan then auto', 'task plan then auto']) {
      const f = fixture(); await f.dispatchActual();
      if (change === 'task default') { f.live.autonomy.permissionMode = 'default'; f.emitTask(); }
      if (change === 'global plan') f.emitGlobal('plan');
      if (change === 'global plan then auto') { f.emitGlobal('plan'); f.emitGlobal('auto'); }
      if (change === 'task plan then auto') { f.live.autonomy.permissionMode = 'plan'; f.emitTask(); f.live.autonomy.permissionMode = 'auto'; f.emitTask(); }
      if (change === 'deleted') { f.context.schedulerRuntime.tasks = []; f.emitTask(); }
      if (change === 'paused') { f.live.state.enabled = false; f.emitTask(); }
      await assert.rejects(() => f.api.revalidateSessionExecutionPermission(f.context.sessionId, f.context.owner), revoked);
      assert.equal(f.context.owner.cancelRequested, true); f.invariant(); f.close(); t.ok(true, change + ': original owner cancels and old authority cannot revive');
    }
    {
      const f = fixture(); await f.dispatchActual(); const p = await pendingDecision(f);
      f.loseStorage(); await assert.rejects(() => p.parts.preflight({ type: 'permission' }), error => error.code === 'work_data_key.absent');
      assert.equal(f.context.pendingPermissions.get('permission_control'), p.entry); assert.equal(f.effects(), 0);
      f.close(); t.ok(true, 'key/storage loss is refused before decision intent; original pending consumer retained');
    }
    {
      const f = fixture('default', 'auto', 'auto'); await f.dispatchActual(); const p = await pendingDecision(f);
      f.live.payload = { ...f.live.payload, text: 'NEW_FUTURE_CONTENT' }; f.live.revision++; f.emitTask(); f.emitGlobal('auto');
      await p.parts.preflight({ type: 'permission' }); assert.equal(p.parts.execute().ok, true); assert.equal((await p.answer).behavior, 'allow');
      assert.equal(f.captured().permissionMode, 'default'); f.invariant(); f.close();
      t.ok(true, 'future-only content edit keeps unchanged authorization/content/key; live/global widening never lifts the old default snapshot');
    }
    {
      const f = fixture(); f.live.state.enabled = false; f.context.schedMode = 'manual';
      await f.dispatchActual(); await f.api.revalidateSessionExecutionPermission(f.context.sessionId, f.context.owner);
      f.invariant(); f.close(); t.ok(true, 'an explicitly requested manual run of an already paused task keeps the existing contract');
    }
    {
      const f = fixture(); await f.dispatchActual(); let unrelatedCancelled = 0;
      f.api.turnSettlers.set(f.context.sessionId, { source: 'scheduler', requestMeta: { runId: 'another_run' }, cancel: () => { unrelatedCancelled++; } });
      f.live.autonomy.permissionMode = 'plan'; f.emitTask();
      await assert.rejects(() => f.api.revalidateSessionExecutionPermission(f.context.sessionId, f.context.owner), revoked);
      assert.equal(unrelatedCancelled, 0); f.invariant(); f.close(); t.ok(true, 'late revocation cannot cancel a different current execution owner');
    }
    {
      const f = fixture(); await f.dispatchActual();
      const answer = f.api.requestNativePermission(f.context.sessionId, 'file_write', {}, event => {
        if (event.type === 'permission_request') { f.live.autonomy.permissionMode = 'plan'; f.emitTask(); }
      }, 1000, 'edit');
      assert.equal((await answer).behavior, 'deny'); assert.equal(f.context.pendingPermissions.size, 0);
      assert.equal(f.effects(), 0); f.invariant(); f.close(); t.ok(true, 'synchronous revocation in permission event callback leaves no orphaned pending consumer');
    }
    {
      const f = fixture(); await f.dispatchActual(); f.context.schedulerRuntime.tasks = [];
      await assert.rejects(() => f.dispatchActual(), revoked); f.close(); t.ok(true, 'missing live task refuses submission rather than falling back to old snapshot');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { t.done({ exit: true }); }
})();
