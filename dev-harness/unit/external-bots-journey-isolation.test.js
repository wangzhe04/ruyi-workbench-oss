'use strict';
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { functionBlock } = require('../lib/source-slice');
const { BUDGET, scriptModel, retainProviderStartup, createJourneyHome } = require('../lib/external-bots-c2/actual-http-fixture.cjs');
const { ACTIONS } = require('../lib/external-bots-c2/run-journeys.cjs');
const source = fs.readFileSync(process.env.RUYI_C2_JOURNEY_RUNNER_SOURCE || path.resolve(__dirname, '../lib/external-bots-c2/run-journeys.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
test('original per-test home helper gets case-local HOME and both AppData roots without shared fake caches', () => {
  const contexts = Array.from({ length: 9 }, () => createJourneyHome());
  for (const key of ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) a.equal(new Set(contexts.map(row => row.env[key])).size, 9, key);
  for (const row of contexts) {
    a.equal(row.env.USERPROFILE, row.home); a.equal(row.env.HOME, row.home);
    a.equal(row.env.LOCALAPPDATA, path.join(row.home, 'AppData', 'Local')); a.equal(row.env.APPDATA, path.join(row.home, 'AppData', 'Roaming'));
    a.ok(fs.statSync(row.env.LOCALAPPDATA).isDirectory()); a.ok(fs.statSync(row.env.APPDATA).isDirectory());
  }
});
function fixtureRun(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-c2-isolation-pure-')), output = path.join(root, 'evidence');
  const fixtures = [], events = [], timers = [], cleared = [], state = { active: 0, peak: 0, calls: 0, failures: 0, done: 0 };
  const now = 1000000; class InertDate extends Date { static now() { return now; } }
  const context = { fs: overrides.io || fs, path, require, Date: InertDate, BUDGET, AbortController, ACTIONS,
    createRunner: () => ({ ok() {}, fail() { state.failures++; }, done() { state.done++; }, get failures() { return state.failures; } }),
    assertThat: (value, text) => a.ok(value, text),
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout(timer) { cleared.push(timer); },
    process: { exit() { a.fail('inert run must not invoke process exit'); } }, console: { error(value) { events.push('diagnostic-stderr:' + value); } },
    async createActualFixture(options) {
      state.calls++; events.push('create-' + state.calls);
      if (overrides.startup) return overrides.startup(options, state.calls);
      a.equal(state.active, 0, 'new fixture cannot overlap any earlier held owner'); state.active++; state.peak = Math.max(state.peak, state.active);
      const home = path.join(root, 'home-' + state.calls); fs.mkdirSync(home);
      const row = { options, home, work: path.join(home, 'work'), owners: { server: {}, provider: {}, official: {}, ledger: {} }, closed: false };
      row.model = scriptModel(() => row.work, { output: options.output });
      row.configure = async platform => { (row.configured ||= []).push(platform); };
      row.evidence = () => ({ home, work: row.work, heldOwners: Object.keys(row.owners), syntheticOnly: true });
      row.close = async () => {
        events.push('close-start-' + fixtures.indexOf(row)); row.closeSignalAborted = options.signal.aborted;
        if (overrides.close) await overrides.close(row, fixtures.indexOf(row));
        row.closed = true; state.active--; events.push('close-end-' + fixtures.indexOf(row));
        return { status: 'closed-held-actors-and-owned-listeners', facts: row.evidence() };
      };
      fixtures.push(row); return row;
    },
    async oneJourney(fx, type, action, sequence, _t, caseOutput) {
      a.equal(fx.options.output, caseOutput); a.deepEqual(fx.configured, ['qq', 'feishu']);
      if (overrides.journey) await overrides.journey(fx, type, action, sequence);
      // Actual receive helper, inert model body: each local index0 must be a
      // new wx artifact in its case directory, without any socket or child.
      await fx.model.handler({ body: { messages: [{ role: 'user', content: 'inert case ' + sequence }] } });
      return { type, action, sequence, home: fx.home, output: caseOutput };
    },
  };
  const run = vm.runInNewContext(functionBlock(source, 'runJourneys') + '\nrunJourneys', context);
  return { root, output, fixtures, events, timers, cleared, state, run: () => run({ output }), result: () => JSON.parse(fs.readFileSync(path.join(output, 'ACTUAL-RESULT.json'))) };
}
test('one full batch creates nine serial fresh owners, with identical global deadlines/signal and exclusive wx namespaces', async () => {
  const f = fixtureRun(); await f.run(); const r = f.result();
  a.equal(f.state.calls, 9); a.equal(f.state.peak, 1); a.equal(f.state.active, 0); a.equal(f.state.failures, 0); a.equal(f.state.done, 1);
  a.equal(r.status, 'passed-selected-journeys-and-known-cleanup'); a.equal(r.selectedJourneys.completed.length, 9);
  a.equal(f.timers.length, 2); a.deepEqual(f.timers.map(row => row.ms), [3420000, 3540000]); a.equal(f.cleared.length, 2);
  a.equal(r.executionDeadline, 1000000 + 3420000); a.equal(r.cleanupDeadline, 1000000 + 3540000);
  a.equal(new Set(f.fixtures.map(fx => fx.options.signal)).size, 1); a.equal(f.fixtures[0].options.signal.aborted, true);
  for (const field of ['home', 'work']) a.equal(new Set(f.fixtures.map(fx => fx[field])).size, 9);
  for (const role of ['server', 'provider', 'official', 'ledger']) a.equal(new Set(f.fixtures.map(fx => fx.owners[role])).size, 9);
  for (let n = 0; n < 9; n++) {
    const fx = f.fixtures[n], c = r.cases[n]; a.equal(fx.options.deadline, r.executionDeadline); a.equal(fx.options.cleanupDeadline, r.cleanupDeadline);
    a.equal(c.cleanup.status, 'known-held-actors-closed'); a.equal(c.business, 'completed'); a.equal(fx.closed, true); a.equal(fx.closeSignalAborted, false);
    const capture = JSON.parse(fs.readFileSync(path.join(c.output, 'provider-request-00000.json'))); a.equal(capture.index, 0);
    a.ok(fs.existsSync(path.join(c.output, 'CASE-RESULT.json')));
    if (n) a.ok(f.events.indexOf('close-end-' + (n - 1)) < f.events.indexOf('create-' + (n + 1)));
  }
  const replay = scriptModel(() => f.root, { output: f.fixtures[0].options.output });
  await a.rejects(replay.handler({ body: { messages: [] } }), { code: 'EEXIST' });
});
test('delayed known close is a strict barrier before allocating the next fixture', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixtureRun({ close: async (_fx, index) => { if (!index) { entered.resolve(); await gate.promise; } } });
  const pending = f.run(); await entered.promise; await tick(); a.equal(f.state.calls, 1); a.equal(f.state.active, 1);
  a.equal(f.fixtures[0].options.signal.aborted, false); gate.resolve(); await pending; a.equal(f.state.calls, 9); a.equal(f.state.failures, 0);
});
test('first business RED and unknown close preserve earlier completion and exact first error, stop next allocation and retain watchdog', async () => {
  const f = fixtureRun({ journey: async (_fx, _type, _action, sequence) => { if (sequence === 2) throw Error('original stream RED'); },
    close: async (_fx, index) => { if (index === 1) throw Error('unknown original owner close'); } });
  await f.run(); const r = f.result(), first = JSON.parse(fs.readFileSync(path.join(f.output, 'FIRST-FAILURE.json')));
  a.equal(f.state.calls, 2); a.equal(r.selectedJourneys.completed.length, 1); a.equal(r.cleanup.status, 'unknown-or-failed');
  a.match(first.error, /original stream RED/); a.doesNotMatch(first.error, /unknown original owner close/);
  a.equal(r.cases[1].cleanup.status, 'unknown-or-failed'); a.equal(f.state.active, 1);
  a.ok(!f.cleared.includes(f.timers[1]), 'unknown close must retain the original cumulative cleanup watchdog');
});
test('receive/stream/first-failure/case diagnostic EIO cannot skip original close or create a later fixture', async () => {
  for (const phase of ['receive', 'stream', 'first-failure-write', 'case-write']) {
    const io = { ...fs, writeFileSync(file, ...rest) {
      if ((phase === 'first-failure-write' && path.basename(file) === 'FIRST-FAILURE.json') || (phase === 'case-write' && path.basename(file) === 'CASE-RESULT.json')) throw Object.assign(Error(phase + ' EIO'), { code: 'EIO' });
      return fs.writeFileSync(file, ...rest);
    } };
    const f = fixtureRun({ io, journey: async fx => {
      if (phase === 'receive') { const model = scriptModel(() => fx.work, { output: fx.options.output, io: { writeFileSync() { throw Object.assign(Error('receive EIO'), { code: 'EIO' }); } } }); await model.handler({ body: { messages: [] } }); }
      if (phase !== 'case-write') throw Error('original ' + phase + ' RED');
    } });
    await f.run(); a.equal(f.state.calls, 1, phase); a.equal(f.state.active, 0, phase); a.equal(f.fixtures[0].closed, true, phase);
    a.equal(f.result().status, 'RED', phase); a.ok(f.state.failures > 0, phase); a.equal(f.result().cleanup.status, 'known-held-actors-closed', phase);
  }
});
test('late original provider startup stays owned after first RED; settlement can only close and never resume or allocate', async () => {
  const startup = deferred(), server = new EventEmitter(); server.listening = true; let closes = 0, owned = null, retention;
  const provider = { server, async close() { closes++; server.listening = false; server.emit('close'); } };
  const f = fixtureRun({ startup: async () => {
    const original = retainProviderStartup(startup.promise, value => { owned = value; }, () => {}, Date.now() + 10000);
    retention = { promise: original.requestClose(), snapshot: original.snapshot };
    const error = Error('original startup first RED'); error.c2ProviderRetention = retention;
    error.c2Evidence = { cleanupError: 'startup pending; unknown exact listener retained', cleanupResult: null }; throw error;
  } });
  await f.run(); a.equal(f.state.calls, 1); a.equal(retention.snapshot().closeStatus, 'awaiting-startup');
  a.ok(!f.cleared.includes(f.timers[1])); startup.resolve(provider); await retention.promise; await tick();
  a.equal(owned, provider); a.equal(closes, 1); a.equal(server.listening, false); a.equal(f.state.calls, 1);
  const late = JSON.parse(fs.readFileSync(path.join(f.output, 'LATE-PROVIDER-RETENTION.json'))); a.match(late.originalFailure, /original startup first RED/);
  a.equal(f.result().status, 'RED'); a.ok(!f.cleared.includes(f.timers[1]), 'late provider close alone cannot certify all original unknown cleanup');
});
test('execution deadline before a new case stops allocation, without a per-case batch timer reset', async () => {
  const f = fixtureRun({ close: async (_fx, index) => { if (!index) f.timers[0].fn(); } });
  await f.run(); a.equal(f.state.calls, 1); a.equal(f.timers.length, 2); a.equal(f.result().status, 'RED');
  a.match(JSON.parse(fs.readFileSync(path.join(f.output, 'FIRST-FAILURE.json'))).error, /cumulative execution deadline/);
});
test('late close and its diagnostic EIO keep the original startup failure, exact owner and global watchdog', async () => {
  const startup = deferred(), server = new EventEmitter(); server.listening = true; let owned = null, retention, closes = 0;
  const provider = { server, async close() { closes++; throw Object.assign(Error('late close EIO'), { code: 'EIO' }); } };
  const io = { ...fs, writeFileSync(file, ...rest) { if (path.basename(file) === 'LATE-PROVIDER-RETENTION.json') throw Object.assign(Error('late diagnostic EIO'), { code: 'EIO' }); return fs.writeFileSync(file, ...rest); } };
  const f = fixtureRun({ io, startup: async () => {
    const original = retainProviderStartup(startup.promise, value => { owned = value; }, () => {}, Date.now() + 10000);
    retention = { promise: original.requestClose(), snapshot: original.snapshot };
    const error = Error('original retained startup RED'); error.c2ProviderRetention = retention; error.c2Evidence = { cleanupError: 'pending startup' }; throw error;
  } });
  await f.run(); startup.resolve(provider); await a.rejects(retention.promise, /late close EIO/); await tick();
  a.equal(f.state.calls, 1); a.equal(owned, provider); a.equal(closes, 1); a.equal(server.listening, true); a.equal(retention.snapshot().closeStatus, 'failed');
  a.ok(!f.cleared.includes(f.timers[1])); a.match(JSON.parse(fs.readFileSync(path.join(f.output, 'FIRST-FAILURE.json'))).error, /original retained startup RED/);
  a.ok(f.events.some(row => row.includes('late diagnostic EIO'))); a.equal(f.result().status, 'RED');
});
test('unchanged original product budget still defers seventh shared-chat reply beyond45s; isolated cases do not rewrite reservations', () => {
  const product = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13w-external-bots.js'), 'utf8');
  const exact = Date.parse('2026-11-01T04:29:50.277Z'); class InertDate extends Date { static now() { return exact; } }
  const delay = vm.runInNewContext(functionBlock(product, 'externalBotFeedbackDelay') + '\nexternalBotFeedbackDelay', { Date: InertDate, Math });
  const reservations = ['44.775', '45.791', '46.805', '47.832', '48.854', '49.881'].map(t => ({ at: '2026-11-01T04:29:' + t + 'Z' }));
  const make = rows => ({ platform: 'qq', control: { appId: 'original-app' }, conversationId: 'same-original-chat', feedback: { reservations: rows } });
  const state = { items: reservations.map(row => make([row])) }, target = make([]), before = JSON.stringify(state);
  a.equal(delay(state, target) - exact, 54498); a.ok(delay(state, target) - exact > BUDGET.request); a.equal(JSON.stringify(state), before);
  for (const count of [4, 5]) a.ok(delay({ items: reservations.slice(0, count).map(row => make([row])) }, target) - exact < BUDGET.request);
  a.equal(BUDGET.request, 45000); a.equal(BUDGET.stream, 300000); a.equal(BUDGET.journey, 360000); a.equal(BUDGET.startup, 180000); a.equal(BUDGET.cleanup, 120000);
});
