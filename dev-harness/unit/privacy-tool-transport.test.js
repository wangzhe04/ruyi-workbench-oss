'use strict';
// Transport contracts for the actual registry. No tool side effects, HTTP or real model.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-privacy-tool-contract-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'MCP_TOOLS', 'PROVIDER_SESSION_TOOL_SCHEMAS', 'TOOL_HANDLERS', 'resolveBridge']);
const { fixture, syntheticComparisonPlan } = require('../lib/privacy-test-fixture');
app.PrivacyGateway.setHost({ planDisclosure: syntheticComparisonPlan });
const vault = fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal;
app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const policy = { credentialEncryptionV1: true, privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
let serial = 0;
const scoped = async (fn, selectedPolicy = policy) => { app.PrivacyGateway.configure(selectedPolicy); return app.PrivacyGateway.run('transport-' + (++serial), selectedPolicy, fn); };
const nativeCapability = { isRegisteredTool: () => false }; // Host native registry, not caller-supplied names.
const call = (name, args, capability = nativeCapability) => app.PrivacyGateway.prepareExecution({ name, rawArgs: JSON.stringify(args) }, capability);
const unpack = prepared => { assert.equal(prepared.privacyError, undefined); return JSON.parse(prepared.rawArgs); };
after(() => { vault.clear(); if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-privacy-tool-contract-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });

test('actual native registration alone grants no arbitrary field disclosure; explicit payload slots retain nested values and keys', async () => {
  const names = [...new Set([...Object.keys(app.TOOL_HANDLERS), ...app.MCP_TOOLS.map(row => row.name), ...app.PROVIDER_SESSION_TOOL_SCHEMAS.map(row => row.name)])].sort();
  assert.ok(names.length >= app.MCP_TOOLS.length && app.MCP_TOOLS.length > 100);
  await scoped(async () => {
    const original = 'transport-fixture@example.test', refs = await app.PrivacyGateway.toolResult({ email: original });
    const input = { path: 'fixture.txt', content: { nested: [{ [refs.email]: { arbitraryParameter: refs.email } }] } };
    const prepared = unpack(await call('file_write', input));
    assert.deepEqual(prepared, { path: 'fixture.txt', content: { nested: [{ [original]: { arbitraryParameter: original } }] } });
    assert.ok(JSON.stringify(input).includes(refs.email));
    for (const name of names) {
      const rejected = await call(name, { arbitraryParameter: refs.email }, { isRegisteredTool: () => true });
      assert.ok(rejected.privacyError, name + ': registry existence cannot authorize arbitrary fields');
      assert.equal(rejected.rawArgs.includes(original), false);
    }
    const proxy = unpack(await call('tool_invoke_edit', { name: 'file_write', arguments: { path: 'fixture.txt', content: refs.email } }));
    assert.equal(proxy.arguments.content, original);
  });
});

test('managed MCP registration and model-owned capability fields cannot release original values', async () => {
  await scoped(async () => {
    const refs = await app.PrivacyGateway.toolResult({ password: 'managed-secret-fixture' });
    const route = { fixture__custom_operation: { serverId: 'fixture', toolName: 'custom_operation' } };
    const capability = { resolveBridge: name => app.resolveBridge(route, name), isRegisteredTool: name => Boolean(app.resolveBridge(route, name)) };
    for (const name of ['fixture__custom_operation', 'custom_operation', 'constructor', 'toString', '__proto__', 'invented_tool']) {
      const refused = await call(name, { anything: [refs.password] }, capability);
      assert.ok(refused.privacyError); assert.equal(refused.rawArgs.includes('managed-secret-fixture'), false);
    }
    assert.equal(app.resolveBridge(route, 'constructor'), null);
    for (const name of ['invented_tool', 'fixture__custom_operation']) {
      const refused = await call('tool_invoke_exec', { name, arguments: JSON.stringify({ password: refs.password }) }, capability);
      assert.ok(refused.privacyError); assert.equal(refused.rawArgs.includes('managed-secret-fixture'), false);
    }
    const spoof = await app.PrivacyGateway.prepareExecution({ name: 'invented_tool', registered: true, isRegisteredTool: true, recipient: 'local', rawArgs: JSON.stringify({ value: refs.password }) });
    assert.ok(spoof.privacyError);
  });
});

test('inverse transport checks key collisions, scope ownership and proxy depth before exposing execution values', async () => {
  let ref;
  await scoped(async () => {
    ref = (await app.PrivacyGateway.toolResult({ email: 'collision@example.test' })).email;
    assert.equal((await call('file_write', { content: { [ref]: 1, 'collision@example.test': 2 } })).privacyError.code, 'privacy.key_collision');
    let args = { name: 'file_write', arguments: { content: ref } };
    for (let i = 0; i < 34; i++) args = { name: 'tool_invoke_exec', arguments: args };
    assert.equal((await call('tool_invoke_exec', args)).privacyError.code, 'privacy.structure_limit');
  });
  await scoped(async () => assert.equal((await call('file_write', { content: ref })).privacyError.code, 'privacy.reference_unknown'));
});

test('off mode preserves exact objects and does not parse arguments, inspect rules, start workers or create encrypted state', async () => {
  const before = fs.existsSync(path.join(data, 'privacy-scopes')) ? fs.readdirSync(path.join(data, 'privacy-scopes')).length : 0;
  const off = { privacyModeV1: 'off', get privacyRulesV1() { throw Error('disabled rules touched'); }, get providers() { throw Error('disabled credentials touched'); } };
  app.PrivacyGateway.configure(off);
  await app.PrivacyGateway.run('disabled', off, async () => {
    const body = { messages: [{ content: 'plain@example.test [[RUYI_PVT:literal' }] };
    const tool = { text: 'plain@example.test' };
    const input = { name: 'file_write', get rawArgs() { throw Error('disabled arguments parsed'); } };
    assert.equal(await app.PrivacyGateway.beforeRequest(body), body);
    assert.equal(await app.PrivacyGateway.toolResult(tool), tool);
    assert.equal(app.PrivacyGateway.prepareCall(input, { isRegisteredTool() { throw Error('disabled registry touched'); } }), input);
    assert.equal(await app.PrivacyGateway.projectSource('plain@example.test'), null);
  });
  assert.equal(fs.readdirSync(path.join(data, 'privacy-scopes')).length, before);
});

test('source projections keep partial sensitive spans whole and bind only exact nested result leaves', async () => {
  const custom = { ...policy, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] };
  await scoped(async () => {
    const source = '{"patientCode":"SYNTHETIC-CONTEXT-VALUE","email":"source@example.test"}';
      const view = await app.PrivacyGateway.projectSource(source);
      const start = source.indexOf('CONTEXT'), part = app.PrivacyGateway.sliceSource(view, start, start + 3);
      assert.ok(part.start < start && part.end > start + 3);
      assert.ok(part.text.includes('[[RUYI_PVT:INTERNAL:') && !part.text.includes('CONTEXT'));
      const row = { text: part.text };
      app.PrivacyGateway.markSourceView(row, ['/text'], view);
      const safe = await app.PrivacyGateway.toolResult({ matches: [row], note: 'another@example.test' });
      assert.equal(safe.matches[0].text, part.text); assert.ok(!safe.note.includes('another@example.test'));
      await assert.rejects(() => app.PrivacyGateway.toolResult({ matches: [{ ...row }] }), /reserved_literal/);
      const rawImposter = { text: part.text, metadata: part.text };
      app.PrivacyGateway.markSourceView(rawImposter, ['/text'], view);
      await assert.rejects(() => app.PrivacyGateway.toolResult(rawImposter), /reserved_literal/);
      row.text += ' changed';
      await assert.rejects(() => app.PrivacyGateway.toolResult({ matches: [row] }), /source_view_changed/);
      await assert.rejects(() => app.PrivacyGateway.projectSource(part.text), /reserved_literal/);
      assert.throws(() => app.PrivacyGateway.markSourceView({ text: part.text }, ['/text'], { text: view.text }), /source_proof_invalid/);
  }, custom);
});

