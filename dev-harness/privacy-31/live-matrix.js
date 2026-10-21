'use strict';
// Explicit opt-in production gateway acceptance. Only synthetic data enters model bodies.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto'), cp = require('node:child_process');
const { createRunner } = require('../lib/harness');
const { killOwnTree } = require('../lib/kill-own-tree');
const t = createRunner('DEEPSEEK PRIVACY MATRIX');
const check = (condition, label) => { if (!t.ok(condition, label)) throw Error('assertion_failed'); };
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const prepareTool = (app, call, config, work, extra = {}) => app.PrivacyGateway.prepareExecution(call, { ...extra, config, workingDir: work, session: { id: 'live-matrix-disclosure', cwd: work } });
const safeError = error => /^privacy\.[a-z_]+$/.test(error.code || '') ? error.code : /^[a-z_]+$/.test(error.message || '') ? error.message : 'sanitized_failure';
async function readSourceConfig(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!parsed?.credentialRefsV1) return parsed;
  // Use the real binding/authentication checks without readConfig(), which could migrate or
  // repair the user's installation. This host refuses every persistence operation.
  const vm = require('node:vm'), { constBlock } = require('../lib/source-slice');
  const read = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
  const api = vm.runInNewContext(read('01h-privacy-core.js') + '\n' + read('01j-local-crypto.js') + '\n' + constBlock(read('01k-credential-vault.js'), 'CredentialVault') + '\n({PrivacyCore,LocalSecretCrypto,CredentialVault})', { require, Buffer, TextDecoder, URL, structuredClone, process, setTimeout, clearTimeout });
  const vaultFile = path.join(path.dirname(path.resolve(file)), 'credential-vault-v1.json');
  const stat = fs.lstatSync(vaultFile); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('configured_vault_refused');
  const vault = api.CredentialVault.create({ core: api.PrivacyCore, protector: api.LocalSecretCrypto, supportedDefault: () => process.platform === 'win32',
    size: async () => fs.statSync(vaultFile).size,
    store: { read: async () => JSON.parse(fs.readFileSync(vaultFile, 'utf8').replace(/^\uFEFF/, '')), write: async () => { throw Error('source_configuration_is_read_only'); }, invalidate() {} } });
  try { return (await vault.hydrateConfig(parsed)).raw; } finally { vault.clear(); }
}
async function main() {
  if (!process.argv.includes('--live')) throw Error('explicit_live_flag_required');
  if (option('restart')) {
    require('../lib/self-isolate-home');
    const root = path.resolve(option('restart'));
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-live-matrix-')) throw Error('restart_scope_refused');
    // This internal child mode must never fall back to the caller's real data root.
    process.env.RUYI_HOME = path.join(root, 'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
    delete process.env.RUYI_TEST_SERVER_JS;
    const app = require('../lib/server-internals').loadServerInternals(['readConfig', 'PrivacyGateway', 'providerRawCompletion']);
    const cfg = await app.readConfig(), saved = JSON.parse(fs.readFileSync(path.join(root, 'restart.json'), 'utf8'));
    const provider = cfg.providers.find(row => row.id === cfg.activeProvider);
    await app.PrivacyGateway.run('restart-acceptance', cfg, async () => {
      const body = await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: saved.email }] });
      check(body.messages.at(-1).content === saved.ref, 'fresh Node process decrypts the same stable scope reference');
      const result = await app.providerRawCompletion(provider, [{ role: 'user', content: 'Reply OK. Contact: ' + saved.ref }]);
      check(result.ok, 'fresh Node authenticates through the migrated credential and reuses persisted references');
      const restored = await prepareTool(app, { name: 'file_write', rawArgs: JSON.stringify({ path: 'restart.txt', content: saved.ref }) }, cfg, cfg.defaultWorkspace);
      check(!restored.privacyError && JSON.parse(restored.rawArgs).content === saved.email, 'fresh Node restores persisted reference exactly');
    });
    return;
  }
  const file = option('config') || [process.env.RUYI_HOME && path.join(process.env.RUYI_HOME, 'config.json'), path.join(os.homedir(), '.ruyi-workbench/config.json'), path.join(os.homedir(), '.win-claude-workbench/config.json')].filter(Boolean).find(value => fs.existsSync(value));
  if (!file) throw Error('configuration_not_found');
  const saved = await readSourceConfig(file);
  const selected = saved.providers?.find(row => row.id === saved.activeProvider && /deepseek/i.test(row.baseUrl + ' ' + row.model)) || saved.providers?.find(row => /deepseek/i.test(row.baseUrl + ' ' + row.model));
  if (!selected?.apiKey || !selected?.baseUrl || !selected?.model) throw Error('configured_deepseek_endpoint_unavailable');
  require('../lib/self-isolate-home');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-matrix-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  fs.mkdirSync(data); fs.mkdirSync(work); process.env.RUYI_HOME = data; process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
  delete process.env.RUYI_TEST_SERVER_JS;
  const sourceFile = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
  const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sourceServerSha256 = sha256(sourceFile), harnessSha256 = sha256(__filename);
  const app = require('../lib/server-internals').loadServerInternals(['runSessionTurn', 'runStewardTurn', 'createSession', 'loadSession', 'saveSession', 'readConfig', 'mutateConfig', 'PrivacyGateway', 'MCP_TOOLS', 'TOOL_HANDLERS', 'PROVIDER_SESSION_TOOL_SCHEMAS', 'providerWireProtocol', 'providerRawCompletion', 'runSubAgentCore', 'killAllMcpClients', 'mcpClients', 'mcpStartingClients', 'toolCall', 'stopSession', 'maybeWriteThreadBrief']);
  async function stopMcp() {
    for (const client of new Set([...app.mcpClients.values(), ...app.mcpStartingClients.values()])) {
      const child = client.child; if (!child) continue;
      if (child.exitCode === null && child.signalCode === null) {
        let timer;
        const closed = new Promise(resolve => child.once('close', resolve));
        killOwnTree(child);
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('mcp_cleanup_timeout')), 8000); })]).finally(() => clearTimeout(timer));
      }
      // The ownership-checked child has exited. Product cleanup can now release client state
      // without scheduling another PID-only termination after the PID could be recycled.
      client.pid = 0;
    }
    app.killAllMcpClients();
  }
  // Copy only the selected authentication/protocol. Never inherit extraBaseUrls: a failover must
  // remain behind the capture proxy, rather than reaching a real endpoint without its leak guard.
  const provider = { id: 'fixture-live', label: 'Synthetic DeepSeek acceptance', type: 'openai-compat', model: selected.model,
    apiStyle: selected.apiStyle, apiKey: selected.apiKey, extraHeaders: selected.extraHeaders, baseUrl: selected.baseUrl,
    anthropicAuth: selected.anthropicAuth, serverWebSearch: false, anthropicThinking: 'off', reasoning: false, vision: false, extraBaseUrls: [] };
  const wire = app.providerWireProtocol(provider), target = new URL(wire.completionUrl(provider.baseUrl));
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) throw Error('endpoint_transport_refused');
  const marker = crypto.randomBytes(6).toString('hex');
  const values = { email: 'matrix-' + marker + '@example.test', user: 'user-' + marker + '@example.test', phone: '13800138000', staff: 'STAFF-' + marker, literal: '本地项目机密-' + marker, field: 'CUSTOM-PATIENT-' + marker, key: 'sk-fixture-' + crypto.randomBytes(20).toString('hex') };
  const rules = [{ id: 'staff', kind: 'regex', value: 'STAFF-[a-f0-9]{12}', category: 'INTERNAL' }, { id: 'literal', kind: 'literal', value: values.literal, category: 'INTERNAL' }, { id: 'field', kind: 'field', value: '/patientCode', category: 'INTERNAL' }];
  let phase = 'setup', allowed = [], leak = false, requests = 0, upstreams = 0, injectRetry = false, retries = 0;
  const records = [], checks = [], catalogRules = [], leakLabels = new Set(), leakPaths = new Set(), turnTraces = [], restartChildren = new Set(), started = Date.now();
  let complete = false, failureCode = '', inputTokens = 0, outputTokens = 0, childInputTokens = 0, childOutputTokens = 0;
  const reportFile = path.resolve(option('report') || path.join(os.tmpdir(), 'ruyi-deepseek-privacy-matrix-report.json'));
  const sensitiveIn = raw => {
    const visited = new Set();
    const scan = (value, depth = 0, trail = '$') => {
      if (depth > 64) { leakLabels.add('scan_budget'); leakPaths.add(trail); return true; }
      if (typeof value === 'string') {
        const visible = value.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '[private-reference]');
        const hit = [...Object.entries(values), ['authentication', provider.apiKey]].find(([, secret]) => !allowed.includes(secret) && (secret.length >= 8 ? visible.includes(secret) : new RegExp('(?<![A-Za-z0-9])' + secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(visible)));
        if (hit) {
          // Emit structural locations only, never the matched value or request body.
          try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && scan(parsed, depth + 1, trail + '<json>')) return true; } catch {}
          leakLabels.add(hit[0]); leakPaths.add(trail); return true;
        }
        if (visited.has(value)) return false; visited.add(value);
        try { return scan(JSON.parse(value), depth + 1, trail + '<json>'); } catch { return false; }
      }
      if (value && typeof value === 'object') return Object.entries(value).some(([key, row], index) => {
        const segment = Array.isArray(value) ? '[' + index + ']' : /^(?:input|messages|output|content|arguments|text|function|tool_calls|name|role|type|result|stdout|stderr|non_ascii|samples|context|path)$/.test(key) ? '.' + key : '[entry' + index + ']';
        return scan(key, depth + 1, trail + '<key' + index + '>') || scan(row, depth + 1, trail + segment);
      });
      return false;
    };
    return scan(raw);
  };
  const proxy = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || requests >= 100 || Date.now() - started > 900000) throw Error('request_budget');
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 2 * 1024 * 1024) throw Error('body_limit'); }
      requests++; const body = JSON.parse(raw);
      if (sensitiveIn(raw)) { leak = true; throw Error('private_body_refused'); }
      records.push({ phase, stream: body.stream === true, references: (raw.match(/\[\[RUYI_PVT:/g) || []).length, bytes: Buffer.byteLength(raw), tools: (body.tools || []).length, expectedPlaintextObserved: allowed.length > 0 && allowed.every(value => raw.includes(value)) });
      if (injectRetry) { injectRetry = false; retries++; res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"synthetic transient failure"}}'); return; }
      upstreams++;
      const response = await fetch(target, { method: 'POST', redirect: 'error', headers: wire.requestHeaders(provider, { model: provider.model }), body: raw, signal: AbortSignal.timeout(60000) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      for await (const part of response.body) res.write(part); res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end('{}'); }
  });
  const policy = async (mode = 'enhanced', custom = rules, technical = false) => app.mutateConfig(current => { Object.assign(current, { privacyModeV1: mode, privacyRulesV1: custom, privacyTechnicalV1: technical }); return {}; });
  const runCase = async (label, fn) => { phase = label; const before = requests; await fn(); check(!leak, label + ': recursively decoded wire contains no forbidden originals'); checks.push({ label, requests: requests - before, passed: true }); };
  const auxiliary = async message => { const result = await app.providerRawCompletion((await app.readConfig()).providers[0], [{ role: 'user', content: message }]); const code = typeof result.error === 'string' && /^privacy\.[a-z_]+$/.test(result.error) ? ' (' + result.error + ')' : ''; check(result.ok, phase + ': real non-streaming completion succeeds' + code); return result; };
  const usage = event => {
    if (event.type === 'usage') { inputTokens += Number(event.usage?.input_tokens || 0); outputTokens += Number(event.usage?.output_tokens || 0); }
    if (event.type === 'subagent_usage') { childInputTokens += Number(event.inTok || 0); childOutputTokens += Number(event.outTok || 0); }
  };
  const turn = async (message, session, inspect = () => {}) => {
    session ||= await app.createSession({ cwd: work, title: 'Synthetic privacy matrix' });
    const events = []; let timedOut = false, unexpectedPermission = false;
    const timer = setTimeout(() => { timedOut = true; app.stopSession(session.id, 'matrix_timeout'); }, 90000);
    try {
      await app.runSessionTurn({ sessionId: session.id, message, onEvent: event => {
        events.push(event); usage(event); inspect(event);
        // This noninteractive fixture grants its single known read-only MCP operation locally.
        // An unexpected approval must fail and stop this owned turn instead of hanging for a user.
        if (event.type === 'permission_request') { unexpectedPermission = true; setTimeout(() => app.stopSession(session.id, 'matrix_unexpected_permission'), 0); }
      } });
    } finally { clearTimeout(timer); }
    const result = events.findLast(event => event.type === 'result');
    const knownResultCodes = new Set(['privacy.restore_denied', 'privacy.reference_unknown', 'privacy.reference_malformed', 'privacy.arguments_invalid', 'privacy.credential_context', 'privacy.file_read_view_unsupported', 'privacy.file_edit_miss', 'privacy.tool_view_not_supported', 'not_found', 'ambiguous', 'bad_args', 'invalid_args', 'not_utf8', 'not_roundtrip', 'syntax_error']);
    turnTraces.push({ phase, events: events.filter(event => ['tool_use', 'tool_result', 'result', 'error', 'permission_request'].includes(event.type)).map(event => {
      const payload = event.type === 'tool_result' ? event.content : event.type === 'tool_use' ? event.input : undefined;
      const raw = payload === undefined ? '' : JSON.stringify(payload);
      return { type: event.type, ...(event.type === 'permission_request' ? { name: Object.hasOwn(app.TOOL_HANDLERS, event.toolName) ? event.toolName : 'other', tier: ['read', 'edit', 'exec'].includes(event.tier) ? event.tier : 'other' } : {}), ...(typeof event.name === 'string' && /^[a-z_]{1,64}$/.test(event.name) ? { name: event.name } : {}), ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}), ...(typeof event.error === 'string' && /^privacy\.[a-z_]+$/.test(event.error) ? { errorCode: event.error } : {}), ...(payload === undefined ? {} : {
        payloadOk: typeof payload?.ok === 'boolean' ? payload.ok : undefined,
        payloadCode: typeof payload?.code === 'string' ? knownResultCodes.has(payload.code) ? payload.code : 'other' : undefined,
        payloadErrorCode: typeof payload?.error === 'string' ? payload.error.match(/privacy\.[a-z_]+|\bENOENT\b|\bEPERM\b|\bEACCES\b|\bETIMEDOUT\b/)?.[0] : undefined,
        reservedMarkers: (raw.match(/\[\[RUYI_PVT:/g) || []).length,
        malformedReservedMarkers: (raw.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '').match(/\[\[RUYI_PVT:/g) || []).length,
      }) };
    }) });
    if (result?.ok !== true) {
      const shape = [];
      const visit = (value, trail, depth = 0) => {
        if (depth > 12 || shape.length >= 100) return;
        if (typeof value === 'string') {
          const markers = (value.match(/\[\[RUYI_PVT:/g) || []).length;
          if (markers) shape.push({ path: trail, markers, malformed: (value.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '').match(/\[\[RUYI_PVT:/g) || []).length });
          try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') visit(parsed, trail + '<json>', depth + 1); } catch {}
        } else if (value && typeof value === 'object') Object.entries(value).forEach(([key, row], index) => visit(row, trail + (Array.isArray(value) ? '[' + index + ']' : /^(?:content|text|arguments|tool_calls|function|reasoning_content|reasoning|output|input)$/.test(key) ? '.' + key : '[entry' + index + ']'), depth + 1));
      };
      visit((await app.loadSession(session.id)).providerHistory, '$history');
      turnTraces.at(-1).privateMarkerShape = shape;
    }
    check(!timedOut && !unexpectedPermission, phase + ': bounded fixture turn needs no interactive permission');
    check(result?.ok === true && !result.aborted && !result.error && !events.some(event => event.type === 'error'), phase + ': production native turn emits a successful final result');
    return session;
  };
  const copy = 'All values are synthetic. Treat local privacy references as opaque: copy them exactly into the registered tool arguments requested by this task. Never decode, guess, shorten, or escape the marker itself. Prefer complete file_read unless a particular view is requested. Do only the requested operations, then reply DONE. ';
  const samePath = (value, expected) => typeof value === 'string' && path.resolve(work, value).toLowerCase() === path.resolve(work, expected).toLowerCase();
  const toolSucceeded = (events, name, predicate = () => true) => events.some(event => event.type === 'tool_use' && event.name === name && typeof event.id === 'string' && event.id.length > 0 && predicate(event.input || {}) && events.some(result => result.type === 'tool_result' && result.id === event.id && result.isError === false && result.content?.ok === true));
  try {
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    await runCase('default-off-no-encryption', async () => {
      const cfg = await app.readConfig(), body = { messages: [{ role: 'user', content: values.email }] }, result = { email: values.email };
      check(cfg.privacyModeV1 === 'off' && cfg.credentialEncryptionV1 === false, 'actual new installation defaults to no privacy translation and no credential encryption');
      check(await app.PrivacyGateway.beforeRequest(body) === body && await app.PrivacyGateway.toolResult(result) === result, 'disabled production boundary preserves the original input and output objects');
      check(!fs.existsSync(path.join(data, 'credential-vault-v1.json')) && !fs.existsSync(path.join(data, 'privacy-scopes')), 'default-off checks initialize no vault, DPAPI master or mappings');
    });
    const local = { ...provider, baseUrl: 'http://127.0.0.1:' + proxy.address().port };
    // Encryption here is an explicit fixture opt-in, separate from the new-install default above.
    await app.mutateConfig(current => { Object.assign(current, { credentialEncryptionV1: true, providers: [local], activeProvider: local.id, privacyModeV1: 'off', privacyRulesV1: [], defaultWorkspace: work, permissionMode: 'acceptEdits', toolLoadingMode: 'auto', bridgeExternalToolsToProvider: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, stewardThreadBriefV1: false, schedulerEnabledV1: false, allowCommandTools: false, allowDesktopTools: false, openaiMaxToolIterations: 8, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false }); return {}; });
    await runCase('off-identity', async () => {
      allowed = [values.email]; await auxiliary('Reply OK. Contact: ' + values.email); allowed = [];
      check(records.at(-1)?.expectedPlaintextObserved && !fs.existsSync(path.join(data, 'privacy-scopes')), 'off mode preserves the synthetic input and creates no reference maps');
    });
    await runCase('basic-credential', async () => {
      await policy('basic', []); allowed = [values.email]; await auxiliary('Reply OK. Contact: ' + values.email + ' apiKey="' + values.key + '"'); allowed = [];
      check(records.at(-1)?.expectedPlaintextObserved && records.at(-1)?.references > 0, 'basic conceals credentials while preserving its documented personal-data scope');
    });
    for (const mode of ['enhanced', 'strict']) await runCase(mode + '-builtin-custom-unicode', async () => {
      // Field rules use JSON Pointers: send structured JSON, rather than prose that merely
      // contains a JSON-looking fragment (which has no structural /patientCode pointer).
      await policy(mode); await auxiliary(JSON.stringify({ instruction: 'Reply OK.', email: values.email, phone: values.phone, apiKey: values.key, staff: values.staff, project: values.literal, patientCode: values.field }));
      const trial = await app.PrivacyGateway.preview(await app.readConfig(), JSON.stringify({ staff: values.staff, project: values.literal, patientCode: values.field }));
      check(rules.every(rule => trial.matches.some(match => match.ruleIds.includes(rule.id))), phase + ': literal, field and worker-regex rule IDs all match');
    });
    await runCase('technical-private-network-and-path', async () => { await policy('strict', rules, true); values.ip = '10.93.42.17'; values.path = 'C:\\Users\\SyntheticPrivate\\secret.txt'; await auxiliary('Reply OK. Host ' + values.ip + ' file ' + values.path); });
    await runCase('complete-forty-five-rule-catalog', async () => {
      const corpus = require('./synthetic-catalog-corpus').createCorpus(marker);
      await policy('strict', rules, true);
      for (const row of corpus) values['catalog-' + row.id] = row.secret;
      const sample = corpus.map(row => row.sample).join('\n---\n');
      const trial = await app.PrivacyGateway.preview(await app.readConfig(), sample);
      for (const row of corpus) check(trial.matches.some(match => match.ruleIds.includes(row.id)), row.id + ': actual gateway preview reports the catalog rule');
      await auxiliary('All following data are synthetic acceptance fixtures. Reply OK, without repeating any value.\n' + sample);
      catalogRules.push(...corpus.map(row => row.id));
      check(catalogRules.length === 45, 'all forty-five catalog rules cross the real endpoint only as protected references');
    });
    await runCase('natural-mixed-input-and-tool-return', async () => {
      const mixed = require('./synthetic-catalog-corpus').createMixedCorpus();
      const secrets = mixed.cases.flatMap(row => row.secrets || [row.secret]);
      check(secrets.length === 47 && secrets.every(secret => mixed.prose.includes(secret)), 'all 47 independent synthetic entities occur in the natural mixed paragraph');
      secrets.forEach((secret, index) => { values['mixed-' + index] = secret; });
      values.mixedContact = 'natural-' + marker + '@example.test';
      await policy('enhanced', [], true);
      fs.writeFileSync(path.join(work, 'mixed-natural.txt'), mixed.prose + '\nDedicated copy contact: ' + values.mixedContact);
      const events = [];
      await turn(copy + 'Read mixed-natural.txt. Write only its dedicated copy contact email into mixed-natural-copy.txt. Do not copy any other field. The following duplicate natural paragraph is also synthetic input for validation:\n' + mixed.prose, undefined, event => events.push(event));
      check(toolSucceeded(events, 'file_read', input => samePath(input.path, 'mixed-natural.txt')) && toolSucceeded(events, 'file_write', input => samePath(input.path, 'mixed-natural-copy.txt')), 'real model reads the full mixed file and writes the designated contact through registered tools');
      check(fs.readFileSync(path.join(work, 'mixed-natural-copy.txt'), 'utf8').trim() === values.mixedContact, 'real model copies the opaque email reference and the host restores its exact synthetic value');
    });
    await runCase('second-six-scenario-input-and-tool-return', async () => {
      const corpus = require('./second-scenario-corpus').createSecondCorpus();
      await policy('enhanced', [], false);
      corpus.cases.forEach((row, index) => { values['second-' + index] = row.secret; });
      values.secondContact = 'second-' + marker + '@example.test';
      const sample = [...corpus.cases.map(row => row.sample), ...corpus.negatives, ...corpus.technical].join('\n');
      const trial = await app.PrivacyGateway.preview(await app.readConfig(), sample), visible = trial.protectedSample.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
      check(corpus.cases.every(row => !visible.includes(row.secret)), 'all 36 second-scenario synthetic sensitive entities are concealed');
      check([...corpus.negatives, ...corpus.technical].every(value => trial.protectedSample.includes(value)), 'all 30 business/format negatives and 3 disabled technical identifiers stay exact');
      fs.writeFileSync(path.join(work, 'second-natural.txt'), sample + '\nDedicated copy contact: ' + values.secondContact);
      const events = [];
      await turn(copy + 'Read second-natural.txt. Write only its dedicated copy contact email into second-natural-copy.txt. Do not copy any other field. Synthetic duplicate input:\n' + sample, undefined, event => events.push(event));
      check(toolSucceeded(events, 'file_read', input => samePath(input.path, 'second-natural.txt')) && toolSucceeded(events, 'file_write', input => samePath(input.path, 'second-natural-copy.txt')), 'second corpus crosses the real model with actual read/write tools');
      check(fs.readFileSync(path.join(work, 'second-natural-copy.txt'), 'utf8').trim() === values.secondContact, 'second corpus tool alias restores exactly');
    });
    await runCase('third-six-scenario-input-and-tool-return', async () => {
      const corpus = require('./third-scenario-corpus').createThirdCorpus();
      await policy('enhanced', [], false);
      corpus.cases.forEach((row, index) => { values['third-' + index] = row.secret; });
      values.thirdContact = 'third-' + marker + '@example.test';
      const sample = [...corpus.cases.map(row => row.sample), ...corpus.negatives, ...corpus.technical].join('\n');
      const trial = await app.PrivacyGateway.preview(await app.readConfig(), sample), visible = trial.protectedSample.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
      check(corpus.cases.every(row => !visible.includes(row.secret)), 'all 27 third-scenario synthetic sensitive entities are concealed');
      check([...corpus.negatives, ...corpus.technical].every(value => trial.protectedSample.includes(value)), 'all 25 public/partly-redacted/encoding negatives and 1 disabled technical identifier stay exact');
      fs.writeFileSync(path.join(work, 'third-natural.txt'), sample + '\nDedicated copy contact: ' + values.thirdContact);
      const events = [];
      await turn(copy + 'Read third-natural.txt. Write only its dedicated copy contact email into third-natural-copy.txt. Do not copy any other field. Synthetic duplicate input:\n' + sample, undefined, event => events.push(event));
      check(toolSucceeded(events, 'file_read', input => samePath(input.path, 'third-natural.txt')) && toolSucceeded(events, 'file_write', input => samePath(input.path, 'third-natural-copy.txt')), 'third corpus crosses the real model with actual read/write tools');
      check(fs.readFileSync(path.join(work, 'third-natural-copy.txt'), 'utf8').trim() === values.thirdContact, 'third corpus tool alias restores exactly');
    });
    await runCase('steward-natural-language-rule-management', async () => {
      await policy('enhanced', [], false);
      await app.mutateConfig(current => { current.stewardEnabledV1 = true; current.stewardProviderId = local.id; current.stewardPollMs = 120000; return {}; });
      const message = '请直接设置隐私识别规则：以 RND- 开头、后跟四位数字的项目代号视为内部信息，规则id为company-rnd。你自主整理正则和合成正反例，使用隐私专用工具先试验再保存。不要识别普通订单号，不要改脱敏档位或其他设置。正例RND-1234，反例订单1234。不要只解释做法，请实际完成。';
      const result = await app.runStewardTurn({ trigger: 'user', message, onEvent: usage });
      const config = await app.readConfig();
      turnTraces.push({ phase, steward: { ok: result.ok === true, ruleSaved: config.privacyRulesV1.some(rule => rule.id === 'company-rnd'),
        errorCode: [result.error, result.code, result.message].filter(value => typeof value === 'string').join(' ').match(/privacy\.[a-z_]+/)?.[0]
          || [result.error, result.code, result.message].filter(value => typeof value === 'string').join(' ').match(/steward\.[a-z_]+|[a-z_]+_timeout/)?.[0] || (result.error ? 'other' : ''),
        resultKeys: Object.keys(result), actions: (result.actions || []).map(row => ({ kind: row.kind, tool: row.tool,
          resultKeys: Object.keys(row.result || {}), ok: row.result?.ok, saved: row.result?.saved, status: row.result?.status,
          code: typeof row.result?.code === 'string' && /^[a-z_.]+$/.test(row.result.code) ? row.result.code : undefined })) } });
      check(result.ok === true && config.privacyRulesV1.some(rule => rule.id === 'company-rnd'), 'real DeepSeek steward translates natural language into a persisted recognition rule');
      check(result.actions?.some(row => row.result?.saved === true && row.result?.status === 'applied'), 'real steward exposes the actual settlement receipt');
      const trial = await app.PrivacyGateway.preview(config, 'RND-5678\n订单5678');
      check(!trial.protectedSample.includes('RND-5678') && trial.protectedSample.includes('订单5678'), 'natural-language generated pattern generalizes to unseen values without masking order numbers');
      await app.mutateConfig(current => { current.stewardEnabledV1 = false; return {}; });
    });
    await policy();
    await runCase('tool-read-write-six-fields', async () => {
      fs.writeFileSync(path.join(work, 'contact.json'), JSON.stringify({ email: values.email, phone: values.phone, staff: values.staff, project: values.literal, patientCode: values.field, apiKey: values.key }));
      await turn(copy + 'Read contact.json. Write exactly the values email, phone, staff, project, patientCode in that order, one per line, into roundtrip.txt. Exclude apiKey.');
      check(fs.readFileSync(path.join(work, 'roundtrip.txt'), 'utf8').trim() === [values.email, values.phone, values.staff, values.literal, values.field].join('\n'), 'six-field tool result is concealed and five allowed values restore exactly');
    });
    await runCase('user-input-and-history', async () => {
      const session = await turn(copy + 'Write the following email alone into user.txt: ' + values.user);
      check(fs.readFileSync(path.join(work, 'user.txt'), 'utf8').trim() === values.user, 'user input reference restores to a real file');
      const events = [];
      await turn(copy + 'Use the same email from the previous request using exactly one file_write to history.txt. Write the email alone. Do not read files or verify the write; immediately reply DONE.', session, event => events.push(event));
      const historyCalls = events.filter(event => event.type === 'tool_use');
      // A read-back of the newly written destination cannot supply the value used in
      // the earlier write. Reject every source lookup before that write and any other
      // operation, while allowing this optional post-write verification.
      check(historyCalls[0]?.name === 'file_write' && samePath(historyCalls[0].input?.path, 'history.txt') &&
        historyCalls[0].input?.content?.trim() === values.user &&
        toolSucceeded(events, 'file_write', input => samePath(input.path, 'history.txt')) &&
        historyCalls.slice(1).every(event => event.name === 'file_read' && samePath(event.input?.path, 'history.txt')),
      'history replay writes the exact value first without any source lookup; optional reads only verify the new destination');
      check(fs.readFileSync(path.join(work, 'history.txt'), 'utf8').trim() === values.user, 'second turn reuses protected provider history');
    });
    await runCase('unavailable-history-reference-recovery', async () => {
      await policy();
      const session = await app.createSession({ cwd: work, title: 'Synthetic refused-reference recovery' });
      const invalid = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
      const cfg = await app.readConfig(); let valid;
      await app.PrivacyGateway.run(session.id, cfg, async () => {
        valid = (await app.PrivacyGateway.toolResult({ email: values.email })).email;
        const refused = await prepareTool(app, { name: 'file_write', rawArgs: JSON.stringify({ path: 'never-execute.txt', content: invalid }) }, cfg, work);
        check(refused.privacyError?.code === 'privacy.reference_unknown', 'synthetic unknown reference remains strictly refused before execution');
      });
      // Replay a previously refused host-owned batch, as a restarted session would load it.
      // The actual-engine deterministic regression separately proves how this history is produced.
      session.providerHistory = [
        { role: 'user', content: 'Synthetic contact for later authorized copying: ' + valid },
        { role: 'assistant', content: 'The synthetic negative call below was refused.', tool_calls: [{ id: 'synthetic-refused-history', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'never-execute.txt', content: invalid }) } }] },
        { role: 'tool', tool_call_id: 'synthetic-refused-history', content: JSON.stringify({ ok: false, code: 'privacy.reference_unknown', error: 'The negative call was not executed. Do not retry it.' }) },
      ];
      await app.saveSession(session);
      fs.rmSync(path.join(work, 'recovered-history.txt'), { force: true });
      check(!fs.existsSync(path.join(work, 'never-execute.txt')), 'refused destination is absent before the recovery turn');
      const events = [];
      await turn(copy + 'The earlier negative case is finished. Use the valid contact from the first historical user message, and write that email alone to recovered-history.txt using file_write, with no leading/trailing whitespace or final newline. Do not retry the refused call or use never-execute.txt.', session, event => events.push(event));
      const recoveryCalls = events.filter(event => event.type === 'tool_use');
      check(recoveryCalls[0]?.name === 'file_write' && samePath(recoveryCalls[0].input?.path, 'recovered-history.txt') &&
        recoveryCalls[0].input?.content === values.email &&
        recoveryCalls.slice(1).every(event => event.name === 'file_read' && samePath(event.input?.path, 'recovered-history.txt')),
      'recovery reuses the valid historical alias before any source lookup and never retries the refused operation');
      check(!recoveryCalls.some(event => samePath(event.input?.path, 'never-execute.txt')), 'recovery emits no tool call for the refused destination');
      check(toolSucceeded(events, 'file_write', input => samePath(input.path, 'recovered-history.txt')) && fs.readFileSync(path.join(work, 'recovered-history.txt'), 'utf8').trim() === values.email, 'real model continues the loaded session and executes its unchanged valid contact reference');
      check(!fs.existsSync(path.join(work, 'never-execute.txt')), 'the historical refused operation is never executed during recovery');
      check(JSON.stringify((await app.loadSession(session.id)).providerHistory).includes(invalid), 'canonical history retains the refused original arguments for auditing');
    });
    await runCase('json-exact-edit-escaped-bigint', async () => {
      const original = '{\n  "n": 900719925474099312345, "dup":1, "dup":2,\n  "email":"\\u006dat rix"\n}\n'.replace('\\u006dat rix', '\\u006d' + values.email.slice(1));
      fs.writeFileSync(path.join(work, 'exact.json'), original);
      const events = [];
      await turn(copy + 'Read exact.json, then call file_edit with oldText equal to its entire exact file content (keep spaces, escapes and duplicate keys), and newText equal to {"edited":true}. Do not use file_write.', undefined, event => events.push(event));
      turnTraces.at(-1).editContract = events.filter(event => event.type === 'tool_use' && event.name === 'file_edit').map(event => ({ originalChars: original.length, actualChars: typeof event.input?.oldText === 'string' ? event.input.oldText.length : null, exact: event.input?.oldText === original, withoutFinalNewline: event.input?.oldText === original.slice(0, -1), callIdPresent: typeof event.id === 'string' && event.id.length > 0, pairedSuccess: toolSucceeded(events, 'file_edit') }));
      check(!events.some(event => event.type === 'tool_use' && event.name === 'file_write') && toolSucceeded(events, 'file_edit', input => input.oldText === original || input.oldText === original.slice(0, -1)), 'exact source replacement succeeds through file_edit without file_write fallback (optional final newline)');
      check(fs.readFileSync(path.join(work, 'exact.json'), 'utf8').trim() === '{"edited":true}', 'file_edit matches exact escaped source and long integer spelling');
    });
    await runCase('source-views-search-profile-diff', async () => {
      const repo = path.join(work, 'diff-fixture'); fs.mkdirSync(repo);
      const git = argv => cp.execFileSync('git', argv, { cwd: repo, windowsHide: true, stdio: 'pipe', timeout: 15000 });
      git(['init', '-q']);
      fs.writeFileSync(path.join(repo, 'contact.json'), JSON.stringify({ email: values.email, patientCode: values.field, publicValue: 1 }) + '\n');
      git(['add', 'contact.json']); git(['-c', 'user.email=fixture@example.test', '-c', 'user.name=PrivacyFixture', 'commit', '-qm', 'synthetic baseline']);
      fs.writeFileSync(path.join(repo, 'contact.json'), JSON.stringify({ email: values.email, patientCode: values.field, publicValue: 2 }) + '\n');
      const events = [];
      await turn(copy + 'Perform each required operation with these explicit arguments: file_search {"pattern":"patientCode","glob":"contact.json","root":"."}; data_profile {"path":"contact.json"}; git_diff {"cwd":"diff-fixture"}; file_read {"path":"contact.json","lineOffset":1,"lineLimit":1}. Do not omit a required argument or substitute another view. From these protected results copy email and patientCode, one per line, into views.txt.', undefined, event => events.push(event));
      turnTraces.at(-1).viewContract = events.filter(event => event.type === 'tool_use').map(event => ({ name: event.name, inputKeys: Object.keys(event.input || {}), searchRootMatches: event.name === 'file_search' ? samePath(event.input?.root, '.') : undefined, readOffset: event.name === 'file_read' ? event.input?.lineOffset : undefined, readLimit: event.name === 'file_read' ? event.input?.lineLimit : undefined }));
      check(toolSucceeded(events, 'file_search', input => typeof input.glob === 'string' && input.glob.includes('contact.json') && samePath(input.root, '.')) && toolSucceeded(events, 'data_profile', input => samePath(input.path, 'contact.json')) && toolSucceeded(events, 'git_diff', input => samePath(input.cwd, 'diff-fixture')) && toolSucceeded(events, 'file_read', input => samePath(input.path, 'contact.json') && input.lineOffset === 1 && input.lineLimit === 1), 'real model successfully runs search, profile, Git diff and the requested formatted line read on their intended targets');
      check(fs.readFileSync(path.join(work, 'views.txt'), 'utf8').trim() === values.email + '\n' + values.field, 'source-derived opaque references restore exactly after the real model selects them');
    });
    await runCase('unadapted-command-pre-dispatch-refusal', async () => {
      const cfg = await app.readConfig(), target = path.join(work, 'command.txt');
      await app.PrivacyGateway.run('command-refusal', cfg, async () => {
        const ref = (await app.PrivacyGateway.toolResult({ email: values.email })).email;
        for (const [name, args] of [['powershell_run', { command: "[IO.File]::WriteAllText('command.txt','" + ref + "')" }], ['script_run', { language: 'node', code: 'console.log(' + JSON.stringify(ref) + ')' }]]) {
          const prepared = await prepareTool(app, { name, rawArgs: JSON.stringify(args) }, cfg, work);
          check(prepared.privacyError?.code === 'privacy.disclosure_not_supported' && !prepared.rawArgs.includes(values.email), name + ': registered arbitrary execution cannot receive restored originals');
        }
        check(!fs.existsSync(target), 'refused command preparation creates no command output file');
      });
    });
    await runCase('unadapted-http-zero-receiver', async () => {
      let hits = 0; const service = http.createServer((req, res) => { hits++; res.end('{}'); });
      try {
        await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
        const cfg = await app.readConfig();
        await app.PrivacyGateway.run('http-refusal', cfg, async () => {
          const refs = await app.PrivacyGateway.toolResult({ email: values.email, password: values.key });
          const url = 'http://127.0.0.1:' + service.address().port + '/contact?email=' + refs.email + '&token=' + refs.password;
          for (const name of ['web_fetch', 'http_request']) {
            const prepared = await prepareTool(app, { name, rawArgs: JSON.stringify({ url }) }, cfg, work);
            check(prepared.privacyError?.code === 'privacy.disclosure_not_supported' && !prepared.rawArgs.includes(values.key), name + ': unknown disclosure adapter cannot restore query originals');
            let code = ''; try { await app.toolCall(name, { url }, { config: cfg, workingDir: work }); } catch (error) { code = error.code; }
            check(code === 'privacy.disclosure_not_supported' && hits === 0, name + ': actual dispatch refuses before any receiver request');
          }
        });
      } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
    });
    await runCase('subagent-read-write', async () => {
      const cfg = await app.readConfig(), parent = await app.createSession({ cwd: work, title: 'Synthetic parent' });
      // A field rule requires its source JSON context. Re-read the original structured fixture
      // in the child scope, rather than claim to identify a label-free value copied into prose.
      const child = await app.runSubAgentCore({ parentSession: parent, provider: cfg.providers[0], config: cfg, task: copy + 'Read contact.json. Write exactly email, phone, staff, project, patientCode in that order, one per line, into child.txt. Exclude apiKey.', agentKey: 'fixture', toolTier: 'edit', maxIters: 5, model: provider.model, onEvent: usage, subagentId: 'live-child', depth: 1, ctrl: new AbortController(), permModeOverride: 'acceptEdits' });
      check(child.ok && fs.readFileSync(path.join(work, 'child.txt'), 'utf8').trim() === [values.email, values.phone, values.staff, values.literal, values.field].join('\n'), 'real production subagent conceals and restores structured source values independently');
    });
    await runCase('managed-mcp-text-and-unadapted-credential-refusal', async () => {
      const script = path.join(root, 'contact-mcp.cjs'), payload = path.join(root, 'mcp-contact.json'), called = path.join(root, 'mcp-called'), captured = path.join(root, 'mcp-arguments.json');
      fs.writeFileSync(payload, JSON.stringify({ email: values.email, staff: values.staff, password: values.key }));
      fs.writeFileSync(script, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'contact-fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'read_contact',description:'Read the synthetic contact fixture. Read only. Call with no arguments.',inputSchema:{type:'object',properties:{password:{type:'string',description:'Do not supply this optional field.'},email:{type:'string',description:'Do not supply this optional field.'}},additionalProperties:false}},{name:'echo_private',description:'Echo the supplied synthetic arguments. No external side effects.',inputSchema:{type:'object',properties:{password:{type:'string'},email:{type:'string'},details:{type:'object',properties:{copiedStaff:{type:'string'}},required:['copiedStaff']}},required:['password','email','details'],additionalProperties:false}}]};
else if(m.method==='tools/call'&&m.params?.name==='read_contact'){fs.writeFileSync(process.argv[3],'called');result={content:[{type:'text',text:fs.readFileSync(process.argv[2],'utf8')}]};}
else if(m.method==='tools/call'&&m.params?.name==='echo_private'){fs.writeFileSync(process.argv[4],JSON.stringify(m.params.arguments));result={content:[{type:'text',text:JSON.stringify(m.params.arguments)}]};}
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
      try {
        await app.mutateConfig(current => { current.externalMcpServers = [{ id: 'contact', label: 'Synthetic contact', enabled: true, command: process.execPath, args: [script, payload, called, captured], cwd: work }]; current.bridgedToolTiers = { read_contact: 'read', echo_private: 'read' }; current.bridgeExternalToolsToProvider = true; current.toolLoadingMode = 'full'; return {}; });
        let toolUsed = false;
        const session = await turn(copy + 'Call contact__read_contact with no arguments, then exactly one file_write. Its path MUST be mcp.txt and content MUST be the exact returned email, one newline, then the exact returned staff value. Copy their opaque references verbatim. No labels, quotes, Markdown, JSON wrapper, spaces or extra lines. Exclude password. Do not read any files. Reply DONE immediately after the successful write.', undefined, event => { if (event.type === 'tool_use' && event.name === 'contact__read_contact') toolUsed = true; });
        const output = fs.existsSync(path.join(work, 'mcp.txt')) ? fs.readFileSync(path.join(work, 'mcp.txt'), 'utf8').trim() : '';
        turnTraces.at(-1).mcpOutputShape = { exists: !!output, lines: output.split('\n').length, emailPresent: output.includes(values.email), staffPresent: output.includes(values.staff), references: (output.match(/\[\[RUYI_PVT:/g) || []).length, exact: output === values.email + '\n' + values.staff };
        check(toolUsed && fs.existsSync(called) && fs.readFileSync(path.join(work, 'mcp.txt'), 'utf8').trim() === values.email + '\n' + values.staff, 'real managed MCP child returns originals, real model sees references and local file execution restores them');
        const cfg = await app.readConfig();
        await app.PrivacyGateway.run(session.id, cfg, async () => {
          const refs = await app.PrivacyGateway.toolResult({ email: values.email, password: values.key, staff: values.staff });
          const prepared = await prepareTool(app, { name: 'contact__echo_private', rawArgs: JSON.stringify({ password: refs.password, email: refs.email, details: { copiedStaff: refs.staff } }) }, cfg, work, { bridge: { serverId: 'contact', toolName: 'echo_private' } });
          check(prepared.privacyError?.code === 'privacy.disclosure_not_supported' && !prepared.rawArgs.includes(values.key), 'registered managed MCP without a recipient adapter cannot receive restored credentials or nested values');
          check(!fs.existsSync(captured), 'refused MCP argument release never calls echo_private');
        });
      } finally {
        await stopMcp();
        await app.mutateConfig(current => { current.externalMcpServers = []; current.bridgedToolTiers = {}; current.bridgeExternalToolsToProvider = false; current.toolLoadingMode = 'auto'; return {}; });
      }
    });
    await runCase('transient-retry', async () => { const before = requests; injectRetry = true; await turn(copy + 'Reply DONE. Contact: ' + values.email); check(retries === 1 && !injectRetry && requests >= before + 2, 'production streaming turn retries a transient 503 through the same protected HTTP boundary'); });
    await runCase('restart-persisted-reference', async () => {
      const cfg = await app.readConfig(); let ref;
      await app.PrivacyGateway.run('restart-acceptance', cfg, async () => { ref = (await app.PrivacyGateway.toolResult({ email: values.email })).email; });
      fs.writeFileSync(path.join(root, 'restart.json'), JSON.stringify({ email: values.email, ref }));
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [__filename, '--live', '--restart=' + root], { env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        restartChildren.add(child);
        let output = ''; child.stdout.on('data', part => output += part); child.stderr.resume();
        let expired = false, killTimer;
        const timer = setTimeout(() => { expired = true; killOwnTree(child); killTimer = setTimeout(() => reject(Error('restart_cleanup_timeout')), 8000); }, 90000);
        child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
        child.once('close', code => { clearTimeout(timer); clearTimeout(killTimer); restartChildren.delete(child); !expired && code === 0 && output.includes('ALL PASS') ? resolve() : reject(Error(expired ? 'restart_timeout' : 'restart_failed')); });
      });
      check(true, 'fresh process DPAPI credential and mapping acceptance passes');
    });
    await runCase('fail-closed-negative-matrix', async () => {
      const count = requests, cfg = await app.readConfig(); let ref, secret;
      await app.PrivacyGateway.run('deny-one', cfg, async () => {
        const protectedValue = await app.PrivacyGateway.toolResult({ email: values.email, password: values.key }); ref = protectedValue.email; secret = protectedValue.password;
        let credentialContextDenied = false;
        try { await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: JSON.stringify({ password: ref }) }] }); }
        catch (error) { credentialContextDenied = error.code === 'privacy.credential_context'; }
        check(credentialContextDenied && requests === count, 'ordinary reference cannot be reused as a credential through a sensitive field');
        const credentialHistory = await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'tool', content: JSON.stringify({ password: secret }) }] });
        check(credentialHistory.messages.at(-1).content.includes(secret) && requests === count, 'genuine credential references retain their protected history representation');
        for (const [name, args] of [['powershell_run', { command: ref }], ['web_fetch', { url: 'https://example.test/?q=' + ref }], ['file_write', { path: 'safe-credential.txt', content: secret, unknownSlot: ref }]]) {
          const prepared = await prepareTool(app, { name, rawArgs: JSON.stringify(args) }, cfg, work);
          check(!!prepared.privacyError && !prepared.rawArgs.includes(values.key), name + ': unknown receiver or field cannot receive an execution original');
        }
        const local = await prepareTool(app, { name: 'file_write', rawArgs: JSON.stringify({ path: 'explicit-local-credential.txt', content: secret }) }, cfg, work);
        check(!local.privacyError && JSON.parse(local.rawArgs).content === values.key, 'audited local file content explicitly permits the credential original');
        for (const name of ['invented_private_tool', 'constructor', '__proto__']) check(!!(await prepareTool(app, { name, rawArgs: JSON.stringify({ secret }) }, cfg, work)).privacyError, name + ': unregistered tool cannot receive an execution secret');
        for (const name of ['file_search', 'docs_search', 'data_profile']) {
          const result = await app.toolCall(name, { root: work, path: 'contact.json', pattern: 'patientCode', query: 'patientCode', command: 'Write-Output unused' }, { config: cfg, workingDir: work });
          check(result.ok === true, name + ': source tool remains available under active privacy');
          const safe = await app.PrivacyGateway.toolResult(result);
          check(![values.email, values.field, values.key].some(value => JSON.stringify(safe).includes(value)), name + ': source-aware result contains no private originals');
        }
        const disabled = await app.toolCall('powershell_run', { command: 'Write-Output unused' }, { config: cfg, workingDir: work });
        check(disabled.ok === false && disabled.code !== 'privacy.tool_view_not_supported', 'ordinary command enablement policy still refuses execution when commands are disabled');
      });
      await app.PrivacyGateway.run('deny-two', cfg, async () => { check((await prepareTool(app, { name: 'file_write', rawArgs: JSON.stringify({ path: 'cross-scope.txt', content: ref }) }, cfg, work)).privacyError?.code === 'privacy.reference_unknown', 'cross-scope reference is refused'); });
      for (const sample of ['{"phone":13800138000}', '{"patientCode":true}', '{"patientCode":null}', '{"patientCode":{"finding":"positive"}}']) {
        await app.PrivacyGateway.run('strict-typed-negative', cfg, async () => {
          let code = ''; try { await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: sample }] }); } catch (error) { code = error.code; }
          check(/^privacy\.(?:typed|numeric)_sensitive$/.test(code) && requests === count, 'strict typed API still rejects incompatible sensitive data before any HTTP request');
        });
      }
      let regexDenied = false;
      try { await app.PrivacyGateway.preview({ ...cfg, privacyRulesV1: [{ id: 'slow', kind: 'regex', value: '(a+)+$', category: 'INTERNAL' }] }, 'a'.repeat(40000) + '!'); } catch (error) { regexDenied = error.code === 'privacy.regex_timeout'; }
      check(regexDenied, 'catastrophic custom regex worker terminates');
      app.PrivacyGateway.markUnavailable();
      // Do not readConfig here: a successful fresh read intentionally recovers transient health.
      const unavailable = await app.providerRawCompletion(cfg.providers[0], [{ role: 'user', content: 'Reply OK' }]);
      check(unavailable.ok === false && unavailable.error === 'privacy.policy_unavailable' && requests === count, 'invalid types, worker timeout and unavailable policy cause zero HTTP requests');
      app.PrivacyGateway.configure(cfg);
    });
    await runCase('typed-content-live-recovery', async () => {
      await policy('enhanced', rules, false);
      for (const sample of ['{"phone":13800138000}', '{"patientCode":null}']) {
        const before = requests;
        await auxiliary(sample);
        check(requests > before, 'real model receives a protected omission and completes instead of ending the request with a typed error');
      }
      const session = await app.createSession({ cwd: work, title: 'Synthetic completed write recovery' });
      const original = '{"apiKey":null,"phone":13800138000}', destination = path.join(work, 'typed-already-written.json');
      fs.writeFileSync(destination, original);
      session.providerHistory = [
        { role: 'user', content: 'A previous synthetic write finished. Its contents are not needed to answer the next message.' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'synthetic-completed-write', type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ path: 'typed-already-written.json', content: original }) } }] },
        { role: 'tool', tool_call_id: 'synthetic-completed-write', content: JSON.stringify({ ok: true, bytes: original.length }) },
      ];
      await app.saveSession(session); const before = requests, events = [];
      await turn('Reply DONE only. The earlier write is complete. Do not call any tools, repeat it or inspect its contents.', session, event => events.push(event));
      check(requests > before && !events.some(event => event.type === 'tool_use') && fs.readFileSync(destination, 'utf8') === original,
        'real model continues a typed-sensitive historical write without replaying its side effects');
      check(JSON.stringify((await app.loadSession(session.id)).providerHistory).includes('apiKey'), 'canonical typed write arguments remain available for the local audit');
    });
    await runCase('explicit-native-disclosure-contracts', async () => {
      const cfg = await app.readConfig();
      await app.PrivacyGateway.run('native-disclosure-contracts', cfg, async () => {
        const refs = await app.PrivacyGateway.toolResult({ email: values.email, password: values.key });
        const pathRef = app.PrivacyGateway.active().scope.protectValue(path.join(work, 'contact.json'), 'INTERNAL');
        const names = [...new Set([...Object.keys(app.TOOL_HANDLERS), ...app.MCP_TOOLS.map(tool => tool.name), ...app.PROVIDER_SESSION_TOOL_SCHEMAS.map(tool => tool.name)])].sort();
        for (const name of names) {
          const args = /^tool_invoke_/.test(name) ? { name: 'file_write', arguments: { path: 'explicit-proxy.txt', content: refs.password } } : { transportFixture: { [refs.email]: [refs.email, refs.password] } };
          const prepared = await prepareTool(app, { name, rawArgs: JSON.stringify(args) }, cfg, work);
          if (/^tool_invoke_/.test(name)) check(!prepared.privacyError && JSON.parse(prepared.rawArgs).arguments.content === values.key, name + ': proxy uses the explicit local target fields');
          else check(!!prepared.privacyError && !prepared.rawArgs.includes(values.key), name + ': registration cannot authorize arbitrary fields or nested keys');
        }
        for (const [name, args, slot, expected] of [
          ['file_read', { path: pathRef }, 'path', path.join(work, 'contact.json')],
          ['file_write', { path: 'explicit-content.txt', content: refs.password }, 'content', values.key],
          ['file_edit', { path: 'contact.json', oldText: refs.email, newText: refs.email }, 'oldText', values.email],
          ['docs_search', { root: work, query: refs.email }, 'query', values.email],
          ['codebase_symbol_search', { root: work, symbol: refs.email }, 'symbol', values.email],
        ]) {
          const prepared = await prepareTool(app, { name, rawArgs: JSON.stringify(args) }, cfg, work);
          check(!prepared.privacyError && JSON.parse(prepared.rawArgs)[slot] === expected, name + ': audited local field preserves the exact authorized value');
        }
        check(names.length === Object.keys(app.TOOL_HANDLERS).length && names.length >= 120, 'complete current registry is checked for explicit fields or refusal, without executing arbitrary side effects');
      });
    });
    await runCase('thread-brief-atomic-private-excerpts', async () => {
      await policy('enhanced', rules, false);
      const cfg = { ...await app.readConfig(), stewardThreadBriefV1: true };
      values.titleKey = 'sk-briefboundary-' + crypto.randomBytes(20).toString('hex');
      values.titleKeyFragment = values.titleKey.slice(0, 10);
      const identityPrefix = '11010119990101123', weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
      values.titleIdentity = identityPrefix + '10X98765432'[weights.reduce((sum, weight, index) => sum + weight * Number(identityPrefix[index]), 0) % 11];
      values.titleIdentityFragment = values.titleIdentity.slice(0, 10);
      const introduction = 'Synthetic privacy excerpt boundary acceptance. ';
      const message = introduction + 'A'.repeat(1189 - introduction.length) + ' ' + values.titleKey;
      const reply = 'B'.repeat(390) + values.titleIdentity;
      const inputPreview = await app.PrivacyGateway.preview(cfg, message), replyPreview = await app.PrivacyGateway.preview(cfg, reply);
      check(!inputPreview.protectedSample.includes(values.titleKeyFragment) && !replyPreview.protectedSample.includes(values.titleIdentityFragment), 'complete synthetic originals satisfy the detector contract before testing excerpt boundaries');
      const session = await app.createSession({ cwd: work });
      const before = requests;
      const brief = await app.maybeWriteThreadBrief({ sessionId: session.id, config: cfg, threadProvider: cfg.providers[0], message, replyText: reply, stage: 'settled' });
      check(!!brief?.title && requests > before, 'real title generation receives atomic references for input and reply values crossing their original excerpt budgets');
      const saved = await app.loadSession(session.id);
      check(saved.threadBrief?.title === brief.title, 'real auxiliary model result persists through the production thread-brief path');
    });
    await runCase('native-model-user-display-roundtrip', async () => {
      await policy('enhanced', rules, false);
      const cfg = await app.readConfig(), session = await app.createSession({ cwd: work });
      await app.PrivacyGateway.run(session.id, cfg, async () => {
        const result = await auxiliary('Echo the following email and phone exactly as received, once each, without explanation. Preserve any local privacy reference unchanged as instructed by the harness. Email: ' + values.email + '\nPhone: ' + values.phone);
        check(result.content.includes('[[RUYI_PVT:') && !result.content.includes(values.email) && !result.content.includes(values.phone), 'real model returns opaque aliases without learning either original');
        const shown = await app.PrivacyGateway.displayText(session.id, result.content);
        check(shown.includes(values.email) && shown.includes(values.phone) && !shown.includes('[[RUYI_PVT:'), 'host-only final display restores both real model references exactly');
        const events = [], stream = app.PrivacyGateway.createDisplayStream(session.id, event => events.push(event));
        for (const char of result.content) { await stream.write({ type: 'raw_line', data: char }); await stream.write({ type: 'assistant_delta', text: char }); }
        await stream.flush(); stream.close();
        check(events.filter(event => event.type === 'assistant_delta').map(event => event.text).join('') === shown, 'real model output also restores when every reference character arrives separately');
      });
    });
    await runCase('physical-encryption', async () => {
      const maps = fs.readdirSync(path.join(data, 'privacy-scopes')).map(name => fs.readFileSync(path.join(data, 'privacy-scopes', name), 'utf8'));
      check(maps.length > 0 && maps.every(raw => { const map = JSON.parse(raw); return map.version === 1 && map.envelope?.algorithm === 'A256GCM' && typeof map.envelope.ciphertext === 'string'; }), 'all persisted reference maps use authenticated ciphertext envelopes');
      const disk = maps.join('') + fs.readFileSync(path.join(data, 'credential-vault-v1.json'), 'utf8') + fs.readFileSync(path.join(data, 'config.json'), 'utf8');
      // Three-digit CVVs occur naturally in random ciphertext. Their protection is proved by
      // capture offsets and the decoded wire check, rather than a meaningless ciphertext substring test.
      check(![provider.apiKey, ...Object.values(values), '[[RUYI_PVT:'].filter(value => value.length >= 8).some(value => disk.includes(value)), 'credential vault, persisted rules and reference maps contain no private originals');
    });
    const expectedCases = ['default-off-no-encryption', 'off-identity', 'basic-credential', 'enhanced-builtin-custom-unicode', 'strict-builtin-custom-unicode', 'technical-private-network-and-path', 'complete-forty-five-rule-catalog', 'natural-mixed-input-and-tool-return', 'second-six-scenario-input-and-tool-return', 'third-six-scenario-input-and-tool-return', 'steward-natural-language-rule-management', 'tool-read-write-six-fields', 'user-input-and-history', 'unavailable-history-reference-recovery', 'json-exact-edit-escaped-bigint', 'source-views-search-profile-diff', 'unadapted-command-pre-dispatch-refusal', 'unadapted-http-zero-receiver', 'subagent-read-write', 'managed-mcp-text-and-unadapted-credential-refusal', 'transient-retry', 'restart-persisted-reference', 'fail-closed-negative-matrix', 'explicit-native-disclosure-contracts', 'thread-brief-atomic-private-excerpts', 'native-model-user-display-roundtrip', 'physical-encryption'];
    expectedCases.splice(expectedCases.indexOf('explicit-native-disclosure-contracts'), 0, 'typed-content-live-recovery');
    check(JSON.stringify(checks.map(row => row.label)) === JSON.stringify(expectedCases), 'all twenty-eight required cases executed successfully in order');
    complete = true;
  } catch (error) {
    failureCode = safeError(error); throw error;
  } finally {
    let cleanupSafe = true;
    for (const child of restartChildren) if (child.exitCode === null && child.signalCode === null) {
      try {
        let timer; const closed = new Promise(resolve => child.once('close', resolve)); killOwnTree(child);
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('restart_cleanup_timeout')), 8000); })]).finally(() => clearTimeout(timer));
      } catch { cleanupSafe = false; complete = false; failureCode ||= 'restart_cleanup_timeout'; t.fail('owned restart cleanup failed'); }
    }
    try { await stopMcp(); } catch (error) { complete = false; failureCode ||= safeError(error); t.fail('owned MCP cleanup failed'); }
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (sha256(sourceFile) !== sourceServerSha256 || sha256(__filename) !== harnessSha256) { complete = false; failureCode ||= 'candidate_changed'; t.fail('candidate app and live matrix entry point changed during validation'); }
    const report = { schema: 1, complete, passed: complete && !leak && t.failures === 0, failureCode: failureCode || undefined, model: provider.model, protocol: wire.id, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, requests, upstreams, injectedRetries: retries, mainStreamingInputTokens: inputTokens, mainStreamingOutputTokens: outputTokens, subagentInputTokens: childInputTokens, subagentOutputTokens: childOutputTokens, catalogRules, leak, leakLabels: [...leakLabels], leakPaths: [...leakPaths], turnTraces, failures: t.failures, checks, requestsByCase: records };
    report.sourceServerSha256 = sourceServerSha256;
    report.harnessSha256 = harnessSha256;
    if (!complete) report.forensicRoot = root;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log('REPORT ' + reportFile);
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-live-matrix-')) throw Error('cleanup_scope');
    if (cleanupSafe && complete) fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => t.fail('matrix failed: ' + safeError(error))).finally(() => t.done({ exit: true }));
