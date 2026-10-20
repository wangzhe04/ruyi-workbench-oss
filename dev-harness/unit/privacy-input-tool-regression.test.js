'use strict';
// Production wire encoders, privacy boundary and real file handlers. No listener,
// real model, browser, CLI or DPAPI subprocess; ciphertext uses a synthetic protector.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-input-tool-regression-'));
const work = path.join(root, 'work'), data = path.join(root, 'data');
fs.mkdirSync(work); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'FILE_TOOL_HANDLERS', 'providerWireProtocol',
  'createSession', 'loadSession', 'saveSession', 'readConfig', 'runSessionTurn', 'turnSettlers'], { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const cnId = prefix => prefix + '10X98765432'[[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2].reduce((sum, weight, i) => sum + weight * Number(prefix[i]), 0) % 11];
const values = { email: 'synthetic-input-chain@example.test', id: cnId('11010120000101001'),
  key: 'sk-synthetic-' + 'A'.repeat(24), internal: 'SYNTHETIC-INTERNAL-CONTENT', technical: '10.71.82.93', public: 'PUBLIC-ORDER-20261020' };
const cnCredentials = { API密钥: 'SYNTHETIC-CN-API-CREDENTIAL', 访问令牌: 'SYNTHETIC-CN-ACCESS-CREDENTIAL', 刷新令牌: 'SYNTHETIC-CN-REFRESH-CREDENTIAL' };
const commonPersonal = ['139 0000 0088', '139-0000-0088', '合成甲', "O'Brien"];
let serial = 0;
const policy = (mode, technical = false) => ({ privacyModeV1: mode, privacyTechnicalV1: technical, privacyRulesV1: [],
  providers: [], credentialEncryptionV1: true, defaultWorkspace: work });
const ctx = config => ({ config, workingDir: work, sessionId: 'sess_input_chain', session: { id: 'sess_input_chain', cwd: work } });
const scoped = async (config, run, id = 'input-chain-' + (++serial)) => {
  app.PrivacyGateway.configure(config); return app.PrivacyGateway.run(id, config, run);
};

test('business-number phone exclusions survive complete JSON requests and tool returns without weakening learned privacy', async () => {
  const config = policy('enhanced');
  await scoped(config, async () => {
    for (const data of [{ orderId: '13900000088' }, { trackingNumber: '13900000088' }, { 学号: '13900000088' }]) {
      const source = JSON.stringify(data);
      assert.equal((await app.PrivacyGateway.beforeRequest(encode('chat', [{ role: 'user', content: source }]))).messages.at(-1).content, source);
      assert.equal(JSON.stringify(await app.PrivacyGateway.toolResult(data)), source);
    }
    const returned = await app.PrivacyGateway.toolResult({ phone: '13900000088' });
    assert.ok(returned.phone.startsWith('[[RUYI_PVT:PHONE:'));
    const duplicate = await app.PrivacyGateway.toolResult({ orderId: '13900000088' });
    assert.ok(!JSON.stringify(duplicate).includes('13900000088'), 'a known private value cannot be declassified by relabelling it as an order');
    const prepared = app.PrivacyGateway.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'synthetic.txt', content: returned.phone }) });
    assert.equal(prepared.privacyError, undefined); assert.equal(JSON.parse(prepared.rawArgs).content, '13900000088');
  });
});
for (const generation of ['second', 'third']) test(generation + ' scenarios preserve the same privacy contract through user input, JSON tool returns and exact tool restoration', async () => {
  const corpus = generation === 'second' ? require('../privacy-31/second-scenario-corpus').createSecondCorpus() : require('../privacy-31/third-scenario-corpus').createThirdCorpus();
  for (const mode of ['off', 'basic', 'enhanced', 'strict']) {
    const config = policy(mode, false);
    await scoped(config, async () => {
      for (const row of corpus.cases) {
        const body = await app.PrivacyGateway.beforeRequest(encode('chat', [{ role: 'user', content: row.sample }]));
        const protectedInput = body.messages.at(-1).content;
        const returned = await app.PrivacyGateway.toolResult({ text: row.sample });
        const hidden = mode !== 'off' && (row.tier === 'basic' || mode !== 'basic');
        // Inspect outside opaque IDs; three-digit CVVs can occur in random token IDs.
        const visible = value => value.replace(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g, '');
        assert.equal(!visible(protectedInput).includes(row.secret), hidden, mode + '/' + row.id + '/input');
        assert.equal(!visible(returned.text).includes(row.secret), hidden, mode + '/' + row.id + '/tool');
        const prepared = app.PrivacyGateway.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: 'synthetic.txt', content: returned.text }) }, { isRegisteredTool: () => false });
        assert.equal(prepared.privacyError, undefined, mode + '/' + row.id + '/restore');
        assert.equal(JSON.parse(prepared.rawArgs).content, row.sample, mode + '/' + row.id + '/exact');
      }
      for (const sample of [...corpus.negatives, ...corpus.technical]) {
        const returned = await app.PrivacyGateway.toolResult({ text: sample });
        assert.equal(returned.text, sample, mode + '/public-negative');
      }
    });
  }
});
const encode = (style, messages) => app.providerWireProtocol(style).encodeMessages({ model: 'synthetic', messages, stream: true,
  provider: { apiStyle: style, anthropicThinking: 'off' }, hasTools: false });
