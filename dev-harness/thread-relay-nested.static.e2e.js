'use strict';
// Full original turn, relay, launchOrchestrateFromTurn closure and workflow
// registration. Pause at the real first save; model IO is a fetch counter only.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { functionBlock, sliceBlock } = require('./lib/source-slice');
const { createRunner } = require('./lib/harness');
const t = createRunner('THREAD RELAY NESTED STATIC'), repo = path.resolve(__dirname, '..'), src = path.join(repo, 'ruyi-workbench/app/src');
const flag = process.argv.find(value => value.startsWith('--baseline-root=')), before = flag && path.resolve(flag.slice('--baseline-root='.length));
const sourcePath = name => before && fs.existsSync(path.join(before, 'ruyi-workbench/app/src', name)) ? path.join(before, 'ruyi-workbench/app/src', name) : path.join(src, name);
const read = name => fs.readFileSync(sourcePath(name), 'utf8'), clone = value => JSON.parse(JSON.stringify(value));
const testFile = path.join(__dirname, 'workflow-combination.static.e2e.js'), nativeRequire = createRequire(testFile);
const fixtureFs = { ...fs, readFileSync(file, ...args) { return fs.readFileSync(path.dirname(String(file)) === src ? sourcePath(path.basename(file)) : file, ...args); } };
const testSource = fs.readFileSync(testFile, 'utf8');
const combined = vm.runInNewContext(testSource.slice(0, testSource.indexOf('\n(async () => {')) + '\ncombined', {
  require: name => name === 'node:fs' ? fixtureFs : nativeRequire(name), __dirname, Buffer, URL, AbortController, process: { argv: [], env: {} },
});
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
async function probe({ source = 'thread_relay', background = false, delegation = false, parentFirst = false, fault = '' } = {}) {
  const c = await combined(), { f, box } = c, registered = defer(), release = defer(), cleanup = defer();
  let nestedFetches = 0, parentFetches = 0, parentCurrentAtChild = false, observedKind = '', gated = false;
  const originalSave = box.saveAgentRun, originalMake = box.makeId;
  box.makeId = prefix => prefix === 'run' ? 'run_nested' : originalMake(prefix);
  Object.assign(box, { resumeInFlight: new Set(), getAgentRoleLibrary: async () => [], normalizeCwd: value => value, agentRoleIsUntrusted: () => false,
    syncRunEventSeq: async () => {}, sanitizeAgentOutputSchema: () => null, normalizeAgentGate: () => null, normalizeWaitSpec: () => null,
    normalizeWorkflowCondition: () => null, normalizeWorkflowLoop: () => null, purgeNodeEvidence() {}, appendAgentRunEvent() {},
    agentRunEventsJournal: () => ({ preflight: async () => {} }), resolveAgentTeamRoute: async (config, provider) => ({ engine: 'openai', provider, model: 'inert', preferenceUsed: false, fallbackReason: '' }),
    resolveNodeModel: () => 'inert', orchestrateArgsProblem: () => '', resolveOrchestrateNodes: async () => ({ nodes: [{ id: 'child', task: 'Approved child material', engine: 'openai', resources: [], dependsOn: [] }] }), orchestrateModelNotes: () => [],
    readAgentRunRecord: async () => null, deliverAgentRunEnvelope: async () => { cleanup.resolve(); }, agentRunCapabilities: () => ({}),
    fetch: url => { if (url === 'inert-child-provider') nestedFetches++; else parentFetches++; return { ok: true }; },
  });
  Object.assign(box.PrivacyGateway, { active: () => null, withPolicy: (sid, work) => work(), beforeModelRequest: async body => body, disclosurePolicyGuard: () => () => {}, assertPolicyAvailable() {} });
  const launch = sliceBlock(read('09-workflow.js'), '  const launchOrchestrateFromTurn =', '\n  // v1.0-S6'); assert.ok(launch.length > 5000);
  vm.runInNewContext(functionBlock(read('09-workflow.js'), 'runAgentWorkflow') + '\n' + functionBlock(read('04h-provider-http.js'), 'providerModelPostOnce')
    + '\nfunction nestedLaunch(session,provider,config,delegationPlan){const model="inert",isProviderPlanMode=false,planApproved=false,subagentTurnCap=4,ctrl=null,reg={};let subagentTotal=0;const backgroundAgentRunIds=new Set();' + launch
    + '\nreturn launchOrchestrateFromTurn;}\nSessionExecutionHooks.nestedLaunch=nestedLaunch;SessionExecutionHooks.nestedPost=providerModelPostOnce;', box);
  const assertDispatch = box.SessionExecutionHooks.assertDispatch;
  box.SessionExecutionHooks.assertDispatch = (owner, fence, submitted) => {
    if (submitted && fault === 'source') f.value('a').content = 'changed at final original workflow registration';
    if (submitted && fault === 'owner') box.turnSettlers.delete('b');
    return assertDispatch(owner, fence, submitted);
  };
  let nestedError = '';
  box.saveAgentRun = async run => {
    if (run.id !== 'run_nested' || gated) return originalSave(run);
    gated = true; observedKind = run.kind; registered.resolve(); await release.promise;
    parentCurrentAtChild = box.turnSettlers.has('b');
    try { await box.SessionExecutionHooks.nestedPost({ url: 'inert-child-provider', headers: {}, body: { messages: [{ role: 'user', content: 'approved child material' }] } }); }
    catch (e) { nestedError = String(e.code || e.message); }
    // Refuse this exact first save: the original catch removes its own runtime.
    // No reducer, node engine or timer can start.
    throw Error('owned registration boundary stop');
  };
  box.runOpenAiTurn = async args => {
    box.assertSessionExecutionOwner(args.session.id, args.executionOwner);
    args.session.turnSeq++; args.session.content = 'inert parent result'; f.sessions.set(args.session.id, clone(args.session));
    if (parentFirst) await box.SessionExecutionHooks.nestedPost({ url: 'inert-parent-provider', headers: {}, body: { messages: [] } });
    const launch = box.SessionExecutionHooks.nestedLaunch(args.session, { id: 'inert' }, { permissionMode: 'auto', subagentMaxConcurrent: 1, agentWorkflowMaxNodes: 1 }, delegation ? {} : null);
    const work = launch({ task: 'Approved child material', background }, () => {}, delegation), settled = work.then(value => ({ value }), error => ({ error }));
    if (fault) {
      const outcome = await settled; assert.ok(outcome.error); assert.equal(gated, false); assert.equal(box.activeAgentRuns.has('run_nested'), false); throw outcome.error;
    }
    await registered.promise;
    const runtime = box.activeAgentRuns.get('run_nested'); assert.equal(runtime.run.kind, delegation ? 'steward_delegation' : 'orchestrate_agents'); assert.equal(runtime.run.sessionId, 'b'); assert.equal(runtime.run.nodes[0].id, 'child'); assert.equal(box.turnSettlers.get('b'), args.executionOwner);
    if (background) { assert.equal((await settled).value.accepted, true); }
    else { release.resolve(); const stopped = await settled; assert.equal(stopped.error.message, 'owned registration boundary stop'); assert.equal(box.activeAgentRuns.has('run_nested'), false); }
    // A background child remains registered during this legitimate parent POST.
    await box.SessionExecutionHooks.nestedPost({ url: 'inert-parent-provider', headers: {}, body: { messages: [] } });
    args.onEvent({ type: 'result', ok: true });
  };
  let result;
  if (source === 'thread_relay') { const chain = await f.make('nested_' + background + delegation + fault); await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id); const run = f.admitted(); result = await f.relay.execute(run, run.nodes[0], new AbortController().signal, () => {}); }
  else result = await box.SessionExecutionHooks.runTurn({ sessionId: 'b', source: 'http' });
  if (fault) { assert.equal(result.ok, false); assert.equal(nestedFetches + parentFetches, 0); t.ok(true, 'first delegated registration rejects late ' + fault + ' change with no workflow registration or POST'); return; }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.owners.size, 0);
  if (background) { assert.equal(box.activeAgentRuns.has('run_nested'), true); release.resolve(); await cleanup.promise; assert.equal(box.activeAgentRuns.has('run_nested'), false); }
  assert.equal(observedKind, delegation ? 'steward_delegation' : 'orchestrate_agents'); assert.equal(parentFetches, parentFirst ? 2 : 1);
  if (before && source === 'thread_relay') { assert.equal(nestedError, 'thread_relay.target_busy'); assert.equal(nestedFetches, 0); t.ok(true, 'expected RED: full original fresh workflow registration inherits parent relay fence and rejects its first POST'); }
  else { assert.equal(nestedError, ''); assert.equal(nestedFetches, 1); assert.equal(parentCurrentAtChild, !background); t.ok(true, source + ': original ' + (background ? 'background child outlives parent turn' : 'foreground child') + (parentFirst ? ', after first parent POST' : delegation ? ', fromDelegation before parent POST' : ', first orchestration before parent POST') + ' retains its own lifecycle'); }
}
(async () => { try {
  await probe({ source: 'http' });
  if (before) await probe();
  else { for (const background of [false, true]) { for (const delegation of [false, true]) await probe({ background, delegation }); await probe({ background, parentFirst: true }); } for (const fault of ['source', 'owner']) await probe({ fault }); }
} catch (e) { t.fail(e.stack || String(e)); } finally { t.done({ exit: true }); } })();
