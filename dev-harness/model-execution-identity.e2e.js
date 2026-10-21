'use strict';
// Actual generated engines,
// loopback provider requests and tool results, no live credentials or CLI spawn.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./lib/fake-anthropic-provider');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-model-identity-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = require('./lib/server-internals').loadServerInternals(['runOpenAiTurn', 'runSessionTurn', 'ensureStewardSession', 'saveSession', 'runSubAgentCore', 'buildWorkbenchSelfStatus', 'buildModelExecutionFacts', 'buildModelIdentityPrompt', 'buildStewardSystemPrompt', 'getPromptPack', 'providerWireProtocol', 'getCapabilities', 'createSession', 'mutateConfig', 'readConfig', 'stewardImplUsage', 'stewardImplConfigGet'], { withEval: true });
const t = createRunner('MODEL EXECUTION IDENTITY'), { ok } = t;
let fake, anthropic, rows = [], serial = 0, changedDefault = false;
(async () => {
  app.__eval('networkAnchors = () => [];'); // Keep capability probes offline; provider traffic remains loopback.
  fake = await startFakeProvider({ async handler(ctx) {
    rows.push(structuredClone(ctx.body));
    const hasResult = ctx.messages.some(m => m.role === 'tool');
    if (!hasResult && ctx.body.model === 'session-override' && !changedDefault) {
      changedDefault = true;
      await app.mutateConfig(current => { current.providers = current.providers.map(p => p.id === 'identity-provider' ? { ...p, model: 'changed-global-default' } : p); });
    }
    const name = ctx.tools.some(tool => tool.function?.name === 'steward_self_status') ? 'steward_self_status' : 'workbench_self_status';
    const offered = ctx.tools.some(tool => tool.function?.name === name);
    const frames = hasResult || !offered ? textFrames('Synthetic model identity checked.') : toolCallFrames(name, { section: 'identity' }, 'identity-call');
    // A proxy's returned label is not proof of its physical backend identity.
    return frames.map(frame => ({ ...frame, model: 'proxy-reported-other-model' }));
  } });
  const provider = { id: 'identity-provider', label: 'Synthetic route', type: 'openai-compat', apiStyle: 'chat', baseUrl: fake.url, apiKey: 'synthetic-identity-key', model: 'global-default', models: [{ id: 'global-default' }, { id: 'session-override' }, { id: 'child-override' }, { id: 'steward-override' }], vision: true };
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1: 'off', providers: [provider], activeProvider: provider.id, defaultWorkspace: root, workspaces: [], recentWorkspaces: [], permissionMode: 'acceptEdits', toolLoadingMode: 'full', includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false }, schedulerEnabledV1: false, stewardEnabledV1: true, stewardPersonaName: 'Synthetic steward' }));
  let config = await app.readConfig();
  function inspect(caseName, role, model, providerId) {
    const first = rows.find(row => row.model === model);
    const followup = rows.find(row => row.messages?.some(m => m.role === 'tool'));
    const toolMessage = followup?.messages.find(m => m.role === 'tool');
    const result = toolMessage && JSON.parse(toolMessage.content);
    const system = (first?.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    ok(Boolean(first) && system.includes(model) && /请求模型标识|requested model identifier/.test(system), caseName + ': actual resolved request body and system identity agree');
    ok(result?.execution?.requestModel === model && result.execution.providerId === providerId && result.execution.role === role && result.execution.source === 'host_request_route', caseName + ': actual tool roundtrip retains host route/model/role');
    ok(result?.execution?.backendModelVerified === false && result.execution.requestModel !== 'proxy-reported-other-model', caseName + ': returned proxy alias never becomes a verified backend claim');
  }
  rows = [];
  const mainSession = await app.createSession({ cwd: root, title: 'Identity session override' });
  mainSession.engineRoute = { engine: 'openai', providerId: provider.id, model: 'session-override' };
  await app.saveSession(mainSession);
  await app.runSessionTurn({ sessionId: mainSession.id, message: 'Query your current model identity.', cwd: root, onEvent() {} });
  inspect('session override versus global default changed in flight', 'main', 'session-override', provider.id);

  // Exercise the production steward resolver, not a hand-overridden provider.
  const stewardProvider = { ...provider, id: 'steward-identity-provider', label: 'Synthetic steward route', model: 'steward-provider-default' };
  await app.mutateConfig(current => Object.assign(current, { providers: [...current.providers, stewardProvider], stewardProviderId: stewardProvider.id, stewardModel: 'steward-override' }));
  config = await app.readConfig();
  const ensured = await app.ensureStewardSession(config);
  ok(ensured.ok && ensured.route.providerId === stewardProvider.id && ensured.route.model === 'steward-override', 'ensureStewardSession resolves configured stewardProviderId/stewardModel independently of global default');
  const stewardIdentity = app.buildModelIdentityPrompt(stewardProvider, ensured.route.model, ensured.session.cwd, config);
  const stewardPrompt = await app.buildStewardSystemPrompt(ensured.session, config, { provider: stewardProvider, model: ensured.route.model, workingDir: ensured.session.cwd });
  const stewardBase = app.getPromptPack(config.locale).steward.stable;
  ok(stewardBase.length <= 2500 && stewardPrompt.stable === stewardIdentity + '\n\n' + stewardBase && stewardPrompt.stable.split(stewardIdentity).length === 2, 'combined steward stable contains exactly one shared identity layer and preserves the original <=2500 base pack');
  console.log('OBSERVATION stewardIdentityChars=' + stewardIdentity.length + ' combinedStableChars=' + stewardPrompt.stable.length + ' (synthetic route; no billing change)');
  rows = [];
  await app.runSessionTurn({ sessionId: ensured.session.id, message: 'Query your current model identity.', cwd: ensured.session.cwd, source: 'steward', engineRoute: ensured.route, onEvent() {} });
  inspect('actual steward resolver to turn', 'steward', 'steward-override', stewardProvider.id);

  // No explicit sub model: verify the real role/preferred/default precedence.
  const subCases = [
    { name: 'explicit beats role and preferred', model: 'child-explicit', roleModel: 'child-role', preferred: 'child-preferred', expected: 'child-explicit' },
    { name: 'role beats preferred and provider default', roleModel: 'child-role', preferred: 'child-preferred', expected: 'child-role' },
    { name: 'preferred beats provider default', preferred: 'child-preferred', expected: 'child-preferred' },
    { name: 'provider default when no overrides', preferred: '', expected: 'global-default' },
  ];
  for (const item of subCases) {
    rows = [];
    const parentSession = await app.createSession({ cwd: root, title: 'Identity child ' + (++serial) });
    const childConfig = { ...config, subagentPreferredModel: item.preferred };
    const roleDefinition = item.roleModel ? { id: 'identity-role', label: 'Identity role', source: 'builtin', models: { openai: item.roleModel }, toolTier: 'read' } : undefined;
    await app.runSubAgentCore({ parentSession, provider, config: childConfig, task: 'Query your current model identity.', agentKey: 'identity-child-' + serial, subagentId: 'identity-child-' + serial, toolTier: 'read', maxIters: 3, ...(item.model ? { model: item.model } : {}), roleDefinition, depth: 1, onEvent() {}, ctrl: new AbortController() });
    inspect(item.name, 'subagent', item.expected, provider.id);
  }
  const anthropicRows = [];
  anthropic = await startFakeAnthropic({ handler(ctx) {
    anthropicRows.push(structuredClone(ctx.body));
    const answered = ctx.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
    const offered = ctx.tools.some(tool => tool.name === 'workbench_self_status');
    return messageEvents({ model: 'proxy-reported-other-model', ...(answered || !offered
      ? { text: 'Synthetic Messages identity checked.' }
      : { toolUses: [{ id: 'identity-anthropic-call', name: 'workbench_self_status', input: { section: 'identity' } }] }) });
  } });
  const messagesProvider = { ...provider, id: 'messages-identity-provider', label: 'Synthetic compatible route', apiStyle: 'anthropic', baseUrl: anthropic.url, model: 'claude-identity-request-alias' };
  await app.mutateConfig(current => { current.providers = [...current.providers, messagesProvider]; });
  const messagesSession = await app.createSession({ cwd: root, title: 'Messages protocol identity' });
  messagesSession.engineRoute = { engine: 'openai', providerId: messagesProvider.id, model: messagesProvider.model }; await app.saveSession(messagesSession);
  await app.runSessionTurn({ sessionId: messagesSession.id, message: 'Query your current model identity.', cwd: root, onEvent() {} });
  const messagesRequest = anthropicRows.find(row => row.model === messagesProvider.model);
  const messagesSystem = Array.isArray(messagesRequest?.system) ? messagesRequest.system.map(block => block.text || '').join('\n') : String(messagesRequest?.system || '');
  const messagesReply = anthropicRows.flatMap(row => row.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result');
  const toolText = typeof messagesReply?.content === 'string' ? messagesReply.content : (messagesReply?.content || []).map(block => block.text || '').join('');
  const messagesIdentity = toolText ? JSON.parse(toolText) : null;
  ok(Boolean(messagesRequest) && messagesSystem.includes('Anthropic Messages') && messagesSystem.includes(messagesProvider.model), 'actual Messages request system identifies its registered protocol and requested alias');
  ok(messagesIdentity?.execution?.protocol === 'anthropic' && messagesIdentity.execution.protocolLabel === 'Anthropic Messages'
    && messagesIdentity.execution.requestModel === messagesProvider.model && messagesIdentity.execution.backendModelVerified === false,
    'actual Messages tool roundtrip distinguishes protocol, requested alias and unverified returned model');
  ok(changedDefault, 'global default changed after the actual main request without changing its execution identity');
  await app.mutateConfig(current => { current.providers = current.providers.map(p => p.id === provider.id ? { ...p, model: 'global-default' } : p); });
  const facts = app.buildModelExecutionFacts({ ...provider, model: 'provider-default' }, 'live-request', 'main');
  app.__eval('globalThis.__identityReadConfig = readConfig; readConfig = async () => { throw Error("identity-only must not read configuration"); };');
  let identity;
  try { identity = await app.buildWorkbenchSelfStatus({ section: 'identity' }, { provider, execution: facts }); }
  finally { app.__eval('readConfig = globalThis.__identityReadConfig; delete globalThis.__identityReadConfig;'); }
  ok(identity.execution.requestModel === 'live-request' && !identity.config, 'identity-only returns current host facts before any configuration read');
  const runtimeProvider = { ...provider, id: 'runtime-anthropic-provider', apiStyle: 'anthropic', vision: false };
  const runtimeFacts = app.buildModelExecutionFacts(runtimeProvider, 'live-request', 'main');
  const configured = await app.buildWorkbenchSelfStatus({ section: 'config' }, { provider: runtimeProvider, execution: runtimeFacts });
  ok(configured.execution.requestModel === 'live-request' && configured.config.model === 'global-default' && configured.config.identityAuthority === false, 'global configured model is explicitly separate from execution');
  ok(configured.config.providerId === provider.id && configured.config.modalities.vision === true
    && configured.config.providerCapabilities.protocol === 'chat' && configured.config.providerCapabilities.source === 'configuration_defaults',
    'configuration snapshot consistently reports global Chat defaults and vision');
  ok(configured.capabilities.modalities.vision === false && configured.capabilities.providerCapabilities.providerId === runtimeProvider.id
    && configured.capabilities.providerCapabilities.protocol === 'anthropic' && configured.capabilities.providerCapabilities.source === 'host_execution_provider_configuration',
    'capabilities consistently report the actual Anthropic runtime provider and vision');
  const noContext = await app.buildWorkbenchSelfStatus({ section: 'identity' }, {});
  const cli = await app.buildWorkbenchSelfStatus({ section: 'identity' }, { session: { engineRoute: { engine: 'claude' } } });
  ok(noContext.execution.status === 'unknown' && cli.execution.status === 'unknown', 'no-context and unproven CLI identity never fill from native provider defaults');
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const routed = app.buildModelExecutionFacts({ ...provider, apiStyle: protocol }, 'proxy-model-alias', 'main');
    const caps = await app.getCapabilities({ ...config, activeProvider: provider.id, providers: [{ ...provider, apiStyle: protocol }] }, true);
    ok(caps.provider.id === provider.id && caps.provider.apiStyle === protocol, protocol + ': capability packet names the actual probed provider protocol');
    const wire = app.providerWireProtocol(protocol);
    const identityLine = app.buildModelIdentityPrompt({ ...provider, apiStyle: protocol }, 'proxy-model-alias', root, config);
    ok(routed.engine === 'native-provider' && routed.protocol === protocol && routed.protocolLabel === wire.displayLabel && identityLine.includes(wire.displayLabel) && routed.backendModelVerified === false,
      protocol + ': execution identifies the native transport and protocol without asserting a model vendor or backend');
  }
  ok(app.providerWireProtocol('chat').displayLabel === 'Chat Completions' && app.providerWireProtocol('responses').displayLabel === 'Responses API' && app.providerWireProtocol('anthropic').displayLabel === 'Anthropic Messages', 'protocol display names live in the existing backend registry, independently of provider brand');
  const safe = app.buildModelExecutionFacts({ id: 'route', label: 'https://user:secret@host.invalid?key=synthetic' }, 'request-alias', 'main');
  ok(!JSON.stringify(safe).includes('secret') && !JSON.stringify(safe).includes('host.invalid'), 'execution facts do not inject endpoint URL credentials/query');
  const usage = await app.stewardImplUsage({});
  const settings = await app.stewardImplConfigGet({ keys: ['activeProvider', 'model'] }, {}, config);
  ok(usage.provenance === 'historical_usage' && settings.provenance === 'configuration_snapshot' && !usage.identityAuthority && !settings.identityAuthority, 'config and usage payloads declare their non-identity provenance');
})().catch(error => { console.error(error.stack || error); t.fail('uncaught identity fixture error'); }).finally(async () => {
  if (fake) await fake.close();
  if (anthropic) await anthropic.close();
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
