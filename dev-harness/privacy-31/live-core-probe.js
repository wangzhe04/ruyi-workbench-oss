'use strict';
// Explicit opt-in experiment: real configured model + pure privacy core + two fixture-only tools.
// NOT a production gateway test. Never writes real config, logs keys, starts the app, or executes model commands.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRunner } = require('../lib/harness');
const t = createRunner('PRIVACY CORE LIVE PROBE');
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'ruyi-workbench/app/src');
const load = name => fs.readFileSync(path.join(src, name), 'utf8');
const failure = code => { throw Object.assign(new Error(code), { safeCode: code }); };

async function main() {
  if (!process.argv.includes('--live')) failure('explicit_live_flag_required');
  const configArgument = process.argv.find(x => x.startsWith('--config='));
  const configFile = configArgument ? path.resolve(configArgument.slice(9)) : [
    process.env.RUYI_HOME && path.join(process.env.RUYI_HOME, 'config.json'),
    process.env.WIN_CLAUDE_WORKBENCH_HOME && path.join(process.env.WIN_CLAUDE_WORKBENCH_HOME, 'config.json'),
    path.join(os.homedir(), '.ruyi-workbench/config.json'), path.join(os.homedir(), '.win-claude-workbench/config.json'),
  ].filter(Boolean).find(file => fs.existsSync(file));
  if (!configFile) failure('config_not_found');
  // Read-only, explicit user authorization. No normalization/migration function is invoked.
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const provider = (config.providers || []).find(item => item.id === config.activeProvider);
  if (!provider || !provider.apiKey || !provider.baseUrl || !provider.model) failure('active_provider_not_supported');
  const context = vm.createContext({ require, Buffer, URL, AbortController, setTimeout, clearTimeout });
  vm.runInContext(load('01i-privacy-rules.js') + '\n' + load('01h-privacy-core.js') + '\n' + load('04h-provider-http.js') + '\n'
    + load('04i-provider-anthropic.js') + '\n' + load('04i-provider-wire.js')
    + '\nProviderWireHooks.makeId = () => "call_" + require("node:crypto").randomBytes(8).toString("hex");'
    + '\nProviderWireHooks.redact = () => "[redacted]";'
    // Fixture histories are constructed as complete pairs below; pairing repair is outside this experiment.
    + '\nProviderWireHooks.repairProviderHistoryToolArgs = () => 0;'
    + '\nProviderWireHooks.repairProviderHistoryPairing = () => 0;'
    + '\nthis.probe = { PrivacyCore, providerWireProtocol };', context);
  const { PrivacyCore: core, providerWireProtocol } = context.probe;
  const wire = providerWireProtocol(provider), model = provider.model;
  const endpoint = new URL(wire.completionUrl(provider.baseUrl));
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) failure('endpoint_transport_refused');
  const runId = crypto.randomBytes(6).toString('hex');
  const fixture = { email: 'fixture-' + runId + '@example.test', phone: '13800138000', apiKey: 'sk-fixture-' + crypto.randomBytes(20).toString('hex') };
  const privateValues = [...Object.values(fixture), provider.apiKey];
  const privacy = core.createScope({ scopeId: 'probe-' + runId, detector: core.createDetector({ personal: true, knownSecrets: [provider.apiKey] }) });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-probe-'));
  const file = path.join(folder, 'contact.json');
  fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
  const messages = [
    { role: 'system', content: 'This is a synthetic tool-compatibility test. Values like [[RUYI_PVT:TYPE:ID]] are opaque local references. Copy them exactly into the corresponding tool argument. Never try to decode them. Use only the supplied tools.' },
    { role: 'user', content: '先调用 read_contact 读取测试联系人，再用其中的邮箱调用 find_orders，最后只报告订单号。不要猜邮箱。' },
  ];
  const tools = [
    { type: 'function', function: { name: 'read_contact', description: '读取唯一的合成联系人记录。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
    { type: 'function', function: { name: 'find_orders', description: '用联系人邮箱或邮箱代号查询测试订单。', parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'], additionalProperties: false } } },
  ];
  let requests = 0, read = false, restored = false, final = false;
  let inputTokens = 0, outputTokens = 0;
  const started = Date.now();
  try {
    for (let turn = 0; turn < 4; turn++) {
      const body = wire.encodeMessages({ model, messages, stream: false, provider, hasTools: true });
      wire.applyTools(body, tools, { serverWebSearch: false });
      body[wire.outputTokensField] = 2048;
      const payload = JSON.stringify(body);
      if (privateValues.some(value => value && payload.includes(value))) failure('plaintext_in_request');
      const response = await fetch(endpoint, { method: 'POST', headers: wire.requestHeaders(provider, { model }), body: payload,
        redirect: 'error', signal: AbortSignal.timeout(90000) });
      requests++;
      if (!response.ok) { await response.body?.cancel(); failure('provider_http_' + response.status); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) failure('response_limit'); chunks.push(chunk); }
      const decoded = wire.decodeCompletion(JSON.parse(Buffer.concat(chunks).toString('utf8')), { requestModel: model });
      if (decoded.failed || decoded.failureText) failure('provider_completion_failed');
      inputTokens += Number(decoded.usage?.prompt_tokens || decoded.usage?.input_tokens || 0);
      outputTokens += Number(decoded.usage?.completion_tokens || decoded.usage?.output_tokens || 0);
      const calls = decoded.toolCalls || [];
      if (!calls.length) { final = restored && String(decoded.text).includes('ORDER-FIXTURE-42'); break; }
      if (calls.length !== 1) failure('expected_sequential_single_tool');
      messages.push({ role: 'assistant', content: decoded.text || null, ...wire.assistantHistoryFields(decoded),
        tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArgs } })) });
      const call = calls[0], args = JSON.parse(call.rawArgs);
      let result;
      if (call.name === 'read_contact' && !read && Object.keys(args).length === 0) {
        result = privacy.protectRaw(fs.readFileSync(file, 'utf8')).text;
        if (Object.values(fixture).some(value => result.includes(value))) failure('plaintext_in_tool_result');
        read = true;
      } else if (call.name === 'find_orders' && read && !restored && Object.keys(args).join(',') === 'email') {
        if (typeof args.email !== 'string' || !args.email.startsWith('[[RUYI_PVT:EMAIL:')) failure('model_did_not_use_reference');
        const email = privacy.restoreForTool(args.email, { scopeId: 'probe-' + runId, tool: 'find_orders', pointer: '/email',
          destination: 'local-fixture', purpose: 'user-order-lookup',
          authorize: request => request.tool === 'find_orders' && request.pointer === '/email' && request.category === 'EMAIL'
            && !request.embedded && request.destination === 'local-fixture' && request.purpose === 'user-order-lookup' });
        if (email !== fixture.email) failure('restored_value_mismatch');
        restored = true;
        result = privacy.protectRaw(JSON.stringify({ email, orderId: 'ORDER-FIXTURE-42' })).text;
      } else failure('unexpected_tool_or_arguments');
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    t.ok(read, 'real model requested fixture file read; result was tokenized before returning');
    t.ok(restored, 'real model reused email reference; local field policy restored exact fixture email');
    t.ok(final, 'real model reported the fixture order after the tool round trip');
    t.ok(requests >= 3 && requests <= 4, 'bounded request sequence used the configured endpoint');
    console.log(JSON.stringify({ boundary: 'pure-core experiment, production gateway NOT integrated', apiStyle: wire.id, model,
      requests, inputTokens, outputTokens, elapsedMs: Date.now() - started, pass: t.failures === 0 }));
  } finally {
    privacy.clear();
    if (path.dirname(folder) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('ruyi-privacy-probe-')) failure('cleanup_scope');
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => t.fail(error.safeCode || 'probe_failed_no_sensitive_details')).finally(() => t.done());
