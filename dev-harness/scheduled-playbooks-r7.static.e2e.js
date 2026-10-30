'use strict';
// Original registration/missing-provider guard/catch/return/finalizer slices and
// real encrypted M3 writers/collector. No HTTP transport, engine or timers run.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock, sliceBlock, bracedBlock } = require('./lib/source-slice');
const { fixture } = require('./scheduled-playbooks-cold-effects.static.e2e');
const t = createRunner('SCHEDULED PLAYBOOK R7 STATIC');
const flag = process.argv.find(value => value.startsWith('--baseline-root=')), baseline = Boolean(flag);
const repo = path.resolve(__dirname, '..'), root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : repo;
const read = name => fs.readFileSync(path.join(root, 'ruyi-workbench/app/src', name), 'utf8');
const turn = functionBlock(read('10-context-governance.js'), 'runSessionTurn');
const register = sliceBlock(turn, "  const driverRunId = makeId('drun');", "  let turnError = '';");
const finish = sliceBlock(turn, '    const outcomeId = session.id;', '    // 116-5a(§11.8.4)');
const guard = bracedBlock(turn, "    if (pinnedRoute?.engine === 'openai' && !provider)");
const caught = bracedBlock(turn, '  } catch (err)');
const returned = sliceBlock(turn, '  return {\n    ok: !turnError,', '\n}');
assert.ok(register.includes('recordSessionExecutionOwner')); assert.ok(finish.includes('updateSessionMeta')); assert.ok(guard.includes('Provider')); assert.ok(caught.includes("type: 'error'")); assert.ok(returned.includes('error: turnError'));
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
async function runCase(state, advance, ok) {
  const f = await fixture(); try {
    const c = await f.cold(), rows = await c.api.schedulerLoad();
    Object.assign(c.context, { source: 'http', session: await c.head(), body: {}, ownSettleEntry: null, turnStopped: false,
      AbortController, makeId: () => 'ordinary_registered', activeDriverRuns: new Map(), autonomyGrants: new Map(), sessionLastExecutions: new Map(), sessionExecutionEvictionGeneration: 0 });
    const ownerHelpers = functionBlock(read('04-permission-runtime.js'), 'recordSessionExecutionOwner') + '\n' + functionBlock(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/06f-autonomy-grants.js'), 'utf8'), 'bindDriverRun');
    const owner = vm.runInContext(ownerHelpers + '\n' + register + '\nsettleEntry', c.context, { timeout: 1000 });
    assert.equal(c.context.turnSettlers.get('sess_cold'), owner); assert.equal(owner.turnSeqAtStart, 2);
    await c.api.schedulerRecover(rows); const pending = (await c.head()).stewardLastTurn;
    assert.equal(pending.scheduler.state, 'pending'); assert.equal((await c.api.schedulerReadFireRows()).at(-1).turnSeq, 2);
    assert.equal((await c.api.schedulerReadFireRows()).at(-1).outcome, 'unknown');
    if (state !== 'pending') {
      // Exact source-control durable fact, without executing a business turn.
      c.context.turnSettlers.delete('sess_cold');
      await c.api.updateSessionMeta('sess_cold', { stewardLastTurn: { ...pending, ok: state === 'settled', quiet: state === 'settled', errorClass: state === 'unknown' ? 'scheduler_unknown' : '', scheduler: { ...pending.scheduler, state } } }, { waitForCommit: true, expectedSchedulerOutcome: { ...pending.scheduler, seq: 2 } });
      c.context.turnSettlers.set('sess_cold', owner);
    }
    assert.equal(await c.poll(), null);
    const old = await c.head(), before = await fs.promises.readFile(path.join(f.directory, 'sessions/sess_cold.json')), cursor = clone(c.context.stewardRuntime.cursor.sessionTurns.sess_cold);
    const fireBefore = await fs.promises.readFile(c.api.schedulerFiresPath());
    const events = [], writes = [], originalMeta = c.context.updateSessionMeta;
    c.context.updateSessionMeta = (...args) => { const p = originalMeta(...args); writes.push(p); return p; };
    Object.assign(c.context, { session: await c.head(), pinnedRoute: { engine: 'openai', providerId: 'missing_test_provider' }, provider: null,
      turnError: '', emit: event => events.push(clone(event)), lastResult: null, todosStartSig: '', STEWARD_SESSION_ID: 'steward',
      sessionMissionId: s => s.id, agentWakeSuppressed: new Set(), usageTotals: {}, lastTurnTokens: 0, disconnectHandled: false, privacySettingsResult: null,
      scheduleAgentWake() { throw Error('no wake capability'); } });
    if (advance) {
      const head = await c.head(); head.turnSeq = 3; await c.api.saveSession(head, { executionOwner: owner }); c.context.session = await c.head();
      c.context.lastResult = { ok, errorClass: ok ? '' : 'ordinary_failed' };
    } else {
      vm.runInContext('try {\n' + guard + '\n' + caught, c.context, { timeout: 1000 });
      assert.equal(events.length, 1); assert.equal(events[0].type, 'error'); assert.match(events[0].error, /Provider.*missing_test_provider/);
      assert.match(c.context.turnError, /Provider/);
    }
    const response = await vm.runInContext('(async()=>{' + finish + '\n' + returned + '\n})()', c.context, { timeout: 1000 });
    vm.runInContext('settleResolve()', c.context, { timeout: 1000 }); await flush(); await Promise.all(writes); await flush();
    assert.equal(c.context.turnSettlers.has('sess_cold'), false); assert.equal(f.state.businessExecutions, 0);
    const head = await c.head(), event = await c.poll();
    if (!advance) {
      assert.equal(response.ok, false); assert.equal(response.turnSeq, 2); assert.match(response.error, /Provider.*missing_test_provider/);
      if (baseline) {
        assert.equal(writes.length, 1); assert.equal(head.stewardLastTurn.scheduler, undefined); assert.equal(head.stewardLastTurn.seq, 2); assert.equal(head.stewardLastTurn.ok, false);
        assert.equal(event.kind, 'failed'); assert.equal(event.seq, 2); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2);
        t.ok(true, 'expected RED: missing-provider ordinary attempt without advancement overwrites ' + state + '2 and consumes cursor2, while HTTP error remains');
      } else {
        assert.equal(writes.length, 0); assert.deepEqual(head.stewardLastTurn, old.stewardLastTurn); assert.equal(event, null);
        assert.deepEqual(await fs.promises.readFile(path.join(f.directory, 'sessions/sess_cold.json')), before, 'no previous outcome/head stamp rewrite');
        if (state === 'settled') assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 2, 'confirmed old quiet result releases after this attempted owner exits');
        else assert.deepEqual(clone(c.context.stewardRuntime.cursor.sessionTurns.sess_cold), cursor, 'old cursor remains unchanged');
        assert.deepEqual(await fs.promises.readFile(c.api.schedulerFiresPath()), fireBefore); assert.equal(c.context.turnOutcomePending.size, 0);
        t.ok(true, 'real registration + missing-provider guard/catch preserves ' + state + '2 head/stamp; ' + (state === 'settled' ? 'old confirmed quiet result remains consumable' : 'unknown cursor remains unchanged') + '; HTTP error/return and owner cleanup remain');
      }
    } else {
      assert.equal(writes.length, 1); assert.equal(head.turnSeq, 3); assert.equal(head.stewardLastTurn.seq, 3); assert.equal(head.stewardLastTurn.ok, ok); assert.equal(head.stewardLastTurn.scheduler, undefined);
      assert.equal(event.kind, ok ? 'done' : 'failed'); assert.equal(event.seq, 3); assert.equal(c.context.stewardRuntime.cursor.sessionTurns.sess_cold.turnSeq, 3);
      assert.equal(response.ok, true, 'source return records thrown error separately from an engine result'); assert.equal(response.result.ok, ok);
      assert.deepEqual(await fs.promises.readFile(c.api.schedulerFiresPath()), fireBefore);
      t.ok(true, 'genuine durable advancement to seq3 after old ' + state + '2 publishes ordinary ' + (ok ? 'success' : 'failure') + ', preserving unknown2 journal/key');
    }
  } finally { await f.close(); }
}
(async () => { try {
  for (const state of ['pending', 'unknown']) await runCase(state, false, false);
  if (!baseline) { await runCase('settled', false, false); for (const state of ['pending', 'unknown']) for (const ok of [true, false]) await runCase(state, true, ok); }
} catch (error) { t.fail(error.stack || String(error)); } finally { t.done({ exit: true }); } })();
