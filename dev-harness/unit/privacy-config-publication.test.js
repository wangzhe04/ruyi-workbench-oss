'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises, os = require('node:os'), path = require('node:path');
const { loadServerInternals } = require('../lib/server-internals');
const { releaseEnvironment } = require('../lib/release-checks');
const tempBase = path.resolve(os.tmpdir());
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture rendezvous timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-config-publication-')), data = path.join(root, 'data'); fs.mkdirSync(data);
  Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
  const file = path.join(data, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ privacyModeV1: 'off', credentialEncryptionV1: true, providers: [], externalMcpServers: [],
    desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, schedulerEnabledV1: false }));
  const app = loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'readConfig', 'writeConfig', 'writeConfigAtomic', 'mutateConfig', 'configEmitWritten'], { withEval: true });
  const config = await app.readConfig();
  t.after(() => {
    assert.equal(path.dirname(root), tempBase); assert(path.basename(root).startsWith('ruyi-config-publication-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root, data, file, config };
}
function holdHydration(t, app) {
  const original = app.PrivacyCore.configHooks.hydrateConfig, entered = deferred(), release = deferred(); let once = true;
  app.PrivacyCore.configHooks.hydrateConfig = async raw => {
    const result = await original(raw);
    if (once) { once = false; entered.resolve(); await release.promise; }
    return result;
  };
  t.after(() => { release.resolve(); app.PrivacyCore.configHooks.hydrateConfig = original; });
  return { entered: entered.promise, release: release.resolve };
}
function queuedWrites(app) {
  return app.__eval(`(() => {
    const original = writeConfigAtomic, signal = { ordinary: null, migration: null };
    writeConfigAtomic = function(data, options = {}) {
      const pending = original(data, options);
      if (options.expectedReadGeneration === undefined) signal.ordinary?.(); else signal.migration?.();
      return pending;
    };
    return signal;
  })()`);
}
function holdProtection(t, app) {
  const original = app.PrivacyCore.configHooks.protectConfig, entered = deferred(), release = deferred(); let once = true;
  app.PrivacyCore.configHooks.protectConfig = async (...args) => {
    if (once) { once = false; entered.resolve(); await release.promise; }
    return original(...args);
  };
  t.after(() => { release.resolve(); app.PrivacyCore.configHooks.protectConfig = original; });
  return { entered: entered.promise, release: release.resolve };
}

test('late real OFF hydration cannot replace committed policy, last-good facts, credential choice or cache', async t => {
  const { app, file } = await setup(t), hold = holdHydration(t, app);
  const oldRead = app.readConfig(); await bounded(hold.entered);
  const committed = await app.mutateConfig(config => { config.privacyModeV1 = 'basic'; });
  hold.release(); assert.equal((await oldRead).privacyModeV1, 'off');
  assert.throws(() => app.PrivacyGateway.assertMediaAllowed(), error => error.code === 'privacy.media_not_supported');
  assert.equal(app.__eval('lastGoodConfig.privacyModeV1'), 'basic');
  assert.equal(app.__eval('lastGoodCredentialEncryptionV1'), true);
  assert.notEqual(app.__eval('configReadCache?.snapshot.privacyModeV1'), 'off');
  committed.config.privacyModeV1 = 'off'; committed.config.credentialEncryptionV1 = false;
  assert.equal(app.__eval('lastGoodConfig.privacyModeV1'), 'basic'); assert.equal(app.__eval('lastGoodCredentialEncryptionV1'), true);
  await assert.rejects(() => app.PrivacyGateway.withPolicy('new-after-late-read', async () => app.PrivacyGateway.assertMediaAllowed()), error => error.code === 'privacy.media_not_supported');
  fs.writeFileSync(file, '{broken'); fs.rmSync(file + '.prev', { force: true });
  assert.equal((await app.readConfig()).privacyModeV1, 'basic');
});

test('obsolete read-derived migration paused in protectConfig is explicitly superseded by ordinary write', async t => {
  const { app, file, config } = await setup(t);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8')); legacy.configSchema = 0; fs.writeFileSync(file, JSON.stringify(legacy));
  const hold = holdProtection(t, app), signal = queuedWrites(app), ordinaryQueued = deferred(); signal.ordinary = ordinaryQueued.resolve;
  const oldRead = app.readConfig(); await bounded(hold.entered);
  const writing = app.writeConfig({ ...config, privacyModeV1: 'enhanced' }); await bounded(ordinaryQueued.promise);
  hold.release(); await writing; assert.equal((await oldRead).privacyModeV1, 'off');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacyModeV1, 'enhanced');
  assert.equal(app.__eval('lastGoodConfig.privacyModeV1'), 'enhanced');
  const before = fs.readFileSync(file);
  assert.deepEqual(await app.writeConfigAtomic(JSON.stringify(legacy), { expectedReadGeneration: -1 }), { saved: false });
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a read started behind a pending ordinary write cannot queue a late migration that overwrites it', async t => {
  const { app, file, config } = await setup(t);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8')); legacy.configSchema = 0; fs.writeFileSync(file, JSON.stringify(legacy));
  const hold = holdProtection(t, app), signal = queuedWrites(app), migrationQueued = deferred(); signal.migration = migrationQueued.resolve;
  const writing = app.writeConfig({ ...config, privacyModeV1: 'strict' }); await bounded(hold.entered);
  const oldRead = app.readConfig(); await bounded(migrationQueued.promise);
  hold.release(); await writing; assert.equal((await oldRead).privacyModeV1, 'off');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacyModeV1, 'strict');
  assert.equal(app.__eval('lastGoodConfig.privacyModeV1'), 'strict');
  assert.throws(() => app.PrivacyGateway.assertMediaAllowed(), error => error.code === 'privacy.media_not_supported');
});

test('a read can publish its own successful migration; clean cache hits preserve that policy', async t => {
  const { app, file } = await setup(t);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8')); legacy.configSchema = 0; legacy.privacyModeV1 = 'basic'; fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal((await app.readConfig()).privacyModeV1, 'basic'); assert.equal(app.__eval('lastGoodConfig.privacyModeV1'), 'basic');
  const past = new Date(Date.now() - 10000); fs.utimesSync(file, past, past); await app.readConfig();
  assert(app.__eval('!!configReadCache')); assert.equal((await app.readConfig()).privacyModeV1, 'basic');
  assert.throws(() => app.PrivacyGateway.assertMediaAllowed(), error => error.code === 'privacy.media_not_supported');
});

for (const rollback of [false, true]) test('real recovery host ' + (rollback ? 'rollback' : 'deferred commit') + ' invalidates old reads and preserves new-scope policy', async t => {
  const { app, file, data } = await setup(t);
  const { fixture } = require('../lib/privacy-test-fixture'), { bracedBlock } = require('../lib/source-slice');
  const ownVault = fixture(), imported = fixture(), password = 'synthetic-publication-recovery-password';
  Object.assign(app.PrivacyCore.configHooks, ownVault.vault);
  // Rebind the actual production recovery host after substituting only its local
  // vault adapter. Its durable journal/config callbacks and generation hooks stay real.
  const binding = bracedBlock(fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/01l-credential-recovery.js'), 'utf8'), 'Object.assign(PrivacyCore.configHooks, CredentialRecovery.create(');
  assert(binding); app.__eval(binding + '));');
  await app.mutateConfig(config => { config.privacyModeV1 = 'basic'; });
  const key = 'ordinary-value-owned-by-new-provider';
  const backup = await imported.vault.exportBackup(await imported.vault.protectConfig(JSON.stringify({ credentialEncryptionV1: true, providers: [{ id: 'new-provider', baseUrl: 'https://synthetic.invalid/v1', apiKey: key }] })), password);
  const preview = await app.PrivacyCore.configHooks.preview(backup, password);
  const hold = holdHydration(t, app), oldRead = app.readConfig(); await bounded(hold.entered);
  const atRemoval = deferred(), releaseRemoval = deferred(), originalUnlink = fsp.unlink;
  let first = true, publications = 0; const originalConfigure = app.PrivacyCore.configHooks.configurePrivacy;
  app.PrivacyCore.configHooks.configurePrivacy = config => { publications++; originalConfigure(config); };
  fsp.unlink = async function(filePath, ...args) {
    if (String(filePath) === path.join(data, 'credential-import-v1.json') && first) {
      first = false; atRemoval.resolve(); await releaseRemoval.promise;
      if (rollback) throw Object.assign(Error('synthetic journal removal failure'), { code: 'EIO' });
    }
    return originalUnlink.call(this, filePath, ...args);
  };
  t.after(() => { releaseRemoval.resolve(); fsp.unlink = originalUnlink; app.PrivacyCore.configHooks.configurePrivacy = originalConfigure; ownVault.vault.clear(); imported.vault.clear(); });
  const commit = app.PrivacyCore.configHooks.commit(preview.ticket).then(value => ({ value }), error => ({ error }));
  await bounded(atRemoval.promise);
  const beforePublication = publications;
  assert.equal(app.__eval('lastGoodConfig.providers.length'), 0); // Deferred data is not public yet.
  releaseRemoval.resolve(); const result = await bounded(commit);
  if (rollback) assert.match(result.error?.message || '', /synthetic journal removal failure/); else assert.equal(result.value?.ok, true);
  const afterCommit = publications; hold.release(); await oldRead;
  assert.equal(publications, afterCommit); assert.equal(app.__eval('lastGoodConfig'), null);
  if (!rollback) assert.equal(afterCommit, beforePublication + 1);
  const body = await app.PrivacyGateway.withPolicy('fresh-recovery-scope-' + rollback, () => app.PrivacyGateway.beforeModelRequest({ messages: [{ role: 'user', content: key }] }));
  assert.equal(JSON.stringify(body).includes(key), rollback);
  assert.equal((await app.readConfig()).providers.some(p => p.id === 'new-provider'), !rollback);
  assert.equal(fs.existsSync(path.join(data, 'credential-import-v1.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).privacyModeV1, 'basic');
});