const restore = (text, name = 'file_write') => {
  const prepared = app.PrivacyGateway.prepareCall({ name, rawArgs: JSON.stringify({ content: text }) }, { isRegisteredTool: () => false });
  assert.equal(prepared.privacyError, undefined); return JSON.parse(prepared.rawArgs).content;
};
after(() => { f.vault.clear(); if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-input-tool-regression-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });

test('three production wire encoders protect fresh input and old history according to each selected tier', async () => {
  const text = [values.email, values.id, JSON.stringify(cnCredentials), '手机号：' + commonPersonal[0], '手机号是' + commonPersonal[1],
    '姓名是' + commonPersonal[2], '联系人为' + commonPersonal[3], 'apiKey=' + values.key, '内部项目：' + values.internal, values.technical, values.public].join('\n');
  for (const style of ['chat', 'responses', 'anthropic']) for (const mode of ['off', 'basic', 'enhanced', 'strict']) for (const technical of [false, true]) {
    const config = policy(mode, technical);
    await scoped(config, async () => {
      const body = encode(style, [{ role: 'user', content: text }, { role: 'assistant', content: text }, { role: 'user', content: 'Repeat the previous synthetic contact.' }]);
      const sent = await app.PrivacyGateway.beforeRequest(body), wire = JSON.stringify(sent);
      if (mode === 'off') assert.equal(sent, body);
      for (const [value, hidden] of [[values.key, mode !== 'off'], [values.email, ['enhanced', 'strict'].includes(mode)],
        ...Object.values(cnCredentials).map(value => [value, mode !== 'off']), ...commonPersonal.map(value => [value, ['enhanced', 'strict'].includes(mode)]),
        [values.id, ['enhanced', 'strict'].includes(mode)], [values.internal, mode === 'strict'], [values.technical, mode !== 'off' && technical]]) {
        assert.equal(wire.includes(value), !hidden, style + '/' + mode + '/technical=' + technical + ' expected tier boundary');
      }
      assert.ok(wire.includes(values.public));
    });
  }
});

test('complete JSON and formatted file reads cross each real wire encoder, then restore into real file execution', async () => {
  const raw = JSON.stringify({ email: values.email, idCard: values.id, apiKey: values.key, order: values.public }, null, 2);
  const source = path.join(work, 'synthetic-contact.json'); fs.writeFileSync(source, raw);
  for (const style of ['chat', 'responses', 'anthropic']) for (const view of [{}, { lineOffset: 2, lineLimit: 2 }]) {
    const config = policy('enhanced');
    await scoped(config, async () => {
      const result = await app.PrivacyGateway.toolResult(await app.FILE_TOOL_HANDLERS.file_read.handler({ path: source, ...view }, ctx(config)));
      assert.equal(result.ok, true);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(values.email)); assert.ok(!serialized.includes(values.id)); assert.ok(!serialized.includes(values.key));
      const reference = serialized.match(/\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]/)?.[0]; assert.ok(reference);
      const body = encode(style, [{ role: 'assistant', content: '', tool_calls: [{ id: 'synthetic-read', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: source }) } }] },
        { role: 'tool', tool_call_id: 'synthetic-read', content: serialized }, { role: 'user', content: 'Copy only the contact email.' }]);
      const sent = JSON.stringify(await app.PrivacyGateway.beforeRequest(body));
      for (const original of [values.email, values.id, values.key]) assert.equal(sent.includes(original), false);
      const destination = path.join(work, style + '-' + (view.lineOffset || 'full') + '.txt');
      const prepared = app.PrivacyGateway.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ path: destination, content: reference }) }, { isRegisteredTool: () => false });
      assert.equal(prepared.privacyError, undefined);
      const written = await app.FILE_TOOL_HANDLERS.file_write.handler(JSON.parse(prepared.rawArgs), ctx(config));
      assert.equal(written.ok, true); assert.equal(fs.readFileSync(destination, 'utf8'), values.email);
      const verified = await app.PrivacyGateway.toolResult(await app.FILE_TOOL_HANDLERS.file_read.handler({ path: destination }, ctx(config)));
      assert.equal(verified.content, reference);
    });
  }
});

