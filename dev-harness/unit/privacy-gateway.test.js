const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway, clone } = require('../lib/privacy-test-fixture');
const config = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [{ id: 'x', apiKey: 'fixture-auth-key' }] };

test('model request recovery omits only incompatible content across three protocols without changing the local transcript', async t => {
  const { api } = await setup(t), source = '{"apiKey":null,"phone":13600005555}';
  const protocols = [
    { messages: [{ role: 'user', content: source }, { role: 'assistant', content: 'public', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'file_write', arguments: source } }] }, { role: 'tool', tool_call_id: 'call-a', content: source }] },
    { system: 'public', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: source }, { type: 'tool_use', id: 'call-a', name: 'file_write', input: { apiKey: null } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-a', content: source }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_text', text: source }] }, { type: 'reasoning', summary: [{ type: 'reasoning_text', text: source }] }, { type: 'function_call', call_id: 'call-a', name: 'file_write', arguments: source }, { type: 'function_call_output', call_id: 'call-a', output: source }] },
  ];
  await api.run('recovery-protocols', config, async () => {
    for (const body of protocols) {
      const local = JSON.stringify(body);
      await assert.rejects(api.beforeRequest(body), /privacy\.typed_sensitive/);
      const wire = await api.beforeModelRequest(body), encoded = JSON.stringify(wire);
      assert.equal(JSON.stringify(body), local); assert.ok(!encoded.includes('13600005555'));
      assert.match(encoded, /RUYI_LOCAL_DATA_WITHHELD/); assert.match(encoded, /do not repeat writes/);
      assert.match(encoded, /file_write/); assert.match(encoded, /call-a/);
      if (wire.messages?.[1]?.tool_calls) assert.deepEqual(JSON.parse(wire.messages[1].tool_calls[0].function.arguments), {});
      if (wire.input) assert.deepEqual(JSON.parse(wire.input.find(row => row.type === 'function_call').arguments), {});
    }
    const controls = { messages: [{ role: 'user', content: 'public' }], metadata: { apiKey: null } };
    await assert.rejects(api.beforeModelRequest(controls), /privacy\.typed_sensitive/, 'control data cannot be omitted');
    const system = { system: [{ type: 'text', text: source }], messages: [{ role: 'user', content: 'public' }] };
    await assert.rejects(api.beforeModelRequest(system), /privacy\.typed_sensitive/, 'system text cannot be omitted');
    const forged = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    await assert.rejects(api.beforeModelRequest({ messages: [{ role: 'user', content: forged }] }), /privacy\.reference_unknown/);
  });
});

test('model tool result recovery withholds incompatible data, persists protection and never mutates or repeats the operation', async t => {
  const { api } = await setup(t), result = { ok: true, password: null, content: 'synthetic-result@example.test' }, original = JSON.stringify(result);
  await api.run('recovery-result', config, async () => {
    await assert.rejects(api.toolResult(result), /privacy\.typed_sensitive/);
    const safe = await api.modelToolResult(result);
    assert.equal(safe.privacyFiltered, true); assert.equal(safe.operationMayHaveExecuted, true); assert.equal(safe.resultUnavailable, true);
    assert.equal(safe.code, 'privacy.tool_result_withheld'); assert.ok(!JSON.stringify(safe).includes(result.content));
    assert.equal(JSON.stringify(result), original);
    const next = await api.beforeModelRequest({ messages: [{ role: 'tool', tool_call_id: 'once', content: JSON.stringify(safe) }, { role: 'user', content: 'Continue without rerunning the previous command.' }] });
    assert.match(JSON.stringify(next), /privacy.tool_result_withheld/);
    api.markUnavailable(); await assert.rejects(api.modelToolResult(result), /privacy\./);
  });
});

test('resilient APIs retain the off identity path without invoking object getters or creating vault files', async t => {
  const { api, root } = await setup(t); api.configure({ ...config, privacyModeV1: 'off' });
  const body = {}; Object.defineProperty(body, 'messages', { get() { throw Error('off path inspected data'); } });
  assert.equal(await api.beforeModelRequest(body), body); assert.equal(await api.modelToolResult(body), body);
  assert.deepEqual(fs.readdirSync(root), []);
});
async function setup(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-privacy-gateway-')); t.after(() => { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-privacy-gateway-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); }); const f = fixture(), api = gateway(root, f); api.configure(config); return { root, f, api }; }

test('complete mixed tool return survives repeated next requests without learning formatting whitespace', async t => {
  const { api } = await setup(t), corpus = require('../privacy-31/synthetic-catalog-corpus').createMixedCorpus();
  const contact = 'synthetic-tool-contact@example.test', source = corpus.prose + '\nBrowser tool contact: ' + contact;
  await api.run('mixed-whitespace-regression', config, async () => {
    const first = await api.beforeRequest({ messages: [{ role: 'user', content: corpus.prose }] });
    const result = await api.toolResult({ ok: true, path: 'browser-mixed-source.txt', content: source, truncated: false });
    assert.ok(result.content.includes('普通计数 count=200'), 'ordinary formatting spaces stay visible');
    const history = { messages: [{ role: 'user', content: first.messages.at(-1).content },
      { role: 'tool', tool_call_id: 'synthetic-file-read', content: JSON.stringify(result) }] };
    for (let pass = 0; pass < 4; pass++) {
      const body = await api.beforeRequest(history), visible = JSON.stringify(body).replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
      for (const row of corpus.cases.filter(row => row.tier !== 'technical')) for (const secret of row.secrets || [row.secret]) assert.ok(!visible.includes(secret), row.id);
      assert.ok(visible.includes('count=200'));
    }
    const entries = api.active().scope.exportState().entries;
    assert.ok(entries.every(entry => /\S/.test(entry.value) && !['Bearer', 'Bearer ', '"', "'"].includes(entry.value)), 'no whitespace, scheme or quote mapping is learned');
    const email = [...result.content.matchAll(/\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]/g)].at(-1)[0];
    const prepared = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'copy.txt', content: email }) });
    assert.equal(prepared.privacyError, undefined); assert.equal(JSON.parse(prepared.rawArgs).content, contact);
  });
});

test('labels adjoining valid references retain their complete-source context across repeated requests', async t => {
  const { api } = await setup(t);
  await api.run('reference-label-context', config, async () => {
    const scope = api.active().scope, credential = scope.protectValue('SYNTHETIC-CONTEXT-CREDENTIAL', 'CREDENTIAL'), personal = scope.protectValue('合成上下文资料', 'INTERNAL');
    const samples = ['Authorization: ' + credential, 'Authorization: Bearer ' + credential, 'Proxy-Authorization: ApiKey ' + credential,
      'Cookie: ' + credential, 'Password=' + credential, 'Password="' + credential + '"', 'QiniuAK: "' + credential + '"',
      '姓名: ' + personal, '家庭住址: ' + personal, '诊断结果: ' + personal];
    for (let pass = 0; pass < 4; pass++) for (const content of samples) {
      const body = await api.beforeRequest({ messages: [{ role: 'user', content }] });
      assert.equal(body.messages.at(-1).content, content);
    }
    assert.equal(scope.size(), 2, 'formatting and public scheme text never become learned values');
    for (const content of ['Authorization: Bearer ' + credential + ' FRESH-AUTH-SECRET', 'Password="' + credential + ' FRESH-SQL-SECRET"']) {
      const body = await api.beforeRequest({ messages: [{ role: 'user', content }] });
      assert.ok(!JSON.stringify(body).includes('FRESH-'), 'a real raw suffix is still protected');
    }
    await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: 'Authorization: [[RUYI_PVT:CREDENTIAL:' + 'f'.repeat(32) + ']]' }] }), /reference_unknown/);
  });
});

