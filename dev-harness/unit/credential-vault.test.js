'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n' + constBlock(read('01k-credential-vault.js'), 'CredentialVault');
const { core, vault, catalog } = vm.runInNewContext(source + '\n({core:PrivacyCore,vault:CredentialVault,catalog:PrivacyRuleCatalog})', { require, Buffer, URL, structuredClone });
const clone = value => JSON.parse(JSON.stringify(value));
const fails = (fn, suffix) => assert.rejects(fn, error => error.code === 'credential_vault.' + suffix);
function fixture() {
  let disk, readFail = false, writeFail = false, unlockFail = false, supported = true, wraps = 0;
  const wrappingKey = crypto.randomBytes(32), backups = new Map();
  const host = {
    core, supportedDefault: () => true, size: async () => disk ? Buffer.byteLength(JSON.stringify(disk)) : 0,
    store: { read: async () => { if (readFail) throw Error('private failure'); return disk ? clone(disk) : vault.empty(); },
      write: async value => { if (writeFail) throw Error('private failure'); disk = clone(value); }, invalidate() {} },
    protector: { supported: () => supported, run: async (op, value, entropy) => {
      wraps++; if (unlockFail) throw Error('private failure');
      if (op === 'protect') {
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce); cipher.setAAD(entropy);
        return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
    } },
    backups: { list: async () => [...backups.keys()], read: async name => backups.get(name), write: async (name, value) => { if (writeFail) throw Error('backup failure'); backups.set(name, value); } },
  };
  return { api: vault.create(host), restart: () => vault.create(host), backups, raw: () => clone(disk),
    modify: fn => { fn(disk); }, install: state => { disk = clone(state); }, diskExists: () => !!disk, wraps: () => wraps,
    failRead: value => { readFail = value; }, failWrite: value => { writeFail = value; }, failUnlock: value => { unlockFail = value; }, unsupported: () => { supported = false; } };
}
const config = (patch = {}) => ({ credentialEncryptionV1: true, providers: [{ id: 'test-provider', apiKey: 'fixture-api-key', baseUrl: 'https://example.test/v1', extraHeaders: { 'x-api-key': 'fixture-header' } }], ...patch });
test('immutable encrypted references hydrate exact values; same credentials deduplicate and new processes unwrap the master', async () => {
  const f = fixture(), original = config();
  const encoded = await f.api.protectConfig(JSON.stringify(original)), raw = JSON.parse(encoded);
  assert.equal(raw.providers[0].apiKey, ''); assert.equal(raw.providers[0].extraHeaders, '');
  assert.equal(raw.credentialRefsV1.slots.length, 2);
  for (const value of ['fixture-api-key', 'fixture-header']) { assert.equal(encoded.includes(value), false); assert.equal(JSON.stringify(f.raw()).includes(value), false); }
  const hydrated = (await f.api.hydrateConfig(raw)).raw;
  assert.deepEqual(clone(hydrated.providers), original.providers);
  assert.equal(hydrated.credentialRefsV1, undefined);
  assert.equal(await f.api.protectConfig(encoded), encoded);
  assert.equal(f.raw().records.length, 2); assert.equal(f.wraps(), 1);
  assert.deepEqual(clone((await f.restart().hydrateConfig(raw)).raw.providers), original.providers);
  assert.equal(f.wraps(), 2);
});
test('configuration target/identity changes and swapping a referenced id cannot reuse a credential', async () => {
  const f = fixture(), raw = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  for (const mutate of [r => { r.providers[0].baseUrl = 'https://other.test/v1'; }, r => { r.providers[0].id = 'different'; },
    r => { r.credentialRefsV1.slots[0].id = r.credentialRefsV1.slots[1].id; }]) {
    const attempt = clone(raw); mutate(attempt); await fails(() => f.api.hydrateConfig(attempt), 'binding_mismatch');
  }
  const attempt = clone(raw); attempt.providers[0].apiKey = 'injected';
  await fails(() => f.api.hydrateConfig(attempt), 'reference_collision');
});
test('previous immutable credentials remain recoverable after a key change; no eviction or late-write overwrite', async () => {
  const f = fixture(), old = JSON.parse(await f.api.protectConfig(JSON.stringify(config())));
  const next = config(); next.providers[0].apiKey = 'replacement-key';
  const current = JSON.parse(await f.api.protectConfig(JSON.stringify(next)));
  assert.equal((await f.api.hydrateConfig(old)).raw.providers[0].apiKey, 'fixture-api-key');
  assert.equal((await f.api.hydrateConfig(current)).raw.providers[0].apiKey, 'replacement-key');
  const refs = await Promise.all(Array.from({ length: 8 }, () => f.api.protectConfig(JSON.stringify(next))));
  assert.equal(new Set(refs).size, 1); assert.equal(f.raw().records.length, 3);
});
test('secret-bearing endpoint URLs, MCP env/args/headers and search/CLI credentials are stored without plaintext', async () => {
  const f = fixture(), original = config({ modelsApiKey: 'fixture-cli', modelsApiBase: 'https://example.test/?api_key=fixture-query',
    searchBackend: { apiKey: 'fixture-search', baseUrl: 'https://example.test/search' },
    externalMcpServers: [{ id: 'mcp-test', command: 'fixture.exe', args: ['--token', 'fixture-arg'], env: { TOKEN: 'fixture-env' }, headers: { Authorization: 'fixture-mcp' } }] });
  original.providers[0].baseUrl = 'https://tester:fixture-pass@example.test/v1';
  original.providers[0].extraBaseUrls = ['https://example.test/?token=fixture-extra'];
  const encoded = await f.api.protectConfig(JSON.stringify(original));
  for (const value of ['fixture-cli', 'fixture-query', 'fixture-search', 'fixture-arg', 'fixture-env', 'fixture-mcp', 'fixture-pass', 'fixture-extra']) assert.equal(encoded.includes(value), false, value);
  const restored = clone((await f.api.hydrateConfig(JSON.parse(encoded))).raw);
  for (const key of ['providers', 'modelsApiKey', 'modelsApiBase', 'searchBackend', 'externalMcpServers']) assert.deepEqual(restored[key], original[key]);
});
test('corrupt storage, write failure, unsupported platform and unwrap failure never return plaintext or reset the vault', async () => {
  const f = fixture(); f.failWrite(true); await fails(() => f.api.protectConfig(JSON.stringify(config())), 'storage_unavailable'); assert.equal(f.diskExists(), false);
  f.failWrite(false); const encoded = await f.api.protectConfig(JSON.stringify(config()));
  f.failRead(true); await fails(() => f.api.hydrateConfig(JSON.parse(encoded)), 'storage_unavailable'); f.failRead(false);
  f.failUnlock(true); await fails(() => f.restart().hydrateConfig(JSON.parse(encoded)), 'unlock_failed'); f.failUnlock(false);
  f.modify(state => { state.schema = 99; }); await fails(() => f.api.protectConfig(JSON.stringify(config())), 'storage_unavailable');
  const unsupported = fixture(); unsupported.unsupported(); await fails(() => unsupported.api.protectConfig(JSON.stringify(config())), 'unsupported'); assert.equal(unsupported.diskExists(), false);
});
test('tampered ciphertext fails on read and on record reuse rather than emitting a broken reference', async () => {
  const f = fixture(), encoded = await f.api.protectConfig(JSON.stringify(config()));
  f.modify(state => { const row = state.records[0]; const bytes = Buffer.from(row.envelope.tag, 'base64'); bytes[0] ^= 1; row.envelope.tag = bytes.toString('base64'); });
  await fails(() => f.api.hydrateConfig(JSON.parse(encoded)), 'decrypt_failed');
  await fails(() => f.api.protectConfig(JSON.stringify(config())), 'integrity_failed');
});
test('no-secret reads create nothing; legacy disable works only before encrypted data exists', async () => {
  const f = fixture(); assert.equal((await f.api.hydrateConfig({})).needsMigration, false); assert.equal(f.diskExists(), false);
  const legacy = config({ credentialEncryptionV1: false });
  assert.ok((await f.api.protectConfig(JSON.stringify(legacy))).includes('fixture-api-key')); assert.equal(f.diskExists(), false);
  await f.api.protectConfig(JSON.stringify(config()));
  await fails(() => f.api.protectConfig(JSON.stringify(legacy)), 'disable_requires_migration');
});