test('enabling protection on an existing native history protects old and new values in the next encoded request', async () => {
  for (const style of ['chat', 'responses', 'anthropic']) {
    const history = [{ role: 'user', content: values.id }, { role: 'assistant', content: 'Prior synthetic contact: ' + values.email }];
    app.PrivacyGateway.configure(policy('off'));
    assert.ok(JSON.stringify(await app.PrivacyGateway.beforeRequest(encode(style, history))).includes(values.id));
    await scoped(policy('enhanced'), async () => {
      const sent = JSON.stringify(await app.PrivacyGateway.beforeRequest(encode(style, [...history, { role: 'user', content: 'Remember ' + values.email }])));
      assert.ok(!sent.includes(values.id)); assert.ok(!sent.includes(values.email)); assert.ok(sent.includes('RUYI_PVT:'));
      assert.equal(history[0].content, values.id, 'wire projection does not silently rewrite local display history');
    });
  }
});

test('labelled and Chinese-field synthetic identity variants cross real encoders without weakening basic tier negatives', async () => {
  const invalid = values.id.slice(0, -1) + (values.id.endsWith('0') ? '1' : '0');
  const grouped = invalid.slice(0, 6) + ' ' + invalid.slice(6, 14) + '-' + invalid.slice(14);
  const fullwidth = invalid.replace(/\d/g, value => String.fromCharCode(value.charCodeAt(0) + 0xfee0));
  const variants = [invalid, grouped, fullwidth, '320311770706001'];
  for (const style of ['chat', 'responses', 'anthropic']) for (const mode of ['basic', 'enhanced', 'strict']) {
    await scoped(policy(mode), async () => {
      for (const value of variants) {
        const text = '我的身份证号码是' + value + '\n公开订单：PUBLIC-ORDER-20261020';
        const sent = JSON.stringify(await app.PrivacyGateway.beforeRequest(encode(style, [{ role: 'user', content: text }])));
        assert.equal(sent.includes(value), mode === 'basic', style + '/' + mode + ': labelled identity tier boundary');
        if (mode !== 'basic') assert.match(sent, /RUYI_PVT:IDENTITY:/);
      }
      const fieldOnly = 'SYNTHETIC-CHINESE-ID-FIELD-ONLY';
      const body = await app.PrivacyGateway.beforeRequest(encode(style, [{ role: 'user', content: JSON.stringify({ 身份证号: fieldOnly }) }]));
      assert.equal(JSON.stringify(body).includes(fieldOnly), mode === 'basic', 'field alias cannot borrow a previously learned labelled value');
    });
  }
});

