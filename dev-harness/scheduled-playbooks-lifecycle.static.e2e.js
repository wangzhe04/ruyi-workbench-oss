'use strict';
// Genuine UI continuations, turn finalizer, metadata chain and inbox collector
// in capability-free VMs. Deferred values model I/O ordering; no module executes
// a server, engine, HTTP request, browser, native tool, scheduler or real timer.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock, constBlock, bracedBlock, sliceBlock } = require('./lib/source-slice');
const t = createRunner('SCHEDULED PLAYBOOK LIFECYCLE STATIC');
const repo = path.resolve(__dirname, '..');
const flag = process.argv.find(arg => arg.startsWith('--baseline-root='));
const root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : repo;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const src = name => read('ruyi-workbench/app/src/' + name);
// The unchanged keyed-chain owner is shared by both candidate generations.
const boot = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/00-boot.js'), 'utf8');
const ui = read('ruyi-workbench/app/public/js/steward-settings.js'), scheduler = src('13s-scheduler.js');
const navigation = read('ruyi-workbench/app/public/js/navigation-controls.js');
const provider = src('06-provider-engine.js'), core = src('06i-steward-core.js'), calendar = src('06j-scheduler-core.js');
const inbox = src('13i-steward-inbox.js'), store = src('02-session-store.js'), governance = src('10-context-governance.js');
const fire = functionBlock(scheduler, 'schedulerFireOnce');
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
const normalize = vm.runInNewContext(['PLAYBOOK_INPUT_TYPES', 'PLAYBOOK_REQUIRES', 'PLAYBOOK_SERVICES', 'PLAYBOOK_REUSE_OPEN'].map(n => constBlock(provider, n)).join('\n')
  + '\n' + ['normalizePlaybookReuse', 'playbookReuseTemplate', 'normalizePlaybook'].map(n => functionBlock(provider, n)).join('\n') + '\nnormalizePlaybook', { crypto: require('node:crypto') }, { timeout: 1000 });
