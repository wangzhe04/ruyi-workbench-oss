'use strict';
// Actual config and recovery HTTP handlers, invoked without a listener. Only key wrapping
// and unrelated health/CLI/desktop probes are synthetic; no service/model/browser is started.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const Module = require('node:module');
const childProcess = require('node:child_process');
const net = require('node:net');
let processAttempts = 0, listenerAttempts = 0;
const originalProcesses = new Map();
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  originalProcesses.set(key, childProcess[key]);
  childProcess[key] = () => { processAttempts++; throw Error('No subprocess is allowed in this pure recovery test.'); };
}
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = () => { listenerAttempts++; throw Error('No listener is allowed in this pure recovery test.'); };
after(() => {
  for (const [key, value] of originalProcesses) childProcess[key] = value;
  net.Server.prototype.listen = originalListen;
  assert.equal(processAttempts, 0); assert.equal(listenerAttempts, 0);
});
const REPO = process.env.RUYI_REVIEW_REPO || path.resolve(__dirname, '../..');
const SERVER = path.join(REPO, 'ruyi-workbench/app/server.js');
const CANDIDATE = process.env.RUYI_TEST_SERVER_JS || SERVER;
const TEMP = path.resolve(os.tmpdir());
const PASSWORD = 'synthetic-missing-config-recovery-password';
const SECRET = 'SYNTHETIC-MISSING-CONFIG-CREDENTIAL';
const initial = encrypted => ({ credentialEncryptionV1: encrypted, privacyModeV1: 'off',
  stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
  includeWorkbenchMcp: false, desktopMcp: { enabled: false, autodetect: false },
  providers: [{ id: 'fixture', type: 'openai-compat', model: 'fixture-model',
    baseUrl: 'https://fixture.invalid/v1', apiKey: SECRET }] });
