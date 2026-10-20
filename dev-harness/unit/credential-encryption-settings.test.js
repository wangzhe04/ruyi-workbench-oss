'use strict';
// Actual config persistence and administration handlers, synthetic key wrapping only.
// No listener, model request, CLI, browser or DPAPI subprocess is started.
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Readable } = require('node:stream');
const { loadServerInternals } = require('../lib/server-internals');
const TEMP_BASE = path.resolve(os.tmpdir());
const initial = () => ({ privacyModeV1: 'off', stewardEnabledV1: false, schedulerEnabledV1: false,
  providers: [{ id: 'fixture', type: 'openai-compat', model: 'fixture-model', apiKey: 'SYNTHETIC-OPTIN-KEY', baseUrl: 'https://fixture.invalid/v1' }] });
function setup(t) {
  const root = fs.mkdtempSync(path.join(TEMP_BASE, 'ruyi-encryption-settings-'));
  Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const file = path.join(root, 'data', 'config.json'), vaultFile = path.join(root, 'data', 'credential-vault-v1.json');
  fs.writeFileSync(file, JSON.stringify(initial()));
  const app = loadServerInternals(['CredentialVault', 'PrivacyCore', 'PrivacyGateway', 'readConfig', 'mutateConfig', 'ConfigPatchHooks', 'defaultConfig'], { withEval: true });
  let wraps = 0, failVault = false;
  const installVault = () => {
    const vault = app.CredentialVault.create({ core: app.PrivacyCore,
      size: async () => fs.existsSync(vaultFile) ? fs.statSync(vaultFile).size : 0,
      stamp: async () => fs.existsSync(vaultFile) ? String(fs.statSync(vaultFile).mtimeMs) + ':' + fs.statSync(vaultFile).size : 'absent',
      store: { read: async () => fs.existsSync(vaultFile) ? JSON.parse(fs.readFileSync(vaultFile, 'utf8')) : app.CredentialVault.empty(),
        write: async value => { if (failVault) throw Error('synthetic vault failure'); fs.writeFileSync(vaultFile, JSON.stringify(value)); }, invalidate() {} },
      protector: { supported: () => true, run: async (_operation, value) => { wraps++; return Buffer.from(value); } } });
    for (const key of ['hydrateConfig', 'protectConfig', 'protectBackup', 'protectCorrupt', 'migrateBackups', 'stateStamp', 'sealLocal', 'openLocal']) app.PrivacyCore.configHooks[key] = vault[key];
    return vault;
  };
  installVault();
  app.__eval('atomicWriteJson = Object.assign(async function(file, value, options) { if (atomicWriteJson.fail && file === paths.config) throw Object.assign(new Error("synthetic config commit failure"), { code: "EIO" }); return atomicWriteJson.original(file, value, options); }, { original: atomicWriteJson, fail: false });');
  t.after(() => {
    if (path.dirname(root) !== TEMP_BASE || !path.basename(root).startsWith('ruyi-encryption-settings-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = async (route, value) => {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]); req.method = 'POST'; req.headers = {};
    let status, body; const res = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
    assert.equal(await app.PrivacyCore.configHooks.handleApiRoutes(req, res, '/api/privacy/' + route), true);
    return { status, body };
  };
  return { app, file, vaultFile, post, installVault, wraps: () => wraps, failVault: value => { failVault = value; }, failCommit: value => app.__eval('atomicWriteJson.fail = ' + String(value)) };
}

test('new defaults and ordinary config saves leave credentials unencrypted and never initialize key wrapping', async t => {
  const f = setup(t), config = await f.app.readConfig();
  assert.equal(f.app.defaultConfig().credentialEncryptionV1, false); assert.equal(config.credentialEncryptionV1, false); assert.equal(config.privacyModeV1, 'off');
  await f.app.mutateConfig(current => { current.theme = 'dark'; });
  const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(disk.providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY'); assert.equal(disk.credentialRefsV1, undefined);
  assert.equal(fs.existsSync(f.vaultFile), false); assert.equal(f.wraps(), 0);
  const refused = await f.post('settings', { mode: 'enhanced', technical: false, rules: [] });
  assert.equal(refused.body.error.code, 'privacy.encryption_required'); assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
  assert.equal((await f.post('backup/export', { password: 'synthetic-long-password' })).body.error.code, 'privacy.encryption_required');
});

test('explicit enable migrates credentials and old references retain encryption across restart and contradictory off flags', async t => {
  const f = setup(t); await f.app.readConfig();
  assert.equal((await f.post('encryption', { enabled: true })).status, 200);
  const encoded = fs.readFileSync(f.file, 'utf8'), raw = JSON.parse(encoded);
  assert.equal(raw.credentialEncryptionV1, true); assert.ok(raw.credentialRefsV1); assert.ok(!encoded.includes('SYNTHETIC-OPTIN-KEY'));
  const restarted = f.installVault();
  assert.equal((await restarted.hydrateConfig(raw)).raw.providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY');
  const contradictory = { ...raw, credentialEncryptionV1: false };
  const hydrated = await restarted.hydrateConfig(contradictory);
  assert.equal(hydrated.raw.credentialEncryptionV1, true);
  assert.equal((await f.app.readConfig()).credentialEncryptionV1, true);
});

test('cold legacy privacy without explicit encryption pauses until a same-page opt-in confirms both settings', async t => {
  const f = setup(t);
  fs.writeFileSync(f.file, JSON.stringify({ ...initial(), privacyModeV1: 'enhanced' }));
  const config = await f.app.readConfig();
  assert.equal(config.privacyModeV1, 'enhanced'); assert.equal(config.credentialEncryptionV1, false);
  assert.equal(config.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.app.PrivacyGateway.recoveryRequired(), true);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).privacyPolicyRecoveryRequiredV1, true);
  assert.equal(fs.existsSync(f.vaultFile), false); assert.equal(f.wraps(), 0);
  await assert.rejects(() => f.app.PrivacyGateway.beforeRequest({ messages: [{ content: 'synthetic@example.test' }] }), /policy_unavailable/);
  const denied = await f.post('settings', { mode: 'enhanced', technical: false, rules: [] });
  assert.equal(denied.body.error.code, 'privacy.encryption_required'); assert.equal(f.wraps(), 0);
  assert.equal((await f.post('settings', { mode: 'enhanced', technical: false, rules: [], encryption: true })).status, 200);
  const confirmed = await f.app.readConfig();
  assert.equal(confirmed.credentialEncryptionV1, true); assert.equal(confirmed.privacyPolicyRecoveryRequiredV1, false); assert.equal(f.app.PrivacyGateway.recoveryRequired(), false);
  assert.equal(confirmed.providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY');
});

test('cold encrypted references enable privacy safely even when the disk flag was omitted by older defaults', async t => {
  const f = setup(t); await f.app.readConfig();
  await f.post('settings', { mode: 'enhanced', technical: false, rules: [], encryption: true });
  const raw = JSON.parse(fs.readFileSync(f.file, 'utf8')); delete raw.credentialEncryptionV1;
  fs.writeFileSync(f.file, JSON.stringify(raw)); f.installVault();
  const config = await f.app.readConfig();
  assert.equal(config.credentialEncryptionV1, true); assert.equal(config.privacyPolicyRecoveryRequiredV1, false);
  assert.equal(config.providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY'); assert.equal(f.app.PrivacyGateway.recoveryRequired(), false);
});

test('failed enable preserves the old off configuration and retries without losing credentials', async t => {
  const f = setup(t); await f.app.readConfig(); const before = fs.readFileSync(f.file, 'utf8');
  f.failVault(true); assert.equal((await f.post('encryption', { enabled: true })).body.error.code, 'credential_vault.storage_unavailable');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(fs.existsSync(f.vaultFile), false);
  f.failVault(false); f.failCommit(true); assert.equal((await f.post('encryption', { enabled: true })).status, 409);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
  f.failCommit(false); assert.equal((await f.post('encryption', { enabled: true })).status, 200);
  assert.equal((await f.app.readConfig()).providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY');
});

test('disabling needs explicit plaintext confirmation and off privacy; failed commit preserves encrypted references', async t => {
  const f = setup(t); await f.app.readConfig(); await f.post('encryption', { enabled: true });
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal((await f.post('encryption', { enabled: false })).body.error.code, 'privacy.plaintext_confirmation_required');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  await assert.rejects(() => f.app.ConfigPatchHooks.applyConfigPatch({ credentialEncryptionV1: false }), /dedicated privacy settings/);
  f.failCommit(true); assert.equal((await f.post('encryption', { enabled: false, confirmPlaintext: true })).status, 409);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal((await f.app.readConfig()).credentialEncryptionV1, true);
  f.failCommit(false); const vaultBefore = fs.readFileSync(f.vaultFile, 'utf8');
  assert.equal((await f.post('encryption', { enabled: false, confirmPlaintext: true })).status, 200);
  const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(disk.credentialEncryptionV1, false); assert.equal(disk.credentialRefsV1, undefined); assert.equal(disk.providers[0].apiKey, 'SYNTHETIC-OPTIN-KEY');
  assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), vaultBefore);
  const wraps = f.wraps(); await f.app.mutateConfig(current => { current.theme = 'light'; });
  assert.equal(f.wraps(), wraps); assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
});

test('same-page explicit encryption and privacy save commits together; active privacy blocks plaintext downgrade', async t => {
  const f = setup(t); await f.app.readConfig();
  const enabled = await f.post('settings', { mode: 'enhanced', technical: false, rules: [], encryption: true });
  assert.equal(enabled.status, 200); assert.equal((await f.app.readConfig()).privacyModeV1, 'enhanced');
  assert.equal((await f.post('encryption', { enabled: false, confirmPlaintext: true })).body.error.code, 'privacy.encryption_required');
  assert.equal((await f.post('settings', { mode: 'off', technical: false, rules: [], encryption: false, confirmPlaintext: true })).status, 200);
  assert.equal((await f.app.readConfig()).privacyModeV1, 'off'); assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
});

test('conditional privacy settings reject stale policy or encryption drafts without mutating credentials', async t => {
  const f = setup(t); const initial = await f.app.readConfig();
  const expectedRuleVersion = f.app.PrivacyGateway.ruleVersion(initial);
  const draft = { mode: 'enhanced', technical: false, rules: [], encryption: true, expectedRuleVersion, expectedEncryption: false };
  const before = fs.readFileSync(f.file, 'utf8');
  const partial = await f.post('settings', { ...draft, expectedEncryption: undefined });
  assert.equal(partial.body.error.code, 'privacy.settings_invalid'); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal((await f.post('encryption', { enabled: true })).status, 200);
  const afterEncryption = fs.readFileSync(f.file, 'utf8'), vault = fs.readFileSync(f.vaultFile, 'utf8');
  const staleEncryption = await f.post('settings', draft);
  assert.equal(staleEncryption.body.error.code, 'privacy.settings_changed');
  assert.equal(fs.readFileSync(f.file, 'utf8'), afterEncryption); assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), vault);
  const success = await f.post('settings', { ...draft, expectedEncryption: true });
  assert.equal(success.status, 200); assert.equal((await f.app.readConfig()).privacyModeV1, 'enhanced');
  const committed = fs.readFileSync(f.file, 'utf8');
  const stalePolicy = await f.post('settings', { ...draft, expectedEncryption: true, mode: 'off' });
  assert.equal(stalePolicy.body.error.code, 'privacy.settings_changed'); assert.equal(fs.readFileSync(f.file, 'utf8'), committed);
});