function node(tag = 'input', value = '') {
  const listeners = new Map();
  return { tag, value, hidden: false, dataset: {}, children: [], options: [], classList: { add() {} }, addEventListener(name, fn) { listeners.set(name, fn); }, dispatchEvent(event) { listeners.get(event.type)?.(event); }, appendChild(child) { this.children.push(child); if (this.tag === 'select') { this.options.push(child); if (this.options.length === 1) this.value = child.value; } return child; },
    querySelectorAll(selector) { const out = []; const visit = n => { if (selector === '[data-input-key]' && n.dataset.inputKey) out.push(n); for (const child of n.children || []) visit(child); }; visit(this); return out; } };
}
function editor() {
  const nodes = {};
  nodes.settingsModal = node('div');
  for (const name of ['Form', 'Title', 'Kind', 'At', 'Date', 'Dom', 'Cron', 'Timezone', 'PayloadKind', 'Text', 'Target', 'Permission', 'Tier', 'OnMissed', 'Grace', 'SessionId', 'Playbook', 'Inputs', 'Checks', 'Preview', 'SubmitBtn', 'FormError', 'DaysBlock']) nodes['cfgStewardSchedule' + name] = node(['SessionId', 'Playbook'].includes(name) ? 'select' : 'input');
  nodes.cfgStewardScheduleDate.value = '2026-11-01'; nodes.cfgStewardScheduleKind.value = 'daily';
  const templates = ['A', 'B'].map(x => normalize({ id: 'pb_' + x, title: 'Template ' + x, promptTemplate: 'Read {material} for ' + x, requires: [], inputs: [{ key: 'material', label: 'Material', type: 'file', required: true }] }));
  const tasks = templates.map((template, i) => { const x = ['A', 'B'][i]; return { id: 'sch_' + x, title: 'Task ' + x, schedule: { kind: 'daily', at: '09:00', tz: 'UTC' }, payload: { kind: 'playbook', template, playbookId: template.id, revision: template.revision, values: { material: 'C:/synthetic/' + x + '.txt' }, checks: ['Check ' + x] }, target: { mode: 'existing-session', sessionId: 'sess_' + x }, autonomy: { permissionMode: 'plan' }, policy: { onMissed: 'run-once-late', graceMinutes: 720 } }; });
  const missions = { missions: tasks.map((task, i) => ({ sessionId: task.target.sessionId, title: 'Target ' + ['A', 'B'][i] })) };
  const requests = { missions: [], playbooks: [], preview: [], save: [] };
  const context = vm.createContext({ byId: id => nodes[id], $: id => nodes[id], Event, _modalTriggers: new WeakMap(), modalReturnTarget: () => null, el: (tag, _cls, text) => Object.assign(node(tag), { textContent: text }), clear: n => { n.children = []; n.options = []; n.value = ''; }, t: key => key, stewardErrorText: String, scheduleErrorReason: () => 'failed', lang: () => 'en', scheduleRows: tasks, loadSchedule: async () => {},
    api: route => { const d = defer(); const kind = route.startsWith('/api/missions') ? 'missions' : route === '/api/playbooks' ? 'playbooks' : route.endsWith('/preview') ? 'preview' : 'save'; requests[kind].push(d); return d.promise; } });
  // This is the real combined declaration, not a duplicate state model.
  const start = ui.indexOf("  let scheduleEditingId = ''"), end = ui.indexOf(';', start) + 1;
  assert.ok(start > 0 && end > start);
  const source = ['SCHEDULE_KIND_FIELDS', 'SCHEDULE_FIELD_BLOCKS', 'SCHEDULE_TASKS_PATH'].map(n => constBlock(ui, n)).join('\n') + '\n' + ui.slice(start, end)
    + '\n' + ['syncScheduleForm', 'fillScheduleSessions', 'fillScheduleInputs', 'schedulePlaybookDraft', 'fillSchedulePlaybooks', 'editSchedule', 'scheduleFormPlan', 'scheduleFormBody', 'toggleScheduleForm', 'scheduleFormError', 'previewSchedule', 'submitScheduleOnce'].map(n => functionBlock(ui, n)).join('\n');
  const api = vm.runInContext(source + '\n({editSchedule,scheduleFormBody,toggleScheduleForm,previewSchedule,submitScheduleOnce,fillSchedulePlaybooks});', context, { timeout: 1000 });
  const newStart = ui.indexOf('    if (newSchedule) newSchedule.onclick ='), newEnd = ui.indexOf('\n', newStart);
  assert.ok(newStart > 0); context.newSchedule = {};
  vm.runInContext(ui.slice(newStart, newEnd), context, { timeout: 1000 });
  const create = () => context.newSchedule.onclick();
  const closeListener = ui.split('\n').find(line => line.includes("byId('settingsModal')?.addEventListener('ruyi:modalclosed'"));
  if (closeListener) vm.runInContext(closeListener, context, { timeout: 1000 });
  vm.runInContext(functionBlock(navigation, 'closeModal'), context, { timeout: 1000 });
  return { context, api, nodes, tasks, templates, requests, missions, create, close: () => vm.runInContext("closeModal('settingsModal')", context, { timeout: 1000 }), body: () => plain(api.scheduleFormBody()), async mission(index) { requests.missions[index].resolve(missions); await flush(); }, async template(index, rows = templates) { requests.playbooks[index].resolve({ playbooks: rows }); await flush(); } };
}
async function accepted(f, body) {
  const context = vm.createContext({ crypto: require('node:crypto'), StewardHooks: { normalizePlaybook: normalize, loadAllPlaybooks: async () => f.templates } });
  const api = vm.runInContext(calendar + '\n' + functionBlock(core, 'stewardAssemblePlaybookPrompt') + '\n' + functionBlock(scheduler, 'schedulerNormalizePlaybookPayload') + '\nSchedulerHooks.normalizePlaybookPayload=schedulerNormalizePlaybookPayload;\n' + functionBlock(scheduler, 'schedulerBindPlaybookBody') + '\n({schedulerBindPlaybookBody,normalizeSchedulerTask})', context, { timeout: 1000 });
  const bound = await api.schedulerBindPlaybookBody(body, f.tasks[1]);
  const normalized = api.normalizeSchedulerTask({ ...f.tasks[1], ...bound }, Date.parse('2026-10-30T08:00:00Z'));
  assert.equal(normalized.ok, true); return normalized.task;
}
const collectorSource = ['STEWARD_EVENT_KINDS', 'STEWARD_SOURCE_EVENT_MAP', 'STEWARD_SUMMARY_CHARS', 'STEWARD_RUN_TERMINAL', 'STEWARD_ACTIVE_WINDOW_MS', 'stewardHeldTurnSessions'].map(n => constBlock(inbox, n)).join('\n')
  + '\n' + ['stewardResolveMissionResultKind', 'stewardResolveRunEndKind', 'stewardResolveNodeSettledKind', 'stewardResolveSessionTurnKind'].map(n => functionBlock(inbox, n)).join('\n') + '\n' + constBlock(inbox, 'STEWARD_KIND_RESOLVERS')
  + '\n' + ['stewardKindFor', 'stewardClipSummary', 'stewardIsoAt', 'stewardNormalizeSessionTurn', 'stewardThreadBackgroundBusy', 'stewardCollectSessionTurn'].map(n => functionBlock(inbox, n)).join('\n')
  + '\n' + ['stewardCoveringLastTurn', 'stewardWatchedThread'].map(n => functionBlock(core, n)).join('\n');