test('source proof supports multiple source snapshots and exact escaped JSON restoration without type loss', async () => {
  await scoped(async () => {
    const source = '{\n "n":900719925474099312345,"dup":1,"dup":2,"email":"\\u0061lice@example.test"\n}';
    const first = await app.PrivacyGateway.projectSource(source), second = await app.PrivacyGateway.projectSource('second@example.test');
    const result = { diff: first.text + '\n' + second.text, content: first.text };
    app.PrivacyGateway.markSourceView(result, ['/diff'], [first, second]);
    app.PrivacyGateway.markSourceView(result, ['/content'], first);
    const output = await app.PrivacyGateway.toolResult(result);
    assert.equal(output.diff, result.diff);
    assert.equal(unpack((await call('file_edit', { oldText: output.content, newText: '{}' }))).oldText, source);
    for (let i = 2; i < 128; i++) await app.PrivacyGateway.projectSource('public text');
    await assert.rejects(() => app.PrivacyGateway.projectSource('over budget'), /source_limit/);
  });
});

test('source views cannot retain a partial raw value after another source or a later result field teaches it', async () => {
  const custom = { ...policy, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] };
  app.PrivacyGateway.configure(custom);
  for (const laterSource of [true, false]) await app.PrivacyGateway.run('late-source-' + laterSource, custom, async () => {
    const original = 'SYNTHETIC-UNCLASSIFIED-PATIENT';
    const view = await app.PrivacyGateway.projectSource(original);
    const row = { text: app.PrivacyGateway.sliceSource(view, 0, 9).text };
    const views = [view];
    app.PrivacyGateway.markSourceView(row, ['/text'], views);
    views.length = 0; // The host proof must retain its own snapshot of the view list.
    if (laterSource) {
      await app.PrivacyGateway.projectSource(JSON.stringify({ patientCode: original }));
      assert.throws(() => app.PrivacyGateway.sliceSource(view, 0, 9), /source_view_stale/);
      await assert.rejects(() => app.PrivacyGateway.toolResult({ rows: [row] }), /source_view_stale/);
    } else await assert.rejects(() => app.PrivacyGateway.toolResult({ rows: [row], patientCode: original }), /source_view_stale/);
  });
});