test('typed personal values, unknown and cross-scope references cannot reach execution or a model request', async () => {
  let reference;
  await scoped(policy('enhanced'), async () => {
    reference = (await app.PrivacyGateway.toolResult({ email: values.email })).email;
    for (const style of ['chat', 'responses', 'anthropic']) for (const value of [{ idCard: Number(values.id.slice(0, 17)) }, { idCard: true }, { idCard: null }]) {
      await assert.rejects(app.PrivacyGateway.beforeRequest(encode(style, [{ role: 'user', content: JSON.stringify(value) }])), /privacy\.(?:typed|numeric)_sensitive/);
    }
    const unknown = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    assert.equal(app.PrivacyGateway.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: unknown }) }).privacyError.code, 'privacy.reference_unknown');
    for (const style of ['chat', 'responses', 'anthropic']) await assert.rejects(app.PrivacyGateway.beforeRequest(encode(style, [{ role: 'user', content: unknown }])), /privacy\.reference_unknown/);
  });
  await scoped(policy('enhanced'), async () => {
    assert.equal(app.PrivacyGateway.prepareCall({ name: 'file_write', rawArgs: JSON.stringify({ content: reference }) }).privacyError.code, 'privacy.reference_unknown');
    for (const style of ['chat', 'responses', 'anthropic']) await assert.rejects(app.PrivacyGateway.beforeRequest(encode(style, [{ role: 'user', content: reference }])), /privacy\.reference_unknown/);
  });
  let now = 100;
  const scope = app.PrivacyCore.createScope({ scopeId: 'expired-input-regression', detector: app.PrivacyCore.createDetector({ personal: true }), ttlMs: 10, clock: () => now });
  const ref = scope.protectRaw(values.email).text; now += 11;
  assert.throws(() => scope.restoreForTool(ref, { scopeId: 'expired-input-regression', tool: 'file_write', pointer: '/content', destination: 'local-harness', purpose: 'authorized-tool-input', authorize: () => true }), /reference_expired/);
  scope.clear();
});

test('on-to-off host history migration restores old values without secretly enabling the disabled tool translator', async () => {
  let reference;
  const scopeId = 'off-history-regression';
  await scoped(policy('enhanced'), async () => { reference = (await app.PrivacyGateway.toolResult({ email: values.email })).email; assert.equal(restore(reference), values.email); }, scopeId);
  app.PrivacyGateway.configure(policy('off'));
  const oldHistory = [{ role: 'assistant', content: reference }, { role: 'user', content: 'Copy that old tool contact.' }];
  const migrated = await app.PrivacyGateway.restoreHistory(scopeId, oldHistory);
  assert.equal(migrated[0].content, values.email); assert.equal(oldHistory[0].content, reference);
  const lexical = '{  "big":900719925474099312345, "dup":1,"dup":2, "untouched":"\\u0061\\t", "contact":' + JSON.stringify(reference) + ' }';
  const exact = await app.PrivacyGateway.restoreHistory(scopeId, [{ role: 'tool', content: lexical }]);
  assert.equal(exact[0].content, lexical.replace(reference, values.email), 'only affected lexical token changes');
  const nestedEncoded = JSON.stringify({ outer: lexical.replaceAll('[', '\\u005b') });
  const nested = await app.PrivacyGateway.restoreHistory(scopeId, [{ role: 'tool', content: nestedEncoded }]);
  assert.equal(JSON.parse(nested[0].content).outer, lexical.replace(reference, values.email), 'nested escaped history references are validated and restored');
  const body = encode('chat', migrated); assert.equal(await app.PrivacyGateway.beforeRequest(body), body);
  const call = { name: 'file_write', rawArgs: JSON.stringify({ path: path.join(work, 'off-old-history.txt'), content: migrated[0].content }) };
  const prepared = app.PrivacyGateway.prepareCall(call);
  assert.equal(prepared, call, 'required disabled-path identity is preserved');
  const result = await app.FILE_TOOL_HANDLERS.file_write.handler(JSON.parse(prepared.rawArgs), ctx(policy('off')));
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'off-old-history.txt'), 'utf8'), values.email);
  const fresh = [{ role: 'user', content: 'Public fresh off history' }];
  assert.equal(await app.PrivacyGateway.restoreHistory('no-existing-scope', fresh), fresh);
  await assert.rejects(app.PrivacyGateway.restoreHistory('another-scope', oldHistory), /privacy\.(?:reference_unknown|mapping_missing|mapping_unavailable)/);
  await assert.rejects(app.PrivacyGateway.restoreHistory(scopeId, [{ role: 'assistant', content: '[[RUYI_PVT:EMAIL:' + 'e'.repeat(32) + ']]' }]), /privacy\.reference_unknown/);
  const forged = JSON.stringify({ outer: JSON.stringify({ contact: '[[RUYI_PVT:EMAIL:' + 'e'.repeat(32) + ']]' }).replaceAll('[', '\\u005b') });
  await assert.rejects(app.PrivacyGateway.restoreHistory(scopeId, [{ role: 'tool', content: forged }]), /privacy\.reference_unknown/);
  const encodedLetters = JSON.stringify({ contact: reference }).replace('RUYI', '\\u0052UYI');
  assert.equal(JSON.parse((await app.PrivacyGateway.restoreHistory(scopeId, [{ content: encodedLetters }]))[0].content).contact, values.email);
  const unknownLetters = encodedLetters.replace(reference.match(/[a-f0-9]{32}/)[0], 'e'.repeat(32));
  await assert.rejects(app.PrivacyGateway.restoreHistory(scopeId, [{ content: unknownLetters }]), /privacy\.reference_unknown/);
  const topString = JSON.stringify(reference).replace('R', '\\u0052');
  assert.equal((await app.PrivacyGateway.restoreHistory(scopeId, [{ content: topString }]))[0].content, JSON.stringify(values.email));
  await assert.rejects(app.PrivacyGateway.restoreHistory(scopeId, [{ content: topString.replace(reference.match(/[a-f0-9]{32}/)[0], 'e'.repeat(32)) }]), /privacy\.reference_unknown/);
  const unrelated = [{ content: '{"letter":"\\u0061","big":900719925474099312345}' }];
  assert.equal(await app.PrivacyGateway.restoreHistory('absent-unrelated-unicode-scope', unrelated), unrelated,
    'unrelated Unicode JSON does not load any mapping or vault');
});

