'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const config = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
const unknown = '[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-history-quarantine-')), f = fixture(), api = gateway(root, f); api.configure(config);
  t.after(() => { f.vault.clear(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ruyi-history-quarantine-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, f, api };
}
const call = argumentsText => ({ id: 'negative', type: 'function', function: { name: 'file_write', arguments: argumentsText } });
test('host history quarantines only bad slots while canonical arguments and valid references stay exact', async t => {
  const { api } = await setup(t);
  await api.run('scope', config, async () => {
    const valid = api.active().scope.protectValue('synthetic-history@example.test', 'EMAIL');
    const args = JSON.stringify({ path: 'negative.txt', content: unknown });
    const history = [{ role: 'user', content: valid }, { role: 'assistant', content: 'old ' + unknown, reasoning_content: unknown, tool_calls: [call(args)] },
      { role: 'tool', tool_call_id: 'negative', content: '{"ok":false,"code":"privacy.reference_unknown"}' }];
    const frozen = JSON.stringify(history), owner = {}; api.bindHostHistory(owner, history);
    const view = api.projectHostHistory(owner, history);
    assert.equal(view[0], history[0]); assert.equal(view[1].tool_calls[0].function.arguments, '{}');
    assert.equal(view[1].tool_calls[0].id, 'negative'); assert.equal(view[1].tool_calls[0].function.name, 'file_write');
    assert.equal(view[2], history[2]); assert.ok(!JSON.stringify(view).includes(unknown)); assert.equal(JSON.stringify(history), frozen);
    assert.ok(!JSON.stringify(await api.beforeRequest({ messages: view })).includes('synthetic-history@example.test'));
    assert.equal((await api.prepareExecution({ name: 'file_write', rawArgs: args })).privacyError.code, 'privacy.reference_unknown');
    assert.equal(JSON.parse((await api.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: 'positive.txt', content: valid }) })).rawArgs).content, 'synthetic-history@example.test');
  });
});
test('new user and steer forgeries stay strict, but the next host-loaded turn can recover', async t => {
  const { api } = await setup(t);
  await api.run('scope', config, async () => {
    const owner = {}, history = []; api.bindHostHistory(owner, history);
    history.push({ role: 'user', content: unknown });
    assert.throws(() => api.projectHostHistory(owner, history), /privacy.reference_unknown/);
    const nextOwner = {}; api.bindHostHistory(nextOwner, history);
    const next = [...history, { role: 'user', content: 'ordinary followup' }];
    assert.doesNotThrow(() => api.projectHostHistory(nextOwner, next));
    assert.equal(next[0].content, unknown);
    await assert.rejects(api.beforeRequest({ messages: [{ role: 'user', content: unknown }] }), /privacy.reference_unknown/);
  });
});
test('Unicode, nested JSON, malformed references and credential contexts cannot poison host history', async t => {
  const { api } = await setup(t);
  await api.run('scope', config, async () => {
    const valid = api.active().scope.protectValue('synthetic-person@example.test', 'EMAIL');
    const examples = [JSON.stringify({ content: unknown }).replaceAll('[', '\\u005b'),
      JSON.stringify({ nested: JSON.stringify({ content: unknown }) }), '{"password":' + JSON.stringify(valid) + '}',
      '{"content":"[[RUYI_PVT:EMAIL:broken]]"}'];
    for (const args of examples) {
      const history = [{ role: 'assistant', content: '', tool_calls: [call(args)] }], owner = {}; api.bindHostHistory(owner, []);
      const projected = api.projectHostHistory(owner, history);
      assert.equal(projected[0].tool_calls[0].function.arguments, '{}');
      assert.equal(history[0].tool_calls[0].function.arguments, args);
      await api.beforeRequest({ messages: projected });
    }
    await assert.rejects(api.beforeRequest({ messages: [{ role: 'user', content: 'Password=' + valid }] }), /privacy.credential_context/);
  });
});
test('expired and revoked historical references disappear only from the model view', async t => {
  const { api } = await setup(t);
  await api.run('scope', config, async () => {
    const scope = api.active().scope, revoked = scope.protectValue('synthetic-revoked@example.test', 'EMAIL'); scope.revoke(revoked);
    const history = [{ role: 'assistant', content: revoked }], owner = {}; api.bindHostHistory(owner, []);
    assert.ok(!JSON.stringify(api.projectHostHistory(owner, history)).includes(revoked));
    assert.equal(history[0].content, revoked);
    assert.match((await api.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: 'x', content: revoked }) })).privacyError.code, /^privacy.reference_(unknown|revoked)$/);
    const expired = scope.protectValue('synthetic-expired@example.test', 'EMAIL'), snapshot = scope.exportState();
    snapshot.entries.find(entry => entry.token === expired).expiresAt = 0; scope.importState(snapshot);
    assert.equal((await api.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: 'x', content: expired }) })).privacyError.code, 'privacy.reference_expired');
    assert.ok(!JSON.stringify(api.projectHostHistory(owner, [{ role: 'assistant', content: expired }])).includes(expired));
  });
});
test('off legacy recovery uses ephemeral copies and creates no new vault or mappings', async t => {
  const { api, root } = await setup(t); api.configure({ ...config, privacyModeV1: 'off' });
  const source = { messages: [], providerHistory: [{ role: 'user', content: unknown }, { role: 'assistant', content: '', tool_calls: [call(JSON.stringify({ content: unknown }))] }] };
  await assert.rejects(api.restoreHistory('missing-scope', source), /privacy.reference_unknown/);
  const view = await api.restoreHistory('missing-scope', source, true), owner = {};
  api.bindRestoredHostHistory(owner, source.providerHistory, view.providerHistory);
  const newInput = { role: 'user', content: 'ordinary off followup' };
  const projected = api.projectHostHistory(owner, [...source.providerHistory, newInput]);
  assert.ok(!JSON.stringify(projected).includes(unknown)); assert.equal(projected.at(-1), newInput);
  assert.ok(JSON.stringify(source).includes(unknown)); assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(await api.beforeRequest({ messages: projected }).then(body => body.messages), projected);
});
test('restart reloads valid mappings and quarantines only unavailable historical references', async t => {
  const { api, root, f } = await setup(t); let valid;
  await api.run('restart', config, async () => { valid = (await api.toolResult({ email: 'restart-history@example.test' })).email; });
  const restarted = gateway(root, f); restarted.configure(config);
  await restarted.run('restart', config, async () => {
    const history = [{ role: 'user', content: valid }, { role: 'assistant', content: unknown }], owner = {}; restarted.bindHostHistory(owner, history);
    const projected = restarted.projectHostHistory(owner, history);
    assert.equal(projected[0].content, valid); assert.ok(!JSON.stringify(projected).includes(unknown));
    assert.equal(JSON.parse((await restarted.prepareExecution({ name: 'file_write', rawArgs: JSON.stringify({ path: 'restart.txt', content: valid }) })).rawArgs).content, 'restart-history@example.test');
  });
});
test('policy and resource failures remain hard errors for history projection', async t => {
  const { api } = await setup(t);
  await api.run('scope', config, async () => {
    const owner = {}; api.bindHostHistory(owner, []);
    let value = 'text'; for (let i = 0; i < 35; i++) value = [value];
    await assert.rejects(api.beforeRequest({ messages: api.projectHostHistory(owner, [{ role: 'assistant', content: value }]) }), /privacy.structure_limit/);
    api.markUnavailable(); assert.throws(() => api.projectHostHistory(owner, [{ role: 'assistant', content: unknown }]), /privacy.policy_unavailable/);
  });
});

