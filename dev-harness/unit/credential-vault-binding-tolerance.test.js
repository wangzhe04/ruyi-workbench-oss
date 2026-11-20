'use strict';
// 150 号文 §4 P15 (3.1 phase 4): hand edits of config.json that only reorder or remove providers or toggle a
// trailing slash keep their credentials; a credential bound to a changed endpoint is withheld (not given to
// the new endpoint, not a whole-config failure) and is restored when the edit is undone. Helper timeouts and
// a blocked helper are not reported as a DPAPI unlock failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n' + constBlock(read('01k-credential-vault.js'), 'CredentialVault')
  + '\n' + constBlock(read('01l-credential-recovery.js'), 'CredentialRecovery');
const { core, vault, recovery } = vm.runInNewContext(source + '\n({core:PrivacyCore,vault:CredentialVault,recovery:CredentialRecovery})', { require, Buffer, URL, structuredClone });
const clone = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(clone(actual), clone(expected), message);
function fixture() {
  let disk, failure = null;
  const wrappingKey = crypto.randomBytes(32);
  const host = {
    core, size: async () => disk ? Buffer.byteLength(JSON.stringify(disk)) : 0,
    store: { read: async () => disk ? clone(disk) : vault.empty(), write: async value => { disk = clone(value); }, invalidate() {} },
    protector: { supported: () => true, run: async (op, value, entropy) => {
      if (failure) throw failure;
      if (op === 'protect') {
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce); cipher.setAAD(entropy);
        return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
    } },
  };
  return { api: vault.create(host), restart: () => vault.create(host), records: () => clone(disk).records.length, fail: error => { failure = error; }, install: state => { disk = clone(state); } };
}
const provider = (id, key, baseUrl) => ({ id, apiKey: key, baseUrl, extraHeaders: { 'x-api-key': key + '-header' } });
const config = () => ({ credentialEncryptionV1: true, providers: [provider('alpha', 'alpha-key', 'https://alpha.example.test/v1'), provider('beta', 'beta-key', 'https://beta.example.test/v1')] });
const keys = raw => raw.providers.map(row => [row.id, row.apiKey, row.extraHeaders?.['x-api-key'] ?? row.extraHeaders]);

test('reordering providers, removing one and toggling a trailing slash keep every credential with its own provider', async () => {
  const f = fixture(), stored = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  const swapped = clone(stored); swapped.providers.reverse();
  const reordered = await f.restart().hydrateConfig(swapped);
  same(keys(reordered.raw), [['beta', 'beta-key', 'beta-key-header'], ['alpha', 'alpha-key', 'alpha-key-header']]);
  assert.equal(reordered.needsMigration, true, 'moved credentials are rewritten at their new positions once');
  same(reordered.withheld, []);
  const removed = clone(stored); removed.providers.shift();
  const afterRemove = await f.restart().hydrateConfig(removed);
  same(keys(afterRemove.raw), [['beta', 'beta-key', 'beta-key-header']]);
  same(afterRemove.withheld, []);
  for (const edit of [url => url + '/', url => url + '//']) {
    const slashed = clone(stored); slashed.providers[1].baseUrl = edit(slashed.providers[1].baseUrl);
    const hydrated = await f.restart().hydrateConfig(slashed);
    same(keys(hydrated.raw)[1], ['beta', 'beta-key', 'beta-key-header'], 'trailing slash');
  }
  // Healing: protecting the hydrated (moved) configuration writes references at the new positions.
  const healed = JSON.parse(await f.api.protectConfig(JSON.stringify(reordered.raw)));
  same(keys((await f.restart().hydrateConfig(healed)).raw), keys(reordered.raw));
  assert.equal((await f.restart().hydrateConfig(healed)).needsMigration, false);
});

