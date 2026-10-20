'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { constBlock, functionBlock } = require('../lib/source-slice');
const readSource = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = constBlock(readSource('01-config.js'), 'DurableJsonStore') + '\n' + functionBlock(readSource('00-boot.js'), 'runKeyedChain')
  + '\n' + readSource('01j-local-crypto.js') + '\n' + readSource('13y-external-bot-credentials.js') + '\nExternalBotCredentials';
const plain = value => JSON.parse(JSON.stringify(value));
const connection = (patch = {}) => ({ id: 'bot_one', platform: 'qq', appId: 'app_one', tenantId: 'app_one', botUserId: '', enabled: false, ...patch });
const coded = suffix => error => error.code === 'external_credentials.' + suffix && Number.isInteger(error.statusCode) && error.message === error.code;
function fixture({ platform = 'win32' } = {}) {
  let disk, writes = 0, children = 0, writeError = false, readError = false, mode = '';
  const key = crypto.randomBytes(32), calls = [], env = { SystemRoot: 'C:\\Windows', RUYI_BOT_UNRELATED: 'not-for-child', PSModulePath: 'C:\\third-party-modules' };
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const raw = () => { if (readError) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); if (disk === undefined) throw missing(); return disk; };
  function spawn(executable, args, options) {
    children++; calls.push({ executable, args, options });
    if (mode === 'spawn') throw new Error('must-not-leak-provider-secret');
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
    child.stdin.end = input => {
      const lines = input.split('\n');
      assert.equal(lines.length, 4); assert.equal(lines[3], '');
      const request = { op: lines[0], value: lines[1], entropy: lines[2] }; calls.at(-1).input = request;
      if (mode === 'timeout') return;
      setImmediate(() => {
        if (mode === 'capacity') { child.stdout.emit('data', Buffer.alloc(131073)); child.emit('close', 0); return; }
        if (mode === 'malformed') { child.stdout.emit('data', Buffer.from('must-not-leak-provider-secret')); child.emit('close', 0); return; }
        if (mode === 'utf8') { child.stdout.emit('data', Buffer.from([0xff])); child.emit('close', 0); return; }
        if (mode === 'error') { child.emit('error', new Error('must-not-leak-provider-secret')); child.emit('close', 1); return; }
        let output, ok = mode !== 'exit';
        try {
          const bytes = Buffer.from(request.value, 'base64'), entropy = Buffer.from(request.entropy, 'base64');
          if (request.op === 'protect') {
            const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(entropy);
            output = Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
          } else {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
            decipher.setAAD(entropy); decipher.setAuthTag(bytes.subarray(-16));
            output = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
          }
        } catch { ok = false; }
        child.stdout.emit('data', Buffer.from(JSON.stringify(ok ? { ok: true, value: output.toString('base64') } : { ok: false })));
        child.emit('close', ok ? 0 : 1);
      });
    };
    return child;
  }
  const context = { Buffer, TextDecoder, crypto, path,
    process: { platform, env }, require: name => { if (name === 'node:path') return path; assert.equal(name, 'node:child_process'); return { spawn }; },
    fs: { readFileSync: raw, copyFileSync() { throw new Error('must not quarantine credential ciphertext'); } },
    fsp: { readFile: async () => raw(), stat: async () => ({ size: Buffer.byteLength(raw()) }), mkdir: async () => {} },
    paths: { data: '/isolated' }, atomicWriteJson: async (_file, value) => { writes++; if (writeError) throw new Error('write failed'); disk = JSON.stringify(value); },
    setTimeout: (fn, ms) => setTimeout(fn, mode === 'timeout' ? 1 : ms), clearTimeout,
  };
  const api = vm.runInNewContext(source, context);
  return { api, env, calls, counts: () => ({ writes, children }), disk: () => disk, setDisk: value => { disk = value; },
    mode: value => { mode = value; }, writeError: value => { writeError = value; }, readError: value => { readError = value; } };
}
async function set(f, conn, values, extra = {}) {
  const before = await f.api.inspect(conn);
  return f.api.save(conn, { set: values, remove: [], expectedRevision: before.credentialRevision, ...extra });
}
test('read/inspect on an absent vault create nothing and expose only presence/source/revision', async () => {
  const f = fixture(); const snapshot = await f.api.snapshot(connection());
  assert.equal(snapshot.values.botSecret, ''); assert.equal(snapshot.fields.botSecret.source, 'none');
  assert.equal(snapshot.fields.botSecret.present, false); assert.match(snapshot.credentialRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(plain(await f.api.inspect(connection())), { credentialRevision: snapshot.credentialRevision, fields: plain(snapshot.fields) });
  assert.deepEqual(f.counts(), { writes: 0, children: 0 }); assert.equal(f.disk(), undefined);
});
test('local credentials are encrypted/bound, public inspection omits values, and helper argv/env contain no credential', async () => {
  const f = fixture(), conn = connection(), value = 'synthetic-secret-密码';
  const result = await set(f, conn, { botSecret: value });
  assert.equal(result.fields.botSecret.source, 'local'); assert.equal(result.fields.botSecret.present, true);
  assert.ok(!JSON.stringify(result).includes(value)); assert.ok(!f.disk().includes(value));
  assert.equal((await f.api.read(conn)).botSecret, value);
  for (const call of f.calls) {
    assert.ok(!JSON.stringify(call.args).includes(value)); assert.ok(!JSON.stringify(call.options.env).includes(value));
    assert.equal(call.options.env.RUYI_BOT_UNRELATED, undefined); assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.PSModulePath, path.join(path.dirname(call.executable), 'Modules'));
    assert.deepEqual(plain(call.options.stdio), ['pipe', 'pipe', 'ignore']);
    assert.match(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), /DataProtectionScope\]::CurrentUser/);
    assert.doesNotMatch(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), /Add-Type|New-Object|ConvertFrom-Json/);
    assert.equal(call.executable, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
});
test('explicit env selection takes precedence; absent/invalid env never falls back to a saved local value', async () => {
  const f = fixture(), conn = connection(); await set(f, conn, { botSecret: 'local-only-secret' });
  const selected = { ...conn, botSecretEnv: 'RUYI_BOT_QQ' };
  let snapshot = await f.api.snapshot(selected);
  assert.equal(snapshot.values.botSecret, ''); assert.equal(snapshot.fields.botSecret.source, 'env');
  assert.equal(snapshot.fields.botSecret.errorCode, 'external_credentials.env_missing');
  const oldRevision = snapshot.credentialRevision; f.env.RUYI_BOT_QQ = 'environment-secret';
  snapshot = await f.api.snapshot(selected); assert.equal(snapshot.values.botSecret, 'environment-secret'); assert.notEqual(snapshot.credentialRevision, oldRevision);
  f.env.RUYI_BOT_QQ = '\0'; snapshot = await f.api.snapshot(selected); assert.equal(snapshot.values.botSecret, '');
  await assert.rejects(f.api.snapshot({ ...conn, botSecretEnv: 'OTHER_SECRET' }), coded('env_reference_invalid'));
});
test('per-field mixed sources are explicit and inspection never exposes any value', async () => {
  const f = fixture(), conn = connection({ platform: 'feishu', tenantId: 'tenant_one', botUserId: 'ou_bot' });
  await set(f, conn, { verificationToken: 'verify-local', encryptKey: 'encrypt-local', appSecret: 'app-local' });
  f.env.RUYI_BOT_APP = 'app-environment'; const snap = await f.api.snapshot({ ...conn, appSecretEnv: 'RUYI_BOT_APP' });
  assert.equal(snap.fields.appSecret.source, 'env'); assert.equal(snap.fields.encryptKey.source, 'local');
  assert.equal(snap.values.appSecret, 'app-environment'); assert.equal(snap.values.encryptKey, 'encrypt-local');
  const shown = JSON.stringify(await f.api.inspect(conn));
  for (const value of ['verify-local', 'encrypt-local', 'app-local', 'app-environment']) assert.ok(!shown.includes(value));
});
test('save requires disabled connection, exact platform slots and explicit current revision; stale concurrent writes cannot win', async () => {
  const f = fixture(), conn = connection(); const before = await f.api.inspect(conn);
  await assert.rejects(f.api.save({ ...conn, enabled: true }, { set: { botSecret: 'one' }, expectedRevision: before.credentialRevision }), coded('connection_enabled'));
  for (const patch of [{ set: { botSecret: 'one' } }, { set: { appSecret: 'wrong-platform' }, expectedRevision: before.credentialRevision },
    { set: { botSecret: 'one' }, remove: ['botSecret'], expectedRevision: before.credentialRevision }, { set: { botSecret: '\ud800' }, expectedRevision: before.credentialRevision }]) {
    await assert.rejects(f.api.save(conn, patch), coded('patch_invalid'));
  }
  const writes = await Promise.allSettled(['one', 'two'].map(value => f.api.save(conn, { set: { botSecret: value }, expectedRevision: before.credentialRevision })));
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'external_credentials.revision_conflict');
  const current = await f.api.inspect(conn); await f.api.remove(conn, { expectedRevision: current.credentialRevision });
  assert.equal((await f.api.read(conn)).botSecret, ''); assert.notEqual((await f.api.inspect(conn)).credentialRevision, before.credentialRevision);
  await assert.rejects(f.api.save(conn, { set: { botSecret: 'old observation' }, expectedRevision: before.credentialRevision }), coded('revision_conflict'));
});
test('application/tenant/bot identity changes cannot reuse a connection credential; ciphertext swapping fails authentication', async () => {
  const f = fixture(), conn = connection(); await set(f, conn, { botSecret: 'bound-secret' });
  for (const patch of [{ appId: 'foreign' }, { tenantId: 'foreign' }, { botUserId: 'foreign' }]) await assert.rejects(f.api.read({ ...conn, ...patch }), coded('identity_mismatch'));
  const state = JSON.parse(f.disk()); state.records[0].binding.appId = 'foreign'; f.setDisk(JSON.stringify(state));
  await assert.rejects(f.api.read({ ...conn, appId: 'foreign' }), coded('decrypt_failed'));
});
test('unreadable ciphertext retains public revision/presence for explicit complete replacement, never partial mutation or secret reads', async () => {
  const f = fixture(), conn = connection({ platform: 'feishu', tenantId: 'tenant_one', botUserId: 'ou_bot' });
  const values = { verificationToken: 'verify-one', encryptKey: 'encrypt-one', appSecret: 'secret-one' };
  await set(f, conn, values);
  const state = JSON.parse(f.disk()); state.records[0].cipher = crypto.randomBytes(96).toString('base64'); f.setDisk(JSON.stringify(state));
  const status = await f.api.inspect(conn);
  for (const slot of Object.keys(values)) {
    assert.equal(status.fields[slot].present, true); assert.equal(status.fields[slot].ready, false);
    assert.equal(status.fields[slot].errorCode, 'external_credentials.decrypt_failed');
  }
  assert.equal(status.values, undefined);
  await assert.rejects(f.api.snapshot(conn), coded('decrypt_failed'));
  await assert.rejects(f.api.save(conn, { set: { appSecret: 'new-only' }, expectedRevision: status.credentialRevision }), coded('decrypt_failed'));
  await assert.rejects(f.api.save(conn, { set: { appSecret: 'new-only' }, replaceAll: true, expectedRevision: status.credentialRevision }), coded('patch_invalid'));
  const recovered = await f.api.save(conn, { set: values, replaceAll: true, expectedRevision: status.credentialRevision });
  assert.notEqual(recovered.credentialRevision, status.credentialRevision);
  assert.equal(recovered.fields.appSecret.ready, true); assert.equal((await f.api.read(conn)).appSecret, 'secret-one');
});
test('strict identities and env source types cannot be coerced into a different connection or platform', async () => {
  const f = fixture();
  for (const patch of [{ id: ['bot_one'] }, { platform: 'constructor' }, { botUserId: 0 }]) await assert.rejects(f.api.inspect(connection(patch)), coded('identity_invalid'));
  for (const botSecretEnv of [null, 0, []]) await assert.rejects(f.api.snapshot(connection({ botSecretEnv })), coded('env_reference_invalid'));
});
test('explicit complete recovery keeps env selection, removes its unused local slot and never falls back when that env is missing', async () => {
  const f = fixture(), original = connection({ platform: 'feishu', tenantId: 'tenant_one', botUserId: 'ou_bot' });
  await set(f, original, { verificationToken: 'old-verify', encryptKey: 'old-encrypt', appSecret: 'old-app' });
  const state = JSON.parse(f.disk()); state.records[0].cipher = crypto.randomBytes(96).toString('base64'); f.setDisk(JSON.stringify(state));
  const conn = { ...original, appSecretEnv: 'RUYI_BOT_APP' }, revision = (await f.api.inspect(conn)).credentialRevision;
  await assert.rejects(f.api.save(conn, { set: { verificationToken: 'new-verify', encryptKey: 'new-encrypt', appSecret: 'forbidden' }, replaceAll: true, expectedRevision: revision }), coded('patch_invalid'));
  const saved = await f.api.save(conn, { set: { verificationToken: 'new-verify', encryptKey: 'new-encrypt' }, remove: ['appSecret'], replaceAll: true, expectedRevision: revision });
  assert.equal(saved.fields.verificationToken.ready, true); assert.equal(saved.fields.appSecret.source, 'env');
  assert.equal(saved.fields.appSecret.ready, false); assert.equal(saved.fields.appSecret.errorCode, 'external_credentials.env_missing');
  const snap = await f.api.snapshot(conn); assert.equal(snap.values.appSecret, ''); assert.equal(snap.values.encryptKey, 'new-encrypt');
  assert.equal((await f.api.snapshot(original)).fields.appSecret.source, 'none', 'explicit recovery erased old local appSecret rather than retaining a fallback');
});
test('strict durable failure never returns cached secrets, overwrites corrupt input or creates a recovery copy', async () => {
  const f = fixture(), conn = connection(); await set(f, conn, { botSecret: 'known-secret' }); const good = f.disk();
  for (const invalid of ['{', '{}', '{"schema":2,"records":[]}', '{"schema":1,"records":[{}]}', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    f.setDisk(invalid); const writes = f.counts().writes;
    await assert.rejects(f.api.read(conn), coded('storage_unavailable')); assert.equal(f.disk(), invalid); assert.equal(f.counts().writes, writes);
  }
  f.setDisk(good); assert.equal((await f.api.read(conn)).botSecret, 'known-secret');
  f.readError(true); await assert.rejects(f.api.read(conn), coded('storage_unavailable')); f.readError(false);
  const revision = (await f.api.inspect(conn)).credentialRevision; f.writeError(true);
  await assert.rejects(f.api.save(conn, { set: { botSecret: 'new-secret' }, expectedRevision: revision }), coded('storage_unavailable'));
  f.writeError(false); assert.equal((await f.api.read(conn)).botSecret, 'known-secret');
});
test('unsupported OS keeps explicit env working but never stores plaintext or attempts a helper', async () => {
  const f = fixture({ platform: 'linux' }), conn = connection({ botSecretEnv: 'RUYI_BOT_QQ' }); f.env.RUYI_BOT_QQ = 'env-supported';
  assert.equal((await f.api.read(conn)).botSecret, 'env-supported');
  await assert.rejects(set(f, conn, { botSecret: 'not-saved' }), coded('unsupported'));
  assert.equal(f.disk(), undefined); assert.deepEqual(f.counts(), { writes: 0, children: 0 });
});
test('bounded vault capacity fails without evicting a prior credential or invoking encryption for the overflow record', async () => {
  const f = fixture(); await set(f, connection(), { botSecret: 'retained' });
  const state = JSON.parse(f.disk()), row = state.records[0];
  for (let index = 1; index < 64; index++) state.records.push({ ...row, binding: { ...row.binding, connectionId: 'retired_' + index }, revision: crypto.randomBytes(16).toString('hex') });
  f.setDisk(JSON.stringify(state)); const conn = connection({ id: 'new_record' });
  const revision = (await f.api.inspect(conn)).credentialRevision, counts = f.counts(), bytes = f.disk();
  await assert.rejects(f.api.save(conn, { set: { botSecret: 'overflow' }, expectedRevision: revision }), coded('capacity'));
  assert.equal(f.disk(), bytes); assert.deepEqual(f.counts(), counts);
});
for (const [mode, expected] of [['spawn', 'process_failed'], ['error', 'process_failed'], ['exit', 'process_failed'],
  ['timeout', 'process_timeout'], ['capacity', 'process_capacity'], ['malformed', 'process_failed'], ['utf8', 'process_failed']]) {
  test('helper ' + mode + ' is bounded, typed and never persists plaintext or raw error output', async () => {
    const f = fixture(); f.mode(mode);
    await assert.rejects(set(f, connection(), { botSecret: 'must-not-leak-provider-secret' }), coded(expected));
    assert.equal(f.disk(), undefined); assert.equal(f.counts().writes, 0);
  });
}