test('reference-internal short credentials cannot upgrade surrounding personal labels', async t => {
  const { api } = await setup(t);
  await api.run('opaque-context-merge', config, async () => {
    const scope = api.active().scope, token = '[[RUYI_PVT:INTERNAL:' + '5910'.repeat(8) + ']]';
    scope.importState({ version: 1, scopeId: 'opaque-context-merge', entries: [{ token, value: '合成上下文资料', category: 'INTERNAL', expiresAt: Date.now() + 60000 }] });
    scope.protectValue('591', 'CREDENTIAL');
    for (const content of ['姓名: ' + token, JSON.stringify({ 姓名: token }), JSON.stringify({ nested: JSON.stringify({ 姓名: token }) })]) {
      const body = await api.beforeRequest({ messages: [{ role: 'user', content }] });
      assert.equal(body.messages.at(-1).content, content);
    }
    await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: 'password=' + token }] }), /credential_context/);
  });
});

test('explicit whitespace passwords fail closed without teaching every formatting space', async t => {
  const { api } = await setup(t);
  await api.run('explicit-whitespace', config, async () => {
    for (const value of [' ', '\t', '  ']) await assert.rejects(() => api.toolResult({ password: value }), /whitespace_sensitive/);
    assert.equal(api.active().scope.size(), 0);
    assert.equal((await api.beforeRequest({ messages: [{ role: 'user', content: 'ordinary public text' }] })).messages.at(-1).content, 'ordinary public text');
  });
});

test('escaped JSON values use decoded label evidence while preserving exact raw spelling and existing aliases', async t => {
  const { api } = await setup(t), scopeId = 'json-context-sources';
  await api.run(scopeId, config, async () => {
    const values = ['SYNTHETIC-AK-JSON-ONLY', 'SYNTHETIC-SK-JSON-ONLY', 'SYNTHETIC-SMTP-JSON-ONLY'];
    const source = JSON.stringify({ QiniuAK: values[0], body: 'QiniuSK: ' + values[1] + '\nSMTP_PASSWORD=' + values[2] + '\npublic_count=200' });
    const result = await api.toolResult({ content: source });
    for (const value of values) assert.ok(!result.content.includes(value));
    const restored = api.active().scope.restoreForTool(result.content, { scopeId, tool: 'synthetic_contract', pointer: '/content',
      destination: 'synthetic-local', purpose: 'test', authorize: () => true, allowCredentialEmbedding: true });
    assert.equal(restored, source, 'escape spelling is preserved exactly');
    for (const content of [result.content, JSON.stringify({ nested: result.content })]) {
      const body = await api.beforeRequest({ messages: [{ role: 'tool', tool_call_id: 'synthetic-context', content }] });
      for (const value of values) assert.ok(!JSON.stringify(body).includes(value));
    }
    await assert.rejects(() => api.beforeRequest({ messages: [{ content: '{"API密钥":true}' }] }), /typed_sensitive/);
    await assert.rejects(() => api.beforeRequest({ messages: [{ content: '{"API密钥":null}' }] }), /typed_sensitive/);
    await assert.rejects(() => api.beforeRequest({ messages: [{ content: '{"API密钥":591}' }] }), /numeric_sensitive/);
  });
});

test('JSON lexical guards preserve explicit crossing rules even when IDs imitate automatic rules', async t => {
  const { api } = await setup(t), source = '{"left":"alpha","right":"omega"}', crossing = 'alpha","right":"omega';
  for (const [index, kind] of ['literal', 'regex', 'known', 'learned'].entries()) {
    const policy = { ...config, privacyRulesV1: kind === 'literal' || kind === 'regex' ? [{ id: 'credential.integration-secret', kind, value: crossing, category: 'CREDENTIAL' }] : [],
      providers: [{ id: 'x', apiKey: kind === 'known' ? crossing : 'fixture-auth-key' }] };
    api.configure(policy);
    await api.run('json-crossing-' + index, policy, async () => {
      if (kind === 'learned') api.active().scope.protectValue(crossing, 'CREDENTIAL');
      await assert.rejects(() => api.beforeRequest({ messages: [{ content: source }] }), /json_sensitive_structure/);
      await assert.rejects(() => api.toolResult({ content: source }), /json_sensitive_structure/);
    });
  }
});

test('automatic PEM and XML secrets split across JSON fields still fail the original structural guard', async t => {
  const { api } = await setup(t);
  for (const [index, source] of [JSON.stringify({ begin: '-----BEGIN PRIVATE KEY-----', body: 'SYNTHETIC-PRIVATE-KEY-BODY', end: '-----END PRIVATE KEY-----' }),
    JSON.stringify({ begin: '<password>', body: 'SYNTHETIC-XML-SECRET', end: '</password>' })].entries()) {
    await api.run('split-auto-structure-' + index, config, async () => {
      await assert.rejects(() => api.beforeRequest({ messages: [{ content: source }] }), /json_sensitive_structure/);
      await assert.rejects(() => api.toolResult({ content: source }), /json_sensitive_structure/);
    });
  }
});

test('legacy whitespace maps remain usable without poisoning ordinary JSON or user display', async t => {
  const { api } = await setup(t), scopeId = 'legacy-space-context', token = '[[RUYI_PVT:CREDENTIAL:' + 'b'.repeat(32) + ']]';
  await api.run(scopeId, config, async () => {
    const scope = api.active().scope;
    scope.importState({ version: 1, scopeId, entries: [{ token, value: ' ', category: 'CREDENTIAL', expiresAt: Date.now() + 60000 }] });
    const source = '{ "count": 200, "ok": true }';
    assert.equal((await api.beforeRequest({ messages: [{ role: 'user', content: source }] })).messages.at(-1).content, source);
    assert.equal((await api.toolResult({ content: 'ordinary public text' })).content, 'ordinary public text');
    assert.equal((await api.beforeRequest({ messages: [{ role: 'assistant', content: 'legacy' + token }] })).messages.at(-1).content, 'legacy' + token);
    assert.equal(await api.displayText(scopeId, token), ' ');
    assert.equal(scope.restoreForTool(token, { scopeId, tool: 'synthetic_contract', pointer: '/value', destination: 'synthetic-local', purpose: 'test', authorize: () => true }), ' ');
    assert.equal(scope.exportState().entries.length, 1);
    await assert.rejects(() => api.toolResult({ password: ' ' }), /whitespace_sensitive/);
  });
});