const finalizeSlice = sliceBlock(functionBlock(governance, 'runSessionTurn'), '    const outcomeId = session.id;', '    // 116-5a(§11.8.4)');
assert.ok(finalizeSlice.includes('turnSettlers.delete(session.id)'));
function publication({ failed = false, meaningfulChange = false, source = 'scheduler', stopped = false, denied = 0, loadError = null, missing = false, holdWake = false } = {}) {
  let head = { id: 'sess_existing', turnSeq: 2, launchedBy: 'steward', updatedAt: '2026-10-30T09:00:00Z', stewardLastTurn: { seq: 1, ok: true, quiet: true } };
  const runtime = { cold: false, cursor: { sessionTurns: { sess_existing: { turnSeq: 1, stamp: 'previous' } } }, sourcesSeen: { sessionTurns: 0 } };
  const writes = [], timers = [], wake = defer(), owner = { source, driverRunId: 'owned', cancelRequested: stopped, requestMeta: { taskId: 'sch_owned', runId: 'run_owned', occurrenceKey: 'sch_owned@2026-10-30T09:00:00.000Z' } };
  const context = vm.createContext({ session: { ...plain(head), kind: 'thread' }, source, body: {}, settleEntry: owner, lastResult: { ok: !failed, aborted: stopped, errorClass: failed ? 'source_missing' : '' }, turnError: '', turnStopped: stopped,
    todosStartSig: '', STEWARD_SESSION_ID: 'steward', turnSettlers: new Map([[head.id, owner]]), activeChildren: new Map(), turnOutcomePending: new Map(), activeAgentRuns: new Map(), agentWakeSuppressed: new Set(),
    stewardRuntime: runtime, EventStreamHooks: { backgroundShells: { rows: () => [] }, pendingAgentWakeJobs: holdWake ? () => wake.promise : async () => [] }, StewardHooks: { onThreadSettled() {} },
    stewardReadTurnHead: async () => plain(head), stewardSanitizeText: String, nowIso: () => head.updatedAt, sessionMissionId: s => s.id,
    loadSession: async () => { if (loadError) throw Object.assign(new Error(loadError), { code: loadError }); return missing ? null : plain(head); },
    sessionSaveIsTombstoned: () => context.deleted === true,
    saveSession: copy => { const d = defer(); writes.push({ d, copy: plain(copy) }); return d.promise.then(() => { if (!context.deleted) head = plain(copy); }); },
    RUYI_EVENTS: { emit() {} }, logEvent() {}, scheduleAgentWake() {}, setTimeout: callback => { timers.push(callback); return { callback }; }, clearTimeout() {},
    timedOut: false, queueTimedOut: false, permissionDenied: denied, meaningfulChange, task: { id: owner.requestMeta.taskId, payload: { kind: 'playbook' } }, runId: owner.requestMeta.runId, occKey: owner.requestMeta.occurrenceKey, timer: {}, executionFinished: false });
  const metaSource = ['sessionMetaDeferChains', 'SESSION_META_DEFER_TIMEOUT_MS', 'SESSION_META_STALE_REPLAYS', 'sessionMutateChains', 'STEWARD_WATCH_NOTE_MAX'].map(n => constBlock(store, n)).join('\n')
    + '\n' + functionBlock(boot, 'runKeyedChain') + '\n' + ['withSessionMutateLock', 'stewardWatchNoteFrom', 'sessionSchedulerTurnReceipt', 'sessionSchedulerTurnMatches', 'sessionStampSchedulerTurn', 'applySessionMetaPatch', 'updateSessionMeta', 'updateSessionMetaAttempt'].map(n => functionBlock(store, n)).join('\n');
  const helper = flag ? '' : functionBlock(scheduler, 'schedulerTurnOutcome');
  const api = vm.runInContext(metaSource + '\n' + collectorSource + '\n' + helper + '\n({collect:stewardCollectSessionTurn,meta:updateSessionMeta,apply:applySessionMetaPatch,finalize:async()=>{' + finalizeSlice + '\n}})', context, { timeout: 1000 });
  if (functionBlock(store, 'sessionStampSchedulerTurn') && source === 'scheduler') {
    context.headForStamp = head;
    vm.runInContext('sessionStampSchedulerTurn(headForStamp, settleEntry)', context, { timeout: 1000 });
    context.session.stewardLastTurn = plain(head.stewardLastTurn);
  }
  if (!flag) context.body.schedulerOutcome = vm.runInContext('({' + bracedBlock(fire, 'schedulerOutcome: turn =>') + '}).schedulerOutcome', context, { timeout: 1000 });
  const start = () => {
    const p = api.finalize();
    // Baseline caller writes its result only after the actual turn returned.
    const result = flag && source === 'scheduler' ? p.then(() => {
      context.targetBusy = false; context.queueTimedOut = false; context.sessionId = head.id; context.result = { turnSeq: 2 }; context.inner = context.lastResult; context.outcome = failed ? 'failed' : 'succeeded';
      const write = sliceBlock(fire, '      if (!targetBusy && !queueTimedOut) void updateSessionMeta(sessionId, {', '\n    }\n    }\n  } catch');
      assert.ok(write.includes('stewardLastTurn')); vm.runInContext(write, context, { timeout: 1000 });
    }) : p;
    result.catch(() => {}); return result;
  };
  return { api, context, writes, timers, wake, owner, runtime, start, head: () => plain(head), poll: () => api.collect(head.id, head.id, { sourceStamp: 'control-' + writes.length }, Date.parse(head.updatedAt)), async commit(index = 0) { writes[index].d.resolve(); await flush(); } };
}
async function uiControls() {
  const f = editor(), a = f.api.editSchedule(f.tasks[0]), b = f.api.editSchedule(f.tasks[1]);
  await f.mission(1); await f.template(0); await b;
  const before = f.body(); assert.equal(before.target.sessionId, 'sess_B');
  await f.mission(0);
  if (flag) await f.template(1);
  await a; const after = f.body();
  if (flag) { assert.equal(after.taskId, 'sch_B'); assert.equal(after.target.sessionId, 'sess_A'); assert.equal(after.payload.values.material, 'C:/synthetic/A.txt'); }
  else assert.deepEqual(after, before);
  const admitted = await accepted(f, after); assert.equal(admitted.id, 'sch_B'); assert.equal(admitted.payload.playbookId, flag ? 'pb_A' : 'pb_B');
  t.ok(true, flag ? 'expected RED: valid mixed B identity / A material reaches actual bind/normalize' : 'late A missions cannot write B fields or acquire a newer template ticket; real bind stays B');
  if (flag) return;
  const both = editor(), x = both.api.editSchedule(both.tasks[0]); await both.mission(0);
  const y = both.api.editSchedule(both.tasks[1]); await both.mission(1); await both.template(1); await y;
  const current = both.body(); await both.template(0); await x; assert.deepEqual(both.body(), current);
  t.ok(true, 'late A templates cannot overwrite completed B editor');
  const order = editor(), first = order.api.editSchedule(order.tasks[0]), second = order.api.editSchedule(order.tasks[1]);
  await order.mission(0); assert.equal(order.requests.playbooks.length, 0); await order.mission(1); await order.template(0); await Promise.all([first, second]); assert.equal(order.body().payload.playbookId, 'pb_B');
  t.ok(true, 'A-first missions order also leaves B as the sole owner');
  for (const stage of ['missions', 'templates']) for (const action of ['cancel', 'create']) {
    const q = editor(), old = q.api.editSchedule(q.tasks[0]); if (stage === 'templates') await q.mission(0);
    q.api.toggleScheduleForm(false); if (action === 'create') { q.create(); await q.mission(stage === 'missions' ? 1 : 1); await q.template(stage === 'templates' ? 1 : 0, [q.templates[1]]); }
    const saved = q.body(), error = q.nodes.cfgStewardScheduleFormError.textContent;
    if (stage === 'missions') await q.mission(0); else await q.template(0);
    await old; assert.deepEqual(q.body(), saved); assert.equal(q.nodes.cfgStewardScheduleFormError.textContent, error); assert.equal(q.nodes.cfgStewardScheduleForm.hidden, action === 'cancel');
    t.ok(true, stage + ' response after ' + action + ' cannot mutate or reopen form');
  }
  for (const stage of ['missions', 'templates']) {
    const q = editor(), old = q.api.editSchedule(q.tasks[0]); if (stage === 'templates') await q.mission(0);
    q.close(); const snapshot = q.body();
    if (stage === 'missions') await q.mission(0); else await q.template(0);
    await old; assert.deepEqual(q.body(), snapshot); assert.equal(q.nodes.cfgStewardScheduleForm.hidden, true);
    t.ok(true, 'actual closeModal synchronously invalidates stale ' + stage + ' continuation');
  }
  const errors = editor(), stale = errors.api.editSchedule(errors.tasks[0]); await errors.mission(0); const live = errors.api.editSchedule(errors.tasks[1]); await errors.mission(1); await errors.template(1); await live;
  const intact = errors.body(); errors.requests.playbooks[0].reject(new Error('stale failure')); await stale; assert.deepEqual(errors.body(), intact); assert.equal(errors.nodes.cfgStewardScheduleFormError.textContent, '');
  t.ok(true, 'stale template failure cannot replace current editor error/input');
  const recover = editor(), edit = recover.api.editSchedule(recover.tasks[0]); await recover.mission(0); recover.requests.playbooks[0].reject(new Error('current failure')); await edit;
  assert.match(recover.nodes.cfgStewardScheduleFormError.textContent, /failed/); const retry = recover.api.fillSchedulePlaybooks(recover.tasks[0]); await recover.template(1, [recover.templates[1]]); await retry;
  assert.equal(recover.body().payload.playbookId, 'pb_A'); assert.equal(recover.body().payload.values.material, 'C:/synthetic/A.txt');
  assert.equal(recover.nodes.cfgStewardScheduleFormError.textContent, '');
  t.ok(true, 'current failure recovers with pinned old revision and entered values');
  const pending = recover.api.previewSchedule(); recover.api.toggleScheduleForm(false); recover.create(); const freshError = recover.nodes.cfgStewardScheduleFormError.textContent;
  recover.requests.preview[0].resolve({ ok: false, error: 'late' }); await pending; assert.equal(recover.nodes.cfgStewardScheduleFormError.textContent, freshError);
  t.ok(true, 'late preview errors respect cancel/create epoch');
  // A successful save may finish after another task has been opened.
  const save = editor(); save.tasks[0].payload = { kind: 'prompt', text: 'Prompt A' }; const opening = save.api.editSchedule(save.tasks[0]); await save.mission(0); await save.template(0); await opening;
  const saving = save.api.submitScheduleOnce(), switched = save.api.editSchedule(save.tasks[1]); await save.mission(1); await save.template(1); await switched;
  const savedBody = save.body(); save.requests.save[0].resolve({ ok: true }); await saving; assert.deepEqual(save.body(), savedBody); assert.equal(save.nodes.cfgStewardScheduleForm.hidden, false);
  t.ok(true, 'late prompt save cannot close a newer Playbook editor');
}
async function outcomeControls() {
  for (const [name, options, expected] of [['quiet unchanged success', {}, null], ['real failed result', { failed: true }, 'failed'], ['meaningful change', { meaningfulChange: true }, 'done']]) {
    const f = publication({ ...options, holdWake: true }), finishing = f.start(); await flush();
    const beforeWake = await f.poll();
    if (!flag) { assert.equal(beforeWake, null); assert.equal(f.runtime.cursor.sessionTurns.sess_existing.turnSeq, 1); }
    f.wake.resolve([]); await flush(); assert.equal(f.writes.length, 1);
    const beforeWrite = await f.poll();
    if (flag) { assert.equal(beforeWake.kind, 'done'); assert.equal(beforeWrite, null); }
    else { assert.equal(beforeWrite, null); assert.equal(f.runtime.cursor.sessionTurns.sess_existing.turnSeq, 1); assert.equal(f.context.executionFinished, true); }
    await f.commit(); await finishing; const after = await f.poll();
    if (flag) assert.equal(after, null); else assert.equal(after?.kind || null, expected);
    t.ok(true, (flag ? 'expected RED: cursor consumes engine completion before ' : 'owner/pending barrier holds cursor until actual commit: ') + name);
  }
  if (flag) return;
  for (const failure of ['store rejected', 'missing key', 'missing session', 'deleted during write']) {
    const f = publication({ loadError: failure === 'missing key' ? 'work_data.key_missing' : null, missing: failure === 'missing session' }), p = f.start(); await flush();
    if (failure === 'store rejected') f.writes[0].d.reject(new Error('disk unavailable'));
    if (failure === 'deleted during write') { f.context.deleted = true; await f.commit(); }
    await assert.rejects(p, error => error.code === 'SCHEDULER_OUTCOME_UNCERTAIN');
    assert.equal(f.context.turnOutcomePending.get('sess_existing'), f.owner); assert.equal(await f.poll(), null); assert.equal(f.runtime.cursor.sessionTurns.sess_existing.turnSeq, 1);
    t.ok(true, failure + ': uncertain publication retains matching pending owner/cursor');
  }
  const deferred = publication({ holdWake: true }), p = deferred.start(); await flush();
  const next = defer(), newOwner = { promise: next.promise, driverRunId: 'new' }; deferred.context.turnSettlers.set('sess_existing', newOwner); deferred.wake.resolve([]); await flush();
  assert.equal(deferred.writes.length, 0); let returned = false; p.then(() => { returned = true; }); await flush(); assert.equal(returned, false);
  assert.equal(await deferred.poll(), null); deferred.context.turnSettlers.delete('sess_existing'); next.resolve(); await flush(); assert.equal(deferred.writes.length, 1);
  deferred.context.turnOutcomePending.set('sess_existing', newOwner); await deferred.commit(); await p; assert.equal(deferred.context.turnOutcomePending.get('sess_existing'), newOwner);
  t.ok(true, 'deferred metadata projection cannot release barrier; old completion cannot clear newer pending owner');
  for (const rejectWrite of [true, false]) {
    const q = publication({ holdWake: true }), old = q.start(); await flush(); const ownerDone = defer(); q.context.turnSettlers.set('sess_existing', { promise: ownerDone.promise }); q.wake.resolve([]); await flush();
    if (rejectWrite) { q.context.turnSettlers.delete('sess_existing'); ownerDone.resolve(); await flush(); q.writes[0].d.reject(new Error('deferred disk error')); }
    else { assert.equal(q.timers.length, 1); q.timers[0](); }
    await assert.rejects(old, e => e.code === 'SCHEDULER_OUTCOME_UNCERTAIN'); assert.equal(q.context.turnOutcomePending.get('sess_existing'), q.owner); assert.equal(await q.poll(), null);
    t.ok(true, rejectWrite ? 'real deferred-chain rejection propagates as unknown, not accepted projection' : 'deferred owner timeout never forces an unsafe outcome write');
  }
  const replaced = publication(), newer = { driverRunId: 'replacement' }; replaced.context.turnSettlers.set('sess_existing', newer); await replaced.start(); assert.equal(replaced.writes.length, 0); assert.equal(replaced.context.turnSettlers.get('sess_existing'), newer);
  t.ok(true, 'superseded finalizer neither publishes old result nor removes replacement execution owner');
  const revoked = publication({ stopped: true, denied: 1 }), revoking = revoked.start(); await flush(); await revoked.commit(); await revoking; assert.equal(revoked.head().stewardLastTurn.ok, false); assert.equal(revoked.head().stewardLastTurn.quiet, undefined); assert.equal(revoked.head().stewardLastTurn.aborted, true);
  t.ok(true, 'revoked/stopped completion is persisted truthfully and cannot become quiet success');
  const noTurn = publication(); noTurn.context.settleEntry.turnSeqAtStart = 2; noTurn.context.lastResult = null; noTurn.context.turnError = 'provider unavailable';
  await noTurn.start(); assert.equal(noTurn.writes.length, 0); assert.equal(noTurn.context.turnOutcomePending.size, 0); assert.equal(noTurn.context.executionFinished, true);
  t.ok(true, 'pre-admission failure stops dispatch timer without overwriting an older session outcome');
  for (const source of ['http', 'steward']) {
    const q = publication({ source, failed: true }), final = q.start(); await final; await flush();
    if (source === 'http') { assert.equal(q.writes.length, 1); assert.equal(await q.poll(), null); await q.commit(); await flush(); assert.equal((await q.poll()).kind, 'failed'); }
    else assert.equal(q.writes.length, 0);
    t.ok(true, source + ': existing ordinary asynchronous outcome ownership remains compatible');
  }
  // Structural protection: uncertainty must escape both catches before reconcile.
  assert.ok(bracedBlock(fire, '} catch (e) {\n        if (e?.code').includes('SCHEDULER_OUTCOME_UNCERTAIN'));
  assert.ok(fire.includes("if (!fireBase || schedulerIsWorkDataError(e) || e?.code === 'SCHEDULER_OUTCOME_UNCERTAIN') throw e;"));
  t.ok(true, 'uncertain result escapes scheduler catches with durable in-flight occurrence retained');
}
module.exports = { editor, normalize };
if (require.main === module) (async () => { try { await uiControls(); await outcomeControls(); } catch (error) { t.fail(error.stack || String(error)); } finally { t.done({ exit: true }); } })();
