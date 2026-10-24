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
  'WorkDataKeys', 'WorkDataStore', 'WorkDataRecovery', 'WorkDataManifest', 'WorkDataMigrationCodecs', 'CredentialVault', 'PrivacyCore', 'LocalSecretCrypto', 'atomicWriteJson', 'VERSION',
]);
const leases = [], keys = [];
const vaults = [];
let opened;
const vaultAt = file => {
  const value = api.CredentialVault.create({ core: api.PrivacyCore, protector: api.LocalSecretCrypto,
    size: async () => { try { return fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } },
    store: {
      read: async () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return api.CredentialVault.empty(); throw error; } },
      write: value => api.atomicWriteJson(file, value), invalidate() {},
    },
  });
  vaults.push(value); return value;
};
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
  const vaultFile = path.join(active, 'credential-vault-v1.json'), sourceVault = vaultAt(vaultFile);
  const credentials = secret => JSON.stringify({ credentialEncryptionV1: true,
    providers: [{ id: 'synthetic', baseUrl: 'https://fixture.invalid', apiKey: secret }] });
  const oldConfig = await sourceVault.protectConfig(credentials('SYNTHETIC-OLD-CREDENTIAL'));
  const currentConfig = await sourceVault.protectConfig(credentials('SYNTHETIC-CURRENT-CREDENTIAL'));
  const privateLocal = await sourceVault.sealLocal('SYNTHETIC-PRIVACY-REFERENCE-CONTENT', 'privacy-scope', 'scope_portable_foundation');
  const vaultSnapshot = await sourceVault.snapshotForWorkDataRecovery(); leases.push(vaultSnapshot.lease);
  const vaultBytes = fs.readFileSync(vaultFile);
  assert.equal(vaultSnapshot.state.records.length, 2);
  assert.notDeepEqual(vaultSnapshot.lease.key, staged.lease.key);
  t.ok(true, 'actual native credential snapshot retains historical records and a credential/privacy master independent of work data');
  const password = 'synthetic foundation password only';
  const backup = await api.WorkDataRecovery.seal({ appVersion: api.VERSION, generation: 1, createdAt: new Date().toISOString(),
    directories: ['sessions', 'privacy-scopes'], keys: [{ id: 'work-data:current', purpose: 'work-data', instanceId: staged.header.instanceId,
      protectedKey: staged.header.protectedKey, master: staged.lease.key },
    { id: 'credential:current', purpose: 'credential', instanceId: vaultSnapshot.state.instanceId,
      protectedKey: vaultSnapshot.state.protectedKey, master: vaultSnapshot.lease.key }],
    files: [{ path: 'sessions/record.json', data: sealed, keyRefs: ['work-data:current'] },
      { path: 'credential-vault-v1.json', data: vaultBytes, keyRefs: ['credential:current'] },
      { path: 'config.json', data: Buffer.from(currentConfig), keyRefs: ['credential:current'] },
      { path: 'config.json.prev', data: Buffer.from(oldConfig), keyRefs: ['credential:current'] },
      { path: 'privacy-scopes/scope.json', data: Buffer.from(JSON.stringify(privateLocal)), keyRefs: ['credential:current'] }],
  }, password);
  assert.equal(backup.includes('PRIVATE-FOUNDATION-CONTENT'), false);
  assert.equal(backup.includes(staged.lease.key.toString('base64')), false);
  assert.equal(backup.includes(vaultSnapshot.lease.key.toString('base64')), false);
  assert.equal(backup.includes('SYNTHETIC-CURRENT-CREDENTIAL'), false);
  t.ok(true, 'actual chunked ciphertext and its independent master round-trip through a password package');

  const restore = path.join(root, 'fresh-restore');
  await assert.rejects(api.WorkDataRecovery.open(backup, 'wrong synthetic password'), { code: 'work_data_recovery.authentication' });
  const damaged = JSON.parse(backup), cipher = Buffer.from(damaged.data, 'base64'); cipher[0] ^= 1; damaged.data = cipher.toString('base64');
  await assert.rejects(api.WorkDataRecovery.open(JSON.stringify(damaged), password), { code: 'work_data_recovery.authentication' });
  assert.equal(fs.existsSync(restore), false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config); assert.equal(fs.readFileSync(source, 'utf8'), plain);
  assert.deepEqual(fs.readFileSync(sealedFile), sealed);
  assert.deepEqual(fs.readFileSync(vaultFile), vaultBytes);
  t.ok(true, 'wrong password and damaged package return no snapshot and leave all source bytes intact');

  staged.lease.release(); sealedKeys.clear(); vaultSnapshot.lease.release(); sourceVault.clear();
  opened = await api.WorkDataRecovery.open(backup, password);
  const recovered = opened.snapshot.keys[0];
  const rewrapped = await nativeKeys.stageRecovered({ instanceId: recovered.instanceId, key: recovered.master }); leases.push(rewrapped.lease);
  assert.equal(rewrapped.header.instanceId, recovered.instanceId);
  assert.notEqual(rewrapped.header.protectedKey, recovered.protectedKey);
  const portableVault = opened.snapshot.keys.find(key => key.purpose === 'credential');
  const vaultState = JSON.parse(opened.snapshot.files.find(file => file.path === 'credential-vault-v1.json').data.toString('utf8'));
  const targetVault = vaultAt(path.join(restore, 'credential-vault-v1.json'));
  const credentialStage = await targetVault.stageRecoveredForWorkData({ state: vaultState, key: portableVault.master }); leases.push(credentialStage.lease);
  assert.equal(fs.existsSync(restore), false);
  for (const dir of opened.snapshot.directories) fs.mkdirSync(path.join(restore, dir), { recursive: true });
  for (const file of opened.snapshot.files) fs.writeFileSync(path.join(restore, file.path), file.data);
  fs.writeFileSync(path.join(restore, 'credential-vault-v1.json'), JSON.stringify(credentialStage.state));
  fs.writeFileSync(path.join(restore, 'work-data-key-v1.json'), JSON.stringify(rewrapped.header));
  // Fresh key cache reads only the newly wrapped DPAPI header, never the source key cache.
  const coldKeys = keySet(JSON.parse(fs.readFileSync(path.join(restore, 'work-data-key-v1.json'), 'utf8')));
  assert.equal(await store(path.join(restore, 'sessions', 'record.json'), coldKeys, true).read(), plain);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config); assert.equal(fs.readFileSync(source, 'utf8'), plain);
  t.ok(true, 'fresh native DPAPI wrapping opens the restored actual ciphertext with a cold key cache');

  const current = await targetVault.hydrateConfig(JSON.parse(fs.readFileSync(path.join(restore, 'config.json'), 'utf8')));
  const old = await targetVault.hydrateConfig(JSON.parse(fs.readFileSync(path.join(restore, 'config.json.prev'), 'utf8')));
  assert.equal(current.raw.providers[0].apiKey, 'SYNTHETIC-CURRENT-CREDENTIAL');
  assert.equal(old.raw.providers[0].apiKey, 'SYNTHETIC-OLD-CREDENTIAL');
  assert.equal(await targetVault.openLocal(JSON.parse(fs.readFileSync(path.join(restore, 'privacy-scopes/scope.json'), 'utf8')),
    'privacy-scope', 'scope_portable_foundation'), 'SYNTHETIC-PRIVACY-REFERENCE-CONTENT');
  assert.notEqual(credentialStage.state.protectedKey, portableVault.protectedKey);
  assert.deepEqual(fs.readFileSync(vaultFile), vaultBytes);
  t.ok(true, 'cold native credential wrapping hydrates current and historical configs plus the original privacy mapping');

  const ownedMaster = recovered.master, ownedFile = opened.snapshot.files[0].data;
  opened.release(); opened.release();
  assert.ok(ownedMaster.every(byte => byte === 0)); assert.ok(ownedFile.every(byte => byte === 0));
  assert.ok(portableVault.master.every(byte => byte === 0));
  t.ok(true, 'returned recovery buffers release their own secret bytes without modifying source data');

  // This checks authority IO only: neither pointer mode change below is a full data migration.
  const authorityRoot = path.join(root, 'authority'), pointerFile = path.join(authorityRoot, '.work-data', 'active-v1.json');
  fs.mkdirSync(authorityRoot);
  const authority = api.WorkDataManifest.create({ base: authorityRoot });
  const original = await authority.readActive(), encryptedRoot = await authority.prepare({ expected: original, mode: 'encrypted' });
  assert.equal((await authority.readActive()).generation, 0);
  const firstAuthority = await authority.commit({ expected: original, candidate: encryptedRoot });
  assert.equal(firstAuthority.generation, 1); assert.equal(firstAuthority.mode, 'encrypted');
  assert.equal((await api.WorkDataManifest.create({ base: authorityRoot }).readActive()).proof.raw, firstAuthority.proof.raw);
  t.ok(true, 'actual default Windows publisher durably selects a prepared manifest and a fresh reader finds that exact authority');
  const plainRoot = await authority.prepare({ expected: firstAuthority, mode: 'plain' }), heldReader = fs.openSync(pointerFile, 'r');
  try {
    await assert.rejects(authority.commit({ expected: firstAuthority, candidate: plainRoot }),
      error => error.code === 'work_data_manifest.publisher_occupied' && error.commitUncertain === true && error.helperMayStillRun === false);
    assert.equal((await authority.readActive()).proof.raw, firstAuthority.proof.raw);
  } finally { fs.closeSync(heldReader); }
  const nextAuthority = await authority.commit({ expected: firstAuthority, candidate: plainRoot });
  assert.equal(nextAuthority.generation, 2); assert.equal(nextAuthority.mode, 'plain');
  assert.ok(fs.statSync(firstAuthority.root).isDirectory()); assert.ok(fs.statSync(nextAuthority.root).isDirectory());
  t.ok(true, 'an occupied actual manifest preserves old authority; explicit retry after close replaces it and retains both roots');

  const bridgeSource = path.join(root, 'bridge-source'), bridgeEncrypted = path.join(root, 'bridge-encrypted'), bridgePlain = path.join(root, 'bridge-plain');
  for (const directory of [bridgeSource, bridgeEncrypted, bridgePlain]) fs.mkdirSync(directory);
  const samples = new Map([
    ['memory/global/portable_note.md', Buffer.from('# 原始 Markdown\r\n' + '中文😀\r\n'.repeat(180000))],
    ['sessions/sess_bridge.messages.ndjson', Buffer.from('{"role":"user","content":"raw user"}\r\n{"role":"assistant","content":"raw assistant"}\n')],
    ['steward/inbox-v1.ndjson', Buffer.from('{"id":"synthetic_inbox","content":"raw inbox"}\n')],
    ['skills/Tool_One/.ruyi-import.json', Buffer.from('{ "id": "Tool_One", "unknown": 9007199254740993 }\r\n')],
  ]);
  const encryptBridge = api.WorkDataMigrationCodecs.create({ sourceRoot: bridgeSource, targetRoot: bridgeEncrypted,
    targetKeys: coldKeys, writeJson: api.atomicWriteJson, maxLogicalBytes: 4 * 1024 * 1024 });
  const decryptBridge = api.WorkDataMigrationCodecs.create({ sourceRoot: bridgeEncrypted, targetRoot: bridgePlain,
    sourceKeys: coldKeys, writeJson: api.atomicWriteJson, maxLogicalBytes: 4 * 1024 * 1024 });
  for (const [relative, bytes] of samples) {
    const sourceFile = path.join(bridgeSource, relative); fs.mkdirSync(path.dirname(sourceFile), { recursive: true }); fs.writeFileSync(sourceFile, bytes);
    const encryptedResult = await encryptBridge.transform({ relative, targetMode: 'encrypted' });
    const plainResult = await decryptBridge.transform({ relative, targetMode: 'plain' });
    assert.equal(encryptedResult.domainValidation, 'host-owner-required'); assert.equal(plainResult.logicalHash, encryptedResult.logicalHash);
    assert.deepEqual(fs.readFileSync(sourceFile), bytes); assert.deepEqual(fs.readFileSync(path.join(bridgePlain, relative)), bytes);
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), config);
  t.ok(true, 'real native-key codec bridge preserves raw Markdown, record rows and mixed-case skill bytes through a new shadow and reverse conversion');
})().catch(error => t.fail(error?.stack || String(error))).finally(() => {
  opened?.release(); for (const lease of leases) lease.release(); for (const key of keys) key.clear(); for (const vault of vaults) vault.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-recovery-foundation-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});
