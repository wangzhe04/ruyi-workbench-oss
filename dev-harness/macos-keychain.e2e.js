'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), { Readable } = require('stream');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacKeychainHelper } = require('../ruyi-workbench/tools/build-macos-keychain-helper');
const { createMacKeychainFixture } = require('./lib/macos-keychain-fixture');
const t = createRunner('MACOS KEYCHAIN');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-keychain-'));
process.env.RUYI_HOME = path.join(root, 'data');
const keychain = path.join(root, 'fixture.keychain');
let disposable;
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac Keychain requires macOS'); return; }
    disposable = createMacKeychainFixture(root);
    const { helper, control } = disposable;
    const production = buildMacKeychainHelper({ output: path.join(root, 'production-helper') });
    const rejected = cp.spawnSync(production, [], { input: JSON.stringify({ version: 1, op: 'get', keychain }), encoding: 'utf8', timeout: 3000 });
    t.ok(rejected.status === 1 && JSON.parse(rejected.stdout).error === 'input_invalid', 'production protocol rejects test-domain selection before touching Keychain');
    fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({ credentialEncryptionV1: false, privacyModeV1: 'off',
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
      providers: [{ id: 'fixture', type: 'openai-compat', apiKey: 'SYNTHETIC-API-KEY', baseUrl: 'https://fixture.invalid', model: 'fixture' }],
      desktopMcp: { enabled: false, autodetect: false } }));
    const S = loadServerInternals(['LocalSecretCrypto', 'LocalSecretCryptoHooks', 'CredentialVault', 'PrivacyCore', 'ExternalBotCredentials', 'CredentialRecovery', 'readConfig', 'externalBotPublicConnections']);
    S.LocalSecretCryptoHooks.helperPath = () => helper;
    const secret = Buffer.from('SYNTHETIC-中文-SECRET'), entropy = Buffer.from('fixture-owner');
    const sealed = await S.LocalSecretCrypto.run('protect', secret, entropy);
    t.ok(!sealed.includes(secret) && sealed.includes(Buffer.from('macos-keychain')) && sealed.includes(Buffer.from('schemaVersion')),
      'new protected bytes identify Keychain and schema without containing plaintext');
    t.ok((await S.LocalSecretCrypto.run('unprotect', sealed, entropy)).equals(secret), 'real isolated Keychain wraps and unwraps through the production Node protector');
    const cold = loadServerInternals(['LocalSecretCrypto', 'LocalSecretCryptoHooks']); cold.LocalSecretCryptoHooks.helperPath = () => helper;
    t.ok((await cold.LocalSecretCrypto.run('unprotect', sealed, entropy)).equals(secret), 'a fresh protector instance reads the existing Keychain key');
    for (const [bytes, aad, code] of [[sealed, Buffer.from('wrong-owner'), 'decrypt_failed'], [Buffer.from('old-dpapi-bytes'), entropy, 'provider_mismatch'],
      [Buffer.concat([sealed.subarray(0, sealed.length - 1), Buffer.from('!')]), entropy, 'decrypt_failed']]) {
      try { await S.LocalSecretCrypto.run('unprotect', bytes, aad); t.fail(code + ' should reject'); }
      catch (error) { t.ok(error.code === 'local_crypto.' + code, code + ' rejects without fallback'); }
    }
    const W = loadServerInternals(['LocalSecretCrypto'], { testPlatform: 'win32' });
    try { await W.LocalSecretCrypto.run('unprotect', sealed, entropy); t.fail('Windows should reject a Mac envelope'); }
    catch (error) { t.ok(error.code === 'local_crypto.provider_mismatch', 'Windows rejects Keychain records before invoking DPAPI'); }
    async function api(route, body) {
      const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]); req.method = body ? 'POST' : 'GET'; req.headers = {};
      let status, result;
      const res = { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } };
      await S.PrivacyCore.configHooks.handleApiRoutes(req, res, '/api/privacy/' + route);
      return { status, body: result };
    }
    t.ok((await api('status')).body.supported === true, 'real Mac privacy status reports platform support');
    const enabled = await api('encryption', { enabled: true });
    const savedConfig = fs.readFileSync(path.join(process.env.RUYI_HOME, 'config.json'), 'utf8');
    const savedVault = JSON.parse(fs.readFileSync(path.join(process.env.RUYI_HOME, 'credential-vault-v1.json'), 'utf8'));
    t.ok(enabled.status === 200 && JSON.parse(savedConfig).credentialRefsV1 && !savedConfig.includes('SYNTHETIC-API-KEY')
      && Buffer.from(savedVault.protectedKey, 'base64').includes(Buffer.from('macos-keychain')), 'real encryption API saves Keychain-wrapped references rather than plaintext');
    const connection = { id: 'fixture_bot', platform: 'qq', appId: 'fixture', tenantId: 'fixture', botUserId: '', enabled: false };
    const revision = (await S.ExternalBotCredentials.inspect(connection)).credentialRevision;
    await S.ExternalBotCredentials.save(connection, { set: { botSecret: 'SYNTHETIC-BOT-SECRET' }, expectedRevision: revision });
    t.ok((await S.ExternalBotCredentials.read(connection)).botSecret === 'SYNTHETIC-BOT-SECRET'
      && !fs.readFileSync(path.join(process.env.RUYI_HOME, 'external-bot-credentials.json'), 'utf8').includes('SYNTHETIC-BOT-SECRET'),
      'real Mac bot credential save and read use the same platform protector');
    const connections = [connection];
    for (let index = 1; index < 5; index++) {
      const row = { ...connection, id: connection.id + '_' + index };
      const expectedRevision = (await S.ExternalBotCredentials.inspect(row)).credentialRevision;
      await S.ExternalBotCredentials.save(row, { set: { botSecret: 'SYNTHETIC-BOT-SECRET' }, expectedRevision });
      connections.push(row);
    }
    const listed = await S.externalBotPublicConnections(connections);
    t.ok(listed.length === 5 && listed.every(row => row.configured && !row.credentialError),
      'an ordinary five-connection list does not exceed the Keychain process budget or misreport healthy credentials');
    // Exercise the real vault persistence shape, cold load and portable recovery using this protector.
    let state = S.CredentialVault.empty();
    const host = { core: S.PrivacyCore, protector: S.LocalSecretCrypto, size: async () => 0,
      store: { read: async () => structuredClone(state), write: async value => { state = structuredClone(value); }, invalidate() {} } };
    let vault = S.CredentialVault.create(host);
    const raw = JSON.stringify({ credentialEncryptionV1: true, providers: [{ id: 'fixture', apiKey: 'SYNTHETIC-API-KEY', baseUrl: 'https://fixture.invalid' }] });
    const config = await vault.protectConfig(raw), before = JSON.stringify(state);
    vault.clear(); vault = S.CredentialVault.create(host);
    t.ok((await vault.hydrateConfig(JSON.parse(config))).raw.providers[0].apiKey === 'SYNTHETIC-API-KEY' && !config.includes('SYNTHETIC-API-KEY'),
      'real vault cold load decrypts protected references without plaintext persistence');
    const backup = await vault.exportBackup(config, 'synthetic-long-password');
    t.ok((await vault.prepareImport(backup, 'synthetic-long-password', { runtime: true })).runtime.providers[0].apiKey === 'SYNTHETIC-API-KEY',
      'existing password-protected recovery package rewraps under the Mac protector');
    vault.clear(); control('lock');
    try { await vault.hydrateConfig(JSON.parse(config)); t.fail('locked Keychain should reject'); }
    catch (error) { t.ok(error.code === 'credential_vault.keychain_locked' && JSON.stringify(state) === before, 'locked Keychain remains typed through the vault and does not change stored data (' + error.code + ')'); }
    control('unlock');
    t.ok((await vault.hydrateConfig(JSON.parse(config))).raw.providers[0].apiKey === 'SYNTHETIC-API-KEY', 'unlocking restores cold vault access without replacing any key');
    vault.clear(); control('replace-key');
    try { await S.LocalSecretCrypto.run('unprotect', sealed, entropy); t.fail('changed key should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.key_changed', 'changed Keychain identity does not decrypt or replace old records'); }
    control('corrupt-key');
    try { await S.LocalSecretCrypto.run('protect', secret, entropy); t.fail('damaged key should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.keychain_corrupt', 'damaged wrapping key is not silently regenerated'); }
    control('remove-key');
    try { await S.LocalSecretCrypto.run('unprotect', sealed, entropy); t.fail('missing key should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.key_missing', 'unprotect does not create a replacement for a missing key'); }
    // A bounded fake helper covers explicit access denial and malformed IPC, without OS prompts.
    const fake = path.join(root, 'fake-helper'); S.LocalSecretCryptoHooks.helperPath = () => fake;
    for (const errorCode of ['permission_denied', 'permission_required']) {
      fs.writeFileSync(fake, '#!' + process.execPath + '\nconsole.log(' + JSON.stringify(JSON.stringify({ ok: false, error: errorCode })) + ');process.exitCode=1;', { mode: 0o700 });
      try { await vault.protectConfig(raw); t.fail(errorCode + ' should reject'); }
      catch (error) { t.ok(error.code === 'credential_vault.' + errorCode && JSON.stringify(state) === before, errorCode + ' reaches the vault with no plaintext or durable write'); }
    }
    fs.writeFileSync(fake, '#!' + process.execPath + '\nconsole.log("null");', { mode: 0o700 });
    try { await S.LocalSecretCrypto.run('protect', secret, entropy); t.fail('malformed response should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.process_failed', 'malformed helper JSON is a bounded failure'); }
    fs.writeFileSync(fake, '#!' + process.execPath + '\nprocess.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>console.log(' + JSON.stringify(JSON.stringify({ ok: true, value: Buffer.alloc(32, 7).toString('base64') })) + '),150));', { mode: 0o700 });
    const originalSpawn = cp.spawn, launches = [];
    cp.spawn = function(executable, args, options) { launches.push({ args, env: options.env }); return originalSpawn.call(this, executable, args, options); };
    try {
      const requests = await Promise.allSettled(Array.from({ length: 5 }, () => S.LocalSecretCrypto.run('protect', secret, entropy)));
      t.ok(requests.filter(row => row.status === 'fulfilled').length === 4 && requests.some(row => row.reason?.code === 'local_crypto.process_busy'),
        'helper concurrency is bounded without retrying or queueing extra secret requests');
      t.ok(launches.length === 4 && launches.every(row => row.args.length === 0 && Object.keys(row.env).length === 0),
        'helper arguments and environment contain neither credentials nor inherited provider secrets');
    } finally { cp.spawn = originalSpawn; }
    fs.writeFileSync(fake, '#!' + process.execPath + '\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write("x".repeat(4097)));', { mode: 0o700 });
    try { await S.LocalSecretCrypto.run('protect', secret, entropy); t.fail('helper overflow should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.process_capacity', 'oversize helper output fails before parsing or saving it'); }
    fs.writeFileSync(fake, '#!' + process.execPath + '\nsetTimeout(()=>{},20000);', { mode: 0o700 });
    try { await S.LocalSecretCrypto.run('protect', secret, entropy); t.fail('helper timeout should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.process_timeout', 'a stalled native helper has a bounded lifetime'); }
    S.LocalSecretCryptoHooks.helperPath = () => path.join(root, 'missing-helper');
    try { await S.LocalSecretCrypto.run('protect', secret, entropy); t.fail('missing helper should reject'); }
    catch (error) { t.ok(error.code === 'local_crypto.dependency_missing', 'missing native component fails explicitly'); }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (disposable) { try { disposable.destroy(); } catch (error) { t.fail(error.message); } }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
