'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const binding = { recipient: 'qq:app:tenant:group:room:sender', purpose: 'external-bot-reply', sourceHash: 'host-source-digest' };
async function setup(t, mode = 'enhanced') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bot-disclosure-')), f = fixture(), api = gateway(root, f);
  const config = { privacyModeV1: mode, privacyRulesV1: [], providers: [] };
  api.configure(config);
  t.after(() => { f.vault.clear(); fs.rmSync(root, { recursive: true, force: true }); });
  return { api, config, root };
}
test('host disclosure protects complete original including learned and host vault credentials; receipt is opaque and exact', async t => {
  const { api } = await setup(t);
  await api.withPolicy('steward', async () => {
    api.active().scope.protectValue('patient-case-sentinel', 'INTERNAL');
    const source = 'patient-case-sentinel and vault-secret-sentinel';
    const prepared = await api.prepareDisclosure(source, { ...binding, knownSecrets: ['vault-secret-sentinel'] });
    assert.ok(!prepared.value.includes('patient-case-sentinel')); assert.ok(!prepared.value.includes('vault-secret-sentinel'));
    assert.equal(JSON.stringify(prepared.receipt), '{}');
    api.assertDisclosure(prepared.receipt, { ...binding, value: prepared.value });
    assert.throws(() => api.assertDisclosure(prepared.receipt, { ...binding, value: source }), /disclosure_changed/);
    for (const patch of [{ recipient: 'other' }, { purpose: 'other' }, { sourceHash: 'other' }]) assert.throws(() => api.assertDisclosure(prepared.receipt, { ...binding, ...patch }), /recipient_changed/);
    assert.throws(() => api.assertDisclosure({}, binding), /recipient_changed/);
  });
});
test('unrelated concurrent learning refreshes unchanged bytes; sensitive late learning reprojects the complete source', async t => {
  const { api } = await setup(t);
  await api.withPolicy('steward', async () => {
    const prepared = await api.prepareDisclosure('later-sensitive-value remains here', binding);
    api.active().scope.protectValue('unrelated-value', 'INTERNAL');
    assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /disclosure_dirty/);
    assert.equal(await api.refreshDisclosure(prepared.receipt, binding), prepared.value);
    api.active().scope.protectValue('later-sensitive-value', 'INTERNAL');
    const next = await api.refreshDisclosure(prepared.receipt, binding);
    assert.ok(!next.includes('later-sensitive-value')); api.assertDisclosure(prepared.receipt, { ...binding, value: next });
  });
});
test('microtask learning between synchronous transform and await continuation cannot stamp stale bytes current', async t => {
  const { api } = await setup(t);
  await api.withPolicy('steward', async () => {
    const scope = api.active().scope;
    // protectedTransform's no-regex stable pass executes synchronously. This
    // queued task runs before its caller resumes after await.
    queueMicrotask(() => scope.protectValue('microtask-sensitive-value', 'INTERNAL'));
    const prepared = await api.prepareDisclosure('microtask-sensitive-value', binding);
    const value = await api.refreshDisclosure(prepared.receipt, binding);
    assert.ok(!value.includes('microtask-sensitive-value'));
    api.assertDisclosure(prepared.receipt, { ...binding, value });
  });
});
test('unknown, cross-scope, revoked references and policy flips refuse disclosure', async t => {
  const { api, config } = await setup(t); let token;
  await api.withPolicy('other', async () => { token = api.active().scope.protectValue('foreign-value', 'INTERNAL'); });
  await api.withPolicy('steward', async () => {
    await assert.rejects(api.prepareDisclosure(token, binding), /reference_unknown/);
    await assert.rejects(api.prepareDisclosure('[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]', binding), /reference_unknown/);
    const own = api.active().scope.protectValue('own-value', 'INTERNAL');
    const prepared = await api.prepareDisclosure(own, binding);
    api.active().scope.revoke(own);
    assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /disclosure_dirty|reference_revoked/);
    await assert.rejects(api.refreshDisclosure(prepared.receipt, binding), /reference_revoked|reference_unknown/);
    const fresh = await api.prepareDisclosure('public text', binding);
    api.configure({ ...config, privacyModeV1: 'off' });
    assert.throws(() => api.assertDisclosure(fresh.receipt, binding), /policy_changed/);
  });
});
test('off preserves exact payload without initializing scopes or inspecting host secrets and still binds opt-in', async t => {
  const { api, config, root } = await setup(t, 'off');
  await api.withPolicy('steward', async () => {
    const hostBinding = { ...binding, get knownSecrets() { throw Error('OFF inspected credentials'); } };
    const source = 'literal [[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]';
    const prepared = await api.prepareDisclosure(source, hostBinding);
    assert.equal(prepared.value, source); assert.equal(api.active(), undefined); assert.deepEqual(fs.readdirSync(root), []);
    api.assertDisclosure(prepared.receipt, binding);
    api.configure({ ...config, privacyModeV1: 'basic' });
    assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /policy_changed/);
  });
});

test('receipt policy epochs reject signature and availability round trips even after refresh', async t => {
  for (const startingMode of ['off', 'enhanced']) {
    const { api, config } = await setup(t, startingMode);
    await api.withPolicy('steward', async () => {
      const prepared = await api.prepareDisclosure('public synthetic reply', binding);
      assert.equal(await api.refreshDisclosure(prepared.receipt, binding), prepared.value);
      api.configure({ ...config, unrelatedUiPreference: true });
      api.assertDisclosure(prepared.receipt, binding);
      api.configure({ ...config, privacyModeV1: startingMode === 'off' ? 'enhanced' : 'off' });
      api.configure(config);
      assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /policy_changed/);
      await assert.rejects(api.refreshDisclosure(prepared.receipt, binding), /policy_changed/);
    });
  }
  for (const disrupt of [api => api.markUnavailable(), (api, config) => api.configure({ ...config, privacyPolicyRecoveryRequiredV1: true }), (api, config) => {
    try { api.configure({ ...config, privacyRulesV1: [{}] }); } catch { /* actual invalid configuration */ }
  }]) {
    const { api, config } = await setup(t);
    await api.withPolicy('steward', async () => {
      const prepared = await api.prepareDisclosure('public synthetic reply', binding);
      disrupt(api, config); api.configure(config);
      assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /policy_changed/);
      await assert.rejects(api.refreshDisclosure(prepared.receipt, binding), /policy_changed/);
    });
  }
});
