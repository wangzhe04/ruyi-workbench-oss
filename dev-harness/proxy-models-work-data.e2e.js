'use strict';
require('./lib/self-isolate-home');
// Real local model discovery/cache and Windows DPAPI, synthetic account metadata only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { startFakeProvider } = require('./lib/fake-openai-provider');
const t = createRunner('PROXY MODELS WORK DATA');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-proxy-models-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const api = require('./lib/server-internals').loadServerInternals(['getProxyModelsCache', 'setProxyModelsCache', 'offlineModelList', 'discoverModels', 'buildModelHint', 'tierModelForNode', 'readConfig', 'writeConfig', 'workDataKeys', 'paths']);
const file = path.join(api.paths.data, 'proxy-models-cache.json');
const bytes = () => fs.readFileSync(file, 'utf8');
const privateError = error => String(error?.code || '').startsWith('work_data');
const setSwitch = async enabled => { const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config); };
let fake;
(async () => {
  await setSwitch(false); await api.setProxyModelsCache([{ id: 'legacy-private-model', label: 'Legacy' }]);
  t.ok(bytes() === JSON.stringify(JSON.parse(bytes()), null, 2), 'OFF writes the same pretty JSON bytes');
  const old = bytes(); await api.setProxyModelsCache([{ id: 'legacy-private-model', label: 'Legacy' }]);
  t.ok(bytes() === old, 'identical model contents do not change the timestamp or disk bytes');
  fs.writeFileSync(file, JSON.stringify({ at: 'manual', models: [{ id: 'replacement-id' }] }));
  t.ok((await api.getProxyModelsCache()).models[0].id === 'replacement-id', 'a replaced plain file invalidates the process memo');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI: Windows only; source units cover crypto/authority'); return; }
  await setSwitch(true); await api.workDataKeys.ensure(); const before = bytes();
  await api.getProxyModelsCache(); t.ok(bytes() === before, 'reading old plaintext under ON performs no implicit migration');
  fake = await startFakeProvider({ models: ['PRIVATE_ACCOUNT_MODEL'], handler: () => { throw new Error('unexpected model invocation'); } });
  const config = { ...await api.readConfig(), modelsApiBase: 'http://127.0.0.1:' + fake.port, modelsApiKey: 'synthetic-local-only' };
  const discovered = await api.discoverModels(config), sealed = bytes(), header = JSON.parse(sealed.split('\n')[0]);
  t.ok(discovered.proxyCount === 1 && header.workData === 3 && header.purpose === 'cache' && header.manifest.purpose === 'cache' && !sealed.includes('PRIVATE_ACCOUNT_MODEL'), 'real local discovery seals complete metadata under purpose cache');
  t.ok((await api.offlineModelList(config)).some(model => model.id === 'PRIVATE_ACCOUNT_MODEL'), 'offline consumers await and restore the encrypted list');
  await api.getProxyModelsCache(); await api.getProxyModelsCache();
  const keyFile = path.join(api.paths.data, 'work-data-key-v1.json'); api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.getProxyModelsCache(), privateError);
    await assert.rejects(() => api.setProxyModelsCache([{ id: 'would-overwrite' }]), privateError);
    await assert.rejects(() => api.discoverModels(config), privateError);
    t.ok(bytes() === sealed, 'warm memo and successful live refetch cannot bypass a missing key or overwrite old ciphertext');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); api.workDataKeys.clear(); }
  fs.writeFileSync(file, sealed.slice(0, -10)); const broken = bytes();
  await assert.rejects(() => api.getProxyModelsCache(), privateError); await assert.rejects(() => api.setProxyModelsCache([{ id: 'erase-bad' }]), privateError);
  t.ok(bytes() === broken, 'bad authenticated storage never becomes a writable empty model cache');
  fs.writeFileSync(file, sealed); await setSwitch(false);
  t.ok((await api.getProxyModelsCache()).models[0].id === 'PRIVATE_ACCOUNT_MODEL', 'sealed data remains readable after disabling encryption');
  await assert.rejects(() => api.setProxyModelsCache([{ id: 'plaintext-downgrade' }]), privateError);
  t.ok(bytes() === sealed, 'OFF cannot downgrade an existing sealed model cache');
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  if (fake) { await fake.close(); assert.deepEqual(fake.errors, []); } api.workDataKeys.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-proxy-models-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