test('source proof checks encoded and nested references against the actual source membership', async () => {
  await scoped(async () => {
    const unrelated = (await app.PrivacyGateway.toolResult({ email: 'unrelated@example.test' })).email;
    const view = await app.PrivacyGateway.projectSource('public text');
    const text = JSON.stringify({ x: unrelated }).replace(/\[/g, '\\u005b');
    assert.throws(() => app.PrivacyGateway.markSourceView({ text }, ['/text'], view), /source_proof_invalid/);
    const ownView = await app.PrivacyGateway.projectSource('own@example.test');
    const ownEncoded = JSON.stringify({ x: ownView.text }).replace(/\[/g, '\\u005b');
    const result = { text: ownEncoded };
    app.PrivacyGateway.markSourceView(result, ['/text'], ownView);
    assert.equal((await app.PrivacyGateway.toolResult(result)).text, ownEncoded);
  });
});

test('enabled text without matches creates no key, and unchanged references avoid repeated ciphertext writes', async () => {
  const seal = app.PrivacyCore.configHooks.sealLocal; let writes = 0;
  app.PrivacyCore.configHooks.sealLocal = (...args) => { writes++; return seal(...args); };
  try {
    await scoped(async () => {
      await app.PrivacyGateway.beforeRequest({ messages: [{ role: 'user', content: 'hello public text' }] });
      assert.equal(writes, 0);
      const body = { messages: [{ role: 'user', content: 'cache@example.test' }] };
      const first = await app.PrivacyGateway.beforeRequest(body);
      assert.equal(writes, 1);
      assert.deepEqual(await app.PrivacyGateway.beforeRequest(body), first);
      await app.PrivacyGateway.toolResult({ email: 'cache@example.test' });
      assert.equal(writes, 1, 'stable scope needs no new encryption or file write');
      await app.PrivacyGateway.toolResult({ email: 'another-cache@example.test' });
      assert.equal(writes, 2);
    });
  } finally { app.PrivacyCore.configHooks.sealLocal = seal; }
});