test('reordering MCP servers whose args are themselves encrypted moves every field (review 4B-S1); a lost owner is not blamed on the new occupant (4B-S2)', async () => {
  const f = fixture();
  const server = (id, secret) => ({ id, command: 'node', args: ['server.js', '--token', secret + '-arg'], env: { API_TOKEN: secret + '-env' }, cwd: '' });
  const original = { credentialEncryptionV1: true, externalMcpServers: [server('m1', 'one'), server('m2', 'two')] };
  const stored = JSON.parse(await f.api.protectConfig(JSON.stringify(original)));
  assert.equal(JSON.stringify(stored).includes('one-arg'), false);
  const swapped = clone(stored); swapped.externalMcpServers.reverse();
  const hydrated = await f.restart().hydrateConfig(swapped);
  same(hydrated.raw.externalMcpServers.map(row => [row.id, row.args, row.env]), [['m2', ['server.js', '--token', 'two-arg'], { API_TOKEN: 'two-env' }], ['m1', ['server.js', '--token', 'one-arg'], { API_TOKEN: 'one-env' }]]);
  same(hydrated.withheld, []);
  // m1 removed and m2 moved to its position: m1's values are gone, not reported against m2.
  const removed = clone(stored); removed.externalMcpServers.shift();
  const afterRemove = await f.restart().hydrateConfig(removed);
  same(afterRemove.raw.externalMcpServers.map(row => [row.id, row.env]), [['m2', { API_TOKEN: 'two-env' }]]);
  same(afterRemove.withheld, []);
  // Review 4B round 2: a secret URL and args are each part of the other's binding; they move together.
  const withUrl = id => ({ ...server(id, id), url: 'https://' + id + '.example.test/mcp?token=' + id + '-url' });
  const urlStored = JSON.parse(await f.api.protectConfig(JSON.stringify({ credentialEncryptionV1: true, externalMcpServers: [withUrl('u1'), withUrl('u2')] })));
  assert.equal(JSON.stringify(urlStored).includes('u1-url'), false);
  const urlSwapped = clone(urlStored); urlSwapped.externalMcpServers.reverse();
  const moved = await f.restart().hydrateConfig(urlSwapped);
  same(moved.raw.externalMcpServers.map(row => [row.id, row.url, row.args[2], row.env.API_TOKEN]), [['u2', 'https://u2.example.test/mcp?token=u2-url', 'u2-arg', 'u2-env'], ['u1', 'https://u1.example.test/mcp?token=u1-url', 'u1-arg', 'u1-env']]);
  same(moved.withheld, []);
});

test('a credential bound to a changed endpoint or identity is withheld, never given to the new binding, and comes back when undone', async () => {
  const f = fixture(), stored = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  const edited = clone(stored); edited.providers[0].baseUrl = 'https://attacker.example.test/v1';
  const api = f.restart(), hydrated = await api.hydrateConfig(edited);
  assert.equal(hydrated.raw.providers[0].apiKey, '', 'the old key is not carried to the new service');
  assert.equal(hydrated.raw.providers[0].extraHeaders, '');
  same(keys(hydrated.raw)[1], ['beta', 'beta-key', 'beta-key-header'], 'unrelated credentials still load');
  same(hydrated.withheld.map(row => row.pointer).sort(), ['/providers/0/apiKey', '/providers/0/extraHeaders']);
  // 4B review v2: no other credential of that position verified in place, so the owner is not claimed.
  assert.ok(hydrated.withheld.every(row => row.containerId === null));
  same(api.credentialWithheld(), hydrated.withheld);
  assert.ok(!JSON.stringify(hydrated.withheld).includes('alpha-key'));
  // An ordinary write of the hydrated configuration keeps the withheld references (slot still empty).
  const written = JSON.parse(await api.protectConfig(JSON.stringify(hydrated.raw)));
  assert.ok(written.credentialWithheldRefsV1.some(row => row.pointer === '/providers/0/apiKey'), 'kept in the withheld list, not in a slot');
  assert.ok(!written.credentialRefsV1.slots.some(row => row.pointer === '/providers/0/apiKey'));
  assert.equal(JSON.stringify(written).includes('alpha-key'), false);
  // Undoing the hand edit restores the original credential.
  written.providers[0].baseUrl = 'https://alpha.example.test/v1';
  same(keys((await f.restart().hydrateConfig(written)).raw)[0], ['alpha', 'alpha-key', 'alpha-key-header']);
  // Typing a new key replaces the withheld one; the old reference is dropped.
  const retyped = clone(hydrated.raw); retyped.providers[0].apiKey = 'replacement-key';
  const next = JSON.parse(await api.protectConfig(JSON.stringify(retyped)));
  next.providers[0].baseUrl = 'https://alpha.example.test/v1';
  const back = (await f.restart().hydrateConfig(next)).raw;
  // The key typed for the edited endpoint stays bound to it; the original key of the original endpoint returns.
  assert.equal(back.providers[0].apiKey, 'alpha-key', 'undoing the edit restores the original key even after a key was typed');
  // An id change is an identity change.
  const renamed = clone(stored); renamed.providers[0].id = 'renamed';
  const afterRename = await f.restart().hydrateConfig(renamed);
  assert.equal(afterRename.raw.providers[0].apiKey, ''); assert.equal(afterRename.withheld.length, 2);
});