test('actual turn admission owns a delayed off-history migration before a second source can enter', async () => {
  app.__eval("detectClaudePath = () => ''; detectKimiPath = () => ''; maybeWriteThreadBrief = async () => {}; runOpenAiTurn = async function({ session, onEvent }) { await saveSession(session); onEvent({ type: 'result', ok: true }); };");
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, privacyModeV1: 'off', credentialEncryptionV1: false,
    activeProvider: 'migration-fixture', providers: [{ id: 'migration-fixture', type: 'openai-compat', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKey: '' }],
    defaultWorkspace: work, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, stewardEnabledV1: false,
    stewardThreadBriefV1: false, schedulerEnabledV1: false, runtimeOptimizationShadowV1: false, contextAutoCompactEnabled: false,
    sessionNotesEnabledV1: false, desktopMcp: { enabled: false, autodetect: false }, missionAutoContinue: false }));
  const session = await app.createSession({ title: 'Synthetic migration admission', cwd: work });
  const scope = app.PrivacyCore.createScope({ scopeId: session.id, detector: app.PrivacyCore.createDetector({ personal: true }) });
  const ref = scope.protectRaw(values.email).text;
  const key = require('node:crypto').createHash('sha256').update(session.id).digest('hex');
  const file = path.join(data, 'privacy-scopes', key + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(await f.vault.sealLocal(JSON.stringify(scope.exportState()), 'privacy-mapping', key))); scope.clear();
  session.privacyHistoryV1 = true;
  session.messages = [{ role: 'assistant', content: ref, createdAt: new Date().toISOString(), engine: 'openai', providerId: 'migration-fixture' }];
  session.providerHistory = [{ role: 'assistant', content: ref }]; await app.saveSession(session);
  const open = app.PrivacyCore.configHooks.openLocal;
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  app.PrivacyCore.configHooks.openLocal = async (...args) => { entered(); await gate; return open(...args); };
  let first;
  try {
    first = app.runSessionTurn({ sessionId: session.id, source: 'scheduler', message: 'Resume the synthetic contact.', onEvent() {} });
    await Promise.race([blocked, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('migration gate was not reached')), 3000); timer.unref(); })]);
    const owner = app.turnSettlers.get(session.id); assert.ok(owner);
    await assert.rejects(app.runSessionTurn({ sessionId: session.id, source: 'agent_wake', message: 'Competing synthetic turn.', onEvent() {} }), error => error.code === 'SESSION_TURN_BUSY_ELSEWHERE');
    assert.equal(app.turnSettlers.get(session.id), owner, 'competing source does not replace the migration owner');
    release(); await first;
    const stored = await app.loadSession(session.id);
    assert.equal(stored.privacyHistoryV1, false);
    assert.equal(stored.providerHistory[0].content, values.email);
    assert.equal(stored.messages[0].content, values.email);
    assert.equal(app.turnSettlers.has(session.id), false);
  } finally { release(); app.PrivacyCore.configHooks.openLocal = open; if (first) await first; }
});