function setup(t, seed = initial(true)) {
  const root = fs.mkdtempSync(path.join(TEMP, 'ruyi-missing-config-vault-unit-'));
  const data = path.join(root, 'data');
  Object.assign(process.env, require(path.join(REPO, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), data));
  fs.mkdirSync(data, { recursive: true });
  const file = path.join(data, 'config.json'), vaultFile = path.join(data, 'credential-vault-v1.json');
  if (seed !== null) fs.writeFileSync(file, JSON.stringify(seed));
  const instances = [];
  function load() {
    const mod = new Module(SERVER, module); mod.filename = SERVER;
    mod.paths = Module._nodeModulePaths(path.dirname(SERVER));
    mod._compile(fs.readFileSync(CANDIDATE, 'utf8') + '\n;module.exports.__review = { CredentialVault, PrivacyCore, PrivacyGateway, readConfig, mutateConfig, handleApi, __eval: code => eval(code) };', SERVER);
    const app = mod.exports.__review;
    app.__eval('detectClaudePath=()=>"";detectKimiPath=()=>"";detectAgentCliPath=()=>"";resolveClaudeLauncher=value=>value;RUNTIME.token="synthetic-missing-config-token";'
      + 'desktopMcpDetectionPending=()=>true;computeHealth=async()=>({health:{},manifest:{}});'
      + 'agentConversationContextMeta=async()=>({contextWindow:4096,contextWindowSource:"fixture",contextAgentCliType:"claude"});probeRgAsync=async()=>null;');
    let wraps = 0;
    const vault = app.CredentialVault.create({ core: app.PrivacyCore,
      size: async () => fs.existsSync(vaultFile) ? fs.statSync(vaultFile).size : 0,
      stamp: async () => fs.existsSync(vaultFile) ? String(fs.statSync(vaultFile).mtimeMs) + ':' + fs.statSync(vaultFile).size : 'absent',
      store: { read: async () => fs.existsSync(vaultFile) ? JSON.parse(fs.readFileSync(vaultFile, 'utf8')) : app.CredentialVault.empty(),
        write: async value => fs.writeFileSync(vaultFile, JSON.stringify(value)), invalidate() {} },
      protector: { supported: () => true, run: async (_operation, value) => { wraps++; return Buffer.from(value); } } });
    for (const name of ['hydrateConfig', 'protectConfig', 'protectBackup', 'protectCorrupt', 'migrateBackups', 'stateStamp', 'sealLocal', 'openLocal', 'prepareImport', 'exportBackup']) app.PrivacyCore.configHooks[name] = vault[name];
    // Rebind the real recovery instance to the synthetic vault; preserve its real journal,
    // configuration writer, transaction, revision, import and error behavior.
    const recovery = fs.readFileSync(path.join(REPO, 'ruyi-workbench/app/src/01l-credential-recovery.js'), 'utf8');
    app.__eval(recovery.slice(recovery.indexOf('Object.assign(PrivacyCore.configHooks, CredentialRecovery.create({')));
    app.__eval('atomicWriteJson=Object.assign(async function(file,value,options){if(atomicWriteJson.fail && file===paths.config)throw Object.assign(new Error("synthetic persistence failure"),{code:"EIO"});return atomicWriteJson.original(file,value,options);},{original:atomicWriteJson,fail:false});');
    const invoke = async (method, route, value) => {
      const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
      Object.assign(req, { method, url: route, headers: { host: '127.0.0.1', 'x-wcw-token': 'synthetic-missing-config-token' }, socket: { remoteAddress: '127.0.0.1' } });
      let status, body;
      const res = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
      await app.handleApi(req, res, route);
      return { status, body };
    };
    const instance = { app, vault, invoke, wraps: () => wraps };
    instances.push(instance); return instance;
  }
  const current = load();
  const state = () => JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(vaultFile)).digest('hex');
  const lose = () => { fs.rmSync(file, { force: true }); fs.rmSync(file + '.prev', { force: true }); };
  t.after(() => { for (const value of instances) value.vault.clear();
    if (path.dirname(root) !== TEMP || !path.basename(root).startsWith('ruyi-missing-config-vault-unit-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true }); });
  return { ...current, root, file, vaultFile, state, hash, lose, restart: load };
}
async function paused(app) {
  await assert.rejects(() => app.PrivacyGateway.beforeRequest({ messages: [] }), error => error.code === 'privacy.policy_unavailable');
  assert.throws(() => app.PrivacyGateway.assertSupported({}, 'cli'), error => error.code === 'privacy.policy_unavailable');
  assert.throws(() => app.PrivacyGateway.assertToolChannel(), error => error.code === 'privacy.policy_unavailable');
  assert.throws(() => app.PrivacyGateway.assertMediaAllowed({}), error => error.code === 'privacy.policy_unavailable');
}
async function readable(f) {
  for (const route of ['/api/status', '/api/privacy/status', '/api/privacy/settings']) {
    const response = await f.invoke('GET', route);
    assert.equal(response.status, 200); assert.equal(response.body.ok, true);
    if (route !== '/api/status') assert.equal(response.body.recoveryRequired, true);
  }
}
test('encrypted missing config leaves UI and recovery handlers usable, preserves master/records and stays paused until confirmation', async t => {
  const f = setup(t); await f.app.readConfig();
  const backup = (await f.invoke('POST', '/api/privacy/backup/export', { password: PASSWORD })).body.backup;
  const original = f.state(), beforeHash = f.hash(), beforeWraps = f.wraps(); f.lose();
  const config = await f.app.readConfig();
  assert.equal(config.credentialEncryptionV1, true); assert.equal(config.permissionMode, 'default');
  assert.equal(config.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), beforeHash); assert.equal(f.wraps(), beforeWraps);
  await readable(f); await paused(f.app);
  const diskBeforePreview = fs.readFileSync(f.file, 'utf8'), vaultBeforePreview = f.hash();
  const preview = await f.invoke('POST', '/api/privacy/backup/preview', { backup, password: PASSWORD });
  assert.equal(preview.status, 200); assert.equal(typeof preview.body.ticket, 'string');
  assert.equal(fs.readFileSync(f.file, 'utf8'), diskBeforePreview); assert.equal(f.hash(), vaultBeforePreview);
  const restored = await f.invoke('POST', '/api/privacy/backup/import', { ticket: preview.body.ticket });
  assert.equal(restored.status, 200); assert.equal(restored.body.ok, true);
  const result = await f.app.readConfig(); assert.equal(result.providers[0].apiKey, SECRET);
  assert.equal(result.privacyPolicyRecoveryRequiredV1, true); await paused(f.app);
  const after = f.state(); assert.equal(after.instanceId, original.instanceId); assert.equal(after.protectedKey, original.protectedKey);
  for (const record of original.records) assert.deepEqual(after.records.find(row => row.id === record.id), record);
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(SECRET));
  assert.equal((await f.invoke('POST', '/api/privacy/settings', { mode: 'off', technical: false, rules: [] })).status, 200);
  const body = { messages: [] }; assert.equal(await f.app.PrivacyGateway.beforeRequest(body), body);
});
test('cold config loss with only a retained encrypted vault keeps encryption and recovery UI available without wrapping a new key', async t => {
  const f = setup(t); await f.app.readConfig();
  const backup = (await f.invoke('POST', '/api/privacy/backup/export', { password: PASSWORD })).body.backup;
  const original = f.state(), hash = f.hash(); f.lose();
  const cold = f.restart(), cfg = await cold.app.readConfig();
  assert.equal(cfg.credentialEncryptionV1, true); assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true);
  assert.equal(cold.wraps(), 0); assert.equal(f.hash(), hash); assert.equal(f.state().protectedKey, original.protectedKey);
  await readable(cold); await paused(cold.app);
  const before = fs.readFileSync(f.file, 'utf8');
  const preview = await cold.invoke('POST', '/api/privacy/backup/preview', { backup, password: PASSWORD });
  assert.equal(preview.status, 200); assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.hash(), hash);
  assert.equal((await cold.invoke('POST', '/api/privacy/backup/import', { ticket: preview.body.ticket })).status, 200);
  assert.equal((await cold.app.readConfig()).providers[0].apiKey, SECRET); assert.equal(f.state().protectedKey, original.protectedKey);
  for (const record of original.records) assert.deepEqual(f.state().records.find(row => row.id === record.id), record);
  await paused(cold.app);
});
test('successful explicit plaintext choice is retained for same-process recovery and never deletes the old vault', async t => {
  const f = setup(t); await f.app.readConfig();
  assert.equal((await f.invoke('POST', '/api/privacy/encryption', { enabled: false, confirmPlaintext: true })).status, 200);
  const hash = f.hash(), wraps = f.wraps(); f.lose();
  const cfg = await f.app.readConfig(); assert.equal(cfg.credentialEncryptionV1, false);
  assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash); assert.equal(f.wraps(), wraps);
  await readable(f); await paused(f.app);
  // Once the saved plaintext choice is itself lost across a restart, the retained vault
  // alone cannot prove that choice. Protect conservatively and ask for confirmation.
  f.lose(); const cold = f.restart(), again = await cold.app.readConfig();
  assert.equal(again.credentialEncryptionV1, true); assert.equal(again.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash);
  await paused(cold.app);
});
test('a valid previous explicit plaintext config restores after missing, corrupt or empty current config without locking recovery UI', async t => {
  for (const shape of ['missing', 'corrupt', 'empty']) {
    const f = setup(t); await f.app.readConfig();
    assert.equal((await f.invoke('POST', '/api/privacy/encryption', { enabled: false, confirmPlaintext: true })).status, 200);
    const committed = fs.readFileSync(f.file, 'utf8'), hash = f.hash();
    assert.equal(JSON.parse(committed).credentialEncryptionV1, false); assert.equal(JSON.parse(committed).credentialRefsV1, undefined);
    f.lose(); fs.writeFileSync(f.file + '.prev', committed);
    if (shape !== 'missing') fs.writeFileSync(f.file, shape === 'corrupt' ? '{ synthetic broken config' : '');
    const cold = f.restart(), cfg = await cold.app.readConfig();
    assert.equal(cfg.credentialEncryptionV1, false); assert.equal(cfg.providers[0].apiKey, SECRET);
    assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash); assert.equal(cold.wraps(), 0);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).credentialEncryptionV1, false);
    await readable(cold); await paused(cold.app);
  }
});
test('unknown legacy previous config after interrupted encryption append recovers conservatively and preserves its explicit-key projection', async t => {
  for (const explicitKeys of [false, true]) {
    const legacy = initial(false); delete legacy.credentialEncryptionV1;
    const f = setup(t, legacy); await f.app.readConfig();
    const previous = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    if (!explicitKeys) delete previous.configExplicitKeysV1;
    assert.equal(previous.credentialEncryptionV1, undefined);
    await f.vault.protectConfig(JSON.stringify(initial(true))); const original = f.state();
    f.lose(); fs.writeFileSync(f.file + '.prev', JSON.stringify(previous));
    const cold = f.restart(), cfg = await cold.app.readConfig();
    assert.equal(cfg.credentialEncryptionV1, true); assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true);
    assert.equal(cfg.providers[0].apiKey, SECRET); assert.equal(f.state().protectedKey, original.protectedKey);
    for (const record of original.records) assert.deepEqual(f.state().records.find(row => row.id === record.id), record);
    const disk = fs.readFileSync(f.file, 'utf8');
    assert.equal(JSON.parse(disk).credentialEncryptionV1, true); assert.ok(JSON.parse(disk).credentialRefsV1);
    assert.ok(!disk.includes(SECRET)); await readable(cold); await paused(cold.app);
  }
});
test('an unknown previous config respects a newer committed plaintext snapshot in the same process', async t => {
  const legacy = initial(false); delete legacy.credentialEncryptionV1;
  const f = setup(t, legacy); await f.app.readConfig(); const previous = fs.readFileSync(f.file, 'utf8');
  await f.vault.protectConfig(JSON.stringify(initial(true)));
  assert.equal((await f.invoke('POST', '/api/privacy/encryption', { enabled: false, confirmPlaintext: true })).status, 200);
  const hash = f.hash(); f.lose(); fs.writeFileSync(f.file + '.prev', previous);
  const cfg = await f.app.readConfig();
  assert.equal(cfg.credentialEncryptionV1, false); assert.equal(cfg.providers[0].apiKey, SECRET);
  assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash); await readable(f); await paused(f.app);
});
test('recovery choice matrix prioritizes real refs, real boolean choices, committed snapshots and conservative existing-vault protection', t => {
  const f = setup(t, null);
  const unknown = [[null, false, true], [true, false, true]];
  const shapes = [
    { source: 'rawEmpty', raw: {}, expected: unknown },
    { source: 'prev:true', raw: { credentialEncryptionV1: true }, expected: [[true, true, true], [true, true, true]] },
    { source: 'prev:false', raw: { credentialEncryptionV1: false }, expected: [[false, false, false], [false, false, false]] },
    { source: 'prev:missing', raw: {}, expected: unknown },
    { source: 'prev:refs', raw: { credentialRefsV1: { version: 1, slots: [] } }, expected: [[true, true, true], [true, true, true]] },
    { source: 'prev:refs-false', raw: { credentialEncryptionV1: false, credentialRefsV1: { version: 1, slots: [] } }, expected: [[true, true, true], [true, true, true]] },
    { source: 'prev:null', raw: { credentialEncryptionV1: null }, expected: unknown },
    { source: 'prev:number', raw: { credentialEncryptionV1: 0 }, expected: unknown },
    { source: 'prev:string', raw: { credentialEncryptionV1: 'false' }, expected: unknown },
  ];
  let cases = 0;
  for (const shape of shapes) for (const [vaultIndex, nonempty] of [false, true].entries()) {
    for (const [snapshotIndex, snapshot] of [null, false, true].entries()) {
      const actual = f.app.__eval('configRecoveryCredentialChoice(' + JSON.stringify(shape.raw) + ',' + JSON.stringify(snapshot) + ',' + nonempty + ')');
      assert.equal(actual, shape.expected[vaultIndex][snapshotIndex], shape.source + '/vault=' + nonempty + '/snapshot=' + snapshot); cases++;
    }
  }
  assert.equal(cases, 54); assert.equal(f.wraps(), 0); assert.equal(fs.existsSync(f.vaultFile), false);
});
test('restoring previous encrypted references without their vault stays closed and never creates a replacement key', async t => {
  const f = setup(t); await f.app.readConfig(); const previous = fs.readFileSync(f.file, 'utf8');
  f.lose(); fs.rmSync(f.vaultFile); fs.writeFileSync(f.file + '.prev', previous);
  const cold = f.restart();
  await assert.rejects(() => cold.app.readConfig(), error => /^credential_vault\./.test(error.code));
  assert.equal(cold.wraps(), 0); assert.equal(fs.existsSync(f.vaultFile), false); assert.equal(fs.existsSync(f.file), false);
  await paused(cold.app);
});
test('previous encrypted references override a contradictory false flag and a committed plaintext snapshot without rotating the master', async t => {
  const f = setup(t); await f.app.readConfig(); const previous = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal((await f.invoke('POST', '/api/privacy/encryption', { enabled: false, confirmPlaintext: true })).status, 200);
  const original = f.state(); previous.credentialEncryptionV1 = false;
  f.lose(); fs.writeFileSync(f.file + '.prev', JSON.stringify(previous));
  const cfg = await f.app.readConfig();
  assert.equal(cfg.credentialEncryptionV1, true); assert.equal(cfg.providers[0].apiKey, SECRET);
  assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.state().protectedKey, original.protectedKey);
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes(SECRET)); await readable(f); await paused(f.app);
});
test('failed mutator or failed disable commit cannot turn a mutable last-good object into plaintext consent', async t => {
  for (const mode of ['throwing-mutator', 'failed-disable']) {
    const f = setup(t); await f.app.readConfig(); const hash = f.hash();
    if (mode === 'throwing-mutator') await assert.rejects(() => f.app.mutateConfig(current => { current.credentialEncryptionV1 = false; throw Error('synthetic failed mutation'); }));
    else { f.app.__eval('atomicWriteJson.fail=true');
      assert.equal((await f.invoke('POST', '/api/privacy/encryption', { enabled: false, confirmPlaintext: true })).status, 409);
      f.app.__eval('atomicWriteJson.fail=false'); }
    f.lose(); const cfg = await f.app.readConfig();
    assert.equal(cfg.credentialEncryptionV1, true); assert.equal(cfg.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash); await paused(f.app);
  }
});
test('new installation without vault stays off with zero crypto and its initial defaults grant no later plaintext exception', async t => {
  const f = setup(t, null), cfg = await f.app.readConfig();
  assert.equal(cfg.credentialEncryptionV1, false); assert.equal(cfg.privacyModeV1, 'off');
  assert.equal(cfg.privacyPolicyRecoveryRequiredV1, false); assert.equal(f.wraps(), 0); assert.equal(fs.existsSync(f.vaultFile), false);
  assert.equal(fs.existsSync(path.join(path.dirname(f.file), 'privacy-scopes')), false);
  assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
  assert.equal(f.wraps(), 0); assert.equal(fs.existsSync(f.vaultFile), false);
  // Simulate a vault append whose subsequent config commit never happened.
  await f.vault.protectConfig(JSON.stringify(initial(true))); const hash = f.hash(); f.lose();
  const recovered = await f.app.readConfig(); assert.equal(recovered.credentialEncryptionV1, true);
  assert.equal(recovered.privacyPolicyRecoveryRequiredV1, true); assert.equal(f.hash(), hash); await paused(f.app);
});
test('a nonempty sparse legacy config cannot turn normalized default false into plaintext consent', async t => {
  const f = setup(t, { permissionMode: 'default' });
  assert.equal((await f.app.readConfig()).credentialEncryptionV1, false);
  assert.equal((await f.app.readConfig()).credentialEncryptionV1, false); assert.equal(f.wraps(), 0);
  await f.vault.protectConfig(JSON.stringify(initial(true))); const hash = f.hash(); f.lose();
  const recovered = await f.app.readConfig();
  assert.equal(recovered.credentialEncryptionV1, true); assert.equal(recovered.privacyPolicyRecoveryRequiredV1, true);
  assert.equal(f.hash(), hash); await paused(f.app);
});
test('failed recovery persistence remains closed and retries without rotating or deleting vault state', async t => {
  const f = setup(t); await f.app.readConfig(); const hash = f.hash(); f.lose();
  f.app.__eval('atomicWriteJson.fail=true');
  await assert.rejects(() => f.app.readConfig(), /synthetic persistence failure/);
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.hash(), hash); await paused(f.app);
  f.app.__eval('atomicWriteJson.fail=false');
  assert.equal((await f.app.readConfig()).credentialEncryptionV1, true); assert.equal(f.hash(), hash); await readable(f); await paused(f.app);
});
test('the general vault guard still rejects an unconfirmed plaintext write when a vault already exists', async t => {
  const f = setup(t); await f.app.readConfig(); const hash = f.hash();
  await assert.rejects(() => f.vault.protectConfig(JSON.stringify(initial(false))), error => error.code === 'credential_vault.disable_requires_migration');
  assert.equal(f.hash(), hash);
});
