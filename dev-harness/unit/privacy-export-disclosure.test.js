'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const policy = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-export-copy-')), f = fixture(), api = gateway(root, f);
  api.configure(policy);
  t.after(() => { f.vault.clear(); fs.rmSync(root, { recursive: true, force: true }); });
  return api;
}
test('multi-source copies inherit learned originals, omit aliases and bind all revisions', async t => {
  const api = await setup(t), one = 'synthetic original alpha', two = 'synthetic original beta';
  let alias;
  await api.withPolicy('source-one', async () => { alias = (await api.toolResult({ password: one })).password; });
  await api.withPolicy('source-two', () => api.toolResult({ password: two }));
  const binding = { recipient: 'user-file-copy', purpose: 'unit-copy', sourceHash: 'whole-source' };
  const source = { [one]: { title: two, note: one + two, alias } };
  const copy = await api.prepareMultiSourceDisclosure(source, ['source-one', 'source-two'], binding);
  const encoded = JSON.stringify(copy.value);
  assert.ok(!encoded.includes(one) && !encoded.includes(two) && !encoded.includes('[[RUYI_PVT:'));
  copy.assert();
  await api.withPolicy('source-one', () => api.toolResult({ password: 'later-learning' }));
  assert.throws(copy.assert, /privacy.disclosure_dirty/);
  assert.equal(source[one].alias, alias);
});
test('off is exact without scopes, while protected empty provenance is rejected', async t => {
  const api = await setup(t), binding = { recipient: 'file', purpose: 'copy', sourceHash: 'source' };
  await assert.rejects(api.prepareMultiSourceDisclosure('private', [], binding), /privacy.scope_invalid/);
  api.configure({ ...policy, privacyModeV1: 'off' });
  const original = { text: '[[RUYI_PVT:CREDENTIAL:00000000000000000000000000000000]]' };
  const result = await api.prepareMultiSourceDisclosure(original, [], binding);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), original);
  result.assert(); api.configure(policy); assert.throws(result.assert, /privacy.policy_changed/);
});
test('more than 128 clean origins survive LRU eviction and detect reloaded mapping changes', async t => {
  const api = await setup(t), origins = Array.from({ length: 140 }, (_, index) => 'many-origins-' + index);
  const binding = { recipient: 'user-file-copy', purpose: 'many-origin-copy', sourceHash: 'all-origins' };
  const copy = await api.prepareMultiSourceDisclosure({ text: 'ordinary public copy' }, origins, binding);
  copy.assert();
  await api.withPolicy(origins[0], () => api.toolResult({ password: 'reloaded private learning' }));
  assert.throws(copy.assert, /privacy.disclosure_dirty/);
});
test('unpersisted learning cannot be evicted to evade a captured mapping guard', async t => {
  const api = await setup(t), binding = { recipient: 'file', purpose: 'copy', sourceHash: 'source' };
  const copy = await api.prepareMultiSourceDisclosure('public', ['dirty-origin'], binding);
  await api.withPolicy('dirty-origin', async () => { api.active().scope.protectValue('unpersisted private value', 'CREDENTIAL'); });
  for (let i = 0; i < 140; i++) await api.withPolicy('clean-extra-' + i, async () => {});
  assert.throws(copy.assert, /privacy.disclosure_dirty/);
});