test('credentials without explicit encryption remain plaintext without initializing a vault, even on supported hosts', async () => {
  const f = fixture(), original = config(); delete original.credentialEncryptionV1;
  assert.equal((await f.api.hydrateConfig(original)).needsMigration, false);
  const serialized = await f.api.protectConfig(JSON.stringify(original));
  assert.deepEqual(JSON.parse(serialized), original); assert.equal(f.diskExists(), false); assert.equal(f.wraps(), 0);
  await f.api.migrateBackups(serialized); assert.equal(f.diskExists(), false);
});

test('host-authorized plaintext migration retains old encrypted references and cannot implicitly downgrade referenced input', async () => {
  const f = fixture(), encoded = await f.api.protectConfig(JSON.stringify(config()));
  const before = f.raw(), legacy = config({ credentialEncryptionV1: false });
  const plain = await f.api.protectConfig(JSON.stringify(legacy), { allowPlaintext: true });
  assert.equal(JSON.parse(plain).credentialEncryptionV1, false); assert.ok(plain.includes('fixture-api-key'));
  assert.deepEqual(f.raw(), before);
  const disguised = JSON.parse(encoded); disguised.credentialEncryptionV1 = false;
  const retained = JSON.parse(await f.api.protectConfig(JSON.stringify(disguised), { allowPlaintext: true }));
  assert.equal(retained.credentialEncryptionV1, true); assert.ok(retained.credentialRefsV1);
  assert.deepEqual(clone((await f.restart().hydrateConfig(JSON.parse(encoded))).raw.providers), config().providers);
});
test('known backups migrate without losing recovery values; malformed backups are authenticated whole-file envelopes', async () => {
  const f = fixture(), next = await f.api.protectConfig(JSON.stringify(config()));
  f.backups.set('config.json.prev', JSON.stringify(config())); f.backups.set('config.json.corrupt', '{"apiKey":"fixture-broken');
  await f.api.migrateBackups(next);
  for (const serialized of f.backups.values()) { assert.equal(serialized.includes('fixture-api-key'), false); assert.equal(serialized.includes('fixture-broken'), false); }
  assert.equal((await f.api.hydrateConfig(JSON.parse(f.backups.get('config.json.prev')))).raw.providers[0].apiKey, 'fixture-api-key');
  assert.equal(JSON.parse(f.backups.get('config.json.corrupt')).ruyiEncryptedBackupV1, 1);
  const snapshot = [...f.backups.values()]; await f.api.migrateBackups(next); assert.deepEqual([...f.backups.values()], snapshot);
});
test('catalog metadata and rule profiles distinguish credentials, personal information and optional technical privacy', () => {
  assert.ok(catalog.list().length >= 40);
  const detect = (value, options = {}, context = {}) => core.createDetector(options).detect(value, context);
  const samples = ['glpat-' + 'x'.repeat(24), 'hf_' + 'x'.repeat(32), 'AIza' + 'x'.repeat(35), '密码恢复码: ignore\n恢复码: SYNTHETIC-CODE',
    '<password>fixture-password</password>', 'redis://:fixture-redis@example.test', 'CVV: 123'];
  for (const value of samples) assert.ok(detect(value).length, value);
  assert.equal(detect('姓名: 测试甲').length, 0); assert.ok(detect('姓名: 测试甲', { personal: true }).length);
  assert.equal(detect('192.168.1.8').length, 0); assert.ok(detect('192.168.1.8', { technical: true }).length);
  assert.equal(detect('192.168.999.8', { technical: true }).length, 0);
  assert.equal(detect('person@example.test', {}, { pointer: '/user/email' }).length, 0);
  assert.ok(detect('arbitrary-secret', {}, { pointer: '/authorization' }).length);
  assert.ok(detect('测试住址', { personal: true }, { pointer: '/user/homeAddress' }).length);
  assert.equal(detect('glpat-' + 'x'.repeat(24), { ruleOverrides: { 'credential.gitlab': false } }).length, 0);
  assert.throws(() => core.createDetector({ ruleOverrides: { missing: false } }), error => error.code === 'privacy.rule_override_invalid');
});
test('portable backup prepares recovery under a different wrapping key without writing or accepting attacker KDF work factors', async () => {
  const f = fixture(), encoded = await f.api.protectConfig(JSON.stringify(config()));
  const password = 'fixture-long-backup-password';
  const backup = await f.api.exportBackup(encoded, password);
  assert.equal(backup.includes('fixture-api-key'), false);
  const other = fixture(), recovered = await other.api.prepareImport(backup, password);
  assert.equal(other.diskExists(), false);
  const recoveredState = recovered.state;
  assert.ok(vault.validate(recoveredState)); assert.equal(JSON.parse(recovered.config).credentialRefsV1.version, 1);
  other.install(recoveredState); // Simulate the future transaction's state commit in this isolated fixture.
  assert.equal((await other.restart().hydrateConfig(JSON.parse(recovered.config))).raw.providers[0].apiKey, 'fixture-api-key');
  await fails(() => other.api.prepareImport(backup, 'fixture-wrong-password'), 'backup_authentication');
  const altered = JSON.parse(backup); altered.kdf.N = 1073741824;
  await fails(() => other.api.prepareImport(JSON.stringify(altered), password), 'backup_invalid');
  await fails(() => f.api.exportBackup(encoded, 'short'), 'backup_password');
});
test('every executable catalog rule has a positive fixture and all profiles preserve ordinary technical text', () => {
  const x = 'x'.repeat(40);
  const cases = {
    'credential.gitlab': 'glpat-' + x, 'credential.npm': 'npm_' + x, 'credential.pypi': 'pypi-' + x + x,
    'credential.huggingface': 'hf_' + x, 'credential.google-api': 'AIza' + 'x'.repeat(35), 'credential.google-oauth': 'ya29.' + x,
    'credential.stripe': 'sk_live_' + x, 'credential.sendgrid': 'SG.' + x + '.' + x,
    'credential.slack-webhook': 'https://hooks.slack.com/services/' + x + '/' + x + '/' + x,
    'credential.discord-webhook': 'https://discord.com/api/webhooks/1234567890123456/' + x,
    'credential.teams-webhook': 'https://fixture.webhook.office.com/webhookb2/' + x,
    'credential.aws-temporary-id': 'ASIA1234567890123456', 'credential.azure-sas': '?sig=' + x,
    'credential.signed-query': '?X-Goog-Signature=' + x, 'credential.redis-auth': 'redis://:fixture-password@example.test',
    'credential.sql-password': 'Password=fixture-secret;', 'credential.xml-secret': '<password>fixture-secret</password>',
    'credential.docker-auth': '"auth":"Zml4dHVyZTpleGFtcGxl"', 'credential.ssh-password': "sshpass -p 'fixture secret'",
    'credential.otp': '验证码：123456', 'credential.recovery-code': '恢复码: FIXTURE-CODE',
    'credential.wallet-private': 'private key: 0x' + 'a'.repeat(64),
    'credential.integration-secret': 'QiniuAK: SYNTHETIC-ACCESS-KEY-ONLY',
    'personal.cn-landline': '电话: 010-12345678', 'personal.international-phone': 'phone: +1 202 555 0100',
    'personal.passport-labelled': 'passport: EX1234567', 'personal.social-security': 'SSN: 123-45-6789',
    'personal.driver-license': '驾驶证号: EX12345678', 'personal.tax-id': '税号: TEST1234567890',
    'personal.bank-account': 'bank account: TEST1234567890', 'personal.payment-security': 'CVV: 123',
    'personal.payment-expiry': '银行卡有效期：12/29',
    'personal.birth-date': '生日: 2000-01-01', 'personal.contact-name': '姓名: 测试甲',
    'personal.address': '家庭住址: 合成测试地址一号', 'personal.health-record': '病历号: FIXTURE1234',
    'personal.diagnosis': '诊断结果: 合成测试诊断',
    'personal.vehicle': '车架号 TESTVIN00000000001', 'personal.work-identifier': '工号 EMP-99881',
    'personal.profile-url': '领英 linkedin.com/in/synthetic-vault-fixture', 'technical.ipv4': '192.168.1.8',
    'technical.mac': '02:00:00:00:00:01', 'technical.windows-user-path': 'C:\\Users\\fixture\\test.txt',
    'technical.posix-user-path': '/home/fixture/test.txt', 'internal.classified-line': '保密代号: 合成代号',
  };
  const detector = core.createDetector({ personal: true, technical: true, confidential: true });
  for (const rule of catalog.list()) {
    assert.ok(cases[rule.id], rule.id + ' requires a fixture');
    assert.ok(detector.detect(cases[rule.id]).some(match => match.ruleIds.includes(rule.id)), rule.id + ' must match its own fixture');
  }
  for (const input of ['version=3.1 tokenCount=8192 maxTokens=4096', 'commit=' + 'a'.repeat(40), '订单 1234567890', 'public key: ssh-ed25519 AAAA fixture']) assert.equal(detector.detect(input).length, 0, input);
});
