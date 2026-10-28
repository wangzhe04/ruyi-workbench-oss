const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, clone } = require('../lib/privacy-test-fixture');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
function setup() {
  const f = fixture(); let disk, journal, busy = false, fault = '', invalidations = 0; const notifications = [];
  const original = { credentialEncryptionV1: true, defaultWorkspace: 'KEEP-WORKSPACE', privacyModeV1: 'enhanced', providers: [{ id: 'same', apiKey: 'old-test-key', baseUrl: 'https://old.test' }, { id: 'keep', apiKey: 'kept-test-key', baseUrl: 'https://keep.test' }] };
  const host = { committed: config => notifications.push(clone(config)), vault: f.vault, normalize: raw => ({ config: clone(raw), persisted: clone(raw) }),
    readConfig: async () => (await f.vault.hydrateConfig(JSON.parse(disk))).raw,
    readConfigFile: async () => disk, writeConfigFile: async value => { disk = value; },
    busy: () => busy, readJournal: async () => journal, writeJournal: async value => { journal = clone(value); if (fault === 'crash') throw Error('simulated crash after journal rename'); },
    removeJournal: async () => { if (fault === 'remove') { fault = ''; throw Error('simulated remove failure'); } journal = null; }, invalidate: () => { invalidations++; },
    mutate: async work => { const { next } = await work(await host.readConfig());
      if (fault === 'before') throw Error('write failure');
      disk = await f.vault.protectConfig(JSON.stringify(next));
      if (!api.deferConfigWritten(next)) host.committed(next);
      if (fault === 'after') throw Error('post-rename failure');
      return { ok: true };
    } };
  const api = f.CredentialRecovery.create(host);
  return { f, api, host, original, notifications, init: async () => { disk = await f.vault.protectConfig(JSON.stringify(original)); },
    backup: async () => {
      const other = fixture(), imported = { ...original, defaultWorkspace: 'MUST-NOT-IMPORT', privacyModeV1: 'off', providers: [{ id: 'same', apiKey: 'imported-test-key', baseUrl: 'https://new.test' }] };
      return other.vault.exportBackup(await other.vault.protectConfig(JSON.stringify(imported)), 'fixture-password-123');
    }, raw: () => disk, journal: () => journal, fault: value => { fault = value; }, busy: value => { busy = value; },
    change: async () => { const cfg = await host.readConfig(); cfg.theme = 'changed'; disk = await f.vault.protectConfig(JSON.stringify(cfg)); }, invalidations: () => invalidations };
}
test('preview is side-effect free; commit merges credentials, preserves unrelated settings and consumes ticket', async () => {
  const f = setup(); await f.init(); const backup = await f.backup(), before = f.raw(), state = JSON.stringify(f.f.state());
  await assert.rejects(() => f.api.preview(backup, 'wrong-password'), /credential_vault/);
  assert.equal(f.raw(), before); assert.equal(JSON.stringify(f.f.state()), state);
  const preview = await f.api.preview(backup, 'fixture-password-123');
  assert.equal(f.raw(), before); assert.equal(JSON.stringify(f.f.state()), state);
  assert.equal(JSON.stringify(preview).includes('imported-test-key'), false);
  await f.api.commit(preview.ticket);
  const current = await f.host.readConfig();
  assert.equal(current.providers[0].apiKey, 'imported-test-key'); assert.equal(current.providers[1].apiKey, 'kept-test-key');
  assert.equal(current.defaultWorkspace, 'KEEP-WORKSPACE'); assert.equal(current.privacyModeV1, 'enhanced');
  assert.equal(f.raw().includes('imported-test-key'), false); assert.equal(f.journal(), null); assert.ok(f.invalidations());
  await assert.rejects(() => f.api.commit(preview.ticket), /ticket_expired/);
});
test('preview cannot overwrite a newer configuration or restore while a turn is running', async () => {
  const f = setup(); await f.init(); const backup = await f.backup();
  const first = await f.api.preview(backup, 'fixture-password-123'); await f.change();
  await assert.rejects(() => f.api.commit(first.ticket), /configuration_changed/); assert.equal((await f.host.readConfig()).theme, 'changed');
  const next = await f.api.preview(backup, 'fixture-password-123'); f.busy(true);
  await assert.rejects(() => f.api.commit(next.ticket), /busy/); assert.equal((await f.host.readConfig()).providers[0].apiKey, 'old-test-key');
});
for (const stage of ['before', 'after', 'remove']) test('rollback preserves exact credentials after ' + stage + ' failure', async () => {
  const f = setup(); await f.init(); const backup = await f.backup(); const preview = await f.api.preview(backup, 'fixture-password-123'); f.fault(stage);
  await assert.rejects(() => f.api.commit(preview.ticket));
  assert.equal((await f.host.readConfig()).providers[0].apiKey, 'old-test-key');
  assert.equal((await f.host.readConfig()).providers[1].apiKey, 'kept-test-key'); assert.equal(f.journal(), null); assert.equal(f.notifications.length, 0);
  assert.equal(JSON.stringify(f.f.state()).includes('imported-test-key'), false);
});
test('interrupted journal write recovers under a fresh transaction instance and is idempotent', async () => {
  const f = setup(); await f.init(); const preview = await f.api.preview(await f.backup(), 'fixture-password-123'); f.fault('crash');
  await assert.rejects(() => f.api.commit(preview.ticket)); assert.ok(f.journal());
  assert.equal(JSON.stringify(f.journal()).includes('old-test-key'), false);
  const restarted = f.f.CredentialRecovery.create({ ...f.host, vault: f.f.restartVault() });
  assert.equal(await restarted.recoverPending(), true); assert.equal(await restarted.recoverPending(), false);
  assert.equal((await f.host.readConfig()).providers[0].apiKey, 'old-test-key');
});
test('tampered recovery journal fails closed without deleting the journal or rewriting configuration', async () => {
  const f = setup(); await f.init(); const preview = await f.api.preview(await f.backup(), 'fixture-password-123'); f.fault('crash'); await assert.rejects(() => f.api.commit(preview.ticket));
  const before = f.raw(); f.journal().envelope.tag = Buffer.alloc(16).toString('base64');
  await assert.rejects(() => f.api.recoverPending(), /journal_unreadable/); assert.equal(f.raw(), before); assert.ok(f.journal());
});

