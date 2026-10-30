'use strict';
// Genuine owner/metadata/admission source and authenticated M3 files only.
// No engine, HTTP, process, platform key, scheduler activation or real timer.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { fixture } = require('./scheduled-playbooks-cold-effects.static.e2e');
const t = createRunner('SCHEDULED PLAYBOOK R6 STATIC');
const flag = process.argv.find(value => value.startsWith('--baseline-root=')), baseline = Boolean(flag);
const root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ruyi-workbench/app/src/10-context-governance.js'), 'utf8');
const hook = source.split('\n').find(line => line.includes("if (source !== 'scheduler'") && line.includes('sessionTurnAdmission'));
assert.ok(hook);
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
async function invoke(c) { Object.assign(c.context, { source: 'http', session: await c.head() }); return vm.runInContext('(async()=>{' + hook + '})()', c.context, { timeout: 1000 }); }
async function prepareHead(f, seq) { const h = await f.warm.head(); h.turnSeq = seq; h.messages = []; h.providerHistory = []; await f.warm.api.saveSession(h); }
async function ownerInterleave(seq, outcome) {
  const f = await fixture(); try {
    await prepareHead(f, seq); const c = await f.cold(), rows = await c.api.schedulerLoad();
    const settled = defer(), entered = defer(), release = defer(), timerEntered = defer(), timers = [];
    const owner = { source: 'http', driverRunId: 'ordinary_' + (seq + 1), turnSeqAtStart: seq, promise: settled.promise };
    c.context.turnSettlers.set('sess_cold', owner);
    const originalLoad = c.context.loadSession; let intercepted = false;
    c.context.loadSession = async id => { const h = await originalLoad(id); if (!intercepted) { intercepted = true; entered.resolve(); await release.promise; } return h; };
    c.context.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.push(timer); timerEntered.resolve(); return timer; };
    let recoveryDone = false, admissionDone = false;
    const recovering = c.api.schedulerRecover(rows).then(() => { recoveryDone = true; }); recovering.catch(() => {});
    await entered.promise;
    const admitting = invoke(c).then(() => { admissionDone = true; }); admitting.catch(() => {});
    release.resolve();
    const state = await Promise.race([recovering.then(() => 'completed'), timerEntered.promise.then(() => 'waiting')]);
    if (baseline) {
      assert.equal(state, 'waiting'); await flush(); assert.equal(recoveryDone, false); assert.equal(admissionDone, false); assert.equal(timers[0].ms, 180000);
      assert.equal(c.context.turnSettlers.get('sess_cold'), owner); assert.equal(f.state.businessExecutions, 0);
      c.context.turnSettlers.delete('sess_cold'); settled.resolve(); await Promise.all([recovering, admitting]);
      t.ok(true, 'expected RED: head3/receipt2 ordinary admission and recovery mutually wait; original synthetic owner release only'); return;
    }
    assert.equal(state, 'completed'); await admitting; assert.equal(admissionDone, true); assert.equal(timers.length, 0);
    assert.equal(c.context.turnSettlers.get('sess_cold'), owner, 'recovery must not retire the live ordinary owner');
    const pending = (await c.head()).stewardLastTurn; assert.equal(pending.scheduler.state, 'pending'); assert.equal(pending.seq, 2);
    const retired = (await c.api.schedulerReadFireRows()).at(-1); assert.equal(retired.outcome, 'unknown'); assert.equal(retired.turnSeq, 2); assert.equal(retired.occurrenceKey, f.key);
    assert.deepEqual(JSON.parse(JSON.stringify(retired.snapshot)), JSON.parse(JSON.stringify(f.snapshot)));
    if (seq === 2) { assert.equal(await c.poll(), null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1); }
    const h = await c.head(); h.turnSeq = seq + 1; await c.api.saveSession(h, { executionOwner: owner });
    c.context.turnSettlers.delete('sess_cold'); settled.resolve();
    await c.api.updateSessionMeta('sess_cold', { stewardLastTurn: { seq: seq + 1, ok: outcome === 'success', aborted: outcome === 'cancelled', errorClass: outcome === 'failed' ? 'ordinary_failed' : '' } }, { waitForCommit: true });
    const event = await c.poll(); assert.equal(event.seq, seq + 1); assert.equal(event.kind, outcome === 'failed' ? 'failed' : 'done');
    assert.equal((await c.head()).stewardLastTurn.scheduler, undefined); assert.equal(f.state.businessExecutions, 0);
    t.ok(true, 'Tasks recovery never waits live ordinary owner: head' + seq + '/receipt2, later ' + outcome + ' preserved and bounded unknown released');
  } finally { await f.close(); }
}
async function ownerControls() {
  if (baseline) { await ownerInterleave(3, 'success'); return; }
  for (const seq of [2, 3]) for (const result of ['success', 'failed', 'cancelled']) await ownerInterleave(seq, result);
  for (const change of ['owner-arrives-in-mutate', 'receipt-changed', 'publication-rejected']) {
    const f = await fixture(); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad(), settled = defer();
      const owner = { source: 'http', driverRunId: 'ordinary_owned', turnSeqAtStart: 2, promise: settled.promise };
      const originalLoad = c.context.loadSession; let loads = 0;
      c.context.loadSession = async id => {
        loads++;
        if (loads === 2 && change === 'owner-arrives-in-mutate') c.context.turnSettlers.set(id, owner);
        if (loads === 2 && change === 'receipt-changed') { const h = await c.head(); h.turnSeq = 3; h.stewardLastTurn = { seq: 3, ok: false, errorClass: 'new_result' }; await c.api.saveSession(h); }
        return originalLoad(id);
      };
      if (change === 'publication-rejected') { f.state.failHead = true; await assert.rejects(c.api.schedulerRecover(rows)); assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, f.runId); assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'pending'); assert.equal(await c.poll(), null); f.state.failHead = false; await c.api.schedulerRecover(rows); }
      else await c.api.schedulerRecover(rows);
      if (change === 'owner-arrives-in-mutate') { assert.equal(c.context.turnSettlers.get('sess_cold'), owner); assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'pending'); assert.equal(await c.poll(), null); c.context.turnSettlers.delete('sess_cold'); settled.resolve(); }
      if (change === 'receipt-changed') { assert.equal((await c.head()).stewardLastTurn.errorClass, 'new_result'); assert.equal((await c.poll()).kind, 'failed'); }
      assert.equal((await c.api.schedulerReadFireRows()).at(-1).turnSeq, 2); assert.equal(f.state.businessExecutions, 0);
      t.ok(true, 'recovery exact CAS/owner boundary: ' + change);
    } finally { await f.close(); }
  }
  const f = await fixture(); try {
    const c = await f.cold(), pending = (await c.head()).stewardLastTurn, settled = defer(), entered = defer();
    const owner = { source: 'scheduler', driverRunId: 'current_original_owner', promise: settled.promise };
    c.context.turnSettlers.set('sess_cold', owner); c.context.setTimeout = (callback, ms) => { assert.equal(ms, 180000); entered.resolve(); return { callback, ms }; };
    let committed = false;
    const writing = c.api.updateSessionMeta('sess_cold', { stewardLastTurn: { ...pending, ok: true, quiet: true, scheduler: { ...pending.scheduler, state: 'settled' } } }, { waitForCommit: true, expectedSchedulerOutcome: { ...pending.scheduler, seq: 2 } }).then(() => { committed = true; });
    await entered.promise; assert.equal(committed, false); assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'pending'); assert.equal(await c.poll(), null);
    c.context.turnSettlers.delete('sess_cold'); settled.resolve(); await writing; assert.equal((await c.head()).stewardLastTurn.scheduler.state, 'settled'); assert.equal(await c.poll(), null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2);
    t.ok(true, 'warm original finalizer still awaits actual durable commit before quiet ACK/cursor release');
  } finally { await f.close(); }
}
async function growHistory(c) {
  const template = c.api.normalizePlaybook({ id: 'pb_other_history', title: 'Other valid template', promptTemplate: 'P'.repeat(5000), inputs: [], requires: [] });
  const normalized = c.api.normalizeSchedulerTask({ id: 'sch_other_history', title: 'Other retained history', schedule: { kind: 'daily', at: '09:00', tz: 'UTC' }, payload: { kind: 'playbook', template, playbookId: template.id, revision: template.revision, values: {}, checks: ['Keep meaningful evidence'] }, target: { mode: 'existing-session', sessionId: 'sess_other_history' } }, 0);
  assert.equal(normalized.ok, true); const snapshot = c.api.schedulerOccurrenceSnapshot(normalized.task), old = await c.api.schedulerReadFireRows(), lines = [];
  let logical = old.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row) + '\n'), 0), seq = old.at(-1).seq;
  for (let i = 0; logical < 10 * 1024 * 1024; i++) {
    const dueAt = new Date(Date.parse('2026-10-31T09:00:00Z') + i * 86400000).toISOString(), key = 'sch_other_history@' + dueAt;
    const row = { seq: ++seq, at: dueAt, taskId: normalized.task.id, title: normalized.task.title, occurrenceKey: key, dueAt, runId: 'other_run_' + i, executionGeneration: 1, mode: 'ontime', phase: 'reconciled', outcome: 'succeeded', sessionId: 'sess_other_history', snapshot: { ...snapshot, occurrence: { key, dueAt, mode: 'ontime' } } };
    const text = JSON.stringify(row); logical += Buffer.byteLength(text + '\n'); lines.push(text);
  }
  c.context.__tailRows = lines; c.context.__lastSeq = seq;
  await c.api.schedulerTaskAdmission(() => vm.runInContext("withSchedulerFireLock(async()=>{const journal=schedulerFireJournal();return journal.withOperation(async operation=>{await journal.preflight(operation);await journal.append(__tailRows,async()=>{throw Error('plain fallback forbidden');},operation);schedulerRuntime.fireSeq=__lastSeq;});})", c.context, { timeout: 1000 }));
  const window = await vm.runInContext('schedulerReadFiresText()', c.context, { timeout: 1000 }); assert.equal(window.droppedHead, true);
  const limits = vm.runInContext('[SCHEDULER_FIRES_FULL_READ_BYTES,SCHEDULER_FIRES_TAIL_BYTES]', c.context); assert.deepEqual(Array.from(limits), [8 * 1024 * 1024, 1024 * 1024]);
  assert.equal((await c.api.schedulerReadFireRows()).some(row => row.runId === 'run_cold'), false);
  return { logicalBytes: logical, records: lines.length };
}
async function tailControls() {
  for (const recoveredFirst of (baseline ? [true] : [true, false])) {
    const f = await fixture({ legacy: true }); try {
      const c = await f.cold(), rows = await c.api.schedulerLoad();
      if (recoveredFirst) { await c.api.schedulerRecover(rows); assert.equal(await c.poll(), null); }
      const growth = await growHistory(c); assert.ok(growth.logicalBytes > 8 * 1024 * 1024);
      const cold = await f.cold(); await cold.api.schedulerLoad();
      if (baseline) {
        for (const target of [c, cold]) { const event = await target.poll(); assert.equal(event.kind, 'done'); assert.equal(event.seq, 2); assert.equal(target.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2); assert.equal((await target.head()).stewardLastTurn.seq, 1); }
        assert.equal(f.state.businessExecutions, 0); t.ok(true, 'expected RED: real >8MiB authenticated journal tail drops old barrier; warm and cold emit false done/cursor2'); continue;
      }
      for (const [name, target] of [['warm', c], ['cold', cold]]) { assert.equal(await target.poll(), null); assert.equal(target.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1); assert.equal((await target.head()).stewardLastTurn.seq, 1); t.ok(true, name + ' full-history association holds cursor through ' + growth.records + ' retained normal snapshot rows, recoveredFirst=' + recoveredFirst); }
      if (!recoveredFirst) {
        f.state.failFires = true; await assert.rejects(c.api.schedulerRecover(rows)); assert.equal(c.api.schedulerRuntime.tasks[0].state.inFlightRunId, f.runId); assert.equal(await c.poll(), null);
        f.state.failFires = false; await c.api.schedulerRecover(rows);
        const full = await vm.runInContext("schedulerReadRecoveryEntries('sess_cold')", c.context, { timeout: 1000 }), entry = full.get(f.runId);
        assert.equal(entry.outcome, 'unknown'); assert.equal(entry.legacyTurnThrough, 2); assert.equal(entry.occurrenceKey, f.key); assert.deepEqual(JSON.parse(JSON.stringify(entry.snapshot)), JSON.parse(JSON.stringify(f.snapshot)));
        t.ok(true, 'recovery reads original run outside UI tail; rejected unknown append retains inFlight and original key/snapshot before retry');
      }
      f.state.lostKey = true; assert.equal(await c.poll(), null); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1); f.state.lostKey = false; assert.equal(await c.poll(), null);
      t.ok(true, 'large-history lost key preserves cursor; key restoration preserves bounded barrier without replay');
      const ordinary = await c.head(); ordinary.turnSeq = 3; ordinary.stewardLastTurn = { seq: 3, ok: false, errorClass: 'ordinary_failed' }; await c.api.saveSession(ordinary); assert.equal((await cold.poll()).kind, 'failed');
      t.ok(true, 'large-history genuine later ordinary result releases only later seq3, no scheduler execution');
      // Unknown append/torn history is never a complete negative proof. Move
      // back to the original ambiguous head only inside this owned fixture.
      const ambiguous = await c.head(); ambiguous.turnSeq = 4; ambiguous.stewardLastTurn = { seq: 3, ok: true }; await c.api.saveSession(ambiguous);
      await fs.promises.appendFile(c.api.schedulerFiresPath(), '{"unfinished":', 'utf8');
      const afterTorn = await f.cold(); await afterTorn.api.schedulerLoad(); assert.equal(await afterTorn.poll(), null); assert.equal(afterTorn.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 1);
      await assert.rejects(vm.runInContext("schedulerSessionTurnAdmission(__head)", Object.assign(afterTorn.context, { __head: await afterTorn.head() }), { timeout: 1000 }));
      const result = await afterTorn.head(); result.stewardLastTurn = { seq: 4, ok: true }; await afterTorn.api.saveSession(result); assert.equal((await afterTorn.poll()).seq, 4);
      assert.equal(f.state.businessExecutions, 0); t.ok(true, 'torn/incomplete full proof holds ambiguous cursor; actual covering ordinary result releases without depending on history');
    } finally { await f.close(); }
  }
}
(async () => { try { await ownerControls(); await tailControls(); } catch (error) { t.fail(error.stack || String(error)); } finally { t.done({ exit: true }); } })();
