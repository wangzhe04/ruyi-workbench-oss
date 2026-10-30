'use strict';
// Genuine durable owner/route/metadata/UI functions; owned M3 files and deferred
// in-memory UI only. No server, HTTP, browser, engine, native or scheduler starts.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock } = require('./lib/source-slice');
const { fixture } = require('./scheduled-playbooks-cold-effects.static.e2e');
const { editor, normalize } = require('./scheduled-playbooks-lifecycle.static.e2e');
const t = createRunner('SCHEDULED PLAYBOOK R5 STATIC');
const flag = process.argv.find(arg => arg.startsWith('--baseline-root=')), baseline = Boolean(flag);
const root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8'), clone = value => JSON.parse(JSON.stringify(value));
async function legacyControls() {
  for (const legacyPrompt of [false, true]) for (const newTarget of [false, true]) for (const order of ['collect-first', 'recover-first']) {
    const f = await fixture({ legacy: true, legacyPrompt, newTarget }); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad(); let event;
      if (order === 'collect-first') event = await c.poll(); await c.api.schedulerRecover(rows); if (order === 'recover-first') event = await c.poll();
      const last = (await c.api.schedulerReadFireRows()).at(-1);
      assert.equal(last.outcome, 'unknown'); assert.equal(last.occurrenceKey, f.key); assert.equal(f.state.businessExecutions, 0); assert.ok(f.notices.some(row => row.kind === 'unknown'));
      if (!legacyPrompt) assert.deepEqual(clone(last.snapshot), clone(f.snapshot)); else assert.equal(last.snapshot, undefined);
      assert.equal((await c.head()).stewardLastTurn.seq, 1, 'ambiguous head was not assigned to the scheduled run');
      if (baseline) { assert.equal(event.kind, 'done'); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2); }
      else {
        assert.equal(event, null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1); assert.equal(last.legacyTurnThrough, 2); assert.equal(last.turnSeq, undefined);
        const again = await f.cold(); await again.api.schedulerLoad(); assert.equal(await again.poll(), null);
        const ordinary = await again.head(); Object.assign(ordinary, { turnSeq: 3, messages: [], providerHistory: [] }); await again.api.saveSession(ordinary);
        assert.equal((await again.poll()).seq, 3, 'later ordinary turn escapes old bounded ambiguity');
      }
      t.ok(true, (baseline ? 'expected RED legacy false done: ' : 'legacy uncertainty held without guessed ownership: ') + (legacyPrompt ? 'prompt ' : 'Playbook ') + (newTarget ? 'new target ' : 'existing target ') + order);
    } finally { await f.close(); }
  }
  if (baseline) return;
  for (const fault of ['lostKey', 'failFires', 'failTasks']) {
    const f = await fixture({ legacyPrompt: true }); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad(); f.state[fault] = true;
      assert.equal(await c.poll(), null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1);
      await assert.rejects(c.api.schedulerRecover(rows)); assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, f.runId);
      f.state[fault] = false; const retry = await f.cold(), original = await retry.api.schedulerLoad(); await retry.api.schedulerRecover(original);
      assert.equal(await retry.poll(), null); assert.equal((await retry.api.schedulerReadFireRows()).at(-1).legacyTurnThrough, 2); assert.equal(f.state.businessExecutions, 0);
      t.ok(true, 'legacy ' + fault + ': no false ACK/done; original task/fire authority survives cold retry');
    } finally { await f.close(); }
  }
  const f = await fixture({ legacyPrompt: true }); try {
    const c = await f.cold(), staleRows = await c.api.schedulerLoad();
    const line = read('ruyi-workbench/app/src/10-context-governance.js').split('\n').find(value => value.includes("if (source !== 'scheduler'") && value.includes('sessionTurnAdmission'));
    assert.ok(line); const ordinaryOwner = { source: 'http', driverRunId: 'ordinary_owned' }; c.context.source = 'http'; c.context.session = await c.head(); c.context.turnSettlers.set('sess_cold', ordinaryOwner);
    await vm.runInContext('(async()=>{' + line + '})()', c.context, { timeout: 1000 });
    const head = await c.head(); Object.assign(head, { turnSeq: 3, messages: [], providerHistory: [] }); await c.api.saveSession(head, { executionOwner: ordinaryOwner }); c.context.turnSettlers.clear();
    await c.api.schedulerRecover(staleRows); assert.equal((await c.api.schedulerReadFireRows()).at(-1).legacyTurnThrough, 2); assert.equal((await c.poll()).seq, 3);
    t.ok(true, 'real ordinary-turn admission bounds old ambiguity before increment; stale recovery input cannot extend it');
  } finally { await f.close(); }
  let loaded = 0;
  const admit = vm.runInNewContext(functionBlock(read('ruyi-workbench/app/src/13s-scheduler.js'), 'schedulerSessionTurnAdmission') + '\nschedulerSessionTurnAdmission', {
    fsp: { stat: async () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); } }, schedulerFiresPath: () => 'synthetic-never-created',
    schedulerLoad: async () => { loaded++; throw Error('task owner must not be loaded'); },
  }, { timeout: 1000 });
  assert.equal(await admit({ id: 'ordinary', turnSeq: 2, stewardLastTurn: { seq: 1, ok: true } }), true); assert.equal(loaded, 0);
  t.ok(true, 'absent scheduler history does not load task/key owners or activate/create scheduler state');
}
async function publicMetadataControls() {
  const line = read('ruyi-workbench/app/src/13d-core-domain-routes.js').split('\n').find(value => value.includes('const session = await updateSessionMeta(id, body'));
  assert.ok(line);
  for (const mode of ['settled', 'unknown', 'erase', 'higher-seq erase', 'ordinary pending', 'ordinary unknown', 'ordinary settled', 'JSON options spoof', 'legacy result forge']) {
    const f = await fixture({ legacy: mode === 'legacy result forge' }); try {
      const c = await f.cold(); let old = (await c.head()).stewardLastTurn;
      if (mode.startsWith('ordinary')) { const head = await c.head(); Object.assign(head, { turnSeq: 3, messages: [], providerHistory: [], stewardLastTurn: { seq: 3, ok: true } }); await c.api.saveSession(head); old = head.stewardLastTurn; }
      let body = { stewardLastTurn: { ...old, ok: true, errorClass: '', scheduler: { taskId: 'sch_cold', runId: f.runId, occurrenceKey: f.key, state: mode.split(' ').at(-1) } } };
      if (mode.includes('erase')) body = { stewardLastTurn: { seq: mode.startsWith('higher') ? 99 : 2, ok: true } };
      if (mode === 'legacy result forge') body = { stewardLastTurn: { seq: 2, ok: true } };
      if (mode === 'JSON options spoof') { body.external = false; body.internal = true; body.stewardLastTurn.scheduler.state = 'settled'; }
      Object.assign(c.context, { body: clone(body), id: 'sess_cold' }); const before = await fs.promises.readFile(path.join(f.directory, 'sessions/sess_cold.json'));
      const invoke = () => vm.runInContext('(async()=>{' + line + '\nreturn session;})()', c.context, { timeout: 1000 });
      if (baseline) { await invoke(); assert.notDeepEqual((await c.head()).stewardLastTurn, old); }
      else { await assert.rejects(invoke(), error => error.code === 'SESSION_METADATA_INTERNAL' && error.statusCode === 400); assert.deepEqual(await fs.promises.readFile(path.join(f.directory, 'sessions/sess_cold.json')), before); assert.deepEqual((await c.head()).stewardLastTurn, old); }
      t.ok(true, (baseline ? 'expected RED public receipt accepted: ' : 'actual public route + M3 metadata reject protected fact mutation: ') + mode);
    } finally { await f.close(); }
  }
  if (baseline) return;
  const f = await fixture(); try {
    const c = await f.cold(), old = clone((await c.head()).stewardLastTurn); c.context.sessionTitleOverrides = new Map(); Object.assign(c.context, { id: 'sess_cold', body: { title: 'Legitimate title', pinned: true } });
    await vm.runInContext('(async()=>{' + line + '})()', c.context, { timeout: 1000 }); const head = await c.head(); assert.equal(head.title, 'Legitimate title'); assert.equal(head.pinned, true); assert.deepEqual(head.stewardLastTurn, old);
    t.ok(true, 'ordinary public metadata remains editable without altering engine-owned receipt');
  } finally { await f.close(); }
}
async function budgetControls() {
  for (const [snapshotCap, liveCap] of [[24, 24], [24, 1], [1, 24]]) {
    const f = await fixture(); try {
      const c = f.warm, old = clone(f.snapshot), due = Date.parse('2026-10-30T08:00:00Z'); delete old.occurrence; old.policy.maxRunsPerDay = snapshotCap;
      f.task.policy.maxRunsPerDay = liveCap; f.task.state.inFlightRunId = ''; delete f.task.state.inFlightSnapshot;
      f.task.state.queuedOccurrence = { dueMs: due, snapshot: old }; f.task.state.nextFireAt = '2026-10-31T09:00:00.000Z'; f.task.state.runsToday = { date: '2026-10-30', count: 1 }; c.api.schedulerRuntime.globalRuns = { date: '2026-10-30', count: 1 };
      await c.api.schedulerSaveTasks(); c.context.makeId = () => 'run_budget_owned'; let registered = false; c.context.__registered = () => { registered = true; }; c.context.__append = c.api.schedulerAppendFire;
      vm.runInContext("schedulerAppendFire=async row=>{if(row.phase==='registered'){__registered();throw Object.assign(Error('owned pre-fire boundary'),{code:'work_data.test_budget_boundary'});}return __append(row);}", c.context);
      const expected = (baseline ? liveCap : Math.min(snapshotCap, liveCap)) > 1;
      if (expected) await assert.rejects(c.api.schedulerFireOnce(f.task, 'late', due), error => error.code === 'work_data.test_budget_boundary'); else assert.equal(await c.api.schedulerFireOnce(f.task, 'late', due), 'skipped');
      assert.equal(registered, expected); assert.equal(f.task.state.runsToday.count, expected ? 2 : 1); assert.equal(f.state.businessExecutions, 0);
      if (registered) assert.equal(f.task.state.inFlightSnapshot.policy.maxRunsPerDay, snapshotCap);
      t.ok(true, (baseline && snapshotCap === 1 && liveCap === 24 ? 'expected RED frozen budget lifted: ' : 'real admission uses frozen/live narrower cap: ') + snapshotCap + '/' + liveCap);
    } finally { await f.close(); }
  }
}
async function refreshControls() {
  const binding = read('ruyi-workbench/app/public/js/steward-settings.js').split('\n').find(line => line.includes('reloadTemplates.onclick =')); assert.ok(binding);
  const f = editor(), opening = f.api.editSchedule(f.tasks[0]); await f.mission(0); await f.template(0); await opening;
  f.nodes.cfgStewardScheduleInputs.querySelectorAll('[data-input-key]')[0].value = 'C:/synthetic/UNSAVED_INPUT.txt'; f.nodes.cfgStewardScheduleChecks.value = 'UNSAVED_ACCEPTANCE';
  const before = f.body(); f.nodes.cfgStewardSchedulePlaybookRefresh = {}; vm.runInContext(binding, f.context, { timeout: 1000 });
  const newer = normalize({ ...f.templates[0], promptTemplate: 'NEW_REVISION {material}' }); assert.notEqual(newer.revision, f.templates[0].revision);
  const refresh = f.nodes.cfgStewardSchedulePlaybookRefresh.onclick(); await f.template(1, [newer, f.templates[1]]); await refresh;
  if (baseline) { assert.equal(f.body().payload.revision, newer.revision); assert.equal(f.body().payload.values.material, ''); assert.deepEqual(f.body().payload.checks, []); }
  else assert.deepEqual(f.body(), before);
  t.ok(true, baseline ? 'expected RED real refresh silently changes revision/drops draft' : 'actual refresh handler preserves entire draft and selected old revision');
  if (baseline) return;
  const inflight = f.nodes.cfgStewardSchedulePlaybookRefresh.onclick(); f.nodes.cfgStewardScheduleInputs.querySelectorAll('[data-input-key]')[0].value = 'C:/synthetic/TYPED_WHILE_LOADING.txt'; f.nodes.cfgStewardScheduleChecks.value = 'CURRENT_ACCEPTANCE'; const typed = f.body();
  await f.template(2, []); await inflight; assert.deepEqual(f.body(), typed);
  t.ok(true, 'library deletion/response retains latest typing and checks during reload');
  const stale = f.nodes.cfgStewardSchedulePlaybookRefresh.onclick(); const next = f.api.editSchedule(f.tasks[1]); await f.mission(1); await f.template(4); await next; const b = f.body(); await f.template(3, [newer]); await stale; assert.deepEqual(f.body(), b);
  t.ok(true, 'stale refresh cannot overwrite a newer editing epoch');
  const chooseBinding = read('ruyi-workbench/app/public/js/steward-settings.js').split('\n').find(line => line.includes('templateSelect.onchange =')); assert.ok(chooseBinding); vm.runInContext(chooseBinding, f.context, { timeout: 1000 });
  const loading = f.nodes.cfgStewardSchedulePlaybookRefresh.onclick(); f.nodes.cfgStewardSchedulePlaybook.value = '0'; f.nodes.cfgStewardSchedulePlaybook.onchange();
  f.nodes.cfgStewardScheduleInputs.querySelectorAll('[data-input-key]')[0].value = 'C:/synthetic/EXPLICIT_CHOICE.txt'; f.nodes.cfgStewardScheduleChecks.value = 'EXPLICIT_CHECK'; const chosen = f.body();
  assert.equal(chosen.payload.playbookId, 'pb_A'); assert.equal(chosen.target.sessionId, 'sess_B'); await f.template(5, [newer, f.templates[1]]); await loading; assert.deepEqual(f.body(), chosen);
  t.ok(true, 'explicit template change applies new semantics and remains the current owner during library reload');
}
(async () => { try { await legacyControls(); await publicMetadataControls(); await budgetControls(); await refreshControls(); } catch (error) { t.fail(error.stack || String(error)); } finally { t.done({ exit: true }); } })();
