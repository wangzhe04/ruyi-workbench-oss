'use strict';
// Generated runtime, real local files/PowerShell/Windows DPAPI; only the HTTP model is synthetic.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-agent-snapshot-e2e-'));
const work = path.join(root, 'work'); fs.mkdirSync(work);
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const t = createRunner('AGENT RUN SNAPSHOT WORK DATA');
const names = [
  'saveAgentRun', 'readAgentRunSnapshot', 'listAgentRuns', 'listAgentRunDigests', 'agentRunFile', 'agentRunEventsFile',
  'readAgentRunRecord', 'stewardReadRunSnapshot', 'EventStreamHooks', 'createSession', 'loadSession', 'readConfig', 'mutateConfig',
  'workDataKeys', 'paths', 'getPretenderProjectionIndex', 'pretenderIndexRuntime', 'activeAgentRuns',
  'runAgentWorkflow', 'launchPersistedAgentRun', 'handleAgentRunApiRoutes', 'markInterruptedAgentRuns',
  'markInterruptedInterventions', 'agentRunWriteChains', 'agentRunEventChains', 'sessionWriteChains',
];
const runtimes = [];
const load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error && error.code || '').startsWith('work_data');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(api) {
  for (const chains of [api.agentRunWriteChains, api.agentRunEventChains, api.sessionWriteChains]) {
    await Promise.all([...chains.values()].map(promise => promise.catch(() => {})));
  }
}
async function waitForRun(api, sid, rid) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!api.activeAgentRuns.has(rid)) { await settle(api); return api.readAgentRunSnapshot(sid, rid); }
    await pause(50);
  }
  throw new Error('persisted workflow did not settle within 45 seconds');
}