test('field values stay protected in earlier copies, later unlabelled reads and restarted scopes without crossing scopes', async t => {
  const { root, f, api } = await setup(t), secret = 'CUSTOM-PATIENT-LEARNED-ONLY';
  const policy = { ...config, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] }; api.configure(policy);
  let token;
  await api.run('learned-session', policy, async () => {
    const result = await api.toolResult({ echo: secret, content: JSON.stringify({ patientCode: secret }) });
    token = JSON.parse(result.content).patientCode;
    assert.equal(result.echo, token, 'a field discovered late protects an earlier copy in the same result');
    assert.equal((await api.toolResult({ content: 'verified ' + secret })).content, 'verified ' + token);
    const request = await api.beforeRequest({ messages: [{ role: 'user', content: 'history ' + secret }] });
    assert.equal(request.messages.at(-1).content, 'history ' + token);
    const restored = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'copy.txt', content: token }) });
    assert.equal(restored.privacyError, undefined); assert.equal(JSON.parse(restored.rawArgs).content, secret);
  });
  await api.run('fresh-session', policy, async () => assert.equal((await api.toolResult({ content: secret })).content, secret));
  const restarted = gateway(root, { ...f, vault: f.restartVault() }); restarted.configure(policy);
  await restarted.run('learned-session', policy, async () => assert.equal((await restarted.toolResult({ content: secret })).content, token));
});

test('escaped credential aliases and previously exposed aliases retain credential restrictions across a restart', async t => {
  const { root, f, api } = await setup(t), decoded = 'learned"credential', source = JSON.stringify({ patientCode: decoded });
  const policy = { ...config, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] }; api.configure(policy);
  let alias;
  await api.run('escaped-learned', policy, async () => {
    alias = JSON.parse((await api.toolResult({ content: source })).content).patientCode;
    assert.equal(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: alias }) }).privacyError, undefined);
    await api.toolResult({ password: decoded });
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: alias }) }).privacyError, 'an old escaped alias must tighten even when this result contains only decoded credentials');
    const again = await api.toolResult({ content: JSON.stringify({ unrelated: decoded }) });
    assert.equal(JSON.parse(again.content).unrelated, alias);
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: JSON.parse(again.content).unrelated }) }).privacyError);
  });
  const restarted = gateway(root, { ...f, vault: f.restartVault() }); restarted.configure(policy);
  await restarted.run('escaped-learned', policy, async () => {
    assert.ok(restarted.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: alias }) }).privacyError);
    const again = await restarted.toolResult({ content: JSON.stringify({ unrelated: decoded }) });
    assert.equal(JSON.parse(again.content).unrelated, alias);
  });
});

test('learned credential overlap upgrades a stable longer reference and learned numbers fail closed', async t => {
  const { api } = await setup(t);
  await api.run('learned-classification', config, async () => {
    const scope = api.active().scope, longer = scope.protectValue('ABCDE', 'INTERNAL'); scope.protectValue('ABC', 'CREDENTIAL');
    assert.equal((await api.toolResult({ content: 'ABCDE' })).content, longer);
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: longer }) }).privacyError);
    scope.protectValue('foo"bar', 'CREDENTIAL');
    const encoded = await api.toolResult({ content: '{"other":"foo\\"bar"}' });
    const escaped = JSON.parse(encoded.content).other;
    assert.match(escaped, /^\[\[RUYI_PVT:CREDENTIAL:/);
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: escaped }) }).privacyError);
    scope.protectValue('12345', 'INTERNAL');
    await assert.rejects(() => api.toolResult({ value: 12345 }), /numeric_sensitive/);
    await assert.rejects(() => api.toolResult({ content: '{"value":12345}' }), /numeric_sensitive/);
    scope.protectValue('x', 'INTERNAL');
    await assert.rejects(() => api.beforeRequest({ model: 'x' }), /control_field_sensitive/);
  });
});

