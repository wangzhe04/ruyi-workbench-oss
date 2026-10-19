'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Load the actual manifest assembly in an isolated CommonJS scope. Test-only access does not add
// product exports; no production server or real model starts. Saves and reads use the production disk store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-execution-write-owner-'));
process.env.RUYI_HOME = home;
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const manifest = JSON.parse(fs.readFileSync(path.join(app, 'src/manifest.json'), 'utf8'));
const source = manifest.modules.map(m => fs.readFileSync(path.join(app, 'src', m.file), 'utf8')).join('\n');
const isolated = new Module(path.join(app, 'server.js'), module);
isolated.filename = path.join(app, 'server.js');
isolated.paths = Module._nodeModulePaths(app);
isolated._compile(source + '\nmodule.exports.ownerProbe = { recordSessionExecutionOwner, turnSettlers, sessionWriteChains, saveTurnFinalSession, activeChildren, DeliveryHooks, sessionEnvelopeLiveParts, sessionEnvelopeStamp, sessionEnvelopeEtag };', isolated.filename);
const srv = isolated.exports;
const internals = srv.ownerProbe;
after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* optional temp cleanup */ } });

async function pair() {
  const seed = await srv.createSession({ title: 'synthetic same-sequence owners', cwd: home });
  const a = structuredClone(seed), b = structuredClone(seed);
  for (const [value, text] of [[a, 'OLD_A'], [b, 'NEW_B']]) {
    value.turnSeq = 1;
    value.messages = [{ role: 'user', content: text, turnSeq: 1, createdAt: new Date().toISOString() }];
    value.providerHistory = [{ role: 'user', content: text }];
  }
  return { id: seed.id, a, b, ownerA: { driverRunId: 'A' }, ownerB: { driverRunId: 'B' } };
}

test('same turnSeq stale owner cannot overwrite B, including after B has settled', async () => {
  for (const settled of [false, true]) {
    const f = await pair();
    internals.recordSessionExecutionOwner(f.id, f.ownerB);
    await srv.saveSession(f.b, { executionOwner: f.ownerB });
    if (settled) internals.turnSettlers.delete(f.id);
    await srv.saveSession(f.a, { executionOwner: f.ownerA });
    assert.equal(await internals.saveTurnFinalSession(f.a, 'stale-A-final', { executionOwner: f.ownerA }), false);
    const got = await srv.loadSession(f.id);
    assert.equal(got.turnSeq, 1);
    assert.deepEqual(got.messages.map(m => m.content), ['NEW_B']);
    assert.deepEqual(got.providerHistory.map(m => m.content), ['NEW_B']);
  }
});

test('current cancelled owner still persists the ordinary stopped final snapshot', async () => {
  const f = await pair();
  f.ownerA.cancelRequested = true;
  internals.recordSessionExecutionOwner(f.id, f.ownerA);
  f.a.messages.push({ role: 'assistant', content: 'stopped', source: 'aborted', turnSeq: 1 });
  assert.equal(await internals.saveTurnFinalSession(f.a, 'stopped-A-final', { executionOwner: f.ownerA }), true);
  assert.equal((await srv.loadSession(f.id)).messages.at(-1).source, 'aborted');
});

test('ownership is checked inside the save chain, after a queued writer loses its owner', async () => {
  const f = await pair();
  internals.recordSessionExecutionOwner(f.id, f.ownerA);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  internals.sessionWriteChains.set(f.id, pending);
  const map = internals.sessionWriteChains, originalSet = map.set;
  let enqueued;
  const queued = new Promise(resolve => { enqueued = resolve; });
  map.set = function(key, value) {
    const result = originalSet.call(this, key, value);
    if (key === f.id && value !== pending) enqueued();
    return result;
  };
  const old = internals.saveTurnFinalSession(f.a, 'queued-A-final', { executionOwner: f.ownerA });
  let timer;
  try {
    await Promise.race([queued, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A did not enter the save chain')), 3000); })]);
  } finally { map.set = originalSet; clearTimeout(timer); }
  internals.recordSessionExecutionOwner(f.id, f.ownerB);
  const current = internals.saveTurnFinalSession(f.b, 'queued-B-final', { executionOwner: f.ownerB });
  release();
  assert.equal(await old, false);
  assert.equal(await current, true);
  assert.deepEqual((await srv.loadSession(f.id)).messages.map(m => m.content), ['NEW_B']);
});

test('legacy callers with no captured owner keep their existing save contract', async () => {
  const f = await pair();
  internals.recordSessionExecutionOwner(f.id, f.ownerB);
  assert.equal(await internals.saveTurnFinalSession(f.a, 'legacy-final'), true);
  assert.deepEqual((await srv.loadSession(f.id)).messages.map(m => m.content), ['OLD_A']);
});

test('session stays live across final persistence after its provider child has ended', { timeout: 15000 }, async () => {
  const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');
  const fake = await startFakeProvider({ handler: () => textFrames('FINAL_SETTLEMENT_PROOF') });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 14, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
    defaultWorkspace: home, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
    desktopMcp: { enabled: false, autodetect: false },
    providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'synthetic-key', model: 'fake-model' }],
  }));
  const session = await srv.createSession({ title: 'synthetic final-persistence barrier', cwd: home });
  const previous = internals.DeliveryHooks.capture;
  let release, entered, timer, turn;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  internals.DeliveryHooks.capture = async value => { if (value.id === session.id) { entered(); await barrier; } };
  try {
    turn = srv.runSessionTurn({ sessionId: session.id, message: 'finish once', cwd: home, source: 'http', onEvent() {} });
    await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('final-persistence barrier not reached')), 5000); })]);
    clearTimeout(timer);
    assert.equal(internals.activeChildren.has(session.id), false, 'provider has already left the active registry');
    assert.equal(internals.turnSettlers.has(session.id), true, 'driver still owns final persistence');
    assert.equal((await srv.loadSession(session.id)).messages.some(m => m.role === 'assistant'), false, 'final assistant is not yet on disk');
    const during = internals.sessionEnvelopeLiveParts(session.id);
    assert.equal(during.live, true, 'polling must not stop on the old user-only history');
    const etag = internals.sessionEnvelopeEtag(session.id, await internals.sessionEnvelopeStamp(session.id), during);
    release();
    assert.equal((await turn).ok, true);
    const finished = await srv.loadSession(session.id);
    assert.equal(finished.messages.at(-1).content, 'FINAL_SETTLEMENT_PROOF');
    const after = internals.sessionEnvelopeLiveParts(session.id);
    assert.equal(after.live, false, 'completed persistence releases the live state');
    assert.equal(after.execution, null);
    assert.notEqual(internals.sessionEnvelopeEtag(session.id, await internals.sessionEnvelopeStamp(session.id), after), etag, 'conditional polling observes the final transition');
  } finally {
    clearTimeout(timer); release();
    try { if (turn) await turn; } finally { internals.DeliveryHooks.capture = previous; await fake.close(); }
  }
});