(async () => {
  let fake, abort;
  try {
    const api = load();
    await api.mutateConfig(config => { config.workDataEncryptionV1 = false; return {}; });
    const session = await api.createSession({ title: 'Synthetic persisted snapshot recovery', cwd: work });
    const large = { id: 'run_ab12', sessionId: session.id, status: 'succeeded', createdAt: '2026-01-01T00:00:00Z',
      nodes: [{ id: 'large', status: 'succeeded', result: '本机快照😀'.repeat(100000) }] };
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
    const saving = api.saveAgentRun(large), submitted = JSON.stringify(large, null, 2); await saving;
    const largeFile = api.agentRunFile(session.id, large.id);
    assert.equal(fs.readFileSync(largeFile, 'utf8'), submitted);
    assert.equal((await api.listAgentRuns(session.id))[0].nodes[0].result, large.nodes[0].result);
    t.ok(true, 'OFF preserves exact legacy pretty JSON bytes for a >1 MiB Unicode snapshot');
    if (process.platform !== 'win32') {
      console.log('SKIP sealed snapshot lifecycle and PowerShell side effect: real Windows DPAPI is required');
      return;
    }
    await api.mutateConfig(config => { config.workDataEncryptionV1 = true; return {}; });
    await api.workDataKeys.ensure(); await api.saveAgentRun(large);
    const largeSealed = fs.readFileSync(largeFile);
    assert.equal(JSON.parse(largeSealed.toString('utf8').split('\n')[0]).workData, 3);
    assert.equal(largeSealed.includes(Buffer.from('本机快照')), false);
    t.ok(true, 'ON seals the complete large Unicode snapshot with actual DPAPI-backed keys');

    const counter = path.join(work, 'completed-node-counter.txt');
    let phase = 'first', firstCalls = 0, resumedCalls = 0;
    fake = await startFakeProvider({ handler(ctx) {
      if (phase === 'first') {
        firstCalls++;
        assert.ok(ctx.raw.includes('SNAPSHOT_COMPLETED_NODE'));
        if (firstCalls === 1) return toolCallFrames('powershell_run', {
          command: "Add-Content -LiteralPath './completed-node-counter.txt' -Value '1'; Write-Output 'snapshot durable operation complete'",
        }, 'snapshot-durable-call');
        assert.equal(firstCalls, 2, 'completed node has one tool execution and one concluding request');
        return textFrames('The durable operation finished successfully.');
      }
      resumedCalls++;
      assert.ok(ctx.raw.includes('SNAPSHOT_PENDING_NODE'), 'cold resume dispatches only the unfinished node');
      assert.equal(resumedCalls, 1, 'no replay or extra model retry');
      return textFrames('The remaining node is complete.');
    } });
    await api.mutateConfig(config => { Object.assign(config, {
      activeProvider: 'snapshot-fixture', providers: [{ id: 'snapshot-fixture', type: 'openai-compat', apiStyle: 'chat', model: 'synthetic-model', baseUrl: fake.url + '/v1', apiKey: 'SYNTHETIC-ONLY-AUTH' }],
      privacyModeV1: 'off', defaultWorkspace: work, permissionMode: 'bypass', toolLoadingMode: 'full',
      importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, bridgeExternalToolsToProvider: false,
      stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false, runtimeOptimizationShadowV1: false,
      contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
      allowCommandTools: true, allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false },
      openaiMaxToolIterations: 4, subagentMaxConcurrent: 1, agentWorkflowMaxNodes: 4, agentTaskPoolPolicy: 'off',
    }); return {}; });
    const config = await api.readConfig(); abort = new AbortController();
    const result = await api.runAgentWorkflow({ parentSession: session, provider: config.providers.find(row => row.id === 'snapshot-fixture'), config,
      nodes: [
        { id: 'n1', task: 'SNAPSHOT_COMPLETED_NODE: perform the one durable operation and then finish.', toolTier: 'exec', engine: 'openai', model: 'synthetic-model', maxIters: 4 },
        { id: 'n2', task: 'SNAPSHOT_PENDING_NODE: finish the remaining synthetic task without using tools.', dependsOn: ['n1'], toolTier: 'read', engine: 'openai', model: 'synthetic-model', maxIters: 2 },
      ], maxNodes: 4, ctrl: abort, permModeOverride: 'bypass', poolPolicy: 'off',
      onEvent(event) { if (event.type === 'agent_workflow' && event.state === 'node_end' && event.nodeId === 'n1' && event.status === 'succeeded') abort.abort(); },
    });
    await settle(api);
    assert.equal(firstCalls, 2); assert.equal(result.results.find(row => row.id === 'n1').status, 'succeeded');
    assert.notEqual(result.results.find(row => row.id === 'n2').status, 'succeeded');
    assert.deepEqual(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/), ['1']);
    const rid = result.runId, runFile = api.agentRunFile(session.id, rid), eventsFile = api.agentRunEventsFile(session.id, rid);
    const stoppedBytes = fs.readFileSync(runFile), eventBytes = fs.readFileSync(eventsFile);
    t.ok(true, 'real first workflow executes one PowerShell side effect and persists an unfinished dependent node');

    api.workDataKeys.clear();
    const cold = load();
    assert.equal((await cold.readAgentRunSnapshot(session.id, large.id)).nodes[0].result, large.nodes[0].result);
    assert.equal((await cold.readAgentRunRecord(session.id, large.id)).run.id, large.id);
    assert.equal((await cold.stewardReadRunSnapshot(session.id, large.id)).id, large.id);
    assert.equal((await cold.EventStreamHooks.readAgentRunSnapshot(session.id, large.id)).id, large.id);
    await cold.listAgentRunDigests(session.id); await cold.listAgentRunDigests(session.id);
    assert.ok((await cold.getPretenderProjectionIndex()).sessions.some(row => row.sessionId === session.id));
    assert.deepEqual(fs.readFileSync(largeFile), largeSealed);
    t.ok(true, 'cold generated runtime decrypts losslessly through shared readers and warms digest/projection without rewriting');

    const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json');
    for (const runtime of runtimes) runtime.workDataKeys.clear();
    fs.renameSync(keyFile, keyFile + '.missing');
    try {
      for (let i = 0; i < 2; i++) {
        await assert.rejects(() => cold.listAgentRunDigests(session.id), privateError);
        await assert.rejects(cold.getPretenderProjectionIndex, privateError);
      }
      await assert.rejects(() => cold.readAgentRunSnapshot(session.id, large.id), privateError);
      await assert.rejects(() => cold.saveAgentRun({ ...large, nodes: [] }), privateError);
      const beforeRequests = fake.requests.length;
      await assert.rejects(() => cold.launchPersistedAgentRun({ sessionId: session.id, runId: rid }), privateError);
      await assert.rejects(() => cold.handleAgentRunApiRoutes({ method: 'DELETE', headers: {}, url: '/api/agent-runs/' + rid + '?sessionId=' + session.id }, {}, '/api/agent-runs/' + rid), privateError);
      await cold.markInterruptedAgentRuns(); await cold.markInterruptedInterventions(); await settle(cold);
      assert.equal(fake.requests.length, beforeRequests); assert.equal(cold.activeAgentRuns.has(rid), false);
      assert.deepEqual(fs.readFileSync(largeFile), largeSealed); assert.deepEqual(fs.readFileSync(runFile), stoppedBytes);
      assert.deepEqual(fs.readFileSync(eventsFile), eventBytes);
      assert.deepEqual(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/), ['1']);
      t.ok(true, 'missing key rejects warm caches, overwrite, cold execution and real DELETE before changing snapshot/event authority');
    } finally { fs.renameSync(keyFile + '.missing', keyFile); }

    phase = 'resume';
    const resumed = await cold.launchPersistedAgentRun({ sessionId: session.id, runId: rid });
    assert.equal(resumed.ok, true); assert.equal(resumed.accepted, true);
    const finalRun = await waitForRun(cold, session.id, rid);
    assert.equal(finalRun.status, 'succeeded'); assert.equal(resumedCalls, 1);
    assert.equal(finalRun.nodes.find(row => row.id === 'n1').attempts, 1);
    assert.equal(finalRun.nodes.find(row => row.id === 'n2').status, 'succeeded');
    assert.deepEqual(fs.readFileSync(counter, 'utf8').trim().split(/\r?\n/), ['1']);
    assert.equal(fake.errors.length, 0);
    t.ok(true, 'restoring the key resumes only the pending node after restart; the completed tool operation stays exactly once');
  } finally {
    if (abort) abort.abort();
    for (const api of runtimes) {
      for (const runtime of api.activeAgentRuns.values()) { runtime.stopRequested = true; if (runtime.ctrl) runtime.ctrl.abort(); }
      clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer);
      await settle(api); api.workDataKeys.clear();
    }
    if (fake) await fake.close();
    assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-agent-snapshot-e2e-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { t.fail(error && error.stack || String(error)); }).finally(() => t.done());