test('4B review v2: after a reorder plus an endpoint edit the occupant is not blamed, and the reference survives a key typed into its old slot', async () => {
  const f = fixture();
  const cfg = { credentialEncryptionV1: true, providers: [{ id: 'alpha', apiKey: 'alpha-key', baseUrl: 'https://alpha.example.test/v1' }, { id: 'gamma', apiKey: '', baseUrl: 'https://gamma.example.test/v1' }] };
  const stored = JSON.parse(await f.api.protectConfig(JSON.stringify(cfg)));
  const edited = clone(stored); edited.providers.reverse(); edited.providers[1].baseUrl = 'https://proxy.example.test/v1';
  const api = f.restart(), hydrated = await api.hydrateConfig(edited);
  same(hydrated.raw.providers.map(row => [row.id, row.apiKey]), [['gamma', ''], ['alpha', '']]);
  same(hydrated.withheld, [{ pointer: '/providers/0/apiKey', containerId: null }], 'gamma is not named as the owner');
  const saved = JSON.parse(await api.protectConfig(JSON.stringify(hydrated.raw)));
  same(saved.credentialWithheldRefsV1.map(row => row.pointer), ['/providers/0/apiKey']);
  // Reverting alpha's URL restores alpha's key at alpha's new position.
  const reverted = clone(saved); reverted.providers[1].baseUrl = 'https://alpha.example.test/v1';
  const back = await f.restart().hydrateConfig(reverted);
  same(back.raw.providers.map(row => [row.id, row.apiKey]), [['gamma', ''], ['alpha', 'alpha-key']]); same(back.withheld, []);
  // Following the notice and typing a key for gamma does not destroy alpha's reference.
  const other = f.restart(), again = await other.hydrateConfig(clone(saved));
  again.raw.providers[0].apiKey = 'gamma-key';
  const typed = JSON.parse(await other.protectConfig(JSON.stringify(again.raw)));
  same((await f.restart().hydrateConfig(clone(typed))).withheld, [], 'a value typed in the old slot hides the notice');
  const typedReverted = clone(typed); typedReverted.providers[1].baseUrl = 'https://alpha.example.test/v1';
  same((await f.restart().hydrateConfig(typedReverted)).raw.providers.map(row => [row.id, row.apiKey]), [['gamma', 'gamma-key'], ['alpha', 'alpha-key']]);
  // A sibling credential verified in place is the proof that names the owner.
  const two = { credentialEncryptionV1: true, providers: [{ id: 'delta', apiKey: 'delta-key', baseUrl: 'https://delta.example.test/v1', extraHeaders: { 'x-k': 'h' } }] };
  const twoStored = JSON.parse(await f.api.protectConfig(JSON.stringify(two)));
  const headersRef = twoStored.credentialRefsV1.slots.find(row => row.pointer.endsWith('/extraHeaders'));
  const withOld = clone(twoStored); withOld.credentialWithheldRefsV1 = [{ pointer: '/providers/0/apiKey', id: headersRef.id }];
  assert.ok((await f.restart().hydrateConfig(withOld)).raw.providers[0].apiKey === 'delta-key', 'a kept reference never overrides a live one');
});

