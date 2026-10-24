'use strict';
require('./lib/self-isolate-home.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-final-mail-'));
const candidateServer = process.env.RUYI_TEST_SERVER_JS;
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), root));
if (candidateServer) process.env.RUYI_TEST_SERVER_JS = candidateServer;
const { loadServerInternals } = require('./lib/server-internals');
const I = loadServerInternals(['runSubAgentCore', 'runAgentWorkflow', 'ownAgentMessageReceipt', 'nodeDeliveryEligibility', 'buildAgentRunEnvelope', 'settleWaitEnvelopes', 'EventStreamHooks', 'activeAgentRuns', 'readAgentRunRecord', 'withBackgroundJobOperation', 'flushWorkbenchLogs', 'defaultConfig', 'agentRunActionCommand']);
const t = createRunner('AGENT FINAL MAILBOX');
const { ok } = t;
function barrier() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }
async function main() {
  let entered, held, mode, requests;
  const fake = await startFakeProvider({ async handler(req) {
    requests.push(req.messages);
    if (mode === 'workflow' && JSON.stringify(req.messages).includes('DOWNSTREAM_CHECK')) return textFrames('downstream done');
    if (requests.length === 1) { entered.release(); await held.promise; }
    if (mode === 'error') { req.res.writeHead(400, { 'content-type': 'application/json' }); req.res.end(JSON.stringify({ error: { message: 'bad provider' } })); return; }
    return textFrames(requests.length === 1 ? 'provisional' : 'revised');
  } });
  const provider = { id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake' };
  const config = { permissionMode: 'bypass', defaultWorkspace: root };
  async function attempt(tag, maxIters, enqueue, abort, failure) {
    entered = barrier(); held = barrier(); requests = []; mode = failure ? 'error' : '';
    const queue = [], steers = [], events = [], ctrl = new AbortController();
    let sealed = '';
    const node = { id: 'worker', status: 'running' };
    const run = { id: 'run-' + tag, sessionId: 'sess-test', status: 'running', nodes: [node], messages: [] };
    const send = (id, text) => {
      const entry = { id, sender: 'parent', target: 'worker', text, createdAt: new Date().toISOString(), deliveredAt: null, dropped: false };
      run.messages.push(entry);
      const eligible = I.nodeDeliveryEligibility(run, 'worker');
      if (!eligible.ok) { entry.dropped = true; entry.dropReason = eligible.reason; } else queue.push({ sender: 'parent', text, entry });
      return entry;
    };
    const pending = I.runSubAgentCore({ parentSession: { id: 'sess-test', cwd: root }, provider, config, task: tag, toolTier: 'read', maxIters,
      onEvent: e => events.push(e), subagentId: 'sub-' + tag, depth: 1, ctrl, runId: run.id,
      getMail: () => queue.splice(0), getSteer: () => steers.splice(0), steerReminder: '\nSTRICT_JSON_REMINDER',
      closeInbox: reason => { if (!sealed) { sealed = reason; node.mailboxClosedReason = reason; } for (const m of queue.splice(0)) { m.entry.dropped = true; m.entry.dropReason = sealed; } },
    });
    await entered.promise;
    if (enqueue) { send('first', 'FIRST_FACT'); send('second', 'SECOND_FACT'); steers.push('USER_PRIORITY'); }
    if (abort) ctrl.abort();
    held.release();
    const result = await pending;
    return { result, run, events, requests: requests.slice(), sealed, send };
  }
  try {
    const race = await attempt('final-race', 4, true);
    ok(race.result.ok && race.result.result === 'revised', 'mail arriving during final response revises final output');
    ok(race.requests.length === 2, 'exactly one existing-budget request consumes final-response mail');
    const received = race.requests[1].filter(m => typeof m.content === 'string' && m.content.includes('[节点 parent 消息]'));
    ok(received.length === 2 && received[0].content.includes('FIRST_FACT') && received[1].content.includes('SECOND_FACT'), 'FIFO mail injected exactly once into next provider request');
    ok(received.every(m => m.content.includes('参考信息') && m.content.includes('STRICT_JSON_REMINDER')), 'peer reference framing and structured reminder preserved');
    ok(race.requests[1].findIndex(m => m.content && m.content.includes('[编排者插话] USER_PRIORITY')) < race.requests[1].indexOf(received[0]), 'user steer precedes peer mail');
    ok((await I.ownAgentMessageReceipt(race.run, 'parent', 'first')).status === 'delivered', 'sender queries delivered local injection');
    ok((await I.ownAgentMessageReceipt(race.run, 'foreign', 'first')).status === 'not_found', 'foreign sender cannot inspect receipt');
    I.activeAgentRuns.set(race.run.id, { run: race.run });
    const closedSteer = await I.agentRunActionCommand({ sessionId: race.run.sessionId, runId: race.run.id, action: 'steer_node', nodeId: 'worker', text: 'late steer' });
    I.activeAgentRuns.delete(race.run.id);
    ok(closedSteer.status === 409 && typeof closedSteer.body === 'object' && closedSteer.body.ok === false && closedSteer.body.error.code === 'agent_run.mailbox_closed', 'sealed node steer command returns structured HTTP-compatible 409 body');
    const late = race.send('late', 'LATE_FACT');
    ok(late.dropped && (await I.ownAgentMessageReceipt(race.run, 'parent', 'late')).reason === 'completed', 'post-seal arrival has explicit undeliverable receipt');
    const clean = await attempt('no-mail', 4, false);
    ok(clean.requests.length === 1 && clean.result.result === 'provisional', 'no pending mail causes no extra provider request');
    const capped = await attempt('capped', 1, true);
    ok(capped.requests.length === 1 && capped.run.messages.every(m => m.dropped && m.dropReason === 'iteration_budget'), 'exact maxIters closes pending mail without budget extension');
    const aborted = await attempt('aborted', 4, true, true);
    ok(!aborted.result.ok && aborted.run.messages.every(m => m.dropped && m.dropReason === 'aborted'), 'abort settles pending receipts');
    const failed = await attempt('failed', 4, true, false, true);
    ok(!failed.result.ok && failed.run.messages.every(m => m.dropped && m.dropReason === 'provider_error'), 'failed provider seals pending receipts');
    const env = I.buildAgentRunEnvelope({ ...capped.run, status: 'succeeded' });
    ok(env.messageReceipts.length === 2 && env.messageReceipts.every(m => m.status === 'undeliverable' && !('text' in m)), 'completion envelope carries bounded receipt metadata without duplicate body');
    const short = I.settleWaitEnvelopes({ id: 'sess-test', backgroundJobSeen: ['agent:' + env.runId] }, { runs: [env] });
    ok(short.runs[0].messageReceipts.length === 2, 'already-delivered completion short receipt preserves unsuccessful mail');
    entered = barrier(); held = barrier(); requests = []; mode = 'workflow';
    const parent = { id: 'sess-workflow', cwd: root, providerHistory: [], messages: [] };
    const workflow = I.runAgentWorkflow({ parentSession: parent, provider, maxNodes: 4, config: { ...I.defaultConfig(), ...config, providers: [provider], activeProvider: 'fake', externalMcpServers: [], desktopMcp: { enabled: false } },
      nodes: [{ id: 'worker', task: 'WORKFLOW_FINAL', maxIters: 4 }, { id: 'downstream', task: 'DOWNSTREAM_CHECK', dependsOn: ['worker'] }], onEvent: () => {} });
    await entered.promise;
    const runtime = [...I.activeAgentRuns.values()].find(r => r.run.sessionId === parent.id);
    const queuedReply = await runtime.sendToAgent({ targetNodeKey: 'worker', message: 'WORKFLOW_FACT' });
    ok((await runtime.sendToAgent({ action: 'status', messageId: queuedReply.messageId })).status === 'queued', 'production status is queued during held final response');
    for (let n = 0; n < 10; n++) await runtime.sendToAgent({ action: 'status', messageId: queuedReply.messageId });
    const rejectedAction = await runtime.sendToAgent({ action: '', targetNodeKey: 'worker', message: 'SHOULD_NOT_SEND' });
    ok(rejectedAction.ok === false && runtime.run.messages.length === 1, 'status queries do not consume quota and invalid action cannot send');
    held.release();
    const outcome = await workflow;
    const record = await I.readAgentRunRecord(parent.id, outcome.runId);
    const downstream = requests.find(messages => JSON.stringify(messages).includes('DOWNSTREAM_CHECK'));
    ok(record && record.run.nodes.find(n => n.id === 'worker').result === 'revised' && JSON.stringify(downstream).includes('revised') && !JSON.stringify(downstream).includes('provisional'), 'downstream receives only revised final answer');
    ok((await I.ownAgentMessageReceipt(record.run, 'parent', queuedReply.messageId)).status === 'delivered', 'completed run retains sender-visible delivery status');
    await I.withBackgroundJobOperation('sess-idle', operation => operation.write([{ id: 'agent-message:idle-mail', kind: 'agent_message', sessionId: 'sess-idle', sourceSessionId: parent.id, status: 'queued', output: 'PRIVATE_BODY' }]));
    ok((await I.EventStreamHooks.agentMessageStatus(parent.id, 'sess-idle', 'idle-mail')).status === 'queued', 'idle cross-session receipt remains queued');
    ok((await I.EventStreamHooks.agentMessageStatus('foreign', 'sess-idle', 'idle-mail')).status === 'not_found', 'cross-session receipt is source-session bound');
    ok((await I.EventStreamHooks.agentMessageStatus(parent.id, '../bad', 'idle-mail')).status === 'not_found', 'invalid status target returns structured unavailable receipt');
    await I.withBackgroundJobOperation('sess-idle', operation => operation.write([{ id: 'agent-message:idle-mail', kind: 'agent_message', sessionId: 'sess-idle', sourceSessionId: parent.id, status: 'delivered', deliveredAt: '2026-10-15T00:00:00.000Z' }]));
    ok((await I.EventStreamHooks.agentMessageStatus(parent.id, 'sess-idle', 'idle-mail')).status === 'delivered', 'cross-session delivered receipt uses ledger');
    const queued = { id: 'queued', sender: 'parent', target: 'worker', deliveredAt: null };
    capped.run.messages.push(queued);
    ok((await I.ownAgentMessageReceipt(capped.run, 'parent', 'queued')).status === 'queued', 'queued status remains distinct from delivered');
  } finally { await fake.close(); await I.flushWorkbenchLogs({ allowFailure: true }); fs.rmSync(root, { recursive: true, force: true }); }
  t.done();
}
main().catch(e => { console.error(e); t.fail('unexpected exception'); t.done(); });
