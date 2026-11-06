'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('WORKTREE CLEANUP RETRY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-worktree-retry-'));
process.env.RUYI_HOME = path.join(root, 'data');
(async () => {
  try {
    const S = loadServerInternals(['runAgentWorkflow', 'createSession', 'defaultConfig', 'agentRunFile'], { withEval: true });
    const provider = { id: 'fixture', type: 'openai-compat', apiStyle: 'chat', baseUrl: 'http://127.0.0.1:1', model: 'fixture' };
    const config = { ...S.defaultConfig(), defaultWorkspace: root, permissionMode: 'bypass', providers: [provider], activeProvider: provider.id,
      subagentMaxPerTurn: 4, subagentMaxConcurrent: 1, agentTaskPoolPolicy: 'off' };
    const session = await S.createSession({ title: 'cleanup retry fixture', cwd: root });
    for (const mode of ['degraded', 'failed', 'finalize', 'create', 'sub-cleanup']) {
      const worktree = path.join(root, 'worktree-' + mode); fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, 'retained.txt'), 'keep');
      S.__eval(`globalThis.__worktreeRetryMode=${JSON.stringify(mode)};globalThis.__worktreeRetryPath=${JSON.stringify(worktree)};globalThis.__worktreeRetryCalls=0;globalThis.__worktreeRetryFinalizeCalls=0;
        createAgentWorktree=async()=>{const isolation={mode:'worktree',status:'running',path:globalThis.__worktreeRetryPath,repoRoot:${JSON.stringify(root)}};
          if(globalThis.__worktreeRetryMode==='create')throw Object.assign(new Error('create cleanup unconfirmed'),{cleanupIncomplete:true,worktreeIsolation:{...isolation,cleanupIncomplete:true}});return isolation;};
        finalizeAgentWorktree=async()=>{globalThis.__worktreeRetryFinalizeCalls++;if(globalThis.__worktreeRetryMode==='finalize')throw Object.assign(new Error('finalize cleanup unconfirmed'),{cleanupIncomplete:true});};
        cleanupAgentWorktree=async()=>{throw Object.assign(new Error('cleanup unconfirmed'),{cleanupIncomplete:true});};
        runSubAgent=async()=>{globalThis.__worktreeRetryCalls++;return {ok:globalThis.__worktreeRetryMode!=='failed',cleanupIncomplete:globalThis.__worktreeRetryMode==='sub-cleanup',degraded:globalThis.__worktreeRetryMode==='degraded',warning:'synthetic degraded result',result:'fixture result',error:'synthetic failed result',iters:1,toolCalls:0};};`);
      const events = [];
      const result = await S.runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1,
        nodes: [{ id: 'writer', task: 'fixture', toolTier: 'edit', isolation: 'worktree', failurePolicy: 'retry', maxRetries: 2, degradedPolicy: 'retry' }],
        onEvent: event => events.push(event), ctrl: new AbortController(), poolPolicy: 'off' });
      const run = JSON.parse(fs.readFileSync(S.agentRunFile(session.id, result.runId), 'utf8'));
      const node = run.nodes[0];
      t.ok(node.status === 'failed' && node.errorClass === 'process_cleanup_incomplete' && node.isolation.path === worktree
        && fs.existsSync(path.join(worktree, 'retained.txt')), mode + ' failure persists isolation and failure classification');
      t.ok(!events.some(event => ['node_retry', 'node_degraded_retry'].includes(event.state))
        && S.__eval('globalThis.__worktreeRetryCalls') <= 1, mode + ' cleanup failure prevents automatic re-execution');
      if (['create', 'sub-cleanup'].includes(mode)) t.ok(S.__eval('globalThis.__worktreeRetryFinalizeCalls') === 0, mode + ' uncertainty prevents snapshot finalization');
      const resumed = await S.runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1, existingRun: run,
        onEvent: () => {}, ctrl: new AbortController(), poolPolicy: 'off' });
      t.ok(!resumed.ok && resumed.cleanupIncomplete && resumed.startedCount === 0, mode + ' persisted uncertainty prevents silent resume');
      if (mode === 'sub-cleanup') {
        const pending = structuredClone(run);
        pending.nodes[0].isolation.status = 'applying'; delete pending.nodes[0].isolation.cleanupIncomplete; pending.nodes[0].errorClass = '';
        const pendingResult = await S.runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1, existingRun: pending, onEvent: () => {}, ctrl: new AbortController() });
        t.ok(!pendingResult.ok && pendingResult.applicationUnconfirmed && pendingResult.startedCount === 0, 'unconfirmed apply intent also blocks workflow resume');
      }
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const key of ['__worktreeRetryMode', '__worktreeRetryPath', '__worktreeRetryCalls', '__worktreeRetryFinalizeCalls']) delete globalThis[key];
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
