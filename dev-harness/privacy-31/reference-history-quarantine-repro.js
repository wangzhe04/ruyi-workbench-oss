'use strict';
// Isolated real-engine regression. Only the model transport is synthetic; no listener,
// endpoint, existing profile, CLI or user workspace is read. --observe records a failing
// candidate without pretending that failure satisfies the desired regression contract.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-reference-history-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'loadSession', 'readConfig', 'mutateConfig'], { withEval: true });
const protocol = process.argv.find(arg => arg.startsWith('--protocol='))?.split('=')[1] || 'chat';
if (!['chat', 'responses', 'anthropic'].includes(protocol)) throw Error('synthetic_protocol_invalid');
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const state = app.__eval(`(() => {
  const state = { steps: [], wire: [], executions: [] };
  detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {};
  openAiStreamOnce = async function(options) {
    const projected = await PrivacyGateway.beforeRequest(options.body);
    PrivacyGateway.assertPolicyAvailable(); state.wire.push(structuredClone(projected));
    const step = state.steps.shift(); if (!step) throw Error('synthetic_model_steps_exhausted');
    return step;
  };
  const execute = toolCall;
  toolCall = async function(name, args, context) { state.executions.push({ name, path: args.path || '' }); return execute(name, args, context); };
  return state;
})()`);
const text = content => ({ text: content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const call = (id, filename, reference) => ({ text: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id, name: 'file_write', rawArgs: JSON.stringify({ path: filename, content: reference }) }] });
const outcome = async (sessionId, message) => {
  const events = [];
  try { const result = await app.runSessionTurn({ sessionId, message, source: 'user', onEvent: event => events.push(event) });
    const terminal = events.findLast(event => event.type === 'result');
    return { ok: terminal?.ok === true && !terminal.aborted && !events.some(event => event.type === 'error'),
      error: terminal?.error || events.find(event => event.type === 'error')?.error || result?.error || '' }; }
  catch (error) { return { ok: false, error: error.code || error.message }; }
};
(async () => {
  const report = { schema: 1, syntheticOnly: true };
  try {
    await app.mutateConfig(config => { Object.assign(config, { activeProvider: 'synthetic-history', providers: [{ id: 'synthetic-history', type: 'openai-compat', apiStyle: protocol, anthropicThinking: 'off', model: 'synthetic-model', baseUrl: 'https://fixture.invalid/v1', apiKey: 'SYNTHETIC-ENDPOINT-KEY' }],
      privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, defaultWorkspace: work,
      permissionMode: 'bypass', toolLoadingMode: 'full', importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      bridgeExternalToolsToProvider: false, stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false,
      runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
      allowCommandTools: false, allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false }, openaiMaxToolIterations: 4 }); return {}; });
    const cfg = await app.readConfig(), session = await app.createSession({ cwd: work, title: 'Synthetic reference history regression' });
    const original = 'history-quarantine-positive@example.test'; let reference;
    await app.PrivacyGateway.run(session.id, cfg, async () => { reference = (await app.PrivacyGateway.toolResult({ email: original })).email; });
    state.steps.push(call('synthetic-valid', 'valid.txt', reference), text('VALID_DONE'));
    const positive = await outcome(session.id, 'Write the requested synthetic contact to valid.txt.');
    report.validToolSucceeded = positive.ok && fs.existsSync(path.join(work, 'valid.txt')) && fs.readFileSync(path.join(work, 'valid.txt'), 'utf8') === original;
    const unknown = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    state.steps.push(call('synthetic-invalid', 'invalid.txt', unknown), text('Recovered after the refused invalid reference.'));
    const rejected = await outcome(session.id, 'Attempt only the explicitly requested synthetic negative case.');
    report.negativeTurn = { ok: rejected.ok, error: rejected.error };
    report.invalidExecutionCount = state.executions.filter(row => path.basename(row.path) === 'invalid.txt').length;
    report.invalidArtifactAbsent = !fs.existsSync(path.join(work, 'invalid.txt'));
    const saved = await app.loadSession(session.id);
    report.invalidArgumentPersisted = JSON.stringify(saved.providerHistory).includes(unknown);
    state.steps.length = 0; state.steps.push(text('NORMAL_FOLLOWUP_OK'));
    const beforeFollowup = state.wire.length, followup = await outcome(session.id, 'Explain the earlier result in an ordinary sentence.');
    report.normalFollowup = { ok: followup.ok, error: followup.error, modelRequests: state.wire.length - beforeFollowup };
    state.steps.length = 0; state.steps.push(call('synthetic-valid-again', 'valid-again.txt', reference), text('VALID_AGAIN_DONE'));
    const validAgain = await outcome(session.id, 'Reuse the same legitimate contact alias for valid-again.txt.');
    report.validReferenceRetained = validAgain.ok && fs.existsSync(path.join(work, 'valid-again.txt'))
      && fs.readFileSync(path.join(work, 'valid-again.txt'), 'utf8') === original;
    report.modelAuthoredCases = [];
    for (const [name, step] of [
      ['unknown-text', text('Synthetic narration: ' + unknown)],
      ['unknown-thinking', { ...text('Ordinary synthetic answer.'), reasoning: 'Synthetic reasoning: ' + unknown }],
      ['malformed-tool', call('synthetic-malformed', 'malformed.txt', '[[RUYI_PVT:EMAIL:not-a-valid-id]]')],
    ]) {
      const isolated = await app.createSession({ cwd: work, title: 'Synthetic ' + name });
      state.steps.length = 0; state.steps.push(step, text('RECOVERED_AFTER_REFUSAL'));
      const initial = await outcome(isolated.id, 'Exercise only the named synthetic model-output case.');
      state.steps.length = 0; state.steps.push(text('NORMAL_FOLLOWUP_OK'));
      const before = state.wire.length, next = await outcome(isolated.id, 'Reply with an ordinary public sentence.');
      report.modelAuthoredCases.push({ name, initialOk: initial.ok, followupOk: next.ok, error: next.error, followupRequests: state.wire.length - before });
    }
    const fresh = await app.createSession({ cwd: work, title: 'Synthetic forged user negative' });
    state.steps.length = 0; state.steps.push(text('MUST_NOT_REACH_MODEL'));
    const beforeForgery = state.wire.length, forged = await outcome(fresh.id, unknown);
    report.freshUserForgery = { refused: !forged.ok, modelRequests: state.wire.length - beforeForgery };
    state.steps.length = 0; state.steps.push(text('RECOVERED_AFTER_REJECTED_USER'));
    const afterUser = state.wire.length, userRecovery = await outcome(fresh.id, 'Reply normally after the refused synthetic input.');
    report.rejectedUserFollowup = { ok: userRecovery.ok, modelRequests: state.wire.length - afterUser };
    state.steps.length = 0; state.steps.push(call('synthetic-child-invalid', 'child-invalid.txt', unknown), text('CHILD_RECOVERED'));
    const child = await app.runSubAgentCore({ parentSession: session, provider: cfg.providers[0], config: cfg, task: 'Exercise the synthetic negative reference and recover.', agentKey: 'fixture', toolTier: 'edit', maxIters: 4, model: 'synthetic-model', onEvent: () => {}, subagentId: 'quarantine-child', depth: 1, ctrl: new AbortController(), permModeOverride: 'acceptEdits' });
    report.subagentRecovery = { ok: child.ok === true, invalidArtifactAbsent: !fs.existsSync(path.join(work, 'child-invalid.txt')) };
    await app.mutateConfig(current => { current.privacyModeV1 = 'off'; return {}; });
    state.steps.length = 0; state.steps.push(text('OFF_FOLLOWUP_OK'));
    const offRecovery = await outcome(session.id, 'Reply normally with privacy disabled.');
    report.offFollowup = { ok: offRecovery.ok, error: offRecovery.error, auditRetained: JSON.stringify((await app.loadSession(session.id)).providerHistory).includes(unknown) };
    // Off is deliberately allowed to send restored historical values. The enabled wire remains opaque.
    state.wire.pop();
    report.noOriginalOnWire = state.wire.every(body => !JSON.stringify(body).includes(original));
    report.desiredContract = report.validToolSucceeded && report.invalidExecutionCount === 0 && report.invalidArtifactAbsent
      && report.normalFollowup.ok && report.normalFollowup.modelRequests > 0 && report.validReferenceRetained
      && report.modelAuthoredCases.every(row => row.followupOk && row.followupRequests > 0) && report.freshUserForgery.refused
      && report.freshUserForgery.modelRequests === 0 && report.noOriginalOnWire && report.invalidArgumentPersisted
      && report.negativeTurn.ok && report.rejectedUserFollowup.ok && report.rejectedUserFollowup.modelRequests > 0
      && report.offFollowup.ok && report.offFollowup.auditRetained && report.subagentRecovery.ok && report.subagentRecovery.invalidArtifactAbsent;
    report.protocol = protocol;
    console.log(JSON.stringify(report, null, 2));
    if (!process.argv.includes('--observe')) assert.ok(report.desiredContract, 'a refused model reference must not poison later normal turns');
  } finally {
    f.vault.clear();
    if (path.dirname(root) !== temp || !path.basename(root).startsWith('ruyi-reference-history-')) throw Error('cleanup_scope');
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