test('wide historical JSON is counted once and OFF can continue after an enabled structure refusal', async t => {
  const { api, root } = await setup(t);
  const content = JSON.stringify(Array.from({ length: 10000 }, () => ({ ok: 'ordinary' })));
  const history = [{ role: 'tool', tool_call_id: 'old-read', content }], frozen = JSON.stringify(history);
  await api.run('wide-old-history', config, async () => {
    const owner = {}; api.bindHostHistory(owner, history);
    const projected = api.projectHostHistory(owner, history);
    const result = await api.beforeModelRequest({ messages: projected });
    assert.equal(result.messages.at(-1).content, content);
    const tooWide = [{ role: 'tool', tool_call_id: 'oversized-old-read', content: JSON.stringify(Array.from({ length: 18000 }, () => ({ ok: 'ordinary' }))) }];
    await assert.rejects(api.beforeModelRequest({ messages: tooWide }), /privacy.structure_limit/);
    api.configure({ ...config, privacyModeV1: 'off' });
  });
  const off = { messages: Array.from({ length: 12000 }, () => ({ role: 'assistant', content: 'ordinary public history' })), providerHistory: history };
  assert.equal(await api.restoreHistory('wide-old-history', off, true), off);
  assert.equal(await api.beforeModelRequest({ messages: history }).then(body => body.messages), history);
  assert.equal(JSON.stringify(history), frozen); assert.deepEqual(fs.readdirSync(root), []);
});