test('concurrent config readers wait for an active switch instead of rolling back or observing a provisional commit', async () => {
  const f = setup(); await f.init(); const preview = await f.api.preview(await f.backup(), 'fixture-password-123');
  let entered, proceed; const atJournal = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { proceed = resolve; });
  const original = f.host.writeJournal; f.host.writeJournal = async value => { await original(value); entered(); await gate; };
  const committed = f.api.commit(preview.ticket); await atJournal;
  let finished = false; const reader = f.api.recoverPending().then(value => { finished = true; return value; });
  await new Promise(setImmediate); assert.equal(finished, false); assert.equal(f.notifications.length, 0);
  proceed(); await committed; assert.equal(await reader, false); assert.equal(f.notifications.length, 1);
  assert.equal((await f.host.readConfig()).providers[0].apiKey, 'imported-test-key');
});

test('concurrent previews reserve ticket capacity before password work begins', async () => {
  const f = setup(); await f.init(); const backup = await f.backup();
  for (let i = 0; i < 3; i++) await f.api.preview(backup, 'fixture-password-123');
  const results = await Promise.allSettled([f.api.preview(backup, 'fixture-password-123'), f.api.preview(backup, 'fixture-password-123')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'credential_recovery.busy').length, 1);
});

test('an unavailable old wrapping key cannot mutate the old profile; the portable package imports under a fresh independent key', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-credential-fresh-recovery-'));
  const tempRoot = fs.realpathSync(os.tmpdir()), ownedRoot = fs.realpathSync(root);
  t.after(() => {
    assert.equal(path.dirname(ownedRoot), tempRoot);
    assert.ok(path.basename(ownedRoot).startsWith('ruyi-credential-fresh-recovery-'));
    assert.equal(fs.lstatSync(ownedRoot).isSymbolicLink(), false);
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  const f = fixture(), password = 'synthetic-portable-password-123';
  function profile(name, wrappingKey) {
    const data = path.join(ownedRoot, name); fs.mkdirSync(data, { recursive: true });
    const configFile = path.join(data, 'config.json'), vaultFile = path.join(data, 'credential-vault-v1.json'), journalFile = path.join(data, 'credential-import-v1.json');
    let writes = 0;
    const write = (file, value) => { writes++; fs.writeFileSync(file, value); };
    const vault = f.CredentialVault.create({ core: f.PrivacyCore,
      size: async () => fs.existsSync(vaultFile) ? fs.statSync(vaultFile).size : 0,
      stamp: async () => fs.existsSync(vaultFile) ? crypto.createHash('sha256').update(fs.readFileSync(vaultFile)).digest('hex') : 'absent',
      store: { read: async () => fs.existsSync(vaultFile) ? JSON.parse(fs.readFileSync(vaultFile, 'utf8')) : f.CredentialVault.empty(),
        write: async value => write(vaultFile, JSON.stringify(value)), invalidate() {} },
      protector: { supported: () => true, run: async (operation, value, entropy) => {
        if (operation === 'protect') {
          const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce); cipher.setAAD(entropy);
          return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(value.subarray(-16));
        return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
      } } });
    const host = { vault, normalize: raw => ({ config: clone(raw), persisted: clone(raw) }), busy: () => false,
      readConfig: async () => (await vault.hydrateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')))).raw,
      readConfigFile: async () => fs.readFileSync(configFile, 'utf8'), writeConfigFile: async value => write(configFile, value),
      readJournal: async () => fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : null,
      writeJournal: async value => write(journalFile, JSON.stringify(value)), removeJournal: async () => { if (fs.existsSync(journalFile)) { writes++; fs.unlinkSync(journalFile); } }, invalidate() {},
      mutate: async work => { const { next } = await work(await host.readConfig()); write(configFile, await vault.protectConfig(JSON.stringify(next))); return { ok: true }; } };
    return { vault, api: f.CredentialRecovery.create(host), host, data, configFile, vaultFile, journalFile, write, writes: () => writes };
  }
  const old = profile('old', crypto.randomBytes(32));
  const original = { credentialEncryptionV1: true, privacyModeV1: 'enhanced', providers: [{ id: 'synthetic', apiKey: 'SYNTHETIC-PORTABLE-KEY', baseUrl: 'https://synthetic.invalid/v1' }] };
  old.write(old.configFile, await old.vault.protectConfig(JSON.stringify(original)));
  const historyFile = path.join(old.data, 'synthetic-history.ndjson'); fs.writeFileSync(historyFile, '{"content":"old synthetic history"}\n');
  const backup = await old.api.exportBackup(password);
  const files = [old.configFile, old.vaultFile, historyFile];
  const hashes = () => files.map(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  const before = hashes();
  const locked = profile('old', crypto.randomBytes(32));
  let lockedError;
  await assert.rejects(() => locked.host.readConfig(), error => { lockedError = error; return error.code === 'credential_vault.unlock_failed'; });
  await assert.rejects(() => locked.api.preview(backup, password), error => error.code === 'credential_vault.unlock_failed');
  await assert.rejects(() => locked.api.commit('not-issued'), error => error.code === 'credential_recovery.ticket_expired');
  assert.equal(locked.writes(), 0); assert.deepEqual(hashes(), before); assert.equal(fs.existsSync(locked.journalFile), false);
  assert.ok(f.CredentialRecovery.startupGuidance(lockedError).includes('RUYI_HOME'));
  const fresh = profile('fresh', crypto.randomBytes(32));
  fresh.write(fresh.configFile, JSON.stringify({ credentialEncryptionV1: false, privacyModeV1: 'off', providers: [], defaultWorkspace: 'FRESH-WORKSPACE' }));
  const freshBefore = fs.readFileSync(fresh.configFile, 'utf8');
  await assert.rejects(() => fresh.api.preview(backup, 'incorrect-password-123'), error => {
    assert.equal(f.CredentialRecovery.startupGuidance(error), ''); return error.code === 'credential_vault.backup_authentication';
  });
  assert.equal(fs.readFileSync(fresh.configFile, 'utf8'), freshBefore); assert.equal(fs.existsSync(fresh.vaultFile), false);
  const preview = await fresh.api.preview(backup, password);
  assert.equal(fs.existsSync(fresh.vaultFile), false); assert.equal(JSON.stringify(preview).includes('SYNTHETIC-PORTABLE-KEY'), false);
  assert.equal((await fresh.api.commit(preview.ticket)).ok, true);
  const restored = await fresh.host.readConfig();
  assert.equal(restored.providers[0].apiKey, original.providers[0].apiKey); assert.equal(restored.credentialEncryptionV1, true);
  assert.equal(restored.privacyModeV1, 'off'); assert.equal(restored.defaultWorkspace, 'FRESH-WORKSPACE');
  assert.notEqual(JSON.parse(fs.readFileSync(fresh.vaultFile, 'utf8')).instanceId, JSON.parse(fs.readFileSync(old.vaultFile, 'utf8')).instanceId);
  for (const file of [fresh.configFile, fresh.vaultFile]) assert.equal(fs.readFileSync(file, 'utf8').includes('SYNTHETIC-PORTABLE-KEY'), false);
  assert.equal(fs.existsSync(fresh.journalFile), false); assert.deepEqual(hashes(), before); assert.equal(locked.writes(), 0);
});

test('CLI startup prints fresh-profile recovery guidance only for a locked credential vault', async () => {
  const f = fixture(), { bracedBlock, sliceBlock } = require('../lib/source-slice');
  const mainSource = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/14-main.js'), 'utf8');
  const directCli = bracedBlock(mainSource, 'if (require.main === module)'); assert.ok(directCli);
  const startupGuidance = f.CredentialRecovery.startupGuidance;
  const guidance = startupGuidance({ code: 'credential_vault.unlock_failed', message: 'MUST-NOT-SHOW-PRIVATE-DETAIL' });
  for (const phrase of ['保留原数据目录', '不要删除密钥或覆盖旧库', 'RUYI_HOME', '独立、全新的空目录', 'Start-Workbench.cmd', '先预览再确认导入', '不恢复旧聊天']) assert.ok(guidance.includes(phrase), phrase);
  assert.equal(guidance.includes('MUST-NOT-SHOW-PRIVATE-DETAIL'), false);
  for (const code of ['credential_vault.backup_authentication', 'credential_vault.backup_password', 'credential_vault.unsupported', 'EACCES']) assert.equal(startupGuidance({ code }), '');
  for (const code of ['credential_vault.unlock_failed', 'credential_vault.backup_authentication', 'EACCES']) {
    const error = Object.assign(new Error('synthetic ' + code), { code }), lines = [], exits = [], entryModule = {};
    vm.runInNewContext(sliceBlock(mainSource, 'let workDataCliHelperHeld', '// These commands read config through') + '\n' + directCli, { module: entryModule, require: { main: entryModule }, main: async () => { throw error; },
      PrivacyCore: { configHooks: { startupGuidance } }, console: { error: value => lines.push(value) }, process: { exit: value => exits.push(value) } });
    await new Promise(setImmediate);
    assert.deepEqual(exits, [1]); assert.equal(lines.length, 1);
    assert.equal(lines[0], code === 'credential_vault.unlock_failed' ? guidance : error.stack);
  }
});

test('startup diagnostic retains its schema, size limit and original error while exposing safe locked-vault guidance', async () => {
  const f = fixture(), { functionBlock } = require('../lib/source-slice');
  const source = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13-http-router.js'), 'utf8');
  const functions = ['startServer', 'writeStartError', 'startErrorNextText'].map(name => { const code = functionBlock(source, name); assert.ok(code, name); return code; }).join('\n');
  for (const code of ['credential_vault.unlock_failed', 'credential_vault.backup_authentication', 'EIO']) {
    const error = Object.assign(new Error(code === 'EIO' ? 'x'.repeat(1600) : 'synthetic failure'), { code }), records = [];
    let finished = 0;
    const start = vm.runInNewContext(functions + '\nstartServer', {
      PrivacyCore: { configHooks: { startupGuidance: f.CredentialRecovery.startupGuidance } },
      paths: { data: 'synthetic-data' }, dataRoot: () => 'synthetic-data', dataRootSource: () => 'default',
      WorkDataMaintenanceRuntimeHooks: {}, // This case isolates the existing post-admission startup diagnostic.
      WorkDataRootHooks: { bind: async () => {}, ready: () => true }, path, resolveBindHost: () => '127.0.0.1', defaultDataRoots: () => ({ legacy: 'synthetic-old', next: 'synthetic-new' }),
      lstatOrNull: () => null, isDirectServeInvocation: () => false, ServerOwnership: { acquire: async () => ({ portable: false }) },
      startServerInner: async () => { throw error; }, finishBootCliPathProbes: () => { finished++; },
      START_ERROR_KINDS: ['port-unavailable', 'data-dir-unwritable', 'startup-failed'], LAST_START_ERROR_FILE: 'last-start-error.json',
      fsp: { mkdir: async () => {} }, atomicWriteJson: async (_file, value) => records.push(value), nowIso: () => '2026-10-20T00:00:00.000Z',
    });
    await assert.rejects(() => start({}), caught => caught === error && caught.code === code);
    assert.equal(finished, 1); assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'kind', 'message', 'next']);
    assert.equal(records[0].kind, 'startup-failed'); assert.ok(records[0].message.length <= 800);
    assert.equal(records[0].message, code === 'credential_vault.unlock_failed' ? f.CredentialRecovery.startupGuidance(error) : error.message.slice(0, 800));
    assert.ok(records[0].next); assert.equal(records[0].message.includes('synthetic-data'), false);
  }
});