test('one learned scanning budget covers all leaves and stabilization passes rather than resetting per string', async t => {
  const { root, f } = await setup(t); let budgets = 0;
  const core = { ...f.PrivacyCore, createMatchBudget: () => { budgets++; return f.PrivacyCore.createMatchBudget(128); } };
  const api = gateway(root, { ...f, PrivacyCore: core }); api.configure(config);
  await api.run('shared-budget', config, async () => {
    api.active().scope.protectValue('KNOWN-LEARNED', 'INTERNAL');
    for (let i = 0; i < 12; i++) assert.equal((await api.toolResult('q'.repeat(24))), 'q'.repeat(24));
    const before = budgets;
    await assert.rejects(() => api.toolResult(Array(12).fill('q'.repeat(24))), /learned_scan_limit/);
    assert.equal(budgets, before + 1, 'a composite input receives one shared opaque budget');
    const beforeLearning = budgets, revision = api.active().scope.revision();
    const learned = await api.toolResult({ password: 'NEW-CRED-ABC' });
    assert.match(learned.password, /^\[\[RUYI_PVT:CREDENTIAL:/);
    assert.ok(api.active().scope.revision() > revision);
    assert.equal(budgets, beforeLearning + 1, 'learning and its stabilization pass share the same budget');
  });
});

test('mixed literal field and worker-regex rules handle real request booleans, nulls and embedded JSON literals', async t => {
  const { api } = await setup(t), values = { literal: '合成项目机密', field: 'CUSTOM-PATIENT-MIXED', regex: 'STAFF-123abc456def' };
  const policy = { ...config, privacyRulesV1: [
    { id: 'literal', kind: 'literal', value: values.literal, category: 'INTERNAL' },
    { id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' },
    { id: 'staff', kind: 'regex', value: 'STAFF-[a-f0-9]{12}', category: 'INTERNAL' },
  ] }; api.configure(policy);
  await api.run('mixed-real-protocol', policy, async () => {
    const body = { model: 'fixture-model', stream: true, store: false, metadata: { enabled: false, disabled: true, previous: null },
      messages: [{ role: 'user', content: 'All following values are synthetic. ' + values.literal + ' ' + values.regex },
        { role: 'user', content: JSON.stringify({ patientCode: values.field, enabled: true, disabled: false, absent: null, n: 123 }) }],
      tools: [{ type: 'function', function: { name: 'login', parameters: { type: 'object', properties: { password: { type: 'string' }, rows: false }, additionalProperties: false } } }] };
    const result = await api.beforeRequest(body);
    assert.equal(result.stream, true); assert.equal(result.store, false); assert.deepEqual(structuredClone(result.metadata), body.metadata);
    assert.deepEqual(structuredClone(result.tools), body.tools);
    for (const value of Object.values(values)) assert.equal(JSON.stringify(result).includes(value), false);
    const json = JSON.parse(result.messages.at(-1).content);
    assert.equal(json.enabled, true); assert.equal(json.disabled, false); assert.equal(json.absent, null); assert.equal(json.n, 123);
    const tool = await api.toolResult({ ok: true, result: null, content: JSON.stringify({ patientCode: values.field, visible: false }) });
    assert.equal(tool.ok, true); assert.equal(tool.result, null); assert.equal(JSON.parse(tool.content).visible, false);
    assert.equal(JSON.stringify(tool).includes(values.field), false);
  });
});
test('actual request bodies keep auth/control fields and pseudonymize nested structured tool results', async t => {
  const { root, f, api } = await setup(t);
  let token;
  await api.run('session-one', config, async () => {
    const body = await api.beforeRequest({ model: 'fixture-model', messages: [{ role: 'user', content: 'Write alice@example.test with key fixture-auth-key' }] });
    assert.equal(body.model, 'fixture-model'); assert.equal(body.messages[1].role, 'user');
    const serialized = JSON.stringify(body); assert.ok(!serialized.includes('alice@example.test')); assert.ok(!serialized.includes('fixture-auth-key'));
    const result = await api.toolResult({ rows: [{ email: 'alice@example.test', password: 'structured-secret-value' }] });
    token = result.rows[0].email; assert.ok(token.startsWith('[[RUYI_PVT:EMAIL:')); assert.ok(result.rows[0].password.startsWith('[[RUYI_PVT:CREDENTIAL:'));
    const again = await api.beforeRequest({ messages: [{ role: 'tool', content: JSON.stringify(result) }] });
    assert.ok(JSON.stringify(again).includes(token));
    const call = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'safe.txt', content: 'Contact ' + token }) });
    assert.equal(JSON.parse(call.rawArgs).content, 'Contact alice@example.test'); assert.equal(call.privacyError, undefined);
    const denied = api.prepareCall({ name: 'web_fetch', rawArgs: JSON.stringify({ url: 'https://example.test/?x=' + token }) }); assert.ok(denied.privacyError);
    const deniedKey = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'safe.txt', content: result.rows[0].password }) }); assert.ok(deniedKey.privacyError);
    assert.ok(api.prepareCall({ name: 'file_read', rawArgs: '{broken' }).privacyError);
  });
  const files = fs.readdirSync(path.join(root, 'privacy-scopes')); assert.equal(files.length, 1);
  const disk = fs.readFileSync(path.join(root, 'privacy-scopes', files[0]), 'utf8'); assert.ok(!disk.includes('alice@example.test')); assert.ok(!disk.includes(token));
  const restarted = gateway(root, { ...f, vault: f.restartVault() }); restarted.configure(config);
  await restarted.run('session-one', config, async () => { const protectedBody = await restarted.beforeRequest({ messages: [{ content: 'alice@example.test' }] }); assert.equal(protectedBody.messages.at(-1).content, token); });
});
test('scope separation, unknown refs, opaque content, media and changed policy fail before network calls', async t => {
  const { api } = await setup(t); let token;
  await api.run('one', config, async () => { token = (await api.toolResult({ email: 'alice@example.test' })).email; });
  await api.run('two', config, async () => {
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: token }) }).privacyError);
    for (const body of [{ messages: [{ content: token }] }, { messages: [{ content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] }] }, { thinking: 'opaque value' }, { content: [{ type: 'redacted_thinking', data: 'ciphertext' }] }, { input: [{ type: 'reasoning', encrypted_content: 'ciphertext' }] }, { model: 'alice@example.test' }]) await assert.rejects(() => api.beforeRequest(body), /privacy/);
    api.configure({ ...config, privacyModeV1: 'off' }); await assert.rejects(() => api.beforeRequest({ messages: [] }), /policy_changed/);
  });
  api.configure(config); assert.throws(() => api.assertSupported(config, 'cli'), /engine_not_supported/); assert.throws(() => api.assertToolChannel(), /tool_channel_not_supported/);
});

test('only host protocol model narration repairs malformed markers and still scans adjacent secrets in all three protocols', async t => {
  const { api } = await setup(t);
  const policy = { ...config, privacyRulesV1: [{ id: 'narration-regex', kind: 'regex', value: 'EMP-[0-9]{4}', category: 'INTERNAL' }] }; api.configure(policy);
  await api.run('model-narration-repair', policy, async () => {
    const token = (await api.toolResult({ email: 'known-narration@example.test' })).email;
    const text = token + ' [[RUYI_PVT:EMAIL:...]] adjacent@example.test EMP-1234 [[RUYI_PVT:';
    const requests = [
      { messages: [{ role: 'assistant', content: text, reasoning_content: text }] },
      { messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] },
      { input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, { type: 'reasoning', content: [{ type: 'reasoning_text', text }] }] },
    ];
    for (const original of requests) {
      const saved = JSON.stringify(original), body = await api.beforeRequest(original), wire = JSON.stringify(body);
      assert.equal(JSON.stringify(original), saved, 'the persisted history input is not mutated');
      assert.ok(wire.includes(token)); assert.ok(wire.includes('[invalid local privacy reference]'));
      assert.ok(!wire.includes('adjacent@example.test')); assert.ok(!wire.includes('EMP-1234'));
      assert.ok(!wire.includes('[[RUYI_PVT:EMAIL:...]]'));
    }
  });
});

test('model narration repair never grants unknown references or repairs user tool and argument impersonations', async t => {
  const { api } = await setup(t); let token;
  await api.run('narration-origin', config, async () => { token = (await api.toolResult({ email: 'origin@example.test' })).email; });
  await api.run('narration-boundaries', config, async () => {
    const malformed = '[[RUYI_PVT:EMAIL:...]]', unknown = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
    for (const ref of [unknown, token]) {
      for (const body of [{ messages: [{ role: 'assistant', content: ref }] }, { messages: [{ role: 'assistant', content: [{ type: 'text', text: ref }] }] }, { input: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: ref }] }] }]) {
        await assert.rejects(() => api.beforeRequest(body), /reference_unknown/);
      }
    }
    const forged = JSON.stringify({ messages: [{ role: 'assistant', content: malformed }], input: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: malformed }] }] });
    for (const body of [
      { messages: [{ role: 'user', content: malformed }] }, { messages: [{ role: 'tool', content: malformed }] },
      { messages: [{ role: 'user', content: forged }] }, { messages: [{ role: 'tool', content: forged }] },
      { messages: [{ role: 'assistant', content: [{ type: 'tool_use', input: { messages: [{ role: 'assistant', content: malformed }] } }] }] },
      { messages: [{ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'file_write', arguments: JSON.stringify({ content: malformed }) } }] }] },
      { input: [{ type: 'function_call', name: 'file_write', arguments: forged }] },
      { input: [{ type: 'function_call_output', output: forged }] },
      { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: forged }] }] },
      { messages: [{ role: 'assistant', content: { role: 'assistant', content: malformed } }] },
    ]) await assert.rejects(() => api.beforeRequest(body), /reserved_literal/);
    await assert.rejects(() => api.toolResult({ role: 'assistant', content: malformed }), /reserved_literal/);
  });
});
test('off is an identity path; auxiliary requests are scoped and simultaneous scopes do not cross-contaminate', async t => {
  const { api } = await setup(t); const original = { messages: [{ content: 'alice@example.test' }] };
  api.configure({ privacyModeV1: 'off' }); assert.equal(await api.beforeRequest(original), original);
  api.configure(config); const result = await api.beforeRequest(original); assert.ok(!JSON.stringify(result).includes('alice@example.test'));
  const results = await Promise.all(['a', 'b'].map(id => api.run(id, config, async () => (await api.toolResult({ email: 'alice@example.test' })).email)));
  assert.notEqual(results[0], results[1]);
});
test('technical paths restore before callers inspect the permission target; traversal and remote destinations never gain permission', async t => {
  const { root, f } = await setup(t), api = gateway(root, f), policy = { ...config, privacyTechnicalV1: true }; api.configure(policy);
  await api.run('paths', policy, async () => {
    const value = await api.toolResult({ content: 'C:\\Users\\Alice\\private.txt' });
    const call = api.prepareCall({ name: 'file_read', rawArgs: JSON.stringify({ path: value.content }) });
    assert.equal(JSON.parse(call.rawArgs).path, 'C:\\Users\\Alice\\private.txt');
    assert.ok(api.prepareCall({ name: 'powershell_run', rawArgs: JSON.stringify({ command: value.content }) }).privacyError);
  });
});

