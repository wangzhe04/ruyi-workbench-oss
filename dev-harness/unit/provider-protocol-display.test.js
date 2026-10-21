'use strict';
// Actual pure presentation helper and existing registry: no app, accounts or DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/provider-api-styles.js')).href);
test('current endpoint display follows all registered protocols without claiming a model vendor or mutating routes', async () => {
  const { providerDisplayLabel, PROVIDER_API_STYLES } = await load();
  for (const [apiStyle, meta] of Object.entries(PROVIDER_API_STYLES)) {
    const provider = { id: 'gateway', label: 'Configured Gateway', apiStyle, model: 'user-entered-model', baseUrl: 'https://synthetic.invalid' };
    const before = structuredClone(provider), calls = [];
    const label = providerDisplayLabel(provider, key => { calls.push(key); return 'protocol:' + key; });
    assert.equal(label, 'Configured Gateway · protocol:' + meta.labelKey);
    assert.deepEqual(calls, [meta.labelKey]); assert.deepEqual(provider, before);
    assert.ok(!label.includes(provider.model)); assert.ok(!label.includes(provider.baseUrl));
  }
});
test('known configured endpoint defaults through the registry; absent endpoint identity never invents a protocol', async () => {
  const { providerDisplayLabel, providerApiStyleMeta, isProviderApiStyle } = await load();
  const translate = key => key;
  assert.equal(providerDisplayLabel({ id: 'legacy' }, translate), 'legacy · ' + providerApiStyleMeta(undefined).labelKey);
  assert.equal(providerDisplayLabel({ id: 'legacy', apiStyle: 'unregistered' }, translate), 'legacy · ' + providerApiStyleMeta('unregistered').labelKey);
  for (const provider of [undefined, null, '', {}]) assert.equal(providerDisplayLabel(provider, () => { throw Error('Unknown endpoint must not infer protocol'); }), '');
  for (const style of ['chat', 'responses', 'anthropic']) assert.equal(isProviderApiStyle(style), true);
  for (const style of [undefined, null, '', 'future', 'constructor', 'toString', {}, 3]) assert.equal(isProviderApiStyle(style), false);
});
