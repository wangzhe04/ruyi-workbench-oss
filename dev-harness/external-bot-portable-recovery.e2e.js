'use strict';
// Generated server runtime + real CurrentUser DPAPI, isolated synthetic credentials only.
// Foundation composition, not the production migration/restore UI or a cross-account test.
// Run serially. No network, server, real config, crypto replacement or secret environment IPC.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto');
const harnessOption = process.argv.indexOf('--harness-root');
const harnessRoot = harnessOption >= 0 ? path.resolve(process.argv[harnessOption + 1]) : __dirname;
require(path.join(harnessRoot, 'lib/self-isolate-home'));
const { releaseEnvironment } = require(path.join(harnessRoot, 'lib/release-checks'));
const { killOwnTree } = require(path.join(harnessRoot, 'lib/kill-own-tree'));
const { createRunner } = require(path.join(harnessRoot, 'lib/harness'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const requireThat = (condition, label) => { if (!condition) throw Object.assign(new Error(label), { code: 'fixture.' + label }); };
const children = new Set();

function environment(home, data) {
  // Whitelist ordinary OS paths/options instead of forwarding inherited credentials.
  const inherited = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (typeof process.env[key] === 'string') inherited[key] = process.env[key];
  }
  return releaseEnvironment(home, data, inherited);
}
function applyEnvironment(env) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
}
function observeSpawns(secrets) {
  const original = cp.spawn;
  const status = { calls: 0, nativeCalls: 0, clean: true };
  cp.spawn = function(file, args, options) {
    status.calls++;
    if (path.basename(String(file)).toLowerCase() === 'powershell.exe') status.nativeCalls++;
    const visible = JSON.stringify([file, args, options && options.env]);
    if (secrets.some(value => value && visible.includes(value))) status.clean = false;
    const child = original.apply(this, arguments);
    children.add(child); child.once('close', () => children.delete(child));
    return child;
  };
  return { status, restore() { cp.spawn = original; } };
}
function runtime() {
  const { loadServerInternals } = require(path.join(harnessRoot, 'lib/server-internals'));
  return loadServerInternals(['ExternalBotCredentials', 'WorkDataRecovery', 'paths', 'atomicWriteJson', 'VERSION', 'CONFIG_SCHEMA', 'externalBotNormalizeConnection', 'externalBotValidState']);
}
async function rejectsCode(work, expected) {
  try { await work(); }
  catch (error) { requireThat(error && error.code === expected, 'unexpected_error_code'); return; }
  requireThat(false, 'expected_rejection');
}
async function readInput() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; requireThat(size <= 65536, 'worker_input_capacity'); chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  try { return JSON.parse(input.toString('utf8')); }
  finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
async function coldWorker() {
  let observer;
  try {
    const task = await readInput();
    applyEnvironment(environment(task.home, task.data));
    observer = observeSpawns(task.rows.flatMap(row => Object.values(row.values)));
    const api = runtime();
    requireThat(path.resolve(api.paths.data) === path.resolve(task.data), 'cold_paths');
    let matched = true, local = true;
    for (const row of task.rows) {
      const snapshot = await api.ExternalBotCredentials.snapshot(row.connection);
      matched = matched && equal(snapshot.values, row.values);
      for (const slot of Object.keys(row.values)) {
        local = local && snapshot.fields[slot].source === 'local' && snapshot.fields[slot].ready;
      }
    }
    const missing = await api.ExternalBotCredentials.snapshot({ ...task.rows[0].connection, botSecretEnv: 'RUYI_BOT_PORTABLE_OVERRIDE' });
    const tombstone = await api.ExternalBotCredentials.snapshot(task.tombstone);
    const ledger = JSON.parse(fs.readFileSync(path.join(task.data, 'external-bot-credentials.json'), 'utf8'));
    const botState = JSON.parse(fs.readFileSync(path.join(task.data, 'external-bots', 'state-v1.json'), 'utf8'));
    requireThat(ledger.records.length === 4, 'cold_complete_ledger');
    process.stdout.write(JSON.stringify({ ok: true, matched, local, nativeCalls: observer.status.nativeCalls,
      ipcClean: observer.status.clean, stateValid: api.externalBotValidState(botState), missingEnv: missing.values.botSecret === '' && missing.fields.botSecret.source === 'env'
        && missing.fields.botSecret.errorCode === 'external_credentials.env_missing',
      tombstoneEmpty: Object.values(tombstone.values).every(value => value === '')
        && Object.values(tombstone.fields).every(field => field.source === 'none' && !field.present && !field.ready),
      metadata: ledger.records.map(({ binding, revision, present }) => ({ binding, revision, present })),
    }));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(?:fixture|external_credentials)\.[a-z0-9_]+$/.test(error.code) ? error.code : 'fixture.worker_failed';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code })); process.exitCode = 1;
  } finally {
    for (const child of children) killOwnTree(child);
    observer?.restore();
  }
}
function readCold(task, root, secrets) {
  return new Promise((resolve, reject) => {
    const env = environment(path.join(root, 'cold-home'), task.data);
    const child = cp.spawn(process.execPath, [__filename, '--cold-worker', '--harness-root', harnessRoot],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, complete = false, failure;
    const fail = code => { failure ||= code; killOwnTree(child); };
    const timer = setTimeout(() => fail('cold_timeout'), 65000);
    const finish = (error, result) => {
      if (complete) return; complete = true; clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      if (error) reject(Object.assign(new Error(error), { code: 'fixture.' + error })); else resolve(result);
    };
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) { chunk.fill(0); fail('cold_output_capacity'); } else chunks.push(chunk); });
    child.stdout.on('error', () => fail('cold_output_failed'));
    child.stderr.resume(); // Never print helper/worker raw output or exception text.
    child.on('error', () => { if (!child.pid) finish('cold_spawn'); else fail('cold_process'); });
    child.on('close', code => {
      if (failure || code !== 0) { finish(failure || 'cold_exit'); return; }
      const bytes = Buffer.concat(chunks);
      try {
        const text = bytes.toString('utf8');
        if (secrets.some(value => value && text.includes(value))) { finish('cold_secret_output'); return; }
        finish(null, JSON.parse(text));
      } catch { finish('cold_response'); }
      finally { bytes.fill(0); }
    });
    child.stdin.on('error', () => fail('cold_input'));
    child.stdin.end(JSON.stringify({ ...task, home: path.join(root, 'cold-home') }));
  });
}

