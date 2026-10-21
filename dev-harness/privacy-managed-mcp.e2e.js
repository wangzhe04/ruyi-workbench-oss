'use strict';
// Real generated main/child engines and loopback MCP/model bytes. No external account or provider.
const cp = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-managed-mcp-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyCore', 'PrivacyGateway', 'runSessionTurn', 'runSubAgentCore', 'createSession', 'readConfig', 'mutateConfig', 'ManagedMcp', 'killAllMcpClients', 'getBridgedClient', 'handleApi', 'recordSessionExecutionOwner', 'registerSessionExecutionChild', 'activeChildren', 'turnSettlers'], { withEval: true });
const vault = require('./lib/privacy-test-fixture').fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const t = createRunner('PRIVACY MANAGED MCP');
let model, server, step, eventStream, held, heldSubscription, cliHost;
const capture = path.join(root, 'stdio-rpc.ndjson');
const received = () => calls.concat(fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const calls = [], secret = 'managed-private@example.test', personal = 'managed-person@example.test';
async function resetClients(clearTraffic = true) {
  const children = app.__eval('[...mcpClients.values()].map(client => client.child).filter(Boolean)');
  app.killAllMcpClients();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) killOwnTree(child);
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  if (clearTraffic) { calls.length = 0; fs.writeFileSync(capture, ''); }
}
const catalog = [{ uri: 'fixture://one', name: secret, description: personal, mimeType: 'text/plain' }, { uri: 'fixture://binary', name: 'Binary refusal fixture', mimeType: 'text/plain' }];
function rpc(res, payload) { if (res.sseResponse) return res.sseResponse.write('event: message\ndata: ' + JSON.stringify(payload) + '\n\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); }
(async () => {
  app.__eval('networkAnchors = () => []; detectClaudePath = () => ""; detectKimiPath = () => ""; maybeWriteThreadBrief = async () => {};');
  server = http.createServer(async (req, res) => {
    if (req.url === '/sse') {
      eventStream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: endpoint\ndata: /messages\n\n');
      req.on('close', () => { if (eventStream === res) eventStream = null; }); return;
    }
    if (req.url === '/messages') { res.sseResponse = eventStream; res.writeHead(202); res.end(); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks)); calls.push(structuredClone(msg));
    if (msg.method === 'tools/call' && msg.params.arguments.hold && held) { held.accepted(); await held.release; }
    if (msg.method === 'resources/subscribe' && heldSubscription) { heldSubscription.accepted(); await heldSubscription.release; }
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } }, serverInfo: { name: 'synthetic-managed', version: '1' } };
    else if (msg.method === 'notifications/initialized') { if (!res.sseResponse) { res.writeHead(202); res.end(); } return; }
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Fixture ' + secret, inputSchema: { type: 'object', properties: { text: { type: 'string', description: secret } } } }] };
    else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: secret }], isError: false };
    else if (msg.method === 'resources/list') result = { resources: msg.params.cursor ? [] : catalog, ...(msg.params.cursor ? {} : { nextCursor: 'private-cursor-' + secret }) };
    else if (msg.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'fixture://{name}', name: secret }] };
    else if (msg.method === 'resources/read') result = { contents: [{ uri: msg.params.uri, mimeType: 'text/plain', text: secret, ...(msg.params.uri === 'fixture://binary' ? { _meta: { nested: { image: 'binary-disguised-as-text' } } } : {}) }] };
    else if (msg.method === 'resources/subscribe') {
      if (res.sseResponse) { res.sseResponse.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: msg.params.uri, forbiddenRawField: secret } }) + '\n\n'); return rpc(res, { jsonrpc: '2.0', id: msg.id, result: {} }); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: msg.params.uri, forbiddenRawField: secret } }) + '\n\n');
      return res.end('data: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n\n');
    } else if (msg.method === 'resources/unsubscribe') result = {};
    else return rpc(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: secret } });
    rpc(res, { jsonrpc: '2.0', id: msg.id, result });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  model = await startFakeProvider({ handler(ctx) {
    step.requests.push({ raw: ctx.raw, body: structuredClone(ctx.body) });
    const messages = ctx.messages.filter(item => item.role === 'tool');
    if (!messages.length) return toolCallFrames('mcp_resource', { serverId: 'fixture', operation: 'list' }, 'mcp-list');
    const latest = JSON.parse(messages.at(-1).content);
    if (latest.resources?.length) {
      step.resourceId = latest.resources[0].resourceId; step.cursor = latest.cursor;
      return toolCallFrames('mcp_resource', { serverId: 'fixture', operation: 'read', resourceId: step.resourceId }, 'mcp-read');
    }
    if (latest.contents) { step.readResult = latest; return toolCallFrames('mcp_resource', { serverId: 'fixture', operation: 'list', cursor: step.cursor }, 'mcp-page'); }
    if (!step.templatesRequested) { step.templatesRequested = true; return toolCallFrames('mcp_resource', { serverId: 'fixture', operation: 'templates' }, 'mcp-templates'); }
    if (!step.echoRequested) { step.echoRequested = true; return step.proxy
      ? toolCallFrames('tool_invoke_exec', { name: 'fixture__echo', arguments: { text: 'ordinary public input' } }, 'mcp-echo')
      : toolCallFrames('fixture__echo', { text: 'ordinary public input' }, 'mcp-echo'); }
    return textFrames('Synthetic managed resource complete.');
  } });
  for (const transport of ['http', 'sse', 'stdio']) for (const mode of ['off', 'basic', 'enhanced', 'strict']) for (const child of [false, true]) for (const proxy of [false, true]) {
    await app.mutateConfig(config => Object.assign(config, {
      privacyModeV1: mode, credentialEncryptionV1: true, privacyRulesV1: [], defaultWorkspace: root,
      activeProvider: 'model', providers: [{ id: 'model', type: 'openai-compat', apiStyle: 'chat', baseUrl: model.url, apiKey: secret, model: 'fixture' }],
      externalMcpServers: [transport === 'stdio'
        ? { id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, 'fake-mcp.js')], cwd: root, env: { FAKE_MCP_RESOURCE_CAPTURE: capture }, enabled: true }
        : { id: 'fixture', transport, url: 'http://127.0.0.1:' + server.address().port + (transport === 'sse' ? '/sse' : '/rpc'), enabled: true }],
      desktopMcp: { enabled: false, autodetect: false }, bridgeExternalToolsToProvider: true,
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, permissionMode: 'bypass', toolLoadingMode: proxy ? 'auto' : 'full',
      schedulerEnabledV1: false, stewardEnabledV1: false, importAgentInstructions: false, runtimeOptimizationShadowV1: false,
      contextAutoCompactEnabled: false, memoryAutoProposeEnabled: false, missionAutoContinue: false, openaiMaxToolIterations: 6,
    }));
    await resetClients(); const config = await app.readConfig(), session = await app.createSession({ cwd: root, title: 'MCP ' + mode + child });
    step = { requests: [], proxy, events: [] }; const start = received().length;
    if (child) await app.runSubAgentCore({ parentSession: session, provider: config.providers[0], config, task: 'Read the fixture resource.', agentKey: 'mcp-child', subagentId: 'mcp-child', toolTier: 'exec', maxIters: 6, depth: 1, onEvent(event) { step.events.push(event); }, ctrl: new AbortController() });
    else await app.runSessionTurn({ sessionId: session.id, message: 'Read the fixture resource.', cwd: root, onEvent(event) { step.events.push(event); } });
    for (let spin = 0; spin < 50 && !received().slice(start).some(item => item.method === 'resources/unsubscribe'); spin++) await new Promise(resolve => setTimeout(resolve, 10));
    if (!step.readResult) { console.error('DIAGNOSTIC', JSON.stringify({ transport, mode, child, proxy, methods: received().slice(start).map(x=>x.method) })); throw new Error('resource roundtrip missing'); }
    const label = transport + ' ' + mode + ' ' + (child ? 'child' : 'main') + (proxy ? ' proxy' : ' direct'), traffic = received().slice(start);
    t.ok(traffic.filter(item => item.method === 'tools/call').length === 1 && traffic.find(item => item.method === 'tools/call')?.params.arguments.text === 'ordinary public input', label + ': ordinary main/child direct/proxy bridge input reaches actual service unchanged once');
    t.ok(traffic.filter(item => item.method === 'resources/read').length === 1 && step.readResult?.contents?.length === 1, label + ': actual resource tool reaches MCP and next model POST once');
    t.ok(traffic.some(item => item.method === 'resources/list' && item.params.cursor === 'private-cursor-' + secret), label + ': opaque pagination handle resolves only in host');
    t.ok(step.readResult?.mcpNotifications?.events?.[0]?.resourceId === step.resourceId && !JSON.stringify(step.readResult).includes('forbiddenRawField'), label + ': advertised subscription update reaches shared tool-result seam without arbitrary fields');
    t.ok(traffic.some(item => item.method === 'resources/unsubscribe'), label + ': turn-end cleanup unsubscribes without a new turn or dialog');
    const modelBytes = step.requests.map(item => item.raw).join('\n');
    t.ok(mode === 'off' ? modelBytes.includes(secret) : !modelBytes.includes(secret), label + ': metadata, descriptions, resource text and notifications obey mode at actual model receiver');
    t.ok(['off', 'basic'].includes(mode) ? modelBytes.includes(personal) : !modelBytes.includes(personal), label + ': independent personal metadata follows basic/enhanced boundary');
    t.ok(traffic.some(item => item.method === 'resources/templates/list'), label + ': templates have a real model-tool production entry');
    t.ok(!app.ManagedMcp.active(), label + ': no turn capability survives completion');
  }
  for (const transport of ['http', 'sse', 'stdio']) {
    const gate = path.join(root, 'held-' + transport);
    await app.mutateConfig(config => Object.assign(config, { privacyModeV1: 'enhanced', externalMcpServers: [transport === 'stdio'
      ? { id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, 'fake-mcp.js')], cwd: root, env: { FAKE_MCP_RESOURCE_CAPTURE: capture, FAKE_MCP_RESOURCE_RELEASE: gate }, enabled: true }
      : { id: 'fixture', transport, url: 'http://127.0.0.1:' + server.address().port + (transport === 'sse' ? '/sse' : '/rpc'), enabled: true }] }));
    await resetClients(); const config = await app.readConfig(), client = await app.getBridgedClient('fixture', config);
    const count = received().filter(item => item.method === 'tools/call').length;
    let accepted, release;
    const acceptedPromise = new Promise(resolve => { accepted = resolve; });
    held = { accepted, release: new Promise(resolve => { release = resolve; }), done: () => { release(); fs.writeFileSync(gate, "release"); } };
    await app.PrivacyGateway.withPolicy('response-race-' + transport, () => app.ManagedMcp.runTurn({}, async () => {
      const pending = client.callTool('echo', { text: 'public held request', hold: true });
      if (transport === 'stdio') {
        for (let spin = 0; spin < 500 && !fs.existsSync(gate + '.ready'); spin++) await new Promise(resolve => setTimeout(resolve, 10));
        t.ok(fs.existsSync(gate + '.ready'), 'stdio actual peer accepted held operation');
      } else await Promise.race([acceptedPromise, pending.then(result => { throw new Error('held request ended before acceptance: ' + JSON.stringify({ code: result?.code, ok: result?.ok, resultUnavailable: result?.resultUnavailable })); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('held peer acceptance timeout: ' + transport)), 5000); timer.unref(); })]);
      await app.mutateConfig(current => { current.privacyModeV1 = 'off'; });
      if (transport === 'stdio') fs.writeFileSync(gate, 'release'); else release();
      const result = await pending;
      t.ok(result.operationMayHaveExecuted === true && result.resultUnavailable === true && !JSON.stringify(result).includes(secret), transport + ': changed-policy received result has a safe executed/withheld receipt');
      t.ok(received().filter(item => item.method === 'tools/call').length === count + 1, transport + ': result withholding never replays service operation');
    }));
    held = null;
  }
  for (const transport of ['http', 'sse', 'stdio']) for (const mutation of ['policy', 'configuration']) {
    const gate = path.join(root, 'subscribe-' + transport + '-' + mutation);
    await app.mutateConfig(config => Object.assign(config, { privacyModeV1: 'enhanced', externalMcpServers: [transport === 'stdio'
      ? { id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, 'fake-mcp.js')], cwd: root, env: { FAKE_MCP_RESOURCE_CAPTURE: capture, FAKE_MCP_SUBSCRIBE_RELEASE: gate }, enabled: true }
      : { id: 'fixture', transport, url: 'http://127.0.0.1:' + server.address().port + (transport === 'sse' ? '/sse' : '/rpc'), enabled: true }] }));
    await resetClients(); await app.readConfig();
    const start = received().length;
    let accepted, release;
    const acceptedPromise = new Promise(resolve => { accepted = resolve; });
    heldSubscription = { accepted, release: new Promise(resolve => { release = resolve; }), done: () => { release(); fs.writeFileSync(gate, "release"); } };
    await app.PrivacyGateway.withPolicy('subscribe-race-' + transport + mutation, () => app.ManagedMcp.runTurn({}, async () => {
      const listing = await app.ManagedMcp.resource({ serverId: 'fixture', operation: 'list' });
      const pending = app.ManagedMcp.resource({ serverId: 'fixture', operation: 'read', resourceId: listing.resources[0].resourceId });
      if (transport === 'stdio') {
        for (let spin = 0; spin < 500 && !fs.existsSync(gate + '.ready'); spin++) await new Promise(resolve => setTimeout(resolve, 10));
        t.ok(fs.existsSync(gate + '.ready'), 'stdio actual peer accepted held subscription');
      } else await Promise.race([acceptedPromise, pending.then(result => { throw new Error('held request ended before acceptance: ' + JSON.stringify({ code: result?.code, ok: result?.ok, resultUnavailable: result?.resultUnavailable })); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('held peer acceptance timeout: ' + transport)), 5000); timer.unref(); })]);
      await app.mutateConfig(current => { if (mutation === 'policy') current.privacyModeV1 = 'off'; else current.theme = current.theme === 'light' ? 'dark' : 'light'; });
      if (transport === 'stdio') fs.writeFileSync(gate, 'release'); else release();
      const result = await pending;
      t.ok(result.operationMayHaveExecuted === true && result.resultUnavailable === true, transport + ' ' + mutation + ': accepted subscription is retained as possible execution after held response');
    }));
    for (let spin = 0; spin < 100 && !received().slice(start).some(item => item.method === 'resources/unsubscribe'); spin++) await new Promise(resolve => setTimeout(resolve, 10));
    const cleanup = received().slice(start).filter(item => item.method === 'resources/unsubscribe');
    t.ok(cleanup.length === 1 && cleanup[0].params.uri === 'fixture://one', transport + ' ' + mutation + ': actual receiver gets exactly one fixed-old-URI teardown despite changed policy/settings');
    heldSubscription = null;
  }
  const refused = async work => { try { await work(); return false; } catch (error) { return String(error.code || error.message).includes('privacy.'); } };
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1: 'enhanced', externalMcpServers: [{ id: 'fixture', transport: 'sse', url: 'http://127.0.0.1:' + server.address().port + '/sse', enabled: true }] }));
  await resetClients(); await app.readConfig();
  for (const kind of ['resource', 'list']) for (const invalidation of ['list_changed', 'ttl']) {
    await app.PrivacyGateway.withPolicy('handle-race-' + kind + invalidation, () => app.ManagedMcp.runTurn({}, async () => {
      const listing = await app.ManagedMcp.resource({ serverId: 'fixture', operation: 'list' });
      const id = kind === 'resource' ? listing.resources[0].resourceId : listing.cursor;
      const args = kind === 'resource' ? { serverId: 'fixture', operation: 'read', resourceId: id } : { serverId: 'fixture', operation: 'list', cursor: id };
      const state = app.ManagedMcp.active(), start = received().length;
      const gate = app.__eval(`(() => { const original = readConfig; const gate = { count: 0 }; readConfig = async function() { if (++gate.count === 2) { gate.accepted(); await gate.release; } return original(); }; gate.restore = () => { readConfig = original; }; return gate; })()`);
      let accepted, release;
      const acceptedPromise = new Promise(resolve => { accepted = resolve; }); gate.accepted = accepted;
      gate.release = new Promise(resolve => { release = resolve; });
      try {
        const pending = app.ManagedMcp.resource(args);
        await Promise.race([acceptedPromise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("prepare acceptance timeout")), 5000); timer.unref(); })]);
        if (invalidation === 'list_changed') {
          eventStream.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' }) + '\n\n');
          for (let spin = 0; spin < 100 && state.handles.has(id); spin++) await new Promise(resolve => setTimeout(resolve, 5));
          t.ok(!state.handles.has(id), kind + ': actual SSE list_changed invalidates issued handle before first subscription');
        } else { state.handles.get(id).expires = Date.now() + 5; await new Promise(resolve => setTimeout(resolve, 10)); }
        release();
        t.ok(await refused(() => pending), kind + ' ' + invalidation + ': held prepare cannot revive removed or expired exact handle');
        t.ok(!received().slice(start).some(item => ['resources/read', 'resources/list'].includes(item.method)), kind + ' ' + invalidation + ': actual receiver gets zero stale URI/cursor requests');
      } finally { gate.restore(); release(); }
    }));
  }
  for (const [from, to] of [['off', 'enhanced'], ['enhanced', 'off']]) {
    await app.mutateConfig(config => { config.privacyModeV1 = from; });
    await resetClients(); const config = await app.readConfig(), client = await app.getBridgedClient('fixture', config), count = received().filter(item => item.method === 'tools/call').length;
    await app.PrivacyGateway.withPolicy('guard-race-' + from, () => app.ManagedMcp.runTurn({}, async () => {
      const prepared = await app.ManagedMcp.prepare(client, 'tools/call', { name: 'echo', arguments: { text: 'held public input' } });
      await app.mutateConfig(current => { current.privacyModeV1 = to; });
      const result = await client.callTool('echo', { text: 'held public input' }, 1000, prepared.options);
      t.ok(result.ok === false && !received().slice(count).some(item => item.method === 'tools/call' && item.params.arguments.text === 'held public input'), from + '→' + to + ': held request emits no original service bytes');
    }));
  }
  await app.mutateConfig(config => { config.privacyModeV1 = 'enhanced'; });
  await resetClients(); await app.readConfig();
  await app.PrivacyGateway.withPolicy('resource-negative-cases', () => app.ManagedMcp.runTurn({}, async () => {
    const listing = await app.ManagedMcp.resource({ serverId: 'fixture', operation: 'list' });
    t.ok(await refused(() => app.ManagedMcp.resource({ serverId: 'fixture', operation: 'read', resourceId: 'arbitrary-uri-is-not-a-capability', uri: 'file:///private' })), 'arbitrary URI and guessed handles grant no resource read');
    t.ok(await refused(() => app.ManagedMcp.resource({ serverId: 'fixture', operation: 'read', resourceId: listing.resources[1].resourceId })), 'nested binary/image metadata cannot masquerade as a text resource');
    const client = await app.getBridgedClient('fixture', await app.readConfig());
    const controller = new AbortController();
    const pending = await app.ManagedMcp.prepare(client, 'tools/call', { name: 'echo', arguments: { text: 'cancelled-before-send' } }, { signal: controller.signal });
    controller.abort();
    const cancelled = await client.callTool('echo', pending.params.arguments, 1000, pending.options);
    t.ok(cancelled.ok === false && cancelled.steerInterrupted === true && cancelled.operationMayHaveExecuted !== true && !received().some(item => item.method === 'tools/call' && item.params.arguments.text === 'cancelled-before-send'), 'cancelled prepared call is refused before actual service bytes');
    const alias = app.PrivacyGateway.active().scope.protectValue('custom-known-private-value', 'INTERNAL');
    const count = received().filter(item => item.method === 'tools/call').length;
    t.ok(await refused(() => app.ManagedMcp.prepare(client, 'tools/call', { name: 'echo', arguments: { text: alias } })), 'unknown external service receives no raw-reference restoration authority');
    t.ok(received().filter(item => item.method === 'tools/call').length === count, 'reference refusal occurs before service dispatch');
  }));
  await app.mutateConfig(config => { config.privacyModeV1 = 'off'; });
  await resetClients();
  await app.PrivacyGateway.withPolicy('native-offer-positive', () => app.ManagedMcp.runTurn({}, async () => {
    const config = await app.readConfig();
    for (const child of [false, true]) {
      const schemas = app.__eval('buildOpenAiTools')(config, null, { noAgentTools: child, toolTier: child ? 'exec' : undefined });
      t.ok(schemas.some(tool => tool.function?.name === 'mcp_resource'), (child ? 'child' : 'main') + ': real native schema builder advertises managed resources inside its turn');
    }
    const compact = await app.__eval('toolCall')('list_tools', { pack: 'integrations' }, { config });
    const searched = await app.__eval('toolCall')('tool_search', { query: 'mcp_resource' }, { config });
    t.ok(compact.groups?.integrations?.includes('mcp_resource') && searched.matches?.some(tool => tool.name === 'mcp_resource'), 'native auto discovery lists and searches the usable managed resource tool');
  }));
  // MCP8 authenticates this old global bridge through a live host-owned CLI.
  // A real synthetic wrapper owns the actual mcp grandchild and inherits WCW_*.
  // No verification hook is replaced or disabled in this fixture.
  cliHost = http.createServer((req, res) => {
    void app.handleApi(req, res, new URL(req.url, 'http://local').pathname).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}'); });
  });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CLI host listen timeout')), 5000); cliHost.once('error', error => { clearTimeout(timer); reject(error); }); cliHost.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); }); });
  const cliToken = 'd'.repeat(32), cliPort = cliHost.address().port;
  app.__eval('RUNTIME.token=' + JSON.stringify(cliToken) + ';RUNTIME.port=' + cliPort + ';RUNTIME.host="127.0.0.1";');
  const wrapper = path.join(root, 'owned-cli-wrapper.cjs');
  fs.writeFileSync(wrapper, `const cp=require('node:child_process');
    const child=cp.spawn(process.execPath,[process.env.WCW_FIXTURE_SERVER_JS,'mcp'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
    child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;process.stdin.pause();});`);
  for (const loading of ['full', 'auto']) {
    const cliSession = await app.createSession({ title: 'Synthetic CLI offer owner ' + loading, cwd: root });
    const child = cp.spawn(process.execPath, [wrapper], {
      env: { ...process.env, WCW_TOOL_LOADING_MODE: loading, WCW_FIXTURE_SERVER_JS: path.resolve(__dirname, '../ruyi-workbench/app/server.js'), WCW_SESSION_ID: cliSession.id, WCW_HOST: '127.0.0.1', WCW_PORT: String(cliPort), WCW_TOKEN: cliToken }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settle; const owner = { promise: new Promise(resolve => { settle = resolve; }), source: 'fixture-cli', driverRunId: 'managed-cli-' + loading, phase: 'starting', cancelRequested: false, cancel() { this.cancelRequested = true; } };
    app.recordSessionExecutionOwner(cliSession.id, owner);
    const reg = { child, pid: child.pid, kind: 'kimi-acp', state: 'running', exited: false, session: cliSession };
    app.registerSessionExecutionChild(cliSession.id, reg, owner);
    child.stdin.on('error', () => {});
    let buffer = '', seq = 0; const pending = new Map();
    child.stdout.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); let message; try { message = JSON.parse(line); } catch { continue; } pending.get(message.id)?.(message); } });
    child.stderr.resume();
    const call = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CLI RPC timeout: ' + method)); }, 5000); pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      const listing = await call('tools/list', {});
      t.ok(!listing.result.tools.some(tool => tool.name === 'mcp_resource') && listing.result.tools.some(tool => tool.name === 'mcp_list' || tool.name === 'list_tools'), loading + ': real CLI stdio offers no native-turn resource tool');
      for (const name of ['list_tools', 'tool_search']) {
        const reply = await call('tools/call', { name, arguments: { query: 'mcp_resource', limit: 100 } });
        const result = JSON.parse(reply.result.content[0].text);
        t.ok(!Object.values(result.groups || {}).flat().includes('mcp_resource') && !(result.matches || []).some(tool => tool.name === 'mcp_resource'), loading + ': CLI ' + name + ' has no unusable resource offer');
      }
      for (const proxy of [false, true]) {
        const reply = await call('tools/call', { name: proxy ? 'tool_invoke_read' : 'mcp_resource', arguments: proxy ? { name: 'mcp_resource', arguments: { serverId: 'fixture', operation: 'list' } } : { serverId: 'fixture', operation: 'list' } });
        const result = JSON.parse(reply.result.content[0].text);
        t.ok(result.ok === false && result.code === 'privacy.mcp_native_turn_required' && result.operationMayHaveExecuted === false, loading + ': CLI guessed resource ' + (proxy ? 'proxy' : 'direct') + ' gets typed pre-dispatch refusal');
      }
      app.activeChildren.delete(cliSession.id);
      const unauthenticated = await call('tools/list', {});
      t.ok(Boolean(unauthenticated.error), loading + ': unchanged inherited token/session environment cannot authorize RPC after real host CLI ownership is removed');
    } finally {
      if (app.activeChildren.get(cliSession.id) === reg) app.activeChildren.delete(cliSession.id);
      if (app.turnSettlers.get(cliSession.id) === owner) app.turnSettlers.delete(cliSession.id);
      settle();
      killOwnTree(child);
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }
})().catch(error => { console.error(error.stack); t.fail('uncaught managed MCP fixture error'); }).finally(async () => {
  held?.done?.(); heldSubscription?.done?.(); await resetClients(false); if (model) await model.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (cliHost) { cliHost.closeAllConnections(); await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CLI host close timeout')), 5000); cliHost.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); }); }); }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); t.done();
});
