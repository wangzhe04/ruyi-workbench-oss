'use strict';
// Source-driven tests cover the new await boundaries before the shared runtime build.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { constBlock, functionBlock, sliceBlock } = require('../lib/source-slice');
const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const workflow = source('09-workflow.js'), runs = source('08-agent-runs.js'), governance = source('10-context-governance.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
function mailFixture(notify) {
  const run = { id: 'run_x', sessionId: 'sess_x', messages: [], nodes: [] }, runtime = { closing: false, mailQueues: new Map() };
  let serial = 0, saves = 0;
  const context = { run, runtime, runId: run.id, EventStreamHooks: { notifyAgentMessage: notify }, MAIL_TEXT_MAX: 2000,
    MAIL_PER_SENDER_MAX: 2, MAIL_GLOBAL_MAX: 3, MAIL_QUEUE_MAX: 2, makeId: () => 'msg_' + ++serial,
    nowIso: () => '2026-10-24T00:00:00Z', throttledSaveRun: () => saves++, nodeDeliveryEligibility: () => ({ ok: true }),
    ownAgentMessageReceipt: async () => ({ ok: true, status: 'delivered' }), agentRunRoster: () => ({}) };
  const block = sliceBlock(workflow, '  const sendToAgentImpl =', '  runtime.sendToAgent ='); assert.ok(block.length > 2000);
  return { run, runtime, send: vm.runInNewContext(block + '\nsendToAgentImpl;', context), saves: () => saves };
}

test('parent mail reserves admission before await and returns actual durable result after runtime closes', async () => {
  const releases = [], f = mailFixture(() => new Promise(resolve => releases.push(resolve)));
  const first = f.send('child', { target: 'parent', text: 'one' }), second = f.send('child', { target: 'parent', text: 'two' });
  assert.equal(f.run.messages.length, 2);
  const over = await f.send('child', { target: 'parent', text: 'three' }); assert.equal(over.ok, false); assert.equal(releases.length, 2);
  f.runtime.closing = true; releases[0](false); releases[1](true);
  const [failed, queued] = await Promise.all([first, second]);
  assert.equal(failed.ok, false); assert.equal(failed.status, 'undeliverable'); assert.equal(f.run.messages[0].dropped, true);
  assert.equal(queued.ok, true); assert.equal(queued.status, 'queued'); assert.equal(queued.delivered, false); assert.equal(f.run.messages[1].dropped, false);
  assert.equal((await f.send('child', { target: 'parent', text: 'closed' })).ok, false);
});

test('throwing async mail persistence cannot leave the reserved receipt falsely pending', async () => {
  const f = mailFixture(async () => { await turn(); throw Object.assign(Error('work_data_key.absent'), { code: 'work_data_key.absent' }); });
  const result = await f.send('child', { target: 'parent', text: 'one' });
  assert.equal(result.ok, false); assert.equal(f.run.messages[0].dropped, true); assert.equal(f.run.messages[0].dropReason, 'work_data_key.absent'); assert.equal(f.saves(), 1);
});

test('own receipt and live/cold run record wait for async projection and propagate storage errors', async () => {
  let resolve, fail = false;
  const run = { id: 'run_x', sessionId: 'sess_x', messages: [{ id: 'msg-1', sender: 'parent', target: 'child', createdAt: 'x' }] };
  const activeAgentRuns = new Map([['run_x', { run }]]);
  const context = { activeAgentRuns, safeSessionId: value => value, readAgentRunSnapshot: async () => run,
    EventStreamHooks: { projectAgentMessageReceipts: async current => { await new Promise(done => { resolve = done; }); if (fail) throw Object.assign(Error('key'), { code: 'work_data_key.absent' }); current.messages[0].deliveredAt = 'delivered'; } } };
  const api = vm.runInNewContext(['agentMessageReceipt', 'ownAgentMessageReceipt', 'readAgentRunRecord'].map(name => functionBlock(runs, name)).join('\n') + '\n({ownAgentMessageReceipt,readAgentRunRecord})', context);
  const pending = api.ownAgentMessageReceipt(run, 'parent', 'msg-1'); assert.equal(run.messages[0].deliveredAt, undefined); resolve(); assert.equal((await pending).status, 'delivered');
  const live = api.readAgentRunRecord('sess_x', 'run_x'); resolve(); assert.equal((await live).live, true);
  activeAgentRuns.clear(); const cold = api.readAgentRunRecord('sess_x', 'run_x'); await turn(); resolve(); assert.equal((await cold).live, false);
  fail = true; const denied = api.readAgentRunRecord('sess_x', 'run_x'); await turn(); resolve(); await assert.rejects(denied, { code: 'work_data_key.absent' });
});

test('wait_agents pending Promise resolving false never pretends to be ready mail', async () => {
  const context = { Set, Date, setTimeout, clearTimeout, safeSessionId: value => value, waitAgentsMaxMs: () => 1000,
    readAgentRunRecord: async () => ({ live: true, run: { id: 'run_x', status: 'running' } }),
    buildAgentRunEnvelope: run => ({ runId: run.id, status: run.status }), AGENT_RUN_TERMINAL: new Set(['succeeded']),
    EventStreamHooks: { pendingAgentMessages: async () => false } };
  const wait = vm.runInNewContext(functionBlock(workflow, 'waitForAgentRunResults') + '\nwaitForAgentRunResults;', context);
  const result = await wait('sess_x', ['run_x'], 0, null);
  assert.equal(result.timedOut, true); assert.equal(result.messageReady, undefined);
  context.EventStreamHooks.pendingAgentMessages = async () => true;
  assert.equal((await wait('sess_x', ['run_x'], 0, null)).messageReady, true);
  context.EventStreamHooks.pendingAgentMessages = async () => { throw Object.assign(Error('missing'), { code: 'work_data_key.absent' }); };
  await assert.rejects(wait('sess_x', ['run_x'], 0, null), { code: 'work_data_key.absent' });
});

function wakeFixture() {
  const attempts = new Map(), calls = [], resolves = [];
  const job = { id: 'agent:run_x', runId: 'run_x', status: 'succeeded', completedAt: '2026-10-24' };
  const context = { Map, Set, turnSettlers: new Map(), activeChildren: new Map(), providerCompactInFlight: new Map(), agentWakeSuppressed: new Set(),
    agentWakeAttempted: attempts, agentWakeChain: new Map(), AGENT_WAKE_SOURCE: 'agent_wake',
    readConfig: async () => ({}), loadSession: async () => ({ id: 'sess_x' }), logEvent: () => {}, agentWakeMessage: () => 'wake',
    EventStreamHooks: { pendingAgentWakeJobs: () => new Promise(resolve => resolves.push(resolve)) },
    runSessionTurn: args => { calls.push(args); return Promise.resolve({ ok: true }); } };
  const api = vm.runInNewContext(['agentWakeJobKey', 'agentWakeSkipsStatus', 'runAgentWake'].map(name => functionBlock(governance, name)).join('\n') + '\n({runAgentWake,agentWakeJobKey})', context);
  return { context, attempts, calls, resolves, job, api };
}

test('wake uses a fresh attempted set after async ledger reading so concurrent wake cannot start twice', async () => {
  const f = wakeFixture(), one = f.api.runAgentWake('sess_x', 'one'), two = f.api.runAgentWake('sess_x', 'two');
  while (f.resolves.length < 2) await turn();
  f.resolves[0]([f.job]); assert.equal((await one).ok, true);
  f.resolves[1]([f.job]); assert.equal((await two).skipped, 'nothing_pending'); assert.equal(f.calls.length, 1);
});

test('wake rechecks Stop and compaction after async ledger read; load errors preserve work_data', async () => {
  for (const flag of ['agentWakeSuppressed', 'providerCompactInFlight']) {
    const f = wakeFixture(), pending = f.api.runAgentWake('sess_x', 'test'); while (!f.resolves.length) await turn();
    f.context[flag] instanceof Set ? f.context[flag].add('sess_x') : f.context[flag].set('sess_x', true);
    f.resolves[0]([f.job]); assert.equal((await pending).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.attempts.size, 0);
  }
  const f = wakeFixture(); f.context.loadSession = async () => { throw Object.assign(Error('locked'), { code: 'work_data_key.absent' }); };
  await assert.rejects(f.api.runAgentWake('sess_x', 'test'), { code: 'work_data_key.absent' });
});

test('Claude prompt assembles delivered text after async drain rather than stringifying its Promise', async () => {
  const text = sliceBlock(source('05-claude-engine.js'), '  const currentUserEnvelope =', '  // 自有传输层'); assert.ok(text.length > 1000);
  const context = { slashCommand: false, basePrompt: 'user', memoryTurnCheck: '', recoveryHistory: '', indexInjection: '', kimiNativeSlashCommand: false,
    EventStreamHooks: { drainAgentEnvelopesText: async () => { await turn(); return 'DELIVERED ENVELOPE'; } }, session: {} };
  const prompt = await vm.runInNewContext('(async () => {' + text + '\nreturn fullPrompt;})()', context);
  assert.ok(prompt.includes('DELIVERED ENVELOPE')); assert.equal(prompt.includes('[object Promise]'), false);
});