async function main() {
  const t = createRunner('EXTERNAL BOT PORTABLE RECOVERY');
  if (process.platform !== 'win32') { console.log('SKIP real Windows DPAPI portable bot recovery'); t.done(); return; }
  const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-bot-portable-recovery-'));
  const source = path.join(root, 'source'), target = path.join(root, 'target'), failed = path.join(root, 'failed-source');
  let api, observer, sourceSnapshot, opened, failedOpened, stageLabel = 'initialize';
  const owned = [];
  const secret = label => 'SYNTHETIC_PORTABLE_' + label + '_' + crypto.randomBytes(12).toString('hex');
  const qq = { id: 'portable_qq', platform: 'qq', appId: 'portable_app_qq', tenantId: 'portable_tenant', enabled: false };
  const feishu = { id: 'portable_feishu', platform: 'feishu', appId: 'cli_portable', tenantId: 'portable_tenant', botUserId: 'ou_portable', enabled: false };
  const orphan = { id: 'portable_orphan', platform: 'qq', appId: 'portable_orphan_app', tenantId: 'portable_orphan_tenant', enabled: false };
  const tombstone = { id: 'portable_removed', platform: 'qq', appId: 'portable_removed_app', tenantId: 'portable_tenant', enabled: false };
  const rows = [{ connection: qq, values: { botSecret: secret('QQ') } },
    { connection: feishu, values: { verificationToken: secret('VERIFY'), encryptKey: secret('ENCRYPT'), appSecret: secret('APP') } },
    { connection: orphan, values: { botSecret: secret('ORPHAN') } }];
  const removedSecret = secret('REMOVED'), envSecret = secret('ENV_ONLY'), password = secret('PASSWORD');
  const secrets = [...rows.flatMap(row => Object.values(row.values)), removedSecret, envSecret, password];
  try {
    applyEnvironment(environment(path.join(root, 'source-home'), source));
    fs.mkdirSync(source);
    observer = observeSpawns(secrets);
    api = runtime();
    requireThat(api.WorkDataRecovery.VERSION === 2, 'generated_v2_required');
    requireThat(path.resolve(api.paths.data) === path.resolve(source), 'source_paths');
    const ledgerFile = path.join(source, 'external-bot-credentials.json'), configFile = path.join(source, 'config.json');
    await api.atomicWriteJson(configFile, { configSchema: api.CONFIG_SCHEMA, stewardEnabledV1: false, schedulerEnabledV1: false,
      autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] });
    const botFile = path.join(source, 'external-bots', 'state-v1.json');
    const botState = { schema: 1, connections: [
      { ...api.externalBotNormalizeConnection({ ...qq, botSecretEnv: 'RUYI_BOT_PORTABLE_OVERRIDE' }, qq.id), controlRevision: 1 },
      { ...api.externalBotNormalizeConnection(feishu, feishu.id), controlRevision: 1 },
    ], items: [], retiredConnectionIds: [tombstone.id], setupReceipts: [] };
    requireThat(api.externalBotValidState(botState), 'actual_bot_owner_schema');
    fs.mkdirSync(path.dirname(botFile));
    await api.atomicWriteJson(botFile, botState);
    for (const row of [...rows, { connection: tombstone, values: { botSecret: removedSecret } }]) {
      const before = await api.ExternalBotCredentials.inspect(row.connection);
      await api.ExternalBotCredentials.save(row.connection, { set: row.values, remove: [], expectedRevision: before.credentialRevision });
    }
    const beforeRemove = await api.ExternalBotCredentials.inspect(tombstone);
    await api.ExternalBotCredentials.remove(tombstone, { expectedRevision: beforeRemove.credentialRevision });
    const sourceState = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    await api.atomicWriteJson(ledgerFile, JSON.stringify(sourceState, null, 2) + '\r\n');
    const raw = fs.readFileSync(ledgerFile), rawConfig = fs.readFileSync(configFile), rawBots = fs.readFileSync(botFile);
    const metadata = sourceState.records.map(({ binding, revision, present }) => ({ binding, revision, present }));
    requireThat(sourceState.records.length === 4 && sourceState.records.at(-1).cipher === '' && sourceState.records.at(-1).present.length === 0, 'source_rows');
    requireThat(secrets.every(value => !raw.includes(Buffer.from(value)) && !rawConfig.includes(Buffer.from(value)) && !rawBots.includes(Buffer.from(value))), 'source_ciphertext_only');
    t.ok(true, 'A1 real native save/remove creates QQ, every Feishu slot, an unreferenced row and a durable revision tombstone');

    stageLabel = 'snapshot';
    process.env.RUYI_BOT_PORTABLE_OVERRIDE = envSecret;
    const selected = await api.ExternalBotCredentials.snapshot({ ...qq, botSecretEnv: 'RUYI_BOT_PORTABLE_OVERRIDE' });
    requireThat(selected.values.botSecret === envSecret && selected.fields.botSecret.source === 'env', 'env_priority');
    sourceSnapshot = await api.ExternalBotCredentials.snapshotForWorkDataRecovery();
    owned.push(sourceSnapshot.source.data, sourceSnapshot.portable);
    requireThat(sourceSnapshot.present && sourceSnapshot.source.data.equals(raw) && sourceSnapshot.source.sha256 === hash(raw), 'raw_source_proof');
    const portable = JSON.parse(sourceSnapshot.portable.toString('utf8'));
    requireThat(portable.records.length === 4 && portable.records[0].values.botSecret === rows[0].values.botSecret
      && !sourceSnapshot.portable.includes(Buffer.from(envSecret)) && !sourceSnapshot.portable.includes(Buffer.from(removedSecret)), 'local_not_environment');
    requireThat(equal(portable.records.map(({ binding, revision, present }) => ({ binding, revision, present })), metadata), 'portable_metadata');
    delete process.env.RUYI_BOT_PORTABLE_OVERRIDE;
    t.ok(true, 'A2 env priority cannot hide retained local credentials from full export; no environment value or removed secret enters portable data');

    stageLabel = 'package';
    const backup = await api.WorkDataRecovery.seal({ appVersion: api.VERSION, generation: 7, createdAt: new Date().toISOString(),
      directories: ['external-bots'], keys: [], files: [
        { path: 'external-bot-credentials.json', data: sourceSnapshot.source.data, keyRefs: [] },
        { path: 'config.json', data: rawConfig, keyRefs: [] },
        { path: 'external-bots/state-v1.json', data: rawBots, keyRefs: [] },
      ], auxiliaries: [{ type: 'external-bot-credentials', schema: 1, sourcePath: 'external-bot-credentials.json',
        sourceSha256: sourceSnapshot.source.sha256, data: sourceSnapshot.portable }],
    }, password);
    requireThat(JSON.parse(backup).version === 2 && secrets.every(value => !backup.includes(value)), 'package_ciphertext_only');
    await rejectsCode(() => api.WorkDataRecovery.open(backup, 'wrong synthetic password'), 'work_data_recovery.authentication');
    const tampered = JSON.parse(backup), cipher = Buffer.from(tampered.data, 'base64');
    cipher[cipher.length - 1] ^= 1; tampered.data = cipher.toString('base64'); cipher.fill(0);
    await rejectsCode(() => api.WorkDataRecovery.open(JSON.stringify(tampered), password), 'work_data_recovery.authentication');
    requireThat(!fs.existsSync(target) && fs.readFileSync(ledgerFile).equals(raw) && fs.readFileSync(configFile).equals(rawConfig), 'authentication_no_target');
    t.ok(true, 'B1 v2 typed auxiliary is password-encrypted; wrong password and authenticated ciphertext tamper create no target and preserve source bytes');

    stageLabel = 'validate_all_rows';
    opened = await api.WorkDataRecovery.open(backup, password);
    const originalFile = opened.snapshot.files.find(file => file.path === 'external-bot-credentials.json');
    const aux = opened.snapshot.auxiliaries[0];
    requireThat(opened.snapshot.keys.length === 0 && opened.snapshot.auxiliaries.length === 1
      && aux.type === 'external-bot-credentials' && aux.schema === 1 && aux.sourcePath === originalFile.path
      && aux.sourceSha256 === hash(originalFile.data) && originalFile.data.equals(raw), 'typed_source_binding');
    const expectedManifest = { schema: 2, appVersion: opened.snapshot.appVersion, generation: opened.snapshot.generation,
      createdAt: opened.snapshot.createdAt, directories: ['external-bots'], keys: [],
      files: opened.snapshot.files.map(file => ({ path: file.path, size: file.data.length, sha256: hash(file.data), keyRefs: [] })),
      auxiliaries: [{ type: aux.type, schema: aux.schema, sourcePath: aux.sourcePath, sourceSha256: aux.sourceSha256,
        size: aux.data.length, sha256: hash(aux.data) }],
      bytes: opened.snapshot.files.reduce((sum, file) => sum + file.data.length, 0) + aux.data.length };
    requireThat(opened.manifestSha256 === hash(JSON.stringify(expectedManifest)), 'complete_manifest_digest');
    owned.push(...opened.snapshot.files.map(file => file.data), aux.data);
    const malformed = JSON.parse(aux.data.toString('utf8'));
    malformed.records.at(-1).revision = (malformed.records.at(-1).revision[0] === '0' ? '1' : '0') + malformed.records.at(-1).revision.slice(1);
    const badPortable = Buffer.from(JSON.stringify(malformed));
    const callsBeforeInvalid = observer.status.nativeCalls;
    try { await rejectsCode(() => api.ExternalBotCredentials.stageRecoveredForWorkData({ state: JSON.parse(originalFile.data.toString('utf8')), portable: badPortable }), 'external_credentials.recovery_invalid'); }
    finally { badPortable.fill(0); }
    requireThat(observer.status.nativeCalls === callsBeforeInvalid && !fs.existsSync(target), 'all_rows_before_native');
    t.ok(true, 'B2 source-bound typed auxiliary includes every durable row; an invalid final row is rejected before the first native job or target creation');

    stageLabel = 'stage';
    api.paths.data = target;
    const staged = await api.ExternalBotCredentials.stageRecoveredForWorkData({ state: JSON.parse(originalFile.data.toString('utf8')), portable: aux.data });
    requireThat(!fs.existsSync(target), 'stage_no_target_mkdir');
    requireThat(equal(staged.state.records.map(({ binding, revision, present }) => ({ binding, revision, present })), metadata), 'stage_metadata');
    requireThat(staged.sourceStateSha256 === hash(JSON.stringify(sourceState)) && staged.stagedStateSha256 === hash(JSON.stringify(staged.state)), 'stage_hashes');
    requireThat(staged.state.records.every((row, index) => row.present.length ? row.cipher !== sourceState.records[index].cipher && row.cipher.length > 0 : row.cipher === ''), 'native_rewrap');
    requireThat(fs.readFileSync(ledgerFile).equals(raw), 'stage_source_unchanged');
    t.ok(true, 'C1 actual DPAPI protect/unprotect stages the full ledger before target mkdir while preserving bindings, stored revisions and tombstone');

    stageLabel = 'publish_fixture';
    fs.mkdirSync(target);
    await api.atomicWriteJson(path.join(target, 'external-bot-credentials.json'), staged.state);
    await api.atomicWriteJson(path.join(target, 'config.json'), rawConfig.toString('utf8'));
    fs.mkdirSync(path.join(target, 'external-bots'));
    await api.atomicWriteJson(path.join(target, 'external-bots', 'state-v1.json'), rawBots.toString('utf8'));
    const targetRaw = fs.readFileSync(path.join(target, 'external-bot-credentials.json'));
    requireThat(secrets.every(value => !targetRaw.includes(Buffer.from(value))), 'target_ciphertext_only');
    requireThat(equal(fs.readdirSync(target).sort(), ['config.json', 'external-bot-credentials.json', 'external-bots'])
      && equal(fs.readdirSync(path.join(target, 'external-bots')), ['state-v1.json']), 'no_virtual_plaintext_file');
    const cold = await readCold({ data: target, rows, tombstone }, root, secrets);
    requireThat(cold.ok && cold.matched && cold.local && cold.missingEnv && cold.tombstoneEmpty
      && cold.nativeCalls === rows.length && cold.ipcClean && cold.stateValid && equal(cold.metadata, metadata), 'fresh_native_reader');
    const targetBots = JSON.parse(fs.readFileSync(path.join(target, 'external-bots', 'state-v1.json'), 'utf8'));
    requireThat(targetBots.connections[0].botSecretEnv === 'RUYI_BOT_PORTABLE_OVERRIDE'
      && !targetBots.connections.some(connection => connection.id === orphan.id)
      && fs.readFileSync(path.join(target, 'external-bots', 'state-v1.json')).equals(rawBots), 'reference_preservation');
    t.ok(true, 'C2 a fresh generated-runtime Node process reads all rewrapped local values; missing env remains explicit, orphan survives and tombstone stays empty');

    stageLabel = 'failure_release';
    failedOpened = await api.WorkDataRecovery.open(backup, password);
    const failedFile = failedOpened.snapshot.files.find(file => file.path === 'external-bot-credentials.json');
    const failedAux = failedOpened.snapshot.auxiliaries[0];
    const failedBuffers = [...failedOpened.snapshot.files.map(file => file.data), failedAux.data];
    try {
      const badState = JSON.parse(failedFile.data.toString('utf8'));
      badState.records.at(-1).revision = (badState.records.at(-1).revision[0] === '0' ? '1' : '0') + badState.records.at(-1).revision.slice(1);
      await rejectsCode(() => api.ExternalBotCredentials.stageRecoveredForWorkData({ state: badState, portable: failedAux.data }), 'external_credentials.recovery_invalid');
    } finally { failedOpened.release(); failedOpened.release(); }
    requireThat(failedBuffers.every(bytes => bytes.every(byte => byte === 0)), 'failed_package_release');
    fs.mkdirSync(failed);
    const corruptState = structuredClone(sourceState); corruptState.records[2].cipher = crypto.randomBytes(96).toString('base64');
    await api.atomicWriteJson(path.join(failed, 'external-bot-credentials.json'), corruptState);
    const corruptRaw = fs.readFileSync(path.join(failed, 'external-bot-credentials.json'));
    api.paths.data = failed;
    await rejectsCode(() => api.ExternalBotCredentials.snapshotForWorkDataRecovery(), 'external_credentials.decrypt_failed');
    requireThat(fs.readFileSync(path.join(failed, 'external-bot-credentials.json')).equals(corruptRaw)
      && equal(fs.readdirSync(failed), ['external-bot-credentials.json']), 'failed_source_no_skip_or_write');
    t.ok(true, 'D1 failure paths release opened portable/file buffers; one unreadable unreferenced source row rejects the whole export without quarantine or rewriting');

    stageLabel = 'release';
    sourceSnapshot.release(); sourceSnapshot.release(); opened.release(); opened.release();
    requireThat(owned.every(bytes => bytes.every(byte => byte === 0)), 'owned_release');
    requireThat(fs.readFileSync(ledgerFile).equals(raw) && fs.readFileSync(configFile).equals(rawConfig) && fs.readFileSync(botFile).equals(rawBots), 'final_source_unchanged');
    requireThat(observer.status.clean && observer.status.nativeCalls > 0 && children.size === 0, 'native_ipc_clean');
    requireThat(!Object.keys(process.env).some(key => /^RUYI_BOT_/i.test(key)), 'no_env_secret_forwarded');
    t.ok(true, 'D2 idempotent release clears every returned owned buffer; source bytes remain intact and no helper/worker argv or environment carries secrets');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_.]+$/i.test(error.code) ? error.code : 'fixture.failed';
    t.fail(stageLabel + ': ' + code);
  } finally {
    sourceSnapshot?.release(); opened?.release(); failedOpened?.release();
    delete process.env.RUYI_BOT_PORTABLE_OVERRIDE;
    for (const child of children) killOwnTree(child);
    observer?.restore();
    requireThat(path.dirname(root) === temp && path.basename(root).startsWith('ruyi-bot-portable-recovery-'), 'cleanup_scope');
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
}
if (process.argv.includes('--cold-worker')) coldWorker();
else main().catch(() => { console.log('FAIL fixture.unhandled'); process.exitCode = 1; });