test('mapping persistence failure aborts before exposing any reference; reserved tool output cannot forge a reference', async t => {
  const { root, f } = await setup(t);
  const api = gateway(root, { ...f, vault: { ...f.vault, sealLocal: async () => { throw Error('fixture write failure'); } } }); api.configure(config);
  await api.run('failed-write', config, async () => {
    await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: 'private@example.test' }] }), /fixture write failure/);
  });
  const real = gateway(root, f); real.configure(config);
  await real.run('reserved', config, async () => {
    await assert.rejects(() => real.toolResult({ content: '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]' }), /reserved_literal/);
    await assert.rejects(() => real.beforeRequest({ messages: [], tools: [{ type: 'web_search' }] }), /server_tools_not_supported/);
  });
});

test('JSON supplied by a user is treated as data, with field rules applied without confusing protocol control fields', async t => {
  const { api } = await setup(t);
  await api.run('json-data', config, async () => {
    const result = await api.beforeRequest({ model: 'fixture-model', messages: [{ role: 'user', content: JSON.stringify({ name: 'json-user@example.test', password: 'json-private-password', id: 'id-user@example.test' }) }] });
    const contents = JSON.parse(result.messages.at(-1).content);
    assert.ok(contents.name.startsWith('[[RUYI_PVT:EMAIL:')); assert.ok(contents.password.startsWith('[[RUYI_PVT:CREDENTIAL:')); assert.ok(contents.id.startsWith('[[RUYI_PVT:EMAIL:'));
  });
});

test('file JSON keeps whitespace and integer precision so file_edit oldText can round-trip exactly', async t => {
  const { api } = await setup(t);
  await api.run('json-source', config, async () => {
    const original = '{\n  "order": 900719925474099312345,\n  "email": "format-user@example.test"\n}\n';
    const output = await api.toolResult({ content: original });
    const call = api.prepareCall({ name: 'file_edit', rawArgs: JSON.stringify({ path: 'data.json', oldText: output.content, newText: 'replacement' }) });
    assert.equal(call.privacyError, undefined); assert.equal(JSON.parse(call.rawArgs).oldText, original);
  });
});

test('escaped JSON source values restore byte-for-byte; sensitive numeric source fails without precision coercion', async t => {
  const { api } = await setup(t);
  await api.run('json-escapes', config, async () => {
    const original = '{"email":"\\u0061lice@example.test","path":"a\\/b"}';
    const output = await api.toolResult({ content: original });
    assert.equal(output.content.includes('alice@example.test'), false);
    const call = api.prepareCall({ name: 'file_edit', rawArgs: JSON.stringify({ path: 'data.json', oldText: output.content, newText: 'replacement' }) });
    assert.equal(call.privacyError, undefined); assert.equal(JSON.parse(call.rawArgs).oldText, original);
    await assert.rejects(() => api.toolResult({ content: '{"phone":13800138000}' }), /numeric_sensitive/);
  });
});