test('OFF restores only referenced subtrees across large dual histories while preserving exact ordinary JSON', async t => {
  const { api } = await setup(t); let valid, revoked;
  await api.run('wide-ref-off', config, async () => {
    valid = (await api.toolResult({ email: 'synthetic-wide-off@example.test' })).email;
    revoked = api.active().scope.protectValue('synthetic-revoked-wide@example.test', 'EMAIL');
    api.active().scope.revoke(revoked);
  });
  api.configure({ ...config, privacyModeV1: 'off' });
  const ordinary = JSON.stringify(Array.from({ length: 20000 }, () => ({ ok: 'ordinary' })));
  const rows = Array.from({ length: 10000 }, () => ({ role: 'assistant', content: 'ordinary retained context' }));
  const escaped = JSON.stringify({ content: valid }).replaceAll('R', '\\u0052').replaceAll('[', '\\u005b');
  const source = { messages: rows, providerHistory: [...rows, { role: 'tool', tool_call_id: 'wide', content: ordinary },
    { role: 'tool', tool_call_id: 'mixed-wide', content: ordinary.slice(0, -1) + ',{"ref":' + JSON.stringify(valid) + ',"unavailable":' + JSON.stringify(unknown) + '}]' },
    { role: 'assistant', content: escaped }, { role: 'assistant', content: revoked }] };
  const frozen = JSON.stringify(source), restored = await api.restoreHistory('wide-ref-off', source, true);
  assert.equal(restored.providerHistory.at(-4).content, ordinary);
  assert.ok(!restored.providerHistory.at(-3).content.includes(unknown));
  assert.equal(JSON.parse(restored.providerHistory.at(-2).content).content, 'synthetic-wide-off@example.test');
  assert.ok(!JSON.stringify(restored).includes(revoked));
  assert.equal(JSON.stringify(source), frozen);
  const mixedValid = { providerHistory: [{ role: 'tool', content: ordinary.slice(0, -1) + ',{"ref":' + JSON.stringify(valid) + '}]' }] };
  const restoredValid = await api.restoreHistory('wide-ref-off', mixedValid, true);
  assert.equal(JSON.parse(restoredValid.providerHistory[0].content).at(-1).ref, 'synthetic-wide-off@example.test');
  const credentialContext = { providerHistory: [{ role: 'tool', content: JSON.stringify({ password: valid }) }] };
  assert.ok(!JSON.stringify(await api.restoreHistory('wide-ref-off', credentialContext, true)).includes('synthetic-wide-off@example.test'));
  await assert.rejects(api.restoreHistory('wide-ref-off', { providerHistory: [{ role: 'assistant', content: unknown }] }), /privacy.reference_unknown/);
});
test('summary source protection precedes JSON tagging, extraction and truncation', async t => {
  const { api } = await setup(t), policy = { ...config, privacyRulesV1: [{ id: 'patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }] };
  api.configure(policy);
  await api.run('summary', policy, async () => {
    const original = 'SYNTHETIC-PATIENT-FIELD-ONLY', history = [{ role: 'user', content: JSON.stringify({ patientCode: original }) }], owner = {};
    api.bindHostHistory(owner, history);
    const protectedHistory = await api.protectHostHistory(owner, history);
    assert.ok(!JSON.stringify(protectedHistory).includes(original)); assert.ok(history[0].content.includes(original));
    const tagged = protectedHistory.map(message => ({ ...message, content: '[source 1; role=user; origin=message]\n' + message.content }));
    assert.ok(!JSON.stringify(await api.beforeRequest({ messages: tagged })).includes(original));
    const fresh = { role: 'user', content: unknown };
    await assert.rejects(api.protectHostHistory(owner, [...history, fresh]), /privacy.reference_unknown/);
  });
});
test('expired or revoked raw historical values recover without accepting fresh reuse', async t => {
  const { api } = await setup(t);
  await api.run('raw-revoked', config, async () => {
    const value = 'synthetic-old-revoked@example.test', scope = api.active().scope, token = scope.protectValue(value, 'EMAIL');
    scope.revoke(token);
    const old = { role: 'user', content: 'Prior contact: ' + value }, owner = {}; api.bindHostHistory(owner, [old]);
    assert.ok(!JSON.stringify(api.projectHostHistory(owner, [old])).includes(value)); assert.ok(old.content.includes(value));
    assert.throws(() => api.projectHostHistory(owner, [old, { role: 'user', content: value }]), /privacy.reference_unknown/);
  });
});
test('valid escaped JSON cannot become an uncaught lexical parsing failure during recovery', async t => {
  const { api } = await setup(t); api.configure({ ...config, privacyModeV1: 'off' });
  for (let depth = 0; depth < 12; depth++) {
    let content = 'quote " slash \\ newline\n ' + unknown;
    for (let n = 0; n < depth; n++) content = JSON.stringify({ value: content });
    const source = { providerHistory: [{ role: 'assistant', content }] };
    try {
      const restored = await api.restoreHistory('missing-json', source, true);
      assert.ok(!JSON.stringify(restored).includes(unknown));
    } catch (error) {
      assert.ok(depth >= 6, 'ordinary nesting must recover');
      assert.equal(error.code, 'privacy.structure_limit', 'deeper encodings may hit the unchanged bounded decoder, never an uncaught SyntaxError');
    }
    assert.equal(source.providerHistory[0].content, content);
  }
});