test('4B review v3: a withheld reference retires with its deleted provider and survives a backup round trip', async () => {
  const f = fixture(), A = 'https://alpha.example.test/v1', X = 'https://proxy.example.test/v1';
  const cfg = { credentialEncryptionV1: true, providers: [{ id: 'alpha', apiKey: 'alpha-key', baseUrl: A }, { id: 'gamma', apiKey: 'gamma-key', baseUrl: 'https://gamma.example.test/v1' }] };
  const stored = JSON.parse(await f.api.protectConfig(JSON.stringify(cfg)));
  const edited = clone(stored); edited.providers[0].baseUrl = X;
  let api = f.restart(); const hydrated = await api.hydrateConfig(edited);
  same(hydrated.withheld.map(row => row.pointer), ['/providers/0/apiKey']);
  const saved = JSON.parse(await api.protectConfig(JSON.stringify(hydrated.raw)));
  same(saved.credentialWithheldRefsV1.map(row => [row.pointer, row.ownerId]), [['/providers/0/apiKey', 'alpha']]);
  // Deleting alpha retires its withheld key; re-adding alpha with the original URL starts without a key.
  api = f.restart(); const again = await api.hydrateConfig(clone(saved)); again.raw.providers.shift();
  const deleted = JSON.parse(await api.protectConfig(JSON.stringify(again.raw)));
  assert.equal(deleted.credentialWithheldRefsV1, undefined);
  const readded = clone(deleted); readded.providers.push({ id: 'alpha', apiKey: '', baseUrl: A });
  same((await f.restart().hydrateConfig(readded)).raw.providers.map(row => [row.id, row.apiKey]), [['gamma', 'gamma-key'], ['alpha', '']]);
  // A credential package carries the withheld record; after a restore, undoing the edit still brings it back.
  const password = 'fixture-long-backup-password';
  const backup = await f.restart().exportBackup(JSON.stringify(saved), password);
  assert.equal(backup.includes('alpha-key'), false);
  const other = fixture(), imported = await other.restart().prepareImport(backup, password);
  other.install(imported.state);
  const restoredConfig = JSON.parse(imported.config);
  same(restoredConfig.credentialWithheldRefsV1.map(row => row.pointer), ['/providers/0/apiKey']);
  const stillWithheld = await other.restart().hydrateConfig(clone(restoredConfig));
  same(stillWithheld.raw.providers.map(row => [row.id, row.apiKey]), [['alpha', ''], ['gamma', 'gamma-key']]);
  const undone = clone(restoredConfig); undone.providers[0].baseUrl = A;
  same((await other.restart().hydrateConfig(undone)).raw.providers.map(row => [row.id, row.apiKey]), [['alpha', 'alpha-key'], ['gamma', 'gamma-key']]);
});

test('swapping reference ids, a typed value over a reference and tampering still fail or withhold as before', async () => {
  const f = fixture(), stored = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  const swapped = clone(stored); swapped.credentialRefsV1.slots[0].id = swapped.credentialRefsV1.slots[1].id;
  const hydrated = await f.restart().hydrateConfig(swapped);
  assert.equal(hydrated.raw.providers[0].apiKey, '', 'a record cannot be moved to another field');
  const injected = clone(stored); injected.providers[0].apiKey = 'injected';
  await assert.rejects(f.restart().hydrateConfig(injected), error => error.code === 'credential_vault.reference_collision');
  const missing = clone(stored); missing.credentialRefsV1.slots[0].id = 'a'.repeat(32);
  await assert.rejects(f.restart().hydrateConfig(missing), error => error.code === 'credential_vault.reference_missing');
});

test('a helper timeout or a blocked helper is not a DPAPI verdict and its guidance never asks for a new data root', async () => {
  const f = fixture(), stored = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  const cases = [
    [Object.assign(new Error('x'), { code: 'local_crypto.process_timeout', helperMayStillRun: true }), 'credential_vault.unlock_timeout'],
    [Object.assign(new Error('x'), { code: 'local_crypto.helper_blocked' }), 'credential_vault.helper_unavailable'],
    [Object.assign(new Error('x'), { code: 'local_crypto.process_failed' }), 'credential_vault.helper_unavailable'],
    [Object.assign(new Error('x'), { code: 'local_crypto.decrypt_failed' }), 'credential_vault.unlock_failed'],
    [new Error('generic'), 'credential_vault.unlock_failed'],
  ];
  for (const [failure, code] of cases) {
    f.fail(failure);
    await assert.rejects(f.restart().hydrateConfig(stored), error => {
      assert.equal(error.code, code);
      if (failure.helperMayStillRun) assert.equal(error.helperMayStillRun, true, 'the uncertain-helper marker survives');
      const guidance = recovery.startupGuidance(error);
      assert.ok(guidance.includes(code), code);
      assert.equal(guidance.includes('RUYI_HOME'), code === 'credential_vault.unlock_failed', 'only a real DPAPI failure mentions a separate data root');
      return true;
    });
  }
  f.fail(null);
  same(keys((await f.restart().hydrateConfig(stored)).raw)[0], ['alpha', 'alpha-key', 'alpha-key-header']);
});
