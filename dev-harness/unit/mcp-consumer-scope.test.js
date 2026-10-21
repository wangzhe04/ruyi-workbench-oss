'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const binding = { recipient: 'consumer-test', purpose: 'protocol-output', sourceHash: 'whole-logical-output' };
async function setup(t, mode = 'enhanced') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-consumer-scope-')), source = fixture(), api = gateway(root, source);
  api.configure({ privacyModeV1: mode, privacyRulesV1: [], providers: [] });
  t.after(() => { source.vault.clear(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, api };
}
test('connection capabilities are opaque, isolated and commit mappings only in memory', async t => {
  const { root, api } = await setup(t), one = api.createConnectionScope(), two = api.createConnectionScope();
  assert.deepEqual(Object.keys(one).sort(), ['close', 'run']);
  let token;
  await one.run(async () => {
    const prepared = await api.prepareDisclosure('private-user@example.test', binding); token = prepared.value;
    assert.ok(!token.includes('private-user@example.test')); api.assertDisclosure(prepared.receipt, { ...binding, value: token });
  });
  await assert.rejects(two.run(() => api.prepareDisclosure(token, binding)), /reference_unknown/);
  assert.deepEqual(fs.readdirSync(root), []);
  one.close(); two.close();
  await assert.rejects(one.run(async () => {}), /connection_closed/);
});
test('OFF connection creates neither detector context nor mapping/vault files', async t => {
  const { root, api } = await setup(t, 'off'), connection = api.createConnectionScope();
  await connection.run(async () => { assert.equal(api.active(), undefined); const value = await api.prepareDisclosure('literal private-user@example.test', binding); assert.equal(value.value, 'literal private-user@example.test'); });
  connection.close(); assert.deepEqual(fs.readdirSync(root), []);
});
test('policy migration waits for busy requests and preserves aliases without category downgrade', async t => {
  const { api } = await setup(t), connection = api.createConnectionScope();
  let release, ready, token;
  const started = new Promise(resolve => { ready = resolve; });
  const work = connection.run(async () => { token = (await api.prepareDisclosure('private-user@example.test', binding)).value; ready(); await new Promise(resolve => { release = resolve; }); });
  await started;
  api.configure({ privacyModeV1: 'strict', privacyRulesV1: [], providers: [] });
  await assert.rejects(connection.run(async () => {}), /connection_busy/);
  release(); await assert.rejects(work, /policy_changed/);
  await connection.run(async () => { const next = await api.prepareDisclosure(token, binding); assert.equal(next.value, token); });
  connection.close();
});
test('close immediately refuses new work and withholds a held old output', async t => {
  const { api, root } = await setup(t), connection = api.createConnectionScope(); let release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const work = connection.run(async () => { await api.prepareDisclosure('private-user@example.test', binding); ready(); await new Promise(resolve => { release = resolve; }); });
  await started; connection.close(); await assert.rejects(connection.run(async () => {}), /connection_closed/);
  release(); await assert.rejects(work, /connection_closed/); assert.deepEqual(fs.readdirSync(root), []);
});
test('policy flipback cannot revive a held connection request', async t => {
  const { api } = await setup(t), connection = api.createConnectionScope(); let release, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const work = connection.run(async () => { ready(); await new Promise(resolve => { release = resolve; }); });
  await started;
  api.configure({ privacyModeV1: 'off', privacyRulesV1: [], providers: [] });
  api.configure({ privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] });
  release(); await assert.rejects(work, /policy_changed/); connection.close();
});
test('parallel sensitive learning invalidates a receipt and reprojects its complete original', async t => {
  const { api } = await setup(t), connection = api.createConnectionScope(); let prepared;
  await connection.run(async () => { prepared = await api.prepareDisclosure('learned-late-private', binding); });
  await connection.run(async () => { api.active().scope.protectValue('learned-late-private', 'INTERNAL'); });
  await connection.run(async () => {
    assert.throws(() => api.assertDisclosure(prepared.receipt, binding), /disclosure_dirty/);
    const value = await api.refreshDisclosure(prepared.receipt, binding); assert.ok(!value.includes('learned-late-private'));
    api.assertDisclosure(prepared.receipt, { ...binding, value });
  }); connection.close();
});