test('nested trusted history mixes validated references and new secrets without changing exact file edit spelling', async t => {
  const { api } = await setup(t);
  const policy = { ...config, privacyRulesV1: [
    { id: 'literal', kind: 'literal', value: 'SYNTHETIC-LITERAL', category: 'INTERNAL' },
    { id: 'field', kind: 'field', value: '/patientCode', category: 'INTERNAL' },
    { id: 'regex', kind: 'regex', value: 'STAFF-[0-9]{4}', category: 'INTERNAL' },
  ] }; api.configure(policy);
  await api.run('nested-exact-history', policy, async () => {
    const original = '{\n  "n": 900719925474099312345, "dup":1, "dup":2,\n  "email":"\\u006datrix-synthetic@example.test", "untouched":"a\\/b"\n}\n';
    const output = await api.toolResult({ ok: true, content: original });
    const alias = JSON.parse(output.content).email;
    assert.match(alias, /^\[\[RUYI_PVT:/);
    for (const fresh of ['another@example.test', 'SYNTHETIC-LITERAL', 'STAFF-1234']) {
      const oldText = output.content + ' ' + fresh;
      const args = '{ "path":"data.json", "oldText":' + JSON.stringify(oldText) + ', "newText":"replacement" }';
      const body = await api.beforeRequest({ input: [{ type: 'function_call_output', output: JSON.stringify({ content: output.content }) }, { type: 'function_call', name: 'file_edit', arguments: args }] });
      const protectedArgs = body.input[1].arguments;
      assert.ok(!protectedArgs.includes(fresh)); assert.ok(protectedArgs.includes(alias));
      // Lexical JSON outside actual edits stays untouched, including Unicode escapes,
      // duplicate keys, long integers and optional solidus escapes.
      assert.ok(protectedArgs.startsWith('{ "path":"data.json", "oldText":'));
      assert.ok(protectedArgs.includes('900719925474099312345')); assert.ok(protectedArgs.includes('a\\\\/b'));
      const restored = api.prepareCall({ name: 'file_edit', rawArgs: protectedArgs });
      assert.equal(restored.privacyError, undefined);
      assert.equal(JSON.parse(restored.rawArgs).oldText, original + ' ' + fresh);
    }
    const nested = JSON.stringify({ oldText: JSON.stringify({ ref: alias, patientCode: 'PATIENT-NESTED-ONLY' }), newText: 'replacement' });
    const body = await api.beforeRequest({ input: [{ type: 'function_call', name: 'file_edit', arguments: nested }] });
    const restored = api.prepareCall({ name: 'file_edit', rawArgs: body.input[0].arguments });
    assert.equal(restored.privacyError, undefined);
    assert.equal(JSON.parse(restored.rawArgs).oldText, '{"ref":"\\u006datrix-synthetic@example.test","patientCode":"PATIENT-NESTED-ONLY"}');
  });
});

test('nested validated references do not authorize raw tool forgeries, unknown references or new credentials', async t => {
  const { api } = await setup(t); let alias;
  await api.run('nested-reference-boundary', config, async () => {
    alias = (await api.toolResult({ email: 'old@example.test' })).email;
    const unknown = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
    for (const ref of [alias, unknown]) {
      await assert.rejects(() => api.toolResult({ content: JSON.stringify({ ref, email: 'new@example.test' }) }), /reserved_literal/);
    }
    await assert.rejects(() => api.beforeRequest({ input: [{ arguments: JSON.stringify({ oldText: unknown + ' new@example.test' }) }] }), /reference_unknown/);
    const encodedRef = JSON.stringify(alias).replace(/\[/g, '\\u005b');
    const source = '{ "oldText":' + encodedRef + ', "newText":' + JSON.stringify(JSON.stringify({ ref: alias, password: 'FRESH-NESTED-CREDENTIAL' })) + ' }';
    const body = await api.beforeRequest({ input: [{ arguments: source }] });
    assert.ok(body.input[0].arguments.includes('\\u005b'), 'unchanged encoded references preserve their lexical spelling');
    assert.ok(!body.input[0].arguments.includes('FRESH-NESTED-CREDENTIAL'));
    assert.ok(api.prepareCall({ name: 'file_edit', rawArgs: body.input[0].arguments }).privacyError, 'a mixed leaf never downgrades a newly classified credential');
  });
  await api.run('nested-other-scope', config, async () => {
    await assert.rejects(() => api.beforeRequest({ input: [{ arguments: JSON.stringify({ oldText: alias + ' fresh@example.test' }) }] }), /reference_unknown/);
  });
});

test('credential contexts refuse personal references without denying genuine or already tightened credential history', async t => {
  const { api } = await setup(t);
  await api.run('reference-credential-context', config, async () => {
    const email = (await api.toolResult({ email: 'email-context@example.test' })).email;
    const credential = (await api.toolResult({ password: 'CREDENTIAL-CONTEXT-SYNTHETIC' })).password;
    let sent = 0;
    const send = async content => { const result = await api.beforeRequest({ messages: [{ role: 'user', content }] }); sent++; return result; };
    await assert.rejects(() => send(JSON.stringify({ password: email })), /credential_context/);
    await assert.rejects(() => send(JSON.stringify({ nested: JSON.stringify({ password: email + ' fresh' }) })), /credential_context/);
    assert.equal(sent, 0, 'context misuse is refused before a caller can submit any request');
    assert.equal(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: email }) }).privacyError, undefined, 'a refused context does not revoke the original authorized email use');
    await send(JSON.stringify({ email }));
    await send(JSON.stringify({ password: credential }));
    await api.toolResult({ password: 'email-context@example.test' });
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: email }) }).privacyError);
    await send(JSON.stringify({ password: email }));
    assert.equal(sent, 3, 'classification comes from current scope metadata, not the old token prefix');
  });
});

test('short learned credentials inside opaque reference IDs do not cause random credential-context refusals', async t => {
  const { api } = await setup(t);
  await api.run('opaque-short-credential', config, async () => {
    const token = '[[RUYI_PVT:EMAIL:' + 'a'.repeat(32) + ']]';
    api.active().scope.importState({ version: 1, scopeId: 'opaque-short-credential', entries: [{ token, value: 'opaque@example.test', category: 'EMAIL', expiresAt: Date.now() + 60000 }] });
    api.active().scope.protectValue('a', 'CREDENTIAL');
    const result = await api.beforeRequest({ input: [{ content: JSON.stringify({ x: token }) }] });
    assert.equal(JSON.parse(result.input[0].content).x, token);
    assert.equal(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: token }) }).privacyError, undefined);
    await assert.rejects(() => api.beforeRequest({ input: [{ content: JSON.stringify({ password: token }) }] }), /credential_context/);
  });
});

test('worker regex is used by requests, tool returns and ephemeral previews, including escaped JSON and parallel work', async t => {
  const { api, root } = await setup(t);
  const policy = { ...config, privacyRulesV1: [{ id: 'employee', kind: 'regex', value: 'EMP-[0-9]{4}', flags: 'i', category: 'INTERNAL' }] };
  api.configure(policy);
  const trial = await api.preview(policy, '🙂 emp-1234');
  assert.ok(!trial.protectedSample.includes('emp-1234')); assert.equal(trial.matches[0].start, 3); assert.equal(trial.matches[0].ruleIds[0], 'employee');
  assert.equal(fs.existsSync(path.join(root, 'privacy-scopes')), false);
  const off = await api.preview({ ...policy, privacyModeV1: 'off' }, 'EMP-1234'); assert.equal(off.protectedSample, 'EMP-1234'); assert.equal(off.matches.length, 0);
  await api.run('regex', policy, async () => {
    const body = await api.beforeRequest({ messages: [{ role: 'user', content: 'EMP-1234' }] }); assert.ok(!JSON.stringify(body).includes('EMP-1234'));
    const outputs = await Promise.all(['EMP-1234', 'EMP-4321'].map(value => api.toolResult({ content: '{"staff":"' + value + '"}' })));
    for (let i = 0; i < outputs.length; i++) {
      const call = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: outputs[i].content }) });
      assert.equal(JSON.parse(call.rawArgs).content, '{"staff":"' + ['EMP-1234', 'EMP-4321'][i] + '"}');
    }
    const escaped = await api.toolResult({ content: '{"staff":"EMP-\\u0031234"}' }); assert.ok(!escaped.content.includes('EMP-'));
  });
});

test('matches spanning JSON syntax fail closed in preview, request and tool paths for regex and literals', async t => {
  const { api } = await setup(t);
  for (const kind of ['regex', 'literal']) {
    const policy = { ...config, privacyRulesV1: [{ id: 'context', kind, value: kind === 'regex' ? '"staffcode"\\s*:\\s*"[A-Z]{6}"' : '"staffcode":"ABCDEF"', category: 'INTERNAL' }] };
    api.configure(policy);
    const sample = '{"staffcode":"ABCDEF"}';
    await assert.rejects(() => api.preview(policy, sample), /json_sensitive_structure/);
    await api.run('cross-json-' + kind, policy, async () => {
      await assert.rejects(() => api.beforeRequest({ messages: [{ content: sample }] }), /json_sensitive_structure/);
      await assert.rejects(() => api.toolResult({ content: sample }), /json_sensitive_structure/);
    });
  }
});

test('a source-context match is not covered by an unrelated replacement in the same JSON value', async t => {
  const { api } = await setup(t);
  const policy = { ...config, privacyRulesV1: [{ id: 'context', kind: 'regex', value: '(?<=staffcode":")[A-Z]+|(?<=extra=)[A-Z]+', category: 'INTERNAL' }] };
  api.configure(policy);
  await assert.rejects(() => api.preview(policy, '{"staffcode":"ABCDEFextra=UVWXYZ"}'), /json_sensitive_structure/);
});

