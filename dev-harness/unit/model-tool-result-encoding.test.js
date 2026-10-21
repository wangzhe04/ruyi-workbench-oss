'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-tool-encoding-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'encodeModelToolResult', 'truncateToolResult']);
const f = require('../lib/privacy-test-fixture').fixture(), gateway = app.PrivacyGateway;
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
const policy = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
let serial = 0;
const scoped = work => { gateway.configure(policy); return gateway.run('encoding-' + (++serial), policy, work); };
after(() => { f.vault.clear(); assert.equal(path.dirname(root), tempBase); fs.rmSync(root, { recursive: true, force: true }); });

test('OFF retains exact JSON/truncation bytes and never creates privacy state', async () => {
  gateway.configure({ privacyModeV1: 'off', get providers() { throw Error('OFF scanned credentials'); }, get privacyRulesV1() { throw Error('OFF scanned rules'); } });
  const before = fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')) : [];
  const original = app.PrivacyCore.configHooks.sealLocal;
  app.PrivacyCore.configHooks.sealLocal = () => { throw Error('OFF persisted mapping'); };
  try {
    for (const value of [{ ok: true, text: '中文\n"quoted"\t' }, { content: '字'.repeat(90000) }, { items: [1, null, true], nested: '{"email":"public@example.test"}' }]) {
      assert.equal(await app.encodeModelToolResult('fixture', value), app.truncateToolResult('fixture', JSON.stringify(value)));
    }
    assert.equal(gateway.active(), undefined);
    assert.deepEqual(fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')) : [], before);
  } finally { app.PrivacyCore.configHooks.sealLocal = original; }
});

test('long Chinese, nested objects and escaped JSON protect the complete result before truncating and commit omitted aliases', async () => {
  for (const shape of ['plain', 'nested', 'encoded']) await scoped(async () => {
    const original = 'middle-' + shape + '@example.test';
    const span = shape === 'encoded' ? 18000 : 50000;
    const long = '前'.repeat(span) + ' ' + original + ' ' + '后'.repeat(span);
    const value = shape === 'plain' ? { content: long } : shape === 'nested' ? { outer: [{ content: long }] }
      : { content: JSON.stringify({ body: long, email: 'encoded@example.test' }).replace(/middle/g, String.fromCharCode(92) + 'u006diddle') };
    if (shape === 'encoded') assert.ok(value.content.includes(String.fromCharCode(92) + 'u006diddle'), 'fixture contains a literal JSON Unicode escape');
    const snapshot = JSON.stringify(value), encoded = await app.encodeModelToolResult('fixture', value);
    if (shape === 'encoded') assert.ok(snapshot.includes(String.fromCharCode(92).repeat(2) + 'u006diddle'));
    assert.ok(encoded.length < snapshot.length / 2); assert.equal(encoded.includes(original), false);
    assert.equal(JSON.stringify(value), snapshot, 'source object stays intact');
    const context = gateway.active(), entry = context.scope.exportState().entries.find(row => row.value === original);
    assert.ok(entry, 'even the omitted middle was detected');
    assert.equal(encoded.includes(entry.token), false, 'the sensitive span lies in the omitted middle');
    const key = crypto.createHash('sha256').update(context.scopeId).digest('hex');
    const ciphertext = JSON.parse(fs.readFileSync(path.join(data, 'privacy-scopes', key + '.json'), 'utf8'));
    const persisted = JSON.parse(await f.vault.openLocal(ciphertext, 'privacy-mapping', key));
    assert.ok(persisted.entries.some(row => row.token === entry.token && row.value === original), 'mapping committed before truncated result returns');
  });
});

test('source proofs survive encoding by identity and unproven copies cannot authorize aliases', async () => {
  await scoped(async () => {
    const view = await gateway.projectSource('{"email":"proof@example.test"}');
    const row = { text: view.text }; gateway.markSourceView(row, ['/text'], view);
    const encoded = await app.encodeModelToolResult('fixture', { matches: [row] });
    assert.equal(JSON.parse(encoded).matches[0].text, row.text); assert.match(encoded, /RUYI_PVT/);
    await assert.rejects(app.encodeModelToolResult('fixture', { matches: [{ ...row }] }), /privacy.reserved_literal/);
    row.text += ' changed'; await assert.rejects(app.encodeModelToolResult('fixture', { matches: [row] }), /privacy.source_view_changed/);
  });
});

test('typed incompatible results encode the original no-replay receipt; unknown aliases remain strict errors', async () => {
  await scoped(async () => {
    const source = { ok: true, password: null, content: 'receipt-private@example.test' }, snapshot = JSON.stringify(source);
    const encoded = await app.encodeModelToolResult('fixture', source), result = JSON.parse(encoded);
    assert.equal(result.ok, false); assert.equal(result.privacyFiltered, true); assert.equal(result.resultUnavailable, true);
    assert.equal(result.operationMayHaveExecuted, true); assert.equal(result.code, 'privacy.tool_result_withheld'); assert.equal(result.reason, 'privacy.typed_sensitive');
    assert.equal(encoded.includes(source.content), false); assert.equal(JSON.stringify(source), snapshot);
    const unknown = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    await assert.rejects(app.encodeModelToolResult('fixture', { content: unknown }), error => error.code === 'privacy.reserved_literal');
  });
});

test('policy changes while protecting propagate the original error instead of a successful encoded result', async () => {
  await scoped(async () => {
    const pending = app.encodeModelToolResult('fixture', { content: 'policy-private@example.test' });
    gateway.configure({ ...policy, privacyTechnicalV1: true });
    await assert.rejects(pending, error => error.code === 'privacy.policy_changed');
  });
});

test('mapping persistence failures preserve error identity and never return truncated success', async () => {
  await scoped(async () => {
    const original = app.PrivacyCore.configHooks.sealLocal, failure = Object.assign(new Error('synthetic mapping write failed'), { code: 'EIO' });
    app.PrivacyCore.configHooks.sealLocal = async () => { throw failure; };
    try { await assert.rejects(app.encodeModelToolResult('fixture', { content: 'persist-private@example.test' }), error => error === failure); }
    finally { app.PrivacyCore.configHooks.sealLocal = original; }
  });
  // A separate generated module injects the actual mapping store write failure,
  // independently of the encryption hook above and without changing other tests' host.
  const isolated = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'encodeModelToolResult']);
  isolated.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal;
  isolated.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
  const failure = Object.assign(new Error('synthetic store write failed'), { code: 'EIO' });
  isolated.PrivacyGateway.setHost({ data, makeStore: file => ({ read: async () => JSON.parse(await fs.promises.readFile(file, 'utf8')), write: async () => { throw failure; } }) });
  isolated.PrivacyGateway.configure(policy);
  await assert.rejects(isolated.PrivacyGateway.run('encoding-store-write-failure', policy,
    () => isolated.encodeModelToolResult('fixture', { content: 'store-private@example.test' })), error => error === failure);
});
