'use strict';
// Generated runtime, real Windows DPAPI and actual chunked work-data bytes. This exercises
// foundation composition only; it is not the production migration/restore UI journey.
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-recovery-foundation-'));
const isolated = require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'active'));
for (const key of Object.keys(process.env)) if (!Object.hasOwn(isolated, key)) delete process.env[key];
Object.assign(process.env, isolated);
const { createRunner } = require('./lib/harness'), t = createRunner('WORK DATA RECOVERY FOUNDATION');
const api = require('./lib/server-internals').loadServerInternals([
  'WorkDataKeys', 'WorkDataStore', 'WorkDataRecovery', 'LocalSecretCrypto', 'atomicWriteJson', 'VERSION',
]);
const leases = [], keys = [];
let opened;
const keySet = state => {
  const value = api.WorkDataKeys.create({
    store: { read: async () => structuredClone(state), write: async () => { throw Error('unexpected active key publication'); } },
    protector: api.LocalSecretCrypto, enabled: () => { throw Error('staging must not read active policy'); },
  });
  keys.push(value); return value;
};
const binding = { purpose: 'session', schema: 2, scopeId: 'sessions', recordId: 'sess_portable_foundation',
  chunked: true, maxPlaintextBytes: 4 * 1024 * 1024 };
const store = (file, nativeKeys, enabled) => api.WorkDataStore.createText({ ...binding,
  file: () => file, keys: nativeKeys, enabled: () => enabled, writeJson: api.atomicWriteJson });

(async () => {
  if (process.platform !== 'win32') { console.log('SKIP real Windows DPAPI foundation composition'); return; }
  const active = path.join(root, 'active'), shadow = path.join(root, 'shadow');
  fs.mkdirSync(active); fs.mkdirSync(shadow);
  const configFile = path.join(active, 'config.json'), source = path.join(active, 'source.txt');
  const config = '{"configSchema":7,"workDataEncryptionV1":false}\n';
  const plain = 'PRIVATE-FOUNDATION-CONTENT\n' + '中文😀\r\n'.repeat(180000);
  fs.writeFileSync(configFile, config); fs.writeFileSync(source, plain);
  const nativeKeys = keySet(api.WorkDataKeys.empty()), staged = await nativeKeys.stageNew(); leases.push(staged.lease);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config);
  assert.equal(fs.existsSync(path.join(active, 'work-data-key-v1.json')), false);
  assert.equal(staged.lease.key.length, 32);
  t.ok(true, 'OFF setup stages a real DPAPI key without changing active config or publishing a key');

  const sealedKeys = keySet(staged.header), sealedFile = path.join(shadow, 'record.json');
  await store(sealedFile, sealedKeys, true).write(plain);
  const sealed = fs.readFileSync(sealedFile);
  assert.equal(JSON.parse(sealed.toString('utf8').split('\n')[0]).workData, 3);
  assert.equal(sealed.includes(Buffer.from('PRIVATE-FOUNDATION-CONTENT')), false);
  assert.equal(await store(sealedFile, sealedKeys, true).read(), plain);
  const password = 'synthetic foundation password only';
  const backup = await api.WorkDataRecovery.seal({ appVersion: api.VERSION, generation: 1, createdAt: new Date().toISOString(),
    directories: ['sessions'], keys: [{ id: 'work-data:current', purpose: 'work-data', instanceId: staged.header.instanceId,
      protectedKey: staged.header.protectedKey, master: staged.lease.key }],
    files: [{ path: 'sessions/record.json', data: sealed, keyRefs: ['work-data:current'] }],
  }, password);
  assert.equal(backup.includes('PRIVATE-FOUNDATION-CONTENT'), false);
  assert.equal(backup.includes(staged.lease.key.toString('base64')), false);
  t.ok(true, 'actual chunked ciphertext and its independent master round-trip through a password package');

  const restore = path.join(root, 'fresh-restore');
  await assert.rejects(api.WorkDataRecovery.open(backup, 'wrong synthetic password'), { code: 'work_data_recovery.authentication' });
  const damaged = JSON.parse(backup), cipher = Buffer.from(damaged.data, 'base64'); cipher[0] ^= 1; damaged.data = cipher.toString('base64');
  await assert.rejects(api.WorkDataRecovery.open(JSON.stringify(damaged), password), { code: 'work_data_recovery.authentication' });
  assert.equal(fs.existsSync(restore), false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config); assert.equal(fs.readFileSync(source, 'utf8'), plain);
  assert.deepEqual(fs.readFileSync(sealedFile), sealed);
  t.ok(true, 'wrong password and damaged package return no snapshot and leave all source bytes intact');

  staged.lease.release(); sealedKeys.clear();
  opened = await api.WorkDataRecovery.open(backup, password);
  const recovered = opened.snapshot.keys[0];
  const rewrapped = await nativeKeys.stageRecovered({ instanceId: recovered.instanceId, key: recovered.master }); leases.push(rewrapped.lease);
  assert.equal(rewrapped.header.instanceId, recovered.instanceId);
  assert.notEqual(rewrapped.header.protectedKey, recovered.protectedKey);
  fs.mkdirSync(path.join(restore, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(restore, 'sessions', 'record.json'), opened.snapshot.files[0].data);
  fs.writeFileSync(path.join(restore, 'work-data-key-v1.json'), JSON.stringify(rewrapped.header));
  // Fresh key cache reads only the newly wrapped DPAPI header, never the source key cache.
  const coldKeys = keySet(JSON.parse(fs.readFileSync(path.join(restore, 'work-data-key-v1.json'), 'utf8')));
  assert.equal(await store(path.join(restore, 'sessions', 'record.json'), coldKeys, true).read(), plain);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config); assert.equal(fs.readFileSync(source, 'utf8'), plain);
  t.ok(true, 'fresh native DPAPI wrapping opens the restored actual ciphertext with a cold key cache');

  const ownedMaster = recovered.master, ownedFile = opened.snapshot.files[0].data;
  opened.release(); opened.release();
  assert.ok(ownedMaster.every(byte => byte === 0)); assert.ok(ownedFile.every(byte => byte === 0));
  t.ok(true, 'returned recovery buffers release their own secret bytes without modifying source data');
})().catch(error => t.fail(error?.stack || String(error))).finally(() => {
  opened?.release(); for (const lease of leases) lease.release(); for (const key of keys) key.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-recovery-foundation-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
