'use strict';
// Synthetic actual-engine regression. Never reads a user transcript or calls a model.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-typed-turn-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'); fs.mkdirSync(data); fs.mkdirSync(work);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const server = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
const candidate = process.argv.find(value => value.startsWith('--candidate='))?.slice(12);
const names = ['PrivacyCore', 'PrivacyGateway', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'loadSession', 'readConfig', 'mutateConfig'];
let app;
if (candidate) {
  const mod = new Module(server, module); mod.filename = server; mod.paths = Module._nodeModulePaths(path.dirname(server));
  mod._compile(fs.readFileSync(path.resolve(candidate), 'utf8') + '\nmodule.exports.__internals={' + names.join(',') + '};module.exports.__internals.__eval=code=>eval(code);', server);
  app = mod.exports.__internals;
} else app = require('../lib/server-internals').loadServerInternals(names, { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const state = app.__eval(`(() => {
  const state = { steps: [], wire: [] };
  detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {};
  openAiStreamOnce = async ({ body }) => {
    const sent = await (PrivacyGateway.beforeModelRequest || PrivacyGateway.beforeRequest)(body);
    state.wire.push(structuredClone(sent));
    const step = state.steps.shift(); if (!step) throw Error('synthetic_steps_exhausted'); return step;
  };
  return state;
})()`);
const protocol = process.argv.find(arg => arg.startsWith('--protocol='))?.split('=')[1] || 'chat';
if (!['chat', 'responses', 'anthropic'].includes(protocol)) throw Error('protocol_invalid');
const text = value => ({ text: value, reasoning: '', toolCalls: [], finishReason: 'stop' });
const call = (id, name, args) => ({ text: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id, name, rawArgs: JSON.stringify(args) }] });
async function turn(sessionId, message) {
  const events = [], start = state.wire.length;
  try {
    await app.runSessionTurn({ sessionId, message, source: 'user', onEvent: event => events.push(event) });
    const result = events.findLast(event => event.type === 'result');
    return { ok: result?.ok === true && !result.aborted && !events.some(event => event.type === 'error'),
      error: String(result?.error || events.find(event => event.type === 'error')?.error || '').match(/privacy\.[a-z_]+/)?.[0] || '', requests: state.wire.length - start };
  } catch (error) { return { ok: false, error: /^privacy\.[a-z_]+$/.test(error.code || '') ? error.code : 'sanitized_failure', requests: state.wire.length - start }; }
}
(async () => {
  const report = { syntheticOnly: true, protocol, networkCalls: 0 };
  try {
    await app.mutateConfig(config => { Object.assign(config, { activeProvider: 'typed-fixture', providers: [{ id: 'typed-fixture', type: 'openai-compat', apiStyle: protocol, anthropicThinking: 'off', model: 'synthetic', baseUrl: 'https://fixture.invalid/v1', apiKey: 'SYNTHETIC-AUTH' }],
      privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, defaultWorkspace: work,
      permissionMode: 'bypass', toolLoadingMode: 'full', importAgentInstructions: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      bridgeExternalToolsToProvider: false, stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false,
      runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false,
      allowCommandTools: true, allowDesktopTools: false, desktopMcp: { enabled: false, autodetect: false }, openaiMaxToolIterations: 5 }); return {}; });
    const session = await app.createSession({ cwd: work, title: 'Synthetic typed recovery' });
    const source = '{"apiKey":null,"phone":13600005555,"orderId":"PUBLIC-ORDER-12345"}';
    state.steps.push(call('typed-write', 'file_write', { path: 'typed.json', content: source }), text('WRITE_FINISHED'));
    report.write = await turn(session.id, 'Write the requested synthetic configuration once to typed.json.');
    report.writeExecutedExactly = fs.existsSync(path.join(work, 'typed.json')) && fs.readFileSync(path.join(work, 'typed.json'), 'utf8') === source;
    state.steps.length = 0; state.steps.push(text('FOLLOWUP_FINISHED'));
    report.followup = await turn(session.id, 'Continue with a normal explanation, without repeating the earlier write.');
    const saved = await app.loadSession(session.id);
    report.canonicalArgumentsRetained = saved.providerHistory.some(message => message.tool_calls?.some(tool => tool.id === 'typed-write' && tool.function.arguments.includes('apiKey')));
    const resultSession = await app.createSession({ cwd: work, title: 'Synthetic typed tool result' });
    const command = "Add-Content -LiteralPath './counter.txt' -Value '1'; Write-Output '" + source + "'";
    state.steps.length = 0; state.steps.push(call('typed-output', 'powershell_run', { command }), text('RESULT_FINISHED'));
    report.toolResult = await turn(resultSession.id, 'Run the synthetic local counter once and report its result.');
    report.counterExecutions = fs.existsSync(path.join(work, 'counter.txt')) ? fs.readFileSync(path.join(work, 'counter.txt'), 'utf8').trim().split(/\r?\n/).length : 0;
    state.steps.length = 0; state.steps.push(text('RESULT_FOLLOWUP_FINISHED'));
    report.resultFollowup = await turn(resultSession.id, 'Continue normally; do not rerun the previous command.');
    const fresh = await app.createSession({ cwd: work, title: 'Synthetic typed fresh input' });
    state.steps.length = 0; state.steps.push(text('INPUT_WITHHELD_ACKNOWLEDGED'));
    report.freshInput = await turn(fresh.id, source);
    state.steps.length = 0; state.steps.push(call('typed-child-write', 'file_write', { path: 'typed-child.json', content: source }), text('CHILD_FINISHED'));
    const cfg = await app.readConfig();
    const child = await app.runSubAgentCore({ parentSession: session, provider: cfg.providers[0], config: cfg,
      task: 'Write the requested synthetic configuration once and finish.', agentKey: 'fixture', toolTier: 'edit', maxIters: 4, model: 'synthetic',
      onEvent: () => {}, subagentId: 'typed-child', depth: 1, ctrl: new AbortController(), permModeOverride: 'acceptEdits' });
    report.child = { ok: child.ok === true, exactArtifact: fs.existsSync(path.join(work, 'typed-child.json')) && fs.readFileSync(path.join(work, 'typed-child.json'), 'utf8') === source };
    report.noTypedOriginalOnWire = state.wire.every(body => !JSON.stringify(body).includes('13600005555'));
    report.desiredContract = report.write.ok && report.followup.ok && report.toolResult.ok && report.resultFollowup.ok && report.freshInput.ok
      && report.writeExecutedExactly && report.counterExecutions === 1 && report.canonicalArgumentsRetained && report.noTypedOriginalOnWire && report.child.ok && report.child.exactArtifact;
    console.log(JSON.stringify(report, null, 2));
    if (!report.desiredContract && !process.argv.includes('--observe')) process.exitCode = 1;
  } finally { f.vault.clear(); if (path.dirname(root) !== base || !path.basename(root).startsWith('ruyi-typed-turn-')) throw Error('cleanup_scope'); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(/^privacy\.[a-z_]+$/.test(error.code || '') ? error.code : 'typed_repro_failed'); process.exitCode = 1; });