test('canonical JSON escapes never confuse decoded offsets with source offsets and round-trip exactly', async t => {
  const { api } = await setup(t);
  const policy = { ...config, privacyRulesV1: [{ id: 'escaped', kind: 'regex', value: String.raw`(?<=x":"\\{12})ABCDEF|(?<=^.{12})UVWXYZ`, category: 'CREDENTIAL' }] };
  api.configure(policy);
  const sample = JSON.stringify({ x: '\\'.repeat(6) + 'ABCDEFUVWXYZ' });
  const result = await api.preview(policy, sample);
  assert.ok(!result.protectedSample.includes('ABCDEF')); assert.ok(!result.protectedSample.includes('UVWXYZ'));
  assert.ok(result.protectedSample.includes('[[RUYI_PVT:CREDENTIAL:'));
  await api.run('escaped-canonical', policy, async () => {
    const output = await api.toolResult({ content: sample });
    assert.ok(api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: output.content }) }).privacyError);
  });
});

test('explicit field rules reject unsupported typed values in JSON sources and real structures', async t => {
  const { api } = await setup(t);
  const policy = { ...config, privacyRulesV1: [
    { id: 'patient', kind: 'field', value: '/patient', category: 'INTERNAL' },
    { id: 'metadata-patient', kind: 'field', value: '/metadata/patient', category: 'INTERNAL' },
    { id: 'employee', kind: 'regex', value: 'EMP-[0-9]+', category: 'INTERNAL' },
  ] };
  api.configure(policy);
  const samples = [true, false, null, [], {}, ['positive'], { result: 'positive' }];
  for (const [index, patient] of samples.entries()) {
    const source = JSON.stringify({ patient });
    await assert.rejects(() => api.preview(policy, source), /typed_sensitive/);
    await api.run('typed-field-' + index, policy, async () => {
      await assert.rejects(() => api.toolResult({ patient }), /typed_sensitive/);
      await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: source }] }), /typed_sensitive/);
      await assert.rejects(() => api.beforeRequest({ metadata: { patient } }), /typed_sensitive/);
    });
  }
  await assert.rejects(() => api.preview(policy, '{"patient":123}'), /numeric_sensitive/);
});

test('credential fields reject unsupported typed values without classifying ordinary protocol objects', async t => {
  const { api } = await setup(t);
  for (const [index, apiKey] of [true, false, null, [], {}, ['private'], { value: 'private' }].entries()) {
    await assert.rejects(() => api.preview(config, JSON.stringify({ apiKey })), /typed_sensitive/);
    await api.run('typed-credential-' + index, config, async () => {
      await assert.rejects(() => api.toolResult({ apiKey }), /typed_sensitive/);
    });
  }
  const ordinary = { model: 'fixture-model', stream: true, messages: [{ role: 'user', content: 'hello' }], metadata: { id: null, name: { first: 'public' }, enabled: true, rows: [] } };
  await api.run('ordinary-typed-values', config, async () => {
    const result = await api.beforeRequest(ordinary);
    assert.deepEqual(structuredClone(result.metadata), ordinary.metadata);
    assert.equal(result.stream, true); assert.equal(result.model, ordinary.model);
    assert.deepEqual(structuredClone(await api.toolResult({ id: null, name: { first: 'public' }, enabled: true })), { id: null, name: { first: 'public' }, enabled: true });
  });
});

test('enhanced builtin personal fields reject unsupported typed data while basic preserves its narrower scope', async t => {
  const { api } = await setup(t);
  for (const field of ['diagnosis', 'phone', 'email', 'bankAccount', 'medicalRecord', 'fullName']) {
    for (const value of [true, false, null, [], { finding: 'positive' }]) {
      await api.run('personal-typed-' + field, config, async () => {
        await assert.rejects(() => api.toolResult({ [field]: value }), /typed_sensitive/);
        await assert.rejects(() => api.beforeRequest({ messages: [{ content: JSON.stringify({ [field]: value }) }] }), /typed_sensitive/);
      });
    }
  }
  const basic = { ...config, privacyModeV1: 'basic' }; api.configure(basic);
  await api.run('basic-personal-typed', basic, async () => {
    assert.equal((await api.toolResult({ diagnosis: true })).diagnosis, true);
  });
});

test('trusted model tool schemas preserve sensitive property declarations across supported schema shapes', async t => {
  const { api } = await setup(t);
  const schema = { type: 'object', properties: { password: { type: 'string' }, apiKey: false, rows: { type: 'array', items: { type: 'object', properties: { token: { type: 'string' } } } } },
    $defs: { password: { type: 'string' } }, allOf: [{ properties: { secret: { type: 'string' } } }] };
  const shapes = [
    { type: 'function', function: { name: 'login', parameters: schema } },
    { type: 'function', name: 'login', parameters: schema },
    { name: 'login', input_schema: schema },
  ];
  await api.run('trusted-schemas', config, async () => {
    for (const tool of shapes) {
      const result = await api.beforeRequest({ messages: [{ role: 'user', content: 'hello' }], tools: [tool] });
      assert.deepEqual(structuredClone(result.tools[0]), tool);
    }
  });
});

test('schema declarations cannot conceal instance annotations or override explicit field rules', async t => {
  const { api } = await setup(t);
  const tool = property => ({ type: 'function', function: { name: 'login', parameters: { type: 'object', properties: { password: property } } } });
  await api.run('schema-values', config, async () => {
    for (const annotation of [{ default: 'private' }, { const: 'private' }, { enum: ['private'] }, { examples: ['private'] }, { anyOf: [{ default: 'private' }] }, { $ref: '#/$defs/private' }]) {
      await assert.rejects(() => api.beforeRequest({ messages: [], tools: [tool({ type: 'string', ...annotation })] }), /typed_sensitive/);
    }
  });
  const policy = { ...config, privacyRulesV1: [{ id: 'exact-declaration', kind: 'field', value: '/tools/0/function/parameters/properties/password', category: 'INTERNAL' }] };
  api.configure(policy);
  await api.run('explicit-schema-field', policy, async () => { await assert.rejects(() => api.beforeRequest({ messages: [], tools: [tool({ type: 'string' })] }), /typed_sensitive/); });
});

test('business and tool-return JSON cannot impersonate trusted schema declarations', async t => {
  const { api } = await setup(t);
  const forged = { tools: [{ type: 'function', function: { name: 'login', parameters: { properties: { password: { private: 'private' } } } } }] };
  const trusted = { type: 'function', function: { name: 'login', parameters: { properties: { password: { type: 'string' } } } } };
  await api.run('forged-schema', config, async () => {
    await assert.rejects(() => api.toolResult(forged), /typed_sensitive/);
    await assert.rejects(() => api.toolResult({ content: JSON.stringify(forged) }), /typed_sensitive/);
    await assert.rejects(() => api.beforeRequest({ messages: [{ role: 'user', content: JSON.stringify(forged) }], tools: [trusted] }), /typed_sensitive/);
  });
});

test('configured URL credentials and explicit MCP secret arguments protect unlabelled echoes', async t => {
  const { api } = await setup(t);
  const values = ['URLfixtureSecret', 'ARGSfixtureSecret', 'INLINEfixtureSecret', 'url-user', 'p@ss%value'];
  const policy = { ...config, providers: [{ baseUrl: 'https://url-user:p%40ss%25value@fixture.invalid/v1?client_secret=URLfixtureSecret' }], externalMcpServers: [{ args: ['--token', values[1], '--api-key=' + values[2], '--port', '43210'] }] };
  api.configure(policy);
  await api.run('configured-credentials', policy, async () => {
    const body = await api.beforeRequest({ messages: [{ content: values.join(' ') + ' 43210' }] });
    const wire = JSON.stringify(body); assert.ok(values.every(value => !wire.includes(value))); assert.ok(wire.includes('43210'));
  });
});

test('ordinary configured MCP env flags and provider headers never become credential literals', async t => {
  const { api } = await setup(t);
  const ordinary = { PYTHONUTF8: '1', PYTHONPATH: 'C:/fixture/modules', PATH: 'C:/fixture/bin', NODE_ENV: 'production', FEATURE_FLAG: 'true' };
  const headers = { 'Content-Type': 'application/json', 'x-client-version': '1', Accept: 'application/json' };
  const policy = { ...config, providers: [{ id: 'x', extraHeaders: headers }], externalMcpServers: [{ id: 'fixture', env: ordinary, headers }] };
  api.configure(policy);
  await api.run('ordinary-mcp-env', policy, async () => {
    const body = { model: 'model-1', messages: [{ role: 'user', content: Object.values(ordinary).join(' ') + ' application/json' }], max_tokens: 1024, temperature: 1, stream: true };
    const wire = await api.beforeModelRequest(body);
    assert.equal(wire.model, body.model); assert.equal(wire.max_tokens, 1024); assert.equal(wire.temperature, 1); assert.equal(wire.stream, true);
    assert.equal(wire.messages.at(-1).content, body.messages[0].content);
    const result = { ok: true, count: 1, production: true, content: body.messages[0].content };
    assert.equal(JSON.stringify(await api.modelToolResult(result)), JSON.stringify(result));
    assert.equal(api.active().scope.size(), 0, 'runtime flags and content types create no credential mappings');
  });
});

test('credential-named env and headers retain exact protection while unknown fields use format and custom rules', async t => {
  const { api } = await setup(t);
  const credentials = {
    AWS_ACCESS_KEY_ID: 'fixture-access-value-A', AWS_SECRET_ACCESS_KEY: 'fixture-secret-value-B', AWS_SESSION_TOKEN: 'fixture-session-value-C',
    GITHUB_PAT: 'fixture-pat-value-D', QINIU_AK: 'fixture-qiniu-value-E', QINIU_SK: 'fixture-qiniu-value-F',
    DB_PASS: 'fixture-db-value-G', MCP_AUTH: 'fixture-auth-value-H', APIKEY: 'fixture-api-value-I', MY_PWD: 'fixture-pwd-value-J',
  };
  const bearer = 'fixture-bearer-value-K', basic = 'Zml4dHVyZTpiYXNpYy12YWx1ZQ==';
  const formatted = 'ghp_SyntheticUnknownHeader0123456789abcdef', custom = 'fixture-custom-value-L';
  const values = [...Object.values(credentials), bearer, basic, formatted, custom, 'fixture-url-user', 'fixture-url-password', 'fixture-query-value', 'fixture-cookie-value'];
  const policy = { ...config, privacyRulesV1: [{ id: 'unknown-field-secret', kind: 'literal', value: custom, category: 'CREDENTIAL' }],
    providers: [{ extraHeaders: { 'x-client-version': '1', 'x-custom-auth': 'fixture-auth-value-H', 'x-unknown': 'Bearer ' + bearer } }],
    externalMcpServers: [{ env: { ...credentials, RUNTIME_ENDPOINT: 'https://fixture-url-user:fixture-url-password@fixture.invalid/?token=fixture-query-value', UNCLASSIFIED: custom },
      headers: { Cookie: 'fixture-cookie-value', 'x-unknown-basic': 'Basic ' + basic, 'x-unknown-format': formatted } }] };
  api.configure(policy);
  await api.run('classified-config-fields', policy, async () => {
    for (const value of values) {
      const wire = await api.beforeModelRequest({ model: 'model-1', messages: [{ role: 'user', content: value }], max_tokens: 1024 });
      assert.ok(!JSON.stringify(wire).includes(value), value);
      const result = await api.toolResult({ content: value });
      assert.ok(!result.content.includes(value), value);
      const call = api.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'fixture.txt', content: result.content }) }, { isRegisteredTool: name => name === 'file_write' });
      assert.equal(call.privacyError, undefined); assert.equal(JSON.parse(call.rawArgs).content, value);
    }
    assert.equal(api.active().scope.detect('1').length, 0, 'ordinary header values remain ordinary even beside real credentials');
  });
});

test('disabled privacy never inspects configured env or headers while preserving request and tool identity', async t => {
  const { api } = await setup(t), policy = { privacyModeV1: 'off' };
  for (const key of ['providers', 'externalMcpServers', 'privacyRulesV1']) Object.defineProperty(policy, key, { get() { throw Error('off config inspected ' + key); } });
  api.configure(policy);
  const body = {}; Object.defineProperty(body, 'messages', { get() { throw Error('off request inspected'); } });
  assert.equal(await api.beforeModelRequest(body), body); assert.equal(await api.modelToolResult(body), body);
});

test('MCP and Anthropic media cannot hide in JSON strings; typed sensitive values and short or long known credentials are protected', async t => {
  const { api } = await setup(t);
  await api.run('media-shapes', config, async () => {
    for (const value of [{ content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }, { source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }]) {
      await assert.rejects(() => api.toolResult(value), /media_not_supported/);
      await assert.rejects(() => api.toolResult({ content: JSON.stringify(value) }), /media_not_supported/);
    }
    await assert.rejects(() => api.beforeRequest({ messages: [{ content: [{ type: 'tool_use', input: { phone: 13800138000 } }] }] }), /numeric_sensitive/);
    await assert.rejects(() => api.toolResult({ password: 1234 }), /numeric_sensitive/);
    await assert.rejects(() => api.beforeRequest({ messages: [], metadata: { phone: 13800138000 } }), /numeric_sensitive/);
  });
  for (const value of ['K7q2X', 'L'.repeat(5000)]) {
    const policy = { ...config, providers: [{ apiKey: value }] }; api.configure(policy);
    await api.run('known-' + value.length, policy, async () => { const result = await api.toolResult({ content: value }); assert.ok(!result.content.includes(value)); assert.ok(result.content.startsWith('[[RUYI_PVT:CREDENTIAL:')); });
  }
});
